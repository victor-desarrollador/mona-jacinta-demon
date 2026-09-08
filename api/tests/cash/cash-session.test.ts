import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch, createRole, createTestUser } from '../helpers/factories.js';
import { getAuthToken } from '../helpers/auth.js';

describe('cash sessions', () => {
  let db: PrismaClient;
  let app: ReturnType<typeof createApp>;
  let branchId: string, otherBranchId: string, registerId: string, userId: string, roleId: string, token: string;
  const exact = '9007199254740993';
  beforeAll(async () => { db = await createTestPrismaClient(); app = createApp(db); });
  beforeEach(async () => {
    await truncateAllTables(db);
    branchId = (await createBranch(db)).id;
    otherBranchId = (await createBranch(db)).id;
    roleId = (await createRole(db, 'CASHIER')).id;
    await db.permission.createMany({ data: [{ code: 'cash.session.open' }, { code: 'cash.session.close' }] });
    for (const permission of await db.permission.findMany()) await db.rolePermission.create({ data: { roleId, permissionId: permission.id } });
    userId = (await createTestUser(db, roleId, branchId)).id;
    token = await getAuthToken({ id: userId });
    registerId = (await db.cashRegister.create({ data: { branchId, name: 'Caja principal' } })).id;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$disconnect(); });
  const open = (body: object = { registerId, startingCash: exact }) => request(app).post('/api/v1/cash/sessions/open').set('Authorization', `Bearer ${token}`).send(body);
  const close = (id: string, body: object = { closingCash: exact }) => request(app).post(`/api/v1/cash/sessions/${id}/close`).set('Authorization', `Bearer ${token}`).send(body);
  const read = (route: string, query: object = { branchId }) => request(app).get(`/api/v1/cash/${route}`).set('Authorization', `Bearer ${token}`).query(query);
  async function revoke(code: string) {
    const permission = await db.permission.findUniqueOrThrow({ where: { code } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId, permissionId: permission.id } } });
  }
  it('requires authentication on all routes', async () => {
    for (const route of ['register', 'current']) expect((await request(app).get(`/api/v1/cash/${route}`)).status).toBe(401);
    for (const route of ['open', `${randomUUID()}/close`]) expect((await request(app).post(`/api/v1/cash/sessions/${route}`)).status).toBe(401);
  });
  it.each(['CASHIER', 'MANAGER', 'ADMIN'])('uses fresh permissions without %s bypass', async (code) => {
    await db.role.update({ where: { id: roleId }, data: { code } });
    const session = await open(); expect(session.status).toBe(201);
    await revoke('cash.session.open'); expect((await open()).status).toBe(403);
    await revoke('cash.session.close'); expect((await close(session.body.sessionId)).status).toBe(403);
  });
  it('allows explicit permissions independently of role names', async () => {
    await db.role.update({ where: { id: roleId }, data: { code: 'CUSTOM' } });
    const session = await open(); expect(session.status).toBe(201);
    expect((await close(session.body.sessionId)).status).toBe(200);
  });
  it('discovers assigned register and null current without writes or cash permissions', async () => {
    await revoke('cash.session.open'); await revoke('cash.session.close');
    expect((await read('register')).body).toEqual({ id: registerId, branchId, name: 'Caja principal' });
    expect((await read('current')).body).toBeNull();
    for (const route of ['register', 'current']) expect((await read(route, { branchId: otherBranchId })).status).toBe(403);
    expect(await db.cashSession.count()).toBe(0); expect(await db.cashMovement.count()).toBe(0); expect(await db.auditLog.count()).toBe(0);
  });
  it.each(['register', 'current'])('requires valid branch UUID on %s', async (route) => {
    for (const query of [{}, { branchId: 'bad' }]) expect((await read(route, query)).status).toBe(400);
  });
  it('persists exact opening, actor, movement, audit and rejects second opening', async () => {
    const result = await open(); expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ registerId, branchId, openedById: userId, startingCash: exact, status: 'OPEN' });
    expect((await read('current')).body).toEqual(result.body);
    expect(await db.cashSession.count()).toBe(1);
    expect((await db.cashSession.findFirstOrThrow()).startingCash).toBe(BigInt(exact));
    expect(await db.cashMovement.findMany()).toMatchObject([{ sessionId: result.body.sessionId, type: 'OPENING', amount: BigInt(exact), userId, salePaymentId: null }]);
    expect(await db.auditLog.findMany()).toMatchObject([{ action: 'CASH_SESSION_OPENED', userId, branchId, entityId: result.body.sessionId, after: { startingCash: exact } }]);
    expect((await open()).status).toBe(409);
    expect(await db.cashMovement.count()).toBe(1); expect(await db.auditLog.count()).toBe(1);
  });
  it('closes exactly once with exact cash and audit, then permits reopening with zero', async () => {
    const session = await open();
    const result = await close(session.body.sessionId); expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ status: 'CLOSED', closedById: userId, closingCash: exact, closedAt: expect.any(String) });
    expect(await db.cashSession.findFirstOrThrow()).toMatchObject({ status: 'CLOSED', closedById: userId, closedAt: expect.any(Date) });
    expect(await db.cashMovement.findMany({ where: { type: 'CLOSING' } })).toMatchObject([{ amount: BigInt(exact), userId, salePaymentId: null }]);
    expect(await db.auditLog.findMany({ where: { action: 'CASH_SESSION_CLOSED' } })).toMatchObject([{ userId, branchId, entityId: session.body.sessionId, before: { status: 'OPEN' }, after: { closingCash: exact } }]);
    expect((await close(session.body.sessionId)).status).toBe(409);
    expect(await db.cashMovement.count({ where: { type: 'CLOSING' } })).toBe(1); expect(await db.auditLog.count()).toBe(2);
    expect((await read('current')).body).toBeNull();
    expect((await open({ registerId, startingCash: '0' })).status).toBe(201);
  });
  it.each(['open', 'close'])('serializes concurrent %s without duplicate side effects', async (operation) => {
    const id = operation === 'close' ? (await open()).body.sessionId : '';
    const responses = await Promise.all(operation === 'open' ? [open(), open()] : [close(id), close(id)]);
    expect(responses.map((r) => r.status).sort()).toEqual([operation === 'open' ? 201 : 200, 409]);
    expect(await db.cashSession.count()).toBe(1);
    expect(await db.cashSession.count({ where: { status: 'OPEN' } })).toBe(operation === 'open' ? 1 : 0);
    expect(await db.cashMovement.count({ where: { type: operation === 'open' ? 'OPENING' : 'CLOSING' } })).toBe(1);
    expect(await db.auditLog.count()).toBe(operation === 'open' ? 1 : 2);
  });
  it.each([undefined, '', '-1', '1.5', 1.5, 100, '1e3', '+1', ' 1', '9223372036854775808'])('rejects invalid money %s on both writes', async (value) => {
    expect((await open({ registerId, startingCash: value })).status).toBe(400);
    expect((await close(randomUUID(), { closingCash: value })).status).toBe(400);
    expect(await db.cashSession.count()).toBe(0); expect(await db.cashMovement.count()).toBe(0);
  });
  it('validates resource UUIDs and reports unknown resources', async () => {
    expect((await open({ registerId: 'bad', startingCash: '0' })).status).toBe(400);
    expect((await close('bad')).status).toBe(400);
    expect((await open({ registerId: randomUUID(), startingCash: '0' })).status).toBe(404);
    expect((await close(randomUUID())).status).toBe(404);
    await db.cashRegister.delete({ where: { id: registerId } });
    expect((await read('register')).status).toBe(404);
  });
  it('respects branch reassignment after JWT issuance on all routes', async () => {
    const session = await open();
    await db.userBranchRole.updateMany({ where: { userId }, data: { branchId: otherBranchId } });
    expect((await read('register')).status).toBe(403); expect((await read('current')).status).toBe(403);
    expect((await open()).status).toBe(403); expect((await close(session.body.sessionId)).status).toBe(403);
    expect((await db.cashSession.findFirstOrThrow()).status).toBe('OPEN'); expect(await db.cashMovement.count()).toBe(1);
  });
  it.each(['open', 'close'])('rolls back every %s write if audit fails', async (operation) => {
    const id = operation === 'close' ? (await open()).body.sessionId : '';
    const transaction = db.$transaction.bind(db);
    vi.spyOn(db, '$transaction').mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options: object) =>
      transaction(async (tx) => {
        vi.spyOn(tx.auditLog, 'create').mockRejectedValueOnce(new Error('Forced audit failure'));
        return callback(tx);
      }, options)) as typeof db.$transaction);
    expect((await (operation === 'open' ? open() : close(id))).status).toBe(500);
    expect(await db.cashSession.count()).toBe(operation === 'open' ? 0 : 1);
    expect(await db.cashMovement.count()).toBe(operation === 'open' ? 0 : 1);
    expect(await db.auditLog.count()).toBe(operation === 'open' ? 0 : 1);
    if (operation === 'close') expect(await db.cashSession.findFirstOrThrow()).toMatchObject({ status: 'OPEN', closedAt: null, closedById: null });
  });
});
