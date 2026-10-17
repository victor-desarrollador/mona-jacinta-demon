// R3-A3.4 (R3 rev. 2 §1 "Un solo selector de camino" and §5 "Política de
// sucursales") — DB-FREE. The REAL sales and payments services and the REAL
// /payments router run against tests/helpers/in-memory-sales-db.ts; nothing
// reaches a database.
//
// The durable path selector: PROPORTIONAL_CHECKOUT_LOCATION_IDS is validated at
// startup and read ONLY by createDraftSale, which fixes Sale.pricingModel once,
// at creation. Every later path decides from that persisted column, read under
// the sale lock. The variable is never consulted again.
//
// PRE-REGISTERED EXPECTATIONS
//   P1 absent / empty / whitespace-only -> ALLOW, zero branches enabled
//   P2 comma-separated Location UUIDs   -> ALLOW, every segment trimmed
//   P3 an empty segment (,UUID / UUID, / -> FAIL_CLOSED at startup: the comma is
//      UUID,,UUID / UUID, ,UUID)           a separator and empty segments are kept
//   P4 malformed entry                  -> FAIL_CLOSED at startup, never echoed
//   S1 branch named by the policy       -> DERIVE pricingModel = PROPORTIONAL_V1
//   S2 any other branch                 -> DERIVE pricingModel = FIXED_TOTAL
//   S3 no branch configured             -> DERIVE FIXED_TOTAL, SALE_CREATED audit unchanged
//   S4 policy changed after creation    -> PRESERVE the persisted model, both directions
//   S5 read site                        -> ONLY config/env.ts + modules/sales/sales.service.ts
//   C1 PROPORTIONAL_V1 through /payments -> DENY 409 CHECKOUT_REQUIRED, zero effects
//   C2 decision site                    -> persisted column, read FOR UPDATE
//   C3 FIXED_TOTAL CASH payment         -> ALLOW, PAID (historical path byte-for-byte)
//   C4 FIXED_TOTAL credit + QR partials -> ALLOW, PAID (historical path byte-for-byte)
//   C5 FIXED_TOTAL PAID completion      -> ALLOW, COMPLETED (historical path byte-for-byte)
//   C6 the real route                   -> 409 CHECKOUT_REQUIRED, no payment row
//
// Fidelity limits (by design): the in-memory store models no isolation level or
// race, and does not model the column default of Sale.pricingModel; every row
// this suite cares about is written with an explicit value.
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Request } from 'express';
import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { parseEnv } from '../../src/config/env.js';
import { AppError } from '../../src/shared/errors.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';
import { createPaymentsRouter } from '../../src/modules/payments/payments.routes.js';
import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';

const POLICY_VARIABLE = 'PROPORTIONAL_CHECKOUT_LOCATION_IDS';
const SRC = new URL('../../src/', import.meta.url);

// Synthetic Location/Branch ids (Location.id == Branch.id). Never real ids.
const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';

// The minimum accepted environment (same shape tests/env.test.ts uses).
const ENV_BASE = {
  DATABASE_URL: 'postgresql://test:test@demo.invalid:5432/bootstrap',
  TEST_DATABASE_URL: 'postgresql://test:test@test.invalid:5432/bootstrap',
  JWT_SECRET: 'synthetic-test-key-not-for-real-authentication',
  JWT_ACCESS_TTL_SECONDS: '900',
  CORS_ORIGINS: 'http://localhost:3000',
};

type Role = 'SELLER' | 'CASHIER' | 'WAREHOUSE' | 'ADMIN' | 'OWNER';

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

// Source files that mention the identifier OUTSIDE a comment, relative to src/.
function filesMentioning(identifier: string): string[] {
  const withoutComments = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return readdirSync(fileURLToPath(SRC), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.ts') && !entry.startsWith('generated/'))
    .filter((entry) => withoutComments(readFileSync(new URL(entry, SRC), 'utf8')).includes(identifier))
    .sort();
}

function setup(options: { proportional?: readonly string[] } = {}) {
  const db = createInMemorySalesDb();
  db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  db.insert('location', { id: L1, isActive: true });
  db.insert('location', { id: L2, isActive: true });
  db.insert('branch', { id: L1, code: 'S1', name: 'Sucursal 1' });
  db.insert('branch', { id: L2, code: 'S2', name: 'Sucursal 2' });
  for (const branchId of [L1, L2]) db.insert('saleNumberCounter', { branchId, nextValue: 1n });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = {
    seller: user('seller'), seller2: user('seller2'), cashier: user('cashier'), cashier2: user('cashier2'),
  };
  const product = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const V1 = db.insert('productVariant', {
    productId: product, sku: 'V1', barcode: 'V1', cashPrice: 10000n, price: 10000n, wholesalePrice: null,
    costPrice: 1000n, color: 'Negro', size: 'V1',
  }).id as string;
  for (const branchId of [L1, L2]) {
    db.insert('inventory', { branchId, variantId: V1, physical: 100n, reserved: 0n });
    const registerId = db.insert('cashRegister', { branchId, name: `Caja ${branchId}` }).id as string;
    db.insert('cashSession', { registerId, openedById: ids.cashier, startingCash: 0n, status: 'OPEN' });
  }
  const reqs = {
    seller: requestFor(ids.seller, [assignment('SELLER', L1)]),
    seller2: requestFor(ids.seller2, [assignment('SELLER', L2)]),
    cashier: requestFor(ids.cashier, [assignment('CASHIER', L1)]),
    cashier2: requestFor(ids.cashier2, [assignment('CASHIER', L2)]),
  };
  const client = db.client as unknown as PrismaClient;
  // R3-A3.4: the policy seam. Production reads the parsed environment value.
  const salesWith = (proportional: readonly string[]) =>
    createSalesService(client, { proportionalCheckoutLocationIds: proportional });
  const sales = salesWith(options.proportional ?? []);
  const payments = createPaymentsService(client);

  const draft = async (
    req: Request, userId: string, branchId: string, items: Array<[string, bigint]> = [[V1, 2n]],
  ) => {
    const sale = await sales.createDraftSale(req, userId, branchId);
    for (const [variantId, quantity] of items) await sales.addItem(req, userId, sale.id, { variantId, quantity });
    return sale.id;
  };
  const pay = async (saleId: string, req: Request, userId: string, method = 'CASH', amount?: bigint) => {
    const total = db.table('sale').find((row) => row.id === saleId)!.total as bigint;
    const value = amount ?? total;
    return payments.registerPayment(req, userId, saleId, {
      method, amount: value, receivedAmount: method === 'CASH' ? value : null, idempotencyKey: randomUUID(),
    } as never);
  };
  return {
    db, ids, reqs, V1, sales, salesWith, payments, draft, pay,
    sale: (saleId: string) => db.table('sale').find((row) => row.id === saleId)!,
    audits: (action: string) => db.table('auditLog').filter((row) => row.action === action),
  };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected AppError ${status} ${code}`).toBeInstanceOf(AppError);
  expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status, code });
}

// The startup failure message for a malformed variable, or null when the value
// was accepted. A rejected value is never echoed back (no secret/config leak).
function invalidConfigMessage(value: string): string | null {
  try {
    parseEnv({ ...ENV_BASE, [POLICY_VARIABLE]: value });
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

describe('P — PROPORTIONAL_CHECKOUT_LOCATION_IDS is validated at startup (req. 7)', () => {
  it('P1 an absent, empty or whitespace-only variable enables no branch', () => {
    expect(parseEnv(ENV_BASE).PROPORTIONAL_CHECKOUT_LOCATION_IDS).toEqual([]);
    expect(parseEnv({ ...ENV_BASE, [POLICY_VARIABLE]: '' }).PROPORTIONAL_CHECKOUT_LOCATION_IDS).toEqual([]);
    expect(parseEnv({ ...ENV_BASE, [POLICY_VARIABLE]: '   ' }).PROPORTIONAL_CHECKOUT_LOCATION_IDS).toEqual([]);
  });

  it('P2 accepts a comma-separated list of Location UUIDs, trimmed', () => {
    const parsed = parseEnv({ ...ENV_BASE, [POLICY_VARIABLE]: ` ${L1} ,\n${L2} ` });
    expect(parsed.PROPORTIONAL_CHECKOUT_LOCATION_IDS).toEqual([L1, L2]);
    expect(parseEnv({ ...ENV_BASE, [POLICY_VARIABLE]: L1 }).PROPORTIONAL_CHECKOUT_LOCATION_IDS).toEqual([L1]);
  });

  // The comma is a separator and nothing else: a leading, trailing or
  // intermediate empty segment is malformed configuration, never a silently
  // dropped entry. Every other segment may still be trimmed.
  it.each([`,${L1}`, `${L1},`, `${L1},,${L2}`, `${L1}, ,${L2}`, ','])(
    'P3 rejects the empty segment in %j before the server starts',
    (value) => {
      const message = invalidConfigMessage(value);
      expect(message).toContain(POLICY_VARIABLE);
      expect(message).not.toContain(value);
    },
  );

  it.each([
    'not-a-uuid',
    '11111111111141118111111111111111',
    '123e4567-e89b-12d3-a456-42661417400',
    '11111111-1111-4111-8111-11111111111z',
    `${L1},nope`,
  ])('P4 rejects the malformed value %j before the server starts and never echoes it', (value) => {
    const message = invalidConfigMessage(value);
    expect(message).toContain(POLICY_VARIABLE);
    expect(message).not.toContain(value);
  });
});

// S-REF gate: PROPORTIONAL_EXTERNAL_METHODS_ENABLED, startup validation.
const GATE_VARIABLE = 'PROPORTIONAL_EXTERNAL_METHODS_ENABLED';

describe('G — PROPORTIONAL_EXTERNAL_METHODS_ENABLED is validated at startup (S-REF)', () => {
  it('GATE-S01 defaults to OFF when absent and parses exactly the two explicit booleans', () => {
    expect(parseEnv(ENV_BASE).PROPORTIONAL_EXTERNAL_METHODS_ENABLED).toBe(false);
    expect(parseEnv({ ...ENV_BASE, [GATE_VARIABLE]: 'false' }).PROPORTIONAL_EXTERNAL_METHODS_ENABLED).toBe(false);
    expect(parseEnv({ ...ENV_BASE, [GATE_VARIABLE]: 'true' }).PROPORTIONAL_EXTERNAL_METHODS_ENABLED).toBe(true);
  });

  it.each(['', '1', '0', 'yes', 'TRUE', 'on', 'False'])(
    'GATE-S02 rejects the non-explicit boolean %j before the server starts',
    (value) => {
      const message = (() => {
        try {
          parseEnv({ ...ENV_BASE, [GATE_VARIABLE]: value });
          return null;
        } catch (error) {
          return (error as Error).message;
        }
      })();
      expect(message).toContain(GATE_VARIABLE);
    },
  );

  // The gate is injected by composition: the validated configuration and the
  // composition read it, and no service reads it from the process (the refund is
  // never gated in the first place). S-REF.1 replaced the old source-grep
  // assertion with REAL wiring evidence at the composition boundary in
  // checkout-quote.behavior.test.ts (SREF-F03/F05) and
  // checkout-reservation.behavior.test.ts (SREF-F02/F04): parseEnv -> the router
  // option exactly as app.ts injects it -> controller -> service -> HTTP answer.
});

describe('S — createDraftSale fixes the durable path once (req. 1, 2, 6)', () => {
  it('S1 a sale in a branch named by the policy is created PROPORTIONAL_V1', async () => {
    const t = setup({ proportional: [L1] });
    const created = await t.sales.createDraftSale(t.reqs.seller, t.ids.seller, L1);
    expect(created.pricingModel).toBe('PROPORTIONAL_V1');
    expect(t.sale(created.id)).toMatchObject({ pricingModel: 'PROPORTIONAL_V1', priceMode: 'CASH', status: 'DRAFT' });
  });

  it('S2 any other branch is created FIXED_TOTAL', async () => {
    const t = setup({ proportional: [L1] });
    const created = await t.sales.createDraftSale(t.reqs.seller2, t.ids.seller2, L2);
    expect(created.pricingModel).toBe('FIXED_TOTAL');
    expect(t.sale(created.id).pricingModel).toBe('FIXED_TOTAL');
  });

  it('S3 with no configured branch every sale is FIXED_TOTAL and SALE_CREATED is unchanged', async () => {
    const t = setup();
    const created = await t.sales.createDraftSale(t.reqs.seller, t.ids.seller, L1);
    expect(created).toMatchObject({ pricingModel: 'FIXED_TOTAL', priceMode: 'CASH', status: 'DRAFT' });
    const audits = t.audits('SALE_CREATED');
    expect(audits).toHaveLength(1);
    // Same payload the production audit suite pins: money as decimal strings,
    // no pricing model added (createAuditLog serializes BigInt for JSON).
    expect(audits[0]!.after).toEqual({ status: 'DRAFT', subtotal: '0', discountTotal: '0', total: '0' });
  });

  it('S4 changing the policy never re-routes a sale that already exists', async () => {
    const t = setup({ proportional: [L1] });
    const wasProportional = await t.sales.createDraftSale(t.reqs.seller, t.ids.seller, L1);
    const wasHistorical = await t.sales.createDraftSale(t.reqs.seller2, t.ids.seller2, L2);
    // The operator now flips the policy: L1 leaves the list, L2 joins it.
    const flipped = t.salesWith([L2]);
    const nowProportional = await flipped.createDraftSale(t.reqs.seller2, t.ids.seller2, L2);
    const nowHistorical = await flipped.createDraftSale(t.reqs.seller, t.ids.seller, L1);
    expect(t.sale(wasProportional.id).pricingModel).toBe('PROPORTIONAL_V1');
    expect(t.sale(wasHistorical.id).pricingModel).toBe('FIXED_TOTAL');
    expect(nowProportional.pricingModel).toBe('PROPORTIONAL_V1');
    expect(nowHistorical.pricingModel).toBe('FIXED_TOTAL');
  });

  it('S5 the variable is read only by the sale-creation path', () => {
    expect(filesMentioning(POLICY_VARIABLE)).toEqual(['config/env.ts', 'modules/sales/sales.service.ts']);
  });
});

describe('C — /payments decides on the persisted model, under the lock (req. 3, 4, 5)', () => {
  it('C1 a PROPORTIONAL_V1 sale is refused 409 CHECKOUT_REQUIRED leaving no trace', async () => {
    const t = setup({ proportional: [L1] });
    const saleId = await t.draft(t.reqs.seller, t.ids.seller, L1);
    await t.sales.sendToCashier(saleId, t.ids.seller, [L1]);
    const reservedBefore = t.db.table('stockReservation').map((row) => [row.id, row.status]);
    const inventoryBefore = t.db.table('inventory').map((row) => [row.id, row.reserved]);
    const auditsBefore = t.db.table('auditLog').length;

    await expectAppError(t.pay(saleId, t.reqs.cashier, t.ids.cashier), 409, 'CHECKOUT_REQUIRED');

    expect(t.db.table('salePayment')).toHaveLength(0);
    expect(t.sale(saleId).paymentStartedAt).toBeNull();
    expect(t.sale(saleId).status).toBe('PENDING_PAYMENT');
    expect(t.db.table('cashMovement')).toHaveLength(0);
    expect(t.db.table('auditLog')).toHaveLength(auditsBefore);
    expect(t.audits('PAYMENT_REGISTERED')).toHaveLength(0);
    expect(t.db.table('stockReservation').map((row) => [row.id, row.status])).toEqual(reservedBefore);
    expect(t.db.table('inventory').map((row) => [row.id, row.reserved])).toEqual(inventoryBefore);
  });

  it('C2 the decision reads the persisted Sale.pricingModel under FOR UPDATE', async () => {
    const t = setup({ proportional: [L1] });
    const saleId = await t.draft(t.reqs.seller, t.ids.seller, L1);
    await t.sales.sendToCashier(saleId, t.ids.seller, [L1]);
    t.db.rawQueries.length = 0;

    await expectAppError(t.pay(saleId, t.reqs.cashier, t.ids.cashier), 409, 'CHECKOUT_REQUIRED');

    const lock = t.db.rawQueries.find((sql) => sql.includes('FROM "Sale"'));
    expect(lock).toBeDefined();
    expect(lock).toContain('"pricingModel"');
    expect(lock).toContain('FOR UPDATE');
  });

  it('C3 a FIXED_TOTAL sale keeps the historical CASH path', async () => {
    const t = setup({ proportional: [L1] });
    const saleId = await t.draft(t.reqs.seller2, t.ids.seller2, L2);
    await t.sales.sendToCashier(saleId, t.ids.seller2, [L2]);
    expect(await t.pay(saleId, t.reqs.cashier2, t.ids.cashier2)).toMatchObject({ resultingStatus: 'PAID' });
    expect(t.sale(saleId).status).toBe('PAID');
    expect(t.audits('PAYMENT_REGISTERED')).toHaveLength(1);
  });

  it('C4 a FIXED_TOTAL sale keeps credit and QR partial payments', async () => {
    const t = setup({ proportional: [L1] });
    const saleId = await t.draft(t.reqs.seller2, t.ids.seller2, L2);
    await t.sales.updatePriceMode(t.reqs.seller2, t.ids.seller2, saleId, 'LIST');
    await t.sales.sendToCashier(saleId, t.ids.seller2, [L2]);
    expect(await t.pay(saleId, t.reqs.cashier2, t.ids.cashier2, 'CARD_CREDIT', 12000n))
      .toMatchObject({ resultingStatus: 'PENDING_PAYMENT' });
    expect(await t.pay(saleId, t.reqs.cashier2, t.ids.cashier2, 'QR', 8000n))
      .toMatchObject({ resultingStatus: 'PAID' });
    expect(t.db.table('salePayment')).toHaveLength(2);
  });

  it('C5 a FIXED_TOTAL PAID sale still completes', async () => {
    const t = setup({ proportional: [L1] });
    const saleId = await t.draft(t.reqs.seller2, t.ids.seller2, L2);
    await t.sales.sendToCashier(saleId, t.ids.seller2, [L2]);
    await t.pay(saleId, t.reqs.cashier2, t.ids.cashier2);
    expect((await t.sales.completeSale(t.reqs.cashier2, t.ids.cashier2, saleId)).status).toBe('COMPLETED');
    expect(t.db.table('stockReservation').every((row) => row.status === 'CONSUMED')).toBe(true);
    expect(t.audits('SALE_COMPLETED')).toHaveLength(1);
  });

  it('C6 the real /payments route answers 409 CHECKOUT_REQUIRED with no payment row', async () => {
    const t = setup({ proportional: [L1] });
    const saleId = await t.draft(t.reqs.seller, t.ids.seller, L1);
    await t.sales.sendToCashier(saleId, t.ids.seller, [L1]);
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.auth = (t.reqs.cashier as unknown as { auth: Express.AuthContext }).auth;
      next();
    });
    app.use('/sales', createPaymentsRouter(t.db.client as unknown as PrismaClient));
    app.use(errorHandler);

    const response = await supertest(app).post(`/sales/${saleId}/payments`).send({
      method: 'CASH', amount: '20000', receivedAmount: '20000', idempotencyKey: randomUUID(),
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: { code: 'CHECKOUT_REQUIRED', message: expect.any(String) } });
    expect(t.db.table('salePayment')).toHaveLength(0);
  });
});
