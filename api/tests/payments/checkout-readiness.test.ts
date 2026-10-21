// R3-A4.3 S9 — the startup readiness gate. DB-FREE ONLY: no driver, no pool,
// no connection. The real ledger/catalog query is proven by the opt-in
// PostgreSQL suite (checkout-readiness.pg.test.ts); here the gate's ORDER,
// classification, fail-closed behaviour and credential hygiene are pinned with
// an injected client, and the startup wiring is pinned with an injected server.
import { describe, expect, it, vi } from 'vitest';
import {
  R3_CATALOG_OBJECTS,
  READINESS_CATALOG_OBJECTS,
  R3ReadinessError,
  assertR3Ready,
  evaluateR3Readiness,
  requiredR3Migrations,
  r3FeaturesFromEnv,
  type R3Features,
  type R3LedgerRow,
  type R3ReadinessClient,
  type R3ReadinessSnapshot,
} from '../../src/modules/payments/checkout-readiness.js';
import { startServer, startupFailureEntry } from '../../src/server.js';

const M8 = '20261016120000_r3_proportional_checkout';
const M9 = '20261016130000_r3_checkout_attempts';
const SHA8 = '217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6';
const SHA9 = '076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148';

// PILOT G11 cut-over: the gate is G11-strict (m8–m11) whenever any feature is on; the
// cash movement feature is always on at runtime (checkout-readiness-g11.test.ts). These
// R3-focused cases keep it off to isolate the R3 flags.
const M10 = '20261018120000_cash_movement_withdrawals_expenses';
const M11 = '20261018180000_cash_movement_reversals';
const SHA10 = 'e37149442d1fb82ec87877e7b3e1f2e4311b36a9d47d314a3fd1843702c5adf9';
const SHA11 = 'd638559da376f5c4fb1f71136027c0af426906b8b8a2c582f388e73ffd1b3770';
// CARD_CREDIT block: the gate is G12 (m8–m12); m12 is the additive CARD_CREDIT migration.
const M12 = '20261021120000_r3_card_credit';
const SHA12 = 'ccec6685120cc9236c5c95a57f2922dc5bbe09cf759ff21b4c9a3635d893f6be';
// WAREHOUSE-MVP: the gate is G13 (m8–m13); m13 is the additive stock-adjustment migration.
const M13 = '20261021130000_warehouse_stock_adjustment';
const SHA13 = '819d669933639173e1b21879791c14eb3cced33c0d8417ca30dd07800fb252c0';
const OFF: R3Features = { locationSelectorEnabled: false, externalMethodsEnabled: false, cashMovementsEnabled: false };
const LOCATION_ON: R3Features = { locationSelectorEnabled: true, externalMethodsEnabled: false, cashMovementsEnabled: false };
const EXTERNAL_ON: R3Features = { locationSelectorEnabled: false, externalMethodsEnabled: true, cashMovementsEnabled: false };

const applied = (migration_name: string, checksum: string): R3LedgerRow => ({ migration_name, checksum, finished: true, rolled_back: false });
const CASH_APPLIED = (): R3LedgerRow[] => [applied(M10, SHA10), applied(M11, SHA11), applied(M12, SHA12), applied(M13, SHA13)];
const completeLedger = (): R3LedgerRow[] => [applied(M8, SHA8), applied(M9, SHA9), ...CASH_APPLIED()];

// Every required object present unless the caller removes some.
function objects(absent: readonly string[] = []): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const name of READINESS_CATALOG_OBJECTS) map[name] = !absent.includes(name);
  return map;
}

const snapshot = (ledger: readonly R3LedgerRow[], absent: readonly string[] = []): R3ReadinessSnapshot => ({ ledger, objects: objects(absent) });

// A client whose readSnapshot resolves the given snapshot, or rejects.
function clientOf(result: R3ReadinessSnapshot | Error): { client: R3ReadinessClient; calls: () => number } {
  const spy = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { client: { readSnapshot: spy }, calls: () => spy.mock.calls.length };
}

async function reasonOf(promise: Promise<unknown>): Promise<{ code: string; reason: string; migrations: readonly string[]; objects: readonly string[] } | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof R3ReadinessError) {
      return { code: error.code, reason: error.reason, migrations: error.migrations, objects: error.objects };
    }
    throw error;
  }
}

describe('R3-A4.3 S9 — feature detection and required migrations', () => {
  it('S9-01 both flags OFF: no R3 database is required and the gate never queries', async () => {
    expect(requiredR3Migrations(OFF)).toEqual([]);
    const { client, calls } = clientOf(new Error('must never be called'));
    await expect(assertR3Ready(client, OFF)).resolves.toBeUndefined();
    expect(calls()).toBe(0);
  });

  it('S9-02 location selector ON: migrations 8, 9, 10, 11, 12 and 13 are required (G13 strict)', () => {
    expect(requiredR3Migrations(LOCATION_ON).map((pin) => pin.name)).toEqual([M8, M9, M10, M11, M12, M13]);
  });

  it('S9-03 external methods ON: migrations 8, 9, 10, 11, 12 and 13 are required (G13 strict)', () => {
    expect(requiredR3Migrations(EXTERNAL_ON).map((pin) => pin.name)).toEqual([M8, M9, M10, M11, M12, M13]);
  });

  it('derives the features from the parsed environment exactly as the runtime does', () => {
    // The cash movement features ship with this release: never off at runtime.
    expect(r3FeaturesFromEnv({ PROPORTIONAL_CHECKOUT_LOCATION_IDS: [], PROPORTIONAL_EXTERNAL_METHODS_ENABLED: false })).toEqual({ ...OFF, cashMovementsEnabled: true });
    expect(r3FeaturesFromEnv({ PROPORTIONAL_CHECKOUT_LOCATION_IDS: ['x'], PROPORTIONAL_EXTERNAL_METHODS_ENABLED: false }).locationSelectorEnabled).toBe(true);
    expect(r3FeaturesFromEnv({ PROPORTIONAL_CHECKOUT_LOCATION_IDS: [], PROPORTIONAL_EXTERNAL_METHODS_ENABLED: true }).externalMethodsEnabled).toBe(true);
  });
});

describe('R3-A4.3 S9 — ledger classification', () => {
  it('S9-04 migration 8 missing: MIGRATION_MISSING', async () => {
    const ledger = [applied(M9, SHA9), ...CASH_APPLIED()];
    const verdict = evaluateR3Readiness(snapshot(ledger), LOCATION_ON);
    expect(verdict).toMatchObject({ ready: false, reason: 'MIGRATION_MISSING', migrations: [M8] });
    const viaAssert = await reasonOf(assertR3Ready(clientOf(snapshot(ledger)).client, LOCATION_ON));
    expect(viaAssert).toMatchObject({ code: 'R3_DATABASE_NOT_READY', reason: 'MIGRATION_MISSING', migrations: [M8] });
  });

  it('S9-05 migration 9 missing: MIGRATION_MISSING', async () => {
    expect(evaluateR3Readiness(snapshot([applied(M8, SHA8), ...CASH_APPLIED()]), LOCATION_ON)).toMatchObject({ ready: false, reason: 'MIGRATION_MISSING', migrations: [M9] });
  });

  it('S9-06 migration 9 unfinished: MIGRATION_UNFINISHED', () => {
    const ledger = [applied(M8, SHA8), { migration_name: M9, checksum: SHA9, finished: false, rolled_back: false }, ...CASH_APPLIED()];
    expect(evaluateR3Readiness(snapshot(ledger), LOCATION_ON)).toMatchObject({ ready: false, reason: 'MIGRATION_UNFINISHED', migrations: [M9] });
  });

  it('S9-07 migration 9 rolled back: MIGRATION_ROLLED_BACK', () => {
    const ledger = [applied(M8, SHA8), { migration_name: M9, checksum: SHA9, finished: false, rolled_back: true }, ...CASH_APPLIED()];
    expect(evaluateR3Readiness(snapshot(ledger), LOCATION_ON)).toMatchObject({ ready: false, reason: 'MIGRATION_ROLLED_BACK', migrations: [M9] });
  });

  it('S9-08 checksum mismatch on migration 9: MIGRATION_CHECKSUM_DRIFT', () => {
    const ledger = [applied(M8, SHA8), applied(M9, '0'.repeat(64)), ...CASH_APPLIED()];
    expect(evaluateR3Readiness(snapshot(ledger), LOCATION_ON)).toMatchObject({ ready: false, reason: 'MIGRATION_CHECKSUM_DRIFT', migrations: [M9] });
  });

  it('empty ledger is MIGRATION_MISSING for every required migration', () => {
    expect(evaluateR3Readiness(snapshot([]), LOCATION_ON)).toMatchObject({ ready: false, reason: 'MIGRATION_MISSING', migrations: [M8, M9, M10, M11, M12, M13] });
  });

  it('a rolled-back attempt followed by a clean applied attempt is ready', () => {
    const ledger = [applied(M8, SHA8), { migration_name: M9, checksum: SHA9, finished: false, rolled_back: true }, applied(M9, SHA9), ...CASH_APPLIED()];
    expect(evaluateR3Readiness(snapshot(ledger), LOCATION_ON)).toEqual({ ready: true });
  });
});

describe('R3-A4.3 S9 — catalog probe', () => {
  it('S9-09 a required schema object absent: SCHEMA_OBJECT_MISSING', async () => {
    const verdict = evaluateR3Readiness(snapshot(completeLedger(), ['CheckoutAttempt']), LOCATION_ON);
    expect(verdict).toMatchObject({ ready: false, reason: 'SCHEMA_OBJECT_MISSING', objects: ['CheckoutAttempt'] });
    const viaAssert = await reasonOf(assertR3Ready(clientOf(snapshot(completeLedger(), ['fn_external_collection_guard'])).client, LOCATION_ON));
    expect(viaAssert).toMatchObject({ reason: 'SCHEMA_OBJECT_MISSING', objects: ['fn_external_collection_guard'] });
  });

  it('a valid ledger but a missing m9 function is not READY (partial migration is caught)', () => {
    expect(R3_CATALOG_OBJECTS).toEqual(expect.arrayContaining([
      'SaleCheckout', 'ExternalCollection', 'CheckoutAttempt', 'CheckoutAttemptTender',
      'fn_checkout_attempt_guard', 'fn_external_collection_guard',
    ]));
  });
});

describe('R3-A4.3 S9 — fail closed', () => {
  it('S9-10 the snapshot read throws or times out: DATABASE_UNREACHABLE', async () => {
    const error = await reasonOf(assertR3Ready(clientOf(new Error('connection refused')).client, LOCATION_ON));
    expect(error).toMatchObject({ code: 'R3_DATABASE_NOT_READY', reason: 'DATABASE_UNREACHABLE' });
  });

  it('S9-11 a complete, valid ledger and catalog: ready', async () => {
    expect(evaluateR3Readiness(snapshot(completeLedger()), LOCATION_ON)).toEqual({ ready: true });
    await expect(assertR3Ready(clientOf(snapshot(completeLedger())).client, EXTERNAL_ON)).resolves.toBeUndefined();
  });

  it('S9-14 the failure carries a stable code, a closed reason and never the driver error', async () => {
    const secret = 'postgresql://mona:sup3r-s3cret@db.internal:5432/prod';
    const error = await reasonOf(assertR3Ready(clientOf(new Error(secret)).client, LOCATION_ON));
    expect(error).toMatchObject({ code: 'R3_DATABASE_NOT_READY', reason: 'DATABASE_UNREACHABLE' });
    const rendered = JSON.stringify(error);
    expect(rendered).not.toContain('sup3r-s3cret');
    expect(rendered).not.toContain('postgresql://');
    expect(rendered).not.toContain('DATABASE_URL');
    expect(error!.migrations).toEqual([]);
    expect(error!.objects).toEqual([]);
  });
});

describe('R3-A4.3 S9 — startup wiring (before listen)', () => {
  const logger = () => ({ info: vi.fn(), error: vi.fn() });

  it('S9-12 a failed gate: listen is NEVER called', async () => {
    const listen = vi.fn();
    const log = logger();
    const failure = new R3ReadinessError('MIGRATION_MISSING', { migrations: [M9] });
    await expect(startServer({
      httpServer: { listen },
      env: { API_PORT: 3001 },
      logger: log,
      assertReady: () => Promise.reject(failure),
    })).rejects.toBe(failure);
    expect(listen).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('S9-13 a successful gate: listen proceeds exactly once and logs server_started', async () => {
    const listen = vi.fn((_port: number, callback: () => void) => { callback(); return undefined; });
    const log = logger();
    const onListening = vi.fn();
    await startServer({
      httpServer: { listen },
      env: { API_PORT: 3001 },
      logger: log,
      assertReady: () => Promise.resolve(),
      onListening,
    });
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen.mock.calls[0]![0]).toBe(3001);
    expect(log.info).toHaveBeenCalledWith({ event: 'server_started', port: 3001 });
    expect(onListening).toHaveBeenCalledTimes(1);
  });

  it('S9-14b the startup FAILURE log is a fixed shape and never carries the driver error', () => {
    const gateEntry = startupFailureEntry(new R3ReadinessError('MIGRATION_MISSING', { migrations: [M9] }));
    expect(gateEntry).toEqual({ event: 'r3_startup_gate_failed', code: 'R3_DATABASE_NOT_READY', reason: 'MIGRATION_MISSING', migrations: [M9], objects: [] });
    const driver = new Error('connect ECONNREFUSED postgresql://mona:sup3r-s3cret@db.internal:5432/prod');
    const otherEntry = startupFailureEntry(driver);
    expect(otherEntry).toEqual({ event: 'startup_failed' });
    expect(JSON.stringify([gateEntry, otherEntry])).not.toMatch(/sup3r-s3cret|postgresql:\/\/|db\.internal|DATABASE_URL/i);
  });
});
