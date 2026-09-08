import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';

type InventoryDatabase = Pick<PrismaClient, 'inventory'>;
const branchSchema = z.uuid();
const variantIdsSchema = z.array(z.uuid());
const itemsSchema = z.array(
  z.object({
    variantId: z.uuid(),
    quantity: z.bigint().positive(),
  }),
);

function withAvailability<T extends { physical: bigint; reserved: bigint }>(
  row: T,
) {
  return { ...row, available: row.physical - row.reserved };
}

// Internal callers must establish branch authorization before using this service.
// Keep BigInts inside the service; sendJson handles the HTTP boundary.
export function createInventoryService(database: InventoryDatabase) {
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
    return rows.map(withAvailability);
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
    return rows.map(withAvailability);
  }

  // Read-only pre-check, NOT a reservation or concurrency guarantee.
  // Task 12 must revalidate stock inside the reservation transaction under locks.
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
