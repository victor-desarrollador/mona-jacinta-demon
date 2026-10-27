// OWNER-only, PILOT-only import of the real Local 1 catalog and stock from the
// OWNER's spreadsheet: the 2026-10-13 "local1 corregido.xlsx" layout (local1-v1) or the
// 2026-10-19 "local1.xlsx" layout (local1-v2, see parseLocal1V2), detected by header B2.
//
//   --dry-run   offline: reads the file, checks its SHA-256, validates every cell,
//               prints a sanitized summary (no cost figures) and the catalog digest,
//               and writes a private 0600 report (raw row text, costs, anomalies,
//               totals) outside the repository. No URL file, network, Prisma or client.
//   --authorize OWNER tty ceremony: binds the execution plan digest, the file hash,
//               the target and a VERIFIED pg_dump archive of PILOT into one
//               single-use, short-lived authorization record (0600).
//   --execute   PILOT only: plan digest → URL file/project → backup re-verification →
//               authorization → audited pilot-marker --check → consume authorization →
//               ONE transaction (maintenance lock, marker and 7-migration ledger re-proof,
//               classification ABSENT/EXACT/CONFLICT, canonical catalog-admin and
//               initial-stock services, post-write classification, untouched-branch
//               fingerprint and reconciliation) → receipt.
//
// OWNER decisions encoded here (2026-10-13): every item and unit goes to ONE retail
// location; every other location gets nothing; SKU = sheet code; barcode = SKU
// (provisional); category "General"; brand "Sin marca"; list = yellow unit price (E);
// cash = list × 80/100 and must be exact in centavos; cost = red unit price (I);
// cost 0 and cost above list are kept and reported. INITIAL_STOCK happens once:
// any prior state other than the exact result of this plan is a CONFLICT; nothing
// existing is ever updated. Later merchandise needs its own (not yet built) flow.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  closeSync, constants as fsConstants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { XlsxError, readXlsx } from './xlsx-sheet-reader.mjs';
import { CA_PATH, PROJECT_REF_PATTERN } from './lib.mjs';
import { APPROVED_MIGRATION_PAYLOAD } from './pilot-migrate.mjs';
import { NestedTransactionFailure, OWNER_ACCOUNT, loadCanonical, nestedTransactionAdapter } from './pilot-catalog-bootstrap.mjs';
import {
  CANONICAL_MARKER, GUARD_SCHEMA, PILOT_URL_FILE, createVerifiedClient, deriveProjectRef, main as pilotMarkerMain, parsePilotUrl, readPrivateUrlFile,
} from './pilot-marker.mjs';

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImportError';
    this.code = code;
  }
}

export class Stop extends Error {
  constructor(phase, reason) {
    super(reason);
    this.phase = phase;
  }
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PREFIX = '[db:pilot-local1-catalog-import]';
const CATALOG_DOMAIN = 'MONA/PILOT-LOCAL1-CATALOG/v1';
const EXECUTION_DOMAIN = 'MONA/PILOT-LOCAL1-EXECUTION/v1';
const AUTH_FORMAT = 'mona-pilot-local1-import-authorization/v1';
const CATEGORY = 'General';
const BRAND = 'Sin marca';
const CASH_NUMERATOR = 80n;
const CASH_DENOMINATOR = 100n;
const PILOT_CUIT = 'PILOT-NO-FISCAL';
export const MAINTENANCE_ADVISORY_LOCK_ID = 506005;
export const TRANSACTION_OPTIONS = Object.freeze({ timeout: 600000, maxWait: 10000 });
export const AUTH_TTL_MS = 2 * 60 * 60 * 1000;
export const BACKUP_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const YELLOW = 'FFFFFF00';
const RED = 'FFFF0000';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MARKER_RECHECK_SQL = `SELECT to_regnamespace('mona_test_guard') IS NOT NULL AS test_guard_exists,
  (SELECT coalesce(json_agg(json_build_object('environment', environment, 'marker_id', marker_id::text)), '[]'::json)
     FROM mona_pilot_guard.database_identity) AS rows`;
export const MIGRATIONS_SQL = `SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back
  FROM public._prisma_migrations ORDER BY migration_name, started_at`;
// The archive is held in memory for its inspections; a PILOT backup far above this is refused, not streamed.
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const PG_RESTORE = '/usr/lib/postgresql/17/bin/pg_restore';
// pg_dump writes every column of the marker table, in DDL order, into its COPY statement.
const MARKER_COPY_COLUMNS = ['singleton', 'environment', 'marker_id', 'installed_at'];
const TIMESTAMPTZ_TEXT = /^([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,6}))?([+-])([0-9]{2})(?::([0-9]{2}))?(?::([0-9]{2}))?$/;
// pg_restore is bounded in time; on expiry the child is killed and the backup is refused.
const PG_RESTORE_TIMEOUT_MS = 120000;
// OWNER-confirmed provenance contract (2026-10-13): the import's own AuditLog evidence, written in its transaction.
const PROVENANCE_ACTION = 'PILOT_LOCAL1_IMPORT_COMMITTED';
const PROVENANCE_ENTITY = 'PilotLocal1Import';
const PROVENANCE_FORMAT = 'mona-pilot-local1-import-provenance/v1';
const PROVENANCE_KEYS = ['format', 'authId', 'planDigest', 'catalogDigest', 'fileSha256', 'locationCode', 'markerId', 'projectRef', 'toolSha256',
  'productIds', 'variantIds', 'inventoryIds', 'movementIds', 'totals'];
const GUARD_SCHEMA_NAME = /\bmona_[a-z0-9_]*_guard\b/g;
const BACKUP_TABLES = ['Category', 'Brand', 'Product', 'ProductVariant', 'Inventory', 'StockMovement', 'Location', 'Branch', 'Company', 'AuditLog', '_prisma_migrations'];

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const fail = (code, message) => {
  throw new ImportError(code, message);
};

// --- money / quantities (decimal text → integers; never floating point) ---------------

// Exact centavos from cached decimal text; null when not a plain decimal or more than 2 decimals.
function exactCents(text) {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(text ?? '');
  if (!m) return null;
  const frac = (m[3] ?? '').replace(/0+$/, '');
  if (frac.length > 2) return null;
  const cents = BigInt(m[2]) * 100n + BigInt(frac.padEnd(2, '0') || '0');
  return m[1] ? -cents : cents;
}

// Totals rows may carry binary-float residue (…130000001): round half-up to centavos.
function roundedCents(text) {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(text ?? '');
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(3, '0');
  let cents = BigInt(m[2]) * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) cents += 1n;
  return m[1] ? -cents : cents;
}

const slugOf = (code) => code.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// --- workbook validation ----------------------------------------------------------------

const HEADER = [
  ['B2', 'productos', null], ['D2', 'precio de lista', YELLOW], ['E2', null, YELLOW], ['F2', null, YELLOW],
  ['H2', 'precio de costo', RED], ['I2', null, RED], ['J2', null, RED],
  ['B3', 'codigo / sku', null], ['D3', 'stock', YELLOW], ['E3', 'precio unitario', YELLOW], ['F3', 'stock valorizado', YELLOW],
  ['H3', 'stock', RED], ['I3', 'precio unitario', RED], ['J3', 'stock valorizado', RED],
];

export function parseLocal1Workbook(buffer, expect) {
  let wb;
  try {
    wb = readXlsx(buffer);
  } catch (err) {
    if (err instanceof XlsxError) fail('XLSX', `${err.code}: ${err.message}`);
    throw err;
  }
  if (wb.sheets.length !== 1 || wb.sheets[0].name !== 'Hoja1' || wb.sheets[0].state !== 'visible') {
    fail('SHEET', 'the workbook must hold exactly one visible sheet named Hoja1');
  }
  const { cells, merges } = wb.sheets[0];
  const at = (ref) => cells.get(ref) ?? null;
  const text = (ref) => {
    const c = at(ref);
    return c && c.type === 's' ? c.value : null;
  };
  const has = (c) => c !== null && ((c.value !== null && c.value !== '') || c.formula !== null);
  if ((text('B2') ?? '').normalize('NFC').trim() === V2_HEADER[0][1]) return parseLocal1V2({ cells, merges, at, text, has }, expect);

  for (const [ref, label, fill] of HEADER) {
    const c = at(ref);
    if (label !== null && (text(ref) ?? '').trim() !== label) fail('HEADER', `header ${ref} must read "${label}"`);
    if (label === null && has(c)) fail('HEADER', `header cell ${ref} must be empty`);
    if (fill !== null && c?.fill !== fill) fail('HEADER', `header ${ref} must carry the ${fill === YELLOW ? 'yellow' : 'red'} fill`);
  }

  const totalRows = [...cells.values()].filter((c) => c.col === 'B' && c.row >= 4 && c.type === 's' && c.value.trim() === 'total').map((c) => c.row);
  if (totalRows.length !== 1) fail('TOTALS', 'exactly one "total" row is required below the data');
  const t = totalRows[0];
  const last = t - 1;
  if (last < 4) fail('TOTALS', 'the sheet has no data rows');

  // Nothing but the known layout may carry a value or a formula.
  const allowed = (c) => {
    if (c.row === 2) return ['B', 'D', 'H'].includes(c.col);
    if (c.row === 3) return ['B', 'D', 'E', 'F', 'H', 'I', 'J'].includes(c.col);
    if (c.row >= 4 && c.row <= last) return ['B', 'D', 'E', 'F', 'H', 'I', 'J'].includes(c.col);
    if (c.row === t) return ['B', 'E', 'F', 'I', 'J'].includes(c.col);
    return false;
  };
  for (const c of cells.values()) if (has(c) && !allowed(c)) fail('STRAY_CELL', `unexpected content at ${c.ref}`);

  const expectedMerges = ['B2:C2', 'B3:C3', 'D2:F2', 'H2:J2', `B${t}:C${t}`].sort();
  if (JSON.stringify([...merges].sort()) !== JSON.stringify(expectedMerges)) fail('LAYOUT', 'the merged cells differ from the approved layout');

  // Formulas: cached values are mandatory and only the approved shapes are accepted.
  for (const c of cells.values()) {
    if (c.formula === null) continue;
    if (c.value === null || c.value === '') fail('FORMULA_NO_CACHE', `${c.ref} has a formula without a cached value`);
    const r = c.row;
    const ok = (r >= 4 && r <= last && ((c.col === 'E' && c.formula === `F${r}/D${r}`) || (c.col === 'I' && c.formula === `J${r}/H${r}`)))
      || (r === t && ['E', 'F', 'I', 'J'].includes(c.col) && c.formula === `SUM(${c.col}4:${c.col}${last})`);
    if (!ok) fail('FORMULA_UNEXPECTED', `${c.ref} carries an unexpected formula`);
  }

  const rows = [];
  const anomalies = [];
  const skus = new Map();
  const slugs = new Map();
  let units = 0n;
  let listValue = 0n;
  let cashValue = 0n;
  let costValue = 0n;
  const sums = { E: 0n, F: 0n, I: 0n, J: 0n };
  for (let r = 4; r <= last; r += 1) {
    const raw = text(`B${r}`);
    const m = raw === null ? null : /^\s*(\S+)\s+(\S[\s\S]*?)\s*$/.exec(raw);
    if (!m) fail('ROW_TEXT', `row ${r}: column B must hold "<code> <description>"`);
    const sku = m[1];
    const name = m[2].replace(/\s+/g, ' ');
    if (sku.length > 64 || name.length > 120) fail('LENGTH', `row ${r}: code or description too long`);

    const num = (col) => {
      const c = at(`${col}${r}`);
      return c && c.type === 'n' ? c.value : null;
    };
    const d = num('D');
    const h = num('H');
    if (!/^[1-9][0-9]{0,8}$/.test(d ?? '') || d !== h) fail('STOCK', `row ${r}: yellow and red stock must be the same positive integer`);
    const stock = BigInt(d);

    const list = exactCents(num('E'));
    if (list === null || list <= 0n || (list * CASH_NUMERATOR) % CASH_DENOMINATOR !== 0n) {
      fail('LIST_PRICE', `row ${r}: the list price must be a positive amount whose 80% is exact in centavos`);
    }
    const cash = (list * CASH_NUMERATOR) / CASH_DENOMINATOR;
    const cost = exactCents(num('I'));
    if (cost === null || cost < 0n) fail('COST', `row ${r}: the cost must be a non-negative amount with at most 2 decimals`);
    const f = exactCents(num('F'));
    const j = exactCents(num('J'));
    if (f === null || f !== list * stock) fail('VALUED', `row ${r}: stock valorizado (lista) differs from stock × precio`);
    if (j === null || (cost * stock - j > 1n || j - cost * stock > 1n)) fail('VALUED', `row ${r}: stock valorizado (costo) differs from stock × costo`);

    rows.push(planRow({ r, sku, raw, name, list, cash, cost, stock, skus, slugs, anomalies }));
    units += stock;
    listValue += list * stock;
    cashValue += cash * stock;
    costValue += cost * stock;
    sums.E += list;
    sums.F += f;
    sums.I += cost;
    sums.J += j;
  }

  for (const col of ['E', 'F', 'I', 'J']) {
    const c = at(`${col}${t}`);
    if (!c || c.formula === null || roundedCents(c.value) !== sums[col]) fail('TOTALS', `total ${col}${t} differs from the sum of the rows`);
  }

  const totals = { items: rows.length, units: String(units), listValueCents: String(listValue), cashValueCents: String(cashValue), costValueCents: String(costValue) };
  if (!expect || totals.items !== Number(expect.items) || totals.units !== String(expect.units)) {
    fail('COUNTS', `the sheet holds ${totals.items} items / ${totals.units} units, not the expected counts`);
  }
  return { layout: 'local1-v1', rows, anomalies, totals };
}

// One plan row (both layouts): case-insensitive unique code, unique slug, cost anomalies reported.
function planRow({ r, sku, raw, name, list, cash, cost, stock, skus, slugs, anomalies }) {
  const key = sku.toUpperCase();
  if (skus.has(key)) fail('SKU', `row ${r}: code ${sku} repeats row ${skus.get(key)}`);
  skus.set(key, r);
  const slug = slugOf(sku);
  if (!SLUG.test(slug) || slug.length > 120) fail('SLUG', `row ${r}: code ${sku} yields no valid slug`);
  if (slugs.has(slug)) fail('SLUG', `row ${r}: code ${sku} collides with row ${slugs.get(slug)} as slug ${slug}`);
  slugs.set(slug, r);

  if (cost === 0n) anomalies.push({ row: r, sku, kind: 'COST_ZERO', listCents: String(list), costCents: '0' });
  else if (cost > list) anomalies.push({ row: r, sku, kind: 'COST_ABOVE_LIST', listCents: String(list), costCents: String(cost) });

  return { row: r, sku, barcode: sku, raw, name, slug, listCents: String(list), cashCents: String(cash), costCents: String(cost), stock: String(stock) };
}

// --- workbook validation: the 2026-10-19 layout -----------------------------------------
// OWNER's "local1.xlsx": one header row (2) and data from row 3 down to the first empty B, no
// totals row, no merges, no formulas, values only in B..H. Persisted: tarjeta → list price,
// p. efectivo → cash price (must be exactly list × 80 / 100, the current contract), precio de
// costo → cost, Stock → INITIAL_STOCK (≥ 1: the canonical initial-stock service). p. debito and
// p.transf are NOT persisted (no per-variant column exists: Pricing V2 derives them from the cash
// base and the company adjustments); each is compared with roundHalfUpBps(cash, bps) and every
// difference is reported, never fatal.
const V2_HEADER = [['B2', 'Artículo'], ['C2', 'Stock'], ['D2', 'tarjeta'], ['E2', 'precio de costo'], ['F2', 'p. efectivo'], ['G2', 'p. debito'], ['H2', 'p.transf']];
const V2_COLUMNS = ['B', 'C', 'D', 'E', 'F', 'G', 'H'];
// Pricing V2 adjustments over the cash base (OWNER-confirmed 2026-10-19), api/src/modules/pricing/pricing.ts.
const V2_PRICE_CHECKS = [['DEBIT_CARD', 'G', 'p. debito', 625], ['BANK_TRANSFER', 'H', 'p.transf', 1250]];
const BASIS_POINTS = 10000n;
const roundHalfUpBps = (base, bps) => (base * (BASIS_POINTS + BigInt(bps)) + BASIS_POINTS / 2n) / BASIS_POINTS;

function parseLocal1V2({ cells, merges, at, text, has }, expect) {
  for (const [ref, label] of V2_HEADER) {
    if ((text(ref) ?? '').normalize('NFC').trim() !== label) fail('HEADER', `header ${ref} must read "${label}"`);
  }
  if (merges.length !== 0) fail('LAYOUT', 'the 2026-10-19 layout has no merged cells');
  let last = 2;
  while (has(at(`B${last + 1}`))) last += 1;
  if (last < 3) fail('TOTALS', 'the sheet has no data rows');
  for (const c of cells.values()) if (has(c) && !(c.row >= 2 && c.row <= last && V2_COLUMNS.includes(c.col))) fail('STRAY_CELL', `unexpected content at ${c.ref}`);
  for (const c of cells.values()) if (c.formula !== null) fail('FORMULA_UNEXPECTED', `${c.ref} carries a formula; the 2026-10-19 layout holds values only`);

  const rows = [];
  const anomalies = [];
  const priceDifferences = [];
  const checks = Object.fromEntries(V2_PRICE_CHECKS.map(([mode, , column, bps]) => [mode, { column, adjustmentBps: bps, rows: 0, exact: 0, differ: 0, maxAbs: 0n }]));
  const skus = new Map();
  const slugs = new Map();
  let units = 0n;
  let listValue = 0n;
  let cashValue = 0n;
  let costValue = 0n;
  for (let r = 3; r <= last; r += 1) {
    const raw = text(`B${r}`);
    const m = raw === null ? null : /^\s*(\S+)\s+(\S[\s\S]*?)\s*$/.exec(raw);
    if (!m) fail('ROW_TEXT', `row ${r}: column B must hold "<code> <description>"`);
    const sku = m[1];
    const name = m[2].replace(/\s+/g, ' ');
    if (sku.length > 64 || name.length > 120) fail('LENGTH', `row ${r}: code or description too long`);

    const num = (col) => {
      const c = at(`${col}${r}`);
      return c && c.type === 'n' ? c.value : null;
    };
    const money = (col, label) => {
      const cents = exactCents(num(col));
      if (cents === null) fail('MONEY', `row ${r}: ${label} must be an amount with at most 2 decimals`);
      return cents;
    };
    const d = num('C');
    if (!/^[1-9][0-9]{0,8}$/.test(d ?? '')) fail('STOCK', `row ${r}: Stock must be a whole number of at least 1 (one INITIAL_STOCK per item)`);
    const stock = BigInt(d);
    const list = money('D', 'tarjeta');
    if (list <= 0n || (list * CASH_NUMERATOR) % CASH_DENOMINATOR !== 0n) {
      fail('LIST_PRICE', `row ${r}: tarjeta must be a positive amount whose 80% is exact in centavos`);
    }
    const cost = money('E', 'precio de costo');
    if (cost < 0n) fail('COST', `row ${r}: the cost must be a non-negative amount with at most 2 decimals`);
    const cash = money('F', 'p. efectivo');
    if (cash !== (list * CASH_NUMERATOR) / CASH_DENOMINATOR) fail('CASH_PRICE', `row ${r}: p. efectivo must equal tarjeta × 80 / 100 exactly`);
    for (const [mode, col, column, bps] of V2_PRICE_CHECKS) {
      const sheet = money(col, column);
      if (sheet <= 0n) fail('MONEY', `row ${r}: ${column} must be positive`);
      const system = roundHalfUpBps(cash, bps);
      const diff = sheet - system;
      const k = checks[mode];
      k.rows += 1;
      if (diff === 0n) k.exact += 1;
      else {
        k.differ += 1;
        const abs = diff < 0n ? -diff : diff;
        if (abs > k.maxAbs) k.maxAbs = abs;
        priceDifferences.push({ row: r, sku, mode, sheetCents: String(sheet), systemCents: String(system), diffCents: String(diff) });
      }
    }

    rows.push(planRow({ r, sku, raw, name, list, cash, cost, stock, skus, slugs, anomalies }));
    units += stock;
    listValue += list * stock;
    cashValue += cash * stock;
    costValue += cost * stock;
  }

  const totals = { items: rows.length, units: String(units), listValueCents: String(listValue), cashValueCents: String(cashValue), costValueCents: String(costValue) };
  if (!expect || totals.items !== Number(expect.items) || totals.units !== String(expect.units)) {
    fail('COUNTS', `the sheet holds ${totals.items} items / ${totals.units} units, not the expected counts`);
  }
  const priceChecks = Object.fromEntries(Object.entries(checks).map(([mode, k]) => [mode,
    { column: k.column, adjustmentBps: k.adjustmentBps, rows: k.rows, exact: k.exact, differ: k.differ, maxAbsDiffCents: String(k.maxAbs) }]));
  return { layout: 'local1-v2', rows, anomalies, totals, priceChecks, priceDifferences };
}

// --- plan -------------------------------------------------------------------------------

export function buildCatalogPlan({ fileSha256, parsed }) {
  const v2 = parsed.layout === 'local1-v2';
  const doc = {
    format: 'mona-pilot-local1-catalog-plan/v1',
    ...(v2 ? { layout: 'local1-v2' } : {}),
    file: { sha256: fileSha256, sheet: 'Hoja1' },
    decisions: {
      category: CATEGORY,
      brand: BRAND,
      barcode: 'sku',
      ...(v2 ? {
        listPrice: 'column "tarjeta"',
        cashPrice: `column "p. efectivo", equal to list * ${CASH_NUMERATOR} / ${CASH_DENOMINATOR} exactly`,
        costPrice: 'column "precio de costo"',
        debitTransfer: 'columns "p. debito" / "p.transf" compared with Pricing V2 (cash + company bps, half-up); never persisted',
      } : {
        listPrice: 'yellow column E (unit price)',
        cashPrice: `list * ${CASH_NUMERATOR} / ${CASH_DENOMINATOR}, exact in centavos`,
        costPrice: 'red column I (unit price)',
      }),
      stock: 'all units to the target retail location; every other location receives nothing',
      initialStock: 'once per variant; any other prior state is a conflict',
    },
    columns: ['row', 'sku', 'barcode', 'slug', 'name', 'raw', 'listCents', 'cashCents', 'costCents', 'stock'],
    rows: parsed.rows.map((r) => [r.row, r.sku, r.barcode, r.slug, r.name, r.raw, r.listCents, r.cashCents, r.costCents, r.stock]),
    anomalies: parsed.anomalies.map((a) => [a.row, a.sku, a.kind]),
    totals: parsed.totals,
    ...(v2 ? { priceChecks: parsed.priceChecks } : {}),
  };
  const canonical = JSON.stringify(doc);
  return {
    fileSha256,
    canonical,
    catalogDigest: sha256(`${CATALOG_DOMAIN}\n${canonical}`),
    layout: parsed.layout,
    rows: parsed.rows.map((r) => ({ ...r })),
    anomalies: parsed.anomalies.map((a) => ({ ...a })),
    totals: { ...parsed.totals },
    ...(v2 ? { priceChecks: parsed.priceChecks, priceDifferences: parsed.priceDifferences.map((d) => ({ ...d })) } : {}),
  };
}

export function executionDigest({ catalogDigest, locationCode, markerId, projectRef, toolSha256 }) {
  return sha256(`${EXECUTION_DOMAIN}\n${JSON.stringify([catalogDigest, locationCode, markerId, projectRef, toolSha256])}`);
}

// --- CLI --------------------------------------------------------------------------------

const MODES = ['dry-run', 'authorize', 'execute'];
const COMMON = ['file', 'expect-file-sha256', 'expect-items', 'expect-units'];
const REQUIRED = {
  'dry-run': COMMON,
  authorize: [...COMMON, 'location', 'marker-id', 'project-ref', 'plan', 'backup', 'backup-sha256'],
  execute: [...COMMON, 'location', 'marker-id', 'confirm-project-ref', 'plan', 'backup', 'backup-sha256', 'authorization'],
};
const OPTIONAL = { 'dry-run': ['location', 'marker-id', 'project-ref'], authorize: [], execute: [] };
const FORMAT = {
  file: (v) => path.isAbsolute(v) && !v.includes('\0'),
  backup: (v) => path.isAbsolute(v) && !v.includes('\0'),
  'expect-file-sha256': (v) => HEX64.test(v),
  'backup-sha256': (v) => HEX64.test(v),
  plan: (v) => HEX64.test(v),
  'expect-items': (v) => /^[1-9][0-9]{0,5}$/.test(v),
  'expect-units': (v) => /^[1-9][0-9]{0,9}$/.test(v),
  location: (v) => /^[A-Z]{2,6}$/.test(v),
  'marker-id': (v) => UUID_V4.test(v),
  'project-ref': (v) => PROJECT_REF_PATTERN.test(v),
  'confirm-project-ref': (v) => PROJECT_REF_PATTERN.test(v),
  authorization: (v) => /^[0-9a-f]{32}$/.test(v),
};

export function parseCliArgs(argv) {
  const modes = argv.filter((a) => MODES.some((m) => a === `--${m}`));
  if (modes.length !== 1) return { ok: false, error: `exactly one of ${MODES.map((m) => `--${m}`).join(', ')} is required` };
  const mode = modes[0].slice(2);
  const values = {};
  for (const arg of argv) {
    if (arg === modes[0]) continue;
    const m = /^--([a-z0-9-]+)=(.*)$/s.exec(arg);
    if (!m) return { ok: false, error: 'unrecognized argument (value not shown)' };
    const [, key, value] = m;
    if (![...REQUIRED[mode], ...OPTIONAL[mode]].includes(key)) return { ok: false, error: `--${key} is not accepted with --${mode}` };
    if (Object.hasOwn(values, key)) return { ok: false, error: `--${key} is given twice` };
    if (!FORMAT[key](value)) return { ok: false, error: `--${key} is malformed (value not shown)` };
    values[key] = value;
  }
  for (const key of REQUIRED[mode]) if (!Object.hasOwn(values, key)) return { ok: false, error: `--${key} is required with --${mode}` };
  const target = OPTIONAL[mode].filter((k) => Object.hasOwn(values, k));
  if (target.length !== 0 && target.length !== OPTIONAL[mode].length) return { ok: false, error: '--location, --marker-id and --project-ref go together' };
  return { ok: true, mode, values };
}

// --- private files ----------------------------------------------------------------------

// The real location of a path: its deepest existing ancestor resolved through every symlink, plus the
// not-yet-existing remainder. A symlinked parent can therefore not hide a forbidden root.
function realLocation(p) {
  let current = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(p);
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

function underAny(file, roots) {
  const targets = [path.resolve(file), realLocation(file)];
  return roots.some((root) => [path.resolve(root), realLocation(root)].some((r) => targets.some((t) => t === r || t.startsWith(`${r}${path.sep}`))));
}

export function ensurePrivateDir(dir, forbiddenRoots, phase) {
  if (underAny(dir, forbiddenRoots)) throw new Stop(phase, 'private output directory lies inside the repository or temporary storage');
  let st;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    st = lstatSync(dir);
  } catch {
    throw new Stop(phase, 'private output directory could not be created (path not shown)');
  }
  if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077) !== 0) throw new Stop(phase, 'private output directory must be an owner-only (0700) directory');
}

const defaultFsOps = Object.freeze({ openSync, writeSync, fsyncSync, closeSync, unlinkSync });

export function writeExclusive(file, text, phase, fsOps = defaultFsOps) {
  const buffer = Buffer.from(text, 'utf8');
  let fd;
  try {
    fd = fsOps.openSync(file, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW ?? 0), 0o600);
  } catch {
    throw new Stop(phase, 'a private file could not be created exclusively (it may already exist)');
  }

  let failed = false;
  try {
    let offset = 0;
    while (offset < buffer.length) {
      const remaining = buffer.length - offset;
      const written = fsOps.writeSync(fd, buffer, offset, remaining, offset);
      if (!Number.isInteger(written) || written <= 0 || written > remaining) throw new Error('invalid write progress');
      offset += written;
    }
    fsOps.fsyncSync(fd);
  } catch {
    failed = true;
  }
  try {
    fsOps.closeSync(fd);
  } catch {
    failed = true;
  }
  if (failed) {
    if (phase === 'report' || phase === 'authorize') {
      try {
        fsOps.unlinkSync(file);
      } catch {
        // Best effort: malformed or incomplete files are rejected when read.
      }
    }
    throw new Stop(phase, 'a private file could not be written safely');
  }
}

function publishReceipt({ reportRoot, forbiddenRoots, now, planDigest, authorization, result, fsOps = defaultFsOps }) {
  ensurePrivateDir(reportRoot, forbiddenRoots, 'receipt');
  const dir = path.join(reportRoot, `${stamp(now())}-${planDigest.slice(0, 12)}-execute-${randomBytes(4).toString('hex')}`);
  ensurePrivateDir(dir, forbiddenRoots, 'receipt');
  writeExclusive(path.join(dir, 'receipt.json'), `${JSON.stringify({ format: 'mona-pilot-local1-import-receipt/v1', authId: authorization, planDigest, result }, (_, x) => (typeof x === 'bigint' ? String(x) : x), 2)}\n`, 'receipt', fsOps);
}

export function readOwnerFile(file, maxBytes) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    return { ok: false, reason: 'missing or not readable' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'not a regular file' };
    if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) return { ok: false, reason: 'must be owned by this user with mode 0600' };
    if (st.size > maxBytes) return { ok: false, reason: 'too large' };
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return off === st.size ? { ok: true, buf } : { ok: false, reason: 'short read' };
  } finally {
    closeSync(fd);
  }
}

// --- backup evidence --------------------------------------------------------------------

function parseArchiveTime(date, time, zone) {
  let offset;
  if (zone === 'UTC' || zone === 'GMT') offset = 'Z';
  else if (/^[+-][0-9]{2}$/.test(zone)) offset = `${zone}:00`;
  else if (/^[+-][0-9]{2}:?[0-9]{2}$/.test(zone)) offset = `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  else return null;
  const ms = Date.parse(`${date}T${time}${offset}`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

// Positioned reads only: the descriptor offset never moves, so the same descriptor can be re-read from 0.
function preadAll(fd, size) {
  const buf = Buffer.alloc(size);
  let off = 0;
  while (off < size) {
    const n = readSync(fd, buf, off, size - off, off);
    if (n === 0) throw new Error('short archive read');
    off += n;
  }
  if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) throw new Error('archive grew while reading');
  return buf;
}

// pg_restore never opens a path: each inspection receives exactly the bytes whose digest was checked, on stdin.
// No filename argument and no connection option, so it can neither reopen the backup nor reach a database.
export function pgRestoreInvocation(kind, archive) {
  const options = {
    env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', input: archive, stdio: ['pipe', 'pipe', 'ignore'], timeout: PG_RESTORE_TIMEOUT_MS, killSignal: 'SIGKILL',
  };
  if (kind === 'list') return { file: PG_RESTORE, args: ['--list', '--format=custom'], options: { ...options, maxBuffer: 64 * 1024 * 1024 } };
  if (kind === 'markerData') {
    return {
      file: PG_RESTORE,
      args: ['--format=custom', '--data-only', '--no-owner', '--no-privileges', `--schema=${GUARD_SCHEMA}`, '--table=database_identity', '--file=-'],
      options: { ...options, maxBuffer: 1024 * 1024 },
    };
  }
  throw new Error('unknown pg_restore invocation');
}

// A timestamptz as pg_dump writes it (ISO DateStyle), checked as a real calendar instant; null otherwise.
function parseTimestamptz(text) {
  const m = TIMESTAMPTZ_TEXT.exec(text);
  if (!m) return null;
  const [y, mo, d, h, mi, sec] = m.slice(1, 7).map(Number);
  const [sign, oh, om, os] = [m[8], Number(m[9]), Number(m[10] ?? 0), Number(m[11] ?? 0)];
  const daysInMonth = mo >= 1 && mo <= 12 ? new Date(Date.UTC(y, mo, 0)).getUTCDate() : 0;
  if (d < 1 || d > daysInMonth || h > 23 || mi > 59 || sec > 59 || oh > 15 || om > 59 || os > 59) return null;
  const fraction = Number(`0.${m[7] ?? '0'}`) * 1000;
  const offsetMs = (sign === '-' ? -1 : 1) * ((oh * 3600) + (om * 60) + os) * 1000;
  return new Date(Date.UTC(y, mo - 1, d, h, mi, sec) + fraction - offsetMs);
}

// The marker row exactly as pg_dump writes the canonical table (pilot-marker.mjs CANONICAL_MARKER): one COPY with
// every column in DDL order and one row (singleton t, environment pilot, the marker id, a timestamptz). Anything
// else — another column list, a second row or COPY, NULLs, another environment — yields null.
function markerFromArchiveData(output) {
  const canonical = CANONICAL_MARKER.columns.map((c) => c.name);
  if (JSON.stringify(canonical) !== JSON.stringify(MARKER_COPY_COLUMNS)) return null;
  const text = String(output);
  const copies = [...text.matchAll(new RegExp(`^COPY ${GUARD_SCHEMA}\\.database_identity \\(([^)\\n]*)\\) FROM stdin;\\r?\\n([^]*?)^\\\\\\.\\r?$`, 'gm'))];
  if (copies.length !== 1 || (text.match(/^COPY /gm) ?? []).length !== 1) return null;
  if (copies[0][1] !== MARKER_COPY_COLUMNS.join(', ')) return null;
  const rows = copies[0][2].replace(/\r?\n$/, '').split(/\r?\n/);
  if (rows.length !== 1) return null;
  const fields = rows[0].split('\t');
  if (fields.length !== MARKER_COPY_COLUMNS.length) return null;
  const [singleton, environment, markerId, installedAt] = fields;
  const installed = parseTimestamptz(installedAt);
  if (singleton !== 't' || environment !== 'pilot' || !UUID_V4.test(markerId) || !installed) return null;
  return { markerId, installedAt: installed };
}

export function verifyBackupArchive({ path: file, expectedSha256, expectedDbname, expectedMarkerId, now, forbiddenRoots, pgRestoreList, pgRestoreMarkerData, maxArchiveBytes = MAX_ARCHIVE_BYTES, fsOps = {} }) {
  const no = (reason) => ({ ok: false, reason });
  const fsx = { openSync, ...fsOps };
  const privateFile = (x) => x.isFile() && x.uid === process.getuid() && (x.mode & 0o077) === 0;
  if (!path.isAbsolute(file)) return no('the backup path must be absolute');
  if (underAny(file, forbiddenRoots)) return no('the backup lies inside the repository or temporary storage');
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return no('the backup file is missing');
  }
  if (!st.isFile()) return no('the backup is not a regular file (symlinks are refused)');
  if (st.uid !== process.getuid() || (st.mode & 0o077) !== 0) return no('the backup must be owned by this user with mode 0600');
  if (st.size < 5) return no('the backup is empty');
  if (st.size > maxArchiveBytes) return no('the backup exceeds the archive size limit');

  // One held descriptor for the whole verification; the inspected bytes are read from it exactly once.
  let fd;
  try {
    fd = fsx.openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  } catch {
    return no('the backup could not be opened');
  }
  try {
    let held;
    let archive;
    try {
      held = fstatSync(fd);
      // The descriptor itself must be the private regular file: no window between the path checks and the open.
      if (!privateFile(held)) return no('the backup must be owned by this user with mode 0600');
      if (held.dev !== st.dev || held.ino !== st.ino || held.size !== st.size) return no('the inspected backup changed during verification');
      archive = preadAll(fd, held.size);
    } catch {
      return no('the inspected backup changed during verification');
    }
    const actual = sha256(archive);
    if (actual !== expectedSha256) return no('the backup SHA-256 differs from --backup-sha256');
    if (archive.subarray(0, 5).toString('latin1') !== 'PGDMP') return no('the backup is not a pg_dump custom-format archive');
    let list;
    try {
      list = String(pgRestoreList(Buffer.from(archive)));
    } catch {
      return no('pg_restore --list could not read the archive');
    }
    const created = /^;\s+Archive created at ([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) (\S+)\s*$/m.exec(list);
    const when = created ? parseArchiveTime(created[1], created[2], created[3]) : null;
    if (!when) return no('the archive creation time is missing or not parseable');
    const age = now.getTime() - when.getTime();
    if (age < -CLOCK_SKEW_MS) return no('the archive claims a creation time in the future');
    if (age > BACKUP_MAX_AGE_MS) return no('the archive is older than 6 hours');
    const dbname = /^;\s+dbname: (.+?)\s*$/m.exec(list)?.[1];
    if (dbname !== expectedDbname) return no('the archive was taken from another database');
    // A14: a PILOT recovery point never carries a TEST, LOCAL_TEST or any other environment's guard schema.
    const guards = new Set(list.split(/\r?\n/).filter((line) => !line.startsWith(';')).flatMap((line) => line.match(GUARD_SCHEMA_NAME) ?? []));
    if (guards.size !== 1 || !guards.has(GUARD_SCHEMA)) return no('the archive carries the guard schema of another environment (mixed environments are refused)');
    if (!/^[0-9]+; [0-9]+ [0-9]+ SCHEMA - mona_pilot_guard /m.test(list)) return no('the archive does not contain the PILOT guard schema');
    if (!/^[0-9]+; [0-9]+ [0-9]+ TABLE DATA mona_pilot_guard database_identity /m.test(list)) return no('the archive does not contain the PILOT marker data');
    for (const table of BACKUP_TABLES) {
      if (!new RegExp(`^[0-9]+; [0-9]+ [0-9]+ TABLE DATA public ${table} `, 'm').test(list)) return no(`the archive does not contain table data for ${table}`);
    }
    let markerData;
    try { markerData = pgRestoreMarkerData(Buffer.from(archive)); } catch { return no('the PILOT marker data could not be extracted from the archive'); }
    const marker = markerFromArchiveData(markerData);
    if (marker?.markerId !== expectedMarkerId) return no('the archive does not contain exactly the expected PILOT marker value');
    // The marker existed before the dump that contains it.
    if (marker.installedAt.getTime() > when.getTime() + CLOCK_SKEW_MS) return no('the archive does not contain exactly the expected PILOT marker value (installed after the archive)');
    // The verified backup must still be this very file: same inode at the path, same size, same digest.
    try {
      const atPath = lstatSync(file);
      const now2 = fstatSync(fd);
      if (!privateFile(atPath) || !privateFile(now2) || atPath.dev !== held.dev || atPath.ino !== held.ino || now2.size !== held.size
        || (atPath.mode & 0o777) !== (held.mode & 0o777) || atPath.uid !== held.uid
        || sha256(preadAll(fd, held.size)) !== actual) return no('the inspected backup changed during verification');
    } catch { return no('the inspected backup changed during verification'); }
    return { ok: true, sha256: actual, createdAt: when.toISOString(), dbname };
  } finally {
    closeSync(fd);
  }
}

// --- classification ---------------------------------------------------------------------

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));

const sortedIds = (rows) => rows.map((r) => r.id).sort();
const sameList = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]);
const totalsWithoutCost = (t) => ({ items: t.items, units: t.units, listValueCents: t.listValueCents, cashValueCents: t.cashValueCents });
// Structural JSON equality. JSONB does not keep object key order, so objects compare by key set and values;
// arrays stay ordered.
function sameJson(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    return sameList(ka, Object.keys(b).sort()) && ka.every((k) => sameJson(a[k], b[k]));
  }
  return a === b;
}

// The import's own evidence, bound to the plan, the target and the exact rows it created (OWNER-confirmed contract).
function provenanceConflict(prov, expected) {
  const a = prov.after;
  if (prov.userId !== expected.ownerId || prov.branchId !== expected.locationId || prov.entityType !== PROVENANCE_ENTITY || prov.entityId !== expected.catalogDigest) {
    return 'the import provenance is not bound to this OWNER, location and catalog';
  }
  if (a === null || typeof a !== 'object' || Array.isArray(a) || !sameList(Object.keys(a).sort(), [...PROVENANCE_KEYS].sort())) return 'the import provenance record is malformed';
  if (a.format !== PROVENANCE_FORMAT || !/^[0-9a-f]{32}$/.test(a.authId ?? '') || !HEX64.test(a.planDigest ?? '') || !HEX64.test(a.toolSha256 ?? '')) return 'the import provenance record is malformed';
  // The recorded plan digest must be the one its own fields produce (the tool digest may differ from today's tool).
  if (a.planDigest !== executionDigest({ catalogDigest: a.catalogDigest, locationCode: a.locationCode, markerId: a.markerId, projectRef: a.projectRef, toolSha256: a.toolSha256 })) {
    return 'the import provenance plan digest is not derived from its own fields';
  }
  if (a.catalogDigest !== expected.catalogDigest || a.fileSha256 !== expected.fileSha256 || a.locationCode !== expected.locationCode
    || a.markerId !== expected.markerId || a.projectRef !== expected.projectRef) return 'the import provenance is bound to another plan or target';
  for (const key of ['productIds', 'variantIds', 'inventoryIds', 'movementIds']) {
    if (!sameList(a[key], expected[key])) return `the import provenance does not cover exactly the current ${key}`;
  }
  if (!sameJson(a.totals, expected.totals)) return 'the import provenance totals differ from the plan';
  return null;
}

export function classifyImportState(s, plan, { locationCode, ownerId, markerId, projectRef, provenance = 'required' }) {
  const conflicts = [];
  const audits = s.audits ?? [];
  const provenances = audits.filter((a) => a.action === PROVENANCE_ACTION);
  const locs = s.locations.filter((l) => l.code === locationCode);
  const loc = locs.length === 1 ? locs[0] : null;
  if (!loc) conflicts.push(`location ${locationCode} must exist exactly once`);
  else {
    if (loc.type !== 'RETAIL_BRANCH') conflicts.push(`location ${locationCode} is not a RETAIL_BRANCH`);
    if (loc.isActive !== true) conflicts.push(`location ${locationCode} is not active`);
    if (!s.branches.some((b) => b.id === loc.id)) conflicts.push(`location ${locationCode} has no Branch with the same id`);
    const company = s.companies.find((c) => c.id === loc.companyId);
    if (!company || company.cuit !== PILOT_CUIT || company.isActive !== true) conflicts.push(`location ${locationCode} does not belong to the active PILOT company`);
  }
  if (s.owners.length !== 1 || s.owners[0].id !== ownerId || s.owners[0].isActive !== true) conflicts.push('the OWNER audit actor must exist and be active');
  const category = s.categories.find((c) => c.name === CATEGORY) ?? null;
  const brand = s.brands.find((b) => b.name === BRAND) ?? null;
  const base = { locationId: loc?.id ?? null, categoryId: category?.id ?? null, brandId: brand?.id ?? null };
  if (conflicts.length) return { state: 'CONFLICT', conflicts, ...base };

  if (s.variants.length === 0 && s.products.length === 0) {
    if (provenances.length !== 0) return { state: 'CONFLICT', conflicts: ['an import provenance exists without its catalog rows'], ...base };
    return s.inventory.length === 0 && s.movements.length === 0 ? { state: 'ABSENT', conflicts, ...base } : { state: 'CONFLICT', conflicts: ['inventory without catalog rows'], ...base };
  }

  if (s.variants.length !== plan.rows.length) conflicts.push(`found ${s.variants.length} catalog variants matching the plan codes/barcodes, expected ${plan.rows.length} or none`);
  if (s.products.length !== plan.rows.length) conflicts.push(`found ${s.products.length} products matching the plan, expected ${plan.rows.length} or none`);
  for (const r of plan.rows) {
    const v = s.variants.filter((x) => x.sku === r.sku);
    if (v.length !== 1) {
      conflicts.push(`${r.sku}: variant missing`);
      continue;
    }
    const variant = v[0];
    const p = s.products.find((x) => x.id === variant.productId);
    const sameVariant = variant.barcode === r.barcode && variant.color === null && variant.size === null && variant.isActive === true
      && variant.wholesalePrice === null && big(variant.cashPrice ?? -1) === big(r.cashCents) && big(variant.price) === big(r.listCents)
      && big(variant.costPrice) === big(r.costCents);
    if (!sameVariant) conflicts.push(`${r.sku}: existing variant differs from the plan (never updated)`);
    if (!p || p.name !== r.name || p.slug !== r.slug || p.categoryId !== base.categoryId || p.brandId !== base.brandId || p.isActive !== true || p.description !== null) {
      conflicts.push(`${r.sku}: existing product differs from the plan (never updated)`);
    }
    const inv = s.inventory.filter((i) => i.variantId === variant.id);
    if (inv.length !== 1 || inv[0].branchId !== base.locationId || big(inv[0].physical) !== big(r.stock) || big(inv[0].reserved) !== 0n) {
      conflicts.push(`${r.sku}: inventory is not exactly ${r.stock} units at ${locationCode} only`);
      continue;
    }
    const mv = s.movements.filter((m) => m.inventoryId === inv[0].id);
    if (mv.length !== 1 || mv[0].type !== 'INITIAL_STOCK' || big(mv[0].quantityDelta) !== big(r.stock) || mv[0].branchId !== base.locationId || mv[0].saleId !== null
      || mv[0].userId !== ownerId) {
      conflicts.push(`${r.sku}: stock ledger is not exactly one OWNER INITIAL_STOCK of ${r.stock}`);
    }
    // Exactly the canonical OWNER audit of each created row — with the full snapshots the services write
    // (catalog-admin.service.ts productSelect/variantSelect, initial-stock.service.ts) — and no other audit of it.
    const only = (entityId) => audits.filter((x) => x.entityId === entityId);
    const canonicalAudit = (rows, action, entityType, branchId, before, after) => rows.length === 1 && rows[0].action === action
      && rows[0].entityType === entityType && rows[0].userId === ownerId && rows[0].branchId === branchId
      && sameJson(rows[0].before ?? null, before) && sameJson(rows[0].after ?? null, after);
    if (!canonicalAudit(only(variant.productId), 'PRODUCT_CREATED', 'Product', null, null,
      { id: variant.productId, name: r.name, slug: r.slug, categoryId: base.categoryId, brandId: base.brandId, isActive: true })) {
      conflicts.push(`${r.sku}: product audit trail is not exactly one canonical OWNER PRODUCT_CREATED`);
    }
    if (!canonicalAudit(only(variant.id), 'PRODUCT_VARIANT_CREATED', 'ProductVariant', null, null, {
      id: variant.id, productId: variant.productId, sku: r.sku, barcode: r.barcode, color: null, size: null,
      cashPrice: r.cashCents, price: r.listCents, wholesalePrice: null, costPrice: r.costCents, isActive: true,
    })) {
      conflicts.push(`${r.sku}: variant audit trail is not exactly one canonical OWNER PRODUCT_VARIANT_CREATED`);
    }
    if (!canonicalAudit(only(inv[0].id), 'INVENTORY_INITIAL_STOCK_LOADED', 'Inventory', base.locationId, { physical: '0', reserved: '0' },
      { physical: r.stock, reserved: '0', quantity: r.stock, variantId: variant.id })) {
      conflicts.push(`${r.sku}: inventory audit trail is not exactly one canonical OWNER INVENTORY_INITIAL_STOCK_LOADED of ${r.stock}`);
    }
  }
  if (conflicts.length === 0) {
    if (provenance === 'pending') {
      if (provenances.length !== 0) conflicts.push('an import provenance already exists');
    } else if (provenances.length !== 1) {
      conflicts.push(provenances.length === 0 ? 'the catalog has no import provenance (not created by this import)' : 'more than one import provenance exists');
    } else {
      const why = provenanceConflict(provenances[0], {
        ownerId, locationId: base.locationId, locationCode, markerId, projectRef, catalogDigest: plan.catalogDigest, fileSha256: plan.fileSha256,
        productIds: sortedIds(s.products), variantIds: sortedIds(s.variants), inventoryIds: sortedIds(s.inventory), movementIds: sortedIds(s.movements),
        totals: totalsWithoutCost(plan.totals),
      });
      if (why) conflicts.push(why);
    }
  }
  return { state: conflicts.length ? 'CONFLICT' : 'EXACT', conflicts, ...base };
}

// --- transaction body -------------------------------------------------------------------

async function readImportSnapshot(tx, plan, { locationCode, ownerId }) {
  const skus = plan.rows.map((r) => r.sku);
  const slugs = plan.rows.map((r) => r.slug);
  const locations = await tx.location.findMany({ where: { code: locationCode }, select: { id: true, code: true, type: true, isActive: true, companyId: true } });
  const branches = await tx.branch.findMany({ where: { id: { in: locations.map((l) => l.id) } }, select: { id: true, code: true } });
  const companies = await tx.company.findMany({ where: { id: { in: locations.map((l) => l.companyId) } }, select: { id: true, cuit: true, isActive: true } });
  const owners = await tx.user.findMany({ where: { id: ownerId }, select: { id: true, email: true, isActive: true } });
  const categories = await tx.category.findMany({ where: { name: CATEGORY }, select: { id: true, name: true } });
  const brands = await tx.brand.findMany({ where: { name: BRAND }, select: { id: true, name: true } });
  const variants = await tx.productVariant.findMany({
    where: { OR: [{ sku: { in: skus } }, { barcode: { in: skus } }] },
    select: { id: true, productId: true, sku: true, barcode: true, color: true, size: true, cashPrice: true, price: true, wholesalePrice: true, costPrice: true, isActive: true },
  });
  const products = await tx.product.findMany({
    where: { OR: [{ slug: { in: slugs } }, { id: { in: variants.map((v) => v.productId) } }] },
    select: { id: true, name: true, slug: true, description: true, categoryId: true, brandId: true, isActive: true },
  });
  const inventory = await tx.inventory.findMany({ where: { variantId: { in: variants.map((v) => v.id) } }, select: { id: true, variantId: true, branchId: true, physical: true, reserved: true } });
  const movements = await tx.stockMovement.findMany({
    where: { inventoryId: { in: inventory.map((i) => i.id) } },
    select: { id: true, inventoryId: true, type: true, quantityDelta: true, saleId: true, branchId: true, userId: true },
  });
  const entityIds = [...products.map((x) => x.id), ...variants.map((x) => x.id), ...inventory.map((x) => x.id)];
  const audits = await tx.auditLog.findMany({
    where: { OR: [{ action: PROVENANCE_ACTION }, { entityId: { in: entityIds } }] },
    select: { id: true, userId: true, branchId: true, action: true, entityType: true, entityId: true, before: true, after: true },
  });
  return { locations, branches, companies, owners, categories, brands, products, variants, inventory, movements, audits };
}

async function otherInventoryFingerprint(tx, excludeVariantIds) {
  const rows = await tx.inventory.findMany({
    where: { NOT: { variantId: { in: excludeVariantIds } } },
    select: { id: true, variantId: true, branchId: true, physical: true, reserved: true },
  });
  const canonical = rows.map((r) => [r.id, r.variantId, r.branchId, String(r.physical), String(r.reserved)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256(JSON.stringify(canonical));
}

export function parseMarkerRows(marker) {
  let rows = marker?.rows;
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows);
    } catch {
      rows = null;
    }
  }
  return Array.isArray(rows) ? rows : [];
}

export async function importTransaction(tx, ctx) {
  const { plan, locationCode, markerId, owner, canonical, approvedMigrations, provenance } = ctx;
  if (!provenance || !/^[0-9a-f]{32}$/.test(provenance.authId ?? '') || !HEX64.test(provenance.planDigest ?? '') || !HEX64.test(provenance.toolSha256 ?? '')
    || !PROJECT_REF_PATTERN.test(provenance.projectRef ?? '')) {
    throw new Stop('identity', 'the import provenance context is missing or malformed; nothing was written');
  }
  if (provenance.planDigest !== executionDigest({ catalogDigest: plan.catalogDigest, locationCode, markerId, projectRef: provenance.projectRef, toolSha256: provenance.toolSha256 })) {
    throw new Stop('identity', 'the import provenance plan digest is not derived from this plan and target; nothing was written');
  }
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${MAINTENANCE_ADVISORY_LOCK_ID})::text`;

  const [marker] = await tx.$queryRawUnsafe(MARKER_RECHECK_SQL);
  const markerRows = parseMarkerRows(marker);
  if (marker?.test_guard_exists !== false || markerRows.length !== 1 || markerRows[0].environment !== 'pilot' || markerRows[0].marker_id !== markerId) {
    throw new Stop('identity', 'the write session does not see exactly the proven PILOT marker (or sees a TEST marker); nothing was written');
  }
  const ledger = await tx.$queryRawUnsafe(MIGRATIONS_SQL);
  const ledgerOk = Array.isArray(ledger) && ledger.length === approvedMigrations.length && ledger.every((m, i) => m.migration_name === approvedMigrations[i].name
    && m.checksum === approvedMigrations[i].sha256 && m.finished === true && m.rolled_back === false);
  if (!ledgerOk) throw new Stop('identity', `the migration ledger is not exactly the ${approvedMigrations.length} approved migrations; nothing was written`);

  const opts = { locationCode, ownerId: owner.id, markerId, projectRef: provenance.projectRef };
  const before = classifyImportState(await readImportSnapshot(tx, plan, opts), plan, opts);
  if (before.state === 'CONFLICT') {
    const more = before.conflicts.length > 1 ? ` (+${before.conflicts.length - 1} more)` : '';
    throw new Stop('conflict', `${before.conflicts[0]}${more}; nothing was written`);
  }
  if (before.state === 'EXACT') return { action: 'NOOP', totals: { ...plan.totals } };

  const otherBefore = await otherInventoryFingerprint(tx, []);
  let categories = 0;
  let brands = 0;
  let categoryId = before.categoryId;
  let brandId = before.brandId;
  if (!categoryId) {
    categoryId = (await tx.category.create({ data: { name: CATEGORY }, select: { id: true } })).id;
    categories = 1;
  }
  if (!brandId) {
    brandId = (await tx.brand.create({ data: { name: BRAND }, select: { id: true } })).id;
    brands = 1;
  }

  const nested = nestedTransactionAdapter(tx);
  const admin = canonical.createCatalogAdminService(nested.db);
  const stock = canonical.createInitialStockService(nested.db);
  const created = [];
  for (const r of plan.rows) {
    const product = await admin.createProduct(owner.id, canonical.createProductSchema.parse({ name: r.name, slug: r.slug, categoryId, brandId }));
    const variant = await admin.createVariant(owner.id, canonical.createVariantSchema.parse({
      productId: product.id, sku: r.sku, barcode: r.barcode, cashPrice: r.cashCents, price: r.listCents, costPrice: r.costCents,
    }));
    await stock.loadInitialStock(owner.id, canonical.initialStockSchema.parse({ variantId: variant.id, branchId: before.locationId, quantity: r.stock }));
    created.push(variant.id);
  }
  if (nested.failed) throw new NestedTransactionFailure();

  const afterSnapshot = await readImportSnapshot(tx, plan, opts);
  const after = classifyImportState(afterSnapshot, plan, { ...opts, provenance: 'pending' });
  if (after.state !== 'EXACT') throw new Stop('verify', `post-write verification failed (${after.conflicts[0] ?? 'state not exact'}); rolled back`);
  if ((await otherInventoryFingerprint(tx, created)) !== otherBefore) throw new Stop('verify', 'inventory of another variant or location changed during the import; rolled back');

  const physicalOf = new Map(afterSnapshot.inventory.map((i) => [i.variantId, big(i.physical)]));
  let units = 0n;
  let listValue = 0n;
  let cashValue = 0n;
  let costValue = 0n;
  for (const v of afterSnapshot.variants) {
    const q = physicalOf.get(v.id) ?? 0n;
    units += q;
    listValue += big(v.price) * q;
    cashValue += big(v.cashPrice) * q;
    costValue += big(v.costPrice) * q;
  }
  const totals = { items: afterSnapshot.variants.length, units: String(units), listValueCents: String(listValue), cashValueCents: String(cashValue), costValueCents: String(costValue) };
  if (JSON.stringify(totals) !== JSON.stringify(plan.totals)) throw new Stop('verify', 'reconciliation totals differ from the plan; rolled back');

  // Last write of the transaction: the import's provenance, bound to exactly the verified rows.
  await tx.auditLog.create({
    data: {
      userId: owner.id, branchId: before.locationId, action: PROVENANCE_ACTION, entityType: PROVENANCE_ENTITY, entityId: plan.catalogDigest,
      after: {
        format: PROVENANCE_FORMAT, authId: provenance.authId, planDigest: provenance.planDigest, catalogDigest: plan.catalogDigest, fileSha256: plan.fileSha256,
        locationCode, markerId, projectRef: provenance.projectRef, toolSha256: provenance.toolSha256,
        productIds: sortedIds(afterSnapshot.products), variantIds: sortedIds(afterSnapshot.variants),
        inventoryIds: sortedIds(afterSnapshot.inventory), movementIds: sortedIds(afterSnapshot.movements), totals: totalsWithoutCost(plan.totals),
      },
    },
  });
  const proven = classifyImportState(await readImportSnapshot(tx, plan, opts), plan, opts);
  if (proven.state !== 'EXACT') throw new Stop('verify', `post-write provenance verification failed (${proven.conflicts[0] ?? 'state not exact'}); rolled back`);
  return { action: 'CREATED', counts: { categories, brands, products: plan.rows.length, variants: created.length, stockRows: created.length, provenance: 1 }, totals };
}

// --- runtime defaults -------------------------------------------------------------------

export async function tsImport(rel) {
  const api = await import(pathToFileURL(path.join(ROOT, 'api/node_modules/tsx/dist/esm/api/index.mjs')).href);
  return api.tsImport(pathToFileURL(path.join(ROOT, rel)).href, import.meta.url);
}

// Prisma over the held connection fields with verified TLS (same as the other PILOT tools).
export async function createPilotPrisma(conn) {
  const { PrismaClient } = await tsImport('api/src/generated/prisma/client.ts');
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(ROOT, 'api', 'package.json'));
  const { PrismaPg } = await import(pathToFileURL(require.resolve('@prisma/adapter-pg')).href);
  const adapter = new PrismaPg({ ...conn, ssl: { rejectUnauthorized: true, ca: readFileSync(CA_PATH, 'utf8'), servername: conn.host }, connectionTimeoutMillis: 10000 });
  return new PrismaClient({ adapter, log: [] });
}

function readInputFile(file) {
  const r = readOwnerFileLoose(file);
  if (!r.ok) throw new Stop('file', `the spreadsheet ${r.reason}`);
  return r.buf;
}

// The spreadsheet is the OWNER's own document: regular file, no symlink, bounded size.
function readOwnerFileLoose(file) {
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return { ok: false, reason: 'is missing' };
  }
  if (!st.isFile()) return { ok: false, reason: 'is not a regular file' };
  if (st.size > MAX_INPUT_BYTES) return { ok: false, reason: 'is too large' };
  return { ok: true, buf: readFileSync(file) };
}

const home = os.homedir();
const defaultDeps = {
  fsOps: defaultFsOps,
  readInputFile,
  reportRoot: path.join(home, '.local', 'share', 'mona-jacinta', 'pilot-local1-import'),
  stateRoot: path.join(home, '.local', 'state', 'mona-jacinta', 'pilot-local1-import-authorizations'),
  forbiddenRoots: [ROOT, '/tmp', '/var/tmp', '/dev/shm', os.tmpdir()],
  now: () => new Date(),
  toolSha256: null,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  urlFile: PILOT_URL_FILE,
  readPrivateFile: (file) => readPrivateUrlFile(file),
  createClient: createVerifiedClient,
  pilotMarkerMain,
  createPrisma: createPilotPrisma,
  publishReceipt,
  loadCanonical,
  pgRestoreList: (archive) => {
    const { file, args, options } = pgRestoreInvocation('list', archive);
    return execFileSync(file, args, options);
  },
  pgRestoreMarkerData: (archive) => {
    const { file, args, options } = pgRestoreInvocation('markerData', archive);
    return execFileSync(file, args, options);
  },
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  env: process.env,
  owner: OWNER_ACCOUNT,
  approvedMigrations: APPROVED_MIGRATION_PAYLOAD.migrations,
};

// The execution plan binds the exact code that parses and imports: this file and the XLSX reader.
export function toolDigest() {
  const importer = sha256(readFileSync(fileURLToPath(import.meta.url)));
  const reader = sha256(readFileSync(fileURLToPath(new URL('./xlsx-sheet-reader.mjs', import.meta.url))));
  return sha256(`${importer}\n${reader}`);
}

export const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.[0-9]{3}Z$/, 'Z');
export const recordHash = (record) => {
  const { recordSha256, ...rest } = record;
  void recordSha256;
  return sha256(JSON.stringify(rest));
};

// --- main -------------------------------------------------------------------------------

export async function main(argv, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const toolSha256 = d.toolSha256 ?? toolDigest();
  const fail = (phase, detail, code) => {
    d.error(`${PREFIX} FAIL: phase=${phase}${code ? ` code=${code}` : ''} — ${detail}`);
    return 1;
  };
  const parsedArgs = parseCliArgs(argv);
  if (!parsedArgs.ok) return fail('args', parsedArgs.error);
  const { mode, values: v } = parsedArgs;

  if (mode === 'execute') {
    if (d.env?.DEBUG !== undefined) return fail('config', 'DEBUG is set; unset it (debug output could expose query parameters)');
    if (d.env?.PGOPTIONS !== undefined) return fail('config', 'PGOPTIONS is set in the environment; unset it (value not shown)');
  }

  try {
    const buf = d.readInputFile(v.file);
    const fileSha256 = sha256(buf);
    if (fileSha256 !== v['expect-file-sha256']) return fail('file', 'the spreadsheet SHA-256 differs from --expect-file-sha256; nothing was parsed');
    let parsed;
    try {
      parsed = parseLocal1Workbook(buf, { items: v['expect-items'], units: v['expect-units'] });
    } catch (err) {
      if (err instanceof ImportError) return fail('validate', err.message, err.code);
      throw err;
    }
    const plan = buildCatalogPlan({ fileSha256, parsed });
    const projectRef = v['project-ref'] ?? v['confirm-project-ref'] ?? null;
    const execDigest = v.location ? executionDigest({ catalogDigest: plan.catalogDigest, locationCode: v.location, markerId: v['marker-id'], projectRef, toolSha256 }) : null;
    const now = d.now();

    if (mode === 'dry-run') {
      ensurePrivateDir(d.reportRoot, d.forbiddenRoots, 'report');
      const dir = path.join(d.reportRoot, `${stamp(now)}-${plan.catalogDigest.slice(0, 12)}-${randomBytes(4).toString('hex')}`);
      ensurePrivateDir(dir, d.forbiddenRoots, 'report');
      const v2 = plan.layout === 'local1-v2';
      const report = { format: 'mona-pilot-local1-import-report/v1', createdAt: now.toISOString(), fileSha256, catalogDigest: plan.catalogDigest, executionDigest: execDigest, totals: plan.totals, anomalies: plan.anomalies, rows: plan.rows,
        ...(v2 ? { layout: plan.layout, priceChecks: plan.priceChecks, priceDifferences: plan.priceDifferences } : {}) };
      writeExclusive(path.join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'report', d.fsOps);
      const t = plan.totals;
      for (const line of [
        `${PREFIX} DRY RUN — offline: no URL file, network, Prisma or database client was used; nothing was written to any database`,
        `  file sha256: ${fileSha256}`,
        `  layout: ${plan.layout}`,
        `  items: ${t.items}; units: ${t.units} (all to the target retail location; every other location: 0)`,
        // Counts only on stdout; the per-row differences are in the private report.
        ...(v2 ? Object.entries(plan.priceChecks).map(([mode, k]) => `  price check ${mode} (${k.column}, ${k.adjustmentBps} bps): exact ${k.exact}, differ ${k.differ}, max |diff| ${k.maxAbsDiffCents} centavos (reported, not persisted)`) : []),
        `  list value: ${t.listValueCents} centavos; cash value (list × 80%): ${t.cashValueCents} centavos; cost value: in the private report only`,
        `  decisions: category "${CATEGORY}", brand "${BRAND}", barcode = SKU, INITIAL_STOCK once, no updates of existing rows`,
        `  anomalies: ${plan.anomalies.length} (${plan.anomalies.map((a) => `${a.kind} ${a.sku} row ${a.row}`).join('; ')})`,
        `  private report (0600, includes costs and raw row text): ${path.join(dir, 'report.json')}`,
        `  catalog sha256: ${plan.catalogDigest}`,
        execDigest ? `  execution plan sha256: ${execDigest} (target ${v.location}, marker ${v['marker-id']}, project as given)` : '  execution plan: not computed (pass --location, --marker-id and --project-ref together)',
        '  --execute additionally requires a verified PILOT backup, an OWNER --authorize ceremony and the PILOT marker proof',
      ]) d.log(line);
      return 0;
    }

    if (execDigest !== v.plan) return fail('plan', 'this file/target does not match --plan; re-run --dry-run and review (nothing was opened)');

    const urlRead = d.readPrivateFile(d.urlFile);
    if (!urlRead?.ok) return fail('config', `PILOT URL file: ${urlRead?.reason ?? 'could not be read'}`);
    const heldUrl = urlRead.text.replace(/\r?\n$/, '');
    const url = parsePilotUrl(heldUrl);
    if (!url.ok) return fail('config', 'the PILOT URL file must hold one PostgreSQL URL (value not shown)');
    if (deriveProjectRef(url.conn) !== projectRef) return fail('target', 'the project addressed by the PILOT URL file is not the one given (values not shown)');

    const backup = verifyBackupArchive({ path: v.backup, expectedSha256: v['backup-sha256'], expectedDbname: url.conn.database, expectedMarkerId: v['marker-id'], now, forbiddenRoots: d.forbiddenRoots, pgRestoreList: d.pgRestoreList, pgRestoreMarkerData: d.pgRestoreMarkerData });
    if (!backup.ok) return fail('backup', backup.reason);

    if (mode === 'authorize') {
      if (!d.isTTY) return fail('authorize', 'the authorization ceremony requires an interactive terminal');
      const phrase = `AUTORIZO ${v.location} ${v.plan.slice(0, 12)}`;
      const typed = await d.prompt(`Escriba exactamente "${phrase}" para autorizar UNA importación: `);
      if (typed !== phrase) return fail('authorize', 'the typed confirmation does not match; nothing was authorized');
      ensurePrivateDir(d.stateRoot, d.forbiddenRoots, 'authorize');
      const authId = randomBytes(16).toString('hex');
      const expiresAt = new Date(Math.min(now.getTime() + AUTH_TTL_MS, Date.parse(backup.createdAt) + BACKUP_MAX_AGE_MS));
      const record = {
        format: AUTH_FORMAT, authId, planDigest: v.plan, catalogDigest: plan.catalogDigest, fileSha256, location: v.location, markerId: v['marker-id'], projectRef,
        backup: { sha256: backup.sha256, createdAt: backup.createdAt, dbname: backup.dbname }, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      };
      record.recordSha256 = recordHash(record);
      writeExclusive(path.join(d.stateRoot, `${authId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'authorize', d.fsOps);
      d.log(`${PREFIX} AUTHORIZED — single use, expires ${record.expiresAt}`);
      d.log(`  authorization id: ${authId}`);
      return 0;
    }

    // execute
    const authFile = path.join(d.stateRoot, `${v.authorization}.json`);
    const consumedFile = path.join(d.stateRoot, `${v.authorization}.consumed.json`);
    const read = readOwnerFile(authFile, 64 * 1024);
    if (!read.ok) return fail('authorization', `authorization record ${read.reason}`);
    let record;
    try {
      record = JSON.parse(read.buf.toString('utf8'));
    } catch {
      return fail('authorization', 'authorization record is not JSON');
    }
    const bound = record?.format === AUTH_FORMAT && record.authId === v.authorization && record.recordSha256 === recordHash(record)
      && record.planDigest === v.plan && record.catalogDigest === plan.catalogDigest && record.fileSha256 === fileSha256
      && record.location === v.location && record.markerId === v['marker-id'] && record.projectRef === projectRef && record.backup?.sha256 === backup.sha256;
    if (!bound) return fail('authorization', 'the authorization record is altered or bound to another plan, file, target or backup');
    if (!(now.getTime() < Date.parse(record.expiresAt))) return fail('authorization', 'the authorization has expired');
    try {
      lstatSync(consumedFile);
      return fail('authorization', 'the authorization was already used');
    } catch {
      // not consumed yet
    }

    const proof = await d.pilotMarkerMain(['--target=pilot', '--check', `--marker-id=${v['marker-id']}`], {
      urlFile: d.urlFile, readUrlFile: () => ({ ok: true, text: heldUrl }), env: d.env, createClient: d.createClient, log: d.log, error: d.error,
    });
    if (proof !== 0) return fail('identity', 'PILOT identity proof failed; the authorization was NOT consumed; nothing was written');

    writeExclusive(consumedFile, `${JSON.stringify({ authId: v.authorization, planDigest: v.plan, at: d.now().toISOString() })}\n`, 'authorization', d.fsOps);

    let prisma;
    // A completed callback only proves the write body finished; Prisma still
    // has to COMMIT. A resolved $transaction is the confirmation boundary.
    let commitState = 'before';
    try {
      const canonical = await d.loadCanonical();
      prisma = await d.createPrisma(url.conn);
      const result = await prisma.$transaction(
        async (tx) => {
          const imported = await importTransaction(tx, {
            plan, locationCode: v.location, markerId: v['marker-id'], owner: d.owner, canonical, approvedMigrations: d.approvedMigrations,
            provenance: { authId: v.authorization, planDigest: v.plan, projectRef, toolSha256 },
          });
          commitState = 'pending';
          return imported;
        },
        TRANSACTION_OPTIONS,
      );
      commitState = 'confirmed';
      await d.publishReceipt({ reportRoot: d.reportRoot, forbiddenRoots: d.forbiddenRoots, now: d.now, planDigest: v.plan, authorization: v.authorization, result, fsOps: d.fsOps });
      if (result.action === 'NOOP') d.log(`${PREFIX} OK — PILOT already holds exactly this import; nothing was written`);
      else d.log(`${PREFIX} OK — Local 1 catalog import committed in one transaction (${result.counts.products} products, ${result.counts.variants} variants, ${result.totals.units} units)`);
      return 0;
    } catch (err) {
      if (commitState === 'confirmed') return fail('receipt', 'COMMIT confirmed: import data persisted in PILOT, but the receipt or success output failed. Do not retry blindly. With a new authorization, check EXACT; if confirmed, perform an idempotent NOOP');
      if (commitState === 'pending') return fail('commit', 'COMMIT outcome is uncertain. Do not assume success or rollback; reconcile PILOT before any further import attempt');
      if (err instanceof Stop) return fail(err.phase, err.message);
      if (err instanceof NestedTransactionFailure) return fail('import', 'a nested catalog operation failed before COMMIT and was not retried; persistence is not claimed');
      return fail('import', 'failed before COMMIT; persistence is not claimed');
    } finally {
      if (prisma) await Promise.resolve().then(() => prisma.$disconnect()).catch(() => {});
    }
  } catch (err) {
    if (err instanceof Stop) return fail(err.phase, err.message);
    throw err;
  }
}

// Only run when executed directly; importing from a test never connects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
