import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { attemptStorageKey, canonicalPayloadOf, canonicalWatermarksOf, exchangeLockName, fingerprintOf } from "./exchange-draft-store";
import {
  ITEM_A, ITEM_B, OTHER, SALE, USER, build, coded, deferred, fill, flushMicrotasks, line, makeLocks, makeRecord, makeStorage, nonExcludingLocks, sendArgs, BRANCH, VAR_A, VAR_B,
} from "./exchange-store-test-harness";

// The concurrency guard of the exchange store. navigator.locks is a SAFETY requirement: without it the store never mints a key, never
// writes a new attempt and never sends (CONCURRENCY_GUARD_UNAVAILABLE). A write-then-reread fallback cannot exclude another process, so it
// is not offered as a guarantee. Also: the CONFIRMED tombstone, and settle() running under the same lock as prepare().

const noLocksInterleaving = (withLocks: ReturnType<typeof makeLocks> | typeof nonExcludingLocks | null) => {
  // Tab B reads "no record"; BEFORE B continues, tab A runs its whole send. This is the interleaving that two processes can produce.
  const data = new Map<string, string>();
  const storageA = makeStorage({}, data);
  const storageB = makeStorage({}, data);
  const tabA = build({ storage: storageA, locks: withLocks });
  const tabB = build({ storage: storageB, locks: withLocks });
  fill(tabA.store);
  fill(tabB.store);
  let outcomeA: Promise<unknown> = Promise.resolve();
  storageB.onGet = (_key, value) => {
    storageB.onGet = undefined;
    if (value === null) outcomeA = tabA.store.send(sendArgs).catch((error: unknown) => error);
  };
  const outcomeB = tabB.store.send(sendArgs).catch((error: unknown) => error);
  return { tabA, tabB, storageA, outcomeA: () => outcomeA, outcomeB };
};

describe("exchange store — navigator.locks is required (LOCK)", () => {
  it("LOCK-01 locks unavailable: send throws CONCURRENCY_GUARD_UNAVAILABLE and mints no key", async () => {
    const tab = build({ locks: null });
    fill(tab.store);
    expect(tab.store.getGuardStatus()).toBe("UNAVAILABLE");
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    expect(tab.newKey).not.toHaveBeenCalled();
  });

  it("LOCK-02 locks unavailable: nothing is fetched, not even the retry of an UNCERTAIN attempt", async () => {
    const storage = makeStorage();
    const first = build({ storage, handler: () => { throw coded(500, null); } });
    fill(first.store);
    await first.store.send(sendArgs);
    const noLocks = build({ storage, locks: null });
    await expect(noLocks.store.send(sendArgs)).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    expect(noLocks.request).not.toHaveBeenCalled();
    expect(noLocks.newKey).not.toHaveBeenCalled();

    const fresh = build({ locks: null });
    fill(fresh.store);
    await expect(fresh.store.send(sendArgs)).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    expect(fresh.request).not.toHaveBeenCalled();
  });

  it("LOCK-03 locks unavailable: no new SENDING record is written, and an existing record is left byte for byte as it was", async () => {
    const empty = makeStorage();
    const tab = build({ storage: empty, locks: null });
    fill(tab.store);
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    expect(empty.records()).toHaveLength(0);

    const storage = makeStorage();
    const first = build({ storage, handler: () => { throw coded(500, null); } });
    fill(first.store);
    await first.store.send(sendArgs);
    const before = storage.rawOf(attemptStorageKey(USER, SALE));
    const noLocks = build({ storage, locks: null });
    await expect(noLocks.store.send(sendArgs)).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    expect(storage.rawOf(attemptStorageKey(USER, SALE))).toBe(before);
  });

  it("LOCK-04 two stores without locks, even in the interleaving that used to fork the key, can never run a commercial send", async () => {
    const run = noLocksInterleaving(null);
    const [outcomeB, outcomeA] = [await run.outcomeB, await run.tabA.store.send(sendArgs).catch((error: unknown) => error)];
    expect(String(outcomeB)).toMatch(/CONCURRENCY_GUARD_UNAVAILABLE/);
    expect(String(outcomeA)).toMatch(/CONCURRENCY_GUARD_UNAVAILABLE/);
    expect(run.tabA.calls).toHaveLength(0);
    expect(run.tabB.calls).toHaveLength(0);
    expect(run.tabA.newKey).not.toHaveBeenCalled();
    expect(run.tabB.newKey).not.toHaveBeenCalled();
    expect(run.storageA.records()).toHaveLength(0);
  });

  it("LOCK-CONTROL a lock that excludes nothing DOES fork the key in that interleaving: the harness can see the race the lock closes", async () => {
    const run = noLocksInterleaving(nonExcludingLocks);
    await run.outcomeB;
    await run.outcomeA();
    await vi.waitFor(() => expect(run.tabA.calls.length + run.tabB.calls.length).toBe(2));
    expect(run.tabA.calls[0]!.body.idempotencyKey).not.toBe(run.tabB.calls[0]!.body.idempotencyKey);
  });

  it("LOCK-05 with real mutual exclusion the same interleaving yields ONE key and ONE request; the loser is blocked", async () => {
    const run = noLocksInterleaving(makeLocks());
    const outcomeB = await run.outcomeB;
    const results = [outcomeB, await run.outcomeA()]; // A's send starts inside B's critical section, so it exists only after B's started
    await vi.waitFor(() => expect(run.tabA.calls.length + run.tabB.calls.length).toBe(1));
    expect(run.tabA.newKey.mock.calls.length + run.tabB.newKey.mock.calls.length).toBe(1);
    expect(run.storageA.records()).toHaveLength(1);
    expect(results.filter((result) => result instanceof Error && /PENDING_ELSEWHERE/.test(result.message))).toHaveLength(1);
  });

  it("LOCK-05b two tabs, same sale, sent at once: exactly one attempt exists afterwards", async () => {
    const storage = makeStorage();
    const locks = makeLocks();
    const a = deferred();
    const b = deferred();
    const tabA = build({ storage, locks, handler: a.handler });
    const tabB = build({ storage, locks, handler: b.handler });
    fill(tabA.store);
    fill(tabB.store);
    const sends = Promise.allSettled([tabA.store.send(sendArgs), tabB.store.send(sendArgs)]);
    await vi.waitFor(() => expect(tabA.calls.length + tabB.calls.length).toBe(1));
    a.state.release({ exchangeId: randomUUID(), replayed: false });
    b.state.release({ exchangeId: randomUUID(), replayed: false });
    const results = await sends;
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(tabA.newKey.mock.calls.length + tabB.newKey.mock.calls.length).toBe(1);
    expect(storage.records()).toHaveLength(1);
    expect(tabA.calls.length + tabB.calls.length).toBe(1);
  });

  it("LOCK-06 an UNCERTAIN attempt with locks: any tab retries with the SAME key and the SAME body", async () => {
    const storage = makeStorage();
    const locks = makeLocks();
    const tabA = build({ storage, locks, handler: () => { throw coded(500, null); } });
    const tabB = build({ storage, locks });
    fill(tabA.store);
    fill(tabB.store); // B has its own editable copy, made before A sent
    await tabA.store.send(sendArgs);
    const key = tabA.calls[0]!.body.idempotencyKey;
    tabB.store.handleStorageEvent(attemptStorageKey(USER, SALE));
    expect((await tabB.store.send(sendArgs)).kind).toBe("CONFIRMED");
    expect(tabB.calls[0]!.body).toEqual({ ...tabA.calls[0]!.body, idempotencyKey: key });
    expect(tabB.newKey).not.toHaveBeenCalled();
  });

  it("LOCK-07 a lock manager that cannot grant the lock is the same as no lock: CONCURRENCY_GUARD_UNAVAILABLE, nothing sent", async () => {
    const rejecting = build({ locks: { request: () => Promise.reject(new Error("SecurityError")) } });
    fill(rejecting.store);
    await expect(rejecting.store.send(sendArgs)).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    const neverRuns = build({ locks: { request: () => Promise.resolve() as never } });
    fill(neverRuns.store);
    await expect(neverRuns.store.send(sendArgs)).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    for (const tab of [rejecting, neverRuns]) {
      expect(tab.request).not.toHaveBeenCalled();
      expect(tab.newKey).not.toHaveBeenCalled();
      expect(tab.storage.records()).toHaveLength(0);
    }
  });

  it("LOCK-08 the lock is per (user, sale): the lock name carries both", () => {
    expect(exchangeLockName(USER, SALE)).not.toBe(exchangeLockName(OTHER, SALE));
    expect(exchangeLockName(USER, SALE)).not.toBe(exchangeLockName(USER, randomUUID()));
    expect(exchangeLockName(USER, SALE.toUpperCase())).toBe(exchangeLockName(USER, SALE));
  });
});

describe("exchange store — the CONFIRMED tombstone (TOMB)", () => {
  it("TOMB-01 CONFIRMED leaves exactly the data needed to reconcile, including the watermarks and confirmedAt", async () => {
    const storage = makeStorage();
    const { store, calls } = build({ storage, now: () => 1_700_000_123_456 });
    fill(store);
    await store.send(sendArgs);
    const [record] = storage.records();
    expect(Object.keys(record!).sort()).toEqual(["branchId", "confirmedAt", "exchangeId", "fingerprint", "idempotencyKey", "payload", "saleId", "status", "userId", "v", "watermarks"]);
    expect(record).toMatchObject({ v: 1, userId: USER, branchId: BRANCH, saleId: SALE, status: "CONFIRMED", idempotencyKey: calls[0]!.body.idempotencyKey, confirmedAt: 1_700_000_123_456 });
    const expected = [
      { saleItemId: ITEM_A, exchangedQuantityBefore: "2", expectedExchangedQuantityAfter: "4" },
      { saleItemId: ITEM_B, exchangedQuantityBefore: "0", expectedExchangedQuantityAfter: "1" },
    ].sort((x, y) => (x.saleItemId < y.saleItemId ? -1 : 1));
    expect(record!.watermarks).toEqual(expected);
    expect(JSON.stringify(record)).not.toContain("secret-token");
  });

  it("TOMB-02 a tombstone (or any record) whose watermarks do not add up is unreadable: RECOVERY_REQUIRED, no key, no request", () => {
    const base = makeRecord({ status: "CONFIRMED" });
    const mutate = (change: (copy: Record<string, unknown>) => void) => { const copy = structuredClone(base) as Record<string, unknown>; change(copy); return JSON.stringify(copy); };
    const cases: Array<[string, string]> = [
      ["no exchangeId", mutate((r) => { delete r.exchangeId; })],
      ["no confirmedAt", mutate((r) => { delete r.confirmedAt; })],
      ["confirmedAt not a positive integer", mutate((r) => { r.confirmedAt = -5; })],
      ["exchangeId not a UUID", mutate((r) => { r.exchangeId = "x"; })],
      ["no watermarks", mutate((r) => { delete r.watermarks; })],
      ["watermark of another item", mutate((r) => { (r.watermarks as Array<Record<string, string>>)[0]!.saleItemId = randomUUID(); })],
      ["after != before + return", mutate((r) => { (r.watermarks as Array<Record<string, string>>)[0]!.expectedExchangedQuantityAfter = "3"; })],
      ["non canonical decimal", mutate((r) => { (r.watermarks as Array<Record<string, string>>)[0]!.exchangedQuantityBefore = "02"; })],
      ["a number instead of a string", mutate((r) => { (r.watermarks as Array<Record<string, unknown>>)[0]!.exchangedQuantityBefore = 2; })],
    ];
    for (const [name, value] of cases) {
      const storage = makeStorage({ [attemptStorageKey(USER, SALE)]: value });
      const tab = build({ storage });
      expect(tab.store.getDraft(USER, SALE)?.recovery, name).toEqual({ reason: "UNREADABLE" });
      expect(tab.request, name).not.toHaveBeenCalled();
      expect(tab.newKey, name).not.toHaveBeenCalled();
    }
    // a SENDING record must not carry tombstone fields
    const sending = makeStorage({ [attemptStorageKey(USER, SALE)]: JSON.stringify({ ...makeRecord({ status: "SENDING" }), confirmedAt: 1 }) });
    expect(build({ storage: sending }).store.getDraft(USER, SALE)?.recovery).toEqual({ reason: "UNREADABLE" });
  });

  it("TOMB-03 a tab that opens a sale with a tombstone gets a blocked draft: no edit, no reset, no send, no key", async () => {
    const storage = makeStorage({ [attemptStorageKey(USER, SALE)]: JSON.stringify(makeRecord({ status: "CONFIRMED" })) });
    const tab = build({ storage });
    tab.store.getSnapshot();
    const draft = tab.store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [line(ITEM_A, "2")] });
    expect(draft.recovery).toEqual({ reason: "CONFIRMED" });
    expect(draft.attempt).toMatchObject({ status: "CONFIRMED" });
    expect(() => tab.store.edit(USER, SALE, { type: "reason", value: "x" })).toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    expect(() => tab.store.reset(USER, SALE)).toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    expect(tab.request).not.toHaveBeenCalled();
    expect(tab.newKey).not.toHaveBeenCalled();
  });

  it("TOMB-04 a reload recovers the tombstone with its watermarks", async () => {
    const storage = makeStorage();
    const first = build({ storage });
    fill(first.store);
    await first.store.send(sendArgs);
    const reloaded = build({ storage });
    const draft = reloaded.store.getDraft(USER, SALE)!;
    expect(draft.attempt).toMatchObject({ status: "CONFIRMED", idempotencyKey: first.calls[0]!.body.idempotencyKey });
    expect(draft.attempt!.watermarks).toEqual(first.store.getDraft(USER, SALE)!.attempt!.watermarks);
    expect(draft.recovery).toEqual({ reason: "CONFIRMED" });
  });

  it("TOMB-05 another user does not see the tombstone and keeps their own record apart", async () => {
    const storage = makeStorage();
    const first = build({ storage });
    fill(first.store);
    await first.store.send(sendArgs);
    const other = build({ storage });
    expect(other.store.getDrafts(OTHER)).toEqual([]);
    const draft = other.store.openDraftUnsafe({ userId: OTHER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [] });
    expect(draft.recovery).toBeNull();
    expect(draft.attempt).toBeNull();
  });

  it("TOMB-06 if the tombstone cannot be written the SENDING record stays: a reload recovers it as UNCERTAIN and the retry replays the SAME key", async () => {
    const storage = makeStorage();
    const first = build({ storage, handler: () => { storage.failWrites = true; return { exchangeId: randomUUID(), replayed: false }; } });
    fill(first.store);
    expect((await first.store.send(sendArgs)).kind).toBe("CONFIRMED");
    storage.failWrites = false;
    expect(storage.records()[0]!.status).toBe("SENDING");
    const reloaded = build({ storage });
    expect(reloaded.store.getDraft(USER, SALE)!.attempt!.status).toBe("UNCERTAIN");
    await reloaded.store.send(sendArgs);
    expect(reloaded.calls[0]!.body.idempotencyKey).toBe(first.calls[0]!.body.idempotencyKey);
    expect(reloaded.newKey).not.toHaveBeenCalled();
  });

  it("TOMB-07 logout / session expiry keeps a CONFIRMED draft, and its tombstone, until it is reconciled", async () => {
    const storage = makeStorage();
    const { store } = build({ storage });
    fill(store);
    await store.send(sendArgs);
    store.dropEditable();
    expect(store.getDraft(USER, SALE)!.attempt!.status).toBe("CONFIRMED");
    expect(storage.records()[0]!.status).toBe("CONFIRMED");
  });
});

describe("exchange store — settle() runs under the lock and never overwrites another key (SETTLE)", () => {
  const sendAndHold = async (storage = makeStorage(), locks = makeLocks()) => {
    const gate = deferred();
    const tab = build({ storage, locks, handler: gate.handler });
    fill(tab.store);
    const pending = tab.store.send(sendArgs);
    await vi.waitFor(() => expect(tab.calls).toHaveLength(1));
    return { tab, gate, pending, storage, locks, key: tab.calls[0]!.body.idempotencyKey, durableKey: attemptStorageKey(USER, SALE) };
  };
  const foreign = (status: "SENDING" | "UNCERTAIN" | "CONFIRMED") => makeRecord({ status });

  it.each(["SENDING", "UNCERTAIN", "CONFIRMED"] as const)("SETTLE-01 a late answer of key A while the durable record is key B (%s): B is not modified", async (status) => {
    const held = await sendAndHold();
    const other = JSON.stringify(foreign(status));
    held.storage.put(held.durableKey, other);
    held.gate.state.release({ exchangeId: randomUUID(), replayed: false });
    expect((await held.pending).kind).toBe("CONFIRMED"); // the caller still learns what happened to ITS request
    expect(held.storage.rawOf(held.durableKey)).toBe(other);
  });

  it.each(["SENDING", "UNCERTAIN", "CONFIRMED"] as const)("SETTLE-02 a late CONFIRMED of key A neither deletes nor rewrites key B (%s)", async (status) => {
    const held = await sendAndHold();
    const other = JSON.stringify(foreign(status));
    held.storage.put(held.durableKey, other);
    held.gate.state.release({ exchangeId: randomUUID(), replayed: true });
    await held.pending;
    expect(held.storage.rawOf(held.durableKey)).toBe(other);
    expect(held.storage.records()).toHaveLength(1);
  });

  it.each(["SENDING", "UNCERTAIN", "CONFIRMED"] as const)("SETTLE-03 a late UNCERTAIN (and a late REJECTED) of key A does not overwrite key B (%s)", async (status) => {
    for (const failure of [coded(500, null), coded(409, "INSUFFICIENT_STOCK")]) {
      const held = await sendAndHold();
      const other = JSON.stringify(foreign(status));
      held.storage.put(held.durableKey, other);
      held.gate.state.fail(failure);
      await held.pending;
      expect(held.storage.rawOf(held.durableKey)).toBe(other);
    }
  });

  it("SETTLE-04 the same attempt completes normally: CONFIRMED -> tombstone, UNCERTAIN -> UNCERTAIN, REJECTED -> record removed", async () => {
    const confirmed = await sendAndHold();
    confirmed.gate.state.release({ exchangeId: randomUUID(), replayed: false });
    await confirmed.pending;
    expect(confirmed.storage.records()[0]).toMatchObject({ status: "CONFIRMED", idempotencyKey: confirmed.key });

    const uncertain = await sendAndHold();
    uncertain.gate.state.fail(coded(500, null));
    await uncertain.pending;
    expect(uncertain.storage.records()[0]).toMatchObject({ status: "UNCERTAIN", idempotencyKey: uncertain.key });

    const rejected = await sendAndHold();
    rejected.gate.state.fail(coded(409, "INSUFFICIENT_STOCK"));
    await rejected.pending;
    expect(rejected.storage.records()).toHaveLength(0);
  });

  it("SETTLE-05 an unreadable durable record at settle time is left alone and puts the tab in RECOVERY_REQUIRED", async () => {
    const held = await sendAndHold();
    held.storage.put(held.durableKey, "{{{");
    held.gate.state.release({ exchangeId: randomUUID(), replayed: false });
    await held.pending;
    expect(held.storage.rawOf(held.durableKey)).toBe("{{{");
    expect(held.tab.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "UNREADABLE" });
  });

  it("SETTLE-06 the durable record is gone: a CONFIRMED or UNCERTAIN answer restores the evidence, a REJECTED one writes nothing", async () => {
    const confirmed = await sendAndHold();
    confirmed.storage.removeItem(confirmed.durableKey);
    confirmed.gate.state.release({ exchangeId: randomUUID(), replayed: false });
    await confirmed.pending;
    expect(confirmed.storage.records()[0]).toMatchObject({ status: "CONFIRMED", idempotencyKey: confirmed.key });

    const uncertain = await sendAndHold();
    uncertain.storage.removeItem(uncertain.durableKey);
    uncertain.gate.state.fail(coded(500, null));
    await uncertain.pending;
    expect(uncertain.storage.records()[0]).toMatchObject({ status: "UNCERTAIN", idempotencyKey: uncertain.key });

    const rejected = await sendAndHold();
    rejected.storage.removeItem(rejected.durableKey);
    rejected.gate.state.fail(coded(409, "INSUFFICIENT_STOCK"));
    await rejected.pending;
    expect(rejected.storage.records()).toHaveLength(0);
  });

  it("SETTLE-07 settle waits for the (user, sale) lock: while another holder has it the SENDING record is untouched", async () => {
    const locks = makeLocks();
    const held = await sendAndHold(makeStorage(), locks);
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    const holder = locks.request(exchangeLockName(USER, SALE), () => gate);
    held.gate.state.release({ exchangeId: randomUUID(), replayed: false });
    await flushMicrotasks(); // everything that could run without the lock has run: settle must still be queued behind the holder
    expect(held.storage.records()[0]!.status).toBe("SENDING");
    openGate();
    await holder;
    expect((await held.pending).kind).toBe("CONFIRMED");
    expect(held.storage.records()[0]!.status).toBe("CONFIRMED");
  });

  it("FP-01 the fingerprint covers the baseline: a draft whose baseline was altered behind edit() cannot reuse the key of its attempt", async () => {
    const { store, calls } = build({ handler: () => { throw coded(500, null); } });
    fill(store);
    await store.send(sendArgs);
    store.getDraft(USER, SALE)!.lines[0]!.exchangedQuantityBefore = "7";
    await expect(store.send(sendArgs)).rejects.toThrow(/FINGERPRINT_MISMATCH/);
    expect(calls).toHaveLength(1);
  });

  it("FP-02 fingerprintOf differs when only a watermark differs, and edit() keeps the baseline of a line it changes", () => {
    const draft = { reason: "x", lines: [{ ...line(ITEM_A, "2"), replacementVariantId: VAR_A, returnQuantity: "1" }] };
    const payload = canonicalPayloadOf(draft)!;
    const marks = canonicalWatermarksOf(draft, payload)!;
    const other = canonicalWatermarksOf({ ...draft, lines: [{ ...draft.lines[0]!, exchangedQuantityBefore: "3" }] }, payload)!;
    expect(fingerprintOf(SALE, payload, marks)).not.toBe(fingerprintOf(SALE, payload, other));
    expect(marks).toEqual([{ saleItemId: ITEM_A, exchangedQuantityBefore: "2", expectedExchangedQuantityAfter: "3" }]);
    const { store } = build();
    store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [line(ITEM_A, "2")] });
    store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_B, replacementLabel: "x", returnQuantity: "1" });
    expect(store.getDraft(USER, SALE)!.lines[0]!.exchangedQuantityBefore).toBe("2");
  });
});
