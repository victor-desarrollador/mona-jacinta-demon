// R3-A3.5 (R3 rev. 2 §5 "Otros endpoints") — DB-FREE. The REAL sales service and
// the REAL sales router run against tests/helpers/in-memory-sales-db.ts; nothing
// reaches a database.
//
// Two additive contracts so the POS can tell the two checkout paths apart:
//   GET /sales/pending   -> pricingModel + checkoutRequired per sale, derived
//                           ONLY from the persisted Sale.pricingModel.
//   PATCH /price-mode    -> a PROPORTIONAL_V1 sale accepts CASH and nothing
//                           else (409 PRICE_MODE_NOT_APPLICABLE), checked under
//                           the existing Sale lock, before any write.
//
// PRE-REGISTERED EXPECTATIONS
//   Q1 both models in one answer       -> DERIVE each flag from its own row
//   Q2 existing item contract          -> PRESERVE every field, ADD exactly two
//   Q3 branch joins the policy         -> PRESERVE checkoutRequired false
//   Q4 branch leaves the policy        -> PRESERVE checkoutRequired true
//   M1 PROPORTIONAL_V1 + 5 other modes -> DENY 409 PRICE_MODE_NOT_APPLICABLE,
//                                         zero writes, zero audit, under lock
//   M2 PROPORTIONAL_V1 + CASH          -> ALLOW, no write, no reprice, model intact
//   M3 FIXED_TOTAL + 5 historical modes-> ALLOW, reprices and audits as before
//   M4 FIXED_TOTAL same mode           -> ALLOW, no-op, no audit (historical)
//   M5 policy names a FIXED_TOTAL sale -> ALLOW (the guard reads the row, not the policy)
//   M6 the real route                  -> 409 with the stable code, no write
//   M7 source order                    -> lock, guard, then the first write
//
// Fidelity limits (by design): the in-memory store models no isolation level or
// race and does not model Sale.pricingModel's column default, so every row here
// is written with an explicit value.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express, { type Request } from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { createSalesRouter } from '../../src/modules/sales/sales.routes.js';
import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';

// Synthetic ids only; never a real branch, user or sale.
const L1 = '11111111-1111-4111-8111-111111111111';

type Role = 'SELLER' | 'CASHIER' | 'OWNER';

function assignment(role: Role, locationId: string | null): Express.ProductionAssignment {
  return {
    roleId: role, roleCode: role,
    scopeKind: locationId ? 'LOCATION' : 'COMPANY', locationId,
    permissions: role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[role]],
  };
}

function requestFor(userId: string, assignments: Express.ProductionAssignment[]): Request {
  const effectiveLocationIds = assignments.flatMap(({ locationId }) => (locationId ? [locationId] : []));
  return { auth: { userId, roles: assignments.map(({ roleCode }) => roleCode), assignments, effectiveLocationIds } } as unknown as Request;
}

// The exact item contract of GET /sales/pending: the 18 fields the POS already
// consumes plus the two R3-A3.5 additions. Nothing else, nothing renamed.
const PENDING_ITEM_KEYS = [
  'canAcceptPayment', 'canCancel', 'canConfirmWholesale', 'canCorrect', 'checkoutRequired',
  'holdState', 'items', 'paidAmount', 'paymentCount', 'priceMode', 'pricingMode', 'pricingModel',
  'remainingBalance', 'saleId', 'saleNumber', 'sellerName', 'status', 'subtotal', 'total',
  'wholesaleConfirmed',
];

const ALL_PRICE_MODES = ['CASH', 'LIST', 'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'QR'] as const;
const NON_CASH_MODES = ALL_PRICE_MODES.filter((mode) => mode !== 'CASH');

function setup() {
  const db = createInMemorySalesDb();
  db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  const companyId = db.table('company')[0]!.id as string;
  // LIST +1000 bps: switching a retail draft to LIST has to move the line, so
  // "no repriced" is observable and not an accident of a zero adjustment.
  db.insert('companyPricingConfig', { companyId, listAdjustmentBps: 1000 });
  db.insert('location', { id: L1, isActive: true });
  db.insert('branch', { id: L1, code: 'S1', name: 'Sucursal 1' });
  db.insert('saleNumberCounter', { branchId: L1, nextValue: 1n });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), cashier: user('cashier'), owner: user('owner') };
  const product = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const V1 = db.insert('productVariant', {
    productId: product, sku: 'V1', barcode: 'V1', cashPrice: 10000n, price: 10000n, wholesalePrice: null,
    costPrice: 1000n, color: 'Negro', size: 'V1',
  }).id as string;
  db.insert('inventory', { branchId: L1, variantId: V1, physical: 100n, reserved: 0n });
  const reqs = {
    seller: requestFor(ids.seller, [assignment('SELLER', L1)]),
    cashier: requestFor(ids.cashier, [assignment('CASHIER', L1)]),
    owner: requestFor(ids.owner, [assignment('OWNER', null)]),
  };
  const client = db.client as unknown as PrismaClient;
  // R3-A3.4 seam: the branch policy is only consulted at draft creation.
  const salesF = createSalesService(client, { proportionalCheckoutLocationIds: [] });
  const salesP = createSalesService(client, { proportionalCheckoutLocationIds: [L1] });

  const draft = async (sales: ReturnType<typeof createSalesService>, quantity = 2n) => {
    const created = await sales.createDraftSale(reqs.seller, ids.seller, L1);
    await sales.addItem(reqs.seller, ids.seller, created.id, { variantId: V1, quantity });
    return created.id;
  };
  // A sale the queue can list: DRAFT -> PENDING_PAYMENT with its hold coverage.
  const queued = async (sales: ReturnType<typeof createSalesService>) => {
    const saleId = await draft(sales);
    await sales.sendToCashier(saleId, ids.seller, [L1]);
    return saleId;
  };
  const queueRow = (pricingModel: string, createdAt: string) => db.insert('sale', {
    sellerId: ids.seller, branchId: L1, status: 'PENDING_PAYMENT', saleNumber: `Q-${randomUUID()}`,
    subtotal: 20000n, total: 20000n, pricingMode: 'LIST', priceMode: 'CASH', pricingModel,
    createdAt: new Date(createdAt), updatedAt: new Date(createdAt),
  }).id as string;
  const sale = (saleId: string) => db.table('sale').find((row) => row.id === saleId)!;
  const items = (saleId: string) => db.table('saleItem').filter((row) => row.saleId === saleId);
  const snapshot = (saleId: string) => items(saleId).map((item) => ({
    id: item.id, quantity: item.quantity, unitPrice: item.unitPrice, subtotal: item.subtotal,
    priceBaseType: item.priceBaseType, priceMode: item.priceMode, baseUnitPrice: item.baseUnitPrice,
    priceAdjustmentBps: item.priceAdjustmentBps,
  }));
  const audits = (action: string) => db.table('auditLog').filter((row) => row.action === action);
  const auditActions = () => db.table('auditLog').map((row) => row.action);
  return {
    db, ids, reqs, V1, salesF, salesP, draft, queued, queueRow, sale, items, snapshot, audits, auditActions,
    list: (sales: ReturnType<typeof createSalesService>) => sales.listPendingSales([L1], reqs.cashier.auth),
    rowOf: (rows: Array<{ saleId: string }>, saleId: string) => rows.find(({ saleId: id }) => id === saleId)!,
  };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected AppError ${status} ${code}`).toBeInstanceOf(AppError);
  expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status, code });
}

describe('Q — GET /sales/pending exposes the durable checkout path (req. 1, 2)', () => {
  it('Q1 reports each model side by side, derived from its own persisted row', async () => {
    const t = setup();
    const fixed = t.queueRow('FIXED_TOTAL', '2026-01-01T00:00:00.000Z');
    const proportional = t.queueRow('PROPORTIONAL_V1', '2026-01-01T00:00:01.000Z');
    const rows = await t.list(t.salesP);
    expect(rows.map(({ saleId }) => saleId)).toEqual([fixed, proportional]);
    expect(t.rowOf(rows, fixed)).toMatchObject({ pricingModel: 'FIXED_TOTAL', checkoutRequired: false });
    expect(t.rowOf(rows, proportional)).toMatchObject({ pricingModel: 'PROPORTIONAL_V1', checkoutRequired: true });
  });

  it('Q2 keeps every existing field and adds exactly the two new ones', async () => {
    const t = setup();
    const saleId = t.queueRow('FIXED_TOTAL', '2026-01-01T00:00:00.000Z');
    const [row] = await t.list(t.salesF);
    // The contract, pinned: nothing removed, nothing renamed.
    expect(Object.keys(row!).sort()).toEqual(PENDING_ITEM_KEYS);
    // Called directly, the service hands back the raw column values (bigint),
    // not the JSON strings the HTTP layer produces.
    expect(row).toMatchObject({
      saleId,
      saleNumber: t.sale(saleId).saleNumber,
      sellerName: 'seller',
      status: 'PENDING_PAYMENT',
      items: [],
      subtotal: 20000n,
      total: 20000n,
      paidAmount: 0n,
      remainingBalance: 20000n,
      holdState: 'COVERAGE_INVALID',
      canAcceptPayment: false,
      paymentCount: 0,
      // Historical Pricing V2 facts of the row, untouched.
      pricingMode: 'LIST',
      priceMode: 'CASH',
      wholesaleConfirmed: false,
      canConfirmWholesale: false,
      canCorrect: false,
      canCancel: true,
      pricingModel: 'FIXED_TOTAL',
      checkoutRequired: false,
    });
  });

  it('Q3 a FIXED_TOTAL sale stays FIXED_TOTAL when its branch joins the policy', async () => {
    const t = setup();
    // Created while the branch was NOT configured, so it is FIXED_TOTAL forever.
    const saleId = await t.queued(t.salesF);
    expect(t.sale(saleId).pricingModel).toBe('FIXED_TOTAL');
    // The operator now configures the branch; the listing service reads it.
    const [row] = await t.list(t.salesP);
    expect(row).toMatchObject({ saleId, pricingModel: 'FIXED_TOTAL', checkoutRequired: false, holdState: 'VALID' });
  });

  it('Q4 a PROPORTIONAL_V1 sale stays PROPORTIONAL_V1 when its branch leaves the policy', async () => {
    const t = setup();
    const saleId = await t.queued(t.salesP);
    expect(t.sale(saleId).pricingModel).toBe('PROPORTIONAL_V1');
    // The branch is unconfigured again; the listing service no longer names it.
    const [row] = await t.list(t.salesF);
    expect(row).toMatchObject({ saleId, pricingModel: 'PROPORTIONAL_V1', checkoutRequired: true, holdState: 'VALID' });
  });
});

describe('M — PATCH /price-mode guards a PROPORTIONAL_V1 sale (req. 3, 4, 5, 6, 7)', () => {
  it.each(NON_CASH_MODES)('M1 PROPORTIONAL_V1 rejects %s with 409 and no effects', async (mode) => {
    const t = setup();
    const saleId = await t.draft(t.salesP);
    const itemsBefore = t.snapshot(saleId);
    const actionsBefore = t.auditActions();
    const before = { priceMode: t.sale(saleId).priceMode, total: t.sale(saleId).total, pricingModel: t.sale(saleId).pricingModel };
    t.db.rawQueries.length = 0;

    await expectAppError(t.salesP.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, mode), 409, 'PRICE_MODE_NOT_APPLICABLE');

    // No write and no audit: the rejection happens before any effect.
    expect(t.sale(saleId)).toMatchObject(before);
    expect(t.snapshot(saleId)).toEqual(itemsBefore);
    expect(t.auditActions()).toEqual(actionsBefore);
    expect(t.audits('SALE_PRICE_MODE_CHANGED')).toHaveLength(0);
    // ... and it was decided on the locked row.
    const lock = t.db.rawQueries.find((sql) => sql.includes('FROM "Sale"'));
    expect(lock).toBeDefined();
    expect(lock).toContain('"pricingModel"');
    expect(lock).toContain('FOR UPDATE');
  });

  it('M2 PROPORTIONAL_V1 accepts CASH without writing, auditing or repricing', async () => {
    const t = setup();
    const saleId = await t.draft(t.salesP);
    const itemsBefore = t.snapshot(saleId);
    const actionsBefore = t.auditActions();

    const updated = await t.salesP.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, 'CASH');

    expect(updated).toMatchObject({ id: saleId, priceMode: 'CASH', pricingModel: 'PROPORTIONAL_V1', total: 20000n });
    // The CASH snapshot stays as written at item time (pricingModel untouched,
    // no recalculation as a consequence of this slice).
    expect(t.snapshot(saleId)).toEqual(itemsBefore);
    expect(t.snapshot(saleId)[0]).toMatchObject({ unitPrice: 10000n, baseUnitPrice: 10000n, priceMode: 'CASH' });
    expect(t.auditActions()).toEqual(actionsBefore);
  });

  it.each(NON_CASH_MODES)('M3 FIXED_TOTAL keeps the historical %s mode', async (mode) => {
    const t = setup();
    const saleId = await t.draft(t.salesF);

    const updated = await t.salesP.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, mode);

    expect(updated).toMatchObject({ id: saleId, priceMode: mode, pricingModel: 'FIXED_TOTAL' });
    expect(t.audits('SALE_PRICE_MODE_CHANGED')).toHaveLength(1);
    // LIST is the mode that moves the line (+1000 bps over the CASH base).
    if (mode === 'LIST') {
      expect(t.snapshot(saleId)[0]).toMatchObject({ unitPrice: 11000n, priceMode: 'LIST', baseUnitPrice: 10000n, priceAdjustmentBps: 1000 });
      expect(t.sale(saleId).total).toBe(22000n);
    } else {
      expect(t.snapshot(saleId)[0]).toMatchObject({ unitPrice: 10000n, priceMode: mode });
    }
  });

  it('M4 FIXED_TOTAL re-selecting its own mode stays the historical no-op', async () => {
    const t = setup();
    const saleId = await t.draft(t.salesF);
    const itemsBefore = t.snapshot(saleId);
    const actionsBefore = t.auditActions();

    const updated = await t.salesP.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, 'CASH');

    expect(updated).toMatchObject({ id: saleId, priceMode: 'CASH' });
    expect(t.snapshot(saleId)).toEqual(itemsBefore);
    expect(t.auditActions()).toEqual(actionsBefore);
  });

  it('M5 a FIXED_TOTAL sale is unaffected by the policy naming its branch', async () => {
    const t = setup();
    // Created before the branch was configured (FIXED_TOTAL), then listed and
    // patched by the service whose policy DOES name the branch.
    const saleId = await t.draft(t.salesF);
    expect(t.sale(saleId).pricingModel).toBe('FIXED_TOTAL');

    const updated = await t.salesP.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, 'LIST');

    expect(updated).toMatchObject({ priceMode: 'LIST', pricingModel: 'FIXED_TOTAL' });
    expect(t.snapshot(saleId)[0]).toMatchObject({ unitPrice: 11000n, baseUnitPrice: 10000n, priceAdjustmentBps: 1000 });
  });

  it('M6 the real route answers 409 PRICE_MODE_NOT_APPLICABLE without writing', async () => {
    const t = setup();
    const saleId = await t.draft(t.salesP);
    const actionsBefore = t.auditActions();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.auth = (t.reqs.seller as unknown as { auth: Express.AuthContext }).auth;
      next();
    });
    app.use('/sales', createSalesRouter(t.db.client as unknown as PrismaClient));
    app.use(errorHandler);

    const response = await supertest(app).patch(`/sales/${saleId}/price-mode`).send({ priceMode: 'LIST' });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: 'PRICE_MODE_NOT_APPLICABLE', message: expect.any(String) } });
    expect(t.sale(saleId)).toMatchObject({ priceMode: 'CASH', pricingModel: 'PROPORTIONAL_V1' });
    expect(t.auditActions()).toEqual(actionsBefore);
  });

  it('M7 the guard sits inside the existing transaction, between the lock and the first write', () => {
    const source = readFileSync(new URL('../../src/modules/sales/sales.service.ts', import.meta.url), 'utf8');
    const body = source.slice(
      source.indexOf('async function updatePriceMode('),
      source.indexOf('async function confirmWholesale('),
    );
    const lock = body.indexOf('lockDraft(tx, saleId)');
    const guard = body.indexOf('ensurePriceModeApplies(locked.pricingModel, priceMode)');
    const firstWrite = body.indexOf('tx.saleItem.update(');
    expect(lock).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(lock);
    expect(firstWrite).toBeGreaterThan(guard);
    // No new transaction: the check runs in the one that already existed.
    expect(body.match(/\$transaction\(/g) ?? []).toHaveLength(1);
    // Stable, documented code, declared once next to the other 409 helpers.
    expect(source).toContain("'PRICE_MODE_NOT_APPLICABLE'");
  });
});
