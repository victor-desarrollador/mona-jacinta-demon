// Sale exchange v1 (G20) — DB-free static contract of 20261026150000_sale_post_sale_guard and of the SalePostSaleGuard model.
// The behaviour of the SQL is proven on real PostgreSQL by sale-post-sale-guard.pg.test.ts and sale-void-exchange-isolation.pg.test.ts.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const NAME = '20261026150000_sale_post_sale_guard';
const sql = readFileSync(new URL(`../../prisma/migrations/${NAME}/migration.sql`, import.meta.url), 'utf8');
const code = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const at = (needle: string) => code.indexOf(needle);

describe('G20 sale_post_sale_guard — migration content', () => {
  it('PG01 is the LAST migration, after the G19 guard, and its bytes are pinned', () => {
    const names = readdirSync(new URL('../../prisma/migrations/', import.meta.url)).filter((entry) => /^\d{14}_/.test(entry)).sort();
    expect(names.slice(-2)).toEqual(['20261026140000_sale_void_exchange_guard', NAME]);
    expect(createHash('sha256').update(sql).digest('hex')).toBe('5924bb722676048489dd930bc1c90a36a8dda193ae77dc0368562989667deef5');
  });

  it('PG02 is additive: it creates exactly one table, one function and two triggers and alters/drops nothing existing', () => {
    expect(code.match(/^\s*CREATE TABLE\b/gm)).toHaveLength(1);
    expect(code.match(/^\s*CREATE FUNCTION\b/gm)).toHaveLength(1);
    expect(code.match(/^\s*CREATE TRIGGER\b/gm)).toHaveLength(2);
    expect(code).not.toMatch(/\b(ALTER TABLE|DROP|TRUNCATE|DELETE FROM|CREATE TYPE|ALTER TYPE|CREATE OR REPLACE|UPDATE\s+"?public"?\.?"?(Sale|SaleVoid|SaleExchange)\b)/);
    expect(code).not.toMatch(/CREATE (UNIQUE )?INDEX/); // the primary key is the only index
  });

  it('PG03 table: PK(saleId), TEXT mode CHECKed to VOID | EXCHANGE (no enum), timestamptz(3), FK to Sale RESTRICT / RESTRICT', () => {
    expect(code).toMatch(/"saleId" TEXT NOT NULL,\s*"mode" TEXT NOT NULL,\s*"createdAt" TIMESTAMPTZ\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
    expect(code).toMatch(/CONSTRAINT "SalePostSaleGuard_pkey" PRIMARY KEY \("saleId"\)/);
    expect(code).toMatch(/CONSTRAINT "chk_sale_post_sale_guard_mode" CHECK \("mode" IN \('VOID', 'EXCHANGE'\)\)/);
    expect(code).toMatch(/FOREIGN KEY \("saleId"\) REFERENCES "Sale"\("id"\) ON DELETE RESTRICT ON UPDATE RESTRICT/);
  });

  it('PG04 order: lock both tables, create, DETECT the double family, backfill, and only then create the function and the triggers', () => {
    const order = [
      'LOCK TABLE public."SaleVoid", public."SaleExchange" IN SHARE ROW EXCLUSIVE MODE', 'CREATE TABLE "SalePostSaleGuard"', 'backfill aborted',
      `SELECT DISTINCT "saleId", 'VOID' FROM "SaleVoid"`, `SELECT DISTINCT "saleId", 'EXCHANGE' FROM "SaleExchange"`, 'CREATE FUNCTION public."fn_sale_post_sale_claim"',
      'CREATE TRIGGER "trg_sale_void_post_sale_claim"', 'CREATE TRIGGER "trg_sale_exchange_post_sale_claim"',
    ].map(at);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(code).toMatch(/USING ERRCODE = 'check_violation'/);
    expect(code).toMatch(/no mode is chosen silently/);
  });

  it('PG05 the claim: Sale locked first, INSERT .. ON CONFLICT (saleId) DO UPDATE SET mode = existing mode RETURNING, a different mode is check_violation', () => {
    expect(code).toMatch(/SECURITY INVOKER SET search_path = pg_catalog, pg_temp/);
    expect(at('FOR UPDATE')).toBeLessThan(at('ON CONFLICT ("saleId") DO UPDATE SET "mode" = g."mode"'));
    expect(code).toMatch(/RETURNING g\."mode" INTO claimed/);
    expect(code).toMatch(/IF claimed IS DISTINCT FROM wanted THEN/);
    expect(code).toMatch(/BEFORE INSERT OR UPDATE OF "saleId"\s*ON public\."SaleVoid" FOR EACH ROW\s*EXECUTE FUNCTION public\."fn_sale_post_sale_claim"\('VOID'\)/);
    expect(code).toMatch(/BEFORE INSERT OR UPDATE OF "saleId"\s*ON public\."SaleExchange" FOR EACH ROW\s*EXECUTE FUNCTION public\."fn_sale_post_sale_claim"\('EXCHANGE'\)/);
  });

  it('PG06 the trigger NAMES keep the lock order Sale -> claim: each claim fires after the G18 / G19 guard that locks the Sale first', () => {
    const sorted = (names: string[]) => [...names].sort();
    expect(sorted(['trg_sale_exchange_append_only', 'trg_sale_exchange_header_guard', 'trg_sale_exchange_post_sale_claim', 'trg_sale_exchange_void_guard']).indexOf('trg_sale_exchange_header_guard'))
      .toBeLessThan(sorted(['trg_sale_exchange_append_only', 'trg_sale_exchange_header_guard', 'trg_sale_exchange_post_sale_claim', 'trg_sale_exchange_void_guard']).indexOf('trg_sale_exchange_post_sale_claim'));
    expect(sorted(['trg_sale_void_exchange_guard', 'trg_sale_void_post_sale_claim'])).toEqual(['trg_sale_void_exchange_guard', 'trg_sale_void_post_sale_claim']);
  });
});

describe('G20 — schema.prisma model', () => {
  const body = /^model SalePostSaleGuard \{([\s\S]*?)^\}/m.exec(schema)?.[1] ?? '';
  it('PS01 SalePostSaleGuard: saleId @id, mode String (no enum), createdAt timestamptz(3), RESTRICT relation to Sale; Sale gets one optional back-relation', () => {
    expect(body).toMatch(/saleId\s+String\s+@id/);
    expect(body).toMatch(/mode\s+String\s*$/m);
    expect(body).toMatch(/createdAt\s+DateTime\s+@default\(now\(\)\)\s+@db\.Timestamptz\(3\)/);
    expect(body).toMatch(/onDelete: Restrict, onUpdate: Restrict, map: "SalePostSaleGuard_saleId_fkey"/);
    expect(schema).toMatch(/postSaleGuard\s+SalePostSaleGuard\?/);
    expect(schema).not.toMatch(/enum PostSale/);
  });
});
