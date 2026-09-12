import type { PrismaClient } from '../../generated/prisma/client.js';
import { DEFAULT_ROLE_GRANTS } from './role-permission-matrix.js';
import { productionPermissionValues, type ProductionPermission } from './permissions.js';
import { ROLE_CODES, roleCodeValues, type RoleCode } from './roles.js';

type RoleDelegate = Pick<PrismaClient, 'role'>;
type PermissionDelegate = Pick<PrismaClient, 'permission'>;
type RolePermissionDelegate = Pick<PrismaClient, 'rolePermission'>;
type RbacCatalogDatabase = Pick<PrismaClient, 'role' | 'permission' | 'rolePermission'>;
type CatalogDatabase = Pick<PrismaClient, 'role' | 'permission' | 'rolePermission' | '$transaction'>;

// Canonical, permanent ids for the Production catalog rows this module may
// create fresh. Hand-assigned per code (never derived from array/object
// iteration order, so inserting a new permission later can never shift an
// already-assigned id), in the same namespaced-uuid-shape convention as
// prisma/seed.ts's `id()` helper (namespace 8000) and
// organization.service.ts's bootstrap ids (namespaces 9000-9200) — distinct
// namespaces 9300 (roles) / 9400 (permissions) here.
//
// Used ONLY when a row does not already exist (see ensureProductionRoleCatalog
// / ensureProductionPermissionCatalog below) — an already-persisted row (e.g.
// legacy ADMIN/CASHIER/SELLER, or an OWNER/WAREHOUSE/Permission row created
// before this map existed) always keeps its current id. This exists because
// Prisma's `@default(uuid())` produced a fresh random id on every create,
// which silently broke this repository's deterministic-seed contract
// (prisma/seed.ts, tests/seed.test.ts): a clean starting state must always
// produce the same authoritative ids, not a new random one per reset. ADMIN/
// CASHIER/SELLER get an entry too even though Phase 1B's demo/test data never
// exercises it (those three always already exist via the legacy seed) — a
// genuinely fresh Production bootstrap with no prior Demo V2 data still needs
// a deterministic id for every role.
const canonicalId = (namespace: number, n: number) =>
  `00000000-0000-4000-${namespace}-${String(n).padStart(12, '0')}`;

export const CANONICAL_ROLE_IDS: Record<RoleCode, string> = {
  OWNER: canonicalId(9300, 1),
  ADMIN: canonicalId(9300, 2),
  CASHIER: canonicalId(9300, 3),
  SELLER: canonicalId(9300, 4),
  WAREHOUSE: canonicalId(9300, 5),
};

export const CANONICAL_PERMISSION_IDS: Record<ProductionPermission, string> = {
  PRICE_MANAGE: canonicalId(9400, 1),
  GOODS_RECEIPT_MANAGE: canonicalId(9400, 2),
  PRODUCT_MANAGE: canonicalId(9400, 3),
  PRODUCT_VARIANT_MANAGE: canonicalId(9400, 4),
  LABEL_PRINT: canonicalId(9400, 5),
  IMPORT_RUN: canonicalId(9400, 6),
  TRANSFER_RESOLVE: canonicalId(9400, 7),
  SENA_SETTLE: canonicalId(9400, 8),
  SALE_CREATE: canonicalId(9400, 9),
  SALE_CHARGE: canonicalId(9400, 10),
  SALE_COMPLETE: canonicalId(9400, 11),
  SALE_VIEW: canonicalId(9400, 12),
  SALE_QUEUE_VIEW: canonicalId(9400, 13),
  INVENTORY_VIEW: canonicalId(9400, 14),
  INVENTORY_MANAGE: canonicalId(9400, 15),
  CASH_SESSION_OPEN: canonicalId(9400, 16),
  CASH_SESSION_CLOSE: canonicalId(9400, 17),
  USER_MANAGE: canonicalId(9400, 18),
  REPORT_VIEW: canonicalId(9400, 19),
  AUDIT_VIEW: canonicalId(9400, 20),
  SUPPLIER_MANAGE: canonicalId(9400, 21),
  TRANSFER_REQUEST: canonicalId(9400, 22),
  TRANSFER_VIEW: canonicalId(9400, 23),
  TRANSFER_APPROVE: canonicalId(9400, 24),
  TRANSFER_PREPARE: canonicalId(9400, 25),
  TRANSFER_DISPATCH: canonicalId(9400, 26),
  TRANSFER_RECEIVE: canonicalId(9400, 27),
  EXCHANGE_MANAGE: canonicalId(9400, 28),
  PUBLICATION_CHECKOUT: canonicalId(9400, 29),
  PUBLICATION_RETURN: canonicalId(9400, 30),
  SENA_CREATE: canonicalId(9400, 31),
  SENA_MANAGE: canonicalId(9400, 32),
  PRODUCT_IMAGE_MANAGE: canonicalId(9400, 33),
};

// Phase 1B (Production V1): additive Production RBAC catalog bootstrap.
// docs/production-v1/03-role-permission-matrix.md states the Role/Permission
// tables as the storage for these exact codes ("Roles are stored in the
// `Role` table... Permission names... are stored in the `Permission`
// table"), and docs/production-v1/08-implementation-roadmap.md's Phase 1C is
// scoped *only* to UserBranchRole -> UserRoleScope assignment migration and
// authorization switching — it never mentions Role/Permission catalog
// creation. Catalog persistence (this file) is therefore Phase 1B's
// responsibility; assignment migration (which user has which role/scope)
// stays Phase 1C's.
//
// This never touches `MANAGER`, the legacy lowercase Permission codes, or any
// `UserBranchRole` row — see catalog.service coexistence tests. `Role`/
// `Permission` are looked up by their natural unique key (`code`) and created
// only if absent, so this is idempotent and safe to rerun; nothing here
// deletes or renames an existing row.

// ADD-if-absent for each Production role code. An existing Role row is reused
// only if it already matches (`name === code`, the existing Demo V2
// convention — see prisma/seed.ts). A mismatch means an unexpected existing
// row occupies that code; this fails closed rather than silently overwriting
// it, the same convention organization.service.ts's ensureCompany already
// uses for Company. New rows (OWNER, WAREHOUSE) get a generated uuid
// (`Role.id`'s Prisma default) — never a hardcoded demo-style id — so this
// function has no demo-specific constants and is reusable for a future
// controlled production bootstrap unchanged.
//
// Batched (findMany -> createMany -> findMany, 3 round trips regardless of
// role count) rather than one findUnique/create pair per code: run inside a
// single interactive transaction over a real hosted-Postgres connection
// (Supabase pooler latency), 5 sequential round-trip pairs plus 33 more for
// permissions blew past Prisma's default 5s interactive-transaction timeout.
export async function ensureProductionRoleCatalog(
  db: RoleDelegate,
): Promise<Record<RoleCode, string>> {
  const existing = await db.role.findMany({ where: { code: { in: roleCodeValues } } });
  const existingByCode = new Map(existing.map((role) => [role.code, role]));
  for (const code of roleCodeValues) {
    const found = existingByCode.get(code);
    if (found && found.name !== code) {
      throw new Error(
        `Role ${code} already exists but its name ("${found.name}") does not match the ` +
          `expected Production name ("${code}"); refusing to silently overwrite an unexpected ` +
          `existing Role row`,
      );
    }
  }
  const missing = roleCodeValues.filter((code) => !existingByCode.has(code));
  if (missing.length > 0) {
    await db.role.createMany({
      data: missing.map((code) => ({ id: CANONICAL_ROLE_IDS[code], code, name: code })),
      skipDuplicates: true,
    });
  }
  const all = await db.role.findMany({ where: { code: { in: roleCodeValues } } });
  const ids = {} as Record<RoleCode, string>;
  for (const role of all) ids[role.code as RoleCode] = role.id;
  return ids;
}

// ADD-if-absent for each of the 33 Production permission codes. These are
// new, distinct string values from every legacy lowercase-dot Demo V2
// permission code, so no collision with existing Permission rows is possible;
// nothing here can shadow or conflict with a legacy code. Batched for the
// same round-trip/timeout reason as ensureProductionRoleCatalog above.
export async function ensureProductionPermissionCatalog(
  db: PermissionDelegate,
): Promise<Record<ProductionPermission, string>> {
  const existing = await db.permission.findMany({
    where: { code: { in: productionPermissionValues } },
  });
  const existingCodes = new Set(existing.map((permission) => permission.code));
  const missing = productionPermissionValues.filter((code) => !existingCodes.has(code));
  if (missing.length > 0) {
    await db.permission.createMany({
      data: missing.map((code) => ({ id: CANONICAL_PERMISSION_IDS[code], code })),
      skipDuplicates: true,
    });
  }
  const all = await db.permission.findMany({
    where: { code: { in: productionPermissionValues } },
  });
  const ids = {} as Record<ProductionPermission, string>;
  for (const permission of all) ids[permission.code as ProductionPermission] = permission.id;
  return ids;
}

// Persists exactly role-permission-matrix.ts's DEFAULT_ROLE_GRANTS (SELLER,
// CASHIER, WAREHOUSE, ADMIN — OWNER has no entry there and gets no rows here,
// by design: "OWNER is special... do not rely on RolePermission rows as the
// source of OWNER authority"). `roleIds`/`permissionIds` may include
// production ADMIN mapped to the *same* Role.id as its existing legacy
// grants (ensureProductionRoleCatalog reuses that row) — `createMany` with
// `skipDuplicates` only ever adds the (roleId, productionPermissionId) pairs
// that don't already exist, so this never touches ADMIN's existing legacy
// (roleId, legacyPermissionId) rows and is idempotent on rerun.
export async function ensureProductionRolePermissions(
  db: RolePermissionDelegate,
  roleIds: Record<RoleCode, string>,
  permissionIds: Record<ProductionPermission, string>,
): Promise<{ grantCount: number }> {
  const data = Object.entries(DEFAULT_ROLE_GRANTS).flatMap(([roleCode, grants]) =>
    grants.map((permissionCode) => ({
      roleId: roleIds[roleCode as RoleCode],
      permissionId: permissionIds[permissionCode],
    })),
  );
  await db.rolePermission.createMany({ data, skipDuplicates: true });
  return { grantCount: data.length };
}

// Core sync operation, usable on an existing transaction client — no
// `$transaction` of its own. This is what prisma/seed.ts's populate() calls
// directly on its own already-open transaction (120s timeout, already
// covering the legacy Demo V2 population) so that a successful seed/reset can
// never commit a legacy-only RBAC state: never a second, nested interactive
// transaction, and never a fresh round-trip-heavy implementation (this reuses
// the same batched ensure* functions already proven not to hit Prisma's 5s
// default interactive-transaction timeout).
export async function syncProductionRbacCatalog(db: RbacCatalogDatabase) {
  const roleIds = await ensureProductionRoleCatalog(db);
  const permissionIds = await ensureProductionPermissionCatalog(db);
  const grants = await ensureProductionRolePermissions(db, roleIds, permissionIds);
  return { roleIds, permissionIds, rolePermissionGrantCount: grants.grantCount };
}

// Standalone entry point (the `db:bootstrap-rbac-catalog` CLI, or any other
// caller without an existing transaction): opens its own transaction around
// syncProductionRbacCatalog so catalog rows and their grants either all land
// or none do. Never creates or touches a UserRoleScope row — assignment is
// Phase 1C.
export async function bootstrapProductionRbacCatalog(db: CatalogDatabase) {
  return db.$transaction((tx) => syncProductionRbacCatalog(tx));
}

// VERIFY step, independent of trusting the sync/bootstrap's own return value.
export async function verifyProductionRbacCatalog(db: RbacCatalogDatabase) {
  const issues: string[] = [];

  const roles = await db.role.findMany({ where: { code: { in: roleCodeValues } } });
  const roleByCode = new Map(roles.map((role) => [role.code, role]));
  for (const code of roleCodeValues) {
    if (!roleByCode.has(code)) issues.push(`missing Production Role ${code}`);
  }

  const permissions = await db.permission.findMany({
    where: { code: { in: productionPermissionValues } },
  });
  const permissionByCode = new Map(permissions.map((permission) => [permission.code, permission]));
  for (const code of productionPermissionValues) {
    if (!permissionByCode.has(code)) issues.push(`missing Production Permission ${code}`);
  }

  const ownerRole = roleByCode.get(ROLE_CODES.OWNER);
  if (ownerRole) {
    const productionPermissionIds = permissions.map((permission) => permission.id);
    const ownerGrantCount = await db.rolePermission.count({
      where: { roleId: ownerRole.id, permissionId: { in: productionPermissionIds } },
    });
    if (ownerGrantCount > 0) {
      issues.push(
        `OWNER has ${ownerGrantCount} unexpected Production RolePermission row(s); OWNER ` +
          `authority must remain implicit, never RolePermission-backed`,
      );
    }
  }

  for (const [roleCode, grants] of Object.entries(DEFAULT_ROLE_GRANTS)) {
    const role = roleByCode.get(roleCode as RoleCode);
    if (!role) continue; // already reported as missing above
    const expectedPermissionIds = grants
      .map((code) => permissionByCode.get(code)?.id)
      .filter((id): id is string => Boolean(id));
    const actualCount = await db.rolePermission.count({
      where: { roleId: role.id, permissionId: { in: expectedPermissionIds } },
    });
    if (actualCount !== grants.length) {
      issues.push(
        `${roleCode}: expected ${grants.length} Production RolePermission grant(s), found ${actualCount}`,
      );
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    roleCount: roles.length,
    permissionCount: permissions.length,
  };
}
