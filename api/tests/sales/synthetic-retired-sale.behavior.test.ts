// PILOT synthetic retirement (OWNER decision 2026-10-19, "cancelar con pago retenido") — DB-FREE.
// The REAL services run against tests/helpers/in-memory-sales-db.ts; nothing reaches a database.
//
// The state is produced with the real code: a real send-to-cashier hold, a real PARTIAL cash payment
// (payments.service.ts: SALE_INCOME in the open session), the session then closed, and the retirement
// writes exactly as scripts/database/pilot-local1-synthetic-retire.mjs performs them (the canonical
// releaseReservations under the Sale → StockReservation locks, PENDING_PAYMENT → CANCELLED, the
// SALE_CANCELLED and PILOT_SYNTHETIC_DATA_RETIREMENT audits). Then every normal operation is asked
// about that CANCELLED sale with a retained payment:
//
//   X1 cashier work queue (GET /sales/pending)      -> never lists it
//   X2 a new payment                                -> 409 INVALID_SALE_STATE, nothing written
//   X3 a replayed payment key                       -> the existing row only, nothing written
//   X4 completion                                   -> 409 INVALID_SALE_STATE, no stock moves
//   X5 the canonical cancel                         -> refused (payment accepted), nothing written
//   X6 the expired-hold release                     -> NOT_PENDING, nothing written
//   X7 the dashboard queries                        -> pending = PENDING_PAYMENT only; revenue = PAID/COMPLETED only
//   X8 history                                      -> SalePayment and its SALE_INCOME (closed session) untouched;
//                                                      physical stock untouched, reserved released exactly
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { createAuditLog } from '../../src/shared/audit.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createSalesService } from '../../src/modules/sales/sales.service.js';
import { createCancellationService, releaseReservations } from '../../src/modules/sales/cancellation.service.js';
import { createPaymentsService } from '../../src/modules/payments/payments.service.js';
import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';

const L1 = '11111111-1111-4111-8111-111111111111';
type Role = 'SELLER' | 'CASHIER';
const assignment = (role: Role): Express.ProductionAssignment => ({
  roleId: role, roleCode: role, scopeKind: 'LOCATION', locationId: L1, permissions: [...DEFAULT_ROLE_GRANTS[role]],
});
const requestFor = (userId: string, role: Role) => ({
  auth: { userId, roles: [role], assignments: [assignment(role)], effectiveLocationIds: [L1] },
}) as unknown as Request;

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected AppError ${status} ${code}`).toBeInstanceOf(AppError);
  expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status, code });
}

async function retiredWorld() {
  const db = createInMemorySalesDb();
  db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  db.insert('location', { id: L1, isActive: true });
  db.insert('branch', { id: L1, code: 'S1', name: 'Sucursal 1' });
  db.insert('saleNumberCounter', { branchId: L1, nextValue: 1n });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), cashier: user('cashier'), owner: user('owner') };
  const product = db.insert('product', { name: 'Buzo PILOT', isActive: true }).id as string;
  const variantId = db.insert('productVariant', {
    productId: product, sku: 'PILOT-BUZO-GRI-L', barcode: 'PILOT-BC-0013', cashPrice: 3500000n, price: 3500000n, wholesalePrice: null,
    costPrice: 1600000n, color: 'Gris', size: 'L',
  }).id as string;
  db.insert('inventory', { branchId: L1, variantId, physical: 4n, reserved: 0n });
  const registerId = db.insert('cashRegister', { branchId: L1, name: 'Caja 1' }).id as string;
  const sessionId = db.insert('cashSession', { registerId, status: 'OPEN', startingCash: 0n, openedById: ids.cashier }).id as string;
  const client = db.client as unknown as PrismaClient;
  const sales = createSalesService(client, { proportionalCheckoutLocationIds: [] });
  const payments = createPaymentsService(client);
  const cancellation = createCancellationService(client);
  const seller = requestFor(ids.seller, 'SELLER');
  const cashier = requestFor(ids.cashier, 'CASHIER');

  // the observed PILOT shape, built by the real services
  const created = await sales.createDraftSale(seller, ids.seller, L1);
  await sales.addItem(seller, ids.seller, created.id, { variantId, quantity: 1n });
  await sales.sendToCashier(created.id, ids.seller, [L1]);
  const paymentKey = randomUUID();
  await payments.registerPayment(cashier, ids.cashier, created.id, { method: 'CASH', amount: 1000000n, receivedAmount: 1000000n, idempotencyKey: paymentKey });
  db.table('cashSession').find((row) => row.id === sessionId)!.status = 'CLOSED';
  const saleId = created.id;
  expect(db.table('sale').find((row) => row.id === saleId)!.status).toBe('PENDING_PAYMENT');
  // non-vacuous: before the retirement the paid-pending sale IS in the cashier queue
  const queued = await sales.listPendingSales([L1], (cashier as unknown as { auth: Express.AuthContext }).auth);
  expect(queued.map((row: { saleId: string }) => row.saleId)).toContain(saleId);

  // the retirement writes, exactly as the tool performs them
  await client.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ id: string; branchId: string; status: string }>>`SELECT id, "branchId", status FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
    const holds = await tx.$queryRaw<Array<{ id: string; variantId: string; branchId: string; quantity: bigint; status: string; expiresAt: Date }>>`
      SELECT id, "variantId", "branchId", quantity, status, "expiresAt" FROM "StockReservation" WHERE "saleId" = ${saleId} ORDER BY id ASC FOR UPDATE`;
    const released = await releaseReservations(tx, locked as never, holds as never);
    const cancelled = await tx.sale.updateMany({ where: { id: saleId, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
    expect(cancelled.count).toBe(1);
    await createAuditLog(tx, { userId: ids.owner, branchId: L1, action: 'SALE_CANCELLED', entityType: 'Sale', entityId: saleId,
      before: { status: 'PENDING_PAYMENT' }, after: { status: 'CANCELLED', reason: 'OTHER', note: 'PILOT_SYNTHETIC_DATA_RETIREMENT', released } });
    await createAuditLog(tx, { userId: ids.owner, branchId: L1, action: 'PILOT_SYNTHETIC_DATA_RETIREMENT', entityType: 'Sale', entityId: saleId,
      after: { reason: 'PILOT_SYNTHETIC_DATA_RETIREMENT', status: 'CANCELLED' } });
  });

  const rows = () => ({
    payments: structuredClone(db.table('salePayment')), cash: structuredClone(db.table('cashMovement')),
    stock: structuredClone(db.table('stockMovement')), reservations: structuredClone(db.table('stockReservation')),
    inventory: structuredClone(db.table('inventory')), sales: structuredClone(db.table('sale')),
  });
  return { db, ids, saleId, variantId, sessionId, paymentKey, sales, payments, cancellation, seller, cashier, rows };
}

describe('X — a retired (CANCELLED, payment retained) synthetic sale is never active or collectable again', () => {
  it('X1 the cashier work queue never lists it', async () => {
    const w = await retiredWorld();
    const queue = await w.sales.listPendingSales([L1], (w.cashier as unknown as { auth: Express.AuthContext }).auth);
    expect(queue.map((row: { saleId: string }) => row.saleId)).not.toContain(w.saleId);
  });

  it('X2 a new payment is refused with INVALID_SALE_STATE and writes nothing', async () => {
    const w = await retiredWorld();
    const before = w.rows();
    await expectAppError(w.payments.registerPayment(w.cashier, w.ids.cashier, w.saleId,
      { method: 'CASH', amount: 2500000n, receivedAmount: 2500000n, idempotencyKey: randomUUID() }), 409, 'INVALID_SALE_STATE');
    expect(w.rows()).toEqual(before);
  });

  it('X3 replaying the original payment key returns the existing row and writes nothing', async () => {
    const w = await retiredWorld();
    const before = w.rows();
    const replay = await w.payments.registerPayment(w.cashier, w.ids.cashier, w.saleId,
      { method: 'CASH', amount: 1000000n, receivedAmount: 1000000n, idempotencyKey: w.paymentKey });
    expect(replay.replayed).toBe(true);
    expect(replay.resultingStatus).toBe('CANCELLED');
    expect(w.rows()).toEqual(before);
  });

  it('X4 completion is refused (only a PAID sale completes) and no stock moves', async () => {
    const w = await retiredWorld();
    const before = w.rows();
    await expectAppError(w.sales.completeSale(w.cashier, w.ids.cashier, w.saleId), 409, 'INVALID_SALE_STATE');
    expect(w.rows()).toEqual(before);
  });

  it('X5 the canonical cancel refuses it (a payment was accepted) and writes nothing', async () => {
    const w = await retiredWorld();
    const before = w.rows();
    await expectAppError(w.cancellation.cancelSale(w.cashier, w.saleId, { reason: 'OTHER', note: 'x' }), 409, 'PAYMENT_ALREADY_ACCEPTED');
    expect(w.rows()).toEqual(before);
  });

  it('X6 the expired-hold release treats it as not pending and writes nothing', async () => {
    const w = await retiredWorld();
    const before = w.rows();
    const outcome = await w.cancellation.releaseExpiredSaleHolds(w.saleId, { actor: { kind: 'SYSTEM' } as never, now: new Date(Date.now() + 86_400_000) });
    expect(outcome).toEqual({ outcome: 'NOT_PENDING', saleId: w.saleId });
    expect(w.rows()).toEqual(before);
  });

  it('X7 the dashboard counts pending as PENDING_PAYMENT only and revenue as PAID/COMPLETED only', () => {
    const source = readFileSync(new URL('../../src/modules/backoffice/backoffice.service.ts', import.meta.url), 'utf8');
    expect(source).toContain("database.sale.count({ where: { branchId: { in: branchIds }, status: 'PENDING_PAYMENT' } })");
    expect(source).toMatch(/where: \{ \.\.\.todayWhere, status: \{ in: \['PAID', 'COMPLETED'\] \} \},\s*_sum: \{ total: true \}/);
    const queue = readFileSync(new URL('../../src/modules/sales/sales.service.ts', import.meta.url), 'utf8');
    expect(queue).toContain("where: { status: { in: ['PENDING_PAYMENT', 'PAID'] }, branchId: { in: branchIds } }");
  });

  it('X8 history is retained: the payment, its SALE_INCOME in the CLOSED session, physical stock; the hold released exactly', async () => {
    const w = await retiredWorld();
    const payment = w.db.table('salePayment').filter((row) => row.saleId === w.saleId);
    expect(payment).toHaveLength(1);
    expect(payment[0]).toMatchObject({ method: 'CASH', amount: 1000000n, cashSessionId: w.sessionId });
    const income = w.db.table('cashMovement').filter((row) => row.salePaymentId === payment[0]!.id);
    expect(income).toHaveLength(1);
    expect(income[0]).toMatchObject({ type: 'SALE_INCOME', amount: 1000000n, sessionId: w.sessionId });
    expect(w.db.table('cashSession').find((row) => row.id === w.sessionId)!.status).toBe('CLOSED');
    expect(w.db.table('stockReservation').filter((row) => row.saleId === w.saleId).map((row) => row.status)).toEqual(['RELEASED']);
    expect(w.db.table('inventory').find((row) => row.variantId === w.variantId)).toMatchObject({ physical: 4n, reserved: 0n });
    expect(w.db.table('stockMovement')).toHaveLength(0);
    expect(w.db.table('auditLog').filter((row) => row.entityId === w.saleId).map((row) => row.action))
      .toEqual(expect.arrayContaining(['SALE_CANCELLED', 'PILOT_SYNTHETIC_DATA_RETIREMENT']));
    // the payment's own audit (entity SalePayment) is history too, untouched
    expect(w.db.table('auditLog').filter((row) => row.entityId === payment[0]!.id).map((row) => row.action)).toEqual(['PAYMENT_REGISTERED']);
  });
});
