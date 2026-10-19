// Paginated catalogue loading and sheet planning, as plain functions so that
// the React page only wires them to state. The page request is injected, so
// nothing here touches the network on its own.
//
// ADM-15-A: read-only. The loader never writes and never retries.

import type { CatalogProduct } from '../api';
import type { LabelModel } from './labelData.ts';
import { paginate, type LayoutResult } from './labelLayout.ts';

export const CATALOG_PAGE_LIMIT = 100;
export const CATALOG_MAX_PAGES = 50;

export type CatalogPageResponse = {
  items: CatalogProduct[];
  pagination: { total: number };
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

function isValidPage(response: unknown): response is CatalogPageResponse {
  if (typeof response !== 'object' || response === null) return false;
  const { items, pagination } = response as { items?: unknown; pagination?: unknown };
  if (!Array.isArray(items)) return false;
  if (!items.every((item) => typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string' && (item as { id: string }).id !== '')) return false;
  if (typeof pagination !== 'object' || pagination === null) return false;
  const total = (pagination as { total?: unknown }).total;
  return Number.isInteger(total) && (total as number) >= 0;
}

export async function loadAllProducts(fetchPage: FetchPage, options: LoadOptions = {}): Promise<LoadOutcome> {
  const limit = options.limit ?? CATALOG_PAGE_LIMIT;
  const maxPages = options.maxPages ?? CATALOG_MAX_PAGES;
  const cancelled = () => options.isCancelled?.() === true;
  if (cancelled()) return { ok: false, code: 'CANCELLED' };

  const products: CatalogProduct[] = [];
  const seen = new Set<string>();
  let duplicatesDropped = 0;
  let received = 0;
  let total = 0;
  let pagesLoaded = 0;

  for (let page = 1; page <= maxPages; page += 1) {
    let response: unknown;
    try {
      response = await fetchPage(page, limit);
    } catch (cause) {
      if (cancelled()) return { ok: false, code: 'CANCELLED' };
      if (options.isForbidden?.(cause) === true) return { ok: false, code: 'FORBIDDEN' };
      return { ok: false, code: 'FAILED', cause };
    }
    if (cancelled()) return { ok: false, code: 'CANCELLED' };
    if (!isValidPage(response)) return { ok: false, code: 'FAILED', cause: new Error('Respuesta de catálogo inválida.') };

    pagesLoaded += 1;
    total = response.pagination.total;
    received += response.items.length;
    for (const product of response.items) {
      if (seen.has(product.id)) {
        duplicatesDropped += 1;
        continue;
      }
      seen.add(product.id);
      products.push(product);
    }
    if (response.items.length === 0 || received >= total) break;
  }

  return { ok: true, products, total, truncated: products.length < total, duplicatesDropped, pagesLoaded };
}

export type SheetPlacement = { label: LabelModel; xMm: number; yMm: number };
export type SheetPlan = { sheetNumber: number; startSlot: number; placements: SheetPlacement[] };

export type SheetPlansResult =
  | { ok: true; sheets: SheetPlan[] }
  | { ok: false; code: 'LAYOUT_INVALID' | 'SLOT_MISSING' | 'INVALID_TOTAL' | 'INVALID_PER_SHEET' | 'START_OUT_OF_RANGE' };

// Places every copy on a sheet slot. Pure: the page calls it from useMemo, so
// nothing is mutated while rendering.
export function buildSheetPlans(
  copies: ReadonlyArray<LabelModel>,
  layout: LayoutResult | null | undefined,
  startSlot: unknown,
): SheetPlansResult {
  if (!layout || layout.ok !== true) return { ok: false, code: 'LAYOUT_INVALID' };
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
