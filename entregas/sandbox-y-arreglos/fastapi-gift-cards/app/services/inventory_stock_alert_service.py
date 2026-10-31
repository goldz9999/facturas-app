"""
app/services/inventory_stock_alert_service.py
──────────────────────────────────────────────
Detecta cuándo un producto de tipo 'code' (códigos/vouchers) cae en o por
debajo de su umbral de reposición, y manda un push nativo al APK Android.

Se llama de forma síncrona (in-process, sin Celery) justo después de que
un fulfillment descuenta stock de inventory_codes (marca un código como
'sold'). No hay ningún polling ni tarea periódica nueva.

Reglas:
  - Nunca notifica productos con product_type == 'coda_topup' (recarga
    directa, sin códigos, no aplica el concepto de stock).
  - Nunca notifica productos con inv_notifications_enabled == false
    (el usuario apagó las notificaciones para ese producto, individual
    o vía el toggle global).
  - Re-notifica en cada bajada mientras el stock siga en o bajo el umbral:
    si el umbral es 5, avisa en 5, en 4, en 3... pero no repite si el
    stock se queda quieto en el mismo número.
  - Si el stock vuelve a subir por encima del umbral, se resetea el
    registro: la siguiente vez que baje se trata como una alerta nueva.
  - Stock == 0 se marca como "agotado" (más urgente) en vez de "stock bajo".
  - Si el producto tiene reposición automática activa, se informa cuánto
    falta para el próximo ciclo (horario fijo de Celery beat, ver
    app/celery_app.py). Si está en manual, se avisa que requiere acción.

Agrupación:
  - check_stock_alerts(product_ids) evalúa una lista de productos (puede
    ser uno solo) y devuelve solo los que califican para notificar.
  - notify_stock_alerts(alerts) arma UNA sola notificación push:
    individual si es 1 producto, agrupada con lista si son 2 o más.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from app.core.database import supabase
from app.core.push import send_push_to_all, store_notification

logger = logging.getLogger(__name__)

MAX_PRODUCTS_IN_BODY = 5  # tope de líneas listadas en la notificación agrupada

# Horas UTC en las que corre el ciclo de reposición automática (Celery beat,
# ver app/celery_app.py: crontab hour=13/15/18/21/1, minute=0). Si cambias
# el schedule allá, actualiza esta lista también.
REPLENISHMENT_UTC_HOURS = [1, 6, 15, 18, 21]


def _next_replenishment_eta(now: Optional[datetime] = None) -> str:
    """Texto tipo 'en 2h 15min' hasta el próximo ciclo de reposición automática."""
    now = now or datetime.now(timezone.utc)
    current_minutes = now.hour * 60 + now.minute
    slots = sorted(h * 60 for h in REPLENISHMENT_UTC_HOURS)
    upcoming = [s for s in slots if s > current_minutes]
    next_minutes = upcoming[0] if upcoming else slots[0] + 24 * 60
    delta = next_minutes - current_minutes
    hours, minutes = divmod(delta, 60)
    if hours and minutes:
        return f"en {hours}h {minutes}min"
    if hours:
        return f"en {hours}h"
    return f"en {minutes}min"


async def _count_available_codes(product_id: int) -> int:
    result = (
        supabase.table("inventory_codes")
        .select("id", count="exact")
        .eq("product_id", product_id)
        .eq("status", "available")
        .execute()
    )
    return result.count or 0


async def check_stock_alert(product_id: int) -> Optional[dict]:
    """
    Evalúa un solo producto. Devuelve un dict con la info a notificar si
    corresponde avisar en este momento, o None si no hay nada que hacer.
    """
    prod_resp = (
        supabase.table("products")
        .select("id, name, product_type, inv_replenish_threshold, inv_notifications_enabled, inv_auto_replenish")
        .eq("id", product_id)
        .limit(1)
        .execute()
    )
    if not prod_resp.data:
        return None

    product = prod_resp.data[0]

    # Recarga directa: no tiene códigos, no aplica el concepto de stock.
    if product.get("product_type") == "coda_topup":
        return None

    # El usuario desactivó las notificaciones para este producto.
    if not product.get("inv_notifications_enabled", True):
        return None

    threshold = product.get("inv_replenish_threshold") or 0
    if threshold <= 0:
        return None

    stock = await _count_available_codes(product_id)

    alert_resp = (
        supabase.table("inventory_stock_alerts")
        .select("last_notified_stock")
        .eq("product_id", product_id)
        .limit(1)
        .execute()
    )
    last_notified = alert_resp.data[0]["last_notified_stock"] if alert_resp.data else None

    # Stock recuperado por encima del umbral: resetear para la próxima bajada.
    if stock > threshold:
        if last_notified is not None:
            supabase.table("inventory_stock_alerts").delete().eq("product_id", product_id).execute()
        return None

    # Stock en o bajo el umbral. ¿Corresponde avisar de nuevo?
    if last_notified is not None and stock >= last_notified:
        # Ya se avisó en este nivel (o uno más bajo) y no bajó más. No repetir.
        return None

    supabase.table("inventory_stock_alerts").upsert(
        {
            "product_id": product_id,
            "last_notified_stock": stock,
            "threshold": threshold,
        },
        on_conflict="product_id",
    ).execute()

    return {
        "product_id": product_id,
        "product_name": product.get("name", "Producto desconocido"),
        "stock": stock,
        "threshold": threshold,
        "auto_replenish": product.get("inv_auto_replenish", False),
    }


async def check_stock_alerts(product_ids: list[int]) -> list[dict]:
    """
    Evalúa una lista de productos (puede tener 1 o varios elementos) y
    devuelve solo los que califican para notificar en esta pasada.
    Usar con IDs únicos: si un fulfillment tocó el mismo producto varias
    veces, pásalo una sola vez.
    """
    alerts: list[dict] = []
    for product_id in dict.fromkeys(product_ids):  # dedupe preservando orden
        try:
            alert = await check_stock_alert(product_id)
        except Exception:
            logger.exception("check_stock_alert falló para product_id=%s", product_id)
            continue
        if alert:
            alerts.append(alert)
    return alerts


def _replenishment_line(auto_replenish: bool) -> str:
    if auto_replenish:
        return f"🤖 Reposición automática: {_next_replenishment_eta()}"
    return "⚡ Reposición manual — necesita tu acción"


def _batch_title(alerts: list[dict]) -> str:
    """Producto(s) primero, igual que el aviso individual. Solo 2 nombres: el
    celular corta el título y si no, "Stock bajo" quedaría fuera de la vista."""
    names = [a["product_name"] for a in alerts]
    shown = ", ".join(names[:2])
    if len(names) > 2:
        shown += f" y {len(names) - 2} más"
    return f"⚠️ {shown}: Stock bajo"


def notify_stock_alerts(alerts: list[dict]) -> None:
    """
    Manda UNA sola notificación push por los productos que califiquen:
      - 1 producto  -> notificación individual con el detalle.
      - 2+ productos -> notificación agrupada con lista de productos.
    """
    if not alerts:
        return

    if len(alerts) == 1:
        a = alerts[0]
        body = f"Stock: {a['stock']} (umbral: {a['threshold']})\n{_replenishment_line(a['auto_replenish'])}"
        send_push_to_all(
            title=f"⚠️ {a['product_name']}: Stock bajo",
            body=body,
            data={
                "type": "low_stock",
                "product_id": a["product_id"],
                "stock": a["stock"],
                "threshold": a["threshold"],
            },
        )
        logger.info(
            "[stock-alert] push individual: %s (%d/%d)",
            a["product_name"], a["stock"], a["threshold"],
        )
        return

    # TODOS los productos, uno por línea (antes solo 5 y "y N más").
    # Al deslizar/expandir la notificación en el celular se ve la lista completa.
    body = "\n".join(f"• {a['product_name']}: {a['stock']}/{a['threshold']}" for a in alerts)

    # En la web (campanita) se guarda UNA notificación por producto. Antes se
    # guardaba solo la agrupada, cuyo texto lista 5 productos y "y N más":
    # por eso en la página no aparecían todos los productos con stock bajo.
    for a in alerts:
        store_notification(
            title=f"⚠️ {a['product_name']}: Stock bajo",
            body=f"Stock: {a['stock']} (umbral: {a['threshold']})\n{_replenishment_line(a['auto_replenish'])}",
            data={"type": "low_stock", "product_id": a["product_id"],
                  "stock": a["stock"], "threshold": a["threshold"]},
        )

    # Al celular sigue llegando UN solo push agrupado (no se guarda de nuevo).
    send_push_to_all(
        store=False,
        title=_batch_title(alerts),
        body=body,
        data={
            "type": "low_stock_batch",
            "products": [
                {"product_id": a["product_id"], "stock": a["stock"], "threshold": a["threshold"]}
                for a in alerts
            ],
        },
    )
    logger.info("[stock-alert] push agrupado: %d producto(s)", len(alerts))


async def check_and_notify(product_ids: list[int]) -> list[dict]:
    """Atajo: evalúa y notifica en una sola llamada. Devuelve las alertas enviadas."""
    alerts = await check_stock_alerts(product_ids)
    notify_stock_alerts(alerts)
    # Modo B: los mismos puntos de venta que avisan stock bajo encolan la
    # reposición de los productos en modo umbral (no hace nada si está apagado).
    try:
        from app.services.replenishment_queue import enqueue_if_needed
        await enqueue_if_needed(product_ids, "sale")
    except Exception as e:
        logger.warning("Modo B: no se pudo evaluar reposición tras venta: %s", e)
    return alerts