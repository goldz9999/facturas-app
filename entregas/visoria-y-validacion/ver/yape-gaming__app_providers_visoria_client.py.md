# visoria_client.py

**Repositorio:** `yape-gaming`  
**Ruta:** `app/providers/visoria_client.py`

Copia TODO el bloque de abajo y reemplaza el archivo completo.

````python
"""
app/providers/visoria_client.py

Visoria (https://api.visoria.digital) como proveedor de recarga directa.

Visoria NO valida cuentas: no dice de quién es un ID. Por eso
can_validate = False: en el motor de recargas solo RECARGA, y el nombre
del jugador lo da otro proveedor del grupo (Coda, Hankgames). validate()
acá solo arma la orden (los campos que pide el producto) sin llamar a
nadie más que al detalle del producto.

API (ver documentación de Visoria):
  - Auth: header X-Api-Key. Con una key vsk_test_ todo va al sandbox de
    Visoria (órdenes simuladas, saldo de prueba), mismas rutas.
  - GET  /v1/products?search=        catálogo (fulfillment_type RECHARGE = recarga)
  - GET  /v1/products/{id}           detalle, con recharge_fields
  - POST /v1/orders                  con idempotency_key y recharge_data
  - GET  /v1/orders/by-idempotency-key/{key}   estado de la orden

La orden se identifica con su idempotency_key (derivada de nuestra
referencia de la recarga): así se puede consultar aunque la respuesta del
POST se haya perdido, y reintentar nunca crea una segunda orden.

Variables:
  VISORIA_API_KEY   (obligatoria para usarlo)
  VISORIA_BASE_URL  (opcional, default https://api.visoria.digital)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
import uuid
from typing import Any, Optional

import httpx

from app.providers.base import (
    FULFILLED, PROCESSING, REJECTED, UNCERTAIN, CatalogEntry, ExecResult, RedeemResult, ValidateResult,
)

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.visoria.digital"
PRODUCT_TTL_SECONDS = 300
_STATUS_POLLS = 3
_STATUS_POLL_DELAY = 2.0


class VisoriaError(Exception):
    def __init__(self, message: str, http_status: Optional[int] = None, code: Optional[str] = None):
        super().__init__(message)
        self.http_status = http_status
        self.code = code


class MissingField(Exception):
    pass


def _base_url() -> str:
    return (os.environ.get("VISORIA_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


async def _request(method: str, path: str, *, timeout: float = 20.0, **kwargs) -> Any:
    key = os.environ.get("VISORIA_API_KEY", "")
    if not key:
        raise VisoriaError("VISORIA_API_KEY no está configurada")
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.request(method, f"{_base_url()}{path}", headers={"X-Api-Key": key}, **kwargs)
    if resp.status_code >= 400:
        try:
            body = resp.json()
        except ValueError:
            body = {}
        code = body.get("code") if isinstance(body, dict) else None
        message = body.get("message") if isinstance(body, dict) else None
        raise VisoriaError(f"Visoria {resp.status_code} {code or ''}: {message or resp.text[:200]}".strip(),
                           http_status=resp.status_code, code=code)
    return resp.json()


# ── Catálogo ─────────────────────────────────────────────────────────────

_product_cache: dict[str, tuple[float, dict]] = {}


async def get_product(product_id: str) -> dict:
    cached = _product_cache.get(product_id)
    if cached and cached[0] > time.monotonic():
        return cached[1]
    product = await _request("GET", f"/v1/products/{product_id}")
    _product_cache[product_id] = (time.monotonic() + PRODUCT_TTL_SECONDS, product)
    return product


async def search_products(query: str, max_pages: int = 5) -> list[dict]:
    """Productos que coinciden con la búsqueda (todas las palabras deben coincidir)."""
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        data = await _request("GET", "/v1/products", params={"search": query, "limit": 100, "page": page})
        items = data.get("data") or []
        out.extend(items)
        total = (data.get("meta") or {}).get("total") or 0
        if not items or len(out) >= total:
            break
    return out


def is_recharge(product: dict) -> bool:
    return (product.get("fulfillment_type") or "").upper() == "RECHARGE"


def category_of(product: dict) -> dict:
    cats = product.get("categories") or []
    return cats[0] if cats else {"id": "", "name": "Sin categoría"}


def _field_kind(field: dict) -> str:
    """Qué dato de la cuenta pide un campo de Visoria: user_id, zone_id, server o role."""
    name = f"{field.get('field_name', '')} {field.get('api_field_name', '')}".lower()
    if (field.get("input_type") or "").lower() == "lookup" or "character" in name or "role" in name:
        return "role"
    if "zone" in name:
        return "zone_id"
    if "server" in name:
        return "server"
    return "user_id"


def guess_subtype(fields: Optional[list]) -> int:
    kinds = {_field_kind(f) for f in fields or []}
    if "server" in kinds:
        return 2
    if "zone_id" in kinds:
        return 3
    return 1


def build_custom_value(fields: Optional[list], account: dict, role_id: Optional[str] = None) -> list[dict]:
    """Arma recharge_data.custom_value con los datos de la cuenta.

    El primer campo "genérico" recibe el user_id; zona, servidor y personaje
    se reconocen por el nombre del campo. Un campo obligatorio que no se
    puede llenar → MissingField (la orden no se envía).
    """
    values: list[dict] = []
    user_used = False
    for field in fields or []:
        kind = _field_kind(field)
        if kind == "user_id":
            value = None if user_used else account.get("user_id")
            user_used = user_used or value is not None
        elif kind == "server":
            value = account.get("server") or account.get("zone_id")
        elif kind == "role":
            value = role_id
        else:
            value = account.get(kind)
        if value not in (None, ""):
            values.append({"field_name": field["field_name"], "value_code": str(value)})
        elif field.get("required"):
            raise MissingField(field.get("label") or field.get("field_name"))
    if not values:
        raise MissingField("user_id")
    return values


def admin_sku(product: dict) -> dict:
    fields = product.get("recharge_fields") or []
    return {
        "sku": product.get("id"),
        "title": product.get("name"),
        "priceAmount": product.get("price"),
        "priceCurrency": product.get("currency_code"),
        "stock": bool(product.get("orderable")),
        "subtype": guess_subtype(fields),
        "haveRole": any(_field_kind(f) == "role" for f in fields),
        "fields": [{"name": f.get("field_name"), "label": f.get("label"), "required": bool(f.get("required"))}
                   for f in fields],
    }


# ── Órdenes ──────────────────────────────────────────────────────────────

def idempotency_key(external_ref: str) -> str:
    """Siempre la misma para la misma recarga nuestra (UUID, 36 caracteres)."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"visoria-topup:{external_ref}"))


def classify_order(order: dict, key: str) -> ExecResult:
    status = (order.get("status") or "").upper()
    keys = [k for item in order.get("items") or [] for k in item.get("keys") or []]
    if status == "CANCELLED":
        return ExecResult(REJECTED, order_id=key, error="Visoria canceló la orden")
    if keys and all((k.get("status") or "").upper() == "REFUNDED" for k in keys):
        reason = next((k.get("refund_reason") for k in keys if k.get("refund_reason")), None)
        return ExecResult(REJECTED, order_id=key, error=f"Visoria devolvió la recarga{': ' + reason if reason else ''}")
    if status == "COMPLETED":
        return ExecResult(FULFILLED, order_id=key)
    return ExecResult(PROCESSING, order_id=key)


class VisoriaProvider:
    code = "visoria"
    can_validate = False   # no devuelve de quién es la cuenta

    # ── Admin (mapeo desde el panel) ────────────────────────────────────

    async def search_games(self, query: str) -> list[dict]:
        """Juegos (categorías) con productos de recarga que coinciden con la búsqueda."""
        games: dict[str, dict] = {}
        for product in await search_products(query):
            if not is_recharge(product):
                continue
            cat = category_of(product)
            game = games.setdefault(cat.get("name") or "", {"name": cat.get("name"), "categoryId": cat.get("id"), "count": 0})
            game["count"] += 1
        return sorted(games.values(), key=lambda g: g["name"] or "")

    async def list_admin_products(self) -> list[dict]:
        # Visoria no tiene un listado de juegos: se busca por nombre (search_games).
        return []

    async def list_admin_skus(self, ref: str) -> list[dict]:
        """`ref` = nombre del juego (categoría): sus productos de recarga con precio."""
        products = [p for p in await search_products(ref)
                    if is_recharge(p) and (category_of(p).get("name") or "") == ref]
        return [admin_sku(p) for p in products]

    async def get_catalog(self) -> dict[str, CatalogEntry]:
        return {}

    async def current_price(self, supplier: dict, cache: dict) -> Optional[tuple]:
        """Precio vigente (monto, moneda) del producto de esta variante."""
        _product_cache.pop(supplier["coda_sku"], None)   # siempre fresco
        product = await get_product(supplier["coda_sku"])
        if product.get("price") is None:
            return None
        return float(product["price"]), product.get("currency_code")

    async def list_servers(self, ref: str) -> list[dict]:
        try:
            product = await get_product(ref)
        except (VisoriaError, httpx.HTTPError):
            logger.exception("[Visoria] no se pudo leer el producto %s", ref)
            return []
        for field in product.get("recharge_fields") or []:
            if _field_kind(field) == "server":
                return [{"id": o.get("value"), "name": o.get("label")} for o in field.get("options") or []]
        return []

    # ── Venta ───────────────────────────────────────────────────────────

    async def validate(self, ref: str, user_id: str, server: Optional[str], role_id: Optional[str],
                       zone_id: Optional[str], catalog_entry: Optional[CatalogEntry]) -> ValidateResult:
        """Prepara la orden. No verifica la cuenta (Visoria no puede)."""
        product = await get_product(ref)
        if not is_recharge(product) or not product.get("orderable"):
            logger.warning("[Visoria] producto %s no disponible para recarga (orderable=%s)", ref, product.get("orderable"))
            return ValidateResult(valid=False)
        account = {"user_id": user_id, "server": server, "zone_id": zone_id}
        try:
            custom_value = build_custom_value(product.get("recharge_fields"), account, role_id)
        except MissingField as e:
            logger.warning("[Visoria] producto %s pide un dato que no tenemos: %s", ref, e)
            return ValidateResult(valid=False)
        return ValidateResult(
            valid=True,
            user_name=None,
            name_verified=False,
            server_name=server,
            pending={
                "ref": ref,
                "user_id": user_id,
                "server": server,
                "zone_id": zone_id,
                "custom_value": custom_value,
                "fields": product.get("recharge_fields") or [],
                "price_amount": product.get("price"),
                "price_currency": product.get("currency_code"),
            },
        )

    async def redeem(self, pending: dict, role_id: Optional[str]) -> RedeemResult:
        return (await self.execute(pending, role_id, external_ref=f"vs-{pending['ref']}-{uuid.uuid4().hex[:12]}")).to_redeem()

    async def execute(self, pending: dict, role_id: Optional[str], external_ref: str) -> ExecResult:
        """POST /v1/orders y unas pocas consultas de estado.

        - 4xx (datos inválidos, sin saldo, límite) → REJECTED: no creó la orden.
        - Red, timeout o 5xx → UNCERTAIN, con la idempotency_key para consultarla.
        - COMPLETED → FULFILLED · CANCELLED o devuelta → REJECTED · PROGRESSING → se consulta.
        """
        key = idempotency_key(external_ref or uuid.uuid4().hex)
        custom_value = pending.get("custom_value")
        if role_id:
            try:
                custom_value = build_custom_value(pending.get("fields"), pending, role_id)
            except MissingField as e:
                return ExecResult(REJECTED, error=f"Visoria: falta {e}")
        body = {
            "items": [{
                "product_id": pending["ref"],
                "quantity": 1,
                "face_value": 1,
                "recharge_data": [{"custom_value": custom_value}],
            }],
            "currency_code": pending.get("price_currency") or "USD",
            "idempotency_key": key,
        }
        try:
            order = await _request("POST", "/v1/orders", json=body, timeout=60.0)
        except VisoriaError as e:
            if e.http_status is not None and 400 <= e.http_status < 500:
                return ExecResult(REJECTED, error=str(e))
            logger.error("[Visoria] orden sin respuesta clara: %s", e)
            return ExecResult(UNCERTAIN, order_id=key, error=str(e))
        except (httpx.HTTPError, ValueError) as e:
            logger.error("[Visoria] orden sin respuesta (%s): %s", type(e).__name__, e)
            return ExecResult(UNCERTAIN, order_id=key, error=f"Sin respuesta de Visoria: {type(e).__name__}")

        result = classify_order(order, key)
        for _ in range(_STATUS_POLLS):
            if result.status != PROCESSING:
                return result
            await asyncio.sleep(_STATUS_POLL_DELAY)
            result = await self.check_status(key)
        return result

    async def check_status(self, order_id: str) -> ExecResult:
        """order_id = idempotency_key de la orden."""
        try:
            order = await _request("GET", f"/v1/orders/by-idempotency-key/{order_id}")
        except (VisoriaError, httpx.HTTPError, ValueError) as e:
            logger.warning("[Visoria] no se pudo consultar la orden %s: %s", order_id, e)
            return ExecResult(PROCESSING, order_id=order_id, error=str(e))
        result = classify_order(order, order_id)
        logger.info("[Visoria] estado orden %s: %r → %s", order_id, order.get("status"), result.status)
        return result
````
