# UBICACIÓN EN TU REPO: fastapi-gift-cards/app/providers/visoria_client.py
# (repositorio: fastapi-gift-cards · ruta: app/providers/visoria_client.py)
"""
app/providers/visoria_client.py

Visoria (https://api.visoria.digital) como proveedor de CÓDIGOS (PIN).
Las recargas directas de Visoria van por yape-gaming, no por aquí.

  - Auth: header X-Api-Key. Con una key vsk_test_ todo va al sandbox de
    Visoria (órdenes simuladas con códigos SANDBOX-..., saldo de prueba).
  - GET  /v1/balance                               saldo por moneda
  - GET  /v1/products?search=                      catálogo (fulfillment_type PIN = código)
  - GET  /v1/products/{id}                         detalle
  - POST /v1/orders                                con idempotency_key
  - GET  /v1/orders/by-idempotency-key/{key}       estado y códigos

La orden se identifica por su idempotency_key: se puede consultar aunque se
pierda la respuesta del POST, y reintentar con la misma key nunca crea una
segunda orden. Los códigos (`key`/`pin`) requieren el scope keys:read.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

import httpx

from app.core.config import settings
from app.providers.errors import ProviderRejected

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.visoria.digital"


class VisoriaError(Exception):
    def __init__(self, message: str, http_status: Optional[int] = None, code: Optional[str] = None):
        super().__init__(message)
        self.http_status = http_status
        self.code = code


class VisoriaRejected(ProviderRejected):
    """Visoria respondió 4xx al crear la orden: la orden NO se creó."""


def _base_url() -> str:
    return (getattr(settings, "VISORIA_BASE_URL", "") or DEFAULT_BASE_URL).rstrip("/")


async def _request(method: str, path: str, *, timeout: float = 30.0, **kwargs) -> Any:
    key = getattr(settings, "VISORIA_API_KEY", "") or ""
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


async def get_balance(currency: str = "USD") -> Optional[float]:
    rows = await _request("GET", "/v1/balance")
    for row in rows or []:
        if (row.get("currency_code") or "").upper() == currency.upper():
            return float(row.get("balance") or 0)
    return None


async def search_products(query: str = "", max_pages: int = 3, page_size: int = 100) -> list[dict]:
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        params: dict = {"limit": page_size, "page": page}
        if query:
            params["search"] = query
        data = await _request("GET", "/v1/products", params=params)
        items = data.get("data") or []
        out.extend(items)
        total = (data.get("meta") or {}).get("total") or 0
        if not items or len(out) >= total:
            break
    return out


async def get_product(product_id: str) -> dict:
    return await _request("GET", f"/v1/products/{product_id}")


def is_code_product(product: dict) -> bool:
    return (product.get("fulfillment_type") or "PIN").upper() == "PIN"


async def create_order(product_id: str, quantity: int, currency: str, idempotency_key: str,
                       face_value: Optional[float] = None) -> dict:
    """POST /v1/orders. 4xx → VisoriaRejected (no se creó). 5xx/red → se propaga (dudoso)."""
    body = {
        "items": [{"product_id": product_id, "quantity": quantity, "face_value": face_value or 1}],
        "currency_code": currency or "USD",
        "idempotency_key": idempotency_key,
    }
    try:
        return await _request("POST", "/v1/orders", json=body, timeout=90.0)
    except VisoriaError as e:
        if e.http_status is not None and 400 <= e.http_status < 500:
            raise VisoriaRejected(str(e)) from e
        raise


async def get_order_by_key(idempotency_key: str) -> dict:
    return await _request("GET", f"/v1/orders/by-idempotency-key/{idempotency_key}")


def order_status(order: dict) -> str:
    return (order.get("status") or "").upper()


def extract_codes(order: dict) -> list[str]:
    """Códigos entregados. Si una tarjeta trae código y PIN distintos, van juntos."""
    codes: list[str] = []
    for item in order.get("items") or []:
        for k in item.get("keys") or []:
            if (k.get("status") or "").upper() != "DELIVERED":
                continue
            key = (k.get("key") or "").strip()
            pin = (k.get("pin") or "").strip()
            if key and pin and pin != key:
                codes.append(f"{key} PIN: {pin}")
            elif key or pin:
                codes.append(key or pin)
    return codes


def all_refunded(order: dict) -> bool:
    keys = [k for item in order.get("items") or [] for k in item.get("keys") or []]
    return bool(keys) and all((k.get("status") or "").upper() == "REFUNDED" for k in keys)
