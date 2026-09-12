import { hash } from 'bcryptjs';
import type { Prisma } from '../src/generated/prisma/client.js';
import { syncProductionRbacCatalog } from '../src/modules/rbac/catalog.service.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const timestamp = new Date('2026-01-01T00:00:00.000Z');
export const permissions = [
  'sale.create',
  'sale.charge',
  'sale.complete',
  'sale.view',
  'sale.queue.view',
  'inventory.view',
  'inventory.manage',
  'cash.session.open',
  'cash.session.close',
  'user.manage',
  'report.view',
  'audit.view',
] as const;
export const rolePermissions = {
  SELLER: ['sale.create', 'sale.view', 'inventory.view'],
  CASHIER: [
    'sale.charge',
    'sale.complete',
    'sale.view',
    'sale.queue.view',
    'inventory.view',
    'cash.session.open',
    'cash.session.close',
  ],
  // The approved audit task reserves audit viewing for ADMIN.
  MANAGER: permissions.filter((p) => p !== 'user.manage' && p !== 'audit.view'),
  ADMIN: [...permissions],
} satisfies Record<string, readonly string[]>;
// User-approved demo metadata; these numbers are not fiscal invoice numbers.
export const branches = [
  { code: 'CEN', name: 'Centro', pointOfSaleNumber: 1 },
  { code: 'YB', name: 'Yerba Buena', pointOfSaleNumber: 2 },
  { code: 'TV', name: 'Tafí Viejo', pointOfSaleNumber: 3 },
  { code: 'BAN', name: 'Banda', pointOfSaleNumber: 4 },
  { code: 'CON', name: 'Concepción', pointOfSaleNumber: 5 },
  { code: 'DEP', name: 'Depósito Central', pointOfSaleNumber: 6 },
] as const;
const products = [
  {
    name: 'Remera Básica',
    slug: 'remera-basica',
    price: 4500000n,
    costPrice: 2500000n,
    options: [
      ['Negro', 'M', 'REM-NEG-M'],
      ['Blanco', 'S', 'REM-BLA-S'],
    ],
  },
  {
    name: 'Jean Slim',
    slug: 'jean-slim',
    price: 7500000n,
    costPrice: 4000000n,
    options: [
      ['Azul', '42', 'JEA-AZU-42'],
      ['Azul', '44', 'JEA-AZU-44'],
    ],
  },
  {
    name: 'Campera Jean',
    slug: 'campera-jean',
    price: 9500000n,
    costPrice: 5500000n,
    options: [
      ['Azul', 'M', 'CAM-AZU-M'],
      ['Azul', 'L', 'CAM-AZU-L'],
    ],
  },
] as const;

async function assertNoOperations(tx: Prisma.TransactionClient) {
  const counts = await Promise.all([
    tx.sale.count(),
    tx.cashSession.count(),
    tx.stockMovement.count(),
    tx.stockReservation.count(),
    tx.auditLog.count(),
  ]);
  if (counts.some((n) => n > 0))
    throw new Error('Business operations exist; use the guarded demo reset');
}

async function populate(tx: Prisma.TransactionClient, passwordHash: string) {
  const roles = Object.entries(rolePermissions);
  for (const [i, permission] of permissions.entries()) {
    const data = { id: id(100 + i), code: permission };
    await tx.permission.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
  }
  for (const [i, [code, grants]] of roles.entries()) {
    const data = { id: id(200 + i), code, name: code };
    await tx.role.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
    await tx.rolePermission.deleteMany({ where: { roleId: data.id } });
    await tx.rolePermission.createMany({
      data: grants.map((code) => ({
        roleId: data.id,
        permissionId: id(100 + permissions.findIndex((p) => p === code)),
      })),
    });
  }
  for (const [i, branch] of branches.entries()) {
    const data = {
      id: id(300 + i),
      ...branch,
      address: `Domicilio demo — ${branch.name}`,
    };
    await tx.branch.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
    const counter = { id: id(400 + i), branchId: data.id, nextValue: 1n };
    await tx.saleNumberCounter.upsert({
      where: { id: counter.id },
      create: counter,
      update: counter,
    });
    const register = {
      id: id(500 + i),
      branchId: data.id,
      name: 'Caja principal',
    };
    await tx.cashRegister.upsert({
      where: { id: register.id },
      create: register,
      update: register,
    });
  }
  const users = [
    ['admin', 'ADMIN'],
    ['manager01', 'MANAGER'],
    ['seller01', 'SELLER'],
    ['cashier01', 'CASHIER'],
  ] as const;
  for (const [i, [name, role]] of users.entries()) {
    const data = {
      id: id(600 + i),
      name,
      email: `${name}@demo.local`,
      passwordHash,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    // Random bcrypt salts are deliberate; only business values/identities are deterministic.
    await tx.user.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
    await tx.userBranchRole.deleteMany({ where: { userId: data.id } });
    const assigned = role === 'ADMIN' ? branches : branches.slice(0, 1);
    // ADMIN receives all 12 permissions and all demo branches. Global authorization
    // resolution belongs to Task 8; no role-check middleware or extra permission here.
    await tx.userBranchRole.createMany({
      data: assigned.map((branch) => ({
        id: id(700 + i * 10 + branch.pointOfSaleNumber),
        userId: data.id,
        branchId: id(300 + branch.pointOfSaleNumber - 1),
        roleId: id(200 + roles.findIndex(([code]) => code === role)),
      })),
    });
  }
  const category = { id: id(800), name: 'Indumentaria' };
  const brand = { id: id(801), name: 'Mona Jacinta' };
  await tx.category.upsert({
    where: { id: category.id },
    create: category,
    update: category,
  });
  await tx.brand.upsert({
    where: { id: brand.id },
    create: brand,
    update: brand,
  });
  for (const [i, product] of products.entries()) {
    const data = {
      id: id(900 + i),
      name: product.name,
      slug: product.slug,
      description: 'Producto de demostración',
      categoryId: category.id,
      brandId: brand.id,
      isActive: true,
    };
    await tx.product.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
    for (const [j, [color, size, sku]] of product.options.entries()) {
      const variant = {
        id: id(1000 + i * 10 + j),
        productId: data.id,
        color,
        size,
        sku,
        barcode: `DEMO-${sku}`,
        price: product.price,
        costPrice: product.costPrice,
        isActive: true,
      };
      await tx.productVariant.upsert({
        where: { id: variant.id },
        create: variant,
        update: variant,
      });
      for (const [k] of branches.entries()) {
        const inventory = {
          id: id(2000 + i * 100 + j * 10 + k),
          variantId: variant.id,
          branchId: id(300 + k),
          physical: k === 5 ? 50n : 20n,
          reserved: 0n,
        };
        await tx.inventory.upsert({
          where: { id: inventory.id },
          create: inventory,
          update: inventory,
        });
      }
    }
  }
  // Phase 1B (Production V1): the Production RBAC catalog (roles, permissions,
  // grants) must exist after every successful seed/reset — see
  // api/src/modules/rbac/catalog.service.ts. Runs on this same transaction
  // (never a nested one) and after the legacy role/permission loop above,
  // since that loop's `rolePermission.deleteMany({ where: { roleId } })` for
  // reused roles (ADMIN/CASHIER/SELLER share their legacy Role.id) would
  // otherwise wipe Production grants added before it ran.
  await syncProductionRbacCatalog(tx);
}

async function clear(tx: Prisma.TransactionClient) {
  // Explicit FK order: preserve schema, constraints, and _prisma_migrations.
  await tx.cashMovement.deleteMany();
  await tx.salePayment.deleteMany();
  await tx.stockMovement.deleteMany();
  await tx.stockReservation.deleteMany();
  await tx.saleItem.deleteMany();
  await tx.sale.deleteMany();
  await tx.cashSession.deleteMany();
  await tx.auditLog.deleteMany();
  await tx.inventory.deleteMany();
  await tx.productVariant.deleteMany();
  await tx.product.deleteMany();
  await tx.category.deleteMany();
  await tx.brand.deleteMany();
  await tx.cashRegister.deleteMany();
  await tx.saleNumberCounter.deleteMany();
  await tx.userBranchRole.deleteMany();
  await tx.rolePermission.deleteMany();
  await tx.user.deleteMany();
  await tx.role.deleteMany();
  await tx.permission.deleteMany();
  await tx.branch.deleteMany();
}

type SeedClient = {
  $transaction<T>(
    action: (tx: Prisma.TransactionClient) => Promise<T>,
    options: { maxWait: number; timeout: number },
  ): Promise<T>;
};

async function run(prisma: SeedClient, reset: boolean) {
  // Public, demo-only password requested by the plan. Hash before opening a transaction.
  const passwordHash = await hash('demo123', 12);
  await prisma.$transaction(
    async (tx) => {
      // Serialize these maintenance commands, including concurrent test invocations.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(506005)::text`;
      if (reset) await clear(tx);
      else await assertNoOperations(tx);
      await populate(tx, passwordHash);
    },
    { maxWait: 10000, timeout: 120000 },
  );
}

export const seedDemo = (prisma: SeedClient) => run(prisma, false);
export const resetDemo = (prisma: SeedClient) => run(prisma, true);
