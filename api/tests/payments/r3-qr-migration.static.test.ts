// QR block (P0-B) — static guard for migration 14 (20261021140000_r3_qr). DB-free.
//
// The migration must stay ADDITIVE and N-1 safe: it adds NULLable columns, widens CHECKs by
// dropping and re-creating a constraint of the SAME name in one transaction, adds one partial
// unique index and replaces one function. It never rewrites, deletes or retypes rows or columns,
// and it never edits an earlier migration.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const NAME = '20261021140000_r3_qr';
const sql = readFileSync(new URL(`../../prisma/migrations/${NAME}/migration.sql`, import.meta.url), 'utf8');
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
// Comments may name forbidden words; only executable statements are screened.
const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');

describe('QR migration 14 (static)', () => {
  it('sorts right after the warehouse migration (m13) and is followed only by the sale void and sale exchange migrations', () => {
    const names = readdirSync(new URL('../../prisma/migrations/', import.meta.url)).filter((entry) => /^\d{14}_/.test(entry)).sort();
    expect(names.at(-7)).toBe(NAME);
    expect(names.at(-8)).toBe('20261021130000_warehouse_stock_adjustment');
    expect(names.slice(-6)).toEqual([
      '20261024120000_sale_void_enum', '20261024130000_sale_void_schema',
      '20261026120000_sale_exchange_enum', '20261026130000_sale_exchange_schema',
      '20261026140000_sale_void_exchange_guard',
      '20261026150000_sale_post_sale_guard',
    ]);
  });

  it('is one atomic transaction: BEGIN first, COMMIT last, the LOCK before any DDL', () => {
    expect(code.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(code.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(code.split('\n').filter((line) => /^(BEGIN|COMMIT|ROLLBACK);$/.test(line))).toEqual(['BEGIN;', 'COMMIT;']);
    expect(code.indexOf('LOCK TABLE')).toBeGreaterThan(-1);
    expect(code.indexOf('LOCK TABLE')).toBeLessThan(code.indexOf('ALTER TABLE'));
  });

  it('is additive: no row or table is deleted, updated, truncated, dropped or retyped', () => {
    expect(code).not.toMatch(/\b(DELETE\s+FROM|UPDATE\s+"|TRUNCATE|DROP\s+TABLE|DROP\s+COLUMN|DROP\s+TYPE|ALTER\s+COLUMN|RENAME|ALTER\s+TYPE)\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it('adds exactly the four QR columns, all NULLable and without a default', () => {
    const added = [...code.matchAll(/ADD COLUMN\s+"(\w+)"\s+(\w+)([^,;]*)/g)].map((match) => [match[1], match[2], match[3]!.trim()]);
    expect(added).toEqual([
      ['fullPriceQr', 'BIGINT', ''], ['qrAdjustmentBps', 'INTEGER', ''],
      ['fullPriceQr', 'BIGINT', ''], ['qrAdjustmentBps', 'INTEGER', ''],
    ]);
  });

  it('every DROP CONSTRAINT is re-created, in the same table, under the same name', () => {
    const drops = [...code.matchAll(/ALTER TABLE "(\w+)" DROP CONSTRAINT "(\w+)"/g)].map((match) => `${match[1]}.${match[2]}`);
    const adds = [...code.matchAll(/ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)"/g)].map((match) => `${match[1]}.${match[2]}`);
    expect(drops.length).toBeGreaterThan(0);
    for (const dropped of drops) expect(adds, dropped).toContain(dropped);
    expect(adds.filter((added) => !drops.includes(added)).sort()).toEqual(['CheckoutAttempt.chk_attempt_qr_snapshot', 'SaleCheckout.chk_checkout_qr_snapshot']);
  });

  it('widens the method lists with QR and the algorithm version to 1, 2 and 3 only', () => {
    expect(code).toContain(`'CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR'`);
    expect(code).toContain('"algorithmVersion" IN (1, 2, 3)');
    expect(code).not.toMatch(/"algorithmVersion" IN \(1, 2, 3, 4/);
  });

  it('re-creates the credit snapshot CHECKs so a version-3 row may carry a credit price (m12 pinned version = 2)', () => {
    for (const name of ['chk_checkout_credit_snapshot', 'chk_attempt_credit_snapshot']) {
      expect(code, name).toContain(`"${name}"`);
    }
    expect(code).toContain('"algorithmVersion" >= 2 OR "fullPriceCredit" IS NULL');
    expect(code).not.toContain('"algorithmVersion" = 2 OR "fullPriceCredit" IS NULL');
  });

  it('creates exactly one index, partial and unique, for QR references per branch', () => {
    expect([...code.matchAll(/CREATE\s+(UNIQUE\s+)?INDEX\s+"(\w+)"/g)].map((match) => [match[1]?.trim(), match[2]])).toEqual([['UNIQUE', 'ExternalCollection_qr_ref_key']]);
    expect(code).toContain(`WHERE "method" = 'QR'`);
  });

  it('QR carries no institution in ExternalCollection (chk_ec_institution), like the cards', () => {
    expect(code).toContain(`"method" IN ('CARD_DEBIT', 'CARD_CREDIT', 'QR') AND "institution" IS NULL AND "institutionOther" IS NULL`);
  });

  it('replaces only the F1 immutability function, keeping its signature and attributes, and freezes the QR columns', () => {
    expect([...code.matchAll(/CREATE OR REPLACE FUNCTION\s+(\S+)/g)].map((match) => match[1])).toEqual(['public."fn_checkout_attempt_guard"()']);
    expect(code).toContain('LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp');
    for (const side of ['NEW', 'OLD']) {
      expect(code).toContain(`${side}."fullPriceQr"`);
      expect(code).toContain(`${side}."qrAdjustmentBps"`);
      // The credit columns stay frozen too (the function is the m12 body plus the two QR columns).
      expect(code).toContain(`${side}."fullPriceCredit"`);
      expect(code).toContain(`${side}."creditAdjustmentBps"`);
    }
  });

  it('does not touch earlier migrations: m12 and m13 keep their reviewed bytes', () => {
    const pins = readFileSync(new URL('../../src/modules/payments/checkout-readiness.ts', import.meta.url), 'utf8');
    expect(pins).toContain('ccec6685120cc9236c5c95a57f2922dc5bbe09cf759ff21b4c9a3635d893f6be');
    expect(pins).toContain('819d669933639173e1b21879791c14eb3cced33c0d8417ca30dd07800fb252c0');
  });

  it('schema.prisma mirrors the four columns as optional, in both models', () => {
    for (const model of ['SaleCheckout', 'CheckoutAttempt']) {
      const body = schema.slice(schema.indexOf(`model ${model} {`));
      const block = body.slice(0, body.indexOf('\n}'));
      expect(block, model).toMatch(/fullPriceQr\s+BigInt\?/);
      expect(block, model).toMatch(/qrAdjustmentBps\s+Int\?/);
    }
  });
});
