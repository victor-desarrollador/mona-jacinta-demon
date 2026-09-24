import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { assertPermissionAtLocation } from '../../middleware/authorization.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { resolveSystemActorId } from '../audit/system-actor.service.js';
import { releasableExpiredHoldWhere } from './reservation-holds.js';

type AuthScope = { userId: string; branchIds: string[] };
type LockedSale = { id: string; branchId: string; status: string };
type LockedReservation = { id: string; variantId: string; branchId: string; quantity: bigint; status: string; expiresAt: Date };
type LockedInventory = { id: string; variantId: string; branchId: string; physical: bigint; reserved: bigint };

// Pilot P0.1-B1: who a release is attributed to. ADMIN = the invoking human
// (manual INVENTORY_MANAGE endpoint); SYSTEM = the dedicated inactive
// system actor (automation; the scheduler itself is P0.1-B2).
export type ReleaseActor = { userId: string; trigger: 'ADMIN' | 'SYSTEM' };
type ReleasedQuantity = { variantId: string; quantity: bigint };
export type ReleaseOutcome =
  | { outcome: 'RELEASED'; saleId: string; branchId: string; quantities: ReleasedQuantity[] }
  | { outcome: 'NOT_FOUND' | 'OUT_OF_SCOPE' | 'NOT_PENDING' | 'PAYMENT_PROTECTED' | 'NOTHING_EXPIRED'; saleId: string };
type ReleasedSale = { saleId: string; branchId: string; quantities: ReleasedQuantity[] };
export type ReconcileResult = { released: ReleasedSale[]; failed: Array<{ saleId: string; code: string }> };

export const EXPIRED_HOLD_RELEASE_BATCH_LIMIT = 100;

const invalidState = () => new AppError(409, 'INVALID_SALE_STATE', 'La venta no puede cancelarse en su estado actual.');
const invalidReservation = (message = 'La reserva de la venta no es válida.') => new AppError(409, 'INVALID_RESERVATION', message);

function transient(error: unknown) {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034' || candidate.meta?.code === '40001'
    || candidate.meta?.code === '40P01' || message.includes('40001') || message.includes('40P01');
}

async function acceptedTotal(tx: Prisma.TransactionClient, saleId: string) {
  const payments = await tx.salePayment.findMany({ where: { saleId }, select: { amount: true } });
  return payments.reduce((sum, payment) => sum + payment.amount, 0n);
}

async function releaseReservations(
  tx: Prisma.TransactionClient,
  sale: LockedSale,
  reservations: LockedReservation[],
) {
  const active = reservations.filter((reservation) => reservation.status === 'ACTIVE');
  if (active.some((reservation) => reservation.branchId !== sale.branchId)) throw invalidReservation('La reserva pertenece a otra sucursal.');
  const quantities = new Map<string, bigint>();
  for (const reservation of active) quantities.set(reservation.variantId, (quantities.get(reservation.variantId) ?? 0n) + reservation.quantity);
  const variantIds = [...quantities.keys()];
  if (variantIds.length === 0) return [];
  const inventories = await tx.$queryRaw<LockedInventory[]>`
    SELECT id, "variantId", "branchId", physical, reserved
    FROM "Inventory"
    WHERE "branchId" = ${sale.branchId} AND "variantId" IN (${Prisma.join(variantIds)})
    ORDER BY id ASC FOR UPDATE
  `;
  const byVariant = new Map(inventories.map((inventory) => [inventory.variantId, inventory]));
  for (const [variantId, quantity] of quantities) {
    const inventory = byVariant.get(variantId);
    if (!inventory) throw invalidReservation('No se encontró el inventario de la reserva.');
    if (inventory.reserved < quantity) throw invalidReservation('El inventario reservado no puede liberar la reserva.');
  }
  for (const [variantId, quantity] of quantities) {
    const inventory = byVariant.get(variantId)!;
    await tx.inventory.update({ where: { id: inventory.id }, data: { reserved: inventory.reserved - quantity } });
  }
  await tx.stockReservation.updateMany({ where: { id: { in: active.map(({ id }) => id) } }, data: { status: 'RELEASED' } });
  return [...quantities].map(([variantId, quantity]) => ({ variantId, quantity }));
}

export function createCancellationService(database: PrismaClient) {
  async function inTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await database.$transaction(operation, { isolationLevel: 'Serializable', timeout: 30000 });
      } catch (error) {
        if (!transient(error) || attempt === 2) {
          if (transient(error)) throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
          throw error;
        }
      }
    }
    throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
  }

  async function cancelSale(req: Parameters<typeof assertPermissionAtLocation>[0], saleId: string) {
    return inTransaction(async (tx) => {
      const [sale] = await tx.$queryRaw<LockedSale[]>`SELECT id, "branchId", status FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
      if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
      // Phase 1D.3.1 SWITCH: /cancel is gated on the Production SALE_CREATE
      // grant, paired with this sale's own location — never a bare
      // effectiveLocationIds membership check.
      assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CREATE, sale.branchId);
      const paid = await acceptedTotal(tx, saleId);
      if (paid > 0n) throw new AppError(409, 'PAYMENT_ALREADY_ACCEPTED', 'La venta tiene pagos aceptados.');
      if (sale.status !== 'DRAFT' && sale.status !== 'PENDING_PAYMENT') throw invalidState();
      const reservations = await tx.$queryRaw<LockedReservation[]>`
        SELECT id, "variantId", "branchId", quantity, status, "expiresAt"
        FROM "StockReservation" WHERE "saleId" = ${saleId} ORDER BY id ASC FOR UPDATE
      `;
      if (reservations.some((reservation) => reservation.branchId !== sale.branchId)) throw invalidReservation('La reserva pertenece a otra sucursal.');
      if (sale.status === 'DRAFT' && reservations.some((reservation) => reservation.status === 'ACTIVE')) throw invalidReservation('Una venta en borrador no puede tener reservas activas.');
      const released = sale.status === 'PENDING_PAYMENT'
        ? await releaseReservations(tx, sale, reservations)
        : [];
      await tx.sale.update({ where: { id: saleId }, data: { status: 'CANCELLED' } });
      await createAuditLog(tx, {
        userId: req.auth!.userId, branchId: sale.branchId, action: 'SALE_CANCELLED', entityType: 'Sale', entityId: saleId,
        before: { status: sale.status },
        after: { status: 'CANCELLED', released },
      });
      return { saleId, branchId: sale.branchId, status: 'CANCELLED', released };
    });
  }

  // Pilot P0.1-B1: THE authoritative release of one Sale's expired,
  // zero-payment technical holds — one Sale per Serializable transaction.
  // Lock order: Sale -> StockReservation(id ASC) -> Inventory(id ASC), the
  // same prefix cancelSale/payments take, so every path serializes on the
  // Sale row first. Every condition is re-evaluated under those locks;
  // discovery results are only hints. Any invariant failure throws and
  // rolls back the whole Sale: writes are never clamped.
  async function releaseExpiredSaleHolds(
    saleId: string,
    options: { actor: ReleaseActor; now: Date; branchIds?: string[] },
  ): Promise<ReleaseOutcome> {
    return inTransaction(async (tx): Promise<ReleaseOutcome> => {
      const [sale] = await tx.$queryRaw<LockedSale[]>`SELECT id, "branchId", status FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
      if (!sale) return { outcome: 'NOT_FOUND', saleId };
      if (options.branchIds && !options.branchIds.includes(sale.branchId)) return { outcome: 'OUT_OF_SCOPE', saleId };
      if (sale.status !== 'PENDING_PAYMENT') return { outcome: 'NOT_PENDING', saleId };
      // Policy A: any SalePayment row, whatever its amount, protects the holds.
      if (await tx.salePayment.count({ where: { saleId } }) > 0) return { outcome: 'PAYMENT_PROTECTED', saleId };

      const reservations = await tx.$queryRaw<LockedReservation[]>`
        SELECT id, "variantId", "branchId", quantity, status, "expiresAt"
        FROM "StockReservation"
        WHERE "saleId" = ${saleId} AND status = 'ACTIVE' AND "expiresAt" <= ${options.now}
        ORDER BY id ASC FOR UPDATE
      `;
      if (reservations.length === 0) return { outcome: 'NOTHING_EXPIRED', saleId };
      if (reservations.some((reservation) => reservation.branchId !== sale.branchId)) throw invalidReservation('La reserva pertenece a otra sucursal.');

      const quantities = new Map<string, bigint>();
      for (const reservation of reservations) {
        if (reservation.quantity <= 0n) throw invalidReservation();
        quantities.set(reservation.variantId, (quantities.get(reservation.variantId) ?? 0n) + reservation.quantity);
      }
      const inventories = await tx.$queryRaw<LockedInventory[]>`
        SELECT id, "variantId", "branchId", physical, reserved
        FROM "Inventory"
        WHERE "branchId" = ${sale.branchId} AND "variantId" IN (${Prisma.join([...quantities.keys()])})
        ORDER BY id ASC FOR UPDATE
      `;
      const byVariant = new Map(inventories.map((inventory) => [inventory.variantId, inventory]));
      for (const [variantId, quantity] of quantities) {
        const inventory = byVariant.get(variantId);
        if (!inventory) throw invalidReservation('No se encontró el inventario de la reserva.');
        if (inventory.reserved < quantity) throw invalidReservation('El inventario reservado no puede liberar la reserva.');
      }
      for (const [variantId, quantity] of quantities) {
        await tx.inventory.update({ where: { id: byVariant.get(variantId)!.id }, data: { reserved: { decrement: quantity } } });
      }
      const ids = reservations.map(({ id }) => id);
      const updated = await tx.stockReservation.updateMany({ where: { id: { in: ids }, status: 'ACTIVE' }, data: { status: 'RELEASED' } });
      if (updated.count !== ids.length) throw invalidReservation('La reserva cambió durante la liberación.');

      const released = [...quantities].map(([variantId, quantity]) => ({ variantId, quantity }));
      await createAuditLog(tx, {
        userId: options.actor.userId, branchId: sale.branchId, action: 'RESERVATION_RELEASED', entityType: 'Sale', entityId: saleId,
        after: { saleId, reason: 'EXPIRED', trigger: options.actor.trigger, released },
      });
      return { outcome: 'RELEASED', saleId, branchId: sale.branchId, quantities: released };
    });
  }

  // Discovery runs outside any transaction and only nominates candidates
  // (shared P0.1-A predicate, deterministic, bounded); each Sale is then
  // released in its own transaction, so one failing Sale never rolls back
  // or blocks another. branchIds null = every location (SYSTEM only).
  async function reconcile(options: { actor: ReleaseActor; now: Date; branchIds: string[] | null; limit?: number }): Promise<ReconcileResult> {
    const result: ReconcileResult = { released: [], failed: [] };
    if (options.branchIds?.length === 0) return result;
    const candidates = await database.stockReservation.groupBy({
      by: ['saleId'],
      where: {
        AND: [
          releasableExpiredHoldWhere(options.now),
          ...(options.branchIds ? [{ sale: { branchId: { in: options.branchIds } } }] : []),
        ],
      },
      orderBy: { saleId: 'asc' },
      take: options.limit ?? EXPIRED_HOLD_RELEASE_BATCH_LIMIT,
    });
    for (const { saleId } of candidates) {
      try {
        const outcome = await releaseExpiredSaleHolds(saleId, {
          actor: options.actor, now: options.now, ...(options.branchIds ? { branchIds: options.branchIds } : {}),
        });
        if (outcome.outcome === 'RELEASED') {
          result.released.push({ saleId, branchId: outcome.branchId, quantities: outcome.quantities });
        }
      } catch (error) {
        result.failed.push({ saleId, code: error instanceof AppError ? error.code : 'RELEASE_FAILED' });
      }
    }
    return result;
  }

  function reconcileExpiredHolds(options: { actor: ReleaseActor; now: Date; branchIds: string[]; limit?: number }) {
    return reconcile(options);
  }

  // Automatic form for P0.1-B2's future scheduler: attributed to the system
  // actor, company-wide. Fails closed before any write if the actor is
  // missing or tampered with. It takes no clock: expiry is always decided by
  // its own wall clock, so no caller can release holds before they expire.
  async function releaseExpiredHoldsAsSystem(options: { limit?: number } = {}) {
    const userId = await resolveSystemActorId(database);
    const now = new Date();
    return reconcile({ actor: { userId, trigger: 'SYSTEM' }, now, branchIds: null, ...(options.limit ? { limit: options.limit } : {}) });
  }

  // Manual INVENTORY_MANAGE endpoint: the invoking human is the audit actor.
  function releaseExpiredReservations(scope: AuthScope) {
    return reconcile({ actor: { userId: scope.userId, trigger: 'ADMIN' }, now: new Date(), branchIds: scope.branchIds });
  }

  return { cancelSale, releaseExpiredSaleHolds, reconcileExpiredHolds, releaseExpiredHoldsAsSystem, releaseExpiredReservations };
}
