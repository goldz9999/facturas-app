# UBICACIÓN EN TU REPO: fastapi-gift-cards/app/routes/recovery.py
# (repositorio: fastapi-gift-cards · ruta: app/routes/recovery.py)
"""
app/routes/recovery.py

Endpoints de la pantalla "Recuperación de órdenes" a proveedores:

- GET  /api/recovery/orders        → órdenes de provider_recovery_log
                                     (PENDING | UNRECOVERED | RECOVERED)
- GET  /api/recovery/orders/{id}   → detalle con historial de intentos
- GET  /api/recovery/summary       → conteos por estado (badges)
- POST /api/recovery/{id}/retry    → "Recuperar ahora": misma lógica que el
                                     ciclo automático, sin esperar al ciclo.

Estados (ver app/services/provider_order_tracking.py):
  PENDING      → Pendientes: faltan códigos, dentro de los 2 días
                 (is_partial=true si ya se recibió algo).
  UNRECOVERED  → En recuperación: > 2 días, o el proveedor la marcó fallida.
  RECOVERED    → Completadas: se recibió el 100 % de lo solicitado.
"""

from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import JSONResponse

from app.core.database import supabase
from app.routes.auth import require_auth
from app.services.auto_purchase_service import retry_recovery_now
from app.services.provider_order_tracking import (
    PENDING_ORDER_RECOVERY_DAYS,
    STATUS_COMPLETED,
    STATUS_PENDING,
    STATUS_RECOVERY,
    TRACKING_TABLE,
)

router = APIRouter(dependencies=[Depends(require_auth)])

_VALID_STATUSES = {STATUS_PENDING, STATUS_RECOVERY, STATUS_COMPLETED}

_LIST_COLUMNS = (
    "id, provider, product_id, order_ref, stage_at_resolution, status, codes_count, "
    "requested_quantity, received_quantity, remaining_quantity, attempt_count, "
    "last_attempt_at, recovery_due_at, moved_to_recovery_at, "
    "original_created_at, original_expires_at, resolved_at, retried_manually, created_at, "
    "raw_metadata, product:products(name)"
)


def _parse_dt(value) -> Optional[datetime]:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def serialize_order(row: dict, now: Optional[datetime] = None) -> dict:
    """Normaliza una fila para el frontend (campos derivados incluidos)."""
    now = now or datetime.now(timezone.utc)
    out = dict(row)
    out["product_name"] = (out.pop("product", None) or {}).get("name")

    requested = out.get("requested_quantity")
    received = out.get("received_quantity")
    if received is None:
        received = out.get("codes_count") or 0
    out["received_quantity"] = received

    remaining = out.get("remaining_quantity")
    if remaining is None and requested is not None:
        remaining = max(int(requested) - int(received), 0)
    if out.get("status") == STATUS_COMPLETED and remaining is None:
        remaining = 0
    out["remaining_quantity"] = remaining

    created = _parse_dt(out.get("original_created_at")) or _parse_dt(out.get("created_at"))
    out["age_hours"] = round((now - created).total_seconds() / 3600, 1) if created else None
    out["is_partial"] = out.get("status") != STATUS_COMPLETED and int(received or 0) > 0
    out["can_retry"] = out.get("status") in (STATUS_PENDING, STATUS_RECOVERY) and (
        remaining is None or remaining > 0
    )
    out["recovery_after_days"] = PENDING_ORDER_RECOVERY_DAYS
    meta = out.pop("raw_metadata", None) or {}
    key = PROVIDER_ORDER_KEYS.get(out.get("provider") or "")
    out["provider_order_id"] = (meta.get(key) if key else None) or None
    out["can_edit_provider_order_id"] = key is not None
    return out


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/recovery/orders
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/orders")
async def get_recovery_orders(
    provider: Optional[str] = Query(None, description="código de proveedor (hankgames, bamboo, ez, ...)"),
    status: Optional[str] = Query(None, description="PENDING | UNRECOVERED | RECOVERED"),
    limit: int = Query(200, ge=1, le=500),
):
    """
    Órdenes a proveedores: pendientes, en recuperación y completadas.
    Pendientes primero (las más antiguas arriba, son las más urgentes);
    el resto por actividad más reciente.
    """
    try:
        query = supabase.table(TRACKING_TABLE).select(_LIST_COLUMNS)
        if provider:
            query = query.eq("provider", provider.lower())
        if status:
            st = status.upper()
            if st not in _VALID_STATUSES:
                raise HTTPException(status_code=400, detail=f"status inválido: {status}")
            query = query.eq("status", st)

        if status and status.upper() == STATUS_PENDING:
            query = query.order("original_created_at", desc=False)
        else:
            query = query.order("resolved_at", desc=True)

        rows = query.limit(limit).execute().data or []
        now = datetime.now(timezone.utc)
        out = [serialize_order(r, now) for r in rows]

        if not status:
            priority = {STATUS_PENDING: 0, STATUS_RECOVERY: 1, STATUS_COMPLETED: 2}
            out.sort(key=lambda r: priority.get(r.get("status"), 3))
        return out

    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/recovery/orders/{id}
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/orders/{id}")
async def get_recovery_order_detail(id: int):
    """Detalle de una orden con su historial completo de intentos (auditoría)."""
    try:
        res = supabase.table(TRACKING_TABLE) \
            .select(_LIST_COLUMNS + ", attempts") \
            .eq("id", id).limit(1).execute()
        if not res.data:
            raise HTTPException(status_code=404, detail="Orden no encontrada")
        out = serialize_order(res.data[0])
        out["attempts"] = out.get("attempts") or []
        return out
    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ─────────────────────────────────────────────────────────────────────────────
# GET /api/recovery/summary
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/summary")
async def get_recovery_summary():
    """Conteos por estado para badges/alertas, sin traer el historial completo."""
    try:
        def _count(st: str) -> int:
            r = supabase.table(TRACKING_TABLE).select("id", count="exact").eq("status", st).execute()
            return r.count or 0

        pending = _count(STATUS_PENDING)
        unrecovered = _count(STATUS_RECOVERY)
        recovered = _count(STATUS_COMPLETED)

        partial = supabase.table(TRACKING_TABLE).select("id", count="exact") \
            .eq("status", STATUS_PENDING).gt("received_quantity", 0).execute()

        return {
            "pending_count": pending,
            "partial_count": partial.count or 0,
            "unrecovered_count": unrecovered,   # "En recuperación"
            "recovered_count": recovered,       # "Completadas"
        }
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})


# ─────────────────────────────────────────────────────────────────────────────
# POST /api/recovery/{id}/retry
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/{id}/retry")
async def retry_recovery_order(id: int):
    """
    "Recuperar ahora": reintenta una orden PENDING o EN RECUPERACIÓN sin
    esperar al ciclo automático. Ejecuta exactamente la misma validación de
    cantidades: si el proveedor entrega solo una parte, se guardan esos
    códigos y la orden sigue pendiente con lo que falta.
    """
    try:
        result = supabase.table(TRACKING_TABLE).select("*").eq("id", id).limit(1).execute()
        if not result.data:
            raise HTTPException(status_code=404, detail="Orden no encontrada")

        log_entry = result.data[0]
        if log_entry["status"] == STATUS_COMPLETED:
            return {"success": False, "message": "Esta orden ya está completada (100 % de los códigos recibidos)"}

        payload = await retry_recovery_now(log_entry)

        refreshed = supabase.table(TRACKING_TABLE).select(_LIST_COLUMNS).eq("id", id).limit(1).execute()
        if refreshed.data:
            payload["order"] = serialize_order(refreshed.data[0])
        return payload

    except HTTPException:
        raise
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})

# ─────────────────────────────────────────────────────────────────────────────
# PATCH /api/recovery/{id}
# ─────────────────────────────────────────────────────────────────────────────
# Edición manual desde el panel:
#   - provider_order_id: número de orden del PROVEEDOR (p. ej. "H275060" de
#     Hankgames). Se guarda en el campo que usa "Recuperar ahora" para ese
#     proveedor. La referencia interna (order_ref) no se toca.
#   - status: PENDING | UNRECOVERED | RECOVERED.
# Cada cambio queda en el historial de intentos (quién no, pero sí qué y cuándo).

from pydantic import BaseModel, Field  # noqa: E402

# Campo de raw_metadata que lee la recuperación de cada proveedor
PROVIDER_ORDER_KEYS = {
    "hankgames":       "order_id",
    "wgcards":         "order_id",
    "eneba_wholesale": "order_id",
    "bamboo":          "request_id",
    "cardone":         "order_code",
    "icodes":          "reference_code",
    "ez":              "transaction_id",
    "wupex":           "order_name",
    "manastore":       "order_ulid",
    "visoria":         "idempotency_key",
}

STATUS_LABELS = {STATUS_PENDING: "Pendiente", STATUS_RECOVERY: "En recuperación", STATUS_COMPLETED: "Completada"}


class RecoveryOrderEdit(BaseModel):
    provider_order_id: Optional[str] = Field(None, max_length=120)
    status: Optional[str] = None
    note: Optional[str] = Field(None, max_length=300)
    # Completar con lo recibido: el proveedor entregó y cobró menos de lo
    # pedido (p. ej. Bamboo 4 de 5) y el resto no se va a entregar.
    close_with_received: bool = False


@router.patch("/{id}")
async def edit_recovery_order(id: int, body: RecoveryOrderEdit):
    res = supabase.table(TRACKING_TABLE).select("*").eq("id", id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    row = res.data[0]
    now = datetime.now(timezone.utc)
    updates: dict = {}
    changes: dict = {}

    # ── Número de orden del proveedor ────────────────────────────────────────
    if body.provider_order_id is not None:
        new_ref = body.provider_order_id.strip()
        key = PROVIDER_ORDER_KEYS.get(row.get("provider") or "")
        if not key:
            raise HTTPException(status_code=400,
                                detail=f"{row.get('provider')} no usa número de orden del proveedor "
                                       f"(compra por unidad): no se puede editar")
        if not new_ref:
            raise HTTPException(status_code=400, detail="El número de orden no puede estar vacío")
        meta = dict(row.get("raw_metadata") or {})
        before = meta.get(key)
        if new_ref != before:
            meta[key] = new_ref
            if row.get("provider") == "eneba_wholesale":
                # En Eneba el actionId de la compra es el mismo UUID que el orderId
                meta["action_id"] = new_ref
            meta["provider_order_id_edited_at"] = now.isoformat()
            updates["raw_metadata"] = meta
            changes["provider_order_id"] = {"antes": before, "ahora": new_ref}

    # ── Estado ──────────────────────────────────────────────────────────────
    new_status = (body.status or "").upper() or None
    if new_status and new_status != row.get("status"):
        if new_status not in _VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"Estado inválido: {body.status}")
        requested = row.get("requested_quantity")
        received = int(row.get("received_quantity") or row.get("codes_count") or 0)
        remaining = max(int(requested) - received, 0) if requested is not None else row.get("remaining_quantity")

        if new_status == STATUS_PENDING:
            if remaining == 0:
                raise HTTPException(status_code=400,
                                    detail="Esta orden ya recibió todos sus códigos: no puede volver a Pendiente")
            # Nuevo plazo de 2 días desde ahora; la reanudación automática la
            # vuelve a consultar en cada ciclo y bloquea recompras del faltante.
            # remaining_quantity es una columna GENERADA (solicitado - recibido):
            # la base la calcula sola y no acepta que se escriba.
            updates.update({
                "status": STATUS_PENDING,
                "recovery_due_at": (now + timedelta(days=PENDING_ORDER_RECOVERY_DAYS)).isoformat(),
                "resolved_at": now.isoformat(),
            })
        elif new_status == STATUS_RECOVERY:
            updates.update({"status": STATUS_RECOVERY, "moved_to_recovery_at": now.isoformat(),
                            "resolved_at": now.isoformat()})
        else:
            # La base de datos solo acepta "Completada" con el 100 % recibido
            # (restricción provider_recovery_log_completed_check).
            if requested is not None and received < int(requested):
                if not body.close_with_received:
                    raise HTTPException(
                        status_code=400,
                        detail=(f"Solo se puede marcar Completada cuando llegaron todos los códigos "
                                f"({received} de {requested}). Si el proveedor no va a entregar ni "
                                f"cobrar el resto, usa «Completar con lo recibido»."),
                    )
                if received <= 0:
                    raise HTTPException(
                        status_code=400,
                        detail="No llegó ningún código: no se puede completar con lo recibido. "
                               "Déjala En recuperación o bórrala.",
                    )
                # Lo comprado de verdad es lo recibido: se ajusta lo solicitado
                # (el original queda guardado) y la orden cumple el 100 %.
                meta = dict(updates.get("raw_metadata") or row.get("raw_metadata") or {})
                meta["original_requested_quantity"] = int(requested)
                updates.update({"requested_quantity": received, "raw_metadata": meta})
                changes["requested_quantity"] = {"antes": int(requested), "ahora": received}
            updates.update({"status": STATUS_COMPLETED, "resolved_at": now.isoformat()})
        changes["status"] = {"antes": row.get("status"), "ahora": new_status}

    if not updates:
        return {"success": True, "message": "Sin cambios", "order": serialize_order(row)}

    history = list(row.get("attempts") or [])
    history.append({
        "n": row.get("attempt_count") or 0,
        "type": "manual_edit",
        "at": now.isoformat(),
        "source": "manual",
        "status": updates.get("status", row.get("status")),
        "changes": changes,
        "reason": body.note or _describe(changes),
    })
    updates["attempts"] = history[-100:]

    try:
        supabase.table(TRACKING_TABLE).update(updates).eq("id", id).execute()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"No se pudo guardar el cambio: {getattr(e, 'message', None) or e}")

    # Si sale de "Pendiente", el ciclo automático deja de esperarla
    if row.get("status") == STATUS_PENDING and updates.get("status") in (STATUS_RECOVERY, STATUS_COMPLETED):
        try:
            from app.services.auto_purchase_service import _tracker
            _tracker.delete_provider_pointer(row["provider"], row["order_ref"], row.get("product_id"))
        except Exception:
            pass

    refreshed = supabase.table(TRACKING_TABLE).select(_LIST_COLUMNS) \
        .eq("id", id).limit(1).execute()
    order = serialize_order(refreshed.data[0]) if refreshed.data else None
    return {"success": True, "message": _describe(changes), "order": order}


def _describe(changes: dict) -> str:
    parts = []
    if "provider_order_id" in changes:
        parts.append(f"Nº de orden del proveedor: {changes['provider_order_id']['ahora']}")
    if "status" in changes:
        parts.append(f"Estado cambiado a «{STATUS_LABELS.get(changes['status']['ahora'], changes['status']['ahora'])}»")
    if "requested_quantity" in changes:
        c = changes["requested_quantity"]
        parts.append(f"cerrada con {c['ahora']} de {c['antes']} (el proveedor no entregó ni cobró el resto)")
    return " · ".join(parts) or "Sin cambios"

# ─────────────────────────────────────────────────────────────────────────────
# DELETE /api/recovery/{id}
# ─────────────────────────────────────────────────────────────────────────────

@router.delete("/{id}")
async def delete_recovery_order(id: int):
    """
    Elimina una orden de "Recuperación de órdenes" (para las que figuran como
    en recuperación pero en realidad no se van a recuperar: envíos ambiguos
    que nunca se crearon, órdenes canceladas por el proveedor, pruebas…).

    Además de la fila de provider_recovery_log:
      - borra el puntero de reanudación del proveedor (*_pending_orders), para
        que el ciclo automático deje de consultarla;
      - cierra el trabajo del Modo B que la estuviera esperando, para que el
        producto se pueda volver a reponer.
    Las órdenes completadas no se borran (son el historial de compras).
    """
    res = supabase.table(TRACKING_TABLE).select("id, provider, order_ref, product_id, status") \
        .eq("id", id).limit(1).execute()
    if not res.data:
        raise HTTPException(status_code=404, detail="Orden no encontrada")
    row = res.data[0]
    if row.get("status") == STATUS_COMPLETED:
        raise HTTPException(status_code=400, detail="Las órdenes completadas no se eliminan (son historial).")

    try:
        from app.services.auto_purchase_service import _tracker
        _tracker.delete_provider_pointer(row["provider"], row["order_ref"], row.get("product_id"))
    except Exception:
        pass

    try:
        q = supabase.table("replenishment_jobs").update({
            "status": "cancelled", "lease_until": None,
            "last_error": "orden eliminada manualmente de Recuperación de órdenes",
        }).eq("status", "awaiting_delivery").eq("order_ref", str(row["order_ref"]))
        if row.get("product_id") is not None:
            q = q.eq("product_id", row["product_id"])
        q.execute()
    except Exception:
        pass   # tabla del Modo B puede no existir si nunca se activó

    try:
        supabase.table(TRACKING_TABLE).delete().eq("id", id).execute()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"No se pudo eliminar: {getattr(e, 'message', None) or e}")

    return {"success": True, "deleted_id": id,
            "message": f"Orden {row.get('order_ref')} eliminada de Recuperación de órdenes"}