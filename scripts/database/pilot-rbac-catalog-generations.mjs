// RBAC catalog GENERATIONS after the G11 -> G14 cut-over (sale void v1). A separate module on purpose:
// pilot-rbac-catalog.mjs (CATALOG_35 / CATALOG_36, pinned BYTE FOR BYTE by the four PILOT tool manifests) is
// not modified, so every cut-over tool keeps its exact catalog contract. This module adds the LATEST catalog
// and a classifier that knows all three. Builtins only (node:crypto), no I/O.
//
//   CATALOG_37 — the LATEST canonical catalog: CATALOG_36 + SALE_VOID (canonical id 9400/37) + exactly one
//                default grant (ADMIN): 5 roles, 37 permissions, 76 grants. OWNER keeps no grants (implicit
//                authority); CASHIER, SELLER and WAREHOUSE never get it.
//   CATALOG_36 — HISTORICAL (the cut-over tools' catalog), CATALOG_35 — older; both reused from the base module.
//
// A catalog is the COMPLETE content of "Role", "Permission" and "RolePermission", exactly like the base module:
// any extra, missing, duplicate or foreign row, or a partial transition, is unclassified. The digest format is the
// base module's (mona-rbac-catalog/v1) so the 35 and 36 digests here are provably the base ones (tested).
import { createHash } from 'node:crypto';
import { CATALOG_35, CATALOG_36 } from './pilot-rbac-catalog.mjs';

const SALE_VOID_PERMISSION = Object.freeze(['SALE_VOID', '00000000-0000-4000-9400-000000000037']);
const SALE_VOID_GRANT = Object.freeze(['ADMIN', 'SALE_VOID']);

// Rows keep the base module's sorted order (default array sort on [code, id] / [role, code]).
export const CATALOG_37 = Object.freeze({
  roles: CATALOG_36.roles,
  permissions: Object.freeze([...CATALOG_36.permissions, SALE_VOID_PERMISSION].sort()),
  grants: Object.freeze([...CATALOG_36.grants, SALE_VOID_GRANT].sort()),
});
// What a future OWNER-only 36 -> 37 transition adds to an exact CATALOG_36, and nothing else. NOT executed anywhere here.
export const UPGRADE_DELTA_37 = Object.freeze({ permission: SALE_VOID_PERMISSION, grants: Object.freeze([SALE_VOID_GRANT]) });

export const LATEST_CATALOG = 'CATALOG_37';
export const HISTORICAL_CATALOGS = Object.freeze(['CATALOG_35', 'CATALOG_36']);

function serialize({ roles, permissions, grants }) {
  const lines = [
    ...roles.map((r) => `R ${r.id} ${r.code}`),
    ...permissions.map((p) => `P ${p.id} ${p.code}`),
    ...grants.map((g) => `G ${g.roleId} ${g.permissionId}`),
  ];
  return lines.sort().join('\n');
}
const digest = (rows) => createHash('sha256').update(`mona-rbac-catalog/v1\n${serialize(rows)}`).digest('hex');
function rowsOf(def) {
  const roleId = new Map(def.roles.map(([code, id]) => [code, id]));
  const permId = new Map(def.permissions.map(([code, id]) => [code, id]));
  return {
    roles: def.roles.map(([code, id]) => ({ id, code })),
    permissions: def.permissions.map(([code, id]) => ({ id, code })),
    grants: def.grants.map(([role, perm]) => ({ roleId: roleId.get(role), permissionId: permId.get(perm) })),
  };
}
export const CATALOG_GENERATION_DIGESTS = Object.freeze({
  CATALOG_35: digest(rowsOf(CATALOG_35)),
  CATALOG_36: digest(rowsOf(CATALOG_36)),
  CATALOG_37: digest(rowsOf(CATALOG_37)),
});

const isStr = (v) => typeof v === 'string' && v.length > 0;
// Exactly CATALOG_35, CATALOG_36 or CATALOG_37 (same rows, no duplicates), else unclassified. Never throws.
export function classifyCatalogGeneration(rows) {
  const none = (reason) => ({ ok: false, catalog: null, reason });
  try {
    if (rows === null || typeof rows !== 'object') return none('the RBAC catalog could not be read');
    const { roles, permissions, grants } = rows;
    if (![roles, permissions, grants].every(Array.isArray)) return none('the RBAC catalog could not be read');
    if (!roles.every((r) => r && isStr(r.id) && isStr(r.code)) || !permissions.every((p) => p && isStr(p.id) && isStr(p.code))
      || !grants.every((g) => g && isStr(g.roleId) && isStr(g.permissionId))) return none('an RBAC catalog row is malformed');
    const lines = serialize({ roles, permissions, grants }).split('\n');
    if (new Set(lines).size !== lines.length) return none('the RBAC catalog holds a duplicate row');
    const d = digest({ roles, permissions, grants });
    for (const [name, value] of Object.entries(CATALOG_GENERATION_DIGESTS)) if (d === value) return { ok: true, catalog: name, digest: d };
    return none('the RBAC catalog is not an exact 35-, 36- or 37-permission catalog');
  } catch {
    return none('the RBAC catalog could not be classified');
  }
}
