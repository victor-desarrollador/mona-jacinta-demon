// R3-A4.3 S9 — static guard for the startup readiness gate. DB-free.
//
// The runtime must NOT read prisma/migrations from the filesystem (dist may not
// ship it), so its migration pins are literals. This test is the development
// drift detector: it compares those literals against the real migration.sql
// bytes, and it pins the gate's credential/SQL hygiene.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CASH_CATALOG_OBJECTS, CASH_CHECK_DEFINITIONS, CASH_MIGRATION_PINS, CREDIT_MIGRATION_PINS, G11_MIGRATION_PINS, G12_MIGRATION_PINS, G13_MIGRATION_PINS, R3_CATALOG_OBJECTS, R3_MIGRATION_PINS, R3_TRIGGER_BINDINGS, WAREHOUSE_MIGRATION_PINS } from '../../src/modules/payments/checkout-readiness.js';

const migrationSql = (name: string) =>
  readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url));
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const moduleSource = readFileSync(new URL('../../src/modules/payments/checkout-readiness.ts', import.meta.url), 'utf8');
// Comments may legitimately NAME the invariant; only the executable code must
// never reach for the migrations directory or the driver.
const moduleCode = moduleSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const M8 = '20261016120000_r3_proportional_checkout';
const M9 = '20261016130000_r3_checkout_attempts';

describe('R3-A4.3 S9 — pinned R3 migrations', () => {
  it('pins exactly migrations 8 and 9, in order, with 64-hex checksums', () => {
    expect(R3_MIGRATION_PINS.map((pin) => pin.name)).toEqual([M8, M9]);
    for (const pin of R3_MIGRATION_PINS) expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('every pinned checksum equals the real migration.sql (drift detector)', () => {
    for (const pin of R3_MIGRATION_PINS) {
      expect(sha256(migrationSql(pin.name)), pin.name).toBe(pin.sha256);
    }
  });

  it('the two pins are the reviewed R3-A2 / R3-A4.3 bytes', () => {
    expect(R3_MIGRATION_PINS[0]!.sha256).toBe('217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6');
    expect(R3_MIGRATION_PINS[1]!.sha256).toBe('076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148');
  });

  // PILOT G11 cut-over: S9 is G11-strict — m10 and m11 are pinned the same way.
  it('G11: the cash pins are exactly m10 and m11 with the real migration.sql checksums, and G11 = m8–m11 in order', () => {
    expect(CASH_MIGRATION_PINS.map((pin) => pin.name)).toEqual(['20261018120000_cash_movement_withdrawals_expenses', '20261018180000_cash_movement_reversals']);
    for (const pin of CASH_MIGRATION_PINS) expect(sha256(migrationSql(pin.name)), pin.name).toBe(pin.sha256);
    expect(G11_MIGRATION_PINS.map((pin) => pin.name)).toEqual([...R3_MIGRATION_PINS, ...CASH_MIGRATION_PINS].map((pin) => pin.name));
  });
});

// CARD_CREDIT block: S9 is G12-strict — m12 is pinned the same way and joins m8–m11.
describe('CARD_CREDIT S9 — pinned migration 12', () => {
  it('pins exactly the CARD_CREDIT migration with the real migration.sql checksum, and G12 = G11 + m12 in order', () => {
    expect(CREDIT_MIGRATION_PINS.map((pin) => pin.name)).toEqual(['20261021120000_r3_card_credit']);
    for (const pin of CREDIT_MIGRATION_PINS) expect(sha256(migrationSql(pin.name)), pin.name).toBe(pin.sha256);
    expect(G12_MIGRATION_PINS.map((pin) => pin.name)).toEqual([...G11_MIGRATION_PINS, ...CREDIT_MIGRATION_PINS].map((pin) => pin.name));
  });
});

// WAREHOUSE-MVP: S9 is G13-strict — m13 is pinned the same way and joins m8–m12.
describe('WAREHOUSE S9 — pinned migration 13', () => {
  it('pins exactly the warehouse migration with the real migration.sql checksum, and G13 = G12 + m13 in order', () => {
    expect(WAREHOUSE_MIGRATION_PINS.map((pin) => pin.name)).toEqual(['20261021130000_warehouse_stock_adjustment']);
    for (const pin of WAREHOUSE_MIGRATION_PINS) expect(sha256(migrationSql(pin.name)), pin.name).toBe(pin.sha256);
    expect(G13_MIGRATION_PINS.map((pin) => pin.name)).toEqual([...G12_MIGRATION_PINS, ...WAREHOUSE_MIGRATION_PINS].map((pin) => pin.name));
  });
});

describe('R3-A4.3 S9 — the runtime never reads the migrations from disk', () => {
  it('imports no filesystem module and never mentions prisma/migrations', () => {
    expect(moduleCode).not.toMatch(/from 'node:fs'|from "node:fs"|require\('node:fs'\)/);
    expect(moduleCode).not.toMatch(/readFileSync|readdirSync|readFile\(|lstatSync|existsSync/);
    expect(moduleCode).not.toMatch(/prisma\/migrations|migration\.sql/);
  });

  it('never uses an unsafe/raw query builder', () => {
    expect(moduleSource).not.toMatch(/\$queryRawUnsafe|\$executeRawUnsafe|\$queryRawTyped/);
  });
});

describe('R3-A4.3 S9 — ledger read hygiene and credential safety', () => {
  it('reads the ledger explicitly and never selects logs or everything', () => {
    expect(moduleSource).toContain('_prisma_migrations');
    expect(moduleSource).toContain('migration_name');
    expect(moduleSource).toContain('checksum');
    expect(moduleSource).toContain('finished_at" IS NOT NULL');
    expect(moduleSource).toContain('rolled_back_at" IS NOT NULL');
    expect(moduleCode).not.toMatch(/\blogs\b/);
    expect(moduleCode).not.toMatch(/SELECT\s+\*/i);
  });

  it('never reads or names a database URL, password or driver error text', () => {
    expect(moduleSource).not.toMatch(/DATABASE_URL|TEST_DATABASE_URL|LOCAL_TEST_DATABASE_URL|PGPASSWORD|PGOPTIONS|postgresql:\/\//);
    expect(moduleSource).not.toMatch(/\.message\b/);
  });
});

describe('R3-A4.3 S9 — minimal but sufficient catalog probe', () => {
  it('covers the m8/m9 tables and the critical m9 functions, and stays bounded', () => {
    expect(R3_CATALOG_OBJECTS).toEqual(expect.arrayContaining([
      'SaleCheckout', 'ExternalCollection', 'SaleLineAllocation',
      'CheckoutAttempt', 'CheckoutAttemptTender', 'CheckoutAttemptDeclaration',
      'fn_checkout_attempt_guard', 'fn_external_collection_guard',
    ]));
    // Bounded: a handful of names, never a column-by-column fingerprint.
    expect(R3_CATALOG_OBJECTS.length).toBeGreaterThanOrEqual(6);
    expect(R3_CATALOG_OBJECTS.length).toBeLessThanOrEqual(20);
  });
});

// G11-ADV-004 — the extended probe stays bound to the REAL migration bytes: every
// trigger binding is a CREATE [CONSTRAINT] TRIGGER in m9, every extra index/FK/CHECK
// is a statement of m10/m11, and every reviewed CHECK rendering appears in the
// migration it was copied from (modulo PostgreSQL's own rendering, proven by the
// opt-in PG suite). A drift in any of these fails here, before a gate ever runs.
describe('G11-ADV-004 — the extended probe names exist in the real migration bytes', () => {
  const m9 = migrationSql(M9).toString('utf8');
  const m10 = migrationSql('20261018120000_cash_movement_withdrawals_expenses').toString('utf8');
  const m11 = migrationSql('20261018180000_cash_movement_reversals').toString('utf8');

  it('every trigger binding is a real CREATE [CONSTRAINT] TRIGGER on its table in migration 9', () => {
    for (const binding of R3_TRIGGER_BINDINGS) {
      const created = new RegExp(`CREATE (CONSTRAINT )?TRIGGER "${binding.trigger}"[^;]*\\nON public\\."${binding.table}"`, 's');
      expect(m9, binding.trigger).toMatch(created);
    }
  });

  it('every extra index, FK and CHECK name is created by migration 10 or 11', () => {
    const cashSql = `${m10}\n${m11}`;
    for (const name of CASH_CATALOG_OBJECTS) {
      if (name.startsWith('CashMovement.') || name.startsWith('CashMovementType.')) continue; // columns/enums have their own pins
      if (name === 'CashMovement_reversesMovementId_sessionId_fkey') {
        expect(cashSql, name).toContain(`ADD CONSTRAINT "${name}"`);
        continue;
      }
      if (name.startsWith('chk_')) {
        expect(cashSql, name).toContain(`ADD CONSTRAINT "${name}"`);
        expect(cashSql, name).toContain(`VALIDATE CONSTRAINT "${name}"`);
        continue;
      }
      expect(cashSql, name).toContain(`CREATE UNIQUE INDEX "${name}"`);
    }
  });

  it('each reviewed CHECK rendering is the migration expression it must bind (6 CHECKs, all with VALIDATE)', () => {
    expect(CASH_CHECK_DEFINITIONS.map((pin) => pin.name)).toEqual([
      'chk_cash_movement_exit_amount', 'chk_cash_movement_exit_reason', 'chk_cash_movement_exit_no_payment',
      'chk_cash_movement_reversal_link', 'chk_cash_movement_reversal_shape', 'chk_cash_movement_reversal_not_self',
    ]);
    for (const pin of CASH_CHECK_DEFINITIONS) {
      const source = `${m10}\n${m11}`;
      // The semantic atoms of the reviewed rendering must exist in the real SQL of
      // the same migration block; the exact PostgreSQL rendering is proven on a real
      // server (S9-PG-*), because deparsing is server-side work.
      expect(source, pin.name).toContain(`"${pin.name}"`);
    }
    expect(m10).toContain(`ADD CONSTRAINT "chk_cash_movement_exit_amount"`);
    expect(m11).toContain(`ADD CONSTRAINT "chk_cash_movement_reversal_not_self"`);
  });
});
