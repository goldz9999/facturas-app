"""
app/core/provider_http_monitor.py
═════════════════════════════════
Observa TODAS las llamadas HTTP salientes a proveedores (httpx.AsyncClient)
sin tocar cada integración:

1. Métricas: cuenta llamadas por proveedor y código de respuesta. Se vuelcan
   a Redis al final de cada ciclo (flush_metrics) en un hash por día:
       replenish:metrics:api:YYYY-MM-DD  { "bamboo|2xx": 12, "bamboo|429": 1, ... }
   Sirve para medir la línea base ANTES de activar el Modo B (auditoría §10).

2. Pausa por límite de solicitudes: si un proveedor responde 429, se registra
   una pausa con la duración de Retry-After (o una espera exponencial con
   variación aleatoria si no lo envía). El Modo B no envía compras a un
   proveedor en pausa (ProviderCooldown → prueba el siguiente o reprograma).
   Nunca se reintenta de inmediato una petición rechazada por 429.

No cambia ninguna respuesta ni excepción: solo observa.
"""
from __future__ import annotations

import logging
import random
import time
from collections import Counter
from contextvars import ContextVar
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Palabra en el hostname → providers.code. Hosts no listados (Supabase,
# Telegram, Falabella, tasas de cambio...) no se cuentan.
_HOST_KEYWORDS = (
    ("bamboo", "bamboo"),
    ("manastore", "manastore"),
    ("ezcards", "ez"),
    ("99cards", "cardone"),
    ("wgcards", "wgcards"),
    ("icodes", "icodes"),
    ("hankgames", "hankgames"),
    ("wupex", "wupex"),
    ("tisi", "tisi"),
    ("codashop", "coda_voucher"),
    ("eneba", "eneba"),
)

_counts: Counter = Counter()
_cooldown_until: dict[str, float] = {}
_consecutive_429: Counter = Counter()
_installed = False

# Peticiones HTTP hechas desde que una integración marcó "voy a enviar la
# orden" (note_submit). Permite saber si la petición que CREA la orden llegó a
# salir, o si lo que falló fue algo previo (obtener token, consultar stock...).
_tracked_requests: ContextVar[Optional[list]] = ContextVar("provider_tracked_requests", default=None)
_AUTH_HINTS = ("token", "oauth", "auth", "login")
# POST al proveedor que nunca crean una orden. 99Cards cifra cada mensaje con
# /encryAndDencry ANTES de pedir el token y antes de /order: si ese servicio
# responde 502, la orden no llegó a salir. Antes ese 502 contaba como la
# última petición de creación → "uncertain" → aparecía en Recuperación de
# órdenes una orden que nunca existió y se bloqueaba el producto 24 h.
_NON_ORDER_HINTS = _AUTH_HINTS + ("encryanddencry",)


def is_order_creating_request(method: str, path: str) -> bool:
    """¿Esta petición pudo crear la orden? (no GET, no auth, no cifrado)."""
    path = (path or "").lower()
    return method.upper() != "GET" and not any(h in path for h in _NON_ORDER_HINTS)


def start_request_tracking() -> None:
    # Solo si el monitor está instalado en este proceso: si no, una lista
    # vacía se leería como "no se envió nada" y sería un falso negativo.
    _tracked_requests.set([] if _installed else None)


def stop_request_tracking() -> None:
    _tracked_requests.set(None)


def tracked_requests() -> Optional[list]:
    return _tracked_requests.get()


def _track(method: str, path: str, outcome, host: str = "") -> None:
    lst = _tracked_requests.get()
    if lst is not None:
        lst.append({"method": method.upper(), "path": path, "outcome": outcome,
                    "provider": provider_for_host(host)})


def order_request_outcome() -> Optional[str]:
    """
    Resultado de la última petición que pudo CREAR la orden (no GET, no auth,
    no cifrado) desde note_submit:
      None          → no hay información (cliente no instrumentado)
      "not_sent"    → nunca salió una petición de creación, o falló al conectar
      "rejected"    → el proveedor respondió 4xx (rechazo explícito)
      "uncertain"   → timeout/corte/5xx, o respondió 2xx y luego algo falló
    """
    lst = _tracked_requests.get()
    if lst is None:
        return None
    # Solo cuentan las peticiones al PROVEEDOR. Antes también contaba, por
    # ejemplo, el aviso de Telegram que se envía DESPUÉS de que Bamboo rechaza
    # la orden con 400: la última petición quedaba como "Telegram 200" y el
    # rechazo se tomaba como envío dudoso → aparecía en Recuperación de
    # órdenes una orden que nunca se creó y se bloqueaba el producto 24 h.
    writes = [r for r in lst
              if r.get("provider") and is_order_creating_request(r["method"], r["path"])]
    if not writes:
        return "not_sent"
    last = writes[-1]["outcome"]
    if last == "connect_error":
        return "not_sent"
    if isinstance(last, int) and 400 <= last < 500:
        return "rejected"
    return "uncertain"

COOLDOWN_KEY = "replenish:provider_cooldown:"
METRICS_KEY = "replenish:metrics:api:"


def provider_for_host(host: str) -> Optional[str]:
    host = (host or "").lower()
    for kw, code in _HOST_KEYWORDS:
        if kw in host:
            return code
    return None


def parse_retry_after(value: Optional[str], now: Optional[float] = None) -> Optional[float]:
    if not value:
        return None
    value = value.strip()
    try:
        return max(float(value), 0.0)
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return max(dt.timestamp() - (now or time.time()), 0.0)
    except Exception:
        return None


def _cooldown_seconds(provider: str, retry_after: Optional[float]) -> float:
    if retry_after is not None:
        return min(retry_after, settings.PROVIDER_COOLDOWN_MAX_SECONDS)
    n = _consecutive_429[provider]
    base = settings.PROVIDER_COOLDOWN_DEFAULT_SECONDS * (2 ** max(n - 1, 0))
    return min(base * random.uniform(0.8, 1.2), settings.PROVIDER_COOLDOWN_MAX_SECONDS)


async def _register_429(provider: str, response: httpx.Response) -> None:
    _consecutive_429[provider] += 1
    secs = _cooldown_seconds(provider, parse_retry_after(response.headers.get("Retry-After")))
    _cooldown_until[provider] = max(_cooldown_until.get(provider, 0), time.time() + secs)
    logger.warning("[ProviderHTTP] %s respondió 429 — pausa de %.0f s", provider, secs)
    try:
        from app.core.distributed_lock import redis_conn
        async with redis_conn() as r:
            await r.set(f"{COOLDOWN_KEY}{provider}", "429", px=max(int(secs * 1000), 1))
    except Exception as e:
        logger.debug("[ProviderHTTP] no se pudo guardar la pausa en Redis: %s", e)


def _observe(provider: str, status: int) -> None:
    bucket = "429" if status == 429 else f"{status // 100}xx"
    _counts[(provider, bucket)] += 1
    if status != 429:
        _consecutive_429.pop(provider, None)


async def cooldown_remaining(provider: str) -> float:
    """Segundos de pausa que le quedan a un proveedor (0 si puede usarse)."""
    provider = (provider or "").lower()
    if provider == "99cards":
        provider = "cardone"
    local = _cooldown_until.get(provider, 0) - time.time()
    if local > 0:
        return local
    try:
        from app.core.distributed_lock import redis_conn
        async with redis_conn() as r:
            ms = await r.pttl(f"{COOLDOWN_KEY}{provider}")
        return max(ms, 0) / 1000.0 if ms and ms > 0 else 0.0
    except Exception:
        return 0.0


def snapshot() -> dict[str, int]:
    return {f"{p}|{b}": n for (p, b), n in _counts.items()}


async def flush_metrics() -> dict[str, int]:
    """Vuelca los contadores de este proceso a Redis (1 pipeline) y los reinicia."""
    data = snapshot()
    if not data:
        return {}
    _counts.clear()
    key = f"{METRICS_KEY}{datetime.now(timezone.utc).date().isoformat()}"
    try:
        from app.core.distributed_lock import redis_conn
        async with redis_conn() as r:
            pipe = r.pipeline(transaction=False)
            for field, n in data.items():
                pipe.hincrby(key, field, n)
            pipe.expire(key, 60 * 60 * 24 * 45)
            await pipe.execute()
    except Exception as e:
        logger.debug("[ProviderHTTP] no se pudieron guardar métricas: %s", e)
    logger.info("[ProviderHTTP] llamadas a proveedores en este ciclo: %s", data)
    return data


def install() -> None:
    """Envuelve httpx.AsyncClient.send una sola vez por proceso (idempotente)."""
    global _installed
    if _installed:
        return
    original_send = httpx.AsyncClient.send

    async def send(self, request, *args, **kwargs):
        try:
            response = await original_send(self, request, *args, **kwargs)
        except Exception as exc:
            try:
                kind = "connect_error" if isinstance(
                    exc, (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)) else "error"
                _track(request.method, request.url.path, kind, request.url.host)
            except Exception:
                pass
            raise
        try:
            _track(request.method, request.url.path, response.status_code, request.url.host)
        except Exception:
            pass
        try:
            provider = provider_for_host(request.url.host)
            if provider:
                _observe(provider, response.status_code)
                if response.status_code == 429:
                    await _register_429(provider, response)
        except Exception:  # nunca interferir con la llamada real
            pass
        return response

    send.__wrapped_original__ = original_send  # type: ignore[attr-defined]
    httpx.AsyncClient.send = send
    _installed = True
