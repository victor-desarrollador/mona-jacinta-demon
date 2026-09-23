import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import type { CreateProductInput } from './dto/product.dto.js';
import type { CreateVariantInput, UpdateVariantPriceInput } from './dto/variant.dto.js';

// D3 (Demo Operativa V1): admin catalogue writes. Authorization is enforced
// before these run (products.routes.ts: requirePermission with the
// COMPANY-required PRODUCT_MANAGE / PRODUCT_VARIANT_MANAGE / PRICE_MANAGE).
// Products, variants and prices are global, so every audit row records
// branchId null — never an arbitrary Location. Each write and its audit
// commit atomically. Uniqueness is pre-checked for a specific 409; a
// concurrent duplicate that slips past the pre-check still fails on the
// database unique index and maps to 409 via errorHandler (P2002).

type CatalogDatabase = Pick<PrismaClient, 'category' | 'brand' | '$transaction'>;

const productSelect = {
  id: true, name: true, slug: true, categoryId: true, brandId: true, isActive: true,
} as const;

const variantSelect = {
  id: true, productId: true, sku: true, barcode: true, color: true, size: true,
  price: true, costPrice: true, isActive: true,
} as const;

function conflict(code: string, message: string) {
  return new AppError(409, code, message);
}

export function createCatalogAdminService(database: CatalogDatabase) {
  async function listCategories() {
    return database.category.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
  }

  async function listBrands() {
    return database.brand.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true } });
  }

  async function createProduct(userId: string, input: CreateProductInput) {
    return database.$transaction(async (tx) => {
      const [category, brand, existing] = await Promise.all([
        tx.category.findUnique({ where: { id: input.categoryId }, select: { id: true } }),
        tx.brand.findUnique({ where: { id: input.brandId }, select: { id: true } }),
        tx.product.findUnique({ where: { slug: input.slug }, select: { id: true } }),
      ]);
      if (!category) throw new AppError(404, 'NOT_FOUND', 'No se encontró la categoría.');
      if (!brand) throw new AppError(404, 'NOT_FOUND', 'No se encontró la marca.');
      if (existing) throw conflict('PRODUCT_SLUG_TAKEN', 'Ya existe un producto con ese identificador.');
      const product = await tx.product.create({ data: input, select: productSelect });
      await createAuditLog(tx, {
        userId, branchId: null, action: 'PRODUCT_CREATED', entityType: 'Product', entityId: product.id,
        after: product,
      });
      return product;
    });
  }

  async function createVariant(userId: string, input: CreateVariantInput) {
    return database.$transaction(async (tx) => {
      const [product, sameSku, sameBarcode] = await Promise.all([
        tx.product.findUnique({ where: { id: input.productId }, select: { id: true } }),
        tx.productVariant.findUnique({ where: { sku: input.sku }, select: { id: true } }),
        tx.productVariant.findUnique({ where: { barcode: input.barcode }, select: { id: true } }),
      ]);
      if (!product) throw new AppError(404, 'NOT_FOUND', 'No se encontró el producto.');
      if (sameSku) throw conflict('VARIANT_SKU_TAKEN', 'Ya existe una variante con ese SKU.');
      if (sameBarcode) throw conflict('VARIANT_BARCODE_TAKEN', 'Ya existe una variante con ese código de barras.');
      const variant = await tx.productVariant.create({ data: input, select: variantSelect });
      await createAuditLog(tx, {
        userId, branchId: null, action: 'PRODUCT_VARIANT_CREATED', entityType: 'ProductVariant', entityId: variant.id,
        after: variant,
      });
      return variant;
    });
  }

  async function updateVariantPrice(userId: string, variantId: string, input: UpdateVariantPriceInput) {
    return database.$transaction(async (tx) => {
      // Row lock so the audited `before` is exactly the price this update
      // replaced, even under concurrent price changes.
      const [current] = await tx.$queryRaw<Array<{ price: bigint }>>`
        SELECT price FROM "ProductVariant" WHERE id = ${variantId} FOR UPDATE
      `;
      if (!current) throw new AppError(404, 'NOT_FOUND', 'No se encontró la variante.');
      const variant = await tx.productVariant.update({
        where: { id: variantId }, data: { price: input.price }, select: variantSelect,
      });
      await createAuditLog(tx, {
        userId, branchId: null, action: 'PRODUCT_VARIANT_PRICE_CHANGED', entityType: 'ProductVariant', entityId: variantId,
        before: { price: current.price }, after: { price: variant.price },
      });
      return variant;
    });
  }

  return { listCategories, listBrands, createProduct, createVariant, updateVariantPrice };
}
