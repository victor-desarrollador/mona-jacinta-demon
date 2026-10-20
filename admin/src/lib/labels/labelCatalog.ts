// Paginated catalogue loading and sheet planning, as plain functions so that
// the React page only wires them to state. The page request is injected, so
// nothing here touches the network on its own.
//
// ADM-15-A: read-only. The loader never writes and never retries.

import type { CatalogProduct } from '../api';
import { expandCopiesChecked, type LabelModel } from './labelData.ts';
import { MAX_LABELS_PER_SELECTION, paginate, type LayoutResult } from './labelLayout.ts';

export const CATALOG_PAGE_LIMIT = 100;
export const CATALOG_MAX_PAGES = 50;

export type CatalogPageResponse = {
  items: CatalogProduct[];
  pagination: { page: number; limit: number; total: number };
};

export type FetchPage = (page: number, limit: number) => Promise<CatalogPageResponse>;

export type LoadOptions = {
  limit?: number;
  maxPages?: number;
  // Polled before the first request and after every response, so a result that
  // belongs to a finished session or a closed screen is never returned.
  isCancelled?: () => boolean;
  isForbidden?: (cause: unknown) => boolean;
};

export type LoadOutcome =
  | {
      ok: true;
      products: CatalogProduct[];
      // `pagination.total` of the last page the server answered.
      total: number;
      // True when fewer unique products were collected than the server declared.
      truncated: boolean;
      duplicatesDropped: number;
      pagesLoaded: number;
    }
  | { ok: false; code: 'CANCELLED' | 'FORBIDDEN' }
  | { ok: false; code: 'FAILED'; cause: unknown };

const isNullableString = (value: unknown) => value === null || typeof value === 'string';

// Only what this module and its page actually read is validated, as declared by
// GET /products (products.service.ts publicVariantSelect; BigInt prices arrive as
// strings through api/src/shared/json-safe.ts). `barcode` is a string in the
// schema; null is tolerated because the module excludes such variants later.
function isValidVariant(variant: unknown): boolean {
  if (typeof variant !== 'object' || variant === null) return false;
  const v = variant as Record<string, unknown>;
  return (
    typeof v.id === 'string' && v.id !== '' &&
    typeof v.sku === 'string' &&
    typeof v.isActive === 'boolean' &&
    isNullableString(v.barcode) &&
    isNullableString(v.color) &&
    isNullableString(v.size) &&
    isNullableString(v.cashPrice)
  );
}

function isValidProduct(product: unknown): boolean {
  if (typeof product !== 'object' || product === null) return false;
  const p = product as Record<string, unknown>;
  return (
    typeof p.id === 'string' && p.id !== '' &&
    typeof p.name === 'string' &&
    Array.isArray(p.variants) && p.variants.every(isValidVariant)
  );
}

function isValidPage(response: unknown): response is CatalogPageResponse {
  if (typeof response !== 'object' || response === null) return false;
  const { items, pagination } = response as { items?: unknown; pagination?: unknown };
  if (!Array.isArray(items)) return false;
  if (!items.every(isValidProduct)) return false;
  if (typeof pagination !== 'object' || pagination === null) return false;
  const { page, limit, total } = pagination as { page?: unknown; limit?: unknown; total?: unknown };
  return (
    Number.isSafeInteger(page) && (page as number) >= 1 &&
    Number.isSafeInteger(limit) && (limit as number) >= 1 &&
    Number.isSafeInteger(total) && (total as number) >= 0
  );
}

const inconsistent = (reason: string): { ok: false; code: 'FAILED'; cause: Error } => ({
  ok: false,
  code: 'FAILED',
  cause: new Error(`Catálogo inconsistente: ${reason}. Volvé a cargar la pantalla.`),
});

export async function loadAllProducts(fetchPage: FetchPage, options: LoadOptions = {}): Promise<LoadOutcome> {
  // Options are validated before any request. The limit may not exceed the page
  // size GET /products accepts (max 100).
  const limit: unknown = options.limit === undefined ? CATALOG_PAGE_LIMIT : options.limit;
  const maxPages: unknown = options.maxPages === undefined ? CATALOG_MAX_PAGES : options.maxPages;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > CATALOG_PAGE_LIMIT) {
    return { ok: false, code: 'FAILED', cause: new Error('Opciones de carga inválidas: limit.') };
  }
  if (!Number.isSafeInteger(maxPages) || (maxPages as number) < 1 || (maxPages as number) > CATALOG_MAX_PAGES) {
    return { ok: false, code: 'FAILED', cause: new Error('Opciones de carga inválidas: maxPages.') };
  }
  const cancelled = () => options.isCancelled?.() === true;
  if (cancelled()) return { ok: false, code: 'CANCELLED' };

  const products: CatalogProduct[] = [];
  const seen = new Set<string>();
  let duplicatesDropped = 0;
  let received = 0;
  let total = 0;
  let pagesLoaded = 0;

  for (let page = 1; page <= (maxPages as number); page += 1) {
    let response: unknown;
    try {
      response = await fetchPage(page, limit as number);
    } catch (cause) {
      if (cancelled()) return { ok: false, code: 'CANCELLED' };
      if (options.isForbidden?.(cause) === true) return { ok: false, code: 'FORBIDDEN' };
      return { ok: false, code: 'FAILED', cause };
    }
    if (cancelled()) return { ok: false, code: 'CANCELLED' };
    if (!isValidPage(response)) return { ok: false, code: 'FAILED', cause: new Error('Respuesta de catálogo inválida.') };

    // GET /products is offset-paginated over a name ordering with a separate count(): there is
    // no snapshot. The only pages accepted are the ones the declared total predicts; anything
    // else (a changed total, a short or oversized page, an unexpected empty page) means the
    // catalogue moved or the response is wrong, and the load fails instead of passing off a
    // partial catalogue as complete.
    // The server echoes the page and the limit it served; a response for another page or another
    // page size is not the one asked for and its arithmetic cannot be trusted.
    if (response.pagination.page !== page) return inconsistent('la respuesta corresponde a otra página');
    if (response.pagination.limit !== limit) return inconsistent('la respuesta usa otro tamaño de página');
    if (pagesLoaded > 0 && response.pagination.total !== total) return inconsistent('el total cambió durante la carga');
    total = response.pagination.total;
    const expected = Math.min(limit as number, Math.max(0, total - pagesLoaded * (limit as number)));
    if (response.items.length > (limit as number)) return inconsistent('la página superó el límite pedido');
    if (response.items.length !== expected) return inconsistent('la página no coincide con el total declarado');

    pagesLoaded += 1;
    received += response.items.length;
    for (const product of response.items) {
      if (seen.has(product.id)) {
        duplicatesDropped += 1;
        continue;
      }
      seen.add(product.id);
      products.push(product);
    }
    if (received >= total) break;
  }

  return { ok: true, products, total, truncated: products.length < total, duplicatesDropped, pagesLoaded };
}

export type SheetPlacement = { label: LabelModel; xMm: number; yMm: number };
export type SheetPlan = { sheetNumber: number; startSlot: number; placements: SheetPlacement[] };

export type SheetPlansResult =
  | { ok: true; sheets: SheetPlan[] }
  | { ok: false; code: 'LAYOUT_INVALID' | 'SLOT_MISSING' | 'INVALID_TOTAL' | 'INVALID_PER_SHEET' | 'START_OUT_OF_RANGE' | 'TOTAL_EXCEEDS_LIMIT' | 'INVALID_QUANTITY' };

// Places every copy on a sheet slot. Pure: the page calls it from useMemo, so
// nothing is mutated while rendering.
export function buildSheetPlans(
  copies: ReadonlyArray<LabelModel>,
  layout: LayoutResult | null | undefined,
  startSlot: unknown,
): SheetPlansResult {
  if (!layout || layout.ok !== true) return { ok: false, code: 'LAYOUT_INVALID' };
  // No placement is built for an over-limit set of copies.
  if (copies.length > MAX_LABELS_PER_SELECTION) return { ok: false, code: 'TOTAL_EXCEEDS_LIMIT' };
  const plan = paginate(copies.length, layout.perSheet, startSlot);
  if (!plan.ok) return { ok: false, code: plan.code };

  const sheets: SheetPlan[] = [];
  let cursor = 0;
  for (const [index, sheet] of plan.sheets.entries()) {
    const placements: SheetPlacement[] = [];
    for (let offset = 0; offset < sheet.count; offset += 1) {
      const slot = layout.slots[sheet.startSlot + offset];
      if (!slot) return { ok: false, code: 'SLOT_MISSING' };
      placements.push({ label: copies[cursor + offset], xMm: slot.xMm, yMm: slot.yMm });
    }
    cursor += sheet.count;
    sheets.push({ sheetNumber: index + 1, startSlot: sheet.startSlot, placements });
  }
  return { ok: true, sheets };
}

// The single checked path from selection to sheets: layout, then quantities and
// the global limit (before any expansion), then planning. Every failure is an
// explicit error; an empty selection is a valid empty plan.
export function planLabelSheets(
  labels: ReadonlyArray<LabelModel>,
  layout: LayoutResult | null | undefined,
  startSlot: unknown,
): SheetPlansResult {
  if (!layout || layout.ok !== true) return { ok: false, code: 'LAYOUT_INVALID' };
  const expanded = expandCopiesChecked(labels);
  if (!expanded.ok) return { ok: false, code: expanded.code };
  return buildSheetPlans(expanded.copies, layout, startSlot);
}

// What the page shows. Only READY carries sheets and counts, so a success message
// can never be produced for an error.
export type SheetPreview =
  | { kind: 'LAYOUT_INVALID' }
  | { kind: 'EMPTY' }
  | { kind: 'ERROR'; code: Exclude<Extract<SheetPlansResult, { ok: false }>['code'], 'LAYOUT_INVALID'> }
  | { kind: 'READY'; sheets: SheetPlan[]; labelCount: number; sheetCount: number };

export function deriveSheetPreview(
  labels: ReadonlyArray<LabelModel>,
  layout: LayoutResult | null | undefined,
  startSlot: unknown,
): SheetPreview {
  const plan = planLabelSheets(labels, layout, startSlot);
  if (!plan.ok) return plan.code === 'LAYOUT_INVALID' ? { kind: 'LAYOUT_INVALID' } : { kind: 'ERROR', code: plan.code };
  if (plan.sheets.length === 0) return { kind: 'EMPTY' };
  const labelCount = plan.sheets.reduce((sum, sheet) => sum + sheet.placements.length, 0);
  return { kind: 'READY', sheets: plan.sheets, labelCount, sheetCount: plan.sheets.length };
}

// What the catalogue area of the page says. Error wins over loading, and a valid
// catalogue without variants is not the same as a search without results.
export type CatalogNotice = 'LOADING' | 'ERROR' | 'EMPTY_CATALOG' | 'NO_RESULTS' | 'NONE';

export function deriveCatalogNotice(state: {
  loading: boolean;
  error: string;
  variantCount: number;
  rowCount: number;
  hasSearch: boolean;
}): CatalogNotice {
  if (state.error) return 'ERROR';
  if (state.loading) return 'LOADING';
  if (state.variantCount === 0) return 'EMPTY_CATALOG';
  if (state.rowCount === 0 && state.hasSearch) return 'NO_RESULTS';
  return 'NONE';
}

// What the preview area says. A catalogue that is loading or failed never gets
// instructions or a success line; EMPTY is split into "nothing selected" and
// "everything selected was excluded".
export type PreviewNotice =
  | { kind: 'CATALOG_LOADING' }
  | { kind: 'CATALOG_ERROR' }
  | { kind: 'NO_SELECTION' }
  | { kind: 'ALL_EXCLUDED' }
  | { kind: 'LAYOUT_INVALID' }
  | { kind: 'PLAN_ERROR'; code: Extract<SheetPreview, { kind: 'ERROR' }>['code'] }
  | { kind: 'READY' };

export function derivePreviewNotice(state: {
  loading: boolean;
  error: string;
  selectionCount: number;
  preview: SheetPreview;
}): PreviewNotice {
  if (state.error) return { kind: 'CATALOG_ERROR' };
  if (state.loading) return { kind: 'CATALOG_LOADING' };
  const { preview } = state;
  if (preview.kind === 'LAYOUT_INVALID') return { kind: 'LAYOUT_INVALID' };
  if (preview.kind === 'ERROR') return { kind: 'PLAN_ERROR', code: preview.code };
  if (preview.kind === 'READY') return { kind: 'READY' };
  return state.selectionCount === 0 ? { kind: 'NO_SELECTION' } : { kind: 'ALL_EXCLUDED' };
}
