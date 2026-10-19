// SECURITY-RBAC-01a — COMPANY scope is valid ONLY for OWNER and ADMIN. DB-free.
// The scope writer (scope-assignment.service.ts) refuses COMPANY for any other
// role, but a row can still exist through direct SQL, legacy data or a future
// writer. buildAuthorizationContext is the single constructor behind HTTP
// (middleware/auth.ts), /login (auth.service.ts) and Socket.IO (socket.ts), so
// it must fail such a row closed PER ASSIGNMENT: no ProductionAssignment and no
// effectiveLocationIds expansion from it, while every valid assignment of the
// same user survives. The policy layer re-checks the same rule independently
// (authorization-policy.test.ts) — two lines of defense, two test suites.
// Kept apart from authorization-context.test.ts, whose middleware-wiring block
// needs a real database, so these cases run without one.
import { describe, expect, it, vi } from 'vitest';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';

const ACTIVE = ['loc-a', 'loc-b'];

function stubDb() {
  return { location: { findMany: vi.fn(async () => ACTIVE.map((id) => ({ id }))) } };
}

type RoleScope = Parameters<typeof buildAuthorizationContext>[1]['roleScopes'][number];

const scope = (code: string, scopeKind: 'LOCATION' | 'COMPANY', locationId: string | null, permissions: string[] = []): RoleScope => ({
  roleId: `role-${code.toLowerCase()}`,
  scopeKind,
  locationId,
  role: { code, permissions: permissions.map((permission) => ({ permission: { code: permission } })) },
});

const user = (roleScopes: RoleScope[]) => ({ id: 'user-1', branchRoles: [], roleScopes });

describe('buildAuthorizationContext — COMPANY only for OWNER/ADMIN (SECURITY-RBAC-01a)', () => {
  for (const code of ['CASHIER', 'SELLER', 'WAREHOUSE']) {
    it(`a ${code} + COMPANY row creates no assignment and never expands effectiveLocationIds`, async () => {
      const db = stubDb();
      const ctx = await buildAuthorizationContext(db, user([scope(code, 'COMPANY', null, ['SALE_VIEW'])]));
      expect(ctx.assignments).toEqual([]);
      expect(ctx.effectiveLocationIds).toEqual([]);
      expect(db.location.findMany).not.toHaveBeenCalled();
    });
  }

  it('keeps a valid SELLER @ loc-a while dropping an invalid CASHIER + COMPANY row on the same user', async () => {
    const db = stubDb();
    const ctx = await buildAuthorizationContext(db, user([
      scope('SELLER', 'LOCATION', 'loc-a', ['SALE_CREATE']),
      scope('CASHIER', 'COMPANY', null, ['SALE_CHARGE']),
    ]));
    expect(ctx.assignments).toEqual([
      { roleId: 'role-seller', roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: 'loc-a', permissions: ['SALE_CREATE'] },
    ]);
    expect(ctx.effectiveLocationIds).toEqual(['loc-a']);
    expect(db.location.findMany).not.toHaveBeenCalled();
  });

  for (const code of ['MANAGER', 'GHOST']) {
    it(`a ${code} (non-Production) + COMPANY row never expands effectiveLocationIds (F-07)`, async () => {
      const db = stubDb();
      const ctx = await buildAuthorizationContext(db, user([scope(code, 'COMPANY', null, ['SALE_VIEW'])]));
      expect(ctx.assignments).toEqual([]);
      expect(ctx.effectiveLocationIds).toEqual([]);
      expect(db.location.findMany).not.toHaveBeenCalled();
    });
  }

  it('a MANAGER (non-Production) + LOCATION row creates no assignment and contributes no effectiveLocationIds', async () => {
    const db = stubDb();
    const ctx = await buildAuthorizationContext(db, user([scope('MANAGER', 'LOCATION', 'loc-a', ['SALE_VIEW'])]));
    expect(ctx.assignments).toEqual([]);
    expect(ctx.effectiveLocationIds).toEqual([]);
    expect(db.location.findMany).not.toHaveBeenCalled();
  });

  for (const code of ['OWNER', 'ADMIN']) {
    it(`control: a valid ${code} + COMPANY row keeps its assignment and expands to every active location`, async () => {
      const db = stubDb();
      const ctx = await buildAuthorizationContext(db, user([scope(code, 'COMPANY', null, ['SALE_VIEW'])]));
      expect(ctx.assignments).toEqual([
        { roleId: `role-${code.toLowerCase()}`, roleCode: code, scopeKind: 'COMPANY', locationId: null, permissions: ['SALE_VIEW'] },
      ]);
      expect(ctx.effectiveLocationIds).toEqual(ACTIVE);
      expect(db.location.findMany).toHaveBeenCalledTimes(1);
    });
  }
});
