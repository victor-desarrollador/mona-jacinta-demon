import { compare } from 'bcryptjs';
import { createHash } from 'node:crypto';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  backfillLocationsFromBranches,
  locationTypeForBranchCode,
  type CompanyBootstrap,
} from '../src/modules/organization/organization.service.js';
import { branches as seedBranches, seedDemo } from '../prisma/seed.js';
import { pinUtcWriterSession } from './local-test-utc-writer.js';
import { CANONICAL_DEMO_SEED, resolveSeedPassword } from '../prisma/seed.js';
import { CANONICAL_PERMISSION_IDS, CANONICAL_ROLE_IDS } from '../src/modules/rbac/catalog.service.js';
import { productionPermissionValues } from '../src/modules/rbac/permissions.js';
import { DEFAULT_ROLE_GRANTS } from '../src/modules/rbac/role-permission-matrix.js';
import { roleCodeValues, type RoleCode } from '../src/modules/rbac/roles.js';
import { PROTECTED_RELATIONS, TYPE_CONTRACT_V3, type CellText, type ProtectedTx, type StateRows } from './local-test-fingerprint.js';
import { TEST_COMPANY_BOOTSTRAP } from './test-company-bootstrap.js';

// Task 4: LOCAL_TEST baseline runtime — the database side of
// scripts/database/local-test-prepare.mjs (classify, seed, backfill, verify).
//
// Classification and verification are pure functions over a facts snapshot
// (LocalTestBaselineFacts) compared against an explicit canonical descriptor
// (LocalTestCanonicalBaseline); reading facts from a database is a separate,
// injected seam. The only resumable states are the ones the prepare pipeline
// itself creates (after migration, after seed #1, after backfill, after seed #2);
// anything else — operational/history rows, migration drift, any value that
// seedDemo would silently overwrite (counters, inventory, users, catalog) — is
// refused, never repaired. There is no reset path.
//
// Importing this module never touches a database: no PrismaClient, no pg, no
// environment read. Target selection and identity proof belong to the caller
// (LOCAL_TEST only), which supplies `db`, `proveIdentity` and `close`.

export const LOCAL_TEST_BASELINE_STATES = Object.freeze([
  'FRESH',
  'MIGRATED_EMPTY',
  'EXACT_BASELINE',
  'POST_SEED1',
  'POST_BACKFILL',
  'PARTIAL_UNSAFE',
  'OPERATIONAL_DATA',
  'MIGRATION_DRIFT',
  'UNKNOWN',
] as const);
export type LocalTestBaselineState = (typeof LOCAL_TEST_BASELINE_STATES)[number];

// Every transactional/history model. Each must be exactly zero at every
// resumable state (seedDemo's own assertNoOperations checks only five of them).
export const OPERATIONAL_MODELS = Object.freeze([
  'sale',
  'saleItem',
  'salePayment',
  'cashSession',
  'cashMovement',
  'stockMovement',
  'stockReservation',
  'auditLog',
] as const);
export type OperationalModel = (typeof OPERATIONAL_MODELS)[number];

export type MigrationRow = { name: string; checksum: string; finished: boolean; rolledBack: boolean };
export type ApprovedMigration = { name: string; checksum: string };
export type CompanyRow = { id: string; name: string; cuit: string; address: string; isActive: boolean };
export type BranchRow = { id: string; code: string; name: string; address: string; pointOfSaleNumber: number };
export type LocationRow = {
  id: string;
  companyId: string;
  code: string;
  name: string;
  type: 'RETAIL_BRANCH' | 'CENTRAL_WAREHOUSE';
  address: string;
  pointOfSaleNumber: number;
  isActive: boolean;
};
export type CounterRow = { id: string; branchId: string; nextValue: bigint };
export type RegisterRow = { id: string; branchId: string; name: string };
// passwordHash is salted (bcrypt, random salt per seed run): facts carry only
// whether it verifies against the LOCAL_TEST default password, never the bytes.
export type PasswordState = 'default' | 'other' | 'invalid';
export type UserRow = { id: string; name: string; email: string; isActive: boolean; password: PasswordState };
export type RoleRow = { id: string; code: string; name: string };
export type PermissionRow = { id: string; code: string };
export type RolePermissionRow = { roleId: string; permissionId: string };
// UserRoleScope.id is generated: scopes are compared by their content only.
export type ScopeRow = { userId: string; roleId: string; scopeKind: 'COMPANY' | 'LOCATION'; locationId: string | null };
export type UserBranchRoleRow = { userId: string; branchId: string; roleId: string };
export type CategoryRow = { id: string; name: string };
export type BrandRow = { id: string; name: string };
export type ProductRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  categoryId: string;
  brandId: string;
  isActive: boolean;
};
export type VariantRow = {
  id: string;
  productId: string;
  sku: string;
  barcode: string;
  color: string | null;
  size: string | null;
  price: bigint;
  costPrice: bigint;
  isActive: boolean;
};
export type InventoryRow = { id: string; variantId: string; branchId: string; physical: bigint; reserved: bigint };

// Everything seedDemo writes (upserts) apart from UserRoleScope.
export type SeededRows = {
  branches: BranchRow[];
  counters: CounterRow[];
  registers: RegisterRow[];
  users: UserRow[];
  roles: RoleRow[];
  permissions: PermissionRow[];
  rolePermissions: RolePermissionRow[];
  userBranchRoles: UserBranchRoleRow[];
  categories: CategoryRow[];
  brands: BrandRow[];
  products: ProductRow[];
  variants: VariantRow[];
  inventory: InventoryRow[];
};
export const SEEDED_TABLES = Object.freeze([
  'branches',
  'counters',
  'registers',
  'users',
  'roles',
  'permissions',
  'rolePermissions',
  'userBranchRoles',
  'categories',
  'brands',
  'products',
  'variants',
  'inventory',
] as const satisfies readonly (keyof SeededRows)[]);

export type LocalTestBaselineFacts = {
  migration: { schemaPresent: boolean; rows: MigrationRow[] };
  operational: Record<OperationalModel, number>;
  seeded: SeededRows;
  companies: CompanyRow[];
  locations: LocationRow[];
  userRoleScopes: ScopeRow[];
};

export type LocalTestCanonicalBaseline = {
  migrations: readonly ApprovedMigration[];
  company: Readonly<CompanyBootstrap>;
  seeded: SeededRows;
  // Seed #1 runs with zero Locations: only the COMPANY assignments exist.
  seed1Scopes: readonly ScopeRow[];
  // After backfill + seed #2: every canonical assignment.
  finalScopes: readonly ScopeRow[];
};

export type LocalTestBaselineClassification = { state: LocalTestBaselineState; issues: string[] };

// Canonical Locations are derived, never listed: one per canonical Branch,
// Location.id == Branch.id, owned by the canonical Company, typed by the
// frozen FR-ORG-001 mapping.
export function canonicalLocations(canonical: LocalTestCanonicalBaseline): LocationRow[] {
  return canonical.seeded.branches.map((branch) => ({
    id: branch.id,
    companyId: canonical.company.id,
    code: branch.code,
    name: branch.name,
    type: locationTypeForBranchCode(branch.code),
    address: branch.address,
    pointOfSaleNumber: branch.pointOfSaleNumber,
    isActive: true,
  }));
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const result = (state: LocalTestBaselineState, issue: string): LocalTestBaselineClassification => ({
  state,
  issues: [issue],
});

// Order-independent, type-exact identity of a row: keys sorted, bigint kept
// distinct from number, so a set comparison can never match 1n with 1.
function rowKey(value: unknown): string {
  if (typeof value === 'bigint') return `${value}n`;
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(rowKey).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${rowKey(record[key])}`)
    .join(',')}}`;
}
// Exact set equality; both sides are duplicate-free (facts are validated first).
function sameRows(actual: readonly unknown[], expected: readonly unknown[]): boolean {
  if (actual.length !== expected.length) return false;
  const a = actual.map(rowKey).sort();
  const e = expected.map(rowKey).sort();
  return a.every((key, i) => key === e[i]);
}

// The identity each collection's rows must not repeat (schema primary keys;
// scopes by their whole semantic content because their ids are generated).
const identity: Record<string, (row: Record<string, unknown>) => unknown> = {
  rolePermissions: (row) => (typeof row.roleId === 'string' && typeof row.permissionId === 'string' ? `${row.roleId}|${row.permissionId}` : null),
  userBranchRoles: (row) =>
    typeof row.userId === 'string' && typeof row.branchId === 'string' && typeof row.roleId === 'string'
      ? `${row.userId}|${row.branchId}|${row.roleId}`
      : null,
  userRoleScopes: (row) =>
    typeof row.userId === 'string' &&
    typeof row.roleId === 'string' &&
    (row.scopeKind === 'COMPANY' || row.scopeKind === 'LOCATION') &&
    (row.locationId === null || typeof row.locationId === 'string')
      ? rowKey(row)
      : null,
};
const byId = (row: Record<string, unknown>) => (typeof row.id === 'string' ? row.id : null);

// Every row a record with a well-typed identity, and no identity repeated.
function wellFormedRows(rows: unknown, table: string): rows is Record<string, unknown>[] {
  if (!Array.isArray(rows)) return false;
  const keyOf = identity[table] ?? byId;
  const seen = new Set<unknown>();
  for (const row of rows) {
    if (!isRecord(row)) return false;
    const key = keyOf(row);
    if (key === null || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function isWellFormed(facts: unknown): facts is LocalTestBaselineFacts {
  if (!isRecord(facts)) return false;
  const { migration, operational, seeded } = facts;
  if (!isRecord(migration) || typeof migration.schemaPresent !== 'boolean' || !Array.isArray(migration.rows)) return false;
  for (const row of migration.rows) {
    if (
      !isRecord(row) ||
      typeof row.name !== 'string' ||
      typeof row.checksum !== 'string' ||
      typeof row.finished !== 'boolean' ||
      typeof row.rolledBack !== 'boolean'
    ) {
      return false;
    }
  }
  if (!isRecord(operational)) return false;
  for (const model of OPERATIONAL_MODELS) {
    const count = operational[model];
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return false;
  }
  if (!isRecord(seeded)) return false;
  for (const table of SEEDED_TABLES) if (!wellFormedRows(seeded[table], table)) return false;
  return (
    wellFormedRows(facts.companies, 'companies') &&
    wellFormedRows(facts.locations, 'locations') &&
    wellFormedRows(facts.userRoleScopes, 'userRoleScopes')
  );
}

const exactMigrations = (rows: readonly MigrationRow[], approved: readonly ApprovedMigration[]) =>
  rows.length === approved.length &&
  rows.every(
    (row, i) =>
      row.name === approved[i]!.name && row.checksum === approved[i]!.checksum && row.finished && !row.rolledBack,
  );

const noBusinessRows = (f: LocalTestBaselineFacts) =>
  SEEDED_TABLES.every((table) => f.seeded[table].length === 0) &&
  f.companies.length === 0 &&
  f.locations.length === 0 &&
  f.userRoleScopes.length === 0;

// Fail-closed precedence: malformed → migration history → operational rows →
// empty → exact seeded rows → Company/Location/scope phase. Unsafe evidence
// always outranks a recognizable safe fragment.
export function classifyLocalTestBaseline(
  facts: unknown,
  canonical: LocalTestCanonicalBaseline,
): LocalTestBaselineClassification {
  if (!isWellFormed(facts)) return result('UNKNOWN', 'facts are missing or malformed');
  const f = facts;

  if (!f.migration.schemaPresent) {
    if (f.migration.rows.length > 0) return result('MIGRATION_DRIFT', 'migration history without the application schema');
    const nothing = noBusinessRows(f) && OPERATIONAL_MODELS.every((model) => f.operational[model] === 0);
    return nothing
      ? result('FRESH', 'no application schema and no migration history')
      : result('UNKNOWN', 'rows reported without an application schema');
  }
  if (!exactMigrations(f.migration.rows, canonical.migrations)) {
    return result('MIGRATION_DRIFT', 'migration history differs from the approved migrations');
  }

  if (OPERATIONAL_MODELS.some((model) => f.operational[model] > 0)) {
    return result('OPERATIONAL_DATA', 'operational or history rows exist');
  }

  if (noBusinessRows(f)) return result('MIGRATED_EMPTY', 'migrated, no business rows');

  const drifted = SEEDED_TABLES.filter((table) => !sameRows(f.seeded[table], canonical.seeded[table]));
  if (drifted.length > 0) return result('PARTIAL_UNSAFE', `seeded data differs from the canonical seed (${drifted.join(', ')})`);

  const seed1 = sameRows(f.userRoleScopes, canonical.seed1Scopes);
  if (f.companies.length === 0 && f.locations.length === 0 && seed1) {
    return result('POST_SEED1', 'canonical seed without Company/Locations');
  }
  const company = { ...canonical.company, isActive: true };
  if (sameRows(f.companies, [company]) && sameRows(f.locations, canonicalLocations(canonical))) {
    if (sameRows(f.userRoleScopes, canonical.finalScopes)) return result('EXACT_BASELINE', 'exact baseline');
    if (seed1) return result('POST_BACKFILL', 'backfilled, second seed pending');
  }
  return result('PARTIAL_UNSAFE', 'state is not one the prepare pipeline creates');
}

// Strict, read-only final verification: only the exact prepared baseline passes.
export function verifyLocalTestBaseline(
  facts: unknown,
  canonical: LocalTestCanonicalBaseline,
): { ok: boolean; state: LocalTestBaselineState; issues: string[] } {
  const classification = classifyLocalTestBaseline(facts, canonical);
  return { ok: classification.state === 'EXACT_BASELINE', ...classification };
}

function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) freezeDeep(nested);
    Object.freeze(value);
  }
  return value;
}

// The production canonical descriptor, projected from the single sources:
// CANONICAL_DEMO_SEED (everything seedDemo writes itself), the Production RBAC
// catalog (rows seedDemo synchronizes through syncProductionRbacCatalog) and
// TEST_COMPANY_BOOTSTRAP. `migrations` is supplied by the caller (the reviewed
// pins live in scripts/database/pilot-migrate.mjs). Deeply frozen.
export function defaultLocalTestCanonicalBaseline(migrations: readonly ApprovedMigration[]): LocalTestCanonicalBaseline {
  if (migrations.length === 0) throw new Error('approved migrations are required');
  const seed = CANONICAL_DEMO_SEED;
  // Single-source tripwire: seed.ts's compatibility `branches` must stay a
  // projection of the descriptor, never an independent list.
  if (!sameRows(seedBranches, seed.branches.map(({ code, name, pointOfSaleNumber }) => ({ code, name, pointOfSaleNumber })))) {
    throw new Error('prisma/seed.ts branches no longer match CANONICAL_DEMO_SEED');
  }

  // A catalog row that already exists keeps its id (legacy ADMIN/CASHIER/SELLER);
  // the rest are created at their canonical Production ids.
  const legacyRoleIds = new Map(seed.roles.map((role) => [role.code, role.id]));
  const roleIdFor = (code: RoleCode) => legacyRoleIds.get(code) ?? CANONICAL_ROLE_IDS[code];
  const permissionIds = new Map<string, string>([
    ...seed.permissions.map((p): [string, string] => [p.code, p.id]),
    ...productionPermissionValues.map((code): [string, string] => [code, CANONICAL_PERMISSION_IDS[code]]),
  ]);
  const branchIdByCode = new Map(seed.branches.map((branch) => [branch.code, branch.id]));
  const users = [...seed.users, seed.owner]
    .map((user) => ({ id: user.id, name: user.name, email: user.email, isActive: true, password: 'default' as const }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const scopes = seed.assignments.map((assignment) => ({
    userId: assignment.userId,
    roleId: roleIdFor(assignment.roleCode),
    scopeKind: assignment.scopeKind,
    locationId: assignment.branchCode === null ? null : branchIdByCode.get(assignment.branchCode)!,
  }));

  return freezeDeep({
    migrations: migrations.map(({ name, checksum }) => ({ name, checksum })),
    company: TEST_COMPANY_BOOTSTRAP,
    seeded: {
      branches: seed.branches.map((branch) => ({ ...branch })),
      counters: seed.saleNumberCounters.map((counter) => ({ ...counter })),
      registers: seed.cashRegisters.map((register) => ({ ...register })),
      users,
      roles: [
        ...seed.roles.map(({ id, code, name }) => ({ id, code, name })),
        ...roleCodeValues.filter((code) => !legacyRoleIds.has(code)).map((code) => ({ id: CANONICAL_ROLE_IDS[code], code, name: code })),
      ],
      permissions: [...permissionIds].map(([code, id]) => ({ id, code })),
      rolePermissions: [
        ...seed.roles.flatMap((role) => role.permissionCodes.map((code) => ({ roleId: role.id, permissionId: permissionIds.get(code)! }))),
        ...Object.entries(DEFAULT_ROLE_GRANTS).flatMap(([code, grants]) =>
          grants.map((permission) => ({ roleId: roleIdFor(code as RoleCode), permissionId: permissionIds.get(permission)! })),
        ),
      ],
      userBranchRoles: seed.userBranchRoles.map((row) => ({ ...(row as UserBranchRoleRow) })),
      categories: [{ ...seed.category }],
      brands: [{ ...seed.brand }],
      products: seed.products.map((product) => ({ ...product })),
      variants: seed.variants.map((variant) => ({ ...variant })),
      inventory: seed.inventory.map((row) => ({ ...row })),
    },
    seed1Scopes: scopes.filter((scope) => scope.scopeKind === 'COMPANY'),
    finalScopes: scopes,
  });
}


type SeedDatabase = Parameters<typeof seedDemo>[0];
type BackfillDatabase = Parameters<typeof backfillLocationsFromBranches>[0];
export type LocalTestBaselineDatabase = SeedDatabase & BackfillDatabase;

export type LocalTestBaselineRuntimeDeps = {
  db: LocalTestBaselineDatabase;
  canonical: LocalTestCanonicalBaseline;
  proveIdentity: () => Promise<void>;
  readFacts: (db: LocalTestBaselineDatabase) => Promise<unknown>;
  close: () => Promise<void>;
  seed?: (db: SeedDatabase) => Promise<unknown>;
  backfill?: (db: BackfillDatabase, company: Readonly<CompanyBootstrap>) => Promise<unknown>;
};

export type LocalTestBaselineRuntime = {
  proveIdentity: () => Promise<void>;
  classify: () => Promise<LocalTestBaselineState>;
  seedDemo: () => Promise<void>;
  backfillCompanyLocations: () => Promise<void>;
  verifyBaseline: () => Promise<void>;
  close: () => Promise<void>;
};

// The prepare-facing runtime. It owns nothing it was not given: `close` is the
// caller's release of the proven pool/client, invoked exactly once. Once close
// has been called, every other method refuses without touching a dependency.
export function createLocalTestBaselineRuntime(deps: LocalTestBaselineRuntimeDeps): LocalTestBaselineRuntime {
  if (
    !deps ||
    !deps.db ||
    typeof deps.proveIdentity !== 'function' ||
    typeof deps.readFacts !== 'function' ||
    typeof deps.close !== 'function' ||
    !deps.canonical ||
    deps.canonical.migrations.length === 0
  ) {
    throw new Error('LOCAL_TEST baseline runtime requires db, canonical migrations, proveIdentity, readFacts and close');
  }
  const seed = deps.seed ?? ((db: SeedDatabase) => seedDemo(pinUtcWriterSession(db)));
  const backfill = deps.backfill ?? ((db: BackfillDatabase, company: Readonly<CompanyBootstrap>) => backfillLocationsFromBranches(pinUtcWriterSession(db), company));
  let closing: Promise<void> | null = null;
  const live = () => {
    if (closing) throw new Error('LOCAL_TEST baseline runtime is closed');
  };
  // A dependency signals failure by throwing; an explicit `false` is a failure too.
  const must = (value: unknown, step: string) => {
    if (value === false) throw new Error(`LOCAL_TEST baseline ${step} reported failure`);
  };
  return {
    proveIdentity: async () => {
      live();
      must(await deps.proveIdentity(), 'identity proof');
    },
    classify: async () => {
      live();
      return classifyLocalTestBaseline(await deps.readFacts(deps.db), deps.canonical).state;
    },
    seedDemo: async () => {
      live();
      must(await seed(deps.db), 'seed');
    },
    backfillCompanyLocations: async () => {
      live();
      must(await backfill(deps.db, TEST_COMPANY_BOOTSTRAP), 'backfill');
    },
    verifyBaseline: async () => {
      live();
      const verdict = verifyLocalTestBaseline(await deps.readFacts(deps.db), deps.canonical);
      if (!verdict.ok) {
        throw new Error(`LOCAL_TEST baseline verification failed: state ${verdict.state} (details not shown)`);
      }
    },
    close: () => (closing ??= deps.close()),
  };
}

// ===== R4 transformation contract: seed #2 turns the verified pre-image P into the post-image Q =====
//
// P and Q are the in-memory rows of the protected relations (server-projected text, in contract column order) read by
// the protected transaction; this verifier is the ONLY place the pre-image is consulted, and neither P nor Q ever
// leaves it (a violation carries a fixed rule id and nothing else). The post-image digest F_post attests exactly the Q
// that passed here (verified == witnessed). Categories (R3 TRANSFORMATION-CONTRACT, retained by R4):
//   PRESERVED_FROM_BACKUP   Q == P exactly (OWNER, wholesalePrice, AuditLog incl. jsonb, _prisma_migrations, operational rows)
//   CANONICAL_VALUE         Q == P exactly (already canonical at POST_BACKFILL; seed #2 rewrites identical values)
//   RECREATED_SEMANTIC_SET  RolePermission: the whole row is the key, so set equality is exact equality
//   ROW_CLASS_RULES         User: OWNER preserved; seed users equal except a fresh bcrypt hash of the default password
//   PRESERVED_AND_CREATED   UserRoleScope: P rows preserved by id; exactly the missing canonical scopes created with uuid v4 ids

export const TRANSFORMATION_RULE_IDS = Object.freeze([
  'ROWS_UNAVAILABLE', 'RELATION_SET', 'RELATION_CHANGED', 'ROLE_PERMISSION_SET', 'USER_OWNER', 'USER_SEED', 'USER_OTHER', 'USER_PASSWORD',
  'USER_TIMESTAMP', 'USER_ROLE_SCOPE_PRESERVED', 'USER_ROLE_SCOPE_CREATED', 'USER_ROLE_SCOPE_SET',
] as const);
export type TransformationRuleId = (typeof TRANSFORMATION_RULE_IDS)[number];
export class TransformationViolation extends Error {
  readonly rule: TransformationRuleId;
  constructor(rule: TransformationRuleId) {
    super('transformation contract violated');
    this.rule = rule;
  }
}

const PRESERVED_RELATIONS = new Set([
  'Company', 'Location', 'UserBranchRole', 'AuditLog', 'Sale', 'SaleItem', 'SalePayment', 'CashSession', 'CashMovement', 'StockMovement', 'StockReservation', '_prisma_migrations',
]);
const categoryOf = (relation: string, column: string) => {
  if (relation === 'ProductVariant' && column === 'wholesalePrice') return 'PRESERVED_FROM_BACKUP';
  if (relation === 'RolePermission') return 'RECREATED_SEMANTIC_SET';
  if (relation === 'User') return 'ROW_CLASS_RULES';
  if (relation === 'UserRoleScope') return 'PRESERVED_AND_CREATED';
  return PRESERVED_RELATIONS.has(relation) ? 'PRESERVED_FROM_BACKUP' : 'CANONICAL_VALUE';
};
export const TRANSFORMATION_CATEGORIES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(TYPE_CONTRACT_V3.map((c) => [`${c.relation}.${c.name}`, categoryOf(c.relation, c.name)])),
);
// Bound into every POST witness: which verifier approved Q. It covers the category map and the canonical seed facts the
// rules read (seed users, OWNER identity, final scope assignments, the pinned seed timestamp).
export const TRANSFORMATION_CONTRACT_SHA256 = createHash('sha256')
  .update(JSON.stringify({
    version: 'MONA/V233/TRANSFORMATION/R4',
    categories: TRANSFORMATION_CATEGORIES,
    seedTimestamp: CANONICAL_DEMO_SEED.userTimestamp,
    owner: CANONICAL_DEMO_SEED.owner,
    users: CANONICAL_DEMO_SEED.users,
    assignments: CANONICAL_DEMO_SEED.assignments,
  }))
  .digest('hex');

const TX_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const txColumnIndex = (relation: string, name: string) => TYPE_CONTRACT_V3.filter((c) => c.relation === relation).findIndex((c) => c.name === name);
const txSameRow = (a: readonly CellText[], b: readonly CellText[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const txSameRows = (a: readonly (readonly CellText[])[], b: readonly (readonly CellText[])[]) => a.length === b.length && a.every((row, i) => txSameRow(row, b[i] as readonly CellText[]));
const txRowKey = (row: readonly CellText[]) => JSON.stringify(row);

export async function verifyTransformation(
  pre: StateRows,
  post: StateRows,
  deps: Readonly<{ passwordState?: PasswordStateFn }> = {},
): Promise<void> {
  const fail = (rule: TransformationRuleId): never => {
    throw new TransformationViolation(rule);
  };
  const passwordState = deps.passwordState ?? seedPasswordState;
  if (!(pre instanceof Map) || !(post instanceof Map) || pre.size !== PROTECTED_RELATIONS.length || post.size !== PROTECTED_RELATIONS.length) fail('RELATION_SET');
  const P = (relation: string) => pre.get(relation) ?? fail('RELATION_SET');
  const Q = (relation: string) => post.get(relation) ?? fail('RELATION_SET');
  for (const relation of PROTECTED_RELATIONS) {
    P(relation);
    Q(relation);
  }

  // PRESERVED_FROM_BACKUP and CANONICAL_VALUE relations: identical rows, identical order (both sorted by primary key).
  for (const relation of PROTECTED_RELATIONS) {
    if (relation === 'RolePermission' || relation === 'User' || relation === 'UserRoleScope') continue;
    if (!txSameRows(P(relation), Q(relation))) fail('RELATION_CHANGED');
  }

  // RECREATED_SEMANTIC_SET: the whole row is the primary key, so equality of the row sets is exact.
  const rolePermissionsBefore = new Set(P('RolePermission').map(txRowKey));
  const rolePermissionsAfter = new Set(Q('RolePermission').map(txRowKey));
  if (rolePermissionsBefore.size !== rolePermissionsAfter.size || [...rolePermissionsBefore].some((k) => !rolePermissionsAfter.has(k))) fail('ROLE_PERMISSION_SET');

  // ROW_CLASS_RULES (User)
  const id = txColumnIndex('User', 'id');
  const email = txColumnIndex('User', 'email');
  const hash = txColumnIndex('User', 'passwordHash');
  const createdAt = txColumnIndex('User', 'createdAt');
  const updatedAt = txColumnIndex('User', 'updatedAt');
  const seedTimestamp = String(Date.parse(CANONICAL_DEMO_SEED.userTimestamp) * 1000);
  const seedEmails = new Set(CANONICAL_DEMO_SEED.users.map((u) => u.email));
  const usersAfter = new Map(Q('User').map((r) => [r[id] as string, r]));
  const usersBefore = P('User');
  if (usersAfter.size !== Q('User').length || usersAfter.size !== usersBefore.length) fail('USER_OTHER');
  if (!usersBefore.some((r) => r[email] === CANONICAL_DEMO_SEED.owner.email)) fail('USER_OWNER');
  for (const before of usersBefore) {
    const after = usersAfter.get(before[id] as string);
    const who = before[email] === CANONICAL_DEMO_SEED.owner.email ? 'USER_OWNER' : seedEmails.has(before[email] as string) ? 'USER_SEED' : 'USER_OTHER';
    if (!after) return fail(who);
    if (who === 'USER_SEED') {
      if (after[createdAt] !== before[createdAt] || after[updatedAt] !== before[updatedAt] || after[createdAt] !== seedTimestamp || after[updatedAt] !== seedTimestamp) fail('USER_TIMESTAMP');
      if (!before.every((v, i) => i === hash || v === after[i])) fail('USER_SEED');
      if ((await passwordState(after[hash] as string)) !== 'default') fail('USER_PASSWORD');
    } else if (!txSameRow(before, after)) {
      fail(who);
    }
  }

  // PRESERVED_AND_CREATED (UserRoleScope)
  const sid = txColumnIndex('UserRoleScope', 'id');
  const suser = txColumnIndex('UserRoleScope', 'userId');
  const srole = txColumnIndex('UserRoleScope', 'roleId');
  const skind = txColumnIndex('UserRoleScope', 'scopeKind');
  const sloc = txColumnIndex('UserRoleScope', 'locationId');
  const content = (r: readonly CellText[]) => JSON.stringify([r[suser], r[srole], r[skind], r[sloc]]);
  const scopesBefore = P('UserRoleScope');
  const scopesAfter = Q('UserRoleScope');
  const afterById = new Map(scopesAfter.map((r) => [r[sid] as string, r]));
  if (afterById.size !== scopesAfter.length) fail('USER_ROLE_SCOPE_SET');
  for (const before of scopesBefore) {
    const after = afterById.get(before[sid] as string);
    if (!after || !txSameRow(before, after)) fail('USER_ROLE_SCOPE_PRESERVED');
  }
  const roleIdByCode = new Map(Q('Role').map((r) => [r[txColumnIndex('Role', 'code')] as string, r[txColumnIndex('Role', 'id')] as string]));
  const locationIdByCode = new Map(Q('Location').map((r) => [r[txColumnIndex('Location', 'code')] as string, r[txColumnIndex('Location', 'id')] as string]));
  const hasLocations = locationIdByCode.size > 0;
  const expected = new Set<string>();
  for (const a of CANONICAL_DEMO_SEED.assignments) {
    const roleId = roleIdByCode.get(a.roleCode);
    if (roleId === undefined) return fail('USER_ROLE_SCOPE_SET');
    if (a.scopeKind === 'COMPANY') expected.add(JSON.stringify([a.userId, roleId, 'COMPANY', null]));
    else if (hasLocations) {
      const locationId = locationIdByCode.get(a.branchCode as string);
      if (locationId === undefined) return fail('USER_ROLE_SCOPE_SET');
      expected.add(JSON.stringify([a.userId, roleId, 'LOCATION', locationId]));
    }
  }
  const preservedIds = new Set(scopesBefore.map((r) => r[sid] as string));
  const preservedContent = new Set(scopesBefore.map(content));
  const created = scopesAfter.filter((r) => !preservedIds.has(r[sid] as string));
  const createdIds = created.map((r) => r[sid] as string);
  const missing = [...expected].filter((k) => !preservedContent.has(k)).sort();
  // exactly the missing canonical scopes are created (as a multiset: no extra, no duplicate), with distinct uuid v4 ids
  if (
    JSON.stringify(created.map(content).sort()) !== JSON.stringify(missing) ||
    createdIds.some((v) => typeof v !== 'string' || !TX_UUID_V4.test(v)) ||
    new Set(createdIds).size !== createdIds.length
  ) {
    fail('USER_ROLE_SCOPE_CREATED');
  }
  // backstop: the final content is exactly the canonical assignment set, once each
  const afterContent = scopesAfter.map(content);
  if (new Set(afterContent).size !== afterContent.length || afterContent.length !== expected.size || afterContent.some((k) => !expected.has(k))) fail('USER_ROLE_SCOPE_SET');
}

// --- Facts reader --------------------------------------------------------------------------
//
// Maps the live LOCAL_TEST database into LocalTestBaselineFacts. READ only:
// every relevant table is read in full (never filtered to canonical rows, so a
// foreign row stays visible to the classifier), rows are projected to the facts
// fields with explicit selects, duplicates are preserved, bigints stay bigints,
// and passwordHash is read only to derive the semantic password state. The
// reader never selects a target, never writes and never closes the caller's
// client. Missing or partial application schema is a structural state
// (FRESH-compatible or unreadable), not an exception.

// Every application table (Prisma model name == table name; no @@map in the
// schema). All must exist before any model delegate is queried.
export const APPLICATION_TABLES = Object.freeze([
  'Company',
  'Location',
  'User',
  'Role',
  'Permission',
  'RolePermission',
  'UserRoleScope',
  'Branch',
  'UserBranchRole',
  'Category',
  'Brand',
  'Product',
  'ProductVariant',
  'Inventory',
  'StockMovement',
  'StockReservation',
  'Sale',
  'SaleItem',
  'SalePayment',
  'CashRegister',
  'CashSession',
  'CashMovement',
  'AuditLog',
  'SaleNumberCounter',
] as const);

// Not facts: the classifier maps anything that is not well-formed facts to UNKNOWN.
export type LocalTestBaselineUnreadable = { unreadable: string };
export type PasswordStateFn = (passwordHash: string) => Promise<PasswordState>;
export type LocalTestBaselineReadDatabase = Pick<
  PrismaClient,
  | '$transaction'
  | '$queryRaw'
  | 'company'
  | 'location'
  | 'user'
  | 'role'
  | 'permission'
  | 'rolePermission'
  | 'userRoleScope'
  | 'branch'
  | 'userBranchRole'
  | 'category'
  | 'brand'
  | 'product'
  | 'productVariant'
  | 'inventory'
  | 'stockMovement'
  | 'stockReservation'
  | 'sale'
  | 'saleItem'
  | 'salePayment'
  | 'cashRegister'
  | 'cashSession'
  | 'cashMovement'
  | 'auditLog'
  | 'saleNumberCounter'
>;

// Stored bcrypt format ($2a/$2b/$2y, cost 04–31, 22-char salt + 31-char hash).
const BCRYPT_HASH = /^\$2[aby]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

// The seed's own default password (prisma/seed.ts resolveSeedPassword(), no
// environment involved) against a stored hash. Anything that is not a bcrypt
// hash is `invalid` (bcryptjs.compare would merely answer false for it).
export async function seedPasswordState(passwordHash: string): Promise<PasswordState> {
  if (typeof passwordHash !== 'string' || !BCRYPT_HASH.test(passwordHash)) return 'invalid';
  return (await compare(resolveSeedPassword(), passwordHash)) ? 'default' : 'other';
}

type RawRow = Record<string, unknown>;
const READ_FAILURE = 'LOCAL_TEST baseline facts could not be read (details not shown)';
const unreadable = (reason: string): LocalTestBaselineUnreadable => ({ unreadable: reason });

// Strict: exactly one row, one boolean per probed table, nothing coerced.
function tablePresence(rows: unknown): Record<string, boolean> | null {
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) return null;
  const row = rows[0];
  const presence: Record<string, boolean> = {};
  for (const table of [...APPLICATION_TABLES, '_prisma_migrations']) {
    const value = row[table];
    if (typeof value !== 'boolean') return null;
    presence[table] = value;
  }
  return presence;
}

// The transaction options are a client-side request. Before any schema or
// business facts are trusted, require PostgreSQL itself to confirm the exact
// snapshot semantics requested for this read.
function transactionSettingsAreCanonical(rows: unknown): boolean {
  if (!Array.isArray(rows) || rows.length !== 1 || !isRecord(rows[0])) return false;
  const row = rows[0];
  return (
    Object.hasOwn(row, 'transaction_isolation') &&
    Object.hasOwn(row, 'transaction_read_only') &&
    row.transaction_isolation === 'repeatable read' &&
    row.transaction_read_only === 'on'
  );
}

// Strict: each history row must already carry the exact types; never coerced.
function migrationRows(rows: unknown): MigrationRow[] | null {
  if (!Array.isArray(rows)) return null;
  const mapped: MigrationRow[] = [];
  for (const row of rows) {
    if (
      !isRecord(row) ||
      typeof row.name !== 'string' ||
      typeof row.checksum !== 'string' ||
      typeof row.finished !== 'boolean' ||
      typeof row.rolledBack !== 'boolean'
    ) {
      return null;
    }
    mapped.push({ name: row.name, checksum: row.checksum, finished: row.finished, rolledBack: row.rolledBack });
  }
  return mapped;
}

type Snapshot =
  | { kind: 'unreadable'; reason: string }
  | { kind: 'fresh'; rows: MigrationRow[] }
  | {
      kind: 'schema';
      rows: MigrationRow[];
      operational: Record<OperationalModel, number>;
      users: { id: string; name: string; email: string; isActive: boolean; passwordHash: string }[];
      seeded: Omit<SeededRows, 'users'>;
      companies: CompanyRow[];
      locations: LocationRow[];
      userRoleScopes: ScopeRow[];
    };

// Every database read happens inside ONE interactive REPEATABLE READ
// transaction that first makes itself read-only, so every fact comes from the
// same snapshot. Presence is probed before any model query: all 24 application
// tables → read; none → FRESH-compatible (history only); some → unreadable.
async function readSnapshot(db: LocalTestBaselineReadDatabase): Promise<Snapshot> {
  return db.$transaction(
    async (tx): Promise<Snapshot> => {
      await tx.$queryRaw`SELECT set_config('transaction_read_only', 'on', true)`;
      const settings = await tx.$queryRaw<RawRow[]>`SELECT current_setting('transaction_isolation') AS transaction_isolation, current_setting('transaction_read_only') AS transaction_read_only`;
      if (!transactionSettingsAreCanonical(settings)) {
        throw new Error('LOCAL_TEST transaction settings are not canonical');
      }
      return readSnapshotOnTransaction(tx);
    },
    { isolationLevel: 'RepeatableRead', maxWait: 10000, timeout: 30000 },
  );
}

// The snapshot reads proper, on a transaction the CALLER owns (isolation, read-only-ness, search_path and locks are the
// caller's: the protected resume transaction proves them itself). Issues SELECT/model reads only.
type SnapshotTx = Omit<LocalTestBaselineReadDatabase, '$transaction'>;
async function readSnapshotOnTransaction(tx: SnapshotTx): Promise<Snapshot> {
  const presence = tablePresence(
    await tx.$queryRaw<RawRow[]>`SELECT
to_regclass('public."Company"') IS NOT NULL AS "Company",
to_regclass('public."Location"') IS NOT NULL AS "Location",
to_regclass('public."User"') IS NOT NULL AS "User",
to_regclass('public."Role"') IS NOT NULL AS "Role",
to_regclass('public."Permission"') IS NOT NULL AS "Permission",
to_regclass('public."RolePermission"') IS NOT NULL AS "RolePermission",
to_regclass('public."UserRoleScope"') IS NOT NULL AS "UserRoleScope",
to_regclass('public."Branch"') IS NOT NULL AS "Branch",
to_regclass('public."UserBranchRole"') IS NOT NULL AS "UserBranchRole",
to_regclass('public."Category"') IS NOT NULL AS "Category",
to_regclass('public."Brand"') IS NOT NULL AS "Brand",
to_regclass('public."Product"') IS NOT NULL AS "Product",
to_regclass('public."ProductVariant"') IS NOT NULL AS "ProductVariant",
to_regclass('public."Inventory"') IS NOT NULL AS "Inventory",
to_regclass('public."StockMovement"') IS NOT NULL AS "StockMovement",
to_regclass('public."StockReservation"') IS NOT NULL AS "StockReservation",
to_regclass('public."Sale"') IS NOT NULL AS "Sale",
to_regclass('public."SaleItem"') IS NOT NULL AS "SaleItem",
to_regclass('public."SalePayment"') IS NOT NULL AS "SalePayment",
to_regclass('public."CashRegister"') IS NOT NULL AS "CashRegister",
to_regclass('public."CashSession"') IS NOT NULL AS "CashSession",
to_regclass('public."CashMovement"') IS NOT NULL AS "CashMovement",
to_regclass('public."AuditLog"') IS NOT NULL AS "AuditLog",
to_regclass('public."SaleNumberCounter"') IS NOT NULL AS "SaleNumberCounter",
to_regclass('public._prisma_migrations') IS NOT NULL AS "_prisma_migrations"`,
  );
  if (!presence) return { kind: 'unreadable', reason: 'schema presence probe returned an unexpected shape' };
  const presentCount = APPLICATION_TABLES.filter((table) => presence[table]).length;
  if (presentCount > 0 && presentCount < APPLICATION_TABLES.length) {
    return { kind: 'unreadable', reason: 'partial application schema' };
  }
  const rows = presence._prisma_migrations
    ? migrationRows(
        await tx.$queryRaw<RawRow[]>`SELECT migration_name AS name, checksum,
        finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS "rolledBack"
        FROM public._prisma_migrations ORDER BY started_at ASC, migration_name ASC, id ASC`,
      )
    : [];
  if (!rows) return { kind: 'unreadable', reason: 'migration history row has an unexpected shape' };
  if (presentCount === 0) return { kind: 'fresh', rows };

  const operational: Record<OperationalModel, number> = {
    sale: await tx.sale.count(),
    saleItem: await tx.saleItem.count(),
    salePayment: await tx.salePayment.count(),
    cashSession: await tx.cashSession.count(),
    cashMovement: await tx.cashMovement.count(),
    stockMovement: await tx.stockMovement.count(),
    stockReservation: await tx.stockReservation.count(),
    auditLog: await tx.auditLog.count(),
  };
  const users = await tx.user.findMany({
    select: { id: true, name: true, email: true, isActive: true, passwordHash: true },
    orderBy: { id: 'asc' },
  });
  const seeded: Omit<SeededRows, 'users'> = {
    branches: await tx.branch.findMany({
      select: { id: true, code: true, name: true, address: true, pointOfSaleNumber: true },
      orderBy: { id: 'asc' },
    }),
    counters: await tx.saleNumberCounter.findMany({ select: { id: true, branchId: true, nextValue: true }, orderBy: { id: 'asc' } }),
    registers: await tx.cashRegister.findMany({ select: { id: true, branchId: true, name: true }, orderBy: { id: 'asc' } }),
    roles: await tx.role.findMany({ select: { id: true, code: true, name: true }, orderBy: { id: 'asc' } }),
    permissions: await tx.permission.findMany({ select: { id: true, code: true }, orderBy: { id: 'asc' } }),
    rolePermissions: await tx.rolePermission.findMany({
      select: { roleId: true, permissionId: true },
      orderBy: [{ roleId: 'asc' }, { permissionId: 'asc' }],
    }),
    userBranchRoles: await tx.userBranchRole.findMany({ select: { userId: true, branchId: true, roleId: true }, orderBy: { id: 'asc' } }),
    categories: await tx.category.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } }),
    brands: await tx.brand.findMany({ select: { id: true, name: true }, orderBy: { id: 'asc' } }),
    products: await tx.product.findMany({
      select: { id: true, name: true, slug: true, description: true, categoryId: true, brandId: true, isActive: true },
      orderBy: { id: 'asc' },
    }),
    variants: await tx.productVariant.findMany({
      select: { id: true, productId: true, sku: true, barcode: true, color: true, size: true, price: true, costPrice: true, isActive: true },
      orderBy: { id: 'asc' },
    }),
    inventory: await tx.inventory.findMany({
      select: { id: true, variantId: true, branchId: true, physical: true, reserved: true },
      orderBy: { id: 'asc' },
    }),
  };
  const companies = await tx.company.findMany({
    select: { id: true, name: true, cuit: true, address: true, isActive: true },
    orderBy: { id: 'asc' },
  });
  const locations = await tx.location.findMany({
    select: { id: true, companyId: true, code: true, name: true, type: true, address: true, pointOfSaleNumber: true, isActive: true },
    orderBy: { id: 'asc' },
  });
  const userRoleScopes = await tx.userRoleScope.findMany({
    select: { userId: true, roleId: true, scopeKind: true, locationId: true },
    orderBy: { id: 'asc' },
  });
  return { kind: 'schema', rows, operational, users, seeded, companies, locations, userRoleScopes };
}

export async function readLocalTestBaselineFacts(
  db: LocalTestBaselineReadDatabase,
  options: { passwordState?: PasswordStateFn } = {},
): Promise<LocalTestBaselineFacts | LocalTestBaselineUnreadable> {
  let snapshot: Snapshot;
  try {
    snapshot = await readSnapshot(db);
  } catch {
    // Infrastructure failure is not database state: a fixed error, no cause.
    throw new Error(READ_FAILURE);
  }
  return factsFromSnapshot(snapshot, options.passwordState ?? seedPasswordState);
}

// R4: the same facts read on a SUPPLIED (protected) transaction — it opens no transaction of its own, issues no set_config
// and does not probe settings (the owner proved them). Infrastructure failure is the same constant error.
export async function readFactsOnTransaction(
  tx: ProtectedTx,
  options: { passwordState?: PasswordStateFn } = {},
): Promise<LocalTestBaselineFacts | LocalTestBaselineUnreadable> {
  let snapshot: Snapshot;
  try {
    snapshot = await readSnapshotOnTransaction(tx);
  } catch {
    throw new Error(READ_FAILURE);
  }
  return factsFromSnapshot(snapshot, options.passwordState ?? seedPasswordState);
}

async function factsFromSnapshot(snapshot: Snapshot, passwordState: PasswordStateFn): Promise<LocalTestBaselineFacts | LocalTestBaselineUnreadable> {
  if (snapshot.kind === 'unreadable') return unreadable(snapshot.reason);
  if (snapshot.kind === 'fresh') {
    return {
      migration: { schemaPresent: false, rows: snapshot.rows },
      operational: Object.fromEntries(OPERATIONAL_MODELS.map((model) => [model, 0])) as Record<OperationalModel, number>,
      seeded: Object.fromEntries(SEEDED_TABLES.map((table) => [table, []])) as unknown as SeededRows,
      companies: [],
      locations: [],
      userRoleScopes: [],
    };
  }
  // CPU-only, after the snapshot closed: the hashes all come from that snapshot.
  // A comparator failure marks that one user invalid; nothing about it escapes.
  const users: UserRow[] = [];
  for (const user of snapshot.users) {
    let password: PasswordState;
    try {
      password = await passwordState(user.passwordHash);
    } catch {
      password = 'invalid';
    }
    users.push({ id: user.id, name: user.name, email: user.email, isActive: user.isActive, password });
  }
  return {
    migration: { schemaPresent: true, rows: snapshot.rows },
    operational: snapshot.operational,
    seeded: { ...snapshot.seeded, users },
    companies: snapshot.companies,
    locations: snapshot.locations,
    userRoleScopes: snapshot.userRoleScopes,
  };
}
