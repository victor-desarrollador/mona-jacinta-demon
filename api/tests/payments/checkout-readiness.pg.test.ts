// R3-A4.3 S9 — the startup readiness gate against a REAL PostgreSQL. OPT-IN
// ONLY, never part of an ordinary run.
//
// Requires an OWNER-authorized, DISPOSABLE, isolated LOCAL_TEST cluster bound by
// marker + pg_control_system().system_identifier (the approved R3 PG gate):
//
//   Suite M9 — a cluster with the FULL applied prefix through migration 9
//     (clusters A/C of the R3 PG gate), run with:
//       MONA_R3_S9_PG=1 MONA_R3_S9_PG_DISPOSABLE=1 MONA_TEST_DATABASE_TARGET=local
//       LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//       MONA_R3_PG_SYSTEM_ID=<that cluster's system_identifier>
//
//   Suite PRE9 — a cluster with the ledger through migration 8 only, NO 9
//     (clusters B/D of the R3 PG gate), run with the same variables plus:
//       MONA_R3_S9_PRE9_PG=1 MONA_R3_S9_PRE9_PG_DISPOSABLE=1
//
// Writes: NONE persist. Every ledger/catalog fixture runs inside ONE
// transaction that is ALWAYS rolled back (a deleted ledger row, an unfinished or
// rolled-back attempt, a drifted checksum and RENAME'd objects all vanish on
// ROLLBACK), so no case can contaminate the next. The read-only case runs inside
// BEGIN READ ONLY and therefore fails if the gate ever issued a write.
//
// What only PostgreSQL can prove: that the module's own ledger/catalog SQL text
// is accepted by the server, that the ledger classification matches the REAL
// _prisma_migrations rows and the REAL pg_catalog, that the startup gate keeps
// the socket closed on an incomplete schema, and that two independent readers
// agree (idempotence) with no locks taken.
import type { Pool, PoolClient } from 'pg';
import { Pool as PgPool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import {
  READINESS_CATALOG_OBJECTS,
  R3ReadinessError,
  assertR3Ready,
  createPrismaR3ReadinessClient,
  type R3Features,
  type R3ReadinessClient,
  type R3ReadinessReason,
} from '../../src/modules/payments/checkout-readiness.js';
import { openProvenLocalTestPool } from '../../scripts/demo-database.js';

const M8 = '20261016120000_r3_proportional_checkout';
const M9 = '20261016130000_r3_checkout_attempts';
const SHA8 = '217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6';

// PILOT G11 cut-over: the gate is G11-strict (m8–m11). Suite M9 therefore needs a cluster
// with the FULL G11 ledger (the R3-only clusters A/C of the earlier gate no longer read
// READY), and on the 1–8 cluster of Suite PRE9 m9, m10 and m11 are all missing. The R3
// flags are isolated here (cash off); the always-on cash feature is covered DB-free.
const M10 = '20261018120000_cash_movement_withdrawals_expenses';
const M11 = '20261018180000_cash_movement_reversals';
const LOCATION_ON: R3Features = { locationSelectorEnabled: true, externalMethodsEnabled: false, cashMovementsEnabled: false };
const EXTERNAL_ON: R3Features = { locationSelectorEnabled: false, externalMethodsEnabled: true, cashMovementsEnabled: false };
const OFF: R3Features = { locationSelectorEnabled: false, externalMethodsEnabled: false, cashMovementsEnabled: false };

const suiteM9 = process.env.MONA_R3_S9_PG === '1';
const suitePre9 = process.env.MONA_R3_S9_PRE9_PG === '1';

// A minimal Prisma-like `$queryRaw` over a real pg connection. The module's OWN
// SQL text is what reaches the server: the tag is reassembled with $n
// placeholders exactly as a driver would, so this exercises the shipped query
// rather than a re-implementation of it.
type QueryRawTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

function pgQueryRaw(executor: Pool | PoolClient): QueryRawTag {
  return async (strings, ...values) => {
    let text = '';
    for (let index = 0; index < strings.length; index += 1) {
      text += strings[index];
      if (index < values.length) text += `$${index + 1}`;
    }
    const result = await executor.query(text, values as unknown[]);
    return result.rows;
  };
}

function clientOver(executor: Pool | PoolClient): R3ReadinessClient {
  const database = { $queryRaw: pgQueryRaw(executor) } as unknown as Pick<PrismaClient, '$queryRaw'>;
  return createPrismaR3ReadinessClient(database);
}

async function reasonOf(promise: Promise<unknown>): Promise<R3ReadinessError | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof R3ReadinessError) return error;
    throw error;
  }
}

async function openBoundCluster(): Promise<{ pool: Pool; end: () => Promise<void> }> {
  if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
  const expected = process.env.MONA_R3_PG_SYSTEM_ID;
  if (!expected || !/^[1-9][0-9]{15,20}$/.test(expected)) {
    throw new Error('isolated cluster binding is missing: MONA_R3_PG_SYSTEM_ID');
  }
  const { pool } = await openProvenLocalTestPool(4, process.env);
  const { rows } = await pool.query<{ system_id: string }>('SELECT system_identifier::text AS system_id FROM pg_control_system()');
  if (rows[0]?.system_id !== expected) {
    await pool.end();
    throw new Error('isolated PostgreSQL cluster does not match binding');
  }
  return { pool, end: () => pool.end() };
}

// Runs `fn` inside ONE transaction that is always rolled back, so any fixture it
// applied is gone afterwards.
async function withRollback<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }
}

type Verdict = { reason: R3ReadinessReason; migrations: readonly string[]; objects: readonly string[] };

async function verdictOf(executor: Pool | PoolClient, features: R3Features): Promise<Verdict | 'READY'> {
  const error = await reasonOf(assertR3Ready(clientOver(executor), features));
  if (error === null) return 'READY';
  return { reason: error.reason, migrations: error.migrations, objects: error.objects };
}

// The dist/server.js import needs a valid parsed environment. In the PG gate run
// only NODE_ENV/TEST_DATABASE_URL are supplied, so the remaining non-secret
// variables are synthesized here (never a real target: DATABASE_URL is .invalid).
async function loadStartServer() {
  process.env.DATABASE_URL ??= 'postgresql://s9-synthetic:never-used@database-url-disabled-in-tests.invalid:5432/postgres';
  process.env.JWT_SECRET ??= 's9-synthetic-test-secret-not-for-real-auth-0123456789';
  process.env.JWT_ACCESS_TTL_SECONDS ??= '900';
  process.env.CORS_ORIGINS ??= 'http://localhost:5173';
  const module = await import('../../src/server.js');
  return module.startServer;
}

const noopLogger = { info: () => undefined, error: () => undefined };

describe.skipIf(!suiteM9)('R3-A4.3 S9 — readiness gate on a real 1–9 cluster (disposable LOCAL_TEST)', () => {
  let pool: Pool;
  let end: () => Promise<void>;

  beforeAll(async () => {
    if (process.env.MONA_R3_S9_PG_DISPOSABLE !== '1') throw new Error('MONA_R3_S9_PG_DISPOSABLE=1 is required (disposable cluster)');
    ({ pool, end } = await openBoundCluster());
  }, 60_000);

  afterAll(async () => {
    await end?.();
  });

  it('S9-PG-01 a fully migrated cluster is READY and the real catalog probe finds every object', async () => {
    const snapshot = await clientOver(pool).readSnapshot();
    expect(snapshot.ledger.filter((row) => row.migration_name === M8)).toEqual([
      { migration_name: M8, checksum: SHA8, finished: true, rolled_back: false },
    ]);
    expect(snapshot.ledger.find((row) => row.migration_name === M9)?.finished).toBe(true);
    try {
      for (const name of READINESS_CATALOG_OBJECTS) expect(snapshot.objects[name], name).toBe(true);
    } catch (error) {
      // Failure-path diagnostic part 3: capture the module's own probe statement exactly as
      // the pg bridge reconstructs and binds it, and verify each column's parameter against
      // the reviewed pin. Schema text only; the connection is never described.
      const captured: Array<{ text: string; values: unknown[] }> = [];
      const recording = {
        $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
          captured.push({ text: strings.join('$'), values });
          return pgQueryRaw(pool)(strings, ...values);
        },
      } as unknown as Pick<PrismaClient, '$queryRaw'>;
      const snap2 = await createPrismaR3ReadinessClient(recording).readSnapshot();
      if (captured.length === 2) {
        const probe = captured[1]!;
        console.log('S9_PROBE_TEXT', JSON.stringify(probe.text));
        console.log('S9_PROBE_VALUES', JSON.stringify(probe.values));
        void snap2;
      } else {
        console.log('S9_PROBE_CAPTURE_MISSED', JSON.stringify(captured.length));
      }
      throw error;
    }
    expect(snapshot.ledger.filter((row) => row.migration_name === M10 || row.migration_name === M11).length).toBe(2);
    expect(await verdictOf(pool, LOCATION_ON)).toBe('READY');
    expect(await verdictOf(pool, EXTERNAL_ON)).toBe('READY');
  }, 30_000);

  it('S9-PG-02 ledger 1–7 (both R3 rows absent) is rejected as MIGRATION_MISSING', async () => {
    const verdict = await withRollback(pool, async (client) => {
      await client.query('DELETE FROM "_prisma_migrations" WHERE "migration_name" = ANY($1::text[])', [[M8, M9]]);
      return verdictOf(client, LOCATION_ON);
    });
    expect(verdict).toEqual({ reason: 'MIGRATION_MISSING', migrations: [M8, M9], objects: [] });
  }, 30_000);

  it('S9-PG-03 ledger 1–8 (no migration 9) is rejected — m9-strict', async () => {
    const verdict = await withRollback(pool, async (client) => {
      await client.query('DELETE FROM "_prisma_migrations" WHERE "migration_name" = $1', [M9]);
      return verdictOf(client, LOCATION_ON);
    });
    expect(verdict).toEqual({ reason: 'MIGRATION_MISSING', migrations: [M9], objects: [] });
  }, 30_000);

  it('S9-PG-04 an unfinished migration 9 is rejected as MIGRATION_UNFINISHED', async () => {
    const verdict = await withRollback(pool, async (client) => {
      await client.query('UPDATE "_prisma_migrations" SET "finished_at" = NULL WHERE "migration_name" = $1', [M9]);
      return verdictOf(client, LOCATION_ON);
    });
    expect(verdict).toEqual({ reason: 'MIGRATION_UNFINISHED', migrations: [M9], objects: [] });
  }, 30_000);

  it('S9-PG-05 a rolled-back migration 9 is rejected as MIGRATION_ROLLED_BACK', async () => {
    const verdict = await withRollback(pool, async (client) => {
      await client.query('UPDATE "_prisma_migrations" SET "finished_at" = NULL, "rolled_back_at" = now() WHERE "migration_name" = $1', [M9]);
      return verdictOf(client, LOCATION_ON);
    });
    expect(verdict).toEqual({ reason: 'MIGRATION_ROLLED_BACK', migrations: [M9], objects: [] });
  }, 30_000);

  it('S9-PG-06 a drifted checksum is rejected as MIGRATION_CHECKSUM_DRIFT', async () => {
    const verdict = await withRollback(pool, async (client) => {
      await client.query('UPDATE "_prisma_migrations" SET "checksum" = repeat(\'0\', 64) WHERE "migration_name" = $1', [M9]);
      return verdictOf(client, LOCATION_ON);
    });
    expect(verdict).toEqual({ reason: 'MIGRATION_CHECKSUM_DRIFT', migrations: [M9], objects: [] });
  }, 30_000);

  it('S9-PG-07 a valid ledger but a missing required TABLE is rejected as SCHEMA_OBJECT_MISSING', async () => {
    const verdict = await withRollback(pool, async (client) => {
      await client.query('ALTER TABLE "CheckoutAttempt" RENAME TO "CheckoutAttempt__s9_absent"');
      return verdictOf(client, LOCATION_ON);
    });
    // G11-ADV-004: a dropped table also takes its bound triggers with it, so the gate
    // names the table AND both pg_trigger bindings that referenced it.
    expect(verdict).toEqual({ reason: 'SCHEMA_OBJECT_MISSING', migrations: [], objects: [
      'CheckoutAttempt', 'trg_checkout_attempt_guard', 'trg_checkout_attempt_commit_check',
    ] });
  }, 30_000);

  it('S9-PG-08 a valid ledger but a missing required FUNCTION is rejected as SCHEMA_OBJECT_MISSING', async () => {
    const verdict = await withRollback(pool, async (client) => {
      await client.query('ALTER FUNCTION "fn_external_collection_guard"() RENAME TO "fn_external_collection_guard__s9_absent"');
      return verdictOf(client, LOCATION_ON);
    });
    expect(verdict).toEqual({ reason: 'SCHEMA_OBJECT_MISSING', migrations: [], objects: ['fn_external_collection_guard'] });
  }, 30_000);

  it('S9-PG-09 both R3 flags OFF performs ZERO database queries', async () => {
    let queries = 0;
    const counting: R3ReadinessClient = {
      readSnapshot: async () => {
        queries += 1;
        return clientOver(pool).readSnapshot();
      },
    };
    await expect(assertR3Ready(counting, OFF)).resolves.toBeUndefined();
    expect(queries).toBe(0);
  });

  it('S9-PG-10 the gate issues no write: it succeeds inside BEGIN READ ONLY', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      await expect(assertR3Ready(clientOver(client), LOCATION_ON)).resolves.toBeUndefined();
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 30_000);

  it('S9-PG-11 two independent concurrent readers agree (idempotent, no locks)', async () => {
    const [first, second] = await Promise.all([verdictOf(pool, LOCATION_ON), verdictOf(pool, EXTERNAL_ON)]);
    expect(first).toBe('READY');
    expect(second).toBe('READY');
  }, 30_000);

  it('S9-PG-12 an unreachable target fails closed as DATABASE_UNREACHABLE with no credential in the error', async () => {
    const dead = new PgPool({
      host: '127.0.0.1',
      port: 1,
      database: 'mona_local_test',
      user: 's9_probe',
      password: 's9-not-a-real-password',
      max: 1,
      connectionTimeoutMillis: 2_000,
    });
    dead.on('error', () => undefined);
    try {
      const error = await reasonOf(assertR3Ready(clientOver(dead), LOCATION_ON));
      expect(error?.reason).toBe('DATABASE_UNREACHABLE');
      expect(error?.code).toBe('R3_DATABASE_NOT_READY');
      const rendered = `${error?.message ?? ''}`;
      expect(rendered).not.toContain('s9-not-a-real-password');
      expect(rendered).not.toContain('postgresql://');
    } finally {
      await dead.end();
    }
  }, 30_000);

  it('S9-PG-13 startup: a valid cluster lets listen proceed exactly once', async () => {
    const startServer = await loadStartServer();
    const calls: number[] = [];
    await startServer({
      httpServer: { listen: (port: number, callback: () => void) => { calls.push(port); callback(); return undefined; } },
      env: { API_PORT: 3001 },
      logger: noopLogger,
      assertReady: () => assertR3Ready(clientOver(pool), LOCATION_ON),
    });
    expect(calls).toEqual([3001]);
  }, 30_000);

  it('S9-PG-14 startup: an incomplete schema keeps the socket closed (listen NEVER called)', async () => {
    const startServer2 = await loadStartServer();
    const calls: number[] = [];
    await withRollback(pool, async (client) => {
      await client.query('DELETE FROM "_prisma_migrations" WHERE "migration_name" = $1', [M9]);
      await expect(startServer2({
        httpServer: { listen: (port: number) => { calls.push(port); return undefined; } },
        env: { API_PORT: 3001 },
        logger: noopLogger,
        assertReady: () => assertR3Ready(clientOver(client), LOCATION_ON),
      })).rejects.toBeInstanceOf(R3ReadinessError);
    });
    expect(calls).toEqual([]);
  }, 30_000);

  // G11-ADV-004: the extended cash binding, proven on the real catalog.
  it('S9-PG-15 a weakened re-created CHECK constraint is refused (the reviewed rendering is compared)', async () => {
    const verdict = await withRollback(pool, async (client) => {
      await client.query('ALTER TABLE "CashMovement" DROP CONSTRAINT "chk_cash_movement_exit_amount"');
      await client.query('ALTER TABLE "CashMovement" ADD CONSTRAINT "chk_cash_movement_exit_amount" CHECK (NOT ("type"::text = \'WITHDRAWAL\'::text OR "type"::text = \'EXPENSE\'::text) OR "amount" > -1)');
      await client.query('ALTER TABLE "CashMovement" VALIDATE CONSTRAINT "chk_cash_movement_exit_amount"');
      return verdictOf(client, EXTERNAL_ON);
    });
    expect(verdict).toEqual({ reason: 'SCHEMA_OBJECT_MISSING', migrations: [], objects: ['chk_cash_movement_exit_amount'] });
  }, 30_000);

  it('S9-PG-16 a dropped m9 trigger is refused even though its function and table both exist', async () => {
    const verdict = await withRollback(pool, async (client) => {
      await client.query('DROP TRIGGER "trg_external_collection_guard" ON "ExternalCollection"');
      return verdictOf(client, EXTERNAL_ON);
    });
    expect(verdict).toEqual({ reason: 'SCHEMA_OBJECT_MISSING', migrations: [], objects: ['trg_external_collection_guard'] });
  }, 30_000);

  it('S9-PG-17 a m10/m11 unique index dropped is refused (to_regclass binding)', async () => {
    const verdict = await withRollback(pool, async (client) => {
      await client.query('DROP INDEX "CashMovement_sessionId_idempotencyKey_key"');
      return verdictOf(client, EXTERNAL_ON);
    });
    expect(verdict).toEqual({ reason: 'SCHEMA_OBJECT_MISSING', migrations: [], objects: ['CashMovement_sessionId_idempotencyKey_key'] });
  }, 30_000);
});

describe.skipIf(!suitePre9)('R3-A4.3 S9 — m9-strict rejection on a real 1–8 cluster (disposable LOCAL_TEST)', () => {
  let pool: Pool;
  let end: () => Promise<void>;

  beforeAll(async () => {
    if (process.env.MONA_R3_S9_PRE9_PG_DISPOSABLE !== '1') throw new Error('MONA_R3_S9_PRE9_PG_DISPOSABLE=1 is required (disposable cluster)');
    ({ pool, end } = await openBoundCluster());
  }, 60_000);

  afterAll(async () => {
    await end?.();
  });

  it('S9-PG-20 a real ledger 1–8 has no migration 9 and is rejected as MIGRATION_MISSING', async () => {
    const snapshot = await clientOver(pool).readSnapshot();
    expect(snapshot.ledger.map((row) => row.migration_name)).toEqual([M8]);
    expect(await verdictOf(pool, LOCATION_ON)).toEqual({ reason: 'MIGRATION_MISSING', migrations: [M9, M10, M11], objects: [] });
  }, 30_000);

  it('S9-PG-21 startup on a real 1–8 cluster keeps the socket closed (listen NEVER called)', async () => {
    const startServer = await loadStartServer();
    const calls: number[] = [];
    await expect(startServer({
      httpServer: { listen: (port: number) => { calls.push(port); return undefined; } },
      env: { API_PORT: 3001 },
      logger: noopLogger,
      assertReady: () => assertR3Ready(clientOver(pool), EXTERNAL_ON),
    })).rejects.toBeInstanceOf(R3ReadinessError);
    expect(calls).toEqual([]);
  }, 30_000);
});
