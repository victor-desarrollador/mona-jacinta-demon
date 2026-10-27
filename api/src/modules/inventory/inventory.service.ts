import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import {
  effectiveAvailability,
  loadReleasableExpiredHolds,
} from '../sales/reservation-holds.js';

type InventoryDatabase = Pick<PrismaClient, 'inventory' | 'stockReservation'>;
type InventoryServiceOptions = { now?: () => Date };
const branchSchema = z.uuid();
const variantIdsSchema = z.array(z.uuid());
const itemsSchema = z.array(
  z.object({
    variantId: z.uuid(),
    quantity: z.bigint().positive(),
  }),
);

// Internal callers must establish branch authorization before using this service.
// Keep BigInts inside the service; sendJson handles the HTTP boundary.
export function createInventoryService(
  database: InventoryDatabase,
  { now: clock = () => new Date() }: InventoryServiceOptions = {},
) {
  // One captured instant and one grouped hold aggregate per operation,
  // bounded to the already-authorized branch and the rows actually read.
  async function withAvailability<T extends { variantId: string; physical: bigint; reserved: bigint }>(
    branchId: string,
    rows: T[],
  ) {
    const releasable = await loadReleasableExpiredHolds(
      database,
      rows.map(({ variantId }) => ({ branchId, variantId })),
      clock(),
    );
    return rows.map((row) => ({
      ...row,
      available: effectiveAvailability(row.physical, row.reserved, releasable(branchId, row.variantId)).effectiveAvailable,
    }));
  }

  async function getAvailability(branchId: string, variantIds?: string[]) {
    branchSchema.parse(branchId);
    if (variantIds !== undefined) variantIdsSchema.parse(variantIds);
    const rows = await database.inventory.findMany({
      where: {
        branchId,
        ...(variantIds === undefined ? {} : { variantId: { in: variantIds } }),
      },
      orderBy: { variantId: 'asc' },
      select: { variantId: true, physical: true, reserved: true },
    });
    return withAvailability(branchId, rows);
  }

  async function getInventoryByBranch(branchId: string) {
    branchSchema.parse(branchId);
    const rows = await database.inventory.findMany({
      where: { branchId },
      orderBy: [
        { variant: { product: { name: 'asc' } } },
        { variant: { sku: 'asc' } },
      ],
      select: {
        id: true,
        branchId: true,
        variantId: true,
        physical: true,
        reserved: true,
        variant: {
          select: {
            id: true,
            sku: true,
            barcode: true,
            color: true,
            size: true,
            price: true,
            isActive: true,
            product: {
              select: { id: true, name: true, slug: true, isActive: true },
            },
          },
        },
      },
    });
    return withAvailability(branchId, rows);
  }

  // Read-only pre-check, NOT a reservation or concurrency guarantee.
  // Task 12 must revalidate stock inside the reservation transaction under locks.
  // Expiry-aware availability here is optimistic; the send-to-cashier
  // transaction still validates the persisted counter authoritatively.
  async function checkAvailability(
    branchId: string,
    items: Array<{ variantId: string; quantity: bigint }>,
  ): Promise<void> {
    const parsed = itemsSchema.safeParse(items);
    if (!parsed.success) {
      throw new AppError(
        400,
        'VALIDATION_ERROR',
        'Las variantes y cantidades deben ser válidas y positivas.',
      );
    }
    const quantities = new Map<string, bigint>();
    for (const item of parsed.data) {
      quantities.set(
        item.variantId,
        (quantities.get(item.variantId) ?? 0n) + item.quantity,
      );
    }
    const rows = await getAvailability(branchId, [...quantities.keys()]);
    const available = new Map(
      rows.map((row) => [row.variantId, row.available]),
    );
    for (const [variantId, quantity] of quantities) {
      const stock = available.get(variantId);
      if (stock === undefined || stock < quantity) {
        throw new AppError(
          409,
          'INSUFFICIENT_STOCK',
          'No hay stock disponible suficiente para la variante.',
          { variantId },
        );
      }
    }
  }

  return { getInventoryByBranch, getAvailability, checkAvailability };
}
