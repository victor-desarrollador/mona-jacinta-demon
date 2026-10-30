import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { attemptStorageKey, createExchangeDraftStore, markStorageKey } from "./exchange-draft-store";
import {
  BRANCH, ITEM_A, ITEM_B, SALE, USER, build, coded, fill, fillOne, freshRead, makeLocks, makeStorage, markRecord, parkedSend, readMarkLines, reconcileArgs, sendArgs,
} from "./exchange-store-test-harness";

// The durable HIGH-WATER MARK of (user, sale): per item, the highest exchangedQuantity this client knows was confirmed. It rises when an
// exchange is confirmed and when a validated fresh read shows more; it never falls and it is NOT removed when a tombstone is reconciled.
// It is what stops a stale tab (one that lost every storage event) from minting a key from a baseline that predates a confirmed exchange.

// Two tabs open the same sale at baseline 2 (item A); B returns 1 and confirms (expected after = 3) and reconciles.
const twoTabsThenBConfirmsAndReconciles = async () => {
  const storage = makeStorage();
  const locks = makeLocks();
  const tabA = build({ storage, locks });
  const tabB = build({ storage, locks, read: () => freshRead({ exchanged: { a: "3" }, items: [ITEM_A], quantity: { a: "10" } }) });
  fillOne(tabA.store, "2", "1");
  fillOne(tabB.store, "2", "1");
  await tabB.store.send(sendArgs);
  const reconciled = await tabB.store.reconcileAfterFreshRead(reconcileArgs);
  return { storage, locks, tabA, tabB, reconciled };
};

describe("exchange store — the high-water mark (EPOCH)", () => {
  it("EPOCH-01 A and B open at baseline 2, B confirms (3) and reconciles, A lost every event: A's send mints nothing and sends nothing", async () => {
    const { storage, tabA, reconciled } = await twoTabsThenBConfirmsAndReconciles();
    expect(reconciled).toMatchObject({ ok: true });
    expect(storage.recordKeys()).toHaveLength(0); // the tombstone is gone: only the mark remembers
    await expect(tabA.store.send(sendArgs)).rejects.toThrow(/STALE_EXCHANGE_BASELINE/);
    expect(tabA.newKey).not.toHaveBeenCalled();
    expect(tabA.request).not.toHaveBeenCalled();
    expect(storage.recordKeys()).toHaveLength(0); // and no SENDING record was written
    expect(tabA.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "STALE_BASELINE" });
    await expect(tabA.store.send(sendArgs)).rejects.toThrow(/STALE_EXCHANGE_BASELINE/);
  });

  it("EPOCH-02 the mark is durable: after a reload the old draft is still refused", async () => {
    const { storage, locks } = await twoTabsThenBConfirmsAndReconciles();
    const reloaded = build({ storage, locks });
    fillOne(reloaded.store, "2", "1"); // the same old screen, rebuilt
    await expect(reloaded.store.send(sendArgs)).rejects.toThrow(/STALE_EXCHANGE_BASELINE/);
    expect(reloaded.newKey).not.toHaveBeenCalled();
    expect(reloaded.request).not.toHaveBeenCalled();
  });

  it("EPOCH-03 a fresh read showing 3 opens a draft with baseline 3, and that one may start a legitimate new attempt", async () => {
    const { storage, tabB } = await twoTabsThenBConfirmsAndReconciles();
    expect(tabB.store.getDraft(USER, SALE)!.lines[0]!.exchangedQuantityBefore).toBe("3");
    tabB.store.edit(USER, SALE, { type: "reason", value: "Otro cambio" });
    tabB.store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: randomUUID(), replacementLabel: "x", returnQuantity: "1" });
    expect((await tabB.store.send(sendArgs)).kind).toBe("CONFIRMED");
    expect(tabB.calls).toHaveLength(2);
    expect(tabB.calls[1]!.body.idempotencyKey).not.toBe(tabB.calls[0]!.body.idempotencyKey);
    expect(readMarkLines(storage)![ITEM_A]).toBe("4");
  });

  it("EPOCH-04 a baseline ABOVE the mark (someone else exchanged more) is accepted, and the mark rises, never falls", async () => {
    const storage = makeStorage({ [markStorageKey(USER, SALE)]: markRecord({ [ITEM_A]: "3" }) });
    const tab = build({ storage });
    fillOne(tab.store, "4", "1");
    expect((await tab.store.send(sendArgs)).kind).toBe("CONFIRMED");
    expect(readMarkLines(storage)![ITEM_A]).toBe("5");
    const lower = makeStorage({ [markStorageKey(USER, SALE)]: markRecord({ [ITEM_A]: "9" }) });
    const other = build({ storage: lower });
    fillOne(other.store, "9", "1");
    await other.store.send(sendArgs);
    expect(readMarkLines(lower)![ITEM_A]).toBe("10");
  });

  it("EPOCH-05 one stale line of two blocks the WHOLE attempt", async () => {
    // fill(): A baseline 2, B baseline 0. The mark says A 2 (fine) and B 1 (the draft's 0 is older).
    const storage = makeStorage({ [markStorageKey(USER, SALE)]: markRecord({ [ITEM_A]: "2", [ITEM_B]: "1" }) });
    const tab = build({ storage });
    fill(tab.store);
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/STALE_EXCHANGE_BASELINE/);
    expect(tab.newKey).not.toHaveBeenCalled();
    expect(tab.request).not.toHaveBeenCalled();
    expect(storage.recordKeys()).toHaveLength(0);
    const ok = makeStorage({ [markStorageKey(USER, SALE)]: markRecord({ [ITEM_A]: "2", [ITEM_B]: "0" }) });
    const fine = build({ storage: ok });
    fill(fine.store);
    expect((await fine.store.send(sendArgs)).kind).toBe("CONFIRMED");
  });

  it("EPOCH-06 above 2^53 the comparison is exact (BigInt): 2^53 < 2^53 + 1 is stale, Number() would call them equal", async () => {
    const storage = makeStorage({ [markStorageKey(USER, SALE)]: markRecord({ [ITEM_A]: "9007199254740993" }) });
    const tab = build({ storage });
    fillOne(tab.store, "9007199254740992", "1");
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/STALE_EXCHANGE_BASELINE/);
    expect(tab.request).not.toHaveBeenCalled();
    const exact = build({ storage: makeStorage({ [markStorageKey(USER, SALE)]: markRecord({ [ITEM_A]: "9007199254740993" }) }) });
    fillOne(exact.store, "9007199254740993", "1");
    await exact.store.send(sendArgs);
    expect(readMarkLines(exact.storage)![ITEM_A]).toBe("9007199254740994");
  });

  it("EPOCH-07 a corrupt mark fails closed: RECOVERY_REQUIRED, no key, no request, the mark is left as found", async () => {
    const good = JSON.parse(markRecord({ [ITEM_A]: "3" }));
    const mutate = (change: (copy: Record<string, unknown>) => void) => { const copy = structuredClone(good); change(copy); return JSON.stringify(copy); };
    const cases: Array<[string, string]> = [
      ["not JSON", "{{{"],
      ["an array", "[]"],
      ["wrong version", mutate((m) => { m.v = 2; })],
      ["another user's mark", mutate((m) => { m.userId = "intruder"; })],
      ["another sale's mark", mutate((m) => { m.saleId = randomUUID(); })],
      ["an extra field", mutate((m) => { m.extra = 1; })],
      ["a quantity that is a number", mutate((m) => { (m.lines as Record<string, unknown>)[ITEM_A] = 3; })],
      ["a non canonical quantity", mutate((m) => { (m.lines as Record<string, unknown>)[ITEM_A] = "03"; })],
      ["a line key that is not a UUID", mutate((m) => { (m.lines as Record<string, unknown>)["nope"] = "1"; })],
    ];
    for (const [name, value] of cases) {
      const storage = makeStorage({ [markStorageKey(USER, SALE)]: value });
      const tab = build({ storage });
      fillOne(tab.store, "2", "1");
      await expect(tab.store.send(sendArgs), name).rejects.toThrow(/RECOVERY_REQUIRED/);
      expect(tab.newKey, name).not.toHaveBeenCalled();
      expect(tab.request, name).not.toHaveBeenCalled();
      expect(storage.rawOf(markStorageKey(USER, SALE)), name).toBe(value);
      expect(storage.recordKeys(), name).toHaveLength(0);
    }
    const unreadable = makeStorage();
    const tab = build({ storage: unreadable });
    fillOne(tab.store, "2", "1");
    unreadable.failReads = true;
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/RECOVERY_REQUIRED/);
    expect(tab.request).not.toHaveBeenCalled();
  });

  it("EPOCH-08 a successful reconcile closes the tombstone but keeps (and may raise) the mark", async () => {
    const storage = makeStorage();
    const locks = makeLocks();
    const first = build({ storage, locks });
    fill(first.store);
    await first.store.send(sendArgs);
    expect(readMarkLines(storage)).toEqual({ [ITEM_A]: "4", [ITEM_B]: "1" }); // raised by the confirmation itself
    expect(storage.recordKeys()).toHaveLength(1);
    const tab = build({ storage, locks, read: () => freshRead({ exchanged: { a: "6", b: "1" } }) }); // another exchange happened meanwhile
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toMatchObject({ ok: true });
    expect(storage.recordKeys()).toHaveLength(0);
    expect(readMarkLines(storage)).toEqual({ [ITEM_A]: "6", [ITEM_B]: "1" });
  });

  it("EPOCH-08b a read OLDER than the mark cannot reconcile or open anything, even without a tombstone", async () => {
    const storage = makeStorage({ [markStorageKey(USER, SALE)]: markRecord({ [ITEM_A]: "4", [ITEM_B]: "1" }) });
    const tab = build({ storage });
    expect(await tab.store.openDraftFromFreshRead({ userId: USER, branchId: BRANCH, saleNumber: "T-1", read: freshRead({ exchanged: { a: "3", b: "1" } }) })).toEqual({ ok: false, reason: "READ_STALE" });
    expect(tab.store.getDraft(USER, SALE)).toBeNull();
    expect(readMarkLines(storage)).toEqual({ [ITEM_A]: "4", [ITEM_B]: "1" });
  });

  it("EPOCH-09 a REJECTED attempt raises nothing (no exchange happened)", async () => {
    const storage = makeStorage();
    const tab = build({ storage, handler: () => { throw coded(409, "INSUFFICIENT_STOCK"); } });
    fill(tab.store);
    expect((await tab.store.send(sendArgs)).kind).toBe("REJECTED");
    expect(storage.rawOf(markStorageKey(USER, SALE))).toBeNull();
    const uncertain = makeStorage();
    const unsure = build({ storage: uncertain, handler: () => { throw coded(500, null); } });
    fill(unsure.store);
    await unsure.store.send(sendArgs);
    expect(uncertain.rawOf(markStorageKey(USER, SALE))).toBeNull(); // not known to be confirmed
  });

  it("EPOCH-10 a late CONFIRMED of an old key never lowers a higher mark, and never touches a corrupt one", async () => {
    // key A is in flight; a higher mark appears while it is; A's answer arrives late. `entered` / `release` order it, not a timer.
    const storage = makeStorage();
    const parked = parkedSend(storage);
    fill(parked.tab.store);
    const pending = parked.tab.store.send(sendArgs);
    await parked.entered;
    storage.put(markStorageKey(USER, SALE), markRecord({ [ITEM_A]: "9", [ITEM_B]: "0" }));
    parked.release({ exchangeId: randomUUID(), replayed: false });
    await pending;
    expect(readMarkLines(storage)).toEqual({ [ITEM_A]: "9", [ITEM_B]: "1" }); // A stays 9 (not lowered to 4); B rises to 1

    const corrupt = makeStorage();
    const parked2 = parkedSend(corrupt);
    fill(parked2.tab.store);
    const pending2 = parked2.tab.store.send(sendArgs);
    await parked2.entered;
    corrupt.put(markStorageKey(USER, SALE), "{{{");
    parked2.release({ exchangeId: randomUUID(), replayed: false });
    await pending2;
    expect(corrupt.rawOf(markStorageKey(USER, SALE))).toBe("{{{");
  });

  it("EPOCH-11 a retry of an UNCERTAIN attempt is NOT blocked by a higher mark: replaying the same key is how it gets resolved", async () => {
    const storage = makeStorage();
    const locks = makeLocks();
    let n = 0;
    const tab = build({ storage, locks, handler: () => { n += 1; if (n === 1) throw coded(500, null); return { exchangeId: randomUUID(), replayed: true }; } });
    fillOne(tab.store, "2", "1");
    await tab.store.send(sendArgs);
    storage.put(markStorageKey(USER, SALE), markRecord({ [ITEM_A]: "3" })); // another tab saw the committed exchange in a fresh read
    expect((await tab.store.send(sendArgs)).kind).toBe("CONFIRMED");
    expect(tab.calls[1]!.body.idempotencyKey).toBe(tab.calls[0]!.body.idempotencyKey);
    expect(tab.newKey).toHaveBeenCalledTimes(1);
  });

  it("EPOCH-12 the mark never carries a token or the draft, only user, sale and quantities", async () => {
    const storage = makeStorage();
    const tab = build({ storage });
    fill(tab.store);
    await tab.store.send(sendArgs);
    const raw = storage.rawOf(markStorageKey(USER, SALE))!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(["lines", "saleId", "userId", "v"]);
    expect(raw).not.toContain("secret-token");
    expect(raw).not.toContain("Cambio de talle");
    expect(attemptStorageKey(USER, SALE)).not.toBe(markStorageKey(USER, SALE));
  });
});

describe("exchange store — drafts are born from a validated fresh read (BASELINE)", () => {
  const open = (tab: ReturnType<typeof build>, read: unknown = freshRead({ exchanged: { a: "4", b: "1" } }), who = { userId: USER, branchId: BRANCH, saleNumber: "T-1" }) =>
    tab.store.openDraftFromFreshRead({ ...who, read });

  it("BASELINE-01 the productive path derives sale, branch, number, items, variants, baseline and remaining from the validated read", async () => {
    const storage = makeStorage();
    const tab = build({ storage });
    const raw = freshRead({ exchanged: { a: "4", b: "1" } });
    const result = await open(tab, raw);
    expect(result.ok).toBe(true);
    const draft = tab.store.getDraft(USER, SALE)!;
    expect(draft).toMatchObject({ userId: USER, branchId: BRANCH, saleId: SALE, saleNumber: "T-1", reason: "", attempt: null, recovery: null });
    expect(draft.lines.map((l) => [l.saleItemId, l.exchangedQuantityBefore]).sort()).toEqual([[ITEM_A, "4"], [ITEM_B, "1"]].sort());
    expect(draft.available.map((a) => [a.saleItemId, a.exchangedQuantityBefore, a.remainingQuantity, a.variantId.length > 0]).sort())
      .toEqual([[ITEM_A, "4", "6", true], [ITEM_B, "1", "4", true]].sort());
    expect(readMarkLines(storage)).toEqual({ [ITEM_A]: "4", [ITEM_B]: "1" });
    // and the baseline it set is the one the watermarks will be built on
    tab.store.edit(USER, SALE, { type: "reason", value: "x" });
    tab.store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: randomUUID(), replacementLabel: "", returnQuantity: "2" });
    tab.store.edit(USER, SALE, { type: "removeLine", saleItemId: ITEM_B });
    await tab.store.send(sendArgs);
    expect(storage.records()[0]!.watermarks).toEqual([{ saleItemId: ITEM_A, exchangedQuantityBefore: "4", expectedExchangedQuantityAfter: "6" }]);
  });

  it("BASELINE-02 a read with invalid quantities opens nothing", async () => {
    const storage = makeStorage();
    const tab = build({ storage });
    const base = freshRead();
    for (const bad of [
      { ...base, lines: [{ ...base.lines[0], exchangedQuantity: "-1" }] },
      { ...base, lines: [{ ...base.lines[0], exchangedQuantity: 4 }] },
      { ...base, lines: [{ ...base.lines[0], exchangedQuantity: "04" }] },
      { ...base, lines: [{ ...base.lines[0], remainingQuantity: "99" }] },
      { nonsense: true },
      null,
    ]) {
      expect(await open(tab, bad)).toEqual({ ok: false, reason: "READ_INVALID" });
    }
    expect(tab.store.getDraft(USER, SALE)).toBeNull();
    expect(storage.keys()).toHaveLength(0);
  });

  it("BASELINE-03 addLine cannot bring a baseline: it takes it from the opening read, and unknown items are refused", async () => {
    const tab = build();
    await open(tab, freshRead({ exchanged: { a: "4", b: "1" } }));
    tab.store.edit(USER, SALE, { type: "removeLine", saleItemId: ITEM_A });
    tab.store.edit(USER, SALE, { type: "addLine", saleItemId: ITEM_A, exchangedQuantityBefore: "0" } as never); // an invented baseline is ignored
    const line = tab.store.getDraft(USER, SALE)!.lines.find((l) => l.saleItemId === ITEM_A)!;
    expect(line.exchangedQuantityBefore).toBe("4");
    expect(() => tab.store.edit(USER, SALE, { type: "addLine", saleItemId: randomUUID() })).toThrow(/UNKNOWN_LINE/);
    // the productive store has no way to open a draft with a chosen baseline
    const productive = createExchangeDraftStore({ storage: makeStorage(), request: async () => ({}), newKey: () => randomUUID(), locks: makeLocks() });
    expect("openDraft" in productive).toBe(false);
    expect("openDraftUnsafe" in productive).toBe(false);
  });

  it("BASELINE-04 a read of another branch or another sale number creates no draft", async () => {
    const tab = build();
    expect(await open(tab, freshRead({ branchId: "branch-9" }))).toEqual({ ok: false, reason: "READ_MISMATCH" });
    expect(await open(tab, freshRead({ saleNumber: "T-99" }))).toEqual({ ok: false, reason: "READ_MISMATCH" });
    expect(await open(tab, freshRead(), { userId: USER, branchId: "branch-9", saleNumber: "T-1" })).toEqual({ ok: false, reason: "READ_MISMATCH" });
    expect(tab.store.getDrafts(USER)).toEqual([]);
  });

  it("BASELINE-05 quantities stay canonical decimal strings and are exact above 2^53", async () => {
    const storage = makeStorage();
    const tab = build({ storage });
    const big = freshRead({ quantity: { a: "9007199254741000" }, exchanged: { a: "9007199254740993", b: "1" } });
    await open(tab, big);
    const draft = tab.store.getDraft(USER, SALE)!;
    expect(draft.lines.find((l) => l.saleItemId === ITEM_A)!.exchangedQuantityBefore).toBe("9007199254740993");
    expect(draft.available.find((a) => a.saleItemId === ITEM_A)!.remainingQuantity).toBe("7");
    expect(readMarkLines(storage)![ITEM_A]).toBe("9007199254740993");
  });

  it("BASELINE-06 nothing to exchange or not exchangeable: no draft; an existing attempt or tombstone wins over the read", async () => {
    const tab = build();
    expect(await open(tab, freshRead({ quantity: { a: "4", b: "1" }, exchanged: { a: "4", b: "1" } }))).toEqual({ ok: false, reason: "NOTHING_LEFT_TO_EXCHANGE" });
    expect(await open(tab, freshRead({ exchangeable: false }))).toEqual({ ok: false, reason: "NOT_EXCHANGEABLE" });

    const storage = makeStorage();
    const locks = makeLocks();
    const first = build({ storage, locks });
    fill(first.store);
    await first.store.send(sendArgs);
    const second = build({ storage, locks });
    const result = await open(second, freshRead({ exchanged: { a: "4", b: "1" } }));
    expect(result).toMatchObject({ ok: true });
    expect(second.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "CONFIRMED" });
    expect(second.newKey).not.toHaveBeenCalled();
  });

  it("BASELINE-07 without Web Locks the productive open is refused (it writes the mark)", async () => {
    const tab = build({ locks: null });
    await expect(open(tab)).rejects.toThrow(/CONCURRENCY_GUARD_UNAVAILABLE/);
    expect(tab.storage.keys()).toHaveLength(0);
  });
});

// The exits and the unreadable-mark cases that the high-water mark introduced.
describe("exchange store — leaving STALE_BASELINE, and an unreadable mark (EPOCH exits)", () => {
  it("EPOCH-13 a STALE_BASELINE draft is refused, then leaves through reconcileAfterFreshRead with the baseline of the new read, and only then sends", async () => {
    const markKey = markStorageKey(USER, SALE);
    const storage = makeStorage({ [markKey]: markRecord({ [ITEM_A]: "3" }) });
    const tab = build({ storage, read: () => freshRead({ exchanged: { a: "3" }, items: [ITEM_A], quantity: { a: "10" } }) });
    fillOne(tab.store, "2", "1"); // opened at baseline 2; this client already knows 3 was confirmed
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/STALE_EXCHANGE_BASELINE/);
    expect(tab.newKey).not.toHaveBeenCalled();
    expect(tab.calls).toHaveLength(0); // no POST
    expect(storage.recordKeys()).toHaveLength(0); // no SENDING record
    expect(tab.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "STALE_BASELINE" });
    expect(() => tab.store.reset(USER, SALE)).toThrow(/STALE_EXCHANGE_BASELINE/); // a plain reset is not the exit
    expect(tab.reads).toHaveLength(0);

    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toMatchObject({ ok: true });
    expect(tab.reads).toHaveLength(1);
    const draft = tab.store.getDraft(USER, SALE)!;
    expect(draft).toMatchObject({ recovery: null, attempt: null, reason: "" });
    expect(draft.lines.map((l) => [l.saleItemId, l.exchangedQuantityBefore])).toEqual([[ITEM_A, "3"]]); // from the NEW read
    expect(readMarkLines(storage)![ITEM_A]).toBe("3");
    expect(tab.newKey).not.toHaveBeenCalled(); // reconciling mints nothing either

    tab.store.edit(USER, SALE, { type: "reason", value: "Otro cambio" });
    tab.store.edit(USER, SALE, { type: "line", saleItemId: ITEM_A, replacementVariantId: randomUUID(), replacementLabel: "x", returnQuantity: "1" });
    expect((await tab.store.send(sendArgs)).kind).toBe("CONFIRMED");
    expect(tab.newKey).toHaveBeenCalledTimes(1);
    expect(tab.calls).toHaveLength(1);
    expect(readMarkLines(storage)![ITEM_A]).toBe("4");
  });

  it("EPOCH-13b a read that is still OLDER than the mark does not release a STALE_BASELINE draft", async () => {
    const storage = makeStorage({ [markStorageKey(USER, SALE)]: markRecord({ [ITEM_A]: "3" }) });
    const tab = build({ storage, read: () => freshRead({ exchanged: { a: "2" }, items: [ITEM_A], quantity: { a: "10" } }) });
    fillOne(tab.store, "2", "1");
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/STALE_EXCHANGE_BASELINE/);
    expect(await tab.store.reconcileAfterFreshRead(reconcileArgs)).toEqual({ ok: false, reason: "READ_STALE" });
    expect(tab.store.getDraft(USER, SALE)!.recovery).toEqual({ reason: "STALE_BASELINE" });
    expect(readMarkLines(storage)![ITEM_A]).toBe("3");
  });

  it("EPOCH-14 an unreadable mark beats a perfectly valid read at open: RECOVERY_REQUIRED, no commercial draft, no key, no POST, the mark untouched", async () => {
    const markKey = markStorageKey(USER, SALE);
    const cases: Array<[string, string]> = [["not JSON", "{{{"], ["wrong shape", JSON.stringify({ v: 1 })], ["a number where a string belongs", markRecord({ [ITEM_A]: "3" }).replace('"3"', "3")]];
    for (const [name, corrupt] of cases) {
      const storage = makeStorage({ [markKey]: corrupt });
      const tab = build({ storage });
      const result = await tab.store.openDraftFromFreshRead({ userId: USER, branchId: BRANCH, saleNumber: "T-1", read: freshRead({ exchanged: { a: "4", b: "1" } }) });
      expect(result.ok, name).toBe(true);
      const draft = tab.store.getDraft(USER, SALE)!;
      expect(draft.recovery, name).toEqual({ reason: "UNREADABLE" });
      expect(draft.lines, name).toEqual([]); // nothing from the read became a draft
      expect(draft.attempt, name).toBeNull();
      await expect(tab.store.send(sendArgs), name).rejects.toThrow(/RECOVERY_REQUIRED/);
      expect(() => tab.store.edit(USER, SALE, { type: "reason", value: "x" }), name).toThrow(/RECOVERY_REQUIRED/);
      expect(tab.newKey, name).not.toHaveBeenCalled();
      expect(tab.request, name).not.toHaveBeenCalled();
      expect(storage.rawOf(markKey), name).toBe(corrupt); // neither overwritten nor deleted
      expect(storage.recordKeys(), name).toHaveLength(0);
    }
  });

  it("EPOCH-15 the mark turns unreadable between the two locked sections of reconcile: fail closed, tombstone kept, no new draft, evidence untouched", async () => {
    const markKey = markStorageKey(USER, SALE);
    const storage = makeStorage();
    const locks = makeLocks();
    const first = build({ storage, locks });
    fill(first.store);
    await first.store.send(sendArgs);
    const tombstone = storage.rawOf(attemptStorageKey(USER, SALE));
    expect(JSON.parse(tombstone!).status).toBe("CONFIRMED");
    // phase 1 sees a valid state; the GET (which runs with NO lock held) is where the corruption lands; phase 2 must notice it
    const tab = build({ storage, locks, read: () => { storage.put(markKey, "{{{"); return freshRead(); } });
    await expect(tab.store.reconcileAfterFreshRead(reconcileArgs)).rejects.toThrow(/RECOVERY_REQUIRED/);
    expect(tab.reads).toHaveLength(1);
    expect(storage.rawOf(attemptStorageKey(USER, SALE))).toBe(tombstone); // not deleted, not rewritten
    expect(storage.rawOf(markKey)).toBe("{{{");
    const draft = tab.store.getDraft(USER, SALE)!;
    expect(draft.recovery).toEqual({ reason: "UNREADABLE" });
    expect(draft.attempt).toMatchObject({ status: "CONFIRMED" }); // no fresh draft replaced the confirmed one
    expect(draft.lines.map((l) => l.saleItemId).sort()).toEqual([ITEM_A, ITEM_B].sort());
    expect(draft.reason).toBe("Cambio de talle");
    expect(tab.newKey).not.toHaveBeenCalled();
    expect(tab.calls).toHaveLength(0);
    await expect(tab.store.send(sendArgs)).rejects.toThrow(/RECOVERY_REQUIRED/);
  });
});
