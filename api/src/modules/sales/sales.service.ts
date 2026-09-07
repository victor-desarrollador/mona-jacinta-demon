import type { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { assertBranchAccess } from '../../middleware/authorization.js';
import { AppError } from '../../shared/errors.js';
import { createInventoryService } from '../inventory/inventory.service.js';
import type { AddSaleItemInput, UpdateSaleItemInput } from './dto/sale-item.dto.js';

type SaleDatabase = Pick<PrismaClient, 'sale' | 'productVariant' | 'inventory' | '$transaction'>;

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

  return { createDraftSale, addItem, updateItem, removeItem, getDraft, listDrafts };
}