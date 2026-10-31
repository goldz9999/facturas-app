# UBICACIÓN EN TU REPO: yape-gaming/tests/test_fx.py
# (repositorio: yape-gaming · ruta: tests/test_fx.py)
"""Tipo de cambio en vivo (app/topups/fx.py) con exchangerate-api simulado."""

import asyncio
import json
import time

import httpx
import respx

from app.topups import fx as fxmod
from app.topups.fx import LiveFxRates, usd_per_unit
from tests.test_topup_engine import FakeRedis

URL = "https://v6.exchangerate-api.com/v6/k/latest/USD"
OK = {"result": "success", "conversion_rates": {"USD": 1, "PEN": 3.75, "EUR": 0.92}}


def run(coro):
    return asyncio.run(coro)


def test_usd_per_unit():
    rates = usd_per_unit({"USD": 1, "PEN": 4, "BAD": "x", "ZERO": 0})
    assert rates == {"USD": 1.0, "PEN": 0.25}


@respx.mock
def test_fetches_once_and_caches():
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=OK))
    redis = FakeRedis()
    fx = LiveFxRates(redis, api_key="k")
    first = run(fx.rates())
    second = run(fx.rates())
    assert route.call_count == 1 and first == second
    assert abs(first["PEN"] - 1 / 3.75) < 1e-9
    assert json.loads(redis.data[fxmod.REDIS_KEY])["rates"] == first     # otras réplicas la reutilizan


@respx.mock
def test_other_replica_uses_saved_rate():
    route = respx.get(URL).mock(return_value=httpx.Response(200, json=OK))
    redis = FakeRedis()
    redis.data[fxmod.REDIS_KEY] = json.dumps({"rates": {"USD": 1.0, "PEN": 0.3}, "fetched_at": time.time()})
    assert run(LiveFxRates(redis, api_key="k").rates())["PEN"] == 0.3
    assert route.call_count == 0


@respx.mock
def test_service_down_uses_last_known_rate():
    respx.get(URL).mock(side_effect=httpx.ConnectError("x"))
    redis = FakeRedis()
    old = time.time() - fxmod.TTL_SECONDS - 100                            # vencida, pero es lo último que hay
    redis.data[fxmod.REDIS_KEY] = json.dumps({"rates": {"USD": 1.0, "PEN": 0.26}, "fetched_at": old})
    assert run(LiveFxRates(redis, api_key="k").rates())["PEN"] == 0.26


@respx.mock
def test_error_response_and_no_saved_rate_is_usd_only():
    respx.get(URL).mock(return_value=httpx.Response(200, json={"result": "error", "error-type": "invalid-key"}))
    assert run(LiveFxRates(FakeRedis(), api_key="k").rates()) == {"USD": 1.0}


def test_without_key_is_usd_only():
    assert run(LiveFxRates(FakeRedis(), api_key="").rates()) == {"USD": 1.0}
