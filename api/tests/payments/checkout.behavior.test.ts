// R3-A3.2 — proportional checkout service, DB-FREE behavior suite.
//
// The REAL checkout service runs against an in-memory double built on top of
// tests/helpers/in-memory-sales-db.ts (which covers the sales/cash/audit
// subset) plus the three R3 tables the helper does not know
// (SaleCheckout / ExternalCollection / SaleLineAllocation). No query ever
// reaches a database: no Prisma engine, no pg Pool, no network.
//
// FIDELITY LIMITS (documented for reviewers, per the R3 design §10):
//   * `$transaction` runs callbacks serially and restores a full snapshot on
//     throw. It models atomic rollback, NOT PostgreSQL isolation levels,
//     row locks, races or Serializable conflicts.
//   * It never validates the migration's CHECK constraints or the partial
//     unique indexes.
//   * P2002 races and REAL 40001/40P01/P2034 conflicts cannot be produced.
//   => The following guarantees are PostgreSQL-only and are NOT proven here:
//      true concurrency (parallel double click, checkout vs cash close),
//      statement-level abort/rollback of a real backend termination, the
//      migration's CHECK/unique enforcement, and real Serializable retries.
//      Those live in api/tests/payments/checkout.local-test.test.ts (PG01-PG17,
//      not authorized yet).
//
// PRE-REGISTERED EXPECTATIONS (written before checkout.service.ts existed;
// A5/A6/B3/B3c/G7/H3/P1-P7 added for the cents + P2002 + reconciliation pass):
//   A1 CASH fixed 20000 + TRANSFER balance -> balance 22000, total 42000
//   A2 TRANSFER fixed 11000 + CASH balance   -> balance 30000, total 41000, change 5000
//   A3 CASH fixed 10000 + CARD_DEBIT balance -> balance 31500, total 41500
//   A4 CASH 10000 + TRANSFER 11000 + CARD_DEBIT balance -> balance 21000, total 42000
//   A5 CASH fixed 20037 (cents) + TRANSFER balance -> balance 22000, total 42037
//   A6 CARD_DEBIT fixed 21037 (cents) + CASH balance -> balance 20000, total 41037
//   B1 new transfer reference -> APPLIED ExternalCollection, payment linked
//   B2 existing UNAPPLIED collection, whole pesos -> becomes APPLIED
//   B3 existing collection of 22037 cents -> applied as the exact fixed transfer
//   B3c existing collection 22038 vs a 22037 tender -> 409 EXTERNAL_COLLECTION_NOT_APPLICABLE
//   B4 internal 409 invariant: payments = total = allocations, no duplicates
//   D4 same key + same payload -> replayed, zero new rows
//   D5 same key + other payload -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD
//   D7 other key, sale already checked out -> 409 SALE_ALREADY_CHECKED_OUT
//   E1 closed cash session -> 409 NO_OPEN_CASH_SESSION
//   E2 cash session of another branch -> 409 CASH_SESSION_BRANCH_MISMATCH
//   F1 expired reservation -> 409 RESERVATION_EXPIRED
//   F4 physical < required -> 409 INSUFFICIENT_PHYSICAL
//   G7 a reference over 64 characters -> 400 (its normalised key alone would pass)
//   G8 the reference length is counted in Unicode code points, like char_length
//      (ABC + 61 emoji = 64 -> valid; ABC + 62 emoji = 65 -> 400)
//   H3 per-payment allocations that cancel globally -> 500, whole rollback
//   P1-P9 P2002 resolution: operationKey replay, saleId refusal, the EXACT partial
//          index identified (transfer vs debit) with distinct statuses and inverted
//          tender order, the FULL key (branch + institution), one operation with
//          several references, and a fail-closed ambiguous target
//   I1 exactly one Serializable transaction, timeout 30000, 3 attempts
//   I2 no Socket.IO emission before commit
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Request } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import {
  checkoutRequestHash,
  createCheckoutService,
  type CheckoutRequest,
  type CheckoutTender,
} from '../../src/modules/payments/checkout.service.js';
import { createInMemorySalesDb, type Row } from '../helpers/in-memory-sales-db.js';

type Role = 'SELLER' | 'CASHIER' | 'WAREHOUSE' | 'ADMIN';
type AnyArgs = Record<string, unknown>;

const SERVICE_PATH = new URL('../../src/modules/payments/checkout.service.ts', import.meta.url);

function assignment(role: Role | 'OWNER', locationId: string | null): Express.ProductionAssignment {
  return {
    roleId: role, roleCode: role,
    scopeKind: locationId ? 'LOCATION' : 'COMPANY', locationId,
    permissions: role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[role]],
  };
}

function requestFor(userId: string, assignments: Express.ProductionAssignment[]): Request {
  const effectiveLocationIds = assignments.flatMap(({ locationId }) => (locationId ? [locationId] : []));
  // The service only reads req.auth; the cast mirrors the Block 1 harness.
  return { auth: { userId, roles: assignments.map(({ roleCode }) => roleCode), assignments, effectiveLocationIds } } as unknown as Request;
}

// ---------------------------------------------------------------------------
// In-memory double: the base store plus SaleCheckout / ExternalCollection /
// SaleLineAllocation, a CashSession JOIN lock and an ExternalCollection lock.
// ---------------------------------------------------------------------------
type ExtraModel = 'saleCheckout' | 'externalCollection' | 'saleLineAllocation';

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Date) && !Array.isArray(value);
}

function matchesWhere(row: Row, where: unknown): boolean {
  if (where === undefined) return true;
  if (!plain(where)) throw new Error('checkout fake: unsupported where shape');
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (plain(condition)) {
      if ('in' in condition) return (condition.in as unknown[]).includes(row[key]);
      throw new Error(`checkout fake: unsupported operator on ${key}`);
    }
    return row[key] === condition;
  });
}

function createCheckoutDb() {
  const base = createInMemorySalesDb();
  const extra: Record<ExtraModel, Row[]> = { saleCheckout: [], externalCollection: [], saleLineAllocation: [] };
  const allocationBiases: Array<(data: Row) => Row> = [];

  const delegateFor = (model: ExtraModel, store: Row[]) => ({
    create: async (args: AnyArgs) => {
      let data = args.data as Row;
      // Test-only bias: lets a case corrupt what actually reaches the store, so a
      // wrong write can be proven to be caught (H3 per-payment reconciliation).
      if (model === 'saleLineAllocation') for (const bias of allocationBiases) data = bias(data);
      const row: Row = { id: randomUUID(), ...data };
      store.push(row);
      return { ...row };
    },
    findMany: async (args: AnyArgs = {}) => store.filter((row) => matchesWhere(row, args.where)).map((row) => ({ ...row })),
    findFirst: async (args: AnyArgs = {}) => store.filter((row) => matchesWhere(row, args.where)).map((row) => ({ ...row }))[0] ?? null,
    findUnique: async (args: AnyArgs = {}) => store.filter((row) => matchesWhere(row, args.where)).map((row) => ({ ...row }))[0] ?? null,
    findUniqueOrThrow: async (args: AnyArgs = {}) => {
      const found = store.find((row) => matchesWhere(row, args.where));
      if (!found) throw new Error('checkout fake: not found');
      return { ...found };
    },
    update: async (args: AnyArgs) => {
      const row = store.find((candidate) => matchesWhere(candidate, args.where));
      if (!row) throw new Error('checkout fake: update target not found');
      Object.assign(row, args.data as Row);
      return { ...row };
    },
    updateMany: async (args: AnyArgs) => {
      const targets = store.filter((row) => matchesWhere(row, args.where));
      for (const row of targets) Object.assign(row, args.data as Row);
      return { count: targets.length };
    },
  });

  const client = base.client as Record<string, unknown>;
  for (const model of Object.keys(extra) as ExtraModel[]) client[model] = delegateFor(model, extra[model]);

  const baseQueryRaw = client.$queryRaw as (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>;
  const record = (sql: string) => base.rawQueries.push(sql.replace(/\s+/g, ' ').trim());
  client.$queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (/JOIN "CashRegister"/.test(sql)) {
      record(sql);
      const session = base.table('cashSession').find((row) => row.id === values[0]);
      if (!session) return [];
      const register = base.table('cashRegister').find((row) => row.id === session.registerId);
      if (!register) return [];
      return [{ id: session.id, status: session.status, registerId: session.registerId, branchId: register.branchId }];
    }
    if (/FROM "ExternalCollection"/.test(sql)) {
      record(sql);
      const bound = values[0];
      const ids = (Array.isArray(bound) ? bound : (bound as { values: unknown[] }).values) as unknown[];
      return extra.externalCollection
        .filter((row) => ids.includes(row.id))
        .sort((left, right) => String(left.id).localeCompare(String(right.id)))
        .map((row) => ({ ...row }));
    }
    return baseQueryRaw(strings, ...values);
  };

  // Test-only seam: what a CONCURRENT peer transaction had already committed when
  // our write collided with it. The mutations are applied only after our
  // transaction unwinds, so this double's rollback cannot erase them — exactly the
  // durable state a committed peer leaves behind in PostgreSQL (which is why the
  // real race cannot be produced here).
  let committedByPeers: Array<() => void> = [];

  const baseTransaction = client.$transaction as (operation: unknown, options?: unknown) => Promise<unknown>;
  client.$transaction = async (operation: unknown, options?: unknown) => {
    const snapshot = structuredClone(extra);
    try {
      return await baseTransaction(operation, options);
    } catch (error) {
      // Restore IN PLACE: each delegate holds the array reference captured when it
      // was built, so replacing the properties would leave every delegate writing
      // to an abandoned array and hide the rollback from them.
      for (const model of Object.keys(extra) as ExtraModel[]) {
        extra[model].length = 0;
        extra[model].push(...snapshot[model]);
      }
      const queued = committedByPeers;
      committedByPeers = [];
      for (const apply of queued) apply();
      throw error;
    }
  };

  const injectFailure = (model: string, operation: string, error: unknown = new Error('injected failure'), when?: (args: AnyArgs) => boolean) => {
    const delegate = (client as Record<string, Record<string, unknown>>)[model]!;
    const original = delegate[operation] as (args: AnyArgs) => Promise<unknown>;
    delegate[operation] = async (args: AnyArgs) => {
      if (when && !when(args)) return original(args);
      delegate[operation] = original;
      throw error;
    };
  };

  // A P2002 exactly as the driver reports it, with the offending unique target
  // (a field list for a declared @@unique, the index name for a partial index).
  const injectUniqueViolation = (model: string, operation: string, target: string, when?: (args: AnyArgs) => boolean) => {
    const error = Object.assign(new Error(`Unique constraint failed on the fields: (${target})`), { code: 'P2002', meta: { target } });
    injectFailure(model, operation, error, when);
  };

  return {
    ...base, client, extra, injectFailure, injectUniqueViolation,
    simulateConcurrentCommit: (apply: () => void) => committedByPeers.push(apply),
    addAllocationBias: (bias: (data: Row) => Row) => allocationBiases.push(bias),
  };
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------
const BRANCH = 'L1';
const OTHER_BRANCH = 'L2';

type SaleOptions = {
  quantity?: bigint;
  baseUnitPrice?: bigint;
  withReservation?: boolean;
  reservationQuantity?: bigint;
  expiresInMs?: number;
  physical?: bigint;
  reserved?: bigint;
  pricingModel?: string;
  status?: string;
  priceMode?: string;
  priceBaseType?: string;
  withPayment?: boolean;
};

function setup(options: SaleOptions = {}) {
  const db = createCheckoutDb();
  const company = db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  db.insert('companyPricingConfig', {
    companyId: company.id,
    listAdjustmentBps: 2000, creditCardAdjustmentBps: 1500, debitCardAdjustmentBps: 500,
    bankTransferAdjustmentBps: 1000, qrAdjustmentBps: 0,
  });
  db.insert('location', { id: BRANCH, isActive: true });
  db.insert('location', { id: OTHER_BRANCH, isActive: true });
  db.insert('branch', { id: BRANCH, code: 'S1', name: 'Sucursal 1' });
  db.insert('branch', { id: OTHER_BRANCH, code: 'S2', name: 'Sucursal 2' });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), cashier: user('cashier'), cashier2: user('cashier2'), warehouse: user('warehouse'), owner: user('owner') };
  const productId = db.insert('product', { name: 'Remera', isActive: true }).id as string;

  const quantity = options.quantity ?? 1n;
  const base = options.baseUnitPrice ?? 40000n;
  const variantId = db.insert('productVariant', {
    productId, sku: 'REM-01', barcode: 'REM-01', color: 'Negro', size: 'U',
    price: base, cashPrice: base, wholesalePrice: null, costPrice: 1000n, isActive: true,
  }).id as string;
  db.insert('inventory', { branchId: BRANCH, variantId, physical: options.physical ?? 10n, reserved: options.reserved ?? 1n });

  const register = db.insert('cashRegister', { branchId: BRANCH, name: 'Caja 1' });
  const session = db.insert('cashSession', { registerId: register.id, openedById: ids.cashier, startingCash: 0n, status: 'OPEN' });
  const otherRegister = db.insert('cashRegister', { branchId: OTHER_BRANCH, name: 'Caja 2' });
  const otherSession = db.insert('cashSession', { registerId: otherRegister.id, openedById: ids.cashier2, startingCash: 0n, status: 'OPEN' });

  let saleSequence = 0;
  const addSale = (saleOptions: SaleOptions = {}) => {
    saleSequence += 1;
    const saleQuantity = saleOptions.quantity ?? quantity;
    const saleBase = saleOptions.baseUnitPrice ?? base;
    const id = db.insert('sale', {
      branchId: BRANCH, sellerId: ids.seller, saleNumber: `S1-${String(saleSequence).padStart(6, '0')}`,
      status: saleOptions.status ?? 'PENDING_PAYMENT',
      subtotal: saleBase * saleQuantity, discountTotal: 0n, total: saleBase * saleQuantity,
      pricingMode: saleOptions.priceBaseType ?? 'LIST', priceMode: saleOptions.priceMode ?? 'CASH',
      pricingModel: saleOptions.pricingModel ?? 'PROPORTIONAL_V1',
      wholesaleAuthorizedAt: null, wholesaleConfirmedById: null, wholesaleConfirmedAt: null, paymentStartedAt: null,
    }).id as string;
    const itemId = db.insert('saleItem', {
      saleId: id, variantId, productId, productName: 'Remera', variantName: 'REM-01', sku: 'REM-01',
      quantity: saleQuantity, unitPrice: saleBase, subtotal: saleBase * saleQuantity,
      priceBaseType: saleOptions.priceBaseType ?? 'LIST', priceMode: saleOptions.priceMode ?? 'CASH',
      baseUnitPrice: saleBase, priceAdjustmentBps: 0,
    }).id as string;
    if (saleOptions.withReservation !== false) {
      db.insert('stockReservation', {
        saleId: id, variantId, branchId: BRANCH, quantity: saleOptions.reservationQuantity ?? saleQuantity, status: 'ACTIVE',
        expiresAt: new Date(Date.now() + (saleOptions.expiresInMs ?? 15 * 60 * 1000)),
      });
    }
    if (saleOptions.withPayment) {
      db.insert('salePayment', { saleId: id, method: 'CASH', amount: 1000n, receivedAmount: 1000n, changeAmount: 0n, idempotencyKey: randomUUID() });
    }
    return { saleId: id, saleItemId: itemId };
  };
  const { saleId, saleItemId } = addSale(options);
  const addCollection = (data: Row) => {
    const row: Row = { id: randomUUID(), ...data };
    db.extra.externalCollection.push(row);
    return row;
  };

  const reqs = {
    cashier: requestFor(ids.cashier, [assignment('CASHIER', BRANCH)]),
    cashier2: requestFor(ids.cashier2, [assignment('CASHIER', OTHER_BRANCH)]),
    seller: requestFor(ids.seller, [assignment('SELLER', BRANCH)]),
    warehouse: requestFor(ids.warehouse, [assignment('WAREHOUSE', BRANCH)]),
    owner: requestFor(ids.owner, [assignment('OWNER', null)]),
  };

  const client = db.client as unknown as PrismaClient;
  const checkout = createCheckoutService(client);

  const table = (model: Parameters<typeof db.table>[0]) => db.table(model);
  const counts = () => ({
    checkouts: db.extra.saleCheckout.length,
    collections: db.extra.externalCollection.length,
    allocations: db.extra.saleLineAllocation.length,
    payments: table('salePayment').length,
    stockMovements: table('stockMovement').length,
    cashMovements: table('cashMovement').length,
    audits: table('auditLog').length,
  });
  const sale = (id: string = saleId) => table('sale').find((row) => row.id === id)!;
  const audits = (action: string) => table('auditLog').filter((row) => row.action === action);

  const lockOrder = () =>
    db.rawQueries
      .map((sql): string | null => {
        if (/FROM "Sale" WHERE id = \? FOR UPDATE/.test(sql)) return 'Sale';
        if (/FROM "ExternalCollection"/.test(sql)) return 'ExternalCollection';
        if (/JOIN "CashRegister"/.test(sql)) return 'CashSession';
        if (/FROM "StockReservation"/.test(sql)) return 'StockReservation';
        if (/FROM "Inventory"/.test(sql)) return 'Inventory';
        return null;
      })
      .filter((value): value is string => value !== null);

  return {
    db, client, checkout, ids, reqs, saleId, saleItemId, variantId, addSale, addCollection,
    sessionId: session.id as string, otherSessionId: otherSession.id as string, table, counts, sale, audits, lockOrder,
  };
}

type Harness = ReturnType<typeof setup>;

function fixedTender(method: 'CASH' | 'TRANSFER' | 'CARD_DEBIT', amount: bigint, extra: Partial<CheckoutTender> = {}): CheckoutTender {
  return {
    method, role: 'FIXED', amount, receivedAmount: null, reference: null,
    institution: null, institutionOther: null, externalCollectionId: null, ...extra,
  };
}

function balanceTender(method: 'CASH' | 'TRANSFER' | 'CARD_DEBIT', extra: Partial<CheckoutTender> = {}): CheckoutTender {
  return {
    method, role: 'BALANCE', amount: null, receivedAmount: null, reference: null,
    institution: null, institutionOther: null, externalCollectionId: null, ...extra,
  };
}

// The four commercial cases all price one unit of 40000 centavos with a 1000 bps
// transfer and 500 bps debit adjustment: P_CASH 40000, P_TRANSFER 44000, P_DEBIT 42000.
function request(t: Harness, overrides: Partial<CheckoutRequest> = {}): CheckoutRequest {
  return {
    operationKey: randomUUID(),
    cashSessionId: t.sessionId,
    balanceMethod: 'TRANSFER',
    expectedTotal: 42000n,
    expectedBalanceAmount: 22000n,
    tenders: [
      fixedTender('CASH', 20000n, { receivedAmount: 20000n }),
      balanceTender('TRANSFER', { reference: 'OP 88123', institution: 'GALICIA' }),
    ],
    ...overrides,
  };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected AppError ${status} ${code}`).toBeInstanceOf(AppError);
  expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status, code });
  return error as AppError;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R3 checkout — the four commercial cases', () => {
  it('A1 CASH fixed + TRANSFER balance writes one coherent settlement', async () => {
    const t = setup();
    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t));

    expect(result).toMatchObject({
      saleId: t.saleId, saleNumber: 'S1-000001', status: 'COMPLETED', replayed: false,
      total: 42000n, changeAmount: 0n,
    });
    expect(result.payments.map((p) => [p.method, p.tenderRole, p.amount])).toEqual([
      ['CASH', 'FIXED', 20000n], ['TRANSFER', 'BALANCE', 22000n],
    ]);
    expect(result.lines).toEqual([{ saleItemId: t.saleItemId, sku: 'REM-01', quantity: 1n, finalAmount: 42000n }]);

    // One checkout, two payments, two allocations, one stock movement, one cash movement.
    expect(t.counts()).toEqual({
      checkouts: 1, collections: 1, allocations: 2, payments: 2, stockMovements: 1, cashMovements: 1, audits: 5,
    });
    expect(t.db.extra.saleCheckout[0]).toMatchObject({
      saleId: t.saleId, branchId: BRANCH, pricingModel: 'PROPORTIONAL_V1', balanceMethod: 'TRANSFER',
      referenceSubtotal: 40000n, total: 42000n, changeAmount: 0n,
      fullPriceCash: 40000n, fullPriceTransfer: 44000n, fullPriceDebit: 42000n,
      transferAdjustmentBps: 1000, debitAdjustmentBps: 500, algorithmVersion: 1,
    });
    expect(String(t.db.extra.saleCheckout[0]!.requestHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(t.db.extra.saleCheckout[0]!.pricingConfigId).toBe(t.table('companyPricingConfig')[0]!.id);

    // Sale is COMPLETED and its total is the proportional total.
    expect(t.sale()).toMatchObject({ status: 'COMPLETED', total: 42000n });
    // Stock deducted once, reservation consumed.
    expect(t.table('inventory')[0]).toMatchObject({ physical: 9n, reserved: 0n });
    expect(t.table('stockReservation')[0]).toMatchObject({ status: 'CONSUMED' });
    expect(t.table('stockMovement')[0]).toMatchObject({ type: 'SALE', quantityDelta: -1n });
    // Audit trail.
    expect(t.audits('PAYMENT_REGISTERED')).toHaveLength(2);
    expect(t.audits('SALE_CHECKOUT_COMPLETED')).toHaveLength(1);
    expect(t.audits('EXTERNAL_COLLECTION_APPLIED')).toHaveLength(1);
    expect(t.audits('SALE_COMPLETED')).toHaveLength(1);
    // Lock order is deterministic (no external collection is referenced here).
    expect(t.lockOrder().slice(0, 4)).toEqual(['Sale', 'CashSession', 'StockReservation', 'Inventory']);
  });

  it('A2 TRANSFER fixed + CASH balance records the change', async () => {
    const t = setup();
    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      balanceMethod: 'CASH',
      expectedTotal: 41000n,
      expectedBalanceAmount: 30000n,
      tenders: [
        fixedTender('TRANSFER', 11000n, { reference: 'TR-1', institution: 'MACRO' }),
        balanceTender('CASH', { receivedAmount: 35000n }),
      ],
    }));

    expect(result).toMatchObject({ total: 41000n, changeAmount: 5000n });
    // Persisted in the engine's canonical method order (CASH, TRANSFER, CARD_DEBIT).
    expect(result.payments.map((p) => [p.method, p.tenderRole, p.amount, p.changeAmount])).toEqual([
      ['CASH', 'BALANCE', 30000n, 5000n], ['TRANSFER', 'FIXED', 11000n, null],
    ]);
    // Only the net cash becomes a cash movement.
    expect(t.table('cashMovement')).toHaveLength(1);
    expect(t.table('cashMovement')[0]).toMatchObject({ type: 'SALE_INCOME', amount: 30000n });
  });

  it('A3 CASH fixed + CARD_DEBIT balance uses the debit adjustment', async () => {
    const t = setup();
    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      balanceMethod: 'CARD_DEBIT',
      expectedTotal: 41500n,
      expectedBalanceAmount: 31500n,
      tenders: [
        fixedTender('CASH', 10000n, { receivedAmount: 10000n }),
        balanceTender('CARD_DEBIT', { reference: 'L12-C0456' }),
      ],
    }));

    expect(result).toMatchObject({ total: 41500n, changeAmount: 0n });
    expect(t.db.extra.saleCheckout[0]).toMatchObject({ balanceMethod: 'CARD_DEBIT' });
    expect(t.table('salePayment').find((row) => row.method === 'CARD_DEBIT')).toMatchObject({ amount: 31500n, adjustmentBps: 500, methodFullPrice: 42000n });
  });

  it('A4 three methods settle exactly to the proportional total', async () => {
    const t = setup();
    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      balanceMethod: 'CARD_DEBIT',
      expectedTotal: 42000n,
      expectedBalanceAmount: 21000n,
      tenders: [
        fixedTender('CASH', 10000n, { receivedAmount: 10000n }),
        fixedTender('TRANSFER', 11000n, { reference: 'TR-2', institution: 'BBVA' }),
        balanceTender('CARD_DEBIT', { reference: 'D003' }),
      ],
    }));

    expect(result.payments.map((p) => [p.method, p.tenderRole, p.amount])).toEqual([
      ['CASH', 'FIXED', 10000n], ['TRANSFER', 'FIXED', 11000n], ['CARD_DEBIT', 'BALANCE', 21000n],
    ]);
    // Σ payments = Σ allocations = checkout.total = Sale.total.
    const paymentSum = t.table('salePayment').reduce((sum, row) => sum + (row.amount as bigint), 0n);
    const allocationSum = t.db.extra.saleLineAllocation.reduce((sum, row) => sum + (row.amount as bigint), 0n);
    expect(paymentSum).toBe(42000n);
    expect(allocationSum).toBe(42000n);
    expect(t.db.extra.saleCheckout[0]!.total).toBe(42000n);
    expect(t.sale().total).toBe(42000n);
    expect(t.counts().allocations).toBe(3);
    expect(t.counts().collections).toBe(2);
  });

  it('A5 a CASH fixed amount may carry centavos and is applied exactly', async () => {
    const t = setup();
    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      balanceMethod: 'TRANSFER',
      expectedTotal: 42037n,
      expectedBalanceAmount: 22000n,
      tenders: [
        fixedTender('CASH', 20037n, { receivedAmount: 20037n }),
        balanceTender('TRANSFER', { reference: 'OP 88123', institution: 'GALICIA' }),
      ],
    }));

    expect(result).toMatchObject({ total: 42037n, changeAmount: 0n });
    expect(result.payments.map((p) => [p.method, p.tenderRole, p.amount, p.changeAmount])).toEqual([
      ['CASH', 'FIXED', 20037n, 0n], ['TRANSFER', 'BALANCE', 22000n, null],
    ]);
    // The received centavos are never rounded away.
    expect(t.db.extra.saleLineAllocation.find((row) => row.method === 'CASH')).toMatchObject({
      amount: 20037n, unitPrice: 40000n, lineFullPrice: 40000n, baseUnitPrice: 40000n,
    });
    expect(t.table('cashMovement')[0]).toMatchObject({ type: 'SALE_INCOME', amount: 20037n });
    expect(t.sale().total).toBe(42037n);
    expect(t.counts().allocations).toBe(2);
  });

  it('A6 a CARD_DEBIT fixed amount may carry centavos and keeps the debit adjustment', async () => {
    const t = setup();
    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      balanceMethod: 'CASH',
      expectedTotal: 41037n,
      expectedBalanceAmount: 20000n,
      tenders: [
        fixedTender('CARD_DEBIT', 21037n, { reference: 'D900' }),
        balanceTender('CASH', { receivedAmount: 20000n }),
      ],
    }));

    expect(result).toMatchObject({ total: 41037n, changeAmount: 0n });
    expect(t.table('salePayment').find((row) => row.method === 'CARD_DEBIT')).toMatchObject({
      amount: 21037n, methodFullPrice: 42000n, adjustmentBps: 500,
    });
    expect(t.db.extra.saleLineAllocation.find((row) => row.method === 'CARD_DEBIT')).toMatchObject({ amount: 21037n, unitPrice: 42000n });
    expect(t.db.extra.externalCollection[0]).toMatchObject({ method: 'CARD_DEBIT', amount: 21037n, status: 'APPLIED' });
    expect(t.sale().total).toBe(41037n);
  });
});

describe('R3 checkout — external collections', () => {
  it('B1 a new transfer reference is recorded APPLIED and linked to its payment', async () => {
    const t = setup();
    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t));

    const [collection] = t.db.extra.externalCollection;
    expect(collection).toMatchObject({
      branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 88123', referenceKey: 'OP88123',
      institution: 'GALICIA', institutionOther: null, status: 'APPLIED', appliedSaleId: t.saleId, originSaleId: t.saleId,
      cashSessionId: t.sessionId, recordedById: t.ids.cashier,
    });
    const transfer = t.table('salePayment').find((row) => row.method === 'TRANSFER')!;
    expect(transfer.externalCollectionId).toBe(collection!.id);
  });

  it('B2 an existing UNAPPLIED collection is applied instead of charged again', async () => {
    const t = setup();
    const existing = t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 88123', referenceKey: 'OP88123',
      institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', originSaleId: t.saleId,
      recordedById: t.ids.seller, cashSessionId: null, appliedCheckoutId: null, appliedSaleId: null,
    });

    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      balanceMethod: 'CASH',
      expectedBalanceAmount: 20000n,
      tenders: [
        fixedTender('TRANSFER', 22000n, { externalCollectionId: existing.id as string }),
        balanceTender('CASH', { receivedAmount: 20000n }),
      ],
    }));

    expect(t.db.extra.externalCollection).toHaveLength(1);
    expect(t.db.extra.externalCollection[0]).toMatchObject({ id: existing.id, status: 'APPLIED', appliedSaleId: t.saleId, appliedCheckoutId: t.db.extra.saleCheckout[0]!.id });
    expect(t.table('salePayment').find((row) => row.method === 'TRANSFER')!.externalCollectionId).toBe(existing.id);
    // The full global lock order, with the external collection between sale and cash session.
    expect(t.lockOrder().slice(0, 5)).toEqual(['Sale', 'ExternalCollection', 'CashSession', 'StockReservation', 'Inventory']);
  });

  it('B3 a collection that carries centavos is applied for precisely its amount', async () => {
    const t = setup();
    const existing = t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 22037n, reference: 'OP 88', referenceKey: 'OP88',
      institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', originSaleId: t.saleId,
      recordedById: t.ids.seller, cashSessionId: null, appliedCheckoutId: null, appliedSaleId: null,
    });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      balanceMethod: 'CASH',
      expectedTotal: 42037n,
      expectedBalanceAmount: 20000n,
      tenders: [
        fixedTender('TRANSFER', 22037n, { externalCollectionId: existing.id as string }),
        balanceTender('CASH', { receivedAmount: 20000n }),
      ],
    }));

    // 22037 is applied as-is: never rounded to 22000 nor to 22100.
    expect(result).toMatchObject({ total: 42037n, changeAmount: 0n });
    expect(result.payments.map((p) => [p.method, p.tenderRole, p.amount])).toEqual([
      ['CASH', 'BALANCE', 20000n], ['TRANSFER', 'FIXED', 22037n],
    ]);
    expect(t.db.extra.externalCollection).toHaveLength(1);
    expect(t.db.extra.externalCollection[0]).toMatchObject({ id: existing.id, amount: 22037n, status: 'APPLIED', appliedSaleId: t.saleId });
    expect(t.table('salePayment').find((row) => row.method === 'TRANSFER')).toMatchObject({ amount: 22037n, externalCollectionId: existing.id });
    expect(t.db.extra.saleLineAllocation.find((row) => row.method === 'TRANSFER')).toMatchObject({ amount: 22037n, unitPrice: 44000n, lineFullPrice: 44000n });
  });

  it('B3c a collection whose amount differs by centavos is refused', async () => {
    const t = setup();
    const existing = t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 22038n, reference: 'OP 88', referenceKey: 'OP88',
      institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', originSaleId: t.saleId,
      recordedById: t.ids.seller, cashSessionId: null, appliedCheckoutId: null, appliedSaleId: null,
    });
    const before = t.counts();

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      balanceMethod: 'CASH',
      expectedTotal: 42037n,
      expectedBalanceAmount: 20000n,
      tenders: [
        fixedTender('TRANSFER', 22037n, { externalCollectionId: existing.id as string }),
        balanceTender('CASH', { receivedAmount: 20000n }),
      ],
    })), 409, 'EXTERNAL_COLLECTION_NOT_APPLICABLE');
    expect(t.counts()).toEqual(before);
    expect(t.db.extra.externalCollection[0]).toMatchObject({ status: 'UNAPPLIED' });
  });

  it('B3b an already applied collection cannot be applied twice', async () => {
    const t = setup();
    const applied = t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 99', referenceKey: 'OP99',
      institution: 'GALICIA', institutionOther: null, status: 'APPLIED',
      appliedCheckoutId: randomUUID(), appliedSaleId: t.saleId, recordedById: t.ids.seller,
    });
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      balanceMethod: 'CASH',
      expectedBalanceAmount: 20000n,
      tenders: [
        fixedTender('TRANSFER', 22000n, { externalCollectionId: applied.id as string }),
        balanceTender('CASH', { receivedAmount: 20000n }),
      ],
    })), 409, 'EXTERNAL_COLLECTION_NOT_APPLICABLE');
  });

  it('B5 a new reference that already exists is refused with its status', async () => {
    const t = setup();
    t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 11000n, reference: 'OP 88123', referenceKey: 'OP88123',
      institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
    });
    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      balanceMethod: 'CARD_DEBIT',
      expectedTotal: 42000n,
      expectedBalanceAmount: 31500n,
      tenders: [
        fixedTender('TRANSFER', 11000n, { reference: 'OP 88123', institution: 'GALICIA' }),
        balanceTender('CARD_DEBIT', { reference: 'D009' }),
      ],
    })), 409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED');
    expect(error.details).toEqual({ status: 'UNAPPLIED' });
  });
});

describe('R3 checkout — authorization', () => {
  it('C1 a cashier of another branch is refused with no effects', async () => {
    const t = setup();
    const before = t.counts();
    await expectAppError(t.checkout.checkout(t.reqs.cashier2, t.ids.cashier2, t.saleId, request(t)), 403, 'FORBIDDEN');
    expect(t.counts()).toEqual(before);
    expect(t.sale().status).toBe('PENDING_PAYMENT');
  });

  it('C2 SALE_CHARGE without SALE_COMPLETE is refused', async () => {
    const t = setup();
    await expectAppError(t.checkout.checkout(t.reqs.seller, t.ids.seller, t.saleId, request(t)), 403, 'FORBIDDEN');
    await expectAppError(t.checkout.checkout(t.reqs.warehouse, t.ids.warehouse, t.saleId, request(t)), 403, 'FORBIDDEN');
  });

  it('C3 OWNER holds implicit authority', async () => {
    const t = setup();
    await expect(t.checkout.checkout(t.reqs.owner, t.ids.owner, t.saleId, request(t))).resolves.toMatchObject({ status: 'COMPLETED' });
  });
});

describe('R3 checkout — state and idempotency', () => {
  it('D1 a FIXED_TOTAL sale is refused', async () => {
    const t = setup({ pricingModel: 'FIXED_TOTAL' });
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'INVALID_SALE_STATE');
  });

  it('D2 a sale that is not PENDING_PAYMENT is refused', async () => {
    const t = setup({ status: 'DRAFT' });
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'INVALID_SALE_STATE');
  });

  it('D3 a sale with previous payments is refused', async () => {
    const t = setup({ withPayment: true });
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'INVALID_SALE_STATE');
    expect(t.table('salePayment')).toHaveLength(1);
  });

  it('D4 the same key and payload replays without new rows', async () => {
    const t = setup();
    const payload = request(t);
    const first = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    const afterFirst = t.counts();

    const replay = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    expect(replay.replayed).toBe(true);
    expect(replay.checkoutId).toBe(first.checkoutId);
    expect(replay.total).toBe(first.total);
    expect(t.counts()).toEqual(afterFirst);
  });

  it('D5 the same key with a different payload is refused', async () => {
    const t = setup();
    const payload = request(t);
    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    const before = t.counts();

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, {
      ...payload,
      tenders: [
        fixedTender('CASH', 20000n, { receivedAmount: 25000n }),
        balanceTender('TRANSFER', { reference: 'OP 88123', institution: 'GALICIA' }),
      ],
    }), 409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    expect(t.counts()).toEqual(before);
  });

  it('D6 the same key on another sale is refused', async () => {
    const t = setup();
    const payload = request(t);
    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    const other = t.addSale();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, other.saleId, payload), 409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  });

  it('D7 a second checkout with another key is refused', async () => {
    const t = setup();
    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t));
    const before = t.counts();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'SALE_ALREADY_CHECKED_OUT');
    expect(t.counts()).toEqual(before);
  });

  it('D8 a checkout whose sale is not COMPLETED fails closed', async () => {
    const t = setup();
    const payload = request(t);
    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    t.sale().status = 'PAID';
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload), 500, 'CHECKOUT_STATE_INCONSISTENT');
  });

  it('D9 a stale quote is refused with the recalculated amounts', async () => {
    const t = setup();
    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, { expectedBalanceAmount: 21000n })), 409, 'CHECKOUT_QUOTE_CHANGED');
    expect(error.details).toEqual({ total: 42000n, balance: 22000n });
    expect(t.counts().payments).toBe(0);
  });
});

describe('R3 checkout — cash session', () => {
  it('E1 a closed session is refused', async () => {
    const t = setup();
    t.table('cashSession').find((row) => row.id === t.sessionId)!.status = 'CLOSED';
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'NO_OPEN_CASH_SESSION');
  });

  it('E2 a session of another branch is refused', async () => {
    const t = setup();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, { cashSessionId: t.otherSessionId })), 409, 'CASH_SESSION_BRANCH_MISMATCH');
  });

  it('E3 an unknown session is refused', async () => {
    const t = setup();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, { cashSessionId: randomUUID() })), 409, 'NO_OPEN_CASH_SESSION');
  });
});

describe('R3 checkout — reservations and stock', () => {
  it('F1 an expired reservation is refused', async () => {
    const t = setup({ expiresInMs: -1000 });
    const before = t.counts();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'RESERVATION_EXPIRED');
    expect(t.counts()).toEqual(before);
  });

  it('F2 no active hold is refused', async () => {
    const t = setup({ withReservation: false });
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'INVALID_RESERVATION');
  });

  it('F3 a hold that does not match the items is refused', async () => {
    const t = setup({ reservationQuantity: 2n });
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'INVALID_RESERVATION');
  });

  it('F4 insufficient physical stock is refused', async () => {
    const t = setup({ physical: 0n });
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'INSUFFICIENT_PHYSICAL');
    expect(t.table('inventory')[0]).toMatchObject({ physical: 0n, reserved: 1n });
  });

  it('F5 insufficient reserved stock is refused', async () => {
    const t = setup({ reserved: 0n });
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'INSUFFICIENT_RESERVED');
  });
});

describe('R3 checkout — request and engine validation', () => {
  it('G1 exactly one balance tender is required', async () => {
    const t = setup();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [balanceTender('TRANSFER', { reference: 'REFA' }), balanceTender('CASH', { receivedAmount: 1000n })],
    })), 400, 'VALIDATION_ERROR');
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [fixedTender('CASH', 20000n, { receivedAmount: 20000n })],
    })), 400, 'VALIDATION_ERROR');
  });

  it('G2 the balance method must match the balance tender', async () => {
    const t = setup();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [
        fixedTender('CASH', 20000n, { receivedAmount: 20000n }),
        balanceTender('CARD_DEBIT', { reference: 'D001' }),
      ],
    })), 400, 'VALIDATION_ERROR');
  });

  it('G3 a fixed amount is mandatory and positive; CASH needs received money', async () => {
    const t = setup();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [fixedTender('CASH', 20000n), balanceTender('TRANSFER', { reference: 'REF1', institution: 'GALICIA' })],
    })), 400, 'VALIDATION_ERROR');
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [
        fixedTender('CASH', 20000n, { receivedAmount: 1000n }),
        balanceTender('TRANSFER', { reference: 'REF1', institution: 'GALICIA' }),
      ],
    })), 409, 'CASH_RECEIVED_INSUFFICIENT');
  });

  it('G4 credit and QR are not enabled methods', async () => {
    const t = setup();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [fixedTender('CASH', 20000n, { receivedAmount: 20000n }), balanceTender('TRANSFER', { reference: 'REF1', institution: 'GALICIA' }), {
        // A method the R3 opening policy excludes; the cast lets the case reach the engine.
        method: 'CREDIT_CARD', role: 'FIXED', amount: 1000n, receivedAmount: null, reference: 'REFX',
        institution: null, institutionOther: null, externalCollectionId: null,
      } as unknown as CheckoutTender],
    })), 409, 'PAYMENT_METHOD_NOT_ENABLED');
  });

  it('G5 the engine rejects fixed tenders that cover the sale and a sub-peso balance', async () => {
    const t = setup();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [fixedTender('CASH', 40000n, { receivedAmount: 40000n }), balanceTender('TRANSFER', { reference: 'REF1', institution: 'GALICIA' })],
    })), 409, 'FIXED_TENDERS_COVER_SALE');
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [fixedTender('CASH', 10000n, { receivedAmount: 10000n }), balanceTender('CASH', { receivedAmount: 10000n })],
    })), 400, 'VALIDATION_ERROR');
  });

  it('G6 transfer and debit references are validated', async () => {
    const t = setup();
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [fixedTender('CASH', 20000n, { receivedAmount: 20000n }), balanceTender('TRANSFER', { institution: 'GALICIA' })],
    })), 400, 'VALIDATION_ERROR');
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [fixedTender('CASH', 20000n, { receivedAmount: 20000n }), balanceTender('TRANSFER', { reference: 'REF1', institution: 'OTHER' })],
    })), 400, 'VALIDATION_ERROR');
  });

  it('G7 a reference longer than 64 characters is rejected before it is normalised', async () => {
    const t = setup();
    // 69 characters whose normalised key is the valid 'OP123': only the RAW length
    // check can reject it (chk_ec_reference is 1..64 --- not just the key pattern).
    const tooLong = `OP${'-'.repeat(64)}123`;
    expect(tooLong).toHaveLength(69);
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [
        fixedTender('CASH', 20000n, { receivedAmount: 20000n }),
        balanceTender('TRANSFER', { reference: tooLong, institution: 'GALICIA' }),
      ],
    })), 400, 'VALIDATION_ERROR');
    // An empty reference is refused too (1..64).
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [
        fixedTender('CASH', 20000n, { receivedAmount: 20000n }),
        balanceTender('TRANSFER', { reference: '', institution: 'GALICIA' }),
      ],
    })), 400, 'VALIDATION_ERROR');

    // 64 characters is the boundary the database accepts, and it is stored whole.
    const exact = `TRA${'-'.repeat(61)}`;
    expect(exact).toHaveLength(64);
    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [
        fixedTender('CASH', 20000n, { receivedAmount: 20000n }),
        balanceTender('TRANSFER', { reference: exact, institution: 'GALICIA' }),
      ],
    }));
    expect(result.status).toBe('COMPLETED');
    expect(t.db.extra.externalCollection[0]).toMatchObject({ reference: exact, referenceKey: 'TRA' });
  });

  it('G8 the reference length is counted in Unicode code points, like char_length', async () => {
    const t = setup();
    // 64 code points but 125 UTF-16 units: byte/unit counting would reject it.
    const astral64 = `ABC${'👍'.repeat(61)}`;
    expect([...astral64]).toHaveLength(64);
    expect(astral64.length).toBe(125);

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [
        fixedTender('CASH', 20000n, { receivedAmount: 20000n }),
        balanceTender('TRANSFER', { reference: astral64, institution: 'GALICIA' }),
      ],
    }));
    expect(result.status).toBe('COMPLETED');
    expect(t.db.extra.externalCollection[0]).toMatchObject({ reference: astral64, referenceKey: 'ABC' });

    // 65 code points: over the database's limit.
    const astral65 = `ABC${'👍'.repeat(62)}`;
    expect([...astral65]).toHaveLength(65);
    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t, {
      tenders: [
        fixedTender('CASH', 20000n, { receivedAmount: 20000n }),
        balanceTender('TRANSFER', { reference: astral65, institution: 'GALICIA' }),
      ],
    })), 400, 'VALIDATION_ERROR');
    expect(t.db.extra.externalCollection).toHaveLength(1);
  });
});

describe('R3 checkout — P2002 unique-collision resolution', () => {
  // The double cannot raise a real P2002, so each case injects exactly the error a
  // concurrent peer's commit would raise; when the peer's row must exist, it is
  // committed through simulateConcurrentCommit, applied after our transaction
  // unwinds (the durable state PostgreSQL would leave).
  const threeMethodRequest = (t: Harness, overrides: Partial<CheckoutRequest> = {}) => request(t, {
    balanceMethod: 'CARD_DEBIT',
    expectedTotal: 42500n,
    expectedBalanceAmount: 31500n,
    tenders: [
      fixedTender('TRANSFER', 11000n, { reference: 'OP 88123', institution: 'GALICIA' }),
      balanceTender('CARD_DEBIT', { reference: 'D009' }),
    ],
    ...overrides,
  });

  it('P1 an operationKey collision replays the checkout a peer committed', async () => {
    const t = setup();
    const payload = request(t);
    const checkoutId = randomUUID();
    const completedAt = new Date();
    t.db.simulateConcurrentCommit(() => {
      t.sale().status = 'COMPLETED';
      t.sale().total = 42000n;
      t.db.extra.saleCheckout.push({
        id: checkoutId, saleId: t.saleId, branchId: BRANCH, pricingModel: 'PROPORTIONAL_V1',
        operationKey: payload.operationKey, requestHash: checkoutRequestHash(t.saleId, payload),
        cashSessionId: t.sessionId, balanceMethod: 'TRANSFER', total: 42000n, changeAmount: 0n, completedAt,
      });
      const cash = t.db.insert('salePayment', {
        saleId: t.saleId, method: 'CASH', tenderRole: 'FIXED', amount: 20000n, methodFullPrice: 40000n,
        adjustmentBps: 0, externalCollectionId: null, receivedAmount: 20000n, changeAmount: 0n,
        cashSessionId: t.sessionId, idempotencyKey: `co:${payload.operationKey}:CASH`, paidAt: new Date(completedAt.getTime() - 1000),
      });
      const transfer = t.db.insert('salePayment', {
        saleId: t.saleId, method: 'TRANSFER', tenderRole: 'BALANCE', amount: 22000n, methodFullPrice: 44000n,
        adjustmentBps: 1000, externalCollectionId: null, receivedAmount: null, changeAmount: null,
        cashSessionId: t.sessionId, idempotencyKey: `co:${payload.operationKey}:TRANSFER`, paidAt: completedAt,
      });
      t.db.extra.saleLineAllocation.push(
        { id: randomUUID(), checkoutId, saleId: t.saleId, saleItemId: t.saleItemId, salePaymentId: cash.id, method: 'CASH', amount: 20000n },
        { id: randomUUID(), checkoutId, saleId: t.saleId, saleItemId: t.saleItemId, salePaymentId: transfer.id, method: 'TRANSFER', amount: 22000n },
      );
    });
    t.db.injectUniqueViolation('saleCheckout', 'create', 'operationKey');

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    expect(result).toMatchObject({ replayed: true, checkoutId, status: 'COMPLETED', total: 42000n, changeAmount: 0n });
    expect(result.payments.map((p) => [p.method, p.tenderRole, p.amount])).toEqual([['CASH', 'FIXED', 20000n], ['TRANSFER', 'BALANCE', 22000n]]);
    expect(result.lines).toEqual([{ saleItemId: t.saleItemId, sku: 'REM-01', quantity: 1n, finalAmount: 42000n }]);
    expect(t.counts().payments).toBe(2);
  });

  it('P2 a saleId collision is refused as an already checked-out sale', async () => {
    const t = setup();
    const before = t.counts();
    t.db.injectUniqueViolation('saleCheckout', 'create', 'saleId');

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 409, 'SALE_ALREADY_CHECKED_OUT');
    expect(t.counts()).toEqual(before);
    expect(t.sale()).toMatchObject({ status: 'PENDING_PAYMENT', total: 40000n });
  });

  it('P3 the transfer index is reported with the transfer collection status', async () => {
    const t = setup();
    t.db.simulateConcurrentCommit(() => {
      t.addCollection({
        branchId: BRANCH, method: 'TRANSFER', amount: 11000n, reference: 'OP 88123', referenceKey: 'OP88123',
        institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
      });
    });
    t.db.injectUniqueViolation('externalCollection', 'create', 'ExternalCollection_transfer_ref_key');

    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, threeMethodRequest(t)), 409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED');
    expect(error.details).toEqual({ status: 'UNAPPLIED' });
    expect(t.counts().payments).toBe(0);
    expect(t.db.extra.saleCheckout).toHaveLength(0);
  });

  it('P4 the same reference at ANOTHER institution is not reported as a collision', async () => {
    const t = setup();
    t.db.simulateConcurrentCommit(() => {
      t.addCollection({
        branchId: BRANCH, method: 'TRANSFER', amount: 11000n, reference: 'OP 88123', referenceKey: 'OP88123',
        institution: 'BBVA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
      });
    });
    // The transfer key is (branch, institution, referenceKey): a BBVA peer row does
    // not collide with our GALICIA transfer, so no collision may be invented.
    t.db.injectUniqueViolation('externalCollection', 'create', 'branchId,institution,referenceKey');

    const error = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, threeMethodRequest(t)).then(() => null, (cause: unknown) => cause);
    expect(error).not.toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'P2002' });
    // The peer row survives untouched.
    expect(t.db.extra.externalCollection).toHaveLength(1);
    expect(t.db.extra.externalCollection[0]).toMatchObject({ institution: 'BBVA', status: 'UNAPPLIED' });
  });

  it('P5 a reference of another branch is never read nor surfaced', async () => {
    const t = setup();
    t.addCollection({
      branchId: OTHER_BRANCH, method: 'TRANSFER', amount: 11000n, reference: 'OP 88123', referenceKey: 'OP88123',
      institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.cashier2,
    });
    t.db.injectUniqueViolation('externalCollection', 'create', 'branchId,institution,referenceKey');

    const error = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, threeMethodRequest(t)).then(() => null, (cause: unknown) => cause);
    expect(error).not.toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'P2002' });
    // The other branch's row is untouched and its data never surfaced.
    expect(t.db.extra.externalCollection).toHaveLength(1);
    expect(t.db.extra.externalCollection[0]).toMatchObject({ branchId: OTHER_BRANCH, status: 'UNAPPLIED' });
  });

  it('P6 a debit reference a peer committed is reported (index-name target)', async () => {
    const t = setup();
    t.db.simulateConcurrentCommit(() => {
      t.addCollection({
        branchId: BRANCH, method: 'CARD_DEBIT', amount: 31500n, reference: 'D009', referenceKey: 'D009',
        institution: null, institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
      });
    });
    // Only the debit insert collides: the first (transfer) insert must succeed.
    t.db.injectUniqueViolation('externalCollection', 'create', 'ExternalCollection_debit_ref_key', (args) => (args.data as Row).method === 'CARD_DEBIT');

    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, threeMethodRequest(t)), 409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED');
    expect(error.details).toEqual({ status: 'UNAPPLIED' });
  });

  it('P7 with several references the colliding one is the one reported', async () => {
    const t = setup();
    t.db.simulateConcurrentCommit(() => {
      t.addCollection({
        branchId: BRANCH, method: 'CARD_DEBIT', amount: 31500n, reference: 'D009', referenceKey: 'D009',
        institution: null, institutionOther: null, status: 'REFUNDED', recordedById: t.ids.seller,
        resolvedById: t.ids.cashier, resolvedAt: new Date(), refundReference: 'NC-001',
      });
    });
    // 'OP88123' comes FIRST in the request and exists nowhere; only the debit
    // reference collides. A lookup by the first reference would miss it.
    t.db.injectUniqueViolation('externalCollection', 'create', 'branchId,referenceKey', (args) => (args.data as Row).method === 'CARD_DEBIT');

    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, threeMethodRequest(t)), 409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED');
    expect(error.details).toEqual({ status: 'REFUNDED' });
  });

  it('P8 an ambiguous reference collision fails closed instead of guessing a status', async () => {
    const t = setup();
    t.db.simulateConcurrentCommit(() => {
      t.addCollection({
        branchId: BRANCH, method: 'TRANSFER', amount: 11000n, reference: 'OP 88123', referenceKey: 'OP88123',
        institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
      });
    });
    // 'referenceKey' alone does not say which partial index failed: the debit key is
    // (branch, referenceKey), the transfer key is (branch, institution, referenceKey).
    // An unverifiable collision must never be attributed an arbitrary status.
    t.db.injectUniqueViolation('externalCollection', 'create', 'referenceKey');

    const error = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, threeMethodRequest(t)).then(() => null, (cause: unknown) => cause);
    expect(error).not.toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'P2002' });
    expect(t.counts().payments).toBe(0);
    expect(t.db.extra.saleCheckout).toHaveLength(0);
  });

  // The TRANSFER row and the CARD_DEBIT row carry DIFFERENT statuses, so the answer
  // proves which one was read. Tender order is inverted in two of the four cases:
  // the resolution must follow the index that failed, never the request order.
  it.each([
    { label: 'transfer index, tenders CASH/TRANSFER/CARD_DEBIT', target: 'ExternalCollection_transfer_ref_key', failing: 'TRANSFER', expected: 'UNAPPLIED', inverted: false },
    { label: 'transfer index, inverted tenders (debit first)', target: 'ExternalCollection_transfer_ref_key', failing: 'TRANSFER', expected: 'UNAPPLIED', inverted: true },
    { label: 'debit index, tenders CASH/TRANSFER/CARD_DEBIT', target: 'ExternalCollection_debit_ref_key', failing: 'CARD_DEBIT', expected: 'REFUNDED', inverted: false },
    { label: 'debit index, inverted tenders (debit first)', target: 'ExternalCollection_debit_ref_key', failing: 'CARD_DEBIT', expected: 'REFUNDED', inverted: true },
  ])('P9 $label reports only the method the index identifies', async ({ target, failing, expected, inverted }) => {
    const t = setup();
    t.db.simulateConcurrentCommit(() => {
      t.addCollection({
        branchId: BRANCH, method: 'TRANSFER', amount: 11000n, reference: 'OP 88123', referenceKey: 'OP88123',
        institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
      });
      t.addCollection({
        branchId: BRANCH, method: 'CARD_DEBIT', amount: 31500n, reference: 'D009', referenceKey: 'D009',
        institution: null, institutionOther: null, status: 'REFUNDED', recordedById: t.ids.seller,
        resolvedById: t.ids.cashier, resolvedAt: new Date(), refundReference: 'NC-002',
      });
    });
    // Only the create of the method named by the index collides.
    t.db.injectUniqueViolation('externalCollection', 'create', target, (args) => (args.data as Row).method === failing);

    const tenders = inverted
      ? [balanceTender('CARD_DEBIT', { reference: 'D009' }), fixedTender('TRANSFER', 11000n, { reference: 'OP 88123', institution: 'GALICIA' })]
      : undefined;
    const error = await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, threeMethodRequest(t, tenders ? { tenders } : {})),
      409,
      'EXTERNAL_REFERENCE_ALREADY_RECORDED',
    );
    expect(error.details).toEqual({ status: expected });
  });
});

describe('R3 checkout — atomicity and no duplicated effects', () => {
  it('H1 a failure during finalization rolls back every effect', async () => {
    const t = setup();
    const before = t.counts();
    const inventoryBefore = { ...t.table('inventory')[0]! };
    t.db.injectFailure('inventory', 'update');

    await expect(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t))).rejects.toThrow('injected failure');

    expect(t.counts()).toEqual(before);
    expect(t.table('inventory')[0]).toMatchObject({ physical: inventoryBefore.physical, reserved: inventoryBefore.reserved });
    expect(t.table('stockReservation')[0]).toMatchObject({ status: 'ACTIVE' });
    expect(t.sale()).toMatchObject({ status: 'PENDING_PAYMENT', total: 40000n });
    expect(t.audits('PAYMENT_REGISTERED')).toHaveLength(0);
    expect(t.audits('SALE_COMPLETED')).toHaveLength(0);
    expect(t.db.rawQueries.length).toBeGreaterThan(0);
  });

  it('H2 a successful replay never duplicates payments, movements or audits', async () => {
    const t = setup();
    const payload = request(t);
    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    const after = t.counts();
    for (let index = 0; index < 3; index += 1) await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    expect(t.counts()).toEqual(after);
    expect(t.table('stockMovement')).toHaveLength(1);
    expect(t.table('cashMovement')).toHaveLength(1);
  });

  it('H3 per-payment allocations that only cancel globally revert the whole transaction', async () => {
    const t = setup();
    const before = t.counts();
    // CASH gains exactly what TRANSFER loses: Σ allocations stays 42000 = total,
    // so only the per-payment reconciliation can catch the corruption.
    t.db.addAllocationBias((data) => {
      if (data.method === 'CASH') return { ...data, amount: (data.amount as bigint) + 1000n };
      if (data.method === 'TRANSFER') return { ...data, amount: (data.amount as bigint) - 1000n };
      return data;
    });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, request(t)), 500, 'CHECKOUT_STATE_INCONSISTENT');
    expect(t.counts()).toEqual(before);
    expect(t.sale()).toMatchObject({ status: 'PENDING_PAYMENT', total: 40000n });
    expect(t.table('inventory')[0]).toMatchObject({ physical: 10n, reserved: 1n });
    expect(t.table('stockReservation')[0]).toMatchObject({ status: 'ACTIVE' });
  });
});

describe('R3 checkout — static contract', () => {
  const source = readFileSync(SERVICE_PATH, 'utf8');

  it('I1 opens exactly one Serializable transaction with three attempts', () => {
    // Exactly one Serializable settlement transaction (timeout 30000, 3 tries).
    expect(source.match(/isolationLevel: 'Serializable'/g) ?? []).toHaveLength(1);
    expect(source).toContain('CHECKOUT_TIMEOUT_MS = 30_000');
    expect(source).toContain('timeout: CHECKOUT_TIMEOUT_MS');
    expect(source).toContain('MAX_ATTEMPTS = 3');
    expect(source).toContain('attemptNumber < MAX_ATTEMPTS');
    expect(source).not.toContain('maxWait');
    // Plus the documented, separate P2002 resolution transaction (design §7).
    expect(source.match(/\$transaction\(/g) ?? []).toHaveLength(2);
  });

  it('I2 emits no realtime event inside the module', () => {
    expect(source).not.toContain('.emit(');
    expect(source).not.toContain('realtime');
  });

  it('I3 uses the R3 engine and the shared finalizer instead of copying them', () => {
    expect(source).toContain("from '../pricing/proportional-checkout.js'");
    expect(source).toContain("from '../sales/sale-finalization.js'");
    expect(source).not.toMatch(/\broundPeso\s*\(/);
  });

  it('I4 resolves a unique collision in one fresh, branch-scoped transaction', () => {
    const resolution = source.slice(source.indexOf('async function referenceCollisionStatus'), source.indexOf('async function checkout'));
    expect(resolution).toContain('database.$transaction(');
    expect(resolution).toContain('sale.branchId');
    expect(resolution).toContain('normalizeReferenceKey(tender.reference!)');
    // Only the method the failed index names is consulted, and an unidentifiable
    // index fails closed instead of guessing a method.
    expect(resolution).toContain('candidate.method === method');
    expect(resolution).toContain("collision.method === null");
    // And the per-payment reconciliation lives inside the settlement transaction.
    expect(source).toContain('allocationByPayment');
  });
});
