import { describe, expect, it } from 'vitest';
import { toPublicUserContext } from '../../src/modules/auth/user-context.dto.js';

describe('toPublicUserContext (Phase 1D.1 compatibility adapter)', () => {
  it('maps effectiveLocationIds to branchIds and legacyPermissions to permissions', () => {
    const dto = toPublicUserContext(
      { id: 'u1', name: 'Seller', email: 's@test.local', branchRoles: [{ role: { code: 'SELLER' } }] },
      { effectiveLocationIds: ['loc-1'], legacyPermissions: ['sale.create'] },
    );
    expect(dto).toEqual({
      id: 'u1',
      name: 'Seller',
      email: 's@test.local',
      roles: ['SELLER'],
      branchIds: ['loc-1'],
      permissions: ['sale.create'],
    });
  });

  it('derives public roles from UserBranchRole only, never the internal legacy+Production union', () => {
    const dto = toPublicUserContext(
      { id: 'u2', name: 'Manager', email: 'm@test.local', branchRoles: [{ role: { code: 'MANAGER' } }] },
      { effectiveLocationIds: [], legacyPermissions: [] },
    );
    // The internal AuthContext.roles for this same user is
    // ['MANAGER', 'WAREHOUSE'] (legacy ∪ Production union — see
    // authorization-context.test.ts's MANAGER->WAREHOUSE desync test), but
    // the PUBLIC contract must keep exposing only the legacy UserBranchRole
    // code: admin/client were built against the pre-1D.1, UserBranchRole-only
    // meaning of `roles` and must not see it silently change shape.
    expect(dto.roles).toEqual(['MANAGER']);
  });

  it('never leaks internal-only keys (assignments, legacyPermissions, effectiveLocationIds) onto the public shape', () => {
    const dto = toPublicUserContext(
      { id: 'u3', name: 'X', email: 'x@test.local', branchRoles: [] },
      { effectiveLocationIds: [], legacyPermissions: [] },
    );
    expect(dto).not.toHaveProperty('assignments');
    expect(dto).not.toHaveProperty('legacyPermissions');
    expect(dto).not.toHaveProperty('effectiveLocationIds');
    expect(Object.keys(dto).sort()).toEqual(['branchIds', 'email', 'id', 'name', 'permissions', 'roles']);
  });
});
