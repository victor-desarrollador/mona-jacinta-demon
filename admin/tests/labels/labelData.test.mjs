import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as labelDataModule from '../../src/lib/labels/labelData.ts';
import {
  LABELS_ACCESS_PERMISSION,
  MAX_NAME_LENGTH,
  MAX_SKU_DISPLAY_LENGTH,
  MAX_VARIANT_DISPLAY_LENGTH,
  buildLabels,
  canAccessLabels,
  expandCopies,
  shortenName,
  shortenText,
  summarizeExclusions,
} from '../../src/lib/labels/labelData.ts';
import { encodeCode128B } from '../../src/lib/labels/code128.ts';

const formatMoney = (cents) => `$${cents}`;
const formatVariant = (color, size) => [color, size].filter(Boolean).join(' / ') || 'Única';
const OPTIONS = { showPrice: false, formatMoney, formatVariant };
const WITH_PRICE = { ...OPTIONS, showPrice: true };

let counter = 0;
function variant(overrides = {}) {
  counter += 1;
  return {
    id: `v${counter}`,
    productId: 'p1',
    sku: `SKU-${counter}`,
    barcode: `BC-${counter}`,
    color: 'Azul',
    size: 'M',
    price: '999900',
    cashPrice: '850000',
    isActive: true,
    ...overrides,
  };
}
const product = (variants, overrides = {}) => ({
  id: 'p1',
  name: 'Remera básica',
  slug: 'remera-basica',
  description: null,
  category: { id: 'c1', name: 'Remeras' },
  brand: { id: 'b1', name: 'Mona' },
  variants,
  ...overrides,
});
const pick = (...ids) => ids.map((id) => ({ variantId: id, quantity: 1 }));
const reasons = (result) => result.excluded.map(({ variantId, reason }) => [variantId, reason]);


test('a valid selected variant becomes a label with the original barcode, SKU, name and color/size', () => {
  const a = variant({ id: 'a', sku: 'JEA-1', barcode: 'JEA-1', color: 'Negro', size: '42' });
  const result = buildLabels([product([a])], [{ variantId: 'a', quantity: 3 }], OPTIONS);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.labels.length, 1);
  const [label] = result.labels;
  assert.equal(label.variantId, 'a');
  assert.equal(label.sku, 'JEA-1');
  assert.equal(label.barcode, 'JEA-1');
  assert.equal(label.productName, 'Remera básica');
  assert.equal(label.variantText, 'Negro / 42');
  assert.equal(label.quantity, 3);
  assert.equal(label.priceText, null);
  assert.equal(label.encoded.ok, true);
  assert.deepEqual(label.encoded, encodeCode128B('JEA-1'));
  assert.equal(result.totalLabels, 3);
  assert.equal(result.totalError, null);
});

test('barcode is independent of the price: different cashPrice and price give identical modules', () => {
  const cheap = variant({ id: 'cheap', barcode: 'SAME-CODE-1', cashPrice: '1000', price: '1200' });
  const dear = variant({ id: 'dear', barcode: 'SAME-CODE-1', cashPrice: '2000', price: '2500' });
  // Same barcode value on two products would be an exact duplicate, so build each alone.
  const a = buildLabels([product([cheap])], pick('cheap'), WITH_PRICE).labels[0];
  const b = buildLabels([product([dear])], pick('dear'), WITH_PRICE).labels[0];
  assert.equal(a.priceText, '$1000');
  assert.equal(b.priceText, '$2000');
  assert.equal(a.encoded.modules, b.encoded.modules);
  assert.equal(a.barcode, 'SAME-CODE-1');
});

test('price switch off: no price text even when cashPrice exists', () => {
  const a = variant({ id: 'a' });
  const [label] = buildLabels([product([a])], pick('a'), OPTIONS).labels;
  assert.equal(label.priceText, null);
});

test('price switch on: prints cashPrice only, never the legacy price', () => {
  const a = variant({ id: 'a', cashPrice: '850000', price: '999900' });
  const [label] = buildLabels([product([a])], pick('a'), WITH_PRICE).labels;
  assert.equal(label.priceText, '$850000');
  assert.ok(!JSON.stringify(label).includes('999900'));
});

test('adversarial: price on and cashPrice null is excluded as PRICE_MISSING and never falls back to price', () => {
  const a = variant({ id: 'a', cashPrice: null, price: '999900' });
  const result = buildLabels([product([a])], pick('a'), WITH_PRICE);
  assert.deepEqual(result.labels, []);
  assert.deepEqual(reasons(result), [['a', 'PRICE_MISSING']]);
});

test('adversarial: price on and cashPrice not a positive integer string is PRICE_MISSING', () => {
  for (const bad of ['', '0', '-5', '12.5', 'abc', undefined]) {
    const a = variant({ id: 'a', cashPrice: bad });
    const result = buildLabels([product([a])], pick('a'), WITH_PRICE);
    assert.deepEqual(reasons(result), [['a', 'PRICE_MISSING']], JSON.stringify(bad));
  }
});

test('price off with cashPrice null still produces the label (continue without price)', () => {
  const a = variant({ id: 'a', cashPrice: null });
  const result = buildLabels([product([a])], pick('a'), OPTIONS);
  assert.equal(result.labels.length, 1);
  assert.deepEqual(result.excluded, []);
});

test('adversarial: inactive variant is excluded as INACTIVE', () => {
  const a = variant({ id: 'a', isActive: false });
  assert.deepEqual(reasons(buildLabels([product([a])], pick('a'), OPTIONS)), [['a', 'INACTIVE']]);
});

test('adversarial: barcode null, undefined, empty or whitespace-only is MISSING_BARCODE', () => {
  for (const bad of [null, undefined, '', '   ', '\t']) {
    const a = variant({ id: 'a', barcode: bad });
    assert.deepEqual(reasons(buildLabels([product([a])], pick('a'), OPTIONS)), [['a', 'MISSING_BARCODE']], JSON.stringify(bad));
  }
});

test('adversarial: barcode with leading or trailing whitespace is BARCODE_EDGE_WHITESPACE', () => {
  for (const bad of [' ABC', 'ABC ', ' ABC ']) {
    const a = variant({ id: 'a', barcode: bad });
    assert.deepEqual(reasons(buildLabels([product([a])], pick('a'), OPTIONS)), [['a', 'BARCODE_EDGE_WHITESPACE']], JSON.stringify(bad));
  }
});

test('adversarial: barcode not representable in Code 128-B is BARCODE_NOT_ENCODABLE', () => {
  for (const bad of ['Ñandú-1', 'COD😀', 'X'.repeat(65)]) {
    const a = variant({ id: 'a', barcode: bad });
    assert.deepEqual(reasons(buildLabels([product([a])], pick('a'), OPTIONS)), [['a', 'BARCODE_NOT_ENCODABLE']], JSON.stringify(bad));
  }
});

test('adversarial: an exact duplicate barcode between different variants blocks both, even if only one is selected', () => {
  const a = variant({ id: 'a', barcode: 'DUP-1' });
  const b = variant({ id: 'b', barcode: 'DUP-1' });
  const c = variant({ id: 'c', barcode: 'OK-1' });
  const result = buildLabels([product([a, b]), product([c], { id: 'p2' })], pick('a', 'c'), OPTIONS);
  assert.deepEqual(reasons(result), [['a', 'DUPLICATE_BARCODE']]);
  assert.deepEqual(result.labels.map((label) => label.variantId), ['c']);
  assert.deepEqual(result.duplicateGroups, [{ value: 'DUP-1', variantIds: ['a', 'b'] }]);
});

test('duplicates are detected across products of the inspected catalog, including inactive variants', () => {
  const a = variant({ id: 'a', barcode: 'DUP-2' });
  const b = variant({ id: 'b', barcode: 'DUP-2', isActive: false });
  const result = buildLabels([product([a]), product([b], { id: 'p2' })], pick('a'), OPTIONS);
  assert.deepEqual(reasons(result), [['a', 'DUPLICATE_BARCODE']]);
});

test('barcodes that differ only in case are reported as a separate potential conflict and do not block', () => {
  const a = variant({ id: 'a', barcode: 'abc-9' });
  const b = variant({ id: 'b', barcode: 'ABC-9' });
  const result = buildLabels([product([a, b])], pick('a', 'b'), OPTIONS);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.labels.length, 2);
  assert.deepEqual(result.duplicateGroups, []);
  assert.deepEqual(result.warnings, [{ code: 'DUPLICATE_BARCODE_CASE', value: 'abc-9', variantIds: ['a', 'b'] }]);
});

test('a barcode equal to another variant SKU is a potential conflict (CROSS_CODE) and does not block', () => {
  const a = variant({ id: 'a', sku: 'A-SKU', barcode: 'B-SKU' });
  const b = variant({ id: 'b', sku: 'B-SKU', barcode: 'B-BARCODE' });
  const result = buildLabels([product([a, b])], pick('a', 'b'), OPTIONS);
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.warnings, [{ code: 'CROSS_CODE', value: 'B-SKU', variantIds: ['a', 'b'] }]);
});

test('cross-code detection ignores case differences between a barcode and another SKU', () => {
  const a = variant({ id: 'a', sku: 'A-SKU', barcode: 'b-sku' });
  const b = variant({ id: 'b', sku: 'B-SKU', barcode: 'B-BARCODE' });
  const result = buildLabels([product([a, b])], pick('a'), OPTIONS);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['CROSS_CODE']);
});

test('a barcode equal to the variant\'s own SKU is NOT a conflict (the pilot import sets barcode = sku)', () => {
  const a = variant({ id: 'a', sku: 'SAME', barcode: 'SAME' });
  const b = variant({ id: 'b', sku: 'OTHER', barcode: 'OTHER' });
  const result = buildLabels([product([a, b])], pick('a', 'b'), OPTIONS);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(result.excluded, []);
  assert.deepEqual(result.duplicateGroups, []);
});

test('adversarial: unknown variant id is NOT_FOUND and a repeated selection entry is DUPLICATE_SELECTION', () => {
  const a = variant({ id: 'a' });
  const result = buildLabels(
    [product([a])],
    [
      { variantId: 'a', quantity: 1 },
      { variantId: 'ghost', quantity: 1 },
      { variantId: 'a', quantity: 2 },
    ],
    OPTIONS,
  );
  assert.deepEqual(reasons(result), [['ghost', 'NOT_FOUND'], ['a', 'DUPLICATE_SELECTION']]);
  assert.equal(result.labels.length, 1);
  assert.equal(result.labels[0].quantity, 1);
});

test('adversarial: invalid quantities are excluded as INVALID_QUANTITY', () => {
  const ids = ['q0', 'qneg', 'qfrac', 'qnan', 'qbig'];
  const vs = ids.map((id) => variant({ id }));
  const quantities = [0, -1, 1.5, Number.NaN, 201];
  const selection = ids.map((variantId, i) => ({ variantId, quantity: quantities[i] }));
  const result = buildLabels([product(vs)], selection, OPTIONS);
  assert.deepEqual(result.labels, []);
  assert.deepEqual(reasons(result), ids.map((id) => [id, 'INVALID_QUANTITY']));
});

test('empty selection is not an error: no labels, no exclusions', () => {
  const result = buildLabels([product([variant()])], [], OPTIONS);
  assert.deepEqual(result.labels, []);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.totalLabels, 0);
  assert.equal(result.totalError, null);
});

test('empty catalog with a selection reports NOT_FOUND', () => {
  assert.deepEqual(reasons(buildLabels([], pick('x'), OPTIONS)), [['x', 'NOT_FOUND']]);
});

test('selection total above 1000 is reported as TOTAL_EXCEEDS_LIMIT', () => {
  const vs = ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => variant({ id }));
  const selection = vs.map((v) => ({ variantId: v.id, quantity: 200 }));
  const over = buildLabels([product(vs)], selection, OPTIONS);
  assert.equal(over.totalLabels, 1200);
  assert.equal(over.totalError, 'TOTAL_EXCEEDS_LIMIT');
  const exact = buildLabels([product(vs)], selection.slice(0, 5), OPTIONS);
  assert.equal(exact.totalLabels, 1000);
  assert.equal(exact.totalError, null);
});

test('excluded variants do not count toward the total', () => {
  const a = variant({ id: 'a', isActive: false });
  const b = variant({ id: 'b' });
  const result = buildLabels([product([a, b])], [{ variantId: 'a', quantity: 200 }, { variantId: 'b', quantity: 2 }], OPTIONS);
  assert.equal(result.totalLabels, 2);
});

test('long product names are shortened to 28 characters for display and the original is preserved', () => {
  assert.equal(MAX_NAME_LENGTH, 28);
  const name = 'Remera de algodón peinado premium con estampa '.repeat(5);
  const a = variant({ id: 'a' });
  const [label] = buildLabels([product([a], { name })], pick('a'), OPTIONS).labels;
  assert.equal(label.productName, name);
  assert.equal(Array.from(label.productNameShort).length, 28);
  assert.ok(label.productNameShort.endsWith('…'));
});

test('shortenName: exact-limit names are untouched, line breaks and runs of spaces collapse, emoji are not split', () => {
  assert.equal(shortenName('x'.repeat(28)), 'x'.repeat(28));
  assert.equal(shortenName('x'.repeat(29)), `${'x'.repeat(27)}…`);
  assert.equal(shortenName('  Remera \n\t  azul  '), 'Remera azul');
  assert.equal(shortenName(''), '');
  const emoji = '😀'.repeat(40);
  const short = shortenName(emoji);
  assert.equal(Array.from(short).length, 28);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(short));
});

test('expandCopies repeats each label once per requested copy, in selection order', () => {
  const a = variant({ id: 'a' });
  const b = variant({ id: 'b' });
  const { labels } = buildLabels([product([a, b])], [{ variantId: 'b', quantity: 2 }, { variantId: 'a', quantity: 3 }], OPTIONS);
  assert.deepEqual(expandCopies(labels).map((label) => label.variantId), ['b', 'b', 'a', 'a', 'a']);
  assert.deepEqual(expandCopies([]), []);
});

test('buildLabels does not mutate its inputs', () => {
  const a = variant({ id: 'a' });
  const catalog = [product([a])];
  const selection = pick('a');
  const before = JSON.stringify([catalog, selection]);
  buildLabels(catalog, selection, WITH_PRICE);
  assert.equal(JSON.stringify([catalog, selection]), before);
});

// ---- static contract checks over the delivered sources ----
const here = dirname(fileURLToPath(import.meta.url));
const libDir = join(here, '..', '..', 'src', 'lib', 'labels');
const pagePath = join(here, '..', '..', 'src', 'pages', 'Labels.tsx');
const libFiles = readdirSync(libDir).filter((name) => name.endsWith('.ts'));
const read = (path) => readFileSync(path, 'utf8');
const stripComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

test('static contract: the delivered modules are exactly the four authorized lib files', () => {
  assert.deepEqual([...libFiles].sort(), ['code128.ts', 'labelCatalog.ts', 'labelData.ts', 'labelLayout.ts']);
});

test('static contract: lib/labels modules import only types from existing code and relative .ts siblings', () => {
  for (const file of libFiles) {
    const source = stripComments(read(join(libDir, file)));
    const imports = [...source.matchAll(/^\s*import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/gm)];
    for (const [, clause, specifier] of imports) {
      const typeOnly = /^type\s/.test(clause);
      const sibling = /^\.\/[A-Za-z0-9]+\.ts$/.test(specifier);
      assert.ok(typeOnly || sibling, `${file}: runtime import of ${specifier} is not allowed`);
    }
    assert.ok(!/\bimport\s*\(/.test(source), `${file}: dynamic import`);
    assert.ok(!/\brequire\s*\(/.test(source), `${file}: require`);
  }
});

test('static contract: no write path, no network call and no printing in ADM-15-A sources', () => {
  const sources = [...libFiles.map((file) => join(libDir, file)), pagePath].map((path) => [path, stripComments(read(path))]);
  for (const [path, source] of sources) {
    assert.ok(!/\bfetch\s*\(/.test(source), `${path}: fetch`);
    assert.ok(!/\bXMLHttpRequest\b/.test(source), `${path}: XMLHttpRequest`);
    assert.ok(!/['"`](POST|PUT|PATCH|DELETE)['"`]/.test(source), `${path}: write verb`);
    assert.ok(!/\bmethod\s*:/.test(source), `${path}: request method`);
    assert.ok(!/window\.print|\.print\s*\(/.test(source), `${path}: printing belongs to ADM-15-B`);
    assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source), `${path}: persistence`);
  }
});

test('static contract: the page reads the catalogue only through api.products', () => {
  const source = stripComments(read(pagePath));
  const calls = [...source.matchAll(/\bapi\.(\w+)/g)].map((match) => match[1]);
  assert.ok(calls.length > 0, 'page must load the catalogue');
  assert.deepEqual([...new Set(calls)], ['products']);
  assert.ok(/export\s+function\s+Labels\b/.test(source));
  assert.ok(/export\s+const\s+labelsRoute\b/.test(source));
});


// ======================= remediation regression tests (F-01 .. F-09) =======================

// ---- F-01: provisional visual gate = the projected admin-access string 'report.view'
// Shapes mirror what /auth/me really projects (legacy strings + 5 Production codes); LABEL_PRINT is never projected.
const OWNER_LIKE = ['sale.create', 'sale.charge', 'sale.complete', 'sale.view', 'sale.queue.view', 'inventory.view', 'inventory.manage', 'cash.session.open', 'cash.session.close', 'user.manage', 'report.view', 'audit.view', 'PRODUCT_MANAGE', 'PRODUCT_VARIANT_MANAGE', 'PRICE_MANAGE', 'IMPORT_RUN', 'CASH_MOVEMENT_MANAGE'];
const SELLER_LIKE = ['sale.create', 'sale.view', 'inventory.view'];
const CASHIER_LIKE = ['sale.charge', 'sale.complete', 'sale.view', 'sale.queue.view', 'inventory.view', 'cash.session.open', 'cash.session.close', 'CASH_MOVEMENT_MANAGE'];
const WAREHOUSE_LIKE = ['inventory.view', 'inventory.manage'];

test('F-01 the gate is the projected string report.view', () => {
  assert.equal(LABELS_ACCESS_PERMISSION, 'report.view');
});

test('F-01 an OWNER/ADMIN-shaped projection can access labels (defect: the old LABEL_PRINT gate denied everyone)', () => {
  assert.equal(canAccessLabels({ permissions: OWNER_LIKE }), true);
  assert.equal(canAccessLabels({ permissions: ['report.view'] }), true);
});

test('F-01 SELLER, CASHIER and WAREHOUSE-shaped projections (no report.view) cannot access labels', () => {
  for (const permissions of [SELLER_LIKE, CASHIER_LIKE, WAREHOUSE_LIKE]) {
    assert.equal(canAccessLabels({ permissions }), false);
  }
});

test('F-01 adversarial: LABEL_PRINT, REPORT_VIEW, case and whitespace variants do not pass', () => {
  for (const permissions of [['LABEL_PRINT'], ['REPORT_VIEW'], ['Report.View'], ['report.view '], [' report.view'], ['report_view'], ['report'], ['view']]) {
    assert.equal(canAccessLabels({ permissions }), false, JSON.stringify(permissions));
  }
});

test('F-01 adversarial: malformed users and non-array permissions are denied (a substring string must not pass)', () => {
  for (const user of [null, undefined, {}, { permissions: null }, { permissions: 'report.view' }, { permissions: 'xreport.viewx' }, { permissions: { includes: () => true } }, { permissions: [] }, 42, 'report.view']) {
    assert.equal(canAccessLabels(user), false, JSON.stringify(user));
  }
});

test('F-01 the previous LABEL_PRINT gate is gone from the module surface', () => {
  assert.equal('canPrintLabels' in labelDataModule, false);
  assert.equal('LABEL_PRINT_PERMISSION' in labelDataModule, false);
});

const authFile = join(here, '..', '..', 'src', 'lib', 'auth.ts');
const apiPermissionsFile = join(here, '..', '..', '..', 'api', 'src', 'shared', 'permissions.ts');

test('F-01 contract (skipped outside the full repo): the admin shell gate uses the same literal', (t) => {
  if (!existsSync(authFile)) return t.skip('admin/src/lib/auth.ts not present in this checkout');
  assert.match(readFileSync(authFile, 'utf8'), /canUseBackoffice[\s\S]*?permissions\.includes\('report\.view'\)/);
});

test('F-01 contract (skipped outside the full repo): the API projects report.view as the legacy public string', (t) => {
  if (!existsSync(apiPermissionsFile)) return t.skip('api/src/shared/permissions.ts not present in this checkout');
  assert.match(readFileSync(apiPermissionsFile, 'utf8'), /REPORT_VIEW:\s*'report\.view'/);
});

// ---- F-07: provisional 22-character display truncation (originals preserved)
test('F-07 display limits are 22 characters for SKU and variant', () => {
  assert.equal(MAX_SKU_DISPLAY_LENGTH, 22);
  assert.equal(MAX_VARIANT_DISPLAY_LENGTH, 22);
});

test('F-07 shortenText: exact limit untouched, one over is cut to limit with an ellipsis', () => {
  assert.equal(shortenText('x'.repeat(22), 22), 'x'.repeat(22));
  assert.equal(shortenText('x'.repeat(23), 22), `${'x'.repeat(21)}…`);
  assert.equal(shortenText('x'.repeat(23), 22).length, 22);
});

test('F-07 shortenText: whitespace collapses, emoji are never split, non-strings are empty', () => {
  assert.equal(shortenText('  Azul \n\t marino  ', 22), 'Azul marino');
  const short = shortenText('😀'.repeat(40), 22);
  assert.equal(Array.from(short).length, 22);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(short));
  for (const bad of [null, undefined, 42, {}]) assert.equal(shortenText(bad, 22), '');
});

test('F-07 shortenText: invalid limits do not crash (limit below 2 yields the ellipsis only for long text)', () => {
  assert.equal(shortenText('abc', 5), 'abc');
  assert.equal(shortenText('abcdef', 1), '…');
});

test('F-07 the model carries short display values and keeps the originals untouched', () => {
  const longSku = 'JEA-OXF-AZUL-MARINO-OSCURO-TALLE-42-EXTRA';
  const a = variant({ id: 'a', sku: longSku, barcode: 'BC-A', color: 'Azul marino oscuro de noche profunda', size: 'XXL extra largo' });
  const [label] = buildLabels([product([a])], pick('a'), OPTIONS).labels;
  assert.equal(label.sku, longSku);
  assert.equal(label.skuShort, `${longSku.slice(0, 21)}…`);
  assert.equal(Array.from(label.skuShort).length, 22);
  assert.equal(label.variantText, 'Azul marino oscuro de noche profunda / XXL extra largo');
  assert.equal(Array.from(label.variantTextShort).length, 22);
  assert.ok(label.variantTextShort.endsWith('…'));
});

test('F-07 short values at the limit are shown whole', () => {
  const a = variant({ id: 'a', sku: 'S'.repeat(22), color: 'C'.repeat(10), size: null });
  const [label] = buildLabels([product([a])], pick('a'), OPTIONS).labels;
  assert.equal(label.skuShort, 'S'.repeat(22));
  assert.equal(label.variantTextShort, 'C'.repeat(10));
});

// ---- F-03: legibility warnings (warn only; never block, never claim readability)
const code27 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0';
const code26 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const code64 = 'x'.repeat(64);
const legibility = (barcode, extra = {}) => {
  const a = variant({ id: 'a', barcode, sku: 'SKU-A' });
  return buildLabels([product([a])], pick('a'), { ...OPTIONS, ...extra });
};
const isWithin = (value, expected, tolerance = 5e-5) => Math.abs(value - expected) <= tolerance;

test('F-03 a 26-character barcode on the default 70 mm label is not flagged', () => {
  const result = legibility(code26);
  assert.equal(result.labels.length, 1);
  assert.deepEqual(result.legibilityWarnings, []);
  assert.ok(isWithin(result.labels[0].metrics.moduleWidthMm, 0.193));
  assert.equal(result.labels[0].metrics.belowMinimum, false);
});

test('F-03 a 27-character barcode gets a NARROW_MODULE warning but is still included', () => {
  const result = legibility(code27);
  assert.equal(result.labels.length, 1);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.legibilityWarnings.length, 1);
  const [warning] = result.legibilityWarnings;
  assert.equal(warning.code, 'NARROW_MODULE');
  assert.equal(warning.variantId, 'a');
  assert.ok(isWithin(warning.moduleWidthMm, 0.1869));
  assert.equal(warning.minimumMm, 0.19);
});

test('F-03 a 64-character barcode on 70 mm gets both warnings (module and human text) and is still included', () => {
  const result = legibility(code64);
  assert.equal(result.labels.length, 1);
  assert.deepEqual(result.legibilityWarnings.map((w) => w.code).sort(), ['HUMAN_TEXT_TOO_SMALL', 'NARROW_MODULE']);
  const small = result.legibilityWarnings.find((w) => w.code === 'HUMAN_TEXT_TOO_SMALL');
  assert.equal(small.fontPt, 4.8);
  assert.deepEqual(result.labels[0].humanText, { fontPt: 4.8, fits: false });
});

test('F-03 a wider label (100 mm) removes the human-text warning but keeps the narrow-module one for 64 chars', () => {
  const result = legibility(code64, { labelWidthMm: 100 });
  assert.deepEqual(result.legibilityWarnings.map((w) => w.code), ['NARROW_MODULE']);
  assert.ok(isWithin(result.labels[0].metrics.moduleWidthMm, 0.1262));
  assert.deepEqual(result.labels[0].humanText, { fontPt: 7, fits: true });
});

test('F-03 an invalid label width never crashes: no metrics and no legibility warnings', () => {
  for (const bad of [Number.NaN, 0, -5, '70', null]) {
    const result = legibility(code64, { labelWidthMm: bad });
    assert.equal(result.labels.length, 1);
    assert.equal(result.labels[0].metrics, null);
    assert.equal(result.labels[0].humanText, null);
    assert.deepEqual(result.legibilityWarnings, []);
  }
});

test('F-03 the barcode value is never altered by legibility handling', () => {
  const result = legibility(code64);
  assert.equal(result.labels[0].barcode, code64);
  assert.deepEqual(result.labels[0].encoded, encodeCode128B(code64));
});

test('F-03 legibility warnings cover only included labels, in selection order', () => {
  const a = variant({ id: 'a', barcode: code27, sku: 'SKU-A' });
  const b = variant({ id: 'b', barcode: code64, sku: 'SKU-B', isActive: false });
  const c = variant({ id: 'c', barcode: code64.replace(/x/g, 'y'), sku: 'SKU-C' });
  const result = buildLabels([product([a, b, c])], pick('c', 'b', 'a'), OPTIONS);
  assert.deepEqual(result.legibilityWarnings.filter((w) => w.code === 'NARROW_MODULE').map((w) => w.variantId), ['c', 'a']);
});

// ---- F-04 / F-09: global exclusion summary (independent of any filter or row cap)
function exclusionScenario() {
  const v1 = variant({ id: 'v1', isActive: false });
  const v2 = variant({ id: 'v2', barcode: '' });
  const v3 = variant({ id: 'v3', barcode: 'Ñandú-200' });
  const v4 = variant({ id: 'v4' });
  const ok = variant({ id: 'ok', sku: 'SKU-OK' });
  const catalogue = [product([v1, v2, v3, v4, ok])];
  const selection = [
    { variantId: 'v1', quantity: 2 },
    { variantId: 'v2', quantity: 5 },
    { variantId: 'v3', quantity: 200 },
    { variantId: 'v4', quantity: Number.NaN },
    { variantId: 'ok', quantity: 3 },
  ];
  return { catalogue, selection, result: buildLabels(catalogue, selection, OPTIONS) };
}

test('F-04 excluded entries record the requested quantity (null when the quantity itself is invalid)', () => {
  const { result } = exclusionScenario();
  assert.deepEqual(result.excluded.map(({ variantId, reason, quantity }) => [variantId, reason, quantity]), [
    ['v1', 'INACTIVE', 2],
    ['v2', 'MISSING_BARCODE', 5],
    ['v3', 'BARCODE_NOT_ENCODABLE', 200],
    ['v4', 'INVALID_QUANTITY', null],
  ]);
});

test('F-04 the summary counts variants and labels per reason: 4 variants, 207 labels, 1 unknown quantity', () => {
  const { catalogue, result } = exclusionScenario();
  const summary = summarizeExclusions(result.excluded, catalogue);
  assert.equal(summary.variants, 4);
  assert.equal(summary.labels, 207);
  assert.equal(summary.unknownQuantityVariants, 1);
  assert.deepEqual(summary.byReason, [
    { reason: 'INVALID_QUANTITY', variants: 1, labels: 0, variantIds: ['v4'] },
    { reason: 'INACTIVE', variants: 1, labels: 2, variantIds: ['v1'] },
    { reason: 'MISSING_BARCODE', variants: 1, labels: 5, variantIds: ['v2'] },
    { reason: 'BARCODE_NOT_ENCODABLE', variants: 1, labels: 200, variantIds: ['v3'] },
  ]);
});

test('F-04 the summary lists every excluded variant with SKU and product resolved from the catalogue (not from table rows)', () => {
  const { catalogue, result } = exclusionScenario();
  const summary = summarizeExclusions(result.excluded, catalogue);
  assert.equal(summary.items.length, 4);
  assert.deepEqual(summary.items.map((item) => item.variantId), ['v1', 'v2', 'v3', 'v4']);
  assert.ok(summary.items.every((item) => item.productName === 'Remera básica' && typeof item.sku === 'string'));
  assert.deepEqual(summary.items[0], { variantId: 'v1', reason: 'INACTIVE', quantity: 2, sku: catalogue[0].variants[0].sku, productName: 'Remera básica' });
});

test('F-09 NOT_FOUND selections stay visible in the summary, with no SKU or product name', () => {
  const result = buildLabels([product([variant({ id: 'a' })])], [{ variantId: 'ghost', quantity: 4 }, { variantId: 'a', quantity: 1 }], OPTIONS);
  const summary = summarizeExclusions(result.excluded, [product([variant({ id: 'a' })])]);
  assert.equal(summary.variants, 1);
  assert.equal(summary.labels, 4);
  assert.deepEqual(summary.items, [{ variantId: 'ghost', reason: 'NOT_FOUND', quantity: 4, sku: null, productName: null }]);
  assert.deepEqual(summary.byReason, [{ reason: 'NOT_FOUND', variants: 1, labels: 4, variantIds: ['ghost'] }]);
});

test('F-04 an empty exclusion list gives an empty summary', () => {
  assert.deepEqual(summarizeExclusions([], []), { variants: 0, labels: 0, unknownQuantityVariants: 0, byReason: [], items: [] });
});

test('F-04 adversarial: everything excluded, boundary quantities 200 and 201, and the repeated entry of a variant', () => {
  const a = variant({ id: 'a', isActive: false });
  const b = variant({ id: 'b', isActive: false });
  const result = buildLabels([product([a, b])], [
    { variantId: 'a', quantity: 200 },
    { variantId: 'b', quantity: 201 },
    { variantId: 'a', quantity: 7 },
  ], OPTIONS);
  assert.deepEqual(result.labels, []);
  const summary = summarizeExclusions(result.excluded, [product([a, b])]);
  assert.equal(summary.variants, 3);
  assert.equal(summary.labels, 207);
  assert.equal(summary.unknownQuantityVariants, 1);
  assert.deepEqual(summary.byReason.map((g) => [g.reason, g.variants, g.labels]), [
    ['DUPLICATE_SELECTION', 1, 7],
    ['INVALID_QUANTITY', 1, 0],
    ['INACTIVE', 1, 200],
  ]);
});

test('F-04 the same reason aggregates several variants with different quantities', () => {
  const vs = ['x1', 'x2', 'x3'].map((id) => variant({ id, isActive: false }));
  const result = buildLabels([product(vs)], [{ variantId: 'x1', quantity: 1 }, { variantId: 'x2', quantity: 10 }, { variantId: 'x3', quantity: 100 }], OPTIONS);
  const summary = summarizeExclusions(result.excluded, [product(vs)]);
  assert.deepEqual(summary.byReason, [{ reason: 'INACTIVE', variants: 3, labels: 111, variantIds: ['x1', 'x2', 'x3'] }]);
});

test('F-04 the summary does not mutate its inputs', () => {
  const { catalogue, result } = exclusionScenario();
  const before = JSON.stringify([result.excluded, catalogue]);
  summarizeExclusions(result.excluded, catalogue);
  assert.equal(JSON.stringify([result.excluded, catalogue]), before);
});

// ---- F-05 / F-08 / F-09: static checks over the page source (heuristic; no DOM available without installing deps)
const pageCode = () => stripComments(read(pagePath));

test('F-05 the page no longer claims or depends on LABEL_PRINT', () => {
  assert.ok(!/LABEL_PRINT/.test(pageCode()));
});

test('F-05 the page states that only active products and variants are inspected', () => {
  assert.match(pageCode(), /solo productos y variantes activas/);
});

test('F-05 the page documents that report.view is not LABEL_PRINT and not a server authorization (source comment)', () => {
  const source = read(pagePath);
  assert.match(source, /report\.view/);
  assert.match(source, /no equivale a LABEL_PRINT/i);
});

test('F-08 the page loads the catalogue through loadAllProducts and plans sheets through buildSheetPlans', () => {
  const code = pageCode();
  assert.match(code, /loadAllProducts\(/);
  // V3.1: the page plans through the single checked composition (deriveSheetPreview -> planLabelSheets -> buildSheetPlans).
  assert.match(code, /deriveSheetPreview\(/);
  assert.match(stripComments(read(join(libDir, 'labelCatalog.ts'))), /export function planLabelSheets[\s\S]*?buildSheetPlans\(/);
  assert.ok(!/let\s+cursor\b/.test(code), 'no mutable cursor in render');
  assert.ok(!/for\s*\(\s*let\s+page/.test(code), 'no pagination loop inside the component');
});

test('F-08 the load effect guards against stale results with a cancellation flag and cleanup', () => {
  const code = pageCode();
  assert.match(code, /let\s+active\s*=\s*true/);
  assert.match(code, /isCancelled:\s*\(\)\s*=>\s*!active/);
  assert.match(code, /return\s*\(\)\s*=>\s*\{\s*active\s*=\s*false;?\s*\}/);
});

test('F-09 the page clears catalogue and selection when the user or session changes', () => {
  const code = pageCode();
  assert.match(code, /const\s+userId\s*=/);
  assert.match(code, /\[token,\s*logout,\s*mayAccessLabels,\s*userId\]/);
  assert.match(code, /setProducts\(\[\]\)/);
  assert.match(code, /setQuantities\(\{\}\)/);
});

test('F-04 the exclusion summary is rendered before (outside) the filtered, capped table', () => {
  const code = pageCode();
  const summaryAt = code.indexOf('Resumen de exclusiones');
  const tableAt = code.indexOf('className="table-card"');
  assert.ok(summaryAt > 0, 'summary section exists');
  assert.ok(tableAt > 0, 'table exists');
  assert.ok(code.includes('rows.slice(0, MAX_ROWS)'), 'the table is capped');
  assert.ok(summaryAt < tableAt, 'summary precedes the table');
  assert.match(code, /summarizeExclusions\(/);
});

test('F-03 the page renders the computed module width and never claims physical legibility', () => {
  const code = pageCode();
  assert.match(code, /legibilityWarnings/);
  assert.match(code, /legibilidad (física )?no (está )?verificada/i);
  assert.ok(!/(se lee correctamente|legible garantizad|escaneable garantizad)/i.test(code));
});

test('F-03 the page takes border, padding and quiet-zone constants from labelLayout instead of redefining them', () => {
  const code = pageCode();
  assert.match(code, /QUIET_ZONE_MODULES/);
  assert.match(code, /LABEL_PADDING_X_MM/);
  assert.ok(!/const\s+QUIET_ZONE_MODULES\s*=/.test(code));
});

// ---- F-09: the same variant listed twice in the catalogue (e.g. a product repeated while paginating) is not a duplicate of itself
test('F-09 the same variant id repeated in the catalogue is not reported as a duplicate barcode and is not blocked', () => {
  const a = variant({ id: 'a', barcode: 'REPEAT-1' });
  const result = buildLabels([product([a]), product([a], { id: 'p-again' })], pick('a'), OPTIONS);
  assert.deepEqual(result.duplicateGroups, []);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.labels.length, 1);
});

test('F-09 a genuine duplicate is still caught when one of the two variants is also listed twice', () => {
  const a = variant({ id: 'a', barcode: 'REPEAT-2' });
  const b = variant({ id: 'b', barcode: 'REPEAT-2' });
  const result = buildLabels([product([a, b]), product([a], { id: 'p-again' })], pick('a'), OPTIONS);
  assert.deepEqual(result.duplicateGroups, [{ value: 'REPEAT-2', variantIds: ['a', 'b'] }]);
  assert.deepEqual(result.excluded.map(({ variantId, reason }) => [variantId, reason]), [['a', 'DUPLICATE_BARCODE']]);
});

// ======================= V3 regression tests (M-01, L-02, CL-02, L-01, CL-03 page) =======================
// Each test below was run against the unmodified V2 sources first (see the RED log of the V3 delivery).

// Counts Array.from({ length }) expansions, which is how expandCopies materialises copies.
function countExpansions(run) {
  const real = Array.from;
  let expansions = 0;
  Array.from = function patched(...args) {
    const source = args[0];
    if (source && typeof source === 'object' && !Array.isArray(source) && typeof source.length === 'number' && typeof source[Symbol.iterator] !== 'function') expansions += 1;
    return real.apply(this, args);
  };
  try {
    return { value: run(), expansions };
  } finally {
    Array.from = real;
  }
}
const fakeLabels = (quantities) => quantities.map((quantity, i) => ({ variantId: `f${i + 1}`, quantity }));

// ---- M-01: the global limit is checked before anything is expanded
test('M-01 expandCopies refuses 1200 copies (6 x 200): empty result and no expansion work at all', () => {
  const { value, expansions } = countExpansions(() => expandCopies(fakeLabels([200, 200, 200, 200, 200, 200])));
  assert.deepEqual(value, []);
  assert.equal(expansions, 0);
});

test('M-01 expandCopies still expands exactly 1000 copies (5 x 200) in selection order', () => {
  const copies = expandCopies(fakeLabels([200, 200, 200, 200, 200]));
  assert.equal(copies.length, 1000);
  assert.equal(copies[0].variantId, 'f1');
  assert.equal(copies[999].variantId, 'f5');
});

test('M-01 expandCopies refuses 1001 copies, a fractional quantity and a non-numeric one', () => {
  assert.deepEqual(expandCopies(fakeLabels([200, 200, 200, 200, 201])), []);
  assert.deepEqual(expandCopies(fakeLabels([1.5])), []);
  assert.deepEqual(expandCopies(fakeLabels([Number.NaN])), []);
  assert.deepEqual(expandCopies(fakeLabels([-1, 3])), []);
});

test('M-01 expandCopies keeps its ordinary behaviour for empty and small selections', () => {
  assert.deepEqual(expandCopies([]), []);
  assert.deepEqual(expandCopies(fakeLabels([2, 1])).map((l) => l.variantId), ['f1', 'f1', 'f2']);
});

// ---- L-02: truncation never splits a grapheme cluster
const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F466}';
const FLAG = '\u{1F1E6}\u{1F1F7}';
const E_ACUTE = 'é';
const THUMB = '\u{1F44D}\u{1F3FD}';
const KEYCAP = '1️⃣';

test('L-02 a family ZWJ sequence is never cut: 6 families with max 5 keep 4 whole families', () => {
  assert.equal(shortenText(FAMILY.repeat(6), 5), `${FAMILY.repeat(4)}…`);
});

test('L-02 regional-indicator flags are never cut in half', () => {
  assert.equal(shortenText(FLAG.repeat(14), 5), `${FLAG.repeat(4)}…`);
});

test('L-02 a base letter keeps its combining mark: 30 decomposed e-acute with max 5 keep 4 whole clusters', () => {
  const short = shortenText(E_ACUTE.repeat(30), 5);
  assert.equal(short, `${E_ACUTE.repeat(4)}…`);
  assert.ok(!/^[̀-ͯ]/.test(short));
});

test('L-02 an emoji keeps its skin-tone modifier, and keycap sequences stay whole', () => {
  assert.equal(shortenText(THUMB.repeat(30), 5), `${THUMB.repeat(4)}…`);
  assert.equal(shortenText(KEYCAP.repeat(10), 4), `${KEYCAP.repeat(3)}…`);
});

test('L-02 text that fits by graphemes is returned untouched (22 families with max 22)', () => {
  assert.equal(shortenText(FAMILY.repeat(22), 22), FAMILY.repeat(22));
  assert.equal(shortenText('x'.repeat(23), 22), `${'x'.repeat(21)}…`);
});

test('L-02 compatibility fallback: without Intl.Segmenter truncation is by code points (documented limitation)', () => {
  const original = Intl.Segmenter;
  Intl.Segmenter = undefined;
  try {
    assert.equal(shortenText(E_ACUTE.repeat(30), 5), `${E_ACUTE.repeat(2)}…`);
    assert.equal(shortenText('x'.repeat(23), 22), `${'x'.repeat(21)}…`);
    assert.equal(shortenText('  Remera \n azul ', 22), 'Remera azul');
  } finally {
    Intl.Segmenter = original;
  }
  assert.equal(shortenText(E_ACUTE.repeat(30), 5), `${E_ACUTE.repeat(4)}…`);
});

test('L-02 free text keeps collapsing whitespace', () => {
  assert.equal(shortenText('  Remera \n azul ', 22), 'Remera azul');
});

// ---- CL-02: identifiers keep their significant spaces; the encoded barcode bytes never change
const skuShortOf = (sku) => buildLabels([product([variant({ id: 's', sku, barcode: 'BC-S' })])], pick('s'), OPTIONS).labels[0].skuShort;

test('CL-02 a SKU with a double space is shown as it is', () => {
  assert.equal(skuShortOf('AB  CD'), 'AB  CD');
});

test('CL-02 leading and trailing spaces and tabs of a SKU are not normalised', () => {
  assert.equal(skuShortOf(' AB '), ' AB ');
  assert.equal(skuShortOf('A\tB'), 'A\tB');
});

test('CL-02 a long SKU is cut after 21 raw characters plus the ellipsis, spaces intact', () => {
  const sku = 'AB  CD  EF  GH  IJ  KL  MN  OP';
  assert.equal(sku.length, 30);
  assert.equal(skuShortOf(sku), `${sku.slice(0, 21)}…`);
});

test('CL-02 the SKU of the model and the barcode bytes are untouched by display shortening', () => {
  const [label] = buildLabels([product([variant({ id: 'b', sku: 'AB  CD', barcode: 'AB  CD' })])], pick('b'), OPTIONS).labels;
  assert.equal(label.sku, 'AB  CD');
  assert.equal(label.barcode, 'AB  CD');
  assert.deepEqual(label.encoded, encodeCode128B('AB  CD'));
});

test('CL-02 variant text is free text and keeps collapsing whitespace; a non-string SKU is empty', () => {
  const [label] = buildLabels([product([variant({ id: 'c', color: 'Azul   marino', size: null, barcode: 'BC-C' })])], pick('c'), OPTIONS).labels;
  assert.equal(label.variantTextShort, 'Azul marino');
  assert.equal(typeof labelDataModule.shortenIdentifier, 'function');
  assert.equal(labelDataModule.shortenIdentifier(42, 22), '');
  assert.equal(labelDataModule.shortenIdentifier('x'.repeat(23), 22), `${'x'.repeat(21)}…`);
});

test('CL-02 the page renders the SKU and the human-readable barcode with white-space: pre (static)', () => {
  const code = pageCode();
  assert.match(code, /title=\{label\.sku\}\s+style=\{\{[^}]*whiteSpace:\s*'pre'/);
  assert.match(code, /fontFamily:\s*'monospace'[^}]*whiteSpace:\s*'pre'[^}]*\}\}>\s*\{label\.barcode\}/);
});

// ---- L-01 / CL-03 on the page (static: the component cannot run without installing dependencies)
test('L-01 the selection-reset effect depends on the session token as well as the user (static)', () => {
  assert.match(pageCode(), /setQuantities\(\{\}\);[\s\S]{0,60}?\},\s*\[userId,\s*token\]\)/);
});

test('L-01 the catalogue-load effect keeps its dependencies (static)', () => {
  assert.match(pageCode(), /\[token,\s*logout,\s*mayAccessLabels,\s*userId\]/);
});

test('CL-03 the page parses numeric fields only through the shared pure parsers (static)', () => {
  const code = pageCode();
  assert.ok(!/\bNumber\(/.test(code), 'no Number(text) parsing may remain in the page');
  assert.match(code, /parseDecimalField/);
  assert.match(code, /parseQuantityField/);
});

// ======================= V3.1 regression tests (M-01 checked expansion, page state) =======================
const fakeCopies = (quantities) => quantities.map((quantity, i) => ({ variantId: `k${i + 1}`, quantity }));

function fnOf(name) {
  assert.equal(typeof labelDataModule[name], 'function', `${name} must be exported by labelData.ts`);
  return labelDataModule[name];
}

test('M-01 expandCopiesChecked tells an empty selection apart from an over-limit one', () => {
  const checked = fnOf('expandCopiesChecked');
  assert.deepEqual(checked([]), { ok: true, copies: [] });
  assert.deepEqual(checked(fakeCopies([200, 200, 200, 200, 200, 200])), { ok: false, code: 'TOTAL_EXCEEDS_LIMIT' });
  assert.deepEqual(checked(fakeCopies([200, 200, 200, 200, 201])), { ok: false, code: 'TOTAL_EXCEEDS_LIMIT' });
});

test('M-01 expandCopiesChecked keeps exactly 1000 copies, in selection order', () => {
  const checked = fnOf('expandCopiesChecked');
  const result = checked(fakeCopies([200, 200, 200, 200, 200]));
  assert.equal(result.ok, true);
  assert.equal(result.copies.length, 1000);
  assert.equal(result.copies[0].variantId, 'k1');
  assert.equal(result.copies[999].variantId, 'k5');
});

test('M-01 expandCopiesChecked reports invalid quantities as errors, never as an empty selection, whatever their position', () => {
  const checked = fnOf('expandCopiesChecked');
  for (const quantities of [[Number.NaN], [1.5], [-1], [2, Number.NaN], [Number.NaN, 2], [200, 200, 200, 200, 200, 200, Number.NaN], [Number.NaN, 200, 200, 200, 200, 200, 200], [Number.POSITIVE_INFINITY]]) {
    assert.deepEqual(checked(fakeCopies(quantities)), { ok: false, code: 'INVALID_QUANTITY' }, JSON.stringify(quantities));
  }
});

test('M-01 expandCopiesChecked does no expansion work for an over-limit or invalid selection', () => {
  const checked = fnOf('expandCopiesChecked');
  for (const quantities of [[200, 200, 200, 200, 200, 200], [1e21], [Number.NaN, 3], [5000, 5000]]) {
    const { expansions } = countExpansions(() => checked(fakeCopies(quantities)));
    assert.equal(expansions, 0, JSON.stringify(quantities));
  }
});

test('M-01 a label with quantity 0 is a valid selection with nothing to place', () => {
  assert.deepEqual(fnOf('expandCopiesChecked')(fakeCopies([0])), { ok: true, copies: [] });
});

test('M-01 the legacy expandCopies stays lossy ([] for errors): the page must use the checked form instead', () => {
  assert.deepEqual(expandCopies(fakeCopies([200, 200, 200, 200, 200, 200])), []);
  assert.deepEqual(expandCopies(fakeCopies([Number.NaN])), []);
});

test('M-01 the page no longer expands copies with the lossy helper and derives its state from deriveSheetPreview (static)', () => {
  const code = pageCode();
  assert.ok(!/\bexpandCopies\b/.test(code), 'the page must not call or import expandCopies');
  assert.match(code, /deriveSheetPreview\(/);
});

test('M-01 the success status line is rendered only for a READY preview (static)', () => {
  const code = pageCode();
  const occurrences = [...code.matchAll(/etiquetas incluidas/g)];
  assert.equal(occurrences.length, 1, 'exactly one success line');
  const before = code.slice(Math.max(0, occurrences[0].index - 260), occurrences[0].index);
  assert.match(before, /kind === 'READY'/);
});

test('M-01 the over-limit message comes from the preview state, not from a separate flag (static)', () => {
  const code = pageCode();
  assert.match(code, /code === 'TOTAL_EXCEEDS_LIMIT'/);
  assert.ok(!/result\.totalError/.test(code), 'no second source of truth for the limit error');
});

test('CL-05 catalogue failures never expose data as complete: products are set only on success (static)', () => {
  const code = pageCode();
  assert.equal([...code.matchAll(/setProducts\(outcome\.products\)/g)].length, 1);
  assert.match(code, /if \(outcome\.ok\) \{\s*setProducts\(outcome\.products\)/);
  assert.match(code, /else if \(outcome\.code === 'FAILED'\) \{\s*setError\(/);
  assert.match(code, /\{!loading && !error \? \(/);
});
