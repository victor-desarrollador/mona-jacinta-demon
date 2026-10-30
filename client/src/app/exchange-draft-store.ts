"use client";

import { useMemo, useSyncExternalStore } from "react";
import { CodedApiError, apiRequestCoded } from "../lib/api";
import { availableLinesFromFreshRead, draftLinesFromFreshRead, validateFreshRead, type AvailableLine, type FreshReadFailure, type Watermark } from "./exchange-fresh-read";

// Cambios de prenda — estado de módulo que sobrevive a que la pestaña se desmonte, más un registro DURABLE y compartido por todas las
// pestañas del navegador (localStorage) de todo intento cuyo resultado se desconoce, y del último intento CONFIRMADO hasta que se reconcilia.
//
// Invariante: nunca se genera una idempotencyKey nueva para una venta si existe una posibilidad razonable de que un intento anterior
// haya sido confirmado.
//
// Por qué. POST /sales/:saleId/exchanges es idempotente por (venta, idempotencyKey). Si el envío queda incierto (corte de red, 5xx, un
// 401 en medio del vuelo, una recarga, una pestaña cerrada), el cambio PUDO haberse confirmado: el único modo seguro de resolverlo es
// repetir exactamente el mismo cuerpo con exactamente la misma clave. Perder la clave, o que dos pestañas fabriquen claves distintas
// para la misma venta, puede duplicar el cambio.
//
//   - navigator.locks es un REQUISITO DE SEGURIDAD, no una optimización. Sin él (contexto no seguro: http fuera de localhost; navegador
//     sin Web Locks) el store no genera claves, no escribe intentos y no envía: CONCURRENCY_GUARD_UNAVAILABLE. "Escribir y releer" no
//     excluye a otro proceso (otra pestaña puede escribir entre mi verificación y mi envío), así que no se ofrece como garantía.
//   - Lo durable es el INTENTO: una clave de storage por (userId, saleId) con userId, branchId, saleId, payload canónico, fingerprint,
//     idempotencyKey, status y los WATERMARKS por línea (ver exchange-fresh-read.ts). Nunca el token ni el borrador editable.
//   - La memoria de una pestaña NUNCA es autoridad: antes de generar o reusar una clave se relee el registro durable, dentro del lock
//     (userId, saleId). Hay UNCERTAIN -> misma clave y mismo payload. Hay un SENDING que esta pestaña no lanzó -> PENDING_ELSEWHERE.
//     Hay un CONFIRMED -> CONFIRMED_REQUIRES_REFRESH.
//   - CONFIRMED no borra la evidencia: deja un tombstone durable (clave, payload, fingerprint, exchangeId, confirmedAt, watermarks). Un
//     borrador viejo de otra pestaña, aunque no reciba el evento `storage`, lo encuentra al enviar. La única salida es
//     reconcileAfterFreshRead: el store hace él mismo GET /sales/exchangeable, comprueba que es de esta venta y sucursal y que YA muestra
//     el cambio confirmado (exchangedQuantity >= watermark por ítem), y recién entonces cierra el ciclo y abre un borrador nuevo.
//     reset() no sale de CONFIRMED ni de RESOLVED_ELSEWHERE.
//   - HIGH-WATER MARK durable por (userId, saleId): por ítem, la mayor exchangedQuantity que este cliente SABE confirmada. Sube al
//     confirmar un cambio (expectedExchangedQuantityAfter) y cuando una lectura fresca validada muestra más; nunca baja y NO se borra al
//     reconciliar. Antes de generar una clave nueva, prepare() exige baseline >= marca en cada línea: un borrador viejo de una pestaña que
//     perdió todos los eventos queda bloqueado (STALE_EXCHANGE_BASELINE) aunque el tombstone ya se haya cerrado. Una marca ilegible es
//     RECOVERY_REQUIRED, nunca "no hay marca". Reintentar un UNCERTAIN (misma clave) no se bloquea por la marca.
//   - El baseline (exchangedQuantityBefore) NO lo inventa la UI: sale de una lectura validada de GET /sales/exchangeable
//     (openDraftFromFreshRead / reconcileAfterFreshRead). La API productiva no tiene una forma de abrir un borrador con un baseline elegido.
//   - Si el registro durable existe pero no se puede leer con certeza (JSON roto, campo faltante, fingerprint que no coincide, payload o
//     watermarks inválidos, getItem que lanza), NO se interpreta como "sin intento": RECOVERY_REQUIRED. No se genera clave, no se envía,
//     no se edita y no hay salida dentro de la app (procedimiento operativo).
//   - Un evento `storage` de otra pestaña actualiza ésta; si el registro desaparece mientras esta pestaña lo tenía sin resolver, ya no
//     sabe si fue CONFIRMED o rechazado: RESOLVED_ELSEWHERE, y la salida es reconcileAfterFreshRead. Ese bloqueo vive sólo en memoria.
//   - Mientras el intento es SENDING/UNCERTAIN el payload está CONGELADO; el fingerprint cubre payload Y baseline, y cada envío lo
//     recalcula y se niega si no coincide con el del intento.
//   - settle() corre bajo el MISMO lock, relee el registro y sólo lo toca si todavía es de la clave que resuelve: una respuesta tardía
//     de una clave vieja nunca pisa una clave nueva ni un tombstone ajeno.
//   - Ni un 401/sessionExpired ni un logout explícito destruyen el intento (dropEditable sólo suelta lo editable). El intento queda
//     atado a su userId.
//   - Si el intento no se puede persistir, NO se envía (falla cerrado).
//   - El request lo lanza una acción del store, no un efecto del componente: si la pestaña se desmonta a mitad de vuelo la respuesta
//     se registra igual.
//
// Alcance de la garantía: Web Locks y localStorage son por origen y por perfil de navegador. Protegen a las pestañas de UN navegador.
// NO excluyen a dos perfiles, a dos dispositivos ni a dos usuarios del mismo navegador (cada uno tiene su propio registro); ahí la única
// defensa es el servidor (Sale FOR UPDATE + remanente), que sigue siendo la autoridad. Si el operador borra los datos del sitio, el
// registro se pierde. REJECTED borra el registro (no se confirmó nada).
//
// Marca por encima del servidor (P3-MARKNOEXIT-01): si la high-water mark local queda POR ENCIMA de lo que devuelve GET /sales/exchangeable,
// abrir y reconciliar fallan cerrado (READ_STALE; una marca ilegible es RECOVERY_REQUIRED) y NO hay recuperación automática. En operación
// normal no ocurre: exchangedQuantity es la suma de SaleExchangeLine y es monótona. Sí puede ocurrir si se resetea o restaura una base, si se
// reutiliza un saleId, o si alguien modifica la evidencia local a mano. La salida es un procedimiento operativo / de soporte (verificar la
// venta en el servidor y borrar la evidencia local de esa venta); NUNCA generar otra clave de forma automática. Sin tooling de soporte todavía.
//
// Límite documentado (aceptado): el cliente no distingue "nunca hubo intento" de "alguien borró toda la evidencia local". Cubre: datos del
// sitio / localStorage borrados mientras había una operación posiblemente confirmada, otro perfil, otro dispositivo, storage eliminado por
// el usuario o el navegador. Cualquier caso detectable dentro del MISMO storage y perfil sí se bloquea. El servidor es la autoridad final.

export const ATTEMPT_KEY_PREFIX = "mona-jacinta-exchange-attempt:v1:";
export const MARK_KEY_PREFIX = "mona-jacinta-exchange-mark:v1:";

const REASON_MAX = 200;
const LINES_MAX = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUANTITY = /^[1-9][0-9]{0,18}$/;
// A baseline may be 0 (nothing exchanged before); the watermark after it adds a returned quantity of up to 19 digits.
const BASELINE_QUANTITY = /^(0|[1-9][0-9]{0,18})$/;
const WATERMARK_QUANTITY = /^(0|[1-9][0-9]{0,19})$/;
// Definitive answers: the service refused BEFORE writing anything. Everything else (network, 5xx, 408/429, 401, CONCURRENCY_ERROR) may
// have committed and is UNCERTAIN.
const DEFINITIVE_STATUSES = new Set([400, 403, 404, 409, 410, 422]);

export type { AvailableLine, Watermark };

export type ExchangeLineDraft = {
  saleItemId: string;
  replacementVariantId: string | null;
  replacementLabel: string;
  returnQuantity: string;
  // What the read that opened the draft (GET /sales/exchangeable) said was ALREADY exchanged of this item. Never typed by a person.
  exchangedQuantityBefore: string;
};

export type CanonicalLine = { saleItemId: string; replacementVariantId: string; returnQuantity: string };
export type CanonicalPayload = { reason: string; lines: CanonicalLine[] };

export type AttemptStatus = "SENDING" | "UNCERTAIN" | "CONFIRMED" | "REJECTED";

export type ExchangeAttempt = {
  idempotencyKey: string;
  fingerprint: string;
  payload: CanonicalPayload;
  watermarks: Watermark[];
  status: AttemptStatus;
  errorCode: string | null;
  errorMessage: string | null;
  exchangeId: string | null;
  replayed: boolean;
  confirmedAt: number | null;
};

// Why the store refuses to decide for a sale. The future UI maps each one to its own message:
//   UNREADABLE / STORAGE_ERROR -> RECOVERY_REQUIRED          (no way out inside the app)
//   CONFIRMED                  -> CONFIRMED_REQUIRES_REFRESH (reconcileAfterFreshRead)
//   RESOLVED_ELSEWHERE         -> RESOLVED_ELSEWHERE         (reconcileAfterFreshRead)
//   STALE_BASELINE             -> STALE_EXCHANGE_BASELINE    (reconcileAfterFreshRead: the draft predates a confirmed exchange)
export type RecoveryReason = "UNREADABLE" | "STORAGE_ERROR" | "RESOLVED_ELSEWHERE" | "CONFIRMED" | "STALE_BASELINE";

export type ExchangeDraft = {
  userId: string;
  branchId: string;
  saleId: string;
  saleNumber: string;
  reason: string;
  lines: ExchangeLineDraft[];
  // The items of the sale this draft may add back (addLine), with the baseline and remainder the opening read gave. "" when unknown (a
  // draft rebuilt from a durable record).
  available: AvailableLine[];
  attempt: ExchangeAttempt | null;
  recovery: { reason: RecoveryReason } | null;
};

export type ExchangeEdit =
  | { type: "reason"; value: string }
  | { type: "addLine"; saleItemId: string }
  | { type: "removeLine"; saleItemId: string }
  | { type: "line"; saleItemId: string; replacementVariantId: string | null; replacementLabel: string; returnQuantity: string };

export type SendOutcome =
  | { kind: "CONFIRMED"; replayed: boolean; exchangeId: string | null }
  | { kind: "UNCERTAIN"; status: number | null; code: string | null; sessionExpired: boolean }
  | { kind: "REJECTED"; status: number | null; code: string | null; message: string };

export type ReconcileFailure = FreshReadFailure | "READ_FAILED" | "STATE_CHANGED" | "NOT_BLOCKED_BY_REFRESH" | "PERSIST_FAILED";
export type OpenFromReadResult = { ok: true; draft: ExchangeDraft } | { ok: false; reason: FreshReadFailure | "PERSIST_FAILED" };
export type ReconcileResult = { ok: true; draft: ExchangeDraft } | { ok: false; reason: ReconcileFailure; detail?: string | null };

// Codes the UI can switch on:
//   CONCURRENCY_GUARD_UNAVAILABLE  no navigator.locks: Exchange is unavailable in this browser or context (open the system over HTTPS)
//   PENDING_ELSEWHERE              another tab is sending this sale right now (transient)
//   RECOVERY_REQUIRED              the durable record cannot be trusted
//   CONFIRMED_REQUIRES_REFRESH     an exchange of this sale was confirmed: refresh before another one
//   RESOLVED_ELSEWHERE             another tab resolved the attempt this tab held: refresh before another one
//   STALE_EXCHANGE_BASELINE        this draft was opened before an exchange this client knows was confirmed: refresh
// plus NOT_FOUND, UNKNOWN_LINE, INCOMPLETE, BASELINE_MISSING, FROZEN, ALREADY_SENDING, FINGERPRINT_MISMATCH, PERSIST_FAILED.
export class ExchangeStoreError extends Error {
  readonly code: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "ExchangeStoreError";
    this.code = code;
  }
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
type RequestFn = (path: string, token: string | null, init: RequestInit) => Promise<unknown>;
// navigator.locks, reduced to what the store needs.
type LockManagerLike = { request<T>(name: string, callback: () => Promise<T> | T): Promise<T> };
// Resolved at the moment of use, so a browser whose lock manager appears (or not) after the module loaded is judged by what it has then.
type LocksDep = LockManagerLike | null | (() => LockManagerLike | null);

type PersistedStatus = "SENDING" | "UNCERTAIN" | "CONFIRMED";

type PersistedAttempt = {
  v: 1;
  userId: string;
  branchId: string;
  saleId: string;
  payload: CanonicalPayload;
  watermarks: Watermark[];
  fingerprint: string;
  idempotencyKey: string;
  status: PersistedStatus;
  // Only a CONFIRMED record (the tombstone) carries them.
  exchangeId: string | null;
  confirmedAt: number | null;
};

type Durable =
  | { kind: "none" }
  | { kind: "attempt"; record: PersistedAttempt }
  | { kind: "unreadable"; reason: "UNREADABLE" | "STORAGE_ERROR" };

export type ExchangeStoreSnapshot = { drafts: ExchangeDraft[] };

export const attemptStorageKey = (userId: string, saleId: string) => `${ATTEMPT_KEY_PREFIX}${encodeURIComponent(userId)}:${saleId.toLowerCase()}`;

export const markStorageKey = (userId: string, saleId: string) => `${MARK_KEY_PREFIX}${encodeURIComponent(userId)}:${saleId.toLowerCase()}`;

// One lock per (user, sale): prepare(), settle() and the reconciliation steps all queue on it.
export const exchangeLockName = (userId: string, saleId: string) => `mona-jacinta-exchange:${userId}:${saleId.toLowerCase()}`;

// The inverse of attemptStorageKey, for the start-up scan and for storage events. null when the key is not ours or not attributable.
function parseStorageKey(key: string): { userId: string; saleId: string } | null {
  if (!key.startsWith(ATTEMPT_KEY_PREFIX)) return null;
  const rest = key.slice(ATTEMPT_KEY_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  if (cut < 1) return null;
  const saleId = rest.slice(cut + 1);
  if (!UUID.test(saleId)) return null;
  try {
    return { userId: decodeURIComponent(rest.slice(0, cut)), saleId };
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactKeys = (value: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(value).sort();
  const expected = [...keys].sort();
  return own.length === expected.length && own.every((key, index) => key === expected[index]);
};
const isShortText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 128;

// The canonical request plus the baseline it was built on: same intent on the same read -> same text. Lines are sorted by saleItemId (the
// same canonicalisation as the server's request hash).
export function fingerprintOf(saleId: string, payload: CanonicalPayload, watermarks: Watermark[]) {
  return JSON.stringify({
    v: 2,
    saleId,
    reason: payload.reason,
    lines: payload.lines.map((line) => ({ saleItemId: line.saleItemId, replacementVariantId: line.replacementVariantId, returnQuantity: line.returnQuantity })),
    watermarks: watermarks.map((mark) => ({ saleItemId: mark.saleItemId, exchangedQuantityBefore: mark.exchangedQuantityBefore, expectedExchangedQuantityAfter: mark.expectedExchangedQuantityAfter })),
  });
}

// The payload to send, or null when the draft is not a complete, valid request. Ids are lowercased (one spelling per UUID).
export function canonicalPayloadOf(draft: Pick<ExchangeDraft, "reason" | "lines">): CanonicalPayload | null {
  const reason = draft.reason.trim();
  if (reason.length < 1 || reason.length > REASON_MAX) return null;
  if (draft.lines.length < 1 || draft.lines.length > LINES_MAX) return null;
  const lines: CanonicalLine[] = [];
  for (const line of draft.lines) {
    if (!UUID.test(line.saleItemId) || !line.replacementVariantId || !UUID.test(line.replacementVariantId) || !QUANTITY.test(line.returnQuantity)) return null;
    lines.push({ saleItemId: line.saleItemId.toLowerCase(), replacementVariantId: line.replacementVariantId.toLowerCase(), returnQuantity: line.returnQuantity });
  }
  lines.sort((a, b) => (a.saleItemId < b.saleItemId ? -1 : a.saleItemId > b.saleItemId ? 1 : 0));
  for (let index = 1; index < lines.length; index += 1) if (lines[index]!.saleItemId === lines[index - 1]!.saleItemId) return null;
  return { reason, lines };
}

// One watermark per payload line, in payload order: before (the baseline of the draft's line) and after = before + returned, in BigInt.
// null when any line has no valid baseline: that draft is not sendable.
export function canonicalWatermarksOf(draft: Pick<ExchangeDraft, "lines">, payload: CanonicalPayload): Watermark[] | null {
  const marks: Watermark[] = [];
  for (const line of payload.lines) {
    const source = draft.lines.find((candidate) => candidate.saleItemId.toLowerCase() === line.saleItemId);
    const before = source?.exchangedQuantityBefore;
    if (typeof before !== "string" || !BASELINE_QUANTITY.test(before)) return null;
    marks.push({ saleItemId: line.saleItemId, exchangedQuantityBefore: before, expectedExchangedQuantityAfter: (BigInt(before) + BigInt(line.returnQuantity)).toString() });
  }
  return marks;
}

function parseWatermarks(value: unknown, lines: CanonicalLine[]): Watermark[] | null {
  if (!Array.isArray(value) || value.length !== lines.length) return null;
  const marks: Watermark[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const mark = value[index];
    if (!isRecord(mark) || !hasExactKeys(mark, ["exchangedQuantityBefore", "expectedExchangedQuantityAfter", "saleItemId"])) return null;
    const { saleItemId, exchangedQuantityBefore, expectedExchangedQuantityAfter } = mark;
    if (saleItemId !== lines[index]!.saleItemId) return null;
    if (typeof exchangedQuantityBefore !== "string" || !BASELINE_QUANTITY.test(exchangedQuantityBefore)) return null;
    if (typeof expectedExchangedQuantityAfter !== "string" || !WATERMARK_QUANTITY.test(expectedExchangedQuantityAfter)) return null;
    if (BigInt(expectedExchangedQuantityAfter) !== BigInt(exchangedQuantityBefore) + BigInt(lines[index]!.returnQuantity)) return null;
    marks.push({ saleItemId, exchangedQuantityBefore, expectedExchangedQuantityAfter });
  }
  return marks;
}

// Strict reader of one persisted record: anything that is not exactly what this module wrote fails closed (null).
function parsePersisted(value: unknown): PersistedAttempt | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (status !== "SENDING" && status !== "UNCERTAIN" && status !== "CONFIRMED") return null;
  const baseKeys = ["branchId", "fingerprint", "idempotencyKey", "payload", "saleId", "status", "userId", "v", "watermarks"];
  if (!hasExactKeys(value, status === "CONFIRMED" ? [...baseKeys, "confirmedAt", "exchangeId"] : baseKeys)) return null;
  if (value.v !== 1) return null;
  if (!isShortText(value.userId) || !isShortText(value.branchId)) return null;
  if (typeof value.saleId !== "string" || !UUID.test(value.saleId)) return null;
  if (typeof value.idempotencyKey !== "string" || !UUID_V4.test(value.idempotencyKey)) return null;
  if (typeof value.fingerprint !== "string") return null;
  let exchangeId: string | null = null;
  let confirmedAt: number | null = null;
  if (status === "CONFIRMED") {
    if (typeof value.exchangeId !== "string" || !UUID.test(value.exchangeId)) return null;
    if (typeof value.confirmedAt !== "number" || !Number.isSafeInteger(value.confirmedAt) || value.confirmedAt <= 0) return null;
    exchangeId = value.exchangeId;
    confirmedAt = value.confirmedAt;
  }
  const payload = value.payload;
  if (!isRecord(payload) || !hasExactKeys(payload, ["lines", "reason"])) return null;
  if (typeof payload.reason !== "string" || payload.reason !== payload.reason.trim() || payload.reason.length < 1 || payload.reason.length > REASON_MAX) return null;
  if (!Array.isArray(payload.lines) || payload.lines.length < 1 || payload.lines.length > LINES_MAX) return null;
  const lines: CanonicalLine[] = [];
  for (const line of payload.lines) {
    if (!isRecord(line) || !hasExactKeys(line, ["replacementVariantId", "returnQuantity", "saleItemId"])) return null;
    const { saleItemId, replacementVariantId, returnQuantity } = line;
    if (typeof saleItemId !== "string" || !UUID.test(saleItemId) || saleItemId !== saleItemId.toLowerCase()) return null;
    if (typeof replacementVariantId !== "string" || !UUID.test(replacementVariantId) || replacementVariantId !== replacementVariantId.toLowerCase()) return null;
    if (typeof returnQuantity !== "string" || !QUANTITY.test(returnQuantity)) return null;
    lines.push({ saleItemId, replacementVariantId, returnQuantity });
  }
  for (let index = 1; index < lines.length; index += 1) if (lines[index]!.saleItemId <= lines[index - 1]!.saleItemId) return null;
  const watermarks = parseWatermarks(value.watermarks, lines);
  if (!watermarks) return null;
  const canonical: CanonicalPayload = { reason: payload.reason, lines };
  if (fingerprintOf(value.saleId, canonical, watermarks) !== value.fingerprint) return null;
  return {
    v: 1, userId: value.userId, branchId: value.branchId, saleId: value.saleId, payload: canonical, watermarks,
    fingerprint: value.fingerprint, idempotencyKey: value.idempotencyKey, status, exchangeId, confirmedAt,
  };
}

// Strict reader of the high-water mark: canonical decimal strings keyed by lowercase saleItemId, about exactly this user and sale.
function parseMark(value: unknown, userId: string, saleId: string): Map<string, string> | null {
  if (!isRecord(value) || !hasExactKeys(value, ["lines", "saleId", "userId", "v"])) return null;
  if (value.v !== 1 || value.userId !== userId || typeof value.saleId !== "string" || value.saleId !== saleId.toLowerCase()) return null;
  if (!isRecord(value.lines)) return null;
  const lines = new Map<string, string>();
  for (const [id, quantity] of Object.entries(value.lines)) {
    if (!UUID.test(id) || id !== id.toLowerCase() || typeof quantity !== "string" || !WATERMARK_QUANTITY.test(quantity)) return null;
    lines.set(id, quantity);
  }
  return lines.size === 0 ? null : lines;
}

function classifyFailure(cause: unknown): SendOutcome {
  if (cause instanceof CodedApiError) {
    if (cause.status === 401) return { kind: "UNCERTAIN", status: 401, code: cause.code, sessionExpired: true };
    if (cause.status !== null && DEFINITIVE_STATUSES.has(cause.status) && cause.code !== "CONCURRENCY_ERROR") {
      return { kind: "REJECTED", status: cause.status, code: cause.code, message: cause.message };
    }
    return { kind: "UNCERTAIN", status: cause.status, code: cause.code, sessionExpired: false };
  }
  return { kind: "UNCERTAIN", status: null, code: null, sessionExpired: false };
}

function classifySuccess(result: unknown): SendOutcome {
  if (isRecord(result) && typeof result.exchangeId === "string") {
    return { kind: "CONFIRMED", replayed: result.replayed === true, exchangeId: result.exchangeId };
  }
  // A 2xx the store cannot read: do not claim anything. Retrying with the same key replays the stored answer.
  return { kind: "UNCERTAIN", status: null, code: "UNREADABLE_RESPONSE", sessionExpired: false };
}

const guardUnavailable = () =>
  new ExchangeStoreError("CONCURRENCY_GUARD_UNAVAILABLE", "Cambios no está disponible en este navegador o contexto. Abrí el sistema mediante la URL segura HTTPS.");

type Mark = { kind: "none" } | { kind: "mark"; lines: Map<string, string> } | { kind: "unreadable"; reason: "UNREADABLE" | "STORAGE_ERROR" };

// What reconcileAfterFreshRead decided it was looking at, to be compared again once the GET came back.
type RefreshBasis = { kind: "tombstone"; record: PersistedAttempt } | { kind: "none"; watermarks: Watermark[] | null };
type RefreshInspection = { ok: true; basis: RefreshBasis; draft: ExchangeDraft } | { ok: false; reason: "NOT_BLOCKED_BY_REFRESH" | "STATE_CHANGED" };

type StoreDeps = { storage: StorageLike | null; request: RequestFn; newKey: () => string; locks?: LocksDep; now?: () => number };

function buildExchangeDraftStore(deps: StoreDeps) {
  const drafts = new Map<string, ExchangeDraft>();
  const inFlight = new Map<string, Promise<SendOutcome>>();
  // Keys this tab created, or adopted at start-up (where a SENDING record is, by definition, an outcome nobody saw). A SENDING record
  // whose key is NOT here belongs to a request another tab may still be running.
  const owned = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot: ExchangeStoreSnapshot = { drafts: [] };
  let loaded = false;
  const now = deps.now ?? (() => Date.now());

  const keyOf = (userId: string, saleId: string) => `${saleId.toLowerCase()}|${userId}`;

  function resolveLocks(): LockManagerLike | null {
    const locks = typeof deps.locks === "function" ? deps.locks() : (deps.locks ?? null);
    return locks && typeof locks.request === "function" ? locks : null;
  }

  function notify() {
    snapshot = { drafts: [...drafts.values()] };
    for (const listener of listeners) listener();
  }

  function put(draft: ExchangeDraft) {
    drafts.set(keyOf(draft.userId, draft.saleId), draft);
    notify();
  }

  // ---- the durable record ---------------------------------------------------------------------------------------------------------
  function readDurable(userId: string, saleId: string): Durable {
    if (!deps.storage) return { kind: "none" };
    let raw: string | null;
    try {
      raw = deps.storage.getItem(attemptStorageKey(userId, saleId));
    } catch {
      return { kind: "unreadable", reason: "STORAGE_ERROR" };
    }
    if (raw === null) return { kind: "none" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "unreadable", reason: "UNREADABLE" };
    }
    const record = parsePersisted(parsed);
    // A record filed under this key must be exactly about this user and this sale.
    if (!record || record.userId !== userId || record.saleId.toLowerCase() !== saleId.toLowerCase()) return { kind: "unreadable", reason: "UNREADABLE" };
    return { kind: "attempt", record };
  }

  function writeDurable(draft: ExchangeDraft, attempt: ExchangeAttempt, status: PersistedStatus): boolean {
    if (!deps.storage) return false;
    const base = {
      v: 1, userId: draft.userId, branchId: draft.branchId, saleId: draft.saleId, payload: attempt.payload, watermarks: attempt.watermarks,
      fingerprint: attempt.fingerprint, idempotencyKey: attempt.idempotencyKey, status,
    };
    const record = status === "CONFIRMED" ? { ...base, exchangeId: attempt.exchangeId, confirmedAt: attempt.confirmedAt } : base;
    try {
      deps.storage.setItem(attemptStorageKey(draft.userId, draft.saleId), JSON.stringify(record));
      return true;
    } catch {
      return false;
    }
  }

  function removeDurable(userId: string, saleId: string) {
    try {
      deps.storage?.removeItem(attemptStorageKey(userId, saleId));
    } catch {
      /* a stale record is safe: a reload recovers it as UNCERTAIN and the retry replays the same key */
    }
  }

  // ---- the high-water mark ---------------------------------------------------------------------------------------------------------
  function readMark(userId: string, saleId: string): Mark {
    if (!deps.storage) return { kind: "none" };
    let raw: string | null;
    try {
      raw = deps.storage.getItem(markStorageKey(userId, saleId));
    } catch {
      return { kind: "unreadable", reason: "STORAGE_ERROR" };
    }
    if (raw === null) return { kind: "none" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { kind: "unreadable", reason: "UNREADABLE" };
    }
    const lines = parseMark(parsed, userId, saleId);
    return lines ? { kind: "mark", lines } : { kind: "unreadable", reason: "UNREADABLE" };
  }

  // Raises the mark to max(current, value) per item; never lowers it, never writes over a mark it cannot read, never writes a value that
  // is not a canonical quantity. Returns whether the mark now covers every given value.
  function raiseMark(userId: string, saleId: string, values: Array<[string, string]>): boolean {
    if (!deps.storage) return false;
    const current = readMark(userId, saleId);
    if (current.kind === "unreadable") return false;
    const merged = new Map(current.kind === "mark" ? current.lines : []);
    let changed = current.kind === "none";
    for (const [id, quantity] of values) {
      if (!WATERMARK_QUANTITY.test(quantity)) return false;
      const key = id.toLowerCase();
      const known = merged.get(key);
      if (known === undefined || BigInt(quantity) > BigInt(known)) {
        merged.set(key, quantity);
        changed = true;
      }
    }
    if (merged.size === 0) return false;
    if (!changed) return true;
    try {
      deps.storage.setItem(markStorageKey(userId, saleId), JSON.stringify({ v: 1, userId, saleId: saleId.toLowerCase(), lines: Object.fromEntries(merged) }));
      return true;
    } catch {
      return false;
    }
  }

  // Is any of these (item, quantity) pairs OLDER than what the mark knows was confirmed?
  const olderThanMark = (mark: Mark, values: Array<[string, string]>) =>
    mark.kind === "mark" && values.some(([id, quantity]) => {
      const known = mark.lines.get(id.toLowerCase());
      return known !== undefined && BigInt(quantity) < BigInt(known);
    });

  function attemptFromRecord(record: PersistedAttempt, status: AttemptStatus): ExchangeAttempt {
    return {
      idempotencyKey: record.idempotencyKey, fingerprint: record.fingerprint, payload: record.payload, watermarks: record.watermarks, status,
      errorCode: null, errorMessage: null, exchangeId: record.exchangeId, replayed: false, confirmedAt: record.confirmedAt,
    };
  }

  function draftFromRecord(record: PersistedAttempt, status: AttemptStatus, previous?: ExchangeDraft): ExchangeDraft {
    const labels = new Map((previous?.lines ?? []).map((line) => [line.saleItemId.toLowerCase(), line.replacementLabel]));
    const before = new Map(record.watermarks.map((mark) => [mark.saleItemId, mark.exchangedQuantityBefore]));
    return {
      userId: record.userId, branchId: record.branchId, saleId: record.saleId, saleNumber: previous?.saleNumber ?? "",
      reason: record.payload.reason,
      lines: record.payload.lines.map((line) => ({
        saleItemId: line.saleItemId, replacementVariantId: line.replacementVariantId, returnQuantity: line.returnQuantity,
        replacementLabel: labels.get(line.saleItemId) ?? "", exchangedQuantityBefore: before.get(line.saleItemId) ?? "0",
      })),
      available: previous?.available?.length
        ? previous.available
        : record.watermarks.map((mark) => ({ saleItemId: mark.saleItemId, variantId: "", exchangedQuantityBefore: mark.exchangedQuantityBefore, remainingQuantity: "" })),
      attempt: attemptFromRecord(record, status),
      // A CONFIRMED attempt is a tombstone: the sale stays blocked until it is reconciled.
      recovery: status === "CONFIRMED" ? { reason: "CONFIRMED" } : null,
    };
  }

  function recoveryDraft(userId: string, saleId: string, reason: RecoveryReason, previous?: ExchangeDraft): ExchangeDraft {
    return {
      userId, branchId: previous?.branchId ?? "", saleId, saleNumber: previous?.saleNumber ?? "",
      reason: previous?.reason ?? "", lines: previous?.lines ?? [], available: previous?.available ?? [], attempt: previous?.attempt ?? null, recovery: { reason },
    };
  }

  // Lazy so that importing the module has no side effects (SSR, tests). Every SENDING/UNCERTAIN record found at start-up is an attempt
  // whose outcome this tab never saw: it comes back as UNCERTAIN and this tab adopts it. A tombstone comes back CONFIRMED (blocked). A key
  // that exists but cannot be trusted becomes a recovery draft.
  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    if (!deps.storage) return;
    const keys: string[] = [];
    try {
      for (let index = 0; index < deps.storage.length; index += 1) {
        const key = deps.storage.key(index);
        if (key && key.startsWith(ATTEMPT_KEY_PREFIX)) keys.push(key);
      }
    } catch {
      return; // cannot enumerate: openDraft/send re-read the exact key of the sale they are asked about, which is what protects the invariant
    }
    for (const key of keys) {
      const ids = parseStorageKey(key);
      if (!ids) continue;
      const durable = readDurable(ids.userId, ids.saleId);
      if (durable.kind === "attempt") {
        if (durable.record.status === "CONFIRMED") {
          drafts.set(keyOf(ids.userId, ids.saleId), draftFromRecord(durable.record, "CONFIRMED"));
        } else {
          owned.add(durable.record.idempotencyKey);
          drafts.set(keyOf(ids.userId, ids.saleId), draftFromRecord(durable.record, "UNCERTAIN"));
        }
      } else if (durable.kind === "unreadable") {
        drafts.set(keyOf(ids.userId, ids.saleId), recoveryDraft(ids.userId, ids.saleId, durable.reason));
      }
    }
    snapshot = { drafts: [...drafts.values()] };
  }

  function mustGet(userId: string, saleId: string) {
    ensureLoaded();
    const draft = drafts.get(keyOf(userId, saleId));
    if (!draft || draft.userId !== userId) throw new ExchangeStoreError("NOT_FOUND", "No hay un cambio en curso para esta venta.");
    return draft;
  }

  function recoveryError(draft: ExchangeDraft) {
    const reason = draft.recovery?.reason;
    if (reason === "CONFIRMED") return new ExchangeStoreError("CONFIRMED_REQUIRES_REFRESH", "Ya se confirmó un cambio de esta venta: releé la venta antes de iniciar otro.");
    if (reason === "RESOLVED_ELSEWHERE") return new ExchangeStoreError("RESOLVED_ELSEWHERE", "Otra pestaña resolvió el cambio de esta venta: releé la venta antes de iniciar otro.");
    if (reason === "STALE_BASELINE") return new ExchangeStoreError("STALE_EXCHANGE_BASELINE", "La venta cambió desde que se abrió este borrador: releé la venta antes de iniciar otro cambio.");
    return new ExchangeStoreError("RECOVERY_REQUIRED", `Hay un intento de cambio de esta venta pendiente de verificar (${reason ?? "?"}).`);
  }

  // ---- drafts -----------------------------------------------------------------------------------------------------------------------
  // NOT PART OF THE PRODUCTIVE API (createExchangeDraftStore does not expose it): opens a draft with lines and baselines chosen by the caller.
  // Tests need to build precise situations; production code opens drafts with openDraftFromFreshRead, where the baseline is derived.
  // Opening a sale always consults the durable record first: an existing attempt (even one made in another tab) wins over whatever
  // lines the caller brings, a tombstone blocks the sale until it is reconciled, and an unreadable record blocks the sale instead of
  // being read as "no attempt".
  function openDraftUnsafe(input: { userId: string; branchId: string; saleId: string; saleNumber: string; lines: ExchangeLineDraft[] }) {
    ensureLoaded();
    const key = keyOf(input.userId, input.saleId);
    const existing = drafts.get(key);
    if (existing) return existing;
    const durable = readDurable(input.userId, input.saleId);
    if (durable.kind === "attempt") {
      const draft = { ...draftFromRecord(durable.record, durable.record.status), saleNumber: input.saleNumber };
      put(draft);
      return draft;
    }
    if (durable.kind === "unreadable") {
      const draft = { ...recoveryDraft(input.userId, input.saleId, durable.reason), branchId: input.branchId, saleNumber: input.saleNumber };
      put(draft);
      return draft;
    }
    const draft: ExchangeDraft = {
      userId: input.userId, branchId: input.branchId, saleId: input.saleId, saleNumber: input.saleNumber,
      reason: "", lines: input.lines.map((line) => ({ ...line })),
      available: input.lines.map((line) => ({ saleItemId: line.saleItemId, variantId: "", exchangedQuantityBefore: line.exchangedQuantityBefore, remainingQuantity: "" })),
      attempt: null, recovery: null,
    };
    put(draft);
    return draft;
  }

  // The productive way to open a draft: from the raw body of GET /sales/exchangeable, which is validated here. Sale, branch, number, items,
  // variants, baseline (exchangedQuantity) and remainder all come from that body. It also raises the high-water mark to what the read shows
  // (and refuses a read OLDER than the mark). An existing attempt, tombstone or unreadable record wins over the read.
  async function openDraftFromFreshRead(input: { userId: string; branchId: string; saleNumber: string; read: unknown }): Promise<OpenFromReadResult> {
    if (!resolveLocks()) throw guardUnavailable();
    ensureLoaded();
    const { userId, branchId, saleNumber } = input;
    const verdict = validateFreshRead(input.read, { saleId: null, branchId, saleNumber, watermarks: null });
    if (!verdict.ok) return verdict;
    const read = verdict.read;
    const saleId = read.sale.id;
    const existing = drafts.get(keyOf(userId, saleId));
    if (existing) return { ok: true, draft: existing };
    return exclusive(exchangeLockName(userId, saleId), (): OpenFromReadResult => {
      const again = drafts.get(keyOf(userId, saleId));
      if (again) return { ok: true, draft: again };
      const durable = readDurable(userId, saleId);
      if (durable.kind === "attempt") {
        const draft = { ...draftFromRecord(durable.record, durable.record.status), saleNumber };
        put(draft);
        return { ok: true, draft };
      }
      const blockedBy = durable.kind === "unreadable" ? durable.reason : null;
      const mark = blockedBy ? null : readMark(userId, saleId);
      const markBlock = mark?.kind === "unreadable" ? mark.reason : null;
      if (blockedBy || markBlock) {
        const draft = { ...recoveryDraft(userId, saleId, (blockedBy ?? markBlock)!), branchId, saleNumber };
        put(draft);
        return { ok: true, draft };
      }
      const shown: Array<[string, string]> = read.lines.map((row) => [row.saleItemId, row.exchangedQuantity]);
      if (olderThanMark(mark!, shown)) return { ok: false, reason: "READ_STALE" };
      if (!raiseMark(userId, saleId, shown)) return { ok: false, reason: "PERSIST_FAILED" };
      const draft: ExchangeDraft = {
        userId, branchId, saleId, saleNumber, reason: "", lines: draftLinesFromFreshRead(read), available: availableLinesFromFreshRead(read), attempt: null, recovery: null,
      };
      put(draft);
      return { ok: true, draft };
    });
  }

  function edit(userId: string, saleId: string, change: ExchangeEdit) {
    const draft = mustGet(userId, saleId);
    if (draft.recovery) throw recoveryError(draft);
    const status = draft.attempt?.status;
    if (status === "SENDING" || status === "UNCERTAIN" || status === "CONFIRMED") {
      throw new ExchangeStoreError("FROZEN", "El cambio ya fue enviado: no se puede modificar.");
    }
    // A definitive rejection is over: editing starts a NEW intent, which will get a new key at its first send.
    const base: ExchangeDraft = status === "REJECTED" ? { ...draft, attempt: null } : draft;
    let next: ExchangeDraft;
    if (change.type === "reason") next = { ...base, reason: change.value };
    else if (change.type === "addLine") {
      // The baseline of an added line is the one the opening read gave for that item; the caller cannot bring one.
      const source = base.available.find((candidate) => candidate.saleItemId.toLowerCase() === change.saleItemId.toLowerCase());
      if (!source) throw new ExchangeStoreError("UNKNOWN_LINE", "Esa prenda no figura en la lectura de la venta.");
      const present = base.lines.some((line) => line.saleItemId.toLowerCase() === source.saleItemId.toLowerCase());
      next = present ? base : {
        ...base,
        lines: [...base.lines, { saleItemId: source.saleItemId, replacementVariantId: null, replacementLabel: "", returnQuantity: "", exchangedQuantityBefore: source.exchangedQuantityBefore }],
      };
    }
    else if (change.type === "removeLine") next = { ...base, lines: base.lines.filter((line) => line.saleItemId !== change.saleItemId) };
    else {
      next = {
        ...base,
        lines: base.lines.map((line) => (line.saleItemId === change.saleItemId
          ? { ...line, replacementVariantId: change.replacementVariantId, replacementLabel: change.replacementLabel, returnQuantity: change.returnQuantity }
          : line)),
      };
    }
    put(next);
  }

  // "Nuevo cambio" for a draft that was never sent, or was definitively rejected. It is NOT a way out of anything unresolved: an attempt
  // whose outcome is unknown, a confirmed one (tombstone), a draft resolved in another tab and a draft the store cannot decide about all
  // refuse. The way out of the last two kinds is reconcileAfterFreshRead.
  function reset(userId: string, saleId: string) {
    const draft = mustGet(userId, saleId);
    if (draft.recovery) throw recoveryError(draft);
    const status = draft.attempt?.status;
    if (status === "SENDING" || status === "UNCERTAIN") throw new ExchangeStoreError("FROZEN", "Hay un envío sin resolver para esta venta.");
    drafts.delete(keyOf(userId, saleId));
    notify();
  }

  // ---- sending ----------------------------------------------------------------------------------------------------------------------
  // Runs `fn` while holding the (user, sale) lock. There is no fallback: without navigator.locks, or if the lock cannot be granted, fn does
  // not run. Errors thrown BY fn are propagated as they are; failing to get the lock is CONCURRENCY_GUARD_UNAVAILABLE.
  async function exclusive<T>(name: string, fn: () => T): Promise<T> {
    const locks = resolveLocks();
    if (!locks) throw guardUnavailable();
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null as { ok: true; value: T } | { ok: false; error: unknown } | null;
    try {
      await locks.request(name, async () => {
        try {
          outcome = { ok: true, value: fn() };
        } catch (error) {
          outcome = { ok: false, error };
        }
      });
    } catch {
      throw guardUnavailable();
    }
    if (outcome === null) throw guardUnavailable();
    const settled: { ok: true; value: T } | { ok: false; error: unknown } = outcome;
    if (!settled.ok) throw settled.error;
    return settled.value;
  }

  function nextState(current: ExchangeDraft, outcome: SendOutcome): { attempt: ExchangeAttempt; recovery: ExchangeDraft["recovery"] } {
    const attempt = current.attempt!;
    if (outcome.kind === "CONFIRMED") {
      return {
        attempt: { ...attempt, status: "CONFIRMED", errorCode: null, errorMessage: null, exchangeId: outcome.exchangeId, replayed: outcome.replayed, confirmedAt: now() },
        recovery: { reason: "CONFIRMED" },
      };
    }
    if (outcome.kind === "REJECTED") return { attempt: { ...attempt, status: "REJECTED", errorCode: outcome.code, errorMessage: outcome.message }, recovery: null };
    return { attempt: { ...attempt, status: "UNCERTAIN", errorCode: outcome.code, errorMessage: null }, recovery: null };
  }

  // Runs under the (user, sale) lock. Re-reads the durable record and touches it ONLY while it is still the one of the attempt being
  // resolved (or gone): an answer that arrives late, for a key another tab has since replaced, never overwrites that tab's record.
  function settleLocked(key: string, idempotencyKey: string, outcome: SendOutcome) {
    const current = drafts.get(key);
    // Cleared meanwhile (clearAll): the answer must not resurrect the draft nor its durable record.
    if (!current || current.attempt?.idempotencyKey !== idempotencyKey) return;
    // A confirmation is knowledge whatever happened to the durable record meanwhile: the mark only rises (a late answer can never lower it,
    // and a mark that cannot be read is left alone). If this write fails the tombstone below still blocks the sale until it is reconciled,
    // and the reconciliation raises the mark again.
    if (outcome.kind === "CONFIRMED") raiseMark(current.userId, current.saleId, current.attempt.watermarks.map((mark) => [mark.saleItemId, mark.expectedExchangedQuantityAfter]));
    const durable = readDurable(current.userId, current.saleId);
    if (durable.kind === "unreadable") {
      put(recoveryDraft(current.userId, current.saleId, durable.reason, current));
      return;
    }
    if (durable.kind === "attempt" && (durable.record.idempotencyKey !== idempotencyKey || durable.record.status === "CONFIRMED")) {
      // Another key (or an already confirmed tombstone of this very key): not ours to modify. The tab follows what is durable.
      put(draftFromRecord(durable.record, durable.record.status, current));
      return;
    }
    const next = nextState(current, outcome);
    if (outcome.kind === "CONFIRMED") writeDurable(current, next.attempt, "CONFIRMED"); // if this fails the SENDING record stays: a reload recovers it as UNCERTAIN
    else if (outcome.kind === "UNCERTAIN") writeDurable(current, next.attempt, "UNCERTAIN"); // same
    else if (durable.kind === "attempt") removeDurable(current.userId, current.saleId);
    put({ ...current, attempt: next.attempt, recovery: next.recovery });
  }

  async function settle(key: string, userId: string, saleId: string, idempotencyKey: string, outcome: SendOutcome) {
    try {
      await exclusive(exchangeLockName(userId, saleId), () => settleLocked(key, idempotencyKey, outcome));
    } catch {
      // The lock vanished between the request and its answer: leave the durable record alone (the SENDING one stays and a reload recovers
      // it as UNCERTAIN) and only tell this tab what happened.
      const current = drafts.get(key);
      if (current?.attempt?.idempotencyKey === idempotencyKey) put({ ...current, ...nextState(current, outcome) });
    }
  }

  // The critical section, run under the (user, sale) lock: decide, from the DURABLE record, whether this tab may send and with which key;
  // write SENDING; verify it stuck.
  function prepare(userId: string, saleId: string): ExchangeAttempt {
    const current = drafts.get(keyOf(userId, saleId));
    if (!current) throw new ExchangeStoreError("NOT_FOUND", "No hay un cambio en curso para esta venta.");
    if (current.recovery) throw recoveryError(current);
    const payload = canonicalPayloadOf(current);
    if (!payload) throw new ExchangeStoreError("INCOMPLETE", "Completá el motivo y, en cada prenda, el reemplazo y la cantidad.");
    const watermarks = canonicalWatermarksOf(current, payload);
    if (!watermarks) throw new ExchangeStoreError("BASELINE_MISSING", "Falta la cantidad ya cambiada de una prenda: releé la venta.");
    const fingerprint = fingerprintOf(current.saleId, payload, watermarks);

    const held = current.attempt;
    // The only thing allowed after an unknown outcome: the SAME payload (and baseline) with the SAME key. Anything else must never reach the server.
    if (held?.status === "UNCERTAIN" && held.fingerprint !== fingerprint) {
      throw new ExchangeStoreError("FINGERPRINT_MISMATCH", "El cambio no coincide con el intento anterior.");
    }

    const durable = readDurable(userId, saleId);
    if (durable.kind === "unreadable") {
      const blocked = { ...current, recovery: { reason: durable.reason } };
      put(blocked);
      throw recoveryError(blocked);
    }
    let reuse: PersistedAttempt | null = null;
    if (durable.kind === "attempt") {
      const record = durable.record;
      if (record.status === "CONFIRMED") {
        // An exchange of this sale was confirmed (by this or another tab): no key, no request, until it is reconciled.
        const blocked = draftFromRecord(record, "CONFIRMED", current);
        put(blocked);
        throw recoveryError(blocked);
      }
      if (record.status === "SENDING" && !owned.has(record.idempotencyKey)) {
        throw new ExchangeStoreError("PENDING_ELSEWHERE", "Este cambio se está enviando en otra pestaña. Esperá o recargá la página.");
      }
      if (record.fingerprint !== fingerprint) throw new ExchangeStoreError("FINGERPRINT_MISMATCH", "El cambio no coincide con el intento pendiente de esta venta.");
      reuse = record;
    } else if (held?.status === "UNCERTAIN" || held?.status === "SENDING") {
      // This tab held an unresolved attempt and its durable record is gone: another tab resolved it, and CONFIRMED vs rejected is unknown.
      const blocked: ExchangeDraft = { ...current, attempt: null, recovery: { reason: "RESOLVED_ELSEWHERE" } };
      put(blocked);
      throw recoveryError(blocked);
    }

    if (!reuse) {
      // About to mint a NEW key: the baseline must not predate anything this client knows was confirmed. (A retry of an existing attempt
      // replays its own key and is exactly how an unknown outcome gets resolved: it is not subject to the mark.)
      const mark = readMark(userId, saleId);
      if (mark.kind === "unreadable") {
        const blocked = { ...current, recovery: { reason: mark.reason } };
        put(blocked);
        throw recoveryError(blocked);
      }
      if (olderThanMark(mark, watermarks.map((w) => [w.saleItemId, w.exchangedQuantityBefore]))) {
        const blocked: ExchangeDraft = { ...current, recovery: { reason: "STALE_BASELINE" } };
        put(blocked);
        throw recoveryError(blocked);
      }
    }

    const attempt: ExchangeAttempt = reuse
      ? attemptFromRecord(reuse, "SENDING")
      : { idempotencyKey: deps.newKey(), fingerprint, payload, watermarks, status: "SENDING", errorCode: null, errorMessage: null, exchangeId: null, replayed: false, confirmedAt: null };
    // The record must be on disk BEFORE the request leaves: a reload mid-flight, or another tab, has to find the key.
    if (!writeDurable(current, attempt, "SENDING")) throw new ExchangeStoreError("PERSIST_FAILED", "No se pudo guardar el intento en este navegador; no se envió el cambio.");
    const confirmed = readDurable(userId, saleId);
    if (confirmed.kind !== "attempt" || confirmed.record.idempotencyKey !== attempt.idempotencyKey) {
      // Belt and braces: under the lock nobody else writes this record, but if it did change we send nothing.
      throw new ExchangeStoreError("PENDING_ELSEWHERE", "Otra pestaña inició este cambio al mismo tiempo. Esperá o recargá la página.");
    }
    owned.add(attempt.idempotencyKey);
    put({ ...current, attempt });
    return attempt;
  }

  async function send({ userId, saleId, token }: { userId: string; saleId: string; token: string | null }): Promise<SendOutcome> {
    if (!resolveLocks()) throw guardUnavailable();
    const draft = mustGet(userId, saleId);
    const key = keyOf(userId, saleId);
    const running = inFlight.get(key);
    if (running) return running;
    if (draft.recovery) throw recoveryError(draft);
    if (draft.attempt?.status === "SENDING") throw new ExchangeStoreError("ALREADY_SENDING", "Este cambio se está enviando.");

    // The in-flight slot is taken before the first await, so a double submit in this tab is one request.
    const promise = (async (): Promise<SendOutcome> => {
      const attempt = await exclusive(exchangeLockName(userId, saleId), () => prepare(userId, saleId));
      const body = JSON.stringify({ reason: attempt.payload.reason, idempotencyKey: attempt.idempotencyKey, lines: attempt.payload.lines });
      let outcome: SendOutcome;
      try {
        outcome = classifySuccess(await deps.request(`/sales/${saleId}/exchanges`, token, { method: "POST", body }));
      } catch (cause) {
        outcome = classifyFailure(cause);
      }
      await settle(key, userId, saleId, attempt.idempotencyKey, outcome);
      return outcome;
    })();
    inFlight.set(key, promise);
    void promise.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      // Only forget OUR entry: after clearAll() a newer send on the same key may own the slot.
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
    return promise;
  }

  // ---- reconciliation after a fresh read ----------------------------------------------------------------------------------------------
  // The only way out of CONFIRMED and RESOLVED_ELSEWHERE. 1) under the lock: look at what blocks the sale (the tombstone, or nothing
  // durable). 2) with no lock held: GET /sales/exchangeable, which starts AFTER the tombstone was observed and the tombstone is written
  // after the server committed, so the read can only be older than the exchange if it is stale. 3) validate the body: this sale, this
  // branch, and per item at least the watermark. 4) under the lock again: the durable state must still be the one inspected in 1); then
  // remove the tombstone and open a new draft built from the read. Anything else leaves the sale blocked.
  function inspectForRefresh(userId: string, saleId: string): RefreshInspection {
    const draft = mustGet(userId, saleId);
    if (inFlight.has(keyOf(userId, saleId))) return { ok: false, reason: "NOT_BLOCKED_BY_REFRESH" };
    if (draft.recovery && (draft.recovery.reason === "UNREADABLE" || draft.recovery.reason === "STORAGE_ERROR")) throw recoveryError(draft);
    const durable = readDurable(userId, saleId);
    if (durable.kind === "unreadable") {
      const blocked = recoveryDraft(userId, saleId, durable.reason, draft);
      put(blocked);
      throw recoveryError(blocked);
    }
    if (durable.kind === "attempt") {
      if (durable.record.status === "CONFIRMED") return { ok: true, basis: { kind: "tombstone", record: durable.record }, draft };
      // A live attempt: nothing to refresh. The tab follows what is durable.
      put(draftFromRecord(durable.record, durable.record.status, draft));
      return { ok: false, reason: draft.recovery ? "STATE_CHANGED" : "NOT_BLOCKED_BY_REFRESH" };
    }
    if (!draft.recovery) return { ok: false, reason: "NOT_BLOCKED_BY_REFRESH" };
    if (draft.recovery.reason === "CONFIRMED") {
      // Blocked by a tombstone that is no longer durable (another tab already reconciled): the watermarks this tab holds still apply.
      if (!draft.attempt) return { ok: false, reason: "STATE_CHANGED" };
      return { ok: true, basis: { kind: "none", watermarks: draft.attempt.watermarks }, draft };
    }
    return { ok: true, basis: { kind: "none", watermarks: null }, draft };
  }

  const sameBasis = (a: RefreshBasis, b: RefreshBasis) => {
    if (a.kind === "tombstone" && b.kind === "tombstone") return a.record.idempotencyKey === b.record.idempotencyKey && a.record.confirmedAt === b.record.confirmedAt;
    return a.kind === "none" && b.kind === "none";
  };

  async function reconcileAfterFreshRead(input: { userId: string; saleId: string; branchId: string; saleNumber: string; token: string | null }): Promise<ReconcileResult> {
    if (!resolveLocks()) throw guardUnavailable();
    const { userId, saleId, branchId, saleNumber, token } = input;
    const lockName = exchangeLockName(userId, saleId);

    const first = await exclusive(lockName, () => inspectForRefresh(userId, saleId));
    if (!first.ok) return first;
    const watermarks = first.basis.kind === "tombstone" ? first.basis.record.watermarks : first.basis.watermarks;
    // The branch the attempt was made in, when the store knows it, is the only branch whose read can close it.
    const knownBranch = first.basis.kind === "tombstone" ? first.basis.record.branchId : first.draft.branchId;
    if (knownBranch && knownBranch !== branchId) return { ok: false, reason: "READ_MISMATCH" };

    let raw: unknown;
    try {
      raw = await deps.request(`/sales/exchangeable?branchId=${encodeURIComponent(branchId)}&saleNumber=${encodeURIComponent(saleNumber)}`, token, { method: "GET" });
    } catch (cause) {
      return { ok: false, reason: "READ_FAILED", detail: cause instanceof CodedApiError ? `${cause.status ?? ""} ${cause.code ?? ""}`.trim() : null };
    }
    const verdict = validateFreshRead(raw, { saleId, branchId, saleNumber, watermarks });
    if (!verdict.ok) return verdict;

    return exclusive(lockName, (): ReconcileResult => {
      const second = inspectForRefresh(userId, saleId);
      if (!second.ok || !sameBasis(first.basis, second.basis)) return { ok: false, reason: "STATE_CHANGED" };
      // The read must not be older than what this client knows was confirmed, and what it shows becomes part of that knowledge BEFORE the
      // tombstone goes away: from here on the mark, not the tombstone, is what remembers.
      const shown: Array<[string, string]> = verdict.read.lines.map((row) => [row.saleItemId, row.exchangedQuantity]);
      const mark = readMark(userId, saleId);
      if (mark.kind === "unreadable") {
        const blocked = recoveryDraft(userId, saleId, mark.reason, second.draft);
        put(blocked);
        throw recoveryError(blocked);
      }
      if (olderThanMark(mark, shown)) return { ok: false, reason: "READ_STALE" };
      if (!raiseMark(userId, saleId, shown)) return { ok: false, reason: "PERSIST_FAILED" };
      if (second.basis.kind === "tombstone") {
        removeDurable(userId, saleId);
        if (readDurable(userId, saleId).kind !== "none") return { ok: false, reason: "STATE_CHANGED" };
      }
      if (second.draft.attempt) owned.delete(second.draft.attempt.idempotencyKey);
      const draft: ExchangeDraft = {
        userId, branchId, saleId: second.draft.saleId, saleNumber, reason: "", lines: draftLinesFromFreshRead(verdict.read), available: availableLinesFromFreshRead(verdict.read), attempt: null, recovery: null,
      };
      put(draft);
      return { ok: true, draft };
    });
  }

  // ---- cross-tab ----------------------------------------------------------------------------------------------------------------------
  // Re-reads the durable record of one (user, sale) and brings this tab's memory in line with it. Called for `storage` events.
  function reconcile(userId: string, saleId: string) {
    const key = keyOf(userId, saleId);
    const draft = drafts.get(key);
    if (inFlight.has(key)) return; // this tab is the writer
    const durable = readDurable(userId, saleId);
    if (durable.kind === "attempt") {
      if (draft?.attempt?.idempotencyKey === durable.record.idempotencyKey && draft.attempt.status === durable.record.status) return;
      put(draftFromRecord(durable.record, durable.record.status, draft));
    } else if (durable.kind === "unreadable") {
      put(recoveryDraft(userId, saleId, durable.reason, draft));
    } else if (draft?.attempt && (draft.attempt.status === "SENDING" || draft.attempt.status === "UNCERTAIN")) {
      put({ ...draft, attempt: null, recovery: { reason: "RESOLVED_ELSEWHERE" } });
    }
    // A CONFIRMED draft whose tombstone disappeared stays blocked: only this tab's own reconcileAfterFreshRead lifts it.
  }

  function handleStorageEvent(key: string | null) {
    ensureLoaded();
    if (key === null) {
      // storage.clear() somewhere: everything this tab held unresolved is now unknown.
      for (const draft of [...drafts.values()]) reconcile(draft.userId, draft.saleId);
      return;
    }
    const ids = parseStorageKey(key);
    if (ids) reconcile(ids.userId, ids.saleId);
  }

  // ---- session ------------------------------------------------------------------------------------------------------------------------
  // !!! DESTRUCTIVE. Wipes memory AND every durable record: the attempts (SENDING / UNCERTAIN / CONFIRMED tombstones) and the high-water
  // marks. That is the local evidence of idempotency: after it, an exchange that may have been committed can be sent again with a NEW key.
  // It must not be used in any normal production flow, and today it has NO production caller (logout and session expiry use dropEditable,
  // which keeps the evidence). It is reserved for tests and explicit, supervised support procedures. Do not add callers.
  function clearAll() {
    ensureLoaded();
    drafts.clear();
    inFlight.clear();
    owned.clear();
    if (deps.storage) {
      try {
        const keys: string[] = [];
        for (let index = 0; index < deps.storage.length; index += 1) {
          const key = deps.storage.key(index);
          if (key && (key.startsWith(ATTEMPT_KEY_PREFIX) || key.startsWith(MARK_KEY_PREFIX))) keys.push(key);
        }
        for (const key of keys) deps.storage.removeItem(key);
      } catch {
        /* nothing more can be removed */
      }
    }
    notify();
  }

  // Logout or automatic session expiry: drop what is only an editable draft; keep every attempt whose outcome is unknown, every confirmed
  // one awaiting its refresh, and every sale the store cannot decide about (memory and durable record), so the same user can come back
  // and resolve it after logging in again.
  function dropEditable() {
    ensureLoaded();
    for (const [key, draft] of [...drafts.entries()]) {
      const status = draft.attempt?.status;
      if (status !== "SENDING" && status !== "UNCERTAIN" && status !== "CONFIRMED" && !draft.recovery) drafts.delete(key);
    }
    notify();
  }

  const api = {
    openDraftFromFreshRead,
    edit,
    reset,
    send,
    reconcileAfterFreshRead,
    clearAll,
    dropEditable,
    handleStorageEvent,
    // Whether this browser and context can run Exchange at all (navigator.locks present). The future UI shows the HTTPS message on UNAVAILABLE.
    getGuardStatus(): "AVAILABLE" | "UNAVAILABLE" {
      return resolveLocks() ? "AVAILABLE" : "UNAVAILABLE";
    },
    getDraft(userId: string, saleId: string): ExchangeDraft | null {
      ensureLoaded();
      const draft = drafts.get(keyOf(userId, saleId));
      return draft && draft.userId === userId ? draft : null;
    },
    getDrafts(userId: string): ExchangeDraft[] {
      ensureLoaded();
      return [...drafts.values()].filter((draft) => draft.userId === userId);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getSnapshot(): ExchangeStoreSnapshot {
      ensureLoaded();
      return snapshot;
    },
  };
  return { api, openDraftUnsafe };
}

// The productive store: drafts are opened only from a validated fresh read.
export function createExchangeDraftStore(deps: StoreDeps) {
  return buildExchangeDraftStore(deps).api;
}

// TESTS ONLY: the same store plus openDraftUnsafe (caller-chosen lines and baselines). Production code must not import this.
export function createExchangeDraftStoreForTests(deps: StoreDeps) {
  const { api, openDraftUnsafe } = buildExchangeDraftStore(deps);
  return { ...api, openDraftUnsafe };
}

export type ExchangeDraftStore = ReturnType<typeof createExchangeDraftStore>;

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

// navigator.locks exists only in secure contexts (HTTPS, or localhost). Anywhere else this is null and Exchange stays unavailable.
function browserLocks(): LockManagerLike | null {
  try {
    return typeof navigator !== "undefined" && navigator.locks
      ? { request: <T>(name: string, callback: () => Promise<T> | T) => navigator.locks.request(name, async () => await callback()) as Promise<T> }
      : null;
  } catch {
    return null;
  }
}

// The process-wide store the Cambios tab uses.
export const exchangeDrafts: ExchangeDraftStore = createExchangeDraftStore({
  storage: browserStorage(),
  request: apiRequestCoded,
  newKey: () => crypto.randomUUID(),
  locks: browserLocks,
});

// Another tab of this browser changed an attempt: bring this tab in line (the event never fires in the tab that wrote).
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => exchangeDrafts.handleStorageEvent(event.key));
}

const emptySnapshot: ExchangeStoreSnapshot = { drafts: [] };

// The drafts of ONE user. Another user's draft is never returned.
export function useExchangeDrafts(userId: string): ExchangeDraft[] {
  const snapshot = useSyncExternalStore(exchangeDrafts.subscribe, exchangeDrafts.getSnapshot, () => emptySnapshot);
  return useMemo(() => snapshot.drafts.filter((draft) => draft.userId === userId), [snapshot, userId]);
}
