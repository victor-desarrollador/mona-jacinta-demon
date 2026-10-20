// R3-A4.3 S1 — schema behavior of migration 20261016130000_r3_checkout_attempts
// on a REAL PostgreSQL. OPT-IN ONLY, never part of an ordinary run: it is NOT
// authorized yet and has NOT been executed. The DB-free static tests
// (r3-attempts-schema.static / r3-attempts-pg-harness.static) only prove SQL
// presence and harness shape; the effective behavior is proven ONLY here.
//
// Requires an OWNER-authorized, disposable, isolated LOCAL_TEST cluster
// (marker + system id binding):
//   Suite A (P1–P5, P23, P33–P35, P47–P53, matrices) — migrations 1–9 applied:
//     MONA_R3_ATTEMPTS_PG=1 MONA_TEST_DATABASE_TARGET=local
//     LOCAL_TEST_DATABASE_URL=… LOCAL_TEST_DATABASE_MARKER_ID=…
//     MONA_R3_PG_SYSTEM_ID=<pg_control_system().system_identifier of THAT cluster>
//   Suite B (P21a, P21b) — exact ledger of migrations 1–8, no migration 9
//     (built on a FRESH cluster by local-test-prepare.mjs --migration-set=r3-p21-base):
//     same variables with MONA_R3_P21_PG=1; needs /usr/bin/psql.
//
// Writes:
//   Suite A: every case runs inside ONE transaction that is always rolled back;
//     each expectation runs in a savepoint; deferred triggers are forced with
//     SET CONSTRAINTS ALL IMMEDIATE. Nothing persists.
//   Suite B P21a: COMMITS a fixture (Branch, User, CashRegister, CashSession,
//     Sale, SaleCheckout), runs the COMPLETE migration file with psql (its own
//     BEGIN/COMMIT, no outer transaction), then deletes exactly those ids.
//   Suite B P21b: runs the instrumented copy with psql; it fails before its
//     COMMIT. It first requires the authoritative R3-T pin (U1: the LOCAL_TEST
//     payload pin of local-test-migration-payload.mjs); a mismatch FAILS CLOSED.
// Credentials never reach argv, a shell or a log line (tests/helpers/r3-psql.ts).
//
// P21c, P21d (S9/S11), P54 and P55 (S4–S6 services) are todo, never reported
// as passing.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  P21B_INJECTION,
  R3_ATTEMPTS_MIGRATION,
  checkMigration9Pin,
  deriveP21bInstrumentedCopy,
  expectedLedgerBeforeMigration9,
  insertedLines,
  migrationPath,
  readMigration,
  splitTopLevelStatements,
} from '../helpers/r3-attempts-migration.js';
import { createBoundPsqlRunner } from '../helpers/r3-psql.js';
import type { LocalTestTarget } from '../../scripts/demo-database.js';

const suiteA = process.env.MONA_R3_ATTEMPTS_PG === '1';
const suiteB = process.env.MONA_R3_P21_PG === '1';
const CHECK = '23514';
const FK = '23503';

// Returns the pool AND the target it was proven against (marker + system id);
// psql later uses exactly this target's url, never a fresh environment read.
async function openBoundPool(): Promise<{ pool: Pool; target: LocalTestTarget }> {
  if (process.env.MONA_TEST_DATABASE_TARGET !== 'local') throw new Error('LOCAL_TEST selector required');
  const expectedSystemId = process.env.MONA_R3_PG_SYSTEM_ID;
  if (!expectedSystemId || !/^[1-9][0-9]{15,20}$/.test(expectedSystemId)) throw new Error('isolated cluster binding is missing');
  const { openProvenLocalTestPool } = await import('../../scripts/demo-database.js');
  const { pool, target } = await openProvenLocalTestPool(2, process.env);
  const { rows } = await pool.query<{ system_id: string }>('SELECT system_identifier::text AS system_id FROM pg_control_system()');
  if (rows[0]?.system_id !== expectedSystemId) {
    await pool.end();
    throw new Error('isolated PostgreSQL cluster does not match binding');
  }
  return { pool, target };
}

async function hasAttemptTable(q: Pool | PoolClient): Promise<boolean> {
  const { rows } = await q.query(`SELECT to_regclass('public."CheckoutAttempt"') IS NOT NULL AS present`);
  return rows[0].present === true;
}

// --- SQL harness (inside the caller's open transaction) -------------------------
type PgError = { code?: string; message?: string; constraint?: string };
type Db = {
  q: (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
  // Runs sql in a savepoint that is ALWAYS rolled back; returns the error or null.
  probe: (sql: string, params?: unknown[], forceDeferred?: boolean) => Promise<PgError | null>;
  // Runs `body` (optionally forcing deferred checks) in a savepoint that is ALWAYS rolled back.
  attempt: (body: () => Promise<void>, forceDeferred: boolean) => Promise<PgError | null>;
  fails: (code: string, sql: string, params?: unknown[], message?: RegExp) => Promise<void>;
  // Runs `body`, then forces the deferred triggers; expects `code` (or success when null).
  atCommit: (code: string | null, body: () => Promise<void>, message?: RegExp) => Promise<void>;
};

function harness(client: PoolClient): Db {
  let n = 0;
  const q = async (sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows;
  const savepoint = async (run: () => Promise<void>, keep: boolean): Promise<PgError | null> => {
    const sp = `sp_${++n}`;
    await client.query(`SAVEPOINT ${sp}`);
    try {
      await run();
      await client.query(keep ? `RELEASE SAVEPOINT ${sp}` : `ROLLBACK TO SAVEPOINT ${sp}`);
      return null;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      return error as PgError;
    } finally {
      await client.query('SET CONSTRAINTS ALL DEFERRED');
    }
  };
  return {
    q,
    probe: (sql, params = [], forceDeferred = false) => savepoint(async () => {
      await q(sql, params);
      if (forceDeferred) await q('SET CONSTRAINTS ALL IMMEDIATE');
    }, false),
    attempt: (body, forceDeferred) => savepoint(async () => {
      await body();
      if (forceDeferred) await q('SET CONSTRAINTS ALL IMMEDIATE');
    }, false),
    async fails(code, sql, params = [], message) {
      const error = await savepoint(async () => { await q(sql, params); }, true);
      expect(error?.code, `${sql.slice(0, 90)} → ${error?.message ?? 'no error'}`).toBe(code);
      if (message) expect(error?.message).toMatch(message);
    },
    async atCommit(code, body, message) {
      const error = await savepoint(async () => { await body(); await q('SET CONSTRAINTS ALL IMMEDIATE'); }, true);
      if (code === null) expect(error, error?.message).toBeNull();
      else {
        expect(error?.code, error?.message ?? 'no error').toBe(code);
        if (message) expect(error?.message).toMatch(message);
      }
    },
  };
}

// --- fixture ---------------------------------------------------------------------
type Fx = {
  branch: string; branch2: string; starter: string; other: string; session: string; register: string;
  sale: string; sale2: string; sale3: string; sale4: string;
};
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
let refCounter = 0;

async function fixture(db: Db): Promise<Fx> {
  const fx: Fx = {
    branch: randomUUID(), branch2: randomUUID(), starter: randomUUID(), other: randomUUID(), session: randomUUID(),
    register: randomUUID(), sale: randomUUID(), sale2: randomUUID(), sale3: randomUUID(), sale4: randomUUID(),
  };
  const tag = fx.branch.slice(0, 8);
  for (const [id, n] of [[fx.branch, 1], [fx.branch2, 2]] as const) {
    await db.q(`INSERT INTO "Branch"("id","name","code","address","pointOfSaleNumber") VALUES ($1,$2,$3,'Test',$4)`,
      [id, `R3S1 ${tag} ${n}`, `r3s1-${tag}-${n}`, 900_000 + n]);
  }
  for (const id of [fx.starter, fx.other]) {
    await db.q(`INSERT INTO "User"("id","name","email","passwordHash","updatedAt") VALUES ($1,'R3S1',$2,'not-used',now())`,
      [id, `r3s1-${id}@test.invalid`]);
  }
  await db.q(`INSERT INTO "CashRegister"("id","branchId","name") VALUES ($1,$2,'R3S1')`, [fx.register, fx.branch]);
  await db.q(`INSERT INTO "CashSession"("id","registerId","openedById","startingCash") VALUES ($1,$2,$3,0)`,
    [fx.session, fx.register, fx.starter]);
  for (const id of [fx.sale, fx.sale2, fx.sale3, fx.sale4]) {
    await db.q(`INSERT INTO "Sale"("id","branchId","sellerId","status","pricingModel","priceMode","subtotal","total","updatedAt")
                VALUES ($1,$2,$3,'PENDING_PAYMENT','PROPORTIONAL_V1','CASH',10000,10000,now())`, [id, fx.branch, fx.starter]);
  }
  return fx;
}

type Method = 'CASH' | 'TRANSFER' | 'CARD_DEBIT';
type Tender = { method: Method; role: 'BALANCE' | 'FIXED'; source: 'NEW' | 'COLLECTION'; amount?: bigint; collection?: string };
const CASH_BALANCE: Tender = { method: 'CASH', role: 'BALANCE', source: 'NEW' };

function planRow(fx: Fx, sale: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(), saleId: sale, branchId: fx.branch, reserveKey: randomUUID(), operationKey: randomUUID(),
    planHash: HASH_A, cashSessionId: fx.session, balanceMethod: 'CASH', expectedTotal: 10000, expectedBalanceAmount: 5000,
    tenderCount: 1, fullPriceCash: 10000, algorithmVersion: 1, startedById: fx.starter, ...extra,
  };
}

function insertSql(table: string, row: Record<string, unknown>): [string, unknown[]] {
  const cols = Object.keys(row);
  return [`INSERT INTO "${table}"(${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})`, Object.values(row)];
}

async function insertAttempt(db: Db, fx: Fx, opts: {
  sale?: string; tenders?: Tender[]; tenderCount?: number; balanceMethod?: string; seal?: boolean;
  claim?: boolean; starter?: string; extra?: Record<string, unknown>;
} = {}): Promise<{ id: string; operationKey: string; reserveKey: string; sale: string }> {
  const tenders = opts.tenders ?? [CASH_BALANCE];
  const sale = opts.sale ?? fx.sale;
  const row = planRow(fx, sale, {
    tenderCount: opts.tenderCount ?? tenders.length, balanceMethod: opts.balanceMethod ?? 'CASH',
    startedById: opts.starter ?? fx.starter, ...(opts.extra ?? {}),
  });
  await db.q(...insertSql('CheckoutAttempt', row));
  const id = row.id as string;
  for (const t of tenders) {
    await db.q(`INSERT INTO "CheckoutAttemptTender"("id","attemptId","branchId","method","role","source","amount","externalCollectionId")
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [randomUUID(), id, fx.branch, t.method, t.role, t.source, t.amount ?? null, t.collection ?? null]);
  }
  if (opts.claim !== false) {
    for (const t of tenders.filter((x) => x.source === 'COLLECTION')) {
      await db.q(`UPDATE "ExternalCollection" SET "claimAttemptId" = $1 WHERE "id" = $2`, [id, t.collection]);
    }
  }
  if (opts.seal !== false) await db.q(`UPDATE "CheckoutAttempt" SET "planSealed" = true WHERE "id" = $1`, [id]);
  return { id, operationKey: row.operationKey as string, reserveKey: row.reserveKey as string, sale };
}

async function insertCollection(db: Db, fx: Fx, opts: {
  method?: 'TRANSFER' | 'CARD_DEBIT' | 'CARD_CREDIT'; amount?: bigint; branch?: string; originSale?: string | null;
  originAttempt?: string; recordedBy?: string; status?: string; appliedCheckout?: string; appliedSale?: string;
} = {}): Promise<string> {
  const id = randomUUID();
  const method = opts.method ?? 'TRANSFER';
  const ref = `R3S1REF${++refCounter}X${id.slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
  await db.q(`INSERT INTO "ExternalCollection"("id","branchId","method","amount","reference","referenceKey","institution",
                "status","originSaleId","originAttemptId","cashSessionId","recordedById","appliedCheckoutId","appliedSaleId")
              VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, opts.branch ?? fx.branch, method, opts.amount ?? 5000n, ref, method === 'TRANSFER' ? 'MACRO' : null,
      opts.status ?? 'UNAPPLIED', opts.originSale === undefined ? fx.sale : opts.originSale, opts.originAttempt ?? null,
      fx.session, opts.recordedBy ?? fx.starter, opts.appliedCheckout ?? null, opts.appliedSale ?? null]);
  return id;
}

async function reject(db: Db, attempt: string, by: string) {
  await db.q(`UPDATE "CheckoutAttempt" SET "status"='REJECTED',"rejectionCode"='NO_OPEN_CASH_SESSION',"rejectedById"=$2,"rejectedAt"=now() WHERE "id"=$1`, [attempt, by]);
}
async function abandon(db: Db, attempt: string, by: string) {
  await db.q(`UPDATE "CheckoutAttempt" SET "status"='ABANDONED',"abandonedById"=$2,"abandonedAt"=now() WHERE "id"=$1`, [attempt, by]);
}
type DeclRow = { method: string; source: string; outcome: string; collection?: string | null; returned?: bigint | null; evidence?: string | null; by?: string };
function declSql(fx: Fx, attempt: string, sale: string, r: DeclRow): [string, unknown[]] {
  return insertSql('CheckoutAttemptDeclaration', {
    id: randomUUID(), attemptId: attempt, saleId: sale, branchId: fx.branch, method: r.method, tenderSource: r.source,
    outcome: r.outcome, externalCollectionId: r.collection ?? null, returnedAmount: r.returned ?? null,
    evidence: r.evidence ?? null, declaredById: r.by ?? fx.starter,
  });
}
async function declare(db: Db, fx: Fx, attempt: string, rows: DeclRow[], sale = fx.sale) {
  for (const r of rows) await db.q(...declSql(fx, attempt, sale, r));
}
async function markDeclared(db: Db, attempt: string, by: string) {
  await db.q(`UPDATE "CheckoutAttempt" SET "declaredById"=$2,"declaredAt"=now() WHERE "id"=$1`, [attempt, by]);
}
async function confirm(db: Db, attempt: string, by: string, hash = HASH_B) {
  await db.q(`UPDATE "CheckoutAttempt" SET "status"='CONFIRMED',"confirmationHash"=$3,"confirmedById"=$2,"confirmedAt"=now() WHERE "id"=$1`, [attempt, by, hash]);
}
function checkoutRow(fx: Fx, a: { operationKey: string }, sale: string, hash = HASH_B, attemptStatus = 'CONFIRMED') {
  return {
    id: randomUUID(), saleId: sale, branchId: fx.branch, pricingModel: 'PROPORTIONAL_V1', operationKey: a.operationKey,
    requestHash: hash, cashSessionId: fx.session, userId: fx.starter, balanceMethod: 'CASH', referenceSubtotal: 10000,
    total: 10000, fullPriceCash: 10000, algorithmVersion: 1, attemptStatus,
  };
}
async function insertCheckout(db: Db, fx: Fx, a: { operationKey: string }, sale = fx.sale, hash = HASH_B): Promise<string> {
  const row = checkoutRow(fx, a, sale, hash);
  await db.q(...insertSql('SaleCheckout', row));
  return row.id;
}

// --- Independent oracles, written from the contract text (not from the SQL) ----
const OUTCOME_COLUMNS = [
  'confirmationHash', 'confirmedById', 'confirmedAt', 'confirmReason', 'confirmEvidence',
  'rejectionCode', 'rejectionDetails', 'rejectedById', 'rejectedAt',
  'abandonedById', 'abandonedAt', 'abandonReason', 'abandonEvidence', 'declaredById', 'declaredAt',
] as const;
type Row = Record<string, unknown>;
const present = (row: Row, col: string) => row[col] !== null && row[col] !== undefined;
const none = (row: Row, cols: readonly string[]) => cols.every((c) => !present(row, c));
const CONFIRM_COLS = ['confirmationHash', 'confirmedById', 'confirmedAt', 'confirmReason', 'confirmEvidence'];
const REJECT_COLS = ['rejectionCode', 'rejectionDetails', 'rejectedById', 'rejectedAt'];
const ABANDON_COLS = ['abandonedById', 'abandonedAt', 'abandonReason', 'abandonEvidence'];
const DECLARED_COLS: readonly string[] = ['declaredById', 'declaredAt'];
const declaredPair = (row: Row) => present(row, 'declaredById') === present(row, 'declaredAt');

// chk_attempt_status_fields, consolidated contract §2.1.1.
function statusFieldsValid(row: Row): boolean {
  const sealed = row.planSealed === true;
  switch (row.status) {
    case 'RESERVED':
      return none(row, OUTCOME_COLUMNS);
    case 'CONFIRMED':
      return sealed && present(row, 'confirmationHash') && present(row, 'confirmedById') && present(row, 'confirmedAt')
        && ((row.confirmedById === row.startedById && none(row, ['confirmReason', 'confirmEvidence']))
          || (row.confirmedById !== row.startedById && present(row, 'confirmReason') && present(row, 'confirmEvidence')))
        && none(row, [...REJECT_COLS, ...ABANDON_COLS, ...DECLARED_COLS]);
    case 'REJECTED':
      return sealed && present(row, 'rejectionCode') && /^[A-Z][A-Z_]{2,63}$/.test(String(row.rejectionCode))
        && present(row, 'rejectedById') && present(row, 'rejectedAt')
        && none(row, [...CONFIRM_COLS, ...ABANDON_COLS]) && declaredPair(row);
    case 'ABANDONED':
      return sealed && present(row, 'abandonedById') && present(row, 'abandonedAt')
        && (row.abandonedById === row.startedById || (present(row, 'abandonReason') && present(row, 'abandonEvidence')))
        && none(row, [...CONFIRM_COLS, ...REJECT_COLS]) && declaredPair(row);
    default:
      return false;
  }
}

// chk_tender_shape.
function tenderShapeValid(t: { method: string; role: string; source: string; amount: bigint | null; collection: boolean }): boolean {
  if (!['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT'].includes(t.method)) return false;
  if (t.role === 'BALANCE') return t.source === 'NEW' && t.amount === null && !t.collection;
  if (t.source === 'NEW') return t.amount !== null && t.amount > 0n && !t.collection;
  return ['TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT'].includes(t.method) && t.amount !== null && t.amount > 0n && t.collection;
}

// chk_declaration_shape + chk_declaration_evidence (C1–C5 §2.2).
function declarationShapeValid(d: { method: string; source: string; outcome: string; collection: boolean; returned: bigint | null; evidence: string | null }): boolean {
  if (d.evidence !== null && (d.evidence.trim().length < 3 || d.evidence.trim().length > 200)) return false;
  if (d.method === 'CASH') {
    if (d.source !== 'NEW' || d.collection) return false;
    if (d.outcome === 'NONE') return d.returned === null;
    if (d.outcome === 'RETURNED') return d.returned !== null && d.returned > 0n && d.evidence !== null;
    return false;
  }
  if (!['TRANSFER', 'CARD_DEBIT'].includes(d.method)) return false;
  if (d.outcome === 'NONE') return !d.collection && d.returned === null;
  if (d.outcome === 'CHARGED') return d.source === 'NEW' && d.collection && d.returned === null && d.evidence !== null;
  return false;
}

const cartesian = <T extends Record<string, readonly unknown[]>>(axes: T): Array<{ [K in keyof T]: T[K][number] }> =>
  Object.entries(axes).reduce<Array<Record<string, unknown>>>(
    (acc, [key, values]) => acc.flatMap((partial) => values.map((v) => ({ ...partial, [key]: v }))), [{}],
  ) as Array<{ [K in keyof T]: T[K][number] }>;

const text = (n: number, pad = '') => `${pad}${'x'.repeat(n)}${pad}`;
const show = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const fresh = (row: Row): Row => ({ ...row, id: randomUUID(), reserveKey: randomUUID(), operationKey: randomUUID() });

describe.skipIf(!suiteA)('R3-A4.3 S1 — schema on PostgreSQL (migrations 1–9)', () => {
  let pool: Pool;
  let client: PoolClient;
  let db: Db;
  let fx: Fx;

  beforeAll(async () => {
    ({ pool } = await openBoundPool());
    if (!(await hasAttemptTable(pool))) throw new Error('suite A requires migration 9 applied');
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(async () => {
    client = await pool.connect();
    await client.query('BEGIN');
    db = harness(client);
    fx = await fixture(db);
  });
  afterEach(async () => {
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------- P1 matrices
  it('P1a chk_attempt_status_fields: every valid row per status, and every single-column mutation of it, match the contract oracle', async () => {
    const now = new Date();
    const valid = (status: string, cols: Row): Row => ({ ...planRow(fx, fx.sale), status, planSealed: status !== 'RESERVED', ...cols });
    const conf = { confirmationHash: HASH_B, confirmedAt: now };
    const sup = (prefix: 'confirm' | 'abandon') => ({ [`${prefix}Reason`]: 'motivo del supervisor', [`${prefix}Evidence`]: 'cupón 123' });
    const bases: Row[] = [
      valid('RESERVED', {}),
      valid('RESERVED', { planSealed: true }),
      valid('CONFIRMED', { ...conf, confirmedById: fx.starter }),
      valid('CONFIRMED', { ...conf, confirmedById: fx.other, ...sup('confirm') }),
      valid('REJECTED', { rejectionCode: 'NO_OPEN_CASH_SESSION', rejectedById: fx.starter, rejectedAt: now }),
      valid('REJECTED', { rejectionCode: 'INSUFFICIENT_PHYSICAL', rejectionDetails: '{"v":1}', rejectedById: fx.starter, rejectedAt: now, declaredById: fx.starter, declaredAt: now }),
      valid('ABANDONED', { abandonedById: fx.starter, abandonedAt: now }),
      valid('ABANDONED', { abandonedById: fx.other, abandonedAt: now, ...sup('abandon'), declaredById: fx.other, declaredAt: now }),
    ];
    const sample: Row = {
      confirmationHash: HASH_B, confirmedById: fx.other, confirmedAt: now, confirmReason: 'motivo del supervisor',
      confirmEvidence: 'cupón 123', rejectionCode: 'NO_OPEN_CASH_SESSION', rejectionDetails: '{}', rejectedById: fx.starter,
      rejectedAt: now, abandonedById: fx.other, abandonedAt: now, abandonReason: 'motivo del supervisor',
      abandonEvidence: 'cupón 123', declaredById: fx.starter, declaredAt: now,
    };
    const cases: Array<[string, Row]> = [];
    for (const base of bases) {
      cases.push([`${String(base.status)} base`, base]);
      for (const col of OUTCOME_COLUMNS) cases.push([`${String(base.status)} toggle ${col}`, fresh({ ...base, [col]: present(base, col) ? null : sample[col] })]);
      if (base.status !== 'RESERVED') cases.push([`${String(base.status)} unsealed`, fresh({ ...base, planSealed: false })]);
    }
    cases.push(['REJECTED lowercase code', fresh({ ...bases[4], rejectionCode: 'bad_code' })]);
    cases.push(['CONFIRMED self with supervisor fields', fresh({ ...bases[2], ...sup('confirm') })]);
    let positives = 0;
    for (const [label, row] of cases) {
      const expected = statusFieldsValid(row);
      const error = await db.probe(...insertSql('CheckoutAttempt', row));
      if (expected) {
        positives += 1;
        expect(error, `${label}: ${error?.message}`).toBeNull();
      } else {
        expect(error?.code, `${label}: ${error?.message ?? 'accepted'}`).toBe(CHECK);
        expect(error?.constraint, label).toBe('chk_attempt_status_fields');
      }
    }
    expect(positives).toBeGreaterThanOrEqual(bases.length);
  });

  it('P1b plan, hash, snapshot, text and recovery CHECKs: NULL forms, boundaries and invalid values', async () => {
    const snap: Row = { pricingConfigId: 'cfg', pricingConfigUpdatedAt: new Date(), fullPriceTransfer: 10100, fullPriceDebit: 10200, transferAdjustmentBps: 100, debitAdjustmentBps: 200 };
    const now = new Date();
    const supConfirm = (reason: string, evidence: string): Row => ({ status: 'CONFIRMED', planSealed: true, confirmationHash: HASH_B, confirmedById: fx.other, confirmedAt: now, confirmReason: reason, confirmEvidence: evidence });
    const supAbandon = (reason: string, evidence: string): Row => ({ status: 'ABANDONED', planSealed: true, abandonedById: fx.other, abandonedAt: now, abandonReason: reason, abandonEvidence: evidence });
    type Case = [string, Row, string | null];
    const plan = (col: string, pairs: ReadonlyArray<readonly [unknown, string | null]>): Case[] => pairs.map(([v, c]) => [`${col} ${String(v)}`, { [col]: v }, c]);
    const P = 'chk_attempt_plan';
    const S = 'chk_attempt_pricing_snapshot';
    const T = 'chk_attempt_texts';
    const R = 'chk_attempt_recovery';
    const cases: Case[] = [
      ['planHash uppercase', { planHash: 'A'.repeat(64) }, 'chk_attempt_hashes'],
      ['planHash non-hex', { planHash: 'g'.repeat(64) }, 'chk_attempt_hashes'],
      ['planHash 63 chars (CHAR pads)', { planHash: 'a'.repeat(63) }, 'chk_attempt_hashes'],
      ['confirmationHash non-hex', { status: 'CONFIRMED', planSealed: true, confirmationHash: 'Z'.repeat(64), confirmedById: fx.starter, confirmedAt: now }, 'chk_attempt_hashes'],
      // CARD_CREDIT is a valid plan method since the CARD_CREDIT migration; as the balance of a row WITHOUT a credit
      // price (this base row has none) it is refused by the credit snapshot CHECK, never by the plan CHECK.
      ...plan('balanceMethod', [['CASH', null], ['TRANSFER', null], ['CARD_DEBIT', null], ['CARD_CREDIT', 'chk_attempt_credit_snapshot'], ['QR', P]]),
      ...plan('expectedTotal', [[0, P], [1, null]]),
      ...plan('expectedBalanceAmount', [[0, P], [99, P], [100, null], [150, P], [200, null]]),
      ...plan('tenderCount', [[0, P], [1, null], [3, null], [4, P]]),
      ...plan('fullPriceCash', [[0, P], [50, P], [100, null]]),
      // 1 = no credit snapshot (what an N-1 API writes), 2 = the credit snapshot (CARD_CREDIT migration); nothing else.
      ...plan('algorithmVersion', [[0, P], [1, null], [2, null], [3, P]]),
      ['v2 with the pricing snapshot but no credit price', { ...snap, algorithmVersion: 2 }, 'chk_attempt_credit_snapshot'],
      ['v1 with a credit price', { ...snap, fullPriceCredit: 10300, creditAdjustmentBps: 300 }, 'chk_attempt_credit_snapshot'],
      ['v2 with the whole snapshot incl. credit', { ...snap, algorithmVersion: 2, fullPriceCredit: 10300, creditAdjustmentBps: 300 }, null],
      ['CARD_CREDIT balance with the whole v2 snapshot', { ...snap, algorithmVersion: 2, fullPriceCredit: 10300, creditAdjustmentBps: 300, balanceMethod: 'CARD_CREDIT' }, null],
      ['snapshot complete', snap, null],
      ...Object.keys(snap).map((k): Case => [`snapshot only ${k}`, { [k]: snap[k] }, S]),
      ...Object.keys(snap).map((k): Case => [`snapshot without ${k}`, { ...snap, [k]: null }, S]),
      ...([['fullPriceTransfer', 0], ['fullPriceTransfer', 10150], ['fullPriceDebit', 0], ['fullPriceDebit', 10150],
        ['transferAdjustmentBps', -1], ['transferAdjustmentBps', 10001], ['debitAdjustmentBps', -1], ['debitAdjustmentBps', 10001]] as const)
        .map(([k, v]): Case => [`snapshot ${k}=${v}`, { ...snap, [k]: v }, S]),
      ...([['transferAdjustmentBps', 0], ['transferAdjustmentBps', 10000], ['debitAdjustmentBps', 0], ['debitAdjustmentBps', 10000]] as const)
        .map(([k, v]): Case => [`snapshot ${k}=${v} (bound)`, { ...snap, [k]: v }, null]),
      // Texts: reason 10..500, evidence 3..200, measured after btrim.
      ...([[9, T], [10, null], [500, null], [501, T]] as const).flatMap(([n, c]): Case[] => [
        [`confirmReason ${n}`, supConfirm(text(n), 'ok1'), c],
        [`abandonReason ${n}`, supAbandon(text(n), 'ok1'), c],
      ]),
      ...([[2, T], [3, null], [200, null], [201, T]] as const).flatMap(([n, c]): Case[] => [
        [`confirmEvidence ${n}`, supConfirm(text(10), text(n)), c],
        [`abandonEvidence ${n}`, supAbandon(text(10), text(n)), c],
      ]),
      ['confirmReason 9 padded', supConfirm(text(9, '   '), 'ok1'), T],
      ['abandonEvidence 2 padded', supAbandon(text(10), text(2, '  ')), T],
      ['recovery both valid', { recoveryReason: text(10), recoveryEvidence: text(3) }, null],
      ['recovery reason only', { recoveryReason: text(10) }, R],
      ['recovery evidence only', { recoveryEvidence: text(3) }, R],
      ['recovery reason 9', { recoveryReason: text(9), recoveryEvidence: text(3) }, R],
      ['recovery reason 500', { recoveryReason: text(500), recoveryEvidence: text(3) }, null],
      ['recovery reason 501', { recoveryReason: text(501), recoveryEvidence: text(3) }, R],
      ['recovery evidence 2 padded', { recoveryReason: text(10), recoveryEvidence: text(2, ' ') }, R],
      ['recovery evidence 200', { recoveryReason: text(10), recoveryEvidence: text(200) }, null],
      ['recovery evidence 201', { recoveryReason: text(10), recoveryEvidence: text(201) }, R],
    ];
    for (const [label, extra, constraint] of cases) {
      const error = await db.probe(...insertSql('CheckoutAttempt', planRow(fx, fx.sale, extra)));
      if (constraint === null) expect(error, `${label}: ${error?.message}`).toBeNull();
      else {
        expect(error?.code, `${label}: ${error?.message ?? 'accepted'}`).toBe(CHECK);
        expect(error?.constraint, label).toBe(constraint);
      }
    }
    // NOT NULL plan columns are refused as NULL (23502), never silently defaulted.
    for (const col of ['reserveKey', 'operationKey', 'planHash', 'cashSessionId', 'balanceMethod', 'expectedTotal', 'expectedBalanceAmount', 'tenderCount', 'fullPriceCash', 'algorithmVersion', 'startedById']) {
      const error = await db.probe(...insertSql('CheckoutAttempt', planRow(fx, fx.sale, { [col]: null })));
      expect(error?.code, col).toBe('23502');
    }
  });

  it('P1c every CheckoutAttemptTender variant (method × role × source × amount × collection) matches chk_tender_shape', async () => {
    const ec: Record<string, string> = {
      TRANSFER: await insertCollection(db, fx, { method: 'TRANSFER', amount: 5000n }),
      CARD_DEBIT: await insertCollection(db, fx, { method: 'CARD_DEBIT', amount: 5000n }),
      CARD_CREDIT: await insertCollection(db, fx, { method: 'CARD_CREDIT', amount: 5000n }),
    };
    const attempt = await insertAttempt(db, fx, { sale: fx.sale4, seal: false, tenders: [], tenderCount: 1 });
    const matrix = cartesian({
      method: ['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR'],
      role: ['BALANCE', 'FIXED'],
      source: ['NEW', 'COLLECTION'],
      amount: [null, -1n, 0n, 5000n],
      collection: [false, true],
    } as const);
    let accepted = 0;
    for (const t of matrix) {
      const collectionId = t.collection ? (ec[t.method] ?? ec.TRANSFER!) : null;
      const expected = tenderShapeValid(t);
      const error = await db.probe(`INSERT INTO "CheckoutAttemptTender"("id","attemptId","branchId","method","role","source","amount","externalCollectionId") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), attempt.id, fx.branch, t.method, t.role, t.source, t.amount, collectionId]);
      if (expected) {
        accepted += 1;
        expect(error, `${show(t)}: ${error?.message}`).toBeNull();
      } else {
        expect(error?.code, `${show(t)}: ${error?.message ?? 'accepted'}`).toBe(CHECK);
        expect(error?.constraint, show(t)).toBe('chk_tender_shape');
      }
    }
    // BALANCE NEW ×4 methods, FIXED NEW ×4, FIXED COLLECTION ×3 (amount 5000 only).
    expect(accepted).toBe(4 + 4 + 3);
  });

  it('P1d every CheckoutAttemptDeclaration variant matches chk_declaration_shape / chk_declaration_evidence (or the F4 guard for CHARGED)', async () => {
    const cNew = await insertAttempt(db, fx, { sale: fx.sale, tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 5000n }, { method: 'CARD_DEBIT', role: 'FIXED', source: 'NEW', amount: 3000n }] });
    const ct = await insertCollection(db, fx, { method: 'TRANSFER', amount: 5000n, originSale: fx.sale2 });
    const cd = await insertCollection(db, fx, { method: 'CARD_DEBIT', amount: 3000n, originSale: fx.sale2 });
    const cColl = await insertAttempt(db, fx, { sale: fx.sale2, tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 5000n, collection: ct }, { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 3000n, collection: cd }] });
    await abandon(db, cNew.id, fx.starter);
    await abandon(db, cColl.id, fx.starter);
    const charged: Record<string, string> = {
      TRANSFER: await insertCollection(db, fx, { method: 'TRANSFER', amount: 5000n, originAttempt: cNew.id }),
      CARD_DEBIT: await insertCollection(db, fx, { method: 'CARD_DEBIT', amount: 3000n, originAttempt: cNew.id }),
    };
    const matrix = cartesian({
      method: ['CASH', 'TRANSFER', 'CARD_DEBIT'],
      source: ['NEW', 'COLLECTION'],
      outcome: ['NONE', 'CHARGED', 'RETURNED'],
      collection: [false, true],
      returned: [null, 0n, 2000n],
      evidence: [null, 'ab', '  ab  ', 'comprobante 1'],
    } as const);
    let accepted = 0;
    for (const d of matrix) {
      const attempt = d.source === 'NEW' ? cNew : cColl;
      const collectionId = d.collection ? (charged[d.method] ?? charged.TRANSFER!) : null;
      const expected = declarationShapeValid(d);
      const error = await db.probe(...declSql(fx, attempt.id, attempt.sale, {
        method: d.method, source: d.source, outcome: d.outcome, collection: collectionId, returned: d.returned, evidence: d.evidence,
      }));
      if (expected) {
        accepted += 1;
        expect(error, `${show(d)}: ${error?.message}`).toBeNull();
        continue;
      }
      expect(error?.code, `${show(d)}: ${error?.message ?? 'accepted'}`).toBe(CHECK);
      // F4 runs BEFORE the row CHECKs: a CHARGED without a usable collection is refused by it.
      if (error?.constraint) expect(['chk_declaration_shape', 'chk_declaration_evidence'], show(d)).toContain(error.constraint);
      else expect(error?.message, show(d)).toMatch(/CHARGED requires an UNAPPLIED collection/);
    }
    // CASH NONE (evidence null|valid), CASH RETURNED 2000 (valid evidence),
    // TRANSFER/CARD_DEBIT NONE × NEW/COLLECTION (evidence null|valid), CHARGED NEW (valid evidence).
    expect(accepted).toBe(2 + 1 + 2 * 2 * 2 + 2);
  });

  it('P1e EC and SaleCheckout CHECKs: origin attempt without sale; attemptStatus other than CONFIRMED', async () => {
    const a = await insertAttempt(db, fx);
    const error = await db.probe(`INSERT INTO "ExternalCollection"("id","branchId","method","amount","reference","referenceKey","status","originAttemptId","recordedById")
      VALUES ($1,$2,'CARD_DEBIT',5000,'R3S1OR','R3S1OR','UNAPPLIED',$3,$4)`, [randomUUID(), fx.branch, a.id, fx.starter]);
    expect(error?.constraint).toBe('chk_ec_origin_attempt');
    for (const status of ['RESERVED', 'REJECTED', 'ABANDONED']) {
      const e = await db.probe(...insertSql('SaleCheckout', checkoutRow(fx, a, fx.sale, HASH_A, status)));
      expect(e?.code, status).toBe(CHECK);
      expect(e?.constraint, status).toBe('chk_checkout_attempt_status');
    }
  });

  // ---------------------------------------------------------------- P2 FKs
  it('P2 composite FKs: COLLECTION tender (amount/method/branch), checkout ↔ CONFIRMED attempt with the same hash and sale', async () => {
    const c = await insertCollection(db, fx, { method: 'TRANSFER', amount: 5000n });
    const cOther = await insertCollection(db, fx, { method: 'TRANSFER', amount: 5000n, branch: fx.branch2, originSale: null });
    const a = await insertAttempt(db, fx, { seal: false, tenders: [CASH_BALANCE], tenderCount: 2 });
    for (const [label, method, amount, collection] of [
      ['other amount', 'TRANSFER', 4999n, c], ['other method', 'CARD_DEBIT', 5000n, c], ['other branch', 'TRANSFER', 5000n, cOther],
    ] as const) {
      const e = await db.probe(`INSERT INTO "CheckoutAttemptTender"("id","attemptId","branchId","method","role","source","amount","externalCollectionId") VALUES ($1,$2,$3,$4,'FIXED','COLLECTION',$5,$6)`,
        [randomUUID(), a.id, fx.branch, method, amount, collection]);
      expect(e?.code, label).toBe(FK);
      expect(e?.constraint, label).toBe('CheckoutAttemptTender_collection_fkey');
    }
    const b = await insertAttempt(db, fx, { sale: fx.sale2 });
    for (const [label, row] of [
      ['no attempt', checkoutRow(fx, { operationKey: randomUUID() }, fx.sale2)],
      ['RESERVED attempt', checkoutRow(fx, b, fx.sale2)],
    ] as const) {
      const e = await db.probe(...insertSql('SaleCheckout', row));
      expect(e?.code, label).toBe(FK);
      expect(e?.constraint, label).toBe('SaleCheckout_attempt_fkey');
    }
    await confirm(db, b.id, fx.starter, HASH_B);
    for (const [label, row] of [
      ['other hash', checkoutRow(fx, b, fx.sale2, 'c'.repeat(64))],
      ['other sale', checkoutRow(fx, b, fx.sale3)],
    ] as const) {
      const e = await db.probe(...insertSql('SaleCheckout', row));
      expect(e?.code, label).toBe(FK);
      expect(e?.constraint, label).toBe('SaleCheckout_attempt_fkey');
    }
    expect(await db.probe(...insertSql('SaleCheckout', checkoutRow(fx, b, fx.sale2)))).toBeNull();
  });

  it('P2b CHARGED declaration FK crossed: other attempt, other sale, other branch, other method', async () => {
    const x = await insertAttempt(db, fx, { tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 5000n }, { method: 'CARD_DEBIT', role: 'FIXED', source: 'NEW', amount: 5000n }] });
    const y = await insertAttempt(db, fx, { sale: fx.sale2, tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 5000n }] });
    await abandon(db, x.id, fx.starter);
    await abandon(db, y.id, fx.starter);
    const ofY = await insertCollection(db, fx, { originSale: fx.sale2, originAttempt: y.id });
    const ofX = await insertCollection(db, fx, { method: 'TRANSFER', originAttempt: x.id });
    const base: DeclRow = { method: 'TRANSFER', source: 'NEW', outcome: 'CHARGED', evidence: 'comp 1' };
    const [otherBranchSql, otherBranchParams] = declSql(fx, x.id, x.sale, { ...base, collection: ofX });
    otherBranchParams[3] = fx.branch2; // branchId
    // Other sale / other branch break BOTH the attempt FK and the collection FK;
    // PostgreSQL reports whichever RI trigger fires first, so either is accepted.
    const BOTH = ['CheckoutAttemptDeclaration_attempt_fkey', 'CheckoutAttemptDeclaration_collection_fkey'];
    const cases: Array<[string, [string, unknown[]], string[]]> = [
      ['other attempt', declSql(fx, x.id, x.sale, { ...base, collection: ofY }), ['CheckoutAttemptDeclaration_collection_fkey']],
      ['other sale', declSql(fx, x.id, fx.sale2, { ...base, collection: ofX }), BOTH],
      ['other branch', [otherBranchSql, otherBranchParams], BOTH],
      ['other method', declSql(fx, x.id, x.sale, { ...base, method: 'CARD_DEBIT', collection: ofX }), ['CheckoutAttemptDeclaration_collection_fkey']],
    ];
    for (const [label, [sql, params], constraints] of cases) {
      const e = await db.probe(sql, params);
      expect(e?.code, `${label}: ${e?.message ?? 'accepted'}`).toBe(FK);
      expect(constraints, label).toContain(e?.constraint);
    }
    expect(await db.probe(...declSql(fx, x.id, x.sale, { ...base, collection: ofX }))).toBeNull();
  });

  // ---------------------------------------------------------------- P3 F1
  it('P3a F1 transition matrix: from each of the four statuses to each status; only RESERVED → terminal is allowed', async () => {
    const now = new Date();
    const target: Record<string, Row> = {
      RESERVED: {},
      CONFIRMED: { confirmationHash: HASH_B, confirmedById: fx.starter, confirmedAt: now },
      REJECTED: { rejectionCode: 'NO_OPEN_CASH_SESSION', rejectedById: fx.starter, rejectedAt: now },
      ABANDONED: { abandonedById: fx.starter, abandonedAt: now },
    };
    const reach = async (from: string, sale: string) => {
      const a = await insertAttempt(db, fx, { sale });
      if (from === 'CONFIRMED') await confirm(db, a.id, fx.starter);
      if (from === 'REJECTED') await reject(db, a.id, fx.starter);
      if (from === 'ABANDONED') {
        await abandon(db, a.id, fx.starter);
        await declare(db, fx, a.id, [{ method: 'CASH', source: 'NEW', outcome: 'NONE' }], sale);
        await markDeclared(db, a.id, fx.starter);
      }
      return a;
    };
    const statuses = ['RESERVED', 'CONFIRMED', 'REJECTED', 'ABANDONED'];
    const sales = [fx.sale, fx.sale2, fx.sale3, fx.sale4];
    for (const [i, from] of statuses.entries()) {
      const a = await reach(from, sales[i]!);
      for (const to of statuses) {
        // Full target shape: the target's fields set, every other outcome column cleared (declaration left as is).
        const cleared = Object.fromEntries(OUTCOME_COLUMNS.filter((c) => !DECLARED_COLS.includes(c)).map((c) => [c, null]));
        const set: Row = { status: to, ...cleared, ...target[to] };
        const cols = Object.keys(set);
        const error = await db.probe(`UPDATE "CheckoutAttempt" SET ${cols.map((c, j) => `"${c}" = $${j + 2}`).join(', ')} WHERE "id" = $1`, [a.id, ...Object.values(set)]);
        const label = `${from} → ${to}`;
        if (from === 'RESERVED') expect(error, `${label}: ${error?.message}`).toBeNull(); // incl. the RESERVED no-op rewrite
        else {
          expect(error?.code, `${label}: ${error?.message ?? 'accepted'}`).toBe(CHECK);
          expect(error?.message, label).toMatch(/status transition not allowed|outcome is immutable|written once/);
        }
      }
    }
  });

  it('P3b F1 every plan and snapshot column is immutable, in RESERVED and after CONFIRMED; no unsealing; no delete; frozen outcome and declaration', async () => {
    const snap = { pricingConfigId: 'cfg', pricingConfigUpdatedAt: new Date('2026-10-01T00:00:00Z'), fullPriceTransfer: 10100, fullPriceDebit: 10200, transferAdjustmentBps: 100, debitAdjustmentBps: 200 };
    const changes: Record<string, unknown> = {
      id: randomUUID(), saleId: fx.sale4, branchId: fx.branch2, reserveKey: randomUUID(), operationKey: randomUUID(), planHash: HASH_B,
      cashSessionId: randomUUID(), balanceMethod: 'TRANSFER', expectedTotal: 20000, expectedBalanceAmount: 6000, tenderCount: 2,
      fullPriceCash: 20000, fullPriceTransfer: 20100, fullPriceDebit: 20200, transferAdjustmentBps: 101, debitAdjustmentBps: 201,
      pricingConfigId: 'cfg2', pricingConfigUpdatedAt: new Date('2026-10-02T00:00:00Z'), algorithmVersion: 2, startedById: fx.other,
      startedAt: new Date('2026-01-01T00:00:00Z'), recoveryReason: 'otro motivo distinto', recoveryEvidence: 'otro 1',
    };
    const a = await insertAttempt(db, fx, { extra: { ...snap, recoveryReason: 'stock vencido, cupón 1', recoveryEvidence: 'cupón 1' } });
    for (const phase of ['RESERVED', 'CONFIRMED']) {
      if (phase === 'CONFIRMED') await confirm(db, a.id, fx.starter);
      for (const [col, value] of Object.entries(changes)) {
        const error = await db.probe(`UPDATE "CheckoutAttempt" SET "${col}" = $2 WHERE "id" = $1`, [a.id, value]);
        expect(error?.code, `${phase} ${col}`).toBe(CHECK);
        expect(error?.message, `${phase} ${col}`).toMatch(/plan is immutable/);
      }
      for (const col of ['fullPriceTransfer', 'pricingConfigId', 'recoveryReason']) {
        const error = await db.probe(`UPDATE "CheckoutAttempt" SET "${col}" = NULL WHERE "id" = $1`, [a.id]);
        expect(error?.message, `${phase} ${col} NULL`).toMatch(/plan is immutable/);
      }
      expect((await db.probe(`UPDATE "CheckoutAttempt" SET "planSealed" = false WHERE "id" = $1`, [a.id]))?.message).toMatch(/planSealed only goes/);
      expect((await db.probe(`DELETE FROM "CheckoutAttempt" WHERE "id" = $1`, [a.id]))?.message).toMatch(/permanent/);
    }
    for (const [col, value] of [['confirmedAt', new Date(0)], ['confirmationHash', 'c'.repeat(64)], ['confirmedById', fx.other]] as const) {
      const error = await db.probe(`UPDATE "CheckoutAttempt" SET "${col}" = $2 WHERE "id" = $1`, [a.id, value]);
      expect(error?.message, col).toMatch(/outcome is immutable/);
    }
    const r = await insertAttempt(db, fx, { sale: fx.sale2 });
    await reject(db, r.id, fx.starter);
    await declare(db, fx, r.id, [{ method: 'CASH', source: 'NEW', outcome: 'NONE' }], fx.sale2);
    await markDeclared(db, r.id, fx.starter);
    for (const [col, value] of [['declaredAt', new Date(0)], ['declaredById', fx.other], ['rejectionCode', 'OTHER_CODE'], ['rejectedAt', new Date(0)]] as const) {
      const error = await db.probe(`UPDATE "CheckoutAttempt" SET "${col}" = $2 WHERE "id" = $1`, [r.id, value]);
      expect(error?.message, col).toMatch(/written once|outcome is immutable/);
    }
    const live = await insertAttempt(db, fx, { sale: fx.sale3 });
    expect((await db.probe(`UPDATE "CheckoutAttempt" SET "declaredById"=$2,"declaredAt"=now() WHERE "id"=$1`, [live.id, fx.starter]))?.code).toBe(CHECK);
  });

  it('P3c F1 every terminal column of every terminal state cannot be rewritten (to another value or to NULL)', async () => {
    const now = new Date();
    const terminal = async (sale: string, set: Row) => {
      const a = await insertAttempt(db, fx, { sale });
      const cols = Object.keys(set);
      await db.q(`UPDATE "CheckoutAttempt" SET ${cols.map((c, j) => `"${c}" = $${j + 2}`).join(', ')} WHERE "id" = $1`, [a.id, ...Object.values(set)]);
      return a.id;
    };
    const states: Array<[string, string]> = [
      ['CONFIRMED self', await terminal(fx.sale, { status: 'CONFIRMED', confirmationHash: HASH_B, confirmedById: fx.starter, confirmedAt: now })],
      ['CONFIRMED supervisor', await terminal(fx.sale, { status: 'CONFIRMED', confirmationHash: HASH_B, confirmedById: fx.other, confirmedAt: now, confirmReason: 'motivo del supervisor', confirmEvidence: 'cupón 123' })],
      ['REJECTED', await terminal(fx.sale2, { status: 'REJECTED', rejectionCode: 'NO_OPEN_CASH_SESSION', rejectionDetails: '{"v":1}', rejectedById: fx.starter, rejectedAt: now })],
      ['ABANDONED self', await terminal(fx.sale3, { status: 'ABANDONED', abandonedById: fx.starter, abandonedAt: now })],
      ['ABANDONED supervisor', await terminal(fx.sale4, { status: 'ABANDONED', abandonedById: fx.other, abandonedAt: now, abandonReason: 'motivo del supervisor', abandonEvidence: 'cupón 123' })],
    ];
    // A value different from anything stored above, per terminal column.
    const other: Row = {
      confirmationHash: 'c'.repeat(64), confirmedById: randomUUID(), confirmedAt: new Date(0),
      confirmReason: 'otro motivo diferente', confirmEvidence: 'otra 1',
      rejectionCode: 'OTHER_CODE', rejectionDetails: '{"x":2}', rejectedById: randomUUID(), rejectedAt: new Date(0),
      abandonedById: randomUUID(), abandonedAt: new Date(0), abandonReason: 'otro motivo diferente', abandonEvidence: 'otra 1',
    };
    expect(Object.keys(other).sort()).toEqual(OUTCOME_COLUMNS.filter((c) => !DECLARED_COLS.includes(c)).sort());
    for (const [label, id] of states) {
      const stored = (await db.q(`SELECT * FROM "CheckoutAttempt" WHERE "id" = $1`, [id]))[0]!;
      for (const [col, value] of Object.entries(other)) {
        for (const next of present(stored, col) ? [value, null] : [value]) {
          const error = await db.probe(`UPDATE "CheckoutAttempt" SET "${col}" = $2 WHERE "id" = $1`, [id, next]);
          expect(error?.code, `${label} ${col} → ${show(next)}: ${error?.message ?? 'accepted'}`).toBe(CHECK);
          expect(error?.message, `${label} ${col}`).toMatch(/outcome is immutable/);
        }
      }
    }
  });

  // ---------------------------------------------------------------- P4 F2/F3
  it('P4 F2/F3: no late or modified tenders; unsealed, short or wrong-balance plans fail only at commit', async () => {
    const a = await insertAttempt(db, fx);
    await db.fails(CHECK, `INSERT INTO "CheckoutAttemptTender"("id","attemptId","branchId","method","role","source","amount") VALUES ($1,$2,$3,'TRANSFER','FIXED','NEW',100)`,
      [randomUUID(), a.id, fx.branch], /unsealed RESERVED/);
    await db.fails(CHECK, `UPDATE "CheckoutAttemptTender" SET "amount" = NULL WHERE "attemptId" = $1`, [a.id], /immutable/);
    await db.fails(CHECK, `DELETE FROM "CheckoutAttemptTender" WHERE "attemptId" = $1`, [a.id], /immutable/);
    const bad: Array<Parameters<typeof insertAttempt>[2]> = [
      { seal: false },                                                                  // unsealed
      { tenderCount: 2 },                                                               // fewer tenders than declared
      { balanceMethod: 'TRANSFER' },                                                    // BALANCE in another method
      { tenders: [{ method: 'CASH', role: 'FIXED', source: 'NEW', amount: 100n }] },   // no BALANCE at all
    ];
    for (const opts of bad) {
      await db.atCommit(CHECK, async () => { await insertAttempt(db, fx, { sale: fx.sale2, ...opts }); }, /plan incomplete/);
    }
    // sealed plan with two valid tenders but tenderCount = 1: every statement is
    // accepted (no CHECK, index, FK or immediate trigger objects); only F3 at COMMIT refuses it.
    const twoTenders = async () => {
      await insertAttempt(db, fx, { sale: fx.sale3, tenderCount: 1, tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 5000n }] });
    };
    expect(await db.attempt(twoTenders, false)).toBeNull();
    const atCommit = await db.attempt(twoTenders, true);
    expect(atCommit?.code).toBe(CHECK);
    expect(atCommit?.constraint).toBeUndefined();
    expect(atCommit?.message).toMatch(/CheckoutAttempt plan incomplete at commit/);
  });

  // ---------------------------------------------------------------- P5 F4/F5/F6
  it('P5 F4/F5/F6: declarations only on terminal undeclared attempts, evidence for non-initiators, no loose declarations, immutable rows', async () => {
    const live = await insertAttempt(db, fx);
    const cashNone = (attempt: string, sale: string, by: string, evidence: string | null = null) => declSql(fx, attempt, sale, { method: 'CASH', source: 'NEW', outcome: 'NONE', by, evidence });
    await db.fails(CHECK, ...cashNone(live.id, fx.sale, fx.starter), /not open for declaration/);
    await abandon(db, live.id, fx.starter);
    await db.fails(CHECK, ...cashNone(live.id, fx.sale, fx.other), /requires evidence/);
    expect(await db.probe(...cashNone(live.id, fx.sale, fx.other, 'vi el cupón'))).toBeNull();
    // A loose declaration (no declaredAt) is accepted as a statement and refused only at commit.
    expect(await db.probe(...cashNone(live.id, fx.sale, fx.starter))).toBeNull();
    expect((await db.probe(...cashNone(live.id, fx.sale, fx.starter), true))?.code).toBe(CHECK);
    await db.fails(CHECK, `INSERT INTO "ExternalCollection"("id","branchId","method","amount","reference","referenceKey","institution","status","originSaleId","originAttemptId","recordedById")
      VALUES ($1,$2,'TRANSFER',5000,'R3S1APP','R3S1APP','MACRO','APPLIED',$3,$4,$5)`, [randomUUID(), fx.branch, fx.sale, live.id, fx.starter], /starts UNAPPLIED/);
    const confirmed = await insertAttempt(db, fx, { sale: fx.sale2 });
    await confirm(db, confirmed.id, fx.starter);
    await db.fails(CHECK, ...cashNone(confirmed.id, fx.sale2, fx.starter), /not open for declaration/);
    await declare(db, fx, live.id, [{ method: 'CASH', source: 'NEW', outcome: 'NONE' }]);
    await db.fails(CHECK, `UPDATE "CheckoutAttemptDeclaration" SET "evidence" = 'otro 1' WHERE "attemptId" = $1`, [live.id], /immutable/);
    await db.fails(CHECK, `DELETE FROM "CheckoutAttemptDeclaration" WHERE "attemptId" = $1`, [live.id], /immutable/);
    // CHARGED over a collection that is no longer UNAPPLIED (REFUNDED) is refused by F4.
    const z = await insertAttempt(db, fx, { sale: fx.sale3, tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 5000n }] });
    await abandon(db, z.id, fx.starter);
    const refunded = await insertCollection(db, fx, { originSale: fx.sale3, originAttempt: z.id });
    await db.q(`UPDATE "ExternalCollection" SET "status"='REFUNDED',"resolvedById"=$2,"resolvedAt"=now(),"refundReference"='DEV1',"resolutionNote"='devolución hecha afuera',"externalRefundedAt"=now() - interval '1 hour' WHERE "id"=$1`, [refunded, fx.starter]);
    await db.fails(CHECK, ...declSql(fx, z.id, fx.sale3, { method: 'TRANSFER', source: 'NEW', outcome: 'CHARGED', collection: refunded, evidence: 'comp 1' }), /UNAPPLIED collection/);
  });

  it('P5b trigger timing: F1/F2/F4/F6 raise at the statement; F3/F5 only when deferred constraints are checked', async () => {
    const rows = await db.q(`SELECT t.tgname, t.tgdeferrable, t.tginitdeferred FROM pg_trigger t
      WHERE NOT t.tgisinternal AND t.tgfoid IN (SELECT oid FROM pg_proc WHERE proname IN
      ('fn_checkout_attempt_guard','fn_checkout_attempt_tender_guard','fn_checkout_attempt_commit_check',
       'fn_checkout_attempt_declaration_guard','fn_checkout_declaration_commit_check','fn_external_collection_guard'))
      ORDER BY t.tgname`);
    expect(rows).toEqual([
      { tgname: 'trg_checkout_attempt_commit_check', tgdeferrable: true, tginitdeferred: true },
      { tgname: 'trg_checkout_attempt_declaration_guard', tgdeferrable: false, tginitdeferred: false },
      { tgname: 'trg_checkout_attempt_guard', tgdeferrable: false, tginitdeferred: false },
      { tgname: 'trg_checkout_attempt_tender_guard', tgdeferrable: false, tginitdeferred: false },
      { tgname: 'trg_checkout_declaration_commit_check', tgdeferrable: true, tginitdeferred: true },
      { tgname: 'trg_external_collection_guard', tgdeferrable: false, tginitdeferred: false },
    ]);
    const [sql, params] = insertSql('CheckoutAttempt', planRow(fx, fx.sale));
    expect(await db.probe(sql, params)).toBeNull();
    expect((await db.probe(sql, params, true))?.message).toMatch(/plan incomplete/);
    const a = await insertAttempt(db, fx, { sale: fx.sale2 });
    expect((await db.probe(`DELETE FROM "CheckoutAttempt" WHERE "id" = $1`, [a.id]))?.message).toMatch(/permanent/);
    expect((await db.probe(`DELETE FROM "CheckoutAttemptTender" WHERE "attemptId" = $1`, [a.id]))?.message).toMatch(/immutable/);
    const e = await insertCollection(db, fx);
    expect((await db.probe(`DELETE FROM "ExternalCollection" WHERE "id" = $1`, [e]))?.message).toMatch(/permanent/);
  });

  it('P5c R3-A2 positive control: an APPLIED collection without originAttemptId nor claimAttemptId, and UNAPPLIED incidents, are accepted', async () => {
    await db.atCommit(null, async () => {
      const a = await insertAttempt(db, fx, { tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 5000n }] });
      await confirm(db, a.id, fx.starter);
      const checkout = await insertCheckout(db, fx, a, fx.sale);
      const applied = await insertCollection(db, fx, { status: 'APPLIED', appliedCheckout: checkout, appliedSale: fx.sale });
      expect(await db.q(`SELECT "status","originAttemptId","claimAttemptId" FROM "ExternalCollection" WHERE "id" = $1`, [applied]))
        .toEqual([{ status: 'APPLIED', originAttemptId: null, claimAttemptId: null }]);
      await insertCollection(db, fx, { originSale: fx.sale2 });
      await insertCollection(db, fx, { originSale: null, method: 'CARD_DEBIT' });
    });
  });

  // ---------------------------------------------------------------- P23
  it('P23 C2: COLLECTION never CHARGED; every financial/origin column immutable; no delete; single declaring actor', async () => {
    const c = await insertCollection(db, fx, { method: 'CARD_DEBIT', amount: 3000n, originSale: fx.sale2 });
    const a = await insertAttempt(db, fx, { tenders: [CASH_BALANCE, { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 3000n, collection: c }] });
    await abandon(db, a.id, fx.starter);
    const e1 = await db.probe(...declSql(fx, a.id, fx.sale, { method: 'CARD_DEBIT', source: 'COLLECTION', outcome: 'CHARGED', collection: c, evidence: 'comp 1' }));
    expect(e1?.code).toBe(CHECK);
    // Close `a` correctly (T-X order) so it is valid when deferred checks are forced below.
    await declare(db, fx, a.id, [{ method: 'CASH', source: 'NEW', outcome: 'NONE' }, { method: 'CARD_DEBIT', source: 'COLLECTION', outcome: 'NONE' }]);
    await markDeclared(db, a.id, fx.starter);
    await db.q(`UPDATE "ExternalCollection" SET "claimAttemptId" = NULL WHERE "claimAttemptId" = $1`, [a.id]);
    const e = await insertCollection(db, fx, { originSale: fx.sale3 });
    for (const [col, value] of [
      ['id', randomUUID()], ['branchId', fx.branch2], ['method', 'CARD_DEBIT'], ['amount', 1], ['reference', 'OTHER1'], ['referenceKey', 'OTHER1'],
      ['institution', 'BBVA'], ['institutionOther', 'x'], ['originSaleId', fx.sale2], ['originAttemptId', a.id],
      ['cashSessionId', null], ['recordedById', fx.other], ['recordedAt', new Date(0)], ['incidentReason', 'x'],
    ] as const) {
      const error = await db.probe(`UPDATE "ExternalCollection" SET "${col}" = $2 WHERE "id" = $1`, [e, value]);
      expect(error?.message, col).toMatch(/financial and origin data are immutable/);
    }
    await db.fails(CHECK, `DELETE FROM "ExternalCollection" WHERE "id" = $1`, [e], /permanent/);
    const d = await insertAttempt(db, fx, { sale: fx.sale3, tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 5000n }] });
    await db.atCommit(CHECK, async () => {
      await reject(db, d.id, fx.starter);
      await declare(db, fx, d.id, [{ method: 'CASH', source: 'NEW', outcome: 'NONE' }], fx.sale3);
      await declare(db, fx, d.id, [{ method: 'TRANSFER', source: 'NEW', outcome: 'NONE', evidence: 'vi 1', by: fx.other }], fx.sale3);
      await markDeclared(db, d.id, fx.starter);
    }, /by the declaring actor/);
    await reject(db, d.id, fx.starter);
    const byOther = await insertCollection(db, fx, { originSale: fx.sale3, originAttempt: d.id, recordedBy: fx.other });
    await db.fails(CHECK, ...declSql(fx, d.id, fx.sale3, { method: 'TRANSFER', source: 'NEW', outcome: 'CHARGED', collection: byOther, evidence: 'comp 1' }), /recorded by the declarer/);
  });

  // ---------------------------------------------------------------- P33–P35
  it('P33 claim transitions (F6): no X→Y, no release while RESERVED, APPLIED only by the claiming attempt, REFUNDED never claimed, frozen once APPLIED', async () => {
    const c = await insertCollection(db, fx, { originSale: fx.sale });
    const a = await insertAttempt(db, fx, { tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 5000n, collection: c }] });
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "claimAttemptId" = NULL WHERE "id" = $1`, [c], /completed declaration/);
    const b = await insertAttempt(db, fx, { sale: fx.sale2 });
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "claimAttemptId" = $2 WHERE "id" = $1`, [c, b.id], /cannot move/);
    await confirm(db, b.id, fx.starter);
    const scB = await insertCheckout(db, fx, b, fx.sale2);
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "status"='APPLIED',"appliedCheckoutId"=$2,"appliedSaleId"=$3 WHERE "id"=$1`, [c, scB, fx.sale2], /claiming attempt/);
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "status"='REFUNDED',"resolvedById"=$2,"resolvedAt"=now(),"refundReference"='DEV1',"resolutionNote"='devolución hecha afuera',"externalRefundedAt"=now() WHERE "id"=$1`, [c, fx.starter]);
    await db.atCommit(null, async () => {
      await confirm(db, a.id, fx.starter);
      const scA = await insertCheckout(db, fx, a, fx.sale);
      await db.q(`UPDATE "ExternalCollection" SET "status"='APPLIED',"appliedCheckoutId"=$2,"appliedSaleId"=$3 WHERE "id"=$1`, [c, scA, fx.sale]);
    });
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "status"='UNAPPLIED',"appliedCheckoutId"=NULL,"appliedSaleId"=NULL WHERE "id"=$1`, [c]);
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "claimAttemptId" = NULL WHERE "id" = $1`, [c], /only while UNAPPLIED/);
    const free = await insertCollection(db, fx, { originSale: fx.sale4 });
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "status"='APPLIED',"appliedCheckoutId"=$2,"appliedSaleId"=$3 WHERE "id"=$1`, [free, scB, fx.sale2], /claiming attempt/);
  });

  it('P34 F3 claim state at commit: an open plan must claim its COLLECTION tenders; a declared attempt must hold none', async () => {
    const c = await insertCollection(db, fx);
    await db.atCommit(CHECK, async () => {
      await insertAttempt(db, fx, { claim: false, tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 5000n, collection: c }] });
    }, /UNAPPLIED claim/);
    const a = await insertAttempt(db, fx, { tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 5000n, collection: c }] });
    await db.atCommit(CHECK, async () => {
      await abandon(db, a.id, fx.starter);
      await declare(db, fx, a.id, [{ method: 'CASH', source: 'NEW', outcome: 'NONE' }, { method: 'TRANSFER', source: 'COLLECTION', outcome: 'NONE' }]);
      await markDeclared(db, a.id, fx.starter);
    }, /must not hold any claim/);
  });

  it('P35 chk_ec_refund_fields: REFUNDED needs reason 10..500, external date <= resolvedAt, no claim; the date exists only on REFUNDED', async () => {
    const e = await insertCollection(db, fx);
    for (const [label, note, when] of [
      ['no note', null, `now() - interval '1 hour'`],
      ['no external date', 'devolución hecha afuera', 'NULL'],
      ['external date after resolvedAt', 'devolución hecha afuera', `now() + interval '1 hour'`],
      ['note 9 chars', text(9), `now() - interval '1 hour'`],
      ['note 501 chars', text(501), `now() - interval '1 hour'`],
    ] as const) {
      const error = await db.probe(`UPDATE "ExternalCollection" SET "status"='REFUNDED',"resolvedById"=$2,"resolvedAt"=now(),"refundReference"='DEV1',"resolutionNote"=$3,"externalRefundedAt"=${when} WHERE "id"=$1`, [e, fx.starter, note]);
      expect(error?.code, label).toBe(CHECK);
      expect(error?.constraint, label).toBe('chk_ec_refund_fields');
    }
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "externalRefundedAt" = now() WHERE "id" = $1`, [e]);
    const ins = await db.probe(`INSERT INTO "ExternalCollection"("id","branchId","method","amount","reference","referenceKey","status","recordedById","externalRefundedAt")
      VALUES ($1,$2,'CARD_DEBIT',5000,'R3S1DT','R3S1DT','UNAPPLIED',$3,now())`, [randomUUID(), fx.branch, fx.starter]);
    expect(ins?.constraint).toBe('chk_ec_refund_fields');
    await db.atCommit(null, async () => {
      await db.q(`UPDATE "ExternalCollection" SET "status"='REFUNDED',"resolvedById"=$2,"resolvedAt"=now(),"refundReference"='DEV1',"resolutionNote"=$3,"externalRefundedAt"=now() - interval '1 hour' WHERE "id"=$1`, [e, fx.starter, text(10)]);
    });
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "resolutionNote" = 'otra nota distinta' WHERE "id" = $1`, [e], /write-once/);
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "status" = 'UNAPPLIED' WHERE "id" = $1`, [e]);
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "status" = 'APPLIED' WHERE "id" = $1`, [e]);
  });

  // ---------------------------------------------------------------- P47–P53
  it('P47 a CASH-only attempt cannot claim a collection outside its plan', async () => {
    const e = await insertCollection(db, fx);
    const a = await insertAttempt(db, fx, { seal: false });
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "claimAttemptId" = $2 WHERE "id" = $1`, [e, a.id], /Claim requires/);
  });

  it('P48 an attempt holding collection A as COLLECTION cannot claim collection B', async () => {
    const ca = await insertCollection(db, fx);
    const cb = await insertCollection(db, fx);
    const a = await insertAttempt(db, fx, { seal: false, claim: false, tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 5000n, collection: ca }] });
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "claimAttemptId" = $2 WHERE "id" = $1`, [cb, a.id], /Claim requires/);
  });

  it('P49 a sealed (RESERVED or CONFIRMED) attempt cannot claim later', async () => {
    const c = await insertCollection(db, fx);
    const a = await insertAttempt(db, fx, { claim: false, tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 5000n, collection: c }] });
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "claimAttemptId" = $2 WHERE "id" = $1`, [c, a.id], /Claim requires/);
    await confirm(db, a.id, fx.starter);
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "claimAttemptId" = $2 WHERE "id" = $1`, [c, a.id], /Claim requires/);
  });

  it('P50 a REJECTED attempt without declaration cannot release its claim by direct UPDATE', async () => {
    const c = await insertCollection(db, fx);
    const a = await insertAttempt(db, fx, { tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 5000n, collection: c }] });
    await reject(db, a.id, fx.starter);
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "claimAttemptId" = NULL WHERE "id" = $1`, [c], /completed declaration/);
  });

  it('P51 partial declarations + declaredAt + release: the release passes F6 but the transaction fails at commit (F3); the claim survives', async () => {
    const c = await insertCollection(db, fx);
    const a = await insertAttempt(db, fx, { tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 5000n, collection: c }] });
    await reject(db, a.id, fx.starter);
    await db.atCommit(CHECK, async () => {
      await declare(db, fx, a.id, [{ method: 'CASH', source: 'NEW', outcome: 'NONE' }]);
      await markDeclared(db, a.id, fx.starter);
      await db.q(`UPDATE "ExternalCollection" SET "claimAttemptId" = NULL WHERE "id" = $1`, [c]);
    }, /cover every tender/);
    expect(await db.q(`SELECT "claimAttemptId" FROM "ExternalCollection" WHERE "id" = $1`, [c])).toEqual([{ claimAttemptId: a.id }]);
    expect(await db.q(`SELECT 1 FROM "CheckoutAttemptDeclaration" WHERE "attemptId" = $1`, [a.id])).toHaveLength(0);
  });

  it('P52 releasing the claim before declaredAt (wrong order) fails immediately', async () => {
    const c = await insertCollection(db, fx);
    const a = await insertAttempt(db, fx, { tenders: [CASH_BALANCE, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: 5000n, collection: c }] });
    await reject(db, a.id, fx.starter);
    await declare(db, fx, a.id, [{ method: 'CASH', source: 'NEW', outcome: 'NONE' }, { method: 'TRANSFER', source: 'COLLECTION', outcome: 'NONE' }]);
    await db.fails(CHECK, `UPDATE "ExternalCollection" SET "claimAttemptId" = NULL WHERE "id" = $1`, [c], /completed declaration/);
  });

  it('P53 full T-X with COLLECTION, CHARGED and CASH RETURNED commits; no claim left; the released collection can be claimed again', async () => {
    const cd = await insertCollection(db, fx, { method: 'CARD_DEBIT', amount: 3000n });
    const a = await insertAttempt(db, fx, { tenders: [
      CASH_BALANCE,
      { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 5000n },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 3000n, collection: cd },
    ] });
    let charged = '';
    await db.atCommit(null, async () => {
      await abandon(db, a.id, fx.starter);
      charged = await insertCollection(db, fx, { method: 'TRANSFER', amount: 5000n, originAttempt: a.id });
      await declare(db, fx, a.id, [
        { method: 'CASH', source: 'NEW', outcome: 'RETURNED', returned: 2000n, evidence: 'recibo 1' },
        { method: 'TRANSFER', source: 'NEW', outcome: 'CHARGED', collection: charged, evidence: 'comp 123' },
        { method: 'CARD_DEBIT', source: 'COLLECTION', outcome: 'NONE' },
      ]);
      await markDeclared(db, a.id, fx.starter);
      await db.q(`UPDATE "ExternalCollection" SET "claimAttemptId" = NULL WHERE "claimAttemptId" = $1`, [a.id]);
    });
    expect(await db.q(`SELECT 1 FROM "ExternalCollection" WHERE "claimAttemptId" = $1`, [a.id])).toHaveLength(0);
    expect(await db.q(`SELECT count(*)::int AS n FROM "CheckoutAttemptDeclaration" WHERE "attemptId" = $1`, [a.id])).toEqual([{ n: 3 }]);
    expect(await db.q(`SELECT "status","claimAttemptId" FROM "ExternalCollection" WHERE "id" = $1`, [charged])).toEqual([{ status: 'UNAPPLIED', claimAttemptId: null }]);
    await db.atCommit(null, async () => {
      await insertAttempt(db, fx, { tenders: [CASH_BALANCE, { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 3000n, collection: cd }] });
    });
  });

  it('one open attempt per sale (partial index); a declared terminal attempt frees the sale', async () => {
    const a = await insertAttempt(db, fx);
    const dup = await db.probe(...insertSql('CheckoutAttempt', planRow(fx, fx.sale)));
    expect(dup?.code).toBe('23505');
    expect(dup?.constraint).toBe('CheckoutAttempt_one_open_per_sale');
    await db.atCommit(null, async () => {
      await reject(db, a.id, fx.starter);
      await declare(db, fx, a.id, [{ method: 'CASH', source: 'NEW', outcome: 'NONE' }]);
      await markDeclared(db, a.id, fx.starter);
      await insertAttempt(db, fx);
    });
  });

  it.todo('P54 T-X releasing a claim vs T-R of another sale claiming it, 50 iterations (S4–S6 services)');
  it.todo('P55 T-X vs T-C of the same attempt in parallel (S5–S6 services)');
});

// --- Suite B: P21 atomicity on a cluster with the exact ledger 1–8 ----------------
const CATALOG_SNAPSHOT_SQL = `
SELECT 'type' AS k, t.typname || ':' || t.typtype::text AS v FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'enum', t.typname || ':' || e.enumlabel || ':' || e.enumsortorder FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'class', c.relname || ':' || c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'attr', c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull || ':' || a.atthasdef
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped
UNION ALL SELECT 'attrdef', c.relname || '.' || a.attname || ':' || pg_get_expr(d.adbin, d.adrelid)
  FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'constraint', c.relname || '.' || k.conname || ':' || pg_get_constraintdef(k.oid)
  FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'index', pg_get_indexdef(i.indexrelid)
  FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'proc', p.proname || '(' || pg_get_function_identity_arguments(p.oid) || '):' || md5(p.prosrc)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
UNION ALL SELECT 'trigger', c.relname || '.' || g.tgname || ':' || pg_get_triggerdef(g.oid)
  FROM pg_trigger g JOIN pg_class c ON c.oid = g.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT g.tgisinternal
ORDER BY 1, 2`;

async function snapshot(q: Pool | PoolClient): Promise<string> {
  const { rows } = await q.query<{ k: string; v: string }>(CATALOG_SNAPSHOT_SQL);
  return rows.map((r) => `${r.k}\t${r.v}`).join('\n');
}

type LedgerRow = { name: string; checksum: string; finished: boolean; rolledBack: boolean };
async function ledger(q: Pool | PoolClient): Promise<LedgerRow[]> {
  const { rows } = await q.query<LedgerRow>(`SELECT migration_name AS name, checksum, finished_at IS NOT NULL AS finished,
    rolled_back_at IS NOT NULL AS "rolledBack" FROM "_prisma_migrations" ORDER BY migration_name`);
  return rows;
}
const exactLedger1to8 = () => expectedLedgerBeforeMigration9().map((row) => ({ ...row, finished: true, rolledBack: false }));


describe.skipIf(!suiteB)('R3-A4.3 S1 — P21 migration 9 atomicity (exact ledger 1–8)', () => {
  let pool: Pool;
  // psql directly (no shell), credentials via libpq env + 0600 pass file, bound
  // to the url of the target proven in beforeAll.
  let runPsql: (sqlFile: string) => Promise<{ code: number; stderr: string }>;
  let baseline: string;
  let cleanupFailed = false;
  const original = readMigration(R3_ATTEMPTS_MIGRATION);
  const body = splitTopLevelStatements(original).slice(1, -1).map((s) => `${s};`).join('\n');

  const assertExactBaseState = async () => {
    expect(await hasAttemptTable(pool)).toBe(false);
    expect(await ledger(pool)).toEqual(exactLedger1to8());
  };

  beforeAll(async () => {
    const bound = await openBoundPool();
    pool = bound.pool;
    runPsql = createBoundPsqlRunner(bound.target.url, execFile);
    await assertExactBaseState();
    baseline = await snapshot(pool);
  });
  afterAll(async () => { await pool?.end(); });
  beforeEach(() => {
    if (cleanupFailed) throw new Error('a previous committed fixture was not cleaned up; refusing further writes');
  });

  it('P21a COMMITTED SaleCheckout row + COMPLETE migration file via psql → preflight check_violation; catalogs and ledger unchanged', async () => {
    const ids = { branch: randomUUID(), user: randomUUID(), register: randomUUID(), session: randomUUID(), sale: randomUUID(), checkout: randomUUID() };
    let failure: unknown = null;
    try {
      // Committed fixture (autocommit statements), as an R3-A2-only build would leave it.
      await pool.query(`INSERT INTO "Branch"("id","name","code","address","pointOfSaleNumber") VALUES ($1,'R3 P21a',$2,'Test',999001)`, [ids.branch, `r3-p21a-${ids.branch.slice(0, 8)}`]);
      await pool.query(`INSERT INTO "User"("id","name","email","passwordHash","updatedAt") VALUES ($1,'R3 P21a',$2,'not-used',now())`, [ids.user, `r3-p21a-${ids.user}@test.invalid`]);
      await pool.query(`INSERT INTO "CashRegister"("id","branchId","name") VALUES ($1,$2,'R3 P21a')`, [ids.register, ids.branch]);
      await pool.query(`INSERT INTO "CashSession"("id","registerId","openedById","startingCash") VALUES ($1,$2,$3,0)`, [ids.session, ids.register, ids.user]);
      await pool.query(`INSERT INTO "Sale"("id","branchId","sellerId","status","pricingModel","priceMode","subtotal","total","updatedAt")
        VALUES ($1,$2,$3,'PENDING_PAYMENT','PROPORTIONAL_V1','CASH',10000,10000,now())`, [ids.sale, ids.branch, ids.user]);
      await pool.query(`INSERT INTO "SaleCheckout"("id","saleId","branchId","pricingModel","operationKey","requestHash","cashSessionId","userId","balanceMethod","referenceSubtotal","total","fullPriceCash","algorithmVersion")
        VALUES ($1,$2,$3,'PROPORTIONAL_V1',$4,$5,$6,$7,'CASH',10000,10000,10000,1)`, [ids.checkout, ids.sale, ids.branch, randomUUID(), HASH_A, ids.session, ids.user]);
      expect((await pool.query(`SELECT count(*)::int AS n FROM "SaleCheckout" WHERE "id" = $1`, [ids.checkout])).rows).toEqual([{ n: 1 }]);

      // The REAL file, unmodified, with its own BEGIN/COMMIT; no outer transaction.
      const result = await runPsql(migrationPath(R3_ATTEMPTS_MIGRATION));
      expect(result.code, result.stderr).not.toBe(0);
      expect(result.stderr).toContain('R3-A4.3 preflight: SaleCheckout must be empty');

      expect(await snapshot(pool)).toBe(baseline);
      await assertExactBaseState();
      expect((await pool.query(`SELECT count(*)::int AS n FROM "SaleCheckout" WHERE "id" = $1`, [ids.checkout])).rows).toEqual([{ n: 1 }]);
    } catch (error) {
      failure = error;
    }
    // Exact ids only, reverse dependency order; a cleanup failure blocks further writes.
    const cleanupError = await (async () => {
      await pool.query(`DELETE FROM "SaleCheckout" WHERE "id" = $1`, [ids.checkout]);
      await pool.query(`DELETE FROM "Sale" WHERE "id" = $1`, [ids.sale]);
      await pool.query(`DELETE FROM "CashSession" WHERE "id" = $1`, [ids.session]);
      await pool.query(`DELETE FROM "CashRegister" WHERE "id" = $1`, [ids.register]);
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user]);
      await pool.query(`DELETE FROM "Branch" WHERE "id" = $1`, [ids.branch]);
      const left = await pool.query(`SELECT (SELECT count(*) FROM "SaleCheckout" WHERE "id" = $1) + (SELECT count(*) FROM "Sale" WHERE "id" = $2)
        + (SELECT count(*) FROM "CashSession" WHERE "id" = $3) + (SELECT count(*) FROM "CashRegister" WHERE "id" = $4)
        + (SELECT count(*) FROM "User" WHERE "id" = $5) + (SELECT count(*) FROM "Branch" WHERE "id" = $6) AS n`,
      [ids.checkout, ids.sale, ids.session, ids.register, ids.user, ids.branch]);
      if (Number(left.rows[0].n) !== 0) throw new Error('P21a fixture rows remain after cleanup');
      return null;
    })().catch((error: unknown) => error);
    if (cleanupError !== null) {
      cleanupFailed = true;
      throw failure === null ? cleanupError : new AggregateError([failure, cleanupError], 'P21a failed and its cleanup failed too');
    }
    if (failure !== null) throw failure;
  });

  it('P21b instrumented copy (exact R3-T pin required) fails late with the injected error; catalogs and ledger identical to the baseline', async () => {
    // The pin is authoritative from R3-T (U1). A mismatch FAILS CLOSED: a
    // well-formed 64-hex hash proves nothing; only the exact pinned bytes do.
    const pin = checkMigration9Pin(original);
    expect(pin.status, `P21b requires the authoritative R3-T pin for migration 9 (current sha256 ${pin.actual})`).toBe('MATCH');
    const copy = deriveP21bInstrumentedCopy(original);
    expect(insertedLines(original, copy)?.lines).toEqual([P21B_INJECTION]);
    const dir = mkdtempSync(path.join(tmpdir(), 'r3-p21b-'));
    try {
      const file = path.join(dir, 'migration.instrumented.sql');
      writeFileSync(file, copy, { mode: 0o600, flag: 'wx' });
      const result = await runPsql(file);
      expect(result.code, result.stderr).not.toBe(0);
      expect(result.stderr).toContain('P21b injected late failure');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await snapshot(pool)).toBe(baseline);
    await assertExactBaseState();
  });

  it('P21b positive control: the real body inside a rolled-back transaction changes the snapshot with the migration-9 objects', async () => {
    const client = await pool.connect();
    let during: string;
    try {
      await client.query('BEGIN');
      try {
        await client.query(body);
        during = await snapshot(client);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
    expect(during).not.toBe(baseline);
    for (const object of ['class\tCheckoutAttempt:r', 'attr\tExternalCollection.claimAttemptId:text:false:false', 'proc\tfn_external_collection_guard():']) {
      expect(during).toContain(object);
      expect(baseline).not.toContain(object);
    }
    expect(await snapshot(pool)).toBe(baseline);
    await assertExactBaseState();
  });

  it.todo('P21c P21a through the repository migration tool: failed ledger row, startup gate rejects the database (S9/S11)');
  it.todo('P21d clean base: the real file applies completely; R3-T LOCAL_TEST fingerprint matches (S11)');
});
