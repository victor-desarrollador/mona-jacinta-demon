import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { assertBranchAccess } from '../../middleware/authorization.js';
import type { Request } from 'express';
import type { ProductQuery } from './dto/product.dto.js';
import type { VariantQuery } from './dto/variant.dto.js';

type ProductDatabase = Pick<PrismaClient, 'product' | 'productVariant'>;

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

function inventoryWithAvailable<T extends { physical: bigint; reserved: bigint }>(
  inventory: T[],
) {
  return inventory.map((row) => ({
    ...row,
    physical: row.physical.toString(),
    reserved: row.reserved.toString(),
    available: (row.physical - row.reserved).toString(),
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
    variants: product.variants.map((variant) => ({
      ...variant,
      inventory: inventoryWithAvailable(variant.inventory),
    })),
  };
}

export async function listVariants(
  database: ProductDatabase,
  req: Request,
  query: VariantQuery,
) {
  const branchId = query.branchId;
  if (branchId) assertBranchAccess(req, branchId);
  const branchIds = req.auth?.branchIds ?? [];
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
    items: items.map((variant) => ({
      ...variant,
      inventory: inventoryWithAvailable(variant.inventory),
    })),
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
  return { ...variant, inventory: inventoryWithAvailable(variant.inventory) };
}