import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { createSalesRouter } from '../../src/modules/sales/sales.routes.js';

// D5I-B1: DB-free regression for GET /sales/pending. The route gate is global
// (SALE_QUEUE_VIEW held by ANY assignment), so the locations feeding the
// query must be the ones where the SAME assignment grants the permission,
// never the cross-assignment effectiveLocationIds union.
//
// Everything below the stub Prisma client is real: buildAuthorizationContext,
// requirePermission, authorizedLocationIds/hasPermissionAtLocation, the
// DEFAULT_ROLE_GRANTS matrix, the real router and controller.
vi.mock('../../src/config/env.js', () => ({ env: { WHOLESALE_AUTH_CODE_HASH: undefined } }));

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const C = '00000000-0000-4000-8000-0000000000c3';
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

async function getPending(auth: Express.AuthContext, query = '') {
  const app = express();
  app.use((req, _res, next) => { req.auth = auth; next(); });
  app.use('/sales', createSalesRouter({ sale: { findMany } } as unknown as PrismaClient));
  app.use(errorHandler);
  return request(app).get(`/sales/pending${query}`);
}

function queriedLocations(): string[] {
  expect(findMany).toHaveBeenCalledTimes(1);
  return findMany.mock.calls[0]![0].where.branchId.in as string[];
}

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
});

describe('GET /sales/pending location scope (D5I-B1)', () => {
  // Expected outcomes are fixed here, before execution.
  const cases: Array<{ name: string; scopes: Scope[]; legacy?: string[]; expected: string[] | 403 }> = [
    { name: '1 CASHIER@B + SELLER@A -> B only', scopes: [{ role: 'CASHIER', at: B }, { role: 'SELLER', at: A }], expected: [B] },
    { name: '2 CASHIER@A + CASHIER@B -> A and B', scopes: [{ role: 'CASHIER', at: A }, { role: 'CASHIER', at: B }], expected: [A, B] },
    { name: '3 CASHIER@B + WAREHOUSE@A -> B only', scopes: [{ role: 'CASHIER', at: B }, { role: 'WAREHOUSE', at: A }], expected: [B] },
    { name: '4 ADMIN COMPANY -> every active location', scopes: [{ role: 'ADMIN', at: 'COMPANY' }], expected: ACTIVE },
    { name: '5 OWNER COMPANY -> every active location', scopes: [{ role: 'OWNER', at: 'COMPANY' }], expected: ACTIVE },
    { name: '6 malformed OWNER LOCATION@A only -> no authority', scopes: [{ role: 'OWNER', at: A }], expected: 403 },
    { name: '7 malformed OWNER LOCATION@A + CASHIER@B -> B only', scopes: [{ role: 'OWNER', at: A }, { role: 'CASHIER', at: B }], expected: [B] },
    { name: '8 empty assignments -> forbidden', scopes: [], expected: 403 },
    { name: '9 duplicate effective locations -> deduplicated', scopes: [{ role: 'CASHIER', at: B }, { role: 'CASHIER', at: B }], expected: [B] },
    { name: '10 stale UserBranchRole only -> forbidden', scopes: [], legacy: ['CASHIER', 'ADMIN'], expected: 403 },
    { name: '11 SELLER@A without SALE_QUEUE_VIEW -> forbidden', scopes: [{ role: 'SELLER', at: A }], expected: 403 },
    { name: '12 SELLER@A with explicit SALE_QUEUE_VIEW grant -> A only', scopes: [{ role: 'SELLER', at: A, extraPermissions: [PRODUCTION_PERMISSIONS.SALE_QUEUE_VIEW] }], expected: [A] },
    { name: '13 ADMIN COMPANY + SELLER@A -> every active location', scopes: [{ role: 'ADMIN', at: 'COMPANY' }, { role: 'SELLER', at: A }], expected: ACTIVE },
    { name: '14 CASHIER@A + CASHIER@B + SELLER@C -> A and B', scopes: [{ role: 'CASHIER', at: A }, { role: 'CASHIER', at: B }, { role: 'SELLER', at: C }], expected: [A, B] },
    { name: '15 WAREHOUSE@A only -> forbidden', scopes: [{ role: 'WAREHOUSE', at: A }], expected: 403 },
    { name: '16 SELLER@A + CASHIER@B + WAREHOUSE@C -> B only', scopes: [{ role: 'SELLER', at: A }, { role: 'CASHIER', at: B }, { role: 'WAREHOUSE', at: C }], expected: [B] },
    { name: '17 stale UserBranchRole CASHIER + SELLER@A scope -> forbidden', scopes: [{ role: 'SELLER', at: A }], legacy: ['CASHIER'], expected: 403 },
  ];

  it.each(cases)('$name', async ({ scopes, legacy, expected }) => {
    const response = await getPending(await authFor(scopes, legacy));
    if (expected === 403) {
      expect(response.status).toBe(403);
      expect(findMany).not.toHaveBeenCalled();
      return;
    }
    expect(response.status).toBe(200);
    expect(queriedLocations()).toEqual(expected);
  });

  it('still rejects client-supplied branch filters without querying', async () => {
    const auth = await authFor([{ role: 'CASHIER', at: B }]);
    const response = await getPending(auth, `?branchId=${A}`);
    expect(response.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });
});
