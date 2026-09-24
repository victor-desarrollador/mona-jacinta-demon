import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import OperationsPage from "./page";

const TOKEN_KEY = "mona-jacinta-token";

type QueueRow = {
  saleId: string;
  saleNumber: string;
  sellerName: string;
  status: "PENDING_PAYMENT" | "PAID";
  items: unknown[];
  subtotal: string;
  total: string;
  paidAmount: string;
  remainingBalance: string;
  holdState: "VALID" | "EXPIRED" | "PAYMENT_PROTECTED" | "PAID" | "COVERAGE_INVALID";
  canAcceptPayment: boolean;
};

type Payment = {
  id: string;
  saleId: string;
  method: "TRANSFER" | "CASH";
  amount: string;
  receivedAmount: string | null;
  changeAmount: string | null;
  cashSessionId: string | null;
  idempotencyKey: string;
  paidAt: string;
};

const cashier = {
  id: "u1",
  name: "Cajero",
  email: "cashier@demo.local",
  roles: ["CASHIER"],
  branchIds: ["CEN"],
  permissions: ["sale.charge"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    saleId: "sale-1",
    saleNumber: "CEN-V-000001",
    sellerName: "Vendedor",
    status: "PENDING_PAYMENT",
    items: [],
    subtotal: "1000000",
    total: "1000000",
    paidAmount: "0",
    remainingBalance: "1000000",
    holdState: "VALID",
    canAcceptPayment: true,
    ...overrides,
  };
}

function payment(amount: string): Payment {
  return {
    id: `pay-${amount}`,
    saleId: "sale-1",
    method: "TRANSFER",
    amount,
    receivedAmount: null,
    changeAmount: null,
    cashSessionId: null,
    idempotencyKey: `key-${amount}`,
    paidAt: "2030-01-01T00:00:00.000Z",
  };
}

// Pilot P0.1-C: minimal fetch router for the cashier workspace. The queue
// and payments are mutable so a test can model the server after a payment.
function createCashierRouter(state: { queue: QueueRow[]; payments: Payment[] }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/auth/me")) return jsonResponse({ user: cashier });
    if (url.includes("/sales/pending")) return jsonResponse({ items: state.queue });
    if (url.includes("/payments") && method === "POST") {
      const created = payment(JSON.parse(String(init?.body)).amount);
      state.payments = [...state.payments, created];
      state.queue = state.queue.map((sale) => ({
        ...sale, status: "PAID", holdState: "PAID", canAcceptPayment: false, paidAmount: sale.total, remainingBalance: "0",
      }));
      return jsonResponse(created, 201);
    }
    if (url.includes("/payments")) return jsonResponse({ items: state.payments });
    if (url.includes("/cash/current")) {
      return jsonResponse({
        sessionId: "cs-1", registerId: "reg-1", branchId: "CEN", openedById: "u1", closedById: null,
        startingCash: "0", status: "OPEN", openedAt: "2030-01-01T00:00:00.000Z", closedAt: null,
      });
    }
    if (url.includes("/cash/register")) return jsonResponse({ id: "reg-1", branchId: "CEN", name: "Caja principal" });
    return jsonResponse({ items: [] });
  });
}

async function renderCashier(state: { queue: QueueRow[]; payments: Payment[] }) {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", createCashierRouter(state));
  render(<OperationsPage />);
  expect(await screen.findByText("Ventas pendientes")).toBeInTheDocument();
  await screen.findByRole("heading", { name: "CEN-V-000001" });
}

const payButton = () => screen.getByRole("button", { name: /Registrar pago/ });
const completeButton = () => screen.getByRole("button", { name: /Finalizar venta/ });

describe("cashier queue hold states (Pilot P0.1-C)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps an EXPIRED zero-payment sale visible but offers no payment action", async () => {
    await renderCashier({ queue: [row({ holdState: "EXPIRED", canAcceptPayment: false })], payments: [] });
    await waitFor(() => expect(payButton()).toBeDisabled());
    expect(completeButton()).toBeDisabled();
    expect(screen.getByText(/reserva técnica venció/i)).toBeInTheDocument();
  });

  it("lets a PAYMENT_PROTECTED sale pay its remaining balance", async () => {
    await renderCashier({
      queue: [row({ holdState: "PAYMENT_PROTECTED", paidAmount: "400000", remainingBalance: "600000" })],
      payments: [payment("400000")],
    });
    await waitFor(() => expect(payButton()).toBeEnabled());
    expect(completeButton()).toBeDisabled();
  });

  it("offers completion, not another payment, for a PAID sale", async () => {
    await renderCashier({
      queue: [row({ status: "PAID", holdState: "PAID", canAcceptPayment: false, paidAmount: "1000000", remainingBalance: "0" })],
      payments: [payment("1000000")],
    });
    await waitFor(() => expect(completeButton()).toBeEnabled());
    expect(payButton()).toBeDisabled();
  });

  it("keeps the sale selected and completable after the final payment makes it PAID", async () => {
    const state = { queue: [row()], payments: [] as Payment[] };
    await renderCashier(state);
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    await waitFor(() => expect(payButton()).toBeEnabled());
    fireEvent.click(payButton());
    await waitFor(() => expect(completeButton()).toBeEnabled());
    expect(screen.getByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    expect(payButton()).toBeDisabled();
  });
});
