// USER-MGMT-01 U2 — the identity lifecycle through the REAL app (global auth middleware, permission gate, strict validation, controller, service)
// against the in-memory stub of tests/helpers/user-admin-stub.ts. DB-free.
//
//   UH-01..UH-04  create: status codes, no-store on every answer, strict bodies, the USER_MANAGE gate before validation
//   UH-05         end to end: create -> login (any capitalisation) -> forced password change -> the temporary password is dead
//   UH-06..UH-08  edit / deactivate / reactivate / reset over HTTP; login e-mail is case-insensitive
import { hash } from 'bcryptjs';
import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { signAccessToken } from '../../src/modules/auth/tokens.js';
import { createUserAdminStub, type AdminStubUser } from '../helpers/user-admin-stub.js';

vi.mock('../../src/modules/auth/password.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/modules/auth/password.js')>('../../src/modules/auth/password.js');
  const { hash: bcryptHash } = await import('bcryptjs');
  return { ...actual, hashPassword: (password: string) => bcryptHash(password, 4) };
});

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const CASHIER = '00000000-0000-4000-8000-0000000000a2';
const SELLER = '00000000-0000-4000-8000-0000000000a3';
const GONE = '00000000-0000-4000-8000-0000000000a4';
const LOC_A = '11111111-1111-4111-8111-111111111111';
const K1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const K2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const K3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
const BASE = '/api/v1/backoffice/users';
const NEW_PASSWORD = 'una-contrasena-nueva-123';

let oldHash = '';
beforeAll(async () => {
  oldHash = await hash('old-password-123', 4);
});

const user = (id: string, patch: Partial<AdminStubUser> = {}): AdminStubUser => ({
  id, name: `User ${id.slice(-2)}`, email: `u${id.slice(-2)}@example.com`, isActive: true, passwordHash: oldHash, mustChangePassword: false, credentialsChangedAt: null, ...patch,
});

function world() {
  const stub = createUserAdminStub({
    users: [user(OWNER), user(CASHIER), user(SELLER, { email: 'Legacy.Seller@Example.com' }), user(GONE, { isActive: false })],
    scopes: [
      { userId: OWNER, roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null },
      { userId: CASHIER, roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: LOC_A },
      { userId: SELLER, roleCode: 'SELLER', scopeKind: 'LOCATION', locationId: LOC_A },
      { userId: GONE, roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: LOC_A },
    ],
    locations: [{ id: LOC_A, name: 'Local A', code: 'A', isActive: true }],
  });
  return { ...stub, app: createApp(stub.db) };
}
type World = ReturnType<typeof world>;

const as = async (userId: string) => ({ Authorization: `Bearer ${await signAccessToken(userId, null)}` });
const createBody = (patch: Record<string, unknown> = {}) => ({ name: 'Maria Lopez', email: 'Maria@Example.com', roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [LOC_A], idempotencyKey: K1, ...patch });
const post = async (w: World, path: string, body: unknown, actor = OWNER) => request(w.app).post(path).set(await as(actor)).send(body as object);

describe('create over HTTP (UH-01..UH-04)', () => {
  it('UH-01 201 with the temporary password once, then 200 on the replay WITHOUT it; both answers are no-store', async () => {
    const w = world();
    const first = await post(w, BASE, createBody());
    expect(first.status).toBe(201);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).toMatchObject({ replayed: false, user: { email: 'maria@example.com', isActive: true, mustChangePassword: true } });
    expect(first.body.temporaryPassword).toMatch(/^[A-Za-z2-9]{4}(-[A-Za-z2-9]{4}){3}$/);
    const replay = await post(w, BASE, createBody());
    expect(replay.status).toBe(200);
    expect(replay.headers['cache-control']).toBe('no-store');
    expect(replay.body).toMatchObject({ replayed: true, temporaryPassword: null, user: { id: first.body.user.id } });
    expect(replay.body.message).toMatch(/Resetear contraseña/);
    expect(JSON.stringify(replay.body)).not.toContain(first.body.temporaryPassword);
  });

  it('UH-02 every refusal is no-store too: validation 400, the permission gate 403, EMAIL_TAKEN 409, the reused key 409', async () => {
    const w = world();
    await post(w, BASE, createBody());
    const answers = [
      await post(w, BASE, createBody({ idempotencyKey: 'no-es-un-uuid' })),
      await post(w, BASE, createBody(), CASHIER),
      await post(w, BASE, createBody({ idempotencyKey: K2 })),
      await post(w, BASE, createBody({ email: 'otra@example.com' })),
    ];
    expect(answers.map((a) => a.status)).toEqual([400, 403, 409, 409]);
    expect(answers.map((a) => a.body.error.code)).toEqual(['VALIDATION_ERROR', 'FORBIDDEN', 'EMAIL_TAKEN', 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD']);
    for (const answer of answers) expect(answer.headers['cache-control']).toBe('no-store');
  });

  it('UH-03 the body is strict: no password, no isActive, no unknown field, no missing key, no bad e-mail, no duplicate locations', async () => {
    const w = world();
    const bad = [
      createBody({ password: 'secreta-123456' }), createBody({ isActive: false }), createBody({ mustChangePassword: false }), createBody({ extra: 1 }),
      { ...createBody(), idempotencyKey: undefined }, createBody({ idempotencyKey: 'AAAAAAAA-AAAA-1AAA-8AAA-AAAAAAAAAAA1' }), createBody({ email: 'no-es-un-email' }),
      createBody({ name: '   ' }), createBody({ locationIds: [LOC_A, LOC_A] }), createBody({ locationIds: [] }), createBody({ roleCode: 'MANAGER' }), createBody({ scopeKind: 'ALL' }),
    ];
    for (const body of bad) {
      const res = await post(w, BASE, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(w.state.users).toHaveLength(4);
    expect(w.state.operations).toEqual([]);
  });

  it('UH-04 the USER_MANAGE gate runs BEFORE validation: a caller without it gets 403 even with an invalid body, and learns nothing about the schema', async () => {
    const w = world();
    for (const [path, method] of [[BASE, 'post'], [`${BASE}/${SELLER}`, 'patch'], [`${BASE}/${SELLER}/deactivate`, 'post'], [`${BASE}/${SELLER}/reactivate`, 'post'], [`${BASE}/${SELLER}/reset-password`, 'post']] as const) {
      const res = await request(w.app)[method](path).set(await as(CASHIER)).send({ basura: true });
      expect(res.status, path).toBe(403);
      expect(res.headers['cache-control'], path).toBe('no-store');
    }
    expect((await request(w.app).post(BASE).send(createBody())).status).toBe(401);
    expect(w.state.operations).toEqual([]);
  });
});

describe('end to end (UH-05)', () => {
  it('UH-05 create -> login with ANY capitalisation -> blocked until the password is changed -> the temporary password is dead afterwards', async () => {
    const w = world();
    const created = await post(w, BASE, createBody());
    const temporary = created.body.temporaryPassword as string;

    const login = await request(w.app).post('/api/v1/auth/login').send({ email: 'MARIA@example.COM', password: temporary });
    expect(login.status).toBe(200);
    expect(login.body.user).toMatchObject({ email: 'maria@example.com', mustChangePassword: true });
    const token = login.body.accessToken as string;

    const blocked = await request(w.app).get(BASE).set({ Authorization: `Bearer ${token}` });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const changed = await request(w.app).post('/api/v1/auth/change-password').set({ Authorization: `Bearer ${token}` }).send({ currentPassword: temporary, newPassword: NEW_PASSWORD });
    expect(changed.status).toBe(200);
    expect(changed.body.user.mustChangePassword).toBe(false);
    expect((await request(w.app).get('/api/v1/auth/me').set({ Authorization: `Bearer ${token}` })).status).toBe(401); // the temporary-password session ended

    expect((await request(w.app).post('/api/v1/auth/login').send({ email: 'maria@example.com', password: temporary })).status).toBe(401);
    expect((await request(w.app).post('/api/v1/auth/login').send({ email: 'maria@example.com', password: NEW_PASSWORD })).status).toBe(200);
  });
});

describe('edit, deactivate, reactivate, reset over HTTP (UH-06..UH-08)', () => {
  it('UH-06 PATCH changes name/e-mail (strict body, at least one field) and is no-store', async () => {
    const w = world();
    const ok = await request(w.app).patch(`${BASE}/${SELLER}`).set(await as(OWNER)).send({ name: 'Ana Ruiz', email: 'ANA@Example.com' });
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body.user).toMatchObject({ id: SELLER, name: 'Ana Ruiz', email: 'ana@example.com' });
    for (const body of [{}, { password: 'x' }, { isActive: false }, { name: 'A', roleCode: 'ADMIN' }]) {
      expect((await request(w.app).patch(`${BASE}/${SELLER}`).set(await as(OWNER)).send(body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(w.app).patch(`${BASE}/no-es-uuid`).set(await as(OWNER)).send({ name: 'A' })).status).toBe(400);
    const taken = await request(w.app).patch(`${BASE}/${SELLER}`).set(await as(OWNER)).send({ email: 'UA2@example.com' });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('UH-07 deactivate ends the sessions and blocks login; reactivate issues a new temporary password; reset replaces it; replays carry no password', async () => {
    const w = world();
    const sellerToken = { Authorization: `Bearer ${await signAccessToken(SELLER, null)}` };
    expect((await request(w.app).get('/api/v1/auth/me').set(sellerToken)).status).toBe(200);

    const off = await post(w, `${BASE}/${SELLER}/deactivate`, { idempotencyKey: K1 });
    expect(off.status).toBe(200);
    expect(off.headers['cache-control']).toBe('no-store');
    expect(off.body).toMatchObject({ replayed: false, user: { isActive: false } });
    const dead = await request(w.app).get('/api/v1/auth/me').set(sellerToken);
    expect([dead.status, dead.body.error.code]).toEqual([403, 'INACTIVE_USER']); // the session is over: the very next request is refused
    expect((await request(w.app).post('/api/v1/auth/login').send({ email: 'legacy.seller@example.com', password: 'old-password-123' })).status).toBe(403);
    expect((await post(w, `${BASE}/${SELLER}/deactivate`, { idempotencyKey: K1 })).body.replayed).toBe(true);

    const back = await post(w, `${BASE}/${SELLER}/reactivate`, { idempotencyKey: K2 });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ replayed: false, user: { isActive: true, mustChangePassword: true } });
    const afterReactivate = back.body.temporaryPassword as string;
    expect((await request(w.app).post('/api/v1/auth/login').send({ email: 'legacy.seller@example.com', password: afterReactivate })).status).toBe(200);
    expect((await post(w, `${BASE}/${SELLER}/reactivate`, { idempotencyKey: K2 })).body).toMatchObject({ replayed: true, temporaryPassword: null });

    const reset = await post(w, `${BASE}/${SELLER}/reset-password`, { idempotencyKey: K3 });
    expect(reset.status).toBe(200);
    expect(reset.body.temporaryPassword).not.toBe(afterReactivate);
    expect((await request(w.app).post('/api/v1/auth/login').send({ email: 'legacy.seller@example.com', password: afterReactivate })).status).toBe(401);
    expect((await request(w.app).post('/api/v1/auth/login').send({ email: 'legacy.seller@example.com', password: reset.body.temporaryPassword })).status).toBe(200);
    expect((await post(w, `${BASE}/${SELLER}/reset-password`, { idempotencyKey: K3 })).body).toMatchObject({ replayed: true, temporaryPassword: null });
    expect(w.state.audit.map((a) => a.action)).toEqual(['USER_DEACTIVATED', 'USER_REACTIVATED', 'USER_PASSWORD_RESET']);
  });

  it('UH-08 a historical upper-case e-mail logs in with any capitalisation; unknown e-mail and wrong password stay indistinguishable', async () => {
    const w = world();
    const attempts = ['Legacy.Seller@Example.com', 'legacy.seller@example.com', 'LEGACY.SELLER@EXAMPLE.COM'];
    // the SELLER holds a hash of 'old-password-123'
    for (const email of attempts) expect((await request(w.app).post('/api/v1/auth/login').send({ email, password: 'old-password-123' })).status, email).toBe(200);
    const wrong = await request(w.app).post('/api/v1/auth/login').send({ email: 'legacy.seller@example.com', password: 'otra-cosa-123456' });
    const unknown = await request(w.app).post('/api/v1/auth/login').send({ email: 'nadie@example.com', password: 'otra-cosa-123456' });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body).toEqual(unknown.body);
  });
});
