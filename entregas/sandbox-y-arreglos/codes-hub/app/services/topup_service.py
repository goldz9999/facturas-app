"""Recargas directas para clientes: valida, cobra, llama al motor y cierra la recarga.

Orden de la plata (nunca al revés):
  1. dist_start_topup cobra y deja la recarga 'pending' ANTES de llamar al motor.
  2. Según lo que dice el motor:
       fulfilled             → completed
       failed / rechazo claro → failed (se devuelve el saldo)
       uncertain             → uncertain (el saldo queda retenido, alerta)
       processing / sin respuesta → sigue pending; la reconciliación la cierra después.
El motor es idempotente por (consumer, request_id): volver a llamarlo con la
misma recarga nunca recarga dos veces.
"""

import json
import logging
import threading
import time
from datetime import datetime, timezone
from functools import lru_cache
from typing import Any

import redis

from app.core.config import get_settings
from app.core.errors import ApiError
from app.services import alerts
from app.services.sandbox_engine import SandboxTopupEngine
from app.services.topup_engine import EngineError, EngineUnavailable, TopupEngine
from app.services.topups_repo import TopupsRepo

logger = logging.getLogger(__name__)

VALIDATION_TTL = 300
# Una recarga 'pending' que el motor no conoce después de este tiempo nunca llegó a enviarse.
NEVER_SENT_AFTER_SECONDS = 180

ACCOUNT_FIELDS = {1: ["user_id"], 2: ["user_id", "server"], 3: ["user_id", "zone_id"]}

# Errores del motor que garantizan que NO se recargó.
_ENGINE_SAFE_FAILURES = {
    "validation_expired": (410, "La validación venció o ya se usó. Valida la cuenta de nuevo."),
    "role_required": (422, "Esta recarga necesita elegir un personaje."),
    "not_available": (422, "Esta recarga no está disponible en este momento."),
    "no_validator": (422, "Esta recarga no está disponible en este momento."),
    "request_id_conflict": (409, "Ese request_id ya se usó con otra recarga."),
}

# Lo que ve el cliente en "status".
PUBLIC_STATUS = {
    "pending": "processing",
    "uncertain": "under_review",
    "completed": "completed",
    "failed": "failed",
    "refunded": "refunded",
}


def consumer_for(client: dict) -> str:
    return f"dist:{client['code']}"


class _NoAlerts:
    """Los clientes de prueba no mandan avisos a Telegram."""

    def __getattr__(self, name):
        return lambda *args, **kwargs: None


def alerts_for(client: dict):
    return _NoAlerts() if client.get("sandbox") else alerts.get_alerts()


class ValidationStore:
    """validation_id → a qué cliente, SKU y cuenta pertenece. Redis, o memoria si no hay."""

    def __init__(self, redis_url: str):
        self.redis = redis.Redis.from_url(redis_url, socket_timeout=1, socket_connect_timeout=1) if redis_url else None
        self.mem: dict[str, tuple[float, str]] = {}
        self.lock = threading.Lock()

    def put(self, validation_id: str, data: dict) -> None:
        raw = json.dumps(data)
        if self.redis is not None:
            try:
                self.redis.setex(f"dist:topup:val:{validation_id}", VALIDATION_TTL, raw)
                return
            except redis.RedisError:
                logger.exception("Redis no disponible para guardar la validación")
        with self.lock:
            self.mem[validation_id] = (time.monotonic() + VALIDATION_TTL, raw)

    def take(self, validation_id: str) -> dict | None:
        """Lee y borra: una validación sirve para una sola recarga."""
        if self.redis is not None:
            try:
                raw = self.redis.getdel(f"dist:topup:val:{validation_id}")
                if raw:
                    return json.loads(raw)
            except redis.RedisError:
                logger.exception("Redis no disponible para leer la validación")
        with self.lock:
            item = self.mem.pop(validation_id, None)
            if item and item[0] > time.monotonic():
                return json.loads(item[1])
        return None

    def get(self, validation_id: str) -> dict | None:
        if self.redis is not None:
            try:
                raw = self.redis.get(f"dist:topup:val:{validation_id}")
                if raw:
                    return json.loads(raw)
            except redis.RedisError:
                logger.exception("Redis no disponible para leer la validación")
        with self.lock:
            item = self.mem.get(validation_id)
            if item and item[0] > time.monotonic():
                return json.loads(item[1])
        return None


@lru_cache
def get_validation_store() -> ValidationStore:
    return ValidationStore(get_settings().redis_url)


def to_topup_out(row: dict) -> dict[str, Any]:
    return {
        "topup_id": row.get("order_number"),
        "request_id": row["request_id"],
        "status": PUBLIC_STATUS.get(row["status"], row["status"]),
        "product_sku": row["product_sku"],
        "product_name": row["product_name"],
        "account": row.get("account") or {},
        "user_name": row.get("user_name"),
        "price": float(row["price"]),
        "currency": row["currency"],
        "error": row.get("error") if row["status"] == "failed" else None,
        "created_at": row["created_at"],
        "completed_at": row.get("completed_at"),
        "balance_after": float(row["balance_after"]) if row.get("balance_after") is not None else None,
    }


class TopupService:
    def __init__(self, repo: TopupsRepo, engine: TopupEngine, validations: ValidationStore):
        self.repo = repo
        self.engine = engine
        self.validations = validations

    def engine_for(self, client: dict) -> TopupEngine:
        """Clientes de prueba → motor simulado: nunca llega a un proveedor."""
        if client.get("sandbox"):
            return SandboxTopupEngine(self.repo, client["id"])
        return self.engine

    # ── Catálogo ────────────────────────────────────────────────────────────

    def catalog(self, client: dict) -> list[dict[str, Any]]:
        return [
            {
                "sku": i["sku"], "name": i["name"], "game": i["game"],
                "price": float(i["price"]), "currency": i["currency"], "available": bool(i["available"]),
                "account_fields": ACCOUNT_FIELDS.get(i["subtype"], ["user_id"]),
            }
            for i in self.repo.catalog(client["id"])
        ]

    def _item(self, client: dict, sku: str) -> dict:
        item = next((i for i in self.repo.catalog(client["id"]) if i["sku"] == sku), None)
        if not item:
            raise ApiError(404, "product_not_found", "Recarga no habilitada para este cliente")
        if not item["available"]:
            raise ApiError(422, "not_available", "Esta recarga no está disponible en este momento")
        return item

    @staticmethod
    def _engine_error(e: EngineError) -> ApiError:
        if e.code == "topups_not_configured":
            return ApiError(503, "topups_unavailable", "Las recargas no están disponibles en este momento")
        if e.code in _ENGINE_SAFE_FAILURES:
            status, text = _ENGINE_SAFE_FAILURES[e.code]
            return ApiError(status, e.code, text)
        logger.error("Motor de recargas respondió %s %s: %s", e.status_code, e.code, e.message)
        return ApiError(502, "provider_error", "No se pudo completar la consulta con el proveedor")

    # ── Servidores / validación ─────────────────────────────────────────────

    def servers(self, client: dict, sku: str) -> list[dict]:
        item = self._item(client, sku)
        if item["subtype"] != 2:
            return []
        try:
            return self.engine_for(client).servers(item["product_id"], item["variant_key"])
        except EngineError as e:
            raise self._engine_error(e)
        except EngineUnavailable:
            raise ApiError(503, "provider_unavailable", "El proveedor no responde. Intenta en unos segundos.")

    def validate(self, client: dict, sku: str, account: dict) -> dict[str, Any]:
        item = self._item(client, sku)
        needed = ACCOUNT_FIELDS.get(item["subtype"], ["user_id"])
        missing = [f for f in needed if not account.get(f)]
        if missing:
            raise ApiError(422, "missing_account_fields", f"Faltan datos de la cuenta: {', '.join(missing)}",
                           {"required": needed, "missing": missing})
        account = {f: str(account[f]).strip() for f in needed}

        try:
            res = self.engine_for(client).validate(consumer_for(client), item["product_id"], item["variant_key"], account)
        except EngineError as e:
            raise self._engine_error(e)
        except EngineUnavailable:
            raise ApiError(503, "provider_unavailable", "El proveedor no responde. Intenta en unos segundos.")

        if not res.get("valid"):
            return {"valid": False, "product_sku": sku, "account": account}

        self.validations.put(res["validation_id"], {
            "client_id": client["id"], "sku": sku, "account": account, "user_name": res.get("user_name"),
        })
        return {
            "valid": True,
            "validation_id": res["validation_id"],
            "product_sku": sku,
            "account": account,
            "user_name": res.get("user_name"),
            "server_name": res.get("server_name"),
            "expires_in": res.get("expires_in", VALIDATION_TTL),
        }

    # ── Recargar ────────────────────────────────────────────────────────────

    def create(self, client: dict, request_id: str, sku: str, validation_id: str) -> dict[str, Any]:
        existing = self.repo.get_by_request_id(client["id"], request_id)
        if existing:
            if existing["product_sku"] != sku or existing["validation_id"] != validation_id:
                raise ApiError(409, "request_id_conflict", "Ese request_id ya se usó con otra recarga")
            row = self.refresh(client, existing) if existing["status"] == "pending" else existing
            return {**row, "replayed": True}

        validation = self.validations.take(validation_id)
        if not validation or validation["client_id"] != client["id"] or validation["sku"] != sku:
            if validation:  # era de otro SKU o cliente: no se gasta
                self.validations.put(validation_id, validation)
            raise ApiError(410, "validation_expired", "La validación venció, ya se usó o no corresponde a esta recarga. Valida la cuenta de nuevo.")

        try:
            row = self.repo.start(client["id"], request_id, sku, validation_id, validation["account"], validation.get("user_name"))
        except ApiError:
            # No se cobró (sin saldo, cuenta suspendida...): la validación sigue sirviendo.
            self.validations.put(validation_id, validation)
            raise
        if row.get("replayed"):  # otra petición igual ganó la carrera
            return row
        balance_after = row["balance_after"]
        row = self._execute(client, row)
        row["balance_after"] = row.get("balance_after", balance_after)
        if row["status"] in ("completed", "pending", "uncertain"):
            alerts_for(client).check_low_balance(client, {**row, "total": row["price"]})
        return {**row, "replayed": False}

    def _execute(self, client: dict, row: dict) -> dict:
        try:
            res = self.engine_for(client).execute(consumer_for(client), row["request_id"], row["validation_id"])
        except EngineUnavailable:
            # No se sabe si llegó: queda pending y la reconciliación pregunta después.
            return row
        except EngineError as e:
            # El motor la rechazó sin recargar: se devuelve el saldo.
            api = self._engine_error(e)
            return self._finish(client, row, "failed", error=api.message)
        return self.apply(client, row, res)

    def apply(self, client: dict, row: dict, res: dict) -> dict:
        """Aplica a la recarga el estado que informa el motor."""
        status = res.get("status")
        info = dict(provider=res.get("provider"), provider_order_id=res.get("provider_order_id"),
                    cost_price=res.get("cost_price"), cost_currency=res.get("cost_currency"))
        if status == "fulfilled":
            return self._finish(client, row, "completed", **info)
        if status == "failed":
            return self._finish(client, row, "failed", error="El proveedor no pudo hacer la recarga.", **info)
        if status == "uncertain":
            return self._finish(client, row, "uncertain", error=res.get("error"), **info)
        return row  # processing / in_progress: sigue pending

    def _finish(self, client: dict, row: dict, status: str, created_by: str = "engine", **kw) -> dict:
        out = self.repo.finish(row["id"], status, created_by=created_by, **kw)
        if out.get("changed") and status == "uncertain":
            alerts_for(client).topup_uncertain(client, out)
        elif out.get("changed") and status == "completed" and created_by == "engine":
            alerts_for(client).topup_completed(client, out)
        return out

    # ── Consultar / reconciliar ─────────────────────────────────────────────

    def refresh(self, client: dict, row: dict) -> dict:
        """Pregunta al motor por una recarga pending."""
        if row["status"] != "pending":
            return row
        try:
            res = self.engine_for(client).get(consumer_for(client), row["request_id"])
        except EngineUnavailable:
            return row
        except EngineError as e:
            if e.code == "not_found" and _age_seconds(row) > NEVER_SENT_AFTER_SECONDS:
                return self._finish(client, row, "failed", error="La recarga no llegó a enviarse al proveedor.")
            return row
        return self.apply(client, row, res)

    def reconcile_once(self, clients_by_id) -> int:
        changed = 0
        for row in self.repo.list_pending(older_than_seconds=60):
            client = clients_by_id(row["client_id"])
            if not client:
                continue
            new = self.refresh(client, row)
            changed += int(new.get("status") != "pending")
        return changed


def _age_seconds(row: dict) -> float:
    created = row.get("created_at")
    if isinstance(created, str):
        created = datetime.fromisoformat(created.replace("Z", "+00:00"))
    if not created:
        return 0
    return (datetime.now(timezone.utc) - created).total_seconds()
