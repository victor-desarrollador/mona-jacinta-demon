// USER-MGMT-01 U1 — POST /api/v1/auth/change-password through the REAL app, DB-free (in-memory stub with real rollback semantics).
//
// Contract: authenticated; body { currentPassword, newPassword } (strict); in ONE transaction the User row is locked FOR NO KEY UPDATE,
// the CURRENT password is verified against the hash read UNDER the lock, the new password is stored (hashed OUTSIDE the transaction),
// mustChangePassword becomes false, the credentials epoch moves to max(now, previous + 1 ms) and USER_PASSWORD_CHANGED is audited in
// the same transaction. The new token is signed only AFTER the commit, carrying the committed epoch as `cc`.
// The two-simultaneous-requests race is proven on real PostgreSQL (user-credentials-epoch.pg.test.ts); here the lost-race shape is
// reproduced deterministically with the stub's onLock hook (a winner that committed while this request waited for the lock).
//
//   CP-01..CP-03 success, temporary password, epoch/token
//   CP-04..CP-06 refusals write nothing
//   CP-07..CP-09 audit: present, in the same transaction, never a secret
//   CP-10..CP-13 atomicity, lock, hash outside / verify under the lock, lost race
//   CP-14        epoch progression
//   CP-15..CP-18 transport: 401, strict body, no-store, transient retry
import { compare, hash } from 'bcryptjs';
import { decodeJwt } from 'jose';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { createCredentialsStub, type StubState, type StubUser } from '../helpers/user-credentials-stub.js';

// Spy on the REAL bcrypt helpers to prove WHERE (inside or outside the transaction) each one runs.
const calls = vi.hoisted(() => ({ list: [] as { fn: string; txOpen: boolean | null }[], probe: null as null | (() => boolean) }));
vi.mock('../../src/modules/auth/password.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/modules/auth/password.js')>();
  return {
    ...original,
    hashPassword: (password: string) => {
      calls.list.push({ fn: 'hash', txOpen: calls.probe?.() ?? null });
      return original.hashPassword(password);
    },
    verifyPassword: (password: string, passwordHash: string) => {
      calls.list.push({ fn: 'verify', txOpen: calls.probe?.() ?? null });
      return original.verifyPassword(password, passwordHash);
    },
  };
});

const CURRENT = 'current-password-123';
const NEXT = 'brand-new-password-456';
const EMAIL = 'maria@example.com';
const URL = '/api/v1/auth/change-password';

let currentHash = '';
beforeAll(async () => {
  currentHash = await hash(CURRENT, 4);
});
afterEach(() => {
  calls.list = [];
  calls.probe = null;
  vi.useRealTimers();
});

const user = (patch: Partial<StubUser> = {}): StubUser => ({
  id: 'user-1', name: 'Maria Lopez', email: EMAIL, isActive: true, passwordHash: currentHash,
  mustChangePassword: false, credentialsChangedAt: null, ...patch,
});

function world(patch: Partial<StubUser> = {}, options: Parameters<typeof createCredentialsStub>[1] = {}) {
  const stub = createCredentialsStub([user(patch)], options);
  calls.probe = () => stub.state.txOpen;
  return { ...stub, app: createApp(stub.db) };
}

const change = (app: ReturnType<typeof createApp>, token: string, body: unknown) => request(app).post(URL).set('Authorization', `Bearer ${token}`).send(body as object);
const tokenOf = (epoch: Date | null = null) => signAccessToken('user-1', epoch);

describe('success (CP-01..CP-03)', () => {
  it('CP-01 stores the new password, clears the flag, moves the epoch and answers a token + user', async () => {
    const w = world({ credentialsChangedAt: new Date(1_700_000_000_000) });
    const res = await change(w.app, await tokenOf(new Date(1_700_000_000_000)), { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.status).toBe(200);
    const stored = w.user('user-1');
    expect(await compare(NEXT, stored.passwordHash)).toBe(true);
    expect(await compare(CURRENT, stored.passwordHash)).toBe(false);
    expect(stored.mustChangePassword).toBe(false);
    expect(stored.credentialsChangedAt!.getTime()).toBeGreaterThan(1_700_000_000_000);
    expect(res.body.user.id).toBe('user-1');
    expect(res.body.user.mustChangePassword).toBe(false);
    expect(typeof res.body.accessToken).toBe('string');
  });

  it('CP-02 a temporary password (mustChangePassword) is changed the same way and the pending flag is cleared', async () => {
    const w = world({ mustChangePassword: true });
    const res = await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.status).toBe(200);
    expect(w.user('user-1').mustChangePassword).toBe(false);
    expect(res.body.user.mustChangePassword).toBe(false);
    const after = await request(w.app).get('/api/v1/cash/register?branchId=00000000-0000-4000-8000-000000000000').set('Authorization', `Bearer ${res.body.accessToken}`);
    expect(after.body.error?.code).not.toBe('PASSWORD_CHANGE_REQUIRED'); // the new token is no longer blocked
  });

  it('CP-03 the NEW token carries the committed epoch as cc and is valid at once; the PREVIOUS token is invalid on the next request', async () => {
    const w = world();
    const previous = await tokenOf();
    const res = await change(w.app, previous, { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.status).toBe(200);
    const committed = w.user('user-1').credentialsChangedAt!;
    expect(decodeJwt(res.body.accessToken).cc).toBe(committed.getTime());
    expect((await request(w.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.accessToken}`)).status).toBe(200);
    const old = await request(w.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${previous}`);
    expect(old.status).toBe(401);
    expect(old.body.error.code).toBe('UNAUTHORIZED');
  });
});

describe('refusals write nothing (CP-04..CP-06)', () => {
  const untouched = (w: ReturnType<typeof world>) => {
    expect(w.user('user-1').passwordHash).toBe(currentHash);
    expect(w.user('user-1').credentialsChangedAt).toBeNull();
    expect(w.state.audit).toHaveLength(0);
    expect(w.state.events).not.toContain('update');
  };

  it('CP-04 a wrong current password is 400 INVALID_CURRENT_PASSWORD, with no write and no audit', async () => {
    const w = world();
    const res = await change(w.app, await tokenOf(), { currentPassword: 'not-the-password', newPassword: NEXT });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    untouched(w);
  });

  it.each([
    ['9 bytes', 'a'.repeat(9)],
    ['73 bytes', 'a'.repeat(73)],
    ['a multibyte string over 72 bytes', 'ñ'.repeat(37)],
    ['the account email', EMAIL],
    ['the current password', CURRENT],
  ])('CP-05 a new password that is %s is 400 PASSWORD_POLICY_VIOLATION and nothing is written', async (_label, newPassword) => {
    const w = world();
    const res = await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PASSWORD_POLICY_VIOLATION');
    untouched(w);
  });

  it('CP-06 an account that became inactive between the token check and the lock is refused 403 INACTIVE_USER and nothing is written', async () => {
    const w = world({}, { onLock: (state) => { state.users[0]!.isActive = false; } });
    const res = await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INACTIVE_USER');
    expect(w.user('user-1').passwordHash).toBe(currentHash);
    expect(w.state.audit).toHaveLength(0);
  });
});

describe('audit (CP-07..CP-09)', () => {
  it('CP-07 exactly one USER_PASSWORD_CHANGED row, written by the user on itself, with the minimal before/after snapshot', async () => {
    const w = world({ mustChangePassword: true });
    expect((await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword: NEXT })).status).toBe(200);
    expect(w.state.audit).toHaveLength(1);
    const row = w.state.audit[0]!;
    expect(row).toMatchObject({ userId: 'user-1', action: 'USER_PASSWORD_CHANGED', entityType: 'User', entityId: 'user-1', branchId: null });
    expect(row.before).toEqual({ mustChangePassword: true, credentialsChangedAt: null });
    const committed = w.user('user-1').credentialsChangedAt!;
    expect(row.after).toEqual({ mustChangePassword: false, credentialsChangedAt: committed.toISOString() });
  });

  it('CP-08 the audit row is written in the SAME transaction as the user update (between its begin and commit, after the lock)', async () => {
    const w = world();
    await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword: NEXT });
    expect(w.state.events).toEqual(['tx:begin', 'lock', 'update', 'audit', 'tx:commit']);
  });

  it('CP-09 no secret ever reaches the audit payload: not the current/new password, not any hash, not a token', async () => {
    const w = world();
    const previous = await tokenOf();
    const res = await change(w.app, previous, { currentPassword: CURRENT, newPassword: NEXT });
    const serialized = JSON.stringify(w.state.audit);
    for (const secret of [CURRENT, NEXT, currentHash, w.user('user-1').passwordHash, previous, res.body.accessToken as string]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toMatch(/\$2[aby]\$/);
    expect(serialized).not.toMatch(/passwordHash|currentPassword|newPassword|accessToken/);
  });
});

describe('atomicity, lock and the race (CP-10..CP-13)', () => {
  it('CP-10 an audit failure rolls the whole change back: old password, flag and epoch intact, no token, 500', async () => {
    const w = world({ mustChangePassword: true }, { auditFailure: true });
    const res = await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.status).toBe(500);
    expect(res.body.accessToken).toBeUndefined();
    expect(w.user('user-1').passwordHash).toBe(currentHash);
    expect(w.user('user-1').mustChangePassword).toBe(true);
    expect(w.user('user-1').credentialsChangedAt).toBeNull();
    expect(w.state.events).toContain('tx:rollback');
  });

  it('CP-11 the user row is locked FOR NO KEY UPDATE by id inside the transaction before anything is written', async () => {
    const w = world();
    await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword: NEXT });
    const lock = w.state.statements.find((s) => /FOR NO KEY UPDATE/.test(s))!;
    expect(lock).toMatch(/FROM "User"\s+WHERE id = \?\s+FOR NO KEY UPDATE/);
    expect(w.state.events.indexOf('lock')).toBeGreaterThan(w.state.events.indexOf('tx:begin'));
    expect(w.state.events.indexOf('lock')).toBeLessThan(w.state.events.indexOf('update'));
  });

  it('CP-12 the new password is hashed OUTSIDE the transaction and the current one is verified INSIDE it (under the lock)', async () => {
    const w = world();
    await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword: NEXT });
    const hashes = calls.list.filter((c) => c.fn === 'hash');
    const verifies = calls.list.filter((c) => c.fn === 'verify');
    expect(hashes).toHaveLength(1);
    expect(hashes[0]!.txOpen).toBe(false);
    expect(verifies.length).toBeGreaterThanOrEqual(1);
    expect(verifies.every((c) => c.txOpen === true)).toBe(true);
  });

  it('CP-13 a lost race: a winner changed the credentials while this request waited for the lock -> the current password is verified against the WINNER hash and refused, with no write, no audit and no token', async () => {
    const winnerHash = await hash('winner-new-password-789', 4);
    const w = world({}, {
      onLock: (state: StubState) => {
        state.users[0]!.passwordHash = winnerHash;
        state.users[0]!.credentialsChangedAt = new Date(1_700_000_000_500);
      },
    });
    const res = await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(w.user('user-1').passwordHash).toBe(winnerHash); // the winner's state is untouched
    expect(w.user('user-1').credentialsChangedAt!.getTime()).toBe(1_700_000_000_500);
    expect(w.state.audit).toHaveLength(0);
    expect(res.body.accessToken).toBeUndefined();
  });
});

describe('epoch progression (CP-14)', () => {
  it('CP-14 two consecutive changes in the same millisecond, or with the clock behind the stored epoch, still move the epoch strictly forward; the first token dies', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(1_700_000_000_000));
    const w = world({ credentialsChangedAt: new Date(1_700_000_010_000) }); // the stored epoch is AHEAD of the clock
    const first = await change(w.app, await tokenOf(new Date(1_700_000_010_000)), { currentPassword: CURRENT, newPassword: NEXT });
    expect(first.status).toBe(200);
    const e1 = w.user('user-1').credentialsChangedAt!.getTime();
    expect(e1).toBe(1_700_000_010_001);
    const second = await change(w.app, first.body.accessToken as string, { currentPassword: NEXT, newPassword: 'third-password-xyz-1' });
    expect(second.status).toBe(200);
    const e2 = w.user('user-1').credentialsChangedAt!.getTime();
    expect(e2).toBe(e1 + 1);
    expect((await request(w.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${first.body.accessToken}`)).status).toBe(401);
    expect((await request(w.app).get('/api/v1/auth/me').set('Authorization', `Bearer ${second.body.accessToken}`)).status).toBe(200);
  });
});

describe('transport (CP-15..CP-18)', () => {
  it('CP-15 without a token: 401', async () => {
    const w = world();
    expect((await request(w.app).post(URL).send({ currentPassword: CURRENT, newPassword: NEXT })).status).toBe(401);
  });

  it.each([
    ['an extra field', { currentPassword: CURRENT, newPassword: NEXT, email: 'x@y.z' }],
    ['a missing newPassword', { currentPassword: CURRENT }],
    ['an empty currentPassword', { currentPassword: '', newPassword: NEXT }],
    ['a non-string password', { currentPassword: CURRENT, newPassword: 12345678901 }],
  ])('CP-16 %s is a 400 VALIDATION_ERROR and nothing runs', async (_label, body) => {
    const w = world();
    const res = await change(w.app, await tokenOf(), body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(w.state.transactions).toBe(0);
  });

  it('CP-17 the response (it carries a token) is never cacheable', async () => {
    const w = world();
    const res = await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('CP-18 a transient transaction failure (40001 / P2034) is retried and the change then commits exactly once', async () => {
    const w = world({}, { transientFailures: 1 });
    const res = await change(w.app, await tokenOf(), { currentPassword: CURRENT, newPassword: NEXT });
    expect(res.status).toBe(200);
    expect(w.state.audit).toHaveLength(1);
    expect(w.state.transactions).toBe(1);
  });
});
