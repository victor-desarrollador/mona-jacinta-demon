import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import OperationsPage from "./page";

// System V2 P0-A: the traditional (FIXED_TOTAL) payment panel takes CASH only.
// Every non-cash method is charged through the proportional checkout, so the
// "Método" select of the traditional panel offers a single enabled option.

const TOKEN_KEY = "mona-jacinta-token";
const cashier = {
  id: "c1", name: "Cajero", email: "cashier@demo.local", roles: ["CASHIER"], branchIds: ["CEN"],
  permissions: ["sale.charge", "cash.session.open", "cash.session.close"],
  cashMovementLocationIds: [], cashSupervisorLocationIds: [],
};
const openSession = {
  sessionId: "cs-1", registerId: "reg-1", branchId: "CEN", openedById: "c1", closedById: null,
  startingCash: "0", status: "OPEN", openedAt: "2030-01-01T09:00:00.000Z", closedAt: null,
  expectedCash: null, countedCash: null, difference: null,
};

type Row = Record<string, unknown>;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function row(overrides: Row = {}): Row {
  return {
    saleId: "sale-1", saleNumber: "CEN-V-000001", sellerName: "Vendedor", status: "PENDING_PAYMENT",
    items: [{ id: "i1", variantId: "v1", productName: "Remera", variantName: "Negro / M", sku: "R-1", quantity: "1", unitPrice: "120000", subtotal: "120000" }],
    subtotal: "120000", total: "120000", paidAmount: "0", remainingBalance: "120000",
    holdState: "VALID", canAcceptPayment: true, paymentCount: 0, canCorrect: false, canCancel: false,
    pricingMode: "LIST", priceMode: "LIST", wholesaleConfirmed: false, canConfirmWholesale: false,
    pricingModel: "FIXED_TOTAL", checkoutRequired: false,
    ...overrides,
  };
}

async function renderCashier(queue: Row[]) {
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/auth/me")) return jsonResponse({ user: cashier });
    if (url.includes("/sales/pending")) return jsonResponse({ items: queue });
    if (url.includes("/cash/current")) return jsonResponse(openSession);
    if (url.includes("/cash/register")) return jsonResponse({ id: "reg-1", branchId: "CEN", name: "Caja principal" });
    return jsonResponse({ items: [] });
  }));
  render(<OperationsPage />);
  await screen.findByRole("heading", { name: String(queue[0]?.saleNumber) });
}

const optionOf = (value: string) => screen.getByRole("option", { name: new RegExp(`^${value}`) }) as HTMLOptionElement;

describe("traditional payment panel is cash-only (System V2 P0-A)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("CO1 a FIXED_TOTAL sale starts on Efectivo with the non-cash methods disabled", async () => {
    await renderCashier([row()]);
    const select = screen.getByRole("combobox", { name: /Método/ }) as HTMLSelectElement;
    expect(select.value).toBe("CASH");
    expect(optionOf("Efectivo").disabled).toBe(false);
    for (const label of ["Transferencia", "Tarjeta de débito", "Tarjeta de crédito", "QR"]) {
      expect(optionOf(label).disabled, label).toBe(true);
    }
    expect(screen.queryByText(/solo admite efectivo/)).toBeNull();
  });

  it("CO2 a non-cash price mode explains that the traditional payment takes cash only", async () => {
    await renderCashier([row({ priceMode: "BANK_TRANSFER" })]);
    const notice = screen.getByText(/solo admite efectivo/);
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/checkout proporcional/);
  });

  it("CO3 a LIST or CASH price mode shows no warning", async () => {
    await renderCashier([row({ priceMode: "CASH" })]);
    expect(screen.queryByText(/solo admite efectivo/)).toBeNull();
  });

  it("CO4 a PROPORTIONAL_V1 sale never renders the traditional method select", async () => {
    await renderCashier([row({ pricingModel: "PROPORTIONAL_V1", checkoutRequired: true, priceMode: "CASH" })]);
    expect(screen.queryByRole("combobox", { name: /^Método$/ })).toBeNull();
  });
});
