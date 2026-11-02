// READ-ONLY PILOT post-migration verifier for the USER-MGMT rollout (G20 -> G21 -> G22). Zero writes, zero DDL, no Prisma. It proves that PILOT is EXACTLY EXACT_G22
// and that the two additive migrations changed no operational data. Run it right after pilot-g22-migrate.mjs and BEFORE the new API is deployed: it also requires
// every existing user to still hold the migration defaults (mustChangePassword = false, credentialsChangedAt NULL) and UserAdminOperation to be empty.
//
//   node scripts/database/pilot-g22-verify.mjs --target=pilot --check --marker-id=<uuid> --expected-counts='<json printed by the preflight as ROLLOUT_COUNTS>' \
//     [--confirm-project-ref=<ref>]
//
// Checks (one REPEATABLE READ READ ONLY snapshot on a verified-TLS client, always ROLLBACK): the PILOT marker; the ledger is exactly the 22 reviewed migrations,
// all finished, none rolled back, every checksum equal to its pin; the app-schema digest equals the pinned EXACT_G22 reference and every reviewed probe passes
// (lower(email) unique index, UserAdminOperation with its CHECK constraints, FKs, unique (actorId, idempotencyKey) and (targetUserId, createdAt) index); the
// fingerprint shows 360 columns and 38 relations (the Prisma ledger table included); the lower(email) index is UNIQUE; the G21 defaults hold for every user; and
// the frozen business counts (User, UserRoleScope, Sale, SalePayment, CashSession, Inventory, StockMovement, SaleExchange, SaleVoid, AuditLog) equal the expected
// ones. A changed AuditLog count is a failure like any other. Output never carries a URL, host, user, password, project ref, e-mail or hash.
import { pathToFileURL } from 'node:url';
import {
  PILOT_URL_FILE, createVerifiedClient, deriveProjectRef, parsePilotUrl, readPrivateUrlFile,
} from './pilot-marker.mjs';
import { PROJECT_REF_PATTERN } from './lib.mjs';
import { GENERATION_SCHEMA_G22 } from './pilot-g22-schema-references.mjs';
import { TARGET_GENERATION, formatCounts, parseCounts, proveIdentity, readSnapshot, verifyTarget } from './pilot-g22-rollout.mjs';

const PREFIX = '[db:pilot-g22-verify]';
const URL_FILE_LABEL = '~/.config/mona-jacinta/pilot-database-url';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref', 'expected-counts'];

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
  const counts = parseCounts(values['expected-counts'] ?? '');
  if (!counts.ok) return { ok: false, error: '--expected-counts must be exactly the ROLLOUT_COUNTS JSON the preflight printed (the ten frozen tables, non-negative integers)' };
  return { ok: true, markerId: values['marker-id'], confirmProjectRef, expectedCounts: counts.counts };
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

export function reportLines(verdict, facts, { confirmProjectRef = null } = {}) {
  return [
    `${PREFIX} READ-ONLY — nothing was written (REPEATABLE READ READ ONLY, always ROLLBACK)`,
    '  identity: PILOT marker proven (values not shown)',
    `  project ref: ${confirmProjectRef === null ? 'not checked (no --confirm-project-ref)' : 'matches --confirm-project-ref'}`,
    `  target generation: ${TARGET_GENERATION}; app schema digest: ${verdict.digest ?? 'not computed'}`,
    `  users: ${facts.users.total} (mustChangePassword=true: ${facts.userDefaults?.mustChange ?? 'n/a'}, credentialsChangedAt set: ${facts.userDefaults?.credentialsSet ?? 'n/a'})`,
    `  UserAdminOperation rows: ${facts.adminOperations ?? 'n/a'}`,
    ...Object.entries(facts.counts).map(([table, n]) => `  rows ${table}: ${n}`),
    `  ROLLOUT_COUNTS=${formatCounts(facts.counts)}`,
    ...verdict.failures.map((f) => `  FAILED: ${f}`),
    `  VERDICT=${verdict.ok ? 'EXACT_G22_VERIFIED' : 'FAILED'}`,
  ];
}

export async function main(argv, deps = defaultDeps) {
  const fail = (phase, detail) => { deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`); deps.log('PILOT_G22_VERIFY_RESULT=ERROR'); return 1; };
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

  const snapshot = await readSnapshot(deps, parsedUrl.conn, parsed.markerId, { userDefaults: true, adminOperations: true });
  if (!snapshot.ok) return fail('snapshot', snapshot.reason);
  const verdict = verifyTarget(snapshot, TARGET_GENERATION, { expectedCounts: parsed.expectedCounts, schema: deps.schema, fingerprint: deps.fingerprint });

  for (const line of reportLines(verdict, snapshot.facts, { confirmProjectRef: parsed.confirmProjectRef })) deps.log(line);
  deps.log(`PILOT_G22_VERIFY_RESULT=${verdict.ok ? 'EXACT_G22_VERIFIED' : 'FAILED'}`);
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
