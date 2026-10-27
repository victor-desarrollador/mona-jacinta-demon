// WAREHOUSE-MVP — OPT-IN SERVICE-LEVEL PostgreSQL gate for the manual stock
// adjustment (migration 20261021130000_warehouse_stock_adjustment). OPT-IN ONLY:
// without MONA_WAREHOUSE_PG=1 the whole suite is skipped, it is never part of the
// DB-free tier (safe-nodb-run refuses any file that loads a DB driver), and it
// never reads DATABASE_URL / DEV / PILOT / hosted TEST configuration.
//
// What only a real PostgreSQL proves here: the migration's live DDL (enum labels,
// columns, the (userId, idempotencyKey) unique index and the three CHECKs actually
// enforcing on INSERT), the real FOR UPDATE row lock (a coordinator holds the row,
// pg_stat_activity + pg_blocking_pids PROVE the service backends wait on it), two
// concurrent adjustments of one Inventory, the same idempotency key racing, the
// first-Inventory-row race (a table lock holds both inserts until they overlap),
// atomic rollback under a failing AuditLog insert, the physical >= reserved
// invariant, REAL driver errors (23505 -> P2002, 40001) fed to the retry
// classifier, and the real reservation service and real sale completion racing an
// adjustment on the same Inventory row.
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with the
// repository migrations applied (the last one included), bound by marker + system id:
//   MONA_WAREHOUSE_PG=1 MONA_WAREHOUSE_PG_DISPOSABLE=1
//   MONA_TEST_DATABASE_TARGET=local LOCAL_TEST_DATABASE_URL=…
//   LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_WAREHOUSE_PG_SYSTEM_ID=<pg_control_system().system_identifier>
// Fixtures are COMMITTED and PERMANENT by design (unique tags; nothing
// baseline-owned is mutated), hence the explicit DISPOSABLE acknowledgement: the
// cluster is discarded afterwards, never reused. The audit-failure case installs a
// temporary trigger on "AuditLog" scoped to its own user and always drops it.
//
// Concurrency assertions are on DURABLE invariants (exact movements, audits and
// balances the contract allows), never on an incidental interleaving.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { createInventoryAdjustmentService, isRetryable } from '../../src/modules/inventory/inventory-adjustment.service.js';
import { createReservationService } from '../../src/modules/sales/reservation.service.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
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

const enabled = process.env.MONA_WAREHOUSE_PG === '1';

type Role = 'WAREHOUSE' | 'CASHIER' | 'SELLER';
function ctxOf(userId: string, role: Role, branchId: string): Express.AuthContext {
  return {
    userId, roles: [role], effectiveLocationIds: [branchId],
    assignments: [{ roleId: role, roleCode: role, scopeKind: 'LOCATION', locationId: branchId, permissions: [...DEFAULT_ROLE_GRANTS[role]] }],
  } as unknown as Express.AuthContext;
}

const byBigint = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

type World = { tag: string; branchId: string; variantId: string; userA: string; userB: string; ctxA: Express.AuthContext; ctxB: Express.AuthContext };

describe.skipIf(!enabled)('WAREHOUSE-MVP manual stock adjustment on PostgreSQL (disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;
  let racerA: PrismaClient;
  let racerB: PrismaClient;
  let companyId: string;
  let categoryId: string;
  let brandId: string;

  beforeAll(async () => {
    if (process.env.MONA_WAREHOUSE_PG_DISPOSABLE !== '1') {
      throw new Error('the Warehouse PG suite writes permanent rows: MONA_WAREHOUSE_PG_DISPOSABLE=1 is required');
    }
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_WAREHOUSE_PG_SYSTEM_ID;
    if (!expectedSystemId || !PG_SYSTEM_ID.test(expectedSystemId)) {
      throw new Error('isolated cluster binding is missing: MONA_WAREHOUSE_PG_SYSTEM_ID must be the decimal pg_control_system().system_identifier of the target');
    }
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    // pools[0]: coordinator + fixtures + observer; pools[1]/pools[2]: racers.
    for (const max of [8, 3, 3]) {
      const { pool } = await openProvenLocalTestPool(max, process.env);
      pools.push(pool);
      clients.push(new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] }));
    }
    [db, racerA, racerB] = clients as [PrismaClient, PrismaClient, PrismaClient];
    const { rows } = await pools[0]!.query<{ system_id: string; migrated: boolean }>(
      `SELECT system_identifier::text AS system_id,
              to_regclass('public."StockMovement_userId_idempotencyKey_key"') IS NOT NULL AS migrated
         FROM pg_control_system()`,
    );
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    if (rows[0]?.migrated !== true) throw new Error('the warehouse stock adjustment migration is required');

    const suite = randomUUID().slice(0, 8);
    const company = await db.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } })
      ?? await db.company.create({ data: { name: `WH ${suite}`, cuit: `wh-${suite}`, address: 'Test' } });
    companyId = company.id;
    categoryId = (await db.category.create({ data: { name: `WH ${suite}` } })).id;
    brandId = (await db.brand.create({ data: { name: `WH ${suite}` } })).id;
  });

  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    for (const pool of pools) await pool.end();
  });

  // --- fixtures ---------------------------------------------------------------

  async function makeVariant(tag: string, suffix = 'v'): Promise<string> {
    const product = await db.product.create({ data: { name: `WH ${tag} ${suffix}`, slug: `wh-${tag}-${suffix}`, categoryId, brandId } });
    const variant = await db.productVariant.create({ data: {
      productId: product.id, sku: `WH-${tag}-${suffix}`, barcode: `wh-${tag}-${suffix}`, price: 1000n, costPrice: 500n,
    } });
    return variant.id;
  }

  async function makeWorld(): Promise<World> {
    const tag = randomUUID().slice(0, 8);
    const branchId = randomUUID();
    await db.location.create({ data: {
      id: branchId, companyId, code: `wh-${tag}`, name: `WH ${tag}`, type: 'RETAIL_BRANCH', address: 'Test',
      pointOfSaleNumber: pointOfSaleNumberFor('WH', tag),
    } });
    await db.branch.create({ data: { id: branchId, code: `wh-${tag}`, name: `WH ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    await db.saleNumberCounter.create({ data: { branchId } });
    const [userA, userB] = [randomUUID(), randomUUID()];
    for (const [name, id] of [['a', userA], ['b', userB]] as const) {
      await db.user.create({ data: { id, name: `WH ${tag} ${name}`, email: `wh-${tag}-${name}@test.invalid`, passwordHash: 'not-used' } });
    }
    return {
      tag, branchId, variantId: await makeVariant(tag), userA, userB,
      ctxA: ctxOf(userA, 'WAREHOUSE', branchId), ctxB: ctxOf(userB, 'WAREHOUSE', branchId),
    };
  }

  const seedInventory = (w: World, physical: bigint, reserved: bigint, variantId = w.variantId) =>
    db.inventory.create({ data: { variantId, branchId: w.branchId, physical, reserved } });
  const inventoryOf = (w: World, variantId = w.variantId) =>
    db.inventory.findUnique({ where: { variantId_branchId: { variantId, branchId: w.branchId } } });
  const adjustmentsOf = (w: World) => db.stockMovement.findMany({ where: { branchId: w.branchId, type: 'ADJUSTMENT' } });
  const auditsOf = (w: World) => db.auditLog.findMany({ where: { branchId: w.branchId, action: 'INVENTORY_MANUAL_ADJUSTMENT' } });

  const input = (w: World, overrides: Record<string, unknown> = {}) => ({
    variantId: w.variantId, branchId: w.branchId, delta: -1n, reason: 'LOST' as const, note: undefined as string | undefined,
    idempotencyKey: `wh-${randomUUID()}`, ...overrides,
  });

  async function appErrorOf(promise: Promise<unknown>): Promise<AppError | null> {
    try {
      await promise;
      return null;
    } catch (error) {
      if (error instanceof AppError) return error;
      throw error;
    }
  }

  // A raw INSERT of a StockMovement that EXPECTS a PostgreSQL refusal; returns the
  // SQLSTATE and constraint, or null when the statement unexpectedly succeeded.
  async function rawMovement(w: World, inventoryId: string, v: {
    type?: string; delta: number | string; reason: string | null; note?: string | null; key: string | null; userId?: string;
  }): Promise<{ code: string | null; constraint: string | null } | null> {
    try {
      await pools[0]!.query(
        `INSERT INTO "StockMovement" (id, "inventoryId", type, "quantityDelta", "saleId", "userId", "branchId", reason, note, "idempotencyKey")
         VALUES ($1, $2, $3::"StockMovementType", $4, NULL, $5, $6, $7::"StockAdjustmentReason", $8, $9)`,
        [randomUUID(), inventoryId, v.type ?? 'ADJUSTMENT', v.delta, v.userId ?? w.userA, w.branchId, v.reason, v.note ?? null, v.key],
      );
      return null;
    } catch (error) {
      const candidate = error as { code?: unknown; constraint?: unknown };
      return {
        code: typeof candidate.code === 'string' ? candidate.code : null,
        constraint: typeof candidate.constraint === 'string' ? candidate.constraint : null,
      };
    }
  }

  // --- PG-WH-01..03 migration, CHECKs, unique index ------------------------------

  it('PG-WH-01 the migration is live: enum labels, columns, unique index and validated CHECKs', async () => {
    const labels = async (type: string) => (await pools[0]!.query<{ label: string }>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = $1 ORDER BY e.enumsortorder`, [type],
    )).rows.map((row) => row.label);
    expect(await labels('StockMovementType')).toEqual(['SALE', 'INITIAL_STOCK', 'ADJUSTMENT']);
    expect(await labels('StockAdjustmentReason')).toEqual(['DAMAGED', 'LOST', 'LOAD_ERROR', 'SURPLUS', 'OTHER']);

    const columns = await pools[0]!.query<{ attname: string; data_type: string; attnotnull: boolean }>(
      `SELECT attname, format_type(atttypid, atttypmod) AS data_type, attnotnull FROM pg_attribute
        WHERE attrelid = 'public."StockMovement"'::regclass AND attname IN ('reason', 'note', 'idempotencyKey') AND NOT attisdropped
        ORDER BY attname`,
    );
    expect(columns.rows).toEqual([
      { attname: 'idempotencyKey', data_type: 'text', attnotnull: false },
      { attname: 'note', data_type: 'text', attnotnull: false },
      { attname: 'reason', data_type: '"StockAdjustmentReason"', attnotnull: false },
    ]);

    const index = await pools[0]!.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'StockMovement_userId_idempotencyKey_key'`,
    );
    expect(index.rows[0]?.indexdef).toBe('CREATE UNIQUE INDEX "StockMovement_userId_idempotencyKey_key" ON public."StockMovement" USING btree ("userId", "idempotencyKey")');

    const checks = await pools[0]!.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'public."StockMovement"'::regclass AND contype = 'c' AND conname LIKE 'chk_stock_movement_%' ORDER BY conname`,
    );
    expect(checks.rows).toEqual([
      { conname: 'chk_stock_movement_adjustment_reason_rules', convalidated: true },
      { conname: 'chk_stock_movement_adjustment_shape', convalidated: true },
      { conname: 'chk_stock_movement_reason_only_adjustment', convalidated: true },
    ]);
  });

  it('PG-WH-02 the CHECKs enforce on INSERT (and accept every legal shape)', async () => {
    const w = await makeWorld();
    const inv = await seedInventory(w, 50n, 0n);
    const shape = 'chk_stock_movement_adjustment_shape';
    const rules = 'chk_stock_movement_adjustment_reason_rules';
    const k = () => `chk-${randomUUID()}`;

    const refused: Array<[string, Parameters<typeof rawMovement>[2], string]> = [
      ['no reason', { delta: -1, reason: null, key: k() }, shape],
      ['no idempotency key', { delta: -1, reason: 'LOST', key: null }, shape],
      ['blank idempotency key', { delta: -1, reason: 'LOST', key: '   ' }, shape],
      ['zero delta', { delta: 0, reason: 'LOAD_ERROR', key: k() }, shape],
      ['delta +101', { delta: 101, reason: 'LOAD_ERROR', key: k() }, shape],
      ['delta -101', { delta: -101, reason: 'LOAD_ERROR', key: k() }, shape],
      ['DAMAGED positive', { delta: 1, reason: 'DAMAGED', key: k() }, rules],
      ['LOST positive', { delta: 1, reason: 'LOST', key: k() }, rules],
      ['SURPLUS negative', { delta: -1, reason: 'SURPLUS', key: k() }, rules],
      ['OTHER without note', { delta: 1, reason: 'OTHER', key: k() }, rules],
      ['OTHER with a 9-char note', { delta: 1, reason: 'OTHER', note: '123456789', key: k() }, rules],
      ['OTHER with a blank-padded note', { delta: 1, reason: 'OTHER', note: '   short   ', key: k() }, rules],
      ['a reason on a SALE movement', { type: 'SALE', delta: -1, reason: 'LOST', key: null }, 'chk_stock_movement_reason_only_adjustment'],
    ];
    for (const [name, values, constraint] of refused) {
      expect(await rawMovement(w, inv.id, values), name).toEqual({ code: '23514', constraint });
    }
    const accepted: Array<[string, Parameters<typeof rawMovement>[2]]> = [
      ['LOAD_ERROR +100', { delta: 100, reason: 'LOAD_ERROR', key: k() }],
      ['LOAD_ERROR -100', { delta: -100, reason: 'LOAD_ERROR', key: k() }],
      ['DAMAGED -1', { delta: -1, reason: 'DAMAGED', key: k() }],
      ['LOST -1', { delta: -1, reason: 'LOST', key: k() }],
      ['SURPLUS +1', { delta: 1, reason: 'SURPLUS', key: k() }],
      ['OTHER +1 with a 10-char note', { delta: 1, reason: 'OTHER', note: '0123456789', key: k() }],
      ['historical SALE without reason or key', { type: 'SALE', delta: -1, reason: null, key: null }],
    ];
    for (const [name, values] of accepted) expect(await rawMovement(w, inv.id, values), name).toBeNull();
  });

  it('PG-WH-03 (userId, idempotencyKey) is unique; NULL keys never conflict; other users may reuse a key', async () => {
    const w = await makeWorld();
    const inv = await seedInventory(w, 50n, 0n);
    const key = `uniq-${randomUUID()}`;
    expect(await rawMovement(w, inv.id, { delta: -1, reason: 'LOST', key })).toBeNull();
    expect(await rawMovement(w, inv.id, { delta: -1, reason: 'LOST', key })).toEqual({ code: '23505', constraint: 'StockMovement_userId_idempotencyKey_key' });
    expect(await rawMovement(w, inv.id, { delta: -1, reason: 'LOST', key, userId: w.userB })).toBeNull();
    expect(await rawMovement(w, inv.id, { type: 'SALE', delta: -1, reason: null, key: null })).toBeNull();
    expect(await rawMovement(w, inv.id, { type: 'SALE', delta: -1, reason: null, key: null })).toBeNull();
  });

  // --- PG-WH-04..07 service semantics on a real engine ---------------------------

  it('PG-WH-04 a positive and a negative adjustment move physical only, with one movement and one audit each', async () => {
    const w = await makeWorld();
    await seedInventory(w, 10n, 4n);
    const svc = createInventoryAdjustmentService(db);
    const up = await svc.adjustStock(w.ctxA, input(w, { delta: 5n, reason: 'SURPLUS' }));
    expect(up).toMatchObject({ replayed: false, inventory: { physical: 15n, reserved: 4n, available: 11n } });
    const down = await svc.adjustStock(w.ctxA, input(w, { delta: -6n, reason: 'OTHER', note: '  conteo físico distinto  ' }));
    expect(down.inventory).toMatchObject({ physical: 9n, reserved: 4n });
    expect(await inventoryOf(w)).toMatchObject({ physical: 9n, reserved: 4n });
    const movements = await adjustmentsOf(w);
    expect(movements.map((m) => m.quantityDelta).sort(byBigint)).toEqual([-6n, 5n]);
    expect(movements.every((m) => m.userId === w.userA && m.saleId === null && m.branchId === w.branchId)).toBe(true);
    expect(movements.find((m) => m.reason === 'OTHER')?.note).toBe('conteo físico distinto');
    const audits = await auditsOf(w);
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.userId === w.userA && a.entityType === 'Inventory')).toBe(true);
  });

  it('PG-WH-05 a positive adjustment creates the missing Inventory row at 0/0; a negative one never does', async () => {
    const w = await makeWorld();
    const svc = createInventoryAdjustmentService(db);
    expect((await appErrorOf(svc.adjustStock(w.ctxA, input(w, { delta: -1n }))))?.code).toBe('NEGATIVE_STOCK');
    expect(await inventoryOf(w)).toBeNull();
    await svc.adjustStock(w.ctxA, input(w, { delta: 4n, reason: 'SURPLUS' }));
    expect(await inventoryOf(w)).toMatchObject({ physical: 4n, reserved: 0n });
  });

  it('PG-WH-06 physical=1, reserved=1, delta=-1 is refused and nothing changes (reserved intact)', async () => {
    const w = await makeWorld();
    await seedInventory(w, 1n, 1n);
    const error = await appErrorOf(createInventoryAdjustmentService(db).adjustStock(w.ctxA, input(w, { delta: -1n })));
    expect(error).toMatchObject({ status: 409, code: 'STOCK_BELOW_RESERVED' });
    expect(await inventoryOf(w)).toMatchObject({ physical: 1n, reserved: 1n });
    expect(await adjustmentsOf(w)).toHaveLength(0);
    expect(await auditsOf(w)).toHaveLength(0);
  });

  it('PG-WH-07 the boundary physical == reserved is allowed; one below is not', async () => {
    const w = await makeWorld();
    await seedInventory(w, 5n, 3n);
    const svc = createInventoryAdjustmentService(db);
    expect((await appErrorOf(svc.adjustStock(w.ctxA, input(w, { delta: -3n }))))?.code).toBe('STOCK_BELOW_RESERVED');
    await svc.adjustStock(w.ctxA, input(w, { delta: -2n }));
    expect(await inventoryOf(w)).toMatchObject({ physical: 3n, reserved: 3n });
    expect((await appErrorOf(svc.adjustStock(w.ctxA, input(w, { delta: -1n }))))?.code).toBe('STOCK_BELOW_RESERVED');
  });

  // --- PG-WH-08..11 real locks and races ----------------------------------------

  it('PG-WH-08 FOR UPDATE is real: the service waits on a row held by another backend and then applies on top of its change', async () => {
    const w = await makeWorld();
    const inv = await seedInventory(w, 10n, 0n);
    const coordinator = await holdRowLock(pools[0]!, 'Inventory', inv.id);
    let released = false;
    try {
      const call = createInventoryAdjustmentService(racerA).adjustStock(w.ctxA, input(w, { delta: -3n }));
      const waiting = await waitForBlocked(pools[0]!, coordinator.pid, 1, /FOR UPDATE/);
      expect(waiting).toHaveLength(1);
      // The holder commits a competing change; the service must read AFTER taking the lock.
      await coordinator.commit(async (client) => { await client.query('UPDATE "Inventory" SET physical = 20 WHERE id = $1', [inv.id]); });
      released = true;
      const result = await withTimeout(call, RACE_TIMEOUT_MS, 'locked adjustment');
      expect(result.inventory.physical).toBe(17n);
    } finally {
      if (!released) await coordinator.release();
    }
    expect(await inventoryOf(w)).toMatchObject({ physical: 17n, reserved: 0n });
  });

  it('PG-WH-09 two concurrent adjustments of the same Inventory serialize: no lost update, no negative stock', async () => {
    const w = await makeWorld();
    const inv = await seedInventory(w, 5n, 0n);
    const coordinator = await holdRowLock(pools[0]!, 'Inventory', inv.id);
    let results: PromiseSettledResult<unknown>[];
    try {
      const a = createInventoryAdjustmentService(racerA).adjustStock(w.ctxA, input(w, { delta: -3n }));
      const b = createInventoryAdjustmentService(racerB).adjustStock(w.ctxB, input(w, { delta: -3n }));
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'race');
    } finally {
      await coordinator.release();
    }
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'NEGATIVE_STOCK' });
    expect(await inventoryOf(w)).toMatchObject({ physical: 2n, reserved: 0n });
    expect(await adjustmentsOf(w)).toHaveLength(1);
    expect(await auditsOf(w)).toHaveLength(1);
  });

  it('PG-WH-10 two concurrent compatible adjustments both apply exactly once', async () => {
    const w = await makeWorld();
    const inv = await seedInventory(w, 10n, 0n);
    const coordinator = await holdRowLock(pools[0]!, 'Inventory', inv.id);
    let results: PromiseSettledResult<unknown>[];
    try {
      const a = createInventoryAdjustmentService(racerA).adjustStock(w.ctxA, input(w, { delta: -3n }));
      const b = createInventoryAdjustmentService(racerB).adjustStock(w.ctxB, input(w, { delta: -2n }));
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'race');
    } finally {
      await coordinator.release();
    }
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await inventoryOf(w)).toMatchObject({ physical: 5n, reserved: 0n });
    expect((await adjustmentsOf(w)).map((m) => m.quantityDelta).sort(byBigint)).toEqual([-3n, -2n]);
    expect(await auditsOf(w)).toHaveLength(2);
  });

  it('PG-WH-11 the same idempotency key racing from two connections mutates stock once (the other is a replay)', async () => {
    const w = await makeWorld();
    const inv = await seedInventory(w, 10n, 0n);
    const body = input(w, { delta: -2n, idempotencyKey: `race-${randomUUID()}` });
    const coordinator = await holdRowLock(pools[0]!, 'Inventory', inv.id);
    let results: PromiseSettledResult<{ replayed: boolean }>[];
    try {
      const a = createInventoryAdjustmentService(racerA).adjustStock(w.ctxA, body);
      const b = createInventoryAdjustmentService(racerB).adjustStock(w.ctxA, body);
      // Both passed the (empty) replay lookup and now wait on the row lock.
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'same-key race');
    } finally {
      await coordinator.release();
    }
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const replays = results.map((r) => (r as PromiseFulfilledResult<{ replayed: boolean }>).value.replayed);
    expect(replays.filter(Boolean)).toHaveLength(1);
    expect(await inventoryOf(w)).toMatchObject({ physical: 8n, reserved: 0n });
    expect(await adjustmentsOf(w)).toHaveLength(1);
    expect(await auditsOf(w)).toHaveLength(1);
  });

  it('PG-WH-12 the same key with a different payload is refused 409 and stock does not move', async () => {
    const w = await makeWorld();
    await seedInventory(w, 10n, 0n);
    const svc = createInventoryAdjustmentService(db);
    const key = `payload-${randomUUID()}`;
    await svc.adjustStock(w.ctxA, input(w, { delta: -2n, idempotencyKey: key }));
    const error = await appErrorOf(svc.adjustStock(w.ctxA, input(w, { delta: -3n, idempotencyKey: key })));
    expect(error).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    expect(await inventoryOf(w)).toMatchObject({ physical: 8n });
    expect(await adjustmentsOf(w)).toHaveLength(1);
  });

  it('PG-WH-13 the first Inventory row of a (variant, branch) raced by two adjustments yields ONE row and both deltas', async () => {
    const w = await makeWorld();
    // A table lock that conflicts with INSERT holds both services at the upsert until they genuinely overlap.
    const holder = await pools[0]!.connect();
    let locked = false;
    let results: PromiseSettledResult<unknown>[];
    try {
      await holder.query('BEGIN');
      await holder.query('LOCK TABLE "Inventory" IN SHARE ROW EXCLUSIVE MODE');
      locked = true;
      const { rows } = await holder.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const a = createInventoryAdjustmentService(racerA).adjustStock(w.ctxA, input(w, { delta: 3n, reason: 'SURPLUS' }));
      const b = createInventoryAdjustmentService(racerB).adjustStock(w.ctxB, input(w, { delta: 4n, reason: 'SURPLUS' }));
      const blocked = await waitForBlocked(pools[0]!, rows[0]!.pid, 2, /Inventory/);
      expect(blocked).toHaveLength(2);
      await holder.query('ROLLBACK');
      locked = false;
      results = await withTimeout(Promise.allSettled([a, b]), RACE_TIMEOUT_MS, 'first-insert race');
    } finally {
      if (locked) await holder.query('ROLLBACK');
      holder.release();
    }
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    const rows = await db.inventory.findMany({ where: { variantId: w.variantId, branchId: w.branchId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ physical: 7n, reserved: 0n });
    expect(await adjustmentsOf(w)).toHaveLength(2);
    expect(await auditsOf(w)).toHaveLength(2);
  });

  // --- PG-WH-14 REAL driver errors through the retry classifier -----------------

  it('PG-WH-14 REAL driver errors: Inventory / idempotency P2002 retry; a foreign P2002 does not; a real 40001 retries', async () => {
    const w = await makeWorld();
    const inv = await seedInventory(w, 10n, 0n);
    const key = `p2002-${randomUUID()}`;
    await db.stockMovement.create({ data: {
      inventoryId: inv.id, type: 'ADJUSTMENT', quantityDelta: -1n, userId: w.userA, branchId: w.branchId, reason: 'LOST', idempotencyKey: key,
    } });
    const capture = async (promise: Promise<unknown>) => {
      try { await promise; } catch (error) { return error; }
      throw new Error('the statement unexpectedly succeeded');
    };

    const inventoryDuplicate = await capture(db.inventory.create({ data: { variantId: w.variantId, branchId: w.branchId, physical: 0n, reserved: 0n } }));
    expect(isRetryable(inventoryDuplicate)).toBe(true);
    const idempotencyDuplicate = await capture(db.stockMovement.create({ data: {
      inventoryId: inv.id, type: 'ADJUSTMENT', quantityDelta: -1n, userId: w.userA, branchId: w.branchId, reason: 'LOST', idempotencyKey: key,
    } }));
    expect(isRetryable(idempotencyDuplicate)).toBe(true);
    const foreignDuplicate = await capture(db.productVariant.create({ data: {
      productId: (await db.productVariant.findUniqueOrThrow({ where: { id: w.variantId } })).productId,
      sku: `WH-${w.tag}-v`, barcode: `other-${randomUUID()}`, price: 1n, costPrice: 1n,
    } }));
    expect((foreignDuplicate as { code?: string }).code).toBe('P2002');
    expect(isRetryable(foreignDuplicate)).toBe(false);
    const foreignLocation = await capture(db.location.create({ data: {
      companyId, code: `wh-${w.tag}`, name: 'dup', type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: pointOfSaleNumberFor('WH', randomUUID().slice(0, 8)),
    } }));
    expect(isRetryable(foreignLocation)).toBe(false);

    // A genuine serialization failure between two Serializable transactions.
    let readA!: () => void;
    let readB!: () => void;
    const aRead = new Promise<void>((resolve) => { readA = resolve; });
    const bRead = new Promise<void>((resolve) => { readB = resolve; });
    const txA = racerA.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT physical FROM "Inventory" WHERE id = ${inv.id}`;
      readA();
      await bRead;
      await tx.inventory.update({ where: { id: inv.id }, data: { physical: 11n } });
    }, { isolationLevel: 'Serializable' });
    const txB = racerB.$transaction(async (tx) => {
      await aRead;
      await tx.$queryRaw`SELECT physical FROM "Inventory" WHERE id = ${inv.id}`;
      readB();
      await tx.inventory.update({ where: { id: inv.id }, data: { physical: 12n } });
    }, { isolationLevel: 'Serializable' });
    const [settledA, settledB] = await withTimeout(Promise.allSettled([txA, txB]), RACE_TIMEOUT_MS, 'serialization conflict');
    const failure = [settledA, settledB].find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    expect(failure, 'one Serializable transaction must lose').toBeDefined();
    expect(isRetryable(failure!.reason)).toBe(true);
  });

  // --- PG-WH-15 atomicity ---------------------------------------------------------

  it('PG-WH-15 an AuditLog failure rolls back the whole adjustment (balance, movement and a freshly created Inventory row)', async () => {
    const w = await makeWorld();
    const existingVariant = w.variantId;
    await seedInventory(w, 10n, 2n);
    const freshVariant = await makeVariant(w.tag, 'fresh');
    const user = w.userA;
    expect(user).toMatch(/^[0-9a-f-]{36}$/);
    await pools[0]!.query(`CREATE OR REPLACE FUNCTION public.mona_wh_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $fn$
      BEGIN RAISE EXCEPTION 'intentional audit failure' USING ERRCODE = 'P0001'; END $fn$`);
    await pools[0]!.query(`CREATE TRIGGER mona_wh_audit_fail BEFORE INSERT ON public."AuditLog"
      FOR EACH ROW WHEN (NEW."userId" = '${user}') EXECUTE FUNCTION public.mona_wh_audit_fail()`);
    try {
      const svc = createInventoryAdjustmentService(db);
      await expect(svc.adjustStock(w.ctxA, input(w, { variantId: existingVariant, delta: -3n }))).rejects.toThrow(/intentional audit failure/);
      await expect(svc.adjustStock(w.ctxA, input(w, { variantId: freshVariant, delta: 5n, reason: 'SURPLUS' }))).rejects.toThrow(/intentional audit failure/);
    } finally {
      await pools[0]!.query('DROP TRIGGER IF EXISTS mona_wh_audit_fail ON public."AuditLog"');
      await pools[0]!.query('DROP FUNCTION IF EXISTS public.mona_wh_audit_fail()');
    }
    expect(await inventoryOf(w, existingVariant)).toMatchObject({ physical: 10n, reserved: 2n });
    expect(await inventoryOf(w, freshVariant)).toBeNull();
    expect(await adjustmentsOf(w)).toHaveLength(0);
    expect(await auditsOf(w)).toHaveLength(0);
  });

  // --- PG-WH-16..17 races with the REAL reservation and completion services -------

  async function draftSale(w: World, quantity: bigint, status: 'DRAFT' | 'PAID', seller: string) {
    const variant = await db.productVariant.findUniqueOrThrow({ where: { id: w.variantId } });
    const sale = await db.sale.create({ data: {
      branchId: w.branchId, sellerId: seller, status, priceMode: 'CASH', pricingMode: 'LIST',
      subtotal: 1000n * quantity, discountTotal: 0n, total: 1000n * quantity,
    } });
    await db.saleItem.create({ data: {
      saleId: sale.id, variantId: variant.id, productId: variant.productId, productName: `WH ${w.tag}`, variantName: 'WH',
      sku: variant.sku, quantity, unitPrice: 1000n, subtotal: 1000n * quantity,
    } });
    return sale.id;
  }

  it('PG-WH-16 an adjustment racing the REAL reservation: exactly one wins and physical >= reserved always holds', async () => {
    const w = await makeWorld();
    const inv = await seedInventory(w, 3n, 0n);
    const saleId = await draftSale(w, 2n, 'DRAFT', w.userB);
    const coordinator = await holdRowLock(pools[0]!, 'Inventory', inv.id);
    let results: PromiseSettledResult<unknown>[];
    try {
      const adjust = createInventoryAdjustmentService(racerA).adjustStock(w.ctxA, input(w, { delta: -2n }));
      const reserve = createReservationService(racerB).sendToCashier(saleId, w.userB, [w.branchId]);
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      results = await withTimeout(Promise.allSettled([adjust, reserve]), RACE_TIMEOUT_MS, 'adjust vs reserve');
    } finally {
      await coordinator.release();
    }
    const after = (await inventoryOf(w))!;
    expect(after.physical).toBeGreaterThanOrEqual(after.reserved);
    expect(after.reserved).toBeGreaterThanOrEqual(0n);
    const [adjusted, reserved] = results;
    expect([adjusted!.status, reserved!.status].filter((s) => s === 'fulfilled')).toHaveLength(1);
    if (adjusted!.status === 'fulfilled') {
      expect(after).toMatchObject({ physical: 1n, reserved: 0n });
      expect((reserved as PromiseRejectedResult).reason).toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    } else {
      expect(after).toMatchObject({ physical: 3n, reserved: 2n });
      expect((adjusted as PromiseRejectedResult).reason).toMatchObject({ code: 'STOCK_BELOW_RESERVED' });
    }
  });

  it('PG-WH-17 an adjustment racing the REAL sale completion never breaks the invariant and both orders converge', async () => {
    const w = await makeWorld();
    const inv = await seedInventory(w, 4n, 2n);
    const saleId = await draftSale(w, 2n, 'PAID', w.userB);
    const variant = await db.productVariant.findUniqueOrThrow({ where: { id: w.variantId } });
    await db.stockReservation.create({ data: {
      saleId, variantId: variant.id, branchId: w.branchId, quantity: 2n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3_600_000),
    } });
    const cashier = ctxOf(w.userB, 'CASHIER', w.branchId);
    const coordinator = await holdRowLock(pools[0]!, 'Inventory', inv.id);
    let results: PromiseSettledResult<unknown>[];
    try {
      // -3 is refused in EVERY order: first it would leave physical 1 < reserved 2, after the
      // completion it would leave 2 - 3 < 0.
      const adjust = createInventoryAdjustmentService(racerA).adjustStock(w.ctxA, input(w, { delta: -3n }));
      const complete = createSalesService(racerB).completeSale({ auth: cashier } as never, w.userB, saleId);
      await waitForBlocked(pools[0]!, coordinator.pid, 2, /FOR UPDATE/);
      await coordinator.release();
      results = await withTimeout(Promise.allSettled([adjust, complete]), RACE_TIMEOUT_MS, 'adjust vs complete');
    } finally {
      await coordinator.release();
    }
    const [adjusted, completed] = results;
    expect(completed!.status).toBe('fulfilled');
    expect(adjusted!.status).toBe('rejected');
    expect((adjusted as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(['STOCK_BELOW_RESERVED', 'NEGATIVE_STOCK']).toContain((adjusted as PromiseRejectedResult).reason.code);
    expect(await inventoryOf(w)).toMatchObject({ physical: 2n, reserved: 0n });
    expect(await adjustmentsOf(w)).toHaveLength(0);
  });
});
