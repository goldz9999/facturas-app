# UBICACIÓN EN TU REPO: fastapi-gift-cards/app/services/auto_purchase_service.py
# (repositorio: fastapi-gift-cards · ruta: app/services/auto_purchase_service.py)
"""
app/services/auto_purchase_service.py
═══════════════════════════════════════
Sistema de auto-compra de códigos digitales para Falabella + HomeDelivery.

Flujo crítico (códigos SOLO en memoria, jamás en BD):
  1. Verificar stock actual (Falabella API)
  2. Si stock <= umbral → comprar al proveedor (con fallback entre proveedores)
  3. Obtener códigos en variable temporal
  4. Subir a HomeDelivery (con retry)
  5. Solo si subida OK → UpdateStock en Falabella
  6. Limpiar variable temporal

Seguridades:
  - Lock por producto (evita compras duplicadas)
  - Retry con backoff exponencial para HD
  - Fallback automático entre proveedores ordenados por prioridad
  - Logs detallados en cada paso
"""

from app.core.config import settings
from app.core import config
import asyncio
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from app.core.database import supabase
from app.providers.bamboo_client import BambooClient
from app.providers.cardone_client import get_cardone_client
from app.providers.tisi_client import TisiClient, TisiError, TisiTransactionDuplicate, TisiInsufficientBalance
from app.providers.falabella_client import get_falabella_client
from app.providers.homedelivery_client import get_homedelivery_client
from app.services.telegram_service import telegram
from app.services.provider_order_tracking import (
    PENDING_ORDER_RECOVERY_DAYS,
    STATUS_COMPLETED,
    STATUS_PENDING,
    STATUS_RECOVERY,
    UNIT_BASED_PROVIDERS,
    ProviderOrderResult,
    ProviderOrderTracker,
    get_last_order_result,
    insert_inventory_codes,
    set_last_order_result,
    tracking_provider_code,
    clear_submit_marker,
    get_submit_marker,
    is_ambiguous_submit_error,
    note_rejected,
    note_submit,
)
from app.core import distributed_lock

logger = logging.getLogger(__name__)

_tracker = ProviderOrderTracker()


# ── Log genérico de recuperación de órdenes a proveedores ─────────────────────

async def _log_recovery(
    provider: str,
    order_ref: str,
    status: str,
    product_id: Optional[int] = None,
    stage_at_resolution: Optional[str] = None,
    codes_count: int = 0,
    original_created_at: Optional[str] = None,
    original_expires_at: Optional[str] = None,
    raw_metadata: Optional[dict] = None,
    retried_manually: bool = False,
) -> None:
    """
    Registra en provider_recovery_log el desenlace (RECOVERED / UNRECOVERED)
    de una orden a proveedor. Se mantiene la firma original por
    compatibilidad, pero ahora delega en ProviderOrderTracker.resolve(), que
    respeta las cantidades ya acumuladas de la orden (nunca las sobrescribe)
    y NUNCA marca como RECOVERED una orden con códigos faltantes.

    NOTA: la fila se identifica por (provider, order_ref, product_id) porque
    EZ API agrupa varios productos bajo el mismo transaction_id
    (_EZBatchCollector) — cada producto necesita su propia fila.
    """
    try:
        _tracker.resolve(
            provider=provider,
            order_ref=str(order_ref),
            status=status,
            product_id=product_id,
            stage_at_resolution=stage_at_resolution,
            codes_count=codes_count,
            original_created_at=original_created_at,
            original_expires_at=original_expires_at,
            raw_metadata=raw_metadata,
            retried_manually=retried_manually,
        )
    except Exception as e:
        logger.warning("[RecoveryLog] No se pudo registrar %s/%s: %s", provider, order_ref, e)


def _pending_expiry_iso() -> tuple[str, str]:
    """(created_at, expires_at) para las tablas *_pending_orders: regla única de 2 días."""
    from datetime import timezone, timedelta
    now = datetime.now(timezone.utc)
    return now.isoformat(), (now + timedelta(days=PENDING_ORDER_RECOVERY_DAYS)).isoformat()


# ── Base común de "orden pendiente" ───────────────────────────────────────────

class ProviderOrderPending(Exception):
    """
    Base de todas las señales "la orden ya fue creada/pagada en el proveedor
    pero aún faltan códigos". Significa: NO comprar a otro proveedor, la orden
    se retoma en el próximo ciclo (o con "Recuperar ahora").

    Cualquier proveedor nuevo debe lanzar esta excepción (o una subclase) —
    los callers solo necesitan capturar ProviderOrderPending.
    """
    def __init__(
        self,
        message: str = "",
        *,
        provider: str = "",
        order_ref: str = "",
        product_id: Optional[int] = None,
        requested_quantity: Optional[int] = None,
        received_quantity: int = 0,
        remaining_quantity: Optional[int] = None,
    ):
        self.provider           = provider
        self.order_ref          = order_ref
        self.product_id         = product_id
        self.requested_quantity = requested_quantity
        self.received_quantity  = received_quantity
        self.remaining_quantity = remaining_quantity
        super().__init__(message or f"{provider} orden pendiente {order_ref}")


# ── Excepción especial WGCards pre-order ──────────────────────────────────────

class WGCardsOrderPending(ProviderOrderPending):
    """
    Se lanza cuando WGCards acepta la orden (pre-order) pero los códigos
    aún no están disponibles. Señal para NO ir a otro proveedor y esperar.
    Lleva el orderId guardado en BD para retomarlo en el próximo ciclo.
    """
    def __init__(self, order_id: str, sku_id: str, product_id: int):
        self.order_id   = order_id
        self.sku_id     = sku_id
        self.product_id = product_id
        super().__init__(f"WGCards orden pendiente orderId={order_id} (pre-order)",
                         provider="wgcards", order_ref=order_id, product_id=product_id)
class EnebaOrderPending(ProviderOrderPending):
    """
    Se lanza cuando Eneba aceptó la compra pero las claves aún no
    están disponibles (action no COMPLETED, ZIP no generado, o URL expirada).
 
    Señal para NO ir a otro proveedor — la orden ya fue pagada.
    El stage indica en qué fase quedó para retomar en el próximo ciclo.
 
    Stages:
      ACTION_POLLING  → A_action todavía en NEW
      EXPORT_PENDING  → O_orderExport todavía en PENDING
      DOWNLOAD_READY  → downloadUrl disponible pero descarga/extracción falló
    """
    def __init__(
        self,
        order_id: str,
        action_id: str,
        auction_id: str,
        product_id: int,
        stage: str,
        entry_token: Optional[str] = None,
        download_url: Optional[str] = None,
    ):
        self.order_id     = order_id
        self.action_id    = action_id
        self.auction_id   = auction_id
        self.product_id   = product_id
        self.stage        = stage
        self.entry_token  = entry_token
        self.download_url = download_url
        super().__init__(
            f"Eneba orden pendiente orderId={order_id} stage={stage}",
            provider="eneba_wholesale", order_ref=order_id, product_id=product_id,
        )

class EZOrderPending(ProviderOrderPending):
    def __init__(self, transaction_id: str, provider_sku: str, product_id: int):
        self.transaction_id = transaction_id
        self.provider_sku   = provider_sku
        self.product_id     = product_id
        super().__init__(f"EZ API orden pendiente transactionId={transaction_id} (PROCESSING)",
                         provider="ez", order_ref=transaction_id, product_id=product_id)

class HankgamesOrderPending(ProviderOrderPending):
    """
    Se lanza cuando Hankgames aceptó la orden pero los códigos aún no están
    disponibles en get_codes_from_transaction. Señal para NO ir a otro
    proveedor — la orden ya fue creada/cobrada. Se retoma en el próximo
    ciclo vía orderId.
    """
    def __init__(self, order_id: str, provider_product_id: str, product_id: int):
        self.order_id            = order_id
        self.provider_product_id = provider_product_id
        self.product_id          = product_id
        super().__init__(f"Hankgames orden pendiente orderId={order_id}",
                         provider="hankgames", order_ref=order_id, product_id=product_id)

class WupexOrderPending(ProviderOrderPending):
    """
    Se lanza cuando Wupex aceptó la orden pero quedó como pre-order total o
    parcial (preOrderNo != null) y los códigos restantes aún no están
    disponibles. Señal para NO ir a otro proveedor y esperar — la orden ya
    fue pagada/comprometida. Se retoma en el próximo ciclo vía orderName.
    """
    def __init__(self, order_name: str, sku: str, product_id: int, reference_id: Optional[str] = None):
        self.order_name   = order_name
        self.sku          = sku
        self.product_id   = product_id
        self.reference_id = reference_id
        super().__init__(f"Wupex orden pendiente orderName={order_name} (pre-order)",
                         provider="wupex", order_ref=order_name, product_id=product_id)


class ManastoreOrderPending(ProviderOrderPending):
    """
    Se lanza cuando Manastore creó la orden pero get-codes aún no marca el
    ítem como "completed". Señal para NO ir a otro proveedor — la orden ya
    fue pagada. Se retoma en el próximo ciclo vía order_ulid.
    """
    def __init__(self, order_ulid: str, variant_id: int, product_id: int):
        self.order_ulid = order_ulid
        self.variant_id = variant_id
        self.product_id = product_id
        super().__init__(f"Manastore orden pendiente ulid={order_ulid}",
                         provider="manastore", order_ref=order_ulid, product_id=product_id)

HANKGAMES_CREATE_TIMEOUT = 120.0   # espera del orderId al crear la orden (solo manual/reposición)


class ProviderOrderAmbiguous(ProviderOrderPending):
    """
    El envío de la orden falló DESPUÉS de enviarse (timeout, conexión cortada,
    5xx): no se sabe si el proveedor la ejecutó. NO se prueba otro proveedor.
    La orden queda registrada para recuperarla o revisarla (auditoría R3).
    """


class ProviderCooldown(Exception):
    """El proveedor está en pausa por límite de solicitudes (429). Se prueba el siguiente."""


# ── Constantes ────────────────────────────────────────────────────────────────

MAX_HD_RETRIES = 3          # Intentos máximos para HomeDelivery
HD_BACKOFF_BASE = 2.0       # Segundos base para backoff exponencial
HD_BACKOFF_MAX = 30.0       # Tope máximo de espera entre reintentos
LOCK_TIMEOUT = 300          # Segundos antes de liberar un lock colgado (5 min)


# ── Estructuras de datos ──────────────────────────────────────────────────────

@dataclass
class PurchaseConfig:
    product_id: int
    product_name: str
    seller_sku: str
    shop_sku: str
    provider_code: str
    provider_sku: str
    auto_compra_activa: bool
    umbral_minimo: int
    cantidad_compra: int
    channel_listing_id: int
    face_value: Optional[float] = None
    max_cost_usd: Optional[float] = None  # ← NUEVO
    suppliers_fallback: list = field(default_factory=list)


@dataclass
class PurchaseResult:
    """Resultado de un ciclo de auto-compra."""
    product_id: int
    product_name: str
    success: bool
    codes_purchased: int = 0
    codes_uploaded: int = 0
    stock_before: int = 0
    stock_after: int = 0
    error: Optional[str] = None
    skipped_reason: Optional[str] = None
    cost_total: Optional[float] = None
    provider_balance: Optional[float] = None
    balance_currency: str = "USD"
    provider: Optional[str] = None
    # Validación de cantidades (orden a proveedor del ciclo)
    order_ref: Optional[str] = None
    codes_requested: Optional[int] = None
    codes_pending: Optional[int] = None


# ── Lock manager (en memoria) ─────────────────────────────────────────────────

class ProductLockManager:
    """
    Mutex por producto para evitar compras duplicadas concurrentes.

    Dos niveles:
      1. En memoria (mismo proceso): evita ir a Redis si este mismo proceso
         ya está trabajando el producto.
      2. Distribuido en Redis (app/core/distributed_lock.py): lo comparten el
         worker de Celery y uvicorn (compra manual, "Recuperar ahora",
         ejecución manual del ciclo). Antes solo existía el nivel 1, que no
         protegía entre procesos (auditoría R1).

    release() ahora es async: hay que usar `await _lock_manager.release(pid)`.
    """

    def __init__(self):
        self._held: dict[int, tuple[float, Optional[str]]] = {}

    async def acquire(self, product_id: int) -> bool:
        now = time.time()
        held = self._held.get(product_id)
        if held and now - held[0] < settings.REPLENISH_LOCK_TTL_SECONDS:
            logger.info("[Lock] product_id=%d ya está procesando (este proceso), saltando", product_id)
            return False
        # Reserva local SIN await entre la comprobación y la escritura
        # (atómico dentro del event loop).
        self._held[product_id] = (now, None)
        token = await distributed_lock.acquire(
            distributed_lock.product_lock_key(product_id), settings.REPLENISH_LOCK_TTL_SECONDS,
        )
        if not token:
            self._held.pop(product_id, None)
            logger.info("[Lock] product_id=%d bloqueado por otro proceso, saltando", product_id)
            return False
        self._held[product_id] = (now, token)
        return True

    async def release(self, product_id: int) -> None:
        held = self._held.pop(product_id, None)
        if held:
            await distributed_lock.release(distributed_lock.product_lock_key(product_id), held[1])


_lock_manager = ProductLockManager()


class _EZBatchCollector:
    """
    Junta varias compras EZ que caen en la misma ventana de tiempo del ciclo
    (mientras los productos se procesan en paralelo con el Semaphore(5)) y las
    manda en UNA sola orden bulk con varios SKUs, en vez de una orden por SKU.

    Cómo funciona:
      - El primer producto que necesita comprar en EZ abre una ventana de
        `window_seconds` y arranca un timer.
      - Cualquier otro producto EZ que se sume durante esa ventana se agrega
        al mismo batch.
      - Al cerrar la ventana, se crea UNA orden con todos los SKUs juntos
        (create_bulk_order_multi) y el transactionId resultante se reparte a
        todos los que esperaban.
      - Cada producto sigue haciendo SU PROPIO polling/pending-order por SKU
        como ya hacía antes — si su código tarda más que los demás, no bloquea
        ni se pierde: queda su propia fila en ez_pending_orders apuntando al
        mismo transactionId, y se retoma en el próximo ciclo igual que hoy.
    """

    def __init__(self, window_seconds: float = 2.0):
        self.window_seconds = window_seconds
        self._pending: list[tuple["PurchaseConfig", "asyncio.Future"]] = []
        self._lock = asyncio.Lock()
        self._timer_running = False

    async def request(self, cfg: "PurchaseConfig") -> dict:
        """Registra una solicitud de compra EZ y espera el resultado del batch."""
        fut = asyncio.get_event_loop().create_future()
        async with self._lock:
            self._pending.append((cfg, fut))
            start_timer = not self._timer_running
            self._timer_running = True
        if start_timer:
            asyncio.create_task(self._flush_after_window())
        return await fut

    async def _flush_after_window(self):
        await asyncio.sleep(self.window_seconds)
        async with self._lock:
            batch = self._pending
            self._pending = []
            self._timer_running = False

        if not batch:
            return

        skus = ", ".join(f"{c.provider_sku} x{c.cantidad_compra}" for c, _ in batch)
        logger.info("[EZ batch] Agrupando %d producto(s) en una sola orden: %s", len(batch), skus)

        from app.providers.ez_client import EZClient
        import uuid

        ez = EZClient()
        client_order_number = str(uuid.uuid4())
        products_payload = [{"sku": c.provider_sku, "quantity": c.cantidad_compra} for c, _ in batch]

        try:
            order = await ez.create_bulk_order_multi(
                products=products_payload,
                client_order_number=client_order_number,
            )
            transaction_id = order.get("transactionId")
            if not transaction_id:
                raise RuntimeError(f"EZ API: sin transactionId en respuesta: {order}")

            logger.info("[EZ batch] Orden creada transactionId=%s con %d SKU(s)", transaction_id, len(batch))
            for cfg, fut in batch:
                if not fut.done():
                    fut.set_result({"transaction_id": transaction_id, "error": None})

        except Exception as e:
            logger.error("[EZ batch] Falló la creación de la orden agrupada: %s", e)
            for cfg, fut in batch:
                if not fut.done():
                    fut.set_result({"transaction_id": None, "error": str(e)})


# ── Servicio principal ────────────────────────────────────────────────────────

class AutoPurchaseService:
    """
    Servicio de auto-compra: verifica stock, compra, sube a HD y actualiza Falabella.
    Los códigos NUNCA se escriben en BD — viven solo en variables locales.
    """

    def __init__(self):
        self.falabella = get_falabella_client()
        self.hd_client = get_homedelivery_client()
        self._ez_batch = _EZBatchCollector()
        self._tracker = _tracker

    # ─── Validación común de cantidades (TODOS los proveedores) ──────────────

    async def _settle_order(
        self,
        cfg: "PurchaseConfig",
        *,
        provider: str,
        order_ref: str,
        requested_quantity: Optional[int],
        fetched_codes: list,
        resume_meta: Optional[dict] = None,
        save_pending=None,
        pending_exc: Optional[Exception] = None,
        created_at: Optional[str] = None,
        stage: Optional[str] = None,
        terminal_failure: bool = False,
        error: Optional[str] = None,
        manual: bool = False,
        source: str = "auto",
    ) -> list[str]:
        """
        Punto ÚNICO donde se decide si una orden a proveedor está completa.
        Toda integración (nueva compra o reanudación) llama aquí con los
        códigos que el proveedor muestra para esa orden.

          cantidad solicitada → cantidad recibida → cantidad pendiente

        - remaining == 0 → COMPLETADA: se borra el puntero *_pending_orders y
          se devuelven los códigos nuevos para insertarlos en inventario.
        - remaining > 0 y hay códigos nuevos → PARCIAL: se devuelven los
          códigos nuevos (se guardan en inventario) y la orden queda PENDING
          para que el próximo ciclo pida SOLO lo que falta.
        - remaining > 0 y ningún código nuevo → se lanza pending_exc
          (no ir a otro proveedor: la orden ya está pagada).
        - terminal_failure (el proveedor marcó la orden como fallida) →
          los códigos recibidos se guardan igual y la orden pasa directo a
          "En recuperación".

        `save_pending` (callable async) se ejecuta si la orden queda
        incompleta y todavía no tiene puntero en la tabla del proveedor
        (solo hay que pasarlo en el camino de "orden nueva").
        """
        provider_key = tracking_provider_code(provider)
        meta = {
            "provider_code": cfg.provider_code,
            "provider_sku":  cfg.provider_sku,
            "face_value":    cfg.face_value,
            "product_name":  cfg.product_name,
        }
        meta.update(resume_meta or {})

        try:
            result = self._tracker.record_attempt(
                provider=provider_key,
                order_ref=str(order_ref),
                product_id=cfg.product_id,
                requested_quantity=requested_quantity,
                fetched_codes=fetched_codes,
                resume_meta=meta,
                manual=manual,
                source=source,
                created_at=created_at,
                stage=stage,
                terminal_failure=terminal_failure,
                error=error,
            )
        except Exception as e:
            # Nunca perder códigos por un fallo de BD en el registro: se
            # devuelven tal cual (comportamiento previo) y se avisa.
            logger.error(
                "[%s] ⚠️ No se pudo registrar cantidades de %s/%s: %s — se devuelven los códigos sin validar",
                cfg.product_name, provider_key, order_ref, e,
            )
            from app.services.provider_order_tracking import normalize_codes
            codes = normalize_codes(fetched_codes)
            if not codes and pending_exc is not None:
                if save_pending:
                    await save_pending()
                raise pending_exc
            return codes

        result.resume_meta = dict(meta)
        set_last_order_result(result)
        # La orden ya tiene registro: si el worker se cae ahora, no hay duda.
        clear_submit_marker()

        logger.info(
            "[%s] %s orden=%s solicitados=%s recibidos(este intento)=%d acumulado=%d pendientes=%d → %s",
            cfg.product_name, provider_key, order_ref, result.requested_quantity,
            result.received_quantity, result.total_received_quantity,
            result.remaining_quantity, result.status,
        )

        if result.is_complete or result.status == STATUS_RECOVERY:
            self._tracker.delete_provider_pointer(provider_key, str(order_ref), cfg.product_id)
            if result.is_complete:
                self._tracker.discard_clean_intent(provider_key, str(order_ref), cfg.product_id)
        elif save_pending:
            await save_pending()

        # Telegram: aviso de orden pendiente o parcial (todos los proveedores,
        # tanto compra nueva como recuperación manual/automática)
        try:
            if result.status == STATUS_RECOVERY and result.remaining_quantity:
                await telegram.broadcast(
                    f"⚠️ <b>{cfg.product_name}</b> — {provider_key}\n"
                    f"Orden <code>{order_ref}</code> pasó a <b>Recuperación de órdenes</b>.\n"
                    f"Solicitados: <b>{result.requested_quantity}</b> · "
                    f"Recibidos: <b>{result.total_received_quantity}</b> · "
                    f"Pendientes: <b>{result.remaining_quantity}</b>\n"
                    f"{'Error: ' + error if error else 'Sin códigos entregados por el proveedor.'}"
                )
            elif result.status == STATUS_PENDING and result.received_quantity == 0:
                # Orden pagada pero sin códigos aún (ej. en PROCESSING)
                await telegram.broadcast(
                    f"⏳ <b>{cfg.product_name}</b> — {provider_key}\n"
                    f"Orden <code>{order_ref}</code> pendiente de entrega.\n"
                    f"Solicitados: <b>{result.requested_quantity}</b>\n"
                    f"Se reintentará automáticamente en el próximo ciclo."
                )
            elif result.is_partial and result.received_quantity > 0:
                await telegram.broadcast(
                    f"🧩 <b>{cfg.product_name}</b> — {provider_key}\n"
                    f"Entrega PARCIAL en orden <code>{order_ref}</code>.\n"
                    f"Solicitados: <b>{result.requested_quantity}</b> · "
                    f"Recibidos: <b>{result.total_received_quantity}</b> · "
                    f"Pendientes: <b>{result.remaining_quantity}</b>\n"
                    + ("Pasa a <b>Recuperación de órdenes</b>."
                       if result.status == STATUS_RECOVERY else
                       "Se reintentará automáticamente solo lo pendiente.")
                )
        except Exception:
            pass

        if result.codes:
            return result.codes

        if result.is_complete:
            return []
        if result.status == STATUS_RECOVERY:
            raise RuntimeError(
                f"{provider_key}: orden {order_ref} fallida en el proveedor con "
                f"{result.remaining_quantity} código(s) sin entregar — enviada a Recuperación de órdenes"
                + (f" ({error})" if error else "")
            )
        raise pending_exc or ProviderOrderPending(
            f"{provider_key}: orden {order_ref} sin códigos nuevos "
            f"({result.total_received_quantity}/{result.requested_quantity})",
            provider=provider_key, order_ref=str(order_ref), product_id=cfg.product_id,
            requested_quantity=result.requested_quantity,
            received_quantity=result.total_received_quantity,
            remaining_quantity=result.remaining_quantity,
        )

    # ─── Marcadores de envío (respuestas ambiguas) ───────────────────────────

    def _note_submit(self, cfg: "PurchaseConfig", provider: str, requested: Optional[int],
                     client_ref: Optional[str] = None, meta: Optional[dict] = None) -> None:
        """Llamar JUSTO ANTES de la petición que crea la orden en el proveedor."""
        note_submit(provider, cfg.product_id, requested, client_ref=client_ref,
                    meta={"provider_code": cfg.provider_code, "provider_sku": cfg.provider_sku,
                          "face_value": cfg.face_value, "product_name": cfg.product_name,
                          **(meta or {})})

    def _note_accepted(self, cfg: "PurchaseConfig", order_ref: str, meta: Optional[dict] = None) -> None:
        """
        Llamar apenas el proveedor devuelve la referencia de la orden. Registra
        la orden como PENDING ANTES del polling: si el worker se reinicia, la
        reanudación automática la recupera (auditoría R4).
        """
        m = get_submit_marker()
        if m is None:
            return
        m.order_ref = str(order_ref)
        m.meta.update(meta or {})
        m.meta.setdefault("kind", "order")
        self._tracker.record_intent(provider=m.provider, order_ref=m.order_ref, product_id=m.product_id,
                                    requested_quantity=m.requested_quantity, meta=m.meta)

    async def _handle_failed_submit(self, cfg: "PurchaseConfig", p_name: str, exc: Exception) -> None:
        """
        Decide qué hacer cuando el intento con un proveedor lanzó excepción.
        Vuelve sin hacer nada si es seguro probar con el siguiente proveedor;
        lanza ProviderOrderPending/Ambiguous si NO lo es.
        """
        m = get_submit_marker()
        if m is None or m.rejected:
            return  # nunca se envió, o el proveedor la rechazó de forma explícita
        if m.order_ref:
            # La orden EXISTE en el proveedor (ya teníamos su referencia): la
            # intención PENDING ya está registrada; la reanudación la recupera.
            logger.warning("[%s] %s: error tras crear la orden %s (%s) — queda pendiente, NO se compra a otro proveedor",
                           cfg.product_name, p_name, m.order_ref, exc)
            await telegram.broadcast(
                f"⏳ <b>{cfg.product_name}</b> — {m.provider}\n"
                f"Orden <code>{m.order_ref}</code> creada, pero falló la lectura de códigos ({str(exc)[:150]}).\n"
                f"Queda pendiente y se recupera automáticamente."
            )
            raise ProviderOrderPending(
                f"{p_name}: orden {m.order_ref} creada, códigos pendientes ({exc})",
                provider=m.provider, order_ref=m.order_ref, product_id=cfg.product_id,
                requested_quantity=m.requested_quantity, remaining_quantity=m.requested_quantity,
            )
        if not is_ambiguous_submit_error(exc):
            return
        ref = self._tracker.record_ambiguous(
            provider=m.provider, product_id=cfg.product_id, requested_quantity=m.requested_quantity,
            client_ref=m.client_ref, meta=m.meta, error=str(exc),
        )
        logger.error("[%s] %s: respuesta AMBIGUA al crear la orden (%s) — NO se compra a otro proveedor (ref=%s)",
                     cfg.product_name, p_name, exc, ref)
        await telegram.broadcast(
            f"⚠️ <b>{cfg.product_name}</b> — {m.provider}\n"
            f"No se sabe si la orden se creó: {str(exc)[:200]}\n"
            f"Referencia: <code>{ref}</code> · Cantidad: {m.requested_quantity}\n"
            f"Revísala en <b>Recuperación de órdenes</b>. El producto no se recompra durante 24 h."
        )
        raise ProviderOrderAmbiguous(
            f"{p_name}: respuesta ambigua al crear la orden ({exc})",
            provider=m.provider, order_ref=ref, product_id=cfg.product_id,
            requested_quantity=m.requested_quantity,
        )

    # ─── Entrada principal ────────────────────────────────────────────────────

    # ⚠️ ADVERTENCIA — LEER ANTES DE TOCAR ESTE MÉTODO O DE AGREGAR LÓGICA NUEVA AQUÍ:
    #
    # Este run_cycle() NO está conectado a ningún Celery beat ni endpoint activo.
    # Verificado el 2026-09 buscando todos los `.run_cycle()` del repo — ninguna
    # tarea programada ni ruta manual lo invoca. El pipeline real en producción es:
    #
    #   inventory_replenishment_task (Celery, 5x/día)
    #     → InventoryReplenishmentService.run_cycle()      [inventory_replenishment_service.py]
    #         → self._purchase_service = AutoPurchaseService()   ← SÍ usa esta clase,
    #           pero llamando a sus métodos de bajo nivel uno por uno
    #           (_purchase_codes_with_fallback, _sweep_expired_pending_orders,
    #           _refresh_supplier_prices, _get_cost_and_balance, etc.)
    #         → inserta los códigos en inventory_codes (NO sube a HomeDelivery aquí)
    #
    #   auto_purchase_task (Celery, 5x/día, TAREA SEPARADA)
    #     → falabella_inventory_fulfillment_service.py
    #         → jala de inventory_codes → sube a HomeDelivery → actualiza stock Falabella
    #
    # O sea: los métodos individuales de esta clase (comprar a cada proveedor,
    # guardar/leer pending_orders, hacer polling) SÍ están vivos y en uso — se
    # reutilizan por composición desde InventoryReplenishmentService. Pero el
    # ORQUESTADOR de punta a punta de ESTE archivo (este run_cycle(), que subía
    # directo a HomeDelivery/Falabella) quedó reemplazado por el diseño de
    # "inventario central" y ya no corre en ningún lado.
    #
    # Si necesitas agregar algo que debe correr en cada ciclo automático real
    # (ej. un barrido, una notificación, una limpieza), NO lo pongas dentro de
    # este método — ponlo en InventoryReplenishmentService.run_cycle() (Paso 0
    # en adelante), que es el que Celery sí ejecuta. Antes de asumir que un
    # método "corre en producción", greppea sus llamadas: `grep -rn ".run_cycle()"`
    # y confirma qué Celery task o endpoint llega hasta ahí.
    async def run_cycle(self) -> list[PurchaseResult]:
        self._ez_batch = _EZBatchCollector()  # reset por ciclo — no arrastrar batch de ciclos anteriores
        logger.info("════════════════════════════════════════")
        logger.info("🔄 AUTO-COMPRA: Iniciando ciclo — %s", datetime.utcnow().isoformat())
        logger.info("════════════════════════════════════════")

        # NOTA: el barrido de pending_orders vencidas (_sweep_expired_pending_orders)
        # se llama desde inventory_replenishment_service.run_cycle(), NO desde aquí —
        # este run_cycle() de AutoPurchaseService no está conectado a ninguna tarea
        # de Celery ni a ningún endpoint activo (ver RECOVERY_FEATURE_PROGRESS.md).

        # ── Paso 0: Refrescar precios de proveedores antes de evaluar ─────────
        await self._refresh_supplier_prices()

        configs = await self._load_active_configs()
        if not configs:
            logger.info("Sin productos activos para auto-compra")
            return []

        logger.info("Productos a evaluar: %d", len(configs))

        semaphore = asyncio.Semaphore(5)

        async def bounded_process(cfg: PurchaseConfig) -> PurchaseResult:
            async with semaphore:
                return await self._process_product(cfg)

        tasks = [bounded_process(cfg) for cfg in configs]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        final: list[PurchaseResult] = []
        for cfg, result in zip(configs, results):
            if isinstance(result, Exception):
                logger.error("Error no capturado en product_id=%d: %s", cfg.product_id, result)
                final.append(PurchaseResult(
                    product_id=cfg.product_id,
                    product_name=cfg.product_name,
                    success=False,
                    error=str(result),
                ))
            else:
                final.append(result)

        self._log_cycle_summary(final)

        # ── Enviar resumen al bot de Telegram ──────────────────────────────
        total       = len(final)
        purchased   = sum(1 for r in final if r.codes_purchased > 0)
        skipped     = sum(1 for r in final if r.skipped_reason)
        errors_ct   = sum(1 for r in final if not r.success and not r.skipped_reason)
        total_codes = sum(r.codes_uploaded for r in final)

        lines = ["🤖 <b>Auto-compra completada</b>\n"]
        lines.append(f"📦 Activos:   <b>{total}</b>")
        lines.append(f"🛒 Comprados: <b>{purchased}</b>")
        lines.append(f"⏭️ Sobre umbral: <b>{skipped}</b>")
        lines.append(f"❌ Errores:   <b>{errors_ct}</b>")
        lines.append(f"🔑 Códigos:   <b>{total_codes}</b>")

        if purchased > 0:
            lines.append("\n✅ <b>Productos repuestos:</b>")
            for r in final:
                if r.codes_uploaded > 0:
                    lines.append(f"  • {r.product_name}: +{r.codes_uploaded} → stock {r.stock_after}")

        if errors_ct > 0:
            lines.append("\n⚠️ <b>Errores:</b>")
            for r in final:
                if not r.success and not r.skipped_reason:
                    lines.append(f"  • {r.product_name}: {r.error}")

        await telegram.broadcast("\n".join(lines))

        return final

    # ─── Procesar un producto ─────────────────────────────────────────────────

    async def _get_provider_price(self, provider_code: str, provider_sku: str, product_id: Optional[int] = None) -> Optional[float]:
        """
        Lee el cost_price desde Supabase (ya actualizado por _refresh_supplier_prices
        al inicio del ciclo) para comparar contra max_cost_usd antes de comprar.

        IMPORTANTE: filtra por product_id además de provider_sku.
        Varios productos pueden compartir el mismo provider_sku (ej: Roblox $5, $6, $7
        todos usan SKU=1250769 en Bamboo pero con distintos face_value), por lo que
        sin filtrar por product_id se leería el cost_price del producto equivocado.

        No filtramos por is_available: _refresh_supplier_prices actualiza precios
        sin importar disponibilidad, y necesitamos el precio aunque no haya stock ahora.
        """
        try:
            query = supabase.table("product_suppliers") \
                .select("cost_price, cost_currency") \
                .eq("provider_sku", str(provider_sku)) \
                .eq("is_active", True)

            # Filtrar por product_id para evitar leer el precio de otro producto
            # que comparte el mismo SKU de proveedor
            if product_id is not None:
                query = query.eq("product_id", product_id)

            ps = query.order("priority", desc=False).limit(1).execute()

            if not ps.data:
                logger.debug(
                    "[_get_provider_price] %s sku=%s product_id=%s: sin registro en Supabase",
                    provider_code, provider_sku, product_id
                )
                return None

            row = ps.data[0]
            cost_price = row.get("cost_price")
            if cost_price is None:
                logger.debug(
                    "[_get_provider_price] %s sku=%s product_id=%s: cost_price es None",
                    provider_code, provider_sku, product_id
                )
                return None

            return float(cost_price)  # siempre en USD (garantizado por _refresh_supplier_prices)

        except Exception as e:
            logger.warning("[_get_provider_price] %s sku=%s product_id=%s error: %s",
                           provider_code, provider_sku, product_id, e)

        return None

    # ─── Barrido de pending_orders vencidas (recuperación) ────────────────────

    async def _sweep_expired_pending_orders(self) -> None:
        """
        Revisa las 6 tablas de *_pending_orders y mueve al log de recuperación
        (status=UNRECOVERED) cualquier fila cuyo expires_at ya pasó y que nadie
        reclamó a tiempo. Sin esto, esas filas quedan huérfanas para siempre y
        el dinero pagado al proveedor sin códigos entregados pasa desapercibido.

        Se corre al inicio de cada run_cycle() (5x/día) — es seguro llamarlo
        más seguido de lo necesario porque _log_recovery() hace upsert por
        (provider, order_ref, product_id), así que nunca duplica filas en el log.
        """
        from datetime import datetime, timezone

        now_iso = datetime.now(timezone.utc).isoformat()

        # ── 1) Regla de los 2 días sobre las órdenes rastreadas ───────────────
        # Toda orden PENDING con >= 2 días desde su creación pasa a
        # "En recuperación" conservando solicitado/recibido/pendiente e
        # historial (no se borra), y se suelta su puntero *_pending_orders.
        moved = self._tracker.sweep_overdue()
        if moved:
            logger.warning("[Sweep] %d orden(es) con códigos pendientes pasaron a Recuperación (>%d días)",
                           len(moved), PENDING_ORDER_RECOVERY_DAYS)
            try:
                lines = [f"🗂️ <b>{len(moved)} orden(es) pasaron a Recuperación</b> "
                         f"(más de {PENDING_ORDER_RECOVERY_DAYS} días con códigos pendientes):"]
                for r in moved[:15]:
                    lines.append(
                        f"  • {r.get('provider')} <code>{r.get('order_ref')}</code>: "
                        f"{r.get('received_quantity') or 0}/{r.get('requested_quantity') or '?'} recibidos"
                    )
                await telegram.broadcast("\n".join(lines))
            except Exception:
                pass

        # ── 2) Barrido legado de punteros vencidos sin orden rastreada ────────
        # (nombre de tabla, provider, columna que sirve como order_ref)
        tables = [
            ("eneba_pending_orders",     "eneba_wholesale", "order_id"),
            ("ez_pending_orders",        "ez",              "transaction_id"),
            ("wgcards_pending_orders",   "wgcards",         "order_id"),
            ("wupex_pending_orders",     "wupex",           "order_name"),
            ("hankgames_pending_orders", "hankgames",       "order_id"),
            ("manastore_pending_orders", "manastore",       "order_ulid"),
        ]

        total_swept = 0

        for table_name, provider, ref_column in tables:
            try:
                expired = supabase.table(table_name) \
                    .select("*") \
                    .lt("expires_at", now_iso) \
                    .execute()
                rows = expired.data or []
            except Exception as e:
                logger.warning("[Sweep] Error consultando %s: %s", table_name, e)
                continue

            if not rows:
                continue

            logger.warning("[Sweep] %s: %d orden(es) vencida(s) sin recuperar", table_name, len(rows))

            for row in rows:
                order_ref = row.get(ref_column) or row.get("sku_id") or row.get("id")
                try:
                    await _log_recovery(
                        provider=provider,
                        product_id=row.get("product_id"),
                        order_ref=order_ref,
                        stage_at_resolution=row.get("stage"),  # solo eneba_pending_orders lo tiene
                        status="UNRECOVERED",
                        codes_count=0,
                        original_created_at=row.get("created_at"),
                        original_expires_at=row.get("expires_at"),
                        raw_metadata=row,
                    )
                    supabase.table(table_name).delete().eq("id", row["id"]).execute()
                    total_swept += 1
                except Exception as e:
                    logger.error(
                        "[Sweep] No se pudo mover a UNRECOVERED %s id=%s: %s",
                        table_name, row.get("id"), e
                    )

        if total_swept:
            logger.warning("[Sweep] ✅ %d orden(es) vencida(s) movida(s) a provider_recovery_log", total_swept)
            try:
                await telegram.broadcast(
                    f"🗂️ <b>Barrido de órdenes vencidas</b>\n"
                    f"{total_swept} orden(es) a proveedores expiraron sin recuperar código(s).\n"
                    f"Revísalas en el panel de recuperación."
                )
            except Exception:
                pass
        else:
            logger.info("[Sweep] Sin órdenes vencidas pendientes de barrer")

    async def _process_product(self, cfg: PurchaseConfig) -> PurchaseResult:
        result = PurchaseResult(
            product_id=cfg.product_id,
            product_name=cfg.product_name,
            success=True,
        )

        acquired = await _lock_manager.acquire(cfg.product_id)
        if not acquired:
            result.skipped_reason = "producto ya siendo procesado (lock activo)"
            logger.info("[%s] Saltando: %s", cfg.product_name, result.skipped_reason)
            return result

        try:
            # ── Paso 2: Stock actual desde Falabella ──────────────────────────
            logger.info("[%s] Consultando stock en Falabella (sku=%s)...", cfg.product_name, cfg.seller_sku)
            stock_map = await self.falabella.get_stock([cfg.seller_sku])
            stock_actual = stock_map.get(cfg.seller_sku, 0)
            result.stock_before = stock_actual

            logger.info("[%s] Stock actual: %d | Umbral: %d", cfg.product_name, stock_actual, cfg.umbral_minimo)

            # ── Paso 3: Actualizar stock local ────────────────────────────────
            await self._update_local_stock(cfg, stock_actual)

            # ── Paso 4: Evaluar si se necesita compra ─────────────────────────
            if stock_actual > cfg.umbral_minimo:
                result.skipped_reason = f"stock suficiente ({stock_actual} > {cfg.umbral_minimo})"
                logger.info("[%s] Sin acción necesaria: %s", cfg.product_name, result.skipped_reason)
                return result

            logger.info(
                "[%s] ⚡ Stock bajo umbral (%d <= %d) — iniciando auto-compra de %d unidades",
                cfg.product_name, stock_actual, cfg.umbral_minimo, cfg.cantidad_compra
            )

            # ── Paso 5: Comprar al proveedor (con fallback) ───────────────────
            try:
                codes, used_provider, skip_reason = await self._purchase_codes_with_fallback(cfg)
            except WGCardsOrderPending as e:
                # Pre-order WGCards: orden creada y guardada en BD.
                # No es un error — simplemente no hay códigos aún.
                result.skipped_reason = f"WGCards pre-order pendiente (orderId={e.order_id}) — se retomará en próximo ciclo"
                logger.info(
                    "[%s] ⏳ WGCards pre-order: orderId=%s guardado. Se retoma en próximo ciclo.",
                    cfg.product_name, e.order_id
                )
                await telegram.broadcast(
                    f"⏳ <b>{cfg.product_name}</b>\n"
                    f"WGCards: orden pre-order creada.\n"
                    f"orderId: <code>{e.order_id}</code>\n"
                    f"Los códigos llegarán en 1-3 días. Se verificará automáticamente."
                )
                return result
            
            except EnebaOrderPending as e:
                # La orden Eneba ya fue pagada — claves aún en camino.
                # No es un error, simplemente no hay códigos en este ciclo.
                stage_label = {
                    "ACTION_POLLING": "confirmando compra",
                    "EXPORT_PENDING": "generando ZIP de claves",
                    "DOWNLOAD_READY": "descargando claves",
                }.get(e.stage, e.stage)
 
                result.skipped_reason = (
                    f"Eneba orden pendiente ({stage_label}) — "
                    f"orderId={e.order_id} — se retomará en próximo ciclo"
                )
                logger.info(
                    "[%s] ⏳ Eneba: orderId=%s guardado (stage=%s). Retoma en próximo ciclo.",
                    cfg.product_name, e.order_id, e.stage
                )
                await telegram.broadcast(
                    f"⏳ <b>{cfg.product_name}</b>\n"
                    f"Eneba: orden pendiente ({stage_label}).\n"
                    f"orderId: <code>{e.order_id}</code>\n"
                    f"Se verificará automáticamente en el próximo ciclo."
                )
                return result

            except EZOrderPending as e:
                # La orden EZ ya fue facturada — códigos aún en PROCESSING.
                # No es un error, no ir a otro proveedor.
                result.skipped_reason = (
                    f"EZ API orden pendiente (transactionId={e.transaction_id}) — "
                    f"se retomará en próximo ciclo"
                )
                logger.info(
                    "[%s] ⏳ EZ API: transactionId=%s guardado. Se retoma en próximo ciclo.",
                    cfg.product_name, e.transaction_id
                )
                return result

            except HankgamesOrderPending as e:
                result.skipped_reason = f"Hankgames orden pendiente (orderId={e.order_id}) — se retomará en próximo ciclo"
                logger.info(
                    "[%s] ⏳ Hankgames: orderId=%s guardado. Se retoma en próximo ciclo.",
                    cfg.product_name, e.order_id
                )
                await telegram.broadcast(
                    f"⏳ <b>{cfg.product_name}</b>\n"
                    f"Hankgames: orden creada, códigos aún no disponibles.\n"
                    f"orderId: <code>{e.order_id}</code>\n"
                    f"Se verificará automáticamente en el próximo ciclo."
                )
                return result

            except ManastoreOrderPending as e:
                result.skipped_reason = f"Manastore orden pendiente (ulid={e.order_ulid}) — se retomará en próximo ciclo"
                logger.info(
                    "[%s] ⏳ Manastore: ulid=%s guardado. Se retoma en próximo ciclo.",
                    cfg.product_name, e.order_ulid
                )
                return result

            except ProviderOrderPending as e:
                result.skipped_reason = f"{e.provider} orden pendiente ({e.order_ref}) — se retomará en próximo ciclo"
                return result

            if not codes:
                result.success = False
                result.error = skip_reason or "Ningún proveedor devolvió códigos válidos"
                logger.error("[%s] ❌ Compra fallida: sin códigos tras intentar todos los proveedores", cfg.product_name)
                await telegram.send_replenishment_alert(
                    product_name=cfg.product_name,
                    channel="falabella",
                    codes_added=0,
                    new_stock=stock_actual,
                    provider=cfg.provider_code,
                    success=False,
                    error_msg=skip_reason or "Ningún proveedor devolvió códigos",
                )
                return result

            result.codes_purchased = len(codes)
            logger.info("[%s] ✅ Compra exitosa: %d código(s) obtenidos (proveedor=%s)", cfg.product_name, len(codes), used_provider)

            # ── Paso 6: Subir a HomeDelivery ──────────────────────────────────
            uploaded_count = await self._upload_to_homedelivery_with_retry(cfg, codes)

            del codes
            codes = []  # type: ignore

            if uploaded_count == 0:
                result.success = False
                result.error = f"Fallo subida a HomeDelivery tras {MAX_HD_RETRIES} reintentos"
                logger.error("[%s] ❌ Códigos comprados pero NO subidos a HD", cfg.product_name)
                await telegram.send_replenishment_alert(
                    product_name=cfg.product_name,
                    channel="falabella",
                    codes_added=0,
                    new_stock=stock_actual,
                    provider=used_provider or cfg.provider_code,
                    success=False,
                    error_msg="Fallo HomeDelivery — stock no actualizado",
                )
                return result

            result.codes_uploaded = uploaded_count
            logger.info("[%s] ✅ %d código(s) subidos a HomeDelivery", cfg.product_name, uploaded_count)

            # ── Paso 7: UpdateStock en Falabella ──────────────────────────────
            new_stock = stock_actual + uploaded_count
            feed_id = await self._update_falabella_stock(cfg, new_stock)

            result.stock_after = new_stock
            logger.info(
                "[%s] ✅ Stock actualizado en Falabella: %d → %d (feed_id=%s)",
                cfg.product_name, stock_actual, new_stock, feed_id
            )

            # ── Paso 8: Actualizar stock local ────────────────────────────────
            await self._update_local_stock(cfg, new_stock)

            # ── Paso 9: Obtener costo y saldo, notificar ──────────────────────
            cost_total, provider_balance, balance_currency = await self._get_cost_and_balance(
                cfg, uploaded_count
            )

            await telegram.send_replenishment_alert(
                product_name=cfg.product_name,
                channel="falabella",
                codes_added=uploaded_count,
                new_stock=new_stock,
                provider=used_provider or cfg.provider_code,
                success=True,
                cost_total=cost_total,
                provider_balance=provider_balance,
                balance_currency=balance_currency,
            )

            logger.info(
                "[%s] 🎉 Ciclo completado — comprados=%d subidos=%d stock=%d→%d gasto=$%.2f saldo=$%.2f",
                cfg.product_name, result.codes_purchased, uploaded_count,
                stock_actual, new_stock,
                cost_total or 0, provider_balance or 0,
            )

        except Exception as e:
            result.success = False
            result.error = str(e)
            logger.exception("[%s] ❌ Error inesperado: %s", cfg.product_name, e)

        finally:
            await _lock_manager.release(cfg.product_id)

        return result

    # ─── Compra con fallback entre proveedores ────────────────────────────────

    async def _call_provider_purchase(self, cfg: PurchaseConfig, p_code: str, supplier_info: dict) -> list:
        """Despacho a la integración de cada proveedor (sin cambios de lógica)."""
        if p_code == "bamboo":
            return await self._purchase_bamboo(cfg)
        if p_code in ("cardone", "99cards"):
            return await self._purchase_cardone(cfg)
        if p_code == "wgcards":
            return await self._purchase_wgcards(cfg, supplier_info)
        if p_code == "eneba":
            return await self._purchase_eneba(cfg, supplier_info)
        if p_code == "icodes":
            return await self._purchase_icodes(cfg)
        if p_code == "ez":
            return await self._purchase_ez(cfg)
        if p_code == "wupex":
            return await self._purchase_wupex(cfg, supplier_info)
        if p_code == "hankgames":
            return await self._purchase_hankgames(cfg, supplier_info)
        if p_code == "coda_voucher":
            return await self._purchase_coda_voucher(cfg, supplier_info)
        if p_code == "manastore":
            return await self._purchase_manastore(cfg, supplier_info)
        if p_code == "tisi":
            return await self._purchase_tisi(cfg, supplier_info)
        if p_code == "visoria":
            return await self._purchase_visoria(cfg, supplier_info)
        logger.error("[%s] Proveedor desconocido: %s", cfg.product_name, p_code)
        return []

    def _open_order_blocks(self, cfg: PurchaseConfig, open_order: dict) -> bool:
        """
        ¿La orden abierta impide comprar otro lote?
          - Envío ambiguo reciente → SÍ, siempre (pudo haberse ejecutado).
          - Orden PENDING → SÍ si lo que falta recibir alcanza para dejar el
            stock por encima del umbral (available + en_tránsito > umbral):
            comprar otro lote sería pagar dos veces el mismo déficit.
            Si ni recibiendo todo lo pendiente se supera el umbral, el
            déficit es mayor que la orden y se permite un lote adicional.
        """
        if open_order.get("status") != "PENDING":
            return True
        try:
            res = supabase.table("inventory_codes").select("id", count="exact") \
                .eq("product_id", cfg.product_id).eq("status", "available").execute()
            available = int(res.count or 0)
        except Exception:
            return True
        in_flight = self._tracker.in_flight_remaining(cfg.product_id)
        if available + in_flight > int(cfg.umbral_minimo or 0):
            return True
        logger.info(
            "[%s] Orden %s/%s pendiente (%d en camino) no cubre el umbral (%d disponibles ≤ %d): se permite otro lote",
            cfg.product_name, open_order.get("provider"), open_order.get("order_ref"),
            in_flight, available, cfg.umbral_minimo,
        )
        return False

    async def _purchase_codes_with_fallback(
        self, cfg: PurchaseConfig, provider_gate=None,
    ) -> tuple[list, str, str]:
        """
        Compra probando los proveedores en orden de prioridad.

        Protecciones (auditoría R2/R3):
          - Si el producto tiene una orden abierta de CUALQUIER proveedor que
            ya cubre el déficit (o un envío ambiguo reciente) →
            ProviderOrderPending: no se compra otro lote para el mismo déficit.
          - Si un proveedor falla DESPUÉS de enviar la orden → no se prueba el
            siguiente (ver _handle_failed_submit).

        provider_gate (opcional, Modo B): fábrica `gate(provider_code)` que
        devuelve un async context manager que limita la concurrencia por
        proveedor y puede lanzar ProviderCooldown si el proveedor está en
        pausa por 429. Sin gate el comportamiento es el del Modo A.
        """
        open_order = self._tracker.find_open_order(cfg.product_id)
        if open_order and not self._open_order_blocks(cfg, open_order):
            open_order = None
        if open_order:
            raise ProviderOrderPending(
                f"{open_order.get('provider')}: orden {open_order.get('order_ref')} abierta "
                f"({open_order.get('received_quantity') or 0}/{open_order.get('requested_quantity') or '?'}) "
                f"— no se compra otro lote hasta resolverla",
                provider=open_order.get("provider") or "",
                order_ref=str(open_order.get("order_ref")),
                product_id=cfg.product_id,
                requested_quantity=open_order.get("requested_quantity"),
                received_quantity=int(open_order.get("received_quantity") or 0),
                remaining_quantity=open_order.get("remaining_quantity"),
            )

        suppliers_to_try = cfg.suppliers_fallback if cfg.suppliers_fallback else [
            {
                "provider_code": cfg.provider_code,
                "provider_sku":  cfg.provider_sku,
                "provider_name": cfg.provider_code,
                "face_value":    cfg.face_value,
            }
        ]

        original_provider_code = cfg.provider_code
        original_provider_sku  = cfg.provider_sku
        original_face_value    = cfg.face_value

        skip_reasons: list[str] = []

        # Proveedores con una orden YA PAGADA de este producto que lleva
        # >= 15 min sin entregar códigos (liberada por release_stalled_orders en la reposición):
        # se saltan y se compra al siguiente. Esa orden se sigue recuperando.
        stalled_providers = self._tracker.released_providers(cfg.product_id)

        try:
            for supplier_info in suppliers_to_try:
                p_code = supplier_info.get("provider_code", "")
                p_sku  = supplier_info.get("provider_sku", "")
                p_name = supplier_info.get("provider_name", p_code)

                if not p_code:
                    continue

                if tracking_provider_code(p_code) in stalled_providers:
                    logger.warning("[%s] %s tiene una orden demorada sin códigos — se prueba el siguiente proveedor",
                                   cfg.product_name, p_name)
                    skip_reasons.append(f"{p_name}: orden anterior demorada (>15 min sin códigos)")
                    continue

                # ── verificar precio actual contra límite ─────────────────────
                if cfg.max_cost_usd:
                    current_price = await self._get_provider_price(p_code, p_sku, cfg.product_id)
                    if current_price is not None:
                        if current_price > cfg.max_cost_usd:
                            logger.warning(
                                "[%s] %s precio actual $%.4f supera límite $%.4f — saltando",
                                cfg.product_name, p_name, current_price, cfg.max_cost_usd
                            )
                            skip_reasons.append(
                                f"{p_name}: precio ${current_price:.4f} supera límite ${cfg.max_cost_usd:.4f}"
                            )
                            continue
                        else:
                            logger.info(
                                "[%s] %s precio actual $%.2f OK (límite $%.2f)",
                                cfg.product_name, p_name, current_price, cfg.max_cost_usd
                            )
                # ─────────────────────────────────────────────────────────────

                cfg.provider_code = p_code
                cfg.provider_sku  = p_sku
                cfg.face_value    = supplier_info.get("face_value")

                # ── Orden pendiente ya consultada hace poco (p. ej. en el paso
                # de reanudación automática de este mismo ciclo): no volver a
                # consultar ni comprar a otro proveedor — se espera lo pendiente.
                recent = self._tracker.find_recent_attempt(p_code, cfg.product_id)
                if recent:
                    raise ProviderOrderPending(
                        f"{p_name}: orden {recent.get('order_ref')} con "
                        f"{recent.get('remaining_quantity')} código(s) pendiente(s) "
                        f"ya consultada en este ciclo",
                        provider=tracking_provider_code(p_code),
                        order_ref=str(recent.get("order_ref")),
                        product_id=cfg.product_id,
                        requested_quantity=recent.get("requested_quantity"),
                        received_quantity=int(recent.get("received_quantity") or 0),
                        remaining_quantity=recent.get("remaining_quantity"),
                    )

                set_last_order_result(None)
                clear_submit_marker()

                try:
                    gate = provider_gate(p_code) if provider_gate else None
                    if gate is not None:
                        async with gate:
                            codes = await self._call_provider_purchase(cfg, p_code, supplier_info)
                    else:
                        codes = await self._call_provider_purchase(cfg, p_code, supplier_info)
                except ProviderOrderPending:
                    # Orden ya pagada — NO ir a otro proveedor, relanzar.
                    raise
                except ProviderCooldown as e:
                    skip_reasons.append(f"{p_name}: en pausa por límite de solicitudes ({e})")
                    continue
                except Exception as e:
                    await self._handle_failed_submit(cfg, p_name, e)   # puede relanzar
                    logger.error(
                        "[%s] Proveedor %s falló con error: %s — probando siguiente...",
                        cfg.product_name, p_name, e
                    )
                    skip_reasons.append(f"{p_name}: error al comprar ({e})")
                    codes = []
                    logger.warning("[%s] ⚠️ %s sin códigos, probando siguiente proveedor...", cfg.product_name, p_name)
                    continue
                finally:
                    clear_submit_marker()

                if codes:
                    logger.info("[%s] ✅ %s devolvió %d código(s)", cfg.product_name, p_name, len(codes))
                    return codes, p_code, ""

                # Si con este proveedor ya se creó/registró una orden, NUNCA
                # comprar a otro: lo que falte se recupera de ESA orden.
                settled = get_last_order_result()
                if settled is not None and settled.product_id == cfg.product_id:
                    return [], p_code, (
                        f"{p_name}: orden {settled.order_id} sin códigos nuevos "
                        f"({settled.total_received_quantity}/{settled.requested_quantity})"
                    )

                # Solo llegamos aquí si no hubo excepción pero tampoco hubo códigos
                skip_reasons.append(f"{p_name}: sin stock")
                logger.warning("[%s] ⚠️ %s sin códigos, probando siguiente proveedor...", cfg.product_name, p_name)

        finally:
            cfg.provider_code = original_provider_code
            cfg.provider_sku  = original_provider_sku
            cfg.face_value    = original_face_value

        return [], "", " | ".join(skip_reasons)

    # ─── Costo y saldo del proveedor ──────────────────────────────────────────

    async def _get_cost_and_balance(
        self,
        cfg: PurchaseConfig,
        qty: int,
    ) -> tuple[Optional[float], Optional[float], str]:
        """
        Retorna (costo_total, saldo_restante, moneda).
        Consulta el cost_price real desde Supabase y el balance vía API del proveedor.
        """
        cost_total: Optional[float] = None
        provider_balance: Optional[float] = None
        balance: Optional[float] = None
        currency: str = "USD"
        provider: Optional[str] = None

        # ── 1. Costo unitario desde product_suppliers ─────────────────────────
        try:
            # Costo del proveedor que REALMENTE vendió (cfg.provider_code), no
            # el de priority=1 (auditoría R6). Si no se encuentra, el de mayor
            # prioridad como antes.
            ps = supabase.table("product_suppliers") \
                .select("cost_price, cost_currency, priority, provider:providers(code)") \
                .eq("product_id", cfg.product_id) \
                .eq("is_active", True) \
                .order("priority", desc=False) \
                .execute()

            rows = ps.data or []
            match = next((r for r in rows
                          if ((r.get("provider") or {}).get("code") or "").lower() == (cfg.provider_code or "").lower()),
                         rows[0] if rows else None)
            if match:
                unit_cost  = float(match.get("cost_price") or 0)
                currency   = (match.get("cost_currency") or "USD").upper()
                cost_total = round(unit_cost * qty, 2)
                logger.debug("[%s] cost_price=%.4f x %d = %.2f %s",
                             cfg.product_name, unit_cost, qty, cost_total, currency)
        except Exception as e:
            logger.warning("[%s] No se pudo obtener cost_price: %s", cfg.product_name, e)

        # ── 2. Saldo real según proveedor ─────────────────────────────────────
        balance_currency = "USD"  # todos los proveedores son USD-only, excepto WgCards
        try:
            if cfg.provider_code == "bamboo":
                balance = await self._get_bamboo_balance()
            elif cfg.provider_code == "ez":
                balance = await self._get_ez_balance()
            elif cfg.provider_code in ("cardone", "99cards"):
                balance = await self._get_cardone_balance()
            elif cfg.provider_code == "wgcards":
                balance, balance_currency = await self._get_wgcards_balance(cfg)
            elif cfg.provider_code == "icodes":
                balance = await self._get_icodes_balance()
            elif cfg.provider_code == "wupex":
                balance = await self._get_wupex_balance()
            elif cfg.provider_code == "hankgames":
                balance = await self._get_hankgames_balance()
            elif cfg.provider_code == "coda_voucher":
                balance = await self._get_coda_voucher_balance()
            elif cfg.provider_code == "manastore":
                balance = await self._get_manastore_balance()
            elif cfg.provider_code == "tisi":
                balance = await self._get_tisi_balance()
            elif cfg.provider_code == "visoria":
                balance = await self._get_visoria_balance()
            else:
                logger.warning("[%s] provider_code=%s sin función de saldo mapeada",
                               cfg.product_name, cfg.provider_code)
        except Exception as e:
            logger.warning("[%s] No se pudo obtener saldo de %s: %s",
                           cfg.product_name, cfg.provider_code, e)

        if balance is not None:
            try:
                await self._check_and_alert_low_balance(cfg.provider_code, balance_currency, balance)
            except Exception as e:
                logger.warning("[%s] fallo al chequear umbral de saldo de %s: %s",
                               cfg.product_name, cfg.provider_code, e)

        return cost_total, balance, currency

    async def _check_and_alert_low_balance(self, provider_code: str, balance_currency: str, balance: float) -> None:
        """
        Compara el saldo recién consultado contra el umbral configurado en
        provider_balance_thresholds y, si está por debajo, manda un push
        nativo a la app Android. Solo avisa una vez mientras el saldo siga
        bajo — se vuelve a avisar si se recupera por encima del umbral y
        luego vuelve a bajar (evita spamear en cada ciclo de reposición).

        La clave es "{provider_code}_{moneda}" (ej. "wgcards_usd", "wgcards_eur")
        porque WgCards opera en USD y EUR con saldos independientes — un solo
        umbral compartido mezclaría dos montos que no son comparables.
        """
        # "99cards" es un alias legado de "cardone" — normalizamos para que
        # ambos compartan el mismo umbral y no queden como filas separadas.
        normalized_provider = "cardone" if provider_code == "99cards" else provider_code
        threshold_key = f"{normalized_provider}_{balance_currency.lower()}"

        th_resp = supabase.table("provider_balance_thresholds") \
            .select("threshold_usd").eq("provider", threshold_key).limit(1).execute()
        if not th_resp.data:
            return  # sin umbral configurado para esta combinación proveedor+moneda

        threshold = float(th_resp.data[0]["threshold_usd"])

        alert_resp = supabase.table("provider_balance_alerts") \
            .select("is_low").eq("provider", threshold_key).limit(1).execute()
        was_low = bool(alert_resp.data[0]["is_low"]) if alert_resp.data else False

        is_low = balance < threshold
        label = f"{provider_code} ({balance_currency})" if balance_currency != "USD" else provider_code

        if is_low and not was_low:
            from app.core.push import send_push_to_all
            send_push_to_all(
                title=f"⚠️ Saldo bajo en {label}",
                body=f"Saldo actual: ${balance:.2f} {balance_currency} (umbral: ${threshold:.2f})",
                data={"provider": provider_code, "currency": balance_currency, "balance": balance, "threshold": threshold},
            )
            logger.warning("[%s] saldo bajo detectado ($%.2f %s < $%.2f) — push enviado",
                           label, balance, balance_currency, threshold)

        if is_low != was_low:
            from datetime import datetime, timezone
            supabase.table("provider_balance_alerts").upsert({
                "provider": threshold_key,
                "is_low": is_low,
                "balance": balance,
                "threshold": threshold,
                "sent_at": datetime.now(timezone.utc).isoformat() if is_low and not was_low else None,
            }, on_conflict="provider").execute()

    async def _get_bamboo_balance(self) -> Optional[float]:
        """Lee saldo de la cuenta activa de Bamboo en USD (ignora cuentas EUR, ej. la 895)."""
        bamboo = BambooClient()
        accounts_resp = await bamboo.get_accounts()
        account_list  = accounts_resp.get("accounts", [])
        active_usd    = [
            a for a in account_list
            if a.get("isActive") and (a.get("currency") or "").upper() == "USD"
        ]

        if not active_usd:
            return None

        for field_name in ("balance", "availableBalance", "creditBalance", "amount", "credit", "funds"):
            val = active_usd[0].get(field_name)
            if val is not None:
                try:
                    return round(float(val), 2)
                except (ValueError, TypeError):
                    pass
        return None

    async def _get_ez_balance(self) -> Optional[float]:
        """Lee saldo USD de EZ API."""
        from app.providers.ez_client import EZClient
        ez = EZClient()
        balances = await ez.get_balances(currency="USD")

        if not isinstance(balances, list) or not balances:
            return None

        for b in balances:
            if (b.get("currency") or "").upper() == "USD":
                raw = b.get("balance") or b.get("amount") or "0"
                try:
                    return round(float(str(raw).replace(",", "")), 2)
                except (ValueError, TypeError):
                    pass

        raw = balances[0].get("balance") or balances[0].get("amount") or "0"
        try:
            return round(float(str(raw).replace(",", "")), 2)
        except (ValueError, TypeError):
            return None

    async def _get_cardone_balance(self) -> Optional[float]:
        """Lee saldo USD de CardOne vía /get_profile."""
        import httpx
        import json as _json

        cardone = get_cardone_client()
        token   = await cardone.get_access_token()

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                f"{cardone.base_url}/get_profile",
                headers={"Authorization": f"Bearer {token}"},
            )

        if resp.status_code != 200:
            logger.warning("[CardOne] /get_profile devolvió HTTP %d", resp.status_code)
            return None

        raw = resp.text.strip()

        try:
            data = _json.loads(raw)
        except Exception:
            try:
                decrypted = await cardone._decrypt(raw)
                data = _json.loads(decrypted)
            except Exception as e:
                logger.warning("[CardOne] No se pudo parsear /get_profile: %s", e)
                return None

        if data.get("statusCode") != "200":
            return None

        profile = data.get("data") or {}
        bal_usd = profile.get("balance_USD") or 0
        try:
            return round(float(bal_usd), 2)
        except (ValueError, TypeError):
            return None

    # ─── Compra al proveedor ──────────────────────────────────────────────────

    async def _purchase_bamboo(self, cfg: PurchaseConfig) -> list[str]:
        import uuid

        bamboo = BambooClient()

        # ── ¿Orden pendiente (parcial o sin entregar)? → retomar ESA orden ────
        pending_row = self._tracker.find_pending("bamboo", cfg.product_id, str(cfg.provider_sku))
        if pending_row:
            logger.info("[%s] Bamboo: retomando orden pendiente %s (%s/%s recibidos)",
                        cfg.product_name, pending_row.get("order_ref"),
                        pending_row.get("received_quantity"), pending_row.get("requested_quantity"))
            return await self._bamboo_resume(cfg, pending_row)

        accounts_resp = await bamboo.get_accounts()
        account_list  = accounts_resp.get("accounts", [])
        account = next((a for a in account_list if a.get("isActive")), None)
        if not account:
            raise RuntimeError("Bamboo: sin cuentas activas")

        request_id = str(uuid.uuid4())

        if cfg.face_value and cfg.face_value > 0:
            face_value = cfg.face_value
            logger.info("[%s] Usando face_value configurado: %s", cfg.product_name, face_value)
        else:
            catalog = await bamboo.get_catalog(product_id=int(cfg.provider_sku), page_size=10)
            brands  = catalog.get("items", [])
            face_value = None
            for brand in brands:
                for p in brand.get("products", []):
                    if str(p.get("id")) == str(cfg.provider_sku):
                        face_value = p.get("minFaceValue")
                        break
                if face_value is not None:
                    break

            if face_value is None:
                raise RuntimeError(f"Bamboo: SKU {cfg.provider_sku} no encontrado en catálogo")

        if face_value is None:
            logger.warning(
                "[%s] Bamboo: SKU %s no encontrado en catálogo, usando face_value del supplier",
                cfg.product_name, cfg.provider_sku
            )
            try:
                ps = supabase.table("product_suppliers") \
                    .select("cost_price") \
                    .eq("product_id", cfg.product_id) \
                    .eq("provider_sku", str(cfg.provider_sku)) \
                    .limit(1).execute()
                if ps.data:
                    face_value = float(ps.data[0].get("cost_price") or 0)
                    logger.info("[%s] Usando cost_price=%s como face_value", cfg.product_name, face_value)
            except Exception as e:
                logger.warning("[%s] No se pudo obtener cost_price de Supabase: %s", cfg.product_name, e)

        if face_value is None:
            raise RuntimeError(f"Bamboo: SKU {cfg.provider_sku} no encontrado en catálogo")

        self._note_submit(cfg, "bamboo", cfg.cantidad_compra, client_ref=request_id,
                          meta={"request_id": request_id, "kind": "order"})
        await bamboo.place_order(
            request_id=request_id,
            account_id=account["id"],
            products=[{
                "product_id": int(cfg.provider_sku),
                "quantity":   cfg.cantidad_compra,
                "value":      face_value,
            }]
        )

        resume_meta = {"request_id": request_id, "kind": "order"}
        self._note_accepted(cfg, request_id, resume_meta)
        codes, failed, error = await self._bamboo_fetch_codes(
            cfg.product_name, request_id, expected=cfg.cantidad_compra,
        )
        if failed and not codes:
            # Orden rechazada sin entregar nada → igual que antes: ir al siguiente proveedor.
            note_rejected()
            self._tracker.discard_intent_if_empty("bamboo", request_id, cfg.product_id)
            raise RuntimeError(f"Bamboo orden fallida: {error or 'sin detalle'}")

        # Antes: si llegaban menos de los pedidos se daba por completa, y un
        # timeout hacía comprar a OTRO proveedor con la orden ya pagada.
        # Ahora: se valida la cantidad y lo faltante queda PENDING sobre ESTA orden.
        return await self._settle_order(
            cfg, provider="bamboo", order_ref=request_id,
            requested_quantity=cfg.cantidad_compra, fetched_codes=codes,
            resume_meta=resume_meta, terminal_failure=failed, error=error,
        )

    async def _bamboo_resume(self, cfg: PurchaseConfig, pending_row: dict, *, quick: bool = False,
                             manual: bool = False, source: str = "auto") -> list[str]:
        meta = pending_row.get("raw_metadata") or {}
        request_id = meta.get("request_id") or pending_row.get("order_ref")
        requested = pending_row.get("requested_quantity")
        codes, failed, error = await self._bamboo_fetch_codes(
            cfg.product_name, request_id, expected=requested, attempts=2 if quick else 30,
        )
        return await self._settle_order(
            cfg, provider="bamboo", order_ref=pending_row.get("order_ref") or request_id,
            requested_quantity=requested, fetched_codes=codes,
            terminal_failure=failed, error=error, manual=manual, source=source,
        )

    async def _bamboo_fetch_codes(
        self, product_name: str, request_id: str, expected: Optional[int],
        attempts: int = 30,
    ) -> tuple[list[str], bool, Optional[str]]:
        """
        Polling de la orden Bamboo. Devuelve (códigos_visibles, fallida, error).
        Sigue esperando mientras haya MENOS códigos de los esperados; al
        agotar los intentos devuelve lo mejor que haya visto (puede ser
        parcial o vacío) — la decisión de completitud la toma _settle_order.
        """
        bamboo = BambooClient()
        best: list[str] = []
        for attempt in range(attempts):
            await asyncio.sleep(3)
            try:
                order = await bamboo.get_order(request_id)
            except Exception:
                continue

            status = (order.get("status") or "").lower()
            logger.debug("[%s] Bamboo polling #%d status=%s", product_name, attempt + 1, status)

            codes: list[str] = []
            for item in order.get("items") or []:
                for card in item.get("cards") or []:
                    code = card.get("cardCode") or card.get("serialNumber")
                    if code:
                        codes.append(code)
            if len(codes) > len(best):
                best = codes

            if status in ("failed", "cancelled"):
                return best, True, order.get("errorMessage") or status
            if status in ("succeeded", "success", "completed") and best and (
                expected is None or len(best) >= expected
            ):
                return best, False, None
            if expected is not None and len(best) >= expected:
                return best, False, None

        if best:
            logger.warning("[%s] Bamboo: polling terminó con %d/%s código(s)", product_name, len(best), expected)
        else:
            logger.warning("[%s] Bamboo: timeout esperando códigos (request_id=%s)", product_name, request_id)
        return best, False, None

    async def _purchase_cardone(self, cfg: PurchaseConfig) -> list[str]:
        """
        Compra códigos en CardOne/99Cards.

        La respuesta de /get_order_info tiene esta estructura:
          {
            "statusCode": "200",
            "data": [{
              "pins": [
                {
                  "number": "<id interno>",   ← NO es el código
                  "pin":    "XXXX-XXXX-XXXX", ← ESTE es el código canjeable
                  "expiryDate": "...",
                  "type": "Text"
                }
              ]
            }]
          }

        Se lee 'pin' primero; 'number' se usa SOLO como fallback si 'pin' está vacío,
        ya que en algunos productos 'number' contiene el código real (tarjetas sin PIN).
        """
        import uuid

        cardone = get_cardone_client()

        # ── ¿Orden pendiente (parcial o sin entregar)? → retomar ESA orden ────
        pending_row = self._tracker.find_pending("cardone", cfg.product_id, str(cfg.provider_sku))
        if pending_row:
            logger.info("[%s] CardOne: retomando orden pendiente %s", cfg.product_name, pending_row.get("order_ref"))
            return await self._cardone_resume(cfg, pending_row)

        client_order_id = str(uuid.uuid4())

        self._note_submit(cfg, "cardone", cfg.cantidad_compra, client_ref=client_order_id,
                          meta={"client_order_id": client_order_id, "kind": "order"})
        result = await cardone.place_order(
            product_code=cfg.provider_sku,
            quantity=cfg.cantidad_compra,
            client_order_id=client_order_id,
        )

        logger.info("[%s] CardOne place_order raw result: %s", cfg.product_name, result)

        if not result:
            raise RuntimeError(f"CardOne: respuesta vacía en place_order. result={result}")

        if isinstance(result, dict):
            status_code = result.get("statusCode") or result.get("status")
            if status_code and str(status_code) != "200":
                error_msg = (
                    result.get("msg")
                    or result.get("message")
                    or (result.get("data") if isinstance(result.get("data"), str) else None)
                    or "sin detalle"
                )
                note_rejected()   # el proveedor respondió un error explícito
                raise RuntimeError(f"CardOne: error {status_code} — {error_msg}")
            items = result.get("data") or []
        elif isinstance(result, list):
            items = result
        else:
            raise RuntimeError(f"CardOne: respuesta inesperada — {type(result)}: {result}")

        if not items:
            raise RuntimeError(f"CardOne: data vacío en place_order. result completo: {result}")

        order_code = None
        delay_ms   = 10000

        first = items[0] if isinstance(items, list) and items else items
        if isinstance(first, dict):
            order_code = first.get("orderCode") or first.get("code") or first.get("orderId")
            delay_ms   = first.get("delay", 10000)

        if not order_code:
            raise RuntimeError(f"CardOne: sin orderCode en respuesta. items: {items}")

        logger.info("[%s] CardOne order_code=%s delay=%dms", cfg.product_name, order_code, delay_ms)
        self._note_accepted(cfg, str(order_code), {"order_code": str(order_code), "client_order_id": client_order_id})
        await asyncio.sleep(min(delay_ms / 1000.0, 30.0))

        codes, failed, error = await self._cardone_fetch_codes(
            cfg.product_name, order_code, expected=cfg.cantidad_compra,
        )
        if failed and not codes:
            note_rejected()
            self._tracker.discard_intent_if_empty("cardone", str(order_code), cfg.product_id)
            raise RuntimeError(f"CardOne: orden {order_code} falló con status={error}")

        return await self._settle_order(
            cfg, provider="cardone", order_ref=str(order_code),
            requested_quantity=cfg.cantidad_compra, fetched_codes=codes,
            resume_meta={"order_code": str(order_code), "client_order_id": client_order_id, "kind": "order"},
            terminal_failure=failed, error=error,
        )

    async def _cardone_resume(self, cfg: PurchaseConfig, pending_row: dict, *, quick: bool = False,
                              manual: bool = False, source: str = "auto") -> list[str]:
        meta = pending_row.get("raw_metadata") or {}
        order_code = meta.get("order_code") or pending_row.get("order_ref")
        requested = pending_row.get("requested_quantity")
        codes, failed, error = await self._cardone_fetch_codes(
            cfg.product_name, order_code, expected=requested, attempts=2 if quick else 30,
        )
        return await self._settle_order(
            cfg, provider="cardone", order_ref=pending_row.get("order_ref") or order_code,
            requested_quantity=requested, fetched_codes=codes,
            terminal_failure=failed, error=error, manual=manual, source=source,
        )

    async def _cardone_fetch_codes(
        self, product_name: str, order_code: str, expected: Optional[int], attempts: int = 30,
    ) -> tuple[list[str], bool, Optional[str]]:
        """
        Polling de /get_order_info. Devuelve (códigos_visibles, fallida, error).
        Espera mientras haya menos códigos que los esperados.
        """
        cardone = get_cardone_client()
        best: list[str] = []
        for attempt in range(attempts):
            try:
                order_detail = await cardone.get_order(order_code)
                logger.debug(
                    "[%s] CardOne get_order #%d: %s",
                    product_name, attempt + 1, str(order_detail)[:300]
                )

                if isinstance(order_detail, dict):
                    order_data = order_detail.get("data") or []
                elif isinstance(order_detail, list):
                    order_data = order_detail
                else:
                    order_data = []

                codes: list[str] = []
                items_list = order_data if isinstance(order_data, list) else [order_data]
                for item in items_list:
                    if not isinstance(item, dict):
                        continue
                    for pin in item.get("pins") or item.get("cards") or []:
                        # ── PRIORIDAD CORRECTA ────────────────────────────────
                        # 'pin'    → código canjeable (gift card / Nintendo / etc.)
                        # 'number' → ID interno de CardOne (NO usar como código)
                        #            EXCEPCIÓN: si 'pin' está vacío, algunos productos
                        #            usan 'number' como el código real.
                        code = (
                            pin.get("pin")      or   # campo correcto según la doc
                            pin.get("pinCode")  or   # alias alternativo
                            pin.get("code")     or   # otro alias
                            pin.get("cardCode") or   # otro alias
                            pin.get("number")        # fallback: solo si los anteriores están vacíos
                        )
                        if code:
                            codes.append(str(code).strip())
                if len(codes) > len(best):
                    best = codes

                if best and (expected is None or len(best) >= expected):
                    logger.info("[%s] CardOne: %d código(s) obtenidos", product_name, len(best))
                    return best, False, None

                # Verificar si la orden ya falló o el proveedor devolvió error terminal
                # 99Cards usa statusCode en el cuerpo (no HTTP status):
                #   420 = sin stock al precio ofrecido (sold out / restock in progress)
                #   421 = Stock Insufficient (sin stock suficiente en este momento)
                #   422 = precio fuera de rango
                # Estos son errores terminales: no tiene sentido seguir reintentando.
                status_code = None
                status = None
                if isinstance(order_detail, dict):
                    status_code = str(order_detail.get("statusCode") or "")
                    inner = order_detail.get("data") or {}
                    status = (
                        inner.get("status") or
                        inner.get("orderStatus") or
                        order_detail.get("status")
                    ) if isinstance(inner, dict) else None

                TERMINAL_STATUS_CODES = {"420", "421", "422"}
                if status_code in TERMINAL_STATUS_CODES:
                    error_msg = f"CardOne statusCode={status_code}: {order_detail.get('data', '')}"
                    logger.warning("[%s] CardOne: error terminal %s — dejando de reintentar", product_name, error_msg)
                    return best, True, error_msg

                if status and str(status).upper() in ("FAILED", "CANCELLED", "ERROR"):
                    return best, True, str(status)

            except Exception as e:
                logger.debug("[%s] CardOne polling #%d error: %s", product_name, attempt + 1, e)

            await asyncio.sleep(3)

        logger.warning("[%s] CardOne: polling terminó con %d/%s código(s) para order_code=%s",
                       product_name, len(best), expected, order_code)
        return best, False, None

    async def _purchase_ez(self, cfg: PurchaseConfig) -> list[str]:
        from app.providers.ez_client import EZClient

        ez = EZClient()

        # ── PASO 1: ¿Existe orden pendiente? → pedir SOLO lo que falta de ESA orden ──
        existing = await self._ez_get_pending_order(cfg.product_id, cfg.provider_sku)
        if existing:
            logger.info("[%s] EZ API: retomando transactionId=%s", cfg.product_name, existing)
            tracked = self._tracker.get("ez", existing, cfg.product_id)
            requested = (tracked or {}).get("requested_quantity") or cfg.cantidad_compra
            codes = await self._ez_poll_codes(ez, cfg, existing, expected=requested)
            return await self._settle_order(
                cfg, provider="ez", order_ref=existing, requested_quantity=requested,
                fetched_codes=codes,
                resume_meta={"transaction_id": existing, "provider_sku": cfg.provider_sku, "kind": "order"},
                pending_exc=EZOrderPending(existing, cfg.provider_sku, cfg.product_id),
            )

        # ── PASO 2: Bulk order (agrupada con otros productos EZ del mismo ciclo) ──
        logger.info("[%s] EZ API: solicitando compra sku=%s qty=%d (se agrupará con otras si llegan en la misma ventana)",
                    cfg.product_name, cfg.provider_sku, cfg.cantidad_compra)

        batch_result = await self._ez_batch.request(cfg)
        if batch_result["error"]:
            raise RuntimeError(f"EZ API: fallo en orden agrupada: {batch_result['error']}")

        transaction_id = batch_result["transaction_id"]
        logger.info("[%s] EZ API: transactionId=%s (orden agrupada)", cfg.product_name, transaction_id)

        # ── PASO 3: Polling + validación de cantidad ─────────────────────────
        codes = await self._ez_poll_codes(ez, cfg, transaction_id, expected=cfg.cantidad_compra)

        async def _save():
            await self._ez_save_pending_order(cfg.product_id, cfg.provider_sku, transaction_id)
            if not codes:
                await telegram.broadcast(
                    f"⏳ <b>{cfg.product_name}</b>\n"
                    f"EZ API: orden en PROCESSING.\n"
                    f"transactionId: <code>{transaction_id}</code>\n"
                    f"Se verificará automáticamente en el próximo ciclo."
                )

        return await self._settle_order(
            cfg, provider="ez", order_ref=transaction_id,
            requested_quantity=cfg.cantidad_compra, fetched_codes=codes,
            resume_meta={"transaction_id": transaction_id, "provider_sku": cfg.provider_sku, "kind": "order"},
            save_pending=_save,
            pending_exc=EZOrderPending(transaction_id, cfg.provider_sku, cfg.product_id),
        )

    async def _ez_poll_codes(
        self, ez, cfg: PurchaseConfig, transaction_id: str,
        expected: Optional[int] = None, quick: bool = False,
    ) -> list[str]:
        """
        Polling de códigos EZ (~2 min, o 1 consulta en modo quick).
        Antes cortaba en cuanto aparecía el PRIMER código (2 de 10 se daban
        por completos). Ahora sigue esperando mientras falten códigos y
        devuelve lo mejor que vio — la completitud la decide _settle_order.
        """
        POLL_INTERVALS = [2] if quick else [5, 5, 10, 10, 15, 15, 20, 20, 30, 30]
        best: list[str] = []

        for i, wait in enumerate(POLL_INTERVALS):
            await asyncio.sleep(wait)
            try:
                ez_codes = await ez.get_codes(transaction_id=transaction_id, sku=cfg.provider_sku)
                logger.info("[%s] EZ API polling #%d transactionId=%s → %d código(s)",
                            cfg.product_name, i + 1, transaction_id, len(ez_codes))

                codes = [str(c.get("redeem_code") or c.get("redeemCode")).strip()
                         for c in ez_codes if c.get("redeem_code") or c.get("redeemCode")]
                if len(codes) > len(best):
                    best = codes
                if best and (expected is None or len(best) >= expected):
                    logger.info("[%s] EZ API: %d código(s) obtenidos en intento #%d",
                                cfg.product_name, len(best), i + 1)
                    return best

            except Exception as e:
                logger.warning("[%s] EZ API polling #%d error: %s", cfg.product_name, i + 1, e)

        logger.info("[%s] EZ API: polling finalizado con %d/%s código(s) para transactionId=%s",
                    cfg.product_name, len(best), expected, transaction_id)
        return best

    async def _ez_get_pending_order(self, product_id: int, provider_sku: str) -> Optional[str]:
        try:
            from datetime import datetime, timezone
            now_iso = datetime.now(timezone.utc).isoformat()
            result = supabase.table("ez_pending_orders") \
                .select("transaction_id") \
                .eq("product_id", product_id) \
                .eq("provider_sku", provider_sku) \
                .gt("expires_at", now_iso) \
                .limit(1) \
                .execute()
            if result.data:
                return result.data[0]["transaction_id"]
        except Exception as e:
            logger.warning("[EZ] _ez_get_pending_order error: %s", e)
        return None

    async def _ez_save_pending_order(self, product_id: int, provider_sku: str, transaction_id: str) -> None:
        try:
            created_iso, expires_iso = _pending_expiry_iso()
            supabase.table("ez_pending_orders").upsert({
                "product_id":     product_id,
                "provider_sku":   provider_sku,
                "transaction_id": transaction_id,
                "created_at":     created_iso,
                "expires_at":     expires_iso,
            }, on_conflict="product_id,provider_sku").execute()
            logger.info("[EZ] Orden pendiente guardada: product_id=%d sku=%s transactionId=%s",
                        product_id, provider_sku, transaction_id)
        except Exception as e:
            logger.error("[EZ] No se pudo guardar orden pendiente (transactionId=%s): %s", transaction_id, e)

    async def _ez_delete_pending_order(
        self, product_id: int, provider_sku: str,
        status: str = "RECOVERED", codes_count: int = 0,
    ) -> None:
        try:
            row = supabase.table("ez_pending_orders") \
                .select("*") \
                .eq("product_id", product_id) \
                .eq("provider_sku", provider_sku) \
                .limit(1).execute()
            pending_row = row.data[0] if row.data else {}

            # La completitud la decide _settle_order (validación de cantidades);
            # aquí solo se registran desenlaces terminales (UNRECOVERED).
            if status != STATUS_COMPLETED:
                await _log_recovery(
                    provider="ez",
                    product_id=product_id,
                    order_ref=pending_row.get("transaction_id") or provider_sku,
                    status=status,
                    codes_count=codes_count,
                    original_created_at=pending_row.get("created_at"),
                    original_expires_at=pending_row.get("expires_at"),
                    raw_metadata=pending_row,
                )

            supabase.table("ez_pending_orders") \
                .delete() \
                .eq("product_id", product_id) \
                .eq("provider_sku", provider_sku) \
                .execute()
            logger.info("[EZ] Orden pendiente eliminada: product_id=%d sku=%s status=%s", product_id, provider_sku, status)
        except Exception as e:
            logger.warning("[EZ] No se pudo eliminar orden pendiente: %s", e)

    # ─── HomeDelivery con retry ───────────────────────────────────────────────

    async def _upload_to_homedelivery_with_retry(
        self,
        cfg: PurchaseConfig,
        codes: list[str],
    ) -> int:
        cupones = [{"codigo": code, "sku": cfg.shop_sku} for code in codes]

        for attempt in range(1, MAX_HD_RETRIES + 1):
            logger.info(
                "[%s] HD upload intento %d/%d — %d cupones",
                cfg.product_name, attempt, MAX_HD_RETRIES, len(cupones)
            )
            try:
                hd_result  = await self.hd_client.cargar_cupones(cupones)
                creados    = hd_result.get("cupones_creados", 0)
                duplicados = hd_result.get("cupones_duplicados", 0)

                logger.info(
                    "[%s] HD intento %d OK — creados=%d duplicados=%d",
                    cfg.product_name, attempt, creados, duplicados
                )

                if creados > 0:
                    return creados
                if duplicados > 0:
                    logger.warning("[%s] HD: todos duplicados (%d)", cfg.product_name, duplicados)
                    return duplicados

                logger.warning("[%s] HD intento %d: 0 cupones creados", cfg.product_name, attempt)

            except Exception as e:
                wait = min(HD_BACKOFF_BASE ** attempt, HD_BACKOFF_MAX)
                logger.error(
                    "[%s] HD intento %d/%d falló: %s — esperando %.1fs",
                    cfg.product_name, attempt, MAX_HD_RETRIES, e, wait
                )
                if attempt < MAX_HD_RETRIES:
                    await asyncio.sleep(wait)

        logger.error("[%s] ❌ HD falló en todos los %d intentos", cfg.product_name, MAX_HD_RETRIES)
        return 0

    # ─── UpdateStock Falabella ────────────────────────────────────────────────

    async def _update_falabella_stock(self, cfg: PurchaseConfig, new_stock: int) -> str:
        logger.info(
            "[%s] UpdateStock Falabella: sku=%s cantidad=%d",
            cfg.product_name, cfg.seller_sku, new_stock
        )
        feed = await self.falabella.update_stock(cfg.seller_sku, new_stock)
        return feed.get("feed_id", "unknown")

    # ─── Helpers BD ───────────────────────────────────────────────────────────

    # Proveedor (providers.code) → método de actualización de precios.
    # "eneba" es el providers.code real de Eneba Wholesale; antes solo se
    # despachaba "eneba_wholesale" y Eneba nunca se actualizaba (auditoría §2).
    _PRICE_REFRESHERS = {
        "bamboo":          "_refresh_bamboo_prices",
        "cardone":         "_refresh_cardone_prices",
        "99cards":         "_refresh_cardone_prices",
        "wgcards":         "_refresh_wgcards_prices",
        "icodes":          "_refresh_icodes_prices",
        "ez":              "_refresh_ez_prices",
        "eneba":           "_refresh_eneba_wholesale_prices",
        "eneba_wholesale": "_refresh_eneba_wholesale_prices",
        "hankgames":       "_refresh_hankgames_prices",
        "wupex":           "_refresh_wupex_prices",
        "coda_voucher":    "_refresh_coda_voucher_prices",
        "manastore":       "_refresh_manastore_prices",
        "visoria":         "_refresh_visoria_prices",
    }

    def _load_suppliers_for_refresh(self, product_ids: Optional[list[int]] = None) -> list[dict]:
        q = supabase.table("product_suppliers") \
            .select("id, product_id, provider_sku, provider_item_id, cost_price, cost_currency, face_value, metadata, provider:providers(code), product:products(name)") \
            .eq("is_active", True)  # is_available no se filtra: queremos precio aunque no haya stock
        if product_ids is not None:
            q = q.in_("product_id", list(product_ids))
        return q.execute().data or []

    async def _refresh_supplier_list(self, suppliers: list[dict]) -> dict:
        """
        Despacha la actualización agrupando por proveedor (UNA llamada por lote
        según lo que permita cada API). Devuelve
        {"updated": N, "errors": N, "refreshed_ids": [...], "providers": {...}}.
        refreshed_ids = proveedores cuyo método terminó sin excepción.
        """
        by_provider: dict[str, list[dict]] = {}
        for s in suppliers:
            code = ((s.get("provider") or {}).get("code") or "").lower()
            if code:
                by_provider.setdefault(code, []).append(s)

        updated = errors = 0
        refreshed_ids: list[int] = []
        per_provider: dict[str, str] = {}
        for provider_code, supplier_list in by_provider.items():
            method_name = self._PRICE_REFRESHERS.get(provider_code)
            if not method_name:
                # Sin actualización implementada (p. ej. TISI: precio fijo de
                # catálogo). Se considera vigente: no hay nada que consultar.
                logger.debug("[PriceRefresh] Proveedor %s sin refresh implementado", provider_code)
                refreshed_ids.extend(s["id"] for s in supplier_list)
                per_provider[provider_code] = "sin_refresh"
                continue
            try:
                updated += await getattr(self, method_name)(supplier_list)
                refreshed_ids.extend(s["id"] for s in supplier_list)
                per_provider[provider_code] = "ok"
            except Exception as e:
                logger.warning("[PriceRefresh] Error actualizando %s: %s", provider_code, e)
                errors += 1
                per_provider[provider_code] = f"error: {e}"
        return {"updated": updated, "errors": errors, "refreshed_ids": refreshed_ids,
                "providers": per_provider}

    async def _refresh_supplier_prices(self, product_ids: Optional[list[int]] = None) -> dict:
        """
        Actualiza cost_price/cost_currency en product_suppliers consultando el
        catálogo de cada proveedor y, AL TERMINAR, reordena las prioridades
        por precio (misma regla que el botón manual). Antes este método no
        reordenaba y el ciclo compraba en un orden de prioridad viejo.

        product_ids=None → todos los proveedores activos (comportamiento del
        Modo A, sin cambios de alcance). Con lista → solo esos productos
        (botón manual y Modo B).
        """
        logger.info("[PriceRefresh] ── Actualizando precios de proveedores (%s) ──",
                    "todos" if product_ids is None else f"{len(product_ids)} producto(s)")
        try:
            suppliers = self._load_suppliers_for_refresh(product_ids)
        except Exception as e:
            logger.warning("[PriceRefresh] No se pudo cargar product_suppliers: %s", e)
            return {"updated": 0, "errors": 1, "refreshed_ids": [], "providers": {}, "resort": None}

        if not suppliers:
            logger.info("[PriceRefresh] Sin suppliers activos, saltando.")
            return {"updated": 0, "errors": 0, "refreshed_ids": [], "providers": {}, "resort": None}

        summary = await self._refresh_supplier_list(suppliers)

        # Reordenar SIEMPRE después de actualizar (también si hubo errores
        # parciales: los proveedores que fallaron conservan su último precio).
        try:
            from app.services.supplier_priority import resort_products
            touched = sorted({s["product_id"] for s in suppliers})
            summary["resort"] = await resort_products(touched)
        except Exception as e:
            logger.error("[PriceRefresh] No se pudo reordenar proveedores: %s", e)
            summary["resort"] = {"error": str(e)}

        try:
            from app.services.price_freshness import mark_fresh
            await mark_fresh(summary["refreshed_ids"])
        except Exception as e:
            logger.debug("[PriceRefresh] no se pudo registrar vigencia de precios: %s", e)

        logger.info(
            "[PriceRefresh] ✅ Completado — actualizados=%d errores=%d reordenados=%s",
            summary["updated"], summary["errors"], (summary.get("resort") or {}).get("updated_rows"),
        )
        return summary

    # Proveedores cuyo refresh descarga el catálogo COMPLETO de una vez (el
    # costo en llamadas no depende de cuántos SKUs se actualicen):
    #   bamboo  → get_catalog_v1 (1 llamada; con pocos SKUs usa v2, ver
    #             BAMBOO_V2_MAX_SKUS)
    #   icodes  → get_varieties (1 llamada)
    #   wupex   → get_all_products (todas las páginas, siempre las mismas)
    # Para ellos se actualizan TODOS sus SKUs: no cuesta llamadas extra.
    # El resto (CardOne, Hankgames: 1 llamada por SKU; EZ, Eneba, WGCards,
    # Manastore, Coda: por lote o por producto) solo se consulta para los
    # productos que se van a comprar.
    CATALOG_WIDE_PROVIDERS = frozenset({"bamboo", "icodes", "wupex"})

    # Hasta este número de SKUs, Bamboo se consulta con v2 filtrando por
    # ProductId (1 llamada por SKU, ~1 s c/u por el rate limiter) en vez de
    # descargar el catálogo v1 completo (~18 s). Botón de un producto y
    # Modo B con pocos productos → v2; ciclo programado y "todos" → v1.
    BAMBOO_V2_MAX_SKUS = 5

    @staticmethod
    def _bamboo_skus(suppliers: list[dict]) -> set[str]:
        return {str(s["provider_sku"]) for s in suppliers
                if s.get("provider_sku") and ((s.get("provider") or {}).get("code") or "").lower() == "bamboo"}

    @staticmethod
    def _provider_code_of(supplier: dict) -> str:
        return ((supplier.get("provider") or {}).get("code") or "").lower()

    async def _refresh_and_resort(self, to_refresh: list[dict], resort_product_ids: set[int]) -> dict:
        from app.services.price_freshness import mark_fresh
        from app.services.supplier_priority import resort_products
        if not to_refresh:
            return {"updated": 0, "errors": 0, "refreshed_ids": [], "providers": {}, "resort": None}
        summary = await self._refresh_supplier_list(to_refresh)
        try:
            summary["resort"] = await resort_products(sorted(resort_product_ids | {s["product_id"] for s in to_refresh}))
        except Exception as e:
            logger.error("[PriceRefresh] No se pudo reordenar proveedores: %s", e)
            summary["resort"] = {"error": str(e)}
        await mark_fresh(summary["refreshed_ids"])
        return summary

    async def refresh_prices_for_cycle(self, product_ids_to_buy: list[int]) -> dict:
        """
        Modo A (ciclo programado): actualiza precios SOLO de los productos que
        están en el umbral o por debajo (los que se van a comprar), más el
        catálogo completo de los proveedores CATALOG_WIDE (Bamboo, iCodes,
        Wupex), que cuesta lo mismo actualizar entero. Luego reordena.
        Antes se consultaban todos los proveedores de todos los productos.
        """
        buy = set(product_ids_to_buy)
        try:
            all_suppliers = self._load_suppliers_for_refresh(None)
        except Exception as e:
            logger.warning("[PriceRefresh] No se pudo cargar product_suppliers: %s", e)
            return {"updated": 0, "errors": 1, "refreshed_ids": [], "providers": {}, "resort": None}
        to_refresh = [s for s in all_suppliers
                      if s["product_id"] in buy or self._provider_code_of(s) in self.CATALOG_WIDE_PROVIDERS]
        logger.info("[PriceRefresh] Ciclo: %d producto(s) a comprar → %d de %d proveedor(es) a consultar",
                    len(buy), len(to_refresh), len(all_suppliers))
        summary = await self._refresh_and_resort(to_refresh, buy)
        summary["considered"] = len(all_suppliers)
        return summary

    async def refresh_prices_if_stale(self, product_ids: list[int], max_age_seconds: int) -> dict:
        """
        Modo B: actualiza SOLO los proveedores de esos productos cuyo precio
        no se consultó en los últimos `max_age_seconds`, y reordena. Si todos
        están vigentes no llama a ninguna API. Si hay que consultar un
        proveedor CATALOG_WIDE, se aprovecha la misma descarga para
        actualizar todos sus SKUs.
        """
        from app.services.price_freshness import stale_ids

        suppliers = self._load_suppliers_for_refresh(product_ids)
        stale = set(await stale_ids([s["id"] for s in suppliers], max_age_seconds))
        to_refresh = [s for s in suppliers if s["id"] in stale]
        if not to_refresh:
            return {"updated": 0, "errors": 0, "refreshed_ids": [], "providers": {},
                    "skipped_fresh": len(suppliers), "resort": None}
        wide = {self._provider_code_of(s) for s in to_refresh} & self.CATALOG_WIDE_PROVIDERS
        # Bamboo con pocos SKUs vencidos: se consultan solo esos por v2 (rápido)
        # en vez de descargar el catálogo v1 completo para actualizarlos todos.
        if "bamboo" in wide and len(self._bamboo_skus(to_refresh)) <= self.BAMBOO_V2_MAX_SKUS:
            wide.discard("bamboo")
        if wide:
            seen = {s["id"] for s in to_refresh}
            to_refresh += [s for s in self._load_suppliers_for_refresh(None)
                           if self._provider_code_of(s) in wide and s["id"] not in seen]
        summary = await self._refresh_and_resort(to_refresh, set(product_ids))
        summary["skipped_fresh"] = len(suppliers) - len(stale)
        return summary

    async def _deactivate_missing_skus(self, provider_label: str, missing: list[dict]) -> None:
        """
        SKUs que no aparecieron en el catálogo del proveedor durante el refresh
        de precios.

        YA NO SE DESACTIVAN: según el cliente, esos productos desaparecen del
        catálogo un rato y luego vuelven. Antes se ponía is_active=False y el
        proveedor quedaba apagado para siempre (había que reactivarlo a mano).
        Ahora solo se registra en el log; si al comprar el SKU realmente no
        existe, la compra falla ANTES de crear la orden y se pasa al
        siguiente proveedor automáticamente.
        """
        if not missing:
            return
        logger.info(
            "[PriceRefresh][%s] %d SKU(s) no aparecieron en el catálogo (se mantienen activos): %s",
            provider_label, len(missing), [m.get("sku") for m in missing],
        )

    @staticmethod
    def _index_bamboo_brands(brands: list, catalog_index: dict) -> None:
        """Índice: product_id (int) → (price_min, currency, min_face, max_face). Igual para v1 y v2."""
        for brand in brands:
            currency = brand.get("currencyCode", "USD")
            for product in brand.get("products", []):
                pid = product.get("id")
                if pid is None:
                    continue
                price_data = product.get("price") or {}
                price_min = price_data.get("min")
                if price_min is None:
                    continue
                min_fv = float(product.get("minFaceValue") or price_min)
                max_fv = float(product.get("maxFaceValue") or min_fv)
                catalog_index[int(pid)] = (float(price_min), currency, min_fv, max_fv)

    async def _refresh_bamboo_prices(self, supplier_list: list[dict]) -> int:
        """
        Con muchos SKUs descarga el catálogo completo via v1 (una sola request
        ~18s, sin rate limit) y resuelve cada SKU en memoria. Con pocos
        (<= BAMBOO_V2_MAX_SKUS) consulta cada SKU con v2 filtrando por
        ProductId, que es mucho más rápido; el limitador global de Bamboo
        espacia las llamadas para no disparar 429.

        En v2, si la consulta de un SKU falla (429, timeout, 5xx) ese SKU se
        salta y conserva su precio: solo se desactiva cuando Bamboo responde
        bien y el producto no viene.
        """
        bamboo = BambooClient()
        updated = 0
        total = len([s for s in supplier_list if s.get("provider_sku")])
        skus = {str(s["provider_sku"]) for s in supplier_list if s.get("provider_sku")}

        catalog_index: dict[int, tuple[float, str, float, float]] = {}
        failed_skus: set[str] = set()   # v2: consulta fallida → no se toca

        if len(skus) <= self.BAMBOO_V2_MAX_SKUS:
            print(f"[PriceRefresh][Bamboo] Consultando {len(skus)} SKU(s) con catálogo v2...", flush=True)
            logger.info("[PriceRefresh][Bamboo] Consultando %d SKU(s) con catálogo v2 (ProductId)", len(skus))
            for sku in sorted(skus):
                try:
                    data = await bamboo.get_catalog(product_id=int(sku), page_size=10)
                    self._index_bamboo_brands(data.get("items") or [], catalog_index)
                except Exception as e:
                    failed_skus.add(sku)
                    print(f"[PriceRefresh][Bamboo] ❌ SKU={sku}: error consultando v2: {e} — se conserva su precio", flush=True)
                    logger.warning("[PriceRefresh][Bamboo] SKU=%s: error v2 (%s) — no se actualiza ni desactiva", sku, e)
            if skus and failed_skus == skus:
                # Ninguna consulta salió bien: el proveedor no se marca como vigente
                raise Exception(f"[Bamboo] catálogo v2 falló para todos los SKUs ({len(skus)})")
        else:
            print(f"[PriceRefresh][Bamboo] Descargando catálogo v1 completo...", flush=True)
            logger.info("[PriceRefresh][Bamboo] Descargando catálogo v1 completo para %d SKUs", total)

            try:
                brands = await bamboo.get_catalog_v1()
            except Exception as e:
                print(f"[PriceRefresh][Bamboo] ❌ Error descargando catálogo v1: {e}", flush=True)
                logger.error("[PriceRefresh][Bamboo] Error catálogo v1: %s", e)
                return 0

            self._index_bamboo_brands(brands, catalog_index)

        print(f"[PriceRefresh][Bamboo] Catálogo indexado: {len(catalog_index)} productos", flush=True)
        logger.info("[PriceRefresh][Bamboo] Catálogo indexado: %d productos", len(catalog_index))

        # Caché de tasas por moneda: se piden bajo demanda (una request por
        # moneda distinta, no por SKU) usando el par exacto {moneda}→USD.
        # Es el mismo endpoint/semántica que usaba la versión anterior, que
        # nunca dio overflow — el bulk "base_currency=USD" + inversión 1/val
        # se descartó porque para monedas no estándar del catálogo (CLF, TST,
        # metales XAU/XAG/XPD/XPT) el valor bulk viene en otra escala y al
        # invertirlo genera tasas absurdas que revientan NUMERIC(10,4).
        rate_cache: dict[str, float] = {"USD": 1.0}

        async def get_rate(currency: str) -> Optional[float]:
            if currency in rate_cache:
                return rate_cache[currency]
            print(f"[PriceRefresh][Bamboo] Obteniendo tasa {currency}→USD...", flush=True)
            try:
                rate = await bamboo.get_exchange_rate(base_currency=currency, currency="USD")
                rate_cache[currency] = float(rate)
                print(f"[PriceRefresh][Bamboo] Tasa {currency}→USD = {rate}", flush=True)
                logger.info("[PriceRefresh][Bamboo] Tasa %s→USD = %.6f", currency, rate)
                return rate_cache[currency]
            except Exception as e:
                print(f"[PriceRefresh][Bamboo] ⚠️ No se pudo obtener tasa {currency}→USD: {e}", flush=True)
                logger.warning("[PriceRefresh][Bamboo] No se pudo obtener tasa %s→USD: %s", currency, e)
                # Guardar precio en moneda original sin convertir (tasa 1.0 como marcador)
                rate_cache[currency] = 1.0
                return None

        MAX_ABS_PRICE_USD = 999_999.9999  # límite de NUMERIC(10,4)
        missing_skus: list[dict] = []

        for supplier in supplier_list:
            provider_sku = supplier.get("provider_sku")
            if not provider_sku or str(provider_sku) in failed_skus:
                continue

            try:
                entry = catalog_index.get(int(provider_sku))
                if entry is None:
                    print(f"[PriceRefresh][Bamboo] ⚠️ SKU={provider_sku}: no encontrado en catálogo", flush=True)
                    logger.warning("[PriceRefresh][Bamboo] SKU=%s no encontrado en catálogo", provider_sku)
                    missing_skus.append({
                        "supplier_id": supplier["id"],
                        "sku": provider_sku,
                        "product_id": supplier.get("product_id"),
                        "product_name": (supplier.get("product") or {}).get("name") or f"producto {supplier.get('product_id')}",
                    })
                    continue

                price_min, currency, min_fv, max_fv = entry
                price_float = price_min
                final_currency = "USD"

                # Ajustar al face_value real del supplier si aplica
                supplier_face_value = supplier.get("face_value")
                effective_face_value = None
                if supplier_face_value and float(supplier_face_value) > 0:
                    effective_face_value = float(supplier_face_value)

                if effective_face_value and min_fv > 0 and effective_face_value != min_fv:
                    ratio = effective_face_value / min_fv
                    price_float_adjusted = round(price_float * ratio, 4)
                    print(
                        f"[PriceRefresh][Bamboo] SKU={provider_sku}: "
                        f"price.min={price_float} {currency} para minFaceValue={min_fv} → "
                        f"ajustado a face_value={effective_face_value}: {price_float_adjusted} {currency}",
                        flush=True,
                    )
                    logger.info(
                        "[PriceRefresh][Bamboo] SKU=%s: price.min=%.4f %s × ratio(%.4f/%.4f)=%.4f → %.4f %s",
                        provider_sku, price_float, currency, effective_face_value, min_fv, ratio, price_float_adjusted, currency,
                    )
                    price_float = price_float_adjusted
                else:
                    print(
                        f"[PriceRefresh][Bamboo] SKU={provider_sku}: "
                        f"sin ajuste de face_value (supplier_face_value={supplier_face_value}, "
                        f"min={min_fv}, max={max_fv}) → precio directo: {price_float} {currency}",
                        flush=True,
                    )
                    logger.info(
                        "[PriceRefresh][Bamboo] SKU=%s: precio directo %.4f %s",
                        provider_sku, price_float, currency,
                    )

                # Convertir a USD pidiendo la tasa exacta {moneda}→USD (con caché)
                if currency != "USD":
                    rate_val = await get_rate(currency)
                    if rate_val is None:
                        rate_val = rate_cache[currency]  # 1.0 marcador tras fallo
                        final_currency = currency
                    price_usd = round(price_float * rate_val, 4)
                    print(
                        f"[PriceRefresh][Bamboo] SKU={provider_sku}: "
                        f"{price_float} {currency} × {rate_val} = {price_usd} USD",
                        flush=True,
                    )
                    logger.info("[PriceRefresh][Bamboo] SKU=%s: %.4f %s × %.6f = %.4f USD", provider_sku, price_float, currency, rate_val, price_usd)
                else:
                    price_usd = price_float

                # Freno de seguridad: nunca guardar algo que no entra en NUMERIC(10,4)
                if abs(price_usd) >= MAX_ABS_PRICE_USD:
                    print(
                        f"[PriceRefresh][Bamboo] ❌ SKU={provider_sku}: precio absurdo "
                        f"{price_usd} {final_currency} (posible tasa rota para {currency}) — SALTADO",
                        flush=True,
                    )
                    logger.error(
                        "[PriceRefresh][Bamboo] SKU=%s: precio fuera de rango %.4f %s — saltado sin guardar",
                        provider_sku, price_usd, final_currency,
                    )
                    continue

                old_price = supplier.get("cost_price")
                if old_price is not None and abs(float(old_price) - price_usd) < 0.0001:
                    logger.info("[PriceRefresh][Bamboo] SKU=%s: sin cambio ($%.4f), saltando BD", provider_sku, price_usd)
                    continue

                supabase.table("product_suppliers") \
                    .update({"cost_price": price_usd, "cost_currency": final_currency}) \
                    .eq("id", supplier["id"]) \
                    .execute()

                print(
                    f"[PriceRefresh][Bamboo] ✅ SKU={provider_sku}: "
                    f"${float(old_price or 0):.4f} → ${price_usd:.4f} {final_currency} GUARDADO",
                    flush=True,
                )
                logger.info(
                    "[PriceRefresh][Bamboo] ✅ SKU=%s: $%.4f → $%.4f %s",
                    provider_sku, float(old_price or 0), price_usd, final_currency,
                )
                updated += 1
            except Exception as e:
                print(f"[PriceRefresh][Bamboo] ❌ SKU={provider_sku}: error inesperado: {e} — SALTADO", flush=True)
                logger.error("[PriceRefresh][Bamboo] SKU=%s: error inesperado: %s", provider_sku, e)
                continue

        print(f"[PriceRefresh][Bamboo] Completado: {updated}/{total} actualizados", flush=True)
        logger.info("[PriceRefresh][Bamboo] Completado: %d/%d actualizados", updated, total)
        await self._deactivate_missing_skus("Bamboo", missing_skus)
        return updated
    async def _refresh_cardone_prices(self, supplier_list: list[dict]) -> int:
        """
        Usa /get_stock por productCode — una llamada por SKU, precio directo.
        Mucho más eficiente que paginar el catálogo completo (23k productos).
        Retorna la cantidad de filas actualizadas.
        """
        cardone = get_cardone_client()
        updated = 0
        missing_skus: list[dict] = []

        for supplier in supplier_list:
            provider_sku = supplier.get("provider_sku")
            if not provider_sku:
                continue

            try:
                result = await cardone.get_stock(product_code=provider_sku)
                data = result.get("data") or {}
                price = data.get("price")
                if price is None:
                    logger.debug("[PriceRefresh][CardOne] sku=%s sin precio en get_stock", provider_sku)
                    missing_skus.append({
                        "supplier_id": supplier["id"],
                        "sku": provider_sku,
                        "product_id": supplier.get("product_id"),
                        "product_name": (supplier.get("product") or {}).get("name") or f"producto {supplier.get('product_id')}",
                    })
                    continue

                price_float = float(price)
                old_price = supplier.get("cost_price")
                if old_price is not None and abs(float(old_price) - price_float) < 0.0001:
                    continue

                supabase.table("product_suppliers") \
                    .update({"cost_price": price_float, "cost_currency": "USD"}) \
                    .eq("id", supplier["id"]) \
                    .execute()
                logger.info(
                    "[PriceRefresh][CardOne] sku=%s: $%.4f → $%.4f USD",
                    provider_sku, float(old_price or 0), price_float,
                )
                updated += 1

            except Exception as e:
                logger.warning("[PriceRefresh][CardOne] Error para sku=%s: %s", provider_sku, e)

        await self._deactivate_missing_skus("CardOne", missing_skus)
        return updated


    async def _load_active_configs(self) -> list[PurchaseConfig]:
        try:
            result = supabase.table("channel_listings") \
                .select("""
                    id,
                    product_id,
                    external_id,
                    seller_sku,
                    stock_actual,
                    auto_replenish,
                    replenish_threshold,
                    replenish_qty,
                    max_cost_usd,
                    product:products(id, name)
                """) \
                .eq("channel", "falabella") \
                .eq("is_active", True) \
                .eq("auto_replenish", True) \
                .execute()

            listings = result.data or []
            if not listings:
                return []

            product_ids = list({row["product_id"] for row in listings if row.get("product_id")})
            suppliers_result = supabase.table("product_suppliers") \
                .select("""
                    product_id, provider_id, provider_sku, priority, is_active, is_available,
                    face_value, metadata,
                    provider:providers(id, name, code)
                """) \
                .in_("product_id", product_ids) \
                .eq("is_active", True) \
                .eq("is_available", True) \
                .execute()

            # Agrupar por product_id
            suppliers_by_product: dict[int, list] = {}
            for s in (suppliers_result.data or []):
                pid = s["product_id"]
                suppliers_by_product.setdefault(pid, []).append(s)

            configs: list[PurchaseConfig] = []

            for row in listings:
                product       = row.get("product") or {}
                pid           = row["product_id"]
                supplier_list = suppliers_by_product.get(pid, [])

                if not supplier_list:
                    logger.debug("product_id=%s: sin proveedores activos — saltando", pid)
                    continue

                umbral   = row.get("replenish_threshold")
                cantidad = row.get("replenish_qty") or 0

                if umbral is None or cantidad <= 0:
                    logger.debug(
                        "product_id=%s: threshold=%s qty=%s — saltando",
                        pid, umbral, cantidad
                    )
                    continue

                seller_sku = row.get("seller_sku") or row.get("external_id") or ""
                shop_sku   = row.get("external_id") or row.get("seller_sku") or ""

                if not seller_sku or not shop_sku:
                    logger.warning("product_id=%s sin seller_sku/shop_sku — saltando", pid)
                    continue

                configs.append(
                    self._build_config_with_fallback(
                        row=row,
                        product=product,
                        pid=pid,
                        supplier_list=supplier_list,
                        seller_sku=seller_sku,
                        shop_sku=shop_sku,
                    )
                )

            return configs

        except Exception as e:
            logger.exception("Error cargando configuraciones de auto-compra: %s", e)
            return []

    @staticmethod
    def _build_config_with_fallback(
        row: dict,
        product: dict,
        pid: int,
        supplier_list: list,
        seller_sku: str,
        shop_sku: str,
    ) -> "PurchaseConfig":
        sorted_suppliers = sorted(supplier_list, key=lambda s: s.get("priority", 99))
        suppliers_fallback = [
            {
                "provider_code": (s.get("provider") or {}).get("code", "").lower(),
                "provider_sku":  s.get("provider_sku", ""),
                "provider_name": (s.get("provider") or {}).get("name", ""),
                "face_value":    s.get("face_value"),
                "metadata":      s.get("metadata"),
            }
            for s in sorted_suppliers
            if (s.get("provider") or {}).get("code")
        ]
        primary = suppliers_fallback[0] if suppliers_fallback else {}

        return PurchaseConfig(
            product_id=pid,
            product_name=product.get("name", f"Producto {pid}"),
            seller_sku=seller_sku,
            shop_sku=shop_sku,
            provider_code=primary.get("provider_code", ""),
            provider_sku=primary.get("provider_sku", ""),
            auto_compra_activa=True,
            umbral_minimo=int(row.get("replenish_threshold") or 0),
            cantidad_compra=int(row.get("replenish_qty") or 0),
            channel_listing_id=row["id"],
            face_value=primary.get("face_value"),
            max_cost_usd=float(row["max_cost_usd"]) if row.get("max_cost_usd") else None,  # ← NUEVO
            suppliers_fallback=suppliers_fallback,
        )

    async def _update_local_stock(self, cfg: PurchaseConfig, new_stock: int) -> None:
        try:
            supabase.table("channel_listings") \
                .update({"stock_actual": new_stock}) \
                .eq("id", cfg.channel_listing_id) \
                .execute()
        except Exception as e:
            logger.warning("[%s] Error actualizando stock_actual local: %s", cfg.product_name, e)

    # ─── Resumen de ciclo ─────────────────────────────────────────────────────

    def _log_cycle_summary(self, results: list[PurchaseResult]) -> None:
        total       = len(results)
        purchased   = sum(1 for r in results if r.codes_purchased > 0)
        skipped     = sum(1 for r in results if r.skipped_reason)
        failed      = sum(1 for r in results if not r.success and not r.skipped_reason)
        total_codes = sum(r.codes_uploaded for r in results)

        logger.info("════════════════════════════════════════")
        logger.info("📊 RESUMEN DEL CICLO")
        logger.info("   Total evaluados : %d", total)
        logger.info("   Con compra       : %d", purchased)
        logger.info("   Saltados         : %d", skipped)
        logger.info("   Errores          : %d", failed)
        logger.info("   Códigos subidos  : %d", total_codes)
        logger.info("════════════════════════════════════════")

        for r in results:
            if not r.success and not r.skipped_reason:
                logger.error("  ❌ %s: %s", r.product_name, r.error)
            elif r.codes_uploaded > 0:
                logger.info(
                    "  ✅ %s: +%d códigos | stock %d→%d",
                    r.product_name, r.codes_uploaded, r.stock_before, r.stock_after
                )


    async def _refresh_wgcards_prices(self, supplier_list: list[dict]) -> int:
        """
        Actualiza cost_price en product_suppliers para proveedores WGCards.

        Filtra getItemAndStock por itemId (provider_item_id), consultando solo
        los productos padre que realmente vendés, en vez de paginar el catálogo
        completo. Reduce de ~40+ llamadas a ~3-8 por ciclo (una por itemId único).
        """
        from app.providers import wgcards_client as wg

        total = len(supplier_list)
        print(f"[PriceRefresh][WGCards] Iniciando refresh de {total} SKUs...", flush=True)
        logger.warning("[PriceRefresh][WGCards] Iniciando refresh de %d SKUs", total)

        # Construir índice skuId → supplier para lookup O(1)
        sku_index: dict[str, dict] = {}
        for supplier in supplier_list:
            provider_sku = supplier.get("provider_sku")
            if provider_sku:
                sku_index[provider_sku] = supplier

        if not sku_index:
            print("[PriceRefresh][WGCards] ⚠️ Sin SKUs válidos, saltando.", flush=True)
            logger.warning("[PriceRefresh][WGCards] Sin SKUs válidos, saltando.")
            return 0

        # itemIds únicos a partir de provider_item_id (columna dedicada)
        item_ids = sorted({
            s["provider_item_id"] for s in supplier_list
            if s.get("provider_item_id")
        })

        if not item_ids:
            print("[PriceRefresh][WGCards] ⚠️ Sin provider_item_id guardado en ningún supplier, saltando.", flush=True)
            logger.warning("[PriceRefresh][WGCards] Sin provider_item_id guardado en ningún supplier, saltando.")
            return 0

        print(f"[PriceRefresh][WGCards] {len(item_ids)} itemId(s) único(s) a consultar", flush=True)

        cny_to_usd = 0.138  # fallback: 1 CNY ≈ 0.138 USD
        all_records: list[dict] = []

        for idx, item_id in enumerate(item_ids):
            try:
                data = await wg.get_products_and_stock(
                    current=1,
                    size=100,
                    item_id=item_id,
                    currency_code="USD",
                )
                records = data.get("records", [])
                all_records.extend(records)
                print(
                    f"[PriceRefresh][WGCards] itemId={item_id} ({idx + 1}/{len(item_ids)}) — {len(records)} records",
                    flush=True,
                )
                logger.warning(
                    "[PriceRefresh][WGCards] itemId=%s (%d/%d) — %d records",
                    item_id, idx + 1, len(item_ids), len(records),
                )
            except Exception as e:
                print(f"[PriceRefresh][WGCards] ❌ Error obteniendo itemId={item_id}: {e}", flush=True)
                logger.warning("[PriceRefresh][WGCards] Error obteniendo itemId=%s: %s", item_id, e)
                if "frequency" in str(e).lower() or "limit" in str(e).lower():
                    print("[PriceRefresh][WGCards] ⚠️ Rate limit detectado, cortando loop.", flush=True)
                    logger.warning("[PriceRefresh][WGCards] Rate limit detectado, cortando loop.")
                    break

            if idx < len(item_ids) - 1:
                await asyncio.sleep(2.5)  # API v4: 30 req/60s en getItemAndStock

        # Construir índice de precios skuId → price_usd
        price_map: dict[str, float] = {}
        for item in all_records:
            for sku_info in item.get("skuInfos", []):
                sku_id = sku_info.get("skuId")
                if not sku_id:
                    continue
                raw_price = sku_info.get("skuPrice") or sku_info.get("minPrice")
                if raw_price is None:
                    continue
                price_currency = sku_info.get("skuPriceCurrency", "USD")
                if price_currency == "USD":
                    price_map[sku_id] = float(raw_price)
                else:
                    price_map[sku_id] = round(float(raw_price) * cny_to_usd, 4)

        print(f"[PriceRefresh][WGCards] Catálogo indexado: {len(price_map)} skuIds con precio", flush=True)
        logger.warning("[PriceRefresh][WGCards] Catálogo indexado: %d skuIds con precio", len(price_map))

        # Actualizar en BD solo los SKUs que cambiaron
        updated = 0
        missing_skus: list[dict] = []
        for sku_id, supplier in sku_index.items():
            price_usd = price_map.get(sku_id)
            if price_usd is None:
                print(f"[PriceRefresh][WGCards] ⚠️ skuId={sku_id}: no encontrado en catálogo", flush=True)
                logger.warning("[PriceRefresh][WGCards] skuId=%s no encontrado en catálogo", sku_id)
                missing_skus.append({
                    "supplier_id": supplier["id"],
                    "sku": sku_id,
                    "product_id": supplier.get("product_id"),
                    "product_name": (supplier.get("product") or {}).get("name") or f"producto {supplier.get('product_id')}",
                })
                continue

            old_price = supplier.get("cost_price")
            if old_price is not None and abs(float(old_price) - price_usd) < 0.0001:
                logger.debug(
                    "[PriceRefresh][WGCards] skuId=%s: sin cambio ($%.4f), saltando BD",
                    sku_id, price_usd,
                )
                continue

            try:
                supabase.table("product_suppliers") \
                    .update({"cost_price": price_usd, "cost_currency": "USD"}) \
                    .eq("id", supplier["id"]) \
                    .execute()

                print(
                    f"[PriceRefresh][WGCards] ✅ skuId={sku_id}: ${float(old_price or 0):.4f} → ${price_usd:.4f} USD",
                    flush=True,
                )
                logger.warning(
                    "[PriceRefresh][WGCards] ✅ skuId=%s: $%.4f → $%.4f USD",
                    sku_id, float(old_price or 0), price_usd,
                )
                updated += 1

            except Exception as e:
                print(f"[PriceRefresh][WGCards] ❌ Error actualizando BD para skuId={sku_id}: {e}", flush=True)
                logger.warning("[PriceRefresh][WGCards] Error actualizando BD para skuId=%s: %s", sku_id, e)

        print(f"[PriceRefresh][WGCards] Completado: {updated}/{total} actualizados", flush=True)
        logger.warning("[PriceRefresh][WGCards] Completado: %d/%d actualizados", updated, total)
        await self._deactivate_missing_skus("WGCards", missing_skus)
        return updated

    async def _refresh_eneba_wholesale_prices(self, supplier_list: list[dict]) -> int:
        """
        Actualiza cost_price (USD) para auctions de Eneba Wholesale.

        La API de Eneba no tiene un "get auction by id" directo. Lo más confiable
        es filtrar por `productIds` (UUID de P_API_Product, match exacto — no
        depende de que el nombre siga igual). Guardamos ese UUID en
        metadata.eneba_product_id al momento de mapear el proveedor.

        Para suppliers mapeados ANTES de este campo (sin eneba_product_id en
        metadata), se hace fallback a buscar por metadata.product_name y cruzar
        por auctionId — menos confiable (depende del nombre), pero evita dejar
        sin refresh a los mapeos viejos.
        """
        import json
        from app.providers.eneba_wholesale_client import get_eneba_wholesale_client
        from app.routes.catalog import _get_all_usd_rates

        total = len(supplier_list)
        logger.info("[PriceRefresh][EnebaWholesale] Iniciando refresh de %d auctions", total)

        # Parsear metadata de cada supplier una sola vez
        parsed: list[tuple[dict, dict]] = []  # (supplier, meta)
        for supplier in supplier_list:
            raw_meta = supplier.get("metadata")
            try:
                meta = json.loads(raw_meta) if isinstance(raw_meta, str) else (raw_meta or {})
            except Exception:
                meta = {}
            parsed.append((supplier, meta))

        # Bucket 1: tienen eneba_product_id → se pueden refrescar por productIds (exacto)
        by_product_id: dict[str, list] = {}   # product_id → suppliers (cada uno con SU auction)
        auction_by_product_id: dict[str, str] = {}  # product_id → auctionId esperado
        # Bucket 2: sin product_id → fallback por nombre
        by_name: dict[str, list[dict]] = {}

        skipped = 0
        for supplier, meta in parsed:
            auction_id   = supplier.get("provider_sku")
            product_id   = meta.get("eneba_product_id")
            product_name = meta.get("product_name")

            if not auction_id:
                skipped += 1
                continue

            if product_id:
                by_product_id.setdefault(product_id, []).append(supplier)
                auction_by_product_id[product_id] = auction_id
            elif product_name:
                by_name.setdefault(product_name, []).append(supplier)
            else:
                skipped += 1

        if skipped:
            logger.warning(
                "[PriceRefresh][EnebaWholesale] %d suppliers sin provider_sku/metadata útil, no se pueden refrescar",
                skipped,
            )
        if not by_product_id and not by_name:
            logger.info("[PriceRefresh][EnebaWholesale] Sin datos válidos, saltando.")
            return 0

        # Tasas base USD (cost_price se guarda siempre en USD). Sin tasa real
        # NO se toca el precio: antes se usaba 1.08 fijo y quedaba un costo
        # inventado que no coincidía con la conversión real.
        rates = await _get_all_usd_rates() or {}
        usd_to_eur = rates.get("EUR")
        if usd_to_eur:
            logger.info("[PriceRefresh][EnebaWholesale] Tasa usada: 1 EUR = %.4f USD", 1 / usd_to_eur)
        else:
            logger.error("[PriceRefresh][EnebaWholesale] Sin tasa EUR→USD (revisa EXCHANGE_RATE_API_KEY): "
                         "solo se actualiza stock, no precios")

        def to_usd(amount: float, currency: str) -> Optional[float]:
            """Convierte el precio de Eneba a USD según la moneda QUE DEVUELVE la API
            (antes se asumía siempre EUR aunque viniera en otra moneda)."""
            currency = (currency or "EUR").upper()
            if currency == "USD":
                return round(amount, 4)
            rate = rates.get(currency)          # 1 USD = rate <currency>
            if not rate:
                return None
            return round(amount / float(rate), 4)

        client  = get_eneba_wholesale_client()
        updated = 0

        def apply_update(supplier: dict, auction_id: str, node: dict, label: str) -> bool:
            nonlocal updated
            w_price    = node.get("wholesalePrice") or {}
            stock      = node.get("wholesaleStock") or 0
            amount     = round(float(w_price.get("amount") or 0) / 100, 4)   # centavos → unidades
            currency   = (w_price.get("currency") or "EUR").upper()
            cost_usd   = to_usd(amount, currency)

            old_price     = supplier.get("cost_price")
            if cost_usd is None:
                logger.warning("[PriceRefresh][EnebaWholesale] auctionId=%s: sin tasa para %s — precio sin cambios",
                               auction_id, currency)
                cost_usd = 0.0
                price_changed = False
            else:
                price_changed = old_price is None or abs(float(old_price) - cost_usd) >= 0.0001
                logger.info("[PriceRefresh][EnebaWholesale] auctionId=%s '%s': %.2f %s → $%.4f USD",
                            auction_id, label, amount, currency, cost_usd)

            update_payload: dict = {"is_available": stock > 0}
            if price_changed and cost_usd > 0:
                update_payload["cost_price"]    = cost_usd
                update_payload["cost_currency"] = "USD"

            try:
                supabase.table("product_suppliers") \
                    .update(update_payload) \
                    .eq("id", supplier["id"]) \
                    .execute()
                if price_changed and cost_usd > 0:
                    logger.info(
                        "[PriceRefresh][EnebaWholesale] ✅ auctionId=%s '%s': $%.4f → $%.4f USD (stock=%d)",
                        auction_id, label, float(old_price or 0), cost_usd, stock,
                    )
                    updated += 1
                return True
            except Exception as e:
                logger.warning(
                    "[PriceRefresh][EnebaWholesale] Error actualizando BD auctionId=%s: %s",
                    auction_id, e,
                )
                return False

        async def fetch_all_auctions(**kwargs) -> list[dict]:
            """Todas las subastas (paginando). Un mismo producto tiene VARIAS
            subastas, una por vendedor, cada una con su propio precio."""
            nodes, after = [], None
            for _ in range(20):
                res = await client.get_wholesale_auctions(first=100, after=after, **kwargs)
                nodes += [(e.get("node") or {}) for e in res.get("edges", [])]
                page = res.get("pageInfo") or {}
                if not page.get("hasNextPage"):
                    break
                after = page.get("endCursor")
            return nodes

        # ── Bucket 1: refresh por productIds ───────────────────────────────────
        # BUG anterior: se pedía first=len(chunk) (con 1 producto → 1 sola
        # subasta) y se tomaba la PRIMERA subasta que devolvía Eneba para ese
        # producto, que suele ser de OTRO vendedor con otro precio. Por eso
        # Minecraft 3500 (subasta mapeada a 10.55 €) quedaba en $12.45: se le
        # ponía el precio de la subasta bfa4… (≈ 11.13 €). Ahora se usa el
        # precio de la subasta EXACTA que está mapeada (provider_sku), que es
        # la misma a la que se compra.
        if by_product_id:
            product_ids = list(by_product_id.keys())
            CHUNK = 50
            for i in range(0, len(product_ids), CHUNK):
                chunk = product_ids[i:i + CHUNK]
                try:
                    nodes = await fetch_all_auctions(product_ids=chunk)
                except Exception as e:
                    logger.warning("[PriceRefresh][EnebaWholesale] Error con productIds: %s", e)
                    continue
                by_auction = {n.get("id"): n for n in nodes if n.get("id")}
                for product_id in chunk:
                    for supplier in by_product_id[product_id]:
                        auction_id = supplier.get("provider_sku")
                        node = by_auction.get(auction_id)
                        if node:
                            apply_update(supplier, auction_id, node,
                                         (node.get("product") or {}).get("name") or product_id)
                        else:
                            # La subasta mapeada no está visible ahora: NO se
                            # toma el precio de otro vendedor ni se desactiva.
                            logger.info("[PriceRefresh][EnebaWholesale] subasta %s (producto %s) no visible ahora "
                                        "— precio sin cambios", auction_id, product_id)

        # ── Bucket 2: fallback por nombre (mapeos sin eneba_product_id) ────────
        for product_name, suppliers in by_name.items():
            auction_index = {s["provider_sku"]: s for s in suppliers}
            try:
                edges = [{"node": n} for n in await fetch_all_auctions(search=product_name)]
            except Exception as e:
                logger.warning(
                    "[PriceRefresh][EnebaWholesale] Error buscando '%s': %s", product_name, e
                )
                continue

            found_ids: set[str] = set()
            for edge in edges:
                node       = edge.get("node", {}) or {}
                auction_id = node.get("id")
                if auction_id not in auction_index:
                    continue
                found_ids.add(auction_id)
                apply_update(auction_index[auction_id], auction_id, node, product_name)

            missing = set(auction_index.keys()) - found_ids
            if missing:
                logger.info("[PriceRefresh][EnebaWholesale] '%s': %d auction(s) no aparecen ahora "
                            "(se mantienen sin cambios): %s", product_name, len(missing), sorted(missing))

        logger.info("[PriceRefresh][EnebaWholesale] Completado: %d/%d actualizados", updated, total)
        return updated

    async def _purchase_wgcards(self, cfg: PurchaseConfig, supplier_info: dict) -> list[str]:
        """
        Compra códigos en WGCards con lógica inteligente de stock:

        1. Revisar si ya hay una orden pendiente en BD → reanudar polling
        2. Consultar getStock antes de comprar:
           - stock = 0   → RuntimeError (sin stock, ir a siguiente proveedor)
           - stock > 0   → comprar + polling 2 min (llega rápido)
           - stock = -1  → pre-order: comprar, guardar orderId en BD, lanzar WGCardsOrderPending
        3. En ciclos futuros, la orden pendiente se retoma y se entregan los códigos
           cuando WGCards los libera (1-3 días).
        """
        from app.providers import wgcards_client as wg
        from datetime import timezone, timedelta

        sku_id     = supplier_info.get("provider_sku") or cfg.provider_sku
        face_value = supplier_info.get("face_value") or cfg.face_value

        # Leer purchase_currency desde BD (default USD)
        purchase_currency = "USD"
        try:
            ps = supabase.table("product_suppliers") \
                .select("purchase_currency") \
                .eq("product_id", cfg.product_id) \
                .eq("provider_sku", sku_id) \
                .limit(1) \
                .execute()
            if ps.data and ps.data[0].get("purchase_currency"):
                purchase_currency = ps.data[0]["purchase_currency"].upper()
        except Exception as e:
            logger.warning("[%s] WGCards: no se pudo leer purchase_currency: %s", cfg.product_name, e)

        # ── PASO 1: ¿Existe ya una orden pendiente para este producto/sku? ────
        existing_order_id = await self._wg_get_pending_order(cfg.product_id, sku_id)
        if existing_order_id:
            logger.info(
                "[%s] WGCards: retomando orden pendiente orderId=%s",
                cfg.product_name, existing_order_id
            )
            tracked = self._tracker.get("wgcards", existing_order_id, cfg.product_id)
            requested = (tracked or {}).get("requested_quantity") or cfg.cantidad_compra
            codes = await self._wg_poll_codes(cfg, existing_order_id, expected=requested)
            # Sin códigos nuevos → WGCardsOrderPending; parcial → devuelve solo los nuevos
            return await self._settle_order(
                cfg, provider="wgcards", order_ref=existing_order_id,
                requested_quantity=requested, fetched_codes=codes,
                resume_meta={"order_id": existing_order_id, "sku_id": sku_id, "kind": "order"},
                pending_exc=WGCardsOrderPending(existing_order_id, sku_id, cfg.product_id),
            )

        # ── PASO 2: Consultar stock antes de comprar ──────────────────────────
        stock_type = "unknown"
        try:
            stock_list = await wg.get_stock([sku_id])
            stock_entry = next((s for s in stock_list if s.get("skuId") == sku_id), None)
            stock_qty   = stock_entry.get("number", 0) if stock_entry else 0

            if stock_qty == 0:
                logger.warning(
                    "[%s] WGCards: skuId=%s sin stock (number=0) — saltando a otro proveedor",
                    cfg.product_name, sku_id
                )
                raise RuntimeError(f"WGCards: sin stock para skuId={sku_id}")
            elif 0 < stock_qty < cfg.cantidad_compra:
                # WGCards rechaza la orden completa si no alcanza (code=421
                # "Insufficient inventory quantity!"): no se intenta comprar.
                logger.warning(
                    "[%s] WGCards: skuId=%s stock insuficiente (%d < %d) — saltando a otro proveedor",
                    cfg.product_name, sku_id, stock_qty, cfg.cantidad_compra
                )
                raise RuntimeError(f"WGCards: stock insuficiente para skuId={sku_id} ({stock_qty} < {cfg.cantidad_compra})")
            elif stock_qty == -1:
                stock_type = "preorder"
                logger.info(
                    "[%s] WGCards: skuId=%s es PRE-ORDER (stock=-1) — se comprará y esperará 1-3 días",
                    cfg.product_name, sku_id
                )
            else:
                stock_type = "instant"
                logger.info(
                    "[%s] WGCards: skuId=%s tiene stock físico (%d) — entrega rápida",
                    cfg.product_name, sku_id, stock_qty
                )
        except WGCardsOrderPending:
            raise
        except RuntimeError:
            raise
        except Exception as e:
            # Si getStock falla, asumir stock disponible y continuar
            logger.warning(
                "[%s] WGCards: getStock falló (%s) — asumiendo stock disponible",
                cfg.product_name, e
            )
            stock_type = "unknown"

        # ── PASO 3: Colocar la orden ──────────────────────────────────────────
        logger.info(
            "[%s] WGCards: comprando skuId=%s qty=%d face_value=%s currency=%s",
            cfg.product_name, sku_id, cfg.cantidad_compra, face_value, purchase_currency
        )

        self._note_submit(cfg, "wgcards", cfg.cantidad_compra, meta={"sku_id": sku_id, "kind": "order"})
        order_id = await wg.place_order(
            sku_id=sku_id,
            buy_num=cfg.cantidad_compra,
            currency=purchase_currency,
            face_value=face_value,
        )
        logger.info("[%s] WGCards: orden creada orderId=%s (tipo=%s)", cfg.product_name, order_id, stock_type)
        self._note_accepted(cfg, str(order_id), {"order_id": order_id, "sku_id": sku_id, "stock_type": stock_type})

        # ── PASO 4: Polling inmediato ─────────────────────────────────────────
        codes = await self._wg_poll_codes(cfg, order_id, expected=cfg.cantidad_compra)

        # ── PASO 5: Validar cantidad ──────────────────────────────────────────
        # Si la orden fue aceptada pero no llegaron TODOS los códigos en 2 min,
        # se guarda lo recibido y lo faltante queda pendiente sobre ESTA orden.
        # WGCards puede tardar desde minutos hasta 1-3 días incluso con stock físico.
        async def _save():
            if stock_type == "instant":
                logger.warning(
                    "[%s] WGCards: stock físico pero no llegaron todos los códigos en 2 min — "
                    "guardando orden para retomar en próximo ciclo (orderId=%s)",
                    cfg.product_name, order_id
                )
            await self._wg_save_pending_order(cfg.product_id, sku_id, order_id)

        return await self._settle_order(
            cfg, provider="wgcards", order_ref=order_id,
            requested_quantity=cfg.cantidad_compra, fetched_codes=codes,
            resume_meta={"order_id": order_id, "sku_id": sku_id, "kind": "order",
                         "stock_type": stock_type},
            save_pending=_save,
            pending_exc=WGCardsOrderPending(order_id, sku_id, cfg.product_id),
        )

    async def _wg_poll_codes(
        self, cfg: PurchaseConfig, order_id: str,
        expected: Optional[int] = None, quick: bool = False,
    ) -> list[str]:
        """
        Polling de códigos WGCards durante ~2 minutos (1 consulta en modo quick).
        Sigue esperando mientras haya menos códigos que `expected` y devuelve
        lo mejor que vio ([] si nada) — la completitud la decide _settle_order.
        """
        from app.providers import wgcards_client as wg

        POLL_INTERVALS = [2] if quick else [3, 5, 5, 10, 10, 10, 15, 15, 30, 30]  # ~2 min total
        best: list[str] = []

        def _enough(c: list) -> bool:
            return bool(c) and (expected is None or len(c) >= expected)

        for i, wait in enumerate(POLL_INTERVALS):
            await asyncio.sleep(wait)
            try:
                detail          = await wg.get_order_detail(order_id)
                first           = detail.get("firstTo", {})
                delivery_status = first.get("deliveryStatus", 0)
                order_status    = first.get("orderStatus", 0)

                logger.info(
                    "[%s] WGCards polling #%d orderId=%s deliveryStatus=%s orderStatus=%s",
                    cfg.product_name, i + 1, order_id, delivery_status, order_status
                )

                if delivery_status == 3 or order_status == 1:
                    codes_raw = await wg.get_order_codes(order_id)
                    codes = [
                        str(r.get("card") or r.get("pinCode") or r.get("snCode")).strip()
                        for r in codes_raw
                        if r.get("card") or r.get("pinCode") or r.get("snCode")
                    ]
                    if len(codes) > len(best):
                        best = codes
                    if _enough(best):
                        logger.info("[%s] WGCards: %d códigos en intento #%d", cfg.product_name, len(best), i + 1)
                        return best

            except Exception as e:
                logger.warning("[%s] WGCards polling #%d getOrderDetail error: %s", cfg.product_name, i + 1, e)
                # Fallback directo a getBuyCard
                try:
                    codes_raw = await wg.get_order_codes(order_id)
                    codes = [
                        str(r.get("card") or r.get("pinCode") or r.get("snCode")).strip()
                        for r in codes_raw
                        if r.get("card") or r.get("pinCode") or r.get("snCode")
                    ]
                    if len(codes) > len(best):
                        best = codes
                    if _enough(best):
                        logger.info(
                            "[%s] WGCards: %d códigos via getBuyCard (fallback) intento #%d",
                            cfg.product_name, len(best), i + 1
                        )
                        return best
                except Exception as e2:
                    logger.warning("[%s] WGCards polling #%d getBuyCard también falló: %s", cfg.product_name, i + 1, e2)

        logger.info("[%s] WGCards: polling finalizado con %d/%s código(s) para orderId=%s",
                    cfg.product_name, len(best), expected, order_id)
        return best

    async def _wg_get_pending_order(self, product_id: int, sku_id: str) -> Optional[str]:
        """Busca una orden WGCards pendiente no expirada. Retorna orderId o None."""
        try:
            from datetime import datetime, timezone
            now_iso = datetime.now(timezone.utc).isoformat()
            result = supabase.table("wgcards_pending_orders") \
                .select("order_id") \
                .eq("product_id", product_id) \
                .eq("sku_id", sku_id) \
                .gt("expires_at", now_iso) \
                .order("created_at", desc=False) \
                .limit(1) \
                .execute()
            if result.data:
                return result.data[0]["order_id"]
        except Exception as e:
            logger.warning("[WGCards] _wg_get_pending_order error: %s", e)
        return None

    async def _wg_save_pending_order(self, product_id: int, sku_id: str, order_id: str) -> None:
        """Guarda una orden WGCards pendiente (regla única: pasa a recuperación a los 2 días)."""
        try:
            created_iso, expires_iso = _pending_expiry_iso()
            supabase.table("wgcards_pending_orders").insert({
                "product_id": product_id,
                "sku_id":     sku_id,
                "order_id":   order_id,
                "created_at": created_iso,
                "expires_at": expires_iso,
            }).execute()
            logger.info(
                "[WGCards] Orden pendiente guardada: product_id=%d sku_id=%s orderId=%s expira=%s",
                product_id, sku_id, order_id, expires_iso[:10]
            )
        except Exception as e:
            logger.error("[WGCards] No se pudo guardar orden pendiente (orderId=%s): %s", order_id, e)

    async def _wg_delete_pending_order(
        self, product_id: int, sku_id: str,
        status: str = "RECOVERED", codes_count: int = 0,
    ) -> None:
        """Elimina la orden pendiente una vez que llegaron los códigos."""
        try:
            row = supabase.table("wgcards_pending_orders") \
                .select("*") \
                .eq("product_id", product_id) \
                .eq("sku_id", sku_id) \
                .limit(1).execute()
            pending_row = row.data[0] if row.data else {}

            # La completitud la decide _settle_order (validación de cantidades);
            # aquí solo se registran desenlaces terminales (UNRECOVERED).
            if status != STATUS_COMPLETED:
                await _log_recovery(
                    provider="wgcards",
                    product_id=product_id,
                    order_ref=pending_row.get("order_id") or sku_id,
                    status=status,
                    codes_count=codes_count,
                    original_created_at=pending_row.get("created_at"),
                    original_expires_at=pending_row.get("expires_at"),
                    raw_metadata=pending_row,
                )

            supabase.table("wgcards_pending_orders") \
                .delete() \
                .eq("product_id", product_id) \
                .eq("sku_id", sku_id) \
                .execute()
            logger.info("[WGCards] Orden pendiente eliminada: product_id=%d sku_id=%s status=%s", product_id, sku_id, status)
        except Exception as e:
            logger.warning("[WGCards] No se pudo eliminar orden pendiente: %s", e)

    async def _purchase_icodes(self, cfg: "PurchaseConfig") -> list[str]:
        """
        Compra códigos usando iCodes API (check → create_order → polling →
        download). Se usan las primitivas del cliente (en vez de
        ic.purchase_codes) para conservar el reference_code: si la orden no
        termina a tiempo o llega incompleta, queda PENDING y se retoma.
        """
        from app.providers import icodes_client as ic

        pending_row = self._tracker.find_pending("icodes", cfg.product_id, str(cfg.provider_sku))
        if pending_row:
            logger.info("[%s] iCodes: retomando orden pendiente %s", cfg.product_name, pending_row.get("order_ref"))
            return await self._icodes_resume(cfg, pending_row)

        quantity = cfg.cantidad_compra
        logger.info("[%s] iCodes: comprando sku=%s x%d", cfg.product_name, cfg.provider_sku, quantity)

        check = await ic.check_variety(cfg.provider_sku, quantity)
        if not check.get("is_available"):
            raise Exception(f"[iCodes] sin stock para sku={cfg.provider_sku} (qty={quantity})")
        orderable = check.get("orderable_range") or {}
        min_qty, max_qty = orderable.get("from"), orderable.get("to")
        if min_qty and quantity < int(min_qty):
            raise Exception(f"[iCodes] Cantidad {quantity} menor al mínimo permitido ({min_qty})")
        if not orderable.get("is_unlimited", False) and max_qty and quantity > int(max_qty):
            logger.warning("[%s] iCodes: cantidad %d supera el máximo %s — ajustando",
                           cfg.product_name, quantity, max_qty)
            quantity = int(max_qty)

        self._note_submit(cfg, "icodes", quantity, meta={"kind": "order"})
        order = await ic.create_order(cfg.provider_sku, quantity)
        reference_code = order["_reference_code"]
        if order.get("status") == 4:
            note_rejected()
            raise Exception(f"[iCodes] Orden rechazada: {order.get('error_display', 'Error desconocido')}")

        self._note_accepted(cfg, str(reference_code), {"reference_code": reference_code})
        codes, failed, error = await self._icodes_fetch_codes(cfg.product_name, reference_code, order.get("status"))
        if failed and not codes:
            note_rejected()
            self._tracker.discard_intent_if_empty("icodes", str(reference_code), cfg.product_id)
            raise Exception(f"[iCodes] Orden {reference_code} rechazada: {error}")

        return await self._settle_order(
            cfg, provider="icodes", order_ref=reference_code,
            requested_quantity=quantity, fetched_codes=codes,
            resume_meta={"reference_code": reference_code, "kind": "order"},
            terminal_failure=failed, error=error,
        )

    async def _icodes_resume(self, cfg: "PurchaseConfig", pending_row: dict, *, quick: bool = False,
                             manual: bool = False, source: str = "auto") -> list[str]:
        meta = pending_row.get("raw_metadata") or {}
        reference_code = meta.get("reference_code") or pending_row.get("order_ref")
        codes, failed, error = await self._icodes_fetch_codes(
            cfg.product_name, reference_code, None, max_wait=5 if quick else 120,
        )
        return await self._settle_order(
            cfg, provider="icodes", order_ref=pending_row.get("order_ref") or reference_code,
            requested_quantity=pending_row.get("requested_quantity"), fetched_codes=codes,
            terminal_failure=failed, error=error, manual=manual, source=source,
        )

    async def _icodes_fetch_codes(
        self, product_name: str, reference_code: str, status: Optional[int], max_wait: int = 120,
    ) -> tuple[list[str], bool, Optional[str]]:
        """Polling hasta status=5 (Completed) y descarga. (códigos, fallida, error)."""
        from app.providers import icodes_client as ic
        elapsed, poll_interval = 0, 5
        while True:
            if status == 5:
                try:
                    return await ic.download_codes(reference_code), False, None
                except Exception as e:
                    logger.warning("[%s] iCodes: error descargando %s: %s", product_name, reference_code, e)
                    return [], False, None
            if status == 4:
                return [], True, "rechazada por iCodes"
            if elapsed >= max_wait:
                logger.warning("[%s] iCodes: orden %s no completó en %ds (status=%s)",
                               product_name, reference_code, max_wait, status)
                return [], False, None
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval
            try:
                status = (await ic.get_order_status(reference_code)).get("status")
            except Exception as e:
                logger.warning("[%s] iCodes: error consultando %s: %s", product_name, reference_code, e)

    async def _get_icodes_balance(self) -> Optional[float]:
        """iCodes no expone endpoint de balance público."""
        return None

    async def _refresh_icodes_prices(self, supplier_list: list[dict]) -> int:
        """Refresca precios de iCodes consultando varieties."""
        from app.providers import icodes_client as ic
        from app.core.database import supabase

        try:
            varieties = await ic.get_varieties()
        except Exception as e:
            logger.warning("[PriceRefresh][iCodes] Error obteniendo varieties: %s", e)
            return 0

        price_map = {str(v["product_sku"]): float(v["price"]) for v in varieties if v.get("product_sku") and v.get("price")}
        updated = 0
        missing_skus: list[dict] = []

        for supplier in supplier_list:
            sku = str(supplier.get("provider_sku") or "")
            if not sku:
                continue
            if sku not in price_map:
                missing_skus.append({
                    "supplier_id": supplier["id"],
                    "sku": sku,
                    "product_id": supplier.get("product_id"),
                    "product_name": (supplier.get("product") or {}).get("name") or f"producto {supplier.get('product_id')}",
                })
                continue
            new_price = price_map[sku]
            try:
                supabase.table("product_suppliers") \
                    .update({"cost_price": new_price, "cost_currency": "USD"}) \
                    .eq("id", supplier["id"]) \
                    .execute()
                updated += 1
                logger.debug("[PriceRefresh][iCodes] %s → $%.4f", sku, new_price)
            except Exception as e:
                logger.warning("[PriceRefresh][iCodes] Error actualizando sku=%s: %s", sku, e)

        logger.info("[PriceRefresh][iCodes] %d precios actualizados", updated)
        await self._deactivate_missing_skus("iCodes", missing_skus)
        return updated

    async def _purchase_coda_voucher(self, cfg: "PurchaseConfig", supplier_info: dict,
                                     pending_row: Optional[dict] = None,
                                     manual: bool = False, source: str = "auto") -> list[str]:
        """
        Compra un voucher Coda en un solo call (placeOrder), sin
        validate/topup previo. supplier_info.metadata debe traer
        {"api_path": "/steam-voucher"} — Coda necesita el apiPath del
        producto además del sku para armar la URL /v2/{apiPath}.
        """
        from app.providers.coda_voucher_client import CodaVoucherClient

        import json as _json
        raw_meta = supplier_info.get("metadata")
        metadata = _json.loads(raw_meta) if isinstance(raw_meta, str) else (raw_meta or {})
        api_path = metadata.get("api_path")
        if not api_path:
            logger.error(
                "[Coda Voucher][DEBUG] sku=%s tipo_raw_meta=%s raw_meta=%r metadata_parseada=%r supplier_info_completo=%r",
                cfg.provider_sku, type(raw_meta).__name__, raw_meta, metadata, supplier_info,
            )
            raise Exception(
                f"[Coda Voucher] falta 'api_path' en metadata de product_suppliers "
                f"(sku={cfg.provider_sku})"
            )

        client = CodaVoucherClient()

        # Precio vigente: Coda rechaza con 30113 (Price Error) si no matchea
        # exactamente el de listSku, así que lo pedimos fresco antes de comprar.
        skus = await client.list_skus(api_path)
        sku_row = next((s for s in skus if s["sku"] == cfg.provider_sku), None)
        if not sku_row:
            raise Exception(f"[Coda Voucher] sku={cfg.provider_sku} no encontrado en listSku({api_path})")

        # ── Unidad por unidad: si hay una orden PENDING, se compran SOLO las
        # unidades que faltan (las fallidas no se cobraron), nunca la cantidad
        # original de nuevo. ───────────────────────────────────────────────
        if pending_row is None:
            pending_row = self._tracker.find_pending("coda_voucher", cfg.product_id, str(cfg.provider_sku))
        if pending_row:
            requested = int(pending_row.get("requested_quantity") or cfg.cantidad_compra or 1)
            qty = max(1, int(pending_row.get("remaining_quantity")
                             or requested - int(pending_row.get("received_quantity") or 0)))
            order_ref = pending_row["order_ref"]
        else:
            import uuid as _uuid
            requested = max(1, int(cfg.cantidad_compra or 1))
            qty = requested
            order_ref = f"CODA-{cfg.product_id}-{_uuid.uuid4().hex[:12]}"

        logger.info(
            "[%s] Coda Voucher: comprando %d x sku=%s apiPath=%s precio=%s %s%s",
            cfg.product_name, qty, cfg.provider_sku, api_path,
            sku_row["priceAmount"], sku_row["priceCurrency"],
            f" (pendientes de {order_ref})" if pending_row else "",
        )
        try:
            codes = await self._coda_buy_units(cfg, client, api_path, sku_row, qty)
        except Exception as e:
            if not pending_row:
                raise   # nada comprado → igual que antes: siguiente proveedor
            codes, err = [], str(e)
        else:
            err = None

        if not pending_row and len(codes) >= requested:
            return codes   # compra completa normal

        return await self._settle_order(
            cfg, provider="coda_voucher", order_ref=order_ref,
            requested_quantity=requested, fetched_codes=codes,
            resume_meta={"kind": "unit", "provider_sku": str(cfg.provider_sku),
                         "supplier_metadata": metadata},
            error=err, manual=manual, source=source,
        )

    async def _coda_buy_units(self, cfg: "PurchaseConfig", client, api_path: str, sku_row: dict, qty: int) -> list[str]:
        """Compra `qty` vouchers Coda de a uno. Si falla a mitad, devuelve los ya comprados."""

        # Antes se hacía un solo placeOrder con quantity=1 y se devolvía [code],
        # ignorando cfg.cantidad_compra → se pedían 40 y llegaba 1.
        # Se compra unidad por unidad: si una falla a mitad, los códigos ya
        # obtenidos se devuelven igual (no se pierden) y el resto se completa
        # en el próximo ciclo.
        codes: list[str] = []
        for i in range(qty):
            try:
                result = await client.place_order(
                    api_path=api_path,
                    sku=cfg.provider_sku,
                    price_amount=sku_row["priceAmount"],
                    price_currency=sku_row["priceCurrency"],
                    customer_id=f"auto-purchase-{cfg.product_id}",
                )
            except Exception as e:
                if not codes:
                    raise
                logger.error(
                    "[%s] Coda unidad %d/%d falló: %s — se devuelven %d código(s)",
                    cfg.product_name, i + 1, qty, str(e) or type(e).__name__, len(codes),
                )
                break

            if not result["success"]:
                if not codes:
                    raise Exception(f"[Coda Voucher] {result['error']}")
                logger.error(
                    "[%s] Coda unidad %d/%d: %s — se devuelven %d código(s)",
                    cfg.product_name, i + 1, qty, result["error"], len(codes),
                )
                break

            code = result["code"]
            if not code:
                if not codes:
                    raise Exception(f"[Coda Voucher] placeOrder OK pero sin código en la respuesta (orderId={result['order_id']})")
                logger.error(
                    "[%s] Coda unidad %d/%d sin código (orderId=%s) — se devuelven %d código(s)",
                    cfg.product_name, i + 1, qty, result["order_id"], len(codes),
                )
                break

            codes.append(code)
            if i < qty - 1:
                await asyncio.sleep(0.3)   # no saturar al proveedor

        if len(codes) < qty:
            logger.warning("[%s] Coda: compra parcial %d/%d", cfg.product_name, len(codes), qty)
        return codes

    async def _coda_resume(self, cfg: "PurchaseConfig", pending_row: dict, *, manual: bool = False,
                           source: str = "auto") -> list[str]:
        meta = pending_row.get("raw_metadata") or {}
        supplier_info = {
            "provider_sku": meta.get("provider_sku") or cfg.provider_sku,
            "metadata":     meta.get("supplier_metadata") or {},
        }
        cfg.provider_sku = supplier_info["provider_sku"]
        set_last_order_result(None)
        return await self._purchase_coda_voucher(cfg, supplier_info, pending_row=pending_row,
                                                 manual=manual, source=source)


    async def _get_coda_voucher_balance(self) -> Optional[float]:
        """Balance de prepago Coda. Puede traer varias monedas — suma solo USD."""
        from app.providers.coda_voucher_client import CodaVoucherClient
        try:
            balances = await CodaVoucherClient().get_balance()
        except Exception as e:
            logger.warning("[Coda Voucher] No se pudo obtener balance: %s", e)
            return None
        usd_total = sum(b["balance"] for b in balances if b.get("currency") == "USD")
        return usd_total if balances else None

    async def _refresh_coda_voucher_prices(self, supplier_list: list[dict]) -> int:
        """Refresca cost_price agrupando por api_path (metadata) para no repetir listSku por SKU."""
        from app.providers.coda_voucher_client import CodaVoucherClient
        from app.core.database import supabase

        client = CodaVoucherClient()
        import json as _json
        by_api_path: dict[str, list[dict]] = {}
        for s in supplier_list:
            raw_meta = s.get("metadata")
            meta = _json.loads(raw_meta) if isinstance(raw_meta, str) else (raw_meta or {})
            api_path = meta.get("api_path")
            if not api_path:
                continue
            by_api_path.setdefault(api_path, []).append(s)

        updated = 0
        missing_skus: list[dict] = []
        for api_path, group in by_api_path.items():
            try:
                skus = await client.list_skus(api_path)
            except Exception as e:
                logger.warning("[PriceRefresh][CodaVoucher] Error listSku(%s): %s", api_path, e)
                continue
            price_map = {s["sku"]: (s["priceAmount"], s["priceCurrency"]) for s in skus}
            for supplier in group:
                sku = supplier.get("provider_sku")
                if sku not in price_map:
                    missing_skus.append({
                        "supplier_id": supplier["id"],
                        "sku": sku,
                        "product_id": supplier.get("product_id"),
                        "product_name": (supplier.get("product") or {}).get("name") or f"producto {supplier.get('product_id')}",
                    })
                    continue
                amount, currency = price_map[sku]
                try:
                    supabase.table("product_suppliers") \
                        .update({"cost_price": amount, "cost_currency": currency}) \
                        .eq("id", supplier["id"]) \
                        .execute()
                    updated += 1
                except Exception as e:
                    logger.warning("[PriceRefresh][CodaVoucher] Error actualizando sku=%s: %s", sku, e)

        logger.info("[PriceRefresh][CodaVoucher] %d precios actualizados", updated)
        await self._deactivate_missing_skus("CodaVoucher", missing_skus)
        return updated

    async def _purchase_manastore(self, cfg: PurchaseConfig, supplier_info: dict) -> list[str]:
        """
        Compra en Manastore: create_order (paga con un wallet) + polling de
        get-codes hasta que el ítem quede status="completed".

        provider_sku = product_variant_id (el id numérico de la variante,
        NO el product_id — ver metadata.provider_item_id para el product_id,
        usado solo para refrescar precios).
        """
        from app.providers.manastore_client import ManastoreClient
        import json as _json

        client = ManastoreClient()
        variant_id = int(supplier_info.get("provider_sku") or cfg.provider_sku)

        purchase_currency = "USD"
        try:
            ps = supabase.table("product_suppliers") \
                .select("purchase_currency") \
                .eq("product_id", cfg.product_id) \
                .eq("provider_sku", str(variant_id)) \
                .limit(1).execute()
            if ps.data and ps.data[0].get("purchase_currency"):
                purchase_currency = ps.data[0]["purchase_currency"].upper()
        except Exception as e:
            logger.warning("[%s] Manastore: no se pudo leer purchase_currency: %s", cfg.product_name, e)

        # ── PASO 1: ¿Existe orden pendiente? ──────────────────────────────────
        existing = await self._ms_get_pending_order(cfg.product_id, variant_id)
        if existing:
            logger.info("[%s] Manastore: retomando orden pendiente orderUlid=%s", cfg.product_name, existing)
            tracked = self._tracker.get("manastore", existing, cfg.product_id)
            requested = (tracked or {}).get("requested_quantity") or cfg.cantidad_compra
            codes = await self._ms_poll_codes(cfg, existing, expected=requested)
            return await self._settle_order(
                cfg, provider="manastore", order_ref=existing,
                requested_quantity=requested, fetched_codes=codes,
                resume_meta={"order_ulid": existing, "variant_id": variant_id, "kind": "order"},
                pending_exc=ManastoreOrderPending(existing, variant_id, cfg.product_id),
            )

        # ── PASO 2: Elegir wallet y crear la orden ────────────────────────────
        wallet_id = await client.get_wallet_id_for_currency(purchase_currency)

        logger.info(
            "[%s] Manastore: comprando variantId=%s qty=%d wallet=%s",
            cfg.product_name, variant_id, cfg.cantidad_compra, wallet_id,
        )
        self._note_submit(cfg, "manastore", cfg.cantidad_compra, meta={"variant_id": variant_id, "kind": "order"})
        order = await client.create_order(
            wallet_id=wallet_id,
            product_variant_id=variant_id,
            quantity=cfg.cantidad_compra,
        )
        order_ulid = order.get("ulid")
        if not order_ulid:
            raise Exception(f"[Manastore] create_order no devolvió 'ulid': {order}")
        self._note_accepted(cfg, order_ulid, {"order_ulid": order_ulid, "variant_id": variant_id})

        logger.info(
            "[%s] Manastore: orden creada ulid=%s fulfillment_status=%s",
            cfg.product_name, order_ulid, order.get("fulfillment_status"),
        )

        # ── PASO 3: Intentar leer códigos de inmediato ────────────────────────
        codes = await self._ms_poll_codes(cfg, order_ulid, quick=True, expected=cfg.cantidad_compra)

        # ── PASO 4: Validar cantidad — lo faltante queda pendiente ────────────
        async def _save():
            logger.warning(
                "[%s] Manastore: orden incompleta (%d/%d) — guardando para retomar (ulid=%s)",
                cfg.product_name, len(codes), cfg.cantidad_compra, order_ulid,
            )
            await self._ms_save_pending_order(cfg.product_id, variant_id, order_ulid)

        return await self._settle_order(
            cfg, provider="manastore", order_ref=order_ulid,
            requested_quantity=cfg.cantidad_compra, fetched_codes=codes,
            resume_meta={"order_ulid": order_ulid, "variant_id": variant_id, "kind": "order"},
            save_pending=_save,
            pending_exc=ManastoreOrderPending(order_ulid, variant_id, cfg.product_id),
        )

    # ── Visoria ─────────────────────────────────────────────────────────────

    async def _purchase_visoria(self, cfg: PurchaseConfig, supplier_info: dict) -> list[str]:
        """
        Compra en Visoria: POST /v1/orders con una idempotency_key nueva y
        polling del estado por esa misma key (que es la referencia de la
        orden: se puede consultar aunque el POST no haya respondido).

        provider_sku = id del producto de Visoria. Solo productos de precio
        fijo (BASIC): face_value = 1, como pide Visoria.
        """
        import uuid
        from app.providers import visoria_client as vs

        # ── ¿Orden pendiente (parcial o sin entregar)? → retomar ESA orden ────
        pending_row = self._tracker.find_pending("visoria", cfg.product_id, str(cfg.provider_sku))
        if pending_row:
            logger.info("[%s] Visoria: retomando orden pendiente %s", cfg.product_name, pending_row.get("order_ref"))
            return await self._visoria_resume(cfg, pending_row)

        key = str(uuid.uuid4())
        currency = (supplier_info.get("cost_currency") or "USD").upper()
        logger.info("[%s] Visoria: comprando producto=%s qty=%d key=%s",
                    cfg.product_name, cfg.provider_sku, cfg.cantidad_compra, key)
        self._note_submit(cfg, "visoria", cfg.cantidad_compra, client_ref=key,
                          meta={"idempotency_key": key, "kind": "order"})
        try:
            order = await vs.create_order(str(cfg.provider_sku), cfg.cantidad_compra, currency, key)
        except vs.VisoriaRejected:
            note_rejected()   # 4xx: la orden no existe → se prueba el siguiente proveedor
            raise
        self._note_accepted(cfg, key, {"idempotency_key": key, "order_id": order.get("id")})

        codes, failed, error = await self._visoria_poll(cfg.product_name, key, cfg.cantidad_compra, order=order)
        if failed and not codes:
            note_rejected()
            self._tracker.discard_intent_if_empty("visoria", key, cfg.product_id)
            raise RuntimeError(f"Visoria: orden {key} {error}")
        return await self._settle_order(
            cfg, provider="visoria", order_ref=key,
            requested_quantity=cfg.cantidad_compra, fetched_codes=codes,
            resume_meta={"idempotency_key": key, "order_id": order.get("id"), "kind": "order"},
            terminal_failure=failed, error=error,
        )

    async def _visoria_resume(self, cfg: PurchaseConfig, pending_row: dict, *, quick: bool = False,
                              manual: bool = False, source: str = "auto") -> list[str]:
        meta = pending_row.get("raw_metadata") or {}
        key = meta.get("idempotency_key") or pending_row.get("order_ref")
        requested = pending_row.get("requested_quantity")
        codes, failed, error = await self._visoria_poll(cfg.product_name, key, requested, attempts=1 if quick else 12)
        return await self._settle_order(
            cfg, provider="visoria", order_ref=pending_row.get("order_ref") or key,
            requested_quantity=requested, fetched_codes=codes,
            terminal_failure=failed, error=error, manual=manual, source=source,
        )

    async def _visoria_poll(self, product_name: str, key: str, expected: Optional[int],
                            order: Optional[dict] = None, attempts: int = 12,
                            delay: float = 5.0) -> tuple[list[str], bool, Optional[str]]:
        """
        Lee la orden por su idempotency_key hasta que esté COMPLETED o traiga
        los códigos esperados. Devuelve (códigos, fallida, error).
        CANCELLED o todas las keys devueltas = fallida (Visoria no cobró).
        """
        from app.providers import visoria_client as vs

        best: list[str] = []
        for attempt in range(attempts):
            if order is None or attempt:
                if attempt:
                    await asyncio.sleep(delay)
                try:
                    order = await vs.get_order_by_key(key)
                except Exception as e:
                    logger.warning("[%s] Visoria: no se pudo consultar la orden %s: %s", product_name, key, e)
                    order = None
                    continue
            status = vs.order_status(order)
            codes = vs.extract_codes(order)
            if len(codes) > len(best):
                best = codes
            if status == "CANCELLED" or vs.all_refunded(order):
                return best, True, f"Visoria: orden {status.lower() or 'devuelta'}"
            if status == "COMPLETED" or (expected and len(best) >= expected):
                logger.info("[%s] Visoria: %d código(s) en orden %s (%s)", product_name, len(best), key, status)
                return best, False, None
        return best, False, None

    async def _get_visoria_balance(self) -> Optional[float]:
        from app.providers import visoria_client as vs
        return await vs.get_balance("USD")

    async def _refresh_visoria_prices(self, supplier_list: list[dict]) -> int:
        """Precio vigente de cada producto (GET /v1/products/{id}). Si falla, conserva el precio."""
        from app.providers import visoria_client as vs

        updated = 0
        for supplier in supplier_list:
            sku = str(supplier.get("provider_sku") or "")
            if not sku:
                continue
            try:
                product = await vs.get_product(sku)
            except Exception as e:
                logger.warning("[PriceRefresh][Visoria] sku=%s sin respuesta: %s — se conserva el precio", sku, e)
                continue
            price = product.get("price")
            if price is None:
                continue
            new_price, currency = float(price), (product.get("currency_code") or "USD").upper()
            old_price = supplier.get("cost_price")
            if old_price is not None and abs(float(old_price) - new_price) < 0.0001 \
                    and (supplier.get("cost_currency") or "USD").upper() == currency:
                continue
            try:
                supabase.table("product_suppliers") \
                    .update({"cost_price": new_price, "cost_currency": currency}) \
                    .eq("id", supplier["id"]).execute()
                updated += 1
            except Exception as e:
                logger.warning("[PriceRefresh][Visoria] Error actualizando sku=%s: %s", sku, e)
        logger.info("[PriceRefresh][Visoria] %d precios actualizados", updated)
        return updated

    async def _ms_poll_codes(
        self, cfg: PurchaseConfig, order_ulid: str, quick: bool = False,
        expected: Optional[int] = None, single: bool = False,
    ) -> list[str]:
        """
        Polling de get-codes. `quick=True` (primer intento tras crear la orden)
        usa una ventana corta (~1 min); al retomar una orden pendiente ya
        guardada se usa una ventana algo más larga (~2 min). `single=True`
        hace una sola consulta (reanudación automática del ciclo).

        Devuelve los códigos visibles cuando la orden está completa o ya hay
        `expected` códigos; al agotar el polling devuelve lo mejor que vio
        (entregas parciales incluidas) — la completitud la decide _settle_order.
        """
        from app.providers.manastore_client import ManastoreClient
        client = ManastoreClient()

        if single:
            POLL_INTERVALS = [2]
        else:
            POLL_INTERVALS = [5, 8, 10, 12, 15, 20] if quick else [5, 10, 10, 15, 15, 20, 20]
        best: list[str] = []

        for i, wait in enumerate(POLL_INTERVALS):
            await asyncio.sleep(wait)
            try:
                items = await client.get_codes(order_ulid)
            except Exception as e:
                logger.warning("[%s] Manastore polling #%d get-codes error: %s", cfg.product_name, i + 1, e)
                continue

            codes: list[str] = []
            all_completed = bool(items)
            for item in items:
                if item.get("status") != "completed":
                    all_completed = False
                    continue
                for c in item.get("codes") or []:
                    code = c.get("code") or c.get("serial_number")
                    if code:
                        codes.append(str(code).strip())

            logger.info(
                "[%s] Manastore polling #%d ulid=%s items=%d codes=%d completed=%s",
                cfg.product_name, i + 1, order_ulid, len(items), len(codes), all_completed,
            )

            if len(codes) > len(best):
                best = codes
            if best and (all_completed or (expected is not None and len(best) >= expected)):
                return best

        return best

    async def _ms_get_pending_order(self, product_id: int, variant_id: int) -> Optional[str]:
        try:
            from datetime import datetime, timezone
            now_iso = datetime.now(timezone.utc).isoformat()
            result = supabase.table("manastore_pending_orders") \
                .select("order_ulid") \
                .eq("product_id", product_id) \
                .eq("variant_id", variant_id) \
                .gt("expires_at", now_iso) \
                .order("created_at", desc=False) \
                .limit(1) \
                .execute()
            if result.data:
                return result.data[0]["order_ulid"]
        except Exception as e:
            logger.warning("[Manastore] _ms_get_pending_order error: %s", e)
        return None

    async def _ms_save_pending_order(self, product_id: int, variant_id: int, order_ulid: str) -> None:
        try:
            created_iso, expires_iso = _pending_expiry_iso()
            supabase.table("manastore_pending_orders").insert({
                "product_id":  product_id,
                "variant_id":  variant_id,
                "order_ulid":  order_ulid,
                "created_at":  created_iso,
                "expires_at":  expires_iso,
            }).execute()
            logger.info(
                "[Manastore] Orden pendiente guardada: product_id=%d variantId=%d ulid=%s expira=%s",
                product_id, variant_id, order_ulid, expires_iso[:10]
            )
        except Exception as e:
            logger.error("[Manastore] No se pudo guardar orden pendiente (ulid=%s): %s", order_ulid, e)

    async def _ms_delete_pending_order(
        self, product_id: int, variant_id: int,
        status: str = "RECOVERED", codes_count: int = 0,
    ) -> None:
        try:
            row = supabase.table("manastore_pending_orders") \
                .select("*") \
                .eq("product_id", product_id) \
                .eq("variant_id", variant_id) \
                .limit(1).execute()
            pending_row = row.data[0] if row.data else {}

            # La completitud la decide _settle_order (validación de cantidades);
            # aquí solo se registran desenlaces terminales (UNRECOVERED).
            if status != STATUS_COMPLETED:
                await _log_recovery(
                    provider="manastore",
                    product_id=product_id,
                    order_ref=pending_row.get("order_ulid") or str(variant_id),
                    status=status,
                    codes_count=codes_count,
                    original_created_at=pending_row.get("created_at"),
                    original_expires_at=pending_row.get("expires_at"),
                    raw_metadata=pending_row,
                )

            supabase.table("manastore_pending_orders") \
                .delete() \
                .eq("product_id", product_id) \
                .eq("variant_id", variant_id) \
                .execute()
            logger.info("[Manastore] Orden pendiente eliminada: product_id=%d variantId=%d status=%s", product_id, variant_id, status)
        except Exception as e:
            logger.warning("[Manastore] No se pudo eliminar orden pendiente: %s", e)

    async def _get_manastore_balance(self) -> Optional[float]:
        """Suma los saldos de los wallets en USD."""
        from app.providers.manastore_client import ManastoreClient
        try:
            wallets = await ManastoreClient().list_wallets()
        except Exception as e:
            logger.warning("[Manastore] No se pudo obtener balance: %s", e)
            return None
        usd_total = 0.0
        found = False
        for w in wallets:
            if (w.get("currency") or "").upper() == "USD":
                try:
                    usd_total += float(w.get("balance", {}).get("amount", 0))
                    found = True
                except (TypeError, ValueError):
                    continue
        return usd_total if found else None

    async def _refresh_manastore_prices(self, supplier_list: list[dict]) -> int:
        """
        Refresca cost_price consultando get_product(product_id) por cada
        product_id único (metadata.product_id) y cruzando por variant_id
        (provider_sku) dentro de la respuesta.

        NOTA: get_product solo devuelve UNA variant en la doc pública — si
        un producto Manastore tiene varias variants, esto puede necesitar
        ajuste cuando se confirme el shape real con variants múltiples.
        """
        from app.providers.manastore_client import ManastoreClient
        import json as _json

        client = ManastoreClient()
        by_product_id: dict[str, list[dict]] = {}
        for s in supplier_list:
            raw_meta = s.get("metadata")
            meta = _json.loads(raw_meta) if isinstance(raw_meta, str) else (raw_meta or {})
            product_id = meta.get("product_id")
            if not product_id:
                continue
            by_product_id.setdefault(str(product_id), []).append(s)

        updated = 0
        missing_skus: list[dict] = []
        for product_id, group in by_product_id.items():
            try:
                product = await client.get_product(int(product_id))
            except Exception as e:
                logger.warning("[PriceRefresh][Manastore] Error get_product(%s): %s", product_id, e)
                continue

            variant = product.get("variant") or {}
            variant_id = str(variant.get("id"))
            price = variant.get("price") or {}
            amount = price.get("decimal")
            currency = price.get("currency", "USD")
            if amount is None:
                for supplier in group:
                    missing_skus.append({
                        "supplier_id": supplier["id"],
                        "sku": supplier.get("provider_sku"),
                        "product_id": supplier.get("product_id"),
                        "product_name": (supplier.get("product") or {}).get("name") or f"producto {supplier.get('product_id')}",
                    })
                continue

            for supplier in group:
                if str(supplier.get("provider_sku")) != variant_id:
                    # NOTA: get_product solo devuelve 1 variant — un mismatch aquí puede
                    # ser solo eso (producto con varias variantes), no un SKU inexistente.
                    # No se desactiva por esta condición para evitar falsos positivos.
                    continue
                try:
                    supabase.table("product_suppliers") \
                        .update({"cost_price": float(amount), "cost_currency": currency}) \
                        .eq("id", supplier["id"]) \
                        .execute()
                    updated += 1
                except Exception as e:
                    logger.warning("[PriceRefresh][Manastore] Error actualizando variantId=%s: %s", variant_id, e)

        logger.info("[PriceRefresh][Manastore] %d precios actualizados", updated)
        await self._deactivate_missing_skus("Manastore", missing_skus)
        return updated

        # ── Hankgames ──────────────────────────────────────────────────────────
    # Compra de códigos: create_transaction (deliver-product) + lectura de
    # get_transaction_details para extraer los pines de items[]. Es
    # sincrónico (Hankgames no maneja pre-orders como WGCards), así que no
    # necesita tabla de "órdenes pendientes" ni polling largo — solo unos
    # pocos reintentos cortos por si el detalle tarda en actualizarse.

    async def _purchase_hankgames(self, cfg: PurchaseConfig, supplier_info: dict) -> list[str]:
        """
        Compra códigos en Hankgames vía deliver-product + capture por índice.

        Si ya existe una orden pendiente en BD (creada en un ciclo anterior
        porque los códigos no llegaron a tiempo), se retoma consultando
        get_transaction_details en vez de crear una orden nueva.
        """
        from app.providers import hankgames_client as hg
        import uuid as _uuid
        import json as _json

        product_id = supplier_info.get("provider_sku") or cfg.provider_sku

        raw_meta = supplier_info.get("metadata")
        try:
            meta = _json.loads(raw_meta) if isinstance(raw_meta, str) else (raw_meta or {})
        except Exception:
            meta = {}
        is_range_topup = bool(meta.get("hankgames_range_topup"))

        face_value = supplier_info.get("face_value") or cfg.face_value
        if is_range_topup and face_value:
            # SKU de monto variable: `quantity` es el MONTO pedido y se entrega
            # UN código por ese monto → se esperan 1 código, no `qty` códigos.
            qty = int(round(float(face_value)))
            expected_codes = 1
        else:
            qty = cfg.cantidad_compra
            expected_codes = qty

        resume_base = {"provider_product_id": product_id, "kind": "order",
                       "range_topup": is_range_topup, "provider_quantity": qty}

        # ── PASO 1: ¿Existe ya una orden pendiente para este producto? ────────
        existing = await self._hg_get_pending_order(cfg.product_id, product_id)
        if existing:
            tracked = self._tracker.get("hankgames", existing, cfg.product_id)
            requested = (tracked or {}).get("requested_quantity") or expected_codes
            logger.info(
                "[%s] Hankgames: retomando orden pendiente orderId=%s (%s/%s recibidos)",
                cfg.product_name, existing, (tracked or {}).get("received_quantity", 0), requested,
            )
            resume_error: Optional[str] = None
            try:
                codes = await hg.get_codes_from_transaction(existing, expected_quantity=requested)
            except hg.HankgamesError as e:
                # Antes esto hacía comprar a otro proveedor con la orden ya pagada.
                codes, resume_error = [], str(e)
                logger.error("[%s] Hankgames: error retomando orderId=%s: %s", cfg.product_name, existing, e)

            # get_codes_from_transaction devuelve TODOS los códigos visibles de
            # la orden (acumulado); _settle_order cuenta solo los nuevos.
            return await self._settle_order(
                cfg, provider="hankgames", order_ref=existing,
                requested_quantity=requested, fetched_codes=codes,
                resume_meta={**resume_base, "order_id": existing}, error=resume_error,
                pending_exc=HankgamesOrderPending(existing, product_id, cfg.product_id),
            )

        # ── PASO 2: Crear la orden ──────────────────────────────────────────────
        external_order_id = f"gc-{cfg.product_id}-{_uuid.uuid4().hex[:12]}"

        logger.info(
            "[%s] Hankgames: comprando productId=%s qty=%d externalOrderId=%s",
            cfg.product_name, product_id, qty, external_order_id,
        )

        self._note_submit(cfg, "hankgames", expected_codes, client_ref=external_order_id,
                          meta={**resume_base, "external_order_id": external_order_id, "kind": "order"})
        try:
            order = await hg.create_transaction(
                product_id=product_id,
                quantity=qty,
                external_order_id=external_order_id,
                # Hankgames a veces tarda más de 60 s en devolver el orderId
                # (orden gc-37-09d1dd75f58b): sin ese número la orden no se
                # puede recuperar, así que se espera hasta 2 minutos.
                timeout=HANKGAMES_CREATE_TIMEOUT,
            )
        except hg.HankgamesError as e:
            msg = str(e)
            if "Timeout" not in msg and "Error de red" not in msg:
                note_rejected()   # la API respondió un error explícito: la orden no se creó
            raise Exception(f"[Hankgames] error creando transacción para productId={product_id}: {e}")

        order_id = order.get("orderId")
        if not order_id:
            raise Exception(f"[Hankgames] deliver-product no devolvió orderId: {order}")
        self._note_accepted(cfg, str(order_id), {**resume_base, "order_id": order_id,
                                                 "external_order_id": external_order_id})

        # ── PASO 3: Intentar leer los códigos de inmediato ──────────────────────
        codes: list[str] = []
        fetch_error: Optional[str] = None
        try:
            codes = await hg.get_codes_from_transaction(order_id, expected_quantity=expected_codes)
        except hg.HankgamesError as e:
            # La orden YA está creada/cobrada: no se pierde, queda pendiente.
            fetch_error = str(e)
            logger.error("[%s] Hankgames: error obteniendo transaction-status de orderId=%s: %s",
                         cfg.product_name, order_id, e)

        # ── PASO 4: Validar cantidad ────────────────────────────────────────────
        # Antes: si pedías 10 y llegaban 2, se devolvían los 2 como si la orden
        # estuviera completa. Ahora los 2 se guardan en inventario y los 8
        # restantes quedan PENDING sobre ESTA orden (nunca se vuelven a pedir 10).
        async def _save():
            logger.warning(
                "[%s] Hankgames: orden incompleta (%d/%d) — guardando para retomar (orderId=%s)",
                cfg.product_name, len(codes), expected_codes, order_id,
            )
            await self._hg_save_pending_order(cfg.product_id, product_id, order_id, external_order_id)

        return await self._settle_order(
            cfg, provider="hankgames", order_ref=order_id,
            requested_quantity=expected_codes, fetched_codes=codes,
            resume_meta={**resume_base, "order_id": order_id, "external_order_id": external_order_id},
            save_pending=_save, error=fetch_error,
            pending_exc=HankgamesOrderPending(order_id, product_id, cfg.product_id),
        )

    async def _hg_get_pending_order(self, product_id: int, provider_product_id: str) -> Optional[str]:
        """Busca una orden Hankgames pendiente no expirada. Retorna orderId o None."""
        try:
            from datetime import datetime, timezone
            now_iso = datetime.now(timezone.utc).isoformat()
            result = supabase.table("hankgames_pending_orders") \
                .select("order_id") \
                .eq("product_id", product_id) \
                .eq("provider_product_id", provider_product_id) \
                .gt("expires_at", now_iso) \
                .order("created_at", desc=False) \
                .limit(1) \
                .execute()
            if result.data:
                return result.data[0]["order_id"]
        except Exception as e:
            logger.warning("[Hankgames] _hg_get_pending_order error: %s", e)
        return None

    async def _hg_save_pending_order(
        self, product_id: int, provider_product_id: str, order_id: str, external_order_id: Optional[str] = None
    ) -> None:
        """Guarda una orden Hankgames pendiente (regla única: pasa a recuperación a los 2 días)."""
        try:
            created_iso, expires_iso = _pending_expiry_iso()
            supabase.table("hankgames_pending_orders").insert({
                "product_id":          product_id,
                "provider_product_id": provider_product_id,
                "order_id":            order_id,
                "external_order_id":   external_order_id,
                "created_at":          created_iso,
                "expires_at":          expires_iso,
            }).execute()
            logger.info(
                "[Hankgames] Orden pendiente guardada: product_id=%d providerProductId=%s orderId=%s expira=%s",
                product_id, provider_product_id, order_id, expires_iso[:10]
            )
        except Exception as e:
            logger.error("[Hankgames] No se pudo guardar orden pendiente (orderId=%s): %s", order_id, e)

    async def _hg_delete_pending_order(
        self, product_id: int, provider_product_id: str,
        status: str = "RECOVERED", codes_count: int = 0,
    ) -> None:
        """Elimina la orden pendiente una vez que llegaron los códigos."""
        try:
            row = supabase.table("hankgames_pending_orders") \
                .select("*") \
                .eq("product_id", product_id) \
                .eq("provider_product_id", provider_product_id) \
                .limit(1).execute()
            pending_row = row.data[0] if row.data else {}

            # La completitud la decide _settle_order (validación de cantidades);
            # aquí solo se registran desenlaces terminales (UNRECOVERED).
            if status != STATUS_COMPLETED:
                await _log_recovery(
                    provider="hankgames",
                    product_id=product_id,
                    order_ref=pending_row.get("order_id") or provider_product_id,
                    status=status,
                    codes_count=codes_count,
                    original_created_at=pending_row.get("created_at"),
                    original_expires_at=pending_row.get("expires_at"),
                    raw_metadata=pending_row,
                )

            supabase.table("hankgames_pending_orders") \
                .delete() \
                .eq("product_id", product_id) \
                .eq("provider_product_id", provider_product_id) \
                .execute()
            logger.info("[Hankgames] Orden pendiente eliminada: product_id=%d providerProductId=%s status=%s", product_id, provider_product_id, status)
        except Exception as e:
            logger.warning("[Hankgames] No se pudo eliminar orden pendiente: %s", e)

    async def _get_hankgames_balance(self) -> Optional[float]:
        """Consulta el saldo de la cuenta Hankgames."""
        from app.providers import hankgames_client as hg
        try:
            result = await hg.get_balance()
        except Exception as e:
            logger.warning("[Hankgames] No se pudo obtener balance: %s", e)
            return None

        if isinstance(result, dict):
            inner = result.get("data") if isinstance(result.get("data"), dict) else result
            for key in ("balance", "amount", "value"):
                if inner.get(key) is not None:
                    try:
                        return float(inner[key])
                    except (TypeError, ValueError):
                        return None
        return None

    async def _refresh_hankgames_prices(self, supplier_list: list[dict]) -> int:
        """Refresca cost_price consultando /product/{productId}/price para cada SKU mapeado."""
        from app.providers import hankgames_client as hg

        updated = 0
        missing_skus: list[dict] = []
        for supplier in supplier_list:
            product_id = supplier.get("provider_sku")
            if not product_id:
                continue
            try:
                price_data = await hg.get_product_price(product_id)
                price = None
                currency = "USD"
                if isinstance(price_data, dict):
                    inner = price_data.get("data") if isinstance(price_data.get("data"), dict) else price_data
                    price = inner.get("price") or inner.get("amount") or inner.get("value")
                    currency = (inner.get("currency") or currency).upper()
                if price is None:
                    logger.warning("[PriceRefresh][Hankgames] productId=%s sin precio en respuesta", product_id)
                    missing_skus.append({
                        "supplier_id": supplier["id"],
                        "sku": product_id,
                        "product_id": supplier.get("product_id"),
                        "product_name": (supplier.get("product") or {}).get("name") or f"producto {supplier.get('product_id')}",
                    })
                    continue

                supabase.table("product_suppliers") \
                    .update({"cost_price": float(price), "cost_currency": currency}) \
                    .eq("id", supplier["id"]) \
                    .execute()
                updated += 1
                logger.debug("[PriceRefresh][Hankgames] productId=%s → %.4f %s", product_id, float(price), currency)
            except Exception as e:
                logger.warning("[PriceRefresh][Hankgames] Error actualizando productId=%s: %s", product_id, e)

        logger.info("[PriceRefresh][Hankgames] %d precios actualizados", updated)
        await self._deactivate_missing_skus("Hankgames", missing_skus)
        return updated

    # ── Wupex ───────────────────────────────────────────────────────────────

    async def _purchase_wupex(self, cfg: PurchaseConfig, supplier_info: dict) -> list[str]:
        """
        Compra códigos en Wupex vía /api/order/pull-codes (allowTakeAll=true).

        1. Revisar si ya hay una orden pendiente en BD para este product/sku
           → retomar consultando /api/order/detail por orderName.
        2. Si no hay pendiente, crear la orden con un referenceId propio.
           - Si entrega completa de inmediato (preOrderNo == null) → devolver códigos.
           - Si preOrderNo != null (pre-order total o parcial) → guardar orden
             pendiente y hacer polling corto; si no completa, lanzar
             WupexOrderPending para retomar en el próximo ciclo (puede tardar
             minutos a días, igual que WGCards).
        """
        from app.providers import wupex_client as wp

        sku = supplier_info.get("provider_sku") or cfg.provider_sku

        # ── PASO 1: ¿Existe ya una orden pendiente para este producto/sku? ────
        pending = await self._wupex_get_pending_order(cfg.product_id, sku)
        if pending:
            order_name, reference_id = pending["order_name"], pending["reference_id"]
            logger.info(
                "[%s] Wupex: retomando orden pendiente orderName=%s",
                cfg.product_name, order_name
            )
            tracked = self._tracker.get("wupex", order_name, cfg.product_id)
            requested = (tracked or {}).get("requested_quantity") or cfg.cantidad_compra
            detail = await wp.get_order_detail(order_name=order_name)
            codes = wp.extract_codes(detail)
            status_type = (detail.get("statusType") or "").lower()

            # Completa SOLO si llegó el 100 % de lo solicitado (no basta con
            # statusType=completed ni con "algún" código). Si Wupex la marca
            # Failed, lo recibido se guarda y la orden pasa a Recuperación.
            return await self._settle_order(
                cfg, provider="wupex", order_ref=order_name,
                requested_quantity=requested, fetched_codes=codes,
                resume_meta={"order_name": order_name, "reference_id": reference_id,
                             "sku": sku, "kind": "order"},
                terminal_failure=(status_type == "failed"),
                error=("Wupex statusType=Failed" if status_type == "failed" else None),
                pending_exc=WupexOrderPending(order_name, sku, cfg.product_id, reference_id),
            )

        # ── PASO 2: Crear la orden ─────────────────────────────────────────────
        logger.info(
            "[%s] Wupex: comprando sku=%s x%d (allowTakeAll=true)",
            cfg.product_name, sku, cfg.cantidad_compra
        )
        import uuid as _uuid_wp
        wp_reference_id = str(_uuid_wp.uuid4())
        self._note_submit(cfg, "wupex", cfg.cantidad_compra, client_ref=wp_reference_id,
                          meta={"reference_id": wp_reference_id, "sku": sku, "kind": "order"})
        data = await wp.create_voucher_order(
            sku=sku,
            quantity=cfg.cantidad_compra,
            reference_id=wp_reference_id,
            allow_take_all=True,
        )

        order_name    = data.get("orderName")
        reference_id  = data.get("_reference_id")
        pre_order_no  = data.get("preOrderNo")
        codes         = wp.extract_codes(data)

        resume_meta = {"order_name": order_name, "reference_id": reference_id, "sku": sku, "kind": "order"}
        if order_name:
            self._note_accepted(cfg, str(order_name), resume_meta)

        async def _save():
            await self._wupex_save_pending_order(cfg.product_id, sku, order_name, reference_id)

        if not pre_order_no:
            # Entrega inmediata
            if not codes:
                raise Exception(f"[Wupex] Orden {order_name} sin preOrderNo pero sin códigos entregados")
            logger.info("[%s] Wupex: entrega inmediata, %d/%d código(s)",
                        cfg.product_name, len(codes), cfg.cantidad_compra)
            return await self._settle_order(
                cfg, provider="wupex", order_ref=order_name,
                requested_quantity=cfg.cantidad_compra, fetched_codes=codes,
                resume_meta=resume_meta, save_pending=_save,
                pending_exc=WupexOrderPending(order_name, sku, cfg.product_id, reference_id),
            )

        # ── PASO 3: Pre-order (total o parcial) — polling corto ────────────────
        logger.info(
            "[%s] Wupex: pre-order creado orderName=%s statusMessage=%s — polling corto...",
            cfg.product_name, order_name, data.get("statusMessage")
        )

        polled = await self._wupex_poll_codes(cfg, order_name, expected=cfg.cantidad_compra)
        # Los códigos entregados de inmediato (pre-order parcial) también cuentan.
        best = polled if len(polled) >= len(codes) else codes

        return await self._settle_order(
            cfg, provider="wupex", order_ref=order_name,
            requested_quantity=cfg.cantidad_compra, fetched_codes=best,
            resume_meta=resume_meta, save_pending=_save,
            pending_exc=WupexOrderPending(order_name, sku, cfg.product_id, reference_id),
        )

    async def _wupex_poll_codes(
        self, cfg: PurchaseConfig, order_name: str,
        expected: Optional[int] = None, quick: bool = False,
    ) -> list[str]:
        """
        Polling corto (~2 min, 1 consulta en modo quick) de /api/order/detail.
        Devuelve lo mejor que vio (incluye entregas parciales); la
        completitud la decide _settle_order.
        """
        from app.providers import wupex_client as wp

        POLL_INTERVALS = [2] if quick else [3, 5, 5, 10, 10, 10, 15, 15, 30, 30]  # ~2 min total
        best: list[str] = []

        for i, wait in enumerate(POLL_INTERVALS):
            await asyncio.sleep(wait)
            try:
                detail = await wp.get_order_detail(order_name=order_name)
                status_type = (detail.get("statusType") or "").lower()
                logger.info(
                    "[%s] Wupex polling #%d orderName=%s statusType=%s progress=%s",
                    cfg.product_name, i + 1, order_name, status_type, detail.get("progress")
                )
                codes = wp.extract_codes(detail)
                if len(codes) > len(best):
                    best = codes
                if status_type == "failed":
                    logger.warning("[%s] Wupex: pre-order %s marcada Failed durante polling", cfg.product_name, order_name)
                    return best
                if best and (status_type == "completed" or (expected is not None and len(best) >= expected)):
                    logger.info("[%s] Wupex: %d códigos en intento #%d", cfg.product_name, len(best), i + 1)
                    return best
            except Exception as e:
                logger.warning("[%s] Wupex polling #%d error: %s", cfg.product_name, i + 1, e)

        logger.info("[%s] Wupex: polling finalizado con %d/%s código(s) para orderName=%s",
                    cfg.product_name, len(best), expected, order_name)
        return best

    async def _wupex_get_pending_order(self, product_id: int, sku: str) -> Optional[dict]:
        """Busca una orden Wupex pendiente no expirada. Retorna {order_name, reference_id} o None."""
        try:
            from datetime import datetime, timezone
            now_iso = datetime.now(timezone.utc).isoformat()
            result = supabase.table("wupex_pending_orders") \
                .select("order_name, reference_id") \
                .eq("product_id", product_id) \
                .eq("sku", sku) \
                .gt("expires_at", now_iso) \
                .order("created_at", desc=False) \
                .limit(1) \
                .execute()
            if result.data:
                return result.data[0]
        except Exception as e:
            logger.warning("[Wupex] _wupex_get_pending_order error: %s", e)
        return None

    async def _wupex_save_pending_order(
        self, product_id: int, sku: str, order_name: str, reference_id: Optional[str]
    ) -> None:
        """Guarda una orden Wupex pendiente (regla única: pasa a recuperación a los 2 días)."""
        try:
            created_iso, expires_iso = _pending_expiry_iso()
            supabase.table("wupex_pending_orders").insert({
                "product_id":   product_id,
                "sku":          sku,
                "order_name":   order_name,
                "reference_id": reference_id,
                "created_at":   created_iso,
                "expires_at":   expires_iso,
            }).execute()
            logger.info(
                "[Wupex] Orden pendiente guardada: product_id=%d sku=%s orderName=%s expira=%s",
                product_id, sku, order_name, expires_iso[:10]
            )
        except Exception as e:
            logger.error("[Wupex] No se pudo guardar orden pendiente (orderName=%s): %s", order_name, e)

    async def _wupex_delete_pending_order(
        self, product_id: int, sku: str,
        status: str = "RECOVERED", codes_count: int = 0,
    ) -> None:
        """Elimina la orden pendiente una vez entregada/completada/fallida."""
        try:
            row = supabase.table("wupex_pending_orders") \
                .select("*") \
                .eq("product_id", product_id) \
                .eq("sku", sku) \
                .limit(1).execute()
            pending_row = row.data[0] if row.data else {}

            # La completitud la decide _settle_order (validación de cantidades);
            # aquí solo se registran desenlaces terminales (UNRECOVERED).
            if status != STATUS_COMPLETED:
                await _log_recovery(
                    provider="wupex",
                    product_id=product_id,
                    order_ref=pending_row.get("order_name") or sku,
                    status=status,
                    codes_count=codes_count,
                    original_created_at=pending_row.get("created_at"),
                    original_expires_at=pending_row.get("expires_at"),
                    raw_metadata=pending_row,
                )

            supabase.table("wupex_pending_orders") \
                .delete() \
                .eq("product_id", product_id) \
                .eq("sku", sku) \
                .execute()
            logger.info("[Wupex] Orden pendiente eliminada: product_id=%d sku=%s status=%s", product_id, sku, status)
        except Exception as e:
            logger.warning("[Wupex] No se pudo eliminar orden pendiente: %s", e)

    async def _get_wupex_balance(self) -> Optional[float]:
        """Lee el balance de la cuenta Wupex."""
        from app.providers import wupex_client as wp
        return await wp.get_balance()

    # ── TISI ────────────────────────────────────────────────────────────────

    async def _purchase_tisi(self, cfg: PurchaseConfig, supplier_info: dict, pending_row: Optional[dict] = None,
                             manual: bool = False, source: str = "auto") -> list[str]:
        """
        Compra PINs en TISI usando el flujo de 3 pasos.
        TISI vende 1 PIN por transacción — se ejecutan cfg.cantidad_compra
        transacciones en secuencia.
        """
        # ── Unidad por unidad: si hay orden PENDING, comprar SOLO lo que falta ─
        if pending_row is None:
            pending_row = self._tracker.find_pending("tisi", cfg.product_id, str(cfg.provider_sku))
        if pending_row:
            requested = int(pending_row.get("requested_quantity") or cfg.cantidad_compra)
            qty = max(1, int(pending_row.get("remaining_quantity")
                             or requested - int(pending_row.get("received_quantity") or 0)))
            order_ref = pending_row["order_ref"]
            logger.info("[%s] TISI: completando orden pendiente %s — faltan %d de %d",
                        cfg.product_name, order_ref, qty, requested)
        else:
            requested = cfg.cantidad_compra
            qty = requested
            order_ref = f"TISI-{cfg.product_id}-{int(time.time() * 1000)}"

        try:
            codes = await self._tisi_buy_units(cfg, supplier_info, qty)
        except Exception as e:
            if not pending_row:
                raise   # nada comprado → igual que antes: siguiente proveedor
            codes, err = [], str(e)
        else:
            err = None

        if not pending_row:
            if not codes:
                return []                 # nada comprado → nada que rastrear
            if len(codes) >= requested:
                return codes              # compra completa normal

        return await self._settle_order(
            cfg, provider="tisi", order_ref=order_ref,
            requested_quantity=requested, fetched_codes=codes,
            resume_meta={"kind": "unit", "provider_sku": str(cfg.provider_sku),
                         "supplier_metadata": supplier_info.get("metadata"),
                         "channel_listing_id": cfg.channel_listing_id},
            error=err, manual=manual, source=source,
        )

    async def _tisi_resume(self, cfg: PurchaseConfig, pending_row: dict, *, manual: bool = False,
                           source: str = "auto") -> list[str]:
        meta = pending_row.get("raw_metadata") or {}
        supplier_info = {
            "provider_sku": meta.get("provider_sku") or cfg.provider_sku,
            "metadata":     meta.get("supplier_metadata") or {},
        }
        cfg.provider_sku = supplier_info["provider_sku"]
        if meta.get("channel_listing_id"):
            cfg.channel_listing_id = meta["channel_listing_id"]
        set_last_order_result(None)
        return await self._purchase_tisi(cfg, supplier_info, pending_row=pending_row,
                                         manual=manual, source=source)

    async def _tisi_buy_units(self, cfg: PurchaseConfig, supplier_info: dict, quantity: int) -> list[str]:
        """
        Ejecuta `quantity` transacciones TISI (1 PIN c/u). Si una falla a mitad
        de camino, devuelve los PINs ya comprados (antes un error técnico
        después de comprar algunos los descartaba aunque ya estaban pagados).
        """
        import time as _time

        from app.providers.tisi_client import tisi_reference_fields
        tisi        = TisiClient()
        id_producto = str(cfg.provider_sku)
        all_codes: list[str] = []

        for i in range(quantity):
            ts  = str(int(_time.time() * 1000))[-7:]
            ref = f"TISI{cfg.product_id}-{cfg.channel_listing_id}-{i+1}-{ts}"
            ref = ref[:50]

            logger.info(
                "[%s] TISI comprando unidad %d/%d id_producto=%s ref=%s",
                cfg.product_name, i + 1, quantity, id_producto, ref,
            )

            try:
                pins, nro_transaccion_tisi = await tisi.purchase(
                    id_producto=id_producto,
                    nro_transaccion_referencia=ref,
                    campos_referencia=tisi_reference_fields(),
                )
                all_codes.extend(pins)
                logger.info(
                    "[%s] TISI unidad %d/%d OK — PIN obtenido",
                    cfg.product_name, i + 1, quantity,
                )
                # Registro para conciliación (mismo código que la compra en tiempo real)
                from app.providers.tisi_client import record_tisi_transaction
                await record_tisi_transaction(tisi, id_producto, ref, nro_transaccion_tisi,
                                              supplier_info.get("metadata"), cfg.product_name)

            except TisiTransactionDuplicate:
                logger.warning(
                    "[%s] TISI ref=%s ya registrada (código 35) — consultando estado",
                    cfg.product_name, ref,
                )
                try:
                    estado = await tisi.get_transaction_status(ref)
                    cod    = str(estado.get("codigo", "")).strip()
                    if cod == "00":
                        recovery_code = f"TISI-DUP-{ref}"
                        all_codes.append(recovery_code)
                        logger.warning(
                            "[%s] TISI ref=%s duplicada y exitosa — registrado como %s",
                            cfg.product_name, ref, recovery_code,
                        )
                    else:
                        logger.error(
                            "[%s] TISI ref=%s duplicada y estado=%s — saltando",
                            cfg.product_name, ref, cod,
                        )
                except Exception as estado_exc:
                    logger.error(
                        "[%s] TISI no se pudo consultar estado de ref=%s: %s",
                        cfg.product_name, ref, estado_exc,
                    )

            except TisiInsufficientBalance as e:
                logger.error("[%s] TISI saldo insuficiente: %s", cfg.product_name, e)
                break

            except TisiError as e:
                logger.error(
                    "[%s] TISI error código=%s unidad %d/%d: %s",
                    cfg.product_name, e.codigo, i + 1, quantity, e,
                )
                if e.codigo in ("01", "02", "04", "05"):
                    if all_codes:
                        break   # no perder los PINs ya pagados
                    raise

            except Exception as e:
                logger.error(
                    "[%s] TISI error técnico unidad %d/%d: %s",
                    cfg.product_name, i + 1, quantity, e,
                )
                if all_codes:
                    break       # no perder los PINs ya pagados
                raise

        return all_codes

    async def _get_tisi_balance(self) -> Optional[float]:
        """Consulta el saldo disponible en TISI (en PEN)."""
        try:
            tisi = TisiClient()
            return await tisi.get_balance()
        except Exception as e:
            logger.warning("[TISI] No se pudo obtener saldo: %s", e)
            return None

    async def _refresh_wupex_prices(self, supplier_list: list[dict]) -> int:
        """Refresca precios de Wupex consultando el catálogo completo."""
        from app.providers import wupex_client as wp

        try:
            items = await wp.get_all_products(page_size=100)
        except Exception as e:
            logger.warning("[PriceRefresh][Wupex] Error obteniendo catálogo: %s", e)
            return 0

        price_map: dict[str, float] = {}
        for item in items:
            sku = str(item.get("productCode") or "")
            price = item.get("price")
            if sku and price is not None:
                try:
                    price_map[sku] = float(price)
                except (TypeError, ValueError):
                    continue

        updated = 0
        missing_skus: list[dict] = []
        for supplier in supplier_list:
            sku = str(supplier.get("provider_sku") or "")
            if not sku:
                continue
            if sku not in price_map:
                missing_skus.append({
                    "supplier_id": supplier["id"],
                    "sku": sku,
                    "product_id": supplier.get("product_id"),
                    "product_name": (supplier.get("product") or {}).get("name") or f"producto {supplier.get('product_id')}",
                })
                continue
            new_price = price_map[sku]
            old_price = supplier.get("cost_price")
            if old_price is not None and abs(float(old_price) - new_price) < 0.0001:
                continue
            try:
                supabase.table("product_suppliers") \
                    .update({"cost_price": new_price, "cost_currency": "USD"}) \
                    .eq("id", supplier["id"]) \
                    .execute()
                updated += 1
                logger.debug("[PriceRefresh][Wupex] %s → $%.4f", sku, new_price)
            except Exception as e:
                logger.warning("[PriceRefresh][Wupex] Error actualizando sku=%s: %s", sku, e)

        logger.info("[PriceRefresh][Wupex] %d precios actualizados", updated)
        await self._deactivate_missing_skus("Wupex", missing_skus)
        return updated

    async def _refresh_ez_prices(self, supplier_list: list[dict]) -> int:
        from app.providers.ez_client import EZClient
        ez = EZClient()
        updated = 0
        BATCH = 100

        skus = list({s["provider_sku"] for s in supplier_list if s.get("provider_sku")})
        total = len(skus)

        print(f"[PriceRefresh][EZ] Iniciando refresh de {total} SKU(s)...", flush=True)
        logger.info("[PriceRefresh][EZ] Iniciando refresh de %d SKUs", total)

        if not skus:
            print("[PriceRefresh][EZ] Sin SKUs con provider_sku, nada que hacer.", flush=True)
            logger.info("[PriceRefresh][EZ] Sin SKUs, saltando.")
            return 0

        n_batches = (total + BATCH - 1) // BATCH
        price_map: dict[str, float] = {}
        for i in range(0, total, BATCH):
            batch = skus[i:i + BATCH]
            batch_num = i // BATCH + 1
            try:
                data = await ez.get_products(limit=1000, page=1, sku=",".join(batch))
                items = data.get("items", [])
                print(f"[PriceRefresh][EZ] Lote {batch_num}/{n_batches} ({len(batch)} SKUs) — {len(items)} items recibidos", flush=True)
                logger.info("[PriceRefresh][EZ] Lote %d/%d: %d items recibidos", batch_num, n_batches, len(items))
            except Exception as e:
                print(f"[PriceRefresh][EZ] ❌ Error obteniendo productos (lote {batch_num}/{n_batches}): {e}", flush=True)
                logger.warning("[PriceRefresh][EZ] Error obteniendo productos (batch=%s): %s", i, e)
                continue

            for item in items:
                sku = item.get("sku")
                prices = item.get("prices", [])
                if sku and prices:
                    sorted_prices = sorted(prices, key=lambda p: p.get("fromQuantity", 0))
                    price_map[sku] = float(sorted_prices[0]["price"])

        print(f"[PriceRefresh][EZ] Catálogo indexado: {len(price_map)} SKUs con precio", flush=True)
        logger.info("[PriceRefresh][EZ] Catálogo indexado: %d SKUs con precio", len(price_map))

        if not price_map:
            print(f"[PriceRefresh][EZ] ⚠️ Sin precios obtenidos tras {n_batches} lote(s)", flush=True)
            logger.warning("[PriceRefresh][EZ] Sin precios obtenidos tras %d lote(s)", n_batches)
            return 0

        not_found = 0
        missing_skus: list[dict] = []
        for supplier in supplier_list:
            sku = supplier.get("provider_sku")
            if not sku:
                continue
            price = price_map.get(sku)
            if price is None:
                not_found += 1
                logger.warning("[PriceRefresh][EZ] sku=%s: no encontrado en respuesta de EZ", sku)
                missing_skus.append({
                    "supplier_id": supplier["id"],
                    "sku": sku,
                    "product_id": supplier.get("product_id"),
                    "product_name": (supplier.get("product") or {}).get("name") or f"producto {supplier.get('product_id')}",
                })
                continue
            old_price = supplier.get("cost_price")
            if old_price is not None and abs(float(old_price) - price) < 0.0001:
                logger.info("[PriceRefresh][EZ] sku=%s: sin cambio ($%.4f), saltando BD", sku, price)
                continue
            try:
                supabase.table("product_suppliers") \
                    .update({"cost_price": price, "cost_currency": "USD"}) \
                    .eq("id", supplier["id"]) \
                    .execute()
                print(f"[PriceRefresh][EZ] ✅ sku={sku}: ${float(old_price or 0):.4f} → ${price:.4f} GUARDADO", flush=True)
                logger.info("[PriceRefresh][EZ] sku=%s: $%.4f → $%.4f", sku, float(old_price or 0), price)
                updated += 1
            except Exception as e:
                print(f"[PriceRefresh][EZ] ❌ Error actualizando sku={sku}: {e}", flush=True)
                logger.warning("[PriceRefresh][EZ] Error actualizando sku=%s: %s", sku, e)

        print(f"[PriceRefresh][EZ] Completado: {updated}/{total} actualizados ({not_found} no encontrados en EZ)", flush=True)
        logger.info("[PriceRefresh][EZ] Completado: %d/%d actualizados, %d no encontrados", updated, total, not_found)
        await self._deactivate_missing_skus("EZ", missing_skus)
        return updated

    async def _get_wgcards_balance(self, cfg: "PurchaseConfig") -> tuple[Optional[float], str]:
        """Lee el saldo de la cuenta WGCards según purchase_currency del supplier. Devuelve (balance, currency)."""
        from app.providers import wgcards_client as wg

        purchase_currency = "USD"
        try:
            ps = supabase.table("product_suppliers") \
                .select("purchase_currency") \
                .eq("product_id", cfg.product_id) \
                .eq("provider_sku", cfg.provider_sku) \
                .eq("is_active", True) \
                .limit(1) \
                .execute()
            if ps.data and ps.data[0].get("purchase_currency"):
                purchase_currency = ps.data[0]["purchase_currency"].upper()
        except Exception:
            pass

        try:
            account = await wg.get_account()
            accounts = account.get("accounts", [])
            for wallet in accounts:
                if wallet.get("currency", "").upper() == purchase_currency and wallet.get("effective"):
                    raw = wallet.get("balance", 0)
                    # API v4: balance en unidades normales (string decimal, ej. "200.00").
                    # En v3 venía escalado ×1e9 — ya no se divide.
                    return round(wg.wallet_balance(wallet), 2), purchase_currency
            # Si no encuentra la moneda exacta, retorna el primero activo
            for wallet in accounts:
                if wallet.get("effective"):
                    raw = wallet.get("balance", 0)
                    return round(wg.wallet_balance(wallet), 2), wallet.get("currency", "USD").upper()
        except Exception as e:
            logger.warning("[%s] WGCards: no se pudo obtener balance: %s", cfg.product_name, e)

        return None, purchase_currency
    # =========================================================================
    # ENEBA WHOLESALE — Auto-compra
    # =========================================================================
 
    async def _purchase_eneba(
        self, cfg: "PurchaseConfig", supplier_info: dict
    ) -> list[str]:
        """
        Compra claves en Eneba Wholesale con lógica de 3 fases:
 
        1. ¿Existe orden pendiente en BD?
           ├─ stage=ACTION_POLLING  → pollear A_action 2 min
           │   ├─ COMPLETED → obtener entryToken → avanzar a EXPORT_PENDING
           │   └─ Aún NEW   → actualizar BD, lanzar EnebaOrderPending
           ├─ stage=EXPORT_PENDING  → pollear O_orderExport 2 min
           │   ├─ COMPLETED → descargar ZIP → extraer códigos → retornar
           │   └─ Aún PENDING → lanzar EnebaOrderPending
           └─ stage=DOWNLOAD_READY → descargar ZIP (downloadUrl guardada o nueva)
              ├─ OK  → retornar códigos
              └─ URL expirada → redo export_order_keys → lanzar EnebaOrderPending
 
        2. No hay orden pendiente:
           → buscar subasta → comprar → pollear action 2 min
           → si rápido: exportar → pollear export → descargar → retornar ✅
           → si lento:  guardar BD → lanzar EnebaOrderPending
        """
        from app.providers.eneba_wholesale_client import get_eneba_wholesale_client
 
        client     = get_eneba_wholesale_client()
        auction_id = supplier_info.get("provider_sku") or cfg.provider_sku
        qty        = cfg.cantidad_compra
 
        # ── PASO 1: ¿Existe orden pendiente? ─────────────────────────────────
        pending = await self._eneba_get_pending_order(cfg.product_id, auction_id)
 
        if pending:
            logger.info(
                "[%s] Eneba: retomando orden pendiente orderId=%s stage=%s",
                cfg.product_name, pending["order_id"], pending["stage"]
            )
            tracked = self._tracker.get("eneba_wholesale", pending["order_id"], cfg.product_id)
            requested = (tracked or {}).get("requested_quantity") or qty
            return await self._eneba_settle(
                cfg, pending["order_id"], requested,
                lambda: self._eneba_resume_pending(cfg, client, pending),
                base_meta={"order_id": pending["order_id"], "action_id": pending.get("action_id"),
                           "auction_id": auction_id},
            )
 
        # ── PASO 2: Nueva compra ──────────────────────────────────────────────
        logger.info(
            "[%s] Eneba: comprando auctionId=%s qty=%d",
            cfg.product_name, auction_id, qty
        )
 
        self._note_submit(cfg, "eneba", qty, meta={"auction_id": auction_id, "kind": "order"})
        purchase = await client.purchase_wholesale_auctions([
            {"auctionId": auction_id, "quantity": qty}
        ])
 
        order_id  = purchase["orderId"]
        action_id = purchase["actionId"]
        self._note_accepted(cfg, str(order_id), {"order_id": order_id, "action_id": action_id,
                                                 "auction_id": auction_id})
 
        logger.info(
            "[%s] Eneba: compra iniciada orderId=%s actionId=%s",
            cfg.product_name, order_id, action_id
        )
 
        async def _continue_new_order() -> list[str]:
            # ── PASO 3: Polling inmediato de la acción (~2 min) ───────────────────
            state = await client.poll_action_until_done(action_id, cfg.product_name)
 
            if state == "FAILED":
                note_rejected()
                self._tracker.discard_intent_if_empty("eneba", str(order_id), cfg.product_id)
                raise RuntimeError(
                    f"[Eneba] Compra rechazada actionId={action_id} — revisar saldo EUR"
                )
 
            if state != "COMPLETED":
                # Aún en proceso → guardar y retomar en próximo ciclo
                await self._eneba_save_pending_order(
                    product_id   = cfg.product_id,
                    auction_id   = auction_id,
                    order_id     = order_id,
                    action_id    = action_id,
                    stage        = "ACTION_POLLING",
                )
                raise EnebaOrderPending(
                    order_id=order_id, action_id=action_id,
                    auction_id=auction_id, product_id=cfg.product_id,
                    stage="ACTION_POLLING",
                )
 
            # ── PASO 4: Acción COMPLETED → obtener entryToken ─────────────────────
            logger.info("[%s] Eneba: compra COMPLETED — buscando entryToken...", cfg.product_name)
            entry_token = await self._eneba_find_entry_token(client, order_id, cfg.product_name)
 
            if not entry_token:
                # No encontró la orden aún en O_orders — guardar y retomar
                await self._eneba_save_pending_order(
                    product_id  = cfg.product_id,
                    auction_id  = auction_id,
                    order_id    = order_id,
                    action_id   = action_id,
                    stage       = "EXPORT_PENDING",
                )
                raise EnebaOrderPending(
                    order_id=order_id, action_id=action_id,
                    auction_id=auction_id, product_id=cfg.product_id,
                    stage="EXPORT_PENDING",
                )
 
            # ── PASO 5: Iniciar exportación del ZIP ───────────────────────────────
            codes = await self._eneba_export_and_download(
                cfg=cfg, client=client,
                order_id=order_id, action_id=action_id,
                auction_id=auction_id, entry_token=entry_token,
            )
            return codes
 

        return await self._eneba_settle(
            cfg, order_id, qty, _continue_new_order,
            base_meta={"order_id": order_id, "action_id": action_id, "auction_id": auction_id},
        )

    async def _eneba_settle(
        self, cfg: "PurchaseConfig", order_id: str, requested: int, fetch, base_meta: dict,
        manual: bool = False, source: str = "auto",
    ) -> list[str]:
        """
        Ejecuta la fase de Eneba que toque (`fetch`) y valida cantidades con
        _settle_order. Si Eneba aún no tiene las claves (EnebaOrderPending),
        el intento queda registrado igual, para que la orden aparezca en
        "Recuperación de órdenes" como pendiente.
        """
        try:
            codes = await fetch()
            stage, pending_exc = None, None
        except EnebaOrderPending as e:
            codes, stage, pending_exc = [], e.stage, e
        return await self._settle_order(
            cfg, provider="eneba_wholesale", order_ref=order_id,
            requested_quantity=requested, fetched_codes=codes,
            resume_meta={**base_meta, "kind": "order", **({"stage": stage} if stage else {})},
            stage=stage, manual=manual, source=source,
            pending_exc=pending_exc or EnebaOrderPending(
                order_id=order_id, action_id=base_meta.get("action_id") or "",
                auction_id=base_meta.get("auction_id") or "", product_id=cfg.product_id,
                stage="DOWNLOAD_READY",
            ),
        )

    async def _eneba_resume_pending(
        self,
        cfg: "PurchaseConfig",
        client,
        pending: dict,
    ) -> list[str]:
        """Retoma una orden Eneba pendiente según su stage actual."""
        order_id     = pending["order_id"]
        action_id    = pending["action_id"]
        auction_id   = pending["auction_id"]
        stage        = pending["stage"]
        entry_token  = pending.get("entry_token")
        download_url = pending.get("download_url")
 
        if stage == "ACTION_POLLING":
            # Pollear la acción
            logger.info(
                "[%s] Eneba resume: actionId=%s — iniciando polling...",
                cfg.product_name, action_id
            )
            state = await client.poll_action_until_done(action_id, cfg.product_name)
            logger.info(
                "[%s] Eneba resume: polling terminó con state=%s",
                cfg.product_name, state
            )
 
            if state == "FAILED":
                await self._eneba_delete_pending_order(
                    cfg.product_id, auction_id, status="UNRECOVERED"
                )
                raise RuntimeError(
                    f"[Eneba] Compra rechazada actionId={action_id}"
                )
 
            if state != "COMPLETED":
                raise EnebaOrderPending(
                    order_id=order_id, action_id=action_id,
                    auction_id=auction_id, product_id=cfg.product_id,
                    stage="ACTION_POLLING",
                )
 
            # COMPLETED → buscar entryToken
            entry_token = await self._eneba_find_entry_token(client, order_id, cfg.product_name)
            if not entry_token:
                await self._eneba_update_pending_order(
                    cfg.product_id, auction_id, stage="EXPORT_PENDING"
                )
                raise EnebaOrderPending(
                    order_id=order_id, action_id=action_id,
                    auction_id=auction_id, product_id=cfg.product_id,
                    stage="EXPORT_PENDING",
                )
 
            # Avanzar a exportación
            await self._eneba_update_pending_order(
                cfg.product_id, auction_id,
                stage="EXPORT_PENDING", entry_token=entry_token
            )
            stage = "EXPORT_PENDING"
 
        if stage == "EXPORT_PENDING":
            codes = await self._eneba_export_and_download(
                cfg=cfg, client=client,
                order_id=order_id, action_id=action_id,
                auction_id=auction_id, entry_token=entry_token,
                is_resuming=True,
            )
            return codes
 
        if stage == "DOWNLOAD_READY":
            # Intentar con la URL guardada (puede haber expirado)
            if download_url:
                try:
                    codes = await client.download_and_extract_keys(download_url)
                    if codes:
                        # La completitud (cantidad) la valida _settle_order.
                        logger.info(
                            "[%s] Eneba: %d claves extraídas del ZIP guardado",
                            cfg.product_name, len(codes)
                        )
                        return codes
                except Exception as e:
                    logger.warning(
                        "[%s] Eneba: downloadUrl expirada o inválida (%s) — regenerando export",
                        cfg.product_name, e
                    )
 
            # URL expirada → hacer nuevo export_order_keys
            if entry_token:
                codes = await self._eneba_export_and_download(
                    cfg=cfg, client=client,
                    order_id=order_id, action_id=action_id,
                    auction_id=auction_id, entry_token=entry_token,
                    is_resuming=True,
                )
                return codes
 
            raise EnebaOrderPending(
                order_id=order_id, action_id=action_id,
                auction_id=auction_id, product_id=cfg.product_id,
                stage="EXPORT_PENDING",
            )
 
        raise RuntimeError(f"[Eneba] Stage desconocido: {stage}")
 
    async def _eneba_export_and_download(
        self,
        cfg: "PurchaseConfig",
        client,
        order_id: str,
        action_id: str,
        auction_id: str,
        entry_token: str,
        is_resuming: bool = False,
    ) -> list[str]:
        """Inicia export, pollera hasta COMPLETED, descarga ZIP y extrae claves."""
 
        logger.info(
            "[%s] Eneba: iniciando exportación de claves entryToken=%s",
            cfg.product_name, entry_token
        )
        await client.export_order_keys(entry_token)
 
        # Pollear hasta que el ZIP esté listo (~2 min)
        download_url = await client.poll_export_until_done(entry_token, cfg.product_name)
 
        if not download_url:
            # ZIP no listo en este ciclo → guardar y retomar
            await self._eneba_update_pending_order(
                cfg.product_id, auction_id,
                stage="EXPORT_PENDING", entry_token=entry_token
            ) if is_resuming else await self._eneba_save_pending_order(
                product_id  = cfg.product_id,
                auction_id  = auction_id,
                order_id    = order_id,
                action_id   = action_id,
                stage       = "EXPORT_PENDING",
                entry_token = entry_token,
            )
            raise EnebaOrderPending(
                order_id=order_id, action_id=action_id,
                auction_id=auction_id, product_id=cfg.product_id,
                stage="EXPORT_PENDING", entry_token=entry_token,
            )
 
        # Guardar downloadUrl por si la descarga falla
        await self._eneba_update_pending_order(
            cfg.product_id, auction_id,
            stage="DOWNLOAD_READY",
            entry_token=entry_token,
            download_url=download_url,
        ) if is_resuming else await self._eneba_save_pending_order(
            product_id   = cfg.product_id,
            auction_id   = auction_id,
            order_id     = order_id,
            action_id    = action_id,
            stage        = "DOWNLOAD_READY",
            entry_token  = entry_token,
            download_url = download_url,
        )
 
        # Descargar y extraer
        codes = await client.download_and_extract_keys(download_url)
 
        if not codes:
            # Antes: RuntimeError → se compraba a OTRO proveedor con la orden
            # ya pagada. Ahora la orden queda pendiente en stage DOWNLOAD_READY.
            logger.warning("[%s] Eneba: ZIP descargado pero sin códigos para orderId=%s",
                           cfg.product_name, order_id)
            raise EnebaOrderPending(
                order_id=order_id, action_id=action_id,
                auction_id=auction_id, product_id=cfg.product_id,
                stage="DOWNLOAD_READY", entry_token=entry_token, download_url=download_url,
            )

        # La validación de cantidad y la limpieza del puntero las hace _settle_order.
        logger.info(
            "[%s] Eneba: ✅ %d claves extraídas para orderId=%s",
            cfg.product_name, len(codes), order_id
        )
        return codes
 
    async def _eneba_find_entry_token(
        self, client, order_id: str, product_name: str = ""
    ) -> Optional[str]:
        """
        Busca el entryToken en O_orders filtrando directamente por orderId.
        O_orders soporta el argumento orderIds (max 20) para buscar sin paginar,
        lo que evita devolver el entryToken de una orden distinta si hay compras concurrentes.
        """
        try:
            result = await client.list_orders(first=1, order_ids=[order_id])
            edges  = result.get("edges", [])
            for edge in edges:
                node = edge.get("node", {})
                entry_token = node.get("entryToken")
                if entry_token:
                    logger.info(
                        "[%s] Eneba: entryToken encontrado=%s (orderId=%s orderState=%s)",
                        product_name, entry_token, order_id, node.get("orderState")
                    )
                    return entry_token
        except Exception as e:
            logger.warning(
                "[%s] Eneba: error buscando entryToken (orderId=%s): %s",
                product_name, order_id, e
            )

        logger.warning(
            "[%s] Eneba: no se encontró entryToken para orderId=%s",
            product_name, order_id
        )
        return None
 
    # ── BD helpers ────────────────────────────────────────────────────────────
 
    async def _eneba_get_pending_order(
        self, product_id: int, auction_id: str
    ) -> Optional[dict]:
        """Busca una orden Eneba pendiente no expirada."""
        try:
            from datetime import datetime, timezone
            now_iso = datetime.now(timezone.utc).isoformat()
            result  = supabase.table("eneba_pending_orders") \
                .select("*") \
                .eq("product_id", product_id) \
                .eq("auction_id", auction_id) \
                .gt("expires_at", now_iso) \
                .order("created_at", desc=False) \
                .limit(1) \
                .execute()
            if result.data:
                return result.data[0]
        except Exception as e:
            logger.warning("[Eneba] _eneba_get_pending_order error: %s", e)
        return None
 
    async def _eneba_save_pending_order(
        self,
        product_id: int,
        auction_id: str,
        order_id: str,
        action_id: str,
        stage: str,
        entry_token: Optional[str] = None,
        download_url: Optional[str] = None,
    ) -> None:
        """Guarda una orden Eneba pendiente (regla única: pasa a recuperación a los 2 días)."""
        try:
            from datetime import datetime, timezone, timedelta
            now     = datetime.now(timezone.utc)
            expires = now + timedelta(days=PENDING_ORDER_RECOVERY_DAYS)
            supabase.table("eneba_pending_orders").upsert({
                "product_id":   product_id,
                "auction_id":   auction_id,
                "order_id":     order_id,
                "action_id":    action_id,
                "stage":        stage,
                "entry_token":  entry_token,
                "download_url": download_url,
                "created_at":   now.isoformat(),
                "expires_at":   expires.isoformat(),
            }, on_conflict="product_id,auction_id").execute()
            logger.info(
                "[Eneba] Orden pendiente guardada: product_id=%d auctionId=%s "
                "orderId=%s stage=%s expira=%s",
                product_id, auction_id, order_id, stage, expires.date()
            )
        except Exception as e:
            logger.error(
                "[Eneba] No se pudo guardar orden pendiente (orderId=%s): %s",
                order_id, e
            )
 
    async def _eneba_update_pending_order(
        self,
        product_id: int,
        auction_id: str,
        stage: str,
        entry_token: Optional[str] = None,
        download_url: Optional[str] = None,
    ) -> None:
        """Actualiza el stage (y opcionalmente entry_token/download_url) de una orden pendiente."""
        try:
            updates: dict = {"stage": stage}
            if entry_token  is not None:
                updates["entry_token"]  = entry_token
            if download_url is not None:
                updates["download_url"] = download_url
 
            supabase.table("eneba_pending_orders") \
                .update(updates) \
                .eq("product_id", product_id) \
                .eq("auction_id", auction_id) \
                .execute()
            logger.info(
                "[Eneba] Orden pendiente actualizada: product_id=%d auctionId=%s → stage=%s",
                product_id, auction_id, stage
            )
        except Exception as e:
            logger.warning("[Eneba] _eneba_update_pending_order error: %s", e)
 
    async def _eneba_delete_pending_order(
        self, product_id: int, auction_id: str,
        status: str = "RECOVERED", codes_count: int = 0,
    ) -> None:
        """
        Elimina la orden pendiente (éxito o falla terminal) y deja constancia
        en provider_recovery_log antes de borrar, para no perder el historial.

        status="RECOVERED"   → se llama tras extraer códigos exitosamente.
        status="UNRECOVERED" → se llama tras un FAILED terminal (compra rechazada).
        """
        try:
            row = supabase.table("eneba_pending_orders") \
                .select("*") \
                .eq("product_id", product_id) \
                .eq("auction_id", auction_id) \
                .limit(1).execute()
            pending_row = row.data[0] if row.data else {}

            # La completitud la decide _settle_order (validación de cantidades);
            # aquí solo se registran desenlaces terminales (UNRECOVERED).
            if status != STATUS_COMPLETED:
                await _log_recovery(
                    provider="eneba_wholesale",
                    product_id=product_id,
                    order_ref=pending_row.get("order_id") or auction_id,
                    stage_at_resolution=pending_row.get("stage"),
                    status=status,
                    codes_count=codes_count,
                    original_created_at=pending_row.get("created_at"),
                    original_expires_at=pending_row.get("expires_at"),
                    raw_metadata=pending_row,
                )

            supabase.table("eneba_pending_orders") \
                .delete() \
                .eq("product_id", product_id) \
                .eq("auction_id", auction_id) \
                .execute()
            logger.info(
                "[Eneba] Orden pendiente eliminada: product_id=%d auctionId=%s status=%s",
                product_id, auction_id, status
            )
        except Exception as e:
            logger.warning("[Eneba] _eneba_delete_pending_order error: %s", e)


# ── Recuperación de órdenes pendientes (manual Y automática, misma lógica) ────

async def _recover_fetch_and_settle(
    service: "AutoPurchaseService", cfg: PurchaseConfig, row: dict,
    *, manual: bool, quick: bool, source: str,
) -> list[str]:
    """
    Consulta al proveedor la orden `row` (de provider_recovery_log) y valida
    cantidades con _settle_order. Devuelve los códigos a insertar.
    Lanza ProviderOrderPending si no llegó nada nuevo.
    """
    provider  = row["provider"]
    order_ref = str(row["order_ref"])
    meta      = row.get("raw_metadata") or {}
    requested = row.get("requested_quantity")   # None solo en filas legadas
    common = dict(manual=manual, source=source)

    if provider == "bamboo":
        return await service._bamboo_resume(cfg, row, quick=quick, **common)
    if provider == "cardone":
        return await service._cardone_resume(cfg, row, quick=quick, **common)
    if provider == "icodes":
        return await service._icodes_resume(cfg, row, quick=quick, **common)
    if provider == "tisi":
        return await service._tisi_resume(cfg, row, **common)
    if provider == "visoria":
        return await service._visoria_resume(cfg, row, quick=quick, **common)
    if provider == "coda_voucher":
        return await service._coda_resume(cfg, row, **common)

    if provider == "ez":
        from app.providers.ez_client import EZClient
        tx = meta.get("transaction_id") or order_ref
        cfg.provider_sku = meta.get("provider_sku") or cfg.provider_sku
        codes = await service._ez_poll_codes(EZClient(), cfg, tx, expected=requested, quick=quick)
        return await service._settle_order(cfg, provider="ez", order_ref=order_ref,
                                           requested_quantity=requested, fetched_codes=codes, **common)

    if provider == "wgcards":
        codes = await service._wg_poll_codes(cfg, meta.get("order_id") or order_ref,
                                             expected=requested, quick=quick)
        return await service._settle_order(cfg, provider="wgcards", order_ref=order_ref,
                                           requested_quantity=requested, fetched_codes=codes, **common)

    if provider == "wupex":
        from app.providers import wupex_client as wp
        detail = await wp.get_order_detail(order_name=meta.get("order_name") or order_ref)
        failed = (detail.get("statusType") or "").lower() == "failed"
        return await service._settle_order(
            cfg, provider="wupex", order_ref=order_ref, requested_quantity=requested,
            fetched_codes=wp.extract_codes(detail), terminal_failure=failed,
            error="Wupex statusType=Failed" if failed else None, **common,
        )

    if provider == "hankgames":
        from app.providers import hankgames_client as hg
        codes = await hg.get_codes_from_transaction(
            meta.get("order_id") or order_ref, expected_quantity=requested,
            max_attempts=1 if quick else 20,
        )
        return await service._settle_order(cfg, provider="hankgames", order_ref=order_ref,
                                           requested_quantity=requested, fetched_codes=codes, **common)

    if provider == "manastore":
        codes = await service._ms_poll_codes(cfg, meta.get("order_ulid") or order_ref,
                                             expected=requested, single=quick)
        return await service._settle_order(cfg, provider="manastore", order_ref=order_ref,
                                           requested_quantity=requested, fetched_codes=codes, **common)

    if provider == "eneba_wholesale":
        from app.providers.eneba_wholesale_client import get_eneba_wholesale_client
        client = get_eneba_wholesale_client()
        # El puntero vivo (si existe) tiene el stage/entry_token más reciente.
        pending = dict(meta)
        try:
            ptr = supabase.table("eneba_pending_orders").select("*") \
                .eq("order_id", meta.get("order_id") or order_ref).limit(1).execute()
            if ptr.data:
                pending.update(ptr.data[0])
        except Exception:
            pass
        pending.setdefault("order_id", order_ref)
        pending.setdefault("stage", "ACTION_POLLING")
        if pending.get("stage") in ("EXPORT_PENDING", "DOWNLOAD_READY") and not (
            pending.get("entry_token") or pending.get("download_url")
        ):
            pending["stage"] = "ACTION_POLLING"   # re-obtener entryToken
        if not pending.get("action_id") or not pending.get("auction_id"):
            raise RuntimeError("Eneba: faltan action_id/auction_id en la orden guardada")
        return await service._eneba_settle(
            cfg, order_ref, requested,
            lambda: service._eneba_resume_pending(cfg, client, pending),
            base_meta={"order_id": pending["order_id"], "action_id": pending["action_id"],
                       "auction_id": pending["auction_id"]},
            **common,
        )

    raise RuntimeError(f"Proveedor sin recuperación implementada: {provider}")


async def recover_tracked_order(log_entry: dict, *, manual: bool = True, quick: bool = False,
                                lock_held: bool = False) -> dict:
    """
    Recupera AHORA una orden de provider_recovery_log (PENDING o
    UNRECOVERED). Es EXACTAMENTE la misma lógica para:
      - el botón "Recuperar ahora" (manual=True, polling completo ~2 min), y
      - la reanudación automática de cada ciclo (manual=False, quick=True).

    1. Consulta al proveedor SOLO por esa orden (nunca crea una orden nueva,
       salvo TISI/Coda donde se compran únicamente las unidades faltantes).
    2. Valida cantidades: cuenta solo códigos nuevos, rechaza duplicados.
    3. Inserta los códigos nuevos en inventory_codes (el mismo destino del
       ciclo automático; Falabella los toma después con auto_purchase_task).
    4. Completa la orden SOLO si recibido acumulado == solicitado; si no,
       la deja como estaba (PENDING o En recuperación) con lo pendiente.
    """
    provider   = log_entry.get("provider")
    product_id = log_entry.get("product_id")
    order_ref  = log_entry.get("order_ref")
    meta       = log_entry.get("raw_metadata") or {}
    source     = "manual" if manual else "auto_resume"

    if log_entry.get("status") == STATUS_COMPLETED:
        return {"success": False, "message": "Esta orden ya está completada", "status": STATUS_COMPLETED}
    if not meta:
        return {"success": False, "message": "Sin datos de la orden guardados — no se puede reintentar"}

    product_name = meta.get("product_name") or f"producto {product_id}"
    try:
        p = supabase.table("products").select("name").eq("id", product_id).limit(1).execute()
        if p.data:
            product_name = p.data[0]["name"]
    except Exception:
        pass

    requested = log_entry.get("requested_quantity")
    cfg = PurchaseConfig(
        product_id=product_id,
        product_name=product_name,
        seller_sku="", shop_sku="",
        # filas legadas no guardaban provider_code; "eneba_wholesale" es "eneba" en providers.code
        provider_code=meta.get("provider_code") or {"eneba_wholesale": "eneba"}.get(provider, provider),
        provider_sku=str(meta.get("provider_sku") or order_ref),
        auto_compra_activa=True, umbral_minimo=0,
        cantidad_compra=int(requested or 1),
        channel_listing_id=int(meta.get("channel_listing_id") or 0),
        face_value=meta.get("face_value"),
    )

    acquired = True if (lock_held or product_id is None) else await _lock_manager.acquire(product_id)
    if not acquired:
        if distributed_lock.last_failure:
            return {"success": False, "message": f"No se puede recuperar ahora: {distributed_lock.last_failure}"}
        return {"success": False, "message": "El producto se está procesando en este momento — intenta en unos minutos"}

    service = get_auto_purchase_service()
    codes: list[str] = []
    error_msg: Optional[str] = None
    set_last_order_result(None)
    try:
        codes = await _recover_fetch_and_settle(service, cfg, log_entry, manual=manual, quick=quick, source=source)
    except ProviderOrderPending:
        codes = []
    except Exception as e:
        error_msg = str(e)
        logger.warning("[Recovery] %s %s/%s: %s", product_name, provider, order_ref, e)
    finally:
        if product_id is not None and not lock_held:
            await _lock_manager.release(product_id)

    result = get_last_order_result()

    # Si el proveedor falló antes de poder registrar el intento, se deja constancia igual.
    if result is None and error_msg:
        try:
            result = _tracker.record_attempt(
                provider=provider, order_ref=str(order_ref), product_id=product_id,
                requested_quantity=requested, fetched_codes=[], manual=manual,
                source=source, error=error_msg,
            )
        except Exception:
            pass

    inserted = {"inserted": 0, "duplicates": 0, "errors": []}
    if codes:
        inserted = insert_inventory_codes(product_id, cfg.provider_code, codes, source="auto_replenishment")
        if inserted["errors"]:
            # Los códigos NO quedaron en inventario pero sí contados: el próximo
            # intento los volverá a ofrecer para insertar (no se pierden).
            logger.error("[Recovery] %s: fallo insertando en inventario: %s", product_name, inserted["errors"])

    payload = {
        "success": bool(codes) and not inserted["errors"],
        "provider": provider,
        "order_ref": order_ref,
        "codes_recovered": result.received_quantity if result else len(codes),
        "codes_inserted_inventory": inserted["inserted"],
        "duplicates_rejected": (result.duplicates_rejected if result else 0) + inserted["duplicates"],
        "requested_quantity": result.requested_quantity if result else requested,
        "received_quantity": result.total_received_quantity if result else None,
        "remaining_quantity": result.remaining_quantity if result else None,
        "status": result.status if result else log_entry.get("status"),
        "error": error_msg,
    }

    if inserted["errors"]:
        payload["message"] = (
            f"{len(codes)} código(s) recibido(s) del proveedor pero NO se pudieron guardar en inventario "
            f"({inserted['errors'][0]}). Se reintentará la inserción en el próximo intento."
        )
    elif result and result.is_complete:
        payload["message"] = (
            f"✅ Orden completada: {result.total_received_quantity}/{result.requested_quantity} códigos "
            f"(+{result.received_quantity} en este intento, {inserted['inserted']} insertado(s) en inventario)."
        )
    elif result and result.received_quantity > 0:
        payload["message"] = (
            f"Recuperación parcial: +{result.received_quantity} código(s). "
            f"Recibidos {result.total_received_quantity}/{result.requested_quantity} — "
            f"faltan {result.remaining_quantity}, la orden sigue pendiente."
        )
    elif error_msg:
        payload["message"] = f"Error al reintentar: {error_msg}"
    else:
        rem = f" (faltan {result.remaining_quantity})" if result and result.requested_quantity else ""
        payload["message"] = f"Aún no hay códigos nuevos — sigue pendiente en el proveedor{rem}."
    return payload


async def retry_recovery_now(log_entry: dict) -> dict:
    """Compatibilidad: POST /api/recovery/{id}/retry → recuperación manual."""
    return await recover_tracked_order(log_entry, manual=True, quick=False)


async def resume_pending_orders(quick: bool = True, concurrency: int = 5, timeout_seconds: float = 150.0) -> list[dict]:
    """
    Paso automático de cada ciclo de reposición: reintenta TODAS las órdenes
    PENDING, sin importar el umbral de stock del producto (una entrega
    parcial puede haber subido el stock y antes la orden quedaba olvidada).

    - Órdenes con puntero de proveedor: solo consulta (ya están pagadas).
    - TISI/Coda (por unidad): compra solo lo faltante, y solo si el producto
      sigue activo y con reposición automática habilitada.
    """
    try:
        rows = _tracker.list_pending()
    except Exception as e:
        logger.warning("[ResumePending] no se pudieron leer órdenes pendientes: %s", e)
        return []
    if not rows:
        return []

    # Productos con reposición automática habilitada (para las de compra por unidad)
    unit_product_ids = {r["product_id"] for r in rows if r.get("provider") in UNIT_BASED_PROVIDERS and r.get("product_id")}
    auto_ok: set = set()
    if unit_product_ids:
        try:
            res = supabase.table("products").select("id") \
                .in_("id", list(unit_product_ids)).eq("is_active", True).eq("inv_auto_replenish", True).execute()
            auto_ok = {p["id"] for p in res.data or []}
        except Exception:
            pass

    sem = asyncio.Semaphore(concurrency)

    async def _one(row: dict) -> dict:
        if row.get("provider") in UNIT_BASED_PROVIDERS and row.get("product_id") not in auto_ok:
            return {"order_ref": row.get("order_ref"), "skipped": "reposición automática deshabilitada"}
        async with sem:
            try:
                if row.get("provider") in UNIT_BASED_PROVIDERS:
                    # Sin timeout: cortar a mitad podría perder PINs ya pagados.
                    return await recover_tracked_order(row, manual=False, quick=quick)
                return await asyncio.wait_for(
                    recover_tracked_order(row, manual=False, quick=quick), timeout=timeout_seconds,
                )
            except asyncio.TimeoutError:
                return {"order_ref": row.get("order_ref"), "provider": row.get("provider"),
                        "success": False, "message": "timeout consultando al proveedor"}
            except Exception as e:
                return {"order_ref": row.get("order_ref"), "provider": row.get("provider"),
                        "success": False, "message": str(e)}

    logger.info("[ResumePending] Reintentando %d orden(es) pendiente(s)", len(rows))
    return list(await asyncio.gather(*[_one(r) for r in rows]))


def release_stalled_orders(product_ids: Optional[set] = None,
                           older_than_minutes: Optional[int] = None) -> set:
    """
    Se llama DENTRO de la reposición automática, justo DESPUÉS de reintentar
    las órdenes pendientes (no hay tarea extra de Celery):

      ciclo N   → se compra; el proveedor cobra pero aún no entrega códigos
      ciclo N+1 → se reintenta traer los códigos (resume_pending_orders /
                  sync_awaiting_jobs); si SIGUEN sin llegar y la orden tiene
                  >= 15 min, se marca "demorada" → deja de bloquear y en este
                  mismo ciclo se compra al SIGUIENTE proveedor.

    La orden demorada sigue PENDING y se sigue recuperando en cada ciclo; si
    sus códigos llegan después, entran al inventario igual.
    Devuelve los product_id liberados.
    """
    from app.services.provider_order_tracking import STALLED_ORDER_FALLBACK_MINUTES
    rows = _tracker.list_stalled(older_than_minutes or STALLED_ORDER_FALLBACK_MINUTES)
    released: set = set()
    for row in rows:
        pid = row.get("product_id")
        if not pid or row.get("provider") in UNIT_BASED_PROVIDERS:
            continue   # TISI/Coda ya compran solo lo faltante
        if product_ids is not None and pid not in product_ids:
            continue
        reason = (f"sin códigos tras reintentar ({row.get('received_quantity') or 0}/"
                  f"{row.get('requested_quantity') or '?'}): se compra al siguiente proveedor")
        if _tracker.mark_fallback_released(row, reason):
            released.add(pid)
            logger.warning("[StalledFallback] %s/%s producto %s: %s",
                           row.get("provider"), row.get("order_ref"), pid, reason)
    return released


# ── Singleton ─────────────────────────────────────────────────────────────────

_service_instance: Optional[AutoPurchaseService] = None


def get_auto_purchase_service() -> AutoPurchaseService:
    global _service_instance
    if _service_instance is None:
        _service_instance = AutoPurchaseService()
    return _service_instance