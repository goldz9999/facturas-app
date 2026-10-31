// UBICACIÓN EN TU REPO: digital-wallet-manager/src/features/productos/types.ts
// (repositorio: digital-wallet-manager · ruta: src/features/productos/types.ts)
// ─── Tipos del módulo Productos ────────────────────────────────────────────────
// Movidos 1:1 desde pages/Productos.tsx — sin cambios de forma, solo de ubicación.

export interface Provider { id: number; name: string; code: string; }

export interface Supplier {
  id: number; provider_id: number; provider_sku: string;
  cost_price: string; cost_currency: string; priority: number; is_active: boolean; is_available: boolean;
  priority_locked?: boolean;
  provider: Provider;
}

export interface Channel {
  id: number; channel: string; external_id: string | null;
  external_name?: string | null;
  external_auction_id?: string | null;
  seller_sku?: string | null;
  sell_price: string | null; declared_stock: number; stock_actual: number;
  is_active: boolean; auto_replenish: boolean;
  replenish_threshold: number; replenish_qty: number;
  last_sync_at: string | null;
  max_cost_usd: number | null;
  purchase_currency?: string | null;
  active_reservations?: number;
}

export interface Product {
  id: number; sku: string; name: string; is_active: boolean;
  product_type: "code" | "coda_topup";
  aliases?: string[] | null;
  inv_replenish_threshold?: number | null;
  inv_replenish_qty?: number | null;
  inv_auto_replenish?: boolean | null;
  inv_max_cost_usd?: number | null;
  /** "scheduled" = Modo A (5×/día) · "threshold" = Modo B (por umbral). Ausente si el backend no tiene la migración. */
  inv_replenish_mode?: "scheduled" | "threshold" | null;
  eneba_auto_disable_enabled?: boolean | null;
  eneba_auto_disable_min_stock?: number | null;
  suppliers: Supplier[];
  channels: Channel[];
}

export interface InventoryCode {
  id: number | string; code: string | null; pin?: string | null; serial?: string | null;
  status: string; created_at: string;
  sold_to_channel?: string | null;
  sold_at?: string | null;
  source?: string;
  cost_price?: number | null;
  order_id?: string | null;
  reserved_qty?: number | null;
}

export interface SupplierProduct {
  id: string; name: string; sku: string; price: number; currency?: string;
}

export interface FalabellaProduct {
  seller_sku: string; shop_sku: string; name: string; stock: number; price: number; status: string;
}

export const TABS = ["General", "Proveedores", "Canales", "Inventario", "Config"] as const;
export type Tab = typeof TABS[number];

// Productos de recarga directa (product_type === "coda_topup") tienen un set
// de tabs distinto: no manejan inventario propio (Coda no tiene stock tuyo
// que administrar) ni Config; en su lugar, Historial de recargas.
export const TABS_CODA = ["General", "Proveedores", "Canales", "Canje", "Historial"] as const;

// ── Códigos de canje (yape-gaming /redeem) ──────────────────────────────────
export type RedeemStatus = "active" | "processing" | "review" | "redeemed" | "void";

export interface RedeemBatch {
  id: string;
  supplier_id: number;
  topup_product_id: number;
  code_product_id: number | null;
  quantity: number;
  prefix: string | null;
  created_by: string | null;
  created_at: string;
  variant: string;
  counts: Partial<Record<RedeemStatus, number>>;
  product_sku?: string;
  product_name?: string;
  codes?: string[];
}

export interface RedeemCode {
  id: number;
  code: string;
  display_code: string;
  batch_id: string;
  supplier_id: number;
  code_product_id: number | null;
  inventory_code_id: number | null;
  status: RedeemStatus;
  attempts: number;
  account: { user_id?: string; zone_id?: string; server?: string } | null;
  user_name: string | null;
  provider: string | null;
  provider_order_id: string | null;
  error: string | null;
  note: string | null;
  redeemed_at: string | null;
  created_at: string;
  pin_status: string | null;
  sold_to_channel: string | null;
}
export type TabCoda = typeof TABS_CODA[number];

// ─── Recarga Directa (gaming, via Coda xShop) ──────────────────────────────
// Estos productos NO se entregan como código: se acreditan directo en la
// cuenta del jugador. El catálogo de Coda (para buscar/mapear un SKU) llega
// en vivo vía backend-yape; el mapeo, canal y el historial sí se guardan en
// tablas propias, separadas de product_suppliers/channel_listings.

// Entrada del catálogo en vivo de Coda (para el buscador de mapeo)
export interface CodaProductEntry {
  name: string;
  apiPath: string;
  subtype: number;
  haveRole: boolean;
}

export interface CodaSkuEntry {
  sku: string;
  title: string;
  priceAmount: number | null;
  priceCurrency: string | null;
  stock: boolean;
}
export interface CodaCatalogEntry {
  sku: string;
  title: string;
  apiPath: string;
  subtype: number;
  haveRole: boolean;
  stock: boolean;
  priceAmount: number | null;
  priceCurrency: string | null;
}

export type DirectTopupProvider = "coda" | "hankgames" | "visoria";

// Visoria no tiene listado de juegos: se busca por nombre.
export interface VisoriaGameEntry {
  name: string;
  categoryId: string;
  count: number;
}

// Producto de recarga de Visoria: mismo formato que un SKU de Coda, más
// qué datos pide (subtype sugerido) según sus campos.
export interface VisoriaSkuEntry extends CodaSkuEntry {
  subtype?: number;
  haveRole?: boolean;
  fields?: { name: string; label: string; required: boolean }[];
}

export interface HankgamesCategoryEntry {
  name: string;
  categoryId: string;
}

// Variante mapeada a un proveedor (una denominación específica, ej. "5 Diamantes").
// Un producto puede tener varias. Para Hankgames, coda_sku = productId y
// coda_api_path = categoryId.
export interface DirectTopupVariant {
  id: number;
  product_id: number;
  provider?: DirectTopupProvider | string | null;
  // Variantes con el mismo variant_key son la misma recarga en distintos
  // proveedores (respaldo); priority 1 se intenta primero.
  variant_key?: string | null;
  priority?: number | null;
  coda_sku: string;
  coda_api_path: string;
  subtype: number;
  have_role: boolean;
  title: string | null;
  variant_label: string | null;
  cost_price: number | null;
  cost_currency: string;
  is_active: boolean;
  // false = "solo recarga": el motor no le pide el nombre del jugador.
  validates?: boolean | null;
}

// Canal donde se vende una variante puntual (no el producto entero)
export interface DirectTopupChannel {
  id: number;
  product_id: number;
  supplier_id: number;
  channel: string;
  sell_price: number | null;
  sell_currency: string;
  is_active: boolean;
  custom_product_id?: string | null;
  custom_title?: string | null;
}

// Fila de historial de recargas ya realizadas
export interface GamingRecharge {
  id: number;
  product_id: number | null;
  coda_sku: string;
  channel: string;
  user_id: string;
  server: string | null;
  order_id: string | null;
  status: "FULFILLED" | "FAILED";
  error_message: string | null;
  created_at: string;
}