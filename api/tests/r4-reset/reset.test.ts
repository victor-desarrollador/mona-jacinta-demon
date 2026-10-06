import { describe, expect, it } from 'vitest';
import { readLocalTestTarget } from '../../scripts/demo-database.js';
import { APPLICATION_TABLES } from '../../scripts/local-test-baseline.js';
import {
  countSql, dropFunctionSql, dropTableSql, dropTypeSql, KNOWN_TRIGGER_FUNCTIONS, evaluateResetGate, ResetRefusal, resetDisposableLocalTest, RESET_EXPECTED_MARKER_VAR, RESET_TOKEN_VALUE, RESET_TOKEN_VAR, ROW_CEILING,
  SQL_BEGIN, SQL_COMMIT, SQL_EXTENSIONS, SQL_FOREIGN_SCHEMAS, SQL_LOCK_MARKER, SQL_LOCK_TIMEOUT, SQL_MARKER_DIGEST, SQL_PUBLIC_OBJECTS, SQL_ROLLBACK, SQL_SEARCH_PATH, SQL_SESSIONS,
  type ResetClient, type ResetCode, type ResetDeps,
} from './reset.js';

// DB-free: R01..R29 of RESET-PREREGISTRATION.md against a scripted in-memory connection.
const MARKER = '521a2e1c-9a21-4e57-af4f-24cdd32d7818';
const OTHER_MARKER = '11111111-1111-4111-8111-111111111111';
const FOUR_OF_FIVE_TABLES = [...APPLICATION_TABLES.filter((t) => t !== 'ProductVariant'), '_prisma_migrations'] as string[];

type World = {
  tables: string[];
  enums: string[];
  functions: string[];
  extraObjects: { kind: string; name: string }[];
  schemas: string[];
  extensions: string[];
  sessions: number;
  counts: Record<string, number>;
  digest: string;
};
const freshWorld = (over: Partial<World> = {}): World => ({
  tables: [...FOUR_OF_FIVE_TABLES], enums: ['Role_Kind'], functions: [], extraObjects: [], schemas: [], extensions: [], sessions: 0,
  counts: { Company: 1, Branch: 1, Location: 6, Role: 1, User: 1, UserBranchRole: 1, _prisma_migrations: 4 }, digest: 'd0', ...over,
});

type Hooks = {
  onDigest?: (n: number, w: World) => void;
  failDropAt?: number;
  failDropCode?: string;
  dropIsNoop?: boolean;
  throwOnQuery?: (sql: string) => Error | undefined;
};
class FakePg {
  readonly log: string[] = [];
  readonly connectionIds = new Set<string>();
  digests = 0;
  drops = 0;
  constructor(readonly world: World, private readonly hooks: Hooks = {}, readonly connId = 'conn-1') {}
  readonly client: ResetClient = {
    query: async (sql: string) => {
      this.connectionIds.add(this.connId);
      this.log.push(sql);
      const injected = this.hooks.throwOnQuery?.(sql);
      if (injected) throw injected;
      const w = this.world;
      if ([SQL_BEGIN, SQL_SEARCH_PATH, SQL_LOCK_TIMEOUT, SQL_LOCK_MARKER, SQL_COMMIT, SQL_ROLLBACK].includes(sql)) return { rows: [] };
      if (sql === SQL_SESSIONS) return { rows: [{ n: w.sessions }] };
      if (sql === SQL_FOREIGN_SCHEMAS) return { rows: w.schemas.map((name) => ({ name })) };
      if (sql === SQL_EXTENSIONS) return { rows: w.extensions.map((name) => ({ name })) };
      if (sql === SQL_PUBLIC_OBJECTS) {
        return { rows: [...w.tables.map((name) => ({ kind: 'rel:r', name })), ...w.enums.map((name) => ({ kind: 'type:e', name })), ...w.functions.map((name) => ({ kind: 'proc', name })), ...w.extraObjects] };
      }
      if (sql === SQL_MARKER_DIGEST) {
        this.digests += 1;
        this.hooks.onDigest?.(this.digests, w);
        return { rows: [{ digest: w.digest, n: 1 }] };
      }
      const count = /^SELECT count\(\*\)::int AS n FROM public\."(.+)"$/.exec(sql);
      if (count) return { rows: [{ n: w.counts[count[1] as string] ?? 0 }] };
      const dropT = /^DROP TABLE public\."(.+)" CASCADE$/.exec(sql);
      const dropY = /^DROP TYPE public\."(.+)"$/.exec(sql);
      const dropF = /^DROP FUNCTION public\."(.+)"\(\)$/.exec(sql);
      if (dropT || dropY || dropF) {
        this.drops += 1;
        if (this.hooks.failDropAt === this.drops) throw Object.assign(new Error('postgresql://u:secretpw@127.0.0.1:5432/x boom'), { code: this.hooks.failDropCode ?? 'XX000' });
        if (!this.hooks.dropIsNoop) {
          if (dropT) w.tables = w.tables.filter((t) => t !== dropT[1]);
          if (dropY) w.enums = w.enums.filter((t) => t !== dropY[1]);
          if (dropF) w.functions = w.functions.filter((t) => t !== dropF[1]);
        }
        return { rows: [] };
      }
      throw new Error(`unexpected statement: ${sql}`);
    },
  };
  count(re: RegExp): number {
    return this.log.filter((s) => re.test(s)).length;
  }
  get drop(): number {
    return this.count(/^DROP /);
  }
}

const okProve = async (): Promise<void> => undefined;
const deps = (pg: FakePg, over: Partial<ResetDeps> = {}): ResetDeps => ({
  client: pg.client, ownerToken: RESET_TOKEN_VALUE, expectedMarkerId: MARKER, targetMarkerId: MARKER, proveIdentity: okProve, ...over,
});
async function codeOf(p: Promise<unknown>): Promise<ResetCode | 'NO_THROW'> {
  try {
    await p;
    return 'NO_THROW';
  } catch (error) {
    return error instanceof ResetRefusal ? error.code : ('NO_THROW' as const);
  }
}

describe('R4 reset helper (DB-free, preregistered R01-R29)', () => {
  it('R01 valid disposable fixture: all drops in one transaction, committed, report counts only', async () => {
    const pg = new FakePg(freshWorld());
    const report = await resetDisposableLocalTest(deps(pg));
    expect(report.outcome).toBe('OK');
    expect(report.droppedTables).toBe(FOUR_OF_FIVE_TABLES.length);
    expect(report.droppedTypes).toBe(1);
    expect(pg.world.tables).toEqual([]);
    expect(pg.world.enums).toEqual([]);
    expect(pg.log[0]).toBe(SQL_BEGIN);
    expect(pg.log.at(-1)).toBe(SQL_COMMIT);
    expect(pg.count(/^BEGIN/)).toBe(1);
    expect(pg.count(/^COMMIT$/)).toBe(1);
    expect(pg.count(/^ROLLBACK$/)).toBe(0);
    expect(report.rowCounts.Company).toBe(1);
  });

  it('R02/R03 owner token missing or wrong: refused before any query', async () => {
    for (const ownerToken of [undefined, '', 'yes', RESET_TOKEN_VALUE + ' ']) {
      const pg = new FakePg(freshWorld());
      expect(await codeOf(resetDisposableLocalTest(deps(pg, { ownerToken })))).toBe('REFUSED_AUTH');
      expect(pg.log).toEqual([]);
    }
  });

  it('R04/R05 expected marker missing, malformed or different from the target marker: refused before any query', async () => {
    for (const expectedMarkerId of [undefined, '', 'not-a-uuid', MARKER.toUpperCase(), OTHER_MARKER]) {
      const pg = new FakePg(freshWorld());
      expect(await codeOf(resetDisposableLocalTest(deps(pg, { expectedMarkerId })))).toBe('BLOCKED_TARGET_IDENTITY');
      expect(pg.log).toEqual([]);
    }
  });

  it('R06 identity proof rejects: rollback, no DDL', async () => {
    const pg = new FakePg(freshWorld());
    const proveIdentity = async () => {
      throw new Error('LOCAL_TEST identity could not be proven; refusing destructive writes');
    };
    expect(await codeOf(resetDisposableLocalTest(deps(pg, { proveIdentity })))).toBe('BLOCKED_TARGET_IDENTITY');
    expect(pg.drop).toBe(0);
    expect(pg.count(/^ROLLBACK$/)).toBe(1);
    expect(pg.count(/^COMMIT$/)).toBe(0);
  });

  it('R07 identity prover absent: refused before any query', async () => {
    const pg = new FakePg(freshWorld());
    expect(await codeOf(resetDisposableLocalTest(deps(pg, { proveIdentity: undefined as never })))).toBe('REFUSED_AUTH');
    expect(pg.log).toEqual([]);
  });

  it('R08 the identity proofs run on the very connection that executes the DDL (and after the marker lock)', async () => {
    const pg = new FakePg(freshWorld());
    const seen: ResetClient[] = [];
    const lockSeenBeforeProof: boolean[] = [];
    await resetDisposableLocalTest(deps(pg, {
      proveIdentity: async (c) => {
        seen.push(c);
        lockSeenBeforeProof.push(pg.log.includes(SQL_LOCK_MARKER));
      },
    }));
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((c) => c === pg.client)).toBe(true);
    expect(lockSeenBeforeProof.every(Boolean)).toBe(true);
    expect(pg.connectionIds.size).toBe(1);
    expect(pg.log.indexOf(SQL_SEARCH_PATH)).toBeGreaterThan(pg.log.indexOf(SQL_BEGIN));
    expect(pg.log.indexOf(SQL_SEARCH_PATH)).toBeLessThan(pg.log.indexOf(SQL_LOCK_MARKER));
  });

  it('R09 a second session connected to the database: blocked, no DDL', async () => {
    const pg = new FakePg(freshWorld({ sessions: 1 }));
    expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_RESET_STATE');
    expect(pg.drop).toBe(0);
    expect(pg.count(/^COMMIT$/)).toBe(0);
  });

  it('R10 marker digest changes between the proof and the drops: blocked, rolled back, no DDL', async () => {
    const pg = new FakePg(freshWorld(), { onDigest: (n, w) => { if (n === 2) w.digest = 'tampered'; } });
    expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_TARGET_IDENTITY');
    expect(pg.drop).toBe(0);
    expect(pg.count(/^ROLLBACK$/)).toBe(1);
  });

  it('R11 marker digest changes after the drops, before commit: rolled back, never committed', async () => {
    const pg = new FakePg(freshWorld(), { onDigest: (n, w) => { if (n === 3) w.digest = 'tampered'; } });
    expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_TARGET_IDENTITY');
    expect(pg.count(/^COMMIT$/)).toBe(0);
    expect(pg.count(/^ROLLBACK$/)).toBe(1);
  });

  it('R12 post-drop identity re-proof fails: rolled back, never committed', async () => {
    const pg = new FakePg(freshWorld());
    let calls = 0;
    const proveIdentity = async () => {
      calls += 1;
      if (calls === 2) throw new Error('refused');
    };
    expect(await codeOf(resetDisposableLocalTest(deps(pg, { proveIdentity })))).toBe('BLOCKED_TARGET_IDENTITY');
    expect(pg.count(/^COMMIT$/)).toBe(0);
    expect(pg.count(/^ROLLBACK$/)).toBe(1);
  });

  it('R13 unknown table in public: blocked, no DDL', async () => {
    const pg = new FakePg(freshWorld({ tables: [...FOUR_OF_FIVE_TABLES, 'CustomerBackup'] }));
    expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_RESET_STATE');
    expect(pg.drop).toBe(0);
  });

  it('R14 operational tables holding rows: blocked, no DDL', async () => {
    for (const table of ['Sale', 'SaleItem', 'SalePayment', 'CashSession', 'CashMovement', 'StockMovement', 'StockReservation', 'AuditLog']) {
      const pg = new FakePg(freshWorld({ counts: { Company: 1, [table]: 1 } }));
      expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_RESET_STATE');
      expect(pg.drop).toBe(0);
    }
  });

  it('R15 row total above the ceiling: blocked, no DDL; exactly the ceiling is allowed', async () => {
    const big = new FakePg(freshWorld({ counts: { Company: ROW_CEILING + 1 } }));
    expect(await codeOf(resetDisposableLocalTest(deps(big)))).toBe('BLOCKED_RESET_STATE');
    expect(big.drop).toBe(0);
    const edge = new FakePg(freshWorld({ counts: { Company: ROW_CEILING } }));
    expect((await resetDisposableLocalTest(deps(edge))).outcome).toBe('OK');
  });

  it('R16 partial migration state (4/5 migrations): reset', async () => {
    const pg = new FakePg(freshWorld());
    expect((await resetDisposableLocalTest(deps(pg))).outcome).toBe('OK');
    expect(pg.world.tables).toEqual([]);
  });

  it('R17 half-reset state (only _prisma_migrations, or only some tables): completes', async () => {
    for (const tables of [['_prisma_migrations'], ['Company', 'Branch']]) {
      const pg = new FakePg(freshWorld({ tables, enums: [] }));
      const report = await resetDisposableLocalTest(deps(pg));
      expect(report.outcome).toBe('OK');
      expect(report.droppedTables).toBe(tables.length);
      expect(pg.world.tables).toEqual([]);
    }
  });

  it('R18 second invocation on an already fresh database: ALREADY_FRESH, zero drops, still proven', async () => {
    const pg = new FakePg(freshWorld({ tables: [], enums: [] }));
    let proofs = 0;
    const report = await resetDisposableLocalTest(deps(pg, { proveIdentity: async () => { proofs += 1; } }));
    expect(report.outcome).toBe('ALREADY_FRESH');
    expect(pg.drop).toBe(0);
    expect(proofs).toBeGreaterThanOrEqual(1);
  });

  it('R19 non-whitelisted object kinds in public: blocked, no DDL', async () => {
    for (const kind of ['proc', 'rel:v', 'rel:m', 'rel:c', 'rel:f', 'rel:p', 'type:c', 'type:d', 'type:r', 'extension', 'collation', 'operator']) {
      const pg = new FakePg(freshWorld({ extraObjects: [{ kind, name: 'thing' }] }));
      expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_RESET_STATE');
      expect(pg.drop).toBe(0);
    }
    const ext = new FakePg(freshWorld({ extensions: ['pgcrypto'] }));
    expect(await codeOf(resetDisposableLocalTest(deps(ext)))).toBe('BLOCKED_RESET_STATE');
    expect(ext.drop).toBe(0);
  });

  it('R20 foreign schema present (TEST/PILOT/other guard): blocked, no DDL', async () => {
    for (const schema of ['mona_test_guard', 'mona_pilot_guard', 'analytics']) {
      const pg = new FakePg(freshWorld({ schemas: [schema] }));
      expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_RESET_STATE');
      expect(pg.drop).toBe(0);
    }
  });

  it('R21 DEV/TEST/DEMO/PILOT-like configuration is refused before any connection', () => {
    const base = { [RESET_TOKEN_VAR]: RESET_TOKEN_VALUE, MONA_TEST_DATABASE_TARGET: 'local', [RESET_EXPECTED_MARKER_VAR]: MARKER, LOCAL_TEST_DATABASE_MARKER_ID: MARKER };
    const good = 'postgresql://mona_local_test:pw@127.0.0.1:5432/mona_local_test';
    expect(evaluateResetGate({ ...base, LOCAL_TEST_DATABASE_URL: good })).toEqual({ enabled: true });
    const bad = [
      'postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres',
      'postgresql://postgres.abc:pw@aws-0-eu.pooler.supabase.com:6543/postgres',
      'postgresql://mona_local_test:pw@127.0.0.1:5433/mona_local_test',
      'postgresql://mona_local_test:pw@localhost:5432/mona_local_test',
      'postgresql://mona_local_test:pw@127.0.0.1:5432/mona_test',
      'postgresql://postgres:pw@127.0.0.1:5432/mona_local_test',
      'not a url',
    ];
    for (const url of bad) {
      const decision = evaluateResetGate({ ...base, LOCAL_TEST_DATABASE_URL: url });
      expect(decision.enabled).toBe(false);
      expect(() => readLocalTestTarget({ LOCAL_TEST_DATABASE_URL: url, LOCAL_TEST_DATABASE_MARKER_ID: MARKER } as NodeJS.ProcessEnv)).toThrow();
    }
    for (const forbidden of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
      expect(evaluateResetGate({ ...base, LOCAL_TEST_DATABASE_URL: good, [forbidden]: 'postgresql://x' }).enabled).toBe(false);
    }
    expect(evaluateResetGate({ ...base, MONA_TEST_DATABASE_TARGET: 'test', LOCAL_TEST_DATABASE_URL: good }).enabled).toBe(false);
    expect(evaluateResetGate({ ...base, [RESET_TOKEN_VAR]: 'yes', LOCAL_TEST_DATABASE_URL: good }).enabled).toBe(false);
    expect(evaluateResetGate({ ...base, [RESET_EXPECTED_MARKER_VAR]: OTHER_MARKER, LOCAL_TEST_DATABASE_URL: good }).enabled).toBe(false);
    expect(evaluateResetGate({}).enabled).toBe(false);
  });

  it('R22 interrupted reset: rolled back, never committed, error sanitized (R26)', async () => {
    const pg = new FakePg(freshWorld(), { failDropAt: 3 });
    let message = '';
    try {
      await resetDisposableLocalTest(deps(pg));
    } catch (error) {
      message = String((error as Error).message);
      expect(error).toBeInstanceOf(ResetRefusal);
    }
    expect(message).not.toBe('');
    expect(message).not.toMatch(/postgres(ql)?:\/\/|secretpw|127\.0\.0\.1/);
    expect(pg.count(/^COMMIT$/)).toBe(0);
    expect(pg.count(/^ROLLBACK$/)).toBe(1);
  });

  it('R23/R28 every statement is on a strict allowlist: no guard-schema DDL, no INSERT/UPDATE/DELETE/CREATE/TRUNCATE/DROP SCHEMA', async () => {
    const pg = new FakePg(freshWorld());
    await resetDisposableLocalTest(deps(pg));
    const allowed = [
      /^BEGIN$/, /^SET LOCAL search_path TO pg_catalog, pg_temp$/, /^SET LOCAL lock_timeout = '5s'$/, /^LOCK TABLE mona_local_test_guard\.database_identity IN SHARE MODE$/,
      /^SELECT /, /^DROP TABLE public\."[A-Za-z_]+" CASCADE$/, /^DROP TYPE public\."[A-Za-z_]+"$/, /^DROP FUNCTION public\."fn_[a-z_]+"\(\)$/, /^COMMIT$/,
    ];
    for (const sql of pg.log) expect(allowed.some((re) => re.test(sql)), sql).toBe(true);
    for (const sql of pg.log.filter((s) => /^(DROP|CREATE|ALTER|INSERT|UPDATE|DELETE|TRUNCATE)/i.test(s))) {
      expect(sql).not.toMatch(/mona_local_test_guard|SCHEMA|OWNED/i);
      expect(sql).toMatch(/^DROP (TABLE|TYPE|FUNCTION) public\./);
    }
  });

  it('R24 hostile identifiers are never interpolated: blocked, no DDL', async () => {
    for (const name of ['Company"; DROP SCHEMA public CASCADE; --', 'a b', 'Company\n']) {
      const pg = new FakePg(freshWorld({ tables: [...FOUR_OF_FIVE_TABLES, name] }));
      expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_RESET_STATE');
      expect(pg.drop).toBe(0);
    }
    const t = new FakePg(freshWorld({ enums: ['E"; DROP TABLE x; --'] }));
    expect(await codeOf(resetDisposableLocalTest(deps(t)))).toBe('BLOCKED_RESET_STATE');
    expect(t.drop).toBe(0);
  });

  it('R25 a drop that leaves objects behind: blocked, rolled back', async () => {
    const pg = new FakePg(freshWorld(), { dropIsNoop: true });
    expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_RESET_STATE');
    expect(pg.count(/^COMMIT$/)).toBe(0);
    expect(pg.count(/^ROLLBACK$/)).toBe(1);
  });

  it('R27 lock contention on a drop (55P03): blocked, rolled back', async () => {
    const pg = new FakePg(freshWorld(), { failDropAt: 1, failDropCode: '55P03' });
    expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_RESET_STATE');
    expect(pg.count(/^COMMIT$/)).toBe(0);
    expect(pg.count(/^ROLLBACK$/)).toBe(1);
  });

  it('R29 only application tables, _prisma_migrations and enum types are ever dropped', async () => {
    const pg = new FakePg(freshWorld());
    await resetDisposableLocalTest(deps(pg));
    const allowedTables = new Set<string>([...APPLICATION_TABLES, '_prisma_migrations']);
    for (const sql of pg.log.filter((s) => s.startsWith('DROP TABLE'))) {
      expect(allowedTables.has(/"(.+)"/.exec(sql)?.[1] as string)).toBe(true);
    }
    expect(pg.log).toContain(dropTableSql('Company'));
    expect(pg.log).toContain(dropTypeSql('Role_Kind'));
    expect(pg.log).toContain(countSql('Company'));
    expect(SQL_PUBLIC_OBJECTS).toMatch(/pg_namespace|nspname/);
    expect(SQL_MARKER_DIGEST).toMatch(/database_identity/);
  });

  // ---- real-DB finding (rebuild): migration 5 leaves three trigger functions in public; the first reset ran before it existed ----
  it('R33 the three known migration-5 trigger functions are dropped after the tables, in the same transaction', async () => {
    const pg = new FakePg(freshWorld({ functions: [...KNOWN_TRIGGER_FUNCTIONS] }));
    const report = await resetDisposableLocalTest(deps(pg));
    expect(report.outcome).toBe('OK');
    expect(report.droppedFunctions).toBe(3);
    expect(pg.world.functions).toEqual([]);
    for (const name of KNOWN_TRIGGER_FUNCTIONS) expect(pg.log).toContain(dropFunctionSql(name));
    const lastTable = pg.log.map((s, i) => (s.startsWith('DROP TABLE') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(pg.log.indexOf(dropFunctionSql(KNOWN_TRIGGER_FUNCTIONS[0] as string))).toBeGreaterThan(lastTable);
    expect(pg.count(/^COMMIT$/)).toBe(1);
  });

  it('R34/R36 any other function, or a hostile name, is refused with no DDL', async () => {
    for (const name of ['fn_other', 'fn_sale_payment_history"() ; DROP SCHEMA public CASCADE; --', 'FN_SALE_PAYMENT_HISTORY', 'fn_sale_payment_history ']) {
      const pg = new FakePg(freshWorld({ functions: [name] }));
      expect(await codeOf(resetDisposableLocalTest(deps(pg))), name).toBe('BLOCKED_RESET_STATE');
      expect(pg.drop).toBe(0);
    }
  });

  it('R35 a known function that survives its drop leaves the reset refused and rolled back', async () => {
    const pg = new FakePg(freshWorld({ functions: ['fn_sale_payment_history'] }), { dropIsNoop: true });
    expect(await codeOf(resetDisposableLocalTest(deps(pg)))).toBe('BLOCKED_RESET_STATE');
    expect(pg.count(/^COMMIT$/)).toBe(0);
    expect(pg.count(/^ROLLBACK$/)).toBe(1);
  });

  it('R37 half-reset: functions alone left behind are still completed (idempotent)', async () => {
    const pg = new FakePg(freshWorld({ tables: [], enums: [], functions: [KNOWN_TRIGGER_FUNCTIONS[1] as string] }));
    const report = await resetDisposableLocalTest(deps(pg));
    expect(report.outcome).toBe('OK');
    expect(report.droppedFunctions).toBe(1);
  });
});
