import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_MAX_PAGES, CATALOG_PAGE_LIMIT, buildSheetPlans, loadAllProducts } from '../../src/lib/labels/labelCatalog.ts';
import { computeLayout } from '../../src/lib/labels/labelLayout.ts';

const product = (id) => ({
  id,
  name: `Producto ${id}`,
  slug: `producto-${id}`,
  description: null,
  category: { id: 'c1', name: 'Categoría' },
  brand: { id: 'b1', name: 'Marca' },
  variants: [],
});
const catalog = (count, prefix = 'p') => Array.from({ length: count }, (_, i) => product(`${prefix}${i + 1}`));

// A fake GET /products: serves slices of `all`, records every call.
function server(all, { declaredTotal } = {}) {
  const calls = [];
  const fetchPage = async (page, limit) => {
    calls.push({ page, limit });
    return { items: all.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: declaredTotal ?? all.length } };
  };
  return { fetchPage, calls };
}
const forbidden = (cause) => cause instanceof Error && cause.status === 403;
const httpError = (status, message = 'x') => Object.assign(new Error(message), { status });

test('page size 100 and a 50-page ceiling are the defaults', () => {
  assert.equal(CATALOG_PAGE_LIMIT, 100);
  assert.equal(CATALOG_MAX_PAGES, 50);
});

test('F-08 loads every page: 250 products over 3 pages of 100', async () => {
  const { fetchPage, calls } = server(catalog(250));
  const outcome = await loadAllProducts(fetchPage);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.products.length, 250);
  assert.equal(outcome.total, 250);
  assert.equal(outcome.truncated, false);
  assert.equal(outcome.duplicatesDropped, 0);
  assert.equal(outcome.pagesLoaded, 3);
  assert.deepEqual(calls, [{ page: 1, limit: 100 }, { page: 2, limit: 100 }, { page: 3, limit: 100 }]);
});

test('F-08 preserves server order', async () => {
  const outcome = await loadAllProducts(server(catalog(120)).fetchPage);
  assert.deepEqual(outcome.products.map((p) => p.id), catalog(120).map((p) => p.id));
});

test('F-08 empty catalog: one request, no products, not truncated', async () => {
  const { fetchPage, calls } = server([]);
  const outcome = await loadAllProducts(fetchPage);
  assert.equal(outcome.ok, true);
  assert.deepEqual([outcome.products.length, outcome.total, outcome.truncated, outcome.pagesLoaded], [0, 0, false, 1]);
  assert.equal(calls.length, 1);
});

test('F-08 a server that declares more than it returns stops on the empty page and reports truncation', async () => {
  const { fetchPage, calls } = server(catalog(250), { declaredTotal: 300 });
  const outcome = await loadAllProducts(fetchPage);
  assert.equal(outcome.ok, true);
  assert.deepEqual([outcome.products.length, outcome.total, outcome.truncated, outcome.pagesLoaded], [250, 300, true, 4]);
  assert.equal(calls.length, 4);
});

test('F-08 the page ceiling is enforced and reported as truncation', async () => {
  const { fetchPage, calls } = server(catalog(500));
  const outcome = await loadAllProducts(fetchPage, { maxPages: 2 });
  assert.equal(outcome.ok, true);
  assert.deepEqual([outcome.products.length, outcome.total, outcome.truncated, outcome.pagesLoaded], [200, 500, true, 2]);
  assert.equal(calls.length, 2);
});

test('F-08 a custom page size is passed to every request', async () => {
  const { fetchPage, calls } = server(catalog(60));
  const outcome = await loadAllProducts(fetchPage, { limit: 25 });
  assert.equal(outcome.products.length, 60);
  assert.deepEqual(calls.map((c) => c.limit), [25, 25, 25]);
});

test('F-08 403 is FORBIDDEN and stops immediately', async () => {
  let calls = 0;
  const outcome = await loadAllProducts(async () => {
    calls += 1;
    throw httpError(403);
  }, { isForbidden: forbidden });
  assert.deepEqual(outcome, { ok: false, code: 'FORBIDDEN' });
  assert.equal(calls, 1);
});

test('F-08 without an isForbidden hook every failure is FAILED and carries its cause', async () => {
  const cause = httpError(403);
  const outcome = await loadAllProducts(async () => { throw cause; });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'FAILED');
  assert.equal(outcome.cause, cause);
});

test('F-08 an error on page 2 discards the partial catalog (FAILED, no products)', async () => {
  const all = catalog(250);
  const cause = new Error('boom');
  const outcome = await loadAllProducts(async (page, limit) => {
    if (page === 2) throw cause;
    return { items: all.slice(0, limit), pagination: { page, limit, total: 250 } };
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, 'FAILED');
  assert.equal(outcome.cause, cause);
  assert.ok(!('products' in outcome));
});

test('F-08 cancellation before the first request makes no request', async () => {
  const { fetchPage, calls } = server(catalog(10));
  const outcome = await loadAllProducts(fetchPage, { isCancelled: () => true });
  assert.deepEqual(outcome, { ok: false, code: 'CANCELLED' });
  assert.equal(calls.length, 0);
});

test('F-09 cancellation after a response never returns stale products', async () => {
  const { fetchPage, calls } = server(catalog(250));
  let cancelled = false;
  const outcome = await loadAllProducts(async (page, limit) => {
    const response = await fetchPage(page, limit);
    if (page === 1) cancelled = true;
    return response;
  }, { isCancelled: () => cancelled });
  assert.deepEqual(outcome, { ok: false, code: 'CANCELLED' });
  assert.equal(calls.length, 1);
});

test('F-09 cancellation after the last page also wins over the result', async () => {
  const { fetchPage } = server(catalog(10));
  let cancelled = false;
  const outcome = await loadAllProducts(async (page, limit) => {
    const response = await fetchPage(page, limit);
    cancelled = true;
    return response;
  }, { isCancelled: () => cancelled });
  assert.deepEqual(outcome, { ok: false, code: 'CANCELLED' });
});

test('F-09 a product repeated across pages is kept once (first occurrence) and counted as dropped', async () => {
  const [a, b, c] = catalog(3);
  const pages = [[a, b], [b, c]];
  const outcome = await loadAllProducts(async (page, limit) => ({ items: pages[page - 1] ?? [], pagination: { page, limit, total: 3 } }), { limit: 2 });
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.products.map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.equal(outcome.duplicatesDropped, 1);
  assert.equal(outcome.truncated, false);
});

test('F-09 duplicates that hide missing products still report truncation', async () => {
  const [a, b] = catalog(2);
  const pages = [[a, b], [b, b]];
  const outcome = await loadAllProducts(async (page, limit) => ({ items: pages[page - 1] ?? [], pagination: { page, limit, total: 4 } }), { limit: 2 });
  assert.equal(outcome.ok, true);
  assert.deepEqual([outcome.products.length, outcome.duplicatesDropped, outcome.truncated], [2, 2, true]);
});

test('F-08 adversarial responses: malformed shapes are FAILED, never a crash', async () => {
  const bad = [
    null,
    undefined,
    {},
    { items: 'x', pagination: { total: 1 } },
    { items: [], pagination: null },
    { items: [], pagination: { total: Number.NaN } },
    { items: [], pagination: { total: -1 } },
    { items: [], pagination: { total: 1.5 } },
    { items: [null], pagination: { total: 1 } },
    { items: [{ name: 'sin id' }], pagination: { total: 1 } },
  ];
  for (const response of bad) {
    const outcome = await loadAllProducts(async () => response);
    assert.equal(outcome.ok, false, JSON.stringify(response));
    assert.equal(outcome.code, 'FAILED', JSON.stringify(response));
  }
});

test('F-08 does not mutate the server responses', async () => {
  const all = catalog(150).map((p) => Object.freeze({ ...p, variants: Object.freeze([]) }));
  const frozenPages = (page, limit) => Object.freeze({ items: Object.freeze(all.slice((page - 1) * limit, page * limit)), pagination: Object.freeze({ page, limit, total: 150 }) });
  const outcome = await loadAllProducts(async (page, limit) => frozenPages(page, limit));
  assert.equal(outcome.ok, true);
  assert.equal(outcome.products.length, 150);
});

// ---- sheet planning (F-08): no state is mutated while rendering
const labels = (count) => Array.from({ length: count }, (_, i) => ({ variantId: `l${i + 1}` }));
const defaultLayout = computeLayout();

test('F-08 sheets: 15 copies from slot 3 give a sheet of 11 starting at (82,49) and a sheet of 4 starting at (10,10)', () => {
  const plan = buildSheetPlans(labels(15), defaultLayout, 3);
  assert.equal(plan.ok, true);
  assert.equal(plan.sheets.length, 2);
  const [first, second] = plan.sheets;
  assert.deepEqual([first.sheetNumber, first.startSlot, first.placements.length], [1, 3, 11]);
  assert.deepEqual([second.sheetNumber, second.startSlot, second.placements.length], [2, 0, 4]);
  assert.deepEqual([first.placements[0].xMm, first.placements[0].yMm], [82, 49]);
  assert.deepEqual([first.placements[10].xMm, first.placements[10].yMm], [82, 244]);
  assert.deepEqual([second.placements[0].xMm, second.placements[0].yMm], [10, 10]);
  assert.equal(first.placements[0].label.variantId, 'l1');
  assert.equal(second.placements[3].label.variantId, 'l15');
});

test('F-08 sheets keep selection order across sheets and place every copy exactly once', () => {
  const plan = buildSheetPlans(labels(1000), defaultLayout, 0);
  assert.equal(plan.ok, true);
  assert.equal(plan.sheets.length, 72);
  assert.equal(plan.sheets.at(-1).placements.length, 6);
  const ids = plan.sheets.flatMap((sheet) => sheet.placements.map((p) => p.label.variantId));
  assert.deepEqual(ids, labels(1000).map((l) => l.variantId));
});

test('F-08 sheets: no copies means no sheets', () => {
  assert.deepEqual(buildSheetPlans([], defaultLayout, 0), { ok: true, sheets: [] });
});

test('F-08 sheets use the capacity of a custom layout (zero margins: 24 per sheet)', () => {
  const layout = computeLayout({ marginTopMm: 0, marginLeftMm: 0, gapHorizontalMm: 0, gapVerticalMm: 0 });
  const plan = buildSheetPlans(labels(25), layout, 0);
  assert.deepEqual(plan.sheets.map((s) => s.placements.length), [24, 1]);
});

test('F-08 adversarial sheets: bad start slots and an invalid layout are rejected', () => {
  for (const bad of [14, -1, 1.5, Number.NaN, '3', null]) {
    assert.deepEqual(buildSheetPlans(labels(3), defaultLayout, bad), { ok: false, code: 'START_OUT_OF_RANGE' }, String(bad));
  }
  assert.deepEqual(buildSheetPlans(labels(3), { ok: false, code: 'LAYOUT_NO_FIT' }, 0), { ok: false, code: 'LAYOUT_INVALID' });
  assert.deepEqual(buildSheetPlans(labels(3), null, 0), { ok: false, code: 'LAYOUT_INVALID' });
});

test('F-08 sheets do not mutate their inputs', () => {
  const copies = Object.freeze(labels(5).map((l) => Object.freeze(l)));
  const before = JSON.stringify([copies, defaultLayout]);
  buildSheetPlans(copies, defaultLayout, 2);
  assert.equal(JSON.stringify([copies, defaultLayout]), before);
});
