import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LAYOUT,
  HUMAN_TEXT_MAX_PT,
  HUMAN_TEXT_MIN_PT,
  LABEL_BORDER_MM,
  LABEL_PADDING_X_MM,
  MAX_LABELS_PER_SELECTION,
  MIN_MODULE_WIDTH_MM,
  QUIET_ZONE_MODULES,
  barcodeMetrics,
  fitHumanText,
  printableWidthMm,
  MAX_QUANTITY_PER_VARIANT,
  computeLayout,
  paginate,
  validateQuantity,
  validateSelectionTotal,
} from '../../src/lib/labels/labelLayout.ts';

test('provisional limits: 200 labels per variant, 1000 labels per selection', () => {
  assert.equal(MAX_QUANTITY_PER_VARIANT, 200);
  assert.equal(MAX_LABELS_PER_SELECTION, 1000);
});

test('default layout is A4 with 70x37 mm labels, 10 mm margins and 2 mm gaps', () => {
  assert.deepEqual(DEFAULT_LAYOUT, {
    sheetWidthMm: 210,
    sheetHeightMm: 297,
    labelWidthMm: 70,
    labelHeightMm: 37,
    marginTopMm: 10,
    marginLeftMm: 10,
    gapHorizontalMm: 2,
    gapVerticalMm: 2,
  });
});

test('default layout yields 2 columns x 7 rows = 14 labels per sheet', () => {
  const layout = computeLayout();
  assert.equal(layout.ok, true);
  assert.equal(layout.columns, 2);
  assert.equal(layout.rows, 7);
  assert.equal(layout.perSheet, 14);
  assert.equal(layout.slots.length, 14);
});

test('default slot positions in mm: slot 0 (10,10), slot 1 (82,10), slot 2 (10,49), slot 13 (82,244)', () => {
  const { slots } = computeLayout();
  assert.deepEqual(
    [slots[0], slots[1], slots[2], slots[13]].map(({ index, column, row, xMm, yMm }) => [index, column, row, xMm, yMm]),
    [
      [0, 0, 0, 10, 10],
      [1, 1, 0, 82, 10],
      [2, 0, 1, 10, 49],
      [13, 1, 6, 82, 244],
    ],
  );
});

test('no slot overflows the printable area (margin kept on every side)', () => {
  const layout = computeLayout();
  for (const slot of layout.slots) {
    assert.ok(slot.xMm >= 10 && slot.yMm >= 10);
    assert.ok(slot.xMm + 70 <= 210 - 10, `slot ${slot.index} right edge`);
    assert.ok(slot.yMm + 37 <= 297 - 10, `slot ${slot.index} bottom edge`);
  }
});

test('layout is configurable: zero margins and gaps fit 3 columns x 8 rows', () => {
  const layout = computeLayout({ marginTopMm: 0, marginLeftMm: 0, gapHorizontalMm: 0, gapVerticalMm: 0 });
  assert.equal(layout.ok, true);
  assert.equal(layout.columns, 3);
  assert.equal(layout.rows, 8);
  assert.equal(layout.perSheet, 24);
});

test('a partial override keeps the remaining defaults and does not mutate DEFAULT_LAYOUT', () => {
  const before = JSON.stringify(DEFAULT_LAYOUT);
  // Symmetric 34 mm side margins leave exactly 142 mm = 2 x 70 + 2 gap.
  const layout = computeLayout({ marginLeftMm: 34 });
  assert.equal(layout.ok, true);
  assert.equal(layout.columns, 2);
  assert.equal(computeLayout({ marginLeftMm: 35 }).columns, 1);
  assert.equal(JSON.stringify(DEFAULT_LAYOUT), before);
  assert.throws(() => {
    DEFAULT_LAYOUT.marginLeftMm = 0;
  }, TypeError);
});

test('adversarial: a label wider than the printable width returns LAYOUT_NO_FIT', () => {
  assert.deepEqual(computeLayout({ labelWidthMm: 200 }), { ok: false, code: 'LAYOUT_NO_FIT' });
  assert.deepEqual(computeLayout({ labelHeightMm: 300 }), { ok: false, code: 'LAYOUT_NO_FIT' });
  assert.deepEqual(computeLayout({ marginLeftMm: 100 }), { ok: false, code: 'LAYOUT_NO_FIT' });
});

test('adversarial: non-finite, zero or negative dimensions return INVALID_CONFIG', () => {
  for (const bad of [
    { labelWidthMm: 0 },
    { labelHeightMm: -5 },
    { sheetWidthMm: Number.NaN },
    { sheetHeightMm: Number.POSITIVE_INFINITY },
    { marginTopMm: -1 },
    { gapHorizontalMm: -0.5 },
    { gapVerticalMm: Number.NaN },
    { marginLeftMm: '10' },
  ]) {
    assert.deepEqual(computeLayout(bad), { ok: false, code: 'INVALID_CONFIG' }, JSON.stringify(bad));
  }
});

test('adversarial quantity: only integers from 1 to 200 are accepted', () => {
  assert.deepEqual(validateQuantity(1), { ok: true, quantity: 1 });
  assert.deepEqual(validateQuantity(200), { ok: true, quantity: 200 });
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 201, 1_000_000, '10', null, undefined, {}, [], true]) {
    assert.deepEqual(validateQuantity(bad), { ok: false, code: 'INVALID_QUANTITY' }, String(bad));
  }
});

test('selection total: 1000 is accepted, 1001 is TOTAL_EXCEEDS_LIMIT, junk is INVALID_TOTAL', () => {
  assert.deepEqual(validateSelectionTotal(0), { ok: true, total: 0 });
  assert.deepEqual(validateSelectionTotal(1000), { ok: true, total: 1000 });
  assert.deepEqual(validateSelectionTotal(1001), { ok: false, code: 'TOTAL_EXCEEDS_LIMIT' });
  for (const bad of [-1, 1.5, Number.NaN, '5', null]) {
    assert.deepEqual(validateSelectionTotal(bad), { ok: false, code: 'INVALID_TOTAL' }, String(bad));
  }
});

test('pagination: 15 labels on 14-slot sheets from slot 0 gives [14, 1]; 14 gives [14]', () => {
  assert.deepEqual(paginate(15, 14, 0), {
    ok: true,
    sheets: [
      { startSlot: 0, count: 14 },
      { startSlot: 0, count: 1 },
    ],
  });
  assert.deepEqual(paginate(14, 14, 0), { ok: true, sheets: [{ startSlot: 0, count: 14 }] });
});

test('pagination: a start slot only affects the first sheet (15 labels, start 3 gives [11, 4])', () => {
  assert.deepEqual(paginate(15, 14, 3), {
    ok: true,
    sheets: [
      { startSlot: 3, count: 11 },
      { startSlot: 0, count: 4 },
    ],
  });
});

test('pagination: the start slot defaults to 0 and 0 labels produce no sheets', () => {
  assert.deepEqual(paginate(1, 14), { ok: true, sheets: [{ startSlot: 0, count: 1 }] });
  assert.deepEqual(paginate(0, 14, 0), { ok: true, sheets: [] });
});

test('pagination: the last slot is valid and fills exactly one label', () => {
  assert.deepEqual(paginate(1, 14, 13), { ok: true, sheets: [{ startSlot: 13, count: 1 }] });
  assert.deepEqual(paginate(2, 14, 13), {
    ok: true,
    sheets: [
      { startSlot: 13, count: 1 },
      { startSlot: 0, count: 1 },
    ],
  });
});

test('adversarial pagination: start slot out of range, bad totals and bad capacity', () => {
  assert.deepEqual(paginate(5, 14, 14), { ok: false, code: 'START_OUT_OF_RANGE' });
  assert.deepEqual(paginate(5, 14, -1), { ok: false, code: 'START_OUT_OF_RANGE' });
  assert.deepEqual(paginate(5, 14, 1.5), { ok: false, code: 'START_OUT_OF_RANGE' });
  assert.deepEqual(paginate(-1, 14, 0), { ok: false, code: 'INVALID_TOTAL' });
  assert.deepEqual(paginate(Number.NaN, 14, 0), { ok: false, code: 'INVALID_TOTAL' });
  assert.deepEqual(paginate(5, 0, 0), { ok: false, code: 'INVALID_PER_SHEET' });
  assert.deepEqual(paginate(5, 2.5, 0), { ok: false, code: 'INVALID_PER_SHEET' });
});

test('pagination: sheet counts always add up to the requested total', () => {
  for (const [total, perSheet, start] of [[1000, 14, 0], [999, 14, 5], [27, 14, 13], [14, 14, 0], [13, 14, 1]]) {
    const result = paginate(total, perSheet, start);
    assert.equal(result.ok, true);
    assert.equal(result.sheets.reduce((sum, sheet) => sum + sheet.count, 0), total);
    for (const sheet of result.sheets) assert.ok(sheet.count >= 1 && sheet.startSlot + sheet.count <= perSheet);
  }
});

test('adversarial: labels below the 10 mm minimum are INVALID_CONFIG instead of producing thousands of slots', () => {
  assert.deepEqual(computeLayout({ labelWidthMm: 0.5, labelHeightMm: 0.5 }), { ok: false, code: 'INVALID_CONFIG' });
  assert.deepEqual(computeLayout({ labelWidthMm: 9.99 }), { ok: false, code: 'INVALID_CONFIG' });
});

test('undefined overrides fall back to the defaults', () => {
  assert.deepEqual(computeLayout({ marginLeftMm: undefined }), computeLayout());
});

// ---- F-06: horizontal and vertical gaps are independent (kills the gap-axis mutants)
test('F-06 asymmetric gaps A: the horizontal gap alone limits the columns (60 mm labels, gap 10/0 -> 2 x 7)', () => {
  const layout = computeLayout({ labelWidthMm: 60, gapHorizontalMm: 10, gapVerticalMm: 0 });
  assert.equal(layout.ok, true);
  assert.deepEqual([layout.columns, layout.rows, layout.perSheet], [2, 7, 14]);
});

test('F-06 asymmetric gaps B: the vertical gap alone limits the rows (gap 0/10 -> 2 x 6)', () => {
  const layout = computeLayout({ gapHorizontalMm: 0, gapVerticalMm: 10 });
  assert.equal(layout.ok, true);
  assert.deepEqual([layout.columns, layout.rows, layout.perSheet], [2, 6, 12]);
});

test('F-06 asymmetric gaps and margins C: top 12, left 8, gaps 6/1 -> 2 x 7, slot 1 (84,12), slot 2 (8,50)', () => {
  const layout = computeLayout({ marginTopMm: 12, marginLeftMm: 8, gapHorizontalMm: 6, gapVerticalMm: 1 });
  assert.equal(layout.ok, true);
  assert.deepEqual([layout.columns, layout.rows], [2, 7]);
  assert.deepEqual([layout.slots[1].xMm, layout.slots[1].yMm], [84, 12]);
  assert.deepEqual([layout.slots[2].xMm, layout.slots[2].yMm], [8, 50]);
});

test('F-06 non-equal margins D: top 20, left 5 -> 2 x 6, slot 1 (77,20), slot 2 (5,59)', () => {
  const layout = computeLayout({ marginTopMm: 20, marginLeftMm: 5 });
  assert.equal(layout.ok, true);
  assert.deepEqual([layout.columns, layout.rows, layout.perSheet], [2, 6, 12]);
  assert.deepEqual([layout.slots[1].xMm, layout.slots[1].yMm], [77, 20]);
  assert.deepEqual([layout.slots[2].xMm, layout.slots[2].yMm], [5, 59]);
});

// ---- F-03: real module width and human-readable text fitting (warn only; never a legibility claim)
const close = (actual, expected, tolerance = 5e-5) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test('F-03 constants: border 0.3 mm, padding 1.8 mm, quiet zone 10 modules, provisional minimum 0.19 mm, text 5-7 pt', () => {
  assert.equal(LABEL_BORDER_MM, 0.3);
  assert.equal(LABEL_PADDING_X_MM, 1.8);
  assert.equal(QUIET_ZONE_MODULES, 10);
  assert.equal(MIN_MODULE_WIDTH_MM, 0.19);
  assert.equal(HUMAN_TEXT_MAX_PT, 7);
  assert.equal(HUMAN_TEXT_MIN_PT, 5);
});

test('F-03 printable width: a 70 mm label leaves 65.8 mm; 4.3 mm leaves 0.1 mm', () => {
  assert.deepEqual(printableWidthMm(70), { ok: true, widthMm: 65.8 });
  assert.deepEqual(printableWidthMm(4.3), { ok: true, widthMm: 0.1 });
});

test('F-03 adversarial printable width: NaN, 0, 4.2 (nothing left), negative, strings and null are INVALID_LABEL_WIDTH', () => {
  for (const bad of [Number.NaN, 0, 4.2, 1, -70, Number.POSITIVE_INFINITY, '70', null, undefined, {}]) {
    assert.deepEqual(printableWidthMm(bad), { ok: false, code: 'INVALID_LABEL_WIDTH' }, String(bad));
  }
});

test('F-03 module width on the default label: 14 chars (209 modules incl. quiet zone) -> 0.3148 mm, 12.4 mils, not below', () => {
  const metrics = barcodeMetrics(11 * 14 + 35, 70);
  assert.equal(metrics.ok, true);
  close(metrics.moduleWidthMm, 0.3148);
  close(metrics.moduleMils, 12.4, 0.05);
  assert.equal(metrics.belowMinimum, false);
});

test('F-03 threshold boundary: 26 chars -> 0.1930 mm (not below), 27 chars -> 0.1869 mm (below), 64 chars -> 0.0867 mm (below)', () => {
  const at26 = barcodeMetrics(11 * 26 + 35, 70);
  const at27 = barcodeMetrics(11 * 27 + 35, 70);
  const at64 = barcodeMetrics(11 * 64 + 35, 70);
  close(at26.moduleWidthMm, 0.193);
  assert.equal(at26.belowMinimum, false);
  close(at27.moduleWidthMm, 0.1869);
  assert.equal(at27.belowMinimum, true);
  close(at64.moduleWidthMm, 0.0867);
  assert.equal(at64.belowMinimum, true);
});

test('F-03 a wider label helps: 64 chars on a 100 mm label -> 0.1262 mm, still below the minimum', () => {
  const metrics = barcodeMetrics(11 * 64 + 35, 100);
  close(metrics.moduleWidthMm, 0.1262);
  assert.equal(metrics.belowMinimum, true);
});

test('F-03 a module exactly at the minimum is not below it (46 modules on a 16.74 mm label)', () => {
  const metrics = barcodeMetrics(46, 16.74);
  assert.equal(metrics.ok, true);
  close(metrics.moduleWidthMm, 0.19, 1e-9);
  assert.equal(metrics.belowMinimum, false);
});

test('F-03 adversarial module metrics: invalid modules or label width are rejected, label width is checked first', () => {
  for (const bad of [0, -1, 1.5, Number.NaN, '46', null, undefined]) {
    assert.deepEqual(barcodeMetrics(bad, 70), { ok: false, code: 'INVALID_MODULES' }, String(bad));
  }
  assert.deepEqual(barcodeMetrics(46, Number.NaN), { ok: false, code: 'INVALID_LABEL_WIDTH' });
  assert.deepEqual(barcodeMetrics(0, 0), { ok: false, code: 'INVALID_LABEL_WIDTH' });
});

test('F-03 human text: up to 44 chars fit at 7 pt, 45 chars need 6.9 pt, 64 chars need 4.8 pt and do not fit', () => {
  assert.deepEqual(fitHumanText(44, 70), { ok: true, fontPt: 7, fits: true });
  assert.deepEqual(fitHumanText(45, 70), { ok: true, fontPt: 6.9, fits: true });
  assert.deepEqual(fitHumanText(64, 70), { ok: true, fontPt: 4.8, fits: false });
  assert.deepEqual(fitHumanText(1, 70), { ok: true, fontPt: 7, fits: true });
});

test('F-03 human text on a wider label: 64 chars fit at 7 pt on 100 mm', () => {
  assert.deepEqual(fitHumanText(64, 100), { ok: true, fontPt: 7, fits: true });
});

test('F-03 adversarial human text: bad character counts and widths are rejected', () => {
  for (const bad of [0, -3, 1.5, Number.NaN, '5', null]) {
    assert.deepEqual(fitHumanText(bad, 70), { ok: false, code: 'INVALID_CHARS' }, String(bad));
  }
  assert.deepEqual(fitHumanText(10, 3), { ok: false, code: 'INVALID_LABEL_WIDTH' });
});
