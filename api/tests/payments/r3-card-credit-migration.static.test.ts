// CARD_CREDIT block — static guard for migration 12 (20261021120000_r3_card_credit). DB-free.
//
// The migration must stay ADDITIVE and N-1 safe: it adds NULLable columns, widens CHECKs by
// dropping and re-creating a constraint of the SAME name in one transaction, adds one partial
// unique index and replaces one function. It never rewrites, deletes or retypes rows or columns.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const NAME = '20261021120000_r3_card_credit';
const sql = readFileSync(new URL(`../../prisma/migrations/${NAME}/migration.sql`, import.meta.url), 'utf8');
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
// Comments may name forbidden words; only executable statements are screened.
const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

describe('CARD_CREDIT migration 12 (static)', () => {
  it('is one atomic transaction: BEGIN first, COMMIT last, the LOCK before any DDL', () => {
    expect(code.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(code.trimEnd().endsWith('COMMIT;')).toBe(true);
    // The only top-level transaction statements (the plpgsql function body has its own BEGIN … END).
    expect(code.split('\n').filter((line) => /^(BEGIN|COMMIT|ROLLBACK);$/.test(line))).toEqual(['BEGIN;', 'COMMIT;']);
    expect(code.indexOf('LOCK TABLE')).toBeGreaterThan(-1);
    expect(code.indexOf('LOCK TABLE')).toBeLessThan(code.indexOf('ALTER TABLE'));
  });

  it('is additive: no row or table is deleted, updated, truncated, dropped or retyped', () => {
    expect(code).not.toMatch(/\b(DELETE\s+FROM|UPDATE\s+"|TRUNCATE|DROP\s+TABLE|DROP\s+COLUMN|DROP\s+TYPE|ALTER\s+COLUMN|RENAME|ALTER\s+TYPE)\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it('adds exactly the four credit columns, all NULLable and without a default', () => {
    const added = [...code.matchAll(/ADD COLUMN\s+"(\w+)"\s+(\w+)([^,;]*)/g)].map((match) => [match[1], match[2], match[3]!.trim()]);
    expect(added).toEqual([
      ['fullPriceCredit', 'BIGINT', ''], ['creditAdjustmentBps', 'INTEGER', ''],
      ['fullPriceCredit', 'BIGINT', ''], ['creditAdjustmentBps', 'INTEGER', ''],
    ]);
  });

  it('every DROP CONSTRAINT is re-created, in the same table, under the same name', () => {
    const drops = [...code.matchAll(/ALTER TABLE "(\w+)" DROP CONSTRAINT "(\w+)"/g)].map((match) => `${match[1]}.${match[2]}`);
    const adds = [...code.matchAll(/ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)"/g)].map((match) => `${match[1]}.${match[2]}`);
    expect(drops.length).toBeGreaterThan(0);
    for (const dropped of drops) expect(adds, dropped).toContain(dropped);
    // The only constraints that are NEW (not replacements) are the two credit snapshot CHECKs.
    expect(adds.filter((added) => !drops.includes(added)).sort()).toEqual(['CheckoutAttempt.chk_attempt_credit_snapshot', 'SaleCheckout.chk_checkout_credit_snapshot']);
  });

  it('widens every method list with CARD_CREDIT and never admits QR', () => {
    expect(code).toContain(`'CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT'`);
    expect(code).not.toContain("'QR'");
    // The algorithm version stays closed: only 1 (no credit snapshot) and 2 (with it).
    expect(code).toContain('"algorithmVersion" IN (1, 2)');
  });

  it('creates exactly one index, partial and unique, for CARD_CREDIT references per branch', () => {
    expect([...code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+"(\w+)"/g)].map((match) => [match[1]?.trim(), match[2]])).toEqual([['UNIQUE', 'ExternalCollection_credit_ref_key']]);
    expect(code).toContain(`WHERE "method" = 'CARD_CREDIT'`);
  });

  it('replaces only the F1 immutability function, keeping its signature and attributes, and freezes the credit columns', () => {
    expect([...code.matchAll(/CREATE OR REPLACE FUNCTION\s+(\S+)/g)].map((match) => match[1])).toEqual(['public."fn_checkout_attempt_guard"()']);
    expect(code).toContain('LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp');
    for (const side of ['NEW', 'OLD']) {
      expect(code).toContain(`${side}."fullPriceCredit"`);
      expect(code).toContain(`${side}."creditAdjustmentBps"`);
    }
  });

  it('schema.prisma mirrors the four columns as optional, in both models', () => {
    for (const model of ['SaleCheckout', 'CheckoutAttempt']) {
      const body = schema.slice(schema.indexOf(`model ${model} {`));
      const block = body.slice(0, body.indexOf('\n}'));
      expect(block, model).toMatch(/fullPriceCredit\s+BigInt\?/);
      expect(block, model).toMatch(/creditAdjustmentBps\s+Int\?/);
    }
  });
});
