import { describe, expect, it } from 'vitest';
import { toPublicUserContext } from '../../src/modules/auth/user-context.dto.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';

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
      cashMovementLocationIds: [],
      cashSupervisorLocationIds: [],
      inventoryManageLocationIds: [],
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
  // PILOT R-1 (OWNER 2026-10-18): CASH_MOVEMENT_MANAGE is appended after the
  // D3 codes; the 16 earlier strings keep their exact order.
  it('projects all 12 compatibility permissions, the 4 D3 Production codes and CASH_MOVEMENT_MANAGE for OWNER via implicit authority, even with zero RolePermission grants', () => {
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
      'PRODUCT_MANAGE', 'PRODUCT_VARIANT_MANAGE', 'PRICE_MANAGE', 'IMPORT_RUN', 'CASH_MOVEMENT_MANAGE',
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
    expect(Object.keys(company).sort()).toEqual([
      'branchIds', 'cashMovementLocationIds', 'cashSupervisorLocationIds', 'email', 'id', 'inventoryManageLocationIds', 'name', 'permissions', 'roles',
    ]);

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

  // PILOT R-1: the cash movement panel is gated on CASH_MOVEMENT_MANAGE, which
  // the public projection must expose exactly when it is already EFFECTIVE —
  // through the same hasPermission policy, never fabricated. Projection only:
  // the supervisor rule stays server-side (cash.service.ts).
  describe('R-1 CASH_MOVEMENT_MANAGE public projection', () => {
    const real = (roleCode: 'ADMIN' | 'CASHIER' | 'SELLER' | 'WAREHOUSE', scopeKind: 'COMPANY' | 'LOCATION') => toPublicUserContext(
      { id: `u-${roleCode}`, name: roleCode, email: `${roleCode}@test.local`, branchRoles: [] },
      {
        effectiveLocationIds: scopeKind === 'LOCATION' ? ['loc-1'] : [],
        assignments: [assignment({
          roleCode, scopeKind, locationId: scopeKind === 'LOCATION' ? 'loc-1' : null, permissions: [...DEFAULT_ROLE_GRANTS[roleCode]],
        })],
      },
    ).permissions;

    it('R1-01 a COMPANY-scoped ADMIN with its real grants projects CASH_MOVEMENT_MANAGE', () => {
      expect(real('ADMIN', 'COMPANY')).toContain('CASH_MOVEMENT_MANAGE');
    });

    it('R1-02 a LOCATION CASHIER (real catalogued grant) and a LOCATION ADMIN project it: it is effective for them (expense, history)', () => {
      expect(real('CASHIER', 'LOCATION')).toContain('CASH_MOVEMENT_MANAGE');
      expect(real('ADMIN', 'LOCATION')).toContain('CASH_MOVEMENT_MANAGE');
    });

    it('R1-03 never fabricated: SELLER, WAREHOUSE, no assignment, or an assignment lacking the grant project nothing', () => {
      expect(real('SELLER', 'LOCATION')).not.toContain('CASH_MOVEMENT_MANAGE');
      expect(real('WAREHOUSE', 'LOCATION')).not.toContain('CASH_MOVEMENT_MANAGE');
      const none = toPublicUserContext({ id: 'u', name: 'N', email: 'n@test.local', branchRoles: [] }, { effectiveLocationIds: [], assignments: [] });
      expect(none.permissions).toEqual([]);
      const stripped = toPublicUserContext(
        { id: 'u', name: 'C', email: 'c@test.local', branchRoles: [] },
        { effectiveLocationIds: ['loc-1'], assignments: [assignment({ roleCode: 'CASHIER', permissions: DEFAULT_ROLE_GRANTS.CASHIER.filter((p) => p !== 'CASH_MOVEMENT_MANAGE') })] },
      );
      expect(stripped.permissions).not.toContain('CASH_MOVEMENT_MANAGE');
    });

    it('R1-04 the earlier public strings are unchanged: removing CASH_MOVEMENT_MANAGE leaves exactly the previous projection', () => {
      for (const [roleCode, scopeKind] of [['ADMIN', 'COMPANY'], ['CASHIER', 'LOCATION'], ['SELLER', 'LOCATION']] as const) {
        const projected = real(roleCode, scopeKind);
        expect(projected.filter((p) => p === 'CASH_MOVEMENT_MANAGE').length).toBeLessThanOrEqual(1);
        if (projected.includes('CASH_MOVEMENT_MANAGE')) expect(projected.at(-1)).toBe('CASH_MOVEMENT_MANAGE');
      }
      expect(real('CASHIER', 'LOCATION')).toEqual([
        'sale.charge', 'sale.complete', 'sale.view', 'sale.queue.view', 'inventory.view', 'cash.session.open', 'cash.session.close',
        'CASH_MOVEMENT_MANAGE',
      ]);
    });
  });

  // CLIENT-CASH-UX (2026-10-19, branch-aware cash permissions mini-slice):
  // the public contract gains two server-computed, branch-aware UI HINTS:
  //   - cashMovementLocationIds: where CASH_MOVEMENT_MANAGE is EFFECTIVE at a
  //     location (authorizedLocationIds' exact bounded semantics);
  //   - cashSupervisorLocationIds: where the caller acts as the cash
  //     supervisor (actsAsSupervisorAtLocation's exact semantics, i.e. OWNER,
  //     or a COMPANY-scoped ADMIN holding the grant — never a LOCATION role).
  // Both are visibility hints ONLY: hasPermissionAtLocation /
  // actsAsSupervisorAtLocation stay the sole endpoint-enforced authority.
  const MVM = 'CASH_MOVEMENT_MANAGE';
  const dtoFor = (effectiveLocationIds: string[], assignments: Express.ProductionAssignment[]) => toPublicUserContext(
    { id: 'u', name: 'U', email: 'u@test.local', branchRoles: [] },
    { effectiveLocationIds, assignments },
  );

  describe('branch-aware cash movement location hints (AUTH-BR-01..08)', () => {
    it('AUTH-BR-01 a CASHIER holding the grant at A plus a SELLER at B projects cashMovementLocationIds exactly [A] and no supervision', () => {
      const dto = dtoFor(['A', 'B'], [
        assignment({ roleId: 'r-cashier', roleCode: 'CASHIER', locationId: 'A', permissions: [MVM, 'CASH_SESSION_OPEN'] }),
        assignment({ roleId: 'r-seller', roleCode: 'SELLER', locationId: 'B', permissions: ['SALE_CREATE'] }),
      ]);
      expect(dto.cashMovementLocationIds).toEqual(['A']);
      expect(dto.cashSupervisorLocationIds).toEqual([]);
    });

    it('AUTH-BR-02 a COMPANY-scoped ADMIN with its real grants is supervisor and manager at every effectively valid branch', () => {
      const dto = dtoFor(['A', 'B'], [
        assignment({ roleId: 'r-admin', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] }),
      ]);
      expect(dto.cashMovementLocationIds).toEqual(['A', 'B']);
      expect(dto.cashSupervisorLocationIds).toEqual(['A', 'B']);
    });

    it('AUTH-BR-03 a LOCATION-scoped ADMIN at A manages there (Gasto/Historial) but NEVER supervises there', () => {
      const dto = dtoFor(['A'], [
        assignment({ roleId: 'r-admin', roleCode: 'ADMIN', locationId: 'A', permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] }),
      ]);
      expect(dto.cashMovementLocationIds).toEqual(['A']);
      expect(dto.cashSupervisorLocationIds).toEqual([]);
    });

    it('AUTH-BR-04 a canonical COMPANY OWNER supervises and manages at every effectively valid branch with zero RolePermission rows', () => {
      const dto = dtoFor(['A', 'B'], [
        assignment({ roleId: 'r-owner', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }),
      ]);
      expect(dto.cashMovementLocationIds).toEqual(['A', 'B']);
      expect(dto.cashSupervisorLocationIds).toEqual(['A', 'B']);
    });

    it('AUTH-BR-05 a malformed LOCATION-scoped OWNER never supervises and never widens its grant beyond its own location (no implicit authority)', () => {
      const withGrant = dtoFor(['A', 'B'], [
        assignment({ roleId: 'r-owner-x', roleCode: 'OWNER', locationId: 'A', permissions: [MVM] }),
      ]);
      expect(withGrant.cashSupervisorLocationIds).toEqual([]);
      expect(withGrant.cashMovementLocationIds).toEqual(['A']);
      // Without a persisted grant even its own location contributes nothing —
      // OWNER's implicit authority only exists through a valid COMPANY row.
      const rodlessGrant = dtoFor(['A', 'B'], [
        assignment({ roleId: 'r-owner-x', roleCode: 'OWNER', locationId: 'A', permissions: [] }),
      ]);
      expect(rodlessGrant.cashMovementLocationIds).toEqual([]);
      expect(rodlessGrant.cashSupervisorLocationIds).toEqual([]);
    });

    it('AUTH-BR-06 an actor without the grant projects both cash arrays empty, whatever locations it holds', () => {
      const dto = dtoFor(['A'], [
        assignment({ roleId: 'r-seller', roleCode: 'SELLER', locationId: 'A', permissions: ['SALE_CREATE', 'SALE_VIEW'] }),
      ]);
      expect(dto.cashMovementLocationIds).toEqual([]);
      expect(dto.cashSupervisorLocationIds).toEqual([]);
    });

    it('AUTH-BR-07 nothing is fabricated outside the effective location universe — a COMPANY assignment that would cover any string stays bounded by it', () => {
      // One active location exists; a COMPANY ADMIN/OWNER would qualify for
      // literally any non-empty locationId string (policy module contract), so
      // the lists must be exactly the effective universe, never wider.
      for (const roleCode of ['ADMIN', 'OWNER'] as const) {
        const dto = dtoFor(['A'], [
          assignment({
            roleId: `r-${roleCode}`, roleCode, scopeKind: 'COMPANY', locationId: null,
            permissions: roleCode === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS.ADMIN],
          }),
        ]);
        expect(dto.cashMovementLocationIds, roleCode).toEqual(['A']);
        expect(dto.cashSupervisorLocationIds, roleCode).toEqual(['A']);
      }
    });

    it('AUTH-BR-07b both lists follow effectiveLocationIds order and appear exactly once (deterministic, deduplicated)', () => {
      const dto = dtoFor(['B', 'A', 'A'], [
        assignment({ roleId: 'r-owner', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }),
      ]);
      expect(dto.cashMovementLocationIds).toEqual(['B', 'A']);
      expect(dto.cashSupervisorLocationIds).toEqual(['B', 'A']);
    });

    it('AUTH-BR-08 fully additive: the pre-existing public projection is unchanged and the two new hints ride along', () => {
      // The exact projection pinned by R1-04 for a real-grants CASHIER.
      const dto = toPublicUserContext(
        { id: 'u', name: 'C', email: 'c@test.local', branchRoles: [] },
        {
          effectiveLocationIds: ['loc-1'],
          assignments: [assignment({ roleId: 'r-cashier', roleCode: 'CASHIER', locationId: 'loc-1', permissions: [...DEFAULT_ROLE_GRANTS.CASHIER] })],
        },
      );
      expect(dto.roles).toEqual(['CASHIER']);
      expect(dto.branchIds).toEqual(['loc-1']);
      expect(dto.permissions).toEqual([
        'sale.charge', 'sale.complete', 'sale.view', 'sale.queue.view', 'inventory.view', 'cash.session.open', 'cash.session.close',
        'CASH_MOVEMENT_MANAGE',
      ]);
      // The hints: the CASHIER manages at its own location only, never
      // supervises anywhere.
      expect(dto.cashMovementLocationIds).toEqual(['loc-1']);
      expect(dto.cashSupervisorLocationIds).toEqual([]);
      expect(Object.keys(dto).sort()).toEqual([
        'branchIds', 'cashMovementLocationIds', 'cashSupervisorLocationIds', 'email', 'id', 'inventoryManageLocationIds', 'name', 'permissions', 'roles',
      ]);
    });
  });

  it('never leaks internal-only keys (assignments, legacyPermissions, effectiveLocationIds) onto the public shape', () => {
    const dto = toPublicUserContext(
      { id: 'u3', name: 'X', email: 'x@test.local', branchRoles: [] },
      { effectiveLocationIds: [], assignments: [] },
    );
    expect(dto).not.toHaveProperty('assignments');
    expect(dto).not.toHaveProperty('legacyPermissions');
    expect(dto).not.toHaveProperty('effectiveLocationIds');
    expect(Object.keys(dto).sort()).toEqual([
      'branchIds', 'cashMovementLocationIds', 'cashSupervisorLocationIds', 'email', 'id', 'inventoryManageLocationIds', 'name', 'permissions', 'roles',
    ]);
  });

  // WAREHOUSE-MVP: a third additive, server-computed UI HINT. inventoryManageLocationIds
  // lists the locations where INVENTORY_MANAGE is EFFECTIVE (authorizedLocationIds'
  // bounded semantics: same-assignment pairing over the effective location universe).
  // Visibility only: POST /inventory/adjustments and GET /inventory/stock keep
  // enforcing hasPermissionAtLocation server-side.
  describe('inventory manage location hint (WAREHOUSE-MVP, INV-HINT-01..05)', () => {
    const IM = 'INVENTORY_MANAGE';
    const hintFor = (effectiveLocationIds: string[], assignments: Express.ProductionAssignment[]) => toPublicUserContext(
      { id: 'u', name: 'U', email: 'u@test.local', branchRoles: [] },
      { effectiveLocationIds, assignments },
    ).inventoryManageLocationIds;

    it('INV-HINT-01 a WAREHOUSE at A plus a SELLER at B projects exactly [A]', () => {
      expect(hintFor(['A', 'B'], [
        assignment({ roleId: 'r-w', roleCode: 'WAREHOUSE', locationId: 'A', permissions: [...DEFAULT_ROLE_GRANTS.WAREHOUSE] }),
        assignment({ roleId: 'r-s', roleCode: 'SELLER', locationId: 'B', permissions: [...DEFAULT_ROLE_GRANTS.SELLER] }),
      ])).toEqual(['A']);
    });

    it('INV-HINT-02 a COMPANY ADMIN and a COMPANY OWNER project every effectively valid branch', () => {
      expect(hintFor(['A', 'B'], [assignment({ roleId: 'r-a', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] })])).toEqual(['A', 'B']);
      expect(hintFor(['A', 'B'], [assignment({ roleId: 'r-o', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] })])).toEqual(['A', 'B']);
    });

    it('INV-HINT-03 a SELLER or CASHIER (no INVENTORY_MANAGE) projects nothing', () => {
      expect(hintFor(['A'], [assignment({ roleId: 'r-s', roleCode: 'SELLER', locationId: 'A', permissions: [...DEFAULT_ROLE_GRANTS.SELLER] })])).toEqual([]);
      expect(hintFor(['A'], [assignment({ roleId: 'r-c', roleCode: 'CASHIER', locationId: 'A', permissions: [...DEFAULT_ROLE_GRANTS.CASHIER] })])).toEqual([]);
    });

    it('INV-HINT-04 a grant at A never composes with a location of a different assignment', () => {
      expect(hintFor(['A', 'B'], [
        assignment({ roleId: 'r-x', roleCode: 'WAREHOUSE', locationId: 'A', permissions: [IM] }),
        assignment({ roleId: 'r-y', roleCode: 'CASHIER', locationId: 'B', permissions: ['SALE_VIEW'] }),
      ])).toEqual(['A']);
    });

    it('INV-HINT-05 a location outside the effective universe is never fabricated', () => {
      expect(hintFor([], [assignment({ roleId: 'r-w', roleCode: 'WAREHOUSE', locationId: 'A', permissions: [IM] })])).toEqual([]);
    });
  });
});
