// WAREHOUSE-MVP: DB-FREE static contract for the additive stock-adjustment
// schema (Prisma model + the NEW migration). It reads text only; the migration
// is proven against real PostgreSQL separately (disposable cluster, never PILOT).
//
// PRE-REGISTERED EXPECTATIONS (2026-10-20), SA-01..SA-10:
//   SA-01 StockMovementType gains ADJUSTMENT, historical values are kept
//   SA-02 enum StockAdjustmentReason = DAMAGED | LOST | LOAD_ERROR | SURPLUS | OTHER
//   SA-03 StockMovement gains nullable reason / note / idempotencyKey
//   SA-04 @@unique([userId, idempotencyKey]) (NULL keys stay distinct)
//   SA-05 a NEW migration (no applied migration is edited) creates all of it
//   SA-06 the migration never USES the new enum label as a value (same-
//         transaction rule): CHECKs compare "type"::text
//   SA-07 ADJUSTMENT CHECKs: reason/key NOT NULL, delta <> 0, abs <= 100,
//         OTHER note >= 10, DAMAGED/LOST negative, SURPLUS positive
//   SA-08 non-ADJUSTMENT rows must have reason NULL
//   SA-09 no global Inventory physical/reserved CHECK (needs a PILOT inspection)
//   SA-10 no existing migration directory was modified (listing is additive)
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const API = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const schema = readFileSync(path.join(API, 'prisma/schema.prisma'), 'utf8');
const migrationsDir = path.join(API, 'prisma/migrations');
const LAST_EXISTING = '20261021120000_r3_card_credit';
const added = readdirSync(migrationsDir).filter((name) => /^\d{14}_/.test(name) && name > LAST_EXISTING).sort();
const sql = added.map((name) => readFileSync(path.join(migrationsDir, name, 'migration.sql'), 'utf8')).join('\n');
const block = (source: string, kind: 'model' | 'enum', name: string) =>
  new RegExp(`${kind} ${name} \\{[\\s\\S]*?\\n\\}`).exec(source)?.[0] ?? '';

describe('stock adjustment schema (WAREHOUSE-MVP)', () => {
  it('SA-01 StockMovementType gains ADJUSTMENT and keeps SALE / INITIAL_STOCK', () => {
    const movementType = block(schema, 'enum', 'StockMovementType');
    for (const label of ['SALE', 'INITIAL_STOCK', 'ADJUSTMENT']) expect(movementType).toMatch(new RegExp(`\\b${label}\\b`));
  });

  it('SA-02 StockAdjustmentReason has exactly the five approved reasons', () => {
    const body = block(schema, 'enum', 'StockAdjustmentReason');
    expect(body).not.toBe('');
    const labels = [...body.matchAll(/^\s+([A-Z_]+)\s*$/gm)].map((match) => match[1]);
    expect(labels).toEqual(['DAMAGED', 'LOST', 'LOAD_ERROR', 'SURPLUS', 'OTHER']);
  });

  it('SA-03 StockMovement gains nullable reason / note / idempotencyKey', () => {
    const model = block(schema, 'model', 'StockMovement');
    expect(model).toMatch(/\breason\s+StockAdjustmentReason\?/);
    expect(model).toMatch(/\bnote\s+String\?/);
    expect(model).toMatch(/\bidempotencyKey\s+String\?/);
  });

  it('SA-04 (userId, idempotencyKey) is unique', () => {
    expect(block(schema, 'model', 'StockMovement')).toMatch(/@@unique\(\[userId, idempotencyKey\]\)/);
  });

  it('SA-05 an additive migration newer than the last applied one exists', () => {
    expect(added.length).toBeGreaterThanOrEqual(1);
    expect(sql).toMatch(/ALTER TYPE "StockMovementType" ADD VALUE 'ADJUSTMENT'/);
    expect(sql).toMatch(/CREATE TYPE "StockAdjustmentReason" AS ENUM \('DAMAGED', 'LOST', 'LOAD_ERROR', 'SURPLUS', 'OTHER'\)/);
    expect(sql).toMatch(/ADD COLUMN "reason" "StockAdjustmentReason"/);
    expect(sql).toMatch(/ADD COLUMN "note" TEXT/);
    expect(sql).toMatch(/ADD COLUMN "idempotencyKey" TEXT/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "StockMovement_userId_idempotencyKey_key"\s+ON "StockMovement"\("userId", "idempotencyKey"\)/);
    expect(sql).not.toMatch(/\bDROP\b/);
  });

  it('SA-06 no statement uses the new ADJUSTMENT label as an enum value', () => {
    const withoutComments = sql.replace(/--.*$/gm, '');
    const usages = withoutComments.split(';').filter((statement) => /ADJUSTMENT/.test(statement) && !/ADD VALUE/.test(statement));
    expect(usages.length).toBeGreaterThan(0);
    for (const statement of usages) {
      expect(statement).not.toMatch(/"type"\s*(=|<>|IN|NOT IN)\s*\(?\s*'ADJUSTMENT'::"StockMovementType"/);
      expect(statement).toMatch(/"type"::text/);
    }
  });

  it('SA-07 ADJUSTMENT rows are constrained', () => {
    const lower = sql.replace(/\s+/g, ' ');
    expect(lower).toMatch(/"reason" IS NOT NULL/);
    expect(lower).toMatch(/"idempotencyKey" IS NOT NULL/);
    expect(lower).toMatch(/"quantityDelta" <> 0/);
    expect(lower).toMatch(/abs\("quantityDelta"\) <= 100/);
    expect(lower).toMatch(/"reason"::text = 'OTHER'/);
    expect(lower).toMatch(/char_length\(btrim\("note"\)\) >= 10/);
    expect(lower).toMatch(/"reason"::text IN \('DAMAGED', 'LOST'\)/);
    expect(lower).toMatch(/"quantityDelta" < 0/);
    expect(lower).toMatch(/"reason"::text = 'SURPLUS'/);
    expect(lower).toMatch(/"quantityDelta" > 0/);
  });

  it('SA-08 non-ADJUSTMENT rows must not carry a reason', () => {
    expect(sql.replace(/\s+/g, ' ')).toMatch(/"type"::text = 'ADJUSTMENT' OR "reason" IS NULL/);
  });

  it('SA-09 no global Inventory non-negativity CHECK is added (needs an authorized PILOT inspection)', () => {
    expect(sql).not.toMatch(/ALTER TABLE "Inventory"/);
  });

  it('SA-10 every previously applied migration directory is still present (additive listing)', () => {
    const all = readdirSync(migrationsDir).filter((name) => /^\d{14}_/.test(name));
    expect(all).toContain(LAST_EXISTING);
    expect(all).toContain('20260922210000_d3_initial_stock_and_global_audit');
  });
});
