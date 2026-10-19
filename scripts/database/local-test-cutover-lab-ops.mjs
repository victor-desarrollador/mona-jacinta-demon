// LOCAL_TEST cut-over lab — operations. Loaded ONLY by local-test-cutover-lab.mjs stage 3, after
// it proved the network isolation; every exported operation proves it again (createLabContext)
// so an import from elsewhere cannot reach a cluster outside the namespace. No entry point.
//
// Cluster recipe (the audited CASH-1 / R3 PG-gate recipe, now in one place): initdb with
// --auth-local=peer --auth-host=reject under the lab root, listen 127.0.0.1:5432 plus a private
// 0700 socket dir, one scram-sha-256 hba line for mona_local_test@127.0.0.1/32, a NOSUPERUSER
// role mona_local_test owning database mona_local_test, the canonical LOCAL_TEST marker
// installed by local-test-marker.mjs, and the expected system_identifier read by pg_controldata
// from the data directory the lab just initialized. One cluster runs at a time (127.0.0.1:5432).
// Secrets (the random role password) live only in memory and in a 0600 passfile inside the run
// directory, removed when the run ends; they are never printed, never in an argv.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  buildLabPlan, canonicalJson, checkLabRoot, childEnv, createGate, evaluateFresh, evaluateIdentity, LOCAL_TEST, localTestUrl,
  parseControlData, proveIsolation, RUN_ID, stageStatePayload,
} from './local-test-cutover-lab-core.mjs';
import { CONFIRM_LOCAL_TARGET, main as markerMain, MARKER_FACTS_SQL, MARKER_ROWS_SQL, verifyMarkerStructure } from './local-test-marker.mjs';
import { LEDGER_SQL, MIGRATION_PINS, requireState, STATES } from './pilot-migration-states.mjs';
import { PINNED_SEARCH_PATH, projectionDigest, projectionSummary, readProjection, runProbes } from './app-schema-projection.mjs';
import { SCHEMA_REFERENCES, STATE_PROBES } from './pilot-schema-references.mjs';
import { CATALOG_35, CATALOG_36, CATALOG_SQL, classifyCatalog } from './pilot-rbac-catalog.mjs';
import { PRISMA_ARGS, resolvePrismaCli, verifyMigrationPayload } from './pilot-migrate.mjs';
import { upgradeCatalogInTransaction, UPGRADE_SQL } from './pilot-rbac-catalog-upgrade.mjs';
import { checkInvariants, CLONE_SQL, fingerprintRows, HARD_INVARIANTS, INFO_INVARIANTS } from './pilot-clone-restore.mjs';
import { main as referenceMain } from './pilot-schema-reference.mjs';

const PREFIX = '[db:local-test-cutover-lab]';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const API_DIR = path.join(REPO, 'api');
const BIN = '/usr/lib/postgresql/17/bin';
export const LAB_CONFIG = 'prisma.local-test-lab.config.ts';
export const REHEARSAL_CONFIG = 'prisma.local-test.config.ts';
// pilot-migrate's exact Prisma command; only the --config value differs (PILOT's config pins Supabase TLS).
export const REHEARSAL_PRISMA_ARGS = Object.freeze([...PRISMA_ARGS.slice(0, -1), REHEARSAL_CONFIG]);
export const LAB_PRISMA_ARGS = Object.freeze([...PRISMA_ARGS.slice(0, -1), LAB_CONFIG]);
const T = { initdb: 120000, ctl: 90000, prisma: 600000, dump: 600000 };

export function labRoot(home) { return path.join(home, '.local', 'share', 'mona-jacinta', 'cutover-lab'); }

// ---------------- context ----------------
export function createLabContext({ home, log, error, execPath }) {
  const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
  const iso = proveIsolation({ netDev: read('/proc/self/net/dev'), route: read('/proc/self/net/route'), ipv6Route: read('/proc/self/net/ipv6_route') ?? '', uid: process.getuid() });
  if (!iso.ok) throw new Error(`LOCAL_TEST_IDENTITY_NOT_PROVEN: ${iso.reason}`);
  const root = labRoot(home);
  if (!fs.existsSync(root)) { fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 }); fs.mkdirSync(root, { mode: 0o700 }); }
  const rc = checkLabRoot(root, { forbiddenRoots: [REPO, '/tmp', '/var/tmp', '/dev/shm', '/run', '/proc', '/sys'] });
  if (!rc.ok) throw new Error(`lab root refused: ${rc.reason}`);
  return { home, log, error, execPath, root, osUser: os.userInfo().username, say: (l) => log(`${PREFIX} ${l}`) };
}
function newRun(ctx, label) {
  const now = new Date().toISOString().replace(/[-:]/g, '').replace(/\.[0-9]+Z$/, 'Z');
  const id = `lab-${now}-${randomBytes(4).toString('hex')}`;
  if (!RUN_ID.test(id)) throw new Error('run id');
  const dir = path.join(ctx.root, id);
  fs.mkdirSync(dir, { mode: 0o700 });
  for (const d of ['home', 'tmp', 'stage', 'evidence']) fs.mkdirSync(path.join(dir, d), { mode: 0o700 });
  ctx.say(`run ${id} (${label})`);
  return { id, dir, evidence: {}, clusters: [] };
}
function writeEvidence(run) {
  fs.writeFileSync(path.join(run.dir, 'evidence', 'evidence.json'), `${JSON.stringify(run.evidence, null, 2)}\n`, { mode: 0o600 });
}

// ---------------- children ----------------
function runChild(file, args, { env, cwd, logFile, timeoutMs, input = null }) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(file, args, { env, cwd, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'], shell: false }); } catch { resolve({ ok: false, code: null }); return; }
    const out = fs.openSync(logFile, 'a', 0o600);
    const write = (b) => { try { fs.writeSync(out, b); } catch { /* best effort */ } };
    child.stdout.on('data', write); child.stderr.on('data', write);
    if (input !== null) child.stdin.end(input);
    const timer = setTimeout(() => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); }, timeoutMs);
    child.on('error', () => {});
    child.on('close', (code, signal) => { clearTimeout(timer); fs.closeSync(out); resolve({ ok: code === 0 && signal === null, code, signal }); });
  });
}

// ---------------- cluster ----------------
class Cluster {
  constructor(ctx, run, name) {
    this.ctx = ctx; this.run = run; this.name = name;
    this.dir = path.join(run.dir, name);
    this.pgdata = path.join(this.dir, 'pgdata'); this.logDir = path.join(this.dir, 'log');
    // Private socket dir in a short, fixed place so the Unix socket path never depends on the run directory depth.
    this.sock = path.join(ctx.root, 'k', randomBytes(6).toString('hex'));
    this.password = randomBytes(32).toString('hex');
    this.markerId = randomUUID();
    this.url = localTestUrl(this.password);
    this.passfile = path.join(this.dir, 'pgpass');
    this.systemIdentifier = null; this.running = false;
    if (`${this.sock}/.s.PGSQL.5432`.length > 107) throw new Error('the cluster socket path would exceed the 107-byte Unix socket limit; use a shorter lab root');
    run.clusters.push(this);
  }
  env(extra = {}) { return childEnv({ home: path.join(this.run.dir, 'home'), tmpdir: path.join(this.run.dir, 'tmp'), extra }); }
  log(name) { return path.join(this.logDir, `${name}.log`); }
  async create() {
    fs.mkdirSync(this.dir, { mode: 0o700 });
    fs.mkdirSync(path.join(this.ctx.root, 'k'), { recursive: true, mode: 0o700 }); fs.chmodSync(path.join(this.ctx.root, 'k'), 0o700);
    for (const d of [this.sock, this.logDir]) fs.mkdirSync(d, { mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, 'socket-dir'), `${this.sock}\n`, { mode: 0o600 });
    const init = await runChild(`${BIN}/initdb`, [`--pgdata=${this.pgdata}`, `--username=${this.ctx.osUser}`, '--auth-local=peer', '--auth-host=reject',
      '--encoding=UTF8', '--locale=C.UTF-8', '--no-instructions'], { env: this.env(), logFile: this.log('initdb'), timeoutMs: T.initdb });
    if (!init.ok) throw new Error(`initdb failed (${this.name}; see its log)`);
    const control = await new Promise((resolve) => {
      let text = ''; const c = spawn(`${BIN}/pg_controldata`, [this.pgdata], { env: this.env(), stdio: ['ignore', 'pipe', 'ignore'], shell: false });
      c.stdout.on('data', (b) => { text += b; }); c.on('close', (code) => resolve(code === 0 ? text : ''));
      c.on('error', () => resolve(''));
    });
    this.systemIdentifier = parseControlData(control);
    if (!this.systemIdentifier) throw new Error('pg_controldata did not report a system identifier');
    const hba = path.join(this.pgdata, 'pg_hba.conf');
    fs.writeFileSync(hba, `host mona_local_test mona_local_test 127.0.0.1/32 scram-sha-256\n${fs.readFileSync(hba, 'utf8')}`);
    fs.appendFileSync(path.join(this.pgdata, 'postgresql.conf'), ['', '# local-test-cutover-lab (disposable, loopback + private socket only)',
      "listen_addresses = '127.0.0.1'", 'port = 5432', `unix_socket_directories = '${this.sock}'`, 'unix_socket_permissions = 0700',
      "password_encryption = 'scram-sha-256'", "timezone = 'UTC'", 'fsync = off', 'synchronous_commit = off', 'full_page_writes = off', ''].join('\n'));
    fs.writeFileSync(this.passfile, `127.0.0.1:5432:mona_local_test:mona_local_test:${this.password}\n`, { mode: 0o600 });
    await this.start();
    const admin = await this.admin('postgres');
    try {
      const id = (await admin.query("SELECT current_setting('data_directory') AS d, current_setting('server_version_num') AS v, current_setting('listen_addresses') AS l, (SELECT system_identifier::text FROM pg_control_system()) AS s")).rows[0];
      if (id.d !== fs.realpathSync(this.pgdata) || !/^17[0-9]{4}$/.test(id.v) || id.l !== '127.0.0.1' || id.s !== this.systemIdentifier) throw new Error('the started server is not the cluster the lab initialized');
      await admin.query("SET log_statement = 'none'");
      await admin.query(`CREATE ROLE mona_local_test WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '${this.password}'`);
      await admin.query("CREATE DATABASE mona_local_test OWNER mona_local_test TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C.UTF-8'");
    } finally { await admin.end(); }
    const lines = [];
    const rc = await markerMain(['--execute', `--marker-id=${this.markerId}`, `--confirm-local-target=${CONFIRM_LOCAL_TARGET}`],
      { env: { LOCAL_TEST_DATABASE_URL: this.url, LOCAL_TEST_DATABASE_MARKER_ID: this.markerId }, log: (l) => lines.push(l), error: (l) => lines.push(l), endTimeoutMs: 5000,
        createClient: (conn) => { const k = new pg.Client({ ...conn, ssl: false, connectionTimeoutMillis: 10000, query_timeout: 20000 }); k.on('error', () => {}); return k; } });
    if (rc !== 0) throw new Error(`the LOCAL_TEST marker could not be installed: ${(lines.find((l) => l.includes('FAIL')) ?? '').split(this.password).join('«redacted»')}`);
    const id = await this.proveIdentity();
    if (!id.ok) throw new Error(`LOCAL_TEST_IDENTITY_NOT_PROVEN: ${id.reason}`);
    this.ctx.say(`${this.name}: created (PostgreSQL 17, 127.0.0.1:5432 + private socket, marker installed, system_identifier ${this.systemIdentifier})`);
  }
  async start() {
    const r = await runChild(`${BIN}/pg_ctl`, ['start', `--pgdata=${this.pgdata}`, '--wait', '--timeout=60', `--log=${this.log('postgresql')}`, '--silent'],
      { env: this.env(), logFile: this.log('pg_ctl'), timeoutMs: T.ctl });
    if (!r.ok) throw new Error(`pg_ctl start failed (${this.name})`);
    this.running = true;
  }
  async stop() {
    if (!this.running) { fs.rmSync(this.passfile, { force: true }); fs.rmSync(this.sock, { recursive: true, force: true }); return true; }
    const r = await runChild(`${BIN}/pg_ctl`, ['stop', `--pgdata=${this.pgdata}`, '--mode=fast', '--wait', '--timeout=60', '--silent'],
      { env: this.env(), logFile: this.log('pg_ctl'), timeoutMs: T.ctl });
    const gone = !fs.existsSync(path.join(this.pgdata, 'postmaster.pid'));
    this.running = !(r.ok && gone);
    if (!this.running) { fs.rmSync(this.passfile, { force: true }); fs.rmSync(this.sock, { recursive: true, force: true }); }
    return !this.running;
  }
  async admin(database) {
    const c = new pg.Client({ host: this.sock, port: 5432, user: this.ctx.osUser, database, application_name: 'mona-cutover-lab-admin', connectionTimeoutMillis: 10000 });
    await c.connect(); return c;
  }
  // TCP as mona_local_test, exactly the canonical target (never a URL from the shell). raw: every value as server text.
  async client({ raw = false } = {}) {
    const c = new pg.Client({ ...LOCAL_TEST, password: this.password, application_name: 'mona-cutover-lab', connectionTimeoutMillis: 10000, query_timeout: 600000,
      ...(raw ? { types: { getTypeParser: () => (v) => v } } : {}) });
    await c.connect(); return c;
  }
  async proveIdentity() {
    let c;
    try {
      c = await this.client();
      await c.query(`SET search_path = ${PINNED_SEARCH_PATH}`);
      const r = (await c.query(`SELECT current_database() AS db, current_user AS usr, (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS owner,
        current_setting('server_version_num') AS v, host(inet_server_addr()) AS addr, inet_server_port() AS port, current_setting('listen_addresses') AS listen,
        (SELECT system_identifier::text FROM pg_control_system()) AS sid, to_regnamespace('mona_test_guard') IS NOT NULL AS tg, to_regnamespace('mona_pilot_guard') IS NOT NULL AS pg_,
        to_regclass('mona_local_test_guard.database_identity') IS NOT NULL AS marker_table`)).rows[0];
      const markerRows = r.marker_table ? (await c.query(MARKER_ROWS_SQL)).rows : [];
      const facts = r.marker_table ? (await c.query(MARKER_FACTS_SQL)).rows[0]?.facts : null;
      return evaluateIdentity({ currentDatabase: r.db, currentUser: r.usr, databaseOwner: r.owner, serverVersionNum: r.v, serverAddr: r.addr, serverPort: r.port,
        listenAddresses: r.listen, systemIdentifier: r.sid, testGuard: r.tg, pilotGuard: r.pg_, markerRows, markerStructureOk: facts ? verifyMarkerStructure(facts) === null : false },
      { systemIdentifier: this.systemIdentifier, markerId: this.markerId });
    } catch {
      return { ok: false, reason: 'the identity facts could not be read' };
    } finally { await c?.end().catch(() => {}); }
  }
  async proveState(state) {
    let c;
    try {
      c = await this.client();
      await c.query(`SET search_path = ${PINNED_SEARCH_PATH}`);
      if (state === 'FRESH') {
        const r = (await c.query(`SELECT (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public') AS rels,
          to_regclass('public._prisma_migrations') IS NOT NULL AS ledger,
          (SELECT array_agg(nspname::text ORDER BY nspname::text) FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema') AS schemas`)).rows[0];
        return evaluateFresh({ publicRelations: r.rels, ledgerExists: r.ledger, schemas: r.schemas });
      }
      return requireState((await c.query(LEDGER_SQL)).rows, state);
    } catch {
      return { ok: false, reason: 'the state facts could not be read' };
    } finally { await c?.end().catch(() => {}); }
  }
  gate() { return createGate({ proveIdentity: () => this.proveIdentity(), proveState: (s) => this.proveState(s) }); }
}

// ---------------- prisma ----------------
async function runPrisma(ctx, cluster, { args, extra = {} }) {
  const prisma = resolvePrismaCli(API_DIR);
  if (!prisma.ok) throw new Error(`prisma: ${prisma.reason}`);
  const env = childEnv({ home: path.join(cluster.run.dir, 'home'), tmpdir: path.join(cluster.run.dir, 'tmp'), path: `${path.dirname(ctx.execPath)}:/usr/bin:/bin`,
    extra: { LOCAL_TEST_DATABASE_URL: cluster.url, NODE_ENV: 'production', CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1', ...extra } });
  const r = await runChild(ctx.execPath, [prisma.script, ...args], { env, cwd: prisma.cwd, logFile: cluster.log('prisma'), timeoutMs: T.prisma });
  redactFile(cluster.log('prisma'), cluster.password);
  return { ...r, prisma };
}
function redactFile(file, secret) {
  try { const t = fs.readFileSync(file, 'utf8'); if (t.includes(secret)) fs.writeFileSync(file, t.split(secret).join('«redacted»')); } catch { /* absent */ }
}

// FRESH → exactly the state's migrations (staged byte-verified copy) → identity + exact state.
async function provisionState(ctx, run, cluster, state) {
  await cluster.create();
  const stage = stageStatePayload(API_DIR, state, path.join(run.dir, 'stage'));
  if (!stage.ok) throw new Error(`staging: ${stage.reason}`);
  try {
    const res = await cluster.gate().run('provision', { state: 'FRESH' }, async () => {
      const id = await cluster.proveIdentity();
      if (!id.ok) throw new Error(`LOCAL_TEST_IDENTITY_NOT_PROVEN before migrate: ${id.reason}`);
      return runPrisma(ctx, cluster, { args: LAB_PRISMA_ARGS, extra: { LOCAL_TEST_LAB_MIGRATIONS_DIR: stage.migrationsDir } });
    });
    if (!res.ok) throw new Error(`prisma migrate (${state}) failed; see ${cluster.name}/log/prisma.log`);
  } finally { stage.cleanup(); }
  const id = await cluster.proveIdentity();
  if (!id.ok) throw new Error(`LOCAL_TEST_IDENTITY_NOT_PROVEN after provision: ${id.reason}`);
  const st = await cluster.proveState(state);
  if (!st.ok) throw new Error(`EXACT_STATE_NOT_PROVEN after provision: ${st.reason}`);
  ctx.say(`${cluster.name}: ${state} provisioned FRESH with exactly ${STATES[state].length} migrations (ledger exact, pinned checksums)`);
}

// ---------------- deterministic fixture ----------------
// Columns of migrations 1–4 only (valid in every state); ids and values fixed. The catalog is the
// state's pinned RBAC catalog (CATALOG_35 before the cut-over, CATALOG_36 at G11).
export function fixtureStatements(state) {
  const cat = state === 'EXACT_G11' ? CATALOG_36 : CATALOG_35;
  const roleId = new Map(cat.roles.map(([c, id]) => [c, id])); const permId = new Map(cat.permissions.map(([c, id]) => [c, id]));
  const ts = "'2026-10-01 12:00:00+00'";
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  return [
    `INSERT INTO "Role" (id, code, name) VALUES ${cat.roles.map(([c, id]) => `(${q(id)}, ${q(c)}, ${q(`Rol ${c}`)})`).join(', ')}`,
    `INSERT INTO "Permission" (id, code) VALUES ${cat.permissions.map(([c, id]) => `(${q(id)}, ${q(c)})`).join(', ')}`,
    `INSERT INTO "RolePermission" ("roleId", "permissionId") VALUES ${cat.grants.map(([r, p]) => `(${q(roleId.get(r))}, ${q(permId.get(p))})`).join(', ')}`,
    `INSERT INTO "Company" (id, name, cuit, address) VALUES ('co-1', 'Mona Jacinta Lab', '20-11111111-1', 'Calle Falsa 123')`,
    `INSERT INTO "Branch" (id, name, code, address, "pointOfSaleNumber") VALUES ('br-1', 'Local 1', 'L1', 'Calle Falsa 123', 1)`,
    `INSERT INTO "Location" (id, "companyId", name, code, type, address, "pointOfSaleNumber") VALUES ('br-1', 'co-1', 'Local 1', 'L1', 'RETAIL_BRANCH', 'Calle Falsa 123', 1)`,
    `INSERT INTO "User" (id, name, email, "passwordHash", "updatedAt") VALUES ('us-1', 'Cajera Lab', 'cajera@lab.invalid', 'x', ${ts}), ('us-2', 'Dueña Lab', 'owner@lab.invalid', 'x', ${ts})`,
    `INSERT INTO "UserBranchRole" (id, "userId", "branchId", "roleId") VALUES ('ubr-1', 'us-1', 'br-1', ${q(roleId.get('CASHIER'))})`,
    `INSERT INTO "Category" (id, name) VALUES ('cat-1', 'Remeras')`,
    `INSERT INTO "Brand" (id, name) VALUES ('brd-1', 'Mona')`,
    `INSERT INTO "Product" (id, name, slug, "categoryId", "brandId") VALUES ('pr-1', 'Remera básica', 'remera-basica', 'cat-1', 'brd-1')`,
    `INSERT INTO "ProductVariant" (id, "productId", sku, barcode, price, "costPrice") VALUES ('pv-1', 'pr-1', 'REM-M', '7790000000011', 150000, 80000), ('pv-2', 'pr-1', 'REM-L', '7790000000028', 160000, 85000)`,
    `INSERT INTO "Inventory" (id, "variantId", "branchId") VALUES ('inv-1', 'pv-1', 'br-1'), ('inv-2', 'pv-2', 'br-1')`,
    `INSERT INTO "CashRegister" (id, "branchId", name) VALUES ('cr-1', 'br-1', 'Caja 1')`,
    `INSERT INTO "CashSession" (id, "registerId", "openedById", "openedAt", "closedById", "closedAt", "startingCash", status) VALUES ('cs-1', 'cr-1', 'us-1', ${ts}, 'us-1', '2026-10-01 20:00:00+00', 50000, 'CLOSED')`,
    `INSERT INTO "Sale" (id, "saleNumber", "branchId", "sellerId", status, subtotal, "discountTotal", total, "updatedAt") VALUES ('sa-1', 'L1-000001', 'br-1', 'us-1', 'PAID', 310000, 0, 310000, ${ts}), ('sa-2', 'L1-000002', 'br-1', 'us-1', 'PAID', 150000, 0, 150000, ${ts})`,
    `INSERT INTO "SaleItem" (id, "saleId", "variantId", "productId", "productName", "variantName", sku, quantity, "unitPrice", subtotal) VALUES
      ('si-1', 'sa-1', 'pv-1', 'pr-1', 'Remera básica', 'M', 'REM-M', 1, 150000, 150000), ('si-2', 'sa-1', 'pv-2', 'pr-1', 'Remera básica', 'L', 'REM-L', 1, 160000, 160000),
      ('si-3', 'sa-2', 'pv-1', 'pr-1', 'Remera básica', 'M', 'REM-M', 1, 150000, 150000)`,
    `INSERT INTO "SalePayment" (id, "saleId", method, amount, "receivedAmount", "changeAmount", "cashSessionId", "idempotencyKey") VALUES
      ('sp-1', 'sa-1', 'CASH', 310000, 320000, 10000, 'cs-1', 'idem-sp-1'), ('sp-2', 'sa-2', 'TRANSFER', 150000, NULL, NULL, NULL, 'idem-sp-2')`,
    `INSERT INTO "CashMovement" (id, "sessionId", type, amount, "salePaymentId", "userId") VALUES ('cm-1', 'cs-1', 'OPENING', 50000, NULL, 'us-1'), ('cm-2', 'cs-1', 'SALE_INCOME', 310000, 'sp-1', 'us-1')`,
    `INSERT INTO "AuditLog" (id, "userId", "branchId", action, "entityType", "entityId") VALUES ('al-1', 'us-1', 'br-1', 'SALE_PAID', 'Sale', 'sa-1')`,
  ];
}
async function seed(ctx, cluster, state) {
  await cluster.gate().run('seed', { state }, async () => {
    const c = await cluster.client();
    try {
      await c.query('BEGIN');
      for (const s of fixtureStatements(state)) await c.query(s);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw new Error(`fixture seed failed: ${String(e?.message ?? '').slice(0, 200)}`); } finally { await c.end(); }
  });
  ctx.say(`${cluster.name}: deterministic fixture seeded (${fixtureStatements(state).length} statements, catalog ${state === 'EXACT_G11' ? 'CATALOG_36' : 'CATALOG_35'})`);
}

// ---------------- measurements ----------------
// Everything a proof compares. `columnsOf` (optional) restricts row fingerprints to a given column
// set per table (the rehearsal's "columns that existed before the migration").
async function measure(cluster, state, { columnsOf = null } = {}) {
  const c = await cluster.client(); const raw = await cluster.client({ raw: true });
  try {
    await c.query(`SET search_path = ${PINNED_SEARCH_PATH}`); await raw.query(`SET search_path = ${PINNED_SEARCH_PATH}`); await raw.query(CLONE_SQL.pinTimeZone);
    const ledger = requireState((await c.query(LEDGER_SQL)).rows, state);
    const projection = await readProjection(c);
    const digest = projectionDigest(projection);
    const probesFailed = runProbes(projection, STATE_PROBES[state]);
    const unvalidated = projection.constraints.filter((x) => x.validated !== true).map((x) => `${x.table}.${x.name}`);
    const invalidIndexes = projection.indexes.filter((x) => x.valid !== true).map((x) => `${x.table}.${x.name}`);
    const cat = {}; for (const k of ['roles', 'permissions', 'grants']) cat[k] = (await c.query(CATALOG_SQL[k])).rows;
    const rbac = classifyCatalog(cat);
    const invariants = checkInvariants((await raw.query(CLONE_SQL.invariants)).rows[0]);
    const tables = [...projection.tables.map((t) => t.name), '_prisma_migrations'].sort();
    const counts = {}; const fingerprints = {};
    for (const t of tables) {
      counts[t] = Number((await raw.query(CLONE_SQL.count(t))).rows[0].n);
      const cols = columnsOf?.[t];
      if (columnsOf && !cols) continue;
      const sql = cols ? `SELECT ${cols.map((x) => `"${x.replace(/"/g, '""')}"`).join(', ')} FROM ONLY public."${t}"` : CLONE_SQL.rows(t);
      fingerprints[t] = fingerprintRows((await raw.query({ text: sql, rowMode: 'array' })).rows);
    }
    const columns = Object.fromEntries(projection.tables.map((t) => [t.name, t.columns.map((x) => x.name)]));
    columns._prisma_migrations = null;
    return { ledger, digest, projection, summary: projectionSummary(projection), probesFailed, unvalidated, invalidIndexes, rbac, invariants, counts, fingerprints, columns };
  } finally { await c.end(); await raw.end(); }
}

// pg_dump of schema public (superuser over the private socket) after the gate; pg_restore into a
// FRESH target as mona_local_test over 127.0.0.1 (passfile), after the target's gate.
async function dump(ctx, cluster, state, file) {
  await cluster.gate().run('pg_dump', { state }, async () => {
    const r = await runChild(`${BIN}/pg_dump`, ['--format=custom', '--schema=public', '--no-owner', '--no-privileges', `--file=${file}`, `--host=${cluster.sock}`, '--port=5432',
      `--username=${ctx.osUser}`, '--dbname=mona_local_test', '--no-password'], { env: cluster.env(), logFile: cluster.log('pg_dump'), timeoutMs: T.dump });
    if (!r.ok) throw new Error('pg_dump failed');
  });
  fs.chmodSync(file, 0o600);
}
async function restore(ctx, cluster, file) {
  await cluster.gate().run('pg_restore', { state: 'FRESH' }, async () => {
    const id = await cluster.proveIdentity();
    if (!id.ok) throw new Error(`LOCAL_TEST_IDENTITY_NOT_PROVEN before pg_restore: ${id.reason}`);
    const r = await runChild(`${BIN}/pg_restore`, ['--format=custom', '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges', '--schema=public',
      '--host=127.0.0.1', '--port=5432', '--username=mona_local_test', '--dbname=mona_local_test', '--no-password', file],
    { env: cluster.env({ PGPASSFILE: cluster.passfile }), logFile: cluster.log('pg_restore'), timeoutMs: T.dump });
    if (!r.ok) throw new Error('pg_restore failed (exit status)');
  });
}

function compareProofs(src, dst, state, expectedCatalog) {
  const ref = SCHEMA_REFERENCES[state]?.digest ?? null;
  const checks = {
    ledger: src.ledger.ok && dst.ledger.ok && src.ledger.state === state && dst.ledger.state === state,
    schemaEqual: src.digest === dst.digest,
    schemaReference: ref === null ? 'NO_REFERENCE_YET' : dst.digest === ref,
    probes: src.probesFailed.length === 0 && dst.probesFailed.length === 0,
    constraintsValidated: dst.unvalidated.length === 0 && dst.invalidIndexes.length === 0,
    counts: canonicalJson(src.counts) === canonicalJson(dst.counts),
    fingerprints: canonicalJson(src.fingerprints) === canonicalJson(dst.fingerprints),
    rbac: src.rbac.ok && dst.rbac.ok && dst.rbac.catalog === expectedCatalog && src.rbac.digest === dst.rbac.digest,
    invariants: src.invariants.ok && dst.invariants.ok && canonicalJson(src.invariants.values) === canonicalJson(dst.invariants.values),
  };
  const ok = Object.values(checks).every((v) => v === true || v === 'NO_REFERENCE_YET');
  return { ok, checks };
}
// Object-level difference of two projections: family and object key only (never a definition body).
export function diffProjections(a, b) {
  const keyed = (p) => {
    const m = new Map();
    for (const t of p.tables) { m.set(`table:${t.name}`, t.name); for (const c of t.columns) m.set(`column:${t.name}.${c.name}`, canonicalJson(c)); }
    for (const e of p.enums) m.set(`enum:${e.name}`, canonicalJson(e.labels));
    for (const x of p.types) m.set(`type:${x.name}`, x.kind);
    for (const x of p.constraints) m.set(`constraint:${x.table}.${x.name}`, canonicalJson(x));
    for (const x of p.indexes) m.set(`index:${x.table}.${x.name}`, canonicalJson(x));
    for (const x of p.functions) m.set(`function:${x.name}(${x.args})`, canonicalJson(x));
    for (const x of p.triggers) m.set(`trigger:${x.table}.${x.name}`, canonicalJson(x));
    return m;
  };
  const ka = keyed(a); const kb = keyed(b);
  return [...new Set([...ka.keys(), ...kb.keys()])].filter((k) => ka.get(k) !== kb.get(k)).sort();
}
const fmtChecks = (checks) => Object.entries(checks).map(([k, v]) => `${k}=${v === true ? 'PASS' : v === false ? 'FAIL' : v}`).join(' ');
const fmtInv = (inv) => (inv.values ? [...INFO_INVARIANTS.slice(0, 1), ...HARD_INVARIANTS, ...INFO_INVARIANTS.slice(1)].map((k) => `${k}=${inv.values[k]}`).join(' ') : 'malformed');

// ---------------- operations ----------------
async function withRun(ctx, label, body) {
  const run = newRun(ctx, label);
  try {
    return await body(run);
  } finally {
    for (const c of run.clusters) await c.stop().catch(() => false);
    run.evidence.stopped = run.clusters.every((c) => !c.running);
    writeEvidence(run);
    ctx.say(`run ${run.id}: clusters stopped=${run.evidence.stopped ? 'PASS' : 'FAIL'}; evidence ${path.join(run.dir, 'evidence', 'evidence.json')} (data kept until --op=teardown)`);
  }
}

async function opProvision(ctx, { state }) {
  return withRun(ctx, `provision ${state}`, async (run) => {
    const c = new Cluster(ctx, run, 'c1');
    await provisionState(ctx, run, c, state);
    run.evidence.provision = { state, systemIdentifier: c.systemIdentifier, migrations: STATES[state].length, plan: buildLabPlan({ op: 'provision', state, from: null, prisma: resolvePrismaCli(API_DIR), configSha256: fileSha(path.join(API_DIR, LAB_CONFIG)) }).digest };
    ctx.say(`PROVISION ${state} system_identifier=${c.systemIdentifier} plan=${run.evidence.provision.plan}`);
    return { ok: true };
  });
}
function fileSha(f) { return createHash('sha256').update(fs.readFileSync(f)).digest('hex'); }

async function opSchemaReference(ctx, { state }) {
  return withRun(ctx, `schema-reference ${state}`, async (run) => {
    const c = new Cluster(ctx, run, 'c1');
    await provisionState(ctx, run, c, state);
    const lines = [];
    const rc = await c.gate().run('schema-reference', { state }, () => referenceMain(['--target=local-test', `--expected-state=${state}`, `--system-identifier=${c.systemIdentifier}`],
      { env: { LOCAL_TEST_DATABASE_URL: c.url, LOCAL_TEST_DATABASE_MARKER_ID: c.markerId }, log: (l) => lines.push(l), error: (l) => lines.push(l) }));
    for (const l of lines) ctx.log(`  ${l.split(c.password).join('«redacted»')}`);
    const entry = lines.find((l) => l.startsWith(`  ${state}: Object.freeze({ digest: '`)) ?? null;
    const m = await measure(c, state);
    run.evidence.reference = { state, systemIdentifier: c.systemIdentifier, ledger: m.ledger.ok ? m.ledger.state : m.ledger.reason, migrations: STATES[state], digest: m.digest, summary: m.summary, entry };
    ctx.say(`SCHEMA_REFERENCE state=${state} sysid=${c.systemIdentifier} ledger=${m.ledger.ok ? m.ledger.state : 'FAIL'} digest=${m.digest} counts=${canonicalJson(m.summary)}`);
    return { ok: rc === 0 && entry !== null && m.ledger.ok, rc: rc === 0 ? 3 : rc };
  });
}

async function sourceAndRestore(ctx, run, state) {
  const src = new Cluster(ctx, run, 'cs');
  await provisionState(ctx, run, src, state);
  await seed(ctx, src, state);
  const srcM = await measure(src, state);
  const file = path.join(run.dir, 'evidence', `${state}.dump`);
  await dump(ctx, src, state, file);
  if (!(await src.stop())) throw new Error('the source cluster could not be verifiably stopped');
  const dst = new Cluster(ctx, run, 'cr');
  await dst.create();
  await restore(ctx, dst, file);
  const id = await dst.proveIdentity();
  if (!id.ok) throw new Error(`LOCAL_TEST_IDENTITY_NOT_PROVEN after restore: ${id.reason}`);
  const dstM = await measure(dst, state);
  return { src, dst, srcM, dstM, file };
}

async function opBackupRestore(ctx, { state }) {
  return withRun(ctx, `backup-restore-proof ${state}`, async (run) => {
    const { src, dst, srcM, dstM } = await sourceAndRestore(ctx, run, state);
    const cmp = compareProofs(srcM, dstM, state, state === 'EXACT_G11' ? 'CATALOG_36' : 'CATALOG_35');
    run.evidence.restoreProof = { state, source: src.systemIdentifier, restore: dst.systemIdentifier, digest: dstM.digest, counts: dstM.counts, checks: cmp.checks, invariants: dstM.invariants.values };
    ctx.say(`LOCAL_RESTORE_PROOF ${state} source_sysid=${src.systemIdentifier} restore_sysid=${dst.systemIdentifier} digest=${dstM.digest}`);
    ctx.say(`  checks ${fmtChecks(cmp.checks)}`);
    if (!cmp.checks.schemaEqual) {
      const keys = diffProjections(srcM.projection, dstM.projection);
      for (const k of keys) ctx.say(`  SCHEMA_DIFF ${k}`);
      const pick = (p) => keys.map((k) => [k, p.constraints.find((x) => `constraint:${x.table}.${x.name}` === k) ?? p.indexes.find((x) => `index:${x.table}.${x.name}` === k) ?? null]);
      fs.writeFileSync(path.join(run.dir, 'evidence', 'schema-diff.json'), `${JSON.stringify({ source: pick(srcM.projection), restored: pick(dstM.projection) }, null, 2)}\n`, { mode: 0o600 });
    }
    ctx.say(`  rows=${Object.values(dstM.counts).reduce((a, b) => a + b, 0)} invariants ${fmtInv(dstM.invariants)}`);
    return { ok: cmp.ok };
  });
}

async function opRehearsal(ctx, { from }) {
  return withRun(ctx, `migration-rehearsal ${from} → EXACT_G11`, async (run) => {
    const { dst, srcM, dstM } = await sourceAndRestore(ctx, run, from);
    const pre = compareProofs(srcM, dstM, from, 'CATALOG_35');
    ctx.say(`  restored clone ${from}: ${fmtChecks(pre.checks)}`);
    if (!pre.ok) return { ok: false };
    const columnsOf = Object.fromEntries(Object.entries(dstM.columns).filter(([, v]) => v !== null));
    const before = await measure(dst, from, { columnsOf });
    // pilot-migrate's own payload proof on the reviewed tree, then its exact Prisma command.
    const payload = verifyMigrationPayload(API_DIR);
    if (!payload.ok) throw new Error(`payload: ${payload.reason}`);
    const res = await dst.gate().run('rehearsal migrate', { state: from }, () => runPrisma(ctx, dst, { args: REHEARSAL_PRISMA_ARGS }));
    if (!res.ok) throw new Error('rehearsal prisma migrate failed; see cr/log/prisma.log (RESTORE_REQUIRED on PILOT)');
    // The RBAC upgrade with the very statements pilot-rbac-catalog-upgrade runs, after identity + EXACT_G11.
    const step = await dst.gate().run('rbac upgrade', { state: 'EXACT_G11' }, async () => {
      const c = await dst.client();
      try {
        await c.query(UPGRADE_SQL.begin); await c.query(UPGRADE_SQL.searchPath); for (const s of UPGRADE_SQL.timeouts) await c.query(s);
        const r = await upgradeCatalogInTransaction(c);
        if (r.outcome === 'UPGRADED') await c.query('COMMIT'); else await c.query('ROLLBACK');
        return r;
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { await c.end(); }
    });
    const after = await measure(dst, 'EXACT_G11', { columnsOf });
    const ref = SCHEMA_REFERENCES.EXACT_G11?.digest ?? null;
    const delta = { _prisma_migrations: STATES.EXACT_G11.length - STATES[from].length, Permission: 1, RolePermission: 2 };
    const countsPreserved = Object.keys(before.counts).every((t) => after.counts[t] === before.counts[t] + (delta[t] ?? 0));
    const changed = Object.keys(before.fingerprints).filter((t) => t !== '_prisma_migrations' && t !== 'Permission' && t !== 'RolePermission' && before.fingerprints[t] !== after.fingerprints[t]);
    const checks = {
      ledger: after.ledger.ok && after.ledger.state === 'EXACT_G11',
      migrationsApplied: after.counts._prisma_migrations - before.counts._prisma_migrations === MIGRATION_PINS.length - STATES[from].length,
      schemaReference: ref === null ? 'NO_REFERENCE_YET' : after.digest === ref,
      probes: after.probesFailed.length === 0,
      constraintsValidated: after.unvalidated.length === 0 && after.invalidIndexes.length === 0,
      rbac: step.outcome === 'UPGRADED' && after.rbac.ok && after.rbac.catalog === 'CATALOG_36',
      countsPreserved,
      fingerprintsPreserved: changed.length === 0,
      invariants: after.invariants.ok,
    };
    const ok = Object.values(checks).every((v) => v === true || v === 'NO_REFERENCE_YET');
    run.evidence.rehearsal = { from, sysid: dst.systemIdentifier, before: { digest: before.digest, counts: before.counts }, after: { digest: after.digest, counts: after.counts, summary: after.summary },
      checks, changedFingerprints: changed, probesFailed: after.probesFailed, unvalidated: after.unvalidated, prismaArgs: REHEARSAL_PRISMA_ARGS };
    ctx.say(`MIGRATION_REHEARSAL ${from} → EXACT_G11 sysid=${dst.systemIdentifier} applied=${delta._prisma_migrations} (${MIGRATION_PINS.slice(STATES[from].length).map((m) => m.name.slice(0, 14)).join(',')})`);
    ctx.say(`  command: prisma ${REHEARSAL_PRISMA_ARGS.join(' ')} (pilot-migrate's command; reviewed tree verified by pilot-migrate.verifyMigrationPayload)`);
    ctx.say(`  rbac ${step.outcome} catalog_after=${after.rbac.ok ? after.rbac.catalog : 'NONE'} schema_after=${after.digest}`);
    ctx.say(`  checks ${fmtChecks(checks)}${changed.length ? ` changed=${changed.join(',')}` : ''}`);
    for (const f of [...after.probesFailed, ...after.unvalidated.map((x) => `UNVALIDATED:${x}`)]) ctx.say(`  ${f}`);
    return { ok };
  });
}

async function opIntegration(ctx) {
  return withRun(ctx, 'integration-test (pilot-clone-restore.itest.mjs)', async (run) => {
    // Short root: pilot-clone-restore refuses socket paths over 100 bytes (its own fail-closed guard).
    const itestRoot = path.join(ctx.root, `i${run.id.slice(-8)}`); fs.mkdirSync(itestRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(run.dir, 'itest-root'), `${itestRoot}\n`, { mode: 0o600 });
    const env = childEnv({ home: ctx.home, tmpdir: path.join(run.dir, 'tmp'), path: `${path.dirname(ctx.execPath)}:/usr/bin:/bin`,
      extra: { MONA_A5_ITEST_ROOT: itestRoot, MONA_CUTOVER_LAB_RUN: run.id } });
    const file = path.join(run.dir, 'evidence', 'itest.log');
    const r = await runChild(ctx.execPath, ['--test', '--test-reporter=spec', path.join(HERE, 'pilot-clone-restore.itest.mjs')], { env, cwd: REPO, logFile: file, timeoutMs: 3600000 });
    const text = fs.readFileSync(file, 'utf8');
    const tally = (k) => Number(new RegExp(`^ℹ ${k} ([0-9]+)$`, 'm').exec(text)?.[1] ?? NaN);
    run.evidence.integration = { exit: r.code, tests: tally('tests'), pass: tally('pass'), fail: tally('fail'), skipped: tally('skipped') };
    ctx.say(`INTEGRATION_TEST exit=${r.code} tests=${tally('tests')} pass=${tally('pass')} fail=${tally('fail')} skipped=${tally('skipped')} (log ${file})`);
    const itestOk = r.ok && tally('fail') === 0 && tally('skipped') === 0 && tally('pass') > 0;
    // G11-ADV-004: in the SAME gated run, the real-PostgreSQL proof of the S9 startup gate:
    // a fresh disposable EXACT_G11 cluster (this run's own Cluster, stopped with the run)
    // carries the OPT-IN PG suite of the gate itself, which on real PostgreSQL 17 proves the
    // shipped probe SQL end to end — every catalog object including the trigger bindings, the
    // composite FK column pairs and RESTRICT/RESTRICT/SIMPLE, and the six CHECK definitions
    // compared against the pinned reviewed renderings (whitespace normalized) plus the tamper
    // cases. The binding travels only in the child environment and is never printed.
    try {
      const c9 = new Cluster(ctx, run, 's9src');
      await provisionState(ctx, run, c9, 'EXACT_G11');
      const env9 = childEnv({ home: path.join(run.dir, 'home'), tmpdir: path.join(run.dir, 'tmp'), path: `${path.dirname(ctx.execPath)}:/usr/bin:/bin`,
        extra: { MONA_CUTOVER_LAB_RUN: run.id, MONA_TEST_DATABASE_TARGET: 'local',
          MONA_R3_S9_PG: '1', MONA_R3_S9_PG_DISPOSABLE: '1', MONA_R3_PG_SYSTEM_ID: String(c9.systemIdentifier),
          LOCAL_TEST_DATABASE_URL: c9.url, LOCAL_TEST_DATABASE_MARKER_ID: c9.markerId } });
      const file9 = path.join(run.dir, 'evidence', 's9pg.log');
      const r9 = await runChild(ctx.execPath, [path.join(API_DIR, 'node_modules', 'vitest', 'vitest.mjs'), 'run', '--config', 'vitest.s9-pg-g11.config.ts'], { env: env9, cwd: API_DIR, logFile: file9, timeoutMs: 3600000 });
      const t9 = fs.readFileSync(file9, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
      const filesFailed = Number(/^\s*Test Files\s+(\d+)\s+failed/m.exec(t9)?.[1] ?? 0);
      run.evidence.s9pg = { exit: r9.code, summary: t9.match(/^\s*Test Files\s.*$/m)?.[0]?.trim() ?? null, tests: t9.match(/^\s*Tests\s.*$/m)?.[0]?.trim() ?? null, filesFailed };
      ctx.say(`S9_STARTUP_GATE_PG exit=${r9.code} ${run.evidence.s9pg.tests ?? 'no vitest summary'} (log ${file9})`);
      if (r9.code !== 0 || filesFailed !== 0) {
        for (const line of t9.split('\n').filter((l) => l.includes('FAIL') || l.includes('AssertionError') || l.includes('ERROR')).slice(0, 40)) ctx.say(`  ${line}`);
        return { ok: false };
      }
      return { ok: itestOk };
    } finally {
      try { await c9.stop(); } catch { /* the run's own stop pass records the authoritative state */ }
    }
  });
}

async function opTeardown(ctx, { run }) {
  const dir = path.join(ctx.root, run);
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) return { ok: false, result: 'REFUSED', rc: 2 };
  for (const c of fs.readdirSync(dir)) {
    const pid = path.join(dir, c, 'pgdata', 'postmaster.pid');
    if (fs.existsSync(pid)) { ctx.say(`teardown refused: ${c} still has a postmaster.pid (stop it first; nothing deleted)`); return { ok: false, result: 'REFUSED', rc: 2 }; }
  }
  fs.rmSync(dir, { recursive: true });
  const itestRoot = path.join(ctx.root, `i${run.slice(-8)}`);
  if (fs.existsSync(itestRoot) && !fs.lstatSync(itestRoot).isSymbolicLink()) fs.rmSync(itestRoot, { recursive: true });
  ctx.say(`teardown ${run}: removed`);
  return { ok: true };
}

export async function runOperation(args, io) {
  const ctx = createLabContext(io);
  switch (args.op) {
    case 'provision': return opProvision(ctx, args);
    case 'schema-reference': return opSchemaReference(ctx, args);
    case 'backup-restore-proof': return opBackupRestore(ctx, args);
    case 'migration-rehearsal': return opRehearsal(ctx, args);
    case 'integration-test': return opIntegration(ctx, args);
    case 'teardown': return opTeardown(ctx, args);
    default: throw new Error('unknown operation');
  }
}

// The itest's cluster API: the same Cluster/provision path, only inside a lab run (MONA_CUTOVER_LAB_RUN).
export async function itestProvision({ state, root, say }) {
  const runId = process.env.MONA_CUTOVER_LAB_RUN;
  if (!RUN_ID.test(runId ?? '')) throw new Error('the itest provision runs only inside a lab integration-test run');
  const ctx = createLabContext({ home: os.homedir(), log: say ?? (() => {}), error: say ?? (() => {}), execPath: process.execPath });
  const dir = fs.mkdtempSync(path.join(root, `${state.toLowerCase()}-`)); fs.chmodSync(dir, 0o700);
  for (const d of ['home', 'tmp', 'stage', 'evidence']) fs.mkdirSync(path.join(dir, d), { mode: 0o700 });
  const run = { id: runId, dir, evidence: {}, clusters: [] };
  const c = new Cluster(ctx, run, 'src');
  await provisionState(ctx, run, c, state);
  return {
    sock: c.sock, osUser: ctx.osUser, systemIdentifier: c.systemIdentifier, gate: c.gate(), proveIdentity: () => c.proveIdentity(),
    seed: () => seed(ctx, c, state), stop: () => c.stop(), dir,
    // G11-ADV-004: the S9 PG proof needs the binding the suite's own guard expects.
    // In-process only — never logged, never in an argv.
    url: c.url, markerId: c.markerId,
  };
}
