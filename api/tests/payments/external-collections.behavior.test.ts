// R3-A4.3 S-REF — T-F, the refund of an ExternalCollection
// (POST /api/v1/external-collections/:id/refund) and the branch listing
// (GET /api/v1/external-collections), against the DB-free double
// tests/helpers/checkout-reservation-fake-db.ts.
//
// Approved OWNER design: ONE READ COMMITTED transaction, NO NOWAIT, NO retries,
// NO CheckoutAttempt lock, NO cash/stock write, amount taken ONLY from the
// locked ExternalCollection row (BigInt end-to-end, no partial refund).
// Lock order: ExternalCollection (FOR UPDATE) -> permission -> state -> write ->
// audit -> COMMIT.
//
// What PostgreSQL alone can prove (the F6 trigger, chk_ec_status /
// chk_ec_refund_fields / chk_ec_claim_state, the partial unique indexes, the
// REAL row lock under contention) stays in the opt-in
// external-collections-refund.pg.test.ts (P36–P40, NOT RUN here).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createExternalCollectionsService } from '../../src/modules/payments/external-collections.service.js';
import type { ExternalCollectionRefundRequest } from '../../src/modules/payments/dto/external-collection-refund.dto.js';
import { createCheckoutReservationFakeDb, type Row } from '../helpers/checkout-reservation-fake-db.js';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const PAST = new Date(NOW.getTime() - 60_000);
const SERVICE_PATH = new URL('../../src/modules/payments/external-collections.service.ts', import.meta.url);
const uuid = () => randomUUID();

type Role = 'CASHIER' | 'SELLER' | 'ADMIN' | 'OWNER';
function auth(userId: string, role: Role, locationId: string | null, permissions?: string[]) {
  const grants = permissions ?? (role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[role]]);
  return {
    auth: {
      userId, roles: [role], effectiveLocationIds: locationId ? [locationId] : [],
      assignments: [{ roleId: role, roleCode: role, scopeKind: locationId ? 'LOCATION' : 'COMPANY', locationId, permissions: grants }],
    },
  } as never;
}

function setup() {
  const db = createCheckoutReservationFakeDb({ now: () => NOW });
  const branch = uuid();
  const otherBranch = uuid();
  const owner = db.insert('user', { id: uuid(), name: 'Dueño' });
  const admin = db.insert('user', { id: uuid(), name: 'Admin' });
  const otherAdmin = db.insert('user', { id: uuid(), name: 'Admin 2' });
  const cashier = db.insert('user', { id: uuid(), name: 'Caja' });
  const seller = db.insert('user', { id: uuid(), name: 'Vendedor' });
  const service = createExternalCollectionsService(db.client as unknown as PrismaClient, { now: () => NOW });
  const collection = (patch: Row = {}) => db.insert('externalCollection', {
    id: uuid(), branchId: branch, method: 'TRANSFER', amount: 25000n, reference: 'OP 123', referenceKey: 'OP123',
    institution: 'GALICIA', institutionOther: null, status: 'UNAPPLIED', originSaleId: null, originAttemptId: null,
    cashSessionId: null, recordedById: cashier.id, recordedAt: NOW, resolvedById: null, resolvedAt: null,
    refundReference: null, resolutionNote: null, externalRefundedAt: null, claimAttemptId: null, ...patch,
  });
  const request = (patch: Partial<ExternalCollectionRefundRequest> = {}): ExternalCollectionRefundRequest => ({
    refundReference: 'REF-001', externalRefundedAt: PAST, reason: 'devolución acordada con el cliente', ...patch,
  });
  return {
    db, branch, otherBranch, owner, admin, otherAdmin, cashier, seller, service, collection, request,
    asOwner: auth(owner.id as string, 'OWNER', null),
    asAdmin: auth(admin.id as string, 'ADMIN', null),
    asOtherAdmin: auth(otherAdmin.id as string, 'ADMIN', null),
    asLocationAdmin: auth(admin.id as string, 'ADMIN', branch),
    asCashier: auth(cashier.id as string, 'CASHIER', branch),
    asSeller: auth(seller.id as string, 'SELLER', branch),
  };
}

const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return null; } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.status, code: error.code, details: error.details };
  }
};

const refunded = (t: ReturnType<typeof setup>, patch: Row = {}) => t.collection({
  status: 'REFUNDED', resolvedById: t.admin.id, resolvedAt: NOW, refundReference: 'REF-001',
  resolutionNote: 'devolución acordada con el cliente', externalRefundedAt: PAST, claimAttemptId: null, ...patch,
});

describe('R3-A4.3 S-REF — T-F refund (DB-free)', () => {
  it('REF-B-01 a fresh refund: UNAPPLIED -> REFUNDED in ONE READ COMMITTED transaction, locking only the collection; audit before/after', async () => {
    const t = setup();
    const ec = t.collection();
    const mark = t.db.ops.length;
    const result = await t.service.refund(t.asAdmin, ec.id as string, t.request());
    expect(result.replayed).toBe(false);
    expect(result.collection).toMatchObject({ id: ec.id, status: 'REFUNDED', amount: 25000n, refundReference: 'REF-001', resolutionNote: 'devolución acordada con el cliente' });
    expect(t.db.transactions).toEqual([{ isolationLevel: 'ReadCommitted', timeout: 30_000 }]);
    const row = t.db.table('externalCollection')[0]!;
    expect(row).toMatchObject({
      status: 'REFUNDED', resolvedById: t.admin.id, resolvedAt: NOW, refundReference: 'REF-001',
      resolutionNote: 'devolución acordada con el cliente', externalRefundedAt: PAST, claimAttemptId: null,
    });
    // Only the collection is locked (never a CheckoutAttempt, never NOWAIT).
    expect(t.db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model)).toEqual(['ExternalCollection']);
    const [audit] = t.db.table('auditLog');
    expect(audit).toMatchObject({
      action: 'EXTERNAL_COLLECTION_REFUNDED', entityType: 'ExternalCollection', entityId: ec.id,
      userId: t.admin.id, branchId: t.branch,
    });
    expect(audit!.before).toMatchObject({ status: 'UNAPPLIED' });
    expect(audit!.after).toMatchObject({ status: 'REFUNDED', resolvedById: t.admin.id, refundReference: 'REF-001' });
  });

  it('REF-B-02 the amount is the locked collection amount, exact BigInt, never a partial refund', async () => {
    const t = setup();
    const ec = t.collection({ amount: 123457n });
    const result = await t.service.refund(t.asAdmin, ec.id as string, t.request());
    expect(result.collection.amount).toBe(123457n);
    expect(t.db.table('externalCollection')[0]!.amount).toBe(123457n);
    // The REQUEST never carries an amount; the audit records only the row's own
    // amount, as a JSON-safe string (SREF-F11), never a Number.
    expect(t.db.table('auditLog')[0]!.after).toMatchObject({ amount: '123457' });
    expect(t.db.table('auditLog')[0]!.before).toMatchObject({ amount: '123457' });
  });

  it('REF-B-03 a claimed UNAPPLIED collection is 409 EXTERNAL_COLLECTION_CLAIMED and is never written', async () => {
    const t = setup();
    const ec = t.collection({ claimAttemptId: uuid() });
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.refund(t.asAdmin, ec.id as string, t.request())))
      .toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_CLAIMED' });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('externalCollection')[0]!.status).toBe('UNAPPLIED');
  });

  it('REF-B-04 an APPLIED collection is 409 EXTERNAL_COLLECTION_ALREADY_APPLIED and is never written', async () => {
    const t = setup();
    const ec = t.collection({ status: 'APPLIED', appliedCheckoutId: uuid(), appliedSaleId: uuid(), claimAttemptId: null });
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.refund(t.asAdmin, ec.id as string, t.request())))
      .toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_ALREADY_APPLIED' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('REF-B-05 an identical replay by the same supervisor is a zero-write, zero-audit 200', async () => {
    const t = setup();
    const ec = refunded(t);
    const mark = t.db.ops.length;
    const audits = t.db.table('auditLog').length;
    const result = await t.service.refund(t.asAdmin, ec.id as string, t.request());
    expect(result).toMatchObject({ replayed: true });
    expect(result.collection.status).toBe('REFUNDED');
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('auditLog')).toHaveLength(audits);
  });

  it('REF-B-06 an identical replay by ANOTHER authorized supervisor is also a zero-write, zero-audit 200: the actor is not part of the identity', async () => {
    const t = setup();
    const ec = refunded(t, { resolvedById: t.admin.id });
    const mark = t.db.ops.length;
    const result = await t.service.refund(t.asOtherAdmin, ec.id as string, t.request());
    expect(result).toMatchObject({ replayed: true });
    expect(t.db.writesSince(mark)).toEqual([]);
    // resolvedById is NEVER rewritten by the replaying actor.
    expect(t.db.table('externalCollection')[0]!.resolvedById).toBe(t.admin.id);
  });

  it('REF-B-07 a replay with a different refundReference is 409 EXTERNAL_COLLECTION_ALREADY_REFUNDED, zero writes', async () => {
    const t = setup();
    const ec = refunded(t);
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.refund(t.asAdmin, ec.id as string, t.request({ refundReference: 'REF-999' }))))
      .toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_ALREADY_REFUNDED' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('REF-B-08 a replay with a different externalRefundedAt is 409, zero writes', async () => {
    const t = setup();
    const ec = refunded(t);
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.refund(t.asAdmin, ec.id as string, t.request({ externalRefundedAt: new Date(PAST.getTime() - 1000) }))))
      .toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_ALREADY_REFUNDED' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('REF-B-09 a replay with a different reason is 409, zero writes', async () => {
    const t = setup();
    const ec = refunded(t);
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.refund(t.asAdmin, ec.id as string, t.request({ reason: 'otro motivo distinto del original' }))))
      .toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_ALREADY_REFUNDED' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('REF-B-10 an externalRefundedAt in the future is 400 BEFORE the UPDATE, zero writes', async () => {
    const t = setup();
    const ec = t.collection();
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.refund(t.asAdmin, ec.id as string, t.request({ externalRefundedAt: new Date(NOW.getTime() + 1000) }))))
      .toMatchObject({ status: 400 });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('externalCollection')[0]!.status).toBe('UNAPPLIED');
  });

  it('REF-B-11 externalRefundedAt exactly equal to the single server resolvedAt is accepted', async () => {
    const t = setup();
    const ec = t.collection();
    const result = await t.service.refund(t.asAdmin, ec.id as string, t.request({ externalRefundedAt: NOW }));
    expect(result.replayed).toBe(false);
    expect(t.db.table('externalCollection')[0]).toMatchObject({ externalRefundedAt: NOW, resolvedAt: NOW });
  });

  it('REF-B-12 the refund permission is the supervisor on the locked ec.branchId; nothing else qualifies', async () => {
    const cases: Array<[string, () => ReturnType<typeof setup>['asAdmin']]> = [];
    // OWNER and a COMPANY ADMIN succeed.
    for (const as of ['asOwner', 'asAdmin'] as const) {
      const t = setup();
      const ec = t.collection();
      const result = await t.service.refund(t[as], ec.id as string, t.request());
      expect(result.replayed, as).toBe(false);
      expect(t.db.table('externalCollection')[0]!.status).toBe('REFUNDED');
    }
    // A LOCATION ADMIN, a CASHIER (even holding SALE_CHARGE/SALE_CANCEL_PENDING),
    // a pure SALE_CHARGE holder and a supervisor assignment in ANOTHER branch all fail.
    const denied = [
      (t: ReturnType<typeof setup>) => t.asLocationAdmin,
      (t: ReturnType<typeof setup>) => t.asCashier,
      (t: ReturnType<typeof setup>) => auth(t.seller.id as string, 'CASHIER', t.branch, ['SALE_CHARGE']),
      (t: ReturnType<typeof setup>) => auth(t.seller.id as string, 'ADMIN', t.otherBranch),
    ];
    for (const pick of denied) {
      const t = setup();
      const ec = t.collection();
      const mark = t.db.ops.length;
      expect(await codeOf(t.service.refund(pick(t), ec.id as string, t.request()))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(t.db.writesSince(mark)).toEqual([]);
      expect(t.db.table('externalCollection')[0]!.status).toBe('UNAPPLIED');
    }
    void cases;
  });

  it('REF-B-13 an unknown collection id is 404 and writes nothing', async () => {
    const t = setup();
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.refund(t.asAdmin, uuid(), t.request()))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('REF-B-14 a failing audit rolls the whole refund back', async () => {
    const t = setup();
    const ec = t.collection();
    t.db.failOn('auditLog', 'create', () => new Error('audit down'), false);
    await expect(t.service.refund(t.asAdmin, ec.id as string, t.request())).rejects.toThrow('audit down');
    expect(t.db.ops.at(-1)).toEqual({ kind: 'rollback' });
    expect(t.db.table('externalCollection')[0]).toMatchObject({ status: 'UNAPPLIED', resolvedById: null, resolvedAt: null, refundReference: null, resolutionNote: null, externalRefundedAt: null });
    expect(t.db.table('auditLog')).toHaveLength(0);
  });

  it('REF-B-15 the refund writes no cash, stock, sale, checkout or attempt row', async () => {
    const t = setup();
    const ec = t.collection();
    const mark = t.db.ops.length;
    await t.service.refund(t.asAdmin, ec.id as string, t.request());
    const models = t.db.writesSince(mark).map((op) => op.model);
    for (const forbidden of ['cashSession', 'cashMovement', 'cashRegister', 'stockReservation', 'inventory', 'stockMovement', 'salePayment', 'saleCheckout', 'checkoutAttempt', 'sale']) {
      expect(models, forbidden).not.toContain(forbidden);
    }
    expect(models).toEqual(['externalCollection', 'auditLog']);
  });

  it('REF-B-16 the lock is a plain FOR UPDATE on the collection only: no NOWAIT, no CheckoutAttempt lock, no retry', async () => {
    const t = setup();
    const ec = t.collection();
    await t.service.refund(t.asAdmin, ec.id as string, t.request());
    const locks = t.db.ops.filter((op) => op.kind === 'lock');
    expect(locks.map((op) => op.model)).toEqual(['ExternalCollection']);
    expect(JSON.stringify(locks)).not.toMatch(/NOWAIT/i);
    expect(t.db.transactions).toHaveLength(1);
    const source = readFileSync(SERVICE_PATH, 'utf8');
    expect(source).not.toMatch(/FOR UPDATE NOWAIT/);
    expect(source).not.toMatch(/P2034|40001|40P01|RETRY|retry/);
  });

  it('REF-B-17 the replay identity is the canonical reference + date + reason, never the actor or resolvedById', async () => {
    const t = setup();
    // The stored raw reference normalises to the same key as the incoming one.
    const ec = refunded(t, { refundReference: 'ref 001' });
    const mark = t.db.ops.length;
    const result = await t.service.refund(t.asAdmin, ec.id as string, t.request({ refundReference: 'REF-001' }));
    expect(result).toMatchObject({ replayed: true });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('REF-B-18 the refund service is deterministic: no env, no floats, no realtime, no clock read outside the injected now', () => {
    const source = readFileSync(SERVICE_PATH, 'utf8');
    expect(source).not.toMatch(/process\.env|DATABASE_URL|TEST_DATABASE_URL/);
    expect(source).not.toMatch(/\bNumber\(|parseFloat|parseInt|toFixed|Math\./);
    expect(source).not.toMatch(/RealtimeEmitter|realtime\/socket|\.emit\(/);
  });

  // R3-A4.3 S-REF.1 (A2/A4): audit snapshot, error codes and lock order.
  it('SREF-F10 a valid but future externalRefundedAt is refused with the exact code EXTERNAL_REFUND_DATE_IN_FUTURE before any write', async () => {
    const t = setup();
    const ec = t.collection();
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.refund(t.asAdmin, ec.id as string, t.request({ externalRefundedAt: new Date(NOW.getTime() + 1) }))))
      .toMatchObject({ status: 400, code: 'EXTERNAL_REFUND_DATE_IN_FUTURE' });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('externalCollection')[0]).toMatchObject({ status: 'UNAPPLIED', resolvedAt: null });
  });

  it('SREF-F11 the audit snapshot carries the exact amount as a JSON-safe string in BOTH before and after (never Number)', async () => {
    const t = setup();
    const ec = t.collection({ amount: 123457n });
    await t.service.refund(t.asAdmin, ec.id as string, t.request());
    const [audit] = t.db.table('auditLog');
    expect(audit!.before).toMatchObject({ amount: '123457' });
    expect(audit!.after).toMatchObject({ amount: '123457' });
    expect(typeof (audit!.before as Row).amount).toBe('string');
    expect(typeof (audit!.after as Row).amount).toBe('string');
  });

  it('SREF-F12 before/after snapshot the identity, the method, the reference and the origin context', async () => {
    const t = setup();
    const originSaleId = uuid();
    const cashSessionId = uuid();
    const ec = t.collection({ originSaleId, cashSessionId, recordedById: t.cashier.id });
    await t.service.refund(t.asAdmin, ec.id as string, t.request());
    const [audit] = t.db.table('auditLog');
    const common = {
      id: ec.id, branchId: t.branch, method: 'TRANSFER', amount: '25000', reference: 'OP 123', referenceKey: 'OP123',
      originSaleId, originAttemptId: null, cashSessionId, claimAttemptId: null,
    };
    expect(audit!.before).toMatchObject({ ...common, status: 'UNAPPLIED', resolvedById: null, resolvedAt: null, refundReference: null, resolutionNote: null, externalRefundedAt: null });
    expect(audit!.after).toMatchObject({ ...common, status: 'REFUNDED', resolvedById: t.admin.id, resolvedAt: NOW, refundReference: 'REF-001', resolutionNote: 'devolución acordada con el cliente', externalRefundedAt: PAST });
  });

  it('SREF-F13 an identical replay creates no second audit and leaves the original snapshot intact', async () => {
    const t = setup();
    const ec = refunded(t);
    const audits = t.db.table('auditLog');
    const before = [...audits];
    const result = await t.service.refund(t.asOtherAdmin, ec.id as string, t.request());
    expect(result.replayed).toBe(true);
    expect(t.db.table('auditLog')).toHaveLength(before.length);
    expect(t.db.table('externalCollection')[0]).toMatchObject({ resolvedById: t.admin.id });
  });

  it('SREF-F14 a failing audit rolls the whole refund back: no row change, no audit, no half snapshot', async () => {
    const t = setup();
    const ec = t.collection();
    t.db.failOn('auditLog', 'create', () => new Error('audit down'));
    await expect(t.service.refund(t.asAdmin, ec.id as string, t.request())).rejects.toThrow('audit down');
    expect(t.db.ops.at(-1)).toEqual({ kind: 'rollback' });
    expect(t.db.table('externalCollection')[0]).toMatchObject({ status: 'UNAPPLIED', resolvedById: null, resolvedAt: null, refundReference: null, resolutionNote: null, externalRefundedAt: null });
    expect(t.db.table('auditLog')).toHaveLength(0);
  });

  it('SREF-F15 the collection lock happens BEFORE the RBAC check: a refused actor still locked the row first', async () => {
    const t = setup();
    const ec = t.collection();
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.refund(t.asCashier, ec.id as string, t.request())))
      .toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const sequence = t.db.ops.slice(mark).map((op) => `${op.kind}:${op.model ?? ''}`);
    expect(sequence).toEqual(['begin:', 'lock:ExternalCollection', 'rollback:']);
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('SREF-F16 an impossible persisted status fails closed with 500 EXTERNAL_COLLECTION_STATE_INCONSISTENT, never a raw DB check', async () => {
    const t = setup();
    const ec = t.collection({ status: 'ARCHIVED' });
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.refund(t.asAdmin, ec.id as string, t.request())))
      .toMatchObject({ status: 500, code: 'EXTERNAL_COLLECTION_STATE_INCONSISTENT' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });
});

describe('R3-A4.3 S-REF — GET listing (DB-free)', () => {
  it('REF-B-19 a supervisor at the branch lists the whole branch, filtered by status and limit', async () => {
    const t = setup();
    t.collection({ recordedById: t.cashier.id });
    t.collection({ recordedById: t.admin.id, status: 'APPLIED', appliedCheckoutId: uuid(), appliedSaleId: uuid() });
    t.collection({ branchId: t.otherBranch, recordedById: t.admin.id });
    const all = await t.service.list(t.asAdmin, { branchId: t.branch, status: null, limit: 100 });
    expect(all.items).toHaveLength(2);
    const applied = await t.service.list(t.asAdmin, { branchId: t.branch, status: 'APPLIED', limit: 100 });
    expect(applied.items.map((item) => item.status)).toEqual(['APPLIED']);
    const limited = await t.service.list(t.asAdmin, { branchId: t.branch, status: null, limit: 1 });
    expect(limited.items).toHaveLength(1);
  });

  it('REF-B-20 a SALE_CHARGE holder without supervisor authority sees only its own recorded rows', async () => {
    const t = setup();
    t.collection({ recordedById: t.cashier.id });
    t.collection({ recordedById: t.admin.id });
    const mine = await t.service.list(t.asCashier, { branchId: t.branch, status: null, limit: 100 });
    expect(mine.items.map((item) => item.recordedById)).toEqual([t.cashier.id]);
    // OWNER is a supervisor and sees the whole branch.
    expect((await t.service.list(t.asOwner, { branchId: t.branch, status: null, limit: 100 })).items).toHaveLength(2);
  });

  it('REF-B-21 a caller with no authority at the branch is 403 and reads nothing', async () => {
    const t = setup();
    t.collection();
    const mark = t.db.ops.length;
    expect(await codeOf(t.service.list(t.asSeller, { branchId: t.branch, status: null, limit: 100 }))).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(t.db.ops.slice(mark).filter((op) => op.kind !== 'begin' && op.kind !== 'rollback')).toEqual([]);
  });

  it('REF-B-22 the listing never returns a row of another branch and never writes', async () => {
    const t = setup();
    t.collection();
    t.collection({ branchId: t.otherBranch });
    const mark = t.db.ops.length;
    const result = await t.service.list(t.asAdmin, { branchId: t.branch, status: null, limit: 100 });
    expect(result.items.every((item) => item.branchId === t.branch)).toBe(true);
    expect(t.db.writesSince(mark)).toEqual([]);
  });
});
