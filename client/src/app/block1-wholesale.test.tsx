import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OperationsPage from "./page";

// Block 1: seller wholesale activation and cashier wholesale confirmation.
// The page only relays the code and renders server state; the backend is
// the sole authority for prices, activation and confirmation.

const TOKEN_KEY = "mona-jacinta-token";
const CODE = "Mayor-2026";

type Call = { url: string; method: string; body: unknown };

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const seller = { id: "s1", name: "Vendedor", email: "seller@demo.local", roles: ["SELLER"], branchIds: ["CEN"], permissions: [] };
const cashier = { id: "c1", name: "Cajero", email: "cashier@demo.local", roles: ["CASHIER"], branchIds: ["CEN"], permissions: [] };

function sale(overrides: Record<string, unknown> = {}) {
  return {
    id: "sale-1", branchId: "CEN", saleNumber: null, status: "DRAFT", subtotal: "2000000", discountTotal: "0", total: "2000000",
    pricingMode: "LIST",
    items: [{
      id: "item-1", variantId: "v1", productName: "Remera", variantName: "Negro / M", sku: "REM-M",
      quantity: "2", unitPrice: "1000000", subtotal: "2000000",
    }],
    ...overrides,
  };
}

const wholesaleSale = () => sale({
  pricingMode: "WHOLESALE", subtotal: "1400000", total: "1400000",
  items: [{
    id: "item-1", variantId: "v1", productName: "Remera", variantName: "Negro / M", sku: "REM-M",
    quantity: "2", unitPrice: "700000", subtotal: "1400000",
  }],
});

function sellerRouter(calls: Call[], activation: () => Response) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/auth/me")) return jsonResponse({ user: seller });
    if (url.endsWith("/wholesale") && method === "POST") return activation();
    if (url.endsWith("/sales") && method === "POST") return jsonResponse(sale(), 201);
    return jsonResponse({ items: [] });
  });
}

async function renderSellerWithDraft(calls: Call[], activation: () => Response) {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", sellerRouter(calls, activation));
  render(<OperationsPage />);
  fireEvent.click(await screen.findByRole("button", { name: "Abrir venta" }));
  await screen.findByText(/Venta en borrador/);
}

type QueueRow = Record<string, unknown>;

function queueRow(overrides: QueueRow = {}): QueueRow {
  return {
    saleId: "sale-1", saleNumber: "CEN-V-000001", sellerName: "Vendedor", status: "PENDING_PAYMENT",
    items: [{
      id: "item-1", variantId: "v1", productName: "Remera", variantName: "Negro / M", sku: "REM-M",
      quantity: "2", unitPrice: "700000", subtotal: "1400000",
    }],
    subtotal: "1400000", total: "1400000", paidAmount: "0", remainingBalance: "1400000",
    holdState: "VALID", canAcceptPayment: false, paymentCount: 0, canCorrect: true, canCancel: true,
    pricingMode: "WHOLESALE", wholesaleConfirmed: false, canConfirmWholesale: true,
    ...overrides,
  };
}

function cashierRouter(state: { queue: QueueRow[] }, calls: Call[]) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/auth/me")) return jsonResponse({ user: cashier });
    if (url.includes("/sales/pending")) return jsonResponse({ items: state.queue });
    if (url.endsWith("/wholesale/confirm") && method === "POST") {
      state.queue = state.queue.map((row) => ({ ...row, wholesaleConfirmed: true, canConfirmWholesale: false, canAcceptPayment: true }));
      return jsonResponse({ saleId: "sale-1", pricingMode: "WHOLESALE", replayed: false });
    }
    if (url.includes("/payments")) return jsonResponse({ items: [] });
    if (url.includes("/cash/current")) {
      return jsonResponse({
        sessionId: "cs-1", registerId: "reg-1", branchId: "CEN", openedById: "c1", closedById: null,
        startingCash: "0", status: "OPEN", openedAt: "2030-01-01T00:00:00.000Z", closedAt: null,
      });
    }
    if (url.includes("/cash/register")) return jsonResponse({ id: "reg-1", branchId: "CEN", name: "Caja principal" });
    return jsonResponse({ items: [] });
  });
}

async function renderCashier(state: { queue: QueueRow[] }, calls: Call[]) {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", cashierRouter(state, calls));
  render(<OperationsPage />);
  await screen.findByRole("heading", { name: "CEN-V-000001" });
}

const payButton = () => screen.getByRole("button", { name: /Registrar pago/ });

describe("Block 1 wholesale UI", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("seller activates wholesale for the current sale with a code; prices come from the server", async () => {
    const calls: Call[] = [];
    await renderSellerWithDraft(calls, () => jsonResponse(wholesaleSale()));
    expect(screen.queryByText("Venta mayorista activa")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mayorista" }));
    const input = screen.getByLabelText("Código mayorista");
    expect(input).toHaveAttribute("type", "password");
    expect(input).toHaveAttribute("autocomplete", "off");
    fireEvent.change(input, { target: { value: CODE } });
    fireEvent.click(screen.getByRole("button", { name: "Activar mayorista" }));
    expect(await screen.findByText("Venta mayorista activa")).toBeInTheDocument();
    const activation = calls.find((call) => call.url.endsWith("/sales/sale-1/wholesale"))!;
    expect(activation).toMatchObject({ method: "POST", body: { code: CODE } });
    // The code is not kept anywhere in the rendered page after submission.
    expect(screen.queryByLabelText("Código mayorista")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(CODE);
    // The cart shows the server's repriced snapshot, not a client computation.
    expect(screen.getAllByText(/7\.000/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Mayorista" })).not.toBeInTheDocument();
  });

  it("seller sees the server rejection and the code is cleared", async () => {
    const calls: Call[] = [];
    await renderSellerWithDraft(calls, () => jsonResponse({ error: { code: "WHOLESALE_CODE_INVALID", message: "El código mayorista no es válido." } }, 403));
    fireEvent.click(screen.getByRole("button", { name: "Mayorista" }));
    fireEvent.change(screen.getByLabelText("Código mayorista"), { target: { value: "wrong-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Activar mayorista" }));
    expect(await screen.findByText("El código mayorista no es válido.")).toBeInTheDocument();
    expect(screen.getByLabelText("Código mayorista")).toHaveValue("");
    expect(screen.queryByText("Venta mayorista activa")).not.toBeInTheDocument();
  });

  it("cashier must confirm a wholesale sale before payment is offered", async () => {
    const calls: Call[] = [];
    const state = { queue: [queueRow()] };
    await renderCashier(state, calls);
    expect(screen.getAllByText("Mayorista").length).toBeGreaterThan(0);
    expect(screen.getByText(/Caja debe confirmar la venta mayorista/)).toBeInTheDocument();
    await waitFor(() => expect(payButton()).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Confirmar venta mayorista" }));
    await waitFor(() => expect(screen.getByText("Mayorista confirmada")).toBeInTheDocument());
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/sales/sale-1/wholesale/confirm"))).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    await waitFor(() => expect(payButton()).toBeEnabled());
  });

  it("cashier without confirmation eligibility gets no confirm action", async () => {
    await renderCashier({ queue: [queueRow({ canConfirmWholesale: false })] }, []);
    expect(screen.queryByRole("button", { name: "Confirmar venta mayorista" })).not.toBeInTheDocument();
    expect(screen.getByText(/No podés confirmar esta venta mayorista/)).toBeInTheDocument();
    await waitFor(() => expect(payButton()).toBeDisabled());
  });

  it("an ordinary LIST sale shows no wholesale controls", async () => {
    await renderCashier({
      queue: [queueRow({ pricingMode: "LIST", canConfirmWholesale: false, canAcceptPayment: true, items: [] })],
    }, []);
    expect(screen.queryByText("Mayorista")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Confirmar venta mayorista" })).not.toBeInTheDocument();
  });
});
