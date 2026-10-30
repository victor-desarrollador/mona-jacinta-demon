import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ATTEMPT_KEY_PREFIX, attemptStorageKey, createExchangeDraftStoreForTests, ExchangeStoreError } from "./exchange-draft-store";
import {
  BRANCH, ITEM_A, ITEM_B, OTHER, SALE, TOKEN, USER, VAR_A, build, coded, fill, line, makeLocks, makeRequest, makeStorage, sendArgs,
} from "./exchange-store-test-harness";

// The exchange draft store: module-level state that survives the Cambios tab being unmounted, and a DURABLE, browser-wide (localStorage)
// record, one key per (userId, saleId), of any attempt whose outcome is unknown (SENDING / UNCERTAIN) so that a reload, a closed tab, an
// automatic 401 or a second tab can never lose or fork the idempotencyKey of an exchange that may already be committed. The editable draft
// itself lives in memory only. If the durable record cannot be read with certainty the store refuses (RECOVERY_REQUIRED): it never
// treats "I cannot tell" as "there was no attempt".



describe("exchange draft store — draft and first send", () => {
  it("EX-01 opening a draft twice keeps the first one and no key exists before the first send", () => {
    const { store, newKey } = build();
    fill(store);
    const first = store.getDraft(USER, SALE);
    store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [] });
    expect(store.getDraft(USER, SALE)).toBe(first);
    expect(first!.attempt).toBeNull();
    expect(newKey).not.toHaveBeenCalled();
  });

  it("EX-02 the first send persists SENDING BEFORE the request leaves, sends the canonical body, and never stores the token", async () => {
    let storedWhenRequested: string | null = null;
    const storage = makeStorage();
    const { store, calls } = build({ storage, handler: () => { storedWhenRequested = storage.raw(); return { exchangeId: randomUUID(), replayed: false }; } });
    fill(store);
    await store.send(sendArgs);
    expect(storedWhenRequested).not.toBeNull();
    expect(JSON.parse(storedWhenRequested!)[0].status).toBe("SENDING");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/sales/${SALE}/exchanges`);
    expect(calls[0]!.token).toBe(TOKEN);
    const { body } = calls[0]!;
    expect(body.reason).toBe("Cambio de talle");
    expect(body.lines.map((line) => line.saleItemId)).toEqual([ITEM_A, ITEM_B].sort());
    for (const line of body.lines) expect(typeof line.returnQuantity).toBe("string");
    expect(storage.all()).not.toContain(TOKEN);
  });

  it("EX-03 [persist 1] a SENDING attempt is persisted with exactly the data needed to recover it", async () => {
    const storage = makeStorage();
    let release: (value: unknown) => void = () => undefined;
    const { store, calls } = build({ storage, handler: () => new Promise((resolve) => { release = resolve; }) });
    fill(store);
    const pending = store.send(sendArgs);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    const [record] = JSON.parse(storage.raw()!);
    expect(Object.keys(record).sort()).toEqual(["branchId", "fingerprint", "idempotencyKey", "payload", "saleId", "status", "userId", "v", "watermarks"]);
    expect(record).toMatchObject({ v: 1, userId: USER, branchId: BRANCH, saleId: SALE, status: "SENDING", idempotencyKey: calls[0]!.body.idempotencyKey });
    expect(record.payload).toEqual({ reason: "Cambio de talle", lines: calls[0]!.body.lines });
    expect(store.getDraft(USER, SALE)!.attempt!.status).toBe("SENDING");
    release({ exchangeId: randomUUID(), replayed: false });
    await pending;
  });
});

describe("exchange draft store — outcomes", () => {
  it.each([
    ["network failure", () => { throw new TypeError("Failed to fetch"); }],
    ["500", () => { throw coded(500, null); }],
    ["409 CONCURRENCY_ERROR", () => { throw coded(409, "CONCURRENCY_ERROR"); }],
    ["429", () => { throw coded(429, "RATE_LIMITED"); }],
    ["a 2xx with an unreadable body", () => ({ nonsense: true })],
  ])("EX-04 [persist 2] %s leaves the attempt UNCERTAIN, persisted, with its key", async (_name, handler) => {
    const storage = makeStorage();
    const { store, calls } = build({ storage, handler });
    fill(store);
    const outcome = await store.send(sendArgs);
    expect(outcome.kind).toBe("UNCERTAIN");
    const attempt = store.getDraft(USER, SALE)!.attempt!;
    expect(attempt.status).toBe("UNCERTAIN");
    expect(attempt.idempotencyKey).toBe(calls[0]!.body.idempotencyKey);
    expect(JSON.parse(storage.raw()!)[0]).toMatchObject({ status: "UNCERTAIN", idempotencyKey: attempt.idempotencyKey });
  });

  it("EX-05 a 401 is UNCERTAIN (never lost), flagged sessionExpired, and stays persisted", async () => {
    const storage = makeStorage();
    const { store } = build({ storage, handler: () => { throw coded(401, null); } });
    fill(store);
    const outcome = await store.send(sendArgs);
    expect(outcome).toMatchObject({ kind: "UNCERTAIN", sessionExpired: true });
    expect(JSON.parse(storage.raw()!)[0].status).toBe("UNCERTAIN");
  });

  it("EX-06 payload frozen while SENDING or UNCERTAIN: every edit is refused", async () => {
    let release: (value: unknown) => void = () => undefined;
    const { store, calls } = build({ handler: () => new Promise((resolve) => { release = resolve; }) });
    fill(store);
    const pending = store.send(sendArgs);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(() => store.edit(USER, SALE, { type: "reason", value: "otro" })).toThrow(ExchangeStoreError);
    expect(() => store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_A, replacementLabel: "", returnQuantity: "1" })).toThrow(/FROZEN/);
    release({ exchangeId: randomUUID(), replayed: false });
    await pending;

    const uncertain = build({ handler: () => { throw coded(500, null); } });
    fill(uncertain.store);
    await uncertain.store.send(sendArgs);
    expect(() => uncertain.store.edit(USER, SALE, { type: "reason", value: "otro" })).toThrow(/FROZEN/);
    expect(uncertain.store.getDraft(USER, SALE)!.reason).toBe("  Cambio de talle  ");
  });

  it("EX-07 a retry after UNCERTAIN reuses the SAME key and the SAME body (one key per attempt)", async () => {
    let n = 0;
    const { store, calls, newKey } = build({ handler: () => { n += 1; if (n === 1) throw coded(500, null); return { exchangeId: randomUUID(), replayed: true }; } });
    fill(store);
    await store.send(sendArgs);
    const outcome = await store.send(sendArgs);
    expect(outcome).toEqual({ kind: "CONFIRMED", replayed: true, exchangeId: expect.any(String) });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toEqual(calls[0]!.body);
    expect(newKey).toHaveBeenCalledTimes(1);
  });

  it("EX-08 [persist 9] CONFIRMED (201 or replay 200) leaves a durable CONFIRMED tombstone and blocks a second send of the same attempt", async () => {
    const storage = makeStorage();
    const { store, calls } = build({ storage });
    fill(store);
    const outcome = await store.send(sendArgs);
    expect(outcome.kind).toBe("CONFIRMED");
    expect(storage.records()).toHaveLength(1);
    expect(storage.records()[0]).toMatchObject({ status: "CONFIRMED", idempotencyKey: calls[0]!.body.idempotencyKey });
    expect(store.getDraft(USER, SALE)!.attempt!.status).toBe("CONFIRMED");
    expect(store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "CONFIRMED" });
    await expect(store.send(sendArgs)).rejects.toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    expect(calls).toHaveLength(1);
    expect(() => store.edit(USER, SALE, { type: "reason", value: "otro" })).toThrow(/CONFIRMED_REQUIRES_REFRESH/);
  });

  it("EX-09 reset after CONFIRMED is refused: a new exchange of the sale needs reconcileAfterFreshRead, never a plain reset", async () => {
    const { store, calls, newKey } = build();
    fill(store);
    await store.send(sendArgs);
    expect(() => store.reset(USER, SALE)).toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    expect(store.getDraft(USER, SALE)!.attempt!.status).toBe("CONFIRMED");
    await expect(store.send(sendArgs)).rejects.toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    expect(calls).toHaveLength(1);
    expect(newKey).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["400", 400, "VALIDATION_ERROR"],
    ["403", 403, "FORBIDDEN"],
    ["404", 404, "NOT_FOUND"],
    ["409 INSUFFICIENT_STOCK", 409, "INSUFFICIENT_STOCK"],
    ["409 EXCHANGE_QUANTITY_EXCEEDED", 409, "EXCHANGE_QUANTITY_EXCEEDED"],
    ["409 REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED", 409, "REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED"],
  ])("EX-10 a definitive %s is REJECTED, clears the persisted record, and an edit afterwards earns a NEW key", async (_name, status, code) => {
    const storage = makeStorage();
    let n = 0;
    const { store, calls } = build({ storage, handler: () => { n += 1; if (n === 1) throw coded(status, code, "No se puede"); return { exchangeId: randomUUID(), replayed: false }; } });
    fill(store);
    const outcome = await store.send(sendArgs);
    expect(outcome).toMatchObject({ kind: "REJECTED", status, code });
    expect(storage.raw()).toBeNull();
    expect(store.getDraft(USER, SALE)!.attempt).toMatchObject({ status: "REJECTED", errorCode: code });
    store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_A, replacementLabel: "otra", returnQuantity: "1" });
    expect(store.getDraft(USER, SALE)!.attempt).toBeNull();
    await store.send(sendArgs);
    expect(calls[1]!.body.idempotencyKey).not.toBe(calls[0]!.body.idempotencyKey);
  });

  it("EX-11 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD is surfaced, never retried on its own", async () => {
    const { store, calls } = build({ handler: () => { throw coded(409, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"); } });
    fill(store);
    const outcome = await store.send(sendArgs);
    expect(outcome).toMatchObject({ kind: "REJECTED", code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" });
    expect(calls).toHaveLength(1);
  });

  it("EX-12 two concurrent sends of the same sale issue ONE request and share the outcome", async () => {
    let release: (value: unknown) => void = () => undefined;
    const { store, request } = build({ handler: () => new Promise((resolve) => { release = resolve; }) });
    fill(store);
    const a = store.send(sendArgs);
    const b = store.send(sendArgs);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    release({ exchangeId: randomUUID(), replayed: false });
    expect(await a).toEqual(await b);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("EX-13 the answer is recorded even if nobody is subscribed any more (tab switched away mid-request)", async () => {
    let release: (value: unknown) => void = () => undefined;
    const { store, calls } = build({ handler: () => new Promise((resolve) => { release = resolve; }) });
    fill(store);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    const pending = store.send(sendArgs);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    unsubscribe();
    release({ exchangeId: randomUUID(), replayed: false });
    await pending;
    expect(store.getDraft(USER, SALE)!.attempt!.status).toBe("CONFIRMED");
  });

  it("EX-14 an answer that arrives after an explicit logout does not resurrect the draft or its persisted record", async () => {
    const storage = makeStorage();
    let release: (value: unknown) => void = () => undefined;
    const { store, calls } = build({ storage, handler: () => new Promise((resolve) => { release = resolve; }) });
    fill(store);
    const pending = store.send(sendArgs);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    store.clearAll();
    release(Promise.reject(coded(500, null)));
    await pending.catch(() => undefined);
    expect(store.getDraft(USER, SALE)).toBeNull();
    expect(storage.raw()).toBeNull();
  });
});

describe("exchange draft store — guards", () => {
  it("EX-15 an incomplete draft is never sent", async () => {
    const { store, request } = build();
    store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [line(ITEM_A, "0")] });
    await expect(store.send(sendArgs)).rejects.toThrow(/INCOMPLETE/);
    store.edit(USER, SALE, { type: "reason", value: "motivo" });
    store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_A, replacementLabel: "x", returnQuantity: "0" });
    await expect(store.send(sendArgs)).rejects.toThrow(/INCOMPLETE/);
    store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_A, replacementLabel: "x", returnQuantity: "1.5" });
    await expect(store.send(sendArgs)).rejects.toThrow(/INCOMPLETE/);
    expect(request).not.toHaveBeenCalled();
  });

  it("EX-16 if the attempt cannot be persisted nothing is sent and no attempt is created (fail closed)", async () => {
    const storage = makeStorage();
    storage.failWrites = true;
    const { store, request } = build({ storage });
    fill(store);
    await expect(store.send(sendArgs)).rejects.toThrow(/PERSIST_FAILED/);
    expect(request).not.toHaveBeenCalled();
    expect(store.getDraft(USER, SALE)!.attempt).toBeNull();
  });

  it("EX-17 [payload != key] a draft altered behind the reducer's back cannot reuse the key of its attempt", async () => {
    const { store, calls } = build({ handler: () => { throw coded(500, null); } });
    fill(store);
    await store.send(sendArgs);
    store.getDraft(USER, SALE)!.lines[0]!.returnQuantity = "9"; // simulates a bug that bypasses edit()
    await expect(store.send(sendArgs)).rejects.toThrow(/FINGERPRINT_MISMATCH/);
    expect(calls).toHaveLength(1);
  });

  it("EX-18 a user cannot send or see another user's draft", async () => {
    const { store, request } = build();
    fill(store);
    expect(store.getDraft(OTHER, SALE)).toBeNull();
    expect(store.getDrafts(OTHER)).toEqual([]);
    await expect(store.send({ userId: OTHER, saleId: SALE, token: TOKEN })).rejects.toThrow(/NOT_FOUND/);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("exchange draft store — reload and session", () => {
  async function uncertainStore(storage = makeStorage()) {
    const first = build({ storage, handler: () => { throw coded(500, null); } });
    fill(first.store);
    await first.store.send(sendArgs);
    return { storage, first, key: first.calls[0]!.body.idempotencyKey, body: first.calls[0]!.body };
  }

  it("EX-19 [persist 3] a recreated store (page reload) recovers the same key, payload and branch for the same user", async () => {
    const { storage, key, body } = await uncertainStore();
    const reloaded = build({ storage });
    const draft = reloaded.store.getDraft(USER, SALE)!;
    expect(draft).toMatchObject({ userId: USER, branchId: BRANCH, saleId: SALE, reason: "Cambio de talle" });
    expect(draft.attempt).toMatchObject({ status: "UNCERTAIN", idempotencyKey: key });
    expect(draft.lines.map((line) => ({ saleItemId: line.saleItemId, replacementVariantId: line.replacementVariantId, returnQuantity: line.returnQuantity })))
      .toEqual(body.lines);
  });

  it("EX-20 a SENDING record found after a reload is recovered as UNCERTAIN (the outcome is unknown)", async () => {
    const storage = makeStorage();
    let release: (value: unknown) => void = () => undefined;
    const first = build({ storage, handler: () => new Promise((resolve) => { release = resolve; }) });
    fill(first.store);
    const pending = first.store.send(sendArgs);
    await vi.waitFor(() => expect(first.calls).toHaveLength(1));
    const reloaded = build({ storage });
    expect(reloaded.store.getDraft(USER, SALE)!.attempt!.status).toBe("UNCERTAIN");
    release({ exchangeId: randomUUID(), replayed: false });
    await pending;
  });

  it("EX-21 [persist 4] the recovered retry uses exactly the same key and body, and no new key is generated", async () => {
    const { storage, key, body } = await uncertainStore();
    const reloaded = build({ storage });
    const outcome = await reloaded.store.send(sendArgs);
    expect(outcome.kind).toBe("CONFIRMED");
    expect(reloaded.calls).toHaveLength(1);
    expect(reloaded.calls[0]!.body).toEqual({ ...body, idempotencyKey: key });
    expect(reloaded.newKey).not.toHaveBeenCalled();
    expect(storage.records()).toHaveLength(1);
    expect(storage.records()[0]).toMatchObject({ status: "CONFIRMED", idempotencyKey: key });
  });

  it("EX-22 [persist 5] a recovered attempt is frozen: its payload cannot change, so the key cannot meet another payload", async () => {
    const { storage } = await uncertainStore();
    const { store, request } = build({ storage });
    expect(() => store.edit(USER, SALE, { type: "reason", value: "otro" })).toThrow(/FROZEN/);
    expect(() => store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_A, replacementLabel: "", returnQuantity: "5" })).toThrow(/FROZEN/);
    expect(() => store.reset(USER, SALE)).toThrow(/FROZEN/);
    expect(request).not.toHaveBeenCalled();
  });

  it("EX-23 [persist 6] another user never sees, sends or reuses a recovered attempt", async () => {
    const { storage, key } = await uncertainStore();
    const { store, request } = build({ storage });
    expect(store.getDrafts(OTHER)).toEqual([]);
    expect(store.getDraft(OTHER, SALE)).toBeNull();
    await expect(store.send({ userId: OTHER, saleId: SALE, token: "other-token" })).rejects.toThrow(/NOT_FOUND/);
    expect(request).not.toHaveBeenCalled();
    expect(JSON.parse(storage.raw()!)[0]).toMatchObject({ userId: USER, idempotencyKey: key });
  });

  it("EX-24 [persist 7] an automatic session expiry keeps the UNCERTAIN attempt (memory and storage) and drops only editable drafts", async () => {
    const storage = makeStorage();
    const { store } = build({ storage, handler: () => { throw coded(500, null); } });
    fill(store);
    await store.send(sendArgs);
    const editableSale = randomUUID();
    store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: editableSale, saleNumber: "T-2", lines: [] });
    store.dropEditable();
    expect(store.getDraft(USER, editableSale)).toBeNull();
    expect(store.getDraft(USER, SALE)!.attempt!.status).toBe("UNCERTAIN");
    const reloaded = build({ storage });
    expect(reloaded.store.getDraft(USER, SALE)!.attempt!.status).toBe("UNCERTAIN");
  });

  // An explicit logout and an automatic expiry both go through dropEditable(): neither may destroy an attempt whose outcome is unknown,
  // because forgetting its key would let the operator send the same exchange again with a NEW key and, if units remain, exchange twice.
  it("EX-25 [logout] a logout during SENDING keeps the attempt; its answer is still recorded afterwards", async () => {
    const storage = makeStorage();
    let release: (value: unknown) => void = () => undefined;
    const { store, calls } = build({ storage, handler: () => new Promise((resolve) => { release = resolve; }) });
    fill(store);
    const pending = store.send(sendArgs);
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    store.dropEditable(); // what logout does
    expect(store.getDraft(USER, SALE)!.attempt!.status).toBe("SENDING");
    expect(JSON.parse(storage.raw()!)[0]).toMatchObject({ userId: USER, status: "SENDING", idempotencyKey: calls[0]!.body.idempotencyKey });
    release(Promise.reject(coded(500, null)));
    expect((await pending).kind).toBe("UNCERTAIN");
    expect(JSON.parse(storage.raw()!)[0].status).toBe("UNCERTAIN");
  });

  it("EX-27a [logout] a logout during UNCERTAIN keeps the attempt, and the same user recovers the SAME key and payload after a reload", async () => {
    const { storage, first, key, body } = await uncertainStore();
    first.store.dropEditable();
    const reloaded = build({ storage });
    expect(reloaded.store.getDraft(USER, SALE)!.attempt).toMatchObject({ status: "UNCERTAIN", idempotencyKey: key });
    await reloaded.store.send({ userId: USER, saleId: SALE, token: "token-after-login-again" });
    expect(reloaded.calls[0]!.body).toEqual({ ...body, idempotencyKey: key });
    expect(reloaded.newKey).not.toHaveBeenCalled();
  });

  it("EX-27b [logout] after a logout another user neither sees nor retries the attempt, and it stays the original user's", async () => {
    const { storage, first, key } = await uncertainStore();
    first.store.dropEditable();
    const other = build({ storage });
    expect(other.store.getDrafts(OTHER)).toEqual([]);
    await expect(other.store.send({ userId: OTHER, saleId: SALE, token: "other-token" })).rejects.toThrow(/NOT_FOUND/);
    expect(other.request).not.toHaveBeenCalled();
    expect(JSON.parse(storage.raw()!)[0]).toMatchObject({ userId: USER, idempotencyKey: key });
  });

  it("EX-27c [logout] after a logout the retry's CONFIRMED leaves the tombstone, and a definitive REJECTED clears the record", async () => {
    const confirmed = await uncertainStore();
    confirmed.first.store.dropEditable();
    const ok = build({ storage: confirmed.storage });
    expect((await ok.store.send(sendArgs)).kind).toBe("CONFIRMED");
    expect(confirmed.storage.records()[0]).toMatchObject({ status: "CONFIRMED", idempotencyKey: confirmed.key });

    const rejected = await uncertainStore();
    rejected.first.store.dropEditable();
    const refused = build({ storage: rejected.storage, handler: () => { throw coded(409, "INSUFFICIENT_STOCK"); } });
    expect((await refused.store.send(sendArgs)).kind).toBe("REJECTED");
    expect(rejected.storage.raw()).toBeNull();
  });

  it("EX-25b clearAll() is a full wipe that no production path calls (it is not what logout does)", async () => {
    const { storage, first } = await uncertainStore();
    first.store.clearAll();
    expect(first.store.getDraft(USER, SALE)).toBeNull();
    expect(storage.raw()).toBeNull();
    expect(build({ storage }).store.getDraft(USER, SALE)).toBeNull();
  });

  it("EX-26 the same user can re-authenticate and recover after a session expiry", async () => {
    const { storage } = await uncertainStore();
    const reloaded = build({ storage });
    reloaded.store.dropEditable(); // the 401 path
    const outcome = await reloaded.store.send({ userId: USER, saleId: SALE, token: "fresh-token-after-relogin" });
    expect(outcome.kind).toBe("CONFIRMED");
    expect(reloaded.calls[0]!.token).toBe("fresh-token-after-relogin");
  });
});

type Persisted = Record<string, unknown> & { payload: { reason: string; lines: Array<Record<string, unknown>> } };

// What the store must do when the durable record of (user, sale) exists but cannot be trusted: NOT "there was no attempt" but
// RECOVERY_REQUIRED, with no new key and no request.
describe("exchange draft store — a record it cannot trust fails closed (RECOVERY_REQUIRED)", () => {
  const good = async () => {
    const storage = makeStorage();
    const { store } = build({ storage, handler: () => { throw coded(500, null); } });
    fill(store);
    await store.send(sendArgs);
    return storage.records()[0] as Persisted;
  };
  const seeded = (value: string) => {
    const storage = makeStorage({ [attemptStorageKey(USER, SALE)]: value });
    return { ...build({ storage }), storage };
  };
  const openFresh = (store: ReturnType<typeof createExchangeDraftStoreForTests>) =>
    store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [{ ...line(ITEM_A, "0"), replacementVariantId: VAR_A, replacementLabel: "x", returnQuantity: "1" }] });

  it("EX-27 [EX-CROSS-05] unreadable or malformed durable data: recovery required, newKey = 0, fetch = 0, in both entry paths", async () => {
    const record = await good();
    const mutate = (change: (copy: Persisted) => void) => { const copy = structuredClone(record); change(copy); return JSON.stringify(copy); };
    const cases: Array<[string, string]> = [
      ["not JSON", "{{{"],
      ["an array", "[]"],
      ["null", "null"],
      ["a number", "1"],
      ["missing userId", mutate((r) => { delete r.userId; })],
      ["missing idempotencyKey", mutate((r) => { delete r.idempotencyKey; })],
      ["missing payload", mutate((r) => { delete (r as Record<string, unknown>).payload; })],
      ["missing fingerprint", mutate((r) => { delete r.fingerprint; })],
      ["unknown version", mutate((r) => { r.v = 2; })],
      ["status CONFIRMED without its exchangeId and confirmedAt", mutate((r) => { r.status = "CONFIRMED"; })],
      ["missing watermarks", mutate((r) => { delete r.watermarks; })],
      ["a watermark whose after is not before + return", mutate((r) => { (r.watermarks as Array<Record<string, string>>)[0]!.expectedExchangedQuantityAfter = "99"; })],
      ["watermarks for fewer lines than the payload", mutate((r) => { (r.watermarks as unknown[]).pop(); })],
      ["status garbage", mutate((r) => { r.status = "WHATEVER"; })],
      ["key that is not a UUID v4", mutate((r) => { r.idempotencyKey = "not-a-key"; })],
      ["saleId that is not a UUID", mutate((r) => { r.saleId = "../../x"; })],
      ["a record that belongs to another user", mutate((r) => { r.userId = "intruder"; })],
      ["a record that belongs to another sale", mutate((r) => { r.saleId = randomUUID(); })],
      ["payload altered after the fingerprint was taken", mutate((r) => { r.payload.lines[0]!.returnQuantity = "9"; })],
      ["reason altered", mutate((r) => { r.payload.reason = "otro"; })],
      ["quantity 0", mutate((r) => { r.payload.lines[0]!.returnQuantity = "0"; r.fingerprint = "x"; })],
      ["quantity as a JSON number", mutate((r) => { r.payload.lines[0]!.returnQuantity = 2; })],
      ["no lines", mutate((r) => { r.payload.lines = []; })],
      ["duplicate saleItemId", mutate((r) => { r.payload.lines[1]!.saleItemId = r.payload.lines[0]!.saleItemId; })],
      ["empty reason", mutate((r) => { r.payload.reason = ""; })],
    ];
    for (const [name, value] of cases) {
      // path 1: a fresh tab, found by the start-up scan
      const scanned = seeded(value);
      expect(scanned.store.getDraft(USER, SALE)?.recovery, `scan: ${name}`).toEqual({ reason: "UNREADABLE" });
      await expect(scanned.store.send(sendArgs), `scan: ${name}`).rejects.toThrow(/RECOVERY_REQUIRED/);
      // path 2: a tab that opens the sale
      const opened = seeded(value);
      opened.store.getSnapshot();
      const draft = openFresh(opened.store);
      expect(draft.recovery, `open: ${name}`).toEqual({ reason: "UNREADABLE" });
      expect(draft.attempt, name).toBeNull();
      await expect(opened.store.send(sendArgs), `open: ${name}`).rejects.toThrow(/RECOVERY_REQUIRED/);
      for (const tab of [scanned, opened]) {
        expect(tab.request, name).not.toHaveBeenCalled();
        expect(tab.newKey, name).not.toHaveBeenCalled();
      }
    }
  });

  it("EX-27a in recovery the draft is locked: no edit, no reset, no new attempt for that sale", () => {
    const { store } = seeded("{{{");
    openFresh(store);
    expect(() => store.edit(USER, SALE, { type: "reason", value: "x" })).toThrow(/RECOVERY_REQUIRED/);
    expect(() => store.reset(USER, SALE)).toThrow(/RECOVERY_REQUIRED/);
    expect(store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "UNREADABLE" });
  });

  it("EX-28 a valid record next to a corrupt one of ANOTHER sale is still recovered", async () => {
    const record = await good();
    const storage = makeStorage({
      [attemptStorageKey(USER, SALE)]: JSON.stringify(record),
      [attemptStorageKey(USER, randomUUID())]: "{{{",
    });
    const { store } = build({ storage });
    expect(store.getDraft(USER, SALE)!.attempt!.idempotencyKey).toBe(record.idempotencyKey);
    expect(store.getDrafts(USER).filter((draft) => draft.recovery)).toHaveLength(1);
  });

  it("EX-29 with no storage at all (SSR, blocked) the store works in memory but refuses to send", async () => {
    const { request } = makeRequest();
    const store = createExchangeDraftStoreForTests({ storage: null, request, newKey: () => randomUUID(), locks: makeLocks() });
    fill(store);
    await expect(store.send(sendArgs)).rejects.toThrow(/PERSIST_FAILED/);
    expect(request).not.toHaveBeenCalled();
  });
});

// The durable record is shared by every tab of the browser. A tab never mints a key without re-reading it first, and "tab A decided" is
// visible to tab B.
describe("exchange draft store — cross-tab (EX-CROSS)", () => {
  const deferredHandler = () => {
    const state = { release: (value: unknown): void => void value };
    const handler = () => new Promise((resolve) => { state.release = resolve; });
    return { state, handler };
  };

  it("EX-CROSS-01 two tabs send the same sale at once (navigator.locks): ONE new key, ONE request, the other tab is blocked", async () => {
    const storage = makeStorage();
    const locks = makeLocks();
    const a = deferredHandler();
    const b = deferredHandler();
    const tabA = build({ storage, locks, handler: a.handler });
    const tabB = build({ storage, locks, handler: b.handler });
    fill(tabA.store);
    fill(tabB.store);
    const sendA = tabA.store.send(sendArgs);
    const sendB = tabB.store.send(sendArgs);
    await expect(sendB).rejects.toThrow(/PENDING_ELSEWHERE/);
    await vi.waitFor(() => expect(tabA.calls).toHaveLength(1));
    expect(tabB.calls).toHaveLength(0);
    expect(tabA.newKey).toHaveBeenCalledTimes(1);
    expect(tabB.newKey).not.toHaveBeenCalled();
    expect(storage.records()).toHaveLength(1);
    a.state.release({ exchangeId: randomUUID(), replayed: false });
    expect((await sendA).kind).toBe("CONFIRMED");
  });

  it("EX-CROSS-02 tab A leaves the attempt UNCERTAIN; tab B opening the same sale finds it, mints nothing, and retries with A's key", async () => {
    const storage = makeStorage();
    const tabA = build({ storage, handler: () => { throw coded(500, null); } });
    const tabB = build({ storage });
    tabB.store.getSnapshot(); // B started (and scanned an empty storage) BEFORE A's attempt
    fill(tabA.store);
    await tabA.store.send(sendArgs);
    const key = tabA.calls[0]!.body.idempotencyKey;

    const draft = tabB.store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [] });
    expect(draft.attempt).toMatchObject({ status: "UNCERTAIN", idempotencyKey: key });
    expect(tabB.newKey).not.toHaveBeenCalled();
    expect((await tabB.store.send(sendArgs)).kind).toBe("CONFIRMED");
    expect(tabB.calls[0]!.body.idempotencyKey).toBe(key);
    expect(tabB.newKey).not.toHaveBeenCalled();
  });

  it("EX-CROSS-03 a tab that was closed and reopened (a recreated store) recovers the same key and payload from the durable record", async () => {
    const storage = makeStorage();
    const first = build({ storage, handler: () => { throw coded(500, null); } });
    fill(first.store);
    await first.store.send(sendArgs);
    const { idempotencyKey, payload } = first.store.getDraft(USER, SALE)!.attempt!;
    const reopened = build({ storage });
    expect(reopened.store.getDraft(USER, SALE)!.attempt).toMatchObject({ status: "UNCERTAIN", idempotencyKey, payload });
    await reopened.store.send(sendArgs);
    expect(reopened.calls[0]!.body.idempotencyKey).toBe(idempotencyKey);
    expect(reopened.newKey).not.toHaveBeenCalled();
  });

  it("EX-CROSS-04 another user neither sees nor reuses the attempt: its own record lives under its own key and the original stays intact", async () => {
    const storage = makeStorage();
    const owner = build({ storage, handler: () => { throw coded(500, null); } });
    fill(owner.store);
    await owner.store.send(sendArgs);
    const original = owner.store.getDraft(USER, SALE)!.attempt!.idempotencyKey;

    const other = build({ storage });
    expect(other.store.getDrafts(OTHER)).toEqual([]);
    expect(attemptStorageKey(OTHER, SALE)).not.toBe(attemptStorageKey(USER, SALE));
    const draft = other.store.openDraftUnsafe({ userId: OTHER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [] });
    expect(draft.attempt).toBeNull();
    expect(other.store.getDraft(OTHER, SALE)!.attempt).toBeNull();
    expect(storage.records().find((record) => record.userId === USER)!.idempotencyKey).toBe(original);
    expect(storage.keys().filter((key) => key.startsWith(ATTEMPT_KEY_PREFIX))).toHaveLength(1);
    expect(JSON.stringify(storage.all())).not.toContain(TOKEN);
  });

  it("EX-CROSS-06 getItem() throwing is RECOVERY_REQUIRED (from the start, or the moment it starts failing): newKey = 0, fetch = 0", async () => {
    const early = makeStorage();
    early.failReads = true;
    const tabEarly = build({ storage: early });
    const draft = tabEarly.store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [] });
    expect(draft.recovery).toEqual({ reason: "STORAGE_ERROR" });
    await expect(tabEarly.store.send(sendArgs)).rejects.toThrow(/RECOVERY_REQUIRED/);

    const storage = makeStorage();
    const tab = build({ storage });
    fill(tab.store);
    storage.failReads = true; // the storage becomes unreadable between editing and sending
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/RECOVERY_REQUIRED/);
    expect(tab.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "STORAGE_ERROR" });
    for (const t of [tabEarly, tab]) {
      expect(t.request).not.toHaveBeenCalled();
      expect(t.newKey).not.toHaveBeenCalled();
    }
  });

  it("EX-CROSS-07 setItem() failing before the request: fetch = 0 and no attempt exists", async () => {
    const storage = makeStorage();
    const tab = build({ storage });
    fill(tab.store);
    storage.failWrites = true;
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/PERSIST_FAILED/);
    expect(tab.request).not.toHaveBeenCalled();
    expect(tab.store.getDraft(USER, SALE)!.attempt).toBeNull();
    expect(storage.records()).toHaveLength(0);
  });

  it("EX-CROSS-08 a storage event announcing another tab's UNCERTAIN attempt updates this tab, which then mints no new key", async () => {
    const storage = makeStorage();
    const tabA = build({ storage, handler: () => { throw coded(500, null); } });
    const tabB = build({ storage });
    fill(tabA.store);
    fill(tabB.store); // B has its own editable copy
    const listener = vi.fn();
    tabB.store.subscribe(listener);
    await tabA.store.send(sendArgs);
    const key = tabA.calls[0]!.body.idempotencyKey;

    tabB.store.handleStorageEvent(attemptStorageKey(USER, SALE));
    expect(listener).toHaveBeenCalled();
    expect(tabB.store.getDraft(USER, SALE)!.attempt).toMatchObject({ status: "UNCERTAIN", idempotencyKey: key });
    expect(() => tabB.store.edit(USER, SALE, { type: "reason", value: "otro" })).toThrow(/FROZEN/);
    await tabB.store.send(sendArgs);
    expect(tabB.calls[0]!.body.idempotencyKey).toBe(key);
    expect(tabB.newKey).not.toHaveBeenCalled();
  });

  it("EX-CROSS-08b a storage event for a record that vanished while this tab held it unresolved: this tab must not mint a key, it must re-read the sale", async () => {
    const storage = makeStorage();
    const tabA = build({ storage, handler: () => { throw coded(500, null); } });
    const tabB = build({ storage });
    fill(tabA.store);
    await tabA.store.send(sendArgs);
    tabB.store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [] });
    expect(tabB.store.getDraft(USER, SALE)!.attempt!.status).toBe("UNCERTAIN");
    storage.removeItem(attemptStorageKey(USER, SALE)); // tab A confirmed (or was rejected) and cleaned up
    tabB.store.handleStorageEvent(attemptStorageKey(USER, SALE));
    expect(tabB.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "RESOLVED_ELSEWHERE" });
    await expect(tabB.store.send(sendArgs)).rejects.toThrow(/RESOLVED_ELSEWHERE/);
    expect(tabB.newKey).not.toHaveBeenCalled();
    // a plain reset is NOT the way out: only reconcileAfterFreshRead is (see the reconcile suite)
    expect(() => tabB.store.reset(USER, SALE)).toThrow(/RESOLVED_ELSEWHERE/);
    expect(tabB.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "RESOLVED_ELSEWHERE" });
  });

  it("EX-CROSS-08d the record vanished and this tab never got the event: send re-reads, finds nothing where it held an unresolved attempt, and refuses (no new key, no request)", async () => {
    const storage = makeStorage();
    const tabA = build({ storage, handler: () => { throw coded(500, null); } });
    const tabB = build({ storage });
    fill(tabA.store);
    await tabA.store.send(sendArgs);
    tabB.store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [] });
    storage.removeItem(attemptStorageKey(USER, SALE)); // resolved elsewhere, event missed
    await expect(tabB.store.send(sendArgs)).rejects.toThrow(/RESOLVED_ELSEWHERE/);
    expect(tabB.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "RESOLVED_ELSEWHERE" });
    expect(tabB.request).not.toHaveBeenCalled();
    expect(tabB.newKey).not.toHaveBeenCalled();
  });

  it("EX-CROSS-08c events about other keys, or about this tab's own in-flight attempt, change nothing", async () => {
    const storage = makeStorage();
    const a = deferredHandler();
    const tab = build({ storage, handler: a.handler });
    fill(tab.store);
    const sending = tab.store.send(sendArgs);
    await vi.waitFor(() => expect(tab.calls).toHaveLength(1));
    tab.store.handleStorageEvent("something-else");
    tab.store.handleStorageEvent(attemptStorageKey(USER, SALE));
    expect(tab.store.getDraft(USER, SALE)!.attempt!.status).toBe("SENDING");
    expect(tab.store.getDraft(USER, SALE)!.recovery).toBeNull();
    a.state.release({ exchangeId: randomUUID(), replayed: false });
    await sending;
  });

  it("EX-CROSS-09 CONFIRMED leaves a durable tombstone, so every tab that finds it is blocked until it reconciles", async () => {
    const storage = makeStorage();
    const tab = build({ storage });
    fill(tab.store);
    expect((await tab.store.send(sendArgs)).kind).toBe("CONFIRMED");
    expect(storage.records()).toHaveLength(1);
    expect(storage.records()[0]!.status).toBe("CONFIRMED");
    const other = build({ storage });
    expect(other.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "CONFIRMED" });
    await expect(other.store.send(sendArgs)).rejects.toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    expect(other.newKey).not.toHaveBeenCalled();
  });

  it("EX-CROSS-10 a definitive REJECTED clears the durable record, and only then does an edited intent get a different key", async () => {
    const storage = makeStorage();
    let n = 0;
    const tab = build({ storage, handler: () => { n += 1; if (n === 1) throw coded(409, "INSUFFICIENT_STOCK"); return { exchangeId: randomUUID(), replayed: false }; } });
    fill(tab.store);
    expect((await tab.store.send(sendArgs)).kind).toBe("REJECTED");
    expect(storage.records()).toHaveLength(0);
    tab.store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_A, replacementLabel: "otra", returnQuantity: "1" });
    await tab.store.send(sendArgs);
    expect(tab.calls[1]!.body.idempotencyKey).not.toBe(tab.calls[0]!.body.idempotencyKey);
    expect(tab.newKey).toHaveBeenCalledTimes(2);
  });

  it("EX-CROSS-11 same-tab double submit with locks still issues ONE request (the in-flight slot is taken before the first await)", async () => {
    const a = deferredHandler();
    const tab = build({ locks: makeLocks(), handler: a.handler });
    fill(tab.store);
    const first = tab.store.send(sendArgs);
    const second = tab.store.send(sendArgs);
    await vi.waitFor(() => expect(tab.request).toHaveBeenCalledTimes(1));
    a.state.release({ exchangeId: randomUUID(), replayed: false });
    expect(await first).toEqual(await second);
    expect(tab.request).toHaveBeenCalledTimes(1);
    expect(tab.newKey).toHaveBeenCalledTimes(1);
  });
});
