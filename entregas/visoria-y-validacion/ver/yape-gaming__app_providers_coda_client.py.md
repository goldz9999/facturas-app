# coda_client.py

**Repositorio:** `yape-gaming`  
**Ruta:** `app/providers/coda_client.py`

Copia TODO el bloque de abajo y reemplaza el archivo completo.

````python
"""
app/providers/coda_client.py

Cliente de Coda xShop, extraído de app/main.py (donde vivía como funciones
sueltas) para implementar la interfaz común DirectTopupProvider. Misma
lógica de siempre (JWT propio por request, catálogo cacheado en Redis,
validate→topup en dos pasos) — solo reorganizada en una clase.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import random
import time
import uuid
from typing import Any, Optional

import httpx
import redis.asyncio as redis

from app.providers.base import (
    FULFILLED, REJECTED, UNCERTAIN, CatalogEntry, ExecResult, RedeemResult, ValidateResult,
)

logger = logging.getLogger("yape-gaming.coda")


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


class CodaProvider:
    code = "coda"
    can_validate = True  # validate devuelve el username de la cuenta y NO cobra (solo cobra el topup)

    def __init__(
        self,
        base_url: str,
        api_key: str,
        client_id: str,
        secret: str,
        redis_client: "redis.Redis",
        catalog_ttl_seconds: int = 300,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.client_id = client_id
        self.secret = secret
        self.redis = redis_client
        self.catalog_ttl_seconds = catalog_ttl_seconds
        self.catalog_key = "yape_gaming:catalog:coda"

    # ── JWT / llamadas crudas ──────────────────────────────────────────

    def _build_jwt(self, body: dict) -> tuple[str, bytes]:
        header = {
            "alg": "HS256",
            "typ": "JWT",
            "x-api-key": self.api_key,
            "x-api-version": "2.0",
            "x-client-id": self.client_id,
        }
        header_b64 = _b64url(json.dumps(header, separators=(",", ":")).encode())
        payload_bytes = json.dumps(body, separators=(",", ":")).encode()
        payload_b64 = _b64url(payload_bytes)
        unsigned = f"{header_b64}.{payload_b64}".encode()
        sig = hmac.new(self.secret.encode(), unsigned, hashlib.sha256).digest()
        return f"{header_b64}.{payload_b64}.{_b64url(sig)}", payload_bytes

    async def _call(self, product_path: Optional[str], method: Optional[str], params: dict) -> dict:
        if method is None:
            # GET /products — Coda exige JWT en la práctica aunque su doc
            # pública diga que no. Ver nota histórica en el repo original.
            iat = int(time.time()) + 257
            token, _ = self._build_jwt({"iat": iat})
            url = f"{self.base_url}/products"
            async with httpx.AsyncClient(timeout=20) as client:
                resp = await client.get(
                    url,
                    headers={
                        "x-api-key": self.api_key,
                        "x-api-version": "2.0",
                        "Authorization": f"Bearer {token}",
                    },
                )
            resp.raise_for_status()
            data = resp.json()
            if "error" in data:
                raise RuntimeError(f"Coda /products error: {data['error']}")
            return data

        body = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": method,
            "params": {**params, "iat": int(time.time()) + 257 + random.randint(0, 40)},
        }
        token, payload_bytes = self._build_jwt(body)
        url = f"{self.base_url}{product_path}"

        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.post(
                url,
                content=payload_bytes,
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": self.api_key,
                    "x-api-version": "2.0",
                    "Authorization": f"Bearer {token}",
                },
            )
        resp.raise_for_status()
        data = resp.json()
        if "error" in data:
            logger.warning("Coda business error en %s: %s", method, data["error"])
        return data

    # ── Catálogo / admin ────────────────────────────────────────────────

    async def list_admin_products(self) -> list[dict]:
        products_resp = await self._call(None, None, {})
        product_list = products_resp.get("result", {}).get("productList", [])
        eligible = [p for p in product_list if p.get("type") == "topup"]
        return [
            {
                "name": p["name"],
                "apiPath": p["apiPath"],
                "subtype": int(p.get("subtype", 2)),
                "haveRole": p.get("haveRole", False),
            }
            for p in eligible
        ]

    async def list_admin_skus(self, ref: str) -> list[dict]:
        """`ref` acá es el apiPath del producto (ej. "/moonton/mobilelegends")."""
        resp = await self._call(f"/{ref.lstrip('/')}", "listSku", {})
        if "error" in resp:
            raise RuntimeError(f"Coda listSku error: {resp['error']}")
        sku_list = resp.get("result", {}).get("skuList", [])

        seen: set[str] = set()
        deduped = []
        for s in sku_list:
            if s["sku"] in seen:
                continue
            seen.add(s["sku"])
            deduped.append(s)

        return [
            {
                "sku": s["sku"],
                "title": s.get("description", s["sku"]),
                "priceAmount": s.get("price", {}).get("amount"),
                "priceCurrency": s.get("price", {}).get("currency"),
                "stock": True,
            }
            for s in deduped
        ]

    async def current_price(self, supplier: dict, cache: dict) -> Optional[tuple]:
        """Precio vigente (monto, moneda) del SKU de esta variante. Coda dice la
        moneda en cada SKU; `cache` evita pedir el mismo juego dos veces."""
        key = ("coda", supplier["coda_api_path"])
        if key not in cache:
            cache[key] = {s["sku"]: s for s in await self.list_admin_skus(supplier["coda_api_path"])}
        sku = cache[key].get(supplier["coda_sku"])
        if not sku or sku.get("priceAmount") is None:
            return None
        return sku["priceAmount"], sku.get("priceCurrency")

    async def _refresh_catalog_if_needed(self) -> None:
        if await self.redis.exists(self.catalog_key):
            return

        products_resp = await self._call(None, None, {})
        product_list = products_resp.get("result", {}).get("productList", [])
        eligible = [p for p in product_list if p.get("type") == "topup"]

        async def fetch_skus(product: dict) -> tuple[dict, list]:
            api_path = product["apiPath"]
            try:
                sku_resp = await self._call(api_path, "listSku", {})
            except Exception:
                logger.exception("Error listando SKUs de %s", api_path)
                return product, []
            return product, sku_resp.get("result", {}).get("skuList", [])

        results = await asyncio.gather(*(fetch_skus(p) for p in eligible))

        new_entries: dict[str, str] = {}
        failures = []
        for product, sku_list in results:
            if not sku_list:
                failures.append(product["apiPath"])
                continue
            for sku_row in sku_list:
                sku = sku_row["sku"]
                price = sku_row.get("price", {})
                new_entries[sku] = json.dumps({
                    "sku": sku,
                    "title": f"{product['name']} - {sku_row.get('description', sku)}",
                    "apiPath": product["apiPath"],
                    "subtype": product.get("subtype", 2),
                    "haveRole": product.get("haveRole", False),
                    "priceAmount": price.get("amount"),
                    "priceCurrency": price.get("currency"),
                })

        if new_entries:
            async with self.redis.pipeline() as pipe:
                pipe.delete(self.catalog_key)
                pipe.hset(self.catalog_key, mapping=new_entries)
                pipe.expire(self.catalog_key, self.catalog_ttl_seconds)
                await pipe.execute()
        else:
            logger.error(
                "Coda: catalogo vacio tras revisar %d productos elegibles. Fallos: %s",
                len(eligible), failures,
            )

    async def get_catalog(self) -> dict[str, CatalogEntry]:
        await self._refresh_catalog_if_needed()
        raw = await self.redis.hgetall(self.catalog_key)
        catalog: dict[str, CatalogEntry] = {}
        for sku, meta_json in raw.items():
            meta = json.loads(meta_json)
            catalog[sku] = CatalogEntry(
                ref=sku,
                title=meta["title"],
                subtype=meta["subtype"],
                have_role=meta["haveRole"],
                stock=meta["stock"],
                price_amount=meta.get("priceAmount"),
                price_currency=meta.get("priceCurrency"),
                extra={"apiPath": meta["apiPath"]},
            )
        return catalog

    async def get_catalog_entry(self, ref: str) -> Optional[CatalogEntry]:
        raw = await self.redis.hget(self.catalog_key, ref)
        if not raw:
            return None
        meta = json.loads(raw)
        return CatalogEntry(
            ref=ref,
            title=meta["title"],
            subtype=meta["subtype"],
            have_role=meta["haveRole"],
            stock=meta["stock"],
            price_amount=meta.get("priceAmount"),
            price_currency=meta.get("priceCurrency"),
            extra={"apiPath": meta["apiPath"]},
        )

    # ── Flujo de venta ──────────────────────────────────────────────────

    def _build_user_account(self, entry: CatalogEntry, user_id: str, server: Any, role_id: Optional[str]) -> Any:
        subtype = entry.subtype
        have_role = entry.have_role
        if subtype == 1:
            if not have_role:
                return user_id
            account = {"userId": user_id}
            if role_id:
                account["roleId"] = role_id
            return account
        if subtype == 2:
            if isinstance(server, dict):
                server_obj = {"id": server.get("id"), "name": server.get("name") or server.get("id")}
            else:
                server_obj = {"id": server, "name": server}
            account: dict = {"userId": user_id, "server": server_obj}
            if role_id:
                account["roleId"] = role_id
            return account
        if subtype == 3:
            account = {"userId": user_id, "zoneId": server}
            if role_id:
                account["roleId"] = role_id
            return account
        raise ValueError(f"subtype {subtype} no soportado")

    async def list_servers(self, ref: str) -> list[dict]:
        entry = await self.get_catalog_entry(ref)
        if not entry:
            return []
        if entry.subtype != 2:
            return []
        resp = await self._call(entry.extra["apiPath"], "listServer", {})
        if "error" in resp:
            raise RuntimeError(resp["error"].get("message", "Error listando servidores"))
        servers = resp.get("servers", []) or resp.get("result", {}).get("servers", [])
        return [{"id": s.get("id"), "name": s.get("name")} for s in servers]

    async def validate(
        self,
        ref: str,
        user_id: str,
        server: Optional[str],
        role_id: Optional[str],
        zone_id: Optional[str],
        catalog_entry: Optional[CatalogEntry],
    ) -> ValidateResult:
        entry = catalog_entry or await self.get_catalog_entry(ref)
        if not entry:
            logger.warning("[Coda] validate %s: el SKU no está en el catálogo de Coda (sin stock o desactivado)", ref)
            return ValidateResult(valid=False)
        # Las rutas /gaming/* mandan la zona de los subtype 3 en `server`;
        # el motor (app/topups) la manda en `zone_id`. Se aceptan las dos.
        if entry.subtype == 3 and not server and zone_id:
            server = zone_id

        # Para subtype 2 hay que resolver el name real del server ANTES de
        # armar la cuenta: Coda solo hace eco de lo que le mandamos, no
        # resuelve nombres por su cuenta.
        server_value: Any = server
        if entry.subtype == 2 and server:
            try:
                servers_resp = await self._call(entry.extra["apiPath"], "listServer", {})
                servers = servers_resp.get("servers", []) or servers_resp.get("result", {}).get("servers", [])
                for s in servers:
                    if str(s.get("id")) == str(server):
                        server_value = {"id": s.get("id"), "name": s.get("name")}
                        break
            except Exception:
                logger.exception("No se pudo resolver el nombre del servidor via listServer")

        user_account = self._build_user_account(entry, user_id, server_value, role_id)

        try:
            resp = await self._call(entry.extra["apiPath"], "validate", {
                "customerId": user_id,
                "items": [{
                    "sku": ref,
                    "quantity": 1,
                    "price": {"currency": entry.price_currency, "amount": entry.price_amount},
                }],
                "userAccount": user_account,
            })
        except httpx.HTTPStatusError:
            logger.exception("Error de red validando en Coda")
            return ValidateResult(valid=False)

        if "error" in resp:
            err = resp["error"]
            logger.warning("[Coda] validate %s (subtype=%s) rechazado: %s", ref, entry.subtype,
                           err if not isinstance(err, dict) else {k: err.get(k) for k in ("code", "message", "data")})
            return ValidateResult(valid=False)

        result = resp.get("result", {})
        order_id = result.get("orderId")
        message = result.get("message", {})
        username = message.get("username")
        if not order_id:
            logger.warning("[Coda] validate %s: respuesta sin orderId: %s", ref, str(resp)[:300])
            return ValidateResult(valid=False)

        pending = {
            "order_id": order_id,
            "api_path": entry.extra["apiPath"],
            "user_account": user_account,
            "ref": ref,
            "price_amount": entry.price_amount,
            "price_currency": entry.price_currency,
            "have_role": entry.have_role,
        }

        server_name = None
        if isinstance(server_value, dict) and server_value.get("name"):
            server_name = server_value["name"]
        elif server:
            server_name = server

        return ValidateResult(
            valid=True,
            user_name=username or user_id,
            name_verified=bool(username and str(username).strip()),
            server_name=server_name,
            roles=message.get("roles", []) if entry.have_role else None,
            pending=pending,
        )

    async def redeem(self, pending: dict, role_id: Optional[str]) -> RedeemResult:
        """Rutas /gaming/* (Yape): misma recarga que execute(), en el formato de siempre."""
        return (await self.execute(pending, role_id, external_ref="")).to_redeem()

    async def execute(self, pending: dict, role_id: Optional[str], external_ref: str) -> ExecResult:
        """
        topup de Coda clasificado. Según su documentación, Coda solo cobra
        cuando el topup se completa (status FULFILLED) y los errores de
        negocio vienen como objeto `error` dentro de un HTTP 200.

        Antes, cualquier status distinto de FULFILLED hacía que esta función
        no devolviera nada y la ruta /gaming/recharge/ fallara con 500 sin
        dejar registro; ahora queda como UNCERTAIN (no se sabe si se hizo).
        """
        user_account = pending["user_account"]
        if pending.get("have_role"):
            if not role_id:
                return ExecResult(REJECTED, error="Este producto requiere roleId.")
            user_account = {**user_account, "roleId": role_id} if isinstance(user_account, dict) else user_account

        try:
            resp = await self._call(pending["api_path"], "topup", {
                "orderId": pending["order_id"],
                "customerId": pending["user_account"].get("userId") if isinstance(pending["user_account"], dict) else pending["user_account"],
                "items": [{
                    "sku": pending["ref"],
                    "quantity": 1,
                    "price": {"currency": pending["price_currency"], "amount": pending["price_amount"]},
                }],
                "userAccount": user_account,
            })
        except httpx.HTTPStatusError as e:
            code = e.response.status_code if e.response is not None else 0
            logger.exception("Coda topup respondió HTTP %s", code)
            if 400 <= code < 500:
                # Petición rechazada antes de procesarse: no se cobró.
                return ExecResult(REJECTED, order_id=pending.get("order_id"), error=f"Coda rechazó la petición (HTTP {code})")
            return ExecResult(UNCERTAIN, order_id=pending.get("order_id"), error=f"Coda respondió HTTP {code}")
        except (httpx.HTTPError, ValueError) as e:
            # Timeout, red cortada o respuesta ilegible: el topup pudo haberse hecho.
            logger.exception("Error de red haciendo topup en Coda")
            return ExecResult(UNCERTAIN, order_id=pending.get("order_id"), error=f"Sin respuesta clara de Coda ({type(e).__name__})")

        if "error" in resp:
            err = resp["error"]
            msg = err.get("message", "Recharge fallo") if isinstance(err, dict) else str(err)
            return ExecResult(REJECTED, order_id=pending.get("order_id"), error=msg)

        result = resp.get("result", {}) or {}
        status = result.get("status")
        if status == "FULFILLED":
            return ExecResult(FULFILLED, order_id=result.get("orderId") or pending.get("order_id"))
        return ExecResult(
            UNCERTAIN, order_id=result.get("orderId") or pending.get("order_id"),
            error=f"Coda respondió status={status!r} (no es FULFILLED)",
        )

    async def check_status(self, order_id: str) -> ExecResult:
        # La documentación de xShop no publica un método para consultar una
        # orden: no podemos confirmarla solos. Queda para revisar en el
        # Distributor Portal.
        return ExecResult(UNCERTAIN, order_id=order_id, error="Coda no permite consultar el estado; revisar en el portal de Coda")
````
