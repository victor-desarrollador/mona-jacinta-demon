// DB-FREE structural coverage for DRAFT item removal. The in-memory store
// executes transactions serially, so PostgreSQL row-lock interleavings still
// require a LOCAL_TEST proof; these tests pin the service-level lock contract.
//
// PRE-REGISTERED EXPECTATIONS (2026-10-07):
//   R01 remove existing item from DRAFT -> ALLOW
//   R02 remove nonexistent item -> NOT_FOUND
//   R03 remove item belonging to another Sale -> NOT_FOUND / no cross-sale deletion
//   R04 remove after Sale is PENDING_PAYMENT -> DENY SALE_NOT_DRAFT
//   R05 remove after Sale is COMPLETED -> DENY SALE_NOT_DRAFT
//   R06 send-to-cashier wins Sale lock first, then remove -> SERIALIZE_TRANSITION_FIRST
//   R07 remove wins Sale lock first, then send -> SERIALIZE_REMOVE_FIRST
//   R08 remove last item then send -> DENY EMPTY_SALE
//   R09 remove one of multiple variants then send -> ALLOW exact remaining reservations
//   R10 updateItem/removeItem same Sale -> SERIALIZE through Sale FOR UPDATE (structural)
//   R11 price-mode/wholesale/remove same Sale -> SERIALIZE through Sale FOR UPDATE (structural)
//   R12 unauthorized seller remove -> DENY before mutation
//   R13 removeItem emits Sale FOR UPDATE before mutation -> SERIALIZE contract
//   R14 removeItem re-reads the SaleItem inside the transaction -> NO_SIDE_EFFECT on mismatch
//   R15 adjacent mutation/transition lock contracts remain present -> SERIALIZE contract
import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { createWholesaleCodeVerifier } from '../../src/modules/sales/wholesale-authorization.service.js';
import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';

const CODE = 'Mayor-2026';
const CODE_HASH = await hash(CODE, 4);

function assignment(roleCode: 'SELLER' | 'CASHIER', locationId: string): Express.ProductionAssignment {
  return {
    roleId: roleCode,
    roleCode,
    scopeKind: 'LOCATION',
    locationId,
    permissions: [...DEFAULT_ROLE_GRANTS[roleCode]],
  };
}

function requestFor(userId: string, assignments: Express.ProductionAssignment[]): Request {
  const effectiveLocationIds = assignments.map(({ locationId }) => locationId).filter((id): id is string => id !== null);
  return { auth: { userId, roles: assignments.map(({ roleCode }) => roleCode), assignments, effectiveLocationIds } } as unknown as Request;
}

function setup() {
  const db = createInMemorySalesDb();
  db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  const branchId = db.insert('location', { isActive: true }).id as string;
  db.insert('branch', { id: branchId, code: 'S1', name: 'Sucursal 1' });
  db.insert('saleNumberCounter', { branchId, nextValue: 1n });
  const sellerId = db.insert('user', { name: 'seller', email: 'seller@test.invalid', isActive: true }).id as string;
  const otherSellerId = db.insert('user', { name: 'seller2', email: 'seller2@test.invalid', isActive: true }).id as string;
  const productId = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const variant = (sku: string, cashPrice: bigint, wholesalePrice: bigint | null = cashPrice) =>
    db.insert('productVariant', { productId, sku, barcode: sku, cashPrice, price: cashPrice, wholesalePrice, costPrice: 1000n, color: 'Negro', size: sku }).id as string;
  const firstVariantId = variant('V1', 10000n, 7000n);
  const secondVariantId = variant('V2', 5000n, 3000n);
  for (const variantId of [firstVariantId, secondVariantId]) db.insert('inventory', { branchId, variantId, physical: 100n, reserved: 0n });
  const reqs = {
    seller: requestFor(sellerId, [assignment('SELLER', branchId)]),
    otherSeller: requestFor(otherSellerId, [assignment('SELLER', branchId)]),
  };
  const client = db.client as unknown as PrismaClient;
  const sales = createSalesService(client, { wholesaleVerifier: createWholesaleCodeVerifier(CODE_HASH) });
  async function draft(items: Array<[string, bigint]> = [[firstVariantId, 1n]]) {
    const sale = await sales.createDraftSale(reqs.seller, sellerId, branchId);
    for (const [variantId, quantity] of items) await sales.addItem(reqs.seller, sellerId, sale.id, { variantId, quantity });
    return sale.id;
  }
  const sale = (saleId: string) => db.table('sale').find((row) => row.id === saleId)!;
  const items = (saleId: string) => db.table('saleItem').filter((row) => row.saleId === saleId);
  const firstItem = (saleId: string) => items(saleId)[0]!;
  return { db, branchId, sellerId, otherSellerId, reqs, sales, firstVariantId, secondVariantId, draft, sale, items, firstItem };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected AppError ${status} ${code}`).toBeInstanceOf(AppError);
  expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status, code });
}

function saleLocks(rawQueries: string[]) {
  return rawQueries.filter((query) => /FROM "Sale"\s+WHERE id = \? FOR UPDATE/.test(query));
}

describe('Sale item removal concurrency contract — DB-free', () => {
  it('R01/R13 removes an existing DRAFT item only after taking the Sale row lock', async () => {
    const t = setup();
    const saleId = await t.draft([[t.firstVariantId, 2n], [t.secondVariantId, 1n]]);
    const removed = t.firstItem(saleId);
    const lockCountBefore = saleLocks(t.db.rawQueries).length;

    const updated = await t.sales.removeItem(t.reqs.seller, t.sellerId, saleId, removed.id as string);

    expect(saleLocks(t.db.rawQueries)).toHaveLength(lockCountBefore + 1);
    expect(t.items(saleId)).toHaveLength(1);
    expect(t.items(saleId)[0]).toMatchObject({ variantId: t.secondVariantId, subtotal: 5000n });
    expect(updated).toMatchObject({ id: saleId, total: 5000n, subtotal: 5000n });
  });

  it('R02/R03 rejects missing or cross-sale items without deleting from another Sale', async () => {
    const t = setup();
    const saleA = await t.draft([[t.firstVariantId, 1n]]);
    const saleB = await t.draft([[t.secondVariantId, 1n]]);
    const otherItem = t.firstItem(saleB);

    await expectAppError(t.sales.removeItem(t.reqs.seller, t.sellerId, saleA, randomUUID()), 404, 'NOT_FOUND');
    await expectAppError(t.sales.removeItem(t.reqs.seller, t.sellerId, saleA, otherItem.id as string), 404, 'NOT_FOUND');

    expect(t.items(saleA)).toHaveLength(1);
    expect(t.items(saleB)).toHaveLength(1);
  });

  it('R04/R05/R06 rejects non-DRAFT removals and leaves items, totals and reservations unchanged', async () => {
    const t = setup();
    const saleId = await t.draft([[t.firstVariantId, 1n]]);
    await t.sales.sendToCashier(saleId, t.sellerId, [t.branchId]);
    const itemId = t.firstItem(saleId).id as string;

    await expectAppError(t.sales.removeItem(t.reqs.seller, t.sellerId, saleId, itemId), 409, 'SALE_NOT_DRAFT');
    expect(t.items(saleId)).toHaveLength(1);
    expect(t.sale(saleId)).toMatchObject({ status: 'PENDING_PAYMENT', total: 10000n });
    expect(t.db.table('stockReservation')).toEqual([expect.objectContaining({ saleId, variantId: t.firstVariantId, quantity: 1n, status: 'ACTIVE' })]);

    t.sale(saleId).status = 'COMPLETED';
    await expectAppError(t.sales.removeItem(t.reqs.seller, t.sellerId, saleId, itemId), 409, 'SALE_NOT_DRAFT');
  });

  it('R07/R08/R09 send-to-cashier observes the post-remove item set exactly', async () => {
    const t = setup();
    const saleId = await t.draft([[t.firstVariantId, 2n], [t.secondVariantId, 1n]]);
    await t.sales.removeItem(t.reqs.seller, t.sellerId, saleId, t.firstItem(saleId).id as string);

    await t.sales.sendToCashier(saleId, t.sellerId, [t.branchId]);

    expect(t.sale(saleId)).toMatchObject({ status: 'PENDING_PAYMENT', total: 5000n });
    expect(t.db.table('stockReservation')).toEqual([expect.objectContaining({ saleId, variantId: t.secondVariantId, quantity: 1n, status: 'ACTIVE' })]);

    const empty = await t.draft([[t.firstVariantId, 1n]]);
    await t.sales.removeItem(t.reqs.seller, t.sellerId, empty, t.firstItem(empty).id as string);
    await expectAppError(t.sales.sendToCashier(empty, t.sellerId, [t.branchId]), 409, 'EMPTY_SALE');
  });

  it('R10/R11/R15 uses the same Sale FOR UPDATE contract as adjacent item, price-mode and wholesale mutations', async () => {
    const t = setup();
    const saleId = await t.draft([[t.firstVariantId, 1n], [t.secondVariantId, 1n]]);
    const itemId = t.firstItem(saleId).id as string;
    const before = saleLocks(t.db.rawQueries).length;

    await t.sales.updateItem(t.reqs.seller, t.sellerId, saleId, itemId, { quantity: 2n });
    await t.sales.updatePriceMode(t.reqs.seller, t.sellerId, saleId, 'LIST');
    await t.sales.activateWholesale(t.reqs.seller, t.sellerId, saleId, CODE);
    await t.sales.removeItem(t.reqs.seller, t.sellerId, saleId, itemId);

    expect(saleLocks(t.db.rawQueries).length - before).toBe(4);
  });

  it('R12 denies another seller before mutation', async () => {
    const t = setup();
    const saleId = await t.draft([[t.firstVariantId, 1n]]);
    const itemId = t.firstItem(saleId).id as string;

    await expectAppError(t.sales.removeItem(t.reqs.otherSeller, t.otherSellerId, saleId, itemId), 403, 'FORBIDDEN');

    expect(t.items(saleId)).toHaveLength(1);
    expect(t.sale(saleId).total).toBe(10000n);
  });
});
