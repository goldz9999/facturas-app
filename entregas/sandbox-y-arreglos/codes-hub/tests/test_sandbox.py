"""Clientes de prueba (sandbox): recargas simuladas según el final del user_id."""

from datetime import datetime, timedelta, timezone

import pytest

from app.main import app
from app.routes.public_topups import get_topup_service
from app.services.topup_service import TopupService, ValidationStore
from tests.test_client_auth import CLIENT_IP
from tests.test_topups import auth, balance, create, engine, topups_repo, validate  # noqa: F401 (fixtures)


@pytest.fixture
def sandbox(client, admin_headers, topups_repo, engine):
    topups_repo.add_supplier(4, 77, subtype=2, label="300 Diamantes")
    service = TopupService(topups_repo, engine, ValidationStore(""))
    app.dependency_overrides[get_topup_service] = lambda: service
    body = {"code": "tisi_test", "name": "TISI (prueba)", "ip_whitelist": [CLIENT_IP], "rate_limit_rpm": 1000,
            "sandbox": True, "low_balance_threshold": "9.00"}
    created = client.post("/admin/dist/clients", json=body, headers=admin_headers).json()
    assert created["client"]["sandbox"] is True
    c = {"id": created["client"]["id"], **created["credentials"], "service": service}
    base = f"/admin/dist/clients/{c['id']}"
    for supplier_id, sku in ((1, "FF100"), (3, "FF200"), (4, "FF300")):
        r = client.post(f"{base}/topup-products", json={"supplier_id": supplier_id, "sell_price": "1.50",
                                                        "external_sku": sku}, headers=admin_headers)
        assert r.status_code == 201, r.text
    client.post(f"{base}/balance/credit", json={"amount": 10, "description": "Saldo de prueba"}, headers=admin_headers)
    return c


@pytest.fixture
def no_alerts(monkeypatch):
    sent = []
    from app.services import alerts
    a = alerts.get_alerts()
    for name in ("topup_completed", "topup_uncertain", "check_low_balance"):
        monkeypatch.setattr(a, name, lambda *args, _n=name: sent.append(_n))
    return sent


def topup(client, c, user_id, request_id="r1", sku="FF100"):
    v = validate(client, c, sku, {"user_id": user_id}).json()
    return v, create(client, c, v["validation_id"], request_id, sku)


def age(topups_repo, seconds=60):
    topups_repo.rows[-1]["created_at"] = (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


def test_ping_says_sandbox(client, sandbox):
    assert client.get("/v1/ping", headers=auth(sandbox)).json()["sandbox"] is True


def test_completed_never_calls_real_engine(client, sandbox, engine, topups_repo, no_alerts):
    v, r = topup(client, sandbox, "2247270001")
    assert v["valid"] is True and v["user_name"] == "Jugador de prueba 0001"
    body = r.json()
    assert body["status"] == "completed" and body["balance_after"] == 8.5
    assert balance(client, sandbox) == 8.5
    assert topups_repo.rows[0]["provider"] == "sandbox"
    assert engine.calls == []          # el motor real nunca se llamó
    assert no_alerts == []             # ni Telegram (aunque cruzó el umbral de saldo bajo)


def test_any_other_id_completes(client, sandbox):
    assert topup(client, sandbox, "2247279241")[1].json()["status"] == "completed"


def test_failed_refunds(client, sandbox):
    body = topup(client, sandbox, "1110002")[1].json()
    assert body["status"] == "failed" and body["error"]
    assert balance(client, sandbox) == 10


def test_processing_then_completed(client, sandbox, topups_repo, repo, no_alerts):
    assert topup(client, sandbox, "1110003")[1].json()["status"] == "processing"
    assert client.get("/v1/topups/r1", headers=auth(sandbox)).json()["status"] == "processing"
    age(topups_repo)
    assert client.get("/v1/topups/r1", headers=auth(sandbox)).json()["status"] == "completed"
    assert balance(client, sandbox) == 8.5
    assert no_alerts == []


def test_processing_then_failed_by_reconcile(client, sandbox, topups_repo, repo):
    assert topup(client, sandbox, "1110005")[1].json()["status"] == "processing"
    age(topups_repo)
    assert sandbox["service"].reconcile_once(repo.get) == 1
    assert client.get("/v1/topups/r1", headers=auth(sandbox)).json()["status"] == "failed"
    assert balance(client, sandbox) == 10


def test_no_response_then_completed(client, sandbox, topups_repo):
    assert topup(client, sandbox, "1110006")[1].json()["status"] == "processing"
    age(topups_repo)
    assert client.get("/v1/topups/r1", headers=auth(sandbox)).json()["status"] == "completed"


def test_under_review_without_alert_and_admin_can_close(client, sandbox, topups_repo, admin_headers, no_alerts):
    assert topup(client, sandbox, "1110004")[1].json()["status"] == "under_review"
    assert balance(client, sandbox) == 8.5
    assert no_alerts == []
    tid = topups_repo.rows[0]["id"]
    r = client.post(f"/admin/dist/topups/{tid}/resolve", json={"outcome": "failed"}, headers=admin_headers)
    assert r.status_code == 200, r.text
    assert client.get("/v1/topups/r1", headers=auth(sandbox)).json()["status"] == "failed"
    assert balance(client, sandbox) == 10


def test_invalid_account(client, sandbox):
    r = validate(client, sandbox, account={"user_id": "1110009"})
    assert r.status_code == 200 and r.json()["valid"] is False


def test_provider_unavailable_on_validate(client, sandbox):
    r = validate(client, sandbox, account={"user_id": "1110008"})
    assert r.status_code == 503 and r.json()["error"] == "provider_unavailable"


def test_servers_and_server_name(client, sandbox):
    r = client.get("/v1/topups/servers", params={"product_sku": "FF300"}, headers=auth(sandbox))
    assert r.json()["servers"][0] == {"id": "1", "name": "Servidor de prueba 1"}
    v = validate(client, sandbox, sku="FF300", account={"user_id": "123", "server": "2"}).json()
    assert v["valid"] is True and v["server_name"] == "Servidor de prueba 2"


def test_same_rules_as_production(client, sandbox, admin_headers):
    # Saldo insuficiente y validación de un solo uso funcionan igual que con la clave real.
    v, r = topup(client, sandbox, "1110001")
    assert create(client, sandbox, v["validation_id"], "r2").json()["error"] == "validation_expired"
    assert validate(client, sandbox, sku="FF200", account={"user_id": "1"}).json()["error"] == "missing_account_fields"
    client.post(f"/admin/dist/clients/{sandbox['id']}/balance/adjust", json={"amount": -8.5, "description": "x"},
                headers=admin_headers)
    v = validate(client, sandbox, account={"user_id": "1110001"}).json()
    assert create(client, sandbox, v["validation_id"], "r3").json()["error"] == "insufficient_balance"


def test_orders_blocked_for_sandbox(client, sandbox):
    r = client.post("/v1/orders", json={"request_id": "o1", "product_sku": "X", "quantity": 1}, headers=auth(sandbox))
    assert r.status_code == 403 and r.json()["error"] == "sandbox_not_supported"


def test_real_client_unchanged(client, admin_headers, topups_repo, engine):
    body = {"code": "real", "name": "Real", "ip_whitelist": [CLIENT_IP]}
    created = client.post("/admin/dist/clients", json=body, headers=admin_headers).json()
    assert created["client"]["sandbox"] is False
