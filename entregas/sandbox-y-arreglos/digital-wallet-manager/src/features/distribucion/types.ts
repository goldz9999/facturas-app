// ─── Tipos del módulo Distribución (API Schedaup / codes-hub) ─────────────────

export type ClientStatus = "active" | "suspended" | "inactive";

export interface DistClient {
  id: number;
  code: string;
  name: string;
  status: ClientStatus;
  api_client_id: string;
  balance: string | number;
  balance_currency: string;
  ip_whitelist: string[];
  rate_limit_rpm: number;
  low_balance_threshold: string | number | null;
  webhook_url: string | null;
  contact_email: string | null;
  metadata: Record<string, unknown>;
  credentials_rotated_at: string | null;
  /** Cliente de prueba: sus recargas son simuladas, nunca llegan a un proveedor. */
  sandbox?: boolean;
  created_at: string;
  updated_at: string;
}

export interface DistCredentials {
  client_id: string;
  client_secret: string;
}

export interface ClientProduct {
  id: number;
  client_id: number;
  product_id: number;
  external_sku: string | null;
  sell_price: string | number;
  sell_currency: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  product?: { id: number; sku: string; name: string; is_active?: boolean | null } | null;
}

export interface ProductClient {
  id: number;
  client_id: number;
  product_id: number;
  external_sku: string | null;
  sell_price: string | number;
  sell_currency: string;
  is_active: boolean;
  client: { id: number; code: string; name: string; status: ClientStatus };
}

export interface LedgerEntry {
  id: number;
  type: "credit" | "debit" | "refund" | "adjustment";
  amount: number;
  currency: string;
  balance_after: number;
  reference_type: string | null;
  reference_id: string | null;
  description: string | null;
  created_by: string;
  created_at: string;
}

export interface Page<T> {
  page: number;
  page_size: number;
  total: number;
  items: T[];
}

export interface OrderCode {
  code: string;
  pin: string | null;
  serial: string | null;
  expires_at: string | null;
}

export interface DistOrder {
  id: number;
  order_id: string;
  request_id: string;
  client_id: number;
  product_id: number | null;
  status: "completed" | "refunded";
  product_sku: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  total: number;
  currency: string;
  codes: OrderCode[];
  created_at: string;
  refunded_at: string | null;
  balance_after?: number | null;
}

// ── Recargas directas ───────────────────────────────────────────────────────
/** Variante de recarga asignada a un cliente (lo que ve en /v1/topups/catalog). */
export interface TopupAssignment {
  id: number;
  client_id: number;
  supplier_id: number;
  product_id: number;
  external_sku: string;
  name: string | null;
  sell_price: string | number;
  sell_currency: string;
  is_active: boolean;
  client?: { id: number; code: string; name: string; status: ClientStatus } | null;
  supplier?: { id: number; provider: string | null; variant_label: string | null; title: string | null; is_active: boolean } | null;
  product?: { id: number; name: string; is_active?: boolean | null } | null;
}

export type TopupStatus = "pending" | "completed" | "failed" | "uncertain" | "refunded";

export interface DistTopup {
  id: number;
  order_number: string | null;
  client_id: number;
  request_id: string;
  product_sku: string;
  product_name: string;
  account: { user_id?: string; zone_id?: string; server?: string };
  user_name: string | null;
  price: number;
  currency: string;
  status: TopupStatus;
  error: string | null;
  provider: string | null;
  provider_order_id: string | null;
  cost_price: number | null;
  cost_currency: string | null;
  created_at: string;
  completed_at: string | null;
  balance_after?: number | null;
}

export const TOPUP_STATUS: Record<TopupStatus, { label: string; color: string }> = {
  pending: { label: "En proceso", color: "text-sky-400 border-sky-400/30" },
  completed: { label: "Completada", color: "text-emerald-400 border-emerald-500/30" },
  failed: { label: "Fallida · devuelta", color: "text-muted-foreground border-border" },
  uncertain: { label: "Revisar", color: "text-amber-400 border-amber-400/40 bg-amber-400/10" },
  refunded: { label: "Devuelta", color: "text-yellow-400 border-yellow-400/30" },
};

export const CLIENT_STATUS: Record<ClientStatus, { label: string; color: string }> = {
  active: { label: "Activo", color: "text-emerald-400 border-emerald-500/30 bg-emerald-500/10" },
  suspended: { label: "Suspendido", color: "text-yellow-400 border-yellow-400/30 bg-yellow-400/10" },
  inactive: { label: "Inactivo", color: "text-muted-foreground border-border bg-secondary/40" },
};

export const LEDGER_TYPE: Record<LedgerEntry["type"], string> = {
  credit: "Recarga",
  debit: "Compra",
  refund: "Devolución",
  adjustment: "Ajuste",
};

export const CLIENT_TABS = ["Resumen", "Órdenes", "Recargas", "Movimientos", "Productos", "Acceso API"] as const;
export type ClientTab = typeof CLIENT_TABS[number];

export interface ClientSummary {
  client_id: number;
  codes_today: number;
  total_today: number;
  spend_7d: number;
  avg_daily_spend: number;
  /** Días que alcanza el saldo al ritmo de los últimos 7 días. null = sin consumo reciente. */
  days_left: number | null;
}

export interface ClientStats {
  daily: { day: string; codes: number; total: number }[];
  top_products: { product_name: string; codes: number; total: number }[];
  today: { codes: number; total: number };
  month: { codes: number; total: number };
  spend_7d: number;
  avg_daily_spend: number;
  days_left: number | null;
  products_enabled: number;
  products_out_of_stock: number;
}

export interface ProductMapping {
  product_id: number;
  client_id: number;
  client_code: string;
  client_name: string;
  is_active: boolean;
}

export type ClientHealth = "ok" | "low" | "empty" | "off";

/** Estado para el punto de color de la lista: inactivo, sin saldo, saldo bajo o bien. */
export function clientHealth(c: DistClient, s?: ClientSummary): ClientHealth {
  if (c.status !== "active") return "off";
  const balance = Number(c.balance);
  if (balance <= 0) return "empty";
  const threshold = c.low_balance_threshold != null ? Number(c.low_balance_threshold) : null;
  if ((threshold != null && balance < threshold) || (s?.days_left != null && s.days_left < 2)) return "low";
  return "ok";
}

export const HEALTH_COLOR: Record<ClientHealth, string> = {
  ok: "text-muted-foreground",
  low: "text-yellow-400",
  empty: "text-red-400",
  off: "text-muted-foreground/60",
};

export const HEALTH_DOT: Record<ClientHealth, string | null> = {
  ok: null,
  low: "bg-yellow-400",
  empty: "bg-red-400",
  off: "bg-muted-foreground/50",
};
