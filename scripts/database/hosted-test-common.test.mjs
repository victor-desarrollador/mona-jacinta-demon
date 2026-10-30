import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_ENV_NAMES,
  FORBIDDEN_ENV_PREFIXES,
  buildChildEnv,
  buildEvidence,
  buildStagedConfigText,
  checkEnvironment,
  confirmTarget,
  deployArgs,
  failureCode,
  makeRedactor,
  parseEvidence,
  parseStrictArgs,
  readMigrationTree,
  readRegularFile,
  readTarget,
  renderEvidence,
  resolvePrismaCli,
  runPrismaDeploy,
  sha256Hex,
  stageRun,
  verifyMigrationTree,
  withSnapshot,
  writeExclusive,
} from './hosted-test-common.mjs';

// Shared tooling of the hosted TEST upgrade / baseline tools. Nothing here connects to a database or runs Prisma: the filesystem tests use a
// private temporary directory, the process tests use a fake spawn.

const SELF = fileURLToPath(new URL('./hosted-test-common.mjs', import.meta.url));
const REF = 'abcdefghij0123456789';
const MARKER = '3b1c2d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const PASSWORD = 'S3cretPassw0rd';
const HOST = 'aws-0-sa-east-1.pooler.supabase.com';
const CONFIG = `TEST_DATABASE_URL=postgresql://postgres.${REF}:${PASSWORD}@${HOST}:5432/postgres\nTEST_DATABASE_MARKER_ID=${MARKER}\n`;
const bytes = (text) => new Uint8Array(Buffer.from(text, 'utf8'));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const tmp = () => nodeFs.mkdtempSync(path.join(os.tmpdir(), 'hosted-common-test-'));

// ---------------------------------------------------------------------------------------------------------------- environment
test('HC-01 a clean environment is accepted', () => {
  assert.deepEqual(checkEnvironment({ PATH: '/usr/bin', HOME: '/home/x', LANG: 'C' }), { ok: true });
});

test('HC-02 every variable that could name another database is refused, by name only', () => {
  const dirty = [
    'DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_DATABASE_MARKER_ID', 'MONA_TEST_DATABASE_TARGET',
    'MONA_D5H_PINNED_TEST_TARGET', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'PGOPTIONS', 'PGHOST', 'PGPASSWORD',
    'PRISMA_SCHEMA_ENGINE_BINARY', 'DOTENV_CONFIG_PATH', 'LOCAL_TEST_DATABASE_URL', 'LOCAL_TEST_DATABASE_MARKER_ID', 'PILOT_DATABASE_URL',
  ];
  assert.ok(FORBIDDEN_ENV_NAMES.length > 0 && FORBIDDEN_ENV_PREFIXES.length > 0);
  for (const name of dirty) {
    const verdict = checkEnvironment({ PATH: '/usr/bin', [name]: 'postgresql://u:SECRETVALUE@h/db' });
    assert.equal(verdict.ok, false, name);
    assert.equal(verdict.code, 'ENV_FORBIDDEN');
    assert.deepEqual(verdict.names, [name]);
    assert.doesNotMatch(JSON.stringify(verdict), /SECRETVALUE/);
  }
  assert.deepEqual(checkEnvironment({ DATABASE_URL: undefined, PATH: '/x' }), { ok: true }, 'an unset (undefined) key is not set');
});

// ---------------------------------------------------------------------------------------------------------------- arguments
const SPEC = { modes: ['check', 'dry-run', 'execute'], values: ['target', 'marker-id', 'plan'] };

test('HC-03 arguments: exactly one mode, every value at most once, nothing unknown, nothing positional, values never echoed', () => {
  assert.deepEqual(parseStrictArgs(['--execute', '--target=test', '--plan=abc'], SPEC), { ok: true, mode: 'execute', values: { target: 'test', plan: 'abc' } });
  const bad = [
    [[], 'MODE'], [['--check', '--execute'], 'MODE'], [['--check', '--check'], 'MODE'], [['--target=test'], 'MODE'],
    [['--check', 'positional'], 'POSITIONAL'], [['--check', '--nope=1'], 'UNKNOWN'], [['--check', '--target'], 'UNKNOWN'],
    [['--check', '--target=test', '--target=pilot'], 'DUPLICATE'],
  ];
  for (const [argv, reason] of bad) {
    const verdict = parseStrictArgs(argv, SPEC);
    assert.equal(verdict.ok, false, argv.join(' '));
    assert.equal(verdict.code, 'ARGS_INVALID');
    assert.equal(verdict.reason, reason, argv.join(' '));
  }
  assert.doesNotMatch(JSON.stringify(parseStrictArgs(['--check', '--nope=SECRETVALUE'], SPEC)), /SECRETVALUE/);
  assert.equal(parseStrictArgs('not-an-array', SPEC).ok, false);
});

// ---------------------------------------------------------------------------------------------------------------- target config
test('HC-04 the target comes only from the canonical TEST configuration', () => {
  const ok = readTarget(() => bytes(CONFIG));
  assert.equal(ok.ok, true);
  assert.equal(ok.held.projectRef, REF);
  assert.equal(ok.held.markerId, MARKER);
  assert.match(ok.evidence.targetDigest, /^[0-9a-f]{64}$/);
  assert.match(ok.evidence.markerDigest, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(ok.evidence), new RegExp(`${REF}|${PASSWORD}|${HOST}|${MARKER}`));

  assert.deepEqual(readTarget(() => { throw new Error('ENOENT secret-path'); }), { ok: false, code: 'CONFIG_UNREADABLE' });
  const bad = [
    ['not a pooler host', CONFIG.replace(HOST, 'db.example.com')],
    ['a DEV-looking direct host', CONFIG.replace(HOST, `db.${REF}.supabase.co`)],
    ['wrong port', CONFIG.replace(':5432/', ':6543/')],
    ['wrong database', CONFIG.replace('/postgres\n', '/other\n')],
    ['a user that is not postgres.<ref>', CONFIG.replace(`postgres.${REF}`, 'admin')],
    ['a query string', CONFIG.replace('/postgres\n', '/postgres?sslmode=disable\n')],
    ['no marker', CONFIG.split('\n')[0] + '\n'],
    ['a marker that is not v4', CONFIG.replace(MARKER, '3b1c2d4e-5f60-1a7b-8c9d-0e1f2a3b4c5d')],
    ['a duplicated key', CONFIG + `TEST_DATABASE_MARKER_ID=${MARKER}\n`],
    ['an export prefix', `export ${CONFIG}`],
  ];
  for (const [name, text] of bad) {
    const verdict = readTarget(() => bytes(text));
    assert.equal(verdict.ok, false, name);
    assert.equal(typeof verdict.code, 'string', name);
  }
});

test('HC-05 the operator must restate the marker and (to write) the project ref: neither is ever inferred', () => {
  const { held } = readTarget(() => bytes(CONFIG));
  assert.equal(confirmTarget(held, { markerId: MARKER }), null);
  assert.equal(confirmTarget(held, { markerId: MARKER, projectRef: REF }), null);
  assert.equal(confirmTarget(held, { markerId: '4b1c2d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d' }), 'MARKER_ARG_MISMATCH');
  assert.equal(confirmTarget(held, { markerId: undefined }), 'MARKER_ARG_MISMATCH');
  assert.equal(confirmTarget(held, { markerId: 'nope' }), 'MARKER_ARG_MISMATCH');
  assert.equal(confirmTarget(held, { markerId: MARKER, projectRef: 'zzzzzzzzzzzzzzzzzzzz' }), 'PROJECT_REF_MISMATCH');
  assert.equal(confirmTarget(held, { markerId: MARKER, projectRef: 'short' }), 'PROJECT_REF_MISMATCH');
  assert.equal(confirmTarget(held, { markerId: MARKER, projectRef: '' }), 'PROJECT_REF_MISMATCH');
});

// ---------------------------------------------------------------------------------------------------------------- safe output
test('HC-06 failure codes carry a SQLSTATE or an allow-listed Node code and nothing else', () => {
  assert.equal(failureCode(Object.assign(new Error(`boom ${PASSWORD}`), { code: '28P01' }), [PASSWORD]), '28P01');
  assert.equal(failureCode(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), []), 'ECONNREFUSED');
  assert.equal(failureCode(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), []), 'DEPTH_ZERO_SELF_SIGNED_CERT');
  assert.equal(failureCode(Object.assign(new Error('x'), { code: 'not a code with spaces' }), []), 'unexpected');
  assert.equal(failureCode(new Error('no code'), []), 'unexpected');
  assert.equal(failureCode(null, []), 'unexpected');
  assert.equal(failureCode(Object.assign(new Error('x'), { code: '28P01' }), ['prefix-28p01-suffix']), 'unexpected', 'a code that is part of a secret is not trusted');
  const hostile = new Proxy({}, { get() { throw new Error('trap'); } });
  assert.equal(failureCode(hostile, []), 'unexpected');
});

test('HC-07 the redactor removes every secret, plain and URL-encoded, and ignores trivially short ones', () => {
  const redact = makeRedactor([PASSWORD, 'p@ss word/1', HOST, '', 'ab']);
  const text = `error for ${PASSWORD} at ${HOST} with p%40ss%20word%2F1 and raw p@ss word/1 plus ab`;
  const out = redact(text);
  assert.doesNotMatch(out, new RegExp(`${PASSWORD}|${HOST}|p%40ss|p@ss word`));
  assert.match(out, /<redacted>/);
  assert.match(out, / ab$/, 'a 2-character "secret" would shred ordinary text, so it is not redacted');
  assert.equal(makeRedactor([])('plain'), 'plain');
});

test('HC-08 evidence documents are canonical, self-hashed and refuse tampering', () => {
  const ev = buildEvidence('mona-test-evidence/v1', { b: 2, a: { z: 1, y: [3, 2] } });
  assert.equal(ev.format, 'mona-test-evidence/v1');
  assert.match(ev.evidenceSha256, /^[0-9a-f]{64}$/);
  const text = renderEvidence(ev);
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(parseEvidence(text, 'mona-test-evidence/v1'), ev);
  assert.equal(renderEvidence(buildEvidence('mona-test-evidence/v1', { a: { y: [3, 2], z: 1 }, b: 2 })), text, 'key order never changes the bytes');
  assert.equal(parseEvidence(text, 'another-format/v1'), null);
  assert.equal(parseEvidence(text.replace('"b":2', '"b":3'), 'mona-test-evidence/v1'), null);
  assert.equal(parseEvidence(text.replace('\n', ' \n'), 'mona-test-evidence/v1'), null, 'not the canonical rendering');
  assert.equal(parseEvidence('{', 'mona-test-evidence/v1'), null);
  assert.equal(parseEvidence(text.replace(/"evidenceSha256":"[0-9a-f]+"/, '"evidenceSha256":"0"'), 'mona-test-evidence/v1'), null);
  assert.equal(sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
});

test('HC-09 evidence files are created exclusively (wx), 0600, and never overwritten', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'x.identity.json');
    assert.deepEqual(writeExclusive(nodeFs, file, 'one\n'), { ok: true });
    assert.equal(nodeFs.readFileSync(file, 'utf8'), 'one\n');
    assert.equal(nodeFs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(writeExclusive(nodeFs, file, 'two\n'), { ok: false, code: 'EVIDENCE_EXISTS' });
    assert.equal(nodeFs.readFileSync(file, 'utf8'), 'one\n');
    assert.deepEqual(writeExclusive(nodeFs, 'relative.json', 'x'), { ok: false, code: 'PATH_NOT_ABSOLUTE' });
    assert.deepEqual(writeExclusive(nodeFs, path.join(dir, 'no', 'such', 'dir.json'), 'x'), { ok: false, code: 'EVIDENCE_WRITE_FAILED' });
    const link = path.join(dir, 'link.json');
    nodeFs.symlinkSync(path.join(dir, 'elsewhere.json'), link);
    assert.equal(writeExclusive(nodeFs, link, 'x').ok, false, 'a symlink is never followed');
    assert.equal(nodeFs.existsSync(path.join(dir, 'elsewhere.json')), false);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HC-10 files are read only if they are regular files of a sane size, never through a symlink', () => {
  const dir = tmp();
  try {
    const file = path.join(dir, 'a.txt');
    nodeFs.writeFileSync(file, 'hello');
    assert.equal(readRegularFile(nodeFs, file, 100).toString(), 'hello');
    assert.equal(readRegularFile(nodeFs, file, 3), null, 'too large');
    assert.equal(readRegularFile(nodeFs, path.join(dir, 'missing'), 100), null);
    assert.equal(readRegularFile(nodeFs, dir, 100), null, 'a directory');
    nodeFs.symlinkSync(file, path.join(dir, 'l'));
    assert.equal(readRegularFile(nodeFs, path.join(dir, 'l'), 100), null, 'a symlink');
    assert.equal(readRegularFile(nodeFs, 'relative', 100), null);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------- migration tree
const NAMES = ['20260101000001_one', '20260101000002_two', '20260101000003_three'];
const SQLS = NAMES.map((n, i) => Buffer.from(`-- ${n}\nSELECT ${i};\n`));
const LOCK = Buffer.from('provider = "postgresql"\n');
const PINS = NAMES.map((name, i) => ({ name, bytes: SQLS[i].length, sha256: sha(SQLS[i]) }));
const LOCK_PIN = { bytes: LOCK.length, sha256: sha(LOCK), provider: 'postgresql' };
const memTree = (mutate = (t) => t) => mutate({ ok: true, entries: NAMES.map((name, i) => ({ name, sql: Buffer.from(SQLS[i]) })), lock: Buffer.from(LOCK) });

function writeTree(root, { extra = () => {} } = {}) {
  nodeFs.mkdirSync(root, { recursive: true });
  NAMES.forEach((n, i) => {
    nodeFs.mkdirSync(path.join(root, n));
    nodeFs.writeFileSync(path.join(root, n, 'migration.sql'), SQLS[i]);
  });
  nodeFs.writeFileSync(path.join(root, 'migration_lock.toml'), LOCK);
  extra(root);
}

test('HC-11a the migration tree is read exactly: only <timestamp>_<name>/migration.sql directories and the lock', () => {
  const dir = tmp();
  try {
    const root = path.join(dir, 'migrations');
    writeTree(root);
    const tree = readMigrationTree(root, nodeFs);
    assert.equal(tree.ok, true);
    assert.deepEqual(tree.entries.map((e) => e.name), NAMES);
    assert.equal(tree.lock.toString(), LOCK.toString());
    assert.deepEqual(verifyMigrationTree(tree, PINS, LOCK_PIN), { ok: true });

    const layouts = {
      'an extra file at the root': (r) => nodeFs.writeFileSync(path.join(r, 'README.md'), 'x'),
      'an extra file in a migration': (r) => nodeFs.writeFileSync(path.join(r, NAMES[0], 'extra.sql'), 'x'),
      'a directory with a bad name': (r) => nodeFs.mkdirSync(path.join(r, 'not_a_migration')),
      'a symlinked migration directory': (r) => nodeFs.symlinkSync(path.join(r, NAMES[1]), path.join(r, '20260101000009_linked')),
      'a symlinked migration.sql': (r) => { nodeFs.rmSync(path.join(r, NAMES[2], 'migration.sql')); nodeFs.symlinkSync(path.join(r, NAMES[0], 'migration.sql'), path.join(r, NAMES[2], 'migration.sql')); },
      'a missing lock': (r) => nodeFs.rmSync(path.join(r, 'migration_lock.toml')),
      'a missing migration.sql': (r) => nodeFs.rmSync(path.join(r, NAMES[1], 'migration.sql')),
    };
    for (const [name, mutate] of Object.entries(layouts)) {
      const bad = path.join(dir, `bad-${Object.keys(layouts).indexOf(name)}`);
      writeTree(bad, { extra: mutate });
      const verdict = readMigrationTree(bad, nodeFs);
      assert.equal(verdict.ok, false, name);
      assert.match(verdict.code, /^TREE_/);
    }
    assert.equal(readMigrationTree(path.join(dir, 'absent'), nodeFs).ok, false);
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HC-11b the tree must equal the pins: names, order, bytes, checksum and lock', () => {
  assert.deepEqual(verifyMigrationTree(memTree(), PINS, LOCK_PIN), { ok: true });
  const cases = {
    'a missing migration': [memTree((t) => ({ ...t, entries: t.entries.slice(0, 2) })), 'TREE_NAMES'],
    'an extra migration': [memTree((t) => ({ ...t, entries: [...t.entries, { name: '20260101000004_four', sql: Buffer.from('x') }] })), 'TREE_NAMES'],
    'a renamed migration': [memTree((t) => { t.entries[1].name = '20260101000002_renamed'; return t; }), 'TREE_NAMES'],
    'another order': [memTree((t) => ({ ...t, entries: [t.entries[1], t.entries[0], t.entries[2]] })), 'TREE_NAMES'],
    'one flipped byte': [memTree((t) => { t.entries[2].sql[3] ^= 0xff; return t; }), 'TREE_BYTES'],
    'a longer file': [memTree((t) => { t.entries[0].sql = Buffer.concat([t.entries[0].sql, Buffer.from('\n')]); return t; }), 'TREE_BYTES'],
    'an altered lock': [memTree((t) => ({ ...t, lock: Buffer.from('provider = "mysql"\n') })), 'TREE_LOCK'],
  };
  for (const [name, [tree, code]] of Object.entries(cases)) assert.deepEqual(verifyMigrationTree(tree, PINS, LOCK_PIN), { ok: false, code }, name);
  assert.equal(verifyMigrationTree({ ok: false, code: 'TREE_LAYOUT' }, PINS, LOCK_PIN).ok, false);
  assert.equal(verifyMigrationTree(memTree(), [], LOCK_PIN).ok, false, 'an empty pin list can never match');
});

// ---------------------------------------------------------------------------------------------------------------- prisma staging
test('HC-12 the staged config reproduces the repository config semantics, deterministically, without any URL', () => {
  const text = buildStagedConfigText('../../api/node_modules/prisma/config');
  assert.equal(text, buildStagedConfigText('../../api/node_modules/prisma/config'));
  assert.match(text, /env\('DATABASE_URL'\)/);
  assert.match(text, /sslmode', 'require'/);
  assert.match(text, /sslaccept', 'strict'/);
  assert.match(text, /sslcert/);
  assert.doesNotMatch(text, /postgres(ql)?:\/\//);
  for (const bad of ['', 'a"b', 'a\\b', 'a\nb', 'a\0b', null, 5]) assert.throws(() => buildStagedConfigText(bad));
});

test('HC-13 the child environment is an allow-list: nothing is inherited', () => {
  const env = buildChildEnv({ databaseUrl: 'postgresql://u:p@h:5432/d', home: '/stage/home', tmpdir: '/stage/tmp', execPath: '/opt/node/bin/node' });
  assert.deepEqual(Object.keys(env).sort(), ['CHECKPOINT_DISABLE', 'DATABASE_URL', 'HOME', 'NODE_ENV', 'PATH', 'PRISMA_HIDE_UPDATE_MESSAGE', 'TMPDIR']);
  assert.equal(env.DATABASE_URL, 'postgresql://u:p@h:5432/d');
  assert.equal(env.NODE_ENV, 'production');
  assert.match(env.PATH, /^\/opt\/node\/bin:/);
  assert.equal(Object.isFrozen(env), true);
});

test('HC-14a the deploy command is one literal argv: migrate deploy with an explicit config, never anything else', () => {
  assert.deepEqual(deployArgs('/p/cli.js', '/stage/prisma.config.ts'), ['/p/cli.js', 'migrate', 'deploy', '--config', '/stage/prisma.config.ts']);
  const source = nodeFs.readFileSync(SELF, 'utf8');
  for (const forbidden of ['migrate reset', "'reset'", "'dev'", 'db push', "'push'", "'resolve'", 'migrate resolve', "'diff'"]) {
    assert.ok(!source.includes(forbidden), `common must not contain ${forbidden}`);
  }
});

function fakeSpawn({ exit = 0, lines = [], error = null, hang = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = [];
    child.kill = (signal) => { child.killed.push(signal); if (hang) setImmediate(() => child.emit('close', null, signal)); return true; };
    calls.push({ command, args, options, child });
    setImmediate(() => {
      if (error) return child.emit('error', Object.assign(new Error('spawn failed'), { code: error }));
      for (const line of lines) child.stdout.emit('data', Buffer.from(`${line}\n`));
      if (!hang) child.emit('close', exit, null);
      return undefined;
    });
    return child;
  };
  return { spawn, calls };
}

test('HC-14b the deploy runs once with exactly the given argv/env/cwd, and its output is redacted line by line', async () => {
  const { spawn, calls } = fakeSpawn({ lines: [`applying ${PASSWORD}`, 'done'] });
  const seen = [];
  const result = await runPrismaDeploy({
    spawn, execPath: '/opt/node', script: '/p/cli.js', configPath: '/stage/prisma.config.ts', cwd: '/stage', env: { DATABASE_URL: 'x', PATH: '/bin' },
    timeoutMs: 1000, redact: makeRedactor([PASSWORD]), onLine: (line) => seen.push(line),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/opt/node');
  assert.deepEqual(calls[0].args, ['/p/cli.js', 'migrate', 'deploy', '--config', '/stage/prisma.config.ts']);
  assert.equal(calls[0].options.cwd, '/stage');
  assert.deepEqual(calls[0].options.env, { DATABASE_URL: 'x', PATH: '/bin' });
  assert.equal(calls[0].options.shell, undefined);
  assert.equal(calls[0].options.detached, true);
  assert.deepEqual(result, { code: 0, signal: null, timedOut: false, spawnError: null });
  assert.deepEqual(seen, ['applying <redacted>', 'done']);
});

test('HC-14c a failing, a missing and a hanging deploy are reported, never retried', async () => {
  const failing = fakeSpawn({ exit: 1, lines: ['P3009 failed'] });
  const r1 = await runPrismaDeploy({ spawn: failing.spawn, execPath: 'n', script: 's', configPath: 'c', cwd: '/', env: {}, timeoutMs: 1000, redact: (t) => t, onLine: () => {} });
  assert.equal(r1.code, 1);
  assert.equal(failing.calls.length, 1);

  const missing = fakeSpawn({ error: 'ENOENT' });
  const r2 = await runPrismaDeploy({ spawn: missing.spawn, execPath: 'n', script: 's', configPath: 'c', cwd: '/', env: {}, timeoutMs: 1000, redact: (t) => t, onLine: () => {} });
  assert.equal(r2.spawnError, 'ENOENT');
  assert.equal(r2.code, null);
  assert.equal(missing.calls.length, 1);

  const hanging = fakeSpawn({ hang: true });
  const killed = [];
  const r3 = await runPrismaDeploy({
    spawn: hanging.spawn, execPath: 'n', script: 's', configPath: 'c', cwd: '/', env: {}, timeoutMs: 20, redact: (t) => t, onLine: () => {},
    killGroup: (pid, signal) => killed.push([pid, signal]),
  });
  assert.equal(r3.timedOut, true);
  assert.deepEqual(killed[0], [4242, 'SIGKILL'], 'the whole process group is killed');
  assert.equal(hanging.calls.length, 1);
});

// What the approved plan binds for the staged config: the resolved config module, its bytes and the staged config text built on that module.
function stageExpect(api, schema, ca) {
  const cli = resolvePrismaCli(api, nodeFs);
  return { schemaSha256: sha(schema), caSha256: sha(ca), configModule: cli.configModule, configSha256: cli.configSha256, stagedConfigSha256: sha(buildStagedConfigText(cli.configModule)) };
}

function makeApi(root, { version = '7.10.0', pinned = '7.10.0', link = true } = {}) {
  const api = path.join(root, 'api');
  const pkg = path.join(api, 'node_modules', 'prisma');
  nodeFs.mkdirSync(path.join(pkg, 'build'), { recursive: true });
  nodeFs.mkdirSync(path.join(api, 'node_modules', '.bin'), { recursive: true });
  nodeFs.writeFileSync(path.join(pkg, 'build', 'index.js'), '// cli\n');
  nodeFs.writeFileSync(path.join(pkg, 'config.js'), '// config module\n');
  nodeFs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'prisma', version }));
  if (link) nodeFs.symlinkSync(path.join(pkg, 'build', 'index.js'), path.join(api, 'node_modules', '.bin', 'prisma'));
  nodeFs.writeFileSync(path.join(api, 'package.json'), JSON.stringify({ devDependencies: { prisma: pinned } }));
  nodeFs.writeFileSync(path.join(api, 'prisma.config.ts'), '// config\n');
  return api;
}

test('HC-15a the Prisma CLI must be the repository-local one, at the exact version pinned in api/package.json', () => {
  const dir = tmp();
  try {
    const api = makeApi(dir);
    const ok = resolvePrismaCli(api, nodeFs);
    assert.equal(ok.ok, true);
    assert.equal(ok.version, '7.10.0');
    assert.ok(ok.script.endsWith(path.join('prisma', 'build', 'index.js')));
    const other = makeApi(path.join(dir, 'b'), { version: '7.10.1' });
    assert.equal(resolvePrismaCli(other, nodeFs).ok, false, 'installed version differs from the pinned one');
    const unlinked = makeApi(path.join(dir, 'c'), { link: false });
    assert.equal(resolvePrismaCli(unlinked, nodeFs).ok, false, '.bin/prisma must resolve to the local package');
    const ranged = makeApi(path.join(dir, 'd'), { pinned: '^7.10.0' });
    assert.equal(resolvePrismaCli(ranged, nodeFs).ok, false, 'a range is not a pin');
    assert.equal(resolvePrismaCli(path.join(dir, 'nowhere'), nodeFs).ok, false);
    assert.equal(ok.configModule, nodeFs.realpathSync(path.join(api, 'node_modules', 'prisma', 'config.js')), 'the config module the staged config imports');
    assert.equal(ok.configSha256, sha('// config module\n'), 'its bytes are part of what the plan binds');
    const noModule = makeApi(path.join(dir, 'e'));
    nodeFs.rmSync(path.join(noModule, 'node_modules', 'prisma', 'config.js'));
    assert.equal(resolvePrismaCli(noModule, nodeFs).ok, false, 'no config module, no Prisma CLI');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HC-15b the private stage is an exact 0700 copy of the approved bytes, verified, and removed on cleanup', () => {
  const dir = tmp();
  try {
    const api = makeApi(dir);
    const tree = memTree();
    const schema = Buffer.from('// schema\n');
    const ca = Buffer.from('-----BEGIN CERTIFICATE-----\n');
    const stage = stageRun({ apiDir: api, tmpdir: dir, tree, schemaBytes: schema, caBytes: ca, prismaScript: path.join(api, 'node_modules', 'prisma', 'build', 'index.js'), expect: stageExpect(api, schema, ca) });
    assert.equal(stage.ok, true);
    assert.equal(nodeFs.statSync(stage.root).mode & 0o777, 0o700);
    assert.ok(stage.root.startsWith(dir) && !stage.root.startsWith(api), 'outside the repository tree');
    assert.equal(nodeFs.readFileSync(path.join(stage.root, 'prisma', 'migrations', NAMES[1], 'migration.sql')).toString(), SQLS[1].toString());
    assert.equal(nodeFs.readFileSync(path.join(stage.root, 'prisma', 'migrations', 'migration_lock.toml')).toString(), LOCK.toString());
    assert.equal(nodeFs.readFileSync(path.join(stage.root, 'prisma', 'schema.prisma')).toString(), schema.toString());
    assert.equal(nodeFs.readFileSync(stage.configPath, 'utf8'), buildStagedConfigText(stage.configImport));
    assert.equal(stage.verify().ok, true);
    nodeFs.appendFileSync(path.join(stage.root, 'prisma', 'migrations', NAMES[0], 'migration.sql'), '-- tampered\n');
    assert.deepEqual(stage.verify(), { ok: false, code: 'STAGE_DRIFT' }, 'tampering with the stage after it was verified is detected');
    stage.cleanup();
    assert.equal(nodeFs.existsSync(stage.root), false);
    stage.cleanup(); // idempotent
    const wrong = stageRun({ apiDir: api, tmpdir: dir, tree, schemaBytes: schema, caBytes: ca, prismaScript: path.join(api, 'node_modules', 'prisma', 'build', 'index.js'), expect: { ...stageExpect(api, schema, ca), schemaSha256: sha('other') } });
    assert.equal(wrong.ok, false, 'schema bytes that are not the approved ones are never staged');
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

test('HC-15c the stage is checked against what the plan approved: the staged config digest and the config module bytes', () => {
  const dir = tmp();
  try {
    const api = makeApi(dir);
    const tree = memTree();
    const schema = Buffer.from('// schema\n');
    const ca = Buffer.from('CA\n');
    const base = stageExpect(api, schema, ca);
    const run = (expect) => stageRun({ apiDir: api, tmpdir: dir, tree, schemaBytes: schema, caBytes: ca, expect });
    assert.equal(run({ ...base, stagedConfigSha256: sha('some other staged config') }).ok, false, 'a staged config the plan did not approve is never written');
    assert.equal(run({ ...base, configSha256: sha('other module bytes') }).ok, false, 'a config module that is not the approved one is never staged against');
    const stage = run(base);
    assert.equal(stage.ok, true);
    assert.equal(sha(nodeFs.readFileSync(stage.configPath)), base.stagedConfigSha256, 'the staged config is exactly the approved one');
    assert.equal(stage.verify().ok, true);
    nodeFs.appendFileSync(path.join(api, 'node_modules', 'prisma', 'config.js'), '// modified after the plan\n');
    assert.deepEqual(stage.verify(), { ok: false, code: 'STAGE_DRIFT' }, 'changing the config module after staging is detected');
    stage.cleanup();
  } finally {
    nodeFs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------------------- snapshot
function fakeClient({ failConnect = false, failRollback = false, failEnd = false, failQuery = null } = {}) {
  const log = [];
  return {
    log,
    client: {
      connect: async () => { log.push('connect'); if (failConnect) throw Object.assign(new Error('nope'), { code: 'ECONNREFUSED' }); },
      query: async (sql) => {
        log.push(sql);
        if (failQuery && sql.includes(failQuery)) throw Object.assign(new Error('bad'), { code: '42P01' });
        if (sql === 'ROLLBACK' && failRollback) throw new Error('rollback failed');
        return { rows: [] };
      },
      end: async () => { log.push('end'); if (failEnd) throw new Error('end failed'); },
    },
  };
}

test('HC-16 a snapshot is one read-only REPEATABLE READ transaction that is always rolled back and closed, and fails closed otherwise', async () => {
  const held = { password: PASSWORD, host: HOST, username: `postgres.${REF}`, projectRef: REF, markerId: MARKER };
  const ok = fakeClient();
  const r = await withSnapshot(() => ok.client, held, async (c) => { await c.query('SELECT 1'); return 'value'; });
  assert.deepEqual(r, { ok: true, value: 'value' });
  assert.deepEqual(ok.log, ['connect', 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SELECT 1', 'ROLLBACK', 'end']);

  const noConnect = fakeClient({ failConnect: true });
  assert.deepEqual(await withSnapshot(() => noConnect.client, held, async () => 'never'), { ok: false, phase: 'connect', code: 'ECONNREFUSED' });
  assert.ok(!noConnect.log.includes('ROLLBACK'));

  const boom = fakeClient({ failQuery: 'SELECT boom' });
  const failed = await withSnapshot(() => boom.client, held, async (c) => c.query('SELECT boom'));
  assert.deepEqual(failed, { ok: false, phase: 'snapshot', code: '42P01' });
  assert.deepEqual(boom.log.slice(-2), ['ROLLBACK', 'end'], 'rolled back and closed even though the work failed');

  const noRollback = fakeClient({ failRollback: true });
  assert.deepEqual(await withSnapshot(() => noRollback.client, held, async () => 'v'), { ok: false, phase: 'cleanup', code: 'ROLLBACK_UNCONFIRMED' });
  const noEnd = fakeClient({ failEnd: true });
  assert.deepEqual(await withSnapshot(() => noEnd.client, held, async () => 'v'), { ok: false, phase: 'cleanup', code: 'CLOSE_UNCONFIRMED' });
  assert.deepEqual(await withSnapshot(() => { throw new Error('cannot build'); }, held, async () => 'v'), { ok: false, phase: 'connect', code: 'unexpected' });
});

// ---------------------------------------------------------------------------------------------------------------- static
test('HC-17 the shared module can never reach PILOT or another database: static properties of its source', () => {
  const source = nodeFs.readFileSync(SELF, 'utf8');
  assert.doesNotMatch(source, /pilot-marker|pilot-backup|pilot-launch|pilot-migrate|pilot-g\d+-migrate|local-test-prepare|PILOT_DATABASE_URL|LOCAL_TEST_DATABASE_URL\s*[=:]/);
  assert.doesNotMatch(source, /process\.env/, 'the environment is always injected, never read implicitly');
  assert.doesNotMatch(source, /execSync|exec\(|\bshell:\s*true/);
  const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports.filter((i) => i.startsWith('./')).sort(), ['./d5h-preflight.mjs', './hosted-test-config.mjs', './lib.mjs', './test-marker.mjs']);
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});
