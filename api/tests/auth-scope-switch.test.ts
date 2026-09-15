import express from 'express';
import request from 'supertest';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { env } from '../src/config/env.js';
import { createRequireAuth } from '../src/middleware/auth.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { sendJson } from '../src/shared/json-safe.js';

const key = new TextEncoder().encode(env.JWT_SECRET);
const now = Math.floor(Date.now() / 1000);

function buildApp(database: PrismaClient) {
  const app = express();
  app.get('/private', createRequireAuth(database), (req, res) => {
    sendJson(res, { effectiveLocationIds: req.auth?.effectiveLocationIds, roles: req.auth?.roles });
  });
  app.use(errorHandler);
  return app;
}

async function token() {
  return new SignJWT()
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('test-user')
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(key);
}

type StubRoleScope = {
  roleId: string;
  role: { code: string; permissions: Array<{ permission: { code: string } }> };
  scopeKind: 'LOCATION' | 'COMPANY';
  locationId: string | null;
};

function stubUser(branchIds: string[], roleScopes: StubRoleScope[] = []) {
  return {
    id: 'test-user',
    isActive: true,
    branchRoles: branchIds.map((branchId) => ({
      branchId,
      role: { code: 'SELLER', permissions: [] },
    })),
    roleScopes,
  };
}

// Proves the real per-request path (middleware/auth.ts, which is what
// authorization.ts's assertBranchAccess/requirePermission actually enforce
// against) switches branchIds to UserRoleScope, not just auth.service.ts's
// /login and /me response bodies. Uses a stub database (same style as the
// existing api/tests/auth.test.ts) so this is fast and does not need a real
// Postgres connection. UserRoleScope rows are stubbed as part of the single
// `user.findUnique` result (its `roleScopes` selection) rather than a
// separate `userRoleScope.findMany` call — middleware/auth.ts loads both in
// one query and never queries UserRoleScope on its own (see
// effective-branch-ids.ts).
describe('middleware/auth.ts branchIds resolution (Phase 1C SWITCH)', () => {
  it('prefers UserRoleScope over legacy UserBranchRole when it has been backfilled for this user', async () => {
    const testDatabase = {
      user: {
        findUnique: async () =>
          stubUser(['legacy-branch'], [
            { roleId: 'r1', role: { code: 'SELLER', permissions: [{ permission: { code: 'CASH_SESSION_OPEN' } }] }, scopeKind: 'LOCATION', locationId: 'switched-location' },
          ]),
      },
    } as unknown as PrismaClient;
    const response = await request(buildApp(testDatabase))
      .get('/private')
      .auth(await token(), { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body.effectiveLocationIds).toEqual(['switched-location']);
  });

  it('returns empty branchIds when UserRoleScope is empty, even though legacy UserBranchRole still grants a branch (no per-user legacy fallback post-SWITCH)', async () => {
    // An earlier version of this policy treated "zero UserRoleScope rows for
    // this user" as "not yet migrated" and fell back to the legacy
    // UserBranchRole-derived set — but that's ambiguous: it cannot tell
    // "never migrated" apart from "administrator explicitly revoked every
    // scope for this user", and the latter must not silently resurrect the
    // user's old legacy branches. UserRoleScope is authoritative even when
    // empty; UserBranchRole stays only as the legacy role/permission source
    // (see stubUser's roles/permissions untouched below).
    const testDatabase = {
      user: { findUnique: async () => stubUser(['legacy-branch']) },
    } as unknown as PrismaClient;
    const response = await request(buildApp(testDatabase))
      .get('/private')
      .auth(await token(), { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body.effectiveLocationIds).toEqual([]);
    expect(response.body.roles).toEqual(['SELLER']);
  });

  it('fails closed (500) on an unexpected COMPANY-scoped row instead of guessing', async () => {
    const testDatabase = {
      user: {
        findUnique: async () =>
          stubUser(['legacy-branch'], [
            { roleId: 'r1', role: { code: 'ADMIN', permissions: [] }, scopeKind: 'COMPANY', locationId: null },
          ]),
      },
    } as unknown as PrismaClient;
    const response = await request(buildApp(testDatabase))
      .get('/private')
      .auth(await token(), { type: 'bearer' });
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('UNSUPPORTED_SCOPE');
  });
});
