// Hermetic tests for pilot-local1-synthetic-retire.mjs. An in-memory Prisma-shaped transaction and fakes
// only: no credential, no database, no socket. Run under a no-network namespace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as T from './pilot-local1-synthetic-retire.mjs';
import { CATALOG, OWNER_ACCOUNT } from './pilot-catalog-bootstrap.mjs';
import { APPROVED_MIGRATION_PAYLOAD } from './pilot-migrate.mjs';
import { MARKER_RECHECK_SQL, MIGRATIONS_SQL, tsImport } from './pilot-local1-catalog-import.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sha = (s) => createHash('sha256').update(s).digest('hex');
const PCEN = '2477257d-2567-4fd6-9df7-1e078676b7ad';
const PDEP = '3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const MARKER = '11111111-1111-4111-8111-111111111111';
const REF = 'abcdefghijklmnopqrst';
const SYN = CATALOG.products.flatMap((p, pi) => p.variants.map((v) => ({ ...v, slug: p.slug, name: p.name, pi })));
const BUZO_L = SYN.findIndex((v) => v.sku === 'PILOT-BUZO-GRI-L');
const vid = (i) => `v${String(i + 1).padStart(2, '0')}`;
const pid = (i) => `p${i + 1}`;
const EXPECT = Object.freeze({ sale: sha('mona-pilot-synthetic-sale\ns1'), totalCents: '3500000', acceptedCents: '1000000', reservedUnits: '1' });
const clone = (x) => structuredClone(x);

// ---------- the observed PILOT shape: a partially CASH-paid PENDING_PAYMENT sale holding one synthetic unit ----------
function world() {
  return {
    location: [{ id: PCEN, code: 'PCEN', type: 'RETAIL_BRANCH', isActive: true }, { id: PDEP, code: 'PDEP', type: 'CENTRAL_WAREHOUSE', isActive: true }],
    user: [{ id: OWNER_ACCOUNT.id, isActive: true }],
    product: CATALOG.products.map((p, i) => ({ id: pid(i), slug: p.slug, name: p.name, isActive: true })),
    productVariant: SYN.map((v, i) => ({ id: vid(i), productId: pid(v.pi), sku: v.sku, barcode: v.barcode, isActive: true })),
    inventory: SYN.flatMap((v, i) => [
      { id: `i${i}`, variantId: vid(i), branchId: PCEN, physical: 5n, reserved: i === BUZO_L ? 1n : 0n },
      { id: `j${i}`, variantId: vid(i), branchId: PDEP, physical: 9n, reserved: 0n },
    ]),
    stockMovement: SYN.map((v, i) => ({ id: `m${i}`, inventoryId: `i${i}`, type: 'INITIAL_STOCK', quantityDelta: 5n, saleId: null, branchId: PCEN })),
    sale: [{ id: 's1', branchId: PCEN, status: 'PENDING_PAYMENT', total: 3500000n, subtotal: 3500000n, discountTotal: 0n, pricingModel: 'FIXED_TOTAL' }],
    saleItem: [{ id: 'si1', saleId: 's1', variantId: vid(BUZO_L), quantity: 1n, unitPrice: 3500000n, subtotal: 3500000n }],
    stockReservation: [{ id: 'r1', saleId: 's1', variantId: vid(BUZO_L), branchId: PCEN, quantity: 1n, status: 'ACTIVE', expiresAt: new Date('2026-10-01T00:00:00Z') }],
    salePayment: [{ id: 'pay1', saleId: 's1', method: 'CASH', amount: 1000000n, cashSessionId: 'cs1', checkoutId: null, externalCollectionId: null }],
    cashMovement: [{ id: 'cm1', sessionId: 'cs1', type: 'SALE_INCOME', amount: 1000000n, salePaymentId: 'pay1', reversesMovementId: null }],
    cashSession: [{ id: 'cs1', status: 'CLOSED' }],
    saleCheckout: [],
    checkoutAttempt: [],
    auditLog: [],
  };
}

// ---------- an in-memory Prisma-shaped transaction (only what the tool uses) ----------
function matches(row, where = {}) {
  return Object.entries(where).every(([k, c]) => {
    if (c !== null && typeof c === 'object' && !(c instanceof Date) && Object.hasOwn(c, 'in')) return c.in.includes(row[k]);
    return row[k] === c;
  });
}
function fakeDb(data = world(), { marker = [{ environment: 'pilot', marker_id: MARKER }], testGuard = false, ledger } = {}) {
  const writes = [];
  const raw = [];
  const table = (name) => ({
    findMany: async ({ where } = {}) => data[name].filter((r) => matches(r, where)).map(clone),
    findUnique: async ({ where }) => clone(data[name].find((r) => matches(r, where)) ?? null),
    findFirst: async ({ where } = {}) => clone(data[name].find((r) => matches(r, where)) ?? null),
    upsert: async ({ where, create, update }) => {
      const row = data[name].find((r) => matches(r, where));
      if (row) { Object.assign(row, update); writes.push([name, 'upsert', where]); return clone(row); }
      const made = { id: `${name}-${data[name].length + 1}`, updatedAt: new Date(0), ...create };
      data[name].push(made); writes.push([name, 'upsert', where]); return clone(made);
    },
    count: async ({ where } = {}) => data[name].filter((r) => matches(r, where)).length,
    update: async ({ where, data: d }) => {
      const row = data[name].find((r) => matches(r, where));
      if (!row) throw new Error(`${name}.update: no row`);
      Object.assign(row, d); writes.push([name, 'update', where]); return clone(row);
    },
    updateMany: async ({ where, data: d }) => {
      const rows = data[name].filter((r) => matches(r, where));
      for (const r of rows) Object.assign(r, d);
      writes.push([name, 'updateMany', where, rows.length]); return { count: rows.length };
    },
    create: async ({ data: d }) => {
      const row = { id: `${name}-${data[name].length + 1}`, ...d };
      data[name].push(row); writes.push([name, 'create']); return clone(row);
    },
  });
  const ledgerRows = ledger ?? APPROVED_MIGRATION_PAYLOAD.migrations.map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));
  const tx = {
    ...Object.fromEntries(Object.keys(data).map((n) => [n, table(n)])),
    async $queryRawUnsafe(sql, ...params) {
      raw.push(sql);
      if (sql === T.SQL.ADVISORY_LOCK) return [{ pg_advisory_xact_lock: '' }];
      if (sql === MARKER_RECHECK_SQL) return [{ test_guard_exists: testGuard, rows: marker }];
      if (sql === MIGRATIONS_SQL) return ledgerRows;
      if (sql === T.SQL.SALE_FOR_UPDATE) return data.sale.filter((s) => s.id === params[0]).map((s) => ({ id: s.id, branchId: s.branchId, status: s.status }));
      if (sql === T.SQL.RESERVATIONS_FOR_UPDATE) return data.stockReservation.filter((r) => r.saleId === params[0]).sort((a, b) => (a.id < b.id ? -1 : 1)).map(clone);
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { data, tx, writes, raw };
}
// The canonical release (cancellation.service.ts releaseReservations) and audit writer, faithfully reproduced.
function fakeCanonical({ tamper = null } = {}) {
  const calls = [];
  return {
    calls,
    async releaseReservations(tx, sale, reservations) {
      calls.push(['release', sale.id, reservations.map((r) => r.id)]);
      const active = reservations.filter((r) => r.status === 'ACTIVE');
      if (active.some((r) => r.branchId !== sale.branchId)) throw new Error('INVALID_RESERVATION');
      const q = new Map();
      for (const r of active) q.set(r.variantId, (q.get(r.variantId) ?? 0n) + r.quantity);
      const invs = await tx.inventory.findMany({ where: { branchId: sale.branchId, variantId: { in: [...q.keys()] } } });
      for (const [v, n] of q) { const inv = invs.find((i) => i.variantId === v); if (!inv || inv.reserved < n) throw new Error('INVALID_RESERVATION'); }
      for (const [v, n] of q) { const inv = invs.find((i) => i.variantId === v); await tx.inventory.update({ where: { id: inv.id }, data: { reserved: inv.reserved - n } }); }
      const released = await tx.stockReservation.updateMany({ where: { id: { in: active.map((r) => r.id) }, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
      if (released.count !== active.length) throw new Error('INVALID_RESERVATION');
      if (tamper) await tamper(tx);
      return [...q].map(([variantId, quantity]) => ({ variantId, quantity }));
    },
    async createAuditLog(tx, entry) { calls.push(['audit', entry.action]); return tx.auditLog.create({ data: entry }); },
  };
}
const PROV = Object.freeze({ authId: 'a'.repeat(32), planDigest: 'b'.repeat(64), toolSha256: 'c'.repeat(64) });
const retireCtx = (canonical = fakeCanonical(), expect = EXPECT) => ({ locationCode: 'PCEN', markerId: MARKER, owner: OWNER_ACCOUNT, canonical,
  approvedMigrations: APPROVED_MIGRATION_PAYLOAD.migrations, expect, provenance: PROV });
const history = (d) => clone({ salePayment: d.salePayment, cashMovement: d.cashMovement, stockMovement: d.stockMovement });

// ---------- R: retire the paid-pending synthetic sale ----------
test('R01 the observed shape classifies READY, bound to exactly this sale and these amounts', async () => {
  const db = fakeDb();
  const c = T.classifyRetirement(await T.readRetirementSnapshot(db.tx, { saleId: 's1', ownerId: OWNER_ACCOUNT.id }), EXPECT);
  assert.equal(c.state, 'READY', c.conflicts.join('; '));
});

test('R02 retire: CANCELLED, the hold released through the canonical rule, every financial and stock history row intact, both audits', async () => {
  const db = fakeDb();
  const before = history(db.data);
  const canonical = fakeCanonical();
  const r = await T.retireTransaction(db.tx, retireCtx(canonical));
  assert.equal(r.action, 'RETIRED');
  assert.equal(db.data.sale[0].status, 'CANCELLED');
  assert.equal(db.data.stockReservation[0].status, 'RELEASED');
  const inv = db.data.inventory.find((i) => i.id === `i${BUZO_L}`);
  assert.equal(inv.reserved, 0n); assert.equal(inv.physical, 5n);
  assert.deepEqual(history(db.data), before, 'SalePayment, CashMovement and StockMovement are untouched');
  assert.deepEqual(canonical.calls.map((c) => c[0] === 'release' ? c : c[1]), [['release', 's1', ['r1']], 'SALE_CANCELLED', 'PILOT_SYNTHETIC_DATA_RETIREMENT']);
  const [cancel, exception] = db.data.auditLog;
  assert.equal(cancel.action, 'SALE_CANCELLED'); assert.equal(cancel.entityId, 's1'); assert.equal(cancel.userId, OWNER_ACCOUNT.id); assert.equal(cancel.branchId, PCEN);
  assert.deepEqual(cancel.before, { status: 'PENDING_PAYMENT' });
  assert.equal(cancel.after.status, 'CANCELLED'); assert.equal(cancel.after.reason, 'OTHER'); assert.match(cancel.after.note, /PILOT_SYNTHETIC_DATA_RETIREMENT/);
  assert.deepEqual(cancel.after.released, [{ variantId: vid(BUZO_L), quantity: 1n }]);
  assert.equal(exception.action, 'PILOT_SYNTHETIC_DATA_RETIREMENT'); assert.equal(exception.entityType, 'Sale'); assert.equal(exception.entityId, 's1');
  assert.equal(exception.after.reason, 'PILOT_SYNTHETIC_DATA_RETIREMENT');
  assert.equal(exception.after.retained.acceptedCents, '1000000');
  assert.deepEqual(exception.after.retained.payments, [{ method: 'CASH', amountCents: '1000000', cashMovements: 1 }]);
  assert.equal(exception.after.planDigest, PROV.planDigest);
  // lock order: maintenance lock, identity, ledger, then Sale → StockReservation (the canonical prefix)
  assert.deepEqual(db.raw, [T.SQL.ADVISORY_LOCK, MARKER_RECHECK_SQL, MIGRATIONS_SQL, T.SQL.SALE_FOR_UPDATE, T.SQL.RESERVATIONS_FOR_UPDATE]);
  // never a delete, never a financial or stock write
  for (const [name, op] of db.writes) assert.ok(['sale', 'stockReservation', 'inventory', 'auditLog'].includes(name) && op !== 'delete', `${name}.${op}`);
});

test('R03 a second run after success is a NOOP with zero writes', async () => {
  const db = fakeDb();
  await T.retireTransaction(db.tx, retireCtx());
  const n = db.writes.length;
  const r = await T.retireTransaction(db.tx, retireCtx());
  assert.equal(r.action, 'NOOP');
  assert.equal(db.writes.length, n);
});

const CONFLICTS = {
  'another sale digest': (d, e) => { e.sale = sha('mona-pilot-synthetic-sale\nother'); },
  'sale already PAID': (d) => { d.sale[0].status = 'PAID'; },
  'sale PROPORTIONAL_V1': (d) => { d.sale[0].pricingModel = 'PROPORTIONAL_V1'; },
  'sale on another branch': (d) => { d.sale[0].branchId = PDEP; },
  'total differs from the evidence': (d, e) => { e.totalCents = '3500001'; },
  'accepted differs from the evidence': (d, e) => { e.acceptedCents = '999999'; },
  'payments already cover the total': (d, e) => { d.salePayment[0].amount = 3500000n; d.cashMovement[0].amount = 3500000n; e.acceptedCents = '3500000'; },
  'no payment at all': (d, e) => { d.salePayment = []; d.cashMovement = []; e.acceptedCents = '0'; },
  'payment linked to an external collection': (d) => { d.salePayment[0].externalCollectionId = 'ec1'; },
  'payment of a checkout': (d) => { d.salePayment[0].checkoutId = 'ck1'; },
  'CASH payment without its SALE_INCOME': (d) => { d.cashMovement = []; },
  'SALE_INCOME of another amount': (d) => { d.cashMovement[0].amount = 1n; },
  'SALE_INCOME already reversed': (d) => { d.cashMovement.push({ id: 'cm2', sessionId: 'cs1', type: 'SALE_INCOME', amount: 1000000n, salePaymentId: 'pay1', reversesMovementId: null }); },
  'its cash session still OPEN': (d) => { d.cashSession[0].status = 'OPEN'; },
  'non-cash payment with a cash movement': (d) => { d.salePayment[0].method = 'TRANSFER'; },
  'a SaleCheckout exists': (d) => { d.saleCheckout.push({ id: 'ck', saleId: 's1' }); },
  'a CheckoutAttempt exists': (d) => { d.checkoutAttempt.push({ id: 'ca', saleId: 's1', status: 'ABANDONED' }); },
  'an item that is not synthetic': (d) => { d.saleItem[0].variantId = 'real-variant'; d.stockReservation[0].variantId = 'real-variant'; },
  'items do not add up': (d) => { d.saleItem[0].subtotal = 3400000n; },
  'holds differ from items': (d) => { d.saleItem[0].quantity = 2n; d.saleItem[0].subtotal = 7000000n; d.sale[0].subtotal = 7000000n; d.sale[0].total = 7000000n; },
  'reserved units differ from the evidence': (d, e) => { e.reservedUnits = '2'; },
  'a second synthetic sale holds stock': (d) => {
    d.sale.push({ ...d.sale[0], id: 's2' }); d.stockReservation.push({ ...d.stockReservation[0], id: 'r2', saleId: 's2', variantId: vid(0) });
  },
  'the hold sits at another branch': (d) => { d.stockReservation[0].branchId = PDEP; },
  'inventory reserved below the hold': (d) => { d.inventory.find((i) => i.id === `i${BUZO_L}`).reserved = 0n; },
  'a synthetic variant is missing': (d) => { d.productVariant = d.productVariant.filter((v) => v.id !== vid(3)); },
  'a synthetic variant barcode differs': (d) => { d.productVariant[0].barcode = 'PILOT-BC-9999'; },
  'PCEN is not an active retail branch': (d) => { d.location[0].isActive = false; },
  'the OWNER audit actor is inactive': (d) => { d.user[0].isActive = false; },
};
test('R04 every precondition fails closed: one deviation → conflict, and not a single write', async () => {
  for (const [label, mutate] of Object.entries(CONFLICTS)) {
    const d = world(); const e = { ...EXPECT };
    mutate(d, e);
    const db = fakeDb(d);
    const snapshot = history(d);
    await assert.rejects(T.retireTransaction(db.tx, retireCtx(fakeCanonical(), e)), (err) => err.phase === 'conflict', label);
    assert.deepEqual(db.writes, [], `${label}: wrote ${JSON.stringify(db.writes)}`);
    assert.deepEqual(history(d), snapshot, label);
  }
});

test('R05 a write session that does not see the proven PILOT marker or the exact G11 ledger writes nothing', async () => {
  for (const opts of [{ marker: [{ environment: 'pilot', marker_id: '22222222-2222-4222-8222-222222222222' }] }, { testGuard: true },
    { ledger: APPROVED_MIGRATION_PAYLOAD.migrations.slice(0, 7).map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false })) }]) {
    const db = fakeDb(world(), opts);
    await assert.rejects(T.retireTransaction(db.tx, retireCtx()), (err) => err.phase === 'identity');
    assert.deepEqual(db.writes, []);
  }
});

test('R06 post-write verification refuses any side effect beyond the plan (the transaction then rolls back)', async () => {
  const tampers = {
    'physical stock changed': async (tx) => { await tx.inventory.update({ where: { id: `i${BUZO_L}` }, data: { physical: 4n } }); },
    'another inventory changed': async (tx) => { await tx.inventory.update({ where: { id: 'j0' }, data: { reserved: 1n } }); },
    'a payment changed': async (tx) => { await tx.salePayment.update({ where: { id: 'pay1' }, data: { amount: 1n } }); },
    'a stock movement written': async (tx) => { await tx.stockMovement.create({ data: { inventoryId: `i${BUZO_L}`, type: 'SALE', quantityDelta: -1n } }); },
  };
  for (const [label, tamper] of Object.entries(tampers)) {
    const db = fakeDb();
    await assert.rejects(T.retireTransaction(db.tx, retireCtx(fakeCanonical({ tamper }))), (err) => err.phase === 'verify', label);
  }
});

// ---------- D: deactivate the 6 synthetic products and 16 variants ----------
const deactivateCtx = (canonical = fakeCanonical()) => ({ locationCode: 'PCEN', markerId: MARKER, owner: OWNER_ACCOUNT, canonical,
  approvedMigrations: APPROVED_MIGRATION_PAYLOAD.migrations, provenance: PROV });

test('D01 after the retirement: exactly 16 variants and 6 products set inactive, one audit each plus the exception; stock and sales untouched', async () => {
  const db = fakeDb();
  await T.retireTransaction(db.tx, retireCtx());
  const before = clone({ inventory: db.data.inventory, sale: db.data.sale, ...history(db.data) });
  const r = await T.deactivateTransaction(db.tx, deactivateCtx());
  assert.equal(r.action, 'DEACTIVATED');
  assert.deepEqual(r.counts, { products: 6, variants: 16 });
  assert.ok(db.data.productVariant.every((v) => v.isActive === false));
  assert.ok(db.data.product.every((p) => p.isActive === false));
  assert.deepEqual(clone({ inventory: db.data.inventory, sale: db.data.sale, ...history(db.data) }), before);
  const audits = db.data.auditLog.slice(2);
  assert.equal(audits.filter((a) => a.action === 'PRODUCT_VARIANT_DEACTIVATED').length, 16);
  assert.equal(audits.filter((a) => a.action === 'PRODUCT_DEACTIVATED').length, 6);
  assert.equal(audits.filter((a) => a.action === 'PILOT_SYNTHETIC_DATA_RETIREMENT').length, 1);
  for (const a of audits.filter((x) => x.action.endsWith('_DEACTIVATED'))) {
    assert.deepEqual(a.before, { isActive: true }); assert.deepEqual(a.after, { isActive: false, reason: 'PILOT_SYNTHETIC_DATA_RETIREMENT' });
  }
});

test('D02 deactivation refuses while a synthetic hold or an open sale with a synthetic item exists', async () => {
  const pending = fakeDb();
  await assert.rejects(T.deactivateTransaction(pending.tx, deactivateCtx()), (err) => err.phase === 'conflict');
  assert.deepEqual(pending.writes, []);
  for (const status of ['DRAFT', 'PENDING_PAYMENT', 'PAID']) {
    const d = world(); d.stockReservation[0].status = 'RELEASED'; d.sale[0].status = status;
    const db = fakeDb(d);
    await assert.rejects(T.deactivateTransaction(db.tx, deactivateCtx()), (err) => err.phase === 'conflict', status);
    assert.deepEqual(db.writes, []);
  }
});

test('D03 deactivation is idempotent (NOOP once inactive) and refuses a mixed or tampered catalog', async () => {
  const db = fakeDb();
  await T.retireTransaction(db.tx, retireCtx());
  await T.deactivateTransaction(db.tx, deactivateCtx());
  const n = db.writes.length;
  assert.equal((await T.deactivateTransaction(db.tx, deactivateCtx())).action, 'NOOP');
  assert.equal(db.writes.length, n);
  const mixed = fakeDb(); await T.retireTransaction(mixed.tx, retireCtx()); mixed.data.productVariant[0].isActive = false; mixed.writes.length = 0;
  await assert.rejects(T.deactivateTransaction(mixed.tx, deactivateCtx()), (err) => err.phase === 'conflict');
  assert.deepEqual(mixed.writes, []);
  const slug = fakeDb(); await T.retireTransaction(slug.tx, retireCtx()); slug.data.product[0].slug = 'remera-basica'; slug.writes.length = 0;
  await assert.rejects(T.deactivateTransaction(slug.tx, deactivateCtx()), (err) => err.phase === 'conflict');
  assert.deepEqual(slug.writes, []);
});

// ---------- C: CLI, plan binding, OWNER envelope ----------
const BASE = ['--location=PCEN', `--marker-id=${MARKER}`];
const RETIRE_EXPECT = [`--expect-sale=${EXPECT.sale}`, '--expect-total-cents=3500000', '--expect-accepted-cents=1000000', '--expect-reserved-units=1'];
test('C01 the CLI accepts exactly the documented arguments per mode and action', () => {
  assert.equal(T.parseCliArgs(['--dry-run', '--action=retire-sale', ...BASE, `--project-ref=${REF}`, ...RETIRE_EXPECT]).ok, true);
  assert.equal(T.parseCliArgs(['--dry-run', '--action=deactivate-catalog', ...BASE, `--project-ref=${REF}`]).ok, true);
  for (const bad of [
    ['--dry-run', '--action=retire-sale', ...BASE, `--project-ref=${REF}`],
    ['--dry-run', '--action=deactivate-catalog', ...BASE, `--project-ref=${REF}`, ...RETIRE_EXPECT],
    ['--dry-run', '--action=delete-everything', ...BASE, `--project-ref=${REF}`],
    ['--dry-run', '--execute', '--action=retire-sale', ...BASE],
    ['--dry-run', '--action=retire-sale', ...BASE, `--project-ref=${REF}`, ...RETIRE_EXPECT, '--expect-total-cents=1'],
    ['--dry-run', '--action=retire-sale', ...BASE, `--project-ref=${REF}`, ...RETIRE_EXPECT.slice(1), '--expect-sale=XYZ'],
    ['--dry-run', '--action=retire-sale', ...BASE, `--project-ref=${REF}`, ...RETIRE_EXPECT.slice(0, 1), '--expect-total-cents=1.5', ...RETIRE_EXPECT.slice(2)],
  ]) assert.equal(T.parseCliArgs(bad).ok, false, bad.join(' '));
});

test('C02 the execution digest binds the action, target, tool and every expected value', () => {
  const base = { action: 'retire-sale', locationCode: 'PCEN', markerId: MARKER, projectRef: REF, toolSha256: 'e'.repeat(64), expect: EXPECT };
  const d = T.executionDigest(base);
  assert.match(d, /^[0-9a-f]{64}$/);
  for (const [k, v] of Object.entries({ action: 'deactivate-catalog', locationCode: 'PDEP', markerId: '22222222-2222-4222-8222-222222222222', projectRef: 'zbcdefghijklmnopqrst', toolSha256: 'f'.repeat(64) })) {
    assert.notEqual(T.executionDigest({ ...base, [k]: v }), d, k);
  }
  for (const k of Object.keys(EXPECT)) assert.notEqual(T.executionDigest({ ...base, expect: { ...EXPECT, [k]: k === 'sale' ? 'a'.repeat(64) : '7' } }), d, k);
});

function harness(over = {}) {
  const out = [];
  const err = [];
  const state = { tx: 0, consumed: false };
  const db = over.db ?? fakeDb();
  const deps = {
    stateRoot: mkdtempSync(path.join(os.tmpdir(), 'mona-retire-test-')), forbiddenRoots: [], now: () => new Date('2026-10-19T20:00:00Z'),
    toolSha256: 'e'.repeat(64), log: (l) => out.push(l), error: (l) => err.push(l),
    readPrivateFile: () => ({ ok: true, text: `postgresql://postgres.${REF}:pw@aws-0-sa-east-1.pooler.supabase.com:5432/postgres\n` }),
    verifyBackup: () => ({ ok: true, sha256: 'd'.repeat(64), createdAt: '2026-10-19T19:30:00.000Z', dbname: 'postgres' }),
    pilotMarkerMain: async () => 0,
    loadCanonical: async () => fakeCanonical(),
    createPrisma: async () => ({ $transaction: async (fn) => { state.tx += 1; return fn(db.tx); }, $disconnect: async () => {} }),
    isTTY: true, prompt: async (q) => /"([^"]+)"/.exec(q)[1],
    env: {},
    ...over.deps,
  };
  return { out, err, deps, state, db };
}
const plan = (action = 'retire-sale') => T.executionDigest({ action, locationCode: 'PCEN', markerId: MARKER, projectRef: REF, toolSha256: 'e'.repeat(64), expect: action === 'retire-sale' ? EXPECT : null });
const envelope = (mode, action = 'retire-sale', extra = []) => [`--${mode}`, `--action=${action}`, ...BASE, ...(action === 'retire-sale' ? RETIRE_EXPECT : []), ...extra];
const backupArgs = ['--backup=/x/pilot.dump', `--backup-sha256=${'d'.repeat(64)}`];

test('C03 dry-run is offline: prints the plan digest, opens nothing, writes nothing', async () => {
  const h = harness({ deps: { readPrivateFile: () => { throw new Error('no URL file in a dry run'); }, createPrisma: () => { throw new Error('no Prisma in a dry run'); } } });
  assert.equal(await T.main(envelope('dry-run', 'retire-sale', [`--project-ref=${REF}`]), h.deps), 0, h.err.join('\n'));
  assert.match(h.out.join('\n'), new RegExp(`execution plan sha256: ${plan()}`));
  assert.match(h.out.join('\n'), /PILOT_SYNTHETIC_DATA_RETIREMENT/);
  assert.deepEqual(readdirSync(h.deps.stateRoot), []);
});

test('C04 authorize (TTY) then execute: single use, bound to plan + backup, marker proof before the transaction', async () => {
  const h = harness();
  assert.equal(await T.main(envelope('authorize', 'retire-sale', [`--project-ref=${REF}`, `--plan=${plan()}`, ...backupArgs]), h.deps), 0, h.err.join('\n'));
  const authId = /authorization id: ([0-9a-f]{32})/.exec(h.out.join('\n'))[1];
  const exec = envelope('execute', 'retire-sale', [`--confirm-project-ref=${REF}`, `--plan=${plan()}`, ...backupArgs, `--authorization=${authId}`]);
  assert.equal(await T.main(exec, h.deps), 0, h.err.join('\n'));
  assert.equal(h.state.tx, 1);
  assert.equal(h.db.data.sale[0].status, 'CANCELLED');
  assert.equal(await T.main(exec, h.deps), 1);
  assert.match(h.err.join('\n'), /already used/);
  assert.equal(h.state.tx, 1);
});

test('C05 execute refuses before any transaction: wrong plan, no TTY ceremony, failed marker proof, DEBUG/PGOPTIONS set', async () => {
  const wrong = harness();
  assert.equal(await T.main(envelope('authorize', 'retire-sale', [`--project-ref=${REF}`, `--plan=${'0'.repeat(64)}`, ...backupArgs]), wrong.deps), 1);
  assert.match(wrong.err.join('\n'), /phase=plan/);
  const notty = harness({ deps: { isTTY: false } });
  assert.equal(await T.main(envelope('authorize', 'retire-sale', [`--project-ref=${REF}`, `--plan=${plan()}`, ...backupArgs]), notty.deps), 1);
  const h = harness({ deps: { pilotMarkerMain: async () => 2 } });
  await T.main(envelope('authorize', 'retire-sale', [`--project-ref=${REF}`, `--plan=${plan()}`, ...backupArgs]), h.deps);
  const authId = /authorization id: ([0-9a-f]{32})/.exec(h.out.join('\n'))[1];
  assert.equal(await T.main(envelope('execute', 'retire-sale', [`--confirm-project-ref=${REF}`, `--plan=${plan()}`, ...backupArgs, `--authorization=${authId}`]), h.deps), 1);
  assert.match(h.err.join('\n'), /phase=identity/);
  assert.equal(h.state.tx, 0);
  const dbg = harness({ deps: { env: { DEBUG: '1' } } });
  assert.equal(await T.main(envelope('execute', 'retire-sale', [`--confirm-project-ref=${REF}`, `--plan=${plan()}`, ...backupArgs, `--authorization=${'a'.repeat(32)}`]), dbg.deps), 1);
  assert.equal(dbg.state.tx, 0);
});

// ---------- S: static contract ----------
test('S01 the tool never deletes and never writes SalePayment, CashMovement or StockMovement', () => {
  const src = readFileSync(path.join(HERE, 'pilot-local1-synthetic-retire.mjs'), 'utf8');
  assert.ok(!/\.delete(Many)?\(/.test(src), 'no delete');
  assert.ok(!/\bDELETE\b|\bTRUNCATE\b|\bINSERT\b|\bUPDATE\s+"/i.test(Object.values(T.SQL).join('\n')), 'frozen SQL is read/lock only');
  for (const m of ['salePayment', 'cashMovement', 'stockMovement', 'cashSession']) {
    assert.ok(!new RegExp(`\\.${m}\\.(create|update|updateMany|upsert|delete)`).test(src), m);
  }
});

test('S02 the tool digest covers the tool and every module whose code it runs', () => {
  assert.deepEqual(T.DIGESTED_FILES, ['scripts/database/pilot-local1-synthetic-retire.mjs', 'scripts/database/pilot-local1-catalog-import.mjs',
    'scripts/database/pilot-catalog-bootstrap.mjs', 'api/src/modules/sales/cancellation.service.ts', 'api/src/shared/audit.ts',
    'api/src/modules/pricing/pricing.service.ts', 'api/src/modules/pricing/pricing.ts']);
  assert.match(T.toolDigest(), /^[0-9a-f]{64}$/);
});

test('S03 the sale identity digest and the synthetic catalog are the preflight ones (one binding, two tools)', async () => {
  const PF = await import('./pilot-local1-preflight.mjs');
  for (const id of ['s1', '00000000-0000-4000-9700-000000000001']) assert.equal(T.saleIdentityDigest(id), PF.saleIdentityDigest(id));
  assert.deepEqual(T.SYNTHETIC_VARIANTS.map((v) => [v.sku, v.barcode]), PF.SYNTHETIC_VARIANTS.map((v) => [v.sku, v.barcode]));
  assert.equal(T.PCEN_LOCATION_ID, PF.PCEN_LOCATION_ID);
});

// ---------- X: cancel the remaining synthetic DRAFT sale (the canonical DRAFT cancel needs the owning seller; the
// OWNER ceremony replaces that authority, the state rules and the audit shape are cancellation.service.ts's) ----------
const DRAFT_EXPECT = Object.freeze({ sale: sha('mona-pilot-synthetic-sale\nd1'), totalCents: '10000000', itemCount: '2' });
function draftWorld() {
  const d = world();
  d.sale = [{ id: 'd1', branchId: PCEN, status: 'DRAFT', total: 10000000n, subtotal: 10000000n, discountTotal: 0n, pricingModel: 'FIXED_TOTAL', priceMode: 'LIST' }];
  d.saleItem = [{ id: 'di1', saleId: 'd1', variantId: vid(0), quantity: 1n, unitPrice: 6000000n, subtotal: 6000000n },
    { id: 'di2', saleId: 'd1', variantId: vid(1), quantity: 2n, unitPrice: 2000000n, subtotal: 4000000n }];
  d.stockReservation = []; d.salePayment = []; d.cashMovement = []; d.cashSession = [];
  for (const i of d.inventory) i.reserved = 0n;
  return d;
}
const draftCtx = (canonical = fakeCanonical(), expect = DRAFT_EXPECT) => retireCtx(canonical, expect);
const stockState = (d) => clone({ inventory: d.inventory, stockMovement: d.stockMovement, saleItem: d.saleItem, salePayment: d.salePayment, cashMovement: d.cashMovement, stockReservation: d.stockReservation });

test('X01 cancel-draft: DRAFT → CANCELLED with the canonical audit shape plus the exception audit; nothing else changes', async () => {
  const db = fakeDb(draftWorld());
  const before = stockState(db.data);
  const canonical = fakeCanonical();
  const r = await T.cancelDraftTransaction(db.tx, draftCtx(canonical));
  assert.equal(r.action, 'DRAFT_CANCELLED');
  assert.equal(db.data.sale[0].status, 'CANCELLED');
  assert.deepEqual(stockState(db.data), before, 'items, inventory, stock/cash/payment history are untouched');
  assert.deepEqual(canonical.calls, [['audit', 'SALE_CANCELLED'], ['audit', 'PILOT_SYNTHETIC_DATA_RETIREMENT']], 'no reservation release: a DRAFT holds none');
  const [cancel, exception] = db.data.auditLog;
  assert.equal(cancel.entityId, 'd1'); assert.equal(cancel.userId, OWNER_ACCOUNT.id); assert.equal(cancel.branchId, PCEN);
  assert.deepEqual(cancel.before, { status: 'DRAFT' });
  assert.equal(cancel.after.status, 'CANCELLED'); assert.equal(cancel.after.reason, 'OTHER'); assert.match(cancel.after.note, /PILOT_SYNTHETIC_DATA_RETIREMENT/);
  assert.deepEqual(cancel.after.released, []);
  assert.equal(exception.entityType, 'Sale'); assert.equal(exception.entityId, 'd1'); assert.equal(exception.after.saleDigest, DRAFT_EXPECT.sale);
  assert.equal(exception.after.planDigest, PROV.planDigest);
  assert.deepEqual(db.raw, [T.SQL.ADVISORY_LOCK, MARKER_RECHECK_SQL, MIGRATIONS_SQL, T.SQL.SALE_FOR_UPDATE, T.SQL.RESERVATIONS_FOR_UPDATE]);
  for (const [name, op] of db.writes) assert.ok(['sale', 'auditLog'].includes(name) && op !== 'delete', `${name}.${op}`);
});

test('X02 a second cancel-draft run is a NOOP with zero writes', async () => {
  const db = fakeDb(draftWorld());
  await T.cancelDraftTransaction(db.tx, draftCtx());
  const n = db.writes.length;
  assert.equal((await T.cancelDraftTransaction(db.tx, draftCtx())).action, 'NOOP');
  assert.equal(db.writes.length, n);
});

const DRAFT_CONFLICTS = {
  'another sale digest': (d, e) => { e.sale = sha('mona-pilot-synthetic-sale\nother'); },
  'sale is PENDING_PAYMENT': (d) => { d.sale[0].status = 'PENDING_PAYMENT'; },
  'sale is PAID': (d) => { d.sale[0].status = 'PAID'; },
  'sale PROPORTIONAL_V1': (d) => { d.sale[0].pricingModel = 'PROPORTIONAL_V1'; },
  'sale on another branch': (d) => { d.sale[0].branchId = PDEP; },
  'total differs from the evidence': (d, e) => { e.totalCents = '10000001'; },
  'item count differs from the evidence': (d, e) => { e.itemCount = '3'; },
  'a payment exists': (d) => { d.salePayment.push({ id: 'p', saleId: 'd1', method: 'CASH', amount: 1n, cashSessionId: null, checkoutId: null, externalCollectionId: null }); },
  'an ACTIVE reservation exists': (d) => { d.stockReservation.push({ id: 'r', saleId: 'd1', variantId: vid(0), branchId: PCEN, quantity: 1n, status: 'ACTIVE', expiresAt: new Date() }); },
  'a RELEASED reservation exists': (d) => { d.stockReservation.push({ id: 'r', saleId: 'd1', variantId: vid(0), branchId: PCEN, quantity: 1n, status: 'RELEASED', expiresAt: new Date() }); },
  'a SaleCheckout exists': (d) => { d.saleCheckout.push({ id: 'ck', saleId: 'd1' }); },
  'a CheckoutAttempt exists': (d) => { d.checkoutAttempt.push({ id: 'ca', saleId: 'd1', status: 'ABANDONED' }); },
  'an item that is not synthetic': (d) => { d.saleItem[1].variantId = 'real-variant'; },
  'items do not add up': (d) => { d.saleItem[0].subtotal = 5999999n; },
  'a second synthetic DRAFT': (d) => { d.sale.push({ ...d.sale[0], id: 'd2' }); d.saleItem.push({ id: 'di3', saleId: 'd2', variantId: vid(2), quantity: 1n, unitPrice: 1n, subtotal: 1n }); },
  'a synthetic variant barcode differs': (d) => { d.productVariant[0].barcode = 'PILOT-BC-9999'; },
  'PCEN is not an active retail branch': (d) => { d.location[0].isActive = false; },
  'the OWNER audit actor is inactive': (d) => { d.user[0].isActive = false; },
};
test('X03 cancel-draft fails closed: one deviation → conflict, and not a single write', async () => {
  for (const [label, mutate] of Object.entries(DRAFT_CONFLICTS)) {
    const d = draftWorld(); const e = { ...DRAFT_EXPECT };
    mutate(d, e);
    const db = fakeDb(d);
    const snapshot = stockState(d);
    await assert.rejects(T.cancelDraftTransaction(db.tx, draftCtx(fakeCanonical(), e)), (err) => err.phase === 'conflict', label);
    assert.deepEqual(db.writes, [], `${label}: wrote ${JSON.stringify(db.writes)}`);
    assert.deepEqual(stockState(d), snapshot, label);
  }
});

test('X04 cancel-draft: a write session that does not see the proven PILOT marker or ledger writes nothing; tampering is rolled back', async () => {
  const db = fakeDb(draftWorld(), { testGuard: true });
  await assert.rejects(T.cancelDraftTransaction(db.tx, draftCtx()), (err) => err.phase === 'identity');
  assert.deepEqual(db.writes, []);
  const tampered = fakeDb(draftWorld());
  const canonical = fakeCanonical();
  const createAuditLog = canonical.createAuditLog;
  canonical.createAuditLog = async (tx, entry) => { await tx.inventory.update({ where: { id: 'i0' }, data: { reserved: 1n } }); return createAuditLog(tx, entry); };
  await assert.rejects(T.cancelDraftTransaction(tampered.tx, draftCtx(canonical)), (err) => err.phase === 'verify');
});

const DRAFT_ARGS = [`--expect-sale=${DRAFT_EXPECT.sale}`, '--expect-total-cents=10000000', '--expect-item-count=2'];
const draftPlan = () => T.executionDigest({ action: 'cancel-draft', locationCode: 'PCEN', markerId: MARKER, projectRef: REF, toolSha256: 'e'.repeat(64), expect: DRAFT_EXPECT });
test('X05 CLI and plan digest: cancel-draft takes exactly the draft evidence and the digest binds every value', () => {
  assert.equal(T.parseCliArgs(['--dry-run', '--action=cancel-draft', ...BASE, `--project-ref=${REF}`, ...DRAFT_ARGS]).ok, true);
  for (const bad of [
    ['--dry-run', '--action=cancel-draft', ...BASE, `--project-ref=${REF}`],
    ['--dry-run', '--action=cancel-draft', ...BASE, `--project-ref=${REF}`, ...DRAFT_ARGS, '--expect-accepted-cents=0'],
    ['--dry-run', '--action=cancel-draft', ...BASE, `--project-ref=${REF}`, ...DRAFT_ARGS.slice(0, 2), '--expect-item-count=0'],
    ['--dry-run', '--action=retire-sale', ...BASE, `--project-ref=${REF}`, ...RETIRE_EXPECT, '--expect-item-count=2'],
  ]) assert.equal(T.parseCliArgs(bad).ok, false, bad.join(' '));
  const d = draftPlan();
  for (const k of Object.keys(DRAFT_EXPECT)) assert.notEqual(T.executionDigest({ action: 'cancel-draft', locationCode: 'PCEN', markerId: MARKER, projectRef: REF, toolSha256: 'e'.repeat(64), expect: { ...DRAFT_EXPECT, [k]: k === 'sale' ? 'a'.repeat(64) : '7' } }), d, k);
  assert.ok(T.ACTIONS.includes('cancel-draft'));
});

test('X06 end to end: dry-run (offline) → authorize (TTY) → execute cancels the DRAFT once', async () => {
  const h = harness({ db: fakeDb(draftWorld()) });
  const argv = (mode, extra) => [`--${mode}`, '--action=cancel-draft', ...BASE, ...DRAFT_ARGS, ...extra];
  assert.equal(await T.main(argv('dry-run', [`--project-ref=${REF}`]), { ...h.deps, readPrivateFile: () => { throw new Error('offline'); } }), 0, h.err.join('\n'));
  assert.match(h.out.join('\n'), new RegExp(`execution plan sha256: ${draftPlan()}`));
  assert.equal(await T.main(argv('authorize', [`--project-ref=${REF}`, `--plan=${draftPlan()}`, ...backupArgs]), h.deps), 0, h.err.join('\n'));
  const authId = /authorization id: ([0-9a-f]{32})/.exec(h.out.join('\n'))[1];
  const exec = argv('execute', [`--confirm-project-ref=${REF}`, `--plan=${draftPlan()}`, ...backupArgs, `--authorization=${authId}`]);
  assert.equal(await T.main(exec, h.deps), 0, h.err.join('\n'));
  assert.equal(h.db.data.sale[0].status, 'CANCELLED');
  assert.match(h.out.join('\n'), /synthetic DRAFT sale CANCELLED/);
  assert.equal(await T.main(exec, h.deps), 1);
});

// ---------- P: set the Local 1 company pricing config through the REAL pricing service (PATCH /pricing/config use case) ----------
const PRICING_AUDIT = 'COMPANY_PRICING_CONFIG_CHANGED';
const realServices = {
  createPricingService: (await tsImport('api/src/modules/pricing/pricing.service.ts')).createPricingService,
  createAuditLog: (await tsImport('api/src/shared/audit.ts')).createAuditLog,
  async releaseReservations() { throw new Error('not used'); },
};
function pricingWorld() {
  const d = world();
  d.location[0].companyId = 'co1'; d.location[1].companyId = 'co1';
  d.company = [{ id: 'co1', createdAt: new Date('2026-09-01T00:00:00Z') }];
  d.companyPricingConfig = [];
  return d;
}
const pricingCtx = (canonical = realServices) => ({ locationCode: 'PCEN', markerId: MARKER, owner: OWNER_ACCOUNT, canonical,
  approvedMigrations: APPROVED_MIGRATION_PAYLOAD.migrations, provenance: PROV });
const LOCAL1 = { listAdjustmentBps: 2500, creditCardAdjustmentBps: 2500, debitCardAdjustmentBps: 625, bankTransferAdjustmentBps: 1250, qrAdjustmentBps: 0 };

test('P01 set-pricing writes the five exact values through the real pricing service and audits COMPANY_PRICING_CONFIG_CHANGED once', async () => {
  const db = fakeDb(pricingWorld());
  const before = stockState(db.data);
  const r = await T.setPricingTransaction(db.tx, pricingCtx());
  assert.equal(r.action, 'PRICING_SET');
  assert.equal(db.data.companyPricingConfig.length, 1);
  const row = db.data.companyPricingConfig[0];
  for (const [k, v] of Object.entries(LOCAL1)) assert.equal(row[k], v, k);
  assert.equal(row.companyId, 'co1');
  const audits = db.data.auditLog.filter((a) => a.action === PRICING_AUDIT);
  assert.equal(audits.length, 1); assert.equal(db.data.auditLog.length, 1);
  assert.equal(audits[0].userId, OWNER_ACCOUNT.id); assert.equal(audits[0].branchId, null); assert.equal(audits[0].entityType, 'CompanyPricingConfig');
  assert.equal(audits[0].entityId, row.id);
  assert.deepEqual(audits[0].after, { CASH: 0, LIST: 2500, CREDIT_CARD: 2500, DEBIT_CARD: 625, BANK_TRANSFER: 1250, QR: 0 });
  assert.deepEqual(stockState(db.data), before, 'no catalog, sale, stock or cash row is touched');
  assert.deepEqual(db.raw, [T.SQL.ADVISORY_LOCK, MARKER_RECHECK_SQL, MIGRATIONS_SQL]);
  for (const [name, op] of db.writes) assert.ok((name === 'companyPricingConfig' && op === 'upsert') || (name === 'auditLog' && op === 'create'), `${name}.${op}`);
});

test('P02 set-pricing is idempotent: the same config is a NOOP with zero writes', async () => {
  const db = fakeDb(pricingWorld());
  await T.setPricingTransaction(db.tx, pricingCtx());
  const n = db.writes.length;
  assert.equal((await T.setPricingTransaction(db.tx, pricingCtx())).action, 'NOOP');
  assert.equal(db.writes.length, n);
});

const PRICING_CONFLICTS = {
  'two companies': (d) => { d.company.push({ id: 'co2', createdAt: new Date('2026-09-02T00:00:00Z') }); },
  'the company is not PCEN\'s': (d) => { d.location[0].companyId = 'other'; },
  'another config already holds different values': (d) => { d.companyPricingConfig.push({ id: 'cfg', companyId: 'co1', ...LOCAL1, debitCardAdjustmentBps: 0 }); },
  'a config of another company only': (d) => { d.companyPricingConfig.push({ id: 'cfg', companyId: 'co9', ...LOCAL1 }); },
  'PCEN is not an active retail branch': (d) => { d.location[0].isActive = false; },
  'the OWNER audit actor is inactive': (d) => { d.user[0].isActive = false; },
};
test('P03 set-pricing fails closed: one deviation → conflict, not a single write', async () => {
  for (const [label, mutate] of Object.entries(PRICING_CONFLICTS)) {
    const d = pricingWorld(); mutate(d);
    const db = fakeDb(d);
    await assert.rejects(T.setPricingTransaction(db.tx, pricingCtx()), (err) => err.phase === 'conflict', label);
    assert.deepEqual(db.writes, [], label);
  }
});

test('P04 set-pricing: a session that does not see the proven PILOT marker writes nothing; a service that writes more is rolled back', async () => {
  const db = fakeDb(pricingWorld(), { testGuard: true });
  await assert.rejects(T.setPricingTransaction(db.tx, pricingCtx()), (err) => err.phase === 'identity');
  assert.deepEqual(db.writes, []);
  const tampered = {
    ...realServices,
    createPricingService: (database) => {
      const service = realServices.createPricingService(database);
      return { ...service, updateConfig: async (userId, input) => service.updateConfig(userId, { ...input, QR: 1 }) };
    },
  };
  await assert.rejects(T.setPricingTransaction(fakeDb(pricingWorld()).tx, pricingCtx(tampered)), (err) => err.phase === 'verify');
});

test('P05 CLI: set-pricing takes no expectation arguments and its plan binds the exact Local 1 values', () => {
  assert.equal(T.parseCliArgs(['--dry-run', '--action=set-pricing', ...BASE, `--project-ref=${REF}`]).ok, true);
  assert.equal(T.parseCliArgs(['--dry-run', '--action=set-pricing', ...BASE, `--project-ref=${REF}`, ...RETIRE_EXPECT]).ok, false);
  assert.ok(T.ACTIONS.includes('set-pricing'));
  assert.deepEqual({ ...T.LOCAL1_PRICING_CONFIG }, { LIST: 2500, CREDIT_CARD: 2500, DEBIT_CARD: 625, BANK_TRANSFER: 1250, QR: 0 });
  const base = { action: 'set-pricing', locationCode: 'PCEN', markerId: MARKER, projectRef: REF, toolSha256: 'e'.repeat(64), expect: null };
  assert.notEqual(T.executionDigest(base), T.executionDigest({ ...base, action: 'deactivate-catalog' }));
});

test('P06 end to end: dry-run (offline) → authorize (TTY) → execute sets the config once; a second execute is refused', async () => {
  const h = harness({ db: fakeDb(pricingWorld()), deps: { loadCanonical: async () => realServices } });
  const argv = (mode, extra) => [`--${mode}`, '--action=set-pricing', ...BASE, ...extra];
  const pdig = T.executionDigest({ action: 'set-pricing', locationCode: 'PCEN', markerId: MARKER, projectRef: REF, toolSha256: 'e'.repeat(64), expect: null });
  assert.equal(await T.main(argv('dry-run', [`--project-ref=${REF}`]), { ...h.deps, readPrivateFile: () => { throw new Error('offline'); } }), 0, h.err.join('\n'));
  assert.match(h.out.join('\n'), new RegExp(`execution plan sha256: ${pdig}`));
  assert.match(h.out.join('\n'), /LIST 2500.*CREDIT_CARD 2500.*DEBIT_CARD 625.*BANK_TRANSFER 1250.*QR 0/);
  assert.equal(await T.main(argv('authorize', [`--project-ref=${REF}`, `--plan=${pdig}`, ...backupArgs]), h.deps), 0, h.err.join('\n'));
  const authId = /authorization id: ([0-9a-f]{32})/.exec(h.out.join('\n'))[1];
  const exec = argv('execute', [`--confirm-project-ref=${REF}`, `--plan=${pdig}`, ...backupArgs, `--authorization=${authId}`]);
  assert.equal(await T.main(exec, h.deps), 0, h.err.join('\n'));
  assert.equal(h.db.data.companyPricingConfig[0].debitCardAdjustmentBps, 625);
  assert.match(h.out.join('\n'), /pricing config set/);
  assert.equal(await T.main(exec, h.deps), 1);
});
