// PILOT G11 cut-over: the pinned literal RBAC catalogs and their strict classifier, shared
// by pilot-a4-readonly, pilot-backup, pilot-clone-restore and pilot-rbac-catalog-upgrade.
// Builtins only (node:crypto), no I/O: the literals are cross-checked against the real
// api/src catalog/matrix by pilot-rbac-catalog.test.mjs.
//
//   CATALOG_36 — the current canonical catalog: 5 Production roles, 36 permissions (incl.
//                CASH_MOVEMENT_MANAGE, id 9400/36) and 75 default grants (OWNER has none;
//                its authority is implicit).
//   CATALOG_35 — the catalog before CASH_MOVEMENT_MANAGE: CATALOG_36 minus that permission
//                and its two default grants (ADMIN, CASHIER).
//
// A catalog is the COMPLETE content of "Role"(id, code), "Permission"(id, code) and
// "RolePermission"(roleId, permissionId) — the same exactness pilot-bootstrap uses. Any
// extra, missing, duplicate or foreign row, or a partial upgrade, is unclassified.
import { createHash } from 'node:crypto';

const ROLES = Object.freeze([
  Object.freeze(['ADMIN', '00000000-0000-4000-9300-000000000002']),
  Object.freeze(['CASHIER', '00000000-0000-4000-9300-000000000003']),
  Object.freeze(['OWNER', '00000000-0000-4000-9300-000000000001']),
  Object.freeze(['SELLER', '00000000-0000-4000-9300-000000000004']),
  Object.freeze(['WAREHOUSE', '00000000-0000-4000-9300-000000000005']),
]);
const PERMISSIONS_36 = Object.freeze([
  Object.freeze(['AUDIT_VIEW', '00000000-0000-4000-9400-000000000020']),
  Object.freeze(['CASH_MOVEMENT_MANAGE', '00000000-0000-4000-9400-000000000036']),
  Object.freeze(['CASH_SESSION_CLOSE', '00000000-0000-4000-9400-000000000017']),
  Object.freeze(['CASH_SESSION_OPEN', '00000000-0000-4000-9400-000000000016']),
  Object.freeze(['EXCHANGE_MANAGE', '00000000-0000-4000-9400-000000000028']),
  Object.freeze(['GOODS_RECEIPT_MANAGE', '00000000-0000-4000-9400-000000000002']),
  Object.freeze(['IMPORT_RUN', '00000000-0000-4000-9400-000000000006']),
  Object.freeze(['INVENTORY_MANAGE', '00000000-0000-4000-9400-000000000015']),
  Object.freeze(['INVENTORY_VIEW', '00000000-0000-4000-9400-000000000014']),
  Object.freeze(['LABEL_PRINT', '00000000-0000-4000-9400-000000000005']),
  Object.freeze(['PRICE_MANAGE', '00000000-0000-4000-9400-000000000001']),
  Object.freeze(['PRODUCT_IMAGE_MANAGE', '00000000-0000-4000-9400-000000000033']),
  Object.freeze(['PRODUCT_MANAGE', '00000000-0000-4000-9400-000000000003']),
  Object.freeze(['PRODUCT_VARIANT_MANAGE', '00000000-0000-4000-9400-000000000004']),
  Object.freeze(['PUBLICATION_CHECKOUT', '00000000-0000-4000-9400-000000000029']),
  Object.freeze(['PUBLICATION_RETURN', '00000000-0000-4000-9400-000000000030']),
  Object.freeze(['REPORT_VIEW', '00000000-0000-4000-9400-000000000019']),
  Object.freeze(['SALE_CANCEL_PENDING', '00000000-0000-4000-9400-000000000035']),
  Object.freeze(['SALE_CHARGE', '00000000-0000-4000-9400-000000000010']),
  Object.freeze(['SALE_COMPLETE', '00000000-0000-4000-9400-000000000011']),
  Object.freeze(['SALE_CORRECT_PENDING', '00000000-0000-4000-9400-000000000034']),
  Object.freeze(['SALE_CREATE', '00000000-0000-4000-9400-000000000009']),
  Object.freeze(['SALE_QUEUE_VIEW', '00000000-0000-4000-9400-000000000013']),
  Object.freeze(['SALE_VIEW', '00000000-0000-4000-9400-000000000012']),
  Object.freeze(['SENA_CREATE', '00000000-0000-4000-9400-000000000031']),
  Object.freeze(['SENA_MANAGE', '00000000-0000-4000-9400-000000000032']),
  Object.freeze(['SENA_SETTLE', '00000000-0000-4000-9400-000000000008']),
  Object.freeze(['SUPPLIER_MANAGE', '00000000-0000-4000-9400-000000000021']),
  Object.freeze(['TRANSFER_APPROVE', '00000000-0000-4000-9400-000000000024']),
  Object.freeze(['TRANSFER_DISPATCH', '00000000-0000-4000-9400-000000000026']),
  Object.freeze(['TRANSFER_PREPARE', '00000000-0000-4000-9400-000000000025']),
  Object.freeze(['TRANSFER_RECEIVE', '00000000-0000-4000-9400-000000000027']),
  Object.freeze(['TRANSFER_REQUEST', '00000000-0000-4000-9400-000000000022']),
  Object.freeze(['TRANSFER_RESOLVE', '00000000-0000-4000-9400-000000000007']),
  Object.freeze(['TRANSFER_VIEW', '00000000-0000-4000-9400-000000000023']),
  Object.freeze(['USER_MANAGE', '00000000-0000-4000-9400-000000000018']),
]);
const GRANTS_36 = Object.freeze([
  Object.freeze(['ADMIN', 'AUDIT_VIEW']),
  Object.freeze(['ADMIN', 'CASH_MOVEMENT_MANAGE']),
  Object.freeze(['ADMIN', 'CASH_SESSION_CLOSE']),
  Object.freeze(['ADMIN', 'CASH_SESSION_OPEN']),
  Object.freeze(['ADMIN', 'EXCHANGE_MANAGE']),
  Object.freeze(['ADMIN', 'GOODS_RECEIPT_MANAGE']),
  Object.freeze(['ADMIN', 'IMPORT_RUN']),
  Object.freeze(['ADMIN', 'INVENTORY_MANAGE']),
  Object.freeze(['ADMIN', 'INVENTORY_VIEW']),
  Object.freeze(['ADMIN', 'LABEL_PRINT']),
  Object.freeze(['ADMIN', 'PRICE_MANAGE']),
  Object.freeze(['ADMIN', 'PRODUCT_IMAGE_MANAGE']),
  Object.freeze(['ADMIN', 'PRODUCT_MANAGE']),
  Object.freeze(['ADMIN', 'PRODUCT_VARIANT_MANAGE']),
  Object.freeze(['ADMIN', 'PUBLICATION_CHECKOUT']),
  Object.freeze(['ADMIN', 'PUBLICATION_RETURN']),
  Object.freeze(['ADMIN', 'REPORT_VIEW']),
  Object.freeze(['ADMIN', 'SALE_CANCEL_PENDING']),
  Object.freeze(['ADMIN', 'SALE_CHARGE']),
  Object.freeze(['ADMIN', 'SALE_COMPLETE']),
  Object.freeze(['ADMIN', 'SALE_CORRECT_PENDING']),
  Object.freeze(['ADMIN', 'SALE_CREATE']),
  Object.freeze(['ADMIN', 'SALE_QUEUE_VIEW']),
  Object.freeze(['ADMIN', 'SALE_VIEW']),
  Object.freeze(['ADMIN', 'SENA_CREATE']),
  Object.freeze(['ADMIN', 'SENA_MANAGE']),
  Object.freeze(['ADMIN', 'SENA_SETTLE']),
  Object.freeze(['ADMIN', 'SUPPLIER_MANAGE']),
  Object.freeze(['ADMIN', 'TRANSFER_APPROVE']),
  Object.freeze(['ADMIN', 'TRANSFER_DISPATCH']),
  Object.freeze(['ADMIN', 'TRANSFER_PREPARE']),
  Object.freeze(['ADMIN', 'TRANSFER_RECEIVE']),
  Object.freeze(['ADMIN', 'TRANSFER_REQUEST']),
  Object.freeze(['ADMIN', 'TRANSFER_RESOLVE']),
  Object.freeze(['ADMIN', 'TRANSFER_VIEW']),
  Object.freeze(['ADMIN', 'USER_MANAGE']),
  Object.freeze(['CASHIER', 'CASH_MOVEMENT_MANAGE']),
  Object.freeze(['CASHIER', 'CASH_SESSION_CLOSE']),
  Object.freeze(['CASHIER', 'CASH_SESSION_OPEN']),
  Object.freeze(['CASHIER', 'EXCHANGE_MANAGE']),
  Object.freeze(['CASHIER', 'INVENTORY_VIEW']),
  Object.freeze(['CASHIER', 'LABEL_PRINT']),
  Object.freeze(['CASHIER', 'PUBLICATION_CHECKOUT']),
  Object.freeze(['CASHIER', 'PUBLICATION_RETURN']),
  Object.freeze(['CASHIER', 'SALE_CANCEL_PENDING']),
  Object.freeze(['CASHIER', 'SALE_CHARGE']),
  Object.freeze(['CASHIER', 'SALE_COMPLETE']),
  Object.freeze(['CASHIER', 'SALE_CORRECT_PENDING']),
  Object.freeze(['CASHIER', 'SALE_QUEUE_VIEW']),
  Object.freeze(['CASHIER', 'SALE_VIEW']),
  Object.freeze(['CASHIER', 'SENA_CREATE']),
  Object.freeze(['CASHIER', 'SENA_SETTLE']),
  Object.freeze(['CASHIER', 'TRANSFER_APPROVE']),
  Object.freeze(['CASHIER', 'TRANSFER_DISPATCH']),
  Object.freeze(['CASHIER', 'TRANSFER_RECEIVE']),
  Object.freeze(['CASHIER', 'TRANSFER_REQUEST']),
  Object.freeze(['CASHIER', 'TRANSFER_RESOLVE']),
  Object.freeze(['CASHIER', 'TRANSFER_VIEW']),
  Object.freeze(['SELLER', 'INVENTORY_VIEW']),
  Object.freeze(['SELLER', 'SALE_CREATE']),
  Object.freeze(['SELLER', 'SALE_VIEW']),
  Object.freeze(['SELLER', 'SENA_CREATE']),
  Object.freeze(['SELLER', 'TRANSFER_REQUEST']),
  Object.freeze(['SELLER', 'TRANSFER_VIEW']),
  Object.freeze(['WAREHOUSE', 'GOODS_RECEIPT_MANAGE']),
  Object.freeze(['WAREHOUSE', 'INVENTORY_MANAGE']),
  Object.freeze(['WAREHOUSE', 'LABEL_PRINT']),
  Object.freeze(['WAREHOUSE', 'PRODUCT_IMAGE_MANAGE']),
  Object.freeze(['WAREHOUSE', 'TRANSFER_APPROVE']),
  Object.freeze(['WAREHOUSE', 'TRANSFER_DISPATCH']),
  Object.freeze(['WAREHOUSE', 'TRANSFER_PREPARE']),
  Object.freeze(['WAREHOUSE', 'TRANSFER_RECEIVE']),
  Object.freeze(['WAREHOUSE', 'TRANSFER_REQUEST']),
  Object.freeze(['WAREHOUSE', 'TRANSFER_RESOLVE']),
  Object.freeze(['WAREHOUSE', 'TRANSFER_VIEW']),
]);

const CMM = 'CASH_MOVEMENT_MANAGE';
export const CATALOG_36 = Object.freeze({ roles: ROLES, permissions: PERMISSIONS_36, grants: GRANTS_36 });
export const CATALOG_35 = Object.freeze({
  roles: ROLES,
  permissions: Object.freeze(PERMISSIONS_36.filter(([code]) => code !== CMM)),
  grants: Object.freeze(GRANTS_36.filter(([, code]) => code !== CMM)),
});
// What pilot-rbac-catalog-upgrade adds to an exact CATALOG_35, and nothing else.
export const UPGRADE_DELTA = Object.freeze({
  permission: PERMISSIONS_36.find(([code]) => code === CMM),
  grants: Object.freeze(GRANTS_36.filter(([, code]) => code === CMM)),
});

export const CATALOG_SQL = Object.freeze({
  roles: 'SELECT id, code FROM ONLY public."Role"',
  permissions: 'SELECT id, code FROM ONLY public."Permission"',
  grants: 'SELECT "roleId", "permissionId" FROM ONLY public."RolePermission"',
});

// Canonical, order-independent serialization of catalog ROWS (ids), the digest input.
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
export const CATALOG_DIGESTS = Object.freeze({ CATALOG_35: digest(rowsOf(CATALOG_35)), CATALOG_36: digest(rowsOf(CATALOG_36)) });

const isStr = (v) => typeof v === 'string' && v.length > 0;
// Exactly CATALOG_35 or CATALOG_36 (same rows, no duplicates), else unclassified. Never throws.
export function classifyCatalog(rows) {
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
    for (const [name, value] of Object.entries(CATALOG_DIGESTS)) if (d === value) return { ok: true, catalog: name, digest: d };
    return none('the RBAC catalog is neither the exact 35- nor the exact 36-permission catalog');
  } catch {
    return none('the RBAC catalog could not be classified');
  }
}
