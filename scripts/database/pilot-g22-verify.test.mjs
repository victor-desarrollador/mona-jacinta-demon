// Zero-database tests for pilot-g22-verify.mjs: the READ-ONLY post-migration verifier of the USER-MGMT rollout.
// Run with: node --test scripts/database/pilot-g22-verify.test.mjs
// Hermetic: synthetic *.invalid URL, the in-memory scripted database of pilot-g22-fake-db.mjs and an injected identity proof.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import * as V from './pilot-g22-verify.mjs';
import { formatCounts } from './pilot-g22-rollout.mjs';
import { FINGERPRINT, FakeDb, MARKER, SCHEMA, baseData, rawFor } from './pilot-g22-fake-db.mjs';

const REF = 'pilotsynthref0000001';
const SECRET = 'VerifyPw';
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/postgres`;
const LEAKS = [SECRET, HOST, REF, URL_TEXT, os.homedir()];
const COUNTS = formatCounts(baseData().counts);
const ARGV = (extra = [], counts = COUNTS) => ['--target=pilot', '--check', `--marker-id=${MARKER}`, `--expected-counts=${counts}`, ...extra];

async function run(argv, { db = new FakeDb({ generation: 'EXACT_G22' }), proof = 0 } = {}) {
  const lines = [];
  const errors = [];
  const rc = await V.main(argv, {
    urlFile: '/synthetic/pilot-database-url', readUrlFile: () => ({ ok: true, text: URL_TEXT }), env: {}, schema: SCHEMA, fingerprint: FINGERPRINT,
    createClient: () => db.client(), proveIdentity: async () => proof,
    log: (l) => lines.push(String(l)), error: (l) => errors.push(String(l)),
  });
  return { rc, db, lines, errors, text: [...lines, ...errors].join('\n') };
}

test('VF-01 args: --expected-counts is mandatory and must be exactly the ten frozen counts; no write mode', async () => {
  assert.equal(V.parseCliArgs(ARGV()).ok, true);
  for (const bad of [['--target=pilot', '--check', `--marker-id=${MARKER}`], ARGV([], '{}'), ARGV([], 'nope'), ARGV(['--execute']), ARGV(['stray']), ARGV(['--expected-counts=x']),
    ['--target=pilot', `--marker-id=${MARKER}`, `--expected-counts=${COUNTS}`]]) {
    const r = await run(bad); assert.equal(r.rc, 1, JSON.stringify(bad)); assert.match(r.text, /PILOT_G22_VERIFY_RESULT=ERROR/);
  }
});

test('VF-02 a database that is exactly EXACT_G22 with unchanged counts verifies (exit 0), read-only, nothing secret printed', async () => {
  const r = await run(ARGV());
  assert.equal(r.rc, 0, r.text);
  assert.equal(r.lines.at(-1), 'PILOT_G22_VERIFY_RESULT=EXACT_G22_VERIFIED');
  assert.match(r.text, /VERDICT=EXACT_G22_VERIFIED/); assert.match(r.text, /UserAdminOperation rows: 0/); assert.match(r.text, /mustChangePassword=true: 0, credentialsChangedAt set: 0/);
  assert.ok(r.db.readOnlyOnly); assert.equal(r.db.statements.at(-1), 'ROLLBACK');
  for (const leak of LEAKS) assert.ok(!r.text.includes(leak));
});

test('VF-03 FAILED (exit 1, the reasons named) for: a G21 database, a G20 database, an AuditLog count that moved, a changed user default, a missing lower(email) index, a missing UserAdminOperation probe', async () => {
  const cases = [
    ['G21 (no UserAdminOperation to read)', new FakeDb({ generation: 'EXACT_G21' }), /phase=snapshot/],
    ['G20', new FakeDb({ generation: 'EXACT_G20' }), null],
    ['audit', new FakeDb({ generation: 'EXACT_G22', data: { counts: { ...baseData().counts, AuditLog: 896 } } }), /count changed: AuditLog 895 -> 896/],
    ['default', new FakeDb({ generation: 'EXACT_G22', data: { userDefaults: { total: 6, mustChange: 2, credentialsSet: 0 } } }), /mustChangePassword = true/],
  ];
  for (const [label, db, match] of cases) {
    const r = await run(ARGV(), { db });
    assert.equal(r.rc, 1, label);
    if (match) assert.match(r.text, match, label);
    assert.ok(!r.lines.includes('PILOT_G22_VERIFY_RESULT=EXACT_G22_VERIFIED'), label);
  }
  const noIndex = new FakeDb({ generation: 'EXACT_G22' }); const raw = rawFor('EXACT_G22'); raw.indexes = raw.indexes.filter((x) => x.name !== 'User_email_lower_key'); noIndex.rawOverride = raw;
  const a = await run(ARGV(), { db: noIndex }); assert.equal(a.rc, 1); assert.match(a.text, /PROBE_FAILED:index:User\.User_email_lower_key/);
  const noTable = new FakeDb({ generation: 'EXACT_G22' }); const raw2 = rawFor('EXACT_G22'); for (const k of ['tables', 'columns', 'constraints', 'indexes']) raw2[k] = raw2[k].filter((x) => x.table !== 'UserAdminOperation'); noTable.rawOverride = raw2;
  const b = await run(ARGV(), { db: noTable }); assert.equal(b.rc, 1); assert.match(b.text, /PROBE_FAILED:table:UserAdminOperation/);
});

test('VF-04 a failed identity proof or an unreadable snapshot (a G20 database has no G21 columns to read) ends in ERROR without a verdict', async () => {
  const p = await run(ARGV(), { proof: 1 });
  assert.equal(p.rc, 1); assert.equal(p.db.statements.length, 0);
  const g20 = await run(ARGV(), { db: new FakeDb({ generation: 'EXACT_G20' }) });
  assert.equal(g20.rc, 1); assert.match(g20.text, /phase=snapshot/); assert.ok(g20.lines.includes('PILOT_G22_VERIFY_RESULT=ERROR'));
});
