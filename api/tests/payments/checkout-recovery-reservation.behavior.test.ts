// R3-A4.3 S7 — T-RR, the supervised recovery reservation: the reservation body
// of POST /sales/:saleId/checkout/reservations plus `recovery: {reason,
// evidence}`, against the DB-free double tests/helpers/checkout-reservation-fake-db.ts.
//
// S7-I (this slice): the T-RR branch and its first guards, in ONE Serializable
// transaction (30 s, 3 attempts on P2034/40001/40P01):
//   Sale FOR UPDATE → supervisor [SALE_CORRECT_PENDING, SALE_CHARGE,
//   SALE_COMPLETE] on the locked branch → replay/refuse → external-method gate
//   → sale state → open-attempt guard.
// T-R and T-RR never replay each other. The recovery justification is NOT part
// of planHash: a T-RR's identity is planHash + the presence of recovery + the
// persisted (trimmed) reason/evidence.
//
// S7-K: a NEW T-RR that passes every guard is a FRESH reservation (201): cash
// session → stock recovery evaluated → server quote → stock applied if changed
// → Sale.updatedAt → a NEW attempt (startedById = the CURRENT supervisor) →
// tenders → claims of U_origin → seal → audits → view. The temporary
// RECOVERY_RESERVATION_NOT_ENABLED refusal is gone.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { planHash, type PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import { createCheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import { computeProportionalQuote } from '../../src/modules/pricing/proportional-checkout.js';
import { TECHNICAL_HOLD_TTL_MS } from '../../src/modules/sales/reservation-holds.js';
import type { CheckoutReservationRequest } from '../../src/modules/payments/dto/checkout-reservation.dto.js';
import { AppError } from '../../src/shared/errors.js';
import { createCheckoutReservationFakeDb, p2002, type Row } from '../helpers/checkout-reservation-fake-db.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const LATER = new Date(NOW.getTime() + 20 * 60_000);
const NEW_EXPIRY = new Date(NOW.getTime() + TECHNICAL_HOLD_TTL_MS);
const PRICING = { bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300, creditCardAdjustmentBps: 0 };
const SERVICE_SOURCE = new URL('../../src/modules/payments/checkout-reservation.service.ts', import.meta.url);
const P = PRODUCTION_PERMISSIONS;
const uuid = () => randomUUID();
const RECOVERY = { reason: 'el cobro externo quedó sin imputar', evidence: 'cupón 0042' };
const SUPERVISOR = [P.SALE_CORRECT_PENDING, P.SALE_CHARGE, P.SALE_COMPLETE];

type Assignment = { roleCode: 'OWNER' | 'ADMIN' | 'CASHIER'; locationId: string | null; permissions: string[] };
function actor(userId: string, assignments: Assignment[]) {
  return {
    auth: {
      userId,
      roles: [...new Set(assignments.map((assignment) => assignment.roleCode))],
      effectiveLocationIds: assignments.flatMap((assignment) => (assignment.locationId ? [assignment.locationId] : [])),
      assignments: assignments.map((assignment) => ({
        roleId: assignment.roleCode, roleCode: assignment.roleCode, scopeKind: assignment.locationId ? 'LOCATION' : 'COMPANY',
        locationId: assignment.locationId, permissions: assignment.permissions,
      })),
    },
  } as never;
}

// OWNER 2026-10-20: a hold's clock no longer ends it, so a coverage is "recoverable"
// only when it is not exactly one ACTIVE row per required variant. `splitHold`
// writes the required 2 as two ACTIVE rows of 1 (valid coverage, changed:true).
function setup(options: { externalMethodsEnabled?: boolean; splitHold?: boolean } = {}) {
  const db = createCheckoutReservationFakeDb({ now: () => NOW });
  const branch = uuid();
  const owner = db.insert('user', { id: uuid(), name: 'Dueño' });
  const admin = db.insert('user', { id: uuid(), name: 'Admin compañía' });
  const cashier = db.insert('user', { id: uuid(), name: 'Caja' });
  const company = db.insert('company', { id: uuid(), createdAt: new Date(0) });
  const pricingConfig = db.insert('companyPricingConfig', {
    id: uuid(), companyId: company.id, updatedAt: new Date('2026-10-01T00:00:00Z'), listAdjustmentBps: 0, creditCardAdjustmentBps: 0,
    debitCardAdjustmentBps: PRICING.debitCardAdjustmentBps, bankTransferAdjustmentBps: PRICING.bankTransferAdjustmentBps, qrAdjustmentBps: 0,
  });
  const register = db.insert('cashRegister', { id: uuid(), branchId: branch });
  const session = db.insert('cashSession', { id: uuid(), registerId: register.id, status: 'OPEN' });
  const sale = db.insert('sale', {
    id: uuid(), branchId: branch, status: 'PENDING_PAYMENT', saleNumber: 'B-0001', pricingMode: 'LIST', priceMode: 'CASH',
    pricingModel: 'PROPORTIONAL_V1', paymentStartedAt: null, wholesaleConfirmedAt: null, wholesaleConfirmedById: null, updatedAt: new Date(0),
  });
  const item = db.insert('saleItem', { saleId: sale.id, variantId: 'v1', sku: 'SKU1', quantity: 2n, baseUnitPrice: 5000n, priceMode: 'CASH', priceBaseType: 'LIST' });
  const hold = db.insert('stockReservation', { saleId: sale.id, variantId: 'v1', branchId: branch, quantity: options.splitHold ? 1n : 2n, status: 'ACTIVE', expiresAt: LATER });
  const secondHold = options.splitHold
    ? db.insert('stockReservation', { saleId: sale.id, variantId: 'v1', branchId: branch, quantity: 1n, status: 'ACTIVE', expiresAt: LATER })
    : null;
  // The sale's own hold of 2 is counted in reserved (an exact coverage by default).
  const inventory = db.insert('inventory', { id: uuid(), variantId: 'v1', branchId: branch, physical: 10n, reserved: 2n });
  const service = createCheckoutReservationService(db.client as unknown as PrismaClient, {
    now: () => NOW, operationKey: () => uuid(), externalMethodsEnabled: options.externalMethodsEnabled ?? true,
  });
  const cashBalance: PlanTenderInput = { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null };
  // S7-J: a recoverable collection the closed checkout left behind (UNAPPLIED,
  // unclaimed, originated by this sale on its branch).
  const collection = (patch: Row = {}) => db.insert('externalCollection', {
    id: uuid(), branchId: branch, method: 'TRANSFER', amount: 3000n, status: 'UNAPPLIED', claimAttemptId: null, originSaleId: sale.id, ...patch,
  });
  const origin = collection();
  const collect = (row: Row, patch: Partial<PlanTenderInput> = {}): PlanTenderInput => ({
    method: row.method as PlanTenderInput['method'], role: 'FIXED', source: 'COLLECTION', amount: row.amount as bigint, externalCollectionId: row.id as string, ...patch,
  });
  // The server quote of a plan (the client's expected totals must match it). A
  // plan the engine itself refuses keeps a placeholder: a guard answers first.
  const quote = (tenders: PlanTenderInput[]) => computeProportionalQuote({
    lines: [{ saleItemId: item.id as string, sku: 'SKU1', quantity: 2n, baseUnitPrice: 5000n }],
    pricing: PRICING,
    tenders: tenders.filter((tender) => tender.role === 'FIXED').map((tender) => ({ method: tender.method, amount: tender.amount! })),
    balanceMethod: tenders.find((tender) => tender.role === 'BALANCE')!.method,
  });
  const expected = (tenders: PlanTenderInput[]) => {
    try {
      const quoted = quote(tenders);
      return { expectedTotal: quoted.total, expectedBalanceAmount: quoted.balance.amount };
    } catch (error) {
      if (error instanceof AppError) return { expectedTotal: 10000n, expectedBalanceAmount: 10000n };
      throw error;
    }
  };
  function request(tenders: PlanTenderInput[] = [cashBalance, collect(origin)], patch: Partial<CheckoutReservationRequest> = {}): CheckoutReservationRequest {
    return {
      reserveKey: uuid(), cashSessionId: session.id as string, balanceMethod: tenders.find((tender) => tender.role === 'BALANCE')!.method,
      ...expected(tenders), tenders, recovery: RECOVERY, ...patch,
    };
  }
  const hashOf = (req: CheckoutReservationRequest, saleId = sale.id as string) => planHash({
    saleId, cashSessionId: req.cashSessionId, balanceMethod: req.balanceMethod, expectedTotal: req.expectedTotal,
    expectedBalanceAmount: req.expectedBalanceAmount, tenders: req.tenders,
  });
  // A committed attempt in a state the schema allows at INSERT (F1 makes the
  // recovery justification write-once, so it is never added by an UPDATE).
  function persisted(req: CheckoutReservationRequest, patch: Row = {}, saleRow: Row = sale) {
    const row = db.insert('checkoutAttempt', {
      saleId: saleRow.id, branchId: saleRow.branchId, reserveKey: req.reserveKey, operationKey: uuid(), planHash: hashOf(req, saleRow.id as string),
      cashSessionId: req.cashSessionId, balanceMethod: req.balanceMethod, expectedTotal: req.expectedTotal,
      expectedBalanceAmount: req.expectedBalanceAmount, tenderCount: req.tenders.length, fullPriceCash: req.expectedTotal,
      algorithmVersion: 1, planSealed: true, startedById: owner.id,
      recoveryReason: req.recovery?.reason ?? null, recoveryEvidence: req.recovery?.evidence ?? null, ...patch,
    });
    for (const tender of req.tenders) db.insert('checkoutAttemptTender', { attemptId: row.id, branchId: saleRow.branchId, ...tender });
    return row;
  }
  return {
    db, service, branch, sale, session, register, request, hashOf, persisted, cashBalance, collection, origin, collect, quote,
    hold, secondHold, inventory, pricingConfig, owner, admin,
    asOwner: actor(owner.id as string, [{ roleCode: 'OWNER', locationId: null, permissions: [] }]),
    asCompanyAdmin: actor(admin.id as string, [{ roleCode: 'ADMIN', locationId: null, permissions: SUPERVISOR }]),
    asLocationAdmin: actor(admin.id as string, [{ roleCode: 'ADMIN', locationId: branch, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] }]),
    asCashier: actor(cashier.id as string, [{ roleCode: 'CASHIER', locationId: branch, permissions: [...DEFAULT_ROLE_GRANTS.CASHIER] }]),
    adminWithout: (missing: string) => actor(admin.id as string, [{ roleCode: 'ADMIN', locationId: null, permissions: SUPERVISOR.filter((p) => p !== missing) }]),
    asSplitAuthority: actor(admin.id as string, [
      { roleCode: 'ADMIN', locationId: null, permissions: [P.SALE_CORRECT_PENDING] },
      { roleCode: 'ADMIN', locationId: null, permissions: [P.SALE_CHARGE, P.SALE_COMPLETE] },
    ]),
  };
}

const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return null; } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.status, code: error.code, details: error.details };
  }
};
const GENERIC_409 = { status: 409, code: 'RESERVE_KEY_REUSED_WITH_DIFFERENT_PLAN', details: undefined };
// S7-K: a NEW T-RR that passes every guard is a fresh, sealed reservation.
const FRESH = { replayed: false, view: { status: 'RESERVED', stockState: 'VALID' } };

describe('R3-A4.3 S7-I — T-RR branch, RBAC, replay, gate, state (DB-free)', () => {
  it('RR-B01k a valid NEW T-RR is a fresh reservation in ONE Serializable transaction: replayed:false, a new RESERVED sealed attempt, view VALID; RECOVERY_RESERVATION_NOT_ENABLED is gone', async () => {
    const t = setup();
    const req = t.request();
    const result = await t.service.reserve(t.asOwner, t.sale.id as string, req);
    expect(result).toMatchObject({ ...FRESH, view: { ...FRESH.view, reserveKey: req.reserveKey } });
    expect(t.db.transactions).toEqual([{ isolationLevel: 'Serializable', timeout: 30_000 }]);
    expect(t.db.ops.at(-1)).toEqual({ kind: 'commit' });
    expect(t.db.table('checkoutAttempt')).toHaveLength(1);
    expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ reserveKey: req.reserveKey, status: 'RESERVED', planSealed: true });
    expect(readFileSync(SERVICE_SOURCE, 'utf8')).not.toContain('RECOVERY_RESERVATION_NOT_ENABLED');
  });

  it('RR-B03 an identical committed T-RR is replayed: same operationKey, zero writes', async () => {
    const t = setup();
    const req = t.request();
    const existing = t.persisted(req);
    const mark = t.db.ops.length;
    const result = await t.service.reserve(t.asOwner, t.sale.id as string, req);
    expect(result).toMatchObject({ replayed: true, view: { reserveKey: req.reserveKey, operationKey: existing.operationKey, status: 'RESERVED' } });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('checkoutAttempt')).toHaveLength(1);
  });

  it('RR-B04 the same key, sale and plan with ANOTHER reason or evidence is the generic 409, zero writes', async () => {
    for (const recovery of [{ ...RECOVERY, reason: 'otro motivo bastante distinto' }, { ...RECOVERY, evidence: 'cupón 9999' }]) {
      const t = setup();
      const req = t.request();
      t.persisted(req);
      const mark = t.db.ops.length;
      expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, { ...req, recovery }))).toEqual(GENERIC_409);
      expect(t.db.writesSince(mark)).toEqual([]);
    }
  });

  it('RR-B05 the same key with another plan, or a key of ANOTHER sale, is the same generic 409 without details', async () => {
    const plan = setup();
    const req = plan.request();
    plan.persisted(req);
    expect(await codeOf(plan.service.reserve(plan.asOwner, plan.sale.id as string, { ...req, expectedTotal: 12000n, expectedBalanceAmount: 12000n }))).toEqual(GENERIC_409);

    const foreign = setup();
    const otherSale = foreign.db.insert('sale', { ...foreign.sale, id: uuid(), saleNumber: 'B-0002' });
    const foreignReq = foreign.request();
    foreign.persisted(foreignReq, {}, otherSale);
    expect(await codeOf(foreign.service.reserve(foreign.asOwner, foreign.sale.id as string, foreignReq))).toEqual(GENERIC_409);
  });

  it('RR-B06 an ORDINARY attempt (no recovery) is never replayed by a T-RR, even with the same key and plan', async () => {
    const t = setup();
    const req = t.request();
    t.persisted({ ...req, recovery: null });
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, req))).toEqual(GENERIC_409);
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('RR-B08 a NEW T-RR on a sale that already holds an open attempt (another key) is 409 CHECKOUT_RESERVATION_OPEN', async () => {
    for (const open of [{ status: 'RESERVED' }, { status: 'REJECTED', rejectionCode: 'NO_OPEN_CASH_SESSION', rejectedById: 'u', rejectedAt: NOW }]) {
      const t = setup();
      t.persisted({ ...t.request(), recovery: null }, open);
      const result = await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request()));
      expect(result, JSON.stringify(open)).toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_OPEN' });
    }
    // A closed (declared) attempt is not open: the new T-RR goes past the guard.
    const closed = setup();
    closed.persisted({ ...closed.request(), recovery: null }, { status: 'ABANDONED', abandonedById: 'u', abandonedAt: NOW, declaredById: 'u', declaredAt: NOW });
    expect(await closed.service.reserve(closed.asOwner, closed.sale.id as string, closed.request())).toMatchObject(FRESH);
  });

  it('RR-B13 gate OFF: a NEW T-RR with an external tender is 409 PAYMENT_METHOD_NOT_ENABLED naming the REQUEST tender method (never an invented one), zero writes', async () => {
    const cases: Array<[PlanTenderInput[], string]> = [
      [[{ method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 3000n, externalCollectionId: null }], 'TRANSFER'],
      [[{ method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }, { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 3000n, externalCollectionId: uuid() }], 'CARD_DEBIT'],
    ];
    for (const [tenders, method] of cases) {
      const t = setup({ externalMethodsEnabled: false });
      const mark = t.db.ops.length;
      const error = await t.service.reserve(t.asOwner, t.sale.id as string, t.request(tenders)).catch((caught: AppError) => caught);
      expect(error).toMatchObject({ status: 409, code: 'PAYMENT_METHOD_NOT_ENABLED' });
      expect((error as AppError).message).toContain(method);
      expect(t.db.writesSince(mark)).toEqual([]);
    }
  });

  it('RR-B14 a committed T-RR is replayed BEFORE the gate: the gate turned OFF never blocks recovering that answer', async () => {
    const t = setup({ externalMethodsEnabled: false });
    const req = t.request([t.cashBalance, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 3000n, externalCollectionId: uuid() }]);
    const existing = t.persisted(req);
    const result = await t.service.reserve(t.asOwner, t.sale.id as string, req);
    expect(result).toMatchObject({ replayed: true, view: { operationKey: existing.operationKey } });
  });

  it('RR-B25 RBAC on the locked branch BEFORE the replay: OWNER and a COMPANY ADMIN with all three permissions pass; everyone else is 403 and recovers nothing', async () => {
    for (const who of ['asOwner', 'asCompanyAdmin'] as const) {
      const t = setup();
      expect(await t.service.reserve(t[who], t.sale.id as string, t.request()), who).toMatchObject(FRESH);
    }
    const denied: Array<[string, (t: ReturnType<typeof setup>) => unknown]> = [
      ['CASHIER', (t) => t.asCashier],
      ['LOCATION ADMIN', (t) => t.asLocationAdmin],
      ['ADMIN without SALE_CORRECT_PENDING', (t) => t.adminWithout(P.SALE_CORRECT_PENDING)],
      ['ADMIN without SALE_CHARGE', (t) => t.adminWithout(P.SALE_CHARGE)],
      ['ADMIN without SALE_COMPLETE', (t) => t.adminWithout(P.SALE_COMPLETE)],
      ['split authority', (t) => t.asSplitAuthority],
    ];
    for (const [label, pick] of denied) {
      const t = setup();
      // A matching committed T-RR exists: a 403 must not leak it as a replay.
      const req = t.request();
      t.persisted(req);
      const mark = t.db.ops.length;
      expect(await codeOf(t.service.reserve(pick(t) as never, t.sale.id as string, req)), label).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(t.db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model), label).toEqual(['Sale']);
      expect(t.db.writesSince(mark)).toEqual([]);
    }
  });

  it('RR-B26 a NEW T-RR on a sale that is not PROPORTIONAL_V1 / PENDING_PAYMENT, or has any payment, is 409 INVALID_SALE_STATE; a committed T-RR still replays', async () => {
    const patches: Row[] = [
      { pricingModel: 'FIXED_TOTAL' }, { status: 'DRAFT' }, { status: 'PAID' }, { status: 'COMPLETED' }, { status: 'CANCELLED' }, { paymentStartedAt: NOW },
    ];
    for (const patch of patches) {
      const t = setup();
      Object.assign(t.db.table('sale')[0]!, patch);
      expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request())), JSON.stringify(patch))
        .toMatchObject({ status: 409, code: 'INVALID_SALE_STATE' });
    }
    const paid = setup();
    paid.db.insert('salePayment', { saleId: paid.sale.id, method: 'CASH', amount: 100n });
    expect(await codeOf(paid.service.reserve(paid.asOwner, paid.sale.id as string, paid.request()))).toMatchObject({ code: 'INVALID_SALE_STATE' });

    const moved = setup();
    const req = moved.request();
    const existing = moved.persisted(req);
    moved.db.table('sale')[0]!.status = 'COMPLETED';
    expect(await moved.service.reserve(moved.asOwner, moved.sale.id as string, req)).toMatchObject({ replayed: true, view: { operationKey: existing.operationKey } });
  });

  it('RR-B26b (S7-K.1) guard precedence equals T-R: state → line snapshot → payments — a paid sale with an invalid line is PRICING_SNAPSHOT_INCONSISTENT in both, zero writes, only the Sale locked', async () => {
    const paid: Array<[string, (t: ReturnType<typeof setup>) => void]> = [
      ['SalePayment', (t) => { t.db.insert('salePayment', { saleId: t.sale.id, method: 'CASH', amount: 100n }); }],
      ['paymentStartedAt', (t) => { t.db.table('sale')[0]!.paymentStartedAt = NOW; }],
    ];
    for (const [label, pay] of paid) {
      const outcomes: unknown[] = [];
      for (const recovery of [RECOVERY, null]) {
        const t = setup({ splitHold: true });
        pay(t);
        // loadProportionalLines refuses a line not priced in CASH.
        t.db.table('saleItem')[0]!.priceMode = 'LIST';
        const before = structuredClone(t.db.tables);
        const mark = t.db.ops.length;
        outcomes.push(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, { ...t.request(), recovery })));
        expect(t.db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model), label).toEqual(['Sale']);
        expect(t.db.writesSince(mark), label).toEqual([]);
        expect(t.db.tables, label).toEqual(before);
      }
      expect(outcomes[0], label).toMatchObject({ status: 409, code: 'PRICING_SNAPSHOT_INCONSISTENT' });
      expect(outcomes[0], `${label}: T-RR == T-R`).toEqual(outcomes[1]);
    }

    // Valid lines + a payment stay INVALID_SALE_STATE, in both.
    for (const recovery of [RECOVERY, null]) {
      const t = setup();
      t.db.insert('salePayment', { saleId: t.sale.id, method: 'CASH', amount: 100n });
      const mark = t.db.ops.length;
      expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, { ...t.request(), recovery }))).toMatchObject({ status: 409, code: 'INVALID_SALE_STATE' });
      expect(t.db.writesSince(mark)).toEqual([]);
    }
  });

  it('RR-B24 the T-RR branch retries transient failures in NEW Serializable transactions (Sale lock and RBAC re-run); three are CONCURRENCY_ERROR', async () => {
    const retried = setup();
    retried.db.failOn('sale', 'lock', () => Object.assign(new Error('could not serialize'), { code: 'P2034' }));
    retried.db.failOn('sale', 'lock', () => Object.assign(new Error('deadlock'), { meta: { code: '40P01' } }));
    const mark = retried.db.ops.length;
    expect(await retried.service.reserve(retried.asOwner, retried.sale.id as string, retried.request())).toMatchObject(FRESH);
    expect(retried.db.transactions).toEqual(Array(3).fill({ isolationLevel: 'Serializable', timeout: 30_000 }));
    expect(retried.db.ops.slice(mark).filter((op) => op.kind === 'begin')).toHaveLength(3);

    const exhausted = setup();
    for (let index = 0; index < 3; index += 1) {
      exhausted.db.failOn('sale', 'lock', () => Object.assign(new Error('could not serialize (40001)'), { meta: { code: '40001' } }));
    }
    expect(await codeOf(exhausted.service.reserve(exhausted.asOwner, exhausted.sale.id as string, exhausted.request())))
      .toMatchObject({ status: 409, code: 'CONCURRENCY_ERROR' });
  });
});

// ---------------------------------------------------------------------------
// S7-J — the collections of a NEW T-RR. U_plan = the COLLECTION tenders' ids;
// U_origin = the sale's own UNAPPLIED, unclaimed collections on its branch.
// ONE statement locks U_plan ∪ (the sale's UNAPPLIED origin rows) in id order;
// U_origin is derived from the LOCKED rows. Error order (P39 depends on it):
// per-tender checks → U_origin non-empty → U_plan == U_origin.
// These refusals write nothing (claims, attempt, cash, stock, quote come later).
// ---------------------------------------------------------------------------
describe('R3-A4.3 S7-J — T-RR collections (DB-free, zero writes)', () => {
  const locks = (t: ReturnType<typeof setup>, mark: number) => t.db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model);

  it('RR-B09 a plan that omits one of the sale\'s two recoverable collections is 409 UNAPPLIED_EXTERNAL_COLLECTION_PENDING; both were locked, in id order, in ONE statement', async () => {
    const t = setup();
    const second = t.collection({ method: 'CARD_DEBIT', amount: 2000n });
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request()))).toMatchObject({ status: 409, code: 'UNAPPLIED_EXTERNAL_COLLECTION_PENDING' });
    expect(locks(t, mark)).toEqual(['Sale', 'ExternalCollection']);
    const statement = t.db.ops.slice(mark).find((op) => op.model === 'ExternalCollection')!.detail as string;
    expect(statement).toMatch(/ORDER BY id ASC FOR UPDATE$/);
    expect(statement).not.toMatch(/NOWAIT/);
    expect([t.origin.id, second.id].every((id) => typeof id === 'string')).toBe(true);
    expect(t.db.writesSince(mark)).toEqual([]);

    // With both in the plan, the set is exact and the fresh reservation commits.
    const both = setup();
    const card = both.collection({ method: 'CARD_DEBIT', amount: 2000n });
    expect(await both.service.reserve(both.asOwner, both.sale.id as string, both.request([both.cashBalance, both.collect(both.origin), both.collect(card)])))
      .toMatchObject(FRESH);
  });

  it('RR-B10 a collection of ANOTHER sale (same branch, UNAPPLIED, unclaimed) is 409 EXTERNAL_COLLECTION_NOT_APPLICABLE — recovery never moves money between sales', async () => {
    const t = setup();
    const foreign = t.collection({ originSaleId: uuid(), method: 'CARD_DEBIT', amount: 2000n });
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request([t.cashBalance, t.collect(t.origin), t.collect(foreign)]))))
      .toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_NOT_APPLICABLE' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('RR-B11 per-tender checks: claimed → EXTERNAL_COLLECTION_CLAIMED; REFUNDED, APPLIED, another branch, another method, another amount, a missing row or one collection under two methods → NOT_APPLICABLE; zero writes', async () => {
    const cases: Array<[string, (t: ReturnType<typeof setup>) => PlanTenderInput[], string]> = [
      ['claimed', (t) => { t.origin.claimAttemptId = uuid(); return [t.cashBalance, t.collect(t.origin)]; }, 'EXTERNAL_COLLECTION_CLAIMED'],
      ['REFUNDED', (t) => { t.origin.status = 'REFUNDED'; return [t.cashBalance, t.collect(t.origin)]; }, 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      ['APPLIED', (t) => { t.origin.status = 'APPLIED'; return [t.cashBalance, t.collect(t.origin)]; }, 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      ['another branch', (t) => [t.cashBalance, t.collect(t.collection({ branchId: uuid(), method: 'CARD_DEBIT' }))], 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      ['another method', (t) => [t.cashBalance, t.collect(t.origin, { method: 'CARD_DEBIT' })], 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      ['another amount', (t) => [t.cashBalance, t.collect(t.origin, { amount: 2999n })], 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      ['missing row', (t) => [t.cashBalance, t.collect(t.origin, { externalCollectionId: uuid() })], 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
      // The DTO and planHash refuse a repeated METHOD; one collection named by
      // two methods is caught by the per-tender method check.
      ['one collection under two methods', (t) => [t.cashBalance, t.collect(t.origin), t.collect(t.origin, { method: 'CARD_DEBIT' })], 'EXTERNAL_COLLECTION_NOT_APPLICABLE'],
    ];
    for (const [label, tenders, code] of cases) {
      const t = setup();
      const plan = tenders(t);
      const before = structuredClone(t.db.table('externalCollection'));
      const mark = t.db.ops.length;
      expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request(plan))), label).toMatchObject({ status: 409, code });
      expect(t.db.writesSince(mark), label).toEqual([]);
      expect(t.db.table('externalCollection'), label).toEqual(before);
    }
  });

  it('RR-B12 no recoverable origin collection is 409 RECOVERY_RESERVATION_NOT_APPLICABLE — but a referenced REFUNDED collection wins with NOT_APPLICABLE (the per-tender check comes first)', async () => {
    const empty = setup();
    empty.origin.status = 'REFUNDED';
    const mark = empty.db.ops.length;
    expect(await codeOf(empty.service.reserve(empty.asOwner, empty.sale.id as string, empty.request([empty.cashBalance]))))
      .toMatchObject({ status: 409, code: 'RECOVERY_RESERVATION_NOT_APPLICABLE' });
    expect(empty.db.writesSince(mark)).toEqual([]);

    // A claimed origin is not recoverable either (it belongs to an open attempt elsewhere).
    const claimed = setup();
    claimed.origin.claimAttemptId = uuid();
    expect(await codeOf(claimed.service.reserve(claimed.asOwner, claimed.sale.id as string, claimed.request([claimed.cashBalance]))))
      .toMatchObject({ code: 'RECOVERY_RESERVATION_NOT_APPLICABLE' });

    // P39 shape: T-F refunded the collection the T-RR plan names.
    const refunded = setup();
    refunded.origin.status = 'REFUNDED';
    expect(await codeOf(refunded.service.reserve(refunded.asOwner, refunded.sale.id as string, refunded.request())))
      .toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_NOT_APPLICABLE' });
  });

  it('RR-B13b the request method is only trusted after it matches the collection: COLLECTION TRANSFER over a CARD_DEBIT collection with the gate ON is NOT_APPLICABLE', async () => {
    const t = setup();
    const card = t.collection({ method: 'CARD_DEBIT', amount: 3000n });
    t.origin.status = 'REFUNDED';
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request([t.cashBalance, t.collect(card, { method: 'TRANSFER' })]))))
      .toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_NOT_APPLICABLE' });
  });

  it('RR-B27 error order: open attempt before any collection check; per-tender checks before U_origin; U_origin before the exact set', async () => {
    const open = setup();
    open.persisted({ ...open.request(), recovery: null });
    open.origin.status = 'REFUNDED';
    const mark = open.db.ops.length;
    expect(await codeOf(open.service.reserve(open.asOwner, open.sale.id as string, open.request()))).toMatchObject({ code: 'CHECKOUT_RESERVATION_OPEN' });
    expect(locks(open, mark)).toEqual(['Sale']);

    // Claimed referenced collection AND an omitted origin: the per-tender error wins.
    const both = setup();
    both.collection({ method: 'CARD_DEBIT', amount: 2000n });
    both.origin.claimAttemptId = uuid();
    expect(await codeOf(both.service.reserve(both.asOwner, both.sale.id as string, both.request()))).toMatchObject({ code: 'EXTERNAL_COLLECTION_CLAIMED' });
  });

  it('RR-B28 the collections are locked right AFTER the Sale, in id order, then the cash session and the stock; both are claimed in id order', async () => {
    const t = setup();
    const ids = ['ffffffff-ffff-4fff-8fff-fffffffffff1', '00000000-0000-4000-8000-000000000a01'];
    const rows = ids.map((id, index) => t.collection({ id, method: index === 0 ? 'CARD_DEBIT' : 'TRANSFER', amount: 1000n }));
    t.origin.status = 'REFUNDED';
    const mark = t.db.ops.length;
    const plan = [t.cashBalance, t.collect(rows[0]!), t.collect(rows[1]!)];
    expect(await t.service.reserve(t.asOwner, t.sale.id as string, t.request(plan))).toMatchObject(FRESH);
    expect(locks(t, mark)).toEqual(['Sale', 'ExternalCollection', 'CashSession', 'StockReservation', 'Inventory']);
    const claim = t.db.writesSince(mark).find((op) => op.model === 'externalCollection')!;
    expect((claim.detail as { where: { id: { in: string[] } } }).where.id.in).toEqual([...ids].sort());
  });
});

// ---------------------------------------------------------------------------
// S7-J.1 (OWNER): a T-RR only recovers collections already persisted for this
// sale; it may carry CASH and COLLECTION tenders, never a NEW external tender.
// Order: … gate → sale state → open attempt → recovery tender shape → the
// collections. With the gate OFF the global policy still answers first.
// ---------------------------------------------------------------------------
describe('R3-A4.3 S7-J.1 — no NEW external tender in a T-RR (DB-free)', () => {
  const locks = (t: ReturnType<typeof setup>, mark: number) => t.db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model);
  const NOT_APPLICABLE = { status: 409, code: 'RECOVERY_RESERVATION_NOT_APPLICABLE' };

  it('RR-B29 gate ON: a NEW TRANSFER next to a valid origin COLLECTION is 409 RECOVERY_RESERVATION_NOT_APPLICABLE, before any collection lock, zero writes', async () => {
    const t = setup();
    t.origin.method = 'CARD_DEBIT';
    const plan: PlanTenderInput[] = [t.cashBalance, t.collect(t.origin), { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 1000n, externalCollectionId: null }];
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request(plan)))).toMatchObject(NOT_APPLICABLE);
    expect(locks(t, mark)).toEqual(['Sale']);
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('RR-B30 gate ON: a NEW CARD_DEBIT next to a valid origin COLLECTION is 409 RECOVERY_RESERVATION_NOT_APPLICABLE', async () => {
    const t = setup();
    const plan: PlanTenderInput[] = [t.cashBalance, t.collect(t.origin), { method: 'CARD_DEBIT', role: 'FIXED', source: 'NEW', amount: 1000n, externalCollectionId: null }];
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request(plan)))).toMatchObject(NOT_APPLICABLE);
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('RR-B31 gate ON: CASH + a valid COLLECTION passes the shape guard and commits a fresh reservation', async () => {
    const t = setup();
    const mark = t.db.ops.length;
    expect(await t.service.reserve(t.asOwner, t.sale.id as string, t.request([t.cashBalance, t.collect(t.origin)]))).toMatchObject(FRESH);
    expect(locks(t, mark)).toEqual(['Sale', 'ExternalCollection', 'CashSession', 'StockReservation', 'Inventory']);
  });

  it('RR-B32 gate OFF: a NEW TRANSFER is still PAYMENT_METHOD_NOT_ENABLED — the global policy is evaluated before the recovery shape rule', async () => {
    const t = setup({ externalMethodsEnabled: false });
    t.origin.method = 'CARD_DEBIT';
    const plan: PlanTenderInput[] = [t.cashBalance, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 1000n, externalCollectionId: null }];
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request(plan)))).toMatchObject({ status: 409, code: 'PAYMENT_METHOD_NOT_ENABLED' });
  });
});

// ---------------------------------------------------------------------------
// S7-K — the FRESH T-RR, one Serializable transaction. After the S7-I/J guards:
//   CashSession FOR UPDATE → evaluateStockRecovery (StockReservation → Inventory,
//   id ASC, no write) → server quote → applyStockRecovery IF changed →
//   Sale.updatedAt (raw now(), ALWAYS once) → NEW attempt (unsealed) → tenders →
//   claims of exactly U_origin (NULL → new attempt) → seal → CHECKOUT_RESERVED →
//   CHECKOUT_STOCK_RECOVERED IF the stock changed → view (same `at`).
// ---------------------------------------------------------------------------
describe('R3-A4.3 S7-K — the fresh T-RR (DB-free)', () => {
  type T = ReturnType<typeof setup>;
  const steps = (t: T, mark: number) => t.db.ops.slice(mark).filter((op) => op.kind !== 'begin' && op.kind !== 'commit').map((op) => `${op.kind}:${op.model}`);
  const locks = (t: T, mark: number) => t.db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model);
  const touches = (t: T, mark: number) => t.db.ops.slice(mark).filter((op) => op.kind === 'touch');
  const userOf = (who: unknown) => (who as { auth: { userId: string } }).auth.userId;
  const actions = (t: T) => t.db.table('auditLog').map((row) => row.action);
  const lastBegin = (t: T) => t.db.ops.map((op) => op.kind).lastIndexOf('begin');
  // Every table a refused T-RR must leave exactly as it was.
  const state = (t: T) => structuredClone({
    sale: t.db.table('sale'), attempts: t.db.table('checkoutAttempt'), tenders: t.db.table('checkoutAttemptTender'),
    collections: t.db.table('externalCollection'), holds: t.db.table('stockReservation'), inventory: t.db.table('inventory'),
    audits: t.db.table('auditLog'),
  });
  const auditDown = (t: T, action: string) => {
    const delegate = t.db.client.auditLog as { create: (args: { data: Row }) => Promise<Row> };
    const original = delegate.create;
    delegate.create = async (args) => {
      if (args.data.action === action) throw new Error(`audit ${action} down`);
      return original(args);
    };
  };

  it('RR-B02 the new attempt persists the recovery, the CURRENT supervisor, a new server operationKey, planHash and the whole pricing snapshot; the previous attempt is untouched', async () => {
    const t = setup();
    const previous = t.persisted({ ...t.request(), recovery: null }, {
      status: 'ABANDONED', abandonedById: t.owner.id, abandonedAt: NOW, declaredById: t.owner.id, declaredAt: NOW,
    });
    const previousBefore = structuredClone(previous);
    const req = t.request();
    await t.service.reserve(t.asCompanyAdmin, t.sale.id as string, req);
    const created = t.db.table('checkoutAttempt').find((row) => row.reserveKey === req.reserveKey)!;
    const quoted = t.quote(req.tenders);
    expect(created).toMatchObject({
      saleId: t.sale.id, branchId: t.branch, reserveKey: req.reserveKey, planHash: t.hashOf(req), cashSessionId: t.session.id,
      balanceMethod: 'CASH', expectedTotal: req.expectedTotal, expectedBalanceAmount: req.expectedBalanceAmount, tenderCount: 2,
      fullPriceCash: quoted.fullPrices.CASH, fullPriceTransfer: quoted.fullPrices.TRANSFER, fullPriceDebit: quoted.fullPrices.CARD_DEBIT,
      fullPriceCredit: quoted.fullPrices.CARD_CREDIT, creditAdjustmentBps: 0,
      transferAdjustmentBps: 200, debitAdjustmentBps: 300, pricingConfigId: t.pricingConfig.id, pricingConfigUpdatedAt: t.pricingConfig.updatedAt,
      algorithmVersion: 2, startedById: userOf(t.asCompanyAdmin), recoveryReason: RECOVERY.reason, recoveryEvidence: RECOVERY.evidence,
      status: 'RESERVED', planSealed: true,
    });
    expect(created.operationKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(created.operationKey).not.toBe(previous.operationKey);
    expect(t.db.table('checkoutAttempt').find((row) => row.id === previous.id)).toEqual(previousBefore);
  });

  it('RR-B15 the cash session is locked like T-R: missing or not OPEN → NO_OPEN_CASH_SESSION; another branch → CASH_SESSION_BRANCH_MISMATCH; zero writes, no stock lock', async () => {
    const cases: Array<[string, (t: T) => Partial<CheckoutReservationRequest>, string]> = [
      ['missing', () => ({ cashSessionId: uuid() }), 'NO_OPEN_CASH_SESSION'],
      ['closed', (t) => { t.session.status = 'CLOSED'; return {}; }, 'NO_OPEN_CASH_SESSION'],
      ['other branch', (t) => { t.register.branchId = uuid(); return {}; }, 'CASH_SESSION_BRANCH_MISMATCH'],
    ];
    for (const [label, patch, code] of cases) {
      const t = setup({ splitHold: true });
      const req = t.request(undefined, patch(t));
      const before = state(t);
      const mark = t.db.ops.length;
      expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, req)), label).toMatchObject({ status: 409, code });
      expect(locks(t, mark), label).toEqual(['Sale', 'ExternalCollection', 'CashSession']);
      expect(t.db.writesSince(mark), label).toEqual([]);
      expect(state(t), label).toEqual(before);
    }
  });

  it('RR-B16 an exact unexpired coverage writes no stock, but the fresh attempt still commits with exactly ONE Sale bump and only CHECKOUT_RESERVED', async () => {
    const t = setup();
    const holdsBefore = structuredClone(t.db.table('stockReservation'));
    const inventoryBefore = structuredClone(t.db.table('inventory'));
    const mark = t.db.ops.length;
    expect(await t.service.reserve(t.asOwner, t.sale.id as string, t.request())).toMatchObject(FRESH);
    expect(t.db.writesSince(mark).filter((op) => op.model === 'stockReservation' || op.model === 'inventory')).toEqual([]);
    expect(t.db.table('stockReservation')).toEqual(holdsBefore);
    expect(t.db.table('inventory')).toEqual(inventoryBefore);
    expect(touches(t, mark)).toHaveLength(1);
    expect(t.db.table('sale')[0]!.updatedAt).toEqual(NOW);
    expect(actions(t)).toEqual(['CHECKOUT_RESERVED']);
  });

  it('RR-B17 a split, or sweeper-RELEASED, coverage is recovered: old ACTIVE released, a new ACTIVE at now + TTL, Inventory = newReserved, both audits', async () => {
    const split = setup({ splitHold: true });
    expect(await split.service.reserve(split.asOwner, split.sale.id as string, split.request())).toMatchObject(FRESH);
    expect(split.db.table('stockReservation').find((row) => row.id === split.hold.id)!.status).toBe('RELEASED');
    const active = split.db.table('stockReservation').filter((row) => row.status === 'ACTIVE');
    expect(active.map((row) => [row.variantId, row.quantity, row.branchId, row.expiresAt])).toEqual([['v1', 2n, split.branch, NEW_EXPIRY]]);
    expect(split.db.table('inventory')[0]!.reserved).toBe(2n);
    expect(actions(split)).toEqual(['CHECKOUT_RESERVED', 'CHECKOUT_STOCK_RECOVERED']);

    const released = setup();
    released.hold.status = 'RELEASED';
    released.inventory.reserved = 0n;
    expect(await released.service.reserve(released.asOwner, released.sale.id as string, released.request())).toMatchObject(FRESH);
    expect(released.db.table('stockReservation').filter((row) => row.status === 'ACTIVE').map((row) => [row.variantId, row.quantity])).toEqual([['v1', 2n]]);
    expect(released.db.table('inventory')[0]!.reserved).toBe(2n);
    expect(actions(released)).toEqual(['CHECKOUT_RESERVED', 'CHECKOUT_STOCK_RECOVERED']);
  });

  it('RR-B18 a changed quote is 409 CHECKOUT_QUOTE_CHANGED {total, balance} after the stock evaluation and before ANY write: no stock, attempt, tender, claim, bump or audit', async () => {
    const t = setup({ splitHold: true });
    const req = t.request(undefined, { expectedTotal: 9999n });
    const quoted = t.quote(req.tenders);
    const before = state(t);
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, req)))
      .toEqual({ status: 409, code: 'CHECKOUT_QUOTE_CHANGED', details: { total: quoted.total, balance: quoted.balance.amount } });
    expect(locks(t, mark)).toEqual(['Sale', 'ExternalCollection', 'CashSession', 'StockReservation', 'Inventory']);
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(state(t)).toEqual(before);
  });

  it('RR-B19 a shortage is 409 INSUFFICIENT_STOCK {variantId} with zero writes', async () => {
    const t = setup();
    t.hold.status = 'RELEASED';
    Object.assign(t.inventory, { physical: 1n, reserved: 0n });
    const before = state(t);
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request())))
      .toEqual({ status: 409, code: 'INSUFFICIENT_STOCK', details: { variantId: 'v1' } });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(state(t)).toEqual(before);
  });

  it('RR-B20 a claim that matches fewer rows than U_origin is 500 CHECKOUT_STATE_INCONSISTENT and rolls EVERYTHING back (stock, bump, attempt, tenders)', async () => {
    const t = setup({ splitHold: true });
    const before = state(t);
    // A peer claims the collection between our lock read and our claim. (The
    // double fires — and drops — every pending hook at the FIRST create of any
    // model; here that is the new stock hold, after the collection lock.)
    t.db.concurrently('stockReservation', 'create', () => {
      t.db.table('externalCollection').find((row) => row.id === t.origin.id)!.claimAttemptId = 'peer';
    });
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request()))).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    expect(t.db.transactions).toHaveLength(1);
    const after = state(t);
    expect({ ...after, collections: before.collections }).toEqual(before);
    expect(after.collections.find((row) => row.id === t.origin.id)!.claimAttemptId).toBe('peer');
  });

  it('RR-B21 a failing CHECKOUT_RESERVED audit, or a failing CHECKOUT_STOCK_RECOVERED audit, rolls everything back', async () => {
    for (const action of ['CHECKOUT_RESERVED', 'CHECKOUT_STOCK_RECOVERED']) {
      const t = setup({ splitHold: true });
      auditDown(t, action);
      const before = state(t);
      await expect(t.service.reserve(t.asOwner, t.sale.id as string, t.request())).rejects.toThrow(`audit ${action} down`);
      expect(state(t), action).toEqual(before);
    }
  });

  it('RR-B22 P2002 on reserveKey: re-read in a NEW Serializable transaction (Sale lock, RBAC, T-RR replay) — a matching peer is replayed with its operationKey; any other peer is the generic 409', async () => {
    const matching = setup({ splitHold: true });
    const req = matching.request();
    let peer: Row = {};
    // The peer commits after our replay check, before our attempt INSERT (the
    // double fires pending hooks at the first create: the new stock hold).
    matching.db.concurrently('stockReservation', 'create', () => { peer = matching.persisted(req); });
    const before = state(matching);
    const result = await matching.service.reserve(matching.asOwner, matching.sale.id as string, req);
    expect(result).toMatchObject({ replayed: true, view: { reserveKey: req.reserveKey, operationKey: peer.operationKey } });
    expect(matching.db.transactions).toEqual(Array(2).fill({ isolationLevel: 'Serializable', timeout: 30_000 }));
    expect(steps(matching, lastBegin(matching))).toEqual(['lock:Sale']);
    // Our attempt rolled back entirely; only the peer's committed rows remain.
    const after = state(matching);
    expect(after.attempts.map((row) => row.id)).toEqual([peer.id]);
    expect({ ...after, attempts: before.attempts, tenders: before.tenders }).toEqual(before);

    for (const recovery of [{ ...RECOVERY, evidence: 'otra evidencia' }, null]) {
      const t = setup();
      const mine = t.request();
      t.db.concurrently('checkoutAttempt', 'create', () => { t.persisted({ ...mine, recovery }); });
      expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, mine)), JSON.stringify(recovery)).toEqual(GENERIC_409);
      expect(t.db.table('auditLog')).toEqual([]);
    }
  });

  it('RR-B23 P2002 on one-open-per-sale is resolved to 409 CHECKOUT_RESERVATION_OPEN by a coherent re-read; an unconfirmable P2002 keeps the original error', async () => {
    const t = setup();
    t.db.concurrently('checkoutAttempt', 'create', () => { t.persisted({ ...t.request(), recovery: null }); });
    expect(await codeOf(t.service.reserve(t.asOwner, t.sale.id as string, t.request()))).toMatchObject({ status: 409, code: 'CHECKOUT_RESERVATION_OPEN' });
    expect(t.db.transactions).toHaveLength(2);

    const ghost = setup();
    ghost.db.failOn('checkoutAttempt', 'create', () => p2002('CheckoutAttempt_one_open_per_sale'));
    await expect(ghost.service.reserve(ghost.asOwner, ghost.sale.id as string, ghost.request())).rejects.toMatchObject({ code: 'P2002' });
    expect(ghost.db.table('checkoutAttempt')).toEqual([]);
  });

  it('RR-B24k a transient failure AFTER the writes rolls attempt 1 back and the retry commits cleanly: one attempt, one claim set, one bump, no duplicated audit', async () => {
    const t = setup({ splitHold: true });
    t.db.failOn('auditLog', 'create', () => Object.assign(new Error('could not serialize'), { code: 'P2034' }));
    expect(await t.service.reserve(t.asOwner, t.sale.id as string, t.request())).toMatchObject(FRESH);
    expect(t.db.transactions).toHaveLength(2);
    const [attempt, ...others] = t.db.table('checkoutAttempt');
    expect(others).toEqual([]);
    expect(t.db.table('checkoutAttemptTender')).toHaveLength(2);
    expect(t.db.table('externalCollection').filter((row) => row.claimAttemptId !== null).map((row) => [row.id, row.claimAttemptId])).toEqual([[t.origin.id, attempt!.id]]);
    expect(touches(t, lastBegin(t))).toHaveLength(1);
    expect(actions(t)).toEqual(['CHECKOUT_RESERVED', 'CHECKOUT_STOCK_RECOVERED']);
    expect(t.db.table('stockReservation').filter((row) => row.status === 'ACTIVE')).toHaveLength(1);
    expect(t.db.table('inventory')[0]!.reserved).toBe(2n);
  });

  it('RR-B26k exact order: Sale → EC → CashSession → SR → Inventory → stock writes → Sale bump → attempt → tenders → claims → seal → audits', async () => {
    const t = setup({ splitHold: true });
    const mark = t.db.ops.length;
    await t.service.reserve(t.asOwner, t.sale.id as string, t.request());
    expect(steps(t, mark)).toEqual([
      'lock:Sale', 'lock:ExternalCollection', 'lock:CashSession', 'lock:StockReservation', 'lock:Inventory',
      'updateMany:stockReservation', 'updateMany:inventory', 'create:stockReservation',
      'touch:Sale',
      'create:checkoutAttempt', 'create:checkoutAttemptTender', 'create:checkoutAttemptTender',
      'updateMany:externalCollection', 'update:checkoutAttempt',
      'create:auditLog', 'create:auditLog',
    ]);
    // Created unsealed; the seal is the only attempt update and touches nothing else.
    const writes = t.db.writesSince(mark);
    expect(writes.find((op) => op.model === 'checkoutAttempt' && op.kind === 'create')!.detail).toMatchObject({ planSealed: false });
    expect((writes.find((op) => op.model === 'checkoutAttempt' && op.kind === 'update')!.detail as { data: Row }).data).toEqual({ planSealed: true });
  });

  it('RR-B27k exact audit payloads: CHECKOUT_RESERVED = the T-R payload + recovery/reason/evidence; CHECKOUT_STOCK_RECOVERED = the T-S format on the NEW attempt; the ordinary T-R payload is unchanged', async () => {
    const t = setup({ splitHold: true });
    const req = t.request();
    await t.service.reserve(t.asCompanyAdmin, t.sale.id as string, req);
    const attempt = t.db.table('checkoutAttempt')[0]!;
    const newHold = t.db.table('stockReservation').find((row) => row.status === 'ACTIVE')!;
    const [reserved, recovered] = t.db.table('auditLog');
    const admin = userOf(t.asCompanyAdmin);
    expect(reserved).toMatchObject({ action: 'CHECKOUT_RESERVED', entityType: 'CheckoutAttempt', entityId: attempt.id, userId: admin, branchId: t.branch });
    expect(reserved!.after).toEqual({
      saleId: t.sale.id, reserveKey: req.reserveKey, operationKey: attempt.operationKey, planHash: t.hashOf(req), cashSessionId: t.session.id,
      balanceMethod: 'CASH', expectedTotal: String(req.expectedTotal), expectedBalanceAmount: String(req.expectedBalanceAmount),
      tenders: [
        { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
        { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: '3000', externalCollectionId: t.origin.id },
      ],
      claimedCollectionIds: [t.origin.id], pricingConfigId: t.pricingConfig.id,
      recovery: true, reason: RECOVERY.reason, evidence: RECOVERY.evidence,
    });
    expect(recovered).toMatchObject({ action: 'CHECKOUT_STOCK_RECOVERED', entityType: 'CheckoutAttempt', entityId: attempt.id, userId: admin, branchId: t.branch });
    expect(recovered!.before).toEqual({
      reserveKey: req.reserveKey, stockState: 'VALID',
      // The audit lists the released holds by id ASC; ids are random UUIDs, so the expectation sorts too.
      released: [t.hold, t.secondHold!].map((row) => ({ id: row.id as string, variantId: 'v1', quantity: '1', expiresAt: LATER }))
        .sort((left, right) => (left.id < right.id ? -1 : 1)),
    });
    expect(recovered!.after).toEqual({
      reserveKey: req.reserveKey, reason: RECOVERY.reason, evidence: RECOVERY.evidence,
      created: [{ id: newHold.id, variantId: 'v1', quantity: '2', expiresAt: NEW_EXPIRY }],
      reservedDeltaByVariant: [{ variantId: 'v1', beforeReserved: '2', afterReserved: '2', delta: '0' }],
      expiresAt: NEW_EXPIRY,
    });

    // The ordinary T-R (recovery: null) keeps its exact CHECKOUT_RESERVED keys.
    const ordinary = setup();
    await ordinary.service.reserve(ordinary.asOwner, ordinary.sale.id as string, { ...ordinary.request(), recovery: null });
    expect(Object.keys(ordinary.db.table('auditLog')[0]!.after as Row).sort()).toEqual([
      'balanceMethod', 'cashSessionId', 'claimedCollectionIds', 'expectedBalanceAmount', 'expectedTotal', 'operationKey', 'planHash',
      'pricingConfigId', 'reserveKey', 'saleId', 'tenders',
    ]);
  });

  it('RR-B33 the claim is exactly U_origin, NULL → the new attempt, guarded by UNAPPLIED + unclaimed; nothing else is claimed', async () => {
    const t = setup();
    const card = t.collection({ method: 'CARD_DEBIT', amount: 2000n });
    const foreign = t.collection({ originSaleId: uuid() });
    const otherBranch = t.collection({ branchId: uuid() });
    const mark = t.db.ops.length;
    await t.service.reserve(t.asOwner, t.sale.id as string, t.request([t.cashBalance, t.collect(t.origin), t.collect(card)]));
    const attempt = t.db.table('checkoutAttempt')[0]!;
    const claims = t.db.writesSince(mark).filter((op) => op.model === 'externalCollection');
    expect(claims).toEqual([{
      kind: 'updateMany', model: 'externalCollection',
      detail: { where: { id: { in: [t.origin.id, card.id].sort() }, status: 'UNAPPLIED', claimAttemptId: null }, data: { claimAttemptId: attempt.id }, count: 2 },
    }]);
    const claimOf = (row: Row) => t.db.table('externalCollection').find((candidate) => candidate.id === row.id)!.claimAttemptId;
    expect([claimOf(t.origin), claimOf(card), claimOf(foreign), claimOf(otherBranch)]).toEqual([attempt.id, attempt.id, null, null]);
  });

  it('RR-B34 the same T-RR right after its fresh success is replayed: same operationKey, zero writes', async () => {
    const t = setup({ splitHold: true });
    const req = t.request();
    const first = await t.service.reserve(t.asOwner, t.sale.id as string, req);
    const mark = t.db.ops.length;
    const again = await t.service.reserve(t.asOwner, t.sale.id as string, req);
    expect(again).toMatchObject({ replayed: true, view: { operationKey: first.view.operationKey, stockState: 'VALID' } });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(touches(t, mark)).toEqual([]);
    expect(t.db.table('checkoutAttempt')).toHaveLength(1);
  });

  it('RR-B35 the balance of a T-RR is CASH: balanceMethod CASH and exactly one BALANCE tender, CASH/NEW; a non-cash balance is refused before any lock beyond the Sale', async () => {
    const t = setup();
    await t.service.reserve(t.asOwner, t.sale.id as string, t.request());
    const attempt = t.db.table('checkoutAttempt')[0]!;
    expect(attempt.balanceMethod).toBe('CASH');
    const balances = t.db.table('checkoutAttemptTender').filter((row) => row.attemptId === attempt.id && row.role === 'BALANCE');
    expect(balances.map((row) => [row.method, row.source, row.amount, row.externalCollectionId])).toEqual([['CASH', 'NEW', null, null]]);

    const transfer = setup();
    transfer.origin.method = 'CARD_DEBIT';
    const plan: PlanTenderInput[] = [{ method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }, transfer.collect(transfer.origin)];
    const mark = transfer.db.ops.length;
    expect(await codeOf(transfer.service.reserve(transfer.asOwner, transfer.sale.id as string, transfer.request(plan))))
      .toMatchObject({ status: 409, code: 'RECOVERY_RESERVATION_NOT_APPLICABLE' });
    expect(locks(transfer, mark)).toEqual(['Sale']);
  });
});
