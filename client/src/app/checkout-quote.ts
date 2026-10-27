// R3-A4.2a: contrato PURO del cliente para el cobro proporcional (R3-A4.1).
//
// Qué es: la traducción tipada de las dos respuestas del servidor
// (POST /sales/:saleId/checkout/quote y POST /sales/:saleId/checkout) y la
// construcción de los dos cuerpos que el POS envía. Nada más.
//
// Qué NO es ni hace:
//   * no cobra, no cotiza, no llama a HTTP y no usa React (cero efectos);
//   * no calcula precios, descuentos, redondeos ni reparto Hamilton: el motor
//     R3-A1 y el checkout del servidor son la única autoridad de precios. Acá
//     solo se copia y se muestra lo que el servidor ya decidió;
//   * no deriva totales: `expectedTotal` y `expectedBalanceAmount` salen
//     literales de la cotización vigente (el servidor los vuelve a calcular y
//     responde CHECKOUT_QUOTE_CHANGED si cambiaron);
//   * no inventa importes de vuelto: la previsualización es una resta exacta
//     en BigInt y el valor definitivo es siempre `changeAmount` del servidor;
//   * no acepta un importe fuera del BIGINT de PostgreSQL (int8): el límite real
//     es el valor (9223372036854775807), no la cantidad de dígitos;
//   * no libera un intento por un error: ningún status ni código lo descarta,
//     porque un envío PENDING puede ser un checkout ya confirmado cuya respuesta
//     se perdió (un 403 sale antes de mirar la operationKey). El intento se
//     conserva incierto con operationKey y cuerpo para un replay idéntico, y
//     sólo lo resuelve la respuesta exitosa del checkout de esa misma clave;
//   * no deja mudo al saldo no-efectivo: el servidor exige referencia (y
//     institución, si es transferencia) en TODO tender que no sea efectivo, el
//     BALANCE incluido, y prohíbe imputarle un cobro ya registrado. El draft
//     lleva esos datos del saldo y los valida con las mismas reglas que un fijo.
//
// El draft (medios e importes que la cajera compone) es una INTENCIÓN: no
// expone ningún total. La cotización es el único enunciado de cifras, y el
// cobro solo puede armarse desde una cotización que corresponda exactamente a
// ese draft.

export const PROPORTIONAL_METHODS = ["CASH", "TRANSFER", "CARD_DEBIT", "CARD_CREDIT", "QR"] as const;
export type ProportionalMethod = (typeof PROPORTIONAL_METHODS)[number];

export const TRANSFER_INSTITUTIONS = ["MACRO", "BBVA", "NACION", "GALICIA", "MERCADO_PAGO", "OTHER"] as const;
export type TransferInstitution = (typeof TRANSFER_INSTITUTIONS)[number];

// El cobro externo pendiente puede ser de cualquier medio (aunque solo los tres
// de R3 se pueden cobrar por esta vía).
export type PaymentMethod = "CASH" | "TRANSFER" | "CARD_DEBIT" | "CARD_CREDIT" | "QR";

// La única razón de indisponibilidad que el motor R3-A1 conoce: sin
// configuración de precios de la empresa, solo el efectivo se puede tasar.
export const PRICING_CONFIG_MISSING = "PRICING_CONFIG_MISSING";

// Paridad con el DTO del servidor: centavos como string decimal canónico
// (sin signo, sin ceros a la izquierda, hasta 19 dígitos) y cantidades como
// entero positivo.
const CENTAVOS = /^(0|[1-9][0-9]{0,18})$/;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
// El límite real de un importe no es la cantidad de dígitos sino el BIGINT de
// PostgreSQL: 9223372036854775807 entra, 9223372036854775808 no. Se compara con
// BigInt (nunca Number) y sin literales BigInt (el target del cliente es ES2017).
const MAX_CENTAVOS = BigInt("9223372036854775807");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Paridad con chk_ec_reference y con la clave canónica del servidor.
const MAX_REFERENCE_CODE_POINTS = 64;
const MIN_REFERENCE_KEY_LENGTH = 3;
const MAX_REFERENCE_KEY_LENGTH = 40;
const MAX_INSTITUTION_OTHER_LENGTH = 60;

// ---------------------------------------------------------------------------
// Cotización (200 de POST /sales/:saleId/checkout/quote)
// ---------------------------------------------------------------------------

export type MethodAvailability =
  | { available: true }
  | { available: false; reason: typeof PRICING_CONFIG_MISSING };

export type QuoteTender = { method: ProportionalMethod; role: "FIXED"; amount: bigint };

export type QuoteLine = { saleItemId: string; sku: string; quantity: bigint; finalAmount: bigint };

export type QuoteCollection = {
  id: string;
  method: PaymentMethod;
  amount: bigint;
  reference: string;
  institution: TransferInstitution | null;
  institutionOther: string | null;
};

export type CheckoutQuote = {
  saleId: string;
  saleNumber: string | null;
  pricingModel: "PROPORTIONAL_V1";
  enabledMethods: Array<{ method: ProportionalMethod } & MethodAvailability>;
  fullPrices: Record<ProportionalMethod, bigint | null>;
  tenders: QuoteTender[];
  balance: { method: ProportionalMethod; amount: bigint };
  total: bigint;
  lines: QuoteLine[];
  unappliedCollections: QuoteCollection[];
  reservationExpiresAt: string | null;
};

// ---------------------------------------------------------------------------
// Resultado del cobro (200/201 de POST /sales/:saleId/checkout)
// ---------------------------------------------------------------------------

export type CheckoutPayment = {
  id: string;
  method: PaymentMethod;
  tenderRole: "FIXED" | "BALANCE";
  amount: bigint;
  methodFullPrice: bigint;
  adjustmentBps: number;
  externalCollectionId: string | null;
  receivedAmount: bigint | null;
  changeAmount: bigint | null;
};

export type CheckoutResult = {
  saleId: string;
  saleNumber: string | null;
  status: "COMPLETED";
  checkoutId: string;
  replayed: boolean;
  total: bigint;
  changeAmount: bigint;
  payments: CheckoutPayment[];
  lines: QuoteLine[];
  completedAt: string;
};

// ---------------------------------------------------------------------------
// Intención del cajero
// ---------------------------------------------------------------------------

export type FixedTenderDraft = {
  method: ProportionalMethod;
  // Centavos exactos, tal como los produce el campo de importe del POS.
  amount: string;
  // Solo efectivo: lo recibido, para el vuelto.
  receivedAmount?: string | null;
  // Referencia nueva (según el medio) o cobro externo ya registrado, nunca ambos.
  reference?: string | null;
  institution?: TransferInstitution | null;
  institutionOther?: string | null;
  externalCollectionId?: string | null;
};

export type CheckoutDraft = {
  balanceMethod: ProportionalMethod;
  fixed: readonly FixedTenderDraft[];
  // Solo cuando el medio de saldo es efectivo.
  receivedAmount?: string | null;
  // Y solo cuando NO lo es: el saldo viaja con la MISMA carga probatoria que un
  // importe fijo de débito/transferencia, porque el servidor se la exige
  // (referencia obligatoria; institución obligatoria en transferencia, con su
  // etiqueta cuando es «Otra»). El saldo nunca imputa un cobro registrado: un
  // cobro externo solo puede ser un importe fijo, así que no hay campo para
  // eso.
  balanceReference?: string | null;
  balanceInstitution?: TransferInstitution | null;
  balanceInstitutionOther?: string | null;
};

export type QuoteRequestBody = {
  balanceMethod: ProportionalMethod;
  tenders: Array<{ method: ProportionalMethod; amount: string }>;
};

export type CheckoutTenderBody = {
  method: ProportionalMethod;
  role: "FIXED" | "BALANCE";
  amount?: string;
  receivedAmount?: string | null;
  reference?: string | null;
  institution?: TransferInstitution | null;
  institutionOther?: string | null;
  externalCollectionId?: string | null;
};

export type CheckoutRequestBody = {
  operationKey: string;
  cashSessionId: string;
  balanceMethod: ProportionalMethod;
  expectedTotal: string;
  expectedBalanceAmount: string;
  tenders: CheckoutTenderBody[];
};

export type ChangePreview = { allocated: bigint; received: bigint; change: bigint };

// ---------------------------------------------------------------------------
// Intento de cobro: pendiente, confirmado o de resultado incierto
// ---------------------------------------------------------------------------

type AttemptBase = {
  saleId: string;
  operationKey: string;
  // El cuerpo se conserva tal cual se envió: un reintento reenvía ESTE cuerpo,
  // nunca uno reconstruido desde un draft que pudo cambiar.
  body: CheckoutRequestBody;
  quotedTotal: bigint;
  quotedBalance: bigint;
};

export type CheckoutAttempt =
  | (AttemptBase & { state: "PENDING" })
  | (AttemptBase & { state: "CONFIRMED"; result: CheckoutResult })
  | (AttemptBase & { state: "UNCERTAIN"; message: string });

export type CheckoutRequestInput = {
  saleId: string;
  cashSessionId: string;
  operationKey: string;
  draft: CheckoutDraft;
  quote: CheckoutQuote;
};

export type BeginCheckoutInput = CheckoutRequestInput & {
  // El intento vigente de esta venta, si lo hay. Es obligatorio: crear el
  // intento y autorizarlo son el mismo acto, no dos pasos que la interfaz
  // deba recordar hacer en el orden correcto.
  current: CheckoutAttempt | null;
};

export type BeginDecision =
  | { allowed: true }
  | { allowed: false; reason: "IN_FLIGHT" | "UNCERTAIN" | "ALREADY_CONFIRMED" };

// Lo que el POS sabe de un envío fallido. `status` y `code` viajan tal como
// llegaron (los tests fijan que NO deciden nada): ninguna respuesta de error
// libera un intento, porque cualquiera de ellos puede ser posterior a un envío
// de la misma clave que sí cometió. Sólo se usa `message` para mostrar.
export type CheckoutFailure = { status?: number; code?: string | null; message: string };

// ---------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------

export type DraftIssue =
  | "TOO_MANY_FIXED_TENDERS"
  | "DUPLICATE_METHOD"
  | "BALANCE_METHOD_ALSO_FIXED"
  | "INVALID_AMOUNT"
  | "AMOUNT_BELOW_MINIMUM"
  | "RECEIVED_REQUIRED"
  | "RECEIVED_BELOW_AMOUNT"
  | "RECEIVED_ONLY_FOR_CASH"
  | "REFERENCE_NOT_ALLOWED"
  | "REFERENCE_XOR_COLLECTION"
  | "REFERENCE_INVALID"
  | "INSTITUTION_REQUIRED"
  | "INSTITUTION_NOT_ALLOWED"
  | "INSTITUTION_OTHER_REQUIRED"
  | "INSTITUTION_OTHER_NOT_ALLOWED"
  | "INVALID_COLLECTION_ID"
  | "METHOD_NOT_AVAILABLE";

export type CheckoutErrorCode =
  | DraftIssue
  | "INVALID_QUOTE_RESPONSE"
  | "INVALID_RESERVATION_RESPONSE"
  | "INVALID_CHECKOUT_RESULT"
  | "INVALID_SALE_ID"
  | "INVALID_SESSION_ID"
  | "INVALID_OPERATION_KEY"
  | "QUOTE_DOES_NOT_MATCH_DRAFT"
  | "RESULT_SALE_MISMATCH"
  | "ATTEMPT_IN_FLIGHT"
  | "ATTEMPT_UNCERTAIN"
  | "ATTEMPT_ALREADY_CONFIRMED";

// Por qué no se puede empezar un cobro nuevo de la misma venta.
const BEGIN_REFUSALS: Record<"IN_FLIGHT" | "UNCERTAIN" | "ALREADY_CONFIRMED", { code: CheckoutErrorCode; message: string }> = {
  IN_FLIGHT: { code: "ATTEMPT_IN_FLIGHT", message: "Ya hay un cobro en curso para esta venta." },
  UNCERTAIN: {
    code: "ATTEMPT_UNCERTAIN",
    message: "No se pudo confirmar el cobro anterior: reintentá con la misma clave antes de cobrar de nuevo.",
  },
  ALREADY_CONFIRMED: { code: "ATTEMPT_ALREADY_CONFIRMED", message: "Este cobro ya se confirmó: no se repite." },
};

export class CheckoutContractError extends Error {
  constructor(
    public readonly code: CheckoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CheckoutContractError";
  }
}

// Textos en español para la UI: el POS muestra estos motivos tal cual y nunca
// inventa uno propio.
const DRAFT_ISSUE_MESSAGES: Record<DraftIssue, string> = {
  TOO_MANY_FIXED_TENDERS: "Se admiten como máximo dos importes fijos.",
  DUPLICATE_METHOD: "Los medios de pago no pueden repetirse.",
  BALANCE_METHOD_ALSO_FIXED: "El medio de saldo no puede cargarse además como importe fijo.",
  INVALID_AMOUNT: "Ingresá un importe en centavos exactos.",
  AMOUNT_BELOW_MINIMUM: "Un importe fijo debe ser mayor que cero.",
  RECEIVED_REQUIRED: "Ingresá el efectivo recibido.",
  RECEIVED_BELOW_AMOUNT: "El efectivo recibido no puede ser menor al importe.",
  RECEIVED_ONLY_FOR_CASH: "Solo el efectivo lleva importe recibido.",
  REFERENCE_NOT_ALLOWED: "El efectivo no lleva referencia ni institución.",
  REFERENCE_XOR_COLLECTION: "Débito y transferencia llevan referencia o un cobro registrado, nunca ambos.",
  REFERENCE_INVALID: "La referencia no tiene un formato válido.",
  INSTITUTION_REQUIRED: "Elegí la institución de la transferencia.",
  INSTITUTION_NOT_ALLOWED: "Este medio no lleva institución.",
  INSTITUTION_OTHER_REQUIRED: "La institución «Otra» requiere un nombre.",
  INSTITUTION_OTHER_NOT_ALLOWED: "El nombre alternativo solo se usa con la institución «Otra».",
  INVALID_COLLECTION_ID: "El cobro registrado no corresponde a esta venta o a este importe.",
  METHOD_NOT_AVAILABLE: "Ese medio de pago no está habilitado para esta venta.",
};

const PARSE_FAILURES = {
  quote: "INVALID_QUOTE_RESPONSE",
  result: "INVALID_CHECKOUT_RESULT",
} as const;

const quoteFailure = (): never => {
  throw new CheckoutContractError(PARSE_FAILURES.quote, "La cotización recibida del servidor no es válida.");
};
const resultFailure = (): never => {
  throw new CheckoutContractError(PARSE_FAILURES.result, "El resultado del cobro recibido del servidor no es válido.");
};
const draftFailure = (code: CheckoutErrorCode, message?: string) =>
  new CheckoutContractError(code, message ?? "El cobro no se puede armar con los datos actuales.");

// ---------------------------------------------------------------------------
// Primitivas de validación
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProportionalMethod(value: unknown): value is ProportionalMethod {
  return (PROPORTIONAL_METHODS as readonly string[]).includes(value as string);
}

function isPaymentMethod(value: unknown): value is PaymentMethod {
  return value === "CASH" || value === "TRANSFER" || value === "CARD_DEBIT" || value === "CARD_CREDIT" || value === "QR";
}

function isTransferInstitution(value: unknown): value is TransferInstitution {
  return (TRANSFER_INSTITUTIONS as readonly string[]).includes(value as string);
}

// Centavos canónicos -> BigInt. `null` cuando el valor no es un entero de
// centavos válido o cuando supera el BIGINT de PostgreSQL (nunca un Number: la
// exactitud es intocable).
function centavosOf(value: unknown): bigint | null {
  if (typeof value !== "string" || !CENTAVOS.test(value)) return null;
  const parsed = BigInt(value);
  if (parsed > MAX_CENTAVOS) return null;
  return parsed;
}

function requiredCentavos(value: unknown, fail: () => never): bigint {
  const parsed = centavosOf(value);
  if (parsed === null) fail();
  return parsed;
}

function optionalCentavos(value: unknown, fail: () => never): bigint | null {
  if (value === null) return null;
  return requiredCentavos(value, fail);
}

function requiredText(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// Paridad con normalizeReferenceKey del servidor: mayúsculas y [A-Z0-9].
function referenceKey(reference: string): string {
  return reference.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// Parsing de la cotización
// ---------------------------------------------------------------------------

export function parseCheckoutQuote(value: unknown): CheckoutQuote {
  const fail: () => never = quoteFailure;
  if (!isRecord(value)) fail();

  const saleId = requiredText(value.saleId);
  if (saleId === null || !UUID.test(saleId)) fail();
  const saleNumber = value.saleNumber === null ? null : requiredText(value.saleNumber);
  if (value.saleNumber !== null && saleNumber === null) fail();
  if (value.pricingModel !== "PROPORTIONAL_V1") fail();

  if (!Array.isArray(value.enabledMethods) || value.enabledMethods.length !== PROPORTIONAL_METHODS.length) fail();
  const enabledMethods: CheckoutQuote["enabledMethods"] = [];
  const seenMethods = new Set<ProportionalMethod>();
  for (const entry of value.enabledMethods as unknown[]) {
    if (!isRecord(entry) || !isProportionalMethod(entry.method) || seenMethods.has(entry.method)) fail();
    if (typeof entry.available !== "boolean") fail();
    seenMethods.add(entry.method);
    if (entry.available) {
      // Un medio disponible no declara motivo: si lo trae, el contrato cambió.
      if (entry.reason !== undefined) fail();
      enabledMethods.push({ method: entry.method, available: true });
    } else {
      if (entry.reason !== PRICING_CONFIG_MISSING) fail();
      enabledMethods.push({ method: entry.method, available: false, reason: PRICING_CONFIG_MISSING });
    }
  }
  if (seenMethods.size !== PROPORTIONAL_METHODS.length) fail();

  if (!isRecord(value.fullPrices)) fail();
  const fullPrices = { CASH: null, TRANSFER: null, CARD_DEBIT: null, CARD_CREDIT: null, QR: null } as CheckoutQuote["fullPrices"];
  for (const method of PROPORTIONAL_METHODS) {
    const raw = (value.fullPrices as Record<string, unknown>)[method];
    fullPrices[method] = raw === null ? null : requiredCentavos(raw, fail);
  }

  if (!Array.isArray(value.tenders)) fail();
  const tenders: QuoteTender[] = (value.tenders as unknown[]).map((entry) => {
    if (!isRecord(entry) || !isProportionalMethod(entry.method) || entry.role !== "FIXED") fail();
    return { method: entry.method, role: "FIXED" as const, amount: requiredCentavos(entry.amount, fail) };
  });

  if (!isRecord(value.balance) || !isProportionalMethod(value.balance.method)) fail();
  const balance = {
    method: value.balance.method,
    amount: requiredCentavos(value.balance.amount, fail),
  };

  if (!Array.isArray(value.lines)) fail();
  const lines: QuoteLine[] = (value.lines as unknown[]).map((entry) => {
    if (!isRecord(entry)) fail();
    const saleItemId = requiredText(entry.saleItemId);
    const sku = requiredText(entry.sku);
    if (saleItemId === null || sku === null) fail();
    if (typeof entry.quantity !== "string" || !POSITIVE_INTEGER.test(entry.quantity)) fail();
    return {
      saleItemId,
      sku,
      quantity: BigInt(entry.quantity),
      finalAmount: requiredCentavos(entry.finalAmount, fail),
    };
  });

  if (!Array.isArray(value.unappliedCollections)) fail();
  const unappliedCollections: QuoteCollection[] = (value.unappliedCollections as unknown[]).map((entry) => {
    if (!isRecord(entry)) fail();
    const id = requiredText(entry.id);
    const reference = requiredText(entry.reference);
    if (id === null || reference === null || !isPaymentMethod(entry.method)) fail();
    if (entry.institution !== null && !isTransferInstitution(entry.institution)) fail();
    if (entry.institutionOther !== null && requiredText(entry.institutionOther) === null) fail();
    return {
      id,
      method: entry.method,
      amount: requiredCentavos(entry.amount, fail),
      reference,
      institution: entry.institution === null ? null : entry.institution,
      institutionOther: entry.institutionOther === null ? null : (entry.institutionOther as string),
    };
  });

  let reservationExpiresAt: string | null = null;
  if (value.reservationExpiresAt !== null) {
    const instant = requiredText(value.reservationExpiresAt);
    if (instant === null || Number.isNaN(Date.parse(instant))) fail();
    reservationExpiresAt = instant;
  }

  return {
    saleId,
    saleNumber,
    pricingModel: "PROPORTIONAL_V1",
    enabledMethods,
    fullPrices,
    tenders,
    balance,
    total: requiredCentavos(value.total, fail),
    lines,
    unappliedCollections,
    reservationExpiresAt,
  };
}

// ---------------------------------------------------------------------------
// Parsing del resultado del cobro
// ---------------------------------------------------------------------------

function parseQuoteLines(value: unknown, fail: () => never): QuoteLine[] {
  if (!Array.isArray(value)) fail();
  return (value as unknown[]).map((entry) => {
    if (!isRecord(entry)) fail();
    const saleItemId = requiredText(entry.saleItemId);
    const sku = requiredText(entry.sku);
    if (saleItemId === null || sku === null) fail();
    if (typeof entry.quantity !== "string" || !POSITIVE_INTEGER.test(entry.quantity)) fail();
    return { saleItemId, sku, quantity: BigInt(entry.quantity), finalAmount: requiredCentavos(entry.finalAmount, fail) };
  });
}

export function parseCheckoutResult(value: unknown): CheckoutResult {
  const fail: () => never = resultFailure;
  if (!isRecord(value)) fail();

  const saleId = requiredText(value.saleId);
  if (saleId === null || !UUID.test(saleId)) fail();
  const saleNumber = value.saleNumber === null ? null : requiredText(value.saleNumber);
  if (value.saleNumber !== null && saleNumber === null) fail();
  if (value.status !== "COMPLETED") fail();
  const checkoutId = requiredText(value.checkoutId);
  if (checkoutId === null) fail();
  if (typeof value.replayed !== "boolean") fail();

  if (!Array.isArray(value.payments)) fail();
  const payments: CheckoutPayment[] = (value.payments as unknown[]).map((entry) => {
    if (!isRecord(entry)) fail();
    const id = requiredText(entry.id);
    if (id === null || !isPaymentMethod(entry.method)) fail();
    if (entry.tenderRole !== "FIXED" && entry.tenderRole !== "BALANCE") fail();
    if (typeof entry.adjustmentBps !== "number" || !Number.isSafeInteger(entry.adjustmentBps) || entry.adjustmentBps < 0) fail();
    if (entry.externalCollectionId !== null && requiredText(entry.externalCollectionId) === null) fail();
    return {
      id,
      method: entry.method,
      tenderRole: entry.tenderRole,
      amount: requiredCentavos(entry.amount, fail),
      methodFullPrice: requiredCentavos(entry.methodFullPrice, fail),
      adjustmentBps: entry.adjustmentBps,
      externalCollectionId: entry.externalCollectionId === null ? null : (entry.externalCollectionId as string),
      receivedAmount: optionalCentavos(entry.receivedAmount, fail),
      changeAmount: optionalCentavos(entry.changeAmount, fail),
    };
  });

  const completedAt = requiredText(value.completedAt);
  if (completedAt === null || Number.isNaN(Date.parse(completedAt))) fail();

  return {
    saleId,
    saleNumber,
    status: "COMPLETED",
    checkoutId,
    replayed: value.replayed,
    total: requiredCentavos(value.total, fail),
    changeAmount: requiredCentavos(value.changeAmount, fail),
    payments,
    lines: parseQuoteLines(value.lines, fail),
    completedAt,
  };
}

// ---------------------------------------------------------------------------
// Medios habilitados
// ---------------------------------------------------------------------------

const UNAVAILABLE: MethodAvailability = { available: false, reason: PRICING_CONFIG_MISSING };

export function methodAvailability(quote: CheckoutQuote): Record<ProportionalMethod, MethodAvailability> {
  const availability = { CASH: UNAVAILABLE, TRANSFER: UNAVAILABLE, CARD_DEBIT: UNAVAILABLE, CARD_CREDIT: UNAVAILABLE, QR: UNAVAILABLE };
  for (const entry of quote.enabledMethods) {
    availability[entry.method] = entry.available ? { available: true } : UNAVAILABLE;
  }
  return availability;
}

export function availableMethods(quote: CheckoutQuote): ProportionalMethod[] {
  const availability = methodAvailability(quote);
  return PROPORTIONAL_METHODS.filter((method) => availability[method].available);
}

// ---------------------------------------------------------------------------
// Validación del draft
// ---------------------------------------------------------------------------

type IssueSink = DraftIssue[];

// Grupo de precios/estructura: es lo único que la COTIZACIÓN necesita. Un draft
// al que todavía le falta la referencia sigue siendo cotizable (el importe y el
// medio ya están definidos), así el total se ve mientras se completa el pago.
function pricingIssues(draft: CheckoutDraft, issues: IssueSink): void {
  if (draft.fixed.length > 2) issues.push("TOO_MANY_FIXED_TENDERS");
  const methods = new Set<ProportionalMethod>();
  for (const tender of draft.fixed) {
    if (methods.has(tender.method)) issues.push("DUPLICATE_METHOD");
    methods.add(tender.method);
    if (tender.method === draft.balanceMethod) issues.push("BALANCE_METHOD_ALSO_FIXED");
    const amount = centavosOf(tender.amount);
    if (amount === null) issues.push("INVALID_AMOUNT");
    else if (amount < BigInt(1)) issues.push("AMOUNT_BELOW_MINIMUM");
  }
}

function cashReceived(value: unknown, issues: IssueSink): bigint | null {
  if (value === null || value === undefined || value === "") {
    issues.push("RECEIVED_REQUIRED");
    return null;
  }
  const received = centavosOf(value);
  if (received === null) issues.push("INVALID_AMOUNT");
  return received;
}

// Reglas comunes de todo tender no-efectivo, sea un importe fijo o el saldo:
// la referencia es obligatoria (o un cobro registrado, que solo puede ser un
// fijo), la institución es obligatoria en transferencia y prohibida en débito,
// y «Otra» exige su etiqueta. Paridad con el DTO y el servicio del servidor,
// que vuelven a validarlo y siguen siendo la autoridad.
function nonCashIssues(
  method: ProportionalMethod,
  reference: string | null,
  institution: TransferInstitution | null,
  institutionOther: string | null,
  collectionId: string | null,
  issues: IssueSink,
): void {
  if (institutionOther !== null) {
    const label = institutionOther.trim();
    if (institution !== "OTHER") issues.push("INSTITUTION_OTHER_NOT_ALLOWED");
    else if (label.length === 0 || label.length > MAX_INSTITUTION_OTHER_LENGTH) issues.push("INSTITUTION_OTHER_REQUIRED");
  } else if (institution === "OTHER") {
    issues.push("INSTITUTION_OTHER_REQUIRED");
  }

  if ((reference === null) === (collectionId === null)) {
    issues.push("REFERENCE_XOR_COLLECTION");
  } else if (reference !== null) {
    const length = [...reference].length;
    const key = referenceKey(reference);
    if (length < 1 || length > MAX_REFERENCE_CODE_POINTS) issues.push("REFERENCE_INVALID");
    else if (key.length < MIN_REFERENCE_KEY_LENGTH || key.length > MAX_REFERENCE_KEY_LENGTH) issues.push("REFERENCE_INVALID");
  }

  if (collectionId !== null) {
    if (!UUID.test(collectionId)) issues.push("INVALID_COLLECTION_ID");
    // Un cobro ya registrado trae su propia institución: repetirla es inválido.
    if (institution !== null) issues.push("INSTITUTION_NOT_ALLOWED");
    return;
  }

  if (method === "TRANSFER") {
    if (institution === null || !isTransferInstitution(institution)) issues.push("INSTITUTION_REQUIRED");
  } else if (institution !== null) {
    issues.push("INSTITUTION_NOT_ALLOWED");
  }
}

// Grupo de pago: qué debe llevar cada medio. Espejo de presentación del DTO
// (el servidor vuelve a validarlo y sigue siendo la autoridad).
function paymentIssues(draft: CheckoutDraft, issues: IssueSink): void {
  for (const tender of draft.fixed) {
    const amount = centavosOf(tender.amount);
    const collectionId = tender.externalCollectionId ?? null;
    const reference = tender.reference ?? null;
    const institution = tender.institution ?? null;
    const institutionOther = tender.institutionOther ?? null;

    if (tender.method === "CASH") {
      if (reference !== null || institution !== null || institutionOther !== null || collectionId !== null) {
        issues.push("REFERENCE_NOT_ALLOWED");
      }
      const received = cashReceived(tender.receivedAmount, issues);
      if (received !== null && amount !== null && received < amount) issues.push("RECEIVED_BELOW_AMOUNT");
      continue;
    }

    if (tender.receivedAmount !== null && tender.receivedAmount !== undefined) issues.push("RECEIVED_ONLY_FOR_CASH");
    nonCashIssues(tender.method, reference, institution, institutionOther, collectionId, issues);
  }

  // El saldo: en efectivo lleva lo recibido; fuera del efectivo se valida igual
  // que un fijo (referencia obligatoria, institución obligatoria en
  // transferencia) y nunca con un cobro registrado, que no tiene campo acá
  // porque el servidor solo lo imputa como importe fijo.
  const balanceReference = draft.balanceReference ?? null;
  const balanceInstitution = draft.balanceInstitution ?? null;
  const balanceInstitutionOther = draft.balanceInstitutionOther ?? null;
  if (draft.balanceMethod === "CASH") {
    if (balanceReference !== null || balanceInstitution !== null || balanceInstitutionOther !== null) {
      issues.push("REFERENCE_NOT_ALLOWED");
    }
    cashReceived(draft.receivedAmount, issues);
    return;
  }
  if (draft.receivedAmount !== null && draft.receivedAmount !== undefined) issues.push("RECEIVED_ONLY_FOR_CASH");
  nonCashIssues(draft.balanceMethod, balanceReference, balanceInstitution, balanceInstitutionOther, null, issues);
}

// Grupo de disponibilidad: solo se puede afirmar con una cotización vigente.
function availabilityIssues(draft: CheckoutDraft, quote: CheckoutQuote, issues: IssueSink): void {
  const availability = methodAvailability(quote);
  if (!availability[draft.balanceMethod].available) issues.push("METHOD_NOT_AVAILABLE");
  for (const tender of draft.fixed) {
    if (!availability[tender.method].available) issues.push("METHOD_NOT_AVAILABLE");
  }
}

// Un cobro externo solo se puede imputar si figura entre los pendientes de ESTA
// venta, con su medio y su importe exactos (el servidor exige lo mismo al
// aplicar el cobro).
function collectionIssues(draft: CheckoutDraft, quote: CheckoutQuote, issues: IssueSink): void {
  for (const tender of draft.fixed) {
    const collectionId = tender.externalCollectionId ?? null;
    if (collectionId === null) continue;
    const pending = quote.unappliedCollections.find((collection) => collection.id === collectionId);
    if (!pending) {
      issues.push("INVALID_COLLECTION_ID");
      continue;
    }
    if (pending.method !== tender.method || pending.amount.toString() !== tender.amount) {
      issues.push("INVALID_COLLECTION_ID");
    }
  }
}

// Todo lo que impide armar el cobro. Sin cotización se omite lo que depende de
// ella (disponibilidad y cobros externos).
export function draftIssues(draft: CheckoutDraft, quote?: CheckoutQuote | null): DraftIssue[] {
  const issues: IssueSink = [];
  pricingIssues(draft, issues);
  paymentIssues(draft, issues);
  if (quote) {
    availabilityIssues(draft, quote, issues);
    collectionIssues(draft, quote, issues);
  }
  return [...new Set(issues)];
}

function throwFirstIssue(issues: DraftIssue[]): void {
  const first = issues[0];
  if (first === undefined) return;
  throw draftFailure(first, DRAFT_ISSUE_MESSAGES[first]);
}

// ---------------------------------------------------------------------------
// Construcción de los cuerpos
// ---------------------------------------------------------------------------

export function buildQuoteRequest(draft: CheckoutDraft): QuoteRequestBody {
  const issues: IssueSink = [];
  pricingIssues(draft, issues);
  throwFirstIssue([...new Set(issues)]);
  return {
    balanceMethod: draft.balanceMethod,
    tenders: draft.fixed.map((tender) => ({ method: tender.method, amount: tender.amount })),
  };
}

// ¿La cotización describe exactamente esta venta y este draft? Se compara el
// saleId y, además, medios e importes fijos y medio de saldo. El orden de los
// fijos no importa: dos ventas con los mismos importes y medios jamás se
// confunden porque el saleId decide.
function tenderKey(entries: ReadonlyArray<{ method: ProportionalMethod; amount: string }>): string {
  return entries.map((entry) => `${entry.method}:${entry.amount}`).sort().join("|");
}

export function quoteMatchesDraft(quote: CheckoutQuote, draft: CheckoutDraft, saleId: string): boolean {
  if (quote.saleId !== saleId) return false;
  if (quote.balance.method !== draft.balanceMethod) return false;
  if (quote.tenders.length !== draft.fixed.length) return false;
  const quoted = tenderKey(quote.tenders.map((tender) => ({ method: tender.method, amount: tender.amount.toString() })));
  return quoted === tenderKey(draft.fixed.map((tender) => ({ method: tender.method, amount: tender.amount })));
}

// Referencia e institución de un tender no-efectivo ya cobrable (el draft pasó
// `draftIssues`): la etiqueta de «Otra» viaja recortada y solo con esa
// institución, igual que en el DTO del servidor.
function nonCashReferenceFields(
  method: ProportionalMethod,
  reference: string | null,
  institution: TransferInstitution | null,
  institutionOther: string | null,
): Pick<CheckoutTenderBody, "reference" | "institution" | "institutionOther"> {
  if (method !== "TRANSFER") return { reference };
  const label = institution === "OTHER" ? (institutionOther ?? "").trim() : null;
  return { reference, institution, ...(label === null ? {} : { institutionOther: label }) };
}

export function buildCheckoutRequest(input: CheckoutRequestInput): CheckoutRequestBody {
  const { saleId, cashSessionId, operationKey, draft, quote } = input;
  if (!UUID.test(saleId)) throw draftFailure("INVALID_SALE_ID");
  if (!UUID.test(cashSessionId)) throw draftFailure("INVALID_SESSION_ID");
  if (!UUID_V4.test(operationKey)) throw draftFailure("INVALID_OPERATION_KEY");
  // El cobro solo puede nacer de la cotización de ESTA venta para ESTE draft:
  // así el total confirmado nunca es de otra composición de pago ni de otra venta.
  if (!quoteMatchesDraft(quote, draft, saleId)) {
    throw draftFailure("QUOTE_DOES_NOT_MATCH_DRAFT", "La cotización cambió: volvé a cotizar antes de confirmar.");
  }
  throwFirstIssue(draftIssues(draft, quote));

  const tenders: CheckoutTenderBody[] = draft.fixed.map((tender): CheckoutTenderBody => {
    if (tender.method === "CASH") {
      return { method: "CASH", role: "FIXED", amount: tender.amount, receivedAmount: tender.receivedAmount ?? null };
    }
    if (tender.externalCollectionId != null) {
      // El cobro registrado ya es dueño de la referencia y de la institución.
      return { method: tender.method, role: "FIXED", amount: tender.amount, externalCollectionId: tender.externalCollectionId };
    }
    return {
      method: tender.method,
      role: "FIXED",
      amount: tender.amount,
      ...nonCashReferenceFields(
        tender.method,
        tender.reference ?? null,
        tender.institution ?? null,
        tender.institutionOther ?? null,
      ),
    };
  });

  // El saldo no lleva importe: lo calcula el servidor. Fuera del efectivo lleva
  // su propia referencia (y su institución si es transferencia), porque el
  // servidor las exige en todo tender que no sea efectivo.
  tenders.push(draft.balanceMethod === "CASH"
    ? { method: "CASH", role: "BALANCE", receivedAmount: draft.receivedAmount ?? null }
    : {
        method: draft.balanceMethod,
        role: "BALANCE",
        ...nonCashReferenceFields(
          draft.balanceMethod,
          draft.balanceReference ?? null,
          draft.balanceInstitution ?? null,
          draft.balanceInstitutionOther ?? null,
        ),
      });

  return {
    operationKey,
    cashSessionId,
    balanceMethod: draft.balanceMethod,
    // Literales del servidor: acá no se suma nada.
    expectedTotal: quote.total.toString(),
    expectedBalanceAmount: quote.balance.amount.toString(),
    tenders,
  };
}

// ---------------------------------------------------------------------------
// Vuelto
// ---------------------------------------------------------------------------

// Previsualización antes de confirmar: una resta exacta en BigInt entre lo
// recibido y lo asignado al efectivo. El valor definitivo es el `changeAmount`
// del servidor; esto es solo lo que el cajero ve mientras tipea.
export function previewChange(draft: CheckoutDraft, quote: CheckoutQuote): ChangePreview | null {
  const cashFixed = draft.fixed.find((tender) => tender.method === "CASH") ?? null;
  const allocated = cashFixed ? centavosOf(cashFixed.amount) : draft.balanceMethod === "CASH" ? quote.balance.amount : null;
  if (allocated === null) return null;
  const raw = cashFixed ? (cashFixed.receivedAmount ?? null) : (draft.receivedAmount ?? null);
  const received = raw === null ? null : centavosOf(raw);
  if (received === null || received < allocated) return null;
  return { allocated, received, change: received - allocated };
}

// ---------------------------------------------------------------------------
// Intento de cobro
// ---------------------------------------------------------------------------

export function beginCheckout(input: BeginCheckoutInput): CheckoutAttempt {
  // La comprobación vive acá y no en quien llama: sin un intento vigente resuelto
  // no se crea otro (ni uno pendiente, ni uno incierto, ni uno ya confirmado).
  const decision = canBeginCheckout(input.current, input.saleId);
  if (!decision.allowed) {
    const refusal = BEGIN_REFUSALS[decision.reason];
    throw draftFailure(refusal.code, refusal.message);
  }
  const body = buildCheckoutRequest(input);
  return {
    state: "PENDING",
    saleId: input.saleId,
    operationKey: input.operationKey,
    body,
    quotedTotal: input.quote.total,
    quotedBalance: input.quote.balance.amount,
  };
}

export function attemptConfirmed(attempt: CheckoutAttempt, result: CheckoutResult): CheckoutAttempt {
  if (result.saleId !== attempt.saleId) {
    throw draftFailure("RESULT_SALE_MISMATCH", "El resultado del cobro no corresponde a esta venta.");
  }
  return { ...attempt, state: "CONFIRMED", result };
}

// Un error NUNCA libera un intento, ni siquiera uno PENDIENTE.
//
// Un PENDING puede representar un envío que YA cometió y cuya respuesta se
// perdió: el POS reintenta con la misma clave, y tanto su primer envío como el
// reintento pueden terminar en cualquier error. Ningún status ni código prueba
// lo contrario: `assertCanCharge` (403 FORBIDDEN) y el middleware corren ANTES
// de resolver la operationKey, y CUALQUIER respuesta puede pertenecer a un envío
// anterior de esa clave. Por eso no hay clasificación de códigos "seguros".
//
// El intento se conserva incierto, con TODOS sus datos (saleId, operationKey,
// quotedTotal, quotedBalance) y el MISMO `body` por referencia, sin
// reconstruirlo: el replay reenvía exactamente lo mismo.
//
// La única salida es la respuesta exitosa del checkout de ESA clave
// (`attemptConfirmed`), que verifica la identidad de la venta y lo vuelve
// CONFIRMED. No existe ninguna otra transición: ni a null, ni a PENDING, ni a un
// intento nuevo (ver `beginCheckout`/`canBeginCheckout`). Una consulta
// autoritativa dedicada todavía no existe y no se inventa acá.
export function attemptAfterFailure(attempt: CheckoutAttempt, failure: CheckoutFailure): CheckoutAttempt {
  // Un intento ya confirmado no se degrada: fue resuelto de forma autoritativa.
  if (attempt.state === "CONFIRMED") return attempt;
  return { ...attempt, state: "UNCERTAIN", message: failure.message };
}

export function retryCheckout(attempt: CheckoutAttempt): { operationKey: string; body: CheckoutRequestBody } {
  if (attempt.state === "CONFIRMED") {
    throw draftFailure("ATTEMPT_ALREADY_CONFIRMED", "Este cobro ya se confirmó: no se reintenta.");
  }
  // Misma clave, mismo cuerpo: si el primer envío sí se había cobrado, el
  // servidor responde el mismo resultado (replayed).
  return { operationKey: attempt.operationKey, body: attempt.body };
}

export function canBeginCheckout(current: CheckoutAttempt | null, saleId: string): BeginDecision {
  if (current === null || current.saleId !== saleId) return { allowed: true };
  if (current.state === "PENDING") return { allowed: false, reason: "IN_FLIGHT" };
  if (current.state === "UNCERTAIN") return { allowed: false, reason: "UNCERTAIN" };
  return { allowed: false, reason: "ALREADY_CONFIRMED" };
}

// ---------------------------------------------------------------------------
// Production V1 — reserva durable + confirmación
// ---------------------------------------------------------------------------

export type ReservationTenderBody = {
  method: ProportionalMethod;
  role: "FIXED" | "BALANCE";
  source: "NEW" | "COLLECTION";
  amount?: string;
  externalCollectionId?: string;
};

export type CheckoutReservationBody = {
  reserveKey: string;
  cashSessionId: string;
  balanceMethod: ProportionalMethod;
  expectedTotal: string;
  expectedBalanceAmount: string;
  tenders: ReservationTenderBody[];
};

export type BuildReservationInput = {
  saleId: string;
  reserveKey: string;
  cashSessionId: string;
  draft: CheckoutDraft;
  quote: CheckoutQuote;
};

export type ReservedTender = {
  method: ProportionalMethod;
  role: "FIXED" | "BALANCE";
  source: "NEW" | "COLLECTION";
  amount: bigint | null;
  externalCollectionId: string | null;
};

export type ConfirmationTenderBody = {
  method: ProportionalMethod;
  receivedAmount?: string;
  reference?: string;
  institution?: TransferInstitution;
  institutionOther?: string;
};

export type CheckoutConfirmationBody = {
  reserveKey: string;
  operationKey: string;
  tenders: ConfirmationTenderBody[];
};

export type BuildConfirmationInput = {
  reserveKey: string;
  operationKey: string;
  draft: CheckoutDraft;
  reservedTenders: readonly ReservedTender[];
};

export function buildReservationRequest(
  input: BuildReservationInput,
): CheckoutReservationBody {
  const { saleId, reserveKey, cashSessionId, draft, quote } = input;

  if (!UUID.test(saleId)) throw draftFailure("INVALID_SALE_ID");
  if (!UUID.test(reserveKey)) throw draftFailure("INVALID_OPERATION_KEY");
  if (!UUID.test(cashSessionId)) throw draftFailure("INVALID_SESSION_ID");

  if (!quoteMatchesDraft(quote, draft, saleId)) {
    throw draftFailure(
      "QUOTE_DOES_NOT_MATCH_DRAFT",
      "La cotización cambió: volvé a cotizar antes de confirmar.",
    );
  }

  throwFirstIssue(draftIssues(draft, quote));

  const tenders: ReservationTenderBody[] = draft.fixed.map((tender) => {
    if (tender.externalCollectionId != null) {
      return {
        method: tender.method,
        role: "FIXED",
        source: "COLLECTION",
        amount: tender.amount,
        externalCollectionId: tender.externalCollectionId,
      };
    }

    return {
      method: tender.method,
      role: "FIXED",
      source: "NEW",
      amount: tender.amount,
    };
  });

  tenders.push({
    method: draft.balanceMethod,
    role: "BALANCE",
    source: "NEW",
  });

  return {
    reserveKey,
    cashSessionId,
    balanceMethod: draft.balanceMethod,
    expectedTotal: quote.total.toString(),
    expectedBalanceAmount: quote.balance.amount.toString(),
    tenders,
  };
}

function confirmationEvidenceFor(
  method: ProportionalMethod,
  draftTender: FixedTenderDraft | null,
  draft: CheckoutDraft,
): ConfirmationTenderBody {
  if (method === "CASH") {
    const received =
      draftTender?.receivedAmount ?? draft.receivedAmount ?? null;

    return received == null
      ? { method: "CASH" }
      : { method: "CASH", receivedAmount: received };
  }

  const reference =
    draftTender?.reference ?? draft.balanceReference ?? null;

  if (method !== "TRANSFER") {
    return reference == null
      ? { method }
      : { method, reference };
  }

  const institution =
    draftTender?.institution ?? draft.balanceInstitution ?? null;
  const institutionOther =
    draftTender?.institutionOther ?? draft.balanceInstitutionOther ?? null;

  return {
    method,
    ...(reference == null ? {} : { reference }),
    ...(institution == null ? {} : { institution }),
    ...(institution === "OTHER" && institutionOther != null
      ? { institutionOther: institutionOther.trim() }
      : {}),
  };
}

export function buildConfirmationRequest(
  input: BuildConfirmationInput,
): CheckoutConfirmationBody {
  const { reserveKey, operationKey, draft, reservedTenders } = input;

  if (!UUID.test(reserveKey)) throw draftFailure("INVALID_OPERATION_KEY");
  if (!UUID_V4.test(operationKey)) {
    throw draftFailure("INVALID_OPERATION_KEY");
  }

  throwFirstIssue(draftIssues(draft));

  const tenders = reservedTenders.map((reserved) => {
    if (reserved.source === "COLLECTION") {
      return { method: reserved.method };
    }

    const draftTender =
      reserved.role === "FIXED"
        ? draft.fixed.find((tender) => tender.method === reserved.method) ?? null
        : null;

    return confirmationEvidenceFor(
      reserved.method,
      draftTender,
      draft,
    );
  });

  return {
    reserveKey,
    operationKey,
    tenders,
  };
}


export type CheckoutReservationView = {
  reserveKey: string;
  operationKey: string;
  status: "RESERVED";
  plan: {
    cashSessionId: string;
    balanceMethod: ProportionalMethod;
    expectedTotal: bigint;
    expectedBalanceAmount: bigint;
    tenders: ReservedTender[];
  };
};

export function parseCheckoutReservation(
  value: unknown,
): CheckoutReservationView {
  if (typeof value !== "object" || value === null) {
    throw draftFailure(
      "INVALID_RESERVATION_RESPONSE",
      "La reserva de cobro recibida del servidor no es válida.",
    );
  }

  const row = value as Record<string, unknown>;
  const plan = row.plan;

  if (
    typeof row.reserveKey !== "string" ||
    !UUID.test(row.reserveKey) ||
    typeof row.operationKey !== "string" ||
    !UUID_V4.test(row.operationKey) ||
    row.status !== "RESERVED" ||
    typeof plan !== "object" ||
    plan === null
  ) {
    throw draftFailure(
      "INVALID_RESERVATION_RESPONSE",
      "La reserva de cobro recibida del servidor no es válida.",
    );
  }

  const p = plan as Record<string, unknown>;

  if (
    typeof p.cashSessionId !== "string" ||
    !UUID.test(p.cashSessionId) ||
    !PROPORTIONAL_METHODS.includes(p.balanceMethod as ProportionalMethod) ||
    typeof p.expectedTotal !== "string" ||
    typeof p.expectedBalanceAmount !== "string" ||
    !Array.isArray(p.tenders)
  ) {
    throw draftFailure(
      "INVALID_RESERVATION_RESPONSE",
      "La reserva de cobro recibida del servidor no es válida.",
    );
  }

  const tenders: ReservedTender[] = p.tenders.map((raw) => {
    if (typeof raw !== "object" || raw === null) {
      throw draftFailure(
        "INVALID_RESERVATION_RESPONSE",
        "La reserva contiene un medio de pago inválido.",
      );
    }

    const tender = raw as Record<string, unknown>;

    if (
      !PROPORTIONAL_METHODS.includes(tender.method as ProportionalMethod) ||
      (tender.role !== "FIXED" && tender.role !== "BALANCE") ||
      (tender.source !== "NEW" && tender.source !== "COLLECTION")
    ) {
      throw draftFailure(
        "INVALID_RESERVATION_RESPONSE",
        "La reserva contiene un medio de pago inválido.",
      );
    }

    const amount =
      tender.amount === null || tender.amount === undefined
        ? null
        : typeof tender.amount === "string" && CENTAVOS.test(tender.amount)
          ? BigInt(tender.amount)
          : null;

    if (tender.amount !== null && tender.amount !== undefined && amount === null) {
      throw draftFailure(
        "INVALID_RESERVATION_RESPONSE",
        "La reserva contiene un importe inválido.",
      );
    }

    const externalCollectionId =
      tender.externalCollectionId === null ||
      tender.externalCollectionId === undefined
        ? null
        : typeof tender.externalCollectionId === "string" &&
            UUID.test(tender.externalCollectionId)
          ? tender.externalCollectionId
          : null;

    if (
      tender.externalCollectionId !== null &&
      tender.externalCollectionId !== undefined &&
      externalCollectionId === null
    ) {
      throw draftFailure(
        "INVALID_RESERVATION_RESPONSE",
        "La reserva contiene un cobro registrado inválido.",
      );
    }

    return {
      method: tender.method as ProportionalMethod,
      role: tender.role as "FIXED" | "BALANCE",
      source: tender.source as "NEW" | "COLLECTION",
      amount,
      externalCollectionId,
    };
  });

  let expectedTotal: bigint;
  let expectedBalanceAmount: bigint;

  try {
    expectedTotal = BigInt(p.expectedTotal);
    expectedBalanceAmount = BigInt(p.expectedBalanceAmount);
  } catch {
    throw draftFailure(
      "INVALID_RESERVATION_RESPONSE",
      "La reserva contiene importes inválidos.",
    );
  }

  return {
    reserveKey: row.reserveKey,
    operationKey: row.operationKey,
    status: "RESERVED",
    plan: {
      cashSessionId: p.cashSessionId,
      balanceMethod: p.balanceMethod as ProportionalMethod,
      expectedTotal,
      expectedBalanceAmount,
      tenders,
    },
  };
}


// ---------------------------------------------------------------------------
// Production V1 — estado durable del intento en el cliente
// ---------------------------------------------------------------------------

// El contexto operativo en el que nació el intento. La confirmación no lleva
// sesión ni sucursal en su cuerpo, así que se registra acá para poder comparar.
export type AttemptContext = {
  branchId: string;
  cashSessionId: string;
};

export type ProductionCheckoutAttempt =
  | {
      phase: "RESERVATION";
      state: "PENDING" | "UNCERTAIN";
      context: AttemptContext;
      saleId: string;
      reserveKey: string;
      body: CheckoutReservationBody;
      draft: CheckoutDraft;
      quote: CheckoutQuote;
      message?: string;
    }
  | {
      phase: "CONFIRMATION";
      state: "PENDING" | "UNCERTAIN";
      context: AttemptContext;
      saleId: string;
      reserveKey: string;
      operationKey: string;
      body: CheckoutConfirmationBody;
      quotedTotal: bigint;
      quotedBalance: bigint;
      message?: string;
    }
  | {
      phase: "CONFIRMATION";
      state: "CONFIRMED";
      context: AttemptContext;
      saleId: string;
      reserveKey: string;
      operationKey: string;
      body: CheckoutConfirmationBody;
      quotedTotal: bigint;
      quotedBalance: bigint;
      result: CheckoutResult;
    };
