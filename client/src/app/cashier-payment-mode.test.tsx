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
// transferencia 47.500, débito 48.125, crédito 51.750, QR +12% = 50.400.
const PRICES = { CASH: "4500000", TRANSFER: "4750000", CARD_DEBIT: "4812500", CARD_CREDIT: "5175000", QR: "5040000" } as const;
// La lista mayorista (wholesalePrice) con los mismos ajustes: efectivo 30.000, crédito +15% = 34.500.
const WHOLESALE_PRICES = { CASH: "3000000", TRANSFER: "3300000", CARD_DEBIT: "3150000", CARD_CREDIT: "3450000", QR: "3360000" } as const;

type Method = keyof typeof PRICES;
type QuoteRequest = { balanceMethod: Method; tenders: Array<{ method: Method; amount: string }> };
type CheckoutBody = {
  operationKey: string; cashSessionId: string; balanceMethod: string; expectedTotal: string; expectedBalanceAmount: string;
  tenders: Array<Record<string, unknown>>;
};
type ReservationBody = {
  reserveKey: string;
  cashSessionId: string;
  balanceMethod: Method;
  expectedTotal: string;
  expectedBalanceAmount: string;
  tenders: Array<{
    method: Method;
    role: "FIXED" | "BALANCE";
    source: "NEW" | "COLLECTION";
    amount?: string;
    externalCollectionId?: string;
  }>;
};

type ConfirmationBody = {
  reserveKey: string;
  operationKey: string;
  tenders: Array<Record<string, unknown>>;
};
type Row = Record<string, unknown>;
type ServerState = {
  queue: Row[];
  cashOpen?: boolean;
  // Retiene la PRÓXIMA lectura de /cash/current (se consume al usarla).
  cashGate?: Promise<void>;
  cashFail?: boolean;
  branchIds?: string[];
  quoteGate?: Promise<void>;
  quoteFail?: { status: number; body: unknown };
  reservationFailures?: number;
  confirmationFailures?: number;
  lastReservation?: ReservationBody;
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
  const prices = sale.pricingMode === "WHOLESALE" ? WHOLESALE_PRICES : PRICES;
  const total = body.tenders.length === 0 ? prices[body.balanceMethod] : prices.CASH;
  return {
    saleId: sale.saleId, saleNumber: sale.saleNumber, pricingModel: "PROPORTIONAL_V1",
    enabledMethods: (["CASH", "TRANSFER", "CARD_DEBIT", "CARD_CREDIT", "QR"] as const).map((method) => (
      state.unavailable?.includes(method)
        ? { method, available: false, reason: "PRICING_CONFIG_MISSING" }
        : { method, available: true }
    )),
    fullPrices: { ...prices },
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
    if (url.includes("/auth/me")) return jsonResponse({ user: { ...cashier, branchIds: state.branchIds ?? cashier.branchIds } });
    if (url.includes("/sales/pending")) return jsonResponse({ items: state.queue });
    if (url.endsWith("/checkout/quote")) {
      if (state.quoteFail) return jsonResponse(state.quoteFail.body, state.quoteFail.status);
      if (state.quoteGate) await state.quoteGate;
      return jsonResponse(quoteFor(state.queue[0]!, body as unknown as QuoteRequest, state));
    }

    if (url.endsWith("/checkout/reservations") && method === "POST") {
      if ((state.reservationFailures ?? 0) > 0) {
        state.reservationFailures = (state.reservationFailures ?? 0) - 1;
        return jsonResponse({
          error: {
            code: "TEMPORARY_FAILURE",
            message: "Se perdió la respuesta de la reserva.",
          },
        }, 503);
      }

      const reservation = body as {
        reserveKey: string;
        cashSessionId: string;
        balanceMethod: Method;
        expectedTotal: string;
        expectedBalanceAmount: string;
        tenders: Array<{
          method: Method;
          role: "FIXED" | "BALANCE";
          source: "NEW" | "COLLECTION";
          amount?: string;
          externalCollectionId?: string;
        }>;
      };

      state.lastReservation = reservation as ReservationBody;

      return jsonResponse({
        reserveKey: reservation.reserveKey,
        operationKey: "44444444-4444-4444-8444-444444444444",
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
            amount: tender.amount ?? null,
            externalCollectionId: tender.externalCollectionId ?? null,
          })),
          fullPrices: { ...PRICES },
        },
        recovery: null,
        rejection: null,
        declaration: null,
        declared: false,
        stockState: "VALID",
        stockExpiresAt: "2030-01-01T01:00:00.000Z",
      }, 201);
    }

    if (url.endsWith("/checkout") && method === "POST") {
      if ((state.confirmationFailures ?? 0) > 0) {
        state.confirmationFailures = (state.confirmationFailures ?? 0) - 1;

        return jsonResponse({
          error: {
            code: "TEMPORARY_FAILURE",
            message: "Se perdió la respuesta de la confirmación.",
          },
        }, 503);
      }

      const confirmation = body as {
        reserveKey?: string;
        operationKey?: string;
        tenders?: Array<Record<string, unknown>>;
      };

      if (confirmation.reserveKey && confirmation.operationKey) {
        const reservation = state.lastReservation;

        if (!reservation) {
          return jsonResponse({
            error: { code: "TEST_FIXTURE_ERROR", message: "Falta la reserva previa." },
          }, 500);
        }

        const sale = state.queue[0]!;
        const confirmationBody = confirmation as ConfirmationBody;

        const payments = reservation.tenders.map((reserved, index) => {
          const evidence = confirmationBody.tenders[index] ?? {};
          const amount =
            reserved.role === "FIXED"
              ? reserved.amount!
              : reservation.expectedBalanceAmount;

          const receivedAmount =
            reserved.method === "CASH"
              ? typeof evidence.receivedAmount === "string"
                ? evidence.receivedAmount
                : amount
              : null;

          const changeAmount =
            receivedAmount === null
              ? null
              : (BigInt(receivedAmount) - BigInt(amount)).toString();

          return {
            id: `pay-${index + 1}`,
            method: reserved.method,
            tenderRole: reserved.role,
            amount,
            methodFullPrice: amount,
            adjustmentBps: 0,
            externalCollectionId: reserved.externalCollectionId ?? null,
            receivedAmount,
            changeAmount,
          };
        });

        const changeAmount = payments
          .reduce(
            (sum, payment) => sum + BigInt(payment.changeAmount ?? "0"),
            BigInt(0),
          )
          .toString();

        return jsonResponse({
          saleId: SALE_ID,
          saleNumber: sale.saleNumber,
          status: "COMPLETED",
          checkoutId: "checkout-1",
          replayed: false,
          total: reservation.expectedTotal,
          changeAmount,
          payments,
          lines: (sale.items as Row[]).map((line) => ({
            saleItemId: line.id,
            sku: line.sku,
            quantity: line.quantity,
            finalAmount: reservation.expectedTotal,
          })),
          completedAt: "2030-01-01T00:00:00.000Z",
        }, 201);
      }

      return jsonResponse(
        checkoutFor(state.queue[0]!, body as unknown as CheckoutBody),
        201,
      );
    }
    if (url.includes("/cash/current")) {
      const cashGate = state.cashGate;
      state.cashGate = undefined;
      if (cashGate) await cashGate;
      if (state.cashFail) return jsonResponse({ error: { code: "CASH_UNAVAILABLE", message: "No se pudo leer la caja." } }, 500);
      if (state.cashOpen === false) return jsonResponse(null);

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
const reservations = (state: ServerState) =>
  state.requests.filter((request) =>
    request.url.endsWith(`/sales/${SALE_ID}/checkout/reservations`)
  );

const checkouts = (state: ServerState) =>
  state.requests.filter((request) =>
    request.url.endsWith(`/sales/${SALE_ID}/checkout`)
  );

const lastReservation = (state: ServerState) =>
  reservations(state).at(-1)!.body as ReservationBody;

const lastConfirmation = (state: ServerState) =>
  checkouts(state).at(-1)!.body as ConfirmationBody;

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
    expect(button(/Agregar pago/)).toBeNull();
  });

  it("UI-2 en Pago simple ofrece Efectivo, Transferencia y Débito con su precio y nada del constructor combinado", async () => {
    await renderCashier();
    expect(await screen.findByRole("button", { name: /Efectivo.*45\.000/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Transferencia.*47\.500/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Débito.*48\.125/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Crédito.*51\.750/ })).toBeInTheDocument();
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

  it("UI-CREDIT-1 aparece Crédito en Pago simple y como opción dentro de Pago combinado", async () => {
    await renderCashier();
    expect(await screen.findByRole("button", { name: /Crédito/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    const balance = screen.getByLabelText("Medio de saldo");
    expect(within(balance).getByRole("option", { name: "Tarjeta de crédito" })).toBeInTheDocument();
    fireEvent.click(button(/Agregar pago/)!);
    expect(within(screen.getByLabelText("Medio del importe fijo 1")).getByRole("option", { name: "Tarjeta de crédito" })).toBeInTheDocument();
  });

  it("UI-CREDIT-2 el precio de Crédito sale de quote.fullPrices y se muestra junto al de los otros medios", async () => {
    await renderCashier();
    expect(await screen.findByRole("button", { name: /Crédito.*51\.750/ })).toBeInTheDocument();
    for (const [name, price] of [["Efectivo", "45\\.000"], ["Transferencia", "47\\.500"], ["Débito", "48\\.125"]] as const) {
      expect(screen.getByRole("button", { name: new RegExp(`${name}.*${price}`) })).toBeInTheDocument();
    }
  });

  it("UI-CREDIT-3 Pago simple + Crédito cotiza sin importes fijos, exige solo la referencia (sin institución) y cobra con balanceMethod CARD_CREDIT", async () => {
    const state = await renderCashier();
    await chooseSimple(/Crédito.*51\.750/, "51.750");
    expect(lastQuote(state)).toEqual({ balanceMethod: "CARD_CREDIT", tenders: [] });
    expect(screen.queryByLabelText("Institución")).toBeNull();
    expect(screen.queryByLabelText("Recibido")).toBeNull();
    expect(button(/^Cobrar/)).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Referencia"), { target: { value: "CRD0042" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    fireEvent.click(button(/^Cobrar/)!);
    await screen.findByTestId("proportional-result");
    const reservation = lastReservation(state);
    const confirmation = lastConfirmation(state);
    expect(reservation).toMatchObject({
      balanceMethod: "CARD_CREDIT",
      expectedTotal: PRICES.CARD_CREDIT,
      cashSessionId: SESSION_ID,
    });
    expect(reservation.tenders[0]).toMatchObject({
      method: "CARD_CREDIT",
      role: "BALANCE",
      source: "NEW",
    });
    expect(confirmation.tenders[0]).toMatchObject({
      method: "CARD_CREDIT",
      reference: "CRD0042",
    });
    expect(confirmation.tenders[0]).not.toHaveProperty("institution");
  });

  it("UI-CREDIT-4 Pago combinado permite Crédito: efectivo fijo + saldo en crédito (y crédito fijo con saldo en efectivo)", async () => {
    const state = await renderCashier();
    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: "CARD_CREDIT" } });
    fireEvent.click(button(/Agregar pago/)!);
    fireEvent.change(screen.getByLabelText("Medio del importe fijo 1"), { target: { value: "CASH" } });
    fireEvent.change(screen.getByLabelText("Importe fijo 1"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Recibido del importe fijo 1"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "CRD0043" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    expect(lastQuote(state)).toEqual({ balanceMethod: "CARD_CREDIT", tenders: [{ method: "CASH", amount: "10000" }] });
    expect(screen.queryByLabelText("Institución del saldo")).toBeNull();
    // Crédito como importe fijo: pide su referencia, sin institución.
    fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: "CASH" } });
    fireEvent.change(screen.getByLabelText("Medio del importe fijo 1"), { target: { value: "CARD_CREDIT" } });
    expect(screen.getByLabelText("Referencia del importe fijo 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Institución del importe fijo 1")).toBeNull();
  });

  it("UI-CREDIT-5 un Crédito sin configuración de precios queda deshabilitado y no se ofrece como saldo", async () => {
    await renderCashier({ unavailable: ["CARD_CREDIT"] });
    expect(await screen.findByRole("button", { name: /Efectivo.*45\.000/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Crédito/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    expect(within(screen.getByLabelText("Medio de saldo")).getByRole("option", { name: "Tarjeta de crédito" })).toBeDisabled();
  });

  it("UI-CREDIT-6 mayorista: el precio de Crédito es el que el servidor calcula sobre la lista mayorista", async () => {
    const state = await renderCashier({ queue: [row({ pricingMode: "WHOLESALE", wholesaleConfirmed: true })] });
    expect(await screen.findByRole("button", { name: /Crédito.*34\.500/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Efectivo.*30\.000/ })).toBeInTheDocument();
    await chooseSimple(/Crédito.*34\.500/, "34.500");
    fireEvent.change(screen.getByLabelText("Referencia"), { target: { value: "CRD0044" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    fireEvent.click(button(/^Cobrar/)!);
    await screen.findByTestId("proportional-result");
    expect(lastReservation(state).expectedTotal).toBe(WHOLESALE_PRICES.CARD_CREDIT);
  });

  it("UI-QR-1 aparece QR en Pago simple y como opción dentro de Pago combinado (saldo e importe fijo)", async () => {
    await renderCashier();
    expect(await screen.findByRole("button", { name: /QR.*50\.400/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    expect(within(screen.getByLabelText("Medio de saldo")).getByRole("option", { name: "QR" })).toBeInTheDocument();
    fireEvent.click(button(/Agregar pago/)!);
    expect(within(screen.getByLabelText("Medio del importe fijo 1")).getByRole("option", { name: "QR" })).toBeInTheDocument();
  });

  it("UI-QR-2 Pago simple + QR cotiza sin importes fijos, exige solo la referencia (sin institución ni recibido) y cobra con balanceMethod QR", async () => {
    const state = await renderCashier();
    await chooseSimple(/QR.*50\.400/, "50.400");
    expect(lastQuote(state)).toEqual({ balanceMethod: "QR", tenders: [] });
    expect(screen.queryByLabelText("Institución")).toBeNull();
    expect(screen.queryByLabelText("Recibido")).toBeNull();
    expect(button(/^Cobrar/)).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Referencia"), { target: { value: "QR0042" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    fireEvent.click(button(/^Cobrar/)!);
    await screen.findByTestId("proportional-result");
    const reservation = lastReservation(state);
    const confirmation = lastConfirmation(state);
    expect(reservation).toMatchObject({
      balanceMethod: "QR",
      expectedTotal: PRICES.QR,
      cashSessionId: SESSION_ID,
    });
    expect(reservation.tenders[0]).toMatchObject({
      method: "QR",
      role: "BALANCE",
      source: "NEW",
    });
    expect(confirmation.tenders[0]).toMatchObject({
      method: "QR",
      reference: "QR0042",
    });
    expect(confirmation.tenders[0]).not.toHaveProperty("institution");
    expect(confirmation.tenders[0]).not.toHaveProperty("receivedAmount");
  });

  it("UI-QR-3 Pago combinado permite QR: efectivo fijo + saldo en QR (y QR fijo con saldo en efectivo)", async () => {
    const state = await renderCashier();
    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: "QR" } });
    fireEvent.click(button(/Agregar pago/)!);
    fireEvent.change(screen.getByLabelText("Medio del importe fijo 1"), { target: { value: "CASH" } });
    fireEvent.change(screen.getByLabelText("Importe fijo 1"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Recibido del importe fijo 1"), { target: { value: "100" } });
    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "QR0043" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    expect(lastQuote(state)).toEqual({ balanceMethod: "QR", tenders: [{ method: "CASH", amount: "10000" }] });
    expect(screen.queryByLabelText("Institución del saldo")).toBeNull();
    // QR como importe fijo: pide su referencia, sin institución.
    fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: "CASH" } });
    fireEvent.change(screen.getByLabelText("Medio del importe fijo 1"), { target: { value: "QR" } });
    expect(screen.getByLabelText("Referencia del importe fijo 1")).toBeInTheDocument();
    expect(screen.queryByLabelText("Institución del importe fijo 1")).toBeNull();
  });

  it("UI-QR-4 un QR sin configuración de precios queda deshabilitado y no se ofrece como saldo", async () => {
    await renderCashier({ unavailable: ["QR"] });
    expect(await screen.findByRole("button", { name: /Efectivo.*45\.000/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /QR/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    expect(within(screen.getByLabelText("Medio de saldo")).getByRole("option", { name: "QR" })).toBeDisabled();
  });

  it("UI-QR-5 mayorista: el precio de QR es el que el servidor calcula sobre la lista mayorista", async () => {
    const state = await renderCashier({ queue: [row({ pricingMode: "WHOLESALE", wholesaleConfirmed: true })] });
    expect(await screen.findByRole("button", { name: /QR.*33\.600/ })).toBeInTheDocument();
    await chooseSimple(/QR.*33\.600/, "33.600");
    fireEvent.change(screen.getByLabelText("Referencia"), { target: { value: "QR0044" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    fireEvent.click(button(/^Cobrar/)!);
    await screen.findByTestId("proportional-result");
    expect(lastReservation(state).expectedTotal).toBe(WHOLESALE_PRICES.QR);
  });




  it("PROD-CASH-03 reutiliza reserveKey, operationKey y body si falla la confirmación", async () => {
    const state = await renderCashier({ confirmationFailures: 1 });

    await chooseSimple(/Efectivo.*45\.000/, "45.000");

    fireEvent.change(screen.getByLabelText("Recibido"), {
      target: { value: "50000" },
    });

    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());

    fireEvent.click(button(/^Cobrar/)!);

    const retryButton = await screen.findByRole("button", {
      name: "Reintentar el mismo cobro",
    });

    const confirmationsBefore = state.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.endsWith(`/sales/${SALE_ID}/checkout`)
    );

    expect(confirmationsBefore).toHaveLength(1);

    const firstBody = confirmationsBefore[0]!.body as Record<string, unknown>;

    fireEvent.click(retryButton);

    await screen.findByTestId("proportional-result");

    const confirmationsAfter = state.requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.endsWith(`/sales/${SALE_ID}/checkout`)
    );

    expect(confirmationsAfter).toHaveLength(2);

    const secondBody = confirmationsAfter[1]!.body as Record<string, unknown>;

    expect(secondBody).toEqual(firstBody);
    expect(secondBody.reserveKey).toBe(firstBody.reserveKey);
    expect(secondBody.operationKey).toBe(firstBody.operationKey);
  });

  it("PROD-CASH-02 reutiliza la misma reserveKey si falla la respuesta de la reserva", async () => {
    const state = await renderCashier({ reservationFailures: 1 });

    await chooseSimple(/Efectivo.*45\.000/, "45.000");
    fireEvent.change(screen.getByLabelText("Recibido"), {
      target: { value: "50000" },
    });

    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());

    fireEvent.click(button(/^Cobrar/)!);

    await waitFor(() => {
      const reservations = state.requests.filter((request) =>
        request.url.endsWith(`/sales/${SALE_ID}/checkout/reservations`)
      );
      expect(reservations).toHaveLength(1);
    });

    const retryButton = await screen.findByRole("button", {
      name: "Reintentar el mismo cobro",
    });

    fireEvent.click(retryButton);

    await screen.findByTestId("proportional-result");

    const reservations = state.requests.filter((request) =>
      request.url.endsWith(`/sales/${SALE_ID}/checkout/reservations`)
    );

    expect(reservations).toHaveLength(2);

    const first = reservations[0]!.body as { reserveKey: string };
    const second = reservations[1]!.body as { reserveKey: string };

    expect(second.reserveKey).toBe(first.reserveKey);
  });

  it("PROD-CASH-01 reserva el cobro antes de confirmarlo", async () => {
    const state = await renderCashier();

    await chooseSimple(/Efectivo.*45\.000/, "45.000");
    fireEvent.change(screen.getByLabelText("Recibido"), {
      target: { value: "50000" },
    });

    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    fireEvent.click(button(/^Cobrar/)!);

    await waitFor(() => {
      const writes = state.requests.filter((request) =>
        request.url.includes(`/sales/${SALE_ID}/checkout`)
      );

      expect(
        writes.some((request) =>
          request.url.endsWith(`/sales/${SALE_ID}/checkout/reservations`)
        ),
      ).toBe(true);
    });

    const writes = state.requests.filter((request) =>
      request.url.includes(`/sales/${SALE_ID}/checkout`)
    );

    const quoteIndex = writes.findIndex((request) =>
      request.url.endsWith("/checkout/quote")
    );
    const reservationIndex = writes.findIndex((request) =>
      request.url.endsWith("/checkout/reservations")
    );
    const confirmationIndex = writes.findIndex((request) =>
      request.url.endsWith(`/sales/${SALE_ID}/checkout`)
    );

    expect(quoteIndex).toBeGreaterThanOrEqual(0);
    expect(reservationIndex).toBeGreaterThan(quoteIndex);
    expect(confirmationIndex).toBeGreaterThan(reservationIndex);
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
    const reservation = lastReservation(state);
    const confirmation = lastConfirmation(state);
    expect(reservation).toMatchObject({
      balanceMethod: "CASH",
      expectedTotal: PRICES.CASH,
      cashSessionId: SESSION_ID,
    });
    expect(reservation.tenders[0]).toMatchObject({
      method: "CASH",
      role: "BALANCE",
      source: "NEW",
    });
    expect(confirmation.tenders[0]).toMatchObject({
      method: "CASH",
      receivedAmount: "5000000",
    });
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
    const reservation = lastReservation(state);
    const confirmation = lastConfirmation(state);
    expect(reservation).toMatchObject({
      balanceMethod: "TRANSFER",
      expectedTotal: PRICES.TRANSFER,
    });
    expect(reservation.tenders[0]).toMatchObject({
      method: "TRANSFER",
      role: "BALANCE",
      source: "NEW",
    });
    expect(confirmation.tenders[0]).toMatchObject({
      method: "TRANSFER",
      reference: "TRF12345",
      institution: "GALICIA",
    });
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
    const reservation = lastReservation(state);
    const confirmation = lastConfirmation(state);
    expect(reservation).toMatchObject({
      balanceMethod: "CARD_DEBIT",
      expectedTotal: PRICES.CARD_DEBIT,
    });
    expect(reservation.tenders[0]).toMatchObject({
      method: "CARD_DEBIT",
      role: "BALANCE",
      source: "NEW",
    });
    expect(confirmation.tenders[0]).toMatchObject({
      method: "CARD_DEBIT",
      reference: "DEB0099",
    });
  });





  it("PROD-CASH-PERF-01 escribir evidencia no vuelve a cotizar si no cambia la composición", async () => {
    const state = await renderCashier();

    await chooseSimple(/Transferencia.*47\.500/, "47.500");

    const before = quotes(state).length;

    fireEvent.change(
      screen.getByLabelText("Referencia"),
      { target: { value: "TRF-000123" } },
    );

    fireEvent.change(
      screen.getByLabelText("Institución"),
      { target: { value: "MACRO" } },
    );

    await new Promise((resolve) => window.setTimeout(resolve, 350));

    expect(quotes(state)).toHaveLength(before);
  });

  it("PROD-CASH-UX-03 con caja cerrada no permite preparar ningún cobro", async () => {
    const state = await renderCashier({ cashOpen: false });

    const closed = await screen.findByTestId("cash-session-closed");
    expect(closed).toHaveTextContent("Caja cerrada");
    expect(closed).toHaveTextContent("Abrí una caja para poder cobrar.");

    expect(
      screen.queryByRole("group", { name: "Tipo de cobro" }),
    ).toBeNull();

    expect(
      screen.queryByRole("button", { name: /^Cobrar/ }),
    ).toBeNull();

    await new Promise((resolve) => window.setTimeout(resolve, 300));

    expect(quotes(state)).toHaveLength(0);
    expect(reservations(state)).toHaveLength(0);
    expect(checkouts(state)).toHaveLength(0);
  });

  it("PROD-CASH-UX-04 explica exactamente qué falta en una transferencia combinada", async () => {
    await renderCashier();

    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });

    fireEvent.click(
      screen.getByRole("button", { name: "Pago combinado" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Agregar pago/i }),
    );

    fireEvent.change(
      screen.getByLabelText("Medio del importe fijo 1"),
      { target: { value: "TRANSFER" } },
    );

    fireEvent.change(
      screen.getByLabelText("Importe fijo 1"),
      { target: { value: "2650" } },
    );

    fireEvent.change(
      screen.getByLabelText("Institución del importe fijo 1"),
      { target: { value: "MACRO" } },
    );

    fireEvent.change(
      screen.getByLabelText("Recibido del saldo"),
      { target: { value: "42350" } },
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          "Ingresá el N.º de operación de la transferencia del pago 1.",
        ),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /^Cobrar/ }),
    ).toBeDisabled();
  });

  // --- Evidencia de cobro (paridad con el DTO del servidor y con nonCashIssues) ---

  const openCombinedMode = async () => {
    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
  };
  const addFixed = (method: Method, amount: string) => {
    fireEvent.click(screen.getByRole("button", { name: /Agregar pago/i }));
    fireEvent.change(screen.getByLabelText("Medio del importe fijo 1"), { target: { value: method } });
    fireEvent.change(screen.getByLabelText("Importe fijo 1"), { target: { value: amount } });
  };
  const blockerText = () => screen.getByTestId("proportional-blocker");
  const expectBlocked = async (message: string) => {
    await waitFor(() => expect(blockerText()).toHaveTextContent(message));
    expect(button(/^Cobrar/)).toBeDisabled();
  };

  it("PROD-CASH-EV-01 importe fijo por transferencia: referencia, institución y «Otra» se exigen en ese orden", async () => {
    const state = await renderCashier();
    await openCombinedMode();
    addFixed("TRANSFER", "2650");
    fireEvent.change(screen.getByLabelText("Recibido del saldo"), { target: { value: "42350" } });

    await expectBlocked("Ingresá el N.º de operación de la transferencia del pago 1.");

    fireEvent.change(screen.getByLabelText("Referencia del importe fijo 1"), { target: { value: "TRF-000123" } });
    await expectBlocked("Elegí la institución de la transferencia del pago 1.");

    fireEvent.change(screen.getByLabelText("Institución del importe fijo 1"), { target: { value: "OTHER" } });
    await expectBlocked("Ingresá el nombre de la institución de la transferencia del pago 1.");

    fireEvent.change(screen.getByLabelText("Institución alternativa del importe fijo 1"), { target: { value: "Banco Provincia" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    expect(screen.queryByTestId("proportional-blocker")).toBeNull();
    expect(checkouts(state)).toHaveLength(0);
  });

  it("PROD-CASH-EV-02 una referencia en blanco no cuenta como evidencia", async () => {
    await renderCashier();
    await openCombinedMode();
    addFixed("TRANSFER", "2650");
    fireEvent.change(screen.getByLabelText("Referencia del importe fijo 1"), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("Institución del importe fijo 1"), { target: { value: "MACRO" } });
    fireEvent.change(screen.getByLabelText("Recibido del saldo"), { target: { value: "42350" } });
    await expectBlocked("Ingresá el N.º de operación de la transferencia del pago 1.");
  });

  it.each(["CARD_DEBIT", "QR"] as const)("PROD-CASH-EV-03 importe fijo %s sin referencia queda bloqueado y no pide institución", async (method) => {
    await renderCashier();
    await openCombinedMode();
    addFixed(method, "2650");
    fireEvent.change(screen.getByLabelText("Recibido del saldo"), { target: { value: "42350" } });
    await expectBlocked("Ingresá el N.º de operación del pago 1.");
    expect(screen.queryByLabelText("Institución del importe fijo 1")).toBeNull();

    fireEvent.change(screen.getByLabelText("Referencia del importe fijo 1"), { target: { value: "OP-998877" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
  });

  it("PROD-CASH-EV-04 pago restante por transferencia: referencia, institución y «Otra» se exigen", async () => {
    await renderCashier();
    await openCombinedMode();
    fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: "TRANSFER" } });

    await expectBlocked("Ingresá el N.º de operación de la transferencia del pago restante.");

    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "TRF-445566" } });
    await expectBlocked("Elegí la institución de la transferencia del pago restante.");

    fireEvent.change(screen.getByLabelText("Institución del saldo"), { target: { value: "OTHER" } });
    await expectBlocked("Ingresá el nombre de la institución de la transferencia del pago restante.");

    fireEvent.change(screen.getByLabelText("Institución alternativa del saldo"), { target: { value: "Banco Provincia" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
  });

  it.each(["CARD_DEBIT", "QR"] as const)("PROD-CASH-EV-05 pago restante %s sin referencia queda bloqueado", async (method) => {
    await renderCashier();
    await openCombinedMode();
    fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: method } });
    await expectBlocked("Ingresá el N.º de operación del pago restante.");
    expect(screen.queryByLabelText("Institución del saldo")).toBeNull();

    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "OP-112233" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
  });

  it("PROD-CASH-EV-06 el efectivo no exige referencia ni institución (simple, fijo y saldo)", async () => {
    await renderCashier();
    await chooseSimple(/Efectivo.*45\.000/, "45.000");
    expect(screen.queryByLabelText("Referencia")).toBeNull();
    expect(screen.queryByLabelText("Institución")).toBeNull();
    fireEvent.change(screen.getByLabelText("Recibido"), { target: { value: "45000" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    expect(screen.queryByTestId("proportional-blocker")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    addFixed("CASH", "1000");
    fireEvent.change(screen.getByLabelText("Recibido del importe fijo 1"), { target: { value: "1000" } });
    fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: "CARD_DEBIT" } });
    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "DEB-554433" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
    expect(screen.queryByTestId("proportional-blocker")).toBeNull();
  });

  it("PROD-CASH-EV-07 el formato de la referencia lo decide el contrato (sin alfanuméricos o demasiado corta)", async () => {
    await renderCashier();
    await openCombinedMode();
    fireEvent.change(screen.getByLabelText("Medio de saldo"), { target: { value: "CARD_DEBIT" } });
    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "---" } });
    await expectBlocked("La referencia no tiene un formato válido.");
    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "ab" } });
    await expectBlocked("La referencia no tiene un formato válido.");
    fireEvent.change(screen.getByLabelText("Referencia del saldo"), { target: { value: "OP-12" } });
    await waitFor(() => expect(button(/^Cobrar/)).toBeEnabled());
  });

  // --- Caja cerrada / abierta y cotización ---

  it("PROD-CASH-UX-05 cerrar la caja suelta la cotización, deja de cotizar y al reabrir vuelve a cotizar", async () => {
    const state = await renderCashier();
    await chooseSimple(/Efectivo.*45\.000/, "45.000");
    const before = quotes(state).length;

    state.cashOpen = false;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(await screen.findByTestId("cash-session-closed")).toBeInTheDocument();
    expect(button(/^Cobrar/)).toBeNull();
    expect(screen.queryByTestId("simple-total")).toBeNull();

    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(quotes(state)).toHaveLength(before);
    expect(checkouts(state)).toHaveLength(0);

    state.cashOpen = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() => expect(screen.queryByTestId("cash-session-closed")).toBeNull());
    await waitFor(() => expect(quotes(state).length).toBeGreaterThan(before));
    await waitForTotal("45.000");
  });

  it("PROD-CASH-UX-06 una cotización en vuelo que llega con la caja ya cerrada se descarta", async () => {
    let release!: () => void;
    const state = await renderCashier({ quoteGate: new Promise<void>((resolve) => { release = resolve; }) });
    // La cotización inicial queda retenida en el servidor.
    await waitFor(() => expect(quotes(state)).toHaveLength(1));

    state.cashOpen = false;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    expect(await screen.findByTestId("cash-session-closed")).toBeInTheDocument();

    // Llega tarde la respuesta vieja y se reabre la caja: no puede quedar una cotización fantasma.
    release();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    state.cashOpen = true;
    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() => expect(screen.queryByTestId("cash-session-closed")).toBeNull());
    expect(screen.queryByRole("button", { name: /Efectivo.*45\.000/ })).toBeNull();
    expect(button(/^Cobrar/)).toBeNull();
    // La cotización vigente es la nueva, no la vieja.
    expect(await screen.findByRole("button", { name: /Efectivo.*45\.000/ })).toBeInTheDocument();
  });

  it("PROD-CASH-PERF-02 refrescar la caja sin cambios no vuelve a cotizar ni suelta la cotización vigente", async () => {
    const state = await renderCashier();
    await chooseSimple(/Transferencia.*47\.500/, "47.500");
    const before = quotes(state).length;

    fireEvent.click(screen.getByRole("button", { name: "Actualizar" }));
    await waitFor(() => expect(state.requests.length).toBeGreaterThan(0));
    await new Promise((resolve) => window.setTimeout(resolve, 500));

    expect(quotes(state)).toHaveLength(before);
    expect(screen.getByTestId("simple-total")).toHaveTextContent("47.500");
  });

  // --- Caja: cargando ≠ cerrada ---

  const gated = () => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  };

  it("PROD-CASH-LOAD-01 mientras se consulta la caja no afirma «Caja cerrada», no deja cobrar y no cotiza", async () => {
    const gate = gated();
    const state = await renderCashier({ cashGate: gate.promise });

    expect(screen.getByTestId("cash-session-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("cash-session-closed")).toBeNull();
    expect(screen.queryByText("Caja cerrada")).toBeNull();
    expect(screen.queryByRole("group", { name: "Tipo de cobro" })).toBeNull();
    expect(button(/^Cobrar/)).toBeNull();
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(quotes(state)).toHaveLength(0);

    gate.release();
    expect(await screen.findByRole("group", { name: "Tipo de cobro" })).toBeInTheDocument();
    expect(screen.queryByTestId("cash-session-loading")).toBeNull();
    expect(screen.getByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
  });

  it("PROD-CASH-LOAD-02 la respuesta que confirma que no hay sesión sí muestra «Caja cerrada»", async () => {
    const gate = gated();
    await renderCashier({ cashOpen: false, cashGate: gate.promise });
    expect(screen.queryByText("Caja cerrada")).toBeNull();

    gate.release();
    expect(await screen.findByTestId("cash-session-closed")).toHaveTextContent("Abrí una caja para poder cobrar.");
    expect(screen.queryByTestId("cash-session-loading")).toBeNull();
    expect(screen.getByRole("heading", { name: "Caja cerrada" })).toBeInTheDocument();
  });

  it("PROD-CASH-LOAD-03 si la lectura de la caja falla no afirma que está cerrada ni deja cobrar", async () => {
    await renderCashier({ cashFail: true });
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(screen.queryByText("Caja cerrada")).toBeNull();
    expect(screen.queryByTestId("cash-session-closed")).toBeNull();
    expect(screen.queryByRole("group", { name: "Tipo de cobro" })).toBeNull();
    expect(button(/^Cobrar/)).toBeNull();
  });

  it("PROD-CASH-LOAD-04 al cambiar de sucursal la sesión anterior no sirve y no aparece una caja cerrada falsa", async () => {
    const state = await renderCashier({ branchIds: ["CEN", "SUR"] });
    expect(await screen.findByRole("group", { name: "Tipo de cobro" })).toBeInTheDocument();
    await waitFor(() => expect(quotes(state).length).toBeGreaterThan(0));
    const before = quotes(state).length;

    const gate = gated();
    state.cashGate = gate.promise;
    fireEvent.change(screen.getByLabelText("Sucursal autorizada"), { target: { value: "SUR" } });

    // Mientras se lee la caja de SUR: ni la sesión de CEN ni un cartel de cerrada.
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Caja abierta" })).toBeNull());
    expect(screen.queryByText("Caja cerrada")).toBeNull();
    expect(screen.queryByTestId("cash-session-closed")).toBeNull();
    expect(screen.queryByRole("group", { name: "Tipo de cobro" })).toBeNull();
    expect(button(/^Cobrar/)).toBeNull();
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(quotes(state)).toHaveLength(before);
    expect(reservations(state)).toHaveLength(0);

    gate.release();
    expect(await screen.findByRole("heading", { name: "Caja abierta" })).toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "Tipo de cobro" })).toBeInTheDocument();
  });

  it("PROD-CASH-UX-02 muestra cuánto efectivo falta y bloquea Cobrar", async () => {
    await renderCashier();

    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });

    fireEvent.click(
      screen.getByRole("button", { name: "Pago combinado" }),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Agregar pago/i }),
    );

    fireEvent.change(
      screen.getByLabelText("Medio del importe fijo 1"),
      { target: { value: "CARD_DEBIT" } },
    );

    fireEvent.change(
      screen.getByLabelText("Importe fijo 1"),
      { target: { value: "1059" } },
    );

    fireEvent.change(
      screen.getByLabelText("Referencia del importe fijo 1"),
      { target: { value: "DEB1059" } },
    );

    fireEvent.change(
      screen.getByLabelText("Recibido del saldo"),
      { target: { value: "43940" } },
    );

    await waitFor(() => {
      expect(
        screen.getByText(/faltan \$ 1/i),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole("button", { name: /^Cobrar/ }),
    ).toBeDisabled();
  });

  it("PROD-CASH-UX-01 Pago combinado usa lenguaje de caja y muestra cuánto falta pagar", async () => {
    await renderCashier();

    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });

    fireEvent.click(
      screen.getByRole("button", { name: "Pago combinado" }),
    );

    expect(screen.queryByText(/medio de saldo/i)).toBeNull();
    expect(screen.queryByText(/importe fijo/i)).toBeNull();

    expect(
      screen.getByText("Falta pagar"),
    ).toBeInTheDocument();

    expect(
      screen.getByTestId("proportional-total"),
    ).toHaveTextContent("$ 45.000");

    expect(
      screen.getByRole("button", { name: /Agregar pago/i }),
    ).toBeInTheDocument();
  });


  it("UI-6 recién al elegir Pago combinado aparece el constructor de varios medios", async () => {
    await renderCashier();
    await screen.findByRole("button", { name: /Efectivo.*45\.000/ });
    expect(button(/Agregar pago/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    expect(screen.getByRole("button", { name: "Pago combinado" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Medio de saldo")).toBeInTheDocument();
    expect(button(/Agregar pago/)).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Efectivo.*45\.000/ })).toBeNull();
  });

  it("UI-7 cambiar entre Simple y Combinado no cobra ni deja datos del modo anterior", async () => {
    const state = await renderCashier();
    await chooseSimple(/Transferencia.*47\.500/, "47.500");
    fireEvent.change(screen.getByLabelText("Referencia"), { target: { value: "TRF12345" } });
    fireEvent.click(screen.getByRole("button", { name: "Pago combinado" }));
    fireEvent.click(button(/Agregar pago/)!);
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
    fireEvent.click(button(/Agregar pago/)!);
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
    await chooseSimple(/Efectivo.*30\.000/, "30.000");
    fireEvent.change(screen.getByLabelText("Recibido"), { target: { value: "30000" } });
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
