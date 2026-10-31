# UBICACIÓN EN TU REPO: fastapi-gift-cards/app/services/eneba_declared_stock_service.py
# (repositorio: fastapi-gift-cards · ruta: app/services/eneba_declared_stock_service.py)
"""
app/services/eneba_declared_stock_service.py

Flujo Declared Stock con Eneba (PRODUCCIÓN):

  RESERVATION  → valida mapeo en channel_listings + proveedor activo
               → registra sesión en eneba_order_sessions
               → guarda metadatos en Redis
               → siempre responde success: true si el mapeo existe

  PROVISION    → 3 intentos × 120s (Eneba reintenta con 5s de sleep)
               → claim_inventory_codes() atómico toma lo disponible (FOR UPDATE SKIP LOCKED)
               → si faltan → compra EXACTAMENTE el faltante al proveedor
               → códigos comprados se insertan directamente en status='reserved'
                 con order_id desde el inicio — nunca pasan por 'available'
                 → trazabilidad exacta: cada código sabe para qué orden fue comprado
                 → imposible que otra orden los tome
               → solo deshabilita el auction tras el 3er fallo

  CANCELLATION → borra Redis
               → pre-provision: libera códigos 'reserved' de vuelta a 'available'
               → post-provision: Eneba gestiona las keys, no recuperar

  Estados de inventory_codes:
    available  | order_id=null  → stock pre-existente, para cualquier orden
    reserved   | order_id=X     → asignado a orden X (inventario previo o recién comprado)
    sold       | order_id=X     → entregado a Eneba para orden X
"""

import os
import time
import httpx
import asyncio
import json
import traceback
from typing import Dict, Any, List, Optional
from datetime import datetime, timedelta

from app.providers.cardone_client import get_cardone_client
from app.providers.ez_client import EZClient
from app.providers.bamboo_client import BambooClient
from app.providers import wgcards_client as wg
from app.core.database import supabase
from app.services.provider_selector import ProviderSelector, SelectionStrategy
from contextvars import ContextVar

# True si el último intento de compra en tiempo real falló SIN cobro (p. ej.
# TISI rechazó la venta con código 99). Permite que un reintento de Eneba
# vuelva a intentar la compra (ver _get_codes_for_auction).
_RT_SAFE_FAIL: ContextVar[bool] = ContextVar("_RT_SAFE_FAIL", default=False)
SAFE_RETRY_KEY = "eneba:provision_safe_retry:{order_id}:{auction_id}"


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_reservation_ttl() -> int:
    now = datetime.utcnow()
    current = now
    counted = 0
    while counted < 3:
        current += timedelta(days=1)
        if current.weekday() < 5:
            counted += 1
    return int((current - now).total_seconds())


def _is_sandbox() -> bool:
    return os.getenv("ENEBA_ENV", "production").lower() == "sandbox"


def _err(action: str, order_id: str, msg: str) -> dict:
    return {"action": action, "orderId": order_id, "success": False, "errorMessage": msg}


_fx_cache: dict = {"rates": None, "fetched_at": 0.0}
_FX_TTL = 6 * 3600


async def _get_eur_to_usd() -> float:
    now = time.time()
    if _fx_cache["rates"] and now - _fx_cache["fetched_at"] < _FX_TTL:
        return _fx_cache["rates"].get("USD", 1.09)
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.get("https://api.exchangerate-api.com/v4/latest/EUR")
            data = r.json()
            _fx_cache["rates"] = data.get("rates", {})
            _fx_cache["fetched_at"] = now
            return _fx_cache["rates"].get("USD", 1.09)
    except Exception:
        return 1.09


# ═════════════════════════════════════════════════════════════════════════════

class EnebaDeclaredStockService:

    def __init__(self):
        self.selector = ProviderSelector()

    # ── Redis — metadatos de reserva ──────────────────────────────
    #
    # Todas las operaciones pasan por redis_execute(): si la conexión quedó
    # muerta (Redis/red de Railway la cerró por inactividad → error
    # "TCPTransport closed... handler is closed"), se reconecta y reintenta.
    # Antes un solo fallo hacía que la reserva no se guardara y el pago
    # posterior respondiera "Reserva no encontrada" (orden 4095c0ee).

    async def _save_reservation(self, order_id: str, data: dict) -> bool:
        from app.core.redis_client import redis_execute
        try:
            await redis_execute(lambda r: r.set(f"eneba:reservation:{order_id}", json.dumps(data),
                                                ex=_get_reservation_ttl()))
            return True
        except Exception as e:
            print(f"   ⚠️  Redis save error (tras reintentos): {e}")
            return False

    async def _get_reservation(self, order_id: str) -> Optional[dict]:
        from app.core.redis_client import redis_execute
        try:
            raw = await redis_execute(lambda r: r.get(f"eneba:reservation:{order_id}"))
            return json.loads(raw) if raw else None
        except Exception as e:
            print(f"   ⚠️  Redis get error (tras reintentos): {e}")
            return None

    async def _delete_reservation(self, order_id: str) -> None:
        from app.core.redis_client import redis_execute
        try:
            await redis_execute(lambda r: r.delete(f"eneba:reservation:{order_id}"))
        except Exception as e:
            print(f"   ⚠️  Redis delete error: {e}")

    def _reservation_from_db(self, order_id: str) -> Optional[dict]:
        """
        Respaldo si la reserva no está en Redis: se reconstruye desde
        eneba_order_sessions, que se escribe en la base en el mismo RESERVE.
        Solo para sesiones que siguen esperando entrega (provide_status
        PENDING): nunca para órdenes canceladas o ya entregadas.
        """
        try:
            rows = supabase.table("eneba_order_sessions") \
                .select("auction_id, key_count, price_amount, price_currency, original_order_id, "
                        "provide_status, reserve_received_at") \
                .eq("order_id", order_id) \
                .execute().data or []
        except Exception as e:
            print(f"   ⚠️  No se pudo leer eneba_order_sessions para {order_id}: {e}")
            return None
        if not rows or any(r.get("provide_status") != "PENDING" for r in rows):
            return None
        return {
            "auctions": [
                {"auctionId": r["auction_id"], "keyCount": int(r.get("key_count") or 1),
                 "price": {"amount": r.get("price_amount"), "currency": r.get("price_currency") or "EUR"}}
                for r in rows
            ],
            "original_order_id": rows[0].get("original_order_id"),
            "reserved_at": rows[0].get("reserve_received_at"),
            "provision_attempts": 0,
            "restored_from_db": True,
        }

    # ── Redis — tracking de intentos de provision ─────────────────

    async def _save_provision_attempt(self, key: str) -> None:
        from app.core.redis_client import redis_execute
        try:
            await redis_execute(lambda r: r.set(key, "1", ex=600))
        except Exception as e:
            print(f"   ⚠️  Redis provision_attempt save error: {e}")

    async def _allow_safe_retry(self, order_id: str, auction_id: str) -> None:
        from app.core.redis_client import redis_execute
        key = SAFE_RETRY_KEY.format(order_id=order_id, auction_id=auction_id)
        try:
            await redis_execute(lambda r: r.set(key, "1", ex=3600))
        except Exception as e:
            print(f"   ⚠️ no se pudo marcar reintento seguro: {e}")

    async def _take_safe_retry(self, order_id: str, auction_id: str) -> bool:
        """Consume la marca (una compra por marca): True si se puede volver a comprar."""
        from app.core.redis_client import redis_execute
        key = SAFE_RETRY_KEY.format(order_id=order_id, auction_id=auction_id)
        try:
            return bool(await redis_execute(lambda r: r.delete(key)))
        except Exception:
            return False   # sin Redis no se arriesga: comportamiento anterior

    async def _get_provision_attempt(self, key: str) -> bool:
        from app.core.redis_client import redis_execute
        try:
            return (await redis_execute(lambda r: r.exists(key))) > 0
        except Exception as e:
            print(f"   ⚠️  Redis provision_attempt get error: {e}")
            return False

    # ── RESERVATION ───────────────────────────────────────────────

    async def handle_reservation(self, data: dict) -> dict:
        order_id          = data.get("orderId")
        original_order_id = data.get("originalOrderId")

        if _is_sandbox():
            return {"action": "RESERVE", "orderId": order_id, "success": True}

        auctions = data.get("auctions", [])
        if not auctions:
            return _err("RESERVE", order_id, "No auctions")

        for auction_entry in auctions:
            auction_id = auction_entry.get("auctionId")
            key_count  = int(auction_entry.get("keyCount", 1))
            price      = auction_entry.get("price", {})

            valid = await self._validate_channel_listing(auction_id)
            if not valid:
                return _err("RESERVE", order_id, f"Sin proveedor para {auction_id}")

            cl = supabase.table("channel_listings") \
                .select("product_id") \
                .eq("external_auction_id", auction_id) \
                .eq("channel", "eneba") \
                .limit(1).execute()

            product_id = cl.data[0]["product_id"] if cl.data else None

            available = 0
            if product_id:
                available = supabase.table("inventory_codes") \
                    .select("id", count="exact") \
                    .eq("product_id", product_id) \
                    .eq("status", "available") \
                    .execute().count or 0

            try:
                supabase.table("eneba_order_sessions").insert({
                    "order_id":            order_id,
                    "original_order_id":   original_order_id,
                    "auction_id":          auction_id,
                    "product_id":          product_id,
                    "key_count":           key_count,
                    "reserved_count":      min(available, key_count),
                    "missing_count":       max(0, key_count - available),
                    "reserve_status":      "COMPLETED",
                    "provide_status":      "PENDING",
                    "price_amount":        price.get("amount"),
                    "price_currency":      price.get("currency", "EUR"),
                    "reserve_received_at": datetime.utcnow().isoformat(),
                }).execute()
            except Exception as e:
                print(f"   ⚠️  eneba_order_sessions insert error: {e}")

        saved = await self._save_reservation(order_id, {
            "auctions":          auctions,
            "original_order_id": original_order_id,
            "reserved_at":       datetime.utcnow().isoformat(),
            "provision_attempts": 0,
        })
        if not saved:
            # La sesión ya está en eneba_order_sessions: el PROVIDE la
            # reconstruye desde la base. Solo se avisa para revisar Redis.
            try:
                from app.services.telegram_service import telegram
                await telegram.broadcast(
                    f"⚠️ <b>Eneba</b>: no se pudo guardar la reserva <code>{order_id}</code> en Redis "
                    f"tras varios intentos. Se usará la copia de la base de datos al momento del pago. "
                    f"Revisa el servicio Redis en Railway."
                )
            except Exception:
                pass

        return {"action": "RESERVE", "orderId": order_id, "success": True}

    # ── PROVISION ─────────────────────────────────────────────────

    async def handle_provision(self, data: dict) -> dict:
        order_id    = data.get("orderId")
        reservation = await self._get_reservation(order_id)
        if not reservation:
            reservation = self._reservation_from_db(order_id)
            if reservation:
                print(f"   ♻️  Reserva {order_id} no estaba en Redis — reconstruida desde eneba_order_sessions")
                await self._save_reservation(order_id, reservation)
        if not reservation:
            return _err("PROVIDE", order_id, "Reserva no encontrada")

        auctions     = data.get("auctions") or reservation.get("auctions", [])
        auctions_out = []

        for auction_entry in auctions:
            auction_id = auction_entry.get("auctionId")
            key_count  = int(auction_entry.get("keyCount", 1))

            attempt_key = f"eneba:provision_attempt:{order_id}:{auction_id}"
            is_retry    = await self._get_provision_attempt(attempt_key)

            try:
                supabase.table("eneba_order_sessions") \
                    .update({"provide_received_at": datetime.utcnow().isoformat()}) \
                    .eq("order_id", order_id) \
                    .eq("auction_id", auction_id) \
                    .is_("provide_received_at", "null") \
                    .execute()
            except Exception:
                pass

            try:
                codes = await asyncio.wait_for(
                    self._get_codes_for_auction(auction_id, key_count, order_id, skip_purchase=is_retry),
                    timeout=115.0,
                )
            except asyncio.TimeoutError:
                await self._save_provision_attempt(attempt_key)
                codes = []

            if not codes:
                await self._save_provision_attempt(attempt_key)
                attempts = reservation.get("provision_attempts", 0) + 1
                reservation["provision_attempts"] = attempts
                await self._save_reservation(order_id, reservation)

                if attempts >= 3:
                    await self._disable_auction_on_failure(auction_id, order_id)
                    try:
                        supabase.table("eneba_order_sessions") \
                            .update({
                                "provide_status": "FAILED",
                                "failed_at":      datetime.utcnow().isoformat(),
                                "failure_reason": f"Sin códigos tras {attempts} intentos",
                            }) \
                            .eq("order_id", order_id) \
                            .eq("auction_id", auction_id) \
                            .execute()
                    except Exception:
                        pass

                return _err("PROVIDE", order_id, f"Sin códigos — intento {attempts}/3")

            auctions_out.append({"auctionId": auction_id, "keys": await self._build_keys(codes)})

        try:
            supabase.table("eneba_order_sessions") \
                .update({
                    "provide_status": "COMPLETED",
                    "provided_count": sum(int(a.get("keyCount", 1)) for a in auctions),
                    "completed_at":   datetime.utcnow().isoformat(),
                }) \
                .eq("order_id", order_id) \
                .execute()
        except Exception:
            pass

        await self._delete_reservation(order_id)

        return {"action": "PROVIDE", "orderId": order_id, "success": True, "auctions": auctions_out}

    # ── CANCELLATION ──────────────────────────────────────────────

    async def handle_cancellation(self, data: dict) -> None:
        order_id = data.get("orderId")
        print(f"\n🚫 CANCELLATION  orderId={order_id}")
        if not order_id:
            return

        await self._delete_reservation(order_id)
        print(f"   🗑️  Reserva eliminada  orderId={order_id}")

        try:
            session = supabase.table("eneba_order_sessions") \
                .select("provide_status") \
                .eq("order_id", order_id) \
                .limit(1).execute()

            provide_status = session.data[0]["provide_status"] if session.data else "PENDING"

            if provide_status == "COMPLETED":
                # Post-provision: códigos ya entregados, Eneba los gestiona
                # No recuperar al inventario
                print(f"   ℹ️  Post-provision — códigos ya entregados, Eneba los gestiona")
            else:
                # Pre-provision: puede haber códigos en 'reserved' si el claim
                # se ejecutó parcialmente antes de la cancelación — devolverlos
                try:
                    released = supabase.table("inventory_codes") \
                        .update({
                            "status":      "available",
                            "order_id":    None,
                            "reserved_at": None,
                        }) \
                        .eq("order_id", order_id) \
                        .eq("status", "reserved") \
                        .execute()
                    count = len(released.data or [])
                    if count:
                        print(f"   🔓 {count} código(s) devueltos a available")
                    else:
                        print(f"   ℹ️  Pre-provision — no había códigos reservados")
                except Exception as e:
                    print(f"⚠️  Error liberando inventory_codes: {e}")

            supabase.table("eneba_order_sessions") \
                .update({"provide_status": "CANCELLED", "updated_at": datetime.utcnow().isoformat()}) \
                .eq("order_id", order_id) \
                .execute()
        except Exception as e:
            print(f"⚠️  Error actualizando sesión: {e}")

        try:
            result = supabase.table("orders") \
                .update({"status": "CANCELLED", "updated_at": datetime.utcnow().isoformat()}) \
                .eq("request_id", order_id) \
                .execute()
            if result.data:
                print(f"   ✅ Orden CANCELLED en Supabase  orderId={order_id}")
            else:
                print(f"   ℹ️  Sin orden en BD (cancelada antes del provision)")
        except Exception as e:
            print(f"⚠️  Error actualizando orders: {e}")

    # ── Deshabilitar auction ───────────────────────────────────────

    async def _disable_auction_on_failure(self, auction_id: str, order_id: str):
        from app.providers.eneba_graphql_client import get_eneba_client
        client = get_eneba_client()
        try:
            await client.execute_query(
                "mutation DisableDS($input: P_API_UpdateDeclaredStockInput!) { P_updateDeclaredStock(input: $input) { success } }",
                {"input": {"statuses": [{"auctionId": auction_id, "declaredStock": None}]}}
            )
            await client.execute_query(
                "mutation DisableAuction($auctionId: S_Uuid!) { S_updateAuction(input: { id: $auctionId, enabled: false, declaredStock: null }) { success actionId } }",
                {"auctionId": auction_id}
            )
            print(f"🔴 Auction {auction_id} desactivado — orderId={order_id}")

            supabase.table("auction_failures").insert({
                "auction_id":  auction_id,
                "order_id":    order_id,
                "reason":      "provision_failed_3_attempts",
                "disabled_at": datetime.utcnow().isoformat(),
            }).execute()

            from app.services.telegram_service import telegram
            await telegram.broadcast(
                f"🔴 <b>AUCTION DESACTIVADO — 3 intentos fallidos</b>\n\n"
                f"🎮 auction_id: <code>{auction_id}</code>\n"
                f"📋 order_id:   <code>{order_id}</code>\n"
                f"🕐 <b>{datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')} UTC</b>\n\n"
                f"⚠️ Revisar inventory_codes y proveedores."
            )
        except Exception as e:
            print(f"⚠️ Error desactivando auction {auction_id}: {e}")

        # ── Alerta: piden más códigos de los que hay disponibles ───────

    async def _notify_insufficient_codes(
        self,
        product_id: int,
        order_id: str,
        requested: int,
        available: int,
        missing: int,
    ) -> None:
        """
        Se piden `requested` códigos y solo había `available`. No es un
        tema de reservas — es que no hay suficiente stock real y tampoco
        se pudo cubrir comprando al proveedor. Avisa por Telegram y por
        notificación web/Android (misma distribución que el resto del
        sistema) para que el admin pueda cargar más códigos manualmente.
        """
        try:
            prod = supabase.table("products").select("name").eq("id", product_id).limit(1).execute()
            product_name = (prod.data[0]["name"] if prod.data else f"Producto #{product_id}")
        except Exception:
            product_name = f"Producto #{product_id}"

        title = f"⚠️ {product_name}: Stock insuficiente"
        body = (
            f"Se pidieron {requested} código(s) y solo había {available} disponible(s) "
            f"(faltan {missing}). Orden: {order_id}."
        )

        try:
            from app.services.telegram_service import telegram
            await telegram.broadcast(
                f"⚠️ STOCK INSUFICIENTE\n\n"
                f"📦 <b>{product_name}</b>\n"
                f"📋 order_id: <code>{order_id}</code>\n\n"
                f"Pedidos: <b>{requested}</b>\n"
                f"Disponibles: <b>{available}</b>\n"
                f"Faltan: <b>{missing}</b>\n\n"
                f"No se pudo completar la entrega. Carga más códigos de este producto."
            )
        except Exception as e:
            print(f"   ⚠️  no se pudo enviar alerta Telegram de stock insuficiente: {e}")

        try:
            from app.core.push import send_push_to_all
            send_push_to_all(
                title=title,
                body=body,
                data={
                    "type": "insufficient_stock",
                    "product_id": product_id,
                    "order_id": order_id,
                    "requested": requested,
                    "available": available,
                    "missing": missing,
                },
            )
        except Exception as e:
            print(f"   ⚠️  no se pudo enviar push/notificación de stock insuficiente: {e}")

    # ── Core: obtener códigos ─────────────────────────────────────

    async def _get_codes_for_auction(
        self,
        auction_id:    str,
        key_count:     int,
        order_id:      str,
        skip_purchase: bool = False,
    ) -> List[dict]:
        """
        Flujo:
          1. claim_inventory_codes() — toma atómicamente lo que hay disponible
          2. Si faltan Y es primer intento → comprar exactamente el faltante
             → insertar directamente en status='reserved' con order_id
             → nunca pasan por 'available' → trazabilidad exacta
          3. Si faltan Y es reintento → esperar 10s y reclamar lo que llegó
          4. Si algo falla → liberar los ya reclamados (_release_claimed)
          5. Marcar como sold en background
        """
        try:
            # 1. Resolver product_id.
            # OJO: no se filtra por is_active aquí — este método entrega
            # códigos de una reserva que YA fue aceptada antes (reservation
            # callback). Si mientras tanto el auto-disable apagó el canal,
            # la orden ya comprometida igual debe poder entregarse; solo
            # las reservas NUEVAS deben bloquearse (eso ya lo hace
            # handle_reservation() / _validate_channel_listing() más arriba).
            cl = supabase.table("channel_listings") \
                .select("product_id") \
                .eq("external_auction_id", auction_id) \
                .eq("channel", "eneba") \
                .limit(1).execute()

            if not cl.data:
                print(f"   ❌ Sin mapeo para auction={auction_id}")
                return []

            product_id = cl.data[0]["product_id"]

            # 2. Reclamar atómicamente lo que hay disponible ahora
            claimed = supabase.rpc("claim_inventory_codes", {
                "p_product_id": product_id,
                "p_quantity":   key_count,
                "p_order_id":   order_id,
            }).execute()

            claimed_codes = claimed.data or []
            faltante      = key_count - len(claimed_codes)
            print(f"   📦 Reclamados: {len(claimed_codes)}/{key_count} | Faltante: {faltante}")

            _purchase_log: list[dict] = []

            # 3. ¿Faltan códigos?
            if faltante > 0:
                do_buy = not skip_purchase
                if skip_purchase:
                    # Reintento — esperar por si la compra anterior aún procesa
                    print(f"   🔄 Reintento — esperando 10s...")
                    await asyncio.sleep(10)

                    extra = supabase.rpc("claim_inventory_codes", {
                        "p_product_id": product_id,
                        "p_quantity":   faltante,
                        "p_order_id":   order_id,
                    }).execute()

                    claimed_codes += extra.data or []
                    faltante = key_count - len(claimed_codes)

                    if faltante > 0:
                        if await self._take_safe_retry(order_id, auction_id):
                            # La compra anterior falló SIN cobro (el proveedor
                            # rechazó la venta): es seguro volver a intentarla.
                            print(f"   🔁 La compra anterior falló sin cobro — reintentando compra")
                            do_buy = True
                        else:
                            await self._release_claimed(claimed_codes)
                            print(f"   ❌ Aún faltan {faltante} códigos tras espera")
                            return []

                if do_buy:
                    # Primer intento (o reintento seguro) — comprar exactamente el faltante
                    print(f"   ⚡ Comprando {faltante} al proveedor...")

                    result = await self.selector.get_best_provider_by_auction(
                        auction_id, SelectionStrategy.MOST_RELIABLE
                    )
                    if not result["success"]:
                        await self._release_claimed(claimed_codes)
                        print(f"   ❌ Sin proveedor: {result['error']}")
                        asyncio.create_task(self._notify_insufficient_codes(
                            product_id, order_id, key_count, len(claimed_codes), faltante
                        ))
                        return []

                    mapping       = result["mapping"]
                    provider      = result["provider"]
                    product       = result["product"]
                    all_suppliers = [mapping] + result.get("alternatives", [])
                    comprado      = False

                    all_safe      = True   # ¿todos los intentos fallaron sin cobro?
                    for supplier in all_suppliers:
                        p_code = (supplier.get("provider") or {}).get("code") or provider["code"]
                        p_sku  = supplier.get("provider_sku") or mapping["provider_sku"]
                        p_id   = supplier.get("provider_id") or provider["id"]
                        p_name = (supplier.get("provider") or {}).get("name") or provider["name"]

                        print(f"   🛒 {p_name} SKU={p_sku} x{faltante}")
                        raw_codes = await self._purchase_from_provider(
                            p_code, p_sku, faltante, order_id,
                            supplier.get("metadata") or mapping.get("metadata"),
                        )

                        if not raw_codes:
                            all_safe = all_safe and _RT_SAFE_FAIL.get()
                            print(f"   ⚠️  {p_name} falló, probando siguiente...")
                            continue

                        cost_price = float(
                            supplier.get("cost_price") or mapping.get("cost_price") or 0
                        )
                        # TISI: aplica el % de descuento configurado en el mapeo
                        from app.providers.tisi_client import apply_tisi_discount
                        cost_price = apply_tisi_discount(
                            cost_price,
                            supplier.get("metadata") or mapping.get("metadata"),
                            p_code,
                        )

                        # Insertar directamente en 'reserved' con order_id
                        # → nunca pasan por 'available'
                        # → trazabilidad exacta: este código es para esta orden
                        purchased_rows = []
                        for c in raw_codes:
                            if not c.get("code"):
                                continue
                            try:
                                row = supabase.table("inventory_codes").insert({
                                    "product_id":  product_id,
                                    "code":        c["code"],
                                    "pin":         c.get("pin"),
                                    "serial":      c.get("serial"),
                                    "status":      "reserved",
                                    "order_id":    order_id,
                                    "reserved_at": datetime.utcnow().isoformat(),
                                    "source":      "auto_replenishment",
                                    "provider_id": int(p_id),
                                    "cost_price":  cost_price,
                                }).execute()
                                if row.data:
                                    purchased_rows.append(row.data[0])
                            except Exception:
                                pass  # duplicado, ignorar

                        if not purchased_rows:
                            all_safe = False   # se compraron códigos que no se pudieron guardar
                            print(f"   ⚠️  {p_name}: ningún código insertado")
                            continue

                        print(f"   ✅ {len(purchased_rows)} código(s) reservados para order_id={order_id}")
                        claimed_codes += purchased_rows

                        bamboo_order_number  = (raw_codes[0] or {}).get("_bamboo_order_number") if p_code == "bamboo" else None
                        ez_order_number      = order_id if p_code == "ez" else None
                        cardone_order_number = order_id if p_code in ("cardone", "99cards") else None
                        asyncio.create_task(self._save_order(
                            order_id=order_id, provider_id=int(p_id), provider_code=p_code,
                            product_name=product.get("name", ""), provider_sku=p_sku,
                            key_count=faltante, cost_price=cost_price,
                            sell_price=float(mapping.get("sell_price") or 0), codes=raw_codes,
                            bamboo_order_number=bamboo_order_number,
                            ez_order_number=ez_order_number,
                            cardone_order_number=cardone_order_number,
                        ))
                        # Aviso Telegram por compra en tiempo real
                        try:
                            from app.services.telegram_service import telegram
                            _purchase_log.append({
                                "product": product.get("name", f"Producto #{product_id}"),
                                "provider": p_name,
                                "qty": len(purchased_rows),
                                "sku": p_sku,
                            })
                        except Exception:
                            pass

                        comprado = True
                        break

                    if not comprado:
                        await self._release_claimed(claimed_codes)
                        print(f"   ❌ Todos los proveedores fallaron")
                        if all_safe:
                            await self._allow_safe_retry(order_id, auction_id)
                            print(f"   ↩️  Ningún proveedor cobró: el próximo reintento de Eneba volverá a comprar")
                        return []

            # Telegram: resumen de compras en tiempo real (agrupado si varios productos)
            if _purchase_log:
                try:
                    from app.services.telegram_service import telegram
                    lines = [f"⚡ <b>Compra en tiempo real — Eneba</b>\n📋 <code>{order_id}</code>\n"]
                    for item in _purchase_log:
                        lines.append(
                            f"  • <b>{item['product']}</b> × {item['qty']} "
                            f"— {item['provider']} <code>{item['sku']}</code>"
                        )
                    await telegram.broadcast("\n".join(lines))
                except Exception as e:
                    print(f"   ⚠️ no se pudo enviar aviso Telegram de compra: {e}")

            # 4. Marcar como sold en background
            asyncio.create_task(
                self._mark_inventory_sold([r["id"] for r in claimed_codes], order_id, product_id)
            )
            print(f"   ✅ {len(claimed_codes)} código(s) listos para order_id={order_id}")
            return claimed_codes

        except Exception as e:
            print(f"   ❌ _get_codes_for_auction error: {e}")
            traceback.print_exc()
            return []

    async def _release_claimed(self, codes: List[dict]) -> None:
        """
        Libera códigos ya reclamados si la compra o entrega falla.
        Todos vuelven a 'available' — los recién comprados también,
        ya que son códigos válidos pagados al proveedor que pueden
        ser usados por la siguiente orden.
        """
        ids = [r["id"] for r in codes if r.get("id")]
        if not ids:
            return
        try:
            supabase.table("inventory_codes") \
                .update({"status": "available", "order_id": None, "reserved_at": None}) \
                .in_("id", ids) \
                .execute()
            print(f"   🔓 {len(ids)} código(s) devueltos a available")
        except Exception as e:
            print(f"   ⚠️  _release_claimed error: {e}")

    async def _mark_inventory_sold(self, ids: List[int], order_id: str, product_id: int = None) -> None:
        try:
            unit_price = None
            unit_currency = "EUR"
            session = supabase.table("eneba_order_sessions") \
                .select("price_amount, price_currency, key_count") \
                .eq("order_id", order_id) \
                .limit(1).execute()
            if session.data:
                s = session.data[0]
                key_count = s.get("key_count") or 1
                if s.get("price_amount") is not None:
                    # price_amount de Eneba viene en centavos y YA es el precio
                    # por unidad del listing (viene del campo "price" de cada
                    # auction en el webhook RESERVE, no es el total de la orden)
                    # — no dividir por key_count.
                    unit_price = round(float(s["price_amount"]) / 100, 4)
                unit_currency = s.get("price_currency") or "EUR"

            update_data = {
                "status": "sold", "sold_to_channel": "eneba",
                "sold_at": datetime.utcnow().isoformat(), "order_id": order_id,
            }
            if unit_price is not None:
                update_data["sold_price"] = unit_price
                update_data["sold_currency"] = unit_currency

            supabase.table("inventory_codes") \
                .update(update_data) \
                .in_("id", ids).execute()

            if product_id:
                try:
                    from app.services.inventory_stock_alert_service import check_and_notify
                    await check_and_notify([product_id])
                except Exception as alert_err:
                    print(f"   ⚠️  no se pudo evaluar alerta de stock: {alert_err}")
                try:
                    from app.services.eneba_auto_disable_service import check_and_disable_eneba
                    await check_and_disable_eneba(product_id)
                except Exception as disable_err:
                    print(f"   ⚠️  no se pudo evaluar apagado automático de Eneba: {disable_err}")
        except Exception as e:
            print(f"   ⚠️  _mark_inventory_sold error: {e}")

    # ── Build keys — formato Eneba ────────────────────────────────

    async def _build_keys(self, codes: List[dict]) -> List[dict]:
        keys = []
        for item in codes:
            metadata  = item.get("metadata") or {}
            image_b64 = item.get("image_base64") or metadata.get("image_base64")
            if image_b64:
                clean_b64 = image_b64.split(",", 1)[-1] if "," in image_b64 else image_b64
                if clean_b64:
                    keys.append({"type": "IMAGE", "value": clean_b64, "filename": metadata.get("filename", "code.jpg")})
            elif item.get("code"):
                code_val = item["code"].strip()
                if code_val:
                    keys.append({"type": "TEXT", "value": code_val})
        return keys

    # ── Validación ────────────────────────────────────────────────

    async def _validate_channel_listing(self, auction_id: str) -> bool:
        try:
            cl = supabase.table("channel_listings") \
                .select("product_id") \
                .eq("external_auction_id", auction_id) \
                .eq("channel", "eneba") \
                .limit(1).execute()

            if not cl.data:
                print(f"   ❌ Sin channel_listing para auction={auction_id}")
                return False

            product_id = cl.data[0]["product_id"]

            ps = supabase.table("product_suppliers") \
                .select("id") \
                .eq("product_id", product_id) \
                .eq("is_active", True) \
                .eq("is_available", True) \
                .limit(1).execute()

            if ps.data:
                return True

            # Sin proveedor activo: igual permitir si hay stock manual disponible
            inv = supabase.table("inventory_codes") \
                .select("id", count="exact") \
                .eq("product_id", product_id) \
                .eq("status", "available") \
                .execute()

            if (inv.count or 0) > 0:
                print(f"   ℹ️  Sin proveedor activo pero hay {inv.count} códigos en inventario para product_id={product_id}")
                return True

            print(f"   ❌ Sin proveedores activos ni inventario para product_id={product_id}")
            return False
        except Exception as e:
            print(f"   ❌ Error validando channel_listing: {e}")
            return False

    # ── Actualizar precio y stock declarado ───────────────────────

    async def update_price_and_stock(self, auction_id: str, price_eur_cents: int, declared_stock: int) -> dict:
        price_result = await self.execute_query(
            "mutation UpdatePrice($input: P_API_UpdateAuctionPriceInput!) { P_updateAuctionPrice(input: $input) { items { auctionId price { amount currency } success paidForPriceChange error } } }",
            {"input": {"items": [{"auctionId": auction_id, "price": {"amount": price_eur_cents, "currency": "EUR"}, "preventPaidPriceChange": True}]}}
        )
        stock_result = await self.execute_query(
            "mutation UpdateStock($input: P_API_UpdateDeclaredStockInput!) { P_updateDeclaredStock(input: $input) { success } }",
            {"input": {"statuses": [{"auctionId": auction_id, "declaredStock": declared_stock}]}}
        )
        return {"price": price_result, "stock": stock_result}

    # ── Compra por proveedor ──────────────────────────────────────

    async def _purchase_from_provider(self, provider_code: str, provider_sku: str, quantity: int, order_id: str,
                                      supplier_metadata=None) -> List[dict]:
        _RT_SAFE_FAIL.set(False)
        try:
            if provider_code == "bamboo":
                return await self._purchase_bamboo(provider_sku, quantity, order_id)
            elif provider_code == "ez":
                return await self._purchase_ez(provider_sku, quantity, order_id)
            elif provider_code in ("cardone", "99cards"):
                return await self._purchase_cardone(provider_sku, quantity, order_id)
            elif provider_code == "wgcards":
                return await self._purchase_wgcards(provider_sku, quantity, order_id)
            elif provider_code == "hankgames":
                return await self._purchase_hankgames(provider_sku, quantity, order_id)
            elif provider_code == "manastore":
                return await self._purchase_manastore(provider_sku, quantity, order_id)
            elif provider_code == "wupex":
                return await self._purchase_wupex(provider_sku, quantity, order_id)
            elif provider_code == "icodes":
                return await self._purchase_icodes(provider_sku, quantity, order_id)
            elif provider_code == "coda_voucher":
                return await self._purchase_coda_voucher(provider_sku, quantity, order_id)
            elif provider_code == "tisi":
                return await self._purchase_tisi(provider_sku, quantity, order_id, supplier_metadata)
            elif provider_code == "visoria":
                return await self._purchase_visoria(provider_sku, quantity, order_id)
            else:
                print(f"   ❌ Proveedor desconocido: {provider_code}")
                return []
        except Exception as e:
            print(f"   ❌ [{provider_code}] error: {e}")
            return []

    async def _purchase_bamboo(self, sku: str, qty: int, order_id: str):
        try:
            bamboo = BambooClient()
            codes = await asyncio.wait_for(bamboo.purchase(sku=sku, quantity=qty, order_id=order_id), timeout=90.0)
            return codes
        except asyncio.TimeoutError:
            print("   ❌ Bamboo timeout (90s)")
            return []
        except Exception as e:
            print(f"   ❌ Bamboo error: {e}")
            return []

    async def _purchase_ez(self, sku: str, qty: int, order_id: str):
        try:
            ez = EZClient()
            result = await ez.create_instant_order(sku=sku, client_order_number=order_id, pay_with_currency="USD")
            transaction_id = result.get("transactionId") or result.get("data", {}).get("transactionId")
            if not transaction_id:
                return []
            for _ in range(20):
                await asyncio.sleep(3)
                codes = await ez.get_codes(transaction_id, sku=sku)
                if codes:
                    out = [{"code": str(c.get("redeem_code") or c.get("redeemCode")).strip(),
                            "pin": c.get("pin_code") or c.get("pinCode")}
                           for c in codes if c.get("redeem_code") or c.get("redeemCode")]
                    if out:
                        return out
            return []
        except Exception as e:
            print(f"   ❌ EZ error: {e}")
            return []

    async def _purchase_cardone(self, sku: str, qty: int, order_id: str):
        try:
            cardone = get_cardone_client()
            result = await cardone.place_order(product_code=sku, quantity=qty, client_order_id=order_id)
            items      = result.get("data") or []
            order_code = items[0].get("orderCode") if items else None
            if not order_code:
                print(f"   ❌ 99Cards: no orderCode en respuesta: {result}")
                return []
            for _ in range(30):
                await asyncio.sleep(3)
                detail = await cardone.get_order(order_code)
                codes  = self._extract_cardone_codes(detail)
                if codes:
                    return codes
            return []
        except Exception as e:
            print(f"   ❌ 99Cards error: {e}")
            return []

    async def _purchase_hankgames(self, sku: str, qty: int, order_id: str) -> List[dict]:
        """Compra códigos HankGames. Mismo flujo que auto_purchase_service._purchase_hankgames."""
        try:
            from app.providers import hankgames_client as hg
            result = await hg.create_transaction(product_id=sku, quantity=qty, external_order_id=order_id)
            hg_order_id = result.get("orderId")
            if not hg_order_id:
                print(f"   ❌ HankGames: no orderId en respuesta: {result}")
                return []
            codes = await hg.get_codes_from_transaction(hg_order_id, expected_quantity=qty, max_attempts=20)
            return [{"code": c, "pin": None} for c in codes if c]
        except Exception as e:
            print(f"   ❌ HankGames error: {e}")
            return []

    async def _purchase_manastore(self, sku: str, qty: int, order_id: str) -> List[dict]:
        """Compra códigos Manastore. Mismo flujo que auto_purchase_service._purchase_manastore."""
        try:
            from app.providers.manastore_client import ManastoreClient
            client = ManastoreClient()
            variant_id = int(sku)
            # Misma moneda que la reposición automática (product_suppliers.purchase_currency)
            purchase_currency = "USD"
            try:
                ps = supabase.table("product_suppliers").select("purchase_currency") \
                    .eq("provider_sku", str(variant_id)).limit(1).execute()
                if ps.data and ps.data[0].get("purchase_currency"):
                    purchase_currency = ps.data[0]["purchase_currency"].upper()
            except Exception:
                pass
            wallet_id = await client.get_wallet_id_for_currency(purchase_currency)
            order = await client.create_order(wallet_id, variant_id, quantity=qty)
            order_ulid = order.get("ulid")
            if not order_ulid:
                print(f"   ❌ Manastore: no ulid en respuesta: {order}")
                return []
            for _ in range(25):
                await asyncio.sleep(5)
                items = await client.get_codes(order_ulid)
                codes = []
                all_completed = bool(items)
                for item in items:
                    if item.get("status") != "completed":
                        all_completed = False
                    for code_obj in item.get("codes") or []:
                        code = code_obj.get("code") or code_obj.get("serial_number")
                        if code:
                            codes.append({"code": str(code).strip(), "pin": None})
                if codes and all_completed:
                    return codes
            return []
        except Exception as e:
            print(f"   ❌ Manastore error: {e}")
            return []

    async def _purchase_visoria(self, sku: str, qty: int, order_id: str) -> List[dict]:
        """Compra códigos Visoria. Mismo flujo que auto_purchase_service._purchase_visoria."""
        try:
            import uuid
            from app.providers import visoria_client as vs
            currency = "USD"
            try:
                ps = supabase.table("product_suppliers").select("cost_currency") \
                    .eq("provider_sku", str(sku)).limit(1).execute()
                if ps.data and ps.data[0].get("cost_currency"):
                    currency = ps.data[0]["cost_currency"].upper()
            except Exception:
                pass
            key = str(uuid.uuid4())
            order = await vs.create_order(str(sku), qty, currency, key)
            for attempt in range(25):
                if attempt:
                    await asyncio.sleep(5)
                    order = await vs.get_order_by_key(key)
                status = vs.order_status(order)
                if status == "CANCELLED" or vs.all_refunded(order):
                    print(f"   ❌ Visoria: orden {key} {status.lower() or 'devuelta'}")
                    return []
                codes = vs.extract_codes(order)
                if status == "COMPLETED" or len(codes) >= qty:
                    return [{"code": c, "pin": None} for c in codes]
            return []
        except Exception as e:
            print(f"   ❌ Visoria error: {e}")
            return []

    async def _purchase_wupex(self, sku: str, qty: int, order_id: str) -> List[dict]:
        """Compra códigos Wupex. Mismo flujo que auto_purchase_service._purchase_wupex."""
        try:
            from app.providers import wupex_client as wp
            data = await wp.create_voucher_order(sku=sku, quantity=qty, reference_id=order_id)
            order_name = data.get("orderName")
            if not order_name:
                print(f"   ❌ Wupex: no orderName en respuesta: {data}")
                return []
            # Códigos inmediatos (entrega directa sin pre-order)
            codes = wp.extract_codes(data)
            if codes and len(codes) >= qty:
                return [{"code": c, "pin": None} for c in codes]
            # Polling para pre-orders
            for _ in range(25):
                await asyncio.sleep(5)
                detail = await wp.get_order_detail(order_name=order_name)
                status_type = (detail.get("statusType") or "").lower()
                polled = wp.extract_codes(detail)
                if len(polled) > len(codes):
                    codes = polled
                if status_type == "failed":
                    print(f"   ❌ Wupex: pre-order {order_name} marcada Failed")
                    break
                if codes and (status_type == "completed" or len(codes) >= qty):
                    break
            return [{"code": c, "pin": None} for c in codes]
        except Exception as e:
            print(f"   ❌ Wupex error: {e}")
            return []

    async def _purchase_icodes(self, sku: str, qty: int, order_id: str) -> List[dict]:
        """Compra códigos iCodes. Mismo flujo que auto_purchase_service._purchase_icodes."""
        try:
            from app.providers import icodes_client as ic
            check = await ic.check_variety(sku, qty)
            if not check.get("is_available"):
                print(f"   ❌ iCodes: sin stock para sku={sku}")
                return []
            order = await ic.create_order(sku, qty)
            reference_code = order.get("_reference_code")
            if not reference_code:
                print(f"   ❌ iCodes: no reference_code en respuesta: {order}")
                return []
            if order.get("status") == 4:
                print(f"   ❌ iCodes: orden rechazada")
                return []
            # Polling hasta status=5 (Completed)
            for _ in range(30):
                status = order.get("status")
                if status == 5:
                    codes = await ic.download_codes(reference_code)
                    return [{"code": c, "pin": None} for c in codes if c]
                if status == 4:
                    return []
                await asyncio.sleep(4)
                order = await ic.get_order_status(reference_code)
            return []
        except Exception as e:
            print(f"   ❌ iCodes error: {e}")
            return []

    async def _purchase_coda_voucher(self, sku: str, qty: int, order_id: str) -> List[dict]:
        """Compra vouchers Coda uno a uno (cada unidad es transacción independiente)."""
        try:
            from app.providers import coda_voucher_client
            # Obtener api_path del metadata del proveedor en product_suppliers
            supplier_res = supabase.table("product_suppliers")                 .select("metadata, provider:providers(code)")                 .eq("provider_sku", sku).execute()
            api_path = None
            for row in supplier_res.data or []:
                if ((row.get("provider") or {}).get("code") or "") == "coda_voucher":
                    api_path = (row.get("metadata") or {}).get("api_path")
                    break
            if not api_path:
                print(f"   ❌ Coda: no se encontró api_path para sku={sku}")
                return []
            client = coda_voucher_client.CodaVoucherClient()
            skus = await client.list_skus(api_path)
            sku_row = next((s for s in skus if s.get("sku") == sku), None)
            if not sku_row:
                print(f"   ❌ Coda: sku {sku} no encontrado en {api_path}")
                return []
            codes = []
            for i in range(qty):
                result = await client.place_order(
                    api_path=api_path, sku=sku,
                    price_amount=sku_row["priceAmount"],
                    price_currency=sku_row["priceCurrency"],
                    customer_id=f"eneba-{order_id}",
                )
                if result.get("success") and result.get("code"):
                    codes.append({"code": result["code"], "pin": None})
            return codes
        except Exception as e:
            print(f"   ❌ Coda error: {e}")
            return []

    async def _purchase_tisi(self, sku: str, qty: int, order_id: str, supplier_metadata=None) -> List[dict]:
        """
        Compra PINs TISI uno a uno (cada unidad es una transacción independiente).
        Usa los mismos datos que la reposición automática y la compra manual
        (auto_purchase_service._tisi_buy_units): referencia de máx. 50
        caracteres, campos_referencia EMAIL/TELEFONO y registro en
        tisi_transactions para la conciliación.

        Si TISI rechaza la VENTA (paso 1) antes de comprar nada, no hubo cobro:
        lo marca en _RT_SAFE_FAIL para que un reintento de Eneba pueda volver a
        intentar la compra.
        """
        import time as _time
        from app.providers.tisi_client import (
            TisiClient, TisiError, TisiInsufficientBalance, TisiTransactionDuplicate,
            is_safe_tisi_failure, record_tisi_transaction, tisi_reference_fields,
        )
        tisi = TisiClient()
        codes: List[dict] = []
        for i in range(qty):
            ts  = str(int(_time.time() * 1000))[-7:]
            ref = f"TISIE-{order_id[:8]}-{i + 1}-{ts}"[:50]
            try:
                pins, nro_transaccion = await tisi.purchase(
                    id_producto=str(sku),
                    nro_transaccion_referencia=ref,
                    campos_referencia=tisi_reference_fields(),
                )
                codes.extend([{"code": p, "pin": None} for p in pins if p])
                await record_tisi_transaction(tisi, str(sku), ref, nro_transaccion, supplier_metadata,
                                              f"Eneba {order_id[:8]}")
            except TisiTransactionDuplicate:
                # Igual que la reposición automática: la referencia ya existe → consultar estado
                try:
                    estado = await tisi.get_transaction_status(ref)
                    if str(estado.get("codigo", "")).strip() == "00":
                        codes.append({"code": f"TISI-DUP-{ref}", "pin": None})
                        print(f"   ⚠️ TISI ref={ref} duplicada y exitosa — registrada como TISI-DUP-{ref}")
                        continue
                except Exception as estado_exc:
                    print(f"   ❌ TISI no se pudo consultar estado de ref={ref}: {estado_exc}")
                break
            except TisiInsufficientBalance as e:
                print(f"   ❌ TISI saldo insuficiente: {e}")
                break
            except Exception as e:
                safe = is_safe_tisi_failure(e)
                print(f"   ❌ TISI unidad {i + 1}/{qty}: {e}"
                      + (" (TISI rechazó la venta: sin cobro)" if safe else ""))
                if not codes and safe:
                    _RT_SAFE_FAIL.set(True)
                break   # conservar los ya comprados
        return codes

    def _extract_cardone_codes(self, response: dict) -> List[dict]:
        """
        Usa exactamente la misma lógica que auto_purchase_service._cardone_fetch_codes
        para no tener divergencias entre la compra en tiempo real y la reposición automática.

        99Cards puede devolver data como:
          - lista: [{"pins": [{"pin": "XXXX"}]}]  ← compra directa / get_order_info nuevo
          - dict:  {"list": [{"cardno": "XXXX"}]} ← get_order_info legado
        """
        codes = []
        try:
            order_detail = response
            if isinstance(order_detail, dict):
                order_data = order_detail.get("data") or []
            elif isinstance(order_detail, list):
                order_data = order_detail
            else:
                order_data = []

            items_list = order_data if isinstance(order_data, list) else [order_data]
            for item in items_list:
                if not isinstance(item, dict):
                    continue
                for pin_obj in item.get("pins") or item.get("cards") or []:
                    if not isinstance(pin_obj, dict):
                        continue
                    # Misma prioridad que auto_purchase_service:
                    # pin > pinCode > code > cardCode > number (fallback)
                    code = (
                        pin_obj.get("pin")      or
                        pin_obj.get("pinCode")  or
                        pin_obj.get("code")     or
                        pin_obj.get("cardCode") or
                        pin_obj.get("number")
                    )
                    if code and str(code).strip():
                        codes.append({"code": str(code).strip(), "pin": None})
                # Fallback para estructura legada (dict con cardno/cardpin)
                if not any(codes):
                    code = item.get("cardno") or item.get("cardCode")
                    if code:
                        codes.append({"code": str(code).strip(), "pin": item.get("cardpin")})

        except Exception as e:
            print(f"   ❌ extract_cardone_codes: {e}")
        return codes

    async def _purchase_wgcards(self, sku: str, qty: int, order_id: str):
        try:
            wg_order_id = await wg.place_order(sku_id=sku, buy_num=qty)
            print(f"   [WgCards] Orden: {wg_order_id}")
            for _ in range(20):
                await asyncio.sleep(4)
                try:
                    records = await wg.get_order_codes(wg_order_id)
                except Exception:
                    continue
                if records:
                    # Igual que la reposición automática, sin perder registros que
                    # solo traen pinCode (antes se descartaban aunque estaban pagados).
                    codes = []
                    for r in records:
                        main = r.get("card") or r.get("snCode")
                        if main:
                            codes.append({"code": str(main).strip(), "pin": r.get("pinCode")})
                        elif r.get("pinCode"):
                            codes.append({"code": str(r["pinCode"]).strip(), "pin": None})
                    if codes:
                        return codes
            return []
        except Exception as e:
            print(f"   ❌ WgCards error: {e}")
            return []

    # ── Guardar orden de compra ───────────────────────────────────

    async def _save_order(
        self,
        order_id: str, provider_id: int, provider_code: str,
        product_name: str, provider_sku: str, key_count: int,
        cost_price: float, sell_price: float, codes: List[dict],
        bamboo_order_number: Optional[str] = None,
        ez_order_number: Optional[str] = None,
        cardone_order_number: Optional[str] = None,
    ) -> None:
        try:
            eur_to_usd     = await _get_eur_to_usd()
            usd_to_eur     = round(1 / eur_to_usd, 6) if eur_to_usd else 0.93
            cost_price_eur = round(cost_price * usd_to_eur, 4)
            sell_price_usd = round(sell_price * eur_to_usd, 4)

            supabase.table("orders").upsert({
                "request_id":           order_id,
                "provider_id":          provider_id,
                "status":               "COMPLETED",
                "total_amount":         cost_price,
                "placed_at":            datetime.utcnow().isoformat(),
                "bamboo_order_number":  bamboo_order_number,
                "ez_order_number":      ez_order_number,
                "cardone_order_number": cardone_order_number,
                "metadata": {
                    "product_name":   product_name,   "provider_sku":   provider_sku,
                    "key_count":      key_count,       "cost_price":     cost_price,
                    "sell_price":     sell_price,      "cost_price_usd": cost_price,
                    "cost_price_eur": cost_price_eur,  "sale_price_eur": sell_price,
                    "sell_price_usd": sell_price_usd,  "eur_to_usd":     eur_to_usd,
                    "sold_on":        "eneba",         "platform":       "Eneba",
                },
            }, on_conflict="request_id").execute()
        except Exception as e:
            print(f"   ⚠️  Error guardando orden en Supabase: {e}")