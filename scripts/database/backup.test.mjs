// Zero-database unit tests for the TEST-only path of scripts/database/backup.mjs
// and the TEST backup set contract in lib.mjs (manifest binding, archive checks,
// pinned snapshot verification). Run with: node --test scripts/database/backup.test.mjs
// Config is synthetic (*.invalid); pg_dump / pg_restore / row counts are injected
// fakes, and artifacts go to throwaway temp directories — never backups/database.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTestInvocation, main, parseTestBackupArgs } from './backup.mjs';
import { buildBackupManifest, checkArchiveToc, LIST_CONN, openVerifiedBackup, parseBackupManifest, tableRowCounts, withVerifiedClient } from './lib.mjs';

const REF = 'syntheticref0000000a';
const SECRET = 'S3cretPassw0rd';
const HOST = 'aws-0-synthetic.pooler.invalid';
const TEST_URL = `postgresql://postgres.${REF}:${SECRET}@${HOST}:5432/postgres`;
const DEV_URL = 'postgresql://postgres.devref00000000000000:DevPassw0rd@dev-host.pooler.invalid:5432/postgres';
const LEAKS = [SECRET, HOST, REF, `postgres.${REF}`, TEST_URL, 'DevPassw0rd', 'dev-host', 'devref', ':5432'];
const ARGS = ['--target=test', '--purpose=manual', `--confirm-project-ref=${REF}`];
const NAME = 'test_manual_20260925T120000Z.dump';
const SET_ID = '0b6f2c1e-8a4d-4e6f-9b2a-1c3d5e7f9a0b';
const COUNTS = { User: 1, Branch: 2 };
const TOC = [
  ';',
  '; Archive created at 2026-09-25 12:00:00 UTC',
  ';     dbname: postgres',
  '5; 2615 2200 SCHEMA - public postgres',
  '215; 1259 16391 TABLE public User postgres',
  '216; 1259 16392 TABLE public Branch postgres',
  '3401; 0 16391 TABLE DATA public User postgres',
  '3402; 0 16392 TABLE DATA public Branch postgres',
].join('\n');

// A synthetic "archive" is ARCHIVE:<toc>. The fake pg_restore --list accepts only
// that shape and prints the embedded TOC — anything else is rejected the way a
// real pg_restore rejects a non-archive. The fake never touches a database.
const archive = (toc = TOC) => `ARCHIVE:${toc}`;
async function fakeList(bin, args, conn) {
  assert.equal(bin, 'pg_restore');
  assert.equal(args[0], '--list');
  assert.deepEqual(conn, LIST_CONN);
  const content = readFileSync(args[1], 'utf8');
  if (!content.startsWith('ARCHIVE:')) throw new Error('pg_restore: error: input file does not appear to be a valid archive');
  return { stdout: content.slice('ARCHIVE:'.length) };
}

let dir;
let snapRoot;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'mona-backup-test-'));
  snapRoot = mkdtempSync(path.join(os.tmpdir(), 'mona-backup-snap-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(snapRoot, { recursive: true, force: true });
});

function envText(lines) {
  return lines.filter((l) => l !== null).join('\n');
}

function makeDeps(overrides = {}) {
  const calls = [];
  const out = [];
  return {
    calls,
    out,
    readEnvText: () => envText([`TEST_DATABASE_URL=${TEST_URL}`]),
    artifactDir: dir,
    tmpRoot: snapRoot,
    artifactName: () => NAME,
    randomUUID: () => SET_ID,
    now: () => new Date('2026-09-25T12:00:00Z'),
    runPgTool: async (bin, args, conn) => {
      calls.push({ bin, args, connKeys: Object.keys(conn), host: conn.host });
      if (bin === 'pg_dump') {
        writeFileSync(args[args.indexOf('--file') + 1], archive());
        return { stdout: '' };
      }
      return fakeList(bin, args, conn);
    },
    tableRowCounts: async () => ({ ...COUNTS }),
    proveIdentities: async () => { throw new Error('proveIdentities must never be called for --target=test'); },
    fs: {},
    log: (line) => out.push(line),
    error: (line) => out.push(line),
    ...overrides,
  };
}

const text = (deps) => deps.out.join('\n');
function assertNoLeak(value) {
  for (const leak of LEAKS) assert.ok(!value.includes(leak), `leaked ${JSON.stringify(leak)}`);
}
const finalFiles = () => readdirSync(dir).sort();
const snapshotsLeft = () => readdirSync(snapRoot);

// Writes a complete backup set by hand (the consumer must not trust its producer).
function writeSet(name, { dump = archive(), counts = COUNTS, purpose = 'manual', setId = SET_ID, manifestFile = name, mutate } = {}) {
  const p = path.join(dir, name);
  writeFileSync(p, dump);
  let manifest = buildBackupManifest({
    setId,
    createdAt: '2026-09-25T12:00:00.000Z',
    purpose,
    file: manifestFile,
    bytes: Buffer.byteLength(dump),
    sha256: createHash('sha256').update(dump).digest('hex'),
    counts,
  });
  if (mutate) manifest = mutate(manifest);
  writeFileSync(`${p}.manifest.json`, manifest); // string or raw Buffer
  return p;
}

async function open(p) {
  return openVerifiedBackup(p, { runPgTool: fakeList, tmpRoot: snapRoot });
}

// --- routing and argument parsing -----------------------------------------

test('routing: any --target=test* goes to the strict TEST path; demo stays legacy', () => {
  assert.equal(isTestInvocation(['--target=test']), true);
  assert.equal(isTestInvocation(['--target=demo', '--target=test']), true);
  assert.equal(isTestInvocation(['--target=testx']), true);
  assert.equal(isTestInvocation(['--target=demo', '--purpose=manual']), false);
  assert.equal(isTestInvocation([]), false);
});

test('parse: valid TEST invocation', () => {
  assert.deepEqual(parseTestBackupArgs(ARGS), { ok: true, purpose: 'manual', confirmProjectRef: REF });
  assert.deepEqual(parseTestBackupArgs(['--target=test', `--confirm-project-ref=${REF}`]), {
    ok: true, purpose: 'manual', confirmProjectRef: REF,
  });
});

test('parse: missing attestation, bad targets, duplicates, unknown and raw URL arguments fail without echo', () => {
  const bad = [
    ['--target=test', '--purpose=manual'],
    ['--target=testx', `--confirm-project-ref=${REF}`],
    ['--target=demo', '--target=test', `--confirm-project-ref=${REF}`],
    ['--target=test', '--target=test', `--confirm-project-ref=${REF}`],
    [...ARGS, '--schema=all'],
    [...ARGS, '--force'],
    [...ARGS, `--url=${TEST_URL}`],
    [...ARGS, TEST_URL],
    [...ARGS, '--purpose=manual'],
    ['--target=test', '--purpose=nightly', `--confirm-project-ref=${REF}`],
    ['--target=test', '--confirm-project-ref=SHORT'],
    ['--target=test', `--confirm-project-ref=${REF}`, `--confirm-project-ref=${REF}`],
  ];
  for (const argv of bad) {
    const parsed = parseTestBackupArgs(argv);
    assert.equal(parsed.ok, false, argv.join(' '));
    assertNoLeak(parsed.error);
  }
});


test('tableRowCounts safely quotes arbitrary public table identifiers', async () => {
  const cases = [
    ['User', '"User"'],
    ['product', '"product"'],
    ['a"b', '"a""b"'],
    ['x"; DROP TABLE y; --', '"x""; DROP TABLE y; --"'],
    ['public.User', '"public.User"'],
    ['has space', '"has space"'],
    ['semi;colon', '"semi;colon"'],
    ['ñandú', '"ñandú"'],
    ['__proto__', '"__proto__"'],
    ['constructor', '"constructor"'],
    ['a$b', '"a$b"'],
  ];

  const queries = [];
  const client = {
    async connect() {},
    async end() {},
    async query(sql) {
      queries.push(sql);
      return { rows: [{ n: 7 }] };
    },
  };

  const counts = await tableRowCounts(
    {},
    cases.map(([name]) => name),
    () => client,
  );

  assert.equal(Object.getPrototypeOf(counts), null);

  for (const [name] of cases) {
    assert.equal(Object.hasOwn(counts, name), true, name);
    assert.equal(counts[name], 7, name);
  }

  assert.deepEqual(
    queries,
    cases.map(
      ([, quoted]) =>
        `SELECT count(*)::int AS n FROM public.${quoted}`,
    ),
  );
});

test('tableRowCounts applies the same quoting to dynamically discovered tables', async () => {
  const queries = [];
  let call = 0;

  const client = {
    async connect() {},
    async end() {},
    async query(sql) {
      queries.push(sql);
      call += 1;

      if (call === 1) {
        return {
          rows: [
            { tablename: 'User' },
            { tablename: 'x"; DROP TABLE y; --' },
            { tablename: '__proto__' },
          ],
        };
      }

      return { rows: [{ n: call }] };
    },
  };

  const counts = await tableRowCounts({}, undefined, () => client);

  assert.equal(
    queries[0],
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  assert.equal(
    queries[1],
    'SELECT count(*)::int AS n FROM public."User"',
  );
  assert.equal(
    queries[2],
    'SELECT count(*)::int AS n FROM public."x""; DROP TABLE y; --"',
  );
  assert.equal(
    queries[3],
    'SELECT count(*)::int AS n FROM public."__proto__"',
  );

  assert.equal(Object.getPrototypeOf(counts), null);
  assert.equal(Object.hasOwn(counts, '__proto__'), true);
});

test('tableRowCounts fails closed on a non-string table name', async () => {
  let tableQueries = 0;

  const client = {
    async connect() {},
    async end() {},
    async query() {
      tableQueries += 1;
      return { rows: [{ n: 1 }] };
    },
  };

  await assert.rejects(
    tableRowCounts({}, [123], () => client),
    /table name must be a string/,
  );

  assert.equal(tableQueries, 0);
});

test('tableRowCounts accepts an explicit empty table list without querying tables', async () => {
  let queries = 0;

  const client = {
    async connect() {},
    async end() {},
    async query() {
      queries += 1;
      return { rows: [{ n: 1 }] };
    },
  };

  const counts = await tableRowCounts({}, [], () => client);

  assert.equal(queries, 0);
  assert.equal(Object.getPrototypeOf(counts), null);
  assert.deepEqual(Object.keys(counts), []);
});

// --- DEV-free ---------------------------------------------------------------

test('DEV-free: succeeds with DATABASE_URL absent, malformed or unreachable; never calls proveIdentities', async () => {
  for (const devLine of [null, 'DATABASE_URL=not a url', `DATABASE_URL=${DEV_URL}`]) {
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(path.join(os.tmpdir(), 'mona-backup-test-'));
    const deps = makeDeps({ readEnvText: () => envText([devLine, `TEST_DATABASE_URL=${TEST_URL}`]) });
    const code = await main(ARGS, deps);
    assert.equal(code, 0, text(deps));
    assert.ok(!text(deps).includes('DATABASE_URL'), 'output must not mention DATABASE_URL');
    assertNoLeak(text(deps));
  }
});

test('DEV-free: the pg tools only ever receive the TEST connection or the empty list connection', async () => {
  const seen = [];
  const deps = makeDeps();
  const inner = deps.runPgTool;
  deps.runPgTool = async (bin, args, conn) => { seen.push({ bin, host: conn.host }); return inner(bin, args, conn); };
  deps.tableRowCounts = async (conn) => { seen.push({ bin: 'counts', host: conn.host }); return { ...COUNTS }; };
  assert.equal(await main(ARGS, deps), 0, text(deps));
  assert.deepEqual(seen, [
    { bin: 'pg_dump', host: HOST },
    { bin: 'counts', host: HOST },
    { bin: 'pg_restore', host: '' },
  ]);
});

// --- configuration and attestation ----------------------------------------

test('config: absent or malformed TEST_DATABASE_URL fails before any tool or file', async () => {
  for (const line of [null, 'TEST_DATABASE_URL=', `TEST_DATABASE_URL=${TEST_URL}?sslmode=disable`, `TEST_DATABASE_URL="${TEST_URL}#x"`, `TEST_DATABASE_URL=postgresql://postgres.${REF}@${HOST}:5432/postgres`]) {
    const deps = makeDeps({ readEnvText: () => envText([`DATABASE_URL=${DEV_URL}`, line]) });
    assert.equal(await main(ARGS, deps), 1);
    assert.match(text(deps), /phase=config/);
    assert.equal(deps.calls.length, 0);
    assert.deepEqual(finalFiles(), []);
    assertNoLeak(text(deps));
  }
});

test('attestation: mismatched project ref fails before any tool, without printing the configured ref', async () => {
  const deps = makeDeps();
  const argv = ['--target=test', '--purpose=manual', '--confirm-project-ref=otherref000000000000'];
  assert.equal(await main(argv, deps), 1);
  assert.match(text(deps), /phase=target/);
  assert.equal(deps.calls.length, 0);
  assertNoLeak(text(deps));
});

test('args: missing attestation fails before reading configuration', async () => {
  let read = false;
  const deps = makeDeps({ readEnvText: () => { read = true; return ''; } });
  assert.equal(await main(['--target=test', '--purpose=manual'], deps), 1);
  assert.equal(read, false);
  assert.match(text(deps), /phase=args/);
});

// --- pg_dump contract -------------------------------------------------------

test('pg_dump: public schema only, no marker schema, no connection data in argv; list runs on a snapshot', async () => {
  const deps = makeDeps();
  assert.equal(await main(ARGS, deps), 0, text(deps));
  const dump = deps.calls.find((c) => c.bin === 'pg_dump');
  const tmp = path.join(dir, `${NAME}.tmp`);
  assert.deepEqual(dump.args, ['--format=custom', '--no-owner', '--no-acl', '--schema=public', '--file', tmp, 'postgres']);
  assert.ok(!dump.args.join(' ').includes('mona_test_guard'));
  assertNoLeak(dump.args.join(' '));
  const list = deps.calls.find((c) => c.bin === 'pg_restore');
  assert.equal(list.args[0], '--list');
  assert.ok(list.args[1].startsWith(snapRoot), 'pg_restore --list must read the private snapshot');
  assert.deepEqual(snapshotsLeft(), [], 'snapshot must be disposed');
});

// --- happy path and artifact contract --------------------------------------

test('success: produces exactly dump + manifest, bound to one run, accepted by the consumer verifier', async () => {
  const deps = makeDeps();
  assert.equal(await main(ARGS, deps), 0, text(deps));
  assert.deepEqual(finalFiles(), [NAME, `${NAME}.manifest.json`]);
  const manifest = parseBackupManifest(readFileSync(path.join(dir, `${NAME}.manifest.json`), 'utf8'), NAME);
  assert.ok(manifest);
  assert.equal(manifest.setId, SET_ID);
  assert.deepEqual(manifest.counts, COUNTS);
  assert.equal(manifest.dump.sha256, createHash('sha256').update(archive()).digest('hex'));
  const handle = await open(path.join(dir, NAME));
  assert.equal(handle.ok, true, handle.reason);
  assert.equal(handle.setId, SET_ID);
  handle.dispose();
  assert.match(text(deps), /environment: test/);
  assertNoLeak(text(deps));
});

test('success: two sequential backups produce two independent verified sets', async () => {
  let n = 0;
  const names = ['test_manual_20260925T120000Z.dump', 'test_manual_20260925T120001Z.dump'];
  const ids = [SET_ID, '1c7a3d2f-9b5e-4f70-8c3b-2d4e6f8a0b1c'];
  const deps = makeDeps({ artifactName: () => names[n], randomUUID: () => ids[n++] });
  assert.equal(await main(ARGS, deps), 0);
  assert.equal(await main(ARGS, deps), 0);
  for (const name of names) {
    const handle = await open(path.join(dir, name));
    assert.equal(handle.ok, true, handle.reason);
    handle.dispose();
  }
});

// --- producer failure paths: nothing may look like a verified backup ------

async function assertFailsClean(deps, phase) {
  const code = await main(ARGS, deps);
  assert.equal(code, 1, text(deps));
  assert.match(text(deps), new RegExp(`phase=${phase}`));
  assert.deepEqual(finalFiles(), [], `left behind: ${finalFiles().join(', ')}`);
  assert.deepEqual(snapshotsLeft(), [], 'snapshot left behind');
  assertNoLeak(text(deps));
}

function dumpWriting(content) {
  return async (bin, args, conn) => {
    if (bin === 'pg_dump') {
      if (content !== null) writeFileSync(args[args.indexOf('--file') + 1], content);
      return { stdout: '' };
    }
    return fakeList(bin, args, conn);
  };
}

test('producer: pg_dump non-zero exit with credential-bearing stderr', async () => {
  const deps = makeDeps({
    runPgTool: async (bin, args) => {
      writeFileSync(args[args.indexOf('--file') + 1], 'partial');
      throw new Error(`pg_dump exited with code 1: connection to ${HOST} as postgres.${REF} password ${SECRET} tenant ${REF} failed`);
    },
  });
  await assertFailsClean(deps, 'dump');
});

test('producer: pg_dump exit 0 but artifact missing or empty', async () => {
  for (const content of [null, '']) await assertFailsClean(makeDeps({ runPgTool: dumpWriting(content) }), 'verify');
});

test('producer: arbitrary bytes, archive without table data, marker schema, or table set mismatch are never finalized', async () => {
  const dumps = [
    'PGDMP arbitrary bytes',
    archive('215; 1259 16391 TABLE public User postgres'),
    archive(`${TOC}\n3403; 0 16393 TABLE DATA mona_test_guard database_identity postgres`),
    archive(TOC.split('\n').filter((l) => !l.includes('DATA public Branch')).join('\n')),
  ];
  for (const content of dumps) await assertFailsClean(makeDeps({ runPgTool: dumpWriting(content) }), 'verify');
});

test('producer: row-count manifest failure or empty manifest', async () => {
  await assertFailsClean(makeDeps({ tableRowCounts: async () => { throw new Error(`count failed on ${HOST} ${SECRET}`); } }), 'counts');
  await assertFailsClean(makeDeps({ tableRowCounts: async () => ({}) }), 'counts');
});

test('producer: checksum failure', async () => {
  await assertFailsClean(makeDeps({ sha256File: async () => { throw new Error(`EIO ${TEST_URL}`); } }), 'checksum');
});

test('producer: finalize link failure removes everything this run created', async () => {
  let links = 0;
  const deps = makeDeps({
    fs: {
      linkSync: (a, b) => {
        links += 1;
        if (links === 2) throw Object.assign(new Error(`EIO ${TEST_URL}`), { code: 'EIO' });
        return linkSync(a, b);
      },
    },
  });
  await assertFailsClean(deps, 'finalize');
});

test('producer: existing destination is never overwritten', async () => {
  const existing = path.join(dir, NAME);
  writeFileSync(existing, 'PRE-EXISTING');
  const deps = makeDeps();
  assert.equal(await main(ARGS, deps), 1);
  assert.match(text(deps), /phase=finalize/);
  assert.equal(readFileSync(existing, 'utf8'), 'PRE-EXISTING');
  assert.deepEqual(finalFiles(), [NAME]);
  assert.equal(deps.calls.length, 0, 'must refuse before dumping');
});

test('producer: cleanup errors after a primary failure do not mask it or crash', async () => {
  const deps = makeDeps({
    tableRowCounts: async () => { throw new Error('counts failed'); },
    fs: { unlinkSync: () => { throw Object.assign(new Error(`EPERM ${TEST_URL}`), { code: 'EPERM' }); } },
  });
  assert.equal(await main(ARGS, deps), 1);
  assert.match(text(deps), /phase=counts/);
  assertNoLeak(text(deps));
});

// --- consumer verifier: B1 / M1 --------------------------------------------

test('consumer: a hand-written complete set verifies and snapshots exactly the manifest bytes', async () => {
  const handle = await open(writeSet(NAME));
  assert.equal(handle.ok, true, handle.reason);
  assert.equal(readFileSync(handle.snapshotPath, 'utf8'), archive());
  assert.deepEqual(handle.counts, COUNTS);
  handle.dispose();
  assert.equal(existsSync(handle.snapshotPath), false);
  assert.deepEqual(snapshotsLeft(), []);
});

test('consumer B1: valid digest and manifest over non-archive, truncated, table-less or marker-bearing dumps are rejected', async () => {
  const dumps = [
    'PGDMP arbitrary bytes',
    archive().slice(0, 5),
    archive('215; 1259 16391 TABLE public User postgres'),
    archive(`${TOC}\n5; 2615 16390 SCHEMA - mona_test_guard postgres`),
    archive(`${TOC}\n3403; 0 16393 TABLE DATA audit User postgres`),
    archive(`${TOC}\n3403; 0 16393 TABLE DATA public Extra postgres`),
  ];
  for (const [i, dump] of dumps.entries()) {
    const handle = await open(writeSet(`test_manual_20260925T12000${i}Z.dump`, { dump }));
    assert.equal(handle.ok, false, dump);
    assert.deepEqual(snapshotsLeft(), [], 'rejected verification must not leave a snapshot');
  }
});

test('consumer M1: dump from one run with the manifest of another is rejected', async () => {
  const a = writeSet('test_manual_20260925T120000Z.dump', { dump: archive() });
  const b = writeSet('test_manual_20260925T120001Z.dump', { dump: archive(`${TOC}\n`), setId: '1c7a3d2f-9b5e-4f70-8c3b-2d4e6f8a0b1c' });
  writeFileSync(`${a}.manifest.json`, readFileSync(`${b}.manifest.json`));
  assert.equal((await open(a)).ok, false);
  // Same-bytes dump but manifest names another file (renamed artifact).
  const c = writeSet('test_manual_20260925T120002Z.dump', { manifestFile: 'test_manual_20260925T120003Z.dump' });
  assert.equal((await open(c)).ok, false);
});

test('consumer M1: edited counts, missing/extra keys, wrong format/environment/setId/purpose are rejected', async () => {
  const mutations = [
    (m) => m.replace('"User": 1', '"User": 999'),
    (m) => { const o = JSON.parse(m); delete o.setId; return JSON.stringify(o); },
    (m) => { const o = JSON.parse(m); o.extra = 1; return JSON.stringify(o); },
    (m) => m.replace('mona-test-backup/v1', 'mona-test-backup/v2'),
    (m) => m.replace('"environment": "test"', '"environment": "demo"'),
    () => 'not json',
  ];
  for (const [i, mutate] of mutations.entries()) {
    assert.equal((await open(writeSet(`test_manual_20260925T12001${i}Z.dump`, { mutate }))).ok, false, String(i));
  }
  assert.equal((await open(writeSet('test_manual_20260925T120020Z.dump', { setId: 'not-a-uuid' }))).ok, false);
  assert.equal((await open(writeSet('test_manual_20260925T120021Z.dump', { purpose: 'drill' }))).ok, false);
  assert.equal((await open(writeSet('test_manual_20260925T120022Z.dump', { counts: { 'x"; DROP TABLE y; --': 1 } }))).ok, false);
  assert.equal((await open(writeSet('test_manual_20260925T120023Z.dump', { counts: {} }))).ok, false);
  assert.equal((await open(writeSet('demo_manual_20260925T120024Z.dump'))).ok, false);
});

test('consumer: missing manifest, legacy sidecars only, or symlinked dump/manifest are rejected', async () => {
  const p = writeSet(NAME);
  unlinkSync(`${p}.manifest.json`);
  writeFileSync(`${p}.sha256`, `${createHash('sha256').update(archive()).digest('hex')}  ${NAME}\n`);
  writeFileSync(`${p}.counts.json`, JSON.stringify(COUNTS));
  assert.equal((await open(p)).ok, false);

  const real = writeSet('test_manual_20260925T120030Z.dump');
  const link = path.join(dir, 'test_manual_20260925T120031Z.dump');
  symlinkSync(real, link);
  writeFileSync(`${link}.manifest.json`, readFileSync(`${real}.manifest.json`));
  assert.equal((await open(link)).ok, false);

  const q = writeSet('test_manual_20260925T120032Z.dump');
  renameSync(`${q}.manifest.json`, `${q}.manifest.real`);
  symlinkSync(`${q}.manifest.real`, `${q}.manifest.json`);
  assert.equal((await open(q)).ok, false);
});

// --- consumer verifier: M2 (post-verification substitution) --------------

test('consumer M2: assertUnchanged detects replacement, in-place edits, symlink swaps and manifest swaps', async () => {
  const scenarios = [
    (p) => { writeFileSync(`${p}.new`, archive()); renameSync(`${p}.new`, p); },
    (p) => appendFileSync(p, 'x'),
    (p) => { renameSync(p, `${p}.moved`); symlinkSync(`${p}.moved`, p); },
    (p) => { writeFileSync(`${p}.m`, readFileSync(`${p}.manifest.json`)); renameSync(`${p}.m`, `${p}.manifest.json`); },
    (p) => unlinkSync(p),
  ];
  for (const [i, change] of scenarios.entries()) {
    const p = writeSet(`test_manual_20260925T12004${i}Z.dump`);
    const handle = await open(p);
    assert.equal(handle.ok, true, handle.reason);
    assert.equal(handle.assertUnchanged(), true);
    change(p);
    assert.equal(handle.assertUnchanged(), false, `scenario ${i}`);
    handle.dispose();
  }
});

test('consumer: after dispose the handle can no longer vouch for the artifact', async () => {
  const handle = await open(writeSet(NAME));
  handle.dispose();
  assert.equal(handle.assertUnchanged(), false);
});

// --- TOC parser ------------------------------------------------------------

test('toc: missing owner and comment lines are handled; unknown TABLE DATA shapes fail closed', () => {
  assert.equal(checkArchiveToc(['3401; 0 16391 TABLE DATA public User postgres', '3402; 0 16392 TABLE DATA public Branch'].join('\n'), COUNTS), null);
  assert.equal(checkArchiveToc(`;  TABLE DATA mona_test_guard x\n${TOC}`, COUNTS), null);
  assert.notEqual(checkArchiveToc('3401; 0 16391 TABLE DATA', COUNTS), null);
  assert.notEqual(checkArchiveToc('', COUNTS), null);
});

// --- H1.2: one serialized manifest has exactly one interpretation ----------

// Each mutation keeps the LAST occurrence identical to the producer's value, so
// JSON.parse (last key wins) would reconstruct a self-consistent manifest.
const AMBIGUOUS_MANIFESTS = {
  'J1 duplicate top-level counts (malicious first)': (m) => m.replace('{\n', '{\n  "counts": {"Evil": 5},\n'),
  'J2 duplicate top-level key with identical value': (m) => m.replace('{\n', '{\n  "format": "mona-test-backup/v1",\n'),
  'J3 duplicate nested dump.file': (m) => m.replace('"dump": {\n', '"dump": {\n    "file": "test_manual_20260101T000000Z.dump",\n'),
  'J4 duplicate key inside counts': (m) => m.replace('"counts": {\n', '"counts": {\n    "User": 999,\n'),
  'J5 duplicate manifestSha256': (m) => m.replace('{\n', `{\n  "manifestSha256": "${'0'.repeat(64)}",\n`),
  'J6 escaped spelling duplicating counts': (m) => m.replace('{\n', '{\n  "\\u0063ounts": {"Evil": 5},\n'),
  'J7 escaped key spelling alone': (m) => m.replace('"counts": {', '"\\u0063ounts": {'),
  'J8 unicode escape in a property name': (m) => m.replace('"setId"', '"\\u0073etId"'),
  'J8 lone surrogate property': (m) => m.replace('{\n', '{\n  "\\ud800": 1,\n'),
  'J9 malformed JSON next to a duplicate': (m) => m.replace('{\n', '{\n  "purpose": "manual",,\n'),
  'J10 compact but otherwise identical': (m) => JSON.stringify(JSON.parse(m)),
  'J10 CRLF line endings': (m) => m.replace(/\n/g, '\r\n'),
  'J10 missing final newline': (m) => m.slice(0, -1),
  'J10 trailing whitespace': (m) => m.replace('"purpose": "manual",', '"purpose": "manual",  '),
  'J11 UTF-8 BOM': (m) => `﻿${m}`,
  'J11 invalid UTF-8 byte': (m) => Buffer.concat([Buffer.from(m.slice(0, 10)), Buffer.from([0xff]), Buffer.from(m.slice(10))]),
  'J13 __proto__ key': (m) => m.replace('{\n', '{\n  "__proto__": {},\n'),
};

test('H1.2 manifest: every ambiguous or non-canonical serialization is rejected', async () => {
  let i = 0;
  for (const [label, mutate] of Object.entries(AMBIGUOUS_MANIFESTS)) {
    const name = `test_manual_20260925T13${String(i++).padStart(4, '0')}Z.dump`;
    const handle = await open(writeSet(name, { mutate }));
    assert.equal(handle.ok, false, label);
  }
  assert.deepEqual(snapshotsLeft(), []);
});

test('H1.2 manifest: producer output round-trips byte-for-byte and is accepted', async () => {
  const handle = await open(writeSet(NAME));
  assert.equal(handle.ok, true, handle.reason);
  handle.dispose();
  const raw = readFileSync(path.join(dir, `${NAME}.manifest.json`), 'utf8');
  assert.equal(`${JSON.stringify(JSON.parse(raw), null, 2)}\n`, raw);
});

// --- H1.2: TOC entries are unique before any set comparison ------------------

const ENTRY_USER = '3401; 0 16391 TABLE DATA public User postgres';
const ENTRY_BRANCH = '3402; 0 16392 TABLE DATA public Branch postgres';
const AMBIGUOUS_TOCS = {
  'T1 identical TABLE DATA line twice': [ENTRY_USER, ENTRY_USER, ENTRY_BRANCH],
  'T2 same table under two dump ids': [ENTRY_USER, '3499; 0 16391 TABLE DATA public User postgres', ENTRY_BRANCH],
  'T3 plain and quoted spelling of one table': [ENTRY_USER, '3499; 0 16391 TABLE DATA public "User" postgres', ENTRY_BRANCH],
  'T3 quoted spelling alone': ['3401; 0 16391 TABLE DATA public "User" postgres', ENTRY_BRANCH],
  'T4 duplicate dump id on a non-TABLE-DATA entry': ['215; 1259 16391 TABLE public User postgres', '215; 1259 16391 TABLE public User postgres', ENTRY_USER, ENTRY_BRANCH],
  'T5 unrecognised non-comment line': ['garbage that is not an entry', ENTRY_USER, ENTRY_BRANCH],
  'T6 TABLE DATA with extra tokens': ['3401; 0 16391 TABLE DATA public User postgres extra', ENTRY_BRANCH],
  'T6 TABLE DATA without a name': ['3401; 0 16391 TABLE DATA public', ENTRY_BRANCH],
  'T9 duplicate hides a missing table': [ENTRY_USER, '3499; 0 16391 TABLE DATA public User postgres'],
};

test('H1.2 toc: duplicate or ambiguous entries are rejected before comparison with counts', () => {
  for (const [label, lines] of Object.entries(AMBIGUOUS_TOCS)) {
    assert.notEqual(checkArchiveToc(lines.join('\n'), COUNTS), null, label);
  }
});

test('H1.2 toc: unique entries, blank lines, comments and a missing owner are accepted', () => {
  assert.equal(checkArchiveToc(TOC, COUNTS), null);
  assert.equal(checkArchiveToc(`\n;\n${ENTRY_USER}\n\n3402; 0 16392 TABLE DATA public Branch\n`, COUNTS), null);
});

test('H1.2 toc: an archive with a duplicated TABLE DATA entry is rejected end to end', async () => {
  const dump = archive([ENTRY_USER, ENTRY_USER, ENTRY_BRANCH].join('\n'));
  assert.equal((await open(writeSet(NAME, { dump }))).ok, false);
});

// --- withVerifiedClient: closing the client never replaces fn(client)'s outcome ---------
//
// Injected fake clients only (no socket). `end` modes: 'throw' is a genuine
// synchronous throw at call time (non-async function), 'reject' an async rejection,
// 'string'/'reject-string' non-Error values. Cleanup errors carry synthetic secrets.
const CLOSE_SECRET = 'postgresql://postgres.closeref000000000a:Cl0seSecret@close-host.invalid:5432/postgres';
function closingClient(end = 'ok', { connectError = null } = {}) {
  const record = { ends: 0, connects: 0 };
  const client = {
    connect() {
      record.connects += 1;
      return connectError ? Promise.reject(connectError) : Promise.resolve();
    },
    query: async () => ({ rows: [{ n: 1 }] }),
    end() {
      record.ends += 1;
      if (end === 'throw') throw new Error(`close threw ${CLOSE_SECRET}`);
      if (end === 'string') throw `close string ${CLOSE_SECRET}`;
      if (end === 'reject') return Promise.reject(new Error(`close rejected ${CLOSE_SECRET}`));
      if (end === 'reject-string') return Promise.reject(`close string ${CLOSE_SECRET}`);
      return Promise.resolve();
    },
  };
  return { client, record, factory: () => client };
}
const END_MODES = ['throw', 'string', 'reject', 'reject-string'];
const CONN = { host: 'h.invalid', port: '5432', database: 'postgres', user: 'u', password: 'p' };

test('V9/V11/V13/V14: a successful fn(client) result survives every close failure; end runs once', async () => {
  for (const end of ['ok', ...END_MODES]) {
    const { record, factory } = closingClient(end);
    const value = await withVerifiedClient(CONN, async () => ({ User: 3 }), factory).then((v) => v, (e) => ({ escaped: String(e?.message ?? e).slice(0, 30) }));
    assert.deepEqual(value, { User: 3 }, `${end}: close failure replaced the successful result`);
    assert.equal(record.ends, 1, `${end}: end called once`);
  }
});

test('V10/V12/V13: a primary fn(client) failure stays authoritative over every close failure', async () => {
  for (const end of END_MODES) {
    const primary = new Error('primary count failure');
    const { record, factory } = closingClient(end);
    await assert.rejects(withVerifiedClient(CONN, async () => { throw primary; }, factory), (err) => err === primary, `${end}: primary replaced`);
    assert.equal(record.ends, 1);
  }
});

test('V14: a connect failure stays authoritative and the client is still ended exactly once', async () => {
  for (const end of END_MODES) {
    const primary = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' });
    const { record, factory } = closingClient(end, { connectError: primary });
    let ran = false;
    await assert.rejects(withVerifiedClient(CONN, async () => { ran = true; }, factory), (err) => err === primary, end);
    assert.equal(ran, false);
    assert.equal(record.ends, 1);
  }
});

test('V15: a call after a close failure is independent', async () => {
  const bad = closingClient('throw');
  await withVerifiedClient(CONN, async () => 1, bad.factory).catch(() => {});
  const good = closingClient();
  assert.equal(await withVerifiedClient(CONN, async () => 2, good.factory), 2);
  assert.equal(good.record.ends, 1);
});

test('V16: lib.mjs stays a leaf module (no local imports, so no cycle with test-marker.mjs)', () => {
  const source = readFileSync(new URL('./lib.mjs', import.meta.url), 'utf8');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.deepEqual(code.match(/from '\.\.?\/[^']+'/g) ?? [], []);
  assert.deepEqual(code.match(/import\(\s*'\.\.?\//g) ?? [], [], 'no dynamic local import either');
  assert.ok(!/\.end\(\)\.catch\(/.test(code), 'no eager .end().catch()');
});
