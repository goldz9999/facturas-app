# UBICACIÓN EN TU REPO: yape-gaming/app/topups/store.py
# (repositorio: yape-gaming · ruta: app/topups/store.py)
"""
app/topups/store.py

Acceso a Supabase del motor de recargas: la cadena de proveedores de una
denominación (direct_topup_suppliers) y las ejecuciones
(direct_topup_executions, ver supabase_migrations/20261028_topup_engine.sql).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

logger = logging.getLogger(__name__)

SUPPLIER_FIELDS = (
    "id, product_id, provider, coda_sku, coda_api_path, subtype, have_role, "
    "title, variant_label, variant_key, priority, cost_price, cost_currency, is_active"
)


def effective_variant_key(supplier: dict) -> str:
    """Denominación de una fila: variant_key si se puso, si no 'v<id>' (fila sola)."""
    return supplier.get("variant_key") or f"v{supplier['id']}"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class TopupStore:
    def __init__(self, supabase):
        self.db = supabase

    # ── Cadena de proveedores ───────────────────────────────────────────

    def chain(self, product_id: int, variant_key: str) -> list[dict]:
        """Filas activas de esa denominación, en orden de prioridad (1 = primero)."""
        # "*" y no SUPPLIER_FIELDS: así funciona antes y después de la
        # migración que agrega `validates` (sin la columna, se toma true).
        rows = self.db.table("direct_topup_suppliers") \
            .select("*") \
            .eq("product_id", product_id) \
            .eq("is_active", True) \
            .execute().data or []
        rows = [r for r in rows if effective_variant_key(r) == variant_key]
        return sorted(rows, key=lambda r: (r.get("priority") or 1, r["id"]))

    # ── Ejecuciones ─────────────────────────────────────────────────────

    def get_execution(self, consumer: str, request_id: str) -> Optional[dict]:
        rows = self.db.table("direct_topup_executions").select("*") \
            .eq("consumer", consumer).eq("request_id", request_id) \
            .limit(1).execute().data or []
        return rows[0] if rows else None

    def insert_execution(self, row: dict) -> Optional[dict]:
        """Crea la ejecución. None si ya existe una con ese (consumer, request_id)."""
        try:
            res = self.db.table("direct_topup_executions").insert(row).execute()
        except Exception as e:
            # 23505 = unique_violation: otra petición con el mismo request_id ganó.
            if "23505" in str(e) or "duplicate key" in str(e):
                return None
            raise
        return (res.data or [None])[0]

    def update_execution(self, execution_id: str, fields: dict) -> dict:
        res = self.db.table("direct_topup_executions") \
            .update({**fields, "updated_at": _now()}) \
            .eq("id", execution_id).execute()
        return (res.data or [{}])[0]

    def list_to_reconcile(self, processing_older_than_s: int, in_progress_older_than_s: int) -> list[dict]:
        now = datetime.now(timezone.utc)
        processing = self.db.table("direct_topup_executions").select("*") \
            .eq("status", "processing") \
            .lt("updated_at", (now - timedelta(seconds=processing_older_than_s)).isoformat()) \
            .limit(50).execute().data or []
        stuck = self.db.table("direct_topup_executions").select("*") \
            .eq("status", "in_progress") \
            .lt("updated_at", (now - timedelta(seconds=in_progress_older_than_s)).isoformat()) \
            .limit(50).execute().data or []
        return processing + stuck
