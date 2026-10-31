# UBICACIÓN EN TU REPO: yape-gaming/app/topups/fx.py
# (repositorio: yape-gaming · ruta: app/topups/fx.py)
"""
app/topups/fx.py

Tipo de cambio EN VIVO para comparar costos de proveedores en distintas
monedas (recargar con el más barato). Usa el mismo servicio que el backend
principal: exchangerate-api.com con EXCHANGE_RATE_API_KEY.

- Se consulta como mucho cada 6 horas (cache en memoria y en Redis, así
  todas las réplicas comparten la misma tasa).
- Si el servicio falla, se usa la última tasa guardada (hasta 7 días).
- Sin key ni tasa guardada: solo se comparan costos en USD; los de otras
  monedas van al final del orden (nunca se compara sin convertir).
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

REDIS_KEY = "topup:fx:usd_rates"
TTL_SECONDS = 6 * 3600
KEEP_SECONDS = 7 * 24 * 3600


def usd_per_unit(conversion_rates: dict) -> dict[str, float]:
    """exchangerate-api da USD → moneda (1 USD = 3.7 PEN); el motor necesita moneda → USD."""
    out = {"USD": 1.0}
    for code, rate in (conversion_rates or {}).items():
        try:
            rate = float(rate)
        except (TypeError, ValueError):
            continue
        if rate > 0:
            out[str(code).upper()] = 1.0 / rate
    return out


class LiveFxRates:
    def __init__(self, redis_client, api_key: Optional[str] = None):
        self.redis = redis_client
        self.api_key = api_key if api_key is not None else os.environ.get("EXCHANGE_RATE_API_KEY", "")
        self._rates: Optional[dict[str, float]] = None
        self._fetched_at = 0.0

    async def _load_saved(self) -> Optional[tuple[dict, float]]:
        try:
            raw = await self.redis.get(REDIS_KEY)
            if raw:
                data = json.loads(raw)
                return data["rates"], float(data["fetched_at"])
        except Exception:
            logger.warning("[FX] no se pudo leer la tasa guardada en Redis")
        return None

    async def _fetch(self) -> Optional[dict[str, float]]:
        if not self.api_key:
            return None
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.get(f"https://v6.exchangerate-api.com/v6/{self.api_key}/latest/USD")
            data = resp.json()
        except Exception as e:
            logger.warning("[FX] exchangerate-api sin respuesta: %s", type(e).__name__)
            return None
        if data.get("result") != "success" or not data.get("conversion_rates"):
            logger.error("[FX] exchangerate-api respondió error: %s", data.get("error-type") or data)
            return None
        return usd_per_unit(data["conversion_rates"])

    async def rates(self) -> dict[str, float]:
        now = time.time()
        if self._rates and now - self._fetched_at < TTL_SECONDS:
            return self._rates
        saved = await self._load_saved()
        if saved and now - saved[1] < TTL_SECONDS:
            self._rates, self._fetched_at = saved
            return self._rates
        fresh = await self._fetch()
        if fresh:
            self._rates, self._fetched_at = fresh, now
            try:
                await self.redis.setex(REDIS_KEY, KEEP_SECONDS, json.dumps({"rates": fresh, "fetched_at": now}))
            except Exception:
                logger.warning("[FX] no se pudo guardar la tasa en Redis")
            logger.info("[FX] tasas actualizadas (%d monedas)", len(fresh))
            return fresh
        # Falló la consulta: la última tasa conocida sirve para ordenar.
        if saved:
            self._rates, self._fetched_at = saved[0], now - TTL_SECONDS + 600   # reintenta en 10 min
            return self._rates
        if self._rates:
            return self._rates
        return {"USD": 1.0}
