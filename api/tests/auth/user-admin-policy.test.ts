// USER-MGMT-01 U3 — the central identity-administration policy (pure functions; no database).
import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import {
  assertCanAdminister, assertCanAssignRoleCode, assertCanManageTarget, classifyActor, isPrivilegedRoleCode, isPrivilegedTarget,
} from '../../src/modules/backoffice/user-admin-policy.js';

type Assignment = Express.ProductionAssignment;
const a = (roleCode: Assignment['roleCode'], scopeKind: Assignment['scopeKind'] = 'COMPANY'): Assignment => ({ roleId: 'r', roleCode, scopeKind, locationId: scopeKind === 'COMPANY' ? null : 'loc', permissions: [] });
const ctx = (userId: string, ...assignments: Assignment[]): Express.AuthContext => ({ userId, roles: assignments.map((x) => x.roleCode), assignments, effectiveLocationIds: [] });
const scopes = (...codes: string[]) => codes.map((code) => ({ role: { code } }));
const denied = (fn: () => unknown) => { try { fn(); } catch (e) { expect(e).toBeInstanceOf(AppError); return e as AppError; } throw new Error('expected a refusal'); };

describe('USER-MGMT-01 U3 policy (PO*)', () => {
  it('PO-01 the actor is classified from its VALID assignments: OWNER COMPANY, ADMIN COMPANY, everything else NONE', () => {
    expect(classifyActor(ctx('u', a('OWNER')))).toBe('OWNER');
    expect(classifyActor(ctx('u', a('ADMIN')))).toBe('ADMIN_COMPANY');
    expect(classifyActor(ctx('u', a('ADMIN'), a('OWNER')))).toBe('OWNER');
    for (const none of [ctx('u', a('ADMIN', 'LOCATION')), ctx('u', a('OWNER', 'LOCATION')), ctx('u', a('CASHIER', 'LOCATION')), ctx('u', a('SELLER', 'LOCATION'), a('WAREHOUSE', 'LOCATION')), ctx('u')]) {
      expect(classifyActor(none)).toBe('NONE');
    }
  });

  it('PO-02 a target is privileged when it holds ANY OWNER or ADMIN scope row (any scope kind, real rows, not the requested role)', () => {
    expect(isPrivilegedTarget(scopes('OWNER'))).toBe(true);
    expect(isPrivilegedTarget(scopes('ADMIN'))).toBe(true);
    expect(isPrivilegedTarget(scopes('SELLER', 'ADMIN'))).toBe(true); // mixed roles
    expect(isPrivilegedTarget(scopes('CASHIER', 'SELLER', 'WAREHOUSE'))).toBe(false);
    expect(isPrivilegedTarget([])).toBe(false);
    expect([isPrivilegedRoleCode('OWNER'), isPrivilegedRoleCode('ADMIN'), isPrivilegedRoleCode('CASHIER'), isPrivilegedRoleCode('MANAGER')]).toEqual([true, true, false, false]);
  });

  it('PO-03 assertCanAdminister: only OWNER and ADMIN COMPANY administer identities (403)', () => {
    expect(() => assertCanAdminister(ctx('u', a('OWNER')))).not.toThrow();
    expect(() => assertCanAdminister(ctx('u', a('ADMIN')))).not.toThrow();
    for (const none of [ctx('u', a('ADMIN', 'LOCATION')), ctx('u', a('CASHIER', 'LOCATION'))]) expect(denied(() => assertCanAdminister(none)).status).toBe(403);
  });

  it('PO-04 assertCanAssignRoleCode: OWNER and ADMIN roles only by an OWNER; operational roles by OWNER or ADMIN COMPANY', () => {
    const owner = ctx('o', a('OWNER')); const admin = ctx('a', a('ADMIN'));
    for (const code of ['OWNER', 'ADMIN', 'CASHIER', 'SELLER', 'WAREHOUSE'] as const) expect(() => assertCanAssignRoleCode(owner, code)).not.toThrow();
    for (const code of ['CASHIER', 'SELLER', 'WAREHOUSE'] as const) expect(() => assertCanAssignRoleCode(admin, code)).not.toThrow();
    for (const code of ['OWNER', 'ADMIN'] as const) expect(denied(() => assertCanAssignRoleCode(admin, code))).toMatchObject({ status: 403, message: `Sólo OWNER puede asignar el rol ${code}.` });
  });

  it('PO-05 assertCanManageTarget: never yourself; ADMIN COMPANY never a privileged target; OWNER any other account', () => {
    const owner = ctx('o', a('OWNER')); const admin = ctx('a', a('ADMIN'));
    expect(denied(() => assertCanManageTarget(owner, 'o', scopes('SELLER'))).status).toBe(403);
    expect(denied(() => assertCanManageTarget(admin, 'a', scopes('SELLER'))).status).toBe(403);
    expect(() => assertCanManageTarget(owner, 'x', scopes('OWNER'))).not.toThrow();
    expect(() => assertCanManageTarget(owner, 'x', scopes('ADMIN'))).not.toThrow();
    expect(() => assertCanManageTarget(admin, 'x', scopes('SELLER'))).not.toThrow();
    for (const target of [scopes('ADMIN'), scopes('OWNER'), scopes('SELLER', 'ADMIN')]) expect(denied(() => assertCanManageTarget(admin, 'x', target)).status).toBe(403);
    expect(denied(() => assertCanManageTarget(ctx('n', a('CASHIER', 'LOCATION')), 'x', scopes('SELLER'))).status).toBe(403);
  });
});
