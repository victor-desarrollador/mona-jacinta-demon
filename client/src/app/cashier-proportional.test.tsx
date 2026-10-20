import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import OperationsPage from "./page";

// R3-A4.2b: el POS cobra una venta PROPORTIONAL_V1 por su circuito propio.
//
// El servidor sigue siendo la única autoridad. El circuito se elige con el
// `checkoutRequired` persistido (nunca por inferencia local), cada importe sale
// de POST /checkout/quote y el cobro se confirma con el total que devolvió el
// backend. Un intento incierto conserva su clave y su cuerpo, y ningún error
// habilita un cobro nuevo.
//
// Las cifras fijadas son las de la entrega aprobada de R3-A4.1/A4.2a:
// CASH fijo 20037 + saldo CARD_DEBIT 31500 = total 51537, con los renglones
// 20615 y 30922.

const TOKEN_KEY = "mona-jacinta-token";
const SALE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SALE_ID = "44444444-4444-4444-8444-444444444444";
const FIXED_SALE_ID = "55555555-5555-4555-8555-555555555555";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const COLLECTION_ID = "33333333-3333-4333-8333-333333333333";
const TOTAL = "51537";
const BALANCE = "31500";

type Item = {
  id: string; variantId: string; productName: string; variantName: string; sku: string;
  quantity: string; unitPrice: string; subtotal: string;
};

type QueueRow = {
  saleId: string; saleNumber: string; sellerName: string; status: "PENDING_PAYMENT" | "PAID";
  items: Item[]; subtotal: string; total: string; paidAmount: string; remainingBalance: string;
  holdState: "VALID" | "EXPIRED" | "PAYMENT_PROTECTED" | "PAID" | "COVERAGE_INVALID";
  canAcceptPayment: boolean; paymentCount: number; canCorrect: boolean; canCancel: boolean;
  pricingMode: "LIST" | "WHOLESALE"; priceMode: "LIST"; wholesaleConfirmed: boolean; canConfirmWholesale: boolean;
  // R3-A4.2b: el circuito persistido por el servidor. Se dejan opcionales para
  // poder probar una fila sin ellos (fail closed).
  pricingModel?: "FIXED_TOTAL" | "PROPORTIONAL_V1";
  checkoutRequired?: boolean;
};

type Collection = {
  id: string; method: "TRANSFER" | "CARD_DEBIT"; amount: string; reference: string;
  institution: "GALICIA" | "MACRO" | null; institutionOther: string | null;
};

type QuoteRequest = { balanceMethod: string; tenders: Array<{ method: string; amount: string }> };
type CheckoutBody = {
  operationKey: string; cashSessionId: string; balanceMethod: string;
  expectedTotal: string; expectedBalanceAmount: string;
  tenders: Array<Record<string, unknown>>;
};

type Reply = { status: number; body: unknown };

type ServerState = {
  queue: QueueRow[];
  collections?: Collection[];
  pricingMissing?: boolean;
  session?: "OPEN" | "NONE";
  reservationExpiresAt?: string | null;
  quoteFail?: Reply | "network";
  checkoutFail?: Reply | "network";
  // La venta se corrigió mientras el cajero confirmaba: el checkout vigente ya
  // no coincide con el total cotizado.
  quoteChanged?: { total: string; balance: string };
  replayed?: boolean;
  checkoutChange?: string;
  hold?: Promise<void>;
  requests: Array<{ url: string; method: string; body: unknown }>;
};

const cashier = {
  id: "u1", name: "Cajero", email: "cashier@demo.local", roles: ["CASHIER"], branchIds: ["CEN"], permissions: ["sale.charge"],
  cashMovementLocationIds: [], cashSupervisorLocationIds: [],
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function item(overrides: Partial<Item> = {}): Item {
  return {
    id: "item-1", variantId: "variant-1", productName: "Remera", variantName: "Negro / M", sku: "V1",
    quantity: "1", unitPrice: "20615", subtotal: "20615", ...overrides,
  };
}

function proportionalRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    saleId: SALE_ID, saleNumber: "CEN-V-000042", sellerName: "Vendedor", status: "PENDING_PAYMENT",
    items: [
      item(),
      item({ id: "item-2", variantId: "variant-2", productName: "Jean", variantName: "Azul / 42", sku: "V2", unitPrice: "30922", subtotal: "30922" }),
    ],
    subtotal: TOTAL, total: TOTAL, paidAmount: "0", remainingBalance: TOTAL,
    holdState: "VALID", canAcceptPayment: true, paymentCount: 0, canCorrect: false, canCancel: true,
    pricingMode: "LIST", priceMode: "LIST", wholesaleConfirmed: false, canConfirmWholesale: false,
    pricingModel: "PROPORTIONAL_V1", checkoutRequired: true,
    ...overrides,
  };
}

function fixedRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    saleId: FIXED_SALE_ID, saleNumber: "CEN-V-000050", sellerName: "Vendedor", status: "PENDING_PAYMENT",
    items: [item({ id: "item-9", sku: "F1", unitPrice: "1000000", subtotal: "1000000" })],
    subtotal: "1000000", total: "1000000", paidAmount: "0", remainingBalance: "1000000",
    holdState: "VALID", canAcceptPayment: true, paymentCount: 0, canCorrect: false, canCancel: true,
    pricingMode: "LIST", priceMode: "LIST", wholesaleConfirmed: false, canConfirmWholesale: false,
    pricingModel: "FIXED_TOTAL", checkoutRequired: false,
    ...overrides,
  };
}

function otherRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return proportionalRow({
    saleId: OTHER_SALE_ID, saleNumber: "CEN-V-000043",
    items: [item({ id: "item-3", sku: "V3", unitPrice: "10000", subtotal: "10000" })],
    subtotal: "10000", total: "10000", remainingBalance: "10000",
    ...overrides,
  });
}

function saleIdOf(url: string) {
  return url.split("/sales/")[1]!.split("/")[0]!;
}

function rowOf(state: ServerState, url: string): QueueRow {
  const row = state.queue.find((candidate) => candidate.saleId === saleIdOf(url));
  if (!row) throw new Error(`sin fila para ${url}`);
  return row;
}

// Cotización del servidor: refleja exactamente la composición pedida, con el
// saldo como total menos los importes fijos.
function quoteFor(row: QueueRow, body: QuoteRequest, state: ServerState) {
  const fixedTotal = body.tenders.reduce((sum, tender) => sum + BigInt(tender.amount), BigInt(0));
  return {
    saleId: row.saleId,
    saleNumber: row.saleNumber,
    pricingModel: "PROPORTIONAL_V1",
    enabledMethods: state.pricingMissing
      ? [
          { method: "CASH", available: true },
          { method: "TRANSFER", available: false, reason: "PRICING_CONFIG_MISSING" },
          { method: "CARD_DEBIT", available: false, reason: "PRICING_CONFIG_MISSING" },
          { method: "CARD_CREDIT", available: false, reason: "PRICING_CONFIG_MISSING" },
        ]
      : [
          { method: "CASH", available: true },
          { method: "TRANSFER", available: true },
          { method: "CARD_DEBIT", available: true },
          { method: "CARD_CREDIT", available: true },
        ],
    fullPrices: { CASH: row.total, TRANSFER: row.total, CARD_DEBIT: row.total, CARD_CREDIT: row.total },
    tenders: body.tenders.map((tender) => ({ method: tender.method, role: "FIXED", amount: tender.amount })),
    balance: { method: body.balanceMethod, amount: (BigInt(row.total) - fixedTotal).toString() },
    total: row.total,
    lines: row.items.map((line) => ({ saleItemId: line.id, sku: line.sku, quantity: line.quantity, finalAmount: line.subtotal })),
    unappliedCollections: state.collections ?? [],
    reservationExpiresAt: state.reservationExpiresAt ?? null,
  };
}

function checkoutFor(row: QueueRow, body: CheckoutBody, state: ServerState) {
  const payments = body.tenders.map((tender, index) => {
    const amount = tender.role === "FIXED" ? (tender.amount as string) : body.expectedBalanceAmount;
    const cash = tender.method === "CASH";
    const received = cash ? ((tender.receivedAmount as string | null) ?? "0") : null;
    return {
      id: `pay-${index + 1}`,
      method: tender.method,
      tenderRole: tender.role,
      amount,
      methodFullPrice: amount,
      adjustmentBps: 0,
      externalCollectionId: (tender.externalCollectionId as string | null) ?? null,
      receivedAmount: received,
      changeAmount: received === null ? null : (BigInt(received) - BigInt(amount)).toString(),
    };
  });
  const change = payments.reduce(
    (sum, payment) => sum + BigInt(payment.changeAmount ?? "0"),
    BigInt(0),
  );
  return {
    saleId: row.saleId,
    saleNumber: row.saleNumber,
    status: "COMPLETED",
    checkoutId: "checkout-1",
    replayed: state.replayed === true,
    total: body.expectedTotal,
    changeAmount: state.checkoutChange ?? change.toString(),
    payments,
    lines: row.items.map((line) => ({ saleItemId: line.id, sku: line.sku, quantity: line.quantity, finalAmount: line.subtotal })),
    completedAt: "2030-01-01T00:00:00.000Z",
  };
}

// Router mínimo que modela al servidor: el estado sólo cambia cuando la
// operación habría cometido.
function createRouter(state: ServerState) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    if (method !== "GET") state.requests.push({ url, method, body });
    if (url.includes("/auth/me")) return jsonResponse({ user: cashier });
    if (url.includes("/sales/pending")) return jsonResponse({ items: state.queue });
    if (url.endsWith("/checkout/quote")) {
      if (state.quoteFail === "network") throw new TypeError("fetch failed");
      if (state.quoteFail) return jsonResponse(state.quoteFail.body, state.quoteFail.status);
      return jsonResponse(quoteFor(rowOf(state, url), body as unknown as QuoteRequest, state));
    }
    if (url.endsWith("/checkout") && method === "POST") {
      const row = rowOf(state, url);
      if (state.hold) await state.hold;
      if (state.checkoutFail === "network") throw new TypeError("fetch failed");
      if (state.checkoutFail) return jsonResponse(state.checkoutFail.body, state.checkoutFail.status);
      if (state.quoteChanged) {
        row.subtotal = state.quoteChanged.total;
        row.total = state.quoteChanged.total;
        row.remainingBalance = state.quoteChanged.total;
        return jsonResponse(
          { error: { code: "CHECKOUT_QUOTE_CHANGED", message: "La cotización cambió; vuelva a confirmar.", details: { total: state.quoteChanged.total, balance: state.quoteChanged.balance } } },
          409,
        );
      }
      return jsonResponse(checkoutFor(row, body as unknown as CheckoutBody, state), 201);
    }
    if (url.includes("/cash/current")) {
      return jsonResponse(
        state.session === "NONE"
          ? null
          : {
              sessionId: SESSION_ID, registerId: "reg-1", branchId: "CEN", openedById: "u1", closedById: null,
              startingCash: "0", status: "OPEN", openedAt: "2030-01-01T00:00:00.000Z", closedAt: null,
            },
      );
    }
    if (url.includes("/cash/sessions?")) return jsonResponse([]);
    if (url.includes("/cash/register")) return jsonResponse({ id: "reg-1", branchId: "CEN", name: "Caja principal" });
    return jsonResponse({ items: [] });
  });
}

// Caja arranca en «Pago simple»; estas pruebas ejercitan el constructor de varios
// medios (el motor proporcional completo), que vive detrás de «Pago combinado».
function openCombined() {
  const toggle = screen.queryByRole("button", { name: "Pago combinado" });
  if (toggle !== null && toggle.getAttribute("aria-pressed") === "false") fireEvent.click(toggle);
}

async function renderCashier(partial: Partial<ServerState> & { queue: QueueRow[] }, heading: string, combined = true) {
  const state: ServerState = { requests: [], ...partial };
  window.localStorage.setItem(TOKEN_KEY, "test-token");
  vi.stubGlobal("fetch", createRouter(state));
  render(<OperationsPage />);
  expect(await screen.findByText("Ventas pendientes")).toBeInTheDocument();
  await screen.findByRole("heading", { name: heading });
  if (combined) openCombined();
  return state;
}

const button = (name: RegExp) => screen.queryByRole("button", { name });
const posted = (state: ServerState, suffix: string) => state.requests.filter((request) => request.url.endsWith(suffix));
const checkoutBodies = (state: ServerState, saleId = SALE_ID) =>
  posted(state, `/sales/${saleId}/checkout`).map((request) => request.body as CheckoutBody);
const queueCards = () => screen.getAllByRole("button").filter((element) => element.className.includes("queue-card"));
const proportionalTotal = () => screen.getByTestId("proportional-total");
const proportionalBalance = () => screen.getByTestId("proportional-balance");

// Espera a que la cotización vigente muestre el saldo pedido: el panel cotiza
// con un pequeño retardo para no disparar un POST por tecla.
const waitForBalance = async (text: string) =>
  waitFor(() => expect(proportionalBalance()).toHaveTextContent(text));

async function changeBalanceMethod(method: string) {
  fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: method } });
}

async function addCashFixed(amount: string, received: string) {
  fireEvent.click(button(/Agregar importe fijo/)!);
  fireEvent.change(screen.getByLabelText("Medio del importe fijo 1"), { target: { value: "CASH" } });
  fireEvent.change(screen.getByLabelText("Importe fijo 1"), { target: { value: amount } });
  fireEvent.change(screen.getByLabelText("Recibido del importe fijo 1"), { target: { value: received } });
}

// La composición fijada por A4.1: CASH fijo con vuelto + saldo por débito.
async function composePinned() {
  await waitFor(() => expect(proportionalTotal()).toHaveTextContent("515,37"));
  await changeBalanceMethod("CARD_DEBIT");
  await addCashFixed("200,37", "300,37");
  fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "D009" } });
  await waitForBalance("315");
}

describe("R3-A4.2b — enrutado del circuito", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("envía una venta PROPORTIONAL_V1 al panel proporcional", async () => {
    await renderCashier({ queue: [proportionalRow()] }, "CEN-V-000042");
    expect(screen.getByRole("heading", { name: "Cobro" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Registrar pago" })).toBeNull();
    expect(screen.queryByLabelText("Método")).toBeNull();
    expect(button(/Finalizar venta/)).toBeNull();
  });

  it("conserva intacto el flujo de pagos de una venta FIXED_TOTAL", async () => {
    const state = await renderCashier({ queue: [fixedRow()] }, "CEN-V-000050");
    expect(screen.getByRole("heading", { name: "Registrar pago" })).toBeInTheDocument();
    expect(screen.getByLabelText("Método")).toBeInTheDocument();
    expect(button(/Registrar pago/)).toBeEnabled();
    expect(button(/Finalizar venta/)).toBeDisabled();
    expect(screen.queryByRole("heading", { name: "Cobro" })).toBeNull();
    // Sin cotización ni checkout: el circuito proporcional ni se asoma.
    expect(posted(state, "/checkout/quote")).toHaveLength(0);
    expect(posted(state, `/sales/${FIXED_SALE_ID}/checkout`)).toHaveLength(0);
  });

  it.each([
    ["sin checkoutRequired", { checkoutRequired: undefined }],
    ["sin pricingModel", { pricingModel: undefined }],
    ["incoherente (obligatorio con modelo fijo)", { pricingModel: "FIXED_TOTAL" as const, checkoutRequired: true }],
    ["incoherente (sin obligación con modelo proporcional)", { pricingModel: "PROPORTIONAL_V1" as const, checkoutRequired: false }],
  ])("invalida la cola entera ante una fila %s", async (_label, override) => {
    window.localStorage.setItem(TOKEN_KEY, "test-token");
    vi.stubGlobal("fetch", createRouter({ queue: [proportionalRow(override)], requests: [] }));
    render(<OperationsPage />);
    expect(await screen.findByText("No se pudo validar la cola de ventas.")).toBeInTheDocument();
    expect(queueCards()).toHaveLength(0);
  });
});

describe("R3-A4.2b — cotización", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("cotiza la composición por defecto y muestra total, saldo, desglose y medios del servidor", async () => {
    const state = await renderCashier({ queue: [proportionalRow()] }, "CEN-V-000042");
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("515,37"));
    // El total y el saldo son los del servidor, no una cuenta local.
    expect(proportionalBalance()).toHaveTextContent("515,37");
    // Desglose por prenda: importe final de la cotización, nombre de la cola.
    const lines = screen.getByTestId("proportional-lines");
    expect(within(lines).getByText("Remera")).toBeInTheDocument();
    expect(within(lines).getByText(/V1/)).toBeInTheDocument();
    expect(within(lines).getByText(/206,15/)).toBeInTheDocument();
    expect(within(lines).getByText(/309,22/)).toBeInTheDocument();
    // Medios habilitados exactamente como los declara la cotización.
    const methods = screen.getByTestId("proportional-methods");
    expect(within(methods).getByText("Efectivo")).toBeInTheDocument();
    expect(within(methods).getByText("Transferencia")).toBeInTheDocument();
    expect(within(methods).getByText("Tarjeta de débito")).toBeInTheDocument();
    expect(posted(state, "/checkout/quote")).toHaveLength(1);
    expect(posted(state, "/checkout/quote")[0]!.body).toEqual({ balanceMethod: "CASH", tenders: [] });
  });

  it("cotiza en centavos exactos cada cambio de medio o de importe", async () => {
    const state = await renderCashier({ queue: [proportionalRow()] }, "CEN-V-000042");
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("515,37"));
    await changeBalanceMethod("CARD_DEBIT");
    await addCashFixed("200,37", "300,37");
    await waitForBalance("315");
    const last = posted(state, "/checkout/quote").at(-1)!.body as QuoteRequest;
    expect(last).toEqual({ balanceMethod: "CARD_DEBIT", tenders: [{ method: "CASH", amount: "20037" }] });
    // Un importe inválido no se cotiza: se avisa y no se manda nada.
    const before = posted(state, "/checkout/quote").length;
    fireEvent.change(screen.getByLabelText("Importe fijo 1"), { target: { value: "200,3,7" } });
    await waitFor(() => expect(posted(state, "/checkout/quote")).toHaveLength(before));
  });

  it("no habilita ningún cobro cuando el servidor rechaza la cotización por permisos", async () => {
    const state = await renderCashier(
      { queue: [proportionalRow()], quoteFail: { status: 403, body: { error: { code: "FORBIDDEN", message: "No tenés permiso para realizar esta acción." } } } },
      "CEN-V-000042",
    );
    expect(await screen.findByTestId("proportional-quote-note")).toHaveTextContent(/permiso/i);
    expect(button(/Cobrar/)).toBeNull();
    expect(checkoutBodies(state)).toHaveLength(0);
  });

  it("con la venta en un estado no cobrable no permite confirmar", async () => {
    await renderCashier({ queue: [proportionalRow({ canAcceptPayment: false, holdState: "EXPIRED", canCancel: true })] }, "CEN-V-000042");
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("515,37"));
    expect(button(/Cobrar/)).toBeDisabled();
    expect(screen.getByTestId("proportional-payment-blocked")).toHaveTextContent(/no admite cobros/i);
  });
});

describe("R3-A4.2b — confirmación", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("confirma con el total y el saldo del servidor y muestra el vuelto definitivo", async () => {
    const state = await renderCashier({ queue: [proportionalRow()], checkoutChange: "1234" }, "CEN-V-000042");
    await composePinned();
    // Vuelto estimado mientras se tipea (resta exacta local).
    expect(screen.getByTestId("proportional-change-preview")).toHaveTextContent("100");
    fireEvent.click(button(/Cobrar/)!);
    await screen.findByTestId("proportional-result");
    const body = checkoutBodies(state)[0]!;
    expect(body.cashSessionId).toBe(SESSION_ID);
    expect(body.balanceMethod).toBe("CARD_DEBIT");
    expect(body.expectedTotal).toBe(TOTAL);
    expect(body.expectedBalanceAmount).toBe(BALANCE);
    expect(body.operationKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(body.tenders).toEqual([
      { method: "CASH", role: "FIXED", amount: "20037", receivedAmount: "30037" },
      { method: "CARD_DEBIT", role: "BALANCE", reference: "D009" },
    ]);
    // El vuelto definitivo es el del servidor, aunque difiera de la resta local.
    expect(screen.getByTestId("proportional-result-change")).toHaveTextContent("12,34");
    expect(screen.getByTestId("proportional-result-total")).toHaveTextContent("515,37");
    expect(screen.getByTestId("proportional-result")).toHaveTextContent(/Cobrado y registrado/i);
    expect(button(/Cobrar/)).toBeNull();
  });

  it("bloquea el segundo clic del mismo tick antes de que React vuelva a renderizar", async () => {
    const hold = deferred();
    const state = await renderCashier({ queue: [proportionalRow()], hold: hold.promise }, "CEN-V-000042");
    await composePinned();
    const cobrar = screen.getByRole("button", { name: /Cobrar/ });
    act(() => {
      cobrar.click();
      cobrar.click();
    });
    expect(checkoutBodies(state)).toHaveLength(1);
    hold.release();
    await screen.findByTestId("proportional-result");
    expect(checkoutBodies(state)).toHaveLength(1);
  });

  it("mantiene el flujo del efectivo con un saldo en efectivo", async () => {
    const state = await renderCashier({ queue: [proportionalRow()] }, "CEN-V-000042");
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("515,37"));
    fireEvent.change(screen.getByLabelText("Recibido del saldo"), { target: { value: "600,00" } });
    expect(screen.getByTestId("proportional-change-preview")).toHaveTextContent("84,63");
    await waitFor(() => expect(button(/Cobrar/)).toBeEnabled());
    fireEvent.click(button(/Cobrar/)!);
    await screen.findByTestId("proportional-result");
    expect(checkoutBodies(state)[0]!.tenders).toEqual([
      { method: "CASH", role: "BALANCE", receivedAmount: "60000" },
    ]);
  });

  it("exige una sesión de caja abierta incluso para un cobro sin efectivo", async () => {
    await renderCashier({ queue: [proportionalRow()], session: "NONE" }, "CEN-V-000042");
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("515,37"));
    await changeBalanceMethod("CARD_DEBIT");
    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "D009" } });
    await waitForBalance("515,37");
    expect(screen.getByTestId("proportional-session-note")).toHaveTextContent(/Abrí caja antes de cobrar/i);
    expect(button(/Cobrar/)).toBeDisabled();
  });

  it("imputa un cobro externo pendiente como importe fijo", async () => {
    const state = await renderCashier(
      {
        queue: [proportionalRow()],
        collections: [{ id: COLLECTION_ID, method: "TRANSFER", amount: "31500", reference: "OP 88123", institution: "GALICIA", institutionOther: null }],
      },
      "CEN-V-000042",
    );
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("515,37"));
    fireEvent.click(button(/Agregar importe fijo/)!);
    fireEvent.change(screen.getByLabelText("Medio del importe fijo 1"), { target: { value: "TRANSFER" } });
    fireEvent.change(screen.getByLabelText("Cobro pendiente del importe fijo 1"), { target: { value: COLLECTION_ID } });
    // El importe del cobro registrado es el suyo: el panel no lo deja inventar.
    expect(screen.getByLabelText("Importe fijo 1")).toHaveValue("315");
    await waitForBalance("200,37");
    fireEvent.change(screen.getByLabelText("Recibido del saldo"), { target: { value: "200,37" } });
    await waitFor(() => expect(button(/Cobrar/)).toBeEnabled());
    fireEvent.click(button(/Cobrar/)!);
    await screen.findByTestId("proportional-result");
    expect(checkoutBodies(state)[0]!.tenders).toEqual([
      { method: "TRANSFER", role: "FIXED", amount: "31500", externalCollectionId: COLLECTION_ID },
      { method: "CASH", role: "BALANCE", receivedAmount: "20037" },
    ]);
  });

  it("no cobra sin la referencia que el servidor exige en un saldo no-efectivo", async () => {
    const state = await renderCashier({ queue: [proportionalRow()] }, "CEN-V-000042");
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("515,37"));
    await changeBalanceMethod("CARD_DEBIT");
    await addCashFixed("200,37", "300,37");
    await waitForBalance("315");
    expect(button(/Cobrar/)).toBeDisabled();
    expect(screen.getByTestId("proportional-blocker")).toHaveTextContent(/referencia o un cobro registrado/i);
    // Y aun forzando el clic no sale ningún checkout.
    fireEvent.click(button(/Cobrar/) ?? screen.getByTestId("proportional-panel"));
    expect(checkoutBodies(state)).toHaveLength(0);
  });
});

describe("R3-A4.2b — intentos", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("tras un error de red conserva el intento y sólo ofrece reintentar lo mismo", async () => {
    const state = await renderCashier({ queue: [proportionalRow()], checkoutFail: "network" }, "CEN-V-000042");
    await composePinned();
    fireEvent.click(button(/Cobrar/)!);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/reintentá el mismo cobro/i);
    const first = checkoutBodies(state)[0]!;
    // Ningún cobro nuevo: el botón principal desapareció.
    expect(button(/Cobrar/)).toBeNull();
    // El repliegue de la cola no libera el intento: sigue incierto.
    fireEvent.click(button(/Actualizar/)!);
    await screen.findByRole("alert");
    // El reintento ahora sí llega al servidor (el fallo simulado ya no aplica).
    state.checkoutFail = undefined;
    state.replayed = true;
    fireEvent.click(button(/Reintentar el mismo cobro/)!);
    await screen.findByTestId("proportional-result");
    const second = checkoutBodies(state)[1]!;
    expect(second.operationKey).toBe(first.operationKey);
    expect(second).toEqual(first);
    expect(screen.getByTestId("proportional-result")).toHaveTextContent(/reintento ya registrado/i);
    expect(checkoutBodies(state)).toHaveLength(2);
  });

  it("no habilita un cobro nuevo después de un error HTTP", async () => {
    const state = await renderCashier(
      { queue: [proportionalRow()], checkoutFail: { status: 500, body: { error: { code: "CONCURRENCY_ERROR", message: "No se pudo confirmar el cobro." } } } },
      "CEN-V-000042",
    );
    await composePinned();
    fireEvent.click(button(/Cobrar/)!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/No se pudo confirmar el cobro/i);
    expect(button(/Cobrar/)).toBeNull();
    // Cambiar la composición no reabre el cobro (el intento sigue incierto).
    fireEvent.click(button(/Quitar importe fijo 1/) ?? screen.getByTestId("proportional-panel"));
    fireEvent.click(button(/Actualizar/)!);
    await waitFor(() => expect(checkoutBodies(state)).toHaveLength(1));
    expect(button(/Cobrar/)).toBeNull();
    expect(button(/Reintentar el mismo cobro/)).toBeEnabled();
  });

  it("conserva el intento al cambiar de venta, refrescar la cola y volver", async () => {
    const state = await renderCashier({ queue: [proportionalRow(), otherRow()], checkoutFail: "network" }, "CEN-V-000042");
    await composePinned();
    fireEvent.click(button(/Cobrar/)!);
    await screen.findByRole("alert");
    const first = checkoutBodies(state)[0]!;
    // Otra venta, otra cotización, y la cola se refresca por completo.
    fireEvent.click(screen.getByRole("button", { name: /CEN-V-000043/ }));
    await screen.findByRole("heading", { name: "CEN-V-000043" });
    // Cada venta abre su propio panel, en «Pago simple».
    openCombined();
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("100"));
    fireEvent.click(button(/Actualizar/)!);
    // Volver a la primera venta: el intento incierto sigue ahí, con su clave.
    fireEvent.click(screen.getByRole("button", { name: /CEN-V-000042/ }));
    await screen.findByRole("heading", { name: "CEN-V-000042" });
    // El reintento ahora sí llega al servidor (el fallo simulado ya no aplica).
    state.checkoutFail = undefined;
    state.replayed = true;
    fireEvent.click(await screen.findByRole("button", { name: /Reintentar el mismo cobro/ }));
    await screen.findByTestId("proportional-result");
    const second = checkoutBodies(state)[1]!;
    expect(second.operationKey).toBe(first.operationKey);
    expect(second).toEqual(first);
  });

  it("ante CHECKOUT_QUOTE_CHANGED invalida la cotización, muestra el importe nuevo y no reenvía solo", async () => {
    const state = await renderCashier(
      { queue: [proportionalRow()], quoteChanged: { total: "60000", balance: "39963" } },
      "CEN-V-000042",
    );
    await composePinned();
    fireEvent.click(button(/Cobrar/)!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/cotización cambió/i);
    // El importe nuevo es el del servidor, y no se reenvió nada por su cuenta.
    expect(screen.getByTestId("proportional-server-total")).toHaveTextContent("600");
    expect(checkoutBodies(state)).toHaveLength(1);
    expect(button(/Cobrar/)).toBeNull();
    // La cotización vieja se invalidó y se recotiza: el nuevo total es el vigente.
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("600"));
  });

  it("un vencimiento de reserva deja el intento incierto y sin cobro nuevo", async () => {
    const state = await renderCashier(
      { queue: [proportionalRow()], checkoutFail: { status: 409, body: { error: { code: "RESERVATION_EXPIRED", message: "La reserva técnica venció." } } } },
      "CEN-V-000042",
    );
    await composePinned();
    fireEvent.click(button(/Cobrar/)!);
    expect(await screen.findByRole("alert")).toHaveTextContent(/reserva técnica venció/i);
    expect(button(/Cobrar/)).toBeNull();
    expect(checkoutBodies(state)).toHaveLength(1);
    expect(screen.queryByTestId("proportional-server-total")).toBeNull();
  });

  it("no presenta la fecha de la reserva como un vencimiento operativo (OWNER 2026-10-20)", async () => {
    await renderCashier(
      { queue: [proportionalRow()], reservationExpiresAt: "2030-01-01T12:00:00.000Z" },
      "CEN-V-000042",
    );
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("515,37"));
    expect(screen.queryByTestId("proportional-expiry")).toBeNull();
    expect(screen.queryByText(/Reserva técnica/i)).toBeNull();
  });
});
