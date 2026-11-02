// USER-MGMT-01 U1 (G21) — DB-free static contract of 20261101120000_user_credentials_epoch and of the two User columns it adds.
// The behaviour on real PostgreSQL (defaults on existing rows, the G20 -> G21 transition) is proven by user-credentials-epoch.pg.test.ts.
//
// G21 carries EXACTLY the two columns U1 needs and nothing else. U2 (UserAdminOperation, the lower(email) index) is a LATER migration
// (G22) and must never be anticipated here: the guards below fail if any of it leaks into G21.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const NAME = '20261101120000_user_credentials_epoch';
const migrationsDir = new URL('../../prisma/migrations/', import.meta.url);
const migrationFile = new URL(`../../prisma/migrations/${NAME}/migration.sql`, import.meta.url);
const sql = existsSync(migrationFile) ? readFileSync(migrationFile, 'utf8') : '';
const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const statements = code.split(';').map((statement) => statement.trim()).filter((statement) => statement.length > 0);
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const userModel = /^model User \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
const scalarUserFields = userModel
  .split('\n')
  .map((line) => /^\s{2}([a-zA-Z]+)\s+(String|Boolean|DateTime|Int|BigInt)\??\b/.exec(line)?.[1])
  .filter((field): field is string => field !== undefined);

describe('G21 user_credentials_epoch — migration content (UC01..UC05)', () => {
  it('UC01 exists, follows the G20 post-sale guard and is followed only by G22 (U2)', () => {
    expect(existsSync(migrationFile)).toBe(true);
    const names = readdirSync(migrationsDir).filter((entry) => /^\d{14}_/.test(entry)).sort();
    expect(names.at(-2)).toBe(NAME);
    expect(names.at(-3)).toBe('20261026150000_sale_post_sale_guard');
    expect(names.at(-1)).toBe('20261101130000_user_admin_lifecycle');
  });

  it('UC01b its bytes are pinned: once reviewed, G21 is never edited (a change is a new migration)', () => {
    expect(Buffer.byteLength(sql, 'utf8')).toBe(881);
    expect(createHash('sha256').update(sql).digest('hex')).toBe('4f8e10245e858e062de7f377771a670f2dedb3f68b1bf56ebbf80c55b958138f');
  });

  it('UC02 is exactly two additive ALTER TABLE ... ADD COLUMN statements on "User", in this order', () => {
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false$/);
    expect(statements[1]).toMatch(/^ALTER TABLE "User" ADD COLUMN "credentialsChangedAt" TIMESTAMPTZ\(3\)$/);
  });

  it('UC03 the credentials epoch is NULLABLE with NO default: an existing user has never changed credentials', () => {
    expect(statements[1]).not.toMatch(/NOT NULL/);
    expect(statements[1]).not.toMatch(/DEFAULT/);
  });

  it('UC04 existing rows get their semantics from the column defaults alone: no UPDATE, no data change, nothing destructive', () => {
    expect(code).not.toMatch(/\b(UPDATE|DELETE|INSERT|DROP|TRUNCATE|RENAME|ALTER TYPE|CREATE OR REPLACE)\b/i);
    expect(code).not.toMatch(/\bALTER COLUMN\b/i);
  });

  it('UC05 U2 is NOT anticipated: no table, index, trigger or function, no lower(email) uniqueness, no UserAdminOperation', () => {
    expect(code).not.toMatch(/\bCREATE\b/i);
    expect(code).not.toMatch(/lower\s*\(/i);
    expect(code).not.toMatch(/\bemail\b/i);
    expect(sql).not.toMatch(/UserAdminOperation/);
    // U2 lives in G22 and ONLY there: no migration other than G22 may mention the operation table or the lower(email) index.
    const mentions = readdirSync(migrationsDir)
      .filter((entry) => /^\d{14}_/.test(entry))
      .filter((entry) => /UserAdminOperation|User_email_lower_key/.test(readFileSync(new URL(`../../prisma/migrations/${entry}/migration.sql`, import.meta.url), 'utf8')));
    expect(mentions).toEqual(['20261101130000_user_admin_lifecycle']);
  });
});

describe('G21 user_credentials_epoch — schema.prisma User (UC06..UC08)', () => {
  it('UC06 mustChangePassword is a required Boolean defaulting to false', () => {
    expect(userModel).toMatch(/^\s{2}mustChangePassword\s+Boolean\s+@default\(false\)\s*$/m);
  });

  it('UC07 credentialsChangedAt is an optional DateTime stored as TIMESTAMPTZ(3), with no default', () => {
    expect(userModel).toMatch(/^\s{2}credentialsChangedAt\s+DateTime\?\s+@db\.Timestamptz\(3\)\s*$/m);
  });

  it('UC08 the scalar fields of User are exactly the existing seven plus these two — nothing else from USER-MGMT', () => {
    expect([...scalarUserFields].sort()).toEqual(
      ['createdAt', 'credentialsChangedAt', 'email', 'id', 'isActive', 'mustChangePassword', 'name', 'passwordHash', 'updatedAt'].sort(),
    );
  });
});
