import type { PrismaClient } from '../../src/generated/prisma/client.js';

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;

export async function createBranch(
  prisma: PrismaClient,
  overrides: Partial<{ name: string; code: string; pointOfSaleNumber: number }> = {},
) {
  const suffix = unique('branch');
  return prisma.branch.create({
    data: {
      name: overrides.name ?? `Branch ${suffix}`,
      code: overrides.code ?? suffix.toUpperCase(),
      address: 'Test address',
      pointOfSaleNumber: overrides.pointOfSaleNumber ?? sequence,
    },
  });
}

export async function createRole(
  prisma: PrismaClient,
  code = unique('ROLE').toUpperCase(),
) {
  return prisma.role.create({ data: { code, name: code } });
}

export async function createTestUser(
  prisma: PrismaClient,
  role: string | { id: string },
  branch: string | { id: string },
) {
  const roleId = typeof role === 'string' ? role : role.id;
  const branchId = typeof branch === 'string' ? branch : branch.id;
  const user = await prisma.user.create({
    data: {
      name: unique('user'),
      email: `${unique('user')}@test.local`,
      passwordHash: 'test-only-hash',
    },
  });
  await prisma.userBranchRole.create({
    data: { userId: user.id, roleId, branchId },
  });
  return user;
}

export async function createProduct(
  prisma: PrismaClient,
  categoryId: string,
  brandId: string,
) {
  return prisma.product.create({
    data: {
      name: unique('Product'),
      slug: unique('product'),
      categoryId,
      brandId,
    },
  });
}

export async function createCategory(prisma: PrismaClient) {
  return prisma.category.create({ data: { name: unique('Category') } });
}

export async function createBrand(prisma: PrismaClient) {
  return prisma.brand.create({ data: { name: unique('Brand') } });
}

export async function createVariant(prisma: PrismaClient, productId: string) {
  const sku = unique('SKU');
  return prisma.productVariant.create({
    data: {
      productId,
      sku,
      barcode: unique('BARCODE'),
      price: 100n,
      costPrice: 50n,
    },
  });
}

export async function createInventory(
  prisma: PrismaClient,
  variantId: string,
  branchId: string,
) {
  return prisma.inventory.create({
    data: { variantId, branchId, physical: 10n, reserved: 0n },
  });
}

export async function createSale(
  prisma: PrismaClient,
  sellerId: string,
  branchId: string,
  variant: { id: string; productId: string; sku: string; price: bigint },
) {
  return prisma.sale.create({
    data: {
      sellerId,
      branchId,
      subtotal: variant.price,
      total: variant.price,
      items: {
        create: {
          variantId: variant.id,
          productId: variant.productId,
          productName: 'Test product',
          variantName: 'Test variant',
          sku: variant.sku,
          quantity: 1n,
          unitPrice: variant.price,
          subtotal: variant.price,
        },
      },
    },
  });
}