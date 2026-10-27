import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';

// D3 (Demo Operativa V1): additive initial stock load
// (docs/production-v1/07-inventory-ledger.md §4: INITIAL_STOCK, ON_HAND,
// +qty). physical = previous physical + quantity — never "set". reserved is
// never changed (a newly created Inventory row starts at 0/0). Exactly one
// positive INITIAL_STOCK StockMovement and one audit row (real target
// branch) commit atomically with the balance change.
//
// Authorization (IMPORT_RUN, location-paired with the validated body
// branchId) is enforced by inventory.routes.ts before this runs.

export const initialStockSchema = z
  .object({
    variantId: z.uuid(),
    branchId: z.uuid(),
    // Positive integer quantity as a JSON string — BigInt-safe, no decimals.
    quantity: z.string().regex(/^[1-9][0-9]{0,17}$/).transform((value) => BigInt(value)),
  })
  .strict();

export type InitialStockInput = z.infer<typeof initialStockSchema>;

type InitialStockDatabase = Pick<PrismaClient, '$transaction'>;
type LockedInventory = { id: string; physical: bigint; reserved: bigint };

// Same transient classification as reservation.service.ts, plus P2002: two
// concurrent first loads of the same (variant, branch) can both try to
// create its Inventory row; the loser's transaction is aborted and retried,
// then finds the row and increments it under the row lock.
function isRetryable(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; meta?: { code?: unknown } };
  const message = error instanceof Error ? error.message : String(error);
  return candidate.code === 'P2002'
    || candidate.code === 'P2034'
    || candidate.meta?.code === '40P01'
    || message.includes('40001')
    || message.includes('TransactionWriteConflict');
}

export function createInitialStockService(database: InitialStockDatabase) {
  async function loadInTransaction(userId: string, input: InitialStockInput) {
    return database.$transaction(async (tx) => {
      const [variant, branch, location] = await Promise.all([
        tx.productVariant.findUnique({ where: { id: input.variantId }, select: { id: true } }),
        tx.branch.findUnique({ where: { id: input.branchId }, select: { id: true } }),
        // Location.id == Branch.id (Phase 1A mapping).
        tx.location.findUnique({ where: { id: input.branchId }, select: { isActive: true } }),
      ]);
      if (!variant) throw new AppError(404, 'NOT_FOUND', 'No se encontró la variante.');
      if (!branch || !location?.isActive) throw new AppError(404, 'NOT_FOUND', 'No se encontró la sucursal.');

      await tx.inventory.upsert({
        where: { variantId_branchId: { variantId: input.variantId, branchId: input.branchId } },
        create: { variantId: input.variantId, branchId: input.branchId, physical: 0n, reserved: 0n },
        update: {},
      });
      const [before] = await tx.$queryRaw<LockedInventory[]>`
        SELECT id, physical, reserved FROM "Inventory"
        WHERE "variantId" = ${input.variantId} AND "branchId" = ${input.branchId}
        FOR UPDATE
      `;
      if (!before) throw new AppError(404, 'INVENTORY_NOT_FOUND', 'No se encontró el inventario de la variante.');

      const inventory = await tx.inventory.update({
        where: { id: before.id },
        data: { physical: { increment: input.quantity } },
        select: { id: true, variantId: true, branchId: true, physical: true, reserved: true },
      });
      const movement = await tx.stockMovement.create({
        data: {
          inventoryId: inventory.id,
          type: 'INITIAL_STOCK',
          quantityDelta: input.quantity,
          saleId: null,
          userId,
          branchId: input.branchId,
        },
        select: { id: true, type: true, quantityDelta: true },
      });
      await createAuditLog(tx, {
        userId,
        branchId: input.branchId,
        action: 'INVENTORY_INITIAL_STOCK_LOADED',
        entityType: 'Inventory',
        entityId: inventory.id,
        before: { physical: before.physical, reserved: before.reserved },
        after: {
          physical: inventory.physical,
          reserved: inventory.reserved,
          quantity: input.quantity,
          variantId: input.variantId,
        },
      });
      return { inventory, movement };
    });
  }

  async function loadInitialStock(userId: string, input: InitialStockInput) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await loadInTransaction(userId, input);
      } catch (error) {
        if (!isRetryable(error)) throw error;
        if (attempt === 3) throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
      }
    }
    throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
  }

  return { loadInitialStock };
}
