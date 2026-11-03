// Zero-database tests of pilot-owner-recovery.mjs (OWNER-RECOVERY R1): the OWNER-only, operator-level recovery of the canonical PILOT OWNER's access.
// Run with: node --test scripts/database/pilot-owner-recovery.test.mjs
// Hermetic: synthetic *.invalid URLs, the scripted snapshot database of pilot-g22-fake-db.mjs, an in-memory Prisma stand-in with real rollback semantics, an injected identity proof,
// and the REAL reviewed API modules (temporary-password, password, credentials-epoch, audit, system actor) loaded through the repo-local tsx. The real private PILOT files are never read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as M from './pilot-owner-recovery.mjs';
import { PILOT_ACCOUNTS } from './pilot-bootstrap.mjs';
import { FINGERPRINT, FakeDb, MARKER, SCHEMA } from './pilot-g22-fake-db.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REF = 'pilotsynthref0000001';
const SECRET_URL_PW = 'G22ecretPw';
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://postgres.${REF}:${SECRET_URL_PW}@${HOST}:6543/postgres`;
const OWNER = PILOT_ACCOUNTS[0];
const OTHER_ID = PILOT_ACCOUNTS[1].id;
const ACTOR_ID = '00000000-0000-4000-8000-00000000a001';
const PHRASE = `RECOVER ${OWNER.id.slice(0, 8)}`;
const NOW = new Date('2030-06-01T12:00:00.000Z');
const canonical = await M.loadCanonical();

// ---- the in-memory Prisma stand-in -----------------------------------------------------------------------------------------------------------

function makeWorld({ epoch = null, mustChange = false, ownerActive = true, ownerScopes = [['OWNER', 'COMPANY']], actor = {}, withOwner = true, otherOwners = 0 } = {}) {
  const users = new Map();
  const add = (u) => users.set(u.id, { passwordHash: '$2b$12$' + 'a'.repeat(53), mustChangePassword: false, credentialsChangedAt: null, isActive: true, ...u });
  if (withOwner) add({ id: OWNER.id, name: 'Propietario', email: OWNER.email, isActive: ownerActive, mustChangePassword: mustChange, credentialsChangedAt: epoch });
  for (const a of PILOT_ACCOUNTS.slice(1)) add({ id: a.id, name: a.name, email: a.email });
  add({ id: ACTOR_ID, name: canonical.SYSTEM_ACTOR_NAME, email: canonical.SYSTEM_ACTOR_EMAIL, isActive: false, ...actor });
  const scopes = [];
  if (withOwner) for (const [roleCode, scopeKind] of ownerScopes) scopes.push({ userId: OWNER.id, roleCode, scopeKind });
  scopes.push({ userId: OTHER_ID, roleCode: 'ADMIN', scopeKind: 'COMPANY' });
  for (let i = 0; i < otherOwners; i += 1) { const id = `00000000-0000-4000-9700-0000000009${i}0`; add({ id, name: 'Other', email: `o${i}@pilot.invalid` }); scopes.push({ userId: id, roleCode: 'OWNER', scopeKind: 'COMPANY' }); }
  return { users, scopes, legacy: [], audit: [], uao: [] };
}
const clone = (w) => ({ users: new Map([...w.users].map(([k, v]) => [k, { ...v }])), scopes: w.scopes.map((s) => ({ ...s })), legacy: [...w.legacy], audit: w.audit.map((a) => ({ ...a })), uao: [...w.uao] });

// `failOn`: update | audit | corruptHash | commit (the COMMIT itself fails after the callback finished) | onTxStart (a hook that runs right after BEGIN, e.g. a concurrent change)
function makePrisma(world, { failOn = {}, sql = [], events = [] } = {}) {
  let inTx = false;
  const raw = (strings, values) => {
    const text = strings.join('?').replace(/\s+/g, ' ').trim();
    sql.push(text);
    if (/UserAdminOperation/.test(text)) throw new Error('UserAdminOperation must not be touched');
    if (/pg_advisory_xact_lock/.test(text)) { events.push('advisory'); return [{}]; }
    if (/FROM "User" WHERE id = \?/.test(text) && /FOR NO KEY UPDATE/.test(text)) { events.push('lock-user'); }
    const row = (id) => { const u = world.users.get(id); return u ? [{ id: u.id, name: u.name, email: u.email, isActive: u.isActive, mustChangePassword: u.mustChangePassword, credentialsChangedAt: u.credentialsChangedAt }] : []; };
    if (/SELECT "passwordHash" FROM "User" WHERE id = \?/.test(text)) return world.users.has(values[0]) ? [{ passwordHash: world.users.get(values[0]).passwordHash }] : [];
    if (/FROM "User" WHERE id = \?/.test(text)) return row(values[0]);
    if (/FROM "UserRoleScope" s JOIN "Role" r/.test(text)) return world.scopes.filter((s) => s.userId === values[0]).map((s) => ({ code: s.roleCode, scopeKind: s.scopeKind }));
    if (/count\(DISTINCT u\.id\)/.test(text)) {
      const owners = new Set(world.scopes.filter((s) => s.roleCode === 'OWNER' && s.scopeKind === 'COMPANY' && world.users.get(s.userId)?.isActive).map((s) => s.userId));
      return [{ n: String(owners.size) }];
    }
    if (/FROM "UserRoleScope" WHERE "userId" = \?/.test(text)) return [{ n: String(world.scopes.filter((s) => s.userId === values[0]).length) }];
    if (/FROM "UserBranchRole" WHERE "userId" = \?/.test(text)) return [{ n: String(world.legacy.filter((s) => s.userId === values[0]).length) }];
    if (/FROM "AuditLog" WHERE action = \?/.test(text)) return [{ n: String(world.audit.filter((a) => a.action === values[0] && a.entityId === values[1]).length) }];
    throw new Error(`unexpected SQL in the fake: ${text.slice(0, 90)}`);
  };
  const db = {
    $queryRaw: async (strings, ...values) => raw(strings, values),
    $executeRaw: async (strings, ...values) => { raw(strings, values); return 1; },
    user: {
      update: async ({ where, data }) => {
        events.push('update');
        if (failOn.update) throw new Error('injected update failure');
        const u = world.users.get(where.id);
        Object.assign(u, data, failOn.corruptHash ? { passwordHash: '$2b$12$' + 'z'.repeat(53) } : {});
        return { id: u.id };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        events.push('audit');
        if (failOn.audit) throw new Error('injected audit failure');
        world.audit.push({ id: `a${world.audit.length}`, ...data });
        return { id: 'x' };
      },
    },
  };
  return {
    ...db,
    $disconnect: async () => {},
    $transaction: async (fn) => {
      const before = clone(world);
      events.push('begin');
      failOn.onTxStart?.(world);
      let done = false;
      try {
        const out = await fn(db);
        done = true;
        if (failOn.commit) throw new Error('connection lost at COMMIT');
        events.push('commit');
        return out;
      } catch (e) {
        if (!done || !failOn.commit) { world.users = before.users; world.scopes = before.scopes; world.audit = before.audit; events.push('rollback'); }
        throw e;
      }
    },
  };
}

// ---- the dependency bundle ------------------------------------------------------------------------------------------------------------------

function harness({ world = makeWorld(), db = new FakeDb({ generation: 'EXACT_G22' }), failOn = {}, tty = { stdin: true, stdout: true }, typed = PHRASE, identity = 0, url = URL_TEXT, canonicalOverride = {}, env = {}, operator = 'operator-os-user' } = {}) {
  const lines = []; const errors = []; const sql = []; const events = []; const shown = []; const reads = { url: 0 };
  const prisma = makePrisma(world, { failOn, sql, events });
  const deps = {
    urlFile: '/synthetic/pilot-database-url', env, readUrlFile: () => { reads.url += 1; return { ok: true, text: `${url}\n` }; },
    proveIdentity: async () => identity, createClient: () => db.createClient(), requireTls: false,
    createPrisma: async () => prisma, loadCanonical: async () => ({ ...canonical, ...canonicalOverride }),
    schema: SCHEMA, fingerprint: FINGERPRINT,
    moduleDir: HERE, apiDir: path.join(REPO, 'api'), repoDir: REPO,
    isTTY: tty, prompt: async (q) => { events.push('prompt'); lines.push(`PROMPT ${q}`); return typed; },
    showSecret: (text) => { events.push('secret'); shown.push(text); },
    now: () => NOW, osUser: () => operator, log: (l) => lines.push(l), error: (l) => errors.push(l),
  };
  return { deps, lines, errors, sql, events, shown, world, db, prisma, reads };
}
const DRY = (over = {}) => ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--target-user=${over.user ?? OWNER.id}`];
const EXEC = (plan, over = {}) => ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${over.ref ?? REF}`, `--target-user=${over.user ?? OWNER.id}`, `--plan=${plan}`];
async function planOf(h) { const code = await M.main(DRY(), h.deps); assert.equal(code, 0, h.errors.join('|')); return h.lines.find((l) => l.startsWith('  PLAN_DIGEST='))?.slice('  PLAN_DIGEST='.length); }
const result = (h) => [...h.lines, ...h.errors].filter((l) => l.startsWith('PILOT_OWNER_RECOVERY_RESULT=')).at(-1)?.slice('PILOT_OWNER_RECOVERY_RESULT='.length);
const everything = (h) => [...h.lines, ...h.errors, ...h.sql].join('\n');

// ---- arguments ------------------------------------------------------------------------------------------------------------------------------

test('OR-01 arguments: pilot only, exactly the documented flags; no URL, host, DATABASE_URL or alias can name another destination', () => {
  assert.equal(M.parseCliArgs(DRY()).ok, true);
  assert.equal(M.parseCliArgs(EXEC('a'.repeat(64))).ok, true);
  for (const bad of [
    ['--target=test', '--dry-run', `--marker-id=${MARKER}`, `--target-user=${OWNER.id}`],
    [...DRY(), '--database-url=postgresql://x'], [...DRY(), '--host=db.example.com'], [...DRY(), '--url=postgresql://x'], DRY().slice(0, 3),
    ['--target=pilot', '--dry-run', '--execute', `--marker-id=${MARKER}`, `--target-user=${OWNER.id}`],
    ['--target=pilot', '--dry-run', `--marker-id=not-a-uuid`, `--target-user=${OWNER.id}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--target-user=not-a-uuid`],
    ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--target-user=${OWNER.id}`, `--plan=${'a'.repeat(64)}`],
    ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`, `--target-user=${OWNER.id}`, '--plan=short'],
    [...DRY(), 'positional'],
  ]) assert.equal(M.parseCliArgs(bad).ok, false, JSON.stringify(bad).slice(0, 100));
});

test('OR-02 the source never reads DATABASE_URL, uses the process environment ONLY to refuse PGOPTIONS (the single `env: process.env` default), never writes a password with raw SQL, and never mentions UserAdminOperation or USER_PASSWORD_RESET outside comments', () => {
  const src = nodeFs.readFileSync(path.join(HERE, 'pilot-owner-recovery.mjs'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(src, /DATABASE_URL/);
  assert.equal((src.match(/process\.env/g) ?? []).length, 1, 'exactly one reference to the process environment');
  assert.match(src, /^\s*env: process\.env,$/m);
  assert.doesNotMatch(src, /UPDATE\s+"User"|"passwordHash"\s*=/i);
  assert.doesNotMatch(src, /userAdminOperation|UserAdminOperation|USER_PASSWORD_RESET/);
  assert.match(src, /USER_PASSWORD_RECOVERY/);
});

// ---- dry-run ---------------------------------------------------------------------------------------------------------------------------------

test('OR-03 dry-run: validates identity, EXACT_G22, target and system actor, writes NOTHING, prints a PLAN_DIGEST and no secret', async () => {
  const h = harness();
  const code = await M.main(DRY(), h.deps);
  assert.equal(code, 0, h.errors.join('|'));
  assert.equal(result(h), 'DRY_RUN_OK');
  assert.match(h.lines.join('\n'), /PLAN_DIGEST=[0-9a-f]{64}/);
  assert.ok(!h.events.includes('begin'), 'no transaction');
  assert.ok(!h.sql.some((s) => /\b(UPDATE|INSERT|DELETE)\b/i.test(s)));
  assert.equal(h.db.readOnlyOnly, true);
  assert.deepEqual(h.shown, []); assert.equal(h.world.audit.length, 0);
  for (const leak of [SECRET_URL_PW, HOST, REF, URL_TEXT, OWNER.email]) assert.ok(!everything(h).includes(leak), `leaked ${leak.slice(0, 6)}`);
});

test('OR-04 the target must be exactly the canonical PILOT OWNER id', async () => {
  const h = harness();
  assert.equal(await M.main(DRY({ user: OTHER_ID }), h.deps), 1);
  assert.equal(result(h), 'REFUSED'); assert.ok(!h.events.includes('begin'));
});

test('OR-05 a missing, inactive or non-OWNER/COMPANY target is refused (read-only, before any lock)', async () => {
  for (const w of [makeWorld({ withOwner: false }), makeWorld({ ownerActive: false }), makeWorld({ ownerScopes: [['ADMIN', 'COMPANY']] }), makeWorld({ ownerScopes: [['OWNER', 'LOCATION']] }), makeWorld({ ownerScopes: [] })]) {
    const h = harness({ world: w });
    assert.equal(await M.main(DRY(), h.deps), 1);
    assert.equal(result(h), 'REFUSED');
  }
});

test('OR-06 a database that is not EXACT_G22 (G20, G21, a drifted ledger) is refused', async () => {
  for (const db of [new FakeDb({ generation: 'EXACT_G20' }), new FakeDb({ generation: 'EXACT_G21' }), new FakeDb({ generation: 'EXACT_G22', ledger: [] })]) {
    const h = harness({ db });
    assert.equal(await M.main(DRY(), h.deps), 1);
    assert.equal(result(h), 'REFUSED');
  }
});

test('OR-07 a wrong marker (snapshot or identity proof) and a wrong project ref are refused', async () => {
  const marker = harness({ db: new FakeDb({ generation: 'EXACT_G22', marker: { marker_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', environment: 'pilot' } }) });
  assert.equal(await M.main(DRY(), marker.deps), 1);
  const proof = harness({ identity: 1 });
  assert.equal(await M.main(DRY(), proof.deps), 1); assert.match(proof.errors.join('\n'), /identity/i);
  const h = harness();
  const plan = await planOf(h);
  const wrongRef = harness();
  assert.equal(await M.main(EXEC(plan, { ref: 'otherref000000000001' }), wrongRef.deps), 1);
  assert.ok(!wrongRef.events.includes('begin') && wrongRef.shown.length === 0);
});

test('OR-08 an absent or invalid system actor (active, with a scope, wrong name) is refused: no AuditLog author, no recovery', async () => {
  const absent = makeWorld(); absent.users.delete(ACTOR_ID);
  const active = makeWorld({ actor: { isActive: true } });
  const scoped = makeWorld(); scoped.scopes.push({ userId: ACTOR_ID, roleCode: 'ADMIN', scopeKind: 'COMPANY' });
  const renamed = makeWorld({ actor: { name: 'Someone else' } });
  for (const w of [absent, active, scoped, renamed]) {
    const h = harness({ world: w });
    assert.equal(await M.main(DRY(), h.deps), 1);
    assert.equal(result(h), 'REFUSED');
  }
});

// ---- execute gates ---------------------------------------------------------------------------------------------------------------------------

test('OR-09 execute needs a TTY on stdin AND stdout: no prompt, no transaction, no secret', async () => {
  for (const tty of [{ stdin: false, stdout: true }, { stdin: true, stdout: false }, { stdin: false, stdout: false }]) {
    const h = harness({ tty });
    const plan = await planOf(harness());
    assert.equal(await M.main(EXEC(plan), h.deps), 1);
    assert.ok(!h.events.includes('prompt') && !h.events.includes('begin') && h.shown.length === 0);
  }
});

test('OR-10 the human confirmation must be exactly "RECOVER <first 8 of the target id>": anything else writes nothing', async () => {
  for (const typed of ['yes', 'y', 'RECOVER', 'RECOVER 12345678', PHRASE.toLowerCase(), `${PHRASE} `, '']) {
    const h = harness({ typed });
    const plan = await planOf(harness());
    assert.equal(await M.main(EXEC(plan), h.deps), 1, typed);
    assert.ok(!h.events.includes('begin') && h.shown.length === 0 && h.world.audit.length === 0, typed);
  }
});

test('OR-11 a wrong or stale PLAN_DIGEST is refused before the confirmation and before any lock', async () => {
  const h = harness();
  assert.equal(await M.main(EXEC('0'.repeat(64)), h.deps), 1);
  assert.match(h.errors.join('\n'), /PLAN_BINDING_MISMATCH/);
  assert.ok(!h.events.includes('prompt') && !h.events.includes('begin'));
});

// ---- the transaction -------------------------------------------------------------------------------------------------------------------------

test('OR-12 happy path: one transaction (advisory lock, user lock, update, one AuditLog), mustChangePassword = true, a new epoch, the secret is shown once and only AFTER the commit', async () => {
  const h = harness();
  const plan = await planOf(h);
  const code = await M.main(EXEC(plan), h.deps);
  assert.equal(code, 0, h.errors.join('|'));
  assert.equal(result(h), 'RECOVERED');
  const order = h.events.filter((e) => ['advisory', 'lock-user', 'update', 'audit', 'commit', 'secret', 'prompt', 'begin'].includes(e));
  assert.deepEqual(order, ['prompt', 'begin', 'advisory', 'lock-user', 'update', 'audit', 'commit', 'secret']);
  const u = h.world.users.get(OWNER.id);
  assert.equal(u.mustChangePassword, true);
  assert.ok(u.credentialsChangedAt instanceof Date && u.credentialsChangedAt.getTime() === NOW.getTime());
  assert.equal(h.shown.length, 1);
  assert.match(h.shown[0], canonical.TEMPORARY_PASSWORD_PATTERN, 'the shown secret is a U2 temporary password');
  assert.equal(await canonical.verifyPassword(h.shown[0], u.passwordHash), true, 'the stored hash verifies the shown password');
  assert.match(u.passwordHash, /^\$2[aby]\$12\$/, 'the runtime bcrypt cost');
});

test('OR-13 audit semantics: the technical actor, USER_PASSWORD_RECOVERY, OPERATOR_RECOVERY, no secret and no e-mail; exactly one row', async () => {
  const h = harness();
  const plan = await planOf(h);
  await M.main(EXEC(plan), h.deps);
  assert.equal(h.world.audit.length, 1);
  const a = h.world.audit[0];
  assert.equal(a.userId, ACTOR_ID); assert.equal(a.branchId, null); assert.equal(a.action, 'USER_PASSWORD_RECOVERY'); assert.equal(a.entityType, 'User'); assert.equal(a.entityId, OWNER.id);
  assert.deepEqual(Object.keys(a.before).sort(), ['credentialsChangedAt', 'mustChangePassword']);
  assert.equal(a.after.mustChangePassword, true);
  assert.equal(a.after.recovery.channel, 'OPERATOR_RECOVERY');
  assert.equal(a.after.recovery.tool, 'pilot-owner-recovery'); assert.match(a.after.recovery.toolSha256, /^[0-9a-f]{64}$/); assert.equal(a.after.recovery.operator, 'operator-os-user'); assert.equal(a.after.recovery.planDigest, plan);
  const json = JSON.stringify(a);
  assert.doesNotMatch(json, /@|\$2[aby]\$|[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-/);
  assert.notEqual(a.action, 'USER_PASSWORD_RESET');
});

test('OR-14 nothing else changes: other users, the target\'s e-mail / scopes / active flag, and no UserAdminOperation row or statement', async () => {
  const h = harness();
  const before = clone(h.world);
  const plan = await planOf(h);
  await M.main(EXEC(plan), h.deps);
  for (const [id, u] of before.users) if (id !== OWNER.id) assert.deepEqual(h.world.users.get(id), u, id);
  const t = h.world.users.get(OWNER.id);
  assert.equal(t.email, OWNER.email); assert.equal(t.isActive, true); assert.equal(t.name, 'Propietario');
  assert.deepEqual(h.world.scopes, before.scopes);
  assert.deepEqual(h.world.uao, []);
  assert.ok(!h.sql.some((s) => /UserAdminOperation/.test(s)));
});

test('OR-15 failure injection: a failing update, a failing AuditLog, a hash that does not verify after the write, each rolls EVERYTHING back and shows no secret', async () => {
  for (const failOn of [{ update: true }, { audit: true }, { corruptHash: true }]) {
    const h = harness({ failOn });
    const before = clone(h.world);
    const plan = await planOf(h);
    const code = await M.main(EXEC(plan), h.deps);
    assert.equal(code, 1, JSON.stringify(failOn));
    assert.equal(result(h), 'ROLLED_BACK', JSON.stringify(failOn));
    assert.deepEqual([...h.world.users], [...before.users], JSON.stringify(failOn));
    assert.equal(h.world.audit.length, 0, JSON.stringify(failOn));
    assert.deepEqual(h.shown, [], JSON.stringify(failOn));
    assert.ok(h.events.includes('rollback'));
  }
});

test('OR-16 an ambiguous COMMIT is UNKNOWN_COMMIT: the secret is NOT shown and a new dry-run is required', async () => {
  const h = harness({ failOn: { commit: true } });
  const plan = await planOf(h);
  assert.equal(await M.main(EXEC(plan), h.deps), 1);
  assert.equal(result(h), 'UNKNOWN_COMMIT');
  assert.deepEqual(h.shown, []);
  assert.match(h.errors.join('\n'), /new --dry-run/i);
});

test('OR-17 a concurrent credentials change between the observation and the lock (epoch compare-and-swap) aborts inside the transaction', async () => {
  const h = harness({ failOn: { onTxStart: (w) => { w.users.get(OWNER.id).credentialsChangedAt = new Date('2030-05-01T00:00:00.000Z'); } } });
  const before = clone(h.world);
  const plan = await planOf(h);
  assert.equal(await M.main(EXEC(plan), h.deps), 1);
  assert.equal(result(h), 'STATE_CHANGED');
  assert.ok(!h.events.includes('update') && !h.events.includes('audit'));
  assert.equal(h.world.audit.length, 0); assert.deepEqual(h.shown, []);
  assert.equal(h.world.users.get(OWNER.id).mustChangePassword, before.users.get(OWNER.id).mustChangePassword);
});

test('OR-18 an owner who stopped being an operative OWNER (or the target\'s role) between observation and lock aborts', async () => {
  const h = harness({ failOn: { onTxStart: (w) => { w.scopes = w.scopes.filter((s) => s.userId !== OWNER.id); } } });
  const plan = await planOf(h);
  assert.equal(await M.main(EXEC(plan), h.deps), 1);
  assert.equal(result(h), 'STATE_CHANGED'); assert.deepEqual(h.shown, []); assert.equal(h.world.audit.length, 0);
});

test('OR-19 replay: after a successful recovery the SAME plan cannot be reused (the observed epoch is in the digest)', async () => {
  const h = harness();
  const plan = await planOf(h);
  assert.equal(await M.main(EXEC(plan), h.deps), 0);
  const second = { ...h, events: [], shown: [] };
  const before = clone(h.world);
  const again = harness({ world: h.world });
  assert.equal(await M.main(EXEC(plan), again.deps), 1);
  assert.match(again.errors.join('\n'), /PLAN_BINDING_MISMATCH/);
  assert.deepEqual(again.shown, []); assert.equal(h.world.audit.length, 1); assert.deepEqual([...h.world.users], [...before.users]);
  void second;
});

test('OR-20 the epoch is strictly monotonic (nextCredentialsEpoch): from NULL, from a past epoch and from an epoch in the future (clock skew)', async () => {
  for (const epoch of [null, new Date('2030-01-01T00:00:00.000Z'), new Date('2031-01-01T00:00:00.000Z')]) {
    const h = harness({ world: makeWorld({ epoch }) });
    const plan = await planOf(h);
    assert.equal(await M.main(EXEC(plan), h.deps), 0);
    const next = h.world.users.get(OWNER.id).credentialsChangedAt;
    assert.ok(next > (epoch ?? new Date(0)), String(epoch));
    assert.equal(next.getTime(), epoch === null ? NOW.getTime() : Math.max(NOW.getTime(), epoch.getTime() + 1));
  }
});

test('OR-21 a pending recovery (mustChangePassword already true) is allowed but the digest differs from a fresh one, so the plan is explicit', async () => {
  const fresh = await planOf(harness());
  const pending = await planOf(harness({ world: makeWorld({ epoch: new Date('2030-05-01T00:00:00.000Z'), mustChange: true }) }));
  assert.notEqual(fresh, pending);
});

// ---- secrets -----------------------------------------------------------------------------------------------------------------------------------

test('OR-22 no secret anywhere: not the temporary password, not a bcrypt hash, not a token or URL, in any log line, error line or SQL text, before or after the commit', async () => {
  const h = harness();
  const plan = await planOf(h);
  await M.main(EXEC(plan), h.deps);
  const secret = h.shown[0];
  const all = everything(h);
  assert.ok(secret.length > 10 && !all.includes(secret));
  assert.doesNotMatch(all, /\$2[aby]\$\d\d\$/);
  assert.doesNotMatch(all, /eyJ[A-Za-z0-9_-]{10,}\./);
  assert.doesNotMatch(all, /[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}-[A-HJ-NP-Za-km-z2-9]{4}/);
  for (const leak of [SECRET_URL_PW, HOST, REF, URL_TEXT, OWNER.email, os.homedir()]) assert.ok(!all.includes(leak), `leaked ${leak.slice(0, 6)}`);
});

test('OR-23 the secret is never shown on any failing path (every refusal, rollback and abort)', async () => {
  const cases = [{ failOn: { update: true } }, { failOn: { audit: true } }, { failOn: { corruptHash: true } }, { failOn: { commit: true } }, { typed: 'nope' }, { tty: { stdin: false, stdout: false } }, { world: makeWorld({ ownerActive: false }) }];
  for (const over of cases) {
    const h = harness(over);
    const plan = await planOf(harness());
    await M.main(EXEC(plan), h.deps);
    assert.deepEqual(h.shown, [], JSON.stringify(Object.keys(over)));
  }
});

test('OR-24 the plan digest binds the tooling: any change of the bound target, observed epoch or tooling changes the digest', async () => {
  const a = M.buildPlan({ targetBinding: { x: 1 }, toolingBinding: { y: 1 }, schemaDigest: 'a'.repeat(64), target: { id: OWNER.id, epoch: null, mustChangePassword: false }, actorId: ACTOR_ID });
  const same = M.buildPlan({ targetBinding: { x: 1 }, toolingBinding: { y: 1 }, schemaDigest: 'a'.repeat(64), target: { id: OWNER.id, epoch: null, mustChangePassword: false }, actorId: ACTOR_ID });
  assert.equal(a.digest, same.digest);
  for (const change of [{ targetBinding: { x: 2 } }, { toolingBinding: { y: 2 } }, { schemaDigest: 'b'.repeat(64) }, { target: { id: OWNER.id, epoch: 5, mustChangePassword: false } }, { target: { id: OWNER.id, epoch: null, mustChangePassword: true } }, { actorId: OTHER_ID }]) {
    const b = M.buildPlan({ targetBinding: { x: 1 }, toolingBinding: { y: 1 }, schemaDigest: 'a'.repeat(64), target: { id: OWNER.id, epoch: null, mustChangePassword: false }, actorId: ACTOR_ID, ...change });
    assert.notEqual(a.digest, b.digest, JSON.stringify(change));
  }
});

test('OR-25 the tooling binding covers the script and every API module it imports (password, temporary password, epoch, audit, system actor) plus the CA', async () => {
  const names = M.RECOVERY_TOOLING_FILES.map((f) => f.path);
  for (const must of ['pilot-owner-recovery.mjs', 'api/src/modules/auth/password.ts', 'api/src/modules/auth/temporary-password.ts', 'api/src/modules/auth/credentials-epoch.ts', 'api/src/shared/audit.ts', 'api/src/modules/audit/system-actor.service.ts', 'scripts/certs/supabase-prod-ca-2021.crt']) assert.ok(names.includes(must), must);
});

// ---- code-review findings (R1 review) ----------------------------------------------------------------------------------------------------------

test('OR-26 PGOPTIONS in the environment can change the session (search_path, read-only, ...): both modes refuse BEFORE reading the private URL or touching anything', async () => {
  for (const mode of ['dry', 'exec']) {
    const h = harness({ env: { PGOPTIONS: '-c search_path=evil' } });
    const plan = mode === 'dry' ? null : await planOf(harness());
    const code = await M.main(mode === 'dry' ? DRY() : EXEC(plan), h.deps);
    assert.equal(code, 1, mode); assert.equal(result(h), 'REFUSED', mode);
    assert.match(h.errors.join('\n'), /PGOPTIONS/);
    assert.equal(h.reads.url, 0, `${mode}: the private URL file was not even read`);
    assert.ok(!h.events.includes('begin') && h.shown.length === 0, mode);
    assert.ok(!everything(h).includes('search_path=evil'), 'the value is never echoed');
  }
});

test('OR-27 the real defaults carry the environment through to the identity proof (the PGOPTIONS guard of pilot-marker must not be skippable by an undefined env)', () => {
  const src = nodeFs.readFileSync(path.join(HERE, 'pilot-owner-recovery.mjs'), 'utf8');
  assert.match(src, /const defaultDeps = \{[\s\S]*?\n  env: process\.env,/);
});

test('OR-28 the operating-system user that lands in the AuditLog JSON is normalised: a safe short login is kept, anything else (quotes, control characters, newlines, shell syntax, an e-mail, too long, not a string) becomes "unknown"', async () => {
  const cases = [['victor.m-1_x', 'victor.m-1_x'], ['ev"il', 'unknown'], ['a\nb', 'unknown'], ['x\u0000y', 'unknown'], ['$(id)', 'unknown'], ['name@domain.com', 'unknown'], ['x'.repeat(65), 'unknown'], ['', 'unknown'], [null, 'unknown'], [42, 'unknown'], ['x'.repeat(64), 'x'.repeat(64)]];
  for (const [input, expected] of cases) {
    const h = harness({ operator: input });
    const plan = await planOf(h);
    assert.equal(await M.main(EXEC(plan), h.deps), 0, String(input).slice(0, 12));
    assert.equal(h.world.audit[0].after.recovery.operator, expected, JSON.stringify(input)?.slice(0, 20));
  }
});
