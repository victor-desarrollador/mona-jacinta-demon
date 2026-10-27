// Sale exchange v1 — RED contract, DB-free and static: G17 (enum) + G18 (schema) of the exchange.
//
// Reads schema.prisma and the two migration files only. It pins:
//   - the schema SHAPE (models, composite keys, RESTRICT everywhere, nothing required added to an existing model);
//   - the migration CONTENT (additive / N-1 safe, every constraint, FK, index, trigger by NAME);
// so a missing or silently weakened guard turns a test red. The behaviour of the SQL itself is proven on real
// PostgreSQL by sale-exchange.pg.test.ts (LOCAL_TEST in CI; hosted TEST is an OWNER-only gate).
import { readFileSync, readdirSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

const ENUM = '20261026120000_sale_exchange_enum';
const SCHEMA = '20261026130000_sale_exchange_schema';
const read = (name: string) => readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url), 'utf8');
const stripComments = (text: string) => text.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
const schema = readFileSync(new URL('../../prisma/schema.prisma', import.meta.url), 'utf8');
const block = (kind: 'enum' | 'model', name: string) => new RegExp(`^${kind} ${name} \\{([\\s\\S]*?)^\\}`, 'm').exec(schema)?.[1] ?? '';
const fieldLine = (body: string, field: string) => body.split('\n').find((line) => new RegExp(`^\\s*${field}\\s`).test(line)) ?? '';
const labels = (name: string) => block('enum', name).split('\n').map((line) => line.replace(/\/\/.*$/, '').trim()).filter(Boolean);

describe('sale exchange v1 — schema.prisma surface', () => {
  it('SE01 StockMovementType keeps its labels in order and appends SALE_EXCHANGE_IN / SALE_EXCHANGE_OUT', () => {
    expect(labels('StockMovementType')).toEqual(['SALE', 'INITIAL_STOCK', 'ADJUSTMENT', 'SALE_VOID', 'SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT']);
  });

  it('SE02 SaleStatus gets no new member (an exchange never changes the sale state)', () => {
    expect(labels('SaleStatus')).toEqual(['DRAFT', 'PENDING_PAYMENT', 'PAID', 'COMPLETED', 'CANCELLED']);
  });

  it('SE03 SaleExchange: the durable header, idempotent per (sale, key), with the canonical request hash', () => {
    const body = block('model', 'SaleExchange');
    expect(body).not.toBe('');
    for (const field of ['id', 'saleId', 'branchId', 'createdById', 'reason', 'idempotencyKey', 'requestHash', 'createdAt']) {
      expect(fieldLine(body, field), field).not.toBe('');
    }
    expect(fieldLine(body, 'requestHash')).toMatch(/@db\.Char\(64\)/);
    expect(fieldLine(body, 'createdAt')).toMatch(/@db\.Timestamptz\(3\)/);
    expect(body).toMatch(/@@unique\(\[saleId, idempotencyKey\]/);
    expect(body).toMatch(/@@unique\(\[id, saleId, branchId\]/);
    expect(body).toMatch(/@@index\(\[saleId, createdAt\]\)/);
    expect(body).toMatch(/@@index\(\[branchId, createdAt\]\)/);
    expect(fieldLine(body, 'saleId')).not.toMatch(/@unique/); // a sale can be exchanged many times
  });

  it('SE04 SaleExchangeLine: the frozen snapshot, one line per (exchange, saleItem)', () => {
    const body = block('model', 'SaleExchangeLine');
    expect(body).not.toBe('');
    for (const field of ['id', 'saleExchangeId', 'saleId', 'branchId', 'saleItemId', 'replacementVariantId', 'returnQuantity', 'originalUnitPrice', 'replacementUnitPrice']) {
      expect(fieldLine(body, field), field).not.toBe('');
    }
    for (const field of ['returnQuantity', 'originalUnitPrice', 'replacementUnitPrice']) expect(fieldLine(body, field), field).toMatch(/\bBigInt\b/);
    expect(body).toMatch(/@@unique\(\[saleExchangeId, saleItemId\]/);
    expect(body).toMatch(/@@unique\(\[id, saleExchangeId, saleId, branchId\]/);
    expect(body).toMatch(/@@index\(\[saleItemId\]\)/);
    expect(body).toMatch(/@@index\(\[replacementVariantId\]\)/);
    expect(body).toMatch(/fields: \[saleExchangeId, saleId, branchId\], references: \[id, saleId, branchId\]/);
    expect(body).toMatch(/fields: \[saleItemId, saleId\], references: \[id, saleId\]/);
  });

  it('SE05 StockMovement carries the exchange and the line it belongs to, both optional; at most one IN and one OUT per line', () => {
    const body = block('model', 'StockMovement');
    expect(fieldLine(body, 'saleExchangeId')).toMatch(/String\?/);
    expect(fieldLine(body, 'saleExchangeLineId')).toMatch(/String\?/);
    expect(body).toMatch(/@@unique\(\[saleExchangeLineId, type\]/);
    expect(body).toMatch(/fields: \[saleExchangeLineId, saleExchangeId, saleId, branchId\], references: \[id, saleExchangeId, saleId, branchId\]/);
    expect(body).toMatch(/fields: \[saleExchangeId, saleId, branchId\], references: \[id, saleId, branchId\]/);
  });

  it('SE06 every relation of the exchange models is RESTRICT / RESTRICT (history is never cascaded away)', () => {
    for (const name of ['SaleExchange', 'SaleExchangeLine']) {
      const relations = block('model', name).split('\n').filter((line) => line.includes('@relation(') && line.includes('fields:'));
      expect(relations.length, name).toBeGreaterThan(0);
      for (const relation of relations) {
        expect(relation, relation).toMatch(/onDelete: Restrict/);
        expect(relation, relation).toMatch(/onUpdate: Restrict/);
      }
    }
    const movement = block('model', 'StockMovement').split('\n').filter((line) => /saleExchange/.test(line) && line.includes('fields:'));
    expect(movement).toHaveLength(2);
    for (const relation of movement) expect(relation).toMatch(/onDelete: Restrict, onUpdate: Restrict/);
  });
});

describe('sale exchange v1 — N-1 safety of schema.prisma', () => {
  it('NS01 StockMovement gains only the two NULLable columns (the N-1 client still inserts SALE / INITIAL_STOCK / ADJUSTMENT / SALE_VOID rows)', () => {
    const required = block('model', 'StockMovement').split('\n').filter((line) => /^\s{2}\w+\s+[A-Za-z]+(\s|$)/.test(line) && !/\?|\[\]|@default|@id/.test(line) && !/@relation/.test(line));
    const names = required.map((line) => line.trim().split(/\s+/)[0]);
    expect(names).toEqual(['inventoryId', 'type', 'quantityDelta', 'userId', 'branchId']);
  });

  it('NS02 Sale, SaleItem, SalePayment, Inventory, ProductVariant and User gain relation lists only (no column)', () => {
    for (const name of ['Sale', 'SaleItem', 'SalePayment', 'Inventory', 'ProductVariant', 'User']) {
      const added = block('model', name).split('\n').filter((line) => /SaleExchange/.test(line));
      for (const line of added) expect(line, `${name}: ${line}`).toMatch(/SaleExchange(Line)?(\[\]|\?)/);
    }
  });
});

describe('sale exchange v1 — G17 migration (enum only)', () => {
  it('MG01 the two migrations follow the sale void pair, in this order, and only the G19 void guard and the G20 post-sale guard come after them', () => {
    const names = readdirSync(new URL('../../prisma/migrations/', import.meta.url)).filter((entry) => /^\d{14}_/.test(entry)).sort();
    expect(names.slice(-6)).toEqual(['20261024120000_sale_void_enum', '20261024130000_sale_void_schema', ENUM, SCHEMA, '20261026140000_sale_void_exchange_guard', '20261026150000_sale_post_sale_guard']);
  });

  it('MG02 contains ONLY the two ADD VALUE statements (a new label cannot be used in the transaction that adds it)', () => {
    const statements = stripComments(read(ENUM)).split(';').map((statement) => statement.trim()).filter(Boolean);
    expect(statements).toEqual([
      `ALTER TYPE "StockMovementType" ADD VALUE 'SALE_EXCHANGE_IN'`,
      `ALTER TYPE "StockMovementType" ADD VALUE 'SALE_EXCHANGE_OUT'`,
    ]);
  });
});

describe('sale exchange v1 — G18 migration (schema)', () => {
  // Read in beforeAll so a missing migration fails EACH test (not the whole file at collection).
  let code = '';
  beforeAll(() => { code = stripComments(read(SCHEMA)); });

  it('MS01 is additive: nothing is deleted, updated, truncated, dropped, retyped or renamed, and no row is inserted', () => {
    expect(code).not.toMatch(/\b(DELETE\s+FROM|UPDATE\s+"|UPDATE\s+public|TRUNCATE\s+TABLE|DROP\s+TABLE|DROP\s+COLUMN|DROP\s+TYPE|DROP\s+CONSTRAINT|ALTER\s+COLUMN|RENAME|ALTER\s+TYPE)\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  it('MS02 the only ALTER on an existing table is StockMovement ADD COLUMN of two NULLable columns without default', () => {
    const added = [...code.matchAll(/ALTER TABLE "(\w+)"\s+ADD COLUMN\s+"(\w+)"\s+(\w+)([^,;]*)/g)].map((m) => [m[1], m[2], m[3], m[4]!.trim()]);
    expect(added).toEqual([['StockMovement', 'saleExchangeId', 'TEXT', ''], ['StockMovement', 'saleExchangeLineId', 'TEXT', '']]);
    const touched = new Set([...code.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]));
    expect([...touched].sort()).toEqual(['SaleExchange', 'SaleExchangeLine', 'StockMovement']);
  });

  it('MS03 creates exactly SaleExchange and SaleExchangeLine', () => {
    expect([...code.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1])).toEqual(['SaleExchange', 'SaleExchangeLine']);
    expect(code).toMatch(/"requestHash" CHAR\(64\) NOT NULL/);
    expect(code).toMatch(/"createdAt" TIMESTAMPTZ\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  });

  it('MS04 unique indexes and indexes, by name', () => {
    const indexes = [...code.matchAll(/CREATE (UNIQUE )?INDEX "(\w+)" ON "(\w+)"\(([^)]*)\)/g)].map((m) => `${m[1] ? 'U ' : ''}${m[3]}(${m[4]!.replace(/"/g, '').replace(/\s+/g, '')})`).sort();
    expect(indexes).toEqual([
      'SaleExchange(branchId,createdAt)', 'SaleExchange(createdById)', 'SaleExchange(saleId,createdAt)',
      'SaleExchangeLine(replacementVariantId)', 'SaleExchangeLine(saleItemId)',
      'StockMovement(saleExchangeId)',
      'U SaleExchange(id,saleId,branchId)', 'U SaleExchange(saleId,idempotencyKey)',
      'U SaleExchangeLine(id,saleExchangeId,saleId,branchId)', 'U SaleExchangeLine(saleExchangeId,saleItemId)',
      'U StockMovement(saleExchangeLineId,type)',
    ].sort());
  });

  it('MS05 foreign keys, by name and target; every one RESTRICT / RESTRICT', () => {
    const fks = [...code.matchAll(/ADD CONSTRAINT "(\w+)"\s+FOREIGN KEY \(([^)]*)\) REFERENCES "(\w+)"\(([^)]*)\)\s+ON DELETE (\w+) ON UPDATE (\w+)/g)]
      .map((m) => ({ name: m[1], from: m[2]!.replace(/"|\s/g, ''), to: `${m[3]}(${m[4]!.replace(/"|\s/g, '')})`, del: m[5], upd: m[6] }));
    expect(fks.map((fk) => `${fk.name}: ${fk.from} -> ${fk.to}`).sort()).toEqual([
      'SaleExchangeLine_exchange_fkey: saleExchangeId,saleId,branchId -> SaleExchange(id,saleId,branchId)',
      'SaleExchangeLine_replacementVariant_fkey: replacementVariantId -> ProductVariant(id)',
      'SaleExchangeLine_saleItem_fkey: saleItemId,saleId -> SaleItem(id,saleId)',
      'SaleExchange_createdBy_fkey: createdById -> User(id)',
      'SaleExchange_sale_branch_fkey: saleId,branchId -> Sale(id,branchId)',
      'StockMovement_saleExchangeLine_fkey: saleExchangeLineId,saleExchangeId,saleId,branchId -> SaleExchangeLine(id,saleExchangeId,saleId,branchId)',
      'StockMovement_saleExchange_sale_branch_fkey: saleExchangeId,saleId,branchId -> SaleExchange(id,saleId,branchId)',
    ].sort());
    for (const fk of fks) expect([fk.del, fk.upd], fk.name).toEqual(['RESTRICT', 'RESTRICT']);
  });

  it('MS06 CHECK constraints, by name', () => {
    const checks = [...code.matchAll(/ADD CONSTRAINT "(chk_\w+)"\s+CHECK/g)].map((m) => m[1]).sort();
    expect(checks).toEqual([
      'chk_sale_exchange_idempotency_key_uuid_v4', 'chk_sale_exchange_line_prices_positive', 'chk_sale_exchange_line_quantity_positive',
      'chk_sale_exchange_line_same_value', 'chk_sale_exchange_reason', 'chk_sale_exchange_request_hash',
      'chk_stock_movement_sale_exchange_in_positive', 'chk_stock_movement_sale_exchange_only',
      'chk_stock_movement_sale_exchange_out_negative', 'chk_stock_movement_sale_exchange_shape',
    ].sort());
  });

  it('MS07 the money rule is a CHECK: equal unit prices, all positive; quantity positive', () => {
    expect(code).toMatch(/"originalUnitPrice" = "replacementUnitPrice"/);
    expect(code).toMatch(/"originalUnitPrice" > 0 AND "replacementUnitPrice" > 0/);
    expect(code).toMatch(/"returnQuantity" > 0/);
  });

  it('MS08 StockMovement CHECKs compare "type"::text (never the new labels as enum values) and are NOT VALID then VALIDATEd', () => {
    for (const name of ['shape', 'only', 'in_positive', 'out_negative']) {
      const constraint = `chk_stock_movement_sale_exchange_${name}`;
      const statement = new RegExp(`ADD CONSTRAINT "${constraint}"[\\s\\S]*?;`).exec(code)?.[0] ?? '';
      expect(statement, constraint).toMatch(/"type"::text/);
      expect(statement, constraint).toMatch(/NOT VALID;$/);
      expect(code, constraint).toMatch(new RegExp(`VALIDATE CONSTRAINT "${constraint}"`));
    }
  });

  it('MS09 the exchange rows are exclusive to the exchange types, and complete', () => {
    expect(code).toMatch(/"saleExchangeId" IS NOT NULL AND "saleExchangeLineId" IS NOT NULL AND "saleId" IS NOT NULL/);
    expect(code).toMatch(/"saleExchangeId" IS NULL AND "saleExchangeLineId" IS NULL/);
    expect(code).toMatch(/"quantityDelta" > 0/);
    expect(code).toMatch(/"quantityDelta" < 0/);
  });

  it('MS10 ledger integrity: DEFERRED constraint triggers on the line, the movements and the header', () => {
    expect(code).toMatch(/CREATE FUNCTION public\."fn_sale_exchange_ledger_check"\(\)/);
    for (const trigger of ['trg_sale_exchange_line_ledger_check', 'trg_stock_movement_sale_exchange_ledger_check', 'trg_sale_exchange_has_lines', 'trg_sale_exchange_line_remainder']) {
      const statement = new RegExp(`CREATE CONSTRAINT TRIGGER "${trigger}"[\\s\\S]*?;`).exec(code)?.[0] ?? '';
      expect(statement, trigger).toMatch(/AFTER INSERT\s+ON/);
      expect(statement, trigger).toMatch(/DEFERRABLE INITIALLY DEFERRED/);
    }
    // what the check proves (names of the fields the function must compare)
    const fn = /CREATE FUNCTION public\."fn_sale_exchange_ledger_check"[\s\S]*?\$\$;/.exec(code)?.[0] ?? '';
    for (const needle of ['SALE_EXCHANGE_IN', 'SALE_EXCHANGE_OUT', 'returnQuantity', 'replacementVariantId', '"variantId"', '"branchId"', 'createdById']) {
      expect(fn, needle).toContain(needle);
    }
  });

  it('MS11 header guard: BEFORE INSERT takes the Sale lock and requires COMPLETED', () => {
    expect(code).toMatch(/CREATE TRIGGER "trg_sale_exchange_header_guard" BEFORE INSERT\s+ON public\."SaleExchange"/);
    const fn = /CREATE FUNCTION public\."fn_sale_exchange_header_guard"[\s\S]*?\$\$;/.exec(code)?.[0] ?? '';
    expect(fn).toMatch(/FOR UPDATE/);
    expect(fn).toMatch(/'COMPLETED'/);
  });

  it('MS12 append-only: UPDATE and DELETE are refused on SaleExchange, SaleExchangeLine and the exchange StockMovement rows', () => {
    expect(code).toMatch(/CREATE FUNCTION public\."fn_sale_exchange_append_only"\(\)/);
    for (const trigger of [
      'trg_sale_exchange_append_only', 'trg_sale_exchange_line_append_only',
      'trg_stock_movement_sale_exchange_no_update', 'trg_stock_movement_sale_exchange_no_delete',
    ]) {
      const statement = new RegExp(`CREATE TRIGGER "${trigger}"[\\s\\S]*?;`).exec(code)?.[0] ?? '';
      expect(statement, trigger).toMatch(/BEFORE (UPDATE|DELETE|UPDATE OR DELETE)/);
      expect(statement, trigger).toMatch(/FOR EACH ROW/);
    }
    expect(/CREATE TRIGGER "trg_stock_movement_sale_exchange_no_delete"[\s\S]*?;/.exec(code)?.[0]).toMatch(/WHEN \(OLD\."type"::text IN/);
    expect(/CREATE TRIGGER "trg_stock_movement_sale_exchange_no_update"[\s\S]*?;/.exec(code)?.[0]).toMatch(/OLD\."type"::text IN[\s\S]*NEW\."type"::text IN/);
  });

  it('MS13 hardening convention of the earlier guards: SECURITY INVOKER, search_path pinned, schema-qualified', () => {
    const functions = [...code.matchAll(/CREATE FUNCTION (public\."fn_\w+")\(\)([\s\S]*?)\$\$;/g)];
    expect(functions.map((m) => m[1]).sort()).toEqual([
      'public."fn_sale_exchange_append_only"', 'public."fn_sale_exchange_header_guard"', 'public."fn_sale_exchange_has_lines"',
      'public."fn_sale_exchange_ledger_check"', 'public."fn_sale_exchange_line_remainder"',
    ].sort());
    for (const fn of functions) {
      expect(fn[0], fn[1]).toMatch(/SECURITY INVOKER/);
      expect(fn[0], fn[1]).toMatch(/SET search_path = pg_catalog, pg_temp/);
      expect(fn[0], fn[1]).not.toMatch(/\bEXECUTE\b/); // no dynamic SQL
    }
  });
});
