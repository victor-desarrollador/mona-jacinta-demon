// Zero-database unit tests for scripts/database/pilot-rbac-catalog.mjs: the pinned
// literal RBAC catalogs CATALOG_35 (before CASH_MOVEMENT_MANAGE) and CATALOG_36 (after),
// their digests and the strict classifier shared by A4, pilot-backup, the clone restore
// proof and pilot-rbac-catalog-upgrade. CATALOG_36 is cross-checked against the REAL
// api/src modules (loaded in-process through the repo-local tsx, no database).
// Run with: node --test scripts/database/pilot-rbac-catalog.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as rbac from './pilot-rbac-catalog.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const tsx = await import(pathToFileURL(path.join(ROOT, 'api/node_modules/tsx/dist/esm/api/index.mjs')).href);
const ts = (rel) => tsx.tsImport(pathToFileURL(path.join(ROOT, rel)).href, import.meta.url);
const [catalog, matrix, permissions] = await Promise.all([
  ts('api/src/modules/rbac/catalog.service.ts'), ts('api/src/modules/rbac/role-permission-matrix.ts'), ts('api/src/modules/rbac/permissions.ts'),
]);

// Database-shaped rows of a catalog definition (what the SQL reads return).
function rowsOf(def) {
  const roleId = new Map(def.roles.map(([code, id]) => [code, id]));
  const permId = new Map(def.permissions.map(([code, id]) => [code, id]));
  return {
    roles: def.roles.map(([code, id]) => ({ id, code })),
    permissions: def.permissions.map(([code, id]) => ({ id, code })),
    grants: def.grants.map(([role, perm]) => ({ roleId: roleId.get(role), permissionId: permId.get(perm) })),
  };
}

test('RC-01 CATALOG_36 (the historical catalog of the G14 cut-over tooling) equals the real canonical catalog of api/src MINUS exactly SALE_VOID and its ADMIN grant', () => {
  // The canonical catalog is CATALOG_37 since sale void v1 (see pilot-rbac-catalog-generations.mjs); this module stays
  // byte-identical because the PILOT tool manifests pin it.
  const real = {
    roles: Object.entries(catalog.CANONICAL_ROLE_IDS).sort(),
    permissions: permissions.productionPermissionValues.map((c) => [c, catalog.CANONICAL_PERMISSION_IDS[c]]).sort().filter(([code]) => code !== 'SALE_VOID'),
    grants: Object.entries(matrix.DEFAULT_ROLE_GRANTS).flatMap(([role, list]) => list.map((p) => [role, p])).sort().filter(([, code]) => code !== 'SALE_VOID'),
  };
  assert.deepEqual(rbac.CATALOG_36.roles.map((r) => [...r]), real.roles);
  assert.deepEqual(rbac.CATALOG_36.permissions.map((p) => [...p]), real.permissions);
  assert.deepEqual(rbac.CATALOG_36.grants.map((g) => [...g]), real.grants);
  assert.equal(rbac.CATALOG_36.permissions.length, 36);
  assert.equal(rbac.CATALOG_36.grants.length, 75);
});

test('RC-02 CATALOG_35 is CATALOG_36 minus exactly CASH_MOVEMENT_MANAGE and its two default grants (CASHIER, ADMIN)', () => {
  assert.deepEqual(rbac.CATALOG_35.roles, rbac.CATALOG_36.roles);
  assert.equal(rbac.CATALOG_35.permissions.length, 35);
  assert.equal(rbac.CATALOG_35.grants.length, 73);
  assert.deepEqual(rbac.CATALOG_36.permissions.filter((p) => !rbac.CATALOG_35.permissions.some((q) => q[0] === p[0])).map((p) => [...p]),
    [['CASH_MOVEMENT_MANAGE', '00000000-0000-4000-9400-000000000036']]);
  assert.deepEqual(rbac.CATALOG_36.grants.filter((g) => !rbac.CATALOG_35.grants.some((h) => h[0] === g[0] && h[1] === g[1])).map((g) => [...g]),
    [['ADMIN', 'CASH_MOVEMENT_MANAGE'], ['CASHIER', 'CASH_MOVEMENT_MANAGE']]);
  assert.deepEqual(rbac.UPGRADE_DELTA, {
    permission: ['CASH_MOVEMENT_MANAGE', '00000000-0000-4000-9400-000000000036'],
    grants: [['ADMIN', 'CASH_MOVEMENT_MANAGE'], ['CASHIER', 'CASH_MOVEMENT_MANAGE']],
  });
});

test('RC-03 the literals are frozen and the module is builtins-only (no disk, no env, no dynamic import)', () => {
  for (const c of [rbac.CATALOG_35, rbac.CATALOG_36]) assert.ok(Object.isFrozen(c) && Object.isFrozen(c.permissions) && Object.isFrozen(c.grants[0]));
  const src = readFileSync(new URL('./pilot-rbac-catalog.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /readFile|readdir|process\.env|import\(|from '(?!node:crypto)/);
});

test('RC-04 exact 35 and exact 36 classify, in any row order; digests differ and are stable', () => {
  assert.deepEqual(rbac.classifyCatalog(rowsOf(rbac.CATALOG_35)), { ok: true, catalog: 'CATALOG_35', digest: rbac.CATALOG_DIGESTS.CATALOG_35 });
  const r36 = rowsOf(rbac.CATALOG_36);
  assert.deepEqual(rbac.classifyCatalog({ roles: [...r36.roles].reverse(), permissions: [...r36.permissions].reverse(), grants: [...r36.grants].reverse() }),
    { ok: true, catalog: 'CATALOG_36', digest: rbac.CATALOG_DIGESTS.CATALOG_36 });
  assert.notEqual(rbac.CATALOG_DIGESTS.CATALOG_35, rbac.CATALOG_DIGESTS.CATALOG_36);
  assert.match(rbac.CATALOG_DIGESTS.CATALOG_36, /^[0-9a-f]{64}$/);
});

test('RC-05 anything else is unclassified: partial upgrade, extra/missing/duplicate rows, foreign ids, malformed', () => {
  const r35 = rowsOf(rbac.CATALOG_35);
  const r36 = rowsOf(rbac.CATALOG_36);
  const cmmGrant = r36.grants.filter((g) => g.permissionId === '00000000-0000-4000-9400-000000000036');
  const cases = {
    'permission without grants (partial upgrade)': { ...r35, permissions: r36.permissions },
    'one of two grants (partial upgrade)': { ...r35, permissions: r36.permissions, grants: [...r35.grants, cmmGrant[0]] },
    'extra legacy role': { ...r36, roles: [...r36.roles, { id: 'x', code: 'MANAGER' }] },
    'missing role': { ...r36, roles: r36.roles.slice(1) },
    'extra permission': { ...r36, permissions: [...r36.permissions, { id: 'y', code: 'FOO' }] },
    'duplicate grant': { ...r36, grants: [...r36.grants, r36.grants[0]] },
    'OWNER grant': { ...r36, grants: [...r36.grants, { roleId: '00000000-0000-4000-9300-000000000001', permissionId: r36.permissions[0].id }] },
    'permission id swapped': { ...r36, permissions: r36.permissions.map((p, i) => (i === 0 ? { ...p, id: 'z' } : p)) },
    'malformed row': { ...r36, roles: [...r36.roles.slice(1), { id: 1, code: 'OWNER' }] },
    'empty': { roles: [], permissions: [], grants: [] },
    'not an object': null,
  };
  for (const [label, rows] of Object.entries(cases)) {
    const r = rbac.classifyCatalog(rows);
    assert.equal(r.ok, false, label);
    assert.equal(r.catalog, null, label);
  }
});

test('RC-06 the read SQL is three plain FROM ONLY projections', () => {
  assert.deepEqual(rbac.CATALOG_SQL, {
    roles: 'SELECT id, code FROM ONLY public."Role"',
    permissions: 'SELECT id, code FROM ONLY public."Permission"',
    grants: 'SELECT "roleId", "permissionId" FROM ONLY public."RolePermission"',
  });
});
