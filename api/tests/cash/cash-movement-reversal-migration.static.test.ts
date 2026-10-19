// CASH MOVEMENT REVERSAL (PILOT, migration 11): static, DB-free contract of the
// additive migration and its schema.prisma mirror. The PostgreSQL behaviour of
// every object pinned here is proven by the LOCAL_TEST suite
// (cash-movement.pg.test.ts); this file only pins the reviewed text.
//
// PRE-REGISTERED EXPECTATIONS (OWNER R1/R5, 2026-10-18):
//   M11-01 migration 11 is the last of exactly eleven; migrations 1–10 keep their reviewed bytes
//   M11-02 two enum labels, one nullable TEXT column, nothing destructive
//   M11-03 one reversal per original: UNIQUE(reversesMovementId)
//   M11-04 same session in the database: UNIQUE(id, sessionId) + composite FK
//          (reversesMovementId, sessionId) -> CashMovement(id, sessionId), RESTRICT both ways
//   M11-05 fail-closed CHECKs on the text of "type" (migration 10 pattern), NOT VALID + VALIDATE
//   M11-06 schema.prisma mirrors the enum, the column, both unique keys and the composite relation
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATIONS = path.join(API, 'prisma', 'migrations');
const M11 = '20261018180000_cash_movement_reversals';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const names = () => readdirSync(MIGRATIONS).filter((d) => /^\d{14}_/.test(d)).sort();
const m11Path = path.join(MIGRATIONS, M11, 'migration.sql');
const sql = existsSync(m11Path) ? readFileSync(m11Path, 'utf8') : '';
// Comments removed, whitespace squashed: the executable text only.
const code = sql.split('\n').map((line) => line.replace(/--.*$/, '')).join(' ').replace(/\s+/g, ' ').trim();
const schema = readFileSync(path.join(API, 'prisma', 'schema.prisma'), 'utf8');

// Reviewed bytes of migrations 8–10 (the seven earlier ones are pinned by pilot-migrate.mjs).
const REVIEWED = [
  ['20261016120000_r3_proportional_checkout', '217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6'],
  ['20261016130000_r3_checkout_attempts', '076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148'],
  ['20261018120000_cash_movement_withdrawals_expenses', 'e37149442d1fb82ec87877e7b3e1f2e4311b36a9d47d314a3fd1843702c5adf9'],
] as const;

describe('migration 11 — cash movement reversals (static)', () => {
  it('M11-01 is the last of exactly eleven migrations; migrations 8–10 keep their reviewed bytes', () => {
    expect(names()).toHaveLength(11);
    expect(names().at(-1)).toBe(M11);
    for (const [name, digest] of REVIEWED) {
      expect(sha256(readFileSync(path.join(MIGRATIONS, name, 'migration.sql'))), name).toBe(digest);
    }
  });

  it('M11-02 adds exactly two enum labels and one nullable TEXT column; nothing destructive', () => {
    expect(code).toContain(`ALTER TYPE "CashMovementType" ADD VALUE 'WITHDRAWAL_REVERSAL';`);
    expect(code).toContain(`ALTER TYPE "CashMovementType" ADD VALUE 'EXPENSE_REVERSAL';`);
    expect(code.match(/ADD VALUE/g)).toHaveLength(2);
    expect(code).toContain('ALTER TABLE "CashMovement" ADD COLUMN "reversesMovementId" TEXT;');
    expect(code.match(/ADD COLUMN/g)).toHaveLength(1);
    expect(code).not.toMatch(/\b(DROP|DELETE FROM|TRUNCATE|RENAME|CASCADE|SET NULL|SET DEFAULT)\b|\bUPDATE "[^"]+" SET\b|SET NOT NULL/i);
    expect(code).not.toMatch(/CREATE (OR REPLACE )?(FUNCTION|TRIGGER)/i);
  });

  it('M11-03 one reversal per original: a UNIQUE index on reversesMovementId', () => {
    expect(code).toContain('CREATE UNIQUE INDEX "CashMovement_reversesMovementId_key" ON "CashMovement"("reversesMovementId");');
  });

  it('M11-04 same session in the database: UNIQUE(id, sessionId) + composite FK, RESTRICT on delete and update', () => {
    expect(code).toContain('CREATE UNIQUE INDEX "CashMovement_id_sessionId_key" ON "CashMovement"("id", "sessionId");');
    expect(code).toContain(
      'ALTER TABLE "CashMovement" ADD CONSTRAINT "CashMovement_reversesMovementId_sessionId_fkey" '
      + 'FOREIGN KEY ("reversesMovementId", "sessionId") REFERENCES "CashMovement"("id", "sessionId") '
      + 'ON DELETE RESTRICT ON UPDATE RESTRICT;',
    );
    // MATCH SIMPLE (the default) is what exempts every historical row (NULL link); MATCH FULL would refuse nothing extra and is not used.
    expect(code).not.toMatch(/MATCH (FULL|PARTIAL)/i);
  });

  it('M11-05 fail-closed CHECKs compare the text of "type" only, NOT VALID then VALIDATE', () => {
    const reversal = `"type"::text IN ('WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL')`;
    expect(code).toContain(`ADD CONSTRAINT "chk_cash_movement_reversal_link" CHECK ((${reversal}) = ("reversesMovementId" IS NOT NULL)) NOT VALID;`);
    expect(code).toContain(
      `ADD CONSTRAINT "chk_cash_movement_reversal_shape" CHECK ("type"::text NOT IN ('WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL') `
      + `OR ("amount" > 0 AND "reason" IS NOT NULL AND btrim("reason") <> '' AND "salePaymentId" IS NULL AND "idempotencyKey" IS NOT NULL)) NOT VALID;`,
    );
    expect(code).toContain(`ADD CONSTRAINT "chk_cash_movement_reversal_not_self" CHECK ("reversesMovementId" IS NULL OR "reversesMovementId" <> "id") NOT VALID;`);
    for (const name of ['chk_cash_movement_reversal_link', 'chk_cash_movement_reversal_shape', 'chk_cash_movement_reversal_not_self']) {
      expect(code).toContain(`ALTER TABLE "CashMovement" VALIDATE CONSTRAINT "${name}";`);
    }
    // A label added by ADD VALUE is never used as an enum constant in the same migration.
    expect(code).not.toMatch(/'(WITHDRAWAL|EXPENSE)_REVERSAL'::"CashMovementType"/);
  });

  it('M11-06 schema.prisma mirrors the enum, the column, both unique keys and the composite relation', () => {
    const enumBody = schema.match(/enum CashMovementType \{([^}]*)\}/)?.[1] ?? '';
    expect(enumBody.split(/\s+/).filter(Boolean)).toEqual(['OPENING', 'SALE_INCOME', 'CLOSING', 'MANUAL', 'WITHDRAWAL', 'EXPENSE', 'WITHDRAWAL_REVERSAL', 'EXPENSE_REVERSAL']);
    const model = (schema.match(/model CashMovement \{([\s\S]*?)\n\}/)?.[1] ?? '').replace(/\s+/g, ' ');
    expect(model).toMatch(/reversesMovementId String\? @unique/);
    expect(model).toMatch(/reverses CashMovement\? @relation\("CashMovementReversal", fields: \[reversesMovementId, sessionId\], references: \[id, sessionId\], onDelete: Restrict, onUpdate: Restrict\)/);
    // One-to-many in Prisma (a one-to-one needs a redundant composite unique); UNIQUE(reversesMovementId) keeps one reversal per original.
    expect(model).toMatch(/reversals CashMovement\[\] @relation\("CashMovementReversal"\)/);
    expect(model).toContain('@@unique([id, sessionId])');
  });
});
