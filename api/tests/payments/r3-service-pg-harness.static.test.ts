// R3-A4.3 U2 — DB-free checks of the opt-in SERVICE-LEVEL PostgreSQL suites
// (S5/T-C, S6/T-X, S7/T-S, S7-I/T-RR) and of their shared helper. Nothing here
// opens a database or spawns a process: it reads the four sources and asserts
// their opt-in gating, their LOCAL_TEST binding, their credential hygiene and
// the purity of the helper they share. The PostgreSQL behaviour itself is proven
// ONLY by the four opt-in files, never here.
//
// This test is deliberately insensitive to HOW a suite groups its cases: it
// requires the gate, the binding, the canonical pool opener and the absence of
// the forbidden shortcuts, and it requires the helper to be imported. It does
// not pin case names or counts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { actsAsSupervisorAtLocation, hasPermissionAtLocation, isOwner } from '../../src/modules/rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import * as servicePgHelper from '../helpers/r3-service-pg.js';
import {
  PG_SYSTEM_ID,
  RACE_TIMEOUT_MS,
  RACE_WAIT_MS,
  actor,
  cashierActor,
  codeOf,
  companyAdminActor,
  errorOf,
  ownerActor,
  withTimeout,
} from '../helpers/r3-service-pg.js';

const source = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
const helperSource = readFileSync(new URL('../helpers/r3-service-pg.ts', import.meta.url), 'utf8');
const cashMovementSource = readFileSync(new URL('../cash/cash-movement.pg.test.ts', import.meta.url), 'utf8');

type Suite = { file: string; gate: string; label: string };
const SUITES: Suite[] = [
  { file: 'checkout-settlement.pg.test.ts', gate: 'MONA_R3_S5_PG', label: 'S5/T-C settlement' },
  { file: 'checkout-close.pg.test.ts', gate: 'MONA_R3_S6_PG', label: 'S6/T-X close' },
  { file: 'checkout-stock-recovery.pg.test.ts', gate: 'MONA_R3_S7_PG', label: 'S7/T-S stock recovery' },
  { file: 'checkout-recovery-reservation.pg.test.ts', gate: 'MONA_R3_S7RR_PG', label: 'S7-I/T-RR recovery reservation' },
];

describe('R3-A4.3 U2 — the shared service-PG helper is pure (no driver at import time)', () => {
  it('U2-H01 imports pg only as a TYPE and never constructs a driver, at module scope or anywhere', () => {
    expect(helperSource).toMatch(/import type \{[^}]*\} from 'pg';/);
    expect(helperSource).not.toMatch(/^\s*import\s+\{[^}]*Pool[^}]*\}\s+from\s+'pg'/m);
    // No driver is ever BUILT here: the helper only borrows a Pool handed to it.
    expect(helperSource).not.toMatch(/new Pool\(|new PrismaClient\(|new PrismaPg\(|PrismaPg\(/);
    expect(helperSource).not.toMatch(/\bexecSync\b|\bspawnSync\b|child_process/);
    // A Pool method call (pool.connect()) is allowed INSIDE a function — that is
    // how the coordinator gets its connection — but never at module scope, so the
    // module stays safe to import in a DB-free test.
    expect(helperSource).not.toMatch(/^await /m);
    expect(helperSource).not.toMatch(/^pool\.connect\(/m);
  });

  it('U2-H02 the system-id binding is a decimal uint64 and the race bounds are positive and finite', () => {
    expect(PG_SYSTEM_ID.test('7461234567890123456')).toBe(true);
    for (const bad of ['', '0', '0123', 'abc', '12345', '746123456789012345678901234']) {
      expect(PG_SYSTEM_ID.test(bad), bad).toBe(false);
    }
    expect(RACE_WAIT_MS).toBeGreaterThan(0);
    expect(RACE_TIMEOUT_MS).toBeGreaterThan(RACE_WAIT_MS);
  });

  it('U2-H03 OWNER/COMPANY-ADMIN/CASHIER actors are accepted by the REAL policy layer, per assignment', () => {
    const owner = ownerActor('u-owner') as { auth: never };
    const admin = companyAdminActor('u-admin') as { auth: never };
    const cashier = cashierActor('u-cashier', 'branch-1') as { auth: never };
    expect(isOwner(owner.auth)).toBe(true);
    expect(isOwner(admin.auth)).toBe(false);
    expect(actsAsSupervisorAtLocation(admin.auth, [PRODUCTION_PERMISSIONS.SALE_CANCEL_PENDING], 'branch-1')).toBe(true);
    expect(actsAsSupervisorAtLocation(cashier.auth, [PRODUCTION_PERMISSIONS.SALE_CANCEL_PENDING], 'branch-1')).toBe(false);
    expect(hasPermissionAtLocation(cashier.auth, PRODUCTION_PERMISSIONS.SALE_CHARGE, 'branch-1')).toBe(true);
    expect(hasPermissionAtLocation(cashier.auth, PRODUCTION_PERMISSIONS.SALE_CHARGE, 'branch-2')).toBe(false);
    // The generic builder refuses to fabricate a branchless CASHIER.
    expect(() => actor('u-x', 'CASHIER', null)).toThrow(/branchId/);
  });

  it('U2-H04 errorOf/codeOf surface only AppError and never swallow infrastructure failures', async () => {
    expect(await codeOf(Promise.resolve('ok'))).toBeNull();
    expect(await errorOf(Promise.resolve('ok'))).toBeNull();
    await expect(errorOf(Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await withTimeout(Promise.resolve(7), 1_000, 'quick')).toBe(7);
    await expect(withTimeout(new Promise(() => {}), 5, 'stuck')).rejects.toThrow(/stuck timed out/);
  });
});

describe('R3-A4.3 U2 — every service PostgreSQL suite is opt-in, bound and credential-safe', () => {
  for (const suite of SUITES) {
    describe(`${suite.label} (${suite.file})`, () => {
      // Read lazily, inside each `it`: a missing suite then fails THAT case with
      // its exact ENOENT path instead of aborting the whole module, so the
      // helper assertions above still report and every gap is visible at once.
      const text = () => source(suite.file);

      it('U2-S01 is opt-in: a single gate variable, describe.skipIf, never .only/.skip-forever', () => {
        expect(text()).toContain(`const enabled = process.env.${suite.gate} === '1';`);
        expect(text()).toContain('describe.skipIf(!enabled)');
        expect(text()).not.toMatch(/\bdescribe\.only\b|\bit\.only\b|\btest\.only\b/);
        // No other gate may sneak a second, differently named switch in.
        expect(text().match(/process\.env\.MONA_R3_[A-Z0-9_]*PG\b/g)?.every((m) => m === `process.env.${suite.gate}`)).toBe(true);
      });

      it('U2-S02 fails closed on the disposable acknowledgement, the LOCAL_TEST selector and the cluster binding', () => {
        expect(text()).toContain(`process.env.${suite.gate}_DISPOSABLE !== '1'`);
        expect(text()).toContain("process.env.MONA_TEST_DATABASE_TARGET !== 'local'");
        expect(text()).toContain('process.env.MONA_R3_PG_SYSTEM_ID');
        // The binding is validated with the shared decimal-uint64 pattern, not a loose truthiness test.
        expect(text()).toMatch(/PG_SYSTEM_ID\.test\(|isolated cluster binding is missing/);
        expect(text()).toContain('pg_control_system()');
        expect(text()).toMatch(/system_id !== expectedSystemId/);
      });

      it('U2-S03 uses the canonical proven LOCAL_TEST pool opener, never a hand-built connection', () => {
        expect(text()).toMatch(/const \{ pool(?:, target)? \} = await openProvenLocalTestPool\(/);
        expect(text()).toContain("await import('../../scripts/demo-database.js')");
        expect(text()).not.toMatch(/new Pool\(|new PrismaClient\(\{[^}]*datasourceUrl|PrismaPg\(process\.env/);
      });

      it('U2-S04 never shells out and never reads a database URL itself', () => {
        expect(text()).not.toMatch(/child_process|\bexecSync\b|\bspawnSync\b|\bsh -c\b|shell:\s*true/);
        expect(text()).not.toMatch(/PGPASSWORD/);
        expect(text()).not.toMatch(/process\.env\.LOCAL_TEST_DATABASE_URL|process\.env\[['"]LOCAL_TEST_DATABASE_URL/);
        expect(text()).not.toMatch(/['"]-d['"]|--dbname/);
      });

      it('U2-S05 shares the pure overlap/actor helper instead of re-implementing it locally', () => {
        expect(text()).toMatch(/from '\.\.\/helpers\/r3-service-pg\.js'/);
        expect(text()).toContain('holdRowLock(');
        expect(text()).toContain('waitForBlocked(');
        expect(text()).toContain('ownerActor(');
      });
    });
  }
});

// P2-B (U2 review): every opt-in PG suite creates Locations with a UNIQUE
// pointOfSaleNumber = suite base + parseInt(tag.slice(0, 5), 16). A five-hex tag
// reaches 0xfffff = 1_048_575, so bases 1_000_000 apart overlapped (S5's top end
// collided with S6's bottom, S4's with S-REF's). One helper owns the ranges.
const POS_SUITES = [
  { file: 'checkout-reservation.pg.test.ts', suite: 'S4' },
  { file: 'external-collections-refund.pg.test.ts', suite: 'SREF' },
  { file: 'checkout-settlement.pg.test.ts', suite: 'S5' },
  { file: 'checkout-close.pg.test.ts', suite: 'S6' },
  { file: 'checkout-stock-recovery.pg.test.ts', suite: 'S7' },
  { file: 'checkout-recovery-reservation.pg.test.ts', suite: 'S7RR' },
] as const;

describe('R3-A4.3 U2 P2-B — pointOfSaleNumber ranges are disjoint per suite', () => {
  const posFor = () => {
    const fn = (servicePgHelper as Record<string, unknown>).pointOfSaleNumberFor;
    expect(typeof fn, 'pointOfSaleNumberFor must be exported').toBe('function');
    return fn as (suite: string, tag: string) => number;
  };

  it('U2-P2B-01 every suite range [min, max] is disjoint from every other one and fits a PostgreSQL INTEGER', () => {
    const pos = posFor();
    const ranges = POS_SUITES.map(({ suite }) => ({ suite, min: pos(suite, '00000000'), max: pos(suite, 'ffffffff') }));
    for (const r of ranges) {
      expect(r.min).toBeGreaterThan(1_000);
      expect(r.max).toBeLessThanOrEqual(2_147_483_647);
      expect(Number.isSafeInteger(r.max)).toBe(true);
    }
    for (const a of ranges) {
      for (const b of ranges) {
        if (a.suite === b.suite) continue;
        expect(a.max < b.min || b.max < a.min, `${a.suite} overlaps ${b.suite}`).toBe(true);
      }
    }
  });

  it('U2-P2B-02 the helper refuses an unknown suite and a tag without five leading lowercase hex digits', () => {
    const pos = posFor();
    expect(() => pos('S9', 'abcdef01')).toThrow();
    for (const bad of ['', 'abcd', 'ABCDE123', 'zzzzz123']) expect(() => pos('S5', bad)).toThrow();
  });

  for (const { file, suite } of POS_SUITES) {
    it(`U2-P2B-03 ${file} takes its Location pointOfSaleNumber only from pointOfSaleNumberFor('${suite}', …)`, () => {
      const text = source(file);
      expect(text).toContain(`pointOfSaleNumberFor('${suite}', tag)`);
      expect(text).not.toMatch(/pointOfSaleNumber:\s*\d[\d_]*\s*\+/);
    });
  }
});

// P2-A (U2 review): AuditLog has a uuid id and `timestamp` = now() at ms
// precision; rows written by one transaction share transaction_timestamp(), so
// ORDER BY timestamp does not define their order. The write order inside T-X is
// proven DB-free (S6W-01..04); the PG suites compare audit rows as a multiset and
// only order rows written by DIFFERENT transactions.
describe('R3-A4.3 U2 P2-A — no PG suite relies on the order of same-transaction audit rows', () => {
  for (const { file } of SUITES) {
    it(`U2-P2A-01 ${file} never maps a timestamp-ordered AuditLog list to an exact action sequence`, () => {
      expect(source(file)).not.toMatch(/auditLog\.findMany\([^;]*orderBy:\s*\{\s*timestamp[^;]*\.map\(\s*\(?row\)?\s*=>\s*row\.action\)/s);
    });
  }
});

// PG gate 2026-10-18 (S4, TEST_BUG): no LOCAL_TEST baseline creates a
// CompanyPricingConfig, so a suite whose T-R needs a TRANSFER/CARD_DEBIT price
// must guarantee its own (as P38-03 does); otherwise it passes or fails
// depending on which suite ran first on the cluster.
describe('R3-A4.3 PG gate — every PG suite guarantees its own pricing configuration', () => {
  for (const { file } of POS_SUITES) {
    it(`U2-PRC-01 ${file} upserts the oldest company's CompanyPricingConfig in its fixture`, () => {
      expect(source(file)).toMatch(/companyPricingConfig\.upsert\(\{\s*where: \{ companyId: company\.id \}/);
    });
  }
});

// PG gate 2026-10-18 (S5PG-02, TEST_BUG): PostgreSQL orders an enum column by
// its DECLARATION order (PaymentMethod: CASH, TRANSFER, CARD_DEBIT, ...), not
// alphabetically as the DB-free double does. A PG suite sorts by method name
// explicitly in JS instead of relying on ORDER BY over the enum.
describe('R3-A4.3 PG gate — no PG suite orders by the PaymentMethod enum', () => {
  for (const { file } of POS_SUITES) {
    it(`U2-ORD-01 ${file} never uses orderBy: { method: … }`, () => {
      expect(source(file)).not.toMatch(/orderBy:\s*\{\s*method\s*:/);
    });
  }
});

// PG gate 2026-10-18 (S6PG-01, TEST_BUG): the HTTP DTO (dto/checkout-close.dto.ts)
// requires `evidence` on every non-NONE declaration row, and chk_declaration_shape
// enforces it for CHARGED/RETURNED. A service-level PG case must send only
// requests the DTO would accept.
describe('R3-A4.3 PG gate — T-X PG declarations respect the HTTP DTO', () => {
  for (const file of ['checkout-close.pg.test.ts', 'checkout-recovery-reservation.pg.test.ts']) {
    const rows = () => source(file).match(/d\('(?:CASH|TRANSFER|CARD_DEBIT)', \{[^}]*outcome: '(?:CHARGED|RETURNED)'[^}]*\}\)/g) ?? [];
    it(`U2-DTO-01 every CHARGED/RETURNED declaration row in ${file} carries evidence`, () => {
      expect(rows().length).toBeGreaterThan(0);
      for (const row of rows()) expect(row, row).toMatch(/evidence: '/);
    });
    it(`U2-DTO-02 no CARD_DEBIT declaration row in ${file} carries an institution (the DTO refuses it)`, () => {
      for (const row of rows().filter((r) => r.startsWith("d('CARD_DEBIT'"))) expect(row, row).not.toMatch(/institution/);
    });
  }
});

// PG gate 2026-10-18 (Suite B, HARNESS_BUG): pg_type.typtype and pg_class.relkind
// are the internal "char" type; `text || "char"` has no unique operator on
// PostgreSQL 17 (SQLSTATE 42725). The P21 catalog snapshot casts them to text.
describe('R3-A4.3 PG gate — the P21 catalog snapshot SQL is valid on PostgreSQL 17', () => {
  it('U2-P21-SQL-01 every "char" catalog column concatenated in CATALOG_SNAPSHOT_SQL is cast to text', () => {
    const text = source('r3-attempts-schema.pg.test.ts');
    const sql = text.slice(text.indexOf('const CATALOG_SNAPSHOT_SQL'), text.indexOf('async function snapshot('));
    expect(sql.length).toBeGreaterThan(100);
    for (const column of ['t.typtype', 'c.relkind']) {
      expect(sql).toContain(`${column}::text`);
      expect(sql).not.toMatch(new RegExp(`${column.replace('.', '\\.')}(?!::text)\\b`));
    }
  });
});

// PILOT CM (2026-10-18): the opt-in cash-movement PostgreSQL suite follows the
// same gating discipline as the R3-U2 suites. DB-free; reads the source only.
describe('PILOT CM — the opt-in cash-movement PostgreSQL suite follows the R3-U2 gating discipline', () => {
  it('CM-S01 is opt-in and fails closed on the disposable acknowledgement, the LOCAL_TEST selector and the cluster binding', () => {
    expect(cashMovementSource).toContain("process.env.MONA_CASH_MOVEMENTS_PG === '1'");
    expect(cashMovementSource).toContain("process.env.MONA_CASH_MOVEMENTS_PG_DISPOSABLE !== '1'");
    expect(cashMovementSource).toContain("process.env.MONA_TEST_DATABASE_TARGET !== 'local'");
    expect(cashMovementSource).toMatch(/PG_SYSTEM_ID\.test\(/);
    expect(cashMovementSource).toContain('pg_control_system()');
    expect(cashMovementSource).toMatch(/system_id !== expectedSystemId/);
  });

  it('CM-S02 uses the canonical proven LOCAL_TEST pool opener and the shared pure helper', () => {
    expect(cashMovementSource).toMatch(/const \{ pool \} = await openProvenLocalTestPool\(/);
    expect(cashMovementSource).toContain("await import('../../scripts/demo-database.js')");
    expect(cashMovementSource).toMatch(/from '\.\.\/helpers\/r3-service-pg\.js'/);
    expect(cashMovementSource).toContain("pointOfSaleNumberFor('CM', tag)");
    expect(cashMovementSource).toContain('holdRowLock(');
    expect(cashMovementSource).toContain('waitForBlocked(');
  });

  it('CM-S03 never reads a database URL or password itself and never shells out', () => {
    expect(cashMovementSource).not.toMatch(/PGPASSWORD/);
    expect(cashMovementSource).not.toMatch(/child_process|\bexecSync\b|\bspawnSync\b|\bsh -c\b/);
    expect(cashMovementSource).not.toMatch(/process\.env\.LOCAL_TEST_DATABASE_URL/);
    expect(cashMovementSource).not.toMatch(/process\.env\[['"]LOCAL_TEST_DATABASE_URL/);
  });

  it('CM-S04 the CM pointOfSaleNumber range is disjoint from every R3 suite range and fits a PostgreSQL INTEGER', () => {
    const pos = servicePgHelper.pointOfSaleNumberFor as (suite: string, tag: string) => number;
    const cmMin = pos('CM', '00000000');
    const cmMax = pos('CM', 'ffffffff');
    expect(cmMin).toBeGreaterThan(pos('S7RR', 'ffffffff'));
    expect(cmMax).toBeLessThanOrEqual(2_147_483_647);
    expect(Number.isSafeInteger(cmMax)).toBe(true);
    for (const suite of ['S4', 'SREF', 'S5', 'S6', 'S7', 'S7RR'] as const) {
      expect(cmMin > pos(suite, 'ffffffff') || pos(suite, '00000000') > cmMax, `CM overlaps ${suite}`).toBe(true);
    }
  });
});
