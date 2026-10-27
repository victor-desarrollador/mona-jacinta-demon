// Sale void v1 + exchange v1 — G19 (20261026140000_sale_void_exchange_guard), DB-free and static.
//
// A sale with at least one SaleExchange cannot be voided: the void rebuilds stock from the original SALE movements and
// after an exchange it would return the original variant twice and never the replacement. The service refuses it
// (SALE_HAS_EXCHANGES); this migration refuses it for ANY writer, and symmetrically refuses an exchange of a voided sale
// (SaleVoid and SaleExchange are mutually exclusive, even for a writer that never updates Sale.status). Additive: two
// functions and two triggers, no table or column touched. The behaviour on real PostgreSQL is sale-void-exchange-guard.pg.test.ts.
import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

const NAME = '20261026140000_sale_void_exchange_guard';
const stripComments = (text: string) => text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
let code = '';
beforeAll(() => { code = stripComments(readFileSync(new URL(`../../prisma/migrations/${NAME}/migration.sql`, import.meta.url), 'utf8')); });

describe('sale void exchange guard — G19 migration (static)', () => {
  it('GD01 sorts right after the G18 exchange schema (only the G20 post-sale guard follows it)', () => {
    const names = readdirSync(new URL('../../prisma/migrations/', import.meta.url)).filter((entry) => /^\d{14}_/.test(entry)).sort();
    expect(names.slice(-3)).toEqual(['20261026130000_sale_exchange_schema', NAME, '20261026150000_sale_post_sale_guard']);
  });

  it('GD02 is additive: no table, column, constraint, type or row is created, altered, dropped or written', () => {
    expect(code).not.toMatch(/\b(CREATE\s+TABLE|ALTER\s+TABLE|ALTER\s+TYPE|DROP|DELETE\s+FROM|UPDATE\s+"|UPDATE\s+public|TRUNCATE|INSERT\s+INTO|RENAME|CREATE\s+(UNIQUE\s+)?INDEX)\b/i);
  });

  it('GD03 exactly two functions and two triggers, by name (one per side of the exclusion)', () => {
    expect([...code.matchAll(/CREATE FUNCTION (public\."\w+")\(\)/g)].map((m) => m[1])).toEqual(['public."fn_sale_void_exchange_guard"', 'public."fn_sale_exchange_void_guard"']);
    expect([...code.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER "(\w+)"/g)].map((m) => m[1])).toEqual(['trg_sale_void_exchange_guard', 'trg_sale_exchange_void_guard']);
  });

  it('GD04 the trigger is a BEFORE row trigger on SaleVoid for INSERT and for a re-pointing UPDATE OF "saleId"', () => {
    const statement = /CREATE TRIGGER "trg_sale_void_exchange_guard"[\s\S]*?;/.exec(code)?.[0] ?? '';
    expect(statement).toMatch(/BEFORE INSERT OR UPDATE OF "saleId"/);
    expect(statement).toMatch(/ON public\."SaleVoid"/);
    expect(statement).toMatch(/FOR EACH ROW/);
  });

  it('GD04b the exchange side is a BEFORE row trigger on SaleExchange for INSERT and UPDATE OF "saleId"', () => {
    const statement = /CREATE TRIGGER "trg_sale_exchange_void_guard"[\s\S]*?;/.exec(code)?.[0] ?? '';
    expect(statement).toMatch(/BEFORE INSERT OR UPDATE OF "saleId"/);
    expect(statement).toMatch(/ON public\."SaleExchange"/);
    expect(statement).toMatch(/FOR EACH ROW/);
  });

  // Both sides: the Sale row is locked FOR UPDATE FIRST (same lock order as the services), the opposite entity is read AFTER the lock.
  it.each([
    ['fn_sale_void_exchange_guard', 'SaleExchange', 'chk_sale_void_has_exchanges'],
    ['fn_sale_exchange_void_guard', 'SaleVoid', 'chk_sale_exchange_has_void'],
  ])('GD05 %s locks the Sale row FOR UPDATE BEFORE looking for the opposite %s, and refuses with check_violation', (name, opposite, message) => {
    const fn = new RegExp(`CREATE FUNCTION public\\."${name}"[\\s\\S]*?\\$\\$;`).exec(code)?.[0] ?? '';
    const lock = fn.search(/FROM public\."Sale" s WHERE s\."id" = NEW\."saleId" FOR UPDATE/);
    const look = fn.search(new RegExp(`FROM public\\."${opposite}"`));
    expect(lock).toBeGreaterThan(-1);
    expect(look).toBeGreaterThan(lock);
    expect(fn).toContain(message);
    expect(fn).toMatch(/ERRCODE = 'check_violation'/);
  });

  it.each(['fn_sale_void_exchange_guard', 'fn_sale_exchange_void_guard'])('GD06 %s follows the hardening convention of the earlier guards: SECURITY INVOKER, search_path pinned, schema-qualified, no dynamic SQL', (name) => {
    const fn = new RegExp(`CREATE FUNCTION public\\."${name}"[\\s\\S]*?\\$\\$;`).exec(code)?.[0] ?? '';
    expect(fn).toMatch(/SECURITY INVOKER/);
    expect(fn).toMatch(/SET search_path = pg_catalog, pg_temp/);
    expect(fn).not.toMatch(/\bEXECUTE\b/);
  });

  it('GD07 G18 is not modified to carry the exclusion: neither of its functions reads SaleVoid', () => {
    const g18 = readFileSync(new URL('../../prisma/migrations/20261026130000_sale_exchange_schema/migration.sql', import.meta.url), 'utf8');
    expect(stripComments(g18)).not.toMatch(/"SaleVoid"/);
  });
});
