import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attemptStorageKey, markStorageKey } from "./exchange-draft-store";
import {
  BRANCH, ITEM_A, ITEM_B, SALE, USER, build, coded, fill, fillOne, freshRead, line, makeLocks, makeRecord, makeStorage, markRecord, reconcileArgs, sendArgs,
} from "./exchange-store-test-harness";

// F-01: a CONFIRMED exchange that consumed the LAST remainder leaves a read with nothing left. For a NEW sale that is NOTHING_LEFT_TO_EXCHANGE;
// for a CONFIRMED tombstone it is the expected shape of the proof, which is the watermarks + identity + monotonicity, never the zero itself.

const exhausted = (overrides: Parameters<typeof freshRead>[0] = {}) => freshRead({ quantity: { a: "4", b: "1" }, ...overrides });

const confirmed = async () => {
  const storage = makeStorage();
  const locks = makeLocks();
  const first = build({ storage, locks });
  fill(first.store);
  await first.store.send(sendArgs);
  return { storage, locks };
};

const stillBlocked = (tab: ReturnType<typeof build>, storage: ReturnType<typeof makeStorage>) => {
  expect(storage.records()).toHaveLength(1);
  expect(storage.records()[0]!.status).toBe("CONFIRMED");
  expect(tab.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "CONFIRMED" });
};

describe("exchange store — reconciling a CONFIRMED exchange that spent the last remainder (F01)", () => {
  it("F01-01 watermarks met + every line at 0 remaining: SUCCESS without a draft, the tombstone closes, the mark is raised, nothing is posted", async () => {
    const { storage, locks } = await confirmed();
    const tab = build({ storage, locks, read: () => exhausted() });
    const result = await tab.store.reconcileAfterFreshRead(reconcileArgs);
    expect(result).toMatchObject({ ok: true, draft: null, saleId: SALE });
    expect(result.ok && result.draft === null ? result.available.every((a) => a.remainingQuantity === "0") : false).toBe(true);
    expect(storage.records()).toHaveLength(0);
    expect(JSON.parse(storage.rawOf(markStorageKey(USER, SALE))!).lines).toEqual({ [ITEM_A]: "4", [ITEM_B]: "1" });
    expect(tab.calls).toHaveLength(0);
    expect(tab.newKey).not.toHaveBeenCalled();
  });

  it("F01-13 after reconciling the last remainder there is no draft at all (nothing editable, nothing blocked), no tombstone, the mark stays, and send() is impossible", async () => {
    const { storage, locks } = await confirmed();
    const tab = build({ storage, locks, read: () => exhausted() });
    await tab.store.reconcileAfterFreshRead(reconcileArgs);
    expect(tab.store.getDraft(USER, SALE)).toBeNull();
    expect(tab.store.getDrafts(USER)).toEqual([]);
    expect(storage.recordKeys()).toEqual([]);
    expect(storage.rawOf(markStorageKey(USER, SALE))).not.toBeNull();
    await expect(tab.store.send(sendArgs)).rejects.toThrow();
    expect(tab.calls).toHaveLength(0);
    expect(tab.newKey).not.toHaveBeenCalled();
  });

  it("F01-15 with something still left, reconcile keeps building the fresh draft from the read as before", async () => {
    const { storage, locks } = await confirmed();
    const tab = build({ storage, locks, read: () => freshRead({ quantity: { a: "10", b: "1" } }) }); // A: 6 left, B: spent
    const result = await tab.store.reconcileAfterFreshRead(reconcileArgs);
    expect(result.ok && result.draft !== null).toBe(true);
    const draft = tab.store.getDraft(USER, SALE)!;
    expect(draft).toMatchObject({ attempt: null, recovery: null, reason: "" });
    expect(draft.lines.map((l) => l.saleItemId)).toEqual([ITEM_A]);
    expect(storage.recordKeys()).toEqual([]);
  });

  it("F01-02 a single-line sale (the watermark of one item) behaves the same", async () => {
    const storage = makeStorage();
    const locks = makeLocks();
    const first = build({ storage, locks });
    first.store.openDraftUnsafe({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", lines: [line(ITEM_A, "2")] });
    first.store.edit(USER, SALE, { type: "reason", value: "x" });
    first.store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: randomUUID(), replacementLabel: "x", returnQuantity: "2" });
    await first.store.send(sendArgs);
    const tab = build({ storage, locks, read: () => freshRead({ items: [ITEM_A], quantity: { a: "4" }, exchanged: { a: "4" } }) });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toMatchObject({ ok: true, draft: null });
    expect(storage.records()).toHaveLength(0);
    expect(tab.store.getDraft(USER, SALE)).toBeNull();
  });

  it("F01-04 exhausted but a watermarked item is missing from the read: the tombstone stays", async () => {
    const { storage, locks } = await confirmed();
    const tab = build({ storage, locks, read: () => exhausted({ items: [ITEM_A] }) });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_MISMATCH" });
    stillBlocked(tab, storage);
  });

  it("F01-05 exhausted but exchangedQuantity below the watermark: the tombstone stays", async () => {
    const { storage, locks } = await confirmed();
    const tab = build({ storage, locks, read: () => freshRead({ quantity: { a: "3", b: "1" }, exchanged: { a: "3", b: "1" } }) });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_STALE" });
    stillBlocked(tab, storage);
  });

  it("F01-06/07/08 exhausted read of another sale, branch or sale number: the tombstone stays", async () => {
    const { storage, locks } = await confirmed();
    for (const read of [exhausted({ saleId: randomUUID() }), exhausted({ branchId: "branch-9" }), exhausted({ saleNumber: "T-99" })]) {
      const tab = build({ storage, locks, read: () => read });
      expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_MISMATCH" });
      stillBlocked(tab, storage);
    }
  });

  it("F01-09 exhausted read that satisfies the watermarks but is below the durable high-water mark: the tombstone stays", async () => {
    const { storage, locks } = await confirmed();
    storage.put(markStorageKey(USER, SALE), markRecord({ [ITEM_A]: "6", [ITEM_B]: "1" }));
    const tab = build({ storage, locks, read: () => exhausted() });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_STALE" });
    stillBlocked(tab, storage);
    expect(JSON.parse(storage.rawOf(markStorageKey(USER, SALE))!).lines[ITEM_A]).toBe("6");
  });

  it("F01-P5 RESOLVED_ELSEWHERE has no watermarks: zero remaining alone proves nothing, the draft stays blocked and no tombstone is invented", async () => {
    const storage = makeStorage();
    const locks = makeLocks();
    const a = build({ storage, locks, handler: () => { throw coded(500, null); } });
    fill(a.store);
    await a.store.send(sendArgs); // UNCERTAIN
    const b = build({ storage, locks, read: () => exhausted() });
    b.store.getSnapshot();
    storage.removeItem(storage.recordKeys()[0]!);
    await expect(b.store.send(sendArgs)).rejects.toThrow(/RESOLVED_ELSEWHERE/);
    expect(await b.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "NOTHING_LEFT_TO_EXCHANGE" });
    expect(b.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "RESOLVED_ELSEWHERE" });
  });

  it("F01-09b exhausted read that is not COMPLETED / not exchangeable: the tombstone stays", async () => {
    const { storage, locks } = await confirmed();
    const tab = build({ storage, locks, read: () => exhausted({ status: "CANCELLED", exchangeable: false }) });
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "NOT_EXCHANGEABLE" });
    stillBlocked(tab, storage);
  });
});

describe("exchange store — opening from a fresh read that has nothing left (F01 reload)", () => {
  const open = (tab: ReturnType<typeof build>, read: unknown) => tab.store.openDraftFromFreshRead({ userId: USER, branchId: BRANCH, saleNumber: "T-1", read });

  it("F01-03 a new sale with nothing left and no CONFIRMED evidence is still NOTHING_LEFT_TO_EXCHANGE", async () => {
    const tab = build();
    expect(await open(tab, exhausted())).toEqual({ ok: false, reason: "NOTHING_LEFT_TO_EXCHANGE" });
    expect(tab.store.getDrafts(USER)).toEqual([]);
    expect(tab.storage.keys()).toHaveLength(0);
  });

  it("F01-10 after a reload the search finds the tombstone of an exhausted sale: blocked CONFIRMED draft, no GET, tombstone untouched; reconcile then does its own GET and closes it", async () => {
    const { storage, locks } = await confirmed();
    const tab = build({ storage, locks, read: () => exhausted() });
    const opened = await open(tab, exhausted());
    expect(opened.ok).toBe(true);
    const draft = tab.store.getDraft(USER, SALE)!;
    expect(draft).toMatchObject({ recovery: { reason: "CONFIRMED" } }); // no saleNumber is persisted: the screen derives the target from the read
    expect(draft.attempt?.status).toBe("CONFIRMED");
    expect(tab.reads).toHaveLength(0); // the search read is NOT the proof
    expect(storage.records()[0]!.status).toBe("CONFIRMED");
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/CONFIRMED_REQUIRES_REFRESH/);

    const result = await tab.store.reconcileAfterFreshRead(reconcileArgs);
    expect(result.ok).toBe(true);
    expect(tab.reads).toHaveLength(1); // its own GET
    expect(storage.records()).toHaveLength(0);
  });

  it("F01-10b the search read being exhausted does not close the tombstone if the reconcile GET is stale", async () => {
    const { storage, locks } = await confirmed();
    const tab = build({ storage, locks, read: () => freshRead({ quantity: { a: "3", b: "1" }, exchanged: { a: "3", b: "1" } }) });
    expect((await open(tab, exhausted())).ok).toBe(true);
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_STALE" });
    stillBlocked(tab, storage);
  });

  it("F01-11 after a reload an exhausted search of a sale WITHOUT a CONFIRMED record is NOTHING_LEFT_TO_EXCHANGE, also with a SENDING/UNCERTAIN record or an unreadable one", async () => {
    const tab = build({ storage: makeStorage({ [markStorageKey(USER, SALE)]: markRecord({ [ITEM_A]: "4", [ITEM_B]: "1" }) }) });
    expect(await open(tab, exhausted())).toEqual({ ok: false, reason: "NOTHING_LEFT_TO_EXCHANGE" });
    expect(tab.store.getDrafts(USER)).toEqual([]);
  });

  it("F01-11b an exhausted search whose existing in-memory draft is editable (not CONFIRMED) is still NOTHING_LEFT", async () => {
    const tab = build();
    fill(tab.store);
    expect(await open(tab, exhausted())).toEqual({ ok: false, reason: "NOTHING_LEFT_TO_EXCHANGE" });
  });

  it("F01-LOW characterization: an editable draft already in memory is returned UNCHANGED by a later read with a lower remainder", async () => {
    const tab = build();
    const first = await open(tab, freshRead({ quantity: { a: "10", b: "5" }, exchanged: { a: "0", b: "0" } }));
    expect(first.ok).toBe(true);
    const before = tab.store.getDraft(USER, SALE)!;
    const second = await open(tab, freshRead({ quantity: { a: "10", b: "5" }, exchanged: { a: "9", b: "0" } }));
    expect(second.ok).toBe(true);
    expect(tab.store.getDraft(USER, SALE)).toBe(before); // stale remaining/baseline kept: out of scope for F-01
    expect(before.available.find((a) => a.saleItemId === ITEM_A)!.remainingQuantity).toBe("10");
  });

  const unchanged = async (tab: ReturnType<typeof build>) => {
    const before = tab.store.getDraft(USER, SALE);
    expect(await open(tab, exhausted())).toEqual({ ok: false, reason: "NOTHING_LEFT_TO_EXCHANGE" });
    expect(tab.store.getDraft(USER, SALE)).toBe(before);
    expect(tab.reads).toHaveLength(0);
  };

  it("F01-16 ONLY a CONFIRMED record passes the exhausted-read gate: none, EDITABLE, SENDING, UNCERTAIN, REJECTED, corrupt, RESOLVED_ELSEWHERE and STALE_BASELINE all stay NOTHING_LEFT", async () => {
    await unchanged(build()); // none
    const editable = build();
    fill(editable.store);
    await unchanged(editable);

    const sending = build({ storage: makeStorage({ [attemptStorageKey(USER, SALE)]: JSON.stringify(makeRecord({ status: "SENDING" })) }) });
    await unchanged(sending);

    const uncertain = build({ handler: () => { throw coded(500, null); } });
    fill(uncertain.store);
    await uncertain.store.send(sendArgs);
    expect(uncertain.store.getDraft(USER, SALE)!.attempt?.status).toBe("UNCERTAIN");
    await unchanged(uncertain);
    const reloaded = build({ storage: uncertain.storage });
    await unchanged(reloaded);

    const rejected = build({ handler: () => { throw coded(409, "INSUFFICIENT_STOCK"); } });
    fill(rejected.store);
    await rejected.store.send(sendArgs);
    expect(rejected.store.getDraft(USER, SALE)!.attempt?.status).toBe("REJECTED");
    await unchanged(rejected);

    const corrupt = build({ storage: makeStorage({ [attemptStorageKey(USER, SALE)]: "{not json" }) });
    await unchanged(corrupt);

    const storage = makeStorage();
    const locks = makeLocks();
    const a = build({ storage, locks, handler: () => { throw coded(500, null); } });
    fill(a.store);
    await a.store.send(sendArgs);
    const b = build({ storage, locks });
    b.store.getSnapshot();
    storage.removeItem(storage.recordKeys()[0]!);
    await expect(b.store.send(sendArgs)).rejects.toThrow(/RESOLVED_ELSEWHERE/);
    await unchanged(b);

    const stale = build({ storage: makeStorage({ [markStorageKey(USER, SALE)]: markRecord({ [ITEM_A]: "3" }) }) });
    fillOne(stale.store, "2", "1");
    await expect(stale.store.send(sendArgs)).rejects.toThrow(/STALE_EXCHANGE_BASELINE/);
    expect(stale.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "STALE_BASELINE" });
    await unchanged(stale);
  });
});
