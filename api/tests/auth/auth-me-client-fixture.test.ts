// PILOT R-1 (OWNER 2026-10-18): the client cash tests must be fed what
// /auth/me can REALLY return. client/src/app/test-fixtures/auth-me.json holds
// the public { roles, permissions } of the canonical actors; this DB-free test
// recomputes each one through the real toPublicUserContext with the real
// catalogued grants and fails on any drift, so a client fixture can never again
// carry a permission the server never projects.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { toPublicUserContext, type PublicBranchLabel, type PublicSessionUser } from '../../src/modules/auth/user-context.dto.js';
import { login, resolveUserContext } from '../../src/modules/auth/auth.service.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'client', 'src', 'app', 'test-fixtures', 'auth-me.json');

type Actor = { roleCode: 'OWNER' | 'ADMIN' | 'CASHIER' | 'SELLER' | 'WAREHOUSE'; scopeKind: 'COMPANY' | 'LOCATION' };
const ACTORS: Record<string, Actor> = {
  OWNER: { roleCode: 'OWNER', scopeKind: 'COMPANY' },
  ADMIN_COMPANY: { roleCode: 'ADMIN', scopeKind: 'COMPANY' },
  ADMIN_LOCATION: { roleCode: 'ADMIN', scopeKind: 'LOCATION' },
  CASHIER: { roleCode: 'CASHIER', scopeKind: 'LOCATION' },
  SELLER: { roleCode: 'SELLER', scopeKind: 'LOCATION' },
  WAREHOUSE: { roleCode: 'WAREHOUSE', scopeKind: 'LOCATION' },
};

function projected({ roleCode, scopeKind }: Actor) {
  const location = scopeKind === 'LOCATION';
  const dto = toPublicUserContext(
    { id: 'u', name: roleCode, email: 'u@test.local', branchRoles: [] },
    {
      // CLIENT-CASH-UX: branch-1 is the ONLY active location in this fake
      // universe, exactly as AMF-03's resolveUserContext expansion validates;
      // passing it for COMPANY actors mirrors the real COMPANY→locations
      // lookup the branch-aware hints are computed over (permissions, which
      // never consults the expansion, is unchanged).
      effectiveLocationIds: ['branch-1'],
      assignments: [{
        roleId: `r-${roleCode}`, roleCode, scopeKind, locationId: location ? 'branch-1' : null,
        permissions: roleCode === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[roleCode]],
      }],
    },
  );
  return {
    roles: dto.roles,
    permissions: dto.permissions,
    cashMovementLocationIds: dto.cashMovementLocationIds,
    cashSupervisorLocationIds: dto.cashSupervisorLocationIds,
    inventoryManageLocationIds: dto.inventoryManageLocationIds,
    saleExchangeLocationIds: dto.saleExchangeLocationIds,
  };
}

describe('client /auth/me fixture = the real public projection', () => {
  it('AMF-01 every canonical actor in the client fixture equals toPublicUserContext output', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, {
      roles: string[]; permissions: string[]; cashMovementLocationIds: string[]; cashSupervisorLocationIds: string[]; inventoryManageLocationIds: string[]; saleExchangeLocationIds: string[];
    }>;
    expect(Object.keys(fixture).sort()).toEqual(Object.keys(ACTORS).sort());
    for (const [name, actor] of Object.entries(ACTORS)) {
      expect(fixture[name], name).toEqual(projected(actor));
    }
  });

  it('AMF-02 the cash movement panel gate is reachable for OWNER, COMPANY ADMIN and CASHIER, and not for SELLER', () => {
    for (const name of ['OWNER', 'ADMIN_COMPANY', 'CASHIER']) expect(projected(ACTORS[name]!).permissions, name).toContain('CASH_MOVEMENT_MANAGE');
    expect(projected(ACTORS.SELLER!).permissions).not.toContain('CASH_MOVEMENT_MANAGE');
  });

  // The SAME service /auth/me calls (resolveUserContext): RolePermission rows
  // as Prisma returns them -> buildAuthorizationContext -> toPublicUserContext.
  it('AMF-03 resolveUserContext over persisted role-scope rows returns exactly the fixture for every actor', async () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, {
      roles: string[]; permissions: string[]; cashMovementLocationIds: string[]; cashSupervisorLocationIds: string[]; inventoryManageLocationIds: string[]; saleExchangeLocationIds: string[];
    }>;
    for (const [name, { roleCode, scopeKind }] of Object.entries(ACTORS)) {
      const location = scopeKind === 'LOCATION';
      const row = {
        id: `user-${name}`, name, email: `${name}@test.local`, isActive: true, passwordHash: 'unused', branchRoles: [],
        roleScopes: [{
          roleId: `role-${roleCode}`, scopeKind, locationId: location ? 'branch-1' : null,
          role: { code: roleCode, permissions: (roleCode === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[roleCode]]).map((code) => ({ permission: { code } })) },
        }],
      };
      const database = {
        user: { findUnique: async () => row },
        location: { findMany: async () => [{ id: 'branch-1' }] },
      } as unknown as Parameters<typeof resolveUserContext>[0];
      const dto = await resolveUserContext(database, row.id);
      expect({
        roles: dto.roles,
        permissions: dto.permissions,
        cashMovementLocationIds: dto.cashMovementLocationIds,
        cashSupervisorLocationIds: dto.cashSupervisorLocationIds,
        inventoryManageLocationIds: dto.inventoryManageLocationIds,
        saleExchangeLocationIds: dto.saleExchangeLocationIds,
      }, name).toEqual(fixture[name]);
    }
  });

  // CLIENT-CASH-UX: the branch-aware arrays must separate the supervisor
  // audience (OWNER / COMPANY ADMIN — Retiro & Corregir visible) from the
  // manager audience (CASHIER, LOCATION ADMIN — Gasto/Historial visible,
  // never Retiro/Corregir), and never hand a hint to an actor with no
  // effective cash authority (SELLER).
  it('AMF-04 the hints separate supervisor from manager and stay empty for the unauthorized', () => {
    for (const name of ['OWNER', 'ADMIN_COMPANY']) {
      expect(projected(ACTORS[name]!).cashSupervisorLocationIds, name).toContain('branch-1');
    }
    for (const name of ['ADMIN_LOCATION', 'CASHIER']) {
      expect(projected(ACTORS[name]!).cashMovementLocationIds, name).toContain('branch-1');
      expect(projected(ACTORS[name]!).cashSupervisorLocationIds, name).toEqual([]);
    }
    expect(projected(ACTORS.SELLER!).cashMovementLocationIds).toEqual([]);
    expect(projected(ACTORS.SELLER!).cashSupervisorLocationIds).toEqual([]);
  });

  // WAREHOUSE-MVP: the Depósito gate is the branch-aware inventoryManageLocationIds
  // hint, never the role name and never the global `inventory.manage` alone.
  it('AMF-05 the inventory hint reaches OWNER, both ADMIN scopes and WAREHOUSE, and never SELLER or CASHIER', () => {
    for (const name of ['OWNER', 'ADMIN_COMPANY', 'ADMIN_LOCATION', 'WAREHOUSE']) {
      expect(projected(ACTORS[name]!).inventoryManageLocationIds, name).toContain('branch-1');
    }
    for (const name of ['SELLER', 'CASHIER']) expect(projected(ACTORS[name]!).inventoryManageLocationIds, name).toEqual([]);
  });

  // Sale exchange: the hint reaches the supervisor audience only.
  it('AMF-06 the sale exchange hint reaches OWNER and COMPANY ADMIN, and never a LOCATION ADMIN, CASHIER, SELLER or WAREHOUSE', () => {
    for (const name of ['OWNER', 'ADMIN_COMPANY']) expect(projected(ACTORS[name]!).saleExchangeLocationIds, name).toContain('branch-1');
    for (const name of ['ADMIN_LOCATION', 'CASHIER', 'SELLER', 'WAREHOUSE']) expect(projected(ACTORS[name]!).saleExchangeLocationIds, name).toEqual([]);
  });

  // BranchSelect labels: `branches` carries display data (id, name, code) ONLY for the caller's effective locations. It is never
  // authority: the selector options still come from branchIds.
  describe('branches (display labels for the selector)', () => {
    const LOCATIONS = [
      { id: 'branch-1', name: 'Sucursal Centro', code: 'CEN' },
      { id: 'branch-2', name: 'Sucursal Norte', code: 'NOR' },
      { id: 'branch-3', name: 'Sucursal Sur', code: 'SUR' },
    ];
    type Where = { id?: { in: string[] }; isActive?: boolean };
    function resolveFor(roleCode: Actor['roleCode'], scopeKind: Actor['scopeKind'], locationId: string | null) {
      const row = {
        id: 'user-x', name: 'X', email: 'x@test.local', isActive: true, passwordHash: 'unused', branchRoles: [],
        roleScopes: [{
          roleId: `role-${roleCode}`, scopeKind, locationId,
          role: { code: roleCode, permissions: (roleCode === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[roleCode]]).map((code) => ({ permission: { code } })) },
        }],
      };
      const findMany = async ({ where }: { where?: Where } = {}) => {
        const wanted = where?.id?.in;
        return LOCATIONS.filter((location) => !wanted || wanted.includes(location.id));
      };
      const database = { user: { findUnique: async () => row }, location: { findMany } } as unknown as Parameters<typeof resolveUserContext>[0];
      return resolveUserContext(database, row.id);
    }

    // The public contract DECLARES `branches` (no cast, no widening): what /auth/me and login return is exactly PublicSessionUser.
    it('AMF-07a the public /auth/me and login results are typed as PublicSessionUser, which declares branches', () => {
      expectTypeOf<Awaited<ReturnType<typeof resolveUserContext>>>().toEqualTypeOf<PublicSessionUser>();
      expectTypeOf<Awaited<ReturnType<typeof login>>['user']>().toEqualTypeOf<PublicSessionUser>();
      expectTypeOf<PublicSessionUser['branches']>().toEqualTypeOf<PublicBranchLabel[]>();
      expectTypeOf<PublicBranchLabel>().toEqualTypeOf<{ id: string; name: string; code: string }>();
      expect(true).toBe(true);
    });

    it('AMF-07 a LOCATION-scoped user gets the label of its own location only', async () => {
      const dto = await resolveFor('CASHIER', 'LOCATION', 'branch-1');
      expect(dto.branchIds).toEqual(['branch-1']);
      expect(dto.branches).toEqual([{ id: 'branch-1', name: 'Sucursal Centro', code: 'CEN' }]);
    });

    it('AMF-08 a COMPANY-scoped user gets one label per effective location, in branchIds order', async () => {
      const dto = await resolveFor('OWNER', 'COMPANY', null);
      expect(dto.branches.map((branch) => branch.id)).toEqual(dto.branchIds);
      expect(dto.branches).toHaveLength(3);
    });

    it('AMF-09 labels never name a location outside branchIds, and carry exactly {id, name, code}', async () => {
      const dto = await resolveFor('SELLER', 'LOCATION', 'branch-2');
      for (const branch of dto.branches) {
        expect(dto.branchIds).toContain(branch.id);
        expect(Object.keys(branch).sort()).toEqual(['code', 'id', 'name']);
      }
      expect(dto.branches.map((branch) => branch.id)).not.toContain('branch-1');
    });
  });
});
