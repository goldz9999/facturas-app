from typing import Any, Protocol

from supabase import Client

from app.core.supabase import get_supabase

TABLE = "dist_clients"

# Nunca se selecciona api_secret_hash hacia afuera.
PUBLIC_COLUMNS = (
    "id,code,name,status,api_client_id,balance,balance_currency,ip_whitelist,"
    "rate_limit_rpm,low_balance_threshold,webhook_url,contact_email,metadata,credentials_rotated_at,"
    "sandbox,created_at,updated_at"
)

# Solo para autenticar /v1: incluye el hash, nunca se devuelve en una respuesta.
AUTH_COLUMNS = (
    "id,code,name,status,api_client_id,api_secret_hash,ip_whitelist,rate_limit_rpm,"
    "low_balance_threshold,balance_currency,sandbox"
)


class ClientsRepo(Protocol):
    def list(self, status: str | None = None) -> list[dict[str, Any]]: ...
    def get(self, client_id: int) -> dict[str, Any] | None: ...
    def get_by_code(self, code: str) -> dict[str, Any] | None: ...
    def create(self, data: dict[str, Any]) -> dict[str, Any]: ...
    def update(self, client_id: int, data: dict[str, Any]) -> dict[str, Any] | None: ...
    def get_for_auth(self, api_client_id: str) -> dict[str, Any] | None: ...


class SupabaseClientsRepo:
    def __init__(self, db: Client):
        self.db = db

    def list(self, status: str | None = None) -> list[dict[str, Any]]:
        query = self.db.table(TABLE).select(PUBLIC_COLUMNS).order("id")
        if status:
            query = query.eq("status", status)
        return query.execute().data or []

    def get(self, client_id: int) -> dict[str, Any] | None:
        rows = self.db.table(TABLE).select(PUBLIC_COLUMNS).eq("id", client_id).limit(1).execute().data
        return rows[0] if rows else None

    def get_by_code(self, code: str) -> dict[str, Any] | None:
        rows = self.db.table(TABLE).select(PUBLIC_COLUMNS).eq("code", code).limit(1).execute().data
        return rows[0] if rows else None

    def create(self, data: dict[str, Any]) -> dict[str, Any]:
        rows = self.db.table(TABLE).insert(data).execute().data
        return self.get(rows[0]["id"])

    def update(self, client_id: int, data: dict[str, Any]) -> dict[str, Any] | None:
        rows = self.db.table(TABLE).update(data).eq("id", client_id).execute().data
        return self.get(client_id) if rows else None

    def get_for_auth(self, api_client_id: str) -> dict[str, Any] | None:
        rows = (
            self.db.table(TABLE)
            .select(AUTH_COLUMNS)
            .eq("api_client_id", api_client_id)
            .limit(1)
            .execute()
            .data
        )
        return rows[0] if rows else None


def get_clients_repo() -> ClientsRepo:
    return SupabaseClientsRepo(get_supabase())
