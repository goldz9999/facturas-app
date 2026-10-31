// ─── Cliente HTTP de la API de distribución (codes-hub / Schedaup) ────────────
// Es un servicio aparte del backend principal. Por defecto usa la URL de
// producción; VITE_DIST_API_URL la reemplaza (p. ej. http://localhost:8080
// para el entorno local de codes-hub/dev).
// Usa el mismo JWT del login (codevault_jwt): ambos servicios comparten JWT_SECRET.
//
// A diferencia de apiFetch, un 401 NO cierra la sesión: si el backend principal
// acepta el token pero esta API no, casi siempre es JWT_SECRET distinto en Railway.
import type {
  ClientProduct, ClientStats, ClientSummary, DistClient, DistCredentials, DistOrder, DistTopup, LedgerEntry, Page,
  ProductClient, ProductMapping, TopupAssignment, TopupStatus,
} from "./types";

export const DIST_API_URL = (import.meta.env.VITE_DIST_API_URL || "https://schedaup-api-production.up.railway.app").replace(/\/+$/, "");
const JWT_KEY = "codevault_jwt";

export class DistApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details: Record<string, unknown> = {}) {
    super(message);
  }
}

async function distFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!DIST_API_URL) {
    throw new DistApiError(0, "not_configured", "Falta VITE_DIST_API_URL en el .env del frontend");
  }
  const token = localStorage.getItem(JWT_KEY);
  let res: Response;
  try {
    res = await fetch(`${DIST_API_URL}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new DistApiError(0, "network", "No se pudo conectar con la API de distribución");
  }

  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401) {
      throw new DistApiError(401, "unauthorized",
        "La API de distribución rechazó tu sesión. Vuelve a iniciar sesión; si sigue, revisa que JWT_SECRET sea igual en ambos servicios.");
    }
    const fields = (body?.details?.fields ?? []) as { field: string; message: string }[];
    const extra = fields.length ? ` (${fields.map(f => `${f.field}: ${f.message}`).join(", ")})` : "";
    throw new DistApiError(res.status, body?.error ?? "error", (body?.message ?? `Error ${res.status}`) + extra, body?.details);
  }
  return body as T;
}

const json = (body: unknown) => JSON.stringify(body);

// ── Clientes ─────────────────────────────────────────────────────────────────
export const listClients = () => distFetch<DistClient[]>("/admin/dist/clients");
export const getClient = (id: number) => distFetch<DistClient>(`/admin/dist/clients/${id}`);

export interface ClientCreateBody {
  code: string;
  name: string;
  balance_currency: string;
  ip_whitelist: string[];
  rate_limit_rpm: number;
  low_balance_threshold: number | null;
  contact_email: string | null;
  sandbox?: boolean;
}
export const createClient = (body: ClientCreateBody) =>
  distFetch<{ client: DistClient; credentials: DistCredentials }>("/admin/dist/clients", { method: "POST", body: json(body) });

export type ClientUpdateBody = Partial<Pick<ClientCreateBody, "name" | "rate_limit_rpm" | "low_balance_threshold" | "contact_email">>;
export const updateClient = (id: number, body: ClientUpdateBody) =>
  distFetch<DistClient>(`/admin/dist/clients/${id}`, { method: "PUT", body: json(body) });
export const setClientStatus = (id: number, status: DistClient["status"]) =>
  distFetch<DistClient>(`/admin/dist/clients/${id}/status`, { method: "PATCH", body: json({ status }) });
export const rotateKey = (id: number) =>
  distFetch<DistCredentials>(`/admin/dist/clients/${id}/rotate-key`, { method: "POST" });

export const addIp = (id: number, ip: string) =>
  distFetch<string[]>(`/admin/dist/clients/${id}/ips`, { method: "POST", body: json({ ip }) });
export const removeIp = (id: number, ip: string) =>
  distFetch<string[]>(`/admin/dist/clients/${id}/ips/${ip}`, { method: "DELETE" });

// ── Productos por cliente ────────────────────────────────────────────────────
export const listClientProducts = (id: number) => distFetch<ClientProduct[]>(`/admin/dist/clients/${id}/products`);
export const addClientProduct = (id: number, body: { product_id: number; sell_price: number; external_sku: string | null }) =>
  distFetch<ClientProduct>(`/admin/dist/clients/${id}/products`, { method: "POST", body: json(body) });
export const updateClientProduct = (id: number, productId: number,
  body: Partial<{ sell_price: number; external_sku: string | null; is_active: boolean }>) =>
  distFetch<ClientProduct>(`/admin/dist/clients/${id}/products/${productId}`, { method: "PUT", body: json(body) });
export const removeClientProduct = (id: number, productId: number) =>
  distFetch<void>(`/admin/dist/clients/${id}/products/${productId}`, { method: "DELETE" });
export const listProductClients = (productId: number) =>
  distFetch<ProductClient[]>(`/admin/dist/products/${productId}/clients`);

// ── Saldo ────────────────────────────────────────────────────────────────────
export const creditBalance = (id: number, body: { amount: number; type: "credit" | "refund"; description: string; reference_id: string | null }) =>
  distFetch<LedgerEntry>(`/admin/dist/clients/${id}/balance/credit`, { method: "POST", body: json(body) });
export const adjustBalance = (id: number, body: { amount: number; description: string }) =>
  distFetch<LedgerEntry>(`/admin/dist/clients/${id}/balance/adjust`, { method: "POST", body: json(body) });

export async function getLedger(id: number, page: number, pageSize = 25): Promise<Page<LedgerEntry>> {
  const r = await distFetch<{ transactions: LedgerEntry[]; page: number; page_size: number; total: number }>(
    `/admin/dist/clients/${id}/ledger?page=${page}&page_size=${pageSize}`);
  return { page: r.page, page_size: r.page_size, total: r.total, items: r.transactions };
}

// ── Órdenes ──────────────────────────────────────────────────────────────────
export async function getOrders(id: number, page: number, pageSize = 25): Promise<Page<DistOrder>> {
  const r = await distFetch<{ orders: DistOrder[]; page: number; page_size: number; total: number }>(
    `/admin/dist/clients/${id}/orders?page=${page}&page_size=${pageSize}`);
  return { page: r.page, page_size: r.page_size, total: r.total, items: r.orders };
}
export const refundOrder = (orderId: number, description: string) =>
  distFetch<DistOrder>(`/admin/dist/orders/${orderId}/refund`, { method: "POST", body: json({ description: description || null }) });

// ── Recargas directas ────────────────────────────────────────────────────────
export const listClientTopups = (id: number) =>
  distFetch<TopupAssignment[]>(`/admin/dist/clients/${id}/topup-products`);
export const listVariantClients = (supplierId: number) =>
  distFetch<TopupAssignment[]>(`/admin/dist/topup-variants/${supplierId}/clients`);
export const addClientTopup = (id: number, body: { supplier_id: number; sell_price: number; external_sku: string; name: string | null }) =>
  distFetch<TopupAssignment>(`/admin/dist/clients/${id}/topup-products`, { method: "POST", body: json(body) });
export const updateClientTopup = (id: number, assignmentId: number,
  body: Partial<{ sell_price: number; external_sku: string; name: string | null; is_active: boolean }>) =>
  distFetch<TopupAssignment>(`/admin/dist/clients/${id}/topup-products/${assignmentId}`, { method: "PUT", body: json(body) });
export const removeClientTopup = (id: number, assignmentId: number) =>
  distFetch<void>(`/admin/dist/clients/${id}/topup-products/${assignmentId}`, { method: "DELETE" });

export async function getTopups(params: { clientId?: number; status?: TopupStatus }, page: number, pageSize = 25): Promise<Page<DistTopup>> {
  const q = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (params.clientId != null) q.set("client_id", String(params.clientId));
  if (params.status) q.set("status", params.status);
  const r = await distFetch<{ topups: DistTopup[]; page: number; page_size: number; total: number }>(`/admin/dist/topups?${q}`);
  return { page: r.page, page_size: r.page_size, total: r.total, items: r.topups };
}
export const refreshTopup = (topupId: number) =>
  distFetch<DistTopup>(`/admin/dist/topups/${topupId}/refresh`, { method: "POST" });
export const resolveTopup = (topupId: number, outcome: "completed" | "failed", note: string) =>
  distFetch<DistTopup>(`/admin/dist/topups/${topupId}/resolve`, { method: "POST", body: json({ outcome, note: note || null }) });
export const refundTopup = (topupId: number, description: string) =>
  distFetch<DistTopup>(`/admin/dist/topups/${topupId}/refund`, { method: "POST", body: json({ description: description || null }) });

// ── Estadísticas ─────────────────────────────────────────────────────────────
export const getSummary = () => distFetch<ClientSummary[]>("/admin/dist/summary");
export const getClientStats = (id: number, days = 30) => distFetch<ClientStats>(`/admin/dist/clients/${id}/stats?days=${days}`);
export const getProductMappings = () => distFetch<ProductMapping[]>("/admin/dist/product-mappings");

// ── Utilidades ───────────────────────────────────────────────────────────────
export function money(value: string | number | null | undefined, currency?: string) {
  const n = Number(value ?? 0);
  const s = n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${s} ${currency}` : s;
}

/** "12:03" si es de hoy, "14 oct 20:40" si no: cabe en una línea dentro de listas. */
export function shortDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  const time = d.toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString("es-PE", { day: "numeric", month: "short" }).replace(".", "")} ${time}`;
}

export function dateTime(value: string | null | undefined) {
  if (!value) return "—";
  return new Date(value).toLocaleString("es-PE", { dateStyle: "short", timeStyle: "short" });
}

/** "~6 días", "~1 día", "menos de 1 día" o null si no hay consumo reciente. */
export function daysLabel(days: number | null | undefined) {
  if (days == null) return null;
  if (days < 1) return "menos de 1 día";
  const d = Math.floor(days);
  return `~${d} ${d === 1 ? "día" : "días"}`;
}
