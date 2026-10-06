import { Prisma, type PriceType, type PrismaClient } from '../../generated/prisma/client.js';
import { assertPermissionAtLocation } from '../../middleware/authorization.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { evaluateCurrentHoldCoverage } from './hold-coverage.js';
import { unitPriceFor } from './wholesale-authorization.service.js';
import type { CorrectPendingSaleInput } from './dto/pending-correction.dto.js';

type RequestLike = Parameters<typeof assertPermissionAtLocation>[0];
type LockedSale = {
  id: string; branchId: string; status: string; total: bigint;
  pricingMode: PriceType; wholesaleConfirmedAt: Date | null; paymentStartedAt: Date | null;
};
type LockedHold = { id: string; variantId: string; branchId: string; quantity: bigint; expiresAt: Date };
type LockedInventory = { id: string; variantId: string; physical: bigint; reserved: bigint };
type ItemSnapshot = {
  variantId: string; productId: string; productName: string; variantName: string; sku: string;
  quantity: bigint; unitPrice: bigint; subtotal: bigint;
};

const conflict = (code: string, message: string, details?: unknown) => new AppError(409, code, message, details);
const invalidReservation = () =>
  conflict('INVALID_RESERVATION', 'Las reservas de la venta no respaldan exactamente sus artículos.');

function transient(error: unknown) {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034' || candidate.meta?.code === '40001'
    || candidate.meta?.code === '40P01' || message.includes('40001')
    || message.includes('40P01') || message.includes('TransactionWriteConflict');
}

function variantName(variant: { color: string | null; size: string | null }) {
  return [variant.color, variant.size].filter(Boolean).join(' / ') || 'Única';
}

function snapshotOf(item: ItemSnapshot) {
  return {
    variantId: item.variantId, sku: item.sku, productName: item.productName, variantName: item.variantName,
    quantity: item.quantity, unitPrice: item.unitPrice, subtotal: item.subtotal,
  };
}

// Pilot P0.2-A: cashier correction of a PENDING_PAYMENT sale before its
// first payment. One Serializable transaction, lock order Sale ->
// StockReservation (ACTIVE, id ASC) -> Inventory (id ASC) — the same prefix
// as payment, completion, cancellation and the B1 expiry release, so every
// lifecycle path serializes on the Sale row first. Everything that decides
// eligibility (status, payment rows, coverage, expiry) is read under that
// lock.
//
// Reservation-only: Inventory.reserved moves by the exact per-variant delta,
// physical stock never changes and no StockMovement is written. The original
// expiresAt is preserved on every resulting hold, so a correction can never
// give the customer a fresh TTL window.
export function createPendingCorrectionService(database: PrismaClient) {
  async function inTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await database.$transaction(operation, { isolationLevel: 'Serializable', timeout: 30000 });
      } catch (error) {
        if (!transient(error)) throw error;
      }
    }
    throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
  }

  async function correctPendingSale(req: RequestLike, saleId: string, input: CorrectPendingSaleInput) {
    return inTransaction(async (tx) => {
      const [sale] = await tx.$queryRaw<LockedSale[]>`
        SELECT id, "branchId", status, total, "pricingMode", "wholesaleConfirmedAt", "paymentStartedAt"
        FROM "Sale" WHERE id = ${saleId} FOR UPDATE
      `;
      if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
      // Live authority, paired with the sale's own persisted location.
      assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CORRECT_PENDING, sale.branchId);
      if (sale.status !== 'PENDING_PAYMENT') {
        throw conflict('INVALID_SALE_STATE', 'Solo se puede corregir una venta pendiente de pago.');
      }
      // Payment-row existence, never the payment sum (Policy A). Block 1: the
      // durable paymentStartedAt fact also counts, so deleting or moving the
      // payment rows can never reopen a sale that already accepted money.
      if (sale.paymentStartedAt !== null || await tx.salePayment.count({ where: { saleId } }) > 0) {
        throw conflict('PAYMENT_ALREADY_ACCEPTED', 'La venta tiene pagos registrados: no puede corregirse.');
      }

      const items = await tx.saleItem.findMany({ where: { saleId }, orderBy: { id: 'asc' } });
      const activeHolds = await tx.$queryRaw<LockedHold[]>`
        SELECT id, "variantId", "branchId", quantity, "expiresAt"
        FROM "StockReservation"
        WHERE "saleId" = ${saleId} AND status = 'ACTIVE'
        ORDER BY id ASC
        FOR UPDATE
      `;
      // Zero payments: the first-payment rule applies — every current hold
      // must be exact and unexpired. An expired or already released hold is
      // not refreshed by a correction; the sale must be cancelled instead.
      const now = new Date();
      const coverage = evaluateCurrentHoldCoverage({
        branchId: sale.branchId, items, activeHolds, policy: { kind: 'FIRST_PAYMENT', now },
      });
      if (!coverage.ok) {
        if (coverage.reason === 'EXPIRED' || coverage.reason === 'NO_ACTIVE_HOLDS') {
          throw conflict('RESERVATION_EXPIRED', 'La reserva de la venta venció: no puede corregirse.');
        }
        throw invalidReservation();
      }
      const current = coverage.requirements;
      // The corrected holds keep the ORIGINAL expiry boundary (the earliest
      // one if rows ever differed): never extended.
      const expiresAt = new Date(Math.min(...activeHolds.map((hold) => hold.expiresAt.getTime())));

      const target = new Map(input.items.map((item) => [item.variantId, item.quantity]));
      const changedVariants = [...new Set([...current.keys(), ...target.keys()])]
        .filter((variantId) => (current.get(variantId) ?? 0n) !== (target.get(variantId) ?? 0n))
        .sort();
      if (changedVariants.length === 0) throw conflict('NO_CHANGES', 'La corrección no modifica la venta.');
      // One SaleItem per variant (addItem aggregates). A legacy duplicate
      // line for a changed variant has no unambiguous price: fail closed.
      for (const variantId of changedVariants) {
        if (items.filter((item) => item.variantId === variantId).length > 1) {
          throw conflict('CORRECTION_NOT_SUPPORTED', 'La venta tiene artículos duplicados para la variante.', { variantId });
        }
      }

      const newVariantIds = changedVariants.filter((variantId) => !current.has(variantId));
      const newVariants = newVariantIds.length === 0 ? [] : await tx.productVariant.findMany({
        where: { id: { in: newVariantIds }, isActive: true, product: { isActive: true } },
        select: {
          id: true, productId: true, sku: true, price: true, wholesalePrice: true, color: true, size: true,
          product: { select: { name: true } },
        },
      });
      if (newVariants.length !== newVariantIds.length) throw new AppError(404, 'NOT_FOUND', 'No se encontró la variante activa.');
      // Block 1: a new line takes the catalog price of the sale's own mode,
      // resolved before any write (a WHOLESALE sale cannot gain a line that
      // has no wholesale price). Existing lines keep their snapshot.
      const newUnitPrices = new Map(newVariants.map((variant) => [variant.id, unitPriceFor(sale.pricingMode, variant)]));

      const inventories = await tx.$queryRaw<LockedInventory[]>`
        SELECT id, "variantId", physical, reserved
        FROM "Inventory"
        WHERE "branchId" = ${sale.branchId} AND "variantId" IN (${Prisma.join(changedVariants)})
        ORDER BY id ASC
        FOR UPDATE
      `;
      const inventoryByVariant = new Map(inventories.map((inventory) => [inventory.variantId, inventory]));
      const deltas = changedVariants.map((variantId) => ({
        variantId, before: current.get(variantId) ?? 0n, after: target.get(variantId) ?? 0n,
      }));
      for (const { variantId, before, after } of deltas) {
        const inventory = inventoryByVariant.get(variantId);
        const delta = after - before;
        if (delta > 0n) {
          // Same authoritative rule as send-to-cashier, on locked rows.
          if (!inventory || inventory.physical - inventory.reserved < delta) {
            throw conflict('INSUFFICIENT_STOCK', 'No hay stock disponible suficiente para la variante.', { variantId });
          }
        } else if (!inventory || inventory.reserved < -delta) {
          throw invalidReservation();
        }
      }

      const beforeItems = items.map(snapshotOf);
      for (const { variantId, before, after } of deltas) {
        await tx.inventory.update({
          where: { id: inventoryByVariant.get(variantId)!.id },
          data: { reserved: { increment: after - before } },
        });
        // Superseded holds become historical RELEASED rows; one ACTIVE row
        // carries the corrected quantity on the original expiry.
        const superseded = activeHolds.filter((hold) => hold.variantId === variantId).map(({ id }) => id);
        if (superseded.length > 0) {
          const released = await tx.stockReservation.updateMany({
            where: { id: { in: superseded }, status: 'ACTIVE' }, data: { status: 'RELEASED' },
          });
          if (released.count !== superseded.length) throw invalidReservation();
        }
        if (after > 0n) {
          await tx.stockReservation.create({
            data: { saleId, variantId, branchId: sale.branchId, quantity: after, status: 'ACTIVE', expiresAt },
          });
        }

        const item = items.find((line) => line.variantId === variantId);
        if (item && after === 0n) {
          await tx.saleItem.delete({ where: { id: item.id } });
        } else if (item) {
          await tx.saleItem.update({ where: { id: item.id }, data: { quantity: after, subtotal: after * item.unitPrice } });
        } else {
          const variant = newVariants.find(({ id }) => id === variantId)!;
          const unitPrice = newUnitPrices.get(variantId)!;
          await tx.saleItem.create({
            data: {
              saleId, variantId, productId: variant.productId, productName: variant.product.name,
              variantName: variantName(variant), sku: variant.sku,
              quantity: after, unitPrice, subtotal: after * unitPrice,
            },
          });
        }
      }

      const resultItems = await tx.saleItem.findMany({ where: { saleId }, orderBy: { id: 'asc' } });
      const resultHolds = await tx.stockReservation.findMany({
        where: { saleId, status: 'ACTIVE' },
        select: { variantId: true, branchId: true, quantity: true, expiresAt: true },
      });
      // Post-condition under the same locks: ACTIVE coverage == items.
      const verified = evaluateCurrentHoldCoverage({
        branchId: sale.branchId, items: resultItems, activeHolds: resultHolds, policy: { kind: 'FIRST_PAYMENT', now },
      });
      if (!verified.ok) throw invalidReservation();

      const subtotal = resultItems.reduce((sum, item) => sum + item.subtotal, 0n);
      // Block 1: a cashier confirmation covers the exact content confirmed.
      // A corrected WHOLESALE sale must be confirmed again before payment.
      const clearsConfirmation = sale.pricingMode === 'WHOLESALE' && sale.wholesaleConfirmedAt !== null;
      await tx.sale.update({
        where: { id: saleId },
        data: {
          subtotal, discountTotal: 0n, total: subtotal,
          ...(clearsConfirmation ? { wholesaleConfirmedAt: null, wholesaleConfirmedById: null } : {}),
        },
      });
      const afterItems = resultItems.map(snapshotOf);
      await createAuditLog(tx, {
        userId: req.auth!.userId, branchId: sale.branchId, action: 'SALE_CORRECTED', entityType: 'Sale', entityId: saleId,
        before: { status: sale.status, total: sale.total, items: beforeItems },
        after: {
          status: sale.status, total: subtotal, items: afterItems, reservationChanges: deltas, expiresAt,
          ...(clearsConfirmation ? { wholesaleConfirmationCleared: true } : {}),
        },
      });
      return {
        saleId, branchId: sale.branchId, status: sale.status, subtotal, total: subtotal, items: afterItems,
        // Signed per-variant change of Inventory.reserved, for the advisory
        // inventory.updated notification.
        quantities: deltas.map(({ variantId, before, after }) => ({ variantId, quantity: after - before })),
      };
    });
  }

  return { correctPendingSale };
}
