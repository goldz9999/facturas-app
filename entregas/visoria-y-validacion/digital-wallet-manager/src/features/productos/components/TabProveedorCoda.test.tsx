// UBICACIÓN EN TU REPO: digital-wallet-manager/src/features/productos/components/TabProveedorCoda.test.tsx
// (repositorio: digital-wallet-manager · ruta: src/features/productos/components/TabProveedorCoda.test.tsx)
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TabProveedorCoda } from "./TabProveedorCoda";
import * as api from "../api";
import type { DirectTopupVariant, Product } from "../types";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const product = { id: 7, name: "Mobile Legends" } as unknown as Product;

const variant = (over: Partial<DirectTopupVariant>): DirectTopupVariant => ({
  id: 1, product_id: 7, provider: "coda", variant_key: null, priority: 1, coda_sku: "sku1", coda_api_path: "ml",
  subtype: 3, have_role: false, title: "ML 86", variant_label: "86 Diamantes", cost_price: 1.5, cost_currency: "USD",
  is_active: true, ...over,
});

function renderTab() {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TabProveedorCoda product={product} />
    </QueryClientProvider>,
  );
}

describe("TabProveedorCoda · Visoria y validación", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "fetchCodaProducts").mockResolvedValue([]);
    vi.spyOn(api, "apiAddDirectTopupVariant").mockResolvedValue({} as never);
    vi.spyOn(api, "apiUpdateDirectTopupVariant").mockResolvedValue({} as never);
  });

  it("agrega un producto de Visoria como solo recarga, con los datos sugeridos", async () => {
    vi.spyOn(api, "fetchDirectTopupVariants").mockResolvedValue([variant({})]);
    const games = vi.spyOn(api, "fetchVisoriaGames").mockResolvedValue([{ name: "Mobile Legends", categoryId: "c1", count: 2 }]);
    vi.spyOn(api, "fetchVisoriaGameProducts").mockResolvedValue([
      { sku: "p-ml-86", title: "Mobile Legends 86 Diamonds", priceAmount: 1.32, priceCurrency: "USD", stock: true, subtype: 3 },
    ]);
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: /agregar variante/i }));
    fireEvent.click(screen.getByRole("button", { name: "Visoria" }));
    fireEvent.change(screen.getByPlaceholderText(/busca el juego en visoria/i), { target: { value: "mobile" } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(games).toHaveBeenCalledWith("mobile"));
    fireEvent.click(await screen.findByText("Mobile Legends", { selector: "p" }));
    fireEvent.click(await screen.findByText("Mobile Legends 86 Diamonds"));
    expect(screen.getByText(/visoria no valida cuentas/i)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "v1" } });
    fireEvent.click(screen.getByRole("button", { name: /^guardar$/i }));
    await waitFor(() => expect(api.apiAddDirectTopupVariant).toHaveBeenCalled());
    expect(vi.mocked(api.apiAddDirectTopupVariant).mock.calls[0][1]).toMatchObject({
      provider: "visoria", coda_sku: "p-ml-86", coda_api_path: "Mobile Legends", subtype: 3,
      cost_price: 1.32, validates: false, variant_key: "g1", priority: 2,
    });
  });

  it("muestra quién valida y quién solo recarga, y avisa si nadie valida", async () => {
    vi.spyOn(api, "fetchDirectTopupVariants").mockResolvedValue([
      variant({ id: 1, variant_key: "g1", validates: false }),
      variant({ id: 2, provider: "visoria", variant_key: "g1", priority: 2, coda_sku: "p-ml-86" }),
    ]);
    renderTab();
    expect(await screen.findAllByText("Solo recarga")).toHaveLength(2);
    expect(screen.getByText(/ninguna variante de este grupo valida/i)).toBeTruthy();
  });

  it("al editar una variante de Coda se puede apagar 'Usar para validar'", async () => {
    vi.spyOn(api, "fetchDirectTopupVariants").mockResolvedValue([variant({})]);
    renderTab();
    fireEvent.click(await screen.findByTitle(/renombrar o cambiar respaldo/i));
    fireEvent.click(screen.getByRole("switch", { name: /usar para validar/i }));
    fireEvent.click(screen.getByRole("button", { name: /^guardar$/i }));
    await waitFor(() => expect(api.apiUpdateDirectTopupVariant).toHaveBeenCalled());
    expect(vi.mocked(api.apiUpdateDirectTopupVariant).mock.calls[0][2]).toMatchObject({ validates: false });
  });
});
