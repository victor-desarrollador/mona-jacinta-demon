import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createCashRouter } from '../../src/modules/cash/cash.routes.js';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';

// CASH-1.1: DB-free route contract for GET /cash/sessions (close history).
// Everything below the stub Prisma client is real: buildAuthorizationContext,
// requirePermission, the strict query DTO, the router, controller and
// cash.service listSessions (CASH_SESSION_CLOSE at the register's own
// location). No pg, no test-db harness, no database of any kind.
//
// PRE-REGISTERED EXPECTATIONS (2026-10-13), characterization of the CASH-1
// route (no API source changes in CASH-1.1):
//   A01 no auth -> 401, no DB call
//   A02 SELLER, valid branchId -> 403, no DB call
//   A03 SELLER, malformed branchId -> 403 (permission gate runs before validation)
//   A04 CASHIER, malformed branchId -> 400, no DB call
//   A05 CASHIER, extra query parameter -> 400 (strict DTO), no DB call
//   A06 CASHIER at A -> 200 array; CLOSED sessions of A's register, newest first, at most 10
//   A07 CASHIER only at B asking for A -> 403, no history read
//   A08 SELLER at A + CASHIER at B asking for A -> 403 (location-aware), no history read
//   A09 pre-CASH-1 close: reconciliation fields serialize as null, never "0"; BIGINT as strings
//   A10 COMPANY-scoped ADMIN -> 200
//   A11 no register at the branch -> 404, no history read

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b2';
const ACTIVE = [A, B];
const REGISTER_A = { id: '00000000-0000-4000-8000-00000000aaaa', branchId: A, name: 'Caja A' };

type RoleName = keyof typeof DEFAULT_ROLE_GRANTS | 'OWNER';
type Scope = { role: RoleName; at: string | 'COMPANY' };

async function authFor(scopes: Scope[]) {
  return buildAuthorizationContext(
    { location: { findMany: async () => ACTIVE.map((id) => ({ id })) } },
    {
      id: 'user-1',
      branchRoles: [],
      roleScopes: scopes.map((scope) => ({
        roleId: `role-${scope.role}`,
        scopeKind: scope.at === 'COMPANY' ? 'COMPANY' as const : 'LOCATION' as const,
        locationId: scope.at === 'COMPANY' ? null : scope.at,
        role: {
          code: scope.role,
          permissions: (scope.role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[scope.role]]).map((code) => ({ permission: { code } })),
        },
      })),
    },
  );
}

const findFirst = vi.fn();
const findMany = vi.fn();

function history(auth: Express.AuthContext | undefined, query: Record<string, string>) {
  const app = express();
  app.use((req, _res, next) => { if (auth) req.auth = auth; next(); });
  app.use('/cash', createCashRouter({ cashRegister: { findFirst }, cashSession: { findMany } } as unknown as PrismaClient));
  app.use(errorHandler);
  return request(app).get('/cash/sessions').query(query);
}

function closedSession(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000c1', registerId: REGISTER_A.id, openedById: 'user-1', closedById: 'user-1',
    openedAt: new Date('2030-01-01T09:00:00.000Z'), closedAt: new Date('2030-01-01T18:00:00.000Z'),
    startingCash: 100000n, expectedCash: 600000n, countedCash: 550000n, difference: -50000n, status: 'CLOSED',
    ...overrides,
  };
}

beforeEach(() => {
  findFirst.mockReset();
  findMany.mockReset();
  findFirst.mockImplementation(async ({ where }: { where: { branchId: string } }) => (where.branchId === A ? REGISTER_A : null));
  findMany.mockResolvedValue([]);
});

const noDbCall = () => {
  expect(findFirst).not.toHaveBeenCalled();
  expect(findMany).not.toHaveBeenCalled();
};

describe('GET /cash/sessions (CASH-1.1 route contract)', () => {
  it('A01 refuses an unauthenticated request with 401 before any read', async () => {
    const response = await history(undefined, { branchId: A });
    expect(response.status).toBe(401);
    noDbCall();
  });

  it('A02 refuses a SELLER (no CASH_SESSION_CLOSE) with 403 before any read', async () => {
    const response = await history(await authFor([{ role: 'SELLER', at: A }]), { branchId: A });
    expect(response.status).toBe(403);
    noDbCall();
  });

  it('A03 checks the permission before validating the query (SELLER + malformed branchId -> 403)', async () => {
    const response = await history(await authFor([{ role: 'SELLER', at: A }]), { branchId: 'not-a-uuid' });
    expect(response.status).toBe(403);
    noDbCall();
  });

  it('A04 rejects a malformed branchId from an authorized cashier with 400 before any read', async () => {
    const response = await history(await authFor([{ role: 'CASHIER', at: A }]), { branchId: 'not-a-uuid' });
    expect(response.status).toBe(400);
    noDbCall();
  });

  it('A05 rejects an extra query parameter (strict DTO) with 400 before any read', async () => {
    const response = await history(await authFor([{ role: 'CASHIER', at: A }]), { branchId: A, take: '1000' });
    expect(response.status).toBe(400);
    noDbCall();
  });

  it('A06 lists only CLOSED sessions of the branch register, newest first, at most 10', async () => {
    findMany.mockResolvedValue([closedSession()]);
    const response = await history(await authFor([{ role: 'CASHIER', at: A }]), { branchId: A });
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(1);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { branchId: A } }));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0]![0]).toEqual({
      where: { registerId: REGISTER_A.id, status: 'CLOSED' },
      orderBy: [{ closedAt: 'desc' }, { openedAt: 'desc' }],
      take: 10,
    });
    expect(response.body[0]).toMatchObject({
      sessionId: closedSession().id, branchId: A, status: 'CLOSED',
      startingCash: '100000', expectedCash: '600000', countedCash: '550000', difference: '-50000',
    });
  });

  it('A07 refuses a cashier of another location with 403 and never reads the history', async () => {
    const response = await history(await authFor([{ role: 'CASHIER', at: B }]), { branchId: A });
    expect(response.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('A08 is location-aware: SELLER at A plus CASHIER at B cannot read A history', async () => {
    const response = await history(await authFor([{ role: 'SELLER', at: A }, { role: 'CASHIER', at: B }]), { branchId: A });
    expect(response.status).toBe(403);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('A09 keeps the reconciliation of a pre-CASH-1 close as null, never zero', async () => {
    findMany.mockResolvedValue([closedSession({ expectedCash: null, countedCash: null, difference: null })]);
    const response = await history(await authFor([{ role: 'CASHIER', at: A }]), { branchId: A });
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({ expectedCash: null, countedCash: null, difference: null, startingCash: '100000' });
  });

  it('A10 allows a COMPANY-scoped ADMIN', async () => {
    const response = await history(await authFor([{ role: 'ADMIN', at: 'COMPANY' }]), { branchId: A });
    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it('A11 answers 404 when the branch has no register and never reads the history', async () => {
    findFirst.mockResolvedValue(null);
    const response = await history(await authFor([{ role: 'CASHIER', at: A }]), { branchId: A });
    expect(response.status).toBe(404);
    expect(findMany).not.toHaveBeenCalled();
  });
});
