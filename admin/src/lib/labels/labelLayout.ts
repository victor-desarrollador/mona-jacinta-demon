// A4 label sheet geometry, pagination and quantity limits. Pure functions.
//
// ADM-15-A: provisional layout (2 columns x 7 rows of 70x37 mm labels) pending
// physical validation in ADM-15-B. The numbers below are not business rules.

export type LayoutConfig = {
  sheetWidthMm: number;
  sheetHeightMm: number;
  labelWidthMm: number;
  labelHeightMm: number;
  // Applied symmetrically: the same margin is kept on the opposite side.
  marginTopMm: number;
  marginLeftMm: number;
  gapHorizontalMm: number;
  gapVerticalMm: number;
};

export const DEFAULT_LAYOUT: Readonly<LayoutConfig> = Object.freeze({
  sheetWidthMm: 210,
  sheetHeightMm: 297,
  labelWidthMm: 70,
  labelHeightMm: 37,
  marginTopMm: 10,
  marginLeftMm: 10,
  gapHorizontalMm: 2,
  gapVerticalMm: 2,
});

// Provisional ADM-15-A limits.
export const MAX_QUANTITY_PER_VARIANT = 200;
export const MAX_LABELS_PER_SELECTION = 1000;

// Guard against degenerate configurations producing thousands of slots.
const MIN_LABEL_MM = 10;
const EPSILON = 1e-9;

export type Slot = { index: number; column: number; row: number; xMm: number; yMm: number };

export type LayoutResult =
  | { ok: true; columns: number; rows: number; perSheet: number; slots: Slot[] }
  | { ok: false; code: 'INVALID_CONFIG' | 'LAYOUT_NO_FIT' };

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const roundMm = (value: number) => Math.round(value * 1000) / 1000;

function mergeConfig(overrides: Partial<Record<keyof LayoutConfig, unknown>>): Record<keyof LayoutConfig, unknown> {
  const merged: Record<string, unknown> = { ...DEFAULT_LAYOUT };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged as Record<keyof LayoutConfig, unknown>;
}

export function computeLayout(overrides: Partial<Record<keyof LayoutConfig, unknown>> = {}): LayoutResult {
  const config = mergeConfig(overrides);
  const values = Object.values(config);
  if (!values.every(isFiniteNumber)) return { ok: false, code: 'INVALID_CONFIG' };
  const c = config as LayoutConfig;

  const positiveOk = c.sheetWidthMm > 0 && c.sheetHeightMm > 0;
  const labelOk = c.labelWidthMm >= MIN_LABEL_MM && c.labelHeightMm >= MIN_LABEL_MM;
  const nonNegativeOk = c.marginTopMm >= 0 && c.marginLeftMm >= 0 && c.gapHorizontalMm >= 0 && c.gapVerticalMm >= 0;
  if (!positiveOk || !labelOk || !nonNegativeOk) return { ok: false, code: 'INVALID_CONFIG' };

  const usableWidth = c.sheetWidthMm - 2 * c.marginLeftMm;
  const usableHeight = c.sheetHeightMm - 2 * c.marginTopMm;
  const columns = Math.floor((usableWidth + c.gapHorizontalMm) / (c.labelWidthMm + c.gapHorizontalMm) + EPSILON);
  const rows = Math.floor((usableHeight + c.gapVerticalMm) / (c.labelHeightMm + c.gapVerticalMm) + EPSILON);
  if (usableWidth <= 0 || usableHeight <= 0 || columns < 1 || rows < 1) return { ok: false, code: 'LAYOUT_NO_FIT' };

  const slots: Slot[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      slots.push({
        index: row * columns + column,
        column,
        row,
        xMm: roundMm(c.marginLeftMm + column * (c.labelWidthMm + c.gapHorizontalMm)),
        yMm: roundMm(c.marginTopMm + row * (c.labelHeightMm + c.gapVerticalMm)),
      });
    }
  }
  return { ok: true, columns, rows, perSheet: columns * rows, slots };
}

export function validateQuantity(value: unknown): { ok: true; quantity: number } | { ok: false; code: 'INVALID_QUANTITY' } {
  if (Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_QUANTITY_PER_VARIANT) {
    return { ok: true, quantity: value as number };
  }
  return { ok: false, code: 'INVALID_QUANTITY' };
}

export function validateSelectionTotal(
  total: unknown,
): { ok: true; total: number } | { ok: false; code: 'INVALID_TOTAL' | 'TOTAL_EXCEEDS_LIMIT' } {
  if (!Number.isInteger(total) || (total as number) < 0) return { ok: false, code: 'INVALID_TOTAL' };
  if ((total as number) > MAX_LABELS_PER_SELECTION) return { ok: false, code: 'TOTAL_EXCEEDS_LIMIT' };
  return { ok: true, total: total as number };
}

export type SheetPlan = { startSlot: number; count: number };

// Splits `totalLabels` over sheets of `perSheet` slots. `startSlot` (0-based)
// only applies to the first sheet; later sheets start at slot 0.
export function paginate(
  totalLabels: unknown,
  perSheet: unknown,
  startSlot: unknown = 0,
):
  | { ok: true; sheets: SheetPlan[] }
  | { ok: false; code: 'INVALID_TOTAL' | 'INVALID_PER_SHEET' | 'START_OUT_OF_RANGE' } {
  if (!Number.isInteger(totalLabels) || (totalLabels as number) < 0) return { ok: false, code: 'INVALID_TOTAL' };
  if (!Number.isInteger(perSheet) || (perSheet as number) < 1) return { ok: false, code: 'INVALID_PER_SHEET' };
  const capacity = perSheet as number;
  if (!Number.isInteger(startSlot) || (startSlot as number) < 0 || (startSlot as number) >= capacity) {
    return { ok: false, code: 'START_OUT_OF_RANGE' };
  }

  const sheets: SheetPlan[] = [];
  let remaining = totalLabels as number;
  let start = startSlot as number;
  while (remaining > 0) {
    const count = Math.min(remaining, capacity - start);
    sheets.push({ startSlot: start, count });
    remaining -= count;
    start = 0;
  }
  return { ok: true, sheets };
}

// ---- Label box model shared by the preview (and later by ADM-15-B printing).
// The label is rendered with box-sizing: border-box, so the barcode area is the
// label width minus the border and the horizontal padding on both sides.
export const LABEL_BORDER_MM = 0.3;
export const LABEL_PADDING_X_MM = 1.8;
// Quiet zone drawn on each side of the barcode, in modules.
export const QUIET_ZONE_MODULES = 10;
// PROVISIONAL (ADM-15-A): 0.19 mm is roughly 7.5 mil. It is a warning
// threshold taken from general barcode-printing practice, not a requirement of
// this project and not a legibility guarantee: only a physical print and scan
// test (ADM-15-B) can establish readability.
export const MIN_MODULE_WIDTH_MM = 0.19;
// PROVISIONAL human-readable text range, in points.
export const HUMAN_TEXT_MAX_PT = 7;
export const HUMAN_TEXT_MIN_PT = 5;
// Approximate advance of a monospace glyph, as a fraction of the font size.
const HUMAN_TEXT_EM_PER_CHAR = 0.6;
const MM_PER_PT = 25.4 / 72;
const MM_PER_MIL = 0.0254;
const MODULE_EPSILON = 1e-9;
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export type PrintableWidth = { ok: true; widthMm: number } | { ok: false; code: 'INVALID_LABEL_WIDTH' };

export function printableWidthMm(labelWidthMm: unknown): PrintableWidth {
  if (!isFiniteNumber(labelWidthMm)) return { ok: false, code: 'INVALID_LABEL_WIDTH' };
  const widthMm = round6(labelWidthMm - 2 * (LABEL_BORDER_MM + LABEL_PADDING_X_MM));
  if (!(widthMm > 0)) return { ok: false, code: 'INVALID_LABEL_WIDTH' };
  return { ok: true, widthMm };
}

export type BarcodeMetrics =
  | { ok: true; moduleWidthMm: number; moduleMils: number; belowMinimum: boolean }
  | { ok: false; code: 'INVALID_LABEL_WIDTH' | 'INVALID_MODULES' };

// `modules` is the encoded width without quiet zones (Code128Encoded.width). The
// barcode is stretched to the printable width, so the module width follows from
// the geometry, never from the font or the content.
export function barcodeMetrics(modules: unknown, labelWidthMm: unknown): BarcodeMetrics {
  const printable = printableWidthMm(labelWidthMm);
  if (!printable.ok) return { ok: false, code: 'INVALID_LABEL_WIDTH' };
  if (!Number.isInteger(modules) || (modules as number) < 1) return { ok: false, code: 'INVALID_MODULES' };
  const moduleWidthMm = printable.widthMm / ((modules as number) + 2 * QUIET_ZONE_MODULES);
  return {
    ok: true,
    moduleWidthMm,
    moduleMils: moduleWidthMm / MM_PER_MIL,
    belowMinimum: moduleWidthMm < MIN_MODULE_WIDTH_MM - MODULE_EPSILON,
  };
}

export type HumanTextFit =
  | { ok: true; fontPt: number; fits: boolean }
  | { ok: false; code: 'INVALID_LABEL_WIDTH' | 'INVALID_CHARS' };

// Largest font size (<= HUMAN_TEXT_MAX_PT, floored to 0.1 pt) at which `chars`
// monospace characters fit on one line. `fits` is false below HUMAN_TEXT_MIN_PT.
export function fitHumanText(chars: unknown, labelWidthMm: unknown): HumanTextFit {
  const printable = printableWidthMm(labelWidthMm);
  if (!printable.ok) return { ok: false, code: 'INVALID_LABEL_WIDTH' };
  if (!Number.isInteger(chars) || (chars as number) < 1) return { ok: false, code: 'INVALID_CHARS' };
  const needed = printable.widthMm / ((chars as number) * HUMAN_TEXT_EM_PER_CHAR * MM_PER_PT);
  const fontPt = Math.min(HUMAN_TEXT_MAX_PT, Math.floor(needed * 10 + MODULE_EPSILON) / 10);
  return { ok: true, fontPt, fits: fontPt >= HUMAN_TEXT_MIN_PT };
}
