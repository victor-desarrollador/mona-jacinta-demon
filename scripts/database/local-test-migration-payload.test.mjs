// Zero-database unit tests for scripts/database/local-test-migration-payload.mjs
// (U1 / R3-T): the LOCAL_TEST-only migration payload G11 (the seven PILOT-approved
// pins of pilot-migrate.mjs plus the two reviewed R3 migrations plus the reviewed
// cash-exit migration 10 plus the reviewed cash-reversal migration 11), its exact-tree
// verifier, the P21 base projection G8 (migrations 1–8) and the private staged copy
// of G8 that prisma.local-test-p21.config.ts points Prisma at.
// Run with: node --test scripts/database/local-test-migration-payload.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
// Looked up on the namespace: a missing export is an assertion failure, never a link error.
import * as payloadModule from './local-test-migration-payload.mjs';
import { API_DIR, APPROVED_MIGRATION_PAYLOAD, verifyMigrationPayload } from './pilot-migrate.mjs';

const SOURCE = readFileSync(new URL('./local-test-migration-payload.mjs', import.meta.url), 'utf8');
const PILOT_SOURCE = readFileSync(new URL('./pilot-migrate.mjs', import.meta.url), 'utf8');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'local-test-payload-test-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const R3_A2 = '20261016120000_r3_proportional_checkout';
const R3_ATTEMPTS = '20261016130000_r3_checkout_attempts';
const CASH_MOVEMENT = '20261018120000_cash_movement_withdrawals_expenses';
const MIG8 = { name: R3_A2, bytes: 15340, sha256: '217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6' };
const MIG9 = { name: R3_ATTEMPTS, bytes: 35290, sha256: '076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148' };
const MIG10 = { name: CASH_MOVEMENT, bytes: 2732, sha256: 'e37149442d1fb82ec87877e7b3e1f2e4311b36a9d47d314a3fd1843702c5adf9' };
const CASH_REVERSAL = '20261018180000_cash_movement_reversals';
const MIG11 = { name: CASH_REVERSAL, bytes: 3366, sha256: 'd638559da376f5c4fb1f71136027c0af426906b8b8a2c582f388e73ffd1b3770' };
const CARD_CREDIT = '20261021120000_r3_card_credit';
const MIG12 = { name: CARD_CREDIT, bytes: 11413, sha256: 'ccec6685120cc9236c5c95a57f2922dc5bbe09cf759ff21b4c9a3635d893f6be' };
const WAREHOUSE = '20261021130000_warehouse_stock_adjustment';
const MIG13 = { name: WAREHOUSE, bytes: 3457, sha256: '819d669933639173e1b21879791c14eb3cced33c0d8417ca30dd07800fb252c0' };
const QR = '20261021140000_r3_qr';
const MIG14 = { name: QR, bytes: 13048, sha256: '32ad30fc0b0aa847d1393ba1fb77419a286470e616973c6bd48de97e6192104a' };

const fn = (name) => {
  const value = payloadModule[name];
  assert.equal(typeof value, 'function', `${name} must be exported`);
  return value;
};
const G11 = () => {
  assert.ok(payloadModule.LOCAL_TEST_MIGRATION_PAYLOAD, 'LOCAL_TEST_MIGRATION_PAYLOAD must be exported');
  return payloadModule.LOCAL_TEST_MIGRATION_PAYLOAD;
};
const G8 = () => {
  assert.ok(payloadModule.LOCAL_TEST_P21_BASE_PAYLOAD, 'LOCAL_TEST_P21_BASE_PAYLOAD must be exported');
  return payloadModule.LOCAL_TEST_P21_BASE_PAYLOAD;
};

// A byte-exact copy of the real reviewed tree (all eleven migrations + lock) under a fake api/.
function fakeApi(names = readdirSync(path.join(API_DIR, 'prisma', 'migrations'))) {
  const root = mkdtempSync(path.join(TMP, 'api-'));
  const from = path.join(API_DIR, 'prisma', 'migrations');
  const to = path.join(root, 'prisma', 'migrations');
  mkdirSync(to, { recursive: true });
  for (const name of names) cpSync(path.join(from, name), path.join(to, name), { recursive: true });
  return root;
}
const migDir = (api) => path.join(api, 'prisma', 'migrations');
const sqlOf = (api, name) => path.join(migDir(api), name, 'migration.sql');
const flipByte = (file) => {
  const bytes = readFileSync(file);
  bytes[bytes.length - 2] ^= 0x01;
  writeFileSync(file, bytes);
};

// --- pins -------------------------------------------------------------------------------------

test('U1-PIN-01 the two R3 pins are the exact reviewed metadata of migrations 8 and 9', () => {
  const pins = payloadModule.R3_MIGRATION_PINS;
  assert.ok(Array.isArray(pins) && Object.isFrozen(pins), 'R3_MIGRATION_PINS must be a frozen array');
  assert.deepEqual(pins.map((p) => ({ ...p })), [MIG8, MIG9]);
  for (const p of pins) assert.ok(Object.isFrozen(p));
});

test('U1-PIN-01b the cash-exit pin is the exact reviewed metadata of migration 10', () => {
  const pins = payloadModule.CASH_MOVEMENT_MIGRATION_PINS;
  assert.ok(Array.isArray(pins) && Object.isFrozen(pins), 'CASH_MOVEMENT_MIGRATION_PINS must be a frozen array');
  assert.deepEqual(pins.map((p) => ({ ...p })), [MIG10]);
  for (const p of pins) assert.ok(Object.isFrozen(p));
});

test('U1-PIN-01c the cash-reversal pin is the exact reviewed metadata of migration 11', () => {
  const pins = payloadModule.CASH_MOVEMENT_REVERSAL_MIGRATION_PINS;
  assert.ok(Array.isArray(pins) && Object.isFrozen(pins), 'CASH_MOVEMENT_REVERSAL_MIGRATION_PINS must be a frozen array');
  assert.deepEqual(pins.map((p) => ({ ...p })), [MIG11]);
  for (const p of pins) assert.ok(Object.isFrozen(p));
});

test('U1-PIN-01d the card-credit pin is the exact reviewed metadata of migration 12', () => {
  const pins = payloadModule.CARD_CREDIT_MIGRATION_PINS;
  assert.ok(Array.isArray(pins) && Object.isFrozen(pins), 'CARD_CREDIT_MIGRATION_PINS must be a frozen array');
  assert.deepEqual(pins.map((p) => ({ ...p })), [MIG12]);
  for (const p of pins) assert.ok(Object.isFrozen(p));
});

test('U1-PIN-01f the QR pin is the exact reviewed metadata of migration 14', () => {
  const pins = payloadModule.QR_MIGRATION_PINS;
  assert.ok(Array.isArray(pins) && Object.isFrozen(pins), 'QR_MIGRATION_PINS must be a frozen array');
  assert.deepEqual(pins.map((p) => ({ ...p })), [MIG14]);
  for (const p of pins) assert.ok(Object.isFrozen(p));
});

test('U1-PIN-01e the warehouse pin is the exact reviewed metadata of migration 13', () => {
  const pins = payloadModule.WAREHOUSE_MIGRATION_PINS;
  assert.ok(Array.isArray(pins) && Object.isFrozen(pins), 'WAREHOUSE_MIGRATION_PINS must be a frozen array');
  assert.deepEqual(pins.map((p) => ({ ...p })), [MIG13]);
  for (const p of pins) assert.ok(Object.isFrozen(p));
});

test('U1-PIN-02 the pins equal the committed bytes on disk (size and SHA-256), file by file', () => {
  for (const m of [MIG8, MIG9, MIG10, MIG11, MIG12, MIG13, MIG14]) {
    const bytes = readFileSync(sqlOf(API_DIR, m.name));
    assert.equal(bytes.length, m.bytes, m.name);
    assert.equal(sha(bytes), m.sha256, m.name);
  }
});

test('U1-PIN-03 the LOCAL_TEST payload IS the shared PILOT payload (same object, never re-typed): mig 1–7 + 8 + 9 + 10 + 11 + 12 + 13 + 14, frozen; same lock', () => {
  const g9 = G11();
  assert.ok(Object.isFrozen(g9) && Object.isFrozen(g9.migrations));
  assert.equal(g9.migrations.length, 14);
  // G14 cut-over: pilot-migrate.mjs approves exactly G14, so LOCAL_TEST and PILOT share ONE payload.
  assert.equal(g9, APPROVED_MIGRATION_PAYLOAD, 'the LOCAL_TEST payload is the shared payload object');
  assert.deepEqual(g9.migrations.slice(7).map((m) => ({ ...m })), [MIG8, MIG9, MIG10, MIG11, MIG12, MIG13, MIG14]);
  const names = g9.migrations.map((m) => m.name);
  assert.deepEqual([...names].sort(), names);
  assert.equal(new Set(names).size, 14);
  assert.equal(g9.lock, APPROVED_MIGRATION_PAYLOAD.lock);
});

test('U1-PIN-04 G8 (the P21 base) is exactly the first eight entries of G11: migration 9 is absent', () => {
  const g8 = G8();
  assert.ok(Object.isFrozen(g8) && Object.isFrozen(g8.migrations));
  assert.deepEqual(g8.migrations, G11().migrations.slice(0, 8));
  assert.ok(!g8.migrations.some((m) => m.name === R3_ATTEMPTS));
  assert.equal(g8.lock, G11().lock);
});

test('U1-PIN-05 no digest is typed here: every pin comes from the shared literal list (pilot-migration-states.mjs via pilot-migrate.mjs)', () => {
  assert.equal((SOURCE.match(/[0-9a-f]{64}/g) ?? []).length, 0);
  assert.doesNotMatch(SOURCE, /readdir\(|createHash|\bglob(Sync)?\b|process\.|import\(|require\(/);
});

// --- PILOT and LOCAL_TEST share one exact payload (E) ----------------------------------------

test('U1-PILOT-01 pilot-migrate approves exactly the fourteen shared pins and the real G14 tree verifies for it', () => {
  assert.equal(APPROVED_MIGRATION_PAYLOAD.migrations.length, 14);
  const real = verifyMigrationPayload(API_DIR);
  assert.equal(real.ok, true, real.reason);
});

test('U1-PILOT-02 pilot-migrate.mjs never imports or names the LOCAL_TEST payload; the LOCAL_TEST module imports nothing PILOT-capable', () => {
  assert.doesNotMatch(PILOT_SOURCE, /local-test-migration-payload|LOCAL_TEST_MIGRATION_PAYLOAD|R3_MIGRATION_PINS/);
  const specifiers = [...SOURCE.matchAll(/\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2]);
  for (const s of specifiers) assert.ok(['node:fs', 'node:path', './pilot-migrate.mjs'].includes(s), `unexpected import ${s}`);
  assert.doesNotMatch(SOURCE, /pilot-marker|pilot-backup|pilot-launch|PILOT_DATABASE_URL|\bmain\s*\(|process\.env/);
  // the only things borrowed from pilot-migrate are the shared G11 payload and the hardened single-file reader
  const fromPilot = SOURCE.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/pilot-migrate\.mjs'/)?.[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
  assert.deepEqual(fromPilot, ['APPROVED_MIGRATION_PAYLOAD', 'readPinned']);
});

// --- the exact-tree verifier (A + D) ----------------------------------------------------------

test('U1-VER-01 the real reviewed tree verifies as G14: fourteen migrations with their pinned digests and the pinned lock', () => {
  const r = fn('verifyLocalTestMigrationPayload')(API_DIR);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.migrations.map((m) => [m.name, m.sha256]), G11().migrations.map((m) => [m.name, m.sha256]));
  assert.deepEqual(r.lock, { sha256: APPROVED_MIGRATION_PAYLOAD.lock.sha256, provider: 'postgresql' });
});

const G10_DENY = {
  'D01 migration 9 one byte changed (same size)': [(api) => flipByte(sqlOf(api, R3_ATTEMPTS)), /r3_checkout_attempts\/migration\.sql does not match its approved SHA-256/],
  'D02 migration 8 one byte changed (same size)': [(api) => flipByte(sqlOf(api, R3_A2)), /r3_proportional_checkout\/migration\.sql does not match its approved SHA-256/],
  'D03 migration 9 one byte appended': [(api) => writeFileSync(sqlOf(api, R3_ATTEMPTS), Buffer.concat([readFileSync(sqlOf(api, R3_ATTEMPTS)), Buffer.from('\n')])), /r3_checkout_attempts\/migration\.sql/],
  'D04 a G7 migration one byte changed': [(api) => flipByte(sqlOf(api, '20261012120000_cash_session_reconciliation')), /cash_session_reconciliation\/migration\.sql does not match its approved SHA-256/],
  'D05 migration 9 missing': [(api) => rmSync(path.join(migDir(api), R3_ATTEMPTS), { recursive: true }), /does not hold exactly the approved migrations/],
  'D06 migration 8 missing': [(api) => rmSync(path.join(migDir(api), R3_A2), { recursive: true }), /does not hold exactly the approved migrations/],
  'D07 a twelfth unreviewed migration': [(api) => { mkdirSync(path.join(migDir(api), '20261019000000_extra')); writeFileSync(sqlOf(api, '20261019000000_extra'), 'SELECT 1;\n'); }, /does not hold exactly the approved migrations/],
  'D08 migration 9 renamed': [(api) => renameSync(path.join(migDir(api), R3_ATTEMPTS), path.join(migDir(api), '20261016130001_r3_checkout_attempts')), /does not hold exactly the approved migrations/],
  'D09 migration 9 SQL is a symlink to identical bytes': [(api) => { const f = sqlOf(api, R3_ATTEMPTS); const copy = path.join(TMP, `m9-${Math.random()}.sql`); cpSync(f, copy); unlinkSync(f); symlinkSync(copy, f); }, /r3_checkout_attempts must contain exactly one regular migration\.sql/],
  'D10 migration 9 directory is a symlink to an identical copy': [(api) => { const d = path.join(migDir(api), R3_ATTEMPTS); const copy = mkdtempSync(path.join(TMP, 'm9dir-')); cpSync(d, copy, { recursive: true }); rmSync(d, { recursive: true }); symlinkSync(copy, d); }, /r3_checkout_attempts is not a real directory/],
  'D11 an extra file inside migration 9': [(api) => writeFileSync(path.join(migDir(api), R3_ATTEMPTS, 'notes.txt'), 'x'), /r3_checkout_attempts must contain exactly one regular migration\.sql/],
  'D12 lock changed': [(api) => flipByte(path.join(migDir(api), 'migration_lock.toml')), /migration_lock\.toml/],
  'D13 lock missing': [(api) => unlinkSync(path.join(migDir(api), 'migration_lock.toml')), /does not hold exactly the approved migrations/],
  'D14 migration 10 one byte changed (same size)': [(api) => flipByte(sqlOf(api, CASH_MOVEMENT)), /cash_movement_withdrawals_expenses\/migration\.sql does not match its approved SHA-256/],
  'D15 migration 10 missing': [(api) => rmSync(path.join(migDir(api), CASH_MOVEMENT), { recursive: true }), /does not hold exactly the approved migrations/],
  'D16 migration 10 renamed': [(api) => renameSync(path.join(migDir(api), CASH_MOVEMENT), path.join(migDir(api), '20261018120001_cash_movement_withdrawals_expenses')), /does not hold exactly the approved migrations/],
  'D17 migration 11 one byte changed (same size)': [(api) => flipByte(sqlOf(api, CASH_REVERSAL)), /cash_movement_reversals\/migration\.sql does not match its approved SHA-256/],
  'D18 migration 11 missing (the G10 tree is drift)': [(api) => rmSync(path.join(migDir(api), CASH_REVERSAL), { recursive: true }), /does not hold exactly the approved migrations/],
  'D19 migration 11 renamed': [(api) => renameSync(path.join(migDir(api), CASH_REVERSAL), path.join(migDir(api), '20261018180001_cash_movement_reversals')), /does not hold exactly the approved migrations/],
};
for (const [label, [mutate, reason]] of Object.entries(G10_DENY)) {
  test(`U1-VER-${label} → DENY`, () => {
    const api = fakeApi();
    assert.equal(fn('verifyLocalTestMigrationPayload')(api).ok, true, 'the unmutated copy verifies');
    mutate(api);
    const r = fn('verifyLocalTestMigrationPayload')(api);
    assert.equal(r.ok, false, label);
    assert.match(r.reason, reason);
  });
}

test('U1-VER-14 a G7-only tree is drift for LOCAL_TEST (G11 is required, never a subset)', () => {
  const api = fakeApi([...APPROVED_MIGRATION_PAYLOAD.migrations.slice(0, 7).map((m) => m.name), 'migration_lock.toml']);
  const r = fn('verifyLocalTestMigrationPayload')(api);
  assert.equal(r.ok, false);
  assert.match(r.reason, /does not hold exactly the approved migrations/);
});

test('U1-VER-15 the generic verifier refuses a malformed payload object instead of trusting it', () => {
  const verify = fn('verifyMigrationTree');
  assert.equal(verify(API_DIR, G11()).ok, true);
  for (const bad of [null, {}, { migrations: [], lock: G11().lock }, { migrations: G11().migrations }, { migrations: [{ name: 'x' }], lock: G11().lock }]) {
    assert.equal(verify(API_DIR, bad).ok, false);
  }
});

// --- the P21 base projection (C) --------------------------------------------------------------

test('U1-P21-01 the P21 base verifies the WHOLE real tree as G11 and returns only migrations 1–8', () => {
  const r = fn('verifyP21BasePayload')(API_DIR);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.migrations.map((m) => [m.name, m.sha256]), G8().migrations.map((m) => [m.name, m.sha256]));
  assert.ok(!r.migrations.some((m) => m.name === R3_ATTEMPTS));
});

test('U1-P21-02 drift anywhere in the tree (migration 9 included) refuses the P21 base too', () => {
  for (const mutate of [(api) => flipByte(sqlOf(api, R3_ATTEMPTS)), (api) => rmSync(path.join(migDir(api), R3_ATTEMPTS), { recursive: true })]) {
    const api = fakeApi();
    mutate(api);
    assert.equal(fn('verifyP21BasePayload')(api).ok, false);
  }
});

test('U1-P21-03 staging copies exactly migrations 1–8 + lock, byte-identical, into a fresh owner-only directory; the source is untouched', () => {
  const tmp = mkdtempSync(path.join(TMP, 'stage-tmp-'));
  const before = readdirSync(migDir(API_DIR)).map((n) => [n, lstatSync(path.join(migDir(API_DIR), n)).mtimeMs]);
  const staged = fn('stageP21BaseMigrations')(API_DIR, tmp);
  try {
    assert.equal(staged.ok, true, staged.reason);
    assert.match(path.basename(staged.root), /^mona-local-test-p21-[A-Za-z0-9]{6}$/);
    assert.equal(path.dirname(staged.root), tmp);
    assert.equal(staged.migrationsDir, path.join(staged.root, 'prisma', 'migrations'));
    assert.equal(statSync(staged.root).mode & 0o777, 0o700);
    assert.deepEqual(readdirSync(staged.migrationsDir).sort(), [...G8().migrations.map((m) => m.name), 'migration_lock.toml'].sort());
    for (const m of G8().migrations) {
      const file = path.join(staged.migrationsDir, m.name, 'migration.sql');
      assert.equal(sha(readFileSync(file)), m.sha256, m.name);
      assert.equal(statSync(file).mode & 0o077, 0, `${m.name} is owner-only`);
    }
    assert.equal(sha(readFileSync(path.join(staged.migrationsDir, 'migration_lock.toml'))), G8().lock.sha256);
    // the staged copy is itself an exact G8 tree
    assert.equal(fn('verifyMigrationTree')(staged.root, G8()).ok, true);
    assert.deepEqual(readdirSync(migDir(API_DIR)).map((n) => [n, lstatSync(path.join(migDir(API_DIR), n)).mtimeMs]), before);
  } finally {
    staged.cleanup?.();
  }
  assert.equal(existsSync(staged.root), false, 'cleanup removes exactly the staged directory');
  assert.deepEqual(readdirSync(tmp), []);
});

test('U1-P21-04 staging refuses a drifted source before writing anything', () => {
  const api = fakeApi();
  flipByte(sqlOf(api, R3_ATTEMPTS));
  const tmp = mkdtempSync(path.join(TMP, 'stage-drift-'));
  const r = fn('stageP21BaseMigrations')(api, tmp);
  assert.equal(r.ok, false);
  assert.deepEqual(readdirSync(tmp), []);
});

test('U1-P21-05 staging refuses a relative or non-directory temporary root', () => {
  assert.equal(fn('stageP21BaseMigrations')(API_DIR, 'relative/tmp').ok, false);
  const file = path.join(TMP, 'not-a-dir');
  writeFileSync(file, 'x');
  assert.equal(fn('stageP21BaseMigrations')(API_DIR, file).ok, false);
});

test('U1-P21-06 the staged-directory pattern is exported and matches only the staging layout', () => {
  const pattern = payloadModule.P21_STAGED_MIGRATIONS_DIR;
  assert.ok(pattern instanceof RegExp);
  assert.match('/tmp/mona-local-test-p21-AbC123/prisma/migrations', pattern);
  for (const bad of ['/tmp/mona-local-test-p21-AbC123/prisma/migrations/', 'tmp/mona-local-test-p21-AbC123/prisma/migrations',
    '/tmp/mona-local-test-p21-AbC12/prisma/migrations', '/tmp/x/../mona-local-test-p21-AbC123/prisma/migrations',
    '/tmp/mona-local-test-p21-AbC123/prisma/migrations\n', '/repo/api/prisma/migrations']) {
    assert.doesNotMatch(bad, pattern, JSON.stringify(bad));
  }
});

// --- the P21 Prisma config (C): only a staged directory, only the canonical LOCAL_TEST url -------

const P21_CONFIG = path.join(API_DIR, 'prisma.local-test-p21.config.ts');
const URL_OK = 'postgresql://mona_local_test:pw-x1@127.0.0.1:5432/mona_local_test';
const markerLine = (payload) => `U1CFG/1 ${payload}\n`;
// The probe with the deterministic protocol (G11-ADV-006): `node:fs` writeSync(1, …)
// flushes synchronously regardless of pipe state, so the child can never exit 0 with
// its answer lost in an async pipe race; the single marked line is what the parser
// accepts.
function defaultProbe() {
  return [
    "import { writeSync } from 'node:fs';",
    `const config = await import(${JSON.stringify(P21_CONFIG)});`,
    "const payload = JSON.stringify({ path: config.default.migrations?.path ?? null, schema: config.default.schema ?? null });",
    `writeSync(1, ${JSON.stringify('U1CFG/1 ')} + payload + ${JSON.stringify('\n')});`,
  ].join('\n');
}
function loadConfig(env, probeText = defaultProbe()) {
  // Node 24 strips the types; `prisma/config` resolves from api/node_modules. No database is
  // contacted: defineConfig only evaluates the object.
  return spawnSync(process.execPath, ['--input-type=module', '-e', probeText], { cwd: API_DIR, env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
}

// Pure, fail-closed parse of one probe result. Empty stdout with exit 0 is a FAILURE,
// not an accept — this closes the U1-CFG-01 race where an async stdout write was lost
// and the assertion would have crashed the test instead of failing the probe deterministically.
function parseU1Cfg(r) {
  if (r.status !== 0) return { ok: false, reason: `probe exited with status ${r.status}` };
  const lines = String(r.stdout).split('\n').map((line) => line.trim()).filter((line) => line.startsWith('U1CFG/1 '));
  if (lines.length === 0) return { ok: false, reason: 'no protocol line (empty or unmarked stdout)' };
  if (lines.length > 1) return { ok: false, reason: 'duplicate protocol lines' };
  let value;
  try { value = JSON.parse(lines[0].slice('U1CFG/1 '.length)); } catch { return { ok: false, reason: 'malformed protocol payload' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('path' in value) || !('schema' in value)) {
    return { ok: false, reason: 'protocol payload misses the required fields' };
  }
  return { ok: true, value };
}

test('U1-CFG-01 the P21 config points Prisma at the staged directory and reads the canonical LOCAL_TEST url', () => {
  const staged = path.join(mkdtempSync(path.join(TMP, 'cfg-')), 'mona-local-test-p21-AbC123', 'prisma', 'migrations');
  const r = loadConfig({ LOCAL_TEST_DATABASE_URL: URL_OK, LOCAL_TEST_P21_MIGRATIONS_DIR: staged });
  const parsed = parseU1Cfg(r);
  assert.ok(parsed.ok, `probe failed: ${parsed.reason ?? r.stderr}`);
  assert.deepEqual(parsed.value, { path: staged, schema: 'prisma/schema.prisma' });
});

test('U1-CFG-02 the P21 config refuses a missing or non-staged migrations directory and a non-canonical url, without echoing values', () => {
  const cases = [
    { LOCAL_TEST_DATABASE_URL: URL_OK },
    { LOCAL_TEST_DATABASE_URL: URL_OK, LOCAL_TEST_P21_MIGRATIONS_DIR: path.join(API_DIR, 'prisma', 'migrations') },
    { LOCAL_TEST_DATABASE_URL: URL_OK, LOCAL_TEST_P21_MIGRATIONS_DIR: '/tmp/x/../mona-local-test-p21-AbC123/prisma/migrations' },
    { LOCAL_TEST_P21_MIGRATIONS_DIR: '/tmp/mona-local-test-p21-AbC123/prisma/migrations' },
    { LOCAL_TEST_DATABASE_URL: 'postgresql://postgres:Sekr3tPw@10.0.0.9:5432/postgres', LOCAL_TEST_P21_MIGRATIONS_DIR: '/tmp/mona-local-test-p21-AbC123/prisma/migrations' },
  ];
  for (const env of cases) {
    const r = loadConfig(env);
    const parsed = parseU1Cfg(r);
    assert.notEqual(r.status, 0, JSON.stringify(Object.keys(env)));
    assert.ok(!parsed.ok, JSON.stringify(Object.keys(env)));
    assert.ok(!`${r.stdout}${r.stderr}`.includes('Sekr3tPw') && !`${r.stdout}${r.stderr}`.includes('pw-x1'));
  }
});

// G11-ADV-006 — the protocol parser is fail-closed on every anomaly, not only on a
// nonzero exit: an accepted-but-lost answer (empty stdout + exit 0), an unparseable
// payload, duplicate lines and a wrong shape all refuse, deterministically.
test('U1-CFG-04 the probe protocol refuses empty stdout with exit 0 (the async-write race is closed)', () => {
  const staged = path.join(mkdtempSync(path.join(TMP, 'cfg-')), 'mona-local-test-p21-AbC124', 'prisma', 'migrations');
  const silent = loadConfig({ LOCAL_TEST_DATABASE_URL: URL_OK, LOCAL_TEST_P21_MIGRATIONS_DIR: staged }, "/* exits 0 without writing anything */");
  const parsed = parseU1Cfg(silent);
  assert.equal(silent.status, 0);
  assert.equal(parsed.ok, false);
  assert.match(parsed.reason, /no protocol line/);
});

test('U1-CFG-05 the probe protocol refuses a malformed payload, duplicate lines, and a wrong shape', () => {
  const staged = path.join(mkdtempSync(path.join(TMP, 'cfg-')), 'mona-local-test-p21-AbC125', 'prisma', 'migrations');
  const env = { LOCAL_TEST_DATABASE_URL: URL_OK, LOCAL_TEST_P21_MIGRATIONS_DIR: staged };
  const probeWriting = (text) => `import { writeSync } from 'node:fs'; writeSync(1, ${JSON.stringify(text)});`;
  const malformed = parseU1Cfg(loadConfig(env, probeWriting('U1CFG/1 {not-json\n')));
  assert.equal(malformed.ok, false);
  assert.match(malformed.reason, /malformed/);
  const duplicate = parseU1Cfg(loadConfig(env, probeWriting(markerLine('{"path":null,"schema":null}') + markerLine('{"path":null,"schema":null}'))));
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /duplicate/);
  const missing = parseU1Cfg(loadConfig(env, probeWriting(markerLine('{"x":1}'))));
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /required fields/);
  const noisy = parseU1Cfg(loadConfig(env, probeWriting(`stderr is separate\n${markerLine(JSON.stringify({ path: '/x', schema: 'prisma/schema.prisma' }))}`)));
  assert.equal(noisy.ok, true, 'stdout noise before the single marker line never breaks the parse');
  assert.deepEqual(noisy.value, { path: '/x', schema: 'prisma/schema.prisma' });
});

test('U1-CFG-03 the ordinary LOCAL_TEST config is unchanged in kind: no migrations override, so it applies the real prisma/migrations (G11)', () => {
  const source = readFileSync(path.join(API_DIR, 'prisma.local-test.config.ts'), 'utf8');
  assert.doesNotMatch(source, /migrations\s*:/);
  assert.doesNotMatch(source, /LOCAL_TEST_P21_MIGRATIONS_DIR/);
});

test.after(() => rmSync(TMP, { recursive: true, force: true }));
