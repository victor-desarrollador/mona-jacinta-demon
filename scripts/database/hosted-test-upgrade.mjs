import { spawn as nodeSpawn } from 'node:child_process';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { env as processEnv, execPath as processExecPath } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { projectionDigest, readProjection, runProbes } from './app-schema-projection.mjs';
import { classifyMigrationHistory, readMigrationHistory } from './d5h-preflight.mjs';
import { MAX_EVIDENCE_AGE_MS, buildChildEnv, buildEvidence, buildStagedConfigText, checkEnvironment, confirmTarget, createDefaultClient, hashToolingFiles, makeRedactor, parseEvidence, parseStrictArgs, readMigrationTree, readRegularFile, readTarget, renderEvidence, resolvePrismaCli, runPrismaDeploy, sha256Hex, stageRun, verifyMigrationTree, withSnapshot, writeExclusive } from './hosted-test-common.mjs';
import { toConnectionString } from './hosted-test-config.mjs';
import { CA_PATH, PROJECT_REF_PATTERN, canonicalJson, manifestPathFor, parseBackupManifest, verifyBackupPair } from './lib.mjs';
import { GENERATION_PROBES_G20, SCHEMA_REFERENCES_G20 } from './pilot-g20-schema-references.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';
import { LOCK_PIN } from './pilot-migration-states.mjs';
import { proveInstalledMarkerInTransaction } from './test-marker.mjs';

// Hosted TEST upgrade: EXACT_G6 -> EXACT_G20, by applying the 14 migrations that already exist in the repository and nothing else.
//
//   node scripts/database/hosted-test-upgrade.mjs --target=test --check   --marker-id=<uuid> --expected-initial-state=EXACT_G6 [--evidence-out=<abs>]
//   node scripts/database/hosted-test-upgrade.mjs --target=test --dry-run --marker-id=<uuid> --expected-initial-state=EXACT_G6 \
//        --backup-evidence=<abs .dump> --identity-evidence=<abs .json>
//   node scripts/database/hosted-test-upgrade.mjs --target=test --execute --marker-id=<uuid> --expected-initial-state=EXACT_G6 \
//        --backup-evidence=<abs .dump> --identity-evidence=<abs .json> --confirm-project-ref=<ref> --plan=<digest the dry-run printed>
//
// What it is: the target is the hosted TEST database described by the canonical TEST configuration (hosted-test-config.mjs) and by nothing else.
// The only initial state is EXACT_G6: no resume state exists. --check is strictly read-only. --dry-run opens no database connection (it only lists the local backup with pg_restore --list); it prints the plan digest. --execute proves the identity, proves the ledger is exactly G6 and that no object of G7..G20 exists, checks the
// backup and the identity evidence, stages the verified bytes privately, runs ONE `prisma migrate deploy`, and proves G20 in a fresh snapshot.
// A failure is reported and never repaired, retried or resolved.
//
// What it is not: it writes no data, touches no RBAC catalog, no fixture and no other database. Its only writes are the Prisma deploy of the
// approved migrations and the exclusive (wx, 0600) evidence files next to the backup.

export const PLAN_FORMAT = 'mona-hosted-test-upgrade-plan/v1';
export const IDENTITY_FORMAT = 'mona-hosted-test-identity/v1';
export const EVIDENCE_FORMAT = 'mona-hosted-test-upgrade-evidence/v1';
export const RESULT_FORMAT = 'mona-hosted-test-upgrade-result/v1';
export const INITIAL_STATE = 'EXACT_G6';
export const TARGET_STATE = 'EXACT_G20';

const BASELINE_COUNT = 6;
const TARGET_COUNT = 20;
const DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;
const FOREIGN_GUARD_SCHEMAS = Object.freeze(['mona_pilot_guard', 'mona_local_test_guard']);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_JSON_BYTES = 1024 * 1024;

// Every file whose bytes decide what this tool does. The plan binds their digests: edit one and the plan an operator approved no longer matches.
export const TOOLING_FILES = Object.freeze([
  'hosted-test-upgrade.mjs', 'hosted-test-common.mjs', 'hosted-test-config.mjs', 'd5h-preflight.mjs', 'test-marker.mjs', 'lib.mjs',
  'app-schema-projection.mjs', 'pilot-migration-generations.mjs', 'pilot-migration-states.mjs', 'pilot-g20-schema-references.mjs',
  'pilot-g19-schema-references.mjs', 'pilot-g16-schema-references.mjs', 'pilot-schema-references.mjs',
]);

// ------------------------------------------------------------------------------------------------------------------ arguments
const SPEC = Object.freeze({
  modes: ['check', 'dry-run', 'execute'],
  values: ['target', 'marker-id', 'expected-initial-state', 'backup-evidence', 'identity-evidence', 'confirm-project-ref', 'plan', 'evidence-out'],
});
const MODE_ARGS = Object.freeze({
  check: { required: [], optional: ['evidence-out'] },
  'dry-run': { required: ['backup-evidence', 'identity-evidence'], optional: [] },
  execute: { required: ['backup-evidence', 'identity-evidence', 'confirm-project-ref', 'plan'], optional: [] },
});

export function parseCliArgs(argv) {
  const base = parseStrictArgs(argv, SPEC);
  if (!base.ok) return base;
  const invalid = (reason) => ({ ok: false, code: 'ARGS_INVALID', reason });
  const { mode, values: v } = base;
  if (v.target !== 'test') return invalid('TARGET');
  if (!UUID_V4.test(v['marker-id'] ?? '')) return invalid('MARKER');
  if (v['expected-initial-state'] !== INITIAL_STATE) return invalid('STATE');
  const { required, optional } = MODE_ARGS[mode];
  const allowed = new Set(['target', 'marker-id', 'expected-initial-state', ...required, ...optional]);
  if (Object.keys(v).some((key) => !allowed.has(key))) return invalid('ARG_NOT_FOR_MODE');
  if (required.some((key) => !Object.hasOwn(v, key))) return invalid('ARG_MISSING');
  for (const key of ['backup-evidence', 'identity-evidence', 'evidence-out']) {
    if (Object.hasOwn(v, key) && !path.isAbsolute(v[key])) return invalid('PATH_NOT_ABSOLUTE');
  }
  if (Object.hasOwn(v, 'plan') && !HEX64.test(v.plan)) return invalid('PLAN');
  if (Object.hasOwn(v, 'confirm-project-ref') && !PROJECT_REF_PATTERN.test(v['confirm-project-ref'])) return invalid('PROJECT_REF');
  const values = { target: v.target, marker: v['marker-id'], state: v['expected-initial-state'] };
  if (Object.hasOwn(v, 'backup-evidence')) values.backup = v['backup-evidence'];
  if (Object.hasOwn(v, 'identity-evidence')) values.identity = v['identity-evidence'];
  if (Object.hasOwn(v, 'confirm-project-ref')) values.confirm = v['confirm-project-ref'];
  if (Object.hasOwn(v, 'plan')) values.plan = v.plan;
  if (Object.hasOwn(v, 'evidence-out')) values.evidenceOut = v['evidence-out'];
  return { ok: true, mode, values };
}

// ------------------------------------------------------------------------------------------------------------------ what "from the future" means
// The names the pending migrations create, taken from their (already verified) SQL. Their absence is part of the G6 proof.
export function deriveAdvancedObjects(sqlTexts) {
  const spec = { tables: new Set(), types: new Set(), columns: [], enumLabels: [], indexes: new Set(), constraints: new Set(), functions: new Set(), triggers: new Set() };
  for (const raw of sqlTexts) {
    const sql = raw.replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/CREATE TYPE\s+"?(\w+)"?/gi)) spec.types.add(m[1]);
    for (const m of sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?/gi)) spec.tables.add(m[1]);
    for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?/gi)) spec.indexes.add(m[1]);
    for (const m of sql.matchAll(/\bCONSTRAINT\s+"(\w+)"/gi)) spec.constraints.add(m[1]);
    for (const m of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION\s+(?:public\.)?"?(\w+)"?/gi)) spec.functions.add(m[1]);
    for (const m of sql.matchAll(/CREATE (?:CONSTRAINT )?TRIGGER\s+"?(\w+)"?/gi)) spec.triggers.add(m[1]);
    for (const statement of sql.matchAll(/ALTER TABLE\s+(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+([\s\S]*?);/gi)) {
      for (const column of statement[2].matchAll(/ADD COLUMN\s+(?:IF NOT EXISTS\s+)?"?(\w+)"?/gi)) spec.columns.push([statement[1], column[1]]);
    }
    for (const m of sql.matchAll(/ALTER TYPE\s+"?(\w+)"?\s+ADD VALUE\s+(?:IF NOT EXISTS\s+)?'([^']+)'/gi)) spec.enumLabels.push([m[1], m[2]]);
  }
  return spec;
}

// Which of those names exist in an app-schema projection. Empty for a database that is really G6.
export function findAdvancedObjects(projection, spec) {
  const found = [];
  const tables = new Map(projection.tables.map((t) => [t.name, t]));
  for (const name of spec.tables) if (tables.has(name)) found.push(`table:${name}`);
  for (const [table, column] of spec.columns) if (tables.get(table)?.columns.some((c) => c.name === column)) found.push(`column:${table}.${column}`);
  const enums = new Map(projection.enums.map((e) => [e.name, e]));
  for (const name of spec.types) if (enums.has(name)) found.push(`enumType:${name}`);
  for (const name of spec.types) if ((projection.types ?? []).some((t) => t.name === name)) found.push(`type:${name}`);
  for (const [type, label] of spec.enumLabels) if (enums.get(type)?.labels.includes(label)) found.push(`enumLabel:${type}.${label}`);
  for (const name of spec.constraints) if (projection.constraints.some((c) => c.name === name)) found.push(`constraint:${name}`);
  for (const name of spec.indexes) if (projection.indexes.some((i) => i.name === name)) found.push(`index:${name}`);
  for (const name of spec.functions) if (projection.functions.some((f) => f.name === name)) found.push(`function:${name}`);
  for (const name of spec.triggers) if (projection.triggers.some((t) => t.name === name)) found.push(`trigger:${name}`);
  return found;
}

// ------------------------------------------------------------------------------------------------------------------ ledger
// EXACT_G6: the first six pins APPLIED_CLEAN, the other fourteen MISSING, nothing unknown. EXACT_G20: all twenty APPLIED_CLEAN. Nothing in between.
export function classifyLedger(rows, pins) {
  if (!Array.isArray(rows)) return { state: 'OTHER', statuses: [], unexpected: 0, counts: {} };
  const verdict = classifyMigrationHistory(rows, pins.map((p) => ({ name: p.name, sha256: p.sha256 })));
  const statuses = verdict.migrations.map((m) => m.status);
  const counts = {};
  for (const status of statuses) counts[status] = (counts[status] ?? 0) + 1;
  const baselineClean = statuses.slice(0, BASELINE_COUNT).every((s) => s === 'APPLIED_CLEAN');
  const restMissing = statuses.slice(BASELINE_COUNT).every((s) => s === 'MISSING');
  let state = 'OTHER';
  if (verdict.unexpected === 0 && statuses.length === TARGET_COUNT) {
    if (baselineClean && restMissing) state = INITIAL_STATE;
    else if (statuses.every((s) => s === 'APPLIED_CLEAN')) state = TARGET_STATE;
  }
  return { state, statuses: verdict.migrations, unexpected: verdict.unexpected, counts };
}

// ------------------------------------------------------------------------------------------------------------------ plan
// The plan the operator approves. Digests and fixed labels only; no URL, host, user, password, project ref or marker id.
export function buildPlan(inputs) {
  const document = {
    format: PLAN_FORMAT,
    initialState: INITIAL_STATE,
    targetState: TARGET_STATE,
    command: 'prisma migrate deploy (one run, staged bytes, literal argv)',
    migrations: inputs.pins.map((p) => ({ name: p.name, sha256: p.sha256 })),
    lock: { bytes: inputs.lockPin.bytes, sha256: inputs.lockPin.sha256 },
    prisma: { version: inputs.prisma.version, scriptSha256: inputs.prisma.scriptSha256, configSha256: inputs.prisma.configSha256 },
    schemaSha256: inputs.schemaSha256,
    caSha256: inputs.caSha256,
    stagedConfigSha256: inputs.stagedConfigSha256,
    referenceDigest: inputs.referenceDigest,
    tooling: [...inputs.tooling].sort((a, b) => (a.file < b.file ? -1 : 1)).map((t) => ({ file: t.file, sha256: t.sha256 })),
    targetDigest: inputs.targetDigest,
    markerDigest: inputs.markerDigest,
    backup: { file: inputs.backup.file, sha256: inputs.backup.sha256, setId: inputs.backup.setId, createdAt: inputs.backup.createdAt },
    identityEvidenceSha256: inputs.identityEvidenceSha256,
  };
  return { digest: sha256Hex(`${PLAN_FORMAT}\n${canonicalJson(document)}`), document };
}

// ------------------------------------------------------------------------------------------------------------------ default collaborators
const defaultReadServerVersion = async (client) => Number((await client.query("SELECT current_setting('server_version_num') AS n")).rows[0]?.n);
const defaultReadForeignGuards = async (client) => (await client.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1::text[])', [FOREIGN_GUARD_SCHEMAS])).rows.map((r) => r.nspname);

export function buildDefaultDeps() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..');
  const apiDir = path.join(repoRoot, 'api');
  return {
    env: processEnv,
    execPath: processExecPath,
    readConfigBytes: () => nodeFs.readFileSync(path.join(repoRoot, '.env.development')),
    pins: pinsOf(TARGET_STATE),
    lockPin: LOCK_PIN,
    apiDir,
    tmpdir: os.tmpdir(),
    fs: nodeFs,
    readTree: () => readMigrationTree(path.join(apiDir, 'prisma', 'migrations'), nodeFs),
    supportFiles: () => ({
      schemaBytes: readRegularFile(nodeFs, path.join(apiDir, 'prisma', 'schema.prisma'), 4 * 1024 * 1024),
      caBytes: readRegularFile(nodeFs, CA_PATH, 1024 * 1024),
    }),
    resolvePrismaCli: () => resolvePrismaCli(apiDir, nodeFs),
    toolingDigests: () => hashToolingFiles(here, TOOLING_FILES, nodeFs),
    reference: { digest: SCHEMA_REFERENCES_G20.EXACT_G20.digest, probes: GENERATION_PROBES_G20.EXACT_G20 },
    createClient: createDefaultClient,
    proveMarker: proveInstalledMarkerInTransaction,
    readLedger: readMigrationHistory,
    readProjection,
    readServerVersion: defaultReadServerVersion,
    readForeignGuards: defaultReadForeignGuards,
    verifyBackupPair: (args) => verifyBackupPair(args),
    now: () => new Date(),
    stage: (options) => stageRun(options),
    runDeploy: (options) => runPrismaDeploy({ spawn: nodeSpawn, ...options }),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

// ------------------------------------------------------------------------------------------------------------------ one run
const fail = (mode, phase, code, extra = {}) => ({ format: RESULT_FORMAT, mode, result: 'FAIL', phase, code, ...extra });
const summarizeLedger = (verdict) => ({ state: verdict.state, counts: verdict.counts, unexpected: verdict.unexpected });

// One read-only snapshot: marker, ledger, projection, server version and the foreign guard schemas, all in the same transaction.
async function takeSnapshot(deps, held) {
  const taken = await withSnapshot(deps.createClient, held, async (client) => {
    const verdict = await deps.proveMarker(client, held.markerId);
    if (!verdict || verdict.ok !== true) return { markerOk: false };
    return {
      markerOk: true,
      history: await deps.readLedger(client),
      projection: await deps.readProjection(client),
      serverVersionNum: await deps.readServerVersion(client),
      guards: await deps.readForeignGuards(client),
    };
  });
  if (!taken.ok) return taken;
  if (!taken.value.markerOk) return { ok: false, phase: 'marker', code: 'MARKER_NOT_PROVEN' };
  return taken;
}

// The pre-upgrade verdict over one snapshot. ok only for a G6 database with nothing from the future in it, on a PostgreSQL 17.
function evaluatePre(snapshot, spec, pins) {
  if (snapshot.guards.length > 0) return { ok: false, code: 'FOREIGN_GUARD_PRESENT', extra: { guards: snapshot.guards.slice(0, 5) } };
  const version = snapshot.serverVersionNum;
  if (!Number.isInteger(version) || version < 170000 || version >= 180000) return { ok: false, code: 'SERVER_VERSION_UNSUPPORTED' };
  if (snapshot.history.ledger !== 'PRESENT') return { ok: false, code: 'LEDGER_ABSENT' };
  const ledger = classifyLedger(snapshot.history.rows, pins);
  if (ledger.state === TARGET_STATE) return { ok: false, code: 'STATE_ALREADY_TARGET', extra: { ledger: summarizeLedger(ledger) } };
  if (ledger.state !== INITIAL_STATE) return { ok: false, code: 'STATE_NOT_EXACT_G6', extra: { ledger: summarizeLedger(ledger) } };
  const advanced = findAdvancedObjects(snapshot.projection, spec);
  if (advanced.length > 0) return { ok: false, code: 'ADVANCED_OBJECTS_PRESENT', extra: { advanced: advanced.slice(0, 25), advancedCount: advanced.length } };
  return { ok: true, ledger, advanced: 0 };
}

async function checkBackup(deps, values, now) {
  const dump = values.backup;
  const name = path.basename(dump);
  const verified = await deps.verifyBackupPair({ dumpPath: dump, manifestPath: manifestPathFor(dump), expectedFile: name });
  if (!verified || verified.ok !== true) return { ok: false, phase: 'backup', code: 'BACKUP_UNVERIFIABLE' };
  const dispose = () => verified.dispose?.();
  const manifestBytes = readRegularFile(deps.fs, manifestPathFor(dump), MAX_JSON_BYTES);
  const manifest = manifestBytes === null ? null : parseBackupManifest(manifestBytes, name);
  if (manifest === null) { dispose(); return { ok: false, phase: 'backup', code: 'BACKUP_MANIFEST' }; }
  if (manifest.purpose !== 'pre-migration') { dispose(); return { ok: false, phase: 'backup', code: 'BACKUP_PURPOSE' }; }
  const created = Date.parse(manifest.createdAt);
  if (created > now.getTime() || now.getTime() - created > MAX_EVIDENCE_AGE_MS) { dispose(); return { ok: false, phase: 'backup', code: 'BACKUP_STALE' }; }
  return { ok: true, verified, file: name, sha256: verified.sha256, setId: verified.setId, createdAt: manifest.createdAt, createdMs: created };
}

function checkIdentityEvidence(deps, values, targetEvidence, backup, now) {
  const bad = (code) => ({ ok: false, phase: 'identity-evidence', code });
  if (path.dirname(values.identity) !== path.dirname(values.backup)) return bad('IDENTITY_EVIDENCE_LOCATION');
  const bytes = readRegularFile(deps.fs, values.identity, MAX_JSON_BYTES);
  const document = bytes === null ? null : parseEvidence(bytes.toString('utf8'), IDENTITY_FORMAT);
  if (document === null) return bad('IDENTITY_EVIDENCE_INVALID');
  if (document.targetDigest !== targetEvidence.targetDigest || document.markerDigest !== targetEvidence.markerDigest) return bad('IDENTITY_EVIDENCE_TARGET');
  if (document.marker !== 'PASS' || document.state !== INITIAL_STATE) return bad('IDENTITY_EVIDENCE_STATE');
  const observed = Date.parse(document.observedAt);
  if (Number.isNaN(observed) || observed > backup.createdMs) return bad('IDENTITY_EVIDENCE_ORDER');
  if (now.getTime() - observed > MAX_EVIDENCE_AGE_MS) return bad('IDENTITY_EVIDENCE_STALE');
  return { ok: true, sha256: document.evidenceSha256 };
}

// Everything that does not need the database: tree, backup, identity evidence, Prisma, staged config, tooling -> the plan.
async function prepare(deps, values, targetEvidence, pins, now) {
  const prisma = deps.resolvePrismaCli();
  if (!prisma || prisma.ok !== true) return { ok: false, phase: 'stage', code: 'PRISMA_CLI_UNAVAILABLE' };
  const support = deps.supportFiles();
  if (!support || !support.schemaBytes || !support.caBytes) return { ok: false, phase: 'plan', code: 'SUPPORT_FILES_UNREADABLE' };
  const tooling = deps.toolingDigests();
  if (!Array.isArray(tooling)) return { ok: false, phase: 'plan', code: 'TOOLING_UNREADABLE' };
  const backup = await checkBackup(deps, values, now);
  if (!backup.ok) return backup;
  const identity = checkIdentityEvidence(deps, values, targetEvidence, backup, now);
  if (!identity.ok) { backup.verified.dispose?.(); return identity; }
  const schemaSha256 = sha256Hex(support.schemaBytes);
  const caSha256 = sha256Hex(support.caBytes);
  const plan = buildPlan({
    pins, lockPin: deps.lockPin, prisma, schemaSha256, caSha256, stagedConfigSha256: sha256Hex(buildStagedConfigText(prisma.configModule)),
    referenceDigest: deps.reference.digest, tooling, targetDigest: targetEvidence.targetDigest, markerDigest: targetEvidence.markerDigest,
    backup: { file: backup.file, sha256: backup.sha256, setId: backup.setId, createdAt: backup.createdAt }, identityEvidenceSha256: identity.sha256,
  });
  return { ok: true, plan, prisma, support, schemaSha256, caSha256, backup, identity, tooling };
}

const planSummary = (prepared, pins) => ({
  format: PLAN_FORMAT, initialState: INITIAL_STATE, targetState: TARGET_STATE, migrations: pins.length, prismaVersion: prepared.prisma.version,
  referenceDigest: prepared.plan.document.referenceDigest, stagedConfigSha256: prepared.plan.document.stagedConfigSha256, configSha256: prepared.plan.document.prisma.configSha256, backup: { file: prepared.backup.file, setId: prepared.backup.setId }, identityEvidenceSha256: prepared.identity.sha256,
});

export async function run(parsed, deps) {
  const { mode, values } = parsed;
  const failed = (phase, code, extra) => fail(mode, phase, code, extra);

  const environment = checkEnvironment(deps.env);
  if (!environment.ok) return failed('env', environment.code, { names: environment.names });
  const target = readTarget(deps.readConfigBytes);
  if (!target.ok) return failed('config', target.code);
  const { held, evidence: targetEvidence } = target;
  const mismatch = confirmTarget(held, { markerId: values.marker, projectRef: mode === 'execute' ? values.confirm : undefined });
  if (mismatch) return failed('confirm', mismatch);

  const redact = makeRedactor([held.password, held.host, held.username, held.projectRef, held.markerId, toConnectionString(held)]);
  const pins = deps.pins;
  if (!Array.isArray(pins) || pins.length !== TARGET_COUNT) return failed('tree', 'TREE_NAMES');
  const tree = deps.readTree();
  const treeVerdict = verifyMigrationTree(tree, pins, deps.lockPin);
  if (!treeVerdict.ok) return failed('tree', treeVerdict.code);
  const spec = deriveAdvancedObjects(tree.entries.slice(BASELINE_COUNT).map((entry) => entry.sql.toString('utf8')));
  const startedAt = deps.now().toISOString();

  if (mode === 'check') return runCheck({ deps, values, held, targetEvidence, spec, pins, startedAt, failed });

  const prepared = await prepare(deps, values, targetEvidence, pins, deps.now());
  if (!prepared.ok) return failed(prepared.phase, prepared.code);
  try {
    if (mode === 'dry-run') {
      return { format: RESULT_FORMAT, mode, result: 'PASS', planDigest: prepared.plan.digest, targetDigest: targetEvidence.targetDigest, markerDigest: targetEvidence.markerDigest, plan: planSummary(prepared, pins) };
    }
    return await runExecute({ deps, values, held, targetEvidence, spec, pins, startedAt, failed, prepared, redact });
  } finally {
    prepared.backup.verified.dispose?.();
  }
}

async function runCheck({ deps, values, held, targetEvidence, spec, pins, startedAt, failed }) {
  const tooling = deps.toolingDigests();
  if (!Array.isArray(tooling)) return failed('plan', 'TOOLING_UNREADABLE');
  const snapshot = await takeSnapshot(deps, held);
  if (!snapshot.ok) return failed(snapshot.phase, snapshot.code);
  const verdict = evaluatePre(snapshot.value, spec, pins);
  if (!verdict.ok) return failed('precheck', verdict.code, verdict.extra);
  const identity = buildEvidence(IDENTITY_FORMAT, {
    observedAt: startedAt,
    targetDigest: targetEvidence.targetDigest,
    markerDigest: targetEvidence.markerDigest,
    marker: 'PASS',
    state: INITIAL_STATE,
    serverVersionNum: snapshot.value.serverVersionNum,
    ledger: summarizeLedger(verdict.ledger),
    advancedObjects: 0,
    foreignGuards: 0,
    toolingDigest: sha256Hex(canonicalJson(tooling)),
  });
  if (values.evidenceOut) {
    const written = writeExclusive(deps.fs, values.evidenceOut, renderEvidence(identity));
    if (!written.ok) return failed('evidence', written.code);
  }
  return { format: RESULT_FORMAT, mode: 'check', result: 'PASS', state: INITIAL_STATE, serverVersionNum: snapshot.value.serverVersionNum, targetDigest: targetEvidence.targetDigest, markerDigest: targetEvidence.markerDigest, evidenceSha256: identity.evidenceSha256 };
}

async function runExecute({ deps, values, held, targetEvidence, spec, pins, startedAt, failed, prepared, redact }) {
  if (prepared.plan.digest !== values.plan) return failed('plan', 'PLAN_MISMATCH');

  const before = await takeSnapshot(deps, held);
  if (!before.ok) return failed(before.phase, before.code);
  const verdict = evaluatePre(before.value, spec, pins);
  if (!verdict.ok) return failed('precheck', verdict.code, verdict.extra);

  const fresh = deps.readTree();
  const freshVerdict = verifyMigrationTree(fresh, pins, deps.lockPin);
  if (!freshVerdict.ok) return failed('tree', freshVerdict.code);
  if (prepared.backup.verified.assertUnchanged?.() !== true) return failed('backup', 'BACKUP_CHANGED');

  // The evidence file is exclusive: a leftover from an earlier attempt must stop the run BEFORE the irreversible step, not after it.
  if (deps.fs.existsSync(`${values.backup}.upgrade-evidence.json`)) return failed('evidence', 'EVIDENCE_EXISTS');

  // The Prisma config module is read again right before staging: whatever the plan approved is what gets staged, or nothing does.
  const again = deps.resolvePrismaCli();
  if (!again || again.ok !== true || again.configSha256 !== prepared.plan.document.prisma.configSha256
    || sha256Hex(buildStagedConfigText(again.configModule)) !== prepared.plan.document.stagedConfigSha256) return failed('plan', 'PLAN_MISMATCH');

  const stage = deps.stage({
    apiDir: deps.apiDir, tmpdir: deps.tmpdir, tree: fresh, schemaBytes: prepared.support.schemaBytes, caBytes: prepared.support.caBytes,
    expect: { schemaSha256: prepared.schemaSha256, caSha256: prepared.caSha256, configModule: again.configModule, configSha256: prepared.plan.document.prisma.configSha256, stagedConfigSha256: prepared.plan.document.stagedConfigSha256 }, fs: deps.fs,
  });
  if (!stage || stage.ok !== true) return failed('stage', stage?.code ?? 'STAGE_FAILED');

  const evidenceFile = `${values.backup}.upgrade-evidence.json`;
  const seal = (outcome, extra) => {
    const document = buildEvidence(EVIDENCE_FORMAT, {
      outcome, planDigest: prepared.plan.digest, initialState: INITIAL_STATE, startedAt, finishedAt: deps.now().toISOString(),
      targetDigest: targetEvidence.targetDigest, markerDigest: targetEvidence.markerDigest, serverVersionNum: before.value.serverVersionNum,
      backup: { file: prepared.backup.file, sha256: prepared.backup.sha256, setId: prepared.backup.setId }, identityEvidenceSha256: prepared.identity.sha256,
      prisma: { version: prepared.prisma.version }, precheck: summarizeLedger(verdict.ledger), ...extra,
    });
    return { document, written: writeExclusive(deps.fs, evidenceFile, renderEvidence(document)) };
  };

  try {
    const stageCheck = stage.verify();
    if (!stageCheck.ok) return failed('stage', stageCheck.code);

    const childEnv = buildChildEnv({ databaseUrl: toConnectionString(held), home: stage.root, tmpdir: deps.tmpdir, execPath: deps.execPath ?? 'node' });
    let outcome;
    try {
      outcome = await deps.runDeploy({
        execPath: deps.execPath ?? 'node', script: prepared.prisma.script, configPath: stage.configPath, cwd: stage.root, env: childEnv, timeoutMs: DEPLOY_TIMEOUT_MS,
        redact, onLine: (line) => deps.error(redact(line)),
      });
    } catch {
      outcome = { code: null, signal: null, timedOut: false, spawnError: 'unexpected' };
    }

    const afterState = async () => {
      const snapshot = await takeSnapshot(deps, held);
      if (!snapshot.ok) return { error: snapshot.code };
      return { ledger: snapshot.value.history.ledger === 'PRESENT' ? summarizeLedger(classifyLedger(snapshot.value.history.rows, pins)) : { state: 'LEDGER_ABSENT' } };
    };
    const finish = (phase, code, extra) => {
      const sealed = seal('FAIL', { phase, code, deploy: { exitCode: outcome.code, timedOut: outcome.timedOut }, ...extra });
      return failed(phase, code, { ...extra, evidenceWritten: sealed.written.ok });
    };

    if (outcome.spawnError || outcome.timedOut || outcome.code !== 0) {
      const code = outcome.spawnError ? 'DEPLOY_SPAWN_FAILED' : outcome.timedOut ? 'DEPLOY_TIMEOUT' : 'DEPLOY_FAILED';
      return finish('deploy', code, { afterFailure: await afterState() });
    }

    const post = await takeSnapshot(deps, held);
    if (!post.ok) return finish('postcheck', post.phase === 'marker' ? 'MARKER_NOT_PROVEN' : post.code, { afterFailure: { error: post.code } });
    const ledger = post.value.history.ledger === 'PRESENT' ? classifyLedger(post.value.history.rows, pins) : { state: 'OTHER', counts: {}, unexpected: 0 };
    if (ledger.state !== TARGET_STATE) return finish('postcheck', 'POSTCHECK_LEDGER', { afterFailure: { ledger: summarizeLedger(ledger) } });
    const schemaDigest = projectionDigest(post.value.projection);
    if (schemaDigest !== deps.reference.digest) return finish('postcheck', 'POSTCHECK_SCHEMA_DIGEST', { afterFailure: { ledger: summarizeLedger(ledger), schemaDigest } });
    const probeFailures = runProbes(post.value.projection, deps.reference.probes);
    if (probeFailures.length > 0) return finish('postcheck', 'POSTCHECK_PROBES', { afterFailure: { ledger: summarizeLedger(ledger), probeFailures: probeFailures.slice(0, 10) } });

    const sealed = seal('PASS', {
      finalState: TARGET_STATE,
      deploy: { exitCode: 0, timedOut: false },
      postcheck: { marker: 'PASS', migrationsApplied: ledger.counts.APPLIED_CLEAN ?? 0, schemaDigest, probes: 'PASS', serverVersionNum: post.value.serverVersionNum },
    });
    if (!sealed.written.ok) return failed('evidence', sealed.written.code, { upgraded: true, finalState: TARGET_STATE });
    return {
      format: RESULT_FORMAT, mode: 'execute', result: 'PASS', planDigest: prepared.plan.digest, initialState: INITIAL_STATE, finalState: TARGET_STATE,
      serverVersionNum: post.value.serverVersionNum, evidenceFile: path.basename(evidenceFile), evidenceSha256: sealed.document.evidenceSha256,
    };
  } finally {
    stage.cleanup();
  }
}

export async function main(argv, suppliedDeps = {}) {
  const deps = { ...buildDefaultDeps(), ...suppliedDeps };
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) {
    deps.log(JSON.stringify({ format: RESULT_FORMAT, mode: null, result: 'FAIL', phase: 'args', code: parsed.code, reason: parsed.reason }));
    return 2;
  }
  const result = await run(parsed, deps);
  deps.log(JSON.stringify(result));
  return result.result === 'PASS' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
