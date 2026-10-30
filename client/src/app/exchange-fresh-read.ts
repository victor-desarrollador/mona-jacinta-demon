import type { ExchangeLineDraft } from "./exchange-types";

// The pure half of reconcileAfterFreshRead: is this body a trustworthy, FRESH read of THIS sale in THIS branch?
//
// GET /sales/exchangeable tells, per SaleItem, how much was sold, how much earlier exchanges already took back and how much is left. After
// an exchange was CONFIRMED the store keeps, per item, a WATERMARK: the quantity exchanged BEFORE the attempt (taken from the read that
// opened the draft) and the quantity the read must show AFTER it (before + returned). A read that shows less than that watermark cannot
// have seen the confirmed exchange. "At least what was returned" would not prove it: with 2 exchanged before and 1 returned, an old read
// that still says 2 satisfies 2 >= 1. All quantities are canonical decimal strings; every comparison is BigInt, never Number.

export type Watermark = { saleItemId: string; exchangedQuantityBefore: string; expectedExchangedQuantityAfter: string };

export type FreshReadLine = {
  saleItemId: string;
  variantId: string;
  quantity: string;
  exchangedQuantity: string;
  remainingQuantity: string;
};

export type FreshRead = {
  sale: { id: string; saleNumber: string; branchId: string; status: string };
  exchangeable: boolean;
  lines: FreshReadLine[];
};

// What a draft may still add or return per item, straight from the read. The only source of a line's baseline.
export type AvailableLine = { saleItemId: string; variantId: string; exchangedQuantityBefore: string; remainingQuantity: string };

export type FreshReadFailure = "READ_INVALID" | "READ_MISMATCH" | "READ_STALE" | "NOT_EXCHANGEABLE" | "NOTHING_LEFT_TO_EXCHANGE";
export type FreshReadVerdict = { ok: true; read: FreshRead } | { ok: false; reason: FreshReadFailure };

export type FreshReadExpectation = {
  // Null when the read is what DEFINES the sale (opening a draft): then only branch and sale number are checked, and the id is the read's.
  saleId: string | null;
  branchId: string;
  saleNumber: string;
  // Null when the store holds no confirmed attempt to check against (a sale whose record was resolved elsewhere).
  watermarks: Watermark[] | null;
};

const ZERO = BigInt(0);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isDecimal = (value: unknown): value is string => typeof value === "string" && DECIMAL.test(value);

function parseRead(raw: unknown): FreshRead | null {
  if (!isRecord(raw) || !isRecord(raw.sale) || typeof raw.exchangeable !== "boolean" || !Array.isArray(raw.lines)) return null;
  const { id, saleNumber, branchId, status } = raw.sale;
  if (typeof id !== "string" || !UUID.test(id) || !isText(saleNumber) || !isText(branchId) || !isText(status)) return null;
  const lines: FreshReadLine[] = [];
  const seen = new Set<string>();
  for (const row of raw.lines) {
    if (!isRecord(row)) return null;
    const { saleItemId, variantId, quantity, exchangedQuantity, remainingQuantity } = row;
    if (typeof saleItemId !== "string" || !UUID.test(saleItemId) || !isText(variantId)) return null;
    if (!isDecimal(quantity) || !isDecimal(exchangedQuantity) || !isDecimal(remainingQuantity)) return null;
    const sold = BigInt(quantity);
    const taken = BigInt(exchangedQuantity);
    if (BigInt(remainingQuantity) !== (sold > taken ? sold - taken : ZERO)) return null;
    if (seen.has(saleItemId.toLowerCase())) return null;
    seen.add(saleItemId.toLowerCase());
    lines.push({ saleItemId, variantId, quantity, exchangedQuantity, remainingQuantity });
  }
  return { sale: { id, saleNumber, branchId, status }, exchangeable: raw.exchangeable, lines };
}

// Order of the verdicts: shape, identity, watermark (a read that is not about this sale, or that predates the exchange, says nothing else
// worth trusting), then whether anything can be exchanged at all.
export function validateFreshRead(raw: unknown, expected: FreshReadExpectation): FreshReadVerdict {
  const read = parseRead(raw);
  if (!read) return { ok: false, reason: "READ_INVALID" };
  if ((expected.saleId !== null && read.sale.id.toLowerCase() !== expected.saleId.toLowerCase()) || read.sale.branchId !== expected.branchId || read.sale.saleNumber !== expected.saleNumber) {
    return { ok: false, reason: "READ_MISMATCH" };
  }
  if (expected.watermarks) {
    const byItem = new Map(read.lines.map((row) => [row.saleItemId.toLowerCase(), row]));
    const rows = expected.watermarks.map((mark) => byItem.get(mark.saleItemId.toLowerCase()));
    if (rows.some((row) => row === undefined)) return { ok: false, reason: "READ_MISMATCH" };
    const stale = expected.watermarks.some((mark, index) => BigInt(rows[index]!.exchangedQuantity) < BigInt(mark.expectedExchangedQuantityAfter));
    if (stale) return { ok: false, reason: "READ_STALE" };
  }
  if (!read.exchangeable || read.sale.status !== "COMPLETED") return { ok: false, reason: "NOT_EXCHANGEABLE" };
  if (!read.lines.some((row) => BigInt(row.remainingQuantity) > ZERO)) return { ok: false, reason: "NOTHING_LEFT_TO_EXCHANGE" };
  return { ok: true, read };
}

// The lines of a new draft, built from the read itself: only items with something left, the baseline being what the read says is already
// exchanged. The UI never types a baseline.
export function draftLinesFromFreshRead(read: FreshRead): ExchangeLineDraft[] {
  return read.lines
    .filter((row) => BigInt(row.remainingQuantity) > ZERO)
    .map((row) => ({ saleItemId: row.saleItemId, replacementVariantId: null, replacementLabel: "", returnQuantity: "", exchangedQuantityBefore: row.exchangedQuantity }));
}

export function availableLinesFromFreshRead(read: FreshRead): AvailableLine[] {
  return read.lines.map((row) => ({ saleItemId: row.saleItemId, variantId: row.variantId, exchangedQuantityBefore: row.exchangedQuantity, remainingQuantity: row.remainingQuantity }));
}
