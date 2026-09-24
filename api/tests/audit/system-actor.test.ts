import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { compare } from 'bcryptjs';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch } from '../helpers/factories.js';
import {
  bootstrapSystemActor,
  planSystemActorBootstrap,
  resolveSystemActorId,
  SYSTEM_ACTOR_EMAIL,
  SYSTEM_ACTOR_NAME,
  SYSTEM_ACTOR_USER_ID,
} from '../../src/modules/audit/system-actor.service.js';
import { main, type BootstrapSystemActorCliDeps } from '../../scripts/bootstrap-system-actor.js';

// Pilot P0.1-B1: the dedicated, inactive, scope-less technical User that
// system-generated reservation-expiry audits are attributed to.
describe('system audit actor bootstrap (Pilot P0.1-B1)', () => {
  let db: Awaited<ReturnType<typeof createTestPrismaClient>>;
  const hashFor = (plaintext: string) => async () => `hash-of-${plaintext.length}-chars`;

  beforeAll(async () => {
    db = await createTestPrismaClient();
  });
  beforeEach(async () => {
    await truncateAllTables(db);
    await bootstrapProductionRbacCatalog(db);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });
  afterAll(async () => db.$disconnect());

  const actorRow = () => db.user.findUnique({ where: { id: SYSTEM_ACTOR_USER_ID } });

  it('creates an inactive actor with zero UserRoleScope and zero UserBranchRole rows', async () => {
    const result = await bootstrapSystemActor(db, { createPasswordHash: hashFor('x') });
    expect(result).toEqual({ action: 'CREATED', userId: SYSTEM_ACTOR_USER_ID });
    const user = await actorRow();
    expect(user).toMatchObject({
      id: SYSTEM_ACTOR_USER_ID, email: SYSTEM_ACTOR_EMAIL, name: SYSTEM_ACTOR_NAME, isActive: false,
    });
    expect(await db.userRoleScope.count({ where: { userId: SYSTEM_ACTOR_USER_ID } })).toBe(0);
    expect(await db.userBranchRole.count({ where: { userId: SYSTEM_ACTOR_USER_ID } })).toBe(0);
    expect(await resolveSystemActorId(db)).toBe(SYSTEM_ACTOR_USER_ID);
  });

  it('is idempotent and leaves an existing valid actor byte-for-byte unchanged', async () => {
    await bootstrapSystemActor(db, { createPasswordHash: hashFor('x') });
    const before = await actorRow();
    const createPasswordHash = vi.fn(hashFor('y'));
    const again = await bootstrapSystemActor(db, { createPasswordHash });
    expect(again).toEqual({ action: 'NOOP_ALREADY_VALID', userId: SYSTEM_ACTOR_USER_ID });
    expect(createPasswordHash).not.toHaveBeenCalled();
    expect(await actorRow()).toEqual(before);
    expect(await db.user.count()).toBe(1);
  });

  it('fails closed without repair when the actor is active', async () => {
    await bootstrapSystemActor(db, { createPasswordHash: hashFor('x') });
    await db.user.update({ where: { id: SYSTEM_ACTOR_USER_ID }, data: { isActive: true } });
    const before = await actorRow();
    await expect(bootstrapSystemActor(db, { createPasswordHash: hashFor('x') })).rejects.toThrow(/active/i);
    expect(await actorRow()).toEqual(before);
    expect((await planSystemActorBootstrap(db)).readyForExecution).toBe(false);
    await expect(resolveSystemActorId(db)).rejects.toMatchObject({ code: 'SYSTEM_ACTOR_UNAVAILABLE' });
  });

  it('fails closed when the actor gained a UserRoleScope', async () => {
    await bootstrapSystemActor(db, { createPasswordHash: hashFor('x') });
    const role = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    await db.userRoleScope.create({
      data: { userId: SYSTEM_ACTOR_USER_ID, roleId: role.id, scopeKind: 'COMPANY', locationId: null },
    });
    await expect(bootstrapSystemActor(db, { createPasswordHash: hashFor('x') })).rejects.toThrow(/scope/i);
    expect(await db.userRoleScope.count({ where: { userId: SYSTEM_ACTOR_USER_ID } })).toBe(1);
    await expect(resolveSystemActorId(db)).rejects.toMatchObject({ code: 'SYSTEM_ACTOR_UNAVAILABLE' });
  });

  it('fails closed when the actor has a legacy UserBranchRole', async () => {
    await bootstrapSystemActor(db, { createPasswordHash: hashFor('x') });
    const branch = await createBranch(db);
    const role = await db.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    await db.userBranchRole.create({ data: { userId: SYSTEM_ACTOR_USER_ID, branchId: branch.id, roleId: role.id } });
    await expect(bootstrapSystemActor(db, { createPasswordHash: hashFor('x') })).rejects.toThrow(/UserBranchRole/);
    await expect(resolveSystemActorId(db)).rejects.toMatchObject({ code: 'SYSTEM_ACTOR_UNAVAILABLE' });
  });

  it('fails closed on a conflicting identity (canonical email on another id, or canonical id with another email/name)', async () => {
    await db.user.create({ data: { name: SYSTEM_ACTOR_NAME, email: SYSTEM_ACTOR_EMAIL, passwordHash: 'x', isActive: false } });
    await expect(bootstrapSystemActor(db, { createPasswordHash: hashFor('x') })).rejects.toThrow(/identity/i);
    expect(await actorRow()).toBeNull();
    await truncateAllTables(db);
    await db.user.create({ data: { id: SYSTEM_ACTOR_USER_ID, name: 'Impostor', email: 'impostor@test.local', passwordHash: 'x', isActive: false } });
    await expect(bootstrapSystemActor(db, { createPasswordHash: hashFor('x') })).rejects.toThrow(/identity/i);
    expect((await actorRow())!.email).toBe('impostor@test.local');
  });

  it('never outputs the generated plaintext and stores only a matching bcrypt hash', async () => {
    const plaintext = 'SENTINEL-PLAINTEXT-7f3c9a1e5b2d4c6f8a0b';
    const logged: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
    const deps: BootstrapSystemActorCliDeps = {
      openSeedDatabase: (async () => ({ prisma: db, close: async () => undefined })) as unknown as BootstrapSystemActorCliDeps['openSeedDatabase'],
      generateSecret: () => plaintext,
    };
    await main(['--target=test', '--execute'], deps);
    expect(process.exitCode).not.toBe(1);
    const stored = await db.user.findUniqueOrThrow({ where: { id: SYSTEM_ACTOR_USER_ID }, select: { passwordHash: true, isActive: true } });
    expect(stored.isActive).toBe(false);
    expect(stored.passwordHash).not.toContain(plaintext);
    expect(await compare(plaintext, stored.passwordHash)).toBe(true);
    const output = logged.join('\n');
    expect(output).toContain('[db:bootstrap-system-actor] OK');
    expect(output).not.toContain(plaintext);
    expect(output).not.toContain(stored.passwordHash);
  }, 120000);

  it('dry-run plans without writing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const generateSecret = vi.fn(() => 'unused');
    await main(['--target=test', '--dry-run'], {
      openSeedDatabase: (async () => ({ prisma: db, close: async () => undefined })) as unknown as BootstrapSystemActorCliDeps['openSeedDatabase'],
      generateSecret,
    });
    expect(generateSecret).not.toHaveBeenCalled();
    expect(await actorRow()).toBeNull();
    expect((await planSystemActorBootstrap(db))).toMatchObject({ state: 'ABSENT', readyForExecution: true });
  });

  it('rejects ambiguous CLI arguments before opening a database', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const openSeedDatabase = vi.fn();
    for (const argv of [[], ['--target=test'], ['--target=prod', '--execute'], ['--target=test', '--dry-run', '--execute'], ['--target=test', '--execute', 'extra']]) {
      process.exitCode = undefined;
      await main(argv, { openSeedDatabase: openSeedDatabase as unknown as BootstrapSystemActorCliDeps['openSeedDatabase'], generateSecret: () => 'x' });
      expect(process.exitCode).toBe(1);
    }
    expect(openSeedDatabase).not.toHaveBeenCalled();
  });

  it('cannot authenticate: login is refused for the inactive actor', async () => {
    const { createApp } = await import('../../src/app.js');
    const request = (await import('supertest')).default;
    const plaintext = 'another-sentinel-secret-value-000000';
    const { hashPassword } = await import('../../src/modules/auth/password.js');
    await bootstrapSystemActor(db, { createPasswordHash: () => hashPassword(plaintext) });
    const response = await request(createApp(db)).post('/api/v1/auth/login').send({ email: SYSTEM_ACTOR_EMAIL, password: plaintext });
    expect(response.status).not.toBe(200);
    expect(response.body).not.toHaveProperty('accessToken');
  });
});
