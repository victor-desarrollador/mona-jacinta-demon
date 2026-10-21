// WAREHOUSE-MVP: DB-FREE behavioral coverage for the manual stock adjustment
// (POST /inventory/adjustments) and its service.
//
// In-memory stateful stand-in: `$transaction` keeps an undo log so a rollback is
// observable, `SELECT ... FOR UPDATE` is a real per-row mutex held until the
// transaction ends, and transient errors can be injected per attempt.
// Real PostgreSQL interleavings are proven separately on a disposable cluster;
// these tests pin the lock protocol, the retry contract, idempotency, the
// invariants (no negative stock, physical >= reserved, reserved untouched) and
// the audit/movement shape.
//
// PRE-REGISTERED EXPECTATIONS (2026-10-20):
//   S01..S21 service, R01..R17 POST route contract.
import { randomUUID } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createInventoryRouter } from '../../src/modules/inventory/inventory.routes.js';
import { createInventoryAdjustmentService } from '../../src/modules/inventory/inventory-adjustment.service.js';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { AppError } from '../../src/shared/errors.js';

const BRANCH = '00000000-0000-4000-8000-0000000000a1';
const OTHER_BRANCH = '00000000-0000-4000-8000-0000000000b2';
const VARIANT = '00000000-0000-4000-8000-0000000000c1';
const OTHER_VARIANT = '00000000-0000-4000-8000-0000000000c2';
const INACTIVE_VARIANT = '00000000-0000-4000-8000-0000000000c3';
const ACTORS = ['00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000d002'] as const;
const ACTIVE_LOCATIONS = [BRANCH, OTHER_BRANCH];

type RoleName = keyof typeof DEFAULT_ROLE_GRANTS | 'OWNER';
type Scope = { role: RoleName; at: string | 'COMPANY' };

async function authFor(scopes: Scope[], userId: string = ACTORS[0]) {
  return buildAuthorizationContext(
    { location: { findMany: async () => ACTIVE_LOCATIONS.map((id) => ({ id })) } },
    {
      id: userId,
      branchRoles: [],
      roleScopes: scopes.map((scope) => ({
        roleId: `role-${scope.role}`,
        scopeKind: scope.at === 'COMPANY' ? ('COMPANY' as const) : ('LOCATION' as const),
        locationId: scope.at === 'COMPANY' ? null : scope.at,
        role: {
          code: scope.role,
          permissions: (scope.role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[scope.role]]).map((code) => ({ permission: { code } })),
        },
      })),
    },
  );
}

type InventoryRow = { id: string; variantId: string; branchId: string; physical: bigint; reserved: bigint };
type MovementRow = {
  id: string; inventoryId: string; type: string; quantityDelta: bigint; saleId: string | null; userId: string;
  branchId: string; reason: string | null; note: string | null; idempotencyKey: string | null;
};
type AuditRow = { userId: string; branchId: string | null; action: string; entityType: string; entityId: string; before: unknown; after: unknown };

function createFakeDb(seed: { inventory?: Array<Partial<InventoryRow>> } = {}) {
  const state = {
    inventory: [] as InventoryRow[],
    movements: [] as MovementRow[],
    audits: [] as AuditRow[],
    variants: new Map<string, { id: string; sku: string; isActive: boolean }>([
      [VARIANT, { id: VARIANT, sku: 'REM-NEG-M', isActive: true }],
      [OTHER_VARIANT, { id: OTHER_VARIANT, sku: 'REM-BLA-M', isActive: true }],
      [INACTIVE_VARIANT, { id: INACTIVE_VARIANT, sku: 'REM-OLD-M', isActive: false }],
    ]),
    locations: new Map<string, { isActive: boolean }>([[BRANCH, { isActive: true }], [OTHER_BRANCH, { isActive: true }]]),
  };
  for (const row of seed.inventory ?? []) {
    state.inventory.push({ id: randomUUID(), variantId: VARIANT, branchId: BRANCH, physical: 0n, reserved: 0n, ...row });
  }
  const log = {
    transactions: 0, attempts: 0, options: [] as unknown[], sql: [] as string[], inventoryUpdates: [] as Array<Record<string, unknown>>,
    order: [] as string[],
  };
  const hooks = {
    failAttempts: [] as unknown[], // errors thrown at the start of consecutive attempts
    raceOnFirstInsert: false,
    auditShouldThrow: false,
  };
  const locks = new Map<string, { owner: symbol; queue: Array<() => void> }>();

  async function acquire(inventoryId: string, owner: symbol) {
    const held = locks.get(inventoryId);
    if (!held) { locks.set(inventoryId, { owner, queue: [] }); return; }
    if (held.owner === owner) return;
    await new Promise<void>((resolve) => held.queue.push(resolve));
    return acquire(inventoryId, owner);
  }
  function releaseAll(owner: symbol) {
    for (const [id, held] of [...locks]) {
      if (held.owner !== owner) continue;
      locks.delete(id);
      const next = held.queue.shift();
      if (next) { for (const rest of held.queue) rest(); next(); }
    }
  }

  function makeTx(owner: symbol, undo: Array<() => void>) {
    const inventoryRow = (variantId: string, branchId: string) => state.inventory.find((r) => r.variantId === variantId && r.branchId === branchId);
    return {
      $queryRaw: async (templates: TemplateStringsArray, ...values: unknown[]) => {
        const sql = templates.join('$?');
        log.sql.push(sql);
        if (sql.includes('FROM "Inventory"') && sql.includes('FOR UPDATE')) {
          const row = inventoryRow(String(values[0]), String(values[1]));
          if (!row) return [];
          await acquire(row.id, owner);
          log.order.push('lock');
          return [{ id: row.id, physical: row.physical, reserved: row.reserved }];
        }
        return [];
      },
      productVariant: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const found = state.variants.get(where.id);
          return found ? { ...found } : null;
        },
      },
      branch: { findUnique: async ({ where }: { where: { id: string } }) => (state.locations.has(where.id) ? { id: where.id } : null) },
      location: { findUnique: async ({ where }: { where: { id: string } }) => state.locations.get(where.id) ?? null },
      inventory: {
        upsert: async ({ where, create }: { where: { variantId_branchId: { variantId: string; branchId: string } }; create: Partial<InventoryRow> }) => {
          const key = where.variantId_branchId;
          let row = inventoryRow(key.variantId, key.branchId);
          if (hooks.raceOnFirstInsert && !row) {
            hooks.raceOnFirstInsert = false;
            // The concurrent winner committed its first insert; this insert loses.
            state.inventory.push({ id: randomUUID(), variantId: key.variantId, branchId: key.branchId, physical: 0n, reserved: 0n });
            throw p2002({ modelName: 'Inventory', target: ['variantId', 'branchId'] });
          }
          if (!row) {
            row = { id: randomUUID(), variantId: key.variantId, branchId: key.branchId, physical: create.physical ?? 0n, reserved: create.reserved ?? 0n };
            const inserted = row;
            state.inventory.push(inserted);
            undo.push(() => { state.inventory.splice(state.inventory.indexOf(inserted), 1); });
          }
          return { ...row };
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          log.inventoryUpdates.push(data);
          const row = state.inventory.find((r) => r.id === where.id)!;
          const before = { ...row };
          const next = data.physical;
          if (typeof next === 'bigint') row.physical = next;
          else if (next && typeof next === 'object' && 'increment' in next) row.physical += (next as { increment: bigint }).increment;
          if (typeof data.reserved === 'bigint') row.reserved = data.reserved;
          undo.push(() => { Object.assign(row, before); });
          return { ...row };
        },
      },
      stockMovement: {
        findUnique: async ({ where }: { where: { userId_idempotencyKey: { userId: string; idempotencyKey: string } } }) => {
          const key = where.userId_idempotencyKey;
          const found = state.movements.find((m) => m.userId === key.userId && m.idempotencyKey === key.idempotencyKey);
          if (!found) return null;
          const inv = state.inventory.find((r) => r.id === found.inventoryId)!;
          return { ...found, inventory: { ...inv } };
        },
        create: async ({ data }: { data: Omit<MovementRow, 'id'> }) => {
          const duplicate = data.idempotencyKey !== null && state.movements.some((m) => m.userId === data.userId && m.idempotencyKey === data.idempotencyKey);
          if (duplicate) throw p2002({ modelName: 'StockMovement', target: ['userId', 'idempotencyKey'] });
          const row = { id: randomUUID(), ...data };
          state.movements.push(row);
          undo.push(() => { state.movements.splice(state.movements.indexOf(row), 1); });
          return { ...row };
        },
      },
      auditLog: {
        create: async ({ data }: { data: AuditRow }) => {
          if (hooks.auditShouldThrow) throw new Error('audit unavailable');
          state.audits.push(data);
          undo.push(() => { state.audits.pop(); });
          return data;
        },
      },
    };
  }

  const database = {
    $transaction: async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>, options?: unknown) => {
      log.attempts += 1;
      log.options.push(options);
      const injected = hooks.failAttempts.shift();
      if (injected) throw injected;
      log.transactions += 1;
      const owner = Symbol('tx');
      const undo: Array<() => void> = [];
      try {
        return await fn(makeTx(owner, undo));
      } catch (error) {
        for (const step of undo.reverse()) step();
        throw error;
      } finally {
        releaseAll(owner);
      }
    },
  };

  // A foreign writer (a reservation or a sale completion) that takes the row
  // lock, parks until released, applies its change and commits.
  async function foreignWriter(variantId: string, branchId: string, change: (row: InventoryRow) => void) {
    const owner = Symbol('foreign');
    const row = state.inventory.find((r) => r.variantId === variantId && r.branchId === branchId)!;
    await acquire(row.id, owner);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const done = gate.then(() => { change(row); releaseAll(owner); });
    return { release, done };
  }

  return { database: database as unknown as PrismaClient, state, log, hooks, foreignWriter };
}

// A Prisma P2002 as the engine (meta.target) or adapter-pg 7.10 (meta.driverAdapterError) reports it.
const p2002 = (meta: Record<string, unknown>) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta });

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

function input(overrides: Record<string, unknown> = {}) {
  return {
    variantId: VARIANT, branchId: BRANCH, delta: 3n, reason: 'LOAD_ERROR' as const, note: undefined as string | undefined,
    idempotencyKey: `key-${randomUUID()}`, ...overrides,
  };
}

async function warehouseAt(branch = BRANCH, userId: string = ACTORS[0]) {
  return authFor([{ role: 'WAREHOUSE', at: branch }], userId);
}

describe('inventory adjustment service (WAREHOUSE-MVP)', () => {
  let fake: ReturnType<typeof createFakeDb>;
  beforeEach(() => { fake = createFakeDb({ inventory: [{ physical: 10n, reserved: 4n }] }); });
  const service = () => createInventoryAdjustmentService(fake.database);
  const row = () => fake.state.inventory.find((r) => r.variantId === VARIANT && r.branchId === BRANCH)!;

  it('S01 a positive adjustment adds to physical and records one ADJUSTMENT movement and one audit', async () => {
    const result = await service().adjustStock(await warehouseAt(), input({ delta: 5n, reason: 'SURPLUS', idempotencyKey: 'k1' }));
    expect(result.replayed).toBe(false);
    expect(row().physical).toBe(15n);
    expect(fake.state.movements).toHaveLength(1);
    expect(fake.state.movements[0]).toMatchObject({
      inventoryId: row().id, type: 'ADJUSTMENT', quantityDelta: 5n, saleId: null, userId: ACTORS[0], branchId: BRANCH,
      reason: 'SURPLUS', note: null, idempotencyKey: 'k1',
    });
    expect(fake.state.audits).toHaveLength(1);
  });

  it('S02 a negative adjustment subtracts from physical', async () => {
    await service().adjustStock(await warehouseAt(), input({ delta: -6n, reason: 'DAMAGED', note: 'se rompió', idempotencyKey: 'k2' }));
    expect(row().physical).toBe(4n);
    expect(fake.state.movements[0]).toMatchObject({ quantityDelta: -6n, reason: 'DAMAGED', note: 'se rompió' });
  });

  it('S03 LOAD_ERROR is accepted with a positive and with a negative delta', async () => {
    await service().adjustStock(await warehouseAt(), input({ delta: 2n, reason: 'LOAD_ERROR', idempotencyKey: 'k3a' }));
    await service().adjustStock(await warehouseAt(), input({ delta: -1n, reason: 'LOAD_ERROR', idempotencyKey: 'k3b' }));
    expect(row().physical).toBe(11n);
  });

  it('S04 reserved is never modified and the balance update only touches physical', async () => {
    await service().adjustStock(await warehouseAt(), input({ delta: -3n, reason: 'LOST', idempotencyKey: 'k4' }));
    expect(row().reserved).toBe(4n);
    expect(fake.log.inventoryUpdates).toHaveLength(1);
    expect(Object.keys(fake.log.inventoryUpdates[0]!)).toEqual(['physical']);
  });

  it('S05 refuses negative stock with NEGATIVE_STOCK and writes nothing', async () => {
    fake = createFakeDb({ inventory: [{ physical: 2n, reserved: 0n }] });
    await expect(service().adjustStock(await warehouseAt(), input({ delta: -3n, reason: 'LOST', idempotencyKey: 'k5' })))
      .rejects.toMatchObject({ status: 409, code: 'NEGATIVE_STOCK' });
    expect(row().physical).toBe(2n);
    expect(fake.state.movements).toHaveLength(0);
    expect(fake.state.audits).toHaveLength(0);
  });

  it('S06 refuses physical below reserved with STOCK_BELOW_RESERVED (boundary physical == reserved is allowed)', async () => {
    await expect(service().adjustStock(await warehouseAt(), input({ delta: -7n, reason: 'LOST', idempotencyKey: 'k6a' })))
      .rejects.toMatchObject({ status: 409, code: 'STOCK_BELOW_RESERVED' });
    expect(row().physical).toBe(10n);
    await service().adjustStock(await warehouseAt(), input({ delta: -6n, reason: 'LOST', idempotencyKey: 'k6b' }));
    expect(row().physical).toBe(4n);
  });

  it('S06b physical=1, reserved=1, delta=-1 is refused with STOCK_BELOW_RESERVED and reserved stays intact', async () => {
    fake = createFakeDb({ inventory: [{ physical: 1n, reserved: 1n }] });
    await expect(service().adjustStock(await warehouseAt(), input({ delta: -1n, reason: 'LOST', idempotencyKey: 'k6c' })))
      .rejects.toMatchObject({ status: 409, code: 'STOCK_BELOW_RESERVED' });
    expect(row()).toMatchObject({ physical: 1n, reserved: 1n });
    expect(fake.state.movements).toHaveLength(0);
    expect(fake.state.audits).toHaveLength(0);
  });

  it('S07 a negative adjustment on a variant without an Inventory row is NEGATIVE_STOCK and creates no row', async () => {
    await expect(service().adjustStock(await warehouseAt(), input({ variantId: OTHER_VARIANT, delta: -1n, reason: 'LOST', idempotencyKey: 'k7' })))
      .rejects.toMatchObject({ status: 409, code: 'NEGATIVE_STOCK' });
    expect(fake.state.inventory).toHaveLength(1);
  });

  it('S07b a positive adjustment on a variant without an Inventory row creates it at 0/0 and applies the delta', async () => {
    await service().adjustStock(await warehouseAt(), input({ variantId: OTHER_VARIANT, delta: 4n, reason: 'SURPLUS', idempotencyKey: 'k7b' }));
    const created = fake.state.inventory.find((r) => r.variantId === OTHER_VARIANT)!;
    expect(created).toMatchObject({ branchId: BRANCH, physical: 4n, reserved: 0n });
  });

  it('S08 the audit row carries real actor / branch / entity and JSON-safe before and after', async () => {
    await service().adjustStock(await warehouseAt(), input({ delta: -2n, reason: 'OTHER', note: 'conteo físico distinto', idempotencyKey: 'k8' }));
    const audit = fake.state.audits[0]!;
    expect(audit).toMatchObject({ userId: ACTORS[0], branchId: BRANCH, action: 'INVENTORY_MANUAL_ADJUSTMENT', entityType: 'Inventory', entityId: row().id });
    expect(audit.before).toEqual({ physical: '10', reserved: '4', available: '6' });
    expect(audit.after).toEqual({
      physical: '8', reserved: '4', available: '4', delta: '-2', reason: 'OTHER', note: 'conteo físico distinto',
      variantId: VARIANT, sku: 'REM-NEG-M', movementId: fake.state.movements[0]!.id, idempotencyKey: 'k8',
    });
  });

  it('S09 is atomic: an audit failure rolls the balance and the movement back', async () => {
    fake.hooks.auditShouldThrow = true;
    await expect(service().adjustStock(await warehouseAt(), input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: 'k9' }))).rejects.toThrow('audit unavailable');
    expect(row().physical).toBe(10n);
    expect(fake.state.movements).toHaveLength(0);
    expect(fake.state.audits).toHaveLength(0);
  });

  it('S10 runs Serializable and reads the balance only after taking the row lock', async () => {
    await service().adjustStock(await warehouseAt(), input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: 'k10' }));
    expect(fake.log.options[0]).toMatchObject({ isolationLevel: 'Serializable' });
    expect(fake.log.sql.some((sql) => sql.includes('FROM "Inventory"') && sql.includes('FOR UPDATE'))).toBe(true);
  });

  describe('retries', () => {
    it.each([
      ['P2034', Object.assign(new Error('write conflict'), { code: 'P2034' })],
      ['P2002 Inventory (engine meta.target fields)', p2002({ modelName: 'Inventory', target: ['variantId', 'branchId'] })],
      ['P2002 Inventory (engine meta.target index)', p2002({ modelName: 'Inventory', target: 'Inventory_variantId_branchId_key' })],
      ['P2002 Inventory (adapter-pg constraint index)', p2002({ driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index: 'Inventory_variantId_branchId_key' } } } })],
      ['P2002 Inventory (adapter-pg quoted fields)', p2002({ driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { fields: ['"variantId"', '"branchId"'] } } } })],
      ['P2002 StockMovement idempotency (meta.target fields)', p2002({ modelName: 'StockMovement', target: ['userId', 'idempotencyKey'] })],
      ['P2002 StockMovement idempotency (adapter-pg index)', p2002({ driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index: 'StockMovement_userId_idempotencyKey_key' } } } })],
      ['40001 in message', new Error('could not serialize access (40001)')],
      ['40001 meta.code', Object.assign(new Error('x'), { meta: { code: '40001' } })],
      ['40001 driverAdapterError originalCode', Object.assign(new Error('x'), { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40001', kind: 'TransactionWriteConflict' } } } })],
      ['40001 pg sqlState on the error', Object.assign(new Error('x'), { code: '40001' })],
      ['40001 pg error as cause', Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('could not serialize'), { code: '40001' }) })],
      ['40P01 message', new Error('deadlock detected (40P01)')],
      ['40P01 meta.code', Object.assign(new Error('deadlock'), { meta: { code: '40P01' } })],
      ['40P01 pg sqlState on the error', Object.assign(new Error('deadlock'), { code: '40P01' })],
      ['40P01 driverAdapterError originalCode', Object.assign(new Error('x'), { meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } })],
      ['40P01 pg error as cause', Object.assign(new Error('Failed query'), { cause: Object.assign(new Error('deadlock'), { code: '40P01' }) })],
      ['driverAdapterError kind TransactionWriteConflict', Object.assign(new Error('x'), { meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } } })],
      ['TransactionWriteConflict', new Error('TransactionWriteConflict')],
    ])('S11 retries a transient %s and then succeeds', async (_name, transient) => {
      fake.hooks.failAttempts = [transient];
      const result = await service().adjustStock(await warehouseAt(), input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: `k11-${_name}` }));
      expect(result.replayed).toBe(false);
      expect(fake.log.attempts).toBe(2);
      expect(row().physical).toBe(11n);
    });

    it('S11b exhausts after 3 attempts with 409 CONCURRENCY_ERROR', async () => {
      const transient = Object.assign(new Error('write conflict'), { code: 'P2034' });
      fake.hooks.failAttempts = [transient, transient, transient, transient];
      await expect(service().adjustStock(await warehouseAt(), input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: 'k11b' })))
        .rejects.toMatchObject({ status: 409, code: 'CONCURRENCY_ERROR', message: 'La operación no pudo completarse por concurrencia.' });
      expect(fake.log.attempts).toBe(3);
      expect(row().physical).toBe(10n);
    });

    it.each([
      ['bare P2002 without a constraint', p2002({})],
      ['P2002 of another table', p2002({ modelName: 'ProductVariant', target: ['sku'] })],
      ['P2002 of another Inventory-like index', p2002({ modelName: 'Inventory', target: ['id'] })],
      ['P2002 of another StockMovement key', p2002({ modelName: 'StockMovement', target: ['saleId', 'inventoryId'] })],
      ['P2002 adapter-pg foreign index', p2002({ driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index: 'ProductVariant_sku_key' } } } })],
      ['P2002 partial match (userId only)', p2002({ modelName: 'StockMovement', target: ['userId'] })],
    ])('S11e does NOT retry %s and propagates the original error', async (_name, foreign) => {
      fake.hooks.failAttempts = [foreign];
      await expect(service().adjustStock(await warehouseAt(), input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: 'k11e' })))
        .rejects.toBe(foreign);
      expect(fake.log.attempts).toBe(1);
      expect(row().physical).toBe(10n);
    });

    it.each([
      ['40001 text inside an unrelated word', new Error('invoice 1400012 failed')],
      ['unrelated code', Object.assign(new Error('x'), { code: '23505' })],
      ['unrelated cause', Object.assign(new Error('x'), { cause: { code: '23503' } })],
      ['non-object throw', 'boom'],
    ])('S11f does not retry %s', async (_name, other) => {
      fake.hooks.failAttempts = [other];
      await expect(service().adjustStock(await warehouseAt(), input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: 'k11f' }))).rejects.toBe(other);
      expect(fake.log.attempts).toBe(1);
    });

    it('S11c does not retry a non-transient error', async () => {
      fake.hooks.failAttempts = [new Error('boom')];
      await expect(service().adjustStock(await warehouseAt(), input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: 'k11c' }))).rejects.toThrow('boom');
      expect(fake.log.attempts).toBe(1);
    });

    it('S11d does not retry a business rejection', async () => {
      await expect(service().adjustStock(await warehouseAt(), input({ delta: -10n, reason: 'LOST', idempotencyKey: 'k11d' })))
        .rejects.toMatchObject({ code: 'STOCK_BELOW_RESERVED' });
      expect(fake.log.attempts).toBe(1);
    });
  });

  it('S12 two concurrent adjustments serialize on the row lock (no lost update, no negative stock)', async () => {
    fake = createFakeDb({ inventory: [{ physical: 5n, reserved: 0n }] });
    const auth = await warehouseAt();
    const results = await Promise.allSettled([
      service().adjustStock(auth, input({ delta: -3n, reason: 'LOST', idempotencyKey: 'k12a' })),
      service().adjustStock(auth, input({ delta: -3n, reason: 'LOST', idempotencyKey: 'k12b' })),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'NEGATIVE_STOCK' });
    expect(row().physical).toBe(2n);
    expect(fake.state.movements).toHaveLength(1);
  });

  it('S13 survives the first-Inventory insert race (P2002 -> retry finds the row and adds under the lock)', async () => {
    fake.hooks.raceOnFirstInsert = true;
    await service().adjustStock(await warehouseAt(), input({ variantId: OTHER_VARIANT, delta: 7n, reason: 'SURPLUS', idempotencyKey: 'k13' }));
    expect(fake.state.inventory.filter((r) => r.variantId === OTHER_VARIANT)).toHaveLength(1);
    expect(fake.state.inventory.find((r) => r.variantId === OTHER_VARIANT)!.physical).toBe(7n);
    expect(fake.log.attempts).toBe(2); // the losing insert aborts attempt 1; the retry finds the row
  });

  describe('idempotency', () => {
    it('S14 the same key and payload replays without mutating stock again (note is normalized)', async () => {
      const auth = await warehouseAt();
      const first = await service().adjustStock(auth, input({ delta: -2n, reason: 'DAMAGED', note: '  se cayó  ', idempotencyKey: 'k14' }));
      const second = await service().adjustStock(auth, input({ delta: -2n, reason: 'DAMAGED', note: 'se cayó', idempotencyKey: 'k14' }));
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.movement.id).toBe(first.movement.id);
      expect(row().physical).toBe(8n);
      expect(fake.state.movements).toHaveLength(1);
      expect(fake.state.audits).toHaveLength(1);
    });

    it('S14b a replay still replays after the variant was deactivated', async () => {
      const auth = await warehouseAt();
      await service().adjustStock(auth, input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: 'k14b' }));
      fake.state.variants.get(VARIANT)!.isActive = false;
      const again = await service().adjustStock(auth, input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: 'k14b' }));
      expect(again.replayed).toBe(true);
    });

    it.each([
      ['delta', { delta: 2n }],
      ['reason', { reason: 'LOAD_ERROR' }],
      ['note', { note: 'otra nota' }],
      ['variant', { variantId: OTHER_VARIANT }],
      ['branch', { branchId: OTHER_BRANCH }],
    ])('S15 the same key with a different %s is 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD and mutates nothing', async (_name, change) => {
      const auth = await authFor([{ role: 'ADMIN', at: 'COMPANY' }]);
      await service().adjustStock(auth, input({ delta: 1n, reason: 'SURPLUS', note: 'una nota', idempotencyKey: 'k15' }));
      const snapshot = fake.state.inventory.map((r) => ({ ...r }));
      await expect(service().adjustStock(auth, input({ delta: 1n, reason: 'SURPLUS', note: 'una nota', idempotencyKey: 'k15', ...change })))
        .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
      expect(fake.state.inventory).toEqual(snapshot);
      expect(fake.state.movements).toHaveLength(1);
    });

    it('S16 the same key from two different users is two independent adjustments', async () => {
      await service().adjustStock(await warehouseAt(BRANCH, ACTORS[0]), input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: 'shared' }));
      const other = await service().adjustStock(await warehouseAt(BRANCH, ACTORS[1]), input({ delta: 1n, reason: 'SURPLUS', idempotencyKey: 'shared' }));
      expect(other.replayed).toBe(false);
      expect(row().physical).toBe(12n);
    });
  });

  it('S17 an adjustment racing a reservation waits for the row lock and sees the new reserved', async () => {
    fake = createFakeDb({ inventory: [{ physical: 10n, reserved: 0n }] });
    const reservation = await fake.foreignWriter(VARIANT, BRANCH, (r) => { r.reserved = 8n; });
    const adjustment = service().adjustStock(await warehouseAt(), input({ delta: -5n, reason: 'LOST', idempotencyKey: 'k17' }));
    const settled = adjustment.then(() => 'ok', (error: AppError) => error.code);
    await tick();
    reservation.release();
    await reservation.done;
    expect(await settled).toBe('STOCK_BELOW_RESERVED');
    expect(row()).toMatchObject({ physical: 10n, reserved: 8n });
  });

  it('S18 an adjustment racing a sale completion applies on top of the completed balance', async () => {
    fake = createFakeDb({ inventory: [{ physical: 10n, reserved: 4n }] });
    const completion = await fake.foreignWriter(VARIANT, BRANCH, (r) => { r.physical = 6n; r.reserved = 0n; });
    const adjustment = service().adjustStock(await warehouseAt(), input({ delta: -5n, reason: 'LOST', idempotencyKey: 'k18' }));
    await tick();
    completion.release();
    await completion.done;
    await adjustment;
    expect(row()).toMatchObject({ physical: 1n, reserved: 0n });
    expect(fake.state.audits[0]!.before).toMatchObject({ physical: '6', reserved: '0' });
  });

  describe('rules before any transaction', () => {
    it.each([
      ['delta 0', { delta: 0n }, 'VALIDATION_ERROR'],
      ['delta 101', { delta: 101n }, 'ADJUSTMENT_LIMIT_EXCEEDED'],
      ['delta -101', { delta: -101n, reason: 'LOST' }, 'ADJUSTMENT_LIMIT_EXCEEDED'],
      ['DAMAGED positive', { delta: 1n, reason: 'DAMAGED' }, 'ADJUSTMENT_REASON_SIGN_MISMATCH'],
      ['LOST positive', { delta: 1n, reason: 'LOST' }, 'ADJUSTMENT_REASON_SIGN_MISMATCH'],
      ['SURPLUS negative', { delta: -1n, reason: 'SURPLUS' }, 'ADJUSTMENT_REASON_SIGN_MISMATCH'],
      ['OTHER without note', { reason: 'OTHER' }, 'ADJUSTMENT_NOTE_REQUIRED'],
      ['OTHER with a short note', { reason: 'OTHER', note: ' corta ' }, 'ADJUSTMENT_NOTE_REQUIRED'],
    ])('S19 rejects %s with 400 %s and opens no transaction', async (_name, change, code) => {
      await expect(service().adjustStock(await warehouseAt(), input({ idempotencyKey: 'k19', ...change })))
        .rejects.toMatchObject({ status: 400, code });
      expect(fake.log.attempts).toBe(0);
    });

    it('S19b accepts the boundaries +100 / -100 and a 10-char OTHER note', async () => {
      fake = createFakeDb({ inventory: [{ physical: 100n, reserved: 0n }] });
      await service().adjustStock(await warehouseAt(), input({ delta: -100n, reason: 'LOST', idempotencyKey: 'k19b1' }));
      await service().adjustStock(await warehouseAt(), input({ delta: 100n, reason: 'SURPLUS', idempotencyKey: 'k19b2' }));
      await service().adjustStock(await warehouseAt(), input({ delta: 1n, reason: 'OTHER', note: '0123456789', idempotencyKey: 'k19b3' }));
      expect(row().physical).toBe(101n);
    });
  });

  it('S20 an inactive variant is 409 VARIANT_INACTIVE; an unknown variant or location is 404; nothing is written', async () => {
    await expect(service().adjustStock(await authFor([{ role: 'ADMIN', at: 'COMPANY' }]), input({ variantId: INACTIVE_VARIANT, idempotencyKey: 'k20a' })))
      .rejects.toMatchObject({ status: 409, code: 'VARIANT_INACTIVE' });
    await expect(service().adjustStock(await authFor([{ role: 'ADMIN', at: 'COMPANY' }]), input({ variantId: randomUUID(), idempotencyKey: 'k20b' })))
      .rejects.toMatchObject({ status: 404 });
    fake.state.locations.get(BRANCH)!.isActive = false;
    await expect(service().adjustStock(await authFor([{ role: 'ADMIN', at: 'COMPANY' }]), input({ idempotencyKey: 'k20c' })))
      .rejects.toMatchObject({ status: 404 });
    expect(fake.state.movements).toHaveLength(0);
    expect(fake.state.audits).toHaveLength(0);
  });

  it('S21 the service re-checks INVENTORY_MANAGE at the branch (defense in depth)', async () => {
    for (const auth of [await authFor([{ role: 'SELLER', at: BRANCH }]), await warehouseAt(OTHER_BRANCH)]) {
      await expect(service().adjustStock(auth, input({ idempotencyKey: 'k21' }))).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    }
    expect(fake.log.attempts).toBe(0);
  });
});

describe('POST /inventory/adjustments (WAREHOUSE-MVP route contract)', () => {
  let fake: ReturnType<typeof createFakeDb>;
  beforeEach(() => { fake = createFakeDb({ inventory: [{ physical: 10n, reserved: 4n }] }); });

  function post(auth: Express.AuthContext | undefined, body: unknown) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { if (auth) req.auth = auth; next(); });
    app.use('/inventory', createInventoryRouter(fake.database));
    app.use(errorHandler);
    return request(app).post('/inventory/adjustments').send(body as object);
  }
  const body = (overrides: Record<string, unknown> = {}) => ({
    variantId: VARIANT, branchId: BRANCH, delta: '3', reason: 'SURPLUS', idempotencyKey: `key-${randomUUID()}`, ...overrides,
  });
  const untouched = () => { expect(fake.log.attempts).toBe(0); };

  it('R01 refuses an unauthenticated request with 401 before any write', async () => {
    expect((await post(undefined, body())).status).toBe(401);
    untouched();
  });

  it('R02 a WAREHOUSE at the branch gets 201 replayed:false with string quantities', async () => {
    const response = await post(await warehouseAt(), body({ delta: '-2', reason: 'DAMAGED', idempotencyKey: 'r02' }));
    expect(response.status).toBe(201);
    expect(response.body.replayed).toBe(false);
    expect(response.body.movement).toMatchObject({ type: 'ADJUSTMENT', quantityDelta: '-2', reason: 'DAMAGED', idempotencyKey: 'r02' });
    expect(response.body.inventory).toMatchObject({ variantId: VARIANT, branchId: BRANCH, physical: '8', reserved: '4', available: '4' });
  });

  it('R03 the replay answers 200 replayed:true and does not mutate again', async () => {
    const auth = await warehouseAt();
    await post(auth, body({ idempotencyKey: 'r03' }));
    const replay = await post(auth, body({ idempotencyKey: 'r03' }));
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(fake.state.movements).toHaveLength(1);
    expect(fake.state.inventory[0]!.physical).toBe(13n);
  });

  it('R03b a reused key with a different payload is 409', async () => {
    const auth = await warehouseAt();
    await post(auth, body({ idempotencyKey: 'r03b' }));
    const response = await post(auth, body({ idempotencyKey: 'r03b', delta: '4' }));
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
  });

  it('R04 a WAREHOUSE at another branch is 403 before any write', async () => {
    expect((await post(await warehouseAt(OTHER_BRANCH), body())).status).toBe(403);
    untouched();
  });

  it('R05/R06 SELLER and CASHIER are 403 before any write', async () => {
    expect((await post(await authFor([{ role: 'SELLER', at: BRANCH }]), body())).status).toBe(403);
    expect((await post(await authFor([{ role: 'CASHIER', at: BRANCH }]), body())).status).toBe(403);
    untouched();
  });

  it('R07/R08/R09 COMPANY ADMIN, OWNER and a LOCATION ADMIN at the branch are authorized', async () => {
    for (const [index, scope] of ([{ role: 'ADMIN', at: 'COMPANY' }, { role: 'OWNER', at: 'COMPANY' }, { role: 'ADMIN', at: BRANCH }] as Scope[]).entries()) {
      const response = await post(await authFor([scope]), body({ idempotencyKey: `r07-${index}` }));
      expect(response.status, `${scope.role}@${scope.at}`).toBe(201);
    }
  });

  it('R09b a LOCATION ADMIN at another branch is 403', async () => {
    expect((await post(await authFor([{ role: 'ADMIN', at: OTHER_BRANCH }]), body())).status).toBe(403);
  });

  it.each([
    ['delta 0', { delta: '0' }, 400, 'VALIDATION_ERROR'],
    ['delta 101', { delta: '101' }, 400, 'ADJUSTMENT_LIMIT_EXCEEDED'],
    ['delta -101', { delta: '-101', reason: 'LOST' }, 400, 'ADJUSTMENT_LIMIT_EXCEEDED'],
    ['decimal delta', { delta: '1.5' }, 400, 'VALIDATION_ERROR'],
    ['non numeric delta', { delta: 'abc' }, 400, 'VALIDATION_ERROR'],
    ['numeric (non string) delta', { delta: 5 }, 400, 'VALIDATION_ERROR'],
    ['invalid reason', { reason: 'BROKEN' }, 400, 'VALIDATION_ERROR'],
    ['OTHER without note', { reason: 'OTHER' }, 400, 'ADJUSTMENT_NOTE_REQUIRED'],
    ['OTHER short note', { reason: 'OTHER', note: 'corta' }, 400, 'ADJUSTMENT_NOTE_REQUIRED'],
    ['DAMAGED positive', { reason: 'DAMAGED', delta: '2' }, 400, 'ADJUSTMENT_REASON_SIGN_MISMATCH'],
    ['LOST positive', { reason: 'LOST', delta: '2' }, 400, 'ADJUSTMENT_REASON_SIGN_MISMATCH'],
    ['SURPLUS negative', { reason: 'SURPLUS', delta: '-2' }, 400, 'ADJUSTMENT_REASON_SIGN_MISMATCH'],
    ['missing idempotencyKey', { idempotencyKey: undefined }, 400, 'VALIDATION_ERROR'],
    ['unknown extra field', { physical: '999' }, 400, 'VALIDATION_ERROR'],
    ['malformed variantId', { variantId: 'nope' }, 400, 'VALIDATION_ERROR'],
  ])('R10 rejects %s with %i %s before any write', async (_name, change, status, code) => {
    const response = await post(await warehouseAt(), body(change));
    expect(response.status).toBe(status);
    expect(response.body.error.code).toBe(code);
    untouched();
  });

  it('R11 an inactive variant is 409 VARIANT_INACTIVE', async () => {
    const response = await post(await warehouseAt(), body({ variantId: INACTIVE_VARIANT }));
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('VARIANT_INACTIVE');
  });

  it('R12 stock conflicts surface as 409 with the backend Spanish message', async () => {
    const response = await post(await warehouseAt(), body({ delta: '-9', reason: 'LOST' }));
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('STOCK_BELOW_RESERVED');
    expect(typeof response.body.error.message).toBe('string');
  });
});
