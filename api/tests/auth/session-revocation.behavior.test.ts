// USER-MGMT-01 U4 — session revocation is a POST-COMMIT side effect of the six mutations that change what a live socket may do:
// deactivate, reactivate, administrative reset, own password change, scope assign, scope revoke. DB-free (in-memory stub with real rollback).
//   SR-01..SR-05  the revoker is called once, with the right user, strictly AFTER the commit
//   SR-06         no revocation when nothing relevant changed (create, edit, replays, no-op scope calls)
//   SR-07         no revocation when the transaction did not commit (authorization, validation, audit failure, wrong current password)
//   SR-08..SR-09  a failing revoker never turns a committed success into an error; it is logged with safe fields only
import { hash } from 'bcryptjs';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { changePassword } from '../../src/modules/auth/auth.service.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { createScopeAssignmentService } from '../../src/modules/backoffice/scope-assignment.service.js';
import { createUserAdminService } from '../../src/modules/backoffice/user-admin.service.js';
import { createNoopSessionRevoker, type SessionRevoker } from '../../src/realtime/session-revoker.js';
import { logger } from '../../src/shared/logger.js';
import { createUserAdminStub, type AdminStubScope, type AdminStubUser } from '../helpers/user-admin-stub.js';

vi.mock('../../src/modules/auth/password.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/auth/password.js')>('../../src/modules/auth/password.js');
  const { hash: bcryptHash } = await import('bcryptjs');
  return { ...actual, hashPassword: (password: string) => bcryptHash(password, 4) };
});

const LOC = '11111111-1111-4111-8111-111111111111';
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const SELLER = '00000000-0000-4000-8000-0000000000a3';
const GONE = '00000000-0000-4000-8000-0000000000a4';
const OWNER2 = '00000000-0000-4000-8000-0000000000a5';
const k = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const CURRENT = 'current-password-123';
let currentHash = '';
beforeAll(async () => { currentHash = await hash(CURRENT, 4); });

const user = (id: string, patch: Partial<AdminStubUser> = {}): AdminStubUser => ({ id, name: `U ${id.slice(-2)}`, email: `u${id.slice(-2)}@example.com`, isActive: true, passwordHash: currentHash, mustChangePassword: false, credentialsChangedAt: null, ...patch });
const company = (userId: string, roleCode: string): AdminStubScope => ({ userId, roleCode, scopeKind: 'COMPANY', locationId: null });
const ownerCtx = (id = OWNER): { auth: Express.AuthContext } => ({ auth: { userId: id, roles: ['OWNER'], assignments: [{ roleId: 'r', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }], effectiveLocationIds: [] } });

// A revoker that records WHEN it was called relative to the transaction: the stub's txOpen flag and its last event.
function world(options: Parameters<typeof createUserAdminStub>[1] = {}, revokerImpl?: (userId: string) => unknown) {
  const stub = createUserAdminStub({
    users: [user(OWNER), user(OWNER2), user(SELLER), user(GONE, { isActive: false })],
    scopes: [company(OWNER, 'OWNER'), company(OWNER2, 'OWNER'), { userId: SELLER, roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: LOC }, { userId: GONE, roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: LOC }],
    locations: [{ id: LOC, name: 'Local', code: 'L', isActive: true }],
  }, options);
  const calls: Array<{ userId: string; txOpen: boolean; lastEvent: string | undefined }> = [];
  const revoker: SessionRevoker = {
    disconnectUser: vi.fn(async (userId: string) => {
      calls.push({ userId, txOpen: stub.state.txOpen, lastEvent: stub.state.events.at(-1) });
      if (revokerImpl) return revokerImpl(userId) as void;
    }),
  };
  return { ...stub, revoker, calls, users: createUserAdminService(stub.db, revoker), scopes: createScopeAssignmentService(stub.db, revoker) };
}
type World = ReturnType<typeof world>;
const afterCommit = (w: World, userId: string) => {
  expect(w.calls).toHaveLength(1);
  expect(w.calls[0]).toEqual({ userId, txOpen: false, lastEvent: 'tx:commit' });
};

// the six operations, each as a thunk returning the user whose sockets must die
const SIX = {
  deactivate: (w: World) => [SELLER, () => w.users.deactivate(ownerCtx(), SELLER, { idempotencyKey: k(1) })] as const,
  reactivate: (w: World) => [GONE, () => w.users.reactivate(ownerCtx(), GONE, { idempotencyKey: k(2) })] as const,
  reset: (w: World) => [SELLER, () => w.users.resetPassword(ownerCtx(), SELLER, { idempotencyKey: k(3) })] as const,
  assign: (w: World) => [SELLER, () => w.scopes.assign(ownerCtx(), SELLER, { roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [LOC] })] as const,
  revoke: (w: World) => [SELLER, () => w.scopes.revoke(ownerCtx(), SELLER, 'SELLER')] as const,
  'own password': (w: World) => [SELLER, () => changePassword(w.db, SELLER, { currentPassword: CURRENT, newPassword: 'a-brand-new-password-9' }, w.revoker)] as const,
};

const errorSpy = vi.spyOn(logger, 'error');
beforeEach(() => { errorSpy.mockClear(); });

describe('the revoker runs once, for the right user, after the commit (SR-01..SR-05)', () => {
  it.each(Object.keys(SIX) as Array<keyof typeof SIX>)('SR-01 %s', async (name) => {
    const w = world();
    const [target, run] = SIX[name](w);
    await run();
    afterCommit(w, target);
    expect(w.state.audit.length).toBeGreaterThan(0); // the audit row was committed before the disconnect
  });

  it('SR-02 change-password returns the NEW token even though the OLD sockets are dropped (the revoker never touches the caller\'s HTTP session)', async () => {
    const w = world();
    const result = await changePassword(w.db, SELLER, { currentPassword: CURRENT, newPassword: 'a-brand-new-password-9' }, w.revoker);
    expect(typeof result.accessToken).toBe('string');
    expect(result.user.mustChangePassword).toBe(false);
    afterCommit(w, SELLER);
  });
});

describe('nothing relevant changed, nothing is revoked (SR-06)', () => {
  it('SR-06 create, edit (name and e-mail), replays, an identical scope assignment and a revoke of nothing do NOT disconnect anybody', async () => {
    const w = world();
    await w.users.create(ownerCtx(), { name: 'Ana', email: 'ana@example.com', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [LOC], idempotencyKey: k(10) } as never);
    await w.users.update(ownerCtx(), SELLER, { name: 'Otro', email: 'otro@example.com' });
    expect(w.calls).toEqual([]);
    await w.users.resetPassword(ownerCtx(), SELLER, { idempotencyKey: k(11) });
    await w.users.resetPassword(ownerCtx(), SELLER, { idempotencyKey: k(11) }); // replay
    await w.users.deactivate(ownerCtx(), GONE, { idempotencyKey: k(12) }); // creates the key
    await w.users.deactivate(ownerCtx(), GONE, { idempotencyKey: k(12) }); // replay
    expect(w.calls.map((c) => c.userId)).toEqual([SELLER, GONE]);
    w.calls.length = 0;
    await w.scopes.assign(ownerCtx(), SELLER, { roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [LOC] }); // logically identical
    await w.scopes.revoke(ownerCtx(), SELLER, 'WAREHOUSE'); // nothing to remove
    expect(w.calls).toEqual([]);
  });
});

describe('no commit, no disconnect (SR-07)', () => {
  it.each(Object.keys(SIX) as Array<keyof typeof SIX>)('SR-07 %s: an audit failure rolls the transaction back and the revoker is never called', async (name) => {
    const w = world({ auditFailure: true });
    const [, run] = SIX[name](w);
    await expect(run()).rejects.toThrow();
    expect(w.state.events).toContain('tx:rollback');
    expect(w.calls).toEqual([]);
  });

  it('SR-07b authorization refusals, a validation refusal and a wrong current password never reach the revoker', async () => {
    const w = world();
    const admin = { auth: { userId: 'admin-x', roles: ['ADMIN'], assignments: [{ roleId: 'r', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [] }], effectiveLocationIds: [] } } as { auth: Express.AuthContext };
    await expect(w.users.deactivate(admin, OWNER, { idempotencyKey: k(1) })).rejects.toMatchObject({ status: 403 });
    await expect(w.users.resetPassword(ownerCtx(), OWNER, { idempotencyKey: k(2) })).rejects.toMatchObject({ status: 403 }); // self
    await expect(w.scopes.revoke(admin, OWNER, 'OWNER')).rejects.toMatchObject({ status: 403 });
    await expect(w.users.reactivate(ownerCtx(), SELLER, { idempotencyKey: k(3) })).rejects.toMatchObject({ status: 409 }); // already active
    await expect(changePassword(w.db, SELLER, { currentPassword: 'definitely-wrong-1', newPassword: 'a-brand-new-password-9' }, w.revoker)).rejects.toMatchObject({ code: 'INVALID_CURRENT_PASSWORD' });
    expect(w.calls).toEqual([]);
  });
});

describe('a failing revoker never fails a committed mutation (SR-08)', () => {
  it.each(Object.keys(SIX) as Array<keyof typeof SIX>)('SR-08 %s: the revoker throws -> the result is the success, the mutation and its audit persist, the failure is logged without secrets', async (name) => {
    for (const impl of [(): never => { throw new Error('boom: sync Bearer eyJleakedToken'); }, async (): Promise<never> => { throw new Error('boom: async temporaryPassword=Abcd-Efgh-Jklm-Npqr'); }]) {
      errorSpy.mockClear();
      const w = world({}, impl);
      const [target, run] = SIX[name](w);
      const result = await run();
      expect(result).toBeTruthy();
      expect(w.calls).toHaveLength(1);
      expect(w.state.audit.length).toBeGreaterThan(0);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const logged = errorSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(logged).toMatchObject({ event: 'realtime_user_disconnect_failed', userId: target, errorType: 'Error' });
      expect(typeof logged.operation).toBe('string');
      expect(Object.keys(logged).sort()).toEqual(['errorType', 'event', 'operation', 'userId']); // never the error message or stack: either can carry a secret
      const text = JSON.stringify(errorSpy.mock.calls);
      expect(text).not.toMatch(/eyJleakedToken|Abcd-Efgh-Jklm-Npqr|boom/);
      expect(text).not.toMatch(/temporaryPassword|passwordHash|bcrypt|\$2[aby]\$|Bearer|eyJ/);
      expect(text).not.toContain((result as { temporaryPassword?: string }).temporaryPassword ?? '\u0000never');
    }
  });

  it('SR-08b the no-op revoker is the default everywhere (services built without one still work)', async () => {
    const stub = createUserAdminStub({ users: [user(OWNER), user(SELLER)], scopes: [company(OWNER, 'OWNER'), { userId: SELLER, roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: LOC }], locations: [{ id: LOC, name: 'L', code: 'L', isActive: true }] });
    expect((await createUserAdminService(stub.db).deactivate(ownerCtx(), SELLER, { idempotencyKey: k(1) })).user.isActive).toBe(false);
    expect((await createScopeAssignmentService(stub.db).revoke(ownerCtx(), SELLER, 'SELLER')).revoked).toBe(true);
    await expect(Promise.resolve(createNoopSessionRevoker().disconnectUser('x'))).resolves.toBeUndefined();
  });
});

describe('HTTP stays successful when the revoker fails (SR-09)', () => {
  const failing: SessionRevoker = { disconnectUser: () => { throw new Error('socket layer down'); } };
  const header = async (id: string) => ({ Authorization: `Bearer ${await signAccessToken(id, null)}` });
  function app() {
    const stub = createUserAdminStub({
      users: [user(OWNER), user(SELLER), user(GONE, { isActive: false })],
      scopes: [company(OWNER, 'OWNER'), { userId: SELLER, roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: LOC }, { userId: GONE, roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: LOC }],
      locations: [{ id: LOC, name: 'Local', code: 'L', isActive: true }],
    });
    return { stub, app: createApp(stub.db, undefined, failing) };
  }

  it('SR-09 deactivate / reactivate / reset / scope assign / scope revoke / change-password all answer their normal 200 and the data is committed', async () => {
    const { stub, app: a } = app();
    const base = '/api/v1/backoffice/users';
    const o = await header(OWNER);
    const off = await request(a).post(`${base}/${SELLER}/deactivate`).set(o).send({ idempotencyKey: k(1) });
    expect([off.status, off.body.user.isActive]).toEqual([200, false]);
    expect((await request(a).get('/api/v1/auth/me').set(await header(SELLER))).status).toBe(403); // the next HTTP request is refused: inactive
    const on = await request(a).post(`${base}/${GONE}/reactivate`).set(o).send({ idempotencyKey: k(2) });
    expect([on.status, on.body.user.isActive, typeof on.body.temporaryPassword]).toEqual([200, true, 'string']);
    const reset = await request(a).post(`${base}/${GONE}/reset-password`).set(o).send({ idempotencyKey: k(3) });
    expect([reset.status, typeof reset.body.temporaryPassword]).toEqual([200, 'string']);
    const assign = await request(a).post(`${base}/${GONE}/scope`).set(o).send({ roleCode: 'WAREHOUSE', scopeKind: 'LOCATION', locationIds: [LOC] });
    expect(assign.status).toBe(200);
    const revoke = await request(a).delete(`${base}/${GONE}/scope/WAREHOUSE`).set(o);
    expect(revoke.status).toBe(200);
    const login = await request(a).post('/api/v1/auth/login').send({ email: 'ua4@example.com', password: reset.body.temporaryPassword });
    expect(login.status).toBe(200);
    const change = await request(a).post('/api/v1/auth/change-password').set({ Authorization: `Bearer ${login.body.accessToken}` }).send({ currentPassword: reset.body.temporaryPassword, newPassword: 'a-brand-new-password-9' });
    expect(change.status).toBe(200);
    expect(typeof change.body.accessToken).toBe('string');
    expect(stub.state.audit.map((x) => x.action)).toEqual(['USER_DEACTIVATED', 'USER_REACTIVATED', 'USER_PASSWORD_RESET', 'USER_SCOPE_ASSIGNED', 'USER_SCOPE_REVOKED', 'USER_PASSWORD_CHANGED']);
  });
});
