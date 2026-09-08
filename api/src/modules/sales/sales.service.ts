import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { assertBranchAccess } from '../../middleware/authorization.js';
import { AppError } from '../../shared/errors.js';
import { toJsonSafe } from '../../shared/json-safe.js';
import { createInventoryService } from '../inventory/inventory.service.js';
import type { AddSaleItemInput, UpdateSaleItemInput } from './dto/sale-item.dto.js';
import { createReservationService } from './reservation.service.js';

type SaleDatabase = PrismaClient;

const saleInclude = {
  items: {
    orderBy: { id: 'asc' as const },
    include: {
      variant: {
        select: {
          id: true, sku: true, barcode: true, color: true, size: true,
          price: true, isActive: true,
          product: { select: { id: true, name: true, slug: true, isActive: true } },
        },
      },
    },
  },
  branch: { select: { id: true, name: true, code: true } },
  seller: { select: { id: true, name: true, email: true } },
} satisfies Prisma.SaleInclude;

function notFound(message: string) {
  return new AppError(404, 'NOT_FOUND', message);
}

function ensureDraft(sale: { status: string }) {
  if (sale.status !== 'DRAFT') {
    throw new AppError(409, 'SALE_NOT_DRAFT', 'La venta no se encuentra en borrador.');
  }
}

function ensureSaleAccess(
  req: Parameters<typeof assertBranchAccess>[0],
  sale: { sellerId: string; branchId: string },
  userId: string,
) {
  assertBranchAccess(req, sale.branchId);
  if (sale.sellerId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'No cuenta con permisos para esta venta.');
  }
}

function completionConflict(code: string, message: string, details?: unknown) {
  return new AppError(409, code, message, details);
}

function isTransientCompletionError(error: unknown) {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034'
    || candidate.meta?.code === '40001'
    || candidate.meta?.code === '40P01'
    || message.includes('40001')
    || message.includes('40P01')
    || message.includes('TransactionWriteConflict');
}

function variantName(variant: { color: string | null; size: string | null }) {
  return [variant.color, variant.size].filter(Boolean).join(' / ') || 'Única';
}

async function recalculateTotals(tx: Prisma.TransactionClient, saleId: string) {
  const items = await tx.saleItem.findMany({ where: { saleId }, select: { subtotal: true } });
  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0n);
  return tx.sale.update({
    where: { id: saleId },
    data: { subtotal, discountTotal: 0n, total: subtotal },
    include: saleInclude,
  });
}

export function createSalesService(database: SaleDatabase) {
  const inventory = createInventoryService(database);
  const reservations = createReservationService(database);

  async function loadSale(saleId: string) {
    const sale = await database.sale.findUnique({ where: { id: saleId }, include: saleInclude });
    if (!sale) throw notFound('No se encontró la venta.');
    return sale;
  }

  async function authorizeSale(
    req: Parameters<typeof assertBranchAccess>[0], userId: string, saleId: string,
  ) {
    const sale = await loadSale(saleId);
    ensureSaleAccess(req, sale, userId);
    return sale;
  }

  async function createDraftSale(
    req: Parameters<typeof assertBranchAccess>[0], userId: string, requestedBranchId?: string,
  ) {
    const branchId = requestedBranchId ?? (req.auth?.branchIds.length === 1 ? req.auth.branchIds[0] : undefined);
    if (!branchId) throw new AppError(400, 'BRANCH_REQUIRED', 'Debe indicar una sucursal autorizada.');
    assertBranchAccess(req, branchId);
    return database.sale.create({
      data: { sellerId: userId, branchId, status: 'DRAFT', subtotal: 0n, discountTotal: 0n, total: 0n },
      include: saleInclude,
    });
  }

  async function addItem(
    req: Parameters<typeof assertBranchAccess>[0], userId: string, saleId: string, input: AddSaleItemInput,
  ) {
    const sale = await authorizeSale(req, userId, saleId);
    ensureDraft(sale);
    const variant = await database.productVariant.findUnique({
      where: { id: input.variantId },
      select: {
        id: true, productId: true, sku: true, price: true, color: true, size: true, isActive: true,
        product: { select: { id: true, name: true, isActive: true } },
      },
    });
    if (!variant || !variant.isActive || !variant.product.isActive) throw notFound('No se encontró la variante activa.');
    const existing = sale.items.find((item) => item.variantId === input.variantId);
    const quantity = (existing?.quantity ?? 0n) + input.quantity;
    await inventory.checkAvailability(sale.branchId, [{ variantId: input.variantId, quantity }]);
    return database.$transaction(async (tx) => {
      if (existing) {
        await tx.saleItem.update({ where: { id: existing.id }, data: { quantity, subtotal: quantity * existing.unitPrice } });
      } else {
        await tx.saleItem.create({
          data: {
            saleId, variantId: variant.id, productId: variant.productId,
            productName: variant.product.name, variantName: variantName(variant), sku: variant.sku,
            quantity, unitPrice: variant.price, subtotal: quantity * variant.price,
          },
        });
      }
      return recalculateTotals(tx, saleId);
    });
  }

  async function updateItem(
    req: Parameters<typeof assertBranchAccess>[0], userId: string, saleId: string, itemId: string, input: UpdateSaleItemInput,
  ) {
    const sale = await authorizeSale(req, userId, saleId);
    ensureDraft(sale);
    const item = sale.items.find(({ id }) => id === itemId);
    if (!item) throw notFound('No se encontró el artículo de la venta.');
    await inventory.checkAvailability(sale.branchId, [{ variantId: item.variantId, quantity: input.quantity }]);
    return database.$transaction(async (tx) => {
      await tx.saleItem.update({ where: { id: itemId }, data: { quantity: input.quantity, subtotal: input.quantity * item.unitPrice } });
      return recalculateTotals(tx, saleId);
    });
  }

  async function removeItem(req: Parameters<typeof assertBranchAccess>[0], userId: string, saleId: string, itemId: string) {
    const sale = await authorizeSale(req, userId, saleId);
    ensureDraft(sale);
    if (!sale.items.some(({ id }) => id === itemId)) throw notFound('No se encontró el artículo de la venta.');
    return database.$transaction(async (tx) => {
      await tx.saleItem.delete({ where: { id: itemId } });
      return recalculateTotals(tx, saleId);
    });
  }

  async function getDraft(req: Parameters<typeof assertBranchAccess>[0], userId: string, saleId: string) {
    const sale = await authorizeSale(req, userId, saleId);
    ensureDraft(sale);
    return sale;
  }

  async function listDrafts(userId: string, branchIds: string[]) {
    return database.sale.findMany({
      where: { sellerId: userId, branchId: { in: branchIds }, status: 'DRAFT' },
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  }

  async function sendToCashier(saleId: string, userId: string, branchIds: string[]) {
    await reservations.sendToCashier(saleId, userId, branchIds);
    return loadSale(saleId);
  }

  async function listPendingSales(branchIds: string[]) {
    const sales = await database.sale.findMany({
      where: { status: 'PENDING_PAYMENT', branchId: { in: branchIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, saleNumber: true, subtotal: true, total: true,
        seller: { select: { name: true } },
        // Historical item snapshots only; never join the current catalog.
        items: {
          orderBy: { id: 'asc' },
          select: {
            id: true, productId: true, variantId: true,
            productName: true, variantName: true, sku: true,
            quantity: true, unitPrice: true, subtotal: true,
          },
        },
        payments: { select: { amount: true } },
      },
    });
    return sales.map((sale) => {
      const paidAmount = sale.payments.reduce((sum, payment) => sum + payment.amount, 0n);
      return {
        saleId: sale.id,
        saleNumber: sale.saleNumber,
        sellerName: sale.seller.name,
        items: sale.items,
        subtotal: sale.subtotal,
        total: sale.total,
        paidAmount,
        remainingBalance: sale.total - paidAmount,
      };
    });
  }

  async function completeSaleInTransaction(
    tx: Prisma.TransactionClient,
    req: Parameters<typeof assertBranchAccess>[0],
    userId: string,
    saleId: string,
  ) {
    const [sale] = await tx.$queryRaw<Array<{
      id: string;
      branchId: string;
      status: string;
      total: bigint;
    }>>`
      SELECT id, "branchId", status, total
      FROM "Sale"
      WHERE id = ${saleId}
      FOR UPDATE
    `;
    if (!sale) throw notFound('No se encontró la venta.');

    if (!req.auth?.branchIds.includes(sale.branchId)) {
      throw new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
    }
    const assignment = await tx.userBranchRole.findFirst({
      where: { userId, branchId: sale.branchId },
      select: { id: true },
    });
    if (!assignment) throw new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');

    if (sale.status === 'COMPLETED') return tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: saleInclude });
    if (sale.status !== 'PAID') throw completionConflict('INVALID_SALE_STATE', 'La venta no está lista para finalizarse.');

    const items = await tx.saleItem.findMany({ where: { saleId }, select: { variantId: true, quantity: true } });
    const requirements = new Map<string, bigint>();
    for (const item of items) {
      if (item.quantity <= 0n) throw completionConflict('INVALID_SALE_QUANTITY', 'La venta contiene una cantidad inválida.');
      requirements.set(item.variantId, (requirements.get(item.variantId) ?? 0n) + item.quantity);
    }
    if (requirements.size === 0) throw completionConflict('INVALID_RESERVATION', 'La venta no tiene cantidades para finalizar.');

    const reservations = await tx.$queryRaw<Array<{
      id: string;
      variantId: string;
      branchId: string;
      quantity: bigint;
      status: string;
    }>>`
      SELECT id, "variantId", "branchId", quantity, status
      FROM "StockReservation"
      WHERE "saleId" = ${saleId}
      ORDER BY id ASC
      FOR UPDATE
    `;
    const reservedByVariant = new Map<string, bigint>();
    for (const reservation of reservations) {
      if (reservation.branchId !== sale.branchId || reservation.status !== 'ACTIVE') {
        throw completionConflict('INVALID_RESERVATION', 'La reserva de la venta no es válida para finalizarse.');
      }
      reservedByVariant.set(reservation.variantId, (reservedByVariant.get(reservation.variantId) ?? 0n) + reservation.quantity);
    }
    if (reservedByVariant.size !== requirements.size) {
      throw completionConflict('INVALID_RESERVATION', 'Las reservas no respaldan exactamente los artículos de la venta.');
    }
    for (const [variantId, required] of requirements) {
      if (reservedByVariant.get(variantId) !== required) {
        throw completionConflict('INVALID_RESERVATION', 'Las reservas no respaldan exactamente los artículos de la venta.', { variantId });
      }
    }

    const variantIds = [...requirements.keys()];
    const inventories = await tx.$queryRaw<Array<{
      id: string;
      variantId: string;
      physical: bigint;
      reserved: bigint;
    }>>`
      SELECT id, "variantId", physical, reserved
      FROM "Inventory"
      WHERE "branchId" = ${sale.branchId}
        AND "variantId" IN (${Prisma.join(variantIds)})
      ORDER BY id ASC
      FOR UPDATE
    `;
    const inventoryByVariant = new Map(inventories.map((inventory) => [inventory.variantId, inventory]));
    for (const [variantId, required] of requirements) {
      const inventory = inventoryByVariant.get(variantId);
      if (!inventory) throw completionConflict('INVENTORY_NOT_FOUND', 'No se encontró el inventario de la variante.', { variantId });
      if (inventory.physical < required) throw completionConflict('INSUFFICIENT_PHYSICAL', 'El inventario físico no puede cubrir la venta.', { variantId });
      if (inventory.reserved < required) throw completionConflict('INSUFFICIENT_RESERVED', 'El inventario reservado no puede cubrir la venta.', { variantId });
    }

    const finalizedInventory: Array<{ variantId: string; quantity: bigint }> = [];
    for (const [variantId, required] of requirements) {
      const inventory = inventoryByVariant.get(variantId)!;
      await tx.inventory.update({
        where: { id: inventory.id },
        data: {
          physical: inventory.physical - required,
          reserved: inventory.reserved - required,
        },
      });
      await tx.stockMovement.create({
        data: {
          inventoryId: inventory.id,
          type: 'SALE',
          quantityDelta: -required,
          saleId,
          userId,
          branchId: sale.branchId,
        },
      });
      finalizedInventory.push({ variantId, quantity: required });
    }

    await tx.stockReservation.updateMany({
      where: { saleId, status: 'ACTIVE' },
      data: { status: 'CONSUMED' },
    });
    await tx.auditLog.create({
      data: {
        userId,
        branchId: sale.branchId,
        action: 'SALE_COMPLETED',
        entityType: 'Sale',
        entityId: saleId,
        before: toJsonSafe({ status: 'PAID' }) as Prisma.InputJsonValue,
        after: toJsonSafe({ status: 'COMPLETED', inventory: finalizedInventory }) as Prisma.InputJsonValue,
      },
    });
    await tx.sale.update({ where: { id: saleId }, data: { status: 'COMPLETED' } });
    return tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: saleInclude });
  }

  async function completeSale(
    req: Parameters<typeof assertBranchAccess>[0], userId: string, saleId: string,
  ) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await database.$transaction(
          (tx) => completeSaleInTransaction(tx, req, userId, saleId),
          { isolationLevel: 'Serializable', timeout: 30000 },
        );
      } catch (error) {
        if (!isTransientCompletionError(error)) throw error;
        if (attempt === 3) throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
      }
    }
    throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
  }

  return { createDraftSale, addItem, updateItem, removeItem, getDraft, listDrafts, sendToCashier, listPendingSales, completeSale };
}
