// R3-A4.3 S4: the persisted price snapshot of a proportional sale, turned into
// the engine's line input. Same rules, order and codes as the R3-A2 quote and
// settlement (checkout-quote.service.ts / checkout.service.ts), which S5 can
// adopt instead of their private copies. It reads, never writes; the caller
// owns the transaction and has already locked the sale.
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import type { PriceType } from '../../generated/prisma/client.js';
import type { ProportionalLineInput } from '../pricing/proportional-checkout.js';
import { assertPricingFinalizable } from '../sales/wholesale-authorization.service.js';

const snapshotInconsistent = (message: string) => new AppError(409, 'PRICING_SNAPSHOT_INCONSISTENT', message);

export async function loadProportionalLines(
  tx: Pick<Prisma.TransactionClient, 'saleItem'>,
  sale: { id: string; pricingMode: string; priceMode: string; wholesaleConfirmedAt: Date | null; wholesaleConfirmedById: string | null },
): Promise<ProportionalLineInput[]> {
  assertPricingFinalizable({
    pricingMode: sale.pricingMode as PriceType,
    wholesaleConfirmedAt: sale.wholesaleConfirmedAt,
    wholesaleConfirmedById: sale.wholesaleConfirmedById,
  });
  if (sale.priceMode !== 'CASH') throw snapshotInconsistent('Una venta proporcional debe estar tasada en efectivo.');
  const items = await tx.saleItem.findMany({
    where: { saleId: sale.id },
    select: { id: true, sku: true, quantity: true, baseUnitPrice: true, priceMode: true, priceBaseType: true },
    orderBy: { id: 'asc' },
  });
  if (items.length === 0) throw snapshotInconsistent('La venta no tiene renglones para cotizar.');
  return items.map((item) => {
    if (item.priceMode !== 'CASH') throw snapshotInconsistent('Un renglón no está tasado en efectivo.');
    if (item.priceBaseType !== sale.pricingMode) throw snapshotInconsistent('La base del renglón no coincide con la venta.');
    if (item.baseUnitPrice === null || item.baseUnitPrice <= 0n || item.quantity <= 0n) {
      throw snapshotInconsistent('Un renglón tiene cantidad o precio base inválido.');
    }
    return { saleItemId: item.id, sku: item.sku, quantity: item.quantity, baseUnitPrice: item.baseUnitPrice };
  });
}
