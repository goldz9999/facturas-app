# UBICACIÓN EN TU REPO: fastapi-gift-cards/app/routes/catalog.py
# (repositorio: fastapi-gift-cards · ruta: app/routes/catalog.py)
"""
Rutas /api/catalog para el frontend (Catálogo, mapeos Eneba <-> proveedores).

Incluye también las rutas de búsqueda en catálogo Eneba y creación de auctions:
  GET  /api/catalog/eneba/environment       → entorno actual (sandbox/prod)
  GET  /api/catalog/eneba/search            → buscar productos en Eneba
  GET  /api/catalog/eneba/product/{id}      → detalle de un producto
  GET  /api/catalog/eneba/price-insights    → precios de mercado
  GET  /api/catalog/eneba/calculate-price   → comisión exacta Eneba (S_calculatePrice)
  POST /api/catalog/eneba/create-auction    → crear auction + guardar mapping
  GET  /api/catalog/eneba/my-auctions       → listar auctions del merchant
"""
import asyncio
import re
import os
import time
import httpx
import logging
from app.routes.auth import require_auth

from fastapi import APIRouter, Query, HTTPException, BackgroundTasks, Depends
from typing import Optional, List, Any
from pydantic import BaseModel

from app.core.database import supabase
from app.core.config import settings
from app.providers import BambooClient, EZClient, CardOneClient
from app.providers.cardone_client import get_cardone_client
router = APIRouter(dependencies=[Depends(require_auth)])
logger = logging.getLogger(__name__)

# ══════════════════════════════════════════════════════════════════════════════
# SECCIÓN 1 – ENEBA CATALOG (búsqueda + creación de auctions)
# ══════════════════════════════════════════════════════════════════════════════

# IDs de providers en Supabase (tabla providers)
_provider_ids_cache: dict = {}

async def _get_provider_id(code: str) -> int | None:
    """Obtiene el ID del proveedor desde Supabase, con cache en memoria."""
    if code in _provider_ids_cache:
        return _provider_ids_cache[code]
    try:
        r = supabase.table("providers").select("id").eq("code", code).limit(1).execute()
        if r.data:
            _provider_ids_cache[code] = r.data[0]["id"]
            return _provider_ids_cache[code]
    except Exception as e:
        logger.warning("_get_provider_id error code=%s: %s", code, e)
    return None

# Cache de token en memoria
_token_cache: dict = {"token": None, "expires_at": 0.0}

# ─── Cache tipo de cambio USD → EUR ───────────────────────────────────────────
_fx_cache: dict = {"rate": None, "fetched_at": 0.0}
_FX_CACHE_TTL = 6 * 3600
_fx_all_rates_cache: dict = {"rates": None, "fetched_at": 0.0}


async def _get_all_usd_rates() -> dict:
    now = time.time()
    if _fx_all_rates_cache["rates"] and (now - _fx_all_rates_cache["fetched_at"]) < _FX_CACHE_TTL:
        return _fx_all_rates_cache["rates"]
    api_key = os.getenv("EXCHANGE_RATE_API_KEY", "")
    if not api_key:
        logger.warning("EXCHANGE_RATE_API_KEY no configurada")
        return {}
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"https://v6.exchangerate-api.com/v6/{api_key}/latest/USD")
        data = resp.json()
        if data.get("result") != "success" or not data.get("conversion_rates"):
            logger.error("exchangerate-api respondió error: %s — se usa la última tasa guardada",
                         data.get("error-type") or data)
            return _fx_all_rates_cache["rates"] or {}
        rates = data["conversion_rates"]
        _fx_all_rates_cache["rates"] = rates
        _fx_all_rates_cache["fetched_at"] = now
        if "EUR" in rates:
            _fx_cache["rate"] = rates["EUR"]
            _fx_cache["fetched_at"] = now
        logger.info("Tasas multi-moneda actualizadas (%d monedas)", len(rates))
        return rates
    except Exception as e:
        logger.warning("Error obteniendo tasas: %s", e)
        return _fx_all_rates_cache["rates"] or {}


def _get_eneba_config() -> dict:
    env = settings.ENEBA_ENV.lower()
    is_sandbox = env == "sandbox"
    return {
        "graphql_url": settings.ENEBA_SANDBOX_GQL       if is_sandbox else settings.ENEBA_PROD_GQL,
        "token_url":   settings.ENEBA_SANDBOX_TOKEN_URL if is_sandbox else settings.ENEBA_PROD_TOKEN_URL,
        "client_id":   settings.ENEBA_SANDBOX_CLIENT_ID if is_sandbox else settings.ENEBA_PROD_CLIENT_ID,
        "auth_id":     settings.ENEBA_AUTH_ID,
        "auth_secret": settings.ENEBA_AUTH_SECRET,
        "is_sandbox":  is_sandbox,
    }


async def _get_eneba_token() -> str:
    config = _get_eneba_config()
    if _token_cache["token"] and time.time() < _token_cache["expires_at"] - 60:
        return _token_cache["token"]
    if not config["auth_id"] or not config["auth_secret"]:
        raise HTTPException(500, "Variables ENEBA_AUTH_ID / ENEBA_AUTH_SECRET no configuradas")
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(
            config["token_url"],
            data={
                "grant_type": "api_consumer",
                "client_id":  config["client_id"],
                "id":         config["auth_id"],
                "secret":     config["auth_secret"],
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if resp.status_code != 200:
        raise HTTPException(502, f"Error autenticando con Eneba: {resp.text}")
    data = resp.json()
    _token_cache["token"]      = data["access_token"]
    _token_cache["expires_at"] = time.time() + data.get("expires_in", 3600)
    return _token_cache["token"]


async def _eneba_graphql(query: str, variables: dict | None = None) -> dict:
    config = _get_eneba_config()
    token  = await _get_eneba_token()
    async with httpx.AsyncClient(timeout=25) as client:
        resp = await client.post(
            config["graphql_url"],
            json={"query": query, "variables": variables or {}},
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        )
    if resp.status_code != 200:
        raise HTTPException(502, f"Error en Eneba GraphQL (HTTP {resp.status_code})")
    result = resp.json()
    if "errors" in result:
        # Extraer mensaje limpio del primer error para mejor detección
        errors = result["errors"]
        first_msg = ""
        if isinstance(errors, list) and errors:
            first_msg = (
                errors[0].get("message") or
                errors[0].get("extensions", {}).get("code") or
                ""
            )
        raise HTTPException(422, f"GraphQL error: {first_msg or errors}")
    return result["data"]


# ─── Modelos Pydantic ─────────────────────────────────────────────────────────

class ProviderMapping(BaseModel):
    provider_code:  str
    provider_sku:   str
    cost_price_eur: float
    cost_price_original: float = 0.0   # precio en moneda original del proveedor
    cost_currency:       str   = "USD"  # moneda original (USD, EUR, etc.)

class CreateAuctionRequest(BaseModel):
    master_product_id: Optional[int] = None
    product_id:     str
    selling_price:  int
    i_want_to_get:  int
    price_currency: str   = "EUR"
    declared_stock: int   = 50
    enabled:        bool  = True
    auto_renew:     bool  = False
    providers:      list[ProviderMapping] = []
    provider_code:  str   = ""
    provider_sku:   str   = ""
    cost_price_eur: float = 0.0


# ══════════════════════════════════════════════════════════════════════════════
# HELPERS DE BASE DE DATOS (nivel módulo — fuera de endpoints)
# ══════════════════════════════════════════════════════════════════════════════

async def _save_auction_to_new_tables(
    master_product_id: Optional[int],
    product_name:      str,
    product_id_eneba:  str,
    auction_id:        str,
    selling_price_eur: float,
    i_want_to_get_eur: float,
    declared_stock:    int,
    final_currency:    str,
    is_sandbox:        bool,
    providers_list:    list,
    product_metadata:  dict,
) -> int:
    """
    Guarda el auction en tablas nuevas (products, channel_listings, product_suppliers).
    Retorna el product_id de la tabla products.
    """
    # 1. Upsert en products (tabla maestra)
    if master_product_id:
        existing = supabase.table("products").select("id").eq("id", master_product_id).execute()
        if not existing.data:
            raise Exception(f"Producto maestro {master_product_id} no encontrado")
        new_product_id = master_product_id
    else:
        products_result = supabase.table("products").upsert(
            {
                "sku":      product_id_eneba,
                "name":     product_name,
                "brand":    product_metadata.get("drm"),
                "category": product_metadata.get("type"),
                "region":   ", ".join(product_metadata.get("regions", [])) or None,
                "currency": final_currency[:3],
                "is_active": True,
            },
            on_conflict="sku",
        ).execute()

        if not products_result.data:
            raise Exception("No se pudo crear/actualizar en tabla products")

        new_product_id = products_result.data[0]["id"]

    # 2. Upsert en channel_listings (canal eneba)
    supabase.table("channel_listings").upsert(
        {
            "product_id":           new_product_id,
            "channel":              "eneba",
            "external_id":          product_id_eneba,
            "external_name":        product_name,
            "external_auction_id":  auction_id,
            "sell_price":           selling_price_eur,
            "declared_stock":       declared_stock,
            "stock_actual":         declared_stock,
            "is_active":            True,
            "metadata": {
                "selling_price_eur": selling_price_eur,
                "environment":       "sandbox" if is_sandbox else "production",
            },
        },
        on_conflict="channel,external_id",
    ).execute()

    # 3. Upsert en product_suppliers
    for idx, prov in enumerate(providers_list):
        pid = await _get_provider_id(prov.provider_code)
        if not pid:
            logger.warning("Provider '%s' no encontrado en Supabase, saltando", prov.provider_code)
            continue

        profit_eur = round(i_want_to_get_eur - prov.cost_price_eur, 4)
        margin_pct = round(profit_eur / i_want_to_get_eur * 100, 2) if i_want_to_get_eur else 0

        supabase.table("product_suppliers").upsert(
            {
                "product_id":   new_product_id,
                "provider_id":  pid,
                "provider_sku": prov.provider_sku,
                "cost_price":    prov.cost_price_original if prov.cost_price_original > 0 else prov.cost_price_eur,
                "cost_currency": prov.cost_currency if prov.cost_price_original > 0 else "EUR",
                "priority":     idx + 1,
                "mode":         "ON_DEMAND",
                "is_active":    True,
                "is_available": True,
                "metadata":     {"margin_pct": margin_pct},
            },
            on_conflict="product_id,provider_id",
        ).execute()

    return new_product_id


async def _sync_stock_to_eneba(auction_id: str, declared_stock: int) -> None:
    mutation = """
    mutation UpdateStock($auctionId: S_Uuid!, $stock: Int!) {
      S_updateAuction(input: { id: $auctionId, enabled: true, declaredStock: $stock }) { success actionId }
    }
    """
    for attempt in range(4):
        try:
            data   = await _eneba_graphql(mutation, {"auctionId": auction_id, "stock": declared_stock})
            result = data.get("S_updateAuction") or {}
            if result.get("success"):
                logger.info("✅ Stock sync — auction=%s stock=%d", auction_id, declared_stock)
            else:
                logger.warning("⚠️ sync stock falló — auction=%s", auction_id)
            return
        except Exception as e:
            match = re.search(r"Retry after (\d+) seconds", str(e))
            if match and attempt < 3:
                await asyncio.sleep(int(match.group(1)) + 2)
            else:
                logger.error("_sync_stock_to_eneba error: %s", e)
                return


async def _sync_price_to_eneba(auction_id: str, sale_price_eur: float) -> None:
    try:
        if not auction_id:
            return

        amount_cents = round(sale_price_eur * 100)
        mutation = """
        mutation SyncPrice($items: [P_API_AuctionPriceInput!]!) {
          P_updateAuctionPrice(input: { items: $items }) {
            items { auctionId success paidForPriceChange error }
          }
        }
        """
        data  = await _eneba_graphql(mutation, {"items": [{"auctionId": auction_id, "price": {"amount": amount_cents, "currency": "EUR"}, "preventPaidPriceChange": False}]})
        items = (data.get("P_updateAuctionPrice") or {}).get("items", [])
        if items and items[0].get("success"):
            logger.info("✅ Precio sync — auction=%s €%.4f", auction_id, sale_price_eur)
        else:
            logger.warning("⚠️ price sync falló — auction=%s", auction_id)
    except Exception as e:
        logger.error("_sync_price_to_eneba error: %s", e)


async def _toggle_auctions_in_eneba(auction_ids: list[str], enabled: bool) -> list[dict]:
    """
    Activa o desactiva una o varias auctions en Eneba en una sola llamada,
    usando P_updateAuctionPrice(enabled). P_updateAuctionPrice acepta hasta
    200 items por mutation (no tiene el límite de 45s/auction — eso aplica
    solo a S_updateAuction, que está deprecada). No toca declaredStock.

    Devuelve la lista `items` tal como la responde Eneba:
    [{"auctionId": ..., "success": bool, "error": str|None}, ...]
    para poder reportar éxitos/errores parciales cuando hay varios canales.
    """
    if not auction_ids:
        return []

    mutation = """
    mutation ToggleAuctions($items: [P_API_AuctionPriceInput!]!) {
      P_updateAuctionPrice(input: { items: $items }) {
        items { auctionId success error }
      }
    }
    """
    items_input = [{"auctionId": aid, "enabled": enabled} for aid in auction_ids]

    for attempt in range(4):
        try:
            data  = await _eneba_graphql(mutation, {"items": items_input})
            items = (data.get("P_updateAuctionPrice") or {}).get("items") or []
            for r in items:
                if r.get("success"):
                    logger.info("✅ Auction toggle OK — auction=%s enabled=%s", r.get("auctionId"), enabled)
                else:
                    logger.warning("⚠️ Auction toggle fallo — auction=%s enabled=%s error=%s", r.get("auctionId"), enabled, r.get("error"))
            return items
        except Exception as e:
            match = re.search(r"Retry after (\d+) seconds", str(e))
            if match and attempt < 3:
                await asyncio.sleep(int(match.group(1)) + 2)
            else:
                logger.error("_toggle_auctions_in_eneba error: %s", e)
                # Ninguna se pudo confirmar: se reportan todas como fallidas
                # para que el caller no asuma éxito.
                return [{"auctionId": aid, "success": False, "error": str(e)} for aid in auction_ids]
    return [{"auctionId": aid, "success": False, "error": "sin respuesta"} for aid in auction_ids]


async def _toggle_auction_in_eneba(auction_id: str, enabled: bool) -> None:
    """Wrapper de compatibilidad para el switch manual de un solo canal
    (usado por update_channel/delete_mapping vía background_tasks, que no
    usan el valor de retorno)."""
    await _toggle_auctions_in_eneba([auction_id], enabled)


# ══════════════════════════════════════════════════════════════════════════════
# ENDPOINTS ENEBA
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/eneba/environment")
async def get_eneba_environment():
    config = _get_eneba_config()
    return {
        "environment":     "sandbox" if config["is_sandbox"] else "production",
        "graphql_url":     config["graphql_url"],
        "auth_id_set":     bool(config["auth_id"]),
        "auth_secret_set": bool(config["auth_secret"]),
    }


@router.get("/fx/usd-eur")
async def get_usd_eur_rate():
    rates  = await _get_all_usd_rates()
    rate   = rates.get("EUR") if rates else (_fx_cache.get("rate") or 1.08)
    cached = bool(_fx_all_rates_cache["rates"]) and (time.time() - _fx_all_rates_cache["fetched_at"]) < _FX_CACHE_TTL
    return {"usd_to_eur": rate, "eur_to_usd": round(1 / rate, 6), "cached": cached, "fetched_at": _fx_all_rates_cache["fetched_at"] or None}


@router.get("/fx/to-eur")
async def get_rate_to_eur(from_currency: str = Query(..., alias="from")):
    from_currency = from_currency.upper().strip()
    if from_currency == "EUR":
        return {"from": "EUR", "to": "EUR", "rate": 1.0, "cached": True}
    rates = await _get_all_usd_rates()
    if not rates:
        raise HTTPException(503, "No se pudo obtener tasas. Configura EXCHANGE_RATE_API_KEY.")
    usd_to_from = rates.get(from_currency)
    usd_to_eur  = rates.get("EUR")
    if not usd_to_from:
        raise HTTPException(400, f"Moneda no soportada: {from_currency}")
    rate_to_eur = round(usd_to_eur / usd_to_from, 8)
    cached = bool(_fx_all_rates_cache["rates"]) and (time.time() - _fx_all_rates_cache["fetched_at"]) < _FX_CACHE_TTL
    return {"from": from_currency, "to": "EUR", "rate": rate_to_eur, "cached": cached, "example": f"1 {from_currency} = {rate_to_eur:.6f} EUR"}


@router.get("/eneba/price-insights")
async def get_price_insights(product_id: str = Query(...), currency: str = Query("EUR")):
    config = _get_eneba_config()
    optional_field = "" if config["is_sandbox"] else "isOptimal"
    insights_gql = f"""
    query PriceInsights($productIds: [I_Uuid!]!, $currency: String!) {{
      I_productPriceInsights(productIds: $productIds, currency: $currency) {{
        productId
        suggestedPrice      {{ amount currency }}
        suggestedPriceEur   {{ amount currency }}
        syncPrice           {{ amount currency }}
        suggestedPriceDifference          {{ amount currency }}
        suggestedPriceDifferencePercentage
        predictedConversionsChangeFraction
        {optional_field}
      }}
    }}
    """
    insights_data = competition_data = insights_error = competition_error = None
    try:
        raw   = await _eneba_graphql(insights_gql, {"productIds": [product_id], "currency": currency})
        items = raw.get("I_productPriceInsights") or []
        if items:
            insights_data = items[0]
    except Exception as e:
        insights_error = str(e)

    if not config["is_sandbox"]:
        try:
            raw_comp  = await _eneba_graphql("""
            query GetCompetition($productId: S_Uuid!) {
              S_competition(productIds: [$productId]) {
                productId
                competition(first: 50) { edges { node { price { amount currency } isInStock belongsToYou } } }
              }
            }
            """, {"productId": product_id})
            comp_list = raw_comp.get("S_competition") or []
            edges     = (comp_list[0].get("competition") or {}).get("edges") or [] if comp_list else []
            prices    = [e["node"]["price"]["amount"] for e in edges if e["node"].get("isInStock") and e["node"].get("price")]
            if prices:
                competition_data = {"lowest_price": {"amount": min(prices), "currency": currency}, "highest_price": {"amount": max(prices), "currency": currency}, "offers_count": len(prices)}
        except Exception as e:
            competition_error = str(e)

    return {"product_id": product_id, "currency": currency, "insights": insights_data, "competition": competition_data, "insights_error": insights_error, "competition_error": competition_error}


@router.get("/eneba/calculate-price")
async def calculate_price(product_id: str = Query(...), selling_price: int = Query(...)):
    gql = """
    query CalculatePrice($price: S_MoneyInput!, $productId: S_Uuid!) {
      S_calculatePrice(input: { price: $price, productId: $productId }) {
        priceWithCommission    { amount currency }
        priceWithoutCommission { amount currency }
        commission { label rate { amount currency } }
      }
    }
    """
    try:
        data          = await _eneba_graphql(gql, {"price": {"amount": selling_price, "currency": "EUR"}, "productId": product_id})
        result        = data.get("S_calculatePrice", {})
        price_without = result.get("priceWithoutCommission", {})
        commission    = result.get("commission", {})
        receive_amt   = price_without.get("amount", 0)
        return {
            "selling_price":    selling_price,
            "i_want_to_get":    receive_amt,
            "commission":       selling_price - receive_amt,
            "commission_label": commission.get("label", ""),
            "currency":         price_without.get("currency", "EUR"),
        }
    except Exception as e:
        commission_est = round(selling_price * 0.05)
        return {"selling_price": selling_price, "i_want_to_get": selling_price - commission_est, "commission": commission_est, "commission_label": "Estimado ~5%", "currency": "EUR"}


@router.get("/eneba/search")
async def search_eneba_catalog(q: str = Query(...), limit: int = Query(20, ge=1, le=100), only_unmapped: Optional[bool] = Query(False), cursor: Optional[str] = Query(None)):
    gql = """
    query SearchProducts($search: String!, $first: Int!, $after: String, $onlyUnmapped: Boolean) {
      S_products(search: $search, first: $first, after: $after, onlyUnmapped: $onlyUnmapped, sort: CREATED_AT_DESC) {
        edges { cursor node { id name slug releasedAt createdAt languages type { value } drm { slug } regions { code } } }
        pageInfo { hasNextPage endCursor }
      }
    }
    """
    data     = await _eneba_graphql(gql, {"search": q, "first": limit, "after": cursor, "onlyUnmapped": only_unmapped})
    products = [{"id": e["node"]["id"], "name": e["node"]["name"], "slug": e["node"].get("slug"), "is_sellable": True, "released_at": e["node"].get("releasedAt"), "languages": e["node"].get("languages", []), "type": e["node"]["type"]["value"] if e["node"].get("type") else None, "drm": e["node"]["drm"]["slug"] if e["node"].get("drm") else None, "regions": [r["code"] for r in e["node"].get("regions", [])], "cursor": e["cursor"]} for e in data["S_products"]["edges"]]
    pi       = data["S_products"]["pageInfo"]
    return {"products": products, "has_next": pi["hasNextPage"], "end_cursor": pi.get("endCursor"), "count": len(products)}


@router.get("/eneba/product/{product_id}")
async def get_eneba_product(product_id: str):
    gql  = """
    query GetProduct($productId: S_Uuid!) {
      S_product(productId: $productId) { id name slug releasedAt createdAt languages type { value } drm { slug } regions { code } }
    }
    """
    data = await _eneba_graphql(gql, {"productId": product_id})
    node = data.get("S_product")
    if not node:
        raise HTTPException(404, f"Producto {product_id} no encontrado en Eneba")
    return {"id": node["id"], "name": node["name"], "slug": node.get("slug"), "is_sellable": True, "released_at": node.get("releasedAt"), "languages": node.get("languages", []), "type": node["type"]["value"] if node.get("type") else None, "drm": node["drm"]["slug"] if node.get("drm") else None, "regions": [r["code"] for r in node.get("regions", [])]}


@router.post("/eneba/create-auction")
async def create_eneba_auction(req: CreateAuctionRequest):
    # Se permite crear el auction sin proveedor: las órdenes se cubren con
    # inventory_codes (subida manual) y el proveedor solo actúa como
    # respaldo de compra automática cuando el stock manual se agota.

    # 1) Verificar producto
    check_data = await _eneba_graphql("""
    query CheckProduct($productId: S_Uuid!) {
      S_product(productId: $productId) { id name drm { slug } regions { code } type { value } }
    }
    """, {"productId": req.product_id})
    product = check_data.get("S_product")
    if not product:
        raise HTTPException(404, f"Producto {req.product_id} no encontrado en Eneba")

    # 2) Crear o actualizar auction
    is_sandbox      = _get_eneba_config()["is_sandbox"]
    auction_id      = None
    auction_updated = False

    create_gql = """
    mutation CreateAuction($productId: S_Uuid!, $amount: Int!, $currency: String!, $declaredStock: Int!, $enabled: Boolean!, $autoRenew: Boolean!) {
      S_createAuction(input: { productId: $productId, enabled: $enabled, declaredStock: $declaredStock, autoRenew: $autoRenew, price: { amount: $amount, currency: $currency } }) { success actionId auctionId price { amount currency } }
    }
    """

    try:
        mutation_data = await _eneba_graphql(create_gql, {"productId": req.product_id, "amount": req.selling_price, "currency": req.price_currency, "declaredStock": req.declared_stock, "enabled": req.enabled, "autoRenew": req.auto_renew})
        ar = mutation_data["S_createAuction"]
        if not ar["success"]:
            raise HTTPException(500, "Eneba no confirmó éxito")
        auction_id = ar["auctionId"]
    except HTTPException as e:
        detail_str = str(e.detail).lower()
        if "already have auction" in detail_str or "auction.already_own" in detail_str:
            # Buscar auction existente en channel_listings (tablas nuevas)
            existing = supabase.table("channel_listings") \
                .select("external_auction_id") \
                .eq("external_id", req.product_id) \
                .eq("channel", "eneba") \
                .limit(1).execute()
            existing_row = existing.data[0] if existing.data else None
            if existing_row and existing_row.get("external_auction_id"):
                auction_id = existing_row["external_auction_id"]
            else:
                # Fallback: buscar directamente en Eneba via S_stock
                stock_data = await _eneba_graphql(
                    "query FindAuction($productId: S_Uuid!) { S_stock(first: 1, productId: $productId) { edges { node { id } } } }",
                    {"productId": req.product_id}
                )
                edges = (stock_data.get("S_stock") or {}).get("edges") or []
                if edges:
                    auction_id = edges[0]["node"]["id"]
                else:
                    raise HTTPException(404, "No se encontró el auction existente")
            update_data = await _eneba_graphql(
                "mutation UpdateAuction($auctionId: S_Uuid!, $amount: Int!, $currency: String!, $declaredStock: Int!) { S_updateAuction(input: { id: $auctionId, enabled: true, price: { amount: $amount, currency: $currency }, declaredStock: $declaredStock }) { success actionId } }",
                {"auctionId": auction_id, "amount": req.selling_price, "currency": req.price_currency, "declaredStock": req.declared_stock}
            )
            if not update_data["S_updateAuction"]["success"]:
                raise HTTPException(500, "No se pudo actualizar el auction existente")
            auction_updated = True
        else:
            raise

    # Precios
    selling_price_eur = req.selling_price / 100.0
    i_want_to_get_eur = req.i_want_to_get / 100.0
    final_currency    = req.price_currency
    profit_eur = round(i_want_to_get_eur - req.cost_price_eur, 4)
    margin_pct = round(profit_eur / i_want_to_get_eur * 100, 2) if i_want_to_get_eur else 0

    # 3) Guardar en DB
    saved_to_db    = False
    db_error       = None
    new_product_id = None

    try:
        providers_list = req.providers if req.providers else []
        if not providers_list and req.provider_code:
            providers_list = [ProviderMapping(provider_code=req.provider_code, provider_sku=req.provider_sku, cost_price_eur=req.cost_price_eur)]
        providers_list = sorted(providers_list, key=lambda p: p.cost_price_eur)

        product_metadata = {
            "drm":     product.get("drm", {}).get("slug") if product.get("drm") else None,
            "type":    product.get("type", {}).get("value") if product.get("type") else None,
            "regions": [r["code"] for r in product.get("regions", [])],
        }

        new_product_id = await _save_auction_to_new_tables(
            master_product_id=req.master_product_id,
            product_name=product["name"],
            product_id_eneba=req.product_id,
            auction_id=auction_id,
            selling_price_eur=selling_price_eur,
            i_want_to_get_eur=i_want_to_get_eur,
            declared_stock=req.declared_stock,
            final_currency=final_currency,
            is_sandbox=is_sandbox,
            providers_list=providers_list,
            product_metadata=product_metadata,
        )
        saved_to_db = True
        logger.info("✅ Guardado — product_id=%s auction=%s", new_product_id, auction_id)

        # ✅ Activar auction con delay — S_createAuction es asíncrono,
        # hay que esperar a que Eneba lo procese antes de envivar enabled+declaredStock
        async def _activate_after_delay(aid: str, stock: int):
            await asyncio.sleep(5)  # esperar 5s a que Eneba procese la creación
            try:
                activate_mutation = """
                mutation ActivateAuction($auctionId: S_Uuid!, $stock: Int!) {
                  S_updateAuction(input: {
                    id: $auctionId
                    enabled: true
                    declaredStock: $stock
                  }) { success actionId }
                }
                """
                data = await _eneba_graphql(activate_mutation, {
                    "auctionId": aid,
                    "stock": stock,
                })
                result = data.get("S_updateAuction") or {}
                if result.get("success"):
                    logger.info("✅ Auction activado — auction=%s stock=%d", aid, stock)
                else:
                    logger.warning("⚠️ Activación falló — auction=%s resp=%s", aid, result)
            except Exception as ex:
                logger.error("_activate_after_delay error auction=%s: %s", aid, ex)

        asyncio.create_task(_activate_after_delay(auction_id, req.declared_stock))

    except Exception as e:
        db_error = str(e)
        logger.error("Error guardando en Supabase: %s", e)

    return {
        "success":        True,
        "auction_id":     auction_id,
        "auction_action": "updated" if auction_updated else "created",
        "product_id":     req.product_id,
        "product_name":   product["name"],
        "selling_price":  {"amount": req.selling_price, "currency": req.price_currency},
        "i_want_to_get":  {"amount": req.i_want_to_get, "currency": req.price_currency},
        "profit_eur":     profit_eur,
        "margin_pct":     margin_pct,
        "declared_stock": req.declared_stock,
        "environment":    "sandbox" if is_sandbox else "production",
        "saved_to_db":    saved_to_db,
        "new_product_id": new_product_id,
        "db_error":       db_error,
    }


@router.get("/eneba/my-auctions")
async def list_my_auctions(product_id: Optional[str] = Query(None), limit: int = Query(20, ge=1, le=100), cursor: Optional[str] = Query(None)):
    gql  = """
    query ListStock($first: Int!, $after: String, $productId: S_Uuid) {
      S_stock(first: $first, after: $after, productId: $productId) {
        edges { cursor node { id enabled declaredStock onHand price { amount currency } priceIWantToGet { amount currency } product { id name type { value } drm { slug } } } }
        pageInfo { hasNextPage endCursor }
      }
    }
    """
    data     = await _eneba_graphql(gql, {"first": limit, "after": cursor, "productId": product_id})
    auctions = [{"auction_id": e["node"]["id"], "enabled": e["node"]["enabled"], "declared_stock": e["node"].get("declaredStock"), "on_hand": e["node"].get("onHand"), "price": {"amount": e["node"]["price"]["amount"], "currency": e["node"]["price"]["currency"]} if e["node"].get("price") else None, "product": {"id": e["node"]["product"]["id"], "name": e["node"]["product"]["name"], "type": e["node"]["product"]["type"]["value"] if e["node"]["product"].get("type") else None, "drm": e["node"]["product"]["drm"]["slug"] if e["node"]["product"].get("drm") else None} if e["node"].get("product") else None, "cursor": e["cursor"]} for e in data["S_stock"]["edges"]]
    pi       = data["S_stock"]["pageInfo"]
    return {"auctions": auctions, "has_next": pi["hasNextPage"], "end_cursor": pi.get("endCursor"), "count": len(auctions)}


# ══════════════════════════════════════════════════════════════════════════════
# SECCIÓN 2 – PROVIDERS
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/providers")
async def get_catalog_providers():
    try:
        r = supabase.table("providers").select("id, name, code").execute()
        return [{"id": str(p["id"]), "name": p.get("name") or p.get("code", ""), "logo": "", "code": p.get("code", "")} for p in (r.data or [])]
    except Exception:
        return []


# ══════════════════════════════════════════════════════════════════════════════
# SECCIÓN 3 – MAPPINGS
# ══════════════════════════════════════════════════════════════════════════════

class MappingUpdate(BaseModel):
    autoFulfillment: Optional[bool]  = None
    salePrice:       Optional[float] = None
    declaredStock:   Optional[int]   = None

class ProviderMappingEdit(BaseModel):
    provider_code:  str
    provider_sku:   str
    cost_price_eur: float

class EditProvidersRequest(BaseModel):
    providers:      List[ProviderMappingEdit]
    sell_price_eur: float


@router.get("/mappings")
async def get_mappings():
    try:
        cl_result = supabase.table("channel_listings") \
            .select("id, product_id, external_id, external_auction_id, sell_price, declared_stock, stock_actual, is_active, product:products(id, sku, name, is_active)") \
            .eq("channel", "eneba").execute()
        listings = cl_result.data or []
        if not listings:
            return []

        product_ids = [l["product_id"] for l in listings]
        ps_result = supabase.table("product_suppliers") \
            .select("product_id, provider_id, provider_sku, cost_price, priority, is_active, is_available, provider:providers(id, name, code)") \
            .in_("product_id", product_ids).eq("is_active", True).order("priority", desc=False).execute()

        supplier_by_product: dict = {}
        for s in (ps_result.data or []):
            pid = s["product_id"]
            if pid not in supplier_by_product:
                supplier_by_product[pid] = s

        # Reservas activas (PENDING) por producto — el cliente puede tardar
        # hasta 3 días hábiles en pagar, así que esto es solo informativo.
        reservations_by_product: dict = {}
        try:
            res_result = supabase.table("eneba_order_sessions") \
                .select("product_id") \
                .eq("provide_status", "PENDING") \
                .in_("product_id", product_ids).execute()
            for r in (res_result.data or []):
                pid = r["product_id"]
                reservations_by_product[pid] = reservations_by_product.get(pid, 0) + 1
        except Exception as e:
            logger.warning("get_mappings: no se pudo contar reservas activas: %s", e)

        out = []
        for listing in listings:
            pid      = listing["product_id"]
            product  = listing.get("product") or {}
            supplier = supplier_by_product.get(pid)
            if not supplier:
                continue
            sell       = float(listing.get("sell_price") or 0)
            cost       = float(supplier.get("cost_price") or 0)
            i_want     = round(sell * 0.96, 4)
            profit     = round(i_want - cost, 4)
            margin_pct = round(profit / i_want * 100, 1) if i_want > 0 else 0
            out.append({
                "id":                     str(listing["id"]),
                "marketplaceProductId":   listing.get("external_id") or product.get("sku") or "",
                "marketplaceProductName": product.get("name") or "",
                "marketplacePlatform":    "Eneba",
                "supplierId":             str(supplier["provider_id"]),
                "supplierName":           (supplier.get("provider") or {}).get("name") or "",
                "supplierSku":            supplier["provider_sku"],
                "cost":                   cost,
                "salePrice":              sell,
                "marginPct":              margin_pct,
                "autoFulfillment":        listing.get("is_active", True),
                "declaredStock":          int(listing.get("declared_stock") or 0),
                "activeReservations":     reservations_by_product.get(pid, 0),
                "_auction_id":            listing.get("external_auction_id"),
            })
        return out
    except Exception as e:
        logger.error("get_mappings error: %s", e)
        return []


@router.patch("/mappings/{id}")
async def update_mapping(id: str, body: MappingUpdate, background_tasks: BackgroundTasks):
    try:
        channel_id = int(id)
        cl_res = supabase.table("channel_listings").select("id, product_id, external_auction_id, sell_price, declared_stock").eq("id", channel_id).eq("channel", "eneba").single().execute()
        if not cl_res.data:
            raise HTTPException(404, "Producto/listing no encontrado")
        product_id = cl_res.data["product_id"]
        auction_id = cl_res.data.get("external_auction_id")

        cl_update: dict = {}
        if body.autoFulfillment is not None:
            cl_update["is_active"] = body.autoFulfillment
        if body.salePrice is not None:
            if body.salePrice <= 0:
                raise HTTPException(400, "El precio debe ser mayor a 0")
            cl_update["sell_price"] = body.salePrice
        if body.declaredStock is not None:
            cl_update["declared_stock"] = body.declaredStock
            cl_update["stock_actual"]   = body.declaredStock

        if cl_update:
            supabase.table("channel_listings").update(cl_update).eq("id", channel_id).execute()
        if body.autoFulfillment is not None:
            supabase.table("product_suppliers").update({"is_active": body.autoFulfillment}).eq("product_id", product_id).execute()
        if body.salePrice is not None and auction_id:
            background_tasks.add_task(_sync_price_to_eneba, auction_id=auction_id, sale_price_eur=body.salePrice)
        if body.declaredStock is not None and auction_id:
            background_tasks.add_task(_sync_stock_to_eneba, auction_id=auction_id, declared_stock=body.declaredStock)
        return {"ok": True}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("update_mapping error id=%s: %s", id, e)
        raise HTTPException(400, detail=str(e))


@router.delete("/mappings/{id}")
async def delete_mapping(id: str, background_tasks: BackgroundTasks):
    try:
        channel_id = int(id)
        cl_res = supabase.table("channel_listings").select("product_id, is_active, external_auction_id, declared_stock").eq("id", channel_id).eq("channel", "eneba").single().execute()
        if not cl_res.data:
            raise HTTPException(404, "Listing no encontrado")
        product_id     = cl_res.data["product_id"]
        current_active = cl_res.data.get("is_active", True)
        auction_id     = cl_res.data.get("external_auction_id")
        new_active     = not current_active

        supabase.table("channel_listings").update({"is_active": new_active}).eq("id", channel_id).execute()
        supabase.table("product_suppliers").update({"is_active": new_active}).eq("product_id", product_id).execute()

        if auction_id:
            if not new_active:
                background_tasks.add_task(_toggle_auction_in_eneba, auction_id=auction_id, enabled=False)
            else:
                declared_stock = cl_res.data.get("declared_stock")
                if declared_stock:
                    background_tasks.add_task(_toggle_auction_in_eneba, auction_id=auction_id, enabled=True)
                    background_tasks.add_task(_sync_stock_to_eneba, auction_id=auction_id, declared_stock=int(declared_stock))
        return {"ok": True, "is_active": new_active}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("delete_mapping error id=%s: %s", id, e, exc_info=True)
        raise HTTPException(400, detail=str(e))


async def _load_ez(skus: list) -> dict:
    """Carga precios EZ para los SKUs indicados: {sku: (price, currency)}.
    El endpoint /v2/products acepta el parámetro sku como lista separada
    por comas (ej: sku=A,B,C), así que filtramos en vez de traer todo el
    catálogo. Se piden en lotes para no exceder límites de URL/query."""
    prices: dict = {}
    if not skus:
        return prices
    ez = EZClient()
    unique_skus = list({str(s) for s in skus if s})
    BATCH = 100
    for i in range(0, len(unique_skus), BATCH):
        batch = unique_skus[i:i + BATCH]
        try:
            data = await ez.get_products(limit=1000, page=1, sku=",".join(batch))
        except Exception as e:
            logger.error("_load_ez error batch=%s: %s", i, e)
            continue
        items = data.get("items", [])
        for p in items:
            sku = p.get("sku")
            if not sku:
                continue
            price_list = p.get("prices") or []
            amount = price_list[0].get("price") if price_list else None
            currency = p.get("currency", "USD")
            try:
                amount_float = float(amount) if amount is not None else None
            except (TypeError, ValueError):
                amount_float = None
            if amount_float is not None:
                prices[str(sku)] = (amount_float, currency)
    return prices


async def _load_bamboo(skus: list) -> dict:
    """Carga precios Bamboo para los SKUs indicados: {sku: (price, currency)}.
    Usa el catálogo v1 (una sola request) por ser el recomendado para
    price refresh cuando hay muchos SKUs."""
    prices: dict = {}
    if not skus:
        return prices
    wanted = {str(s) for s in skus}
    bamboo = BambooClient()
    try:
        brands = await bamboo.get_catalog_v1()
    except Exception as e:
        logger.error("_load_bamboo error: %s", e)
        return prices
    for brand in brands:
        products = brand.get("products", []) if isinstance(brand, dict) else []
        brand_currency = brand.get("currencyCode", "USD") if isinstance(brand, dict) else "USD"
        for p in products:
            sku = str(p.get("id", ""))
            if sku not in wanted:
                continue
            price_obj = p.get("price") or {}
            min_price = price_obj.get("min")
            currency  = price_obj.get("currencyCode") or brand_currency
            if min_price is None:
                continue
            try:
                prices[sku] = (float(min_price), currency)
            except (TypeError, ValueError):
                continue
    return prices


async def _load_cardone(skus: list) -> dict:
    """Carga precios 99Cards/Cardone: {sku: (price, currency)}.
    Usa /get_stock por productCode — una llamada por SKU, precio directo,
    en vez de paginar el catálogo completo (23k+ productos). Mismo patrón
    que auto_purchase_service._refresh_cardone_prices."""
    prices: dict = {}
    if not skus:
        return prices
    cardone = get_cardone_client()
    unique_skus = list({str(s) for s in skus if s})

    semaphore = asyncio.Semaphore(10)

    async def _fetch_one(sku: str) -> None:
        async with semaphore:
            try:
                result = await cardone.get_stock(product_code=sku)
                data = result.get("data") or {} if isinstance(result, dict) else {}
                price = data.get("price")
                if price is None:
                    return
                currency = data.get("currency") or "USD"
                prices[sku] = (float(price), currency)
            except Exception as e:
                logger.warning("_load_cardone error sku=%s: %s", sku, e)

    await asyncio.gather(*(_fetch_one(sku) for sku in unique_skus))
    return prices


async def _load_wgcards() -> dict:
    """Carga precios WgCards: {sku: (price, currency)}. get_all_products
    tiene rate limit de 1/hora y no trae precios, así que usamos get_products
    paginado. API v4: máx. 100 SKUs por página y 30 consultas/min."""
    from app.providers import wgcards_client as wg_client
    prices: dict = {}
    current = 1
    size = 100
    while True:
        try:
            data = await wg_client.get_products(current=current, size=size, currency_code="USD")
        except Exception as e:
            logger.error("_load_wgcards error current=%s: %s", current, e)
            break
        records = data.get("records", []) if isinstance(data, dict) else []
        if not records:
            break
        for item in records:
            for sku in item.get("skus", []):
                sku_id = str(sku.get("skuId", ""))
                if not sku_id:
                    continue
                price_raw = sku.get("skuPrice")
                try:
                    price = float(price_raw) if price_raw is not None else None
                except (TypeError, ValueError):
                    price = None
                if price is not None:
                    prices[sku_id] = (price, "USD")
        # v4: total/pages cuentan SKUs (records agrupa por producto), así que
        # se corta por número de páginas y no por len(records).
        pages = data.get("pages") or 0
        if not pages:
            total = data.get("total") or 0
            pages = -(-total // size) if total else current
        if current >= pages:
            break
        current += 1
        await asyncio.sleep(2.1)  # 30 req/min
    return prices


@router.post("/mappings/refresh-costs")
async def refresh_mapping_costs(update_eneba: bool = Query(True)):
    try:
        # ── Lee de product_suppliers + channel_listings (tablas nuevas) ──
        ps_r = supabase.table("product_suppliers") \
            .select("id, product_id, provider_id, provider_sku, cost_price") \
            .eq("is_active", True).execute()
        suppliers = ps_r.data or []
        if not suppliers:
            return {"ok": True, "updated": 0, "failed": 0, "skipped": 0, "total": 0}

        product_ids = list({s["product_id"] for s in suppliers})

        # Obtener auction_id y sell_price desde channel_listings
        cl_r = supabase.table("channel_listings") \
            .select("id, product_id, external_auction_id, sell_price") \
            .eq("channel", "eneba").eq("is_active", True) \
            .in_("product_id", product_ids).execute()
        cl_by_product: dict = {}
        for row in (cl_r.data or []):
            cl_by_product.setdefault(row["product_id"], []).append(row)

        provider_ids = list({s["provider_id"] for s in suppliers if s.get("provider_id")})
        prov_r = supabase.table("providers").select("id, code, name").in_("id", provider_ids).execute()
        id_to_code = {p["id"]: (p.get("code") or p.get("name", "")).lower() for p in (prov_r.data or [])}

        rates      = await _get_all_usd_rates()
        usd_to_eur = rates.get("EUR") or _fx_cache.get("rate") or 1.08

        def _to_eur(cost: float, currency: str) -> float:
            if currency == "EUR": return round(cost, 4)
            if currency == "USD": return round(cost * usd_to_eur, 4)
            rate_from_usd = rates.get(currency)
            return round(cost / rate_from_usd * usd_to_eur, 4) if rate_from_usd else round(cost * usd_to_eur, 4)

        bamboo_skus   = [s["provider_sku"] for s in suppliers if "bamboo" in id_to_code.get(s["provider_id"], "")]
        ez_skus       = [s["provider_sku"] for s in suppliers if "ez"     in id_to_code.get(s["provider_id"], "")]
        cardone_skus  = [s["provider_sku"] for s in suppliers
                         if ("99" in id_to_code.get(s["provider_id"], "") or "card" in id_to_code.get(s["provider_id"], ""))]
        ez_prices, bamboo_prices, cardone_prices, wgcards_prices = await asyncio.gather(
            _load_ez(ez_skus), _load_bamboo(bamboo_skus), _load_cardone(cardone_skus), _load_wgcards()
        )

        updated, failed, skipped = 0, 0, 0
        eneba_price_updates = []

        for s in suppliers:
            code = id_to_code.get(s["provider_id"], "")
            sku  = str(s.get("provider_sku", ""))
            if   "ez"      in code: entry = ez_prices.get(sku)
            elif "bamboo"  in code: entry = bamboo_prices.get(sku)
            elif "wgcard"  in code: entry = wgcards_prices.get(sku)
            elif "99" in code or "card" in code: entry = cardone_prices.get(sku)
            else: skipped += 1; continue
            if entry is None: failed += 1; continue

            raw_cost, currency = entry
            new_cost_eur = _to_eur(raw_cost, currency)
            old_cost_eur = float(s.get("cost_price") or 0)
            if abs(new_cost_eur - old_cost_eur) < 0.001: skipped += 1; continue

            try:
                # Actualizar cost en product_suppliers (una vez por proveedor)
                supabase.table("product_suppliers").update({"cost_price": new_cost_eur}) \
                    .eq("id", s["id"]).execute()
                updated += 1
            except Exception as e:
                logger.error("refresh_costs error supplier id=%s: %s", s["id"], e)
                failed += 1
                continue

            # Actualizar sell_price en CADA canal Eneba del producto, manteniendo margen
            for cl in cl_by_product.get(s["product_id"], []):
                old_sell = float(cl.get("sell_price") or 0)
                if old_sell > 0 and old_cost_eur > 0:
                    old_margin   = (old_sell - old_cost_eur) / old_sell
                    new_sell_eur = round(new_cost_eur / (1 - old_margin), 4) if old_margin < 1 else new_cost_eur
                else:
                    new_sell_eur = old_sell

                if new_sell_eur > 0 and abs(new_sell_eur - old_sell) >= 0.001:
                    try:
                        supabase.table("channel_listings").update({"sell_price": new_sell_eur}) \
                            .eq("id", cl["id"]).execute()
                    except Exception as e:
                        logger.error("refresh_costs error channel_listing id=%s: %s", cl["id"], e)
                        continue

                auction_id = cl.get("external_auction_id")
                if auction_id and new_sell_eur > 0:
                    eneba_price_updates.append({
                        "auctionId": auction_id,
                        "priceIWantToGet": {"amount": round(new_sell_eur * 100), "currency": "EUR"},
                        "preventPaidPriceChange": False,
                    })

        eneba_updated, eneba_failed = 0, 0
        if eneba_price_updates and update_eneba:
            CHUNK  = 200
            chunks = [eneba_price_updates[i:i+CHUNK] for i in range(0, len(eneba_price_updates), CHUNK)]
            var_decls      = ", ".join(f"$items{i}: [P_API_AuctionPriceInput!]!" for i in range(len(chunks)))
            mutations_body = "\n".join(f'update{i}: P_updateAuctionPrice(input: {{ items: $items{i} }}) {{\n  items {{ auctionId success paidForPriceChange error }}\n}}' for i in range(len(chunks)))
            full_mutation  = f"mutation RefreshPrices({var_decls}) {{\n{mutations_body}\n}}"
            all_vars       = {f"items{i}": chunk for i, chunk in enumerate(chunks)}
            try:
                data = await _eneba_graphql(full_mutation, all_vars)
                for i in range(len(chunks)):
                    for item in (data.get(f"update{i}") or {}).get("items", []):
                        if item.get("success"): eneba_updated += 1
                        else: eneba_failed += 1
            except Exception as e:
                logger.error("P_updateAuctionPrice batch error: %s", e)
                eneba_failed += len(eneba_price_updates)

        return {"ok": True, "total": len(suppliers), "updated": updated, "failed": failed,
                "skipped": skipped, "eneba_updated": eneba_updated, "eneba_failed": eneba_failed,
                "usd_to_eur": usd_to_eur}

    except Exception as e:
        logger.error("refresh_mapping_costs error: %s", e, exc_info=True)
        raise HTTPException(500, detail=str(e))


@router.get("/mappings/by-product/{eneba_product_id}")
async def get_mappings_by_product(eneba_product_id: str):
    try:
        cl = supabase.table("channel_listings") \
            .select("product_id, sell_price") \
            .eq("external_id", eneba_product_id) \
            .eq("channel", "eneba") \
            .limit(1).execute()
        if not cl.data:
            return []
        product_id = cl.data[0]["product_id"]
        sell_price = float(cl.data[0].get("sell_price") or 0)
        ps = supabase.table("product_suppliers") \
            .select("id, provider_id, provider_sku, cost_price, priority, is_active, is_available, provider:providers(id, name, code)") \
            .eq("product_id", product_id).eq("is_active", True) \
            .order("priority", desc=False).execute()
        if not ps.data:
            return []
        return [{
            "id":            str(s["id"]),
            "provider_id":   str(s["provider_id"]),
            "provider_name": (s.get("provider") or {}).get("name", ""),
            "provider_code": (s.get("provider") or {}).get("code", ""),
            "provider_sku":  s["provider_sku"],
            "cost_price":    float(s["cost_price"]),
            "sell_price":    sell_price,
            "priority":      s["priority"],
        } for s in ps.data]
    except Exception as e:
        logger.error("get_mappings_by_product error: %s", e)
        return []


@router.put("/mappings/providers/{eneba_product_id}")
async def update_mapping_providers(eneba_product_id: str, req: EditProvidersRequest):
    logger.info("PUT providers — eneba_product_id=%s", eneba_product_id)
    try:
        cl = supabase.table("channel_listings").select("product_id").eq("external_id", eneba_product_id).eq("channel", "eneba").limit(1).execute()
        if not cl.data:
            raise HTTPException(404, "Producto no encontrado en channel_listings")
        product_id = cl.data[0]["product_id"]
        supabase.table("product_suppliers").delete().eq("product_id", product_id).execute()
        if not req.providers:
            return {"success": True, "created": 0}
        rows = []
        for idx, prov in enumerate(req.providers):
            pid = await _get_provider_id(prov.provider_code)
            if not pid: continue
            i_want_to_get = round(req.sell_price_eur * 0.95, 4)  # 5% comisión real, no 4%
            profit_eur    = round(i_want_to_get - prov.cost_price_eur, 4)
            margin_pct    = round(profit_eur / i_want_to_get * 100, 2) if i_want_to_get else 0
            rows.append({"product_id": product_id, "provider_id": pid, "provider_sku": prov.provider_sku, "cost_price": prov.cost_price_eur, "priority": idx + 1, "is_active": True, "is_available": True, "metadata": {"margin_pct": margin_pct}})
        if rows:
            supabase.table("product_suppliers").insert(rows).execute()
        return {"success": True, "created": len(rows)}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("update_mapping_providers error: %s", e)
        raise HTTPException(500, detail=str(e))


# ══════════════════════════════════════════════════════════════════════════════
# SECCIÓN 4 – BÚSQUEDA DE PRODUCTOS POR PROVEEDOR
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/hankgames/categories")
async def get_hankgames_categories(supplier_id: str = Query(...)):
    """
    Lista las categorías de Hankgames (para el selector de 2 pasos del
    modal "Agregar Proveedor": primero categorías, luego productos de la
    categoría elegida).
    """
    try:
        if supplier_id.isdigit():
            prov = supabase.table("providers").select("id, code, name").eq("id", int(supplier_id)).execute()
        else:
            prov = supabase.table("providers").select("id, code, name").ilike("name", f"%{supplier_id}%").limit(1).execute()
        if not prov.data:
            return []
        code = (prov.data[0].get("code") or prov.data[0].get("name", "")).lower()
        if "hankgames" not in code:
            return []
    except Exception:
        return []

    try:
        from app.providers import hankgames_client as hg
        categories = await hg.get_categories()
    except Exception as e:
        logger.exception("hankgames/categories error: %s", e)
        return []

    out = []
    for cat in categories:
        cat_id = cat.get("id") or cat.get("categoryId")
        if not cat_id:
            continue
        name = cat.get("name") or cat.get("categoryName") or cat.get("title") or str(cat_id)
        out.append({"id": str(cat_id), "name": name})
    out.sort(key=lambda c: c["name"].lower())
    return out


@router.get("/supplier-products")
async def get_supplier_products(
    supplier_id: str = Query(...),
    q: str = Query(""),
    merchant: str = Query("", description="Eneba wholesale: slug EXACTO del merchant"),
    product_type: str = Query("", description="Eneba wholesale: P_ProductType (GAME, GIFTCARD, etc.)"),
    sort: str = Query("", description="Eneba wholesale: P_API_AuctionSort (PRICE_ASC, ON_HAND_DESC, etc.)"),
    category_id: str = Query("", description="Hankgames: id de categoría — obligatorio para traer productos de Hankgames"),
    brand: str = Query("", description="EZ: filtrar por brand (match parcial)"),
    country: str = Query("", description="EZ: filtrar por country / region code"),
    currency: str = Query("", description="EZ: filtrar por moneda (ISO-4217, match exacto)"),
    sku: str = Query("", description="EZ: filtrar por SKU exacto"),
):
    try:
        if supplier_id.isdigit():
            prov = supabase.table("providers").select("id, code, name").eq("id", int(supplier_id)).execute()
        else:
            prov = supabase.table("providers").select("id, code, name").ilike("name", f"%{supplier_id}%").limit(1).execute()
        if not prov.data:
            return []
        code = (prov.data[0].get("code") or prov.data[0].get("name", "")).lower()
    except Exception:
        return []

    out: List[dict] = []

    if "ez" in code:
        ez = EZClient()
        common_filters = dict(
            brand=brand.strip() if brand else None,
            country=country.strip() if country else None,
            currency=currency.strip() if currency else None,
        )
        q_clean = q.strip() if q else ""
        sku_clean = sku.strip() if sku else ""

        if q_clean and sku_clean:
            data_by_name, data_by_sku = await asyncio.gather(
                ez.get_products(limit=100, page=1, name=q_clean, **common_filters),
                ez.get_products(limit=100, page=1, sku=sku_clean, **common_filters),
            )
            seen_skus = set()
            all_items = []
            for p in (data_by_name.get("items", []) or []) + (data_by_sku.get("items", []) or []):
                sku_val = p.get("sku")
                if sku_val in seen_skus:
                    continue
                seen_skus.add(sku_val)
                all_items.append(p)
        elif sku_clean:
            data = await ez.get_products(limit=100, page=1, sku=sku_clean, **common_filters)
            all_items = data.get("items", [])
        else:
            data = await ez.get_products(limit=100, page=1, name=q_clean or None, **common_filters)
            all_items = data.get("items", [])
        for p in all_items[:100]:
            prices     = p.get("prices") or []
            sell_price = p.get("sellPrice")
            if isinstance(sell_price, dict): amount, currency = sell_price.get("amount"), sell_price.get("currency", "USD")
            else: amount, currency = sell_price or (prices[0].get("price") if prices else 0), "USD"
            try: amount_float = float(amount) if amount is not None else 0.0
            except: amount_float = 0.0
            out.append({"id": p.get("sku", ""), "supplierId": supplier_id, "name": p.get("productName") or p.get("name", ""), "sku": p.get("sku", ""), "currency": currency, "priceType": "fixed", "fixedPrices": [amount_float], "stock": None})

    elif "bamboo" in code:
        bamboo  = BambooClient()
        catalog = await bamboo.get_catalog(page_size=200, page_index=0, name=q if q else None)
        brands  = catalog.get("items", []) or (catalog if isinstance(catalog, list) else [])
        q_lower = q.lower() if q else ""
        for brand in brands:
            products       = brand.get("products", []) if isinstance(brand, dict) and brand.get("products") else [brand]
            brand_name     = brand.get("name", "") if isinstance(brand, dict) else ""
            brand_currency = brand.get("currencyCode", "USD") if isinstance(brand, dict) else "USD"
            for p in products:
                name = p.get("name", "")
                if q_lower and q_lower not in name.lower() and q_lower not in brand_name.lower() and q_lower not in str(p.get("id", "")).lower(): continue
                price_obj  = p.get("price") or {}
                min_price  = price_obj.get("min")
                currency   = price_obj.get("currencyCode") or brand_currency
                min_face   = p.get("minFaceValue")
                max_face   = p.get("maxFaceValue")
                if min_face is not None and max_face is not None and min_face != max_face: fixed_prices, price_type = [min_face, max_face], "range"
                else: fixed_prices, price_type = [min_face or max_face], "fixed"
                out.append({"id": str(p.get("id", "")), "supplierId": supplier_id, "name": name, "sku": str(p.get("id", "")), "currency": currency, "priceType": price_type, "fixedPrices": fixed_prices, "costPrice": min_price, "stock": p.get("count", 0) or 0})
        out = out[:100]

    elif "cardone" in code or "99" in code:
        cardone = get_cardone_client()
        catalog = await cardone.get_catalog(page_number=1, page_size=50, query=q or None)
        items   = (catalog.get("data") or {}).get("list", []) or catalog.get("list", []) or []
        for p in items:
            out.append({"id": str(p.get("productCode") or p.get("code", "")), "supplierId": supplier_id, "name": p.get("productName") or p.get("title", ""), "sku": p.get("productCode") or p.get("code", ""), "currency": p.get("currencyCode", "USD"), "priceType": "fixed", "fixedPrices": [float(p.get("price") or 0)], "stock": p.get("stock", 0)})

    elif "wgcard" in code:
        try:
            from app.providers import wgcards_client as wg_client
            # Pedimos precios en USD — la API devuelve skuPrice en USD
            # v4 no busca por nombre: search_products busca en el catálogo
            # cacheado y trae precio/stock solo de lo encontrado.
            data = await wg_client.search_products(q or "", currency_code="USD")
            for item in data.get("records", []):
                item_name = item.get("itemName", "")
                # currencyCode del item es la moneda NATIVA de la region del producto
                # (e.g. PLN para Polonia, EUR para Europa), NO la moneda de compra.
                # Como solicitamos currency_code="USD", skuPrice ya viene en USD.
                item_id = str(item.get("itemId", ""))
                for sku in item.get("skus", []):
                    sku_id    = str(sku.get("skuId", ""))
                    sku_name  = sku.get("skuName", "")
                    full_name = f"{item_name} — {sku_name}" if sku_name else item_name
                    out.append({
                        "id":          sku_id,
                        "supplierId":  supplier_id,
                        "name":        full_name,
                        "sku":         sku_id,
                        "itemId":      item_id,
                        "currency":    "USD",
                        "priceType":   "fixed",
                        "fixedPrices": [float(sku.get("skuPrice") or sku.get("minFaceValue") or 0)],
                        "costPrice":   float(sku.get("skuPrice") or 0) or None,
                        "stock":       sku.get("stock"),
                    })
        except Exception as e:
            logger.error("supplier-products WgCards error: %s", e)
    
    elif "eneba" in code:
        try:
            from app.providers.eneba_wholesale_client import get_eneba_wholesale_client
            client  = get_eneba_wholesale_client()
            result  = await client.get_wholesale_auctions(
                search=q or None,
                first=50,
                merchant_search=merchant or None,
                product_type=product_type or None,
                sort=sort or None,
            )
            edges   = result.get("edges", [])
 
            for edge in edges:
                node     = edge.get("node", {})
                w_price  = node.get("wholesalePrice", {}) or {}
                merchant = node.get("merchant", {}) or {}

                auction_id    = node.get("id", "")
                product       = node.get("product") or {}
                merchant_name = merchant.get("displayName") or merchant.get("slug") or ""
                name          = product.get("name") or merchant_name or auction_id
                on_hand       = node.get("wholesaleStock") or 0

                # wholesalePrice.amount viene en centavos → dividir /100
                amount_cents = w_price.get("amount") or 0
                currency     = w_price.get("currency", "EUR")
                amount_float = round(float(amount_cents) / 100, 4)

                out.append({
                    "id":           auction_id,
                    "supplierId":   supplier_id,
                    "name":         name,
                    "sku":          auction_id,   # auctionId = provider_sku en product_suppliers
                    "currency":     currency,
                    "priceType":    "fixed",
                    "fixedPrices":  [amount_float],
                    "costPrice":    amount_float,
                    "stock":        on_hand,
                    "merchantName": merchant_name,
                    "merchantSlug": merchant.get("slug") or None,
                    "productId":    product.get("id") or None,
                })
        except Exception as e:
            logger.error("supplier-products Eneba error: %s", e)
    elif "icodes" in code:
        try:
            from app.providers.icodes_client import get_varieties
            varieties = await get_varieties()
            # varieties es una lista de objetos; filtramos por nombre o sku si hay query
            q_lower = q.lower() if q else ""
            for v in varieties:
                name = v.get("name") or str(v.get("product_sku", ""))
                sku  = str(v.get("product_sku", ""))
                if q_lower and q_lower not in name.lower() and q_lower not in sku.lower():
                    continue
                price_raw = v.get("price") or 0
                try:
                    price_float = float(price_raw)
                except (TypeError, ValueError):
                    price_float = 0.0
                out.append({
                    "id":          sku,
                    "supplierId":  supplier_id,
                    "name":        name,
                    "sku":         sku,
                    "currency":    v.get("currency_code", "USD"),
                    "priceType":   "fixed",
                    "fixedPrices": [price_float],
                    "costPrice":   price_float if price_float > 0 else None,
                    "stock":       None,
                    "minQty":      (v.get("orderable_range") or {}).get("from"),
                    "maxQty":      (v.get("orderable_range") or {}).get("to"),
                    "isUnlimited": (v.get("orderable_range") or {}).get("is_unlimited", False),
                })
            out = out[:100]
        except Exception as e:
            logger.error("supplier-products iCodes error: %s", e)
    elif "coda" in code:
        try:
            from app.providers.coda_voucher_client import CodaVoucherClient
            coda_v = CodaVoucherClient()
            products = await coda_v.list_voucher_products()
            q_lower = q.lower() if q else ""
            matches = [
                p for p in products
                if not q_lower or q_lower in p["name"].lower()
            ][:15]  # cada match dispara un listSku aparte, no ampliar sin paginar
            for p in matches:
                try:
                    skus = await coda_v.list_skus(p["apiPath"])
                except Exception as e:
                    logger.warning("supplier-products Coda Voucher: listSku(%s) error: %s", p["apiPath"], e)
                    continue
                for s in skus:
                    try:
                        price_float = float(s.get("priceAmount") or 0)
                    except (TypeError, ValueError):
                        price_float = 0.0
                    out.append({
                        "id":          s["sku"],
                        "supplierId":  supplier_id,
                        "name":        f"{p['name']} — {s['title']}",
                        "sku":         s["sku"],
                        "itemId":      p["apiPath"],  # guardar como provider_item_id: lo necesita el purchase flow (api_path)
                        "currency":    s.get("priceCurrency", "USD"),
                        "priceType":   "fixed",
                        "fixedPrices": [price_float],
                        "costPrice":   price_float if price_float > 0 else None,
                        "stock":       None,
                    })
            out = out[:100]
        except Exception as e:
            logger.error("supplier-products Coda Voucher error: %s", e)
    elif "manastore" in code:
        try:
            from app.providers.manastore_client import ManastoreClient
            ms = ManastoreClient()
            resp = await ms.search_products(q, per_page=100) if q else await ms.list_products(per_page=100)
            items = resp.get("data", resp) if isinstance(resp, dict) else (resp or [])
            for p in items:
                product_id = p.get("id")
                variants = p.get("variants")
                if not variants:
                    v = p.get("variant")
                    variants = [v] if v else []
                for v in variants:
                    price = v.get("price") or {}
                    try:
                        price_float = float(price.get("decimal") or 0)
                    except (TypeError, ValueError):
                        price_float = 0.0
                    variant_id = v.get("id")
                    if variant_id is None:
                        continue
                    label = v.get("name") or v.get("face_value") or p.get("name", "")
                    out.append({
                        "id":          str(variant_id),
                        "supplierId":  supplier_id,
                        "name":        f"{p.get('name', '')} — {label}".strip(" —"),
                        "sku":         str(variant_id),
                        "itemId":      str(product_id) if product_id is not None else None,  # provider_item_id: product_id, usado para refrescar precios
                        "currency":    price.get("currency", "USD"),
                        "priceType":   "fixed",
                        "fixedPrices": [price_float],
                        "costPrice":   price_float if price_float > 0 else None,
                        "stock":       None,
                    })
            out = out[:100]
        except Exception as e:
            logger.error("supplier-products Manastore error: %s", e)
    elif "visoria" in code:
        try:
            from app.providers import visoria_client as vs
            # Solo códigos de precio fijo (las recargas de Visoria van por yape-gaming).
            for p in await vs.search_products(q or "", max_pages=1):
                denom = (p.get("denomination") or {}).get("type") or "BASIC"
                if not vs.is_code_product(p) or denom != "BASIC":
                    continue
                try:
                    price_float = float(p.get("price") or 0)
                except (TypeError, ValueError):
                    price_float = 0.0
                out.append({
                    "id":          str(p.get("id")),
                    "supplierId":  supplier_id,
                    "name":        p.get("name") or str(p.get("id")),
                    "sku":         str(p.get("id")),
                    "currency":    p.get("currency_code") or "USD",
                    "priceType":   "fixed",
                    "fixedPrices": [price_float],
                    "costPrice":   price_float if price_float > 0 else None,
                    "stock":       None if p.get("stock_unlimited") else p.get("stock"),
                })
            out = out[:100]
        except Exception as e:
            logger.error("supplier-products Visoria error: %s", e)
    elif "tisi" in code:
        try:
            from app.providers.tisi_client import TisiClient
            tisi = TisiClient()
            productos = await tisi.get_catalog()
            q_lower = q.lower().strip() if q else ""
            for p in productos:
                id_producto = str(p.get("id_producto") or p.get("idProducto") or "")
                nombre = str(p.get("nombre_producto") or p.get("nombreProducto") or id_producto)
                if q_lower and q_lower not in nombre.lower() and q_lower not in id_producto:
                    continue
                try:
                    precio = float(p.get("precio") or p.get("price") or 0)
                except (TypeError, ValueError):
                    precio = 0.0
                pais = p.get("pais_destino") or p.get("paisDestino") or ""
                campos = p.get("campos_referencia") or []
                out.append({
                    "id":          id_producto,
                    "supplierId":  supplier_id,
                    "name":        f"{nombre} ({pais})" if pais else nombre,
                    "sku":         id_producto,
                    "currency":    "PEN",
                    "priceType":   "fixed",
                    "fixedPrices": [precio] if precio > 0 else [],
                    "costPrice":   precio if precio > 0 else None,
                    "stock":       p.get("stock") or p.get("cantidad_disponible") or 0,
                    "tisi_campos_referencia": campos,
                    "requiresEmail": any(c.get("id") == "EMAIL" for c in campos),
                    "requiresTelefono": any(c.get("id") == "TELEFONO" for c in campos),
                })
        except Exception as e:
            logger.error("supplier-products TISI error: %s", e)
    elif "wupex" in code:
        try:
            from app.providers import wupex_client as wp
            items = await wp.get_all_products(q=q or "", page_size=100, max_pages=5)
            for p in items:
                sku = str(p.get("productCode") or p.get("productId") or "")
                if not sku:
                    continue
                try:
                    price_float = float(p.get("price") or 0)
                except (TypeError, ValueError):
                    price_float = 0.0
                out.append({
                    "id":          sku,
                    "supplierId":  supplier_id,
                    "name":        p.get("productName") or sku,
                    "sku":         sku,
                    "productId":   p.get("productId"),
                    "currency":    "USD",
                    "priceType":   "fixed",
                    "fixedPrices": [price_float],
                    "costPrice":   price_float if price_float > 0 else None,
                    "stock":       p.get("available"),
                    "cardType":    p.get("cardType"),
                    "subType":     p.get("subType"),
                    "regionName":  p.get("regionName"),
                })
            out = out[:100]
        except Exception as e:
            logger.error("supplier-products Wupex error: %s", e)
    elif "hankgames" in code:
        try:
            from app.providers import hankgames_client as hg

            # Hankgames no tiene un único endpoint de búsqueda por nombre;
            # el catálogo se arma por categoría. Antes recorríamos TODAS
            # las categorías en cada búsqueda (muy lento). Ahora el modal
            # del frontend obliga a elegir una categoría primero
            # (/hankgames/categories) y acá solo traemos los productos de
            # esa categoría puntual.
            if not category_id:
                logger.warning("supplier-products Hankgames: falta category_id")
                return []

            q_lower = q.lower().strip() if q else ""

            try:
                all_products = await hg.get_products_by_category(category_id)
                logger.info("supplier-products Hankgames: categoria=%s -> %d productos, raw[0]=%s",
                            category_id, len(all_products), all_products[0] if all_products else None)
            except Exception:
                logger.warning("supplier-products Hankgames: error en categoria=%s", category_id)
                all_products = []

            CONCURRENCY = 8
            matches = []
            for p in all_products:
                # Confirmado en producción: los productos usan `_id` (no
                # `id`/`productId` como las categorías).
                product_id = str(p.get("_id") or p.get("id") or p.get("productId") or "")
                name = p.get("name") or p.get("title") or product_id
                if not product_id:
                    continue
                if q_lower and q_lower not in name.lower() and q_lower not in product_id.lower():
                    continue
                matches.append((product_id, name))
                if len(matches) >= 100:
                    break

            # Algunos productos de Hankgames son "de rango" (ej. "25,00 a
            # 500,00 Reais"): el usuario puede pedir cualquier monto entre
            # esos dos valores. La API de Hankgames NO devuelve un min/max
            # estructurado — `get_product_price` da un único número que,
            # comparado con los productos de monto fijo de la misma
            # categoría, resulta ser el COSTO POR 1 UNIDAD de la moneda
            # local (ej. costo de 1 Real), no el costo total del producto.
            # Por eso acá detectamos el rango en el nombre y el costo total
            # se calcula después en el frontend como cantidad × este valor.
            _range_re = re.compile(
                r"([\d]+(?:[.,]\d+)?)\s*a\s*([\d]+(?:[.,]\d+)?)\s*([A-Za-zÀ-ÿ$]+)?",
                re.IGNORECASE,
            )

            def _parse_range(name: str) -> Optional[dict]:
                m = _range_re.search(name)
                if not m:
                    return None
                try:
                    lo = float(m.group(1).replace(".", "").replace(",", ".")) if "," in m.group(1) else float(m.group(1))
                    hi = float(m.group(2).replace(".", "").replace(",", ".")) if "," in m.group(2) else float(m.group(2))
                except ValueError:
                    return None
                if hi <= lo:
                    return None
                return {"min": lo, "max": hi, "label": (m.group(3) or "").strip() or None}

            async def with_price(product_id: str, name: str) -> dict:
                price = None
                try:
                    price_resp = await hg.get_product_price(product_id)
                    if isinstance(price_resp, dict):
                        inner = price_resp.get("data") if isinstance(price_resp.get("data"), dict) else price_resp
                        price = inner.get("price") or inner.get("amount") or inner.get("value")
                except Exception:
                    logger.warning("supplier-products Hankgames: sin precio para productId=%s", product_id)
                price_float = float(price) if price is not None else 0.0

                rng = _parse_range(name)
                if rng:
                    return {
                        "id": product_id,
                        "supplierId": supplier_id,
                        "name": name,
                        "sku": product_id,
                        "currency": "USD",
                        "priceType": "range",
                        "minPrice": rng["min"],
                        "maxPrice": rng["max"],
                        "denominationLabel": rng["label"],
                        # costPrice acá es el costo POR UNIDAD (no del paquete
                        # mínimo) — el frontend lo multiplica por la cantidad.
                        "costPrice": price_float if price_float > 0 else None,
                        "isPerUnitCost": True,
                        "stock": None,
                    }
                return {
                    "id": product_id,
                    "supplierId": supplier_id,
                    "name": name,
                    "sku": product_id,
                    "currency": "USD",
                    "priceType": "fixed",
                    "fixedPrices": [price_float],
                    "costPrice": price_float if price_float > 0 else None,
                    "stock": None,
                }

            for i in range(0, len(matches), CONCURRENCY):
                batch = matches[i:i + CONCURRENCY]
                batch_results = await asyncio.gather(*(with_price(pid, name) for pid, name in batch))
                out.extend(batch_results)
        except Exception as e:
            logger.exception("supplier-products Hankgames error: %s", e)
    return out


# ══════════════════════════════════════════════════════════════════════════════
# SECCIÓN 5 – DEBUG
# ══════════════════════════════════════════════════════════════════════════════

@router.get("/debug-bamboo")
async def debug_bamboo():
    bamboo = BambooClient()
    return await bamboo.get_catalog(currency_code="USD", country_code="US", page_size=5, page_index=0)


@router.get("/debug-hankgames/{category_id}")
async def debug_hankgames(category_id: str):
    """
    Temporal: devuelve tal cual (sin transformar) lo que Hankgames responde
    para una categoría, para poder ajustar el parser sin adivinar el shape.
    Requiere estar logueado en el panel (mismo auth que el resto de /api/catalog).
    Ej: /api/catalog/debug-hankgames/6a6eb229e8461a8234ffe3dd  (Playstation USA)
    """
    from app.providers import hankgames_client as hg
    products = await hg.get_products_by_category(category_id)
    return {"count": len(products), "raw": products}


# ══════════════════════════════════════════════════════════════════════════════
# SECCIÓN 6 – MAPEO MASIVO
# ══════════════════════════════════════════════════════════════════════════════

class BulkMatchRequest(BaseModel):
    names: List[str]
    limit: int = 5


@router.post("/eneba/bulk-match")
async def bulk_match(req: BulkMatchRequest):
    from difflib import SequenceMatcher

    def similarity(a: str, b: str) -> int:
        return round(SequenceMatcher(None, a.lower().strip(), b.lower().strip()).ratio() * 100)

    token = await _get_eneba_token()

    async def search_for_name(name: str):
        gql = """
        query BulkSearch($name: String!, $first: Int!) {
          S_products(filter: { name: $name }, first: $first) { edges { node { id name slug } } }
        }
        """
        try:
            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.post(settings.ENEBA_GRAPHQL_URL, json={"query": gql, "variables": {"name": name, "first": 10}}, headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
                data       = resp.json()
                edges      = data.get("data", {}).get("S_products", {}).get("edges", [])
                candidates = [{"product_id": e["node"]["id"], "product_name": e["node"]["name"], "score": similarity(name, e["node"]["name"])} for e in edges]
                candidates.sort(key=lambda x: x["score"], reverse=True)
                return name, candidates[:req.limit]
        except Exception as e:
            logger.warning("bulk-match error '%s': %s", name, e)
            return name, []

    results: dict = {}
    CONCURRENCY   = 5
    for i in range(0, len(req.names), CONCURRENCY):
        batch         = req.names[i:i + CONCURRENCY]
        batch_results = await asyncio.gather(*[search_for_name(n) for n in batch])
        for name, candidates in batch_results:
            results[name] = candidates
        if i + CONCURRENCY < len(req.names):
            await asyncio.sleep(0.5)

    return {"matches": results, "total": len(results)}


@router.get("/supplier-products-bulk")
async def get_supplier_products_bulk(supplier_id: str = Query(...), q: str = Query("")):
    return await get_supplier_products(supplier_id=supplier_id, q=q)


@router.get("/debug/bamboo-test")
async def bamboo_test():
    import httpx as _httpx
    results = {}
    async with _httpx.AsyncClient() as client:
        r = await client.get("https://api.ipify.org?format=json")
        results["ip"] = r.json().get("ip")
    async with _httpx.AsyncClient(timeout=15.0) as client:
        try:
            r = await client.get(f"{settings.BAMBOO_BASE_URL}/api/integration/v1.0/accounts", auth=(settings.BAMBOO_CLIENT_ID, settings.BAMBOO_CLIENT_SECRET))
            results["bamboo_status"]   = r.status_code
            results["bamboo_response"] = r.text[:500]
        except Exception as e:
            results["bamboo_error"] = str(e)
    return results