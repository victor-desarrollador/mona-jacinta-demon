import { describe, expect, it } from 'vitest';
import {
  hasBranchAccess,
  hasPermission,
  hasPermissionAtLocation,
  isOwner,
  requiresCompanyScope,
} from '../../src/modules/rbac/authorization-policy.js';

// Phase 1D.2 — authorization-policy.ts is the ONLY place OWNER's implicit
// authority is recognized (docs/superpowers/plans/2026-09-14-phase-1d-production-
// authorization.md Cross-cutting design §B) and the ONLY place a permission
// and a location are evaluated together against the SAME assignment. These
// tests are the load-bearing proof for the rest of Phase 1D.

function ctx(assignments: Express.AuthContext['assignments']): Pick<Express.AuthContext, 'assignments'> {
  return { assignments };
}

const seller = {
  roleId: 'r1', roleCode: 'SELLER' as const, scopeKind: 'LOCATION' as const,
  locationId: 'A', permissions: ['SALE_CREATE'],
};
const warehouse = {
  roleId: 'r2', roleCode: 'WAREHOUSE' as const, scopeKind: 'LOCATION' as const,
  locationId: 'B', permissions: ['INVENTORY_MANAGE'],
};
// Canonical OWNER assignment: COMPANY scope, empty permissions — OWNER's
// implicit authority must never depend on RolePermission rows.
const owner = {
  roleId: 'r3', roleCode: 'OWNER' as const, scopeKind: 'COMPANY' as const,
  locationId: null, permissions: [],
};
// Malformed data: an OWNER-coded UserRoleScope row that is LOCATION-scoped.
// Per this phase's task brief, an OWNER assignment must be COMPANY scoped —
// this must fail closed, never silently broaden or narrow into ordinary
// LOCATION authority.
const ownerLocation = {
  roleId: 'r3x', roleCode: 'OWNER' as const, scopeKind: 'LOCATION' as const,
  locationId: 'X', permissions: [],
};
const adminCompany = {
  roleId: 'r4', roleCode: 'ADMIN' as const, scopeKind: 'COMPANY' as const,
  locationId: null, permissions: ['PRICE_MANAGE', 'SALE_VIEW'],
};
// Simulates the EXACT pre-backfill shape of a real ADMIN assignment: the
// Production catalog grants ADMIN all 33 permissions unconditionally,
// including PRICE_MANAGE, regardless of scopeKind — so this fixture's
// `permissions` array genuinely contains 'PRICE_MANAGE' even though it is
// LOCATION-scoped.
const adminLocation = {
  roleId: 'r5', roleCode: 'ADMIN' as const, scopeKind: 'LOCATION' as const,
  locationId: 'X', permissions: ['PRICE_MANAGE', 'SALE_VIEW'],
};

describe('requiresCompanyScope (Phase 1D.2)', () => {
  it('uses the existing canonical COMPANY_SCOPE_REQUIRED_FOR_ADMIN list — no parallel list', () => {
    expect(requiresCompanyScope('PRICE_MANAGE')).toBe(true);
    expect(requiresCompanyScope('PRODUCT_MANAGE')).toBe(true);
    expect(requiresCompanyScope('PRODUCT_VARIANT_MANAGE')).toBe(true);
    expect(requiresCompanyScope('SALE_CREATE')).toBe(false);
  });

  it('does NOT silently include USER_MANAGE (unresolved design question, not decided by this phase)', () => {
    expect(requiresCompanyScope('USER_MANAGE')).toBe(false);
  });
});

describe('isOwner (Phase 1D.2) — the ONLY place OWNER implicit authority is recognized', () => {
  it('[RED 1] is true for a COMPANY-scoped OWNER assignment, even with zero permissions', () => {
    expect(isOwner(ctx([owner]))).toBe(true);
  });

  it('[RED 2] is false for a LOCATION-scoped OWNER assignment — malformed data fails closed', () => {
    expect(isOwner(ctx([ownerLocation]))).toBe(false);
  });

  it('is false when no assignment carries roleCode OWNER', () => {
    expect(isOwner(ctx([seller]))).toBe(false);
  });

  it('[RED 15] is false for empty assignments', () => {
    expect(isOwner(ctx([]))).toBe(false);
  });
});

describe('hasPermission (Phase 1D.2)', () => {
  it('[RED 1] grants OWNER any permission with zero RolePermission rows anywhere', () => {
    expect(hasPermission(ctx([owner]), 'PRICE_MANAGE')).toBe(true);
    expect(hasPermission(ctx([owner]), 'SALE_CREATE')).toBe(true);
  });

  it('[RED 2] denies every permission for a malformed LOCATION-scoped OWNER row', () => {
    expect(hasPermission(ctx([ownerLocation]), 'PRICE_MANAGE')).toBe(false);
    expect(hasPermission(ctx([ownerLocation]), 'SALE_CREATE')).toBe(false);
  });

  it('[RED 3] ADMIN COMPANY assignment only gets permissions explicitly granted to its Role', () => {
    expect(hasPermission(ctx([adminCompany]), 'PRICE_MANAGE')).toBe(true);
    expect(hasPermission(ctx([adminCompany]), 'INVENTORY_MANAGE')).toBe(false); // not granted to this assignment
  });

  it('[RED 4] ADMIN does NOT inherit OWNER implicit authority — an ungranted permission stays denied even at COMPANY scope', () => {
    expect(hasPermission(ctx([adminCompany]), 'USER_MANAGE')).toBe(false);
  });

  it('checks across all assignments for a non-company-required permission, no location involved', () => {
    expect(hasPermission(ctx([seller, warehouse]), 'SALE_CREATE')).toBe(true);
    expect(hasPermission(ctx([seller, warehouse]), 'INVENTORY_MANAGE')).toBe(true);
    expect(hasPermission(ctx([seller, warehouse]), 'PRICE_MANAGE')).toBe(false);
  });

  it('[RED 10 / RED 12] LOCATION ADMIN carrying PRICE_MANAGE still fails the global check — no location argument does not rescue a COMPANY-required permission', () => {
    expect(hasPermission(ctx([adminLocation]), 'PRICE_MANAGE')).toBe(false);
  });

  it('[RED 11] COMPANY ADMIN carrying PRICE_MANAGE passes the global check', () => {
    expect(hasPermission(ctx([adminCompany]), 'PRICE_MANAGE')).toBe(true);
  });

  it('a non-company-required permission held by a LOCATION assignment DOES pass the global (no-location) check', () => {
    expect(hasPermission(ctx([adminLocation]), 'SALE_VIEW')).toBe(true);
  });

  it('[RED 15] empty assignments -> false for any permission', () => {
    expect(hasPermission(ctx([]), 'SALE_CREATE')).toBe(false);
    expect(hasPermission(ctx([]), 'PRICE_MANAGE')).toBe(false);
  });

  it('[RED 16] empty assignments never influence the decision — policy only ever reads assignments (legacyPermissions no longer exists on the context at all, Phase 1D.3.6)', () => {
    const full: Express.AuthContext = {
      userId: 'u1',
      roles: [],
      assignments: [],
      effectiveLocationIds: [],
    };
    expect(hasPermission(full, 'SALE_CREATE')).toBe(false);
  });

  it('[RED 17] a display-only roles[] union containing OWNER never influences the decision — only assignments are read', () => {
    const full: Express.AuthContext = {
      userId: 'u1',
      roles: ['OWNER'], // display-only, no OWNER assignment backing it
      assignments: [],
      effectiveLocationIds: [],
    };
    expect(isOwner(full)).toBe(false);
    expect(hasPermission(full, 'PRICE_MANAGE')).toBe(false);
  });
});

describe('hasPermissionAtLocation (Phase 1D.2) — the cross-assignment composition guard', () => {
  it('[RED 5] LOCATION SELLER@A with SALE_CREATE authorizes SALE_CREATE@A', () => {
    expect(hasPermissionAtLocation(ctx([seller]), 'SALE_CREATE', 'A')).toBe(true);
  });

  it('[RED 6] SELLER@A cannot authorize SALE_CREATE@B', () => {
    expect(hasPermissionAtLocation(ctx([seller]), 'SALE_CREATE', 'B')).toBe(false);
  });

  it('[RED 7] cross-assignment attack is impossible: SELLER@A has SALE_CREATE, WAREHOUSE@B exists -> SALE_CREATE@B is false', () => {
    const twoAssignments = ctx([seller, warehouse]);
    expect(hasPermissionAtLocation(twoAssignments, 'SALE_CREATE', 'B')).toBe(false);
  });

  it('[RED 8] the inverse cross-assignment composition is also impossible: INVENTORY_MANAGE@A is false', () => {
    const twoAssignments = ctx([seller, warehouse]);
    expect(hasPermissionAtLocation(twoAssignments, 'INVENTORY_MANAGE', 'A')).toBe(false);
  });

  it('the full SELLER@A + WAREHOUSE@B matrix', () => {
    const twoAssignments = ctx([seller, warehouse]);
    expect(hasPermissionAtLocation(twoAssignments, 'SALE_CREATE', 'A')).toBe(true);
    expect(hasPermissionAtLocation(twoAssignments, 'SALE_CREATE', 'B')).toBe(false);
    expect(hasPermissionAtLocation(twoAssignments, 'INVENTORY_MANAGE', 'B')).toBe(true);
    expect(hasPermissionAtLocation(twoAssignments, 'INVENTORY_MANAGE', 'A')).toBe(false);
  });

  it('[RED 9] a COMPANY assignment with a location-scoped (non-company-required) permission satisfies it at any concrete location', () => {
    expect(hasPermissionAtLocation(ctx([adminCompany]), 'SALE_VIEW', 'any-location')).toBe(true);
  });

  it('[RED 10] LOCATION ADMIN carrying PRICE_MANAGE fails even at its own matching location', () => {
    expect(hasPermissionAtLocation(ctx([adminLocation]), 'PRICE_MANAGE', 'X')).toBe(false);
  });

  it('[RED 11] COMPANY ADMIN carrying PRICE_MANAGE passes at any location', () => {
    expect(hasPermissionAtLocation(ctx([adminCompany]), 'PRICE_MANAGE', 'literally-any-uuid')).toBe(true);
  });

  it('a COMPANY assignment does NOT qualify for a permission it does not itself grant, even if a co-existing LOCATION assignment grants it elsewhere', () => {
    expect(hasPermissionAtLocation(ctx([adminCompany, seller]), 'SALE_CREATE', 'B')).toBe(false);
  });

  it('[RED 1] OWNER passes regardless of location', () => {
    expect(hasPermissionAtLocation(ctx([owner]), 'PRICE_MANAGE', 'anything')).toBe(true);
  });

  it('[RED 2] a malformed LOCATION-scoped OWNER row fails closed at its own matching location too', () => {
    expect(hasPermissionAtLocation(ctx([ownerLocation]), 'PRICE_MANAGE', 'X')).toBe(false);
  });

  it('rejects an empty locationId even for OWNER — never invents a sentinel', () => {
    expect(hasPermissionAtLocation(ctx([owner]), 'PRICE_MANAGE', '')).toBe(false);
  });

  it('[RED 15] empty assignments -> false', () => {
    expect(hasPermissionAtLocation(ctx([]), 'SALE_CREATE', 'A')).toBe(false);
  });

  it('[RED 12] does not allow a LOCATION assignment to satisfy a company-required permission merely because a location argument happens to match', () => {
    // adminLocation's own locationId IS 'X' and it DOES hold PRICE_MANAGE in
    // its permissions array — matching the location must not rescue it.
    expect(hasPermissionAtLocation(ctx([adminLocation]), 'PRICE_MANAGE', 'X')).toBe(false);
  });
});

describe('hasBranchAccess (Phase 1D.2) — coarse membership only, never a permission decision', () => {
  it('[RED 13] LOCATION A -> true, B -> false', () => {
    expect(hasBranchAccess(ctx([seller]), 'A')).toBe(true);
    expect(hasBranchAccess(ctx([seller]), 'B')).toBe(false);
  });

  it('[RED 14] a COMPANY assignment authorizes any location', () => {
    expect(hasBranchAccess(ctx([adminCompany]), 'literally-anything')).toBe(true);
  });

  it('OWNER authorizes any location', () => {
    expect(hasBranchAccess(ctx([owner]), 'literally-anything')).toBe(true);
  });

  it('[RED 15] empty assignments -> false', () => {
    expect(hasBranchAccess(ctx([]), 'A')).toBe(false);
  });

  it('rejects an empty locationId — never invents a sentinel', () => {
    expect(hasBranchAccess(ctx([owner]), '')).toBe(false);
  });

  it('[FIX 1 / 1] a malformed LOCATION-scoped OWNER row grants NO branch access at its own matching location', () => {
    expect(hasBranchAccess(ctx([ownerLocation]), 'X')).toBe(false);
  });

  it('[FIX 1 / 2] a malformed LOCATION-scoped OWNER row grants no branch access anywhere else either', () => {
    expect(hasBranchAccess(ctx([ownerLocation]), 'some-other-location')).toBe(false);
  });

  it('[FIX 1 / 3] a valid COMPANY-scoped OWNER assignment still authorizes any location (control case, unchanged)', () => {
    expect(hasBranchAccess(ctx([owner]), 'any-valid-location')).toBe(true);
  });

  it('[FIX 1 / 4] a malformed OWNER assignment contributes zero authority PER ASSIGNMENT, never denying an independent valid assignment on the same user', () => {
    const mixed = ctx([ownerLocation, seller]); // malformed OWNER@X + valid SELLER@A
    expect(hasBranchAccess(mixed, 'X')).toBe(false); // malformed OWNER@X contributes nothing
    expect(hasBranchAccess(mixed, 'A')).toBe(true); // SELLER@A still grants A normally
  });
});
