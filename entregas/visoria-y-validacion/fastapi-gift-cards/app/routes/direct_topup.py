# UBICACIÓN EN TU REPO: fastapi-gift-cards/app/routes/direct_topup.py
# (repositorio: fastapi-gift-cards · ruta: app/routes/direct_topup.py)
"""
app/routes/direct_topup.py
───────────────────────────
Rutas /api/direct-topup — todo lo relacionado a "Recarga Directa" (gaming,
via Coda xShop). Deliberadamente separado de /api/products/{id}/suppliers y
/api/products/{id}/channels: esos son para códigos/vouchers, estos productos
no entregan un código, se acreditan directo en la cuenta del jugador.

GET    /api/direct-topup/catalog                                       → catálogo en vivo de Coda (para buscar/mapear)

Un producto puede tener varias VARIANTES (ej. "5 Diamantes", "100
Diamantes"), cada una mapeada a su propio SKU de Coda. Antes solo se podía
1 SKU por producto; ahora cada variante es su propia fila:

GET    /api/direct-topup/{product_id}/variants                         → variantes (SKUs de Coda) mapeadas a este producto
POST   /api/direct-topup/{product_id}/variants                         → agregar una variante nueva
PATCH  /api/direct-topup/{product_id}/variants/{variant_id}            → editar una variante
DELETE /api/direct-topup/{product_id}/variants/{variant_id}            → quitar una variante (y sus canales)
POST   /api/direct-topup/{product_id}/variants/{variant_id}/sync-price → refresca cost_price desde Coda para esa variante

Los canales (dónde se vende) ahora cuelgan de la VARIANTE, no del producto
— así cada denominación se puede activar/desactivar por canal por separado:

GET    /api/direct-topup/{product_id}/variants/{variant_id}/channels        → canales donde se vende esa variante
POST   /api/direct-topup/{product_id}/variants/{variant_id}/channels        → activar un canal para esa variante
PATCH  /api/direct-topup/{product_id}/variants/{variant_id}/channels/{id}   → editar canal
DELETE /api/direct-topup/{product_id}/variants/{variant_id}/channels/{id}   → desactivar canal

GET    /api/direct-topup/{product_id}/history                          → historial de recargas de ese producto
"""

import logging
from typing import Optional
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
import httpx

from app.core.config import settings
from app.core.database import supabase
from app.routes.auth import require_auth

router = APIRouter(dependencies=[Depends(require_auth)])
logger = logging.getLogger(__name__)


def _gateway_headers():
    if not settings.YAPE_GATEWAY_BASE_URL or not settings.YAPE_GATEWAY_ADMIN_KEY:
        raise HTTPException(
            status_code=503,
            detail="Recarga directa no está configurada (YAPE_GATEWAY_BASE_URL / YAPE_GATEWAY_ADMIN_KEY).",
        )
    return settings.YAPE_GATEWAY_BASE_URL.rstrip("/"), {"x-admin-key": settings.YAPE_GATEWAY_ADMIN_KEY}


@router.get("/catalog")
async def get_direct_topup_catalog():
    """Catálogo en vivo de Coda, para que el admin busque qué SKU mapear a su producto."""
    base_url, headers = _gateway_headers()
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{base_url}/gaming/admin/catalog", headers=headers)
        resp.raise_for_status()
    except httpx.HTTPError:
        logger.exception("No se pudo contactar al gateway de recarga directa")
        raise HTTPException(status_code=502, detail="No se pudo contactar al gateway de recarga directa.")

    data = resp.json()
    return {"products": data.get("data", [])}

@router.get("/products")
async def get_direct_topup_products():
    """Solo los juegos elegibles (subtype=2, sin rol), sin SKUs. Barato, un GET a Coda."""
    base_url, headers = _gateway_headers()
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{base_url}/gaming/admin/products", headers=headers)
        resp.raise_for_status()
    except httpx.HTTPError:
        logger.exception("No se pudo contactar al gateway de recarga directa")
        raise HTTPException(status_code=502, detail="No se pudo contactar al gateway de recarga directa.")

    data = resp.json()
    return {"products": data.get("data", [])}


@router.get("/products/{api_path:path}/skus")
async def get_direct_topup_product_skus(api_path: str):
    """SKUs en vivo de un solo juego. Se llama on-demand cuando el admin lo elige en el modal."""
    base_url, headers = _gateway_headers()
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{base_url}/gaming/admin/products/{api_path}/skus", headers=headers)
        resp.raise_for_status()
    except httpx.HTTPError:
        logger.exception("No se pudo contactar al gateway de recarga directa")
        raise HTTPException(status_code=502, detail="No se pudo contactar al gateway de recarga directa.")

    data = resp.json()
    return {"skus": data.get("data", [])}


# ── Hankgames (mismo gateway yape-gaming, rutas /hankgames/admin/*) ────────
# Segundo proveedor de recarga directa, en paralelo a Coda. El admin mapea
# categoría → producto de Hankgames del mismo modo que con Coda; al guardar
# la variante se manda provider="hankgames" explícito (ver VariantAdd más
# abajo) — antes esto se inferia pisando coda_api_path="hankgames" como
# bandera improvisada, ahora es una columna dedicada en la tabla.

@router.get("/hankgames/categories")
async def get_hankgames_categories():
    """Categorías en vivo de Hankgames, para que el admin busque qué mapear."""
    base_url, headers = _gateway_headers()
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{base_url}/hankgames/admin/categories", headers=headers)
        resp.raise_for_status()
    except httpx.HTTPError:
        logger.exception("No se pudo contactar al gateway de Hankgames")
        raise HTTPException(status_code=502, detail="No se pudo contactar al gateway de Hankgames.")

    data = resp.json()
    return {"categories": data.get("data", [])}


@router.get("/hankgames/categories/{category_id}/products")
async def get_hankgames_category_products(category_id: str):
    """Productos en vivo (con precio) de una categoría de Hankgames, on-demand."""
    base_url, headers = _gateway_headers()
    try:
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{base_url}/hankgames/admin/categories/{category_id}/products", headers=headers)
        resp.raise_for_status()
    except httpx.HTTPError:
        logger.exception("No se pudo contactar al gateway de Hankgames")
        raise HTTPException(status_code=502, detail="No se pudo contactar al gateway de Hankgames.")

    data = resp.json()
    return {"products": data.get("data", [])}


# ── Visoria (mismo gateway yape-gaming, rutas /visoria/admin/*) ────────────
# Solo recarga: Visoria no valida cuentas, el nombre lo da otro proveedor del
# grupo. No tiene listado de juegos: se busca por nombre. En la variante,
# coda_sku = id del producto de Visoria y coda_api_path = nombre del juego.

async def _gateway_get(path: str, params: dict, label: str) -> dict:
    base_url, headers = _gateway_headers()
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.get(f"{base_url}{path}", headers=headers, params=params)
        resp.raise_for_status()
    except httpx.HTTPError:
        logger.exception("No se pudo contactar al gateway de %s", label)
        raise HTTPException(status_code=502, detail=f"No se pudo contactar al gateway de {label}.")
    return resp.json()


@router.get("/visoria/games")
async def get_visoria_games(q: str = Query(..., min_length=2, max_length=120)):
    """Juegos de Visoria con productos de recarga que coinciden con la búsqueda."""
    data = await _gateway_get("/visoria/admin/games", {"q": q}, "Visoria")
    return {"games": data.get("data", [])}


@router.get("/visoria/games/products")
async def get_visoria_game_products(name: str = Query(..., min_length=1, max_length=120)):
    """Productos de recarga (con precio) de un juego de Visoria."""
    data = await _gateway_get("/visoria/admin/games/products", {"name": name}, "Visoria")
    return {"products": data.get("data", [])}


# ── Variantes (mapeos a Coda, Hankgames o Visoria) ──────────────────────────
# Un producto puede tener varias: cada una es una denominación distinta
# (ej. "5 Diamantes" vs "100 Diamantes"), cada una con su propio coda_sku.

class VariantAdd(BaseModel):
    coda_sku: str
    coda_api_path: str
    subtype: int
    have_role: bool = False
    title: Optional[str] = None
    # Nombre corto que se muestra en el panel para diferenciar variantes
    # del mismo producto (ej. "5 Diamantes"). Si lo dejas vacío, el panel
    # usa "title" o el coda_sku a secas.
    variant_label: Optional[str] = None
    cost_price: Optional[float] = None
    cost_currency: str = "USD"
    # Qué proveedor resuelve esta variante ("coda" | "hankgames"). Antes
    # se inferia pisando coda_api_path="hankgames" como bandera; ahora es
    # un campo explícito. coda_sku/coda_api_path siguen significando lo
    # mismo de siempre para Coda (sku real / apiPath); para Hankgames,
    # coda_sku = productId y coda_api_path = categoryId.
    provider: str = "coda"
    # Respaldo entre proveedores (motor de recargas de yape-gaming): las
    # variantes del mismo producto con el mismo variant_key son la misma
    # recarga en distintos proveedores; priority 1 se intenta primero.
    # Vacío = la variante va sola.
    variant_key: Optional[str] = None
    priority: int = 1
    # false = "solo recarga": el motor no le pide el nombre del jugador a
    # esta variante (porque ese proveedor no valida este juego), pero sí la
    # usa para recargar. Necesita la migración 20261031_topup_validates.sql.
    validates: bool = True


class VariantUpdate(BaseModel):
    coda_sku: Optional[str] = None
    coda_api_path: Optional[str] = None
    subtype: Optional[int] = None
    have_role: Optional[bool] = None
    title: Optional[str] = None
    variant_label: Optional[str] = None
    cost_price: Optional[float] = None
    cost_currency: Optional[str] = None
    is_active: Optional[bool] = None
    provider: Optional[str] = None
    # "" quita la variante de su grupo de respaldo (ver update_variant).
    variant_key: Optional[str] = None
    priority: Optional[int] = None
    validates: Optional[bool] = None


@router.get("/{product_id}/variants")
async def list_variants(product_id: int):
    result = supabase.table("direct_topup_suppliers").select("*").eq("product_id", product_id).execute()
    return result.data or []


@router.post("/{product_id}/variants")
async def add_variant(product_id: int, body: VariantAdd):
    try:
        payload = body.model_dump()
        payload["product_id"] = product_id
        result = supabase.table("direct_topup_suppliers").insert(payload).execute()
        return result.data[0]
    except Exception as e:
        logger.error("add_variant error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{product_id}/variants/{variant_id}")
async def update_variant(product_id: int, variant_id: int, body: VariantUpdate):
    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    if payload.get("variant_key") == "":
        payload["variant_key"] = None
    result = supabase.table("direct_topup_suppliers") \
        .update(payload).eq("id", variant_id).eq("product_id", product_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Variante no encontrada")
    return result.data[0]


@router.delete("/{product_id}/variants/{variant_id}")
async def delete_variant(product_id: int, variant_id: int):
    # ON DELETE CASCADE en direct_topup_channels.supplier_id se encarga de
    # borrar también los canales de esta variante.
    supabase.table("direct_topup_suppliers").delete().eq("id", variant_id).eq("product_id", product_id).execute()
    return {"ok": True}


@router.post("/{product_id}/variants/{variant_id}/sync-price")
async def sync_variant_price(product_id: int, variant_id: int):
    """
    Vuelve a consultar el precio VIGENTE del SKU en Coda (via listSku) y
    actualiza cost_price/cost_currency de esta variante.

    Necesario porque Coda cambia sus precios sin avisar, y el cost_price
    que guardamos al mapear la variante queda desactualizado — eso hace
    que /validate falle con "Price Error" (code 30113) al vender.
    """
    row = supabase.table("direct_topup_suppliers") \
        .select("*").eq("id", variant_id).eq("product_id", product_id).limit(1).execute()
    if not row.data:
        raise HTTPException(status_code=404, detail="Esta variante no existe.")
    variant = row.data[0]
    provider = variant.get("provider") or "coda"

    base_url, headers = _gateway_headers()

    if provider == "visoria":
        data = await _gateway_get("/visoria/admin/games/products", {"name": variant["coda_api_path"]}, "Visoria")
        skus = data.get("data", [])
    elif provider == "hankgames":
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                resp = await client.get(
                    f"{base_url}/hankgames/admin/categories/{variant['coda_api_path']}/products", headers=headers
                )
            resp.raise_for_status()
        except httpx.HTTPError:
            logger.exception("No se pudo contactar al gateway de recarga directa (Hankgames)")
            raise HTTPException(status_code=502, detail="No se pudo contactar al gateway de recarga directa.")
        skus = resp.json().get("data", [])
    else:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                resp = await client.get(
                    f"{base_url}/gaming/admin/products/{variant['coda_api_path']}/skus", headers=headers
                )
            resp.raise_for_status()
        except httpx.HTTPError:
            logger.exception("No se pudo contactar al gateway de recarga directa")
            raise HTTPException(status_code=502, detail="No se pudo contactar al gateway de recarga directa.")
        skus = resp.json().get("data", [])

    match = next((s for s in skus if s.get("sku") == variant["coda_sku"]), None)
    if not match or match.get("priceAmount") is None:
        raise HTTPException(status_code=404, detail=f"{provider} ya no tiene este SKU disponible con precio.")

    new_price = match["priceAmount"]
    new_currency = match.get("priceCurrency") or variant["cost_currency"]
    old_price = variant.get("cost_price")

    updated = supabase.table("direct_topup_suppliers") \
        .update({"cost_price": new_price, "cost_currency": new_currency}) \
        .eq("id", variant_id) \
        .execute()

    return {
        "changed": old_price != new_price,
        "old_price": old_price,
        "new_price": new_price,
        "currency": new_currency,
        "variant": updated.data[0] if updated.data else None,
    }


# ── Canales por variante ────────────────────────────────────────────────────
# custom_product_id/custom_title son siempre a mano (no se auto-generan):
# viven en la fila del canal, así que si remapeas la variante a otro
# coda_sku más adelante, estos valores NO se pierden - solo cambia a qué
# SKU real de Coda apunta la variante por dentro.

class ChannelAdd(BaseModel):
    channel: str = "yape"
    sell_price: Optional[float] = None
    sell_currency: str = "PEN"
    is_active: bool = True
    # id/nombre a elección para no exponerle el coda_sku real al
    # consumidor externo. Si se dejan vacíos, el gateway usa el coda_sku y
    # el nombre del producto como fallback.
    custom_product_id: Optional[str] = None
    custom_title: Optional[str] = None


class ChannelUpdate(BaseModel):
    sell_price: Optional[float] = None
    sell_currency: Optional[str] = None
    is_active: Optional[bool] = None
    custom_product_id: Optional[str] = None
    custom_title: Optional[str] = None


def _require_variant(product_id: int, variant_id: int):
    row = supabase.table("direct_topup_suppliers") \
        .select("id").eq("id", variant_id).eq("product_id", product_id).limit(1).execute()
    if not row.data:
        raise HTTPException(status_code=404, detail="Variante no encontrada")


@router.get("/{product_id}/variants/{variant_id}/channels")
async def get_variant_channels(product_id: int, variant_id: int):
    _require_variant(product_id, variant_id)
    result = supabase.table("direct_topup_channels").select("*").eq("supplier_id", variant_id).execute()
    return result.data or []


@router.post("/{product_id}/variants/{variant_id}/channels")
async def add_variant_channel(product_id: int, variant_id: int, body: ChannelAdd):
    _require_variant(product_id, variant_id)
    try:
        payload = body.model_dump()
        payload["product_id"] = product_id
        payload["supplier_id"] = variant_id
        result = supabase.table("direct_topup_channels").insert(payload).execute()
        return result.data[0]
    except Exception as e:
        logger.error("add_variant_channel error: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@router.patch("/{product_id}/variants/{variant_id}/channels/{channel_id}")
async def update_variant_channel(product_id: int, variant_id: int, channel_id: int, body: ChannelUpdate):
    _require_variant(product_id, variant_id)
    payload = {k: v for k, v in body.model_dump().items() if v is not None}
    result = supabase.table("direct_topup_channels") \
        .update(payload).eq("id", channel_id).eq("supplier_id", variant_id).execute()
    if not result.data:
        raise HTTPException(status_code=404, detail="Canal no encontrado")
    return result.data[0]


@router.delete("/{product_id}/variants/{variant_id}/channels/{channel_id}")
async def delete_variant_channel(product_id: int, variant_id: int, channel_id: int):
    _require_variant(product_id, variant_id)
    supabase.table("direct_topup_channels").delete().eq("id", channel_id).eq("supplier_id", variant_id).execute()
    return {"ok": True}


# ── Historial ────────────────────────────────────────────────────────────────

@router.get("/{product_id}/history")
async def get_history(product_id: int, limit: int = 50):
    result = supabase.table("gaming_recharges") \
        .select("*") \
        .eq("product_id", product_id) \
        .order("created_at", desc=True) \
        .limit(limit) \
        .execute()
    return result.data or []


# Historial GLOBAL de recargas (todos los productos), para el tab de Ventas.
# Separado de /{product_id}/history porque ese es por producto (usado en
# TabHistorialCoda); este es para ver "todas las ventas de recarga directa
# por canal" (ej: Yape) sin tener que entrar producto por producto.
@router.get("/history")
async def get_global_history(
    channel:    Optional[str] = Query(None),
    page:       int = Query(1, ge=1),
    page_size:  int = Query(50, ge=1, le=200),
    # days=1 => "últimas 24h". Omitido = sin filtro de fecha. `date` tiene prioridad sobre `days`.
    days:       Optional[int] = Query(None, ge=1, le=365),
    date:       Optional[str] = Query(None, description="Día específico YYYY-MM-DD (zona local del negocio, PE = UTC-5)"),
):
    try:
        offset = (page - 1) * page_size
        since_iso = None
        until_iso = None
        if date:
            pe_offset = timedelta(hours=5)
            day_start_local = datetime.fromisoformat(date)
            since_iso = (day_start_local + pe_offset).replace(tzinfo=timezone.utc).isoformat()
            until_iso = (day_start_local + timedelta(days=1) + pe_offset).replace(tzinfo=timezone.utc).isoformat()
        elif days:
            since_iso = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()

        count_q = supabase.table("gaming_recharges").select("id", count="exact")
        if channel:
            count_q = count_q.eq("channel", channel)
        if since_iso:
            count_q = count_q.gte("created_at", since_iso)
        if until_iso:
            count_q = count_q.lt("created_at", until_iso)
        total = (count_q.execute()).count or 0

        q = supabase.table("gaming_recharges") \
            .select("""
                id, product_id, coda_sku, channel, user_id, server, order_id,
                status, error_message, created_at, sold_price, sold_currency,
                product:products(name, sku)
            """) \
            .order("created_at", desc=True) \
            .range(offset, offset + page_size - 1)
        if channel:
            q = q.eq("channel", channel)
        if since_iso:
            q = q.gte("created_at", since_iso)
        if until_iso:
            q = q.lt("created_at", until_iso)

        result = q.execute()

        return {
            "items":       result.data or [],
            "total":       total,
            "page":        page,
            "page_size":   page_size,
            "total_pages": max(1, -(-total // page_size)),
        }
    except Exception as e:
        return {"error": str(e)}

# ── Códigos de canje (yape-gaming /redeem/admin/*) ──────────────────────────
# Se venden como pines de un producto de tipo código ("Canje · ...") y el
# comprador los canjea en la página pública. Aquí solo se reenvía al gateway.

class RedeemBatchAdd(BaseModel):
    supplier_id: int
    quantity: int
    prefix: Optional[str] = None


class RedeemNote(BaseModel):
    note: Optional[str] = None


async def _redeem_call(method: str, path: str, *, params: Optional[dict] = None, body: Optional[dict] = None):
    base_url, headers = _gateway_headers()
    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.request(method, f"{base_url}/redeem/admin{path}", headers=headers, params=params, json=body)
    except httpx.HTTPError:
        logger.exception("No se pudo contactar al gateway de recarga directa (canje)")
        raise HTTPException(status_code=502, detail="No se pudo contactar al gateway de recarga directa.")
    try:
        data = resp.json()
    except ValueError:
        data = {}
    if resp.status_code >= 400:
        detail = data.get("message") if isinstance(data, dict) else None
        if not detail and isinstance(data, dict) and isinstance(data.get("detail"), dict):
            detail = data["detail"].get("data")
        raise HTTPException(status_code=resp.status_code, detail=detail or f"Error {resp.status_code} del gateway")
    return data


@router.post("/{product_id}/redeem/batches")
async def create_redeem_batch(product_id: int, body: RedeemBatchAdd):
    """Genera un lote de códigos de canje para una variante de este producto."""
    row = supabase.table("direct_topup_suppliers").select("id").eq("id", body.supplier_id).eq("product_id", product_id).limit(1).execute()
    if not row.data:
        raise HTTPException(status_code=404, detail="Esa variante no es de este producto.")
    return await _redeem_call("POST", "/batches", body={**body.model_dump(), "created_by": "panel"})


@router.get("/{product_id}/redeem/batches")
async def list_redeem_batches(product_id: int):
    return await _redeem_call("GET", "/batches", params={"topup_product_id": product_id})


@router.get("/{product_id}/redeem/codes")
async def list_redeem_codes(product_id: int, batch_id: Optional[str] = None, status: Optional[str] = None,
                            q: Optional[str] = None, page: int = 1, page_size: int = 50):
    params = {"topup_product_id": product_id, "page": page, "page_size": page_size}
    params.update({k: v for k, v in {"batch_id": batch_id, "status": status, "q": q}.items() if v})
    return await _redeem_call("GET", "/codes", params=params)


@router.post("/{product_id}/redeem/codes/{code_id}/{action}")
async def redeem_code_action(product_id: int, code_id: int, action: str, body: Optional[RedeemNote] = None):
    """action: void (anular) · mark-redeemed (sí llegó) · release (no llegó, liberar)."""
    if action not in ("void", "mark-redeemed", "release"):
        raise HTTPException(status_code=404, detail="Acción desconocida.")
    code = supabase.table("redeem_codes").select("supplier_id").eq("id", code_id).limit(1).execute()
    owner = supabase.table("direct_topup_suppliers").select("id").eq("id", (code.data or [{}])[0].get("supplier_id", -1)) \
        .eq("product_id", product_id).limit(1).execute() if code.data else None
    if not owner or not owner.data:
        raise HTTPException(status_code=404, detail="Ese código no es de este producto.")
    return await _redeem_call("POST", f"/codes/{code_id}/{action}", body={"note": body.note if body else None})
