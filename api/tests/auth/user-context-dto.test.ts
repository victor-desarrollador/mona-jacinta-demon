import { describe, expect, it } from 'vitest';
import { toPublicUserContext } from '../../src/modules/auth/user-context.dto.js';

function assignment(overrides: Partial<Express.ProductionAssignment> = {}): Express.ProductionAssignment {
  return { roleId: 'r1', roleCode: 'ADMIN', scopeKind: 'LOCATION', locationId: 'loc-1', permissions: [], ...overrides };
}

describe('toPublicUserContext (Production authority projection, Phase 1D.3.6)', () => {
  // GC2 (Phase 1 Global Closeout): USER_MANAGE is now COMPANY-required
  // (permissions.ts's COMPANY_SCOPE_REQUIRED_FOR_ADMIN), enforced centrally by
  // hasPermission(). A transitional LOCATION-scoped assignment structurally
  // carries USER_MANAGE in its `permissions` array but must not project
  // user.manage publicly — only REPORT_VIEW (not COMPANY-required) still does.
  it('a transitional LOCATION-scoped ADMIN assignment projects report.view but not user.manage (USER_MANAGE is COMPANY-required)', () => {
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
      permissions: ['report.view'],
    });
  });

  // GC2 companion proof: the canonical, non-transitional ADMIN COMPANY
  // assignment retains the exact user.manage projection the transitional
  // LOCATION case above no longer has.
  it('a canonical COMPANY-scoped ADMIN assignment projects both report.view and user.manage', () => {
    const dto = toPublicUserContext(
      { id: 'u1', name: 'Admin', email: 'a@test.local', branchRoles: [{ role: { code: 'ADMIN' } }] },
      {
        effectiveLocationIds: [],
        assignments: [
          assignment({ scopeKind: 'COMPANY', locationId: null, permissions: ['REPORT_VIEW', 'USER_MANAGE'] }),
        ],
      },
    );
    expect(dto.permissions).toContain('report.view');
    expect(dto.permissions).toContain('user.manage');
  });

  // D1 (Phase 1 Global Closeout): a canonical Production user with ZERO
  // UserBranchRole rows (e.g. the canonical OWNER, or ADMIN once corrected
  // to COMPANY, or any live-DEV-recovered Production-only user) must still
  // publicly project their real role — the pre-D1 UserBranchRole-only
  // derivation returns roles: [] for exactly this case, which is the
  // confirmed compatibility bug this task fixes.
  it('projects OWNER from a Production COMPANY assignment even with zero UserBranchRole rows', () => {
    const dto = toPublicUserContext(
      { id: 'u-owner', name: 'Owner', email: 'owner@test.local', branchRoles: [] },
      {
        effectiveLocationIds: [],
        assignments: [assignment({ roleId: 'r-owner', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] })],
      },
    );
    expect(dto.roles).toEqual(['OWNER']);
  });

  // D1 (Phase 1 Global Closeout): supersedes the pre-D1 contract test this
  // used to be ("derives public roles from UserBranchRole only, never the
  // internal legacy+Production union") — that contract is exactly what
  // caused the confirmed compatibility bug (a canonical Production user
  // with zero UserBranchRole rows publicly showed roles: []). `roles` now
  // derives from Production assignments only; a legacy MANAGER
  // UserBranchRole row, with zero Production assignments, must project no
  // Production role at all — never 'MANAGER' (never a Production role
  // code) and never anything else. MANAGER migration semantics (whether/how
  // a legacy MANAGER row should eventually gain Production authority) are
  // explicitly out of scope for D1.
  it('derives public roles from Production assignments only, never from UserBranchRole (legacy MANAGER projects nothing)', () => {
    const dto = toPublicUserContext(
      { id: 'u2', name: 'Manager', email: 'm@test.local', branchRoles: [{ role: { code: 'MANAGER' } }] },
      { effectiveLocationIds: [], assignments: [] },
    );
    expect(dto.roles).toEqual([]);
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

  // D3: the projection was extended additively with the four Production
  // catalogue/stock codes the admin UI needs; the 12 compatibility strings
  // are unchanged and still come first, in their frozen order.
  it('projects all 12 compatibility permissions plus the 4 D3 Production codes for OWNER via implicit authority, even with zero RolePermission grants', () => {
    const dto = toPublicUserContext(
      { id: 'u5', name: 'Owner', email: 'owner@test.local', branchRoles: [] },
      {
        effectiveLocationIds: [],
        assignments: [assignment({ roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] })],
      },
    );
    expect(dto.permissions).toEqual([
      'sale.create', 'sale.charge', 'sale.complete', 'sale.view', 'sale.queue.view', 'inventory.view',
      'inventory.manage', 'cash.session.open', 'cash.session.close', 'user.manage', 'report.view', 'audit.view',
      'PRODUCT_MANAGE', 'PRODUCT_VARIANT_MANAGE', 'PRICE_MANAGE', 'IMPORT_RUN',
    ]);
  });

  // D3: the additive codes go through the same centralized hasPermission
  // policy as the compatibility map — COMPANY-required catalogue codes never
  // project for a LOCATION-scoped ADMIN, while IMPORT_RUN (not
  // COMPANY-required) does. The internal context never leaks.
  it('projects D3 catalogue codes only for a COMPANY assignment, IMPORT_RUN for LOCATION too, and never leaks internal context', () => {
    const d3Codes = ['PRODUCT_MANAGE', 'PRODUCT_VARIANT_MANAGE', 'PRICE_MANAGE', 'IMPORT_RUN'];
    const company = toPublicUserContext(
      { id: 'u7', name: 'Admin', email: 'a@test.local', branchRoles: [] },
      { effectiveLocationIds: [], assignments: [assignment({ scopeKind: 'COMPANY', locationId: null, permissions: d3Codes })] },
    );
    expect(company.permissions).toEqual(d3Codes);
    expect(Object.keys(company).sort()).toEqual(['branchIds', 'email', 'id', 'name', 'permissions', 'roles']);

    const location = toPublicUserContext(
      { id: 'u8', name: 'Admin', email: 'l@test.local', branchRoles: [] },
      { effectiveLocationIds: ['loc-1'], assignments: [assignment({ permissions: d3Codes })] },
    );
    expect(location.permissions).toEqual(['IMPORT_RUN']);

    const manager = toPublicUserContext(
      { id: 'u9', name: 'Manager', email: 'm@test.local', branchRoles: [{ role: { code: 'MANAGER' } }] },
      { effectiveLocationIds: [], assignments: [] },
    );
    expect(manager).toMatchObject({ roles: [], permissions: [] });
  });

  // D1: multi-assignment users must see every distinct Production role code
  // exactly once — never a duplicate for two assignments of the same role
  // (e.g. CASHIER at two locations), and never a role missing because a
  // second, different-role assignment overwrote it.
  it('deduplicates a repeated role code and includes every distinct role for a multi-assignment user', () => {
    const dto = toPublicUserContext(
      { id: 'u6', name: 'Multi', email: 'multi@test.local', branchRoles: [] },
      {
        effectiveLocationIds: ['loc-1', 'loc-2'],
        assignments: [
          assignment({ roleId: 'r-cashier-1', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: 'loc-1' }),
          assignment({ roleId: 'r-cashier-2', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: 'loc-2' }),
          assignment({ roleId: 'r-seller', roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: 'loc-1' }),
        ],
      },
    );
    expect(dto.roles).toEqual(['CASHIER', 'SELLER']);
  });

  // Review correction (LOW #3): `roles` must be ordered by the canonical
  // Production role catalog (rbac/roles.ts's roleCodeValues: OWNER, ADMIN,
  // CASHIER, SELLER, WAREHOUSE), never by UserRoleScope row/database order.
  // Assignments are supplied here in a deliberately non-canonical order
  // (WAREHOUSE, then OWNER, then CASHIER) to prove the projection sorts them
  // rather than merely deduplicating in insertion order.
  it('orders public roles by the canonical Production role catalog regardless of assignment order', () => {
    const dto = toPublicUserContext(
      { id: 'u7', name: 'Multi', email: 'multi-order@test.local', branchRoles: [] },
      {
        effectiveLocationIds: ['loc-1'],
        assignments: [
          assignment({ roleId: 'r-warehouse', roleCode: 'WAREHOUSE', scopeKind: 'LOCATION', locationId: 'loc-1' }),
          assignment({ roleId: 'r-owner', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null }),
          assignment({ roleId: 'r-cashier', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: 'loc-1' }),
        ],
      },
    );
    expect(dto.roles).toEqual(['OWNER', 'CASHIER', 'WAREHOUSE']);
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
