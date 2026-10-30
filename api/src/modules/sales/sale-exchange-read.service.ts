import type { Request } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { PRODUCTION_PERMISSIONS, actsAsSupervisorAtLocation } from '../rbac/index.js';
import { exchangeableSaleQueryDto } from './dto/exchangeable-sale-query.dto.js';

// The read the Cambios UI needs before it can offer a garment swap: the sale found by its own unique key (branch + sale number), and for
// every SaleItem how much was sold, how much earlier exchanges already took back, and how much is left. INFORMATIONAL: no lock, nothing is
// written, and POST /sales/:saleId/exchanges re-validates everything under the Sale lock (sale-exchange.service.ts is the only authority).
//
// Authorization runs FIRST, against the REQUESTED branch (OWNER, or a COMPANY-scoped ADMIN holding SALE_EXCHANGE: the same
// actsAsSupervisorAtLocation decision the exchange service takes against the sale's persisted branch), so a caller who is not the
// supervisor gets the same 403 whether the sale exists or not. The sale is then looked up by (branchId, saleNumber), so a sale of another
// branch is never returned.
//
// The remainder is the same sum the exchange service uses (sold minus every earlier SaleExchangeLine.returnQuantity of that item); the
// parity with POST is pinned in sale-exchange-read.http.test.ts.

const SALE_EXCHANGE_PERMISSION = PRODUCTION_PERMISSIONS.SALE_EXCHANGE;

export type ExchangeableSaleLine = {
  saleItemId: string;
  variantId: string;
  productName: string;
  variantName: string;
  sku: string;
  quantity: bigint;
  unitPrice: bigint;
  exchangedQuantity: bigint;
  remainingQuantity: bigint;
};

export type ExchangeableSaleResult = {
  sale: { id: string; saleNumber: string; branchId: string; status: string; pricingMode: string; priceMode: string; total: bigint };
  exchangeable: boolean;
  lines: ExchangeableSaleLine[];
};

const toBigInt = (value: unknown) => BigInt(typeof value === 'bigint' ? value : String(value));

export function createSaleExchangeReadService(database: PrismaClient) {
  async function findExchangeableSale(req: Pick<Request, 'auth'>, rawQuery: unknown): Promise<ExchangeableSaleResult> {
    const auth = req.auth;
    if (!auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
    const parsed = exchangeableSaleQueryDto.safeParse(rawQuery);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Los datos de la búsqueda no son válidos.');
    const { branchId, saleNumber } = parsed.data;

    if (!actsAsSupervisorAtLocation(auth, [SALE_EXCHANGE_PERMISSION], branchId)) {
      throw new AppError(403, 'FORBIDDEN', 'No cuenta con permisos para cambiar esta venta.');
    }

    const sale = await database.sale.findFirst({
      where: { branchId, saleNumber },
      select: { id: true, saleNumber: true, branchId: true, status: true, pricingMode: true, priceMode: true, total: true },
    });
    if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');

    const items = await database.saleItem.findMany({
      where: { saleId: sale.id },
      orderBy: { id: 'asc' },
      select: { id: true, variantId: true, productName: true, variantName: true, sku: true, quantity: true, unitPrice: true },
    });
    const earlier = await database.saleExchangeLine.findMany({
      where: { saleId: sale.id },
      select: { saleItemId: true, returnQuantity: true },
    });
    const exchanged = new Map<string, bigint>();
    for (const row of earlier) exchanged.set(row.saleItemId, (exchanged.get(row.saleItemId) ?? 0n) + toBigInt(row.returnQuantity));

    return {
      sale: {
        id: sale.id, saleNumber: sale.saleNumber ?? saleNumber, branchId: sale.branchId, status: sale.status,
        pricingMode: sale.pricingMode, priceMode: sale.priceMode, total: toBigInt(sale.total),
      },
      exchangeable: sale.status === 'COMPLETED',
      lines: items.map((item) => {
        const sold = toBigInt(item.quantity);
        const taken = exchanged.get(item.id) ?? 0n;
        return {
          saleItemId: item.id, variantId: item.variantId, productName: item.productName, variantName: item.variantName, sku: item.sku,
          quantity: sold, unitPrice: toBigInt(item.unitPrice), exchangedQuantity: taken, remainingQuantity: sold > taken ? sold - taken : 0n,
        };
      }),
    };
  }

  return { findExchangeableSale };
}

export type SaleExchangeReadService = ReturnType<typeof createSaleExchangeReadService>;
