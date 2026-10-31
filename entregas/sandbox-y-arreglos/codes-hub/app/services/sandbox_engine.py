"""Motor de recargas simulado para clientes de prueba (dist_clients.sandbox).

Cumple el mismo contrato que HttpTopupEngine, pero no llama a yape-gaming ni a
ningún proveedor. El resultado lo decide el final del user_id, para que el
cliente pueda probar cada respuesta de la API:

  ...0002  failed        (el saldo se devuelve)
  ...0003  processing    → completed al consultar después de SANDBOX_DELAY_SECONDS
  ...0004  under_review  (queda retenida hasta cerrarla en el panel)
  ...0005  processing    → failed al consultar después de SANDBOX_DELAY_SECONDS
  ...0006  sin respuesta del proveedor → processing → completed como 0003
  ...0008  validar responde 503 provider_unavailable
  ...0009  validar responde valid=false (la cuenta no existe)
  otro     completed

No guarda estado propio: lee la recarga ya guardada (cuenta y fecha), así
funciona igual con varios workers y con la reconciliación.
"""

import uuid
from typing import Any

from app.services.topup_engine import EngineError, EngineUnavailable

SANDBOX_DELAY_SECONDS = 30

SANDBOX_SERVERS = [{"id": "1", "name": "Servidor de prueba 1"}, {"id": "2", "name": "Servidor de prueba 2"}]


def scenario(user_id: str | None) -> str:
    return str(user_id or "").strip()[-4:]


class SandboxTopupEngine:
    def __init__(self, repo, client_id: int):
        self.repo = repo
        self.client_id = client_id

    def servers(self, product_id, variant_key):
        return SANDBOX_SERVERS

    def validate(self, consumer, product_id, variant_key, account):
        case = scenario(account.get("user_id"))
        if case == "0008":
            raise EngineUnavailable("sandbox: proveedor sin respuesta")
        if case == "0009":
            return {"valid": False}
        server = account.get("server")
        return {
            "valid": True,
            "validation_id": f"sbx-{uuid.uuid4().hex}",
            "user_name": f"Jugador de prueba {case}",
            "server_name": next((s["name"] for s in SANDBOX_SERVERS if s["id"] == str(server)), None) if server else None,
            "expires_in": 300,
        }

    def _row(self, request_id: str) -> dict:
        row = self.repo.get_by_request_id(self.client_id, request_id)
        if not row:
            raise EngineError(404, "not_found", "Recarga no encontrada")
        return row

    @staticmethod
    def _result(status: str, row: dict) -> dict[str, Any]:
        return {
            "status": status,
            "provider": "sandbox",
            "provider_order_id": f"SBX-{row['request_id']}",
            "cost_price": 0,
            "cost_currency": row.get("currency"),
            "error": "Recarga de prueba sin confirmar" if status == "uncertain" else None,
        }

    def execute(self, consumer, request_id, validation_id):
        row = self._row(request_id)
        case = scenario((row.get("account") or {}).get("user_id"))
        if case == "0006":
            raise EngineUnavailable("sandbox: sin respuesta al recargar")
        status = {"0002": "failed", "0003": "processing", "0004": "uncertain", "0005": "processing"}.get(case, "fulfilled")
        return self._result(status, row)

    def get(self, consumer, request_id):
        from app.services.topup_service import _age_seconds

        row = self._row(request_id)
        case = scenario((row.get("account") or {}).get("user_id"))
        if case in ("0003", "0005", "0006") and _age_seconds(row) < SANDBOX_DELAY_SECONDS:
            return self._result("processing", row)
        status = {"0002": "failed", "0004": "uncertain", "0005": "failed"}.get(case, "fulfilled")
        return self._result(status, row)
