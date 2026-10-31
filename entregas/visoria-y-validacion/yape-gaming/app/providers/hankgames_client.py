# UBICACIÓN EN TU REPO: yape-gaming/app/providers/hankgames_client.py
# (repositorio: yape-gaming · ruta: app/providers/hankgames_client.py)
"""
app/providers/hankgames_client.py

Cliente para Hankgames API (Gamersgold reseller) v1.0
Documentación: https://hankgames.readme.io/reference

- Base URL: https://api.hankgames.com
- Auth: Bearer token, obtenido con POST /v1/reseller/api/auth/token
  (headers x-client-id / x-client-secret). El endpoint no documenta TTL,
  así que cacheamos el token en memoria y lo renovamos automáticamente
  si cualquier llamada responde 401.

Flujo típico de compra en este proveedor (HankgamesProvider.redeem):
  1. create_transaction(product_id, quantity=1, external_order_id, user_id,
     server, zone_id) → { orderId, message }

Este cliente se usa aquí solo para "recarga directa" (acreditación directa
a la cuenta del jugador vía user_id/server/zone_id) — Hankgames no
devuelve código en ese caso, solo confirma la orden. Si en el futuro se
necesita comprar códigos/pines (SKUs sin user_id), el detalle se obtiene
con get_transaction_details(order_id) y se extrae el campo `pin` de cada
elemento de items[] — no con endpoints de "capture" por índice.
"""

import os
import time
import uuid
import asyncio
import logging
from typing import Optional, Any

import httpx

logger = logging.getLogger(__name__)

# ── Config ──────────────────────────────────────────────────────────────────

HANKGAMES_BASE_URL = os.getenv("HANKGAMES_BASE_URL", "https://api.hankgames.com")
HANKGAMES_CLIENT_ID = os.getenv("HANKGAMES_CLIENT_ID", "")
HANKGAMES_CLIENT_SECRET = os.getenv("HANKGAMES_CLIENT_SECRET", "")

_API_PREFIX = "/v1/reseller/api"

# ── Excepciones ───────────────────────────────────────────────────────────

class HankgamesError(Exception):
    """Error genérico devuelto por la API de Hankgames."""

    def __init__(self, message: str, code: Optional[int] = None, payload: Any = None,
                 http_status: Optional[int] = None):
        super().__init__(message)
        self.code = code
        self.payload = payload
        # Código HTTP de la respuesta; None si no hubo respuesta clara
        # (p. ej. deliver-product devolvió algo sin orderId).
        self.http_status = http_status


class HankgamesAuthError(HankgamesError):
    """Credenciales inválidas o token vencido/inválido."""


# ── Token cache ───────────────────────────────────────────────────────────

_token_cache: dict = {"token": None, "expires_at": 0}
# Margen conservador: si la API no dice TTL, renovamos cada 50 min.
_TOKEN_TTL_SECONDS = 50 * 60


def _require_credentials() -> None:
    if not HANKGAMES_CLIENT_ID or not HANKGAMES_CLIENT_SECRET:
        raise HankgamesAuthError(
            "Hankgames no está configurado (HANKGAMES_CLIENT_ID / HANKGAMES_CLIENT_SECRET)."
        )


async def get_token(force_refresh: bool = False) -> str:
    """Obtiene (y cachea) el Bearer token de Hankgames."""
    global _token_cache

    now = time.time()
    if not force_refresh and _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["token"]

    _require_credentials()

    url = f"{HANKGAMES_BASE_URL}{_API_PREFIX}/auth/token"
    headers = {
        "x-client-id": HANKGAMES_CLIENT_ID,
        "x-client-secret": HANKGAMES_CLIENT_SECRET,
    }

    logger.info("[Hankgames] Solicitando nuevo token...")
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(url, headers=headers)

    data = _parse_response(resp)

    # La API no documenta el shape exacto de la respuesta; soportamos las
    # variantes más comunes. Confirmado en producción: OAuth2 estándar
    # {"access_token": "...", "token_type": "Bearer", "expires_in": 3600}.
    token = None
    expires_in = None
    if isinstance(data, str):
        token = data
    elif isinstance(data, dict):
        inner = data.get("data") if isinstance(data.get("data"), dict) else data
        token = (
            inner.get("access_token")
            or inner.get("token")
            or inner.get("accessToken")
        )
        expires_in = inner.get("expires_in") or inner.get("expiresIn")

    if not token:
        raise HankgamesAuthError(f"[Hankgames] No se pudo extraer el token de la respuesta: {data}")

    # Si la API nos dice el TTL real, lo usamos (con margen de 60s); si no,
    # caemos al default conservador de 50 min.
    ttl = _TOKEN_TTL_SECONDS
    if expires_in:
        try:
            ttl = max(int(expires_in) - 60, 60)
        except (TypeError, ValueError):
            pass

    _token_cache = {"token": token, "expires_at": now + ttl}
    logger.info("[Hankgames] Token obtenido: %s...", str(token)[:10])
    return token


def _parse_response(resp: httpx.Response) -> Any:
    """Parsea la respuesta como JSON; si falla, devuelve el texto crudo."""
    try:
        return resp.json()
    except Exception:
        return resp.text


async def _request(
    method: str,
    path: str,
    *,
    json_body: Optional[dict] = None,
    params: Optional[dict] = None,
    retry_on_auth_error: bool = True,
) -> Any:
    """
    Hace una request autenticada contra Hankgames.
    Si responde 401, refresca el token y reintenta una sola vez.
    """
    token = await get_token()
    url = f"{HANKGAMES_BASE_URL}{_API_PREFIX}{path}"
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.request(method, url, headers=headers, json=json_body, params=params)

    if resp.status_code == 401 and retry_on_auth_error:
        logger.warning("[Hankgames] 401 recibido, renovando token y reintentando: %s %s", method, path)
        await get_token(force_refresh=True)
        return await _request(method, path, json_body=json_body, params=params, retry_on_auth_error=False)

    data = _parse_response(resp)

    if resp.status_code >= 400:
        message = data.get("message") if isinstance(data, dict) else str(data)
        code = data.get("code") if isinstance(data, dict) else resp.status_code
        raise HankgamesError(
            f"[Hankgames] {method} {path} → {resp.status_code}: {message}",
            code=code, payload=data, http_status=resp.status_code,
        )

    return data


# ── Metadata / errores ──────────────────────────────────────────────────────

async def get_error_codes() -> Any:
    """GET /error-codes — catálogo de códigos de error de la API."""
    return await _request("GET", "/error-codes")


async def get_api_metadata() -> Any:
    """GET /docs/version — metadata/versión de la API."""
    return await _request("GET", "/docs/version")


# ── Catálogo ──────────────────────────────────────────────────────────────

async def get_categories() -> list:
    """GET /category — lista de categorías disponibles."""
    data = await _request("GET", "/category")
    return _unwrap_list(data)


async def get_products_by_category(category_id: str) -> list:
    """GET /category/{categoryId}/product — productos de una categoría."""
    data = await _request("GET", f"/category/{category_id}/product")
    return _unwrap_list(data)


async def get_product_price(product_id: str) -> Any:
    """GET /product/{productId}/price — precio de un producto."""
    return await _request("GET", f"/product/{product_id}/price")


async def get_product_stock(product_id: str) -> Any:
    """GET /product/{productId}/stock — stock disponible de un producto."""
    return await _request("GET", f"/product/{product_id}/stock")


async def get_server_list(product_id: str) -> list:
    """GET /product/{productId}/server_list — servidores soportados (para topups que requieren server)."""
    data = await _request("GET", f"/product/{product_id}/server_list")
    return _unwrap_list(data)


async def validate_user(
    product_id: str,
    user_id: Optional[str] = None,
    server: Optional[str] = None,
    zone_id: Optional[str] = None,
) -> Any:
    """POST /validate-user/{productId} — valida userId/server/zoneId antes de comprar."""
    body: dict = {}
    if user_id is not None:
        body["userId"] = user_id
    if server is not None:
        body["server"] = server
    if zone_id is not None:
        body["zoneId"] = zone_id
    return await _request("POST", f"/validate-user/{product_id}", json_body=body)


# ── Balance ──────────────────────────────────────────────────────────────

async def get_balance() -> Any:
    """GET /user/balance — saldo de la cuenta reseller."""
    return await _request("GET", "/user/balance")


async def test_connection() -> bool:
    """Prueba rápida de conectividad/credenciales."""
    try:
        await get_balance()
        return True
    except Exception:
        return False


# ── Transacciones ────────────────────────────────────────────────────────

async def create_transaction(
    product_id: str,
    quantity: int = 1,
    external_order_id: Optional[str] = None,
    user_id: Optional[str] = None,
    server: Optional[str] = None,
    zone_id: Optional[str] = None,
    tibia_character_name: Optional[str] = None,
) -> dict:
    """
    POST /deliver-product — crea una transacción (compra de código o
    recarga directa, según si el producto requiere userId/server/zoneId).

    Devuelve {"orderId": ..., "message": ...}.
    """
    data: dict = {
        "productId": product_id,
        "quantity": str(quantity),
    }
    if user_id is not None:
        data["userId"] = user_id
    if server is not None:
        data["server"] = server
    if zone_id is not None:
        data["zoneId"] = zone_id
    if tibia_character_name is not None:
        data["tibiaCharacterName"] = tibia_character_name

    body = {
        "externalOrderId": external_order_id or str(uuid.uuid4()),
        "data": data,
    }

    logger.info(
        "[Hankgames] Creando transacción productId=%s qty=%s externalOrderId=%s",
        product_id, quantity, body["externalOrderId"],
    )
    result = await _request("POST", "/deliver-product", json_body=body)

    if not isinstance(result, dict) or "orderId" not in result:
        raise HankgamesError(f"[Hankgames] Respuesta inesperada de deliver-product: {result}")

    logger.info("[Hankgames] Orden creada orderId=%s", result.get("orderId"))
    return result


async def get_transaction_details(transaction_id: str) -> Any:
    """GET /transaction-status/{transactionId} — estado/detalle de una orden."""
    return await _request("GET", f"/transaction-status/{transaction_id}")


# ── Helpers ──────────────────────────────────────────────────────────────

def _unwrap_list(data: Any) -> list:
    """Normaliza respuestas tipo lista: puede venir como lista directa o {data: [...]}."""
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        inner = data.get("data")
        if isinstance(inner, list):
            return inner
    return []


# ── Provider (implementa app.providers.base.DirectTopupProvider) ──────────
#
# Todo lo de arriba son funciones "crudas" que hablan con la API de
# Hankgames. Esta clase las envuelve para que app/main.py pueda tratar a
# Hankgames exactamente igual que a Coda (CodaProvider) sin conocer sus
# detalles: category→product en vez de apiPath→sku, deliver-product
# síncrono en vez de validate/topup en dos pasos, etc.
#
# Para el `ref` genérico que usan las rutas /gaming/*, usamos el
# productId de Hankgames directo (equivalente al coda_sku de Coda).
# `subtype` se interpreta igual que en Coda: 1=solo userId,
# 2=userId+server, 3=userId+zoneId. have_role no aplica (siempre False).

from app.providers.base import (
    FULFILLED, PROCESSING, REJECTED, UNCERTAIN,
    CatalogEntry, ExecResult, RedeemResult, ValidateResult,
)

# Estados de /transaction-status. La API no documenta la lista completa:
# lo que no esté aquí se trata como "en proceso" (nunca como éxito).
_DONE_STATES = {"finalized", "completed", "complete", "success", "successful", "delivered", "fulfilled"}
_FAILED_STATES = {"failed", "fail", "error", "cancelled", "canceled", "rejected", "refunded"}
# Reintentos cortos de transaction-status justo después de deliver-product.
_STATUS_POLLS = 3
_STATUS_POLL_DELAY = 2.0


def _transaction_state(data: Any) -> Optional[str]:
    """Saca el estado (en minúsculas) de la respuesta de transaction-status."""
    candidates = [data]
    if isinstance(data, dict):
        for key in ("data", "transaction", "order"):
            if isinstance(data.get(key), dict):
                candidates.append(data[key])
    for c in candidates:
        if isinstance(c, dict):
            for key in ("status", "state", "orderStatus", "transactionStatus"):
                value = c.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip().lower()
    return None


def _classify_state(state: Optional[str], order_id: str) -> ExecResult:
    if state in _DONE_STATES:
        return ExecResult(status=FULFILLED, order_id=order_id)
    if state in _FAILED_STATES:
        return ExecResult(status=REJECTED, order_id=order_id, error=f"Hankgames: orden {state}")
    return ExecResult(status=PROCESSING, order_id=order_id)


class HankgamesProvider:
    code = "hankgames"
    can_validate = True

    async def list_admin_products(self) -> list[dict]:
        """Para Hankgames, "productos" en el sentido admin son las categorías."""
        categories = await get_categories()
        return [
            {"name": c.get("name") or c.get("title") or str(c.get("id")), "categoryId": c.get("id") or c.get("categoryId")}
            for c in categories
        ]

    async def list_admin_skus(self, ref: str) -> list[dict]:
        """`ref` acá es el categoryId; devuelve los productos de esa categoría con precio."""
        products = await get_products_by_category(ref)

        async def with_price(product: dict) -> dict:
            # Confirmado en producción: los productos de Hankgames usan
            # `_id` (no `id`/`productId` como las categorías).
            product_id = product.get("_id") or product.get("id") or product.get("productId")
            price = None
            try:
                price_resp = await get_product_price(product_id)
                if isinstance(price_resp, dict):
                    inner = price_resp.get("data") if isinstance(price_resp.get("data"), dict) else price_resp
                    price = inner.get("price") or inner.get("amount") or inner.get("value")
            except Exception:
                logger.warning("[Hankgames] no se pudo obtener precio de productId=%s", product_id)
            return {
                "sku": product_id,
                "title": product.get("name") or product.get("title") or str(product_id),
                "priceAmount": price,
                "priceCurrency": "USD",
                "stock": True,
            }

        return list(await asyncio.gather(*(with_price(p) for p in products)))

    async def current_price(self, supplier: dict, cache: dict) -> Optional[tuple]:
        """Precio vigente (monto, moneda) del producto de esta variante."""
        resp = await get_product_price(supplier["coda_sku"])
        if not isinstance(resp, dict):
            return None
        inner = resp.get("data") if isinstance(resp.get("data"), dict) else resp
        amount = inner.get("price") or inner.get("amount") or inner.get("value")
        if amount is None:
            return None
        return float(amount), (inner.get("currency") or "USD").upper()

    async def get_catalog(self) -> dict[str, CatalogEntry]:
        """
        Hankgames no tiene un único endpoint de catálogo completo (hay que
        recorrer categoría por categoría), y a diferencia de Coda no lo
        cacheamos agresivo acá: el catálogo se usa solo en el panel admin
        (list_admin_products/list_admin_skus), y en el flujo de venta el
        precio se pide fresco por producto (get_product_price) dentro de
        validate(), así que este método no se usa en el camino caliente.
        """
        catalog: dict[str, CatalogEntry] = {}
        try:
            categories = await get_categories()
        except HankgamesError:
            return catalog
        for cat in categories:
            cat_id = cat.get("id") or cat.get("categoryId")
            if not cat_id:
                continue
            try:
                products = await get_products_by_category(cat_id)
            except HankgamesError:
                continue
            for p in products:
                product_id = p.get("_id") or p.get("id") or p.get("productId")
                if not product_id:
                    continue
                catalog[str(product_id)] = CatalogEntry(
                    ref=str(product_id),
                    title=p.get("name") or p.get("title") or str(product_id),
                    subtype=2,
                    have_role=False,
                    stock=True,
                    extra={"categoryId": cat_id},
                )
        return catalog

    async def list_servers(self, ref: str) -> list[dict]:
        try:
            servers = await get_server_list(ref)
        except HankgamesError:
            logger.exception("[Hankgames] error listando servidores de productId=%s", ref)
            return []
        if not isinstance(servers, list):
            return []
        return [
            {"id": s.get("id") or s.get("serverId"), "name": s.get("name") or s.get("serverName")}
            for s in servers
        ]

    async def validate(
        self,
        ref: str,
        user_id: str,
        server: Optional[str],
        role_id: Optional[str],
        zone_id: Optional[str],
        catalog_entry: Optional[CatalogEntry],
    ) -> ValidateResult:
        try:
            resp = await validate_user(ref, user_id=user_id, server=server, zone_id=zone_id)
        except HankgamesError:
            logger.exception("[Hankgames] error de red validando")
            return ValidateResult(valid=False)

        if not isinstance(resp, dict) or resp.get("valid") is False or resp.get("success") is False:
            return ValidateResult(valid=False)

        inner = resp.get("data") if isinstance(resp.get("data"), dict) else resp
        username = inner.get("userName") or inner.get("username") or inner.get("nickname")

        # Precio fresco: Hankgames no separa validate/confirm con precio
        # congelado como Coda, así que solo lo consultamos para guardarlo
        # en el historial (gaming_recharges), no es obligatorio para
        # deliver-product.
        price_amount, price_currency = None, "USD"
        try:
            price_resp = await get_product_price(ref)
            if isinstance(price_resp, dict):
                price_inner = price_resp.get("data") if isinstance(price_resp.get("data"), dict) else price_resp
                price_amount = price_inner.get("price") or price_inner.get("amount") or price_inner.get("value")
                price_currency = (price_inner.get("currency") or price_currency).upper()
        except Exception:
            logger.warning("[Hankgames] no se pudo obtener precio de productId=%s para el historial", ref)

        return ValidateResult(
            valid=True,
            user_name=username or user_id,
            name_verified=bool(username and str(username).strip()),
            server_name=server,
            roles=None,
            pending={
                "ref": ref,
                "user_id": user_id,
                "server": server,
                "zone_id": zone_id,
                "price_amount": price_amount,
                "price_currency": price_currency,
            },
        )

    async def redeem(self, pending: dict, role_id: Optional[str]) -> RedeemResult:
        external_order_id = f"hg-{pending['ref']}-{uuid.uuid4().hex[:12]}"
        return (await self.execute(pending, role_id, external_ref=external_order_id)).to_redeem()

    async def execute(self, pending: dict, role_id: Optional[str], external_ref: str) -> ExecResult:
        """deliver-product y luego unas pocas consultas de estado.

        - Error HTTP 4xx de Hankgames → REJECTED (no creó la orden).
        - Red, timeout, 5xx o respuesta sin orderId → UNCERTAIN (pudo crearse).
        - Con orderId: se consulta transaction-status; si no termina en
          unos segundos queda PROCESSING y se revisa después.
        """
        try:
            order = await create_transaction(
                product_id=pending["ref"],
                quantity=1,
                external_order_id=external_ref or f"hg-{pending['ref']}-{uuid.uuid4().hex[:12]}",
                user_id=pending["user_id"],
                server=pending.get("server"),
                zone_id=pending.get("zone_id"),
            )
        except HankgamesError as e:
            if e.http_status is not None and 400 <= e.http_status < 500:
                return ExecResult(status=REJECTED, error=str(e))
            logger.error("[Hankgames] deliver-product sin respuesta clara: %s", e)
            return ExecResult(status=UNCERTAIN, error=str(e))
        except (httpx.HTTPError, ValueError) as e:
            logger.error("[Hankgames] deliver-product sin respuesta (%s): %s", type(e).__name__, e)
            return ExecResult(status=UNCERTAIN, error=f"Sin respuesta de Hankgames: {type(e).__name__}")

        order_id = str(order.get("orderId"))
        result = ExecResult(status=PROCESSING, order_id=order_id)
        for attempt in range(_STATUS_POLLS):
            if attempt:
                await asyncio.sleep(_STATUS_POLL_DELAY)
            result = await self.check_status(order_id)
            if result.status in (FULFILLED, REJECTED):
                return result
        # Orden creada pero sin estado final todavía: nunca UNCERTAIN aquí,
        # porque hay order_id para seguir consultando.
        return ExecResult(status=PROCESSING, order_id=order_id, error=result.error)

    async def check_status(self, order_id: str) -> ExecResult:
        try:
            data = await get_transaction_details(order_id)
        except (HankgamesError, httpx.HTTPError, ValueError) as e:
            logger.warning("[Hankgames] no se pudo consultar orderId=%s: %s", order_id, e)
            return ExecResult(status=PROCESSING, order_id=order_id, error=str(e))
        state = _transaction_state(data)
        result = _classify_state(state, order_id)
        # Registrar el estado tal cual lo manda Hankgames: su documentación no lista todos.
        log = logger.info if state in _DONE_STATES | _FAILED_STATES else logger.warning
        log("[Hankgames] estado orderId=%s: %r → %s", order_id, state, result.status)
        return result
