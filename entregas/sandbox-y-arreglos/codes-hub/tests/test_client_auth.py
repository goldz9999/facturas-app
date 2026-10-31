import base64

import pytest

from app.middleware.client_ip import ip_allowed

CLIENT_IP = "200.1.2.3"


def basic(client_id, secret):
    token = base64.b64encode(f"{client_id}:{secret}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


EDGE_IP = "79.127.177.113"  # IP del borde de Railway que va al final de X-Forwarded-For


def from_ip(ip, extra=None):
    """Simula lo que llega en Railway: IP real del cliente y luego la del borde."""
    return {"X-Forwarded-For": f"{ip}, {EDGE_IP}", **(extra or {})}


@pytest.fixture
def tisi(client, admin_headers):
    body = {"code": "tisi", "name": "TISI", "ip_whitelist": [CLIENT_IP], "rate_limit_rpm": 5}
    created = client.post("/admin/dist/clients", json=body, headers=admin_headers).json()
    return {"id": created["client"]["id"], **created["credentials"]}


def ping(client, tisi, ip=CLIENT_IP, secret=None):
    headers = {**basic(tisi["client_id"], secret or tisi["client_secret"]), **from_ip(ip)}
    return client.get("/v1/ping", headers=headers)


def test_ping_ok(client, tisi, access_log):
    r = ping(client, tisi)
    assert r.status_code == 200
    assert r.json() == {"ok": True, "client": "tisi", "ip": CLIENT_IP, "sandbox": False}

    entry = access_log.entries[-1]
    assert entry["client_id"] == tisi["id"]
    assert entry["status_code"] == 200
    assert entry["rejected_reason"] is None
    assert entry["ip_address"] == CLIENT_IP
    assert entry["endpoint"] == "/v1/ping"


def test_missing_or_malformed_auth(client, tisi, access_log):
    for headers in ({}, {"Authorization": "Basic !!!"}, {"Authorization": "Bearer x"}):
        r = client.get("/v1/ping", headers={**headers, **from_ip(CLIENT_IP)})
        assert r.status_code == 401
        assert r.headers["www-authenticate"].startswith("Basic")
    assert access_log.entries[-1]["rejected_reason"] == "unauthorized"
    assert access_log.entries[-1]["client_id"] is None


def test_wrong_secret_and_unknown_client(client, tisi):
    assert ping(client, tisi, secret="incorrecto").status_code == 401
    r = client.get("/v1/ping", headers={**basic("nadie", "x"), **from_ip(CLIENT_IP)})
    assert r.status_code == 401
    assert r.json()["error"] == "unauthorized"


def test_ip_not_whitelisted(client, tisi, access_log):
    r = ping(client, tisi, ip="8.8.8.8")
    assert r.status_code == 403
    assert r.json()["error"] == "ip_blocked"
    assert access_log.entries[-1]["client_id"] == tisi["id"]
    assert access_log.entries[-1]["rejected_reason"] == "ip_blocked"


def test_spoofed_forwarded_for_is_ignored(client, tisi):
    # El cliente manda su IP "permitida" a la izquierda; Railway agrega la real y la del borde.
    headers = {**basic(tisi["client_id"], tisi["client_secret"]),
               "X-Forwarded-For": f"{CLIENT_IP}, 8.8.8.8, {EDGE_IP}"}
    assert client.get("/v1/ping", headers=headers).status_code == 403


def test_edge_ip_is_not_the_client_ip(client, tisi):
    # Antes se tomaba la última entrada (el borde de Railway): nunca debe contar como cliente.
    headers = {**basic(tisi["client_id"], tisi["client_secret"]), "X-Forwarded-For": f"8.8.8.8, {CLIENT_IP}"}
    assert client.get("/v1/ping", headers=headers).status_code == 403


def test_missing_forwarded_entries_fails_closed(client, tisi):
    # Una sola entrada: no se sabe cuál es la real, se usa la IP de la conexión y se rechaza.
    headers = {**basic(tisi["client_id"], tisi["client_secret"]), "X-Forwarded-For": CLIENT_IP}
    assert client.get("/v1/ping", headers=headers).status_code == 403


def test_suspended_client(client, tisi, admin_headers):
    client.patch(f"/admin/dist/clients/{tisi['id']}/status", json={"status": "suspended"}, headers=admin_headers)
    r = ping(client, tisi)
    assert r.status_code == 403
    assert r.json()["error"] == "account_suspended"


def test_rotated_key_rejects_old_secret_even_if_cached(client, tisi, admin_headers):
    assert ping(client, tisi).status_code == 200  # queda en cache
    new = client.post(f"/admin/dist/clients/{tisi['id']}/rotate-key", headers=admin_headers).json()
    assert ping(client, tisi).status_code == 401
    assert ping(client, tisi, secret=new["client_secret"]).status_code == 200


def test_rate_limit_per_client(client, tisi):
    codes = [ping(client, tisi).status_code for _ in range(6)]
    assert codes == [200] * 5 + [429]
    r = ping(client, tisi)
    assert r.json()["error"] == "rate_limited"
    assert r.headers["retry-after"] == "60"


def test_brute_force_blocked_by_ip(client, tisi):
    for _ in range(20):
        assert ping(client, tisi, secret="mal").status_code == 401
    # Incluso con el secret correcto, esa IP queda bloqueada el resto del minuto.
    assert ping(client, tisi).status_code == 429


def test_admin_routes_not_logged(client, admin_headers, access_log):
    client.get("/admin/dist/clients", headers=admin_headers)
    assert access_log.entries == []


@pytest.mark.parametrize(
    "ip,whitelist,expected",
    [
        ("200.1.2.3", ["200.1.2.3"], True),
        ("10.0.0.7", ["10.0.0.0/24"], True),
        ("10.0.1.7", ["10.0.0.0/24"], False),
        ("200.1.2.3", [], False),
        (None, ["200.1.2.3"], False),
        ("no-ip", ["200.1.2.3"], False),
    ],
)
def test_ip_allowed(ip, whitelist, expected):
    assert ip_allowed(ip, whitelist) is expected
