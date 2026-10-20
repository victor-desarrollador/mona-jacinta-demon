// OWNER-only, PILOT-only, READ-ONLY Local 1 preflight: the three Local 1 accounts and their
// effective access to PCEN, catalog aggregates, PCEN inventory and PCEN stock movements.
//
//   env -i HOME=<passwd home> PATH=/usr/bin:/bin LANG=C.UTF-8 \
//     <absolute node v24.20.0> scripts/database/pilot-local1-preflight.mjs --target=pilot --read-only-local1
//
// Agents never execute it against a live database (AGENTS.md "Database safety"): the OWNER
// launches it with buildOwnerCommand's command. It follows pilot-a4-readonly.mjs exactly:
// before any database client exists, in this order: exact arguments; Node v24.20.0 with no
// runtime options and an environment of exactly HOME/PATH/LANG; the code manifest
// (pilot-launch-command.mjs verifyCodeManifest: every pinned repository file and the pg
// dependency closure); the private files under the passwd home; and the target (a supported
// Supabase host shape whose project ref digest is the pinned PILOT digest, never a forbidden
// one). Static imports are node:* builtins and the builtins-only pilot-launch-command.mjs
// (pinned by the OWNER command); pilot-marker.mjs (and through it pg) and the shared G11
// modules are imported only after the manifest verified.
//
// One connection, one REPEATABLE READ READ ONLY transaction, statements only from the frozen
// STATEMENTS map plus the shared modules' constant SQL, then ROLLBACK (never COMMIT). Proofs, in
// order, before any business row is read: read-only, TEST guard absent, canonical PILOT marker
// (structure + row = the private marker id), relation safety, EXACT_G11 (strict ledger, the
// app-schema projection equal to the generated G11 reference, the G11 probes, CATALOG_36), every
// row count bounded, then the PCEN identity (one active RETAIL_BRANCH Location and its Branch).
// Table reads are plain `FROM ONLY` column projections with no filtering, ordering or comparison
// in the database (done in JavaScript, so no value is ever interpolated or bound): the PCEN id
// and the three account emails are reviewed constants compared here. No password or hash column
// is ever selected. Output: deterministic KEY=VALUE lines printed only after a confirmed
// ROLLBACK; never a URL, host, user, password, project ref, marker id, SKU or barcode.

import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkPrivateDir, checkRuntime, readPrivateFile, sha256, verifyCodeManifest } from './pilot-launch-command.mjs';

const PREFIX = '[db:pilot-local1-preflight]';
const TOOL = 'pilot-local1-preflight';
const TOOL_REL = 'scripts/database/pilot-local1-preflight.mjs';
const MANIFEST_REL = 'scripts/database/pilot-local1-preflight.manifest.json';
const LAUNCH_REL = 'scripts/database/pilot-launch-command.mjs';
const MAX_PRIVATE_BYTES = 4096;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The PCEN Location/Branch id (OWNER-declared, 2026-10-19; Location.id == Branch.id).
export const PCEN_LOCATION_ID = '2477257d-2567-4fd6-9df7-1e078676b7ad';
// The Local 1 accounts (pilot-bootstrap.mjs PILOT_ACCOUNTS) and the assignment each must hold.
export const LOCAL1_ACCOUNTS = Object.freeze([
  Object.freeze({ email: 'administrador01@pilot.local', role: 'ADMIN', scopeKind: 'COMPANY' }),
  Object.freeze({ email: 'vendedor01@pilot.local', role: 'SELLER', scopeKind: 'LOCATION' }),
  Object.freeze({ email: 'cajero01@pilot.local', role: 'CASHIER', scopeKind: 'LOCATION' }),
]);
// The synthetic PILOT catalog (pilot-catalog-bootstrap.mjs CATALOG, a test asserts equality): the exact
// SKU + barcode pairs that identify a synthetic variant. Only these constants are ever printed as SKUs.
export const SYNTHETIC_VARIANTS = Object.freeze(['REMBAS-BLA-S', 'REMBAS-BLA-M', 'REMBAS-BLA-L', 'REMOVR-NEG-M', 'REMOVR-NEG-L',
  'JEANRC-AZU-38', 'JEANRC-AZU-40', 'JEANRC-AZU-42', 'CARGO-VER-M', 'CARGO-VER-L', 'BUZO-GRI-S', 'BUZO-GRI-M', 'BUZO-GRI-L',
  'CAMP-NEG-M', 'CAMP-NEG-L', 'CAMP-BEI-M'].map((sku, i) => Object.freeze({ sku: `PILOT-${sku}`, barcode: `PILOT-BC-${String(i + 1).padStart(4, '0')}` })));
// Pricing V2 adjustments over the cash base Local 1 requires (OWNER-confirmed 2026-10-19); QR is not used initially.
export const LOCAL1_PRICING = Object.freeze({ LIST: 2500, CREDIT_CARD: 2500, DEBIT_CARD: 625, BANK_TRANSFER: 1250 });
const SALE_STATUSES = new Set(['DRAFT', 'PENDING_PAYMENT', 'PAID', 'COMPLETED', 'CANCELLED']);
const RESERVATION_STATUSES = new Set(['ACTIVE', 'RELEASED', 'CONSUMED']);
const ATTEMPT_STATUSES = new Set(['RESERVED', 'CONFIRMED', 'REJECTED', 'ABANDONED']);
const PRICING_MODELS = new Set(['FIXED_TOTAL', 'PROPORTIONAL_V1']);
const PRICING_TIERS = new Set(['LIST', 'WHOLESALE']);
// pricing.ts paymentMethodPriceMode: the price mode each payment method charges.
const METHOD_PRICE_MODE = Object.freeze({ CASH: 'CASH', TRANSFER: 'BANK_TRANSFER', CARD_DEBIT: 'DEBIT_CARD', CARD_CREDIT: 'CREDIT_CARD', QR: 'QR' });
// api/src/modules/rbac: the Production roles; a COMPANY row is valid only for OWNER/ADMIN.
const PRODUCTION_ROLES = new Set(['OWNER', 'ADMIN', 'CASHIER', 'SELLER', 'WAREHOUSE']);
const COMPANY_SCOPE_ROLES = new Set(['OWNER', 'ADMIN']);

// Same pinned digests as pilot-a4-readonly.mjs / pilot-backup.mjs (a test asserts equality).
const REF_DOMAIN = 'mona-pilot-project-ref\n';
export const REF_DIGESTS = Object.freeze({
  pilot: 'cae01c80a53cf8cf392f309a7f7e0bc402da862c93dedf7347e608075d402c64',
  forbidden: Object.freeze([
    '192f53743dd344fe51a2839109650387c7b12140efeef8aa714d23c3d35776a1', // LOCAL1
    '0ecc4e2617f88b2baafbd1ef659711f7330c99d09e9292dc245ca09702d85d5f', // TEST
    'afeac2094ae5b5ca1b1f695cd864a9abc707b64ba99c81bc0464d8509d94d0af', // PRODUCTION
  ]),
});

export const PACKAGE_CLOSURE = Object.freeze(['pg', 'pg-connection-string', 'pg-pool', 'pg-protocol', 'pg-types', 'pgpass',
  'split2', 'pg-int8', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'pg-cloudflare', 'xtend']);
// All eleven reviewed migrations (pilot-migration-states.mjs pins the same list; a test asserts it).
export const MIGRATIONS = Object.freeze([
  '20260907015311_init', '20260912182432_add_company_location', '20260912191702_add_user_role_scope',
  '20260922210000_d3_initial_stock_and_global_audit', '20261002120000_block1_pricing_wholesale',
  '20261006120000_pilot_pricing_v2', '20261012120000_cash_session_reconciliation',
  '20261016120000_r3_proportional_checkout', '20261016130000_r3_checkout_attempts',
  '20261018120000_cash_movement_withdrawals_expenses', '20261018180000_cash_movement_reversals', '20261021120000_r3_card_credit',
]);
export const SHARED_MODULES = Object.freeze({
  states: 'scripts/database/pilot-migration-states.mjs',
  projection: 'scripts/database/app-schema-projection.mjs',
  references: 'scripts/database/pilot-schema-references.mjs',
  rbac: 'scripts/database/pilot-rbac-catalog.mjs',
});
export const REQUIRED_REPO_FILES = Object.freeze(['scripts/database/pilot-marker.mjs', 'scripts/database/lib.mjs', LAUNCH_REL,
  'scripts/certs/supabase-prod-ca-2021.crt', ...Object.values(SHARED_MODULES), ...MIGRATIONS.map((m) => `api/prisma/migrations/${m}/migration.sql`)]);

// Every relation this tool reads (catalog/ledger through the shared modules, the rest here).
const LEDGER_TABLE = '_prisma_migrations';
const CATALOG_TABLES = Object.freeze(['Role', 'Permission', 'RolePermission']);
const BUSINESS_TABLES = Object.freeze(['Location', 'Branch', 'User', 'UserRoleScope', 'Product', 'ProductVariant', 'Inventory', 'StockMovement',
  'StockReservation', 'Sale', 'SalePayment', 'CheckoutAttempt', 'Company', 'CompanyPricingConfig',
  'SaleItem', 'CashMovement', 'CashSession', 'CashRegister', 'SaleCheckout']);
const READ_TABLES = Object.freeze([...CATALOG_TABLES, ...BUSINESS_TABLES, LEDGER_TABLE]);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
for (const t of READ_TABLES) if (!IDENT.test(t)) throw new Error('invalid table constant');
const PUBLIC_NS = "(SELECT n.oid FROM pg_namespace n WHERE n.nspname = 'public')";
// Objects created by initdb have OIDs below FirstNormalObjectId (16384): "built-in".
const HEAP_AM = (relam) => `(${relam} = (SELECT am.oid FROM pg_am am WHERE am.amname = 'heap') AND ${relam} < 16384::oid)`;
const BUILTIN_INDEXES = (rel) => `NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam WHERE i.indrelid = ${rel} AND (am.oid >= 16384::oid OR am.amhandler::oid >= 16384::oid OR EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) AS oc(o) WHERE oc.o >= 16384::oid)))`;
// Hard cap on rows fetched by any read (taken from the count in the same snapshot).
const ROW_READ_CAP = 100000n;
const COUNT = /^(0|[1-9][0-9]{0,18})$/;
const INTEGER = /^-?(0|[1-9][0-9]{0,30})$/;
const LOCATION_CODE = /^[A-Z][A-Z0-9]{1,9}$/;
const ID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POOLER_HOST = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const DIRECT_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/;
const POOLER_USER = /^postgres\.([a-z0-9]{20})$/;

// The only SQL this tool can send besides the shared modules' constants. Constant text, one
// statement each, no parameters. The identity statements are byte-identical to pilot-a4-readonly.mjs.
export const STATEMENTS = Object.freeze({
  BEGIN: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  SET_SEARCH_PATH: 'SET LOCAL search_path TO pg_catalog, pg_temp',
  SET_LOCK_TIMEOUT: "SET LOCAL lock_timeout = '5s'",
  SET_STATEMENT_TIMEOUT: "SET LOCAL statement_timeout = '15s'",
  SET_NO_INDEXSCAN: 'SET LOCAL enable_indexscan = off',
  SET_NO_INDEXONLYSCAN: 'SET LOCAL enable_indexonlyscan = off',
  SET_NO_BITMAPSCAN: 'SET LOCAL enable_bitmapscan = off',
  SET_NO_JIT: 'SET LOCAL jit = off',
  READ_ONLY: "SELECT current_setting('transaction_read_only') AS ro",
  GUARDS: "SELECT to_regnamespace('mona_test_guard') IS NOT NULL AS test_guard, to_regnamespace('mona_pilot_guard') IS NOT NULL AS pilot_schema, to_regclass('mona_pilot_guard.database_identity') IS NOT NULL AS pilot_table",
  LOCK_MARKER: 'LOCK TABLE mona_pilot_guard.database_identity IN ACCESS SHARE MODE',
  MARKER_FACTS: `SELECT json_build_object(
  'schemaOwnerIsCurrentUser', (SELECT pg_get_userbyid(n.nspowner) = current_user
     FROM pg_namespace n WHERE n.nspname = 'mona_pilot_guard'),
  'relations', (SELECT coalesce(json_agg(json_build_object('name', c.relname, 'kind', c.relkind)), '[]'::json)
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'mona_pilot_guard'),
  'table', (SELECT json_build_object(
       'kind', c.relkind, 'persistence', c.relpersistence, 'isPartition', c.relispartition, 'ofType', c.reloftype <> 0,
       'ownerIsCurrentUser', pg_get_userbyid(c.relowner) = current_user, 'rowSecurity', c.relrowsecurity,
       'forceRowSecurity', c.relforcerowsecurity, 'hasSubclass', c.relhassubclass,
       'parents', (SELECT count(*) FROM pg_inherits i WHERE i.inhrelid = c.oid),
       'children', (SELECT count(*) FROM pg_inherits i WHERE i.inhparent = c.oid),
       'hasRules', c.relhasrules, 'triggers', (SELECT count(*) FROM pg_trigger t WHERE t.tgrelid = c.oid))
     FROM pg_class c WHERE c.oid = to_regclass('mona_pilot_guard.database_identity')),
  'columns', (SELECT coalesce(json_agg(json_build_object(
       'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull,
       'default', pg_get_expr(d.adbin, d.adrelid), 'generated', a.attgenerated, 'identity', a.attidentity,
       'collation', (SELECT co.collname FROM pg_collation co WHERE co.oid = a.attcollation))
       ORDER BY a.attnum), '[]'::json)
     FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = to_regclass('mona_pilot_guard.database_identity') AND a.attnum > 0 AND NOT a.attisdropped),
  'constraints', (SELECT coalesce(json_agg(json_build_object('type', con.contype, 'definition', pg_get_constraintdef(con.oid))), '[]'::json)
     FROM pg_constraint con WHERE con.conrelid = to_regclass('mona_pilot_guard.database_identity') AND con.contype <> 'n')
) AS facts`,
  MARKER_ACCESS: `SELECT ${HEAP_AM('c.relam')} AS heap_am, ${BUILTIN_INDEXES('c.oid')} AS indexes_builtin FROM pg_class c WHERE c.oid = to_regclass('mona_pilot_guard.database_identity')`,
  MARKER_ROWS: 'SELECT environment, marker_id::text AS marker_id, installed_at IS NOT NULL AS has_installed_at FROM mona_pilot_guard.database_identity',
  RELATIONS: `SELECT v.name, c.relkind::text AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls, c.relhasrules AS rules, c.relowner = (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user) AS owned, ${HEAP_AM('c.relam')} AS heap_am, ${BUILTIN_INDEXES('c.oid')} AS indexes_builtin, c.relhassubclass AS has_subclass, c.relispartition AS is_partition FROM unnest(ARRAY[${READ_TABLES.map((n) => `'${n}'`).join(', ')}]::text[]) AS v(name) LEFT JOIN pg_class c ON c.relname = v.name AND c.relnamespace = ${PUBLIC_NS}`,
  COUNT__prisma_migrations: 'SELECT count(*)::text AS n FROM ONLY public._prisma_migrations',
  ...Object.fromEntries([...CATALOG_TABLES, ...BUSINESS_TABLES].map((t) => [`COUNT_${t}`, `SELECT count(*)::text AS n FROM ONLY public."${t}"`])),
  LOCATIONS: 'SELECT id, "companyId" AS company_id, code, type, "isActive" AS active FROM ONLY public."Location"',
  BRANCHES: 'SELECT id, code FROM ONLY public."Branch"',
  USERS: 'SELECT id, email, "isActive" AS active FROM ONLY public."User"',
  ROLE_SCOPES: 'SELECT "userId" AS user_id, "roleId" AS role_id, "scopeKind" AS scope_kind, "locationId" AS location_id FROM ONLY public."UserRoleScope"',
  PRODUCTS: 'SELECT id, "isActive" AS active FROM ONLY public."Product"',
  VARIANTS: 'SELECT id, "productId" AS product_id, sku, barcode, "isActive" AS active FROM ONLY public."ProductVariant"',
  INVENTORY: 'SELECT id, "variantId" AS variant_id, "branchId" AS branch_id, physical::text AS physical, reserved::text AS reserved FROM ONLY public."Inventory"',
  MOVEMENTS: 'SELECT type, "branchId" AS branch_id, "inventoryId" AS inventory_id, "quantityDelta"::text AS delta FROM ONLY public."StockMovement"',
  // Expiry is decided in JavaScript on epoch milliseconds of the same snapshot's statement clock (no
  // TimeZone/DateStyle dependence); the canonical release treats expiresAt <= now as expired.
  RESERVATIONS: 'SELECT id, "saleId" AS sale_id, "variantId" AS variant_id, "branchId" AS branch_id, quantity::text AS quantity, status, floor(extract(epoch FROM "expiresAt") * 1000)::text AS expires_ms, floor(extract(epoch FROM statement_timestamp()) * 1000)::text AS now_ms FROM ONLY public."StockReservation"',
  // Money is cast to text and parsed as BigInt in JavaScript (never a float).
  SALES: 'SELECT id, "branchId" AS branch_id, status, total::text AS total, subtotal::text AS subtotal, "discountTotal"::text AS discount_total, "pricingModel" AS pricing_model, "priceMode" AS price_mode, "pricingMode" AS pricing_mode, "wholesaleConfirmedAt" IS NOT NULL AS wholesale_confirmed FROM ONLY public."Sale"',
  SALE_ITEMS: 'SELECT "saleId" AS sale_id, "variantId" AS variant_id, quantity::text AS quantity, "unitPrice"::text AS unit_price, subtotal::text AS subtotal FROM ONLY public."SaleItem"',
  // The canonical cancel refuses a sale holding ANY SalePayment row; the ids only join CashMovement (never printed).
  SALE_PAYMENTS: 'SELECT id, "saleId" AS sale_id, method, amount::text AS amount, "cashSessionId" IS NOT NULL AS has_session, "cashSessionId" AS session_id FROM ONLY public."SalePayment"',
  CASH_MOVEMENTS: 'SELECT "salePaymentId" AS sale_payment_id, type, amount::text AS amount FROM ONLY public."CashMovement"',
  CASH_SESSIONS: 'SELECT id, "registerId" AS register_id, status FROM ONLY public."CashSession"',
  CASH_REGISTERS: 'SELECT id, "branchId" AS branch_id FROM ONLY public."CashRegister"',
  SALE_CHECKOUTS: 'SELECT "saleId" AS sale_id FROM ONLY public."SaleCheckout"',
  CHECKOUT_ATTEMPTS: 'SELECT "saleId" AS sale_id, status FROM ONLY public."CheckoutAttempt"',
  COMPANIES: 'SELECT id FROM ONLY public."Company"',
  PRICING_CONFIG: 'SELECT "companyId" AS company_id, "listAdjustmentBps" AS list_bps, "creditCardAdjustmentBps" AS credit_bps, "debitCardAdjustmentBps" AS debit_bps, "bankTransferAdjustmentBps" AS transfer_bps, "qrAdjustmentBps" AS qr_bps FROM ONLY public."CompanyPricingConfig"',
  ROLLBACK: 'ROLLBACK',
});

const digest12 = (value) => sha256(String(value)).slice(0, 12);
// Removes every C0/C1 control character so database text can never drive the terminal.
const clean = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

// The OWNER launch command (a review artifact: this tool never runs it). Same trust root and
// shape as pilot-launch-command.mjs buildOwnerCommand for a non-namespaced tool: the digests bind
// the launch to the reviewed tool, manifest, launch module and Node bytes; they do not
// authenticate the operator.
const TRUSTED_UTILS = Object.freeze({
  env: '/usr/bin/env', sh: '/bin/sh', sha256sum: '/usr/bin/sha256sum', getent: '/usr/bin/getent',
  id: '/usr/bin/id', cut: '/usr/bin/cut', stat: '/usr/bin/stat',
});
const SAFE_ABSOLUTE = /^\/[^'"$`\\\n\r\0]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BUILDER_KEYS = Object.freeze(['launchSha256', 'manifestSha256', 'nodePath', 'nodeSha256', 'repoDir', 'toolSha256']);
export function buildOwnerCommand(spec) {
  if (spec === null || typeof spec !== 'object' || Object.keys(spec).sort().join(',') !== BUILDER_KEYS.join(',')) {
    throw new Error(`exactly ${BUILDER_KEYS.join(', ')} are accepted`);
  }
  const { repoDir, nodePath, toolSha256, manifestSha256, launchSha256, nodeSha256 } = spec;
  for (const value of [repoDir, nodePath]) {
    if (typeof value !== 'string' || !SAFE_ABSOLUTE.test(value) || path.posix.normalize(value) !== value) throw new Error('unsafe or relative path');
  }
  for (const d of [toolSha256, manifestSha256, launchSha256, nodeSha256]) {
    if (typeof d !== 'string' || !HEX64.test(d)) throw new Error('digests must be 64 lowercase hex characters');
  }
  const u = TRUSTED_UTILS;
  const q = (v) => `"${v}"`;
  const script = [
    'set -eu',
    `for u in ${Object.values(u).map(q).join(' ')}; do`,
    `  s=$(${q(u.stat)} -L -c %u:%a "$u") || exit 70`,
    '  case "$s" in 0:[0-7][0145][0145]) ;; *) echo "L1PF_LAUNCH=REFUSED untrusted utility" >&2; exit 71 ;; esac',
    'done',
    `cd ${q(repoDir)} || exit 72`,
    `printf "%s  %s\\n" ${toolSha256} ${TOOL_REL} ${manifestSha256} ${MANIFEST_REL} ${launchSha256} ${LAUNCH_REL} ${nodeSha256} ${q(nodePath)} | ${q(u.sha256sum)} --check --strict || exit 73`,
    `H=$(${q(u.getent)} passwd "$(${q(u.id)} -un)" | ${q(u.cut)} -d: -f6)`,
    '[ -n "$H" ] || exit 74',
    `exec ${q(u.env)} -i HOME="$H" PATH=/usr/bin:/bin LANG=C.UTF-8 ${q(nodePath)} ${TOOL_REL} --target=pilot --read-only-local1`,
  ].join('\n');
  return `${q(u.env)} -i ${q(u.sh)} -c '${script}'`;
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2) return { ok: false };
  const set = new Set(argv);
  return { ok: set.size === 2 && set.has('--target=pilot') && set.has('--read-only-local1') };
}

export function checkTarget(conn, refDigests, deriveProjectRef) {
  if (conn.port !== 5432 || conn.database !== 'postgres') return { ok: false, reason: 'port or database outside the supported contract' };
  let ref = null;
  if (POOLER_HOST.test(conn.host)) ref = POOLER_USER.exec(conn.user)?.[1] ?? null;
  else {
    const direct = DIRECT_HOST.exec(conn.host);
    if (direct && conn.user === 'postgres') ref = direct[1];
  }
  if (ref === null) return { ok: false, reason: 'host/user outside the supported Supabase contract' };
  if (deriveProjectRef(conn) !== ref) return { ok: false, reason: 'host and user disagree on the project' };
  const d = sha256(`${REF_DOMAIN}${ref}`);
  if (refDigests.forbidden.includes(d)) return { ok: false, reason: 'FORBIDDEN environment (LOCAL1/TEST/PRODUCTION); no connection opened' };
  if (d !== refDigests.pilot) return { ok: false, reason: 'project ref digest does not match the pinned PILOT digest; no connection opened' };
  return { ok: true, ref };
}

// ~/.config: a real directory, owned, not group/other writable (as pilot-a4-readonly.mjs).
function checkConfigDir(fs, uid, dir) {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

function defaultDeps() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  return {
    env: process.env, homedir: os.userInfo().homedir, uid: process.getuid(), execArgv: process.execArgv, version: process.version,
    root, fs: nodeFs,
    resolvePg: () => fileURLToPath(import.meta.resolve('pg')),
    importMarker: () => import(pathToFileURL(path.join(root, 'scripts', 'database', 'pilot-marker.mjs')).href),
    importShared: async () => {
      const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
      const [states, projection, references, rbac] = await Promise.all(Object.values(SHARED_MODULES).map(load));
      return { states, projection, rbac, references: { SCHEMA_REFERENCES: references.SCHEMA_REFERENCES, STATE_PROBES: references.STATE_PROBES } };
    },
    createClient: null, refDigests: REF_DIGESTS,
    log: (line) => console.log(line), error: (line) => console.error(line), endTimeoutMs: 5000,
  };
}

export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const refuse = (phase, reason, rc) => { deps.error(`${PREFIX} REFUSED: phase=${phase} — ${reason}`); deps.log('LOCAL1_PREFLIGHT_RESULT=REFUSED'); return rc; };

  if (!parseArgs(argv).ok) return refuse('args', 'exactly --target=pilot --read-only-local1 is accepted (arguments not echoed)', 1);
  const runtime = checkRuntime({ env: deps.env, execArgv: deps.execArgv, version: deps.version, expectedKeys: ['HOME', 'PATH', 'LANG'], homedir: deps.homedir });
  if (!runtime.ok) return refuse(runtime.phase, runtime.reason, 3);
  const integrity = verifyCodeManifest({ root: deps.root, manifestRel: MANIFEST_REL, fs: deps.fs, tool: TOOL, requiredRepoFiles: REQUIRED_REPO_FILES,
    packageClosure: PACKAGE_CLOSURE, binaries: [], resolvePg: deps.resolvePg });
  if (!integrity.ok) return refuse('integrity', integrity.reason, 3);

  let marker;
  try { marker = await deps.importMarker(); } catch { return refuse('integrity', 'pilot-marker.mjs could not be loaded', 3); }
  let shared;
  try {
    shared = await deps.importShared();
    if (typeof shared?.states?.requireState !== 'function' || typeof shared?.projection?.readProjection !== 'function'
      || typeof shared?.rbac?.classifyCatalog !== 'function' || shared?.references?.SCHEMA_REFERENCES?.EXACT_G11 === undefined) throw new Error('shape');
  } catch {
    return refuse('integrity', 'the shared G11 modules could not be loaded', 3);
  }

  const cfg = path.join(deps.homedir, '.config');
  const dir = path.join(cfg, 'mona-jacinta');
  if (!checkConfigDir(deps.fs, deps.uid, cfg) || !checkPrivateDir(deps.fs, deps.uid, dir)) {
    return refuse('config', 'private configuration directories must be real, owned and not group/other accessible', 3);
  }
  const urlFile = readPrivateFile(deps.fs, deps.uid, path.join(dir, 'pilot-database-url'), MAX_PRIVATE_BYTES);
  if (!urlFile.ok) return refuse('config', urlFile.reason, 3);
  const idFile = readPrivateFile(deps.fs, deps.uid, path.join(dir, 'pilot-marker-id'), MAX_PRIVATE_BYTES);
  if (!idFile.ok) return refuse('config', idFile.reason, 3);
  const markerId = idFile.bytes.toString('utf8').replace(/\n$/, '');
  if (!UUID_V4.test(markerId)) return refuse('config', 'pilot-marker-id must hold one canonical version-4 UUID (value not shown)', 3);
  const url = marker.parsePilotUrl(urlFile.bytes.toString('utf8'));
  if (!url.ok) return refuse('config', 'pilot-database-url must hold one PostgreSQL URL without query/fragment (value not shown)', 3);
  const { conn } = url;
  const target = checkTarget(conn, deps.refDigests, marker.deriveProjectRef);
  if (!target.ok) return refuse('target', target.reason, 3);

  return connectAndRead({ deps, marker, shared, conn, markerId, ref: target.ref });
}

async function connectAndRead({ deps, marker, shared, conn, markerId, ref }) {
  const secrets = [conn.password, conn.host, conn.user, conn.database, String(conn.port), ref, markerId];
  const fail = (phase, rc) => (err) => { deps.error(`${PREFIX} ERROR: phase=${phase} code=${marker.safeCode(err, secrets)} — nothing was changed`); deps.log('LOCAL1_PREFLIGHT_RESULT=ERROR'); return rc; };
  const createClient = deps.createClient ?? marker.createVerifiedClient;
  let client;
  try { client = createClient(conn); } catch (err) { return fail('connect', 4)(err); }

  let inTx = false;
  const run = async (id) => client.query(STATEMENTS[id]);
  // The shared modules' constant SQL (manifest-pinned bytes): the only text sent besides STATEMENTS.
  const sharedSql = new Set([shared.states.LEDGER_SQL, ...Object.values(shared.projection.PROJECTION_SQL), ...Object.values(shared.rbac.CATALOG_SQL)]);
  const runShared = async (text) => {
    if (!sharedSql.has(text)) throw Object.assign(new Error('statement outside the allowlist'), { code: 'L1PF_ALLOWLIST' });
    return client.query(text);
  };
  const rollback = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { await client.query(STATEMENTS.ROLLBACK); inTx = false; return true; } catch { /* retried, then reported */ }
    }
    return false;
  };
  const destroy = () => { try { client.connection?.stream?.destroy?.(); } catch { /* best effort */ } };
  const refusedInTx = async (phase, reason) => {
    if (!(await rollback())) { deps.error(`${PREFIX} ERROR: phase=cleanup — ROLLBACK not confirmed`); deps.log('LOCAL1_PREFLIGHT_RESULT=ERROR'); return 5; }
    deps.error(`${PREFIX} REFUSED: phase=${phase} — ${reason}; nothing was changed`);
    deps.log('LOCAL1_PREFLIGHT_RESULT=REFUSED');
    return 2;
  };

  try {
    try { await client.connect(); } catch (err) { return fail('connect', 4)(err); }
    const stream = client.connection?.stream;
    if (stream?.encrypted !== true || stream?.authorized !== true) {
      deps.error(`${PREFIX} REFUSED: phase=connect — verified TLS is required`); deps.log('LOCAL1_PREFLIGHT_RESULT=REFUSED'); return 4;
    }

    await run('BEGIN'); inTx = true;
    for (const s of ['SET_SEARCH_PATH', 'SET_LOCK_TIMEOUT', 'SET_STATEMENT_TIMEOUT', 'SET_NO_INDEXSCAN', 'SET_NO_INDEXONLYSCAN', 'SET_NO_BITMAPSCAN', 'SET_NO_JIT']) await run(s);
    if ((await run('READ_ONLY')).rows?.[0]?.ro !== 'on') return refusedInTx('identity', 'transaction is not read-only');

    // ---- marker (same proof as pilot-a4-readonly.mjs) ----
    const g = (await run('GUARDS')).rows?.[0];
    if (!g || g.test_guard !== false) return refusedInTx('identity', 'a TEST marker schema exists or the guard check is unreadable; this is not PILOT');
    if (g.pilot_schema !== true || g.pilot_table !== true) return refusedInTx('identity', 'PILOT marker is absent or partial');
    try { await run('LOCK_MARKER'); } catch (err) {
      if (err?.code === '42P01' || err?.code === '3F000') return refusedInTx('identity', 'PILOT marker is not installed');
      throw err;
    }
    if (marker.verifyMarkerStructure((await run('MARKER_FACTS')).rows?.[0]?.facts ?? null) !== null) return refusedInTx('identity', 'marker structure is not canonical');
    const access = (await run('MARKER_ACCESS')).rows?.[0];
    if (access?.heap_am !== true || access?.indexes_builtin !== true) return refusedInTx('identity', 'marker table access method or indexes are not built-in');
    const mrows = (await run('MARKER_ROWS')).rows ?? [];
    if (mrows.length !== 1 || mrows[0].environment !== 'pilot' || mrows[0].has_installed_at !== true || mrows[0].marker_id !== markerId) {
      return refusedInTx('identity', 'marker row is not exactly one pilot row with the expected id');
    }

    // ---- relation safety (catalog only), then bounded counts ----
    const rel = (await run('RELATIONS')).rows ?? [];
    const unsafe = READ_TABLES.filter((t) => {
      const r = rel.find((x) => x.name === t);
      return !r || r.kind !== 'r' || r.rls !== false || r.force_rls !== false || r.rules !== false || r.owned !== true
        || r.heap_am !== true || r.indexes_builtin !== true || r.has_subclass !== false || r.is_partition !== false;
    });
    if (unsafe.length) return refusedInTx('identity', `relation contract unverified: ${unsafe.join(', ')}`);
    const counts = new Map();
    const bounded = async (t) => {
      const n = (await run(`COUNT_${t}`)).rows?.[0]?.n;
      if (!COUNT.test(String(n))) return `the ${t} row count is not a count`;
      if (BigInt(n) > ROW_READ_CAP) return `the ${t} row count is above the read cap`;
      counts.set(t, Number(n));
      return null;
    };

    // ---- EXACT_G11: strict ledger, schema reference, probes, CATALOG_36 ----
    const ledgerBound = await bounded(LEDGER_TABLE);
    if (ledgerBound) return refusedInTx('bounds', ledgerBound);
    const ledger = shared.states.requireState((await runShared(shared.states.LEDGER_SQL)).rows ?? null, 'EXACT_G11');
    const schema = await shared.projection.readProjection({ query: runShared });
    const reference = shared.projection.projectionDigest(schema) === shared.references.SCHEMA_REFERENCES.EXACT_G11.digest ? 'MATCH' : 'MISMATCH';
    const probes = shared.projection.runProbes(schema, shared.references.STATE_PROBES?.EXACT_G11 ?? []);
    for (const t of CATALOG_TABLES) { const b = await bounded(t); if (b) return refusedInTx('bounds', b); }
    const cat = async (key) => (await runShared(shared.rbac.CATALOG_SQL[key])).rows ?? null;
    const roleRows = await cat('roles');
    const catalog = shared.rbac.classifyCatalog({ roles: roleRows, permissions: await cat('permissions'), grants: await cat('grants') });
    const rbacState = catalog.ok ? catalog.catalog : 'UNCLASSIFIED';
    if (!ledger.ok || reference !== 'MATCH' || probes.length !== 0 || rbacState !== 'CATALOG_36') {
      return refusedInTx('state', `PILOT is not EXACT_G11 with CATALOG_36 (ledger=${ledger.ok ? 'EXACT_G11' : 'REFUSED'} reference=${reference} probes_failed=${probes.length} rbac=${rbacState})`);
    }

    for (const t of BUSINESS_TABLES) { const b = await bounded(t); if (b) return refusedInTx('bounds', b); }
    const read = async (id, table) => {
      const rows = (await run(id)).rows ?? [];
      if (rows.length !== counts.get(table)) throw Object.assign(new Error('row count changed inside the snapshot'), { code: 'L1PF_SNAPSHOT' });
      return rows;
    };

    // ---- PCEN identity ----
    const locations = await read('LOCATIONS', 'Location');
    const branches = await read('BRANCHES', 'Branch');
    const pcen = locations.filter((l) => l.id === PCEN_LOCATION_ID);
    if (pcen.length !== 1 || pcen[0].type !== 'RETAIL_BRANCH' || pcen[0].active !== true || !LOCATION_CODE.test(String(pcen[0].code))
      || branches.filter((b) => b.id === PCEN_LOCATION_ID).length !== 1) {
      return refusedInTx('pcen', 'the PCEN id is not exactly one active RETAIL_BRANCH Location with its Branch');
    }

    const data = {
      locations, roles: roleRows,
      users: await read('USERS', 'User'), scopes: await read('ROLE_SCOPES', 'UserRoleScope'),
      products: await read('PRODUCTS', 'Product'), variants: await read('VARIANTS', 'ProductVariant'),
      inventory: await read('INVENTORY', 'Inventory'), movements: await read('MOVEMENTS', 'StockMovement'),
      reservations: await read('RESERVATIONS', 'StockReservation'), sales: await read('SALES', 'Sale'),
      payments: await read('SALE_PAYMENTS', 'SalePayment'), attempts: await read('CHECKOUT_ATTEMPTS', 'CheckoutAttempt'),
      companies: await read('COMPANIES', 'Company'), pricing: await read('PRICING_CONFIG', 'CompanyPricingConfig'),
      items: await read('SALE_ITEMS', 'SaleItem'), cashMovements: await read('CASH_MOVEMENTS', 'CashMovement'),
      cashSessions: await read('CASH_SESSIONS', 'CashSession'), cashRegisters: await read('CASH_REGISTERS', 'CashRegister'),
      saleCheckouts: await read('SALE_CHECKOUTS', 'SaleCheckout'),
    };
    if (!(await rollback())) { deps.error(`${PREFIX} ERROR: phase=cleanup — ROLLBACK not confirmed; results not trusted`); deps.log('LOCAL1_PREFLIGHT_RESULT=ERROR'); return 5; }

    const report = buildReport(data, pcen[0]);
    deps.log(`${PREFIX} identity: canonical PILOT marker and EXACT_G11 (ledger, schema reference, probes, CATALOG_36) verified in one READ ONLY snapshot; ROLLBACK confirmed (values not shown)`);
    for (const l of report.details) deps.log(clean(l));
    deps.log(`  flags: ${report.flags.length ? report.flags.map(clean).join(', ') : 'none'}`);
    for (const [k, v] of report.keys) deps.log(`${k}=${clean(v)}`);
    deps.log('LOCAL1_PREFLIGHT_RESULT=VERIFIED');
    return 0;
  } catch (err) {
    const closed = inTx ? await rollback() : true;
    deps.error(`${PREFIX} ERROR: phase=read code=${marker.safeCode(err, secrets)} — nothing was changed`);
    deps.log('LOCAL1_PREFLIGHT_RESULT=ERROR');
    return closed ? 4 : 5;
  } finally {
    if (inTx) await rollback();
    if (inTx) destroy();
    await endBounded(client, deps.endTimeoutMs, destroy);
  }
}

const yn = (b) => (b ? 'YES' : 'NO');
const big = (v) => (typeof v === 'string' && INTEGER.test(v) ? BigInt(v) : null);
const missing = (v) => typeof v !== 'string' || v.trim() === '';
function duplicates(values) {
  const seen = new Map();
  for (const v of values) if (!missing(v)) seen.set(v, (seen.get(v) ?? 0) + 1);
  return [...seen.values()].filter((n) => n > 1).length;
}

// Pure: every aggregate from the snapshot rows. Never prints a row value except allowlisted
// shapes (location codes, UUID ids, the reviewed account emails).
export function buildReport({ locations, roles, users, scopes, products, variants, inventory, movements, reservations, sales, payments, attempts, companies, pricing,
  items, cashMovements, cashSessions, cashRegisters, saleCheckouts }, pcen) {
  const flags = [];
  const details = [];
  const roleCode = new Map((roles ?? []).map((r) => [r.id, r.code]));
  const locCode = new Map(locations.map((l) => [l.id, LOCATION_CODE.test(String(l.code)) ? String(l.code) : `INVALID(${digest12(l.code)})`]));
  const where = (id) => (id === null ? 'NONE' : id === PCEN_LOCATION_ID ? 'PCEN' : locCode.get(id) ?? `UNKNOWN(${digest12(id)})`);
  const keys = [['PILOT_STATE', 'EXACT_G11'], ['RBAC_STATE', 'CATALOG_36'], ['MARKER', 'VERIFIED'], ['PCEN_MATCH', 'YES'], ['PCEN_CODE', String(pcen.code)]];

  // ---- users (UserRoleScope is the sole Production authority; UserBranchRole is never read) ----
  for (const account of LOCAL1_ACCOUNTS) {
    const found = users.filter((u) => u.email === account.email);
    const u = found.length === 1 ? found[0] : null;
    if (found.length > 1) flags.push(`USER_DUPLICATE:${account.role}`);
    if (!u) {
      flags.push(`USER_MISSING:${account.role}`);
      keys.push([`${account.role}_EXISTS`, 'NO'], [`${account.role}_ACTIVE`, 'NO'], [`${account.role}_PCEN_ACCESS`, 'NO']);
      details.push(`  account ${account.role}: email=${account.email} exists=NO`);
      continue;
    }
    const active = u.active === true;
    if (!active) flags.push(`USER_INACTIVE:${account.role}`);
    const rows = scopes.filter((s) => s.user_id === u.id).map((s) => {
      const code = roleCode.get(s.role_id);
      const valid = typeof code === 'string' && PRODUCTION_ROLES.has(code) && (s.scope_kind === 'LOCATION' || (s.scope_kind === 'COMPANY' && COMPANY_SCOPE_ROLES.has(code)))
        && (s.scope_kind !== 'LOCATION' || typeof s.location_id === 'string') && (s.scope_kind !== 'COMPANY' || s.location_id === null);
      return { code: typeof code === 'string' && PRODUCTION_ROLES.has(code) ? code : `UNKNOWN(${digest12(s.role_id)})`, kind: s.scope_kind, location: s.location_id ?? null, valid };
    });
    if (rows.some((r) => !r.valid)) flags.push(`INVALID_ASSIGNMENT:${account.role}`);
    const expected = rows.some((r) => r.valid && r.code === account.role && r.kind === account.scopeKind
      && (account.scopeKind === 'COMPANY' || r.location === PCEN_LOCATION_ID));
    const sameRole = rows.filter((r) => r.valid && r.code === account.role);
    if (!expected) flags.push(sameRole.length ? `SCOPE_MISMATCH:${account.role}` : `SCOPE_MISSING:${account.role}`);
    if (rows.some((r) => r.valid && r.code !== account.role)) flags.push(`EXTRA_ROLE:${account.role}`);
    const listed = rows.map((r) => `${r.code}/${['COMPANY', 'LOCATION'].includes(r.kind) ? r.kind : 'INVALID'}@${where(r.location)}${r.valid ? '' : '(invalid)'}`).sort();
    keys.push([`${account.role}_EXISTS`, 'YES'], [`${account.role}_ACTIVE`, yn(active)], [`${account.role}_PCEN_ACCESS`, yn(active && expected)]);
    details.push(`  account ${account.role}: email=${account.email} id=${ID_TEXT.test(String(u.id)) ? u.id : digest12(u.id)} active=${active} assignments=[${listed.join(', ')}] expected=${account.role}/${account.scopeKind}${account.scopeKind === 'LOCATION' ? '@PCEN' : ''}`);
  }
  keys.push(['PASSWORD_HASH_READ', 'NO']);

  // ---- catalog ----
  const productActive = new Map(products.map((p) => [p.id, p.active === true]));
  const effectiveActive = (v) => v.active === true && productActive.get(v.product_id) === true;
  keys.push(['PRODUCT_COUNT', String(products.length)], ['ACTIVE_PRODUCT_COUNT', String(products.filter((p) => p.active === true).length)],
    ['VARIANT_COUNT', String(variants.length)], ['ACTIVE_VARIANT_COUNT', String(variants.filter((v) => v.active === true).length)],
    ['MISSING_SKU', String(variants.filter((v) => missing(v.sku)).length)], ['MISSING_BARCODE', String(variants.filter((v) => missing(v.barcode)).length)],
    ['DUPLICATE_SKU', String(duplicates(variants.map((v) => v.sku)))], ['DUPLICATE_BARCODE', String(duplicates(variants.map((v) => v.barcode)))]);
  if (variants.some((v) => !productActive.has(v.product_id))) flags.push('VARIANT_WITHOUT_PRODUCT');

  // ---- PCEN inventory (BigInt only) ----
  const variantById = new Map(variants.map((v) => [v.id, v]));
  const pcenRows = inventory.filter((i) => i.branch_id === PCEN_LOCATION_ID);
  let physical = 0n; let reserved = 0n; let ltZeroP = 0; let ltZeroR = 0; let gt = 0; let orphan = 0; let inactiveStock = 0;
  for (const i of pcenRows) {
    const p = big(i.physical); const r = big(i.reserved);
    if (p === null || r === null) { flags.push('INVALID_VALUE:Inventory'); continue; }
    physical += p; reserved += r;
    if (p < 0n) ltZeroP += 1;
    if (r < 0n) ltZeroR += 1;
    if (p >= 0n && r >= 0n && r > p) gt += 1;
    const v = variantById.get(i.variant_id);
    if (!v) orphan += 1;
    else if (p > 0n && !effectiveActive(v)) inactiveStock += 1;
  }
  const withRow = new Set(pcenRows.map((i) => i.variant_id));
  keys.push(['INVENTORY_ROWS', String(pcenRows.length)], ['TOTAL_PHYSICAL', String(physical)], ['TOTAL_RESERVED', String(reserved)],
    ['PHYSICAL_LT_ZERO', String(ltZeroP)], ['RESERVED_LT_ZERO', String(ltZeroR)], ['RESERVED_GT_PHYSICAL', String(gt)],
    ['INVENTORY_WITHOUT_VARIANT', String(orphan)], ['INVENTORY_INVARIANT_ERRORS', String(ltZeroP + ltZeroR + gt + orphan)],
    ['ACTIVE_VARIANTS_WITHOUT_INVENTORY', String(variants.filter((v) => effectiveActive(v) && !withRow.has(v.id)).length)],
    ['INACTIVE_VARIANTS_WITH_STOCK', String(inactiveStock)],
    ['OTHER_LOCATION_INVENTORY_ROWS', String(inventory.length - pcenRows.length)]);

  // ---- PCEN stock movements ----
  const pcenMoves = movements.filter((m) => m.branch_id === PCEN_LOCATION_ID);
  const initial = pcenMoves.filter((m) => m.type === 'INITIAL_STOCK');
  let initialUnits = 0n;
  for (const m of initial) { const d = big(m.delta); if (d === null) flags.push('INVALID_VALUE:StockMovement'); else initialUnits += d; }
  const sale = pcenMoves.filter((m) => m.type === 'SALE').length;
  keys.push(['INITIAL_STOCK_MOVEMENTS', String(initial.length)], ['INITIAL_STOCK_UNITS', String(initialUnits)], ['SALE_MOVEMENTS', String(sale)],
    ['OTHER_MOVEMENTS', String(pcenMoves.length - initial.length - sale)],
    // Any PCEN initial stock or any PCEN unit means a new import could add units on top.
    ['INITIAL_STOCK_DUPLICATION_RISK', yn(initial.length > 0 || physical > 0n)]);

  // ---- the synthetic ACTIVE reservation (decision input for the canonical cancel / release) ----
  const synthetic = new Map();
  for (const v of variants) {
    const s = SYNTHETIC_VARIANTS.find((x) => x.sku === v.sku && x.barcode === v.barcode);
    if (s) synthetic.set(v.id, s.sku);
  }
  const active = reservations.filter((r) => r.status === 'ACTIVE');
  const mine = active.filter((r) => synthetic.has(r.variant_id));
  const reservedUnits = pcenRows.filter((i) => synthetic.has(i.variant_id)).reduce((a, i) => a + (big(i.reserved) ?? 0n), 0n);
  const activeUnits = mine.filter((r) => r.branch_id === PCEN_LOCATION_ID).reduce((a, r) => a + (big(r.quantity) ?? 0n), 0n);
  const saleById = new Map(sales.map((x) => [x.id, x]));
  const paid = new Set(payments.map((x) => x.sale_id));
  const classify = (r) => {
    const sale = saleById.get(r.sale_id);
    const expires = big(r.expires_ms); const now = big(r.now_ms);
    const expired = expires !== null && now !== null && expires <= now;
    const saleAttempts = attempts.filter((a) => a.sale_id === r.sale_id);
    let kind;
    if (!sale || sale.branch_id !== r.branch_id || r.branch_id !== PCEN_LOCATION_ID) kind = 'ORPHAN_RESERVED_STATE';
    else if (paid.has(r.sale_id)) kind = 'PAYMENT_ACCEPTED';
    else if (saleAttempts.some((a) => a.status === 'RESERVED')) kind = 'CHECKOUT_ATTEMPT_ACTIVE';
    else if (sale.status !== 'PENDING_PAYMENT') kind = 'ORPHAN_RESERVED_STATE';
    else if (expired) kind = 'EXPIRED';
    else kind = 'PENDING_NO_PAYMENT';
    return { kind, expired, sale, attempts: saleAttempts.length };
  };
  const classified = mine.map((r) => ({ r, ...classify(r) }));
  let classification;
  if (reservedUnits !== activeUnits) classification = 'ORPHAN_RESERVED_STATE';
  else if (classified.length === 0) classification = 'NONE';
  else classification = [...new Set(classified.map((c) => c.kind))].sort().join(',');
  if (reservedUnits !== activeUnits) flags.push('RESERVED_UNITS_MISMATCH');
  const one = classified.length === 1 ? classified[0] : null;
  const many = classified.length > 1 ? 'MULTIPLE' : 'NONE';
  const saleStatus = (sale) => (SALE_STATUSES.has(sale?.status) ? sale.status : `INVALID(${digest12(sale?.status)})`);
  for (const c of classified) {
    details.push(`  synthetic reservation: variant=${synthetic.get(c.r.variant_id)} at=${where(c.r.branch_id)} quantity=${big(c.r.quantity) ?? 'INVALID'} expired=${c.expired} sale=${c.sale ? saleStatus(c.sale) : 'MISSING'} payment=${paid.has(c.r.sale_id)} attempts=${c.attempts} → ${c.kind}`);
  }
  keys.push(['SYNTHETIC_ACTIVE_RESERVATIONS', String(mine.length)], ['SYNTHETIC_RESERVED_UNITS', String(reservedUnits)],
    ['SYNTHETIC_ACTIVE_RESERVATION_UNITS', String(activeUnits)], ['OTHER_ACTIVE_RESERVATIONS', String(active.length - mine.length)],
    ['RESERVATION_EXPIRED', one ? yn(one.expired) : many], ['RESERVATION_VARIANT', one ? synthetic.get(one.r.variant_id) : many],
    ['RESERVATION_SALE_PRESENT', one ? yn(one.sale !== undefined) : many], ['RESERVATION_SALE_STATUS', one ? (one.sale ? saleStatus(one.sale) : 'NONE') : many],
    ['ACCEPTED_PAYMENT_PRESENT', one ? yn(paid.has(one.r.sale_id)) : many], ['CHECKOUT_ATTEMPT_PRESENT', one ? yn(one.attempts > 0) : many],
    ['RESERVATION_CLASSIFICATION', classification]);

  // ---- the paid-pending synthetic sale: can the canonical payment + completion path finish it? ----
  keys.push(...paidPendingEvidence({ mine, saleById, payments, items, reservations, cashMovements, cashSessions, cashRegisters, saleCheckouts, flags }));

  // ---- every OPEN sale holding an exact synthetic item (the deactivate-catalog precondition) ----
  keys.push(...openSyntheticSalesEvidence({ synthetic, variants, products, sales, items, payments, reservations, attempts, cashMovements, cashSessions, saleCheckouts, flags }));

  // ---- real vs synthetic (exact identity, never a prefix): the Local 1 final verification ----
  const syntheticProducts = new Set(variants.filter((v) => synthetic.has(v.id)).map((v) => v.product_id));
  const inventoryVariant = new Map(inventory.map((i) => [i.id, i.variant_id]));
  let realInitial = 0n; let syntheticInitial = 0n; let unmapped = 0;
  for (const m of initial) {
    const d = big(m.delta);
    if (d === null) continue;
    const variantId = inventoryVariant.get(m.inventory_id);
    if (variantId === undefined) unmapped += 1;
    if (variantId !== undefined && synthetic.has(variantId)) syntheticInitial += d; else realInitial += d;
  }
  keys.push(['REAL_ACTIVE_PRODUCTS', String(products.filter((p) => p.active === true && !syntheticProducts.has(p.id)).length)],
    ['REAL_ACTIVE_VARIANTS', String(variants.filter((v) => v.active === true && !synthetic.has(v.id)).length)],
    ['INACTIVE_SYNTHETIC_PRODUCTS', String(products.filter((p) => p.active !== true && syntheticProducts.has(p.id)).length)],
    ['INACTIVE_SYNTHETIC_VARIANTS', String(variants.filter((v) => v.active !== true && synthetic.has(v.id)).length)],
    ['REAL_INITIAL_STOCK_UNITS', String(realInitial)], ['SYNTHETIC_INITIAL_STOCK_UNITS', String(syntheticInitial)], ['INITIAL_STOCK_UNMAPPED_MOVEMENTS', String(unmapped)]);

  // ---- the canonical company's CompanyPricingConfig (pricing.service: the earliest Company; required: exactly one, PCEN's) ----
  if (companies.length !== 1 || companies[0].id !== pcen.company_id) flags.push('PRICING_COMPANY_AMBIGUOUS');
  const configs = pricing.filter((c) => c.company_id === pcen.company_id);
  const config = configs.length === 1 ? configs[0] : null;
  const fields = [['LIST', 'list_bps'], ['CREDIT_CARD', 'credit_bps'], ['DEBIT_CARD', 'debit_bps'], ['BANK_TRANSFER', 'transfer_bps'], ['QR', 'qr_bps']];
  const bps = (v) => (Number.isInteger(v) && v >= 0 && v <= 10000 ? String(v) : `INVALID(${digest12(v)})`);
  if (!config) flags.push('PRICING_CONFIG_MISSING');
  for (const [mode, col] of fields) {
    keys.push([`${mode}_ADJUSTMENT_BPS`, config ? bps(config[col]) : 'NONE']);
    if (config && Object.hasOwn(LOCAL1_PRICING, mode) && config[col] !== LOCAL1_PRICING[mode]) flags.push(`PRICING_MISMATCH:${mode}`);
  }
  const pricingOk = config !== null && !flags.some((f) => f.startsWith('PRICING_'));
  keys.splice(keys.length - fields.length, 0, ['PRICING_CONFIG_EXISTS', yn(config !== null)]);
  keys.push(['PRICING_CONFIG_MATCHES_LOCAL1', yn(pricingOk)]);
  return { keys, details, flags: [...new Set(flags)].sort() };
}

// One-way identity of a sale (domain-separated SHA-256 of its id): what the OWNER passes to
// pilot-local1-synthetic-retire.mjs --expect-sale, so the write is bound to exactly this sale.
export const saleIdentityDigest = (id) => sha256(`mona-pilot-synthetic-sale\n${id}`);

// One sale: the sale of the synthetic ACTIVE reservation that already holds a SalePayment (the case the
// canonical cancel and the expiry release both refuse). Mirrors payments.service.ts (fixed-total path:
// a payment may be partial; the sale turns PAID exactly when the payments reach the total) and
// sale-finalization.ts (PAID → COMPLETED consumes the ACTIVE holds, even expired ones).
function paidPendingEvidence({ mine, saleById, payments, items, reservations, cashMovements, cashSessions, cashRegisters, saleCheckouts, flags }) {
  const pcenRegisters = new Set(cashRegisters.filter((r) => r.branch_id === PCEN_LOCATION_ID).map((r) => r.id));
  const openSessions = cashSessions.filter((x) => x.status === 'OPEN' && pcenRegisters.has(x.register_id)).length;
  const paidSales = [...new Set(mine.map((r) => r.sale_id))].filter((id) => payments.some((p) => p.sale_id === id));
  const none = (classification) => [['PAID_PENDING_SALES', String(paidSales.length)], ['SALE_RECOVERY_CLASSIFICATION', classification], ['SALE_IDENTITY_DIGEST', 'NONE'],
    ...['SALE_PRICING_MODEL', 'SALE_PRICE_MODE', 'SALE_PRICING_TIER', 'SALE_STATUS', 'SALE_TOTAL_CENTS', 'SALE_ITEMS_TOTAL_CENTS', 'SALE_ITEMS_CONSISTENT',
      'ACCEPTED_PAYMENT_TOTAL_CENTS', 'PAYMENT_COUNT', 'PAYMENT_METHODS', 'REMAINING_CENTS', 'PAYMENT_COVERS_TOTAL', 'CASH_MOVEMENT_ALREADY_EXISTS',
      'RESERVATION_ACTIVE', 'RESERVATION_UNITS', 'HOLDS_MATCH_ITEMS', 'SALE_CHECKOUT_PRESENT', 'COMPLETION_METHODS_ALLOWED'].map((k) => [k, 'NONE']),
    ['PCEN_OPEN_CASH_SESSIONS', String(openSessions)]];
  if (paidSales.length === 0) return none('NOT_APPLICABLE');
  if (paidSales.length > 1) return none('UNKNOWN');
  const saleId = paidSales[0];
  const sale = saleById.get(saleId);
  if (!sale) return none('UNKNOWN');
  const allow = (set, v) => (set.has(v) ? v : `INVALID(${digest12(v)})`);
  const total = big(sale.total); const subtotal = big(sale.subtotal); const discount = big(sale.discount_total);
  const lines = items.filter((i) => i.sale_id === saleId);
  let itemsOk = total !== null && subtotal !== null && discount !== null && lines.length > 0;
  let itemsTotal = 0n;
  const wanted = new Map();
  for (const i of lines) {
    const q = big(i.quantity); const u = big(i.unit_price); const t = big(i.subtotal);
    if (q === null || u === null || t === null || q <= 0n || t !== u * q) { itemsOk = false; continue; }
    itemsTotal += t;
    wanted.set(i.variant_id, (wanted.get(i.variant_id) ?? 0n) + q);
  }
  if (itemsOk && (itemsTotal !== subtotal || subtotal - discount !== total)) itemsOk = false;
  const held = new Map();
  let holdUnits = 0n;
  const holds = reservations.filter((r) => r.sale_id === saleId && r.status === 'ACTIVE');
  for (const r of holds) {
    const q = big(r.quantity) ?? 0n;
    holdUnits += q;
    if (r.branch_id === sale.branch_id) held.set(r.variant_id, (held.get(r.variant_id) ?? 0n) + q);
  }
  const holdsMatch = holds.length > 0 && holds.every((r) => r.branch_id === sale.branch_id) && wanted.size === held.size
    && [...wanted].every(([v, q]) => held.get(v) === q);
  const paysOf = payments.filter((p) => p.sale_id === saleId);
  let accepted = 0n;
  let amountsOk = true;
  for (const p of paysOf) { const a = big(p.amount); if (a === null || a <= 0n) amountsOk = false; else accepted += a; }
  const income = (p) => cashMovements.filter((m) => m.sale_payment_id === p.id);
  const cash = paysOf.filter((p) => p.method === 'CASH');
  const cashOk = cash.every((p) => p.has_session === true && income(p).length === 1 && income(p)[0].type === 'SALE_INCOME' && income(p)[0].amount === p.amount);
  const nonCashOk = paysOf.filter((p) => p.method !== 'CASH').every((p) => p.has_session === false && income(p).length === 0);
  const checkout = saleCheckouts.some((c) => c.sale_id === saleId);
  const methods = [...new Set(paysOf.map((p) => (Object.hasOwn(METHOD_PRICE_MODE, p.method) ? p.method : `INVALID(${digest12(p.method)})`)))].sort();
  const priceMode = sale.price_mode;
  const completion = priceMode === 'LIST' ? 'ANY'
    : Object.entries(METHOD_PRICE_MODE).filter(([, mode]) => mode === priceMode).map(([m]) => m).join(',') || 'NONE';
  if (sale.pricing_mode === 'WHOLESALE' && sale.wholesale_confirmed !== true) flags.push('WHOLESALE_CONFIRMATION_REQUIRED');
  const remaining = total !== null ? total - accepted : null;

  let classification;
  if (sale.pricing_model !== 'FIXED_TOTAL' || checkout || total === null) classification = 'UNKNOWN';
  else if (!cashOk || !nonCashOk) classification = 'PAYMENT_WITHOUT_EXPECTED_SIDE_EFFECT';
  else if (!itemsOk || !holdsMatch || !amountsOk || accepted > total || (sale.status === 'PENDING_PAYMENT' && accepted === total)) classification = 'OVERPAID_OR_INCONSISTENT';
  else if (sale.status === 'PAID' && accepted === total) classification = 'SAFE_TO_COMPLETE_CANONICALLY';
  else if (sale.status === 'PENDING_PAYMENT' && accepted < total) classification = 'PARTIALLY_PAID';
  else classification = 'UNKNOWN';

  return [['PAID_PENDING_SALES', '1'], ['SALE_RECOVERY_CLASSIFICATION', classification], ['SALE_IDENTITY_DIGEST', saleIdentityDigest(saleId)],
    ['SALE_PRICING_MODEL', allow(PRICING_MODELS, sale.pricing_model)], ['SALE_PRICE_MODE', allow(new Set(['CASH', ...Object.values(METHOD_PRICE_MODE), 'LIST']), priceMode)],
    ['SALE_PRICING_TIER', allow(PRICING_TIERS, sale.pricing_mode)], ['SALE_STATUS', allow(SALE_STATUSES, sale.status)],
    ['SALE_TOTAL_CENTS', total === null ? 'INVALID' : String(total)], ['SALE_ITEMS_TOTAL_CENTS', String(itemsTotal)], ['SALE_ITEMS_CONSISTENT', yn(itemsOk)],
    ['ACCEPTED_PAYMENT_TOTAL_CENTS', String(accepted)], ['PAYMENT_COUNT', String(paysOf.length)], ['PAYMENT_METHODS', methods.join(',') || 'NONE'],
    ['REMAINING_CENTS', remaining === null ? 'INVALID' : String(remaining)], ['PAYMENT_COVERS_TOTAL', yn(total !== null && accepted === total)],
    ['CASH_MOVEMENT_ALREADY_EXISTS', cash.length === 0 ? 'NOT_APPLICABLE' : yn(cashOk)],
    ['RESERVATION_ACTIVE', yn(holds.length > 0)], ['RESERVATION_UNITS', String(holdUnits)], ['HOLDS_MATCH_ITEMS', yn(holdsMatch)],
    ['SALE_CHECKOUT_PRESENT', yn(checkout)], ['COMPLETION_METHODS_ALLOWED', completion], ['PCEN_OPEN_CASH_SESSIONS', String(openSessions)]];
}

// Every DRAFT / PENDING_PAYMENT / PAID sale with at least one SaleItem on an exact synthetic variant (SKU + barcode
// pair, never a prefix). Read-only evidence: one block of keys per sale, ordered by the sale's one-way digest, so
// the output is deterministic and never carries an internal id. Mirrors the open-sale test of
// pilot-local1-synthetic-retire.mjs deactivate-catalog and the actions that exist today.
const OPEN_STATUSES = new Set(['DRAFT', 'PENDING_PAYMENT', 'PAID']);
function openSyntheticSalesEvidence({ synthetic, variants, products, sales, items, payments, reservations, attempts, cashMovements, cashSessions, saleCheckouts, flags }) {
  const productIds = new Set(variants.filter((v) => synthetic.has(v.id)).map((v) => v.product_id));
  const out = [['SYNTHETIC_VARIANTS_FOUND', String(synthetic.size)], ['SYNTHETIC_PRODUCTS_FOUND', String(productIds.size)],
    ['SYNTHETIC_ACTIVE_VARIANTS', String(variants.filter((v) => synthetic.has(v.id) && v.active === true).length)],
    ['SYNTHETIC_ACTIVE_PRODUCTS', String(products.filter((p) => productIds.has(p.id) && p.active === true).length)]];
  const openIds = [...new Set(items.filter((i) => synthetic.has(i.variant_id)).map((i) => i.sale_id))];
  const blocks = [];
  for (const saleId of openIds) {
    const sale = sales.find((x) => x.id === saleId);
    if (!sale || !OPEN_STATUSES.has(sale.status)) continue;
    const lines = items.filter((i) => i.sale_id === saleId);
    const total = big(sale.total); const subtotal = big(sale.subtotal); const discount = big(sale.discount_total);
    let itemsOk = total !== null && subtotal !== null && discount !== null && lines.length > 0;
    let itemsTotal = 0n;
    const wanted = new Map();
    for (const i of lines) {
      const q = big(i.quantity); const u = big(i.unit_price); const t = big(i.subtotal);
      if (q === null || u === null || t === null || q <= 0n || t !== u * q) { itemsOk = false; continue; }
      itemsTotal += t;
      wanted.set(i.variant_id, (wanted.get(i.variant_id) ?? 0n) + q);
    }
    if (itemsOk && (itemsTotal !== subtotal || subtotal - discount !== total)) itemsOk = false;
    const syntheticLines = lines.filter((i) => synthetic.has(i.variant_id)).length;
    const holds = reservations.filter((r) => r.sale_id === saleId && r.status === 'ACTIVE');
    const held = new Map();
    let holdUnits = 0n;
    for (const r of holds) { const q = big(r.quantity) ?? 0n; holdUnits += q; held.set(r.variant_id, (held.get(r.variant_id) ?? 0n) + q); }
    const holdsMatch = holds.length > 0 && holds.every((r) => r.branch_id === sale.branch_id) && wanted.size === held.size && [...wanted].every(([v, q]) => held.get(v) === q);
    const reservationStatuses = [...new Set(reservations.filter((r) => r.sale_id === saleId).map((r) => (RESERVATION_STATUSES.has(r.status) ? r.status : `INVALID(${digest12(r.status)})`)))].sort();
    const paysOf = payments.filter((p) => p.sale_id === saleId);
    let accepted = 0n; let amountsOk = true;
    for (const p of paysOf) { const a = big(p.amount); if (a === null || a <= 0n) amountsOk = false; else accepted += a; }
    const income = (p) => cashMovements.filter((m) => m.sale_payment_id === p.id);
    const cashOk = paysOf.filter((p) => p.method === 'CASH').every((p) => p.has_session === true && income(p).length === 1 && income(p)[0].type === 'SALE_INCOME' && income(p)[0].amount === p.amount);
    const nonCashOk = paysOf.filter((p) => p.method !== 'CASH').every((p) => p.has_session === false && income(p).length === 0);
    const cashMoves = paysOf.reduce((n, p) => n + income(p).length, 0);
    const openSessionIds = new Set(cashSessions.filter((x) => x.status === 'OPEN').map((x) => x.id));
    const sessionRelated = paysOf.some((p) => p.session_id != null && openSessionIds.has(p.session_id));
    const saleAttempts = attempts.filter((a) => a.sale_id === saleId);
    const attemptStatuses = [...new Set(saleAttempts.map((a) => (ATTEMPT_STATUSES.has(a.status) ? a.status : `INVALID(${digest12(a.status)})`)))].sort();
    const checkout = saleCheckouts.some((c) => c.sale_id === saleId);
    const remaining = total !== null ? total - accepted : null;
    const sideEffectsOk = cashOk && nonCashOk && amountsOk;
    const fixed = sale.pricing_model === 'FIXED_TOTAL';

    let classification;
    if (sale.pricing_model === 'PROPORTIONAL_V1' || checkout || saleAttempts.length > 0) classification = 'PROPORTIONAL_ACTIVE';
    else if (!fixed || total === null || !itemsOk) classification = sale.status === 'PAID' ? 'PAID_INCONSISTENT' : 'OTHER_INCONSISTENT';
    else if (sale.status === 'DRAFT') classification = paysOf.length === 0 && holds.length === 0 ? 'DRAFT_NO_PAYMENT' : 'OTHER_INCONSISTENT';
    else if (sale.status === 'PAID') classification = sideEffectsOk && accepted === total && holdsMatch ? 'PAID_READY_TO_COMPLETE' : 'PAID_INCONSISTENT';
    else if (paysOf.length === 0) classification = holdsMatch ? 'PENDING_NO_PAYMENT' : 'OTHER_INCONSISTENT';
    else classification = sideEffectsOk && accepted < total && holdsMatch ? 'PARTIALLY_PAID' : 'OTHER_INCONSISTENT';

    // Only actions that exist in the current code: the canonical cancel / completion (API services) and the
    // exceptional synthetic retirement, which also requires every item synthetic and holds matching the items.
    const allSynthetic = syntheticLines === lines.length;
    let action;
    if (classification === 'DRAFT_NO_PAYMENT' || classification === 'PENDING_NO_PAYMENT') action = 'CANCEL_CANONICAL';
    else if (classification === 'PARTIALLY_PAID') action = allSynthetic && sale.branch_id === PCEN_LOCATION_ID ? 'SYNTHETIC_RETIREMENT_EXCEPTION' : 'NEEDS_NEW_REVIEWED_OPERATION';
    else if (classification === 'PAID_READY_TO_COMPLETE') action = 'COMPLETE_CANONICAL';
    else action = 'NEEDS_NEW_REVIEWED_OPERATION';
    if (sale.pricing_mode === 'WHOLESALE' && sale.wholesale_confirmed !== true) flags.push('WHOLESALE_CONFIRMATION_REQUIRED');

    blocks.push({ digest: saleIdentityDigest(saleId), rows: [
      ['SALE_IDENTITY_DIGEST', saleIdentityDigest(saleId)], ['STATUS', sale.status],
      ['PRICING_MODEL', PRICING_MODELS.has(sale.pricing_model) ? sale.pricing_model : `INVALID(${digest12(sale.pricing_model)})`],
      ['PRICE_MODE', new Set(['CASH', ...Object.values(METHOD_PRICE_MODE), 'LIST']).has(sale.price_mode) ? sale.price_mode : `INVALID(${digest12(sale.price_mode)})`],
      ['ITEM_COUNT', String(lines.length)], ['SYNTHETIC_ITEM_COUNT', String(syntheticLines)], ['TOTAL_CENTS', total === null ? 'INVALID' : String(total)],
      ['PAYMENT_COUNT', String(paysOf.length)], ['ACCEPTED_PAYMENT_TOTAL_CENTS', String(accepted)], ['REMAINING_CENTS', remaining === null ? 'INVALID' : String(remaining)],
      ['ACTIVE_RESERVATION_UNITS', String(holdUnits)], ['RESERVATION_STATUS', reservationStatuses.join(',') || 'NONE'], ['CHECKOUT_PRESENT', yn(checkout)],
      ['CHECKOUT_ATTEMPT_STATUS', attemptStatuses.join(',') || 'NONE'], ['CASH_MOVEMENT_COUNT', String(cashMoves)], ['OPEN_CASH_SESSION_RELATED', yn(sessionRelated)],
      ['CLASSIFICATION', classification], ['CANONICAL_ACTION', action],
    ] });
  }
  blocks.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
  out.push(['OPEN_SYNTHETIC_SALES', String(blocks.length)]);
  blocks.forEach((b, n) => { for (const [k, v] of b.rows) out.push([`OPEN_SALE_${n + 1}_${k}`, v]); });
  return out;
}

// client.end() can stall on a dead socket: bounded, and the socket is destroyed on timeout.
async function endBounded(client, ms, destroy) {
  let timer;
  let timedOut = false;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; resolve(); }, ms); timer.unref?.(); });
  try {
    await Promise.race([Promise.resolve().then(() => client.end()).catch(() => {}), timeout]);
  } finally {
    clearTimeout(timer);
    if (timedOut) destroy();
  }
}

// Only run when executed directly; importing (tests) never connects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
