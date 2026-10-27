// R3-A4.3 S4: GET /checkout-attempts/recent — reload recovery, independent of
// /sales/pending (C1–C5 §4.1 and §8, correction C4). A CONFIRMED attempt is
// shown with its checkout even when the sale is already COMPLETED, so a cashier
// whose confirmation response was lost never charges twice.
//
// Authorization (design S4 §3):
//   - branchId must be in effectiveLocationIds: the bounded list of real,
//     active locations, used ONLY as the existence proof the authorization
//     module requires of its callers;
//   - scope=mine: SALE_CHARGE at branchId, and only the actor's own attempts;
//   - scope=branch: actsAsSupervisorAtLocation(ctx, [SALE_CANCEL_PENDING], branchId).
// Plain reads, no lock, no write.
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { actsAsSupervisorAtLocation, hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { loadReservationView, requireConfirmedCheckout, type ReservationView } from './checkout-attempt-view.js';
import type { CheckoutAttemptsRecentQuery } from './dto/checkout-attempts-recent.dto.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 7 * DAY_MS;

type RequestLike = { auth?: Express.AuthContext };

export type RecentCheckoutAttempt = {
  attempt: ReservationView;
  sale: { saleNumber: string | null; status: string };
  confirmed: {
    checkoutId: string;
    total: bigint;
    completedAt: Date;
    payments: Array<{ method: string; amount: bigint; referenceKey: string | null; institution: string | null }>;
  } | null;
};

const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
const invalidSince = () => new AppError(400, 'VALIDATION_ERROR', 'since debe estar dentro de los últimos 7 días.');

export function createCheckoutAttemptsRecentService(database: PrismaClient, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());

  function assertCanList(req: RequestLike, query: CheckoutAttemptsRecentQuery) {
    const auth = req.auth;
    if (!auth || !auth.effectiveLocationIds.includes(query.branchId)) throw forbidden();
    const allowed = query.scope === 'mine'
      ? hasPermissionAtLocation(auth, PRODUCTION_PERMISSIONS.SALE_CHARGE, query.branchId)
      : actsAsSupervisorAtLocation(auth, [PRODUCTION_PERMISSIONS.SALE_CANCEL_PENDING], query.branchId);
    if (!allowed) throw forbidden();
  }

  async function recent(req: RequestLike, query: CheckoutAttemptsRecentQuery): Promise<{ items: RecentCheckoutAttempt[] }> {
    assertCanList(req, query);
    const at = now();
    const since = query.since ?? new Date(at.getTime() - DAY_MS);
    if (since.getTime() < at.getTime() - MAX_WINDOW_MS || since.getTime() > at.getTime()) throw invalidSince();
    return database.$transaction(async (tx) => {
      const attempts = await tx.checkoutAttempt.findMany({
        where: {
          branchId: query.branchId,
          startedAt: { gte: since },
          ...(query.scope === 'mine' ? { startedById: req.auth!.userId } : {}),
        },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        take: query.limit,
      });
      const items: RecentCheckoutAttempt[] = [];
      for (const attempt of attempts) {
        const sale = await tx.sale.findFirst({ where: { id: attempt.saleId }, select: { saleNumber: true, status: true } });
        let confirmed: RecentCheckoutAttempt['confirmed'] = null;
        if (attempt.status === 'CONFIRMED') {
          // Fails closed (500) unless the checkout, sale and hash are coherent.
          const { checkout } = await requireConfirmedCheckout(tx, attempt);
          const payments = await tx.salePayment.findMany({ where: { checkoutId: checkout.id }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] });
          const collectionIds = payments.map((payment) => payment.externalCollectionId).filter((id): id is string => id !== null);
          const collections = collectionIds.length === 0 ? [] : await tx.externalCollection.findMany({
            where: { id: { in: collectionIds } }, select: { id: true, referenceKey: true, institution: true },
          });
          const byId = new Map(collections.map((collection) => [collection.id, collection]));
          confirmed = {
            checkoutId: checkout.id,
            total: checkout.total,
            completedAt: checkout.completedAt,
            payments: payments.map((payment) => {
              const collection = payment.externalCollectionId === null ? undefined : byId.get(payment.externalCollectionId);
              return { method: payment.method, amount: payment.amount, referenceKey: collection?.referenceKey ?? null, institution: collection?.institution ?? null };
            }),
          };
        }
        items.push({
          attempt: await loadReservationView(tx, attempt, at),
          sale: { saleNumber: sale?.saleNumber ?? null, status: sale?.status ?? 'UNKNOWN' },
          confirmed,
        });
      }
      return { items };
    }, { isolationLevel: 'RepeatableRead' });
  }

  return { recent };
}

export type CheckoutAttemptsRecentService = ReturnType<typeof createCheckoutAttemptsRecentService>;
