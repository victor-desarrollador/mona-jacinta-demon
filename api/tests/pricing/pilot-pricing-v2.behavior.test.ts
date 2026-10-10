// Pilot Pricing V2 behavior — DB-FREE. The REAL sales / payments /
// pending-correction / catalog-admin / pricing services and routers run
// against tests/helpers/in-memory-sales-db.ts; nothing reaches a database.
//
// PRE-REGISTERED EXPECTATIONS (2026-10-06, second set; the calculator-level
// P01-P26 live in pilot-pricing-v2.test.ts). Classes: ALLOW DENY FAIL_CLOSED
// DERIVE PRESERVE_SNAPSHOT NOT_APPLICABLE.
//   S01 retail, mode CASH            -> DERIVE unitPrice = cashPrice, snapshot (LIST tier, CASH, bps 0)
//   S02 retail, CREDIT_CARD +20%     -> DERIVE 12000 from cash 10000, snapshot bps 2000 + config provenance
//   S03 new draft defaults to CASH (owner 2026-10-06) even with LIST +10% -> DERIVE 10000; explicit LIST -> 11000
//   S03b server sets CASH itself; CASH-default sale refuses card payment, accepts CASH
//   S04 variant without cashPrice    -> FAIL_CLOSED 409 CASH_PRICE_MISSING, no item written
//   S05 wholesale 7000 + CREDIT_CARD +20% -> DERIVE 8400 (WHOLESALE tier snapshot)
//   S06 mode change before send      -> DERIVE every line + total atomically
//   S07 mode change, one line lacks base -> FAIL_CLOSED, nothing repriced
//   S08 config change after draft creation -> PRESERVE_SNAPSHOT until the seller re-selects
//   S09 mode change after send-to-cashier  -> DENY 409 SALE_NOT_DRAFT
//   S10 config change after first payment  -> PRESERVE_SNAPSHOT, total fixed, remaining payment OK
//   S11 CREDIT_CARD sale + CASH payment    -> FAIL_CLOSED 409, no payment row
//   S12 two partial CARD_CREDIT payments settle the fixed total -> ALLOW
//   S13 CARD_CREDIT then CASH (mixed attempt) -> FAIL_CLOSED, first payment kept
//   S14 LIST sale accepts CASH and CARD_CREDIT -> ALLOW (documented: LIST has no method twin)
//   S15 wholesale + card sale: payment before cashier confirmation -> DENY 409
//   S16 wholesale + card sale after confirmation pays at 8400 base-derived total -> ALLOW
//   S17 pending correction adds a line -> DERIVE in the sale's own tier + mode, snapshotted
//   S18 completed sale after config change -> PRESERVE_SNAPSHOT
//   S19 old row (null snapshot columns) quantity edit -> PRESERVE unitPrice, no throw
//   S20 other seller / WAREHOUSE changes mode -> DENY 403
//   S21 config PATCH: negative / above max / unknown key / CASH key / empty -> DENY 400
//   S22 config PATCH 0 and 10000 -> ALLOW; audited before/after
//   S23 /pricing/config: SELLER, CASHIER, WAREHOUSE, ADMIN LOCATION, legacy-only -> DENY 403;
//       ADMIN COMPANY, OWNER -> ALLOW
//   S24 getSnapshot with no config row -> DERIVE all-zero adjustments
//   S25 wholesale cash base above retail cash base (create or update) -> DENY/409
//   S26 migration static: additive only, new CHECKs present, no DML, no old-migration edit
//   S27 catalog reads expose cashPrice, never wholesalePrice -> DENY (asserted in block1 N26, which uses a select-honoring fixture)
//   S28 invalid priceMode value over HTTP -> DENY 400
//   S29 repeated same-mode selection is idempotent -> ALLOW, no extra audit
//   S30 very large valid cash base +100% stays exact -> DERIVE
import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import express, { type Request } from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { createSalesRouter } from '../../src/modules/sales/sales.routes.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';
import { createPendingCorrectionService } from '../../src/modules/sales/pending-correction.service.js';
import { createCatalogAdminService } from '../../src/modules/products/catalog-admin.service.js';
import { createVariantSchema } from '../../src/modules/products/dto/variant.dto.js';
import { createWholesaleCodeVerifier } from '../../src/modules/sales/wholesale-authorization.service.js';
import { createPricingService } from '../../src/modules/pricing/pricing.service.js';
import { createPricingRouter } from '../../src/modules/pricing/pricing.routes.js';
import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';

const CODE = 'Mayor-2026';
const CODE_HASH = await hash(CODE, 4);

type Role = 'SELLER' | 'CASHIER' | 'WAREHOUSE' | 'ADMIN';

function assignment(role: Role | 'OWNER', locationId: string | null): Express.ProductionAssignment {
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

function setup() {
  const db = createInMemorySalesDb();
  db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  const L1 = db.insert('location', { isActive: true }).id as string;
  db.insert('branch', { id: L1, code: 'S1', name: 'Sucursal 1' });
  db.insert('saleNumberCounter', { branchId: L1, nextValue: 1n });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), seller2: user('seller2'), cashier: user('cashier'), warehouse: user('warehouse'), owner: user('owner'), admin: user('admin') };
  const product = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const variant = (sku: string, cashPrice: bigint | null, wholesalePrice: bigint | null) =>
    db.insert('productVariant', { productId: product, sku, barcode: sku, cashPrice, price: cashPrice ?? 5000n, wholesalePrice, costPrice: 1000n, color: 'Negro', size: sku }).id as string;
  const V1 = variant('V1', 10000n, 7000n);
  const V2 = variant('V2', 5000n, null);
  const VNULL = variant('VNULL', null, null);
  for (const variantId of [V1, V2, VNULL]) db.insert('inventory', { branchId: L1, variantId, physical: 100n, reserved: 0n });
  const registerId = db.insert('cashRegister', { branchId: L1, name: 'Caja' }).id as string;
  db.insert('cashSession', { registerId, openedById: ids.cashier, startingCash: 0n, status: 'OPEN' });
  const reqs = {
    seller: requestFor(ids.seller, [assignment('SELLER', L1)]),
    seller2: requestFor(ids.seller2, [assignment('SELLER', L1)]),
    cashier: requestFor(ids.cashier, [assignment('CASHIER', L1)]),
    warehouse: requestFor(ids.warehouse, [assignment('WAREHOUSE', L1)]),
    owner: requestFor(ids.owner, [assignment('OWNER', null)]),
    adminCompany: requestFor(ids.admin, [assignment('ADMIN', null)]),
    adminLocation: requestFor(ids.admin, [assignment('ADMIN', L1)]),
    legacyOnly: requestFor(randomUUID(), []),
  };
  const client = db.client as unknown as PrismaClient;
  const sales = createSalesService(client, { wholesaleVerifier: createWholesaleCodeVerifier(CODE_HASH) });
  const payments = createPaymentsService(client);
  const correction = createPendingCorrectionService(client);
  const catalog = createCatalogAdminService(client);
  const pricing = createPricingService(client);

  async function draft(items: Array<[string, bigint]> = [[V1, 2n]], mode?: 'CASH' | 'LIST' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'BANK_TRANSFER' | 'QR') {
    const created = await sales.createDraftSale(reqs.seller, ids.seller, L1);
    for (const [variantId, quantity] of items) await sales.addItem(reqs.seller, ids.seller, created.id, { variantId, quantity });
    if (mode) await sales.updatePriceMode(reqs.seller, ids.seller, created.id, mode);
    return created.id;
  }
  const send = (saleId: string) => sales.sendToCashier(saleId, ids.seller, [L1]);
  async function pay(saleId: string, method: string, amount?: bigint) {
    const total = db.table('sale').find((row) => row.id === saleId)!.total as bigint;
    const value = amount ?? total;
    return payments.registerPayment(reqs.cashier, ids.cashier, saleId, {
      method, amount: value, receivedAmount: method === 'CASH' ? value : null, idempotencyKey: randomUUID(),
    } as never);
  }
  const sale = (saleId: string) => db.table('sale').find((row) => row.id === saleId)!;
  const items = (saleId: string) => db.table('saleItem').filter((row) => row.saleId === saleId);
  const first = (saleId: string) => {
    const row = items(saleId)[0];
    if (!row) throw new Error('expected a sale item');
    return row;
  };
  const audits = (action: string) => db.table('auditLog').filter((row) => row.action === action);
  const config = (patch: Parameters<typeof pricing.updateConfig>[1]) => pricing.updateConfig(ids.owner, patch);
  return { db, L1, ids, reqs, V1, V2, VNULL, sales, payments, correction, catalog, pricing, draft, send, pay, sale, items, first, audits, config, client };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected AppError ${status} ${code}`).toBeInstanceOf(AppError);
  expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status: status, code });
}

describe('Pilot Pricing V2 — retail derivation and snapshot', () => {
  it('S01 CASH mode prices at the retail cash base with an explanatory snapshot', async () => {
    const t = setup();
    await t.config({ CREDIT_CARD: 2000, LIST: 1000 });
    const saleId = await t.draft([[t.V1, 2n]], 'CASH');
    expect(t.first(saleId)).toMatchObject({
      unitPrice: 10000n, subtotal: 20000n, priceBaseType: 'LIST', priceMode: 'CASH', baseUnitPrice: 10000n, priceAdjustmentBps: 0,
    });
    expect(t.sale(saleId)).toMatchObject({ priceMode: 'CASH', total: 20000n });
  });

  it('S02 CREDIT_CARD adds the company adjustment; snapshot records config provenance', async () => {
    const t = setup();
    const cfg = await t.config({ CREDIT_CARD: 2000 });
    const saleId = await t.draft([[t.V1, 2n]], 'CREDIT_CARD');
    expect(t.first(saleId)).toMatchObject({
      unitPrice: 12000n, subtotal: 24000n, priceMode: 'CREDIT_CARD', baseUnitPrice: 10000n, priceAdjustmentBps: 2000, pricingConfigId: cfg.id,
    });
    expect(t.sale(saleId).total).toBe(24000n);
  });

  it('S03 a new draft defaults to CASH even when LIST carries an adjustment; LIST is an explicit choice', async () => {
    const t = setup();
    await t.config({ LIST: 1000, CREDIT_CARD: 2000 });
    const saleId = await t.draft([[t.V1, 1n]]);
    expect(t.sale(saleId).priceMode).toBe('CASH');
    expect(t.first(saleId)).toMatchObject({ unitPrice: 10000n, priceMode: 'CASH', priceAdjustmentBps: 0 });
    await t.sales.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, 'LIST');
    expect(t.first(saleId)).toMatchObject({ unitPrice: 11000n, priceMode: 'LIST', priceAdjustmentBps: 1000 });
  });

  it('S03b the default never depends on the database default: a store defaulting to LIST still yields CASH', async () => {
    const t = setup();
    await t.config({ LIST: 1000 });
    const saleId = await t.draft([[t.V1, 1n]]);
    expect(t.audits('SALE_CREATED')).toHaveLength(1);
    expect(t.sale(saleId).priceMode).toBe('CASH');
    // A CASH-default sale pays by CASH and is rejected for a card (single mode).
    await t.send(saleId);
    await expectAppError(t.pay(saleId, 'CARD_CREDIT'), 409, 'PAYMENT_METHOD_PRICE_MODE_CONFLICT');
    expect(await t.pay(saleId, 'CASH')).toMatchObject({ resultingStatus: 'PAID' });
  });

  it('S04 a variant without a cash base fails closed and writes nothing', async () => {
    const t = setup();
    const created = await t.sales.createDraftSale(t.reqs.seller, t.ids.seller, t.L1);
    await expectAppError(t.sales.addItem(t.reqs.seller, t.ids.seller, created.id, { variantId: t.VNULL, quantity: 1n }), 409, 'CASH_PRICE_MISSING');
    expect(t.items(created.id)).toHaveLength(0);
  });

  it('S24 with no configuration row every adjustment is zero (deterministic)', async () => {
    const t = setup();
    expect((await t.pricing.getSnapshot()).adjustmentsBps).toEqual({ CASH: 0, LIST: 0, CREDIT_CARD: 0, DEBIT_CARD: 0, BANK_TRANSFER: 0, QR: 0 });
    const saleId = await t.draft([[t.V1, 1n]], 'QR');
    expect(t.first(saleId)).toMatchObject({ unitPrice: 10000n, priceAdjustmentBps: 0 });
  });

  it('S30 a very large valid cash base stays exact at +100%', async () => {
    const t = setup();
    await t.config({ QR: 10000 });
    const big = 4_500_000_000_000_001n;
    t.db.table('productVariant').find((row) => row.id === t.V2)!.cashPrice = big;
    const saleId = await t.draft([[t.V2, 1n]], 'QR');
    expect(t.first(saleId).unitPrice).toBe(big * 2n);
  });
});

describe('Pilot Pricing V2 — wholesale base', () => {
  it('S05 wholesale cash base + CREDIT_CARD adjustment (owner example scaled)', async () => {
    const t = setup();
    await t.config({ CREDIT_CARD: 2000 });
    t.db.table('productVariant').find((row) => row.id === t.V1)!.wholesalePrice = 70000n;
    t.db.table('productVariant').find((row) => row.id === t.V1)!.cashPrice = 100000n;
    const saleId = await t.draft([[t.V1, 1n]], 'CREDIT_CARD');
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    expect(t.first(saleId)).toMatchObject({ unitPrice: 84000n, priceBaseType: 'WHOLESALE', baseUnitPrice: 70000n, priceMode: 'CREDIT_CARD' });
    expect(t.sale(saleId).total).toBe(84000n);
  });

  it('S15 + S16 wholesale card sale needs cashier confirmation before any payment, then settles', async () => {
    const t = setup();
    await t.config({ CREDIT_CARD: 2000 });
    const saleId = await t.draft([[t.V1, 1n]], 'CREDIT_CARD');
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    await t.send(saleId);
    await expectAppError(t.pay(saleId, 'CARD_CREDIT'), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
    expect(t.db.table('salePayment')).toHaveLength(0);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    const paid = await t.pay(saleId, 'CARD_CREDIT');
    expect(paid).toMatchObject({ resultingStatus: 'PAID' });
    expect(t.sale(saleId).total).toBe(8400n);
  });

  it('S14b selecting a new mode on a wholesale draft keeps the wholesale base', async () => {
    const t = setup();
    await t.config({ DEBIT_CARD: 1000 });
    const saleId = await t.draft([[t.V1, 1n]]);
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    await t.sales.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, 'DEBIT_CARD');
    expect(t.first(saleId)).toMatchObject({ unitPrice: 7700n, priceBaseType: 'WHOLESALE', baseUnitPrice: 7000n });
    expect(t.sale(saleId)).toMatchObject({ pricingMode: 'WHOLESALE', wholesaleConfirmedAt: null });
  });
});

describe('Pilot Pricing V2 — sale price-mode lifecycle', () => {
  it('S06 changing the mode in DRAFT reprices every line and the total', async () => {
    const t = setup();
    await t.config({ BANK_TRANSFER: 500 });
    const saleId = await t.draft([[t.V1, 2n], [t.V2, 1n]]);
    await t.sales.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, 'BANK_TRANSFER');
    expect(t.items(saleId).map((row) => row.unitPrice).sort()).toEqual([10500n, 5250n].sort());
    expect(t.sale(saleId)).toMatchObject({ priceMode: 'BANK_TRANSFER', total: 26250n });
    expect(t.audits('SALE_PRICE_MODE_CHANGED')).toHaveLength(1);
  });

  it('S07 a line whose base disappeared aborts the whole repricing', async () => {
    const t = setup();
    await t.config({ QR: 1000 });
    const saleId = await t.draft([[t.V1, 1n], [t.V2, 1n]]);
    t.db.table('productVariant').find((row) => row.id === t.V2)!.cashPrice = null;
    await expectAppError(t.sales.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, 'QR'), 409, 'CASH_PRICE_MISSING');
    expect(t.sale(saleId).priceMode).toBe('CASH');
    expect(t.items(saleId).every((row) => row.priceMode === 'CASH')).toBe(true);
    expect(t.audits('SALE_PRICE_MODE_CHANGED')).toHaveLength(0);
  });

  it('S08 a config change after draft creation keeps existing line snapshots', async () => {
    const t = setup();
    await t.config({ CREDIT_CARD: 2000 });
    const saleId = await t.draft([[t.V1, 1n]], 'CREDIT_CARD');
    await t.config({ CREDIT_CARD: 3000 });
    expect(t.first(saleId)).toMatchObject({ unitPrice: 12000n, priceAdjustmentBps: 2000 });
    await t.sales.updateItem(t.reqs.seller, t.ids.seller, saleId, t.first(saleId).id as string, { quantity: 3n });
    expect(t.first(saleId)).toMatchObject({ unitPrice: 12000n, subtotal: 36000n });
  });

  it('S09 once sent to the cashier the mode can no longer change', async () => {
    const t = setup();
    const saleId = await t.draft();
    await t.send(saleId);
    await expectAppError(t.sales.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, 'QR'), 409, 'SALE_NOT_DRAFT');
    expect(t.sale(saleId).priceMode).toBe('CASH');
  });

  it('S10 a config change after the first payment never moves the fixed total', async () => {
    const t = setup();
    await t.config({ CREDIT_CARD: 2000 });
    const saleId = await t.draft([[t.V1, 2n]], 'CREDIT_CARD');
    await t.send(saleId);
    await t.pay(saleId, 'CARD_CREDIT', 10000n);
    await t.config({ CREDIT_CARD: 9000 });
    expect(t.sale(saleId).total).toBe(24000n);
    expect(t.first(saleId).unitPrice).toBe(12000n);
    expect(await t.pay(saleId, 'CARD_CREDIT', 14000n)).toMatchObject({ resultingStatus: 'PAID' });
  });

  it('S18 a completed sale is untouched by later configuration changes', async () => {
    const t = setup();
    await t.config({ QR: 500 });
    const saleId = await t.draft([[t.V1, 1n]], 'QR');
    await t.send(saleId);
    await t.pay(saleId, 'QR');
    await t.sales.completeSale(t.reqs.cashier, t.ids.cashier, saleId);
    await t.config({ QR: 10000 });
    expect(t.sale(saleId)).toMatchObject({ status: 'COMPLETED', total: 10500n });
    expect(t.first(saleId)).toMatchObject({ unitPrice: 10500n, priceAdjustmentBps: 500 });
  });

  it('S19 a pre-migration row with null snapshot columns still edits without error', async () => {
    const t = setup();
    const saleId = await t.draft([[t.V1, 1n]]);
    const row = t.first(saleId);
    Object.assign(row, { priceBaseType: null, priceMode: null, baseUnitPrice: null, priceAdjustmentBps: null, pricingConfigId: null, pricingConfigUpdatedAt: null });
    await t.sales.updateItem(t.reqs.seller, t.ids.seller, saleId, row.id as string, { quantity: 4n });
    expect(t.first(saleId)).toMatchObject({ unitPrice: 10000n, subtotal: 40000n, priceMode: null });
  });

  it('S20 only the sale\'s own seller can select the mode', async () => {
    const t = setup();
    const saleId = await t.draft();
    await expectAppError(t.sales.updatePriceMode(t.reqs.seller2, t.ids.seller2, saleId, 'QR'), 403, 'FORBIDDEN');
    await expectAppError(t.sales.updatePriceMode(t.reqs.warehouse, t.ids.warehouse, saleId, 'QR'), 403, 'FORBIDDEN');
    expect(t.sale(saleId).priceMode).toBe('CASH');
  });

  it('S29 re-selecting the current mode is a no-op', async () => {
    const t = setup();
    const saleId = await t.draft([[t.V1, 1n]], 'QR');
    await t.sales.updatePriceMode(t.reqs.seller, t.ids.seller, saleId, 'QR');
    expect(t.audits('SALE_PRICE_MODE_CHANGED')).toHaveLength(1);
  });

  it('S17 a line added by pending correction takes the sale\'s tier, mode and snapshot', async () => {
    const t = setup();
    await t.config({ DEBIT_CARD: 1000 });
    const saleId = await t.draft([[t.V1, 1n]], 'DEBIT_CARD');
    await t.send(saleId);
    await t.correction.correctPendingSale(t.reqs.cashier, saleId, { items: [{ variantId: t.V1, quantity: 1n }, { variantId: t.V2, quantity: 2n }] } as never);
    const added = t.items(saleId).find((row) => row.variantId === t.V2)!;
    expect(added).toMatchObject({ unitPrice: 5500n, priceMode: 'DEBIT_CARD', priceBaseType: 'LIST', baseUnitPrice: 5000n });
    expect(t.sale(saleId).total).toBe(11000n + 11000n);
  });
});

describe('Pilot Pricing V2 — payment compatibility (one price mode per sale)', () => {
  it('S11 a payment method that implies another mode is refused with no side effects', async () => {
    const t = setup();
    await t.config({ CREDIT_CARD: 2000 });
    const saleId = await t.draft([[t.V1, 1n]], 'CREDIT_CARD');
    await t.send(saleId);
    await expectAppError(t.pay(saleId, 'CASH'), 409, 'PAYMENT_METHOD_PRICE_MODE_CONFLICT');
    expect(t.db.table('salePayment')).toHaveLength(0);
    expect(t.sale(saleId).status).toBe('PENDING_PAYMENT');
  });

  it('S12 several partial payments of the same mode settle the fixed total', async () => {
    const t = setup();
    await t.config({ CREDIT_CARD: 2000 });
    const saleId = await t.draft([[t.V1, 2n]], 'CREDIT_CARD');
    await t.send(saleId);
    await t.pay(saleId, 'CARD_CREDIT', 4000n);
    await t.pay(saleId, 'CARD_CREDIT', 8000n);
    expect(await t.pay(saleId, 'CARD_CREDIT', 12000n)).toMatchObject({ resultingStatus: 'PAID' });
    expect(t.db.table('salePayment')).toHaveLength(3);
  });

  it('S13 a mixed attempt (credit then cash) fails closed and keeps the first payment', async () => {
    const t = setup();
    await t.config({ CREDIT_CARD: 2000 });
    const saleId = await t.draft([[t.V1, 2n]], 'CREDIT_CARD');
    await t.send(saleId);
    await t.pay(saleId, 'CARD_CREDIT', 4000n);
    await expectAppError(t.pay(saleId, 'CASH', 20000n), 409, 'PAYMENT_METHOD_PRICE_MODE_CONFLICT');
    expect(t.db.table('salePayment')).toHaveLength(1);
  });

  it('S14 an explicitly selected LIST mode (no method twin) accepts cash and card settlement', async () => {
    const t = setup();
    const saleId = await t.draft([[t.V1, 2n]], 'LIST');
    await t.send(saleId);
    await t.pay(saleId, 'CASH', 10000n);
    expect(await t.pay(saleId, 'CARD_CREDIT', 10000n)).toMatchObject({ resultingStatus: 'PAID' });
  });

  it.each([['DEBIT_CARD', 'CARD_DEBIT'], ['BANK_TRANSFER', 'TRANSFER'], ['QR', 'QR'], ['CASH', 'CASH']] as const)(
    'S14c %s sale is settled by %s',
    async (mode, method) => {
      const t = setup();
      const saleId = await t.draft([[t.V1, 1n]], mode);
      await t.send(saleId);
      expect(await t.pay(saleId, method)).toMatchObject({ resultingStatus: 'PAID' });
    },
  );
});

describe('Pilot Pricing V2 — company pricing configuration', () => {
  it('S21 invalid adjustments are rejected by the service and write nothing', async () => {
    const t = setup();
    for (const bad of [-1, 10001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expectAppError(t.config({ QR: bad }), 400, 'INVALID_PRICE_ADJUSTMENT');
    }
    await expectAppError(t.config({}), 400, 'PRICE_CONFIG_EMPTY_UPDATE');
    expect(t.db.table('companyPricingConfig')).toHaveLength(0);
  });

  it('S22 boundary values 0 and 10000 are accepted and audited with before/after', async () => {
    const t = setup();
    await t.config({ QR: 10000, LIST: 0 });
    const after = await t.config({ QR: 0 });
    expect(after.adjustmentsBps).toMatchObject({ QR: 0, LIST: 0 });
    const logs = t.audits('COMPANY_PRICING_CONFIG_CHANGED');
    expect(logs).toHaveLength(2);
    expect(logs[1]?.before).toMatchObject({ QR: 10000 });
    expect(logs[1]?.after).toMatchObject({ QR: 0 });
    expect(t.db.table('companyPricingConfig')).toHaveLength(1);
  });

  describe('HTTP /pricing/config', () => {
    function http(t: ReturnType<typeof setup>) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        req.auth = (t.reqs[req.header('x-test-user') as keyof typeof t.reqs] as unknown as { auth: Express.AuthContext }).auth;
        next();
      });
      app.use('/pricing', createPricingRouter(t.client));
      app.use(errorHandler);
      return supertest(app);
    }

    it('S23 only COMPANY price managers read or write', async () => {
      const t = setup();
      const api = http(t);
      for (const who of ['seller', 'cashier', 'warehouse', 'adminLocation', 'legacyOnly']) {
        expect((await api.get('/pricing/config').set('x-test-user', who)).status, `${who} GET`).toBe(403);
        expect((await api.patch('/pricing/config').set('x-test-user', who).send({ QR: 100 })).status, `${who} PATCH`).toBe(403);
      }
      expect(t.db.table('companyPricingConfig')).toHaveLength(0);
      for (const who of ['adminCompany', 'owner']) {
        const patched = await api.patch('/pricing/config').set('x-test-user', who).send({ QR: 100 });
        expect(patched.status, who).toBe(200);
        const read = await api.get('/pricing/config').set('x-test-user', who);
        expect(read.body.config.adjustmentsBps).toMatchObject({ CASH: 0, QR: 100 });
      }
    });

    it('S21b DTO rejects negative, over-max, CASH, unknown and empty bodies', async () => {
      const t = setup();
      const api = http(t);
      for (const body of [{ QR: -1 }, { QR: 10001 }, { QR: 1.5 }, { QR: '10' }, { CASH: 5 }, { BOGUS: 1 }, {}]) {
        expect((await api.patch('/pricing/config').set('x-test-user', 'owner').send(body)).status, JSON.stringify(body)).toBe(400);
      }
      expect(t.db.table('companyPricingConfig')).toHaveLength(0);
    });
  });
});

describe('Pilot Pricing V2 — sale price-mode route', () => {
  it('S28 invalid or extra body fields are rejected; a valid mode reprices', async () => {
    const t = setup();
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.auth = (t.reqs.seller as unknown as { auth: Express.AuthContext }).auth; next(); });
    app.use('/sales', createSalesRouter(t.client, undefined, { wholesaleVerifier: createWholesaleCodeVerifier(CODE_HASH) }));
    app.use(errorHandler);
    const api = supertest(app);
    await t.config({ QR: 1000 });
    const saleId = await t.draft([[t.V1, 1n]]);
    for (const body of [{ priceMode: 'GOLD' }, { priceMode: 'QR', unitPrice: '1' }, {}, { priceMode: 'qr' }]) {
      expect((await api.patch(`/sales/${saleId}/price-mode`).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    const ok = await api.patch(`/sales/${saleId}/price-mode`).send({ priceMode: 'QR' });
    expect(ok.status).toBe(200);
    expect(ok.body.total).toBe('11000');
    expect(ok.text).not.toContain(CODE);
  });
});

describe('Pilot Pricing V2 — catalog base invariants and confidentiality', () => {
  it('S25 wholesale cash base may never exceed the retail cash base', async () => {
    const t = setup();
    // V1 cash 10000 / wholesale 7000; raise the legacy LIST price so only the cash rule can fire.
    await t.catalog.updateVariantPrice(t.ids.owner, t.V1, { price: 20000n });
    await expectAppError(t.catalog.updateVariantPrice(t.ids.owner, t.V1, { wholesalePrice: 10001n }), 409, 'WHOLESALE_PRICE_ABOVE_CASH');
    await expectAppError(t.catalog.updateVariantPrice(t.ids.owner, t.V1, { cashPrice: 6999n }), 409, 'WHOLESALE_PRICE_ABOVE_CASH');
    expect(t.db.table('productVariant').find((row) => row.id === t.V1)).toMatchObject({ cashPrice: 10000n, wholesalePrice: 7000n });
    expect(await t.catalog.updateVariantPrice(t.ids.owner, t.V1, { wholesalePrice: 10000n })).toMatchObject({ wholesalePrice: 10000n });
    const base = { productId: randomUUID(), sku: 'N1', barcode: 'N1', price: '9000', costPrice: '1' };
    expect(createVariantSchema.safeParse({ ...base, cashPrice: '5000', wholesalePrice: '5001' }).success).toBe(false);
    expect(createVariantSchema.safeParse({ ...base, cashPrice: '5000', wholesalePrice: '5000' }).success).toBe(true);
  });
});

describe('Pilot Pricing V2 — migration (static)', () => {
  const dir = new URL('../../prisma/migrations/20261006120000_pilot_pricing_v2/', import.meta.url);
  const sql = readFileSync(new URL('migration.sql', dir), 'utf8');
  const code = sql.replace(/--.*$/gm, '');

  it('S26 is additive: no DML, drops, renames or type rewrites; existing columns untouched', () => {
    expect(code).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|DROP)\b/gim);
    // The only column alteration allowed: the default of the column THIS migration adds.
    expect(code.match(/ALTER COLUMN[^;]*/gi)).toEqual([`ALTER COLUMN "priceMode" SET DEFAULT 'CASH'`]);
    expect(code).not.toMatch(/RENAME|DROP COLUMN/i);
    expect(code).toContain('ADD COLUMN "cashPrice" BIGINT;');
    // Backfill stamps pre-existing sales LIST; only afterwards do NEW sales default to CASH.
    const backfill = code.indexOf(`"priceMode" "CustomerPriceMode" NOT NULL DEFAULT 'LIST'`);
    const newDefault = code.indexOf(`ALTER COLUMN "priceMode" SET DEFAULT 'CASH'`);
    expect(backfill).toBeGreaterThan(-1);
    expect(newDefault).toBeGreaterThan(backfill);
    expect(readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8')).toMatch(/\n {2}priceMode\s+CustomerPriceMode @default\(CASH\)/);
  });

  it('S26b carries every integrity CHECK: cash positive, wholesale <= cash, snapshot shape, bps bounds', () => {
    expect(code).toContain('chk_product_variant_cash_price_positive');
    expect(code).toContain('chk_product_variant_wholesale_not_above_cash');
    expect(code).toContain('chk_sale_item_pricing_snapshot_consistency');
    expect(code).toContain('chk_company_pricing_config_bps_bounds');
    expect(code).toMatch(/"qrAdjustmentBps" >= 0 AND "qrAdjustmentBps" <= 10000/);
  });
});

// D5I-B2B1 — pricing.getSnapshot(tx). DB-FREE fakes: the OUTER delegates throw
// loudly so a pass proves the supplied transaction client served BOTH reads.
//   X01 getSnapshot() outside a transaction still uses the outer client for both reads -> EXPECTED_UNCHANGED
//   X02 getSnapshot(tx) uses tx for company AND companyPricingConfig, outer never -> FAIL before, PASS after
//   X03 getSnapshot(tx) without a company on tx -> 409 COMPANY_NOT_CONFIGURED, config never read -> EXPECTED_FAIL_CLOSED
//   X04 getSnapshot(tx) with no config row on tx -> all-zero snapshot -> EXPECTED_PASS after
//   X04b getSnapshot(tx) never opens a $transaction -> EXPECTED_PASS
describe('D5I-B2B1 — pricing.getSnapshot transaction binding', () => {
  const loud = (name: string) => ({
    findFirst: async () => { throw new Error(`OUTER_${name}_USED`); },
    findUnique: async () => { throw new Error(`OUTER_${name}_USED`); },
  });
  const fake = (company: { id: string } | null, config: Record<string, unknown> | null, calls: string[] = []) => ({
    company: { findFirst: async () => { calls.push('company'); return company; } },
    companyPricingConfig: { findUnique: async () => { calls.push('config'); return config; } },
  });
  const configRow = {
    id: 'cfg', companyId: 'c', updatedAt: new Date(0), listAdjustmentBps: 1000, creditCardAdjustmentBps: 2000,
    debitCardAdjustmentBps: 0, bankTransferAdjustmentBps: 0, qrAdjustmentBps: 0,
  };

  it('X01 without a transaction client both reads use the outer client', async () => {
    const calls: string[] = [];
    const outer = { ...fake({ id: 'c' }, configRow, calls), $transaction: async () => { throw new Error('NESTED'); } };
    const snapshot = await createPricingService(outer as never).getSnapshot();
    expect(calls).toEqual(['company', 'config']);
    expect(snapshot.adjustmentsBps.LIST).toBe(1000);
  });

  it('X02 getSnapshot(tx) serves BOTH reads from tx and never touches the outer delegates', async () => {
    const calls: string[] = [];
    const outer = { company: loud('COMPANY'), companyPricingConfig: loud('CONFIG'), $transaction: async () => { throw new Error('NESTED'); } };
    const snapshot = await createPricingService(outer as never).getSnapshot(fake({ id: 'c' }, configRow, calls) as never);
    expect(calls).toEqual(['company', 'config']);
    expect(snapshot).toMatchObject({ id: 'cfg', adjustmentsBps: { CASH: 0, LIST: 1000, CREDIT_CARD: 2000 } });
  });

  it('X03 getSnapshot(tx) with no company fails closed from tx and never reads the config', async () => {
    const calls: string[] = [];
    const outer = { company: loud('COMPANY'), companyPricingConfig: loud('CONFIG'), $transaction: async () => undefined };
    await expectAppError(createPricingService(outer as never).getSnapshot(fake(null, configRow, calls) as never), 409, 'COMPANY_NOT_CONFIGURED');
    expect(calls).toEqual(['company']);
  });

  it('X04 getSnapshot(tx) with no config row yields the all-zero snapshot', async () => {
    const outer = { company: loud('COMPANY'), companyPricingConfig: loud('CONFIG'), $transaction: async () => undefined };
    const snapshot = await createPricingService(outer as never).getSnapshot(fake({ id: 'c' }, null) as never);
    expect(snapshot).toMatchObject({ id: null, updatedAt: null });
    expect(Object.values(snapshot.adjustmentsBps).every((bps) => bps === 0)).toBe(true);
  });
});
