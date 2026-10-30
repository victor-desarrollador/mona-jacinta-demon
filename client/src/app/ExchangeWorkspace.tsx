"use client";

import { useRef, useState } from "react";
import { CodedApiError, apiRequestCoded } from "../lib/api";
import { formatMoney } from "../lib/money";
import BranchSelect, { type BranchLabel } from "./BranchSelect";
import { canonicalPayloadOf, exchangeDrafts, useExchangeDrafts, type ExchangeDraft } from "./exchange-draft-store";
import {
  CONFIRMED_REFRESH_FAILED_TEXT, RECOVERY_TEXT, REJECTION_TITLE, RESOLVED_ELSEWHERE_TEXT, STALE_TEXT, UNCERTAIN_TEXT,
  draftView, refreshFailureText, rejectionText, type DraftView,
} from "./exchange-messages";

// Cambios de prenda — UI-1: the shell. It decides WHERE a supervisor may work and WHETHER this browser may work at all.
// UI-2: it looks a sale up (GET /sales/exchangeable) and opens the draft from that fresh read.
// UI-3: per original line it takes a return quantity and offers the replacement candidates of GET /sales/:saleId/exchange-replacements; a chosen
// candidate is written to the draft (exchangeDrafts.edit).
// UI-4: the reason, the send and every state of the draft. The STORE is the only source of truth for attempt / recovery / draft: this file
// never keeps a copy of them (useExchangeDrafts), it only derives what to show (draftView) and calls send() / reconcileAfterFreshRead(). It
// never builds the POST, never mints a key and never fetches the sale again after a confirmation: reconcileAfterFreshRead does that GET itself.
//
// The frontend is UX only: the endpoint's `comparison` is the whole price judgement (nothing here prices anything) and the API stays the
// authority on stock, price, no-op and concurrency. Quantities, stock and prices are decimal strings compared with BigInt, never Number.
//
// Authority is the branch ID, nothing else. The branches offered are intersection(user.branchIds, user.saleExchangeLocationIds): the second list
// is the server-computed hint of where the caller is the exchange supervisor (api user-context.dto.ts), a visibility hint only — GET
// /sales/exchangeable and POST /sales/:saleId/exchanges stay authoritative. `labels` (user.branches: name + code) is display text and never
// creates, widens or removes an option.
//
// Web Locks are a SAFETY requirement of the draft store, not an optimization (see exchange-draft-store.ts): without navigator.locks Cambios is
// unavailable, and the workspace says so instead of offering a way in.

export function exchangeAuthorizedBranchIds(user: { branchIds: string[]; saleExchangeLocationIds?: string[] }): string[] {
  const supervised = new Set(user.saleExchangeLocationIds ?? []);
  const seen = new Set<string>();
  return user.branchIds.filter((id) => {
    if (!supervised.has(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// The local view of the workspace. These phases are NOT the persisted states of the draft store; the store is only consulted to open a draft.
type Phase = "IDLE" | "SEARCHING_SALE" | "SALE_LOADED" | "SEARCH_ERROR";

// The display half of GET /sales/exchangeable (money and quantities are decimal strings: never Number). The store validates the part it
// needs (ids, quantities) before this is ever rendered; the display-only fields are read defensively.
type ExchangeableRead = {
  sale: { id: string; saleNumber: string; branchId: string; pricingMode?: string; priceMode?: string };
  lines: Array<{ saleItemId: string; productName?: string; variantName?: string; sku?: string; quantity: string; exchangedQuantity: string; remainingQuantity: string; unitPrice?: string }>;
};

// One message per refusal of the store (openDraftFromFreshRead). None of them echoes sale data.
const REFUSALS: Record<string, string> = {
  READ_INVALID: "La respuesta del servidor no es válida. Reintentá la búsqueda.",
  READ_MISMATCH: "La respuesta no corresponde a la venta o sucursal buscada. Reintentá la búsqueda.",
  READ_STALE: "La lectura de la venta está desactualizada respecto de un cambio ya registrado. Reintentá la búsqueda.",
  NOT_EXCHANGEABLE: "Esta venta no admite cambios.",
  NOTHING_LEFT_TO_EXCHANGE: "En esta venta no queda ninguna prenda para cambiar.",
  PERSIST_FAILED: "No se pudo guardar el borrador en el almacenamiento del navegador. Revisá el espacio disponible y reintentá.",
};

function branchText(id: string, labels: BranchLabel[] | undefined) {
  const label = labels?.find((candidate) => candidate.id === id);
  return label ? `${label.name} (${label.code})` : id.slice(0, 8).toUpperCase();
}

const REPLACEMENT_LIMIT = 20;
const REASON_MAX = 200;

type Note = { tone: "error" | "info"; text: string };
type SaleTarget = { saleId: string; branchId: string; saleNumber: string };
const confirmedText = (exchangeId: string | null, replayed: boolean) =>
  `${exchangeId ? ` n.º ${exchangeId}.` : ""}${replayed ? " Ese cambio ya estaba registrado: el servidor devolvió el resultado anterior, no se duplicó." : ""}`;

const isSpent = (remaining: string) => /^0+$/.test(remaining);

// A canonical positive integer within what is left of the line. BigInt on strings: a quantity or a remainder past 2^53 stays exact.
const QUANTITY = /^[1-9][0-9]*$/;
const quantityFits = (text: string, remaining: string) => QUANTITY.test(text) && BigInt(text) <= BigInt(remaining);

type Comparison = "EQUAL" | "CHEAPER" | "MORE_EXPENSIVE";
type Candidate = { id: string; sku: string; productName: string; color: string | null; size: string | null; available: string; replacementUnitPrice: string; comparison: Comparison };
type Replacements = { saleItemId: string; originalUnitPrice: string; items: Candidate[] };
type ReplacementPhase = "REPLACEMENT_IDLE" | "SEARCHING_REPLACEMENTS" | "REPLACEMENTS_LOADED" | "REPLACEMENTS_ERROR";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isDecimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const textOrNull = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

// The body of GET /sales/:saleId/exchange-replacements, trusted only if every field this screen decides on is well formed and it answers the
// line that was asked about. Anything else is an error, never a half-rendered list.
function parseReplacements(raw: unknown, saleItemId: string): Replacements | null {
  if (!isRecord(raw) || !isRecord(raw.saleItem) || !Array.isArray(raw.items)) return null;
  if (typeof raw.saleItem.id !== "string" || raw.saleItem.id.toLowerCase() !== saleItemId.toLowerCase() || !isDecimal(raw.saleItem.originalUnitPrice)) return null;
  const items: Candidate[] = [];
  for (const entry of raw.items) {
    if (!isRecord(entry) || !isRecord(entry.product)) return null;
    const { id, sku, available, replacementUnitPrice, comparison } = entry;
    if (typeof id !== "string" || id === "" || typeof sku !== "string" || typeof entry.product.name !== "string") return null;
    if (!isDecimal(available) || !isDecimal(replacementUnitPrice)) return null;
    if (comparison !== "EQUAL" && comparison !== "CHEAPER" && comparison !== "MORE_EXPENSIVE") return null;
    items.push({ id, sku, productName: entry.product.name, color: textOrNull(entry.color), size: textOrNull(entry.size), available, replacementUnitPrice, comparison });
  }
  return { saleItemId, originalUnitPrice: raw.saleItem.originalUnitPrice, items };
}

// Stable, readable, free of prices (the store persists it for recovery): Producto · Color · Talle · SKU.
const replacementLabel = (candidate: Candidate) => [candidate.productName, candidate.color, candidate.size, candidate.sku].filter(Boolean).join(" · ");

const DISABLED_REASON = {
  STOCK: "Sin stock suficiente en esta sucursal.",
  CHEAPER: "Es más barata que la prenda original.",
  MORE_EXPENSIVE: "Es más cara que la prenda original.",
} as const;

// Why a candidate cannot be chosen at this quantity; "" when it can. The price verdict is the endpoint's, stock is compared on strings.
function disabledReason(candidate: Candidate, quantity: string): string {
  if (candidate.comparison === "CHEAPER") return DISABLED_REASON.CHEAPER;
  if (candidate.comparison === "MORE_EXPENSIVE") return DISABLED_REASON.MORE_EXPENSIVE;
  return BigInt(candidate.available) >= BigInt(quantity) ? "" : DISABLED_REASON.STOCK;
}

// One block per draft the store holds that needs the operator's attention, whatever sale is on screen. Everything it shows is derived from
// the store's draft (draftView); the two actions are handed in.
function DraftStatus({
  draft: d,
  known,
  note,
  busy,
  refreshing,
  onVerify,
  onRefresh,
}: {
  draft: ExchangeDraft;
  known: boolean; // is the sale number known, i.e. can the sale be refreshed from here
  note: Note | undefined;
  busy: boolean;
  refreshing: boolean;
  onVerify: () => void;
  onRefresh: () => void;
}) {
  const v = draftView(d);
  const refreshButton = known ? (
    <button type="button" className="secondary-button" disabled={busy} onClick={onRefresh}>
      Actualizar venta
    </button>
  ) : (
    <p className="muted">Buscá la venta por su número para actualizarla antes de hacer otro cambio.</p>
  );
  const noteBlock = note ? (
    <p className={note.tone === "error" ? "error-banner" : "muted"} role={note.tone === "error" ? "alert" : undefined}>
      {note.text}
    </p>
  ) : null;
  if (v === "SENDING") return <p role="status">Procesando el cambio… No cierres ni recargues esta pantalla.</p>;
  if (v === "UNCERTAIN") {
    return (
      <>
        <p className="error-banner" role="alert">{UNCERTAIN_TEXT}</p>
        {noteBlock}
        <button type="button" className="secondary-button" disabled={busy} onClick={onVerify}>
          Verificar el cambio
        </button>
      </>
    );
  }
  if (v === "CONFIRMED") {
    const attempt = d.attempt;
    return (
      <>
        <p role="status">
          <strong>Cambio confirmado.</strong>
          {confirmedText(attempt?.exchangeId ?? null, attempt?.replayed ?? false)}
        </p>
        {refreshing ? (
          <p className="muted">Actualizando la venta…</p>
        ) : (
          <>
            {note ? <p className="error-banner" role="alert">{CONFIRMED_REFRESH_FAILED_TEXT}</p> : null}
            {note ? <p className="muted">{note.text}</p> : known ? <p className="muted">Falta actualizar la venta antes de hacer otro cambio.</p> : null}
            {refreshButton}
          </>
        )}
      </>
    );
  }
  if (v === "RESOLVED_ELSEWHERE") {
    return (
      <>
        <p className="error-banner" role="alert">{RESOLVED_ELSEWHERE_TEXT}</p>
        {noteBlock}
        {refreshButton}
      </>
    );
  }
  if (v === "STALE_BASELINE") {
    return (
      <>
        <p className="error-banner" role="alert">{STALE_TEXT}</p>
        {noteBlock}
        {refreshButton}
      </>
    );
  }
  if (v === "RECOVERY_REQUIRED") return <p className="error-banner" role="alert">{RECOVERY_TEXT}</p>;
  // EDITABLE: a definitive rejection is shown until the operator edits (the store then clears the attempt).
  if (d.attempt?.status === "REJECTED") {
    return (
      <p className="error-banner" role="alert">
        <strong>{REJECTION_TITLE}</strong> {rejectionText(d.attempt.errorCode, d.attempt.errorMessage)}
      </p>
    );
  }
  return noteBlock;
}

export default function ExchangeWorkspace({
  token,
  userId,
  branchIds,
  labels,
  onSessionExpired,
}: {
  token: string | null;
  userId: string;
  branchIds: string[];
  labels?: BranchLabel[];
  onSessionExpired: () => void;
}) {
  const [selected, setSelected] = useState(branchIds[0] ?? "");
  const [saleNumber, setSaleNumber] = useState("");
  const [phase, setPhase] = useState<Phase>("IDLE");
  const [read, setRead] = useState<ExchangeableRead | null>(null);
  const [error, setError] = useState("");
  // UI-3: the original line being worked on, its return quantity and the replacement lookup for it.
  const [lineId, setLineId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState("1");
  const [replacementSearch, setReplacementSearch] = useState("");
  const [replacementPhase, setReplacementPhase] = useState<ReplacementPhase>("REPLACEMENT_IDLE");
  const [replacements, setReplacements] = useState<Replacements | null>(null);
  const [replacementError, setReplacementError] = useState("");
  const drafts = useExchangeDrafts(userId);
  const [reasonOverride, setReasonOverride] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, Note>>({});
  const [confirmation, setConfirmation] = useState<{ saleId: string; exchangeId: string | null; replayed: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  // Synchronous guards (the store also serialises, but a double click must not even reach it twice).
  const sendGuard = useRef(false);
  const refreshGuard = useRef(new Set<string>());
  const replacementInFlight = useRef(false);
  const replacementAttempt = useRef(0);
  // Synchronous: two clicks in the same tick must not both pass. `attempt` identifies the search whose answer may still be applied; changing
  // the branch or the number retires it, so a late answer never renders a sale the operator is no longer asking for.
  const inFlight = useRef(false);
  const attempt = useRef(0);
  // A stale selection can never name a branch outside the offered ones.
  const branchId = branchIds.includes(selected) ? selected : (branchIds[0] ?? "");
  const guardAvailable = exchangeDrafts.getGuardStatus() === "AVAILABLE";
  const trimmed = saleNumber.trim();
  const canSearch = guardAvailable && branchId !== "" && trimmed !== "" && phase !== "SEARCHING_SALE";

  // Only the local view is cleared: persisted drafts and attempts (even uncertain or confirmed ones) belong to the store and stay.
  function resetReplacements() {
    replacementAttempt.current += 1;
    replacementInFlight.current = false;
    setReplacementPhase("REPLACEMENT_IDLE");
    setReplacements(null);
    setReplacementError("");
  }

  function resetView() {
    attempt.current += 1;
    inFlight.current = false;
    setPhase("IDLE");
    setRead(null);
    setError("");
    setLineId(null);
    setQuantity("1");
    setReplacementSearch("");
    setReasonOverride(null);
    setConfirmation(null);
    resetReplacements();
  }

  function changeBranch(next: string) {
    setSelected(next);
    resetView();
  }

  function changeSaleNumber(next: string) {
    setSaleNumber(next);
    resetView();
  }

  async function search(target?: { branchId: string; saleNumber: string }) {
    if (!guardAvailable || inFlight.current || (!target && !canSearch)) return;
    const wantedBranch = target?.branchId ?? branchId;
    const wantedNumber = target?.saleNumber ?? trimmed;
    inFlight.current = true;
    const mine = ++attempt.current;
    const current = () => attempt.current === mine;
    setPhase("SEARCHING_SALE");
    setRead(null);
    setError("");
    setLineId(null);
    setQuantity("1");
    setReasonOverride(null);
    setConfirmation(null);
    resetReplacements();
    const fail = (message: string) => {
      setPhase("SEARCH_ERROR");
      setError(message);
    };
    try {
      const query = new URLSearchParams({ branchId: wantedBranch, saleNumber: wantedNumber });
      const body = await apiRequestCoded(`/sales/exchangeable?${query.toString()}`, token);
      if (!current()) return;
      const opened = await exchangeDrafts.openDraftFromFreshRead({ userId, branchId: wantedBranch, saleNumber: wantedNumber, read: body });
      if (!current()) return;
      if (!opened.ok) return fail(REFUSALS[opened.reason] ?? "No se pudo abrir el cambio de esta venta.");
      setRead(body as ExchangeableRead);
      setPhase("SALE_LOADED");
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof CodedApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      fail(cause instanceof Error ? cause.message : "No se pudo buscar la venta.");
    } finally {
      if (current()) inFlight.current = false;
    }
  }

  // ---- UI-3: original line, quantity, replacement ---------------------------------------------------------------------------------------
  const saleId = read?.sale.id ?? "";
  const draft = saleId ? (drafts.find((candidate) => candidate.saleId.toLowerCase() === saleId.toLowerCase()) ?? null) : null;
  // What to show comes from the store's draft alone. Anything but EDITABLE (sending, unresolved, confirmed, blocked) is not edited from here.
  const view: DraftView = draft ? draftView(draft) : "EDITABLE";
  const frozen = view !== "EDITABLE";
  const line = read?.lines.find((candidate) => candidate.saleItemId === lineId) ?? null;
  const quantityOk = line !== null && quantityFits(quantity, line.remainingQuantity);
  const persisted = draft?.lines.find((candidate) => candidate.saleItemId === lineId) ?? null;
  const chosenId = persisted?.replacementVariantId ?? null;

  // Every write goes through the store; a refusal of the store (frozen, recovery…) is shown, never swallowed.
  function editDraft(change: Parameters<typeof exchangeDrafts.edit>[2]): boolean {
    try {
      exchangeDrafts.edit(userId, saleId, change);
      setReplacementError("");
      return true;
    } catch (cause) {
      setReplacementError(cause instanceof Error ? cause.message : "No se pudo actualizar el cambio.");
      return false;
    }
  }

  function chooseLine(saleItemId: string) {
    if (frozen || saleItemId === lineId) return;
    resetReplacements();
    setLineId(saleItemId);
    setReplacementSearch("");
    const existing = draft?.lines.find((candidate) => candidate.saleItemId === saleItemId);
    setQuantity(existing && existing.returnQuantity !== "" ? existing.returnQuantity : "1");
  }

  function changeQuantity(text: string) {
    setQuantity(text);
    if (!line || !persisted || persisted.replacementVariantId === null) return;
    // The chosen candidate keeps its place only if this quantity still fits it AND it is still verifiable in the loaded results; otherwise it
    // is deselected, so the draft never shows a replacement the screen would refuse.
    const chosen = replacements?.items.find((candidate) => candidate.id === persisted.replacementVariantId);
    if (chosen && chosen.comparison === "EQUAL" && quantityFits(text, line.remainingQuantity) && disabledReason(chosen, text) === "") {
      editDraft({ type: "line", saleItemId: line.saleItemId, replacementVariantId: chosen.id, replacementLabel: persisted.replacementLabel, returnQuantity: text });
    } else {
      clearLine(line.saleItemId);
    }
  }

  // Back to the state the opening read gave the line: no replacement, no quantity. The line stays in the draft (removing it is another decision).
  const clearLine = (saleItemId: string) =>
    editDraft({ type: "line", saleItemId, replacementVariantId: null, replacementLabel: "", returnQuantity: "" });

  function chooseCandidate(candidate: Candidate) {
    if (!line || !quantityOk || frozen) return;
    if (chosenId === candidate.id) {
      clearLine(line.saleItemId);
      return;
    }
    if (disabledReason(candidate, quantity) !== "") return;
    if (!persisted && !editDraft({ type: "addLine", saleItemId: line.saleItemId })) return;
    editDraft({ type: "line", saleItemId: line.saleItemId, replacementVariantId: candidate.id, replacementLabel: replacementLabel(candidate), returnQuantity: quantity });
  }

  // ---- UI-4: reason, send, reconcile ---------------------------------------------------------------------------------------------------
  const reasonText = reasonOverride ?? draft?.reason ?? "";
  const reasonTooLong = reasonOverride !== null;
  // Whether the draft is sendable is the STORE's own decision (canonicalPayloadOf, the function send() uses): every line of the draft must be
  // complete. Lines without a replacement are not omitted by send() (INCOMPLETE), so they must be removed explicitly.
  const sendable = draft !== null && canonicalPayloadOf(draft) !== null;
  const canConfirm = guardAvailable && view === "EDITABLE" && sendable && !reasonTooLong && !sending;
  const unconfigured = draft?.lines.filter((candidate) => candidate.replacementVariantId === null) ?? [];

  // Why Confirmar is disabled, in words (a disabled button must not be a silent dead end). The too-long reason has its own alert.
  const confirmHint =
    !draft || view !== "EDITABLE" || canConfirm || reasonTooLong
      ? ""
      : unconfigured.length > 0 || draft.lines.length === 0
        ? "Elegí el reemplazo de al menos una prenda y quitá las que no se cambian."
        : reasonText.trim() === ""
          ? "Escribí el motivo del cambio para poder confirmar."
          : "";

  function changeReason(text: string) {
    if (text.trim().length > REASON_MAX) {
      setReasonOverride(text); // shown, never persisted, and Confirmar waits: the old reason must not travel under a different text
      return;
    }
    setReasonOverride(null);
    editDraft({ type: "reason", value: text });
  }

  function removeUnconfigured() {
    for (const candidate of unconfigured) editDraft({ type: "removeLine", saleItemId: candidate.saleItemId });
  }

  const setNote = (id: string, note: Note | null) =>
    setNotes((current) => {
      const next = { ...current };
      if (note) next[id] = note;
      else delete next[id];
      return next;
    });

  // After a reconciliation the store holds a fresh draft (new baseline and remainders): the table follows it, the old selection is dropped.
  function adopt(fresh: ExchangeDraft) {
    setRead((current) =>
      current && current.sale.id.toLowerCase() === fresh.saleId.toLowerCase()
        ? {
            ...current,
            lines: current.lines.map((candidate) => {
              const source = fresh.available.find((entry) => entry.saleItemId.toLowerCase() === candidate.saleItemId.toLowerCase());
              return source && source.remainingQuantity !== ""
                ? { ...candidate, exchangedQuantity: source.exchangedQuantityBefore, remainingQuantity: source.remainingQuantity }
                : candidate;
            }),
          }
        : current,
    );
    // Only the sale on screen loses its selection: reconciling another sale of the pending list must not touch this one.
    if (read && read.sale.id.toLowerCase() === fresh.saleId.toLowerCase()) {
      setLineId(null);
      setQuantity("1");
      setReasonOverride(null);
      resetReplacements();
    }
  }

  // The store does its own GET /sales/exchangeable here (token in, no read argument) and closes the tombstone only if the read shows the exchange.
  async function refreshSale(target: SaleTarget) {
    if (target.saleNumber === "" || refreshGuard.current.has(target.saleId)) return;
    refreshGuard.current.add(target.saleId);
    setRefreshing(target.saleId);
    setNote(target.saleId, null);
    try {
      const result = await exchangeDrafts.reconcileAfterFreshRead({ userId, ...target, token });
      if (result.ok) adopt(result.draft);
      else if (result.detail && /^401\b/.test(result.detail)) onSessionExpired(); // the evidence stays: dropEditable never touches it
      else setNote(target.saleId, { tone: "error", text: refreshFailureText(result.reason) });
    } catch (cause) {
      setNote(target.saleId, { tone: "error", text: cause instanceof Error ? cause.message : "No pudimos actualizar la venta." });
    } finally {
      refreshGuard.current.delete(target.saleId);
      setRefreshing(null);
    }
  }

  const targetOf = (d: ExchangeDraft): SaleTarget =>
    read && read.sale.id.toLowerCase() === d.saleId.toLowerCase()
      ? { saleId: d.saleId, branchId: read.sale.branchId, saleNumber: read.sale.saleNumber }
      : { saleId: d.saleId, branchId: d.branchId, saleNumber: d.saleNumber };

  // The ONLY sender. Confirmar cambio and (for an UNCERTAIN attempt) Verificar el cambio both call exchangeDrafts.send, which owns the key,
  // the payload and the replay: for UNCERTAIN it replays the SAME key and body, so the server cannot register it twice.
  async function submit(target: ExchangeDraft) {
    if (sendGuard.current) return;
    sendGuard.current = true;
    setSending(true);
    setNote(target.saleId, null);
    try {
      const outcome = await exchangeDrafts.send({ userId, saleId: target.saleId, token });
      if (outcome.kind === "CONFIRMED") {
        setConfirmation({ saleId: target.saleId, exchangeId: outcome.exchangeId, replayed: outcome.replayed });
        await refreshSale(targetOf(target));
      } else if (outcome.kind === "UNCERTAIN" && outcome.sessionExpired) {
        onSessionExpired(); // the UNCERTAIN attempt is already settled in the store and survives the logout
      }
    } catch (cause) {
      setNote(target.saleId, { tone: "error", text: cause instanceof Error ? cause.message : "No se pudo enviar el cambio." });
    } finally {
      sendGuard.current = false;
      setSending(false);
    }
  }

  function resume(d: ExchangeDraft) {
    if (!branchIds.includes(d.branchId) || d.saleNumber === "") return;
    setSelected(d.branchId);
    setSaleNumber(d.saleNumber);
    void search({ branchId: d.branchId, saleNumber: d.saleNumber });
  }

  const others = drafts.filter((candidate) => candidate.saleId.toLowerCase() !== saleId.toLowerCase());

  async function searchReplacements() {
    if (!line || !quantityOk || replacementInFlight.current) return;
    replacementInFlight.current = true;
    const mine = ++replacementAttempt.current;
    const current = () => replacementAttempt.current === mine;
    setReplacementPhase("SEARCHING_REPLACEMENTS");
    setReplacements(null);
    setReplacementError("");
    try {
      const query = new URLSearchParams({ branchId, saleItemId: line.saleItemId });
      if (replacementSearch.trim() !== "") query.set("search", replacementSearch.trim());
      query.set("page", "1");
      query.set("limit", String(REPLACEMENT_LIMIT));
      const body = await apiRequestCoded(`/sales/${saleId}/exchange-replacements?${query.toString()}`, token);
      if (!current()) return;
      const parsed = parseReplacements(body, line.saleItemId);
      if (!parsed) {
        setReplacementPhase("REPLACEMENTS_ERROR");
        setReplacementError("La respuesta de reemplazos no es válida. Reintentá la búsqueda.");
        return;
      }
      setReplacements(parsed);
      setReplacementPhase("REPLACEMENTS_LOADED");
    } catch (cause) {
      if (!current()) return;
      if (cause instanceof CodedApiError && cause.status === 401) {
        onSessionExpired();
        return;
      }
      setReplacementPhase("REPLACEMENTS_ERROR");
      setReplacementError(cause instanceof Error ? cause.message : "No se pudieron buscar los reemplazos.");
    } finally {
      if (current()) replacementInFlight.current = false;
    }
  }

  return (
    <section className="warehouse-workspace exchange-workspace" data-phase={phase} data-replacement-phase={replacementPhase}>
      <h1>Cambios de prenda</h1>

      {guardAvailable ? (
        <>
          {others.map((other) => {
            const v = draftView(other);
            if (v === "EDITABLE") {
              if (other.saleNumber === "" || !branchIds.includes(other.branchId)) return null;
              return (
                <div key={other.saleId} className="exchange-pending" data-testid={`draft-${other.saleId}`}>
                  <p>
                    Venta {other.saleNumber}: cambio en preparación.{" "}
                    <button type="button" className="secondary-button" onClick={() => resume(other)}>
                      Retomar
                    </button>
                  </p>
                </div>
              );
            }
            return (
              <div key={other.saleId} className="exchange-pending" data-testid={`draft-${other.saleId}`}>
                <p>
                  <strong>Venta {other.saleNumber || other.saleId.slice(0, 8)}</strong>
                </p>
                <DraftStatus
                  draft={other}
                  known={targetOf(other).saleNumber !== ""}
                  note={notes[other.saleId]}
                  busy={sending || refreshing === other.saleId}
                  refreshing={refreshing === other.saleId}
                  onVerify={() => void submit(other)}
                  onRefresh={() => void refreshSale(targetOf(other))}
                />
              </div>
            );
          })}
          <form
            className="toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <BranchSelect value={branchId} branchIds={branchIds} labels={labels} disabled={view === "SENDING"} onChange={changeBranch} />
            <div className="search-box">
              <label htmlFor="exchange-sale-number">Número de venta</label>
              <input id="exchange-sale-number" value={saleNumber} disabled={view === "SENDING"} onChange={(event) => changeSaleNumber(event.target.value)} />
              <button type="submit" className="secondary-button" disabled={!canSearch || view === "SENDING"}>
                Buscar venta
              </button>
            </div>
          </form>
          {phase === "SEARCHING_SALE" ? <p className="muted">Buscando la venta…</p> : null}
          {phase === "SEARCH_ERROR" ? (
            <p className="error-banner" role="alert">
              {error}
            </p>
          ) : null}
          {phase === "SALE_LOADED" && read ? (
            <div className="exchange-sale">
              <dl>
                <dt>Venta</dt>
                <dd>{read.sale.saleNumber}</dd>
                <dt>Sucursal</dt>
                <dd>{branchText(read.sale.branchId, labels)}</dd>
                <dt>pricingMode</dt>
                <dd>{read.sale.pricingMode ?? "—"}</dd>
                <dt>priceMode</dt>
                <dd>{read.sale.priceMode ?? "—"}</dd>
              </dl>
              <table className="warehouse-table">
                <thead>
                  <tr>
                    <th>Línea</th>
                    <th>Prenda</th>
                    <th>Variante</th>
                    <th>SKU</th>
                    <th>Vendida</th>
                    <th>Ya cambiada</th>
                    <th>Disponible</th>
                    <th>Precio unitario</th>
                    <th>Estado</th>
                    <th>Acción</th>
                  </tr>
                </thead>
                <tbody>
                  {read.lines.map((line) => (
                    <tr key={line.saleItemId}>
                      <td>{line.saleItemId}</td>
                      <td>{line.productName}</td>
                      <td>{line.variantName}</td>
                      <td>{line.sku}</td>
                      <td>{line.quantity}</td>
                      <td>{line.exchangedQuantity}</td>
                      <td>{line.remainingQuantity}</td>
                      <td>{typeof line.unitPrice === "string" ? formatMoney(line.unitPrice) : "—"}</td>
                      <td>{isSpent(line.remainingQuantity) ? "Agotada: sin cambio posible" : "Disponible para cambio"}</td>
                      <td>
                        {isSpent(line.remainingQuantity) ? null : (
                          <button type="button" className="secondary-button" aria-pressed={lineId === line.saleItemId} disabled={frozen} onClick={() => chooseLine(line.saleItemId)}>
                            Elegir prenda
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {draft ? (
                <DraftStatus
                  draft={draft}
                  known={targetOf(draft).saleNumber !== ""}
                  note={notes[draft.saleId]}
                  busy={sending || refreshing === draft.saleId}
                  refreshing={refreshing === draft.saleId}
                  onVerify={() => void submit(draft)}
                  onRefresh={() => void refreshSale(targetOf(draft))}
                />
              ) : null}
              {view === "EDITABLE" && confirmation?.saleId === saleId ? (
                <p role="status">
                  <strong>Cambio confirmado.</strong>
                  {confirmedText(confirmation.exchangeId, confirmation.replayed)} La venta ya está actualizada.
                </p>
              ) : null}
              {line ? (
                <div className="exchange-replacement">
                  <h2>Prenda a cambiar</h2>
                  <p>
                    {line.productName} · {line.variantName} · {line.sku} — {typeof line.unitPrice === "string" ? formatMoney(line.unitPrice) : "—"} — disponible: {line.remainingQuantity}
                  </p>
                  <form
                    className="toolbar"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void searchReplacements();
                    }}
                  >
                    <label htmlFor="exchange-return-quantity">Cantidad a devolver</label>
                    <input id="exchange-return-quantity" inputMode="numeric" disabled={frozen} value={quantity} onChange={(event) => changeQuantity(event.target.value)} />
                    <label htmlFor="exchange-replacement-search">Buscar reemplazo</label>
                    <input id="exchange-replacement-search" disabled={frozen} value={replacementSearch} onChange={(event) => setReplacementSearch(event.target.value)} />
                    <button type="submit" className="secondary-button" disabled={!quantityOk || frozen || replacementPhase === "SEARCHING_REPLACEMENTS"}>
                      Buscar reemplazos
                    </button>
                  </form>
                  {!quantityOk ? (
                    <p className="error-banner" role="alert">
                      La cantidad debe ser un número entero entre 1 y {line.remainingQuantity}.
                    </p>
                  ) : null}
                  {replacementPhase === "SEARCHING_REPLACEMENTS" ? <p className="muted">Buscando reemplazos…</p> : null}
                  {replacementError ? (
                    <p className="error-banner" role="alert">
                      {replacementError}
                    </p>
                  ) : null}
                  {replacementPhase === "REPLACEMENTS_LOADED" && replacements ? (
                    <>
                      <p>
                        Precio de la prenda original: {formatMoney(replacements.originalUnitPrice)}
                      </p>
                      {replacements.items.length === 0 ? <p className="muted">No hay reemplazos para esa búsqueda.</p> : (
                        <table className="warehouse-table" aria-label="Candidatos de reemplazo">
                          <thead>
                            <tr>
                              <th>Producto</th>
                              <th>SKU</th>
                              <th>Color</th>
                              <th>Talle</th>
                              <th>Disponible</th>
                              <th>Precio</th>
                              <th>Comparación</th>
                              <th>Acción</th>
                            </tr>
                          </thead>
                          <tbody>
                            {replacements.items.map((candidate) => {
                              const reason = quantityOk ? disabledReason(candidate, quantity) : "";
                              const chosen = chosenId === candidate.id;
                              return (
                                <tr key={candidate.id}>
                                  <td>{candidate.productName}</td>
                                  <td>{candidate.sku}</td>
                                  <td>{candidate.color ?? "—"}</td>
                                  <td>{candidate.size ?? "—"}</td>
                                  <td>{candidate.available}</td>
                                  <td>{formatMoney(candidate.replacementUnitPrice)}</td>
                                  <td>{candidate.comparison}</td>
                                  <td>
                                    <button type="button" className="secondary-button" aria-pressed={chosen} disabled={frozen || (!chosen && (reason !== "" || !quantityOk))} onClick={() => chooseCandidate(candidate)}>
                                      Elegir reemplazo
                                    </button>
                                    {reason !== "" && !chosen ? <span className="muted"> {reason}</span> : null}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </>
                  ) : null}
                </div>
              ) : null}
              {draft ? (
                <div className="exchange-confirm">
                  <h2>Resumen del cambio</h2>
                  {draft.lines.length > 0 ? (
                    <ul aria-label="Resumen del cambio">
                      {draft.lines.map((entry) => {
                        const original = read.lines.find((candidate) => candidate.saleItemId.toLowerCase() === entry.saleItemId.toLowerCase());
                        return (
                          <li key={entry.saleItemId}>
                            {[original?.productName, original?.variantName].filter(Boolean).join(" · ") || "Prenda"}
                            {" → "}
                            {entry.replacementVariantId === null ? "falta elegir el reemplazo" : `${entry.replacementLabel || "reemplazo elegido"} × ${entry.returnQuantity}`}
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                  {confirmHint ? (
                    <p id="exchange-confirm-hint" className="muted">
                      {confirmHint}
                    </p>
                  ) : null}
                  {view === "EDITABLE" && unconfigured.length > 0 ? (
                    <button type="button" className="secondary-button" onClick={removeUnconfigured}>
                      Quitar líneas sin reemplazo
                    </button>
                  ) : null}
                  <label htmlFor="exchange-reason">Motivo del cambio</label>
                  <input id="exchange-reason" value={reasonText} disabled={frozen} onChange={(event) => changeReason(event.target.value)} />
                  <span className="muted">{reasonText.trim().length}/{REASON_MAX}</span>
                  {reasonTooLong ? (
                    <p className="error-banner" role="alert">
                      El motivo no puede superar los {REASON_MAX} caracteres.
                    </p>
                  ) : null}
                  {view === "EDITABLE" || view === "SENDING" ? (
                    <button type="button" className="primary-button" disabled={!canConfirm} aria-describedby={confirmHint ? "exchange-confirm-hint" : undefined} onClick={() => void submit(draft)}>
                      Confirmar cambio
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : (
        <p className="error-banner" role="alert">
          Cambios no está disponible en este navegador o contexto: requiere Web Locks, que solo existen en un contexto seguro (HTTPS). Abrí el
          sistema mediante la URL segura HTTPS para operar cambios.
        </p>
      )}
    </section>
  );
}
