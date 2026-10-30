import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { draftLinesFromFreshRead, validateFreshRead, type Watermark } from "./exchange-fresh-read";
import { BRANCH, ITEM_A, ITEM_B, SALE, freshRead } from "./exchange-store-test-harness";

const ZERO = BigInt(0);

// The pure half of reconcileAfterFreshRead: is this body a trustworthy, FRESH read of THIS sale in THIS branch?

const expected = (watermarks: Watermark[] | null = null) => ({ saleId: SALE, branchId: BRANCH, saleNumber: "T-1", watermarks });
const marks = (a: string, b: string): Watermark[] => [
  { saleItemId: ITEM_A, exchangedQuantityBefore: "0", expectedExchangedQuantityAfter: a },
  { saleItemId: ITEM_B, exchangedQuantityBefore: "0", expectedExchangedQuantityAfter: b },
];

describe("validateFreshRead", () => {
  it("READ-01 a well formed read of the right sale passes and yields the lines that still have something left", () => {
    const result = validateFreshRead(freshRead({ quantity: { a: "4", b: "5" }, exchanged: { a: "4", b: "1" } }), expected());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.read.lines.filter((l) => BigInt(l.remainingQuantity) > ZERO).map((l) => l.saleItemId)).toEqual([ITEM_B]);
  });

  it("READ-02 anything that is not exactly the documented shape is READ_INVALID", () => {
    const base = freshRead();
    const cases: unknown[] = [
      null, 1, "x", [], {}, { ...base, lines: "no" }, { ...base, sale: null }, { ...base, exchangeable: "yes" },
      { ...base, lines: [{ ...base.lines[0], quantity: 10 }] },
      { ...base, lines: [{ ...base.lines[0], exchangedQuantity: "01" }] },
      { ...base, lines: [{ ...base.lines[0], remainingQuantity: "999" }] }, // not quantity - exchanged
      { ...base, lines: [{ ...base.lines[0], saleItemId: "nope" }] },
      { ...base, lines: [base.lines[0], base.lines[0]] },
      { ...base, sale: { ...base.sale, id: 5 } },
    ];
    for (const raw of cases) expect(validateFreshRead(raw, expected()), JSON.stringify(raw)).toEqual({ ok: false, reason: "READ_INVALID" });
  });

  it("READ-03 identity: sale id, branch and sale number must be the requested ones (ids compared case-insensitively)", () => {
    expect(validateFreshRead(freshRead({ saleId: SALE.toUpperCase() }), expected()).ok).toBe(true);
    for (const raw of [freshRead({ saleId: randomUUID() }), freshRead({ branchId: "other" }), freshRead({ saleNumber: "T-2" })]) {
      expect(validateFreshRead(raw, expected())).toEqual({ ok: false, reason: "READ_MISMATCH" });
    }
  });

  it("READ-04 watermarks: the read must show AT LEAST before + returned, per item, in BigInt", () => {
    expect(validateFreshRead(freshRead(), expected(marks("4", "1"))).ok).toBe(true);
    expect(validateFreshRead(freshRead(), expected(marks("5", "1")))).toEqual({ ok: false, reason: "READ_STALE" });
    expect(validateFreshRead(freshRead(), expected(marks("4", "2")))).toEqual({ ok: false, reason: "READ_STALE" });
    const big = freshRead({ quantity: { a: "9007199254741000" }, exchanged: { a: "9007199254740992" } });
    expect(validateFreshRead(big, expected([{ saleItemId: ITEM_A, exchangedQuantityBefore: "9007199254740992", expectedExchangedQuantityAfter: "9007199254740993" }])))
      .toEqual({ ok: false, reason: "READ_STALE" });
  });

  it("READ-05 a watermark for an item the read does not have is READ_MISMATCH, and it wins over READ_STALE", () => {
    const raw = freshRead({ items: [ITEM_A] });
    expect(validateFreshRead(raw, expected(marks("99", "1")))).toEqual({ ok: false, reason: "READ_MISMATCH" });
  });

  it("READ-06 eligibility comes after freshness: not exchangeable, or nothing left", () => {
    expect(validateFreshRead(freshRead({ exchangeable: false }), expected())).toEqual({ ok: false, reason: "NOT_EXCHANGEABLE" });
    expect(validateFreshRead(freshRead({ status: "CANCELLED" }), expected())).toEqual({ ok: false, reason: "NOT_EXCHANGEABLE" });
    expect(validateFreshRead(freshRead({ quantity: { a: "4", b: "1" } }), expected())).toEqual({ ok: false, reason: "NOTHING_LEFT_TO_EXCHANGE" });
    expect(validateFreshRead(freshRead({ quantity: { a: "4", b: "1" }, exchanged: { a: "3" } }), expected(marks("4", "1")))).toEqual({ ok: false, reason: "READ_STALE" });
  });

  it("READ-07 draftLinesFromFreshRead builds draft lines whose baseline IS the read's exchangedQuantity", () => {
    const result = validateFreshRead(freshRead({ quantity: { a: "4", b: "5" }, exchanged: { a: "4", b: "1" } }), expected());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(draftLinesFromFreshRead(result.read)).toEqual([
        { saleItemId: ITEM_B, replacementVariantId: null, replacementLabel: "", returnQuantity: "", exchangedQuantityBefore: "1" },
      ]);
    }
  });
});
