import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { CodedApiError } from "../lib/api";
import {
  ATTEMPT_KEY_PREFIX,
  markStorageKey,
  canonicalPayloadOf,
  canonicalWatermarksOf,
  createExchangeDraftStoreForTests,
  fingerprintOf,
  type ExchangeLineDraft,
} from "./exchange-draft-store";

// Shared fixtures for the exchange draft store tests: an in-memory localStorage that several "tabs" can share, a cooperative lock manager
// (navigator.locks semantics), a request double and the builders of valid durable records and of GET /sales/exchangeable bodies.

const ZERO = BigInt(0);

export const USER = "user-1";
export const OTHER = "user-2";
export const BRANCH = "branch-1";
export const SALE = randomUUID();
export const ITEM_A = randomUUID();
export const ITEM_B = randomUUID();
export const VAR_A = randomUUID();
export const VAR_B = randomUUID();
export const TOKEN = "secret-token-value-123";
export const sendArgs = { userId: USER, saleId: SALE, token: TOKEN };
export const reconcileArgs = { userId: USER, saleId: SALE, branchId: BRANCH, saleNumber: "T-1", token: TOKEN };

// What `fill` leaves in a draft: item A had 2 units exchanged before and gives back 2, item B had 0 and gives back 1.
export const BASELINE_A = "2";
export const BASELINE_B = "0";

export function makeStorage(initial: Record<string, string> = {}, shared?: Map<string, string>) {
  const data = shared ?? new Map(Object.entries(initial));
  const storage = {
    data,
    failWrites: false,
    failReads: false,
    onSet: undefined as undefined | ((key: string) => void),
    // Runs AFTER the value was read and BEFORE it is returned: the reader keeps the (by then stale) value it got.
    onGet: undefined as undefined | ((key: string, value: string | null) => void),
    get length() { return data.size; },
    key: (index: number) => [...data.keys()][index] ?? null,
    getItem(key: string) {
      if (storage.failReads) throw new Error("storage unavailable");
      const value = data.get(key) ?? null;
      storage.onGet?.(key, value);
      return value;
    },
    setItem(key: string, value: string) {
      if (storage.failWrites) throw new Error("quota exceeded");
      data.set(key, value);
      storage.onSet?.(key);
    },
    removeItem: (key: string) => void data.delete(key),
    put: (key: string, value: string) => void data.set(key, value),
    keys: () => [...data.keys()],
    recordKeys: () => [...data.keys()].filter((key) => key.startsWith(ATTEMPT_KEY_PREFIX)),
    records: () => [...data.entries()].filter(([key]) => key.startsWith(ATTEMPT_KEY_PREFIX)).map(([, value]) => JSON.parse(value) as Record<string, unknown>),
    raw: () => {
      const records = [...data.entries()].filter(([key]) => key.startsWith(ATTEMPT_KEY_PREFIX)).map(([, value]) => JSON.parse(value));
      return records.length === 0 ? null : JSON.stringify(records);
    },
    rawOf: (key: string) => data.get(key) ?? null,
    all: () => JSON.stringify([...data.entries()]),
  };
  return storage;
}

// A cooperative lock manager shared by "tabs": requests with the same name run one after the other (navigator.locks semantics).
export function makeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  return {
    request<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
      const previous = tails.get(name) ?? Promise.resolve();
      const run = previous.then(() => fn());
      tails.set(name, run.catch(() => undefined));
      return run;
    },
  };
}

// A "lock" that excludes nothing: the control that proves the interleaving tests are able to see the race they claim to close.
export const nonExcludingLocks = { request: <T>(_name: string, fn: () => Promise<T> | T): Promise<T> => Promise.resolve(fn()) };

export type Call = { path: string; token: string | null; body: { reason: string; idempotencyKey: string; lines: Array<Record<string, string>> } };
export type ReadCall = { path: string; token: string | null };

export function makeRequest(handler?: (call: Call, index: number) => Promise<unknown> | unknown, readHandler?: () => Promise<unknown> | unknown) {
  const calls: Call[] = [];
  const reads: ReadCall[] = [];
  const request = vi.fn(async (path: string, token: string | null, init: RequestInit) => {
    if (init.method === "GET") {
      reads.push({ path, token });
      if (!readHandler) throw new Error("no GET handler in this test");
      return readHandler();
    }
    const call: Call = { path, token, body: JSON.parse(String(init.body)) };
    calls.push(call);
    return handler ? handler(call, calls.length - 1) : { saleId: SALE, exchangeId: randomUUID(), replayed: false, lines: [] };
  });
  return { request, calls, reads };
}

type LocksOption = ReturnType<typeof makeLocks> | typeof nonExcludingLocks | { request: () => Promise<never> } | null;

export function build(options: {
  storage?: ReturnType<typeof makeStorage>;
  handler?: Parameters<typeof makeRequest>[0];
  read?: () => Promise<unknown> | unknown;
  locks?: LocksOption;
  now?: () => number;
} = {}) {
  const storage = options.storage ?? makeStorage();
  const { request, calls, reads } = makeRequest(options.handler, options.read);
  const newKey = vi.fn(() => randomUUID());
  const locks = options.locks === undefined ? makeLocks() : options.locks;
  const store = createExchangeDraftStoreForTests({ storage, request, newKey, locks: locks as never, ...(options.now ? { now: options.now } : {}) });
  return { store, storage, request, calls, reads, newKey };
}

export const line = (saleItemId: string, exchangedQuantityBefore: string): ExchangeLineDraft => ({
  saleItemId, replacementVariantId: null, replacementLabel: "", returnQuantity: "", exchangedQuantityBefore,
});

export function fill(store: ReturnType<typeof createExchangeDraftStoreForTests>, userId = USER) {
  store.openDraftUnsafe({ userId, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [line(ITEM_B, BASELINE_B), line(ITEM_A, BASELINE_A)] });
  store.edit(userId, SALE, { type: "reason", value: "  Cambio de talle  " });
  store.edit(userId, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_B, replacementLabel: "Remera L", returnQuantity: "2" });
  store.edit(userId, SALE, { type: "line", saleItemId: ITEM_B, replacementVariantId: VAR_A, replacementLabel: "Pantalón 42", returnQuantity: "1" });
}

// A one-line draft (item A) with an explicit baseline and return quantity, for the watermark tests.
export function fillOne(store: ReturnType<typeof createExchangeDraftStoreForTests>, before: string, returned: string) {
  store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [line(ITEM_A, before)] });
  store.edit(USER, SALE, { type: "reason", value: "Cambio de talle" });
  store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_B, replacementLabel: "Remera L", returnQuantity: returned });
}

export const coded = (status: number | null, code: string | null, message = "x") => new CodedApiError(message, status, code, null);

// A VALID durable record, as the store itself would have written it, for a draft shaped like `fill`'s.
export function makeRecord(options: { status?: "SENDING" | "UNCERTAIN" | "CONFIRMED"; key?: string; userId?: string; saleId?: string; confirmedAt?: number; exchangeId?: string } = {}) {
  const saleId = options.saleId ?? SALE;
  const lines = [
    { saleItemId: ITEM_A, replacementVariantId: VAR_B, replacementLabel: "", returnQuantity: "2", exchangedQuantityBefore: BASELINE_A },
    { saleItemId: ITEM_B, replacementVariantId: VAR_A, replacementLabel: "", returnQuantity: "1", exchangedQuantityBefore: BASELINE_B },
  ];
  const draft = { reason: "Cambio de talle", lines };
  const payload = canonicalPayloadOf(draft)!;
  const watermarks = canonicalWatermarksOf(draft, payload)!;
  const status = options.status ?? "SENDING";
  return {
    v: 1, userId: options.userId ?? USER, branchId: BRANCH, saleId, payload, watermarks,
    fingerprint: fingerprintOf(saleId, payload, watermarks), idempotencyKey: options.key ?? randomUUID(), status,
    ...(status === "CONFIRMED" ? { exchangeId: options.exchangeId ?? randomUUID(), confirmedAt: options.confirmedAt ?? 1_700_000_000_000 } : {}),
  };
}

// A GET /sales/exchangeable body for the sale of `fill`. `exchanged` is what the read shows as already exchanged, per item.
export function freshRead(options: {
  exchanged?: { a?: string; b?: string };
  quantity?: { a?: string; b?: string };
  saleId?: string;
  branchId?: string;
  saleNumber?: string;
  status?: string;
  exchangeable?: boolean;
  items?: string[];
} = {}) {
  const quantity = { a: options.quantity?.a ?? "10", b: options.quantity?.b ?? "5" };
  // After `fill` confirmed: A 2 (before) + 2 = 4, B 0 + 1 = 1.
  const exchanged = { a: options.exchanged?.a ?? "4", b: options.exchanged?.b ?? "1" };
  const row = (saleItemId: string, q: string, e: string) => {
    const remaining = BigInt(q) > BigInt(e) ? BigInt(q) - BigInt(e) : ZERO;
    return { saleItemId, variantId: randomUUID(), productName: "Remera", variantName: "M", sku: "SKU", quantity: q, unitPrice: "1000", exchangedQuantity: e, remainingQuantity: remaining.toString() };
  };
  const all: Record<string, ReturnType<typeof row>> = { [ITEM_A]: row(ITEM_A, quantity.a, exchanged.a), [ITEM_B]: row(ITEM_B, quantity.b, exchanged.b) };
  const ids = options.items ?? [ITEM_A, ITEM_B];
  return {
    sale: { id: options.saleId ?? SALE, saleNumber: options.saleNumber ?? "T-1", branchId: options.branchId ?? BRANCH, status: options.status ?? "COMPLETED", pricingMode: "RETAIL", priceMode: "RETAIL", total: "9000" },
    exchangeable: options.exchangeable ?? true,
    lines: ids.map((id) => all[id] ?? row(id, "3", "0")),
  };
}

export const deferred = () => {
  const state = { release: (value: unknown): void => void value, fail: (error: unknown): void => void error };
  const handler = () => new Promise((resolve, reject) => { state.release = resolve; state.fail = reject; });
  return { state, handler };
};

// The durable high-water mark of (user, sale): the highest exchangedQuantity per item this client KNOWS was confirmed.
export const markRecord = (lines: Record<string, string>, who: { userId?: string; saleId?: string } = {}) =>
  JSON.stringify({ v: 1, userId: who.userId ?? USER, saleId: (who.saleId ?? SALE).toLowerCase(), lines });
export const readMarkLines = (storage: ReturnType<typeof makeStorage>, userId = USER, saleId = SALE) => {
  const raw = storage.rawOf(markStorageKey(userId, saleId));
  return raw === null ? null : (JSON.parse(raw) as { lines: Record<string, string> }).lines;
};

// A send whose POST is parked until the test says so. `entered` resolves exactly when the request has LEFT (so SENDING is persisted and the
// lock is free); `release` / `fail` then decide how it ends. No timers: the test controls when A enters, what happens meanwhile, and when A goes on.
export function parkedSend(storage: ReturnType<typeof makeStorage>, options: { locks?: LocksOption } = {}) {
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = deferred();
  const tab = build({ storage, ...options, handler: () => { enter(); return gate.handler(); } });
  return { tab, entered, release: (value: unknown) => gate.state.release(value), fail: (error: unknown) => gate.state.fail(error) };
}

// Lets every already-queued microtask (and what they queue) run, with no timers.
export const flushMicrotasks = async (rounds = 100) => {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
};
