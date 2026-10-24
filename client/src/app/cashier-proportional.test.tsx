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
// Fase 1 (POST /checkout/reservations): el plan del cobro, sin evidencia.
type ReservationBody = {
  reserveKey: string; cashSessionId: string; balanceMethod: string;
  expectedTotal: string; expectedBalanceAmount: string;
  tenders: Array<Record<string, unknown>>;
};
// Fase 2 (POST /checkout): la evidencia, con la operationKey que dio el servidor.
type CheckoutBody = {
  reserveKey: string; operationKey: string;
  tenders: Array<Record<string, unknown>>;
};
const RESERVED_OPERATION_KEY = "66666666-6666-4666-8666-666666666666";

type Reply = { status: number; body: unknown };

type ServerState = {
  queue: QueueRow[];
  collections?: Collection[];
  pricingMissing?: boolean;
  session?: "OPEN" | "NONE";
  reservationExpiresAt?: string | null;
  quoteFail?: Reply | "network";
  checkoutFail?: Reply | "network";
  // La venta se corrigió antes de reservar: el servidor, que cotiza dentro de la
  // transacción de la reserva y antes de escribir nada, rechaza UNA reserva con
  // CHECKOUT_QUOTE_CHANGED. Las siguientes ya cotizan el total nuevo.
  reservationQuoteChanged?: { total: string; balance: string };
  // Retiene la PRÓXIMA cotización (se consume al usarla) para ordenar respuestas tardías.
  quoteGate?: Promise<void>;
  replayed?: boolean;
  checkoutChange?: string;
  hold?: Promise<void>;
  lastReservation?: ReservationBody;
  // Contexto operativo: sesión de caja devuelta por /cash/current y sucursales del usuario.
  sessionId?: string;
  branchIds?: string[];
  reservationFail?: "network";
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
          { method: "CARD_CREDIT", available: false, reason: "PRICING_CONFIG_MISSING" }, { method: "QR", available: false, reason: "PRICING_CONFIG_MISSING" },
        ]
      : [
          { method: "CASH", available: true },
          { method: "TRANSFER", available: true },
          { method: "CARD_DEBIT", available: true },
          { method: "CARD_CREDIT", available: true }, { method: "QR", available: true },
        ],
    fullPrices: { CASH: row.total, TRANSFER: row.total, CARD_DEBIT: row.total, CARD_CREDIT: row.total, QR: row.total },
    tenders: body.tenders.map((tender) => ({ method: tender.method, role: "FIXED", amount: tender.amount })),
    balance: { method: body.balanceMethod, amount: (BigInt(row.total) - fixedTotal).toString() },
    total: row.total,
    lines: row.items.map((line) => ({ saleItemId: line.id, sku: line.sku, quantity: line.quantity, finalAmount: line.subtotal })),
    unappliedCollections: state.collections ?? [],
    reservationExpiresAt: state.reservationExpiresAt ?? null,
  };
}

function checkoutFor(row: QueueRow, reservation: ReservationBody, confirmation: CheckoutBody, state: ServerState) {
  const payments = reservation.tenders.map((reserved, index) => {
    const evidence = confirmation.tenders[index] ?? {};
    const amount = reserved.role === "FIXED" ? (reserved.amount as string) : reservation.expectedBalanceAmount;
    const cash = reserved.method === "CASH";
    const received = cash ? ((evidence.receivedAmount as string | undefined) ?? amount) : null;
    return {
      id: `pay-${index + 1}`,
      method: reserved.method,
      tenderRole: reserved.role,
      amount,
      methodFullPrice: amount,
      adjustmentBps: 0,
      externalCollectionId: (reserved.externalCollectionId as string | undefined) ?? null,
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
    total: reservation.expectedTotal,
    changeAmount: state.checkoutChange ?? change.toString(),
    payments,
    lines: row.items.map((line) => ({ saleItemId: line.id, sku: line.sku, quantity: line.quantity, finalAmount: line.subtotal })),
    completedAt: "2030-01-01T00:00:00.000Z",
  };
}

function reservationFor(reservation: ReservationBody) {
  return {
    reserveKey: reservation.reserveKey,
    operationKey: RESERVED_OPERATION_KEY,
    status: "RESERVED",
    startedBy: { id: "u1", name: "Cajero" },
    startedAt: "2030-01-01T00:00:00.000Z",
    plan: {
      cashSessionId: reservation.cashSessionId,
      balanceMethod: reservation.balanceMethod,
      expectedTotal: reservation.expectedTotal,
      expectedBalanceAmount: reservation.expectedBalanceAmount,
      tenderCount: reservation.tenders.length,
      tenders: reservation.tenders.map((tender) => ({
        method: tender.method,
        role: tender.role,
        source: tender.source,
        amount: (tender.amount as string | undefined) ?? null,
        externalCollectionId: (tender.externalCollectionId as string | undefined) ?? null,
      })),
      fullPrices: {},
    },
    recovery: null,
    rejection: null,
    declaration: null,
    declared: false,
    stockState: "VALID",
    stockExpiresAt: "2030-01-01T01:00:00.000Z",
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
    if (url.includes("/auth/me")) return jsonResponse({ user: { ...cashier, branchIds: state.branchIds ?? cashier.branchIds } });
    if (url.includes("/sales/pending")) return jsonResponse({ items: state.queue });
    if (url.endsWith("/checkout/quote")) {
      if (state.quoteFail === "network") throw new TypeError("fetch failed");
      if (state.quoteFail) return jsonResponse(state.quoteFail.body, state.quoteFail.status);
      const gate = state.quoteGate;
      state.quoteGate = undefined;
      if (gate) await gate;
      return jsonResponse(quoteFor(rowOf(state, url), body as unknown as QuoteRequest, state));
    }
    if (url.endsWith("/checkout/reservations") && method === "POST") {
      if (state.reservationFail === "network") throw new TypeError("fetch failed");
      if (state.reservationQuoteChanged) {
        const changed = state.reservationQuoteChanged;
        state.reservationQuoteChanged = undefined;
        const row = rowOf(state, url);
        row.subtotal = changed.total;
        row.total = changed.total;
        row.remainingBalance = changed.total;
        return jsonResponse(
          { error: { code: "CHECKOUT_QUOTE_CHANGED", message: "La cotización cambió; vuelva a cotizar.", details: { total: changed.total, balance: changed.balance } } },
          409,
        );
      }
      state.lastReservation = body as unknown as ReservationBody;
      return jsonResponse(reservationFor(state.lastReservation), 201);
    }
    if (url.endsWith("/checkout") && method === "POST") {
      const row = rowOf(state, url);
      if (state.hold) await state.hold;
      if (state.checkoutFail === "network") throw new TypeError("fetch failed");
      if (state.checkoutFail) return jsonResponse(state.checkoutFail.body, state.checkoutFail.status);
      if (!state.lastReservation) {
        return jsonResponse({ error: { code: "TEST_FIXTURE_ERROR", message: "Falta la reserva previa." } }, 500);
      }
      return jsonResponse(checkoutFor(row, state.lastReservation, body as unknown as CheckoutBody, state), 201);
    }
    if (url.includes("/cash/current")) {
      return jsonResponse(
        state.session === "NONE"
          ? null
          : {
              sessionId: state.sessionId ?? SESSION_ID, registerId: "reg-1", branchId: "CEN", openedById: "u1", closedById: null,
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
  if (combined) {
    // Sin caja abierta el panel no ofrece ningún cobro: esperar a que cargue la sesión.
    await screen.findByRole("heading", { name: "Caja abierta" });
    openCombined();
  }
  return state;
}

const button = (name: RegExp) => screen.queryByRole("button", { name });
const posted = (state: ServerState, suffix: string) => state.requests.filter((request) => request.url.endsWith(suffix));
const reservationBodies = (state: ServerState, saleId = SALE_ID) =>
  posted(state, `/sales/${saleId}/checkout/reservations`).map((request) => request.body as ReservationBody);
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
  fireEvent.click(button(/Agregar pago/)!);
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
    // Fase 1: el plan, con el total y el saldo cotizados por el servidor y sin evidencia.
    const reservation = reservationBodies(state)[0]!;
    expect(reservation.cashSessionId).toBe(SESSION_ID);
    expect(reservation.balanceMethod).toBe("CARD_DEBIT");
    expect(reservation.expectedTotal).toBe(TOTAL);
    expect(reservation.expectedBalanceAmount).toBe(BALANCE);
    expect(reservation.reserveKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(reservation.tenders).toEqual([
      { method: "CASH", role: "FIXED", source: "NEW", amount: "20037" },
      { method: "CARD_DEBIT", role: "BALANCE", source: "NEW" },
    ]);
    // Fase 2: la evidencia, con la operationKey que dio el servidor.
    const body = checkoutBodies(state)[0]!;
    expect(body.reserveKey).toBe(reservation.reserveKey);
    expect(body.operationKey).toBe(RESERVED_OPERATION_KEY);
    expect(body.tenders).toEqual([
      { method: "CASH", receivedAmount: "30037" },
      { method: "CARD_DEBIT", reference: "D009" },
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
    // El segundo clic del mismo tick no abre una segunda reserva.
    expect(reservationBodies(state)).toHaveLength(1);
    hold.release();
    await screen.findByTestId("proportional-result");
    expect(reservationBodies(state)).toHaveLength(1);
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
    expect(reservationBodies(state)[0]!.tenders).toEqual([{ method: "CASH", role: "BALANCE", source: "NEW" }]);
    expect(checkoutBodies(state)[0]!.tenders).toEqual([{ method: "CASH", receivedAmount: "60000" }]);
  });

  it("exige una sesión de caja abierta incluso para un cobro sin efectivo", async () => {
    const state = await renderCashier({ queue: [proportionalRow()], session: "NONE" }, "CEN-V-000042", false);
    expect(await screen.findByTestId("cash-session-closed")).toHaveTextContent("Abrí una caja para poder cobrar.");
    expect(screen.queryByRole("button", { name: "Pago combinado" })).toBeNull();
    expect(button(/Cobrar/)).toBeNull();
    // Sin caja tampoco se cotiza.
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(posted(state, "/checkout/quote")).toHaveLength(0);
    expect(checkoutBodies(state)).toHaveLength(0);
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
    fireEvent.click(button(/Agregar pago/)!);
    fireEvent.change(screen.getByLabelText("Medio del importe fijo 1"), { target: { value: "TRANSFER" } });
    fireEvent.change(screen.getByLabelText("Cobro pendiente del importe fijo 1"), { target: { value: COLLECTION_ID } });
    // El importe del cobro registrado es el suyo: el panel no lo deja inventar.
    expect(screen.getByLabelText("Importe fijo 1")).toHaveValue("315");
    await waitForBalance("200,37");
    fireEvent.change(screen.getByLabelText("Recibido del saldo"), { target: { value: "200,37" } });
    await waitFor(() => expect(button(/Cobrar/)).toBeEnabled());
    fireEvent.click(button(/Cobrar/)!);
    await screen.findByTestId("proportional-result");
    // El cobro externo es dueño de su evidencia: se reserva por su id y la
    // confirmación no repite referencia ni institución manuales.
    expect(reservationBodies(state)[0]!.tenders).toEqual([
      { method: "TRANSFER", role: "FIXED", source: "COLLECTION", amount: "31500", externalCollectionId: COLLECTION_ID },
      { method: "CASH", role: "BALANCE", source: "NEW" },
    ]);
    expect(checkoutBodies(state)[0]!.tenders).toEqual([
      { method: "TRANSFER" },
      { method: "CASH", receivedAmount: "20037" },
    ]);
  });

  it("no cobra sin la referencia que el servidor exige en un saldo no-efectivo", async () => {
    const state = await renderCashier({ queue: [proportionalRow()] }, "CEN-V-000042");
    await waitFor(() => expect(proportionalTotal()).toHaveTextContent("515,37"));
    await changeBalanceMethod("CARD_DEBIT");
    await addCashFixed("200,37", "300,37");
    await waitForBalance("315");
    expect(button(/Cobrar/)).toBeDisabled();
    expect(screen.getByTestId("proportional-blocker")).toHaveTextContent("Ingresá el N.º de operación del pago restante.");
    // Y aun forzando el clic no sale ninguna reserva ni checkout.
    fireEvent.click(button(/Cobrar/) ?? screen.getByTestId("proportional-panel"));
    expect(reservationBodies(state)).toHaveLength(0);
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

  describe("CHECKOUT_QUOTE_CHANGED (rechazo definitivo de la reserva, sin escrituras)", () => {
    const changed = { total: "60000", balance: "39963" };
    const disabledOrAbsent = () => button(/Cobrar/)?.hasAttribute("disabled") ?? true;

    it("suelta la cotización, recotiza el total nuevo y exige un nuevo Cobrar explícito", async () => {
      const state = await renderCashier({ queue: [proportionalRow()], reservationQuoteChanged: changed }, "CEN-V-000042");
      await composePinned();
      fireEvent.click(button(/Cobrar/)!);
      // El rechazo no es un intento incierto: no hay nada que reintentar.
      expect(await screen.findByTestId("proportional-quote-changed")).toHaveTextContent("600");
      expect(button(/Reintentar el mismo cobro/)).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      // La cotización vieja ya no se puede confirmar.
      expect(disabledOrAbsent()).toBe(true);
      // Se recotiza con el draft actual y se muestra el total nuevo.
      await waitFor(() => expect(proportionalTotal()).toHaveTextContent("600"));
      await waitForBalance("399,63");
      // Recotizar jamás reserva ni cobra por su cuenta.
      await new Promise((resolve) => window.setTimeout(resolve, 400));
      expect(reservationBodies(state)).toHaveLength(1);
      expect(checkoutBodies(state)).toHaveLength(0);
      // Sólo una acción explícita sobre la cotización nueva cobra, con otra reserveKey.
      await waitFor(() => expect(button(/Cobrar/)).toBeEnabled());
      fireEvent.click(button(/Cobrar/)!);
      await screen.findByTestId("proportional-result");
      const [first, second] = reservationBodies(state);
      expect(reservationBodies(state)).toHaveLength(2);
      expect(second!.reserveKey).not.toBe(first!.reserveKey);
      expect(second!.expectedTotal).toBe("60000");
      expect(second!.expectedBalanceAmount).toBe("39963");
      expect(checkoutBodies(state)).toHaveLength(1);
      expect(checkoutBodies(state)[0]!.reserveKey).toBe(second!.reserveKey);
    });

    it("una cotización vieja que llega tarde no restaura la anterior", async () => {
      const gate = deferred();
      const state = await renderCashier({ queue: [proportionalRow()], reservationQuoteChanged: changed }, "CEN-V-000042");
      await composePinned();
      state.quoteGate = gate.promise;
      const quotesBefore = posted(state, "/checkout/quote").length;
      fireEvent.click(button(/Cobrar/)!);
      await screen.findByTestId("proportional-quote-changed");
      // La recotización queda retenida; el cajero cambia el importe fijo y esa lectura llega primero.
      await waitFor(() => expect(posted(state, "/checkout/quote").length).toBeGreaterThan(quotesBefore));
      fireEvent.change(screen.getByLabelText("Importe fijo 1"), { target: { value: "250" } });
      await waitForBalance("350");
      // Ahora llega la respuesta retenida (importe fijo 200,37 => saldo 399,63): se descarta.
      gate.release();
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      expect(proportionalBalance()).toHaveTextContent("350");
      expect(reservationBodies(state)).toHaveLength(1);
      expect(checkoutBodies(state)).toHaveLength(0);
    });

    it("cerrar la caja durante la recotización descarta la respuesta", async () => {
      const gate = deferred();
      const state = await renderCashier({ queue: [proportionalRow()], reservationQuoteChanged: changed }, "CEN-V-000042");
      await composePinned();
      state.quoteGate = gate.promise;
      const quotesBefore = posted(state, "/checkout/quote").length;
      fireEvent.click(button(/Cobrar/)!);
      await screen.findByTestId("proportional-quote-changed");
      await waitFor(() => expect(posted(state, "/checkout/quote").length).toBeGreaterThan(quotesBefore));
      state.session = "NONE";
      fireEvent.click(button(/Actualizar/)!);
      expect(await screen.findByTestId("cash-session-closed")).toBeInTheDocument();
      gate.release();
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      // Reabierta la caja, no reaparece la cotización retenida: se lee de nuevo.
      state.session = "OPEN";
      fireEvent.click(button(/Actualizar/)!);
      await waitFor(() => expect(screen.queryByTestId("cash-session-closed")).toBeNull());
      expect(screen.queryByTestId("proportional-total")).toBeNull();
      await waitFor(() => expect(proportionalTotal()).toHaveTextContent("600"));
      expect(reservationBodies(state)).toHaveLength(1);
      expect(checkoutBodies(state)).toHaveLength(0);
    });

    it("cambiar de venta durante la recotización descarta la respuesta y no deja intento", async () => {
      const gate = deferred();
      const state = await renderCashier(
        { queue: [proportionalRow(), otherRow()], reservationQuoteChanged: changed },
        "CEN-V-000042",
      );
      await composePinned();
      state.quoteGate = gate.promise;
      const quotesBefore = posted(state, "/checkout/quote").length;
      fireEvent.click(button(/Cobrar/)!);
      await screen.findByTestId("proportional-quote-changed");
      await waitFor(() => expect(posted(state, "/checkout/quote").length).toBeGreaterThan(quotesBefore));
      fireEvent.click(screen.getByRole("button", { name: /CEN-V-000043/ }));
      await screen.findByRole("heading", { name: "CEN-V-000043" });
      openCombined();
      await waitFor(() => expect(proportionalTotal()).toHaveTextContent("100"));
      gate.release();
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      expect(proportionalTotal()).toHaveTextContent("100");
      // La primera venta vuelve sin intento incierto: cotiza de nuevo y cobra con una reserva nueva.
      fireEvent.click(screen.getByRole("button", { name: /CEN-V-000042/ }));
      await screen.findByRole("heading", { name: "CEN-V-000042" });
      expect(button(/Reintentar el mismo cobro/)).toBeNull();
      openCombined();
      await waitFor(() => expect(proportionalTotal()).toHaveTextContent("600"));
      expect(reservationBodies(state)).toHaveLength(1);
    });
  });

  describe("contexto del intento incierto (misma venta, sucursal y sesión de caja)", () => {
    const OTHER_SESSION_ID = "77777777-7777-4777-8777-777777777777";
    const retryButton = () => button(/Reintentar el mismo cobro/);
    const contextNote = () => screen.queryByTestId("proportional-attempt-context");
    const traffic = (state: ServerState) => [reservationBodies(state).length, checkoutBodies(state).length];
    const settle = () => new Promise((resolve) => window.setTimeout(resolve, 150));

    // Deja un intento UNCERTAIN en la fase pedida, con la sesión SESSION_ID de CEN.
    async function uncertain(phase: "RESERVATION" | "CONFIRMATION", partial: Partial<ServerState> = {}) {
      const state = await renderCashier(
        {
          queue: [proportionalRow()],
          branchIds: ["CEN", "SUR"],
          ...(phase === "RESERVATION" ? { reservationFail: "network" as const } : { checkoutFail: "network" as const }),
          ...partial,
        },
        "CEN-V-000042",
      );
      await composePinned();
      fireEvent.click(button(/Cobrar/)!);
      await screen.findByRole("alert");
      expect(retryButton()).toBeEnabled();
      return state;
    }
    const heal = (state: ServerState) => {
      state.reservationFail = undefined;
      state.checkoutFail = undefined;
      state.replayed = true;
    };

    it.each(["RESERVATION", "CONFIRMATION"] as const)(
      "%s: si se cierra la caja y se abre otra sesión no se puede reintentar el intento viejo",
      async (phase) => {
        const state = await uncertain(phase);
        const before = traffic(state);

        state.session = "NONE";
        fireEvent.click(button(/Actualizar/)!);
        await screen.findByRole("heading", { name: "Caja cerrada" });
        state.session = "OPEN";
        state.sessionId = OTHER_SESSION_ID;
        fireEvent.click(button(/Actualizar/)!);
        await screen.findByRole("heading", { name: "Caja abierta" });

        // El intento sigue a la vista (puede ser un cobro real), pero no se reenvía.
        expect(screen.getByRole("alert")).toBeInTheDocument();
        expect(contextNote()).toHaveTextContent(/otra caja o sucursal/i);
        expect(retryButton()).toBeDisabled();
        heal(state);
        fireEvent.click(retryButton()!);
        await settle();
        expect(traffic(state)).toEqual(before);
        expect(screen.queryByTestId("proportional-result")).toBeNull();
      },
    );

    it.each(["RESERVATION", "CONFIRMATION"] as const)(
      "%s: al cambiar de sucursal no se reintenta, y al volver al mismo contexto sí",
      async (phase) => {
        const state = await uncertain(phase);
        const before = traffic(state);

        fireEvent.change(screen.getByLabelText("Sucursal autorizada"), { target: { value: "SUR" } });
        await screen.findByRole("heading", { name: "Caja abierta" });
        await screen.findByRole("heading", { name: "CEN-V-000042" });
        expect(contextNote()).toHaveTextContent(/otra caja o sucursal/i);
        expect(retryButton()).toBeDisabled();
        heal(state);
        await settle();
        expect(traffic(state)).toEqual(before);

        // Mismo branch y misma sesión: el reintento vuelve a estar permitido, con el mismo cuerpo.
        fireEvent.change(screen.getByLabelText("Sucursal autorizada"), { target: { value: "CEN" } });
        await waitFor(() => expect(contextNote()).toBeNull());
        await waitFor(() => expect(retryButton()).toBeEnabled());
        fireEvent.click(retryButton()!);
        await screen.findByTestId("proportional-result");
        expect(reservationBodies(state)[0]!.reserveKey).toBe(reservationBodies(state).at(-1)!.reserveKey);
      },
    );

    it.each(["RESERVATION", "CONFIRMATION"] as const)(
      "%s: refrescar la misma sesión de caja (objeto nuevo) no invalida el reintento",
      async (phase) => {
        const state = await uncertain(phase);
        fireEvent.click(button(/Actualizar/)!);
        await settle();
        fireEvent.click(button(/Actualizar/)!);
        await settle();
        expect(contextNote()).toBeNull();
        expect(retryButton()).toBeEnabled();
        heal(state);
        fireEvent.click(retryButton()!);
        await screen.findByTestId("proportional-result");
        // Misma reserveKey en todo el intento: nunca una reserva nueva.
        expect(new Set(reservationBodies(state).map((reservation) => reservation.reserveKey)).size).toBe(1);
      },
    );
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
