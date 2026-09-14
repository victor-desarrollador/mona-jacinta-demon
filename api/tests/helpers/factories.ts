import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

let sequence = 0;
const unique = (prefix: string) => `${prefix}-${++sequence}`;

// Production V1 is single-company (organization.service.ts's ensureCompany
// throws on a second Company row). A dedicated factory Company was tried here
// during Phase 1C and caused exactly that: tests/rbac/scope-backfill.test.ts's
// beforeAll reads whatever Company row(s) exist and fails closed the moment a
// second one is present. So factory Locations must attach to the SAME Company
// row Phase 1A's organization backfill already established for TEST — the one
// tests/organization/company-location-backfill.test.ts converges to via its
// own TEST_COMPANY_BOOTSTRAP (id/cuit fixed there). This is deliberately not
// scripts/backfill-company-location.ts's DEMO_COMPANY_BOOTSTRAP (that script
// uses the demo cuit unconditionally, a separate pre-existing gap, out of
// scope here) — this cuit is what the TEST database's canonical Company
// actually carries.
const CANONICAL_TEST_COMPANY_CUIT = '00-11111111-1';

// Exported so tests/helpers/factory-cleanup.ts (and regression tests) can
// target exactly the Locations this module creates, without touching the
// canonical Company or its six canonical Locations. Location.code is
// Postgres TEXT with no length limit (prisma/migrations/.../add_company_location),
// so no truncation risk from this prefix.
export const FACTORY_LOCATION_CODE_PREFIX = 'TEST-FACTORY-LOC-';

// Phase 1C SWITCH: req.auth.branchIds comes from UserRoleScope exclusively at
// request time (empty UserRoleScope means empty branchIds, no legacy
// fallback — see effective-branch-ids.ts). Ad hoc factory-built branches live
// outside the seeded Company/Location/UserRoleScope catalog, so any branch a
// factory user needs authorized access to must get its own Location row
// first — per Phase 1A's convention (Location.id == Branch.id) — under the
// canonical Company, reused (not truncated per-file) via upsert. `code` uses
// FACTORY_LOCATION_CODE_PREFIX + randomUUID rather than this module's own
// per-file `sequence` counter: a counter that resets to 0 at the start of
// each file would collide with a same-numbered Location a different file
// created earlier in the same Vitest invocation (tests/helpers/test-db.ts's
// truncateAllTables intentionally skips Location/Company). What bounds the
// total factory row count is tests/globalSetup.ts, which deletes every
// FACTORY_LOCATION_CODE_PREFIX-marked Location at the start and end of each
// Vitest invocation — see tests/helpers/factory-cleanup.ts.
export async function ensureTestLocation(prisma: PrismaClient, branchId: string) {
  const company = await prisma.company.findUnique({ where: { cuit: CANONICAL_TEST_COMPANY_CUIT } });
  if (!company) {
    throw new Error(
      'Canonical TEST Company (Phase 1A) not found. Run `npm run db:backfill-company-location -- --target=test` ' +
        '(or the tests/organization/company-location-backfill.test.ts suite, which converges to the same row) before this test.',
    );
  }
  await prisma.location.upsert({
    where: { id: branchId },
    create: {
      id: branchId,
      companyId: company.id,
      name: 'Test factory location',
      code: `${FACTORY_LOCATION_CODE_PREFIX}${randomUUID()}`,
      type: 'RETAIL_BRANCH',
      address: 'Test address',
      pointOfSaleNumber: 2_000_000 + Number(process.hrtime.bigint() % 1_000_000n),
    },
    update: {},
  });
}

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
  // Mirror the legacy assignment above with a matching UserRoleScope row so
  // this factory user is authorized for their branch under the switched
  // runtime too (see ensureTestLocation's comment above).
  await ensureTestLocation(prisma, branchId);
  await prisma.userRoleScope.create({
    data: { userId: user.id, roleId, scopeKind: 'LOCATION', locationId: branchId },
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