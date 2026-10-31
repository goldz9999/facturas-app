// UBICACIÓN EN TU REPO: digital-wallet-manager/src/features/productos/api.ts
// (repositorio: digital-wallet-manager · ruta: src/features/productos/api.ts)
// ─── Llamadas a API del módulo Productos ───────────────────────────────────────
//
// Las 3 lecturas (fetchProducts, fetchFalabellaProducts, fetchProductInventory)
// usan el apiFetch centralizado de @/lib/api.
//
// Las mutaciones de abajo SÍ verifican `res.ok` (a diferencia del archivo
// original — ver auditoría: varias mutaciones trataban cualquier respuesta
// como éxito, incluso un 500 del backend). En el camino feliz no cambia nada;
// solo cambia qué pasa cuando el backend devuelve un error.
import { authFetch, apiFetch } from "@/lib/api";

// Mismo fallback que tenía el archivo original (string vacío, no localhost:8000
// como @/lib/api). Distinto a propósito — ver nota en el resumen.
const BASE = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

import type { Product, FalabellaProduct } from "./types";

// FastAPI devuelve {"detail": "..."} en sus errores por defecto — usamos ese
// mensaje cuando está disponible, igual que ya hacía apiManualPurchase.
async function parseOrThrow<T>(res: Response): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || `Error ${res.status}`);
  return data;
}

export const fetchProducts = (type?: "code" | "coda_topup") =>
  apiFetch<Product[]>(type ? `/api/products?type=${type}` : "/api/products");

export const fetchFalabellaProducts = () => apiFetch<FalabellaProduct[]>("/api/products/falabella/products");

// ─── Recarga Directa (gaming, via Coda xShop) ──────────────────────────────
// Separado a propósito de suppliers/channels de códigos — ver types.ts.
export const fetchCodaCatalog = () =>
  apiFetch<{ products: import("./types").CodaCatalogEntry[] }>("/api/direct-topup/catalog").then(r => r.products);

export const fetchCodaProducts = () =>
  apiFetch<{ products: import("./types").CodaProductEntry[] }>("/api/direct-topup/products").then(r => r.products);

export const fetchCodaProductSkus = (apiPath: string) =>
  apiFetch<{ skus: import("./types").CodaSkuEntry[] }>(`/api/direct-topup/products${apiPath}/skus`).then(r => r.skus);

// Hankgames: categorías (≈ juegos) y sus productos (≈ SKUs), mismo formato que Coda.
export const fetchHankgamesCategories = () =>
  apiFetch<{ categories: import("./types").HankgamesCategoryEntry[] }>("/api/direct-topup/hankgames/categories").then(r => r.categories);

export const fetchHankgamesCategoryProducts = (categoryId: string) =>
  apiFetch<{ products: import("./types").CodaSkuEntry[] }>(`/api/direct-topup/hankgames/categories/${encodeURIComponent(categoryId)}/products`).then(r => r.products);

// Visoria: se busca el juego por nombre y luego se listan sus productos de recarga.
export const fetchVisoriaGames = (q: string) =>
  apiFetch<{ games: import("./types").VisoriaGameEntry[] }>(`/api/direct-topup/visoria/games?q=${encodeURIComponent(q)}`).then(r => r.games);

export const fetchVisoriaGameProducts = (name: string) =>
  apiFetch<{ products: import("./types").VisoriaSkuEntry[] }>(`/api/direct-topup/visoria/games/products?name=${encodeURIComponent(name)}`).then(r => r.products);

// Variantes: un producto puede tener varias denominaciones, cada una
// mapeada a su propio SKU de Coda.
export const fetchDirectTopupVariants = (productId: number) =>
  apiFetch<import("./types").DirectTopupVariant[]>(`/api/direct-topup/${productId}/variants`);

export const apiAddDirectTopupVariant = (productId: number, body: {
  coda_sku: string; coda_api_path: string; subtype: number; have_role: boolean;
  title?: string | null; variant_label?: string | null; cost_price?: number | null; cost_currency?: string;
  provider?: import("./types").DirectTopupProvider; variant_key?: string | null; priority?: number; validates?: boolean;
}) =>
  authFetch(`${BASE}/api/direct-topup/${productId}/variants`, { method: "POST", body: JSON.stringify(body) }).then(parseOrThrow);

export const apiUpdateDirectTopupVariant = (productId: number, variantId: number, body: object) =>
  authFetch(`${BASE}/api/direct-topup/${productId}/variants/${variantId}`, { method: "PATCH", body: JSON.stringify(body) }).then(parseOrThrow);

export const apiDeleteDirectTopupVariant = (productId: number, variantId: number) =>
  authFetch(`${BASE}/api/direct-topup/${productId}/variants/${variantId}`, { method: "DELETE" }).then(parseOrThrow);

export const apiSyncDirectTopupVariantPrice = (productId: number, variantId: number) =>
  authFetch(`${BASE}/api/direct-topup/${productId}/variants/${variantId}/sync-price`, { method: "POST" }).then(parseOrThrow);

// Códigos de canje: lotes por variante; se venden como pines y se canjean en la página pública.
export const fetchRedeemBatches = (productId: number) =>
  apiFetch<{ batches: import("./types").RedeemBatch[] }>(`/api/direct-topup/${productId}/redeem/batches`).then(r => r.batches);

export const apiCreateRedeemBatch = (productId: number, body: { supplier_id: number; quantity: number; prefix: string | null }) =>
  authFetch(`${BASE}/api/direct-topup/${productId}/redeem/batches`, { method: "POST", body: JSON.stringify(body) })
    .then(r => parseOrThrow<import("./types").RedeemBatch>(r));

export const fetchRedeemCodes = (productId: number, params: { status?: string; q?: string; batchId?: string; page: number; pageSize: number }) => {
  const q = new URLSearchParams({ page: String(params.page), page_size: String(params.pageSize) });
  if (params.status) q.set("status", params.status);
  if (params.q) q.set("q", params.q);
  if (params.batchId) q.set("batch_id", params.batchId);
  return apiFetch<{ codes: import("./types").RedeemCode[]; page: number; page_size: number; total: number }>(
    `/api/direct-topup/${productId}/redeem/codes?${q}`);
};

export const apiRedeemCodeAction = (productId: number, codeId: number, action: "void" | "mark-redeemed" | "release", note: string | null) =>
  authFetch(`${BASE}/api/direct-topup/${productId}/redeem/codes/${codeId}/${action}`, { method: "POST", body: JSON.stringify({ note }) })
    .then(r => parseOrThrow<import("./types").RedeemCode>(r));

// Canales: cuelgan de una variante puntual, no del producto entero.
export const fetchDirectTopupChannels = (productId: number, variantId: number) =>
  apiFetch<import("./types").DirectTopupChannel[]>(`/api/direct-topup/${productId}/variants/${variantId}/channels`);

export const apiAddDirectTopupChannel = (productId: number, variantId: number, body: {
  channel?: string; sell_price?: number | null; sell_currency?: string; is_active?: boolean;
  custom_product_id?: string | null; custom_title?: string | null;
}) =>
  authFetch(`${BASE}/api/direct-topup/${productId}/variants/${variantId}/channels`, { method: "POST", body: JSON.stringify(body) }).then(parseOrThrow);

export const apiUpdateDirectTopupChannel = (productId: number, variantId: number, channelId: number, body: object) =>
  authFetch(`${BASE}/api/direct-topup/${productId}/variants/${variantId}/channels/${channelId}`, { method: "PATCH", body: JSON.stringify(body) }).then(parseOrThrow);

export const apiDeleteDirectTopupChannel = (productId: number, variantId: number, channelId: number) =>
  authFetch(`${BASE}/api/direct-topup/${productId}/variants/${variantId}/channels/${channelId}`, { method: "DELETE" }).then(parseOrThrow);

export const fetchDirectTopupHistory = (productId: number) =>
  apiFetch<import("./types").GamingRecharge[]>(`/api/direct-topup/${productId}/history`);

// Consumidores de recarga directa configurados (Yape, paginas propias,
// etc) - misma lista que la card de API keys en Configuracion. Se usa
// para poblar el selector de "Activar canal" en vez de tener "yape"
// hardcodeado como unica opcion posible.
export const fetchGatewayApiKeys = () =>
  apiFetch<{ channel: string; is_active: boolean }[]>("/admin/gateway-api-keys");

export const fetchProductInventory = (productId: number) =>
  apiFetch<{ summary: Record<string, number>; codes: import("./types").InventoryCode[] }>(
    `/api/products/${productId}/inventory`
  );

export const apiRenameProduct = (productId: number, name: string) =>
  authFetch(`${BASE}/api/products/${productId}`, { method: "PATCH", body: JSON.stringify({ name }) }).then(parseOrThrow);

export const apiUpdateProductAliases = (productId: number, aliases: string[]) =>
  authFetch(`${BASE}/api/products/${productId}`, { method: "PATCH", body: JSON.stringify({ aliases }) }).then(parseOrThrow);
export const apiAddChannel = (productId: number, body: object) =>
  authFetch(`${BASE}/api/products/${productId}/channels`, { method: "POST", body: JSON.stringify(body) }).then(parseOrThrow);

export const apiUpdateChannel = (productId: number, channelId: number, body: object) =>
  authFetch(`${BASE}/api/products/${productId}/channels/${channelId}`, { method: "PATCH", body: JSON.stringify(body) }).then(parseOrThrow);

// Reordena proveedores por precio (los que tengan priority_locked se mantienen fijos).
export const apiResortSuppliers = (productId: number) =>
  authFetch(`${BASE}/api/products/${productId}/suppliers/resort`, { method: "POST" }).then(parseOrThrow);

// Esta sí, a propósito, no parsea el body: el endpoint de borrado de canal
// no devuelve contenido (204), y el original tampoco intentaba leerlo —
// solo necesitamos saber si falló.
export const apiDeleteChannel = async (productId: number, channelId: number) => {
  const res = await authFetch(`${BASE}/api/products/${productId}/channels/${channelId}`, { method: "DELETE" });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `Error ${res.status}`);
  }
  return res;
};

export const apiManualPurchase = async (productId: number, quantity: number): Promise<{ message?: string; inserted: number }> => {
  const res = await authFetch(`${BASE}/api/inventory/${productId}/manual-purchase`, {
    method: "POST",
    body: JSON.stringify({ quantity }),
  });
  return parseOrThrow(res);
};

export const apiUploadCodes = (
  productId: number,
  rawText: string,
  providerId: number | null,
  costPrice: number | null,
  providerNote: string | null = null,
) =>
  authFetch(`${BASE}/api/inventory/${productId}/upload`, {
    method: "POST",
    body: JSON.stringify({
      raw_text: rawText,
      provider_id: providerId,
      cost_price: costPrice,
      provider_note: providerNote,
    }),
  }).then((res) => parseOrThrow<{ inserted: number; duplicates_count: number }>(res));

export const fetchProvidersList = (): Promise<{ id: number; name: string; code: string }[]> =>
  authFetch(`${BASE}/api/catalog/providers`).then((res) =>
    parseOrThrow<{ id: number; name: string; code: string }[]>(res)
  );

export const apiCreateProduct = (body: object) =>
  authFetch(`${BASE}/api/products`, { method: "POST", body: JSON.stringify(body) }).then(parseOrThrow);

export const apiDeleteProduct = (productId: number) =>
  authFetch(`${BASE}/api/products/${productId}`, { method: "DELETE" }).then(parseOrThrow);