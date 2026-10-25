// Sale void v1 — post-payment void (PAID | COMPLETED -> CANCELLED): RED behavior contract.
//
// DB-FREE: the REAL service (not written yet) runs against tests/helpers/in-memory-sales-db.ts
// (`withSaleVoid`), so no query reaches a database. Race interleavings, PostgreSQL constraints and
// real rollback are in tests/sales/sale-void.pg.test.ts; the drawer arithmetic is in
// tests/cash/sale-refund-reconciliation.test.ts; the schema surface in sale-void-schema.static.test.ts.
//
// WHY EACH TEST FAILS TODAY: src/modules/sales/sale-void.service.ts does not exist. The module is
// loaded lazily INSIDE each test (never a static import), so every test fails on its own with the
// explicit "sale-void service is not implemented" message — not on a broken import of the file.
// The harness sanity tests (H01..H05) test the FIXTURES and pass today.
//
// OWNER DECISIONS pinned here (sale-void-v1):
//   1. States: PAID | COMPLETED only. DRAFT, PENDING_PAYMENT, CANCELLED -> 409 INVALID_SALE_STATE.
//      The pre-payment POST /:saleId/cancel stays separate and untouched.
//   2. Stock follows the REAL lifecycle (finalizePaidSaleInTransaction):
//        PAID      = ACTIVE StockReservation + Inventory.reserved; physical NOT yet consumed
//                    -> release the holds, reserved decremented, physical untouched, NO StockMovement.
//        COMPLETED = physical consumed + StockMovement SALE (negative)
//                    -> physical incremented from those SALE rows, reserved untouched,
//                       append-only StockMovement SALE_VOID (+delta, saleVoidId); SALE rows never deleted.
//   3. Supervisor = actsAsSupervisorAtLocation (OWNER, or ADMIN with a COMPANY scope) AND the dedicated
//      SALE_VOID permission. CASHIER / SELLER / WAREHOUSE / LOCATION-scoped ADMIN: 403.
//   4. reason: required, trimmed, 1..200. idempotencyKey: UUID v4.
//   5. Idempotency (resolved against the sale's single SaleVoid): same key + same payload -> replay;
//      same key + different payload -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD;
//      another key after the sale was voided -> 409 SALE_ALREADY_VOIDED.
//   6. CASH: a CashSession that is not OPEN is NEVER written to. A sale with CASH payments needs
//      `cashSessionId` = an OPEN session of the SAME branch (the session where it was collected if that
//      is still OPEN, or a later one). One append-only CashMovement SALE_REFUND per CASH payment
//      (amount = the payment's net amount, linked through refundOfSalePaymentId — name provisional),
//      salePaymentId stays null, SALE_INCOME and SalePayment are never deleted or edited.
//      The refund may not exceed the projected drawer (409 INSUFFICIENT_CASH_IN_DRAWER, the cash-exit rule —
//      PROPOSED here; OWNER to confirm).
//      A sale without CASH does not require cashSessionId.
//   7. TRANSFER / CARD_DEBIT / CARD_CREDIT / QR: SalePayment and ExternalCollection are NEVER deleted or
//      edited, and the collection is NOT auto-marked REFUNDED. The money went back outside the POS, so the
//      void needs EXPLICIT evidence per external payment (`externalRefunds`), kept in the audit and the
//      result; a payment is reported refundPerformed:true only with that evidence.
//   8. One transaction, Serializable, retried on P2034 / 40001 / 40P01 (3 attempts), then 409 CONCURRENCY_ERROR.
//   9. Lock order (compatible with payments, finalization, cancellation, cash close and checkout):
//        Sale -> CashSession (only if a CASH payment exists) -> StockReservation (PAID) -> Inventory.
//  10. AuditLog SALE_VOIDED in the same transaction, with actor, branch, states, reason, idempotencyKey,
//      stock, payments, cash refunded + movements, external evidence.
//
// CONTRACT NAMES chosen here (the implementation may refine them; then these tests follow):
//   src/modules/sales/sale-void.service.ts
//     createSaleVoidService(database).voidSale(req, saleId, input) -> VoidResult   (types below)
//   src/modules/sales/dto/void-sale.dto.ts   voidSaleDto (strict)
//   error codes: 403 FORBIDDEN, 404 NOT_FOUND, 400 VALIDATION_ERROR, 409 INVALID_SALE_STATE,
//     SALE_ALREADY_VOIDED, IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD, CASH_SESSION_REQUIRED,
//     CASH_SESSION_ALREADY_CLOSED (existing), CASH_SESSION_BRANCH_MISMATCH (existing),
//     INSUFFICIENT_CASH_IN_DRAWER (existing), SALE_REFUND_ALREADY_RECORDED, EXTERNAL_REFUND_EVIDENCE_REQUIRED,
//     EXTERNAL_REFUND_PAYMENT_MISMATCH, SALE_VOID_STOCK_INCONSISTENT, CONCURRENCY_ERROR (existing).
//   NOT decided here: the SALE_VOID_ENABLED rollout flag (no test pins it).
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { reconcileCashSession } from '../../src/modules/cash/cash.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';

type Row = Record<string, unknown>;
type VoidInput = {
  reason: string;
  idempotencyKey: string;
  cashSessionId?: string;
  externalRefunds?: Array<{ salePaymentId: string; evidence: string }>;
};
type VoidResult = {
  saleId: string;
  branchId: string;
  status: 'CANCELLED';
  voidId: string;
  previousStatus: 'PAID' | 'COMPLETED';
  replayed: boolean;
  stockReturned: Array<{ variantId: string; inventoryId: string; quantity: bigint }>;
  reservationsReleased: Array<{ variantId: string; quantity: bigint }>;
  cashRefund: null | { cashSessionId: string; total: bigint; movements: Array<{ id: string; salePaymentId: string; amount: bigint }> };
  externalRefunds: Array<{ salePaymentId: string; method: string; amount: bigint; evidence: string; refundPerformed: true }>;
};
type VoidService = { voidSale: (req: Request, saleId: string, input: VoidInput) => Promise<VoidResult> };

// Lazy on purpose: while the module does not exist EACH test fails on its own, with a clear message.
async function loadService(client: PrismaClient): Promise<VoidService> {
  let mod: { createSaleVoidService?: (database: PrismaClient) => VoidService };
  try {
    mod = (await import('../../src/modules/sales/sale-void.service.js')) as typeof mod;
  } catch {
    throw new Error('sale-void service is not implemented: src/modules/sales/sale-void.service.ts does not exist yet');
  }
  if (typeof mod.createSaleVoidService !== 'function') throw new Error('sale-void service is not implemented: createSaleVoidService is not exported');
  return mod.createSaleVoidService(client);
}
async function loadDto() {
  try {
    const mod = (await import('../../src/modules/sales/dto/void-sale.dto.js')) as {
      voidSaleDto?: { safeParse: (input: unknown) => { success: boolean; data?: Row } };
    };
    if (!mod.voidSaleDto) throw new Error('missing export');
    return mod.voidSaleDto;
  } catch {
    throw new Error('sale-void DTO is not implemented: src/modules/sales/dto/void-sale.dto.ts does not exist yet');
  }
}

type Role = 'CASHIER' | 'SELLER' | 'WAREHOUSE' | 'ADMIN';
const locationAssignment = (role: Role, locationId: string, permissions?: string[]): Express.ProductionAssignment => ({
  roleId: `${role}-${locationId}`, roleCode: role, scopeKind: 'LOCATION', locationId, permissions: permissions ?? [...DEFAULT_ROLE_GRANTS[role]],
});
const companyAssignment = (role: 'OWNER' | 'ADMIN', permissions?: string[]): Express.ProductionAssignment => ({
  roleId: `${role}-company`, roleCode: role, scopeKind: 'COMPANY', locationId: null,
  permissions: role === 'ADMIN' ? (permissions ?? [...DEFAULT_ROLE_GRANTS.ADMIN]) : [],
});
function requestFor(userId: string, assignments: Express.ProductionAssignment[]): Request {
  const effectiveLocationIds = assignments.flatMap(({ locationId }) => (locationId ? [locationId] : []));
  return { auth: { userId, roles: assignments.map(({ roleCode }) => roleCode), assignments, effectiveLocationIds } } as unknown as Request;
}

const PRICE_V1 = 10000n;
const PRICE_V2 = 5000n;
const TOTAL = 2n * PRICE_V1 + PRICE_V2; // 25000: V1 x2 + V2 x1
type Method = 'CASH' | 'TRANSFER' | 'CARD_DEBIT' | 'CARD_CREDIT' | 'QR';
type PaymentSpec = { method: Method; amount: bigint };

function setup() {
  const db = createInMemorySalesDb({ withSaleVoid: true });
  db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  const L1 = db.insert('location', { isActive: true }).id as string;
  const L2 = db.insert('location', { isActive: true }).id as string;
  db.insert('branch', { id: L1, code: 'S1', name: 'Sucursal 1' });
  db.insert('branch', { id: L2, code: 'S2', name: 'Sucursal 2' });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = { seller: user('seller'), cashier: user('cashier'), admin: user('admin'), owner: user('owner'), warehouse: user('warehouse') };
  const product = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const variant = (sku: string, cashPrice: bigint) => db.insert('productVariant', {
    productId: product, sku, barcode: sku, cashPrice, price: cashPrice, wholesalePrice: null, costPrice: 1000n, color: 'Negro', size: 'M',
  }).id as string;
  const V1 = variant('V1', PRICE_V1);
  const V2 = variant('V2', PRICE_V2);
  const inventory = (branchId: string, variantId: string, physical: bigint, reserved: bigint) =>
    db.insert('inventory', { branchId, variantId, physical, reserved }).id as string;
  const inv = { V1: inventory(L1, V1, 100n, 0n), V2: inventory(L1, V2, 100n, 0n) };

  // Cash: a register + OPEN session at each branch, each with its OPENING movement.
  const STARTING = 10_000n;
  const registerL1 = db.insert('cashRegister', { branchId: L1, name: 'Caja 1' }).id as string;
  const registerL2 = db.insert('cashRegister', { branchId: L2, name: 'Caja 2' }).id as string;
  const openSession = (registerId: string, startingCash: bigint, status = 'OPEN') => {
    const session = db.insert('cashSession', { registerId, openedById: ids.cashier, startingCash, status });
    db.insert('cashMovement', { sessionId: session.id, type: 'OPENING', amount: startingCash, salePaymentId: null, userId: ids.cashier });
    return session.id as string;
  };
  const S1 = openSession(registerL1, STARTING);
  const S2 = openSession(registerL2, STARTING);
  const closeSession = (sessionId: string) => {
    db.table('cashSession').find((row) => row.id === sessionId)!.status = 'CLOSED';
  };

  const reqs = {
    owner: requestFor(ids.owner, [companyAssignment('OWNER')]),
    adminCompany: requestFor(ids.admin, [companyAssignment('ADMIN')]),
    adminCompanyNoVoid: requestFor(ids.admin, [companyAssignment('ADMIN', DEFAULT_ROLE_GRANTS.ADMIN.filter((p: string) => p !== 'SALE_VOID'))]),
    adminLocation: requestFor(ids.admin, [locationAssignment('ADMIN', L1)]),
    adminOtherBranch: requestFor(ids.admin, [locationAssignment('ADMIN', L2)]),
    cashier: requestFor(ids.cashier, [locationAssignment('CASHIER', L1)]),
    seller: requestFor(ids.seller, [locationAssignment('SELLER', L1)]),
    warehouse: requestFor(ids.warehouse, [locationAssignment('WAREHOUSE', L1)]),
  };

  function baseSale(status: string, pricingModel: 'FIXED_TOTAL' | 'PROPORTIONAL_V1', items: Array<[string, bigint, bigint]>, branchId = L1) {
    const saleTotal = items.reduce((sum, [, quantity, unitPrice]) => sum + quantity * unitPrice, 0n);
    const sale = db.insert('sale', {
      branchId, sellerId: ids.seller, status, priceMode: 'CASH', pricingModel, subtotal: saleTotal, discountTotal: 0n, total: saleTotal,
      saleNumber: `T-${randomUUID().slice(0, 8)}`,
    });
    for (const [variantId, quantity, unitPrice] of items) {
      db.insert('saleItem', {
        saleId: sale.id, variantId, productId: product, productName: 'Remera', variantName: 'Negro M', sku: variantId,
        quantity, unitPrice, subtotal: quantity * unitPrice,
      });
    }
    return sale.id as string;
  }

  // Real lifecycle: a CASH payment is bound to the session where it was collected and has its SALE_INCOME;
  // an external payment points at its APPLIED ExternalCollection and writes no CashMovement.
  function addPayments(saleId: string, payments: PaymentSpec[], cashSessionId = S1) {
    const byMethod: Record<string, string> = {};
    for (const spec of payments) {
      let externalCollectionId: string | null = null;
      if (spec.method !== 'CASH') {
        externalCollectionId = db.insert('externalCollection', {
          branchId: L1, method: spec.method, amount: spec.amount, reference: `REF-${spec.method}`, referenceKey: `ref-${randomUUID()}`,
          status: 'APPLIED', appliedSaleId: saleId, originSaleId: saleId, recordedById: ids.cashier,
        }).id as string;
      }
      const payment = db.insert('salePayment', {
        saleId, method: spec.method, amount: spec.amount, idempotencyKey: randomUUID(),
        cashSessionId: spec.method === 'CASH' ? cashSessionId : null, externalCollectionId,
      });
      byMethod[spec.method] = payment.id as string;
      if (spec.method === 'CASH') {
        db.insert('cashMovement', { sessionId: cashSessionId, type: 'SALE_INCOME', amount: spec.amount, salePaymentId: payment.id, userId: ids.cashier });
      }
    }
    return byMethod;
  }

  // A COMPLETED sale as the finalizer leaves it: physical decremented, reserved released, one negative SALE
  // movement per inventory, holds CONSUMED. Real lifecycles: PROPORTIONAL_V1 goes PAID->COMPLETED inside the
  // checkout (any method mix); FIXED_TOTAL is CASH-only.
  function completedSale(options: {
    pricingModel?: 'FIXED_TOTAL' | 'PROPORTIONAL_V1'; payments?: PaymentSpec[]; saleMovementQuantities?: [bigint, bigint];
    itemQuantities?: [bigint, bigint]; cashSessionId?: string;
  } = {}) {
    const pricingModel = options.pricingModel ?? 'PROPORTIONAL_V1';
    const [sold1, sold2] = options.saleMovementQuantities ?? [2n, 1n];
    const [item1, item2] = options.itemQuantities ?? [2n, 1n];
    const saleId = baseSale('COMPLETED', pricingModel, [[V1, item1, PRICE_V1], [V2, item2, PRICE_V2]]);
    const sale = db.table('sale').find((row) => row.id === saleId)!;
    const payments = addPayments(saleId, options.payments ?? (pricingModel === 'PROPORTIONAL_V1'
      ? [{ method: 'TRANSFER', amount: 15000n }, { method: 'CARD_DEBIT', amount: 10000n }]
      : [{ method: 'CASH', amount: sale.total as bigint }]), options.cashSessionId);
    for (const [inventoryId, sold] of [[inv.V1, sold1], [inv.V2, sold2]] as const) {
      const row = db.table('inventory').find((candidate) => candidate.id === inventoryId)!;
      row.physical = 100n - sold;
      row.reserved = 0n;
      db.insert('stockMovement', { inventoryId, type: 'SALE', quantityDelta: -sold, saleId, userId: ids.cashier, branchId: L1 });
    }
    db.insert('stockReservation', { saleId, variantId: V1, branchId: L1, quantity: item1, status: 'CONSUMED', expiresAt: new Date(Date.now() + 3600_000) });
    db.insert('stockReservation', { saleId, variantId: V2, branchId: L1, quantity: item2, status: 'CONSUMED', expiresAt: new Date(Date.now() + 3600_000) });
    return { saleId, payments };
  }

  // A PAID FIXED_TOTAL sale awaiting /complete: physical untouched, the stock sits in ACTIVE holds + Inventory.reserved.
  // (PAID persists only on this legacy path; the proportional checkout finalizes in the same transaction.)
  function paidSale(options: { payments?: PaymentSpec[]; cashSessionId?: string; activeHolds?: boolean } = {}) {
    const saleId = baseSale('PAID', 'FIXED_TOTAL', [[V1, 2n, PRICE_V1], [V2, 1n, PRICE_V2]]);
    const payments = addPayments(saleId, options.payments ?? [{ method: 'CASH', amount: TOTAL }], options.cashSessionId);
    if (options.activeHolds !== false) {
      db.table('inventory').find((row) => row.id === inv.V1)!.reserved = 2n;
      db.table('inventory').find((row) => row.id === inv.V2)!.reserved = 1n;
      db.insert('stockReservation', { saleId, variantId: V1, branchId: L1, quantity: 2n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3600_000) });
      db.insert('stockReservation', { saleId, variantId: V2, branchId: L1, quantity: 1n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 3600_000) });
    }
    return { saleId, payments };
  }

  const plainSale = (status: string) => baseSale(status, 'FIXED_TOTAL', [[V1, 1n, PRICE_V1]]);
  const client = db.client as unknown as PrismaClient;
  const everything = () => structuredClone(db.allTables());
  const invRow = (inventoryId: string) => db.table('inventory').find((row) => row.id === inventoryId)! as Row;
  const rows = (name: Parameters<typeof db.table>[0]) => db.table(name) as Row[];
  return {
    db, client, ids, L1, L2, V1, V2, inv, reqs, S1, S2, STARTING, registerL1, registerL2, openSession, closeSession,
    completedSale, paidSale, plainSale, everything, invRow, rows,
  };
}
type World = ReturnType<typeof setup>;

async function appError(promise: Promise<unknown>) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, 'expected an AppError').toBeInstanceOf(AppError);
  return { status: (error as AppError).status, code: (error as AppError).code };
}
const KEY = () => randomUUID();
const REASON = 'Error de carga: producto equivocado';
const EVIDENCE = 'Transferencia devuelta, comprobante 000123';
const input = (extra: Partial<VoidInput> = {}): VoidInput => ({ reason: REASON, idempotencyKey: KEY(), ...extra });
const evidenceFor = (payments: Record<string, string>, ...methods: Method[]) =>
  methods.map((method) => ({ salePaymentId: payments[method]!, evidence: `${EVIDENCE} ${method}` }));
const sortBy = <T extends Row>(list: T[], field: string) => [...list].sort((a, b) => String(a[field]).localeCompare(String(b[field])));
const auditsOf = (w: World, action = 'SALE_VOIDED') => w.rows('auditLog').filter((row) => row.action === action);

// ---- harness sanity: these test the FIXTURES and pass today --------------------------------------------------------

describe('sale void v1 — harness sanity (passes before the feature exists)', () => {
  it('H01 COMPLETED fixture: physical consumed (100 - sold), reserved 0, one negative SALE movement per inventory, holds CONSUMED', () => {
    const w = setup();
    const { saleId } = w.completedSale();
    expect(w.invRow(w.inv.V1)).toMatchObject({ physical: 98n, reserved: 0n });
    expect(w.invRow(w.inv.V2)).toMatchObject({ physical: 99n, reserved: 0n });
    expect(w.rows('stockMovement').filter((row) => row.saleId === saleId).map((row) => row.quantityDelta)).toEqual([-2n, -1n]);
    expect(w.rows('stockReservation').every((row) => row.status === 'CONSUMED')).toBe(true);
  });

  it('H02 PAID fixture mirrors the real lifecycle: physical NOT consumed, stock held by ACTIVE reservations, no SALE movement', () => {
    const w = setup();
    const { saleId } = w.paidSale();
    expect(w.invRow(w.inv.V1)).toMatchObject({ physical: 100n, reserved: 2n });
    expect(w.invRow(w.inv.V2)).toMatchObject({ physical: 100n, reserved: 1n });
    expect(w.rows('stockMovement').filter((row) => row.saleId === saleId)).toHaveLength(0);
    expect(w.rows('stockReservation').filter((row) => row.saleId === saleId).every((row) => row.status === 'ACTIVE')).toBe(true);
  });

  it('H03 payment fixtures: CASH binds to its session with a SALE_INCOME; external payments point at an APPLIED collection and write no cash movement', () => {
    const w = setup();
    const { payments } = w.completedSale({ pricingModel: 'PROPORTIONAL_V1', payments: [{ method: 'CASH', amount: 5000n }, { method: 'TRANSFER', amount: 20000n }] });
    expect(w.rows('salePayment').find((row) => row.id === payments.CASH)).toMatchObject({ cashSessionId: w.S1, externalCollectionId: null });
    expect(w.rows('cashMovement').filter((row) => row.type === 'SALE_INCOME')).toHaveLength(1);
    expect(w.rows('externalCollection')).toHaveLength(1);
    expect(w.rows('externalCollection')[0]).toMatchObject({ status: 'APPLIED', method: 'TRANSFER' });
  });

  it('H04 the in-memory transaction restores every table on throw (rollback is observable)', async () => {
    const w = setup();
    const before = w.everything();
    await w.client.$transaction(async (tx) => {
      await tx.sale.create({ data: { branchId: w.L1, sellerId: w.ids.seller, status: 'DRAFT' } as never });
      throw new Error('boom');
    }).catch(() => undefined);
    expect(w.everything()).toEqual(before);
  });

  it('H05 the drawer fixture reconciles before any void (OPENING + SALE_INCOME)', () => {
    const w = setup();
    const { payments } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    const movements = w.rows('cashMovement').filter((row) => row.sessionId === w.S1);
    const result = reconcileCashSession({
      startingCash: w.STARTING, movements: movements as never, cashPayments: [{ id: payments.CASH!, amount: TOTAL }], countedCash: w.STARTING + TOTAL,
    });
    expect(result).toEqual({ ok: true, expectedCash: w.STARTING + TOTAL, difference: 0n });
  });
});

// ---- states ----------------------------------------------------------------------------------------------------------

describe('sale void v1 — states', () => {
  it('SV01 PAID (FIXED_TOTAL, CASH) + OWNER -> CANCELLED, one SaleVoid recording the previous status', async () => {
    const w = setup();
    const { saleId } = w.paidSale();
    const key = KEY();
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ idempotencyKey: key, cashSessionId: w.S1 }));
    expect(result).toMatchObject({ saleId, branchId: w.L1, status: 'CANCELLED', previousStatus: 'PAID', replayed: false });
    expect(w.rows('sale').find((row) => row.id === saleId)!.status).toBe('CANCELLED');
    const voids = w.rows('saleVoid');
    expect(voids).toHaveLength(1);
    expect(voids[0]).toMatchObject({
      id: result.voidId, saleId, branchId: w.L1, voidedById: w.ids.owner, reason: REASON, idempotencyKey: key, previousStatus: 'PAID',
    });
  });

  it('SV02 COMPLETED (PROPORTIONAL_V1, external only, with evidence) + OWNER -> CANCELLED, previousStatus COMPLETED', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }));
    expect(result).toMatchObject({ saleId, status: 'CANCELLED', previousStatus: 'COMPLETED', replayed: false });
    expect(w.rows('sale').find((row) => row.id === saleId)!.status).toBe('CANCELLED');
    expect(w.rows('saleVoid')[0]).toMatchObject({ previousStatus: 'COMPLETED' });
  });

  it.each([['DRAFT'], ['PENDING_PAYMENT']] as const)('SV03 %s -> 409 INVALID_SALE_STATE and nothing is written', async (status) => {
    const w = setup();
    const saleId = w.plainSale(status);
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input()))).toEqual({ status: 409, code: 'INVALID_SALE_STATE' });
    expect(w.everything()).toEqual(before);
  });

  it('SV04 a sale already CANCELLED by the pre-payment cancel (no SaleVoid) -> 409 INVALID_SALE_STATE, not SALE_ALREADY_VOIDED', async () => {
    const w = setup();
    const saleId = w.plainSale('CANCELLED');
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input()))).toEqual({ status: 409, code: 'INVALID_SALE_STATE' });
    expect(w.everything()).toEqual(before);
  });

  it('SV05 an unknown sale -> 404 NOT_FOUND', async () => {
    const w = setup();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, randomUUID(), input()))).toEqual({ status: 404, code: 'NOT_FOUND' });
  });
});

// ---- stock ------------------------------------------------------------------------------------------------------------

describe('sale void v1 — stock follows the real lifecycle', () => {
  it('SV06 PAID releases exactly the ACTIVE holds: reserved decremented, physical untouched, NO StockMovement', async () => {
    const w = setup();
    const { saleId } = w.paidSale();
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 }));
    expect(w.invRow(w.inv.V1)).toMatchObject({ physical: 100n, reserved: 0n });
    expect(w.invRow(w.inv.V2)).toMatchObject({ physical: 100n, reserved: 0n });
    expect(w.rows('stockReservation').filter((row) => row.saleId === saleId).every((row) => row.status === 'RELEASED')).toBe(true);
    expect(w.rows('stockMovement')).toHaveLength(0);
    expect(result.stockReturned).toEqual([]);
    expect(sortBy(result.reservationsReleased as unknown as Row[], 'variantId')).toEqual(
      sortBy([{ variantId: w.V1, quantity: 2n }, { variantId: w.V2, quantity: 1n }], 'variantId'),
    );
  });

  it('SV07 PAID never increments physical, even when other sales hold reserved stock on the same inventory', async () => {
    const w = setup();
    const { saleId } = w.paidSale();
    w.invRow(w.inv.V1).reserved = 7n; // 2 ours + 5 held by other sales
    await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 }));
    expect(w.invRow(w.inv.V1)).toMatchObject({ physical: 100n, reserved: 5n });
  });

  it('SV08 COMPLETED restores physical from the SALE movements, as append-only SALE_VOID rows linked to the void; reserved untouched', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    w.invRow(w.inv.V1).reserved = 3n; // another sale's holds: must not move
    const salesBefore = structuredClone(w.rows('stockMovement').filter((row) => row.type === 'SALE'));
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }));
    expect(w.invRow(w.inv.V1)).toMatchObject({ physical: 100n, reserved: 3n });
    expect(w.invRow(w.inv.V2)).toMatchObject({ physical: 100n, reserved: 0n });
    const returns = sortBy(w.rows('stockMovement').filter((row) => row.type === 'SALE_VOID'), 'inventoryId');
    expect(returns).toHaveLength(2);
    for (const movement of returns) {
      expect(movement).toMatchObject({ saleId, saleVoidId: result.voidId, userId: w.ids.owner, branchId: w.L1 });
      expect(movement.quantityDelta as bigint).toBeGreaterThan(0n);
    }
    expect(returns.map((movement) => [movement.inventoryId, movement.quantityDelta])).toEqual(
      sortBy([{ inventoryId: w.inv.V1, q: 2n }, { inventoryId: w.inv.V2, q: 1n }], 'inventoryId').map((x) => [x.inventoryId, x.q]),
    );
    // the original SALE rows are never touched or deleted
    expect(w.rows('stockMovement').filter((row) => row.type === 'SALE')).toEqual(salesBefore);
    expect(sortBy(result.stockReturned as unknown as Row[], 'inventoryId')).toEqual(sortBy([
      { variantId: w.V1, inventoryId: w.inv.V1, quantity: 2n }, { variantId: w.V2, inventoryId: w.inv.V2, quantity: 1n },
    ], 'inventoryId'));
    expect(result.reservationsReleased).toEqual([]);
  });

  it('SV09 the SALE movements, not the SaleItem rows, decide what comes back', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale({ saleMovementQuantities: [1n, 1n], itemQuantities: [2n, 1n] });
    await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }));
    expect(w.invRow(w.inv.V1).physical).toBe(100n);
    expect(w.invRow(w.inv.V2).physical).toBe(100n);
    expect(sortBy(w.rows('stockMovement').filter((row) => row.type === 'SALE_VOID'), 'inventoryId').map((row) => row.quantityDelta)).toEqual([1n, 1n]);
  });

  it('SV10 COMPLETED with no SALE movement (cannot prove what left the shelf) -> 409 SALE_VOID_STOCK_INCONSISTENT, nothing written', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    w.db.table('stockMovement').splice(0);
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }))))
      .toEqual({ status: 409, code: 'SALE_VOID_STOCK_INCONSISTENT' });
    expect(w.everything()).toEqual(before);
  });

  it('SV11 BigInt overflow: returning the stock would exceed the signed BIGINT maximum -> fails closed, nothing written', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    w.invRow(w.inv.V1).physical = 9223372036854775807n;
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }))))
      .toEqual({ status: 409, code: 'SALE_VOID_STOCK_INCONSISTENT' });
    expect(w.everything()).toEqual(before);
  });
});

// ---- authorization and validation --------------------------------------------------------------------------------------

describe('sale void v1 — supervisor, branch scope, reason', () => {
  const cases: Array<[string, keyof ReturnType<typeof setup>['reqs'], number]> = [
    ['CASHIER', 'cashier', 403], ['SELLER', 'seller', 403], ['WAREHOUSE', 'warehouse', 403],
    ['ADMIN with only a LOCATION scope', 'adminLocation', 403], ['ADMIN of ANOTHER branch', 'adminOtherBranch', 403],
    ['COMPANY ADMIN without the SALE_VOID permission', 'adminCompanyNoVoid', 403],
  ];
  it.each(cases)('SV12 %s -> 403 FORBIDDEN and nothing is written', async (_label, who, status) => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs[who], saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }))))
      .toEqual({ status, code: 'FORBIDDEN' });
    expect(w.everything()).toEqual(before);
  });

  it('SV13 OWNER and COMPANY ADMIN (holding SALE_VOID) are the only supervisors', async () => {
    for (const who of ['owner', 'adminCompany'] as const) {
      const w = setup();
      const { saleId, payments } = w.completedSale();
      const result = await (await loadService(w.client)).voidSale(w.reqs[who], saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }));
      expect(result.status, who).toBe('CANCELLED');
      expect(w.rows('saleVoid')[0]).toMatchObject({ voidedById: who === 'owner' ? w.ids.owner : w.ids.admin });
    }
  });

  it('SV14 the permission is checked before the sale content: a CASHIER on a CASH sale without cashSessionId gets 403, not 409', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.cashier, saleId, input()))).toEqual({ status: 403, code: 'FORBIDDEN' });
  });

  it.each([[''], ['   '], ['\t\n']])('SV15 a blank reason (%j) -> 400 VALIDATION_ERROR before any write', async (reason) => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, { reason, idempotencyKey: KEY(), externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') })))
      .toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(w.everything()).toEqual(before);
  });

  it('SV16 a missing reason or idempotency key, or a key that is not a UUID v4 -> 400 VALIDATION_ERROR', async () => {
    const w = setup();
    const { saleId } = w.completedSale();
    const service = await loadService(w.client);
    for (const bad of [{ idempotencyKey: KEY() }, { reason: REASON }, { reason: REASON, idempotencyKey: 'not-a-uuid' }]) {
      expect(await appError(service.voidSale(w.reqs.owner, saleId, bad as never))).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    }
  });

  it('SV17 the reason is trimmed and limited to 200 characters', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const service = await loadService(w.client);
    expect(await appError(service.voidSale(w.reqs.owner, saleId, { reason: 'x'.repeat(201), idempotencyKey: KEY(), externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') })))
      .toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    await service.voidSale(w.reqs.owner, saleId, { reason: `  ${'y'.repeat(200)}  `, idempotencyKey: KEY(), externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') });
    expect(w.rows('saleVoid')[0]!.reason).toBe('y'.repeat(200));
  });

  it('SV18 the DTO is strict: reason, idempotencyKey, optional cashSessionId and externalRefunds; unknown keys and duplicate payment ids are refused', async () => {
    const dto = await loadDto();
    const ok = { reason: ` ${REASON} `, idempotencyKey: KEY() };
    expect(dto.safeParse(ok)).toMatchObject({ success: true, data: { reason: REASON } });
    expect(dto.safeParse({ ...ok, cashSessionId: randomUUID() }).success).toBe(true);
    const paymentId = randomUUID();
    expect(dto.safeParse({ ...ok, externalRefunds: [{ salePaymentId: paymentId, evidence: EVIDENCE }] }).success).toBe(true);
    expect(dto.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(dto.safeParse({ ...ok, externalRefunds: [{ salePaymentId: paymentId, evidence: '   ' }] }).success).toBe(false);
    expect(dto.safeParse({ ...ok, externalRefunds: [{ salePaymentId: paymentId, evidence: EVIDENCE, extra: 1 }] }).success).toBe(false);
    expect(dto.safeParse({ ...ok, externalRefunds: [{ salePaymentId: paymentId, evidence: EVIDENCE }, { salePaymentId: paymentId, evidence: EVIDENCE }] }).success).toBe(false);
  });
});

// ---- idempotency --------------------------------------------------------------------------------------------------------

describe('sale void v1 — idempotency and double void', () => {
  it('SV19 same key + same payload -> replayed:true, the same void, no second write', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    const service = await loadService(w.client);
    const request = input({ cashSessionId: w.S1 });
    const first = await service.voidSale(w.reqs.owner, saleId, request);
    const afterFirst = w.everything();
    const second = await service.voidSale(w.reqs.owner, saleId, request);
    expect(second).toMatchObject({ replayed: true, voidId: first.voidId, status: 'CANCELLED', previousStatus: 'COMPLETED' });
    expect(second.cashRefund).toEqual(first.cashRefund);
    expect(sortBy(second.stockReturned as unknown as Row[], 'inventoryId')).toEqual(sortBy(first.stockReturned as unknown as Row[], 'inventoryId'));
    expect(w.everything()).toEqual(afterFirst);
    expect(auditsOf(w)).toHaveLength(1);
  });

  it('SV20 the replay is still answered after the cash session was closed (no new write is needed)', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    const service = await loadService(w.client);
    const request = input({ cashSessionId: w.S1 });
    const first = await service.voidSale(w.reqs.owner, saleId, request);
    w.closeSession(w.S1);
    const afterClose = w.everything();
    const second = await service.voidSale(w.reqs.owner, saleId, request);
    expect(second).toMatchObject({ replayed: true, voidId: first.voidId });
    expect(w.everything()).toEqual(afterClose);
  });

  it('SV21 same key + different reason -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD, no write', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const service = await loadService(w.client);
    const key = KEY();
    const external = evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT');
    await service.voidSale(w.reqs.owner, saleId, { reason: REASON, idempotencyKey: key, externalRefunds: external });
    const before = w.everything();
    expect(await appError(service.voidSale(w.reqs.owner, saleId, { reason: 'Otro motivo', idempotencyKey: key, externalRefunds: external })))
      .toEqual({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    expect(w.everything()).toEqual(before);
  });

  it('SV22 same key + different cashSessionId or different external evidence -> 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale({ pricingModel: 'PROPORTIONAL_V1', payments: [{ method: 'CASH', amount: 5000n }, { method: 'TRANSFER', amount: 20000n }] });
    const service = await loadService(w.client);
    const key = KEY();
    const base = { reason: REASON, idempotencyKey: key, cashSessionId: w.S1, externalRefunds: evidenceFor(payments, 'TRANSFER') };
    await service.voidSale(w.reqs.owner, saleId, base);
    const otherSession = w.openSession(w.registerL1, 0n); // the fake does not enforce one OPEN session per register: only the payload comparison matters
    expect(await appError(service.voidSale(w.reqs.owner, saleId, { ...base, cashSessionId: otherSession })))
      .toEqual({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    const afterOtherSession = w.everything();
    expect(await appError(service.voidSale(w.reqs.owner, saleId, { ...base, externalRefunds: [{ salePaymentId: payments.TRANSFER!, evidence: 'otro comprobante' }] })))
      .toEqual({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    expect(w.everything()).toEqual(afterOtherSession);
  });

  it('SV23 another key after the sale was voided -> 409 SALE_ALREADY_VOIDED; stock, cash and audit are not repeated', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    const service = await loadService(w.client);
    await service.voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 }));
    const before = w.everything();
    expect(await appError(service.voidSale(w.reqs.adminCompany, saleId, input({ cashSessionId: w.S1 })))).toEqual({ status: 409, code: 'SALE_ALREADY_VOIDED' });
    expect(w.everything()).toEqual(before);
    expect(w.invRow(w.inv.V1).physical).toBe(100n);
    expect(w.rows('cashMovement').filter((row) => row.type === 'SALE_REFUND')).toHaveLength(1);
  });
});

// ---- cash ----------------------------------------------------------------------------------------------------------------

describe('sale void v1 — CASH goes back through an OPEN session of the same branch', () => {
  it('SV24 CASH + the original session still OPEN -> one SALE_REFUND there; SalePayment and SALE_INCOME untouched', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    const paymentBefore = structuredClone(w.rows('salePayment'));
    const incomeBefore = structuredClone(w.rows('cashMovement').filter((row) => row.type === 'SALE_INCOME'));
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 }));
    const refunds = w.rows('cashMovement').filter((row) => row.type === 'SALE_REFUND');
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({
      sessionId: w.S1, amount: TOTAL, userId: w.ids.owner, salePaymentId: null, refundOfSalePaymentId: payments.CASH, reason: REASON,
    });
    expect(result.cashRefund).toEqual({ cashSessionId: w.S1, total: TOTAL, movements: [{ id: refunds[0]!.id, salePaymentId: payments.CASH, amount: TOTAL }] });
    expect(w.rows('salePayment')).toEqual(paymentBefore);
    expect(w.rows('cashMovement').filter((row) => row.type === 'SALE_INCOME')).toEqual(incomeBefore);
  });

  it('SV25 CASH + the original session CLOSED + a LATER OPEN session of the same branch -> the refund lands in the later session only', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    w.closeSession(w.S1);
    const later = w.openSession(w.registerL1, 30_000n);
    const closedBefore = structuredClone(w.rows('cashMovement').filter((row) => row.sessionId === w.S1));
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: later }));
    expect(result.cashRefund).toMatchObject({ cashSessionId: later, total: TOTAL });
    expect(w.rows('cashMovement').filter((row) => row.type === 'SALE_REFUND').map((row) => row.sessionId)).toEqual([later]);
    expect(w.rows('cashMovement').filter((row) => row.sessionId === w.S1)).toEqual(closedBefore); // never a write on the CLOSED session
  });

  it('SV26 CASH + a CLOSED session -> 409 CASH_SESSION_ALREADY_CLOSED, nothing is written anywhere', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    w.closeSession(w.S1);
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 })))).toEqual({ status: 409, code: 'CASH_SESSION_ALREADY_CLOSED' });
    expect(w.everything()).toEqual(before);
  });

  it('SV27 CASH + an OPEN session of ANOTHER branch -> 409 CASH_SESSION_BRANCH_MISMATCH, nothing is written', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S2 })))).toEqual({ status: 409, code: 'CASH_SESSION_BRANCH_MISMATCH' });
    expect(w.everything()).toEqual(before);
  });

  it('SV28 CASH without cashSessionId -> 409 CASH_SESSION_REQUIRED, nothing is written (PAID and COMPLETED)', async () => {
    const w = setup();
    const completed = w.completedSale({ pricingModel: 'FIXED_TOTAL' }).saleId;
    const paid = w.paidSale().saleId;
    const before = w.everything();
    const service = await loadService(w.client);
    for (const saleId of [completed, paid]) {
      expect(await appError(service.voidSale(w.reqs.owner, saleId, input()))).toEqual({ status: 409, code: 'CASH_SESSION_REQUIRED' });
    }
    expect(w.everything()).toEqual(before);
  });

  it('SV29 an unknown cashSessionId -> 404 NOT_FOUND, nothing is written', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: randomUUID() })))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(w.everything()).toEqual(before);
  });

  it('SV30 a sale WITHOUT CASH does not require cashSessionId and writes no CashMovement', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const movementsBefore = structuredClone(w.rows('cashMovement'));
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }));
    expect(result.cashRefund).toBeNull();
    expect(w.rows('cashMovement')).toEqual(movementsBefore);
  });

  it('SV31 the drawer still reconciles after the void: expectedCash = starting + SALE_INCOME - SALE_REFUND', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 }));
    const movements = w.rows('cashMovement').filter((row) => row.sessionId === w.S1);
    const result = reconcileCashSession({
      startingCash: w.STARTING, movements: movements as never, cashPayments: [{ id: payments.CASH!, amount: TOTAL }], countedCash: w.STARTING,
    });
    expect(result).toEqual({ ok: true, expectedCash: w.STARTING, difference: 0n });
  });

  it('SV32 two CASH payments -> one SALE_REFUND per payment, in the same session, total reported', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale({
      pricingModel: 'PROPORTIONAL_V1', payments: [{ method: 'CASH', amount: 5000n }, { method: 'CASH', amount: 7000n }, { method: 'TRANSFER', amount: 13000n }],
    });
    const cashPayments = w.rows('salePayment').filter((row) => row.saleId === saleId && row.method === 'CASH');
    expect(cashPayments).toHaveLength(2);
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1, externalRefunds: evidenceFor(payments, 'TRANSFER') }));
    const refunds = sortBy(w.rows('cashMovement').filter((row) => row.type === 'SALE_REFUND'), 'amount');
    expect(refunds.map((row) => row.amount)).toEqual([5000n, 7000n]);
    expect(new Set(refunds.map((row) => row.refundOfSalePaymentId))).toEqual(new Set(cashPayments.map((row) => row.id)));
    expect(result.cashRefund).toMatchObject({ cashSessionId: w.S1, total: 12000n });
  });

  it('SV33 the refund may not exceed the projected drawer -> 409 INSUFFICIENT_CASH_IN_DRAWER, nothing is written (PROPOSED rule, as for cash exits)', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    w.closeSession(w.S1);
    const empty = w.openSession(w.registerL1, 1_000n);
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: empty })))).toEqual({ status: 409, code: 'INSUFFICIENT_CASH_IN_DRAWER' });
    expect(w.everything()).toEqual(before);
  });

  it('SV34 a refund already recorded for a payment of this sale (without a SaleVoid) fails closed: 409 SALE_REFUND_ALREADY_RECORDED', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    w.db.insert('cashMovement', { sessionId: w.S1, type: 'SALE_REFUND', amount: TOTAL, salePaymentId: null, refundOfSalePaymentId: payments.CASH, userId: w.ids.owner });
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 })))).toEqual({ status: 409, code: 'SALE_REFUND_ALREADY_RECORDED' });
    expect(w.everything()).toEqual(before);
  });

  it('SV35 PAID CASH: cash returned AND holds released in the one void', async () => {
    const w = setup();
    const { saleId } = w.paidSale();
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 }));
    expect(result.cashRefund).toMatchObject({ cashSessionId: w.S1, total: TOTAL });
    expect(w.rows('cashMovement').filter((row) => row.type === 'SALE_REFUND')).toHaveLength(1);
    expect(w.invRow(w.inv.V1)).toMatchObject({ physical: 100n, reserved: 0n });
  });
});

// ---- external payments ----------------------------------------------------------------------------------------------------

describe('sale void v1 — TRANSFER / CARD_DEBIT / CARD_CREDIT / QR need explicit refund evidence and are never deleted', () => {
  it.each([['TRANSFER'], ['CARD_DEBIT'], ['CARD_CREDIT'], ['QR']] as const)('SV36 a %s sale is voided with evidence; payment and collection stay exactly as they were', async (method) => {
    const w = setup();
    const { saleId, payments } = w.completedSale({ pricingModel: 'PROPORTIONAL_V1', payments: [{ method, amount: TOTAL }] });
    const paymentsBefore = structuredClone(w.rows('salePayment'));
    const collectionsBefore = structuredClone(w.rows('externalCollection'));
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, method) }));
    expect(result.externalRefunds).toEqual([{ salePaymentId: payments[method], method, amount: TOTAL, evidence: `${EVIDENCE} ${method}`, refundPerformed: true }]);
    expect(w.rows('salePayment')).toEqual(paymentsBefore);
    expect(w.rows('externalCollection')).toEqual(collectionsBefore); // still APPLIED, never auto-REFUNDED, never deleted
    expect(w.rows('externalCollection')[0]!.status).toBe('APPLIED');
    expect(w.rows('cashMovement').filter((row) => row.type === 'SALE_REFUND')).toHaveLength(0);
  });

  it('SV37 an external payment WITHOUT evidence -> 409 EXTERNAL_REFUND_EVIDENCE_REQUIRED, nothing written, never refundPerformed', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale(); // TRANSFER + CARD_DEBIT
    const before = w.everything();
    const service = await loadService(w.client);
    expect(await appError(service.voidSale(w.reqs.owner, saleId, input()))).toEqual({ status: 409, code: 'EXTERNAL_REFUND_EVIDENCE_REQUIRED' });
    // evidence for only ONE of the two external payments is not enough either
    expect(await appError(service.voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER') })))).toEqual({ status: 409, code: 'EXTERNAL_REFUND_EVIDENCE_REQUIRED' });
    expect(w.everything()).toEqual(before);
  });

  it('SV38 blank evidence -> 400 VALIDATION_ERROR, nothing written', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({
      externalRefunds: [{ salePaymentId: payments.TRANSFER!, evidence: '   ' }, { salePaymentId: payments.CARD_DEBIT!, evidence: EVIDENCE }],
    })))).toEqual({ status: 400, code: 'VALIDATION_ERROR' });
    expect(w.everything()).toEqual(before);
  });

  it('SV39 evidence for a CASH payment, or for a payment of ANOTHER sale -> 409 EXTERNAL_REFUND_PAYMENT_MISMATCH, nothing written', async () => {
    const w = setup();
    const mixed = w.completedSale({ pricingModel: 'PROPORTIONAL_V1', payments: [{ method: 'CASH', amount: 5000n }, { method: 'TRANSFER', amount: 20000n }] });
    const other = w.completedSale({ pricingModel: 'PROPORTIONAL_V1', payments: [{ method: 'QR', amount: TOTAL }] });
    const before = w.everything();
    const service = await loadService(w.client);
    expect(await appError(service.voidSale(w.reqs.owner, mixed.saleId, input({
      cashSessionId: w.S1, externalRefunds: [...evidenceFor(mixed.payments, 'TRANSFER'), { salePaymentId: mixed.payments.CASH!, evidence: EVIDENCE }],
    })))).toEqual({ status: 409, code: 'EXTERNAL_REFUND_PAYMENT_MISMATCH' });
    expect(await appError(service.voidSale(w.reqs.owner, mixed.saleId, input({
      cashSessionId: w.S1, externalRefunds: [...evidenceFor(mixed.payments, 'TRANSFER'), ...evidenceFor(other.payments, 'QR')],
    })))).toEqual({ status: 409, code: 'EXTERNAL_REFUND_PAYMENT_MISMATCH' });
    expect(w.everything()).toEqual(before);
  });

  it('SV40 mixed CASH + TRANSFER: both effects in one void — SALE_REFUND for the CASH part, evidence for the external part; nothing deleted', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale({ pricingModel: 'PROPORTIONAL_V1', payments: [{ method: 'CASH', amount: 5000n }, { method: 'TRANSFER', amount: 20000n }] });
    const paymentsBefore = structuredClone(w.rows('salePayment'));
    const collectionsBefore = structuredClone(w.rows('externalCollection'));
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1, externalRefunds: evidenceFor(payments, 'TRANSFER') }));
    expect(result.cashRefund).toMatchObject({ cashSessionId: w.S1, total: 5000n });
    expect(result.externalRefunds.map((refund) => refund.salePaymentId)).toEqual([payments.TRANSFER]);
    expect(w.rows('cashMovement').filter((row) => row.type === 'SALE_REFUND')).toHaveLength(1);
    expect(w.rows('salePayment')).toEqual(paymentsBefore);
    expect(w.rows('externalCollection')).toEqual(collectionsBefore);
    expect(w.rows('stockMovement').filter((row) => row.type === 'SALE_VOID')).toHaveLength(2);
  });

  it('SV41 mixed CASH + external without the evidence: the CASH refund is NOT written either (all-or-nothing)', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'PROPORTIONAL_V1', payments: [{ method: 'CASH', amount: 5000n }, { method: 'TRANSFER', amount: 20000n }] });
    const before = w.everything();
    expect(await appError((await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 })))).toEqual({ status: 409, code: 'EXTERNAL_REFUND_EVIDENCE_REQUIRED' });
    expect(w.everything()).toEqual(before);
  });

  it('SV42 PROPORTIONAL_V1 with CASH only (lifecycle: PAID -> COMPLETED inside the checkout) is voidable through an OPEN session', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'PROPORTIONAL_V1', payments: [{ method: 'CASH', amount: TOTAL }] });
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 }));
    expect(result).toMatchObject({ previousStatus: 'COMPLETED', externalRefunds: [] });
    expect(result.cashRefund).toMatchObject({ total: TOTAL });
  });

  it('SV43 only evidence-covered external payments are reported refundPerformed:true; the result never claims a refund it has no evidence for', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }));
    expect(result.externalRefunds.every((refund) => refund.refundPerformed === true && refund.evidence.trim() !== '')).toBe(true);
    expect(sortBy(result.externalRefunds as unknown as Row[], 'salePaymentId').map((refund) => refund.salePaymentId))
      .toEqual([payments.TRANSFER, payments.CARD_DEBIT].sort());
  });
});

// ---- audit -----------------------------------------------------------------------------------------------------------------

describe('sale void v1 — AuditLog', () => {
  it('SV44 one SALE_VOIDED audit with actor, branch, states, reason, key, stock, payments, cash and external evidence', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale({ pricingModel: 'PROPORTIONAL_V1', payments: [{ method: 'CASH', amount: 5000n }, { method: 'TRANSFER', amount: 20000n }] });
    const key = KEY();
    const result = await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, {
      reason: REASON, idempotencyKey: key, cashSessionId: w.S1, externalRefunds: evidenceFor(payments, 'TRANSFER'),
    });
    const audits = auditsOf(w);
    expect(audits).toHaveLength(1);
    const audit = audits[0]!;
    expect(audit).toMatchObject({ userId: w.ids.owner, branchId: w.L1, action: 'SALE_VOIDED', entityType: 'Sale', entityId: saleId });
    expect(audit.before).toMatchObject({ status: 'COMPLETED' });
    const after = audit.after as Row;
    expect(after).toMatchObject({
      status: 'CANCELLED', previousStatus: 'COMPLETED', voidId: result.voidId, reason: REASON, idempotencyKey: key, cashSessionId: w.S1,
    });
    expect(sortBy(after.stockReturned as Row[], 'inventoryId')).toHaveLength(2);
    expect((after.payments as Row[]).map((payment) => payment.id).sort()).toEqual([payments.CASH, payments.TRANSFER].sort());
    // createAuditLog persists through toJsonSafe: BigInt amounts are stored as decimal strings.
    expect(after.cashRefunded).toBe('5000');
    expect((after.cashRefundMovementIds as string[])).toEqual(result.cashRefund!.movements.map((movement) => movement.id));
    expect(after.externalRefunds).toEqual([{ salePaymentId: payments.TRANSFER, method: 'TRANSFER', amount: '20000', evidence: `${EVIDENCE} TRANSFER` }]);
  });

  it('SV45 a PAID void audits the released reservations and no returned stock', async () => {
    const w = setup();
    const { saleId } = w.paidSale();
    await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 }));
    const after = auditsOf(w)[0]!.after as Row;
    expect(after).toMatchObject({ previousStatus: 'PAID', stockReturned: [] });
    expect((after.reservationsReleased as Row[])).toHaveLength(2);
  });

  it('SV46 a rejected void writes no audit (permission, state, evidence, session)', async () => {
    const w = setup();
    const completed = w.completedSale({ pricingModel: 'FIXED_TOTAL' }).saleId;
    const service = await loadService(w.client);
    await appError(service.voidSale(w.reqs.cashier, completed, input({ cashSessionId: w.S1 })));
    await appError(service.voidSale(w.reqs.owner, completed, input()));
    await appError(service.voidSale(w.reqs.owner, w.plainSale('DRAFT'), input()));
    expect(auditsOf(w)).toHaveLength(0);
  });
});

// ---- atomicity, isolation level and retries ----------------------------------------------------------------------------------

type Delegate = Record<string, (...args: unknown[]) => Promise<unknown>>;
const WRITE_METHODS = new Set(['create', 'update', 'updateMany', 'upsert', 'delete']);

// A client whose k-th WRITE (any model, any of create/update/updateMany/upsert/delete) inside a transaction throws.
// failAt = 0 only counts. Independent of which writes the implementation chooses and in which order.
function writeFailingClient(w: World, failAt: number) {
  const state = { writes: 0, tripped: false };
  const real = w.db.client as Record<string, unknown>;
  const tx = new Proxy(real, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || typeof value !== 'object' || value === null || property.startsWith('$')) return value;
      return new Proxy(value as Delegate, {
        get(delegate, method) {
          const fn = delegate[method as string];
          if (typeof fn !== 'function' || !WRITE_METHODS.has(String(method))) return fn;
          return (...args: unknown[]) => {
            state.writes += 1;
            if (failAt > 0 && state.writes === failAt) {
              state.tripped = true;
              return Promise.reject(new Error(`injected failure at write ${failAt} (${property}.${String(method)})`));
            }
            return fn.apply(delegate, args);
          };
        },
      });
    },
  });
  const client = new Proxy(real, {
    get(target, property, receiver) {
      if (property === '$transaction') return (operation: (t: unknown) => Promise<unknown>, options?: unknown) => (real.$transaction as (...a: unknown[]) => Promise<unknown>)(() => operation(tx), options);
      return Reflect.get(target, property, receiver);
    },
  }) as unknown as PrismaClient;
  return { client, state };
}

describe('sale void v1 — atomicity', () => {
  it('SV47 a failure at ANY single write of a mixed CASH + external COMPLETED void rolls everything back (stock, SaleVoid, SALE_REFUND, status, audit)', async () => {
    const scenario = () => {
      const w = setup();
      const { saleId, payments } = w.completedSale({ pricingModel: 'PROPORTIONAL_V1', payments: [{ method: 'CASH', amount: 5000n }, { method: 'TRANSFER', amount: 20000n }] });
      return { w, saleId, request: input({ cashSessionId: w.S1, externalRefunds: evidenceFor(payments, 'TRANSFER') }) };
    };
    const clean = scenario();
    const counting = writeFailingClient(clean.w, 0);
    await (await loadService(counting.client)).voidSale(clean.w.reqs.owner, clean.saleId, clean.request);
    const total = counting.state.writes;
    // at least: SaleVoid, 2 inventory updates, 2 SALE_VOID movements, SALE_REFUND, sale status, audit
    expect(total).toBeGreaterThanOrEqual(8);
    for (let k = 1; k <= total; k += 1) {
      const { w, saleId, request } = scenario();
      const before = w.everything();
      const failing = writeFailingClient(w, k);
      await expect((await loadService(failing.client)).voidSale(w.reqs.owner, saleId, request), `write ${k}`).rejects.toThrow();
      expect(failing.state.tripped, `write ${k} was reached`).toBe(true);
      expect(w.everything(), `rollback after failing write ${k}`).toEqual(before);
    }
  });

  it('SV48 a failure at ANY single write of a PAID CASH void (holds released + refund) rolls everything back', async () => {
    const scenario = () => {
      const w = setup();
      const { saleId } = w.paidSale();
      return { w, saleId, request: input({ cashSessionId: w.S1 }) };
    };
    const clean = scenario();
    const counting = writeFailingClient(clean.w, 0);
    await (await loadService(counting.client)).voidSale(clean.w.reqs.owner, clean.saleId, clean.request);
    const total = counting.state.writes;
    expect(total).toBeGreaterThanOrEqual(6);
    for (let k = 1; k <= total; k += 1) {
      const { w, saleId, request } = scenario();
      const before = w.everything();
      const failing = writeFailingClient(w, k);
      await expect((await loadService(failing.client)).voidSale(w.reqs.owner, saleId, request), `write ${k}`).rejects.toThrow();
      expect(w.everything(), `rollback after failing write ${k}`).toEqual(before);
    }
  });
});

describe('sale void v1 — Serializable transaction and retries', () => {
  function transactionSpy(w: World, failures: Array<Record<string, unknown>>) {
    const calls: Array<{ isolationLevel?: string }> = [];
    const real = w.db.client as Record<string, unknown>;
    const pending = [...failures];
    const client = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return (operation: unknown, options?: { isolationLevel?: string }) => {
          calls.push({ isolationLevel: options?.isolationLevel });
          const failure = pending.shift();
          if (failure) return Promise.reject(Object.assign(new Error('serialization failure'), failure));
          return (real.$transaction as (...a: unknown[]) => Promise<unknown>)(operation, options);
        };
      },
    }) as unknown as PrismaClient;
    return { client, calls };
  }

  it('SV49 the void runs in ONE Serializable transaction', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const spy = transactionSpy(w, []);
    await (await loadService(spy.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }));
    expect(spy.calls).toEqual([{ isolationLevel: 'Serializable' }]);
  });

  it.each([
    ['P2034', { code: 'P2034' }],
    ['40001', { code: 'P2010', meta: { code: '40001' } }],
    ['40P01', { code: 'P2010', meta: { code: '40P01' } }],
  ])('SV50 a transient %s failure is retried and the void is applied exactly once', async (_label, failure) => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const spy = transactionSpy(w, [failure]);
    const result = await (await loadService(spy.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }));
    expect(result.replayed).toBe(false);
    expect(spy.calls).toHaveLength(2);
    expect(spy.calls.every((call) => call.isolationLevel === 'Serializable')).toBe(true);
    expect(w.rows('saleVoid')).toHaveLength(1);
    expect(auditsOf(w)).toHaveLength(1);
    expect(w.rows('stockMovement').filter((row) => row.type === 'SALE_VOID')).toHaveLength(2);
  });

  it('SV51 three consecutive transient failures -> 409 CONCURRENCY_ERROR and no effect', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const before = w.everything();
    const spy = transactionSpy(w, [{ code: 'P2034' }, { code: 'P2034' }, { code: 'P2034' }]);
    expect(await appError((await loadService(spy.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }))))
      .toEqual({ status: 409, code: 'CONCURRENCY_ERROR' });
    expect(spy.calls).toHaveLength(3);
    expect(w.everything()).toEqual(before);
  });

  it('SV52 a non-transient error is NOT retried', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    const spy = transactionSpy(w, [{ code: 'P2002' }]);
    await expect((await loadService(spy.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }))).rejects.toThrow();
    expect(spy.calls).toHaveLength(1);
  });
});

// ---- lock order -------------------------------------------------------------------------------------------------------------------

describe('sale void v1 — lock order Sale -> CashSession -> StockReservation -> Inventory', () => {
  const firstIndex = (queries: string[], pattern: RegExp) => queries.findIndex((query) => pattern.test(query));
  const FOR_UPDATE = (table: string) => new RegExp(`FROM "${table}"[\\s\\S]*FOR UPDATE`);

  it('SV53 PAID with CASH locks Sale, then the CashSession, then the StockReservation rows, then Inventory', async () => {
    const w = setup();
    const { saleId } = w.paidSale();
    await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 }));
    const order = [FOR_UPDATE('Sale'), FOR_UPDATE('CashSession'), FOR_UPDATE('StockReservation'), FOR_UPDATE('Inventory')].map((pattern) => firstIndex(w.db.rawQueries, pattern));
    expect(order.every((index) => index >= 0), `all four locks taken: ${JSON.stringify(order)}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('SV54 COMPLETED with CASH locks Sale, then the CashSession, then Inventory (no StockReservation: nothing is held)', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ cashSessionId: w.S1 }));
    const order = [FOR_UPDATE('Sale'), FOR_UPDATE('CashSession'), FOR_UPDATE('Inventory')].map((pattern) => firstIndex(w.db.rawQueries, pattern));
    expect(order.every((index) => index >= 0), `locks: ${JSON.stringify(order)}`).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(firstIndex(w.db.rawQueries, FOR_UPDATE('StockReservation'))).toBe(-1);
  });

  it('SV55 a sale without CASH never locks a CashSession', async () => {
    const w = setup();
    const { saleId, payments } = w.completedSale();
    await (await loadService(w.client)).voidSale(w.reqs.owner, saleId, input({ externalRefunds: evidenceFor(payments, 'TRANSFER', 'CARD_DEBIT') }));
    expect(firstIndex(w.db.rawQueries, FOR_UPDATE('CashSession'))).toBe(-1);
    expect(firstIndex(w.db.rawQueries, FOR_UPDATE('Sale'))).toBe(0);
  });

  it('SV56 the Sale row is the FIRST lock, before any permission or state decision reads other rows', async () => {
    const w = setup();
    const { saleId } = w.completedSale({ pricingModel: 'FIXED_TOTAL' });
    await appError((await loadService(w.client)).voidSale(w.reqs.cashier, saleId, input({ cashSessionId: w.S1 })));
    expect(w.db.rawQueries[0]).toMatch(/FROM "Sale"[\s\S]*FOR UPDATE/);
    expect(w.db.rawQueries.filter((query) => /FOR UPDATE/.test(query))).toHaveLength(1); // a refused void takes no further lock
  });
});
