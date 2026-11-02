// USER-MGMT-01 U2 — the administrative identity lifecycle (create, edit, deactivate, reactivate, reset password) through the REAL service
// against the in-memory stub of tests/helpers/user-admin-stub.ts (real rollback, real unique constraints, race hooks). DB-free.
//
//   UA-C*  create          UA-U*  edit          UA-D*  deactivate          UA-R*  reactivate          UA-P*  reset password
//   UA-X*  cross-cutting: no secrets anywhere, audit shape, transient retry
import { compare, hash } from 'bcryptjs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { TEMPORARY_PASSWORD_PATTERN } from '../../src/modules/auth/temporary-password.js';
import { createUserAdminService } from '../../src/modules/backoffice/user-admin.service.js';
import { createUserAdminStub, type AdminStubUser, type AdminStubScope } from '../helpers/user-admin-stub.js';

// bcrypt at the production cost (12 rounds, ~250 ms) would make this suite crawl: the REAL bcrypt runs, with 4 rounds.
vi.mock('../../src/modules/auth/password.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/auth/password.js')>('../../src/modules/auth/password.js');
  const { hash: bcryptHash } = await import('bcryptjs');
  return { ...actual, hashPassword: (password: string) => bcryptHash(password, 4) };
});

const LOC_A = '11111111-1111-4111-8111-111111111111';
const LOC_B = '22222222-2222-4222-8222-222222222222';
const LOC_OFF = '33333333-3333-4333-8333-333333333333';
const K1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const K2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const K3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const EPOCH = new Date(1_700_000_000_000);

let oldHash = '';
beforeAll(async () => {
  oldHash = await hash('old-password-123', 4);
});

const user = (id: string, patch: Partial<AdminStubUser> = {}): AdminStubUser => ({
  id, name: `User ${id}`, email: `${id}@example.com`, isActive: true, passwordHash: oldHash, mustChangePassword: false, credentialsChangedAt: null, ...patch,
});
const company = (userId: string, roleCode: string): AdminStubScope => ({ userId, roleCode, scopeKind: 'COMPANY', locationId: null });
const at = (userId: string, roleCode: string, locationId: string): AdminStubScope => ({ userId, roleCode, scopeKind: 'LOCATION', locationId });
const locations = [
  { id: LOC_A, name: 'Local A', code: 'A', isActive: true },
  { id: LOC_B, name: 'Local B', code: 'B', isActive: true },
  { id: LOC_OFF, name: 'Local cerrado', code: 'X', isActive: false },
];

const ctx = (userId: string, roleCode: 'OWNER' | 'ADMIN' | 'CASHIER'): { auth: Express.AuthContext } => ({
  auth: { userId, roles: [roleCode], assignments: [{ roleId: 'r', roleCode, scopeKind: 'COMPANY', locationId: null, permissions: [] }], effectiveLocationIds: [] },
});

// world: an OWNER (owner-1), an ADMIN (admin-1), a second ADMIN (admin-2), a second OWNER (owner-2), a seller (seller-1) and an inactive seller (gone-1)
function world(options: Parameters<typeof createUserAdminStub>[1] = {}) {
  const stub = createUserAdminStub({
    users: [
      user('owner-1'), user('owner-2'), user('admin-1'), user('admin-2'),
      user('seller-1', { email: 'seller-1@example.com' }),
      user('gone-1', { isActive: false, credentialsChangedAt: EPOCH }),
    ],
    scopes: [company('owner-1', 'OWNER'), company('owner-2', 'OWNER'), company('admin-1', 'ADMIN'), company('admin-2', 'ADMIN'), at('seller-1', 'SELLER', LOC_A), at('gone-1', 'CASHIER', LOC_A)],
    locations,
  }, options);
  return { ...stub, service: createUserAdminService(stub.db), owner: ctx('owner-1', 'OWNER'), admin: ctx('admin-1', 'ADMIN') };
}

const createInput = (patch: Record<string, unknown> = {}) => ({
  name: 'Maria Lopez', email: 'maria@example.com', roleCode: 'SELLER', scopeKind: 'LOCATION' as const, locationIds: [LOC_A], idempotencyKey: K1, ...patch,
}) as never;

async function failure(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  throw new Error('expected a refusal');
}

describe('create (UA-C*)', () => {
  it('UA-C01 creates the user, its scope, the operation record and the audit atomically; the temp password is issued once and hashed', async () => {
    const w = world();
    const res = await w.service.create(w.owner, createInput({ email: '  Maria@Example.COM ' }));
    expect(res.replayed).toBe(false);
    expect(res.temporaryPassword).toMatch(TEMPORARY_PASSWORD_PATTERN);
    expect(res.user).toMatchObject({ name: 'Maria Lopez', email: 'maria@example.com', isActive: true, mustChangePassword: true });
    expect(res.user.assignments).toEqual([{ roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: LOC_A }]);
    const created = w.state.users.find((u) => u.email === 'maria@example.com')!;
    expect(created.mustChangePassword).toBe(true);
    expect(created.isActive).toBe(true);
    expect(await compare(res.temporaryPassword!, created.passwordHash)).toBe(true);
    expect(created.passwordHash).not.toContain(res.temporaryPassword!);
    expect(w.state.scopes.filter((s) => s.userId === created.id)).toEqual([{ userId: created.id, roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: LOC_A }]);
    expect(w.state.operations).toHaveLength(1);
    expect(w.state.operations[0]).toMatchObject({ actorId: 'owner-1', targetUserId: created.id, operation: 'CREATE_USER', idempotencyKey: K1 });
    expect(w.state.operations[0]!.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(w.state.audit).toHaveLength(1);
    expect(w.state.audit[0]).toMatchObject({ userId: 'owner-1', branchId: null, action: 'USER_CREATED', entityType: 'User', entityId: created.id });
  });

  it('UA-C02 the temporary password is in NO persisted artifact: not the user row, the operation record, the audit, nor anywhere in the state', async () => {
    const w = world();
    const res = await w.service.create(w.owner, createInput());
    const dump = JSON.stringify({ users: w.state.users, scopes: w.state.scopes, operations: w.state.operations, audit: w.state.audit, events: w.state.events });
    expect(dump).not.toContain(res.temporaryPassword!);
    expect(dump).not.toMatch(/(?<![A-Za-z0-9-])[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}(?![A-Za-z0-9-])/); // the shape of any temporary password (a UUID is longer: excluded by the boundaries)
  });

  it('UA-C03 a replay (same key, same intent) answers the same user WITHOUT a password and writes nothing', async () => {
    const w = world();
    const first = await w.service.create(w.owner, createInput());
    const before = JSON.stringify({ users: w.state.users, scopes: w.state.scopes, operations: w.state.operations, audit: w.state.audit });
    const replay = await w.service.create(w.owner, createInput());
    expect(replay.replayed).toBe(true);
    expect(replay.temporaryPassword).toBeNull();
    expect(replay.message).toMatch(/contraseña temporal ya fue emitida/i);
    expect(replay.user).toEqual(first.user);
    expect(JSON.stringify({ users: w.state.users, scopes: w.state.scopes, operations: w.state.operations, audit: w.state.audit })).toBe(before);
  });

  it('UA-C04 the intent is compared NORMALIZED: e-mail case/whitespace and location order do not make a different payload', async () => {
    const w = world();
    await w.service.create(w.owner, createInput({ locationIds: [LOC_A, LOC_B] }));
    const replay = await w.service.create(w.owner, createInput({ email: ' MARIA@example.com ', locationIds: [LOC_B, LOC_A] }));
    expect(replay.replayed).toBe(true);
    expect(w.state.users.filter((u) => u.email === 'maria@example.com')).toHaveLength(1);
  });

  it('UA-C05 the same key with another intent is refused 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD and writes nothing', async () => {
    const w = world();
    await w.service.create(w.owner, createInput());
    const snapshot = JSON.stringify([w.state.users, w.state.scopes, w.state.operations, w.state.audit]);
    for (const patch of [{ email: 'otra@example.com' }, { name: 'Otra Persona' }, { roleCode: 'CASHIER' }, { locationIds: [LOC_B] }]) {
      const error = await failure(w.service.create(w.owner, createInput(patch)));
      expect(error.status, JSON.stringify(patch)).toBe(409);
      expect(error.code, JSON.stringify(patch)).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD');
    }
    expect(JSON.stringify([w.state.users, w.state.scopes, w.state.operations, w.state.audit])).toBe(snapshot);
  });

  it('UA-C06 the key is per ACTOR: another actor using the same key is not a replay', async () => {
    const w = world();
    await w.service.create(w.owner, createInput());
    const other = await w.service.create(ctx('owner-2', 'OWNER'), createInput({ email: 'otra@example.com' }));
    expect(other.replayed).toBe(false);
    expect(w.state.operations).toHaveLength(2);
  });

  it('UA-C07 e-mail is unique ignoring case: Maria@x.com / maria@x.com / MARIA@X.COM, and a LEGACY upper-case stored e-mail, are all 409 EMAIL_TAKEN', async () => {
    const w = world();
    w.state.users.push(user('legacy-1', { email: 'Legacy.User@Example.com' }));
    await w.service.create(w.owner, createInput({ email: 'Maria@X.com', idempotencyKey: K1 }));
    for (const [email, key] of [['maria@x.com', K2], ['MARIA@X.COM', K3], ['legacy.user@example.com', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'], ['LEGACY.USER@EXAMPLE.COM', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2']] as const) {
      const error = await failure(w.service.create(w.owner, createInput({ email, idempotencyKey: key })));
      expect(error.status, email).toBe(409);
      expect(error.code, email).toBe('EMAIL_TAKEN');
    }
    expect(w.state.operations).toHaveLength(1);
    expect(w.state.audit).toHaveLength(1);
  });

  it('UA-C08 a failure after the user insert (audit) rolls EVERYTHING back: no user, no scope, no operation, no audit', async () => {
    const w = world({ auditFailure: true });
    await expect(w.service.create(w.owner, createInput())).rejects.toThrow('audit insert failed');
    expect(w.state.users.find((u) => u.email === 'maria@example.com')).toBeUndefined();
    expect(w.state.scopes.filter((s) => s.userId.startsWith('user-'))).toEqual([]);
    expect(w.state.operations).toEqual([]);
    expect(w.state.audit).toEqual([]);
    expect(w.state.events).toContain('tx:rollback');
  });

  it('UA-C09 an inactive Location is refused 400 LOCATION_INACTIVE before anything is kept', async () => {
    const w = world();
    const error = await failure(w.service.create(w.owner, createInput({ locationIds: [LOC_A, LOC_OFF] })));
    expect(error).toMatchObject({ status: 400, code: 'LOCATION_INACTIVE' });
    expect(w.state.users.find((u) => u.email === 'maria@example.com')).toBeUndefined();
    expect(w.state.operations).toEqual([]);
  });

  it('UA-C10 authorization: only OWNER creates OWNER or ADMIN; role and scope kind must be compatible', async () => {
    const w = world();
    const company_ = (roleCode: string, key: string, email: string) => createInput({ roleCode, scopeKind: 'COMPANY', locationIds: undefined, idempotencyKey: key, email });
    expect(await failure(w.service.create(w.admin, company_('ADMIN', K1, 'a1@example.com')))).toMatchObject({ status: 403 });
    expect(await failure(w.service.create(w.admin, company_('OWNER', K2, 'a2@example.com')))).toMatchObject({ status: 403 });
    expect(await failure(w.service.create(w.owner, createInput({ roleCode: 'CASHIER', scopeKind: 'COMPANY', locationIds: undefined })))).toMatchObject({ status: 403 });
    expect(await failure(w.service.create(w.owner, createInput({ roleCode: 'ADMIN' })))).toMatchObject({ status: 403 }); // ADMIN needs COMPANY
    expect(w.state.operations).toEqual([]);
    expect((await w.service.create(w.owner, company_('ADMIN', K3, 'a3@example.com'))).replayed).toBe(false);
    expect((await w.service.create(w.admin, createInput({ email: 'v@example.com', idempotencyKey: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1' }))).replayed).toBe(false);
  });

  it('UA-C11 an e-mail unique violation raised by a concurrent winner (P2002) is the domain 409 EMAIL_TAKEN, never a raw error', async () => {
    const w = world({ raceBeforeUserCreate: (world_) => { world_.users.push(user('winner-1', { email: 'maria@example.com' })); } });
    const error = await failure(w.service.create(w.owner, createInput()));
    expect(error).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    expect(w.state.operations).toEqual([]);
    expect(w.state.audit).toEqual([]);
  });

  it('UA-C12 the same key arriving concurrently with the same intent: the loser resolves to the winner\'s REPLAY (no second user, no second audit, no password)', async () => {
    // the competitor's record must carry the same canonical hash: compute it from a scratch world that really created the same intent
    const scratch = world();
    await scratch.service.create(scratch.owner, createInput());
    const intentHash = scratch.state.operations[0]!.requestHash;
    const w2 = world({
      raceBeforeUserCreate: (world_) => {
        world_.users.push(user('winner-1', { email: 'maria@example.com', mustChangePassword: true }));
        world_.scopes.push(at('winner-1', 'SELLER', LOC_A));
        world_.operations.push({ id: 'op-w', actorId: 'owner-1', targetUserId: 'winner-1', operation: 'CREATE_USER', idempotencyKey: K1, requestHash: intentHash });
        world_.audit.push({ userId: 'owner-1', branchId: null, action: 'USER_CREATED', entityType: 'User', entityId: 'winner-1' });
      },
    });
    const res = await w2.service.create(w2.owner, createInput());
    expect(res.replayed).toBe(true);
    expect(res.temporaryPassword).toBeNull();
    expect(res.user.id).toBe('winner-1');
    expect(w2.state.users.filter((u) => u.email === 'maria@example.com')).toHaveLength(1);
    expect(w2.state.audit).toHaveLength(1);
    expect(w2.state.operations).toHaveLength(1);
  });

  it('UA-C13 a transient serialization failure is retried and the create then succeeds once', async () => {
    const w = world({ transientFailures: 1 });
    const res = await w.service.create(w.owner, createInput());
    expect(res.replayed).toBe(false);
    expect(w.state.users.filter((u) => u.email === 'maria@example.com')).toHaveLength(1);
    expect(w.state.audit).toHaveLength(1);
  });
});

describe('edit (UA-U*)', () => {
  it('UA-U01 changes name and e-mail (normalized), audits before/after names and e-mails only, and does not touch credentials', async () => {
    const w = world();
    const before = w.user('seller-1');
    const hashBefore = before.passwordHash;
    const res = await w.service.update(w.owner, 'seller-1', { name: '  Ana  Ruiz ', email: 'ANA@Example.com' });
    expect(res.user).toMatchObject({ id: 'seller-1', name: 'Ana  Ruiz', email: 'ana@example.com' });
    expect(w.user('seller-1').passwordHash).toBe(hashBefore);
    expect(w.user('seller-1').credentialsChangedAt).toBeNull();
    expect(w.state.audit).toHaveLength(1);
    expect(w.state.audit[0]).toMatchObject({ userId: 'owner-1', branchId: null, action: 'USER_UPDATED', entityType: 'User', entityId: 'seller-1', before: { name: 'User seller-1', email: 'seller-1@example.com' }, after: { name: 'Ana  Ruiz', email: 'ana@example.com' } });
    expect(JSON.stringify(w.state.audit)).not.toMatch(/passwordHash|bcrypt|\$2[aby]\$/);
  });

  it('UA-U02 an identical edit (after normalization) is a no-op: no write, no audit', async () => {
    const w = world();
    await w.service.update(w.owner, 'seller-1', { name: 'User seller-1', email: 'Seller-1@Example.com' });
    expect(w.state.audit).toEqual([]);
    expect(w.state.events.filter((e) => e === 'user.update')).toEqual([]);
  });

  it('UA-U03 an e-mail held by another account (any case, legacy upper-case included) is 409 EMAIL_TAKEN; the account\'s OWN legacy e-mail normalizes without conflict', async () => {
    const w = world();
    w.state.users.push(user('legacy-1', { email: 'Legacy@Example.com' }));
    expect(await failure(w.service.update(w.owner, 'seller-1', { email: 'LEGACY@example.com' }))).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    expect(await failure(w.service.update(w.owner, 'seller-1', { email: 'Admin-1@example.com' }))).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    const own = await w.service.update(w.owner, 'legacy-1', { email: 'legacy@example.com' });
    expect(own.user.email).toBe('legacy@example.com');
    expect(w.state.audit).toHaveLength(1);
  });

  it('UA-U04 an e-mail unique violation raised by a concurrent winner (P2002) is the domain 409 EMAIL_TAKEN', async () => {
    const w = world({ raceBeforeUserUpdate: (world_) => { world_.users.push(user('winner-1', { email: 'nuevo@example.com' })); } });
    expect(await failure(w.service.update(w.owner, 'seller-1', { email: 'nuevo@example.com' }))).toMatchObject({ status: 409, code: 'EMAIL_TAKEN' });
    expect(w.state.audit).toEqual([]);
    expect(w.user('seller-1').email).toBe('seller-1@example.com');
  });

  it('UA-U05 authorization: never yourself; a non-OWNER never edits an OWNER or an ADMIN; OWNER edits an ADMIN; unknown user is 404', async () => {
    const w = world();
    expect(await failure(w.service.update(w.owner, 'owner-1', { name: 'Yo' }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.update(w.admin, 'owner-1', { name: 'X' }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.update(w.admin, 'admin-2', { name: 'X' }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.update(w.admin, 'admin-1', { name: 'X' }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.update(w.owner, 'nadie', { name: 'X' }))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect((await w.service.update(w.owner, 'admin-2', { name: 'Nuevo Admin' })).user.name).toBe('Nuevo Admin');
    expect((await w.service.update(w.admin, 'seller-1', { name: 'Nuevo' })).user.name).toBe('Nuevo');
    expect(w.state.audit).toHaveLength(2);
  });
});

describe('deactivate (UA-D*)', () => {
  it('UA-D01 deactivates, bumps the credentials epoch strictly, records the operation and audits', async () => {
    const w = world();
    w.user('seller-1').credentialsChangedAt = new Date(Date.now() + 60_000); // a clock behind the stored epoch: the new epoch is still strictly greater
    const prior = w.user('seller-1').credentialsChangedAt!;
    const res = await w.service.deactivate(w.owner, 'seller-1', { idempotencyKey: K1 });
    expect(res.replayed).toBe(false);
    expect(res.user.isActive).toBe(false);
    expect(w.user('seller-1').isActive).toBe(false);
    expect(w.user('seller-1').credentialsChangedAt!.getTime()).toBeGreaterThan(prior.getTime());
    expect(w.state.operations).toEqual([expect.objectContaining({ actorId: 'owner-1', targetUserId: 'seller-1', operation: 'DEACTIVATE_USER', idempotencyKey: K1 })]);
    expect(w.state.audit).toHaveLength(1);
    expect(w.state.audit[0]).toMatchObject({ userId: 'owner-1', branchId: null, action: 'USER_DEACTIVATED', entityType: 'User', entityId: 'seller-1', before: { isActive: true }, after: { isActive: false } });
  });

  it('UA-D02 deactivating an already inactive account is a 200 no-op (no audit, no epoch bump) that still records the key', async () => {
    const w = world();
    const res = await w.service.deactivate(w.owner, 'gone-1', { idempotencyKey: K1 });
    expect(res.user.isActive).toBe(false);
    expect(w.user('gone-1').credentialsChangedAt!.getTime()).toBe(EPOCH.getTime());
    expect(w.state.audit).toEqual([]);
    expect(w.state.operations).toHaveLength(1);
  });

  it('UA-D03 a replay never deactivates again, even after the account was reactivated in between', async () => {
    const w = world();
    await w.service.deactivate(w.owner, 'seller-1', { idempotencyKey: K1 });
    await w.service.reactivate(w.owner, 'seller-1', { idempotencyKey: K2 });
    const epoch = w.user('seller-1').credentialsChangedAt!.getTime();
    const audits = w.state.audit.length;
    const replay = await w.service.deactivate(w.owner, 'seller-1', { idempotencyKey: K1 });
    expect(replay.replayed).toBe(true);
    expect(replay.user.isActive).toBe(true);
    expect(w.user('seller-1').isActive).toBe(true);
    expect(w.user('seller-1').credentialsChangedAt!.getTime()).toBe(epoch);
    expect(w.state.audit).toHaveLength(audits);
  });

  it('UA-D04 the same key for ANOTHER target is 409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD; the same key for another operation too', async () => {
    const w = world();
    await w.service.deactivate(w.owner, 'seller-1', { idempotencyKey: K1 });
    expect(await failure(w.service.deactivate(w.owner, 'admin-2', { idempotencyKey: K1 }))).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    expect(await failure(w.service.resetPassword(w.owner, 'seller-1', { idempotencyKey: K1 }))).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    expect(w.user('admin-2').isActive).toBe(true);
  });

  it('UA-D05 authorization: never yourself; a non-OWNER never deactivates an OWNER or an ADMIN (the full matrix and the last-OWNER rule are in user-admin-u3.behavior.test.ts)', async () => {
    const w = world();
    expect(await failure(w.service.deactivate(w.owner, 'owner-1', { idempotencyKey: K1 }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.deactivate(w.admin, 'owner-1', { idempotencyKey: K1 }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.deactivate(w.admin, 'admin-2', { idempotencyKey: K1 }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.deactivate(w.owner, 'nadie', { idempotencyKey: K1 }))).toMatchObject({ status: 404 });
    expect(w.state.operations).toEqual([]);
    expect(w.state.audit).toEqual([]);
    expect((await w.service.deactivate(w.owner, 'admin-2', { idempotencyKey: K1 })).user.isActive).toBe(false);
    // U3 replaced the U2 stop-gap (409 OWNER_DEACTIVATION_NOT_SUPPORTED): an OWNER deactivates another OWNER while one remains operative
    expect((await w.service.deactivate(w.owner, 'owner-2', { idempotencyKey: K2 })).user.isActive).toBe(false);
  });
});

describe('reactivate (UA-R*)', () => {
  it('UA-R01 reactivates: new temporary password, mustChangePassword, epoch bumped, scopes preserved, old password dead, audited', async () => {
    const w = world();
    const priorEpoch = w.user('gone-1').credentialsChangedAt!;
    const res = await w.service.reactivate(w.owner, 'gone-1', { idempotencyKey: K1 });
    expect(res.replayed).toBe(false);
    expect(res.temporaryPassword).toMatch(TEMPORARY_PASSWORD_PATTERN);
    expect(res.user).toMatchObject({ isActive: true, mustChangePassword: true });
    expect(res.user.assignments).toEqual([{ roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: LOC_A }]);
    expect(await compare(res.temporaryPassword!, w.user('gone-1').passwordHash)).toBe(true);
    expect(await compare('old-password-123', w.user('gone-1').passwordHash)).toBe(false);
    expect(w.user('gone-1').credentialsChangedAt!.getTime()).toBeGreaterThan(priorEpoch.getTime());
    expect(w.state.audit).toHaveLength(1);
    expect(w.state.audit[0]).toMatchObject({ userId: 'owner-1', action: 'USER_REACTIVATED', entityType: 'User', entityId: 'gone-1', before: { isActive: false }, after: { isActive: true, mustChangePassword: true } });
    expect(JSON.stringify(w.state)).not.toContain(res.temporaryPassword!);
  });

  it('UA-R02 an already ACTIVE account is 409 USER_ALREADY_ACTIVE and nothing changes', async () => {
    const w = world();
    expect(await failure(w.service.reactivate(w.owner, 'seller-1', { idempotencyKey: K1 }))).toMatchObject({ status: 409, code: 'USER_ALREADY_ACTIVE' });
    expect(w.state.operations).toEqual([]);
    expect(w.state.audit).toEqual([]);
  });

  it('UA-R03 a scope on an inactive Location blocks the reactivation (400 LOCATION_INACTIVE) and nothing is kept', async () => {
    const w = world();
    w.state.scopes.push(at('gone-1', 'SELLER', LOC_OFF));
    const hashBefore = w.user('gone-1').passwordHash;
    expect(await failure(w.service.reactivate(w.owner, 'gone-1', { idempotencyKey: K1 }))).toMatchObject({ status: 400, code: 'LOCATION_INACTIVE' });
    expect(w.user('gone-1').isActive).toBe(false);
    expect(w.user('gone-1').passwordHash).toBe(hashBefore);
    expect(w.state.operations).toEqual([]);
  });

  it('UA-R04 a replay returns the user WITHOUT a password and does not bump the epoch or audit again', async () => {
    const w = world();
    await w.service.reactivate(w.owner, 'gone-1', { idempotencyKey: K1 });
    const hashAfter = w.user('gone-1').passwordHash;
    const epoch = w.user('gone-1').credentialsChangedAt!.getTime();
    const replay = await w.service.reactivate(w.owner, 'gone-1', { idempotencyKey: K1 });
    expect(replay).toMatchObject({ replayed: true, temporaryPassword: null });
    expect(replay.message).toMatch(/contraseña temporal ya fue emitida/i);
    expect(w.user('gone-1').passwordHash).toBe(hashAfter);
    expect(w.user('gone-1').credentialsChangedAt!.getTime()).toBe(epoch);
    expect(w.state.audit).toHaveLength(1);
    expect(w.state.operations).toHaveLength(1);
  });

  it('UA-R05 authorization: never yourself; a non-OWNER never reactivates an OWNER or ADMIN', async () => {
    const w = world();
    w.user('admin-2').isActive = false;
    w.user('owner-2').isActive = false;
    expect(await failure(w.service.reactivate(w.admin, 'admin-2', { idempotencyKey: K1 }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.reactivate(w.admin, 'owner-2', { idempotencyKey: K2 }))).toMatchObject({ status: 403 });
    expect((await w.service.reactivate(w.owner, 'admin-2', { idempotencyKey: K3 })).user.isActive).toBe(true);
  });
});

describe('reset password (UA-P*)', () => {
  it('UA-P01 resets an active account: new temporary password, mustChangePassword, epoch bumped, audited without any secret', async () => {
    const w = world();
    const res = await w.service.resetPassword(w.owner, 'seller-1', { idempotencyKey: K1 });
    expect(res.replayed).toBe(false);
    expect(res.temporaryPassword).toMatch(TEMPORARY_PASSWORD_PATTERN);
    expect(await compare(res.temporaryPassword!, w.user('seller-1').passwordHash)).toBe(true);
    expect(await compare('old-password-123', w.user('seller-1').passwordHash)).toBe(false);
    expect(w.user('seller-1')).toMatchObject({ mustChangePassword: true, isActive: true });
    expect(w.user('seller-1').credentialsChangedAt).toBeInstanceOf(Date);
    expect(w.state.audit).toHaveLength(1);
    expect(w.state.audit[0]).toMatchObject({ userId: 'owner-1', branchId: null, action: 'USER_PASSWORD_RESET', entityType: 'User', entityId: 'seller-1' });
    expect(JSON.stringify(w.state)).not.toContain(res.temporaryPassword!);
  });

  it('UA-P02 an inactive account cannot be reset (409 USER_INACTIVE: reactivate it first)', async () => {
    const w = world();
    expect(await failure(w.service.resetPassword(w.owner, 'gone-1', { idempotencyKey: K1 }))).toMatchObject({ status: 409, code: 'USER_INACTIVE' });
    expect(w.state.operations).toEqual([]);
  });

  it('UA-P03 a replay does not regenerate anything: same hash, same epoch, one audit, no password in the answer', async () => {
    const w = world();
    await w.service.resetPassword(w.owner, 'seller-1', { idempotencyKey: K1 });
    const hashAfter = w.user('seller-1').passwordHash;
    const epoch = w.user('seller-1').credentialsChangedAt!.getTime();
    const replay = await w.service.resetPassword(w.owner, 'seller-1', { idempotencyKey: K1 });
    expect(replay).toMatchObject({ replayed: true, temporaryPassword: null });
    expect(replay.message).toMatch(/Resetear contraseña/);
    expect(w.user('seller-1').passwordHash).toBe(hashAfter);
    expect(w.user('seller-1').credentialsChangedAt!.getTime()).toBe(epoch);
    expect(w.state.audit).toHaveLength(1);
    expect(w.state.operations).toHaveLength(1);
  });

  it('UA-P04 two resets with DIFFERENT keys are two real resets and the second epoch is strictly greater than the first (frozen clock)', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-01T12:00:00.000Z'));
      const w = world();
      const a = await w.service.resetPassword(w.owner, 'seller-1', { idempotencyKey: K1 });
      const first = w.user('seller-1').credentialsChangedAt!.getTime();
      const b = await w.service.resetPassword(w.owner, 'seller-1', { idempotencyKey: K2 });
      const second = w.user('seller-1').credentialsChangedAt!.getTime();
      expect(second).toBeGreaterThan(first);
      expect(a.temporaryPassword).not.toBe(b.temporaryPassword);
      expect(await compare(b.temporaryPassword!, w.user('seller-1').passwordHash)).toBe(true);
      expect(await compare(a.temporaryPassword!, w.user('seller-1').passwordHash)).toBe(false);
      expect(w.state.audit).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('UA-P05 authorization: never yourself (use change-password); a non-OWNER never resets an OWNER or an ADMIN; OWNER resets an ADMIN', async () => {
    const w = world();
    expect(await failure(w.service.resetPassword(w.owner, 'owner-1', { idempotencyKey: K1 }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.resetPassword(w.admin, 'owner-1', { idempotencyKey: K1 }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.resetPassword(w.admin, 'admin-2', { idempotencyKey: K1 }))).toMatchObject({ status: 403 });
    expect(await failure(w.service.resetPassword(w.owner, 'nadie', { idempotencyKey: K1 }))).toMatchObject({ status: 404 });
    expect(w.state.operations).toEqual([]);
    expect((await w.service.resetPassword(w.owner, 'admin-2', { idempotencyKey: K2 })).replayed).toBe(false);
  });

  it('UA-P06 a failing audit rolls the reset back: the old password still works, the epoch is unchanged, no operation is recorded', async () => {
    const w = world({ auditFailure: true });
    const hashBefore = w.user('seller-1').passwordHash;
    await expect(w.service.resetPassword(w.owner, 'seller-1', { idempotencyKey: K1 })).rejects.toThrow('audit insert failed');
    expect(w.user('seller-1').passwordHash).toBe(hashBefore);
    expect(w.user('seller-1').mustChangePassword).toBe(false);
    expect(w.user('seller-1').credentialsChangedAt).toBeNull();
    expect(w.state.operations).toEqual([]);
  });
});

describe('cross-cutting (UA-X*)', () => {
  it('UA-X01 nothing is logged by the lifecycle: no console output at all, whatever the outcome (the temporary password never reaches a log)', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      const w = world();
      const created = await w.service.create(w.owner, createInput());
      await w.service.resetPassword(w.owner, 'seller-1', { idempotencyKey: K2 });
      await failure(w.service.create(w.owner, createInput({ idempotencyKey: K3 })));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(created.temporaryPassword).not.toBeNull();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
