import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';

// WAREHOUSE-MVP: paginated, searchable stock list for ONE branch (the warehouse
// screen). Every ACTIVE variant is listed, including those without an Inventory
// row (0/0/0). available = physical - reserved: the persisted counters, i.e. the
// same quantities the manual adjustment guards (physical >= reserved >= 0).
// Authorization (INVENTORY_MANAGE at branchId) is enforced by inventory.routes.ts
// BEFORE this runs (authorization says yes for any id, even a nonexistent one, so
// existence is decided here and only for an authorized caller): branchId must be
// an existing ACTIVE location, else 404 — never a silent 0/0/0 catalog.

const positiveInt = (max: number) =>
  z.string().regex(/^[0-9]{1,9}$/).transform(Number).refine((value) => value >= 1 && value <= max);

export const DEFAULT_STOCK_LIMIT = 50;
export const MAX_STOCK_LIMIT = 100;

export const stockListQuerySchema = z
  .object({
    branchId: z.uuid(),
    search: z.string().trim().max(100).optional(),
    page: positiveInt(1_000_000).default(1),
    limit: positiveInt(MAX_STOCK_LIMIT).default(DEFAULT_STOCK_LIMIT),
  })
  .strict();

export type StockListQuery = z.infer<typeof stockListQuerySchema>;

type StockListDatabase = Pick<PrismaClient, 'productVariant' | 'branch' | 'location'>;

export function createStockListService(database: StockListDatabase) {
  async function listStock({ branchId, search, page, limit }: StockListQuery) {
    const [branch, location] = await Promise.all([
      database.branch.findUnique({ where: { id: branchId }, select: { id: true } }),
      // Location.id == Branch.id (Phase 1A mapping).
      database.location.findUnique({ where: { id: branchId }, select: { isActive: true } }),
    ]);
    if (!branch || !location?.isActive) throw new AppError(404, 'NOT_FOUND', 'No se encontró la sucursal.');
    const term = search ?? '';
    const contains = { contains: term, mode: 'insensitive' as const };
    const where = {
      isActive: true,
      ...(term.length === 0
        ? {}
        : {
            OR: [
              { product: { name: contains } },
              { sku: contains },
              { barcode: contains },
              { color: contains },
              { size: contains },
            ],
          }),
    };
    const [rows, total] = await Promise.all([
      database.productVariant.findMany({
        where,
        orderBy: [{ product: { name: 'asc' } }, { sku: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          sku: true,
          barcode: true,
          color: true,
          size: true,
          product: { select: { id: true, name: true } },
          inventory: { where: { branchId }, select: { physical: true, reserved: true } },
        },
      }),
      database.productVariant.count({ where }),
    ]);
    return {
      items: rows.map((row) => {
        const physical = row.inventory[0]?.physical ?? 0n;
        const reserved = row.inventory[0]?.reserved ?? 0n;
        return {
          variantId: row.id,
          productId: row.product.id,
          productName: row.product.name,
          sku: row.sku,
          barcode: row.barcode,
          color: row.color,
          size: row.size,
          physical,
          reserved,
          available: physical - reserved,
        };
      }),
      pagination: { page, limit, total },
    };
  }
  return { listStock };
}
