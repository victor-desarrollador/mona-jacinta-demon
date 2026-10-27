import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PILOT_URL_FILE,
  createVerifiedClient,
  deriveProjectRef,
  main as pilotMarkerMain,
  parsePilotUrl,
  readPrivateUrlFile,
} from './pilot-marker.mjs';
import { PROJECT_REF_PATTERN } from './lib.mjs';
import {
  FINAL_STATE, INITIAL_STATES, LEDGER_SQL, LOCK_PIN, MIGRATION_PINS, STATES, pendingFor, requireState,
} from './pilot-migration-states.mjs';
import { canonicalJson, projectionDigest, readProjection, runProbes } from './app-schema-projection.mjs';
import { SCHEMA_REFERENCES, STATE_PROBES } from './pilot-schema-references.mjs';
import { buildTargetBinding, buildToolingBinding, readLockedFile, toolingFile, validateTargetBinding, validateToolingBinding } from './pilot-plan-binding.mjs';

// OWNER-only guarded `prisma migrate deploy` for PILOT.
//
//   node scripts/database/pilot-migrate.mjs --target=pilot --dry-run --marker-id=<uuid> \
//     --expected-initial-state=EXACT_S4|EXACT_G7|EXACT_G11
//   node scripts/database/pilot-migrate.mjs --target=pilot --execute --marker-id=<uuid> \
//     --confirm-project-ref=<ref> --expected-initial-state=EXACT_S4|EXACT_G7|EXACT_G11 --plan=<dry-run digest>
//
// G14 cut-over (OWNER 2026-10-21): the approved repository tree is exactly G14 (the fourteen
// pins of pilot-migration-states.mjs). The initial state is NEVER auto-selected: the OWNER
// names it (EXACT_S4, EXACT_G7 or EXACT_G11) after a fresh A4, and --execute requires the plan digest
// the dry run printed for it. --execute then runs, in order: the identity proof; a READ-ONLY
// pre-check snapshot (REPEATABLE READ READ ONLY, pinned search_path, same marker) that must
// show exactly the expected ledger AND the app-owned schema of that state's generated
// reference (digest + semantic probes); the final payload proof; ONE Prisma deploy; and a
// READ-ONLY post-check that must show exactly FINAL_STATE (ledger, reference digest, probes).
// A failed deploy or post-check is reported as RESTORE_REQUIRED: this tool never resolves,
// never retries and never repairs; the approved rollback before any new post-cutover write is the
// full restore of the verified pre-cutover backup.
//
// Invariant: Prisma receives exactly the URL string this process read ONCE from
// the private PILOT file, and that same string's connection was proven, moments
// before spawning, to hold the canonical PILOT marker with the OWNER's marker id
// (via pilot-marker.mjs's own audited --check path, fed from memory, never from
// disk again). What this does NOT guarantee: the proof connection is closed before
// Prisma starts, and nothing here is transactional with the migrations. The
// guarantee is target identity by construction (same immutable URL, same verified
// TLS trust anchor in prisma.config.ts), established at proof time.
//
// --dry-run opens no database connection and spawns nothing. The child gets an
// allowlisted environment (never the invoking shell's DATABASE_URL/PG*/NODE_*/
// DOTENV_*/PRISMA_*), runs under the same Node binary as this wrapper, and its
// output is redacted line by line. No URL, host, port, user, password or project
// ref is printed.

export const API_DIR = fileURLToPath(new URL('../../api/', import.meta.url));
export const PRISMA_ARGS = Object.freeze(['migrate', 'deploy', '--config', 'prisma.config.ts']);
const PREFIX = '[db:pilot-migrate]';
const URL_FILE_LABEL = '~/.config/mona-jacinta/pilot-database-url';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODES = ['dry-run', 'execute'];
const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref', 'expected-initial-state', 'plan'];
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
const HEX64 = /^[0-9a-f]{64}$/;
export const PLAN_FORMAT = 'mona-pilot-migrate-plan/v3';

// G11-ADV-001: the tooling the plan binds by hash. Every listed artifact's bytes
// can change what `--execute` does (the runner itself, the shared pin/payload and
// projection modules, the audited identity-proof client, the TLS trust anchor
// used by the child, the schema contract the child compiles and the derived-list
// helper). Changing any of them invalidates every old plan digest.
export const MIGRATE_TOOLING_FILES = Object.freeze([
  toolingFile('module', 'pilot-plan-binding.mjs'),
  toolingFile('module', 'pilot-migrate.mjs'),
  toolingFile('module', 'pilot-migration-states.mjs'),
  toolingFile('module', 'app-schema-projection.mjs'),
  toolingFile('module', 'pilot-schema-references.mjs'),
  toolingFile('module', 'pilot-marker.mjs'),
  toolingFile('module', 'lib.mjs'),
  toolingFile('api', 'prisma.config.ts'),
  toolingFile('api', 'prisma/schema.prisma'),
  toolingFile('repo', 'scripts/certs/supabase-prod-ca-2021.crt'),
]);

// OWNER-approved migration payload. History of the approvals these pins carry: the H1
// baseline (m1–m4, digests from the HEAD a04478c blobs), Block 1 (m5, re-pinned after the
// M1 fix at 10096 B), Pilot Pricing V2 (m6, 3282 B, OWNER 2026-10-06), CASH-1 (m7, 390 B),
// the reviewed R3 proportional checkout and checkout attempts (m8, m9), cash exits (m10)
// and cash reversals (m11) — G11, OWNER 2026-10-18. The literals live in
// pilot-migration-states.mjs, the single source every PILOT tool shares; they are never
// regenerated from disk, and a new or changed migration needs a fresh OWNER review and a
// new pin there. Pinning applies nothing anywhere.
export const APPROVED_MIGRATION_PAYLOAD = Object.freeze({ migrations: MIGRATION_PINS, lock: LOCK_PIN });
const LOCK_FILE = 'migration_lock.toml';
const MIGRATION_FILE = 'migration.sql';
const MAX_PAYLOAD_FILE_BYTES = 1024 * 1024;
const PROC_FD = '/proc/self/fd';

// Reads one approved file through a single descriptor and hashes the bytes that
// were actually read: O_NOFOLLOW refuses a symlinked final component, O_NONBLOCK
// keeps a FIFO from hanging the open, fstat must show a regular file of the pinned
// size, and the kernel's own path for the descriptor must be the canonical path
// (so a symlinked parent directory cannot redirect the read). Linux /proc is
// required; without it the read fails closed.
export function readPinned(file, expectedBytes) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return { ok: false, reason: 'is missing or is a symlink' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'is not a regular file' };
    if (st.size !== expectedBytes || st.size > MAX_PAYLOAD_FILE_BYTES) return { ok: false, reason: 'size differs from the approved file' };
    if (readlinkSync(`${PROC_FD}/${fd}`) !== file) return { ok: false, reason: 'does not resolve to its canonical path' };
    const bytes = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, bytes, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read !== st.size || readSync(fd, Buffer.alloc(1), 0, 1, read) !== 0) return { ok: false, reason: 'changed while being read' };
    return { ok: true, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return { ok: false, reason: 'could not be read' };
  } finally {
    closeSync(fd);
  }
}

// The one canonical payload check, used by --dry-run and twice by --execute.
// Allowlist: api/prisma/migrations (real directories, canonical path) must hold
// EXACTLY the approved migration directories plus migration_lock.toml; each
// approved directory EXACTLY one regular migration.sql; every file's SHA-256 (of
// the bytes read from its descriptor) must equal the pinned digest, and the lock
// must name exactly the approved provider. Anything else fails; nothing is repaired.
export function verifyMigrationPayload(apiDir) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    const api = realpathSync(apiDir);
    const prismaDir = path.join(api, 'prisma');
    const root = path.join(prismaDir, 'migrations');
    for (const dir of [prismaDir, root]) {
      if (!lstatSync(dir).isDirectory()) return fail(`${path.relative(api, dir)} must be a real directory, not a symlink`);
    }
    if (realpathSync(root) !== root) return fail('api/prisma/migrations is not at its canonical location');
    const approved = APPROVED_MIGRATION_PAYLOAD.migrations;
    const entries = readdirSync(root, { withFileTypes: true });
    const actual = entries.map((e) => e.name).sort();
    const expected = [...approved.map((m) => m.name), LOCK_FILE].sort();
    if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
      return fail('api/prisma/migrations does not hold exactly the OWNER-approved migrations and migration_lock.toml');
    }
    const order = entries.filter((e) => e.name !== LOCK_FILE).map((e) => e.name).sort();
    if (order.some((name, i) => name !== approved[i].name)) return fail('migration order differs from the approved order');

    const migrations = [];
    for (const m of approved) {
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
    const lock = readPinned(path.join(root, LOCK_FILE), APPROVED_MIGRATION_PAYLOAD.lock.bytes);
    if (!lock.ok) return fail(`${LOCK_FILE} ${lock.reason}`);
    if (lock.sha256 !== APPROVED_MIGRATION_PAYLOAD.lock.sha256) return fail(`${LOCK_FILE} does not match its approved SHA-256`);
    const providers = [...lock.bytes.toString('utf8').matchAll(/^\s*provider\s*=\s*"([^"]*)"\s*$/gm)].map((x) => x[1]);
    if (providers.length !== 1 || providers[0] !== APPROVED_MIGRATION_PAYLOAD.lock.provider) {
      return fail(`${LOCK_FILE} provider is not exactly "${APPROVED_MIGRATION_PAYLOAD.lock.provider}"`);
    }
    return { ok: true, migrations, lock: { sha256: lock.sha256, provider: providers[0] } };
  } catch {
    return fail('migration payload could not be read');
  }
}

// Exactly one --target=pilot, exactly one mode, a canonical marker id, and
// --confirm-project-ref only (and always) with --execute. Values are never echoed.
export function parseCliArgs(argv) {
  const values = {};
  const modes = [];
  for (const arg of argv) {
    if (!arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (MODES.includes(body)) {
      modes.push(body);
      continue;
    }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (modes.length !== 1) return { ok: false, error: 'Specify exactly one of --dry-run or --execute' };
  const [mode] = modes;
  if (values.target !== 'pilot') return { ok: false, error: 'Exactly --target=pilot is required' };
  if (values['marker-id'] === undefined || !UUID_V4.test(values['marker-id'])) {
    return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  }
  const confirmProjectRef = values['confirm-project-ref'] ?? null;
  if (mode === 'dry-run' && confirmProjectRef !== null) {
    return { ok: false, error: '--confirm-project-ref is accepted only with --execute' };
  }
  if (mode === 'execute' && (confirmProjectRef === null || !PROJECT_REF_PATTERN.test(confirmProjectRef))) {
    return { ok: false, error: '--execute requires --confirm-project-ref=<20-character lowercase project ref>' };
  }
  // The initial state is the OWNER's explicit choice; it is never inferred.
  const initialState = values['expected-initial-state'];
  if (!INITIAL_STATES.includes(initialState)) {
    return { ok: false, error: `--expected-initial-state must be exactly one of ${INITIAL_STATES.join(' | ')}` };
  }
  const plan = values.plan ?? null;
  if (mode === 'dry-run' && plan !== null) return { ok: false, error: '--plan is accepted only with --execute' };
  if (mode === 'execute' && (plan === null || !HEX64.test(plan))) {
    return { ok: false, error: '--execute requires --plan=<64-hex plan digest printed by the dry run>' };
  }
  return { ok: true, mode, markerId: values['marker-id'], confirmProjectRef, initialState, plan };
}

// The repository-local Prisma CLI, proven from files only (nothing is executed):
// api/node_modules/.bin/prisma must resolve to api/node_modules/prisma/build/index.js,
// that package must be `prisma` at exactly the version pinned in api/package.json,
// and api/prisma.config.ts must be a regular file (not a symlink to another project).
export function resolvePrismaCli(apiDir) {
  try {
    const cwd = realpathSync(apiDir);
    const pkgDir = path.join(cwd, 'node_modules', 'prisma');
    const expected = realpathSync(path.join(pkgDir, 'build', 'index.js'));
    if (!expected.startsWith(`${realpathSync(pkgDir)}${path.sep}`)) return { ok: false, reason: 'local prisma package is not self-contained' };
    const bin = path.join(cwd, 'node_modules', '.bin', 'prisma');
    if (!lstatSync(bin).isSymbolicLink() || realpathSync(bin) !== expected) {
      return { ok: false, reason: 'api/node_modules/.bin/prisma does not resolve to the local prisma package' };
    }
    const pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const api = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const pinned = api.devDependencies?.prisma ?? api.dependencies?.prisma;
    if (pkg.name !== 'prisma' || typeof pinned !== 'string' || !EXACT_VERSION.test(pinned) || pkg.version !== pinned) {
      return { ok: false, reason: 'local prisma package is not the exact version pinned in api/package.json' };
    }
    const config = lstatSync(path.join(cwd, 'prisma.config.ts'));
    if (!config.isFile()) return { ok: false, reason: 'api/prisma.config.ts must be a regular file' };
    return { ok: true, cwd, script: expected, version: pkg.version };
  } catch {
    return { ok: false, reason: 'repository-local prisma CLI or api/prisma.config.ts is missing' };
  }
}

// ---------------- G11-ADV-002: private staged migration execution ----------------
//
// Root cause: the reviewed migration bytes were verified and then closed, but
// Prisma re-opened the worktree's mutable "api/prisma/migrations" paths itself —
// a verify-then-reopen TOCTOU.
//
// Architecture: before the child is ever spawned, the exact approved bytes are
// read once (the same hardened reads runs at both payload proofs) and copied into
// a fresh, exclusive, 0700/0600 private staging tree under the process tmpdir
// (never the repository, never a symlink, no traversal). The staged tree is then
// verified as an exact copy — every migration sha256 equal to its pin, the lock
// equal to its pin, the schema and CA cert equal to their tooling-binding
// digests, the generated config equal to its deterministic text — and verified
// again immediately before the child starts. The child runs with cwd INSIDE the
// stage and a config that resolves schema AND migrations from the stage only:
// Prisma can therefore never consume a worktree migration byte. The stage is
// removed in a finally, whatever the child's outcome.
//
// Documented boundary: the child binary itself stays the verified repository-
// local prisma CLI (version-pinned by resolvePrismaCli), and the generated stage
// config imports that one package's `prisma/config` module by a relative path —
// module CODE from the same pinned package only; no worktree migration SQL is
// ever opened through it. The stage is not crash-durable by design: it is a
// private copy created fresh for this one run, never published, never reused.

export const STAGE_DIR_PREFIX = 'pilot-migrate-stage-';
const STAGE_CA = 'scripts/certs/supabase-prod-ca-2021.crt';
const STAGE_SCHEMA = 'prisma/schema.prisma';

// The generated config the child loads: byte-equivalent in behaviour to the
// repository's prisma.config.ts under NODE_ENV=production (loadRepositoryEnv is a
// no-op then, so its import is dropped) with exactly these deterministic deltas:
// the `prisma/config` specifier becomes the relative path into the pinned local
// prisma package, so module resolution works from inside the stage. No other
// behaviour, no path logic beyond those two constants, nothing secret (the child
// still receives the URL as DATABASE_URL in its allowlisted env).
export function buildStagedConfigText(relativeConfigImport) {
  if (typeof relativeConfigImport !== 'string' || relativeConfigImport === '' || /["\\\n\r\0]/.test(relativeConfigImport)) {
    throw new Error('the staged config import specifier is not representable');
  }
  return `import { fileURLToPath } from 'node:url';
import { defineConfig, env } from ${JSON.stringify(relativeConfigImport)};

// Generated by pilot-migrate.mjs for one --execute run: a private staged copy.
// Same semantics as the repository config under NODE_ENV=production (the
// repository-env import is a no-op there and is therefore dropped here).
let migrationUrl: URL;
try {
  migrationUrl = new URL(env('DATABASE_URL'));
} catch {
  throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL');
}
if (
  !['postgres:', 'postgresql:'].includes(migrationUrl.protocol) ||
  [...migrationUrl.searchParams.keys()].some(
    (key) => key.startsWith('ssl') || key === 'uselibpqcompat',
  )
) {
  throw new Error('DATABASE_URL must be PostgreSQL without TLS query overrides');
}
const caPath = fileURLToPath(
  new URL('./${STAGE_CA}', import.meta.url),
);
migrationUrl.searchParams.set('sslmode', 'require');
migrationUrl.searchParams.set('sslaccept', 'strict');
migrationUrl.searchParams.set('sslcert', caPath);

export default defineConfig({
  schema: '${STAGE_SCHEMA}',
  datasource: { url: migrationUrl.toString() },
});
`;
}

const STAGE_ROOT_FILES = Object.freeze(['prisma', 'scripts', 'prisma.config.ts']);
const STAGE_CERT_NAME = 'supabase-prod-ca-2021.crt';

// An exact-tree verifier for the private staging copy: the root holds exactly the
// three layout entries, nothing else is a symlink anywhere on the walked paths,
// and every file's bytes hash to its expected digest. Any deviation is fatal
// before the child starts.
export function verifyStagedRun(root, expect) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return fail('the staging root is not an absolute path');
    const rootEntries = readdirSync(root, { withFileTypes: true }).map((e) => e.name).sort();
    if (rootEntries.join(',') !== [...STAGE_ROOT_FILES].sort().join(',')) return fail('the staging root does not hold exactly the expected layout');
    for (const name of rootEntries) {
      if (lstatSync(path.join(root, name)).isSymbolicLink()) return fail(`a staging entry is a symlink: ${name}`);
    }
    // prisma.config.ts: regenerated text must match byte for byte.
    const config = readFileSync(path.join(root, 'prisma.config.ts'));
    const expectedConfig = Buffer.from(buildStagedConfigText(expect.configImport));
    if (!config.equals(expectedConfig)) return fail('the staged config is not the generated one');
    for (const [file, sha] of [[STAGE_SCHEMA, expect.schemaSha256], [STAGE_CA, expect.certSha256]]) {
      if (lstatSync(path.join(root, file)).isSymbolicLink()) return fail(`a staging entry is a symlink: ${file}`);
      if (createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') !== sha) return fail(`a staged file is not the verified copy: ${file}`);
    }
    // migrations: exact names, exact bytes, nothing extra, no symlinks.
    const dir = path.join(root, 'prisma', 'migrations');
    const entries = readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, link: e.isSymbolicLink() }));
    if (entries.some((e) => e.link)) return fail('a staged migration entry is a symlink');
    const names = entries.map((e) => e.name).sort();
    const expectedNames = [...expect.migrations.map((m) => m.name), 'migration_lock.toml'].sort();
    if (names.join(',') !== expectedNames.join(',')) return fail('the staged migration set is not exactly the approved one');
    for (const m of expect.migrations) {
      const file = path.join(dir, m.name, 'migration.sql');
      if (lstatSync(file).isSymbolicLink()) return fail(`a staged migration is a symlink: ${m.name}`);
      const st = lstatSync(file);
      if (!st.isFile() || st.size !== m.bytes) return fail(`a staged migration has the wrong shape: ${m.name}`);
      if (createHash('sha256').update(readFileSync(file)).digest('hex') !== m.sha256) return fail(`a staged migration is not the verified copy: ${m.name}`);
    }
    const lock = path.join(dir, 'migration_lock.toml');
    if (lstatSync(lock).isSymbolicLink()) return fail('the staged migration lock is a symlink');
    if (createHash('sha256').update(readFileSync(lock)).digest('hex') !== expect.lockSha256) return fail('the staged migration lock is not the verified copy');
    return { ok: true };
  } catch {
    return fail('the staging tree could not be read');
  }
}

// Build the private staging tree for one --execute run. Reads every byte through
// the hardened/locked reads (pinned sizes for payload files, readLockedFile for
// schema and cert), verifies the copy, and returns a handle with a deterministic
// verify() (used again immediately before the spawn) and a cleanup() for the
// finally. Fails closed; nothing is left half-written on failure (the temp dir is
// removed on any staging error).
export function stageMigrationRun({ apiDir, tmpdir, payload, toolingBinding }) {
  const fail = (reason) => ({ ok: false, reason });
  const byPath = (rel) => toolingBinding.files.find((f) => f.path === rel);
  const schemaEntry = byPath('prisma/schema.prisma');
  const certEntry = byPath('scripts/certs/supabase-prod-ca-2021.crt');
  if (!schemaEntry || !certEntry) return fail('the tooling binding must carry the schema and the CA cert');
  let root;
  try {
    root = mkdtempSync(path.join(tmpdir, STAGE_DIR_PREFIX));
  } catch {
    return fail('the staging root could not be created under the process tmpdir');
  }
  try {
    const configImport = path.relative(root, path.join(apiDir, 'node_modules', 'prisma', 'config.js')).split(path.sep).join('/');
    if (configImport === '' || configImport.startsWith('/')) return fail('the staged config import path is not representable');
    mkdirSync(path.join(root, 'prisma', 'migrations'), { mode: 0o700, recursive: true });
    mkdirSync(path.join(root, 'scripts', 'certs'), { mode: 0o700, recursive: true });
    const put = (rel, bytes) => writeFileSync(path.join(root, rel), bytes, { mode: 0o600, flag: 'wx' });
    put('prisma.config.ts', Buffer.from(buildStagedConfigText(configImport)));
    const schema = readLockedFile(path.join(apiDir, 'prisma', 'schema.prisma'));
    if (!schema.ok) return fail(`the schema could not be read for staging: ${schema.reason}`);
    put('prisma/schema.prisma', schema.bytes);
    const cert = readLockedFile(path.resolve(apiDir, '..', STAGE_CA));
    if (!cert.ok) return fail(`the TLS trust anchor could not be read for staging: ${cert.reason}`);
    put(STAGE_CA, cert.bytes);
    const lock = readPinned(path.join(apiDir, 'prisma', 'migrations', 'migration_lock.toml'), APPROVED_MIGRATION_PAYLOAD.lock.bytes);
    if (!lock.ok || lock.sha256 !== payload.lock.sha256) return fail('the migration lock could not be staged from the verified payload');
    put('prisma/migrations/migration_lock.toml', lock.bytes);
    for (const m of APPROVED_MIGRATION_PAYLOAD.migrations) {
      const one = readPinned(path.join(apiDir, 'prisma', 'migrations', m.name, 'migration.sql'), m.bytes);
      if (!one.ok || one.sha256 !== m.sha256) return fail(`a migration could not be staged from the verified payload: ${m.name}`);
      mkdirSync(path.join(root, 'prisma', 'migrations', m.name), { mode: 0o700, recursive: true });
      put(path.join('prisma', 'migrations', m.name, 'migration.sql'), one.bytes);
    }
    chmodSync(root, 0o700);
    const expect = {
      configImport,
      schemaSha256: schemaEntry.sha256,
      certSha256: certEntry.sha256,
      lockSha256: payload.lock.sha256,
      migrations: APPROVED_MIGRATION_PAYLOAD.migrations.map((m) => ({ name: m.name, bytes: m.bytes, sha256: m.sha256 })),
    };
    const verify = () => verifyStagedRun(root, expect);
    const first = verify();
    if (!first.ok) { try { rmSync(root, { recursive: true, force: true }); } catch { /* leave private temp garbage */ } return fail(first.reason); }
    return { ok: true, root, expect, verify, cleanup: () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } } };
  } catch (stageError) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* leave private temp garbage */ }
    const stageCode = stageError && typeof stageError.code === 'string' ? ` (${stageError.code})` : '';
    return fail(`the staging copy could not be built${stageCode}`);
  }
}

// The plan the OWNER approves: one exact target and tooling binding (G11-ADV-001),
// the initial state, the exact pins to apply, the exact final ledger, the lock, the
// Prisma version/command and the schema reference digests both states are checked
// against. Throws when a reference is missing (never planned blind) or when a
// binding is absent or malformed (never a plan without its binding).
export function buildPlan({ initialState, payload, prismaVersion, schema, targetBinding, toolingBinding }) {
  if (!validateTargetBinding(targetBinding)) throw new Error('the plan must carry an exact binding of the target (G11-ADV-001)');
  if (!validateToolingBinding(toolingBinding)) throw new Error('the plan must carry an exact binding of the tooling (G11-ADV-001)');
  const initialRef = schema?.references?.[initialState]?.digest;
  const finalRef = schema?.references?.[FINAL_STATE]?.digest;
  if (!HEX64.test(String(initialRef)) || !HEX64.test(String(finalRef))) throw new Error('schema reference missing');
  const sha = new Map(payload.migrations.map((m) => [m.name, m.sha256]));
  const apply = pendingFor(initialState).map((name) => ({ name, sha256: sha.get(name) }));
  const plan = {
    format: PLAN_FORMAT, target: 'pilot', targetBinding, toolingBinding, initialState,
    initialLedger: [...STATES[initialState]], apply,
    finalState: FINAL_STATE, finalLedger: payload.migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
    lockSha256: payload.lock.sha256, prisma: { version: prismaVersion, args: [...PRISMA_ARGS] },
    schemaReferences: { [initialState]: initialRef, [FINAL_STATE]: finalRef },
  };
  return { plan, digest: createHash('sha256').update(canonicalJson(plan)).digest('hex') };
}

// The read-only snapshot both checks take: one REPEATABLE READ READ ONLY transaction on a
// verified client, pinned search_path and timeouts, read-only proven, the same PILOT
// marker, then the ledger and the app-owned schema projection; always ROLLBACK.
export const SNAPSHOT_SQL = Object.freeze({
  begin: 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
  searchPath: 'SET LOCAL search_path = pg_catalog, pg_temp',
  timeouts: Object.freeze(["SET LOCAL statement_timeout = '120s'", "SET LOCAL lock_timeout = '5s'", "SET LOCAL idle_in_transaction_session_timeout = '300s'"]),
  readOnly: "SELECT pg_catalog.current_setting('transaction_read_only') AS read_only",
  marker: 'SELECT marker_id::text AS marker_id, environment FROM ONLY mona_pilot_guard.database_identity',
  ledgerPresent: "SELECT pg_catalog.to_regclass('public.\"_prisma_migrations\"') IS NOT NULL AS present",
  rollback: 'ROLLBACK',
});

async function readSnapshot(deps, conn, markerId) {
  const fail = (reason) => ({ ok: false, reason });
  let client;
  try {
    client = deps.createClient(conn);
  } catch {
    return fail('a read-only client could not be created');
  }
  try {
    await client.connect();
    const stream = client.connection?.stream;
    if (stream?.encrypted !== true || stream?.authorized !== true) return fail('verified TLS is required');
    await client.query(SNAPSHOT_SQL.begin);
    try {
      await client.query(SNAPSHOT_SQL.searchPath);
      for (const sql of SNAPSHOT_SQL.timeouts) await client.query(sql);
      if ((await client.query(SNAPSHOT_SQL.readOnly)).rows?.[0]?.read_only !== 'on') return fail('the snapshot transaction is not read-only');
      const marker = (await client.query(SNAPSHOT_SQL.marker)).rows ?? [];
      if (marker.length !== 1 || marker[0].marker_id !== markerId || marker[0].environment !== 'pilot') return fail('the PILOT marker is not the proven one');
      const present = (await client.query(SNAPSHOT_SQL.ledgerPresent)).rows?.[0]?.present === true;
      const ledger = present ? (await client.query(LEDGER_SQL)).rows : [];
      const projection = await readProjection(client);
      return { ok: true, ledger, projection };
    } finally {
      try { await client.query(SNAPSHOT_SQL.rollback); } catch { /* closed below; nothing was written */ }
    }
  } catch (err) {
    // Fixed texts only: a projection refusal names a rule, never a value; anything else is generic.
    const message = typeof err?.message === 'string' && err.message.startsWith('projection: ') ? err.message : 'the read-only snapshot could not be read';
    return fail(message);
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }
}

// Exactly `state`: ledger, app-schema reference digest and every probe of that state.
export function verifySnapshot(snapshot, state, schema) {
  const ledger = requireState(snapshot.ledger, state);
  if (!ledger.ok) return { ok: false, reason: ledger.reason, failures: [] };
  const digest = projectionDigest(snapshot.projection);
  const failures = runProbes(snapshot.projection, schema.probes[state] ?? []);
  if (digest !== schema.references[state]?.digest) return { ok: false, reason: `the app schema is not the ${state} reference`, failures, digest };
  if (failures.length > 0) return { ok: false, reason: `a ${state} semantic probe failed`, failures, digest };
  return { ok: true, digest, probes: (schema.probes[state] ?? []).length };
}

// Allowlist, not blocklist: nothing from the invoking shell is inherited. PATH is
// fixed (only this Node's directory plus system dirs, for any helper Prisma may
// exec); NODE_ENV=production makes api/src/config/load-env.ts skip .env.development;
// checkpoint telemetry and update checks are off (no extra network).
export function buildChildEnv(databaseUrl, { execPath, home, tmpdir }) {
  return {
    PATH: [path.dirname(execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter),
    HOME: home,
    TMPDIR: tmpdir,
    NODE_ENV: 'production',
    DATABASE_URL: databaseUrl,
    CHECKPOINT_DISABLE: '1',
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
  };
}

// Line redactor for anything derived from the held URL: the URL, user, password
// (decoded and percent-encoded), host, host:port and project ref. Longest first.
export function createRedactor(databaseUrl) {
  const secrets = new Set([databaseUrl]);
  try {
    const url = new URL(databaseUrl);
    const { conn } = parsePilotUrl(databaseUrl);
    for (const s of [url.password, url.username, url.host, url.hostname]) secrets.add(s);
    if (conn) {
      for (const s of [conn.password, encodeURIComponent(conn.password), conn.user, `${conn.host}:${conn.port}`]) secrets.add(s);
      const ref = deriveProjectRef(conn);
      if (ref) secrets.add(ref);
    }
  } catch {
    /* the whole URL is still redacted */
  }
  const ordered = [...secrets].filter((s) => typeof s === 'string' && s.length >= 3).sort((a, b) => b.length - a.length);
  return (line) => ordered.reduce((out, secret) => out.split(secret).join('«redacted»'), line);
}

// Forwards a child stream to `sink` one redacted line at a time, so a secret split
// across chunks is still whole when redacted. `flush` emits a final partial line.
function lineForwarder(stream, redact, sink) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const emit = (text) => {
    pending += text;
    const lines = pending.split('\n');
    pending = lines.pop();
    for (const line of lines) sink(redact(line.replace(/\r$/, '')));
  };
  stream?.on('data', (chunk) => emit(typeof chunk === 'string' ? chunk : decoder.write(chunk)));
  return () => {
    emit(decoder.end());
    if (pending) sink(redact(pending));
    pending = '';
  };
}

// Resolves once with the child's outcome; success is ONLY an observed exit code 0
// with no signal. Spawn errors, signals, unknown status and error-then-close fail.
function runChild(deps, command, args, options, redact) {
  // A Promise settles once: whichever of 'error'/'close' comes first decides.
  return new Promise((settle) => {
    let child;
    try {
      child = deps.spawn(command, args, options);
    } catch {
      return settle({ ok: false, started: false, detail: 'prisma could not be started' });
    }
    const flushOut = lineForwarder(child.stdout, redact, (line) => deps.log(`  prisma| ${line}`));
    const flushErr = lineForwarder(child.stderr, redact, (line) => deps.error(`  prisma| ${line}`));
    child.on('error', () => settle({ ok: false, detail: 'prisma could not be started or failed to run' }));
    child.on('close', (code, signal) => {
      flushOut();
      flushErr();
      if (code === 0 && signal === null) settle({ ok: true });
      else if (signal) settle({ ok: false, detail: `prisma was terminated by ${signal}` });
      else if (Number.isInteger(code)) settle({ ok: false, detail: `prisma exited with code ${code}` });
      else settle({ ok: false, detail: 'prisma exit status is unavailable' });
    });
  });
}

const defaultDeps = {
  apiDir: API_DIR,
  moduleDir: path.dirname(fileURLToPath(import.meta.url)),
  urlFile: PILOT_URL_FILE,
  readUrlFile: (file) => readPrivateUrlFile(file),
  env: process.env,
  createClient: createVerifiedClient,
  spawn: nodeSpawn,
  execPath: process.execPath,
  home: os.homedir(),
  tmpdir: os.tmpdir(),
  schema: { references: SCHEMA_REFERENCES, probes: STATE_PROBES },
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function main(argv, deps = defaultDeps) {
  const fail = (phase, detail) => {
    deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`);
    return 1;
  };

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);

  const prisma = resolvePrismaCli(deps.apiDir);
  if (!prisma.ok) return fail('prisma', prisma.reason);

  // The ONLY read of the private file. Everything after uses this in-memory string.
  let file;
  try {
    file = deps.readUrlFile(deps.urlFile);
  } catch {
    file = { ok: false, reason: 'private URL file could not be read' };
  }
  if (!file.ok) return fail('config', `${URL_FILE_LABEL}: ${file.reason}`);
  const heldUrl = typeof file.text === 'string' ? file.text.replace(/\r?\n$/, '') : '';
  const parsedUrl = parsePilotUrl(heldUrl);
  if (!parsedUrl.ok) {
    return fail('config', `${URL_FILE_LABEL} must hold one PostgreSQL URL with user, password, host and database and no query/fragment (value not shown)`);
  }
  // Initial payload proof: before any database access.
  const payload = verifyMigrationPayload(deps.apiDir);
  if (!payload.ok) return fail('payload', `${payload.reason}; nothing was started`);
  const redact = createRedactor(heldUrl);

  // G11-ADV-001: the plan binds ONE target (project ref, host, database, marker id)
  // and ONE tooling state (every artifact whose bytes can change what executes).
  // A non-derivable project ref cannot be bound → fail closed (dry-run included).
  const projectRef = deriveProjectRef(parsedUrl.conn);
  if (projectRef === null) {
    return fail('target', `${URL_FILE_LABEL} does not carry a derivable project ref; a plan cannot bind its target (nothing was started)`);
  }
  let targetBinding;
  let toolingBinding;
  try {
    targetBinding = buildTargetBinding({ environment: 'pilot', projectRef, host: parsedUrl.conn.host, database: parsedUrl.conn.database, markerId: parsed.markerId });
    toolingBinding = buildToolingBinding({
      moduleDir: deps.moduleDir,
      apiDir: deps.apiDir,
      repoDir: path.dirname(String(deps.apiDir).replace(/\/+$/, '')),
      files: MIGRATE_TOOLING_FILES,
    });
  } catch (error) {
    return fail('binding', `${error?.message ?? 'the target/tooling binding could not be built'}; nothing was started`);
  }
  let planned;
  try {
    planned = buildPlan({ initialState: parsed.initialState, payload, prismaVersion: prisma.version, schema: deps.schema, targetBinding, toolingBinding });
  } catch {
    return fail('reference', `no generated app-schema reference for ${parsed.initialState} and ${FINAL_STATE} (pilot-schema-references.mjs); nothing was started`);
  }
  const pending = planned.plan.apply;

  if (parsed.mode === 'dry-run') {
    for (const line of [
      `${PREFIX} DRY RUN — no database connection was opened and no migration was executed`,
      '  target: PILOT',
      `  private URL file: accepted (${URL_FILE_LABEL}; value not shown; read once, never re-read)`,
      `  marker id: ${parsed.markerId} (syntax accepted; proven against the database only during --execute)`,
      `  project identity: bound to the plan (project ref, host, database, marker id — values not shown); --execute requires --confirm-project-ref to match`,
      `  tooling binding: bound (${toolingBinding.files.length} repository artifacts by SHA-256 — values not shown)`,
      `  Prisma CLI: repository-local prisma ${prisma.version} (api/node_modules/.bin/prisma → prisma/build/index.js), run with this Node binary`,
      `  migration payload: PASS — exactly ${APPROVED_MIGRATION_PAYLOAD.migrations.length} OWNER-approved migrations, SHA-256 approval binding active`,
      ...payload.migrations.map((m, i) => `    ${i + 1}. ${m.name}  sha256 ${m.sha256}`),
      `  migration_lock.toml: PASS (provider "${payload.lock.provider}", sha256 ${payload.lock.sha256})`,
      `  INITIAL_STATE=${parsed.initialState} (explicit; the pre-check refuses any other ledger or schema)`,
      `    required ledger: exactly ${STATES[parsed.initialState].length} migrations; app schema reference ${planned.plan.schemaReferences[parsed.initialState]}`,
      `  migrations to apply: ${pending.length}`,
      ...pending.map((m) => `    + ${m.name}  sha256 ${m.sha256}`),
      `  FINAL_STATE=${FINAL_STATE} (exactly ${STATES[FINAL_STATE].length} migrations; app schema reference ${planned.plan.schemaReferences[FINAL_STATE]})`,
      `  POST_CHECK_STATE=${FINAL_STATE}`,
      `  post-check: read-only; anything but ${FINAL_STATE} → PILOT_MIGRATE_RESULT=RESTORE_REQUIRED (never resolve, retry or repair)`,
      `  PLAN_DIGEST=${planned.digest}`,
      '  payload is re-verified during --execute: before the identity proof AND again immediately before spawning',
      '  child cwd: a fresh private staged copy of the approved migration OWN bytes (tooling tmpdir, 0700/0600, exact-tree',
      '    verified twice; Prisma reads the staged tree only and never re-opens worktree migration SQL); removed after the run',
      `  command: prisma ${PRISMA_ARGS.join(' ')}`,
      '  identity proof: mandatory during --execute — the audited pilot-marker --check (REPEATABLE READ READ ONLY, canonical',
      '    marker, environment=pilot, exact marker id, no TEST marker) on the same held URL, immediately before spawning',
      '  child environment: allowlist only (PATH fixed, HOME, TMPDIR, NODE_ENV=production, DATABASE_URL=held URL,',
      '    CHECKPOINT_DISABLE=1, PRISMA_HIDE_UPDATE_MESSAGE=1); nothing else from this shell is passed',
      '  never run: seed, reset, migrate dev, db push, retries',
      '  STILL REQUIRED before --execute: explicit OWNER approval naming PILOT and this PLAN_DIGEST (--plan=…)',
    ]) deps.log(line);
    return 0;
  }

  if (parsed.plan !== planned.digest) {
    return fail('plan', 'PLAN_BINDING_MISMATCH: --plan is not the digest of this exact plan binding (target, tooling, payload, states); re-run --dry-run and approve its PLAN_DIGEST; nothing was started');
  }
  if (deriveProjectRef(parsedUrl.conn) !== parsed.confirmProjectRef) {
    return fail('target', `--confirm-project-ref does not match the project addressed by ${URL_FILE_LABEL} (values not shown)`);
  }

  // Identity proof: pilot-marker's own --check, fed the held URL from memory.
  const proof = await pilotMarkerMain(['--target=pilot', '--check', `--marker-id=${parsed.markerId}`], {
    urlFile: deps.urlFile,
    readUrlFile: () => ({ ok: true, text: heldUrl }),
    env: deps.env,
    createClient: deps.createClient,
    log: (line) => deps.log(redact(line)),
    error: (line) => deps.error(redact(line)),
  });
  if (proof !== 0) return fail('identity', 'PILOT identity proof failed; prisma was NOT started');

  // Read-only pre-check: exactly the OWNER-named initial state, ledger AND schema.
  const pre = await readSnapshot(deps, parsedUrl.conn, parsed.markerId);
  if (!pre.ok) return fail('precheck', `${pre.reason}; prisma was NOT started`);
  const preVerdict = verifySnapshot(pre, parsed.initialState, deps.schema);
  if (!preVerdict.ok) {
    for (const f of preVerdict.failures) deps.error(`  ${f}`);
    return fail('precheck', `${preVerdict.reason}; prisma was NOT started`);
  }
  deps.log(`${PREFIX} precheck ok — ledger ${parsed.initialState}, app schema ${preVerdict.digest} = reference, probes ${preVerdict.probes}/${preVerdict.probes}`);

  // Final payload proof, after the proof connection is closed and immediately
  // before the spawn: a change made during or after the identity proof stops here.
  const final = verifyMigrationPayload(deps.apiDir);
  if (!final.ok) return fail('payload', `${final.reason}; changed after the initial check — prisma was NOT started`);

  const env = buildChildEnv(heldUrl, deps);

  // G11-ADV-002: stage the exact approved bytes into a private tree and let the
  // child run from there; a worktree change during the run cannot reach the child.
  const staged = stageMigrationRun({ apiDir: deps.apiDir, tmpdir: deps.tmpdir, payload, toolingBinding });
  if (!staged.ok) return fail('stage', `${staged.reason}; nothing was applied`);
  let result;
  try {
    const reverify = staged.verify();
    if (!reverify.ok) return fail('stage', `${reverify.reason}; nothing was applied`);
    result = await runChild(
      deps,
      deps.execPath,
      [prisma.script, ...PRISMA_ARGS],
      { cwd: staged.root, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
      redact,
    );
  } finally {
    staged.cleanup();
  }
  const restoreRequired = (phase, detail) => {
    deps.error(`${PREFIX} RESTORE_REQUIRED — PILOT is not proven ${FINAL_STATE}. The freeze stays in force; never run \`prisma migrate resolve\`,`);
    deps.error('  never retry and never repair by hand: restore the verified pre-cutover backup (runbook: rollback BEFORE new post-cutover writes).');
    deps.log('PILOT_MIGRATE_RESULT=RESTORE_REQUIRED');
    return fail(phase, detail);
  };
  if (!result.ok) {
    if (result.started === false) return fail('prisma', `${result.detail}; nothing was applied`);
    // Read-only inspection for the report only; nothing is decided or repaired from it.
    const seen = await readSnapshot(deps, parsedUrl.conn, parsed.markerId);
    const ledger = seen.ok ? requireState(seen.ledger, FINAL_STATE) : null;
    deps.error(`  post-failure ledger: ${seen.ok ? (ledger.ok ? FINAL_STATE : ledger.reason) : seen.reason}`);
    return restoreRequired('prisma', `${result.detail}; migrations may be partially applied`);
  }
  // Read-only post-check: exactly FINAL_STATE, ledger AND schema.
  const post = await readSnapshot(deps, parsedUrl.conn, parsed.markerId);
  if (!post.ok) return restoreRequired('postcheck', post.reason);
  const postVerdict = verifySnapshot(post, FINAL_STATE, deps.schema);
  if (!postVerdict.ok) {
    for (const f of postVerdict.failures) deps.error(`  ${f}`);
    return restoreRequired('postcheck', postVerdict.reason);
  }
  deps.log(`${PREFIX} postcheck ok — ledger ${FINAL_STATE}, app schema ${postVerdict.digest} = reference, probes ${postVerdict.probes}/${postVerdict.probes}`);
  deps.log(`${PREFIX} OK — the Prisma deploy exited 0 and PILOT is proven ${FINAL_STATE}`);
  deps.log(`PILOT_MIGRATE_RESULT=${FINAL_STATE}`);
  return 0;
}

// Only run when executed directly; importing from a test never connects or spawns.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
