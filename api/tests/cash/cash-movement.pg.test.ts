// PILOT cash exits (migration 10) — the FINAL opt-in SERVICE-LEVEL PostgreSQL
// gate for WITHDRAWAL/EXPENSE cash movements (PG-CM-01..PG-CM-18 plus the
// RBAC/scope, money-bound and reconciliation-regression cases). OPT-IN ONLY.
// What only a real PostgreSQL proves here: migration 10's live DDL (the two
// new enum labels, the two nullable columns, the (sessionId, idempotencyKey)
// unique index and the three conditional CHECKs actually enforcing on INSERT),
// the idempotent replay on a real Serializable engine — including AFTER the
// session close —, genuine serialization of concurrent exits and of the
// exit-vs-close race on the CashSession row lock, the exact BIGINT
// reconciliation arithmetic on int8 columns, and movement+audit atomicity
// under an injected audit failure.
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with
// migrations 1–10 and the canonical baseline catalog (oldest Company + at
// least one ProductVariant), bound by marker + system id:
//   MONA_CASH_MOVEMENTS_PG=1 MONA_CASH_MOVEMENTS_PG_DISPOSABLE=1
//   MONA_TEST_DATABASE_TARGET=local LOCAL_TEST_DATABASE_URL=…
//   LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_CASH_MOVEMENTS_PG_SYSTEM_ID=<pg_control_system().system_identifier>
// Fixtures are COMMITTED and PERMANENT by design (a unique pointOfSaleNumber
// per run; nothing baseline-owned is ever mutated), hence the explicit
// DISPOSABLE acknowledgement: the cluster is discarded afterwards, never
// reused. The audit-failure case (PG-CM-18) installs a temporary trigger on
// "AuditLog" and always drops it in `finally`.
//
// OVERLAP IS PROVEN, NOT ASSUMED (the audited R3-U2 convention): every race
// first holds the contended CashSession row lock on an independent
// COORDINATOR connection, starts the real service calls on independent
// pools, and only releases after pg_stat_activity + pg_blocking_pids prove
// the racing backends are genuinely in the coordinator's lock-wait chain.
//
// Concurrency semantics on this engine: two Serializable transactions that
// both block on the coordinator's lock take their snapshots before either
// racer commits, so the second racer either observes the first's committed
// exit after a 40001 retry (domain outcome: INSUFFICIENT_CASH_IN_DRAWER,
// CASH_SESSION_ALREADY_CLOSED, or an exact reconciliation) or, for a
// duplicate idempotency key, is stopped by the unique index itself. Every
// case below asserts the DURABLE invariant (exactly the movements and audits
// the contract allows), never an incidental interleaving.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { createCashService } from '../../src/modules/cash/cash.service.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { AppError } from '../../src/shared/errors.js';
import {
  PG_SYSTEM_ID,
  RACE_TIMEOUT_MS,
  holdRowLock,
  pointOfSaleNumberFor,
  waitForBlocked,
  withTimeout,
} from '../helpers/r3-service-pg.js';

const enabled = process.env.MONA_CASH_MOVEMENTS_PG === '1';

// Migration 10 is additive over the nine reviewed migrations, and the additive
// cash-reversal migration 11 follows it (G11); the ledger must be exactly this
// set, in this order, all finished and none rolled back.
const APPROVED_MIGRATIONS = [
  '20260907015311_init',
  '20260912182432_add_company_location',
  '20260912191702_add_user_role_scope',
  '20260922210000_d3_initial_stock_and_global_audit',
  '20261002120000_block1_pricing_wholesale',
  '20261006120000_pilot_pricing_v2',
  '20261012120000_cash_session_reconciliation',
  '20261016120000_r3_proportional_checkout',
  '20261016130000_r3_checkout_attempts',
  '20261018120000_cash_movement_withdrawals_expenses',
  '20261018180000_cash_movement_reversals',
] as const;

const MAX_SIGNED_BIGINT = 9223372036854775807n;
// 2^53 + 1: exactly representable in neither float64 nor Number arithmetic.
const FLOAT_UNSAFE = 9007199254740993n;

type World = {
  tag: string;
  branchId: string;
  registerId: string;
  sessionId: string;
  cashier: string;
  owner: string;
  admin: string;
  ladmin: string;
  seller: string;
  warehouse: string;
  cashierCtx: unknown;
  ownerCtx: unknown;
  adminCtx: unknown;
  ladminCtx: unknown;
  sellerCtx: unknown;
  warehouseCtx: unknown;
};

// The cash service methods receive the AUTH CONTEXT itself (req.auth), not
// the request: the inner shape the policy layer reads — userId, roles,
// effectiveLocationIds and assignments with permission + scope from the SAME
// assignment. OWNER: a valid COMPANY assignment with an empty permissions
// array (OWNER authority is implicit). CASHIER/SELLER/WAREHOUSE: LOCATION
// scope at the branch with their real catalogued grants. ADMIN: COMPANY scope
// with every catalogued permission.
function ownerCtxOf(userId: string): unknown {
  return {
    userId, roles: ['OWNER'], effectiveLocationIds: [],
    assignments: [{ roleId: 'OWNER', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }],
  };
}

function companyAdminCtxOf(userId: string): unknown {
  return {
    userId, roles: ['ADMIN'], effectiveLocationIds: [],
    assignments: [{ roleId: 'ADMIN', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] }],
  };
}

function cashierCtxOf(userId: string, branchId: string): unknown {
  return {
    userId, roles: ['CASHIER'], effectiveLocationIds: [branchId],
    assignments: [{ roleId: 'CASHIER', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: branchId, permissions: [...DEFAULT_ROLE_GRANTS.CASHIER] }],
  };
}

// LOCATION-scoped actors the supervisor rule must NOT accept: an ADMIN that is
// never COMPANY (not a supervisor), a SELLER and a WAREHOUSE with their real
// catalogued grants.
function locationCtxOf(userId: string, roleCode: 'ADMIN' | 'SELLER' | 'WAREHOUSE', branchId: string): unknown {
  const grants = roleCode === 'ADMIN' ? DEFAULT_ROLE_GRANTS.ADMIN
    : roleCode === 'SELLER' ? DEFAULT_ROLE_GRANTS.SELLER
      : DEFAULT_ROLE_GRANTS.WAREHOUSE;
  return {
    userId, roles: [roleCode], effectiveLocationIds: [branchId],
    assignments: [{ roleId: roleCode, roleCode, scopeKind: 'LOCATION', locationId: branchId, permissions: [...grants] }],
  };
}

// A COMPANY-scoped ADMIN whose ONLY assignment carries NO permission: the
// composition guard (permission + scope from the SAME assignment) must refuse.
function bareCompanyAdminCtxOf(userId: string): unknown {
  return {
    userId, roles: ['ADMIN'], effectiveLocationIds: [],
    assignments: [{ roleId: 'ADMIN', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [] }],
  };
}

describe.skipIf(!enabled)('PILOT cash exits (migration 10) on PostgreSQL — PG-CM-01..18, RBAC and reconciliation (disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;
  let racerA: PrismaClient;
  let racerB: PrismaClient;

  beforeAll(async () => {
    if (process.env.MONA_CASH_MOVEMENTS_PG_DISPOSABLE !== '1') {
      throw new Error('the CM PG suite writes permanent rows: MONA_CASH_MOVEMENTS_PG_DISPOSABLE=1 is required');
    }
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_CASH_MOVEMENTS_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) {
      throw new Error('isolated cluster binding is missing: MONA_CASH_MOVEMENTS_PG_SYSTEM_ID must be the decimal pg_control_system().system_identifier of the target');
    }
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    // pools[0]: coordinator + fixtures + observer; pools[1]/pools[2]: racers.
    for (const max of [6, 2, 2]) {
      const { pool } = await openProvenLocalTestPool(max, process.env);
      pools.push(pool);
      clients.push(new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] }));
    }
    [db, racerA, racerB] = clients as [PrismaClient, PrismaClient, PrismaClient];
    const { rows } = await pools[0]!.query<{ system_id: string; migrated: boolean }>(
      `SELECT system_identifier::text AS system_id,
              to_regclass('public."CashMovement_sessionId_idempotencyKey_key"') IS NOT NULL AS migrated
         FROM pg_control_system()`,
    );
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    if (rows[0]?.migrated !== true) throw new Error('migration 10 is required');
  });

  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    for (const pool of pools) await pool.end();
  });

  // --- fixtures ---------------------------------------------------------------

  async function makeBranch(tag: string): Promise<{ branchId: string; registerId: string }> {
    const company = await db.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    const branchId = randomUUID();
    await db.location.create({ data: {
      id: branchId, companyId: company.id, code: `cm-${tag}`, name: `CM ${tag}`,
      type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: pointOfSaleNumberFor('CM', tag),
    } });
    await db.branch.create({ data: { id: branchId, code: `cm-${tag}`, name: `CM ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    const register = await db.cashRegister.create({ data: { branchId, name: `CM ${tag}` } });
    return { branchId, registerId: register.id };
  }

  async function makeWorld(startingCash: bigint): Promise<World> {
    const tag = randomUUID().slice(0, 8);
    const base = await makeBranch(tag);
    const ids = {
      cashier: randomUUID(), owner: randomUUID(), admin: randomUUID(),
      ladmin: randomUUID(), seller: randomUUID(), warehouse: randomUUID(),
    };
    for (const [name, id] of Object.entries(ids)) {
      await db.user.create({ data: { id, name: `CM ${tag} ${name}`, email: `cm-${tag}-${name}@test.invalid`, passwordHash: 'not-used' } });
    }
    const opened = await createCashService(db).openSession(
      base.registerId, cashierCtxOf(ids.cashier, base.branchId) as never, startingCash,
    );
    return {
      tag, branchId: base.branchId, registerId: base.registerId, sessionId: opened.sessionId,
      cashier: ids.cashier, owner: ids.owner, admin: ids.admin, ladmin: ids.ladmin, seller: ids.seller, warehouse: ids.warehouse,
      cashierCtx: cashierCtxOf(ids.cashier, base.branchId),
      ownerCtx: ownerCtxOf(ids.owner),
      adminCtx: companyAdminCtxOf(ids.admin),
      ladminCtx: locationCtxOf(ids.ladmin, 'ADMIN', base.branchId),
      sellerCtx: locationCtxOf(ids.seller, 'SELLER', base.branchId),
      warehouseCtx: locationCtxOf(ids.warehouse, 'WAREHOUSE', base.branchId),
    };
  }

  // A direct SALE_INCOME row plus its 1:1 CASH SalePayment (the exact shape
  // the reconciliation cross-checks). Used where the income itself is not the
  // case under test; PG-CM-15 exercises the REAL payments service instead.
  async function directIncome(w: World, amount: bigint): Promise<void> {
    const sale = await db.sale.create({ data: {
      branchId: w.branchId, sellerId: w.cashier, status: 'PAID',
      priceMode: 'CASH', pricingMode: 'LIST', subtotal: amount, discountTotal: 0n, total: amount,
    } });
    const payment = await db.salePayment.create({ data: {
      saleId: sale.id, method: 'CASH', amount, receivedAmount: amount, changeAmount: 0n,
      cashSessionId: w.sessionId, idempotencyKey: randomUUID(),
    } });
    await db.cashMovement.create({ data: {
      sessionId: w.sessionId, type: 'SALE_INCOME', amount, salePaymentId: payment.id, userId: w.cashier,
    } });
  }

  // The real payments-service fixture: a PENDING_PAYMENT sale with exact
  // current ACTIVE hold coverage (mirrors the audited CASH-1 fixture).
  async function pendingSale(w: World, total: bigint): Promise<string> {
    const variant = await db.productVariant.findFirstOrThrow({ select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } });
    await db.inventory.create({ data: { variantId: variant.id, branchId: w.branchId, physical: 1n, reserved: 1n } });
    const sale = await db.sale.create({ data: {
      branchId: w.branchId, sellerId: w.cashier, status: 'PENDING_PAYMENT',
      priceMode: 'CASH', pricingMode: 'LIST', subtotal: total, discountTotal: 0n, total,
    } });
    await db.saleItem.create({ data: {
      saleId: sale.id, variantId: variant.id, productId: variant.productId,
      productName: `CM ${w.tag}`, variantName: 'CM', sku: variant.sku,
      quantity: 1n, unitPrice: total, subtotal: total,
    } });
    await db.stockReservation.create({ data: {
      saleId: sale.id, variantId: variant.id, branchId: w.branchId,
      quantity: 1n, expiresAt: new Date(Date.now() + 3_600_000), status: 'ACTIVE',
    } });
    return sale.id;
  }

  // A raw INSERT that EXPECTS a PostgreSQL refusal. Returns the SQLSTATE and
  // constraint name, or null when the statement unexpectedly succeeded.
  async function rawViolation(text: string, values: readonly unknown[]): Promise<{ code: string | null; constraint: string | null } | null> {
    try {
      await pools[0]!.query(text, [...values]);
      return null;
    } catch (error) {
      const candidate = error as { code?: unknown; constraint?: unknown };
      return {
        code: typeof candidate.code === 'string' ? candidate.code : null,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : null,
      };
    }
  }

  const insertExit = (sessionId: string, userId: string, type: 'WITHDRAWAL' | 'EXPENSE', amount: string | number, reason: string | null, key: string | null, salePaymentId: string | null) =>
    rawViolation(
      `INSERT INTO "CashMovement" (id, "sessionId", type, amount, "salePaymentId", "userId", reason, "idempotencyKey")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [randomUUID(), sessionId, type, amount, salePaymentId, userId, reason, key],
    );

  async function appErrorOf(promise: Promise<unknown>): Promise<AppError | null> {
    try {
      await promise;
      return null;
    } catch (error) {
      if (error instanceof AppError) return error;
      throw error;
    }
  }

  async function anyErrorOf(promise: Promise<unknown>): Promise<Error | null> {
    try {
      await promise;
      return null;
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
  }

  const auditCount = (entityId: string) => db.auditLog.count({ where: { entityType: 'CashMovement', entityId } });

  const svc = () => createCashService(db);

  // --- PG-CM-01..18 -----------------------------------------------------------

  it('PG-CM-01 migrations 1–11 applied exactly (G11): ledger, enum, columns, unique index and validated CHECKs', async () => {
    const ledger = await pools[0]!.query<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>(
      'SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name',
    );
    expect(ledger.rows.map((row) => row.migration_name)).toEqual([...APPROVED_MIGRATIONS]);
    expect(ledger.rows.every((row) => row.finished_at !== null)).toBe(true);
    expect(ledger.rows.every((row) => row.rolled_back_at === null)).toBe(true);

    const labels = await pools[0]!.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'CashMovementType' ORDER BY e.enumsortorder`,
    );
    expect(labels.rows.map((row) => row.label)).toEqual(['OPENING', 'SALE_INCOME', 'CLOSING', 'MANUAL', 'WITHDRAWAL', 'EXPENSE', 'WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL']);

    const columns = await pools[0]!.query<{ attnum: number; attname: string; data_type: string; attnotnull: boolean }>(
      `SELECT attnum, attname, format_type(atttypid, atttypmod) AS data_type, attnotnull
         FROM pg_attribute
        WHERE attrelid = 'public."CashMovement"'::regclass AND attname IN ('reason', 'idempotencyKey') AND NOT attisdropped
        ORDER BY attnum`,
    );
    expect(columns.rows).toEqual([
      { attnum: 8, attname: 'reason', data_type: 'text', attnotnull: false },
      { attnum: 9, attname: 'idempotencyKey', data_type: 'text', attnotnull: false },
    ]);

    const index = await pools[0]!.query<{ idx: string | null }>('SELECT to_regclass($1) AS idx', ['public."CashMovement_sessionId_idempotencyKey_key"']);
    expect(index.rows[0]?.idx).not.toBeNull();

    const checks = await pools[0]!.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'public."CashMovement"'::regclass AND contype = 'c' AND conname LIKE 'chk_cash_movement_exit%'
        ORDER BY conname`,
    );
    expect(checks.rows).toEqual([
      { conname: 'chk_cash_movement_exit_amount', convalidated: true },
      { conname: 'chk_cash_movement_exit_no_payment', convalidated: true },
      { conname: 'chk_cash_movement_exit_reason', convalidated: true },
    ]);
  });

  it('PG-CM-02 historical OPENING/SALE_INCOME/CLOSING rows stay valid with NULL reason/idempotencyKey; NULL keys never collide', async () => {
    const w = await makeWorld(1000n);
    await directIncome(w, 2500n);
    const closed = await svc().closeSession(w.sessionId, w.cashierCtx as never, 3500n);
    expect(closed).toMatchObject({ status: 'CLOSED', expectedCash: 3500n, difference: 0n });

    const movements = await db.cashMovement.findMany({ where: { sessionId: w.sessionId } });
    expect(movements.map((movement) => movement.type)).toEqual(['OPENING', 'SALE_INCOME', 'CLOSING']);
    for (const movement of movements) {
      expect(movement.reason).toBeNull();
      expect(movement.idempotencyKey).toBeNull();
    }

    // A second session on the same register: two OPENING rows, both with NULL
    // keys, coexist — PostgreSQL unique indexes treat NULLs as distinct, so the
    // migration never invalidated the historical shape.
    const second = await svc().openSession(w.registerId, w.cashierCtx as never, 500n);
    const openings = await db.cashMovement.findMany({ where: { type: 'OPENING', idempotencyKey: null } });
    expect(openings.length).toBeGreaterThanOrEqual(2);
    expect(second.sessionId).not.toBe(w.sessionId);
  });

  it('PG-CM-03 an invalid WITHDRAWAL amount <= 0 is refused by the service (400) and by the DB CHECK (23514)', async () => {
    const w = await makeWorld(1000n);
    for (const amount of [0n, -1n]) {
      const refused = await appErrorOf(svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
        amount, reason: 'retiro', idempotencyKey: randomUUID(),
      }));
      expect(refused).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    }
    const violation = await insertExit(w.sessionId, w.owner, 'WITHDRAWAL', 0, 'raw', null, null);
    expect(violation).toEqual({ code: '23514', constraint: 'chk_cash_movement_exit_amount' });
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, type: 'WITHDRAWAL' } })).toBe(0);
  });

  it('PG-CM-04 an invalid EXPENSE amount <= 0 is refused by the service (400) and by the DB CHECK (23514)', async () => {
    const w = await makeWorld(1000n);
    const refused = await appErrorOf(svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: -5n, reason: 'gasto', idempotencyKey: randomUUID(),
    }));
    expect(refused).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    const violation = await insertExit(w.sessionId, w.cashier, 'EXPENSE', 0, 'raw', null, null);
    expect(violation).toEqual({ code: '23514', constraint: 'chk_cash_movement_exit_amount' });
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, type: 'EXPENSE' } })).toBe(0);
  });

  it('PG-CM-05 a WITHDRAWAL/EXPENSE without a real reason is refused by the service (400) and by the DB CHECK (NULL and blank)', async () => {
    const w = await makeWorld(1000n);
    const refused = await appErrorOf(svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: 100n, reason: '   ', idempotencyKey: randomUUID(),
    }));
    expect(refused).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });

    expect(await insertExit(w.sessionId, w.owner, 'WITHDRAWAL', 10, null, null, null))
      .toEqual({ code: '23514', constraint: 'chk_cash_movement_exit_reason' });
    expect(await insertExit(w.sessionId, w.cashier, 'EXPENSE', 10, '   ', null, null))
      .toEqual({ code: '23514', constraint: 'chk_cash_movement_exit_reason' });
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, type: { in: ['WITHDRAWAL', 'EXPENSE'] } } })).toBe(0);
  });

  it('PG-CM-06 an exit carrying salePaymentId is refused by the DB CHECK (23514); service-written exits never carry one', async () => {
    const w = await makeWorld(1000n);
    const sale = await db.sale.create({ data: {
      branchId: w.branchId, sellerId: w.cashier, status: 'PAID',
      priceMode: 'CASH', pricingMode: 'LIST', subtotal: 10n, discountTotal: 0n, total: 10n,
    } });
    const payment = await db.salePayment.create({ data: {
      saleId: sale.id, method: 'CASH', amount: 10n, receivedAmount: 10n, changeAmount: 0n,
      cashSessionId: w.sessionId, idempotencyKey: randomUUID(),
    } });
    const violation = await insertExit(w.sessionId, w.owner, 'WITHDRAWAL', 10, 'raw', null, payment.id);
    expect(violation).toEqual({ code: '23514', constraint: 'chk_cash_movement_exit_no_payment' });

    const exit = await svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: 10n, reason: 'gasto', idempotencyKey: randomUUID(),
    });
    expect(exit.movement.salePaymentId).toBeNull();
  });

  it('PG-CM-07 (sessionId, idempotencyKey) is unique: a duplicate INSERT is 23505 and concurrent same-key calls persist exactly one movement', async () => {
    const w = await makeWorld(1000n);
    const key = randomUUID();
    const first = await svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: 100n, reason: 'gasto', idempotencyKey: key,
    });
    expect(first.replayed).toBe(false);

    // The unique index is the durable race guard behind the service replay.
    const violation = await insertExit(w.sessionId, w.cashier, 'EXPENSE', 100, 'gasto', key, null);
    expect(violation).toEqual({ code: '23505', constraint: 'CashMovement_sessionId_idempotencyKey_key' });

    // Two CONCURRENT same-key, same-payload calls (a client retry while the
    // first request is still in flight). The unique index keeps the durable
    // state at exactly one movement + one audit; the loser either replays
    // (40001 retry, then the existing row) or is stopped by the index itself.
    const coordinator = await holdRowLock(pools[0]!, 'CashSession', w.sessionId);
    try {
      const secondKey = randomUUID();
      const callA = createCashService(racerA).registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
        amount: 50n, reason: 'gasto', idempotencyKey: secondKey,
      });
      const callB = createCashService(racerB).registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
        amount: 50n, reason: 'gasto', idempotencyKey: secondKey,
      });
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      const [a, b] = await withTimeout(Promise.allSettled([callA, callB]), RACE_TIMEOUT_MS, 'PG-CM-07 concurrent same-key calls');

      const durable = await db.cashMovement.findMany({ where: { sessionId: w.sessionId, idempotencyKey: secondKey } });
      expect(durable.length).toBe(1);
      expect(await auditCount(durable[0]!.id)).toBe(1);
      const fulfilled = [a, b].flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : []));
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      for (const result of fulfilled) {
        expect(result.movement.id).toBe(durable[0]!.id);
      }
      for (const outcome of [a, b]) {
        if (outcome.status === 'rejected') {
          // The engine-level stop: a Prisma unique-constraint error (P2002) or
          // a serialization retry that exhausted its attempts. Never a silent
          // duplicate: the durable count above is exactly one.
          expect(outcome.reason).toBeInstanceOf(Error);
        }
      }
    } finally {
      await coordinator.release();
    }
  });

  it('PG-CM-08 same key + same payload replays: replayed=true, one CashMovement, one AuditLog', async () => {
    const w = await makeWorld(1000n);
    const key = randomUUID();
    const first = await svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
      amount: 200n, reason: 'retiro', idempotencyKey: key,
    });
    expect(first.replayed).toBe(false);
    const replay = await svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
      amount: 200n, reason: 'retiro', idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.movement).toMatchObject({ id: first.movement.id, type: 'WITHDRAWAL', amount: 200n, reason: 'retiro' });
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, idempotencyKey: key } })).toBe(1);
    expect(await auditCount(first.movement.id)).toBe(1);
  });

  it('PG-CM-09 same key + different payload (amount, kind, reason) is 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', async () => {
    const w = await makeWorld(1000n);
    const key = randomUUID();
    await svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: 100n, reason: 'gasto', idempotencyKey: key,
    });
    const differentAmount = await appErrorOf(svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: 101n, reason: 'gasto', idempotencyKey: key,
    }));
    expect(differentAmount).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    const differentKind = await appErrorOf(svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
      amount: 100n, reason: 'gasto', idempotencyKey: key,
    }));
    expect(differentKind).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    const differentReason = await appErrorOf(svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: 100n, reason: 'otro', idempotencyKey: key,
    }));
    expect(differentReason).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, idempotencyKey: key } })).toBe(1);
  });

  it('PG-CM-10 a replay AFTER the close returns the original result with no new movement or audit', async () => {
    const w = await makeWorld(1000n);
    const key = randomUUID();
    const first = await svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: 300n, reason: 'gasto', idempotencyKey: key,
    });
    await svc().closeSession(w.sessionId, w.cashierCtx as never, 700n);
    const replay = await svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: 300n, reason: 'gasto', idempotencyKey: key,
    });
    expect(replay.replayed).toBe(true);
    expect(replay.movement.id).toBe(first.movement.id);
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, idempotencyKey: key } })).toBe(1);
    expect(await auditCount(first.movement.id)).toBe(1);
    const movements = await db.cashMovement.findMany({ where: { sessionId: w.sessionId } });
    expect(movements.map((movement) => movement.type).sort()).toEqual(['CLOSING', 'EXPENSE', 'OPENING']);
  });

  it('PG-CM-11 two concurrent withdrawals serialize on CashSession: exactly one persists, no projected-cash overdraft', async () => {
    const w = await makeWorld(1000n);
    const coordinator = await holdRowLock(pools[0]!, 'CashSession', w.sessionId);
    try {
      const callA = createCashService(racerA).registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
        amount: 600n, reason: 'retiro A', idempotencyKey: randomUUID(),
      });
      const callB = createCashService(racerB).registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
        amount: 600n, reason: 'retiro B', idempotencyKey: randomUUID(),
      });
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      const [a, b] = await withTimeout(Promise.allSettled([callA, callB]), RACE_TIMEOUT_MS, 'PG-CM-11 concurrent withdrawals');

      const outcomes = [a, b].map((outcome) => (outcome.status === 'fulfilled' ? 'ok' : 'rejected'));
      expect(outcomes.sort()).toEqual(['ok', 'rejected']);
      const loser = a.status === 'rejected' ? a.reason : b.status === 'rejected' ? b.reason : null;
      expect(loser).toBeInstanceOf(AppError);
      expect((loser as AppError).code).toBe('INSUFFICIENT_CASH_IN_DRAWER');

      const exits = await db.cashMovement.findMany({ where: { sessionId: w.sessionId, type: 'WITHDRAWAL' } });
      expect(exits.length).toBe(1);
      expect(exits[0]!.amount).toBe(600n);
      // The projected drawer after the one committed exit is never negative.
      expect(1000n - exits.reduce((sum, exit) => sum + exit.amount, 0n)).toBe(400n);
      expect(await auditCount(exits[0]!.id)).toBe(1);
    } finally {
      await coordinator.release();
    }
  });

  it('PG-CM-12 a withdrawal racing the close serializes on CashSession: both orders leave an exact, consistent state', async () => {
    const w = await makeWorld(1000n);
    await directIncome(w, 2500n); // projected drawer: 3500
    const coordinator = await holdRowLock(pools[0]!, 'CashSession', w.sessionId);
    try {
      const withdrawal = createCashService(racerA).registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
        amount: 500n, reason: 'retiro', idempotencyKey: randomUUID(),
      });
      const closing = createCashService(racerB).closeSession(w.sessionId, w.cashierCtx as never, 3000n);
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      const [exitOutcome, closeOutcome] = await withTimeout(
        Promise.allSettled([withdrawal, closing]), RACE_TIMEOUT_MS, 'PG-CM-12 withdrawal vs close',
      );

      const session = await db.cashSession.findUniqueOrThrow({ where: { id: w.sessionId } });
      expect(session.status).toBe('CLOSED');
      const exits = await db.cashMovement.findMany({ where: { sessionId: w.sessionId, type: 'WITHDRAWAL' } });

      if (exitOutcome.status === 'fulfilled') {
        // Withdrawal committed first: the close serialized behind it, saw the
        // exit and reconciled exactly (expectedCash 3000, difference 0).
        expect(closeOutcome.status).toBe('fulfilled');
        expect(exits.length).toBe(1);
        expect(session.expectedCash).toBe(3000n);
        expect(session.countedCash).toBe(3000n);
        expect(session.difference).toBe(0n);
      } else {
        // Close committed first: it reconciled the drawer WITHOUT the exit
        // (expectedCash 3500, counted 3000, difference −500) and the withdrawal
        // then found the session CLOSED. No exit is lost or double-counted.
        expect(closeOutcome.status).toBe('fulfilled');
        expect((exitOutcome.reason as AppError).code).toBe('CASH_SESSION_ALREADY_CLOSED');
        expect(exits.length).toBe(0);
        expect(session.expectedCash).toBe(3500n);
        expect(session.countedCash).toBe(3000n);
        expect(session.difference).toBe(-500n);
      }
      // The serialized invariant: expectedCash always equals the exact
      // reconciliation of the committed movements, whatever the order was.
      const movements = await db.cashMovement.findMany({ where: { sessionId: w.sessionId }, select: { type: true, amount: true } });
      const income = movements.filter((movement) => movement.type === 'SALE_INCOME').reduce((sum, movement) => sum + movement.amount, 0n);
      const outgoing = movements.filter((movement) => movement.type === 'WITHDRAWAL' || movement.type === 'EXPENSE').reduce((sum, movement) => sum + movement.amount, 0n);
      expect(session.expectedCash).toBe(1000n + income - outgoing);
    } finally {
      await coordinator.release();
    }
  });

  it('PG-CM-13 amount == projected cash is allowed; a float-unsafe int8 amount round-trips exactly', async () => {
    const w = await makeWorld(FLOAT_UNSAFE);
    const exit = await svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
      amount: FLOAT_UNSAFE, reason: 'retiro completo', idempotencyKey: randomUUID(),
    });
    expect(exit.replayed).toBe(false);
    expect(typeof exit.movement.amount).toBe('bigint');
    expect(exit.movement.amount).toBe(FLOAT_UNSAFE);
    const raw = await pools[0]!.query<{ amount: string }>(
      'SELECT amount::text AS amount FROM "CashMovement" WHERE id = $1', [exit.movement.id],
    );
    expect(raw.rows[0]?.amount).toBe('9007199254740993');
  });

  it('PG-CM-14 amount > projected cash is 409 INSUFFICIENT_CASH_IN_DRAWER with no write', async () => {
    const w = await makeWorld(1000n);
    const before = await db.cashMovement.count({ where: { sessionId: w.sessionId } });
    const refused = await appErrorOf(svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
      amount: 1001n, reason: 'retiro', idempotencyKey: randomUUID(),
    }));
    expect(refused).toMatchObject({ status: 409, code: 'INSUFFICIENT_CASH_IN_DRAWER' });
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId } })).toBe(before);
  });

  it('PG-CM-15 real reconciliation: startingCash + CASH SALE_INCOME − WITHDRAWAL − EXPENSE = expectedCash exactly', async () => {
    const STARTING = 1000n;
    const INCOME = 2500n;
    const WITHDRAWAL = 300n;
    const EXPENSE = 200n;
    const w = await makeWorld(STARTING);

    // The REAL payments service writes the SALE_INCOME movement (regression:
    // the CASH charge path still binds and conciliates on the migration-10
    // schema).
    const saleId = await pendingSale(w, INCOME);
    const paid = await createPaymentsService(db).registerPayment(
      { auth: w.cashierCtx } as Request, w.cashier, saleId,
      { method: 'CASH', amount: INCOME, receivedAmount: INCOME, idempotencyKey: randomUUID() },
    );
    expect(paid).toMatchObject({ replayed: false, resultingStatus: 'PAID' });
    expect(paid.payment.cashSessionId).toBe(w.sessionId);

    await svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
      amount: WITHDRAWAL, reason: 'retiro', idempotencyKey: randomUUID(),
    });
    await svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: EXPENSE, reason: 'gasto', idempotencyKey: randomUUID(),
    });

    const expected = STARTING + INCOME - WITHDRAWAL - EXPENSE;
    const closed = await svc().closeSession(w.sessionId, w.cashierCtx as never, expected);
    expect(closed).toMatchObject({ status: 'CLOSED', expectedCash: expected, difference: 0n });
    const session = await db.cashSession.findUniqueOrThrow({ where: { id: w.sessionId } });
    expect(session.expectedCash).toBe(3000n);
    expect(session.countedCash).toBe(3000n);
    expect(session.difference).toBe(0n);
    const income = await db.cashMovement.findFirstOrThrow({ where: { sessionId: w.sessionId, type: 'SALE_INCOME' } });
    expect(income.amount).toBe(INCOME);
    expect(income.salePaymentId).toBe(paid.payment.id);
  });

  it('PG-CM-16 difference = countedCash − expectedCash, exact in both directions', async () => {
    const shortWorld = await makeWorld(1000n);
    const short = await svc().closeSession(shortWorld.sessionId, shortWorld.cashierCtx as never, 850n);
    expect(short).toMatchObject({ expectedCash: 1000n, difference: -150n });

    const overWorld = await makeWorld(1000n);
    const over = await svc().closeSession(overWorld.sessionId, overWorld.cashierCtx as never, 1090n);
    expect(over).toMatchObject({ expectedCash: 1000n, difference: 90n });
  });

  it('PG-CM-17 a MANUAL movement keeps the close fail-closed (409) with no CLOSING write', async () => {
    const w = await makeWorld(1000n);
    await db.cashMovement.create({ data: {
      sessionId: w.sessionId, type: 'MANUAL', amount: 5n, salePaymentId: null, userId: w.cashier,
    } });
    const refused = await appErrorOf(svc().closeSession(w.sessionId, w.cashierCtx as never, 1000n));
    expect(refused).toMatchObject({ status: 409, code: 'CASH_RECONCILIATION_INCONSISTENT' });
    const session = await db.cashSession.findUniqueOrThrow({ where: { id: w.sessionId } });
    expect(session.status).toBe('OPEN');
    expect(session.expectedCash).toBeNull();
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, type: 'CLOSING' } })).toBe(0);
  });

  it('PG-CM-18 an injected audit failure leaves NO durable CashMovement (full rollback), and the retry then succeeds fresh', async () => {
    const w = await makeWorld(1000n);
    const key = randomUUID();
    await pools[0]!.query(
      `CREATE OR REPLACE FUNCTION public.mona_cm_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $fn$
         BEGIN RAISE EXCEPTION 'CM injected audit failure'; END $fn$`,
    );
    await pools[0]!.query(
      `CREATE TRIGGER mona_cm_audit_fail BEFORE INSERT ON public."AuditLog"
         FOR EACH ROW WHEN (NEW."action" = 'CASH_WITHDRAWAL_REGISTERED')
         EXECUTE FUNCTION public.mona_cm_audit_fail()`,
    );
    try {
      const failure = await anyErrorOf(svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
        amount: 400n, reason: 'retiro', idempotencyKey: key,
      }));
      expect(failure).not.toBeNull();
      expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, idempotencyKey: key } })).toBe(0);
      expect(await db.auditLog.count({ where: { action: 'CASH_WITHDRAWAL_REGISTERED', branchId: w.branchId } })).toBe(0);
    } finally {
      await pools[0]!.query('DROP TRIGGER IF EXISTS mona_cm_audit_fail ON public."AuditLog"');
      await pools[0]!.query('DROP FUNCTION IF EXISTS public.mona_cm_audit_fail()');
    }
    // The transaction fully rolled back, so the same key is still unused.
    const retry = await svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
      amount: 400n, reason: 'retiro', idempotencyKey: key,
    });
    expect(retry.replayed).toBe(false);
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, idempotencyKey: key } })).toBe(1);
  });

  it('MONEY int8 bounds: an amount beyond signed BIGINT is refused by the engine (22003); the service cap is 2^63−1', async () => {
    const w = await makeWorld(MAX_SIGNED_BIGINT);
    const overflow = await insertExit(w.sessionId, w.owner, 'WITHDRAWAL', '9223372036854775808', 'raw', null, null);
    expect(overflow?.code).toBe('22003');
    const refused = await appErrorOf(svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx as never, {
      amount: MAX_SIGNED_BIGINT + 1n, reason: 'retiro', idempotencyKey: randomUUID(),
    }));
    expect(refused).toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
  });

  // --- RBAC and location scope (service level) ---------------------------------

  it('RBAC CASHIER + CASH_MOVEMENT_MANAGE may register an EXPENSE; a WITHDRAWAL is supervisor-only (403)', async () => {
    const w = await makeWorld(1_000_000n);
    const expense = await svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: 100n, reason: 'gasto', idempotencyKey: randomUUID(),
    });
    expect(expense.replayed).toBe(false);
    const denied = await appErrorOf(svc().registerMovement('WITHDRAWAL', w.sessionId, w.cashierCtx as never, {
      amount: 100n, reason: 'retiro', idempotencyKey: randomUUID(),
    }));
    expect(denied).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, type: 'WITHDRAWAL' } })).toBe(0);
  });

  it('RBAC OWNER and a COMPANY-scoped ADMIN may withdraw; a COMPANY ADMIN whose single assignment lacks the permission cannot', async () => {
    const ownerWorld = await makeWorld(1_000_000n);
    const byOwner = await svc().registerMovement('WITHDRAWAL', ownerWorld.sessionId, ownerWorld.ownerCtx as never, {
      amount: 100n, reason: 'retiro', idempotencyKey: randomUUID(),
    });
    expect(byOwner.replayed).toBe(false);

    const adminWorld = await makeWorld(1_000_000n);
    const byAdmin = await svc().registerMovement('WITHDRAWAL', adminWorld.sessionId, adminWorld.adminCtx as never, {
      amount: 100n, reason: 'retiro', idempotencyKey: randomUUID(),
    });
    expect(byAdmin.replayed).toBe(false);

    const bareDenied = await appErrorOf(svc().registerMovement(
      'WITHDRAWAL', adminWorld.sessionId, bareCompanyAdminCtxOf(adminWorld.admin) as never,
      { amount: 100n, reason: 'retiro', idempotencyKey: randomUUID() },
    ));
    expect(bareDenied).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(await db.cashMovement.count({ where: { sessionId: adminWorld.sessionId, type: 'WITHDRAWAL' } })).toBe(1);
  });

  it('RBAC a LOCATION-scoped ADMIN is not a supervisor: WITHDRAWAL 403, EXPENSE allowed at its own location', async () => {
    const w = await makeWorld(1_000_000n);
    const denied = await appErrorOf(svc().registerMovement('WITHDRAWAL', w.sessionId, w.ladminCtx as never, {
      amount: 100n, reason: 'retiro', idempotencyKey: randomUUID(),
    }));
    expect(denied).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const expense = await svc().registerMovement('EXPENSE', w.sessionId, w.ladminCtx as never, {
      amount: 100n, reason: 'gasto', idempotencyKey: randomUUID(),
    });
    expect(expense.replayed).toBe(false);
  });

  it('RBAC SELLER and WAREHOUSE are refused both exits (403), and nothing is written', async () => {
    const w = await makeWorld(1_000_000n);
    for (const ctx of [w.sellerCtx, w.warehouseCtx]) {
      for (const kind of ['EXPENSE', 'WITHDRAWAL'] as const) {
        const denied = await appErrorOf(svc().registerMovement(kind, w.sessionId, ctx as never, {
          amount: 100n, reason: kind === 'EXPENSE' ? 'gasto' : 'retiro', idempotencyKey: randomUUID(),
        }));
        expect(denied).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      }
    }
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, type: { in: ['WITHDRAWAL', 'EXPENSE'] } } })).toBe(0);
  });

  it('RBAC no scope expansion: actors of branch A cannot touch a session of branch B', async () => {
    const worldA = await makeWorld(1_000_000n);
    // A second branch + register + session, opened by OWNER (global authority).
    const tag = randomUUID().slice(0, 8);
    const branchB = await makeBranch(tag);
    const sessionB = await svc().openSession(branchB.registerId, worldA.ownerCtx as never, 500n);

    const cashierDenied = await appErrorOf(svc().registerMovement('EXPENSE', sessionB.sessionId, worldA.cashierCtx as never, {
      amount: 100n, reason: 'gasto', idempotencyKey: randomUUID(),
    }));
    expect(cashierDenied).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const ladminDenied = await appErrorOf(svc().registerMovement('EXPENSE', sessionB.sessionId, worldA.ladminCtx as never, {
      amount: 100n, reason: 'gasto', idempotencyKey: randomUUID(),
    }));
    expect(ladminDenied).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const sellerDenied = await appErrorOf(svc().listMovements(sessionB.sessionId, worldA.sellerCtx as never));
    expect(sellerDenied).toMatchObject({ status: 403, code: 'FORBIDDEN' });

    // The history is readable only with the permission at the register's own branch.
    const listed = await svc().listMovements(sessionB.sessionId, worldA.ownerCtx as never);
    expect(listed.map((movement) => movement.type)).toEqual(['OPENING']);
    expect(await db.cashMovement.count({ where: { sessionId: sessionB.sessionId, type: { in: ['WITHDRAWAL', 'EXPENSE'] } } })).toBe(0);
  });

  it('RECONCILIATION regression: open, real CASH SALE_INCOME, an EXPENSE and the close still reconcile exactly', async () => {
    const STARTING = 500n;
    const INCOME = 800n;
    const EXPENSE = 300n;
    const w = await makeWorld(STARTING);
    const saleId = await pendingSale(w, INCOME);
    const paid = await createPaymentsService(db).registerPayment(
      { auth: w.cashierCtx } as Request, w.cashier, saleId,
      { method: 'CASH', amount: INCOME, receivedAmount: INCOME, idempotencyKey: randomUUID() },
    );
    expect(paid.payment.cashSessionId).toBe(w.sessionId);
    await svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx as never, {
      amount: EXPENSE, reason: 'gasto', idempotencyKey: randomUUID(),
    });
    const expected = STARTING + INCOME - EXPENSE;
    const closed = await svc().closeSession(w.sessionId, w.cashierCtx as never, expected);
    expect(closed).toMatchObject({ status: 'CLOSED', expectedCash: expected, difference: 0n });
  });
});
