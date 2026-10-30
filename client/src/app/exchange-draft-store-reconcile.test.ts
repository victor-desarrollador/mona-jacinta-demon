import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attemptStorageKey } from "./exchange-draft-store";
import {
  BRANCH, ITEM_A, ITEM_B, SALE, USER, VAR_A, build, coded, fill, fillOne, freshRead, line, makeLocks, makeRecord, makeStorage, reconcileArgs, sendArgs,
} from "./exchange-store-test-harness";

// A sale with a CONFIRMED tombstone (or a RESOLVED_ELSEWHERE draft) accepts a new exchange only through reconcileAfterFreshRead: the store
// itself GETs /sales/exchangeable, checks it is about this sale and branch, checks it already SHOWS the confirmed exchange (the per-item
// watermark), and only then closes the previous cycle. A plain reset() never does.

const confirmedWith = async (fillWith: (store: ReturnType<typeof build>["store"]) => void = (store) => fill(store)) => {
  const storage = makeStorage();
  const locks = makeLocks();
  const first = build({ storage, locks });
  fillWith(first.store);
  await first.store.send(sendArgs);
  const key = first.calls[0]!.body.idempotencyKey;
  return { storage, locks, key, durableKey: attemptStorageKey(USER, SALE) };
};

describe("exchange store — a stale tab cannot start another exchange (STALE)", () => {
  it("STALE-01 tab B holds an old editable draft, A confirms, B never gets the storage event: B's send mints nothing and sends nothing", async () => {
    const storage = makeStorage();
    const locks = makeLocks();
    const tabA = build({ storage, locks });
    const tabB = build({ storage, locks });
    fill(tabA.store);
    fill(tabB.store); // B's editable copy, made before A sent
    await tabA.store.send(sendArgs);
    expect(storage.records()[0]!.status).toBe("CONFIRMED");
    await expect(tabB.store.send(sendArgs)).rejects.toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    expect(tabB.newKey).not.toHaveBeenCalled();
    expect(tabB.request).not.toHaveBeenCalled();
    expect(tabB.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "CONFIRMED" });
  });

  it("STALE-02 a tab that re-reads the durable record finds the tombstone and is blocked, by openDraft and by send", async () => {
    const { storage, locks } = await confirmedWith();
    const tab = build({ storage, locks });
    expect(tab.store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [line(ITEM_A, "4")] }).recovery).toEqual({ reason: "CONFIRMED" });
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    expect(tab.newKey).not.toHaveBeenCalled();
  });

  it("STALE-03 a plain reset() enables nothing, after CONFIRMED and after RESOLVED_ELSEWHERE", async () => {
    const { storage, locks, durableKey } = await confirmedWith();
    const tab = build({ storage, locks });
    expect(() => tab.store.reset(USER, SALE)).toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    tab.store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [] });
    expect(() => tab.store.reset(USER, SALE)).toThrow(/CONFIRMED_REQUIRES_REFRESH/);

    // RESOLVED_ELSEWHERE: this tab held an UNCERTAIN attempt and its record vanished
    const s2 = makeStorage();
    const l2 = makeLocks();
    const a = build({ storage: s2, locks: l2, handler: () => { throw coded(500, null); } });
    fill(a.store);
    await a.store.send(sendArgs);
    const b = build({ storage: s2, locks: l2 });
    b.store.getSnapshot(); // B has loaded (and adopted) the attempt before it vanishes
    s2.removeItem(durableKey);
    await expect(b.store.send(sendArgs)).rejects.toThrow(/RESOLVED_ELSEWHERE/);
    expect(() => b.store.reset(USER, SALE)).toThrow(/RESOLVED_ELSEWHERE/);
    expect(() => b.store.edit(USER, SALE, { type: "reason", value: "x" })).toThrow(/RESOLVED_ELSEWHERE/);
    await expect(b.store.send(sendArgs)).rejects.toThrow(/RESOLVED_ELSEWHERE/);
    expect(b.newKey).not.toHaveBeenCalled();
    expect(b.request).not.toHaveBeenCalled();
  });

  it("STALE-04 a fresh read that shows the confirmed exchange lets reconcileAfterFreshRead close the cycle and open a new draft", async () => {
    const { storage, locks, key } = await confirmedWith();
    const tab = build({ storage, locks, read: () => freshRead() });
    const result = await tab.store.reconcileAfterFreshRead(reconcileArgs);
    expect(result.ok).toBe(true);
    expect(tab.reads).toEqual([{ path: `/sales/exchangeable?branchId=${BRANCH}&saleNumber=T-1`, token: reconcileArgs.token }]);
    expect(storage.records()).toHaveLength(0);
    const draft = tab.store.getDraft(USER, SALE)!;
    expect(draft).toMatchObject({ attempt: null, recovery: null, reason: "", branchId: BRANCH, saleNumber: "T-1" });
    // the new draft is built from the READ: its baseline is what the server shows now, and only items with something left
    expect(draft.lines.map((l) => ({ id: l.saleItemId, before: l.exchangedQuantityBefore, returnQuantity: l.returnQuantity }))).toEqual(
      expect.arrayContaining([{ id: ITEM_A, before: "4", returnQuantity: "" }, { id: ITEM_B, before: "1", returnQuantity: "" }]),
    );
    expect(tab.newKey).not.toHaveBeenCalled();
    expect(key).toBeTruthy();
  });

  it("STALE-05 the new attempt gets a key different from the confirmed one, and only after reconciling", async () => {
    const { storage, locks, key } = await confirmedWith();
    const tab = build({ storage, locks, read: () => freshRead() });
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/CONFIRMED_REQUIRES_REFRESH/);
    expect(tab.newKey).not.toHaveBeenCalled();
    await tab.store.reconcileAfterFreshRead(reconcileArgs);
    expect(tab.newKey).not.toHaveBeenCalled();
    tab.store.edit(USER, SALE, { type: "reason", value: "Otro cambio" });
    tab.store.edit(USER, SALE, { type: "removeLine", saleItemId: ITEM_B });
    tab.store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_A, replacementLabel: "x", returnQuantity: "1" });
    expect((await tab.store.send(sendArgs)).kind).toBe("CONFIRMED");
    expect(tab.newKey).toHaveBeenCalledTimes(1);
    expect(tab.calls[0]!.body.idempotencyKey).not.toBe(key);
    // the new tombstone's baseline is the one of the fresh read: 4 + 1
    const [record] = storage.records();
    expect((record!.watermarks as Array<Record<string, string>>).find((w) => w.saleItemId === ITEM_A)).toEqual({ saleItemId: ITEM_A, exchangedQuantityBefore: "4", expectedExchangedQuantityAfter: "5" });
  });

  it("STALE-06 a fresh read with nothing left that SHOWS the confirmed exchange (watermarks met) closes the tombstone: the last remainder was spent by that very exchange", async () => {
    const { storage, locks } = await confirmedWith();
    const tab = build({ storage, locks, read: () => freshRead({ quantity: { a: "4", b: "1" } }) });
    const result = await tab.store.reconcileAfterFreshRead(reconcileArgs);
    expect(result).toMatchObject({ ok: true, draft: null }); // reconciled and closed: nothing left, so no draft at all
    expect(storage.records()).toHaveLength(0);
    expect(tab.store.getDraft(USER, SALE)).toBeNull();
    await expect(tab.store.send(sendArgs)).rejects.toThrow();
    expect(tab.calls).toHaveLength(0);
  });

  it("STALE-06c a fresh read with nothing left that does NOT show the confirmed exchange (watermark unmet) keeps the tombstone", async () => {
    const { storage, locks } = await confirmedWith();
    const tab = build({ storage, locks, read: () => freshRead({ quantity: { a: "4", b: "1" }, exchanged: { a: "4", b: "0" } }) });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_STALE" });
    expect(storage.records()[0]!.status).toBe("CONFIRMED");
    expect(tab.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "CONFIRMED" });
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/CONFIRMED_REQUIRES_REFRESH/);
  });

  it("STALE-06b a sale that is no longer COMPLETED is not exchangeable: the cycle stays closed", async () => {
    const { storage, locks } = await confirmedWith();
    for (const read of [freshRead({ status: "CANCELLED", exchangeable: false }), freshRead({ exchangeable: false })]) {
      const tab = build({ storage, locks, read: () => read });
      expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "NOT_EXCHANGEABLE" });
    }
    expect(storage.records()[0]!.status).toBe("CONFIRMED");
  });

  it("STALE-07 a read about another sale, branch or sale number fails closed", async () => {
    const { storage, locks } = await confirmedWith();
    for (const read of [freshRead({ saleId: randomUUID() }), freshRead({ branchId: "branch-9" }), freshRead({ saleNumber: "T-99" })]) {
      const tab = build({ storage, locks, read: () => read });
      expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_MISMATCH" });
      expect(tab.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "CONFIRMED" });
    }
    // the caller asking for a branch other than the one the attempt was made in
    const other = build({ storage, locks, read: () => freshRead({ branchId: "branch-9" }) });
    expect(await other.store.reconcileAfterFreshRead({ ...reconcileArgs, branchId: "branch-9" })).toEqual({ ok: false, reason: "READ_MISMATCH" });
    expect(storage.records()[0]!.status).toBe("CONFIRMED");
  });

  it("STALE-08 a malformed read, or a failed GET, closes nothing", async () => {
    const { storage, locks } = await confirmedWith();
    for (const read of [() => ({ nonsense: true }), () => null, () => freshRead({ items: [ITEM_A, ITEM_A] })]) {
      const tab = build({ storage, locks, read });
      expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_INVALID" });
    }
    for (const failure of [coded(403, "FORBIDDEN"), coded(404, "NOT_FOUND"), new TypeError("Failed to fetch")]) {
      const tab = build({ storage, locks, read: () => { throw failure; } });
      expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toMatchObject({ ok: false, reason: "READ_FAILED" });
    }
    expect(storage.records()[0]!.status).toBe("CONFIRMED");
  });

  it("STALE-09 the durable record changes while the GET is in flight: STATE_CHANGED, and the other tab's record is untouched", async () => {
    const { storage, locks, durableKey } = await confirmedWith();
    const newer = JSON.stringify(makeRecord({ status: "SENDING" }));
    const tab = build({ storage, locks, read: () => { storage.put(durableKey, newer); return freshRead(); } });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "STATE_CHANGED" });
    expect(storage.rawOf(durableKey)).toBe(newer);
  });

  it("STALE-10 two tabs reconcile at once: exactly one closes the cycle, the other gets STATE_CHANGED", async () => {
    const { storage, locks } = await confirmedWith();
    const tabA = build({ storage, locks, read: () => freshRead() });
    const tabB = build({ storage, locks, read: () => freshRead() });
    const results = await Promise.all([tabA.store.reconcileAfterFreshRead(reconcileArgs), tabB.store.reconcileAfterFreshRead(reconcileArgs)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "STATE_CHANGED" }]);
    expect(storage.records()).toHaveLength(0);
  });

  it("STALE-11 reconcile needs the guard, a blocked draft and a readable record", async () => {
    const { storage, locks } = await confirmedWith();
    const noLocks = build({ storage, locks: null, read: () => freshRead() });
    await expect(noLocks.store.reconcileAfterFreshRead(reconcileArgs)).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    expect(noLocks.reads).toHaveLength(0);

    const unreadable = build({ storage: makeStorage({ [attemptStorageKey(USER, SALE)]: "{{{" }), locks, read: () => freshRead() });
    await expect(unreadable.store.reconcileAfterFreshRead(reconcileArgs)).rejects.toThrow(/RECOVERY_REQUIRED/);
    expect(unreadable.reads).toHaveLength(0);

    const editable = build({ locks, read: () => freshRead() });
    fill(editable.store);
    expect(await editable.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "NOT_BLOCKED_BY_REFRESH" });
    await expect(build({ locks }).store.reconcileAfterFreshRead(reconcileArgs)).rejects.toThrow(/NOT_FOUND/);
  });

  it("STALE-12 an attempt that is SENDING or UNCERTAIN is never closed by a refresh", async () => {
    const storage = makeStorage();
    const locks = makeLocks();
    const a = build({ storage, locks, handler: () => { throw coded(500, null); } });
    fill(a.store);
    await a.store.send(sendArgs);
    const b = build({ storage, locks, read: () => freshRead() });
    expect(await b.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "NOT_BLOCKED_BY_REFRESH" });
    expect(storage.records()[0]!.status).toBe("UNCERTAIN");
  });

  it("STALE-13 RESOLVED_ELSEWHERE is closed by a valid fresh read (no watermark exists for an attempt whose record vanished)", async () => {
    const storage = makeStorage();
    const locks = makeLocks();
    const a = build({ storage, locks, handler: () => { throw coded(500, null); } });
    fill(a.store);
    await a.store.send(sendArgs);
    const b = build({ storage, locks, read: () => freshRead({ exchanged: { a: "2", b: "0" } }) });
    b.store.getSnapshot(); // B has loaded (and adopted) the attempt before it vanishes
    storage.removeItem(attemptStorageKey(USER, SALE));
    await expect(b.store.send(sendArgs)).rejects.toThrow(/RESOLVED_ELSEWHERE/);
    expect(await b.store.reconcileAfterFreshRead(reconcileArgs)).toMatchObject({ ok: true });
    expect(b.store.getDraft(USER, SALE)).toMatchObject({ attempt: null, recovery: null });
    expect(b.newKey).not.toHaveBeenCalled();
    expect(b.request).not.toHaveBeenCalledWith(expect.stringContaining("/exchanges"), expect.anything(), expect.anything());
  });
});

// The freshness proof: after CONFIRMED the read must show, per item, AT LEAST baseline + returned. "At least what was returned" would not do:
// with 2 already exchanged before and 1 returned, an old read that still says 2 satisfies 2 >= 1.
describe("exchange store — the reconciliation watermark (WATERMARK)", () => {
  const readWith = (exchangedA: string, quantityA = "100") => () => freshRead({ quantity: { a: quantityA }, exchanged: { a: exchangedA }, items: [ITEM_A] });
  const oneLine = (before: string, returned: string) => confirmedWith((store) => fillOne(store, before, returned));

  it("WATERMARK-01 before=2, returned=1, the fresh read still says 2: READ_STALE, nothing is closed", async () => {
    const { storage, locks } = await oneLine("2", "1");
    const tab = build({ storage, locks, read: readWith("2") });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_STALE" });
    expect(storage.records()[0]!.status).toBe("CONFIRMED");
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/CONFIRMED_REQUIRES_REFRESH/);
  });

  it("WATERMARK-02 before=2, returned=1, the fresh read says 3: valid", async () => {
    const { storage, locks } = await oneLine("2", "1");
    const tab = build({ storage, locks, read: readWith("3") });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toMatchObject({ ok: true });
    expect(storage.records()).toHaveLength(0);
  });

  it("WATERMARK-03 a later exchange of someone else (fresh > expected after) is valid", async () => {
    const { storage, locks } = await oneLine("2", "1");
    const tab = build({ storage, locks, read: readWith("9") });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toMatchObject({ ok: true });
  });

  it("WATERMARK-04 quantities above 2^53 are compared as BigInt, never as Number", async () => {
    const before = "9007199254740992"; // 2^53
    const { storage, locks } = await oneLine(before, "1");
    expect(storage.records()[0]!.watermarks).toEqual([{ saleItemId: ITEM_A, exchangedQuantityBefore: before, expectedExchangedQuantityAfter: "9007199254740993" }]);
    const quantity = "9007199254740999";
    // Number("9007199254740992") >= Number("9007199254740993") is TRUE (both round to 2^53): a Number comparison would accept a stale read
    const stale = build({ storage, locks, read: readWith(before, quantity) });
    expect(await stale.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_STALE" });
    const fresh = build({ storage, locks, read: readWith("9007199254740993", quantity) });
    expect(await fresh.store.reconcileAfterFreshRead(reconcileArgs)).toMatchObject({ ok: true });
    expect(fresh.store.getDraft(USER, SALE)!.lines[0]!.exchangedQuantityBefore).toBe("9007199254740993");
  });

  it("WATERMARK-05 without a baseline for a line there is no exchange to confirm and nothing to reconcile", async () => {
    // (a) a draft whose line has no baseline can never be sent: no key, no request
    const draftless = build();
    draftless.store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [{ ...line(ITEM_A, "0"), exchangedQuantityBefore: undefined as unknown as string }] });
    draftless.store.edit(USER, SALE, { type: "reason", value: "x" });
    draftless.store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: VAR_A, replacementLabel: "", returnQuantity: "1" });
    await expect(draftless.store.send(sendArgs)).rejects.toThrow(/BASELINE_MISSING/);
    expect(draftless.newKey).not.toHaveBeenCalled();
    expect(draftless.request).not.toHaveBeenCalled();
    // (b) a tombstone without watermarks is an unreadable record: RECOVERY_REQUIRED, and reconcile never even GETs
    const record = JSON.parse(JSON.stringify(makeRecord({ status: "CONFIRMED" })));
    delete record.watermarks;
    const storage = makeStorage({ [attemptStorageKey(USER, SALE)]: JSON.stringify(record) });
    const tab = build({ storage, read: () => freshRead() });
    await expect(tab.store.reconcileAfterFreshRead(reconcileArgs)).rejects.toThrow(/RECOVERY_REQUIRED/);
    expect(tab.reads).toHaveLength(0);
    expect(JSON.parse(storage.rawOf(attemptStorageKey(USER, SALE))!)).toEqual(record);
  });

  it("WATERMARK-06 a baseline that belongs to another sale item (the read does not have it): READ_MISMATCH", async () => {
    const { storage, locks } = await confirmedWith();
    const tab = build({ storage, locks, read: () => freshRead({ items: [ITEM_A, randomUUID()] }) });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_MISMATCH" });
    expect(storage.records()[0]!.status).toBe("CONFIRMED");
  });

  it("WATERMARK-07 after a reload the tombstone still carries exactly expectedExchangedQuantityAfter, and reconciles on it", async () => {
    const { storage, locks } = await confirmedWith();
    const [record] = storage.records();
    const marks = record!.watermarks as Array<Record<string, string>>;
    expect(marks.find((w) => w.saleItemId === ITEM_A)!.expectedExchangedQuantityAfter).toBe("4");
    expect(marks.find((w) => w.saleItemId === ITEM_B)!.expectedExchangedQuantityAfter).toBe("1");
    const justShort = build({ storage, locks, read: () => freshRead({ exchanged: { a: "3" } }) });
    expect(await justShort.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_STALE" });
    const exact = build({ storage, locks, read: () => freshRead({ exchanged: { a: "4", b: "1" } }) });
    expect(await exact.store.reconcileAfterFreshRead(reconcileArgs)).toMatchObject({ ok: true });
  });

  it("WATERMARK-08 two lines, one reaches its watermark and the other does not: READ_STALE for the whole attempt, tombstone kept", async () => {
    const { storage, locks } = await confirmedWith();
    for (const exchanged of [{ a: "4", b: "0" }, { a: "3", b: "1" }]) {
      const tab = build({ storage, locks, read: () => freshRead({ exchanged }) });
      expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_STALE" });
      expect(storage.records()[0]!.status).toBe("CONFIRMED");
      expect(tab.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "CONFIRMED" });
    }
  });
});
