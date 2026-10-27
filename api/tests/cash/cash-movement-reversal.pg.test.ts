// PILOT cash movement reversals (migration 11) — the opt-in SERVICE-LEVEL
// PostgreSQL gate for WITHDRAWAL_REVERSAL / EXPENSE_REVERSAL (PG-CR-01..PG-CR-20).
// OPT-IN ONLY. What only a real PostgreSQL proves here: migration 11's live DDL
// (two enum labels, the nullable link column, the one-reversal UNIQUE index,
// the UNIQUE(id, sessionId) candidate key, the composite same-session FK with
// RESTRICT, and the three CHECKs enforcing on INSERT), the idempotent replay on
// a real Serializable engine — including a REAL concurrent same-key race and a
// REAL different-key double reversal resolved through the adapter-pg P2002 —,
// both execution orders of reversal vs close on the CashSession row lock, the
// exact BIGINT reconciliation on int8 columns, and reversal+audit atomicity
// under an injected audit failure.
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with
// migrations 1–11 (G11) and the canonical baseline catalog, bound by marker +
// system id:
//   MONA_CASH_REVERSAL_PG=1 MONA_CASH_REVERSAL_PG_DISPOSABLE=1
//   MONA_TEST_DATABASE_TARGET=local LOCAL_TEST_DATABASE_URL=…
//   LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_CASH_REVERSAL_PG_SYSTEM_ID=<pg_control_system().system_identifier>
// Fixtures are COMMITTED and PERMANENT by design (a unique pointOfSaleNumber
// per run in the CR slot; nothing baseline-owned is ever mutated), hence the
// explicit DISPOSABLE acknowledgement. PG-CR-16 installs a temporary trigger on
// "AuditLog" and always drops it in `finally`.
//
// OVERLAP IS PROVEN, NOT ASSUMED (the audited R3-U2 convention): every race
// first holds the CashSession row lock on an independent COORDINATOR
// connection, starts the real service calls on independent pools, and only
// releases after pg_stat_activity + pg_blocking_pids prove the racers are in
// the coordinator's lock-wait chain. Waiters on one row lock are granted in
// queue order (PostgreSQL's tuple lock), which is how PG-CR-14/15 force each
// execution order of reversal vs close.
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

const enabled = process.env.MONA_CASH_REVERSAL_PG === '1';

// G11: the ledger must be exactly this set, in this order, all finished and none rolled back.
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

type Ctx = never;
type World = {
  tag: string; branchId: string; registerId: string; sessionId: string;
  cashier: string; owner: string; admin: string; ladmin: string;
  cashierCtx: Ctx; ownerCtx: Ctx; adminCtx: Ctx; ladminCtx: Ctx;
};

const ownerCtxOf = (userId: string) => ({
  userId, roles: ['OWNER'], effectiveLocationIds: [],
  assignments: [{ roleId: 'OWNER', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }],
}) as unknown as Ctx;
const companyAdminCtxOf = (userId: string) => ({
  userId, roles: ['ADMIN'], effectiveLocationIds: [],
  assignments: [{ roleId: 'ADMIN', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] }],
}) as unknown as Ctx;
const locationCtxOf = (userId: string, roleCode: 'CASHIER' | 'ADMIN', branchId: string) => ({
  userId, roles: [roleCode], effectiveLocationIds: [branchId],
  assignments: [{ roleId: roleCode, roleCode, scopeKind: 'LOCATION', locationId: branchId, permissions: [...DEFAULT_ROLE_GRANTS[roleCode]] }],
}) as unknown as Ctx;

describe.skipIf(!enabled)('PILOT cash movement reversals (migration 11) on PostgreSQL — PG-CR-01..20 (disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;
  let racerA: PrismaClient;
  let racerB: PrismaClient;

  beforeAll(async () => {
    if (process.env.MONA_CASH_REVERSAL_PG_DISPOSABLE !== '1') {
      throw new Error('the CR PG suite writes permanent rows: MONA_CASH_REVERSAL_PG_DISPOSABLE=1 is required');
    }
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_CASH_REVERSAL_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) {
      throw new Error('isolated cluster binding is missing: MONA_CASH_REVERSAL_PG_SYSTEM_ID must be the decimal pg_control_system().system_identifier of the target');
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
              to_regclass('public."CashMovement_reversesMovementId_key"') IS NOT NULL AS migrated
         FROM pg_control_system()`,
    );
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    if (rows[0]?.migrated !== true) throw new Error('migration 11 is required');
  });

  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    for (const pool of pools) await pool.end();
  });

  // --- fixtures ---------------------------------------------------------------

  async function makeWorld(startingCash: bigint): Promise<World> {
    const tag = randomUUID().slice(0, 8);
    const company = await db.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    const branchId = randomUUID();
    await db.location.create({ data: {
      id: branchId, companyId: company.id, code: `cr-${tag}`, name: `CR ${tag}`,
      type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: pointOfSaleNumberFor('CR', tag),
    } });
    await db.branch.create({ data: { id: branchId, code: `cr-${tag}`, name: `CR ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    const register = await db.cashRegister.create({ data: { branchId, name: `CR ${tag}` } });
    const ids = { cashier: randomUUID(), owner: randomUUID(), admin: randomUUID(), ladmin: randomUUID() };
    for (const [name, id] of Object.entries(ids)) {
      await db.user.create({ data: { id, name: `CR ${tag} ${name}`, email: `cr-${tag}-${name}@test.invalid`, passwordHash: 'not-used' } });
    }
    const cashierCtx = locationCtxOf(ids.cashier, 'CASHIER', branchId);
    const opened = await createCashService(db).openSession(register.id, cashierCtx, startingCash);
    return {
      tag, branchId, registerId: register.id, sessionId: opened.sessionId, ...ids,
      cashierCtx, ownerCtx: ownerCtxOf(ids.owner), adminCtx: companyAdminCtxOf(ids.admin),
      ladminCtx: locationCtxOf(ids.ladmin, 'ADMIN', branchId),
    };
  }

  const svc = (client: PrismaClient = db) => createCashService(client);
  const withdraw = (w: World, amount: bigint, reason = 'retiro mal cargado') =>
    svc().registerMovement('WITHDRAWAL', w.sessionId, w.ownerCtx, { amount, reason, idempotencyKey: randomUUID() });
  const expense = (w: World, amount: bigint, reason = 'gasto mal cargado') =>
    svc().registerMovement('EXPENSE', w.sessionId, w.cashierCtx, { amount, reason, idempotencyKey: randomUUID() });
  const auditCount = (entityId: string) => db.auditLog.count({ where: { entityType: 'CashMovement', entityId } });

  // A raw statement that EXPECTS a PostgreSQL refusal: the SQLSTATE and constraint, or null on success.
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
  const insertRow = (row: { id?: string; sessionId: string; type: string; amount: string | number; userId: string; reason: string | null; key: string | null; link: string | null; salePaymentId?: string | null }) =>
    rawViolation(
      `INSERT INTO "CashMovement" (id, "sessionId", type, amount, "salePaymentId", "userId", reason, "idempotencyKey", "reversesMovementId")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [row.id ?? randomUUID(), row.sessionId, row.type, row.amount, row.salePaymentId ?? null, row.userId, row.reason, row.key, row.link],
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

  // --- PG-CR-01 schema ----------------------------------------------------------

  it('PG-CR-01 migrations 1–11 applied exactly (G11): ledger, enum, column, both unique keys, composite FK and validated CHECKs', async () => {
    const ledger = await pools[0]!.query<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>(
      'SELECT migration_name, finished_at, rolled_back_at FROM public._prisma_migrations ORDER BY migration_name',
    );
    expect(ledger.rows.map((row) => row.migration_name)).toEqual([...APPROVED_MIGRATIONS]);
    expect(ledger.rows.every((row) => row.finished_at !== null && row.rolled_back_at === null)).toBe(true);

    const labels = await pools[0]!.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'CashMovementType' ORDER BY e.enumsortorder`,
    );
    expect(labels.rows.map((row) => row.label)).toEqual(['OPENING', 'SALE_INCOME', 'CLOSING', 'MANUAL', 'WITHDRAWAL', 'EXPENSE', 'WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL']);

    const column = await pools[0]!.query<{ attnum: number; data_type: string; attnotnull: boolean }>(
      `SELECT attnum, format_type(atttypid, atttypmod) AS data_type, attnotnull FROM pg_attribute
        WHERE attrelid = 'public."CashMovement"'::regclass AND attname = 'reversesMovementId' AND NOT attisdropped`,
    );
    expect(column.rows).toEqual([{ attnum: 10, data_type: 'text', attnotnull: false }]);

    const indexes = await pools[0]!.query<{ name: string; unique: boolean; columns: string }>(
      `SELECT c.relname AS name, i.indisunique AS unique,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS columns
         FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE i.indrelid = 'public."CashMovement"'::regclass
          AND c.relname IN ('CashMovement_reversesMovementId_key', 'CashMovement_id_sessionId_key')
        ORDER BY c.relname`,
    );
    expect(indexes.rows).toEqual([
      { name: 'CashMovement_id_sessionId_key', unique: true, columns: 'id,sessionId' },
      { name: 'CashMovement_reversesMovementId_key', unique: true, columns: 'reversesMovementId' },
    ]);

    const fk = await pools[0]!.query<{ conname: string; from_cols: string; to_cols: string; on_delete: string; on_update: string; match: string; validated: boolean; target: string }>(
      `SELECT con.conname,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS from_cols,
              (SELECT string_agg(a.attname, ',' ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
                 JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS to_cols,
              con.confdeltype::text AS on_delete, con.confupdtype::text AS on_update, con.confmatchtype::text AS match,
              con.convalidated AS validated, con.confrelid::regclass::text AS target
         FROM pg_constraint con
        WHERE con.conrelid = 'public."CashMovement"'::regclass AND con.contype = 'f' AND con.conname = 'CashMovement_reversesMovementId_sessionId_fkey'`,
    );
    // r = RESTRICT, s = MATCH SIMPLE (a NULL link is never checked).
    expect(fk.rows).toEqual([{
      conname: 'CashMovement_reversesMovementId_sessionId_fkey', from_cols: 'reversesMovementId,sessionId', to_cols: 'id,sessionId',
      on_delete: 'r', on_update: 'r', match: 's', validated: true, target: '"CashMovement"',
    }]);

    const checks = await pools[0]!.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'public."CashMovement"'::regclass AND contype = 'c' AND conname LIKE 'chk_cash_movement_reversal%'
        ORDER BY conname`,
    );
    expect(checks.rows).toEqual([
      { conname: 'chk_cash_movement_reversal_link', convalidated: true },
      { conname: 'chk_cash_movement_reversal_not_self', convalidated: true },
      { conname: 'chk_cash_movement_reversal_shape', convalidated: true },
    ]);
  });

  // --- PG-CR-02..08 database constraints -----------------------------------------

  it('PG-CR-02 a raw cross-session reversal is refused by the composite FK (23503)', async () => {
    const a = await makeWorld(1000n);
    const b = await makeWorld(1000n);
    const original = await withdraw(a, 100n);
    const refused = await insertRow({ sessionId: b.sessionId, type: 'WITHDRAWAL_REVERSAL', amount: 100, userId: b.owner, reason: 'cruzada', key: randomUUID(), link: original.movement.id });
    expect(refused).toEqual({ code: '23503', constraint: 'CashMovement_reversesMovementId_sessionId_fkey' });
    expect(await db.cashMovement.count({ where: { reversesMovementId: original.movement.id } })).toBe(0);
  });

  it('PG-CR-03 a reversal type without a link is refused (23514 chk_cash_movement_reversal_link)', async () => {
    const w = await makeWorld(1000n);
    for (const type of ['WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL']) {
      expect(await insertRow({ sessionId: w.sessionId, type, amount: 10, userId: w.owner, reason: 'x', key: randomUUID(), link: null }))
        .toEqual({ code: '23514', constraint: 'chk_cash_movement_reversal_link' });
    }
  });

  it('PG-CR-04 a non-reversal type carrying a link is refused (23514 chk_cash_movement_reversal_link)', async () => {
    const w = await makeWorld(1000n);
    const original = await expense(w, 100n);
    for (const type of ['WITHDRAWAL', 'EXPENSE', 'MANUAL']) {
      expect(await insertRow({ sessionId: w.sessionId, type, amount: 10, userId: w.owner, reason: 'x', key: randomUUID(), link: original.movement.id }), type)
        .toEqual({ code: '23514', constraint: 'chk_cash_movement_reversal_link' });
    }
  });

  it('PG-CR-05 a self-referencing reversal is refused (23514 chk_cash_movement_reversal_not_self)', async () => {
    const w = await makeWorld(1000n);
    const id = randomUUID();
    expect(await insertRow({ id, sessionId: w.sessionId, type: 'EXPENSE_REVERSAL', amount: 10, userId: w.owner, reason: 'x', key: randomUUID(), link: id }))
      .toEqual({ code: '23514', constraint: 'chk_cash_movement_reversal_not_self' });
  });

  it('PG-CR-06 a reversal with amount <= 0, a missing/blank reason, no key or a payment link is refused (23514 shape)', async () => {
    const w = await makeWorld(1000n);
    const original = await expense(w, 100n);
    const base = { sessionId: w.sessionId, type: 'EXPENSE_REVERSAL', amount: 100 as string | number, userId: w.owner, reason: 'x' as string | null, key: randomUUID() as string | null, link: original.movement.id };
    for (const patch of [{ amount: 0 }, { amount: -100 }, { reason: null }, { reason: '   ' }, { key: null }]) {
      expect(await insertRow({ ...base, ...patch }), JSON.stringify(patch)).toEqual({ code: '23514', constraint: 'chk_cash_movement_reversal_shape' });
    }
    expect(await db.cashMovement.count({ where: { reversesMovementId: original.movement.id } })).toBe(0);
  });

  it('PG-CR-07 a second reversal of one original is refused by the UNIQUE index (23505)', async () => {
    const w = await makeWorld(1000n);
    const original = await expense(w, 100n);
    await svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'primera', idempotencyKey: randomUUID() });
    expect(await insertRow({ sessionId: w.sessionId, type: 'EXPENSE_REVERSAL', amount: 100, userId: w.owner, reason: 'segunda', key: randomUUID(), link: original.movement.id }))
      .toEqual({ code: '23505', constraint: 'CashMovement_reversesMovementId_key' });
  });

  it('PG-CR-08 a reversed original cannot be deleted or re-keyed (RESTRICT, 23503); the reversal stays linked', async () => {
    const w = await makeWorld(1000n);
    const original = await withdraw(w, 100n);
    const reversal = await svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'x', idempotencyKey: randomUUID() });
    expect(await rawViolation('DELETE FROM "CashMovement" WHERE id = $1', [original.movement.id]))
      .toEqual({ code: '23503', constraint: 'CashMovement_reversesMovementId_sessionId_fkey' });
    expect(await rawViolation('UPDATE "CashMovement" SET id = $2 WHERE id = $1', [original.movement.id, randomUUID()]))
      .toEqual({ code: '23503', constraint: 'CashMovement_reversesMovementId_sessionId_fkey' });
    const after = await db.cashMovement.findUniqueOrThrow({ where: { id: reversal.movement.id } });
    expect(after.reversesMovementId).toBe(original.movement.id);
  });

  // --- PG-CR-09..13 service on the real engine ------------------------------------

  it('PG-CR-09 a correct EXPENSE reversal: exact amount, durable original, one audit, projection restored', async () => {
    const w = await makeWorld(1000n);
    const original = await expense(w, 250n);
    const before = await db.cashMovement.findUniqueOrThrow({ where: { id: original.movement.id } });
    const key = randomUUID();
    const result = await svc().reverseMovement(w.sessionId, original.movement.id, w.adminCtx, { reason: ' cargado dos veces ', idempotencyKey: key });
    expect(result.replayed).toBe(false);
    const row = await db.cashMovement.findUniqueOrThrow({ where: { id: result.movement.id } });
    expect(row).toMatchObject({
      sessionId: w.sessionId, type: 'EXPENSE_REVERSAL', amount: 250n, reason: 'cargado dos veces', idempotencyKey: key,
      reversesMovementId: original.movement.id, salePaymentId: null, userId: w.admin,
    });
    expect(await db.cashMovement.findUniqueOrThrow({ where: { id: original.movement.id } })).toEqual(before);
    const audits = await db.auditLog.findMany({ where: { entityType: 'CashMovement', entityId: result.movement.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'CASH_EXPENSE_REVERSED', branchId: w.branchId, userId: w.admin,
      before: { id: original.movement.id, type: 'EXPENSE', amount: '250' },
      after: {
        reversalMovementId: result.movement.id, originalMovementId: original.movement.id, sessionId: w.sessionId,
        type: 'EXPENSE_REVERSAL', amount: '250', reason: 'cargado dos veces', idempotencyKey: key,
        projectedExpectedCashBefore: '750', projectedExpectedCashAfter: '1000',
      },
    });
  });

  it('PG-CR-10 a correct WITHDRAWAL reversal by the OWNER; a cashier and a LOCATION ADMIN are refused (403) with nothing written', async () => {
    const w = await makeWorld(1000n);
    const original = await withdraw(w, 400n);
    for (const ctx of [w.cashierCtx, w.ladminCtx]) {
      expect(await appErrorOf(svc().reverseMovement(w.sessionId, original.movement.id, ctx, { reason: 'x', idempotencyKey: randomUUID() })))
        .toMatchObject({ status: 403 });
    }
    expect(await db.cashMovement.count({ where: { reversesMovementId: original.movement.id } })).toBe(0);
    const result = await svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'x', idempotencyKey: randomUUID() });
    expect(result.movement).toMatchObject({ type: 'WITHDRAWAL_REVERSAL', amount: 400n, reversesMovementId: original.movement.id });
    expect(await auditCount(result.movement.id)).toBe(1);
  });

  it('PG-CR-11 same key + same payload replays (one reversal, one audit), also AFTER the close; a different payload is 409', async () => {
    const w = await makeWorld(1000n);
    const original = await expense(w, 100n);
    const key = randomUUID();
    const first = await svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'dup', idempotencyKey: key });
    const second = await svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'dup', idempotencyKey: key });
    expect(second).toMatchObject({ replayed: true, movement: { id: first.movement.id } });
    expect(await appErrorOf(svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'otro', idempotencyKey: key })))
      .toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    await svc().closeSession(w.sessionId, w.cashierCtx, 1000n);
    const afterClose = await svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'dup', idempotencyKey: key });
    expect(afterClose).toMatchObject({ replayed: true, movement: { id: first.movement.id } });
    expect(await db.cashMovement.count({ where: { reversesMovementId: original.movement.id } })).toBe(1);
    expect(await auditCount(first.movement.id)).toBe(1);
  });

  it('PG-CR-12 a REAL concurrent same-key race: one reversal, one audit, and BOTH callers answer the same movement', async () => {
    const w = await makeWorld(1000n);
    const original = await withdraw(w, 300n);
    const key = randomUUID();
    const coordinator = await holdRowLock(pools[0]!, 'CashSession', w.sessionId);
    try {
      const callA = svc(racerA).reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'dup', idempotencyKey: key });
      const callB = svc(racerB).reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'dup', idempotencyKey: key });
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      const [a, b] = await withTimeout(Promise.allSettled([callA, callB]), RACE_TIMEOUT_MS, 'PG-CR-12 same-key race');
      expect(a.status, a.status === 'rejected' ? String(a.reason) : '').toBe('fulfilled');
      expect(b.status, b.status === 'rejected' ? String(b.reason) : '').toBe('fulfilled');
      const durable = await db.cashMovement.findMany({ where: { reversesMovementId: original.movement.id } });
      expect(durable).toHaveLength(1);
      for (const outcome of [a, b]) if (outcome.status === 'fulfilled') expect(outcome.value.movement.id).toBe(durable[0]!.id);
      expect([a, b].map((o) => (o.status === 'fulfilled' ? o.value.replayed : null)).sort()).toEqual([false, true]);
      expect(await auditCount(durable[0]!.id)).toBe(1);
    } finally {
      await coordinator.release();
    }
  });

  it('PG-CR-13 a REAL different-key double reversal: one reversal, the loser is 409 CASH_MOVEMENT_ALREADY_REVERSED without details', async () => {
    const w = await makeWorld(1000n);
    const original = await expense(w, 300n);
    const coordinator = await holdRowLock(pools[0]!, 'CashSession', w.sessionId);
    try {
      const callA = svc(racerA).reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'A', idempotencyKey: randomUUID() });
      const callB = svc(racerB).reverseMovement(w.sessionId, original.movement.id, w.adminCtx, { reason: 'B', idempotencyKey: randomUUID() });
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      const [a, b] = await withTimeout(Promise.allSettled([callA, callB]), RACE_TIMEOUT_MS, 'PG-CR-13 double reversal');
      expect([a, b].map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
      const loser = (a.status === 'rejected' ? a.reason : (b as PromiseRejectedResult).reason) as AppError;
      expect(loser).toBeInstanceOf(AppError);
      expect(loser).toMatchObject({ status: 409, code: 'CASH_MOVEMENT_ALREADY_REVERSED' });
      expect(loser.details).toBeUndefined();
      const durable = await db.cashMovement.findMany({ where: { reversesMovementId: original.movement.id } });
      expect(durable).toHaveLength(1);
      expect(await auditCount(durable[0]!.id)).toBe(1);
    } finally {
      await coordinator.release();
    }
  });

  // --- PG-CR-14/15 close vs reversal, both execution orders ------------------------

  async function orderedRace(w: World, first: () => Promise<unknown>, second: () => Promise<unknown>) {
    const coordinator = await holdRowLock(pools[0]!, 'CashSession', w.sessionId);
    try {
      const firstCall = first();
      await waitForBlocked(pools[0]!, coordinator.pid, 1, /FOR UPDATE/);
      const secondCall = second();
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      return await withTimeout(Promise.allSettled([firstCall, secondCall]), RACE_TIMEOUT_MS, 'ordered race');
    } finally {
      await coordinator.release();
    }
  }

  it('PG-CR-14 reversal queued BEFORE the close: the close reconciles WITH the reversal (expected cash restored, difference 0)', async () => {
    const w = await makeWorld(1000n);
    const original = await withdraw(w, 300n);
    const [reversal, close] = await orderedRace(
      w,
      () => svc(racerA).reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'x', idempotencyKey: randomUUID() }),
      () => svc(racerB).closeSession(w.sessionId, w.cashierCtx, 1000n),
    );
    expect(reversal.status, reversal.status === 'rejected' ? String(reversal.reason) : '').toBe('fulfilled');
    expect(close.status, close.status === 'rejected' ? String(close.reason) : '').toBe('fulfilled');
    const session = await db.cashSession.findUniqueOrThrow({ where: { id: w.sessionId } });
    expect(session).toMatchObject({ status: 'CLOSED', expectedCash: 1000n, countedCash: 1000n, difference: 0n });
    expect(await db.cashMovement.count({ where: { reversesMovementId: original.movement.id } })).toBe(1);
  });

  it('PG-CR-15 close queued BEFORE the reversal: the reversal is 409 CASH_SESSION_ALREADY_CLOSED and the closed arqueo is untouched', async () => {
    const w = await makeWorld(1000n);
    const original = await withdraw(w, 300n);
    const [close, reversal] = await orderedRace(
      w,
      () => svc(racerB).closeSession(w.sessionId, w.cashierCtx, 700n),
      () => svc(racerA).reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'x', idempotencyKey: randomUUID() }),
    );
    expect(close.status, close.status === 'rejected' ? String(close.reason) : '').toBe('fulfilled');
    expect(reversal.status).toBe('rejected');
    expect((reversal as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'CASH_SESSION_ALREADY_CLOSED' });
    const session = await db.cashSession.findUniqueOrThrow({ where: { id: w.sessionId } });
    expect(session).toMatchObject({ status: 'CLOSED', expectedCash: 700n, countedCash: 700n, difference: 0n });
    expect(await db.cashMovement.count({ where: { reversesMovementId: original.movement.id } })).toBe(0);
  });

  // --- PG-CR-16..20 atomicity and reconciliation ----------------------------------

  it('PG-CR-16 an injected audit failure leaves NO durable reversal (full rollback); the same key then succeeds fresh', async () => {
    const w = await makeWorld(1000n);
    const original = await expense(w, 100n);
    const key = randomUUID();
    await pools[0]!.query(
      `CREATE OR REPLACE FUNCTION public.mona_cr_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $fn$
         BEGIN RAISE EXCEPTION 'CR injected audit failure'; END $fn$`,
    );
    await pools[0]!.query(
      `CREATE TRIGGER mona_cr_audit_fail BEFORE INSERT ON public."AuditLog"
         FOR EACH ROW WHEN (NEW."action" = 'CASH_EXPENSE_REVERSED')
         EXECUTE FUNCTION public.mona_cr_audit_fail()`,
    );
    try {
      await expect(svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'x', idempotencyKey: key })).rejects.toThrow();
      expect(await db.cashMovement.count({ where: { reversesMovementId: original.movement.id } })).toBe(0);
      expect(await db.auditLog.count({ where: { action: 'CASH_EXPENSE_REVERSED', branchId: w.branchId } })).toBe(0);
    } finally {
      await pools[0]!.query('DROP TRIGGER IF EXISTS mona_cr_audit_fail ON public."AuditLog"');
      await pools[0]!.query('DROP FUNCTION IF EXISTS public.mona_cr_audit_fail()');
    }
    const retry = await svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'x', idempotencyKey: key });
    expect(retry.replayed).toBe(false);
    expect(await db.cashMovement.count({ where: { reversesMovementId: original.movement.id } })).toBe(1);
  });

  it('PG-CR-17 real reconciliation: startingCash + CASH SALE_INCOME − WITHDRAWAL − EXPENSE + their reversals = expectedCash exactly', async () => {
    const w = await makeWorld(1000n);
    const variant = await db.productVariant.findFirstOrThrow({ select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } });
    await db.inventory.create({ data: { variantId: variant.id, branchId: w.branchId, physical: 1n, reserved: 1n } });
    const sale = await db.sale.create({ data: {
      branchId: w.branchId, sellerId: w.cashier, status: 'PENDING_PAYMENT', priceMode: 'CASH', pricingMode: 'LIST', subtotal: 2500n, discountTotal: 0n, total: 2500n,
    } });
    await db.saleItem.create({ data: {
      saleId: sale.id, variantId: variant.id, productId: variant.productId, productName: `CR ${w.tag}`, variantName: 'CR', sku: variant.sku,
      quantity: 1n, unitPrice: 2500n, subtotal: 2500n,
    } });
    await db.stockReservation.create({ data: {
      saleId: sale.id, variantId: variant.id, branchId: w.branchId, quantity: 1n, expiresAt: new Date(Date.now() + 3_600_000), status: 'ACTIVE',
    } });
    const paid = await createPaymentsService(db).registerPayment(
      { auth: w.cashierCtx } as unknown as Request, w.cashier, sale.id,
      { method: 'CASH', amount: 2500n, receivedAmount: 2500n, idempotencyKey: randomUUID() },
    );
    expect(paid).toMatchObject({ replayed: false, resultingStatus: 'PAID' });
    const wrongWithdrawal = await withdraw(w, 900n);
    await withdraw(w, 300n, 'retiro correcto');
    const wrongExpense = await expense(w, 200n);
    await expense(w, 50n, 'gasto correcto');
    await svc().reverseMovement(w.sessionId, wrongWithdrawal.movement.id, w.ownerCtx, { reason: 'importe equivocado', idempotencyKey: randomUUID() });
    await svc().reverseMovement(w.sessionId, wrongExpense.movement.id, w.adminCtx, { reason: 'duplicado', idempotencyKey: randomUUID() });
    // 1000 + 2500 − (900 + 300) − (200 + 50) + 900 + 200 = 3150
    const closed = await svc().closeSession(w.sessionId, w.cashierCtx, 3150n);
    expect(closed).toMatchObject({ status: 'CLOSED', expectedCash: 3150n, difference: 0n });
  });

  it('PG-CR-18 MANUAL stays fail-closed with a reversal present: the close refuses 409 with no CLOSING write', async () => {
    const w = await makeWorld(1000n);
    const original = await expense(w, 100n);
    await svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'x', idempotencyKey: randomUUID() });
    await db.cashMovement.create({ data: { sessionId: w.sessionId, type: 'MANUAL', amount: 5n, salePaymentId: null, userId: w.cashier } });
    expect(await appErrorOf(svc().closeSession(w.sessionId, w.cashierCtx, 1000n))).toMatchObject({ status: 409, code: 'CASH_RECONCILIATION_INCONSISTENT' });
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, type: 'CLOSING' } })).toBe(0);
  });

  it('PG-CR-19 the runtime guards what the database does not: a raw same-session reversal with a wrong amount makes the close and new reversals fail closed', async () => {
    const w = await makeWorld(1000n);
    const original = await withdraw(w, 300n);
    const other = await expense(w, 100n);
    // Same session, valid shape: the database accepts it (no cross-row trigger for PILOT).
    expect(await insertRow({ sessionId: w.sessionId, type: 'WITHDRAWAL_REVERSAL', amount: 299, userId: w.owner, reason: 'raw', key: randomUUID(), link: original.movement.id })).toBeNull();
    expect(await appErrorOf(svc().closeSession(w.sessionId, w.cashierCtx, 999n))).toMatchObject({ status: 409, code: 'CASH_RECONCILIATION_INCONSISTENT' });
    expect(await appErrorOf(svc().reverseMovement(w.sessionId, other.movement.id, w.ownerCtx, { reason: 'x', idempotencyKey: randomUUID() })))
      .toMatchObject({ status: 409, code: 'CASH_RECONCILIATION_INCONSISTENT' });
  });

  it('PG-CR-20 an OPENING and a reversal itself are not reversible (409 CASH_MOVEMENT_NOT_REVERSIBLE), nothing written', async () => {
    const w = await makeWorld(1000n);
    const opening = await db.cashMovement.findFirstOrThrow({ where: { sessionId: w.sessionId, type: 'OPENING' } });
    expect(await appErrorOf(svc().reverseMovement(w.sessionId, opening.id, w.ownerCtx, { reason: 'x', idempotencyKey: randomUUID() })))
      .toMatchObject({ status: 409, code: 'CASH_MOVEMENT_NOT_REVERSIBLE' });
    const original = await expense(w, 100n);
    const reversal = await svc().reverseMovement(w.sessionId, original.movement.id, w.ownerCtx, { reason: 'x', idempotencyKey: randomUUID() });
    expect(await appErrorOf(svc().reverseMovement(w.sessionId, reversal.movement.id, w.ownerCtx, { reason: 'x', idempotencyKey: randomUUID() })))
      .toMatchObject({ status: 409, code: 'CASH_MOVEMENT_NOT_REVERSIBLE' });
    expect(await db.cashMovement.count({ where: { sessionId: w.sessionId, type: { in: ['WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL'] } } })).toBe(1);
  });
});
