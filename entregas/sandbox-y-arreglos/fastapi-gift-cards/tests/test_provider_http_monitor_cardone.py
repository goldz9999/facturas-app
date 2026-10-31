"""
Una caída de 99Cards en su servicio de cifrado (/encryAndDencry) ANTES de
enviar /order no debe tomarse como orden dudosa: la orden nunca salió.

Correr:
  SUPABASE_URL=http://x SUPABASE_SERVICE_KEY=x python -m pytest tests/test_provider_http_monitor_cardone.py
"""
import os

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "test")

import asyncio

import httpx

from app.core import provider_http_monitor as mon

BASE = "https://api.99cardsint.com/v1"


def _run(responses: dict[str, int], calls: list[str]) -> str | None:
    """
    Repite la secuencia de CardOneClient.place_order:
    cifrar credenciales → /token → cifrar orden → /order → descifrar.
    Se detiene en la primera respuesta 5xx/4xx, como el cliente real
    (raise_for_status en el cifrado; /order con error corta el flujo).
    """
    def handler(request: httpx.Request) -> httpx.Response:
        step = calls[len(_seen)]
        _seen.append(step)
        return httpx.Response(responses.get(step, 200), text="x")

    _seen: list[str] = []

    async def go():
        mon.install()
        mon.start_request_tracking()
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as c:
            for step in calls:
                path = "/encryAndDencry" if step.startswith("crypt") else f"/{step}"
                r = await c.post(f"{BASE}{path}")
                if r.status_code >= 400:
                    break
        try:
            return mon.order_request_outcome()
        finally:
            mon.stop_request_tracking()

    return asyncio.run(go())


FLOW = ["crypt-token", "token", "crypt-order", "order", "crypt-decrypt"]


def test_502_al_cifrar_credenciales_del_token_no_se_envio():
    # Es el caso de los logs: "Requesting new access token" → 502 al cifrar.
    assert _run({"crypt-token": 502}, FLOW) == "not_sent"


def test_502_al_cifrar_la_orden_no_se_envio():
    assert _run({"crypt-order": 502}, FLOW) == "not_sent"


def test_orden_enviada_y_502_al_descifrar_sigue_en_duda():
    assert _run({"crypt-decrypt": 502}, FLOW) == "uncertain"


def test_502_en_order_sigue_en_duda():
    assert _run({"order": 502}, FLOW) == "uncertain"


def test_4xx_en_order_es_rechazo():
    assert _run({"order": 400}, FLOW) == "rejected"


def test_que_peticiones_pueden_crear_la_orden():
    assert mon.is_order_creating_request("POST", "/v1/encryAndDencry") is False
    assert mon.is_order_creating_request("POST", "/v1/token") is False
    assert mon.is_order_creating_request("GET", "/v1/order") is False
    assert mon.is_order_creating_request("POST", "/v1/order") is True
