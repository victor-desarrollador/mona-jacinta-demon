// U1 (R3-T) + PILOT cash exits + cash reversals + card credit: the LOCAL_TEST migration payload.
//
// G14 cut-over (OWNER 2026-10-18, extended 2026-10-20/21): pilot-migrate.mjs approves exactly G14, so the
// LOCAL_TEST payload IS that shared payload object (the fourteen literal pins of
// pilot-migration-states.mjs); nothing is re-typed here. Only the disposable
// LOCAL_TEST tooling (local-test-prepare.mjs) uses this module; it imports nothing
// PILOT-capable. The per-group pin lists below are views of the shared pins by name.
//
// G8 = the first eight entries of G14 (migrations 1–8): the exact ledger the P21
// suite (r3-attempts-schema.pg.test.ts Suite B) needs before migration 9. It is
// produced by a private, byte-identical staged copy of migrations 1–8 — the
// reviewed migration directories are never modified, renamed or moved.
//
// Every verification is exact-tree and fail-closed: any extra, missing, renamed,
// symlinked or changed entry is drift.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APPROVED_MIGRATION_PAYLOAD, readPinned } from './pilot-migrate.mjs';

const pinsNamed = (...names) => Object.freeze(names.map((name) => APPROVED_MIGRATION_PAYLOAD.migrations.find((m) => m.name === name)));
// The two reviewed R3 migrations (m8, m9), the cash-exit migration (m10) and the cash-reversal migration (m11).
export const R3_MIGRATION_PINS = pinsNamed('20261016120000_r3_proportional_checkout', '20261016130000_r3_checkout_attempts');
export const CASH_MOVEMENT_MIGRATION_PINS = pinsNamed('20261018120000_cash_movement_withdrawals_expenses');
export const CASH_MOVEMENT_REVERSAL_MIGRATION_PINS = pinsNamed('20261018180000_cash_movement_reversals');
export const CARD_CREDIT_MIGRATION_PINS = pinsNamed('20261021120000_r3_card_credit');
export const WAREHOUSE_MIGRATION_PINS = pinsNamed('20261021130000_warehouse_stock_adjustment');
export const QR_MIGRATION_PINS = pinsNamed('20261021140000_r3_qr');

export const LOCAL_TEST_MIGRATION_PAYLOAD = APPROVED_MIGRATION_PAYLOAD;

export const LOCAL_TEST_P21_BASE_PAYLOAD = Object.freeze({
  migrations: Object.freeze(LOCAL_TEST_MIGRATION_PAYLOAD.migrations.slice(0, 8)),
  lock: LOCAL_TEST_MIGRATION_PAYLOAD.lock,
});

const LOCK_FILE = 'migration_lock.toml';
const MIGRATION_FILE = 'migration.sql';
const STAGE_PREFIX = 'mona-local-test-p21-';
// The only directory prisma.local-test-p21.config.ts accepts: <abs>/mona-local-test-p21-XXXXXX/prisma/migrations,
// with no `.`/`..` segment, no trailing slash and no control character.
export const P21_STAGED_MIGRATIONS_DIR = /^(?:\/(?!\.\.?(?:\/|$))[^/\p{Cc}]+)*\/mona-local-test-p21-[A-Za-z0-9]{6}\/prisma\/migrations$/u;

const isPin = (m) => m !== null && typeof m === 'object' && typeof m.name === 'string' && /^\d{14}_[a-z0-9_]+$/.test(m.name)
  && Number.isSafeInteger(m.bytes) && m.bytes > 0 && typeof m.sha256 === 'string' && /^[0-9a-f]{64}$/.test(m.sha256);
const isPayload = (p) => p !== null && typeof p === 'object' && Array.isArray(p.migrations) && p.migrations.length > 0
  && p.migrations.every(isPin) && isPin({ name: '00000000000000_lock', ...p.lock }) && typeof p.lock?.provider === 'string';

// Exact-tree verification of <apiDir>/prisma/migrations against `payload`: exactly its migration directories (in order),
// each holding exactly one regular migration.sql with the pinned size and SHA-256, plus the pinned migration_lock.toml
// naming exactly the pinned provider. Same layers as pilot-migrate.mjs verifyMigrationPayload, for any reviewed payload.
export function verifyMigrationTree(apiDir, payload) {
  const fail = (reason) => ({ ok: false, reason });
  if (!isPayload(payload)) return fail('the migration payload is malformed');
  try {
    const api = realpathSync(apiDir);
    const prismaDir = path.join(api, 'prisma');
    const root = path.join(prismaDir, 'migrations');
    for (const dir of [prismaDir, root]) {
      if (!lstatSync(dir).isDirectory()) return fail(`${path.relative(api, dir)} must be a real directory, not a symlink`);
    }
    if (realpathSync(root) !== root) return fail('prisma/migrations is not at its canonical location');
    const entries = readdirSync(root, { withFileTypes: true });
    const actual = entries.map((e) => e.name).sort();
    const expected = [...payload.migrations.map((m) => m.name), LOCK_FILE].sort();
    if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
      return fail('prisma/migrations does not hold exactly the approved migrations and migration_lock.toml');
    }
    const order = entries.filter((e) => e.name !== LOCK_FILE).map((e) => e.name).sort();
    if (order.some((name, i) => name !== payload.migrations[i].name)) return fail('migration order differs from the approved order');

    const migrations = [];
    for (const m of payload.migrations) {
      const entry = entries.find((e) => e.name === m.name);
      if (!entry.isDirectory()) return fail(`${m.name} is not a real directory`);
      const dir = path.join(root, m.name);
      const inner = readdirSync(dir, { withFileTypes: true });
      if (inner.length !== 1 || inner[0].name !== MIGRATION_FILE || !inner[0].isFile()) {
        return fail(`${m.name} must contain exactly one regular ${MIGRATION_FILE}`);
      }
      const file = readPinned(path.join(dir, MIGRATION_FILE), m.bytes);
      if (!file.ok) return fail(`${m.name}/${MIGRATION_FILE} ${file.reason}`);
      if (file.sha256 !== m.sha256) return fail(`${m.name}/${MIGRATION_FILE} does not match its approved SHA-256`);
      migrations.push({ name: m.name, sha256: file.sha256 });
    }

    const lockEntry = entries.find((e) => e.name === LOCK_FILE);
    if (!lockEntry.isFile()) return fail(`${LOCK_FILE} is not a regular file`);
    const lock = readPinned(path.join(root, LOCK_FILE), payload.lock.bytes);
    if (!lock.ok) return fail(`${LOCK_FILE} ${lock.reason}`);
    if (lock.sha256 !== payload.lock.sha256) return fail(`${LOCK_FILE} does not match its approved SHA-256`);
    const providers = [...lock.bytes.toString('utf8').matchAll(/^\s*provider\s*=\s*"([^"]*)"\s*$/gm)].map((x) => x[1]);
    if (providers.length !== 1 || providers[0] !== payload.lock.provider) {
      return fail(`${LOCK_FILE} provider is not exactly "${payload.lock.provider}"`);
    }
    return { ok: true, migrations, lock: { sha256: lock.sha256, provider: providers[0] } };
  } catch {
    return fail('migration payload could not be read');
  }
}

// The LOCAL_TEST payload: the real reviewed tree must be exactly G11.
export function verifyLocalTestMigrationPayload(apiDir) {
  return verifyMigrationTree(apiDir, LOCAL_TEST_MIGRATION_PAYLOAD);
}

// The P21 base: the WHOLE real tree must still be exactly G11 (drift anywhere, migration 9 included, refuses); the result
// is the G8 projection — what the P21 action applies and what its classifier expects in the ledger.
export function verifyP21BasePayload(apiDir) {
  const full = verifyLocalTestMigrationPayload(apiDir);
  if (!full.ok) return full;
  return { ok: true, migrations: full.migrations.slice(0, LOCAL_TEST_P21_BASE_PAYLOAD.migrations.length), lock: full.lock };
}

// A fresh owner-only copy of migrations 1–8 + lock under `tmpdir`: <tmpdir>/mona-local-test-p21-XXXXXX/prisma/migrations.
// Every byte copied is the one readPinned verified against its pin, and the copy is verified again as an exact G8 tree
// before it is handed to Prisma. The source tree is only read. `cleanup()` removes exactly the directory created here.
export function stageP21BaseMigrations(apiDir, tmpdir) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof tmpdir !== 'string' || !path.isAbsolute(tmpdir)) return fail('the staging root must be an absolute directory');
  let base;
  try {
    if (!lstatSync(tmpdir).isDirectory()) return fail('the staging root must be a real directory');
    base = realpathSync(tmpdir);
  } catch {
    return fail('the staging root must be a real directory');
  }
  const source = verifyP21BasePayload(apiDir);
  if (!source.ok) return fail(`${source.reason}; nothing was staged`);
  let root = null;
  const cleanup = () => {
    if (root !== null) rmSync(root, { recursive: true, force: true });
  };
  try {
    root = mkdtempSync(path.join(base, STAGE_PREFIX));
    chmodSync(root, 0o700);
    const from = path.join(realpathSync(apiDir), 'prisma', 'migrations');
    const to = path.join(root, 'prisma', 'migrations');
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const m of LOCAL_TEST_P21_BASE_PAYLOAD.migrations) {
      const file = readPinned(path.join(from, m.name, MIGRATION_FILE), m.bytes);
      if (!file.ok || file.sha256 !== m.sha256) throw new Error('source changed while staging');
      mkdirSync(path.join(to, m.name), { mode: 0o700 });
      writeFileSync(path.join(to, m.name, MIGRATION_FILE), file.bytes, { mode: 0o600, flag: 'wx' });
    }
    const lock = readPinned(path.join(from, LOCK_FILE), LOCAL_TEST_P21_BASE_PAYLOAD.lock.bytes);
    if (!lock.ok || lock.sha256 !== LOCAL_TEST_P21_BASE_PAYLOAD.lock.sha256) throw new Error('source changed while staging');
    writeFileSync(path.join(to, LOCK_FILE), lock.bytes, { mode: 0o600, flag: 'wx' });
    const staged = verifyMigrationTree(root, LOCAL_TEST_P21_BASE_PAYLOAD);
    if (!staged.ok) throw new Error('the staged copy is not an exact G8 tree');
    if (!P21_STAGED_MIGRATIONS_DIR.test(to)) throw new Error('the staged directory does not match the accepted pattern');
    return { ok: true, root, migrationsDir: to, cleanup };
  } catch {
    cleanup();
    return fail('the P21 base migrations could not be staged; nothing was left behind');
  }
}
