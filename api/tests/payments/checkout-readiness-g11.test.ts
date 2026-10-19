// PILOT G11 cut-over — S9 G11 STRICT (OWNER 2026-10-18). DB-FREE ONLY (injected client).
//
// Feature dependencies, from the real code: the cash movement routes (exits, reversals,
// history) are registered unconditionally, and openSession/closeSession/listMovements read
// and write the m10/m11 CashMovement columns — so in this release the cash feature is
// always on and the API must never start on a database that has m8/m9 but not m10/m11.
// When the gate runs it is G11-strict: m8, m9, m10 and m11, exact names and checksums,
// finished, never rolled back, one clean row each, plus a bounded catalog probe. With every
// feature off (only reachable by injection) it reads nothing. No retries.
//
// PRE-REGISTERED EXPECTATIONS:
//   G11-S9-01 the release features always carry cashMovementsEnabled=true, whatever the R3 flags
//   G11-S9-02 any feature on → exactly m8, m9, m10, m11 are required, in order
//   G11-S9-03 every feature off → nothing required and ZERO queries
//   G11-S9-04 m8/m9 present but m10 or m11 missing → MIGRATION_MISSING naming it
//   G11-S9-05 m10/m11 unfinished / rolled back / drifted / duplicated → refused (never READY)
//   G11-S9-06 a missing cash catalog object (column, enum label, unique index, composite FK,
//          SQL-only CHECK, m9 trigger binding) → SCHEMA_OBJECT_MISSING
//   G11-S9-07 the full G11 ledger and catalog → ready
//   G11-S9-08 unreachable database → DATABASE_UNREACHABLE after exactly one read (no retry loop)
import { describe, expect, it, vi } from 'vitest';
import {
  CASH_CATALOG_OBJECTS,
  CASH_CHECK_DEFINITIONS,
  R3_TRIGGER_BINDINGS,
  READINESS_CATALOG_OBJECTS,
  R3ReadinessError,
  assertR3Ready,
  createPrismaR3ReadinessClient,
  evaluateR3Readiness,
  requiredR3Migrations,
  r3FeaturesFromEnv,
  type R3Features,
  type R3LedgerRow,
  type R3ReadinessClient,
} from '../../src/modules/payments/checkout-readiness.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';

const PINS = [
  ['20261016120000_r3_proportional_checkout', '217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6'],
  ['20261016130000_r3_checkout_attempts', '076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148'],
  ['20261018120000_cash_movement_withdrawals_expenses', 'e37149442d1fb82ec87877e7b3e1f2e4311b36a9d47d314a3fd1843702c5adf9'],
  ['20261018180000_cash_movement_reversals', 'd638559da376f5c4fb1f71136027c0af426906b8b8a2c582f388e73ffd1b3770'],
] as const;
const [M8, M9, M10, M11] = PINS.map(([name]) => name);
const row = (i: number, patch: Partial<R3LedgerRow> = {}): R3LedgerRow => ({ migration_name: PINS[i]![0], checksum: PINS[i]![1], finished: true, rolled_back: false, ...patch });
const g11Ledger = (): R3LedgerRow[] => [row(0), row(1), row(2), row(3)];
const catalog = (absent: readonly string[] = []) => Object.fromEntries(READINESS_CATALOG_OBJECTS.map((name) => [name, !absent.includes(name)]));
const CASH_ONLY: R3Features = { locationSelectorEnabled: false, externalMethodsEnabled: false, cashMovementsEnabled: true };
const ALL_OFF: R3Features = { locationSelectorEnabled: false, externalMethodsEnabled: false, cashMovementsEnabled: false };

const env = (ids: string[], external: boolean) => ({ PROPORTIONAL_CHECKOUT_LOCATION_IDS: ids, PROPORTIONAL_EXTERNAL_METHODS_ENABLED: external });

describe('S9 G11 strict — feature dependencies', () => {
  it('G11-S9-01 the release always carries the cash movement feature, whatever the R3 flags', () => {
    for (const [ids, external] of [[[], false], [['loc-1'], false], [[], true], [['loc-1'], true]] as const) {
      expect(r3FeaturesFromEnv(env([...ids], external)).cashMovementsEnabled).toBe(true);
    }
  });

  it('G11-S9-02 any feature on → exactly m8, m9, m10, m11, in order', () => {
    for (const f of [CASH_ONLY, { ...ALL_OFF, locationSelectorEnabled: true }, { ...ALL_OFF, externalMethodsEnabled: true }]) {
      expect(requiredR3Migrations(f).map((p) => [p.name, p.sha256])).toEqual(PINS.map((p) => [...p]));
    }
  });

  it('G11-S9-03 every feature off → nothing required and zero queries', async () => {
    expect(requiredR3Migrations(ALL_OFF)).toEqual([]);
    const readSnapshot = vi.fn();
    await expect(assertR3Ready({ readSnapshot } as R3ReadinessClient, ALL_OFF)).resolves.toBeUndefined();
    expect(readSnapshot).not.toHaveBeenCalled();
  });
});

describe('S9 G11 strict — ledger', () => {
  it('G11-S9-04 m8/m9 present but m10 or m11 missing → MIGRATION_MISSING naming exactly it', () => {
    expect(evaluateR3Readiness({ ledger: [row(0), row(1)], objects: catalog() }, CASH_ONLY)).toMatchObject({ ready: false, reason: 'MIGRATION_MISSING', migrations: [M10, M11] });
    expect(evaluateR3Readiness({ ledger: [row(0), row(1), row(2)], objects: catalog() }, CASH_ONLY)).toMatchObject({ ready: false, reason: 'MIGRATION_MISSING', migrations: [M11] });
    expect(evaluateR3Readiness({ ledger: [row(2), row(3)], objects: catalog() }, CASH_ONLY)).toMatchObject({ ready: false, reason: 'MIGRATION_MISSING', migrations: [M8, M9] });
  });

  it('G11-S9-05 m10/m11 unfinished, rolled back, drifted or duplicated is never READY', () => {
    const verdict = (ledger: R3LedgerRow[]) => evaluateR3Readiness({ ledger, objects: catalog() }, CASH_ONLY);
    expect(verdict([row(0), row(1), row(2), row(3, { finished: false })])).toMatchObject({ reason: 'MIGRATION_UNFINISHED', migrations: [M11] });
    expect(verdict([row(0), row(1), row(2, { finished: false, rolled_back: true }), row(3)])).toMatchObject({ reason: 'MIGRATION_ROLLED_BACK', migrations: [M10] });
    expect(verdict([row(0), row(1), row(2), row(3, { checksum: 'f'.repeat(64) })])).toMatchObject({ reason: 'MIGRATION_CHECKSUM_DRIFT', migrations: [M11] });
    expect(verdict([...g11Ledger(), row(2)])).toMatchObject({ reason: 'MIGRATION_UNFINISHED', migrations: [M10] });
  });
});

describe('S9 G11 strict — catalog and verdict', () => {
  it('G11-S9-06 every cash catalog object is required: one absent → SCHEMA_OBJECT_MISSING naming it', () => {
    // G11-ADV-004: the m10/m11 unique indexes, the six SQL-only CHECKs, and the six
    // m9 trigger bindings joined the columns, enums, FK and reversal index.
    expect(CASH_CATALOG_OBJECTS).toEqual([
      'CashMovement.reason', 'CashMovement.idempotencyKey', 'CashMovement.reversesMovementId',
      'CashMovementType.WITHDRAWAL', 'CashMovementType.EXPENSE', 'CashMovementType.WITHDRAWAL_REVERSAL', 'CashMovementType.EXPENSE_REVERSAL',
      'CashMovement_reversesMovementId_key', 'CashMovement_sessionId_idempotencyKey_key', 'CashMovement_id_sessionId_key',
      'CashMovement_reversesMovementId_sessionId_fkey',
      'chk_cash_movement_exit_amount', 'chk_cash_movement_exit_reason', 'chk_cash_movement_exit_no_payment',
      'chk_cash_movement_reversal_link', 'chk_cash_movement_reversal_shape', 'chk_cash_movement_reversal_not_self',
    ]);
    for (const name of CASH_CATALOG_OBJECTS) {
      expect(evaluateR3Readiness({ ledger: g11Ledger(), objects: catalog([name]) }, CASH_ONLY), name).toMatchObject({ ready: false, reason: 'SCHEMA_OBJECT_MISSING', objects: [name] });
    }
    // G11-ADV-004: an m9 trigger that is absent (or no longer bound to its table — the
    // client resolves the binding and reports the trigger name) is refused too.
    for (const binding of R3_TRIGGER_BINDINGS) {
      expect(evaluateR3Readiness({ ledger: g11Ledger(), objects: catalog([binding.trigger]) }, CASH_ONLY), binding.trigger).toMatchObject({ ready: false, reason: 'SCHEMA_OBJECT_MISSING', objects: [binding.trigger] });
    }
    // The R3 objects stay required too (G11 strict), even with the R3 flags off.
    expect(evaluateR3Readiness({ ledger: g11Ledger(), objects: catalog(['CheckoutAttempt']) }, CASH_ONLY)).toMatchObject({ reason: 'SCHEMA_OBJECT_MISSING' });
  });

  it('G11-S9-07 the full G11 ledger and catalog → ready (and m8/m9 alone never are)', async () => {
    expect(evaluateR3Readiness({ ledger: g11Ledger(), objects: catalog() }, CASH_ONLY)).toEqual({ ready: true });
    const client = { readSnapshot: vi.fn(async () => ({ ledger: g11Ledger(), objects: catalog() })) };
    await expect(assertR3Ready(client, CASH_ONLY)).resolves.toBeUndefined();
    const g9 = { readSnapshot: vi.fn(async () => ({ ledger: [row(0), row(1)], objects: catalog() })) };
    await expect(assertR3Ready(g9, CASH_ONLY)).rejects.toBeInstanceOf(R3ReadinessError);
  });

  it('G11-S9-08 unreachable database → DATABASE_UNREACHABLE after exactly one read, never retried', async () => {
    const readSnapshot = vi.fn(async () => { throw new Error('connect ECONNREFUSED postgresql://user:secret@host/db'); });
    const error = await assertR3Ready({ readSnapshot }, CASH_ONLY).then(() => null, (e: unknown) => e as R3ReadinessError);
    expect(error).toBeInstanceOf(R3ReadinessError);
    expect(error?.reason).toBe('DATABASE_UNREACHABLE');
    expect(String(error?.message)).not.toMatch(/secret|ECONNREFUSED/);
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });
});

// G11-ADV-004 — the REAL client's probe, pinned DB-free by capturing the tagged
// template. What only PostgreSQL can prove (that the server accepts the text and
// that the real catalog answers every subquery) stays in the opt-in PG suite;
// here the construction is pinned: two statements, the ledger first, every CHECK
// compared against its reviewed rendering, every trigger bound to its exact
// table, and the composite FK bound to its column pairs and RESTRICT/RESTRICT
// SIMPLE actions.
type CapturedCall = { text: string; values: unknown[] };

function captureRaw(): { raw: Pick<PrismaClient, '$queryRaw'>; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const raw = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('$'), values });
    return Promise.resolve(calls.length === 1 ? [] : [{}]);
  }) as unknown as unknown;
  return { raw: { $queryRaw: raw } as unknown as Pick<PrismaClient, '$queryRaw'>, calls };
}

describe('S9 G11 strict — real client probe construction (G11-ADV-004)', () => {
  it('exactly two statements; the ledger is first, its single parameter is the four G11 names', async () => {
    const { raw, calls } = captureRaw();
    const client = createPrismaR3ReadinessClient(raw);
    await client.readSnapshot();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toContain('_prisma_migrations');
    expect(calls[0]!.text).not.toContain('pg_get_constraintdef');
    expect(calls[0]!.values[0]).toEqual(PINS.map(([name]) => name));
  });

  it('every reviewed CHECK is compared server-side against its exact reviewed rendering', async () => {
    const { raw, calls } = captureRaw();
    await createPrismaR3ReadinessClient(raw).readSnapshot();
    const probe = calls[1]!;
    for (const pin of CASH_CHECK_DEFINITIONS) {
      expect(probe.text, pin.name).toContain(`c.conname = '${pin.name}'`);
      expect(probe.text, pin.name).toContain(`AS "${pin.name}"`);
      expect(probe.text, pin.name).toContain('pg_get_constraintdef');
      const normalized = pin.definition.replace(/\s+/g, ' ').trim();
      expect(probe.values, pin.name).toContain(normalized);
    }
    expect(CASH_CHECK_DEFINITIONS.map((pin) => pin.name)).toEqual([
      'chk_cash_movement_exit_amount', 'chk_cash_movement_exit_reason', 'chk_cash_movement_exit_no_payment',
      'chk_cash_movement_reversal_link', 'chk_cash_movement_reversal_shape', 'chk_cash_movement_reversal_not_self',
    ]);
  });

  it('every m9 trigger is bound to its exact table and never reads internal triggers', async () => {
    const { raw, calls } = captureRaw();
    await createPrismaR3ReadinessClient(raw).readSnapshot();
    const probe = calls[1]!;
    for (const binding of R3_TRIGGER_BINDINGS) {
      expect(probe.text, binding.trigger).toContain(
        `t.tgrelid = to_regclass('public."${binding.table}"') AND t.tgname = '${binding.trigger}' AND NOT t.tgisinternal`,
      );
      expect(probe.text, binding.trigger).toContain(`AS "${binding.trigger}"`);
    }
    expect(R3_TRIGGER_BINDINGS.map((binding) => binding.trigger)).toEqual([
      'trg_checkout_attempt_guard', 'trg_checkout_attempt_tender_guard', 'trg_checkout_attempt_commit_check',
      'trg_checkout_attempt_declaration_guard', 'trg_checkout_declaration_commit_check', 'trg_external_collection_guard',
    ]);
  });

  it('the composite FK is bound to its column pairs, its own table, and RESTRICT/RESTRICT SIMPLE', async () => {
    const { raw, calls } = captureRaw();
    await createPrismaR3ReadinessClient(raw).readSnapshot();
    const probe = calls[1]!;
    expect(probe.text).toContain(`conname = 'CashMovement_reversesMovementId_sessionId_fkey'`);
    expect(probe.text).toContain(`a.attname = 'reversesMovementId'`);
    expect(probe.text).toContain(`a.attname = 'sessionId'`);
    expect(probe.text).toContain(`a.attname = 'id'`);
    expect(probe.text).toContain(`confrelid = to_regclass('public."CashMovement"')`);
    expect(probe.text).toContain(`c.confdeltype = 'r' AND c.confupdtype = 'r' AND c.confmatchtype = 's'`);
  });
});
