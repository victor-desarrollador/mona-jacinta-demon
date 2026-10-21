"use client";

/* eslint-disable react-hooks/set-state-in-effect */

import { useCallback, useEffect, useRef, useState } from "react";
import { CodedApiError } from "./ProportionalChargePanel";

// WAREHOUSE-MVP: Depósito — branch stock list and the manual stock adjustment.
// Visibility comes from the server-computed user.inventoryManageLocationIds hint
// (never from the role name); GET /inventory/stock and POST /inventory/adjustments
// stay authoritative. Every limit validated here (±100, reason sign, OTHER note,
// result >= 0 and >= reserved) is repeated by the backend.
//
// Durable idempotency: an adjustment is persisted in localStorage BEFORE its POST
// and cleared only by an answer that proves the outcome (2xx, or a definitive
// rejection). A lost answer (network, timeout, 5xx) keeps it, across modal close
// and page reload, and the only way forward is to resend EXACTLY the same payload
// with the SAME idempotencyKey. There is deliberately no "discard" control: it
// could make an already-applied adjustment run again under a new key.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001/api/v1";
const PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 20_000;
// BigInt literals need ES2020; this client targets lower, like the rest of the POS.
const ZERO = BigInt(0);
const MAX_ABS_DELTA = BigInt(100);
const OTHER_NOTE_MIN_LENGTH = 10;
const PENDING_KEY = "mona-jacinta-warehouse-pending-adjustment";
// Statuses that prove the server did NOT apply the adjustment (it was refused
// before or instead of any write). Anything else (no answer, 5xx, 408, 429, ...)
// is uncertain and keeps the pending attempt.
const DEFINITIVE_REJECTION_STATUSES = new Set([400, 401, 403, 404, 409, 422]);

type AdjustmentReason = "DAMAGED" | "LOST" | "LOAD_ERROR" | "SURPLUS" | "OTHER";

const REASONS: Array<{ value: AdjustmentReason; label: string }> = [
  { value: "DAMAGED", label: "Dañado" },
  { value: "LOST", label: "Perdido" },
  { value: "LOAD_ERROR", label: "Error de carga" },
  { value: "SURPLUS", label: "Sobrante" },
  { value: "OTHER", label: "Otro" },
];

type StockItem = {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  barcode: string | null;
  color: string | null;
  size: string | null;
  physical: string;
  reserved: string;
  available: string;
};

type StockPage = { items: StockItem[]; pagination: { page: number; limit: number; total: number } };
type AdjustedInventory = { variantId: string; physical: string; reserved: string; available: string };
type AdjustmentResult = { replayed: boolean; inventory?: AdjustedInventory };

const NETWORK_MESSAGE =
  "No se pudo confirmar el ajuste (sin respuesta del servidor). Podés reintentar el mismo ajuste sin riesgo de duplicarlo.";

// Same transport contract as the rest of the POS (Bearer token, JSON), but it
// keeps the HTTP status and the API error code: the screen must tell a rejected
// adjustment (409 with a reason) from an uncertain one (no answer / 5xx).
async function warehouseRequest<T>(
  path: string,
  token: string | null,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  options.signal?.addEventListener("abort", () => controller.abort());
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers, signal: controller.signal });
  } catch (cause) {
    // A caller-initiated abort (stale list request) is not a network failure.
    if (options.signal?.aborted) throw cause;
    throw new CodedApiError(NETWORK_MESSAGE, null, "NETWORK", null);
  } finally {
    clearTimeout(timer);
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string; details?: unknown };
    message?: string;
  };
  if (!response.ok) {
    const fallback =
      response.status === 401
        ? "Tu sesión expiró."
        : response.status === 403
          ? "No tenés permiso para ajustar stock en esta sucursal."
          : "No se pudo completar la operación.";
    throw new CodedApiError(
      body.error?.message ?? body.message ?? fallback,
      response.status,
      body.error?.code ?? null,
      body.error?.details ?? null,
    );
  }
  return body as T;
}

function isDefinitiveRejection(error: CodedApiError) {
  return error.status !== null && DEFINITIVE_REJECTION_STATUSES.has(error.status);
}

// The attempt exactly as persisted and as sent. userId scopes it to the account
// that made it (a key is only idempotent per user); productName / sku are display only.
type PendingAdjustment = {
  idempotencyKey: string;
  variantId: string;
  branchId: string;
  delta: string;
  reason: AdjustmentReason;
  normalizedNote: string | null;
  userId: string | null;
  productName: string;
  sku: string;
};

function isPendingAdjustment(value: unknown): value is PendingAdjustment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.idempotencyKey === "string" && v.idempotencyKey !== "" &&
    typeof v.variantId === "string" &&
    typeof v.branchId === "string" &&
    typeof v.delta === "string" && /^[+-]?\d+$/.test(v.delta) &&
    REASONS.some((reason) => reason.value === v.reason) &&
    (v.normalizedNote === null || typeof v.normalizedNote === "string") &&
    (v.userId === null || typeof v.userId === "string") &&
    typeof v.productName === "string" &&
    typeof v.sku === "string"
  );
}

// An unreadable or malformed record is not an attempt this code ever wrote
// (writes are single setItem calls of valid JSON): it cannot be replayed.
function loadPending(): PendingAdjustment | null {
  try {
    const raw = window.localStorage.getItem(PENDING_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPendingAdjustment(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function savePending(record: PendingAdjustment) {
  try {
    window.localStorage.setItem(PENDING_KEY, JSON.stringify(record));
    return window.localStorage.getItem(PENDING_KEY) !== null;
  } catch {
    return false;
  }
}

function clearPending() {
  try {
    window.localStorage.removeItem(PENDING_KEY);
  } catch {
    /* nothing else can be done; the next load re-reads the record */
  }
}

function requestBody(record: PendingAdjustment) {
  return {
    variantId: record.variantId,
    branchId: record.branchId,
    delta: record.delta,
    reason: record.reason,
    ...(record.normalizedNote ? { note: record.normalizedNote } : {}),
    idempotencyKey: record.idempotencyKey,
  };
}

type SendOutcome =
  | { kind: "applied" }
  | { kind: "rejected"; message: string }
  | { kind: "uncertain"; message: string }
  | { kind: "expired" }
  | { kind: "unsaved"; message: string }
  | { kind: "busy" };

function branchLabel(id: string) {
  return id.slice(0, 8).toUpperCase();
}

type FormState = { deltaText: string; reason: AdjustmentReason | ""; note: string };

function validateAdjustment(item: StockItem, form: FormState) {
  const raw = form.deltaText.trim();
  const delta = /^[+-]?\d+$/.test(raw) ? BigInt(raw) : null;
  const note = form.note.trim();
  const physical = BigInt(item.physical);
  const reserved = BigInt(item.reserved);

  let message = "";
  if (raw !== "" && (delta === null || delta === ZERO)) {
    message = "La cantidad debe ser un entero distinto de cero.";
  } else if (delta !== null && (delta > MAX_ABS_DELTA || delta < -MAX_ABS_DELTA)) {
    message = "El ajuste no puede superar 100 unidades.";
  } else if (delta !== null && (form.reason === "DAMAGED" || form.reason === "LOST") && delta > ZERO) {
    message = "Este motivo solo admite ajustes negativos.";
  } else if (delta !== null && form.reason === "SURPLUS" && delta < ZERO) {
    message = "Este motivo solo admite ajustes positivos.";
  } else if (form.reason === "OTHER" && note.length < OTHER_NOTE_MIN_LENGTH) {
    message = "La nota debe tener al menos 10 caracteres.";
  } else if (delta !== null && physical + delta < ZERO) {
    message = "El stock físico no puede quedar en negativo.";
  } else if (delta !== null && physical + delta < reserved) {
    message = "El stock físico no puede quedar por debajo de lo reservado.";
  }

  const usableDelta = delta !== null && delta !== ZERO ? delta : null;
  return {
    message,
    valid: message === "" && usableDelta !== null && form.reason !== "",
    delta: usableDelta,
    note,
    resulting: usableDelta !== null ? physical + usableDelta : physical,
  };
}

function AdjustmentDialog({
  branchId,
  item,
  pending,
  onClose,
  onSend,
  onRetryPending,
}: {
  branchId: string;
  item: StockItem;
  // The unresolved attempt, once one exists: the form is frozen and only a retry of it is possible.
  pending: PendingAdjustment | null;
  onClose: () => void;
  onSend: (record: Omit<PendingAdjustment, "userId">) => Promise<SendOutcome>;
  onRetryPending: () => Promise<SendOutcome>;
}) {
  const [form, setForm] = useState<FormState>({ deltaText: "", reason: "", note: "" });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const frozen = pending !== null;

  const check = validateAdjustment(item, form);

  function update(patch: Partial<FormState>) {
    if (frozen) return;
    setForm((current) => ({ ...current, ...patch }));
    setError("");
  }

  async function run(action: () => Promise<SendOutcome>) {
    setSubmitting(true);
    setError("");
    try {
      const outcome = await action();
      if (outcome.kind === "applied") onClose();
      else if (outcome.kind === "rejected" || outcome.kind === "uncertain" || outcome.kind === "unsaved") setError(outcome.message);
    } finally {
      setSubmitting(false);
    }
  }

  function submit() {
    if (submitting || frozen || !check.valid || check.delta === null || form.reason === "") return;
    // A fresh key for a genuinely new attempt; a retry never reaches this path.
    void run(() =>
      onSend({
        idempotencyKey: crypto.randomUUID(),
        variantId: item.variantId,
        branchId,
        delta: check.delta!.toString(),
        reason: form.reason as AdjustmentReason,
        normalizedNote: check.note || null,
        productName: item.productName,
        sku: item.sku,
      }),
    );
  }

  function retry() {
    if (submitting) return;
    void run(onRetryPending);
  }

  return (
    <div className="warehouse-overlay">
      <div className="warehouse-dialog" role="dialog" aria-modal="true" aria-labelledby="warehouse-dialog-title">
        <h2 id="warehouse-dialog-title">Ajustar stock</h2>
        <dl className="warehouse-facts">
          <div>
            <dt>Producto</dt>
            <dd>{item.productName}</dd>
          </div>
          <div>
            <dt>Variante</dt>
            <dd>
              {[item.color, item.size].filter(Boolean).join(" / ") || "—"} · {item.sku}
            </dd>
          </div>
          <div>
            <dt>Stock físico actual</dt>
            <dd>{item.physical}</dd>
          </div>
          <div>
            <dt>Reservado</dt>
            <dd>{item.reserved}</dd>
          </div>
          <div>
            <dt>Disponible</dt>
            <dd>{item.available}</dd>
          </div>
        </dl>

        <label htmlFor="warehouse-delta">Cantidad a ajustar (+ suma, − resta)</label>
        <input
          id="warehouse-delta"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={form.deltaText}
          onChange={(event) => update({ deltaText: event.target.value })}
          disabled={frozen}
        />
        <p className="warehouse-result">
          Stock físico resultante: <strong data-testid="resulting-physical">{check.resulting.toString()}</strong>
        </p>

        <label htmlFor="warehouse-reason">Motivo</label>
        <select
          id="warehouse-reason"
          value={form.reason}
          disabled={frozen}
          onChange={(event) => update({ reason: event.target.value as AdjustmentReason | "" })}
        >
          <option value="">Seleccioná un motivo</option>
          {REASONS.map((reason) => (
            <option key={reason.value} value={reason.value}>
              {reason.label}
            </option>
          ))}
        </select>

        <label htmlFor="warehouse-note">Nota</label>
        <textarea
          id="warehouse-note"
          rows={3}
          maxLength={500}
          value={form.note}
          disabled={frozen}
          onChange={(event) => update({ note: event.target.value })}
        />

        {check.message ? <p className="error-banner" role="alert">{check.message}</p> : null}
        {error ? <p className="error-banner" role="alert">{error}</p> : null}

        <div className="warehouse-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={submitting}>
            Cancelar
          </button>
          {frozen ? (
            <button type="button" className="secondary-button" onClick={retry} disabled={submitting}>
              Reintentar mismo ajuste
            </button>
          ) : null}
          <button
            type="button"
            className="primary-button"
            onClick={submit}
            disabled={!check.valid || submitting || frozen}
          >
            Confirmar ajuste
          </button>
        </div>
      </div>
    </div>
  );
}

export default function WarehouseWorkspace({
  token,
  userId,
  branchIds,
  onSessionExpired,
}: {
  token: string | null;
  userId: string;
  // user.inventoryManageLocationIds: the only branches this screen offers.
  branchIds: string[];
  onSessionExpired: () => void;
}) {
  const [branchId, setBranchId] = useState(branchIds[0] ?? "");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<StockPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const [adjusting, setAdjusting] = useState<StockItem | null>(null);
  // Only mounted client-side (after the session loads), so localStorage is readable here.
  const [pending, setPending] = useState<PendingAdjustment | null>(loadPending);
  const [attemptError, setAttemptError] = useState("");
  const sendingRef = useRef(false);
  const [sending, setSending] = useState(false);
  const tokenRef = useRef(token);
  useEffect(() => {
    tokenRef.current = token;
  });
  // The parent re-creates its callbacks on every render: keep the latest one in a
  // ref so it never retriggers the list request.
  const expiredRef = useRef(onSessionExpired);
  useEffect(() => {
    expiredRef.current = onSessionExpired;
  });

  // Every (branch, search, page) change aborts the previous request; an answer
  // that belongs to an older request is dropped, never rendered.
  useEffect(() => {
    if (!branchId) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ branchId, page: String(page), limit: String(PAGE_SIZE) });
    if (search) query.set("search", search);
    setLoading(true);
    setError("");
    warehouseRequest<StockPage>(`/inventory/stock?${query.toString()}`, token, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof CodedApiError && cause.status === 401) {
          expiredRef.current();
          return;
        }
        setError(cause instanceof Error ? cause.message : "No se pudo cargar el stock.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [token, branchId, search, page, reloadTick]);

  const applyResult = useCallback((record: PendingAdjustment, result: AdjustmentResult) => {
    const inventory = result.inventory;
    if (inventory) {
      setData((current) =>
        current
          ? {
              ...current,
              items: current.items.map((row) =>
                row.variantId === inventory.variantId
                  ? { ...row, physical: inventory.physical, reserved: inventory.reserved, available: inventory.available }
                  : row,
              ),
            }
          : current,
      );
    }
    setNotice(`Ajuste registrado: ${record.productName} (${record.sku}).`);
  }, []);

  // The single send path: first attempts (persisted first) and retries (the stored
  // record, untouched) both go through it, so the payload and key can never differ.
  async function sendAttempt(record: PendingAdjustment, persist: boolean): Promise<SendOutcome> {
    if (sendingRef.current) return { kind: "busy" };
    sendingRef.current = true;
    setSending(true);
    try {
      if (persist) {
        if (!savePending(record)) {
          return { kind: "unsaved", message: "No se pudo guardar el intento de ajuste en este navegador; no se envió nada." };
        }
        setPending(record);
      }
      try {
        const result = await warehouseRequest<AdjustmentResult>("/inventory/adjustments", tokenRef.current, {
          method: "POST",
          body: JSON.stringify(requestBody(record)),
        });
        clearPending();
        setPending(null);
        setAttemptError("");
        applyResult(record, result);
        return { kind: "applied" };
      } catch (cause) {
        const failure = cause instanceof CodedApiError ? cause : null;
        if (failure && isDefinitiveRejection(failure)) {
          clearPending();
          setPending(null);
          if (failure.status === 401) {
            expiredRef.current();
            return { kind: "expired" };
          }
          if (failure.status === 409) setReloadTick((tick) => tick + 1);
          return { kind: "rejected", message: failure.message };
        }
        // No answer, 5xx or anything else that does not prove the outcome: keep the attempt.
        const message = failure && failure.status === null ? failure.message : NETWORK_MESSAGE;
        return { kind: "uncertain", message };
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function retryPendingFromBanner() {
    if (!pending || pending.userId !== userId) return;
    setAttemptError("");
    const outcome = await sendAttempt(pending, false);
    if (outcome.kind === "applied") setReloadTick((tick) => tick + 1);
    else if (outcome.kind === "rejected" || outcome.kind === "uncertain") setAttemptError(outcome.message);
  }

  function changeBranch(next: string) {
    setBranchId(next);
    setPage(1);
    setData(null);
    setNotice("");
  }

  function submitSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
    setNotice("");
  }

  const total = data?.pagination.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section className="warehouse-workspace">
      <h1>Depósito</h1>

      <div className="toolbar">
        <div className="branch-select">
          <label htmlFor="warehouse-branch">Sucursal</label>
          <select
            id="warehouse-branch"
            value={branchId}
            onChange={(event) => changeBranch(event.target.value)}
            disabled={branchIds.length === 0}
          >
            {branchIds.map((id) => (
              <option key={id} value={id}>
                {branchLabel(id)}
              </option>
            ))}
          </select>
        </div>
        <form className="search-box" onSubmit={submitSearch}>
          <label htmlFor="warehouse-search">Buscar producto, SKU o código de barras</label>
          <input
            id="warehouse-search"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          <button type="submit" className="secondary-button">
            Buscar
          </button>
        </form>
      </div>

      {error ? <p className="error-banner">{error}</p> : null}
      {pending ? (
        <div className="error-banner" role="alert" data-testid="pending-adjustment">
          <p>
            <strong>Hay un ajuste de stock pendiente de confirmar.</strong>
          </p>
          <p>
            {pending.productName} ({pending.sku}): {pending.delta} · {REASONS.find((reason) => reason.value === pending.reason)?.label}.
            No se puede iniciar otro ajuste hasta confirmarlo.
          </p>
          {pending.userId !== userId ? (
            <p>Este ajuste pendiente pertenece a otro usuario de este navegador: iniciá sesión con esa cuenta para confirmarlo.</p>
          ) : (
            <button type="button" className="secondary-button" onClick={() => void retryPendingFromBanner()} disabled={sending}>
              Reintentar ajuste pendiente
            </button>
          )}
        </div>
      ) : null}
      {attemptError ? <p className="error-banner" role="alert">{attemptError}</p> : null}
      {notice ? <p className="notice-banner">{notice}</p> : null}

      <table className="warehouse-table">
        <thead>
          <tr>
            <th>Producto</th>
            <th>Color</th>
            <th>Talle</th>
            <th>SKU</th>
            <th>Físico</th>
            <th>Reservado</th>
            <th>Disponible</th>
            <th aria-label="Acciones" />
          </tr>
        </thead>
        <tbody>
          {data?.items.map((item) => (
            <tr key={item.variantId}>
              <td>{item.productName}</td>
              <td>{item.color ?? "—"}</td>
              <td>{item.size ?? "—"}</td>
              <td>{item.sku}</td>
              <td>{item.physical}</td>
              <td>{item.reserved}</td>
              <td>{item.available}</td>
              <td>
                <button
                  type="button"
                  className="secondary-button"
                  aria-label={`Ajustar ${item.sku}`}
                  disabled={pending !== null}
                  onClick={() => {
                    setNotice("");
                    setAdjusting(item);
                  }}
                >
                  Ajustar
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {loading && !data ? <p className="muted">Cargando stock...</p> : null}
      {data && data.items.length === 0 ? <p className="muted">No hay productos para mostrar.</p> : null}

      <div className="warehouse-pager">
        <button type="button" className="secondary-button" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
          Anterior
        </button>
        <span>
          Página {page} de {pages} · {total} variantes
        </span>
        <button type="button" className="secondary-button" disabled={page >= pages || loading} onClick={() => setPage(page + 1)}>
          Siguiente
        </button>
      </div>

      {adjusting ? (
        <AdjustmentDialog
          key={adjusting.variantId}
          branchId={branchId}
          item={data?.items.find((row) => row.variantId === adjusting.variantId) ?? adjusting}
          pending={pending}
          onClose={() => setAdjusting(null)}
          onSend={(record) => sendAttempt({ ...record, userId }, true)}
          onRetryPending={() => (pending ? sendAttempt(pending, false) : Promise.resolve<SendOutcome>({ kind: "busy" }))}
        />
      ) : null}
    </section>
  );
}
