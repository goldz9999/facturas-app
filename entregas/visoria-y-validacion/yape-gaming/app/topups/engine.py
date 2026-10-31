# UBICACIÓN EN TU REPO: yape-gaming/app/topups/engine.py
# (repositorio: yape-gaming · ruta: app/topups/engine.py)
"""
app/topups/engine.py

Motor de recargas directas para consumidores internos (codes-hub).

Una "denominación" (product_id + variant_key) puede tener varias filas en
direct_topup_suppliers, una por proveedor. Eso es la cadena.

Flujo:
  1. validate(): se pregunta a los proveedores que saben validar
     (can_validate y la variante con `validates` activo), en orden de
     `priority`, hasta que uno devuelve el NOMBRE real del jugador. Si
     ninguno lo da pero alguno dice que la cuenta existe, se acepta sin
     nombre. Queda guardada en Redis 5 min con un validation_id.
  2. execute(): con ese validation_id y un request_id del consumidor.
     La recarga va del proveedor MÁS BARATO al más caro (cost_price,
     convertido a USD con el tipo de cambio en vivo, ver app/topups/fx.py);
     a igual costo decide `priority`. Los costos se refrescan solos desde
     cada proveedor (refresh_costs_once, cada 30 min).
     - El request_id es único por consumidor (fila en
       direct_topup_executions creada ANTES de llamar a ningún
       proveedor): repetir la petición devuelve la misma ejecución, nunca
       una segunda recarga.
     - Se recorre la cadena. Solo se pasa al siguiente proveedor si el
       actual RECHAZÓ (no cobró). Si queda en proceso o sin confirmar, se
       para ahí: probar otro podría recargar dos veces.

Cuándo la validación de un proveedor sirve para otro:
  la cuenta es del juego, no del proveedor, así que un ID (subtype 1) o
  ID + zona (subtype 3) es el mismo en todos. Los servidores (subtype 2) y
  los roles son ids propios de cada proveedor: en esos casos la cadena se
  limita a proveedores iguales al que validó. Además, antes de recargar
  en otro proveedor que también sabe validar, se vuelve a validar ahí y
  si el nombre no coincide se descarta.
"""

from __future__ import annotations

import json
import logging
import unicodedata
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from app.providers.base import FULFILLED, PROCESSING, REJECTED, UNCERTAIN, ExecResult
from app.topups.store import TopupStore, effective_variant_key

logger = logging.getLogger(__name__)

VALIDATION_TTL_SECONDS = 300
VALIDATION_PREFIX = "topup:validation:"

# Estados de direct_topup_executions
IN_PROGRESS = "in_progress"   # se está intentando ahora mismo
FINAL_STATES = {"fulfilled", "failed"}

_EXEC_TO_ROW = {FULFILLED: "fulfilled", PROCESSING: "processing", UNCERTAIN: "uncertain"}


class TopupError(Exception):
    def __init__(self, code: str, message: str, http_status: int = 422):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http_status = http_status


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalize_name(name: Optional[str]) -> str:
    if not name:
        return ""
    text = unicodedata.normalize("NFKC", str(name)).casefold()
    return " ".join(text.split())


def names_match(expected: Optional[str], got: Optional[str], user_id: str) -> bool:
    """Compara nombres solo si los dos son nombres reales.

    Coda y Hankgames devuelven el propio user_id cuando no conocen el
    nombre; en ese caso no hay nada que comparar (el ID es el mismo).
    """
    a, b = normalize_name(expected), normalize_name(got)
    uid = normalize_name(user_id)
    if not a or not b or a == uid or b == uid:
        return True
    return a == b


def cost_in_usd(supplier: dict, rates: dict[str, float]) -> Optional[float]:
    try:
        cost = float(supplier.get("cost_price"))
    except (TypeError, ValueError):
        return None
    rate = rates.get((supplier.get("cost_currency") or "USD").upper())
    return cost * rate if rate else None


def execution_order(chain: list[dict], rates: dict[str, float]) -> list[dict]:
    """Del más barato al más caro. Sin costo comparable van al final, por prioridad."""
    def key(s):
        usd = cost_in_usd(s, rates)
        return (usd is None, usd or 0.0, s.get("priority") or 1, s["id"])
    return sorted(chain, key=key)


def _restricted(supplier: dict) -> bool:
    """Servidores y roles son ids de cada proveedor: no se comparten."""
    return (supplier.get("subtype") or 1) == 2 or bool(supplier.get("have_role"))


def public_execution(row: dict) -> dict:
    return {
        "request_id": row.get("request_id"),
        "status": row.get("status"),
        "product_id": row.get("product_id"),
        "variant_key": row.get("variant_key"),
        "account": row.get("account"),
        "user_name": row.get("user_name"),
        "provider": row.get("provider"),
        "provider_order_id": row.get("provider_order_id"),
        "cost_price": row.get("cost_price"),
        "cost_currency": row.get("cost_currency"),
        "error": row.get("error"),
        "attempts": row.get("attempts") or [],
        "created_at": row.get("created_at"),
        "updated_at": row.get("updated_at"),
    }


class TopupEngine:
    def __init__(self, providers: dict, store: TopupStore, redis_client, fx=None):
        self.providers = providers
        self.store = store
        self.redis = redis_client
        # dict fijo (pruebas) u objeto con `async rates()` (LiveFxRates).
        self.fx = fx

    async def _fx_rates(self) -> dict:
        if self.fx is None:
            return {"USD": 1.0}
        if isinstance(self.fx, dict):
            return self.fx
        try:
            return await self.fx.rates()
        except Exception:
            logger.exception("[Topups] no se pudo obtener el tipo de cambio")
            return {"USD": 1.0}

    # ── Helpers ─────────────────────────────────────────────────────────

    def _chain(self, product_id: int, variant_key: str) -> list[dict]:
        chain = [s for s in self.store.chain(product_id, variant_key) if s.get("provider", "coda") in self.providers]
        if not chain:
            raise TopupError("not_available", "Esta recarga no está disponible.", 404)
        return chain

    def _validators(self, chain: list[dict]) -> list[dict]:
        """Variantes que pueden validar, en orden de prioridad (la cadena ya viene así)."""
        out = [s for s in chain
               if getattr(self.providers[s.get("provider") or "coda"], "can_validate", False)
               and s.get("validates") is not False]
        if not out:
            raise TopupError("no_validator", "Ningún proveedor de esta recarga puede validar la cuenta.", 422)
        if _restricted(out[0]):
            # Servidores y personajes son ids de cada proveedor: solo valida
            # el proveedor que da la lista de servidores.
            first = out[0].get("provider") or "coda"
            out = [s for s in out if (s.get("provider") or "coda") == first]
        return out

    def _validator(self, chain: list[dict]) -> dict:
        return self._validators(chain)[0]

    async def _validate_with(self, supplier: dict, account: dict, role_id: Optional[str] = None):
        provider = self.providers[supplier.get("provider") or "coda"]
        return await provider.validate(
            ref=supplier["coda_sku"],
            user_id=account["user_id"],
            server=account.get("server"),
            role_id=role_id,
            zone_id=account.get("zone_id"),
            catalog_entry=None,
        )

    def available(self, product_id: int, variant_key: str) -> bool:
        """Hay al menos un proveedor activo para esta denominación."""
        try:
            self._chain(product_id, variant_key)
            return True
        except TopupError:
            return False

    # ── Servidores ──────────────────────────────────────────────────────

    async def servers(self, product_id: int, variant_key: str) -> list[dict]:
        validator = self._validator(self._chain(product_id, variant_key))
        provider = self.providers[validator.get("provider") or "coda"]
        try:
            return await provider.list_servers(validator["coda_sku"])
        except Exception:
            logger.exception("[Topups] error listando servidores (supplier=%s)", validator["id"])
            raise TopupError("provider_error", "No se pudo consultar los servidores.", 502)

    # ── Validar ─────────────────────────────────────────────────────────

    async def validate(self, consumer: str, product_id: int, variant_key: str, account: dict) -> dict:
        chain = self._chain(product_id, variant_key)
        candidates = self._validators(chain)

        # Se pregunta en orden hasta que uno devuelva el nombre real. Lo que
        # devolvió cada uno se guarda para no volver a llamarlo al recargar.
        prepared: dict[str, dict] = {}
        chosen, chosen_result = None, None
        said_invalid = False
        for supplier in candidates:
            try:
                result = await self._validate_with(supplier, account)
            except Exception:
                logger.exception("[Topups] error validando (supplier=%s)", supplier["id"])
                continue
            if not result.valid:
                said_invalid = True
                logger.info("[Topups] %s dice que la cuenta no es válida (supplier=%s)",
                            supplier.get("provider"), supplier["id"])
                continue
            verified = bool(getattr(result, "name_verified", False))
            prepared[str(supplier["id"])] = {
                "pending": result.pending, "user_name": result.user_name, "name_verified": verified,
            }
            if chosen is None or (verified and not chosen_result.name_verified):
                chosen, chosen_result = supplier, result
            if verified:
                break

        if chosen is None:
            if said_invalid:
                return {"valid": False}
            raise TopupError("provider_error", "No se pudo validar la cuenta en este momento.", 502)

        name_verified = bool(getattr(chosen_result, "name_verified", False))
        if _restricted(chosen):
            same = chosen.get("provider") or "coda"
            chain = [s for s in chain if (s.get("provider") or "coda") == same]
        chain = execution_order(chain, await self._fx_rates())

        user_name = chosen_result.user_name if name_verified else None
        validation_id = uuid.uuid4().hex
        await self.redis.setex(VALIDATION_PREFIX + validation_id, VALIDATION_TTL_SECONDS, json.dumps({
            "consumer": consumer,
            "product_id": product_id,
            "variant_key": variant_key,
            "account": account,
            "user_name": user_name,
            "name_verified": name_verified,
            "server_name": chosen_result.server_name,
            "have_role": bool(chosen.get("have_role")),
            "validator_id": chosen["id"],
            "validator_pending": chosen_result.pending,
            "prepared": prepared,
            "chain": chain,
        }))
        return {
            "valid": True,
            "validation_id": validation_id,
            "user_name": user_name,
            "name_verified": name_verified,
            "server_name": chosen_result.server_name,
            "roles": chosen_result.roles,
            "expires_in": VALIDATION_TTL_SECONDS,
        }

    # ── Ejecutar ────────────────────────────────────────────────────────

    async def execute(self, consumer: str, request_id: str, validation_id: str, role_id: Optional[str]) -> dict:
        existing = self.store.get_execution(consumer, request_id)
        if existing:
            if existing.get("validation_id") != validation_id:
                raise TopupError("request_id_conflict", "Ese request_id ya se usó para otra recarga.", 409)
            return public_execution(existing)

        key = VALIDATION_PREFIX + validation_id
        raw = await self.redis.get(key)
        validation = json.loads(raw) if raw else None
        if not validation or validation.get("consumer") != consumer:
            raise TopupError("validation_expired", "La validación venció o no existe. Valida la cuenta de nuevo.", 410)
        if validation.get("have_role") and not role_id:
            raise TopupError("role_required", "Esta recarga necesita elegir un personaje (role_id).", 422)

        # La validación es de un solo uso: si dos request_id distintos la
        # mandan a la vez, solo uno la consigue.
        if not await self.redis.delete(key):
            again = self.store.get_execution(consumer, request_id)
            if again:
                return public_execution(again)
            raise TopupError("validation_expired", "La validación ya se usó. Valida la cuenta de nuevo.", 410)

        row = self.store.insert_execution({
            "consumer": consumer,
            "request_id": request_id,
            "validation_id": validation_id,
            "product_id": validation["product_id"],
            "variant_key": validation["variant_key"],
            "account": {**validation["account"], **({"role_id": role_id} if role_id else {})},
            "user_name": validation.get("user_name"),
            "status": IN_PROGRESS,
            "attempts": [],
        })
        if row is None:
            # Otra petición con el mismo request_id ganó la carrera.
            return public_execution(self.store.get_execution(consumer, request_id) or {})

        return public_execution(await self._run_chain(row, validation, role_id))

    async def _run_chain(self, row: dict, validation: dict, role_id: Optional[str]) -> dict:
        attempts: list[dict] = []
        account = validation["account"]
        last_error = None

        for n, supplier in enumerate(validation["chain"], start=1):
            provider_code = supplier.get("provider") or "coda"
            provider = self.providers.get(provider_code)
            attempt = {"supplier_id": supplier["id"], "provider": provider_code, "at": _now()}

            # 1. Preparar la recarga en este proveedor.
            prepared = (validation.get("prepared") or {}).get(str(supplier["id"]))
            if supplier["id"] == validation["validator_id"]:
                pending = validation["validator_pending"]
            elif prepared:
                # Ya validó al pedir el nombre: se usa lo que devolvió.
                if prepared.get("name_verified") and validation.get("name_verified") \
                        and not names_match(validation.get("user_name"), prepared.get("user_name"), account["user_id"]):
                    last_error = f"{provider_code}: el nombre de la cuenta no coincide"
                    attempts.append({**attempt, "status": REJECTED, "error": last_error, "stage": "prepare"})
                    continue
                pending = prepared["pending"]
            else:
                try:
                    prep = await self._validate_with(supplier, account, role_id)
                except Exception as e:
                    logger.exception("[Topups] error preparando en %s", provider_code)
                    prep, last_error = None, f"{provider_code}: no se pudo preparar ({type(e).__name__})"
                if prep is None or not prep.valid:
                    last_error = last_error if prep is None else f"{provider_code}: cuenta no válida"
                    attempts.append({**attempt, "status": REJECTED, "error": last_error, "stage": "prepare"})
                    continue
                if getattr(provider, "can_validate", False) and not names_match(validation.get("user_name"), prep.user_name, account["user_id"]):
                    last_error = f"{provider_code}: el nombre de la cuenta no coincide"
                    attempts.append({**attempt, "status": REJECTED, "error": last_error, "stage": "prepare"})
                    continue
                pending = prep.pending

            # 2. Dejar constancia ANTES de llamar: si el proceso se cae a
            #    mitad, la reconciliación sabe que pudo haberse hecho.
            attempts.append({**attempt, "status": "started"})
            self.store.update_execution(row["id"], {
                "attempts": attempts,
                "supplier_id": supplier["id"],
                "provider": provider_code,
            })

            try:
                result = await provider.execute(pending, role_id, external_ref=f"th-{row['id']}-{n}")
            except Exception as e:
                logger.exception("[Topups] excepción ejecutando en %s", provider_code)
                result = ExecResult(UNCERTAIN, error=f"Error inesperado ({type(e).__name__})")

            attempts[-1] = {**attempt, "status": result.status, "order_id": result.order_id, "error": result.error}

            if result.status == REJECTED:
                last_error = f"{provider_code}: {result.error}" if result.error else f"{provider_code}: rechazada"
                self.store.update_execution(row["id"], {"attempts": attempts})
                continue

            return self.store.update_execution(row["id"], {
                "attempts": attempts,
                "status": _EXEC_TO_ROW[result.status],
                "supplier_id": supplier["id"],
                "provider": provider_code,
                "provider_order_id": result.order_id,
                "cost_price": supplier.get("cost_price"),
                "cost_currency": supplier.get("cost_currency"),
                "error": result.error if result.status != FULFILLED else None,
            })

        return self.store.update_execution(row["id"], {
            "attempts": attempts,
            "status": "failed",
            "error": last_error or "Ningún proveedor pudo hacer la recarga.",
        })

    # ── Costos al día (para recargar con el más barato) ─────────────────

    async def refresh_costs_once(self) -> int:
        """Consulta el precio vigente de las variantes que tienen respaldo y
        actualiza cost_price/cost_currency si cambió. Devuelve cuántas cambió.

        Solo las de grupos con 2+ proveedores: ahí el costo decide el orden.
        Si un proveedor no responde, se conserva el precio que había.
        """
        groups: dict[tuple, list[dict]] = {}
        for s in self.store.active_suppliers():
            groups.setdefault((s["product_id"], effective_variant_key(s)), []).append(s)
        changed = 0
        cache: dict = {}   # una consulta por juego/producto en cada pasada
        for members in groups.values():
            if len(members) < 2:
                continue
            for s in members:
                provider = self.providers.get(s.get("provider") or "coda")
                getter = getattr(provider, "current_price", None)
                if not getter:
                    continue
                try:
                    price = await getter(s, cache)
                except Exception as e:
                    logger.warning("[Topups] sin precio de %s para supplier=%s: %s", s.get("provider"), s["id"], e)
                    continue
                if not price:
                    continue
                amount, currency = float(price[0]), (price[1] or s.get("cost_currency") or "USD").upper()
                old = s.get("cost_price")
                if old is not None and abs(float(old) - amount) < 0.0001 and (s.get("cost_currency") or "").upper() == currency:
                    continue
                self.store.update_cost(s["id"], amount, currency)
                logger.info("[Topups] costo supplier=%s (%s): %s → %s %s", s["id"], s.get("provider"), old, amount, currency)
                changed += 1
        return changed

    # ── Consultar / reconciliar ─────────────────────────────────────────

    async def get(self, consumer: str, request_id: str, refresh: bool = True) -> dict:
        row = self.store.get_execution(consumer, request_id)
        if not row:
            raise TopupError("not_found", "No existe esa recarga.", 404)
        if refresh and row.get("status") == "processing":
            row = await self.refresh(row)
        return public_execution(row)

    async def refresh(self, row: dict) -> dict:
        """Consulta al proveedor una ejecución en proceso y la actualiza si cambió."""
        provider = self.providers.get(row.get("provider") or "")
        order_id = row.get("provider_order_id")
        if not provider or not order_id:
            return row
        try:
            result = await provider.check_status(order_id)
        except Exception:
            logger.exception("[Topups] error consultando estado %s", order_id)
            return row
        if result.status == FULFILLED:
            return self.store.update_execution(row["id"], {"status": "fulfilled", "error": None})
        if result.status == REJECTED:
            # El proveedor la anuló después de aceptarla: no cobró.
            return self.store.update_execution(row["id"], {"status": "failed", "error": result.error or "El proveedor anuló la recarga"})
        return row

    async def reconcile_once(self) -> int:
        """Revisa ejecuciones en proceso y las que quedaron a medias. Devuelve cuántas cambió."""
        changed = 0
        for row in self.store.list_to_reconcile(processing_older_than_s=30, in_progress_older_than_s=600):
            if row.get("status") == "processing":
                new = await self.refresh(row)
                changed += int(new.get("status") != "processing")
                continue
            # in_progress viejo: el proceso se cayó en medio de la cadena.
            attempts = row.get("attempts") or []
            if any(a.get("status") == "started" for a in attempts):
                self.store.update_execution(row["id"], {
                    "status": "uncertain",
                    "error": "El servicio se interrumpió durante la recarga; revisar con el proveedor.",
                })
            else:
                # Nunca se llegó a llamar a un proveedor (o todos rechazaron).
                self.store.update_execution(row["id"], {
                    "status": "failed",
                    "error": "La recarga no llegó a enviarse a ningún proveedor.",
                })
            changed += 1
        return changed
