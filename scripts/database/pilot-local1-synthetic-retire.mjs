// OWNER-only, PILOT-only retirement of the synthetic PILOT dataset before Local 1 opens
// (OWNER decision 2026-10-19, "cancelar con pago retenido"). Two actions:
//
//   --action=retire-sale         the ONE synthetic sale the read-only preflight classified PAYMENT_ACCEPTED
//                                (PENDING_PAYMENT, partially paid, holding a synthetic unit): PENDING_PAYMENT →
//                                CANCELLED, its ACTIVE holds released through the canonical
//                                cancellation.service.ts releaseReservations (same locks, checks and writes),
//                                the canonical SALE_CANCELLED audit plus an explicit exception audit
//                                PILOT_SYNTHETIC_DATA_RETIREMENT. SalePayment, its SALE_INCOME CashMovement,
//                                every StockMovement and all other history stay exactly as they are (a
//                                SALE_INCOME cannot be reversed: migration 11 reverses only WITHDRAWAL/EXPENSE).
//   --action=cancel-draft        the ONE synthetic DRAFT sale (no payment, no reservation, no checkout, every item
//                                synthetic) the read-only preflight reported OPEN_SALE_*: DRAFT → CANCELLED with the
//                                canonical SALE_CANCELLED audit shape of cancellation.service.ts cancelSale plus the
//                                exception audit. The canonical DRAFT cancel is the owning seller's API call; PILOT has
//                                no running API, so the OWNER ceremony replaces that authority. No stock is touched.
//   --action=set-pricing         the company's CompanyPricingConfig set to the OWNER-approved Local 1 values
//                                (LIST 2500, CREDIT_CARD 2500, DEBIT_CARD 625, BANK_TRANSFER 1250, QR 0 bps) through the
//                                REAL pricing.service.ts updateConfig (the PATCH /pricing/config use case: same
//                                validation, upsert and COMPANY_PRICING_CONFIG_CHANGED audit), run inside this tool's
//                                Serializable transaction. PILOT has no running API; the OWNER ceremony replaces
//                                PRICE_MANAGE. Refused if a different config already exists (no silent overwrite).
//   --action=deactivate-catalog  the 6 synthetic Products and 16 ProductVariants (pilot-catalog-bootstrap.mjs
//                                CATALOG, exact SKU + barcode + slug) set isActive=false with one audit each and
//                                one exception audit; refused while any synthetic hold or open sale exists.
//
//   --dry-run   offline: prints the bound plan and its execution digest; nothing is opened.
//   --authorize OWNER tty ceremony: binds the plan, the target and a VERIFIED pg_dump archive of PILOT into one
//               single-use, short-lived authorization record (0600).
//   --execute   plan digest → URL file/project → backup re-verification → authorization → audited
//               pilot-marker --check → consume the authorization → ONE Serializable transaction (maintenance
//               lock, marker and G11 ledger re-proof, Sale → StockReservation locks, every precondition
//               re-classified under the locks, the writes, a post-write verification of every untouched
//               history) → COMMIT.
//
// The sale is bound by --expect-sale (the preflight's one-way SALE_IDENTITY_DIGEST) and by the exact
// amounts it reported; any deviation is a conflict and nothing is written. Never a delete, never a
// SalePayment, CashMovement, StockMovement or CashSession write. The envelope (backup verification,
// authorization records, private files, Prisma over the held connection) is the reviewed one of
// pilot-local1-catalog-import.mjs, imported, not copied.

import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROJECT_REF_PATTERN } from './lib.mjs';
import { APPROVED_MIGRATION_PAYLOAD } from './pilot-migrate.mjs';
import { CATALOG, OWNER_ACCOUNT } from './pilot-catalog-bootstrap.mjs';
import {
  AUTH_TTL_MS, BACKUP_MAX_AGE_MS, MAINTENANCE_ADVISORY_LOCK_ID, MARKER_RECHECK_SQL, MIGRATIONS_SQL, Stop, TRANSACTION_OPTIONS,
  createPilotPrisma, ensurePrivateDir, parseMarkerRows, pgRestoreInvocation, readOwnerFile, recordHash, tsImport, verifyBackupArchive, writeExclusive,
} from './pilot-local1-catalog-import.mjs';
import {
  PILOT_URL_FILE, createVerifiedClient, deriveProjectRef, main as pilotMarkerMain, parsePilotUrl, readPrivateUrlFile,
} from './pilot-marker.mjs';

const PREFIX = '[db:pilot-local1-synthetic-retire]';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const EXECUTION_DOMAIN = 'MONA/PILOT-LOCAL1-SYNTHETIC-RETIRE/v1';
const AUTH_FORMAT = 'mona-pilot-local1-synthetic-retire-authorization/v1';
const EXCEPTION_FORMAT = 'mona-pilot-local1-synthetic-retirement/v1';
const HEX64 = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The PCEN Location/Branch id (OWNER-declared, 2026-10-19; Location.id == Branch.id), as in pilot-local1-preflight.mjs.
export const PCEN_LOCATION_ID = '2477257d-2567-4fd6-9df7-1e078676b7ad';
export const RETIREMENT_REASON = 'PILOT_SYNTHETIC_DATA_RETIREMENT';
export const EXCEPTION_ACTION = 'PILOT_SYNTHETIC_DATA_RETIREMENT';
const CATALOG_ENTITY = 'PilotSyntheticCatalog';
// The canonical cancel's structured reason (cancel-sale.dto.ts) and its note.
const CANCEL_REASON = 'OTHER';
const DRAFT_CANCEL_NOTE = `${RETIREMENT_REASON}: OWNER-authorized cancellation of a synthetic PILOT DRAFT sale (no payment, no reservation)`;
const CANCEL_NOTE = `${RETIREMENT_REASON}: OWNER-authorized retirement of a synthetic PILOT sale; its accepted payment and SALE_INCOME are retained as history`;
export const ACTIONS = Object.freeze(['retire-sale', 'cancel-draft', 'deactivate-catalog', 'set-pricing']);
// OWNER-approved Local 1 Pricing V2 adjustments (2026-10-19), in basis points over the CASH base; QR is not used initially.
export const LOCAL1_PRICING_CONFIG = Object.freeze({ LIST: 2500, CREDIT_CARD: 2500, DEBIT_CARD: 625, BANK_TRANSFER: 1250, QR: 0 });
const PRICING_AUDIT = 'COMPANY_PRICING_CONFIG_CHANGED';
const PRICING_FIELDS = Object.freeze({ LIST: 'listAdjustmentBps', CREDIT_CARD: 'creditCardAdjustmentBps', DEBIT_CARD: 'debitCardAdjustmentBps', BANK_TRANSFER: 'bankTransferAdjustmentBps', QR: 'qrAdjustmentBps' });

// The synthetic identity: exactly the reviewed bootstrap catalog.
export const SYNTHETIC_PRODUCTS = Object.freeze(CATALOG.products.map((p) => Object.freeze({ slug: p.slug, name: p.name })));
export const SYNTHETIC_VARIANTS = Object.freeze(CATALOG.products.flatMap((p) => p.variants.map((v) => Object.freeze({ sku: v.sku, barcode: v.barcode, slug: p.slug }))));
const SYNTHETIC_SKUS = SYNTHETIC_VARIANTS.map((v) => v.sku);
const SYNTHETIC_BARCODES = SYNTHETIC_VARIANTS.map((v) => v.barcode);

// One-way sale identity, identical to pilot-local1-preflight.mjs saleIdentityDigest (a test asserts it).
export const saleIdentityDigest = (id) => sha256(`mona-pilot-synthetic-sale\n${id}`);

// The only raw SQL besides the reused marker/ledger statements: the maintenance lock and the canonical
// lock prefix (Sale → StockReservation id ASC, exactly cancellation.service.ts). Parameters are bound.
export const SQL = Object.freeze({
  ADVISORY_LOCK: 'SELECT pg_advisory_xact_lock($1::bigint)::text AS locked',
  SALE_FOR_UPDATE: 'SELECT id, "branchId", status FROM "Sale" WHERE id = $1 FOR UPDATE',
  RESERVATIONS_FOR_UPDATE: 'SELECT id, "variantId", "branchId", quantity, status, "expiresAt" FROM "StockReservation" WHERE "saleId" = $1 ORDER BY id ASC FOR UPDATE',
});

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const stringify = (value) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
const byId = (rows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const fingerprint = (rows) => sha256(stringify(byId(rows)));
const sum = (values) => values.reduce((a, v) => a + v, 0n);

// --- the bound plan ----------------------------------------------------------------------

export function executionDigest({ action, locationCode, markerId, projectRef, toolSha256, expect }) {
  const e = action === 'retire-sale' ? [expect.sale, expect.totalCents, expect.acceptedCents, expect.reservedUnits]
    : action === 'cancel-draft' ? [expect.sale, expect.totalCents, expect.itemCount]
      : action === 'set-pricing' ? LOCAL1_PRICING_CONFIG : null;
  return sha256(`${EXECUTION_DOMAIN}\n${JSON.stringify([action, locationCode, PCEN_LOCATION_ID, markerId, projectRef, toolSha256, sha256(stringify(SYNTHETIC_VARIANTS)), e])}`);
}

// --- snapshot and classification (pure) ------------------------------------------------

export async function readRetirementSnapshot(tx, { saleId, ownerId }) {
  const location = await tx.location.findUnique({ where: { id: PCEN_LOCATION_ID } });
  const owner = await tx.user.findUnique({ where: { id: ownerId } });
  const bySku = await tx.productVariant.findMany({ where: { sku: { in: SYNTHETIC_SKUS } } });
  const byBarcode = await tx.productVariant.findMany({ where: { barcode: { in: SYNTHETIC_BARCODES } } });
  const variants = byId([...new Map([...bySku, ...byBarcode].map((v) => [v.id, v])).values()]);
  const ids = variants.map((v) => v.id);
  const products = await tx.product.findMany({ where: { id: { in: [...new Set(variants.map((v) => v.productId))] } } });
  const syntheticHolds = await tx.stockReservation.findMany({ where: { variantId: { in: ids }, status: 'ACTIVE' } });
  const inventory = await tx.inventory.findMany({ where: { variantId: { in: ids } } });
  const stockMovements = await tx.stockMovement.findMany({ where: { inventoryId: { in: inventory.map((i) => i.id) } } });
  const exceptions = await tx.auditLog.findMany({ where: { action: EXCEPTION_ACTION } });
  const snapshot = { location, owner, variants, products, syntheticHolds, inventory, stockMovements, exceptions, sale: null };
  if (saleId === null) return snapshot;
  const payments = await tx.salePayment.findMany({ where: { saleId } });
  return {
    ...snapshot,
    sale: await tx.sale.findUnique({ where: { id: saleId } }),
    items: await tx.saleItem.findMany({ where: { saleId } }),
    holds: await tx.stockReservation.findMany({ where: { saleId, status: 'ACTIVE' } }),
    payments,
    cashMovements: await tx.cashMovement.findMany({ where: { salePaymentId: { in: payments.map((p) => p.id) } } }),
    cashSessions: await tx.cashSession.findMany({ where: { id: { in: [...new Set(payments.map((p) => p.cashSessionId).filter(Boolean))] } } }),
    saleCheckouts: await tx.saleCheckout.findMany({ where: { saleId } }),
    attempts: await tx.checkoutAttempt.findMany({ where: { saleId } }),
  };
}

function identityConflicts(s, ownerId) {
  const conflicts = [];
  const loc = s.location;
  if (!loc || loc.type !== 'RETAIL_BRANCH' || loc.isActive !== true) conflicts.push('PCEN is not exactly the active RETAIL_BRANCH location');
  if (!s.owner || s.owner.id !== ownerId || s.owner.isActive !== true) conflicts.push('the OWNER audit actor must exist and be active');
  const exact = s.variants.length === SYNTHETIC_VARIANTS.length && SYNTHETIC_VARIANTS.every((x) => s.variants.filter((v) => v.sku === x.sku && v.barcode === x.barcode).length === 1);
  if (!exact) conflicts.push(`the synthetic catalog is not exactly the ${SYNTHETIC_VARIANTS.length} reviewed SKU + barcode pairs`);
  return conflicts;
}

// READY: exactly the bound paid-pending synthetic sale; DONE: already retired (an exception audit names it);
// CONFLICT: anything else. Reasons never carry ids or amounts beyond the bound ones.
export function classifyRetirement(s, expect, { ownerId = OWNER_ACCOUNT.id } = {}) {
  const conflicts = identityConflicts(s, ownerId);
  const syntheticIds = new Set(s.variants.map((v) => v.id));
  const holdSales = [...new Set(s.syntheticHolds.map((h) => h.saleId))];
  const done = s.exceptions.filter((a) => a.entityType === 'Sale' && saleIdentityDigest(a.entityId) === expect.sale);
  if (holdSales.length === 0) {
    if (conflicts.length === 0 && done.length === 1) return { state: 'DONE', conflicts, saleId: done[0].entityId };
    return { state: 'CONFLICT', conflicts: [...conflicts, 'no synthetic ACTIVE reservation and no recorded retirement of the bound sale'] };
  }
  if (holdSales.length > 1) return { state: 'CONFLICT', conflicts: [...conflicts, 'more than one sale holds synthetic stock'] };
  const sale = s.sale;
  if (!sale || sale.id !== holdSales[0]) return { state: 'CONFLICT', conflicts: [...conflicts, 'the sale holding synthetic stock is not the one read'] };
  if (saleIdentityDigest(sale.id) !== expect.sale) conflicts.push('the sale holding synthetic stock is not the bound sale (--expect-sale)');
  if (done.length !== 0) conflicts.push('the bound sale already carries a retirement audit');
  if (sale.status !== 'PENDING_PAYMENT') conflicts.push('the sale is not PENDING_PAYMENT');
  if (sale.pricingModel !== 'FIXED_TOTAL') conflicts.push('the sale is not FIXED_TOTAL');
  if (sale.branchId !== PCEN_LOCATION_ID) conflicts.push('the sale is not at PCEN');
  if (String(sale.total) !== expect.totalCents) conflicts.push('the sale total differs from the evidence');

  // items: all synthetic, exact arithmetic, adding up to the total
  const items = s.items;
  const want = new Map();
  let itemsTotal = 0n;
  let itemsOk = items.length > 0;
  for (const i of items) {
    if (!syntheticIds.has(i.variantId) || i.quantity <= 0n || i.subtotal !== i.unitPrice * i.quantity) itemsOk = false;
    itemsTotal += i.subtotal;
    want.set(i.variantId, (want.get(i.variantId) ?? 0n) + i.quantity);
  }
  if (!itemsOk || itemsTotal !== sale.subtotal || sale.subtotal - sale.discountTotal !== sale.total) conflicts.push('the sale items are not synthetic or do not add up to the total');

  // holds: exactly the items, at PCEN, covered by reserved inventory
  const held = new Map();
  for (const h of s.holds) held.set(h.variantId, (held.get(h.variantId) ?? 0n) + h.quantity);
  if (s.holds.some((h) => h.branchId !== PCEN_LOCATION_ID || h.branchId !== sale.branchId)) conflicts.push('a hold of the sale is not at PCEN');
  if (want.size !== held.size || [...want].some(([v, q]) => held.get(v) !== q)) conflicts.push('the ACTIVE holds differ from the sale items');
  if (String(sum(s.holds.map((h) => h.quantity))) !== expect.reservedUnits) conflicts.push('the reserved units differ from the evidence');
  for (const [v, q] of held) {
    const inv = s.inventory.filter((i) => i.variantId === v && i.branchId === PCEN_LOCATION_ID);
    if (inv.length !== 1 || inv[0].reserved < q) conflicts.push('the PCEN inventory does not cover the hold');
  }

  // payments: at least one, partial, untouched by any checkout/collection, each with exactly its expected side effect
  const accepted = sum(s.payments.map((p) => p.amount));
  if (s.payments.length === 0) conflicts.push('the sale has no accepted payment (the canonical cancel applies instead)');
  if (String(accepted) !== expect.acceptedCents) conflicts.push('the accepted payment total differs from the evidence');
  if (accepted >= sale.total) conflicts.push('the payments already cover the total (not a partially paid sale)');
  for (const p of s.payments) {
    if (p.amount <= 0n || p.checkoutId !== null || p.externalCollectionId !== null) conflicts.push('a payment belongs to a checkout or an external collection');
    const moves = s.cashMovements.filter((m) => m.salePaymentId === p.id);
    if (p.method === 'CASH') {
      const session = s.cashSessions.find((x) => x.id === p.cashSessionId);
      if (moves.length !== 1 || moves[0].type !== 'SALE_INCOME' || moves[0].amount !== p.amount || moves[0].sessionId !== p.cashSessionId) {
        conflicts.push('a CASH payment does not have exactly its SALE_INCOME');
      }
      if (!session || session.status !== 'CLOSED') conflicts.push('a CASH payment sits in a cash session that is not CLOSED');
    } else if (p.cashSessionId !== null || moves.length !== 0) conflicts.push('a non-cash payment has a cash session or a cash movement');
  }
  if (s.saleCheckouts.length !== 0 || s.attempts.length !== 0) conflicts.push('the sale has a SaleCheckout or a CheckoutAttempt');
  return conflicts.length ? { state: 'CONFLICT', conflicts } : { state: 'READY', conflicts, saleId: sale.id };
}

// --- shared transaction prologue ------------------------------------------------------------

async function prologue(tx, { markerId, approvedMigrations, provenance }) {
  if (!provenance || !/^[0-9a-f]{32}$/.test(provenance.authId ?? '') || !HEX64.test(provenance.planDigest ?? '') || !HEX64.test(provenance.toolSha256 ?? '')) {
    throw new Stop('identity', 'the provenance context is missing or malformed; nothing was written');
  }
  await tx.$queryRawUnsafe(SQL.ADVISORY_LOCK, MAINTENANCE_ADVISORY_LOCK_ID);
  const [marker] = await tx.$queryRawUnsafe(MARKER_RECHECK_SQL);
  const rows = parseMarkerRows(marker);
  if (marker?.test_guard_exists !== false || rows.length !== 1 || rows[0].environment !== 'pilot' || rows[0].marker_id !== markerId) {
    throw new Stop('identity', 'the write session does not see exactly the proven PILOT marker (or sees a TEST marker); nothing was written');
  }
  const ledger = await tx.$queryRawUnsafe(MIGRATIONS_SQL);
  const ok = Array.isArray(ledger) && ledger.length === approvedMigrations.length && ledger.every((m, i) => m.migration_name === approvedMigrations[i].name
    && m.checksum === approvedMigrations[i].sha256 && m.finished === true && m.rolled_back === false);
  if (!ok) throw new Stop('identity', `the migration ledger is not exactly the ${approvedMigrations.length} approved migrations; nothing was written`);
}
const conflict = (c) => new Stop('conflict', `${c.conflicts[0]}${c.conflicts.length > 1 ? ` (+${c.conflicts.length - 1} more)` : ''}; nothing was written`);

// --- retire-sale -------------------------------------------------------------------------------

export async function retireTransaction(tx, ctx) {
  const { markerId, owner, canonical, expect, provenance } = ctx;
  await prologue(tx, ctx);
  // Hints only (unlocked); every condition is re-read and re-classified under the Sale lock.
  const hint = await readRetirementSnapshot(tx, { saleId: null, ownerId: owner.id });
  const candidates = [...new Set(hint.syntheticHolds.map((h) => h.saleId))];
  if (candidates.length !== 1) {
    const c = classifyRetirement(hint, expect, { ownerId: owner.id });
    if (c.state === 'DONE') return { action: 'NOOP' };
    throw conflict(c);
  }
  const [lockedSale] = await tx.$queryRawUnsafe(SQL.SALE_FOR_UPDATE, candidates[0]);
  const lockedReservations = await tx.$queryRawUnsafe(SQL.RESERVATIONS_FOR_UPDATE, candidates[0]);
  if (!lockedSale) throw new Stop('conflict', 'the sale holding synthetic stock disappeared; nothing was written');
  const before = await readRetirementSnapshot(tx, { saleId: lockedSale.id, ownerId: owner.id });
  const c = classifyRetirement(before, expect, { ownerId: owner.id });
  if (c.state !== 'READY') throw conflict(c);

  const released = await canonical.releaseReservations(tx, lockedSale, lockedReservations);
  const cancelled = await tx.sale.updateMany({ where: { id: lockedSale.id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
  if (cancelled.count !== 1) throw new Stop('verify', 'the sale changed state during the retirement; rolled back');
  await canonical.createAuditLog(tx, {
    userId: owner.id, branchId: lockedSale.branchId, action: 'SALE_CANCELLED', entityType: 'Sale', entityId: lockedSale.id,
    before: { status: 'PENDING_PAYMENT' },
    after: { status: 'CANCELLED', reason: CANCEL_REASON, note: CANCEL_NOTE, released },
  });
  const retained = {
    totalCents: String(before.sale.total), acceptedCents: String(sum(before.payments.map((p) => p.amount))),
    payments: byId(before.payments).map((p) => ({ method: p.method, amountCents: String(p.amount), cashMovements: before.cashMovements.filter((m) => m.salePaymentId === p.id).length })),
  };
  await canonical.createAuditLog(tx, {
    userId: owner.id, branchId: lockedSale.branchId, action: EXCEPTION_ACTION, entityType: 'Sale', entityId: lockedSale.id,
    before: { status: 'PENDING_PAYMENT', reservedUnits: expect.reservedUnits },
    after: {
      format: EXCEPTION_FORMAT, reason: RETIREMENT_REASON, status: 'CANCELLED', retained, released,
      note: 'payment and SALE_INCOME retained as history (no SALE_INCOME reversal exists); OWNER decision 2026-10-19',
      planDigest: provenance.planDigest, authId: provenance.authId, toolSha256: provenance.toolSha256, markerId, saleDigest: expect.sale,
    },
  });

  // Post-write verification: exactly the planned changes, every history untouched.
  const after = await readRetirementSnapshot(tx, { saleId: lockedSale.id, ownerId: owner.id });
  const releasedQty = new Map(released.map((r) => [r.variantId, r.quantity]));
  const invOk = before.inventory.every((b) => {
    const a = after.inventory.find((x) => x.id === b.id);
    const q = b.branchId === PCEN_LOCATION_ID ? releasedQty.get(b.variantId) ?? 0n : 0n;
    return a && a.physical === b.physical && a.reserved === b.reserved - q && a.variantId === b.variantId && a.branchId === b.branchId;
  }) && after.inventory.length === before.inventory.length;
  const heldIds = new Set(before.holds.map((h) => h.id));
  const checks = [
    [after.sale?.status === 'CANCELLED', 'the sale is not CANCELLED'],
    [after.holds.length === 0 && after.syntheticHolds.every((h) => !heldIds.has(h.id)), 'a hold of the sale is still ACTIVE'],
    [invOk, 'inventory changed beyond releasing exactly the held units'],
    [fingerprint(after.payments) === fingerprint(before.payments), 'a SalePayment changed'],
    [fingerprint(after.cashMovements) === fingerprint(before.cashMovements), 'a CashMovement changed'],
    [fingerprint(after.stockMovements) === fingerprint(before.stockMovements), 'a StockMovement changed'],
    [fingerprint(after.items) === fingerprint(before.items), 'a SaleItem changed'],
    [after.exceptions.filter((a) => a.entityId === lockedSale.id).length === 1, 'the exception audit is not exactly one'],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) throw new Stop('verify', `${failed[1]}; rolled back`);
  return { action: 'RETIRED', released: released.map((r) => ({ quantity: String(r.quantity) })), retained };
}

// --- cancel-draft -------------------------------------------------------------------------------

// READY: exactly the bound synthetic DRAFT sale; DONE: already cancelled by this tool; CONFLICT: anything else.
export function classifyDraftCancel(s, expect, { ownerId = OWNER_ACCOUNT.id } = {}) {
  const conflicts = identityConflicts(s, ownerId);
  const sale = s.sale;
  const done = s.exceptions.filter((a) => a.entityType === 'Sale' && saleIdentityDigest(a.entityId) === expect.sale);
  if (!sale) {
    return { state: 'CONFLICT', conflicts: [...conflicts, 'the bound sale was not found'] };
  }
  if (saleIdentityDigest(sale.id) !== expect.sale) conflicts.push('the sale read is not the bound sale (--expect-sale)');
  if (sale.status === 'CANCELLED' && done.length === 1 && conflicts.length === 0) return { state: 'DONE', conflicts, saleId: sale.id };
  if (done.length !== 0) conflicts.push('the bound sale already carries a retirement audit');
  if (sale.status !== 'DRAFT') conflicts.push('the sale is not DRAFT');
  if (sale.pricingModel !== 'FIXED_TOTAL') conflicts.push('the sale is not FIXED_TOTAL');
  if (sale.branchId !== PCEN_LOCATION_ID) conflicts.push('the sale is not at PCEN');
  if (String(sale.total) !== expect.totalCents) conflicts.push('the sale total differs from the evidence');
  const syntheticIds = new Set(s.variants.map((v) => v.id));
  let itemsTotal = 0n;
  let itemsOk = s.items.length > 0;
  for (const i of s.items) {
    if (!syntheticIds.has(i.variantId) || i.quantity <= 0n || i.subtotal !== i.unitPrice * i.quantity) itemsOk = false;
    itemsTotal += i.subtotal;
  }
  if (!itemsOk || itemsTotal !== sale.subtotal || sale.subtotal - sale.discountTotal !== sale.total) conflicts.push('the sale items are not synthetic or do not add up to the total');
  if (String(s.items.length) !== expect.itemCount) conflicts.push('the item count differs from the evidence');
  if (s.payments.length !== 0) conflicts.push('the sale holds a SalePayment (the canonical cancel refuses it)');
  if (s.reservations.length !== 0) conflicts.push('the sale has a StockReservation');
  if (s.saleCheckouts.length !== 0 || s.attempts.length !== 0) conflicts.push('the sale has a SaleCheckout or a CheckoutAttempt');
  return conflicts.length ? { state: 'CONFLICT', conflicts } : { state: 'READY', conflicts, saleId: sale.id };
}

export async function cancelDraftTransaction(tx, ctx) {
  const { markerId, owner, canonical, expect, provenance } = ctx;
  await prologue(tx, ctx);
  // Hints only (unlocked); every condition is re-read and re-classified under the Sale lock.
  const hint = await readRetirementSnapshot(tx, { saleId: null, ownerId: owner.id });
  const synthetic = hint.variants.map((v) => v.id);
  const itemSales = [...new Set((await tx.saleItem.findMany({ where: { variantId: { in: synthetic } } })).map((i) => i.saleId))];
  const sales = (await tx.sale.findMany({ where: { id: { in: itemSales } } })).filter((x) => saleIdentityDigest(x.id) === expect.sale);
  const open = (await tx.sale.findMany({ where: { id: { in: itemSales } } })).filter((x) => OPEN_SALE.has(x.status));
  if (sales.length !== 1 || open.some((x) => saleIdentityDigest(x.id) !== expect.sale)) {
    throw new Stop('conflict', 'the bound sale was not found, or another open synthetic sale exists; nothing was written');
  }
  const [lockedSale] = await tx.$queryRawUnsafe(SQL.SALE_FOR_UPDATE, sales[0].id);
  const lockedReservations = await tx.$queryRawUnsafe(SQL.RESERVATIONS_FOR_UPDATE, sales[0].id);
  if (!lockedSale) throw new Stop('conflict', 'the bound sale disappeared; nothing was written');
  const read = async () => ({ ...(await readRetirementSnapshot(tx, { saleId: lockedSale.id, ownerId: owner.id })), reservations: await tx.stockReservation.findMany({ where: { saleId: lockedSale.id } }) });
  const before = await read();
  const c = classifyDraftCancel(before, expect, { ownerId: owner.id });
  if (c.state === 'DONE') return { action: 'NOOP' };
  if (c.state !== 'READY' || lockedReservations.length !== 0) throw conflict(c.state === 'READY' ? { conflicts: ['the sale has a StockReservation'] } : c);

  const cancelled = await tx.sale.updateMany({ where: { id: lockedSale.id, status: 'DRAFT' }, data: { status: 'CANCELLED' } });
  if (cancelled.count !== 1) throw new Stop('verify', 'the sale changed state during the cancellation; rolled back');
  await canonical.createAuditLog(tx, {
    userId: owner.id, branchId: lockedSale.branchId, action: 'SALE_CANCELLED', entityType: 'Sale', entityId: lockedSale.id,
    before: { status: 'DRAFT' },
    after: { status: 'CANCELLED', reason: CANCEL_REASON, note: DRAFT_CANCEL_NOTE, released: [] },
  });
  await canonical.createAuditLog(tx, {
    userId: owner.id, branchId: lockedSale.branchId, action: EXCEPTION_ACTION, entityType: 'Sale', entityId: lockedSale.id,
    before: { status: 'DRAFT' },
    after: {
      format: EXCEPTION_FORMAT, reason: RETIREMENT_REASON, status: 'CANCELLED', totalCents: expect.totalCents, itemCount: expect.itemCount,
      note: 'synthetic DRAFT sale cancelled by the OWNER ceremony; no payment, reservation or stock movement existed; OWNER decision 2026-10-19',
      planDigest: provenance.planDigest, authId: provenance.authId, toolSha256: provenance.toolSha256, markerId, saleDigest: expect.sale,
    },
  });

  const after = await read();
  const checks = [
    [after.sale?.status === 'CANCELLED', 'the sale is not CANCELLED'],
    [fingerprint(after.items) === fingerprint(before.items), 'a SaleItem changed'],
    [fingerprint(after.inventory) === fingerprint(before.inventory), 'inventory changed'],
    [fingerprint(after.stockMovements) === fingerprint(before.stockMovements), 'a StockMovement changed'],
    [after.payments.length === 0 && after.reservations.length === 0, 'a payment or reservation appeared'],
    [after.exceptions.filter((a) => a.entityId === lockedSale.id).length === 1, 'the exception audit is not exactly one'],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) throw new Stop('verify', `${failed[1]}; rolled back`);
  return { action: 'DRAFT_CANCELLED' };
}

// --- set-pricing ----------------------------------------------------------------------------------

const pricingMatches = (row) => Object.entries(PRICING_FIELDS).every(([mode, field]) => row[field] === LOCAL1_PRICING_CONFIG[mode]);

export function classifyPricing(s, { ownerId = OWNER_ACCOUNT.id } = {}) {
  const conflicts = [];
  const loc = s.location;
  if (!loc || loc.type !== 'RETAIL_BRANCH' || loc.isActive !== true) conflicts.push('PCEN is not exactly the active RETAIL_BRANCH location');
  if (!s.owner || s.owner.id !== ownerId || s.owner.isActive !== true) conflicts.push('the OWNER audit actor must exist and be active');
  if (s.companies.length !== 1 || !loc || s.companies[0].id !== loc.companyId) conflicts.push('the canonical company is not exactly the one company of PCEN');
  const companyId = s.companies[0]?.id;
  const others = s.configs.filter((c) => c.companyId !== companyId);
  const mine = s.configs.filter((c) => c.companyId === companyId);
  if (others.length !== 0 || mine.length > 1) conflicts.push('a CompanyPricingConfig of another company exists, or the company has more than one');
  if (conflicts.length) return { state: 'CONFLICT', conflicts };
  if (mine.length === 0) return { state: 'READY', conflicts, companyId };
  if (pricingMatches(mine[0])) return { state: 'DONE', conflicts, companyId };
  return { state: 'CONFLICT', conflicts: ['a CompanyPricingConfig with different values already exists (not overwritten silently)'] };
}

async function readPricingSnapshot(tx, ownerId) {
  const location = await tx.location.findUnique({ where: { id: PCEN_LOCATION_ID } });
  return {
    location, owner: await tx.user.findUnique({ where: { id: ownerId } }),
    companies: await tx.company.findMany({}), configs: await tx.companyPricingConfig.findMany({}),
    audits: await tx.auditLog.findMany({ where: { action: PRICING_AUDIT } }),
  };
}

export async function setPricingTransaction(tx, ctx) {
  const { canonical, owner, provenance } = ctx;
  await prologue(tx, ctx);
  const before = await readPricingSnapshot(tx, owner.id);
  const c = classifyPricing(before, { ownerId: owner.id });
  if (c.state === 'DONE') return { action: 'NOOP' };
  if (c.state !== 'READY') throw conflict(c);
  if (typeof canonical.createPricingService !== 'function') throw new Stop('canonical', 'the canonical pricing service could not be loaded; nothing was written');
  // The real service opens its own transaction; here it joins this one (same locks, same Serializable snapshot).
  const service = canonical.createPricingService({ company: tx.company, companyPricingConfig: tx.companyPricingConfig, $transaction: async (fn) => fn(tx) });
  const snapshot = await service.updateConfig(owner.id, { ...LOCAL1_PRICING_CONFIG });
  const after = await readPricingSnapshot(tx, owner.id);
  const row = after.configs.find((x) => x.companyId === c.companyId);
  const checks = [
    [after.configs.length === 1 && row && pricingMatches(row), 'the stored config is not exactly the Local 1 values'],
    [after.audits.length === before.audits.length + 1, `exactly one ${PRICING_AUDIT} audit must be added`],
    [snapshot && Object.entries(LOCAL1_PRICING_CONFIG).every(([m, v]) => snapshot.adjustmentsBps?.[m] === v), 'the service returned other values'],
    [fingerprint(after.companies) === fingerprint(before.companies), 'the company changed'],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) throw new Stop('verify', `${failed[1]}; rolled back`);
  void provenance;
  return { action: 'PRICING_SET' };
}

// --- deactivate-catalog ---------------------------------------------------------------------------

const OPEN_SALE = new Set(['DRAFT', 'PENDING_PAYMENT', 'PAID']);

async function readCatalogSnapshot(tx, ownerId) {
  const base = await readRetirementSnapshot(tx, { saleId: null, ownerId });
  const ids = base.variants.map((v) => v.id);
  const items = await tx.saleItem.findMany({ where: { variantId: { in: ids } } });
  const sales = await tx.sale.findMany({ where: { id: { in: [...new Set(items.map((i) => i.saleId))] } } });
  return { ...base, items, sales };
}

export function classifyDeactivation(s, { ownerId = OWNER_ACCOUNT.id } = {}) {
  const conflicts = identityConflicts(s, ownerId);
  const variants = s.variants;
  const products = s.products;
  const productsExact = products.length === SYNTHETIC_PRODUCTS.length && SYNTHETIC_PRODUCTS.every((x) => products.filter((p) => p.slug === x.slug && p.name === x.name).length === 1)
    && SYNTHETIC_VARIANTS.every((x) => {
      const v = variants.find((y) => y.sku === x.sku);
      return v && products.find((p) => p.id === v.productId)?.slug === x.slug;
    });
  if (!productsExact) conflicts.push(`the synthetic products are not exactly the ${SYNTHETIC_PRODUCTS.length} reviewed slugs and names of their variants`);
  if (s.syntheticHolds.length !== 0) conflicts.push('a synthetic variant still has an ACTIVE reservation (retire the sale first)');
  if (s.sales.some((x) => OPEN_SALE.has(x.status))) conflicts.push('an open (DRAFT, PENDING_PAYMENT or PAID) sale contains a synthetic item');
  if (conflicts.length) return { state: 'CONFLICT', conflicts };
  const flags = [...variants, ...products].map((x) => x.isActive);
  if (flags.every((f) => f === true)) return { state: 'READY', conflicts };
  if (flags.every((f) => f === false) && s.exceptions.some((a) => a.entityType === CATALOG_ENTITY)) return { state: 'DONE', conflicts };
  return { state: 'CONFLICT', conflicts: ['the synthetic catalog is partly inactive or deactivated outside this tool'] };
}

export async function deactivateTransaction(tx, ctx) {
  const { markerId, owner, canonical, provenance } = ctx;
  await prologue(tx, ctx);
  const before = await readCatalogSnapshot(tx, owner.id);
  const c = classifyDeactivation(before, { ownerId: owner.id });
  if (c.state === 'DONE') return { action: 'NOOP' };
  if (c.state !== 'READY') throw conflict(c);
  const vids = before.variants.map((v) => v.id);
  const pids = before.products.map((p) => p.id);
  const v = await tx.productVariant.updateMany({ where: { id: { in: vids }, isActive: true }, data: { isActive: false } });
  const p = await tx.product.updateMany({ where: { id: { in: pids }, isActive: true }, data: { isActive: false } });
  if (v.count !== vids.length || p.count !== pids.length) throw new Stop('verify', 'the synthetic catalog changed during the deactivation; rolled back');
  const after = { isActive: false, reason: RETIREMENT_REASON };
  for (const x of byId(before.variants)) {
    await canonical.createAuditLog(tx, { userId: owner.id, branchId: null, action: 'PRODUCT_VARIANT_DEACTIVATED', entityType: 'ProductVariant', entityId: x.id, before: { isActive: true }, after });
  }
  for (const x of byId(before.products)) {
    await canonical.createAuditLog(tx, { userId: owner.id, branchId: null, action: 'PRODUCT_DEACTIVATED', entityType: 'Product', entityId: x.id, before: { isActive: true }, after });
  }
  await canonical.createAuditLog(tx, {
    userId: owner.id, branchId: null, action: EXCEPTION_ACTION, entityType: CATALOG_ENTITY, entityId: provenance.planDigest,
    before: { isActive: true },
    after: { format: EXCEPTION_FORMAT, reason: RETIREMENT_REASON, products: pids.length, variants: vids.length, skus: SYNTHETIC_SKUS,
      planDigest: provenance.planDigest, authId: provenance.authId, toolSha256: provenance.toolSha256, markerId },
  });
  const done = await readCatalogSnapshot(tx, owner.id);
  const checks = [
    [[...done.variants, ...done.products].every((x) => x.isActive === false), 'a synthetic row is still active'],
    [fingerprint(done.inventory) === fingerprint(before.inventory), 'inventory changed'],
    [fingerprint(done.stockMovements) === fingerprint(before.stockMovements), 'a StockMovement changed'],
    [fingerprint(done.sales) === fingerprint(before.sales) && fingerprint(done.items) === fingerprint(before.items), 'a sale or sale item changed'],
  ];
  const failed = checks.find(([ok]) => !ok);
  if (failed) throw new Stop('verify', `${failed[1]}; rolled back`);
  return { action: 'DEACTIVATED', counts: { products: pids.length, variants: vids.length } };
}

// --- CLI ------------------------------------------------------------------------------------

const MODES = ['dry-run', 'authorize', 'execute'];
const COMMON = ['action', 'location', 'marker-id'];
const EXPECT_ARGS = ['expect-sale', 'expect-total-cents', 'expect-accepted-cents', 'expect-reserved-units'];
const DRAFT_EXPECT_ARGS = ['expect-sale', 'expect-total-cents', 'expect-item-count'];
const REQUIRED = {
  'dry-run': [...COMMON, 'project-ref'],
  authorize: [...COMMON, 'project-ref', 'plan', 'backup', 'backup-sha256'],
  execute: [...COMMON, 'confirm-project-ref', 'plan', 'backup', 'backup-sha256', 'authorization'],
};
const CENTS = /^(0|[1-9][0-9]{0,17})$/;
const FORMAT = {
  action: (v) => ACTIONS.includes(v),
  location: (v) => /^[A-Z]{2,6}$/.test(v),
  'marker-id': (v) => UUID_V4.test(v),
  'project-ref': (v) => PROJECT_REF_PATTERN.test(v),
  'confirm-project-ref': (v) => PROJECT_REF_PATTERN.test(v),
  plan: (v) => HEX64.test(v),
  backup: (v) => path.isAbsolute(v) && !v.includes('\0'),
  'backup-sha256': (v) => HEX64.test(v),
  authorization: (v) => /^[0-9a-f]{32}$/.test(v),
  'expect-sale': (v) => HEX64.test(v),
  'expect-total-cents': (v) => CENTS.test(v),
  'expect-accepted-cents': (v) => CENTS.test(v),
  'expect-reserved-units': (v) => /^[1-9][0-9]{0,8}$/.test(v),
  'expect-item-count': (v) => /^[1-9][0-9]{0,8}$/.test(v),
};

export function parseCliArgs(argv) {
  const modes = argv.filter((a) => MODES.some((m) => a === `--${m}`));
  if (modes.length !== 1) return { ok: false, error: `exactly one of ${MODES.map((m) => `--${m}`).join(', ')} is required` };
  const mode = modes[0].slice(2);
  const values = {};
  for (const arg of argv) {
    if (arg === modes[0]) continue;
    const m = /^--([a-z0-9-]+)=(.*)$/s.exec(arg);
    if (!m || !Object.hasOwn(FORMAT, m[1])) return { ok: false, error: 'unrecognized argument (value not shown)' };
    if (Object.hasOwn(values, m[1])) return { ok: false, error: `--${m[1]} is given twice` };
    if (!FORMAT[m[1]](m[2])) return { ok: false, error: `--${m[1]} is malformed (value not shown)` };
    values[m[1]] = m[2];
  }
  const required = [...REQUIRED[mode], ...(values.action === 'retire-sale' ? EXPECT_ARGS : values.action === 'cancel-draft' ? DRAFT_EXPECT_ARGS : [])];
  for (const key of required) if (!Object.hasOwn(values, key)) return { ok: false, error: `--${key} is required with --${mode}` };
  for (const key of Object.keys(values)) if (!required.includes(key)) return { ok: false, error: `--${key} is not accepted with --${mode} --action=${values.action}` };
  return { ok: true, mode, values };
}

// The execution plan binds the code that decides and writes: this file, the reused envelope, the
// synthetic catalog and the canonical release/audit sources it loads.
export const DIGESTED_FILES = Object.freeze(['scripts/database/pilot-local1-synthetic-retire.mjs', 'scripts/database/pilot-local1-catalog-import.mjs',
  'scripts/database/pilot-catalog-bootstrap.mjs', 'api/src/modules/sales/cancellation.service.ts', 'api/src/shared/audit.ts',
  'api/src/modules/pricing/pricing.service.ts', 'api/src/modules/pricing/pricing.ts']);
export function toolDigest() {
  return sha256(DIGESTED_FILES.map((f) => `${f}\n${sha256(readFileSync(path.join(ROOT, f)))}`).join('\n'));
}

async function loadCanonical() {
  const cancellation = await tsImport('api/src/modules/sales/cancellation.service.ts');
  const audit = await tsImport('api/src/shared/audit.ts');
  if (typeof cancellation.releaseReservations !== 'function' || typeof audit.createAuditLog !== 'function') throw new Stop('canonical', 'the canonical release or audit writer could not be loaded');
  const pricing = await tsImport('api/src/modules/pricing/pricing.service.ts');
  if (typeof pricing.createPricingService !== 'function') throw new Stop('canonical', 'the canonical pricing service could not be loaded');
  return { releaseReservations: cancellation.releaseReservations, createAuditLog: audit.createAuditLog, createPricingService: pricing.createPricingService };
}

const home = os.homedir();
const defaultDeps = {
  stateRoot: path.join(home, '.local', 'state', 'mona-jacinta', 'pilot-local1-synthetic-retire-authorizations'),
  forbiddenRoots: [ROOT, '/tmp', '/var/tmp', '/dev/shm', os.tmpdir()],
  now: () => new Date(),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  urlFile: PILOT_URL_FILE,
  readPrivateFile: (file) => readPrivateUrlFile(file),
  createClient: createVerifiedClient,
  pilotMarkerMain,
  createPrisma: createPilotPrisma,
  loadCanonical,
  verifyBackup: (args) => verifyBackupArchive({
    ...args,
    pgRestoreList: (archive) => { const { file, args: a, options } = pgRestoreInvocation('list', archive); return execFileSync(file, a, options); },
    pgRestoreMarkerData: (archive) => { const { file, args: a, options } = pgRestoreInvocation('markerData', archive); return execFileSync(file, a, options); },
  }),
  isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try { return await rl.question(question); } finally { rl.close(); }
  },
  env: process.env,
  owner: OWNER_ACCOUNT,
  approvedMigrations: APPROVED_MIGRATION_PAYLOAD.migrations,
};

export async function main(argv, deps = {}) {
  const d = { ...defaultDeps, ...deps };
  const fail = (phase, detail) => { d.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`); return 1; };
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);
  const { mode, values: v } = parsed;
  if (mode === 'execute') {
    if (d.env?.DEBUG !== undefined) return fail('config', 'DEBUG is set; unset it (debug output could expose query parameters)');
    if (d.env?.PGOPTIONS !== undefined) return fail('config', 'PGOPTIONS is set in the environment; unset it (value not shown)');
  }
  const toolSha256 = d.toolSha256 ?? toolDigest();
  const expect = v.action === 'retire-sale'
    ? { sale: v['expect-sale'], totalCents: v['expect-total-cents'], acceptedCents: v['expect-accepted-cents'], reservedUnits: v['expect-reserved-units'] }
    : v.action === 'cancel-draft' ? { sale: v['expect-sale'], totalCents: v['expect-total-cents'], itemCount: v['expect-item-count'] } : null;
  const projectRef = v['project-ref'] ?? v['confirm-project-ref'];
  const digest = executionDigest({ action: v.action, locationCode: v.location, markerId: v['marker-id'], projectRef, toolSha256, expect });

  try {
    if (mode === 'dry-run') {
      for (const line of [
        `${PREFIX} DRY RUN — offline: no URL file, network, Prisma or database client was used; nothing was written`,
        `  action: ${v.action} at ${v.location} (${PCEN_LOCATION_ID}); reason ${RETIREMENT_REASON}`,
        ...(v.action === 'cancel-draft' ? [
          `  bound sale: SALE_IDENTITY_DIGEST ${expect.sale}; total ${expect.totalCents} centavos; ${expect.itemCount} synthetic items; no payment, reservation or checkout`,
          `  writes: Sale DRAFT → CANCELLED; AuditLog SALE_CANCELLED (reason ${CANCEL_REASON}) + ${EXCEPTION_ACTION}; SaleItem, Inventory and every history untouched`,
        ] : v.action === 'set-pricing' ? [
          `  writes: CompanyPricingConfig of the one company of PCEN via pricing.service updateConfig: ${Object.entries(LOCAL1_PRICING_CONFIG).map(([m, b]) => `${m} ${b}`).join(', ')} bps;`,
          `          AuditLog ${PRICING_AUDIT}; refused if a different config exists; no catalog, sale, stock or cash row is touched`,
        ] : v.action === 'retire-sale' ? [
          `  bound sale: SALE_IDENTITY_DIGEST ${expect.sale}; total ${expect.totalCents} centavos; accepted ${expect.acceptedCents} centavos; reserved units ${expect.reservedUnits}`,
          '  writes: Sale PENDING_PAYMENT → CANCELLED; its ACTIVE holds RELEASED and Inventory.reserved decremented (canonical releaseReservations);',
          `          AuditLog SALE_CANCELLED (reason ${CANCEL_REASON}) + ${EXCEPTION_ACTION}; SalePayment / SALE_INCOME / StockMovement retained untouched`,
        ] : [
          `  writes: ${SYNTHETIC_VARIANTS.length} ProductVariant + ${SYNTHETIC_PRODUCTS.length} Product isActive → false, one audit each + ${EXCEPTION_ACTION}; Inventory, StockMovement and sales untouched`,
        ]),
        `  execution plan sha256: ${digest}`,
        '  --authorize requires a verified PILOT backup and the OWNER terminal ceremony; --execute the PILOT marker proof',
      ]) d.log(line);
      return 0;
    }
    if (digest !== v.plan) return fail('plan', 'this action/target/evidence does not match --plan; re-run --dry-run and review (nothing was opened)');

    const urlRead = d.readPrivateFile(d.urlFile);
    if (!urlRead?.ok) return fail('config', `PILOT URL file: ${urlRead?.reason ?? 'could not be read'}`);
    const heldUrl = urlRead.text.replace(/\r?\n$/, '');
    const url = parsePilotUrl(heldUrl);
    if (!url.ok) return fail('config', 'the PILOT URL file must hold one PostgreSQL URL (value not shown)');
    if (deriveProjectRef(url.conn) !== projectRef) return fail('target', 'the project addressed by the PILOT URL file is not the one given (values not shown)');
    const now = d.now();
    const backup = d.verifyBackup({ path: v.backup, expectedSha256: v['backup-sha256'], expectedDbname: url.conn.database, expectedMarkerId: v['marker-id'], now, forbiddenRoots: d.forbiddenRoots });
    if (!backup.ok) return fail('backup', backup.reason);

    if (mode === 'authorize') {
      if (!d.isTTY) return fail('authorize', 'the authorization ceremony requires an interactive terminal');
      const phrase = `RETIRO ${v.action} ${v.plan.slice(0, 12)}`;
      const typed = await d.prompt(`Escriba exactamente "${phrase}" para autorizar UNA ejecución: `);
      if (typed !== phrase) return fail('authorize', 'the typed confirmation does not match; nothing was authorized');
      ensurePrivateDir(d.stateRoot, d.forbiddenRoots, 'authorize');
      const authId = randomBytes(16).toString('hex');
      const expiresAt = new Date(Math.min(now.getTime() + AUTH_TTL_MS, Date.parse(backup.createdAt) + BACKUP_MAX_AGE_MS));
      const record = {
        format: AUTH_FORMAT, authId, planDigest: v.plan, action: v.action, location: v.location, markerId: v['marker-id'], projectRef, expect,
        backup: { sha256: backup.sha256, createdAt: backup.createdAt, dbname: backup.dbname }, createdAt: now.toISOString(), expiresAt: expiresAt.toISOString(),
      };
      record.recordSha256 = recordHash(record);
      writeExclusive(path.join(d.stateRoot, `${authId}.json`), `${JSON.stringify(record, null, 2)}\n`, 'authorize');
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
    try { record = JSON.parse(read.buf.toString('utf8')); } catch { return fail('authorization', 'authorization record is not JSON'); }
    const bound = record?.format === AUTH_FORMAT && record.authId === v.authorization && record.recordSha256 === recordHash(record)
      && record.planDigest === v.plan && record.action === v.action && record.location === v.location && record.markerId === v['marker-id']
      && record.projectRef === projectRef && JSON.stringify(record.expect) === JSON.stringify(expect) && record.backup?.sha256 === backup.sha256;
    if (!bound) return fail('authorization', 'the authorization record is altered or bound to another plan, action, target or backup');
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
    writeExclusive(consumedFile, `${JSON.stringify({ authId: v.authorization, planDigest: v.plan, at: d.now().toISOString() })}\n`, 'authorization');

    let prisma;
    let commitState = 'before';
    try {
      const canonical = await d.loadCanonical();
      prisma = await d.createPrisma(url.conn);
      const ctx = { locationCode: v.location, markerId: v['marker-id'], owner: d.owner, canonical, approvedMigrations: d.approvedMigrations, expect,
        provenance: { authId: v.authorization, planDigest: v.plan, toolSha256 } };
      const result = await prisma.$transaction(async (tx) => {
        const r = v.action === 'retire-sale' ? await retireTransaction(tx, ctx) : v.action === 'cancel-draft' ? await cancelDraftTransaction(tx, ctx) : v.action === 'set-pricing' ? await setPricingTransaction(tx, ctx) : await deactivateTransaction(tx, ctx);
        commitState = 'pending';
        return r;
      }, { ...TRANSACTION_OPTIONS, isolationLevel: 'Serializable' });
      commitState = 'confirmed';
      if (result.action === 'NOOP') d.log(`${PREFIX} OK — already done; nothing was written`);
      else if (result.action === 'PRICING_SET') d.log(`${PREFIX} OK — pricing config set to the Local 1 values; committed`);
      else if (result.action === 'DRAFT_CANCELLED') d.log(`${PREFIX} OK — synthetic DRAFT sale CANCELLED; nothing else changed; committed`);
      else if (result.action === 'RETIRED') d.log(`${PREFIX} OK — synthetic sale CANCELLED, hold released, payment history retained (${result.retained.payments.length} payment(s)); committed`);
      else d.log(`${PREFIX} OK — ${result.counts.variants} variants and ${result.counts.products} products deactivated; committed`);
      return 0;
    } catch (err) {
      if (commitState === 'confirmed') return fail('output', 'COMMIT confirmed, but the success output failed; do not retry blindly — re-run the read-only preflight');
      if (commitState === 'pending') return fail('commit', 'COMMIT outcome is uncertain; re-run the read-only preflight before anything else');
      if (err instanceof Stop) return fail(err.phase, err.message);
      return fail('write', 'failed before COMMIT; nothing is claimed persisted');
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
