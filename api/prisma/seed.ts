import { hash } from 'bcryptjs';
import type { Prisma } from '../src/generated/prisma/client.js';
import type { ProtectedTx } from '../scripts/local-test-fingerprint.js';
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

// The canonical demo seed's private sources. Each canonical literal and each
// id() derivation appears only here, inside CANONICAL_DEMO_SEED's construction;
// populate()/convergeCanonicalScopes() consume the descriptor, never these.
// User-approved demo metadata; these numbers are not fiscal invoice numbers.
const demoBranches = (
  [
    ['CEN', 'Centro', 1],
    ['YB', 'Yerba Buena', 2],
    ['TV', 'Tafí Viejo', 3],
    ['BAN', 'Banda', 4],
    ['CON', 'Concepción', 5],
    ['DEP', 'Depósito Central', 6],
  ] as const
).map(([code, name, pointOfSaleNumber], i) => ({
  id: id(300 + i),
  code,
  name,
  pointOfSaleNumber,
  address: `Domicilio demo — ${name}`,
}));
// D2.2: explicit canonical identities with explicit, per-user ids — never
// derived from array position, so removing/adding an identity can never
// renumber another — each with its one canonical Production assignment.
// id(601) is RESERVED for the historical manager01 identity (legacy MANAGER,
// D2.1: DEFERRED) and is never created or reused. No canonical user gets a
// legacy UserBranchRole row: normal seed is Production-native.
const demoUsers = [
  { id: id(600), name: 'admin', roleCode: ROLE_CODES.ADMIN, branchCode: null },
  { id: id(602), name: 'seller01', roleCode: ROLE_CODES.SELLER, branchCode: 'CEN' },
  { id: id(603), name: 'cashier01', roleCode: ROLE_CODES.CASHIER, branchCode: 'CEN' },
  { id: id(605), name: 'warehouse01', roleCode: ROLE_CODES.WAREHOUSE, branchCode: 'DEP' },
] as const;
const demoUserRows = demoUsers.map((user) => ({ ...user, email: `${user.name}@demo.local` }));
// The canonical bootstrap OWNER (Phase 1D.4.2): upserted by email, created once.
const demoOwner = { id: id(604), name: 'Owner Demo', email: 'owner01@demo.local' };
const demoCategory = { id: id(800), name: 'Indumentaria' };
const demoBrand = { id: id(801), name: 'Mona Jacinta' };

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

// Task 4: the canonical demo seed as pure, deeply frozen data — the final ids
// and business values populate() writes, so consumers (the LOCAL_TEST baseline
// verifier) never re-derive seed formulas. Runtime artifacts are excluded:
// passwordHash (random bcrypt salt over resolveSeedPassword()), the OWNER's
// database-default timestamps, generated UserRoleScope ids, and Location ids
// (runtime-resolved: Location.id == Branch.id). The Production RBAC catalog
// (OWNER/WAREHOUSE roles, Production permissions and grants) is owned by
// src/modules/rbac/catalog.service.ts and is not repeated here; `roles` and
// `permissions` are the legacy Demo V2 rows this file writes.
export type DemoSeedCanonical = {
  readonly permissions: readonly { readonly id: string; readonly code: string }[];
  readonly roles: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly permissionCodes: readonly string[];
  }[];
  readonly branches: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly pointOfSaleNumber: number;
    readonly address: string;
  }[];
  readonly saleNumberCounters: readonly { readonly id: string; readonly branchId: string; readonly nextValue: bigint }[];
  readonly cashRegisters: readonly { readonly id: string; readonly branchId: string; readonly name: string }[];
  // createdAt/updatedAt pinned by the seed for these users (ISO text, not a Date).
  readonly userTimestamp: string;
  readonly users: readonly { readonly id: string; readonly name: string; readonly email: string }[];
  // Upserted by email and created only once; its timestamps are database defaults.
  readonly owner: { readonly id: string; readonly name: string; readonly email: string };
  readonly category: { readonly id: string; readonly name: string };
  readonly brand: { readonly id: string; readonly name: string };
  readonly products: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
    readonly description: string;
    readonly categoryId: string;
    readonly brandId: string;
    readonly isActive: boolean;
  }[];
  readonly variants: readonly {
    readonly id: string;
    readonly productId: string;
    readonly color: string;
    readonly size: string;
    readonly sku: string;
    readonly barcode: string;
    readonly cashPrice: bigint;
    readonly price: bigint;
    readonly costPrice: bigint;
    readonly isActive: boolean;
  }[];
  readonly inventory: readonly {
    readonly id: string;
    readonly variantId: string;
    readonly branchId: string;
    readonly physical: bigint;
    readonly reserved: bigint;
  }[];
  // The seed never writes a legacy UserBranchRole row.
  readonly userBranchRoles: readonly never[];
  // Final assignments; LOCATION ones resolve to the Location whose id is the
  // named Branch's id once Locations exist (seed #1 writes only COMPANY ones).
  readonly assignments: readonly {
    readonly userId: string;
    readonly email: string;
    readonly roleCode: RoleCode;
    readonly scopeKind: 'COMPANY' | 'LOCATION';
    readonly branchCode: 'CEN' | 'DEP' | null;
  }[];
};

function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}

const demoCatalog = products.map((product, i) => {
  const row = {
    id: id(900 + i),
    name: product.name,
    slug: product.slug,
    description: 'Producto de demostración',
    categoryId: demoCategory.id,
    brandId: demoBrand.id,
    isActive: true,
  };
  const variants = product.options.map(([color, size, sku], j) => ({
    id: id(1000 + i * 10 + j),
    productId: row.id,
    color,
    size,
    sku,
    barcode: `DEMO-${sku}`,
    cashPrice: product.price,
    price: product.price,
    costPrice: product.costPrice,
    isActive: true,
  }));
  return { row, variants };
});

export const CANONICAL_DEMO_SEED: DemoSeedCanonical = freezeDeep({
  permissions: permissions.map((code, i) => ({ id: id(100 + i), code })),
  roles: Object.entries(rolePermissions).map(([code, grants], i) => ({
    id: id(200 + i),
    code,
    name: code,
    permissionCodes: [...grants],
  })),
  branches: demoBranches,
  saleNumberCounters: demoBranches.map((branch, i) => ({ id: id(400 + i), branchId: branch.id, nextValue: 1n })),
  cashRegisters: demoBranches.map((branch, i) => ({ id: id(500 + i), branchId: branch.id, name: 'Caja principal' })),
  userTimestamp: timestamp.toISOString(),
  users: demoUserRows.map(({ id: userId, name, email }) => ({ id: userId, name, email })),
  owner: demoOwner,
  category: demoCategory,
  brand: demoBrand,
  products: demoCatalog.map((entry) => entry.row),
  variants: demoCatalog.flatMap((entry) => entry.variants),
  inventory: demoCatalog.flatMap((entry, i) =>
    entry.variants.flatMap((variant, j) =>
      demoBranches.map((branch, k) => ({
        id: id(2000 + i * 100 + j * 10 + k),
        variantId: variant.id,
        branchId: branch.id,
        physical: k === 5 ? 50n : 20n,
        reserved: 0n,
      })),
    ),
  ),
  userBranchRoles: [],
  // D2.2 canonical Production assignment per canonical identity: COMPANY
  // assignments are location-independent; LOCATION assignments name their
  // canonical Location by stable Branch code, never by array position.
  assignments: [{ ...demoOwner, roleCode: ROLE_CODES.OWNER, branchCode: null }, ...demoUserRows].map((user) => ({
    userId: user.id,
    email: user.email,
    roleCode: user.roleCode,
    scopeKind: user.branchCode === null ? ('COMPANY' as const) : ('LOCATION' as const),
    branchCode: user.branchCode,
  })),
});

// Compatibility projection (code, name, pointOfSaleNumber) of the canonical Branches.
export const branches: readonly { readonly code: string; readonly name: string; readonly pointOfSaleNumber: number }[] =
  freezeDeep(CANONICAL_DEMO_SEED.branches.map(({ code, name, pointOfSaleNumber }) => ({ code, name, pointOfSaleNumber })));


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
  const seed = CANONICAL_DEMO_SEED;
  const permissionIdByCode = new Map(seed.permissions.map((permission) => [permission.code, permission.id]));
  for (const permission of seed.permissions) {
    const data = { id: permission.id, code: permission.code };
    await tx.permission.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
  }
  for (const role of seed.roles) {
    const data = { id: role.id, code: role.code, name: role.name };
    await tx.role.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
    await tx.rolePermission.deleteMany({ where: { roleId: data.id } });
    await tx.rolePermission.createMany({
      data: role.permissionCodes.map((code) => ({
        roleId: data.id,
        permissionId: permissionIdByCode.get(code)!,
      })),
    });
  }
  for (const branch of seed.branches) {
    const data = { ...branch };
    await tx.branch.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
    for (const counter of seed.saleNumberCounters.filter((c) => c.branchId === branch.id)) {
      const row = { ...counter };
      await tx.saleNumberCounter.upsert({
        where: { id: row.id },
        create: row,
        update: row,
      });
    }
    for (const register of seed.cashRegisters.filter((r) => r.branchId === branch.id)) {
      const row = { ...register };
      await tx.cashRegister.upsert({
        where: { id: row.id },
        create: row,
        update: row,
      });
    }
  }
  // D2.2: canonical demo identities from the descriptor (id(601) stays
  // reserved there); the OWNER is provisioned separately below.
  for (const user of seed.users) {
    const data = {
      ...user,
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
  const category = { ...seed.category };
  const brand = { ...seed.brand };
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
  for (const product of seed.products) {
    const data = { ...product };
    await tx.product.upsert({
      where: { id: data.id },
      create: data,
      update: data,
    });
    for (const variant of seed.variants.filter((v) => v.productId === product.id)) {
      const row = { ...variant };
      await tx.productVariant.upsert({
        where: { id: row.id },
        create: row,
        update: row,
      });
      for (const inventory of seed.inventory.filter((inv) => inv.variantId === variant.id)) {
        const stock = { ...inventory };
        await tx.inventory.upsert({
          where: { id: stock.id },
          create: stock,
          update: stock,
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
    where: { email: seed.owner.email },
    // Canonical id, matching every other seeded entity in this file — a
    // deterministic id.uuid() default would otherwise mint a fresh row on
    // every full clear()/populate() cycle, breaking the file's own
    // "second resetDemo from scratch produces the exact same canonical ids"
    // invariant (see seed-integration.test.ts).
    create: { ...seed.owner, passwordHash },
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
  const assignments = CANONICAL_DEMO_SEED.assignments;
  const roleCodes = [...new Set(assignments.map((a) => a.roleCode))];
  const roles = await tx.role.findMany({ where: { code: { in: roleCodes } } });
  const roleIdByCode = new Map(roles.map((role) => [role.code, role.id]));
  const missingRoles = roleCodes.filter((code) => !roleIdByCode.has(code));
  if (missingRoles.length > 0)
    throw new Error(`Production Role(s) ${missingRoles.join(', ')} missing after catalog sync`);

  const users = await tx.user.findMany({
    where: { email: { in: assignments.map((a) => a.email) } },
    select: { id: true, email: true },
  });
  const userIdByEmail = new Map(users.map((user) => [user.email, user.id]));

  const locationCodes = [...new Set(assignments.flatMap((a) => (a.branchCode === null ? [] : [a.branchCode])))];
  const locationIdByCode = new Map<string, string>();
  if ((await tx.location.count()) > 0) {
    for (const code of locationCodes) {
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

  for (const assignment of assignments) {
    const userId = userIdByEmail.get(assignment.email)!;
    const roleId = roleIdByCode.get(assignment.roleCode)!;
    const target =
      assignment.branchCode === null
        ? { roleId, scopeKind: 'COMPANY' as const, locationId: null }
        : locationIdByCode.has(assignment.branchCode)
          ? {
              roleId,
              scopeKind: 'LOCATION' as const,
              locationId: locationIdByCode.get(assignment.branchCode)!,
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

// D3R1: local/TEST keep the public deterministic demo123. A public DEMO
// database is seeded with an operator-supplied password instead
// (DEMO_SEED_PASSWORD via the db:seed/db:reset CLIs); it is validated before
// any database access, hashed exactly like the default, never logged, never
// echoed in errors and never persisted in plaintext.
const DEFAULT_DEMO_PASSWORD = 'demo123';
const OVERRIDE_MIN_LENGTH = 16;
// bcrypt only uses the first 72 bytes; longer input would be silently truncated.
const OVERRIDE_MAX_BYTES = 72;

export type SeedOptions = { password?: string };

function assertOverridePassword(password: string) {
  if (
    password.length < OVERRIDE_MIN_LENGTH ||
    Buffer.byteLength(password, 'utf8') > OVERRIDE_MAX_BYTES ||
    password.trim() !== password
  ) {
    throw new Error(
      `DEMO_SEED_PASSWORD must be ${OVERRIDE_MIN_LENGTH}+ characters, at most ${OVERRIDE_MAX_BYTES} bytes, without leading/trailing spaces`,
    );
  }
}

// Pure password selection: the default when no override is given, otherwise
// the validated override. Throws (before any database access) on an invalid
// explicit override — never a silent fallback to demo123.
export function resolveSeedPassword(options: SeedOptions = {}): string {
  if (options.password === undefined) return DEFAULT_DEMO_PASSWORD;
  assertOverridePassword(options.password);
  return options.password;
}

// An explicitly supplied (even empty) value is an operator decision and is
// validated here, before the CLI opens any database connection.
export function demoSeedOptionsFromEnv(source: NodeJS.ProcessEnv): SeedOptions {
  const password = source.DEMO_SEED_PASSWORD;
  if (password === undefined) return {};
  assertOverridePassword(password);
  return { password };
}

// The seed body proper, on a transaction the CALLER owns. `run` wraps it in its own transaction (seedDemo/resetDemo, used by
// the integration suites); the LOCAL_TEST protected resume (V2.3.3 R4) calls seedDemoOnTransaction on its single protected
// transaction so seed #2 never opens a transaction, client or connection of its own.
async function seedOnTransaction(tx: Prisma.TransactionClient, reset: boolean, passwordHash: string) {
  // Serialize these maintenance commands, including concurrent test invocations.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(506005)::text`;
  if (reset) await clear(tx);
  else await assertNoOperations(tx);
  await populate(tx, passwordHash);
}

// The bcrypt hash of the seed password (cost 12, CPU only). The protected resume computes it BEFORE opening its transaction.
export async function defaultSeedPasswordHash(options: SeedOptions = {}): Promise<string> {
  return hash(resolveSeedPassword(options), 12);
}

// Seed #2 on the protected transaction. The bcrypt hash is computed by the caller BEFORE the transaction (CPU only).
export async function seedDemoOnTransaction(tx: ProtectedTx, passwordHash: string): Promise<void> {
  await seedOnTransaction(tx, false, passwordHash);
}

async function run(prisma: SeedClient, reset: boolean, options: SeedOptions) {
  // Validate and hash before opening a transaction.
  const passwordHash = await hash(resolveSeedPassword(options), 12);
  await prisma.$transaction((tx) => seedOnTransaction(tx, reset, passwordHash), { maxWait: 10000, timeout: 120000 });
}

export const seedDemo = (prisma: SeedClient, options: SeedOptions = {}) => run(prisma, false, options);
export const resetDemo = (prisma: SeedClient, options: SeedOptions = {}) => run(prisma, true, options);
