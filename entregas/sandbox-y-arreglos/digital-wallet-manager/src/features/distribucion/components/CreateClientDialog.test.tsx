import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CreateClientDialog } from "./CreateClientDialog";
import * as api from "../api";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderDialog() {
  const onCreated = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CreateClientDialog open onOpenChange={() => {}} onCreated={onCreated} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByPlaceholderText("tisi"), { target: { value: "tisi_test" } });
  fireEvent.change(screen.getByPlaceholderText("TISI SAC"), { target: { value: "TISI (prueba)" } });
  return onCreated;
}

describe("CreateClientDialog · cliente de prueba", () => {
  beforeEach(() => {
    vi.spyOn(api, "createClient").mockResolvedValue({
      client: { id: 1, sandbox: true } as never,
      credentials: { client_id: "c", client_secret: "s" },
    });
  });

  it("por defecto crea un cliente real", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /crear cliente/i }));
    await waitFor(() => expect(api.createClient).toHaveBeenCalled());
    expect(vi.mocked(api.createClient).mock.calls[0][0].sandbox).toBe(false);
  });

  it("con el interruptor activado envía sandbox: true", async () => {
    const onCreated = renderDialog();
    fireEvent.click(screen.getByRole("switch", { name: /cliente de prueba/i }));
    fireEvent.click(screen.getByRole("button", { name: /crear cliente/i }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(vi.mocked(api.createClient).mock.calls[0][0]).toMatchObject({ code: "tisi_test", sandbox: true });
  });
});
