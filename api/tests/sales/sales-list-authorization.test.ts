import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createSalesRouter } from '../../src/modules/sales/sales.routes.js';

// D5I-B1C: DB-free regression for GET /sales (own DRAFT list). Same class as
// D5I-B1: the route gate is global (SALE_VIEW held by ANY assignment), so the
// locations feeding the query must be the ones where the SAME assignment
// grants SALE_VIEW, never the cross-assignment effectiveLocationIds union.
// Detail (GET /sales/:saleId) already asserts SALE_VIEW at the sale's branch;
// the list must not return drafts the detail would refuse.
//
// Everything below the stub Prisma client is real: buildAuthorizationContext,
// requirePermission, authorizedLocationIds/hasPermissionAtLocation, the
// DEFAULT_ROLE_GRANTS matrix, the real router, controller and service.
vi.mock('../../src/config/env.js', () => ({ env: { WHOLESALE_AUTH_CODE_HASH: undefined } }));

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const C = '00000000-0000-4000-8000-0000000000c3';
const D_INACTIVE = '00000000-0000-4000-8000-0000000000d4';
const ACTIVE = [A, B, C];

type RoleName = keyof typeof DEFAULT_ROLE_GRANTS | 'OWNER';
type Scope = { role: RoleName; at: string | 'COMPANY'; extraPermissions?: string[] };

function rolePermissions(role: RoleName, extra: string[] = []) {
  const granted = role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[role]];
  return [...granted, ...extra].map((code) => ({ permission: { code } }));
}

async function authFor(scopes: Scope[], legacyRoles: string[] = []) {
  return buildAuthorizationContext(
    { location: { findMany: async () => ACTIVE.map((id) => ({ id })) } },
    {
      id: 'user-1',
      branchRoles: legacyRoles.map((code) => ({ role: { code } })),
      roleScopes: scopes.map((scope) => ({
        roleId: `role-${scope.role}`,
        scopeKind: scope.at === 'COMPANY' ? 'COMPANY' as const : 'LOCATION' as const,
        locationId: scope.at === 'COMPANY' ? null : scope.at,
        role: { code: scope.role, permissions: rolePermissions(scope.role, scope.extraPermissions) },
      })),
    },
  );
}

const findMany = vi.fn();

async function getList(auth: Express.AuthContext) {
  const app = express();
  app.use((req, _res, next) => { req.auth = auth; next(); });
  app.use('/sales', createSalesRouter({ sale: { findMany } } as unknown as PrismaClient));
  app.use(errorHandler);
  return request(app).get('/sales');
}

function queriedWhere() {
  expect(findMany).toHaveBeenCalledTimes(1);
  return findMany.mock.calls[0]![0].where as { sellerId: string; branchId: { in: string[] }; status: string };
}

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe('GET /sales location scope (D5I-B1C)', () => {
  // Expected outcomes are fixed here, before execution.
  const cases: Array<{ name: string; scopes: Scope[]; legacy?: string[]; expected: string[] | 403 }> = [
    { name: '1 SELLER@A + WAREHOUSE@B -> A only', scopes: [{ role: 'SELLER', at: A }, { role: 'WAREHOUSE', at: B }], expected: [A] },
    { name: '2 SELLER@A + SELLER@B -> A and B', scopes: [{ role: 'SELLER', at: A }, { role: 'SELLER', at: B }], expected: [A, B] },
    { name: '3 SELLER@A + CASHIER@B -> A and B (CASHIER carries SALE_VIEW)', scopes: [{ role: 'SELLER', at: A }, { role: 'CASHIER', at: B }], expected: [A, B] },
    { name: '4 CASHIER@B + WAREHOUSE@A -> B only', scopes: [{ role: 'CASHIER', at: B }, { role: 'WAREHOUSE', at: A }], expected: [B] },
    { name: '5 WAREHOUSE@A only -> forbidden', scopes: [{ role: 'WAREHOUSE', at: A }], expected: 403 },
    { name: '6 SELLER@A only -> A', scopes: [{ role: 'SELLER', at: A }], expected: [A] },
    { name: '7 ADMIN COMPANY -> every active location', scopes: [{ role: 'ADMIN', at: 'COMPANY' }], expected: ACTIVE },
    { name: '8 OWNER COMPANY -> every active location', scopes: [{ role: 'OWNER', at: 'COMPANY' }], expected: ACTIVE },
    { name: '9 malformed OWNER LOCATION@A only -> forbidden', scopes: [{ role: 'OWNER', at: A }], expected: 403 },
    { name: '10 malformed OWNER LOCATION@A + SELLER@B -> B only', scopes: [{ role: 'OWNER', at: A }, { role: 'SELLER', at: B }], expected: [B] },
    { name: '11 stale UserBranchRole SELLER only -> forbidden', scopes: [], legacy: ['SELLER'], expected: 403 },
    { name: '12 stale UserBranchRole SELLER + WAREHOUSE@A scope -> forbidden', scopes: [{ role: 'WAREHOUSE', at: A }], legacy: ['SELLER'], expected: 403 },
    { name: '13 duplicate qualifying assignments -> deduplicated', scopes: [{ role: 'SELLER', at: B }, { role: 'CASHIER', at: B }], expected: [B] },
    { name: '14 SELLER@A + SELLER@B + WAREHOUSE@C -> A and B', scopes: [{ role: 'SELLER', at: A }, { role: 'SELLER', at: B }, { role: 'WAREHOUSE', at: C }], expected: [A, B] },
    { name: '15 ADMIN COMPANY expansion excludes the inactive location', scopes: [{ role: 'ADMIN', at: 'COMPANY' }], expected: ACTIVE },
    { name: '16 empty assignments -> forbidden', scopes: [], expected: 403 },
    { name: '17 WAREHOUSE@A with explicit SALE_VIEW grant -> A only', scopes: [{ role: 'WAREHOUSE', at: A, extraPermissions: [PRODUCTION_PERMISSIONS.SALE_VIEW] }], expected: [A] },
    { name: '18 ADMIN COMPANY + WAREHOUSE@A -> every active location', scopes: [{ role: 'ADMIN', at: 'COMPANY' }, { role: 'WAREHOUSE', at: A }], expected: ACTIVE },
    { name: '19 WAREHOUSE@A + WAREHOUSE@B + SELLER@C -> C only', scopes: [{ role: 'WAREHOUSE', at: A }, { role: 'WAREHOUSE', at: B }, { role: 'SELLER', at: C }], expected: [C] },
  ];

  it.each(cases)('$name', async ({ scopes, legacy, expected }) => {
    const response = await getList(await authFor(scopes, legacy));
    if (expected === 403) {
      expect(response.status).toBe(403);
      expect(findMany).not.toHaveBeenCalled();
      return;
    }
    expect(response.status).toBe(200);
    const where = queriedWhere();
    expect(where.branchId.in).toEqual(expected);
    expect(where.branchId.in).not.toContain(D_INACTIVE);
    expect(where.sellerId).toBe('user-1');
    expect(where.status).toBe('DRAFT');
  });

  it('list/detail consistency: no returned-eligible location lacks SALE_VIEW', async () => {
    const auth = await authFor([{ role: 'SELLER', at: A }, { role: 'WAREHOUSE', at: B }]);
    await getList(auth);
    expect(queriedWhere().branchId.in).not.toContain(B);
  });
});
