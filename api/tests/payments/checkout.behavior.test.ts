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
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { confirmationHash } from '../../src/modules/payments/checkout-canonical.js';
import { createCheckoutService } from '../../src/modules/payments/checkout.service.js';
import type { CheckoutConfirmationRequest } from '../../src/modules/payments/dto/checkout.dto.js';
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
type ExtraModel = 'saleCheckout' | 'externalCollection' | 'saleLineAllocation' | 'checkoutAttempt' | 'checkoutAttemptTender';

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
  const extra: Record<ExtraModel, Row[]> = {
    saleCheckout: [], externalCollection: [], saleLineAllocation: [], checkoutAttempt: [], checkoutAttemptTender: [],
  };
  const allocationBiases: Array<(data: Row) => Row> = [];
  const checkoutEvents: string[] = [];
  let attemptTenderReads = 0;

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
    findMany: async (args: AnyArgs = {}) => {
      if (model === 'checkoutAttemptTender') {
        attemptTenderReads += 1;
        checkoutEvents.push('CheckoutAttemptTender');
      }
      return store.filter((row) => matchesWhere(row, args.where)).map((row) => ({ ...row }));
    },
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
    if (/FROM "CheckoutAttempt" WHERE "reserveKey" = \? FOR UPDATE/.test(sql)) {
      record(sql);
      checkoutEvents.push('CheckoutAttempt');
      const attempt = extra.checkoutAttempt.find((row) => row.reserveKey === values[0]);
      return attempt ? [{ ...attempt }] : [];
    }
    if (/FROM "Sale" WHERE id = \? FOR UPDATE/.test(sql)) checkoutEvents.push('Sale');
    return baseQueryRaw(strings, ...values);
  };

  // Test-only seam: what a CONCURRENT peer transaction had already committed when
  // our write collided with it. The mutations are applied only after our
  // transaction unwinds, so this double's rollback cannot erase them — exactly the
  // durable state a committed peer leaves behind in PostgreSQL (which is why the
  // real race cannot be produced here).
  let committedByPeers: Array<() => void> = [];

  const transactions: unknown[] = [];
  const baseTransaction = client.$transaction as (operation: unknown, options?: unknown) => Promise<unknown>;
  client.$transaction = async (operation: unknown, options?: unknown) => {
    transactions.push(options);
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

  // A P2002 exactly as the driver reports it, with the offending unique target:
  // the SQL index name for a partial index, or the column list (string or array)
  // Prisma reports for a declared/derived unique.
  const injectUniqueViolation = (model: string, operation: string, target: string | string[], when?: (args: AnyArgs) => boolean) => {
    const label = Array.isArray(target) ? target.join(',') : target;
    const error = Object.assign(new Error(`Unique constraint failed on the fields: (${label})`), { code: 'P2002', meta: { target } });
    injectFailure(model, operation, error, when);
  };
  // R-1/R-2 (R3 PG gate): the shape @prisma/adapter-pg 7.10 really produces —
  // no meta.target; the constraint is in meta.driverAdapterError.cause.constraint.
  const injectAdapterUniqueViolation = (model: string, operation: string, constraint: { index: string } | { fields: string[] }, when?: (args: AnyArgs) => boolean) => {
    const error = Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { modelName: 'ExternalCollection', driverAdapterError: { name: 'DriverAdapterError', cause: { originalCode: '23505', kind: 'UniqueConstraintViolation', constraint } } },
    });
    injectFailure(model, operation, error, when);
  };

  return {
    ...base, client, extra, transactions, checkoutEvents, injectFailure, injectUniqueViolation, injectAdapterUniqueViolation,
    get attemptTenderReads() { return attemptTenderReads; },
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
  attemptStatus?: string;
  planSealed?: boolean;
  attemptBranchId?: string;
  attemptStartedById?: string;
};

function setup(options: SaleOptions = {}) {
  const db = createCheckoutDb();
  const company = db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  const pricingConfig = db.insert('companyPricingConfig', {
    companyId: company.id,
    listAdjustmentBps: 2000, creditCardAdjustmentBps: 1500, debitCardAdjustmentBps: 500,
    bankTransferAdjustmentBps: 1000, qrAdjustmentBps: 1200,
    updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  db.insert('location', { id: BRANCH, isActive: true });
  db.insert('location', { id: OTHER_BRANCH, isActive: true });
  db.insert('branch', { id: BRANCH, code: 'S1', name: 'Sucursal 1' });
  db.insert('branch', { id: OTHER_BRANCH, code: 'S2', name: 'Sucursal 2' });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), cashier: user('cashier'), cashier2: user('cashier2'), warehouse: user('warehouse'), owner: user('owner'), admin: user('admin') };
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
  const reserveKey = randomUUID();
  const operationKey = randomUUID();
  const attempt = db.extra.checkoutAttempt[0] = {
    id: randomUUID(),
    saleId,
    branchId: options.attemptBranchId ?? BRANCH,
    reserveKey,
    operationKey,
    planHash: 'a'.repeat(64),
    planSealed: options.planSealed ?? true,
    status: options.attemptStatus ?? 'RESERVED',
    startedById: options.attemptStartedById ?? ids.cashier,
    confirmationHash: null as string | null,
    confirmedById: null,
    confirmedAt: null,
    confirmReason: null,
    confirmEvidence: null,
    rejectedById: null,
    rejectionCode: null,
    rejectionDetails: null,
    rejectedAt: null,
    // R3-A4.3 S6: set by T-X (close/declaration); NULL until then.
    declaredAt: null,
    // R3-A4.3 S5-D: the SEALED snapshot T-C settles from — coherent with the
    // default plan below (one CASH BALANCE tender over one 40000-centavo line).
    cashSessionId: session.id,
    balanceMethod: 'CASH',
    expectedTotal: 40000n,
    expectedBalanceAmount: 40000n,
    tenderCount: 1,
    fullPriceCash: 40000n,
    fullPriceTransfer: 44000n,
    fullPriceDebit: 42000n,
    fullPriceCredit: null,
    fullPriceQr: null,
    transferAdjustmentBps: 1000,
    debitAdjustmentBps: 500,
    creditAdjustmentBps: null,
    qrAdjustmentBps: null,
    pricingConfigId: pricingConfig.id,
    pricingConfigUpdatedAt: pricingConfig.updatedAt,
    algorithmVersion: 1,
  };
  db.extra.checkoutAttemptTender.push({
    id: randomUUID(),
    attemptId: attempt.id,
    branchId: attempt.branchId,
    method: 'CASH',
    role: 'BALANCE',
    source: 'NEW',
    amount: null,
    externalCollectionId: null,
  });
  const addCollection = (data: Row) => {
    const row: Row & { id: string } = { id: randomUUID(), ...data };
    db.extra.externalCollection.push(row);
    return row;
  };

  const reqs = {
    cashier: requestFor(ids.cashier, [assignment('CASHIER', BRANCH)]),
    cashier2: requestFor(ids.cashier2, [assignment('CASHIER', OTHER_BRANCH)]),
    seller: requestFor(ids.seller, [assignment('SELLER', BRANCH)]),
    warehouse: requestFor(ids.warehouse, [assignment('WAREHOUSE', BRANCH)]),
    owner: requestFor(ids.owner, [assignment('OWNER', null)]),
    admin: requestFor(ids.admin, [assignment('ADMIN', null)]),
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
  const confirmation = (overrides: Partial<CheckoutConfirmationRequest> = {}): CheckoutConfirmationRequest => ({
    reserveKey,
    operationKey,
    tenders: [{
      method: 'CASH',
      receivedAmount: 42000n,
      reference: null,
      referenceKey: null,
      institution: null,
      institutionOther: null,
    }],
    supervisor: null,
    ...overrides,
  });
  const setPlanTenders = (tenders: Row[]) => {
    db.extra.checkoutAttemptTender.length = 0;
    db.extra.checkoutAttemptTender.push(...tenders.map((tender) => ({
      id: randomUUID(), attemptId: attempt.id, branchId: attempt.branchId, ...tender,
    })));
  };
  // The sealed snapshot is IMMUTABLE in the real schema (F1 freezes the plan
  // columns); a test that changes the plan must also re-seal its snapshot.
  // It always writes the store's CURRENT row: after a rolled-back call the
  // double restores a clone, and `attempt` would then be detached.
  const storedAttempt = () => db.extra.checkoutAttempt[0]!;
  const setSnapshot = (patch: Row) => { Object.assign(storedAttempt(), patch); };
  // Reseals a plan together with a snapshot whose total reconciles with it, so a
  // custom plan stays coherent with what T-C derives.
  const sealPlan = (tenders: Row[], snapshot: Row = {}) => {
    setPlanTenders(tenders);
    const balanceAmount = (snapshot.expectedBalanceAmount ?? storedAttempt().expectedBalanceAmount) as bigint;
    const total = tenders.reduce<bigint>(
      (sum, tender) => sum + (tender.role === 'BALANCE' ? balanceAmount : (tender.amount as bigint)),
      0n,
    );
    setSnapshot({ tenderCount: tenders.length, expectedTotal: total, ...snapshot });
  };
  const hashConfirmation = (payload: CheckoutConfirmationRequest) => confirmationHash({
    planHash: String(attempt.planHash),
    reserveKey: String(attempt.reserveKey),
    operationKey: String(attempt.operationKey),
    tenders: payload.tenders.map((tender) => ({
      method: tender.method,
      receivedAmount: tender.receivedAmount,
      referenceKey: tender.referenceKey,
      institution: tender.institution,
      institutionOther: tender.institutionOther,
    })),
  });

  const lockOrder = () =>
    db.rawQueries
      .map((sql): string | null => {
        if (/FROM "Sale" WHERE id = \? FOR UPDATE/.test(sql)) return 'Sale';
        if (/FROM "CheckoutAttempt" WHERE "reserveKey" = \? FOR UPDATE/.test(sql)) return 'CheckoutAttempt';
        if (/FROM "ExternalCollection"/.test(sql)) return 'ExternalCollection';
        if (/JOIN "CashRegister"/.test(sql)) return 'CashSession';
        if (/FROM "StockReservation"/.test(sql)) return 'StockReservation';
        if (/FROM "Inventory"/.test(sql)) return 'Inventory';
        return null;
      })
      .filter((value): value is string => value !== null);

  return {
    db, client, checkout, ids, reqs, saleId, saleItemId, variantId, addSale, addCollection, attempt, confirmation,
    setPlanTenders, setSnapshot, sealPlan, hashConfirmation, storedAttempt,
    sessionId: session.id as string, otherSessionId: otherSession.id as string, table, counts, sale, audits, lockOrder,
  };
}

type Harness = ReturnType<typeof setup>;

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected AppError ${status} ${code}`).toBeInstanceOf(AppError);
  expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status, code });
  return error as AppError;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('R3-A4.3 S5-B — reserved attempt identity and authority', () => {
  it('S5B-01 settles a valid RESERVED attempt, locking Sale before CheckoutAttempt', async () => {
    const t = setup();

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation());

    expect(result).toMatchObject({ status: 'COMPLETED', replayed: false, total: 40000n, changeAmount: 2000n });
    // The mandated lock order, WITHOUT an ExternalCollection (a CASH-only plan).
    expect(t.lockOrder().slice(0, 5)).toEqual(['Sale', 'CheckoutAttempt', 'CashSession', 'StockReservation', 'Inventory']);
    // The finalizer re-locks the sale, its reservations and its inventory in the
    // same prefix (never a second transaction).
    expect(t.lockOrder().slice(5, 8)).toEqual(['Sale', 'StockReservation', 'Inventory']);
    expect(t.db.transactions.at(-1)).toEqual({ isolationLevel: 'Serializable', timeout: 30_000 });
    expect(t.attempt.status).toBe('CONFIRMED');
    expect(t.attempt.confirmationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(t.attempt.confirmedById).toBe(t.ids.cashier);
    expect(t.attempt.confirmReason).toBeNull();
    expect(t.sale().status).toBe('COMPLETED');
  });

  it('S5B-02 a missing reserveKey is indistinguishable from a missing attempt', async () => {
    const t = setup();
    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({ reserveKey: randomUUID() })),
      404,
      'NOT_FOUND',
    );
  });

  it('S5B-03 an attempt belonging to another sale returns only generic not-found', async () => {
    const t = setup();
    t.attempt.saleId = randomUUID();

    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()),
      404,
      'NOT_FOUND',
    );
  });

  it('S5B-04 an attempt with another branch than the locked sale returns generic not-found', async () => {
    const t = setup();
    t.attempt.branchId = OTHER_BRANCH;

    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()),
      404,
      'NOT_FOUND',
    );
  });

  it('S5B-05 an operationKey different from the reserved one fails closed', async () => {
    const t = setup();
    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({ operationKey: randomUUID() })),
      409,
      'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
    );
  });

  it('S5B-06 an unsealed attempt is an internal state inconsistency', async () => {
    const t = setup({ planSealed: false });
    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()),
      500,
      'CHECKOUT_STATE_INCONSISTENT',
    );
  });

  it('S5B-07 an ABANDONED attempt is not treated as a new confirmation', async () => {
    const t = setup({ attemptStatus: 'ABANDONED' });
    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()),
      409,
      'CHECKOUT_RESERVATION_CLOSED',
    );
  });

  it('S5B-07b a REJECTED attempt replays its OWN persisted rejection (S5-D.1)', async () => {
    const t = setup({ attemptStatus: 'REJECTED' });
    t.setSnapshot({ rejectionCode: 'NO_OPEN_CASH_SESSION', rejectionDetails: { source: 'setup' } });
    const error = await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()),
      409,
      'NO_OPEN_CASH_SESSION',
    );
    expect(error.details).toMatchObject({ source: 'setup', attempt: { status: 'REJECTED' } });
  });

  it.each([
    ['SALE_CHARGE', PRODUCTION_PERMISSIONS.SALE_COMPLETE],
    ['SALE_COMPLETE', PRODUCTION_PERMISSIONS.SALE_CHARGE],
  ])('S5B-08 the initiator is refused when %s is missing at the sale branch', async (_missing, grantedPermission) => {
    const t = setup();
    const cashierAssignment = {
      ...assignment('CASHIER', BRANCH),
      permissions: [grantedPermission],
    };
    const initiator = requestFor(t.ids.cashier, [cashierAssignment]);

    await expectAppError(
      t.checkout.checkout(initiator, t.ids.cashier, t.saleId, t.confirmation()),
      403,
      'FORBIDDEN',
    );
  });

  it('S5B-09 a different user cannot confirm without supervisor justification', async () => {
    const t = setup();
    await expectAppError(
      t.checkout.checkout(t.reqs.admin, t.ids.admin, t.saleId, t.confirmation()),
      403,
      'FORBIDDEN',
    );
  });

  it('S5B-10 a different user with justification but without supervisor authority is refused', async () => {
    const t = setup();
    await expectAppError(
      t.checkout.checkout(
        t.reqs.seller,
        t.ids.seller,
        t.saleId,
        t.confirmation({ supervisor: { reason: 'Confirmación excepcional', evidence: 'Ticket POS 482' } }),
      ),
      403,
      'FORBIDDEN',
    );
  });

  it('S5B-11 a supervisor settles and records the justification on the attempt', async () => {
    const t = setup();
    const confirmation = t.confirmation({
      supervisor: { reason: 'Confirmación excepcional', evidence: 'Ticket POS 482' },
    });

    const result = await t.checkout.checkout(t.reqs.admin, t.ids.admin, t.saleId, confirmation);

    expect(result).toMatchObject({ status: 'COMPLETED', total: 40000n });
    expect(t.attempt).toMatchObject({
      status: 'CONFIRMED',
      confirmedById: t.ids.admin,
      confirmReason: 'Confirmación excepcional',
      confirmEvidence: 'Ticket POS 482',
    });
    // The supervisor's reason travels in the SALE_CHECKOUT_COMPLETED audit, not
    // in a separate row.
    expect(t.audits('PAYMENT_REGISTERED')).toHaveLength(1);
    expect(t.audits('SALE_CHECKOUT_COMPLETED')[0]!.after).toMatchObject({
      supervisor: { byId: t.ids.admin, reason: 'Confirmación excepcional' },
    });
  });

  it('S5B-12 supervisor authority uses the locked sale branch, never request data', async () => {
    const t = setup();
    const confirmation = t.confirmation({
      supervisor: { reason: 'Confirmación excepcional', evidence: 'Ticket POS 482' },
    });
    // The request cannot choose the branch: the locked sale's branch decides.
    Object.assign(confirmation, { branchId: '' });

    const result = await t.checkout.checkout(t.reqs.admin, t.ids.admin, t.saleId, confirmation);

    expect(result).toMatchObject({ status: 'COMPLETED' });
    expect(t.attempt.confirmedById).toBe(t.ids.admin);
  });
});

describe('R3-A4.3 S5-C — sealed plan and confirmation replay', () => {
    const tender = (
      method: 'CASH' | 'TRANSFER' | 'CARD_DEBIT',
      fields: Partial<CheckoutConfirmationRequest['tenders'][number]> = {},
    ): CheckoutConfirmationRequest['tenders'][number] => ({
      method,
      receivedAmount: method === 'CASH' ? 42000n : null,
      reference: null,
      referenceKey: null,
      institution: null,
      institutionOther: null,
      ...fields,
    });

    const seedConfirmedCheckout = (
      t: Harness,
      payload = t.confirmation(),
      patch: Row = {},
    ) => {
      const hash = t.hashConfirmation(payload);
      t.attempt.status = 'CONFIRMED';
      t.attempt.confirmationHash = hash;
      t.sale().status = 'COMPLETED';
      t.db.extra.saleCheckout.push({
        id: randomUUID(),
        saleId: t.saleId,
        branchId: BRANCH,
        operationKey: t.attempt.operationKey,
        requestHash: hash,
        attemptStatus: 'CONFIRMED',
        total: 42000n,
        changeAmount: 0n,
        completedAt: new Date('2026-10-16T12:00:00.000Z'),
        ...patch,
      });
      return hash;
    };

    it('S5C-01 reads CheckoutAttemptTender after both identity locks', async () => {
      const t = setup();
      await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation());
      expect(t.lockOrder().slice(0, 2)).toEqual(['Sale', 'CheckoutAttempt']);
      expect(t.db.attemptTenderReads).toBe(1);
      // The tender read happens strictly after both identity locks.
      expect(t.db.checkoutEvents.slice(0, 3)).toEqual(['Sale', 'CheckoutAttempt', 'CheckoutAttemptTender']);
    });

    it.each([
      [
        'missing CASH',
        [
          { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 20000n, externalCollectionId: null },
          { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 22000n, externalCollectionId: randomUUID() },
        ],
        [tender('TRANSFER')],
      ],
      [
        'missing TRANSFER',
        [
          { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 20000n, externalCollectionId: null },
          { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 22000n, externalCollectionId: randomUUID() },
        ],
        [tender('CASH')],
      ],
      [
        'extra TRANSFER',
        [{ method: 'CASH', role: 'FIXED', source: 'NEW', amount: 40000n, externalCollectionId: null }],
        [tender('CASH'), tender('TRANSFER', { reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA' })],
      ],
      [
        'duplicate CASH',
        [{ method: 'CASH', role: 'FIXED', source: 'NEW', amount: 40000n, externalCollectionId: null }],
        [tender('CASH'), tender('CASH')],
      ],
    ])('S5C-02 rejects a confirmation with %s relative to the sealed method set', async (_label, planTenders, tenders) => {
      const t = setup();
      t.setPlanTenders(planTenders);
      await expectAppError(
        t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({ tenders })),
        400,
        'VALIDATION_ERROR',
      );
    });

    it('S5C-03 derives role, source, amount and collection identity only from sealed tenders', async () => {
      const t = setup();
      const confirmation = t.confirmation({
        tenders: [tender('CASH', { receivedAmount: 42000n })],
      });
      // The request lies about role, source, amount and collection identity. None
      // of it reaches the settlement: the sealed tender decides every one.
      Object.assign(confirmation.tenders[0]!, {
        role: 'FIXED',
        source: 'COLLECTION',
        amount: 1n,
        externalCollectionId: randomUUID(),
      });

      const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, confirmation);

      expect(result).toMatchObject({ total: 40000n, changeAmount: 2000n });
      expect(t.db.extra.checkoutAttemptTender[0]).toMatchObject({
        role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null,
      });
      expect(t.table('salePayment')[0]).toMatchObject({
        method: 'CASH', amount: 40000n, tenderRole: 'BALANCE', adjustmentBps: 0,
        externalCollectionId: null, receivedAmount: 42000n, changeAmount: 2000n,
      });
      expect(t.db.extra.externalCollection).toEqual([]);
      expect(t.attempt.status).toBe('CONFIRMED');
    });

    it.each<[string, Partial<CheckoutConfirmationRequest['tenders'][number]>]>([
      ['reference', { reference: 'OP 123', referenceKey: 'OP123' }],
      ['institution', { institution: 'GALICIA' }],
      ['institutionOther', { institutionOther: 'Banco X' }],
    ])('S5C-04 COLLECTION TRANSFER rejects request %s evidence', async (_field, fields) => {
      const t = setup();
      t.setPlanTenders([
        { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 22000n, externalCollectionId: randomUUID() },
      ]);

      await expectAppError(
        t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
          tenders: [tender('TRANSFER', fields)],
        })),
        400,
        'VALIDATION_ERROR',
      );
    });

    it('S5C-05 COLLECTION confirmation applies the claimed collection and creates no new one', async () => {
      const t = setup();
      const collection = t.addCollection({
        branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'TR 1', referenceKey: 'TR1',
        institution: 'GALICIA', status: 'UNAPPLIED', originSaleId: t.saleId, claimAttemptId: String(t.attempt.id),
      });
      t.sealPlan([
        { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 22000n, externalCollectionId: collection.id },
      ]);

      const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
        tenders: [tender('TRANSFER')],
      }));

      expect(result).toMatchObject({ total: 22000n, changeAmount: 0n });
      // Exactly the claimed collection: no new ExternalCollection row.
      expect(t.db.extra.externalCollection).toHaveLength(1);
      expect(collection).toMatchObject({
        status: 'APPLIED', appliedSaleId: t.saleId, appliedCheckoutId: result.checkoutId,
      });
      expect(t.table('salePayment')[0]).toMatchObject({
        method: 'TRANSFER', amount: 22000n, tenderRole: 'FIXED', methodFullPrice: 44000n,
        adjustmentBps: 1000, externalCollectionId: collection.id,
      });
      expect(t.audits('EXTERNAL_COLLECTION_APPLIED')).toHaveLength(1);
    });

    it.each<[string, Partial<CheckoutConfirmationRequest['tenders'][number]>]>([
      ['missing reference', { institution: 'GALICIA' }],
      ['missing institution', { reference: 'OP 123', referenceKey: 'OP123' }],
      ['OTHER missing institutionOther', { reference: 'OP 123', referenceKey: 'OP123', institution: 'OTHER' }],
    ])('S5C-06 NEW TRANSFER rejects %s', async (_label, fields) => {
      const t = setup();
      t.setPlanTenders([
        { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 22000n, externalCollectionId: null },
      ]);
      await expectAppError(
        t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
          tenders: [tender('TRANSFER', fields)],
        })),
        400,
        'VALIDATION_ERROR',
      );
    });

    it('S5C-07 NEW TRANSFER with reference and institution is accepted from sealed plan', async () => {
      const t = setup();
      t.sealPlan([
        { method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      ], { balanceMethod: 'TRANSFER', expectedBalanceAmount: 44000n });

      const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
        tenders: [tender('TRANSFER', { reference: 'OP 123', referenceKey: 'OP123', institution: 'GALICIA' })],
      }));

      expect(result).toMatchObject({ total: 44000n, changeAmount: 0n });
      expect(t.db.extra.externalCollection).toHaveLength(1);
      expect(t.db.extra.externalCollection[0]).toMatchObject({
        branchId: BRANCH, method: 'TRANSFER', amount: 44000n, reference: 'OP 123', referenceKey: 'OP123',
        institution: 'GALICIA', status: 'APPLIED', originSaleId: t.saleId, recordedById: t.ids.cashier,
      });
      expect(t.table('salePayment')[0]).toMatchObject({
        method: 'TRANSFER', amount: 44000n, tenderRole: 'BALANCE', methodFullPrice: 44000n, adjustmentBps: 1000,
        externalCollectionId: t.db.extra.externalCollection[0]!.id,
      });
    });

    it.each<[string, Partial<CheckoutConfirmationRequest['tenders'][number]>]>([
      ['missing reference', {}],
      ['institution', { reference: 'DEBIT 123', referenceKey: 'DEBIT123', institution: 'GALICIA' }],
    ])('S5C-08 NEW CARD_DEBIT rejects %s', async (_label, fields) => {
      const t = setup();
      t.setPlanTenders([
        { method: 'CARD_DEBIT', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      ]);
      await expectAppError(
        t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
          tenders: [tender('CARD_DEBIT', fields)],
        })),
        400,
        'VALIDATION_ERROR',
      );
    });

    it('S5C-09 CASH requires sufficient received money and derives change from its sealed amount', async () => {
      const t = setup();
      await expectAppError(
        t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
          tenders: [tender('CASH', { receivedAmount: null })],
        })),
        400,
        'VALIDATION_ERROR',
      );
      await expectAppError(
        t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
          tenders: [tender('CASH', { receivedAmount: 39999n })],
        })),
        400,
        'VALIDATION_ERROR',
      );
      const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
        tenders: [tender('CASH', { receivedAmount: 42000n })],
      }));
      // The sealed amount (the balance) is the money; the change is derived from
      // it, never from the received money.
      expect(result).toMatchObject({ total: 40000n, changeAmount: 2000n });
      expect(t.table('salePayment')[0]).toMatchObject({ amount: 40000n, receivedAmount: 42000n, changeAmount: 2000n });
      // CASH-1: the net cash income is the sealed amount, not the received money.
      expect(t.table('cashMovement')[0]).toMatchObject({ amount: 40000n, type: 'SALE_INCOME' });
    });

    it('S5C-10 hashes the normalized confirmation with the locked plan and attempt identity', async () => {
      const t = setup();
      const payload = t.confirmation({
        tenders: [tender('CASH', { receivedAmount: 42000n })],
      });
      const expectedHash = confirmationHash({
        planHash: String(t.attempt.planHash),
        reserveKey: String(t.attempt.reserveKey),
        operationKey: String(t.attempt.operationKey),
        tenders: payload.tenders.map(({ method, receivedAmount, referenceKey, institution, institutionOther }) => ({
          method, receivedAmount, referenceKey, institution, institutionOther,
        })),
      });

      await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);

      // The persisted confirmation hash IS the canonical hash of the SEALED plan
      // identity plus the normalised confirmation.
      expect(expectedHash).toMatch(/^[0-9a-f]{64}$/);
      expect(t.attempt.confirmationHash).toBe(expectedHash);
      expect(t.db.extra.saleCheckout[0]!.requestHash).toBe(expectedHash);
      expect(t.attempt.planHash).toBe('a'.repeat(64));
    });

    it('S5C-11 CONFIRMED with the same hash replays the persisted checkout', async () => {
      const t = setup();
      const payload = t.confirmation();
      const hash = seedConfirmedCheckout(t, payload);

      const replay = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);

      expect(replay).toMatchObject({ replayed: true, checkoutId: expect.any(String) });
      expect(t.attempt.confirmationHash).toBe(hash);
      expect(t.counts().payments).toBe(0);
    });

    it('S5C-12 CONFIRMED with a different hash fails closed', async () => {
      const t = setup();
      seedConfirmedCheckout(t);
      await expectAppError(
        t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
          tenders: [tender('CASH', { receivedAmount: 43000n })],
        })),
        409,
        'CHECKOUT_CONFIRMATION_HASH_MISMATCH',
      );
    });

    it('S5C-13 an ABANDONED attempt cannot confirm', async () => {
      const t = setup({ attemptStatus: 'ABANDONED' });
      await expectAppError(
        t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()),
        409,
        'CHECKOUT_RESERVATION_CLOSED',
      );
    });

    it('S5C-14 CONFIRMED without a coherent SaleCheckout fails as inconsistent state', async () => {
      const t = setup({ attemptStatus: 'CONFIRMED' });
      t.attempt.confirmationHash = t.hashConfirmation(t.confirmation());
      await expectAppError(
        t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()),
        500,
        'CHECKOUT_STATE_INCONSISTENT',
      );
    });

    it('S5C-15 CONFIRMED without a confirmationHash fails as inconsistent state', async () => {
      const t = setup({ attemptStatus: 'CONFIRMED' });
      await expectAppError(
        t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()),
        500,
        'CHECKOUT_STATE_INCONSISTENT',
      );
    });
  });
// ---------------------------------------------------------------------------
// R3-A4.3 S5-D — the real, atomic, durable T-C settlement.
//
// Eleven groups: (1) CASH-only success, (2) atomicity rollback, (3) stock,
// (4) cash session, (5) idempotency/replay, (6) bounded concurrency retries,
// (7) the mandated lock order with and without an ExternalCollection, (8) the
// sealed snapshot (never a live pricing read), (9) CASH change math,
// (10) supervisor audit, (11) realtime only after commit.
//
// Every amount here comes from the SEALED attempt: `setup()` seals one CASH
// BALANCE tender over one 40000-centavo line (see the snapshot in the
// harness), so the money is the seal's, not the request's.
// ---------------------------------------------------------------------------
describe('R3-A4.3 S5-D — atomic T-C settlement', () => {
  const sealedTender = (
    method: 'CASH' | 'TRANSFER' | 'CARD_DEBIT',
    fields: Partial<CheckoutConfirmationRequest['tenders'][number]> = {},
  ): CheckoutConfirmationRequest['tenders'][number] => ({
    method,
    receivedAmount: method === 'CASH' ? 42000n : null,
    reference: null,
    referenceKey: null,
    institution: null,
    institutionOther: null,
    ...fields,
  });

  const planTender = (
    method: string, role: string, source: string, amount: bigint | null, externalCollectionId: string | null = null,
  ) => ({ method, role, source, amount, externalCollectionId });

  // The whole effect set of a rolled-back confirmation.
  const noEffects = {
    checkouts: 0, collections: 0, allocations: 0, payments: 0, stockMovements: 0, cashMovements: 0, audits: 0,
  };

  // A driver-reported transient Serializable conflict.
  const writeConflict = () => Object.assign(new Error('TransactionWriteConflict'), { code: 'P2034' });

  // Makes the next `count` transactions fail with `error` BEFORE they start, the
  // way a real Serializable conflict rolls back without applying anything.
  const failTransactions = (t: Harness, count: number, error: unknown) => {
    const client = t.db.client as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> };
    const original = client.$transaction.bind(t.db.client);
    let calls = 0;
    client.$transaction = async (operation: unknown, options?: unknown) => {
      calls += 1;
      if (calls <= count) throw error;
      return original(operation, options);
    };
    return () => calls;
  };

  // Group 1 — CASH-only success
  it('S5D-01 a CASH-only attempt settles PAID -> COMPLETED with one coherent row set', async () => {
    const t = setup();

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation());

    expect(result).toMatchObject({
      saleId: t.saleId, status: 'COMPLETED', replayed: false, total: 40000n, changeAmount: 2000n,
    });
    expect(result.completedAt).toBeInstanceOf(Date);
    expect(result.lines).toEqual([{ saleItemId: t.saleItemId, sku: 'REM-01', quantity: 1n, finalAmount: 40000n }]);
    expect(t.sale()).toMatchObject({ status: 'COMPLETED', total: 40000n });
    expect(t.storedAttempt()).toMatchObject({ status: 'CONFIRMED', confirmedById: t.ids.cashier });
    expect(t.db.extra.saleCheckout).toHaveLength(1);
    expect(t.db.extra.saleCheckout[0]).toMatchObject({
      saleId: t.saleId, branchId: BRANCH, pricingModel: 'PROPORTIONAL_V1',
      cashSessionId: t.sessionId, userId: t.ids.cashier, balanceMethod: 'CASH',
      referenceSubtotal: 40000n, total: 40000n, changeAmount: 2000n,
      fullPriceCash: 40000n, fullPriceTransfer: 44000n, fullPriceDebit: 42000n,
      transferAdjustmentBps: 1000, debitAdjustmentBps: 500, algorithmVersion: 1,
      attemptStatus: 'CONFIRMED',
    });
    expect(t.db.extra.saleCheckout[0]!.requestHash).toBe(t.storedAttempt().confirmationHash);
    expect(t.table('salePayment')[0]).toMatchObject({
      saleId: t.saleId, method: 'CASH', amount: 40000n, pricingModel: 'PROPORTIONAL_V1',
      tenderRole: 'BALANCE', methodFullPrice: 40000n, adjustmentBps: 0,
      receivedAmount: 42000n, changeAmount: 2000n, externalCollectionId: null,
      checkoutId: t.db.extra.saleCheckout[0]!.id, cashSessionId: t.sessionId,
    });
    expect(t.db.extra.saleLineAllocation).toHaveLength(1);
    expect(t.db.extra.saleLineAllocation[0]).toMatchObject({
      checkoutId: t.db.extra.saleCheckout[0]!.id, saleId: t.saleId, saleItemId: t.saleItemId,
      method: 'CASH', quantity: 1n, baseUnitPrice: 40000n, unitPrice: 40000n, lineFullPrice: 40000n, amount: 40000n,
    });
    expect(t.counts()).toMatchObject({
      checkouts: 1, collections: 0, allocations: 1, payments: 1, cashMovements: 1, stockMovements: 1,
    });
    expect(t.audits('PAYMENT_REGISTERED')).toHaveLength(1);
    expect(t.audits('EXTERNAL_COLLECTION_APPLIED')).toHaveLength(0);
    expect(t.audits('SALE_COMPLETED')).toHaveLength(1);
    // Inventory deducted once and the hold consumed once, never twice.
    expect(t.table('inventory')[0]).toMatchObject({ physical: 9n, reserved: 0n });
    expect(t.table('stockReservation')[0]).toMatchObject({ status: 'CONSUMED' });
  });

  // Group 2 — atomicity rollback
  it('S5D-02 a failure after the payments are written rolls EVERY effect back', async () => {
    const t = setup();
    t.db.injectFailure('cashMovement', 'create');

    await expect(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()),
    ).rejects.toThrow('injected failure');

    expect(t.counts()).toEqual(noEffects);
    expect(t.sale()).toMatchObject({ status: 'PENDING_PAYMENT', total: 40000n });
    expect(t.storedAttempt()).toMatchObject({ status: 'RESERVED', confirmationHash: null });
    // The finalizer's inventory deduction and hold consumption revert too.
    expect(t.table('inventory')[0]).toMatchObject({ physical: 10n, reserved: 1n });
    expect(t.table('stockReservation')[0]).toMatchObject({ status: 'ACTIVE' });
  });

  it('S5D-02b an allocation that reconciles globally but not per payment reverts everything', async () => {
    const t = setup();
    const collection = t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 44000n, reference: 'TR 2', referenceKey: 'TR2',
      institution: 'GALICIA', status: 'UNAPPLIED', originSaleId: t.saleId, claimAttemptId: String(t.storedAttempt().id),
    });
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'COLLECTION', 44000n, collection.id),
    ]);
    // Move 100 centavos from the second allocation to the first: the two still
    // sum to the sale total, so ONLY the per-payment reconciliation can catch it.
    let seen = 0;
    t.db.addAllocationBias((data) => {
      seen += 1;
      return seen === 1
        ? { ...data, amount: (data.amount as bigint) + 100n }
        : { ...data, amount: (data.amount as bigint) - 100n };
    });

    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
        tenders: [sealedTender('CASH', { receivedAmount: 40000n }), sealedTender('TRANSFER')],
      })),
      500,
      'CHECKOUT_STATE_INCONSISTENT',
    );

    // Only the seeded collection remains, still UNAPPLIED.
    expect(t.counts()).toEqual({ ...noEffects, collections: 1 });
    expect(t.sale()).toMatchObject({ status: 'PENDING_PAYMENT', total: 40000n });
    expect(t.storedAttempt()).toMatchObject({ status: 'RESERVED' });
    expect(t.db.extra.externalCollection[0]).toMatchObject({ status: 'UNAPPLIED' });
  });

  // Group 3 — stock
  // OWNER 2026-10-20 (OPTION_B_NON_EXPIRING_COMMITMENT): a normal sale's hold is a
  // commitment that no clock ends. A hold whose review date (expiresAt) passed
  // long ago still backs the sale, so the proportional checkout settles it and
  // the finalizer consumes exactly that hold (RED 3 + RED 4 regression).
  it('S5D-03 a hold past its review date still settles PAID -> COMPLETED and is consumed once', async () => {
    const t = setup({ expiresInMs: -24 * 60 * 60 * 1000 });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation());

    expect(result).toMatchObject({ saleId: t.saleId, status: 'COMPLETED', replayed: false, total: 40000n });
    expect(t.storedAttempt()).toMatchObject({ status: 'CONFIRMED' });
    expect(t.table('inventory')[0]).toMatchObject({ physical: 9n, reserved: 0n });
    expect(t.table('stockReservation')[0]).toMatchObject({ status: 'CONSUMED' });
    expect(t.audits('SALE_COMPLETED')).toHaveLength(1);
  });

  it('S5D-03b a released hold (no ACTIVE coverage left) is a CORRECTABLE 409', async () => {
    const t = setup({ withReservation: false });

    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'STOCK_HOLD_RELEASED');

    expect(error.details).toMatchObject({ observedStatus: 'RESERVED', stockState: 'RELEASED' });
    expect(t.storedAttempt().status).toBe('RESERVED');
  });

  it('S5D-03c a hold that does not cover the items is a CORRECTABLE 409', async () => {
    const t = setup({ reservationQuantity: 2n });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'STOCK_HOLD_RELEASED');

    expect(t.counts()).toEqual(noEffects);
    expect(t.storedAttempt().status).toBe('RESERVED');
  });

  it('S5D-03d insufficient PHYSICAL stock TERMINALLY rejects the attempt', async () => {
    const t = setup({ physical: 0n });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'INSUFFICIENT_PHYSICAL');

    expect(t.storedAttempt()).toMatchObject({
      status: 'REJECTED', rejectionCode: 'INSUFFICIENT_PHYSICAL', rejectedById: t.ids.cashier,
    });
    expect(t.storedAttempt().rejectedAt).toBeInstanceOf(Date);
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, allocations: 0, cashMovements: 0 });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
    expect(t.sale().status).toBe('PENDING_PAYMENT');
  });

  it('S5D-03e insufficient RESERVED stock TERMINALLY rejects the attempt', async () => {
    const t = setup({ reserved: 0n });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'INSUFFICIENT_RESERVED');

    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'INSUFFICIENT_RESERVED' });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
  });

  // Group 4 — cash session
  it('S5D-04 a closed cash session TERMINALLY rejects the attempt', async () => {
    const t = setup();
    t.table('cashSession')[0]!.status = 'CLOSED';

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'NO_OPEN_CASH_SESSION');

    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'NO_OPEN_CASH_SESSION' });
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, allocations: 0, cashMovements: 0 });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
  });

  it('S5D-04b a cash session of ANOTHER branch TERMINALLY rejects the attempt', async () => {
    const t = setup();
    t.setSnapshot({ cashSessionId: t.otherSessionId });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'CASH_SESSION_BRANCH_MISMATCH');

    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'CASH_SESSION_BRANCH_MISMATCH' });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
  });

  // Group 5 — idempotency and replay
  it('S5D-05 replaying the SAME confirmation after a settlement writes nothing new', async () => {
    const t = setup();
    const payload = t.confirmation();
    const first = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    const before = t.counts();
    const confirmedAt = t.storedAttempt().confirmedAt;

    const again = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);

    expect(again).toMatchObject({ replayed: true, checkoutId: first.checkoutId, total: 40000n, changeAmount: 2000n, status: 'COMPLETED' });
    expect(again.payments[0]).toMatchObject({ amount: 40000n, receivedAmount: 42000n, changeAmount: 2000n });
    expect(t.counts()).toEqual(before);
    expect(t.sale().status).toBe('COMPLETED');
    expect(t.storedAttempt().confirmedAt).toBe(confirmedAt);
  });

  it('S5D-05b the same attempt with ANOTHER operationKey is refused and writes nothing', async () => {
    const t = setup();

    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({ operationKey: randomUUID() })),
      409,
      'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
    );

    expect(t.counts()).toEqual(noEffects);
    expect(t.storedAttempt().status).toBe('RESERVED');
  });

  it('S5D-05c a dead sale TERMINALLY rejects the attempt instead of leaving it RESERVED', async () => {
    const t = setup({ status: 'COMPLETED' });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'INVALID_SALE_STATE');

    expect(t.storedAttempt()).toMatchObject({
      status: 'REJECTED', rejectionCode: 'INVALID_SALE_STATE', rejectedById: t.ids.cashier,
    });
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, allocations: 0, cashMovements: 0 });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
  });

  // Group 6 — bounded concurrency retries
  it('S5D-06 a transient write conflict is retried on a fresh transaction and then settles', async () => {
    const t = setup();
    const calls = failTransactions(t, 1, writeConflict());

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation());

    expect(result.status).toBe('COMPLETED');
    expect(calls()).toBe(2);
    // Only the transaction that actually ran recorded its options; the refused
    // one never started.
    expect(t.db.transactions).toEqual([{ isolationLevel: 'Serializable', timeout: 30_000 }]);
    expect(t.storedAttempt().status).toBe('CONFIRMED');
    expect(t.counts()).toMatchObject({ checkouts: 1, payments: 1, allocations: 1, cashMovements: 1 });
  });

  it('S5D-06b exhausting the bounded retries is a 409 CONCURRENCY_ERROR and writes nothing', async () => {
    const t = setup();
    const calls = failTransactions(t, 99, writeConflict());

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'CONCURRENCY_ERROR');

    expect(calls()).toBe(3);
    expect(t.counts()).toEqual(noEffects);
    expect(t.storedAttempt()).toMatchObject({ status: 'RESERVED', confirmationHash: null });
  });

  // Group 7 — the mandated lock order
  it('S5D-07 a CASH-only settlement locks Sale, CheckoutAttempt, CashSession, StockReservation, Inventory', async () => {
    const t = setup();

    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation());

    const order = t.lockOrder();
    expect(order.slice(0, 5)).toEqual(['Sale', 'CheckoutAttempt', 'CashSession', 'StockReservation', 'Inventory']);
    expect(order).not.toContain('ExternalCollection');
    // The finalizer re-locks the sale, its reservations and its inventory, in the
    // same prefix and inside the SAME transaction (no second lock set).
    expect(order.slice(5)).toEqual(['Sale', 'StockReservation', 'Inventory']);
  });

  it('S5D-07b an ExternalCollection plan locks it (id ASC) after the attempt and before the cash session', async () => {
    const t = setup();
    const collection = t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'TR 3', referenceKey: 'TR3',
      institution: 'GALICIA', status: 'UNAPPLIED', originSaleId: t.saleId, claimAttemptId: String(t.storedAttempt().id),
    });
    t.sealPlan([planTender('TRANSFER', 'FIXED', 'COLLECTION', 22000n, collection.id)]);

    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [sealedTender('TRANSFER')],
    }));

    expect(t.lockOrder().slice(0, 6)).toEqual([
      'Sale', 'CheckoutAttempt', 'ExternalCollection', 'CashSession', 'StockReservation', 'Inventory',
    ]);
    expect(t.db.rawQueries.find((sql) => sql.includes('FROM "ExternalCollection"'))).toContain('ORDER BY id ASC FOR UPDATE');
  });

  // Group 8 — the sealed snapshot is the only pricing source
  it('S5D-08 a LIVE pricing-config change after the seal does not reprice the settlement', async () => {
    const t = setup();
    t.sealPlan([
      planTender('TRANSFER', 'BALANCE', 'NEW', null),
    ], { balanceMethod: 'TRANSFER', expectedBalanceAmount: 44000n });
    // The seal is authoritative: a later admin edit must not touch the money.
    Object.assign(t.table('companyPricingConfig')[0]!, {
      bankTransferAdjustmentBps: 9999, listAdjustmentBps: 9999, debitCardAdjustmentBps: 9999, creditCardAdjustmentBps: 9999,
    });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [sealedTender('TRANSFER', { reference: 'OP 999', referenceKey: 'OP999', institution: 'GALICIA' })],
    }));

    expect(result).toMatchObject({ total: 44000n, changeAmount: 0n });
    expect(t.table('salePayment')[0]).toMatchObject({
      method: 'TRANSFER', amount: 44000n, methodFullPrice: 44000n, adjustmentBps: 1000,
    });
    expect(t.db.extra.externalCollection[0]).toMatchObject({ amount: 44000n, status: 'APPLIED' });
    expect(t.db.extra.saleCheckout[0]).toMatchObject({ fullPriceTransfer: 44000n, transferAdjustmentBps: 1000 });
  });

  // Group 9 — CASH change math
  it('S5D-09 the CASH change is the received money minus the SEALED amount', async () => {
    const t = setup();

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [sealedTender('CASH', { receivedAmount: 42575n })],
    }));

    expect(result).toMatchObject({ total: 40000n, changeAmount: 2575n });
    expect(t.table('salePayment')[0]).toMatchObject({ amount: 40000n, receivedAmount: 42575n, changeAmount: 2575n });
    expect(t.db.extra.saleCheckout[0]).toMatchObject({ changeAmount: 2575n });
    // Cash income stays the SALE amount, never the received money (CASH-1).
    expect(t.table('cashMovement')[0]).toMatchObject({ type: 'SALE_INCOME', amount: 40000n });
  });

  // Group 10 — supervisor audit
  it('S5D-10 a supervised settlement records the justification on the attempt and its audit', async () => {
    const t = setup();

    await t.checkout.checkout(t.reqs.admin, t.ids.admin, t.saleId, t.confirmation({
      supervisor: { reason: 'Autorizado por el encargado', evidence: 'Ticket 771' },
    }));

    expect(t.storedAttempt()).toMatchObject({
      status: 'CONFIRMED', confirmedById: t.ids.admin,
      confirmReason: 'Autorizado por el encargado', confirmEvidence: 'Ticket 771',
    });
    expect(t.audits('SALE_CHECKOUT_COMPLETED')[0]!.after).toMatchObject({
      supervisor: { byId: t.ids.admin, reason: 'Autorizado por el encargado' },
    });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(0);
  });

  it('S5D-10b a terminal rejection records WHO rejected it and why', async () => {
    const t = setup();
    t.table('cashSession')[0]!.status = 'CLOSED';

    await expectAppError(
      t.checkout.checkout(t.reqs.admin, t.ids.admin, t.saleId, t.confirmation({
        supervisor: { reason: 'Autorizado por el encargado', evidence: 'Ticket 771' },
      })),
      409,
      'NO_OPEN_CASH_SESSION',
    );

    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectedById: t.ids.admin });
    const audit = t.audits('CHECKOUT_RESERVATION_REJECTED')[0]!;
    expect(audit).toMatchObject({ entityType: 'CheckoutAttempt', entityId: t.storedAttempt().id });
    expect(audit.after).toMatchObject({ status: 'REJECTED', code: 'NO_OPEN_CASH_SESSION' });
  });

  // Group 11 — realtime only after commit
  it('S5D-11 the service never emits; the committed result carries the notification payload', async () => {
    const t = setup();

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation());

    // Static proof: the settlement module holds no realtime dependency at all.
    // The controller emits AFTER the commit (checkout.controller.ts), on these
    // already-committed values, and a replay emits nothing.
    const source = readFileSync(SERVICE_PATH, 'utf8');
    expect(source).not.toContain('realtime');
    expect(source).not.toContain('.emit(');
    expect(result).toMatchObject({ saleId: t.saleId, saleNumber: 'S1-000001', status: 'COMPLETED', replayed: false });
    expect(t.sale()).toMatchObject({ status: 'COMPLETED', saleNumber: 'S1-000001' });
  });

  // ---------------------------------------------------------------------------
  // Group 12 — S5-D.1 hardening: the concurrent P2002 reference race (F1), the
  // REJECTED replay (F2), the service-side raw-reference defence (F3) and the
  // S5-D audit's coverage gaps (EXTERNAL_COLLECTION_NOT_APPLICABLE, an
  // already-recorded reference, multi-method NEW settlement, FIXED centavos, the
  // INVALID_SALE_STATE variants and a missing cash session).
  // ---------------------------------------------------------------------------

  it('S5D1-01 a concurrent NEW-reference collision is a 409, never a 500, and rolls everything back', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'NEW', 22000n),
    ], { expectedBalanceAmount: 20000n });
    // The in-tx pre-check finds nothing: the peer row only becomes durable after
    // our INSERT collides with its partial unique index — exactly the committed
    // state PostgreSQL leaves behind (the double cannot run the real race).
    t.db.simulateConcurrentCommit(() => {
      t.addCollection({
        branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 777', referenceKey: 'OP777',
        institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
      });
    });
    t.db.injectUniqueViolation('externalCollection', 'create', 'ExternalCollection_transfer_ref_key');

    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20000n }),
        sealedTender('TRANSFER', { reference: 'OP 777', referenceKey: 'OP777', institution: 'GALICIA' }),
      ],
    })), 409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED');

    expect(error.details).toEqual({ status: 'UNAPPLIED' });
    // Full rollback: only the peer's committed row survives — no SaleCheckout, no
    // payment, no allocation, no cash/stock movement and no audit.
    expect(t.counts()).toEqual({ ...noEffects, collections: 1 });
    expect(t.sale()).toMatchObject({ status: 'PENDING_PAYMENT', total: 40000n });
    expect(t.storedAttempt()).toMatchObject({ status: 'RESERVED', confirmationHash: null, rejectionCode: null });
    expect(t.table('inventory')[0]).toMatchObject({ physical: 10n, reserved: 1n });
    expect(t.table('stockReservation')[0]).toMatchObject({ status: 'ACTIVE' });
  });

  // R-1/R-2 (R3 PG gate, OWNER 2026-10-18): the same concurrent reference race,
  // with the P2002 in the real adapter-pg 7.10 shape (no meta.target). T-C keeps
  // its pre-check; the shared classifier must still recognise the partial index.
  it('S5D1-AD-01 adapter-shaped P2002 (constraint.index) of the transfer index is the same 409 with its recorded status, full rollback', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'NEW', 22000n),
    ], { expectedBalanceAmount: 20000n });
    t.db.simulateConcurrentCommit(() => {
      t.addCollection({
        branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 777', referenceKey: 'OP777',
        institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
      });
    });
    t.db.injectAdapterUniqueViolation('externalCollection', 'create', { index: 'ExternalCollection_transfer_ref_key' });
    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20000n }),
        sealedTender('TRANSFER', { reference: 'OP 777', referenceKey: 'OP777', institution: 'GALICIA' }),
      ],
    })), 409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED');
    expect(error.details).toEqual({ status: 'UNAPPLIED' });
    expect(t.counts()).toEqual({ ...noEffects, collections: 1 });
    expect(t.storedAttempt()).toMatchObject({ status: 'RESERVED', confirmationHash: null, rejectionCode: null });
  });

  it('S5D1-AD-02 adapter-shaped P2002 (constraint.fields) of the debit index is the same 409', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('CARD_DEBIT', 'FIXED', 'NEW', 22000n),
    ], { expectedBalanceAmount: 20000n });
    t.db.simulateConcurrentCommit(() => {
      t.addCollection({
        branchId: BRANCH, method: 'CARD_DEBIT', amount: 22000n, reference: 'D009', referenceKey: 'D009',
        institution: null, institutionOther: null, status: 'APPLIED', recordedById: t.ids.seller,
      });
    });
    t.db.injectAdapterUniqueViolation('externalCollection', 'create', { fields: ['"branchId"', '"referenceKey"'] });
    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20000n }),
        sealedTender('CARD_DEBIT', { reference: 'D009', referenceKey: 'D009' }),
      ],
    })), 409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED');
    expect(error.details).toEqual({ status: 'APPLIED' });
    expect(t.counts()).toEqual({ ...noEffects, collections: 1 });
  });

  it('S5D1-02 the same collision read from Prisma\'s column-list target is also a 409', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'NEW', 22000n),
    ], { expectedBalanceAmount: 20000n });
    t.db.simulateConcurrentCommit(() => {
      t.addCollection({
        branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 778', referenceKey: 'OP778',
        institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
      });
    });
    // Prisma does not always report the SQL index name; it may report the unique
    // columns as an array. Both shapes must resolve to the same domain error.
    t.db.injectUniqueViolation('externalCollection', 'create', ['branchId', 'institution', 'referenceKey']);

    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20000n }),
        sealedTender('TRANSFER', { reference: 'OP 778', referenceKey: 'OP778', institution: 'GALICIA' }),
      ],
    })), 409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED');

    expect(error.details).toEqual({ status: 'UNAPPLIED' });
    expect(t.counts()).toEqual({ ...noEffects, collections: 1 });
    expect(t.storedAttempt().status).toBe('RESERVED');
  });

  it('S5D1-03 an already-recorded reference is a CORRECTABLE 409 that leaves the attempt RESERVED', async () => {
    const t = setup();
    t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 888', referenceKey: 'OP888',
      institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
    });
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'NEW', 22000n),
    ], { expectedBalanceAmount: 20000n });

    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20000n }),
        sealedTender('TRANSFER', { reference: 'OP 888', referenceKey: 'OP888', institution: 'GALICIA' }),
      ],
    })), 409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED');

    expect(error.details).toEqual({ status: 'UNAPPLIED' });
    // The contract makes a duplicate reference CORRECTABLE (service header): the
    // attempt stays RESERVED and no terminal rejection is committed.
    expect(t.counts()).toEqual({ ...noEffects, collections: 1 });
    expect(t.storedAttempt()).toMatchObject({ status: 'RESERVED', rejectionCode: null });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(0);
  });

  it('S5D1-04 a non-applicable COLLECTION terminally rejects and its replay reproduces the rejection', async () => {
    const t = setup();
    const collection = t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 555', referenceKey: 'OP555',
      institution: 'GALICIA', institutionOther: null, status: 'APPLIED',
      claimAttemptId: String(t.storedAttempt().id), appliedSaleId: t.saleId, appliedCheckoutId: randomUUID(),
    });
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'COLLECTION', 22000n, collection.id),
    ], { expectedBalanceAmount: 20000n });
    const payload = t.confirmation({
      tenders: [sealedTender('CASH', { receivedAmount: 20000n }), sealedTender('TRANSFER')],
    });

    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload), 409, 'EXTERNAL_COLLECTION_NOT_APPLICABLE');
    expect(error.details).toMatchObject({ attempt: { status: 'REJECTED' } });

    // Terminal: the rejection COMMITED with its own audit and no charge.
    expect(t.storedAttempt()).toMatchObject({
      status: 'REJECTED', rejectionCode: 'EXTERNAL_COLLECTION_NOT_APPLICABLE', rejectedById: t.ids.cashier,
    });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, allocations: 0, cashMovements: 0, stockMovements: 0 });
    expect(t.db.extra.externalCollection[0]).toMatchObject({ status: 'APPLIED' });
    const rejectedAt = t.storedAttempt().rejectedAt;

    // The persisted rejection is durable: a replay reproduces it without writing.
    const replay = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload), 409, 'EXTERNAL_COLLECTION_NOT_APPLICABLE');
    expect(replay.details).toMatchObject({ attempt: { status: 'REJECTED' } });
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, allocations: 0 });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
    expect(t.storedAttempt().rejectedAt).toBe(rejectedAt);
  });

  // SECURITY-R3-CROSS-SALE-01 (OWNER): collection.originSaleId must be the
  // confirming sale. T-C re-checks it on the row it locks, independently of T-R,
  // so a historical/corrupt claim (EC of sale A claimed by an attempt of sale B)
  // can never be applied to B: the attempt is terminally REJECTED like any other
  // non-applicable collection (S5D1-04) and no money moves.
  it('XS-C01 a collection originated by ANOTHER sale, even claimed by this attempt, terminally rejects: nothing applied, no payment, no success audit', async () => {
    const t = setup();
    const otherSaleId = randomUUID();
    const collection = t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 556', referenceKey: 'OP556',
      institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED',
      originSaleId: otherSaleId, claimAttemptId: String(t.storedAttempt().id),
    });
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'COLLECTION', 22000n, String(collection.id)),
    ], { expectedBalanceAmount: 20000n });

    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [sealedTender('CASH', { receivedAmount: 20000n }), sealedTender('TRANSFER')],
    })), 409, 'EXTERNAL_COLLECTION_NOT_APPLICABLE');
    expect(error.details).toMatchObject({ attempt: { status: 'REJECTED' } });

    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'EXTERNAL_COLLECTION_NOT_APPLICABLE' });
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, allocations: 0, cashMovements: 0, stockMovements: 0 });
    expect(t.db.extra.externalCollection[0]).toMatchObject({
      status: 'UNAPPLIED', originSaleId: otherSaleId, claimAttemptId: String(t.storedAttempt().id),
    });
    expect(t.db.extra.externalCollection[0]!.appliedSaleId).toBeUndefined();
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
    for (const action of ['PAYMENT_REGISTERED', 'SALE_CHECKOUT_COMPLETED', 'EXTERNAL_COLLECTION_APPLIED']) {
      expect(t.audits(action), action).toHaveLength(0);
    }
    expect(t.sale()).toMatchObject({ status: 'PENDING_PAYMENT' });
  });

  it('S5D1-05 a persisted REJECTED attempt replays its own rejection with zero writes', async () => {
    const t = setup();
    const rejectedAt = new Date('2026-10-01T12:00:00.000Z');
    t.setSnapshot({
      status: 'REJECTED', rejectionCode: 'INSUFFICIENT_PHYSICAL', rejectionDetails: { variantId: 'V-1', reason: 'demo' },
      rejectedById: t.ids.cashier, rejectedAt,
    });
    const before = t.counts();

    const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'INSUFFICIENT_PHYSICAL');

    // The persisted code and details come back unchanged, with the same 409 shape.
    expect(error.details).toMatchObject({ variantId: 'V-1', reason: 'demo', attempt: { status: 'REJECTED' } });
    // No settlement, no audit, no mutation of who/when rejected.
    expect(t.counts()).toEqual(before);
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(0);
    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'INSUFFICIENT_PHYSICAL', rejectedById: t.ids.cashier });
    expect(t.storedAttempt().rejectedAt).toBe(rejectedAt);
    expect(t.sale()).toMatchObject({ status: 'PENDING_PAYMENT' });
  });

  it('S5D1-06 a REJECTED attempt with another operationKey is a key-reuse 409, not a rejection replay', async () => {
    const t = setup();
    t.setSnapshot({
      status: 'REJECTED', rejectionCode: 'INSUFFICIENT_PHYSICAL', rejectionDetails: {},
      rejectedById: t.ids.cashier, rejectedAt: new Date('2026-10-01T12:00:00.000Z'),
    });
    const before = t.counts();

    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({ operationKey: randomUUID() })),
      409,
      'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
    );

    expect(t.counts()).toEqual(before);
    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'INSUFFICIENT_PHYSICAL' });
  });

  it('S5D1-07 the service refuses a raw reference over 64 code points before any INSERT', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'NEW', 22000n),
    ], { expectedBalanceAmount: 20000n });
    // 65 code points whose normalised key 'ABC' alone would pass: only the RAW
    // length (chk_ec_reference) rejects it. The HTTP DTO is bypassed on purpose.
    const reference = `ABC${'-'.repeat(62)}`;
    expect([...reference]).toHaveLength(65);
    const before = t.counts();

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20000n }),
        sealedTender('TRANSFER', { reference, referenceKey: 'ABC', institution: 'GALICIA' }),
      ],
    })), 400, 'VALIDATION_ERROR');

    expect(t.counts()).toEqual(before);
    expect(t.storedAttempt()).toMatchObject({ status: 'RESERVED', rejectionCode: null });
  });

  it('S5D1-08 CASH balance + a NEW transfer settle one payment and one allocation per method', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'NEW', 22000n),
    ], { expectedBalanceAmount: 20000n });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20000n }),
        sealedTender('TRANSFER', { reference: 'OP 777', referenceKey: 'OP777', institution: 'GALICIA' }),
      ],
    }));

    expect(result).toMatchObject({ status: 'COMPLETED', total: 42000n, changeAmount: 0n });
    expect(result.payments.map((p) => [p.method, p.tenderRole, p.amount, p.externalCollectionId === null]))
      .toEqual([['CASH', 'BALANCE', 20000n, true], ['TRANSFER', 'FIXED', 22000n, false]]);
    expect(t.counts()).toMatchObject({ checkouts: 1, collections: 1, allocations: 2, payments: 2, cashMovements: 1, stockMovements: 1 });
    // Σ allocations(method) === payment.amount for EVERY payment.
    for (const payment of t.table('salePayment')) {
      const allocated = t.db.extra.saleLineAllocation
        .filter((allocation) => allocation.salePaymentId === payment.id)
        .reduce((sum, allocation) => sum + (allocation.amount as bigint), 0n);
      expect(allocated).toBe(payment.amount);
    }
    // Σ payments === the SEALED total.
    expect(t.table('salePayment').reduce((sum, payment) => sum + (payment.amount as bigint), 0n)).toBe(42000n);
    expect(t.db.extra.externalCollection[0]).toMatchObject({
      method: 'TRANSFER', amount: 22000n, referenceKey: 'OP777', institution: 'GALICIA', status: 'APPLIED', appliedSaleId: t.saleId,
    });
    expect(t.table('salePayment').find((payment) => payment.method === 'TRANSFER')!.externalCollectionId).toBe(t.db.extra.externalCollection[0]!.id);
    // Cash movement for CASH only; change only on the CASH payment.
    expect(t.table('cashMovement')).toHaveLength(1);
    expect(t.table('salePayment').find((payment) => payment.method === 'TRANSFER')!.changeAmount).toBeNull();
    // ONE stock finalization and one confirmation.
    expect(t.table('inventory')[0]).toMatchObject({ physical: 9n, reserved: 0n });
    expect(t.table('stockReservation')[0]).toMatchObject({ status: 'CONSUMED' });
    expect(t.table('stockMovement')).toHaveLength(1);
    expect(t.storedAttempt().status).toBe('CONFIRMED');
    expect(t.audits('SALE_CHECKOUT_COMPLETED')).toHaveLength(1);
  });

  it('S5D1-09 CASH balance + a NEW debit settle the debit collection without institution', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('CARD_DEBIT', 'FIXED', 'NEW', 22000n),
    ], { expectedBalanceAmount: 20000n });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20000n }),
        sealedTender('CARD_DEBIT', { reference: 'D 777', referenceKey: 'D777' }),
      ],
    }));

    expect(result).toMatchObject({ status: 'COMPLETED', total: 42000n, changeAmount: 0n });
    expect(result.payments.map((p) => [p.method, p.tenderRole, p.amount]))
      .toEqual([['CASH', 'BALANCE', 20000n], ['CARD_DEBIT', 'FIXED', 22000n]]);
    expect(t.counts()).toMatchObject({ checkouts: 1, collections: 1, allocations: 2, payments: 2, cashMovements: 1, stockMovements: 1 });
    expect(t.db.extra.externalCollection[0]).toMatchObject({
      method: 'CARD_DEBIT', amount: 22000n, institution: null, referenceKey: 'D777', status: 'APPLIED',
    });
    const debit = t.table('salePayment').find((payment) => payment.method === 'CARD_DEBIT')!;
    expect(debit).toMatchObject({ methodFullPrice: 42000n, adjustmentBps: 500, externalCollectionId: t.db.extra.externalCollection[0]!.id });
    expect(t.table('cashMovement')).toHaveLength(1);
    expect(debit.changeAmount).toBeNull();
  });

  it('S5D1-10 CASH + a NEW transfer + a NEW debit settle three payments, two collections and one stock finalization', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'NEW', 12000n),
      planTender('CARD_DEBIT', 'FIXED', 'NEW', 12000n),
    ], { expectedBalanceAmount: 18000n });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 18000n }),
        sealedTender('TRANSFER', { reference: 'OP 111', referenceKey: 'OP111', institution: 'GALICIA' }),
        sealedTender('CARD_DEBIT', { reference: 'D 111', referenceKey: 'D111' }),
      ],
    }));

    expect(result).toMatchObject({ total: 42000n, changeAmount: 0n });
    expect(result.payments.map((p) => [p.method, p.tenderRole, p.amount])).toEqual([
      ['CASH', 'BALANCE', 18000n], ['TRANSFER', 'FIXED', 12000n], ['CARD_DEBIT', 'FIXED', 12000n],
    ]);
    expect(t.counts()).toMatchObject({ checkouts: 1, collections: 2, allocations: 3, payments: 3, cashMovements: 1, stockMovements: 1 });
    for (const payment of t.table('salePayment')) {
      const allocated = t.db.extra.saleLineAllocation
        .filter((allocation) => allocation.salePaymentId === payment.id)
        .reduce((sum, allocation) => sum + (allocation.amount as bigint), 0n);
      expect(allocated).toBe(payment.amount);
    }
    expect(t.table('salePayment').reduce((sum, payment) => sum + (payment.amount as bigint), 0n)).toBe(42000n);
    expect(t.db.extra.externalCollection.map((collection) => collection.method).sort()).toEqual(['CARD_DEBIT', 'TRANSFER']);
    expect(t.table('cashMovement')[0]).toMatchObject({ type: 'SALE_INCOME', amount: 18000n });
    expect(t.table('salePayment').filter((payment) => payment.method !== 'CASH').every((payment) => payment.changeAmount === null)).toBe(true);
    expect(t.db.extra.saleCheckout).toHaveLength(1);
    expect(t.table('inventory')[0]).toMatchObject({ physical: 9n, reserved: 0n });
    expect(t.table('stockMovement')).toHaveLength(1);
    expect(t.storedAttempt().status).toBe('CONFIRMED');
    expect(t.audits('SALE_CHECKOUT_COMPLETED')).toHaveLength(1);
  });

  it('S5D1-11 a FIXED transfer that is not a whole peso settles to the exact centavo', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'NEW', 22037n),
    ], { expectedBalanceAmount: 20000n });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20000n }),
        sealedTender('TRANSFER', { reference: 'OP 037', referenceKey: 'OP037', institution: 'GALICIA' }),
      ],
    }));

    expect(result).toMatchObject({ total: 42037n, changeAmount: 0n });
    const transfer = t.table('salePayment').find((payment) => payment.method === 'TRANSFER')!;
    // No accidental rounding anywhere: the amount is BigInt-exact end to end.
    expect(transfer.amount).toBe(22037n);
    expect(t.db.extra.saleLineAllocation.find((allocation) => allocation.salePaymentId === transfer.id)!.amount).toBe(22037n);
    expect(t.db.extra.saleCheckout[0]).toMatchObject({ total: 42037n });
    expect(t.sale()).toMatchObject({ status: 'COMPLETED', total: 42037n });
  });

  it('S5D1-12 a non-PROPORTIONAL_V1 sale terminally rejects the attempt', async () => {
    const t = setup({ pricingModel: 'FIXED_TOTAL' });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'INVALID_SALE_STATE');

    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'INVALID_SALE_STATE' });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, allocations: 0, cashMovements: 0 });
  });

  it('S5D1-13 a sale in the wrong state terminally rejects the attempt', async () => {
    const t = setup({ status: 'DRAFT' });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'INVALID_SALE_STATE');

    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'INVALID_SALE_STATE' });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, allocations: 0 });
  });

  it('S5D1-14 a sale with previous payments terminally rejects the attempt and leaves them untouched', async () => {
    const t = setup({ withPayment: true });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'INVALID_SALE_STATE');

    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'INVALID_SALE_STATE' });
    expect(t.table('salePayment')).toHaveLength(1);
    expect(t.counts()).toMatchObject({ checkouts: 0, allocations: 0, cashMovements: 0 });
  });

  it('S5D1-15 an attempt whose cash session does not exist rejects with NO_OPEN_CASH_SESSION', async () => {
    const t = setup();
    t.setSnapshot({ cashSessionId: randomUUID() });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation()), 409, 'NO_OPEN_CASH_SESSION');

    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'NO_OPEN_CASH_SESSION' });
    expect(t.audits('CHECKOUT_RESERVATION_REJECTED')).toHaveLength(1);
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, allocations: 0, cashMovements: 0 });
  });

  // Behavior of the retired R3-A2 request-shape suite that had no T-C equivalent:
  // authority by branch/OWNER, CASH/debit centavos, a collection amount mismatch and
  // the P2002 cases whose peer row is not the proposed reference.
  it('S5D2-01 a cashier of ANOTHER branch is refused with no effects (was C1)', async () => {
    const t = setup();
    const before = t.counts();

    await expectAppError(t.checkout.checkout(t.reqs.cashier2, t.ids.cashier2, t.saleId, t.confirmation()), 403, 'FORBIDDEN');

    expect(t.counts()).toEqual(before);
    expect(t.sale().status).toBe('PENDING_PAYMENT');
    expect(t.storedAttempt()).toMatchObject({ status: 'RESERVED', confirmationHash: null });
  });

  it('S5D2-02 an OWNER holds implicit supervisor authority and settles with a justification (was C3)', async () => {
    const t = setup();

    const result = await t.checkout.checkout(t.reqs.owner, t.ids.owner, t.saleId, t.confirmation({
      supervisor: { reason: 'Confirmación del propietario', evidence: 'Ticket POS 1' },
    }));

    expect(result).toMatchObject({ status: 'COMPLETED', total: 40000n });
    expect(t.storedAttempt()).toMatchObject({ status: 'CONFIRMED', confirmedById: t.ids.owner });
  });

  it('S5D2-03 a CASH FIXED amount with centavos is settled exactly, with no rounding (was A5)', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CASH', 'FIXED', 'NEW', 20037n),
      planTender('TRANSFER', 'BALANCE', 'NEW', null),
    ], { expectedBalanceAmount: 22000n, balanceMethod: 'TRANSFER' });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20037n }),
        sealedTender('TRANSFER', { reference: 'OP 88123', referenceKey: 'OP88123', institution: 'GALICIA' }),
      ],
    }));

    expect(result).toMatchObject({ total: 42037n, changeAmount: 0n });
    expect(result.payments.map((p) => [p.method, p.tenderRole, p.amount, p.changeAmount]))
      .toEqual([['CASH', 'FIXED', 20037n, 0n], ['TRANSFER', 'BALANCE', 22000n, null]]);
    expect(t.table('cashMovement')[0]).toMatchObject({ type: 'SALE_INCOME', amount: 20037n });
    expect(t.sale().total).toBe(42037n);
  });

  it('S5D2-04 a CARD_DEBIT FIXED amount with centavos keeps the sealed debit adjustment (was A6)', async () => {
    const t = setup();
    t.sealPlan([
      planTender('CARD_DEBIT', 'FIXED', 'NEW', 21037n),
      planTender('CASH', 'BALANCE', 'NEW', null),
    ], { expectedBalanceAmount: 20000n });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [
        sealedTender('CARD_DEBIT', { reference: 'D900', referenceKey: 'D900' }),
        sealedTender('CASH', { receivedAmount: 20000n }),
      ],
    }));

    expect(result).toMatchObject({ total: 41037n, changeAmount: 0n });
    expect(t.table('salePayment').find((row) => row.method === 'CARD_DEBIT')).toMatchObject({
      amount: 21037n, methodFullPrice: 42000n, adjustmentBps: 500,
    });
    expect(t.db.extra.externalCollection[0]).toMatchObject({ method: 'CARD_DEBIT', amount: 21037n, status: 'APPLIED' });
  });

  it('S5D2-05 a COLLECTION whose amount differs from the sealed amount terminally rejects, applying nothing (was B3c)', async () => {
    const t = setup();
    const collection = t.addCollection({
      branchId: BRANCH, method: 'TRANSFER', amount: 22001n, reference: 'OP 556', referenceKey: 'OP556',
      institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', originSaleId: t.saleId,
      claimAttemptId: String(t.storedAttempt().id),
    });
    t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'COLLECTION', 22000n, collection.id),
    ], { expectedBalanceAmount: 20000n });

    await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [sealedTender('CASH', { receivedAmount: 20000n }), sealedTender('TRANSFER')],
    })), 409, 'EXTERNAL_COLLECTION_NOT_APPLICABLE');

    expect(t.storedAttempt()).toMatchObject({ status: 'REJECTED', rejectionCode: 'EXTERNAL_COLLECTION_NOT_APPLICABLE' });
    expect(t.db.extra.externalCollection[0]).toMatchObject({ status: 'UNAPPLIED' });
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, allocations: 0, cashMovements: 0 });
  });

  describe('P2002 on an external reference whose peer row is NOT the proposed one (was P4/P5/P7/P8)', () => {
    const transferPlan = (t: Harness) => t.sealPlan([
      planTender('CASH', 'BALANCE', 'NEW', null),
      planTender('TRANSFER', 'FIXED', 'NEW', 22000n),
    ], { expectedBalanceAmount: 20000n });
    const transferConfirmation = (t: Harness) => t.confirmation({
      tenders: [
        sealedTender('CASH', { receivedAmount: 20000n }),
        sealedTender('TRANSFER', { reference: 'OP 88123', referenceKey: 'OP88123', institution: 'GALICIA' }),
      ],
    });
    const settle = (t: Harness, payload: CheckoutConfirmationRequest) =>
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload).then(() => null, (cause: unknown) => cause);

    it('S5D2-06 the same reference at ANOTHER institution is not a collision: the original P2002 stands', async () => {
      const t = setup();
      transferPlan(t);
      t.db.simulateConcurrentCommit(() => {
        t.addCollection({
          branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 88123', referenceKey: 'OP88123',
          institution: 'BBVA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
        });
      });
      t.db.injectUniqueViolation('externalCollection', 'create', 'ExternalCollection_transfer_ref_key');

      const error = await settle(t, transferConfirmation(t));

      expect(error).not.toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'P2002' });
      expect(t.db.extra.externalCollection).toHaveLength(1);
      expect(t.db.extra.externalCollection[0]).toMatchObject({ institution: 'BBVA', status: 'UNAPPLIED' });
      expect(t.storedAttempt()).toMatchObject({ status: 'RESERVED', rejectionCode: null });
    });

    it('S5D2-07 a reference of ANOTHER branch is never read nor surfaced', async () => {
      const t = setup();
      transferPlan(t);
      t.addCollection({
        branchId: OTHER_BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 88123', referenceKey: 'OP88123',
        institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.cashier2,
      });
      t.db.injectUniqueViolation('externalCollection', 'create', 'ExternalCollection_transfer_ref_key');

      const error = await settle(t, transferConfirmation(t));

      expect(error).not.toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'P2002' });
      expect(t.db.extra.externalCollection).toHaveLength(1);
      expect(t.db.extra.externalCollection[0]).toMatchObject({ branchId: OTHER_BRANCH, status: 'UNAPPLIED' });
    });

    it('S5D2-08 with several proposed references the colliding one is the one reported', async () => {
      const t = setup();
      t.sealPlan([
        planTender('CASH', 'BALANCE', 'NEW', null),
        planTender('TRANSFER', 'FIXED', 'NEW', 11000n),
        planTender('CARD_DEBIT', 'FIXED', 'NEW', 11000n),
      ], { expectedBalanceAmount: 20000n });
      t.db.simulateConcurrentCommit(() => {
        t.addCollection({
          branchId: BRANCH, method: 'CARD_DEBIT', amount: 11000n, reference: 'D009', referenceKey: 'D009',
          institution: null, institutionOther: null, status: 'REFUNDED', recordedById: t.ids.seller,
          resolvedById: t.ids.cashier, resolvedAt: new Date(), refundReference: 'NC-001',
        });
      });
      // 'OP88123' is proposed first and exists nowhere: only the debit reference collides.
      t.db.injectUniqueViolation('externalCollection', 'create', 'ExternalCollection_debit_ref_key', (args) => (args.data as Row).method === 'CARD_DEBIT');

      const error = await expectAppError(t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
        tenders: [
          sealedTender('CASH', { receivedAmount: 20000n }),
          sealedTender('TRANSFER', { reference: 'OP 88123', referenceKey: 'OP88123', institution: 'GALICIA' }),
          sealedTender('CARD_DEBIT', { reference: 'D009', referenceKey: 'D009' }),
        ],
      })), 409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED');

      expect(error.details).toEqual({ status: 'REFUNDED' });
      expect(t.storedAttempt().status).toBe('RESERVED');
    });

    it('S5D2-09 an ambiguous collision (referenceKey alone) fails closed instead of guessing a status', async () => {
      const t = setup();
      transferPlan(t);
      t.db.simulateConcurrentCommit(() => {
        t.addCollection({
          branchId: BRANCH, method: 'TRANSFER', amount: 22000n, reference: 'OP 88123', referenceKey: 'OP88123',
          institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', recordedById: t.ids.seller,
        });
      });
      t.db.injectUniqueViolation('externalCollection', 'create', 'referenceKey');

      const error = await settle(t, transferConfirmation(t));

      expect(error).not.toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'P2002' });
      expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0 });
      expect(t.db.extra.saleCheckout).toHaveLength(0);
    });
  });
});


// R3-A4.3 S6.1: the CHECKOUT_RESERVATION_CLOSED fix must leave the two live
// T-C paths untouched. Named under "S5" so the S5 gate runs them.
describe('R3-A4.3 S5 regression — S6.1 closed-attempt fix leaves live T-C intact', () => {
  it('S6F-21 a CONFIRMED replay is unaffected (same checkout, zero new payments)', async () => {
    const t = setup();
    const payload = t.confirmation();
    const first = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    const payments = t.counts().payments;
    const replay = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, payload);
    expect(replay).toMatchObject({ replayed: true, checkoutId: first.checkoutId, status: 'COMPLETED' });
    expect(t.counts().payments).toBe(payments);
  });

  it('S6F-22 a RESERVED confirmation is unaffected (settles COMPLETED)', async () => {
    const t = setup();
    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation());
    expect(result).toMatchObject({ replayed: false, status: 'COMPLETED' });
    expect(t.storedAttempt()).toMatchObject({ status: 'CONFIRMED' });
  });
});

describe('R3 checkout — static contract', () => {
  const source = readFileSync(SERVICE_PATH, 'utf8');

  it('I1 uses a Serializable S5 confirmation transaction with bounded retries', () => {
    const confirmationFlow = source.slice(source.indexOf('async function checkout('), source.indexOf('return { checkout }'));
    expect(confirmationFlow).toContain("isolationLevel: 'Serializable'");
    expect(confirmationFlow).toContain('timeout: CHECKOUT_TIMEOUT_MS');
    expect(confirmationFlow).toContain('for (let attemptNumber = 0; attemptNumber < MAX_ATTEMPTS; attemptNumber += 1)');
    expect(confirmationFlow).toContain('if (!transient(error)) throw error');
    expect(source).toContain('CHECKOUT_TIMEOUT_MS = 30_000');
    expect(source).toContain('MAX_ATTEMPTS = 3');
    expect(source).not.toContain('maxWait');
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

  it('I4 settles from the SEALED plan and never consults the pricing service', () => {
    // R3-A4.3 S5-D: the settlement is a function of the sealed attempt alone. It
    // must not re-price, so the confirmation flow may not call the pricing
    // service nor the quote engine, and must not open a second transaction.
    const flow = source.slice(source.indexOf('async function checkout('), source.indexOf('return { checkout }'));
    expect(flow).not.toContain('createPricingService');
    expect(flow).not.toContain('computeProportionalQuote');
    expect(flow).not.toContain('getSnapshot');
    expect(flow.match(/database\.\$transaction\(/g)).toHaveLength(1);
    // The sealed helpers are what it does use.
    expect(flow).toContain('hashSealedConfirmation(');
    expect(flow).toContain('buildSettlement(');
    expect(flow).toContain('evaluateCurrentHoldCoverage(');
    expect(flow).toContain('finalizePaidSaleInTransaction(');
    // And the per-payment reconciliation lives inside the settlement transaction.
    expect(source).toContain('allocationByPayment');
  });

  it('I5 clears every sealed plan column without a raw UPDATE build', () => {
    // The plan columns are frozen by F1 and the confirmationHash is the replay
    // identity: the confirmation must write them through the delegate, keeping
    // one place that names them.
    expect(source).toContain('confirmationHash: requestConfirmationHash');
    expect(source).toContain('rejectedById: userId');
  });
});

// ---------------------------------------------------------------------------
// CARD_CREDIT (OWNER block): T-C settles a sealed plan that carries CARD_CREDIT
// exactly like the other external methods, from the sealed credit snapshot
// (algorithmVersion 2). The harness company configuration has credit +15%
// (1500 bps) on the 40000-centavo line: credit full price 46000.
// ---------------------------------------------------------------------------
describe('CARD_CREDIT — T-C settlement', () => {
  const planTender = (
    method: string, role: string, source: string, amount: bigint | null, externalCollectionId: string | null = null,
  ) => ({ method, role, source, amount, externalCollectionId });
  const confirmTender = (
    method: 'CASH' | 'CARD_CREDIT', fields: Partial<CheckoutConfirmationRequest['tenders'][number]> = {},
  ): CheckoutConfirmationRequest['tenders'][number] => ({
    method, receivedAmount: method === 'CASH' ? 12000n : null, reference: null, referenceKey: null, institution: null, institutionOther: null, ...fields,
  });
  const CREDIT_SNAPSHOT = { algorithmVersion: 2, fullPriceCredit: 46000n, creditAdjustmentBps: 1500 };

  it('CC-1 CASH fixed + CARD_CREDIT balance settle one referenced credit collection, from the sealed credit price', async () => {
    const t = setup();
    // balance = 46.000 * (40.000 - 10.000) / 40.000 = 34.500 ; total = 44.500
    t.sealPlan([
      planTender('CASH', 'FIXED', 'NEW', 10000n),
      planTender('CARD_CREDIT', 'BALANCE', 'NEW', null),
    ], { ...CREDIT_SNAPSHOT, balanceMethod: 'CARD_CREDIT', expectedBalanceAmount: 34500n });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [confirmTender('CASH'), confirmTender('CARD_CREDIT', { reference: 'CRD 0001', referenceKey: 'CRD0001' })],
    }));

    expect(result).toMatchObject({ status: 'COMPLETED', total: 44500n, changeAmount: 2000n });
    const credit = t.table('salePayment').find((payment) => payment.method === 'CARD_CREDIT')!;
    expect(credit).toMatchObject({ amount: 34500n, tenderRole: 'BALANCE', methodFullPrice: 46000n, adjustmentBps: 1500, receivedAmount: null, changeAmount: null });
    expect(t.table('salePayment').find((payment) => payment.method === 'CASH')).toMatchObject({ amount: 10000n, methodFullPrice: 40000n, adjustmentBps: 0 });
    expect(credit.externalCollectionId).toBe(t.db.extra.externalCollection[0]!.id);
    expect(t.db.extra.externalCollection[0]).toMatchObject({
      method: 'CARD_CREDIT', amount: 34500n, referenceKey: 'CRD0001', institution: null, institutionOther: null, status: 'APPLIED',
    });
    // Allocations add up to every payment, and the payments to the sealed total.
    for (const payment of t.table('salePayment')) {
      const allocated = t.db.extra.saleLineAllocation
        .filter((allocation) => allocation.salePaymentId === payment.id)
        .reduce((sum, allocation) => sum + (allocation.amount as bigint), 0n);
      expect(allocated).toBe(payment.amount);
    }
    expect(t.table('salePayment').reduce((sum, payment) => sum + (payment.amount as bigint), 0n)).toBe(44500n);
    // The checkout carries the credit snapshot and the format version of its attempt.
    expect(t.db.extra.saleCheckout[0]).toMatchObject({
      balanceMethod: 'CARD_CREDIT', fullPriceCredit: 46000n, creditAdjustmentBps: 1500, algorithmVersion: 2,
    });
    expect(t.audits('SALE_CHECKOUT_COMPLETED')[0]!.after).toMatchObject({
      // The audit store writes BigInt as a decimal string.
      fullPrices: { CARD_CREDIT: '46000' }, adjustments: { credit: 1500 },
    });
    expect(t.table('inventory')[0]).toMatchObject({ physical: 9n, reserved: 0n });
  });

  it('CC-2 simple credit: a single CARD_CREDIT balance tender covers the whole sealed credit price', async () => {
    const t = setup();
    t.sealPlan([planTender('CARD_CREDIT', 'BALANCE', 'NEW', null)], { ...CREDIT_SNAPSHOT, balanceMethod: 'CARD_CREDIT', expectedBalanceAmount: 46000n });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [confirmTender('CARD_CREDIT', { reference: 'CRD 0002', referenceKey: 'CRD0002' })],
    }));

    expect(result).toMatchObject({ status: 'COMPLETED', total: 46000n, changeAmount: 0n });
    expect(t.table('salePayment')).toHaveLength(1);
    expect(t.table('salePayment')[0]).toMatchObject({ method: 'CARD_CREDIT', amount: 46000n, methodFullPrice: 46000n, adjustmentBps: 1500 });
  });

  it.each([
    ['missing reference', {}],
    ['institution', { reference: 'CRD 0003', referenceKey: 'CRD0003', institution: 'GALICIA' as const }],
    ['institutionOther', { reference: 'CRD 0003', referenceKey: 'CRD0003', institutionOther: 'Banco X' }],
    ['institution OTHER with its label', { reference: 'CRD 0003', referenceKey: 'CRD0003', institution: 'OTHER' as const, institutionOther: 'Banco X' }],
  ])('CC-3 NEW CARD_CREDIT rejects %s (400), like a card debit', async (_label, fields) => {
    const t = setup();
    t.sealPlan([planTender('CARD_CREDIT', 'BALANCE', 'NEW', null)], { ...CREDIT_SNAPSHOT, balanceMethod: 'CARD_CREDIT', expectedBalanceAmount: 46000n });
    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({ tenders: [confirmTender('CARD_CREDIT', fields)] })),
      400,
      'VALIDATION_ERROR',
    );
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0 });
  });

  it('CC-4 an attempt sealed WITHOUT a credit snapshot (algorithmVersion 1) can never settle a CARD_CREDIT tender', async () => {
    const t = setup();
    // Version-1 snapshot (fullPriceCredit / creditAdjustmentBps NULL) but a plan that names CARD_CREDIT.
    t.sealPlan([planTender('CARD_CREDIT', 'BALANCE', 'NEW', null)], { balanceMethod: 'CARD_CREDIT', expectedBalanceAmount: 46000n });
    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
        tenders: [confirmTender('CARD_CREDIT', { reference: 'CRD 0004', referenceKey: 'CRD0004' })],
      })),
      500,
      'CHECKOUT_PLAN_INCONSISTENT',
    );
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, collections: 0 });
  });

  it('CC-5 a historical (version 1, credit-free) attempt still settles and its checkout keeps version 1 with NULL credit', async () => {
    const t = setup();
    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation());
    expect(t.db.extra.saleCheckout[0]).toMatchObject({ algorithmVersion: 1, fullPriceCredit: null, creditAdjustmentBps: null });
    expect(t.audits('SALE_CHECKOUT_COMPLETED')[0]!.after).toMatchObject({ fullPrices: { CASH: '40000' }, adjustments: { transfer: 1000, debit: 500 } });
    expect(Object.keys((t.audits('SALE_CHECKOUT_COMPLETED')[0]!.after as { fullPrices: object }).fullPrices)).not.toContain('CARD_CREDIT');
  });

  it('CC-6 a credit reference already recorded on the branch is refused (own partial unique key, separate from debit)', async () => {
    const t = setup();
    t.addCollection({ branchId: BRANCH, method: 'CARD_CREDIT', amount: 100n, referenceKey: 'CRD0005', institution: null, status: 'APPLIED' });
    t.sealPlan([planTender('CARD_CREDIT', 'BALANCE', 'NEW', null)], { ...CREDIT_SNAPSHOT, balanceMethod: 'CARD_CREDIT', expectedBalanceAmount: 46000n });
    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
        tenders: [confirmTender('CARD_CREDIT', { reference: 'CRD 0005', referenceKey: 'CRD0005' })],
      })),
      409,
      'EXTERNAL_REFERENCE_ALREADY_RECORDED',
    );
    // The same reference as a DEBIT is a different namespace: it does not collide.
    const t2 = setup();
    t2.addCollection({ branchId: BRANCH, method: 'CARD_DEBIT', amount: 100n, referenceKey: 'CRD0005', institution: null, status: 'APPLIED' });
    t2.sealPlan([planTender('CARD_CREDIT', 'BALANCE', 'NEW', null)], { ...CREDIT_SNAPSHOT, balanceMethod: 'CARD_CREDIT', expectedBalanceAmount: 46000n });
    await expect(t2.checkout.checkout(t2.reqs.cashier, t2.ids.cashier, t2.saleId, t2.confirmation({
      tenders: [confirmTender('CARD_CREDIT', { reference: 'CRD 0005', referenceKey: 'CRD0005' })],
    }))).resolves.toMatchObject({ status: 'COMPLETED' });
  });
});

// ---------------------------------------------------------------------------
// QR (P0-B): T-C settles a sealed plan that carries QR exactly like the other external
// methods, from the sealed QR snapshot (algorithmVersion 3). The harness company
// configuration has QR +12% (1200 bps) on the 40000-centavo line: QR full price 44800 --
// and a later change of that configuration never reaches a sealed attempt.
// ---------------------------------------------------------------------------
describe('QR — T-C settlement', () => {
  const planTender = (
    method: string, role: string, source: string, amount: bigint | null, externalCollectionId: string | null = null,
  ) => ({ method, role, source, amount, externalCollectionId });
  const confirmTender = (
    method: 'CASH' | 'QR', fields: Partial<CheckoutConfirmationRequest['tenders'][number]> = {},
  ): CheckoutConfirmationRequest['tenders'][number] => ({
    method, receivedAmount: method === 'CASH' ? 12000n : null, reference: null, referenceKey: null, institution: null, institutionOther: null, ...fields,
  });
  const QR_SNAPSHOT = { algorithmVersion: 3, fullPriceQr: 44800n, qrAdjustmentBps: 1200 };

  it('CQ-1 CASH fixed + QR balance settle one referenced QR collection, from the sealed QR price, with no cash movement for QR', async () => {
    const t = setup();
    // balance = 44.800 * (40.000 - 10.000) / 40.000 = 33.600 ; total = 43.600
    t.sealPlan([
      planTender('CASH', 'FIXED', 'NEW', 10000n),
      planTender('QR', 'BALANCE', 'NEW', null),
    ], { ...QR_SNAPSHOT, balanceMethod: 'QR', expectedBalanceAmount: 33600n });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [confirmTender('CASH'), confirmTender('QR', { reference: 'QR 0001', referenceKey: 'QR0001' })],
    }));

    expect(result).toMatchObject({ status: 'COMPLETED', total: 43600n, changeAmount: 2000n });
    const qr = t.table('salePayment').find((payment) => payment.method === 'QR')!;
    expect(qr).toMatchObject({ amount: 33600n, tenderRole: 'BALANCE', methodFullPrice: 44800n, adjustmentBps: 1200, receivedAmount: null, changeAmount: null });
    expect(t.table('salePayment').find((payment) => payment.method === 'CASH')).toMatchObject({ amount: 10000n, methodFullPrice: 40000n, adjustmentBps: 0 });
    expect(qr.externalCollectionId).toBe(t.db.extra.externalCollection[0]!.id);
    expect(t.db.extra.externalCollection[0]).toMatchObject({
      method: 'QR', amount: 33600n, referenceKey: 'QR0001', institution: null, institutionOther: null, status: 'APPLIED',
    });
    // Only the cash tender touches the cash register: QR is never SALE_INCOME.
    const movements = t.table('cashMovement');
    expect(movements.filter((movement) => movement.salePaymentId === qr.id)).toEqual([]);
    expect(movements.reduce((sum, movement) => sum + (movement.amount as bigint), 0n)).toBe(10000n);
    // Allocations add up to every payment, and the payments to the sealed total.
    for (const payment of t.table('salePayment')) {
      const allocated = t.db.extra.saleLineAllocation
        .filter((allocation) => allocation.salePaymentId === payment.id)
        .reduce((sum, allocation) => sum + (allocation.amount as bigint), 0n);
      expect(allocated).toBe(payment.amount);
    }
    expect(t.table('salePayment').reduce((sum, payment) => sum + (payment.amount as bigint), 0n)).toBe(43600n);
    // The checkout carries the QR snapshot and the format version of its attempt.
    expect(t.db.extra.saleCheckout[0]).toMatchObject({
      balanceMethod: 'QR', fullPriceQr: 44800n, qrAdjustmentBps: 1200, algorithmVersion: 3,
    });
    expect(t.audits('SALE_CHECKOUT_COMPLETED')[0]!.after).toMatchObject({
      fullPrices: { QR: '44800' }, adjustments: { qr: 1200 },
    });
    expect(t.table('inventory')[0]).toMatchObject({ physical: 9n, reserved: 0n });
  });

  it('CQ-2 simple QR: a single QR balance tender covers the whole sealed QR price', async () => {
    const t = setup();
    t.sealPlan([planTender('QR', 'BALANCE', 'NEW', null)], { ...QR_SNAPSHOT, balanceMethod: 'QR', expectedBalanceAmount: 44800n });

    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [confirmTender('QR', { reference: 'QR 0002', referenceKey: 'QR0002' })],
    }));

    expect(result).toMatchObject({ status: 'COMPLETED', total: 44800n, changeAmount: 0n });
    expect(t.table('salePayment')).toHaveLength(1);
    expect(t.table('salePayment')[0]).toMatchObject({ method: 'QR', amount: 44800n, methodFullPrice: 44800n, adjustmentBps: 1200 });
    expect(t.table('cashMovement')).toHaveLength(0);
  });

  it.each([
    ['missing reference', {}],
    ['institution', { reference: 'QR 0003', referenceKey: 'QR0003', institution: 'GALICIA' as const }],
    ['institutionOther', { reference: 'QR 0003', referenceKey: 'QR0003', institutionOther: 'Banco X' }],
    ['institution OTHER with its label', { reference: 'QR 0003', referenceKey: 'QR0003', institution: 'OTHER' as const, institutionOther: 'Banco X' }],
  ])('CQ-3 NEW QR rejects %s (400), like a card', async (_label, fields) => {
    const t = setup();
    t.sealPlan([planTender('QR', 'BALANCE', 'NEW', null)], { ...QR_SNAPSHOT, balanceMethod: 'QR', expectedBalanceAmount: 44800n });
    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({ tenders: [confirmTender('QR', fields)] })),
      400,
      'VALIDATION_ERROR',
    );
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0 });
  });

  it('CQ-4 an attempt sealed WITHOUT a QR snapshot (algorithmVersion 2) can never settle a QR tender', async () => {
    const t = setup();
    t.sealPlan([planTender('QR', 'BALANCE', 'NEW', null)], { algorithmVersion: 2, balanceMethod: 'QR', expectedBalanceAmount: 44800n });
    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
        tenders: [confirmTender('QR', { reference: 'QR 0004', referenceKey: 'QR0004' })],
      })),
      500,
      'CHECKOUT_PLAN_INCONSISTENT',
    );
    expect(t.counts()).toMatchObject({ checkouts: 0, payments: 0, collections: 0 });
  });

  it('CQ-5 a historical (version 1, QR-free) attempt still settles; its checkout keeps version 1 with NULL QR and an unchanged audit shape', async () => {
    const t = setup();
    await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation());
    expect(t.db.extra.saleCheckout[0]).toMatchObject({ algorithmVersion: 1, fullPriceQr: null, qrAdjustmentBps: null });
    expect(Object.keys((t.audits('SALE_CHECKOUT_COMPLETED')[0]!.after as { fullPrices: object }).fullPrices)).not.toContain('QR');
    expect(Object.keys((t.audits('SALE_CHECKOUT_COMPLETED')[0]!.after as { adjustments: object }).adjustments)).not.toContain('qr');
  });

  it('CQ-6 a QR reference already recorded on the branch is refused (own partial unique key); the same key as CARD_CREDIT is another namespace', async () => {
    const t = setup();
    t.addCollection({ branchId: BRANCH, method: 'QR', amount: 100n, referenceKey: 'QR0005', institution: null, status: 'APPLIED' });
    t.sealPlan([planTender('QR', 'BALANCE', 'NEW', null)], { ...QR_SNAPSHOT, balanceMethod: 'QR', expectedBalanceAmount: 44800n });
    await expectAppError(
      t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
        tenders: [confirmTender('QR', { reference: 'QR 0005', referenceKey: 'QR0005' })],
      })),
      409,
      'EXTERNAL_REFERENCE_ALREADY_RECORDED',
    );
    const t2 = setup();
    t2.addCollection({ branchId: BRANCH, method: 'CARD_CREDIT', amount: 100n, referenceKey: 'QR0005', institution: null, status: 'APPLIED' });
    t2.sealPlan([planTender('QR', 'BALANCE', 'NEW', null)], { ...QR_SNAPSHOT, balanceMethod: 'QR', expectedBalanceAmount: 44800n });
    await expect(t2.checkout.checkout(t2.reqs.cashier, t2.ids.cashier, t2.saleId, t2.confirmation({
      tenders: [confirmTender('QR', { reference: 'QR 0005', referenceKey: 'QR0005' })],
    }))).resolves.toMatchObject({ status: 'COMPLETED' });
  });

  it('CQ-7 the sealed QR snapshot wins over the current configuration: changing qrAdjustmentBps after the seal changes nothing', async () => {
    const t = setup();
    t.sealPlan([planTender('QR', 'BALANCE', 'NEW', null)], { ...QR_SNAPSHOT, balanceMethod: 'QR', expectedBalanceAmount: 44800n });
    t.db.table('companyPricingConfig')[0]!.qrAdjustmentBps = 3000;
    const result = await t.checkout.checkout(t.reqs.cashier, t.ids.cashier, t.saleId, t.confirmation({
      tenders: [confirmTender('QR', { reference: 'QR 0006', referenceKey: 'QR0006' })],
    }));
    expect(result).toMatchObject({ status: 'COMPLETED', total: 44800n });
    expect(t.table('salePayment')[0]).toMatchObject({ method: 'QR', amount: 44800n, adjustmentBps: 1200 });
    expect(t.db.extra.saleCheckout[0]).toMatchObject({ qrAdjustmentBps: 1200, fullPriceQr: 44800n });
  });
});
