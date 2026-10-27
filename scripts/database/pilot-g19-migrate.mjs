// OWNER-only guarded `prisma migrate deploy` for the PILOT G16 → G19 rollout (sale exchange v1 + the void/exchange guard).
//
//   node scripts/database/pilot-g19-migrate.mjs --target=pilot --dry-run --marker-id=<uuid> \
//     --expected-initial-state=EXACT_G16|EXACT_G17|EXACT_G18
//   node scripts/database/pilot-g19-migrate.mjs --target=pilot --execute --marker-id=<uuid> \
//     --confirm-project-ref=<ref> --expected-initial-state=EXACT_G16|EXACT_G17|EXACT_G18 --plan=<dry-run digest>
//
// The sibling of pilot-g16-migrate.mjs (G14 → G16, which refuses a G19 repository tree and is NOT modified) and of
// pilot-migrate.mjs (the frozen G11 → G14 cut-over). Same guarantees, three generations later: the approved repository tree
// is exactly G19 (the nineteen pins of pilot-migration-generations.mjs); the OWNER names the initial state (EXACT_G16, or
// EXACT_G17 / EXACT_G18 to resume after a failed run that stopped between the three exchange migrations — never inferred;
// those two are intermediates, never a target); --execute requires the plan digest
// the dry run printed. Then, in order: the identity proof; a READ-ONLY pre-check snapshot (REPEATABLE READ READ ONLY,
// pinned search_path, same marker) that must show exactly the expected ledger AND the app-owned schema of that
// generation (reference digest + semantic probes); the final tree proof; ONE Prisma deploy from a private staged
// copy of the approved bytes; and a READ-ONLY post-check that must show exactly EXACT_G19 (ledger, digest, probes).
// A failed deploy or post-check is reported and never repaired: no `migrate resolve`, no retry, no hand fix.
// The migrations are additive (two tables, two columns, enum labels, constraints, indexes, guard and ledger triggers) and are
// the whole of what this tool applies. It does not touch the RBAC catalog (pilot-rbac-catalog-38-upgrade.mjs does).
//
// PENDING BY DESIGN: the app-schema references of EXACT_G17 / EXACT_G18 / EXACT_G19 are generated on a disposable PostgreSQL 17 cluster
// and none was built yet (pilot-g19-schema-references.mjs). Until they are pinned, buildPlan throws and the tool refuses to print a plan
// or to run: it fails closed instead of inventing a digest.
//
// --dry-run opens no database connection and spawns nothing. The child gets an allowlisted environment, runs under
// the same Node binary as this wrapper and its output is redacted line by line. No URL, host, port, user,
// password or project ref is printed.
import { createHash } from 'node:crypto';
import {
  chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PILOT_URL_FILE, createVerifiedClient, deriveProjectRef, main as pilotMarkerMain, parsePilotUrl, readPrivateUrlFile,
} from './pilot-marker.mjs';
import { PROJECT_REF_PATTERN } from './lib.mjs';
import { LEDGER_SQL, LOCK_PIN } from './pilot-migration-states.mjs';
import { pinsOf, requireGeneration } from './pilot-migration-generations.mjs';
import { canonicalJson, projectionDigest, readProjection, runProbes } from './app-schema-projection.mjs';
import { GENERATION_SCHEMA_G19 as GENERATION_SCHEMA } from './pilot-g19-schema-references.mjs';
import {
  API_DIR, PRISMA_ARGS, SNAPSHOT_SQL, buildChildEnv, buildStagedConfigText, createRedactor, readPinned, resolvePrismaCli, verifyStagedRun,
} from './pilot-migrate.mjs';
import {
  buildTargetBinding, buildToolingBinding, readLockedFile, toolingFile, validateTargetBinding, validateToolingBinding,
} from './pilot-plan-binding.mjs';

const PREFIX = '[db:pilot-g19-migrate]';
const URL_FILE_LABEL = '~/.config/mona-jacinta/pilot-database-url';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MODES = ['dry-run', 'execute'];
const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref', 'expected-initial-state', 'plan'];
export const PLAN_FORMAT = 'mona-pilot-g19-migrate-plan/v1';
export const INITIAL_GENERATIONS = Object.freeze(['EXACT_G16', 'EXACT_G17', 'EXACT_G18']);
// This tool's target is G19, as a literal on purpose: a newer generation can never silently retarget it (and the historical G16 tool
// is pinned to 'EXACT_G16' the same way).
export const FINAL_GENERATION = 'EXACT_G19';
export const G19_PAYLOAD = Object.freeze({ migrations: pinsOf(FINAL_GENERATION), lock: LOCK_PIN });
const LOCK_FILE = 'migration_lock.toml';
const MIGRATION_FILE = 'migration.sql';
const STAGE_DIR_PREFIX = 'pilot-g19-migrate-stage-';
const STAGE_CA = 'scripts/certs/supabase-prod-ca-2021.crt';

// G11-ADV-001: every artifact whose bytes can change what --execute does. pilot-migrate.mjs is bound because its
// staged-tree verifier, Prisma resolver, env builder and redactor are imported (the frozen cut-over tool itself
// is not modified).
export const G19_MIGRATE_TOOLING_FILES = Object.freeze([
  toolingFile('module', 'pilot-plan-binding.mjs'),
  toolingFile('module', 'pilot-g19-migrate.mjs'),
  toolingFile('module', 'pilot-migrate.mjs'),
  toolingFile('module', 'pilot-migration-states.mjs'),
  toolingFile('module', 'pilot-migration-generations.mjs'),
  toolingFile('module', 'app-schema-projection.mjs'),
  toolingFile('module', 'pilot-schema-references.mjs'),
  toolingFile('module', 'pilot-g16-schema-references.mjs'),
  toolingFile('module', 'pilot-g19-schema-references.mjs'),
  toolingFile('module', 'pilot-marker.mjs'),
  toolingFile('module', 'lib.mjs'),
  toolingFile('api', 'prisma.config.ts'),
  toolingFile('api', 'prisma/schema.prisma'),
  toolingFile('repo', STAGE_CA),
]);

// Exact-tree verification of <apiDir>/prisma/migrations against the G19 payload: exactly its migration directories,
// each holding exactly one regular migration.sql with the pinned size and SHA-256, plus the pinned lock naming
// exactly the pinned provider. A G16 tree (a missing migration), an extra, renamed, symlinked or changed entry is drift.
export function verifyG19Tree(apiDir, payload = G19_PAYLOAD) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    const api = realpathSync(apiDir);
    const prismaDir = path.join(api, 'prisma');
    const root = path.join(prismaDir, 'migrations');
    for (const dir of [prismaDir, root]) {
      if (!lstatSync(dir).isDirectory()) return fail(`${path.relative(api, dir)} must be a real directory, not a symlink`);
    }
    if (realpathSync(root) !== root) return fail('api/prisma/migrations is not at its canonical location');
    const entries = readdirSync(root, { withFileTypes: true });
    const actual = entries.map((e) => e.name).sort();
    const expected = [...payload.migrations.map((m) => m.name), LOCK_FILE].sort();
    if (actual.length !== expected.length || actual.some((name, i) => name !== expected[i])) {
      return fail('api/prisma/migrations does not hold exactly the approved G19 migrations and migration_lock.toml');
    }
    const migrations = [];
    for (const m of payload.migrations) {
      const entry = entries.find((e) => e.name === m.name);
      if (!entry.isDirectory()) return fail(`${m.name} is not a real directory`);
      const dir = path.join(root, m.name);
      const inner = readdirSync(dir, { withFileTypes: true });
      if (inner.length !== 1 || inner[0].name !== MIGRATION_FILE || !inner[0].isFile()) return fail(`${m.name} must contain exactly one regular ${MIGRATION_FILE}`);
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
    if (providers.length !== 1 || providers[0] !== payload.lock.provider) return fail(`${LOCK_FILE} provider is not exactly "${payload.lock.provider}"`);
    return { ok: true, migrations, lock: { sha256: lock.sha256, provider: providers[0] } };
  } catch {
    return fail('migration payload could not be read');
  }
}

export function parseCliArgs(argv) {
  const values = {};
  const modes = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (MODES.includes(body)) { modes.push(body); continue; }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (modes.length !== 1) return { ok: false, error: 'Specify exactly one of --dry-run or --execute' };
  const [mode] = modes;
  if (values.target !== 'pilot') return { ok: false, error: 'Exactly --target=pilot is required' };
  if (!UUID_V4.test(values['marker-id'] ?? '')) return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  const confirmProjectRef = values['confirm-project-ref'] ?? null;
  const plan = values.plan ?? null;
  if (mode === 'dry-run' && (confirmProjectRef !== null || plan !== null)) return { ok: false, error: '--confirm-project-ref and --plan are accepted only with --execute' };
  if (mode === 'execute' && (confirmProjectRef === null || !PROJECT_REF_PATTERN.test(confirmProjectRef))) {
    return { ok: false, error: '--execute requires --confirm-project-ref=<20-character lowercase project ref>' };
  }
  const initialState = values['expected-initial-state'];
  if (!INITIAL_GENERATIONS.includes(initialState)) return { ok: false, error: `--expected-initial-state must be exactly one of ${INITIAL_GENERATIONS.join(' | ')}` };
  if (mode === 'execute' && (plan === null || !HEX64.test(plan))) return { ok: false, error: '--execute requires --plan=<64-hex plan digest printed by the dry run>' };
  return { ok: true, mode, markerId: values['marker-id'], confirmProjectRef, initialState, plan };
}

// The plan the OWNER approves: one exact target and tooling binding, the initial generation, the exact pins to apply,
// the exact final ledger, the lock, the Prisma command and the schema reference digests both generations are checked
// against. Throws when a reference is missing or a binding is absent or malformed. No database.
export function buildPlan({ initialState, payload = G19_PAYLOAD, prismaVersion, schema = GENERATION_SCHEMA, targetBinding, toolingBinding }) {
  if (!validateTargetBinding(targetBinding)) throw new Error('the plan must carry an exact binding of the target (G11-ADV-001)');
  if (!validateToolingBinding(toolingBinding)) throw new Error('the plan must carry an exact binding of the tooling (G11-ADV-001)');
  if (!INITIAL_GENERATIONS.includes(initialState)) throw new Error('unknown initial generation');
  const initialRef = schema?.references?.[initialState]?.digest;
  const finalRef = schema?.references?.[FINAL_GENERATION]?.digest;
  if (!HEX64.test(String(initialRef)) || !HEX64.test(String(finalRef))) throw new Error('schema reference missing');
  const initial = pinsOf(initialState);
  const apply = payload.migrations.slice(initial.length).map((m) => ({ name: m.name, sha256: m.sha256 }));
  const plan = {
    format: PLAN_FORMAT, target: 'pilot', targetBinding, toolingBinding, initialState,
    initialLedger: initial.map((m) => m.name), apply,
    finalState: FINAL_GENERATION, finalLedger: payload.migrations.map((m) => ({ name: m.name, sha256: m.sha256 })),
    lockSha256: payload.lock.sha256, prisma: { version: prismaVersion, args: [...PRISMA_ARGS] },
    schemaReferences: { [initialState]: initialRef, [FINAL_GENERATION]: finalRef },
  };
  return { plan, digest: createHash('sha256').update(canonicalJson(plan)).digest('hex') };
}

// Builds the private staging tree for one --execute run (same layout and checks as pilot-migrate's stage, for the G19
// payload). Every byte comes through the hardened reads; the copy is verified, and again before the spawn.
export function stageG19Run({ apiDir, tmpdir, payload = G19_PAYLOAD, toolingBinding }) {
  const fail = (reason) => ({ ok: false, reason });
  const byPath = (rel) => toolingBinding.files.find((f) => f.path === rel);
  const schemaEntry = byPath('prisma/schema.prisma');
  const certEntry = byPath(STAGE_CA);
  if (!schemaEntry || !certEntry) return fail('the tooling binding must carry the schema and the CA cert');
  let root;
  try { root = mkdtempSync(path.join(tmpdir, STAGE_DIR_PREFIX)); } catch { return fail('the staging root could not be created under the process tmpdir'); }
  const drop = () => { try { rmSync(root, { recursive: true, force: true }); } catch { /* private temp garbage */ } };
  try {
    const configImport = path.relative(root, path.join(apiDir, 'node_modules', 'prisma', 'config.js')).split(path.sep).join('/');
    if (configImport === '' || configImport.startsWith('/')) { drop(); return fail('the staged config import path is not representable'); }
    mkdirSync(path.join(root, 'prisma', 'migrations'), { mode: 0o700, recursive: true });
    mkdirSync(path.join(root, 'scripts', 'certs'), { mode: 0o700, recursive: true });
    const put = (rel, bytes) => writeFileSync(path.join(root, rel), bytes, { mode: 0o600, flag: 'wx' });
    put('prisma.config.ts', Buffer.from(buildStagedConfigText(configImport)));
    const schema = readLockedFile(path.join(apiDir, 'prisma', 'schema.prisma'));
    if (!schema.ok) { drop(); return fail(`the schema could not be read for staging: ${schema.reason}`); }
    put('prisma/schema.prisma', schema.bytes);
    const cert = readLockedFile(path.resolve(apiDir, '..', STAGE_CA));
    if (!cert.ok) { drop(); return fail(`the TLS trust anchor could not be read for staging: ${cert.reason}`); }
    put(STAGE_CA, cert.bytes);
    const lock = readPinned(path.join(apiDir, 'prisma', 'migrations', LOCK_FILE), payload.lock.bytes);
    if (!lock.ok || lock.sha256 !== payload.lock.sha256) { drop(); return fail('the migration lock could not be staged from the verified payload'); }
    put(`prisma/migrations/${LOCK_FILE}`, lock.bytes);
    for (const m of payload.migrations) {
      const one = readPinned(path.join(apiDir, 'prisma', 'migrations', m.name, MIGRATION_FILE), m.bytes);
      if (!one.ok || one.sha256 !== m.sha256) { drop(); return fail(`a migration could not be staged from the verified payload: ${m.name}`); }
      mkdirSync(path.join(root, 'prisma', 'migrations', m.name), { mode: 0o700, recursive: true });
      put(path.join('prisma', 'migrations', m.name, MIGRATION_FILE), one.bytes);
    }
    chmodSync(root, 0o700);
    const expect = {
      configImport, schemaSha256: schemaEntry.sha256, certSha256: certEntry.sha256, lockSha256: payload.lock.sha256,
      migrations: payload.migrations.map((m) => ({ name: m.name, bytes: m.bytes, sha256: m.sha256 })),
    };
    const verify = () => verifyStagedRun(root, expect);
    const first = verify();
    if (!first.ok) { drop(); return fail(first.reason); }
    return { ok: true, root, expect, verify, cleanup: drop };
  } catch (stageError) {
    drop();
    const code = stageError && typeof stageError.code === 'string' ? ` (${stageError.code})` : '';
    return fail(`the staging copy could not be built${code}`);
  }
}

// One read-only snapshot on a verified client: REPEATABLE READ READ ONLY, pinned search_path and timeouts, read-only
// proven, the same PILOT marker, then the ledger and the app-owned schema projection; always ROLLBACK.
export async function readSnapshot(deps, conn, markerId) {
  const fail = (reason) => ({ ok: false, reason });
  let client;
  try { client = deps.createClient(conn); } catch { return fail('a read-only client could not be created'); }
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
    const message = typeof err?.message === 'string' && err.message.startsWith('projection: ') ? err.message : 'the read-only snapshot could not be read';
    return fail(message);
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }
}

// Exactly `generation`: ledger, app-schema reference digest and every probe of that generation.
export function verifyGenerationSnapshot(snapshot, generation, schema = GENERATION_SCHEMA) {
  const ledger = requireGeneration(snapshot.ledger, generation);
  if (!ledger.ok) return { ok: false, reason: ledger.reason, failures: [] };
  const digest = projectionDigest(snapshot.projection);
  const failures = runProbes(snapshot.projection, schema.probes[generation] ?? []);
  if (digest !== schema.references[generation]?.digest) return { ok: false, reason: `the app schema is not the ${generation} reference`, failures, digest };
  if (failures.length > 0) return { ok: false, reason: `a ${generation} semantic probe failed`, failures, digest };
  return { ok: true, digest, probes: (schema.probes[generation] ?? []).length };
}

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
  return () => { emit(decoder.end()); if (pending) sink(redact(pending)); pending = ''; };
}

// Resolves once; success is ONLY an observed exit code 0 with no signal.
function runChild(deps, command, args, options, redact) {
  return new Promise((settle) => {
    let child;
    try { child = deps.spawn(command, args, options); } catch { return settle({ ok: false, started: false, detail: 'prisma could not be started' }); }
    const flushOut = lineForwarder(child.stdout, redact, (line) => deps.log(`  prisma| ${line}`));
    const flushErr = lineForwarder(child.stderr, redact, (line) => deps.error(`  prisma| ${line}`));
    child.on('error', () => settle({ ok: false, detail: 'prisma could not be started or failed to run' }));
    child.on('close', (code, signal) => {
      flushOut(); flushErr();
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
  schema: GENERATION_SCHEMA,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function main(argv, deps = defaultDeps) {
  const result = (value) => deps.log(`PILOT_G19_MIGRATE_RESULT=${value}`);
  const fail = (phase, detail) => { deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`); return 1; };

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);
  const prisma = resolvePrismaCli(deps.apiDir);
  if (!prisma.ok) return fail('prisma', prisma.reason);

  // The ONLY read of the private file. Everything after uses this in-memory string.
  let file;
  try { file = deps.readUrlFile(deps.urlFile); } catch { file = { ok: false, reason: 'private URL file could not be read' }; }
  if (!file.ok) return fail('config', `${URL_FILE_LABEL}: ${file.reason}`);
  const heldUrl = typeof file.text === 'string' ? file.text.replace(/\r?\n$/, '') : '';
  const parsedUrl = parsePilotUrl(heldUrl);
  if (!parsedUrl.ok) return fail('config', `${URL_FILE_LABEL} must hold one PostgreSQL URL with user, password, host and database and no query/fragment (value not shown)`);
  const payload = verifyG19Tree(deps.apiDir);
  if (!payload.ok) return fail('payload', `${payload.reason}; nothing was started`);
  const redact = createRedactor(heldUrl);

  const projectRef = deriveProjectRef(parsedUrl.conn);
  if (projectRef === null) return fail('target', `${URL_FILE_LABEL} does not carry a derivable project ref; a plan cannot bind its target (nothing was started)`);
  let targetBinding;
  let toolingBinding;
  try {
    targetBinding = buildTargetBinding({ environment: 'pilot', projectRef, host: parsedUrl.conn.host, database: parsedUrl.conn.database, markerId: parsed.markerId });
    toolingBinding = buildToolingBinding({
      moduleDir: deps.moduleDir, apiDir: deps.apiDir, repoDir: path.dirname(String(deps.apiDir).replace(/\/+$/, '')), files: G19_MIGRATE_TOOLING_FILES,
    });
  } catch (error) {
    return fail('binding', `${error?.message ?? 'the target/tooling binding could not be built'}; nothing was started`);
  }
  let planned;
  try {
    planned = buildPlan({ initialState: parsed.initialState, prismaVersion: prisma.version, schema: deps.schema, targetBinding, toolingBinding });
  } catch {
    return fail('reference', `no generated app-schema reference for ${parsed.initialState} and ${FINAL_GENERATION} (pilot-g16-schema-references.mjs); nothing was started`);
  }
  const pending = planned.plan.apply;

  if (parsed.mode === 'dry-run') {
    for (const line of [
      `${PREFIX} DRY RUN — no database connection was opened and no migration was executed`,
      '  target: PILOT',
      `  private URL file: accepted (${URL_FILE_LABEL}; value not shown; read once, never re-read)`,
      `  marker id: ${parsed.markerId} (syntax accepted; proven against the database only during --execute)`,
      '  project identity: bound to the plan (project ref, host, database, marker id — values not shown); --execute requires --confirm-project-ref to match',
      `  tooling binding: bound (${toolingBinding.files.length} repository artifacts by SHA-256 — values not shown)`,
      `  Prisma CLI: repository-local prisma ${prisma.version}, run with this Node binary`,
      `  migration payload: PASS — exactly ${G19_PAYLOAD.migrations.length} OWNER-approved migrations (G19), SHA-256 approval binding active`,
      ...payload.migrations.map((m, i) => `    ${i + 1}. ${m.name}  sha256 ${m.sha256}`),
      `  migration_lock.toml: PASS (provider "${payload.lock.provider}", sha256 ${payload.lock.sha256})`,
      `  INITIAL_STATE=${parsed.initialState} (explicit; the pre-check refuses any other ledger or schema)`,
      `    required ledger: exactly ${planned.plan.initialLedger.length} migrations; app schema reference ${planned.plan.schemaReferences[parsed.initialState]}`,
      `  migrations to apply: ${pending.length}`,
      ...pending.map((m) => `    + ${m.name}  sha256 ${m.sha256}`),
      `  FINAL_STATE=${FINAL_GENERATION} (exactly ${G19_PAYLOAD.migrations.length} migrations; app schema reference ${planned.plan.schemaReferences[FINAL_GENERATION]})`,
      `  post-check: read-only; anything but ${FINAL_GENERATION} → PILOT_G19_MIGRATE_RESULT=RESTORE_REQUIRED (never resolve, retry or repair)`,
      `  PLAN_DIGEST=${planned.digest}`,
      '  payload is re-verified during --execute: before the identity proof AND again immediately before spawning',
      '  child cwd: a fresh private staged copy of the approved migration bytes (0700/0600, exact-tree verified twice); removed after the run',
      `  command: prisma ${PRISMA_ARGS.join(' ')}`,
      '  never run: seed, reset, migrate dev, db push, migrate resolve, retries; the RBAC catalog is NOT touched by this tool',
      '  STILL REQUIRED before --execute: a verified EXACT_G16 backup + clone restore (pilot-g19-backup / pilot-g19-clone-restore) and explicit OWNER approval naming PILOT and this PLAN_DIGEST (--plan=…)',
    ]) deps.log(line);
    return 0;
  }

  if (parsed.plan !== planned.digest) {
    return fail('plan', 'PLAN_BINDING_MISMATCH: --plan is not the digest of this exact plan binding (target, tooling, payload, states); re-run --dry-run and approve its PLAN_DIGEST; nothing was started');
  }
  if (projectRef !== parsed.confirmProjectRef) return fail('target', `--confirm-project-ref does not match the project addressed by ${URL_FILE_LABEL} (values not shown)`);

  const proof = await pilotMarkerMain(['--target=pilot', '--check', `--marker-id=${parsed.markerId}`], {
    urlFile: deps.urlFile, readUrlFile: () => ({ ok: true, text: heldUrl }), env: deps.env, createClient: deps.createClient,
    log: (line) => deps.log(redact(line)), error: (line) => deps.error(redact(line)),
  });
  if (proof !== 0) return fail('identity', 'PILOT identity proof failed; prisma was NOT started');

  // Read-only pre-check: exactly the OWNER-named initial generation, ledger AND schema.
  const pre = await readSnapshot(deps, parsedUrl.conn, parsed.markerId);
  if (!pre.ok) return fail('precheck', `${pre.reason}; prisma was NOT started`);
  const preVerdict = verifyGenerationSnapshot(pre, parsed.initialState, deps.schema);
  if (!preVerdict.ok) {
    for (const f of preVerdict.failures) deps.error(`  ${f}`);
    return fail('precheck', `${preVerdict.reason}; prisma was NOT started`);
  }
  deps.log(`${PREFIX} precheck ok — ledger ${parsed.initialState}, app schema ${preVerdict.digest} = reference, probes ${preVerdict.probes}/${preVerdict.probes}`);

  const final = verifyG19Tree(deps.apiDir);
  if (!final.ok) return fail('payload', `${final.reason}; changed after the initial check — prisma was NOT started`);

  const env = buildChildEnv(heldUrl, deps);
  const staged = stageG19Run({ apiDir: deps.apiDir, tmpdir: deps.tmpdir, toolingBinding });
  if (!staged.ok) return fail('stage', `${staged.reason}; nothing was applied`);
  let outcome;
  try {
    const reverify = staged.verify();
    if (!reverify.ok) return fail('stage', `${reverify.reason}; nothing was applied`);
    outcome = await runChild(deps, deps.execPath, [prisma.script, ...PRISMA_ARGS], { cwd: staged.root, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false }, redact);
  } finally {
    staged.cleanup();
  }
  const restoreRequired = (phase, detail) => {
    deps.error(`${PREFIX} RESTORE_REQUIRED — PILOT is not proven ${FINAL_GENERATION}. Never run \`prisma migrate resolve\`, never retry and never repair by hand:`);
    deps.error('  the approved rollback before any sale exchange write is the restore of the verified pre-rollout backup; an exact EXACT_G17 or EXACT_G18 may only be resumed by a new dry run with --expected-initial-state=EXACT_G17|EXACT_G18 and a new OWNER approval.');
    result('RESTORE_REQUIRED');
    return fail(phase, detail);
  };
  if (!outcome.ok) {
    if (outcome.started === false) return fail('prisma', `${outcome.detail}; nothing was applied`);
    const seen = await readSnapshot(deps, parsedUrl.conn, parsed.markerId);
    const resumable = seen.ok ? INITIAL_GENERATIONS.slice(1).find((g) => requireGeneration(seen.ledger, g).ok) : undefined;
    deps.error(`  post-failure ledger: ${seen.ok ? (resumable ? `${resumable} (resumable only by a new approved plan)` : requireGeneration(seen.ledger, FINAL_GENERATION).reason) : seen.reason}`);
    return restoreRequired('prisma', `${outcome.detail}; migrations may be partially applied`);
  }
  const post = await readSnapshot(deps, parsedUrl.conn, parsed.markerId);
  if (!post.ok) return restoreRequired('postcheck', post.reason);
  const postVerdict = verifyGenerationSnapshot(post, FINAL_GENERATION, deps.schema);
  if (!postVerdict.ok) {
    for (const f of postVerdict.failures) deps.error(`  ${f}`);
    return restoreRequired('postcheck', postVerdict.reason);
  }
  deps.log(`${PREFIX} postcheck ok — ledger ${FINAL_GENERATION}, app schema ${postVerdict.digest} = reference, probes ${postVerdict.probes}/${postVerdict.probes}`);
  deps.log(`${PREFIX} OK — the Prisma deploy exited 0 and PILOT is proven ${FINAL_GENERATION}; next: RBAC 37 → 38 (pilot-rbac-catalog-38-upgrade.mjs), then deploy the API`);
  result(FINAL_GENERATION);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
