// R3-A4.3 S3 — actsAsSupervisorAtLocation (C1–C5 §4.3, correction C3). DB-free.
// The supervisor acting at a sale's location (sale.branchId, read under lock by
// the caller) to confirm exceptionally, close/declare an attempt, recover stock
// or register an external refund:
//   - OWNER only through isOwner(ctx) (a valid COMPANY-scoped OWNER assignment);
//   - ADMIN only through ONE assignment that is roleCode ADMIN, scopeKind
//     COMPANY and holds EVERY requested permission;
//   - permissions are never combined across assignments; no permission is
//     enough without the effective role; empty location / permission list fail.
// Like every check in authorization-policy.ts it is a pure authority evaluator:
// a COMPANY assignment qualifies for any non-empty locationId; the caller
// supplies the persisted sale.branchId.
import { describe, expect, it } from 'vitest';
import {
  actsAsRoleAtLocation,
  actsAsSupervisorAtLocation,
  hasBranchAccess,
  hasPermission,
  hasPermissionAtLocation,
  isOwner,
} from '../../src/modules/rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS as P } from '../../src/modules/rbac/permissions.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';

type Assignment = Express.ProductionAssignment;
const ctx = (...assignments: Assignment[]) => ({ assignments });
const A = 'loc-a';
const B = 'loc-b';

const owner: Assignment = { roleId: 'r-owner', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] };
const ownerAtLocation: Assignment = { ...owner, scopeKind: 'LOCATION', locationId: A };
const adminCompany: Assignment = { roleId: 'r-admin', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] };
const adminAtA: Assignment = { ...adminCompany, scopeKind: 'LOCATION', locationId: A };
const role = (roleCode: Assignment['roleCode'], locationId: string, permissions: readonly string[]): Assignment => ({
  roleId: `r-${roleCode}`, roleCode, scopeKind: 'LOCATION', locationId, permissions: [...permissions],
});
const cashierAtA = role('CASHIER', A, DEFAULT_ROLE_GRANTS.CASHIER);
// SECURITY-RBAC-01a: malformed data — COMPANY is valid only for OWNER/ADMIN.
const cashierCompany: Assignment = { ...cashierAtA, scopeKind: 'COMPANY', locationId: null, permissions: [...DEFAULT_ROLE_GRANTS.CASHIER, P.SALE_CANCEL_PENDING] };

// The permission sets the later slices pass (C1–C5 §4.3, last-REVISE §3.2 and §4.2).
const CONFIRM = [P.SALE_CHARGE, P.SALE_COMPLETE];
const CLOSE = [P.SALE_CANCEL_PENDING];
const STOCK_RECOVERY = [P.SALE_CORRECT_PENDING, P.SALE_CHARGE];
const RECOVERY_RESERVATION = [P.SALE_CORRECT_PENDING, P.SALE_CHARGE, P.SALE_COMPLETE];
const SETS = { CONFIRM, CLOSE, STOCK_RECOVERY, RECOVERY_RESERVATION };

describe('R3-A4.3 S3 — actsAsSupervisorAtLocation', () => {
  it('S01 a valid OWNER (COMPANY assignment, no permission rows) qualifies for every set at any location', () => {
    for (const [name, set] of Object.entries(SETS)) {
      expect(actsAsSupervisorAtLocation(ctx(owner), set, A), name).toBe(true);
      expect(actsAsSupervisorAtLocation(ctx(owner), set, B), name).toBe(true);
    }
  });

  it('S02 an invalid OWNER (LOCATION-scoped, malformed) never qualifies, not even at its own location', () => {
    expect(isOwner(ctx(ownerAtLocation))).toBe(false);
    for (const set of Object.values(SETS)) {
      expect(actsAsSupervisorAtLocation(ctx(ownerAtLocation), set, A)).toBe(false);
      expect(actsAsSupervisorAtLocation(ctx({ ...ownerAtLocation, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] }), set, A)).toBe(false);
    }
  });

  it('S03 a COMPANY ADMIN holding every requested permission qualifies at any location', () => {
    for (const [name, set] of Object.entries(SETS)) {
      expect(actsAsSupervisorAtLocation(ctx(adminCompany), set, A), name).toBe(true);
      expect(actsAsSupervisorAtLocation(ctx(adminCompany), set, B), name).toBe(true);
    }
    const minimal: Assignment = { ...adminCompany, permissions: [...RECOVERY_RESERVATION] };
    expect(actsAsSupervisorAtLocation(ctx(minimal), RECOVERY_RESERVATION, A)).toBe(true);
  });

  it('S04 a LOCATION ADMIN never qualifies, at its own location or another, even with every permission', () => {
    for (const set of Object.values(SETS)) {
      expect(actsAsSupervisorAtLocation(ctx(adminAtA), set, A)).toBe(false);
      expect(actsAsSupervisorAtLocation(ctx(adminAtA), set, B)).toBe(false);
    }
    // ...while the ordinary permission check for that same ADMIN is unchanged.
    expect(hasPermissionAtLocation(ctx(adminAtA), P.SALE_CANCEL_PENDING, A)).toBe(true);
  });

  it('S05 permissions split across two COMPANY ADMIN assignments never combine', () => {
    const half1: Assignment = { ...adminCompany, roleId: 'r-admin-1', permissions: [P.SALE_CORRECT_PENDING] };
    const half2: Assignment = { ...adminCompany, roleId: 'r-admin-2', permissions: [P.SALE_CHARGE, P.SALE_COMPLETE] };
    expect(actsAsSupervisorAtLocation(ctx(half1, half2), STOCK_RECOVERY, A)).toBe(false);
    expect(actsAsSupervisorAtLocation(ctx(half1, half2), RECOVERY_RESERVATION, A)).toBe(false);
    expect(actsAsSupervisorAtLocation(ctx(half2, half1), CONFIRM, A)).toBe(true); // half2 alone holds CONFIRM
    // A COMPANY ADMIN missing a permission plus a CASHIER at the location holding it: still no.
    const adminNoCancel: Assignment = { ...adminCompany, permissions: adminCompany.permissions.filter((p) => p !== P.SALE_CANCEL_PENDING) };
    expect(actsAsSupervisorAtLocation(ctx(adminNoCancel, cashierAtA), CLOSE, A)).toBe(false);
  });

  it('S06 a COMPANY ADMIN missing any one requested permission does not qualify', () => {
    for (const [name, set] of Object.entries(SETS)) {
      for (const missing of set) {
        const admin: Assignment = { ...adminCompany, permissions: adminCompany.permissions.filter((p) => p !== missing) };
        expect(actsAsSupervisorAtLocation(ctx(admin), set, A), `${name} without ${missing}`).toBe(false);
      }
    }
    expect(actsAsSupervisorAtLocation(ctx({ ...adminCompany, permissions: [] }), CLOSE, A)).toBe(false);
  });

  it('S07 CASHIER, SELLER and WAREHOUSE never qualify, even holding SALE_CANCEL_PENDING (and every set) at that location', () => {
    expect(DEFAULT_ROLE_GRANTS.CASHIER).toContain(P.SALE_CANCEL_PENDING);
    const everything = [...DEFAULT_ROLE_GRANTS.ADMIN];
    for (const roleCode of ['CASHIER', 'SELLER', 'WAREHOUSE'] as const) {
      for (const assignment of [role(roleCode, A, everything), { ...role(roleCode, A, everything), scopeKind: 'COMPANY' as const, locationId: null }]) {
        for (const [name, set] of Object.entries(SETS)) {
          expect(actsAsSupervisorAtLocation(ctx(assignment), set, A), `${roleCode} ${assignment.scopeKind} ${name}`).toBe(false);
        }
      }
    }
    expect(actsAsSupervisorAtLocation(ctx(cashierAtA), CLOSE, A)).toBe(false);
    expect(hasPermissionAtLocation(ctx(cashierAtA), P.SALE_CANCEL_PENDING, A)).toBe(true); // the plain grant is untouched
  });

  it('S08 different locations: OWNER and COMPANY ADMIN cover any location; LOCATION assignments cover none', () => {
    const many = ctx(cashierAtA, adminAtA, role('ADMIN', B, DEFAULT_ROLE_GRANTS.ADMIN));
    for (const location of [A, B, 'loc-c']) expect(actsAsSupervisorAtLocation(many, CLOSE, location)).toBe(false);
    for (const location of [A, B, 'loc-c']) {
      expect(actsAsSupervisorAtLocation(ctx(cashierAtA, adminCompany), CLOSE, location)).toBe(true);
      expect(actsAsSupervisorAtLocation(ctx(cashierAtA, owner), CLOSE, location)).toBe(true);
    }
  });

  it('S09 an empty locationId, an empty permission list or an empty permission code always fail, even for OWNER', () => {
    for (const subject of [ctx(owner), ctx(adminCompany)]) {
      expect(actsAsSupervisorAtLocation(subject, CLOSE, '')).toBe(false);
      expect(actsAsSupervisorAtLocation(subject, [], A)).toBe(false);
      expect(actsAsSupervisorAtLocation(subject, [''], A)).toBe(false);
      expect(actsAsSupervisorAtLocation(subject, [P.SALE_CANCEL_PENDING, ''], A)).toBe(false);
    }
    expect(actsAsSupervisorAtLocation(ctx(), CLOSE, A)).toBe(false);
  });

  it('S10 the existing RBAC helpers keep their exact outcomes', () => {
    const subjects = { owner: ctx(owner), ownerAtLocation: ctx(ownerAtLocation), adminCompany: ctx(adminCompany), adminAtA: ctx(adminAtA), cashierAtA: ctx(cashierAtA) };
    const observed = Object.fromEntries(Object.entries(subjects).map(([name, subject]) => [name, [
      isOwner(subject),
      hasPermission(subject, P.SALE_CANCEL_PENDING),
      hasPermissionAtLocation(subject, P.SALE_CANCEL_PENDING, A),
      hasPermissionAtLocation(subject, P.SALE_CANCEL_PENDING, B),
      hasPermissionAtLocation(subject, P.PRICE_MANAGE, A),
      hasBranchAccess(subject, A),
      hasBranchAccess(subject, B),
      actsAsRoleAtLocation(subject, 'CASHIER', P.SALE_CHARGE, A),
    ]]));
    expect(observed).toEqual({
      owner: [true, true, true, true, true, true, true, false],
      ownerAtLocation: [false, false, false, false, false, false, false, false],
      adminCompany: [false, true, true, true, true, true, true, false],
      adminAtA: [false, true, true, false, false, true, false, false],
      cashierAtA: [false, true, true, false, false, true, false, true],
    });
  });

  it('SECURITY-RBAC-01a: an invalid CASHIER + COMPANY assignment never acts as supervisor and has no authority at any location', () => {
    const invalid = ctx(cashierCompany);
    expect(actsAsSupervisorAtLocation(invalid, [P.SALE_CANCEL_PENDING], B)).toBe(false);
    expect(actsAsSupervisorAtLocation(invalid, CONFIRM, B)).toBe(false);
    expect(hasPermissionAtLocation(invalid, P.SALE_CHARGE, B)).toBe(false);
    expect(hasBranchAccess(invalid, B)).toBe(false);
    expect(actsAsSupervisorAtLocation(ctx(cashierAtA, cashierCompany), [P.SALE_CANCEL_PENDING], A)).toBe(false);
  });
});
