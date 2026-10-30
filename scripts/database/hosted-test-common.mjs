import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { buildClientConfig } from './d5h-preflight.mjs';
import { parseHostedTestConfig } from './hosted-test-config.mjs';
import { CA_PATH, PROJECT_REF_PATTERN, canonicalJson } from './lib.mjs';
import { PROOF_BEGIN_SQL, confirmed } from './test-marker.mjs';

// Shared building blocks of the hosted TEST tools (hosted-test-upgrade.mjs, api/scripts/hosted-test-location-baseline.ts).
//
// Everything here is either pure or takes its collaborator (filesystem, spawn, client factory) as an argument: nothing reads the process
// environment on its own, nothing connects on import, and nothing in this file can name a database other than the one the canonical TEST
// configuration (hosted-test-config.mjs, the I1a parser) describes. It deliberately imports no PILOT tooling and no LOCAL_TEST tooling.
//
// Output discipline: results carry digests and fixed codes. No URL, host, user, password, project ref or marker id is ever printed.

export const MAX_EVIDENCE_AGE_MS = 6 * 60 * 60 * 1000;

// ------------------------------------------------------------------------------------------------------------------ environment
// Variables that could name or redirect to another database, another tool target or another runtime. A tool that finds any of them set refuses
// to run: the target is defined by the canonical TEST configuration file and by nothing else.
export const FORBIDDEN_ENV_NAMES = Object.freeze([
  'DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL', 'TEST_DATABASE_URL', 'TEST_DATABASE_MARKER_ID', 'MONA_TEST_DATABASE_TARGET',
  'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
]);
export const FORBIDDEN_ENV_PREFIXES = Object.freeze(['PG', 'PRISMA_', 'DOTENV_', 'LOCAL_TEST_', 'PILOT', 'MONA_D5H']);

export function checkEnvironment(env) {
  const names = Object.keys(env ?? {})
    .filter((key) => env[key] !== undefined)
    .filter((key) => FORBIDDEN_ENV_NAMES.includes(key) || FORBIDDEN_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort();
  return names.length === 0 ? { ok: true } : { ok: false, code: 'ENV_FORBIDDEN', names };
}

// ------------------------------------------------------------------------------------------------------------------ arguments
// Exactly one mode, every `--key=value` at most once, nothing positional, nothing unknown. Rejected text is never echoed.
export function parseStrictArgs(argv, spec) {
  const invalid = (reason) => ({ ok: false, code: 'ARGS_INVALID', reason });
  if (!Array.isArray(argv)) return invalid('MODE');
  const modes = [];
  const values = {};
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return invalid('POSITIONAL');
    const body = arg.slice(2);
    if (spec.modes.includes(body)) {
      modes.push(body);
      continue;
    }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !spec.values.includes(key)) return invalid('UNKNOWN');
    if (Object.hasOwn(values, key)) return invalid('DUPLICATE');
    values[key] = body.slice(eq + 1);
  }
  if (modes.length !== 1) return invalid('MODE');
  return { ok: true, mode: modes[0], values };
}

// ------------------------------------------------------------------------------------------------------------------ target
export function readTarget(readBytes) {
  let bytes;
  try {
    bytes = readBytes();
  } catch {
    return { ok: false, code: 'CONFIG_UNREADABLE' };
  }
  return parseHostedTestConfig(bytes);
}

// The operator restates the marker id (always) and the project ref (to write): both must equal what the configuration holds.
export function confirmTarget(held, { markerId, projectRef }) {
  if (typeof markerId !== 'string' || markerId !== held.markerId) return 'MARKER_ARG_MISMATCH';
  if (projectRef !== undefined && (typeof projectRef !== 'string' || !PROJECT_REF_PATTERN.test(projectRef) || projectRef !== held.projectRef)) {
    return 'PROJECT_REF_MISMATCH';
  }
  return null;
}

// ------------------------------------------------------------------------------------------------------------------ safe output
const SAFE_NODE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);
const fold = (text) => String(text).toUpperCase().replace(/[^0-9A-Z]/g, '');

// A SQLSTATE or an allow-listed Node/TLS code; anything else, or a code that also occurs inside a secret, collapses to 'unexpected'.
export function failureCode(err, secrets) {
  try {
    const code = err !== null && typeof err === 'object' ? err.code : undefined;
    if (typeof code !== 'string') return 'unexpected';
    if (!/^[0-9A-Z]{5}$/.test(code) && !SAFE_NODE_CODES.has(code)) return 'unexpected';
    const folded = fold(code);
    if ((secrets ?? []).some((secret) => typeof secret === 'string' && fold(secret).includes(folded))) return 'unexpected';
    return code;
  } catch {
    return 'unexpected';
  }
}

export function makeRedactor(secrets) {
  const variants = new Set();
  for (const secret of secrets ?? []) {
    if (typeof secret !== 'string' || secret.length < 4) continue;
    variants.add(secret);
    variants.add(encodeURIComponent(secret));
  }
  const ordered = [...variants].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = String(text ?? '');
    for (const variant of ordered) out = out.split(variant).join('<redacted>');
    return out;
  };
}

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

// ------------------------------------------------------------------------------------------------------------------ evidence documents
// One canonical rendering, self-hashed: the accepted inputs are exactly the renderer's outputs, so an edited file never parses.
export function buildEvidence(format, body) {
  const document = { format, ...body };
  return { ...document, evidenceSha256: sha256Hex(canonicalJson(document)) };
}
export const renderEvidence = (evidence) => `${canonicalJson(evidence)}\n`;

export function parseEvidence(text, format) {
  try {
    if (typeof text !== 'string' || !text.endsWith('\n')) return null;
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (renderEvidence(parsed) !== text) return null;
    if (parsed.format !== format) return null;
    const { evidenceSha256, ...document } = parsed;
    if (typeof evidenceSha256 !== 'string' || evidenceSha256 !== sha256Hex(canonicalJson(document))) return null;
    return parsed;
  } catch {
    return null;
  }
}

// Exclusive create (wx), owner-only, never overwriting and never following a link.
export function writeExclusive(fs, file, text) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, code: 'PATH_NOT_ABSOLUTE' };
  try {
    fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    return { ok: false, code: error?.code === 'EEXIST' ? 'EVIDENCE_EXISTS' : 'EVIDENCE_WRITE_FAILED' };
  }
  return { ok: true };
}

// A regular file of bounded size, opened without following a link and without blocking on a special file. null on any deviation.
export function readRegularFile(fs, file, maxBytes) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return offset === stat.size ? buffer : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

export function hashToolingFiles(root, files, fs = nodeFs) {
  const digests = [];
  for (const file of files) {
    const bytes = readRegularFile(fs, path.join(root, file), 4 * 1024 * 1024);
    if (bytes === null) return null;
    digests.push({ file, sha256: sha256Hex(bytes) });
  }
  return digests;
}

// ------------------------------------------------------------------------------------------------------------------ migration tree
const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/;
const MAX_MIGRATION_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 4096;

// The directory holds exactly <timestamp>_<name>/migration.sql entries and migration_lock.toml: no other entry, no link, no special file.
export function readMigrationTree(dir, fs = nodeFs) {
  const layout = { ok: false, code: 'TREE_LAYOUT' };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { ok: false, code: 'TREE_UNREADABLE' };
  }
  const migrations = [];
  let lock = null;
  for (const entry of entries) {
    if (entry.name === 'migration_lock.toml') {
      if (!entry.isFile()) return layout;
      lock = readRegularFile(fs, path.join(dir, entry.name), MAX_LOCK_BYTES);
      if (lock === null) return layout;
      continue;
    }
    if (!MIGRATION_NAME.test(entry.name) || !entry.isDirectory()) return layout;
    let inner;
    try {
      inner = fs.readdirSync(path.join(dir, entry.name), { withFileTypes: true });
    } catch {
      return layout;
    }
    if (inner.length !== 1 || inner[0].name !== 'migration.sql' || !inner[0].isFile()) return layout;
    const sql = readRegularFile(fs, path.join(dir, entry.name, 'migration.sql'), MAX_MIGRATION_BYTES);
    if (sql === null) return layout;
    migrations.push({ name: entry.name, sql });
  }
  if (lock === null) return layout;
  migrations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { ok: true, entries: migrations, lock };
}

// Exact tree: the pinned names, in order, with the pinned bytes and checksums, and the pinned lock.
export function verifyMigrationTree(tree, pins, lockPin) {
  if (!tree || tree.ok !== true) return { ok: false, code: typeof tree?.code === 'string' ? tree.code : 'TREE_LAYOUT' };
  if (!Array.isArray(pins) || pins.length === 0 || !Array.isArray(tree.entries)) return { ok: false, code: 'TREE_NAMES' };
  if (tree.entries.length !== pins.length || tree.entries.some((entry, i) => entry.name !== pins[i].name)) return { ok: false, code: 'TREE_NAMES' };
  for (let i = 0; i < pins.length; i += 1) {
    const sql = tree.entries[i].sql;
    if (!Buffer.isBuffer(sql) || sql.length !== pins[i].bytes || sha256Hex(sql) !== pins[i].sha256) return { ok: false, code: 'TREE_BYTES' };
  }
  if (!Buffer.isBuffer(tree.lock) || tree.lock.length !== lockPin.bytes || sha256Hex(tree.lock) !== lockPin.sha256) return { ok: false, code: 'TREE_LOCK' };
  return { ok: true };
}

// ------------------------------------------------------------------------------------------------------------------ prisma
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

// The repository-local Prisma CLI at the exact version pinned in api/package.json (a range is not a pin), reached through the package's own
// .bin link. Returns the script to run with the current Node binary and its digest (the plan binds it).
export function resolvePrismaCli(apiDir, fs = nodeFs) {
  const unavailable = { ok: false, code: 'PRISMA_CLI_UNAVAILABLE' };
  try {
    const cwd = fs.realpathSync(apiDir);
    const pkgDir = path.join(cwd, 'node_modules', 'prisma');
    const script = fs.realpathSync(path.join(pkgDir, 'build', 'index.js'));
    if (!script.startsWith(`${fs.realpathSync(pkgDir)}${path.sep}`)) return unavailable;
    const bin = path.join(cwd, 'node_modules', '.bin', 'prisma');
    if (!fs.lstatSync(bin).isSymbolicLink() || fs.realpathSync(bin) !== script) return unavailable;
    const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
    const api = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    const pinned = api.devDependencies?.prisma ?? api.dependencies?.prisma;
    if (pkg.name !== 'prisma' || typeof pinned !== 'string' || !EXACT_VERSION.test(pinned) || pkg.version !== pinned) return unavailable;
    if (!fs.lstatSync(path.join(cwd, 'prisma.config.ts')).isFile()) return unavailable;
    // The module the staged config imports: resolved once, inside the package, and bound by its bytes.
    const configModule = fs.realpathSync(path.join(pkgDir, 'config.js'));
    if (!configModule.startsWith(`${fs.realpathSync(pkgDir)}${path.sep}`) || !fs.lstatSync(configModule).isFile()) return unavailable;
    return { ok: true, cwd, script, version: pkg.version, scriptSha256: sha256Hex(fs.readFileSync(script)), configModule, configSha256: sha256Hex(fs.readFileSync(configModule)) };
  } catch {
    return unavailable;
  }
}

const STAGE_SCHEMA = 'prisma/schema.prisma';
const STAGE_CA = 'scripts/certs/supabase-prod-ca-2021.crt';
export const STAGE_DIR_PREFIX = 'hosted-test-upgrade-stage-';

// The config the child loads from inside the private stage: the repository config's semantics (TLS strict, verified against the bundled CA,
// no TLS override accepted from the URL) with the schema and the CA resolved inside the stage, and no URL in the text (the child receives it in
// its environment).
export function buildStagedConfigText(relativeConfigImport) {
  if (typeof relativeConfigImport !== 'string' || relativeConfigImport === '' || /["\\\n\r\0]/.test(relativeConfigImport)) {
    throw new Error('the staged config import specifier is not representable');
  }
  return `import { fileURLToPath } from 'node:url';
import { defineConfig, env } from ${JSON.stringify(relativeConfigImport)};

// Generated for one hosted TEST upgrade run: a private staged copy of the approved bytes.
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

function verifyStage(fs, root, expect) {
  try {
    const rootNames = fs.readdirSync(root).sort();
    if (rootNames.join(',') !== ['prisma', 'prisma.config.ts', 'scripts'].join(',')) return false;
    for (const name of rootNames) if (fs.lstatSync(path.join(root, name)).isSymbolicLink()) return false;
    const config = readRegularFile(fs, path.join(root, 'prisma.config.ts'), 64 * 1024);
    if (config === null || sha256Hex(config) !== expect.stagedConfigSha256) return false;
    const moduleBytes = readRegularFile(fs, expect.configImport, 16 * 1024 * 1024);
    if (moduleBytes === null || sha256Hex(moduleBytes) !== expect.configSha256) return false;
    for (const [rel, sha] of [[STAGE_SCHEMA, expect.schemaSha256], [STAGE_CA, expect.caSha256]]) {
      const bytes = readRegularFile(fs, path.join(root, rel), 4 * 1024 * 1024);
      if (bytes === null || sha256Hex(bytes) !== sha) return false;
    }
    const dir = path.join(root, 'prisma', 'migrations');
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const expectedNames = [...expect.migrations.map((m) => m.name), 'migration_lock.toml'].sort();
    if (entries.map((e) => e.name).sort().join(',') !== expectedNames.join(',')) return false;
    for (const migration of expect.migrations) {
      const inner = fs.readdirSync(path.join(dir, migration.name), { withFileTypes: true });
      if (inner.length !== 1 || inner[0].name !== 'migration.sql' || !inner[0].isFile()) return false;
      const bytes = readRegularFile(fs, path.join(dir, migration.name, 'migration.sql'), MAX_MIGRATION_BYTES);
      if (bytes === null || bytes.length !== migration.bytes || sha256Hex(bytes) !== migration.sha256) return false;
    }
    const lock = readRegularFile(fs, path.join(dir, 'migration_lock.toml'), MAX_LOCK_BYTES);
    return lock !== null && sha256Hex(lock) === expect.lockSha256;
  } catch {
    return false;
  }
}

// A private 0700 copy of exactly the approved bytes, outside the repository. The schema and the CA are checked against the digests the plan
// bound; the whole stage is verified after it is written and again by verify() right before the child starts. cleanup() is idempotent.
export function stageRun({ apiDir, tmpdir, tree, schemaBytes, caBytes, expect, fs = nodeFs }) {
  if (sha256Hex(schemaBytes) !== expect.schemaSha256 || sha256Hex(caBytes) !== expect.caSha256) return { ok: false, code: 'STAGE_INPUT' };
  // The staged config and the module it imports are the ones the plan approved, not whatever this call derives.
  try {
    if (sha256Hex(buildStagedConfigText(expect.configModule)) !== expect.stagedConfigSha256) return { ok: false, code: 'STAGE_INPUT' };
    const moduleBytes = readRegularFile(fs, expect.configModule, 16 * 1024 * 1024);
    if (moduleBytes === null || sha256Hex(moduleBytes) !== expect.configSha256) return { ok: false, code: 'STAGE_INPUT' };
  } catch {
    return { ok: false, code: 'STAGE_INPUT' };
  }
  let root;
  try {
    root = fs.mkdtempSync(path.join(tmpdir, STAGE_DIR_PREFIX));
  } catch {
    return { ok: false, code: 'STAGE_FAILED' };
  }
  const cleanup = () => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* a private temporary directory is left behind at worst */
    }
  };
  try {
    fs.chmodSync(root, 0o700);
    const configImport = expect.configModule;
    const put = (rel, bytes) => fs.writeFileSync(path.join(root, rel), bytes, { mode: 0o600, flag: 'wx' });
    fs.mkdirSync(path.join(root, 'prisma', 'migrations'), { mode: 0o700, recursive: true });
    fs.mkdirSync(path.join(root, 'scripts', 'certs'), { mode: 0o700, recursive: true });
    put('prisma.config.ts', Buffer.from(buildStagedConfigText(configImport), 'utf8'));
    put(STAGE_SCHEMA, schemaBytes);
    put(STAGE_CA, caBytes);
    put('prisma/migrations/migration_lock.toml', tree.lock);
    for (const entry of tree.entries) {
      fs.mkdirSync(path.join(root, 'prisma', 'migrations', entry.name), { mode: 0o700 });
      put(path.join('prisma', 'migrations', entry.name, 'migration.sql'), entry.sql);
    }
    const expectation = {
      configImport,
      configSha256: expect.configSha256,
      stagedConfigSha256: expect.stagedConfigSha256,
      schemaSha256: expect.schemaSha256,
      caSha256: expect.caSha256,
      lockSha256: sha256Hex(tree.lock),
      migrations: tree.entries.map((entry) => ({ name: entry.name, bytes: entry.sql.length, sha256: sha256Hex(entry.sql) })),
    };
    const verify = () => (verifyStage(fs, root, expectation) ? { ok: true } : { ok: false, code: 'STAGE_DRIFT' });
    if (!verify().ok) {
      cleanup();
      return { ok: false, code: 'STAGE_DRIFT' };
    }
    return { ok: true, root, configPath: path.join(root, 'prisma.config.ts'), configImport, verify, cleanup };
  } catch {
    cleanup();
    return { ok: false, code: 'STAGE_FAILED' };
  }
}

// The child gets this and nothing else. The URL is the one derived from the canonical TEST configuration.
export function buildChildEnv({ databaseUrl, home, tmpdir, execPath }) {
  return Object.freeze({
    CHECKPOINT_DISABLE: '1',
    DATABASE_URL: databaseUrl,
    HOME: home,
    NODE_ENV: 'production',
    PATH: `${path.dirname(execPath)}:/usr/bin:/bin`,
    PRISMA_HIDE_UPDATE_MESSAGE: '1',
    TMPDIR: tmpdir,
  });
}

// The one command the tools can run: a deploy of the staged migrations. Literal argv, no shell.
export const deployArgs = (script, configPath) => [script, 'migrate', 'deploy', '--config', configPath];

const defaultKillGroup = (pid, signal) => {
  try {
    globalThis.process.kill(-pid, signal);
  } catch {
    /* already gone */
  }
};

// Runs the deploy once. Output is redacted line by line before it reaches onLine. A timeout kills the whole process group. Never retries.
export function runPrismaDeploy({ spawn, execPath, script, configPath, cwd, env, timeoutMs, redact, onLine, killGroup = defaultKillGroup }) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let timer = null;
    let fallback = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (fallback) clearTimeout(fallback);
      resolve(result);
    };
    let child;
    try {
      child = spawn(execPath, deployArgs(script, configPath), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (error) {
      finish({ code: null, signal: null, timedOut: false, spawnError: typeof error?.code === 'string' && /^[A-Z0-9_]{3,40}$/.test(error.code) ? error.code : 'unexpected' });
      return;
    }
    const pending = { stdout: '', stderr: '' };
    const feed = (stream) => (chunk) => {
      pending[stream] += chunk.toString('utf8');
      const lines = pending[stream].split('\n');
      pending[stream] = lines.pop();
      for (const line of lines) onLine(redact(line));
    };
    child.stdout?.on('data', feed('stdout'));
    child.stderr?.on('data', feed('stderr'));
    child.on('error', (error) => {
      finish({ code: null, signal: null, timedOut: false, spawnError: typeof error?.code === 'string' && /^[A-Z0-9_]{3,40}$/.test(error.code) ? error.code : 'unexpected' });
    });
    child.on('close', (code, signal) => {
      for (const stream of ['stdout', 'stderr']) if (pending[stream] !== '') onLine(redact(pending[stream]));
      finish({ code: code ?? null, signal: signal ?? null, timedOut, spawnError: null });
    });
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid, 'SIGKILL');
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      fallback = setTimeout(() => finish({ code: null, signal: 'SIGKILL', timedOut: true, spawnError: null }), 2000);
      fallback.unref?.();
    }, timeoutMs);
    timer.unref?.();
  });
}

// ------------------------------------------------------------------------------------------------------------------ database
// Discrete connection fields (never a connection string), verified TLS against the bundled CA, bounded connect time.
export function createDefaultClient(held) {
  const client = new pg.Client(buildClientConfig(held, nodeFs.readFileSync(CA_PATH, 'utf8')));
  client.on('error', () => {
    /* Never emit credentials from pg errors; the awaited call fails closed. */
  });
  return client;
}

// One read-only REPEATABLE READ snapshot: `fn` runs inside it, the transaction is always rolled back and the connection always closed, and a
// rollback or a close that cannot be confirmed fails the whole operation.
export async function withSnapshot(createClient, held, fn) {
  const secrets = held ? [held.password, held.host, held.username, held.projectRef, held.markerId] : [];
  let client;
  try {
    client = createClient(held);
  } catch (error) {
    return { ok: false, phase: 'connect', code: failureCode(error, secrets) };
  }
  try {
    await client.connect();
  } catch (error) {
    await confirmed(() => client.end());
    return { ok: false, phase: 'connect', code: failureCode(error, secrets) };
  }
  let value;
  let primary = null;
  let began = false;
  try {
    await client.query(PROOF_BEGIN_SQL);
    began = true;
    value = await fn(client);
  } catch (error) {
    primary = { phase: 'snapshot', code: failureCode(error, secrets) };
  }
  const rolledBack = began ? await confirmed(() => client.query('ROLLBACK')) : true;
  const closed = await confirmed(() => client.end());
  if (primary) return { ok: false, ...primary };
  if (!rolledBack) return { ok: false, phase: 'cleanup', code: 'ROLLBACK_UNCONFIRMED' };
  if (!closed) return { ok: false, phase: 'cleanup', code: 'CLOSE_UNCONFIRMED' };
  return { ok: true, value };
}
