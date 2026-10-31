# UBICACIÓN EN TU REPO: yape-gaming/app/main.py
# (repositorio: yape-gaming · ruta: app/main.py)
"""
yape-gaming
===========

Servicio independiente para recargas en vivo de gaming (Coda xShop,
Hankgames, y cualquier proveedor futuro). Antes vivia combinado con
/pines (venta de codigos) en un solo deploy (yape-gateway). Se separaron
para que un problema en este codigo no pueda tumbar la venta de pines,
y viceversa. La venta de pines vive ahora en su propio repo/deploy:
yape-pines (rutas /auth/, /game/ segun Endpoints.md - esas NO se tocaron,
siguen igual para Yape).

Arquitectura de proveedores (app/providers/):
    base.py              interfaz DirectTopupProvider (ver docstring ahi)
    coda_client.py        CodaProvider
    hankgames_client.py    HankgamesProvider (+ funciones crudas que tambien
                           usa fastapi-gift-cards-feature para compra de
                           codigos, no relacionado a este archivo)

Las rutas /gaming/* son genericas: no conocen los detalles de cada
proveedor, solo despachan segun la columna `provider` de
direct_topup_suppliers (ver migracion
supabase_migrations/20260816_add_provider_to_direct_topup_suppliers.sql).
Agregar un proveedor nuevo = escribir una clase que implemente
DirectTopupProvider y registrarla en PROVIDERS mas abajo.

Los endpoints de ADMIN (para que el panel mapee productos) SI son
especificos por proveedor, porque cada API expone su catalogo con una
forma distinta (Coda: apiPath -> listSku; Hankgames: categoryId ->
productos). Viven en /gaming/admin/* (Coda, sin cambios de ruta para no
romper al backend principal que ya los llama) y /hankgames/admin/*.

Variables de entorno requeridas:
    CODA_BASE_URL
    CODA_API_KEY
    CODA_CLIENT_ID
    CODA_SECRET
    YAPE_GAMING_JWT_SECRET
    REDIS_URL
    GAMING_ADMIN_KEY        (opcional, para que el panel admin lea el catalogo)
    SUPABASE_URL            (historial de recargas + credencial del canal yape_gaming)
    SUPABASE_SERVICE_KEY

    HANKGAMES_CLIENT_ID     (recarga directa via Hankgames)
    HANKGAMES_CLIENT_SECRET
    HANKGAMES_BASE_URL      (opcional, default https://api.hankgames.com)

    INTERNAL_TOPUP_KEY      (motor de recargas para codes-hub, /internal/topups/*;
                             sin ella esas rutas responden 503)

    Canje de códigos (/redeem/*, página pública en WordPress):
    TURNSTILE_SECRET        (captcha de Cloudflare; sin ella las rutas públicas responden 503)
    REDEEM_ALLOWED_ORIGINS  (dominios que pueden llamar a /redeem/*, separados por coma)
    REDEEM_CAPTCHA_DISABLED (true solo para pruebas)

Nota: el x-api-key que usa Yape para /gaming/auth/ YA NO es una env var fija.
Se genera/rota desde el panel admin (POST /admin/gateway-api-keys/yape_gaming/generate
en fastapi-gift-cards-feature) y se guarda hasheado en la tabla
gateway_api_keys de Supabase, igual que las credenciales de pines.
"""

import asyncio
import os
import time
import hmac
import hashlib
import base64
import json
import logging
from typing import Optional, Any

import bcrypt
import redis.asyncio as redis
from fastapi import FastAPI, APIRouter, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from supabase import create_client, Client

from app.providers.base import FULFILLED, REJECTED, UNCERTAIN, CatalogEntry, DirectTopupProvider, ExecResult
from app.providers.coda_client import CodaProvider
from app.providers.hankgames_client import HankgamesProvider
from app.providers.visoria_client import VisoriaProvider
from app.topups.engine import TopupEngine, parse_fx_rates
from app.topups.router import build_router as build_topups_router, reconcile_loop
from app.topups.store import TopupStore
from app.redeem.router import build_router as build_redeem_router, reconcile_loop as redeem_reconcile_loop
from app.redeem.security import Captcha, RateLimiter
from app.redeem.service import RedeemService
from app.redeem.store import RedeemStore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("yape-gaming")

app = FastAPI(title="yape-gaming")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


# Historial de recargas (Supabase) - la usa gaming_router mas abajo
SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


# ════════════════════════════════════════════════════════════════════════
#  Config compartida + registro de proveedores
# ════════════════════════════════════════════════════════════════════════

GAMING_JWT_SECRET = os.environ["YAPE_GAMING_JWT_SECRET"]
REDIS_URL = os.environ["REDIS_URL"]
# Key separada para que el panel admin (via el backend principal) lea el
# catalogo de recarga directa. No confundir con la del canal yape_gaming.
GAMING_ADMIN_KEY = os.environ.get("GAMING_ADMIN_KEY", "")
GAMING_TOKEN_TTL_SECONDS = 600  # 10 min, Yape pidio explicitamente > 5 min
VALIDATION_TTL_SECONDS = 300
CATALOG_TTL_SECONDS = 300

redis_client = redis.from_url(REDIS_URL, decode_responses=True)

PROVIDERS: dict[str, DirectTopupProvider] = {
    "coda": CodaProvider(
        base_url=os.environ["CODA_BASE_URL"],
        api_key=os.environ["CODA_API_KEY"],
        client_id=os.environ["CODA_CLIENT_ID"],
        secret=os.environ["CODA_SECRET"],
        redis_client=redis_client,
        catalog_ttl_seconds=CATALOG_TTL_SECONDS,
    ),
    "hankgames": HankgamesProvider(),
    # Solo recarga (no valida cuentas). Necesita VISORIA_API_KEY.
    "visoria": VisoriaProvider(),
}


def get_provider(code: str) -> DirectTopupProvider:
    provider = PROVIDERS.get(code)
    if not provider:
        raise HTTPException(status_code=500, detail={"success": False, "data": f"Proveedor desconocido: {code}"})
    return provider


def pending_key(product_id: str, user_id: str, server: Optional[str]) -> str:
    return f"yape_gaming:pending:{product_id}:{user_id}:{server or ''}"


def issue_gaming_token(channel: str) -> str:
    payload = json.dumps({"exp": int(time.time()) + GAMING_TOKEN_TTL_SECONDS, "channel": channel}).encode()
    payload_b64 = _b64url(payload)
    sig = hmac.new(GAMING_JWT_SECRET.encode(), payload_b64.encode(), hashlib.sha256).digest()
    return f"{payload_b64}.{_b64url(sig)}"


def decode_gaming_token(token: str) -> Optional[dict]:
    """Valida el token y devuelve su payload ({exp, channel}), o None si es invalido/expirado."""
    try:
        payload_b64, sig_b64 = token.split(".")
        expected_sig = _b64url(hmac.new(GAMING_JWT_SECRET.encode(), payload_b64.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig_b64, expected_sig):
            return None
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=="))
        if int(payload["exp"]) <= int(time.time()):
            return None
        return payload
    except Exception:
        return None


def require_gaming_bearer(authorization: Optional[str]) -> str:
    """Valida el bearer y devuelve el nombre del consumidor (channel) que lo emitio."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail={"success": False, "data": "Missing bearer token"})
    token = authorization[len("Bearer "):].strip()
    payload = decode_gaming_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail={"success": False, "data": "Invalid or expired token"})
    # Tokens viejos (emitidos antes de este cambio) no tienen "channel" -
    # se tratan como "yape" para no romper sesiones ya en curso.
    return payload.get("channel", "yape")


def require_admin_key(x_admin_key: Optional[str]) -> None:
    if not GAMING_ADMIN_KEY or not x_admin_key or not hmac.compare_digest(x_admin_key, GAMING_ADMIN_KEY):
        raise HTTPException(status_code=401, detail={"success": False, "data": "Invalid admin key"})


async def resolve_product_ref(channel: str, client_product_id: str) -> tuple[str, str]:
    """
    Resuelve un productId "publico" (el que manda el consumidor, puede ser
    un custom_product_id para no exponer el ref real del proveedor) a
    (provider_code, provider_ref).

    Si no matchea ningun custom_product_id para este canal, se asume que
    ya es un ref directo del proveedor "coda" (compatibilidad con
    consumidores viejos que no usan ids personalizados).
    """
    row = supabase.table("direct_topup_channels") \
        .select("supplier_id, supplier:direct_topup_suppliers!inner(coda_sku, provider)") \
        .eq("channel", channel) \
        .eq("custom_product_id", client_product_id) \
        .eq("is_active", True) \
        .limit(1).execute()
    if row.data and row.data[0].get("supplier"):
        supplier = row.data[0]["supplier"]
        return supplier.get("provider") or "coda", supplier["coda_sku"]
    return "coda", client_product_id


# ════════════════════════════════════════════════════════════════════════
#  /gaming  — rutas genericas de venta (Coda, Hankgames, futuros)
# ════════════════════════════════════════════════════════════════════════

gaming_router = APIRouter(prefix="/gaming")


@gaming_router.post("/auth/")
async def gaming_auth(x_api_key: Optional[str] = Header(None)):
    if not x_api_key:
        raise HTTPException(status_code=401, detail={"success": False, "data": "Missing x-api-key"})

    # Ya no hay un solo "GAMING_CHANNEL" fijo: cualquier consumidor (Yape,
    # una pagina propia, etc) tiene su propia fila en gateway_api_keys,
    # identificada por nombre. Se prueba el x-api-key recibido contra
    # todas las claves activas hasta encontrar cual es.
    rows = supabase.table("gateway_api_keys") \
        .select("channel, key_hash") \
        .eq("is_active", True).execute()

    matched_channel = None
    for row in (rows.data or []):
        if bcrypt.checkpw(x_api_key.encode(), row["key_hash"].encode()):
            matched_channel = row["channel"]
            break

    if not matched_channel:
        raise HTTPException(status_code=401, detail={"success": False, "data": "Invalid API key"})

    return {"success": True, "data": issue_gaming_token(matched_channel)}


@gaming_router.get("/products/")
async def gaming_list_products(authorization: Optional[str] = Header(None)):
    """
    Productos configurados para el canal del consumidor autenticado, sin
    importar de que proveedor vengan (Coda, Hankgames, ...).
    """
    channel = require_gaming_bearer(authorization)

    try:
        listings = supabase.table("direct_topup_channels") \
            .select("supplier_id, sell_price, custom_product_id, custom_title, "
                    "supplier:direct_topup_suppliers!inner(id, product_id, coda_sku, provider, title, variant_label, is_active), "
                    "product:products(name)") \
            .eq("channel", channel) \
            .eq("is_active", True) \
            .execute().data or []
    except Exception:
        logger.exception("Error consultando direct_topup_channels en gaming_list_products (channel=%s)", channel)
        raise

    # Para saber si Coda todavia tiene el SKU disponible se consulta su
    # catalogo cacheado. Los demas proveedores (Hankgames, etc) no tienen
    # un catalogo completo barato de cachear aca, asi que se asume stock
    # disponible (igual que hacia Coda antes de tener este cache).
    coda_catalog: dict[str, CatalogEntry] = {}
    if any((row.get("supplier") or {}).get("provider", "coda") == "coda" for row in listings):
        try:
            coda_catalog = await get_provider("coda").get_catalog()
        except Exception:
            logger.exception("No se pudo refrescar el catalogo de Coda para chequear stock")

    data = []
    for row in listings:
        supplier = row.get("supplier")
        if not supplier or not supplier.get("is_active"):
            continue
        provider_code = supplier.get("provider") or "coda"
        ref = supplier["coda_sku"]
        product_name = (row.get("product") or {}).get("name")
        variant_label = supplier.get("variant_label")
        base_title = " - ".join(p for p in [product_name, variant_label] if p) \
            or supplier.get("title") or ref
        stock = (ref in coda_catalog) if provider_code == "coda" else True
        data.append({
            # Nunca exponemos el ref real del proveedor: si el canal
            # configuro un id personalizado, se usa ese; si no, fallback
            # al ref (mismo comportamiento que antes, compatibilidad).
            "productId": row.get("custom_product_id") or ref,
            "stock": stock,
            "title": row.get("custom_title") or base_title,
        })
    return {"success": True, "data": data}


@gaming_router.get("/servers/{product_id}")
async def gaming_list_servers(product_id: str, authorization: Optional[str] = Header(None)):
    """Servidores reales del proveedor para un producto subtype=2 (userId+server)."""
    channel = require_gaming_bearer(authorization)
    provider_code, ref = await resolve_product_ref(channel, product_id)
    provider = get_provider(provider_code)

    try:
        servers = await provider.list_servers(ref)
    except Exception:
        logger.exception("Error listando servidores en %s", provider_code)
        return {"success": False, "data": "Error de comunicacion con el proveedor"}

    if not servers:
        return {"success": False, "data": "Este producto no usa seleccion de servidor, o no se encontro"}
    return {"success": True, "data": servers}


class ValidateUserRequest(BaseModel):
    server: Optional[str] = None
    userId: str
    productId: str
    roleId: Optional[str] = None
    zoneId: Optional[str] = None


@gaming_router.post("/validate-user/")
async def gaming_validate_user(body: ValidateUserRequest, authorization: Optional[str] = Header(None)):
    channel = require_gaming_bearer(authorization)
    provider_code, ref = await resolve_product_ref(channel, body.productId)
    provider = get_provider(provider_code)

    supplier_res = supabase.table("direct_topup_suppliers") \
        .select("product_id, coda_sku, provider, is_active") \
        .eq("coda_sku", ref) \
        .eq("provider", provider_code) \
        .eq("is_active", True) \
        .limit(1).execute()
    if not supplier_res.data:
        return {"valid": False, "userName": None}
    supplier = supplier_res.data[0]

    catalog_entry: Optional[CatalogEntry] = None
    if provider_code == "coda":
        # Coda necesita el precio EN VIVO del catalogo cacheado antes de
        # poder validar (ver CodaProvider.validate) - sin esto Coda
        # rechaza con "Price Error" si el precio cambio.
        try:
            catalog_entry = await provider.get_catalog_entry(ref)  # type: ignore[attr-defined]
        except AttributeError:
            pass

    result = await provider.validate(
        ref=ref,
        user_id=body.userId,
        server=body.server,
        role_id=body.roleId,
        zone_id=body.zoneId,
        catalog_entry=catalog_entry,
    )

    if not result.valid:
        return {"valid": False, "userName": None}

    key = pending_key(body.productId, body.userId, body.server)
    payload = json.dumps({
        "provider": provider_code,
        "product_id": supplier["product_id"],
        "channel": channel,
        **result.pending,
    })
    await redis_client.setex(key, VALIDATION_TTL_SECONDS, payload)

    response: dict[str, Any] = {"valid": True, "userName": result.user_name or body.userId}
    if result.server_name:
        response["server"] = result.server_name
    if result.roles is not None:
        # El usuario todavia tiene que elegir un rol antes de poder
        # confirmar la recarga: se le manda la lista para armar su
        # selector, y el id elegido se manda recien en /recharge/.
        response["roles"] = result.roles
    return response


class RechargeRequest(BaseModel):
    productId: str
    userId: str
    server: Optional[str] = None
    roleId: Optional[str] = None
    externalPaymentId: Optional[str] = None


@gaming_router.post("/recharge/")
async def gaming_recharge(body: RechargeRequest, authorization: Optional[str] = Header(None)):
    auth_channel = require_gaming_bearer(authorization)

    key = pending_key(body.productId, body.userId, body.server)
    raw = await redis_client.get(key)
    if not raw:
        return {"success": False, "data": "No hay una validacion vigente para este usuario. Llama a /gaming/validate-user/ primero."}

    pending = json.loads(raw)
    provider = get_provider(pending.get("provider", "coda"))

    # Se borra ANTES de recargar: así un doble clic no puede usar la misma
    # validación dos veces mientras la primera todavía está en curso.
    await redis_client.delete(key)
    try:
        exec_result = await provider.execute(pending, role_id=body.roleId, external_ref="")
    except Exception as e:
        logger.exception("Error inesperado recargando en %s", pending.get("provider", "coda"))
        exec_result = ExecResult(UNCERTAIN, error=f"Error inesperado ({type(e).__name__})")
    result = exec_result.to_redeem()

    if exec_result.status == FULFILLED:
        _log_recharge(pending, body, status="FULFILLED", order_id=result.order_id, fallback_channel=auth_channel)
        return {"success": True, "data": result.order_id}

    # REJECTED → FAILED (no se cobró). PROCESSING / UNCERTAIN quedan con su
    # propio estado para revisarlas: pudieron haberse hecho.
    status = "FAILED" if exec_result.status == REJECTED else exec_result.status.upper()
    _log_recharge(pending, body, status=status, order_id=exec_result.order_id,
                  error=exec_result.error, fallback_channel=auth_channel)
    return {"success": False, "data": result.error or "Recharge fallo"}


def _log_recharge(pending: dict, body: "RechargeRequest", status: str, order_id: Optional[str] = None, error: Optional[str] = None, fallback_channel: str = "yape") -> None:
    try:
        supabase.table("gaming_recharges").insert({
            "product_id": pending.get("product_id"),
            "coda_sku": pending.get("ref") or body.productId,
            # El consumidor real: viene del pending guardado en validate-user
            # (ver /gaming/auth/), no un valor fijo. fallback_channel cubre
            # el caso raro de pendings viejos guardados antes de este cambio.
            "channel": pending.get("channel") or fallback_channel,
            "user_id": body.userId,
            "server": body.server,
            "order_id": order_id,
            "status": status,
            "error_message": error,
            "sold_price": pending.get("price_amount"),
            "sold_currency": pending.get("price_currency"),
        }).execute()
    except Exception:
        logger.exception("No se pudo registrar el historial de recarga (no bloquea la venta)")


# ── Admin: Coda (ruta sin cambios — el backend principal ya la llama) ──────

@gaming_router.get("/admin/products")
async def gaming_admin_products(x_admin_key: Optional[str] = Header(None)):
    """Solo lectura: juegos topup elegibles de Coda, sin SKUs (barato)."""
    require_admin_key(x_admin_key)
    try:
        data = await get_provider("coda").list_admin_products()
    except Exception:
        logger.exception("Error consultando catalogo de Coda")
        raise HTTPException(status_code=502, detail={"success": False, "data": "No se pudo contactar a Coda"})
    return {"success": True, "data": data}


@gaming_router.get("/admin/products/{api_path:path}/skus")
async def gaming_admin_product_skus(api_path: str, x_admin_key: Optional[str] = Header(None)):
    """SKUs en vivo de un solo juego de Coda, pedidos on-demand desde el modal de mapeo."""
    require_admin_key(x_admin_key)
    try:
        data = await get_provider("coda").list_admin_skus(api_path)
    except Exception as e:
        logger.exception("Error listando SKUs de Coda para %s", api_path)
        raise HTTPException(status_code=502, detail={"success": False, "data": str(e)})
    return {"success": True, "data": data}


@gaming_router.get("/admin/catalog")
async def gaming_admin_catalog(x_admin_key: Optional[str] = Header(None)):
    """Solo lectura: catalogo completo de Coda para el tab 'Recarga Directa' del panel."""
    require_admin_key(x_admin_key)
    catalog = await get_provider("coda").get_catalog()
    return {
        "success": True,
        "data": [
            {
                "sku": entry.ref,
                "title": entry.title,
                "apiPath": entry.extra.get("apiPath"),
                "subtype": entry.subtype,
                "haveRole": entry.have_role,
                "stock": entry.stock,
                "priceAmount": entry.price_amount,
                "priceCurrency": entry.price_currency,
            }
            for entry in catalog.values()
        ],
    }


app.include_router(gaming_router)


# ════════════════════════════════════════════════════════════════════════
#  /hankgames  — solo endpoints de ADMIN (mapeo de productos). La venta en
#  si va por las rutas genericas /gaming/* de arriba, ya que Hankgames
#  esta registrado en PROVIDERS igual que Coda.
# ════════════════════════════════════════════════════════════════════════

hankgames_router = APIRouter(prefix="/hankgames")


@hankgames_router.get("/admin/categories")
async def hankgames_admin_categories(x_admin_key: Optional[str] = Header(None)):
    """Categorias de Hankgames en vivo, para que el admin busque que categoria mapear."""
    require_admin_key(x_admin_key)
    try:
        data = await get_provider("hankgames").list_admin_products()
    except Exception as e:
        logger.exception("Error consultando categorias de Hankgames")
        raise HTTPException(status_code=502, detail={"success": False, "data": str(e)})
    return {"success": True, "data": data}


@hankgames_router.get("/admin/categories/{category_id}/products")
async def hankgames_admin_category_products(category_id: str, x_admin_key: Optional[str] = Header(None)):
    """Productos en vivo (con precio) de una categoria de Hankgames, pedidos on-demand."""
    require_admin_key(x_admin_key)
    try:
        data = await get_provider("hankgames").list_admin_skus(category_id)
    except Exception as e:
        logger.exception("Error listando productos de Hankgames para categoria=%s", category_id)
        raise HTTPException(status_code=502, detail={"success": False, "data": str(e)})
    return {"success": True, "data": data}


app.include_router(hankgames_router)


# ════════════════════════════════════════════════════════════════════════
#  /visoria  — solo ADMIN (buscar productos de recarga para mapearlos).
#  Visoria no tiene listado de juegos: se busca por nombre.
# ════════════════════════════════════════════════════════════════════════

visoria_router = APIRouter(prefix="/visoria")


@visoria_router.get("/admin/games")
async def visoria_admin_games(q: str = Query(..., min_length=2, max_length=120),
                              x_admin_key: Optional[str] = Header(None)):
    """Juegos (categorías) de Visoria con productos de recarga que coinciden con `q`."""
    require_admin_key(x_admin_key)
    try:
        data = await get_provider("visoria").search_games(q)
    except Exception as e:
        logger.exception("Error buscando juegos en Visoria (q=%s)", q)
        raise HTTPException(status_code=502, detail={"success": False, "data": str(e)})
    return {"success": True, "data": data}


@visoria_router.get("/admin/games/products")
async def visoria_admin_game_products(name: str = Query(..., min_length=1, max_length=120),
                                      x_admin_key: Optional[str] = Header(None)):
    """Productos de recarga (con precio) de un juego de Visoria, por nombre de categoría."""
    require_admin_key(x_admin_key)
    try:
        data = await get_provider("visoria").list_admin_skus(name)
    except Exception as e:
        logger.exception("Error listando productos de Visoria (juego=%s)", name)
        raise HTTPException(status_code=502, detail={"success": False, "data": str(e)})
    return {"success": True, "data": data}


app.include_router(visoria_router)


# ════════════════════════════════════════════════════════════════════════
#  /internal/topups  — motor de recargas para codes-hub (ver app/topups/)
# ════════════════════════════════════════════════════════════════════════

INTERNAL_TOPUP_KEY = os.environ.get("INTERNAL_TOPUP_KEY", "")
# Para recargar con el proveedor más barato: costos en otras monedas se
# pasan a USD. Ej: TOPUP_FX_TO_USD="PEN=0.27,EUR=1.08".
topup_engine = TopupEngine(PROVIDERS, TopupStore(supabase), redis_client,
                           fx_rates=parse_fx_rates(os.environ.get("TOPUP_FX_TO_USD")))
app.include_router(build_topups_router(topup_engine, INTERNAL_TOPUP_KEY))


@app.on_event("startup")
async def _start_topup_reconcile() -> None:
    if INTERNAL_TOPUP_KEY:
        app.state.topup_reconcile = asyncio.create_task(reconcile_loop(topup_engine, redis_client))
    app.state.redeem_reconcile = asyncio.create_task(redeem_reconcile_loop(redeem_service, redis_client))


# ════════════════════════════════════════════════════════════════════════
#  /redeem  — códigos de canje (ver app/redeem/)
# ════════════════════════════════════════════════════════════════════════

redeem_service = RedeemService(RedeemStore(supabase), topup_engine, redis_client, Captcha.from_env(), RateLimiter(redis_client))
app.include_router(build_redeem_router(redeem_service, require_admin_key))

REDEEM_ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("REDEEM_ALLOWED_ORIGINS", "").split(",") if o.strip()]
if REDEEM_ALLOWED_ORIGINS:
    # Solo la página de canje llama desde un navegador; las demás rutas piden claves.
    app.add_middleware(CORSMiddleware, allow_origins=REDEEM_ALLOWED_ORIGINS, allow_methods=["POST"],
                       allow_headers=["Content-Type"], allow_credentials=False)


@app.get("/healthz")
async def healthz():
    return {"ok": True}