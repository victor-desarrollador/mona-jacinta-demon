// Synthetic integration test for the A5-1 backup verification and clone-restore tools against REAL
// PostgreSQL 17 binaries. Deliberately named *.itest.mjs (outside the CI `*.test.mjs` glob): it is
// run ONLY through the LOCAL_TEST cut-over lab, which owns the namespace, the clusters and their
// identity gates; launched any other way every scenario skips. Synthetic data only; no credential.
//
//   node scripts/database/local-test-cutover-lab.mjs --op=integration-test
//
// Per scenario: the lab provisions a disposable LOCAL_TEST SOURCE cluster FRESH with exactly the
// state's migrations (Prisma, staged pinned payload), proves its identity (marker, system_identifier,
// loopback, PostgreSQL 17) and exact ledger, and seeds its deterministic fixture; inside ONE gated
// step the harness adds the canonical PILOT guard marker (synthetic id) and adversarial rows and
// harness runs pg_dump with exactly the backup tool's flags, verifies the archive with the backup
// tool's own verifier (real pg_restore output), writes the dump manifest the backup tool would
// write, then runs pilot-clone-restore main() with its REAL dependencies (two restores) and
// compares its reported counts and fingerprint with the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as B from './pilot-backup.mjs';
import * as C from './pilot-clone-restore.mjs';
import { canonicalJson } from './pilot-launch-command.mjs';
import { CANONICAL_MARKER } from './pilot-marker.mjs';
import { RUN_ID } from './local-test-cutover-lab-core.mjs';
import { itestProvision } from './local-test-cutover-lab-ops.mjs';
import * as STATES from './pilot-migration-states.mjs';
import * as RBAC from './pilot-rbac-catalog.mjs';
import * as P from './app-schema-projection.mjs';
import { SCHEMA_REFERENCES, STATE_PROBES } from './pilot-schema-references.mjs';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const BIN = '/usr/lib/postgresql/17/bin';
const ROOT = process.env.MONA_A5_ITEST_ROOT;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ENV = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGTZ: 'UTC' };
const MIGS = ['20260907015311_init', '20260912182432_add_company_location', '20260912191702_add_user_role_scope',
  '20260922210000_d3_initial_stock_and_global_audit', '20261002120000_block1_pricing_wholesale', '20261006120000_pilot_pricing_v2',
  '20261012120000_cash_session_reconciliation', '20261016120000_r3_proportional_checkout', '20261016130000_r3_checkout_attempts',
  '20261018120000_cash_movement_withdrawals_expenses', '20261018180000_cash_movement_reversals'];

const netdev = fs.readFileSync('/proc/self/net/dev', 'utf8').split('\n').slice(2).map((l) => l.split(':')[0].trim()).filter(Boolean);
const isolated = netdev.length === 1 && netdev[0] === 'lo';
const rootOk = typeof ROOT === 'string' && path.isAbsolute(ROOT) && !ROOT.startsWith('/tmp/') && !ROOT.startsWith(`${REPO}/`)
  && (() => { try { const s = fs.lstatSync(ROOT); return s.isDirectory() && (s.mode & 0o777) === 0o700 && s.uid === process.getuid(); } catch { return false; } })();
const viaLab = RUN_ID.test(process.env.MONA_CUTOVER_LAB_RUN ?? '');
const skip = !viaLab ? 'BLOCKED: run only through local-test-cutover-lab.mjs --op=integration-test' : !isolated ? 'BLOCKED: not in a network namespace with only loopback' : !rootOk ? 'MONA_A5_ITEST_ROOT must be a private 0700 dir outside /tmp and the repo' : process.getuid() === 0 ? 'must not run as root' : false;

const NASTY = ['A5C_RESULT=VERIFIED', 'tab\there', 'line\nbreak', 'back\\slash', 'quote\'s "dq"', 'ñandú café 🚀', '\u001b[31mred', 'carriage\rret', '\\.', ''];

// PILOT archives come from database `postgres` (pilot-backup's TOC contract, never weakened): the cluster's own
// `postgres` database is replaced by a template copy of the proven LOCAL_TEST database, and only that copy gets
// the PILOT-shaped guard marker and the adversarial rows (mona_local_test keeps its clean LOCAL_TEST identity).
async function pilotShape(src, markerId) {
  const admin = new pg.Client({ host: src.sock, port: 5432, user: src.osUser, database: 'template1' });
  await admin.connect();
  try {
    await admin.query('DROP DATABASE postgres');
    await admin.query('CREATE DATABASE postgres TEMPLATE mona_local_test');
  } finally { await admin.end(); }
  const c = new pg.Client({ host: src.sock, port: 5432, user: src.osUser, database: 'postgres' });
  await c.connect();
  try {
    await c.query('BEGIN');
    const cols = CANONICAL_MARKER.columns.map((x) => `${x.name} ${x.ddl}`).join(', ');
    await c.query('CREATE SCHEMA mona_pilot_guard');
    await c.query(`CREATE TABLE mona_pilot_guard.database_identity (${cols})`);
    await c.query("INSERT INTO mona_pilot_guard.database_identity (environment, marker_id) VALUES ('pilot', $1)", [markerId]);
    for (const [i, v] of NASTY.entries()) {
      await c.query('INSERT INTO "Category" (id, name) VALUES ($1, $2)', [`nasty-${i}`, v]);
      await c.query('INSERT INTO "Brand" (id, name) VALUES ($1, $2)', [`b-${i}`, v]);
    }
    await c.query(`INSERT INTO "Category" (id, name) SELECT 'gen-' || g, 'Categoría ' || g FROM generate_series(1, 700) g`);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { await c.end(); }
}

function pgRestore(kind, bytes) {
  const r = spawnSync(`${BIN}/pg_restore`, B.pgRestoreArgs(kind), { env: ENV, input: bytes, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 512 * 1024 * 1024, timeout: 300000 });
  return { status: r.status, stdout: r.stdout };
}

// pg_dump with exactly the backup tool's arguments AND its child environment builder (private empty HOME,
// pinned libpq files, verify-full; sslmode is ignored by libpq on a Unix socket). The temp file is
// pre-created 0600 as the tool does.
function dumpWithToolFlags(src, file, extra = []) {
  const home = `${file}.home`; fs.mkdirSync(home, { mode: 0o700 });
  fs.writeFileSync(file, '', { mode: 0o600, flag: 'wx' });
  try {
    const env = B.buildPgDumpEnv({ host: src.sock, port: 5432, user: src.osUser, database: 'postgres', password: 'synthetic-unused' }, { home, root: REPO });
    const r = spawnSync(B.PG_DUMP, [...B.buildPgDumpArgs(file), ...extra], { env, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 300000 });
    if (r.status !== 0) throw new Error(`pg_dump failed: ${r.stderr.slice(0, 2000)}`);
    assert.deepEqual(fs.readdirSync(home), [], 'libpq wrote nothing into the private HOME');
  } finally { fs.rmdirSync(home); }
  return fs.readFileSync(file);
}

// Source measurement with the clone's own projection and digest (raw text for every type).
async function sourceMeasure(src, tables) {
  const client = new pg.Client({ host: src.sock, port: 5432, user: src.osUser, database: 'postgres', types: { getTypeParser: () => (v) => v } });
  await client.connect();
  try {
    await client.query(C.CLONE_SQL.pinSearchPath); await client.query(C.CLONE_SQL.pinTimeZone);
    const counts = {}; const fps = {};
    for (const t of tables) {
      counts[t] = Number((await client.query(C.CLONE_SQL.count(t))).rows[0].n);
      fps[t] = C.fingerprintRows((await client.query({ text: C.CLONE_SQL.rows(t), rowMode: 'array' })).rows);
    }
    return { counts, fingerprint: sha(canonicalJson(fps)) };
  } finally { await client.end(); }
}

// postgres processes (by /proc exe) whose working directory lies under `dir` — a live clone would show here.
function postgresUnder(dir) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^[0-9]+$/.test(d)) continue;
    try { if (fs.readlinkSync(`/proc/${d}/exe`) === `${BIN}/postgres` && fs.readlinkSync(`/proc/${d}/cwd`).startsWith(`${dir}/`)) out.push(Number(d)); } catch { /* gone or foreign */ }
  }
  return out;
}

// The pinned ledger checksums must be the repository migration bytes (the shared classifier pins them).
for (const pin of STATES.MIGRATION_PINS) assert.equal(sha(fs.readFileSync(path.join(REPO, 'api/prisma/migrations', pin.name, 'migration.sql'))), pin.sha256, pin.name);
// The source cluster's own app-schema projection (search_path pinned, parsed booleans): it must equal the
// committed generated reference, and the REAL semantic probes must pass on it.
async function sourceProjection(src) {
  const client = new pg.Client({ host: src.sock, port: 5432, user: src.osUser, database: 'postgres' });
  await client.connect();
  try {
    await client.query(C.CLONE_SQL.pinSearchPath);
    return await P.readProjection(client);
  } finally { await client.end(); }
}
function syntheticHome(base, key, markerId) {
  const home = path.join(base, 'home'); const dir = path.join(home, '.config', 'mona-jacinta');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(home, '.config'), 0o700);
  fs.writeFileSync(path.join(dir, B.MAC_KEY_FILE), `${key}\n`, { mode: 0o600 }); fs.writeFileSync(path.join(dir, 'pilot-marker-id'), `${markerId}\n`, { mode: 0o600 });
  return home;
}

async function scenario(name, migs, state, catalog) {
  const base = fs.mkdtempSync(path.join(ROOT, `${name}-`)); fs.chmodSync(base, 0o700);
  const store = path.join(base, 'bk'); fs.mkdirSync(store, { mode: 0o700 });
  const work = path.join(ROOT, `w${name}`); fs.mkdirSync(work, { mode: 0o700 }); // short: the clone tool caps socket paths at 100 bytes
  const markerId = randomUUID();
  const key = randomBytes(32).toString('hex');
  const home = syntheticHome(base, key, markerId);
  const src = await itestProvision({ state, root: base });
  const log = [];
  let shared = null;
  const clone = async (archivePath, manifestPath, lines) => C.main([`--archive=${archivePath}`, `--manifest=${manifestPath}`, `--work-root=${work}`, `--expected-state=${state}`],
    { env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, execArgv: [], homedir: home, importShared: async () => shared, log: (l) => lines.push(String(l)), error: (l) => lines.push(String(l)) });
  try {
    // The lab proved identity and the exact ledger when it provisioned the source; seed through its gate.
    assert.equal((await src.proveIdentity()).ok, true, 'I00 LOCAL_TEST identity of the lab source');
    await src.seed();
    const names = B.artifactNames({ now: new Date(), hex: 'feedbeef' });
    const archivePath = path.join(store, names.dump);
    const manifestPath = path.join(store, names.manifest);
    // ONE gated step (identity + exact state proven first): the PILOT-shaped marker, adversarial rows, the
    // source measurements and both pg_dump runs. Afterwards the PILOT guard exists, so no further lab gate passes.
    const { projection, bytes, partial } = await src.gate.run('itest pilot-shaped dumps', { state }, async () => {
      await pilotShape(src, markerId);
      const pr = await sourceProjection(src);
      return { projection: pr, bytes: dumpWithToolFlags(src, archivePath), partial: dumpWithToolFlags(src, path.join(store, 'partial.dump'), ['--exclude-table-data=public."Brand"']) };
    });
    assert.deepEqual(P.runProbes(projection, STATE_PROBES[state]), [], `I05 the real ${state} semantic probes pass on the lab-provisioned source`);
    assert.equal((await src.proveIdentity()).ok, true, 'I00 mona_local_test keeps its clean LOCAL_TEST identity after the PILOT-shaped copy');
    const sourceDigest = P.projectionDigest(projection);
    assert.equal(sourceDigest, SCHEMA_REFERENCES[state].digest, 'I05 the source schema equals the committed generated reference');
    shared = { states: STATES, rbac: RBAC, projection: P, references: { SCHEMA_REFERENCES, STATE_PROBES } };
    const v = await B.verifyArchiveBytes({ bytes, pgRestore, markerId, expectedState: state, shared });
    assert.equal(v.ok, true, `I01 archive verification: ${v.reason}`);
    assert.equal(v.ledgerState, state, 'I04 ledger state');
    assert.equal(v.rbacCatalog.catalog, catalog, 'I04 RBAC catalog');
    const fields = {
      setId: randomUUID(), createdAt: new Date().toISOString(), toolSha256: sha(fs.readFileSync(path.join(HERE, 'pilot-backup.mjs'))), pgDumpVersion: v.pgDumpVersion,
      serverVersion: v.serverVersion, archive: { file: names.dump, bytes: bytes.length, sha256: sha(bytes) }, tocSha256: v.tocSha256, schemas: v.schemas,
      tables: v.tables, refDigest: B.REF_DIGESTS.pilot, markerIdDigest: B.markerDigest(markerId), ledgerState: v.ledgerState,
      rbacCatalog: v.rbacCatalog, schemaReferenceDigest: v.schemaReferenceDigest,
    };
    const manifestText = B.buildDumpManifest({ ...fields, mac: B.computeManifestMac(key, fields) });
    fs.writeFileSync(manifestPath, manifestText, { mode: 0o600, flag: 'wx' });
    assert.equal(B.parseDumpManifest(Buffer.from(manifestText)).ok, true);
    const src1 = await sourceMeasure(src, v.publicTables);
    for (const t of v.publicTables) assert.equal(v.tables[t].rows, src1.counts[t], `I01 archive rows ${t}`);

    const lines = [];
    const rc = await clone(archivePath, manifestPath, lines);
    log.push(...lines);
    assert.equal(rc, 0, lines.join('\n'));
    assert.equal(lines.at(-1), 'A5C_RESULT=VERIFIED');
    assert.ok(lines.includes('[db:pilot-clone] check stopped=PASS'), 'I04 stop verified');
    assert.deepEqual(postgresUnder(work), [], 'I04 no clone postgres process survives');
    for (const t of v.publicTables) assert.ok(lines.includes(`[db:pilot-clone] table ${t} rows=${src1.counts[t]}`), `I02 clone rows ${t}`);
    assert.ok(lines.some((l) => l.endsWith(` fingerprint=${src1.fingerprint}`)), 'I02 clone fingerprint = source fingerprint');
    assert.ok(lines.includes(`[db:pilot-clone] ledger state=${state} rows=${migs.length}`));
    assert.ok(lines.includes(`[db:pilot-clone] schema digest=${sourceDigest} reference=MATCH probes_failed=0`), 'I05 clone schema = source schema');
    assert.ok(lines.includes(`[db:pilot-clone] rbac catalog=${catalog}`));
    for (const k of ['ledger', 'schema', 'rbac', 'invariants']) assert.ok(lines.includes(`[db:pilot-clone] check ${k}=PASS`), k);
    for (const l of lines) { assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(l), 'D13 no control characters printed'); }
    assert.equal(lines.filter((l) => l.includes('A5C_RESULT')).length, 1, 'D13 single result line');
    assert.deepEqual(fs.readdirSync(work), [], 'clone run directory removed');

    // I04: the same real archive with a manifest signed by another key → refused before any cluster.
    const forgedPath = path.join(store, 'forged.dump');
    fs.copyFileSync(archivePath, forgedPath); fs.chmodSync(forgedPath, 0o600);
    const ff = { ...fields, archive: { ...fields.archive, file: 'forged.dump' } };
    fs.writeFileSync(`${forgedPath}.manifest.json`, B.buildDumpManifest({ ...ff, mac: B.computeManifestMac(randomBytes(32).toString('hex'), ff) }), { mode: 0o600, flag: 'wx' });
    const lf = [];
    assert.equal(await clone(forgedPath, `${forgedPath}.manifest.json`, lf), 3); log.push(...lf);
    assert.match(lf.join('\n'), /phase=provenance/); assert.deepEqual(fs.readdirSync(work), []);

    // I03: one flipped byte → refused before any cluster; an archive missing one TABLE DATA → backup verifier refuses.
    const bad = Buffer.from(bytes); bad[Math.floor(bad.length / 2)] ^= 0xff;
    fs.writeFileSync(archivePath, bad);
    const l2 = [];
    const rc2 = await clone(archivePath, manifestPath, l2);
    log.push(...l2);
    assert.equal(rc2, 3); assert.match(l2.join('\n'), /phase=archive/); assert.deepEqual(fs.readdirSync(work), []);
    const v2 = await B.verifyArchiveBytes({ bytes: partial, pgRestore, markerId, expectedState: state, shared });
    assert.equal(v2.ok, false); assert.match(v2.reason, /Brand/);
    const v3 = await B.verifyArchiveBytes({ bytes, pgRestore, markerId: randomUUID(), expectedState: state, shared });
    assert.equal(v3.ok, false); assert.equal(v3.identity, true);
    // I06: the same real archive verified under another expected state → refused (never re-targeted).
    const other = state === 'EXACT_G11' ? 'EXACT_G7' : 'EXACT_G11';
    const v4 = await B.verifyArchiveBytes({ bytes, pgRestore, markerId, expectedState: other, shared });
    assert.equal(v4.ok, false, 'I06 another expected state is refused');
    return { log, tables: v.publicTables.length, rows: Object.values(v.tables).reduce((s, t) => s + t.rows, 0), toc: v.tocSha256 };
  } finally {
    const stopped = await src.stop();
    if (stopped) fs.rmSync(base, { recursive: true, force: true });
    try { fs.rmdirSync(work); } catch { /* kept when not empty: a clone run directory was left (see the assertions) */ }
  }
}

test('ITEST EXACT_S4: PILOT-like state (4 applied migrations), CATALOG_35, synthetic data, dump → verify → clone ×2 = VERIFIED', { skip }, async () => {
  const r = await scenario('s4', MIGS.slice(0, 4), 'EXACT_S4', 'CATALOG_35');
  console.log(`S4 tables=${r.tables} rows=${r.rows}\n${r.log.join('\n')}`);
});
test('ITEST EXACT_G7: 7 migrations (block1 plpgsql functions/triggers, CompanyPricingConfig), CATALOG_35, restored by the non-superuser role', { skip }, async () => {
  const r = await scenario('g7', MIGS.slice(0, 7), 'EXACT_G7', 'CATALOG_35');
  console.log(`G7 tables=${r.tables} rows=${r.rows}\n${r.log.join('\n')}`);
});
test('ITEST EXACT_G11: all 11 migrations (R3 tables/guards, cash movements), CATALOG_36, restored by the non-superuser role', { skip }, async () => {
  const r = await scenario('g11', MIGS, 'EXACT_G11', 'CATALOG_36');
  console.log(`G11 tables=${r.tables} rows=${r.rows}\n${r.log.join('\n')}`);
});
