// R3-A4.3 S4: T-R, the durable charge reservation
// (POST /sales/:saleId/checkout/reservations), and the per-sale reads of
// attempts. Approved design S4 + closure D1–D5; contract consolidated §5.1,
// C1–C5 §4/§6, last-REVISE §3.3, three final corrections §1.
//
// T-R is ONE READ COMMITTED transaction (timeout 30 s; up to 3 attempts on a
// transient failure). Order (D1):
//   1. lock the sale of the URL (404);
//   2. SALE_CHARGE + SALE_COMPLETE on its persisted branchId (403) — nothing
//      about any attempt is read before this;
//   3. reserveKey: same sale AND same planHash → 200 replay of its current
//      view, in any sale state, with no write at all (not even updatedAt);
//      any other sale or plan → one generic 409 without details;
//   4. a new attempt: sale state, no open attempt, external collections
//      (U_origin ∪ U_plan locked by id), cash session, stock coverage
//      FIRST_PAYMENT(now), server quote;
//   5. writes, in order: visibility rule (UPDATE "Sale"."updatedAt", so a
//      Serializable transaction waiting on the sale lock gets 40001 and sees
//      the attempt), attempt UNSEALED → tenders → claims (F6 NULL → X needs the
//      unsealed plan holding the collection) → seal → audit CHECKOUT_RESERVED.
//      F3 checks the sealed plan and the claims at COMMIT.
// Global lock order: Sale → ExternalCollection(id ASC) → CashSession →
// StockReservation(id ASC). No Inventory lock (D5): T-R writes no stock and
// guarantees no stock — T-C re-checks coverage and inventory under its locks.
// The price snapshot sealed here is what T-C charges (P15).
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { createPricingService } from '../pricing/pricing.service.js';
import { computeProportionalQuote, type ProportionalPricingSnapshot } from '../pricing/proportional-checkout.js';
import { evaluateCurrentHoldCoverage } from '../sales/hold-coverage.js';
import { planHash } from './checkout-canonical.js';
import { loadReservationView, readCheckoutResult, type ReservationView } from './checkout-attempt-view.js';
import { loadProportionalLines } from './checkout-sale-snapshot.js';
import type { CheckoutReservationRequest } from './dto/checkout-reservation.dto.js';
import type { CheckoutResult } from './checkout.service.js';

const RESERVATION_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const RECENT_PER_SALE = 10;

type RequestLike = { auth?: Express.AuthContext };
type Tx = Prisma.TransactionClient;

type LockedSale = {
  id: string; branchId: string; status: string; pricingMode: string; priceMode: string; pricingModel: string;
  paymentStartedAt: Date | null; wholesaleConfirmedAt: Date | null; wholesaleConfirmedById: string | null;
};
type LockedCollection = {
  id: string; branchId: string; method: string; amount: bigint; status: string; claimAttemptId: string | null; originSaleId: string | null;
};

const notFound = () => new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
const reservationNotFound = () => new AppError(404, 'NOT_FOUND', 'No se encontró la reserva de cobro.');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
const invalidState = () => new AppError(409, 'INVALID_SALE_STATE', 'La venta no admite una reserva de cobro en su estado actual.');
const snapshotInconsistent = (message: string) => new AppError(409, 'PRICING_SNAPSHOT_INCONSISTENT', message);
// Generic on purpose: the same code and message whether the key belongs to
// another sale or carries another plan, and never any detail of that attempt.
const reserveKeyReused = () => new AppError(409, 'RESERVE_KEY_REUSED_WITH_DIFFERENT_PLAN', 'La clave de reserva ya fue utilizada con otro contenido.');
const recoveryNotEnabled = () => new AppError(409, 'RECOVERY_RESERVATION_NOT_ENABLED', 'La reserva de recuperación todavía no está habilitada.');
const collectionNotApplicable = () => new AppError(409, 'EXTERNAL_COLLECTION_NOT_APPLICABLE', 'El cobro registrado no se puede aplicar a este medio o importe.');
const collectionClaimed = () => new AppError(409, 'EXTERNAL_COLLECTION_CLAIMED', 'El cobro registrado ya está reservado por otro intento.');
const unappliedPending = () => new AppError(409, 'UNAPPLIED_EXTERNAL_COLLECTION_PENDING', 'La venta tiene cobros externos sin imputar que no se incluyeron.');
const noCashSession = () => new AppError(409, 'NO_OPEN_CASH_SESSION', 'No hay una sesión de caja abierta.');
const cashSessionBranch = () => new AppError(409, 'CASH_SESSION_BRANCH_MISMATCH', 'La sesión de caja pertenece a otra sucursal.');
const stockExpired = () => new AppError(409, 'STOCK_HOLD_EXPIRED', 'La reserva de stock de la venta venció.');
const stockReleased = () => new AppError(409, 'STOCK_HOLD_RELEASED', 'La reserva de stock de la venta fue liberada.');
const inconsistentState = (message: string) => new AppError(500, 'CHECKOUT_STATE_INCONSISTENT', message);
const concurrencyError = () => new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');

const transient = (error: unknown) => {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034' || candidate.meta?.code === '40001' || candidate.meta?.code === '40P01'
    || message.includes('40001') || message.includes('40P01') || message.includes('TransactionWriteConflict');
};

// Which CheckoutAttempt unique key collided. Anything else returns null and the
// original error is rethrown: no cause is ever invented. Exported so the opt-in
// PostgreSQL test can classify a REAL P2002 with the same rule.
export function attemptCollision(error: unknown): 'reserveKey' | 'openPerSale' | null {
  const candidate = error as { code?: string; meta?: { modelName?: string; target?: unknown } };
  if (candidate.code !== 'P2002') return null;
  const target = candidate.meta?.target;
  const text = (Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '').toLowerCase();
  if (text.includes('one_open_per_sale')) return 'openPerSale';
  if (candidate.meta?.modelName !== 'CheckoutAttempt') return null;
  if (text.includes('reservekey')) return 'reserveKey';
  if (text === 'saleid') return 'openPerSale';
  return null;
}

function enginePricing(snapshot: { id: string | null; adjustmentsBps: Record<string, number> }): ProportionalPricingSnapshot | null {
  if (snapshot.id === null) return null;
  return {
    bankTransferAdjustmentBps: snapshot.adjustmentsBps.BANK_TRANSFER!,
    debitCardAdjustmentBps: snapshot.adjustmentsBps.DEBIT_CARD!,
  };
}

export function createCheckoutReservationService(
  database: PrismaClient,
  options: { now?: () => Date; operationKey?: () => string } = {},
) {
  const now = options.now ?? (() => new Date());
  const newOperationKey = options.operationKey ?? (() => randomUUID());
  const pricing = createPricingService(database);

  function assertCanReserve(req: RequestLike, branchId: string) {
    if (!req.auth
      || !hasPermissionAtLocation(req.auth, PRODUCTION_PERMISSIONS.SALE_CHARGE, branchId)
      || !hasPermissionAtLocation(req.auth, PRODUCTION_PERMISSIONS.SALE_COMPLETE, branchId)) throw forbidden();
  }
  function assertCanRead(req: RequestLike, branchId: string) {
    if (!req.auth || !hasPermissionAtLocation(req.auth, PRODUCTION_PERMISSIONS.SALE_CHARGE, branchId)) throw forbidden();
  }

  async function lockSale(tx: Tx, saleId: string): Promise<LockedSale> {
    const [sale] = await tx.$queryRaw<LockedSale[]>`
      SELECT id, "branchId", status, "pricingMode", "priceMode", "pricingModel",
             "paymentStartedAt", "wholesaleConfirmedAt", "wholesaleConfirmedById"
      FROM "Sale" WHERE id = ${saleId} FOR UPDATE
    `;
    if (!sale) throw notFound();
    return sale;
  }

  // D1 step 3 (also the P2002 re-read): only an attempt of THIS sale with THIS
  // plan is ever returned.
  async function replayOrRefuse(tx: Tx, saleId: string, reserveKey: string, hash: string): Promise<{ replayed: true; view: ReservationView } | null> {
    const existing = await tx.checkoutAttempt.findUnique({ where: { reserveKey } });
    if (!existing) return null;
    if (existing.saleId !== saleId || existing.planHash !== hash) throw reserveKeyReused();
    return { replayed: true, view: await loadReservationView(tx, existing, now()) };
  }

  async function openAttemptError(tx: Tx, saleId: string): Promise<AppError | null> {
    const open = await tx.checkoutAttempt.findFirst({
      where: { saleId, declaredAt: null, status: { in: ['RESERVED', 'REJECTED'] } },
    });
    if (!open) return null;
    const user = await tx.user.findUnique({ where: { id: open.startedById }, select: { id: true, name: true } });
    return new AppError(409, 'CHECKOUT_RESERVATION_OPEN', 'La venta ya tiene una reserva de cobro abierta.', {
      open: { reserveKey: open.reserveKey, status: open.status, startedBy: { id: open.startedById, name: user?.name ?? null } },
    });
  }

  async function reserveOnce(req: RequestLike, saleId: string, request: CheckoutReservationRequest, hash: string) {
    return database.$transaction(async (tx) => {
      // 1–2. Lock the sale, then permissions on its persisted branch.
      const sale = await lockSale(tx, saleId);
      assertCanReserve(req, sale.branchId);
      const userId = req.auth!.userId;

      // 3. Idempotency by reserveKey (D1).
      const replay = await replayOrRefuse(tx, saleId, request.reserveKey, hash);
      if (replay) return replay;

      // 4. A new attempt: sale state and line snapshot.
      if (sale.pricingModel !== 'PROPORTIONAL_V1' || sale.status !== 'PENDING_PAYMENT') throw invalidState();
      const lines = await loadProportionalLines(tx, sale);
      const previousPayments = await tx.salePayment.count({ where: { saleId } });
      if (previousPayments > 0 || sale.paymentStartedAt !== null) throw invalidState();

      const open = await openAttemptError(tx, saleId);
      if (open) throw open;

      // External collections: U_origin ∪ U_plan, one query, id order.
      const planIds = request.tenders
        .map((tender) => tender.externalCollectionId)
        .filter((id): id is string => id !== null)
        .sort();
      const locked = await tx.$queryRaw<LockedCollection[]>`
        SELECT id, "branchId", method, amount, status, "claimAttemptId", "originSaleId"
        FROM "ExternalCollection"
        WHERE id = ANY(${planIds}::text[])
           OR ("originSaleId" = ${saleId} AND "branchId" = ${sale.branchId} AND status = 'UNAPPLIED')
        ORDER BY id ASC
        FOR UPDATE
      `;
      const byId = new Map(locked.map((collection) => [collection.id, collection]));
      for (const tender of request.tenders) {
        if (tender.externalCollectionId === null) continue;
        const collection = byId.get(tender.externalCollectionId);
        if (!collection || collection.status !== 'UNAPPLIED') throw collectionNotApplicable();
        if (collection.claimAttemptId !== null) throw collectionClaimed();
        if (collection.branchId !== sale.branchId || collection.method !== tender.method || collection.amount !== tender.amount) {
          throw collectionNotApplicable();
        }
      }
      const origin = locked.filter((collection) => collection.originSaleId === saleId && collection.branchId === sale.branchId
        && collection.status === 'UNAPPLIED');
      if (origin.some((collection) => !planIds.includes(collection.id))) throw unappliedPending();

      // Cash session of the sale's own branch.
      const [session] = await tx.$queryRaw<Array<{ id: string; status: string; branchId: string }>>`
        SELECT cs.id, cs.status, r."branchId"
        FROM "CashSession" cs JOIN "CashRegister" r ON r.id = cs."registerId"
        WHERE cs.id = ${request.cashSessionId}
        FOR UPDATE OF cs
      `;
      if (!session || session.status !== 'OPEN') throw noCashSession();
      if (session.branchId !== sale.branchId) throw cashSessionBranch();

      // Stock coverage FIRST_PAYMENT(now) (D4 codes). Read under lock, never written.
      const coverageItems = await tx.saleItem.findMany({ where: { saleId }, select: { variantId: true, quantity: true } });
      const activeHolds = await tx.$queryRaw<Array<{ id: string; variantId: string; branchId: string; quantity: bigint; expiresAt: Date }>>`
        SELECT id, "variantId", "branchId", quantity, "expiresAt"
        FROM "StockReservation"
        WHERE "saleId" = ${saleId} AND status = 'ACTIVE'
        ORDER BY id ASC
        FOR UPDATE
      `;
      const coverage = evaluateCurrentHoldCoverage({ branchId: sale.branchId, items: coverageItems, activeHolds, policy: { kind: 'FIRST_PAYMENT', now: now() } });
      if (!coverage.ok) {
        if (coverage.reason === 'EXPIRED') throw stockExpired();
        if (coverage.reason === 'NO_ACTIVE_HOLDS' || coverage.reason === 'COVERAGE_MISMATCH') throw stockReleased();
        throw inconsistentState('La reserva de stock de la venta es inválida.');
      }

      // Server quote: the only authority; the client totals are only compared.
      const snapshot = await pricing.getSnapshot(tx);
      const engine = enginePricing(snapshot);
      const quote = computeProportionalQuote({
        lines,
        pricing: engine,
        tenders: request.tenders.filter((tender) => tender.role === 'FIXED').map((tender) => ({ method: tender.method, amount: tender.amount! })),
        balanceMethod: request.balanceMethod,
      });
      if (quote.total !== request.expectedTotal || quote.balance.amount !== request.expectedBalanceAmount) {
        throw new AppError(409, 'CHECKOUT_QUOTE_CHANGED', 'La cotización cambió; vuelva a cotizar.', { total: quote.total, balance: quote.balance.amount });
      }
      const fullPriceCash = quote.fullPrices.CASH;
      if (fullPriceCash === null) throw snapshotInconsistent('La cotización no tiene precio en efectivo.');

      // 5. Writes. Visibility rule first, inside the committing transaction.
      await tx.$executeRaw`UPDATE "Sale" SET "updatedAt" = now() WHERE id = ${saleId}`;
      const operationKey = newOperationKey();
      const attempt = await tx.checkoutAttempt.create({
        data: {
          saleId,
          branchId: sale.branchId,
          reserveKey: request.reserveKey,
          operationKey,
          planHash: hash,
          cashSessionId: request.cashSessionId,
          balanceMethod: request.balanceMethod,
          expectedTotal: request.expectedTotal,
          expectedBalanceAmount: request.expectedBalanceAmount,
          tenderCount: request.tenders.length,
          fullPriceCash,
          // Whole pricing-config snapshot or nothing (chk_attempt_pricing_snapshot).
          fullPriceTransfer: engine === null ? null : quote.fullPrices.TRANSFER,
          fullPriceDebit: engine === null ? null : quote.fullPrices.CARD_DEBIT,
          transferAdjustmentBps: engine?.bankTransferAdjustmentBps ?? null,
          debitAdjustmentBps: engine?.debitCardAdjustmentBps ?? null,
          pricingConfigId: engine === null ? null : snapshot.id,
          pricingConfigUpdatedAt: engine === null ? null : snapshot.updatedAt,
          algorithmVersion: 1,
          startedById: userId,
        },
      });
      await tx.checkoutAttemptTender.createMany({
        data: request.tenders.map((tender) => ({
          attemptId: attempt.id,
          branchId: sale.branchId,
          method: tender.method,
          role: tender.role,
          source: tender.source,
          amount: tender.amount,
          externalCollectionId: tender.externalCollectionId,
        })),
      });
      if (planIds.length > 0) {
        const claimed = await tx.externalCollection.updateMany({
          where: { id: { in: planIds }, status: 'UNAPPLIED', claimAttemptId: null },
          data: { claimAttemptId: attempt.id },
        });
        if (claimed.count !== planIds.length) throw inconsistentState('No se pudieron reservar todos los cobros registrados.');
      }
      const sealed = await tx.checkoutAttempt.update({ where: { id: attempt.id }, data: { planSealed: true } });
      await createAuditLog(tx, {
        userId,
        branchId: sale.branchId,
        action: 'CHECKOUT_RESERVED',
        entityType: 'CheckoutAttempt',
        entityId: attempt.id,
        after: {
          saleId,
          reserveKey: request.reserveKey,
          operationKey,
          planHash: hash,
          cashSessionId: request.cashSessionId,
          balanceMethod: request.balanceMethod,
          expectedTotal: request.expectedTotal,
          expectedBalanceAmount: request.expectedBalanceAmount,
          tenders: request.tenders,
          claimedCollectionIds: planIds,
          pricingConfigId: engine === null ? null : snapshot.id,
        },
      });
      return { replayed: false, view: await loadReservationView(tx, sealed, now()) };
    }, { isolationLevel: 'ReadCommitted', timeout: RESERVATION_TIMEOUT_MS });
  }

  // P2002 of a concurrent peer, re-read in ONE fresh transaction that repeats
  // the sale lock and the permission check before returning anything.
  async function resolveCollision(req: RequestLike, saleId: string, request: CheckoutReservationRequest, hash: string, kind: 'reserveKey' | 'openPerSale') {
    return database.$transaction(async (tx) => {
      const sale = await lockSale(tx, saleId);
      assertCanReserve(req, sale.branchId);
      const replay = await replayOrRefuse(tx, saleId, request.reserveKey, hash);
      if (replay) return replay;
      if (kind === 'openPerSale') {
        const open = await openAttemptError(tx, saleId);
        if (open) throw open;
      }
      return null;
    }, { isolationLevel: 'ReadCommitted', timeout: RESERVATION_TIMEOUT_MS });
  }

  async function reserve(req: RequestLike, saleId: string, request: CheckoutReservationRequest): Promise<{ replayed: boolean; view: ReservationView }> {
    // D2: T-RR is S7. Refused before any transaction.
    if (request.recovery !== null) throw recoveryNotEnabled();
    const hash = planHash({
      saleId,
      cashSessionId: request.cashSessionId,
      balanceMethod: request.balanceMethod,
      expectedTotal: request.expectedTotal,
      expectedBalanceAmount: request.expectedBalanceAmount,
      tenders: request.tenders,
    });
    for (let attemptNumber = 0; attemptNumber < MAX_ATTEMPTS; attemptNumber += 1) {
      try {
        return await reserveOnce(req, saleId, request, hash);
      } catch (error) {
        const collision = attemptCollision(error);
        if (collision !== null) {
          const resolved = await resolveCollision(req, saleId, request, hash, collision);
          if (resolved) return resolved;
          throw error;
        }
        if (!transient(error)) throw error;
        if (attemptNumber === MAX_ATTEMPTS - 1) throw concurrencyError();
      }
    }
    throw concurrencyError();
  }

  async function readSale(tx: Tx, req: RequestLike, saleId: string) {
    const sale = await tx.sale.findFirst({ where: { id: saleId }, select: { id: true, branchId: true } });
    if (!sale) throw notFound();
    assertCanRead(req, sale.branchId);
    return sale;
  }

  // GET /sales/:saleId/checkout/reservations — any sale status, plain reads.
  async function listForSale(req: RequestLike, saleId: string): Promise<{ open: ReservationView | null; recent: ReservationView[] }> {
    return database.$transaction(async (tx) => {
      await readSale(tx, req, saleId);
      const at = now();
      const open = await tx.checkoutAttempt.findFirst({ where: { saleId, declaredAt: null, status: { in: ['RESERVED', 'REJECTED'] } } });
      const recent = await tx.checkoutAttempt.findMany({ where: { saleId }, orderBy: [{ startedAt: 'desc' }, { id: 'desc' }], take: RECENT_PER_SALE });
      return {
        open: open ? await loadReservationView(tx, open, at) : null,
        recent: await Promise.all(recent.map((attempt) => loadReservationView(tx, attempt, at))),
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  // GET /sales/:saleId/checkout/reservations/:reserveKey — only an attempt of
  // THIS sale; a reserveKey of another sale is 404 exactly like an unknown one.
  async function getForSale(req: RequestLike, saleId: string, reserveKey: string): Promise<{ view: ReservationView; checkout: CheckoutResult | null }> {
    return database.$transaction(async (tx) => {
      await readSale(tx, req, saleId);
      const attempt = await tx.checkoutAttempt.findFirst({ where: { reserveKey, saleId } });
      if (!attempt) throw reservationNotFound();
      const view = await loadReservationView(tx, attempt, now());
      const checkout = attempt.status === 'CONFIRMED' ? await readCheckoutResult(tx, attempt) : null;
      return { view, checkout };
    }, { isolationLevel: 'RepeatableRead' });
  }

  return { reserve, listForSale, getForSale };
}

export type CheckoutReservationService = ReturnType<typeof createCheckoutReservationService>;
