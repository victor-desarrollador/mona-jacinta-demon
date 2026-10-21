// OWNER-only, PILOT-only logical backup (A5-1). Agents never execute it against a live
// database (AGENTS.md): the OWNER launches it with the command printed by
// pilot-launch-command.mjs, which pins this file, its manifest, the launch module and Node.
//
//   node scripts/database/pilot-backup.mjs --target=pilot --dry-run  --output-dir=<abs dir> --expected-state=EXACT_S4|EXACT_G7|EXACT_G11|EXACT_G12|EXACT_G13
//   node scripts/database/pilot-backup.mjs --target=pilot --execute  --output-dir=<abs dir> --expected-state=EXACT_S4|EXACT_G7|EXACT_G11|EXACT_G12|EXACT_G13
//
// Gates, in order, before any connection: arguments; exact process context (Node v24.20.0,
// env exactly HOME/PATH/LANG); code-integrity manifest (repo files, npm closure, pg_dump and
// pg_restore bytes); the private PILOT URL and marker-id files; the Supabase host contract and
// the pinned PILOT project-ref digest (LOCAL1/TEST/PRODUCTION digests refused); a private
// (0700, owned, symlink-free, outside repository and temporary storage) output directory
// with free space; final names not taken. --dry-run stops there and spawns nothing.
//
// --execute runs ONE child: the absolute PostgreSQL 17 pg_dump, custom format, schemas public
// and mona_pilot_guard, no owner/privileges, no password prompt, a lock-wait timeout, into a
// dot-temporary file in the output directory. The connection travels only in the child's
// allowlisted environment (verify-full TLS against the pinned CA); the password is never in
// argv, output or files. Then the archive is verified offline with pg_restore over stdin:
// TOC header (dbname postgres, pg_dump 17.11, server 17.x), the exact object allowlist (no
// extension, policy, view, foreign schema, unknown function/trigger), schema-only DDL free of
// untrusted languages and server-side file/program access, the PILOT marker row equal to the
// private marker id, and every public table's COPY data (row count + SHA-256 of the sorted
// COPY lines), the Prisma ledger exactly at the OWNER-named --expected-state (EXACT_S4, EXACT_G7,
// EXACT_G11, EXACT_G12 or EXACT_G13 — never auto-detected) with that state's exact table/function/trigger sets,
// and the RBAC catalog (CATALOG_35/36 before G11, CATALOG_36 at G11/G12). The manifest binds the state's
// generated app-schema reference digest; the restore proof verifies the restored schema against it.
// pg_dump writes into a temporary file this run created exclusively (inode recorded; a replaced
// file is never deleted) with an empty private HOME for libpq. Publication writes exactly the
// verified bytes into new files created exclusively (never overwriting), checks every write,
// fsyncs files and directory, rereads them, and withdraws only its own inodes on any failure.
// The canonical dump manifest (mona-pilot-backup/v1, no secrets) carries the ledger state and an
// HMAC under the OWNER key file ~/.config/mona-jacinta/pilot-backup-mac-key (64 hex, 0600).
// Child stderr is discarded; output is fixed strings, counts and digests only.
//
// Exit codes: 0 VERIFIED / DRY_RUN_OK, 1 arguments, 2 identity, 3 gate refused, 4 error,
// 5 name collision.

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { spawn as nodeSpawn, spawnSync } from 'node:child_process';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  canonicalJson, checkNoSymlinkComponents, checkPrivateDir, checkRuntime, isUnderAny, readPrivateFile, runChild as runChildCore,
  safePathChars, sha256, verifyCodeManifest,
} from './pilot-launch-command.mjs';

const PREFIX = '[db:pilot-backup]';
export const PG_DUMP = '/usr/lib/postgresql/17/bin/pg_dump';
export const PG_RESTORE = '/usr/lib/postgresql/17/bin/pg_restore';
const MANIFEST_REL = 'scripts/database/pilot-backup.manifest.json';
// OWNER-held HMAC key (64 lowercase hex, mode 0600) that authenticates every dump manifest (R2, A5-004).
export const MAC_KEY_FILE = 'pilot-backup-mac-key';
const MAC_DOMAIN = 'mona-pilot-backup/v2 mac\n';
const CA_REL = 'scripts/certs/supabase-prod-ca-2021.crt';
// v2 (G11 cut-over): + the RBAC catalog classification and the bound app-schema reference digest;
// the ledger state is one of the three exact states. A v1 manifest is refused.
const DUMP_MANIFEST_FORMAT = 'mona-pilot-backup/v2';
const GUARD_SCHEMA = 'mona_pilot_guard';
const GUARD_TABLE = 'database_identity';
const MAX_PRIVATE_BYTES = 4096;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_DUMP_MANIFEST_BYTES = 1024 * 1024;
const MIN_FREE_BYTES = 2n * 1024n * 1024n * 1024n;
const PG_DUMP_TIMEOUT_MS = 30 * 60 * 1000;
const PG_RESTORE_TIMEOUT_MS = 10 * 60 * 1000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Domain-separated SHA-256 of the OWNER-declared project refs (2026-10-14); the refs are not stored.
const REF_DOMAIN = 'mona-pilot-project-ref\n';
export const REF_DIGESTS = Object.freeze({
  pilot: 'cae01c80a53cf8cf392f309a7f7e0bc402da862c93dedf7347e608075d402c64',
  forbidden: Object.freeze([
    '192f53743dd344fe51a2839109650387c7b12140efeef8aa714d23c3d35776a1', // LOCAL1
    '0ecc4e2617f88b2baafbd1ef659711f7330c99d09e9292dc245ca09702d85d5f', // TEST
    'afeac2094ae5b5ca1b1f695cd864a9abc707b64ba99c81bc0464d8509d94d0af', // PRODUCTION
  ]),
});
export const markerDigest = (markerId) => sha256(`mona-pilot-marker-id\n${markerId}`);

// The public tables of the four migrations applied on PILOT plus the Prisma ledger; the Pricing V2
// table is accepted only when present with its data (pending migration on PILOT, 2026-10-15).
export const CORE_TABLES = Object.freeze(['AuditLog', 'Branch', 'Brand', 'CashMovement', 'CashRegister', 'CashSession', 'Category', 'Company',
  'Inventory', 'Location', 'Permission', 'Product', 'ProductVariant', 'Role', 'RolePermission', 'Sale', 'SaleItem', 'SaleNumberCounter',
  'SalePayment', 'StockMovement', 'StockReservation', 'User', 'UserBranchRole', 'UserRoleScope']);
export const LEDGER_TABLE = '_prisma_migrations';
// m8/m9: the six R3 tables.
export const R3_TABLES = Object.freeze(['CheckoutAttempt', 'CheckoutAttemptDeclaration', 'CheckoutAttemptTender', 'ExternalCollection', 'SaleCheckout', 'SaleLineAllocation']);
// Block 1 (m5) plpgsql functions and their triggers, as pg_restore --list names them.
export const BLOCK1_FUNCTIONS = Object.freeze(['fn_sale_payment_history()', 'fn_sale_payment_truncate_guard()', 'fn_sale_wholesale_frozen_after_payment()']);
export const BLOCK1_TRIGGERS = Object.freeze(['SalePayment trg_sale_payment_history_before', 'SalePayment trg_sale_payment_history_after',
  'SalePayment trg_sale_payment_truncate_guard', 'Sale trg_sale_wholesale_frozen_after_payment']);
// R3 (m9) guard/commit-check functions F1–F6 and their six triggers (two are deferred CONSTRAINT TRIGGERs).
export const R3_FUNCTIONS = Object.freeze(['fn_checkout_attempt_commit_check()', 'fn_checkout_attempt_declaration_guard()', 'fn_checkout_attempt_guard()',
  'fn_checkout_attempt_tender_guard()', 'fn_checkout_declaration_commit_check()', 'fn_external_collection_guard()']);
export const R3_TRIGGERS = Object.freeze(['CheckoutAttempt trg_checkout_attempt_commit_check', 'CheckoutAttempt trg_checkout_attempt_guard',
  'CheckoutAttemptDeclaration trg_checkout_attempt_declaration_guard', 'CheckoutAttemptDeclaration trg_checkout_declaration_commit_check',
  'CheckoutAttemptTender trg_checkout_attempt_tender_guard', 'ExternalCollection trg_external_collection_guard']);

// G12 cut-over (OWNER 2026-10-18, extended 2026-10-20): a backup is taken of ONE explicitly expected exact state
// (--expected-state), never auto-detected. Its public tables, app functions and triggers must
// be EXACTLY that state's sets; the ledger must be exactly that state (shared strict classifier);
// the RBAC catalog must be CATALOG_35/CATALOG_36 (initial states) or CATALOG_36 (EXACT_G11/EXACT_G12/EXACT_G13).
// The full app-owned schema is proven by the restore proof (pilot-clone-restore.mjs), which
// compares the restored clone's projection digest with the reference digest this manifest binds.
export const STATE_OBJECTS = Object.freeze({
  EXACT_S4: Object.freeze({ tables: Object.freeze([...CORE_TABLES, LEDGER_TABLE].sort()), functions: Object.freeze([]), triggers: Object.freeze([]), catalogs: Object.freeze(['CATALOG_35', 'CATALOG_36']) }),
  EXACT_G7: Object.freeze({ tables: Object.freeze([...CORE_TABLES, LEDGER_TABLE, 'CompanyPricingConfig'].sort()), functions: BLOCK1_FUNCTIONS, triggers: BLOCK1_TRIGGERS, catalogs: Object.freeze(['CATALOG_35', 'CATALOG_36']) }),
  EXACT_G11: Object.freeze({
    tables: Object.freeze([...CORE_TABLES, LEDGER_TABLE, 'CompanyPricingConfig', ...R3_TABLES].sort()),
    functions: Object.freeze([...BLOCK1_FUNCTIONS, ...R3_FUNCTIONS].sort()), triggers: Object.freeze([...BLOCK1_TRIGGERS, ...R3_TRIGGERS].sort()),
    catalogs: Object.freeze(['CATALOG_36']),
  }),
  EXACT_G12: Object.freeze({
    tables: Object.freeze([...CORE_TABLES, LEDGER_TABLE, 'CompanyPricingConfig', ...R3_TABLES].sort()),
    functions: Object.freeze([...BLOCK1_FUNCTIONS, ...R3_FUNCTIONS].sort()), triggers: Object.freeze([...BLOCK1_TRIGGERS, ...R3_TRIGGERS].sort()),
    catalogs: Object.freeze(['CATALOG_36']),
  }),
  EXACT_G13: Object.freeze({
    tables: Object.freeze([...CORE_TABLES, LEDGER_TABLE, 'CompanyPricingConfig', ...R3_TABLES].sort()),
    functions: Object.freeze([...BLOCK1_FUNCTIONS, ...R3_FUNCTIONS].sort()), triggers: Object.freeze([...BLOCK1_TRIGGERS, ...R3_TRIGGERS].sort()),
    catalogs: Object.freeze(['CATALOG_36']),
  }),
});
export const BACKUP_STATES = Object.freeze(Object.keys(STATE_OBJECTS));

const PACKAGE_CLOSURE = Object.freeze(['pg', 'pg-connection-string', 'pg-pool', 'pg-protocol', 'pg-types', 'pgpass',
  'split2', 'pg-int8', 'postgres-array', 'postgres-bytea', 'postgres-date', 'postgres-interval', 'pg-cloudflare', 'xtend']);
// All twelve reviewed migrations (pilot-migration-states.mjs pins the same list; a test asserts it).
export const MIGRATIONS = Object.freeze([
  '20260907015311_init', '20260912182432_add_company_location', '20260912191702_add_user_role_scope',
  '20260922210000_d3_initial_stock_and_global_audit', '20261002120000_block1_pricing_wholesale',
  '20261006120000_pilot_pricing_v2', '20261012120000_cash_session_reconciliation',
  '20261016120000_r3_proportional_checkout', '20261016130000_r3_checkout_attempts',
  '20261018120000_cash_movement_withdrawals_expenses', '20261018180000_cash_movement_reversals', '20261021120000_r3_card_credit', '20261021130000_warehouse_stock_adjustment',
]);
// The builtins-only shared cut-over modules: pinned by the manifest, imported only after it verified.
export const SHARED_MODULES = Object.freeze({
  states: 'scripts/database/pilot-migration-states.mjs',
  references: 'scripts/database/pilot-schema-references.mjs',
  rbac: 'scripts/database/pilot-rbac-catalog.mjs',
});
export const migrationRepoPath = (m) => `api/prisma/migrations/${m}/migration.sql`;
export const REQUIRED_REPO_FILES = Object.freeze(['scripts/database/pilot-marker.mjs', 'scripts/database/lib.mjs', 'scripts/database/pilot-launch-command.mjs', CA_REL,
  ...Object.values(SHARED_MODULES), ...MIGRATIONS.map(migrationRepoPath)]);

const POOLER_HOST = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/;
const DIRECT_HOST = /^db\.([a-z0-9]{20})\.supabase\.co$/;
const POOLER_USER = /^postgres\.([a-z0-9]{20})$/;

// ---------------- arguments and target ----------------

export function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length !== 4) return { ok: false };
  let target = null; let mode = null; let outputDir = null; let expectedState = null;
  for (const a of argv) {
    if (a === '--target=pilot' && target === null) target = 'pilot';
    else if ((a === '--execute' || a === '--dry-run') && mode === null) mode = a.slice(2);
    else if (a.startsWith('--output-dir=') && outputDir === null) outputDir = a.slice('--output-dir='.length);
    else if (a.startsWith('--expected-state=') && expectedState === null) expectedState = a.slice('--expected-state='.length);
    else return { ok: false };
  }
  if (target !== 'pilot' || mode === null || !safePathChars(outputDir) || !BACKUP_STATES.includes(expectedState)) return { ok: false };
  return { ok: true, mode, outputDir, expectedState };
}

// Supabase host contract (pooler user postgres.<ref> on the session pooler, or direct db.<ref> with
// user postgres), port 5432, database postgres, and the ref digest equal to the pinned PILOT digest.
export function resolveTarget(conn, refDigests, deriveProjectRef) {
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
  if (refDigests.forbidden.includes(d)) return { ok: false, reason: 'FORBIDDEN environment (LOCAL1/TEST/PRODUCTION); nothing started' };
  if (d !== refDigests.pilot) return { ok: false, reason: 'project ref digest does not match the pinned PILOT digest; nothing started' };
  return { ok: true, ref, refDigest: d };
}

// ---------------- pg_dump child ----------------

export function buildPgDumpArgs(tempFile) {
  return [`--file=${tempFile}`, '--format=custom', `--schema=public`, `--schema=${GUARD_SCHEMA}`, '--no-owner', '--no-privileges', '--no-password', '--lock-wait-timeout=30s'];
}

// libpq per-user inputs pinned inside an empty private directory created by this run (R2, A5-005):
// no client certificate/key, CRL, password file, service file or sysconf from the operator's home.
export function pinnedLibpqEnv(home) {
  return {
    HOME: home, PGSSLCERT: path.join(home, 'none.crt'), PGSSLKEY: path.join(home, 'none.key'), PGSSLCRL: path.join(home, 'none.crl'),
    PGSSLCRLDIR: path.join(home, 'none-crl.d'), PGPASSFILE: path.join(home, 'none.pgpass'), PGSERVICEFILE: path.join(home, 'none.service'), PGSYSCONFDIR: home,
  };
}

// The connection lives only here; nothing else from the parent environment reaches the child.
export function buildPgDumpEnv(conn, { home, root }) {
  return {
    ...pinnedLibpqEnv(home), PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGTZ: 'UTC', PGAPPNAME: 'mona-pilot-backup', PGCONNECT_TIMEOUT: '15',
    PGHOST: conn.host, PGPORT: String(conn.port), PGUSER: conn.user, PGDATABASE: conn.database, PGPASSWORD: conn.password,
    PGSSLMODE: 'verify-full', PGSSLROOTCERT: path.join(root, CA_REL),
  };
}

export function runChild(spawn, file, args, opts) {
  return runChildCore(spawn, file, args, opts);
}

// ---------------- archive verification (pure) ----------------

// pg_restore --list entry types, longest first so multi-word types win.
const TOC_TYPES = ['MATERIALIZED VIEW DATA', 'DATABASE PROPERTIES', 'SEQUENCE OWNED BY', 'PUBLICATION TABLE', 'PUBLICATION TABLES IN SCHEMA',
  'TEXT SEARCH CONFIGURATION', 'TEXT SEARCH DICTIONARY', 'TEXT SEARCH PARSER', 'TEXT SEARCH TEMPLATE', 'FOREIGN DATA WRAPPER', 'CHECK CONSTRAINT',
  'MATERIALIZED VIEW', 'EVENT TRIGGER', 'FK CONSTRAINT', 'FOREIGN TABLE', 'SEQUENCE SET', 'INDEX ATTACH', 'OPERATOR CLASS', 'OPERATOR FAMILY',
  'LARGE OBJECT', 'ROW SECURITY', 'USER MAPPING', 'DEFAULT ACL', 'TABLE DATA', 'BLOB METADATA', 'ACCESS METHOD', 'PROCEDURAL LANGUAGE',
  'TABLE ATTACH', 'SUBSCRIPTION TABLE', 'AGGREGATE', 'COLLATION', 'CONSTRAINT', 'CONVERSION', 'EXTENSION', 'PROCEDURE', 'PUBLICATION', 'SUBSCRIPTION',
  'STATISTICS', 'TRANSFORM', 'BLOBS', 'BLOB', 'CAST', 'COMMENT', 'DATABASE', 'DEFAULT', 'DOMAIN', 'ENCODING', 'FUNCTION', 'INDEX', 'OPERATOR',
  'POLICY', 'RULE', 'SCHEMA', 'SEARCHPATH', 'SECURITY LABEL', 'SEQUENCE', 'SERVER', 'SHELL TYPE', 'STDSTRINGS', 'TABLE', 'TRIGGER', 'TYPE', 'VIEW', 'ACL']
  .sort((a, b) => b.length - a.length);
const ALLOWED_TYPES = new Set(['TABLE DATA', 'TABLE', 'SCHEMA', 'COMMENT', 'TYPE', 'SEQUENCE', 'SEQUENCE OWNED BY', 'SEQUENCE SET', 'DEFAULT',
  'CONSTRAINT', 'FK CONSTRAINT', 'CHECK CONSTRAINT', 'INDEX', 'FUNCTION', 'TRIGGER']);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// pg_dump writes its local time with a zone abbreviation or numeric offset.
function parseArchiveTime(date, time, zone) {
  let offset;
  if (zone === 'UTC' || zone === 'GMT') offset = 'Z';
  else if (/^[+-][0-9]{2}$/.test(zone)) offset = `${zone}:00`;
  else if (/^[+-][0-9]{2}:?[0-9]{2}$/.test(zone)) offset = `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  else return null;
  const ms = Date.parse(`${date}T${time}${offset}`);
  return Number.isNaN(ms) ? null : new Date(ms);
}

export function parseToc(text) {
  const s = String(text);
  const header = (label) => new RegExp(`^;\\s+${label}: (.+?)\\s*$`, 'm').exec(s)?.[1] ?? null;
  const entries = [];
  let malformed = 0;
  for (const line of s.split('\n')) {
    if (line === '' || line.startsWith(';')) continue;
    const m = /^([0-9]+); ([0-9]+) ([0-9]+) (.+)$/.exec(line);
    if (!m) { malformed += 1; continue; }
    const rest = m[4];
    const type = TOC_TYPES.find((t) => rest.startsWith(`${t} `)) ?? null;
    if (type === null) { entries.push({ type: null, schema: null, name: null, owner: null }); continue; }
    const tokens = rest.slice(type.length + 1).split(' ');
    if (tokens.length < 3) { entries.push({ type, schema: null, name: null, owner: null }); continue; }
    entries.push({ type, schema: tokens[0], name: tokens.slice(1, -1).join(' '), owner: tokens.at(-1) });
  }
  const created = /^;\s+Archive created at ([0-9]{4}-[0-9]{2}-[0-9]{2}) ([0-9]{2}:[0-9]{2}:[0-9]{2}) (\S+)\s*$/m.exec(s);
  return { dbname: header('dbname'), serverVersion: header('Dumped from database version'), dumpVersion: header('Dumped by pg_dump version'), entries, malformed,
    archiveCreatedAt: created ? parseArchiveTime(created[1], created[2], created[3]) : null };
}

// The exact object allowlist of a PILOT backup of the expected state: public tables, app
// functions and triggers equal that state's sets exactly. Returns the public table set on success.
export function verifyToc(toc, expectedState) {
  const no = (reason) => ({ ok: false, reason });
  const expected = STATE_OBJECTS[expectedState];
  if (!expected) return no('unknown expected state');
  if (toc.malformed !== 0) return no('the archive TOC has unparseable entries');
  if (toc.dbname !== 'postgres') return no('the archive was taken from another database');
  if (!/^17\.11( |$)/.test(toc.dumpVersion ?? '')) return no('the archive was not written by pg_dump 17.11');
  if (!/^17\.[0-9]+( |$)/.test(toc.serverVersion ?? '')) return no('the archive source server is not PostgreSQL 17');
  const tables = new Set(); const data = new Set(); const functions = new Set(); const triggers = new Set();
  let guardSchema = 0; let guardTable = 0; let guardData = 0;
  for (const e of toc.entries) {
    if (e.type === null || e.name === null) return no('the archive TOC has an unknown entry type');
    if (!ALLOWED_TYPES.has(e.type)) return no(`the archive contains a ${e.type} entry (not allowed)`);
    if (CONTROL.test(e.name) || CONTROL.test(e.schema)) return no('the archive TOC has control characters');
    if (!['-', 'public', GUARD_SCHEMA].includes(e.schema)) return no('the archive contains an object outside public and the PILOT guard');
    if (e.type === 'SCHEMA') {
      if (e.name === GUARD_SCHEMA) guardSchema += 1;
      else if (e.name !== 'public') return no('the archive contains a foreign schema');
      continue;
    }
    if (e.type === 'COMMENT') {
      if (!/^(SCHEMA (public|mona_pilot_guard)|(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT|SEQUENCE) .+)$/.test(e.name)) return no('the archive contains a comment on a disallowed object');
      continue;
    }
    if (e.schema === GUARD_SCHEMA) {
      if (e.type === 'TABLE' && e.name === GUARD_TABLE) guardTable += 1;
      else if (e.type === 'TABLE DATA' && e.name === GUARD_TABLE) guardData += 1;
      else if (!(e.type === 'CONSTRAINT' && e.name.startsWith(`${GUARD_TABLE} `))) return no('the PILOT guard schema contains an unexpected object');
      continue;
    }
    if (e.schema !== 'public') return no('the archive contains an object without a schema');
    if (e.type === 'FUNCTION') {
      if (!expected.functions.includes(e.name)) return no(`the archive contains a function outside the ${expectedState} allowlist`);
      if (functions.has(e.name)) return no('duplicate function'); functions.add(e.name);
    }
    if (e.type === 'TRIGGER') {
      if (!expected.triggers.includes(e.name)) return no(`the archive contains a trigger outside the ${expectedState} allowlist`);
      if (triggers.has(e.name)) return no('duplicate trigger'); triggers.add(e.name);
    }
    if (e.type === 'TABLE') { if (tables.has(e.name)) return no('duplicate table'); tables.add(e.name); }
    if (e.type === 'TABLE DATA') { if (data.has(e.name)) return no('duplicate table data'); data.add(e.name); }
  }
  if (guardSchema !== 1 || guardTable !== 1) return no('the archive does not contain the PILOT guard schema');
  if (guardData !== 1) return no('the archive does not contain the PILOT marker data');
  for (const t of expected.tables) {
    if (!tables.has(t)) return no(`the archive does not contain table ${t} (required by ${expectedState})`);
    if (!data.has(t)) return no(`the archive does not contain table data for ${t}`);
  }
  for (const t of tables) {
    if (!expected.tables.includes(t)) return no(`the archive contains a table outside the ${expectedState} set`);
    if (!data.has(t)) return no(`the archive does not contain table data for ${t}`);
  }
  for (const t of data) if (!tables.has(t)) return no('the archive contains table data without its table');
  const missingFunctions = expected.functions.filter((f) => !functions.has(f));
  const missingTriggers = expected.triggers.filter((t) => !triggers.has(t));
  if (missingFunctions.length || missingTriggers.length) return no(`the archive lacks app functions/triggers of ${expectedState}`);
  return { ok: true, publicTables: [...tables].sort(), schemas: [GUARD_SCHEMA, 'public'], functions: [...functions].sort(), triggers: [...triggers].sort(), entries: toc.entries };
}

// Schema-only DDL: only trusted procedural languages and no server-side program or file access.
const DDL_FORBIDDEN = [/\bLANGUAGE\s+(?!plpgsql\b|sql\b)[A-Za-z_"]/i, /\bPROGRAM\b/i, /\bCREATE\s+EXTENSION\b/i, /\bLOAD\s+'/i,
  /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|pg_file_write|lo_import|lo_export|lo_from_bytea|dblink\w*|pg_execute_server_program|pg_reload_conf|set_config)\s*\(/i];
// pg_dump's own preamble line is the only set_config call accepted.
const PG_DUMP_SEARCH_PATH = "SELECT pg_catalog.set_config('search_path', '', false);";
export function verifyDdl(text) {
  const s = String(text).split('\n').filter((l) => l !== PG_DUMP_SEARCH_PATH).join('\n');
  for (const re of DDL_FORBIDDEN) if (re.test(s)) return { ok: false, reason: 'the archive DDL uses an untrusted language or server-side program/file access' };
  return { ok: true };
}

const TIMESTAMPTZ = /^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?[+-][0-9]{2}(:[0-9]{2}){0,2}$/;
// The marker as pg_restore writes it: one COPY of the canonical column list with exactly one row.
export function parseMarkerCopy(text) {
  const lines = String(text).split('\n');
  const copies = lines.filter((l) => l.startsWith('COPY '));
  const header = `COPY ${GUARD_SCHEMA}.${GUARD_TABLE} (singleton, environment, marker_id, installed_at) FROM stdin;`;
  if (copies.length !== 1 || copies[0] !== header) return { ok: false };
  const start = lines.indexOf(header);
  const end = lines.indexOf('\\.', start);
  if (end === -1) return { ok: false };
  const rows = lines.slice(start + 1, end);
  if (rows.length !== 1) return { ok: false };
  const f = rows[0].split('\t');
  if (f.length !== 4 || f[0] !== 't' || !/^[a-z]{1,16}$/.test(f[1]) || !UUID_V4.test(f[2]) || !TIMESTAMPTZ.test(f[3])) return { ok: false };
  return { ok: true, environment: f[1], markerId: f[2] };
}

// Per-table COPY data of schema public: row count and SHA-256 of "<column list>\n<sorted lines>".
// The same function digests the archive (backup and clone) and a pg_dump of the restored clone.
export function copyDigests(text) {
  const lines = String(text).split('\n');
  const tables = {};
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith('COPY ')) continue;
    const m = /^COPY public\.("(?:[^"]|"")+"|[a-z_][a-z0-9_$]*) \((.*)\) FROM stdin;$/.exec(line);
    if (!m) return { ok: false, reason: 'COPY data outside schema public' };
    const name = m[1].startsWith('"') ? m[1].slice(1, -1).replace(/""/g, '"') : m[1];
    if (!IDENT.test(name) || Object.hasOwn(tables, name)) return { ok: false, reason: 'unexpected or duplicate COPY block' };
    const end = lines.indexOf('\\.', i + 1);
    if (end === -1) return { ok: false, reason: 'unterminated COPY block' };
    const rows = lines.slice(i + 1, end).sort();
    tables[name] = { rows: rows.length, copySha256: sha256(`${m[2]}\n${rows.join('\n')}`) };
    i = end;
  }
  return { ok: true, tables };
}

// ---------------- ledger (R2, A5-003) ----------------

const LEDGER_COLUMNS = 'id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count';
const MIGRATION_NAME = /^[0-9]{14}_[a-z0-9_]{1,200}$/;
const STEPS = /^(0|[1-9][0-9]{0,8})$/;
const TS_OR_NULL = (v) => v === '\\N' || TIMESTAMPTZ.test(v);

// The Prisma ledger rows exactly as pg_dump/pg_restore write them (one COPY with the Prisma column list).
export function ledgerRowsFromCopy(text) {
  const lines = String(text).split('\n');
  const header = `COPY public.${LEDGER_TABLE} (${LEDGER_COLUMNS}) FROM stdin;`;
  const starts = lines.flatMap((l, i) => (l.startsWith(`COPY public.${LEDGER_TABLE} `) ? [i] : []));
  if (starts.length !== 1 || lines[starts[0]] !== header) return { ok: false, reason: 'the ledger COPY block is missing or has unexpected columns' };
  const end = lines.indexOf('\\.', starts[0] + 1);
  if (end === -1) return { ok: false, reason: 'the ledger COPY block is unterminated' };
  const rows = [];
  for (const line of lines.slice(starts[0] + 1, end)) {
    const f = line.split('\t');
    if (f.length !== 8 || f[0] === '\\N' || !HEX64.test(f[1]) || !TS_OR_NULL(f[2]) || !TS_OR_NULL(f[5]) || !TIMESTAMPTZ.test(f[6]) || !/^[0-9]{1,9}$/.test(f[7])) {
      return { ok: false, reason: 'malformed ledger row' };
    }
    rows.push({ migration_name: f[3], checksum: f[1], finished: f[2] !== '\\N', rolled_back: f[5] !== '\\N', applied_steps_count: f[7] });
  }
  return { ok: true, rows };
}

// G11: the RBAC catalog rows exactly as pg_restore writes them — one COPY block per table, with
// the named columns located by the block's own column list (pg_dump order). Values are text;
// a NULL (\N), a missing column, a duplicate block or an unterminated block refuses.
const CATALOG_COPY = Object.freeze({ Role: ['id', 'code'], Permission: ['id', 'code'], RolePermission: ['roleId', 'permissionId'] });
export function catalogFromCopy(text) {
  const lines = String(text).split('\n');
  const out = {};
  for (const [table, wanted] of Object.entries(CATALOG_COPY)) {
    const prefix = `COPY public."${table}" (`;
    const starts = lines.flatMap((l, i) => (l.startsWith(prefix) && l.endsWith(') FROM stdin;') ? [i] : []));
    if (starts.length !== 1) return { ok: false, reason: `the ${table} COPY block is missing or duplicated` };
    const columns = lines[starts[0]].slice(prefix.length, -') FROM stdin;'.length).split(', ').map((c) => c.replace(/^"(.*)"$/, '$1'));
    const idx = wanted.map((c) => columns.indexOf(c));
    if (idx.some((i) => i < 0)) return { ok: false, reason: `the ${table} COPY block lacks a catalog column` };
    const end = lines.indexOf('\\.', starts[0] + 1);
    if (end === -1) return { ok: false, reason: `the ${table} COPY block is unterminated` };
    const rows = [];
    for (const line of lines.slice(starts[0] + 1, end)) {
      const f = line.split('\t');
      if (f.length !== columns.length || idx.some((i) => f[i] === '\\N')) return { ok: false, reason: `malformed ${table} row` };
      rows.push(Object.fromEntries(wanted.map((c, k) => [c, f[idx[k]]])));
    }
    out[table] = rows;
  }
  return { ok: true, catalog: { roles: out.Role, permissions: out.Permission, grants: out.RolePermission } };
}

// The manifest is written after the archive: [archive creation − 5 min, + 12 h].
export function withinArchiveWindow(createdAtIso, archiveCreatedAt) {
  const t = Date.parse(createdAtIso);
  if (!(archiveCreatedAt instanceof Date) || Number.isNaN(t)) return false;
  const a = archiveCreatedAt.getTime();
  return t >= a - 5 * 60 * 1000 && t <= a + 12 * 60 * 60 * 1000;
}

// ---------------- manifest authentication (R2, A5-004) ----------------

export function parseMacKey(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : '';
  return /^[0-9a-f]{64}\n?$/.test(text) ? text.slice(0, 64) : null;
}
export const canonicalManifestBody = (body) => canonicalJson({ ...body, format: DUMP_MANIFEST_FORMAT });
export function computeManifestMac(keyHex, fields) {
  const { mac: _mac, format: _format, ...body } = fields;
  return createHmac('sha256', Buffer.from(keyHex, 'hex')).update(`${MAC_DOMAIN}${canonicalManifestBody(body)}`).digest('hex');
}
export function verifyManifestMac(keyHex, manifest) {
  if (typeof manifest?.mac !== 'string' || !HEX64.test(manifest.mac)) return false;
  return timingSafeEqual(Buffer.from(computeManifestMac(keyHex, manifest), 'hex'), Buffer.from(manifest.mac, 'hex'));
}

// Offline verification of an archive's bytes (backup before publication; clone before any cluster).
// pgRestore(kind, bytes) may be synchronous or asynchronous.
// The offline archive verification shared by the backup and the restore proof. `shared` = the
// manifest-verified cut-over modules ({ states, references, rbac }).
export async function verifyArchiveBytes({ bytes, pgRestore, markerId, expectedState, shared }) {
  const no = (reason, identity = false) => ({ ok: false, reason, identity });
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== 'PGDMP') return no('the archive is not a pg_dump custom-format archive');
  if (!STATE_OBJECTS[expectedState]) return no('unknown expected state');
  const schemaReferenceDigest = shared?.references?.SCHEMA_REFERENCES?.[expectedState]?.digest;
  if (!HEX64.test(String(schemaReferenceDigest))) return no(`no generated app-schema reference for ${expectedState} (pilot-schema-references.mjs)`);
  const call = async (kind) => {
    const r = await pgRestore(kind, bytes);
    return r && r.status === 0 && typeof r.stdout === 'string' ? r.stdout : null;
  };
  const list = await call('list');
  if (list === null) return no('pg_restore --list could not read the archive');
  const toc = parseToc(list);
  const tv = verifyToc(toc, expectedState);
  if (!tv.ok) return no(tv.reason);
  if (!(toc.archiveCreatedAt instanceof Date)) return no('the archive creation time is missing or not parseable');
  const ddl = await call('ddl');
  if (ddl === null) return no('pg_restore --schema-only could not read the archive');
  const dv = verifyDdl(ddl);
  if (!dv.ok) return no(dv.reason);
  const markerText = await call('marker');
  if (markerText === null) return no('the PILOT marker data could not be extracted');
  const mk = parseMarkerCopy(markerText);
  if (!mk.ok || mk.environment !== 'pilot' || mk.markerId !== markerId) return no('the archive does not contain exactly the expected PILOT marker', true);
  const dataText = await call('data');
  if (dataText === null) return no('the public table data could not be extracted');
  const cd = copyDigests(dataText);
  if (!cd.ok) return no(cd.reason);
  if (Object.keys(cd.tables).sort().join(',') !== tv.publicTables.join(',')) return no('the archive COPY data does not match its table set');
  const lr = ledgerRowsFromCopy(dataText);
  if (!lr.ok) return no(`ledger: ${lr.reason}`);
  const ledger = shared.states.requireState(lr.rows.map((r) => ({ migration_name: r.migration_name, checksum: r.checksum, finished: r.finished, rolled_back: r.rolled_back })), expectedState);
  if (!ledger.ok) return no(`ledger: ${ledger.reason}`);
  const cat = catalogFromCopy(dataText);
  if (!cat.ok) return no(`rbac: ${cat.reason}`);
  const rbac = shared.rbac.classifyCatalog(cat.catalog);
  if (!rbac.ok || !STATE_OBJECTS[expectedState].catalogs.includes(rbac.catalog)) {
    return no(`rbac: the RBAC catalog is ${rbac.ok ? rbac.catalog : 'unclassified'}, ${expectedState} requires ${STATE_OBJECTS[expectedState].catalogs.join(' or ')}`);
  }
  return {
    ok: true, tocSha256: sha256(list), tables: cd.tables, publicTables: tv.publicTables, schemas: tv.schemas, ledgerState: ledger.state, ledger,
    rbacCatalog: { catalog: rbac.catalog, digest: rbac.digest, permissions: cat.catalog.permissions.length, grants: cat.catalog.grants.length },
    schemaReferenceDigest,
    serverVersion: /^(17\.[0-9]+)/.exec(toc.serverVersion)[1], pgDumpVersion: '17.11', archiveCreatedAt: toc.archiveCreatedAt, markerDigest: markerDigest(mk.markerId),
  };
}

// pg_restore never opens a path: the verified bytes arrive on stdin; no connection options.
export function pgRestoreArgs(kind) {
  if (kind === 'list') return ['--list', '--format=custom'];
  if (kind === 'ddl') return ['--format=custom', '--schema-only', '--schema=public', '--no-owner', '--no-privileges', '--file=-'];
  if (kind === 'marker') return ['--format=custom', '--data-only', `--schema=${GUARD_SCHEMA}`, `--table=${GUARD_TABLE}`, '--file=-'];
  if (kind === 'data') return ['--format=custom', '--data-only', '--schema=public', '--file=-'];
  throw new Error('unknown pg_restore invocation');
}
function defaultPgRestore(kind, bytes) {
  const r = spawnSync(PG_RESTORE, pgRestoreArgs(kind), {
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', PGTZ: 'UTC' }, input: bytes, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'],
    timeout: PG_RESTORE_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MAX_ARCHIVE_BYTES,
  });
  return { status: r.status, stdout: r.stdout };
}

// ---------------- dump manifest ----------------

const ts = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.[0-9]{3}Z$/, 'Z');
export function artifactNames({ now, hex }) {
  const dump = `pilot_${ts(now)}_${hex}.dump`;
  return { dump, manifest: `${dump}.manifest.json`, temp: `.${dump}.partial` };
}

const DUMP_MANIFEST_KEYS = ['archive', 'createdAt', 'format', 'ledgerState', 'mac', 'markerIdDigest', 'pgDumpVersion', 'rbacCatalog', 'refDigest',
  'schemaReferenceDigest', 'schemas', 'serverVersion', 'setId', 'tables', 'tocSha256', 'toolSha256'];
export function buildDumpManifest(fields) {
  return `${canonicalJson({ format: DUMP_MANIFEST_FORMAT, ...fields })}\n`;
}
export function parseDumpManifest(bytes) {
  const no = (reason) => ({ ok: false, reason });
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_DUMP_MANIFEST_BYTES) return no('dump manifest size');
  const text = bytes.toString('utf8');
  let m;
  try { m = JSON.parse(text); } catch { return no('dump manifest is not JSON'); }
  if (m === null || typeof m !== 'object' || Array.isArray(m)) return no('dump manifest is not an object');
  if (`${canonicalJson(m)}\n` !== text) return no('dump manifest is not canonical');
  if (Object.keys(m).sort().join(',') !== DUMP_MANIFEST_KEYS.join(',')) return no('dump manifest keys differ');
  const a = m.archive;
  const valid = m.format === DUMP_MANIFEST_FORMAT && UUID_V4.test(m.setId) && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(m.createdAt)
    && HEX64.test(m.toolSha256) && m.pgDumpVersion === '17.11' && /^17\.[0-9]+$/.test(m.serverVersion)
    && a !== null && typeof a === 'object' && Object.keys(a).sort().join(',') === 'bytes,file,sha256'
    && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}\.dump$/.test(a.file) && Number.isSafeInteger(a.bytes) && a.bytes > 0 && HEX64.test(a.sha256)
    && HEX64.test(m.tocSha256) && canonicalJson(m.schemas) === canonicalJson([GUARD_SCHEMA, 'public'])
    && HEX64.test(m.refDigest) && HEX64.test(m.markerIdDigest) && BACKUP_STATES.includes(m.ledgerState) && HEX64.test(m.mac)
    && HEX64.test(m.schemaReferenceDigest)
    && m.rbacCatalog !== null && typeof m.rbacCatalog === 'object' && Object.keys(m.rbacCatalog).sort().join(',') === 'catalog,digest,grants,permissions'
    && STATE_OBJECTS[m.ledgerState]?.catalogs.includes(m.rbacCatalog.catalog) && HEX64.test(m.rbacCatalog.digest)
    && Number.isSafeInteger(m.rbacCatalog.permissions) && Number.isSafeInteger(m.rbacCatalog.grants)
    && m.tables !== null && typeof m.tables === 'object' && !Array.isArray(m.tables) && Object.keys(m.tables).length > 0
    && Object.entries(m.tables).every(([k, v]) => IDENT.test(k) && v !== null && typeof v === 'object' && Object.keys(v).sort().join(',') === 'copySha256,rows'
      && Number.isSafeInteger(v.rows) && v.rows >= 0 && HEX64.test(v.copySha256));
  return valid ? { ok: true, manifest: m } : no('dump manifest field invalid');
}

// ---------------- durable exclusive publication (R2, A5-002) ----------------

// Creates `file` exclusively (never overwrites, never follows a link), writes every byte (a write that
// makes no progress is a failure), fsyncs, closes, then rereads it as a private file and requires the
// same inode and identical bytes. `created` identifies the inode this call made, for withdrawal.
export function publishExclusive(fs, uid, file, bytes) {
  const c = fs.constants;
  let fd;
  try {
    fd = fs.openSync(file, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW ?? 0), 0o600);
  } catch (e) {
    return { ok: false, collision: e?.code === 'EEXIST', created: null };
  }
  let created = null;
  try {
    const st = fs.fstatSync(fd);
    created = { dev: st.dev, ino: st.ino };
    let off = 0;
    while (off < bytes.length) {
      const n = fs.writeSync(fd, bytes, off, bytes.length - off, off);
      if (!Number.isSafeInteger(n) || n <= 0) throw new Error('write made no progress');
      off += n;
    }
    fs.fsyncSync(fd);
  } catch {
    try { fs.closeSync(fd); } catch { /* already failing */ }
    return { ok: false, collision: false, created };
  }
  try { fs.closeSync(fd); } catch { return { ok: false, collision: false, created }; }
  let back;
  try { back = readPrivateFile(fs, uid, file, Math.max(bytes.length, 1)); } catch { back = { ok: false }; }
  if (!back.ok || back.dev !== created.dev || back.ino !== created.ino || !Buffer.from(back.bytes).equals(bytes)) return { ok: false, collision: false, created };
  return { ok: true, created };
}
// Unlinks `file` only while it is still the inode this run created.
export function withdrawOwn(fs, file, created) {
  if (!created) return false;
  try {
    const s = fs.lstatSync(file);
    if (s.isFile() && s.dev === created.dev && s.ino === created.ino) { fs.unlinkSync(file); return true; }
  } catch { /* absent */ }
  return false;
}
export function fsyncDir(fs, dir) {
  const c = fs.constants;
  const fd = fs.openSync(dir, c.O_RDONLY | (c.O_DIRECTORY ?? 0) | (c.O_NOFOLLOW ?? 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// ---------------- main ----------------

function defaultDeps() {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  return {
    env: process.env, homedir: os.userInfo().homedir, uid: process.getuid(), execArgv: process.execArgv, version: process.version,
    root, fs: nodeFs,
    verifyManifest: () => verifyCodeManifest({
      root, manifestRel: MANIFEST_REL, fs: nodeFs, tool: 'pilot-backup', requiredRepoFiles: REQUIRED_REPO_FILES,
      packageClosure: PACKAGE_CLOSURE, binaries: [PG_DUMP, PG_RESTORE], resolvePg: () => fileURLToPath(import.meta.resolve('pg')),
    }),
    importMarker: () => import(pathToFileURL(path.join(root, 'scripts', 'database', 'pilot-marker.mjs')).href),
    importShared: async () => {
      const [states, references, rbac] = await Promise.all(Object.values(SHARED_MODULES).map((rel) => import(pathToFileURL(path.join(root, rel)).href)));
      return { states, references, rbac };
    },
    spawn: nodeSpawn, pgRestore: defaultPgRestore, refDigests: REF_DIGESTS,
    forbiddenRoots: [root.replace(/\/$/, ''), '/tmp', '/var/tmp', '/dev/shm', '/run', '/proc', '/sys'],
    statfs: (dir) => nodeFs.statfsSync(dir, { bigint: true }),
    now: () => new Date(), randomHex: (n) => randomBytes(n).toString('hex'), randomUUID,
    toolSha256: () => sha256(nodeFs.readFileSync(fileURLToPath(import.meta.url))),
    timeoutMs: PG_DUMP_TIMEOUT_MS, killGraceMs: 10000, umask: (m) => process.umask(m),
    log: (line) => console.log(line), error: (line) => console.error(line),
  };
}

export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const fs = deps.fs;
  const say = (line) => deps.log(`${PREFIX} ${line}`);
  const end = (result, rc) => { deps.log(`A5B_RESULT=${result}`); return rc; };
  const refuse = (phase, reason, rc) => { deps.error(`${PREFIX} REFUSED: phase=${phase} — ${reason}`); return end('REFUSED', rc); };
  const failErr = (phase, reason, rc = 4) => { deps.error(`${PREFIX} ERROR: phase=${phase} — ${reason}`); return end('ERROR', rc); };

  const args = parseArgs(argv);
  if (!args.ok) return refuse('args', `exactly --target=pilot, one of --dry-run/--execute, one safe absolute --output-dir and --expected-state=${BACKUP_STATES.join('|')} are accepted (arguments not echoed)`, 1);
  const rt = checkRuntime({ env: deps.env, execArgv: deps.execArgv, version: deps.version, expectedKeys: ['HOME', 'LANG', 'PATH'], homedir: deps.homedir });
  if (!rt.ok) return refuse(rt.phase, rt.reason, 3);
  const integrity = deps.verifyManifest();
  if (!integrity?.ok) return refuse('integrity', integrity?.reason ?? 'code manifest verification failed', 3);
  deps.umask?.(0o077);

  let marker;
  try { marker = await deps.importMarker(); } catch { return refuse('integrity', 'pilot-marker.mjs could not be loaded', 3); }
  let shared;
  try {
    shared = await deps.importShared();
    if (typeof shared?.states?.requireState !== 'function' || typeof shared?.rbac?.classifyCatalog !== 'function') throw new Error('shape');
  } catch {
    return refuse('integrity', 'the shared cut-over modules could not be loaded', 3);
  }
  if (!HEX64.test(String(shared.references?.SCHEMA_REFERENCES?.[args.expectedState]?.digest))) {
    return refuse('reference', `no generated app-schema reference for ${args.expectedState} (pilot-schema-references.mjs); nothing started`, 3);
  }

  const cfg = path.join(deps.homedir, '.config');
  const dir = path.join(cfg, 'mona-jacinta');
  const cfgOk = (() => { try { const s = fs.lstatSync(cfg); return s.isDirectory() && !s.isSymbolicLink() && s.uid === deps.uid && (s.mode & 0o022) === 0; } catch { return false; } })();
  if (!cfgOk || !checkPrivateDir(fs, deps.uid, dir)) return refuse('config', 'private configuration directories must be real, owned and private', 3);
  const urlFile = readPrivateFile(fs, deps.uid, path.join(dir, 'pilot-database-url'), MAX_PRIVATE_BYTES);
  if (!urlFile.ok) return refuse('config', urlFile.reason, 3);
  const idFile = readPrivateFile(fs, deps.uid, path.join(dir, 'pilot-marker-id'), MAX_PRIVATE_BYTES);
  if (!idFile.ok) return refuse('config', idFile.reason, 3);
  const markerId = idFile.bytes.toString('utf8').replace(/\n$/, '');
  if (!UUID_V4.test(markerId)) return refuse('config', 'pilot-marker-id must hold one canonical version-4 UUID (value not shown)', 3);
  const keyFile = readPrivateFile(fs, deps.uid, path.join(dir, MAC_KEY_FILE), MAX_PRIVATE_BYTES);
  if (!keyFile.ok) return refuse('config', `${MAC_KEY_FILE}: ${keyFile.reason}`, 3);
  const macKey = parseMacKey(keyFile.bytes);
  if (macKey === null) return refuse('config', `${MAC_KEY_FILE} must hold exactly 64 lowercase hex characters (value not shown)`, 3);
  const url = marker.parsePilotUrl(urlFile.bytes.toString('utf8'));
  if (!url.ok) return refuse('config', 'pilot-database-url must hold one PostgreSQL URL without query/fragment (value not shown)', 3);
  const target = resolveTarget(url.conn, deps.refDigests, marker.deriveProjectRef);
  if (!target.ok) return refuse('target', target.reason, 3);
  say('phase=target ok (PILOT digest matched; identity not shown)');

  const out = args.outputDir;
  if (isUnderAny(out, deps.forbiddenRoots)) return refuse('output', 'the output directory lies inside the repository or temporary/system storage', 3);
  if (!checkNoSymlinkComponents(fs, out) || !checkPrivateDir(fs, deps.uid, out)) return refuse('output', 'the output directory must exist, be real (no symlinked component), owned and mode 0700', 3);
  let free;
  try { const s = deps.statfs(out); free = BigInt(s.bavail) * BigInt(s.bsize); } catch { return refuse('output', 'free space could not be measured', 3); }
  if (free < MIN_FREE_BYTES) return refuse('output', 'less than 2 GiB free in the output directory', 3);

  const names = artifactNames({ now: deps.now(), hex: deps.randomHex(4) });
  const homeName = `.${names.dump}.home`;
  const absent = (n) => { try { fs.lstatSync(path.join(out, n)); return false; } catch (e) { return e?.code === 'ENOENT'; } };
  if (![names.dump, names.manifest, names.temp, homeName].every(absent)) return refuse('publish', 'a backup with this name already exists; nothing overwritten', 5);
  if (args.mode === 'dry-run') { say(`phase=dry-run every gate passed; expected state ${args.expectedState}; no process started`); return end('DRY_RUN_OK', 0); }

  const temp = path.join(out, names.temp);
  const finalDump = path.join(out, names.dump);
  const finalManifest = path.join(out, names.manifest);

  // An empty private HOME for libpq, created exclusively by this run and removed right after pg_dump.
  const childHome = path.join(out, homeName);
  let homeIno;
  try { fs.mkdirSync(childHome, { mode: 0o700 }); const s = fs.lstatSync(childHome); homeIno = { dev: s.dev, ino: s.ino }; } catch {
    return refuse('publish', 'the private libpq home could not be created exclusively', 5);
  }
  const removeHome = () => {
    try {
      const s = fs.lstatSync(childHome);
      if (!s.isDirectory() || s.dev !== homeIno.dev || s.ino !== homeIno.ino) return false;
      fs.rmdirSync(childHome); return true;
    } catch { return false; }
  };

  // The temporary archive is created here, exclusively, and its inode recorded: pg_dump --file truncates and
  // writes this same inode. It is only ever deleted while it is still that inode (a replaced file is left alone).
  let own;
  try {
    const c = fs.constants;
    const tfd = fs.openSync(temp, c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW ?? 0), 0o600);
    try { const st = fs.fstatSync(tfd); own = { dev: st.dev, ino: st.ino }; } finally { fs.closeSync(tfd); }
  } catch {
    removeHome(); return failErr('publish', 'the temporary archive could not be created exclusively');
  }
  const dropOwnTemp = () => {
    try { const s = fs.lstatSync(temp); if (s.isFile() && s.dev === own.dev && s.ino === own.ino) { fs.unlinkSync(temp); return true; } } catch { /* absent */ }
    return false;
  };

  say('phase=dump starting pg_dump (PostgreSQL 17.11, custom format, schemas public + mona_pilot_guard)');
  const child = await runChild(deps.spawn, PG_DUMP, buildPgDumpArgs(temp), {
    env: buildPgDumpEnv(url.conn, { home: childHome, root: deps.root }), timeoutMs: deps.timeoutMs, killGraceMs: deps.killGraceMs, maxStdout: 0,
  });
  const homeRemoved = removeHome();

  if (child.timedOut) { dropOwnTemp(); return failErr('dump', 'pg_dump timed out and was terminated (child output discarded)'); }
  if (child.status !== 0) { dropOwnTemp(); return failErr('dump', 'pg_dump failed (child output discarded)'); }
  const read = readPrivateFile(fs, deps.uid, temp, MAX_ARCHIVE_BYTES);
  if (!read.ok || read.dev !== own.dev || read.ino !== own.ino) {
    dropOwnTemp(); return failErr('verify', `the dump is not this run's private regular file: ${read.ok ? 'inode replaced' : read.reason}`);
  }
  if (!homeRemoved) { dropOwnTemp(); return failErr('dump', 'the private libpq home was changed or is not empty; nothing published'); }

  const v = await verifyArchiveBytes({ bytes: read.bytes, pgRestore: deps.pgRestore, markerId, expectedState: args.expectedState, shared });
  if (!v.ok) { dropOwnTemp(); return v.identity ? (deps.error(`${PREFIX} REFUSED: phase=identity — ${v.reason} (ids not shown)`), end('REFUSED', 2)) : failErr('verify', v.reason); }
  const createdAt = deps.now().toISOString();
  if (!withinArchiveWindow(createdAt, v.archiveCreatedAt)) { dropOwnTemp(); return failErr('verify', 'the archive creation time is not consistent with now (clock or archive mismatch)'); }
  if (!dropOwnTemp()) return failErr('publish', 'the temporary archive was replaced before cleanup; nothing published, nothing deleted');
  const archiveSha = sha256(read.bytes);

  // =====================================================================================
  // ATOMIC PUBLICATION PROTOCOL (P1-2 fix)
  // Publishes the dump and manifest as a single atomic set using a transaction marker file.
  // Protocol:
  // 1. Write both artifacts to temporary names (.partial suffix)
  // 2. fsync both files and output directory
  // 3. Create a commit marker file (.commit-<setid>) recording both final names and expected hashes
  // 4. fsync commit marker and output directory
  // 5. Link temp dump -> final dump, unlink temp dump
  // 6. Link temp manifest -> final manifest, unlink temp manifest
  // 7. fsync output directory
  // 8. Remove commit marker
  // 9. fsync output directory
  //
  // On any failure after commit marker creation: withdrawCommitted() removes any final files
  // that were linked (by inode), then removes the commit marker.
  // A backup set is complete iff both final files exist AND no commit marker exists for that set.
  // =====================================================================================

  // The manifest body (restored: the reviewed R2 definition was lost in the unreviewed P1-2 rewrite,
  // leaving `fields` undefined at publication — every real --execute would have crashed here).
  const fields = {
    setId: deps.randomUUID(), createdAt, toolSha256: deps.toolSha256(), pgDumpVersion: v.pgDumpVersion,
    serverVersion: v.serverVersion, archive: { file: names.dump, bytes: read.bytes.length, sha256: archiveSha }, tocSha256: v.tocSha256,
    schemas: v.schemas, tables: v.tables, refDigest: target.refDigest, markerIdDigest: markerDigest(markerId), ledgerState: v.ledgerState,
    rbacCatalog: v.rbacCatalog, schemaReferenceDigest: v.schemaReferenceDigest,
  };
  const setId = fields.setId; // Use the manifest's setId as the publication set identifier
  const tempDump = path.join(out, `.${names.dump}.partial`);
  const tempManifest = path.join(out, `.${names.manifest}.partial`);
  const commitMarker = path.join(out, `.commit-${setId}`);

  // Write archive to temp name
  const a = publishExclusive(fs, deps.uid, tempDump, read.bytes);
  if (!a.ok) {
    withdrawOwn(fs, tempDump, a.created);
    return a.collision ? refuse('publish', 'the temporary archive name was taken; nothing overwritten', 5) : failErr('publish', 'the archive could not be written durably; withdrawn');
  }

  // Write manifest to temp name
  const manifestBytes = Buffer.from(buildDumpManifest({ ...fields, mac: computeManifestMac(macKey, fields) }), 'utf8');
  const mm = publishExclusive(fs, deps.uid, tempManifest, manifestBytes);
  if (!mm.ok) {
    withdrawOwn(fs, tempManifest, mm.created); withdrawOwn(fs, tempDump, a.created);
    return mm.collision ? refuse('publish', 'the temporary manifest name was taken; nothing overwritten, temp archive withdrawn', 5) : failErr('publish', 'the manifest could not be written durably; both temp files withdrawn');
  }

  // Fsync both temp files and directory
  try { fsyncDir(fs, out); } catch {
    withdrawOwn(fs, tempManifest, mm.created); withdrawOwn(fs, tempDump, a.created);
    return failErr('publish', 'the output directory could not be synced; both temp files withdrawn');
  }

  // Create commit marker with publication intent
  const commitData = {
    setId,
    dump: { finalName: names.dump, expectedSha256: archiveSha },
    manifest: { finalName: names.manifest, expectedSha256: sha256(manifestBytes) },
    createdAt: deps.now().toISOString(),
  };
  const commitBytes = Buffer.from(`${canonicalJson(commitData)}\n`, 'utf8');
  const cm = publishExclusive(fs, deps.uid, commitMarker, commitBytes);
  if (!cm.ok) {
    withdrawOwn(fs, commitMarker, cm.created); withdrawOwn(fs, tempManifest, mm.created); withdrawOwn(fs, tempDump, a.created);
    return cm.collision ? refuse('publish', 'the commit marker name was taken; nothing overwritten, temp files withdrawn', 5) : failErr('publish', 'the commit marker could not be written; temp files withdrawn');
  }

  // Fsync commit marker and directory
  try { fsyncDir(fs, out); } catch {
    withdrawOwn(fs, commitMarker, cm.created); withdrawOwn(fs, tempManifest, mm.created); withdrawOwn(fs, tempDump, a.created);
    return failErr('publish', 'the output directory could not be synced after commit marker; all temp files withdrawn');
  }

  // Track committed final files by inode for withdrawal on failure
  const committed = { dump: false, manifest: false };
  let dumpFinalIno = null;
  let manifestFinalIno = null;

  const withdrawCommitted = () => {
    if (committed.dump && dumpFinalIno) {
      try {
        const s = fs.lstatSync(finalDump);
        if (s.isFile() && s.dev === dumpFinalIno.dev && s.ino === dumpFinalIno.ino) fs.unlinkSync(finalDump);
      } catch { /* already gone */ }
    }
    if (committed.manifest && manifestFinalIno) {
      try {
        const s = fs.lstatSync(finalManifest);
        if (s.isFile() && s.dev === manifestFinalIno.dev && s.ino === manifestFinalIno.ino) fs.unlinkSync(finalManifest);
      } catch { /* already gone */ }
    }
    // Also remove commit marker if we created it
    try {
      const s = fs.lstatSync(commitMarker);
      if (s.isFile() && s.dev === cm.created.dev && s.ino === cm.created.ino) fs.unlinkSync(commitMarker);
    } catch { /* already gone */ }
  };

  // Atomic commit: link temp -> final for dump
  try {
    fs.linkSync(tempDump, finalDump);
    try {
      const s = fs.lstatSync(finalDump);
      dumpFinalIno = { dev: s.dev, ino: s.ino };
      committed.dump = true;
      fs.unlinkSync(tempDump);
    } catch (e) {
      withdrawCommitted();
      throw e;
    }
  } catch (e) {
    if (e.code === 'EEXIST') {
      withdrawOwn(fs, commitMarker, cm.created); withdrawOwn(fs, tempManifest, mm.created); withdrawOwn(fs, tempDump, a.created);
      return refuse('publish', 'the final archive name was taken; nothing overwritten', 5);
    }
    withdrawOwn(fs, commitMarker, cm.created); withdrawOwn(fs, tempManifest, mm.created); withdrawOwn(fs, tempDump, a.created);
    return failErr('publish', 'the archive could not be committed; all temp files withdrawn');
  }

  // Atomic commit: link temp -> final for manifest
  try {
    fs.linkSync(tempManifest, finalManifest);
    try {
      const s = fs.lstatSync(finalManifest);
      manifestFinalIno = { dev: s.dev, ino: s.ino };
      committed.manifest = true;
      fs.unlinkSync(tempManifest);
    } catch (e) {
      withdrawCommitted();
      throw e;
    }
  } catch (e) {
    if (e.code === 'EEXIST') {
      withdrawCommitted();
      withdrawOwn(fs, tempManifest, mm.created); withdrawOwn(fs, tempDump, a.created);
      return refuse('publish', 'the final manifest name was taken; nothing overwritten, archive withdrawn', 5);
    }
    withdrawCommitted();
    withdrawOwn(fs, tempManifest, mm.created); withdrawOwn(fs, tempDump, a.created);
    return failErr('publish', 'the manifest could not be committed; archive withdrawn');
  }

  // Final directory fsync to make links durable
  try { fsyncDir(fs, out); } catch {
    withdrawCommitted();
    return failErr('publish', 'the output directory could not be synced after commit; backup set may be incomplete');
  }

  // Remove the commit marker. Publication completes ONLY when the marker is
  // provably gone with THIS run's identity preserved until the unlink
  // (G11-ADV-005: the old code swallowed every removal failure, letting a broken
  // set read as publishable while the completeness rule — both finals AND no
  // marker — was actually false). On any failure the evidence is kept and the
  // run reports ERROR; the set is simply never VERIFIED.
  try {
    const s = fs.lstatSync(commitMarker);
    if (!(s.isFile() && s.dev === cm.created.dev && s.ino === cm.created.ino)) {
      return failErr('publish', 'the commit marker was replaced before its removal; the backup set is not published — all evidence kept');
    }
    fs.unlinkSync(commitMarker);
  } catch {
    return failErr('publish', 'the commit marker could not be removed; the backup set is not published — all evidence kept');
  }
  // Prove the absence after the unlink: a swapped-in replacement or a permission
  // surprise stops here instead of silently publishing an incoherent set.
  try {
    const after = fs.lstatSync(commitMarker);
    if (after.isFile() && after.dev === cm.created.dev && after.ino === cm.created.ino) {
      return failErr('publish', 'the commit marker is still present after its removal; the backup set is not published — all evidence kept');
    }
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      return failErr('publish', 'the absence of the commit marker could not be re-verified; the backup set is not published — all evidence kept');
    }
  }

  // Final fsync after marker removal is REQUIRED durability, not a warning
  // (G11-ADV-005: the old downgrade could return VERIFIED while the marker removal
  // was not actually durable). Failure → ERROR with the evidence kept.
  try { fsyncDir(fs, out); } catch {
    return failErr('publish', 'the output directory could not be synced after the commit marker removal; the backup set is not durably published — all evidence kept');
  }

  // Post-publish re-verification (G11-ADV-005): the published finals must still be
  // this run's exact inodes carrying exactly the verified bytes. Anything else — a
  // replaced inode, a truncated or edited file — fails closed with the evidence kept.
  const reverifyFinal = (finalPath, ino, expectedBytes) => {
    try {
      const s = fs.lstatSync(finalPath);
      if (!s.isFile() || s.dev !== ino.dev || s.ino !== ino.ino || s.size !== expectedBytes.length) return false;
      return sha256(fs.readFileSync(finalPath)) === sha256(expectedBytes);
    } catch { return false; }
  };
  if (!reverifyFinal(finalDump, dumpFinalIno, read.bytes) || !reverifyFinal(finalManifest, manifestFinalIno, manifestBytes)) {
    return failErr('publish', 'a published final (archive or manifest) did not re-verify against the bytes this run produced; the backup set is not published — all evidence kept');
  }

  const totalRows = Object.values(v.tables).reduce((s, t) => s + t.rows, 0);
  say(`phase=publish archive=${names.dump} bytes=${read.bytes.length} sha256=${archiveSha}`);
  say(`phase=publish manifest=${names.manifest} tables=${v.publicTables.length} rows=${totalRows} ledger=${v.ledgerState} toc=${v.tocSha256.slice(0, 12)}`);
  return end('VERIFIED', 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; }, () => { console.log('A5B_RESULT=ERROR'); process.exitCode = 4; });
}
