// R3-A4.3 S1 REVISE — DB-free checks of the opt-in PostgreSQL harness used by
// r3-attempts-schema.pg.test.ts. Nothing here opens a database or runs psql:
// it inspects the invocation the harness WOULD run, the temporary credential
// file it creates and removes, the migration-9 pin gate and the expected
// migration ledger 1–8.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PSQL_BIN,
  buildPsqlInvocation,
  createBoundPsqlRunner,
  redactConnectionSecrets,
  withPsqlInvocation,
} from '../helpers/r3-psql.js';
import {
  R3_ATTEMPTS_MIGRATION,
  R3_T_MIGRATION_9_SHA256_PIN,
  checkMigration9Pin,
  expectedLedgerBeforeMigration9,
  migrationNames,
  migrationPath,
  readMigration,
  sha256,
} from '../helpers/r3-attempts-migration.js';

// Synthetic credentials: distinctive so any leak is detectable by substring.
const USER = 'r3userXq';
const PASSWORD = 'pw:Zk9\\secret/y';
const HOST = 'r3host-p21.invalid';
const DB = 'r3dbname';
const PG_URL = `postgresql://${USER}:${encodeURIComponent(PASSWORD)}@${HOST}:6543/${DB}?sslmode=disable`;
const SECRETS = [PG_URL, USER, PASSWORD, encodeURIComponent(PASSWORD), HOST, DB, '6543'];

describe('R3-A4.3 S1 — psql invocation never carries credentials in argv', () => {
  const invocation = () => buildPsqlInvocation(PG_URL, '/work/migration.sql', '/work/tmp');

  it('H01 runs psql directly (absolute binary, no shell) with only fixed flags and the SQL file', () => {
    const inv = invocation();
    expect(inv.command).toBe(PSQL_BIN);
    expect(PSQL_BIN).toBe('/usr/bin/psql');
    expect(inv.args).toEqual(['-X', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-f', '/work/migration.sql']);
    for (const arg of inv.args) for (const secret of SECRETS) expect(arg, `argv leaks ${secret}`).not.toContain(secret);
    expect(inv.args.join(' ')).not.toMatch(/-d\b|--dbname|-U\b|-h\b|-p\b|postgres(ql)?:\/\//);
  });

  it('H02 passes connection data through libpq variables and a pass file; never PGPASSWORD', () => {
    const inv = invocation();
    expect(inv.env).toEqual({
      PATH: '/usr/bin:/bin',
      PGHOST: HOST,
      PGPORT: '6543',
      PGDATABASE: DB,
      PGUSER: USER,
      PGPASSFILE: '/work/tmp/pgpass',
      PGSERVICEFILE: '/work/tmp/no-service-file',
      PGSSLMODE: 'disable',
      PGCONNECT_TIMEOUT: '10',
      PGAPPNAME: 'r3-a43-s1-p21',
    });
    expect(Object.keys(inv.env)).not.toContain('PGPASSWORD');
    for (const value of Object.values(inv.env)) expect(value).not.toContain(PASSWORD);
    // The password lives only in the pass file, with ':' and '\' escaped.
    expect(inv.pgpass).toBe(`${HOST}:6543:${DB}:${USER}:pw\\:Zk9\\\\secret/y\n`);
  });

  it('H03 refuses non-PostgreSQL URLs and any query parameter other than sslmode, without echoing the PG_URL', () => {
    for (const bad of [
      `mysql://${USER}:${PASSWORD}@${HOST}/${DB}`,
      `postgresql://${USER}:x@${HOST}/${DB}?options=-csearch_path%3Devil`,
      `postgresql://${USER}:x@${HOST}/${DB}?host=/tmp`,
      `postgresql://${USER}:x@${HOST}`,
      'not a url',
    ]) {
      let message = '';
      try { buildPsqlInvocation(bad, '/f.sql', '/w'); } catch (error) { message = (error as Error).message; }
      expect(message, bad).toMatch(/^psql target refused: /);
      for (const secret of [USER, PASSWORD, HOST, DB, 'evil']) expect(message).not.toContain(secret);
    }
  });

  it('H04 creates the pass file 0600 inside a 0700 directory and removes both, also when the run throws', async () => {
    let seenDir = '';
    await withPsqlInvocation(PG_URL, '/work/migration.sql', async (live) => {
      seenDir = live.env.PGPASSFILE!.replace(/\/pgpass$/, '');
      expect(statSync(seenDir).mode & 0o777).toBe(0o700);
      expect(statSync(live.env.PGPASSFILE!).mode & 0o777).toBe(0o600);
      expect(readFileSync(live.env.PGPASSFILE!, 'utf8')).toBe(live.pgpass);
      expect(readdirSync(seenDir)).toEqual(['pgpass']);
    });
    expect(existsSync(seenDir)).toBe(false);
    let thrownDir = '';
    await expect(withPsqlInvocation(PG_URL, '/work/migration.sql', async (live) => {
      thrownDir = live.env.PGPASSFILE!.replace(/\/pgpass$/, '');
      throw new Error('simulated psql failure');
    })).rejects.toThrow('simulated psql failure');
    expect(thrownDir).not.toBe('');
    expect(existsSync(thrownDir)).toBe(false);
  });

  it('H05 redacts PG_URL, user, password, host and database from psql output before any assertion prints it', () => {
    const stderr = `psql: error: connection to server at "${HOST}" (127.0.0.1), port 6543 failed: FATAL: password authentication failed for user "${USER}" database "${DB}" ${PG_URL} ${PASSWORD}`;
    const redacted = redactConnectionSecrets(stderr, PG_URL);
    for (const secret of [PG_URL, USER, PASSWORD, HOST, DB]) expect(redacted).not.toContain(secret);
    expect(redacted).toContain('password authentication failed');
    expect(redactConnectionSecrets('ERROR:  P21b injected late failure', PG_URL)).toBe('ERROR:  P21b injected late failure');
  });
});

describe('R3-A4.3 U1 (R3-T) — migration-9 SHA pin', () => {
  const text = readMigration(R3_ATTEMPTS_MIGRATION);

  // G11 keeps the authoritative reviewed literals in pilot-migration-states.mjs;
  // local-test-migration-payload imports that shared payload instead of retyping it.
  // The harness carries the same literal, so neither source can move alone.
  it('H06 the R3-T pin is the exact reviewed migration-9 digest, equal to the LOCAL_TEST payload pin, and the real file MATCHES', () => {
    expect(R3_T_MIGRATION_9_SHA256_PIN).toBe('076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148');
    const payloadSource = readFileSync(new URL('../../../scripts/database/pilot-migration-states.mjs', import.meta.url), 'utf8');
    const pinned = /Object\.freeze\(\{ name: '20261016130000_r3_checkout_attempts', bytes: (\d+), sha256: '([0-9a-f]{64})' \}\)/.exec(payloadSource);
    expect(pinned?.[2]).toBe(R3_T_MIGRATION_9_SHA256_PIN);
    expect(Number(pinned?.[1])).toBe(Buffer.byteLength(text, 'utf8'));
    expect(checkMigration9Pin(text)).toEqual({ status: 'MATCH', actual: sha256(text) });
  });

  it('H07 the gate compares the exact bytes: a well-formed but different hash is a mismatch, a malformed pin is refused', () => {
    expect(checkMigration9Pin(text, sha256(text))).toEqual({ status: 'MATCH', actual: sha256(text) });
    const other = 'f'.repeat(64);
    expect(() => checkMigration9Pin(text, other)).toThrow(/does not match the R3-T pin/);
    expect(() => checkMigration9Pin(`${text}\n`, sha256(text))).toThrow(/does not match the R3-T pin/);
    expect(() => checkMigration9Pin(text, 'ABC')).toThrow(/malformed R3-T pin/);
    expect(() => checkMigration9Pin(text, sha256(text).toUpperCase())).toThrow(/malformed R3-T pin/);
  });
});

describe('R3-A4.3 S1 — exact ledger expected before migration 9 (P21a precondition)', () => {
  it('H08 lists exactly migrations 1–8 with the SHA-256 of each file as the Prisma checksum', () => {
    const ledger = expectedLedgerBeforeMigration9();
    const names = migrationNames();
    expect(ledger.map((row) => row.name)).toEqual(names.slice(0, 8));
    expect(ledger.map((row) => row.name)).not.toContain(R3_ATTEMPTS_MIGRATION);
    for (const row of ledger) expect(row.checksum).toBe(sha256(readFileSync(migrationPath(row.name))));
    // Cross-check with the independently pinned CASH-1 checksums (first and seventh).
    expect(ledger[0]).toEqual({ name: '20260907015311_init', checksum: 'a584edab13a2ae540d694578ffa3b5a622decff04e238a5cf16d3040d295e4cb' });
    expect(ledger[6]).toEqual({ name: '20261012120000_cash_session_reconciliation', checksum: 'd98b7ce082bff6810312866c81c26203146dff03c7a12e5f3bd6a595893fc47f' });
  });
});

describe('R3-A4.3 S1 — the PostgreSQL test file uses only the credential-safe harness', () => {
  const source = readFileSync(new globalThis.URL('./r3-attempts-schema.pg.test.ts', import.meta.url), 'utf8');

  it('H09 no shell, no -d/PG_URL in argv, psql only via withPsqlInvocation + execFile(command, args, { env })', () => {
    expect(source).not.toMatch(/['"]\/bin\/sh['"]|\bsh -c\b|shell:\s*true|\bexecSync\b|\bspawnSync\b|\bexec\(/);
    expect(source).not.toMatch(/['"]-d['"]|--dbname|PGPASSWORD|R3_P21_URL/);
    // psql is bound to the VERIFIED target url: no second read of the environment.
    expect(source).not.toMatch(/process\.env\.LOCAL_TEST_DATABASE_URL|process\.env\[['"]LOCAL_TEST_DATABASE_URL/);
    expect(source).not.toMatch(/withPsqlInvocation\(|execFile\(/);
    expect(source).toMatch(/const \{ pool, target \} = await openProvenLocalTestPool\(/);
    expect(source).toContain('createBoundPsqlRunner(bound.target.url, execFile)');
    // The migration-9 pin gate is used, not a format-only check.
    expect(source).not.toMatch(/toMatch\(\/\^\[0-9a-f\]\{64\}\$\/\)/);
    expect(source).toContain('checkMigration9Pin(');
  });
});

describe('R3-A4.3 S1 — psql stays bound to the verified LOCAL_TEST target', () => {
  type Call = { command: string; args: string[]; env: Record<string, string>; pgpass: string; options: Record<string, unknown> };
  const fakeExec = (calls: Call[], stderr = '') => (command: string, args: readonly string[], options: { env: Record<string, string> } & Record<string, unknown>,
    callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void) => {
    calls.push({ command, args: [...args], env: { ...options.env }, pgpass: readFileSync(options.env.PGPASSFILE!, 'utf8'), options: { ...options } });
    const error = Object.assign(new Error('exit 3'), { code: 3 });
    callback(error, '', stderr);
  };

  it('H10 a change of LOCAL_TEST_DATABASE_URL after binding never redirects psql', async () => {
    const verified = 'postgresql://verified_user:verified%3Apw@127.0.0.1:5432/mona_local_test';
    const swapped = 'postgresql://evil_user:evil_pw@evil-host.invalid:6666/evil_db';
    const previous = process.env.LOCAL_TEST_DATABASE_URL;
    const calls: Call[] = [];
    try {
      process.env.LOCAL_TEST_DATABASE_URL = verified;
      const run = createBoundPsqlRunner(verified, fakeExec(calls, `connect failed for "verified_user" at 127.0.0.1 db mona_local_test`));
      process.env.LOCAL_TEST_DATABASE_URL = swapped; // after binding
      const result = await run('/work/migration.sql');
      expect(result.code).toBe(3);
      // Redaction still applies to the bound target.
      expect(result.stderr).not.toMatch(/verified_user|mona_local_test|127\.0\.0\.1/);
    } finally {
      if (previous === undefined) delete process.env.LOCAL_TEST_DATABASE_URL;
      else process.env.LOCAL_TEST_DATABASE_URL = previous;
    }
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.command).toBe(PSQL_BIN);
    expect(call!.args).toEqual(['-X', '-q', '-w', '-v', 'ON_ERROR_STOP=1', '-f', '/work/migration.sql']);
    expect(call!.env).toMatchObject({ PGHOST: '127.0.0.1', PGPORT: '5432', PGDATABASE: 'mona_local_test', PGUSER: 'verified_user' });
    expect(call!.pgpass).toBe('127.0.0.1:5432:mona_local_test:verified_user:verified\\:pw\n');
    expect(JSON.stringify(call)).not.toMatch(/evil/);
    expect(call!.options.shell).toBeUndefined();
    // The temporary pass file is gone after the run.
    expect(existsSync(call!.env.PGPASSFILE!)).toBe(false);
  });

  it('H11 the PostgreSQL file covers every terminal column in P3 and the sealed two-tender / tenderCount = 1 case in P4', () => {
    const source = readFileSync(new globalThis.URL('./r3-attempts-schema.pg.test.ts', import.meta.url), 'utf8');
    const p3 = source.slice(source.indexOf("it('P3c"), source.indexOf("it('P4"));
    for (const col of ['confirmationHash', 'confirmedById', 'confirmedAt', 'confirmReason', 'confirmEvidence',
      'rejectionCode', 'rejectionDetails', 'rejectedById', 'rejectedAt',
      'abandonedById', 'abandonedAt', 'abandonReason', 'abandonEvidence']) {
      expect(p3, col).toContain(`${col}:`);
    }
    const p4 = source.slice(source.indexOf("it('P4"), source.indexOf("it('P5 "));
    expect(p4).toContain('sealed plan with two valid tenders but tenderCount = 1');
  });
});
