import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Prisma, PrismaClient } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch, createRole, createTestUser, ensureTestLocation } from '../helpers/factories.js';
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
    // Phase 1D.3.3 SWITCH: /sessions/open and /sessions/:sessionId/close now
    // gate on the Production uppercase codes (req.auth.assignments) — the
    // legacy lowercase codes are kept too, granted to the same role, so
    // existing legacy-permission-shaped assertions in this file (revoke by
    // exact Permission.code) still exercise a real row.
    await db.permission.createMany({ data: [
      { code: 'cash.session.open' }, { code: 'cash.session.close' },
      { code: 'CASH_SESSION_OPEN' }, { code: 'CASH_SESSION_CLOSE' },
    ] });
    for (const permission of await db.permission.findMany()) await db.rolePermission.create({ data: { roleId, permissionId: permission.id } });
    userId = (await createTestUser(db, roleId, branchId)).id;
    token = await getAuthToken({ id: userId });
    registerId = (await db.cashRegister.create({ data: { branchId, name: 'Caja principal' } })).id;
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$disconnect(); });
  const open = (body: object = { registerId, startingCash: exact }, accessToken = token) => request(app).post('/api/v1/cash/sessions/open').set('Authorization', `Bearer ${accessToken}`).send(body);
  const close = (id: string, body: object = { closingCash: exact }, accessToken = token) => request(app).post(`/api/v1/cash/sessions/${id}/close`).set('Authorization', `Bearer ${accessToken}`).send(body);
  const read = (route: string, query: object = { branchId }, accessToken = token) => request(app).get(`/api/v1/cash/${route}`).set('Authorization', `Bearer ${accessToken}`).query(query);
  async function revoke(code: string) {
    const permission = await db.permission.findUniqueOrThrow({ where: { code } });
    await db.rolePermission.delete({ where: { roleId_permissionId: { roleId, permissionId: permission.id } } });
  }
  it('requires authentication on all routes', async () => {
    for (const route of ['register', 'current']) expect((await request(app).get(`/api/v1/cash/${route}`)).status).toBe(401);
    for (const route of ['open', `${randomUUID()}/close`]) expect((await request(app).post(`/api/v1/cash/sessions/${route}`)).status).toBe(401);
  });
  it('uses fresh permissions without CASHIER bypass', async () => {
    // Phase 1D.3.3 SWITCH: revoke the Production uppercase grant, not the
    // legacy lowercase one, to prove the switched route's real decision.
    const session = await open(); expect(session.status).toBe(201);
    await revoke('CASH_SESSION_OPEN'); expect((await open()).status).toBe(403);
    await revoke('CASH_SESSION_CLOSE'); expect((await close(session.body.sessionId)).status).toBe(403);
  });
  // Correction: a LOCATION-only ADMIN assignment (renaming this file's
  // shared CASHIER-coded, LOCATION-scoped role to 'ADMIN') is not how ADMIN
  // is actually provisioned (AGENTS.md/role-permission-matrix.ts) — a
  // positive ADMIN Production proof must use the canonical ADMIN COMPANY
  // scope instead of inventing a LOCATION-only ADMIN.
  it('authorizes cash session open/close for a COMPANY-scoped ADMIN assignment', async () => {
    const adminRole = await createRole(db, 'ADMIN');
    const openPermission = await db.permission.findUniqueOrThrow({ where: { code: 'CASH_SESSION_OPEN' } });
    const closePermission = await db.permission.findUniqueOrThrow({ where: { code: 'CASH_SESSION_CLOSE' } });
    await db.rolePermission.createMany({ data: [
      { roleId: adminRole.id, permissionId: openPermission.id },
      { roleId: adminRole.id, permissionId: closePermission.id },
    ] });
    const admin = await db.user.create({ data: { name: 'company-admin', email: 'company-admin-cash@test.local', passwordHash: 'x' } });
    await db.userRoleScope.create({ data: { userId: admin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null } });
    const adminToken = await getAuthToken(admin);
    const session = await open(undefined, adminToken);
    expect(session.status).toBe(201);
    expect((await close(session.body.sessionId, undefined, adminToken)).status).toBe(200);
  });
  it('fails closed for a MANAGER-coded role even with the Production grant intact', async () => {
    // isProductionRoleCode (authorization-context.ts) fails a persisted
    // UserRoleScope's Role.code closed unless it is one of the 5 canonical
    // Production codes — MANAGER can never become a ProductionAssignment,
    // regardless of what RolePermission rows it holds.
    await db.role.update({ where: { id: roleId }, data: { code: 'MANAGER' } });
    expect((await open()).status).toBe(403);
  });
  it('allows explicit permissions independently of role names (among canonical roles)', async () => {
    // 'CUSTOM' is not a canonical Production role code and could never form
    // an assignment post-switch — WAREHOUSE is a real canonical role,
    // proving the point (only the granted permission decides, not which of
    // the 5 canonical names is used) in a way that still holds today.
    await db.role.update({ where: { id: roleId }, data: { code: 'WAREHOUSE' } });
    const session = await open(); expect(session.status).toBe(201);
    expect((await close(session.body.sessionId)).status).toBe(200);
  });
  // Phase 1D.3.3 §8: isolate the authority source explicitly. Fresh
  // canonical-role users (never an invented Role.code — isProductionRoleCode
  // fails closed on anything else) prove the grant alone decides.
  it('authorizes session open via the Production CASH_SESSION_OPEN grant alone', async () => {
    const warehouseRole = await createRole(db, 'WAREHOUSE');
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'CASH_SESSION_OPEN' } });
    await db.rolePermission.create({ data: { roleId: warehouseRole.id, permissionId: permission.id } });
    const user = await createTestUser(db, warehouseRole.id, branchId);
    const isolatedToken = await getAuthToken(user);
    expect((await open(undefined, isolatedToken)).status).toBe(201);
  });
  it('rejects a legacy-lowercase-only cash.session.open grant on session open, once switched', async () => {
    const warehouseRole = await createRole(db, 'WAREHOUSE');
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'cash.session.open' } });
    await db.rolePermission.create({ data: { roleId: warehouseRole.id, permissionId: permission.id } });
    const user = await createTestUser(db, warehouseRole.id, branchId);
    const isolatedToken = await getAuthToken(user);
    expect((await open(undefined, isolatedToken)).status).toBe(403);
  });
  it('authorizes session close via the Production CASH_SESSION_CLOSE grant alone', async () => {
    const session = await open();
    const warehouseRole = await createRole(db, 'WAREHOUSE');
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'CASH_SESSION_CLOSE' } });
    await db.rolePermission.create({ data: { roleId: warehouseRole.id, permissionId: permission.id } });
    const user = await createTestUser(db, warehouseRole.id, branchId);
    const isolatedToken = await getAuthToken(user);
    expect((await close(session.body.sessionId, undefined, isolatedToken)).status).toBe(200);
  });
  it('rejects a legacy-lowercase-only cash.session.close grant on session close, once switched', async () => {
    const session = await open();
    const warehouseRole = await createRole(db, 'WAREHOUSE');
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'cash.session.close' } });
    await db.rolePermission.create({ data: { roleId: warehouseRole.id, permissionId: permission.id } });
    const user = await createTestUser(db, warehouseRole.id, branchId);
    const isolatedToken = await getAuthToken(user);
    expect((await close(session.body.sessionId, undefined, isolatedToken)).status).toBe(403);
  });
  // Phase 1D.3.3 §7 cross-assignment security: a permission granted by one
  // assignment must never combine with a location granted by a different
  // assignment (authorization-policy.ts's hasPermissionAtLocation contract).
  it('SELLER @ A (no CASH_SESSION_OPEN) + WAREHOUSE @ B (CASH_SESSION_OPEN): opens at B, never at A', async () => {
    const sellerRole = await createRole(db, 'SELLER');
    const warehouseRole = await createRole(db, 'WAREHOUSE');
    const permission = await db.permission.findUniqueOrThrow({ where: { code: 'CASH_SESSION_OPEN' } });
    await db.rolePermission.create({ data: { roleId: warehouseRole.id, permissionId: permission.id } });
    await ensureTestLocation(db, otherBranchId);
    const multi = await db.user.create({ data: { name: 'multi-cash', email: 'multi-cash@test.local', passwordHash: 'x' } });
    await db.userRoleScope.createMany({
      data: [
        { userId: multi.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: branchId },
        { userId: multi.id, roleId: warehouseRole.id, scopeKind: 'LOCATION', locationId: otherBranchId },
      ],
    });
    const multiToken = await getAuthToken(multi);
    expect((await open(undefined, multiToken)).status).toBe(403);
    const otherRegister = await db.cashRegister.create({ data: { branchId: otherBranchId, name: 'Caja B' } });
    expect((await open({ registerId: otherRegister.id, startingCash: exact }, multiToken)).status).toBe(201);
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
    // Phase 1C SWITCH: req.auth.branchIds comes from UserRoleScope only —
    // UserBranchRole (role/permission authority) is deliberately left
    // untouched at the original branch, staying independently valid, to
    // prove LOCATION reassignment is a UserRoleScope-only event, not a
    // dual-authority one. otherBranchId is a plain ad hoc Branch with no
    // Location of its own yet (only the user's original branch got one, in
    // createTestUser), so ensure one exists before pointing UserRoleScope at it.
    await ensureTestLocation(db, otherBranchId);
    await db.userRoleScope.updateMany({ where: { userId }, data: { locationId: otherBranchId } });
    expect((await read('register')).status).toBe(403); expect((await read('current')).status).toBe(403);
    expect((await open()).status).toBe(403); expect((await close(session.body.sessionId)).status).toBe(403);
    expect((await db.cashSession.findFirstOrThrow()).status).toBe('OPEN'); expect(await db.cashMovement.count()).toBe(1);
  });
  it('grants cash access to a fresh UserRoleScope location despite a stale UserBranchRole', async () => {
    // Phase 1C SWITCH: UserRoleScope is the sole LOCATION authority.
    // UserBranchRole (role/permission authority) stays at the original
    // branch — only the scope moves to otherBranchId — so this proves the
    // legacy row can no longer veto access to a location UserRoleScope
    // has actually authorized.
    await ensureTestLocation(db, otherBranchId);
    await db.userRoleScope.updateMany({ where: { userId }, data: { locationId: otherBranchId } });
    const otherRegister = await db.cashRegister.create({ data: { branchId: otherBranchId, name: 'Caja Yerba Buena' } });
    expect((await read('register', { branchId: otherBranchId })).status).toBe(200);
    const session = await open({ registerId: otherRegister.id, startingCash: exact });
    expect(session.status).toBe(201);
    expect((await close(session.body.sessionId)).status).toBe(200);
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
