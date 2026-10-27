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

type CatalogDatabase = Pick<PrismaClient, 'category' | 'brand' | 'productVariant' | '$transaction'>;

const productSelect = {
  id: true, name: true, slug: true, categoryId: true, brandId: true, isActive: true,
} as const;

const variantSelect = {
  id: true, productId: true, sku: true, barcode: true, color: true, size: true,
  cashPrice: true, price: true, wholesalePrice: true, costPrice: true, isActive: true,
} as const;

// Block 1: the ONE response shape of price management (GET /variants/:id/
// pricing and PATCH /variants/:id/price): exactly what the price editor
// needs. Least privilege: no costPrice, no other variant/product columns.
const pricingSelect = { id: true, sku: true, cashPrice: true, price: true, wholesalePrice: true } as const;

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

  // Block 1: management read of the current prices (list + wholesale) for
  // the admin price editor. Routed behind PRICE_MANAGE (COMPANY-required),
  // never through the seller/warehouse catalog reads, which keep omitting
  // wholesalePrice. Returns prices only: no cost, no other columns.
  async function getVariantPricing(variantId: string) {
    const variant = await database.productVariant.findUnique({
      where: { id: variantId }, select: pricingSelect,
    });
    if (!variant) throw new AppError(404, 'NOT_FOUND', 'No se encontró la variante.');
    return variant;
  }

  async function updateVariantPrice(userId: string, variantId: string, input: UpdateVariantPriceInput) {
    return database.$transaction(async (tx) => {
      // Row lock so the audited `before` is exactly the price this update
      // replaced, even under concurrent price changes.
      const [current] = await tx.$queryRaw<Array<{ cashPrice: bigint | null; price: bigint; wholesalePrice: bigint | null }>>`
        SELECT "cashPrice", price, "wholesalePrice" FROM "ProductVariant" WHERE id = ${variantId} FOR UPDATE
      `;
      if (!current) throw new AppError(404, 'NOT_FOUND', 'No se encontró la variante.');
      // Block 1: the RESULTING pair must keep wholesale <= list, whichever
      // side this request changes (mirrors the DB CHECK constraint).
      const price = input.price ?? current.price;
      const cashPrice = input.cashPrice ?? current.cashPrice;
      const wholesalePrice = input.wholesalePrice === undefined ? current.wholesalePrice : input.wholesalePrice;
      if (wholesalePrice !== null && wholesalePrice > price) {
        throw conflict('WHOLESALE_PRICE_ABOVE_LIST', 'El precio mayorista no puede superar el precio de lista.');
      }
      // Pilot Pricing V2: wholesalePrice is the wholesale CASH base, so it may
      // never exceed the retail CASH base once that base exists (mirrors the
      // DB CHECK; a NULL cashPrice is not yet backfilled and cannot be compared).
      if (wholesalePrice !== null && cashPrice !== null && wholesalePrice > cashPrice) {
        throw conflict('WHOLESALE_PRICE_ABOVE_CASH', 'El precio mayorista no puede superar el precio efectivo minorista.');
      }
      const variant = await tx.productVariant.update({
        where: { id: variantId }, data: { cashPrice, price, wholesalePrice }, select: pricingSelect,
      });
      // Audit exactly the fields this request changed.
      const changed = (['cashPrice', 'price', 'wholesalePrice'] as const).filter((field) => input[field] !== undefined);
      await createAuditLog(tx, {
        userId, branchId: null, action: 'PRODUCT_VARIANT_PRICE_CHANGED', entityType: 'ProductVariant', entityId: variantId,
        before: Object.fromEntries(changed.map((field) => [field, current[field]])),
        after: Object.fromEntries(changed.map((field) => [field, variant[field]])),
      });
      return variant;
    });
  }

  return { listCategories, listBrands, createProduct, createVariant, getVariantPricing, updateVariantPrice };
}
