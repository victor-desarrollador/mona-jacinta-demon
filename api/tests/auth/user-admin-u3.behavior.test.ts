// USER-MGMT-01 U3 — privilege escalation and last-OWNER protection across BOTH mutable HTTP paths: the identity lifecycle (user-admin.service) and
// the scope endpoints (scope-assignment.service), against the in-memory stub of tests/helpers/user-admin-stub.ts. DB-free; the engine-level
// races live in user-admin-u3.pg.test.ts.
//
//   U3-A  ADMIN COMPANY never touches OWNER/ADMIN (real scopes, active or not)      U3-S  nobody administers themselves
//   U3-N  actors without a valid COMPANY authority          U3-O  OWNER manages OWNER      U3-L  LAST_OWNER_PROTECTED      U3-I  replay authorization
import { hash } from 'bcryptjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { createScopeAssignmentService } from '../../src/modules/backoffice/scope-assignment.service.js';
import { createUserAdminService } from '../../src/modules/backoffice/user-admin.service.js';
import { createUserAdminStub, type AdminStubUser, type AdminStubScope } from '../helpers/user-admin-stub.js';

vi.mock('../../src/modules/auth/password.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/auth/password.js')>('../../src/modules/auth/password.js');
  const { hash: bcryptHash } = await import('bcryptjs');
  return { ...actual, hashPassword: (password: string) => bcryptHash(password, 4) };
});

const LOC_A = '11111111-1111-4111-8111-111111111111';
const k = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
let oldHash = '';
beforeAll(async () => { oldHash = await hash('old-password-123', 4); });

const user = (id: string, patch: Partial<AdminStubUser> = {}): AdminStubUser => ({ id, name: `User ${id}`, email: `${id}@example.com`, isActive: true, passwordHash: oldHash, mustChangePassword: false, credentialsChangedAt: null, ...patch });
const company = (userId: string, roleCode: string): AdminStubScope => ({ userId, roleCode, scopeKind: 'COMPANY', locationId: null });
const at = (userId: string, roleCode: string): AdminStubScope => ({ userId, roleCode, scopeKind: 'LOCATION', locationId: LOC_A });
type Assignment = Express.ProductionAssignment;
const ctxOf = (userId: string, ...assignments: Array<[Assignment['roleCode'], Assignment['scopeKind']]>): { auth: Express.AuthContext } => ({
  auth: { userId, roles: assignments.map(([r]) => r), assignments: assignments.map(([roleCode, scopeKind]) => ({ roleId: 'r', roleCode, scopeKind, locationId: scopeKind === 'COMPANY' ? null : LOC_A, permissions: [] })), effectiveLocationIds: [] },
});
const OWNER = (id = 'owner-1') => ctxOf(id, ['OWNER', 'COMPANY']);
const ADMIN = (id = 'admin-1') => ctxOf(id, ['ADMIN', 'COMPANY']);

// owner-1, owner-2 (OWNERs) · admin-1, admin-2 (ADMIN COMPANY) · ex-admin (INACTIVE, keeps an ADMIN scope) · mixed (SELLER + ADMIN) · weird (a malformed ADMIN @ LOCATION row)
// seller-1 (active) · gone-1 (inactive CASHIER)
function world(extra: Parameters<typeof createUserAdminStub>[1] = {}) {
  const stub = createUserAdminStub({
    users: [user('owner-1'), user('owner-2'), user('admin-1'), user('admin-2'), user('ex-admin', { isActive: false }), user('mixed'), user('weird'), user('seller-1'), user('gone-1', { isActive: false })],
    scopes: [
      company('owner-1', 'OWNER'), company('owner-2', 'OWNER'), company('admin-1', 'ADMIN'), company('admin-2', 'ADMIN'), company('ex-admin', 'ADMIN'),
      at('mixed', 'SELLER'), company('mixed', 'ADMIN'), at('weird', 'ADMIN'), at('seller-1', 'SELLER'), at('gone-1', 'CASHIER'),
    ],
    locations: [{ id: LOC_A, name: 'Local A', code: 'A', isActive: true }],
  }, extra);
  return { ...stub, users: createUserAdminService(stub.db), scopes: createScopeAssignmentService(stub.db) };
}
type World = ReturnType<typeof world>;
const snapshot = (w: World) => JSON.stringify([w.state.users, w.state.scopes, w.state.operations, w.state.audit]);

async function refusal(promise: Promise<unknown>): Promise<AppError> {
  try { await promise; } catch (e) { expect(e).toBeInstanceOf(AppError); return e as AppError; }
  throw new Error('expected a refusal');
}

// every administrative operation against one target, as a named thunk
const operations = (w: World, actor: { auth: Express.AuthContext }, target: string) => ({
  edit: () => w.users.update(actor, target, { name: 'Otro Nombre' }),
  deactivate: () => w.users.deactivate(actor, target, { idempotencyKey: k(101) }),
  reactivate: () => w.users.reactivate(actor, target, { idempotencyKey: k(102) }),
  reset: () => w.users.resetPassword(actor, target, { idempotencyKey: k(103) }),
  'assign operational scope': () => w.scopes.assign(actor, target, { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [LOC_A] }),
  'revoke operational scope': () => w.scopes.revoke(actor, target, 'SELLER'),
});

describe('ADMIN COMPANY never touches a privileged account (U3-A)', () => {
  it.each(['admin-2', 'owner-2', 'ex-admin', 'mixed', 'weird'])('U3-A01 every operation against %s (real OWNER/ADMIN scope rows, active or not) is 403 and writes nothing', async (target) => {
    for (const [name, run] of Object.entries(operations(world(), ADMIN(), target))) {
      const w = world();
      const before = snapshot(w);
      const error = await refusal(operations(w, ADMIN(), target)[name as keyof ReturnType<typeof operations>]());
      expect(error.status, `${name} -> ${target}`).toBe(403);
      expect(snapshot(w), `${name} -> ${target}`).toBe(before);
      void run;
    }
  });

  it('U3-A02 ADMIN never creates ADMIN or OWNER, and never grants or revokes those roles on anybody, itself included', async () => {
    const w = world();
    const before = snapshot(w);
    const company_ = (roleCode: string, n: number) => ({ name: 'X', email: `x${n}@example.com`, roleCode, scopeKind: 'COMPANY' as const, idempotencyKey: k(n) }) as never;
    expect((await refusal(w.users.create(ADMIN(), company_('ADMIN', 1)))).status).toBe(403);
    expect((await refusal(w.users.create(ADMIN(), company_('OWNER', 2)))).status).toBe(403);
    for (const role of ['ADMIN', 'OWNER'] as const) {
      expect((await refusal(w.scopes.assign(ADMIN(), 'seller-1', { roleCode: role, scopeKind: 'COMPANY' }))).status, `assign ${role}`).toBe(403);
      expect((await refusal(w.scopes.revoke(ADMIN(), 'seller-1', role))).status, `revoke ${role}`).toBe(403);
    }
    expect(snapshot(w)).toBe(before);
  });

  it('U3-A03 an ADMIN still manages the three operational roles end to end', async () => {
    const w = world();
    expect((await w.users.create(ADMIN(), { name: 'Ana', email: 'ana@example.com', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [LOC_A], idempotencyKey: k(5) } as never)).replayed).toBe(false);
    expect((await w.users.update(ADMIN(), 'seller-1', { name: 'Nuevo' })).user.name).toBe('Nuevo');
    expect((await w.users.resetPassword(ADMIN(), 'seller-1', { idempotencyKey: k(6) })).replayed).toBe(false);
    expect((await w.users.deactivate(ADMIN(), 'seller-1', { idempotencyKey: k(7) })).user.isActive).toBe(false);
    expect((await w.users.reactivate(ADMIN(), 'gone-1', { idempotencyKey: k(8) })).user.isActive).toBe(true);
    expect((await w.scopes.assign(ADMIN(), 'seller-1', { roleCode: 'WAREHOUSE', scopeKind: 'LOCATION', locationIds: [LOC_A] })).roleCode).toBe('WAREHOUSE');
    expect((await w.scopes.revoke(ADMIN(), 'seller-1', 'WAREHOUSE')).revoked).toBe(true);
  });
});

describe('nobody administers themselves (U3-S)', () => {
  it.each([['OWNER', OWNER('owner-1'), 'owner-1'], ['ADMIN', ADMIN('admin-1'), 'admin-1']] as const)('U3-S01 a %s on its OWN account: every operation is 403 and writes nothing', async (_n, actor, self) => {
    const w = world();
    const before = snapshot(w);
    const ops = {
      ...operations(w, actor, self),
      'assign own role': () => w.scopes.assign(actor, self, { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [LOC_A] }),
      'revoke own role': () => w.scopes.revoke(actor, self, actor.auth.roles[0] as 'OWNER' | 'ADMIN'),
    };
    for (const [name, run] of Object.entries(ops)) expect((await refusal(run())).status, name).toBe(403);
    expect(snapshot(w)).toBe(before);
  });
});

describe('actors without a valid COMPANY authority (U3-N)', () => {
  it.each([
    ['ADMIN LOCATION', ctxOf('admin-1', ['ADMIN', 'LOCATION'])],
    ['CASHIER', ctxOf('admin-1', ['CASHIER', 'LOCATION'])],
    ['no assignment at all', ctxOf('admin-1')],
  ])('U3-N01 %s: every operation, even against an operational target, is 403 at the SERVICE (not only at the route gate)', async (_n, actor) => {
    const w = world();
    const before = snapshot(w);
    for (const [name, run] of Object.entries(operations(w, actor, 'seller-1'))) expect((await refusal(run())).status, name).toBe(403);
    expect((await refusal(w.users.create(actor, { name: 'X', email: 'x@example.com', roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [LOC_A], idempotencyKey: k(1) } as never))).status).toBe(403);
    expect(snapshot(w)).toBe(before);
  });
});

describe('an OWNER manages another OWNER (U3-O)', () => {
  it('U3-O01 edit, reset, deactivate, reactivate and scope changes on another OWNER all work (the U2 stop-gap OWNER_DEACTIVATION_NOT_SUPPORTED is gone)', async () => {
    const w = world();
    expect((await w.users.update(OWNER(), 'owner-2', { name: 'Co-owner' })).user.name).toBe('Co-owner');
    expect((await w.users.resetPassword(OWNER(), 'owner-2', { idempotencyKey: k(1) })).replayed).toBe(false);
    expect((await w.users.deactivate(OWNER(), 'owner-2', { idempotencyKey: k(2) })).user.isActive).toBe(false);
    expect((await w.users.reactivate(OWNER(), 'owner-2', { idempotencyKey: k(3) })).user.isActive).toBe(true);
    expect((await w.scopes.assign(OWNER(), 'owner-2', { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [LOC_A] })).roleCode).toBe('CASHIER');
    expect((await w.scopes.revoke(OWNER(), 'owner-2', 'OWNER')).revoked).toBe(true); // owner-1 stays operative
  });

  it('U3-O02 only an OWNER reactivates an account that kept an OWNER/ADMIN scope while inactive; the classification reads the scopes of an INACTIVE account', async () => {
    const w = world();
    expect((await refusal(w.users.reactivate(ADMIN(), 'ex-admin', { idempotencyKey: k(1) }))).status).toBe(403);
    expect((await w.users.reactivate(OWNER(), 'ex-admin', { idempotencyKey: k(2) })).user.isActive).toBe(true);
  });

  it('U3-O03 an OWNER grants and revokes ADMIN/OWNER on other accounts', async () => {
    const w = world();
    expect((await w.scopes.assign(OWNER(), 'seller-1', { roleCode: 'ADMIN', scopeKind: 'COMPANY' })).roleCode).toBe('ADMIN');
    expect((await w.scopes.assign(OWNER(), 'gone-1', { roleCode: 'OWNER', scopeKind: 'COMPANY' })).roleCode).toBe('OWNER');
    expect((await w.scopes.revoke(OWNER(), 'seller-1', 'ADMIN')).revoked).toBe(true);
  });
});

describe('LAST_OWNER_PROTECTED (U3-L)', () => {
  // The acting OWNER must itself be an operative OWNER for the middleware to admit it, so a sequential violation needs a caller whose context
  // is OWNER while the database says otherwise (a stale context reaching the service directly): the invariant must hold regardless.
  const PHANTOM = () => OWNER('phantom');

  it('U3-L01 deactivating the only operative OWNER is 409 LAST_OWNER_PROTECTED and writes nothing', async () => {
    const w = world();
    w.state.users.find((u) => u.id === 'owner-2')!.isActive = false;
    const before = snapshot(w);
    const error = await refusal(w.users.deactivate(PHANTOM(), 'owner-1', { idempotencyKey: k(1) }));
    expect(error).toMatchObject({ status: 409, code: 'LAST_OWNER_PROTECTED' });
    expect(error.message).toMatch(/último OWNER/i);
    expect(snapshot(w)).toBe(before);
  });

  it('U3-L02 revoking the OWNER scope of the only operative OWNER is 409 LAST_OWNER_PROTECTED and writes nothing', async () => {
    const w = world();
    w.state.scopes = w.state.scopes.filter((s) => !(s.userId === 'owner-2' && s.roleCode === 'OWNER'));
    const before = snapshot(w);
    expect(await refusal(w.scopes.revoke(PHANTOM(), 'owner-1', 'OWNER'))).toMatchObject({ status: 409, code: 'LAST_OWNER_PROTECTED' });
    expect(snapshot(w)).toBe(before);
  });

  it('U3-L03 an inactive OWNER, or an OWNER without a COMPANY scope row, is not operative: it does not count', async () => {
    const w = world();
    w.state.users.find((u) => u.id === 'owner-2')!.isActive = false;
    expect(await refusal(w.users.deactivate(PHANTOM(), 'owner-1', { idempotencyKey: k(1) }))).toMatchObject({ code: 'LAST_OWNER_PROTECTED' });
    const w2 = world();
    w2.state.scopes.find((s) => s.userId === 'owner-2' && s.roleCode === 'OWNER')!.scopeKind = 'LOCATION';
    expect(await refusal(w2.users.deactivate(PHANTOM(), 'owner-1', { idempotencyKey: k(2) }))).toMatchObject({ code: 'LAST_OWNER_PROTECTED' });
  });

  it('U3-L04 with another operative OWNER the same operations succeed; touching a NON-operative OWNER never needs the guard', async () => {
    const w = world();
    expect((await w.users.deactivate(PHANTOM(), 'owner-1', { idempotencyKey: k(1) })).user.isActive).toBe(false); // owner-2 remains
    const w2 = world();
    w2.state.users.find((u) => u.id === 'owner-2')!.isActive = false;
    expect((await w2.users.deactivate(PHANTOM(), 'owner-2', { idempotencyKey: k(2) })).replayed).toBe(false); // already inactive: no-op
    expect((await w2.scopes.revoke(PHANTOM(), 'owner-2', 'OWNER')).revoked).toBe(true); // not operative: removing the row cannot drop below 1
  });

  it('U3-L05 the guard takes the advisory lock BEFORE the target row lock, in deactivate and in an OWNER revoke', async () => {
    const w = world();
    await w.users.deactivate(OWNER(), 'owner-2', { idempotencyKey: k(1) });
    expect(w.state.events.indexOf('advisory')).toBeGreaterThan(-1);
    expect(w.state.events.indexOf('advisory')).toBeLessThan(w.state.events.indexOf('lock'));
    const w2 = world();
    await w2.scopes.revoke(OWNER(), 'owner-2', 'OWNER');
    expect(w2.state.events.indexOf('advisory')).toBeGreaterThan(-1);
    expect(w2.state.events.indexOf('advisory')).toBeLessThan(w2.state.events.indexOf('lock'));
  });

  it('U3-L06 operations that cannot remove an OWNER take no advisory lock (edit, reset, reactivate, operational scopes)', async () => {
    const w = world();
    await w.users.update(OWNER(), 'seller-1', { name: 'Z' });
    await w.users.resetPassword(OWNER(), 'seller-1', { idempotencyKey: k(1) });
    await w.users.reactivate(OWNER(), 'gone-1', { idempotencyKey: k(2) });
    await w.scopes.revoke(OWNER(), 'seller-1', 'SELLER');
    expect(w.state.events).not.toContain('advisory');
  });
});

describe('a replay never skips the CURRENT authorization (U3-I)', () => {
  it('U3-I01 reset replay: the target became ADMIN after the first call, so the same ADMIN with the same key now gets 403 and no state', async () => {
    const w = world();
    await w.users.resetPassword(ADMIN(), 'seller-1', { idempotencyKey: k(1) });
    w.state.scopes.push(company('seller-1', 'ADMIN'));
    const before = snapshot(w);
    expect((await refusal(w.users.resetPassword(ADMIN(), 'seller-1', { idempotencyKey: k(1) }))).status).toBe(403);
    expect(snapshot(w)).toBe(before);
  });

  it('U3-I02 deactivate and reactivate replays follow the same rule', async () => {
    const w = world();
    await w.users.deactivate(ADMIN(), 'seller-1', { idempotencyKey: k(1) });
    await w.users.reactivate(ADMIN(), 'gone-1', { idempotencyKey: k(2) });
    w.state.scopes.push(company('seller-1', 'ADMIN'), company('gone-1', 'ADMIN'));
    expect((await refusal(w.users.deactivate(ADMIN(), 'seller-1', { idempotencyKey: k(1) }))).status).toBe(403);
    expect((await refusal(w.users.reactivate(ADMIN(), 'gone-1', { idempotencyKey: k(2) }))).status).toBe(403);
  });

  it('U3-I03 create replay: an actor that lost its authority (now NONE) cannot read the earlier outcome back', async () => {
    const w = world();
    const input = { name: 'Ana', email: 'ana@example.com', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [LOC_A], idempotencyKey: k(1) } as never;
    await w.users.create(ADMIN(), input);
    expect((await refusal(w.users.create(ctxOf('admin-1', ['ADMIN', 'LOCATION']), input))).status).toBe(403);
    expect((await refusal(w.users.create(ctxOf('admin-1', ['CASHIER', 'LOCATION']), input))).status).toBe(403);
  });

  it('U3-I04 an actor allowed today still gets its replay (no regression of U2)', async () => {
    const w = world();
    await w.users.resetPassword(ADMIN(), 'seller-1', { idempotencyKey: k(1) });
    expect((await w.users.resetPassword(ADMIN(), 'seller-1', { idempotencyKey: k(1) })).replayed).toBe(true);
  });
});
