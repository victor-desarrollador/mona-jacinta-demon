import { describe, expect, it } from 'vitest';
import { toPublicUserContext } from '../../src/modules/auth/user-context.dto.js';

function assignment(overrides: Partial<Express.ProductionAssignment> = {}): Express.ProductionAssignment {
  return { roleId: 'r1', roleCode: 'ADMIN', scopeKind: 'LOCATION', locationId: 'loc-1', permissions: [], ...overrides };
}

describe('toPublicUserContext (Production authority projection, Phase 1D.3.6)', () => {
  it('maps effectiveLocationIds to branchIds and projects public permissions from the caller\'s Production assignments, via the explicit 12-code compatibility mapping', () => {
    const dto = toPublicUserContext(
      { id: 'u1', name: 'Admin', email: 'a@test.local', branchRoles: [{ role: { code: 'ADMIN' } }] },
      {
        effectiveLocationIds: ['loc-1'],
        assignments: [assignment({ permissions: ['REPORT_VIEW', 'USER_MANAGE'] })],
      },
    );
    expect(dto).toEqual({
      id: 'u1',
      name: 'Admin',
      email: 'a@test.local',
      roles: ['ADMIN'],
      branchIds: ['loc-1'],
      // Deterministic mapping order (USER_MANAGE precedes REPORT_VIEW in the
      // explicit 12-code table), never alphabetical or insertion order.
      permissions: ['user.manage', 'report.view'],
    });
  });

  it('derives public roles from UserBranchRole only, never the internal legacy+Production union', () => {
    const dto = toPublicUserContext(
      { id: 'u2', name: 'Manager', email: 'm@test.local', branchRoles: [{ role: { code: 'MANAGER' } }] },
      { effectiveLocationIds: [], assignments: [] },
    );
    // The internal AuthContext.roles for this same user would be
    // ['MANAGER', 'WAREHOUSE'] (legacy ∪ Production union), but the PUBLIC
    // contract must keep exposing only the legacy UserBranchRole code:
    // admin/client were built against the pre-1D.1, UserBranchRole-only
    // meaning of `roles` and must not see it silently change shape.
    expect(dto.roles).toEqual(['MANAGER']);
  });

  // Phase 1D.3.6 correction: a legacy UserBranchRole grant (even for a Role
  // carrying lowercase report.view/user.manage/audit.view in the DB) can
  // never contribute to the public `permissions` field — only the caller's
  // actual Production assignment(s) can. MANAGER maps to Production
  // WAREHOUSE (legacy-role-map.ts), which carries only INVENTORY_MANAGE
  // among the 12 mapped compatibility permissions.
  it('a legacy MANAGER UserBranchRole cannot grant public permissions — only the caller\'s Production assignment can', () => {
    const dto = toPublicUserContext(
      { id: 'u4', name: 'Manager', email: 'manager@test.local', branchRoles: [{ role: { code: 'MANAGER' } }] },
      { effectiveLocationIds: ['loc-1'], assignments: [assignment({ roleCode: 'WAREHOUSE', permissions: ['INVENTORY_MANAGE'] })] },
    );
    expect(dto.permissions).toEqual(['inventory.manage']);
    expect(dto.permissions).not.toContain('report.view');
    expect(dto.permissions).not.toContain('user.manage');
    expect(dto.permissions).not.toContain('audit.view');
  });

  it('projects all 12 compatibility permissions for OWNER via implicit authority, even with zero RolePermission grants', () => {
    const dto = toPublicUserContext(
      { id: 'u5', name: 'Owner', email: 'owner@test.local', branchRoles: [] },
      {
        effectiveLocationIds: [],
        assignments: [assignment({ roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] })],
      },
    );
    expect(dto.permissions.slice().sort()).toEqual(
      [
        'audit.view', 'cash.session.close', 'cash.session.open', 'inventory.manage', 'inventory.view',
        'report.view', 'sale.charge', 'sale.complete', 'sale.create', 'sale.queue.view', 'sale.view', 'user.manage',
      ].sort(),
    );
  });

  it('never leaks internal-only keys (assignments, legacyPermissions, effectiveLocationIds) onto the public shape', () => {
    const dto = toPublicUserContext(
      { id: 'u3', name: 'X', email: 'x@test.local', branchRoles: [] },
      { effectiveLocationIds: [], assignments: [] },
    );
    expect(dto).not.toHaveProperty('assignments');
    expect(dto).not.toHaveProperty('legacyPermissions');
    expect(dto).not.toHaveProperty('effectiveLocationIds');
    expect(Object.keys(dto).sort()).toEqual(['branchIds', 'email', 'id', 'name', 'permissions', 'roles']);
  });
});
