import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createCashRouter } from '../../src/modules/cash/cash.routes.js';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';

// CASH MOVEMENT REVERSAL (PILOT, migration 11): DB-free route contract for
// POST /cash/sessions/:sessionId/movements/:movementId/reversal. Everything
// below the stub Prisma client is real: buildAuthorizationContext,
// requirePermission(CASH_MOVEMENT_MANAGE), the strict params/body DTOs, the
// router, controller and cash.service reverseMovement.
//
// PRE-REGISTERED EXPECTATIONS (2026-10-18):
//   H01 no auth -> 401, no DB call
//   H02 SELLER (no CASH_MOVEMENT_MANAGE) -> 403 at the route gate, no DB call
//   H03 CASHIER passes the gate but is not a supervisor -> 403, nothing written
//   H04 OWNER -> 201 { movement, original, replayed:false }; BIGINT as strings
//   H05 a body naming amount / type / reversesMovementId / sessionId -> 400, no DB call
//   H06 malformed movementId or sessionId -> 400, no DB call
//   H07 the same key + payload again -> 201 replayed:true, no second write
//   H08 a different key on the reversed original -> 409 CASH_MOVEMENT_ALREADY_REVERSED

const A = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-0000000000c1';
const ORIGINAL = '00000000-0000-4000-8000-0000000000d1';
const REGISTER = { id: '00000000-0000-4000-8000-00000000aaaa', branchId: A, name: 'Caja A' };
const KEY = '11111111-1111-4111-8111-111111111111';

type RoleName = keyof typeof DEFAULT_ROLE_GRANTS | 'OWNER';
async function authFor(role: RoleName, at: string | 'COMPANY') {
  return buildAuthorizationContext(
    { location: { findMany: async () => [{ id: A }] } },
    {
      id: `user-${role}`,
      branchRoles: [],
      roleScopes: [{
        roleId: `role-${role}`,
        scopeKind: at === 'COMPANY' ? 'COMPANY' as const : 'LOCATION' as const,
        locationId: at === 'COMPANY' ? null : at,
        role: { code: role, permissions: (role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[role]]).map((code) => ({ permission: { code } })) },
      }],
    },
  );
}

type Row = Record<string, unknown> & { id: string; sessionId: string; type: string; amount: bigint };
let movements: Row[];
let audits: unknown[];
let dbCalls: number;

function fakeClient() {
  const touch = <T>(value: T) => { dbCalls += 1; return Promise.resolve(value); };
  const tx = {
    $queryRaw: (templates: string[], ...values: unknown[]) => touch(
      templates.join('?').includes('"CashSession"') && values[0] === SESSION
        ? [{ id: SESSION, registerId: REGISTER.id, startingCash: 100000n, status: 'OPEN' }] : [],
    ),
    cashRegister: { findUniqueOrThrow: () => touch(REGISTER) },
    cashMovement: {
      findUnique: ({ where }: { where: { sessionId_idempotencyKey?: { idempotencyKey: string }; reversesMovementId?: string } }) => touch(
        where.sessionId_idempotencyKey
          ? movements.find((m) => m.idempotencyKey === where.sessionId_idempotencyKey!.idempotencyKey) ?? null
          : movements.find((m) => m.reversesMovementId === where.reversesMovementId) ?? null,
      ),
      findFirst: ({ where }: { where: { id: string; sessionId: string } }) => touch(movements.find((m) => m.id === where.id && m.sessionId === where.sessionId) ?? null),
      findMany: () => touch(movements.map((m) => ({ ...m }))),
      create: ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `00000000-0000-4000-8000-00000000000${movements.length}`, timestamp: new Date('2030-01-01T10:00:00.000Z'), reversesMovementId: null, ...data } as unknown as Row;
        movements.push(row);
        return touch(row);
      },
    },
    auditLog: { create: ({ data }: { data: unknown }) => { audits.push(data); return touch(data); } },
  };
  return { ...tx, $transaction: (operation: (t: unknown) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient;
}

function post(auth: Express.AuthContext | undefined, body: Record<string, unknown>, sessionId = SESSION, movementId = ORIGINAL) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { if (auth) req.auth = auth; next(); });
  app.use('/cash', createCashRouter(fakeClient()));
  app.use(errorHandler);
  return request(app).post(`/cash/sessions/${sessionId}/movements/${movementId}/reversal`).send(body);
}

beforeEach(() => {
  dbCalls = 0;
  audits = [];
  movements = [
    { id: '00000000-0000-4000-8000-0000000000e0', sessionId: SESSION, type: 'OPENING', amount: 100000n, salePaymentId: null, userId: 'u', reason: null, idempotencyKey: null, reversesMovementId: null, timestamp: new Date() },
    { id: ORIGINAL, sessionId: SESSION, type: 'EXPENSE', amount: 4000n, salePaymentId: null, userId: 'u', reason: 'Gasto', idempotencyKey: '22222222-2222-4222-8222-222222222222', reversesMovementId: null, timestamp: new Date() },
  ];
});

describe('POST /cash/sessions/:sessionId/movements/:movementId/reversal', () => {
  it('H01 no auth -> 401, no DB call', async () => {
    const res = await post(undefined, { reason: 'x', idempotencyKey: KEY });
    expect(res.status).toBe(401);
    expect(dbCalls).toBe(0);
  });

  it('H02 SELLER -> 403 at the route gate, no DB call', async () => {
    const res = await post(await authFor('SELLER', A), { reason: 'x', idempotencyKey: KEY });
    expect(res.status).toBe(403);
    expect(dbCalls).toBe(0);
  });

  it('H03 CASHIER passes the gate but is not a supervisor -> 403, nothing written', async () => {
    const res = await post(await authFor('CASHIER', A), { reason: 'x', idempotencyKey: KEY });
    expect(res.status).toBe(403);
    expect(movements).toHaveLength(2);
    expect(audits).toHaveLength(0);
  });

  it('H04 OWNER -> 201 { movement, original, replayed:false } with BIGINT serialized as strings', async () => {
    const res = await post(await authFor('OWNER', 'COMPANY'), { reason: '  Duplicado ', idempotencyKey: KEY });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      replayed: false,
      movement: { type: 'EXPENSE_REVERSAL', amount: '4000', reason: 'Duplicado', idempotencyKey: KEY, reversesMovementId: ORIGINAL, sessionId: SESSION, salePaymentId: null },
      original: { id: ORIGINAL, type: 'EXPENSE', amount: '4000', reversesMovementId: null },
    });
    expect(audits).toHaveLength(1);
  });

  it('H05 a body naming amount / type / reversesMovementId / sessionId -> 400, no DB call', async () => {
    const owner = await authFor('OWNER', 'COMPANY');
    for (const extra of [{ amount: '1' }, { type: 'EXPENSE_REVERSAL' }, { reversesMovementId: ORIGINAL }, { sessionId: SESSION }]) {
      const res = await post(owner, { reason: 'x', idempotencyKey: KEY, ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect((await post(owner, { reason: '   ', idempotencyKey: KEY })).status).toBe(400);
    expect((await post(owner, { reason: 'x', idempotencyKey: 'nope' })).status).toBe(400);
    expect(dbCalls).toBe(0);
  });

  it('H06 malformed movementId or sessionId -> 400, no DB call', async () => {
    const owner = await authFor('OWNER', 'COMPANY');
    expect((await post(owner, { reason: 'x', idempotencyKey: KEY }, SESSION, 'not-a-uuid')).status).toBe(400);
    expect((await post(owner, { reason: 'x', idempotencyKey: KEY }, 'not-a-uuid', ORIGINAL)).status).toBe(400);
    expect(dbCalls).toBe(0);
  });

  it('H07 the same key + payload again -> 201 replayed:true, no second write', async () => {
    const owner = await authFor('OWNER', 'COMPANY');
    const first = await post(owner, { reason: 'Duplicado', idempotencyKey: KEY });
    const second = await post(owner, { reason: 'Duplicado', idempotencyKey: KEY });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ replayed: true, movement: { id: first.body.movement.id } });
    expect(movements).toHaveLength(3);
    expect(audits).toHaveLength(1);
  });

  it('H08 a different key on the reversed original -> 409 CASH_MOVEMENT_ALREADY_REVERSED', async () => {
    const owner = await authFor('OWNER', 'COMPANY');
    await post(owner, { reason: 'Duplicado', idempotencyKey: KEY });
    const res = await post(owner, { reason: 'Duplicado', idempotencyKey: '33333333-3333-4333-8333-333333333333' });
    expect(res.status).toBe(409);
    expect(res.body.error?.code ?? res.body.code).toBe('CASH_MOVEMENT_ALREADY_REVERSED');
  });
});
