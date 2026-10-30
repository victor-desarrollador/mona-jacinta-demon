import { isTransientTransactionError } from '../../shared/transient-transaction-error.js';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { Prisma, type PriceType, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { PRODUCTION_PERMISSIONS, actsAsSupervisorAtLocation } from '../rbac/index.js';
import type { PriceMode } from '../pricing/pricing.js';
import { createPricingService } from '../pricing/pricing.service.js';
import { exchangeSaleDto, type ExchangeSaleInput } from './dto/exchange-sale.dto.js';
import { unitPriceFor } from './wholesale-authorization.service.js';
import { compareReplacementPrice } from './replacement-price.js';

// Sale exchange v1: a garment swap on a COMPLETED sale, at EQUAL value per line. It moves no money and leaves no debt; the Sale, its
// SaleItems and its SalePayments are never touched (and neither is any cash row). All in ONE Serializable transaction:
//   - one SaleExchange (the durable record and the idempotency source, UNIQUE(saleId, idempotencyKey), with the canonical request hash);
//   - one SaleExchangeLine per returned SaleItem, with the original and the replacement unit price frozen (equal by CHECK);
//   - Inventory.physical +N on the original variant and -N on the replacement, in the SALE's branch, and the append-only ledger of it:
//     one StockMovement SALE_EXCHANGE_IN (+N) and one SALE_EXCHANGE_OUT (-N) per line;
//   - one SALE_EXCHANGED audit row.
//
// Order of decisions (every step before the writes is read-only, so a refusal writes nothing):
//   auth -> input shape -> Sale FOR UPDATE -> supervisor at the sale's persisted branch -> existing exchange of this (sale, key): replay or
//   conflict -> state COMPLETED -> SaleItems of THIS sale -> exchanged-so-far (remainder) -> replacement variants (active, 404) -> NO_OP ->
//   per-line price (equal value only) -> Inventory of the original AND replacement variants locked together, ordered by id ->
//   availability -> writes -> audit.
// Authorization runs after the lock and before everything that depends on the sale's content, so a caller without SALE_EXCHANGE learns
// nothing about it. The replay comes BEFORE the state, the catalog and the stock: a retry of a request that already succeeded returns what was
// stored (frozen prices included), whatever the catalog or the stock look like today.
// Lock order: Sale -> Inventory (one statement, ORDER BY id ASC). It takes neither a CashSession nor a StockReservation lock, so it is a
// prefix-compatible extension of every other writer of these rows (payments, finalization, cancellation, void, checkout).
// The database enforces the same invariants independently (sale_exchange_schema + sale_void_exchange_guard): this service is never the only guard.

const MAX_SIGNED_BIGINT = 9223372036854775807n;
const SALE_EXCHANGE_PERMISSION = PRODUCTION_PERMISSIONS.SALE_EXCHANGE;

type LockedSale = { id: string; branchId: string; status: string; pricingMode: PriceType; priceMode: PriceMode };
type LockedInventory = { id: string; variantId: string; branchId: string; physical: bigint; reserved: bigint };

export type SaleExchangeLineResult = {
  saleItemId: string;
  returnQuantity: bigint;
  replacementVariantId: string;
  originalUnitPrice: bigint;
  replacementUnitPrice: bigint;
};
// Final state of one Inventory row the exchange modified, read from the UPDATE itself inside the transaction (so it is exactly what committed).
export type SaleExchangeInventoryState = { inventoryId: string; variantId: string; physical: bigint; reserved: bigint };
export type SaleExchangeResult = {
  saleId: string;
  exchangeId: string;
  branchId: string;
  replayed: boolean;
  // For the post-commit realtime notification only (never part of the HTTP body). One entry per Inventory id, ordered by id, carrying the
  // FINAL state after every line; EMPTY for a replay, which modifies nothing.
  inventories: SaleExchangeInventoryState[];
  // Ordered by saleItemId, so a replay (rebuilt from the stored rows) is byte-identical to the first answer.
  lines: SaleExchangeLineResult[];
};

const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con permisos para cambiar esta venta.');
const notFound = (message: string) => new AppError(404, 'NOT_FOUND', message);
const concurrency = () => new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
const insufficientStock = (variantId: string) => new AppError(409, 'INSUFFICIENT_STOCK', 'No hay stock disponible suficiente para la variante.', { variantId });
const stockInconsistent = (message: string) => new AppError(409, 'SALE_EXCHANGE_STOCK_INCONSISTENT', message);

const toBigInt = (value: unknown) => BigInt(typeof value === 'bigint' ? value : String(value));
const bySaleItem = <T extends { saleItemId: string }>(rows: T[]) => [...rows].sort((a, b) => (a.saleItemId < b.saleItemId ? -1 : a.saleItemId > b.saleItemId ? 1 : 0));

// The canonical request: the same intent always hashes the same, whatever the order of the lines. The reason is already trimmed by the DTO.
function requestHashOf(saleId: string, input: ExchangeSaleInput) {
  const lines = bySaleItem(input.lines).map((line) => ({
    saleItemId: line.saleItemId, replacementVariantId: line.replacementVariantId, returnQuantity: line.returnQuantity.toString(),
  }));
  return createHash('sha256').update(JSON.stringify({ version: 1, saleId, reason: input.reason, lines })).digest('hex');
}

export function createSaleExchangeService(database: PrismaClient) {
  const pricing = createPricingService(database);

  async function inTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await database.$transaction(operation, { isolationLevel: 'Serializable', timeout: 30000 });
      } catch (error) {
        if (!isTransientTransactionError(error)) throw error;
        if (attempt === 2) throw concurrency();
      }
    }
    throw concurrency();
  }

  async function exchangeSale(req: Pick<Request, 'auth'>, rawSaleId: string, rawInput: unknown): Promise<SaleExchangeResult> {
    // One spelling per UUID before any query or hash (the DTO does the same for the body ids).
    const saleId = String(rawSaleId).toLowerCase();
    const auth = req.auth;
    if (!auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
    const parsed = exchangeSaleDto.safeParse(rawInput);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Los datos del cambio no son válidos.');
    const input = parsed.data;
    const requestHash = requestHashOf(saleId, input);

    return inTransaction(async (tx): Promise<SaleExchangeResult> => {
      // 1. The Sale row is the FIRST lock: every writer of this sale's state (and every other exchange of it) serializes here.
      const [sale] = await tx.$queryRaw<LockedSale[]>`SELECT id, "branchId", status, "pricingMode", "priceMode" FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
      if (!sale) throw notFound('No se encontró la venta.');

      // 2. Supervisor (OWNER, or a COMPANY-scoped ADMIN holding SALE_EXCHANGE), against the PERSISTED branch.
      if (!actsAsSupervisorAtLocation(auth, [SALE_EXCHANGE_PERMISSION], sale.branchId)) throw forbidden();

      // 3. An exchange already exists for this (sale, key): the same intent returns what was stored (no revalidation of stock, catalog or
      //    price), another intent is a conflict. Nothing is written.
      const existing = await tx.saleExchange.findFirst({ where: { saleId, idempotencyKey: input.idempotencyKey } });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'La clave de idempotencia ya se usó con otros datos.');
        }
        const stored = await tx.saleExchangeLine.findMany({ where: { saleExchangeId: existing.id } });
        return {
          saleId, exchangeId: existing.id, branchId: existing.branchId, replayed: true, inventories: [],
          lines: bySaleItem(stored.map((row) => ({
            saleItemId: row.saleItemId, returnQuantity: row.returnQuantity, replacementVariantId: row.replacementVariantId,
            originalUnitPrice: row.originalUnitPrice, replacementUnitPrice: row.replacementUnitPrice,
          }))),
        };
      }

      // 4. State: only COMPLETED sales can be exchanged.
      if (sale.status !== 'COMPLETED') {
        throw new AppError(409, 'INVALID_SALE_STATE', 'La venta no puede cambiarse en su estado actual.');
      }

      // 5. Every requested SaleItem must exist AND belong to this very sale. The original price is the historical SaleItem.unitPrice
      //    snapshot, never the sold variant's price today.
      const saleItems = await tx.saleItem.findMany({
        where: { id: { in: input.lines.map((line) => line.saleItemId) } },
        select: { id: true, saleId: true, variantId: true, quantity: true, unitPrice: true },
      });
      const itemById = new Map(saleItems.map((item) => [item.id, item]));
      for (const line of input.lines) {
        if (itemById.get(line.saleItemId)?.saleId !== saleId) {
          throw new AppError(409, 'SALE_ITEM_MISMATCH', 'Un artículo indicado no pertenece a esta venta.');
        }
      }

      // 6. Remainder: what was sold minus what EARLIER exchanges already took back (the Sale lock serializes every exchange of this sale,
      //    so this read cannot be stale). A line never asks for more than what is left; the whole request is refused otherwise.
      const earlier = await tx.saleExchangeLine.findMany({
        where: { saleItemId: { in: input.lines.map((line) => line.saleItemId) } },
        select: { saleItemId: true, returnQuantity: true },
      });
      const exchanged = new Map<string, bigint>();
      for (const row of earlier) exchanged.set(row.saleItemId, (exchanged.get(row.saleItemId) ?? 0n) + row.returnQuantity);
      for (const line of input.lines) {
        const item = itemById.get(line.saleItemId)!;
        if (line.returnQuantity > item.quantity - (exchanged.get(line.saleItemId) ?? 0n)) {
          throw new AppError(409, 'EXCHANGE_QUANTITY_EXCEEDED', 'La cantidad a cambiar supera lo que queda por cambiar de ese artículo.');
        }
      }

      // 7. Every replacement variant must exist and be sellable (variant AND parent product active).
      const variantIds = [...new Set(input.lines.map((line) => line.replacementVariantId))];
      const variants = await tx.productVariant.findMany({
        where: { id: { in: variantIds }, isActive: true, product: { isActive: true } },
        select: { id: true, cashPrice: true, wholesalePrice: true },
      });
      const variantById = new Map(variants.map((variant) => [variant.id, variant]));
      if (variantById.size !== variantIds.length) throw new AppError(404, 'NOT_FOUND', 'No se encontró la variante de reemplazo.');

      // 8. Same variant is a no-op.
      for (const line of input.lines) {
        if (itemById.get(line.saleItemId)!.variantId === line.replacementVariantId) {
          throw new AppError(409, 'NO_OP_EXCHANGE', 'La variante de reemplazo es la misma que la vendida.');
        }
      }

      // 9. Equal value per line, never netted. The replacement is priced TODAY (catalog + pricing config) with the original sale's own
      //    pricing context (sale.pricingMode / sale.priceMode) and frozen in the line.
      const config = await pricing.getSnapshot(tx);
      const priced = input.lines.map((line) => {
        const original = itemById.get(line.saleItemId)!.unitPrice;
        const replacement = unitPriceFor(sale.pricingMode, variantById.get(line.replacementVariantId)!, sale.priceMode, config).unitPrice;
        const comparison = compareReplacementPrice(original, replacement);
        if (comparison === 'CHEAPER') {
          throw new AppError(409, 'REPLACEMENT_CHEAPER_NOT_SUPPORTED', 'La prenda de reemplazo es más barata: este cambio solo admite igual valor.');
        }
        if (comparison === 'MORE_EXPENSIVE') {
          throw new AppError(409, 'REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED', 'La prenda de reemplazo es más cara: este cambio solo admite igual valor.');
        }
        return { line, item: itemById.get(line.saleItemId)!, original, replacement };
      });

      // 10. Inventory: the original AND the replacement variants of ALL lines, in the SALE's branch, locked together in ONE statement
      //     ordered by id (two exchanges can never take them in opposite orders).
      const inventoryVariantIds = [...new Set([...priced.map(({ item }) => item.variantId), ...variantIds])];
      const locked = await tx.$queryRaw<LockedInventory[]>`
        SELECT id, "variantId", "branchId", physical, reserved
        FROM "Inventory"
        WHERE "branchId" = ${sale.branchId} AND "variantId" IN (${Prisma.join(inventoryVariantIds)})
        ORDER BY id ASC
        FOR UPDATE
      `;
      const inventoryByVariant = new Map(locked.map((row) => [row.variantId, { ...row, physical: toBigInt(row.physical), reserved: toBigInt(row.reserved) }]));

      // 11. Availability, judged on the stock as locked BEFORE this request (available = physical - reserved): the units this very request
      //     returns never finance its own outputs, and several lines drawing the same replacement are summed. No negative stock, no overflow.
      const demand = new Map<string, bigint>();
      const incoming = new Map<string, bigint>();
      for (const { line, item } of priced) {
        demand.set(line.replacementVariantId, (demand.get(line.replacementVariantId) ?? 0n) + line.returnQuantity);
        incoming.set(item.variantId, (incoming.get(item.variantId) ?? 0n) + line.returnQuantity);
      }
      for (const [variantId, quantity] of demand) {
        const inventory = inventoryByVariant.get(variantId);
        if (!inventory || inventory.physical - inventory.reserved < quantity) throw insufficientStock(variantId);
      }
      for (const [variantId, quantity] of incoming) {
        const inventory = inventoryByVariant.get(variantId);
        if (!inventory) throw stockInconsistent('No se encontró el inventario de la variante original en la sucursal de la venta.');
        if (inventory.physical + quantity > MAX_SIGNED_BIGINT) throw stockInconsistent('El reingreso excede el límite del inventario físico.');
      }

      // 12. Writes: the exchange, then each line with its two ledger rows, then the inventory, then the audit.
      const created = await tx.saleExchange.create({
        data: { saleId, branchId: sale.branchId, createdById: auth.userId, reason: input.reason, idempotencyKey: input.idempotencyKey, requestHash },
      });
      const lines: SaleExchangeLineResult[] = [];
      const finalInventories = new Map<string, SaleExchangeInventoryState>();
      for (const { line, item, original, replacement } of priced) {
        const row = await tx.saleExchangeLine.create({
          data: {
            saleExchangeId: created.id, saleId, branchId: sale.branchId, saleItemId: line.saleItemId, replacementVariantId: line.replacementVariantId,
            returnQuantity: line.returnQuantity, originalUnitPrice: original, replacementUnitPrice: replacement,
          },
        });
        const inInventory = inventoryByVariant.get(item.variantId)!;
        const outInventory = inventoryByVariant.get(line.replacementVariantId)!;
        await tx.stockMovement.create({
          data: {
            inventoryId: inInventory.id, type: 'SALE_EXCHANGE_IN', quantityDelta: line.returnQuantity, saleId, saleExchangeId: created.id,
            saleExchangeLineId: row.id, userId: auth.userId, branchId: sale.branchId,
          },
        });
        await tx.stockMovement.create({
          data: {
            inventoryId: outInventory.id, type: 'SALE_EXCHANGE_OUT', quantityDelta: -line.returnQuantity, saleId, saleExchangeId: created.id,
            saleExchangeLineId: row.id, userId: auth.userId, branchId: sale.branchId,
          },
        });
        // The same Inventory can take part in several lines (and as IN of one and OUT of another): the last UPDATE of each id is its final state.
        for (const updated of [
          await tx.inventory.update({ where: { id: inInventory.id }, data: { physical: { increment: line.returnQuantity } } }),
          await tx.inventory.update({ where: { id: outInventory.id }, data: { physical: { increment: -line.returnQuantity } } }),
        ]) {
          finalInventories.set(updated.id, { inventoryId: updated.id, variantId: updated.variantId, physical: updated.physical, reserved: updated.reserved });
        }
        lines.push({
          saleItemId: line.saleItemId, returnQuantity: line.returnQuantity, replacementVariantId: line.replacementVariantId,
          originalUnitPrice: original, replacementUnitPrice: replacement,
        });
      }

      await createAuditLog(tx, {
        userId: auth.userId, branchId: sale.branchId, action: 'SALE_EXCHANGED', entityType: 'Sale', entityId: saleId,
        before: { status: sale.status },
        after: {
          exchangeId: created.id, reason: input.reason, idempotencyKey: input.idempotencyKey,
          lines: bySaleItem(priced.map(({ line, item, original, replacement }) => ({
            saleItemId: line.saleItemId, returnQuantity: line.returnQuantity.toString(), originalVariantId: item.variantId,
            replacementVariantId: line.replacementVariantId, originalUnitPrice: original.toString(), replacementUnitPrice: replacement.toString(),
          }))),
        },
      });
      return {
        saleId, exchangeId: created.id, branchId: sale.branchId, replayed: false, lines: bySaleItem(lines),
        inventories: [...finalInventories.values()].sort((a, b) => (a.inventoryId < b.inventoryId ? -1 : 1)),
      };
    });
  }

  return { exchangeSale };
}

export type SaleExchangeService = ReturnType<typeof createSaleExchangeService>;
