import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";

// Pilot P0.2-C: cashier correction / cancellation / payment UX. The server
// stays authoritative: eligibility comes from the queue row flags, totals and
// remaining balance come from the server, and nothing is shown as committed
// before the server answers.

const TOKEN_KEY = "mona-jacinta-token";

type Item = {
  id: string; variantId: string; productName: string; variantName: string; sku: string;
  quantity: string; unitPrice: string; subtotal: string;
};

type QueueRow = {
  saleId: string; saleNumber: string; sellerName: string; status: "PENDING_PAYMENT" | "PAID";
  items: Item[]; subtotal: string; total: string; paidAmount: string; remainingBalance: string;
  holdState: "VALID" | "EXPIRED" | "PAYMENT_PROTECTED" | "PAID" | "COVERAGE_INVALID";
  canAcceptPayment: boolean; paymentCount: number; canCorrect: boolean; canCancel: boolean;
};

type Payment = {
  id: string; saleId: string; method: "TRANSFER" | "CASH"; amount: string; receivedAmount: string | null;
  changeAmount: string | null; cashSessionId: string | null; idempotencyKey: string; paidAt: string;
};

type ServerState = {
  queue: QueueRow[];
  payments: Payment[];
  fail?: { correct?: string; cancel?: string; payment?: string };
  requests: Array<{ url: string; method: string; body: unknown }>;
};

const cashier = {
  id: "u1", name: "Cajero", email: "cashier@demo.local", roles: ["CASHIER"], branchIds: ["CEN"], permissions: ["sale.charge"],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1", variantId: "variant-1", productName: "Remera", variantName: "Negro / M", sku: "REM-NEG-M",
    quantity: "2", unitPrice: "500000", subtotal: "1000000", ...overrides,
  };
}

function row(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    saleId: "sale-1", saleNumber: "CEN-V-000001", sellerName: "Vendedor", status: "PENDING_PAYMENT",
    items: [item()], subtotal: "1000000", total: "1000000", paidAmount: "0", remainingBalance: "1000000",
    holdState: "VALID", canAcceptPayment: true, paymentCount: 0, canCorrect: true, canCancel: true,
    ...overrides,
  };
}

function payment(amount: string): Payment {
  return {
    id: `pay-${amount}`, saleId: "sale-1", method: "TRANSFER", amount, receivedAmount: null, changeAmount: null,
    cashSessionId: null, idempotencyKey: `key-${amount}`, paidAt: "2030-01-01T00:00:00.000Z",
  };
}

// Minimal fetch router modelling the server: mutations change `state` only
// when they succeed, exactly like a committed transaction.
function createRouter(state: ServerState) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (method !== "GET") state.requests.push({ url, method, body });
    if (url.includes("/auth/me")) return jsonResponse({ user: cashier });
    if (url.includes("/sales/pending")) return jsonResponse({ items: state.queue });
    if (url.endsWith("/correct") && method === "POST") {
      if (state.fail?.correct) return jsonResponse({ error: { code: "X", message: state.fail.correct } }, 409);
      const items = (body.items as Array<{ variantId: string; quantity: string }>).map((line) => {
        const subtotal = (BigInt(line.quantity) * BigInt(500000)).toString();
        return item({ quantity: line.quantity, subtotal, variantId: line.variantId });
      });
      const total = items.reduce((sum, line) => sum + BigInt(line.subtotal), BigInt(0)).toString();
      state.queue = state.queue.map((sale) => ({ ...sale, items, subtotal: total, total, remainingBalance: total }));
      return jsonResponse({ saleId: "sale-1", status: "PENDING_PAYMENT", total, items });
    }
    if (url.endsWith("/cancel") && method === "POST") {
      if (state.fail?.cancel) return jsonResponse({ error: { code: "X", message: state.fail.cancel } }, 409);
      state.queue = state.queue.filter((sale) => !url.includes(sale.saleId));
      return jsonResponse({ saleId: "sale-1", status: "CANCELLED", released: [] });
    }
    if (url.includes("/payments") && method === "POST") {
      if (state.fail?.payment) return jsonResponse({ error: { code: "OVERPAYMENT", message: state.fail.payment } }, 409);
      const created = payment(body.amount);
      state.payments = [...state.payments, created];
      state.queue = state.queue.map((sale) => {
        const paid = BigInt(sale.paidAmount) + BigInt(body.amount);
        const remaining = BigInt(sale.total) - paid;
        return {
          ...sale, paidAmount: paid.toString(), remainingBalance: remaining.toString(), paymentCount: sale.paymentCount + 1,
          canCorrect: false, canCancel: false,
          ...(remaining === BigInt(0)
            ? { status: "PAID" as const, holdState: "PAID" as const, canAcceptPayment: false }
            : { holdState: "PAYMENT_PROTECTED" as const }),
        };
      });
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

async function renderCashier(partial: Partial<ServerState> & { queue: QueueRow[] }) {
  const state: ServerState = { payments: [], requests: [], ...partial };
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", createRouter(state));
  render(<OperationsPage />);
  expect(await screen.findByText("Ventas pendientes")).toBeInTheDocument();
  await screen.findByRole("heading", { name: "CEN-V-000001" });
  return state;
}

const button = (name: RegExp) => screen.queryByRole("button", { name });
const amountInput = () => screen.getByRole("textbox", { name: /Importe ARS/ });
const remainingCard = () => screen.getByText("Saldo pendiente").parentElement as HTMLElement;
const posted = (state: ServerState, suffix: string) => state.requests.filter((request) => request.url.endsWith(suffix));

describe("cashier correction (Pilot P0.2-C)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("offers correction only when the server marks the sale correctable", async () => {
    await renderCashier({ queue: [row()] });
    expect(button(/Corregir venta/)).toBeEnabled();
  });

  it("offers no correction or cancellation once the sale has payments", async () => {
    await renderCashier({
      queue: [row({ holdState: "PAYMENT_PROTECTED", paymentCount: 1, paidAmount: "400000", remainingBalance: "600000", canCorrect: false, canCancel: false })],
      payments: [payment("400000")],
    });
    expect(button(/Corregir venta/)).toBeNull();
    expect(button(/Cancelar venta/)).toBeNull();
    expect(screen.getByText(/tiene pagos registrados: no admite corrección ni cancelación/i)).toBeInTheDocument();
  });

  it("offers no correction on a PAID sale", async () => {
    await renderCashier({
      queue: [row({ status: "PAID", holdState: "PAID", canAcceptPayment: false, paymentCount: 1, paidAmount: "1000000", remainingBalance: "0", canCorrect: false, canCancel: false })],
      payments: [payment("1000000")],
    });
    expect(button(/Corregir venta/)).toBeNull();
  });

  it("sends the corrected item list and shows the server's refreshed sale", async () => {
    const state = await renderCashier({ queue: [row()] });
    fireEvent.click(button(/Corregir venta/)!);
    fireEvent.change(screen.getByRole("spinbutton", { name: /Cantidad Remera/ }), { target: { value: "1" } });
    fireEvent.click(button(/Guardar corrección/)!);
    await screen.findByText(/Venta corregida/i);
    expect(posted(state, "/sales/sale-1/correct")[0]!.body).toEqual({ items: [{ variantId: "variant-1", quantity: "1" }] });
    await waitFor(() => expect(within(remainingCard()).getByText(/5\.000/)).toBeInTheDocument());
    expect(button(/Guardar corrección/)).toBeNull();
  });

  it("resets the CASH tender to the new server balance after a same-sale correction", async () => {
    // Codex P0.2 LOW #1: the sale id does not change on correction, so the
    // tender must be re-derived from the refreshed server balance; otherwise
    // the next CASH payment would record a stale receivedAmount/change.
    const state = await renderCashier({ queue: [row()] });
    const received = () => screen.getByRole("textbox", { name: /Recibido ARS/ });
    await waitFor(() => expect(received()).toHaveValue("10000"));
    expect(amountInput()).toHaveValue("10000");

    fireEvent.click(button(/Corregir venta/)!);
    fireEvent.change(screen.getByRole("spinbutton", { name: /Cantidad Remera/ }), { target: { value: "1" } });
    fireEvent.click(button(/Guardar corrección/)!);
    await screen.findByText(/Venta corregida/i);
    await waitFor(() => expect(within(remainingCard()).getByText(/5\.000/)).toBeInTheDocument());

    expect(screen.getByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
    expect(amountInput()).toHaveValue("5000");
    expect(received()).toHaveValue("5000");
    fireEvent.click(button(/Registrar pago/)!);
    await waitFor(() => expect(posted(state, "/payments")).toHaveLength(1));
    expect(posted(state, "/payments")[0]!.body).toMatchObject({ method: "CASH", amount: "500000", receivedAmount: "500000" });
  });

  it("removes a line by leaving it out of the corrected list", async () => {
    const state = await renderCashier({
      queue: [row({ items: [item(), item({ id: "item-2", variantId: "variant-2", productName: "Jean", sku: "JEA" })], total: "2000000", subtotal: "2000000", remainingBalance: "2000000" })],
    });
    fireEvent.click(button(/Corregir venta/)!);
    fireEvent.click(button(/Quitar Jean/)!);
    fireEvent.click(button(/Guardar corrección/)!);
    await screen.findByText(/Venta corregida/i);
    expect(posted(state, "/correct")[0]!.body).toEqual({ items: [{ variantId: "variant-1", quantity: "2" }] });
  });

  it("does not fake a correction the server rejected", async () => {
    const state = await renderCashier({ queue: [row()], fail: { correct: "No hay stock disponible suficiente para la variante." } });
    fireEvent.click(button(/Corregir venta/)!);
    fireEvent.change(screen.getByRole("spinbutton", { name: /Cantidad Remera/ }), { target: { value: "9" } });
    fireEvent.click(button(/Guardar corrección/)!);
    expect(await screen.findByText(/No hay stock disponible suficiente/)).toBeInTheDocument();
    expect(state.queue[0]!.items[0]!.quantity).toBe("2");
    expect(within(remainingCard()).getByText(/10\.000/)).toBeInTheDocument();
  });

  it("never submits an empty or invalid correction", async () => {
    const state = await renderCashier({ queue: [row()] });
    fireEvent.click(button(/Corregir venta/)!);
    fireEvent.click(button(/Quitar Remera/)!);
    expect(button(/Guardar corrección/)).toBeDisabled();
    expect(screen.getByText(/cancelá la venta/i)).toBeInTheDocument();
    fireEvent.click(button(/Descartar/)!);
    fireEvent.click(button(/Corregir venta/)!);
    fireEvent.change(screen.getByRole("spinbutton", { name: /Cantidad Remera/ }), { target: { value: "0" } });
    expect(button(/Guardar corrección/)).toBeDisabled();
    expect(posted(state, "/correct")).toHaveLength(0);
  });
});

describe("cashier cancellation (Pilot P0.2-C)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("requires a structured reason before cancelling, and a note for OTHER", async () => {
    const state = await renderCashier({ queue: [row()] });
    fireEvent.click(button(/Cancelar venta/)!);
    const confirm = () => button(/Confirmar cancelación/)!;
    expect(confirm()).toBeDisabled();
    const reason = screen.getByRole("combobox", { name: /Motivo/ });
    expect(within(reason).getAllByRole("option").map((option) => (option as HTMLOptionElement).value).filter(Boolean))
      .toEqual(["WRONG_ITEM", "WRONG_QUANTITY", "CUSTOMER_CHANGED_MIND", "DUPLICATE_SALE", "OTHER"]);
    fireEvent.change(reason, { target: { value: "OTHER" } });
    expect(confirm()).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /Nota/ }), { target: { value: "   " } });
    expect(confirm()).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /Nota/ }), { target: { value: "Cliente se retiró" } });
    expect(confirm()).toBeEnabled();
    expect(posted(state, "/cancel")).toHaveLength(0);
  });

  it("cancels through the server and removes the sale from the refreshed queue", async () => {
    const state = await renderCashier({ queue: [row()] });
    fireEvent.click(button(/Cancelar venta/)!);
    fireEvent.change(screen.getByRole("combobox", { name: /Motivo/ }), { target: { value: "DUPLICATE_SALE" } });
    fireEvent.click(button(/Confirmar cancelación/)!);
    await screen.findByText(/Venta cancelada/i);
    expect(posted(state, "/sales/sale-1/cancel")[0]!.body).toEqual({ reason: "DUPLICATE_SALE" });
    await waitFor(() => expect(screen.queryByRole("heading", { name: "CEN-V-000001" })).toBeNull());
  });

  it("keeps the sale when the server refuses the cancellation", async () => {
    await renderCashier({ queue: [row()], fail: { cancel: "La venta tiene pagos aceptados." } });
    fireEvent.click(button(/Cancelar venta/)!);
    fireEvent.change(screen.getByRole("combobox", { name: /Motivo/ }), { target: { value: "WRONG_ITEM" } });
    fireEvent.click(button(/Confirmar cancelación/)!);
    expect(await screen.findByText(/La venta tiene pagos aceptados/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "CEN-V-000001" })).toBeInTheDocument();
  });

  it("offers cancellation, not correction, for an EXPIRED zero-payment sale", async () => {
    await renderCashier({ queue: [row({ holdState: "EXPIRED", canAcceptPayment: false, canCorrect: false, canCancel: true })] });
    expect(button(/Corregir venta/)).toBeNull();
    expect(button(/Cancelar venta/)).toBeEnabled();
    expect(button(/Registrar pago/)).toBeDisabled();
  });
});

describe("cashier payment UX (Pilot P0.2-C)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("shows the server's remaining balance, read-only", async () => {
    // Deliberately inconsistent payments list: the server's remainingBalance wins.
    await renderCashier({ queue: [row({ paidAmount: "250000", remainingBalance: "750000" })], payments: [] });
    expect(within(remainingCard()).getByText(/7\.500/)).toBeInTheDocument();
    expect(within(remainingCard()).queryByRole("textbox")).toBeNull();
  });

  it("with split OFF pays exactly the remaining balance from a read-only amount", async () => {
    const state = await renderCashier({ queue: [row({ holdState: "PAYMENT_PROTECTED", paidAmount: "400000", remainingBalance: "600000", paymentCount: 1, canCorrect: false, canCancel: false })], payments: [payment("400000")] });
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    expect(screen.getByRole("checkbox", { name: /Pago parcial/ })).not.toBeChecked();
    expect(amountInput()).toHaveAttribute("readonly");
    expect(amountInput()).toHaveValue("6000");
    fireEvent.click(button(/Registrar pago/)!);
    await waitFor(() => expect(posted(state, "/payments")).toHaveLength(1));
    expect(posted(state, "/payments")[0]!.body).toMatchObject({ method: "TRANSFER", amount: "600000" });
  });

  it("with split ON accepts a valid partial amount", async () => {
    const state = await renderCashier({ queue: [row()] });
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Pago parcial/ }));
    expect(amountInput()).not.toHaveAttribute("readonly");
    fireEvent.change(amountInput(), { target: { value: "2500" } });
    fireEvent.click(button(/Registrar pago/)!);
    await waitFor(() => expect(posted(state, "/payments")).toHaveLength(1));
    expect(posted(state, "/payments")[0]!.body).toMatchObject({ amount: "250000" });
    await waitFor(() => expect(within(remainingCard()).getByText(/7\.500/)).toBeInTheDocument());
  });

  it("rejects zero and above-remaining partial amounts before calling the server", async () => {
    const state = await renderCashier({ queue: [row()] });
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Pago parcial/ }));
    fireEvent.change(amountInput(), { target: { value: "0" } });
    fireEvent.click(button(/Registrar pago/)!);
    expect(await screen.findByText(/importe de pago válido/i)).toBeInTheDocument();
    fireEvent.change(amountInput(), { target: { value: "10001" } });
    fireEvent.click(button(/Registrar pago/)!);
    expect(await screen.findByText(/supera el saldo pendiente/i)).toBeInTheDocument();
    expect(posted(state, "/payments")).toHaveLength(0);
  });

  it("keeps the backend as final authority when it rejects a payment", async () => {
    await renderCashier({ queue: [row()], fail: { payment: "El pago excede el saldo pendiente." } });
    fireEvent.change(screen.getByRole("combobox", { name: /Método/ }), { target: { value: "TRANSFER" } });
    fireEvent.click(button(/Registrar pago/)!);
    expect(await screen.findByText(/El pago excede el saldo pendiente/)).toBeInTheDocument();
    expect(within(remainingCard()).getByText(/10\.000/)).toBeInTheDocument();
    expect(button(/Reintentar mismo pago/)).toBeInTheDocument();
  });

  it("keeps COVERAGE_INVALID unchargeable", async () => {
    await renderCashier({ queue: [row({ holdState: "COVERAGE_INVALID", canAcceptPayment: false, canCorrect: false })] });
    expect(button(/Registrar pago/)).toBeDisabled();
    expect(screen.getByText(/reservas de la venta no son válidas/i)).toBeInTheDocument();
  });
});
