import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { toJsonSafe } from '../../shared/json-safe.js';

type AuthScope = { userId: string; branchIds: string[] };
type LockedSale = { id: string; branchId: string; status: string };
type LockedReservation = { id: string; variantId: string; branchId: string; quantity: bigint; status: string; expiresAt: Date };
type LockedInventory = { id: string; variantId: string; branchId: string; physical: bigint; reserved: bigint };

const invalidState = () => new AppError(409, 'INVALID_SALE_STATE', 'La venta no puede cancelarse en su estado actual.');
const invalidReservation = (message = 'La reserva de la venta no es válida.') => new AppError(409, 'INVALID_RESERVATION', message);
const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');

function transient(error: unknown) {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034' || candidate.meta?.code === '40001'
    || candidate.meta?.code === '40P01' || message.includes('40001') || message.includes('40P01');
}

async function branchAssignment(tx: Prisma.TransactionClient, scope: AuthScope, branchId: string) {
  if (!scope.branchIds.includes(branchId)) throw forbidden();
  const assigned = await tx.userBranchRole.findFirst({ where: { userId: scope.userId, branchId }, select: { id: true } });
  if (!assigned) throw forbidden();
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

  async function cancelSale(saleId: string, scope: AuthScope) {
    return inTransaction(async (tx) => {
      const [sale] = await tx.$queryRaw<LockedSale[]>`SELECT id, "branchId", status FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
      if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
      await branchAssignment(tx, scope, sale.branchId);
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
      await tx.auditLog.create({ data: {
        userId: scope.userId, branchId: sale.branchId, action: 'SALE_CANCELLED', entityType: 'Sale', entityId: saleId,
        before: toJsonSafe({ status: sale.status }) as Prisma.InputJsonValue,
        after: toJsonSafe({ status: 'CANCELLED', released }) as Prisma.InputJsonValue,
      } });
      return { saleId, branchId: sale.branchId, status: 'CANCELLED', released };
    });
  }

  async function releaseExpiredReservations(scope: AuthScope) {
    if (scope.branchIds.length === 0) return { released: [] };
    return inTransaction(async (tx) => {
      const now = new Date();
      const candidates = await tx.$queryRaw<{ saleId: string }[]>`
        SELECT DISTINCT sr."saleId" FROM "StockReservation" sr
        JOIN "Sale" s ON s.id = sr."saleId"
        WHERE sr.status = 'ACTIVE' AND sr."expiresAt" < ${now}
          AND s.status = 'PENDING_PAYMENT' AND s."branchId" IN (${Prisma.join(scope.branchIds)})
        ORDER BY sr."saleId" ASC
      `;
      const released: Array<{ saleId: string; branchId: string; quantities: Array<{ variantId: string; quantity: bigint }> }> = [];
      for (const candidate of candidates) {
        const [sale] = await tx.$queryRaw<LockedSale[]>`SELECT id, "branchId", status FROM "Sale" WHERE id = ${candidate.saleId} FOR UPDATE`;
        if (!sale || !scope.branchIds.includes(sale.branchId)) continue;
        await branchAssignment(tx, scope, sale.branchId);
        if (sale.status !== 'PENDING_PAYMENT') continue;
        if (await acceptedTotal(tx, sale.id) > 0n) continue;
        const reservations = await tx.$queryRaw<LockedReservation[]>`
          SELECT id, "variantId", "branchId", quantity, status, "expiresAt"
          FROM "StockReservation"
          WHERE "saleId" = ${sale.id} AND status = 'ACTIVE' AND "expiresAt" < ${now}
          ORDER BY id ASC FOR UPDATE
        `;
        const quantities = await releaseReservations(tx, sale, reservations);
        if (quantities.length === 0) continue;
        await tx.auditLog.create({ data: {
          userId: scope.userId, branchId: sale.branchId, action: 'RESERVATION_RELEASED', entityType: 'Sale', entityId: sale.id,
          after: toJsonSafe({ saleId: sale.id, released: quantities, reason: 'EXPIRED' }) as Prisma.InputJsonValue,
        } });
        released.push({ saleId: sale.id, branchId: sale.branchId, quantities });
      }
      return { released };
    });
  }

  return { cancelSale, releaseExpiredReservations };
}
