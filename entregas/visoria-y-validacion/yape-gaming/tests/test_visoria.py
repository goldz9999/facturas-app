# UBICACIÓN EN TU REPO: yape-gaming/tests/test_visoria.py
# (repositorio: yape-gaming · ruta: tests/test_visoria.py)
"""Visoria como proveedor de recarga directa, con la API simulada (respx)."""

import asyncio
import json

import httpx
import pytest
import respx

from app.providers import visoria_client as vc
from app.providers.base import FULFILLED, PROCESSING, REJECTED, UNCERTAIN

BASE = "https://api.visoria.digital"

ML = {
    "id": "p-ml-86", "name": "Mobile Legends 86 Diamonds", "price": 1.32, "currency_code": "USD",
    "orderable": True, "fulfillment_type": "RECHARGE",
    "categories": [{"id": "cat-ml", "name": "Mobile Legends", "redemption_countries": []}],
    "recharge_fields": [
        {"field_name": "userId", "api_field_name": "user_id", "label": "User ID", "input_type": "text", "required": True},
        {"field_name": "zoneId", "api_field_name": "zone_id", "label": "Zone ID", "input_type": "text", "required": True},
    ],
}
STEAM = {**ML, "id": "p-steam", "name": "Steam $10", "fulfillment_type": "PIN", "recharge_fields": None,
         "categories": [{"id": "cat-steam", "name": "Steam", "redemption_countries": []}]}


def run(coro):
    return asyncio.run(coro)


@pytest.fixture(autouse=True)
def env(monkeypatch):
    monkeypatch.setenv("VISORIA_API_KEY", "vsk_test_x")
    monkeypatch.setattr(vc, "_STATUS_POLL_DELAY", 0)
    vc._product_cache.clear()


def order(status, key_status="DELIVERED", refund_reason=None):
    k = {"id": "k1", "status": key_status}
    if refund_reason:
        k["refund_reason"] = refund_reason
    return {"id": "o1", "number": "ORD-1", "status": status, "items": [{"id": "i1", "keys": [k]}]}


async def prepared():
    return await vc.VisoriaProvider().validate("p-ml-86", "2247279241", None, None, "1509", None)


# ── Preparar ────────────────────────────────────────────────────────────

@respx.mock
def test_validate_builds_order_fields_without_name():
    route = respx.get(f"{BASE}/v1/products/p-ml-86").mock(return_value=httpx.Response(200, json=ML))
    res = run(prepared())
    assert res.valid and res.user_name is None and res.name_verified is False
    assert res.pending["custom_value"] == [{"field_name": "userId", "value_code": "2247279241"},
                                           {"field_name": "zoneId", "value_code": "1509"}]
    assert route.calls[0].request.headers["x-api-key"] == "vsk_test_x"


@respx.mock
def test_validate_missing_required_field_is_invalid():
    respx.get(f"{BASE}/v1/products/p-ml-86").mock(return_value=httpx.Response(200, json=ML))
    res = run(vc.VisoriaProvider().validate("p-ml-86", "2247279241", None, None, None, None))
    assert res.valid is False


@respx.mock
def test_validate_not_orderable_is_invalid():
    respx.get(f"{BASE}/v1/products/p-ml-86").mock(return_value=httpx.Response(200, json={**ML, "orderable": False}))
    assert run(prepared()).valid is False


# ── Recargar ────────────────────────────────────────────────────────────

@respx.mock
def test_execute_completed():
    respx.get(f"{BASE}/v1/products/p-ml-86").mock(return_value=httpx.Response(200, json=ML))
    post = respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(200, json=order("COMPLETED")))
    pending = run(prepared()).pending
    res = run(vc.VisoriaProvider().execute(pending, None, external_ref="th-1-1"))
    assert res.status == FULFILLED and res.order_id == vc.idempotency_key("th-1-1")
    body = json.loads(post.calls[0].request.content)
    assert body["idempotency_key"] == vc.idempotency_key("th-1-1")
    assert body["currency_code"] == "USD"
    assert body["items"][0] == {"product_id": "p-ml-86", "quantity": 1, "face_value": 1,
                                "recharge_data": [{"custom_value": pending["custom_value"]}]}


def test_same_reference_same_idempotency_key():
    assert vc.idempotency_key("th-1-1") == vc.idempotency_key("th-1-1") != vc.idempotency_key("th-1-2")
    assert 16 <= len(vc.idempotency_key("x")) <= 128


@respx.mock
def test_execute_progressing_then_completed():
    respx.get(f"{BASE}/v1/products/p-ml-86").mock(return_value=httpx.Response(200, json=ML))
    respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(200, json=order("PROGRESSING")))
    key = vc.idempotency_key("th-2")
    respx.get(f"{BASE}/v1/orders/by-idempotency-key/{key}").mock(side_effect=[
        httpx.Response(200, json=order("PROGRESSING")), httpx.Response(200, json=order("COMPLETED"))])
    res = run(vc.VisoriaProvider().execute(run(prepared()).pending, None, external_ref="th-2"))
    assert res.status == FULFILLED


@respx.mock
def test_execute_still_progressing_is_processing():
    respx.get(f"{BASE}/v1/products/p-ml-86").mock(return_value=httpx.Response(200, json=ML))
    respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(200, json=order("PROGRESSING")))
    respx.get(url__regex=rf"{BASE}/v1/orders/by-idempotency-key/.*").mock(
        return_value=httpx.Response(200, json=order("PROGRESSING")))
    res = run(vc.VisoriaProvider().execute(run(prepared()).pending, None, external_ref="th-3"))
    assert res.status == PROCESSING and res.order_id == vc.idempotency_key("th-3")


@respx.mock
@pytest.mark.parametrize("payload", [order("CANCELLED"), order("COMPLETED", "REFUNDED", "Cuenta inválida")])
def test_cancelled_or_refunded_is_rejected(payload):
    respx.get(f"{BASE}/v1/products/p-ml-86").mock(return_value=httpx.Response(200, json=ML))
    respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(200, json=payload))
    res = run(vc.VisoriaProvider().execute(run(prepared()).pending, None, external_ref="th-4"))
    assert res.status == REJECTED and res.error


@respx.mock
@pytest.mark.parametrize("status,code", [(422, "VALIDATORx01"), (403, "REQUESTx04"), (429, "REQUESTx01")])
def test_4xx_is_rejected(status, code):
    respx.get(f"{BASE}/v1/products/p-ml-86").mock(return_value=httpx.Response(200, json=ML))
    respx.post(f"{BASE}/v1/orders").mock(return_value=httpx.Response(status, json={"code": code, "message": "no"}))
    res = run(vc.VisoriaProvider().execute(run(prepared()).pending, None, external_ref="th-5"))
    assert res.status == REJECTED and code in res.error


@respx.mock
def test_5xx_or_timeout_is_uncertain_with_key():
    respx.get(f"{BASE}/v1/products/p-ml-86").mock(return_value=httpx.Response(200, json=ML))
    respx.post(f"{BASE}/v1/orders").mock(side_effect=[httpx.Response(500, json={"code": "ERRORx01"}),
                                                       httpx.ReadTimeout("t")])
    pending = run(prepared()).pending
    for ref in ("th-6", "th-7"):
        res = run(vc.VisoriaProvider().execute(pending, None, external_ref=ref))
        assert res.status == UNCERTAIN and res.order_id == vc.idempotency_key(ref)


def test_without_api_key_nothing_is_sent(monkeypatch):
    monkeypatch.delenv("VISORIA_API_KEY")
    with pytest.raises(vc.VisoriaError):
        run(prepared())


# ── Admin ───────────────────────────────────────────────────────────────

@respx.mock
def test_search_games_only_recharge():
    respx.get(f"{BASE}/v1/products").mock(return_value=httpx.Response(200, json={
        "data": [ML, {**ML, "id": "p-ml-172"}, STEAM], "meta": {"page": 1, "limit": 100, "total": 3}}))
    games = run(vc.VisoriaProvider().search_games("mobile"))
    assert games == [{"name": "Mobile Legends", "categoryId": "cat-ml", "count": 2}]


@respx.mock
def test_admin_skus_with_price_and_subtype():
    respx.get(f"{BASE}/v1/products").mock(return_value=httpx.Response(200, json={
        "data": [ML, STEAM], "meta": {"page": 1, "limit": 100, "total": 2}}))
    skus = run(vc.VisoriaProvider().list_admin_skus("Mobile Legends"))
    assert len(skus) == 1
    assert skus[0]["sku"] == "p-ml-86" and skus[0]["priceAmount"] == 1.32 and skus[0]["subtype"] == 3


def test_field_mapping_rules():
    fields = [{"field_name": "playerId", "required": True}, {"field_name": "serverId", "required": True}]
    assert vc.guess_subtype(fields) == 2
    assert vc.build_custom_value(fields, {"user_id": "1", "server": "s9"}) == [
        {"field_name": "playerId", "value_code": "1"}, {"field_name": "serverId", "value_code": "s9"}]
    with pytest.raises(vc.MissingField):
        vc.build_custom_value([{"field_name": "characterId", "input_type": "lookup", "required": True}], {"user_id": "1"})
