import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";

// Caja: "Pago simple" / "Pago combinado" sobre el motor PROPORTIONAL_V1 existente.
//
// Simple = un único medio de saldo, sin importes fijos (tenders = []), con el
// precio de cada medio tal como lo devuelve la cotización del servidor. Combinado
// = el constructor de varios medios que ya existía. "Combinado" es solo un modo de
// la interfaz: nunca viaja como medio de pago. Crédito no se ofrece porque el motor
// proporcional todavía no lo soporta.

const TOKEN_KEY = "mona-jacinta-token";
const SALE_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
// Cada medio tiene su propio precio completo (centavos): efectivo 45.000,
// transferencia 47.500, débito 48.125.
const PRICES = { CASH: "4500000", TRANSFER: "4750000", CARD_DEBIT: "4812500" } as const;

type Method = keyof typeof PRICES;
type QuoteRequest = { balanceMethod: Method; tenders: Array<{ method: Method; amount: string }> };
type CheckoutBody = {
  operationKey: string; cashSessionId: string; balanceMethod: string; expectedTotal: string; expectedBalanceAmount: string;
  tenders: Array<Record<string, unknown>>;
};
type Row = Record<string, unknown>;
type ServerState = {
  queue: Row[];
  quoteFail?: { status: number; body: unknown };
  unavailable?: Method[];
  requests: Array<{ url: string; method: string; body: unknown }>;
};

const cashier = {
  id: "u1", name: "Cajero", email: "cashier@demo.local", roles: ["CASHIER"], branchIds: ["CEN"], permissions: ["sale.charge"],
  cashMovementLocationIds: [], cashSupervisorLocationIds: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function row(overrides: Row = {}): Row {
  return {
    saleId: SALE_ID, saleNumber: "CEN-V-000042", sellerName: "Vendedor", status: "PENDING_PAYMENT",
    items: [{
      id: "item-1", variantId: "variant-1", productName: "Remera", variantName: "Negro / M", sku: "V1",
      quantity: "1", unitPrice: PRICES.CASH, subtotal: PRICES.CASH,
    }],
    subtotal: PRICES.CASH, total: PRICES.CASH, paidAmount: "0", remainingBalance: PRICES.CASH,
    holdState: "VALID", canAcceptPayment: true, paymentCount: 0, canCorrect: false, canCancel: true,
    pricingMode: "LIST", priceMode: "CASH", wholesaleConfirmed: false, canConfirmWholesale: false,
    pricingModel: "PROPORTIONAL_V1", checkoutRequired: true,
    ...overrides,
  };
}

function quoteFor(sale: Row, body: QuoteRequest, state: ServerState) {
  const fixed = body.tenders.reduce((sum, tender) => sum + BigInt(tender.amount), BigInt(0));
  const total = body.tenders.length === 0 ? PRICES[body.balanceMethod] : PRICES.CASH;
  return {
    saleId: sale.saleId, saleNumber: sale.saleNumber, pricingModel: "PROPORTIONAL_V1",
    enabledMethods: (["CASH", "TRANSFER", "CARD_DEBIT"] as const).map((method) => (
      state.unavailable?.includes(method)
        ? { method, available: false, reason: "PRICING_CONFIG_MISSING" }
        : { method, available: true }
    )),
    fullPrices: { ...PRICES },
    tenders: body.tenders.map((tender) => ({ method: tender.method, role: "FIXED", amount: tender.amount })),
    balance: { method: body.balanceMethod, amount: (BigInt(total) - fixed).toString() },
    total,
    lines: (sale.items as Row[]).map((line) => ({ saleItemId: line.id, sku: line.sku, quantity: line.quantity, finalAmount: total })),
    unappliedCollections: [],
    reservationExpiresAt: null,
  };
}

function checkoutFor(sale: Row, body: CheckoutBody) {
  const payments = body.tenders.map((tender, index) => {
    const amount = tender.role === "FIXED" ? (tender.amount as string) : body.expectedBalanceAmount;
    const cash = tender.method === "CASH";
    const received = cash ? ((tender.receivedAmount as string | null) ?? "0") : null;
    return {
      id: `pay-${index + 1}`, method: tender.method, tenderRole: tender.role, amount, methodFullPrice: amount, adjustmentBps: 0,
      externalCollectionId: null, receivedAmount: received,
      changeAmount: received === null ? null : (BigInt(received) - BigInt(amount)).toString(),
    };
  });
  return {
    saleId: sale.saleId, saleNumber: sale.saleNumber, status: "COMPLETED", checkoutId: "checkout-1", replayed: false,
    total: body.expectedTotal, changeAmount: payments.reduce((sum, payment) => sum + BigInt(payment.changeAmount ?? "0"), BigInt(0)).toString(),
    payments,
    lines: (sale.items as Row[]).map((line) => ({ saleItemId: line.id, sku: line.sku, quantity: line.quantity, finalAmount: body.expectedTotal })),
    completedAt: "2030-01-01T00:00:00.000Z",
  };
}

function createRouter(state: ServerState) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (method !== "GET") state.requests.push({ url, method, body });
    if (url.includes("/auth/me")) return jsonResponse({ user: cashier });
    if (url.includes("/sales/pending")) return jsonResponse({ items: state.queue });
    if (url.endsWith("/checkout/quote")) {
      if (state.quoteFail) return jsonResponse(state.quoteFail.body, state.quoteFail.status);
      return jsonResponse(quoteFor(state.queue[0]!, body as unknown as QuoteRequest, state));
    }
    if (url.endsWith("/checkout") && method === "POST") return jsonResponse(checkoutFor(state.queue[0]!, body as unknown as CheckoutBody), 201);
    if (url.includes("/cash/current")) {
      return jsonResponse({
        sessionId: SESSION_ID, registerId: "reg-1", branchId: "CEN", openedById: "u1", closedById: null,
        startingCash: "0", status: "OPEN", openedAt: "2030-01-01T00:00:00.000Z", closedAt: null,
      });
    }
    if (url.includes("/cash/sessions?")) return jsonResponse([]);
    if (url.includes("/cash/register")) return jsonResponse({ id: "reg-1", branchId: "CEN", name: "Caja principal" });
    return jsonResponse({ items: [] });
  });
}

async function renderCashier(partial: Partial<ServerState> = {}) {
  const state: ServerState = { queue: [row()], requests: [], ...partial };
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", createRouter(state));
  render(<OperationsPage />);
  expect(await screen.findByText("Ventas pendientes")).toBeInTheDocument();
  await screen.findByRole("heading", { name: "CEN-V-000042" });
  return state;
}

const button = (name: RegExp) => screen.queryByRole("button", { name });
const quotes = (state: ServerState) => state.requests.filter((request) => request.url.endsWith("/checkout/quote"));
const checkouts = (state: ServerState) => state.requests.filter((request) => request.url.endsWith(`/sales/${SALE_ID}/checkout`));
const lastQuote = (state: ServerState) => quotes(state).at(-1)!.body as QuoteRequest;
// El panel cotiza con un pequeño retardo: espera a que el total mostrado sea el pedido.
const waitForTotal = (text: string) => waitFor(() => expect(screen.getByTestId("simple-total")).toHaveTextContent(text));
const chooseSimple = async (name: RegExp, total: string) => {
  fireEvent.click(await screen.findByRole("button", { name }));
  await waitForTotal(total);
};

describe("Caja — tipo de cobro", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("UI-1 muestra «Tipo de cobro» con Pago simple y Pago combinado, sin la complejidad proporcional de entrada", async () => {
    await renderCashier();
    const group = await screen.findByRole("group", { name: "Tipo de cobro" });
    expect(within(group).getByRole("button", { name: "Pago simple" })).toHaveAttribute("aria-pressed", "true");
    expect(within(group).getByRole("button", { name: "Pago combinado" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("heading", { name: "Cobro proporcional" })).toBeNull();
    expect(screen.queryByLabelText("Medio de saldo")).toBeNull();
    expect(button(/Agregar importe fijo/)).toBeNull();
  });

  it("UI-2 en Pago simple ofrece Efectivo, Transferencia y Débito con su precio y nada del constructor combinado", async () => {
    await renderCashier();
    expect(await screen.findByRole("button", { name: /Efectivo.*45\.000/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Transferencia.*47\.500/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Débito.*48\.125/ })).toBeInTheDocument();
    expect(screen.queryByText(/importe fijo/i)).toBeNull();
    expect(screen.queryByText(/medio de saldo/i)).toBeNull();
    expect(screen.queryByText(/cobro proporcional/i)).toBeNull();
    expect(screen.queryByTestId("proportional-balance")).toBeNull();
  });

  it("UI-9 una venta PAID conserva «Pagada» y «Falta finalizar» en la cola, sin ofrecer un cobro nuevo", async () => {
    await renderCashier({
      queue: [row({ status: "PAID", holdState: "PAID", canAcceptPayment: false, paymentCount: 1, paidAmount: PRICES.CASH, remainingBalance: "0" })],
    });
    const card = screen.getAllByRole("button").find((element) => element.className.includes("queue-card"))!;
    expect(within(card).getByText("Pagada")).toBeInTheDocument();
    expect(within(card).getByText("Falta finalizar")).toBeInTheDocument();
    expect(within(card).queryByText(/pendiente/i)).toBeNull();
    expect(button(/^Cobrar/)).toBeNull();
  });

  it("UI-10 no ofrece Crédito mientras el motor proporcional no lo soporta", async () => {
    await renderCashier();
    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });
    expect(screen.queryByRole("button", { name: /Cr[eé]dito/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    expect(screen.queryByRole("option", { name: /Cr[eé]dito/ })).toBeNull();
  });

  it("UI-3 Pago simple + Efectivo cotiza sin importes fijos, pide lo recibido y cobra con balanceMethod CASH", async () => {
    const state = await renderCashier();
    await chooseSimple(/Efectivo.*45\.000/, "45.000");
    expect(lastQuote(state)).toEqual({ balanceMethod: "CASH", tenders: [] });
    expect(screen.queryByLabelText("Referencia")).toBeNull();
    fireEvent.change(screen.getByLabelText("Recibido"), { target: { value: "50000" } });
    await waitFor(() => expect(screen.getByTestId("proportional-change-preview")).toHaveTextContent("5.000"));
    fireEvent.click(button(/^Cobrar/)!);
    await screen.findByTestId("proportional-result");
    const [body] = checkouts(state).map((request) => request.body as CheckoutBody);
    expect(body).toMatchObject({ balanceMethod: "CASH", expectedTotal: PRICES.CASH, cashSessionId: SESSION_ID });
    expect(body!.tenders).toHaveLength(1);
    expect(body!.tenders[0]).toMatchObject({ method: "CASH", role: "BALANCE", receivedAmount: "5000000" });
  });

  it("UI-4 Pago simple + Transferencia exige institución y referencia, y las envía", async () => {
    const state = await renderCashier();
    await chooseSimple(/Transferencia.*47\.500/, "47.500");
    expect(lastQuote(state)).toEqual({ balanceMethod: "TRANSFER", tenders: [] });
    expect(button(/^Cobrar/)).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Referencia"), { target: { value: "TRF12345" } });
    expect(button(/^Cobrar/)).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Institución"), { target: { value: "GALICIA" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    fireEvent.click(button(/^Cobrar/)!);
    await screen.findByTestId("proportional-result");
    const [body] = checkouts(state).map((request) => request.body as CheckoutBody);
    expect(body).toMatchObject({ balanceMethod: "TRANSFER", expectedTotal: PRICES.TRANSFER });
    expect(body!.tenders).toHaveLength(1);
    expect(body!.tenders[0]).toMatchObject({ method: "TRANSFER", role: "BALANCE", reference: "TRF12345", institution: "GALICIA" });
  });

  it("UI-5 Pago simple + Débito exige solo la referencia (sin institución) y la envía", async () => {
    const state = await renderCashier();
    await chooseSimple(/Débito.*48\.125/, "48.125");
    expect(lastQuote(state)).toEqual({ balanceMethod: "CARD_DEBIT", tenders: [] });
    expect(screen.queryByLabelText("Institución")).toBeNull();
    expect(button(/^Cobrar/)).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Referencia"), { target: { value: "DEB0099" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    fireEvent.click(button(/^Cobrar/)!);
    await screen.findByTestId("proportional-result");
    const [body] = checkouts(state).map((request) => request.body as CheckoutBody);
    expect(body).toMatchObject({ balanceMethod: "CARD_DEBIT", expectedTotal: PRICES.CARD_DEBIT });
    expect(body!.tenders[0]).toMatchObject({ method: "CARD_DEBIT", role: "BALANCE", reference: "DEB0099" });
  });

  it("UI-6 recién al elegir Pago combinado aparece el constructor de varios medios", async () => {
    await renderCashier();
    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });
    expect(button(/Agregar importe fijo/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    expect(screen.getByRole("button", { name: "Pago combinado" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Medio de saldo")).toBeInTheDocument();
    expect(button(/Agregar importe fijo/)).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Efectivo.*45\.000/ })).toBeNull();
  });

  it("UI-7 cambiar entre Simple y Combinado no cobra ni deja datos del modo anterior", async () => {
    const state = await renderCashier();
    await chooseSimple(/Transferencia.*47\.500/, "47.500");
    fireEvent.change(screen.getByLabelText("Referencia"), { target: { value: "TRF12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    fireEvent.click(button(/Agregar importe fijo/)!);
    fireEvent.click(screen.getByRole("button", { name: "Pago simple" }));
    // Vuelve a Simple sin medio elegido, sin la referencia anterior y sin Cobrar.
    expect(await screen.findByRole("button", { name: /Efectivo.*45\.000/ })).toBeInTheDocument();
    expect(screen.queryByLabelText("Referencia")).toBeNull();
    expect(button(/^Cobrar/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    expect(screen.queryByLabelText("Importe fijo 1")).toBeNull();
    expect(checkouts(state)).toHaveLength(0);
    expect(state.requests.every((request) => request.url.endsWith("/checkout/quote"))).toBe(true);
  });

  it("Combinado: una transferencia con una institución que no es «Otra» no queda bloqueada (saldo e importe fijo)", async () => {
    const state = await renderCashier();
    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    // Importe fijo por transferencia + saldo por transferencia.
    fireEvent.click(button(/Agregar importe fijo/)!);
    fireEvent.change(screen.getByLabelText("Medio del importe fijo 1"), { target: { value: "TRANSFER" } });
    fireEvent.change(screen.getByLabelText("Importe fijo 1"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Referencia del importe fijo 1"), { target: { value: "TRF11111" } });
    fireEvent.change(screen.getByLabelText("Institución del importe fijo 1"), { target: { value: "GALICIA" } });
    fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: "CARD_DEBIT" } });
    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "DEB22222" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    expect(screen.queryByTestId("proportional-blocker")).toBeNull();
    expect(checkouts(state)).toHaveLength(0);
  });

  it("Combinado: el saldo por transferencia con institución distinta de «Otra» tampoco queda bloqueado", async () => {
    await renderCashier();
    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: "TRANSFER" } });
    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "TRF33333" } });
    fireEvent.change(screen.getByLabelText("Institución del saldo"), { target: { value: "MACRO" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
  });

  it("UI-8 un error de cotización impide Cobrar", async () => {
    await renderCashier({ quoteFail: { status: 403, body: { error: { code: "FORBIDDEN", message: "Sin permisos para cotizar." } } } });
    expect(await screen.findByTestId("proportional-quote-note")).toHaveTextContent("Sin permisos para cotizar.");
    expect(button(/^Cobrar/)).toBeNull();
  });

  it("no ofrece un medio que el servidor informa sin configuración", async () => {
    await renderCashier({ unavailable: ["TRANSFER", "CARD_DEBIT"] });
    expect(await screen.findByRole("button", { name: /Efectivo.*45\.000/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Transferencia/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Débito/ })).toBeDisabled();
  });

  it("mayorista: la misma interfaz simple cobra una venta WHOLESALE confirmada con el precio del servidor", async () => {
    const state = await renderCashier({ queue: [row({ pricingMode: "WHOLESALE", wholesaleConfirmed: true })] });
    expect(await screen.findByText("Mayorista confirmada")).toBeInTheDocument();
    await chooseSimple(/Efectivo.*45\.000/, "45.000");
    fireEvent.change(screen.getByLabelText("Recibido"), { target: { value: "45000" } });
    fireEvent.click(button(/^Cobrar/)!);
    await screen.findByTestId("proportional-result");
    expect(checkouts(state)).toHaveLength(1);
  });

  it("mayorista sin confirmar: no admite cobro y no ofrece Cobrar", async () => {
    await renderCashier({ queue: [row({ pricingMode: "WHOLESALE", wholesaleConfirmed: false, canAcceptPayment: false })] });
    expect(await screen.findByTestId("proportional-payment-blocked")).toBeInTheDocument();
    expect(button(/^Cobrar/)).toBeNull();
  });
});
