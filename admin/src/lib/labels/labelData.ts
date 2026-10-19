// Turns the catalogue returned by GET /products plus a selection into label
// models. Pure: no network, no storage, no writes. Money formatting and
// colour/size formatting are injected so this module imports no runtime code
// from the rest of the admin app.
//
// ADM-15-A rules (provisional; not global business rules):
// - the barcode printed is always the variant's own `barcode`; it never
//   depends on any price;
// - a price is printed only when requested, and then only `cashPrice` — never
//   the legacy `price`;
// - duplicate detection covers the inspected catalogue only (GET /products
//   returns active products and variants only) and does NOT replace the
//   database unique constraints or a correct POS lookup;
// - legibility figures are computed from geometry and are warnings only: they
//   never block a label and never prove that a print can be scanned.

import type { CatalogProduct } from '../api';
import { encodeCode128B, type Code128Encoded } from './code128.ts';
import {
  DEFAULT_LAYOUT,
  MIN_MODULE_WIDTH_MM,
  HUMAN_TEXT_MIN_PT,
  barcodeMetrics,
  fitHumanText,
  validateQuantity,
  validateSelectionTotal,
} from './labelLayout.ts';

// PROVISIONAL visual gate (F-01). `report.view` is the string that /auth/me
// projects for admin access (the admin shell already requires it:
// admin/src/lib/auth.ts canUseBackoffice). It no equivale a LABEL_PRINT, which
// /auth/me never projects, and it is not an authorization: the server decides
// what GET /products returns (INVENTORY_VIEW). Frontend visibility is not a
// security boundary.
export const LABELS_ACCESS_PERMISSION = 'report.view';

export function canAccessLabels(user: unknown): boolean {
  if (typeof user !== 'object' || user === null) return false;
  const permissions = (user as { permissions?: unknown }).permissions;
  return Array.isArray(permissions) && permissions.includes(LABELS_ACCESS_PERMISSION);
}

// Provisional display limits (characters); the original values are always kept.
export const MAX_NAME_LENGTH = 28;
export const MAX_SKU_DISPLAY_LENGTH = 22;
export const MAX_VARIANT_DISPLAY_LENGTH = 22;

export function shortenText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\s+/g, ' ').trim();
  const characters = Array.from(normalized);
  if (characters.length <= max) return normalized;
  return `${characters.slice(0, Math.max(0, max - 1)).join('')}…`;
}

export function shortenName(name: unknown): string {
  return shortenText(name, MAX_NAME_LENGTH);
}

export type ExclusionReason =
  | 'NOT_FOUND'
  | 'DUPLICATE_SELECTION'
  | 'INVALID_QUANTITY'
  | 'INACTIVE'
  | 'MISSING_BARCODE'
  | 'BARCODE_EDGE_WHITESPACE'
  | 'BARCODE_NOT_ENCODABLE'
  | 'DUPLICATE_BARCODE'
  | 'PRICE_MISSING';

// Deterministic presentation order for summaries.
const REASON_ORDER: readonly ExclusionReason[] = [
  'NOT_FOUND',
  'DUPLICATE_SELECTION',
  'INVALID_QUANTITY',
  'INACTIVE',
  'MISSING_BARCODE',
  'BARCODE_EDGE_WHITESPACE',
  'BARCODE_NOT_ENCODABLE',
  'DUPLICATE_BARCODE',
  'PRICE_MISSING',
];

export type SelectionEntry = { variantId: string; quantity: unknown };

export type BuildOptions = {
  showPrice: boolean;
  formatMoney: (cents: string) => string;
  formatVariant: (color: string | null, size: string | null) => string;
  // Label width used for legibility figures; defaults to the A4 layout default.
  labelWidthMm?: unknown;
};

export type LabelMetrics = { moduleWidthMm: number; moduleMils: number; belowMinimum: boolean };

export type LabelModel = {
  variantId: string;
  productId: string;
  sku: string;
  skuShort: string;
  barcode: string;
  productName: string;
  productNameShort: string;
  variantText: string;
  variantTextShort: string;
  quantity: number;
  priceText: string | null;
  encoded: Code128Encoded;
  // null when the label width is not a usable number.
  metrics: LabelMetrics | null;
  humanText: { fontPt: number; fits: boolean } | null;
};

export type DuplicateGroup = { value: string; variantIds: string[] };

// Potential conflicts: reported, never blocking.
export type LabelWarning = {
  code: 'DUPLICATE_BARCODE_CASE' | 'CROSS_CODE';
  value: string;
  variantIds: string[];
};

// Geometry-derived warnings: reported, never blocking, never a readability claim.
export type LegibilityWarning =
  | { code: 'NARROW_MODULE'; variantId: string; moduleWidthMm: number; minimumMm: number }
  | { code: 'HUMAN_TEXT_TOO_SMALL'; variantId: string; fontPt: number; minimumPt: number };

export type ExcludedEntry = {
  variantId: string;
  reason: ExclusionReason;
  // The requested quantity when it is a valid one; null when the quantity itself was invalid.
  quantity: number | null;
};

export type BuildResult = {
  labels: LabelModel[];
  excluded: ExcludedEntry[];
  duplicateGroups: DuplicateGroup[];
  warnings: LabelWarning[];
  legibilityWarnings: LegibilityWarning[];
  totalLabels: number;
  totalError: 'TOTAL_EXCEEDS_LIMIT' | null;
};

type CatalogEntry = { product: CatalogProduct; variant: CatalogProduct['variants'][number] };

const isCodeString = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';
const POSITIVE_CENTS = /^[1-9]\d*$/;

function flatten(products: ReadonlyArray<CatalogProduct>): CatalogEntry[] {
  return products.flatMap((product) => product.variants.map((variant) => ({ product, variant })));
}

function groupBy<T>(items: T[], key: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === null) continue;
    const bucket = groups.get(k);
    if (bucket) bucket.push(item);
    else groups.set(k, [item]);
  }
  return groups;
}

function analyseCatalog(entries: CatalogEntry[]) {
  const withBarcode = entries.filter(({ variant }) => isCodeString(variant.barcode));

  const exact = groupBy(withBarcode, ({ variant }) => variant.barcode);
  const duplicateGroups: DuplicateGroup[] = [];
  const blocked = new Set<string>();
  for (const [value, group] of exact) {
    const ids = [...new Set(group.map(({ variant }) => variant.id))];
    if (ids.length < 2) continue;
    duplicateGroups.push({ value, variantIds: ids });
    ids.forEach((id) => blocked.add(id));
  }

  const warnings: LabelWarning[] = [];
  const byCase = groupBy(withBarcode, ({ variant }) => variant.barcode.toLowerCase());
  for (const group of byCase.values()) {
    const distinctValues = new Set(group.map(({ variant }) => variant.barcode));
    if (distinctValues.size < 2) continue;
    warnings.push({
      code: 'DUPLICATE_BARCODE_CASE',
      value: group[0].variant.barcode,
      variantIds: [...new Set(group.map(({ variant }) => variant.id))],
    });
  }

  const bySku = groupBy(entries, ({ variant }) => (isCodeString(variant.sku) ? variant.sku.toLowerCase() : null));
  for (const { variant } of withBarcode) {
    for (const other of bySku.get(variant.barcode.toLowerCase()) ?? []) {
      if (other.variant.id === variant.id) continue;
      warnings.push({ code: 'CROSS_CODE', value: variant.barcode, variantIds: [variant.id, other.variant.id] });
    }
  }

  return { duplicateGroups, blocked, warnings };
}

export function buildLabels(
  products: ReadonlyArray<CatalogProduct>,
  selection: ReadonlyArray<SelectionEntry>,
  options: BuildOptions,
): BuildResult {
  const entries = flatten(products);
  const byId = new Map<string, CatalogEntry>();
  for (const entry of entries) if (!byId.has(entry.variant.id)) byId.set(entry.variant.id, entry);
  const { duplicateGroups, blocked, warnings } = analyseCatalog(entries);
  const labelWidthMm = options.labelWidthMm === undefined ? DEFAULT_LAYOUT.labelWidthMm : options.labelWidthMm;

  const labels: LabelModel[] = [];
  const excluded: ExcludedEntry[] = [];
  const legibilityWarnings: LegibilityWarning[] = [];
  const seen = new Set<string>();

  for (const { variantId, quantity } of selection) {
    const checkedQuantity = validateQuantity(quantity);
    const exclude = (reason: ExclusionReason) =>
      excluded.push({ variantId, reason, quantity: checkedQuantity.ok ? checkedQuantity.quantity : null });

    if (seen.has(variantId)) {
      exclude('DUPLICATE_SELECTION');
      continue;
    }
    seen.add(variantId);

    const entry = byId.get(variantId);
    if (!entry) {
      exclude('NOT_FOUND');
      continue;
    }
    const { product, variant } = entry;

    if (!checkedQuantity.ok) {
      exclude('INVALID_QUANTITY');
      continue;
    }
    if (variant.isActive !== true) {
      exclude('INACTIVE');
      continue;
    }
    if (!isCodeString(variant.barcode)) {
      exclude('MISSING_BARCODE');
      continue;
    }
    if (variant.barcode !== variant.barcode.trim()) {
      exclude('BARCODE_EDGE_WHITESPACE');
      continue;
    }
    const encoded = encodeCode128B(variant.barcode);
    if (!encoded.ok) {
      exclude('BARCODE_NOT_ENCODABLE');
      continue;
    }
    if (blocked.has(variant.id)) {
      exclude('DUPLICATE_BARCODE');
      continue;
    }

    let priceText: string | null = null;
    if (options.showPrice) {
      if (typeof variant.cashPrice !== 'string' || !POSITIVE_CENTS.test(variant.cashPrice)) {
        exclude('PRICE_MISSING');
        continue;
      }
      priceText = options.formatMoney(variant.cashPrice);
    }

    const metricsResult = barcodeMetrics(encoded.width, labelWidthMm);
    const humanResult = fitHumanText(variant.barcode.length, labelWidthMm);
    const metrics: LabelMetrics | null = metricsResult.ok
      ? { moduleWidthMm: metricsResult.moduleWidthMm, moduleMils: metricsResult.moduleMils, belowMinimum: metricsResult.belowMinimum }
      : null;
    const humanText = humanResult.ok ? { fontPt: humanResult.fontPt, fits: humanResult.fits } : null;
    if (metrics?.belowMinimum) {
      legibilityWarnings.push({ code: 'NARROW_MODULE', variantId: variant.id, moduleWidthMm: metrics.moduleWidthMm, minimumMm: MIN_MODULE_WIDTH_MM });
    }
    if (humanText && !humanText.fits) {
      legibilityWarnings.push({ code: 'HUMAN_TEXT_TOO_SMALL', variantId: variant.id, fontPt: humanText.fontPt, minimumPt: HUMAN_TEXT_MIN_PT });
    }

    const variantText = options.formatVariant(variant.color, variant.size);
    labels.push({
      variantId: variant.id,
      productId: product.id,
      sku: variant.sku,
      skuShort: shortenText(variant.sku, MAX_SKU_DISPLAY_LENGTH),
      barcode: variant.barcode,
      productName: product.name,
      productNameShort: shortenName(product.name),
      variantText,
      variantTextShort: shortenText(variantText, MAX_VARIANT_DISPLAY_LENGTH),
      quantity: checkedQuantity.quantity,
      priceText,
      encoded,
      metrics,
      humanText,
    });
  }

  const totalLabels = labels.reduce((sum, label) => sum + label.quantity, 0);
  const total = validateSelectionTotal(totalLabels);
  return {
    labels,
    excluded,
    duplicateGroups,
    warnings,
    legibilityWarnings,
    totalLabels,
    totalError: total.ok ? null : 'TOTAL_EXCEEDS_LIMIT',
  };
}

export type ExcludedItem = {
  variantId: string;
  reason: ExclusionReason;
  quantity: number | null;
  // null when the variant is not in the catalogue (NOT_FOUND).
  sku: string | null;
  productName: string | null;
};

export type ExclusionSummary = {
  variants: number;
  // Sum of the valid requested quantities of the excluded entries.
  labels: number;
  // Excluded entries whose own quantity was invalid, so no label count exists.
  unknownQuantityVariants: number;
  byReason: { reason: ExclusionReason; variants: number; labels: number; variantIds: string[] }[];
  items: ExcludedItem[];
};

// Global view of everything the selection lost, built only from the build
// result and the catalogue: it does not depend on any table filter or row cap.
export function summarizeExclusions(
  excluded: ReadonlyArray<ExcludedEntry>,
  products: ReadonlyArray<CatalogProduct>,
): ExclusionSummary {
  const index = new Map<string, { sku: string; productName: string }>();
  for (const { product, variant } of flatten(products)) {
    if (!index.has(variant.id)) index.set(variant.id, { sku: variant.sku, productName: product.name });
  }
  const items: ExcludedItem[] = excluded.map(({ variantId, reason, quantity }) => {
    const known = index.get(variantId);
    return { variantId, reason, quantity, sku: known?.sku ?? null, productName: known?.productName ?? null };
  });

  const byReason = REASON_ORDER.flatMap((reason) => {
    const group = items.filter((item) => item.reason === reason);
    if (group.length === 0) return [];
    return [{
      reason,
      variants: group.length,
      labels: group.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
      variantIds: group.map((item) => item.variantId),
    }];
  });

  return {
    variants: items.length,
    labels: items.reduce((sum, item) => sum + (item.quantity ?? 0), 0),
    unknownQuantityVariants: items.filter((item) => item.quantity === null).length,
    byReason,
    items,
  };
}

// One entry per physical label to place on the sheets, in selection order.
export function expandCopies(labels: ReadonlyArray<LabelModel>): LabelModel[] {
  return labels.flatMap((label) => Array.from({ length: label.quantity }, () => label));
}
