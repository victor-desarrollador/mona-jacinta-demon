// OWNER-ONLY, PILOT-ONLY, OPERATOR-LEVEL recovery of the canonical PILOT OWNER's access, for the day no valid credential is known (OWNER-RECOVERY R1).
//
//   node scripts/database/pilot-owner-recovery.mjs --target=pilot --dry-run  --marker-id=<uuid> --target-user=<canonical owner id>
//   node scripts/database/pilot-owner-recovery.mjs --target=pilot --execute  --marker-id=<uuid> --confirm-project-ref=<ref> --target-user=<canonical owner id> --plan=<dry-run digest>
//
// EXECUTE MUST BE RUN BY THE OWNER, IN THEIR OWN INTERACTIVE TERMINAL. It refuses unless stdin AND stdout are TTYs: the temporary password is shown ONLY there, once, after the
// COMMIT, and never reaches argv, the environment, a file, a log or a pipe. Do not run it through an agent, `!`, tmux logging or any capture.
//
// What it does, in ONE transaction (READ COMMITTED + row lock, the discipline of user-admin.service.ts): takes the maintenance advisory lock, locks the target User row
// (FOR NO KEY UPDATE), re-reads and re-validates it (active, the canonical OWNER, OWNER at COMPANY scope, the observed credentials epoch UNCHANGED — a compare-and-swap),
// writes passwordHash (the runtime's bcrypt, via the reviewed module), mustChangePassword = true and credentialsChangedAt = nextCredentialsEpoch(...) (U1: strictly greater than
// the previous epoch, so every token issued before dies on its next request), writes ONE AuditLog row, verifies the result inside the transaction (the stored hash verifies the
// temporary password, the flags, the epoch, exactly one new audit row, still an operative OWNER) and COMMITs. Any failure rolls EVERYTHING back. After a confirmed COMMIT the
// temporary password is displayed once; if the COMMIT outcome is ambiguous the result is UNKNOWN_COMMIT, nothing is displayed, and a new --dry-run is required.
//
// REUSED, not re-implemented: generateTemporaryPassword (U2), hashPassword / verifyPassword (the runtime's bcrypt cost), nextCredentialsEpoch (U1), createAuditLog, the system actor
// constants, the PILOT identity proof, the verified-TLS client and the EXACT_G22 reference of the rollout tools, the plan / tooling binding of the G22 tools.
//
// AUDIT (decision of the OWNER): AuditLog.userId is NOT NULL with a FK to User, and no authenticated actor exists in a recovery. The row is attributed to the real, existing,
// INACTIVE technical system actor of PILOT (no scope, no login) with action USER_PASSWORD_RECOVERY and after.recovery.channel = OPERATOR_RECOVERY, plus the tool, its SHA-256, the
// operating-system user and the PLAN_DIGEST. USER_PASSWORD_RESET is NOT used (it presupposes an authenticated administrator) and neither is UserAdminOperation (its actorId is a
// NOT NULL FK, its operation is a CHECK of four administrative operations, its key a user idempotency key): no actor and no key are fabricated. LIMITATION: the actor shown by an
// audit viewer is that technical user; who really acted lives only in after.recovery.
//
// SESSIONS (limitation): the epoch invalidates every previously issued token on its next request, but this tool cannot reach the API's in-process SessionRevoker, so Socket.IO
// connections that are ALREADY open keep their connection-time snapshot until they reconnect. Nothing here tries to solve that.
//
// REPLAY: the PLAN_DIGEST binds the project, the marker, EXACT_G22, the target, the OBSERVED credentials epoch and mustChangePassword, the system actor and the tooling (this script
// and every module it imports). After a recovery the epoch is no longer the observed one, so the same plan cannot be reused; the compare-and-swap inside the transaction is the
// second barrier. A second recovery is always a new, explicit dry-run -> execute cycle with its own AuditLog row.
//
// Exit codes: 0 DRY_RUN_OK / RECOVERED, 1 anything else. Output never carries a URL, host, user, password, project ref, e-mail, hash, token or the temporary password (except the
// one display of the latter on the TTY).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CA_PATH, PROJECT_REF_PATTERN } from './lib.mjs';
import { PILOT_URL_FILE, createVerifiedClient, deriveProjectRef, parsePilotUrl, readPrivateUrlFile } from './pilot-marker.mjs';
import { PILOT_ACCOUNTS } from './pilot-bootstrap.mjs';
import { proveIdentity, readSnapshotOn } from './pilot-g22-rollout.mjs';
import { requireGeneration } from './pilot-migration-generations.mjs';
import { canonicalJson, projectionDigest, runProbes } from './app-schema-projection.mjs';
import { GENERATION_SCHEMA_G22 } from './pilot-g22-schema-references.mjs';
import { buildTargetBinding, buildToolingBinding, toolingFile, validateTargetBinding, validateToolingBinding } from './pilot-plan-binding.mjs';

const PREFIX = '[db:pilot-owner-recovery]';
const URL_FILE_LABEL = '~/.config/mona-jacinta/pilot-database-url';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
// The shared maintenance advisory lock (pilot-bootstrap, canonical-owner-bootstrap and the seed take the same one).
const MAINTENANCE_ADVISORY_LOCK_ID = 506005;

export const TOOL_NAME = 'pilot-owner-recovery';
export const PLAN_FORMAT = 'mona-pilot-owner-recovery-plan/v1';
export const AUDIT_ACTION = 'USER_PASSWORD_RECOVERY';
export const AUDIT_CHANNEL = 'OPERATOR_RECOVERY';
export const CANONICAL_OWNER = PILOT_ACCOUNTS[0];
const CONFIRMATION_PREFIX = 'RECOVER ';

// Everything whose bytes can change what --execute does: this tool, the modules it imports, the API modules it loads and the CA.
export const RECOVERY_TOOLING_FILES = Object.freeze([
  ...['pilot-owner-recovery.mjs', 'pilot-plan-binding.mjs', 'pilot-bootstrap.mjs', 'pilot-g22-rollout.mjs', 'pilot-migrate.mjs', 'pilot-migration-states.mjs',
    'pilot-migration-generations.mjs', 'app-schema-projection.mjs', 'pilot-schema-references.mjs', 'pilot-g16-schema-references.mjs', 'pilot-g19-schema-references.mjs',
    'pilot-g20-schema-references.mjs', 'pilot-g22-schema-references.mjs', 'pilot-rbac-catalog.mjs', 'pilot-rbac-catalog-generations.mjs', 'pilot-marker.mjs', 'lib.mjs']
    .map((f) => toolingFile('module', f)),
  ...['api/src/modules/auth/password.ts', 'api/src/modules/auth/temporary-password.ts', 'api/src/modules/auth/credentials-epoch.ts', 'api/src/shared/audit.ts',
    'api/src/shared/json-safe.ts', 'api/src/modules/audit/system-actor.service.ts', 'scripts/certs/supabase-prod-ca-2021.crt'].map((f) => toolingFile('repo', f)),
]);

// ---- arguments -------------------------------------------------------------------------------------------------------------------------------

const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref', 'target-user', 'plan'];

export function parseCliArgs(argv) {
  const values = {};
  const modes = [];
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (body === 'dry-run' || body === 'execute') { modes.push(body); continue; }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (modes.length !== 1) return { ok: false, error: 'Specify exactly one of --dry-run or --execute' };
  if (values.target !== 'pilot') return { ok: false, error: 'Exactly --target=pilot is required' };
  if (!UUID_V4.test(values['marker-id'] ?? '')) return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(values['target-user'] ?? '')) return { ok: false, error: '--target-user must be a canonical lowercase UUID' };
  const confirmProjectRef = values['confirm-project-ref'] ?? null;
  if (confirmProjectRef !== null && !PROJECT_REF_PATTERN.test(confirmProjectRef)) return { ok: false, error: '--confirm-project-ref must be a 20-character lowercase project ref' };
  const mode = modes[0];
  if (mode === 'execute') {
    if (confirmProjectRef === null) return { ok: false, error: '--execute requires --confirm-project-ref' };
    if (!HEX64.test(values.plan ?? '')) return { ok: false, error: '--execute requires --plan=<the PLAN_DIGEST printed by --dry-run>' };
  } else if ('plan' in values) return { ok: false, error: '--plan is only valid with --execute' };
  return { ok: true, mode, markerId: values['marker-id'], confirmProjectRef, targetUser: values['target-user'], plan: values.plan ?? null };
}

// ---- the plan --------------------------------------------------------------------------------------------------------------------------------

// Pure. The exact intention the OWNER approves; the digest is what --execute must be given.
export function buildPlan({ targetBinding, toolingBinding, schemaDigest, target, actorId }) {
  const plan = {
    format: PLAN_FORMAT, target: 'pilot', targetBinding, toolingBinding, generation: 'EXACT_G22', schemaDigest,
    targetUser: { id: target.id, role: 'OWNER', scopeKind: 'COMPANY', observedCredentialsEpoch: target.epoch, observedMustChangePassword: target.mustChangePassword },
    audit: { actorId, action: AUDIT_ACTION, channel: AUDIT_CHANNEL },
    writes: ['User.passwordHash', 'User.mustChangePassword=true', 'User.credentialsChangedAt=nextCredentialsEpoch', 'AuditLog+1'],
  };
  return { plan, digest: createHash('sha256').update(canonicalJson(plan)).digest('hex') };
}

// Pure. EXACT_G22: ledger of exactly the 22 reviewed migrations, the app-schema digest equal to the pinned reference and every reviewed probe passing.
export function assertExactG22(snapshot, schema = GENERATION_SCHEMA_G22) {
  const ledger = requireGeneration(snapshot.ledger, 'EXACT_G22');
  if (!ledger.ok) return { ok: false, reason: 'the ledger is not exactly EXACT_G22' };
  if (snapshot.ledger.length !== 22) return { ok: false, reason: 'the ledger does not hold exactly 22 migrations' };
  const digest = projectionDigest(snapshot.projection);
  if (digest !== schema.references.EXACT_G22?.digest) return { ok: false, reason: 'the app schema is not the EXACT_G22 reference' };
  if (runProbes(snapshot.projection, schema.probes.EXACT_G22 ?? []).length > 0) return { ok: false, reason: 'a reviewed EXACT_G22 probe failed' };
  return { ok: true, digest };
}

// ---- reads (the same functions run read-only before the plan and under the lock inside the transaction) --------------------------------------

const toCount = (v) => Number(v ?? 0);

async function readUserRow(db, id, lock) {
  const rows = lock
    ? await db.$queryRaw`SELECT id, name, email, "isActive", "mustChangePassword", "credentialsChangedAt" FROM "User" WHERE id = ${id} FOR NO KEY UPDATE`
    : await db.$queryRaw`SELECT id, name, email, "isActive", "mustChangePassword", "credentialsChangedAt" FROM "User" WHERE id = ${id}`;
  return rows[0] ?? null;
}

// The canonical OWNER, as it is NOW: exists, is the canonical id and e-mail, active, OWNER at COMPANY scope, and the company still has an operative OWNER.
export async function observeTarget(db, targetId, { lock = false } = {}) {
  const reasons = [];
  const user = await readUserRow(db, targetId, lock);
  if (!user) return { ok: false, reasons: ['the target user does not exist'] };
  if (user.id !== CANONICAL_OWNER.id || targetId !== CANONICAL_OWNER.id) reasons.push('the target is not the canonical PILOT OWNER');
  if (user.email !== CANONICAL_OWNER.email) reasons.push('the target e-mail is not the canonical OWNER e-mail');
  if (user.isActive !== true) reasons.push('the target is not active');
  const scopes = await db.$queryRaw`SELECT r.code AS code, s."scopeKind"::text AS "scopeKind" FROM "UserRoleScope" s JOIN "Role" r ON r.id = s."roleId" WHERE s."userId" = ${targetId}`;
  if (!scopes.some((s) => s.code === 'OWNER' && s.scopeKind === 'COMPANY')) reasons.push('the target does not hold OWNER at COMPANY scope');
  const owners = await db.$queryRaw`SELECT count(DISTINCT u.id)::text AS n FROM "User" u JOIN "UserRoleScope" s ON s."userId" = u.id JOIN "Role" r ON r.id = s."roleId" WHERE u."isActive" AND r.code = 'OWNER' AND s."scopeKind"::text = 'COMPANY'`;
  const operativeOwners = toCount(owners[0]?.n);
  if (operativeOwners < 1) reasons.push('there is no operative OWNER');
  const epoch = user.credentialsChangedAt instanceof Date ? user.credentialsChangedAt : user.credentialsChangedAt === null ? null : new Date(user.credentialsChangedAt);
  return {
    ok: reasons.length === 0, reasons, id: user.id, mustChangePassword: user.mustChangePassword === true, credentialsChangedAt: epoch,
    epoch: epoch === null ? null : epoch.getTime(), operativeOwners,
  };
}

// The technical actor the audit row is attributed to: exists with the canonical identity, INACTIVE, no scope, no legacy branch role (the invariants of system-actor.service.ts).
export async function observeActor(db, canonical) {
  const reasons = [];
  const user = await readUserRow(db, canonical.SYSTEM_ACTOR_USER_ID, false);
  if (!user) return { ok: false, reasons: ['the technical system actor does not exist'] };
  if (user.email !== canonical.SYSTEM_ACTOR_EMAIL || user.name !== canonical.SYSTEM_ACTOR_NAME) reasons.push('the technical system actor identity differs from the canonical one');
  if (user.isActive !== false) reasons.push('the technical system actor is active');
  const scopes = await db.$queryRaw`SELECT count(*)::text AS n FROM "UserRoleScope" WHERE "userId" = ${canonical.SYSTEM_ACTOR_USER_ID}`;
  const legacy = await db.$queryRaw`SELECT count(*)::text AS n FROM "UserBranchRole" WHERE "userId" = ${canonical.SYSTEM_ACTOR_USER_ID}`;
  if (toCount(scopes[0]?.n) > 0 || toCount(legacy[0]?.n) > 0) reasons.push('the technical system actor holds a role scope');
  return { ok: reasons.length === 0, reasons, id: canonical.SYSTEM_ACTOR_USER_ID };
}

// The operating-system login that goes into the AuditLog JSON: a short safe login or "unknown" (never free text).
export function normalizeOperator(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value) ? value : 'unknown';
}
function operatorOf(deps) {
  try { return normalizeOperator(deps.osUser()); } catch { return 'unknown'; }
}

// ---- the transaction -------------------------------------------------------------------------------------------------------------------------

export class Stop extends Error {
  constructor(code, reason) {
    super(reason);
    this.code = code;
  }
}

// Runs INSIDE one transaction. Throws Stop('STATE_CHANGED') when the world is not what the plan observed, any other Error on a failure; the caller's transaction rolls back.
export async function recoverInTransaction(tx, canonical, { targetId, expected, passwordHash, temporaryPassword, planDigest, toolSha256, operator, now }) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${MAINTENANCE_ADVISORY_LOCK_ID})::text`;
  const locked = await observeTarget(tx, targetId, { lock: true });
  if (!locked.ok) throw new Stop('STATE_CHANGED', `${locked.reasons[0]} (under the lock)`);
  if (locked.epoch !== expected.epoch || locked.mustChangePassword !== expected.mustChangePassword) {
    throw new Stop('STATE_CHANGED', 'the target credentials changed since the plan was observed (compare-and-swap)');
  }
  const actor = await observeActor(tx, canonical);
  if (!actor.ok) throw new Stop('STATE_CHANGED', `${actor.reasons[0]} (under the lock)`);
  const auditBefore = toCount((await tx.$queryRaw`SELECT count(*)::text AS n FROM "AuditLog" WHERE action = ${AUDIT_ACTION} AND "entityId" = ${targetId}`)[0]?.n);

  const next = canonical.nextCredentialsEpoch(locked.credentialsChangedAt, now());
  await tx.user.update({ where: { id: targetId }, data: { passwordHash, mustChangePassword: true, credentialsChangedAt: next }, select: { id: true } });
  await canonical.createAuditLog(tx, {
    userId: actor.id, branchId: null, action: AUDIT_ACTION, entityType: 'User', entityId: targetId,
    before: { mustChangePassword: locked.mustChangePassword, credentialsChangedAt: locked.credentialsChangedAt?.toISOString() ?? null },
    after: {
      mustChangePassword: true, credentialsChangedAt: next.toISOString(),
      recovery: { channel: AUDIT_CHANNEL, tool: TOOL_NAME, toolSha256, operator, planDigest },
    },
  });

  // Verification, independent of the writes above and still inside the transaction: anything else rolls everything back.
  const after = await observeTarget(tx, targetId);
  const stored = (await tx.$queryRaw`SELECT "passwordHash" FROM "User" WHERE id = ${targetId}`)[0]?.passwordHash;
  const auditAfter = toCount((await tx.$queryRaw`SELECT count(*)::text AS n FROM "AuditLog" WHERE action = ${AUDIT_ACTION} AND "entityId" = ${targetId}`)[0]?.n);
  const problems = [];
  if (!after.ok) problems.push('the target is no longer a valid operative OWNER');
  if (after.mustChangePassword !== true) problems.push('mustChangePassword was not set');
  if (after.epoch !== next.getTime()) problems.push('the credentials epoch is not the computed one');
  if (typeof stored !== 'string' || !(await canonical.verifyPassword(temporaryPassword, stored))) problems.push('the stored hash does not verify the temporary password');
  if (auditAfter !== auditBefore + 1) problems.push('exactly one new audit row was not written');
  if (problems.length > 0) throw new Error(`post-write verification failed: ${problems.join('; ')}`);
  return next;
}

// ---- canonical modules and Prisma (in-process, repo-local tsx; the same way pilot-bootstrap loads them) ------------------------------------

async function tsImport(rel) {
  const api = await import(pathToFileURL(path.join(ROOT, 'api/node_modules/tsx/dist/esm/api/index.mjs')).href);
  return api.tsImport(pathToFileURL(path.join(ROOT, rel)).href, import.meta.url);
}

export async function loadCanonical() {
  const password = await tsImport('api/src/modules/auth/password.ts');
  const temporary = await tsImport('api/src/modules/auth/temporary-password.ts');
  const epoch = await tsImport('api/src/modules/auth/credentials-epoch.ts');
  const audit = await tsImport('api/src/shared/audit.ts');
  const actor = await tsImport('api/src/modules/audit/system-actor.service.ts');
  return {
    hashPassword: password.hashPassword, verifyPassword: password.verifyPassword, BCRYPT_ROUNDS: password.BCRYPT_ROUNDS,
    generateTemporaryPassword: temporary.generateTemporaryPassword, TEMPORARY_PASSWORD_PATTERN: temporary.TEMPORARY_PASSWORD_PATTERN,
    nextCredentialsEpoch: epoch.nextCredentialsEpoch, createAuditLog: audit.createAuditLog,
    SYSTEM_ACTOR_USER_ID: actor.SYSTEM_ACTOR_USER_ID, SYSTEM_ACTOR_EMAIL: actor.SYSTEM_ACTOR_EMAIL, SYSTEM_ACTOR_NAME: actor.SYSTEM_ACTOR_NAME,
  };
}

// Prisma over the held connection FIELDS (never a URL string) with the verified-TLS trust anchor, like pilot-bootstrap.
async function createPilotPrisma(conn) {
  const { PrismaClient } = await tsImport('api/src/generated/prisma/client.ts');
  const require = createRequire(path.join(ROOT, 'api', 'package.json'));
  const { PrismaPg } = await import(pathToFileURL(require.resolve('@prisma/adapter-pg')).href);
  const adapter = new PrismaPg({ ...conn, ssl: { rejectUnauthorized: true, ca: readFileSync(CA_PATH, 'utf8'), servername: conn.host }, connectionTimeoutMillis: 10000 });
  return new PrismaClient({ adapter, log: [] });
}

// ---- the terminal (the only place the temporary password can appear) ------------------------------------------------------------------------

function terminalPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => { rl.question(question, (answer) => { rl.close(); resolve(answer); }); });
}

async function terminalShowSecret(secret) {
  process.stdout.write(`\n  TEMPORARY PASSWORD (shown once; it forces a password change at first login):\n\n      ${secret}\n\n`);
  await terminalPrompt('  Copy it now. Press Enter to clear the screen... ');
  process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

const defaultDeps = {
  urlFile: PILOT_URL_FILE,
  // The environment is read ONLY to refuse PGOPTIONS (which can alter the session); it is also what pilot-marker's identity proof inspects. No other variable is consulted.
  env: process.env,
  readUrlFile: (file) => readPrivateUrlFile(file),
  createClient: createVerifiedClient,
  requireTls: true,
  createPrisma: createPilotPrisma,
  loadCanonical,
  schema: GENERATION_SCHEMA_G22,
  moduleDir: path.dirname(fileURLToPath(import.meta.url)),
  apiDir: path.join(ROOT, 'api'),
  repoDir: ROOT.replace(/\/$/, ''),
  isTTY: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
  prompt: terminalPrompt,
  showSecret: terminalShowSecret,
  now: () => new Date(),
  osUser: () => os.userInfo().username,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

// ---- main ------------------------------------------------------------------------------------------------------------------------------------

export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const result = (code) => deps.log(`PILOT_OWNER_RECOVERY_RESULT=${code}`);
  const fail = (code, phase, detail) => { deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`); result(code); return 1; };

  const args = parseCliArgs(argv);
  if (!args.ok) return fail('REFUSED', 'args', args.error);
  if (args.targetUser !== CANONICAL_OWNER.id) return fail('REFUSED', 'target', '--target-user must be exactly the canonical PILOT OWNER; nothing was read');
  if (deps.env?.PGOPTIONS !== undefined) return fail('REFUSED', 'config', 'PGOPTIONS is set in the environment and could alter the database session; unset it (value not shown); nothing was read');
  if (args.mode === 'execute' && !(deps.isTTY?.stdin === true && deps.isTTY?.stdout === true)) {
    return fail('REFUSED', 'tty', '--execute needs an interactive terminal on stdin AND stdout (the temporary password is shown only there); nothing was read');
  }

  let file;
  try { file = deps.readUrlFile(deps.urlFile); } catch { file = { ok: false, reason: 'private URL file could not be read' }; }
  if (!file.ok) return fail('REFUSED', 'config', `${URL_FILE_LABEL}: ${file.reason}`);
  const heldUrl = typeof file.text === 'string' ? file.text.replace(/\r?\n$/, '') : '';
  const parsedUrl = parsePilotUrl(heldUrl);
  if (!parsedUrl.ok) return fail('REFUSED', 'config', `${URL_FILE_LABEL} must hold one PostgreSQL URL with user, password, host and database (value not shown)`);
  const projectRef = deriveProjectRef(parsedUrl.conn);
  if (projectRef === null) return fail('REFUSED', 'target', 'the private URL does not carry a derivable project ref; nothing was started');
  if (args.confirmProjectRef !== null && args.confirmProjectRef !== projectRef) return fail('REFUSED', 'target', '--confirm-project-ref does not match the project addressed by the private URL file (values not shown)');

  let targetBinding; let toolingBinding;
  try {
    targetBinding = buildTargetBinding({ environment: 'pilot', projectRef, host: parsedUrl.conn.host, database: parsedUrl.conn.database, markerId: args.markerId });
    toolingBinding = buildToolingBinding({ moduleDir: deps.moduleDir, apiDir: deps.apiDir, repoDir: deps.repoDir, files: RECOVERY_TOOLING_FILES });
  } catch (error) {
    return fail('REFUSED', 'binding', `${error?.message ?? 'the target/tooling binding could not be built'}; nothing was started`);
  }
  if (!validateTargetBinding(targetBinding) || !validateToolingBinding(toolingBinding)) return fail('REFUSED', 'binding', 'the target/tooling binding is not valid');
  const toolSha256 = toolingBinding.files.find((f) => f.path === 'pilot-owner-recovery.mjs')?.sha256;

  const proof = await proveIdentity({ ...deps, log: () => {}, error: () => {} }, heldUrl, args.markerId);
  if (proof !== 0) return fail('REFUSED', 'identity', 'PILOT identity proof failed; nothing else was read');

  // 1. read-only: the marker (again, in the snapshot) and EXACT_G22.
  let snapshot;
  const client = deps.createClient(parsedUrl.conn);
  try {
    await client.connect();
    snapshot = await readSnapshotOn(client, { markerId: args.markerId, requireTls: deps.requireTls !== false, userDefaults: true, adminOperations: true });
  } catch { snapshot = { ok: false, reason: 'the read-only snapshot could not be read' }; } finally { try { await client.end(); } catch { /* closed */ } }
  if (!snapshot.ok) return fail('REFUSED', 'snapshot', snapshot.reason);
  const g22 = assertExactG22(snapshot, deps.schema);
  if (!g22.ok) return fail('REFUSED', 'generation', `${g22.reason}; nothing was written`);

  let canonical; let prisma;
  try {
    canonical = await deps.loadCanonical();
    prisma = await deps.createPrisma(parsedUrl.conn);
  } catch { return fail('REFUSED', 'modules', 'the canonical API modules or the database client could not be loaded; nothing was written'); }

  try {
    // 2. read-only: the target and the technical actor.
    const target = await observeTarget(prisma, args.targetUser);
    if (!target.ok) return fail('REFUSED', 'target', `${target.reasons[0]}; nothing was written`);
    const actor = await observeActor(prisma, canonical);
    if (!actor.ok) return fail('REFUSED', 'actor', `${actor.reasons[0]}; nothing was written`);
    const { plan, digest } = buildPlan({
      targetBinding, toolingBinding, schemaDigest: g22.digest,
      target: { id: target.id, epoch: target.epoch, mustChangePassword: target.mustChangePassword }, actorId: actor.id,
    });
    const short = `${target.id.slice(0, 8)}…`;

    if (args.mode === 'dry-run') {
      for (const line of [
        `${PREFIX} DRY RUN — nothing was written (read-only snapshot + read-only queries)`,
        '  identity: PILOT marker proven (values not shown)',
        `  project ref: ${args.confirmProjectRef === null ? 'not checked (no --confirm-project-ref)' : 'matches --confirm-project-ref'}`,
        `  database: EXACT_G22 (22 migrations finished, app schema digest ${g22.digest} = reference)`,
        `  target: the canonical PILOT OWNER ${short} — active, OWNER at COMPANY scope, ${target.operativeOwners} operative OWNER(s) in the company`,
        `  observed credentials epoch: ${target.epoch === null ? 'NULL (never changed)' : new Date(target.epoch).toISOString()}; mustChangePassword = ${target.mustChangePassword}`,
        `  technical system actor ${actor.id.slice(0, 8)}…: valid (inactive, no scope) — the AuditLog author`,
        `  tooling binding: bound (${toolingBinding.files.length} artifacts by SHA-256 — values not shown)`,
        `  would write, in ONE transaction: User.passwordHash, mustChangePassword = true, credentialsChangedAt = nextCredentialsEpoch(...), AuditLog ${AUDIT_ACTION} (${AUDIT_CHANNEL})`,
        '  never touches: the administrative operation records, any other user, scopes, e-mail, the ledger, any other table',
        `  PLAN_DIGEST=${digest}`,
        '  --execute must be run by the OWNER in an interactive terminal; the temporary password is shown only there, once, after the COMMIT',
      ]) deps.log(line);
      result('DRY_RUN_OK');
      return 0;
    }

    // 3. execute
    if (args.plan !== digest) return fail('REFUSED', 'plan', 'PLAN_BINDING_MISMATCH: --plan is not the digest of the CURRENT plan (state, target, tooling); run --dry-run again and approve its PLAN_DIGEST; nothing was written');
    const answer = await deps.prompt(`Type exactly "${CONFIRMATION_PREFIX}${target.id.slice(0, 8)}" to recover the OWNER's access: `);
    if (answer !== `${CONFIRMATION_PREFIX}${target.id.slice(0, 8)}`) return fail('REFUSED', 'confirmation', 'the confirmation was not typed exactly; nothing was written');

    // generated and hashed BEFORE the transaction (bcrypt holds no lock), in memory only
    const temporaryPassword = canonical.generateTemporaryPassword();
    const passwordHash = await canonical.hashPassword(temporaryPassword);
    let completed = false;
    let epoch;
    try {
      epoch = await prisma.$transaction(async (tx) => {
        const next = await recoverInTransaction(tx, canonical, {
          targetId: target.id, expected: { epoch: target.epoch, mustChangePassword: target.mustChangePassword }, passwordHash, temporaryPassword,
          planDigest: digest, toolSha256, operator: operatorOf(deps), now: deps.now,
        });
        completed = true;
        return next;
      }, { maxWait: 10000, timeout: 60000 });
    } catch (error) {
      if (completed) {
        deps.error(`${PREFIX} UNKNOWN_COMMIT — the transaction finished but its COMMIT is not confirmed; the temporary password was NOT shown and cannot be trusted. Run a new --dry-run: if the credentials epoch changed, the password was written but never seen and another recovery is needed.`);
        result('UNKNOWN_COMMIT');
        return 1;
      }
      if (error instanceof Stop) return fail(error.code, 'transaction', `${error.message}; everything was rolled back, nothing changed`);
      return fail('ROLLED_BACK', 'transaction', 'the transaction failed and was rolled back (no partial state); nothing changed');
    }

    // The COMMIT is confirmed. Only now the secret exists for the human.
    deps.log(`${PREFIX} COMMITTED — credentials epoch ${epoch.toISOString()}; mustChangePassword = true; one ${AUDIT_ACTION} audit row`);
    try {
      await deps.showSecret(temporaryPassword);
    } catch {
      deps.error(`${PREFIX} the temporary password could not be displayed; it is lost. Run a new --dry-run and recover again.`);
      result('SECRET_NOT_DISPLAYED');
      return 1;
    }
    result('RECOVERED');
    return 0;
  } finally {
    try { await prisma?.$disconnect?.(); } catch { /* closed */ }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
