// READ-ONLY PILOT preflight for the USER-MGMT rollout (G20 -> G21 -> G22: credentials epoch + user administration lifecycle). Zero writes, zero DDL, no Prisma.
// The sibling of pilot-g20-preflight.mjs (G16 -> G20), which is NOT modified and keeps its own contract.
//
//   node scripts/database/pilot-g22-preflight.mjs --target=pilot --check --marker-id=<uuid> [--confirm-project-ref=<ref>]
//
// It accepts exactly ONE source state, EXACT_G20, and refuses (fail closed, never repairs) everything else: G19 or older, EXACT_G21, EXACT_G22, a half-applied G21
// or G22 (a failed, unfinished or rolled-back ledger row), a G20 ledger over a drifted schema, a case-insensitive e-mail collision, no operative OWNER, an RBAC
// catalog that is not a reviewed generation. In one REPEATABLE READ READ ONLY snapshot on a verified-TLS client (always ROLLBACK) it reports: the identity proof,
// the ledger and its generation, the app-schema digest against the pinned references, the absence of every G21/G22 object, the e-mail and OWNER facts, the
// operational activity (cash sessions open, draft / pending sales, live reservations: WARNINGS, never blockers) and the frozen business counts the migrator and the
// verifier compare. Output never carries a URL, host, user, password, project ref, e-mail or hash.
import { pathToFileURL } from 'node:url';
import {
  PILOT_URL_FILE, createVerifiedClient, deriveProjectRef, parsePilotUrl, readPrivateUrlFile,
} from './pilot-marker.mjs';
import { PROJECT_REF_PATTERN } from './lib.mjs';
import { GENERATION_SCHEMA_G22 } from './pilot-g22-schema-references.mjs';
import { REASONS, SOURCE_GENERATION, assessSource, formatCounts, proveIdentity, readSnapshot } from './pilot-g22-rollout.mjs';

const PREFIX = '[db:pilot-g22-preflight]';
const URL_FILE_LABEL = '~/.config/mona-jacinta/pilot-database-url';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref'];

export function parseCliArgs(argv) {
  const values = {};
  let check = 0;
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (body === 'check') { check += 1; continue; }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (check !== 1) return { ok: false, error: 'Specify exactly one --check (this tool has no write mode)' };
  if (values.target !== 'pilot') return { ok: false, error: 'Exactly --target=pilot is required' };
  if (!UUID_V4.test(values['marker-id'] ?? '')) return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  const confirmProjectRef = values['confirm-project-ref'] ?? null;
  if (confirmProjectRef !== null && !PROJECT_REF_PATTERN.test(confirmProjectRef)) return { ok: false, error: '--confirm-project-ref must be a 20-character lowercase project ref' };
  return { ok: true, markerId: values['marker-id'], confirmProjectRef };
}

const defaultDeps = {
  urlFile: PILOT_URL_FILE,
  readUrlFile: (file) => readPrivateUrlFile(file),
  env: process.env,
  createClient: createVerifiedClient,
  schema: GENERATION_SCHEMA_G22,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

// Pure: the report lines of one assessed snapshot (no value from the database other than counts and generation names).
export function reportLines(report, { confirmProjectRef = null } = {}) {
  const f = report.facts;
  const names = report.ledger.ok ? report.ledger.state : `UNCLASSIFIED (${report.ledger.reason})`;
  const schema = report.schemaGeneration ? `= ${report.schemaGeneration}` : 'no known reference';
  return [
    `${PREFIX} READ-ONLY — nothing was written (REPEATABLE READ READ ONLY, always ROLLBACK)`,
    '  identity: PILOT marker proven (values not shown)',
    `  project ref: ${confirmProjectRef === null ? 'not checked (no --confirm-project-ref)' : 'matches --confirm-project-ref'}`,
    `  ledger generation: ${names}`,
    `  app schema digest: ${report.digest} (${schema})`,
    `  G21/G22 objects (mustChangePassword, credentialsChangedAt, UserAdminOperation, User_email_lower_key): ${report.probeFailures === undefined ? 'not judged' : report.probeFailures.length === 0 ? 'all absent' : `${report.probeFailures.length} probe(s) failing`}`,
    `  RBAC catalog: ${report.catalog.ok ? `${report.catalog.catalog} (digest ${report.catalog.digest})` : `UNCLASSIFIED (${report.catalog.reason})`}`,
    `  users: ${f.users.total} total, ${f.users.active} active, ${f.users.total - f.users.active} inactive, ${f.users.nonLower} with a non-lowercase e-mail`,
    `  e-mail groups colliding case-insensitively: ${f.collisionGroups}`,
    `  operative OWNER (active, OWNER at COMPANY scope): ${f.operativeOwners}`,
    `  cash sessions OPEN: ${f.operation.cashOpen}`,
    `  sales DRAFT: ${f.operation.salesDraft}`,
    `  sales PENDING_PAYMENT: ${f.operation.salesPendingPayment}`,
    `  live stock reservations: ${f.operation.liveReservations}`,
    ...report.warnings.map((w) => `  WARNING (not a blocker): ${w}`),
    ...Object.entries(f.counts).map(([table, n]) => `  rows ${table}: ${n}`),
    `  ROLLOUT_COUNTS=${formatCounts(f.counts)}`,
    ...report.reasons.map((r) => `  BLOCKED: ${r} — ${REASONS[r]}`),
    `  VERDICT=${report.verdict === 'READY' ? 'G22_READY_FOR_MIGRATION' : 'BLOCKED'}`,
  ];
}

export async function main(argv, deps = defaultDeps) {
  const fail = (phase, detail) => { deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`); deps.log('PILOT_G22_PREFLIGHT_RESULT=ERROR'); return 1; };
  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);

  let file;
  try { file = deps.readUrlFile(deps.urlFile); } catch { file = { ok: false, reason: 'private URL file could not be read' }; }
  if (!file.ok) return fail('config', `${URL_FILE_LABEL}: ${file.reason}`);
  const heldUrl = typeof file.text === 'string' ? file.text.replace(/\r?\n$/, '') : '';
  const parsedUrl = parsePilotUrl(heldUrl);
  if (!parsedUrl.ok) return fail('config', `${URL_FILE_LABEL} must hold one PostgreSQL URL (value not shown)`);
  if (parsed.confirmProjectRef !== null && deriveProjectRef(parsedUrl.conn) !== parsed.confirmProjectRef) {
    return fail('target', '--confirm-project-ref does not match the project addressed by the private URL file (values not shown)');
  }

  const proof = await proveIdentity({ ...deps, log: () => {}, error: () => {} }, heldUrl, parsed.markerId);
  if (proof !== 0) return fail('identity', 'PILOT identity proof failed; nothing else was read');

  const snapshot = await readSnapshot(deps, parsedUrl.conn, parsed.markerId);
  if (!snapshot.ok) return fail('snapshot', snapshot.reason);
  const report = assessSource(snapshot, deps.schema, SOURCE_GENERATION);

  for (const line of reportLines(report, { confirmProjectRef: parsed.confirmProjectRef })) deps.log(line);
  if (report.reasons.includes('EMAIL_COLLISION')) deps.log('USER_MGMT_EMAIL_COLLISION_BLOCKER');
  deps.log(`PILOT_G22_PREFLIGHT_RESULT=${report.verdict === 'READY' ? 'G22_READY_FOR_MIGRATION' : 'BLOCKED'}`);
  return report.verdict === 'READY' ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
