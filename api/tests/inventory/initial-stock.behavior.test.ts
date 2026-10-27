// D3 initial stock load — retries and isolation (H-01 / H-02 of the second audit). DB-FREE: a fake $transaction records the options it receives and
// injects the failures; the REAL service runs on top.
//   - the operation runs in ONE Serializable transaction (H-02);
//   - a transient failure in every shape the driver stack produces is retried, at most 3 attempts, then 409 CONCURRENCY_ERROR (shared classifier);
//   - P2002 is retried ONLY for the exact constraint this flow expects: Inventory_variantId_branchId_key (the first Inventory row of a (variant, branch)
//     created concurrently). Any other P2002 is neither retried nor translated: it reaches the caller unchanged.
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { createInitialStockService } from '../../src/modules/inventory/initial-stock.service.js';
import { AppError } from '../../src/shared/errors.js';

const INPUT = { variantId: '00000000-0000-4000-8000-000000000001', branchId: '00000000-0000-4000-8000-000000000002', quantity: 10n };
type Options = { isolationLevel?: string; timeout?: number };

function world(failures: Array<Record<string, unknown>> = []) {
  const pending = [...failures];
  const calls: Options[] = [];
  const writes: string[] = [];
  const tx = {
    productVariant: { findUnique: async () => ({ id: INPUT.variantId }) },
    branch: { findUnique: async () => ({ id: INPUT.branchId }) },
    location: { findUnique: async () => ({ isActive: true }) },
    inventory: {
      upsert: async () => ({}),
      update: async () => { writes.push('inventory.update'); return { id: 'inv-1', variantId: INPUT.variantId, branchId: INPUT.branchId, physical: 15n, reserved: 0n }; },
    },
    $queryRaw: async () => [{ id: 'inv-1', physical: 5n, reserved: 0n }],
    stockMovement: { create: async () => { writes.push('stockMovement.create'); return { id: 'mov-1', type: 'INITIAL_STOCK', quantityDelta: 10n }; } },
    auditLog: { create: async () => { writes.push('auditLog.create'); return {}; } },
  };
  const db = {
    $transaction: async (operation: (t: unknown) => Promise<unknown>, options?: Options) => {
      calls.push({ ...options });
      const failure = pending.shift();
      if (failure) throw Object.assign(new Error('driver failure'), failure);
      return operation(tx);
    },
  } as unknown as PrismaClient;
  return { service: createInitialStockService(db), calls, writes };
}
const adapter = (originalCode: string) => ({ code: 'P2010', meta: { driverAdapterError: { cause: { originalCode } } } });
const p2002 = (index: string, modelName = 'Inventory') => ({ code: 'P2002', meta: { modelName, driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', originalCode: '23505', constraint: { index } } } } });

describe('initial stock — Serializable (H-02)', () => {
  it('IS01 the whole load runs in ONE transaction with isolationLevel Serializable', async () => {
    const w = world();
    const result = await w.service.loadInitialStock('user-1', INPUT);
    expect(result.inventory.physical).toBe(15n);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.isolationLevel).toBe('Serializable');
    expect(w.writes).toEqual(['inventory.update', 'stockMovement.create', 'auditLog.create']);
  });
});

describe('initial stock — transient failures (H-01)', () => {
  it.each([
    ['P2034', { code: 'P2034' }],
    ['SQLSTATE 40001 as meta.code', { code: 'P2010', meta: { code: '40001' } }],
    ['adapter originalCode 40001', adapter('40001')],
    ['adapter originalCode 40P01', adapter('40P01')],
    ['adapter cause.code 40001', { meta: { driverAdapterError: { cause: { code: '40001' } } } }],
    ['adapter kind TransactionWriteConflict', { meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } } }],
    ['cause chain -> P2034', { cause: { code: 'P2034' } }],
  ])('IS02 %s is retried (Serializable each time) and the load is applied once', async (_label, failure) => {
    const w = world([failure]);
    await w.service.loadInitialStock('user-1', INPUT);
    expect(w.calls).toHaveLength(2);
    expect(w.calls.every((c) => c.isolationLevel === 'Serializable')).toBe(true);
    expect(w.writes).toEqual(['inventory.update', 'stockMovement.create', 'auditLog.create']);
  });

  it('IS03 three transient failures -> 409 CONCURRENCY_ERROR after exactly 3 attempts, nothing written, no driver detail', async () => {
    const secret = { code: 'P2010', meta: { driverAdapterError: { cause: { originalCode: '40001', message: 'SECRET-DRIVER-DETAIL' } } } };
    const w = world([secret, secret, secret]);
    const error = await w.service.loadInitialStock('user-1', INPUT).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(AppError);
    expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status: 409, code: 'CONCURRENCY_ERROR' });
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain('SECRET-DRIVER-DETAIL');
    expect(w.calls).toHaveLength(3);
    expect(w.writes).toEqual([]);
  });
});

describe('initial stock — P2002 only for the constraint this flow expects', () => {
  it.each([
    ['adapter-pg: the exact index name', p2002('Inventory_variantId_branchId_key')],
    ['Prisma engine: meta.target = the column list', { code: 'P2002', meta: { modelName: 'Inventory', target: ['variantId', 'branchId'] } }],
  ])('IS04 the Inventory (variantId, branchId) race (%s) is retried and the load then succeeds', async (_label, failure) => {
    const w = world([failure]);
    await w.service.loadInitialStock('user-1', INPUT);
    expect(w.calls).toHaveLength(2);
  });

  it.each([
    ['another constraint of another table (adapter-pg)', p2002('User_email_key', 'User')],
    ['another constraint of Inventory', p2002('Inventory_pkey')],
    ['the same index name on another model', p2002('Inventory_variantId_branchId_key', 'StockMovement')],
    ['a P2002 that names nothing', { code: 'P2002', meta: {} }],
    ['a different column list', { code: 'P2002', meta: { modelName: 'Inventory', target: ['id'] } }],
  ])('IS05 %s is NOT retried and NOT translated: it reaches the caller unchanged after one attempt', async (_label, failure) => {
    const w = world([failure]);
    const error = await w.service.loadInitialStock('user-1', INPUT).then(() => null, (cause: unknown) => cause);
    expect(error).not.toBeNull();
    expect(error).not.toBeInstanceOf(AppError);
    expect((error as { code?: string }).code).toBe('P2002');
    expect(w.calls).toHaveLength(1);
  });

  it('IS06 a non-transient, non-unique error is not retried either', async () => {
    const w = world([{ code: 'P2025' }]);
    await expect(w.service.loadInitialStock('user-1', INPUT)).rejects.toMatchObject({ code: 'P2025' });
    expect(w.calls).toHaveLength(1);
  });
});
