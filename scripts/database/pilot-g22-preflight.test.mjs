// Zero-database tests for pilot-g22-preflight.mjs: the READ-ONLY PILOT preflight of the USER-MGMT rollout (G20 -> G21 -> G22).
// Run with: node --test scripts/database/pilot-g22-preflight.test.mjs
// Hermetic: synthetic *.invalid URL, the in-memory scripted database of pilot-g22-fake-db.mjs and an injected identity proof. The real private PILOT file is never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as P from './pilot-g22-preflight.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';
import { FakeDb, MARKER, SCHEMA, rawFor } from './pilot-g22-fake-db.mjs';

const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = 'pilotsynthref0000001';
const SECRET = 'PreflightPw';
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/postgres`;
const LEAKS = [SECRET, HOST, REF, URL_TEXT, os.homedir()];
const ARGV = (extra = []) => ['--target=pilot', '--check', `--marker-id=${MARKER}`, ...extra];

async function run(argv, { db = new FakeDb(), proof = 0, file = { ok: true, text: `${URL_TEXT}\n` }, overrides = {} } = {}) {
  const lines = [];
  const errors = [];
  let created = 0;
  const rc = await P.main(argv, {
    urlFile: '/synthetic/pilot-database-url', readUrlFile: () => file, env: {}, schema: SCHEMA,
    createClient: () => { created += 1; return db.client(); }, proveIdentity: async () => proof,
    log: (l) => lines.push(String(l)), error: (l) => errors.push(String(l)), ...overrides,
  });
  return { rc, db, lines, errors, text: [...lines, ...errors].join('\n'), created };
}

test('PF-01 args: exactly --target=pilot, one --check, a v4 marker id, an optional 20-character project ref; no write mode, nothing positional or unknown', async () => {
  assert.equal(P.parseCliArgs(ARGV()).ok, true);
  assert.equal(P.parseCliArgs(ARGV([`--confirm-project-ref=${REF}`])).confirmProjectRef, REF);
  for (const bad of [[], ['--target=pilot', `--marker-id=${MARKER}`], ['--target=dev', '--check', `--marker-id=${MARKER}`], ['--target=pilot', '--check', '--check', `--marker-id=${MARKER}`],
    ['--target=pilot', '--check', '--marker-id=nope'], ARGV(['--execute']), ARGV(['--dry-run']), ARGV(['--plan=x']), ARGV(['stray']), ARGV(['--confirm-project-ref=short']), ARGV([`--marker-id=${OTHER}`]),
    ['--target=pilot', '--target=pilot', '--check', `--marker-id=${MARKER}`], ARGV(['--expected-state=EXACT_G20'])]) {
    const r = await run(bad); assert.equal(r.rc, 1, JSON.stringify(bad)); assert.equal(r.created, 0); assert.match(r.text, /PILOT_G22_PREFLIGHT_RESULT=ERROR/);
  }
});

test('PF-02 EXACT_G20 over the EXACT_G20 schema: READY, exit 0, the report carries the facts and the frozen counts, nothing but one read-only snapshot was issued, no secret printed', async () => {
  const r = await run(ARGV());
  assert.equal(r.rc, 0, r.text);
  assert.equal(r.lines.at(-1), 'PILOT_G22_PREFLIGHT_RESULT=G22_READY_FOR_MIGRATION');
  for (const needle of ['ledger generation: EXACT_G20', '6 total, 5 active, 1 inactive, 0 with a non-lowercase e-mail', 'colliding case-insensitively: 0', 'operative OWNER (active, OWNER at COMPANY scope): 1',
    'cash sessions OPEN: 0', 'sales DRAFT: 18', 'sales PENDING_PAYMENT: 1', 'live stock reservations: 0', 'rows AuditLog: 895', 'all absent', 'WARNING (not a blocker): 1 sale(s) PENDING_PAYMENT', 'ROLLOUT_COUNTS={']) {
    assert.ok(r.text.includes(needle), needle);
  }
  assert.ok(r.db.readOnlyOnly); assert.equal(r.db.statements.at(-1), 'ROLLBACK'); assert.equal(r.db.connects, 1); assert.equal(r.db.ends, 1);
  for (const leak of LEAKS) assert.ok(!r.text.includes(leak), leak);
  assert.ok(!/@/.test(r.text), 'no e-mail address is ever printed');
});

test('PF-03 the printed ROLLOUT_COUNTS is exactly what pilot-g22-verify accepts', async () => {
  const r = await run(ARGV());
  const line = r.lines.find((l) => l.trim().startsWith('ROLLOUT_COUNTS='));
  const { parseCounts } = await import('./pilot-g22-rollout.mjs');
  assert.equal(parseCounts(line.trim().slice('ROLLOUT_COUNTS='.length)).ok, true);
});

test('PF-04 every other source is BLOCKED (exit 1, nothing repaired): G19, G21, G22, a half-applied G21/G22, a G20 ledger over drift, e-mail collision, no OWNER, unclassified catalog', async () => {
  const g19 = new FakeDb(); g19.ledgerOverride = pinsOf('EXACT_G19').map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));
  const half = new FakeDb(); half.ledgerOverride = pinsOf('EXACT_G21').map((m, i) => ({ migration_name: m.name, checksum: m.sha256, finished: i !== 20, rolled_back: false }));
  const drift = new FakeDb(); drift.rawOverride = rawFor('EXACT_G21');
  const cases = [
    ['G19', g19, /SOURCE_BEFORE_G20/], ['G21', new FakeDb({ generation: 'EXACT_G21' }), /SOURCE_IS_G21/], ['G22', new FakeDb({ generation: 'EXACT_G22' }), /ALREADY_G22/],
    ['half-applied', half, /LEDGER_UNCLASSIFIED/], ['drift', drift, /SCHEMA_DRIFT/], ['no owner', new FakeDb({ data: { operativeOwners: 0 } }), /NO_OPERATIVE_OWNER/],
  ];
  for (const [label, db, match] of cases) {
    const r = await run(ARGV(), { db });
    assert.equal(r.rc, 1, label); assert.match(r.text, match, label); assert.equal(r.lines.at(-1), 'PILOT_G22_PREFLIGHT_RESULT=BLOCKED', label);
    assert.ok(r.db.readOnlyOnly, label);
  }
});

test('PF-05 an e-mail collision prints USER_MGMT_EMAIL_COLLISION_BLOCKER, lists no address and fixes nothing', async () => {
  const r = await run(ARGV(), { db: new FakeDb({ data: { collisionGroups: 2 } }) });
  assert.equal(r.rc, 1);
  assert.ok(r.lines.includes('USER_MGMT_EMAIL_COLLISION_BLOCKER'));
  assert.match(r.text, /colliding case-insensitively: 2/);
  assert.ok(!/@/.test(r.text));
  assert.ok(r.db.readOnlyOnly);
});

test('PF-06 a failed identity proof, an unreadable or malformed URL file, a mismatching project ref or an unreadable snapshot stop the tool before/without any verdict', async () => {
  const proof = await run(ARGV(), { proof: 1 });
  assert.equal(proof.rc, 1); assert.equal(proof.db.statements.length, 0); assert.match(proof.text, /phase=identity/);
  assert.equal((await run(ARGV(), { file: { ok: false, reason: 'x' } })).rc, 1);
  assert.equal((await run(ARGV(), { file: { ok: true, text: 'not a url' } })).rc, 1);
  const ref = await run(ARGV(['--confirm-project-ref=aaaaaaaaaaaaaaaaaaaa']));
  assert.equal(ref.rc, 1); assert.equal(ref.created, 0); assert.match(ref.text, /does not match/);
  const bad = await run(ARGV(), { db: new FakeDb({ marker: { marker_id: OTHER, environment: 'pilot' } }) });
  assert.equal(bad.rc, 1); assert.match(bad.text, /phase=snapshot/); assert.ok(!bad.lines.some((l) => /VERDICT/.test(l)));
  const throwing = await run(ARGV(), { overrides: { readUrlFile: () => { throw new Error(`boom ${SECRET}`); } } });
  assert.equal(throwing.rc, 1); assert.ok(!throwing.text.includes(SECRET));
});

test('PF-07 the tool has no write path: its source issues no DDL/DML and imports no migration runner', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./pilot-g22-preflight.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|CREATE)\b\s+(INTO|TABLE|FROM|INDEX|\w+)/);
  assert.doesNotMatch(src, /child_process|spawn|prisma migrate|writeFile/);
});
