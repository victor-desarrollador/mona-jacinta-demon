import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
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

// OWNER-only guarded `prisma migrate deploy` for PILOT.
//
//   node scripts/database/pilot-migrate.mjs --target=pilot --dry-run --marker-id=<uuid>
//   node scripts/database/pilot-migrate.mjs --target=pilot --execute --marker-id=<uuid> \
//     --confirm-project-ref=<ref>
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
const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref'];
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

// OWNER-approved migration payload (H1). Digests were taken from the HEAD a04478c
// blobs and checked byte-identical to the working tree (no staged/unstaged diff)
// before pinning. `bytes` is the exact size: a size mismatch fails before reading.
// Order = Prisma's lexicographic directory order. Never regenerate these from
// whatever is on disk: a new or changed migration needs a fresh OWNER review.
// Block 1 (20261002120000_block1_pricing_wholesale) was OWNER-approved from the
// independently reviewed candidate bytes, re-pinned after the M1 fix (Sale
// INSERT marker rule) at 10096 B, recomputed before pinning.
export const APPROVED_MIGRATION_PAYLOAD = Object.freeze({
  migrations: Object.freeze([
    Object.freeze({ name: '20260907015311_init', bytes: 17328, sha256: 'a584edab13a2ae540d694578ffa3b5a622decff04e238a5cf16d3040d295e4cb' }),
    Object.freeze({ name: '20260912182432_add_company_location', bytes: 1343, sha256: '19c345aa92c79a0a613dc03ea01dcf10e91b5a75fd6f3535076d8d71b6f740af' }),
    Object.freeze({ name: '20260912191702_add_user_role_scope', bytes: 2356, sha256: '2b415411eddc1212bf60419ce49022cea38d1fc2d12cb08938ad7c953caf7f3a' }),
    Object.freeze({ name: '20260922210000_d3_initial_stock_and_global_audit', bytes: 482, sha256: '62b3b169e06a48dc2e2a3f81cee11e02a809b2733db2453c5b9eef91c15f77cf' }),
    Object.freeze({ name: '20261002120000_block1_pricing_wholesale', bytes: 10096, sha256: '45cf8d080e8fa4ec0a8dab9c9e5d4b780eb1642f0a8992d43b57dff655250173' }),
  ]),
  lock: Object.freeze({ bytes: 128, sha256: '99836963713b4f5b269ad49af0ed3d7b0b2e336115c2f92dc9ac683d139d0900', provider: 'postgresql' }),
});
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
  return { ok: true, mode, markerId: values['marker-id'], confirmProjectRef };
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
  urlFile: PILOT_URL_FILE,
  readUrlFile: (file) => readPrivateUrlFile(file),
  env: process.env,
  createClient: createVerifiedClient,
  spawn: nodeSpawn,
  execPath: process.execPath,
  home: os.homedir(),
  tmpdir: os.tmpdir(),
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
  const derivable = deriveProjectRef(parsedUrl.conn) !== null;

  if (parsed.mode === 'dry-run') {
    for (const line of [
      `${PREFIX} DRY RUN — no database connection was opened and no migration was executed`,
      '  target: PILOT',
      `  private URL file: accepted (${URL_FILE_LABEL}; value not shown; read once, never re-read)`,
      `  marker id: ${parsed.markerId} (syntax accepted; proven against the database only during --execute)`,
      derivable
        ? '  project identity: derivable from the URL (value not shown); --execute requires --confirm-project-ref to match'
        : '  project identity: NOT derivable from the URL — --execute will refuse',
      `  Prisma CLI: repository-local prisma ${prisma.version} (api/node_modules/.bin/prisma → prisma/build/index.js), run with this Node binary`,
      '  migration payload: PASS — exactly 5 OWNER-approved migrations, SHA-256 approval binding active',
      ...payload.migrations.map((m, i) => `    ${i + 1}. ${m.name}  sha256 ${m.sha256}`),
      `  migration_lock.toml: PASS (provider "${payload.lock.provider}", sha256 ${payload.lock.sha256})`,
      '  payload is re-verified during --execute: before the identity proof AND again immediately before spawning',
      '  cwd: api/',
      `  command: prisma ${PRISMA_ARGS.join(' ')}`,
      '  identity proof: mandatory during --execute — the audited pilot-marker --check (REPEATABLE READ READ ONLY, canonical',
      '    marker, environment=pilot, exact marker id, no TEST marker) on the same held URL, immediately before spawning',
      '  child environment: allowlist only (PATH fixed, HOME, TMPDIR, NODE_ENV=production, DATABASE_URL=held URL,',
      '    CHECKPOINT_DISABLE=1, PRISMA_HIDE_UPDATE_MESSAGE=1); nothing else from this shell is passed',
      '  never run: seed, reset, migrate dev, db push, retries',
      '  STILL REQUIRED before --execute: explicit OWNER approval naming PILOT',
    ]) deps.log(line);
    return 0;
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

  // Final payload proof, after the proof connection is closed and immediately
  // before the spawn: a change made during or after the identity proof stops here.
  const final = verifyMigrationPayload(deps.apiDir);
  if (!final.ok) return fail('payload', `${final.reason}; changed after the initial check — prisma was NOT started`);

  const env = buildChildEnv(heldUrl, deps);
  const result = await runChild(
    deps,
    deps.execPath,
    [prisma.script, ...PRISMA_ARGS],
    { cwd: prisma.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
    redact,
  );
  if (!result.ok) {
    const state = result.started === false
      ? 'nothing was applied'
      : 'migrations may be partially applied — inspect with a read-only status check before any retry';
    return fail('prisma', `${result.detail}; ${state}`);
  }
  deps.log(`${PREFIX} OK — prisma migrate deploy exited 0 on the proven PILOT target`);
  return 0;
}

// Only run when executed directly; importing from a test never connects or spawns.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
