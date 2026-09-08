import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';

type ReservationDatabase = Pick<
  PrismaClient,
  | 'sale'
  | 'inventory'
  | 'stockReservation'
  | 'saleNumberCounter'
  | 'branch'
  | 'auditLog'
  | '$transaction'
>;

type LockedSale = { id: string; branchId: string; sellerId: string; status: string };
type LockedInventory = { id: string; variantId: string; physical: bigint; reserved: bigint };
type LockedCounter = { id: string; nextValue: bigint; code: string };

function saleNotDraft() {
  return new AppError(409, 'SALE_NOT_DRAFT', 'La venta no se encuentra en borrador.');
}

function insufficientStock(variantId: string) {
  return new AppError(409, 'INSUFFICIENT_STOCK', 'No hay stock disponible suficiente para la variante.', { variantId });
}

function isTransientTransactionError(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  const message = error instanceof Error ? error.message : String(error);
  return candidate.code === 'P2034'
    || candidate.meta?.code === '40P01'
    || message.includes('40001')
    || message.includes('TransactionWriteConflict');
}

function formatSaleNumber(counter: bigint, branchCode: string) {
  return `${branchCode}-V-${counter.toString().padStart(6, '0')}`;
}

async function reserveInTransaction(
  tx: Prisma.TransactionClient,
  saleId: string,
  userId: string,
  branchIds: string[],
) {
  const [sale] = await tx.$queryRaw<LockedSale[]>`
    SELECT id, "branchId", "sellerId", status
    FROM "Sale"
    WHERE id = ${saleId}
    FOR UPDATE
  `;
  if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
  if (sale.sellerId !== userId || !branchIds.includes(sale.branchId)) {
    throw new AppError(403, 'FORBIDDEN', 'No cuenta con permisos para esta venta.');
  }
  if (sale.status !== 'DRAFT') throw saleNotDraft();

  const items = await tx.saleItem.findMany({ where: { saleId }, select: { variantId: true, quantity: true } });
  if (items.length === 0) throw new AppError(409, 'EMPTY_SALE', 'No se puede enviar una venta sin artículos.');

  const requirements = new Map<string, bigint>();
  for (const item of items) {
    if (item.quantity <= 0n) throw new AppError(409, 'INVALID_SALE_QUANTITY', 'La venta contiene una cantidad inválida.');
    requirements.set(item.variantId, (requirements.get(item.variantId) ?? 0n) + item.quantity);
  }

  const variantIds = [...requirements.keys()];
  const inventories = await tx.$queryRaw<LockedInventory[]>`
    SELECT id, "variantId", physical, reserved
    FROM "Inventory"
    WHERE "branchId" = ${sale.branchId}
      AND "variantId" IN (${Prisma.join(variantIds)})
    ORDER BY id ASC
    FOR UPDATE
  `;
  const inventoryByVariant = new Map(inventories.map((inventory) => [inventory.variantId, inventory]));
  for (const variantId of variantIds) {
    const inventory = inventoryByVariant.get(variantId);
    const required = requirements.get(variantId)!;
    if (!inventory || inventory.physical - inventory.reserved < required) throw insufficientStock(variantId);
  }

  // Lock order for every send: Sale -> Inventory(id ASC) -> SaleNumberCounter.
  const [counter] = await tx.$queryRaw<LockedCounter[]>`
    SELECT counter.id, counter."nextValue", branch.code
    FROM "SaleNumberCounter" AS counter
    JOIN "Branch" AS branch ON branch.id = counter."branchId"
    WHERE counter."branchId" = ${sale.branchId}
    FOR UPDATE OF counter
  `;
  if (!counter) throw new AppError(409, 'SALE_NUMBER_COUNTER_MISSING', 'No se encontró el contador de ventas de la sucursal.');

  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  for (const [variantId, required] of requirements) {
    const inventory = inventoryByVariant.get(variantId)!;
    await tx.inventory.update({ where: { id: inventory.id }, data: { reserved: { increment: required } } });
    await tx.stockReservation.create({
      data: { saleId, variantId, branchId: sale.branchId, quantity: required, status: 'ACTIVE', expiresAt },
    });
  }

  const commercialNumber = formatSaleNumber(counter.nextValue, counter.code);
  await tx.saleNumberCounter.update({ where: { id: counter.id }, data: { nextValue: { increment: 1n } } });
  await tx.sale.update({ where: { id: saleId }, data: { status: 'PENDING_PAYMENT', saleNumber: commercialNumber } });
  await createAuditLog(tx, {
    userId, branchId: sale.branchId, action: 'SALE_SENT_TO_CASHIER', entityType: 'Sale', entityId: saleId,
    before: { status: 'DRAFT', saleNumber: null },
    after: { status: 'PENDING_PAYMENT', saleNumber: commercialNumber },
  });
  return { saleId, branchId: sale.branchId, saleNumber: commercialNumber };
}

export function createReservationService(database: ReservationDatabase) {
  async function sendToCashier(saleId: string, userId: string, branchIds: string[]) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await database.$transaction(
          (tx) => reserveInTransaction(tx, saleId, userId, branchIds),
          { isolationLevel: 'Serializable' },
        );
      } catch (error) {
        if (!isTransientTransactionError(error)) throw error;
        if (attempt === 3) throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
      }
    }
    throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
  }

  return { sendToCashier };
}