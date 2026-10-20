import { describe, expect, it } from "vitest";
import {
  CheckoutContractError,
  PROPORTIONAL_METHODS,
  attemptAfterFailure,
  attemptConfirmed,
  availableMethods,
  beginCheckout,
  buildCheckoutRequest,
  buildQuoteRequest,
  canBeginCheckout,
  draftIssues,
  methodAvailability,
  parseCheckoutQuote,
  parseCheckoutResult,
  previewChange,
  quoteMatchesDraft,
  retryCheckout,
  type CheckoutAttempt,
  type CheckoutDraft,
  type CheckoutQuote,
} from "./checkout-quote";

// R3-A4.2a: contrato PURO del cliente para el cobro proporcional.
//
// Este módulo no cobra, no cotiza, no redondea y no usa HTTP ni React: traduce
// el contrato del servidor a un modelo tipado y construye los dos cuerpos que
// el POS enviará. Ningún total se calcula localmente: `expectedTotal` y
// `expectedBalanceAmount` se copian del servidor.
//
// Todas las cifras fijadas acá provienen de la entrega aprobada de R3-A4.1:
// CASH fijo 20037 + saldo CARD_DEBIT 31500 = total 51537, con los renglones
// V1 20615 y V2 30922 (caso HTTP H1 del backend).

const SALE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SALE_ID = "99999999-9999-4999-8999-999999999999";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const OPERATION_KEY = "3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const SECOND_OPERATION_KEY = "5a6b7c8d-9e0f-4a1b-9c2d-3e4f5a6b7c8d";
// BIGINT de PostgreSQL: máximo admitido y primer valor rechazado.
const MAX_CENTAVOS = "9223372036854775807";
const OVER_MAX_CENTAVOS = "9223372036854775808";
const COLLECTION_ID = "44444444-4444-4444-8444-444444444444";

type Wire = Record<string, unknown>;
type WireBody = {
  expectedTotal: string;
  tenders: Array<{ amount?: string }>;
};

function wireQuote(overrides: Wire = {}): Wire {
  return {
    saleId: SALE_ID,
    saleNumber: "CEN-V-000001",
    pricingModel: "PROPORTIONAL_V1",
    enabledMethods: [
      { method: "CASH", available: true },
      { method: "TRANSFER", available: true },
      { method: "CARD_DEBIT", available: true },
      { method: "CARD_CREDIT", available: true },
    ],
    fullPrices: { CASH: "50000", TRANSFER: "55000", CARD_DEBIT: "52500", CARD_CREDIT: "57500" },
    tenders: [{ method: "CASH", role: "FIXED", amount: "20037" }],
    balance: { method: "CARD_DEBIT", amount: "31500" },
    total: "51537",
    lines: [
      { saleItemId: "item-1", sku: "V1", quantity: "1", finalAmount: "20615" },
      { saleItemId: "item-2", sku: "V2", quantity: "1", finalAmount: "30922" },
    ],
    unappliedCollections: [],
    reservationExpiresAt: "2030-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function quote(overrides: Wire = {}): CheckoutQuote {
  return parseCheckoutQuote(wireQuote(overrides));
}

function wireResult(overrides: Wire = {}): Wire {
  return {
    saleId: SALE_ID,
    saleNumber: "CEN-V-000001",
    status: "COMPLETED",
    checkoutId: "checkout-1",
    replayed: false,
    total: "51537",
    changeAmount: "4963",
    payments: [
      {
        id: "pay-1", method: "CASH", tenderRole: "FIXED", amount: "20037", methodFullPrice: "20000",
        adjustmentBps: 0, externalCollectionId: null, receivedAmount: "25000", changeAmount: "4963",
      },
      {
        id: "pay-2", method: "CARD_DEBIT", tenderRole: "BALANCE", amount: "31500", methodFullPrice: "31500",
        adjustmentBps: 500, externalCollectionId: null, receivedAmount: null, changeAmount: null,
      },
    ],
    lines: [
      { saleItemId: "item-1", sku: "V1", quantity: "1", finalAmount: "20615" },
      { saleItemId: "item-2", sku: "V2", quantity: "1", finalAmount: "30922" },
    ],
    completedAt: "2030-01-01T00:00:05.000Z",
    ...overrides,
  };
}

// El draft base del caso aprobado: CASH fijo con vuelto + saldo por débito. El
// saldo no-efectivo lleva la referencia que el servidor le exige a todo tender
// que no sea efectivo (CARD_DEBIT no lleva institución).
function draft(overrides: Partial<CheckoutDraft> = {}): CheckoutDraft {
  return {
    balanceMethod: "CARD_DEBIT",
    fixed: [{ method: "CASH", amount: "20037", receivedAmount: "25000" }],
    balanceReference: "D009",
    ...overrides,
  };
}

function checkoutOf(overrides: Partial<CheckoutDraft> = {}, quoteOverrides: Wire = {}) {
  const subject = draft(overrides);
  // La cotización que acompaña al draft siempre refleja sus medios e importes:
  // así cada caso prueba una regla de pago y no una discrepancia accidental.
  const base = wireQuote({
    tenders: subject.fixed.map((tender) => ({ method: tender.method, role: "FIXED", amount: tender.amount })),
    balance: { method: subject.balanceMethod, amount: "31500" },
    ...quoteOverrides,
  });
  return buildCheckoutRequest({
    saleId: SALE_ID,
    cashSessionId: SESSION_ID,
    operationKey: OPERATION_KEY,
    draft: subject,
    quote: parseCheckoutQuote(base),
  });
}

function codesOf(run: () => unknown): string[] {
  try {
    run();
  } catch (cause) {
    if (cause instanceof CheckoutContractError) return [cause.code];
    throw cause;
  }
  throw new Error("Se esperaba un CheckoutContractError.");
}

// Intento nuevo sin intento vigente: el punto de partida de casi todos los casos.
function attemptOf(operationKey = OPERATION_KEY): CheckoutAttempt {
  return beginCheckout({
    saleId: SALE_ID,
    cashSessionId: SESSION_ID,
    operationKey,
    draft: draft(),
    quote: quote(),
    current: null,
  });
}

function attemptInput(current: CheckoutAttempt | null, overrides: Partial<BeginCheckoutLike> = {}) {
  return {
    saleId: SALE_ID,
    cashSessionId: SESSION_ID,
    operationKey: SECOND_OPERATION_KEY,
    draft: draft(),
    quote: quote(),
    current,
    ...overrides,
  };
}

type BeginCheckoutLike = {
  saleId: string;
  cashSessionId: string;
  operationKey: string;
  draft: CheckoutDraft;
  quote: CheckoutQuote;
  current: CheckoutAttempt | null;
};

describe("Q — parsing estricto de la cotización (POST /checkout/quote)", () => {
  it("Q1 traduce el 200 aprobado a un modelo exacto (dinero a BigInt)", () => {
    const parsed = quote();
    expect(parsed).toEqual({
      saleId: SALE_ID,
      saleNumber: "CEN-V-000001",
      pricingModel: "PROPORTIONAL_V1",
      enabledMethods: [
        { method: "CASH", available: true },
        { method: "TRANSFER", available: true },
        { method: "CARD_DEBIT", available: true },
        { method: "CARD_CREDIT", available: true },
      ],
      fullPrices: { CASH: BigInt(50000), TRANSFER: BigInt(55000), CARD_DEBIT: BigInt(52500), CARD_CREDIT: BigInt(57500) },
      tenders: [{ method: "CASH", role: "FIXED", amount: BigInt(20037) }],
      balance: { method: "CARD_DEBIT", amount: BigInt(31500) },
      total: BigInt(51537),
      lines: [
        { saleItemId: "item-1", sku: "V1", quantity: BigInt(1), finalAmount: BigInt(20615) },
        { saleItemId: "item-2", sku: "V2", quantity: BigInt(1), finalAmount: BigInt(30922) },
      ],
      unappliedCollections: [],
      reservationExpiresAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("Q2 rechaza un cuerpo que no es un objeto o al que le falta un campo del contrato", () => {
    for (const body of [null, undefined, 7, "quote", [], { ...wireQuote(), total: undefined }]) {
      expect(codesOf(() => parseCheckoutQuote(body))).toEqual(["INVALID_QUOTE_RESPONSE"]);
    }
    const { saleNumber, ...withoutSaleNumber } = wireQuote();
    expect(saleNumber).toBe("CEN-V-000001");
    expect(codesOf(() => parseCheckoutQuote(withoutSaleNumber))).toEqual(["INVALID_QUOTE_RESPONSE"]);
  });

  it("Q3 rechaza dinero que no sea un entero de centavos canónico", () => {
    for (const total of ["12.5", "-1", "1e3", "01", "", " 5", "1 5", "abc", true, null, 51537]) {
      expect(codesOf(() => parseCheckoutQuote(wireQuote({ total })))).toEqual(["INVALID_QUOTE_RESPONSE"]);
    }
  });

  it("Q4 solo acepta el modelo proporcional", () => {
    expect(codesOf(() => parseCheckoutQuote(wireQuote({ pricingModel: "FIXED_TOTAL" }))))
      .toEqual(["INVALID_QUOTE_RESPONSE"]);
    expect(codesOf(() => parseCheckoutQuote(wireQuote({ pricingModel: undefined }))))
      .toEqual(["INVALID_QUOTE_RESPONSE"]);
  });

  it("Q5 exige los cuatro medios una sola vez y un motivo coherente con available", () => {
    const cases: Wire[] = [
      { enabledMethods: [{ method: "CASH", available: true }] },
      { enabledMethods: [{ method: "CASH", available: true }, { method: "CASH", available: true }, { method: "TRANSFER", available: true }] },
      { enabledMethods: [{ method: "CASH", available: true }, { method: "TRANSFER", available: true }, { method: "CARD_CREDIT", available: true }] },
      { enabledMethods: [{ method: "CASH", available: true }, { method: "TRANSFER", available: false }, { method: "CARD_DEBIT", available: true }, { method: "CARD_CREDIT", available: true }] },
      { enabledMethods: [{ method: "CASH", available: true }, { method: "TRANSFER", available: true, reason: "PRICING_CONFIG_MISSING" }, { method: "CARD_DEBIT", available: true }, { method: "CARD_CREDIT", available: true }] },
      { enabledMethods: [{ method: "CASH", available: true }, { method: "TRANSFER", available: false, reason: "OTHER_REASON" }, { method: "CARD_DEBIT", available: true }, { method: "CARD_CREDIT", available: true }] },
      { enabledMethods: "CASH" },
    ];
    for (const overrides of cases) {
      expect(codesOf(() => parseCheckoutQuote(wireQuote(overrides)))).toEqual(["INVALID_QUOTE_RESPONSE"]);
    }
    // El motivo declarado es el único que el motor usa hoy.
    const missing = quote({
      enabledMethods: [
        { method: "CASH", available: true },
        { method: "TRANSFER", available: false, reason: "PRICING_CONFIG_MISSING" },
        { method: "CARD_DEBIT", available: false, reason: "PRICING_CONFIG_MISSING" },
        { method: "CARD_CREDIT", available: false, reason: "PRICING_CONFIG_MISSING" },
      ],
    });
    expect(methodAvailability(missing).TRANSFER).toEqual({ available: false, reason: "PRICING_CONFIG_MISSING" });
  });

  it("Q6 rechaza renglones malformados: un renglón inválido invalida toda la respuesta", () => {
    const bad: Wire[][] = [
      [{ saleItemId: "item-1", sku: "V1", quantity: "0", finalAmount: "20615" }],
      [{ saleItemId: "item-1", sku: "V1", quantity: "-1", finalAmount: "20615" }],
      [{ saleItemId: "item-1", sku: "V1", quantity: "1", finalAmount: "2061.5" }],
      [{ saleItemId: "item-1", sku: "", quantity: "1", finalAmount: "20615" }],
      [{ saleItemId: "item-1", sku: "V1", quantity: "1" }],
    ];
    for (const lines of bad) {
      expect(codesOf(() => parseCheckoutQuote(wireQuote({ lines })))).toEqual(["INVALID_QUOTE_RESPONSE"]);
    }
    // Nunca se descarta el renglón malo y se muestran los otros: falla cerrado.
    expect(codesOf(() => parseCheckoutQuote(wireQuote({
      lines: [
        { saleItemId: "item-1", sku: "V1", quantity: "1", finalAmount: "20615" },
        { saleItemId: "item-2", sku: "V2", quantity: "1", finalAmount: "nope" },
      ],
    })))).toEqual(["INVALID_QUOTE_RESPONSE"]);
  });

  it("Q7 exige los cuatro precios completos, con null para un medio sin configuración", () => {
    expect(quote({ fullPrices: { CASH: "50000", TRANSFER: null, CARD_DEBIT: null, CARD_CREDIT: null } }).fullPrices)
      .toEqual({ CASH: BigInt(50000), TRANSFER: null, CARD_DEBIT: null, CARD_CREDIT: null });
    for (const fullPrices of [
      { CASH: "50000", TRANSFER: "55000" },
      { CASH: "50000", TRANSFER: "55000", CARD_DEBIT: "52500" },
      { CASH: "50000", TRANSFER: "55000", CARD_DEBIT: "52500", CARD_CREDIT: "x" },
      { CASH: "50000", TRANSFER: "55000", CARD_DEBIT: "52500", CARD_CREDIT: 57500 },
    ]) {
      expect(codesOf(() => parseCheckoutQuote(wireQuote({ fullPrices })))).toEqual(["INVALID_QUOTE_RESPONSE"]);
    }
  });

  it("Q8 valida los cobros externos pendientes con sus campos de presentación", () => {
    const parsed = quote({
      unappliedCollections: [
        {
          id: COLLECTION_ID, method: "TRANSFER", amount: "11000", reference: "OP 88123",
          institution: "GALICIA", institutionOther: null,
        },
      ],
    });
    expect(parsed.unappliedCollections).toEqual([{
      id: COLLECTION_ID, method: "TRANSFER", amount: BigInt(11000),
      reference: "OP 88123", institution: "GALICIA", institutionOther: null,
    }]);
    for (const unappliedCollections of [
      [{ id: COLLECTION_ID, method: "BITCOIN", amount: "11000", reference: "OP", institution: null, institutionOther: null }],
      [{ id: COLLECTION_ID, method: "TRANSFER", amount: "11.000", reference: "OP", institution: null, institutionOther: null }],
      [{ id: COLLECTION_ID, method: "TRANSFER", amount: "11000", reference: "OP", institution: "BANCO_FALSO", institutionOther: null }],
      [{ id: "", method: "TRANSFER", amount: "11000", reference: "OP", institution: null, institutionOther: null }],
    ]) {
      expect(codesOf(() => parseCheckoutQuote(wireQuote({ unappliedCollections })))).toEqual(["INVALID_QUOTE_RESPONSE"]);
    }
  });

  it("Q9 acepta el vencimiento nulo y una fecha ISO, y rechaza cualquier otra cosa", () => {
    expect(quote({ reservationExpiresAt: null }).reservationExpiresAt).toBeNull();
    expect(quote({ reservationExpiresAt: "2030-01-01T03:00:00.000Z" }).reservationExpiresAt)
      .toBe("2030-01-01T03:00:00.000Z");
    for (const reservationExpiresAt of ["", "mañana", 0, {}]) {
      expect(codesOf(() => parseCheckoutQuote(wireQuote({ reservationExpiresAt }))))
        .toEqual(["INVALID_QUOTE_RESPONSE"]);
    }
  });

  it("Q10 el error es tipado y con un código estable", () => {
    try {
      parseCheckoutQuote({});
      throw new Error("Se esperaba un error.");
    } catch (cause) {
      expect(cause).toBeInstanceOf(CheckoutContractError);
      expect((cause as CheckoutContractError).code).toBe("INVALID_QUOTE_RESPONSE");
    }
  });
});

describe("M — métodos habilitados", () => {
  it("M1 sin configuración de precios solo el efectivo está disponible", () => {
    const noConfig = quote({
      enabledMethods: [
        { method: "CASH", available: true },
        { method: "TRANSFER", available: false, reason: "PRICING_CONFIG_MISSING" },
        { method: "CARD_DEBIT", available: false, reason: "PRICING_CONFIG_MISSING" },
        { method: "CARD_CREDIT", available: false, reason: "PRICING_CONFIG_MISSING" },
      ],
      fullPrices: { CASH: "50000", TRANSFER: null, CARD_DEBIT: null, CARD_CREDIT: null },
    });
    expect(availableMethods(noConfig)).toEqual(["CASH"]);
    expect(methodAvailability(noConfig).CARD_DEBIT).toEqual({ available: false, reason: "PRICING_CONFIG_MISSING" });
  });

  it("M2 con configuración los cuatro medios están disponibles, en el orden del contrato", () => {
    const all = quote();
    expect(availableMethods(all)).toEqual([...PROPORTIONAL_METHODS]);
    expect(methodAvailability(all).TRANSFER).toEqual({ available: true });
  });

  it("M3 el efectivo está siempre disponible, aun sin configuración", () => {
    const noConfig = quote({
      enabledMethods: [
        { method: "CASH", available: true },
        { method: "TRANSFER", available: false, reason: "PRICING_CONFIG_MISSING" },
        { method: "CARD_DEBIT", available: false, reason: "PRICING_CONFIG_MISSING" },
        { method: "CARD_CREDIT", available: false, reason: "PRICING_CONFIG_MISSING" },
      ],
    });
    expect(methodAvailability(noConfig).CASH).toEqual({ available: true });
  });

  it("M4 un draft que usa un medio no disponible no se puede cobrar", () => {
    const noConfig = quote({
      enabledMethods: [
        { method: "CASH", available: true },
        { method: "TRANSFER", available: false, reason: "PRICING_CONFIG_MISSING" },
        { method: "CARD_DEBIT", available: false, reason: "PRICING_CONFIG_MISSING" },
        { method: "CARD_CREDIT", available: false, reason: "PRICING_CONFIG_MISSING" },
      ],
    });
    const asBalance = draft({ balanceMethod: "TRANSFER", fixed: [{ method: "CASH", amount: "20037", receivedAmount: "20037" }] });
    expect(draftIssues(asBalance, noConfig)).toContain("METHOD_NOT_AVAILABLE");
    const asFixed = draft({
      balanceMethod: "CASH",
      fixed: [{ method: "CARD_DEBIT", amount: "20037", reference: "OP 1" }],
      receivedAmount: "40000",
    });
    expect(draftIssues(asFixed, noConfig)).toContain("METHOD_NOT_AVAILABLE");
    // Sin cotización todavía no se puede afirmar nada sobre la disponibilidad.
    expect(draftIssues(asBalance)).not.toContain("METHOD_NOT_AVAILABLE");
  });
});

describe("R — request de la cotización", () => {
  it("R1 construye {balanceMethod, tenders} con centavos exactos", () => {
    const request = buildQuoteRequest(draft({
      balanceMethod: "TRANSFER",
      fixed: [
        { method: "CASH", amount: "20037", receivedAmount: "25000" },
        { method: "CARD_DEBIT", amount: "120940", reference: "OP 88123" },
      ],
    }));
    expect(request).toEqual({
      balanceMethod: "TRANSFER",
      tenders: [
        { method: "CASH", amount: "20037" },
        { method: "CARD_DEBIT", amount: "120940" },
      ],
    });
  });

  it("R2 un cobro todo por saldo no lleva importes fijos", () => {
    expect(buildQuoteRequest(draft({ fixed: [] }))).toEqual({ balanceMethod: "CARD_DEBIT", tenders: [] });
    expect(buildQuoteRequest(draft({ balanceMethod: "CASH", fixed: [], receivedAmount: "60000" })))
      .toEqual({ balanceMethod: "CASH", tenders: [] });
  });

  it("R3 el request lleva SOLO los campos del DTO (nada de precios, referencias ni recibidos)", () => {
    const request = buildQuoteRequest(draft({
      fixed: [{
        method: "TRANSFER", amount: "20037", reference: "OP 88123", institution: "GALICIA",
        institutionOther: null, receivedAmount: null,
      }],
    }));
    expect(Object.keys(request).sort()).toEqual(["balanceMethod", "tenders"]);
    expect(Object.keys(request.tenders[0]!).sort()).toEqual(["amount", "method"]);
  });

  it("R4 los centavos nunca se redondean ni se reformatean", () => {
    const request = buildQuoteRequest(draft({ fixed: [{ method: "CASH", amount: "1", receivedAmount: "1" }] }));
    expect(request.tenders[0]!.amount).toBe("1");
  });

  it("R5 rechaza límites y combinaciones inválidas antes de salir a la red", () => {
    const tooMany = draft({
      fixed: [
        { method: "CASH", amount: "100", receivedAmount: "100" },
        { method: "TRANSFER", amount: "100", reference: "OP 1", institution: "MACRO" },
        { method: "CARD_DEBIT", amount: "100", reference: "OP 2" },
      ],
    });
    expect(codesOf(() => buildQuoteRequest(tooMany))).toEqual(["TOO_MANY_FIXED_TENDERS"]);

    const duplicated = draft({
      fixed: [
        { method: "CASH", amount: "100", receivedAmount: "100" },
        { method: "CASH", amount: "100", receivedAmount: "100" },
      ],
    });
    expect(codesOf(() => buildQuoteRequest(duplicated))).toEqual(["DUPLICATE_METHOD"]);

    const balanceAlsoFixed = draft({
      balanceMethod: "CARD_DEBIT",
      fixed: [{ method: "CARD_DEBIT", amount: "100", reference: "OP 1" }],
    });
    expect(codesOf(() => buildQuoteRequest(balanceAlsoFixed))).toEqual(["BALANCE_METHOD_ALSO_FIXED"]);

    for (const amount of ["1.5", "-100", "1e3", "007", "", "92233720368547758070"]) {
      const invalid = draft({ fixed: [{ method: "CASH", amount, receivedAmount: "999999" }] });
      expect(codesOf(() => buildQuoteRequest(invalid))).toEqual(["INVALID_AMOUNT"]);
    }
    expect(codesOf(() => buildQuoteRequest(draft({ fixed: [{ method: "CASH", amount: "0", receivedAmount: "0" }] }))))
      .toEqual(["AMOUNT_BELOW_MINIMUM"]);
  });

  it("R6 el request de cotización no exige todavía los datos de pago (referencia, institución, recibido)", () => {
    // La cotización solo depende de medios e importes: un draft incompleto para
    // cobrar sigue siendo cotizable, y el problema se reporta en draftIssues.
    const incomplete = draft({ fixed: [{ method: "TRANSFER", amount: "100" }] });
    expect(buildQuoteRequest(incomplete)).toEqual({ balanceMethod: "CARD_DEBIT", tenders: [{ method: "TRANSFER", amount: "100" }] });
    expect(draftIssues(incomplete)).toContain("REFERENCE_XOR_COLLECTION");
  });
});

describe("C — request del cobro", () => {
  it("C1 copia expectedTotal y expectedBalanceAmount literales del servidor", () => {
    const body = checkoutOf();
    expect(body.expectedTotal).toBe("51537");
    expect(body.expectedBalanceAmount).toBe("31500");
    expect(body.balanceMethod).toBe("CARD_DEBIT");
    expect(body.operationKey).toBe(OPERATION_KEY);
    expect(body.cashSessionId).toBe(SESSION_ID);
  });

  it("C2 nunca deriva el total: un valor no derivable del servidor se envía tal cual", () => {
    // Valor sintético imposible de deducir de los importes: si el módulo
    // calculara, enviaría 51537. Prueba de procedencia, no de aritmética.
    const body = checkoutOf({}, { total: "777777", balance: { method: "CARD_DEBIT", amount: "424242" } });
    expect(body.expectedTotal).toBe("777777");
    expect(body.expectedBalanceAmount).toBe("424242");
  });

  it("C3 roles correctos: los fijos con su importe y exactamente un BALANCE sin importe", () => {
    const body = checkoutOf();
    expect(body.tenders).toEqual([
      { method: "CASH", role: "FIXED", amount: "20037", receivedAmount: "25000" },
      { method: "CARD_DEBIT", role: "BALANCE", reference: "D009" },
    ]);
    expect(body.tenders.filter((tender) => tender.role === "BALANCE")).toHaveLength(1);
    // El saldo jamás lleva importe (lo calcula el servidor).
    expect(Object.keys(body.tenders[1]!).sort()).toEqual(["method", "reference", "role"]);
  });

  it("C4 receivedAmount solo en efectivo, y nunca changeAmount", () => {
    const cashBalance = checkoutOf(
      { balanceMethod: "CASH", fixed: [{ method: "TRANSFER", amount: "20037", reference: "OP 88123", institution: "GALICIA" }], receivedAmount: "60000", balanceReference: null },
    );
    expect(cashBalance.tenders).toEqual([
      { method: "TRANSFER", role: "FIXED", amount: "20037", reference: "OP 88123", institution: "GALICIA" },
      { method: "CASH", role: "BALANCE", receivedAmount: "60000" },
    ]);
    expect(JSON.stringify(cashBalance)).not.toContain("changeAmount");
    const debitBalance = checkoutOf({ balanceMethod: "CARD_DEBIT", fixed: [{ method: "TRANSFER", amount: "20037", reference: "OP 88123", institution: "MACRO" }] });
    expect(debitBalance.tenders.every((tender) => !("receivedAmount" in tender))).toBe(true);
  });

  it("C5 transferencia con referencia nueva: referencia + institución, sin cobro externo", () => {
    const body = checkoutOf({
      fixed: [{ method: "TRANSFER", amount: "20037", reference: "OP 88123", institution: "GALICIA" }],
    });
    expect(body.tenders[0]).toEqual({
      method: "TRANSFER", role: "FIXED", amount: "20037", reference: "OP 88123", institution: "GALICIA",
    });
  });

  it("C6 la institución OTHER viaja con su etiqueta recortada", () => {
    const body = checkoutOf({
      fixed: [{ method: "TRANSFER", amount: "20037", reference: "OP 88123", institution: "OTHER", institutionOther: "  Banco Vecinal  " }],
    });
    expect(body.tenders[0]).toEqual({
      method: "TRANSFER", role: "FIXED", amount: "20037", reference: "OP 88123", institution: "OTHER",
      institutionOther: "Banco Vecinal",
    });
  });

  it("C7 débito con referencia nueva: sin institución", () => {
    const body = checkoutOf({ balanceMethod: "TRANSFER", fixed: [{ method: "CARD_DEBIT", amount: "20037", reference: "1234" }], balanceInstitution: "MACRO" });
    expect(body.tenders[0]).toEqual({ method: "CARD_DEBIT", role: "FIXED", amount: "20037", reference: "1234" });
  });

  it("C8 un cobro externo pendiente se imputa como fijo por su importe exacto, sin referencia", () => {
    const body = checkoutOf(
      { fixed: [{ method: "TRANSFER", amount: "11000", externalCollectionId: COLLECTION_ID }] },
      { unappliedCollections: [{ id: COLLECTION_ID, method: "TRANSFER", amount: "11000", reference: "OP 88123", institution: "GALICIA", institutionOther: null }] },
    );
    expect(body.tenders[0]).toEqual({
      method: "TRANSFER", role: "FIXED", amount: "11000", externalCollectionId: COLLECTION_ID,
    });
    expect(JSON.stringify(body)).not.toContain("OP 88123");
    expect(JSON.stringify(body)).not.toContain("GALICIA");
  });

  it("C9 rechaza referencia y cobro externo juntos, o ninguno de los dos", () => {
    const both = draft({
      fixed: [{ method: "TRANSFER", amount: "100", reference: "OP 1", institution: "MACRO", externalCollectionId: COLLECTION_ID }],
    });
    expect(draftIssues(both)).toContain("REFERENCE_XOR_COLLECTION");
    const neither = draft({ fixed: [{ method: "CARD_DEBIT", amount: "100" }] });
    expect(draftIssues(neither)).toContain("REFERENCE_XOR_COLLECTION");
    // El efectivo no lleva referencia, institución ni cobro externo.
    const cashWithReference = draft({
      fixed: [{ method: "CASH", amount: "100", receivedAmount: "100", reference: "OP 1" }],
    });
    expect(draftIssues(cashWithReference)).toContain("REFERENCE_NOT_ALLOWED");
  });

  it("C10 rechaza referencias fuera del contrato (1..64 caracteres, clave normalizada 3..40)", () => {
    const withReference = (reference: string) => draft({
      fixed: [{ method: "CARD_DEBIT", amount: "100", reference }],
    });
    expect(draftIssues(withReference("ab"))).toContain("REFERENCE_INVALID");
    expect(draftIssues(withReference("-"))).toContain("REFERENCE_INVALID");
    expect(draftIssues(withReference("a".repeat(65)))).toContain("REFERENCE_INVALID");
    // 64 caracteres pero clave normalizada de 64 > 40: el contrato la rechaza.
    expect(draftIssues(withReference("a".repeat(64)))).toContain("REFERENCE_INVALID");
    // 64 caracteres con clave de 7: válida.
    expect(draftIssues(withReference(`OP 88123${"-".repeat(56)}`))).not.toContain("REFERENCE_INVALID");
    // 65 caracteres: fuera del máximo, aunque la clave sea corta.
    expect(draftIssues(withReference(`OP 88123${"-".repeat(57)}`))).toContain("REFERENCE_INVALID");
    expect(draftIssues(withReference("OP 88123"))).not.toContain("REFERENCE_INVALID");
  });

  it("C11 exige institución en transferencia y la prohíbe en débito o con cobro externo", () => {
    const transferNoInstitution = draft({ fixed: [{ method: "TRANSFER", amount: "100", reference: "OP 1" }] });
    expect(draftIssues(transferNoInstitution)).toContain("INSTITUTION_REQUIRED");
    const bogusInstitution = draft({
      fixed: [{ method: "TRANSFER", amount: "100", reference: "OP 1", institution: "BANCO_FALSO" as "MACRO" }],
    });
    expect(draftIssues(bogusInstitution)).toContain("INSTITUTION_REQUIRED");
    const debitWithInstitution = draft({ fixed: [{ method: "CARD_DEBIT", amount: "100", reference: "OP 1", institution: "MACRO" }] });
    expect(draftIssues(debitWithInstitution)).toContain("INSTITUTION_NOT_ALLOWED");
    const collectionWithInstitution = draft({
      fixed: [{ method: "TRANSFER", amount: "100", externalCollectionId: COLLECTION_ID, institution: "MACRO" }],
    });
    expect(draftIssues(collectionWithInstitution)).toContain("INSTITUTION_NOT_ALLOWED");
  });

  it("C12 exige la etiqueta solo para la institución OTHER", () => {
    const otherWithoutLabel = draft({ fixed: [{ method: "TRANSFER", amount: "100", reference: "OP 1", institution: "OTHER" }] });
    expect(draftIssues(otherWithoutLabel)).toContain("INSTITUTION_OTHER_REQUIRED");
    const otherWithBlankLabel = draft({ fixed: [{ method: "TRANSFER", amount: "100", reference: "OP 1", institution: "OTHER", institutionOther: "   " }] });
    expect(draftIssues(otherWithBlankLabel)).toContain("INSTITUTION_OTHER_REQUIRED");
    const labelOnMacro = draft({ fixed: [{ method: "TRANSFER", amount: "100", reference: "OP 1", institution: "MACRO", institutionOther: "Otro" }] });
    expect(draftIssues(labelOnMacro)).toContain("INSTITUTION_OTHER_NOT_ALLOWED");
  });

  it("C13 el efectivo recibido es obligatorio y no puede ser menor al importe", () => {
    expect(draftIssues(draft({ fixed: [{ method: "CASH", amount: "20037" }] }))).toContain("RECEIVED_REQUIRED");
    expect(draftIssues(draft({ fixed: [{ method: "CASH", amount: "20037", receivedAmount: "" }] }))).toContain("RECEIVED_REQUIRED");
    expect(draftIssues(draft({ fixed: [{ method: "CASH", amount: "20037", receivedAmount: "20036" }] }))).toContain("RECEIVED_BELOW_AMOUNT");
    expect(draftIssues(draft({ fixed: [{ method: "CASH", amount: "20037", receivedAmount: "20036.5" }] }))).toContain("INVALID_AMOUNT");
    expect(draftIssues(draft({ balanceMethod: "CASH", fixed: [] }))).toContain("RECEIVED_REQUIRED");
    // Un saldo en efectivo no lleva referencia (el draft base sí la trae para
    // su saldo por débito: se limpia explícitamente).
    expect(draftIssues(draft({ balanceMethod: "CASH", fixed: [], receivedAmount: "60000", balanceReference: null }))).toEqual([]);
  });

  it("C14 el recibido no se acepta fuera del efectivo", () => {
    expect(draftIssues(draft({
      balanceMethod: "CARD_DEBIT",
      fixed: [{ method: "TRANSFER", amount: "100", reference: "OP 1", institution: "MACRO", receivedAmount: "200" }],
    }))).toContain("RECEIVED_ONLY_FOR_CASH");
    expect(draftIssues(draft({ balanceMethod: "CARD_DEBIT", fixed: [], receivedAmount: "200" })))
      .toContain("RECEIVED_ONLY_FOR_CASH");
  });

  it("C15 el cuerpo tiene exactamente las claves del DTO, con el dinero como string", () => {
    const body = checkoutOf();
    expect(Object.keys(body).sort()).toEqual([
      "balanceMethod", "cashSessionId", "expectedBalanceAmount", "expectedTotal", "operationKey", "tenders",
    ]);
    // JSON serializable: ningún BigInt se filtra al cable.
    const roundTrip = JSON.parse(JSON.stringify(body)) as WireBody;
    expect(roundTrip).toEqual(body);
    expect(roundTrip.expectedTotal).toBe("51537");
    expect(roundTrip.tenders[0]!.amount).toBe("20037");
    expect(body.expectedTotal).not.toBe(`${body.expectedTotal}n`);
  });

  it("C16 exige una clave de operación v4 y sesión/venta no vacías", () => {
    expect(codesOf(() => buildCheckoutRequest({
      saleId: SALE_ID, cashSessionId: SESSION_ID, operationKey: "no-es-uuid",
      draft: draft(), quote: quote(),
    }))).toEqual(["INVALID_OPERATION_KEY"]);
    expect(codesOf(() => buildCheckoutRequest({
      saleId: SALE_ID, cashSessionId: SESSION_ID, operationKey: "3f1a2b4c-5d6e-1f70-8a9b-0c1d2e3f4a5b",
      draft: draft(), quote: quote(),
    }))).toEqual(["INVALID_OPERATION_KEY"]);
    expect(codesOf(() => buildCheckoutRequest({
      saleId: SALE_ID, cashSessionId: "", operationKey: OPERATION_KEY, draft: draft(), quote: quote(),
    }))).toEqual(["INVALID_SESSION_ID"]);
    expect(codesOf(() => buildCheckoutRequest({
      saleId: "sale-1", cashSessionId: SESSION_ID, operationKey: OPERATION_KEY, draft: draft(), quote: quote(),
    }))).toEqual(["INVALID_SALE_ID"]);
  });

  it("C17 rechaza cotizar/cobrar con un cobro externo que no pertenece a la venta", () => {
    const alien = draft({ fixed: [{ method: "TRANSFER", amount: "11000", externalCollectionId: COLLECTION_ID }] });
    // La colección no figura entre las pendientes de ESTA venta.
    expect(draftIssues(alien, quote())).toContain("INVALID_COLLECTION_ID");
    // Y si figura, el importe debe ser el suyo.
    const wrongAmount = draft({ fixed: [{ method: "TRANSFER", amount: "11001", externalCollectionId: COLLECTION_ID }] });
    expect(draftIssues(wrongAmount, quote({
      unappliedCollections: [{ id: COLLECTION_ID, method: "TRANSFER", amount: "11000", reference: "OP 88123", institution: "GALICIA", institutionOther: null }],
    }))).toContain("INVALID_COLLECTION_ID");
    const rightAmount = draft({ fixed: [{ method: "TRANSFER", amount: "11000", externalCollectionId: COLLECTION_ID }] });
    const pending = quote({
      unappliedCollections: [{ id: COLLECTION_ID, method: "TRANSFER", amount: "11000", reference: "OP 88123", institution: "GALICIA", institutionOther: null }],
    });
    expect(draftIssues(rightAmount, pending)).toEqual([]);
    // El medio del cobro debe ser el suyo: un débito no puede imputar una transferencia.
    const wrongMethod = draft({ fixed: [{ method: "CARD_DEBIT", amount: "11000", externalCollectionId: COLLECTION_ID }] });
    expect(draftIssues(wrongMethod, pending)).toContain("INVALID_COLLECTION_ID");
  });

  it("C18 el límite de centavos es el BIGINT de PostgreSQL, no la cantidad de dígitos", () => {
    // Ambos tienen 19 dígitos: el primero entra, el segundo no.
    expect(MAX_CENTAVOS.length).toBe(OVER_MAX_CENTAVOS.length);
    const maxFixed = draft({ fixed: [{ method: "CASH", amount: MAX_CENTAVOS, receivedAmount: MAX_CENTAVOS }] });
    expect(buildQuoteRequest(maxFixed).tenders[0]!.amount).toBe(MAX_CENTAVOS);
    expect(draftIssues(maxFixed)).toEqual([]);
    expect(previewChange(maxFixed, quote())).toEqual({
      allocated: BigInt(MAX_CENTAVOS), received: BigInt(MAX_CENTAVOS), change: BigInt(0),
    });

    const overFixed = draft({ fixed: [{ method: "CASH", amount: OVER_MAX_CENTAVOS, receivedAmount: MAX_CENTAVOS }] });
    expect(codesOf(() => buildQuoteRequest(overFixed))).toEqual(["INVALID_AMOUNT"]);
    expect(buildQuoteRequest(draft({ fixed: [{ method: "CASH", amount: "1", receivedAmount: MAX_CENTAVOS }] })).tenders[0]!.amount).toBe("1");

    // El efectivo recibido también: en el fijo y en el saldo.
    expect(draftIssues(draft({ fixed: [{ method: "CASH", amount: "1", receivedAmount: MAX_CENTAVOS }] }))).toEqual([]);
    expect(draftIssues(draft({ fixed: [{ method: "CASH", amount: "1", receivedAmount: OVER_MAX_CENTAVOS }] })))
      .toContain("INVALID_AMOUNT");
    expect(draftIssues(draft({ balanceMethod: "CASH", fixed: [], receivedAmount: OVER_MAX_CENTAVOS })))
      .toContain("INVALID_AMOUNT");
    expect(draftIssues(draft({ balanceMethod: "CASH", fixed: [], receivedAmount: MAX_CENTAVOS, balanceReference: null }))).toEqual([]);

    // Y ninguna respuesta del servidor puede traer un importe fuera de rango.
    expect(quote({ total: MAX_CENTAVOS }).total).toBe(BigInt(MAX_CENTAVOS));
    expect(codesOf(() => parseCheckoutQuote(wireQuote({ total: OVER_MAX_CENTAVOS })))).toEqual(["INVALID_QUOTE_RESPONSE"]);
    expect(codesOf(() => parseCheckoutQuote(wireQuote({ balance: { method: "CARD_DEBIT", amount: OVER_MAX_CENTAVOS } }))))
      .toEqual(["INVALID_QUOTE_RESPONSE"]);
  });

  it("C19 el saldo no-efectivo viaja con su referencia (y su institución, si es transferencia)", () => {
    // El servidor exige referencia en TODO tender que no sea efectivo, el
    // BALANCE incluido: sin ella el cobro muere en el 400 del DTO.
    const debit = checkoutOf();
    expect(debit.tenders[1]).toEqual({ method: "CARD_DEBIT", role: "BALANCE", reference: "D009" });
    expect("amount" in debit.tenders[1]!).toBe(false);
    expect("institution" in debit.tenders[1]!).toBe(false);

    const transfer = checkoutOf({
      balanceMethod: "TRANSFER",
      fixed: [{ method: "CASH", amount: "20037", receivedAmount: "25000" }],
      balanceReference: "OP 88123",
      balanceInstitution: "GALICIA",
    });
    expect(transfer.tenders[1]).toEqual({
      method: "TRANSFER", role: "BALANCE", reference: "OP 88123", institution: "GALICIA",
    });

    const other = checkoutOf({
      balanceMethod: "TRANSFER",
      fixed: [{ method: "CASH", amount: "20037", receivedAmount: "25000" }],
      balanceReference: "OP 88123",
      balanceInstitution: "OTHER",
      balanceInstitutionOther: "  Banco Vecinal  ",
    });
    expect(other.tenders[1]).toEqual({
      method: "TRANSFER", role: "BALANCE", reference: "OP 88123", institution: "OTHER", institutionOther: "Banco Vecinal",
    });
    // El saldo nunca imputa un cobro ya registrado: no hay campo ni clave.
    expect(JSON.stringify(transfer)).not.toContain("externalCollectionId");
  });

  it("C20 un saldo no-efectivo sin referencia, sin institución o con una de más no se puede cobrar", () => {
    expect(draftIssues(draft({ balanceReference: null }))).toContain("REFERENCE_XOR_COLLECTION");
    expect(draftIssues(draft({ balanceReference: "ab" }))).toContain("REFERENCE_INVALID");
    expect(draftIssues(draft({ balanceMethod: "TRANSFER", balanceInstitution: null }))).toContain("INSTITUTION_REQUIRED");
    expect(draftIssues(draft({ balanceMethod: "TRANSFER", balanceInstitution: "BANCO_FALSO" as "MACRO" })))
      .toContain("INSTITUTION_REQUIRED");
    expect(draftIssues(draft({ balanceInstitution: "MACRO" }))).toContain("INSTITUTION_NOT_ALLOWED");
    expect(draftIssues(draft({ balanceMethod: "TRANSFER", balanceInstitution: "OTHER" }))).toContain("INSTITUTION_OTHER_REQUIRED");
    expect(draftIssues(draft({ balanceMethod: "TRANSFER", balanceInstitution: "MACRO", balanceInstitutionOther: "Otro" })))
      .toContain("INSTITUTION_OTHER_NOT_ALLOWED");
    // El recibido sigue siendo exclusivo del efectivo.
    expect(draftIssues(draft({ receivedAmount: "200" }))).toContain("RECEIVED_ONLY_FOR_CASH");
    // Y el cobro no se puede armar sin resolverlo: se lanza el primer motivo.
    expect(codesOf(() => checkoutOf({ balanceReference: null }))).toEqual(["REFERENCE_XOR_COLLECTION"]);
    expect(codesOf(() => checkoutOf({ balanceMethod: "TRANSFER", balanceInstitution: null })))
      .toEqual(["INSTITUTION_REQUIRED"]);
  });

  it("C21 el saldo en efectivo no lleva referencia ni institución: solo lo recibido", () => {
    const cashBalance = draft({ balanceMethod: "CASH", fixed: [], receivedAmount: "60000", balanceReference: null });
    expect(draftIssues(cashBalance)).toEqual([]);
    expect(draftIssues({ ...cashBalance, balanceReference: "D009" })).toContain("REFERENCE_NOT_ALLOWED");
    expect(draftIssues({ ...cashBalance, balanceInstitution: "GALICIA" })).toContain("REFERENCE_NOT_ALLOWED");
    expect(draftIssues({ ...cashBalance, balanceInstitutionOther: "Otro" })).toContain("REFERENCE_NOT_ALLOWED");
    expect(checkoutOf(cashBalance).tenders).toEqual([
      { method: "CASH", role: "BALANCE", receivedAmount: "60000" },
    ]);
  });
});

describe("V — vuelto (solo BigInt)", () => {
  it("V1 efectivo fijo + saldo por otro medio: asignado el fijo, vuelto recibido menos asignado", () => {
    expect(previewChange(draft(), quote())).toEqual({
      allocated: BigInt(20037), received: BigInt(25000), change: BigInt(4963),
    });
  });

  it("V2 efectivo como medio de saldo: asignado el saldo del servidor", () => {
    const cashQuote = quote({ tenders: [], balance: { method: "CASH", amount: "51537" } });
    expect(previewChange(draft({ balanceMethod: "CASH", fixed: [], receivedAmount: "60000" }), cashQuote))
      .toEqual({ allocated: BigInt(51537), received: BigInt(60000), change: BigInt(8463) });
  });

  it("V3 sin efectivo no hay vuelto", () => {
    const noCash = draft({ balanceMethod: "TRANSFER", fixed: [{ method: "CARD_DEBIT", amount: "20037", reference: "1234" }] });
    expect(previewChange(noCash, quote({ tenders: [], balance: { method: "TRANSFER", amount: "51537" } }))).toBeNull();
  });

  it("V4 un recibido insuficiente no produce vuelto negativo", () => {
    expect(previewChange(draft({ fixed: [{ method: "CASH", amount: "20037", receivedAmount: "100" }] }), quote())).toBeNull();
    expect(previewChange(draft({ balanceMethod: "CASH", fixed: [] }), quote({ tenders: [], balance: { method: "CASH", amount: "51537" } }))).toBeNull();
  });

  it("V5 mantiene la exactitud con importes enormes (jamás Number)", () => {
    const huge = quote({ tenders: [], balance: { method: "CASH", amount: "9223372036854775800" } });
    expect(previewChange(draft({ balanceMethod: "CASH", fixed: [], receivedAmount: "9223372036854775807" }), huge))
      .toEqual({ allocated: BigInt("9223372036854775800"), received: BigInt("9223372036854775807"), change: BigInt(7) });
  });
});

describe("D — la cotización debe corresponder al draft que la originó", () => {
  it("D1 compara medios e importes exactos, sin importar el orden", () => {
    const subject = draft();
    expect(quoteMatchesDraft(quote(), subject, SALE_ID)).toBe(true);
    expect(quoteMatchesDraft(quote({ tenders: [{ method: "CASH", role: "FIXED", amount: "20038" }], total: "51538" }), subject, SALE_ID)).toBe(false);
    expect(quoteMatchesDraft(quote({ tenders: [], balance: { method: "CARD_DEBIT", amount: "51537" }, total: "51537" }), subject, SALE_ID)).toBe(false);
    expect(quoteMatchesDraft(quote({ balance: { method: "TRANSFER", amount: "31500" } }), subject, SALE_ID)).toBe(false);
    const two = draft({
      balanceMethod: "TRANSFER",
      fixed: [
        { method: "CASH", amount: "20037", receivedAmount: "25000" },
        { method: "CARD_DEBIT", amount: "1000", reference: "1234" },
      ],
    });
    expect(quoteMatchesDraft(quote({
      tenders: [
        { method: "CARD_DEBIT", role: "FIXED", amount: "1000" },
        { method: "CASH", role: "FIXED", amount: "20037" },
      ],
      balance: { method: "TRANSFER", amount: "40000" },
      total: "61037",
    }), two, SALE_ID)).toBe(true);
  });

  it("D3 dos ventas con los mismos importes y medios no se confunden: el saleId decide", () => {
    const subject = draft();
    const mine = quote();
    const theirs = quote({ saleId: OTHER_SALE_ID });
    // Mismos medios, mismos importes, distinto saleId: jamás una cotización de otra venta.
    expect(quoteMatchesDraft(theirs, subject, SALE_ID)).toBe(false);
    expect(quoteMatchesDraft(mine, subject, OTHER_SALE_ID)).toBe(false);
    expect(quoteMatchesDraft(mine, subject, SALE_ID)).toBe(true);
    expect(quoteMatchesDraft(theirs, subject, OTHER_SALE_ID)).toBe(true);
    // Y el cobro tampoco se arma con la cotización de la otra venta.
    expect(codesOf(() => buildCheckoutRequest({
      saleId: SALE_ID, cashSessionId: SESSION_ID, operationKey: OPERATION_KEY, draft: subject, quote: theirs,
    }))).toEqual(["QUOTE_DOES_NOT_MATCH_DRAFT"]);
  });

  it("D2 beginCheckout exige que la cotización sea de esa venta y de ese draft", () => {
    const alienSale = quote({ saleId: OTHER_SALE_ID });
    expect(codesOf(() => beginCheckout({
      saleId: SALE_ID, quote: alienSale, draft: draft(), cashSessionId: SESSION_ID, operationKey: OPERATION_KEY,
      current: null,
    }))).toEqual(["QUOTE_DOES_NOT_MATCH_DRAFT"]);
    const staleAmount = quote({ tenders: [{ method: "CASH", role: "FIXED", amount: "20038" }], total: "51538" });
    expect(codesOf(() => beginCheckout({
      saleId: SALE_ID, quote: staleAmount, draft: draft(), cashSessionId: SESSION_ID, operationKey: OPERATION_KEY,
      current: null,
    }))).toEqual(["QUOTE_DOES_NOT_MATCH_DRAFT"]);
    expect(beginCheckout({
      saleId: SALE_ID, quote: quote(), draft: draft(), cashSessionId: SESSION_ID, operationKey: OPERATION_KEY,
      current: null,
    }).state).toBe("PENDING");
  });
});

describe("A — intento: pendiente, confirmado o incierto (clave y cuerpo conservados)", () => {
  it("A1 el intento pendiente guarda la clave, el cuerpo y el total cotizado", () => {
    const attempt = beginCheckout({
      saleId: SALE_ID, quote: quote(), draft: draft(), cashSessionId: SESSION_ID, operationKey: OPERATION_KEY,
      current: null,
    });
    expect(attempt.state).toBe("PENDING");
    expect(attempt.operationKey).toBe(OPERATION_KEY);
    expect(attempt.saleId).toBe(SALE_ID);
    if (attempt.state !== "PENDING") throw new Error("estado inesperado");
    expect(attempt.quotedTotal).toBe(BigInt(51537));
    expect(attempt.quotedBalance).toBe(BigInt(31500));
    expect(attempt.body.expectedTotal).toBe("51537");
  });
  it("A2 una respuesta confirmada cierra el intento y debe ser de la misma venta", () => {
    const attempt = beginCheckout({
      saleId: SALE_ID, quote: quote(), draft: draft(), cashSessionId: SESSION_ID, operationKey: OPERATION_KEY,
      current: null,
    });
    const confirmed = attemptConfirmed(attempt, parseCheckoutResult(wireResult()));
    expect(confirmed.state).toBe("CONFIRMED");
    expect(confirmed.operationKey).toBe(OPERATION_KEY);
    if (confirmed.state !== "CONFIRMED") throw new Error("estado inesperado");
    expect(confirmed.result.changeAmount).toBe(BigInt(4963));
    // Una respuesta de otra venta no puede cerrar este intento. El parser ya
    // rechaza un saleId que no sea un uuid; y uno válido de otra venta se
    // rechaza explícitamente.
    expect(codesOf(() => attemptConfirmed(attempt, parseCheckoutResult(wireResult({ saleId: "otra-venta" })))))
      .toEqual(["INVALID_CHECKOUT_RESULT"]);
    expect(codesOf(() => attemptConfirmed(attempt, parseCheckoutResult(wireResult({ saleId: OTHER_SALE_ID })))))
      .toEqual(["RESULT_SALE_MISMATCH"]);
  });

  it("A3 un resultado incierto conserva la clave y el cuerpo idénticos", () => {
    const attempt = beginCheckout({
      saleId: SALE_ID, quote: quote(), draft: draft(), cashSessionId: SESSION_ID, operationKey: OPERATION_KEY,
      current: null,
    });
    const uncertain: CheckoutAttempt = attemptAfterFailure(attempt, { message: "La red se cortó." });
    expect(uncertain.state).toBe("UNCERTAIN");
    expect(uncertain.operationKey).toBe(OPERATION_KEY);
    expect(uncertain.body).toEqual(attempt.body);
    expect(uncertain.body).toBe(attempt.body);
  });

  it("A4 ningún error descarta un intento PENDIENTE: pudo haber cometido y perdido la respuesta", () => {
    const attempt = attemptOf();
    // El envío se reintentó (misma clave, mismo cuerpo) y la respuesta fue un 403:
    // la autorización corre ANTES de resolver la operationKey, así que no demuestra
    // que el primer envío no haya quedado cobrado.
    const retried = retryCheckout(attempt);
    expect(retried.operationKey).toBe(OPERATION_KEY);
    expect(retried.body).toBe(attempt.body);
    const forbidden = attemptAfterFailure(attempt, { status: 403, code: "FORBIDDEN", message: "Sin permiso." });
    expect(forbidden.state).toBe("UNCERTAIN");
    expect(forbidden.operationKey).toBe(OPERATION_KEY);
    expect(forbidden.body).toBe(attempt.body);
    // Y toda la franja de status, con código conocido o sin él, se comporta igual.
    for (const failure of [
      { status: 400, code: "VALIDATION_ERROR", message: "Datos inválidos." },
      { status: 401, code: "UNAUTHORIZED", message: "Sesión vencida." },
      { status: 403, code: "FORBIDDEN", message: "Sin permiso." },
      { status: 403, message: "Sin permiso, sin código." },
      { status: 404, code: "NOT_FOUND", message: "No existe." },
      { status: 409, code: "CHECKOUT_QUOTE_CHANGED", message: "Cotización vieja." },
      { status: 409, code: "NO_OPEN_CASH_SESSION", message: "Sin caja." },
      { status: 409, message: "Conflicto pelado." },
      { status: 409, code: "CODIGO_NUEVO_DEL_SERVIDOR", message: "?" },
      { status: 429, code: "RATE_LIMITED", message: "Demasiadas peticiones." },
      { status: 500, code: "CHECKOUT_STATE_INCONSISTENT", message: "Error interno." },
      { status: 502, message: "Bad gateway." },
      { message: "La red se cortó." },
    ]) {
      const next = attemptAfterFailure(attempt, failure);
      expect(next.state, JSON.stringify(failure)).toBe("UNCERTAIN");
      expect(next.operationKey, JSON.stringify(failure)).toBe(OPERATION_KEY);
      expect(next.saleId, JSON.stringify(failure)).toBe(SALE_ID);
      // El cuerpo es EL MISMO objeto: no se reconstruye.
      expect(next.body, JSON.stringify(failure)).toBe(attempt.body);
    }
  });

  it("A5 un 5xx o una respuesta ausente son inciertos, nunca 'no cobrado'", () => {
    const attempt = attemptOf();
    for (const failure of [
      { status: 500, code: "CHECKOUT_STATE_INCONSISTENT", message: "Error interno." },
      { status: 502, message: "Bad gateway." },
      { message: "No hubo respuesta." },
    ]) {
      const next = attemptAfterFailure(attempt, failure);
      expect(next!.state).toBe("UNCERTAIN");
      expect(next!.operationKey).toBe(OPERATION_KEY);
    }
  });

  it("A6 el reintento reenvía la MISMA clave y el MISMO cuerpo, sin volver a mirar el draft", () => {
    const attempt = beginCheckout({
      saleId: SALE_ID, quote: quote(), draft: draft(), cashSessionId: SESSION_ID, operationKey: OPERATION_KEY,
      current: null,
    });
    const uncertain = attemptAfterFailure(attempt, { message: "No hubo respuesta." });
    const retry = retryCheckout(uncertain);
    expect(retry.operationKey).toBe(OPERATION_KEY);
    expect(retry.body).toBe(uncertain.body);
    expect(retry).toEqual({ operationKey: attempt.operationKey, body: attempt.body });
    // Y el reintento confirmado se resuelve como replayed sin volver a cobrar.
    const replayed = attemptConfirmed(uncertain, parseCheckoutResult(wireResult({ replayed: true })));
    expect(replayed.state).toBe("CONFIRMED");
    if (replayed.state !== "CONFIRMED") throw new Error("estado inesperado");
    expect(replayed.result.replayed).toBe(true);
  });

  it("A7 un cobro ya confirmado no se reintenta jamás", () => {
    const attempt = beginCheckout({
      saleId: SALE_ID, quote: quote(), draft: draft(), cashSessionId: SESSION_ID, operationKey: OPERATION_KEY,
      current: null,
    });
    const confirmed = attemptConfirmed(attempt, parseCheckoutResult(wireResult()));
    expect(codesOf(() => retryCheckout(confirmed))).toEqual(["ATTEMPT_ALREADY_CONFIRMED"]);
  });

  it("A8 un resultado incierto bloquea un nuevo cobro de la misma venta hasta resolverse", () => {
    const attempt = attemptOf();
    expect(canBeginCheckout(null, SALE_ID)).toEqual({ allowed: true });
    expect(canBeginCheckout(attempt, SALE_ID)).toEqual({ allowed: false, reason: "IN_FLIGHT" });
    const uncertain = attemptAfterFailure(attempt, { message: "No hubo respuesta." });
    expect(canBeginCheckout(uncertain, SALE_ID)).toEqual({ allowed: false, reason: "UNCERTAIN" });
    // Otra venta no queda bloqueada por el intento incierto de esta.
    expect(canBeginCheckout(uncertain, OTHER_SALE_ID)).toEqual({ allowed: true });
    // Descartar el intento no existe como transición: solo lo resuelve el
    // reintento con la misma clave (que revela el replay si ya se había cobrado).
    const confirmed = attemptConfirmed(uncertain, parseCheckoutResult(wireResult({ replayed: true })));
    expect(canBeginCheckout(confirmed, SALE_ID)).toEqual({ allowed: false, reason: "ALREADY_CONFIRMED" });
    // El caso que Codex marcó: un 409 pelado NO prueba que no se cobró.
    const stillUncertain = attemptAfterFailure(uncertain, { status: 409, message: "La venta ya fue cobrada." });
    expect(stillUncertain.state).toBe("UNCERTAIN");
    expect(stillUncertain.operationKey).toBe(OPERATION_KEY);
    expect(canBeginCheckout(stillUncertain, SALE_ID)).toEqual({ allowed: false, reason: "UNCERTAIN" });
  });

  it("A9 los códigos conocidos del servidor tampoco liberan un intento PENDIENTE", () => {
    const attempt = attemptOf();
    // Todos estos códigos se lanzan con la transacción todavía sin commitear
    // (checkout.service.ts: "Every one is thrown before the commit and leaves no
    // row"), pero eso no alcanza: el envío anterior de ESTA clave pudo haber
    // cometido y perdido su respuesta, y varios de estos rechazos (FORBIDDEN,
    // INVALID_SALE_STATE) se evalúan antes de resolver la operationKey.
    for (const [status, code] of [
      [400, "VALIDATION_ERROR"],
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [409, "INVALID_SALE_STATE"],
      [409, "PAYMENT_METHOD_NOT_ENABLED"],
      [409, "PRICING_SNAPSHOT_INCONSISTENT"],
      [409, "CHECKOUT_QUOTE_CHANGED"],
      [409, "CASH_RECEIVED_INSUFFICIENT"],
      [409, "NO_OPEN_CASH_SESSION"],
      [409, "CASH_SESSION_BRANCH_MISMATCH"],
      [409, "RESERVATION_EXPIRED"],
      [409, "INVALID_RESERVATION"],
      [409, "INSUFFICIENT_PHYSICAL"],
      [409, "INSUFFICIENT_RESERVED"],
      [409, "EXTERNAL_REFERENCE_ALREADY_RECORDED"],
      [409, "UNAPPLIED_EXTERNAL_COLLECTION_PENDING"],
      [409, "EXTERNAL_COLLECTION_NOT_APPLICABLE"],
      [409, "CONCURRENCY_ERROR"],
      [409, "SALE_ALREADY_CHECKED_OUT"],
      [409, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"],
    ] as const) {
      const next = attemptAfterFailure(attempt, { status, code, message: code });
      expect(next.state, code).toBe("UNCERTAIN");
      expect(next.operationKey, code).toBe(OPERATION_KEY);
      expect(next.body, code).toBe(attempt.body);
    }
  });

  it("A10 un 4xx sin código, o con un conflicto, tampoco es prueba de no cobro", () => {
    const attempt = attemptOf();
    for (const failure of [
      // Un 409 pelado (el caso que Codex marcó en la revisión anterior).
      { status: 409, message: "conflicto" },
      // Conflictos cuya respuesta no demuestra que este intento no se confirmó.
      { status: 409, code: "CONCURRENCY_ERROR", message: "Concurrencia." },
      { status: 409, code: "SALE_ALREADY_CHECKED_OUT", message: "Ya cobrada." },
      { status: 409, code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", message: "Clave repetida." },
      // Códigos desconocidos (el servidor agrega uno nuevo): jamás se interpretan.
      { status: 409, code: "CODIGO_NUEVO_DEL_SERVIDOR", message: "?" },
      // 401 tiene su propio bullet: nunca es prueba de no cobro.
      { status: 401, code: "UNAUTHORIZED", message: "Sesión vencida." },
    ]) {
      const next = attemptAfterFailure(attempt, failure);
      expect(next.state, JSON.stringify(failure)).toBe("UNCERTAIN");
      expect(next.operationKey, JSON.stringify(failure)).toBe(OPERATION_KEY);
      expect(next.body, JSON.stringify(failure)).toBe(attempt.body);
    }
  });

  it("A11 un código conocido con un status inesperado tampoco decide nada", () => {
    const attempt = attemptOf();
    expect(attemptAfterFailure(attempt, { status: 500, code: "VALIDATION_ERROR", message: "raro" }).state).toBe("UNCERTAIN");
    expect(attemptAfterFailure(attempt, { code: "VALIDATION_ERROR", message: "sin status" }).state).toBe("UNCERTAIN");
  });

  it("A12 un intento ya incierto se conserva incierto ante cualquier error", () => {
    const uncertain = attemptAfterFailure(attemptOf(), { message: "No hubo respuesta." });
    // Un conflicto posterior no puede descartar lo que ya era incierto.
    const conflicted = attemptAfterFailure(uncertain, { status: 409, code: "CONCURRENCY_ERROR", message: "Concurrencia." });
    expect(conflicted.state).toBe("UNCERTAIN");
    expect(conflicted.operationKey).toBe(OPERATION_KEY);
    expect(conflicted.body).toBe(uncertain.body);
    expect(attemptAfterFailure(conflicted, { status: 409, code: "CODIGO_NUEVO_DEL_SERVIDOR", message: "?" }).state).toBe("UNCERTAIN");
    expect(attemptAfterFailure(conflicted, { status: 502, message: "Bad gateway." }).state).toBe("UNCERTAIN");
    // Ni siquiera un código conocido y determinista lo libera: sólo una
    // respuesta exitosa del checkout de esa clave lo resuelve.
    expect(attemptAfterFailure(conflicted, { status: 409, code: "CHECKOUT_QUOTE_CHANGED", message: "Cotización vieja." }).state)
      .toBe("UNCERTAIN");
  });

  it("A15 un intento incierto no se libera jamás por un error posterior", () => {
    const uncertain = attemptAfterFailure(attemptOf(), { message: "No hubo respuesta." });
    for (const failure of [
      // El defecto reportado: el 403 sale de la autorización, ANTES de mirar la operationKey.
      { status: 403, code: "FORBIDDEN", message: "Sin permiso." },
      { status: 403, message: "Sin permiso, sin código." },
      // Códigos que antes se consideraban "seguros": tampoco liberan un intento.
      { status: 400, code: "VALIDATION_ERROR", message: "De la lista." },
      { status: 404, code: "NOT_FOUND", message: "De la lista." },
      { status: 409, code: "CHECKOUT_QUOTE_CHANGED", message: "De la lista." },
      { status: 409, code: "INVALID_SALE_STATE", message: "De la lista." },
      // Desconocidos, conflictos, 5xx y ausencia de respuesta.
      { status: 409, code: "CODIGO_NUEVO_DEL_SERVIDOR", message: "?" },
      { status: 409, message: "conflicto pelado" },
      { status: 409, code: "CONCURRENCY_ERROR", message: "Concurrencia." },
      { status: 500, code: "CHECKOUT_STATE_INCONSISTENT", message: "500." },
      { status: 502, message: "Bad gateway." },
      { message: "Sin respuesta." },
    ]) {
      const next = attemptAfterFailure(uncertain, failure);
      expect(next.state, JSON.stringify(failure)).toBe("UNCERTAIN");
      // Clave y cuerpo idénticos: se reenvía exactamente lo mismo, sin regenerar nada.
      expect(next.operationKey, JSON.stringify(failure)).toBe(OPERATION_KEY);
      expect(next.body, JSON.stringify(failure)).toBe(uncertain.body);
      expect(retryCheckout(next).body, JSON.stringify(failure)).toBe(uncertain.body);
    }
  });

  it("A16 de un intento incierto no se sale por error: sólo lo resuelve su respuesta exitosa", () => {
    let current: CheckoutAttempt = attemptAfterFailure(attemptOf(), { message: "Sin respuesta." });
    for (const failure of [
      { status: 403, code: "FORBIDDEN", message: "Sin permiso." },
      { status: 409, code: "CHECKOUT_QUOTE_CHANGED", message: "Cotización vieja." },
      { status: 500, code: "CHECKOUT_STATE_INCONSISTENT", message: "500." },
    ]) {
      current = attemptAfterFailure(current, failure);
      expect(current.state).toBe("UNCERTAIN");
      expect(current.operationKey).toBe(OPERATION_KEY);
      // Nunca se crea un intento nuevo mientras el anterior siga incierto.
      expect(codesOf(() => beginCheckout(attemptInput(current)))).toEqual(["ATTEMPT_UNCERTAIN"]);
      expect(canBeginCheckout(current, SALE_ID)).toEqual({ allowed: false, reason: "UNCERTAIN" });
    }
    // La única salida es la respuesta exitosa del checkout de ESA clave y ESE cuerpo.
    const confirmed = attemptConfirmed(current, parseCheckoutResult(wireResult({ replayed: true })));
    expect(confirmed.state).toBe("CONFIRMED");
    expect(confirmed.operationKey).toBe(OPERATION_KEY);
    if (confirmed.state !== "CONFIRMED") throw new Error("estado inesperado");
    expect(confirmed.result.replayed).toBe(true);
    expect(codesOf(() => retryCheckout(confirmed))).toEqual(["ATTEMPT_ALREADY_CONFIRMED"]);
  });

  it("A17 un envío confirmado cuya respuesta se perdió no se libera: el retry lo revela", () => {
    const attempt = attemptOf();
    // 1) Primer envío: se reintentó y la respuesta fue un 403 de autorización.
    const afterRetry = attemptAfterFailure(attempt, { status: 403, code: "FORBIDDEN", message: "Sin permiso." });
    expect(afterRetry.state).toBe("UNCERTAIN");
    // 2) No se puede empezar otro cobro de esta venta, ni con otra clave.
    expect(codesOf(() => beginCheckout(attemptInput(afterRetry)))).toEqual(["ATTEMPT_UNCERTAIN"]);
    expect(canBeginCheckout(afterRetry, SALE_ID)).toEqual({ allowed: false, reason: "UNCERTAIN" });
    // 3) El reintento reenvía exactamente lo mismo: misma clave, mismo cuerpo.
    const retry = retryCheckout(afterRetry);
    expect(retry.operationKey).toBe(OPERATION_KEY);
    expect(retry.body).toBe(attempt.body);
    expect(retry.body).toEqual(attempt.body);
    // 4) Y si ESE envío ya había cometido, el servidor responde el replay: la
    //    única resolución posible, verificando que sea de esta venta.
    const confirmed = attemptConfirmed(afterRetry, parseCheckoutResult(wireResult({ replayed: true })));
    expect(confirmed.state).toBe("CONFIRMED");
    expect(confirmed.operationKey).toBe(OPERATION_KEY);
    expect(codesOf(() => attemptConfirmed(afterRetry, parseCheckoutResult(wireResult({ saleId: OTHER_SALE_ID })))))
      .toEqual(["RESULT_SALE_MISMATCH"]);
  });

  it("A18 un intento confirmado no se degrada por un error tardío", () => {
    const confirmed = attemptConfirmed(attemptOf(), parseCheckoutResult(wireResult({ replayed: true })));
    const late = attemptAfterFailure(confirmed, { status: 500, message: "Respuesta atrasada." });
    expect(late.state).toBe("CONFIRMED");
    expect(late).toBe(confirmed);
  });

  it("A13 beginCheckout rechaza un segundo intento de la misma venta en los tres estados", () => {
    const pending = attemptOf();
    expect(codesOf(() => beginCheckout(attemptInput(pending)))).toEqual(["ATTEMPT_IN_FLIGHT"]);
    const uncertain = attemptAfterFailure(pending, { message: "No hubo respuesta." });
    expect(codesOf(() => beginCheckout(attemptInput(uncertain)))).toEqual(["ATTEMPT_UNCERTAIN"]);
    const confirmed = attemptConfirmed(pending, parseCheckoutResult(wireResult({ replayed: true })));
    expect(codesOf(() => beginCheckout(attemptInput(confirmed)))).toEqual(["ATTEMPT_ALREADY_CONFIRMED"]);
    // El intento vigente conserva su clave y su cuerpo: nada se pisó.
    expect(pending.operationKey).toBe(OPERATION_KEY);
    expect(pending.state).toBe("PENDING");
    expect(pending.body.expectedTotal).toBe("51537");
    expect(retryCheckout(pending).body).toBe(pending.body);
  });

  it("A14 el intento vigente de otra venta no impide empezar el de esta", () => {
    const other = beginCheckout(attemptInput(null, { saleId: OTHER_SALE_ID, quote: quote({ saleId: OTHER_SALE_ID }) }));
    expect(other.state).toBe("PENDING");
    const mine = beginCheckout(attemptInput(other));
    expect(mine.operationKey).toBe(SECOND_OPERATION_KEY);
    expect(mine.saleId).toBe(SALE_ID);
    // Y sigue bloqueado el segundo intento de la MISMA venta.
    expect(codesOf(() => beginCheckout(attemptInput(mine)))).toEqual(["ATTEMPT_IN_FLIGHT"]);
  });
});

describe("X — parsing estricto del resultado del cobro", () => {
  it("X1 traduce el 201 aprobado (dinero a BigInt, pagos y renglones)", () => {
    const result = parseCheckoutResult(wireResult());
    expect(result).toEqual({
      saleId: SALE_ID,
      saleNumber: "CEN-V-000001",
      status: "COMPLETED",
      checkoutId: "checkout-1",
      replayed: false,
      total: BigInt(51537),
      changeAmount: BigInt(4963),
      payments: [
        {
          id: "pay-1", method: "CASH", tenderRole: "FIXED", amount: BigInt(20037), methodFullPrice: BigInt(20000),
          adjustmentBps: 0, externalCollectionId: null, receivedAmount: BigInt(25000), changeAmount: BigInt(4963),
        },
        {
          id: "pay-2", method: "CARD_DEBIT", tenderRole: "BALANCE", amount: BigInt(31500), methodFullPrice: BigInt(31500),
          adjustmentBps: 500, externalCollectionId: null, receivedAmount: null, changeAmount: null,
        },
      ],
      lines: [
        { saleItemId: "item-1", sku: "V1", quantity: BigInt(1), finalAmount: BigInt(20615) },
        { saleItemId: "item-2", sku: "V2", quantity: BigInt(1), finalAmount: BigInt(30922) },
      ],
      completedAt: "2030-01-01T00:00:05.000Z",
    });
  });

  it("X2 exige el estado COMPLETED y una clave de idempotencia booleana y explícita", () => {
    for (const overrides of [
      { status: "PENDING_PAYMENT" },
      { status: undefined },
      { replayed: undefined },
      { replayed: "true" },
      { checkoutId: undefined },
      { saleId: "otra-venta" },
    ]) {
      expect(codesOf(() => parseCheckoutResult(wireResult(overrides)))).toEqual(["INVALID_CHECKOUT_RESULT"]);
    }
  });

  it("X3 rechaza pagos malformados (medio, rol, dinero, bps)", () => {
    const payment = (overrides: Wire) => ({ ...(wireResult().payments as Wire[])[0]!, ...overrides });
    for (const payments of [
      [payment({ method: "BITCOIN" })],
      [payment({ tenderRole: "MIXED" })],
      [payment({ amount: "20037.5" })],
      [payment({ methodFullPrice: null })],
      [payment({ adjustmentBps: -1 })],
      [payment({ adjustmentBps: 1.5 })],
      [payment({ receivedAmount: "x" })],
      [payment({ changeAmount: "x" })],
      [{ ...payment({}), id: "" }],
    ]) {
      expect(codesOf(() => parseCheckoutResult(wireResult({ payments })))).toEqual(["INVALID_CHECKOUT_RESULT"]);
    }
  });

  it("X4 rechaza renglones y fechas inválidas", () => {
    expect(codesOf(() => parseCheckoutResult(wireResult({ lines: [{ saleItemId: "item-1", sku: "V1", quantity: "0", finalAmount: "1" }] }))))
      .toEqual(["INVALID_CHECKOUT_RESULT"]);
    for (const completedAt of ["", "ayer", 5]) {
      expect(codesOf(() => parseCheckoutResult(wireResult({ completedAt })))).toEqual(["INVALID_CHECKOUT_RESULT"]);
    }
  });

  it("X5 rechaza cuerpos que no son objetos", () => {
    for (const body of [null, undefined, [], "completed", 3]) {
      expect(codesOf(() => parseCheckoutResult(body))).toEqual(["INVALID_CHECKOUT_RESULT"]);
    }
  });
});
