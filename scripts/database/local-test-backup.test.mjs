// Zero-database unit tests for scripts/database/local-test-backup.mjs.
// Run with: node --test scripts/database/local-test-backup.test.mjs
// Hermetic: synthetic loopback URL and password, an injected fake LOCAL_TEST runtime,
// an injected fake spawn standing in for pg_dump / pg_restore (it writes a synthetic
// archive to the planned --file path and prints a synthetic TOC), fake binary hashes,
// and owner-only scratch directories. No database, no real pg_dump/pg_restore, no tsx.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import * as backup from './local-test-backup.mjs';
import * as prepare from './local-test-prepare.mjs';

const SOURCE = readFileSync(new URL('./local-test-backup.mjs', import.meta.url), 'utf8');
const MARKER = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SECRET = 'B4ckupS3cretValue';
const URL_TEXT = `postgresql://mona_local_test:${SECRET}@127.0.0.1:5432/mona_local_test`;
const ENV = Object.freeze({ LOCAL_TEST_DATABASE_URL: URL_TEXT, LOCAL_TEST_DATABASE_MARKER_ID: MARKER });
const TARGET = 'mona_local_test@127.0.0.1:5432/mona_local_test';
const PG_DUMP = '/synthetic/pg/bin/pg_dump';
const PG_RESTORE = '/synthetic/pg/bin/pg_restore';
const API = '/synthetic/repo/api';
const sha = (label) => createHash('sha256').update(label).digest('hex');
const LEAKS = [SECRET, URL_TEXT];
const ARCHIVE = Buffer.from('PGDMP synthetic custom archive bytes\n');
const R4_RELATIONS = ['AuditLog', 'Branch', 'Brand', 'CashMovement', 'CashRegister', 'CashSession', 'Category', 'Company', 'CompanyPricingConfig', 'Inventory', 'Location', 'Permission', 'Product', 'ProductVariant', 'Role', 'RolePermission', 'Sale', 'SaleItem', 'SaleNumberCounter', 'SalePayment', 'StockMovement', 'StockReservation', 'User', 'UserBranchRole', 'UserRoleScope', '_prisma_migrations'];
// A TOC in the shape pg_restore --list prints, for the 26 protected relations plus a few allow-listed object kinds (R4 strict contract).
function r4Toc({ tables = R4_RELATIONS, data = tables, extra = [], dbname = 'mona_local_test', declared } = {}) {
  const entries = [
    '6; 2615 2200 SCHEMA - public pg_database_owner',
    '3410; 0 0 COMMENT - SCHEMA public pg_database_owner',
    '900; 1247 16385 TYPE public SaleStatus mona_local_test',
    '910; 1255 16400 FUNCTION public fn_sale_payment_history() mona_local_test',
    ...tables.map((t, i) => `${1000 + i}; 1259 ${20000 + i} TABLE public ${t} mona_local_test`),
    ...data.map((t, i) => `${3000 + i}; 0 ${20000 + i} TABLE DATA public ${t} mona_local_test`),
    ...tables.map((t, i) => `${4000 + i}; 2606 ${30000 + i} CONSTRAINT public ${t} ${t}_pkey mona_local_test`),
    '5000; 2620 40000 TRIGGER public SalePayment trg_sale_payment_history_before mona_local_test',
    ...extra,
  ];
  return [
    ';', '; Archive created at 2026-10-05 12:00:00 UTC', `;     dbname: ${dbname}`, `;     TOC Entries: ${declared ?? entries.length}`,
    ';     Compression: gzip', ';     Dump Version: 1.15-0', ';     Format: CUSTOM', ';     Integer: 4 bytes', ';     Offset: 8 bytes',
    ';     Dumped from database version: 17.4', ';     Dumped by pg_dump version: 17.4', ';', ';', '; Selected TOC Entries:', ';', ...entries, '',
  ].join('\n');
}
const TOC = r4Toc();

const G5_PAIRS = [
  ['20260907015311_init', 'a584edab13a2ae540d694578ffa3b5a622decff04e238a5cf16d3040d295e4cb'],
  ['20260912182432_add_company_location', '19c345aa92c79a0a613dc03ea01dcf10e91b5a75fd6f3535076d8d71b6f740af'],
  ['20260912191702_add_user_role_scope', '2b415411eddc1212bf60419ce49022cea38d1fc2d12cb08938ad7c953caf7f3a'],
  ['20260922210000_d3_initial_stock_and_global_audit', '62b3b169e06a48dc2e2a3f81cee11e02a809b2733db2453c5b9eef91c15f77cf'],
  ['20261002120000_block1_pricing_wholesale', '45cf8d080e8fa4ec0a8dab9c9e5d4b780eb1642f0a8992d43b57dff655250173'],
];
const G6_PAIRS = [...G5_PAIRS, ['20261006120000_pilot_pricing_v2', 'd948f74e9c0eed3ce959f5c0e6edea70871d7d5957275f3304922e31bab6df12']];
const G6_MIGRATIONS = G6_PAIRS.map(([name, sha256]) => ({ name, sha256 }));
// V2.3.2: a backup binds the current prepare checkpoint, read from <home>/.local/state/...;
// runs get a real owner-only home holding one current checkpoint for the default payload.
const DEFAULT_PAYLOAD = Object.freeze({ ok: true, migrations: G6_MIGRATIONS, lock: { provider: 'postgresql', sha256: sha('lock') } });
const STORE_POLICY = Object.freeze({ uid: process.getuid(), repoRoot: '/synthetic/repo', forbiddenRoots: ['/synthetic/tmp'] });
function checkpointedHome({ marker = MARKER, payload = DEFAULT_PAYLOAD, record = true } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mona-v232-backup-home-'));
  chmodSync(home, 0o700);
  if (record) {
    const when = { now: new Date('2026-10-03T11:00:00.000Z'), plan: sha('generic plan') };
    assert.ok(prepare.supersedeCheckpoints(home, STORE_POLICY, when).ok);
    const r = prepare.recordCheckpoint(home, STORE_POLICY, { ...when, markerId: marker, payload, prepareSha256: sha('prepare') });
    assert.ok(r.ok, r.reason);
  }
  return home;
}
const SHARED_HOME = checkpointedHome();

function assertNoLeak(text) {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `output leaked ${JSON.stringify(leak)}`);
}

function scratchRoot(mode = 0o700) {
  const base = mkdtempSync(path.join(os.tmpdir(), 'mona-backup-test-'));
  const root = path.join(base, 'root');
  mkdirSync(root, { mode });
  chmodSync(root, mode);
  return { base, root };
}

const SNAPSHOT_ID = '00000003-0000001B-1';
const F_PRE = sha('fpre');
const DOMAIN_SHA = sha('domain-contract');
function fakeRuntime(order, { states = ['POST_BACKFILL', 'POST_BACKFILL'], failOn = {}, proveResult, exporterFailsAfter = false } = {}) {
  const counts = {};
  const call = (name) => {
    order.push(name);
    counts[name] = (counts[name] ?? 0) + 1;
    if ((failOn[name] ?? []).includes(counts[name])) throw new Error(`${name} failed on ${URL_TEXT}`);
    return counts[name];
  };
  return {
    counts,
    runtime: {
      proveIdentity: async () => {
        call('prove');
        return proveResult;
      },
      classify: async () => states[Math.min(call('classify'), states.length) - 1],
      // R4: the exporter (REPEATABLE READ READ ONLY, snapshot exported first) proves identity/settings/domain, requires POST_BACKFILL,
      // computes fPre, runs the driver while it is open, commits, and proves schema stability (B11).
      withBackupSnapshot: async (callback) => {
        call('withBackupSnapshot');
        if (states[0] !== 'POST_BACKFILL') throw new Error(`state ${states[0]}`);
        const value = await callback({ snapshotId: SNAPSHOT_ID, fPre: F_PRE, serverVersionNum: '170004', markerId: MARKER, protectedDomainContractSha256: DOMAIN_SHA });
        call('exporter-committed');
        if (exporterFailsAfter) throw new Error('the catalog changed during the dump');
        return value;
      },
      seedDemo: async () => { call('SEED_MUST_NEVER_RUN'); },
      backfillCompanyLocations: async () => { call('BACKFILL_MUST_NEVER_RUN'); },
      verifyBaseline: async () => { call('verify'); },
      close: async () => { call('close'); },
    },
  };
}

// V2.3.2: every child is started contained (`unshare ... -- <command> <args>`); the fake
// records the wrapped command as `command`/`args` and the wrapper as `contained`.
const unwrap = (command, args) => (path.basename(command) === 'unshare' && args.includes('--')
  ? { command: args[args.indexOf('--') + 1], args: args.slice(args.indexOf('--') + 2) }
  : { command, args });

// pg_dump: writes `archive` to the --file argument; pg_restore --list: prints `toc`.
function fakeSpawn(order, opts = {}) {
  const spawned = [];
  const spawn = (wrapper, wrapperArgs, options) => {
    const { command, args } = unwrap(wrapper, wrapperArgs);
    spawned.push({ command, args: [...args], options, contained: { command: wrapper, args: [...wrapperArgs] } });
    const tool = path.basename(command);
    order.push(tool);
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    const o = opts[tool] ?? {};
    if (o.hang) return child;
    setImmediate(() => {
      if (tool === 'pg_dump') {
        const file = args[args.indexOf('--file') + 1];
        if (!o.noFile) {
          writeFileSync(o.writeTo ?? file, o.archive ?? ARCHIVE, { mode: o.fileMode ?? 0o600 });
          if (o.fileMode !== undefined) chmodSync(o.writeTo ?? file, o.fileMode);
          if (o.symlinkTo) {
            rmSync(file);
            symlinkSync(o.symlinkTo, file);
          }
        }
        for (const line of o.stderr ?? []) child.stderr.write(`${line}\n`);
      } else {
        child.stdout.write(o.toc ?? TOC);
        for (const line of o.stderr ?? []) child.stderr.write(`${line}\n`);
      }
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', o.code ?? 0, o.signal ?? null));
    });
    return child;
  };
  return { spawn, spawned };
}

async function run(argv, opts = {}) {
  const order = [];
  const out = [];
  const { runtime, counts } = fakeRuntime(order, opts.runtime);
  const spawner = fakeSpawn(order, opts.spawn);
  const deps = {
    env: opts.env ?? { ...ENV },
    apiDir: API,
    repoRoot: opts.repoRoot ?? '/synthetic/repo',
    forbiddenRoots: opts.forbiddenRoots ?? ['/synthetic/tmp'],
    home: opts.home ?? SHARED_HOME,
    pgDump: PG_DUMP,
    pgRestore: PG_RESTORE,
    hashBinary: (file) => {
      order.push(`hash:${path.basename(file)}`);
      return opts.binaries?.[path.basename(file)] ?? { ok: true, sha256: sha(path.basename(file)) };
    },
    verifyMigrationPayload: () => opts.payload ?? DEFAULT_PAYLOAD,
    loadRuntime: async () => {
      order.push('loadRuntime');
      if (opts.loadFails) throw new Error(`cannot load ${URL_TEXT}`);
      return runtime;
    },
    spawn: spawner.spawn,
    childTimeoutMs: opts.childTimeoutMs ?? 2000,
    now: opts.now ?? (() => new Date('2026-10-03T12:00:00.000Z')),
    randomSuffix: opts.randomSuffix ?? (() => 'a1b2c3d4'),
    afterHash: opts.afterHash,
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  };
  const code = await backup.main(argv, deps);
  return { code, order, text: out.join('\n'), spawned: spawner.spawned, counts };
}

const DRY = (root) => ['--dry-run', `--marker-id=${MARKER}`, `--output-root=${root}`];
const EXEC = (root, plan) => ['--execute', `--marker-id=${MARKER}`, `--output-root=${root}`, `--confirm-local-target=${TARGET}`, `--plan=${plan}`];
async function planFor(root, opts = {}) {
  const r = await run(DRY(root), opts);
  const m = /plan digest: ([0-9a-f]{64})/.exec(r.text);
  assert.ok(m, `dry-run printed no plan digest:\n${r.text}`);
  return m[1];
}
async function execute(root, opts = {}) {
  return run(EXEC(root, opts.plan ?? (await planFor(root, opts))), opts);
}
const runDirs = (root) => readdirSync(root).filter((n) => n.startsWith('local-test-'));

// --- K. CLI ------------------------------------------------------------------------------

test('K01/K02/K03 exactly one mode, unknown arguments refused without echo', async () => {
  const { root } = scratchRoot();
  for (const argv of [[`--marker-id=${MARKER}`, `--output-root=${root}`], ['--dry-run', '--execute', `--marker-id=${MARKER}`, `--output-root=${root}`], [...DRY(root), '--bogus=hush-value']]) {
    const r = await run(argv);
    assert.equal(r.code, 1);
    assert.ok(!r.text.includes('hush-value'));
    assert.equal(r.order.length, 0);
  }
});

test('K04/K05/K06/K11/K47 output root must be an existing canonical absolute directory', async () => {
  const { base, root } = scratchRoot();
  mkdirSync(path.join(base, 'real'), { mode: 0o700 });
  symlinkSync(path.join(base, 'real'), path.join(base, 'link'));
  writeFileSync(path.join(base, 'file'), 'x');
  for (const argv of [
    ['--dry-run', `--marker-id=${MARKER}`],
    DRY('relative/root'),
    DRY(path.join(base, 'link')),
    DRY(path.join(base, 'missing')),
    DRY(path.join(base, 'file')),
    DRY(`${root}/`),
  ]) {
    const r = await run(argv);
    assert.equal(r.code, 1, JSON.stringify(argv));
    assert.doesNotMatch(r.text, /plan digest/);
  }
});

test('K07/K08/K09 output root outside the repository and temporary storage, owner-only', async () => {
  const { base, root } = scratchRoot();
  assert.equal((await run(DRY(root), { repoRoot: base })).code, 1);
  assert.equal((await run(DRY(root), { forbiddenRoots: [base] })).code, 1);
  const open = scratchRoot(0o755);
  assert.equal((await run(DRY(open.root))).code, 1);
  const group = scratchRoot(0o750);
  assert.equal((await run(DRY(group.root))).code, 1);
});

test('K10 output root owned by another uid is refused (policy evaluated against the given uid)', () => {
  const { root } = scratchRoot();
  const policy = { repoRoot: '/synthetic/repo', forbiddenRoots: ['/synthetic/tmp'] };
  assert.equal(backup.checkOutputRoot(root, { ...policy, uid: process.getuid() }).ok, true);
  assert.equal(backup.checkOutputRoot(root, { ...policy, uid: process.getuid() + 1 }).ok, false);
});

test('K12/K13 dry-run: no runtime, no process, NO DB CONNECTION line, plan digest, no secret in argv or output', async () => {
  const { root } = scratchRoot();
  const r = await run(DRY(root));
  assert.equal(r.code, 0, r.text);
  assert.ok(!r.order.includes('loadRuntime'));
  assert.equal(r.spawned.length, 0);
  assert.match(r.text, /^\[db:local-test-backup\] DRY RUN — NO DB CONNECTION WAS OPENED; no runtime was loaded and nothing was executed$/m);
  assert.match(r.text, /^  plan digest: [0-9a-f]{64}$/m);
  assert.match(r.text, /^  --execute requires --confirm-local-target=mona_local_test@127\.0\.0\.1:5432\/mona_local_test --plan=[0-9a-f]{64}$/m);
  assert.match(r.text, /--format=custom --no-owner --no-acl --schema=public --strict-names --lock-wait-timeout=10000 --no-password --host=127\.0\.0\.1 --port=5432 --username=mona_local_test --dbname=mona_local_test --snapshot=<exporter snapshot id> --file <run>\/local-test\.dump\.tmp/);
  assert.equal(runDirs(root).length, 0);
  assertNoLeak(r.text);
});

test('K14/K15 pg_dump and pg_restore must hash as regular executables at the pinned paths', async () => {
  const { root } = scratchRoot();
  assert.equal((await run(DRY(root), { binaries: { pg_dump: { ok: false, reason: 'is missing' } } })).code, 1);
  assert.equal((await run(DRY(root), { binaries: { pg_restore: { ok: false, reason: 'is missing' } } })).code, 1);
});

test('K16/K17/K18 only the canonical LOCAL_TEST target; forbidden env refused; marker must match', async () => {
  const { root } = scratchRoot();
  const bad = [
    `postgresql://mona_local_test:${SECRET}@localhost:5432/mona_local_test`,
    `postgresql://mona_local_test:${SECRET}@[::1]:5432/mona_local_test`,
    `postgresql://mona_local_test:${SECRET}@127.0.0.1:5433/mona_local_test`,
    `postgresql://mona_local_test:${SECRET}@127.0.0.1:5432/postgres`,
    `postgresql://postgres:${SECRET}@127.0.0.1:5432/mona_local_test`,
  ];
  for (const url of bad) {
    const r = await run(DRY(root), { env: { ...ENV, LOCAL_TEST_DATABASE_URL: url } });
    assert.equal(r.code, 1, url);
    assertNoLeak(r.text);
  }
  for (const key of ['PGPASSWORD', 'PGOPTIONS', 'DATABASE_URL', 'NODE_OPTIONS']) {
    assert.equal((await run(DRY(root), { env: { ...ENV, [key]: 'x' } })).code, 1, key);
  }
  assert.equal((await run(DRY(root), { env: { ...ENV, LOCAL_TEST_DATABASE_MARKER_ID: OTHER } })).code, 1);
});

test('K19/K20/K49 execute needs the exact confirmation and the exact plan (bound to the output root) before the runtime', async () => {
  const { root } = scratchRoot();
  const plan = await planFor(root);
  const noConfirm = await run(['--execute', `--marker-id=${MARKER}`, `--output-root=${root}`, `--plan=${plan}`]);
  assert.equal(noConfirm.code, 1);
  const other = scratchRoot();
  assert.notEqual(await planFor(other.root), plan);
  const wrong = await run(EXEC(root, await planFor(other.root)));
  assert.equal(wrong.code, 1);
  assert.match(wrong.text, /phase=plan/);
  assert.ok(!wrong.order.includes('loadRuntime'));
});

test('K21/K22 identity must be proven and the state must be exactly POST_BACKFILL before any dump', async () => {
  const { root } = scratchRoot();
  const proof = await execute(root, { runtime: { failOn: { prove: [1] } } });
  assert.equal(proof.code, 1);
  assert.ok(!proof.order.includes('pg_dump'));
  for (const state of ['FRESH', 'MIGRATED_EMPTY', 'POST_SEED1', 'EXACT_BASELINE', 'PARTIAL_UNSAFE', 'UNKNOWN']) {
    const r = await execute(root, { runtime: { states: [state] } });
    assert.equal(r.code, 1, state);
    assert.ok(!r.order.includes('pg_dump'), state);
    assert.match(r.text, /requires state POST_BACKFILL/);
  }
  assert.equal(runDirs(root).length, 0);
});

test('K23/K39/K40/K41 success: exact argv, password only in the child env, verified archive, owner-only finalized set', async () => {
  const { root } = scratchRoot();
  const r = await execute(root);
  assert.equal(r.code, 0, r.text);
  assert.deepEqual(r.order.filter((s) => !s.startsWith('hash:')), ['loadRuntime', 'prove', 'withBackupSnapshot', 'pg_dump', 'pg_restore', 'exporter-committed', 'close']); // R4: the exporter owns identity/state; the dump runs inside it
  const dump = r.spawned.find((s) => path.basename(s.command) === 'pg_dump');
  assert.equal(dump.command, PG_DUMP);
  const file = dump.args.at(-1);
  assert.deepEqual(dump.args, ['--format=custom', '--no-owner', '--no-acl', '--schema=public', '--strict-names', '--lock-wait-timeout=10000', '--no-password', '--host=127.0.0.1', '--port=5432', '--username=mona_local_test', '--dbname=mona_local_test', `--snapshot=${SNAPSHOT_ID}`, '--file', file]);
  for (const a of dump.args) assert.ok(!a.includes(SECRET));
  assert.equal(dump.options.shell, false);
  // V2.3.2: started contained — own PID namespace (unshare ... --pid --fork --kill-child) and process group.
  for (const child of r.spawned) {
    assert.equal(child.contained.command, '/usr/bin/unshare');
    assert.deepEqual(child.contained.args.slice(0, 6), ['--user', '--map-current-user', '--pid', '--fork', '--kill-child', '--']);
    assert.equal(child.options.detached, true);
  }
  assert.equal(dump.options.env.PGPASSWORD, SECRET);
  assert.deepEqual(Object.keys(dump.options.env).sort(), backup.PG_CHILD_ENV_KEYS.slice().sort());
  const restore = r.spawned.find((s) => path.basename(s.command) === 'pg_restore');
  assert.equal(restore.command, PG_RESTORE);
  assert.ok(!('PGPASSWORD' in restore.options.env));
  assert.ok(!restore.args.some((a) => a.startsWith('--dbname') || a === '-d'));
  const [dir] = runDirs(root);
  assert.equal(dir, 'local-test-20261003T120000Z-a1b2c3d4');
  const runDir = path.join(root, dir);
  assert.equal(lstatSync(runDir).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(runDir).sort(), ['local-test.dump', 'local-test.dump.manifest.json']);
  for (const f of readdirSync(runDir)) assert.equal(lstatSync(path.join(runDir, f)).mode & 0o777, 0o600);
  const manifestText = readFileSync(path.join(runDir, 'local-test.dump.manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.format, 'mona-local-test-backup/v4'); // V2.3.2 v3 added the checkpoint binding; R4 v4 embeds the digest-only PRE witness
  assert.equal(manifest.state, 'POST_BACKFILL');
  assert.equal(manifest.target, TARGET);
  assert.equal(manifest.markerIdSha256, sha(MARKER));
  assert.equal(manifest.dump.sha256, sha(ARCHIVE));
  assert.equal(manifest.dump.bytes, ARCHIVE.length);
  assert.equal(manifest.list.sha256, sha(TOC));
  assert.equal(manifest.list.tables, 26); // R4: exactly the 26 protected relations
  assert.equal(manifest.manifestSha256, backup.manifestSelfHash(manifest));
  assert.equal(manifestText, `${JSON.stringify(manifest, null, 2)}\n`);
  assertNoLeak(manifestText);
  const ok = r.text.split('\n').filter((l) => l.startsWith('[db:local-test-backup] LOCAL_TEST_BACKUP_OK'));
  assert.equal(ok.length, 1);
  assert.match(ok[0], new RegExp(`^\\[db:local-test-backup\\] LOCAL_TEST_BACKUP_OK run=${dir} dump_sha256=${sha(ARCHIVE)} bytes=${ARCHIVE.length} toc_tables=26 state=POST_BACKFILL checkpoint=cp-\\d{8}T\\d{6}Z-[0-9a-f]{32}$`));
  assert.equal(r.counts.SEED_MUST_NEVER_RUN, undefined);
  assert.equal(r.counts.BACKFILL_MUST_NEVER_RUN, undefined);
  assertNoLeak(r.text);
});

test('K24/K25/K26/K27/K28/K48 dump failures finalize nothing and leave no run artifacts', async () => {
  const cases = [
    { spawn: { pg_dump: { code: 1, stderr: ['pg_dump: error: connection failed'] } } },
    { spawn: { pg_dump: { signal: 'SIGKILL' } } },
    { spawn: { pg_dump: { hang: true } }, childTimeoutMs: 50 },
    { spawn: { pg_dump: { archive: Buffer.alloc(0) } } },
    { spawn: { pg_dump: { symlinkTo: '/etc/hostname' } } },
    { spawn: { pg_dump: { fileMode: 0o644 } } },
    { spawn: { pg_dump: { noFile: true } } },
  ];
  for (const opts of cases) {
    const { root } = scratchRoot();
    const r = await execute(root, opts);
    assert.equal(r.code, 1, JSON.stringify(opts));
    assert.ok(!/LOCAL_TEST_BACKUP_OK/.test(r.text));
    assert.equal(runDirs(root).length, 0, `artifacts left for ${JSON.stringify(opts)}`);
    assert.ok(r.order.includes('close'));
  }
});

test('K29/K30/K31/K32/K33 archive TOC must list cleanly: exit 0, entries, dbname, no marker schema, TABLE DATA for every TABLE', async () => {
  const tocs = [
    { pg_restore: { code: 1 } },
    { pg_restore: { toc: '' } },
    { pg_restore: { toc: TOC.replace('dbname: mona_local_test', 'dbname: postgres') } },
    { pg_restore: { toc: `${TOC}217; 2615 16400 SCHEMA - mona_local_test_guard mona_local_test\n` } },
    { pg_restore: { toc: TOC.replace(/^3000;.*\n/m, '') } },
  ];
  for (const spawn of tocs) {
    const { root } = scratchRoot();
    const r = await execute(root, { spawn });
    assert.equal(r.code, 1, JSON.stringify(spawn).slice(0, 80));
    assert.equal(runDirs(root).length, 0);
  }
});

// R4: K34/K35 (identity and state re-proven AFTER the dump by two further runtime calls) are replaced by the exporter contract:
// identity, settings, domain and POST_BACKFILL are proven INSIDE the snapshot the dump imports, and schema stability (B11) is
// proven by the runtime after the exporter commits (see "R4 an exporter that refuses" below and the runtime tests).
test('K34/K35 (R4) a failing identity proof and an exporter failure after the dump finalize nothing', async () => {
  const proof = await execute(scratchRoot().root, { runtime: { failOn: { prove: [1] } } });
  assert.equal(proof.code, 1);
  const after = await execute(scratchRoot().root, { runtime: { exporterFailsAfter: true } });
  assert.equal(after.code, 1);
  for (const r of [proof, after]) assert.ok(!/LOCAL_TEST_BACKUP_OK/.test(r.text));
});

test('K36 archive bytes changed between the first hash and the final re-hash', async () => {
  const { root } = scratchRoot();
  const r = await execute(root, { afterHash: (file) => writeFileSync(file, Buffer.from('tampered')) });
  assert.equal(r.code, 1);
  assert.equal(runDirs(root).length, 0);
});

test('K37 pg_dump stderr carrying the password is redacted', async () => {
  const { root } = scratchRoot();
  const r = await execute(root, { spawn: { pg_dump: { code: 1, stderr: [`pg_dump: error: password ${SECRET} rejected for ${URL_TEXT}`] } } });
  assert.equal(r.code, 1);
  assertNoLeak(r.text);
});

test('K38 a run-directory collision never overwrites', async () => {
  const { root } = scratchRoot();
  mkdirSync(path.join(root, 'local-test-20261003T120000Z-a1b2c3d4'), { mode: 0o700 });
  writeFileSync(path.join(root, 'local-test-20261003T120000Z-a1b2c3d4', 'keep'), 'mine');
  const r = await execute(root);
  assert.equal(r.code, 1);
  assert.ok(!r.order.includes('pg_dump'));
  assert.equal(readFileSync(path.join(root, 'local-test-20261003T120000Z-a1b2c3d4', 'keep'), 'utf8'), 'mine');
});

test('K42 the runtime is closed after every outcome', async () => {
  for (const opts of [{}, { runtime: { states: ['FRESH'] } }, { spawn: { pg_dump: { code: 1 } } }]) {
    const r = await execute(scratchRoot().root, opts);
    assert.equal(r.order.filter((s) => s === 'close').length, 1);
  }
});

test('K43 imports only node built-ins and the reviewed local modules; no static DB client, no shell', () => {
  const specifiers = [...SOURCE.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
  for (const s of specifiers) assert.ok(s.startsWith('node:') || ['./local-test-prepare.mjs', './pilot-migrate.mjs', './local-test-safe-error.mjs', './local-test-witness.mjs'].includes(s), `unexpected import ${s}`);
  assert.doesNotMatch(SOURCE, /PrismaClient|new\s+Pool\b|shell:\s*true|\bexecSync\b|\bexecFile/);
  const childImports = [...SOURCE.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:child_process'/g)].map((m) => m[1].trim());
  assert.deepEqual(childImports, ['spawn']);
});

test('K44/K45/K46 --verify re-checks a finalized set without any database or environment', async () => {
  const { root } = scratchRoot();
  const made = await execute(root);
  assert.equal(made.code, 0, made.text);
  const runDir = path.join(root, runDirs(root)[0]);
  const ok = await run([`--verify=${runDir}`], { env: {} });
  assert.equal(ok.code, 0, ok.text);
  assert.ok(!ok.order.includes('loadRuntime'));
  assert.match(ok.text, /^\[db:local-test-backup\] VERIFY OK run=local-test-20261003T120000Z-a1b2c3d4 dump_sha256=[0-9a-f]{64} toc_tables=26$/m);
  const manifestFile = path.join(runDir, 'local-test.dump.manifest.json');
  const original = readFileSync(manifestFile, 'utf8');
  writeFileSync(manifestFile, original.replace('"POST_BACKFILL"', '"EXACT_BASELINE"'));
  assert.equal((await run([`--verify=${runDir}`], { env: {} })).code, 1);
  writeFileSync(manifestFile, original);
  writeFileSync(path.join(runDir, 'extra'), 'x', { mode: 0o600 });
  assert.equal((await run([`--verify=${runDir}`], { env: {} })).code, 1);
  rmSync(path.join(runDir, 'extra'));
  writeFileSync(path.join(runDir, 'local-test.dump'), Buffer.from('other bytes'));
  assert.equal((await run([`--verify=${runDir}`], { env: {} })).code, 1);
  assert.ok(existsSync(manifestFile));
});

// --- V231. the manifest is the resume evidence local-test-prepare.mjs verifies ----------------------
const PAYLOAD = DEFAULT_PAYLOAD;

test('V231-B1 the manifest (v4 since R4) binds the verified migration payload (names + sha256) and the lock', async () => {
  const { root } = scratchRoot();
  const r = await execute(root, { payload: PAYLOAD });
  assert.equal(r.code, 0, r.text);
  const manifest = JSON.parse(readFileSync(path.join(root, runDirs(root)[0], 'local-test.dump.manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'mona-local-test-backup/v4');
  assert.deepEqual(manifest.migrations, G6_PAIRS);
  assert.deepEqual(manifest.lock, { provider: 'postgresql', sha256: sha('lock') });
  assert.equal(manifest.manifestSha256, backup.manifestSelfHash(manifest));
});

test('V231-B2 --verify refuses a V2.3 (v1) manifest even when it is canonical and re-self-hashed', async () => {
  const { root } = scratchRoot();
  const made = await execute(root, { payload: PAYLOAD });
  assert.equal(made.code, 0, made.text);
  const runDir = path.join(root, runDirs(root)[0]);
  const file = path.join(runDir, 'local-test.dump.manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const { migrations, lock, manifestSha256, ...v1 } = manifest;
  void migrations; void lock; void manifestSha256;
  v1.format = 'mona-local-test-backup/v1';
  v1.manifestSha256 = backup.manifestSelfHash(v1);
  writeFileSync(file, `${JSON.stringify(v1, null, 2)}\n`);
  const r = await run([`--verify=${runDir}`], { env: {} });
  assert.equal(r.code, 1);
  assert.match(r.text, /format/);
});

// --- V2.3.2: the backup is bound to the current prepare checkpoint (manifest v3) ----------------------
function emptyHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'mona-v232-backup-home-'));
  chmodSync(home, 0o700);
  return home;
}

test('V232-B-RED-1 no current prepare checkpoint: the backup refuses before any dump', async () => {
  const { root } = scratchRoot();
  const r = await execute(root, { home: emptyHome() }).catch((e) => ({ code: 1, order: [], text: String(e) }));
  assert.equal(r.code, 1, 'a backup was taken without a current prepare checkpoint');
  assert.ok(!r.order.includes('pg_dump'));
  assert.deepEqual(runDirs(root), []);
});

test('V232-B-RED-2 manifest (v4) binds the current checkpoint (id + record sha256)', async () => {
  const { root } = scratchRoot();
  const r = await execute(root);
  assert.equal(r.code, 0, r.text);
  const manifest = JSON.parse(readFileSync(path.join(root, runDirs(root)[0], 'local-test.dump.manifest.json'), 'utf8'));
  assert.equal(manifest.format, 'mona-local-test-backup/v4');
  assert.match(manifest.checkpoint?.id ?? '', /^cp-\d{8}T\d{6}Z-[0-9a-f]{32}$/);
  assert.match(manifest.checkpoint?.recordSha256 ?? '', /^[0-9a-f]{64}$/);
});

test('V232-B-RED-3 a proof that resolves false is a failure, never success', async () => {
  const { root } = scratchRoot();
  const r = await execute(root, { runtime: { proveResult: false } });
  assert.equal(r.code, 1, 'proveIdentity() === false was treated as a proof');
  assert.ok(!r.order.includes('pg_dump'));
});

// --- V232 mutation-gap tests ------------------------------------------------------------------------
test('V232-B-M03 the checkpoint superseded during the dump: nothing is finalized', async () => {
  const { root } = scratchRoot();
  const home = checkpointedHome();
  const r = await execute(root, {
    home,
    afterHash: () => assert.ok(prepare.supersedeCheckpoints(home, STORE_POLICY, { now: new Date('2026-10-03T12:00:01.000Z'), plan: sha('other run') }).ok),
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=checkpoint-after — the checkpoint was superseded or consumed during the backup; nothing was finalized/);
  assert.deepEqual(runDirs(root), []);
});

test('V232-B-M02 no current checkpoint is a specific static refusal, never a crash', async () => {
  const { root } = scratchRoot();
  for (const home of [emptyHome(), checkpointedHome({ record: false })]) {
    const r = await run(DRY(root), { home });
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=checkpoint — checkpoint store/);
    assert.doesNotMatch(r.text, /plan digest/);
  }
});

test('V232-B-B01 a dump without the custom-format magic is never finalized', async () => {
  const { root } = scratchRoot();
  const r = await execute(root, { spawn: { pg_dump: { archive: Buffer.from('not an archive at all') } } });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=archive — archive is not a PostgreSQL custom-format archive; nothing was finalized/);
  assert.deepEqual(runDirs(root), []);
});


// =====================================================================================================
// V2.3.3 R4 — snapshot-bound dump, stderr-empty, manifest v4 with the embedded digest-only PRE witness
// =====================================================================================================
import * as witness from './local-test-witness.mjs';
const V4_KEYS = ['format', 'target', 'markerIdSha256', 'state', 'createdAt', 'run', 'checkpoint', 'dump', 'migrations', 'lock', 'list', 'pgDump', 'pgRestore', 'tool', 'plan', 'preWitness', 'preWitnessSha256', 'tocMultisetSha256', 'dumpFlags', 'manifestSha256'];
const dumpOf = (r) => r.spawned.find((x) => path.basename(x.command) === 'pg_dump');
const manifestOf = (root) => { const dir = runDirs(root)[0]; return { dir, file: path.join(root, dir, 'local-test.dump.manifest.json'), json: JSON.parse(readFileSync(path.join(root, dir, 'local-test.dump.manifest.json'), 'utf8')) }; };
const allText = (root) => { const dir = runDirs(root)[0]; return dir ? readdirSync(path.join(root, dir)).map((f) => readFileSync(path.join(root, dir, f)).toString('latin1')).join('\n') : ''; };

test('AC-166/168/170 R4 pg_dump receives the exact exporter snapshot id and the pinned --lock-wait-timeout / --strict-names; the id is in no log or artifact', async () => {
  const { root } = scratchRoot();
  const r = await execute(root);
  assert.equal(r.code, 0, r.text);
  const args = dumpOf(r).args;
  for (const a of [`--snapshot=${SNAPSHOT_ID}`, '--lock-wait-timeout=10000', '--strict-names']) assert.equal(args.filter((x) => x === a).length, 1, a);
  assert.ok(!args.some((a) => a.includes(SECRET)));
  assert.equal(r.text.includes(SNAPSHOT_ID), false);
  assert.equal(allText(root).includes(SNAPSHOT_ID), false);
});

test('AC-167 R4 the dump and the list run INSIDE the exporter; it commits (and proves stability) before anything is finalized', async () => {
  const { root } = scratchRoot();
  const r = await execute(root);
  assert.deepEqual(r.order.filter((s) => !s.startsWith('hash:')), ['loadRuntime', 'prove', 'withBackupSnapshot', 'pg_dump', 'pg_restore', 'exporter-committed', 'close']);
});

test('AC-161 R4 pg_dump exit 0 with ANY stderr is refused: nothing finalized, no run artifact, and the bytes are never shown', async () => {
  for (const stderr of ['x', ' ', 'pg_dump: warning: CANARY_ROW_VALUE']) {
    const { root } = scratchRoot();
    const r = await execute(root, { spawn: { pg_dump: { stderr: [stderr] } } });
    assert.equal(r.code, 1, JSON.stringify(stderr));
    assert.equal(runDirs(root).length, 0);
    assert.equal(r.text.includes('CANARY_ROW_VALUE'), false);
    assert.match(r.text, /stderr/);
  }
});

test('AC-160 R4 pg_restore --list exit 0 with ANY stderr is refused: nothing finalized and the bytes are never shown', async () => {
  for (const stderr of ['x', ' ', 'pg_restore: warning: CANARY_ROW_VALUE']) {
    const { root } = scratchRoot();
    const r = await execute(root, { spawn: { pg_restore: { stderr: [stderr] } } });
    assert.equal(r.code, 1, JSON.stringify(stderr));
    assert.equal(runDirs(root).length, 0);
    assert.equal(r.text.includes('CANARY_ROW_VALUE'), false);
  }
});

test('R4 manifest v4: the exact closed key set; an embedded 8-key digest-only PRE witness bound by preWitnessSha256; the TOC multiset digest; dump flags; exactly two files; no stream, no snapshot id', async () => {
  const { root } = scratchRoot();
  const r = await execute(root);
  assert.equal(r.code, 0, r.text);
  const { dir, json } = manifestOf(root);
  assert.deepEqual(Object.keys(json), V4_KEYS);
  assert.equal(json.format, 'mona-local-test-backup/v4');
  const expectedWitness = { format: 'mona-local-test-pre-witness/v1', digestScheme: 'MONA/V233/STATE-DIGEST/SD1', streamFormat: 3, target: TARGET, markerIdSha256: sha(MARKER), serverVersionNum: '170004', protectedDomainContractSha256: DOMAIN_SHA, fPre: F_PRE };
  assert.deepEqual(json.preWitness, expectedWitness);
  const text = witness.buildWitness('PRE', { markerIdSha256: sha(MARKER), serverVersionNum: '170004', protectedDomainContractSha256: DOMAIN_SHA, fPre: F_PRE });
  assert.equal(json.preWitnessSha256, witness.preWitnessSha256(text));
  assert.equal(json.tocMultisetSha256, prepare.checkToc(TOC).multisetSha256);
  assert.deepEqual(json.dumpFlags, { snapshot: true, lockWaitTimeout: true, strictNames: true });
  assert.deepEqual(readdirSync(path.join(root, dir)).sort(), ['local-test.dump', 'local-test.dump.manifest.json']);
  for (const forbidden of ['fPost', 'streamSha256', 'schemaDigest', 'relationDigests', 'snapshotId', 'F']) assert.ok(!(forbidden in json), forbidden);
  assert.equal(json.manifestSha256, backup.manifestSelfHash(json));
});

test('AC-163/164/165 R4 --verify refuses a third file, an unknown key, a v3 manifest, a tampered embedded witness and a witness hash that does not match its text', async () => {
  const mutate = (root, edit) => {
    const { dir, file, json } = manifestOf(root);
    const next = edit(structuredClone(json));
    next.manifestSha256 = prepare.backupManifestSelfHash(next);
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    return path.join(root, dir);
  };
  const verify = async (runDir) => run([`--verify=${runDir}`]);
  const make = async () => { const { root } = scratchRoot(); const r = await execute(root); assert.equal(r.code, 0, r.text); return root; };
  assert.equal((await verify('/synthetic/not-a-run-directory')).code, 1); // a non-run path is refused
  const base = await make();
  const okDir = path.join(base, runDirs(base)[0]);
  assert.equal((await verify(okDir)).code, 0);
  // a third file in the run directory
  writeFileSync(path.join(okDir, 'local-test.fingerprint.bin'), 'x', { mode: 0o600 });
  assert.equal((await verify(okDir)).code, 1);
  rmSync(path.join(okDir, 'local-test.fingerprint.bin'));
  // unknown key / stale format / tampered embedded witness / hash not matching text
  const cases = [
    (m) => ({ ...m, extra: 1 }),
    (m) => ({ ...m, format: 'mona-local-test-backup/v3' }),
    (m) => ({ ...m, preWitness: { ...m.preWitness, fPre: 'f'.repeat(64) } }),
    (m) => ({ ...m, preWitnessSha256: 'e'.repeat(64) }),
    (m) => ({ ...m, preWitness: { ...m.preWitness, serverVersionNum: '160001' } }),
    (m) => ({ ...m, preWitness: { ...m.preWitness, fExtra: 'x' } }),
    (m) => ({ ...m, tocMultisetSha256: '0'.repeat(64) }),
  ];
  for (const edit of cases) {
    const root = await make();
    const runDir = mutate(root, edit);
    assert.equal((await verify(runDir)).code, 1, String(edit));
  }
});

test('R4 an exporter that refuses (state not POST_BACKFILL, or the catalog changed during the dump) finalizes nothing and leaves no run artifact', async () => {
  for (const runtime of [{ states: ['PARTIAL_UNSAFE'] }, { exporterFailsAfter: true }]) {
    const { root } = scratchRoot();
    const r = await execute(root, { runtime });
    assert.equal(r.code, 1, JSON.stringify(runtime));
    assert.equal(runDirs(root).length, 0);
    assert.ok(r.order.includes('close'));
    assertNoLeak(r.text);
  }
});

// --- HG. historical backup verification: explicit versioned schema generations ------------------------------------
// Generation 1-5 (migrations through block1) archived 25 protected relations; generation 1-6 (Pricing V2) adds
// CompanyPricingConfig. --verify must recognise exactly these two, each against its own exact relation set.
const G5_RELATIONS = R4_RELATIONS.filter((n) => n !== 'CompanyPricingConfig');
const HG_ENTRY = /^\d+; \d+ \d+ (TABLE DATA|TABLE|SCHEMA|COMMENT|TYPE|FUNCTION|CONSTRAINT|FK CONSTRAINT|INDEX|TRIGGER) (\S+) (.+) \S+$/;
const HG_PAYLOAD = (pairs) => ({ ok: true, migrations: pairs.map(([name, sha256]) => ({ name, sha256 })), lock: { provider: 'postgresql', sha256: sha('lock') } });
const HG_HOME = checkpointedHome({ payload: HG_PAYLOAD(G6_PAIRS) });

// A finalized run (made by the real tool under the CURRENT contract) whose manifest is re-bound, independently of the code
// under test, to `pairs` and to the TOC listing `toc`: canonical, re-self-hashed, so only the version contract can refuse it.
async function hgRun({ pairs = G6_PAIRS, toc = TOC, mutate } = {}) {
  const { root } = scratchRoot();
  const made = await execute(root, { payload: HG_PAYLOAD(G6_PAIRS), home: HG_HOME });
  assert.equal(made.code, 0, made.text);
  const runDir = path.join(root, runDirs(root)[0]);
  const file = path.join(runDir, 'local-test.dump.manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  const entries = toc.split('\n').map((l) => HG_ENTRY.exec(l)).filter(Boolean).map((m) => `${m[1]}\t${m[2]}\t${m[3]}`);
  manifest.migrations = pairs;
  manifest.list = { sha256: createHash('sha256').update(toc).digest('hex'), entries: entries.length, tables: entries.filter((e) => e.startsWith('TABLE\t')).length };
  manifest.tocMultisetSha256 = createHash('sha256').update(`${[...entries].sort().join('\n')}\n`).digest('hex');
  if (mutate) mutate(manifest, runDir);
  manifest.manifestSha256 = backup.manifestSelfHash(manifest);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return runDir;
}
const hgVerify = (runDir, toc) => run([`--verify=${runDir}`], { env: {}, spawn: { pg_restore: { toc } } });
const G5_TOC = r4Toc({ tables: G5_RELATIONS });

test('HG01 ALLOW: an exact approved migration-5 archive verifies against the 25-relation generation', async () => {
  const r = await hgVerify(await hgRun({ pairs: G5_PAIRS, toc: G5_TOC }), G5_TOC);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /VERIFY OK .* toc_tables=25/);
  assert.ok(!r.order.includes('loadRuntime'));
});

test('HG02 ALLOW: an exact approved migration-6 archive verifies against the 26-relation generation', async () => {
  const r = await hgVerify(await hgRun({}), TOC);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /toc_tables=26/);
});

test('HG03/HG04/HG05/HG06/HG07/HG17 DENY: unknown, future, missing, reordered, wrong-digest and changed-payload migration sets', async () => {
  const swapped = [G6_PAIRS[1], G6_PAIRS[0], ...G6_PAIRS.slice(2)];
  const wrongDigest = G6_PAIRS.map(([n, s], i) => (i === 4 ? [n, sha('tampered block1')] : [n, s]));
  const wrongPricing = G6_PAIRS.map(([n, s], i) => (i === 5 ? [n, sha('tampered v2')] : [n, s]));
  const cases = {
    unknownSynthetic: [['20260907015311_init', sha('m1')]],
    futureSeventh: [...G6_PAIRS, ['20261201000000_future', sha('future')]],
    missingKnown: G6_PAIRS.filter((_, i) => i !== 2),
    onlyFirstFour: G6_PAIRS.slice(0, 4),
    reordered: swapped,
    wrongDigestBlock1: wrongDigest,
    changedPricingPayload: wrongPricing,
    empty: [],
  };
  for (const [label, pairs] of Object.entries(cases)) {
    for (const [toc, name] of [[TOC, 'g6toc'], [G5_TOC, 'g5toc']]) {
      const r = await hgVerify(await hgRun({ pairs, toc }), toc);
      assert.equal(r.code, 1, `${label}/${name} must be denied`);
    }
  }
});

test('HG08/HG09/HG10/HG11/HG14 DENY: relation sets that are not exactly the manifest generation', async () => {
  const dropOne = (names, n) => names.filter((x) => x !== n);
  const cases = [
    ['g5 missing relation', G5_PAIRS, r4Toc({ tables: dropOne(G5_RELATIONS, 'Sale') })],
    ['g5 extra relation', G5_PAIRS, r4Toc({ tables: [...G5_RELATIONS, 'ExtraTable'] })],
    ['g5 with CompanyPricingConfig', G5_PAIRS, TOC],
    ['g6 missing CompanyPricingConfig', G6_PAIRS, G5_TOC],
    ['g6 extra relation', G6_PAIRS, r4Toc({ tables: [...R4_RELATIONS, 'ExtraTable'] })],
    ['g5 duplicate relation', G5_PAIRS, r4Toc({ tables: [...G5_RELATIONS, 'Sale'] })],
    ['g6 duplicate relation', G6_PAIRS, r4Toc({ tables: [...R4_RELATIONS, 'CompanyPricingConfig'] })],
  ];
  for (const [label, pairs, toc] of cases) {
    const r = await hgVerify(await hgRun({ pairs, toc }), toc);
    assert.equal(r.code, 1, `${label} must be denied`);
  }
});

test('HG12/HG13/HG16 DENY: TOC mutation, manifest self-hash mutation and a non-regular archive', async () => {
  const dir = await hgRun({ pairs: G5_PAIRS, toc: G5_TOC });
  assert.equal((await hgVerify(dir, G5_TOC.replace('TABLE DATA public Sale ', 'TABLE DATA public Sale  '))).code, 1);
  assert.equal((await hgVerify(dir, r4Toc({ tables: G5_RELATIONS, extra: ['5001; 1259 40001 INDEX public Sale ix mona_local_test'] }))).code, 1);
  const file = path.join(dir, 'local-test.dump.manifest.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, `${JSON.stringify({ ...manifest, manifestSha256: sha('forged') }, null, 2)}\n`);
  assert.equal((await hgVerify(dir, G5_TOC)).code, 1);
  const linked = await hgRun({ pairs: G5_PAIRS, toc: G5_TOC, mutate: (_, d) => { rmSync(path.join(d, 'local-test.dump')); symlinkSync('/etc/hostname', path.join(d, 'local-test.dump')); } });
  assert.equal((await hgVerify(linked, G5_TOC)).code, 1);
});

test('HG15 DENY: the expected relation set is never derived from the archive', () => {
  // A caller (or archive) cannot supply its own expectation: the archive's own 25 names, or any other list, are refused.
  assert.equal(prepare.checkToc(G5_TOC).ok, false);
  assert.equal(prepare.checkToc(G5_TOC, G5_RELATIONS).ok, true);
  assert.equal(prepare.checkToc(G5_TOC, [...G5_RELATIONS, 'ExtraTable']).ok, false);
  assert.equal(prepare.checkToc(r4Toc({ tables: ['Sale'] }), ['Sale']).ok, false);
  assert.equal(prepare.checkToc(TOC, G5_RELATIONS).ok, false);
});

test('HG18 SCOPE: backup creation and the resume contract still require the current 26 relations', async () => {
  const { root } = scratchRoot();
  const made = await execute(root, { payload: HG_PAYLOAD(G6_PAIRS), home: HG_HOME, spawn: { pg_restore: { toc: G5_TOC } } });
  assert.equal(made.code, 1);
  assert.equal(runDirs(root).length, 0);
  assert.equal(prepare.checkToc(TOC).ok, true);
});

test('HG19 the current generation is pinned to the OWNER-approved payload; a new migration needs a new reviewed generation', async () => {
  const witness = await import('./local-test-witness.mjs');
  const { APPROVED_MIGRATION_PAYLOAD } = await import('./pilot-migrate.mjs');
  const [g5, g6] = witness.BACKUP_SCHEMA_GENERATIONS;
  assert.deepEqual(witness.BACKUP_SCHEMA_GENERATIONS.map((g) => g.id), ['G1-5', 'G1-6']);
  assert.deepEqual(g6.migrations, APPROVED_MIGRATION_PAYLOAD.migrations.map((m) => [m.name, m.sha256]));
  assert.deepEqual(g5.migrations, g6.migrations.slice(0, 5));
  assert.deepEqual(g5.migrations, G5_PAIRS);
  assert.deepEqual([...g6.relations], [...witness.PROTECTED_RELATION_NAMES]);
  assert.deepEqual([...g5.relations], G5_RELATIONS);
  assert.equal(g5.relations.length, 25);
  assert.equal(g6.relations.length, 26);
  assert.ok(Object.isFrozen(witness.BACKUP_SCHEMA_GENERATIONS) && Object.isFrozen(g5) && Object.isFrozen(g5.migrations) && Object.isFrozen(g5.relations));
  assert.equal(witness.resolveBackupGeneration(g5.migrations)?.id, 'G1-5');
  assert.equal(witness.resolveBackupGeneration(g6.migrations)?.id, 'G1-6');
  assert.equal(witness.resolveBackupGeneration(undefined), null);
  assert.equal(witness.resolveBackupGeneration('G1-6'), null);
});
