// Focused LOCAL_TEST proof that removeItem serializes with every other Sale
// mutation through the Sale row lock. This file deliberately avoids the
// ordinary Vitest DB lifecycle: no global setup, no truncateAllTables, no
// seed, no reset. Every mutable row carries the unique RUN_ID prefix and only
// those rows are deleted. Opt-in: set MONA_REMOVE_ITEM_LOCAL_TEST=1.
//
// Coordination (no sleeps as proof): a test-owned connection holds a row lock
// while the real service call starts; pg_blocking_pids() proves which backend
// each service call waits for before the lock is released. The FIRST
// operation is paused by a test-owned FOR UPDATE on the SaleItem row it must
// write: it already owns the Sale lock and stops at that item write.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Pool, type PoolClient } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hash } from 'bcryptjs';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import type { Request } from 'express';
import type { AppError } from '../../src/shared/errors.js';
import type { createSalesService as CreateSalesService } from '../../src/modules/sales/sales.service.js';
import type { createWholesaleCodeVerifier as CreateWholesaleCodeVerifier } from '../../src/modules/sales/wholesale-authorization.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { openProvenLocalTestPool } from '../../scripts/demo-database.js';
import {
  type ApprovedMigration,
  classifyLocalTestBaseline,
  defaultLocalTestCanonicalBaseline,
  readLocalTestBaselineFacts,
} from '../../scripts/local-test-baseline.js';

type Fixture = Awaited<ReturnType<typeof createFixture>>;

const ENV_FILE = '/home/tuculandia/.config/mona-jacinta/local-test.env';
const RUN_ID = `rmitem-${Date.now()}-${randomUUID().slice(0, 8)}`;
const CODE = 'Mayor-2026';
const CODE_HASH = await hash(CODE, 4);
const APPROVED_MIGRATIONS: ApprovedMigration[] = [
  { name: '20260907015311_init', checksum: 'a584edab13a2ae540d694578ffa3b5a622decff04e238a5cf16d3040d295e4cb' },
  { name: '20260912182432_add_company_location', checksum: '19c345aa92c79a0a613dc03ea01dcf10e91b5a75fd6f3535076d8d71b6f740af' },
  { name: '20260912191702_add_user_role_scope', checksum: '2b415411eddc1212bf60419ce49022cea38d1fc2d12cb08938ad7c953caf7f3a' },
  { name: '20260922210000_d3_initial_stock_and_global_audit', checksum: '62b3b169e06a48dc2e2a3f81cee11e02a809b2733db2453c5b9eef91c15f77cf' },
  { name: '20261002120000_block1_pricing_wholesale', checksum: '45cf8d080e8fa4ec0a8dab9c9e5d4b780eb1642f0a8992d43b57dff655250173' },
  { name: '20261006120000_pilot_pricing_v2', checksum: 'd948f74e9c0eed3ce959f5c0e6edea70871d7d5957275f3304922e31bab6df12' },
];

// inventory/sales validators require UUID branch and variant ids, so those
// rows cannot carry the RUN_ID prefix: their exact ids are tracked instead.
const trackedBranchIds: string[] = [];
const trackedVariantIds: string[] = [];

let pool: Pool;
let prisma: PrismaClient;
let salesFactory: typeof CreateSalesService;
let verifierFactory: typeof CreateWholesaleCodeVerifier;
let appError: typeof AppError;

function localSource() {
  const env = parse(readFileSync(ENV_FILE));
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = env.LOCAL_TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = env.LOCAL_TEST_DATABASE_URL;
  process.env.JWT_SECRET = 'local-test-remove-item-concurrency-secret';
  process.env.JWT_ACCESS_TTL_SECONDS = '3600';
  process.env.CORS_ORIGINS = 'http://localhost.invalid';
  return {
    LOCAL_TEST_DATABASE_URL: env.LOCAL_TEST_DATABASE_URL,
    LOCAL_TEST_DATABASE_MARKER_ID: env.LOCAL_TEST_DATABASE_MARKER_ID,
  };
}

function canonical() {
  return defaultLocalTestCanonicalBaseline(APPROVED_MIGRATIONS);
}

async function baselineState() {
  const facts = await readLocalTestBaselineFacts(prisma);
  return { facts, classification: classifyLocalTestBaseline(facts, canonical()) };
}

function reqFor(userId: string, branchId: string): Request {
  const assignment: Express.ProductionAssignment = {
    roleId: 'SELLER',
    roleCode: 'SELLER',
    scopeKind: 'LOCATION',
    locationId: branchId,
    permissions: [...DEFAULT_ROLE_GRANTS.SELLER],
  };
  return { auth: { userId, roles: ['SELLER'], assignments: [assignment], effectiveLocationIds: [branchId] } } as unknown as Request;
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(appError);
  expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status, code });
}

async function cleanupRun() {
  await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { startsWith: RUN_ID } }, { branchId: { in: trackedBranchIds } }, { userId: { startsWith: RUN_ID } }] } });
  const sales = await prisma.sale.findMany({ where: { id: { startsWith: RUN_ID } }, select: { id: true } });
  const saleIds = sales.map(({ id }) => id);
  if (saleIds.length > 0) {
    await prisma.stockReservation.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
  }
  await prisma.saleNumberCounter.deleteMany({ where: { branchId: { in: trackedBranchIds } } });
  await prisma.inventory.deleteMany({ where: { branchId: { in: trackedBranchIds } } });
  await prisma.productVariant.deleteMany({ where: { id: { in: trackedVariantIds } } });
  await prisma.product.deleteMany({ where: { id: { startsWith: RUN_ID } } });
  await prisma.category.deleteMany({ where: { id: { startsWith: RUN_ID } } });
  await prisma.brand.deleteMany({ where: { id: { startsWith: RUN_ID } } });
  await prisma.userRoleScope.deleteMany({ where: { OR: [{ userId: { startsWith: RUN_ID } }, { locationId: { in: trackedBranchIds } }] } });
  await prisma.user.deleteMany({ where: { id: { startsWith: RUN_ID } } });
  await prisma.branch.deleteMany({ where: { id: { in: trackedBranchIds } } });
  await prisma.location.deleteMany({ where: { id: { in: trackedBranchIds } } });
}

async function residualCount() {
  const rows = await pool.query<{ count: string }>(
    `SELECT (
      (SELECT count(*) FROM "Location" WHERE id = ANY($2) OR code LIKE $1) +
      (SELECT count(*) FROM "Branch" WHERE id = ANY($2) OR code LIKE $1) +
      (SELECT count(*) FROM "User" WHERE id LIKE $1 OR email LIKE $1) +
      (SELECT count(*) FROM "UserRoleScope" WHERE "userId" LIKE $1 OR "locationId" = ANY($2)) +
      (SELECT count(*) FROM "Category" WHERE id LIKE $1) +
      (SELECT count(*) FROM "Brand" WHERE id LIKE $1) +
      (SELECT count(*) FROM "Product" WHERE id LIKE $1) +
      (SELECT count(*) FROM "ProductVariant" WHERE id = ANY($3) OR sku LIKE $1) +
      (SELECT count(*) FROM "Inventory" WHERE "branchId" = ANY($2) OR "variantId" = ANY($3)) +
      (SELECT count(*) FROM "SaleNumberCounter" WHERE "branchId" = ANY($2)) +
      (SELECT count(*) FROM "Sale" WHERE id LIKE $1 OR "branchId" = ANY($2)) +
      (SELECT count(*) FROM "SaleItem" WHERE "saleId" LIKE $1) +
      (SELECT count(*) FROM "StockReservation" WHERE "saleId" LIKE $1) +
      (SELECT count(*) FROM "AuditLog" WHERE "entityId" LIKE $1 OR "branchId" = ANY($2) OR "userId" LIKE $1)
    )::text AS count`,
    [`${RUN_ID}%`, trackedBranchIds, trackedVariantIds],
  );
  return Number(rows.rows[0]!.count);
}

async function createFixture(name: string, itemCount: 1 | 2 = 2) {
  const suffix = `${RUN_ID}-${name}-${randomUUID().slice(0, 8)}`;
  const company = await prisma.company.findFirstOrThrow({ select: { id: true } });
  const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' }, select: { id: true } });
  const branchId = randomUUID();
  trackedBranchIds.push(branchId);
  const sellerId = `${suffix}-seller`;
  const categoryId = `${suffix}-cat`;
  const brandId = `${suffix}-brand`;
  const productId = `${suffix}-product`;
  const firstVariantId = randomUUID();
  const secondVariantId = randomUUID();
  trackedVariantIds.push(firstVariantId, secondVariantId);
  const pos = 800000 + Math.floor(Math.random() * 100000);
  await prisma.location.create({
    data: { id: branchId, companyId: company.id, code: `${suffix}-loc`, name: `${suffix} Location`, type: 'RETAIL_BRANCH', address: suffix, pointOfSaleNumber: pos },
  });
  await prisma.branch.create({ data: { id: branchId, code: `${suffix}-br`, name: `${suffix} Branch`, address: suffix, pointOfSaleNumber: pos } });
  await prisma.user.create({ data: { id: sellerId, name: `${suffix} seller`, email: `${suffix}@test.invalid`, passwordHash: 'not-used', isActive: true } });
  await prisma.userRoleScope.create({ data: { userId: sellerId, roleId: role.id, scopeKind: 'LOCATION', locationId: branchId } });
  await prisma.category.create({ data: { id: categoryId, name: `${suffix} category` } });
  await prisma.brand.create({ data: { id: brandId, name: `${suffix} brand` } });
  await prisma.product.create({ data: { id: productId, name: `${suffix} product`, slug: `${suffix}-product`, categoryId, brandId, isActive: true } });
  await prisma.productVariant.create({
    data: {
      id: firstVariantId, productId, sku: `${suffix}-v1`, barcode: `${suffix}-b1`,
      color: 'Negro', size: 'M', cashPrice: 10000n, price: 10000n, wholesalePrice: 7000n, costPrice: 1000n, isActive: true,
    },
  });
  await prisma.productVariant.create({
    data: {
      id: secondVariantId, productId, sku: `${suffix}-v2`, barcode: `${suffix}-b2`,
      color: 'Azul', size: 'L', cashPrice: 5000n, price: 5000n, wholesalePrice: 3000n, costPrice: 1000n, isActive: true,
    },
  });
  await prisma.inventory.createMany({
    data: [
      { id: `${suffix}-inv1`, branchId, variantId: firstVariantId, physical: 100n, reserved: 0n },
      { id: `${suffix}-inv2`, branchId, variantId: secondVariantId, physical: 100n, reserved: 0n },
    ],
  });
  await prisma.saleNumberCounter.create({ data: { id: `${suffix}-counter`, branchId, nextValue: 1n } });
  const service = salesFactory(prisma, { wholesaleVerifier: verifierFactory(CODE_HASH) });
  const req = reqFor(sellerId, branchId);
  const saleId = `${suffix}-sale`;
  const itemRows = [
    {
      id: `${suffix}-item1`, saleId, variantId: firstVariantId, productId,
      productName: `${suffix} product`, variantName: 'Negro / M', sku: `${suffix}-v1`,
      quantity: 2n, priceBaseType: 'LIST' as const, priceMode: 'CASH' as const, baseUnitPrice: 10000n,
      priceAdjustmentBps: 0, unitPrice: 10000n, subtotal: 20000n,
    },
    {
      id: `${suffix}-item2`, saleId, variantId: secondVariantId, productId,
      productName: `${suffix} product`, variantName: 'Azul / L', sku: `${suffix}-v2`,
      quantity: 1n, priceBaseType: 'LIST' as const, priceMode: 'CASH' as const, baseUnitPrice: 5000n,
      priceAdjustmentBps: 0, unitPrice: 5000n, subtotal: 5000n,
    },
  ].slice(0, itemCount);
  const total = itemRows.reduce((sum, item) => sum + item.subtotal, 0n);
  await prisma.sale.create({ data: { id: saleId, sellerId, branchId, status: 'DRAFT', priceMode: 'CASH', subtotal: total, discountTotal: 0n, total } });
  await prisma.saleItem.createMany({ data: itemRows });
  return {
    service, req, sellerId, branchId, saleId, firstVariantId, secondVariantId,
    firstItemId: `${suffix}-item1`, secondItemId: itemCount === 2 ? `${suffix}-item2` : undefined,
  };
}

async function saleTotals(saleId: string) {
  return prisma.sale.findUniqueOrThrow({ where: { id: saleId }, select: { subtotal: true, total: true, status: true, saleNumber: true, priceMode: true, pricingMode: true } });
}

type Ctx = { holders: Set<PoolClient>; pending: Array<Promise<unknown>> };
type Holder = { client: PoolClient; pid: number };

async function holdRowLock(ctx: Ctx, sql: string, id: string): Promise<Holder> {
  const client = await pool.connect();
  ctx.holders.add(client);
  await client.query('BEGIN');
  const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  await client.query(sql, [id]);
  return { client, pid: rows[0]!.pid };
}

async function endHolder(ctx: Ctx, holder: Holder, action: 'COMMIT' | 'ROLLBACK') {
  await holder.client.query(action);
  ctx.holders.delete(holder.client);
  holder.client.release();
}

function start<T>(ctx: Ctx, run: () => Promise<T>) {
  let settled = false;
  const promise = run().finally(() => {
    settled = true;
  });
  ctx.pending.push(promise.then(() => undefined, () => undefined));
  return { promise, settled: () => settled };
}

// Polls PostgreSQL itself (not a timer) until some backend is waiting on a
// lock held by `holderPid`.
async function waitForBlockedBy(holderPid: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ pid: number; query: string }>(
      `SELECT pid, query FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND $1 = ANY(pg_blocking_pids(pid))
       LIMIT 1`,
      [holderPid],
    );
    if (result.rows.length > 0) return result.rows[0]!;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no backend became blocked behind pid ${holderPid}`);
}

async function expectSaleRowLocked(saleId: string) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const error = await client.query('SELECT id FROM "Sale" WHERE id = $1 FOR UPDATE NOWAIT', [saleId]).then(() => null, (cause: unknown) => cause);
    expect((error as { code?: string } | null)?.code).toBe('55P03');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function withFixture<T>(name: string, itemCount: 1 | 2, fn: (fixture: Fixture, ctx: Ctx) => Promise<T>) {
  const ctx: Ctx = { holders: new Set(), pending: [] };
  const fixture = await createFixture(name, itemCount);
  try {
    return await fn(fixture, ctx);
  } finally {
    for (const client of ctx.holders) {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    await Promise.allSettled(ctx.pending);
    await cleanupRun();
  }
}

// First operation owns the Sale row lock and is paused at its SaleItem write
// (blocked by a test-owned lock on that item); the second operation then
// starts and must queue behind the first operation's Sale lock.
async function overlap<A, B>(
  ctx: Ctx, f: Fixture, lockedItemId: string, first: () => Promise<A>, second: () => Promise<B>,
) {
  const itemLock = await holdRowLock(ctx, 'SELECT id FROM "SaleItem" WHERE id = $1 FOR UPDATE', lockedItemId);
  const op1 = start(ctx, first);
  const op1Backend = await waitForBlockedBy(itemLock.pid);
  expect(op1Backend.query).toContain('SaleItem');
  await expectSaleRowLocked(f.saleId);
  const op2 = start(ctx, second);
  const op2Backend = await waitForBlockedBy(op1Backend.pid);
  expect(op2Backend.pid).not.toBe(op1Backend.pid);
  expect(op2Backend.query).toContain('FROM "Sale"');
  expect(op2Backend.query).toContain('FOR UPDATE');
  expect(op1.settled()).toBe(false);
  expect(op2.settled()).toBe(false);
  await endHolder(ctx, itemLock, 'ROLLBACK');
  return { op1: op1.promise, op2: op2.promise };
}

const enabled = process.env.MONA_REMOVE_ITEM_LOCAL_TEST === '1';

describe.skipIf(!enabled)('removeItem LOCAL_TEST row-lock proof', () => {
  beforeAll(async () => {
    const source = localSource();
    const proven = await openProvenLocalTestPool(8, source);
    pool = proven.pool;
    prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] });
    ({ createSalesService: salesFactory } = await import('../../src/modules/sales/sales.service.js'));
    ({ createWholesaleCodeVerifier: verifierFactory } = await import('../../src/modules/sales/wholesale-authorization.service.js'));
    ({ AppError: appError } = await import('../../src/shared/errors.js'));
    // Preflight, before any write: baseline exact, run identity unused.
    expect((await baselineState()).classification.state).toBe('EXACT_BASELINE');
    expect(await residualCount()).toBe(0);
  });

  afterAll(async () => {
    try {
      await cleanupRun();
      expect(await residualCount()).toBe(0);
      expect((await baselineState()).classification.state).toBe('EXACT_BASELINE');
    } finally {
      await prisma?.$disconnect();
      await pool?.end();
    }
  });

  it('DB01/DB05 [REAL_LOCK_CONTENTION] transition-first: removeItem waits, then SALE_NOT_DRAFT with no side effects', async () => {
    await withFixture('transition-first', 2, async (f, ctx) => {
      const saleLock = await holdRowLock(ctx, 'SELECT id FROM "Sale" WHERE id = $1 FOR UPDATE', f.saleId);
      const remove = start(ctx, () => f.service.removeItem(f.req, f.sellerId, f.saleId, f.firstItemId));
      const blocked = await waitForBlockedBy(saleLock.pid);
      expect(blocked.query).toContain('FROM "Sale"');
      expect(blocked.query).toContain('FOR UPDATE');
      expect(remove.settled()).toBe(false);
      await saleLock.client.query('UPDATE "Sale" SET status = $2 WHERE id = $1', [f.saleId, 'PENDING_PAYMENT']);
      await endHolder(ctx, saleLock, 'COMMIT');
      await expectAppError(remove.promise, 409, 'SALE_NOT_DRAFT');
      expect(await prisma.saleItem.count({ where: { saleId: f.saleId } })).toBe(2);
      expect(await saleTotals(f.saleId)).toMatchObject({ status: 'PENDING_PAYMENT', subtotal: 25000n, total: 25000n });
      expect(await prisma.stockReservation.count({ where: { saleId: f.saleId } })).toBe(0);
    });
  });

  it('DB02 [REAL_LOCK_CONTENTION] remove-first: send waits behind removeItem and observes the post-remove items', async () => {
    await withFixture('remove-first-send', 2, async (f, ctx) => {
      const { op1: remove, op2: send } = await overlap(
        ctx, f, f.firstItemId,
        () => f.service.removeItem(f.req, f.sellerId, f.saleId, f.firstItemId),
        () => f.service.sendToCashier(f.saleId, f.sellerId, [f.branchId]),
      );
      await remove;
      await send;
      expect(await prisma.saleItem.findMany({ where: { saleId: f.saleId } })).toEqual([
        expect.objectContaining({ variantId: f.secondVariantId, quantity: 1n }),
      ]);
      expect(await saleTotals(f.saleId)).toMatchObject({ status: 'PENDING_PAYMENT', subtotal: 5000n, total: 5000n });
      expect(await prisma.stockReservation.findMany({ where: { saleId: f.saleId } })).toEqual([
        expect.objectContaining({ variantId: f.secondVariantId, quantity: 1n, status: 'ACTIVE' }),
      ]);
    });
  });

  it('DB03 [REAL_LOCK_CONTENTION] remove-first of the LAST item: send waits, then EMPTY_SALE', async () => {
    await withFixture('remove-last', 1, async (f, ctx) => {
      const { op1: remove, op2: send } = await overlap(
        ctx, f, f.firstItemId,
        () => f.service.removeItem(f.req, f.sellerId, f.saleId, f.firstItemId),
        () => f.service.sendToCashier(f.saleId, f.sellerId, [f.branchId]),
      );
      await remove;
      await expectAppError(send, 409, 'EMPTY_SALE');
      expect(await prisma.stockReservation.count({ where: { saleId: f.saleId } })).toBe(0);
      expect(await saleTotals(f.saleId)).toMatchObject({ status: 'DRAFT', subtotal: 0n, total: 0n, saleNumber: null });
    });
  });

  it('DB04/DB06/DB07 [REAL_LOCK_CONTENTION] remove one of two while send waits: only the remaining variant is reserved, totals match', async () => {
    await withFixture('remove-one-of-two', 2, async (f, ctx) => {
      const { op1: remove, op2: send } = await overlap(
        ctx, f, f.secondItemId!,
        () => f.service.removeItem(f.req, f.sellerId, f.saleId, f.secondItemId!),
        () => f.service.sendToCashier(f.saleId, f.sellerId, [f.branchId]),
      );
      await remove;
      await send;
      expect(await prisma.stockReservation.findMany({ where: { saleId: f.saleId } })).toEqual([
        expect.objectContaining({ variantId: f.firstVariantId, quantity: 2n, status: 'ACTIVE' }),
      ]);
      const reserved = Object.fromEntries((await prisma.inventory.findMany({ where: { branchId: f.branchId }, select: { variantId: true, reserved: true } })).map((row) => [row.variantId, row.reserved]));
      expect(reserved).toEqual({ [f.firstVariantId]: 2n, [f.secondVariantId]: 0n });
      expect(await saleTotals(f.saleId)).toMatchObject({ status: 'PENDING_PAYMENT', subtotal: 20000n, total: 20000n });
    });
  });

  it('DB08a [REAL_LOCK_CONTENTION] remove-first: updateItem waits, then NOT_FOUND; the removed item is not resurrected', async () => {
    await withFixture('remove-first-update', 2, async (f, ctx) => {
      const { op1: remove, op2: update } = await overlap(
        ctx, f, f.firstItemId,
        () => f.service.removeItem(f.req, f.sellerId, f.saleId, f.firstItemId),
        () => f.service.updateItem(f.req, f.sellerId, f.saleId, f.firstItemId, { quantity: 5n }),
      );
      await remove;
      await expectAppError(update, 404, 'NOT_FOUND');
      expect(await prisma.saleItem.findMany({ where: { saleId: f.saleId } })).toEqual([
        expect.objectContaining({ variantId: f.secondVariantId, quantity: 1n, subtotal: 5000n }),
      ]);
      expect(await saleTotals(f.saleId)).toMatchObject({ subtotal: 5000n, total: 5000n });
    });
  });

  it('DB08b [REAL_LOCK_CONTENTION] update-first: removeItem waits, then deletes the updated item; totals match the remainder', async () => {
    await withFixture('update-first-remove', 2, async (f, ctx) => {
      const { op1: update, op2: remove } = await overlap(
        ctx, f, f.firstItemId,
        () => f.service.updateItem(f.req, f.sellerId, f.saleId, f.firstItemId, { quantity: 5n }),
        () => f.service.removeItem(f.req, f.sellerId, f.saleId, f.firstItemId),
      );
      await update;
      await remove;
      expect(await prisma.saleItem.findMany({ where: { saleId: f.saleId } })).toEqual([
        expect.objectContaining({ variantId: f.secondVariantId, quantity: 1n, subtotal: 5000n }),
      ]);
      expect(await saleTotals(f.saleId)).toMatchObject({ subtotal: 5000n, total: 5000n });
    });
  });

  it('DB09 [REAL_LOCK_CONTENTION] priceMode-first: removeItem waits; final snapshots are coherent', async () => {
    await withFixture('price-first-remove', 2, async (f, ctx) => {
      const { op1: price, op2: remove } = await overlap(
        ctx, f, f.firstItemId,
        () => f.service.updatePriceMode(f.req, f.sellerId, f.saleId, 'QR'),
        () => f.service.removeItem(f.req, f.sellerId, f.saleId, f.secondItemId!),
      );
      await price;
      await remove;
      const items = await prisma.saleItem.findMany({ where: { saleId: f.saleId } });
      expect(items).toEqual([expect.objectContaining({ variantId: f.firstVariantId, priceMode: 'QR' })]);
      const sale = await saleTotals(f.saleId);
      expect(sale).toMatchObject({ priceMode: 'QR' });
      expect(sale.subtotal).toBe(items[0]!.subtotal);
      expect(sale.total).toBe(items[0]!.subtotal);
    });
  });

  it('DB10 [REAL_LOCK_CONTENTION] wholesale-first: removeItem waits; no partially repriced or deleted state', async () => {
    await withFixture('wholesale-first-remove', 2, async (f, ctx) => {
      const { op1: wholesale, op2: remove } = await overlap(
        ctx, f, f.firstItemId,
        () => f.service.activateWholesale(f.req, f.sellerId, f.saleId, CODE),
        () => f.service.removeItem(f.req, f.sellerId, f.saleId, f.secondItemId!),
      );
      await wholesale;
      await remove;
      const items = await prisma.saleItem.findMany({ where: { saleId: f.saleId } });
      expect(items).toEqual([expect.objectContaining({ variantId: f.firstVariantId, priceBaseType: 'WHOLESALE', unitPrice: 7000n, subtotal: 14000n })]);
      expect(await saleTotals(f.saleId)).toMatchObject({ pricingMode: 'WHOLESALE', subtotal: 14000n, total: 14000n });
    });
  });

  it('DB10b [REAL_LOCK_CONTENTION] remove-first: wholesale activation waits and reprices only the remaining item', async () => {
    await withFixture('remove-first-wholesale', 2, async (f, ctx) => {
      const { op1: remove, op2: wholesale } = await overlap(
        ctx, f, f.secondItemId!,
        () => f.service.removeItem(f.req, f.sellerId, f.saleId, f.secondItemId!),
        () => f.service.activateWholesale(f.req, f.sellerId, f.saleId, CODE),
      );
      await remove;
      await wholesale;
      const items = await prisma.saleItem.findMany({ where: { saleId: f.saleId } });
      expect(items).toEqual([expect.objectContaining({ variantId: f.firstVariantId, priceBaseType: 'WHOLESALE', unitPrice: 7000n, subtotal: 14000n })]);
      expect(await saleTotals(f.saleId)).toMatchObject({ pricingMode: 'WHOLESALE', subtotal: 14000n, total: 14000n });
    });
  });
});
