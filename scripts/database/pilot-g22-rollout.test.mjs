// Zero-database tests for pilot-g22-rollout.mjs: the shared core of the USER-MGMT rollout (G20 -> G21 -> G22). An in-memory scripted database only
// (pilot-g22-fake-db.mjs): no network, no PostgreSQL, no private file. Run with: node --test scripts/database/pilot-g22-rollout.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as R from './pilot-g22-rollout.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';
import { FINGERPRINT, FakeDb, MARKER, SCHEMA, baseData, rawFor } from './pilot-g22-fake-db.mjs';

const snap = async (db, options = {}) => R.readSnapshotOn(db.client(), { markerId: MARKER, ...options });
const snapAt = async (generation, data = {}, options = {}) => {
  const db = new FakeDb({ generation, data });
  const s = await snap(db, { userDefaults: generation !== 'EXACT_G20', adminOperations: generation === 'EXACT_G22', ...options });
  assert.equal(s.ok, true, s.reason);
  return s;
};
const unfinished = (generation) => {
  const rows = pinsOf(generation).map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));
  rows[rows.length - 1] = { ...rows[rows.length - 1], finished: false };
  return rows;
};

// ---- the snapshot ---------------------------------------------------------------------------------------------------------------------------

test('SN-01 the snapshot is one READ ONLY transaction: only SELECT / SET LOCAL / ROLLBACK, rolled back, marker proven, nothing but counts and names read', async () => {
  const db = new FakeDb();
  const s = await snap(db);
  assert.equal(s.ok, true);
  assert.ok(db.readOnlyOnly);
  assert.match(db.statements[0], /READ ONLY/);
  assert.equal(db.statements.at(-1), 'ROLLBACK');
  assert.equal(s.facts.users.total, 6);
  assert.equal(s.facts.operativeOwners, 1);
  assert.deepEqual(Object.keys(s.facts.counts), [...R.FROZEN_COUNT_TABLES]);
  // the user columns exist only from G21: a G20 snapshot never asks for them unless the caller does
  assert.ok(!db.statements.some((x) => /mustChangePassword/.test(x)));
});

test('SN-02 refused (and rolled back) when the marker is not the named PILOT one, the transaction is not read-only, TLS is not verified, or the marker id is missing', async () => {
  for (const [label, db, options] of [
    ['other marker', new FakeDb({ marker: { marker_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', environment: 'pilot' } }), {}],
    ['not pilot', new FakeDb({ marker: { marker_id: MARKER, environment: 'dev' } }), {}],
    ['no marker', new FakeDb({ marker: null }), {}],
    ['not read-only', new FakeDb({ readOnly: 'off' }), {}],
    ['no marker id', new FakeDb(), { markerId: '' }],
  ]) {
    const s = await R.readSnapshotOn(db.client(), { markerId: MARKER, ...options });
    assert.equal(s.ok, false, label);
    if (label !== 'no marker id') assert.equal(db.statements.at(-1), 'ROLLBACK', label);
  }
  const plain = new FakeDb();
  const tls = await R.readSnapshotOn(plain.client({ tls: false }), { markerId: MARKER });
  assert.equal(tls.ok, false);
  assert.equal(plain.statements.length, 0, 'no statement is issued over an unverified connection');
});

test('SN-03 a malformed count makes the whole snapshot fail closed (no partial facts)', async () => {
  const db = new FakeDb({ data: { counts: { ...baseData().counts, AuditLog: -1 } } });
  const s = await snap(db);
  assert.equal(s.ok, false);
});

// ---- source assessment ----------------------------------------------------------------------------------------------------------------------------

test('AS-01 EXACT_G20 over the EXACT_G20 schema with 0 collisions and one operative OWNER is READY; operation facts are WARNINGS, not blockers', async () => {
  const a = R.assessSource(await snapAt('EXACT_G20'), SCHEMA);
  assert.equal(a.verdict, 'READY'); assert.deepEqual(a.reasons, []);
  assert.deepEqual(a.warnings, ['1 sale(s) PENDING_PAYMENT']);
  const busy = R.assessSource(await snapAt('EXACT_G20', { operation: { cashOpen: 2, salesDraft: 0, salesPendingPayment: 0, liveReservations: 3 } }), SCHEMA);
  assert.equal(busy.verdict, 'READY');
  assert.deepEqual(busy.warnings, ['2 cash session(s) OPEN', '3 live stock reservation(s)']);
});

test('AS-02 a source older than G20 (G19, G16) is refused', async () => {
  for (const g of ['EXACT_G19', 'EXACT_G16']) {
    const s = await snapAt('EXACT_G20'); s.ledger = pinsOf(g).map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));
    const a = R.assessSource(s, SCHEMA);
    assert.equal(a.verdict, 'BLOCKED'); assert.deepEqual(a.reasons, ['SOURCE_BEFORE_G20'], g);
  }
});

test('AS-03 EXACT_G21 is refused as a normal source (reason names the resume path) and accepted only when the caller explicitly names EXACT_G21', async () => {
  const s = await snapAt('EXACT_G21');
  assert.deepEqual(R.assessSource(s, SCHEMA).reasons, ['SOURCE_IS_G21']);
  assert.match(R.REASONS.SOURCE_IS_G21, /explicit resume/);
  assert.equal(R.assessSource(s, SCHEMA, 'EXACT_G21').verdict, 'READY');
  // and the other way round: a resume told EXACT_G21 over a G20 database is a mismatch, never silently a normal run
  const g20 = await snapAt('EXACT_G20');
  assert.deepEqual(R.assessSource(g20, SCHEMA, 'EXACT_G21').reasons, ['STATE_MISMATCH']);
});

test('AS-04 EXACT_G22 is refused (nothing to migrate), for both source names', async () => {
  const s = await snapAt('EXACT_G22');
  assert.deepEqual(R.assessSource(s, SCHEMA).reasons, ['ALREADY_G22']);
  assert.deepEqual(R.assessSource(s, SCHEMA, 'EXACT_G21').reasons, ['ALREADY_G22']);
});

test('AS-05 a G20 LEDGER over a drifted schema is refused (the ledger alone is never trusted): a G21 column already present, a missing G20 object, an unknown digest', async () => {
  const withG21 = new FakeDb(); withG21.rawOverride = rawFor('EXACT_G21');
  assert.deepEqual(R.assessSource(await snap(withG21), SCHEMA).reasons, ['SCHEMA_DRIFT']);
  const missing = new FakeDb(); const raw = rawFor('EXACT_G20'); raw.functions = raw.functions.filter((f) => f.name !== 'fn_sale_post_sale_claim'); missing.rawOverride = raw;
  const a = R.assessSource(await snap(missing), SCHEMA);
  assert.deepEqual(a.reasons, ['SCHEMA_DRIFT']);
  assert.ok(a.probeFailures.some((f) => /fn_sale_post_sale_claim/.test(f)));
  const extra = new FakeDb(); const raw2 = rawFor('EXACT_G20'); raw2.tables.push({ table: 'Surprise' }); extra.rawOverride = raw2;
  assert.deepEqual(R.assessSource(await snap(extra), SCHEMA).reasons, ['SCHEMA_DRIFT']);
});

test('AS-06 a half-applied G21 or G22 (unfinished / rolled-back / extra / checksum-drifted ledger row) is UNCLASSIFIED and refused, never repaired', async () => {
  const cases = {
    'G21 unfinished': unfinished('EXACT_G21'),
    'G20 + unfinished G22 attempt': [...pinsOf('EXACT_G20').map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false })),
      { migration_name: pinsOf('EXACT_G22')[21].name, checksum: pinsOf('EXACT_G22')[21].sha256, finished: false, rolled_back: false }],
    'G21 + unfinished G22': unfinished('EXACT_G22'),
    'G22 rolled back': pinsOf('EXACT_G22').map((m, i) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: i === 21 })),
    'checksum drift': pinsOf('EXACT_G20').map((m, i) => ({ migration_name: m.name, checksum: i === 19 ? 'b'.repeat(64) : m.sha256, finished: true, rolled_back: false })),
  };
  for (const [label, rows] of Object.entries(cases)) {
    const s = await snapAt('EXACT_G20'); s.ledger = rows;
    assert.deepEqual(R.assessSource(s, SCHEMA).reasons, ['LEDGER_UNCLASSIFIED'], label);
  }
});

test('AS-07 an e-mail collision and a missing operative OWNER are each refused, together or alone, and an unclassifiable RBAC catalog too', async () => {
  assert.deepEqual(R.assessSource(await snapAt('EXACT_G20', { collisionGroups: 2 }), SCHEMA).reasons, ['EMAIL_COLLISION']);
  assert.deepEqual(R.assessSource(await snapAt('EXACT_G20', { operativeOwners: 0 }), SCHEMA).reasons, ['NO_OPERATIVE_OWNER']);
  assert.deepEqual(R.assessSource(await snapAt('EXACT_G20', { collisionGroups: 1, operativeOwners: 0 }), SCHEMA).reasons, ['EMAIL_COLLISION', 'NO_OPERATIVE_OWNER']);
  const s = await snapAt('EXACT_G20'); s.catalog = { roles: [], permissions: [], grants: [] };
  assert.deepEqual(R.assessSource(s, SCHEMA).reasons, ['CATALOG_UNCLASSIFIED']);
});

// ---- counts -----------------------------------------------------------------------------------------------------------------------------------

test('CT-01 ROLLOUT_COUNTS round-trips and parseCounts is strict (exactly the ten frozen tables, non-negative integers)', () => {
  const counts = baseData().counts;
  assert.deepEqual(R.parseCounts(R.formatCounts(counts)), { ok: true, counts });
  for (const bad of ['', '[]', 'null', '{}', JSON.stringify({ ...counts, Extra: 1 }), JSON.stringify({ ...counts, User: -1 }), JSON.stringify({ ...counts, User: 1.5 }), JSON.stringify({ ...counts, User: '6' }), 'not json']) {
    assert.equal(R.parseCounts(bad).ok, false, bad);
  }
  assert.deepEqual(R.diffCounts(counts, { ...counts, AuditLog: 896 }), [{ table: 'AuditLog', before: 895, after: 896 }]);
  assert.deepEqual(R.diffCounts(counts, counts), []);
});

// ---- target verification --------------------------------------------------------------------------------------------------------------------

const verify = (s, generation, extra = {}) => R.verifyTarget(s, generation, { schema: SCHEMA, fingerprint: FINGERPRINT, ...extra });

test('VT-01 EXACT_G22 with unchanged counts, G21 defaults on every user, the unique lower(email) index and an empty UserAdminOperation verifies', async () => {
  const s = await snapAt('EXACT_G22');
  const v = verify(s, 'EXACT_G22', { expectedCounts: baseData().counts });
  assert.deepEqual(v.failures, []); assert.equal(v.ok, true);
  assert.equal(verify(await snapAt('EXACT_G21'), 'EXACT_G21', { expectedCounts: baseData().counts }).ok, true);
});

test('VT-02 the verifier blocks: wrong generation, a count changed (AuditLog included), a user with mustChangePassword / credentialsChangedAt, a non-unique or missing lower(email) index, a non-empty UserAdminOperation, a wrong fingerprint, a missing probe', async () => {
  const counts = baseData().counts;
  const expectFail = async (label, generation, data, match, extra = {}, mutate = null) => {
    const s = await snapAt(generation, data);
    if (mutate) mutate(s);
    const v = verify(s, generation, { expectedCounts: counts, ...extra });
    assert.equal(v.ok, false, label); assert.match(v.failures.join('|'), match, label);
  };
  const g22asG21 = verify(await snapAt('EXACT_G22'), 'EXACT_G21', { expectedCounts: counts });
  assert.equal(g22asG21.ok, false); assert.match(g22asG21.failures[0], /^ledger:/);
  await expectFail('audit count', 'EXACT_G22', { counts: { ...counts, AuditLog: 896 } }, /count changed: AuditLog 895 -> 896/);
  await expectFail('user count', 'EXACT_G22', { counts: { ...counts, User: 7 } }, /count changed: User 6 -> 7/);
  await expectFail('must change', 'EXACT_G22', { userDefaults: { total: 6, mustChange: 1, credentialsSet: 0 } }, /mustChangePassword = true/);
  await expectFail('credentials set', 'EXACT_G22', { userDefaults: { total: 6, mustChange: 0, credentialsSet: 2 } }, /credentialsChangedAt set/);
  await expectFail('defaults for every user', 'EXACT_G22', { userDefaults: { total: 5, mustChange: 0, credentialsSet: 0 } }, /every user/);
  await expectFail('non-unique index', 'EXACT_G22', { lowerIndexDef: 'CREATE INDEX "User_email_lower_key" ON public."User" USING btree (lower(email))' }, /UNIQUE index on lower/);
  await expectFail('no index def', 'EXACT_G22', { lowerIndexDef: null }, /UNIQUE index on lower/);
  await expectFail('operations not empty', 'EXACT_G22', { adminOperations: 1 }, /UserAdminOperation is not empty/);
  await expectFail('fingerprint', 'EXACT_G22', {}, /360 columns/, { fingerprint: { columns: 360, relations: 38 } });
  await expectFail('ledger columns', 'EXACT_G22', { ledgerColumns: 9 }, /columns/);
  // the lower(email) index missing from the schema (probe + digest)
  const raw = rawFor('EXACT_G22'); raw.indexes = raw.indexes.filter((x) => x.name !== 'User_email_lower_key');
  const db = new FakeDb({ generation: 'EXACT_G22' }); db.rawOverride = raw;
  const noIdx = verify(await snap(db, { userDefaults: true, adminOperations: true }), 'EXACT_G22', { expectedCounts: counts });
  assert.equal(noIdx.ok, false); assert.match(noIdx.failures.join('|'), /PROBE_FAILED:index:User\.User_email_lower_key/);
});

test('VT-03 the real fingerprint constants are 360 columns and 38 relations (352 + 8 ledger columns, 37 tables + the ledger)', () => {
  assert.deepEqual({ ...R.EXPECTED_FINGERPRINT }, { columns: 360, relations: 38 });
  assert.equal(R.LEDGER_COLUMNS, 8);
});

// ---- the orchestrator -----------------------------------------------------------------------------------------------------------------------

function harness(db, { onStep = {} } = {}) {
  const applied = [];
  const logs = [];
  return {
    applied, logs,
    run: (initialState) => R.runRollout({
      initialState, schema: SCHEMA, fingerprint: FINGERPRINT, log: (l) => logs.push(l),
      readSnapshotNow: (options) => snap(db, options),
      applyStep: async (generation) => {
        applied.push(generation);
        if (onStep[generation]) return onStep[generation](db);
        db.advance(generation);
        return { ok: true };
      },
    }),
  };
}

test('RR-01 happy path: precheck, G21, witness, re-check, G22, post-check → MIGRATED; exactly the two generations applied, in order, nothing but reads issued by the core', async () => {
  const db = new FakeDb(); const h = harness(db);
  const out = await h.run('EXACT_G20');
  assert.equal(out.result, 'MIGRATED', JSON.stringify(out));
  assert.deepEqual(h.applied, ['EXACT_G21', 'EXACT_G22']);
  assert.ok(db.readOnlyOnly);
  assert.equal(db.generation, 'EXACT_G22');
  assert.equal(h.logs.length, 3);
  assert.ok(!h.logs.join('\n').match(/@|password|postgres/i));
});

test('RR-02 resume: from EXACT_G21 only G22 is applied (G21 is never run again)', async () => {
  const db = new FakeDb({ generation: 'EXACT_G21' }); const h = harness(db);
  const out = await h.run('EXACT_G21');
  assert.equal(out.result, 'MIGRATED'); assert.deepEqual(h.applied, ['EXACT_G22']);
});

test('RR-03 the normal run refuses every other source WITHOUT applying anything: G19, G21, G22, a G20 ledger over drift, a half-applied ledger', async () => {
  const mk = (generation, extra = {}) => Object.assign(new FakeDb({ generation }), extra);
  const g19 = mk('EXACT_G20'); g19.ledgerOverride = pinsOf('EXACT_G19').map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));
  const drift = mk('EXACT_G20'); drift.rawOverride = rawFor('EXACT_G21');
  const half = mk('EXACT_G20'); half.ledgerOverride = unfinished('EXACT_G21');
  for (const [label, db] of [['G19', g19], ['G21', mk('EXACT_G21')], ['G22', mk('EXACT_G22')], ['drift', drift], ['half-applied', half]]) {
    const h = harness(db); const out = await h.run('EXACT_G20');
    assert.equal(out.result, 'REFUSED', label); assert.equal(out.step, 'precheck', label); assert.deepEqual(h.applied, [], label);
  }
});

test('RR-04 an e-mail collision or no operative OWNER stops BEFORE any migration (nothing applied)', async () => {
  for (const data of [{ collisionGroups: 1 }, { operativeOwners: 0 }]) {
    const h = harness(new FakeDb({ data })); const out = await h.run('EXACT_G20');
    assert.equal(out.result, 'REFUSED'); assert.deepEqual(h.applied, []);
  }
  assert.match((await harness(new FakeDb({ data: { collisionGroups: 1 } })).run('EXACT_G20')).detail, /EMAIL_COLLISION/);
});

test('RR-05 the G21 witness blocks migration 22 when a count changed (AuditLog), a user default changed, or the schema is not EXACT_G21 → RESTORE_REQUIRED, G22 never applied', async () => {
  for (const [label, mutate] of [
    ['audit', (db) => { db.data.counts = { ...db.data.counts, AuditLog: 896 }; }],
    ['default', (db) => { db.data.userDefaults = { total: 6, mustChange: 1, credentialsSet: 0 }; }],
    ['schema', (db) => { db.rawOverride = rawFor('EXACT_G20'); }],
  ]) {
    const db = new FakeDb(); const h = harness(db, { onStep: { EXACT_G21: async (d) => { d.advance('EXACT_G21'); mutate(d); return { ok: true }; } } });
    const out = await h.run('EXACT_G20');
    assert.equal(out.result, 'RESTORE_REQUIRED', label); assert.equal(out.step, 'G21', label); assert.deepEqual(h.applied, ['EXACT_G21'], label);
  }
});

test('RR-06 a collision that appears BETWEEN the steps stops before migration 22: the database stays EXACT_G21 and the outcome says a new plan is needed', async () => {
  const db = new FakeDb();
  const h = harness(db, { onStep: { EXACT_G21: async (d) => { d.advance('EXACT_G21'); d.data.collisionGroups = 1; return { ok: true }; } } });
  const out = await h.run('EXACT_G20');
  assert.equal(out.result, 'REFUSED'); assert.equal(out.step, 'G21-to-G22'); assert.match(out.detail, /EMAIL_COLLISION/); assert.match(out.detail, /new approved plan/);
  assert.deepEqual(h.applied, ['EXACT_G21']); assert.equal(db.generation, 'EXACT_G21');
});

test('RR-07 G22 fails after G21 and the ledger is still exactly EXACT_G21 → RESUMABLE (recognised intermediate state); resuming then completes without G21', async () => {
  const db = new FakeDb();
  const h = harness(db, { onStep: { EXACT_G22: async () => ({ ok: false, detail: 'prisma exited with code 1' }) } });
  const out = await h.run('EXACT_G20');
  assert.equal(out.result, 'RESUMABLE'); assert.equal(out.step, 'G22'); assert.match(out.detail, /exactly EXACT_G21/);
  assert.deepEqual(h.applied, ['EXACT_G21', 'EXACT_G22']); assert.equal(db.generation, 'EXACT_G21');
  const resume = harness(db); // a NEW plan: the same database, EXACT_G21 named explicitly
  const done = await resume.run('EXACT_G21');
  assert.equal(done.result, 'MIGRATED'); assert.deepEqual(resume.applied, ['EXACT_G22']);
});

test('RR-08 G22 fails and Prisma left a failed (unfinished) G22 row → the ledger no longer classifies → RESTORE_REQUIRED (no resolve, no resume)', async () => {
  const db = new FakeDb();
  const failed = [...pinsOf('EXACT_G21').map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false })),
    { migration_name: pinsOf('EXACT_G22')[21].name, checksum: pinsOf('EXACT_G22')[21].sha256, finished: false, rolled_back: false }];
  const h = harness(db, { onStep: { EXACT_G22: async (d) => { d.ledgerOverride = failed; return { ok: false, detail: 'prisma exited with code 1' }; } } });
  const out = await h.run('EXACT_G20');
  assert.equal(out.result, 'RESTORE_REQUIRED'); assert.equal(out.step, 'G22');
  // and a resume plan cannot be built over that ledger either
  const again = await harness(db).run('EXACT_G21');
  assert.equal(again.result, 'REFUSED'); assert.match(again.detail, /LEDGER_UNCLASSIFIED/);
});

test('RR-09 G21 fails before touching the ledger (the database is still exactly EXACT_G20) → REFUSED, nothing applied; a step that cannot even start says so', async () => {
  const a = harness(new FakeDb(), { onStep: { EXACT_G21: async () => ({ ok: false, detail: 'prisma exited with code 1' }) } });
  const out = await a.run('EXACT_G20');
  assert.equal(out.result, 'REFUSED'); assert.equal(out.step, 'G21'); assert.match(out.detail, /still exactly EXACT_G20/);
  const b = harness(new FakeDb(), { onStep: { EXACT_G21: async () => ({ ok: false, started: false, detail: 'prisma could not be started' }) } });
  const nb = await b.run('EXACT_G20');
  assert.equal(nb.result, 'REFUSED'); assert.match(nb.detail, /nothing was applied/);
  // a G21 failure that leaves a failed row cannot be classified → RESTORE_REQUIRED
  const db = new FakeDb(); const c = harness(db, { onStep: { EXACT_G21: async (d) => { d.ledgerOverride = unfinished('EXACT_G21'); return { ok: false, detail: 'prisma exited with code 1' }; } } });
  assert.equal((await c.run('EXACT_G20')).result, 'RESTORE_REQUIRED');
});

test('RR-09b G22 cannot even start after a passed G21 witness (tree changed, prisma missing) → RESUMABLE: the database is provably EXACT_G21; the same on a resume is a plain refusal (nothing applied)', async () => {
  const db = new FakeDb();
  const h = harness(db, { onStep: { EXACT_G22: async () => ({ ok: false, started: false, detail: 'migration payload changed' }) } });
  const out = await h.run('EXACT_G20');
  assert.equal(out.result, 'RESUMABLE'); assert.match(out.detail, /exactly EXACT_G21/); assert.equal(db.generation, 'EXACT_G21');
  const r = new FakeDb({ generation: 'EXACT_G21' });
  const res = await harness(r, { onStep: { EXACT_G22: async () => ({ ok: false, started: false, detail: 'migration payload changed' }) } }).run('EXACT_G21');
  assert.equal(res.result, 'REFUSED'); assert.match(res.detail, /nothing was applied/);
});

test('RR-10 the post-check after G22 blocks on: a missing lower(email) index, a changed AuditLog count, a user default, a non-empty UserAdminOperation → RESTORE_REQUIRED', async () => {
  for (const [label, mutate] of [
    ['index', (d) => { const raw = rawFor('EXACT_G22'); raw.indexes = raw.indexes.filter((x) => x.name !== 'User_email_lower_key'); d.rawOverride = raw; }],
    ['audit', (d) => { d.data.counts = { ...d.data.counts, AuditLog: 900 }; }],
    ['default', (d) => { d.data.userDefaults = { total: 6, mustChange: 0, credentialsSet: 1 }; }],
    ['operations', (d) => { d.data.adminOperations = 3; }],
    ['not unique', (d) => { d.data.lowerIndexDef = 'CREATE INDEX x ON public."User" (lower(email))'; }],
  ]) {
    const db = new FakeDb(); const h = harness(db, { onStep: { EXACT_G22: async (d) => { d.advance('EXACT_G22'); mutate(d); return { ok: true }; } } });
    const out = await h.run('EXACT_G20');
    assert.equal(out.result, 'RESTORE_REQUIRED', label); assert.equal(out.step, 'G22', label);
  }
});

test('RR-11 only EXACT_G20 and EXACT_G21 are initial states; the step runner is never asked for anything but EXACT_G21 / EXACT_G22', async () => {
  for (const bad of ['EXACT_G19', 'EXACT_G22', 'EXACT_G16', '', undefined, 'exact_g20']) {
    const h = harness(new FakeDb()); const out = await h.run(bad);
    assert.equal(out.result, 'REFUSED', String(bad)); assert.deepEqual(h.applied, []);
  }
  const db = new FakeDb(); const h = harness(db); await h.run('EXACT_G20');
  assert.ok(h.applied.every((g) => g === 'EXACT_G21' || g === 'EXACT_G22'));
});
