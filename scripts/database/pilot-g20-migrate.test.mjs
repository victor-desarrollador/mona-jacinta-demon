// Zero-database unit tests for scripts/database/pilot-g20-migrate.mjs: the OWNER-only guarded G16 → G20 deploy.
// Run with: node --test scripts/database/pilot-g20-migrate.test.mjs
// Hermetic: synthetic *.invalid URLs, an injected fake pg client, an injected fake spawn (no child process is ever
// started) and throwaway fake `api/` trees in a temp directory. The real private PILOT files are never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from './pilot-g20-migrate.mjs';
import { API_DIR, PRISMA_ARGS } from './pilot-migrate.mjs';
import { LEDGER_SQL } from './pilot-migration-states.mjs';
import { GENERATIONS, pinsOf } from './pilot-migration-generations.mjs';
import { GENERATION_SCHEMA_G20 as GENERATION_SCHEMA } from './pilot-g20-schema-references.mjs';
import { PROJECTION_SQL, buildProjection, projectionDigest } from './app-schema-projection.mjs';

const MARKER = '2b4d6f81-7a9c-4e0b-8d2f-3c5e7a9b1d0f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = 'pilotsynthref0000001';
const SECRET = 'G20ecretPw';
const USER = `postgres.${REF}`;
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://${USER}:${SECRET}@${HOST}:6543/postgres`;
const LEAKS = [SECRET, HOST, REF, USER, URL_TEXT, `${HOST}:6543`, os.homedir()];
const FORBIDDEN_SQL = /\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER|GRANT|REVOKE|CREATE|INSERT|COMMIT)\b/i;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const DRY = (state = 'EXACT_G16') => ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--expected-initial-state=${state}`];
const EXECUTE = (plan, state = 'EXACT_G16') => ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`, `--expected-initial-state=${state}`, `--plan=${plan}`];

const TMP = mkdtempSync(path.join(os.tmpdir(), 'pilot-g20-migrate-test-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
mkdirSync(path.join(TMP, 'scripts', 'certs'), { recursive: true });
writeFileSync(path.join(TMP, 'scripts', 'certs', 'supabase-prod-ca-2021.crt'), 'FAKE-PILOT-CA\n');
let fixtureCount = 0;
// A fake api/ with the repository-local prisma and a byte-exact copy of the REAL reviewed G20 tree.
function fakeApi({ migrations = pinsOf('EXACT_G20').map((m) => m.name), schema = 'mock schema the tooling binding hashes\n' } = {}) {
  const root = path.join(TMP, `api-${fixtureCount++}`);
  const pkg = path.join(root, 'node_modules', 'prisma');
  mkdirSync(path.join(pkg, 'build'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ devDependencies: { prisma: '7.10.0' } }));
  writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'prisma', version: '7.10.0' }));
  writeFileSync(path.join(pkg, 'build', 'index.js'), '#!/usr/bin/env node\n');
  symlinkSync('../prisma/build/index.js', path.join(root, 'node_modules', '.bin', 'prisma'));
  writeFileSync(path.join(root, 'prisma.config.ts'), 'export default {}\n');
  const real = path.join(API_DIR, 'prisma', 'migrations');
  const dest = path.join(root, 'prisma', 'migrations');
  mkdirSync(dest, { recursive: true });
  for (const name of migrations) cpSync(path.join(real, name), path.join(dest, name), { recursive: true });
  cpSync(path.join(real, 'migration_lock.toml'), path.join(dest, 'migration_lock.toml'));
  writeFileSync(path.join(root, 'prisma', 'schema.prisma'), schema);
  return root;
}
const API = fakeApi();

// Synthetic schema references: one distinct catalog per generation, no probes (the real ones are proven on PG17).
const rawCatalog = (tables) => ({
  tables: tables.map((t) => ({ table: t })),
  columns: tables.map((t) => ({ table: t, column: 'id', type: 'text', not_null: true, default_expr: null, identity: '', generated: '' })),
  enums: [], types: [], constraints: [], indexes: [], functions: [], triggers: [],
});
const RAW = { EXACT_G16: rawCatalog(['Sale']), EXACT_G17: rawCatalog(['Sale', 'Enum17']), EXACT_G18: rawCatalog(['Sale', 'SaleExchange']), EXACT_G19: rawCatalog(['Sale', 'SaleExchange', 'Guard']), EXACT_G20: rawCatalog(['Sale', 'SaleExchange', 'Guard', 'Claim']) };
const SCHEMA = {
  references: Object.fromEntries(Object.entries(RAW).map(([k, raw]) => [k, { digest: projectionDigest(buildProjection(raw)) }])),
  probes: { EXACT_G16: [], EXACT_G17: [], EXACT_G18: [], EXACT_G19: [], EXACT_G20: [] },
};
const ledgerOf = (generation) => pinsOf(generation).map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));
const phase = (generation, patch = {}) => ({ ledger: ledgerOf(generation), raw: RAW[generation], ...patch });

function canonicalFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    relations: [{ name: 'database_identity_pkey', kind: 'i' }, { name: 'database_identity', kind: 'r' }],
    table: { kind: 'r', persistence: 'p', isPartition: false, ofType: false, ownerIsCurrentUser: true, rowSecurity: false, forceRowSecurity: false, hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0 },
    columns: [
      { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '', collation: null },
      { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '', collation: 'default' },
      { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '', collation: null },
      { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '', collation: null },
    ],
    constraints: [{ type: 'p', definition: 'PRIMARY KEY (singleton)' }, { type: 'c', definition: 'CHECK (singleton)' }, { type: 'c', definition: "CHECK ((environment = 'pilot'::text))" }],
  };
}

// The snapshots are served in order: BEGIN … READ ONLY #1 is the pre-check, #2 the post-check (or post-failure look).
function fakeClient({ phases }) {
  const sql = [];
  let snapshot = -1;
  return {
    sql,
    connection: { stream: { encrypted: true, authorized: true } },
    async connect() {},
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      sql.push(text);
      if (text === 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY') { snapshot += 1; return { rows: [] }; }
      const db = phases[Math.min(Math.max(snapshot, 0), phases.length - 1)];
      if (text.includes("current_setting('transaction_read_only')")) return { rows: [{ read_only: 'on' }] };
      if (text.startsWith('SELECT marker_id::text AS marker_id')) return { rows: [{ marker_id: MARKER, environment: 'pilot' }] };
      if (text.includes('to_regclass(\'public."_prisma_migrations"\')')) return { rows: [{ present: true }] };
      if (text === LEDGER_SQL) return { rows: db.ledger };
      if (text === PROJECTION_SQL.searchPath) return { rows: [{ search_path: 'pg_catalog, pg_temp' }] };
      const key = Object.keys(PROJECTION_SQL).find((k) => PROJECTION_SQL[k] === text);
      if (key) return { rows: db.raw[key] };
      if (text.includes('to_regnamespace')) return { rows: [{ schema_exists: true, table_exists: true, test_guard_exists: false }] };
      if (text.includes('json_build_object')) return { rows: [{ facts: canonicalFacts() }] };
      if (text.startsWith('SELECT environment')) return { rows: [{ environment: 'pilot', marker_id: MARKER, has_installed_at: true }] };
      return { rows: [] };
    },
    async end() {},
  };
}

function fakeSpawn({ code = 0, signal = null, onSpawn } = {}) {
  const spawned = [];
  const spawn = (command, args, options) => {
    spawned.push({ command, args, options });
    onSpawn?.({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.write(`Applying migration with ${URL_TEXT}\n`);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit('close', code, signal));
    });
    return child;
  };
  return { spawn, spawned };
}

async function run(argv, opts = {}) {
  const out = [];
  const created = [];
  const client = opts.client ?? fakeClient({ phases: opts.phases ?? [phase('EXACT_G16'), phase('EXACT_G20')] });
  const spawner = opts.spawner ?? fakeSpawn();
  const deps = {
    apiDir: opts.apiDir ?? API,
    urlFile: '/nonexistent/synthetic/pilot-database-url',
    readUrlFile: () => ({ ok: true, text: opts.urlText ?? `${URL_TEXT}\n` }),
    env: opts.env ?? {},
    createClient: (conn) => { created.push(conn); return client; },
    spawn: spawner.spawn,
    execPath: '/opt/synthetic/node/bin/node',
    home: '/home/synthetic',
    tmpdir: TMP,
    moduleDir: MODULE_DIR,
    schema: opts.schema ?? SCHEMA,
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  };
  const code = await M.main(argv, deps);
  for (const q of client.sql) assert.ok(!FORBIDDEN_SQL.test(q) || q.startsWith('SELECT json_build_object('), `mutating SQL issued: ${q}`);
  const text = out.join('\n');
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `output leaked ${JSON.stringify(leak)}`);
  return { code, text, created, client, spawned: spawner.spawned };
}
const digestOf = async (state, opts) => {
  const r = await run(DRY(state), opts);
  assert.equal(r.code, 0, r.text);
  return /PLAN_DIGEST=([0-9a-f]{64})/.exec(r.text)[1];
};
const PLAN = await digestOf('EXACT_G16');

test('G20M-01 CLI: only G16, G17, G18 or G19 as the explicit initial state; one mode; canonical marker; execute needs ref and plan', () => {
  assert.equal(M.parseCliArgs(DRY()).ok, true);
  assert.equal(M.parseCliArgs(DRY('EXACT_G17')).ok, true);
  assert.equal(M.parseCliArgs(DRY('EXACT_G18')).ok, true);
  assert.equal(M.parseCliArgs(DRY('EXACT_G19')).ok, true);
  assert.deepEqual(M.parseCliArgs(EXECUTE(PLAN)), { ok: true, mode: 'execute', markerId: MARKER, confirmProjectRef: REF, initialState: 'EXACT_G16', plan: PLAN });
  for (const argv of [
    [], DRY('EXACT_G20'), DRY('EXACT_G15'), DRY('EXACT_G14'), DRY('EXACT_G11'), DRY('EXACT_G7'), ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=test', '--dry-run', `--marker-id=${MARKER}`, '--expected-initial-state=EXACT_G16'],
    [...DRY(), '--dry-run'], [...DRY(), `--plan=${PLAN}`], [...DRY(), '--extra=1'], EXECUTE('nothex'),
    ['--target=pilot', '--execute', `--marker-id=${MARKER}`, '--expected-initial-state=EXACT_G16', `--plan=${PLAN}`],
  ]) assert.equal(M.parseCliArgs(argv).ok, false, argv.join(' '));
});

test('G20M-02 dry-run opens no client, spawns nothing, lists exactly the migrations to apply and a deterministic digest', async () => {
  const r = await run(DRY('EXACT_G16'));
  assert.equal(r.code, 0, r.text);
  assert.equal(r.created.length, 0);
  assert.equal(r.spawned.length, 0);
  assert.match(r.text, /no database connection was opened/);
  assert.match(r.text, /exactly 20 OWNER-approved migrations \(G20\)/);
  assert.match(r.text, /migrations to apply: 4/);
  assert.match(r.text, /\+ 20261026120000_sale_exchange_enum/);
  assert.match(r.text, /\+ 20261026130000_sale_exchange_schema/);
  assert.match(r.text, /\+ 20261026140000_sale_void_exchange_guard/);
  assert.match(r.text, /\+ 20261026150000_sale_post_sale_guard/);
  assert.match(r.text, /RBAC catalog is NOT touched/);
  assert.equal(await digestOf('EXACT_G16'), PLAN);
  const g15 = await run(DRY('EXACT_G17'));
  assert.match(g15.text, /migrations to apply: 3/);
  assert.match((await run(DRY('EXACT_G18'))).text, /migrations to apply: 2/);
  assert.match((await run(DRY('EXACT_G19'))).text, /migrations to apply: 1/);
  assert.notEqual(/PLAN_DIGEST=([0-9a-f]{64})/.exec(g15.text)[1], PLAN, 'another initial state is another plan');
});

test('G20M-03 the shipped references are PINNED for G16..G20: the dry run prints a plan with their digests; a reference that is pending (null) refuses — no plan, no client, no spawn', async () => {
  for (const initial of ['EXACT_G16', 'EXACT_G17', 'EXACT_G18', 'EXACT_G19']) {
    const r = await run(DRY(initial), { schema: GENERATION_SCHEMA });
    assert.equal(r.code, 0, r.text);
    assert.ok(r.text.includes(GENERATION_SCHEMA.references[initial].digest) && r.text.includes(GENERATION_SCHEMA.references.EXACT_G20.digest));
    assert.equal(r.created.length, 0); assert.equal(r.spawned.length, 0);
  }
  assert.equal(new Set(Object.values(GENERATION_SCHEMA.references).map((x) => x.digest)).size, 5);
  for (const pending of ['EXACT_G16', 'EXACT_G17', 'EXACT_G18', 'EXACT_G19', 'EXACT_G20']) {
    const schema = { ...GENERATION_SCHEMA, references: { ...GENERATION_SCHEMA.references, [pending]: { digest: null, pending: true } } };
    for (const initial of ['EXACT_G16', 'EXACT_G17', 'EXACT_G18', 'EXACT_G19']) {
      if (pending !== initial && pending !== 'EXACT_G20') continue;
      for (const argv of [DRY(initial), EXECUTE('a'.repeat(64), initial)]) {
        const r = await run(argv, { schema });
        assert.equal(r.code, 1, `${pending}/${initial}`); assert.match(r.text, /phase=reference/); assert.equal(r.created.length, 0); assert.equal(r.spawned.length, 0);
      }
    }
  }
});

test('G20M-04 tree drift fails closed before any client: G16/G17/G18/G19 tree, extra migration, altered bytes, unknown name, symlink', async () => {
  const names = pinsOf('EXACT_G20').map((m) => m.name);
  const cases = [];
  cases.push(['G16 tree (exchange migrations absent)', fakeApi({ migrations: names.slice(0, 16) })]);
  cases.push(['G17 tree', fakeApi({ migrations: names.slice(0, 17) })]);
  cases.push(['G18 tree (void guard absent)', fakeApi({ migrations: names.slice(0, 18) })]);
  cases.push(['G19 tree (the post-sale claim absent)', fakeApi({ migrations: names.slice(0, 19) })]);
  const extra = fakeApi();
  mkdirSync(path.join(extra, 'prisma', 'migrations', '20261101000000_unreviewed'));
  writeFileSync(path.join(extra, 'prisma', 'migrations', '20261101000000_unreviewed', 'migration.sql'), 'select 1;\n');
  cases.push(['extra migration', extra]);
  const altered = fakeApi();
  appendFileSync(path.join(altered, 'prisma', 'migrations', names[19], 'migration.sql'), '-- tampered\n');
  cases.push(['altered checksum/size', altered]);
  const linked = fakeApi();
  rmSync(path.join(linked, 'prisma', 'migrations', names[3], 'migration.sql'));
  symlinkSync(path.join(API_DIR, 'prisma', 'migrations', names[3], 'migration.sql'), path.join(linked, 'prisma', 'migrations', names[3], 'migration.sql'));
  cases.push(['symlinked migration', linked]);
  for (const [label, apiDir] of cases) {
    for (const argv of [DRY(), EXECUTE(PLAN)]) {
      const r = await run(argv, { apiDir });
      assert.equal(r.code, 1, label);
      assert.match(r.text, /phase=payload/, label);
      assert.equal(r.created.length, 0, label);
      assert.equal(r.spawned.length, 0, label);
    }
  }
});

test('G20M-05 execute with a foreign plan, another marker/project or another initial state is refused before any client', async () => {
  for (const argv of [EXECUTE('a'.repeat(64)), EXECUTE(PLAN, 'EXACT_G17'), ['--target=pilot', '--execute', `--marker-id=${OTHER}`, `--confirm-project-ref=${REF}`, '--expected-initial-state=EXACT_G16', `--plan=${PLAN}`]]) {
    const r = await run(argv);
    assert.equal(r.code, 1);
    assert.match(r.text, /PLAN_BINDING_MISMATCH/);
    assert.equal(r.created.length, 0);
    assert.equal(r.spawned.length, 0);
  }
  const wrongRef = await run(['--target=pilot', '--execute', `--marker-id=${MARKER}`, '--confirm-project-ref=otherrefsynthetic0002', '--expected-initial-state=EXACT_G16', `--plan=${PLAN}`]);
  assert.equal(wrongRef.code, 1);
  assert.equal(wrongRef.spawned.length, 0);
});

test('G20M-06 G16 → G20: identity proof, read-only pre-check, ONE staged Prisma deploy, read-only post-check, result EXACT_G20', async () => {
  const staged = [];
  const spawner = fakeSpawn({ onSpawn: ({ options }) => { staged.push(readdirSync(path.join(options.cwd, 'prisma', 'migrations')).sort()); } });
  const r = await run(EXECUTE(PLAN), { spawner });
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /precheck ok — ledger EXACT_G16/);
  assert.match(r.text, /postcheck ok — ledger EXACT_G20/);
  assert.match(r.text, /PILOT_G20_MIGRATE_RESULT=EXACT_G20/);
  assert.equal(r.spawned.length, 1);
  const [spawn] = r.spawned;
  assert.equal(spawn.command, '/opt/synthetic/node/bin/node');
  assert.deepEqual(spawn.args.slice(1), [...PRISMA_ARGS]);
  assert.equal(spawn.options.shell, false);
  assert.deepEqual(Object.keys(spawn.options.env).sort(), ['CHECKPOINT_DISABLE', 'DATABASE_URL', 'HOME', 'NODE_ENV', 'PATH', 'PRISMA_HIDE_UPDATE_MESSAGE', 'TMPDIR']);
  assert.equal(staged[0].length, 21, 'twenty migration directories plus the lock');
  assert.ok(!existsSync(spawn.options.cwd), 'the private stage is removed after the run');
  assert.ok(r.text.includes('«redacted»'), 'child output is redacted');
});

test('G20M-07 EXACT_G17, EXACT_G18 and EXACT_G19 resume with the remaining migrations', async () => {
  for (const initial of ['EXACT_G17', 'EXACT_G18', 'EXACT_G19']) {
    const plan = await digestOf(initial);
    const r = await run(EXECUTE(plan, initial), { phases: [phase(initial), phase('EXACT_G20')] });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, new RegExp(`precheck ok — ledger ${initial}`));
    assert.match(r.text, /PILOT_G20_MIGRATE_RESULT=EXACT_G20/);
    assert.equal(r.spawned.length, 1);
  }
});

test('G20M-08 the pre-check refuses any other ledger or schema; Prisma is never spawned', async () => {
  const g14 = ledgerOf('EXACT_G16'); // the G16 ledger (sixteen rows)
  const refused = [
    ['already G20', [phase('EXACT_G20')]],
    ['G17 while G16 was named', [phase('EXACT_G17')]],
    ['G15-era ledger (a migration missing)', [phase('EXACT_G16', { ledger: g14.slice(0, 15) })]],
    ['altered checksum', [phase('EXACT_G16', { ledger: g14.map((row, i) => (i === 15 ? { ...row, checksum: 'f'.repeat(64) } : row)) })]],
    ['unknown migration in the ledger', [phase('EXACT_G16', { ledger: [...g14, { migration_name: '20261101000000_unknown', checksum: 'a'.repeat(64), finished: true, rolled_back: false }] })]],
    ['unfinished migration', [phase('EXACT_G16', { ledger: g14.map((row, i) => (i === 15 ? { ...row, finished: false } : row)) })]],
    ['rolled-back migration', [phase('EXACT_G16', { ledger: g14.map((row, i) => (i === 15 ? { ...row, rolled_back: true } : row)) })]],
    ['schema drift (right ledger, other app schema)', [phase('EXACT_G16', { raw: RAW.EXACT_G20 })]],
  ];
  for (const [label, phases] of refused) {
    const r = await run(EXECUTE(PLAN), { phases });
    assert.equal(r.code, 1, label);
    assert.match(r.text, /phase=precheck/, label);
    assert.equal(r.spawned.length, 0, label);
  }
});

test('G20M-09 a probe failure at the pre-check is reported and refuses', async () => {
  const schema = { references: SCHEMA.references, probes: { ...SCHEMA.probes, EXACT_G16: [{ kind: 'table', name: 'MissingTable' }] } };
  const r = await run(EXECUTE(await digestOf('EXACT_G16', { schema })), { schema });
  assert.equal(r.code, 1);
  assert.match(r.text, /PROBE_FAILED:table:MissingTable/);
  assert.equal(r.spawned.length, 0);
});

test('G20M-10 a failed deploy is RESTORE_REQUIRED, never retried (one spawn); the post-failure look is read-only', async () => {
  const spawner = fakeSpawn({ code: 1 });
  const r = await run(EXECUTE(PLAN), { spawner, phases: [phase('EXACT_G16'), phase('EXACT_G17')] });
  assert.equal(r.code, 1);
  assert.match(r.text, /PILOT_G20_MIGRATE_RESULT=RESTORE_REQUIRED/);
  assert.match(r.text, /EXACT_G17 \(resumable only by a new approved plan\)/);
  assert.equal(r.spawned.length, 1, 'never retried');
  assert.doesNotMatch(r.text, /PILOT_G20_MIGRATE_RESULT=EXACT_G20/);
});

test('G20M-11 a post-check that is not exactly G20 (ledger or schema) is RESTORE_REQUIRED even when Prisma exited 0', async () => {
  for (const [label, post] of [['G17 ledger', phase('EXACT_G17')], ['G18 ledger', phase('EXACT_G18')], ['G19 ledger (the claim missing)', phase('EXACT_G19')], ['G20 ledger, wrong schema', phase('EXACT_G20', { raw: RAW.EXACT_G16 })]]) {
    const r = await run(EXECUTE(PLAN), { phases: [phase('EXACT_G16'), post] });
    assert.equal(r.code, 1, label);
    assert.match(r.text, /PILOT_G20_MIGRATE_RESULT=RESTORE_REQUIRED/, label);
    assert.doesNotMatch(r.text, /PILOT_G20_MIGRATE_RESULT=EXACT_G20/, label);
  }
});

test('G20M-12 the tool binds every module it imports, and never imports a LOCAL_TEST module', async () => {
  const bound = M.G20_MIGRATE_TOOLING_FILES.map((f) => f.path);
  for (const needed of ['pilot-g19-schema-references.mjs', 'pilot-g20-migrate.mjs', 'pilot-migrate.mjs', 'pilot-migration-generations.mjs', 'pilot-g16-schema-references.mjs', 'pilot-g20-schema-references.mjs', 'pilot-schema-references.mjs', 'app-schema-projection.mjs', 'pilot-marker.mjs', 'pilot-plan-binding.mjs', 'prisma/schema.prisma']) {
    assert.ok(bound.includes(needed), needed);
  }
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(path.join(MODULE_DIR, 'pilot-g20-migrate.mjs'), 'utf8');
  assert.doesNotMatch(source, /from '\.\/local-test/);
  // The tool's target is the literal EXACT_G20; a later generation never retargets it.
  assert.deepEqual(Object.keys(GENERATIONS), ['EXACT_G14', 'EXACT_G15', 'EXACT_G16', 'EXACT_G17', 'EXACT_G18', 'EXACT_G19', 'EXACT_G20']);
  assert.equal(M.FINAL_GENERATION, 'EXACT_G20');
  assert.deepEqual(M.INITIAL_GENERATIONS, ['EXACT_G16', 'EXACT_G17', 'EXACT_G18', 'EXACT_G19']);
  assert.deepEqual(M.G20_PAYLOAD.migrations.map((m) => m.name), GENERATIONS.EXACT_G20);
});

const AMBIENT = { DATABASE_URL: 'postgresql://postgres.hostileref00000000x:hostilepw@dev-hostile.invalid:5432/postgres', TEST_DATABASE_URL: 'postgresql://postgres.hostileref00000000x:hostilepw@dev-hostile.invalid:5432/postgres', PGHOST: 'dev-hostile.invalid' };

test('G20M-13 no mode flag never means execute; dry-run never writes; an ambient DATABASE_URL is never the identity', async () => {
  assert.equal(M.parseCliArgs(['--target=pilot', `--marker-id=${MARKER}`, '--expected-initial-state=EXACT_G16']).ok, false, 'no mode → refused, not defaulted');
  assert.equal(M.parseCliArgs(['--target=pilot', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`, '--expected-initial-state=EXACT_G16', `--plan=${PLAN}`]).ok, false, 'execute inputs without --execute are refused');
  const dry = await run(DRY(), { env: AMBIENT });
  assert.equal(dry.created.length, 0);
  assert.equal(dry.spawned.length, 0);
  const r = await run(EXECUTE(PLAN), { env: AMBIENT });
  assert.equal(r.code, 0, r.text);
  assert.ok(r.created.length >= 1);
  for (const conn of r.created) assert.equal(conn.host, HOST, 'every client targets the private-file URL only');
  assert.equal(r.spawned[0].options.env.DATABASE_URL, URL_TEXT, 'Prisma gets the held URL, not the ambient one');
  assert.ok(!r.text.includes('hostile'));
  const noFile = await run(EXECUTE(PLAN), { env: AMBIENT, urlText: '' });
  assert.equal(noFile.code, 1, 'an unusable private file never falls back to DATABASE_URL');
  assert.equal(noFile.created.length, 0);
});
