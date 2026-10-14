// OWNER-only, PILOT-only, READ-ONLY identity and state report (A4).
//
//   env -i HOME=<passwd home> PATH=/usr/bin:/bin LANG=C.UTF-8 \
//     <absolute node v24.20.0> scripts/database/pilot-a4-readonly.mjs --target=pilot --read-only-state
//
// Before any database client exists, in this order: exact arguments; Node v24.20.0
// with no runtime options; an environment of exactly HOME/PATH/LANG (pg reads PG*
// variables and NODE_PG_FORCE_NATIVE itself, and NODE_OPTIONS would run code before
// this file); the manifest (SHA-256 of pilot-marker.mjs, lib.mjs, the CA, the seven
// migrations and every file of the pinned pg dependency closure, bound to the
// versions/integrities in package-lock.json); the private files under the passwd
// home and their parent directories; and the target: a supported Supabase host shape
// whose project ref digest equals the pinned PILOT digest and is not a forbidden one.
// Only static imports are node:* builtins; pilot-marker.mjs (and through it lib.mjs
// and pg) is imported only after the manifest verified.
//
// SHA-256 here only detects that bytes differ from the reviewed ones; it does not
// authenticate the operator and does not identify a database. Database identity is
// the in-snapshot proof below; project refs are never stored in clear (public repo).
//
// One connection, one REPEATABLE READ READ ONLY transaction, statements only from the
// frozen STATEMENTS map: read-only check, TEST guard absent, marker LOCK (ACCESS
// SHARE), full canonical marker STRUCTURE, then the marker ROW, then relation safety
// checks (heap access method, no inheritance, built-in index AMs/opclasses) and the
// catalog-only column contract (type, collation, built-in output function), then the
// ledger/schema/count reads. Index paths and JIT are disabled; table reads are plain
// `FROM ONLY` column projections with no ordering, grouping, filtering or comparison in
// the database (done in JavaScript), each bounded by its count. Then ROLLBACK. Private files: lstat, non-blocking no-follow open, same dev/ino, mode
// exactly 0600, owner, size. A4_RESULT=VERIFIED is
// printed only after a confirmed ROLLBACK. Output never contains a URL, host, user,
// password, project ref or marker id; database strings are allowlisted or digested.

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PREFIX = '[db:pilot-a4]';
export const EXPECTED_NODE = 'v24.20.0';
export const EXPECTED_ENV = Object.freeze({ PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' });
const MANIFEST_REL = 'scripts/database/pilot-a4-readonly.manifest.json';
const MANIFEST_FORMAT = 'mona-pilot-a4-manifest/v1';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const MAX_PRIVATE_BYTES = 4096;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Domain-separated SHA-256 of the project refs (OWNER-declared, 2026-10-14). The refs
// themselves are not stored: the repository is public (Blueprint §0.5).
const REF_DOMAIN = 'mona-pilot-project-ref\n';
const REF_DIGESTS = Object.freeze({
  pilot: 'cae01c80a53cf8cf392f309a7f7e0bc402da862c93dedf7347e608075d402c64',
  forbidden: Object.freeze([
    '192f53743dd344fe51a2839109650387c7b12140efeef8aa714d23c3d35776a1', // LOCAL1
    '0ecc4e2617f88b2baafbd1ef659711f7330c99d09e9292dc245ca09702d85d5f', // TEST
    'afeac2094ae5b5ca1b1f695cd864a9abc707b64ba99c81bc0464d8509d94d0af', // PRODUCTION
  ]),
});

export const PACKAGE_CLOSURE = Object.freeze(['pg', 'pg-connection-string', 'pg-pool', 'pg-protocol', 'pg-types', 'pgpass',
  'split2', 'pg-int8', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'pg-cloudflare', 'xtend']);
export const MIGRATIONS = Object.freeze([
  '20260907015311_init', '20260912182432_add_company_location', '20260912191702_add_user_role_scope',
  '20260922210000_d3_initial_stock_and_global_audit', '20261002120000_block1_pricing_wholesale',
  '20261006120000_pilot_pricing_v2', '20261012120000_cash_session_reconciliation',
]);
const REQUIRED_REPO_FILES = Object.freeze(['scripts/database/pilot-marker.mjs', 'scripts/database/lib.mjs',
  'scripts/certs/supabase-prod-ca-2021.crt', ...MIGRATIONS.map((m) => `api/prisma/migrations/${m}/migration.sql`)]);
export const OPERATIONAL_TABLES = Object.freeze(['Company', 'CompanyPricingConfig', 'Location', 'Branch', 'User', 'Role',
  'Permission', 'RolePermission', 'UserRoleScope', 'UserBranchRole', 'CashRegister', 'SaleNumberCounter', 'Category', 'Brand',
  'Product', 'ProductVariant', 'Inventory', 'StockMovement', 'StockReservation', 'Sale', 'SaleItem', 'SalePayment',
  'CashSession', 'CashMovement', 'AuditLog']);
const LEDGER_TABLE = '_prisma_migrations';
// Columns that exist only once the schema of each pending migration is really present.
const PROBES = Object.freeze({
  '20261002120000_block1_pricing_wholesale': [['Sale', 'pricingMode'], ['Sale', 'paymentStartedAt'], ['Sale', 'wholesaleConfirmedById'], ['ProductVariant', 'wholesalePrice']],
  '20261006120000_pilot_pricing_v2': [['ProductVariant', 'cashPrice'], ['Sale', 'priceMode'], ['SaleItem', 'priceMode'], ['SaleItem', 'baseUnitPrice'], ['CompanyPricingConfig', 'listAdjustmentBps']],
  '20261012120000_cash_session_reconciliation': [['CashSession', 'expectedCash'], ['CashSession', 'countedCash'], ['CashSession', 'difference']],
});
// Column type contract for every value-bearing read: [column, type schema, typtype, allowed type names].
// Only built-in pg_catalog base types or the schema's own public enums (built-in enum I/O);
// a domain, composite, range, array, user base type or misplaced enum fails closed.
const TYPE_CONTRACT = Object.freeze({
  [LEDGER_TABLE]: [['migration_name', 'pg_catalog', 'b', ['varchar', 'text']], ['checksum', 'pg_catalog', 'b', ['varchar', 'text']],
    ['finished_at', 'pg_catalog', 'b', ['timestamptz']], ['rolled_back_at', 'pg_catalog', 'b', ['timestamptz']],
    ['started_at', 'pg_catalog', 'b', ['timestamptz']], ['applied_steps_count', 'pg_catalog', 'b', ['int4']]],
  Location: [['code', 'pg_catalog', 'b', ['text', 'varchar']], ['type', 'public', 'e', ['LocationType']], ['isActive', 'pg_catalog', 'b', ['bool']]],
  Company: [['cuit', 'pg_catalog', 'b', ['text', 'varchar']]],
  Sale: [['status', 'public', 'e', ['SaleStatus']]],
  CashSession: [['status', 'public', 'e', ['CashSessionStatus']]],
  User: [['isActive', 'pg_catalog', 'b', ['bool']]],
});
const COLLATABLE_TYPES = new Set(['varchar', 'text']);
const LOCATION_TYPES = new Set(['RETAIL_BRANCH', 'CENTRAL_WAREHOUSE']);
const SALE_STATUSES = new Set(['DRAFT', 'PENDING_PAYMENT', 'PAID', 'COMPLETED', 'CANCELLED']);
const CASH_STATUSES = new Set(['OPEN', 'CLOSED']);
const COUNT = /^(0|[1-9][0-9]{0,18})$/;
const LOCATION_CODE = /^[A-Z][A-Z0-9]{1,9}$/;
const POOLER_HOST = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const DIRECT_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/;
const POOLER_USER = /^postgres\.([a-z0-9]{20})$/;

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
for (const t of [...OPERATIONAL_TABLES, LEDGER_TABLE]) if (!IDENT.test(t)) throw new Error('invalid table constant');
const quoteList = (names) => names.map((n) => `'${n}'`).join(', ');
const PUBLIC_NS = "(SELECT n.oid FROM pg_namespace n WHERE n.nspname = 'public')";
// Objects created by initdb have OIDs below FirstNormalObjectId (16384): "built-in".
const HEAP_AM = (relam) => `(${relam} = (SELECT am.oid FROM pg_am am WHERE am.amname = 'heap') AND ${relam} < 16384::oid)`;
const BUILTIN_INDEXES = (rel) => `NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class ic ON ic.oid = i.indexrelid JOIN pg_am am ON am.oid = ic.relam WHERE i.indrelid = ${rel} AND (am.oid >= 16384::oid OR am.amhandler::oid >= 16384::oid OR EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) AS oc(o) WHERE oc.o >= 16384::oid)))`;
// Hard cap on rows fetched by a value read (taken from the count in the same snapshot).
const ROW_READ_CAP = 100000n;
// The Prisma ledger holds one row per apply attempt; a real history is a few dozen rows.
const LEDGER_ROW_CAP = 1000n;

// The only SQL this tool can send. Constant text, one statement each, no parameters.
export const STATEMENTS = Object.freeze({
  BEGIN: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  SET_SEARCH_PATH: 'SET LOCAL search_path TO pg_catalog, pg_temp',
  SET_LOCK_TIMEOUT: "SET LOCAL lock_timeout = '5s'",
  SET_STATEMENT_TIMEOUT: "SET LOCAL statement_timeout = '15s'",
  // No index access path (and no JIT) for any read: heap sequential scans only.
  SET_NO_INDEXSCAN: 'SET LOCAL enable_indexscan = off',
  SET_NO_INDEXONLYSCAN: 'SET LOCAL enable_indexonlyscan = off',
  SET_NO_BITMAPSCAN: 'SET LOCAL enable_bitmapscan = off',
  SET_NO_JIT: 'SET LOCAL jit = off',
  READ_ONLY: "SELECT current_setting('transaction_read_only') AS ro",
  GUARDS: "SELECT to_regnamespace('mona_test_guard') IS NOT NULL AS test_guard, to_regnamespace('mona_pilot_guard') IS NOT NULL AS pilot_schema, to_regclass('mona_pilot_guard.database_identity') IS NOT NULL AS pilot_table",
  LOCK_MARKER: 'LOCK TABLE mona_pilot_guard.database_identity IN ACCESS SHARE MODE',
  // Same catalog facts as pilot-marker.mjs (verified by its verifyMarkerStructure).
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
  RELATIONS: `SELECT v.name, c.relkind::text AS kind, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls, c.relhasrules AS rules, c.relowner = (SELECT r.oid FROM pg_roles r WHERE r.rolname = current_user) AS owned, ${HEAP_AM('c.relam')} AS heap_am, ${BUILTIN_INDEXES('c.oid')} AS indexes_builtin, c.relhassubclass AS has_subclass, c.relispartition AS is_partition FROM unnest(ARRAY[${quoteList([...OPERATIONAL_TABLES, LEDGER_TABLE])}]::text[]) AS v(name) LEFT JOIN pg_class c ON c.relname = v.name AND c.relnamespace = ${PUBLIC_NS}`,
  COLUMN_TYPES: `SELECT v.t AS table_name, v.c AS column_name, tn.nspname AS type_schema, ty.typname AS type_name, ty.typtype::text AS type_kind, cn.nspname AS coll_schema, co.collname AS coll_name, ty.typoutput::oid < 16384::oid AS out_builtin FROM (VALUES ${Object.entries(TYPE_CONTRACT).flatMap(([t, cols]) => cols.map(([c]) => `('${t}', '${c}')`)).join(', ')}) AS v(t, c) LEFT JOIN pg_class c ON c.relname = v.t AND c.relnamespace = ${PUBLIC_NS} LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = v.c AND a.attnum > 0 AND NOT a.attisdropped LEFT JOIN pg_type ty ON ty.oid = a.atttypid LEFT JOIN pg_namespace tn ON tn.oid = ty.typnamespace LEFT JOIN pg_collation co ON co.oid = a.attcollation LEFT JOIN pg_namespace cn ON cn.oid = co.collnamespace`,
  COUNT_LEDGER: 'SELECT count(*)::text AS n FROM ONLY public._prisma_migrations',
  LEDGER: 'SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back, applied_steps_count FROM ONLY public._prisma_migrations',
  COLUMNS: `SELECT v.t AS table_name, v.c AS column_name, EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = ${PUBLIC_NS} AND c.relname = v.t AND a.attname = v.c AND a.attnum > 0 AND NOT a.attisdropped) AS present FROM (VALUES ${Object.values(PROBES).flat().map(([t, c]) => `('${t}', '${c}')`).join(', ')}) AS v(t, c)`,
  TRIGGERS: `SELECT count(*)::text AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND c.relnamespace = ${PUBLIC_NS} AND c.relname IN ('Sale', 'SalePayment')`,
  ...Object.fromEntries(OPERATIONAL_TABLES.map((t) => [`COUNT_${t}`, `SELECT count(*)::text AS n FROM ONLY public."${t}"`])),
  // Plain column projections: no ordering, grouping, filtering or comparison in the database
  // (done in JavaScript), so no collation, operator class or index support function is used.
  LOCATIONS: 'SELECT code, type, "isActive" AS active FROM ONLY public."Location"',
  COMPANY_CUITS: 'SELECT cuit FROM ONLY public."Company"',
  SALE_STATUSES: 'SELECT status FROM ONLY public."Sale"',
  CASH_STATUSES: 'SELECT status FROM ONLY public."CashSession"',
  USER_ACTIVE: 'SELECT "isActive" AS active FROM ONLY public."User"',
  ROLLBACK: 'ROLLBACK',
});

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const digest12 = (value) => sha256(String(value)).slice(0, 12);
// Removes every C0/C1 control character so database text can never drive the terminal.
const clean = (value) => String(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, '');

// The OWNER launch command (a review artifact: this tool never runs it).
// TRUST ROOT, stated plainly: the root-owned system binaries /usr/bin/env, /bin/sh (dash)
// and /usr/bin/stat are trusted a priori (Debian packages coreutils and dash; their bytes
// are checked out-of-band with `dpkg --verify` in the evidence, not by this command).
// `stat` does not verify itself: it only checks that each listed utility is owned by uid 0
// and not group/other-writable before that utility runs. Utility paths and the uid are
// fixed constants, not parameters. Everything runs under `env -i` with absolute paths (no
// PATH lookup; ENV/BASH_ENV are cleared). The digests bind the launch to the reviewed
// tool, manifest and Node bytes; this does not authenticate the operator.
export const TRUSTED_UTILS = Object.freeze({
  env: '/usr/bin/env', sh: '/bin/sh', sha256sum: '/usr/bin/sha256sum', getent: '/usr/bin/getent',
  id: '/usr/bin/id', cut: '/usr/bin/cut', stat: '/usr/bin/stat',
});
const TRUSTED_OWNER_UID = 0;
const SAFE_ABSOLUTE = /^\/[^'"$`\\\n\r\0]*$/;
const HEX64 = /^[0-9a-f]{64}$/;
const BUILDER_KEYS = Object.freeze(['manifestSha256', 'nodePath', 'nodeSha256', 'repoDir', 'toolSha256']);
export function buildOwnerCommand(spec) {
  if (spec === null || typeof spec !== 'object' || Object.keys(spec).sort().join(',') !== BUILDER_KEYS.join(',')) {
    throw new Error('exactly repoDir, nodePath, toolSha256, manifestSha256 and nodeSha256 are accepted');
  }
  const { repoDir, nodePath, toolSha256, manifestSha256, nodeSha256 } = spec;
  for (const value of [repoDir, nodePath]) {
    if (typeof value !== 'string' || !SAFE_ABSOLUTE.test(value)) throw new Error('unsafe or relative path');
  }
  for (const digest of [toolSha256, manifestSha256, nodeSha256]) {
    if (typeof digest !== 'string' || !HEX64.test(digest)) throw new Error('digests must be 64 lowercase hex characters');
  }
  const u = TRUSTED_UTILS;
  const q = (v) => `"${v}"`;
  const script = [
    'set -eu',
    `for u in ${Object.values(u).map(q).join(' ')}; do`,
    `  s=$(${q(u.stat)} -L -c %u:%a "$u") || exit 70`,
    `  case "$s" in ${TRUSTED_OWNER_UID}:[0-7][0145][0145]) ;; *) echo "A4_LAUNCH=REFUSED untrusted utility" >&2; exit 71 ;; esac`,
    'done',
    `cd ${q(repoDir)} || exit 72`,
    `printf "%s  %s\\n" ${toolSha256} scripts/database/pilot-a4-readonly.mjs ${manifestSha256} scripts/database/pilot-a4-readonly.manifest.json ${nodeSha256} ${q(nodePath)} | ${q(u.sha256sum)} --check --strict || exit 73`,
    `H=$(${q(u.getent)} passwd "$(${q(u.id)} -un)" | ${q(u.cut)} -d: -f6)`,
    '[ -n "$H" ] || exit 74',
    `exec ${q(u.env)} -i HOME="$H" PATH=/usr/bin:/bin LANG=C.UTF-8 ${q(nodePath)} scripts/database/pilot-a4-readonly.mjs --target=pilot --read-only-state`,
  ].join('\n');
  return `${q(u.env)} -i ${q(u.sh)} -c '${script}'`;
}

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 2) return { ok: false };
  const set = new Set(argv);
  return { ok: set.size === 2 && set.has('--target=pilot') && set.has('--read-only-state') };
}

export function checkEnvironment({ env, homedir, execArgv, version }) {
  if (version !== EXPECTED_NODE) return { ok: false, phase: 'runtime', reason: `Node runtime must be ${EXPECTED_NODE}` };
  if (!Array.isArray(execArgv) || execArgv.length !== 0) return { ok: false, phase: 'runtime', reason: 'node must be started without runtime options' };
  const keys = Object.keys(env ?? {}).sort();
  if (keys.join(',') !== 'HOME,LANG,PATH') return { ok: false, phase: 'env', reason: 'environment must contain exactly HOME, PATH and LANG (launch with env -i)' };
  if (env.PATH !== EXPECTED_ENV.PATH || env.LANG !== EXPECTED_ENV.LANG) return { ok: false, phase: 'env', reason: 'PATH/LANG differ from the pinned values' };
  if (typeof homedir !== 'string' || env.HOME !== homedir) return { ok: false, phase: 'env', reason: 'HOME is not the passwd home directory' };
  return { ok: true };
}

function safeRelative(rel) {
  return typeof rel === 'string' && rel.length > 0 && !rel.startsWith('/') && !rel.includes('\\') && !rel.includes('\0')
    && path.posix.normalize(rel) === rel && !rel.split('/').includes('..') && !rel.split('/').includes('.');
}

function readRegular(fs, file, maxBytes) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink()) return null;
  if (st.size > maxBytes) return null;
  return fs.readFileSync(file);
}

// Verifies the manifest and every byte it pins, before any non-builtin module loads.
export function verifyIntegrity({ root, fs = nodeFs, resolvePg }) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    const manifestBytes = readRegular(fs, path.join(root, MANIFEST_REL), MAX_MANIFEST_BYTES);
    if (!manifestBytes) return fail('manifest is not a bounded regular file');
    const m = JSON.parse(manifestBytes.toString('utf8'));
    if (m?.format !== MANIFEST_FORMAT || m?.node !== EXPECTED_NODE) return fail('manifest format or Node version mismatch');
    if (!Array.isArray(m.repoFiles) || !Array.isArray(m.packages)) return fail('manifest structure invalid');

    const repoPaths = m.repoFiles.map((f) => f?.path);
    if (repoPaths.length !== REQUIRED_REPO_FILES.length || [...repoPaths].sort().join('\n') !== [...REQUIRED_REPO_FILES].sort().join('\n')) {
      return fail('manifest repository file set differs from the required set');
    }
    let files = 0;
    const repoSha = new Map();
    for (const f of m.repoFiles) {
      if (!safeRelative(f.path) || !/^[0-9a-f]{64}$/.test(f.sha256 ?? '')) return fail('manifest repository entry invalid');
      const bytes = readRegular(fs, path.join(root, f.path), 64 * 1024 * 1024);
      if (!bytes || sha256(bytes) !== f.sha256) return fail('a pinned repository file differs from the manifest');
      repoSha.set(f.path, f.sha256);
      files += 1;
    }

    const lockBytes = readRegular(fs, path.join(root, 'package-lock.json'), MAX_LOCK_BYTES);
    if (!lockBytes) return fail('package-lock.json is not a bounded regular file');
    const lock = JSON.parse(lockBytes.toString('utf8'))?.packages ?? {};

    const names = m.packages.map((p) => p?.name);
    if (names.length !== PACKAGE_CLOSURE.length || [...names].sort().join(',') !== [...PACKAGE_CLOSURE].sort().join(',')) {
      return fail('manifest package set differs from the pinned dependency closure');
    }
    for (const p of m.packages) {
      const entry = lock[`node_modules/${p.name}`];
      if (!entry || entry.version !== p.version || entry.integrity !== p.integrity) return fail('package-lock.json entry differs from the manifest');
      const dir = path.join(root, 'node_modules', p.name);
      const dst = fs.lstatSync(dir);
      if (!dst.isDirectory() || dst.isSymbolicLink()) return fail('a pinned package directory is not a real directory');
      const found = [];
      const walk = (abs, rel) => {
        for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
          const childRel = `${rel}/${d.name}`;
          if (d.isSymbolicLink()) throw new Error('symlink');
          if (d.isDirectory()) walk(path.join(abs, d.name), childRel);
          else if (d.isFile()) { if (d.name.endsWith('.node')) throw new Error('native'); found.push(childRel); }
          else throw new Error('special');
        }
      };
      try { walk(dir, `node_modules/${p.name}`); } catch { return fail('a pinned package contains a symlink, native addon or special file'); }
      const listed = (p.files ?? []).map((f) => f?.path);
      if (listed.some((rel) => !safeRelative(rel) || !rel.startsWith(`node_modules/${p.name}/`))) return fail('manifest package entry invalid');
      if ([...found].sort().join('\n') !== [...listed].sort().join('\n')) return fail('a pinned package has unlisted or missing files');
      for (const f of p.files) {
        const bytes = readRegular(fs, path.join(root, f.path), 64 * 1024 * 1024);
        if (!bytes || !/^[0-9a-f]{64}$/.test(f.sha256 ?? '') || sha256(bytes) !== f.sha256) return fail('a pinned package file differs from the manifest');
        files += 1;
      }
    }
    if (resolvePg() !== path.join(root, 'node_modules', 'pg', 'esm', 'index.mjs')) return fail('pg does not resolve to the pinned copy');
    return { ok: true, files, packages: m.packages.length, repoSha };
  } catch {
    return fail('manifest verification failed');
  }
}

// lstat first (no open of a FIFO/socket/device/symlink), then a non-blocking, no-follow
// open, then the descriptor must be the SAME regular file (dev/ino), mode exactly 0600,
// owned by the user, bounded; the bytes read must equal its size.
function readPrivate(fs, uid, file, maxBytes) {
  let pre;
  try { pre = fs.lstatSync(file); } catch (err) {
    return { ok: false, reason: err?.code === 'ENOENT' ? 'a private file is missing' : 'a private file could not be inspected' };
  }
  if (pre.isSymbolicLink()) return { ok: false, reason: 'a private file must not be a symlink' };
  if (!pre.isFile()) return { ok: false, reason: 'a private file is not a regular file' };
  let fd;
  try {
    const c = fs.constants;
    fd = fs.openSync(file, c.O_RDONLY | (c.O_NOFOLLOW ?? 0) | (c.O_NONBLOCK ?? 0) | (c.O_NOCTTY ?? 0));
  } catch (err) {
    return { ok: false, reason: err?.code === 'ELOOP' ? 'a private file must not be a symlink' : 'a private file could not be opened' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'a private file is not a regular file' };
    if (st.dev !== pre.dev || st.ino !== pre.ino) return { ok: false, reason: 'a private file changed between inspection and open' };
    if ((st.mode & 0o777) !== 0o600) return { ok: false, reason: 'a private file must have mode exactly 0600' };
    if (st.uid !== uid) return { ok: false, reason: 'a private file is not owned by the current user' };
    if (st.size === 0 || st.size > maxBytes) return { ok: false, reason: 'a private file has an implausible size' };
    const bytes = fs.readFileSync(fd);
    if (bytes.length !== st.size) return { ok: false, reason: 'a private file changed while being read' };
    return { ok: true, text: bytes.toString('utf8') };
  } catch {
    return { ok: false, reason: 'a private file could not be read' };
  } finally {
    fs.closeSync(fd);
  }
}

function checkPrivateDir(fs, uid, dir, forbiddenBits) {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & forbiddenBits) === 0;
  } catch {
    return false;
  }
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

function defaultDeps() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  return {
    env: process.env, homedir: os.userInfo().homedir, uid: process.getuid(), execArgv: process.execArgv, version: process.version,
    root, fs: nodeFs,
    resolvePg: () => fileURLToPath(import.meta.resolve('pg')),
    importMarker: () => import(pathToFileURL(path.join(root, 'scripts', 'database', 'pilot-marker.mjs')).href),
    createClient: null, refDigests: REF_DIGESTS,
    log: (line) => console.log(line), error: (line) => console.error(line), endTimeoutMs: 5000,
  };
}

export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const refuse = (phase, reason, rc) => { deps.error(`${PREFIX} REFUSED: phase=${phase} — ${reason}`); deps.log('A4_RESULT=REFUSED'); return rc; };

  if (!parseArgs(argv).ok) return refuse('args', 'exactly --target=pilot --read-only-state is accepted (arguments not echoed)', 1);
  const envCheck = checkEnvironment(deps);
  if (!envCheck.ok) return refuse(envCheck.phase, envCheck.reason, 3);
  const integrity = verifyIntegrity(deps);
  if (!integrity.ok) return refuse('integrity', integrity.reason, 3);

  let marker;
  try { marker = await deps.importMarker(); } catch { return refuse('integrity', 'pilot-marker.mjs could not be loaded', 3); }

  const cfg = path.join(deps.homedir, '.config');
  const dir = path.join(cfg, 'mona-jacinta');
  if (!checkPrivateDir(deps.fs, deps.uid, cfg, 0o022) || !checkPrivateDir(deps.fs, deps.uid, dir, 0o077)) {
    return refuse('config', 'private configuration directories must be real, owned and not group/other accessible', 3);
  }
  const urlFile = readPrivate(deps.fs, deps.uid, path.join(dir, 'pilot-database-url'), MAX_PRIVATE_BYTES);
  if (!urlFile.ok) return refuse('config', urlFile.reason, 3);
  const idFile = readPrivate(deps.fs, deps.uid, path.join(dir, 'pilot-marker-id'), MAX_PRIVATE_BYTES);
  if (!idFile.ok) return refuse('config', idFile.reason, 3);
  const markerId = idFile.text.replace(/\n$/, '');
  if (!UUID_V4.test(markerId)) return refuse('config', 'pilot-marker-id must hold one canonical version-4 UUID (value not shown)', 3);
  const url = marker.parsePilotUrl(urlFile.text);
  if (!url.ok) return refuse('config', 'pilot-database-url must hold one PostgreSQL URL without query/fragment (value not shown)', 3);
  const { conn } = url;
  const target = checkTarget(conn, deps.refDigests, marker.deriveProjectRef);
  if (!target.ok) return refuse('target', target.reason, 3);

  return connectAndRead({ deps, marker, conn, markerId, ref: target.ref, repoSha: integrity.repoSha, refuse });
}

async function connectAndRead({ deps, marker, conn, markerId, ref, repoSha, refuse }) {
  const secrets = [conn.password, conn.host, conn.user, conn.database, String(conn.port), ref, markerId];
  const createClient = deps.createClient ?? marker.createVerifiedClient;
  let client;
  try { client = createClient(conn); } catch (err) { deps.error(`${PREFIX} ERROR: phase=connect code=${marker.safeCode(err, secrets)}`); deps.log('A4_RESULT=ERROR'); return 4; }

  let inTx = false;
  const run = async (id) => client.query(STATEMENTS[id]);
  const rollback = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try { await client.query(STATEMENTS.ROLLBACK); inTx = false; return true; } catch { /* retried, then reported */ }
    }
    return false;
  };
  const destroy = () => { try { client.connection?.stream?.destroy?.(); } catch { /* best effort */ } };
  const identityRefused = async (reason) => {
    const ok = await rollback();
    if (!ok) { deps.error(`${PREFIX} ERROR: phase=cleanup — ROLLBACK not confirmed`); deps.log('A4_RESULT=ERROR'); return 5; }
    deps.error(`${PREFIX} REFUSED: phase=identity — ${reason}; nothing was changed`);
    deps.log('A4_IDENTITY=REFUSED');
    deps.log('A4_RESULT=REFUSED');
    return 2;
  };

  try {
    try { await client.connect(); } catch (err) {
      deps.error(`${PREFIX} ERROR: phase=connect code=${marker.safeCode(err, secrets)}`); deps.log('A4_RESULT=ERROR'); return 4;
    }
    const stream = client.connection?.stream;
    if (stream?.encrypted !== true || stream?.authorized !== true) {
      deps.error(`${PREFIX} REFUSED: phase=connect — verified TLS is required`); deps.log('A4_RESULT=REFUSED'); return 4;
    }

    await run('BEGIN'); inTx = true;
    await run('SET_SEARCH_PATH'); await run('SET_LOCK_TIMEOUT'); await run('SET_STATEMENT_TIMEOUT');
    await run('SET_NO_INDEXSCAN'); await run('SET_NO_INDEXONLYSCAN'); await run('SET_NO_BITMAPSCAN'); await run('SET_NO_JIT');
    if ((await run('READ_ONLY')).rows?.[0]?.ro !== 'on') return identityRefused('transaction is not read-only');
    const g = (await run('GUARDS')).rows?.[0];
    if (!g || g.test_guard !== false) return identityRefused('a TEST marker schema exists or the guard check is unreadable; this is not PILOT');
    if (g.pilot_schema !== true || g.pilot_table !== true) return identityRefused('PILOT marker is absent or partial');
    try { await run('LOCK_MARKER'); } catch (err) {
      if (err?.code === '42P01' || err?.code === '3F000') return identityRefused('PILOT marker is not installed');
      throw err;
    }
    const facts = (await run('MARKER_FACTS')).rows?.[0]?.facts ?? null;
    const structure = marker.verifyMarkerStructure(facts);
    if (structure !== null) return identityRefused('marker structure is not canonical');
    const access = (await run('MARKER_ACCESS')).rows?.[0];
    if (access?.heap_am !== true || access?.indexes_builtin !== true) return identityRefused('marker table access method or indexes are not built-in');
    const rows = (await run('MARKER_ROWS')).rows ?? [];
    if (rows.length !== 1 || rows[0].environment !== 'pilot' || rows[0].has_installed_at !== true || rows[0].marker_id !== markerId) {
      return identityRefused('marker row is not exactly one pilot row with the expected id');
    }

    const report = await readState(run, repoSha);
    const closed = await rollback();
    if (!closed) { deps.error(`${PREFIX} ERROR: phase=cleanup — ROLLBACK not confirmed; results not trusted`); deps.log('A4_RESULT=ERROR'); return 5; }
    deps.log(`${PREFIX} identity: canonical PILOT marker structure and row verified in one READ ONLY snapshot; TEST guard absent; project ref digest matched the pinned PILOT digest (values not shown)`);
    for (const line of report.lines) deps.log(clean(line));
    deps.log(`  flags: ${report.flags.length ? report.flags.map(clean).join(', ') : 'none'}`);
    deps.log('A4_IDENTITY=VERIFIED');
    deps.log(`A4_STATE=${report.flags.length ? 'PARTIAL' : 'COMPLETE'}`);
    deps.log('A4_RESULT=VERIFIED');
    return 0;
  } catch (err) {
    const closed = inTx ? await rollback() : true;
    deps.error(`${PREFIX} ERROR: phase=read code=${marker.safeCode(err, secrets)} — nothing was changed`);
    deps.log('A4_RESULT=ERROR');
    return closed ? 4 : 5;
  } finally {
    if (inTx) await rollback();
    if (inTx) destroy();
    await endBounded(client, deps.endTimeoutMs, destroy);
  }
}

// Prisma keeps one _prisma_migrations row per apply attempt (finished_at set on success;
// rolled_back_at set by `migrate resolve --rolled-back`, only on failed attempts; a row with
// neither blocks deploy, P3009). Classification uses ALL rows of the migration and does not
// depend on their order. Anything Prisma cannot produce, or that cannot be justified, is
// AMBIGUOUS; only a single clean applied attempt (plus same-checksum rolled-back attempts)
// whose checksum equals the reviewed file is APPLIED.
function classifyMigration(rows, repoChecksum) {
  const wellFormed = rows.every((r) => typeof r.finished === 'boolean' && typeof r.rolled_back === 'boolean'
    && Number.isSafeInteger(r.applied_steps_count) && r.applied_steps_count >= 0 && typeof r.checksum === 'string');
  const applied = rows.filter((r) => r.finished === true && r.rolled_back === false);
  const failed = rows.filter((r) => r.finished === false && r.rolled_back === false);
  const rolledBack = rows.filter((r) => r.finished === false && r.rolled_back === true);
  const impossible = rows.filter((r) => r.finished === true && r.rolled_back === true);
  let status;
  if (!wellFormed || impossible.length > 0) status = 'AMBIGUOUS';
  else if (failed.length > 0) status = 'FAILED';
  else if (applied.length > 1) status = 'AMBIGUOUS';
  else if (applied.length === 0) status = 'ROLLED_BACK';
  else if (applied[0].checksum !== repoChecksum) status = 'DRIFT';
  else if (rolledBack.some((r) => r.checksum !== repoChecksum)) status = 'APPLIED_AFTER_CHANGED_RECOVERY';
  else status = 'APPLIED';
  return { status, applied: applied.length, failed: failed.length, rolledBack: rolledBack.length, allMatch: rows.every((r) => r.checksum === repoChecksum) };
}

async function readState(run, repoSha) {
  const lines = [];
  const flags = [];
  // Relation safety (catalog only): ordinary table, no RLS/rules, owned by the current role,
  // built-in heap access method, no inheritance/partitioning, only built-in index AMs/opclasses.
  const safe = new Set();
  const relRows = (await run('RELATIONS')).rows ?? [];
  for (const t of [...OPERATIONAL_TABLES, LEDGER_TABLE]) {
    const r = relRows.find((x) => x.name === t);
    const problems = [];
    if (!r || r.kind !== 'r' || r.rls !== false || r.force_rls !== false || r.rules !== false || r.owned !== true) problems.push(`UNVERIFIED_RELATION:${t}`);
    else {
      if (r.heap_am !== true) problems.push(`ACCESS_METHOD:${t}`);
      if (r.has_subclass !== false || r.is_partition !== false) problems.push(`INHERITANCE:${t}`);
      if (r.indexes_builtin !== true) problems.push(`INDEX_CONTRACT:${t}`);
    }
    if (problems.length) flags.push(...problems); else safe.add(t);
  }

  // Column contract (catalog only), before any value is read: expected type, pg_catalog
  // "default" collation for text columns (none otherwise), built-in output function.
  const typeRows = (await run('COLUMN_TYPES')).rows ?? [];
  const typesOk = new Set();
  for (const [table, cols] of Object.entries(TYPE_CONTRACT)) {
    const ok = cols.every(([col, schema, kind, allowed]) => typeRows.some((r) => r.table_name === table && r.column_name === col
      && r.type_schema === schema && r.type_kind === kind && allowed.includes(r.type_name) && r.out_builtin === true
      && (COLLATABLE_TYPES.has(r.type_name) ? r.coll_schema === 'pg_catalog' && r.coll_name === 'default' : r.coll_name === null)));
    if (ok) typesOk.add(table); else flags.push(`TYPE_CONTRACT:${table}`);
  }

  if (safe.has(LEDGER_TABLE) && typesOk.has(LEDGER_TABLE)) {
    // Bounded: the same-snapshot count must be valid and within LEDGER_ROW_CAP before any row is read.
    const n = (await run('COUNT_LEDGER')).rows?.[0]?.n;
    if (!COUNT.test(String(n))) {
      flags.push(`ROWS_UNKNOWN:${LEDGER_TABLE}`); lines.push('  ledger: NOT READ (row count unavailable)');
    } else if (BigInt(n) > LEDGER_ROW_CAP) {
      flags.push(`ROWS_TOO_MANY:${LEDGER_TABLE}`); lines.push('  ledger: NOT READ (row count above the cap)');
    } else {
      const rows = (await run('LEDGER')).rows ?? [];
      if (BigInt(rows.length) !== BigInt(n)) flags.push('LEDGER_COUNT_MISMATCH');
      // Every row of every migration is kept (one row per apply attempt); nothing is overwritten.
      const groups = new Map();
      const unknown = [];
      for (const r of rows) {
        if (typeof r.migration_name === 'string' && MIGRATIONS.includes(r.migration_name)) {
          if (!groups.has(r.migration_name)) groups.set(r.migration_name, []);
          groups.get(r.migration_name).push(r);
        } else unknown.push(`UNKNOWN(${digest12(r.migration_name)})`);
      }
      for (const name of MIGRATIONS) {
        const attempts = groups.get(name) ?? [];
        if (attempts.length === 0) { lines.push(`  ledger ${name}: NOT_RECORDED`); flags.push(`MIGRATION_NOT_RECORDED:${name}`); continue; }
        const c = classifyMigration(attempts, repoSha.get(`api/prisma/migrations/${name}/migration.sql`));
        lines.push(`  ledger ${name}: status=${c.status} rows=${attempts.length} applied=${c.applied} failed=${c.failed} rolled_back=${c.rolledBack} checksum_matches_repo=${c.allMatch}`);
        if (c.status === 'DRIFT') flags.push(`MIGRATION_DRIFT:${name}`);
        if (c.status === 'APPLIED_AFTER_CHANGED_RECOVERY') flags.push(`MIGRATION_HISTORY_DRIFT:${name}`);
        if (c.status === 'FAILED') flags.push(`MIGRATION_FAILED:${name}`);
        if (c.status === 'AMBIGUOUS') flags.push(`MIGRATION_AMBIGUOUS:${name}`);
        if (c.status === 'FAILED' || c.status === 'ROLLED_BACK' || c.status === 'AMBIGUOUS') flags.push(`MIGRATION_INCOMPLETE:${name}`);
      }
      for (const u of unknown.sort()) { lines.push(`  ledger ${u}`); flags.push('UNKNOWN_MIGRATION'); }
    }
  } else {
    lines.push('  ledger: NOT READ (relation or column contract unverified)');
  }

  const present = new Set(((await run('COLUMNS')).rows ?? []).filter((r) => r.present === true).map((r) => `${r.table_name}.${r.column_name}`));
  for (const [mig, probes] of Object.entries(PROBES)) {
    const facts = probes.map(([t, c]) => `${t}.${c}=${present.has(`${t}.${c}`)}`);
    lines.push(`  schema ${mig}: ${facts.join(' ')}`);
    if (probes.some(([t, c]) => !present.has(`${t}.${c}`))) flags.push(`SCHEMA_ABSENT:${mig}`);
  }
  const trig = (await run('TRIGGERS')).rows?.[0]?.n;
  lines.push(`  schema user triggers on Sale/SalePayment: ${COUNT.test(String(trig)) ? trig : 'INVALID'}`);

  const counts = new Map();
  for (const t of OPERATIONAL_TABLES) {
    if (!safe.has(t)) { lines.push(`  count ${t}: NOT READ (relation unsafe)`); continue; }
    const n = (await run(`COUNT_${t}`)).rows?.[0]?.n;
    if (COUNT.test(String(n))) { lines.push(`  count ${t}: ${n}`); counts.set(t, BigInt(n)); }
    else { lines.push(`  count ${t}: INVALID`); flags.push(`INVALID_COUNT:${t}`); }
  }
  // A value read needs a safe relation, a verified column contract and a bounded row count.
  const readable = (t) => {
    if (!safe.has(t) || !typesOk.has(t)) return false;
    const n = counts.get(t);
    if (n === undefined) { flags.push(`ROWS_UNKNOWN:${t}`); return false; }
    if (n > ROW_READ_CAP) { flags.push(`ROWS_TOO_MANY:${t}`); return false; }
    return true;
  };
  const tally = (values, allowed, table) => {
    const m = new Map();
    for (const v of values) {
      const ok = allowed.has(v);
      if (!ok) flags.push(`INVALID_VALUE:${table}`);
      const key = ok ? v : `INVALID(${digest12(v)})`;
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, n]) => `${k}=${n}`).join(', ') || 'none';
  };

  if (readable('Location')) {
    const locs = ((await run('LOCATIONS')).rows ?? []).map((l) => {
      const ok = LOCATION_CODE.test(String(l.code)) && LOCATION_TYPES.has(l.type) && typeof l.active === 'boolean';
      if (!ok) flags.push('INVALID_VALUE:Location');
      return ok ? `${l.code}/${l.type}/active=${l.active}` : `INVALID(${digest12(`${l.code}|${l.type}`)})`;
    }).sort();
    lines.push(`  locations: ${locs.join(', ') || 'none'}`);
  }
  if (readable('Company')) {
    const rows = (await run('COMPANY_CUITS')).rows ?? [];
    if (rows.some((r) => typeof r.cuit !== 'string')) flags.push('INVALID_VALUE:Company');
    lines.push(`  company rows with PILOT-NO-FISCAL sentinel: ${rows.filter((r) => r.cuit === 'PILOT-NO-FISCAL').length}/${rows.length}`);
  }
  if (readable('Sale')) lines.push(`  sales by status: ${tally(((await run('SALE_STATUSES')).rows ?? []).map((r) => r.status), SALE_STATUSES, 'Sale')}`);
  if (readable('CashSession')) lines.push(`  cash sessions by status: ${tally(((await run('CASH_STATUSES')).rows ?? []).map((r) => r.status), CASH_STATUSES, 'CashSession')}`);
  if (readable('User')) {
    const rows = (await run('USER_ACTIVE')).rows ?? [];
    if (rows.some((r) => typeof r.active !== 'boolean')) flags.push('INVALID_VALUE:User');
    lines.push(`  users active/inactive (counts only): ${rows.filter((r) => r.active === true).length}/${rows.filter((r) => r.active === false).length}`);
  }
  return { lines, flags: [...new Set(flags)] };
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
