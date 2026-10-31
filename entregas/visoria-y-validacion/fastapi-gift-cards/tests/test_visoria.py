# UBICACIÓN EN TU REPO: fastapi-gift-cards/tests/test_visoria.py
# (repositorio: fastapi-gift-cards · ruta: tests/test_visoria.py)
"""
Visoria como proveedor de códigos.

Correr:
  SUPABASE_URL=http://x SUPABASE_SERVICE_KEY=x python -m pytest tests/test_visoria.py
"""
import os

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test")

import asyncio
import json

import httpx
import pytest
import respx

from app.core.config import settings
from app.providers import visoria_client as vs
from app.services import auto_purchase_service as aps
from app.services.provider_order_tracking import is_ambiguous_submit_error

BASE = "https://api.visoria.digital"


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def key(monkeypatch):
    monkeypatch.setattr(settings, "VISORIA_API_KEY", "vsk_test_x", raising=False)
    monkeypatch.setattr(settings, "VISORIA_BASE_URL", BASE, raising=False)


def order(status, keys):
    return {"id": "o1", "status": status, "items": [{"id": "i1", "keys": keys}]}


def k(status="DELIVERED", key=None, pin=None):
    return {"id": "k", "status": status, "key": key, "pin": pin}


# ── Cliente ─────────────────────────────────────────────────────────────

def test_extract_codes():
    o = order("COMPLETED", [k(key="AAAA-1"), k(key="CARD-2", pin="9999"), k(pin="ONLYPIN"), k("RESERVED", key="X"),
                            k("REFUNDED", key="Y")])
    assert vs.extract_codes(o) == ["AAAA-1", "CARD-2 PIN: 9999", "ONLYPIN"]


@respx.mock
def test_create_order_body_and_key_header():
    route = respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(200, json=order("PROGRESSING", [])))
    run(vs.create_order("prod-1", 3, "USD", "11111111-2222-3333-4444-555555555555"))
    req = route.calls[0].request
    assert req.headers["x-api-key"] == "vsk_test_x"
    assert json.loads(req.content) == {
        "items": [{"product_id": "prod-1", "quantity": 3, "face_value": 1}],
        "currency_code": "USD", "idempotency_key": "11111111-2222-3333-4444-555555555555"}


@respx.mock
def test_4xx_is_explicit_rejection_not_ambiguous():
    respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(422, json={"code": "VALIDATORx01", "message": "x"}))
    with pytest.raises(vs.VisoriaRejected) as e:
        run(vs.create_order("prod-1", 1, "USD", "k" * 20))
    assert is_ambiguous_submit_error(e.value) is False


@respx.mock
def test_5xx_is_not_a_rejection():
    respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(502, text="bad gateway"))
    with pytest.raises(vs.VisoriaError) as e:
        run(vs.create_order("prod-1", 1, "USD", "k" * 20))
    assert not isinstance(e.value, vs.VisoriaRejected)


@respx.mock
def test_balance():
    respx.get(f"{BASE}/v1/balance").mock(return_value=httpx.Response(200, json=[
        {"balance": 3.5, "currency_code": "EUR"}, {"balance": 1250.5, "currency_code": "USD"}]))
    assert run(vs.get_balance("USD")) == 1250.5


# ── Compra automática ───────────────────────────────────────────────────

class FakeTracker:
    def __init__(self, pending=None):
        self.pending = pending
        self.discarded = []

    def find_pending(self, provider, product_id, sku=None):
        return self.pending

    def discard_intent_if_empty(self, provider, order_ref, product_id):
        self.discarded.append(order_ref)


class Cfg:
    product_id = 5
    product_name = "Steam 10 USD"
    provider_sku = "prod-1"
    cantidad_compra = 2


def service(tracker=None):
    svc = aps.AutoPurchaseService.__new__(aps.AutoPurchaseService)
    svc._tracker = tracker or FakeTracker()
    svc.submits, svc.accepted, svc.settled = [], [], []
    svc._note_submit = lambda cfg, provider, qty, client_ref=None, meta=None: svc.submits.append((provider, qty, client_ref))
    svc._note_accepted = lambda cfg, ref, meta=None: svc.accepted.append(ref)

    async def settle(cfg, **kw):
        svc.settled.append(kw)
        return kw["fetched_codes"]
    svc._settle_order = settle
    return svc


@pytest.fixture
def fast(monkeypatch):
    async def no_sleep(_):
        return None
    monkeypatch.setattr(aps.asyncio, "sleep", no_sleep)


@respx.mock
def test_purchase_completed(fast):
    respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(200, json=order("PROGRESSING", [])))
    respx.get(url__regex=rf"{BASE}/v1/orders/by-idempotency-key/.*").mock(side_effect=[
        httpx.Response(200, json=order("PROGRESSING", [k(key="A")])),
        httpx.Response(200, json=order("COMPLETED", [k(key="A"), k(key="B")])),
    ])
    svc = service()
    codes = run(svc._purchase_visoria(Cfg(), {"cost_currency": "usd"}))
    assert codes == ["A", "B"]
    key = svc.submits[0][2]
    assert svc.submits[0][:2] == ("visoria", 2) and svc.accepted == [key]
    assert svc.settled[0]["order_ref"] == key and svc.settled[0]["requested_quantity"] == 2
    assert svc.settled[0]["resume_meta"]["idempotency_key"] == key
    assert json.loads(respx.calls[0].request.content)["currency_code"] == "USD"


@respx.mock
def test_purchase_cancelled_raises_and_discards(fast):
    respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(200, json=order("CANCELLED", [])))
    svc = service()
    with pytest.raises(RuntimeError):
        run(svc._purchase_visoria(Cfg(), {}))
    assert svc.settled == [] and len(svc._tracker.discarded) == 1


@respx.mock
def test_purchase_still_progressing_is_settled_as_pending(fast):
    respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(200, json=order("PROGRESSING", [])))
    respx.get(url__regex=rf"{BASE}/v1/orders/by-idempotency-key/.*").mock(
        return_value=httpx.Response(200, json=order("PROGRESSING", [])))
    svc = service()
    assert run(svc._purchase_visoria(Cfg(), {})) == []
    assert svc.settled[0]["terminal_failure"] is False   # _settle_order la deja PENDING


@respx.mock
def test_pending_order_is_resumed_not_bought_again(fast):
    get = respx.get(f"{BASE}/v1/orders/by-idempotency-key/key-123").mock(
        return_value=httpx.Response(200, json=order("COMPLETED", [k(key="A"), k(key="B")])))
    post = respx.post(f"{BASE}/v1/orders")
    pending = {"order_ref": "key-123", "requested_quantity": 2, "raw_metadata": {"idempotency_key": "key-123"}}
    svc = service(FakeTracker(pending))
    assert run(svc._purchase_visoria(Cfg(), {})) == ["A", "B"]
    assert get.called and not post.called and svc.submits == []


@respx.mock
def test_rejected_order_is_marked_rejected(fast, monkeypatch):
    marked = []
    monkeypatch.setattr(aps, "note_rejected", lambda: marked.append(True))
    respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(403, json={"code": "REQUESTx04"}))
    with pytest.raises(vs.VisoriaRejected):
        run(service()._purchase_visoria(Cfg(), {}))
    assert marked == [True]


def test_wired_in_dispatch_and_maps():
    assert aps.AutoPurchaseService._PRICE_REFRESHERS["visoria"] == "_refresh_visoria_prices"
    from app.core.provider_http_monitor import provider_for_host
    assert provider_for_host("api.visoria.digital") == "visoria"
