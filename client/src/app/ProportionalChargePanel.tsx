"use client";

import { useEffect, useRef, useState } from "react";
import {
  CheckoutContractError,
  PROPORTIONAL_METHODS,
  TRANSFER_INSTITUTIONS,
  attemptAfterFailure,
  attemptConfirmed,
  availableMethods,
  beginCheckout,
  buildCheckoutRequest,
  buildQuoteRequest,
  methodAvailability,
  parseCheckoutQuote,
  parseCheckoutResult,
  previewChange,
  retryCheckout,
  type CheckoutAttempt,
  type CheckoutDraft,
  type CheckoutQuote,
  type CheckoutRequestBody,
  type FixedTenderDraft,
  type PaymentMethod,
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
  chargeBlocked: boolean;
  attempt: CheckoutAttempt | null;
  // El bloqueo síncrono del doble clic vive en el workspace, no en el panel.
  inFlight: { current: Set<string> };
  onAttempt: (attempt: CheckoutAttempt) => void;
};

const METHOD_LABELS: Record<ProportionalMethod, string> = {
  CASH: "Efectivo",
  TRANSFER: "Transferencia",
  CARD_DEBIT: "Tarjeta de débito",
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
  return method === "CASH" || method === "TRANSFER" || method === "CARD_DEBIT";
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
    institutionOther: tender.institutionOther,
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
      draft.balanceInstitutionOther = state.balanceInstitutionOther;
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

// Nada de lo que llega acá libera un intento: sólo se usa `message` para
// mostrar y, cuando el servidor informa el importe vigente, para poder
// mostrarlo. El status y el código viajan tal como llegaron.
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
  chargeBlocked,
  attempt,
  inFlight,
  onAttempt,
}: ProportionalChargePanelProps) {
  const [draftState, setDraftState] = useState<DraftState>(INITIAL_DRAFT);
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  // Los cobros externos que el servidor informó como pendientes en la última
  // cotización válida de esta venta. Se usan sólo para ofrecer la elección: la
  // aceptación real la valida el contrato contra la cotización vigente.
  const [knownCollections, setKnownCollections] = useState<QuoteCollection[]>([]);
  const [quoteNote, setQuoteNote] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteEpoch, setQuoteEpoch] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [panelError, setPanelError] = useState("");
  const [serverTotal, setServerTotal] = useState<string | null>(null);
  const [serverBalance, setServerBalance] = useState<string | null>(null);
  const nextTenderKey = useRef(1);
  const quoteRequest = useRef(0);

  const draft = toDraft(draftState, money);
  const body = quoteBody(draft);
  const confirmed = attempt?.state === "CONFIRMED";

  // La cotización vigente es la del servidor para ESTA composición. Una
  // respuesta que ya no corresponde al draft actual se descarta.
  //
  // El reinicio de la cotización es parte del ciclo de datos del panel, no un
  // setState de evento: cuando el draft deja de ser cotizable (o el cobro ya se
  // confirmó) hay que soltar la cotización vieja antes de esperar el retardo, y
  // cuando la composición cambia hay que marcar la lectura en curso.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (confirmed || body === null) {
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
  }, [body, sale.saleId, request, quoteEpoch, confirmed]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const availability = quote === null ? null : methodAvailability(quote);
  const methods = quote === null ? [...PROPORTIONAL_METHODS] : availableMethods(quote);
  const change = quote === null ? null : previewChange(draft, quote);
  const blocker = quoteLoading || quote === null ? null : checkoutBlocker(draft, quote, sale.saleId);
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

  // El cuerpo viaja tal cual lo armó el contrato, con su clave incluida: acá no
  // se reconstruye ni se recalcula ningún importe.
  async function send(started: CheckoutAttempt, checkoutBody: CheckoutRequestBody) {
    try {
      const response = await request(`/sales/${sale.saleId}/checkout`, {
        method: "POST",
        body: JSON.stringify(checkoutBody),
      });
      onAttempt(attemptConfirmed(started, parseCheckoutResult(response)));
      setPanelError("");
      setServerTotal(null);
      setServerBalance(null);
    } catch (cause) {
      const failure = failureView(cause);
      onAttempt(attemptAfterFailure(started, failure));
      // La cotización vigente ya no sirve. Se muestra el importe que informa el
      // servidor y se pide una nueva; NADA se reenvía por cuenta propia.
      if (failure.code === "CHECKOUT_QUOTE_CHANGED") {
        setServerTotal(failure.total);
        setServerBalance(failure.balance);
        setQuote(null);
        setQuoteEpoch((epoch) => epoch + 1);
      }
    } finally {
      inFlight.current.delete(sale.saleId);
      setSubmitting(false);
    }
  }

  async function confirm() {
    if (quote === null || blocker !== null || cashSession === null || chargeBlocked || submitting) return;
    // Bloqueo síncrono: dos clics del mismo tick llegan antes de que React
    // vuelva a renderizar (y de que el botón quede deshabilitado).
    if (inFlight.current.has(sale.saleId)) return;
    inFlight.current.add(sale.saleId);
    setSubmitting(true);
    setPanelError("");
    let pending: CheckoutAttempt;
    try {
      pending = beginCheckout({
        saleId: sale.saleId,
        cashSessionId: cashSession.sessionId,
        operationKey: crypto.randomUUID(),
        draft,
        quote,
        current: attempt,
      });
    } catch (cause) {
      inFlight.current.delete(sale.saleId);
      setSubmitting(false);
      setPanelError(noteOf(cause, "No se pudo preparar el cobro."));
      return;
    }
    onAttempt(pending);
    await send(pending, pending.body);
  }

  async function retry() {
    if (attempt === null || attempt.state === "CONFIRMED" || submitting) return;
    if (inFlight.current.has(sale.saleId)) return;
    inFlight.current.add(sale.saleId);
    setSubmitting(true);
    setPanelError("");
    // Misma clave, mismo cuerpo: si el primer envío sí cobró, el servidor
    // responde el mismo resultado como reintento.
    const repeat = retryCheckout(attempt);
    await send(attempt, repeat.body);
  }

  const canConfirm =
    quote !== null && !quoteLoading && blocker === null && cashSession !== null && !chargeBlocked
    && !submitting && !locked;

  return (
    <section className="proportional-panel" data-testid="proportional-panel">
      {cashSession === null ? (
        <p className="cart-note" data-testid="proportional-session-note">
          Abrí caja antes de cobrar: el cobro proporcional exige una sesión de caja abierta.
        </p>
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
          <div className="payment-summary">
            <div>
              <span>Total</span>
              <strong data-testid="proportional-total">{money.format(quote.total.toString())}</strong>
            </div>
            <div>
              <span>Saldo ({methodLabel(quote.balance.method)})</span>
              <strong data-testid="proportional-balance">{money.format(quote.balance.amount.toString())}</strong>
            </div>
          </div>

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
            {attempt.state === "UNCERTAIN" ? (
              <button className="secondary-button retry-button" onClick={() => void retry()} disabled={submitting || locked}>
                {submitting ? "Reintentando..." : "Reintentar el mismo cobro"}
              </button>
            ) : null}
          </div>
        )
      ) : (
        <>
          <label>
            Medio de saldo
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
              Recibido del saldo
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
                Referencia del saldo
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
                    Institución del saldo
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
                      Institución alternativa del saldo
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
                  Medio del importe fijo {index + 1}
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
                  Importe fijo {index + 1}
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
                  Quitar importe fijo {index + 1}
                </button>
              </div>
            );
          })}

          <button
            className="secondary-button"
            onClick={addFixedTender}
            disabled={submitting || draftState.fixed.length >= 2}
          >
            Agregar importe fijo
          </button>

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
          {quote !== null ? (
            <button className="send-button" onClick={() => void confirm()} disabled={!canConfirm}>
              {submitting ? "Cobrando..." : "Cobrar"}
              <span>-&gt;</span>
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
