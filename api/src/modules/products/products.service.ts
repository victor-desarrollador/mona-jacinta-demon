import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { assertPermissionAtLocation } from '../../middleware/authorization.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import type { Request } from 'express';
import type { ProductQuery } from './dto/product.dto.js';
import type { VariantQuery } from './dto/variant.dto.js';
import {
  effectiveAvailability,
  loadReleasableExpiredHolds,
} from '../sales/reservation-holds.js';

type ProductDatabase = Pick<PrismaClient, 'product' | 'productVariant' | 'stockReservation'>;
type InventoryRow = { id: string; branchId: string; physical: bigint; reserved: bigint };

const publicVariantSelect = {
  id: true,
  productId: true,
  sku: true,
  barcode: true,
  color: true,
  size: true,
  price: true,
  isActive: true,
} as const;

function inventorySelect(branchIds: string[], branchId?: string) {
  return {
    where: { branchId: branchId ? branchId : { in: branchIds } },
    select: { id: true, branchId: true, physical: true, reserved: true },
  } as const;
}

// Pilot P0.1-A: `available` is expiry-aware; `reserved` stays the raw
// persisted counter. One grouped hold aggregate per call, bounded to the
// inventory rows already filtered to the caller's authorized branches.
async function withEffectiveInventory<V extends { id: string; inventory: InventoryRow[] }>(
  database: ProductDatabase,
  variants: V[],
) {
  const releasable = await loadReleasableExpiredHolds(
    database,
    variants.flatMap((variant) =>
      variant.inventory.map(({ branchId }) => ({ branchId, variantId: variant.id })),
    ),
    new Date(),
  );
  return variants.map((variant) => ({
    ...variant,
    inventory: variant.inventory.map((row) => ({
      ...row,
      physical: row.physical.toString(),
      reserved: row.reserved.toString(),
      available: effectiveAvailability(
        row.physical,
        row.reserved,
        releasable(row.branchId, variant.id),
      ).effectiveAvailable.toString(),
    })),
  }));
}

function productSearch(search?: string) {
  if (!search) return undefined;
  return [
    { name: { contains: search, mode: 'insensitive' as const } },
    { variants: { some: { sku: { contains: search, mode: 'insensitive' as const } } } },
    { variants: { some: { barcode: { contains: search, mode: 'insensitive' as const } } } },
  ];
}

export async function listProducts(database: ProductDatabase, query: ProductQuery) {
  const where = { isActive: query.isActive, OR: productSearch(query.search) };
  const [items, total] = await Promise.all([
    database.product.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        category: { select: { id: true, name: true } },
        brand: { select: { id: true, name: true } },
        variants: { where: { isActive: query.isActive }, select: publicVariantSelect },
      },
    }),
    database.product.count({ where }),
  ]);
  return { items, pagination: { page: query.page, limit: query.limit, total } };
}

export async function getProduct(
  database: ProductDatabase,
  id: string,
  branchIds: string[],
) {
  const product = await database.product.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      isActive: true,
      category: { select: { id: true, name: true } },
      brand: { select: { id: true, name: true } },
      variants: {
        where: { isActive: true },
        select: {
          ...publicVariantSelect,
          inventory: inventorySelect(branchIds),
        },
      },
    },
  });
  if (!product) throw new AppError(404, 'NOT_FOUND', 'No se encontró el producto.');
  return {
    ...product,
    variants: await withEffectiveInventory(database, product.variants),
  };
}

export async function listVariants(
  database: ProductDatabase,
  req: Request,
  query: VariantQuery,
) {
  const branchId = query.branchId;
  if (branchId) assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.INVENTORY_VIEW, branchId);
  const branchIds = req.auth?.effectiveLocationIds ?? [];
  const where = {
    isActive: query.isActive,
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.search
      ? {
          OR: [
            { sku: { contains: query.search, mode: 'insensitive' as const } },
            { barcode: { contains: query.search, mode: 'insensitive' as const } },
            { color: { contains: query.search, mode: 'insensitive' as const } },
            { size: { contains: query.search, mode: 'insensitive' as const } },
            { product: { name: { contains: query.search, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };
  const [items, total] = await Promise.all([
    database.productVariant.findMany({
      where,
      orderBy: [{ product: { name: 'asc' } }, { sku: 'asc' }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      select: {
        ...publicVariantSelect,
        product: { select: { id: true, name: true, slug: true } },
        inventory: inventorySelect(branchIds, branchId),
      },
    }),
    database.productVariant.count({ where }),
  ]);
  return {
    items: await withEffectiveInventory(database, items),
    pagination: { page: query.page, limit: query.limit, total },
  };
}

export async function getVariant(
  database: ProductDatabase,
  id: string,
  branchIds: string[],
) {
  const variant = await database.productVariant.findUnique({
    where: { id },
    select: {
      ...publicVariantSelect,
      product: {
        select: {
          id: true,
          name: true,
          slug: true,
          category: { select: { id: true, name: true } },
          brand: { select: { id: true, name: true } },
        },
      },
      inventory: inventorySelect(branchIds),
    },
  });
  if (!variant) throw new AppError(404, 'NOT_FOUND', 'No se encontró la variante.');
  const [withAvailability] = await withEffectiveInventory(database, [variant]);
  return withAvailability!;
}