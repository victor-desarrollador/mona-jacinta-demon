import type { Request } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { PRODUCTION_PERMISSIONS, actsAsSupervisorAtLocation } from '../rbac/index.js';
import { createPricingService } from '../pricing/pricing.service.js';
import { variantSearchWhere } from '../products/variant-search.js';
import { exchangeReplacementsQueryDto } from './dto/exchange-replacements-query.dto.js';
import { compareReplacementPrice, type ReplacementComparison } from './replacement-price.js';
import { unitPriceFor } from './wholesale-authorization.service.js';

// The replacement candidates the Cambios UI offers for ONE SaleItem, each with the unit price POST /sales/:saleId/exchanges WOULD charge for it.
// INFORMATIONAL: no lock, no transaction, nothing is written; POST /exchanges re-validates everything under the Sale lock and stays the only
// authority (stock, price, catalog and idempotency).
//
// One rule per question, never a second copy of it:
//   - price      unitPriceFor(sale.pricingMode, variant, sale.priceMode, pricing snapshot): the function the exchange service calls;
//   - comparison compareReplacementPrice(SaleItem.unitPrice, replacement): the classification the exchange service refuses on;
//   - search     variantSearchWhere: the text filter of GET /variants.
//
// Authorization runs FIRST, against the REQUESTED branch (OWNER, or a COMPANY-scoped ADMIN holding SALE_EXCHANGE: the same actsAsSupervisorAtLocation
// decision the exchange service and GET /sales/exchangeable take), so a caller who is not the supervisor gets the same 403 whether the sale exists
// or not. The sale is then looked up by (id, branchId) and must be COMPLETED, and the SaleItem must belong to it.
//
// Candidates: active variants of active products that HAVE a base price for the sale's pricingMode (a variant without one would make the exchange
// fail with a pricing error whatever the cashier does), never the variant already on that SaleItem (POST answers NO_OP_EXCHANGE). CHEAPER,
// MORE_EXPENSIVE and zero-stock candidates are returned on purpose: the UI shows them disabled and explains why.
//
// Stock: available = max(physical - reserved, 0) of the Inventory in the SALE's branch, "0" when there is no row. That is the snapshot the exchange
// takes under lock (`physical - reserved`), NOT effectiveAvailability(): that one frees expired holds, which the exchange does not, so it could
// show stock the exchange then refuses.

const SALE_EXCHANGE_PERMISSION = PRODUCTION_PERMISSIONS.SALE_EXCHANGE;

export type ExchangeReplacementCandidate = {
  id: string;
  productId: string;
  sku: string;
  barcode: string | null;
  color: string | null;
  size: string | null;
  product: { id: string; name: string };
  available: bigint;
  replacementUnitPrice: bigint;
  comparison: ReplacementComparison;
};

export type ExchangeReplacementsResult = {
  sale: { id: string; saleNumber: string; branchId: string; pricingMode: string; priceMode: string };
  saleItem: { id: string; variantId: string; originalUnitPrice: bigint };
  items: ExchangeReplacementCandidate[];
  pagination: { page: number; limit: number; total: number };
};

const toBigInt = (value: unknown) => BigInt(typeof value === 'bigint' ? value : String(value));

export function createSaleExchangeReplacementsService(database: PrismaClient) {
  const pricing = createPricingService(database);

  async function findReplacements(req: Pick<Request, 'auth'>, rawSaleId: string, rawQuery: unknown): Promise<ExchangeReplacementsResult> {
    const auth = req.auth;
    if (!auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
    const parsed = exchangeReplacementsQueryDto.safeParse(rawQuery);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Los datos de la búsqueda no son válidos.');
    const { branchId, saleItemId, search, page, limit } = parsed.data;
    const saleId = String(rawSaleId).toLowerCase();

    if (!actsAsSupervisorAtLocation(auth, [SALE_EXCHANGE_PERMISSION], branchId)) {
      throw new AppError(403, 'FORBIDDEN', 'No cuenta con permisos para cambiar esta venta.');
    }

    const sale = await database.sale.findFirst({
      where: { id: saleId, branchId },
      select: { id: true, saleNumber: true, branchId: true, status: true, pricingMode: true, priceMode: true },
    });
    if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
    if (sale.status !== 'COMPLETED') throw new AppError(409, 'INVALID_SALE_STATE', 'La venta no puede cambiarse en su estado actual.');

    const item = await database.saleItem.findFirst({ where: { id: saleItemId, saleId: sale.id }, select: { id: true, variantId: true, unitPrice: true } });
    if (!item) throw new AppError(409, 'SALE_ITEM_MISMATCH', 'El artículo indicado no pertenece a esta venta.');
    const original = toBigInt(item.unitPrice);

    const config = await pricing.getSnapshot(database);
    const where = {
      isActive: true,
      product: { isActive: true },
      id: { not: item.variantId },
      // A positive base for the tier the sale was priced on: exactly what unitPriceFor needs not to refuse.
      ...(sale.pricingMode === 'LIST' ? { cashPrice: { gt: 0n } } : { wholesalePrice: { gt: 0n } }),
      ...variantSearchWhere(search),
    };
    const [rows, total] = await Promise.all([
      database.productVariant.findMany({
        where,
        orderBy: [{ product: { name: 'asc' } }, { sku: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true, productId: true, sku: true, barcode: true, color: true, size: true, cashPrice: true, wholesalePrice: true,
          product: { select: { id: true, name: true } },
          inventory: { where: { branchId: sale.branchId }, select: { physical: true, reserved: true } },
        },
      }),
      database.productVariant.count({ where }),
    ]);

    const items = rows.map((variant): ExchangeReplacementCandidate => {
      const { unitPrice } = unitPriceFor(sale.pricingMode, { id: variant.id, cashPrice: variant.cashPrice, wholesalePrice: variant.wholesalePrice }, sale.priceMode, config);
      const stock = variant.inventory[0];
      const free = stock ? toBigInt(stock.physical) - toBigInt(stock.reserved) : 0n;
      return {
        id: variant.id, productId: variant.productId, sku: variant.sku, barcode: variant.barcode, color: variant.color, size: variant.size,
        product: { id: variant.product.id, name: variant.product.name },
        available: free > 0n ? free : 0n,
        replacementUnitPrice: unitPrice,
        comparison: compareReplacementPrice(original, unitPrice),
      };
    });

    return {
      sale: { id: sale.id, saleNumber: sale.saleNumber ?? '', branchId: sale.branchId, pricingMode: sale.pricingMode, priceMode: sale.priceMode },
      saleItem: { id: item.id, variantId: item.variantId, originalUnitPrice: original },
      items,
      pagination: { page, limit, total },
    };
  }

  return { findReplacements };
}

export type SaleExchangeReplacementsService = ReturnType<typeof createSaleExchangeReplacementsService>;
