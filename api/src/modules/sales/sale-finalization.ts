// R3-A3.1 (R3 rev. 2 §9): the PAID -> COMPLETED finalization of a sale, moved
// verbatim out of sales.service.ts so the future proportional checkout can run
// it inside the SAME Serializable transaction it already holds, instead of
// opening a second one.
//
// Transaction ownership: this module never opens a transaction, never retries
// and never emits Socket.IO events. The caller owns the transaction and its
// outcome; realtime notification happens after commit, outside this file (see
// the `complete` handler in sales.controller.ts). completeSale() in
// sales.service.ts keeps the historical Serializable + 3-retry wrapper for
// POST /sales/:saleId/complete.
//
// saleInclude and the shared error helpers (notFound, completionConflict) moved
// with the finalizer because sales.service.ts imports them back: there is
// exactly one definition of each, never a duplicate.
import { Prisma, type PriceType } from '../../generated/prisma/client.js';
import { assertPermissionAtLocation } from '../../middleware/authorization.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { evaluateCurrentHoldCoverage, type HoldCoverageFailure } from './hold-coverage.js';
import { assertPricingFinalizable } from './wholesale-authorization.service.js';
import { type PriceMode } from '../pricing/pricing.js';

export const saleInclude = {
  items: {
    orderBy: { id: 'asc' as const },
    include: {
      variant: {
        select: {
          id: true, sku: true, barcode: true, color: true, size: true,
          price: true, cashPrice: true, isActive: true,
          product: { select: { id: true, name: true, slug: true, isActive: true } },
        },
      },
    },
  },
  branch: { select: { id: true, name: true, code: true } },
  seller: { select: { id: true, name: true, email: true } },
} satisfies Prisma.SaleInclude;

export function notFound(message: string) {
  return new AppError(404, 'NOT_FOUND', message);
}

export function completionConflict(code: string, message: string, details?: unknown) {
  return new AppError(409, code, message, details);
}

// Pilot P0.1-C: completion keeps its pre-existing stable codes/messages for
// each current-coverage defect.
function completionCoverageError(reason: HoldCoverageFailure, variantId?: string) {
  if (reason === 'INVALID_ITEM_QUANTITY') return completionConflict('INVALID_SALE_QUANTITY', 'La venta contiene una cantidad inválida.');
  if (reason === 'NO_ITEMS') return completionConflict('INVALID_RESERVATION', 'La venta no tiene cantidades para finalizar.');
  if (reason === 'INVALID_HOLD') return completionConflict('INVALID_RESERVATION', 'La reserva de la venta no es válida para finalizarse.');
  return completionConflict('INVALID_RESERVATION', 'Las reservas no respaldan exactamente los artículos de la venta.', variantId ? { variantId } : undefined);
}

// The caller owns the transaction: call this with the `tx` the caller is
// already inside. POST /complete wraps it (completeSale); the proportional
// checkout will pass its own transaction. It performs the PAID -> COMPLETED
// transition exactly once — state/permission validation, hold matching,
// inventory deduction, reservation consumption, audit and status change — and
// returns the finalized sale.
export async function finalizePaidSaleInTransaction(
  tx: Prisma.TransactionClient,
  req: Parameters<typeof assertPermissionAtLocation>[0],
  userId: string,
  saleId: string,
) {
  const [sale] = await tx.$queryRaw<Array<{
    id: string;
    branchId: string;
    status: string;
    total: bigint;
    pricingMode: PriceType;
    priceMode: PriceMode;
    wholesaleConfirmedAt: Date | null;
    wholesaleConfirmedById: string | null;
  }>>`
    SELECT id, "branchId", status, total, "pricingMode", "priceMode", "wholesaleConfirmedAt", "wholesaleConfirmedById"
    FROM "Sale"
    WHERE id = ${saleId}
    FOR UPDATE
  `;
  if (!sale) throw notFound('No se encontró la venta.');

  // Phase 1D.3.1 SWITCH: the real decision is the Production SALE_COMPLETE
  // grant paired with this sale's own location (req.auth.assignments), not
  // a bare effectiveLocationIds membership check.
  if (!req.auth || !hasPermissionAtLocation(req.auth, PRODUCTION_PERMISSIONS.SALE_COMPLETE, sale.branchId)) {
    throw new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
  }

  if (sale.status === 'COMPLETED') return tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: saleInclude });
  if (sale.status !== 'PAID') throw completionConflict('INVALID_SALE_STATE', 'La venta no está lista para finalizarse.');

  // Block 1: defense in depth (payment already requires it; the DB CHECK
  // chk_sale_wholesale_confirmed_when_paid is the last guard).
  assertPricingFinalizable(sale);
  const items = await tx.saleItem.findMany({ where: { saleId }, select: { variantId: true, quantity: true } });

  // Pilot P0.1-C: only CURRENT ACTIVE holds back a completion. Historical
  // RELEASED/CONSUMED rows are neither locked, matched nor re-consumed.
  // A PAID sale is completable after its original expiresAt (the sweeper
  // never touches PAID). Lock order stays Sale -> StockReservation(id
  // ASC) -> Inventory(id ASC), the same prefix as B1 release and cancel.
  const activeHolds = await tx.$queryRaw<Array<{
    id: string;
    variantId: string;
    branchId: string;
    quantity: bigint;
    expiresAt: Date;
  }>>`
    SELECT id, "variantId", "branchId", quantity, "expiresAt"
    FROM "StockReservation"
    WHERE "saleId" = ${saleId} AND status = 'ACTIVE'
    ORDER BY id ASC
    FOR UPDATE
  `;
  const coverage = evaluateCurrentHoldCoverage({
    branchId: sale.branchId, items, activeHolds, policy: { kind: 'PAID_COMPLETION' },
  });
  if (!coverage.ok) throw completionCoverageError(coverage.reason, coverage.variantId);
  const { requirements } = coverage;

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

  const consumed = await tx.stockReservation.updateMany({
    where: { id: { in: activeHolds.map(({ id }) => id) }, status: 'ACTIVE' },
    data: { status: 'CONSUMED' },
  });
  if (consumed.count !== activeHolds.length) {
    throw completionConflict('INVALID_RESERVATION', 'La reserva de la venta no es válida para finalizarse.');
  }
  await createAuditLog(tx, {
    userId,
    branchId: sale.branchId,
    action: 'SALE_COMPLETED',
    entityType: 'Sale',
    entityId: saleId,
    before: { status: 'PAID' },
    after: { status: 'COMPLETED', inventory: finalizedInventory },
  });
  await tx.sale.update({ where: { id: saleId }, data: { status: 'COMPLETED' } });
  return tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: saleInclude });
}
