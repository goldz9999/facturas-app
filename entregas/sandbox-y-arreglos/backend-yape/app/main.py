"""
yape-pines
==========

Servicio independiente para la venta de codigos/pines desde el inventario
en Supabase. Expone las rutas SIN prefijo (/auth/, /game/) tal cual las
tiene configuradas Yape en produccion segun Endpoints.md - NO CAMBIAR
esas rutas ni el formato de sus respuestas, Yape ya las tiene integradas.

Antes este servicio vivia combinado con /gaming (recargas Coda) en un
solo deploy (yape-gateway). Se separaron para que un problema en el
codigo de gaming no pueda tumbar la venta de pines, y viceversa.
El servicio de gaming vive ahora en su propio repo/deploy: yape-gaming.

Variables de entorno requeridas:
    SUPABASE_URL
    SUPABASE_SERVICE_KEY
    YAPE_GATEWAY_JWT_SECRET
"""

import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    stream=sys.stdout,
)

import os
import asyncio
import time
import hmac
import hashlib
import base64
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Optional, Any

import httpx
import bcrypt
import redis.asyncio as redis
from fastapi import FastAPI, APIRouter, Header, HTTPException, Request
from pydantic import BaseModel
from supabase import create_client, Client

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("yape-gateway")

app = FastAPI(title="yape-pines")


# ════════════════════════════════════════════════════════════════════════
#  Alerta de stock bajo (push FCM) — copia autocontenida
#  ────────────────────────────────────────────────────────────────────
#  Este servicio vive en un repo/deploy separado del backend de gift-cards
#  (ver docstring arriba), así que NO puede importar
#  app.services.inventory_stock_alert_service de ese otro repo.
#  Usa la MISMA base de Supabase (mismas tablas products,
#  inventory_stock_alerts, device_push_tokens), así que se duplica aquí
#  una versión mínima de la misma lógica en vez de depender del otro repo.
#  Si cambias la regla en un lado, replícala en el otro.
# ════════════════════════════════════════════════════════════════════════

import firebase_admin
from firebase_admin import credentials as _fb_credentials, messaging as _fb_messaging

_firebase_app = None

# Horas UTC en las que corre el ciclo de reposición automática (Celery beat,
# ver app/celery_app.py del backend de gift-cards: crontab hour=13/15/18/21/1,
# minute=0). Si cambias el schedule allá, actualiza esta lista también.
REPLENISHMENT_UTC_HOURS = [1, 6, 15, 18, 21]


def _next_replenishment_eta() -> str:
    now = datetime.now(timezone.utc)
    current_minutes = now.hour * 60 + now.minute
    slots = sorted(h * 60 for h in REPLENISHMENT_UTC_HOURS)
    upcoming = [s for s in slots if s > current_minutes]
    next_minutes = upcoming[0] if upcoming else slots[0] + 24 * 60
    delta = next_minutes - current_minutes
    hours, minutes = divmod(delta, 60)
    if hours and minutes:
        return f"en {hours}h {minutes}min"
    if hours:
        return f"en {hours}h"
    return f"en {minutes}min"


def _replenishment_line(auto_replenish: bool) -> str:
    if auto_replenish:
        return f"🤖 Reposición automática: {_next_replenishment_eta()}"
    return "⚡ Reposición manual — necesita tu acción"


def _get_firebase_app():
    global _firebase_app
    if _firebase_app is not None:
        return _firebase_app
    raw = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "")
    if not raw:
        raise RuntimeError("FIREBASE_SERVICE_ACCOUNT_JSON no está configurado")
    cred = _fb_credentials.Certificate(json.loads(raw))
    _firebase_app = firebase_admin.initialize_app(cred, name="yape-pines")
    return _firebase_app


def _send_push_to_all(title: str, body: str, data: dict | None = None) -> None:
    tokens_resp = supabase.table("device_push_tokens").select("token").execute()
    tokens = [row["token"] for row in (tokens_resp.data or []) if row.get("token")]
    if not tokens:
        return
    app_fb = _get_firebase_app()
    message = _fb_messaging.MulticastMessage(
        notification=_fb_messaging.Notification(title=title, body=body),
        data={k: str(v) for k, v in (data or {}).items()},
        tokens=tokens,
    )
    try:
        resp = _fb_messaging.send_each_for_multicast(message, app=app_fb)
        invalid = [
            tokens[i] for i, r in enumerate(resp.responses)
            if not r.success and getattr(r.exception, "code", "") in
            ("UNREGISTERED", "INVALID_ARGUMENT")
        ]
        if invalid:
            supabase.table("device_push_tokens").delete().in_("token", invalid).execute()
    except Exception:
        logger.exception("[yape] error enviando push FCM")


async def check_and_notify_stock(product_id: int) -> None:
    prod_resp = supabase.table("products") \
        .select("id, name, product_type, inv_replenish_threshold, inv_notifications_enabled, inv_auto_replenish") \
        .eq("id", product_id).limit(1).execute()
    if not prod_resp.data:
        return
    product = prod_resp.data[0]

    if product.get("product_type") == "coda_topup":
        return
    if not product.get("inv_notifications_enabled", True):
        return

    threshold = product.get("inv_replenish_threshold") or 0
    if threshold <= 0:
        return

    stock_resp = supabase.table("inventory_codes") \
        .select("id", count="exact") \
        .eq("product_id", product_id).eq("status", "available").execute()
    stock = stock_resp.count or 0

    alert_resp = supabase.table("inventory_stock_alerts") \
        .select("last_notified_stock").eq("product_id", product_id).limit(1).execute()
    last_notified = alert_resp.data[0]["last_notified_stock"] if alert_resp.data else None

    if stock > threshold:
        if last_notified is not None:
            supabase.table("inventory_stock_alerts").delete().eq("product_id", product_id).execute()
        return

    if last_notified is not None and stock >= last_notified:
        return

    supabase.table("inventory_stock_alerts").upsert(
        {"product_id": product_id, "last_notified_stock": stock, "threshold": threshold},
        on_conflict="product_id",
    ).execute()

    auto_replenish = product.get("inv_auto_replenish", False)
    body = f"Stock: {stock} (umbral: {threshold})\n{_replenishment_line(auto_replenish)}"

    _send_push_to_all(
        title=f"⚠️ {product.get('name', 'Producto')}: Stock bajo",
        body=body,
        data={"type": "low_stock", "product_id": product_id, "stock": stock, "threshold": threshold},
    )


# ════════════════════════════════════════════════════════════════════════
#  Aviso de venta al backend de gift-cards (reposición por umbral)
#  ────────────────────────────────────────────────────────────────────
#  Avisa al instante, igual que Eneba/G2A/Falabella, para que los productos
#  en modo "Por umbral" se repongan sin esperar el barrido periódico.
#  - Se envía en segundo plano: NUNCA retrasa ni afecta la venta.
#  - Si falla o el backend no responde, no pasa nada: el barrido periódico
#    del backend detecta la venta igual.
#  - Sin GIFTCARDS_API_URL o REPLENISH_NOTIFY_KEY configuradas, no hace nada.
# ════════════════════════════════════════════════════════════════════════

GIFTCARDS_API_URL = os.environ.get("GIFTCARDS_API_URL", "").rstrip("/")
REPLENISH_NOTIFY_KEY = os.environ.get("REPLENISH_NOTIFY_KEY", "")
_notify_tasks: set = set()   # referencia a las tareas en curso (evita que se pierdan)


async def _send_replenishment_notice(product_id: int) -> None:
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            r = await client.post(
                f"{GIFTCARDS_API_URL}/api/internal/replenishment/notify-sale",
                json={"product_ids": [product_id], "channel": "yape"},
                headers={"X-Replenish-Key": REPLENISH_NOTIFY_KEY},
            )
        if r.status_code != 200:
            logger.warning("[yape] aviso de reposición respondió %s: %s", r.status_code, r.text[:200])
    except Exception as e:
        logger.warning("[yape] no se pudo avisar la venta para reposición (lo detectará el barrido): %s", e)


def _notify_replenishment(product_id: int) -> None:
    if not GIFTCARDS_API_URL or not REPLENISH_NOTIFY_KEY:
        return
    try:
        task = asyncio.create_task(_send_replenishment_notice(product_id))
        _notify_tasks.add(task)
        task.add_done_callback(_notify_tasks.discard)
    except Exception:
        logger.exception("[yape] no se pudo programar el aviso de reposición")


# ════════════════════════════════════════════════════════════════════════
#  /pines  — venta de codigos (igual logica que yape-gateway.py original)
# ════════════════════════════════════════════════════════════════════════

pines_router = APIRouter()

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
PINES_JWT_SECRET = os.environ["YAPE_GATEWAY_JWT_SECRET"]
PINES_CHANNEL = "yape"
PINES_TOKEN_TTL_SECONDS = 180  # 3 min, igual que el original (venta de pines, no gaming)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def issue_pines_token() -> str:
    payload = json.dumps({"exp": int(time.time()) + PINES_TOKEN_TTL_SECONDS}).encode()
    payload_b64 = _b64url(payload)
    sig = hmac.new(PINES_JWT_SECRET.encode(), payload_b64.encode(), hashlib.sha256).digest()
    return f"{payload_b64}.{_b64url(sig)}"


def validate_pines_token(token: str) -> bool:
    try:
        payload_b64, sig_b64 = token.split(".")
        expected_sig = _b64url(hmac.new(PINES_JWT_SECRET.encode(), payload_b64.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(sig_b64, expected_sig):
            return False
        payload = json.loads(base64.urlsafe_b64decode(payload_b64 + "=="))
        return int(payload["exp"]) > int(time.time())
    except Exception:
        return False


def require_pines_bearer(authorization: Optional[str]) -> None:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail={"success": False, "data": "Missing bearer token"})
    token = authorization[len("Bearer "):].strip()
    if not validate_pines_token(token):
        raise HTTPException(status_code=401, detail={"success": False, "data": "Invalid or expired token"})


@pines_router.post("/auth")
async def pines_auth(request: Request):
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Basic "):
        raise HTTPException(status_code=401, detail={"success": False, "data": "Missing Basic Auth"})
    try:
        decoded = base64.b64decode(auth_header[len("Basic "):]).decode()
        username, password = decoded.split(":", 1)
    except Exception:
        raise HTTPException(status_code=401, detail={"success": False, "data": "Malformed Basic Auth"})

    creds = supabase.table("gateway_credentials") \
        .select("username, password_hash") \
        .eq("channel", PINES_CHANNEL).limit(1).execute()

    if not creds.data:
        raise HTTPException(status_code=401, detail={"success": False, "data": "No credentials configured"})

    row = creds.data[0]
    valid = hmac.compare_digest(username, row["username"]) and \
        bcrypt.checkpw(password.encode(), row["password_hash"].encode())

    if not valid:
        raise HTTPException(status_code=401, detail={"success": False, "data": "Invalid credentials"})

    return {"token": issue_pines_token()}


@pines_router.get("/game")
async def pines_list_games(authorization: Optional[str] = Header(None)):
    require_pines_bearer(authorization)

    listings = supabase.table("channel_listings") \
        .select("id, product_id, external_id") \
        .eq("channel", PINES_CHANNEL) \
        .eq("is_active", True) \
        .execute().data or []

    available = []
    for listing in listings:
        if not listing.get("external_id"):
            continue
        count = supabase.table("inventory_codes") \
            .select("id", count="exact") \
            .eq("product_id", listing["product_id"]) \
            .eq("status", "available") \
            .execute()
        if (count.count or 0) > 0:
            available.append(listing["external_id"])

    return {"success": True, "data": available}


class SellRequest(BaseModel):
    productId: str
    externalPaymentId: str
    externalClientId: str


@pines_router.post("/game")
async def pines_sell(body: SellRequest, authorization: Optional[str] = Header(None)):
    require_pines_bearer(authorization)

    listing_res = supabase.table("channel_listings") \
        .select("product_id, sell_price") \
        .eq("channel", PINES_CHANNEL) \
        .eq("external_id", body.productId) \
        .eq("is_active", True) \
        .limit(1).execute()

    if not listing_res.data:
        return {"success": False, "data": "ProductId not found"}

    listing = listing_res.data[0]
    product_id = listing["product_id"]
    order_id = f"{body.externalPaymentId}"

    existing = supabase.table("inventory_codes") \
        .select("id, code") \
        .eq("order_id", order_id) \
        .eq("status", "sold") \
        .limit(1).execute()


    if existing.data:
        remaining = supabase.table("inventory_codes") \
            .select("id", count="exact") \
            .eq("product_id", product_id) \
            .eq("status", "available") \
            .execute()
        return {"success": True, "data": existing.data[0]["code"], "count": remaining.count or 0}

    try:
        claimed = supabase.rpc("claim_inventory_codes", {
            "p_product_id": product_id,
            "p_quantity": 1,
            "p_order_id": order_id,
        }).execute()
    except Exception:
        logger.exception("claim_inventory_codes failed")
        return {"success": False, "data": "Pin not available or Out of Stock"}

    rows = claimed.data or []
    if not rows:
        return {"success": False, "data": "Pin not available or Out of Stock"}

    code_row = rows[0]
    update_data = {
        "status": "sold",
        "sold_to_channel": PINES_CHANNEL,
        "sold_at": datetime.now(timezone.utc).isoformat(),
        "order_id": order_id,
        "sold_price": listing.get("sell_price"),
        "sold_currency": "PEN",
        # Guardamos el ID del cliente Yape (externalClientId) en metadata
        # para poder mostrarlo en el historial de ventas del panel.
        "metadata": {"client_id": body.externalClientId},
    }
    supabase.table("inventory_codes").update(update_data).eq("id", code_row["id"]).execute()

    try:
        await check_and_notify_stock(product_id)
    except Exception:
        logger.exception("no se pudo evaluar alerta de stock tras venta Yape")

    _notify_replenishment(product_id)

    remaining = supabase.table("inventory_codes") \
        .select("id", count="exact") \
        .eq("product_id", product_id) \
        .eq("status", "available") \
        .execute()

    return {"success": True, "data": code_row.get("code"), "count": remaining.count or 0}



app.include_router(pines_router)


@app.get("/healthz")
async def healthz():
    return {"ok": True}