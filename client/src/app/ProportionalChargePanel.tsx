"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckoutContractError,
  PROPORTIONAL_METHODS,
  TRANSFER_INSTITUTIONS,
  availableMethods,
  buildCheckoutRequest,
  buildConfirmationRequest,
  buildQuoteRequest,
  buildReservationRequest,
  methodAvailability,
  parseCheckoutQuote,
  parseCheckoutReservation,
  parseCheckoutResult,
  previewChange,
  type CheckoutDraft,
  type CheckoutQuote,
  type FixedTenderDraft,
  type PaymentMethod,
  type ProductionCheckoutAttempt,
  type ProportionalMethod,
  type QuoteCollection,
  type TransferInstitution,
} from "./checkout-quote";

// R3-A4.2b: panel de cobro proporcional.
//
// El servidor sigue siendo la única autoridad. Cada importe mostrado sale de
// POST /checkout/quote y el cobro se confirma con el `expectedTotal` que esa
// cotización devolvió: el panel no reparte el saldo, no recalcula el total y no
// decide el circuito (eso es `checkoutRequired`, persistido por el servidor y
// leído de la cola). Ninguna respuesta de error habilita un cobro nuevo: un
// intento incierto conserva su clave y su cuerpo hasta que se resuelva.

// El error de transporte del circuito proporcional: conserva el status, el
// código y los `details` de la respuesta, porque son lo único que permite
// distinguir una cotización vencida de un fallo de red. El resto del POS usa
// `apiRequest`, que los descarta a propósito (ver page.tsx).
export class CodedApiError extends Error {
  readonly status: number | null;
  readonly code: string | null;
  readonly details: unknown;

  constructor(message: string, status: number | null, code: string | null, details: unknown) {
    super(message);
    this.name = "CodedApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export type CodedRequest = (path: string, options: RequestInit) => Promise<unknown>;

// Las herramientas de dinero y de fecha de page.tsx se pasan como valor: el
// panel no reimplementa ni el parseo de centavos ni el formato.
export type MoneyTools = {
  parse: (input: string) => string | null;
  prefill: (centavos: string) => string;
  format: (centavos: string) => string;
  formatInstant: (value: string) => string;
};

export type ProportionalSaleItem = {
  id: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: string;
};

export type ProportionalSale = {
  saleId: string;
  items: ProportionalSaleItem[];
};

export type ProportionalChargePanelProps = {
  // El transporte con código del circuito, ya ligado al token de la sesión.
  request: CodedRequest;
  money: MoneyTools;
  sale: ProportionalSale;
  cashSession: { sessionId: string } | null;
  // La sucursal elegida: junto con la sesión de caja, el contexto de un intento.
  branchId: string;
  // false mientras se lee la caja de la sucursal: `cashSession === null` todavía
  // no quiere decir «cerrada».
  cashKnown: boolean;
  chargeBlocked: boolean;
  attempt: ProductionCheckoutAttempt | null;
  // El bloqueo síncrono del doble clic vive en el workspace, no en el panel.
  inFlight: { current: Set<string> };
  onAttempt: (attempt: ProductionCheckoutAttempt) => void;
  // Un rechazo definitivo y sin efectos del servidor (la reserva no escribió
  // nada) no deja un intento que reintentar: se descarta el de esa venta.
  onDiscardAttempt: (saleId: string) => void;
};

const ATTEMPT_OTHER_CONTEXT_NOTE =
  "Este cobro quedó incierto en otra caja o sucursal. No se puede reintentar desde esta: volvé a la caja y sucursal originales o consultá a un supervisor.";

const METHOD_LABELS: Record<ProportionalMethod, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  CARD_DEBIT: "Tarjeta de débito",
  CARD_CREDIT: "Tarjeta de crédito",
  QR: "QR",
};

const INSTITUTION_LABELS: Record<TransferInstitution, string> = {
  MACRO: "Macro",
  BBVA: "BBVA",
  NACION: "Nación",
  GALICIA: "Galicia",
  MERCADO_PAGO: "Mercado Pago",
  OTHER: "Otra",
};

// Un POST por tecla sería castigar al servidor: el panel cotiza con un retardo
// corto y descarta la respuesta que ya no corresponde a la composición vigente.
const QUOTE_DEBOUNCE_MS = 200;

// Identificadores de reemplazo para pedirle al contrato el motivo exacto de
// bloqueo. Se usan para armar un cuerpo que se descarta: jamás se envían.
const PLACEHOLDER_SESSION = "00000000-0000-4000-8000-000000000000";
const PLACEHOLDER_KEY = "00000000-0000-4000-8000-000000000001";

const NETWORK_FAILURE = "No se pudo confirmar el cobro: revisá la conexión y reintentá el mismo cobro.";
const INVALID_AMOUNT_NOTE = "Ingresá importes en centavos exactos.";

function methodLabel(method: string): string {
  return (METHOD_LABELS as Record<string, string>)[method] ?? method;
}

function institutionLabel(institution: TransferInstitution): string {
  return INSTITUTION_LABELS[institution];
}

function isProportional(method: PaymentMethod): method is ProportionalMethod {
  return method === "CASH" || method === "TRANSFER" || method === "CARD_DEBIT" || method === "CARD_CREDIT" || method === "QR";
}

function centavosOrRaw(money: MoneyTools, input: string): string {
  return money.parse(input) ?? input.trim();
}

type TenderState = {
  key: number;
  method: ProportionalMethod;
  amount: string;
  received: string;
  reference: string;
  institution: TransferInstitution | "";
  institutionOther: string;
  collectionId: string;
};

type DraftState = {
  balanceMethod: ProportionalMethod;
  balanceReceived: string;
  balanceReference: string;
  balanceInstitution: TransferInstitution | "";
  balanceInstitutionOther: string;
  fixed: TenderState[];
};

type ChargeMode = "SIMPLE" | "COMBINED";

// Etiquetas cortas del pago simple.
const SIMPLE_LABELS: Record<ProportionalMethod, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  CARD_DEBIT: "Débito",
  CARD_CREDIT: "Crédito",
  QR: "QR",
};

const INITIAL_DRAFT: DraftState = {
  balanceMethod: "CASH",
  balanceReceived: "",
  balanceReference: "",
  balanceInstitution: "",
  balanceInstitutionOther: "",
  fixed: [],
};

// El renglón de un importe fijo, ya en la forma del contrato. Un cobro externo
// registrado es dueño de la referencia y de la institución: nunca viajan juntas.
function tenderDraft(tender: TenderState, money: MoneyTools): FixedTenderDraft {
  const amount = centavosOrRaw(money, tender.amount);
  if (tender.method === "CASH") {
    return { method: "CASH", amount, receivedAmount: centavosOrRaw(money, tender.received) };
  }
  if (tender.collectionId !== "") {
    return { method: tender.method, amount, externalCollectionId: tender.collectionId };
  }
  return {
    method: tender.method,
    amount,
    // Un campo vacío es "sin referencia", no "referencia inválida": el motivo
    // que corresponde es el que exige una.
    reference: tender.reference === "" ? null : tender.reference,
    institution: tender.institution === "" ? null : tender.institution,
    // Un campo vacío es "sin nombre alternativo": solo «Otra» lo lleva, y el
    // contrato rechaza una cadena vacía junto a cualquier otra institución.
    institutionOther: tender.institutionOther === "" ? null : tender.institutionOther,
  };
}

function toDraft(state: DraftState, money: MoneyTools): CheckoutDraft {
  const draft: CheckoutDraft = {
    balanceMethod: state.balanceMethod,
    fixed: state.fixed.map((tender) => tenderDraft(tender, money)),
  };
  if (state.balanceMethod === "CASH") {
    draft.receivedAmount = centavosOrRaw(money, state.balanceReceived);
  } else {
    draft.balanceReference = state.balanceReference === "" ? null : state.balanceReference;
    // El saldo por débito no lleva institución; por transferencia sí.
    if (state.balanceMethod === "TRANSFER") {
      draft.balanceInstitution = state.balanceInstitution === "" ? null : state.balanceInstitution;
      draft.balanceInstitutionOther = state.balanceInstitutionOther === "" ? null : state.balanceInstitutionOther;
    }
  }
  return draft;
}

// El cuerpo de la cotización, o null si el draft todavía no se puede cotizar
// (un importe a medio tipear). Es la clave que dispara la cotización.
function quoteBody(draft: CheckoutDraft): string | null {
  try {
    return JSON.stringify(buildQuoteRequest(draft));
  } catch {
    return null;
  }
}

// Redacción operativa de la evidencia que falta en un cobro no-efectivo, con el
// número del pago. NO decide si el cobro se puede armar: eso es de nonCashIssues
// (paridad con el DTO del servidor), que bloquea todo lo que esto nombra.
function evidenceBlocker(draft: CheckoutDraft): string | null {
  for (let index = 0; index < draft.fixed.length; index += 1) {
    const tender = draft.fixed[index]!;
    const paymentNumber = index + 1;

    if (tender.externalCollectionId != null && tender.externalCollectionId !== "") {
      continue;
    }

    if (tender.method !== "CASH" && !tender.reference?.trim()) {
      if (tender.method === "TRANSFER") {
        return `Ingresá el N.º de operación de la transferencia del pago ${paymentNumber}.`;
      }

      return `Ingresá el N.º de operación del pago ${paymentNumber}.`;
    }

    if (tender.method === "TRANSFER" && !tender.institution) {
      return `Elegí la institución de la transferencia del pago ${paymentNumber}.`;
    }

    if (
      tender.method === "TRANSFER" &&
      tender.institution === "OTHER" &&
      !tender.institutionOther?.trim()
    ) {
      return `Ingresá el nombre de la institución de la transferencia del pago ${paymentNumber}.`;
    }
  }

  if (draft.balanceMethod !== "CASH" && !draft.balanceReference?.trim()) {
    if (draft.balanceMethod === "TRANSFER") {
      return "Ingresá el N.º de operación de la transferencia del pago restante.";
    }

    return "Ingresá el N.º de operación del pago restante.";
  }

  if (draft.balanceMethod === "TRANSFER" && !draft.balanceInstitution) {
    return "Elegí la institución de la transferencia del pago restante.";
  }

  if (
    draft.balanceMethod === "TRANSFER" &&
    draft.balanceInstitution === "OTHER" &&
    !draft.balanceInstitutionOther?.trim()
  ) {
    return "Ingresá el nombre de la institución de la transferencia del pago restante.";
  }

  return null;
}

// El motivo exacto por el que el cobro todavía no se puede armar, con el texto
// que usaría el propio contrato: se llama al constructor puro con una sesión y
// una clave de reemplazo y se descarta el cuerpo. Así el panel no inventa ni
// duplica un solo mensaje del contrato.
function checkoutBlocker(draft: CheckoutDraft, quote: CheckoutQuote, saleId: string): string | null {
  try {
    buildCheckoutRequest({
      saleId,
      cashSessionId: PLACEHOLDER_SESSION,
      operationKey: PLACEHOLDER_KEY,
      draft,
      quote,
    });
    return null;
  } catch (cause) {
    return cause instanceof CheckoutContractError ? cause.message : "No se pudo preparar el cobro.";
  }
}

function detailCentavos(details: unknown, key: string): string | null {
  if (typeof details !== "object" || details === null) return null;
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" && /^[0-9]+$/.test(value) ? value : null;
}

type FailureView = {
  status?: number;
  code: string | null;
  message: string;
  total: string | null;
  balance: string | null;
};

// Un fallo de transporte o de la confirmación nunca libera un intento: sólo se
// usa `message` para mostrar y, cuando el servidor informa el importe vigente,
// para poder mostrarlo. La única excepción es CHECKOUT_QUOTE_CHANGED en la
// reserva, un rechazo definitivo sin escrituras (ver sendReservation). El status
// y el código viajan tal como llegaron.
function failureView(cause: unknown): FailureView {
  if (cause instanceof CodedApiError) {
    return {
      status: cause.status ?? undefined,
      code: cause.code,
      message: cause.message,
      total: detailCentavos(cause.details, "total"),
      balance: detailCentavos(cause.details, "balance"),
    };
  }
  if (cause instanceof CheckoutContractError) {
    return { code: cause.code, message: cause.message, total: null, balance: null };
  }
  return { code: null, message: NETWORK_FAILURE, total: null, balance: null };
}

function noteOf(cause: unknown, fallback: string): string {
  if (cause instanceof CodedApiError || cause instanceof CheckoutContractError) return cause.message;
  return fallback;
}

export default function ProportionalChargePanel({
  request,
  money,
  sale,
  cashSession,
  branchId,
  cashKnown,
  chargeBlocked,
  attempt,
  inFlight,
  onAttempt,
  onDiscardAttempt,
}: ProportionalChargePanelProps) {
  const [draftState, setDraftState] = useState<DraftState>(INITIAL_DRAFT);
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  // Los cobros externos que el servidor informó como pendientes en la última
  // cotización válida de esta venta. Se usan sólo para ofrecer la elección: la
  // aceptación real la valida el contrato contra la cotización vigente.
  const [knownCollections, setKnownCollections] = useState<QuoteCollection[]>([]);
  const [quoteNote, setQuoteNote] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  // Fuerza una cotización nueva con el mismo draft (la clave del efecto no cambia).
  const [quoteEpoch, setQuoteEpoch] = useState(0);
  const [quoteChangedNotice, setQuoteChangedNotice] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [serverTotal, setServerTotal] = useState<string | null>(null);
  const [serverBalance, setServerBalance] = useState<string | null>(null);
  // "Pago simple" / "Pago combinado" es solo un modo de la interfaz sobre el mismo
  // motor: nunca viaja como medio de pago. Simple = un único medio de saldo y
  // ningún importe fijo; Combinado = el constructor de varios medios.
  const [mode, setMode] = useState<ChargeMode>("SIMPLE");
  const [simpleMethod, setSimpleMethod] = useState<ProportionalMethod | null>(null);
  const nextTenderKey = useRef(1);
  const quoteRequest = useRef(0);

  const draft = toDraft(draftState, money);
  const body = quoteBody(draft);
  const confirmed = attempt?.state === "CONFIRMED";
  // Un intento sólo se reintenta en el contexto en que nació: misma sucursal y
  // misma sesión de caja, comparadas por id (no por identidad de objeto, así un
  // refresco de la misma sesión no lo invalida).
  const attemptInContext =
    attempt === null ||
    (cashSession !== null &&
      attempt.context.branchId === branchId &&
      attempt.context.cashSessionId === cashSession.sessionId);
  // La cotización no depende de la sesión, sólo de que haya una caja abierta:
  // un refresco que devuelve la misma sesión como objeto nuevo no la reinicia.
  const cashOpen = cashSession !== null;

  // UX Production V1: si el pago restante es en efectivo, mostramos cuánto
  // falta realmente. Todo se calcula en centavos enteros; nunca Number/float.
  const cashShortage =
    quote !== null && draftState.balanceMethod === "CASH"
      ? (() => {
          const received = money.parse(draftState.balanceReceived);
          if (received === null) return null;

          const receivedCents = BigInt(received);
          return receivedCents < quote.balance.amount
            ? quote.balance.amount - receivedCents
            : null;
        })()
      : null;

  // La cotización vigente es la del servidor para ESTA composición. Una
  // respuesta que ya no corresponde al draft actual se descarta.
  //
  // El reinicio de la cotización es parte del ciclo de datos del panel, no un
  // setState de evento: cuando el draft deja de ser cotizable (o el cobro ya se
  // confirmó) hay que soltar la cotización vieja antes de esperar el retardo, y
  // cuando la composición cambia hay que marcar la lectura en curso.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!cashOpen || confirmed || body === null) {
      quoteRequest.current += 1;
      setQuote(null);
      setQuoteNote("");
      setQuoteLoading(false);
      return;
    }
    const current = ++quoteRequest.current;
    setQuoteLoading(true);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const payload = await request(`/sales/${sale.saleId}/checkout/quote`, { method: "POST", body });
          if (current !== quoteRequest.current) return;
          const parsed = parseCheckoutQuote(payload);
          setQuote(parsed);
          setKnownCollections(parsed.unappliedCollections);
          setQuoteNote("");
        } catch (cause) {
          if (current !== quoteRequest.current) return;
          setQuote(null);
          setQuoteNote(noteOf(cause, "No se pudo cotizar la venta: revisá la conexión."));
        } finally {
          if (current === quoteRequest.current) setQuoteLoading(false);
        }
      })();
    }, QUOTE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [body, sale.saleId, request, confirmed, cashOpen, quoteEpoch]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const availability = quote === null ? null : methodAvailability(quote);
  const methods = quote === null ? [...PROPORTIONAL_METHODS] : availableMethods(quote);
  const change = quote === null ? null : previewChange(draft, quote);
  // Una sola regla: el contrato decide SI el cobro está bloqueado; la evidencia
  // sólo elige el texto operativo (con el número de pago) cuando ese bloqueo es
  // por una referencia o institución que falta.
  const contractBlocker = quoteLoading || quote === null ? null : checkoutBlocker(draft, quote, sale.saleId);
  const blocker = contractBlocker === null ? null : evidenceBlocker(draft) ?? contractBlocker;
  const locked = inFlight.current.has(sale.saleId);

  function changeBalanceMethod(method: ProportionalMethod) {
    // Cambiar de medio de saldo descarta su carga probatoria anterior: ni una
    // referencia de un débito sobrevive a un saldo en efectivo ni al revés.
    setDraftState((state) => ({
      ...state,
      balanceMethod: method,
      balanceReceived: "",
      balanceReference: "",
      balanceInstitution: "",
      balanceInstitutionOther: "",
    }));
  }

  // Cambiar de modo descarta todo lo cargado: no queda un medio, una referencia ni
  // un importe fijo del modo anterior, y no se cobra nada (solo se vuelve a cotizar).
  function switchMode(next: ChargeMode) {
    if (next === mode || submitting) return;
    setMode(next);
    setSimpleMethod(null);
    setDraftState(INITIAL_DRAFT);
    setPanelError("");
  }

  function chooseSimpleMethod(method: ProportionalMethod) {
    setSimpleMethod(method);
    changeBalanceMethod(method);
  }

  function addFixedTender() {
    const key = nextTenderKey.current;
    nextTenderKey.current += 1;
    setDraftState((state) => ({
      ...state,
      fixed: [
        ...state.fixed,
        {
          key,
          method: methods.find((method) => method !== state.balanceMethod) ?? "CASH",
          amount: "",
          received: "",
          reference: "",
          institution: "",
          institutionOther: "",
          collectionId: "",
        },
      ],
    }));
  }

  function updateTender(key: number, patch: Partial<TenderState>) {
    setDraftState((state) => ({
      ...state,
      fixed: state.fixed.map((tender) => (tender.key === key ? { ...tender, ...patch } : tender)),
    }));
  }

  function collectionsFor(method: ProportionalMethod): QuoteCollection[] {
    if (method === "CASH") return [];
    return knownCollections.filter(
      (collection) => collection.method === method && isProportional(collection.method),
    );
  }

  function selectCollection(tender: TenderState, collectionId: string) {
    const collection = collectionsFor(tender.method).find((entry) => entry.id === collectionId) ?? null;
    if (collection === null || !isProportional(collection.method)) {
      updateTender(tender.key, { collectionId: "" });
      return;
    }
    // El importe del cobro registrado es el suyo: se precarga, no se inventa.
    updateTender(tender.key, {
      collectionId: collection.id,
      method: collection.method,
      amount: money.prefill(collection.amount.toString()),
      received: "",
      reference: "",
      institution: "",
      institutionOther: "",
    });
  }

  // Production V1: cada fase conserva SU cuerpo exacto.
  // Una respuesta perdida nunca genera reserveKey u operationKey nuevas.
  async function sendConfirmation(
    started: Extract<ProductionCheckoutAttempt, { phase: "CONFIRMATION"; state: "PENDING" | "UNCERTAIN" }>,
  ) {
    try {
      const response = await request(`/sales/${sale.saleId}/checkout`, {
        method: "POST",
        body: JSON.stringify(started.body),
      });

      const result = parseCheckoutResult(response);

      if (result.saleId !== started.saleId) {
        throw new CheckoutContractError(
          "RESULT_SALE_MISMATCH",
          "El resultado del cobro no corresponde a esta venta.",
        );
      }

      onAttempt({
        ...started,
        state: "CONFIRMED",
        result,
      });

      setPanelError("");
      setServerTotal(null);
      setServerBalance(null);
    } catch (cause) {
      const failure = failureView(cause);

      onAttempt({
        ...started,
        state: "UNCERTAIN",
        message: failure.message,
      });

      if (failure.code === "CHECKOUT_QUOTE_CHANGED") {
        setServerTotal(failure.total);
        setServerBalance(failure.balance);
      }
    } finally {
      inFlight.current.delete(sale.saleId);
      setSubmitting(false);
    }
  }

  async function sendReservation(
    started: Extract<ProductionCheckoutAttempt, { phase: "RESERVATION" }>,
  ) {
    try {
      const payload = await request(
        `/sales/${sale.saleId}/checkout/reservations`,
        {
          method: "POST",
          body: JSON.stringify(started.body),
        },
      );

      const reservation = parseCheckoutReservation(payload);

      if (reservation.reserveKey !== started.reserveKey) {
        throw new CheckoutContractError(
          "INVALID_RESERVATION_RESPONSE",
          "La reserva recibida no corresponde al intento enviado.",
        );
      }

      if (
        reservation.plan.cashSessionId !== started.body.cashSessionId ||
        reservation.plan.balanceMethod !== started.body.balanceMethod ||
        reservation.plan.expectedTotal.toString() !== started.body.expectedTotal ||
        reservation.plan.expectedBalanceAmount.toString() !==
          started.body.expectedBalanceAmount
      ) {
        throw new CheckoutContractError(
          "INVALID_RESERVATION_RESPONSE",
          "La reserva recibida no coincide con la cotización confirmada.",
        );
      }

      const confirmationBody = buildConfirmationRequest({
        reserveKey: reservation.reserveKey,
        operationKey: reservation.operationKey,
        draft: started.draft,
        reservedTenders: reservation.plan.tenders,
      });

      const confirming: ProductionCheckoutAttempt = {
        phase: "CONFIRMATION",
        state: "PENDING",
        saleId: started.saleId,
        reserveKey: reservation.reserveKey,
        operationKey: reservation.operationKey,
        body: confirmationBody,
        quotedTotal: started.quote.total,
        quotedBalance: started.quote.balance.amount,
        context: started.context,
      };

      onAttempt(confirming);

      await sendConfirmation(confirming);
    } catch (cause) {
      const failure = failureView(cause);

      if (failure.code === "CHECKOUT_QUOTE_CHANGED") {
        // El servidor cotiza dentro de la reserva y antes de escribir: este
        // rechazo es definitivo y no dejó nada bajo esta reserveKey. La
        // cotización vieja ya no sirve: se suelta, se recotiza con el draft
        // actual y el cobro nuevo sólo sale de un Cobrar explícito.
        onDiscardAttempt(started.saleId);
        setQuote(null);
        setQuoteEpoch((epoch) => epoch + 1);
        setQuoteChangedNotice(
          failure.total === null
            ? failure.message
            : `La cotización cambió: el total vigente es ${money.format(failure.total)}. Revisá el cobro y tocá Cobrar de nuevo.`,
        );
      } else {
        onAttempt({
          ...started,
          state: "UNCERTAIN",
          message: failure.message,
        });
      }

      inFlight.current.delete(sale.saleId);
      setSubmitting(false);
    }
  }

  async function confirm() {
    if (
      quote === null ||
      blocker !== null ||
      cashSession === null ||
      chargeBlocked ||
      submitting
    ) {
      return;
    }

    if (inFlight.current.has(sale.saleId)) return;

    inFlight.current.add(sale.saleId);
    setSubmitting(true);
    setPanelError("");
    setQuoteChangedNotice("");

    try {
      // Si una reserva anterior quedó incierta, se reenvía EXACTAMENTE
      // la misma reserveKey y el mismo cuerpo.
      if (
        attempt !== null &&
        attempt.phase === "RESERVATION" &&
        attempt.state === "UNCERTAIN"
      ) {
        if (!attemptInContext) throw new CheckoutContractError("ATTEMPT_IN_FLIGHT", ATTEMPT_OTHER_CONTEXT_NOTE);
        await sendReservation(attempt);
        return;
      }

      if (attempt !== null) {
        throw new CheckoutContractError(
          "ATTEMPT_IN_FLIGHT",
          "Ya existe un intento de cobro para esta venta.",
        );
      }

      const reserveKey = crypto.randomUUID();

      const reservationBody = buildReservationRequest({
        saleId: sale.saleId,
        reserveKey,
        cashSessionId: cashSession.sessionId,
        draft,
        quote,
      });

      const reserving: ProductionCheckoutAttempt = {
        phase: "RESERVATION",
        state: "PENDING",
        context: { branchId, cashSessionId: cashSession.sessionId },
        saleId: sale.saleId,
        reserveKey,
        body: reservationBody,
        draft,
        quote,
      };

      // Se registra ANTES de tocar la red.
      onAttempt(reserving);

      await sendReservation(reserving);
    } catch (cause) {
      inFlight.current.delete(sale.saleId);
      setSubmitting(false);
      setPanelError(noteOf(cause, "No se pudo preparar el cobro."));
    }
  }

  async function retry() {
    if (attempt === null || attempt.state === "CONFIRMED" || submitting) return;
    // Nunca se reenvía un intento a nombre de otra caja o sucursal.
    if (!attemptInContext) return;
    if (inFlight.current.has(sale.saleId)) return;

    inFlight.current.add(sale.saleId);
    setSubmitting(true);
    setPanelError("");

    if (attempt.phase === "RESERVATION") {
      await sendReservation(attempt);
      return;
    }

    await sendConfirmation(attempt);
  }

  // El resumen técnico (total, saldo, medios) es del combinado, o de un intento que ya
  // se envió; el pago simple muestra solo el total del medio elegido.
  const showCombined = mode === "COMBINED" || attempt !== null;
  const simpleReady = mode === "COMBINED" || simpleMethod !== null;

  const canConfirm =
    quote !== null &&
    !quoteLoading &&
    blocker === null &&
    cashSession !== null &&
    !chargeBlocked &&
    cashShortage === null &&
    !submitting &&
    !locked &&
    simpleReady;

  if (!cashKnown && cashSession === null && attempt === null) {
    return (
      <section className="proportional-panel" data-testid="proportional-panel">
        <div className="payment-summary" data-testid="cash-session-loading">
          <div className="total-line">
            <span>Caja</span>
            <strong>Verificando el estado de la caja...</strong>
          </div>
        </div>
      </section>
    );
  }

  if (cashSession === null && attempt === null) {
    return (
      <section className="proportional-panel" data-testid="proportional-panel">
        <div className="payment-summary" data-testid="cash-session-closed">
          <div className="total-line">
            <span>Caja cerrada</span>
            <strong>Abrí una caja para poder cobrar.</strong>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="proportional-panel" data-testid="proportional-panel">
      {attempt === null ? (
        <div className="charge-mode" role="group" aria-label="Tipo de cobro">
          <button
            className={mode === "SIMPLE" ? "secondary-button active" : "secondary-button"}
            aria-pressed={mode === "SIMPLE"}
            onClick={() => switchMode("SIMPLE")}
            disabled={submitting}
          >
            Pago simple
          </button>
          <button
            className={mode === "COMBINED" ? "secondary-button active" : "secondary-button"}
            aria-pressed={mode === "COMBINED"}
            onClick={() => switchMode("COMBINED")}
            disabled={submitting}
          >
            Pago combinado
          </button>
        </div>
      ) : null}

      {cashSession === null ? (
        <p className="cart-note" data-testid="proportional-session-note">
          Abrí caja antes de cobrar: el cobro exige una sesión de caja abierta.
        </p>
      ) : null}

      {quoteChangedNotice !== "" ? (
        <p className="cart-note" data-testid="proportional-quote-changed">{quoteChangedNotice}</p>
      ) : null}

      {chargeBlocked ? (
        <p className="cart-note" data-testid="proportional-payment-blocked">
          El servidor no admite cobros nuevos para esta venta en este momento.
        </p>
      ) : null}

      {quote === null && !confirmed ? (
        <>
          {quoteLoading ? (
            <p className="muted" data-testid="proportional-quote-loading">Cotizando...</p>
          ) : null}
          {!quoteLoading && quoteNote !== "" ? (
            <p className="cart-note" data-testid="proportional-quote-note">{quoteNote}</p>
          ) : null}
          {!quoteLoading && quoteNote === "" && body === null ? (
            <p className="cart-note" data-testid="proportional-quote-note">{INVALID_AMOUNT_NOTE}</p>
          ) : null}
        </>
      ) : null}

      {quote !== null && !confirmed ? (
        <>
          {showCombined ? (
            <div className="payment-summary">
              <div>
                <span>Total</span>
                <strong data-testid="proportional-total">{money.format(quote.total.toString())}</strong>
              </div>
              <div>
                <span>Falta pagar</span>
                <strong data-testid="proportional-balance">{money.format(quote.balance.amount.toString())}</strong>
              </div>
            </div>
          ) : null}

          <div className="readonly-items" data-testid="proportional-lines">
            {quote.lines.map((line) => {
              const item = sale.items.find((candidate) => candidate.id === line.saleItemId) ?? null;
              return (
                <div className="readonly-item" key={line.saleItemId}>
                  <span>
                    <strong>{item ? item.productName : line.sku}</strong>
                    <small>
                      {item ? `${item.variantName} | ` : ""}
                      {line.sku} | {line.quantity.toString()} u.
                    </small>
                  </span>
                  <strong>{money.format(line.finalAmount.toString())}</strong>
                </div>
              );
            })}
          </div>

          {showCombined ? (
            <div className="proportional-methods" data-testid="proportional-methods">
              {PROPORTIONAL_METHODS.map((method) => (
                <span
                  key={method}
                  className={availability !== null && availability[method].available ? "paid-pill" : "state-pill"}
                  data-method={method}
                >
                  {methodLabel(method)}
                  {availability !== null && !availability[method].available ? " (sin configuración)" : ""}
                </span>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {attempt !== null ? (
        attempt.state === "CONFIRMED" ? (
          <div className="payment-summary" data-testid="proportional-result">
            <div>
              <span>Total cobrado</span>
              <strong data-testid="proportional-result-total">{money.format(attempt.result.total.toString())}</strong>
            </div>
            <div>
              <span>Vuelto</span>
              <strong data-testid="proportional-result-change">{money.format(attempt.result.changeAmount.toString())}</strong>
            </div>
            <div className="total-line">
              <span>Estado</span>
              <strong>
                {attempt.result.replayed
                  ? "Reintento ya registrado: no se cobró dos veces."
                  : "Cobrado y registrado."}
              </strong>
            </div>
            <div className="readonly-items" data-testid="proportional-result-payments">
              {attempt.result.payments.map((payment) => (
                <div className="readonly-item" key={payment.id}>
                  <span>
                    <strong>{methodLabel(payment.method)}</strong>
                    <small>{payment.tenderRole === "BALANCE" ? "Saldo" : "Importe fijo"}</small>
                  </span>
                  <strong>{money.format(payment.amount.toString())}</strong>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="proportional-attempt">
            <p className="cart-note" role="alert">
              {attempt.state === "PENDING" ? "Enviando el cobro..." : attempt.message}
            </p>
            {serverTotal !== null ? (
              <p className="cart-note" data-testid="proportional-server-total">
                El servidor informa un total nuevo de {money.format(serverTotal)}
                {serverBalance === null ? "" : ` y un saldo de ${money.format(serverBalance)}`}.
              </p>
            ) : null}
            {attempt.state === "UNCERTAIN" && !attemptInContext ? (
              <p className="cart-note" data-testid="proportional-attempt-context">{ATTEMPT_OTHER_CONTEXT_NOTE}</p>
            ) : null}
            {attempt.state === "UNCERTAIN" ? (
              <button className="secondary-button retry-button" onClick={() => void retry()} disabled={submitting || locked || !attemptInContext}>
                {submitting ? "Reintentando..." : "Reintentar el mismo cobro"}
              </button>
            ) : null}
          </div>
        )
      ) : (
        <>
          {mode === "SIMPLE" ? (
            <div className="simple-charge" data-testid="simple-charge">
              <div className="simple-methods" role="group" aria-label="Medio de pago">
                {PROPORTIONAL_METHODS.map((method) => {
                  const price = quote === null ? null : quote.fullPrices[method];
                  const unavailable = availability !== null && !availability[method].available;
                  return (
                    <button
                      key={method}
                      className={simpleMethod === method ? "method-button active" : "method-button"}
                      aria-pressed={simpleMethod === method}
                      data-method={method}
                      onClick={() => chooseSimpleMethod(method)}
                      disabled={submitting || chargeBlocked || unavailable}
                    >
                      <span>{SIMPLE_LABELS[method]}</span>
                      {price !== null ? <strong>{money.format(price.toString())}</strong> : null}
                    </button>
                  );
                })}
              </div>

              {simpleMethod === null ? (
                <p className="cart-note">Elegí cómo cobrar.</p>
              ) : (
                <>
                  {quote !== null && quote.balance.method === simpleMethod ? (
                    <div className="payment-summary">
                      <div className="total-line">
                        <span>Total a cobrar</span>
                        <strong data-testid="simple-total">{money.format(quote.total.toString())}</strong>
                      </div>
                    </div>
                  ) : null}

                  {simpleMethod === "CASH" ? (
                    <label>
                      Recibido
                      <input
                        inputMode="decimal"
                        aria-label="Recibido"
                        value={draftState.balanceReceived}
                        onChange={(event) => setDraftState((state) => ({ ...state, balanceReceived: event.target.value }))}
                        disabled={submitting}
                      />
                    </label>
                  ) : (
                    <>
                      <label>
                        Referencia
                        <input
                          aria-label="Referencia"
                          value={draftState.balanceReference}
                          onChange={(event) => setDraftState((state) => ({ ...state, balanceReference: event.target.value }))}
                          disabled={submitting}
                        />
                      </label>
                      {simpleMethod === "TRANSFER" ? (
                        <>
                          <label>
                            Institución
                            <select
                              aria-label="Institución"
                              value={draftState.balanceInstitution}
                              onChange={(event) =>
                                setDraftState((state) => ({
                                  ...state,
                                  balanceInstitution: event.target.value as TransferInstitution | "",
                                }))
                              }
                              disabled={submitting}
                            >
                              <option value="">Elegí una institución</option>
                              {TRANSFER_INSTITUTIONS.map((institution) => (
                                <option key={institution} value={institution}>{institutionLabel(institution)}</option>
                              ))}
                            </select>
                          </label>
                          {draftState.balanceInstitution === "OTHER" ? (
                            <label>
                              Institución alternativa
                              <input
                                aria-label="Institución alternativa"
                                value={draftState.balanceInstitutionOther}
                                onChange={(event) =>
                                  setDraftState((state) => ({ ...state, balanceInstitutionOther: event.target.value }))
                                }
                                disabled={submitting}
                              />
                            </label>
                          ) : null}
                        </>
                      ) : null}
                    </>
                  )}
                </>
              )}
            </div>
          ) : (
            <>
          <label>
            Medio del pago restante
            <select
              aria-label="Medio de saldo"
              value={draftState.balanceMethod}
              onChange={(event) => changeBalanceMethod(event.target.value as ProportionalMethod)}
              disabled={submitting}
            >
              {PROPORTIONAL_METHODS.map((method) => (
                <option
                  key={method}
                  value={method}
                  disabled={availability !== null && !availability[method].available}
                >
                  {methodLabel(method)}
                </option>
              ))}
            </select>
          </label>

          {draftState.balanceMethod === "CASH" ? (
            <label>
              Recibido
              <input
                inputMode="decimal"
                aria-label="Recibido del saldo"
                value={draftState.balanceReceived}
                onChange={(event) => setDraftState((state) => ({ ...state, balanceReceived: event.target.value }))}
                disabled={submitting}
              />
            </label>
          ) : (
            <>
              <label>
                N.º de operación
                <input
                  aria-label="Referencia del saldo"
                  value={draftState.balanceReference}
                  onChange={(event) => setDraftState((state) => ({ ...state, balanceReference: event.target.value }))}
                  disabled={submitting}
                />
              </label>
              {draftState.balanceMethod === "TRANSFER" ? (
                <>
                  <label>
                    Institución
                    <select
                      aria-label="Institución del saldo"
                      value={draftState.balanceInstitution}
                      onChange={(event) =>
                        setDraftState((state) => ({
                          ...state,
                          balanceInstitution: event.target.value as TransferInstitution | "",
                        }))
                      }
                      disabled={submitting}
                    >
                      <option value="">Elegí una institución</option>
                      {TRANSFER_INSTITUTIONS.map((institution) => (
                        <option key={institution} value={institution}>{institutionLabel(institution)}</option>
                      ))}
                    </select>
                  </label>
                  {draftState.balanceInstitution === "OTHER" ? (
                    <label>
                      Otra institución
                      <input
                        aria-label="Institución alternativa del saldo"
                        value={draftState.balanceInstitutionOther}
                        onChange={(event) =>
                          setDraftState((state) => ({ ...state, balanceInstitutionOther: event.target.value }))
                        }
                        disabled={submitting}
                      />
                    </label>
                  ) : null}
                </>
              ) : null}
            </>
          )}

          {draftState.fixed.map((tender, index) => {
            const collections = collectionsFor(tender.method);
            const useCollection = tender.collectionId !== "";
            return (
              <div className="proportional-tender" key={tender.key}>
                <label>
                  Pago {index + 1}
                  <select
                    aria-label={`Medio del importe fijo ${index + 1}`}
                    value={tender.method}
                    onChange={(event) =>
                      updateTender(tender.key, {
                        method: event.target.value as ProportionalMethod,
                        collectionId: "",
                        received: "",
                        reference: "",
                        institution: "",
                        institutionOther: "",
                      })
                    }
                    disabled={submitting}
                  >
                    {PROPORTIONAL_METHODS.map((method) => (
                      <option
                        key={method}
                        value={method}
                        disabled={
                          method === draftState.balanceMethod
                          || (availability !== null && !availability[method].available)
                        }
                      >
                        {methodLabel(method)}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  Importe
                  <input
                    inputMode="decimal"
                    aria-label={`Importe fijo ${index + 1}`}
                    value={tender.amount}
                    onChange={(event) => updateTender(tender.key, { amount: event.target.value })}
                    readOnly={useCollection}
                    disabled={submitting}
                  />
                </label>

                {tender.method === "CASH" ? (
                  <label>
                    Recibido del importe fijo {index + 1}
                    <input
                      inputMode="decimal"
                      aria-label={`Recibido del importe fijo ${index + 1}`}
                      value={tender.received}
                      onChange={(event) => updateTender(tender.key, { received: event.target.value })}
                      disabled={submitting}
                    />
                  </label>
                ) : (
                  <>
                    {collections.length > 0 ? (
                      <label>
                        Cobro pendiente del importe fijo {index + 1}
                        <select
                          aria-label={`Cobro pendiente del importe fijo ${index + 1}`}
                          value={tender.collectionId}
                          onChange={(event) => selectCollection(tender, event.target.value)}
                          disabled={submitting}
                        >
                          <option value="">Sin cobro registrado</option>
                          {collections.map((collection) => (
                            <option key={collection.id} value={collection.id}>
                              {methodLabel(collection.method)} {money.format(collection.amount.toString())} · {collection.reference}
                            </option>
                          ))}
                        </select>
                      </label>
                    ) : null}

                    {useCollection ? (
                      <p className="cart-note">
                        El cobro registrado ya tiene su referencia y su institución.
                      </p>
                    ) : (
                      <>
                        <label>
                          Referencia del importe fijo {index + 1}
                          <input
                            aria-label={`Referencia del importe fijo ${index + 1}`}
                            value={tender.reference}
                            onChange={(event) => updateTender(tender.key, { reference: event.target.value })}
                            disabled={submitting}
                          />
                        </label>
                        {tender.method === "TRANSFER" ? (
                          <>
                            <label>
                              Institución del importe fijo {index + 1}
                              <select
                                aria-label={`Institución del importe fijo ${index + 1}`}
                                value={tender.institution}
                                onChange={(event) =>
                                  updateTender(tender.key, {
                                    institution: event.target.value as TransferInstitution | "",
                                  })
                                }
                                disabled={submitting}
                              >
                                <option value="">Elegí una institución</option>
                                {TRANSFER_INSTITUTIONS.map((institution) => (
                                  <option key={institution} value={institution}>
                                    {institutionLabel(institution)}
                                  </option>
                                ))}
                              </select>
                            </label>
                            {tender.institution === "OTHER" ? (
                              <label>
                                Institución alternativa del importe fijo {index + 1}
                                <input
                                  aria-label={`Institución alternativa del importe fijo ${index + 1}`}
                                  value={tender.institutionOther}
                                  onChange={(event) => updateTender(tender.key, { institutionOther: event.target.value })}
                                  disabled={submitting}
                                />
                              </label>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    )}
                  </>
                )}

                <button
                  className="secondary-button"
                  onClick={() => setDraftState((state) => ({
                    ...state,
                    fixed: state.fixed.filter((current) => current.key !== tender.key),
                  }))}
                  disabled={submitting}
                >
                  Quitar pago {index + 1}
                </button>
              </div>
            );
          })}

          <button
            className="secondary-button"
            onClick={addFixedTender}
            disabled={submitting || draftState.fixed.length >= 2}
          >
            Agregar pago
          </button>

            </>
          )}

          {change !== null ? (
            <div className="change-box" data-testid="proportional-change-preview">
              <span>Vuelto estimado</span>
              <strong>{money.format(change.change.toString())}</strong>
            </div>
          ) : null}

          {blocker !== null ? (
            <p className="cart-note" data-testid="proportional-blocker">{blocker}</p>
          ) : null}
          {panelError !== "" ? (
            <p className="cart-note" data-testid="proportional-error">{panelError}</p>
          ) : null}

          {/* Sin cotización vigente no hay un cobro que confirmar: no se ofrece
              un botón que no pueda hacer nada. */}
          {quote !== null && simpleReady ? (
            <>
              {mode === "COMBINED" && cashShortage !== null ? (
                <p
                  className="cart-note"
                  role="alert"
                  data-testid="cash-shortage"
                >
                  Faltan {money.format(cashShortage.toString())} en efectivo.
                </p>
              ) : null}

              <button
                className="send-button"
                onClick={() => void confirm()}
                disabled={!canConfirm}
              >
                {submitting ? "Cobrando..." : "Cobrar"}
                <span>-&gt;</span>
              </button>
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
