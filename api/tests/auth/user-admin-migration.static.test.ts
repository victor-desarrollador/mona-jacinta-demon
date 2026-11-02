// USER-MGMT-01 U2 (G22) — DB-free static contract of 20261101130000_user_admin_lifecycle, of the UserAdminOperation model and of the
// lower(email) uniqueness. The behaviour on real PostgreSQL (the case-insensitive backstop, the idempotency race, atomicity) is proven by
// user-admin-lifecycle.pg.test.ts.
//
// G22 carries EXACTLY what U2 needs: the case-insensitive email index (guarded by an abort on existing collisions) and the
// UserAdminOperation table. It anticipates NOTHING of U3 (RBAC / last OWNER), U4 (realtime) or U5 (UI), and it never stores a secret.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const NAME = '20261101130000_user_admin_lifecycle';
const migrationsDir = new URL('../../prisma/migrations/', import.meta.url);
const migrationFile = new URL(`../../prisma/migrations/${NAME}/migration.sql`, import.meta.url);
const sql = existsSync(migrationFile) ? readFileSync(migrationFile, 'utf8') : '';
const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const at = (needle: string) => code.indexOf(needle);
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const model = /^model UserAdminOperation \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
const modelFields = model.split('\n').map((line) => /^\s{2}([a-zA-Z]+)\s+(String|DateTime|Boolean|Int|BigInt)\b/.exec(line)?.[1]).filter((f): f is string => f !== undefined);
const tableBody = /CREATE TABLE "UserAdminOperation" \(([\s\S]*?)\n\);/.exec(code)?.[1] ?? '';

describe('G22 user_admin_lifecycle — migration content (UA01..UA09)', () => {
  it('UA01 exists, follows G21 and is the LAST migration of the tree; G21 stays untouched', () => {
    expect(existsSync(migrationFile)).toBe(true);
    const names = readdirSync(migrationsDir).filter((entry) => /^\d{14}_/.test(entry)).sort();
    expect(names.at(-1)).toBe(NAME);
    expect(names.at(-2)).toBe('20261101120000_user_credentials_epoch');
  });

  it('UA02 the collision check ABORTS the migration before anything is created, and resolves nothing automatically', () => {
    expect(code).toMatch(/DO \$\$[\s\S]*GROUP BY lower\("email"\) HAVING count\(\*\) > 1[\s\S]*RAISE EXCEPTION[\s\S]*\$\$;/);
    expect(code).toMatch(/USING ERRCODE = 'check_violation'/);
    expect(at('GROUP BY lower("email")')).toBeLessThan(at('CREATE UNIQUE INDEX "User_email_lower_key"'));
    expect(at('GROUP BY lower("email")')).toBeLessThan(at('CREATE TABLE "UserAdminOperation"'));
    expect(code.replace(/ON (DELETE|UPDATE) (RESTRICT|CASCADE)/g, '')).not.toMatch(/\b(UPDATE|DELETE|INSERT)\b/i); // no automatic repair of a colliding email, no data written
  });

  it('UA03 the email backstop is exactly a UNIQUE index on lower("email") (the case-sensitive User_email_key stays)', () => {
    expect(code).toMatch(/CREATE UNIQUE INDEX "User_email_lower_key"\s+ON "User" \(lower\("email"\)\);/);
    expect(code).not.toMatch(/DROP INDEX/i);
  });

  it('UA04 UserAdminOperation has exactly the seven reviewed columns', () => {
    const columns = [...tableBody.matchAll(/^\s*"([A-Za-z]+)" /gm)].map((m) => m[1]);
    expect(columns).toEqual(['id', 'actorId', 'targetUserId', 'operation', 'idempotencyKey', 'requestHash', 'createdAt']);
    expect(tableBody).toMatch(/"createdAt" TIMESTAMPTZ\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  });

  it('UA05 constraints: the four operations, a sha256 lowercase-hex request hash, a UUID v4 idempotency key, PK, unique (actorId, idempotencyKey), index (targetUserId, createdAt)', () => {
    expect(code).toMatch(/CHECK \("operation" IN \('CREATE_USER', 'RESET_PASSWORD', 'DEACTIVATE_USER', 'REACTIVATE_USER'\)\)/);
    expect(code).toMatch(/CHECK \("requestHash" ~ '\^\[0-9a-f\]\{64\}\$'\)/);
    expect(code).toMatch(/CHECK \("idempotencyKey" ~ '\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-4\[0-9a-f\]\{3\}-\[89ab\]\[0-9a-f\]\{3\}-\[0-9a-f\]\{12\}\$'\)/);
    expect(code).toMatch(/CONSTRAINT "UserAdminOperation_pkey" PRIMARY KEY \("id"\)/);
    expect(code).toMatch(/CREATE UNIQUE INDEX "UserAdminOperation_actorId_idempotencyKey_key" ON "UserAdminOperation"\("actorId", "idempotencyKey"\);/);
    expect(code).toMatch(/CREATE INDEX "UserAdminOperation_targetUserId_createdAt_idx" ON "UserAdminOperation"\("targetUserId", "createdAt"\);/);
  });

  it('UA06 both foreign keys point at User with ON DELETE RESTRICT (history is never deleted with a user)', () => {
    expect(code).toMatch(/"UserAdminOperation_actorId_fkey"\s+FOREIGN KEY \("actorId"\) REFERENCES "User"\("id"\) ON DELETE RESTRICT/);
    expect(code).toMatch(/"UserAdminOperation_targetUserId_fkey"\s+FOREIGN KEY \("targetUserId"\) REFERENCES "User"\("id"\) ON DELETE RESTRICT/);
  });

  it('UA07 it never stores a secret: no password / hash / token / secret column anywhere in the table', () => {
    const columns = [...tableBody.matchAll(/^\s*"([A-Za-z]+)" /gm)].map((m) => m[1]!);
    expect(columns.filter((c) => /password|token|secret|credential|hash/i.test(c))).toEqual(['requestHash']); // the only hash is the request hash
  });

  it('UA08 it is additive and anticipates NOTHING of U3 / U4 / U5: no function, trigger, enum, RBAC table, realtime or User column change', () => {
    expect(code).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|TRIGGER|TYPE|VIEW)|ALTER TYPE|ALTER TABLE "User"|\bDROP\b|TRUNCATE/i);
    expect(code).not.toMatch(/"Role"|"RolePermission"|"Permission"|"UserRoleScope"|"UserBranchRole"|"AuditLog"/);
    expect(code.match(/^\s*CREATE TABLE\b/gm)).toHaveLength(1);
    expect(code.match(/ALTER TABLE/g)).toHaveLength(2); // the two foreign keys, nothing else
  });

  it('UA09 its bytes are pinned once reviewed (a change is a new migration)', () => {
    expect(createHash('sha256').update(sql).digest('hex')).toBe('a418a7dbd845d6e97866915d090a98ed1bc67ed19b87720ef70400c67f23f28f')
    expect(Buffer.byteLength(sql, 'utf8')).toBe(2644);
  });
});

describe('G22 — schema.prisma (UA10..UA11)', () => {
  it('UA10 model UserAdminOperation has exactly the reviewed fields, both relations RESTRICT, the unique and the index', () => {
    expect(modelFields).toEqual(['id', 'actorId', 'targetUserId', 'operation', 'idempotencyKey', 'requestHash', 'createdAt']);
    expect(model).toMatch(/@@unique\(\[actorId, idempotencyKey\]\)/);
    expect(model).toMatch(/@@index\(\[targetUserId, createdAt\]\)/);
    expect(model.match(/onDelete: Restrict/g)).toHaveLength(2);
    expect(model).not.toMatch(/password|token|secret/i);
  });

  it('UA11 User gains only the two relation fields (no scalar), and G21 stays the scalar contract of User', () => {
    const user = /^model User \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
    const scalars = user.split('\n').map((l) => /^\s{2}([a-zA-Z]+)\s+(String|Boolean|DateTime|Int|BigInt)\??\b/.exec(l)?.[1]).filter((f): f is string => f !== undefined);
    expect([...scalars].sort()).toEqual(['createdAt', 'credentialsChangedAt', 'email', 'id', 'isActive', 'mustChangePassword', 'name', 'passwordHash', 'updatedAt']);
    expect(user).toMatch(/UserAdminOperation\[\]\s+@relation\("UserAdminOperationActor"\)/);
    expect(user).toMatch(/UserAdminOperation\[\]\s+@relation\("UserAdminOperationTarget"\)/);
  });
});
