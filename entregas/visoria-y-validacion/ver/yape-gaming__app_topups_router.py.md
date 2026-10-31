# router.py

**Repositorio:** `yape-gaming`  
**Ruta:** `app/topups/router.py`

Copia TODO el bloque de abajo y reemplaza el archivo completo.

````python
"""
app/topups/router.py

API interna del motor de recargas: solo la usan otros servicios nuestros
(codes-hub), nunca un cliente final. Autenticación con el header
X-Internal-Key == env INTERNAL_TOPUP_KEY. Sin esa variable, todo responde 503.

  GET  /internal/topups/servers?product_id=&variant_key=
  POST /internal/topups/validate
  POST /internal/topups/execute
  GET  /internal/topups/{consumer}/{request_id}
"""

from __future__ import annotations

import asyncio
import hmac
import logging
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from app.topups.engine import TopupEngine, TopupError

logger = logging.getLogger(__name__)

RECONCILE_INTERVAL_SECONDS = 60
RECONCILE_LOCK_KEY = "topup:reconcile:lock"


class Account(BaseModel):
    user_id: str = Field(min_length=1, max_length=64)
    server: Optional[str] = Field(None, max_length=64)
    zone_id: Optional[str] = Field(None, max_length=64)


class ValidateBody(BaseModel):
    consumer: str = Field(min_length=1, max_length=64)
    product_id: int
    variant_key: str = Field(min_length=1, max_length=64)
    account: Account


class ExecuteBody(BaseModel):
    consumer: str = Field(min_length=1, max_length=64)
    request_id: str = Field(min_length=1, max_length=100)
    validation_id: str = Field(min_length=1, max_length=64)
    role_id: Optional[str] = Field(None, max_length=64)


def _error(e: TopupError) -> JSONResponse:
    return JSONResponse(status_code=e.http_status, content={"error": e.code, "message": e.message})


def build_router(engine: TopupEngine, internal_key: str) -> APIRouter:
    def require_key(x_internal_key: Optional[str] = Header(None)) -> None:
        if not internal_key:
            raise HTTPException(status_code=503, detail={"error": "not_configured", "message": "INTERNAL_TOPUP_KEY no configurada"})
        if not x_internal_key or not hmac.compare_digest(x_internal_key, internal_key):
            raise HTTPException(status_code=401, detail={"error": "unauthorized"})

    # La clave se revisa antes que el body: sin clave nunca se responde 422.
    router = APIRouter(prefix="/internal/topups", dependencies=[Depends(require_key)])

    @router.get("/servers")
    async def servers(product_id: int = Query(...), variant_key: str = Query(...)):
        try:
            return {"servers": await engine.servers(product_id, variant_key)}
        except TopupError as e:
            return _error(e)

    @router.post("/validate")
    async def validate(body: ValidateBody):
        try:
            return await engine.validate(body.consumer, body.product_id, body.variant_key,
                                         body.account.model_dump(exclude_none=True))
        except TopupError as e:
            return _error(e)

    @router.post("/execute")
    async def execute(body: ExecuteBody):
        try:
            return await engine.execute(body.consumer, body.request_id, body.validation_id, body.role_id)
        except TopupError as e:
            return _error(e)

    @router.get("/{consumer}/{request_id}")
    async def get_execution(consumer: str, request_id: str):
        try:
            return await engine.get(consumer, request_id)
        except TopupError as e:
            return _error(e)

    return router


async def reconcile_loop(engine: TopupEngine, redis_client) -> None:
    """Cada minuto revisa recargas en proceso. Con varias réplicas, solo una lo hace (lock en Redis)."""
    while True:
        try:
            if await redis_client.set(RECONCILE_LOCK_KEY, "1", nx=True, ex=RECONCILE_INTERVAL_SECONDS - 5):
                changed = await engine.reconcile_once()
                if changed:
                    logger.info("[Topups] reconciliación: %s recarga(s) actualizada(s)", changed)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[Topups] error en la reconciliación")
        await asyncio.sleep(RECONCILE_INTERVAL_SECONDS)


PRICE_REFRESH_LOCK_KEY = "topup:price-refresh:lock"
PRICE_REFRESH_INTERVAL_SECONDS = 30 * 60


async def price_refresh_loop(engine: TopupEngine, redis_client) -> None:
    """Cada 30 min pone al día los costos de las variantes con respaldo (una réplica a la vez)."""
    await asyncio.sleep(60)   # deja arrancar el servicio
    while True:
        try:
            if await redis_client.set(PRICE_REFRESH_LOCK_KEY, "1", nx=True, ex=PRICE_REFRESH_INTERVAL_SECONDS - 60):
                changed = await engine.refresh_costs_once()
                logger.info("[Topups] costos de proveedores revisados: %s cambiaron", changed)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[Topups] error refrescando costos")
        await asyncio.sleep(PRICE_REFRESH_INTERVAL_SECONDS)
````
