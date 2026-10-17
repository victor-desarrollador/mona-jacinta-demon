// R3-A4.3 S-REF — T-F (the ExternalCollection refund) on a REAL PostgreSQL.
// OPT-IN ONLY; NOT authorized and NOT executed in this slice. What only
// PostgreSQL proves: the F6 trigger accepting UNAPPLIED -> REFUNDED exactly
// once, chk_ec_status / chk_ec_refund_fields / chk_ec_claim_state (SQLSTATE
// 23514) refusing an invalid resolution, the real row lock serialising two
// refunds of the same collection, and the fail-closed gate of
// PROPORTIONAL_EXTERNAL_METHODS_ENABLED.
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster with
// migrations 1–9 and the canonical baseline catalog, bound by marker + system
// id:
//   MONA_R3_SREF_PG=1 MONA_R3_SREF_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local
//   LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//   MONA_R3_PG_SYSTEM_ID=<pg_control_system().system_identifier of THAT cluster>
// Writes are COMMITTED and partly PERMANENT by design (F6 forbids deleting an
// ExternalCollection), hence the explicit DISPOSABLE acknowledgement.
//
// P39 (refund vs T-RR ×50) is DEFINED and NOT RUN until S7 enables T-RR; it is
// an `it.todo` on purpose and must never be renumbered or smuggled into another
// case. The refund-vs-refund auxiliary race is NOT part of P39.
import { randomUUID } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { computeProportionalQuote } from '../../src/modules/pricing/proportional-checkout.js';
import { createCheckoutReservationService } from '../../src/modules/payments/checkout-reservation.service.js';
import { createCheckoutQuoteService } from '../../src/modules/payments/checkout-quote.service.js';
import { createExternalCollectionsService } from '../../src/modules/payments/external-collections.service.js';
import { createPricingService } from '../../src/modules/pricing/pricing.service.js';
import type { PlanTenderInput } from '../../src/modules/payments/checkout-canonical.js';
import type { ExternalCollectionRefundRequest } from '../../src/modules/payments/dto/external-collection-refund.dto.js';
import { AppError } from '../../src/shared/errors.js';

const enabled = process.env.MONA_R3_SREF_PG === '1';

type Role = 'CASHIER' | 'ADMIN' | 'OWNER' | 'SELLER' | 'WAREHOUSE';
// P37 fix: the permissions come from the actor's OWN role, never from ADMIN's
// grants. The old helper handed a CASHIER the ADMIN permission set, so a
// "CASHIER is refused" row was really testing a mislabelled ADMIN and could not
// prove the role rule. OWNER has no grant list (implicit authority only).
const grantsFor = (role: Role): readonly string[] => (role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[role]]);
const actor = (userId: string, role: Role, branchId: string | null) => ({
  auth: {
    userId, roles: [role], effectiveLocationIds: branchId ? [branchId] : [],
    assignments: [{
      roleId: role, roleCode: role, scopeKind: branchId ? 'LOCATION' : 'COMPANY', locationId: branchId,
      permissions: grantsFor(role),
    }],
  },
}) as never;

// P37: a user whose authority is SPLIT across two assignments — a COMPANY ADMIN
// that does NOT hold the required permission, plus a LOCATION assignment that
// DOES. Neither assignment alone is "ADMIN + COMPANY + the permission", so the
// supervisor policy must refuse it: permission and scope never compose across
// assignments. This is a genuinely different shape from a plain LOCATION ADMIN.
const splitAuthorityActor = (userId: string, branchId: string) => ({
  auth: {
    userId, roles: ['ADMIN', 'CASHIER'], effectiveLocationIds: [branchId],
    assignments: [
      { roleId: 'ADMIN', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null,
        permissions: [...DEFAULT_ROLE_GRANTS.ADMIN].filter((permission) => permission !== PRODUCTION_PERMISSIONS.SALE_CANCEL_PENDING) },
      { roleId: 'CASHIER', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: branchId,
        permissions: [...DEFAULT_ROLE_GRANTS.CASHIER] },
    ],
  },
}) as never;

const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return null; } catch (error) {
    if (error instanceof AppError) return { status: error.status, code: error.code };
    throw error;
  }
};

describe.skipIf(!enabled)('R3-A4.3 S-REF — T-F refund on PostgreSQL (migrations 1–9, disposable cluster)', () => {
  const pools: Pool[] = [];
  const clients: PrismaClient[] = [];
  let db: PrismaClient;

  beforeAll(async () => {
    if (process.env.MONA_R3_SREF_PG_DISPOSABLE !== '1') throw new Error('S-REF PG tests write permanent rows: MONA_R3_SREF_PG_DISPOSABLE=1 is required');
    if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
    const expectedSystemId = process.env.MONA_R3_PG_SYSTEM_ID;
    if (!expectedSystemId || !/^[1-9][0-9]{15,20}$/.test(expectedSystemId)) throw new Error('isolated cluster binding is missing');
    const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
    for (const max of [3, 2]) {
      const { pool } = await openProvenLocalTestPool(max, process.env);
      pools.push(pool);
      clients.push(new PrismaClient({ adapter: new PrismaPg(pool, { schema: 'public' }), log: [] }));
    }
    const { rows } = await pools[0]!.query<{ system_id: string; ok: boolean }>(
      `SELECT system_identifier::text AS system_id, to_regclass('public."ExternalCollection"') IS NOT NULL AS ok FROM pg_control_system()`);
    if (rows[0]?.system_id !== expectedSystemId) throw new Error('isolated PostgreSQL cluster does not match binding');
    if (rows[0]?.ok !== true) throw new Error('migrations 8–9 are required');
    db = clients[0]!;
  });
  afterAll(async () => {
    for (const client of clients) await client.$disconnect();
    for (const pool of pools) await pool.end();
  });

  async function fixture() {
    const company = await db.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    // P38-03: guarantee a real pricing configuration exists for the oldest
    // company so the CLAIMED fixture can never depend on whether the canonical
    // baseline happens to carry one. The read path below (pricingOf) is the
    // contractual T-R one — the oldest company's unique config — so
    // PRICING_CONFIG_MISSING cannot be produced by an accidental baseline
    // absence; if it still were, pricingOf throws instead of silently degrading.
    await db.companyPricingConfig.upsert({
      where: { companyId: company.id },
      create: { companyId: company.id, bankTransferAdjustmentBps: 200, debitCardAdjustmentBps: 300 },
      update: {},
    });
    const variant = await db.productVariant.findFirstOrThrow({ select: { id: true, productId: true, sku: true }, orderBy: { id: 'asc' } });
    const branch = randomUUID();
    const tag = branch.slice(0, 8);
    await db.location.create({ data: { id: branch, companyId: company.id, code: `sref-${tag}`, name: `S-REF ${tag}`, type: 'RETAIL_BRANCH', address: 'Test', pointOfSaleNumber: 4_000_000 + parseInt(tag.slice(0, 5), 16) } });
    await db.branch.create({ data: { id: branch, code: `sref-${tag}`, name: `S-REF ${tag}`, address: 'Test', pointOfSaleNumber: 1 } });
    const users = await Promise.all([1, 2].map((n) => db.user.create({ data: { name: `S-REF ${n}`, email: `sref-${tag}-${n}@test.invalid`, passwordHash: 'not-used' } })));
    const register = await db.cashRegister.create({ data: { branchId: branch, name: `S-REF ${tag}` } });
    const session = await db.cashSession.create({ data: { registerId: register.id, openedById: users[0]!.id, startingCash: 0n, status: 'OPEN' } });
    let counter = 0;
    const collection = (patch: Partial<Prisma.ExternalCollectionUncheckedCreateInput> = {}) => {
      counter += 1;
      const reference = `SREF${tag}${counter}`;
      return db.externalCollection.create({ data: {
        branchId: branch, method: 'TRANSFER', amount: 25000n, reference, referenceKey: reference.toUpperCase().replace(/[^A-Z0-9]/g, ''),
        institution: 'GALICIA', status: 'UNAPPLIED', cashSessionId: session.id, recordedById: users[0]!.id, ...patch,
      } });
    };
    const sale = async () => {
      const created = await db.sale.create({ data: { branchId: branch, sellerId: users[0]!.id, status: 'PENDING_PAYMENT', pricingModel: 'PROPORTIONAL_V1', priceMode: 'CASH', pricingMode: 'LIST', subtotal: 10000n, total: 10000n } });
      const item = await db.saleItem.create({ data: { saleId: created.id, variantId: variant.id, productId: variant.productId, productName: 'S-REF', variantName: 'S-REF', sku: variant.sku,
        quantity: 1n, unitPrice: 10000n, subtotal: 10000n, priceBaseType: 'LIST', priceMode: 'CASH', baseUnitPrice: 10000n, priceAdjustmentBps: 0 } });
      await db.stockReservation.create({ data: { saleId: created.id, variantId: variant.id, branchId: branch, quantity: 1n, status: 'ACTIVE', expiresAt: new Date(Date.now() + 30 * 60_000) } });
      return { ...created, lines: [{ saleItemId: item.id, sku: item.sku, quantity: 1n, baseUnitPrice: 10000n }] };
    };
    return { branch, users, session, sale, collection };
  }

  const request = (patch: Partial<ExternalCollectionRefundRequest> = {}): ExternalCollectionRefundRequest => ({
    refundReference: `REF${randomUUID().slice(0, 8).toUpperCase().replace(/[^A-Z0-9]/g, '')}`,
    externalRefundedAt: new Date(Date.now() - 60_000), reason: 'devolución acordada con el cliente', ...patch,
  });

  it('P36 refund + atomic audit + replay: one transaction commits REFUNDED with resolvedBy/at and exactly one EXTERNAL_COLLECTION_REFUNDED row; an identical replay writes nothing', async () => {
    const f = await fixture();
    const ec = await f.collection();
    const service = createExternalCollectionsService(db);
    const input = request();
    const first = await service.refund(actor(f.users[0]!.id, 'ADMIN', null), ec.id, input);
    expect(first.replayed).toBe(false);
    const stored = await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } });
    expect(stored).toMatchObject({ status: 'REFUNDED', resolvedById: f.users[0]!.id, refundReference: input.refundReference, resolutionNote: input.reason });
    expect(stored.resolvedAt).not.toBeNull();
    expect(await db.auditLog.count({ where: { action: 'EXTERNAL_COLLECTION_REFUNDED', entityId: ec.id } })).toBe(1);
    const audits = await db.auditLog.count({ where: { entityType: 'ExternalCollection', entityId: ec.id } });
    const replay = await service.refund(actor(f.users[1]!.id, 'ADMIN', null), ec.id, input);
    expect(replay.replayed).toBe(true);
    expect(await db.auditLog.count({ where: { entityType: 'ExternalCollection', entityId: ec.id } })).toBe(audits);
    expect((await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } })).resolvedById).toBe(f.users[0]!.id);
  });

  it('P37 RBAC on the locked ec.branchId: OWNER and a COMPANY ADMIN refund; a real CASHIER, a LOCATION ADMIN and a split authority get 403', async () => {
    const f = await fixture();
    const service = createExternalCollectionsService(db);

    // Allowed. OWNER qualifies through its implicit COMPANY authority; a
    // COMPANY-scoped ADMIN qualifies because its OWN grant list holds the
    // required SALE_CANCEL_PENDING permission.
    expect((await service.refund(actor(f.users[1]!.id, 'OWNER', null), (await f.collection()).id, request())).replayed).toBe(false);
    expect((await service.refund(actor(f.users[0]!.id, 'ADMIN', null), (await f.collection()).id, request())).replayed).toBe(false);

    // Refused — three genuinely different authority shapes, never the same case
    // relabelled:
    //   (a) a real CASHIER at the branch: right LOCATION, and its OWN grants do
    //       include SALE_CANCEL_PENDING, but the role is not ADMIN;
    //   (b) a LOCATION-scoped ADMIN: right role, right branch, right permission,
    //       but the wrong SCOPE (a LOCATION assignment never qualifies);
    //   (c) a split authority: an ADMIN@COMPANY assignment WITHOUT the permission
    //       plus a CASHIER@LOCATION assignment that has it — permission and scope
    //       must come from the SAME assignment, so neither qualifies.
    const denied: Array<[string, unknown]> = [
      ['real CASHIER at the branch', actor(f.users[0]!.id, 'CASHIER', f.branch)],
      ['LOCATION-scoped ADMIN', actor(f.users[0]!.id, 'ADMIN', f.branch)],
      ['split ADMIN/CASHIER authority', splitAuthorityActor(f.users[1]!.id, f.branch)],
    ];
    for (const [label, actorInput] of denied) {
      const ec = await f.collection();
      expect(await codeOf(service.refund(actorInput as never, ec.id, request())), label)
        .toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect((await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } })).status).toBe('UNAPPLIED');
    }
  });

  // P38-03: the plan must be quoted with EXACTLY what T-R will read. This uses
  // the same contractual pricing path as the reservation service
  // (createPricingService → getSnapshot: the oldest company's unique config),
  // never an alternate findFirst that could pick another company's row. The
  // config is created deterministically in fixture() above, so a null snapshot is
  // a fixture defect — throw rather than quote with "no pricing".
  const pricingOf = async () => {
    const snapshot = await createPricingService(db).getSnapshot();
    if (snapshot.id === null) throw new Error('S-REF fixture: the company pricing configuration is missing');
    return {
      bankTransferAdjustmentBps: snapshot.adjustmentsBps.BANK_TRANSFER!,
      debitCardAdjustmentBps: snapshot.adjustmentsBps.DEBIT_CARD!,
    };
  };

  // T-R is the ONLY flow that can legally claim a collection (F6 requires an
  // unsealed RESERVED plan holding this collection as a COLLECTION tender).
  // These helpers build the two states P38 asserts through the real flow, never
  // a hand-written middle state.
  async function claimCollection(f: Awaited<ReturnType<typeof fixture>>) {
    const sale = await f.sale();
    const ec = await f.collection({ method: 'CARD_DEBIT', institution: null, originSaleId: sale.id, amount: 2000n });
    const tenders: PlanTenderInput[] = [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: ec.amount, externalCollectionId: ec.id },
    ];
    const quote = computeProportionalQuote({
      lines: sale.lines, pricing: await pricingOf(), balanceMethod: 'CASH',
      tenders: tenders.filter((tender) => tender.role === 'FIXED').map((tender) => ({ method: tender.method, amount: tender.amount! })),
    });
    const { view } = await createCheckoutReservationService(db, { externalMethodsEnabled: true }).reserve(
      actor(f.users[0]!.id, 'CASHIER', f.branch), sale.id,
      { reserveKey: randomUUID(), cashSessionId: f.session.id, balanceMethod: 'CASH', expectedTotal: quote.total, expectedBalanceAmount: quote.balance.amount, tenders, recovery: null },
    );
    const attempt = await db.checkoutAttempt.findUniqueOrThrow({ where: { reserveKey: view.reserveKey } });
    // P38-01: re-read the collection from PostgreSQL AFTER T-R committed and
    // assert the claim belongs to the attempt T-R just created — never trust the
    // pre-claim row f.collection() produced (its claimAttemptId is null).
    const refreshed = await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } });
    if (refreshed.claimAttemptId !== attempt.id) {
      throw new Error(`S-REF fixture: T-R did not claim the collection (claimAttemptId = ${refreshed.claimAttemptId})`);
    }
    return { sale, ec: refreshed, attempt };
  }

  // APPLIED is built by the sanctioned S4 confirmation fixture (T-C is S5). This
  // is deliberately NOT a full T-C: it creates NO SalePayment, NO per-line
  // allocation, NO cash movement and consumes no stock hold. It only produces
  // the two DB facts F6 and chk_ec_status read for an APPLIED collection — a
  // CONFIRMED attempt and the SaleCheckout of THAT attempt's operationKey, in
  // one transaction — and then asserts the fixture is coherent. It must never be
  // described as equivalent to T-C.
  async function appliedCollection(f: Awaited<ReturnType<typeof fixture>>) {
    const { sale, ec, attempt } = await claimCollection(f);
    const hash = 'c'.repeat(64);
    const T = new Date('2026-10-16T12:00:00.000Z');
    const checkout = await db.$transaction(async (tx) => {
      const confirmed = await tx.checkoutAttempt.update({ where: { id: attempt.id }, data: { status: 'CONFIRMED', confirmationHash: hash, confirmedById: f.users[0]!.id, confirmedAt: T } });
      const created = await tx.saleCheckout.create({ data: { saleId: sale.id, branchId: f.branch, pricingModel: 'PROPORTIONAL_V1', operationKey: confirmed.operationKey, requestHash: hash, cashSessionId: f.session.id, userId: f.users[0]!.id, balanceMethod: 'CASH', referenceSubtotal: 10000n, total: confirmed.expectedTotal, fullPriceCash: confirmed.fullPriceCash, algorithmVersion: 1 } });
      await tx.sale.update({ where: { id: sale.id }, data: { status: 'COMPLETED' } });
      await tx.externalCollection.update({ where: { id: ec.id }, data: { status: 'APPLIED', appliedCheckoutId: created.id, appliedSaleId: sale.id } });
      return created;
    });
    const collection = await db.externalCollection.findUniqueOrThrow({ where: { id: ec.id } });
    const [storedAttempt, storedCheckout, storedSale] = await Promise.all([
      db.checkoutAttempt.findUniqueOrThrow({ where: { id: attempt.id } }),
      db.saleCheckout.findUniqueOrThrow({ where: { id: checkout.id } }),
      db.sale.findUniqueOrThrow({ where: { id: sale.id } }),
    ]);
    // Explicit fixture validity — not a claim that T-C ran.
    expect(storedAttempt.status).toBe('CONFIRMED');
    expect(storedCheckout.operationKey).toBe(storedAttempt.operationKey);
    expect(storedCheckout.saleId).toBe(sale.id);
    expect(storedCheckout.requestHash).toBe(hash);
    expect(storedSale.status).toBe('COMPLETED');
    expect(collection.status).toBe('APPLIED');
    expect(collection.appliedCheckoutId).toBe(checkout.id);
    expect(collection.appliedSaleId).toBe(sale.id);
    expect(collection.claimAttemptId).toBe(attempt.id);
    expect(collection.originSaleId).toBe(sale.id);
    // chk_ec_status: an APPLIED collection carries no resolution fields.
    expect(collection.resolvedById).toBeNull();
    expect(collection.resolvedAt).toBeNull();
    expect(collection.refundReference).toBeNull();
    return { sale, attempt, checkout: storedCheckout, collection };
  }

  it('P38 state/DB invariants: a real APPLIED row and a real T-R claim are refused before any write; a resolutionNote < 10 chars is rejected by PostgreSQL with SQLSTATE 23514', async () => {
    const f = await fixture();
    const service = createExternalCollectionsService(db);

    // APPLIED: produced by the S4-confirmation fixture (a real CONFIRMED attempt
    // plus its own checkout), never a hand-written status = APPLIED with a null
    // application.
    const applied = await appliedCollection(f);
    expect(await codeOf(service.refund(actor(f.users[0]!.id, 'ADMIN', null), applied.collection.id, request())))
      .toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_ALREADY_APPLIED' });
    expect((await db.externalCollection.findUniqueOrThrow({ where: { id: applied.collection.id } })).status).toBe('APPLIED');

    // CLAIMED: a claim only F6 accepts, created by T-R and re-read from
    // PostgreSQL after the reservation committed (claimCollection re-reads it and
    // throws if T-R did not claim the collection).
    const claimed = await claimCollection(f);
    expect((await db.externalCollection.findUniqueOrThrow({ where: { id: claimed.ec.id } })).claimAttemptId).toBe(claimed.attempt.id);
    expect(await codeOf(service.refund(actor(f.users[0]!.id, 'ADMIN', null), claimed.ec.id, request())))
      .toMatchObject({ status: 409, code: 'EXTERNAL_COLLECTION_CLAIMED' });
    expect((await db.externalCollection.findUniqueOrThrow({ where: { id: claimed.ec.id } })).status).toBe('UNAPPLIED');

    // The CHECK, not the service, refuses a too-short note. A RAW pg probe (the
    // same pattern as r3-attempts-schema.pg.test.ts) reports the SQLSTATE and the
    // constraint name directly; a Prisma error may otherwise wrap 23514 inside a
    // driverAdapterError (Prisma 7.10 + adapter-pg), so error.meta.code is never
    // assumed. ONE deterministic instant is used for both timestamps, so the note
    // length is the only thing that can fail.
    const T = new Date('2026-10-16T12:00:00.000Z');
    const free = await f.collection();
    const failure = await pools[0]!.query(
      `UPDATE "ExternalCollection" SET "status" = 'REFUNDED', "resolvedById" = $2, "resolvedAt" = $3,
              "refundReference" = 'REFX', "resolutionNote" = 'corto', "externalRefundedAt" = $3
       WHERE "id" = $1`,
      [free.id, f.users[0]!.id, T],
    ).then(() => null, (cause: unknown) => cause as { code?: string; constraint?: string });
    expect(failure?.code).toBe('23514');
    expect(failure?.constraint).toBe('chk_ec_refund_fields');
    expect((await db.externalCollection.findUniqueOrThrow({ where: { id: free.id } })).status).toBe('UNAPPLIED');
  });

  // P40 gate false, on PostgreSQL. The COMPLETE set of surfaces plus the real
  // wiring (env -> router -> controller -> service -> HTTP) runs DB-free in
  // external-methods-gate.behavior.test.ts; this case proves the same gate holds
  // against the real services and the real database.
  it('P40 gate false: the quote hides TRANSFER/CARD_DEBIT and their candidates; T-R refuses NEW TRANSFER/CARD_DEBIT and a COLLECTION; CASH, the refund and the listing stay available', async () => {
    const f = await fixture();
    const cashier = actor(f.users[0]!.id, 'CASHIER', f.branch);

    // (1) The quote: TRANSFER/CARD_DEBIT unavailable, and the sale's recorded
    // UNAPPLIED collection is not offered as a usable candidate.
    const quoteSale = await f.sale();
    await f.collection({ method: 'TRANSFER', originSaleId: quoteSale.id, amount: 3000n });
    const quote = await createCheckoutQuoteService(db, { externalMethodsEnabled: false })
      .quote(cashier, quoteSale.id, { balanceMethod: 'CASH', tenders: [] });
    expect(quote.enabledMethods).toEqual([
      { method: 'CASH', available: true },
      { method: 'TRANSFER', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
      { method: 'CARD_DEBIT', available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' },
    ]);
    expect(quote.unappliedCollections).toEqual([]);

    // (5) CASH still works with the gate off.
    const sale = await f.sale();
    const reservation = createCheckoutReservationService(db, { externalMethodsEnabled: false });
    const cashQuote = computeProportionalQuote({ lines: sale.lines, pricing: null, balanceMethod: 'CASH', tenders: [] });
    const base = { cashSessionId: f.session.id, balanceMethod: 'CASH' as const, expectedTotal: cashQuote.total, expectedBalanceAmount: cashQuote.balance.amount, recovery: null };
    const cashTenders: PlanTenderInput[] = [{ method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }];
    expect(await codeOf(reservation.reserve(cashier, sale.id, { ...base, reserveKey: randomUUID(), tenders: cashTenders }))).toBeNull();

    // (2)(3) A NEW TRANSFER and a NEW CARD_DEBIT tender are refused with the gate
    // code (the gate runs at step 3.5, before any attempt read and before any
    // quote comparison).
    for (const method of ['TRANSFER', 'CARD_DEBIT'] as const) {
      const tenders: PlanTenderInput[] = [
        { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
        { method, role: 'FIXED', source: 'NEW', amount: 2000n, externalCollectionId: null },
      ];
      expect(await codeOf(reservation.reserve(cashier, sale.id, { ...base, reserveKey: randomUUID(), tenders })), method)
        .toMatchObject({ status: 409, code: 'PAYMENT_METHOD_NOT_ENABLED' });
    }

    // (4) Consuming a recorded COLLECTION is refused the same way, and the
    // collection keeps its UNAPPLIED / unclaimed state.
    const collectionSale = await f.sale();
    const recorded = await f.collection({ method: 'TRANSFER', originSaleId: collectionSale.id, amount: 3000n });
    const collectionTenders: PlanTenderInput[] = [
      { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 3000n, externalCollectionId: recorded.id },
    ];
    expect(await codeOf(reservation.reserve(cashier, collectionSale.id, { ...base, reserveKey: randomUUID(), tenders: collectionTenders })))
      .toMatchObject({ status: 409, code: 'PAYMENT_METHOD_NOT_ENABLED' });
    expect((await db.externalCollection.findUniqueOrThrow({ where: { id: recorded.id } }))).toMatchObject({ status: 'UNAPPLIED', claimAttemptId: null });

    // (6) The refund and the listing are never gated: an UNAPPLIED collection
    // still refunds and the branch listing still reads while the gate is off.
    const external = createExternalCollectionsService(db);
    const toRefund = await f.collection({ method: 'TRANSFER' });
    expect((await external.refund(actor(f.users[1]!.id, 'OWNER', null), toRefund.id, request())).replayed).toBe(false);
    const listing = await external.list(actor(f.users[1]!.id, 'OWNER', null), { branchId: f.branch, status: null, limit: 50 });
    expect(listing.items.some((item) => item.id === toRefund.id)).toBe(true);
  });

  // P39: refund vs T-RR ×50 — DEFINED / NOT RUN until S7 enables T-RR.
  it.todo('P39 DEFINED / NOT RUN (S7): 50 interleaved refund/T-RR attempts on the same collection leave exactly one terminal outcome with no partial write');
});
