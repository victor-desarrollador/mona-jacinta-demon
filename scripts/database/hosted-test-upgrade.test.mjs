import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { projectionDigest } from './app-schema-projection.mjs';
import { buildBackupManifest, manifestPathFor } from './lib.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';
import { LOCK_PIN } from './pilot-migration-states.mjs';
import { SCHEMA_REFERENCES_G20 } from './pilot-g20-schema-references.mjs';
import { toConnectionString, parseHostedTestConfig } from './hosted-test-config.mjs';
import { deployArgs, parseEvidence } from './hosted-test-common.mjs';
import {
  EVIDENCE_FORMAT,
  IDENTITY_FORMAT,
  INITIAL_STATE,
  PLAN_FORMAT,
  RESULT_FORMAT,
  TARGET_STATE,
  TOOLING_FILES,
  buildDefaultDeps,
  buildPlan,
  classifyLedger,
  deriveAdvancedObjects,
  findAdvancedObjects,
  main,
  parseCliArgs,
  run,
} from './hosted-test-upgrade.mjs';

// hosted-test-upgrade: G6 -> G20 on the hosted TEST database. EVERY test here runs on injected doubles: no database, no Prisma, no network. The
// filesystem tests use a private temporary directory.

const SELF = fileURLToPath(new URL('./hosted-test-upgrade.mjs', import.meta.url));
const REF = 'abcdefghij0123456789';
const MARKER = '3b1c2d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const PASSWORD = 'S3cretPassw0rd';
const HOST = 'aws-0-sa-east-1.pooler.supabase.com';
const CONFIG = `TEST_DATABASE_URL=postgresql://postgres.${REF}:${PASSWORD}@${HOST}:5432/postgres\nTEST_DATABASE_MARKER_ID=${MARKER}\n`;
const bytes = (t) => new Uint8Array(Buffer.from(t, 'utf8'));
const sha = (d) => createHash('sha256').update(d).digest('hex');
const SETID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const DUMP_NAME = 'test_pre-migration_20261028T100000Z.dump';
const CANARIES = [PASSWORD, HOST, REF, MARKER, 'postgresql://'];

// ------------------------------------------------------------------------------------------------------------------ synthetic migrations
const NAMES = Array.from({ length: 20 }, (_, i) => `2026010100${String(i + 1).padStart(4, '0')}_m${i + 1}`);
const sqlOf = (i) => (i < 6
  ? `-- baseline ${i}\nCREATE TABLE "Base${i}" ("id" TEXT PRIMARY KEY);\n`
  : `-- pending ${i}
CREATE TYPE "Enum${i}" AS ENUM ('A', 'B');
CREATE TABLE "NewT${i}" ("id" TEXT PRIMARY KEY, CONSTRAINT "inline_chk_${i}" CHECK (true));
ALTER TABLE "Sale" ADD COLUMN "col${i}" TEXT;
ALTER TABLE "Sale" ADD CONSTRAINT "add_chk_${i}" CHECK (true);
ALTER TYPE "CashMovementType" ADD VALUE 'LBL${i}';
CREATE UNIQUE INDEX "idx_${i}" ON "NewT${i}"("id");
CREATE FUNCTION public."fn_${i}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER "trg_${i}" BEFORE INSERT ON "NewT${i}" FOR EACH ROW EXECUTE FUNCTION public."fn_${i}"();
`);
const SQLS = NAMES.map((_, i) => Buffer.from(sqlOf(i)));
const LOCK = Buffer.from('provider = "postgresql"\n');
const PINS = NAMES.map((name, i) => ({ name, bytes: SQLS[i].length, sha256: sha(SQLS[i]) }));
const LOCKPIN = { bytes: LOCK.length, sha256: sha(LOCK), provider: 'postgresql' };
const makeTree = (mutate = (t) => t) => mutate({ ok: true, entries: NAMES.map((name, i) => ({ name, sql: Buffer.from(SQLS[i]) })), lock: Buffer.from(LOCK) });

const G6_PROJECTION = Object.freeze({
  format: 'mona-app-schema-projection/v2',
  tables: [{ name: 'Sale', columns: [{ name: 'id' }] }, { name: 'Base0', columns: [{ name: 'id' }] }],
  enums: [{ name: 'CashMovementType', labels: ['OPENING', 'CLOSING'] }], types: [], constraints: [], indexes: [], functions: [], triggers: [],
});
const G20_PROJECTION = Object.freeze({
  format: 'mona-app-schema-projection/v2',
  tables: [{ name: 'Sale', columns: [{ name: 'id' }, { name: 'col7' }] }, { name: 'NewT7', columns: [{ name: 'id' }] }],
  enums: [{ name: 'CashMovementType', labels: ['OPENING', 'CLOSING', 'LBL7'] }], types: [],
  constraints: [{ table: 'NewT7', name: 'inline_chk_7', type: 'c', validated: true }], indexes: [{ table: 'NewT7', name: 'idx_7', valid: true }],
  functions: [{ name: 'fn_7', args: '' }], triggers: [{ table: 'NewT7', name: 'trg_7', enabled: 'O' }],
});
const REFERENCE = Object.freeze({ digest: projectionDigest(G20_PROJECTION), probes: [{ kind: 'table', name: 'NewT7' }] });

const ledgerRows = (count, { tweak = (rows) => rows } = {}) => tweak(PINS.slice(0, count).map((p) => ({ migration_name: p.name, checksum: p.sha256, finished: true, rolled_back: false })));

function tempDir() {
  return nodeFs.mkdtempSync(path.join(os.tmpdir(), 'hosted-upgrade-test-'));
}

// A whole fake world: the database, the clock, the filesystem artifacts and every side effect the tool could have.
function makeWorld(options = {}) {
  const dir = tempDir();
  const dump = path.join(dir, DUMP_NAME);
  nodeFs.writeFileSync(dump, 'dump');
  const world = {
    dir, dump, time: Date.parse('2026-10-28T09:55:00.000Z'), out: [], err: [], clients: 0, clientLogs: [], stages: 0, cleaned: 0, deploys: [], disposed: 0,
    backupUnchanged: true, stageOk: true, tree: () => makeTree(), configBytes: bytes(CONFIG), tooling: [{ file: 'a.mjs', sha256: sha('a') }],
    schema: Buffer.from('// schema\n'), ca: Buffer.from('CA\n'), prisma: { ok: true, cwd: '/repo/api', script: '/repo/api/node_modules/prisma/build/index.js', version: '7.10.0', scriptSha256: sha('cli'), configModule: '/repo/api/node_modules/prisma/config.js', configSha256: sha('config-a') },
    db: { markerOk: true, ledgerRows: ledgerRows(6), projection: G6_PROJECTION, serverVersionNum: 170006, guards: [], failConnect: null },
    deployBehavior: 'ok', ...options.world,
  };
  const deps = {
    env: { PATH: '/usr/bin', HOME: '/home/x' },
    readConfigBytes: () => { if (world.configBytes instanceof Error) throw world.configBytes; return world.configBytes; },
    pins: PINS, lockPin: LOCKPIN, apiDir: '/repo/api', tmpdir: dir, fs: nodeFs,
    readTree: () => world.tree(),
    supportFiles: () => ({ schemaBytes: world.schema, caBytes: world.ca }),
    resolvePrismaCli: () => world.prisma,
    toolingDigests: () => world.tooling,
    reference: REFERENCE,
    createClient: () => {
      world.clients += 1;
      const log = [];
      world.clientLogs.push(log);
      return {
        connect: async () => { log.push('connect'); if (world.db.failConnect) throw Object.assign(new Error(`cannot connect to ${HOST} as postgres.${REF} with ${PASSWORD}`), { code: world.db.failConnect }); },
        query: async (sql) => { log.push(sql); return { rows: [] }; },
        end: async () => { log.push('end'); },
      };
    },
    proveMarker: async () => (world.db.markerOk ? { ok: true } : { ok: false, reason: 'marker mismatch' }),
    readLedger: async () => (world.db.ledgerRows === null ? { ledger: 'ABSENT', rows: [] } : { ledger: 'PRESENT', rows: world.db.ledgerRows }),
    readProjection: async () => world.db.projection,
    readServerVersion: async () => world.db.serverVersionNum,
    readForeignGuards: async () => world.db.guards,
    verifyBackupPair: async (args) => {
      world.verifyArgs = args;
      if (world.verifyBackup) return world.verifyBackup(args);
      return { ok: true, setId: SETID, sha256: sha('dump'), counts: { User: 5 }, assertUnchanged: () => world.backupUnchanged, dispose: () => { world.disposed += 1; } };
    },
    now: () => new Date(world.time),
    stage: (opts) => {
      world.stages += 1;
      world.stageOpts = opts;
      if (world.stageFails) return { ok: false, code: 'STAGE_FAILED' };
      return { ok: true, root: '/stage', configPath: '/stage/prisma.config.ts', configImport: 'x', verify: () => (world.stageOk ? { ok: true } : { ok: false, code: 'STAGE_DRIFT' }), cleanup: () => { world.cleaned += 1; } };
    },
    runDeploy: async (opts) => {
      world.deploys.push(opts);
      opts.onLine?.(`applying with ${PASSWORD} on ${HOST}`);
      if (world.deployBehavior === 'ok') { world.db.ledgerRows = ledgerRows(20); world.db.projection = G20_PROJECTION; return { code: 0, signal: null, timedOut: false, spawnError: null }; }
      if (world.deployBehavior === 'fail') { world.db.ledgerRows = ledgerRows(9, { tweak: (r) => [...r, { migration_name: NAMES[9], checksum: PINS[9].sha256, finished: false, rolled_back: false }] }); return { code: 1, signal: null, timedOut: false, spawnError: null }; }
      if (world.deployBehavior === 'timeout') return { code: null, signal: 'SIGKILL', timedOut: true, spawnError: null };
      if (world.deployBehavior === 'nospawn') return { code: null, signal: null, timedOut: false, spawnError: 'ENOENT' };
      if (world.deployBehavior === 'short') { world.db.ledgerRows = ledgerRows(19); world.db.projection = G20_PROJECTION; return { code: 0, signal: null, timedOut: false, spawnError: null }; }
      if (world.deployBehavior === 'drift') { world.db.ledgerRows = ledgerRows(20); world.db.projection = G6_PROJECTION; return { code: 0, signal: null, timedOut: false, spawnError: null }; }
      if (world.deployBehavior === 'markerlost') { world.db.ledgerRows = ledgerRows(20); world.db.projection = G20_PROJECTION; world.db.markerOk = false; return { code: 0, signal: null, timedOut: false, spawnError: null }; }
      throw new Error('unknown behavior');
    },
    log: (line) => world.out.push(line),
    error: (line) => world.err.push(line),
    ...options.deps,
  };
  world.deps = deps;
  world.cleanup = () => nodeFs.rmSync(dir, { recursive: true, force: true });
  world.writeBackup = ({ purpose = 'pre-migration', createdAt = '2026-10-28T10:00:00.000Z', file = DUMP_NAME } = {}) => {
    nodeFs.writeFileSync(manifestPathFor(dump), buildBackupManifest({ setId: SETID, createdAt, purpose, file, bytes: 4, sha256: sha('dump'), counts: { User: 5 } }));
  };
  world.writeBackup();
  world.identityPath = path.join(dir, 'identity.json');
  world.last = () => JSON.parse(world.out.at(-1));
  return world;
}

async function withWorld(options, fn) {
  const world = makeWorld(options);
  try {
    return await fn(world);
  } finally {
    world.cleanup();
  }
}

const ARGS = {
  check: (w, extra = []) => ['--target=test', '--check', `--marker-id=${MARKER}`, `--expected-initial-state=${INITIAL_STATE}`, ...extra],
  dry: (w, extra = []) => ['--target=test', '--dry-run', `--marker-id=${MARKER}`, `--expected-initial-state=${INITIAL_STATE}`, `--backup-evidence=${w.dump}`, `--identity-evidence=${w.identityPath}`, ...extra],
  exec: (w, plan, extra = []) => ['--target=test', '--execute', `--marker-id=${MARKER}`, `--expected-initial-state=${INITIAL_STATE}`, `--backup-evidence=${w.dump}`, `--identity-evidence=${w.identityPath}`, `--confirm-project-ref=${REF}`, `--plan=${plan}`, ...extra],
};

// The operator's real sequence: check (identity evidence) -> backup -> dry-run (plan) -> execute.
async function checkThenPlan(w) {
  w.time = Date.parse('2026-10-28T09:55:00.000Z');
  assert.equal(await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps), 0);
  w.time = Date.parse('2026-10-28T11:00:00.000Z');
  assert.equal(await main(ARGS.dry(w), w.deps), 0);
  return w.last().planDigest;
}

const noSecrets = (world) => {
  const text = [...world.out, ...world.err].join('\n');
  for (const canary of CANARIES) assert.ok(!text.includes(canary), `output leaked ${canary}`);
};

// ------------------------------------------------------------------------------------------------------------------ arguments
test('HU-01a arguments: the three modes and their exact argument sets', () => {
  const w = { dump: '/b/test_pre-migration_20261028T100000Z.dump', identityPath: '/b/identity.json' };
  assert.equal(parseCliArgs(ARGS.check(w)).ok, true);
  assert.equal(parseCliArgs(ARGS.check(w, ['--evidence-out=/b/x.json'])).ok, true);
  assert.equal(parseCliArgs(ARGS.dry(w)).ok, true);
  const exec = parseCliArgs(ARGS.exec(w, 'a'.repeat(64)));
  assert.equal(exec.ok, true);
  assert.equal(exec.mode, 'execute');
  assert.deepEqual(Object.keys(exec.values).sort(), ['backup', 'confirm', 'identity', 'marker', 'plan', 'state', 'target']);
});

test('HU-01b arguments: only the literal target "test" and only EXACT_G6 are ever accepted', () => {
  const w = { dump: '/b/test_pre-migration_20261028T100000Z.dump', identityPath: '/b/identity.json' };
  for (const target of ['pilot', 'dev', 'demo', 'local', 'local-test', 'TEST', 'test ', 'prod', '']) {
    const argv = ARGS.check(w).map((a) => (a.startsWith('--target=') ? `--target=${target}` : a));
    assert.equal(parseCliArgs(argv).ok, false, `target=${target}`);
  }
  assert.equal(parseCliArgs(ARGS.check(w).filter((a) => !a.startsWith('--target='))).ok, false, 'the target is mandatory, never defaulted');
  for (const state of ['EXACT_G7', 'EXACT_G19', 'EXACT_G20', 'G6', 'exact_g6', '']) {
    const argv = ARGS.check(w).map((a) => (a.startsWith('--expected-initial-state=') ? `--expected-initial-state=${state}` : a));
    assert.equal(parseCliArgs(argv).ok, false, `state=${state}: no resume states exist`);
  }
  assert.equal(parseCliArgs(ARGS.check(w).filter((a) => !a.startsWith('--expected-initial-state='))).ok, false);
  assert.equal(parseCliArgs(ARGS.check(w).filter((a) => !a.startsWith('--marker-id='))).ok, false);
  assert.equal(parseCliArgs(ARGS.check(w).map((a) => (a.startsWith('--marker-id=') ? '--marker-id=not-a-uuid' : a))).ok, false);
});

test('HU-01c arguments: each mode refuses the arguments that belong to another mode', () => {
  const w = { dump: '/b/test_pre-migration_20261028T100000Z.dump', identityPath: '/b/identity.json' };
  const plan = 'a'.repeat(64);
  assert.equal(parseCliArgs([...ARGS.check(w), `--plan=${plan}`]).ok, false);
  assert.equal(parseCliArgs([...ARGS.check(w), `--backup-evidence=${w.dump}`]).ok, false);
  assert.equal(parseCliArgs([...ARGS.check(w), `--confirm-project-ref=${REF}`]).ok, false);
  assert.equal(parseCliArgs([...ARGS.dry(w), `--plan=${plan}`]).ok, false, 'a dry-run takes no plan: it makes it');
  assert.equal(parseCliArgs([...ARGS.dry(w), `--confirm-project-ref=${REF}`]).ok, false);
  assert.equal(parseCliArgs([...ARGS.dry(w), '--evidence-out=/b/x.json']).ok, false);
  assert.equal(parseCliArgs(ARGS.dry(w).filter((a) => !a.startsWith('--backup-evidence='))).ok, false);
  assert.equal(parseCliArgs(ARGS.dry(w).filter((a) => !a.startsWith('--identity-evidence='))).ok, false);
  assert.equal(parseCliArgs(ARGS.exec(w, plan).filter((a) => !a.startsWith('--confirm-project-ref='))).ok, false, 'execute needs the project ref');
  assert.equal(parseCliArgs(ARGS.exec(w, plan).filter((a) => !a.startsWith('--plan='))).ok, false, 'execute needs the plan');
  assert.equal(parseCliArgs(ARGS.exec(w, 'short')).ok, false);
  assert.equal(parseCliArgs(ARGS.exec(w, 'A'.repeat(64))).ok, false, 'uppercase is not the digest');
  assert.equal(parseCliArgs(ARGS.exec(w, plan).map((a) => (a.startsWith('--confirm-project-ref=') ? '--confirm-project-ref=short' : a))).ok, false);
  assert.equal(parseCliArgs(ARGS.dry({ dump: 'relative.dump', identityPath: '/b/i.json' })).ok, false, 'paths must be absolute');
  assert.equal(parseCliArgs([...ARGS.check(w), '--reset']).ok, false);
  assert.equal(parseCliArgs([...ARGS.check(w), '--check']).ok, false);
});

// ------------------------------------------------------------------------------------------------------------------ derived absence spec
test('HU-02 the objects the pending migrations create are derived from their (verified) SQL', () => {
  const spec = deriveAdvancedObjects(SQLS.slice(6).map((b) => b.toString()));
  assert.deepEqual([...spec.tables].sort(), Array.from({ length: 14 }, (_, k) => `NewT${k + 6}`).sort());
  assert.deepEqual([...spec.types].sort(), Array.from({ length: 14 }, (_, k) => `Enum${k + 6}`).sort());
  assert.ok(spec.columns.some(([t, c]) => t === 'Sale' && c === 'col7'));
  assert.ok(spec.enumLabels.some(([t, l]) => t === 'CashMovementType' && l === 'LBL7'));
  assert.ok(spec.indexes.has('idx_7') && spec.functions.has('fn_7') && spec.triggers.has('trg_7'));
  assert.ok(spec.constraints.has('add_chk_7') && spec.constraints.has('inline_chk_7'));
  assert.equal(spec.tables.has('Base0'), false, 'baseline objects are not "advanced"');
  const commented = deriveAdvancedObjects(['-- CREATE TABLE "Ghost" ("id" TEXT);\nSELECT 1;']);
  assert.equal(commented.tables.size, 0, 'comments are not SQL');
});

test('HU-03 advanced objects found in a projection are reported by kind and name; a G6 projection has none', () => {
  const spec = deriveAdvancedObjects(SQLS.slice(6).map((b) => b.toString()));
  assert.deepEqual(findAdvancedObjects(G6_PROJECTION, spec), []);
  const found = findAdvancedObjects(G20_PROJECTION, spec);
  for (const expected of ['table:NewT7', 'column:Sale.col7', 'enumLabel:CashMovementType.LBL7', 'constraint:inline_chk_7', 'index:idx_7', 'function:fn_7', 'trigger:trg_7']) {
    assert.ok(found.includes(expected), expected);
  }
  const typeOnly = { ...G6_PROJECTION, enums: [...G6_PROJECTION.enums, { name: 'Enum9', labels: ['A', 'B'] }] };
  assert.deepEqual(findAdvancedObjects(typeOnly, spec), ['enumType:Enum9']);
});

// ------------------------------------------------------------------------------------------------------------------ ledger
test('HU-04 the ledger is exactly G6, exactly G20, or something else: never in between', () => {
  const verdict = (rows) => classifyLedger(rows, PINS);
  assert.equal(verdict(ledgerRows(6)).state, 'EXACT_G6');
  assert.equal(verdict(ledgerRows(20)).state, 'EXACT_G20');
  assert.equal(verdict(ledgerRows(6)).unexpected, 0);
  const others = {
    'only five applied': ledgerRows(5),
    'seven applied (G7 already there)': ledgerRows(7),
    'nineteen applied': ledgerRows(19),
    'empty ledger': [],
    'an unfinished G4': ledgerRows(6, { tweak: (r) => r.map((x, i) => (i === 3 ? { ...x, finished: false } : x)) }),
    'a rolled-back G2': ledgerRows(6, { tweak: (r) => r.map((x, i) => (i === 1 ? { ...x, rolled_back: true } : x)) }),
    'an altered G3 checksum': ledgerRows(6, { tweak: (r) => r.map((x, i) => (i === 2 ? { ...x, checksum: 'f'.repeat(64) } : x)) }),
    'a duplicated G1': ledgerRows(6, { tweak: (r) => [...r, r[0]] }),
    'an unknown extra migration': ledgerRows(6, { tweak: (r) => [...r, { migration_name: '20269999999999_stranger', checksum: 'e'.repeat(64), finished: true, rolled_back: false }] }),
    'a gap (G7 without G6)': ledgerRows(7, { tweak: (r) => r.filter((x, i) => i !== 5) }),
    'a failed G7 attempt on top of G6': ledgerRows(6, { tweak: (r) => [...r, { migration_name: NAMES[6], checksum: PINS[6].sha256, finished: false, rolled_back: false }] }),
  };
  for (const [name, rows] of Object.entries(others)) assert.equal(verdict(rows).state, 'OTHER', name);
  assert.equal(classifyLedger(null, PINS).state, 'OTHER');
  assert.ok(Array.isArray(verdict(ledgerRows(7)).statuses));
});

// ------------------------------------------------------------------------------------------------------------------ plan
test('HU-05a the dry-run is DB-free and prepares nothing: no client, no stage, no deploy', async () => withWorld({}, async (w) => {
  const plan = await checkThenPlan(w);
  assert.match(plan, /^[0-9a-f]{64}$/);
  const dry = w.last();
  assert.equal(dry.format, RESULT_FORMAT);
  assert.equal(dry.mode, 'dry-run');
  assert.equal(dry.result, 'PASS');
  assert.equal(w.clients, 1, 'only the --check connected; the dry-run did not');
  assert.equal(w.stages, 0);
  assert.equal(w.deploys.length, 0);
  assert.equal(dry.plan.initialState, INITIAL_STATE);
  assert.equal(dry.plan.targetState, TARGET_STATE);
  assert.equal(dry.plan.format, PLAN_FORMAT);
  assert.equal(dry.plan.migrations, 20);
  noSecrets(w);
}));

test('HU-05b the plan digest is deterministic and changes with every input that matters', async () => {
  const digests = new Set();
  const planOf = async (options, mutate = () => {}) => withWorld(options, async (w) => {
    mutate(w);
    return checkThenPlan(w);
  });
  const base = await planOf({});
  assert.equal(await planOf({}), base, 'same inputs, same plan');
  digests.add(base);
  digests.add(await planOf({}, (w) => { w.tooling = [{ file: 'a.mjs', sha256: sha('another') }]; }));
  digests.add(await planOf({}, (w) => { w.schema = Buffer.from('// other schema\n'); }));
  digests.add(await planOf({}, (w) => { w.ca = Buffer.from('other CA\n'); }));
  digests.add(await planOf({}, (w) => { w.prisma = { ...w.prisma, version: '7.11.0' }; }));
  digests.add(await planOf({}, (w) => { w.prisma = { ...w.prisma, scriptSha256: sha('another cli') }; }));
  digests.add(await planOf({}, (w) => { w.configBytes = bytes(CONFIG.replace(REF, 'zzzzzzzzzzzzzzzzzzzz')); }));
  digests.add(await planOf({ deps: { reference: { ...REFERENCE, digest: 'c'.repeat(64) } } }));
  digests.add(await planOf({}, (w) => { w.verifyBackup = async () => ({ ok: true, setId: SETID, sha256: sha('another dump'), counts: {}, assertUnchanged: () => true, dispose() {} }); }));
  digests.add(await planOf({}, (w) => { w.prisma = { ...w.prisma, configSha256: sha('config-b') }; }));
  assert.equal(digests.size, 10, 'every one of the 10 different inputs yields a different plan (the config module bytes among them)');
});

test('HU-05d the plan binds the REAL staged config (built on the resolved config module) and the config module bytes', async () => {
  const { buildStagedConfigText } = await import('./hosted-test-common.mjs');
  await withWorld({}, async (w) => {
    const plan = await checkThenPlan(w);
    assert.match(plan, /^[0-9a-f]{64}$/);
    const doc = w.last().plan;
    assert.equal(doc.stagedConfigSha256, sha(buildStagedConfigText(w.prisma.configModule)), 'sha256 of the staged config text with the real module specifier');
    assert.notEqual(doc.stagedConfigSha256, sha(buildStagedConfigText('PRISMA_CONFIG_MODULE')), 'never the constant placeholder');
    assert.equal(doc.configSha256, w.prisma.configSha256);
  });
  // a different module location changes the staged config text, hence the plan
  const a = await withWorld({}, (w) => checkThenPlan(w));
  const b = await withWorld({}, (w) => { w.prisma = { ...w.prisma, configModule: '/elsewhere/api/node_modules/prisma/config.js' }; return checkThenPlan(w); });
  assert.notEqual(a, b);
});

test('HU-05e prisma/config.js drift between dry-run and execute: PLAN_MISMATCH, nothing staged, nothing deployed', async () => withWorld({}, async (w) => {
  const plan = await checkThenPlan(w);
  w.prisma = { ...w.prisma, configSha256: sha('config-b') };
  w.time = Date.parse('2026-10-28T11:05:00.000Z');
  assert.equal(await main(ARGS.exec(w, plan), w.deps), 1);
  assert.deepEqual([w.last().phase, w.last().code], ['plan', 'PLAN_MISMATCH']);
  assert.equal(w.stages + w.deploys.length, 0);
}));

test('HU-05f prisma/config.js changed after the plan was checked but before staging: PLAN_MISMATCH, nothing staged', async () => withWorld({}, async (w) => {
  const plan = await checkThenPlan(w);
  w.time = Date.parse('2026-10-28T11:05:00.000Z');
  const first = w.prisma;
  let calls = 0;
  w.deps.resolvePrismaCli = () => { calls += 1; return calls === 1 ? first : { ...first, configSha256: sha('config-b') }; };
  assert.equal(await main(ARGS.exec(w, plan), w.deps), 1);
  assert.deepEqual([w.last().phase, w.last().code], ['plan', 'PLAN_MISMATCH']);
  assert.equal(w.stages + w.deploys.length, 0);
}));

test('HU-05g the stage is built against the digests the plan approved', async () => withWorld({}, async (w) => {
  const { buildStagedConfigText } = await import('./hosted-test-common.mjs');
  const plan = await checkThenPlan(w);
  w.time = Date.parse('2026-10-28T11:05:00.000Z');
  assert.equal(await main(ARGS.exec(w, plan), w.deps), 0);
  const { expect } = w.stageOpts;
  assert.equal(expect.configModule, w.prisma.configModule);
  assert.equal(expect.configSha256, w.prisma.configSha256);
  assert.equal(expect.stagedConfigSha256, sha(buildStagedConfigText(w.prisma.configModule)));
}));

test('HU-05c buildPlan is pure and binds pins, lock, prisma, reference, tooling, target, marker, backup and identity evidence', () => {
  const inputs = {
    pins: PINS, lockPin: LOCKPIN, prisma: { version: '7.10.0', scriptSha256: sha('cli'), configSha256: sha('config-a') }, schemaSha256: sha('s'), caSha256: sha('c'), stagedConfigSha256: sha('cfg'),
    referenceDigest: 'r'.repeat(64), tooling: [{ file: 'a.mjs', sha256: sha('a') }], targetDigest: 't'.repeat(64), markerDigest: 'm'.repeat(64),
    backup: { file: DUMP_NAME, sha256: sha('dump'), setId: SETID, createdAt: '2026-10-28T10:00:00.000Z' }, identityEvidenceSha256: 'i'.repeat(64),
  };
  const a = buildPlan(inputs);
  assert.equal(a.digest, buildPlan(JSON.parse(JSON.stringify(inputs))).digest);
  assert.equal(a.document.format, PLAN_FORMAT);
  assert.doesNotMatch(JSON.stringify(a.document), new RegExp(`${REF}|${PASSWORD}|${HOST}|${MARKER}`));
  for (const [key, value] of [['identityEvidenceSha256', 'x'.repeat(64)], ['markerDigest', 'y'.repeat(64)], ['lockPin', { ...LOCKPIN, sha256: sha('l2') }], ['pins', PINS.slice(1)]]) {
    assert.notEqual(buildPlan({ ...inputs, [key]: value }).digest, a.digest, key);
  }
});

// ------------------------------------------------------------------------------------------------------------------ DEV / PILOT
test('HU-06a a contaminated environment is refused before any config, client or file is touched', async () => {
  for (const name of ['DATABASE_URL', 'PILOT_DATABASE_URL', 'LOCAL_TEST_DATABASE_URL', 'MONA_D5H_PINNED_TEST_TARGET', 'TEST_DATABASE_URL', 'PGHOST', 'PRISMA_SCHEMA_ENGINE_BINARY', 'NODE_OPTIONS']) {
    await withWorld({}, async (w) => {
      let read = false;
      w.deps.readConfigBytes = () => { read = true; return bytes(CONFIG); };
      w.deps.env = { PATH: '/usr/bin', [name]: 'postgresql://u:SECRETVALUE@h/d' };
      assert.equal(await main(ARGS.check(w), w.deps), 1, name);
      assert.deepEqual([w.last().phase, w.last().code], ['env', 'ENV_FORBIDDEN'], name);
      assert.deepEqual(w.last().names, [name]);
      assert.equal(read, false);
      assert.equal(w.clients, 0);
      assert.doesNotMatch([...w.out, ...w.err].join('\n'), /SECRETVALUE/);
    });
  }
});

test('HU-06b only the canonical hosted TEST configuration is accepted: nothing else can name the target', async () => {
  const cases = {
    'a direct (non pooler) host': CONFIG.replace(HOST, `db.${REF}.supabase.co`),
    'another host': CONFIG.replace(HOST, 'localhost'),
    'a user that is not postgres.<ref>': CONFIG.replace(`postgres.${REF}`, 'postgres'),
    'a query string': CONFIG.replace('/postgres\n', '/postgres?sslmode=disable\n'),
    'a marker that is not v4': CONFIG.replace(MARKER, MARKER.replace('-4a7b-', '-1a7b-')),
    'a duplicated URL key': CONFIG + CONFIG.split('\n')[0] + '\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    await withWorld({ world: { configBytes: bytes(text) } }, async (w) => {
      assert.equal(await main(ARGS.check(w), w.deps), 1, name);
      assert.equal(w.last().phase, 'config', name);
      assert.equal(w.clients, 0, name);
      noSecrets(w);
    });
  }
  await withWorld({ world: { configBytes: new Error(`ENOENT ${PASSWORD}`) } }, async (w) => {
    assert.equal(await main(ARGS.check(w), w.deps), 1);
    assert.deepEqual([w.last().phase, w.last().code], ['config', 'CONFIG_UNREADABLE']);
    noSecrets(w);
  });
});

test('HU-06c the foreign guard schemas of PILOT and LOCAL_TEST make the target unacceptable', async () => {
  for (const guard of ['mona_pilot_guard', 'mona_local_test_guard']) {
    await withWorld({ world: { db: { markerOk: true, ledgerRows: ledgerRows(6), projection: G6_PROJECTION, serverVersionNum: 170006, guards: [guard] } } }, async (w) => {
      assert.equal(await main(ARGS.check(w), w.deps), 1);
      assert.deepEqual([w.last().phase, w.last().code], ['precheck', 'FOREIGN_GUARD_PRESENT']);
    });
  }
});

test('HU-06d the --marker-id and --confirm-project-ref must restate the configured target; nothing is inferred', async () => {
  await withWorld({}, async (w) => {
    const other = '4b1c2d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
    assert.equal(await main(ARGS.check(w).map((a) => (a.startsWith('--marker-id=') ? `--marker-id=${other}` : a)), w.deps), 1);
    assert.deepEqual([w.last().phase, w.last().code], ['confirm', 'MARKER_ARG_MISMATCH']);
    assert.equal(w.clients, 0);
    const plan = await checkThenPlan(w);
    const wrongRef = ARGS.exec(w, plan).map((a) => (a.startsWith('--confirm-project-ref=') ? '--confirm-project-ref=zzzzzzzzzzzzzzzzzzzz' : a));
    assert.equal(await main(wrongRef, w.deps), 1);
    assert.deepEqual([w.last().phase, w.last().code], ['confirm', 'PROJECT_REF_MISMATCH']);
    assert.equal(w.stages + w.deploys.length, 0);
    noSecrets(w);
  });
});

test('HU-06e static: the source can never import or name PILOT, LOCAL_TEST or lifecycle tooling', () => {
  const source = nodeFs.readFileSync(SELF, 'utf8');
  assert.doesNotMatch(source, /pilot-marker|pilot-backup|pilot-launch|pilot-migrate|pilot-g\d+-migrate|pilot-plan-binding|local-test-prepare|PILOT_DATABASE_URL|openSeedDatabase|seedDemo|resetDemo/);
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]).filter((i) => i.startsWith('./')).sort();
  assert.deepEqual(imports, [
    './app-schema-projection.mjs', './d5h-preflight.mjs', './hosted-test-common.mjs', './hosted-test-config.mjs', './lib.mjs', './pilot-g20-schema-references.mjs',
    './pilot-migration-generations.mjs', './pilot-migration-states.mjs', './test-marker.mjs',
  ]);
  const databaseUrlMentions = [...source.matchAll(/DATABASE_URL/g)].length;
  assert.ok(databaseUrlMentions <= 3, 'DATABASE_URL appears only where the child environment key is built/documented');
  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /\b(TRUNCATE|INSERT\s+INTO|UPDATE\s+"|DELETE\s+FROM|DROP\s+(TABLE|SCHEMA)|CREATE\s+(TABLE|SCHEMA)\s+")/i, 'the tool contains no data/DDL SQL of its own');
  assert.doesNotMatch(source, /"Permission"|"RolePermission"|"Role"|"UserRoleScope"|"Location"|"Company"/, 'RBAC and fixture data are out of scope');
});

// ------------------------------------------------------------------------------------------------------------------ marker, state, version
test('HU-07 the marker is proven inside the snapshot: a wrong or failing proof stops everything', async () => {
  await withWorld({ world: { db: { markerOk: false, ledgerRows: ledgerRows(6), projection: G6_PROJECTION, serverVersionNum: 170006, guards: [] } } }, async (w) => {
    assert.equal(await main(ARGS.check(w), w.deps), 1);
    assert.deepEqual([w.last().phase, w.last().code], ['marker', 'MARKER_NOT_PROVEN']);
  });
  await withWorld({ deps: { proveMarker: async () => { throw Object.assign(new Error(`oops ${PASSWORD}`), { code: '42501' }); } } }, async (w) => {
    assert.equal(await main(ARGS.check(w), w.deps), 1);
    assert.equal(w.last().code, '42501');
    noSecrets(w);
  });
});

test('HU-08 --check is strictly read-only and its evidence sidecar is exclusive, 0600 and secret-free', async () => withWorld({}, async (w) => {
  assert.equal(await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps), 0);
  const result = w.last();
  assert.equal(result.mode, 'check');
  assert.equal(result.result, 'PASS');
  assert.equal(result.state, INITIAL_STATE);
  assert.equal(result.serverVersionNum, 170006);
  assert.equal(w.stages + w.deploys.length, 0);
  const sql = w.clientLogs.flat().filter((s) => s !== 'connect' && s !== 'end');
  assert.deepEqual(sql, ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'ROLLBACK']);
  assert.equal(nodeFs.statSync(w.identityPath).mode & 0o777, 0o600);
  const sidecar = parseEvidence(nodeFs.readFileSync(w.identityPath, 'utf8'), IDENTITY_FORMAT);
  assert.ok(sidecar, 'a canonical self-hashed document');
  assert.equal(sidecar.state, INITIAL_STATE);
  assert.equal(sidecar.marker, 'PASS');
  assert.equal(sidecar.observedAt, '2026-10-28T09:55:00.000Z');
  assert.match(sidecar.targetDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(sidecar), new RegExp(`${REF}|${PASSWORD}|${HOST}|${MARKER}|postgres`));
  // a second write to the same path is refused and changes nothing
  const before = nodeFs.readFileSync(w.identityPath, 'utf8');
  assert.equal(await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps), 1);
  assert.equal(w.last().code, 'EVIDENCE_EXISTS');
  assert.equal(nodeFs.readFileSync(w.identityPath, 'utf8'), before);
  noSecrets(w);
}));

test('HU-09 execute refuses any ledger that is not exactly G6, with nothing staged and nothing deployed', async () => {
  const bad = {
    'only five applied': ledgerRows(5),
    'G7 already applied': ledgerRows(7),
    'a failed G7 attempt': ledgerRows(6, { tweak: (r) => [...r, { migration_name: NAMES[6], checksum: PINS[6].sha256, finished: false, rolled_back: false }] }),
    'an altered G3 checksum': ledgerRows(6, { tweak: (r) => r.map((x, i) => (i === 2 ? { ...x, checksum: 'f'.repeat(64) } : x)) }),
    'a rolled-back G1': ledgerRows(6, { tweak: (r) => r.map((x, i) => (i === 0 ? { ...x, rolled_back: true } : x)) }),
    'an unknown extra row': ledgerRows(6, { tweak: (r) => [...r, { migration_name: '20269999999999_stranger', checksum: 'e'.repeat(64), finished: true, rolled_back: false }] }),
    'no ledger at all': null,
  };
  for (const [name, rows] of Object.entries(bad)) {
    await withWorld({}, async (w) => {
      const plan = await checkThenPlan(w);
      w.db.ledgerRows = rows;
      w.time = Date.parse('2026-10-28T11:01:00.000Z');
      assert.equal(await main(ARGS.exec(w, plan), w.deps), 1, name);
      assert.equal(w.last().phase, 'precheck', name);
      assert.match(w.last().code, /^(STATE_NOT_EXACT_G6|LEDGER_ABSENT)$/, name);
      assert.equal(w.stages + w.deploys.length, 0, name);
    });
  }
});

test('HU-10 objects "from the future" in the target abort the upgrade before it starts', async () => withWorld({}, async (w) => {
  const plan = await checkThenPlan(w);
  w.db.projection = { ...G6_PROJECTION, tables: [...G6_PROJECTION.tables, { name: 'SaleExchange', columns: [] }, { name: 'NewT9', columns: [] }] };
  assert.equal(await main(ARGS.exec(w, plan), w.deps), 1);
  assert.deepEqual([w.last().phase, w.last().code], ['precheck', 'ADVANCED_OBJECTS_PRESENT']);
  assert.ok(w.last().advanced.includes('table:NewT9'));
  assert.equal(w.stages + w.deploys.length, 0);
}));

test('HU-11 the server must be PostgreSQL 17: 17.6 (hosted TEST) passes, anything else stops', async () => {
  for (const [num, ok] of [[170006, true], [170011, true], [160009, false], [180000, false], [0, false], [Number.NaN, false]]) {
    await withWorld({ world: { db: { markerOk: true, ledgerRows: ledgerRows(6), projection: G6_PROJECTION, serverVersionNum: num, guards: [] } } }, async (w) => {
      assert.equal(await main(ARGS.check(w), w.deps), ok ? 0 : 1, String(num));
      if (!ok) assert.equal(w.last().code, 'SERVER_VERSION_UNSUPPORTED');
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------ tree
test('HU-12 the migration tree must be exactly the 20 pins and the lock: any drift aborts before any connection', async () => {
  const trees = {
    'a missing migration': (t) => ({ ...t, entries: t.entries.slice(0, 19) }),
    'an extra migration': (t) => ({ ...t, entries: [...t.entries, { name: '20260101009999_extra', sql: Buffer.from('SELECT 1;') }] }),
    'a flipped byte': (t) => { t.entries[12].sql[5] ^= 0xff; return t; },
    'an altered lock': (t) => ({ ...t, lock: Buffer.from('provider = "sqlite"\n') }),
    'a renamed migration': (t) => { t.entries[3].name = '20260101000004_renamed'; return t; },
    'an unreadable tree': () => ({ ok: false, code: 'TREE_LAYOUT' }),
  };
  for (const [name, mutate] of Object.entries(trees)) {
    await withWorld({}, async (w) => {
      w.tree = () => makeTree(mutate);
      assert.equal(await main(ARGS.check(w), w.deps), 1, name);
      assert.equal(w.last().phase, 'tree', name);
      assert.match(w.last().code, /^TREE_/, name);
      assert.equal(w.clients, 0, name);
    });
  }
  await withWorld({ deps: { pins: PINS.slice(0, 19) } }, async (w) => {
    assert.equal(await main(ARGS.check(w), w.deps), 1);
    assert.equal(w.last().phase, 'tree', 'the tool refuses to run with anything but 20 pins');
  });
});

test('HU-13 the tree is read again right before staging: a change after the plan aborts', async () => withWorld({}, async (w) => {
  const plan = await checkThenPlan(w);
  let reads = 0;
  w.tree = () => { reads += 1; return makeTree(reads >= 2 ? (t) => { t.entries[15].sql[0] ^= 0xff; return t; } : undefined); };
  assert.equal(await main(ARGS.exec(w, plan), w.deps), 1);
  assert.equal(w.last().phase, 'tree');
  assert.equal(w.stages + w.deploys.length, 0);
  assert.ok(reads >= 2);
}));

// ------------------------------------------------------------------------------------------------------------------ plan / confirmation
test('HU-14 the plan must be the one the dry-run printed: wrong, stale or missing plans never run anything', async () => withWorld({}, async (w) => {
  const plan = await checkThenPlan(w);
  for (const wrong of ['0'.repeat(64), plan.replace(/^./, plan[0] === 'a' ? 'b' : 'a')]) {
    assert.equal(await main(ARGS.exec(w, wrong), w.deps), 1);
    assert.deepEqual([w.last().phase, w.last().code], ['plan', 'PLAN_MISMATCH']);
  }
  w.tooling = [{ file: 'a.mjs', sha256: sha('edited after the dry-run') }];
  assert.equal(await main(ARGS.exec(w, plan), w.deps), 1);
  assert.equal(w.last().code, 'PLAN_MISMATCH', 'the tool bytes changed after the plan was made');
  assert.equal(w.stages + w.deploys.length, 0);
  noSecrets(w);
}));

// ------------------------------------------------------------------------------------------------------------------ backup + identity evidence
test('HU-15a the backup must be a verified pre-migration set, fresh and unchanged', async () => {
  await withWorld({}, async (w) => {
    nodeFs.rmSync(manifestPathFor(w.dump));
    assert.equal(await main(ARGS.dry(w), w.deps), 1, 'no manifest');
    assert.equal(w.last().phase, 'backup');
  });
  await withWorld({}, async (w) => {
    await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps);
    w.verifyBackup = async () => ({ ok: false, reason: 'dump does not match its manifest' });
    w.time = Date.parse('2026-10-28T11:00:00.000Z');
    assert.equal(await main(ARGS.dry(w), w.deps), 1, 'verifyBackupPair says no');
    assert.deepEqual([w.last().phase, w.last().code], ['backup', 'BACKUP_UNVERIFIABLE']);
  });
  for (const [purpose, code] of [['manual', 'BACKUP_PURPOSE'], ['drill', 'BACKUP_PURPOSE'], ['scheduled', 'BACKUP_PURPOSE']]) {
    await withWorld({}, async (w) => {
      const dump = path.join(w.dir, `test_${purpose}_20261028T100000Z.dump`);
      nodeFs.writeFileSync(dump, 'dump');
      nodeFs.writeFileSync(manifestPathFor(dump), buildBackupManifest({ setId: SETID, createdAt: '2026-10-28T10:00:00.000Z', purpose, file: path.basename(dump), bytes: 4, sha256: sha('dump'), counts: { User: 5 } }));
      w.dump = dump;
      await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps);
      w.time = Date.parse('2026-10-28T11:00:00.000Z');
      assert.equal(await main(ARGS.dry(w), w.deps), 1, purpose);
      assert.deepEqual([w.last().phase, w.last().code], ['backup', code], purpose);
    });
  }
  for (const [nowIso, label] of [['2026-10-28T16:00:01.000Z', 'older than 6 hours'], ['2026-10-28T09:00:00.000Z', 'created in the future']]) {
    await withWorld({}, async (w) => {
      await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps);
      w.time = Date.parse(nowIso);
      assert.equal(await main(ARGS.dry(w), w.deps), 1, label);
      assert.equal(w.last().phase, 'backup', label);
      assert.equal(w.last().code, 'BACKUP_STALE', label);
    });
  }
});

test('HU-15b the identity evidence must be this target, still G6, taken before the backup, fresh, and kept next to it', async () => {
  const mutateEvidence = (w, change) => {
    const doc = parseEvidence(nodeFs.readFileSync(w.identityPath, 'utf8'), IDENTITY_FORMAT);
    const { evidenceSha256, ...body } = doc;
    const next = change(body);
    return next;
  };
  const rewrite = async (w, build) => {
    const { buildEvidence, renderEvidence } = await import('./hosted-test-common.mjs');
    nodeFs.rmSync(w.identityPath);
    nodeFs.writeFileSync(w.identityPath, renderEvidence(buildEvidence(IDENTITY_FORMAT, build)), { mode: 0o600 });
  };
  const cases = {
    'another target': [(b) => { const { format, ...rest } = b; return { ...rest, targetDigest: 'f'.repeat(64) }; }, 'IDENTITY_EVIDENCE_TARGET'],
    'another marker': [(b) => { const { format, ...rest } = b; return { ...rest, markerDigest: 'f'.repeat(64) }; }, 'IDENTITY_EVIDENCE_TARGET'],
    'a state that is not G6': [(b) => { const { format, ...rest } = b; return { ...rest, state: 'EXACT_G20' }; }, 'IDENTITY_EVIDENCE_STATE'],
    'a marker that was not proven': [(b) => { const { format, ...rest } = b; return { ...rest, marker: 'FAIL' }; }, 'IDENTITY_EVIDENCE_STATE'],
    'observed AFTER the backup': [(b) => { const { format, ...rest } = b; return { ...rest, observedAt: '2026-10-28T10:30:00.000Z' }; }, 'IDENTITY_EVIDENCE_ORDER'],
    'older than 6 hours': [(b) => { const { format, ...rest } = b; return { ...rest, observedAt: '2026-10-28T03:00:00.000Z' }; }, 'IDENTITY_EVIDENCE_STALE'],
  };
  for (const [name, [change, code]] of Object.entries(cases)) {
    await withWorld({}, async (w) => {
      await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps);
      await rewrite(w, mutateEvidence(w, change));
      w.time = Date.parse('2026-10-28T11:00:00.000Z');
      assert.equal(await main(ARGS.dry(w), w.deps), 1, name);
      assert.deepEqual([w.last().phase, w.last().code], ['identity-evidence', code], name);
    });
  }
  await withWorld({}, async (w) => {
    await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps);
    nodeFs.writeFileSync(w.identityPath, nodeFs.readFileSync(w.identityPath, 'utf8').replace('"EXACT_G6"', '"EXACT_G7"'));
    w.time = Date.parse('2026-10-28T11:00:00.000Z');
    assert.equal(await main(ARGS.dry(w), w.deps), 1);
    assert.deepEqual([w.last().phase, w.last().code], ['identity-evidence', 'IDENTITY_EVIDENCE_INVALID'], 'a hand-edited document fails its own digest');
  });
  await withWorld({}, async (w) => {
    nodeFs.rmSync(w.identityPath, { force: true });
    w.time = Date.parse('2026-10-28T11:00:00.000Z');
    assert.equal(await main(ARGS.dry(w), w.deps), 1);
    assert.deepEqual([w.last().phase, w.last().code], ['identity-evidence', 'IDENTITY_EVIDENCE_INVALID'], 'missing evidence');
  });
  await withWorld({}, async (w) => {
    const elsewhere = tempDir();
    try {
      w.identityPath = path.join(elsewhere, 'identity.json');
      await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps);
      w.time = Date.parse('2026-10-28T11:00:00.000Z');
      assert.equal(await main(ARGS.dry(w), w.deps), 1);
      assert.deepEqual([w.last().phase, w.last().code], ['identity-evidence', 'IDENTITY_EVIDENCE_LOCATION'], 'the evidence must live in the backup directory');
    } finally {
      nodeFs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
});

test('HU-15c a backup that changed after it was verified aborts before the stage', async () => withWorld({}, async (w) => {
  const plan = await checkThenPlan(w);
  w.backupUnchanged = false;
  assert.equal(await main(ARGS.exec(w, plan), w.deps), 1);
  assert.deepEqual([w.last().phase, w.last().code], ['backup', 'BACKUP_CHANGED']);
  assert.equal(w.stages + w.deploys.length, 0);
  assert.ok(w.disposed >= 1, 'the verified snapshot is always released');
}));

// ------------------------------------------------------------------------------------------------------------------ execute
test('HU-16 the happy path: ONE stage, ONE deploy with the literal argv and an allow-listed env, then a G20 postcheck and a sealed evidence file', async () => withWorld({}, async (w) => {
  const plan = await checkThenPlan(w);
  w.time = Date.parse('2026-10-28T11:05:00.000Z');
  assert.equal(await main(ARGS.exec(w, plan), w.deps), 0);
  const result = w.last();
  assert.equal(result.result, 'PASS');
  assert.equal(result.mode, 'execute');
  assert.equal(result.planDigest, plan);
  assert.equal(result.finalState, TARGET_STATE);
  assert.equal(w.stages, 1);
  assert.equal(w.deploys.length, 1, 'exactly one prisma migrate deploy');
  assert.equal(w.cleaned, 1, 'the private stage is always removed');
  assert.ok(w.disposed >= 1);

  const deploy = w.deploys[0];
  assert.equal(deploy.configPath, '/stage/prisma.config.ts');
  assert.equal(deploy.script, w.prisma.script);
  assert.equal(deploy.cwd, '/stage');
  const held = parseHostedTestConfig(bytes(CONFIG)).held;
  assert.deepEqual(Object.keys(deploy.env).sort(), ['CHECKPOINT_DISABLE', 'DATABASE_URL', 'HOME', 'NODE_ENV', 'PATH', 'PRISMA_HIDE_UPDATE_MESSAGE', 'TMPDIR']);
  assert.equal(deploy.env.DATABASE_URL, toConnectionString(held));
  assert.deepEqual(deployArgs('S', 'C'), ['S', 'migrate', 'deploy', '--config', 'C']);
  assert.equal(typeof deploy.redact, 'function');

  // the postcheck is a NEW connection after the deploy: marker again, 20/20, digest and probes of G20
  assert.ok(w.clients >= 3, 'check + precheck + postcheck');
  const evidencePath = `${w.dump}.upgrade-evidence.json`;
  assert.equal(nodeFs.statSync(evidencePath).mode & 0o777, 0o600);
  const evidence = parseEvidence(nodeFs.readFileSync(evidencePath, 'utf8'), EVIDENCE_FORMAT);
  assert.ok(evidence);
  assert.equal(evidence.outcome, 'PASS');
  assert.equal(evidence.planDigest, plan);
  assert.equal(evidence.initialState, INITIAL_STATE);
  assert.equal(evidence.finalState, TARGET_STATE);
  assert.equal(evidence.backup.setId, SETID);
  assert.equal(evidence.postcheck.migrationsApplied, 20);
  assert.equal(evidence.postcheck.schemaDigest, REFERENCE.digest);
  assert.equal(evidence.postcheck.marker, 'PASS');
  assert.equal(evidence.serverVersionNum, 170006);
  assert.doesNotMatch(JSON.stringify(evidence), new RegExp(`${REF}|${PASSWORD}|${HOST}|${MARKER}|postgresql:`));
  noSecrets(w);
}));

test('HU-17 a second execute after G20 is refused with STATE_ALREADY_TARGET and does nothing', async () => withWorld({}, async (w) => {
  const plan = await checkThenPlan(w);
  w.time = Date.parse('2026-10-28T11:05:00.000Z');
  assert.equal(await main(ARGS.exec(w, plan), w.deps), 0);
  const stages = w.stages;
  const deploys = w.deploys.length;
  w.time = Date.parse('2026-10-28T11:10:00.000Z');
  assert.equal(await main(ARGS.exec(w, plan), w.deps), 1);
  assert.deepEqual([w.last().phase, w.last().code], ['precheck', 'STATE_ALREADY_TARGET']);
  assert.equal(w.stages, stages);
  assert.equal(w.deploys.length, deploys, 'no second deploy');
}));

test('HU-18 a failed deploy is reported, never retried or repaired: one snapshot afterwards, a FAIL evidence file, the stage removed', async () => {
  for (const behavior of ['fail', 'timeout', 'nospawn']) {
    await withWorld({ world: { deployBehavior: behavior } }, async (w) => {
      const plan = await checkThenPlan(w);
      w.time = Date.parse('2026-10-28T11:05:00.000Z');
      const clientsBefore = w.clients;
      assert.equal(await main(ARGS.exec(w, plan), w.deps), 1, behavior);
      assert.equal(w.last().phase, 'deploy', behavior);
      assert.equal(w.last().code, { fail: 'DEPLOY_FAILED', timeout: 'DEPLOY_TIMEOUT', nospawn: 'DEPLOY_SPAWN_FAILED' }[behavior]);
      assert.equal(w.deploys.length, 1, `${behavior}: no retry`);
      assert.equal(w.cleaned, 1, behavior);
      assert.ok(w.clients > clientsBefore, 'a read-only snapshot after the failure');
      assert.ok(w.last().afterFailure, 'the ledger status after the failure is reported');
      const evidence = parseEvidence(nodeFs.readFileSync(`${w.dump}.upgrade-evidence.json`, 'utf8'), EVIDENCE_FORMAT);
      assert.equal(evidence.outcome, 'FAIL');
      assert.equal(evidence.phase, 'deploy');
      noSecrets(w);
    });
  }
});

test('HU-19 the postcheck is strict: a short ledger, a different schema, failing probes or a lost marker is a FAIL', async () => {
  const cases = { short: 'POSTCHECK_LEDGER', drift: 'POSTCHECK_SCHEMA_DIGEST', markerlost: 'MARKER_NOT_PROVEN' };
  for (const [behavior, code] of Object.entries(cases)) {
    await withWorld({ world: { deployBehavior: behavior } }, async (w) => {
      const plan = await checkThenPlan(w);
      w.time = Date.parse('2026-10-28T11:05:00.000Z');
      assert.equal(await main(ARGS.exec(w, plan), w.deps), 1, behavior);
      assert.deepEqual([w.last().phase, w.last().code], ['postcheck', code], behavior);
      assert.equal(w.deploys.length, 1, 'never a second attempt');
      assert.equal(parseEvidence(nodeFs.readFileSync(`${w.dump}.upgrade-evidence.json`, 'utf8'), EVIDENCE_FORMAT).outcome, 'FAIL');
    });
  }
  await withWorld({ deps: { reference: { digest: projectionDigest(G20_PROJECTION), probes: [{ kind: 'table', name: 'NoSuchTable' }] } } }, async (w) => {
    const plan = await checkThenPlan(w);
    w.time = Date.parse('2026-10-28T11:05:00.000Z');
    assert.equal(await main(ARGS.exec(w, plan), w.deps), 1);
    assert.deepEqual([w.last().phase, w.last().code], ['postcheck', 'POSTCHECK_PROBES']);
  });
});

test('HU-20 a stage that cannot be built or that drifted never reaches Prisma', async () => {
  await withWorld({ world: { stageFails: true } }, async (w) => {
    const plan = await checkThenPlan(w);
    assert.equal(await main(ARGS.exec(w, plan), w.deps), 1);
    assert.deepEqual([w.last().phase, w.last().code], ['stage', 'STAGE_FAILED']);
    assert.equal(w.deploys.length, 0);
  });
  await withWorld({ world: { stageOk: false } }, async (w) => {
    const plan = await checkThenPlan(w);
    assert.equal(await main(ARGS.exec(w, plan), w.deps), 1);
    assert.deepEqual([w.last().phase, w.last().code], ['stage', 'STAGE_DRIFT']);
    assert.equal(w.deploys.length, 0);
    assert.equal(w.cleaned, 1);
  });
  await withWorld({ world: { prisma: { ok: false, code: 'PRISMA_CLI_UNAVAILABLE' } } }, async (w) => {
    assert.equal(await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps), 0, 'the read-only check does not need Prisma');
    w.time = Date.parse('2026-10-28T11:00:00.000Z');
    assert.equal(await main(ARGS.dry(w), w.deps), 1);
    assert.equal(w.last().code, 'PRISMA_CLI_UNAVAILABLE');
  });
});

// ------------------------------------------------------------------------------------------------------------------ no fallback, no leaks
test('HU-21 there is no fallback: a connection failure is a failure, with one attempt and a safe code', async () => withWorld({ world: { db: { markerOk: true, ledgerRows: ledgerRows(6), projection: G6_PROJECTION, serverVersionNum: 170006, guards: [], failConnect: 'ECONNREFUSED' } } }, async (w) => {
  assert.equal(await main(ARGS.check(w), w.deps), 1);
  assert.deepEqual([w.last().phase, w.last().code], ['connect', 'ECONNREFUSED']);
  assert.equal(w.clients, 1, 'one attempt against the one configured target');
  noSecrets(w);
}));

test('HU-22 across success and every failure the output never carries a URL, host, user, password, ref or marker', async () => {
  const scenarios = [{}, { deployBehavior: 'fail' }, { deployBehavior: 'timeout' }, { deployBehavior: 'short' }, { db: { markerOk: false, ledgerRows: ledgerRows(6), projection: G6_PROJECTION, serverVersionNum: 170006, guards: [] } }];
  for (const world of scenarios) {
    await withWorld({ world }, async (w) => {
      await main(ARGS.check(w, [`--evidence-out=${w.identityPath}`]), w.deps);
      w.time = Date.parse('2026-10-28T11:00:00.000Z');
      await main(ARGS.dry(w), w.deps);
      const plan = w.out.map((l) => JSON.parse(l)).find((r) => r.planDigest)?.planDigest ?? 'a'.repeat(64);
      await main(ARGS.exec(w, plan), w.deps);
      noSecrets(w);
      for (const file of nodeFs.readdirSync(w.dir)) {
        const text = nodeFs.readFileSync(path.join(w.dir, file), file.endsWith('.dump') ? 'latin1' : 'utf8');
        for (const canary of CANARIES) assert.ok(!text.includes(canary), `${file} leaked ${canary}`);
      }
    });
  }
});

test('HU-23 main: exit codes (0 pass, 1 refused/failed, 2 usage) and one JSON line per run', async () => withWorld({}, async (w) => {
  assert.equal(await main([], w.deps), 2);
  assert.equal(w.last().code, 'ARGS_INVALID');
  assert.equal(await main(['--target=pilot', '--check'], w.deps), 2);
  const before = w.out.length;
  assert.equal(await main(ARGS.check(w), w.deps), 0);
  assert.equal(w.out.length, before + 1);
  assert.doesNotThrow(() => JSON.parse(w.out.at(-1)));
  assert.equal(w.clients, 1);
}));

// ------------------------------------------------------------------------------------------------------------------ defaults and constants
test('HU-24 the production defaults are the pinned G20 generation and the pinned G20 schema reference', () => {
  const defaults = buildDefaultDeps();
  assert.deepEqual(defaults.pins.map((p) => p.name), pinsOf('EXACT_G20').map((p) => p.name));
  assert.equal(defaults.pins.length, 20);
  assert.deepEqual(defaults.lockPin, LOCK_PIN);
  assert.equal(defaults.reference.digest, SCHEMA_REFERENCES_G20.EXACT_G20.digest);
  assert.equal(SCHEMA_REFERENCES_G20.EXACT_G20.pending, undefined, 'a pending reference can never be a target');
  assert.ok(defaults.reference.probes.length > 0);
  assert.ok(TOOLING_FILES.includes('hosted-test-upgrade.mjs') && TOOLING_FILES.includes('hosted-test-common.mjs'));
  for (const file of TOOLING_FILES) assert.ok(nodeFs.existsSync(path.join(path.dirname(SELF), file)), `${file} exists`);
  assert.equal(INITIAL_STATE, 'EXACT_G6');
  assert.equal(TARGET_STATE, 'EXACT_G20');
  assert.equal(typeof defaults.createClient, 'function');
  assert.equal(defaults.env !== undefined, true);
});
