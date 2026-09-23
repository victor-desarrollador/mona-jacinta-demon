import { hash } from 'bcryptjs';
import type { Prisma } from '../src/generated/prisma/client.js';
import { syncProductionRbacCatalog } from '../src/modules/rbac/catalog.service.js';
import { ROLE_CODES, type RoleCode } from '../src/modules/rbac/roles.js';

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
// D2.2: explicit canonical identities (see populate()). id(601) is reserved
// for the historical manager01 identity and deliberately absent; id(604) is
// the canonical OWNER, provisioned separately below.
const canonicalUsers = [
  { id: id(600), name: 'admin' },
  { id: id(602), name: 'seller01' },
  { id: id(603), name: 'cashier01' },
  { id: id(605), name: 'warehouse01' },
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
  // D2.2: canonical demo identities with explicit, per-user ids — never
  // derived from array position, so removing/adding an identity can never
  // renumber another. id(601) is RESERVED for the historical manager01
  // identity (legacy MANAGER, D2.1: DEFERRED) and is never created or reused
  // here. id(604) is the canonical OWNER, provisioned below. No canonical
  // user gets a legacy UserBranchRole row: normal seed is Production-native.
  for (const user of canonicalUsers) {
    const data = {
      id: user.id,
      name: user.name,
      email: `${user.name}@demo.local`,
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

  // Phase 1D.4.2 (Production V1): canonical bootstrap OWNER user. OWNER
  // never existed as a legacy Demo V2 role, so it never had a
  // UserBranchRole row; its only authorization state is a single COMPANY
  // UserRoleScope (converged below). This provisions the canonical,
  // bootstrap FIRST OWNER — the HTTP scope-assignment endpoint (Task
  // 1D.4.3) cannot bootstrap this first OWNER itself, since
  // self-modification is denied for every caller and ADMIN can never grant
  // OWNER; a later, already-bootstrapped OWNER can still grant the OWNER
  // role to a different (non-self) user through that endpoint.
  await tx.user.upsert({
    where: { email: 'owner01@demo.local' },
    // Canonical id, matching every other seeded entity in this file — a
    // deterministic id.uuid() default would otherwise mint a fresh row on
    // every full clear()/populate() cycle, breaking the file's own
    // "second resetDemo from scratch produces the exact same canonical ids"
    // invariant (see seed-integration.test.ts).
    create: { id: id(604), name: 'Owner Demo', email: 'owner01@demo.local', passwordHash },
    update: {},
  });

  // D2.2 (Phase 1 Global Closeout): canonical Production assignments are
  // provisioned directly — normal seed no longer runs the historical Phase1C
  // UserBranchRole -> UserRoleScope sync or the GC4F2 ADMIN-company
  // convergence (both stay available as standalone recovery tooling). Runs
  // after syncProductionRbacCatalog, which creates the OWNER/WAREHOUSE Role
  // rows, on this same transaction — a failure rolls back the whole
  // seed/reset. Never deletes a legacy UserBranchRole row or any
  // non-canonical user: historical migration input on an existing database
  // (e.g. manager01) is left intact for its own human-approved recovery.
  await convergeCanonicalScopes(tx);
}

// D2.2 canonical Production assignment per canonical identity, keyed by
// the canonical email (the OWNER is upserted by email above). COMPANY
// assignments are location-independent; LOCATION assignments name their
// canonical Location by stable code, never by array position.
const canonicalAssignments: readonly {
  email: string;
  roleCode: RoleCode;
  locationCode: 'CEN' | 'DEP' | null;
}[] = [
  { email: 'owner01@demo.local', roleCode: ROLE_CODES.OWNER, locationCode: null },
  { email: 'admin@demo.local', roleCode: ROLE_CODES.ADMIN, locationCode: null },
  { email: 'seller01@demo.local', roleCode: ROLE_CODES.SELLER, locationCode: 'CEN' },
  { email: 'cashier01@demo.local', roleCode: ROLE_CODES.CASHIER, locationCode: 'CEN' },
  { email: 'warehouse01@demo.local', roleCode: ROLE_CODES.WAREHOUSE, locationCode: 'DEP' },
];

// Converges each canonical user's UserRoleScope rows to exactly its one
// canonical assignment: an already-matching row is kept (generated
// UserRoleScope ids stay stable across reseeds), anything else for that
// user is removed, a missing target is created. Only canonical users'
// rows are ever touched.
//
// Location gate: with zero Locations (Phase 1A never backfilled on this
// database) only the COMPANY assignments are provisioned — no Company or
// Location is ever invented here, and the LOCATION-scoped canonical users
// get no scope. Once any Location exists, the canonical CEN and DEP
// Locations must both resolve with Location.id == Branch.id (the Phase 1A
// mapping); a missing or inconsistent one fails the whole seed/reset closed
// rather than silently producing partial authorization.
async function convergeCanonicalScopes(tx: Prisma.TransactionClient) {
  const roleCodes = [...new Set(canonicalAssignments.map((a) => a.roleCode))];
  const roles = await tx.role.findMany({ where: { code: { in: roleCodes } } });
  const roleIdByCode = new Map(roles.map((role) => [role.code, role.id]));
  const missingRoles = roleCodes.filter((code) => !roleIdByCode.has(code));
  if (missingRoles.length > 0)
    throw new Error(`Production Role(s) ${missingRoles.join(', ')} missing after catalog sync`);

  const users = await tx.user.findMany({
    where: { email: { in: canonicalAssignments.map((a) => a.email) } },
    select: { id: true, email: true },
  });
  const userIdByEmail = new Map(users.map((user) => [user.email, user.id]));

  const locationIdByCode = new Map<string, string>();
  if ((await tx.location.count()) > 0) {
    for (const code of ['CEN', 'DEP'] as const) {
      const [location, branch] = await Promise.all([
        tx.location.findUnique({ where: { code } }),
        tx.branch.findUnique({ where: { code } }),
      ]);
      if (!location || !branch || location.id !== branch.id)
        throw new Error(
          `Canonical Location ${code} is missing or does not match Branch ${code}; ` +
            'refusing to seed a partial authorization state',
        );
      locationIdByCode.set(code, location.id);
    }
  }

  for (const assignment of canonicalAssignments) {
    const userId = userIdByEmail.get(assignment.email)!;
    const roleId = roleIdByCode.get(assignment.roleCode)!;
    const target =
      assignment.locationCode === null
        ? { roleId, scopeKind: 'COMPANY' as const, locationId: null }
        : locationIdByCode.has(assignment.locationCode)
          ? {
              roleId,
              scopeKind: 'LOCATION' as const,
              locationId: locationIdByCode.get(assignment.locationCode)!,
            }
          : null;
    const existing = await tx.userRoleScope.findMany({ where: { userId } });
    const kept = target
      ? existing.find(
          (row) =>
            row.roleId === target.roleId &&
            row.scopeKind === target.scopeKind &&
            row.locationId === target.locationId,
        )
      : undefined;
    const stale = existing.filter((row) => row !== kept).map((row) => row.id);
    if (stale.length > 0) await tx.userRoleScope.deleteMany({ where: { id: { in: stale } } });
    if (target && !kept)
      await tx.userRoleScope.create({ data: { userId, ...target } });
  }
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
