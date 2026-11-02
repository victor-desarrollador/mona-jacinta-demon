// Zero-database unit tests for pilot-g22-migrate.mjs: the OWNER-only guarded EXACT_G20 -> EXACT_G21 -> EXACT_G22 rollout (USER-MGMT).
// Run with: node --test scripts/database/pilot-g22-migrate.test.mjs
// Hermetic: synthetic *.invalid URLs, the in-memory scripted database of pilot-g22-fake-db.mjs, an injected identity proof, an injected fake spawn (no child process
// is ever started: it advances the fake database the way a Prisma deploy over the staged tree would) and throwaway fake `api/` trees holding the REAL reviewed bytes.
// The real private PILOT files are never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from './pilot-g22-migrate.mjs';
import { API_DIR, PRISMA_ARGS } from './pilot-migrate.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';
import { FINGERPRINT, FakeDb, MARKER, SCHEMA, baseData } from './pilot-g22-fake-db.mjs';

const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = 'pilotsynthref0000001';
const SECRET = 'G22ecretPw';
const USER = `postgres.${REF}`;
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://${USER}:${SECRET}@${HOST}:6543/postgres`;
const LEAKS = [SECRET, HOST, REF, USER, URL_TEXT, `${HOST}:6543`, os.homedir()];
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

const DRY = (state = 'EXACT_G20') => ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--expected-initial-state=${state}`];
const EXECUTE = (plan, state = 'EXACT_G20', ref = REF) => ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${ref}`, `--expected-initial-state=${state}`, `--plan=${plan}`];

const TMP = mkdtempSync(path.join(os.tmpdir(), 'pilot-g22-migrate-test-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
mkdirSync(path.join(TMP, 'scripts', 'certs'), { recursive: true });
writeFileSync(path.join(TMP, 'scripts', 'certs', 'supabase-prod-ca-2021.crt'), 'FAKE-PILOT-CA\n');
let fixtureCount = 0;
// A fake api/ with the repository-local prisma and a byte-exact copy of the REAL reviewed tree (22 migrations + the lock) unless told otherwise.
function fakeApi({ migrations = pinsOf('EXACT_G22').map((m) => m.name), schema = 'mock schema the tooling binding hashes\n' } = {}) {
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

// The fake Prisma: records the staged tree it was started over and advances the database to the generation that tree ends at (21 migrations -> EXACT_G21 ...).
function fakeSpawn({ db, code = () => 0, onStart } = {}) {
  const spawned = [];
  const spawn = (command, args, options) => {
    const migrations = readdirSync(path.join(options.cwd, 'prisma', 'migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
    const record = { command, args, options, migrations, cwd: options.cwd };
    spawned.push(record);
    const outcome = onStart?.(record, spawned.length);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.write(`Applying migration with ${URL_TEXT}\n`);
      child.stdout.end(); child.stderr.end();
      const exit = code(record, spawned.length);
      if (exit === 0 && outcome !== 'skip') db?.advance(migrations.length === 21 ? 'EXACT_G21' : 'EXACT_G22');
      setImmediate(() => child.emit('close', exit, null));
    });
    return child;
  };
  return { spawn, spawned };
}

async function run(argv, { db = new FakeDb(), spawner = fakeSpawn({ db }), api = fakeApi(), proof = 0, file = { ok: true, text: `${URL_TEXT}\n` }, overrides = {} } = {}) {
  const out = [];
  const err = [];
  let created = 0;
  const rc = await M.main(argv, {
    apiDir: api, moduleDir: MODULE_DIR, urlFile: '/synthetic/pilot-database-url', readUrlFile: () => file, env: {}, execPath: process.execPath, home: os.homedir(), tmpdir: TMP,
    schema: SCHEMA, fingerprint: FINGERPRINT, createClient: () => { created += 1; return db.client(); }, proveIdentity: async () => proof, spawn: spawner.spawn,
    log: (l) => out.push(String(l)), error: (l) => err.push(String(l)), ...overrides,
  });
  return { rc, db, spawner, api, lines: out, errors: err, text: [...out, ...err].join('\n'), created };
}
const digestOf = async (state = 'EXACT_G20', opts = {}) => /PLAN_DIGEST=([0-9a-f]{64})/.exec((await run(DRY(state), opts)).text)[1];

test('MG-01 args: dry-run xor execute, pilot, a v4 marker id; the initial state is EXACT_G20 or (resume) EXACT_G21 and nothing else; execute needs the project ref and the plan digest', async () => {
  assert.equal(M.parseCliArgs(DRY()).ok, true);
  assert.equal(M.parseCliArgs(DRY('EXACT_G21')).ok, true);
  assert.equal(M.parseCliArgs(EXECUTE('a'.repeat(64))).ok, true);
  for (const state of ['EXACT_G19', 'EXACT_G16', 'EXACT_G22', 'EXACT_G14', '', 'exact_g20', 'EXACT_G20,EXACT_G21']) assert.equal(M.parseCliArgs(DRY(state)).ok, false, state);
  assert.equal(M.parseCliArgs(['--target=pilot', '--dry-run', `--marker-id=${MARKER}`]).ok, false);
  for (const bad of [[], ['--target=pilot', `--marker-id=${MARKER}`, '--expected-initial-state=EXACT_G20'], [...DRY(), '--execute'], ['--target=dev', ...DRY().slice(1)], [...DRY(), `--confirm-project-ref=${REF}`], [...DRY(), `--plan=${'a'.repeat(64)}`],
    EXECUTE('short'), EXECUTE('a'.repeat(64), 'EXACT_G20', 'short'), ['--target=pilot', '--execute', `--marker-id=${MARKER}`, '--expected-initial-state=EXACT_G20', `--plan=${'a'.repeat(64)}`], [...DRY(), 'stray'], [...DRY(), '--x=1'],
    [...DRY(), '--expected-initial-state=EXACT_G20'], ['--target=pilot', '--dry-run', '--marker-id=nope', '--expected-initial-state=EXACT_G20']]) {
    assert.equal(M.parseCliArgs(bad).ok, false, JSON.stringify(bad));
    const r = await run(bad); assert.equal(r.rc, 1); assert.equal(r.created, 0); assert.equal(r.spawner.spawned.length, 0);
  }
});

test('MG-02 --dry-run opens no connection, spawns nothing, prints the 22 pinned migrations, the two steps, the witness and a deterministic PLAN_DIGEST; leaks no secret', async () => {
  const r = await run(DRY());
  assert.equal(r.rc, 0, r.text);
  assert.equal(r.created, 0); assert.equal(r.db.statements.length, 0); assert.equal(r.spawner.spawned.length, 0);
  assert.match(r.text, /DRY RUN — no database connection was opened/);
  assert.equal([...r.text.matchAll(/^\s+\d+\. \d{14}_\S+\s+sha256 [0-9a-f]{64}$/gm)].length, 22);
  assert.match(r.text, /STEP 1: EXACT_G21 — one `prisma migrate deploy` over a staged tree of 21 migrations/);
  assert.match(r.text, /STEP 2: EXACT_G22 — one `prisma migrate deploy` over a staged tree of 22 migrations/);
  assert.match(r.text, /\+ 20261101120000_user_credentials_epoch/); assert.match(r.text, /\+ 20261101130000_user_admin_lifecycle/);
  assert.match(r.text, /INITIAL_STATE=EXACT_G20/); assert.match(r.text, /FINAL_STATE=EXACT_G22/); assert.match(r.text, /EXACT_G20 backup/);
  assert.match(r.text, /never run: seed, reset, migrate dev, db push, migrate resolve, retries/);
  for (const leak of LEAKS) assert.ok(!r.text.includes(leak), leak);
  assert.equal(await digestOf(), await digestOf());
});

test('MG-03 the plan digest binds the initial state (G20 plan ≠ G21 resume plan), the steps (resume = one step, no G21), the target, the tooling and the payload', async () => {
  const d20 = await digestOf('EXACT_G20'); const d21 = await digestOf('EXACT_G21');
  assert.notEqual(d20, d21);
  const resume = await run(DRY('EXACT_G21'));
  assert.match(resume.text, /RESUME: migration 21 is NOT run again/); assert.doesNotMatch(resume.text, /STEP 1: EXACT_G21/); assert.match(resume.text, /STEP 1: EXACT_G22/);
  assert.deepEqual(M.stepsFrom('EXACT_G20'), ['EXACT_G21', 'EXACT_G22']); assert.deepEqual(M.stepsFrom('EXACT_G21'), ['EXACT_G22']);
  // another schema file → another tooling binding → another digest; another project → another target binding → another digest
  assert.notEqual(await digestOf('EXACT_G20', { api: fakeApi({ schema: 'a different schema\n' }) }), d20);
  const otherUrl = `postgresql://postgres.pilotothersynth00002:${SECRET}@${HOST}:6543/postgres`;
  assert.notEqual(await digestOf('EXACT_G20', { file: { ok: true, text: otherUrl } }), d20);
  // a pending reference makes the planner refuse (fail closed), nothing is printed
  const pending = { references: { ...SCHEMA.references, EXACT_G22: { digest: null, pending: true } }, probes: SCHEMA.probes };
  const r = await run(DRY(), { overrides: { schema: pending } });
  assert.equal(r.rc, 1); assert.match(r.text, /no generated app-schema reference/); assert.ok(!r.text.includes('PLAN_DIGEST'));
});

test('MG-04 the repository tree must be EXACTLY the reviewed 22 migrations + lock: a missing, extra, renamed or changed migration, or a symlink, is refused before anything starts', async () => {
  assert.equal(M.verifyG22Tree(fakeApi()).ok, true);
  const g20Only = fakeApi({ migrations: pinsOf('EXACT_G20').map((m) => m.name) });
  const missing = M.verifyG22Tree(g20Only); assert.equal(missing.ok, false); assert.match(missing.reason, /approved G22 migrations/);
  const changed = fakeApi(); appendFileSync(path.join(changed, 'prisma', 'migrations', pinsOf('EXACT_G22')[21].name, 'migration.sql'), '-- tampered\n');
  assert.equal(M.verifyG22Tree(changed).ok, false);
  const extra = fakeApi(); mkdirSync(path.join(extra, 'prisma', 'migrations', '20261201000000_extra')); writeFileSync(path.join(extra, 'prisma', 'migrations', '20261201000000_extra', 'migration.sql'), 'SELECT 1;\n');
  assert.equal(M.verifyG22Tree(extra).ok, false);
  for (const api of [g20Only, changed, extra]) {
    const r = await run(DRY(), { api }); assert.equal(r.rc, 1); assert.match(r.text, /phase=payload/); assert.equal(r.spawner.spawned.length, 0);
  }
});

test('MG-05 --execute from EXACT_G20: precheck, ONE prisma over a 21-migration stage, witness, re-check, ONE prisma over a 22-migration stage, post-check → EXACT_G22; stages removed; leaks nothing', async () => {
  const dry = await digestOf();
  const db = new FakeDb(); const spawner = fakeSpawn({ db });
  const r = await run(EXECUTE(dry), { db, spawner });
  assert.equal(r.rc, 0, r.text);
  assert.equal(r.lines.at(-1), 'PILOT_G22_MIGRATE_RESULT=EXACT_G22');
  assert.equal(spawner.spawned.length, 2);
  assert.deepEqual(spawner.spawned.map((s) => s.migrations.length), [21, 22]);
  assert.deepEqual(spawner.spawned[0].migrations, pinsOf('EXACT_G21').map((m) => m.name));
  assert.deepEqual(spawner.spawned[1].migrations, pinsOf('EXACT_G22').map((m) => m.name));
  for (const s of spawner.spawned) {
    assert.deepEqual(s.args.slice(1), PRISMA_ARGS); assert.equal(s.options.shell, false); assert.equal(s.options.env.NODE_ENV, 'production'); assert.equal(s.options.env.DATABASE_URL, URL_TEXT);
    assert.deepEqual(Object.keys(s.options.env).sort(), ['CHECKPOINT_DISABLE', 'DATABASE_URL', 'HOME', 'NODE_ENV', 'PATH', 'PRISMA_HIDE_UPDATE_MESSAGE', 'TMPDIR']);
    assert.equal(existsSync(s.cwd), false, 'the private stage is removed after the step');
  }
  assert.equal(db.generation, 'EXACT_G22'); assert.ok(db.readOnlyOnly, 'this tool issues reads only; the writes are the child\'s');
  assert.match(r.text, /precheck ok/); assert.match(r.text, /G21 ok — ledger EXACT_G21/); assert.match(r.text, /G22 ok — ledger EXACT_G22/); assert.match(r.text, /ROLLOUT_COUNTS=\{/);
  for (const leak of LEAKS) assert.ok(!r.text.replace(`Applying migration with «redacted»`, '').includes(leak), leak);
  assert.match(r.text, /prisma\| Applying migration with «redacted»/);
});

test('MG-06 resume: --expected-initial-state=EXACT_G21 over a G21 database runs ONE prisma over the 22-migration stage and never re-runs migration 21', async () => {
  const dry = await digestOf('EXACT_G21');
  const db = new FakeDb({ generation: 'EXACT_G21' }); const spawner = fakeSpawn({ db });
  const r = await run(EXECUTE(dry, 'EXACT_G21'), { db, spawner });
  assert.equal(r.rc, 0, r.text); assert.equal(r.lines.at(-1), 'PILOT_G22_MIGRATE_RESULT=EXACT_G22');
  assert.deepEqual(spawner.spawned.map((s) => s.migrations.length), [22]);
  // the NORMAL plan refuses a G21 database, the resume plan refuses a G20 database: neither starts prisma
  const g21 = new FakeDb({ generation: 'EXACT_G21' }); const s2 = fakeSpawn({ db: g21 });
  const normal = await run(EXECUTE(await digestOf()), { db: g21, spawner: s2 });
  assert.equal(normal.rc, 1); assert.equal(s2.spawned.length, 0);
  const g20 = new FakeDb(); const s3 = fakeSpawn({ db: g20 });
  const wrong = await run(EXECUTE(dry, 'EXACT_G21'), { db: g20, spawner: s3 });
  assert.equal(wrong.rc, 1); assert.equal(s3.spawned.length, 0); assert.match(wrong.text, /STATE_MISMATCH/);
});

test('MG-07 refusals before prisma: a wrong or missing plan digest, a wrong project ref, a failed identity proof, an unreadable URL file → nothing queried, nothing spawned', async () => {
  const dry = await digestOf();
  for (const [label, argv, opts, match] of [
    ['wrong plan', EXECUTE('0'.repeat(64)), {}, /PLAN_BINDING_MISMATCH/],
    ['plan of the resume used for the normal run', EXECUTE(await digestOf('EXACT_G21')), {}, /PLAN_BINDING_MISMATCH/],
    ['wrong ref', EXECUTE(dry, 'EXACT_G20', 'aaaaaaaaaaaaaaaaaaaa'), {}, /does not match the project/],
    ['identity', EXECUTE(dry), { proof: 1 }, /phase=identity/],
    ['no file', EXECUTE(dry), { file: { ok: false, reason: 'x' } }, /phase=config/],
  ]) {
    const db = new FakeDb(); const spawner = fakeSpawn({ db });
    const r = await run(argv, { db, spawner, ...opts });
    assert.equal(r.rc, 1, label); assert.match(r.text, match, label); assert.equal(spawner.spawned.length, 0, label); assert.equal(db.statements.length, 0, label);
  }
});

test('MG-08 the early refusals stop before prisma: e-mail collision, no operative OWNER, G19, G21 (normal run), G22, drift, half-applied → exit 1, nothing spawned', async () => {
  const dry = await digestOf();
  const g19 = new FakeDb(); g19.ledgerOverride = pinsOf('EXACT_G19').map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));
  const half = new FakeDb(); half.ledgerOverride = pinsOf('EXACT_G21').map((m, i) => ({ migration_name: m.name, checksum: m.sha256, finished: i !== 20, rolled_back: false }));
  for (const [label, db] of [['collision', new FakeDb({ data: { collisionGroups: 1 } })], ['no owner', new FakeDb({ data: { operativeOwners: 0 } })], ['G19', g19], ['G21', new FakeDb({ generation: 'EXACT_G21' })],
    ['G22', new FakeDb({ generation: 'EXACT_G22' })], ['half-applied', half]]) {
    const spawner = fakeSpawn({ db });
    const r = await run(EXECUTE(dry), { db, spawner });
    assert.equal(r.rc, 1, label); assert.equal(spawner.spawned.length, 0, label); assert.ok(!r.lines.includes('PILOT_G22_MIGRATE_RESULT=EXACT_G22'), label);
  }
});

test('MG-09 G22 fails after G21 with the ledger still EXACT_G21 → exit 1, RESUMABLE_G21, the message says a NEW dry run resumes it; the resume then completes', async () => {
  const dry = await digestOf();
  const db = new FakeDb(); const spawner = fakeSpawn({ db, code: (_r, n) => (n === 2 ? 1 : 0) });
  const r = await run(EXECUTE(dry), { db, spawner });
  assert.equal(r.rc, 1); assert.equal(r.lines.at(-1), 'PILOT_G22_MIGRATE_RESULT=RESUMABLE_G21');
  assert.match(r.text, /NEW --dry-run with --expected-initial-state=EXACT_G21/); assert.match(r.text, /prisma exited with code 1/);
  assert.equal(db.generation, 'EXACT_G21'); assert.equal(spawner.spawned.length, 2);
  const resumeDry = await digestOf('EXACT_G21', { db });
  const s2 = fakeSpawn({ db });
  const done = await run(EXECUTE(resumeDry, 'EXACT_G21'), { db, spawner: s2 });
  assert.equal(done.rc, 0, done.text); assert.deepEqual(s2.spawned.map((s) => s.migrations.length), [22]);
});

test('MG-10 G22 fails leaving a failed ledger row, or a step whose witness fails → RESTORE_REQUIRED (exit 1); no `migrate resolve`, no retry, no resume', async () => {
  const dry = await digestOf();
  const failedRow = [...pinsOf('EXACT_G21').map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false })),
    { migration_name: pinsOf('EXACT_G22')[21].name, checksum: pinsOf('EXACT_G22')[21].sha256, finished: false, rolled_back: false }];
  const db = new FakeDb(); const spawner = fakeSpawn({ db, code: (_r, n) => (n === 2 ? 1 : 0), onStart: (_r, n) => { if (n === 2) db.ledgerOverride = failedRow; } });
  const a = await run(EXECUTE(dry), { db, spawner });
  assert.equal(a.rc, 1); assert.equal(a.lines.at(-1), 'PILOT_G22_MIGRATE_RESULT=RESTORE_REQUIRED');
  assert.match(a.text, /Never run `prisma migrate resolve`/); assert.match(a.text, /verified EXACT_G20 backup/); assert.equal(spawner.spawned.length, 2);
  // the G21 witness fails (a count moved): migration 22 is never started
  const db2 = new FakeDb(); const sp2 = fakeSpawn({ db: db2, onStart: (_r, n) => { if (n === 1) db2.data.counts = { ...db2.data.counts, AuditLog: 900 }; } });
  const b = await run(EXECUTE(dry), { db: db2, spawner: sp2 });
  assert.equal(b.rc, 1); assert.equal(b.lines.at(-1), 'PILOT_G22_MIGRATE_RESULT=RESTORE_REQUIRED'); assert.equal(sp2.spawned.length, 1); assert.match(b.text, /count changed: AuditLog/);
});

test('MG-11 the repository tree is re-verified before EACH spawn: a migration changed between the steps stops the second one', async () => {
  const dry = await digestOf(); const api = fakeApi();
  const db = new FakeDb();
  const spawner = fakeSpawn({ db, onStart: (_r, n) => { if (n === 1) appendFileSync(path.join(api, 'prisma', 'migrations', pinsOf('EXACT_G22')[21].name, 'migration.sql'), '-- changed after the first step\n'); } });
  const r = await run(EXECUTE(dry), { db, spawner, api });
  assert.equal(r.rc, 1); assert.equal(spawner.spawned.length, 1); assert.equal(db.generation, 'EXACT_G21'); assert.ok(!r.lines.includes('PILOT_G22_MIGRATE_RESULT=EXACT_G22'));
  assert.equal(r.lines.at(-1), 'PILOT_G22_MIGRATE_RESULT=RESUMABLE_G21'); assert.match(r.text, /changed since the initial check/);
});

test('MG-12 a prisma that cannot start, or is killed by a signal, is a failed step (never a success); the tool never reports EXACT_G22 unless the post-check proves it', async () => {
  const dry = await digestOf();
  const db = new FakeDb(); const noop = fakeSpawn({ db, onStart: () => 'skip' }); // exits 0 but the database did not move: the witness refuses
  const a = await run(EXECUTE(dry), { db, spawner: noop });
  assert.equal(a.rc, 1); assert.ok(!a.lines.includes('PILOT_G22_MIGRATE_RESULT=EXACT_G22'));
  const throwing = await run(EXECUTE(dry), { overrides: { spawn: () => { throw new Error(`boom ${SECRET}`); } } });
  assert.equal(throwing.rc, 1); assert.ok(!throwing.text.includes(SECRET));
});

test('MG-13 module identity: the tool pins its target and imports the reviewed pieces (stage, tree) instead of re-implementing them', async () => {
  assert.equal(M.FINAL_GENERATION, 'EXACT_G22'); assert.deepEqual([...M.INITIAL_GENERATIONS], ['EXACT_G20', 'EXACT_G21']);
  assert.equal(M.G22_PAYLOAD.migrations.length, 22);
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(path.join(MODULE_DIR, 'pilot-g22-migrate.mjs'), 'utf8');
  assert.match(src, /import \{ stageG20Run, verifyG20Tree \} from '\.\/pilot-g20-migrate\.mjs'/);
  assert.doesNotMatch(src, /migrate resolve['"`]\s*\]|PRISMA_ARGS\s*=\s*Object\.freeze\(\[/);
  for (const f of ['pilot-g22-migrate.mjs', 'pilot-g22-rollout.mjs', 'pilot-g22-schema-references.mjs', 'pilot-g20-migrate.mjs']) assert.ok(M.G22_MIGRATE_TOOLING_FILES.some((t) => t.path === f || t.path.endsWith(f)), f);
  assert.ok(baseData());
});
