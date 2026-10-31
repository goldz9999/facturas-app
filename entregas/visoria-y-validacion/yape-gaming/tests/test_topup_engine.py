# UBICACIÓN EN TU REPO: yape-gaming/tests/test_topup_engine.py
# (repositorio: yape-gaming · ruta: tests/test_topup_engine.py)
"""Pruebas del motor de recargas (app/topups) con proveedores y base falsos."""

import asyncio
import copy
import uuid

import httpx
import pytest

from app.providers.base import FULFILLED, PROCESSING, REJECTED, UNCERTAIN, ExecResult, ValidateResult
from app.topups.engine import TopupEngine, TopupError, names_match
from app.topups.store import effective_variant_key


def run(coro):
    return asyncio.run(coro)


# ── Dobles ───────────────────────────────────────────────────────────────

class FakeRedis:
    def __init__(self):
        self.data = {}

    async def setex(self, key, ttl, value):
        self.data[key] = value

    async def get(self, key):
        return self.data.get(key)

    async def delete(self, key):
        return 1 if self.data.pop(key, None) is not None else 0

    async def set(self, key, value, nx=False, ex=None):
        if nx and key in self.data:
            return None
        self.data[key] = value
        return True


class FakeStore:
    def __init__(self, suppliers):
        self.suppliers = suppliers
        self.executions = {}

    def chain(self, product_id, variant_key):
        rows = [s for s in self.suppliers if s["product_id"] == product_id and s.get("is_active", True)
                and effective_variant_key(s) == variant_key]
        return sorted(copy.deepcopy(rows), key=lambda r: (r.get("priority") or 1, r["id"]))

    def get_execution(self, consumer, request_id):
        for row in self.executions.values():
            if row["consumer"] == consumer and row["request_id"] == request_id:
                return copy.deepcopy(row)
        return None

    def insert_execution(self, row):
        if self.get_execution(row["consumer"], row["request_id"]):
            return None
        row = {**row, "id": str(uuid.uuid4())}
        self.executions[row["id"]] = row
        return copy.deepcopy(row)

    def update_execution(self, execution_id, fields):
        self.executions[execution_id].update(copy.deepcopy(fields))
        return copy.deepcopy(self.executions[execution_id])

    def list_to_reconcile(self, processing_older_than_s, in_progress_older_than_s):
        return [copy.deepcopy(r) for r in self.executions.values() if r["status"] in ("processing", "in_progress")]


class FakeProvider:
    def __init__(self, code, *, can_validate=True, user_name="Jugador Uno", valid=True,
                 exec_status=FULFILLED, status_after=None, raise_on_execute=None, verified=None,
                 raise_on_validate=None):
        self.code = code
        self.can_validate = can_validate
        self.user_name = user_name
        self.valid = valid
        self.exec_status = exec_status
        self.status_after = status_after
        self.raise_on_execute = raise_on_execute
        self.verified = verified
        self.raise_on_validate = raise_on_validate
        self.validate_calls = []
        self.execute_calls = []

    async def validate(self, ref, user_id, server, role_id, zone_id, catalog_entry):
        self.validate_calls.append({"ref": ref, "user_id": user_id, "server": server, "zone_id": zone_id})
        if not self.valid:
            return ValidateResult(valid=False)
        if self.raise_on_validate:
            raise self.raise_on_validate
        name = self.user_name if self.can_validate else None
        verified = bool(name) if self.verified is None else self.verified
        return ValidateResult(valid=True, user_name=name, name_verified=verified,
                              roles=None, pending={"ref": ref, "by": self.code})

    async def execute(self, pending, role_id, external_ref):
        self.execute_calls.append({"pending": pending, "role_id": role_id, "external_ref": external_ref})
        if self.raise_on_execute:
            raise self.raise_on_execute
        return ExecResult(self.exec_status, order_id=f"{self.code}-order", error=None if self.exec_status == FULFILLED else "x")

    async def check_status(self, order_id):
        return ExecResult(self.status_after or PROCESSING, order_id=order_id)

    async def list_servers(self, ref):
        return [{"id": "s1", "name": "Server 1"}]


def supplier(id, provider, *, priority=1, variant_key="100d", subtype=1, have_role=False, product_id=7,
             cost=1.5, currency="USD", validates=None):
    row = {"id": id, "product_id": product_id, "provider": provider, "coda_sku": f"{provider}-sku",
           "subtype": subtype, "have_role": have_role, "variant_key": variant_key, "priority": priority,
           "cost_price": cost, "cost_currency": currency, "is_active": True}
    if validates is not None:
        row["validates"] = validates
    return row


def make(suppliers, fx_rates=None, **providers):
    store = FakeStore(suppliers)
    redis = FakeRedis()
    return TopupEngine(providers, store, redis, fx=fx_rates), store, redis


ACCOUNT = {"user_id": "123456", "zone_id": "77"}


async def validate_and_execute(engine, request_id="r1", role_id=None):
    v = await engine.validate("dist:tisi", 7, "100d", ACCOUNT)
    assert v["valid"]
    return v, await engine.execute("dist:tisi", request_id, v["validation_id"], role_id)


# ── Casos ────────────────────────────────────────────────────────────────

def test_fulfilled_first_provider():
    a, b = FakeProvider("coda"), FakeProvider("hankgames")
    engine, store, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=a, hankgames=b)
    v, res = run(validate_and_execute(engine))
    assert v["user_name"] == "Jugador Uno"
    assert res["status"] == "fulfilled" and res["provider"] == "coda"
    assert res["cost_price"] == 1.5
    assert len(a.execute_calls) == 1 and not b.execute_calls
    # Reusó lo que dejó la validación (orderId de Coda): no validó dos veces.
    assert len(a.validate_calls) == 1


def test_fallback_after_reject():
    a = FakeProvider("coda", exec_status=REJECTED)
    b = FakeProvider("hankgames")
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=a, hankgames=b)
    _, res = run(validate_and_execute(engine))
    assert res["status"] == "fulfilled" and res["provider"] == "hankgames"
    assert [x["status"] for x in res["attempts"]] == [REJECTED, FULFILLED]
    # El segundo proveedor validó en su lado antes de recargar.
    assert len(b.validate_calls) == 1


@pytest.mark.parametrize("status,row_status", [(UNCERTAIN, "uncertain"), (PROCESSING, "processing")])
def test_uncertain_or_processing_stops_chain(status, row_status):
    a = FakeProvider("coda", exec_status=status)
    b = FakeProvider("hankgames")
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=a, hankgames=b)
    _, res = run(validate_and_execute(engine))
    assert res["status"] == row_status
    assert not b.execute_calls


def test_exception_in_execute_is_uncertain():
    a = FakeProvider("coda", raise_on_execute=RuntimeError("boom"))
    b = FakeProvider("hankgames")
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=a, hankgames=b)
    _, res = run(validate_and_execute(engine))
    assert res["status"] == "uncertain" and not b.execute_calls


def test_all_reject_is_failed():
    a = FakeProvider("coda", exec_status=REJECTED)
    b = FakeProvider("hankgames", exec_status=REJECTED)
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=a, hankgames=b)
    _, res = run(validate_and_execute(engine))
    assert res["status"] == "failed" and res["error"]


def test_same_request_id_is_idempotent():
    a = FakeProvider("coda")
    engine, store, _ = make([supplier(1, "coda")], coda=a)

    async def scenario():
        v, first = await validate_and_execute(engine, "r1")
        again = await engine.execute("dist:tisi", "r1", v["validation_id"], None)
        return first, again

    first, again = run(scenario())
    assert again["status"] == "fulfilled" and again["provider_order_id"] == first["provider_order_id"]
    assert len(a.execute_calls) == 1
    assert len(store.executions) == 1


def test_request_id_reused_with_other_validation_conflicts():
    engine, _, _ = make([supplier(1, "coda")], coda=FakeProvider("coda"))

    async def scenario():
        await validate_and_execute(engine, "r1")
        v2 = await engine.validate("dist:tisi", 7, "100d", ACCOUNT)
        await engine.execute("dist:tisi", "r1", v2["validation_id"], None)

    with pytest.raises(TopupError) as e:
        run(scenario())
    assert e.value.code == "request_id_conflict"


def test_validation_is_single_use():
    a = FakeProvider("coda")
    engine, _, _ = make([supplier(1, "coda")], coda=a)

    async def scenario():
        v, _ = await validate_and_execute(engine, "r1")
        await engine.execute("dist:tisi", "r2", v["validation_id"], None)

    with pytest.raises(TopupError) as e:
        run(scenario())
    assert e.value.code == "validation_expired"
    assert len(a.execute_calls) == 1


def test_validation_of_other_consumer_rejected():
    engine, _, _ = make([supplier(1, "coda")], coda=FakeProvider("coda"))

    async def scenario():
        v = await engine.validate("dist:tisi", 7, "100d", ACCOUNT)
        await engine.execute("dist:otro", "r1", v["validation_id"], None)

    with pytest.raises(TopupError) as e:
        run(scenario())
    assert e.value.code == "validation_expired"


def test_expired_validation():
    engine, _, _ = make([supplier(1, "coda")], coda=FakeProvider("coda"))
    with pytest.raises(TopupError) as e:
        run(engine.execute("dist:tisi", "r1", "no-existe", None))
    assert e.value.code == "validation_expired"


def test_name_mismatch_skips_provider():
    a = FakeProvider("coda", exec_status=REJECTED, user_name="Jugador Uno")
    b = FakeProvider("hankgames", user_name="Otra Persona")
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=a, hankgames=b)
    _, res = run(validate_and_execute(engine))
    assert res["status"] == "failed"
    assert "no coincide" in res["error"]
    assert not b.execute_calls


def test_name_match_rules():
    assert names_match("Jugador  Uno", "jugador uno", "1")
    assert names_match("Jugador", "123", "123")      # uno devolvió el ID: nada que comparar
    assert not names_match("Jugador", "Otro", "123")


def test_validator_is_first_that_can_validate():
    blind = FakeProvider("visoria", can_validate=False)
    hg = FakeProvider("hankgames")
    engine, _, _ = make([supplier(1, "visoria"), supplier(2, "hankgames", priority=2)], visoria=blind, hankgames=hg)
    v, res = run(validate_and_execute(engine))
    assert v["user_name"] == "Jugador Uno" and len(hg.validate_calls) == 1
    # Visoria va primero en la cadena y recarga ella.
    assert res["provider"] == "visoria"


def test_no_validator():
    engine, _, _ = make([supplier(1, "visoria")], visoria=FakeProvider("visoria", can_validate=False))
    with pytest.raises(TopupError) as e:
        run(engine.validate("dist:tisi", 7, "100d", ACCOUNT))
    assert e.value.code == "no_validator"


def test_server_products_stay_on_validator_provider():
    a = FakeProvider("coda", exec_status=REJECTED)
    b = FakeProvider("hankgames")
    engine, _, _ = make([supplier(1, "coda", subtype=2), supplier(2, "hankgames", priority=2, subtype=2)],
                        coda=a, hankgames=b)
    _, res = run(validate_and_execute(engine))
    assert res["status"] == "failed" and not b.execute_calls


def test_role_required():
    engine, _, _ = make([supplier(1, "coda", have_role=True)], coda=FakeProvider("coda"))

    async def scenario():
        v = await engine.validate("dist:tisi", 7, "100d", ACCOUNT)
        await engine.execute("dist:tisi", "r1", v["validation_id"], None)

    with pytest.raises(TopupError) as e:
        run(scenario())
    assert e.value.code == "role_required"


def test_unknown_variant_not_available():
    engine, _, _ = make([supplier(1, "coda")], coda=FakeProvider("coda"))
    with pytest.raises(TopupError) as e:
        run(engine.validate("dist:tisi", 7, "otra", ACCOUNT))
    assert e.value.code == "not_available"


def test_row_without_variant_key_is_its_own_denomination():
    s = supplier(9, "coda", variant_key=None)
    engine, _, _ = make([s], coda=FakeProvider("coda"))
    v = run(engine.validate("dist:tisi", 7, "v9", ACCOUNT))
    assert v["valid"]


def test_invalid_account():
    engine, _, _ = make([supplier(1, "coda")], coda=FakeProvider("coda", valid=False))
    assert run(engine.validate("dist:tisi", 7, "100d", ACCOUNT)) == {"valid": False}


def test_get_refreshes_processing():
    a = FakeProvider("hankgames", exec_status=PROCESSING, status_after=FULFILLED)
    engine, _, _ = make([supplier(1, "hankgames")], hankgames=a)

    async def scenario():
        await validate_and_execute(engine, "r1")
        return await engine.get("dist:tisi", "r1")

    assert run(scenario())["status"] == "fulfilled"


def test_reconcile_stuck_in_progress():
    engine, store, _ = make([supplier(1, "coda")], coda=FakeProvider("coda"))
    started = store.insert_execution({"consumer": "c", "request_id": "a", "status": "in_progress",
                                      "attempts": [{"status": "started"}]})
    never = store.insert_execution({"consumer": "c", "request_id": "b", "status": "in_progress", "attempts": []})
    assert run(engine.reconcile_once()) == 2
    assert store.executions[started["id"]]["status"] == "uncertain"
    assert store.executions[never["id"]]["status"] == "failed"


# ── Clasificación de los proveedores reales ──────────────────────────────

def _coda():
    from app.providers.coda_client import CodaProvider
    return CodaProvider(base_url="https://x", api_key="k", client_id="c", secret="s",
                        redis_client=FakeRedis(), catalog_ttl_seconds=60)


CODA_PENDING = {"order_id": "o1", "api_path": "/ml", "user_account": {"userId": "1", "zoneId": "2"},
                "ref": "SKU", "price_amount": 100, "price_currency": "USD", "have_role": False}


def _http_error(code):
    req = httpx.Request("POST", "https://x")
    return httpx.HTTPStatusError("e", request=req, response=httpx.Response(code, request=req))


@pytest.mark.parametrize("behaviour,expected", [
    ({"result": {"status": "FULFILLED", "orderId": "o1"}}, FULFILLED),
    ({"error": {"message": "Price Error"}}, REJECTED),
    ({"result": {"status": "PENDING"}}, UNCERTAIN),
    (_http_error(400), REJECTED),
    (_http_error(503), UNCERTAIN),
    (httpx.ReadTimeout("t"), UNCERTAIN),
])
def test_coda_execute_classification(monkeypatch, behaviour, expected):
    coda = _coda()

    async def fake_call(path, method, params):
        if isinstance(behaviour, Exception):
            raise behaviour
        return behaviour

    monkeypatch.setattr(coda, "_call", fake_call)
    assert run(coda.execute(dict(CODA_PENDING), None, "ref")).status == expected


def test_coda_redeem_no_longer_returns_none(monkeypatch):
    coda = _coda()

    async def fake_call(path, method, params):
        return {"result": {"status": "PENDING"}}

    monkeypatch.setattr(coda, "_call", fake_call)
    result = run(coda.redeem(dict(CODA_PENDING), None))
    assert result is not None and result.success is False


HG_PENDING = {"ref": "p1", "user_id": "1", "server": None, "zone_id": "2"}


@pytest.mark.parametrize("deliver,states,expected", [
    ({"orderId": "h1"}, ["Finalized"], FULFILLED),
    ({"orderId": "h1"}, ["failed"], REJECTED),
    ({"orderId": "h1"}, ["pending", "pending", "pending"], PROCESSING),
    ("http400", [], REJECTED),
    ("http500", [], UNCERTAIN),
    ("timeout", [], UNCERTAIN),
    ("no_order", [], UNCERTAIN),
])
def test_hankgames_execute_classification(monkeypatch, deliver, states, expected):
    from app.providers import hankgames_client as hg

    async def fake_create(**kwargs):
        if deliver == "http400":
            raise hg.HankgamesError("bad", http_status=400)
        if deliver == "http500":
            raise hg.HankgamesError("down", http_status=500)
        if deliver == "timeout":
            raise httpx.ReadTimeout("t")
        if deliver == "no_order":
            raise hg.HankgamesError("Respuesta inesperada")
        assert kwargs["external_order_id"] == "th-1-1"
        return deliver

    queue = list(states)

    async def fake_details(order_id):
        return {"status": queue.pop(0)}

    async def no_sleep(_):
        return None

    monkeypatch.setattr(hg, "create_transaction", fake_create)
    monkeypatch.setattr(hg, "get_transaction_details", fake_details)
    monkeypatch.setattr(hg.asyncio, "sleep", no_sleep)
    assert run(hg.HankgamesProvider().execute(dict(HG_PENDING), None, "th-1-1")).status == expected



# ── Validar con quien dé el nombre y recargar con el más barato ──────────

def test_validation_moves_on_until_a_provider_gives_the_name():
    coda = FakeProvider("coda", verified=False, user_name="123456")   # devuelve el ID, no el nombre
    hank = FakeProvider("hankgames", user_name="goldz999")
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=coda, hankgames=hank)
    v, res = run(validate_and_execute(engine))
    assert v["user_name"] == "goldz999" and v["name_verified"] is True
    # Recargó Coda (mismo costo, prioridad 1) con lo que dejó su validación: nadie validó dos veces.
    assert res["provider"] == "coda"
    assert len(coda.validate_calls) == 1 and len(hank.validate_calls) == 1


def test_validation_stops_at_first_name():
    coda, hank = FakeProvider("coda"), FakeProvider("hankgames")
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=coda, hankgames=hank)
    run(engine.validate("dist:tisi", 7, "100d", ACCOUNT))
    assert len(coda.validate_calls) == 1 and not hank.validate_calls


def test_first_says_invalid_second_gives_name():
    coda = FakeProvider("coda", valid=False)
    hank = FakeProvider("hankgames", user_name="goldz999")
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=coda, hankgames=hank)
    v = run(engine.validate("dist:tisi", 7, "100d", ACCOUNT))
    assert v["valid"] and v["user_name"] == "goldz999"


def test_all_say_invalid():
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)],
                        coda=FakeProvider("coda", valid=False), hankgames=FakeProvider("hankgames", valid=False))
    assert run(engine.validate("dist:tisi", 7, "100d", ACCOUNT)) == {"valid": False}


def test_validator_error_tries_next_and_all_errors_is_provider_error():
    coda = FakeProvider("coda", raise_on_validate=RuntimeError("down"))
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)],
                        coda=coda, hankgames=FakeProvider("hankgames"))
    assert run(engine.validate("dist:tisi", 7, "100d", ACCOUNT))["valid"]
    engine, _, _ = make([supplier(1, "coda")], coda=coda)
    with pytest.raises(TopupError) as e:
        run(engine.validate("dist:tisi", 7, "100d", ACCOUNT))
    assert e.value.code == "provider_error"


def test_no_name_anywhere_is_valid_without_name():
    engine, _, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)],
                        coda=FakeProvider("coda", verified=False), hankgames=FakeProvider("hankgames", verified=False))
    v = run(engine.validate("dist:tisi", 7, "100d", ACCOUNT))
    assert v["valid"] is True and v["name_verified"] is False and v["user_name"] is None


def test_cheapest_provider_recharges_first():
    coda, hank = FakeProvider("coda"), FakeProvider("hankgames")
    engine, _, _ = make([supplier(1, "coda", cost=2.0), supplier(2, "hankgames", priority=2, cost=1.2)],
                        coda=coda, hankgames=hank)
    v, res = run(validate_and_execute(engine))
    assert v["user_name"] == "Jugador Uno"                  # validó Coda (prioridad 1)
    assert res["provider"] == "hankgames" and res["cost_price"] == 1.2
    assert not coda.execute_calls


def test_costs_in_other_currency_are_converted():
    coda, hank = FakeProvider("coda"), FakeProvider("hankgames")
    suppliers = [supplier(1, "coda", cost=5.0, currency="PEN"), supplier(2, "hankgames", priority=2, cost=1.5)]
    engine, _, _ = make(suppliers, fx_rates={"USD": 1.0, "PEN": 0.27}, coda=coda, hankgames=hank)
    _, res = run(validate_and_execute(engine))
    assert res["provider"] == "coda"                        # 5 PEN ≈ 1.35 USD < 1.5 USD


def test_unknown_cost_goes_last():
    coda, hank = FakeProvider("coda"), FakeProvider("hankgames")
    engine, _, _ = make([supplier(1, "coda", cost=None), supplier(2, "hankgames", priority=2, cost=9.0)],
                        coda=coda, hankgames=hank)
    _, res = run(validate_and_execute(engine))
    assert res["provider"] == "hankgames"


def test_cheapest_rejects_then_next_cheapest():
    coda = FakeProvider("coda")
    hank = FakeProvider("hankgames", exec_status=REJECTED)
    engine, _, _ = make([supplier(1, "coda", cost=2.0), supplier(2, "hankgames", priority=2, cost=1.0)],
                        coda=coda, hankgames=hank)
    _, res = run(validate_and_execute(engine))
    assert res["provider"] == "coda"
    assert [a["provider"] for a in res["attempts"]] == ["hankgames", "coda"]


def test_recharge_only_provider_is_used_but_never_validates():
    coda = FakeProvider("coda")
    visoria = FakeProvider("visoria", can_validate=False)
    engine, _, _ = make([supplier(1, "coda", cost=2.0), supplier(2, "visoria", priority=2, cost=1.0)],
                        coda=coda, visoria=visoria)
    v, res = run(validate_and_execute(engine))
    assert v["user_name"] == "Jugador Uno"
    assert res["provider"] == "visoria"
    assert len(visoria.validate_calls) == 1                 # solo para preparar la recarga


def test_variant_marked_not_to_validate_is_skipped_for_validation():
    coda = FakeProvider("coda", user_name="goldz999")
    hank = FakeProvider("hankgames", user_name="goldz999")
    engine, _, _ = make([supplier(1, "coda", validates=False), supplier(2, "hankgames", priority=2)],
                        coda=coda, hankgames=hank)
    v, res = run(validate_and_execute(engine))
    assert v["user_name"] == "goldz999"
    assert res["provider"] == "coda"                        # pero sí recarga
    assert len(coda.validate_calls) == 1                    # solo al preparar la recarga


def test_only_recharge_only_providers_cannot_validate():
    engine, _, _ = make([supplier(1, "visoria")], visoria=FakeProvider("visoria", can_validate=False))
    with pytest.raises(TopupError) as e:
        run(engine.validate("dist:tisi", 7, "100d", ACCOUNT))
    assert e.value.code == "no_validator"


def test_name_mismatch_on_prepared_provider_is_skipped():
    coda = FakeProvider("coda", user_name="Jugador Uno", exec_status=REJECTED)
    hank = FakeProvider("hankgames", user_name="Otra Persona")
    engine, _, redis = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=coda, hankgames=hank)

    async def scenario():
        v = await engine.validate("dist:tisi", 7, "100d", ACCOUNT)
        # Simula que Hankgames también validó al pedir el nombre, con otro nombre.
        key = "topup:validation:" + v["validation_id"]
        data = __import__("json").loads(redis.data[key])
        data["prepared"]["2"] = {"pending": {"ref": "x"}, "user_name": "Otra Persona", "name_verified": True}
        redis.data[key] = __import__("json").dumps(data)
        return await engine.execute("dist:tisi", "r1", v["validation_id"], None)

    res = run(scenario())
    assert res["status"] == "failed" and not hank.execute_calls


class LiveRates:
    def __init__(self, rates):
        self.calls = 0
        self._rates = rates

    async def rates(self):
        self.calls += 1
        return self._rates


def test_live_fx_object_is_used_for_order():
    coda, hank = FakeProvider("coda"), FakeProvider("hankgames")
    fx = LiveRates({"USD": 1.0, "PEN": 1 / 3.75})
    suppliers = [supplier(1, "coda", cost=5.0, currency="PEN"), supplier(2, "hankgames", priority=2, cost=1.5)]
    engine, _, _ = make(suppliers, fx_rates=fx, coda=coda, hankgames=hank)
    _, res = run(validate_and_execute(engine))
    assert res["provider"] == "coda" and fx.calls == 1      # 5 PEN ≈ 1.33 USD < 1.5 USD


def test_fx_failure_falls_back_to_usd_only():
    class Broken:
        async def rates(self):
            raise RuntimeError("down")
    coda, hank = FakeProvider("coda"), FakeProvider("hankgames")
    suppliers = [supplier(1, "coda", cost=1.0, currency="PEN"), supplier(2, "hankgames", priority=2, cost=9.0)]
    engine, _, _ = make(suppliers, fx_rates=Broken(), coda=coda, hankgames=hank)
    _, res = run(validate_and_execute(engine))
    assert res["provider"] == "hankgames"                    # PEN sin tasa → al final, nunca sin convertir


# ── Costos al día ────────────────────────────────────────────────────────

class PricedProvider(FakeProvider):
    def __init__(self, code, price=None, fail=False, **kw):
        super().__init__(code, **kw)
        self.price, self.fail, self.price_calls = price, fail, 0

    async def current_price(self, supplier, cache):
        self.price_calls += 1
        if self.fail:
            raise RuntimeError("timeout")
        return self.price


def test_refresh_costs_updates_only_grouped_and_changed():
    coda = PricedProvider("coda", price=(2.10, "usd"))
    hank = PricedProvider("hankgames", price=(1.5, "USD"))       # igual al guardado: no se toca
    suppliers = [supplier(1, "coda"), supplier(2, "hankgames", priority=2),
                 supplier(3, "coda", variant_key="sola")]         # sin respaldo: no se consulta
    engine, store, _ = make(suppliers, coda=coda, hankgames=hank)
    store.updates = []
    store.active_suppliers = lambda: [copy.deepcopy(x) for x in store.suppliers]
    store.update_cost = lambda sid, amount, cur: store.updates.append((sid, amount, cur))
    assert run(engine.refresh_costs_once()) == 1
    assert store.updates == [(1, 2.10, "USD")]
    assert coda.price_calls == 1 and hank.price_calls == 1


def test_refresh_costs_keeps_price_when_provider_fails():
    coda = PricedProvider("coda", fail=True)
    hank = PricedProvider("hankgames", price=None)
    engine, store, _ = make([supplier(1, "coda"), supplier(2, "hankgames", priority=2)], coda=coda, hankgames=hank)
    store.updates = []
    store.active_suppliers = lambda: [copy.deepcopy(x) for x in store.suppliers]
    store.update_cost = lambda *a: store.updates.append(a)
    assert run(engine.refresh_costs_once()) == 0 and store.updates == []
