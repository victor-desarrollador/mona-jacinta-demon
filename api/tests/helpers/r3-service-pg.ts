// R3-A4.3 U2 — shared helpers for the opt-in SERVICE-LEVEL PostgreSQL suites
// (S5/T-C settlement, S6/T-X close, S7/T-S stock recovery, S7-I/T-RR recovery
// reservation). Everything here is PURE: no database connection, no clock, no
// top-level pool. The `pg` import is TYPE-ONLY, so importing this module never
// loads a database driver, and a DB-free test can import it safely.
//
// What lives here is exactly what all four suites need to prove OVERLAP instead
// of assuming it: holding a row lock on an independent coordinator connection
// and asking PostgreSQL (pg_stat_activity + pg_blocking_pids) until the racing
// backends are genuinely waiting in that coordinator's lock-wait chain. Also the
// canonical Production actors (OWNER / COMPANY ADMIN / CASHIER), so every suite
// builds authority the same way the policy layer evaluates it.
import type { Pool, PoolClient } from 'pg';
import { AppError } from '../../src/shared/errors.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';

// pg_control_system().system_identifier is a decimal uint64; the binding the
// opt-in suites require. Never a hash and never derived from the marker.
export const PG_SYSTEM_ID = /^[1-9][0-9]{15,20}$/;

export const RACE_WAIT_MS = 10_000;
export const RACE_TIMEOUT_MS = 60_000;

// The rows a suite may hold as an overlap coordinator. A closed set, so a table
// name is never interpolated from arbitrary input.
export type LockableTable = 'Sale' | 'CashSession' | 'Inventory' | 'ExternalCollection' | 'CheckoutAttempt' | 'Location';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

// The AppError a rejected service call produced, or null on success. A non-AppError
// is rethrown unchanged: a suite must never mistake an infrastructure failure for
// a domain code.
export async function errorOf(promise: Promise<unknown>): Promise<AppError | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
}

export async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  return (await errorOf(promise))?.code ?? null;
}

// --- canonical Production actors --------------------------------------------
// Built exactly as the policy layer reads them: assignments only, permission and
// scope from the SAME assignment. OWNER: a valid COMPANY assignment with an
// empty permissions array (OWNER authority is implicit). ADMIN: COMPANY scope
// with every catalogued permission (DEFAULT_ROLE_GRANTS.ADMIN), which is what
// `actsAsSupervisorAtLocation` and COMPANY-required permissions demand. CASHIER:
// LOCATION scope at the branch with its own real grants (SALE_CHARGE,
// SALE_COMPLETE, SALE_CORRECT_PENDING, SALE_CANCEL_PENDING).
export type PgRole = 'OWNER' | 'ADMIN' | 'CASHIER';

export function ownerActor(userId: string): unknown {
  return {
    auth: {
      userId, roles: ['OWNER'], effectiveLocationIds: [],
      assignments: [{ roleId: 'OWNER', roleCode: 'OWNER', scopeKind: 'COMPANY', locationId: null, permissions: [] }],
    },
  };
}

export function companyAdminActor(userId: string): unknown {
  return {
    auth: {
      userId, roles: ['ADMIN'], effectiveLocationIds: [],
      assignments: [{ roleId: 'ADMIN', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] }],
    },
  };
}

export function cashierActor(userId: string, branchId: string): unknown {
  return {
    auth: {
      userId, roles: ['CASHIER'], effectiveLocationIds: [branchId],
      assignments: [{ roleId: 'CASHIER', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationId: branchId, permissions: [...DEFAULT_ROLE_GRANTS.CASHIER] }],
    },
  };
}

export function actor(userId: string, role: PgRole, branchId: string | null): unknown {
  if (role === 'OWNER') return ownerActor(userId);
  if (role === 'ADMIN') return companyAdminActor(userId);
  if (branchId === null) throw new Error('a CASHIER actor requires a branchId');
  return cashierActor(userId, branchId);
}

// --- overlap coordination ----------------------------------------------------
// Holds `SELECT id FROM "<table>" WHERE id = $1 FOR UPDATE` on one row, in an
// open transaction on its own connection, until release()/commit(). This is what
// makes a race REAL: the racing services block on this row lock, and
// waitForBlocked() proves the overlap before the coordinator is released.
export async function holdRowLock(pool: Pool, table: LockableTable, id: string): Promise<{
  pid: number;
  // Rolls back and releases. Safe to call more than once.
  release: () => Promise<void>;
  // Optionally runs `mutate` inside the same transaction (so a committed change
  // travels with the row lock's release), then COMMITs and releases. Safe to call
  // more than once; only the first call acts.
  commit: (mutate?: (client: PoolClient) => Promise<void>) => Promise<void>;
}> {
  const client: PoolClient = await pool.connect();
  let finished = false;
  const finish = async (mode: 'ROLLBACK' | 'COMMIT', mutate?: (client: PoolClient) => Promise<void>) => {
    if (finished) return;
    finished = true;
    try {
      if (mode === 'COMMIT' && mutate) await mutate(client);
      await client.query(mode);
    } finally {
      client.release();
    }
  };
  try {
    await client.query('BEGIN');
    await client.query(`SELECT id FROM "${table}" WHERE id = $1 FOR UPDATE`, [id]);
    const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    return {
      pid: rows[0]!.pid,
      release: () => finish('ROLLBACK'),
      commit: (mutate) => finish('COMMIT', mutate),
    };
  } catch (error) {
    finished = true;
    client.release(true);
    throw error;
  }
}

// Polls until at least `count` backends are genuinely waiting in the lock-wait
// chain rooted at `holderPid`, each on a statement matching `statement`. A pool
// wait (no backend at all) or a wait on another backend is never counted, so a
// "race" that never overlapped fails loudly instead of passing by accident.
export async function waitForBlocked(pool: Pool, holderPid: number, count: number, statement: RegExp): Promise<unknown[]> {
  const deadline = Date.now() + RACE_WAIT_MS;
  let last: unknown[] = [];
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{
      pid: number; blockers: number[]; wait_event_type: string | null; wait_event: string | null; query: string;
    }>(
      `SELECT pid, pg_blocking_pids(pid) AS blockers, wait_event_type, wait_event, query
         FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`,
    );
    const chain = new Set<number>([holderPid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const row of rows) {
        if (!chain.has(row.pid) && row.blockers.some((blocker) => chain.has(blocker))) {
          chain.add(row.pid);
          grew = true;
        }
      }
    }
    const waiting = rows.filter((row) => row.pid !== holderPid && chain.has(row.pid)
      && row.wait_event_type === 'Lock' && statement.test(row.query));
    last = waiting.map((row) => ({ pid: row.pid, wait_event: row.wait_event, blockers: row.blockers }));
    if (waiting.length >= count) return waiting;
    await sleep(25);
  }
  throw new Error(`expected ${count} backends waiting on the coordinator lock, saw ${JSON.stringify(last)}`);
}

// --- disjoint Location.pointOfSaleNumber ranges (U2 P2-B) --------------------
// Location.pointOfSaleNumber is UNIQUE. Each opt-in PG suite derives it from a
// five-hex-digit tag (0..0xfffff = 1_048_575), so every suite owns a slot of
// POS_SLOT_WIDTH numbers that the tag can never leave. All slots fit an INTEGER.
// CM: the PILOT cash-exit gate (cash-movement.pg.test.ts), slot 9.
// CR: the PILOT cash-reversal gate (cash-movement-reversal.pg.test.ts), slot 10.
// CC: the CARD_CREDIT gate (checkout-card-credit.pg.test.ts), slot 11.
// WH: the WAREHOUSE-MVP stock-adjustment gate (inventory-adjustment.pg.test.ts), slot 12.
// SC: the scope-assignment lock gate (scope-assignment-lock.pg.test.ts), slot 13.
export const POS_SUITE_SLOTS = Object.freeze({ S4: 3, SREF: 4, S5: 5, S6: 6, S7: 7, S7RR: 8, CM: 9, CR: 10, CC: 11, WH: 12, SC: 13 } as const);
export type PosSuite = keyof typeof POS_SUITE_SLOTS;
const POS_SLOT_WIDTH = 10_000_000;

export function pointOfSaleNumberFor(suite: PosSuite, tag: string): number {
  if (!Object.hasOwn(POS_SUITE_SLOTS, suite)) throw new Error('unknown PG suite for pointOfSaleNumber');
  if (!/^[0-9a-f]{5}/.test(tag)) throw new Error('pointOfSaleNumber tag must start with five lowercase hex digits');
  return POS_SUITE_SLOTS[suite] * POS_SLOT_WIDTH + parseInt(tag.slice(0, 5), 16);
}
