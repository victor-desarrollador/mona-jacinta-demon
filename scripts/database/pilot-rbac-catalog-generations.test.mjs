// Zero-database unit tests for scripts/database/pilot-rbac-catalog-generations.mjs: CATALOG_37 (the LATEST canonical
// catalog, + SALE_VOID) next to the historical CATALOG_35/36, cross-checked against the REAL api/src modules.
// Run with: node --test scripts/database/pilot-rbac-catalog-generations.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as base from './pilot-rbac-catalog.mjs';
import * as gen from './pilot-rbac-catalog-generations.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const tsx = await import(pathToFileURL(path.join(ROOT, 'api/node_modules/tsx/dist/esm/api/index.mjs')).href);
const ts = (rel) => tsx.tsImport(pathToFileURL(path.join(ROOT, rel)).href, import.meta.url);
const [catalog, matrix, permissions] = await Promise.all([
  ts('api/src/modules/rbac/catalog.service.ts'), ts('api/src/modules/rbac/role-permission-matrix.ts'), ts('api/src/modules/rbac/permissions.ts'),
]);
const SALE_VOID_ID = '00000000-0000-4000-9400-000000000037';

function rowsOf(def) {
  const roleId = new Map(def.roles.map(([code, id]) => [code, id]));
  const permId = new Map(def.permissions.map(([code, id]) => [code, id]));
  return {
    roles: def.roles.map(([code, id]) => ({ id, code })),
    permissions: def.permissions.map(([code, id]) => ({ id, code })),
    grants: def.grants.map(([role, perm]) => ({ roleId: roleId.get(role), permissionId: permId.get(perm) })),
  };
}
const shuffled = (rows) => ({ roles: [...rows.roles].reverse(), permissions: [...rows.permissions].reverse(), grants: [...rows.grants].reverse() });

test('RG-01 CATALOG_37 (the LATEST) equals the real canonical catalog of api/src: roles, ids, permissions, default grants', () => {
  const real = {
    roles: Object.entries(catalog.CANONICAL_ROLE_IDS).sort(),
    permissions: permissions.productionPermissionValues.map((c) => [c, catalog.CANONICAL_PERMISSION_IDS[c]]).sort(),
    grants: Object.entries(matrix.DEFAULT_ROLE_GRANTS).flatMap(([role, list]) => list.map((p) => [role, p])).sort(),
  };
  assert.deepEqual(gen.CATALOG_37.roles.map((r) => [...r]), real.roles);
  assert.deepEqual(gen.CATALOG_37.permissions.map((p) => [...p]), real.permissions);
  assert.deepEqual(gen.CATALOG_37.grants.map((g) => [...g]), real.grants);
  assert.equal(gen.CATALOG_37.permissions.length, 37);
  assert.equal(gen.CATALOG_37.grants.length, 76);
  assert.equal(gen.LATEST_CATALOG, 'CATALOG_37');
});

test('RG-02 CATALOG_37 is CATALOG_36 plus exactly SALE_VOID (9400/37) and ONE grant (ADMIN); OWNER and the other roles get nothing', () => {
  assert.deepEqual(gen.CATALOG_37.roles, base.CATALOG_36.roles);
  assert.deepEqual(gen.CATALOG_37.permissions.filter((p) => !base.CATALOG_36.permissions.some((q) => q[0] === p[0])).map((p) => [...p]), [['SALE_VOID', SALE_VOID_ID]]);
  assert.deepEqual(gen.CATALOG_37.grants.filter((g) => !base.CATALOG_36.grants.some((h) => h[0] === g[0] && h[1] === g[1])).map((g) => [...g]), [['ADMIN', 'SALE_VOID']]);
  assert.deepEqual(base.CATALOG_36.permissions.filter((p) => !gen.CATALOG_37.permissions.some((q) => q[0] === p[0])), [], 'nothing of 36 is lost');
  for (const role of ['OWNER', 'CASHIER', 'SELLER', 'WAREHOUSE']) assert.ok(!gen.CATALOG_37.grants.some(([r, p]) => r === role && p === 'SALE_VOID'), role);
  assert.deepEqual(gen.UPGRADE_DELTA_37, { permission: ['SALE_VOID', SALE_VOID_ID], grants: [['ADMIN', 'SALE_VOID']] });
});

test('RG-03 the historical catalogs stay exactly as the cut-over tooling pins them (the base module is untouched)', () => {
  assert.equal(base.CATALOG_36.permissions.length, 36);
  assert.equal(base.CATALOG_36.grants.length, 75);
  assert.equal(base.CATALOG_35.permissions.length, 35);
  assert.deepEqual(gen.HISTORICAL_CATALOGS, ['CATALOG_35', 'CATALOG_36']);
  // the digest scheme is the base module's: the 35 and 36 digests computed here ARE the base ones
  assert.equal(gen.CATALOG_GENERATION_DIGESTS.CATALOG_35, base.CATALOG_DIGESTS.CATALOG_35);
  assert.equal(gen.CATALOG_GENERATION_DIGESTS.CATALOG_36, base.CATALOG_DIGESTS.CATALOG_36);
  assert.equal(new Set(Object.values(gen.CATALOG_GENERATION_DIGESTS)).size, 3);
  // and the base classifier does NOT know 37: a 37 database is unclassified for the cut-over tools, by design
  assert.equal(base.classifyCatalog(rowsOf(gen.CATALOG_37)).ok, false);
});

test('RG-04 exact 35, 36 and 37 classify, in any row order', () => {
  for (const [name, def] of [['CATALOG_35', base.CATALOG_35], ['CATALOG_36', base.CATALOG_36], ['CATALOG_37', gen.CATALOG_37]]) {
    const rows = rowsOf(def);
    assert.deepEqual(gen.classifyCatalogGeneration(rows), { ok: true, catalog: name, digest: gen.CATALOG_GENERATION_DIGESTS[name] }, name);
    assert.equal(gen.classifyCatalogGeneration(shuffled(rows)).catalog, name, `${name} reversed`);
  }
});

test('RG-05 anything else is unclassified: partial 37, wrong holders, foreign ids, extra/missing/duplicate rows, malformed', () => {
  const r36 = rowsOf(base.CATALOG_36);
  const r37 = rowsOf(gen.CATALOG_37);
  const cases = {
    'SALE_VOID permission without its ADMIN grant (partial transition)': { ...r36, permissions: r37.permissions },
    'ADMIN grant without the permission': { ...r36, grants: r37.grants },
    'SALE_VOID also granted to CASHIER': { ...r37, grants: [...r37.grants, { roleId: '00000000-0000-4000-9300-000000000003', permissionId: SALE_VOID_ID }] },
    'SALE_VOID granted to OWNER': { ...r37, grants: [...r37.grants, { roleId: '00000000-0000-4000-9300-000000000001', permissionId: SALE_VOID_ID }] },
    'SALE_VOID with a foreign id': { ...r37, permissions: r37.permissions.map((p) => (p.code === 'SALE_VOID' ? { ...p, id: 'foreign' } : p)) },
    'a different permission in its place': { ...r37, permissions: r37.permissions.map((p) => (p.code === 'SALE_VOID' ? { ...p, code: 'SALE_VOIDS' } : p)) },
    'extra permission': { ...r37, permissions: [...r37.permissions, { id: 'y', code: 'FOO' }] },
    'missing permission': { ...r37, permissions: r37.permissions.slice(1) },
    'duplicate grant': { ...r37, grants: [...r37.grants, r37.grants[0]] },
    'extra legacy role': { ...r37, roles: [...r37.roles, { id: 'x', code: 'MANAGER' }] },
    'malformed row': { ...r37, roles: [...r37.roles.slice(1), { id: 1, code: 'OWNER' }] },
    'empty': { roles: [], permissions: [], grants: [] },
    'not an object': null,
  };
  for (const [label, rows] of Object.entries(cases)) {
    const r = gen.classifyCatalogGeneration(rows);
    assert.equal(r.ok, false, label);
    assert.equal(r.catalog, null, label);
  }
});

test('RG-06 literals are frozen and the module is builtins-only (no disk, no env, no dynamic import, only the base catalog)', () => {
  for (const c of [gen.CATALOG_37, gen.UPGRADE_DELTA_37]) assert.ok(Object.isFrozen(c));
  assert.ok(Object.isFrozen(gen.CATALOG_37.permissions) && Object.isFrozen(gen.CATALOG_37.grants[0]));
  const src = readFileSync(new URL('./pilot-rbac-catalog-generations.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /readFile|readdir|process\.env|import\(/);
  assert.deepEqual([...src.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1]).sort(), ['./pilot-rbac-catalog.mjs', 'node:crypto']);
});
