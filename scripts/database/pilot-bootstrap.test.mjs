// Zero-database unit tests for scripts/database/pilot-bootstrap.mjs.
// Run with: node --test scripts/database/pilot-bootstrap.test.mjs
// Hermetic: synthetic *.invalid URLs, an injected fake pg client for the marker
// proof, an in-memory fake Prisma (unique keys, FKs, CHECK, rollback), synthetic
// private files in a temp dir. The canonical api/src TypeScript modules are loaded
// in-process (pure code, no connection) as the test oracle. Nothing reads the real
// ~/.config/mona-jacinta files; nothing opens a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CONFIG_FILE,
  CREDENTIALS_FILE,
  PILOT_ACCOUNTS,
  canonicalPlan,
  classifyPilotState,
  loadCanonical,
  main,
  planDigest,
  parseCliArgs,
  parseStrictJson,
  validateBusinessConfig,
  validateCredentials,
} from './pilot-bootstrap.mjs';
import { parsePilotUrl } from './pilot-marker.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MARKER = '6d1e3f5a-2b4c-4d6e-8f0a-1b2c3d4e5f60';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = 'pilotsynthref0000001';
const SECRET = 'Boot5ecretPw';
const HOST = 'aws-0-synthetic.pooler.invalid';
const URL_TEXT = `postgresql://postgres.${REF}:${SECRET}@${HOST}:6543/postgres`;
const HOSTILE_URL = 'postgresql://postgres.hostileref00000000x:hostilepw@dev-hostile.invalid:5432/postgres';

const DRY = ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`];
const EXECUTE = ['--target=pilot', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`];

// OWNER decision: PILOT business data is intentionally synthetic. Every name and
// address carries the PILOT marker; the CUIT is the non-fiscal sentinel.
const COMPANY = { name: 'Mona Jacinta PILOT', cuit: 'PILOT-NO-FISCAL', address: 'Domicilio sintético PILOT — sin validez fiscal' };
const LOCATIONS = [
  { code: 'RTA', name: 'Centro PILOT', type: 'RETAIL_BRANCH', address: 'Domicilio sintético PILOT — Centro', pointOfSaleNumber: 11 },
  { code: 'RTB', name: 'Sucursal B PILOT', type: 'RETAIL_BRANCH', address: 'Domicilio sintético PILOT — B', pointOfSaleNumber: 12 },
  { code: 'CDP', name: 'Depósito PILOT', type: 'CENTRAL_WAREHOUSE', address: 'Domicilio sintético PILOT — Depósito', pointOfSaleNumber: 19 },
];
const ASSIGNMENTS = { 'vendedor01@pilot.local': 'RTA', 'cajero01@pilot.local': 'RTA', 'deposito01@pilot.local': 'CDP' };
const config = (overrides = {}) => ({ company: { ...COMPANY }, locations: LOCATIONS.map((l) => ({ ...l })), assignments: { ...ASSIGNMENTS }, ...overrides });
const PASSWORDS = {
  'propietario01@pilot.local': 'Owner-Synth-7yQ2vN4mK9pL',
  'administrador01@pilot.local': 'Admin-Synth-3tR8wX1cV6bZ',
  'vendedor01@pilot.local': 'Seller-Synth-5hJ0kM7nQ2sD',
  'cajero01@pilot.local': 'Cashier-Synth-9gF4dS8aL1pO',
  'deposito01@pilot.local': 'Depot-Synth-2eW6rT0yU3iK',
};
const LEAKS = [SECRET, HOST, REF, `postgres.${REF}`, URL_TEXT, `${HOST}:6543`, ...Object.values(PASSWORDS), '$2a$', '$2b$', 'synthetic-hash:'];
function assertNoLeak(text) {
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `output leaked ${JSON.stringify(leak.slice(0, 12))}…`);
}

// --- canonical oracle (real api/src modules, loaded in-process) ------------------

const tsx = await import(pathToFileURL(path.join(ROOT, 'api/node_modules/tsx/dist/esm/api/index.mjs')).href);
const ts = (rel) => tsx.tsImport(pathToFileURL(path.join(ROOT, rel)).href, import.meta.url);
const catalog = await ts('api/src/modules/rbac/catalog.service.ts');
const matrix = await ts('api/src/modules/rbac/role-permission-matrix.ts');
const roles = await ts('api/src/modules/rbac/roles.ts');
const perms = await ts('api/src/modules/rbac/permissions.ts');
const actor = await ts('api/src/modules/audit/system-actor.service.ts');
const password = await ts('api/src/modules/auth/password.ts');
const fastHash = async (plain) => `synthetic-hash:${plain.length}`;
const CANONICAL = {
  syncProductionRbacCatalog: catalog.syncProductionRbacCatalog,
  verifyProductionRbacCatalog: catalog.verifyProductionRbacCatalog,
  CANONICAL_ROLE_IDS: catalog.CANONICAL_ROLE_IDS,
  CANONICAL_PERMISSION_IDS: catalog.CANONICAL_PERMISSION_IDS,
  DEFAULT_ROLE_GRANTS: matrix.DEFAULT_ROLE_GRANTS,
  roleCodeValues: roles.roleCodeValues,
  productionPermissionValues: perms.productionPermissionValues,
  planSystemActorBootstrap: actor.planSystemActorBootstrap,
  bootstrapSystemActor: actor.bootstrapSystemActor,
  SYSTEM_ACTOR_USER_ID: actor.SYSTEM_ACTOR_USER_ID,
  SYSTEM_ACTOR_EMAIL: actor.SYSTEM_ACTOR_EMAIL,
  SYSTEM_ACTOR_NAME: actor.SYSTEM_ACTOR_NAME,
  hashPassword: fastHash,
  BCRYPT_ROUNDS: password.BCRYPT_ROUNDS,
};

// --- in-memory fake Prisma --------------------------------------------------------

const TABLES = ['role', 'permission', 'rolePermission', 'company', 'location', 'branch', 'cashRegister', 'saleNumberCounter', 'user', 'userRoleScope', 'userBranchRole'];
const UNIQUE = {
  role: [['id'], ['code']], permission: [['id'], ['code']], rolePermission: [['roleId', 'permissionId']],
  company: [['id'], ['cuit']], location: [['id'], ['code'], ['pointOfSaleNumber']], branch: [['id'], ['code']],
  cashRegister: [['id'], ['branchId', 'name']], saleNumberCounter: [['id'], ['branchId']], user: [['id'], ['email']],
  userRoleScope: [['id'], ['userId', 'roleId', 'scopeKind', 'locationId']], userBranchRole: [['id'], ['userId', 'branchId', 'roleId']],
};
const FK = {
  rolePermission: [['roleId', 'role'], ['permissionId', 'permission']],
  location: [['companyId', 'company']],
  cashRegister: [['branchId', 'branch']],
  saleNumberCounter: [['branchId', 'branch']],
  userRoleScope: [['userId', 'user'], ['roleId', 'role'], ['locationId', 'location']],
  userBranchRole: [['userId', 'user'], ['branchId', 'branch'], ['roleId', 'role']],
};
const DEFAULTS = {
  company: { isActive: true, createdAt: new Date(0) }, location: { isActive: true }, user: { isActive: true },
  userRoleScope: { scopeKind: 'LOCATION', locationId: null }, saleNumberCounter: { nextValue: 1n },
};
const clone = (tables) => Object.fromEntries(Object.entries(tables).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]));
const PERMITTED_MUTATIONS = new Set(['create', 'createMany']);

function fakeDb({ seed = {}, marker = { rows: [{ environment: 'pilot', marker_id: MARKER }], testGuard: false }, failOn } = {}) {
  let tables = Object.fromEntries(TABLES.map((t) => [t, (seed[t] ?? []).map((r) => ({ ...r }))]));
  const calls = [];
  const stats = { transactions: 0, commits: 0, rollbacks: 0 };
  const matches = (row, where = {}) =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
        if ('in' in v) return v.in.includes(row[k]);
        if ('not' in v) return row[k] !== v.not;
        throw new Error(`fake: unsupported where operator on ${k}`);
      }
      return row[k] === v;
    });
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).filter((k) => select[k] === true).map((k) => [k, row[k]])) : { ...row });
  const insert = (table, data, skipDuplicates) => {
    const row = { ...(DEFAULTS[table] ?? {}), id: randomUUID(), ...data };
    if (table === 'rolePermission') delete row.id;
    if (table === 'userRoleScope' && !((row.scopeKind === 'LOCATION' && row.locationId !== null) || (row.scopeKind === 'COMPANY' && row.locationId === null))) {
      throw Object.assign(new Error('violates check constraint chk_user_role_scope_consistency'), { code: 'P2004' });
    }
    for (const keys of UNIQUE[table]) {
      if (tables[table].some((r) => keys.every((k) => r[k] === row[k]))) {
        if (skipDuplicates) return null;
        throw Object.assign(new Error(`Unique constraint failed on ${keys.join(',')} ${URL_TEXT}`), { code: 'P2002' });
      }
    }
    for (const [col, ref] of FK[table] ?? []) {
      if (row[col] !== null && row[col] !== undefined && !tables[ref].some((r) => r.id === row[col])) {
        throw Object.assign(new Error(`Foreign key failed ${col}`), { code: 'P2003' });
      }
    }
    tables[table].push(row);
    return row;
  };
  const delegate = (table) =>
    new Proxy(
      {
        findMany: async (args = {}) => {
          let rows = tables[table].filter((r) => matches(r, args.where));
          if (args.take) rows = rows.slice(0, args.take);
          return rows.map((r) => pick(r, args.select));
        },
        findUnique: async (args) => {
          const row = tables[table].find((r) => matches(r, args.where));
          return row ? pick(row, args.select) : null;
        },
        count: async (args = {}) => tables[table].filter((r) => matches(r, args.where)).length,
        create: async ({ data, select }) => {
          if (failOn === `${table}.create`) throw Object.assign(new Error(`db exploded ${URL_TEXT} ${Object.values(PASSWORDS)[0]}`), { code: 'P2010' });
          return pick(insert(table, data, false), select);
        },
        createMany: async ({ data, skipDuplicates }) => {
          let count = 0;
          for (const d of data) if (insert(table, d, skipDuplicates)) count += 1;
          return { count };
        },
      },
      {
        get(target, prop) {
          if (typeof prop === 'string') calls.push(`${table}.${prop}`);
          if (!(prop in target)) return () => Promise.reject(new Error(`fake: ${table}.${String(prop)} is not permitted`));
          return target[prop];
        },
      },
    );
  const client = {
    calls,
    stats,
    get tables() {
      return tables;
    },
    async $queryRaw(strings) {
      const text = Array.isArray(strings) ? strings.join('?') : String(strings);
      calls.push(`$queryRaw:${text.includes('pg_advisory_xact_lock') ? 'advisory-lock' : 'other'}`);
      if (text.includes('pg_advisory_xact_lock')) return [{ pg_advisory_xact_lock: '' }];
      throw new Error('fake: unexpected $queryRaw');
    },
    async $queryRawUnsafe(text) {
      calls.push('$queryRawUnsafe');
      if (text.includes('mona_pilot_guard.database_identity')) {
        return [{ test_guard_exists: marker.testGuard, rows: marker.rows }];
      }
      throw new Error('fake: unexpected $queryRawUnsafe');
    },
    async $transaction(fn) {
      stats.transactions += 1;
      const snapshot = clone(tables);
      const tx = {};
      for (const t of TABLES) tx[t] = delegate(t);
      tx.$queryRaw = client.$queryRaw;
      tx.$queryRawUnsafe = client.$queryRawUnsafe;
      try {
        const result = await fn(tx);
        stats.commits += 1;
        return result;
      } catch (err) {
        tables = snapshot;
        stats.rollbacks += 1;
        throw err;
      }
    },
    async $disconnect() {
      calls.push('$disconnect');
    },
  };
  for (const t of TABLES) client[t] = delegate(t);
  return client;
}

// --- fake pg client speaking pilot-marker's --check protocol --------------------------

function markerFacts() {
  return {
    schemaOwnerIsCurrentUser: true,
    relations: [{ name: 'database_identity_pkey', kind: 'i' }, { name: 'database_identity', kind: 'r' }],
    table: { kind: 'r', persistence: 'p', isPartition: false, ofType: false, ownerIsCurrentUser: true, rowSecurity: false, forceRowSecurity: false, hasSubclass: false, parents: 0, children: 0, hasRules: false, triggers: 0 },
    columns: [
      { name: 'singleton', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '', collation: null },
      { name: 'environment', type: 'text', notNull: true, default: null, generated: '', identity: '', collation: 'default' },
      { name: 'marker_id', type: 'uuid', notNull: true, default: null, generated: '', identity: '', collation: null },
      { name: 'installed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '', collation: null },
    ],
    constraints: [{ type: 'p', definition: 'PRIMARY KEY (singleton)' }, { type: 'c', definition: 'CHECK (singleton)' }, { type: 'c', definition: "CHECK ((environment = 'pilot'::text))" }],
  };
}
function fakePg({ testGuard = false, authorized = true, markerId = MARKER, onQuery } = {}) {
  const sql = [];
  return {
    sql,
    connection: { stream: { encrypted: authorized, authorized } },
    async connect() {},
    async query(q) {
      const text = typeof q === 'string' ? q : q.text;
      sql.push(text);
      onQuery?.(text);
      if (text.includes('to_regnamespace')) return { rows: [{ schema_exists: true, table_exists: true, test_guard_exists: testGuard }] };
      if (text.includes('json_build_object')) return { rows: [{ facts: markerFacts() }] };
      if (text.startsWith('SELECT environment')) return { rows: [{ environment: 'pilot', marker_id: markerId, has_installed_at: true }] };
      return { rows: [] };
    },
    async end() {},
  };
}

// --- private files --------------------------------------------------------------

const TMP = mkdtempSync(path.join(os.tmpdir(), 'pilot-bootstrap-test-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));
let fileCount = 0;
function privateFile(content, mode = 0o600) {
  const file = path.join(TMP, `f-${fileCount++}`);
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  chmodSync(file, mode);
  return file;
}
function files({ url = `${URL_TEXT}\n`, cfg = config(), creds = PASSWORDS } = {}) {
  return {
    urlFile: url === null ? path.join(TMP, 'absent-url') : privateFile(url),
    configFile: cfg === null ? path.join(TMP, 'absent-config') : privateFile(cfg),
    credentialsFile: creds === null ? path.join(TMP, 'absent-creds') : privateFile(creds),
  };
}

// What the OWNER would copy from the dry-run of the same files/marker: the digest
// printed by a zero-DB dry-run (default private-file reader, no counters touched).
async function approvedDigest(argv, opts = {}) {
  const marker = argv.find((a) => a.startsWith('--marker-id='));
  const out = [];
  await main(['--target=pilot', '--dry-run', marker], {
    ...(opts.dryFiles ?? opts.files ?? files()),
    env: {},
    createClient: () => {
      throw new Error('dry-run must not create a client');
    },
    createPrisma: async () => {
      throw new Error('dry-run must not create Prisma');
    },
    loadCanonical: async () => opts.dryCanonical ?? opts.canonical ?? CANONICAL,
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  });
  return /plan sha256: ([0-9a-f]{64})/.exec(out.join('\n'))?.[1] ?? null;
}

async function run(argv, opts = {}) {
  const out = [];
  const pg = opts.pg ?? fakePg();
  const db = opts.db ?? fakeDb();
  const counters = { pgClients: [], prisma: [], canonicalLoads: 0, hashes: 0 };
  const f = opts.files ?? files();
  const deps = {
    ...f,
    env: opts.env ?? {},
    createClient: (conn) => {
      counters.pgClients.push(conn);
      return pg;
    },
    createPrisma: async (conn) => {
      counters.prisma.push(conn);
      return db;
    },
    loadCanonical: async () => {
      counters.canonicalLoads += 1;
      const canonical = opts.canonical ?? CANONICAL;
      return {
        ...canonical,
        hashPassword: async (plain) => {
          counters.hashes += 1;
          return canonical.hashPassword(plain);
        },
      };
    },
    log: (line) => out.push(line),
    error: (line) => out.push(line),
  };
  if (opts.readPrivateFile) deps.readPrivateFile = opts.readPrivateFile;
  let args = argv;
  if (argv.includes('--execute') && argv.includes('--target=pilot') && !argv.some((a) => a.startsWith('--plan')) && opts.plan !== false) {
    args = [...argv, `--plan=${opts.plan ?? (await approvedDigest(argv, opts)) ?? '0'.repeat(64)}`];
  }
  const code = await main(args, deps);
  const text = out.join('\n');
  for (const call of db.calls) {
    const method = call.split('.')[1];
    if (method && !['findMany', 'findUnique', 'count'].includes(method)) assert.ok(PERMITTED_MUTATIONS.has(method), `non-additive call: ${call}`);
  }
  return { code, text, db, pg, counters };
}

// Builds the exact committed state of a successful fresh run, for idempotency/conflict fixtures.
async function bootstrapped(cfg = config()) {
  const r = await run(EXECUTE, { files: files({ cfg }) });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.db.tables.user.filter((u) => u.email.endsWith('@pilot.local')).length, 5, 'fixture: a fresh bootstrap must create the 5 accounts');
  return clone(r.db.tables);
}

// --- CLI -------------------------------------------------------------------------------

test('parse: the two canonical invocations (execute carries the approved plan digest)', () => {
  const plan = 'a1'.repeat(32);
  assert.deepEqual(parseCliArgs(DRY), { ok: true, mode: 'dry-run', markerId: MARKER, confirmProjectRef: null, plan: null });
  assert.deepEqual(parseCliArgs([...EXECUTE, `--plan=${plan}`]), { ok: true, mode: 'execute', markerId: MARKER, confirmProjectRef: REF, plan });
});

test('B1/B2/B4: non-canonical CLI fails closed without echoing values', () => {
  for (const argv of [
    [], ['--target=test', '--dry-run', `--marker-id=${MARKER}`], ['--target=PILOT', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot ', '--dry-run', `--marker-id=${MARKER}`], ['--target=pilot', '--target=pilot', '--dry-run', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', '--execute', `--marker-id=${MARKER}`], ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, 'seed'],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, '--reset'], ['--target=pilot', '--dry-run', `--marker-id=${MARKER.toUpperCase()}`],
    ['--target=pilot', '--dry-run', '--marker-id=6d1e3f5a-2b4c-1d6e-8f0a-1b2c3d4e5f60'], ['--target=pilot', '--execute', `--marker-id=${MARKER}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`],
    ['--target=pilot', '--dry-run', `--marker-id=${MARKER}`, `--password=${PASSWORDS['cajero01@pilot.local']}`],
  ]) {
    const parsed = parseCliArgs(argv);
    assert.equal(parsed.ok, false, argv.join(' '));
    assertNoLeak(parsed.error);
  }
});

test('B1: an invalid CLI reads no file and opens nothing', async () => {
  let reads = 0;
  const r = await run(['--target=test', '--execute', `--marker-id=${MARKER}`, `--confirm-project-ref=${REF}`], {
    readPrivateFile: () => {
      reads += 1;
      return { ok: false, reason: 'x' };
    },
  });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=args/);
  assert.equal(reads, 0);
  assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0);
});

// --- strict JSON and private files ------------------------------------------------------

test('parseStrictJson rejects duplicate keys at any depth and non-integer numbers', () => {
  assert.deepEqual(parseStrictJson('{"a":1,"b":{"c":"x"},"d":[1,2]}'), { a: 1, b: { c: 'x' }, d: [1, 2] });
  for (const bad of ['{"a":1,"a":2}', '{"a":{"b":1,"b":1}}', '[{"x":1,"x":1}]', '{"a":1.5}', '{"a":1e3}', '{"a":1,}', '{"a":1} x', "{'a':1}", '']) {
    assert.throws(() => parseStrictJson(bad), undefined, bad);
  }
});

test('B5/B9/B13: missing, symlinked or group-readable private files fail at phase=config before any DB client', async () => {
  const good = files();
  const link = path.join(TMP, `link-${fileCount++}`);
  symlinkSync(good.credentialsFile, link);
  for (const [label, override] of Object.entries({
    'url missing': { urlFile: path.join(TMP, 'nope-url') },
    'url 0640': { urlFile: privateFile(`${URL_TEXT}\n`, 0o640) },
    'credentials missing': { credentialsFile: path.join(TMP, 'nope-creds') },
    'credentials symlink': { credentialsFile: link },
    'credentials 0640': { credentialsFile: privateFile(PASSWORDS, 0o640) },
    'config missing': { configFile: path.join(TMP, 'nope-config') },
    'config 0604': { configFile: privateFile(config(), 0o604) },
  })) {
    for (const argv of [DRY, EXECUTE]) {
      const r = await run(argv, { files: { ...good, ...override } });
      assert.equal(r.code, 1, label);
      assert.match(r.text, /phase=config/, label);
      assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0, label);
      assertNoLeak(r.text);
    }
  }
});

// --- credentials ------------------------------------------------------------------------

test('B10/B11: credential shape and strength are enforced, values never echoed', () => {
  assert.equal(validateCredentials(PASSWORDS).ok, true);
  const bad = {
    'missing account': (() => { const p = { ...PASSWORDS }; delete p['cajero01@pilot.local']; return p; })(),
    'extra account': { ...PASSWORDS, 'extra@pilot.local': 'Extra-Synth-1aB2cD3eF4gH' },
    'non-string': { ...PASSWORDS, 'cajero01@pilot.local': 12345678901234567 },
    'too short': { ...PASSWORDS, 'cajero01@pilot.local': 'Short-1aB2c' },
    'over 72 bytes': { ...PASSWORDS, 'cajero01@pilot.local': 'Ñ'.repeat(40) },
    'whitespace': { ...PASSWORDS, 'cajero01@pilot.local': 'Has Space-Synth-9gF4dS8aL' },
    'control char': { ...PASSWORDS, 'cajero01@pilot.local': 'Ctrl\u0007-Synth-9gF4dS8aL1' },
    'reused password': { ...PASSWORDS, 'cajero01@pilot.local': PASSWORDS['vendedor01@pilot.local'] },
    'demo password': { ...PASSWORDS, 'cajero01@pilot.local': 'demo123' },
    'contains its own login': { ...PASSWORDS, 'cajero01@pilot.local': 'cajero01-Synth-9gF4dS8aL1' },
    'not an object': ['a'],
  };
  for (const [label, value] of Object.entries(bad)) {
    const result = validateCredentials(value);
    assert.equal(result.ok, false, label);
    assertNoLeak(result.reason);
    for (const v of Object.values(value)) if (typeof v === 'string' && v.length > 4) assert.ok(!result.reason.includes(v), `${label}: value echoed`);
  }
});

test('B10: a duplicate key in the credentials file fails (JSON.parse would silently keep the last)', async () => {
  const text = JSON.stringify(PASSWORDS).replace('{', `{"cajero01@pilot.local":"Dup-Synth-0000aaaaBBBB",`);
  const r = await run(DRY, { files: { ...files(), credentialsFile: privateFile(text) } });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=config/);
  assertNoLeak(r.text);
  assert.ok(!r.text.includes('Dup-Synth-0000aaaaBBBB'));
});

// --- business config ----------------------------------------------------------------------

test('B14/B15: business config shape, CUIT checksum, placeholders and assignments are enforced', () => {
  assert.equal(validateBusinessConfig(config()).ok, true);
  const loc = (i, patch) => config({ locations: LOCATIONS.map((l, j) => (j === i ? { ...l, ...patch } : { ...l })) });
  const bad = {
    'no warehouse': loc(2, { type: 'RETAIL_BRANCH' }),
    'two warehouses': loc(0, { type: 'CENTRAL_WAREHOUSE' }),
    'no retail': config({ locations: [LOCATIONS[2]] }),
    'six retail': config({ locations: [...['RA', 'RB', 'RC', 'RD', 'RE', 'RF'].map((code, i) => ({ ...LOCATIONS[0], code, pointOfSaleNumber: 30 + i })), LOCATIONS[2]] }),
    'duplicate code': loc(1, { code: 'RTA' }),
    'duplicate POS': loc(1, { pointOfSaleNumber: 11 }),
    'bad code shape': loc(0, { code: 'rta' }),
    'POS not integer': loc(0, { pointOfSaleNumber: '11' }),
    'POS zero': loc(0, { pointOfSaleNumber: 0 }),
    'unknown type': loc(0, { type: 'KIOSK' }),
    'extra location key': loc(0, { phone: '123' }),
    'real-looking CUIT instead of the sentinel': config({ company: { ...COMPANY, cuit: '30-71234567-1' } }),
    'empty CUIT': config({ company: { ...COMPANY, cuit: '' } }),
    'lowercase sentinel': config({ company: { ...COMPANY, cuit: 'pilot-no-fiscal' } }),
    'company name without PILOT marker': config({ company: { ...COMPANY, name: 'Mona Jacinta' } }),
    'company address without PILOT marker': config({ company: { ...COMPANY, address: 'Dirección legal — pendiente de dato real' } }),
    'location name without PILOT marker': loc(0, { name: 'Centro' }),
    'location address without PILOT marker': loc(0, { address: 'Domicilio demo — Centro' }),
    'DEMO marker even with PILOT': loc(0, { name: 'Centro PILOT demo' }),
    'lowercase pilot marker only': loc(0, { name: 'Centro pilot' }),
    'padded name': loc(0, { name: ' Centro PILOT' }),
    'empty address': loc(0, { address: '' }),
    'extra company key': config({ company: { ...COMPANY, id: 'x' } }),
    'extra top-level key': { ...config(), users: [] },
    'seller at warehouse': config({ assignments: { ...ASSIGNMENTS, 'vendedor01@pilot.local': 'CDP' } }),
    'cashier at warehouse': config({ assignments: { ...ASSIGNMENTS, 'cajero01@pilot.local': 'CDP' } }),
    'depot at retail': config({ assignments: { ...ASSIGNMENTS, 'deposito01@pilot.local': 'RTB' } }),
    'unknown location': config({ assignments: { ...ASSIGNMENTS, 'cajero01@pilot.local': 'ZZZ' } }),
    'owner assigned a location': config({ assignments: { ...ASSIGNMENTS, 'propietario01@pilot.local': 'RTA' } }),
    'missing assignment': config({ assignments: { 'vendedor01@pilot.local': 'RTA', 'cajero01@pilot.local': 'RTA' } }),
  };
  for (const [label, value] of Object.entries(bad)) {
    const result = validateBusinessConfig(value);
    assert.equal(result.ok, false, label);
    assert.equal(typeof result.reason, 'string', label);
  }
});

// --- dry-run -------------------------------------------------------------------------------

test('B16: dry-run opens nothing, loads no Prisma, hashes nothing and prints the sanitized plan', async () => {
  const r = await run(DRY);
  assert.equal(r.code, 0, r.text);
  assert.equal(r.counters.pgClients.length, 0);
  assert.equal(r.counters.prisma.length, 0);
  assert.equal(r.counters.hashes, 0);
  assert.equal(r.db.calls.length, 0);
  for (const a of [
    ['propietario01@pilot.local', 'Propietario', 'OWNER', 'COMPANY'],
    ['administrador01@pilot.local', 'Administrador', 'ADMIN', 'COMPANY'],
    ['vendedor01@pilot.local', 'Vendedor 01', 'SELLER', 'LOCATION RTA'],
    ['cajero01@pilot.local', 'Cajero 01', 'CASHIER', 'LOCATION RTA'],
    ['deposito01@pilot.local', 'Depósito 01', 'WAREHOUSE', 'LOCATION CDP'],
  ]) assert.ok(r.text.includes(`${a[0]}  "${a[1]}"  ${a[2]}  ${a[3]}`), a[0]);
  for (const needle of [
    /DRY RUN — no database connection was opened and nothing was written/, /target: PILOT/, /credentials: 5 accounts, shape accepted \(values not shown\)/,
    /company: "Mona Jacinta PILOT" — synthetic PILOT data, CUIT sentinel PILOT-NO-FISCAL \(non-fiscal\)/, /RTA  RETAIL_BRANCH  "Centro PILOT"/, /CDP  CENTRAL_WAREHOUSE/, /additive only/i, /no seed, no reset, no deletes, no updates, no migration/,
    /explicit OWNER approval naming PILOT/,
  ]) assert.match(r.text, needle);
  assert.match(r.text, /all business values are synthetic PILOT data, not real business or fiscal data/);
  assertNoLeak(r.text);
});

test('dry-run: an absent business config fails at phase=config (it is OWNER-supplied, never defaulted in source)', async () => {
  const r = await run(DRY, { files: files({ cfg: null }) });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=config/);
  assert.match(r.text, /pilot-bootstrap\.json/);
});

// --- execute: target binding ---------------------------------------------------------------------

test('B3: wrong project confirmation fails before any client', async () => {
  const r = await run(EXECUTE.map((a) => (a.startsWith('--confirm') ? '--confirm-project-ref=othersynthref0000002' : a)));
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=target/);
  assert.equal(r.counters.pgClients.length + r.counters.prisma.length, 0);
});

test('B6: hostile DB env never reaches the proof or the Prisma connection', async () => {
  const env = { DATABASE_URL: HOSTILE_URL, TEST_DATABASE_URL: HOSTILE_URL, DIRECT_URL: HOSTILE_URL, PGHOST: 'hostile.invalid', PGUSER: 'hostile', PGPASSWORD: 'hostile', PGDATABASE: 'hostile' };
  const r = await run(EXECUTE, { env });
  assert.equal(r.code, 0, r.text);
  const expected = parsePilotUrl(URL_TEXT).conn;
  assert.deepEqual(r.counters.pgClients, [expected]);
  assert.deepEqual(r.counters.prisma, [expected]);
});

test('B7/B8: hostile PGOPTIONS or DEBUG fails before any DB client', async () => {
  for (const env of [{ PGOPTIONS: '-c search_path=hostile' }, { DEBUG: 'prisma:*' }]) {
    const r = await run(EXECUTE, { env });
    assert.equal(r.code, 1, JSON.stringify(env));
    assert.equal(r.counters.prisma.length, 0);
    assert.ok(!r.text.includes('hostile'));
  }
});

test('B28/B29: marker proof failures (TEST marker, TLS, wrong marker) stop before Prisma', async () => {
  for (const pg of [fakePg({ testGuard: true }), fakePg({ authorized: false }), fakePg({ markerId: OTHER })]) {
    const r = await run(EXECUTE, { pg });
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=identity/);
    assert.equal(r.counters.prisma.length, 0);
    assert.ok(!r.text.includes(OTHER));
  }
});

// --- execute: fresh bootstrap ------------------------------------------------------------------

test('B17/B39/B40: a fresh PILOT gets exactly the additive rows, in one transaction, via create/createMany only', async () => {
  const r = await run(EXECUTE);
  assert.equal(r.code, 0, r.text);
  const t = r.db.tables;
  assert.equal(r.db.stats.transactions, 1);
  assert.equal(r.db.stats.commits, 1);
  assert.equal(r.counters.pgClients.length, 1);
  assert.equal(r.counters.hashes, 6, 'five accounts + one random system-actor secret');
  assert.deepEqual(t.role.map((x) => x.code).sort(), ['ADMIN', 'CASHIER', 'OWNER', 'SELLER', 'WAREHOUSE']);
  assert.equal(t.permission.length, 35);
  const expectedGrants = Object.values(CANONICAL.DEFAULT_ROLE_GRANTS).reduce((n, g) => n + g.length, 0);
  assert.equal(t.rolePermission.length, expectedGrants);
  assert.equal((await CANONICAL.verifyProductionRbacCatalog(r.db)).ok, true);
  assert.equal(t.company.length, 1);
  assert.deepEqual({ name: t.company[0].name, cuit: t.company[0].cuit, address: t.company[0].address }, COMPANY);
  assert.equal(t.branch.length, 3);
  assert.equal(t.location.length, 3);
  for (const l of LOCATIONS) {
    const b = t.branch.find((x) => x.code === l.code);
    const loc = t.location.find((x) => x.code === l.code);
    assert.equal(loc.id, b.id, 'Location.id == Branch.id');
    assert.equal(loc.type, l.type);
    assert.equal(loc.companyId, t.company[0].id);
    assert.equal(t.cashRegister.filter((x) => x.branchId === b.id && x.name === 'Caja principal').length, 1);
    assert.equal(t.saleNumberCounter.filter((x) => x.branchId === b.id && x.nextValue === 1n).length, 1);
  }
  const users = t.user.filter((u) => u.email.endsWith('@pilot.local'));
  assert.deepEqual(users.map((u) => [u.email, u.name, u.isActive]).sort(), [
    ['administrador01@pilot.local', 'Administrador', true],
    ['cajero01@pilot.local', 'Cajero 01', true],
    ['deposito01@pilot.local', 'Depósito 01', true],
    ['propietario01@pilot.local', 'Propietario', true],
    ['vendedor01@pilot.local', 'Vendedor 01', true],
  ]);
  for (const u of users) assert.equal(u.passwordHash, `synthetic-hash:${PASSWORDS[u.email].length}`);
  const locId = (code) => t.location.find((x) => x.code === code).id;
  const scopeOf = (email) => t.userRoleScope.filter((s) => s.userId === t.user.find((u) => u.email === email).id)
    .map((s) => [t.role.find((x) => x.id === s.roleId).code, s.scopeKind, s.locationId]);
  assert.deepEqual(scopeOf('propietario01@pilot.local'), [['OWNER', 'COMPANY', null]]);
  assert.deepEqual(scopeOf('administrador01@pilot.local'), [['ADMIN', 'COMPANY', null]]);
  assert.deepEqual(scopeOf('vendedor01@pilot.local'), [['SELLER', 'LOCATION', locId('RTA')]]);
  assert.deepEqual(scopeOf('cajero01@pilot.local'), [['CASHIER', 'LOCATION', locId('RTA')]]);
  assert.deepEqual(scopeOf('deposito01@pilot.local'), [['WAREHOUSE', 'LOCATION', locId('CDP')]]);
  assert.equal(t.userBranchRole.length, 0);
  const sys = t.user.find((u) => u.id === CANONICAL.SYSTEM_ACTOR_USER_ID);
  assert.equal(sys.isActive, false);
  assert.equal((await CANONICAL.planSystemActorBootstrap(r.db)).state, 'VALID');
  assert.ok(r.db.calls.includes('$queryRaw:advisory-lock'));
  assert.ok(r.db.calls.includes('$queryRawUnsafe'), 'in-transaction marker re-check');
  assert.ok(r.db.calls.includes('$disconnect'));
  assert.match(r.text, /OK — PILOT bootstrap committed/);
  for (const email of Object.keys(PASSWORDS)) assert.ok(r.text.includes(email));
  assertNoLeak(r.text);
});

test('B40: account passwords are hashed with the canonical bcrypt cost (real hashPassword)', async () => {
  const r = await run(EXECUTE, { canonical: { ...CANONICAL, hashPassword: password.hashPassword } });
  assert.equal(r.code, 0, r.text);
  const owner = r.db.tables.user.find((u) => u.email === 'propietario01@pilot.local');
  assert.ok(owner, 'owner account created');
  assert.match(owner.passwordHash, /^\$2[aby]\$12\$/);
  assert.equal(await password.verifyPassword(PASSWORDS['propietario01@pilot.local'], owner.passwordHash), true);
  assertNoLeak(r.text);
});

// --- idempotency and conflicts ---------------------------------------------------------------------

test('B18/B19: a second run on the exact result is a no-op (no writes, no duplicates)', async () => {
  const seed = await bootstrapped();
  const r = await run(EXECUTE, { db: fakeDb({ seed }) });
  assert.equal(r.code, 0, r.text);
  assert.ok(!r.db.calls.some((c) => /\.(create|createMany)$/.test(c)), r.db.calls.filter((c) => /create/.test(c)).join(','));
  assert.deepEqual(r.db.tables, seed);
  assert.match(r.text, /already bootstrapped/i);
  assert.equal(r.counters.hashes, 0, 'no hashing needed for a no-op');
});

test('B35: adding a new config location after an exact bootstrap creates only that location group', async () => {
  const seed = await bootstrapped();
  const extra = { code: 'RTC', name: 'Sucursal C PILOT', type: 'RETAIL_BRANCH', address: 'Domicilio sintético PILOT — C', pointOfSaleNumber: 13 };
  const r = await run(EXECUTE, { db: fakeDb({ seed }), files: files({ cfg: config({ locations: [...LOCATIONS, extra] }) }) });
  assert.equal(r.code, 0, r.text);
  const creates = r.db.calls.filter((c) => /\.(create|createMany)$/.test(c)).sort();
  assert.deepEqual(creates, ['branch.create', 'cashRegister.create', 'location.create', 'saleNumberCounter.create']);
});

const mutate = (seed, fn) => {
  const s = clone(seed);
  fn(s);
  return s;
};
const userId = (s, email) => s.user.find((u) => u.email === email).id;
const roleId = (s, code) => s.role.find((r) => r.code === code).id;
const permId = (s, code) => s.permission.find((p) => p.code === code).id;

test('B20-B27/B33/B34/B36: every conflicting or partial existing state rolls back with zero writes', async () => {
  const seed = await bootstrapped();
  const conflicts = {
    'B20 email exists with a different id': (s) => { s.user.find((u) => u.email === 'cajero01@pilot.local').id = randomUUID(); s.userRoleScope = s.userRoleScope.filter((x) => s.user.some((u) => u.id === x.userId)); },
    'B21 deterministic id occupied by another email': (s) => { s.user.find((u) => u.email === 'cajero01@pilot.local').email = 'otro@pilot.local'; },
    'B22 visible name differs': (s) => { s.user.find((u) => u.email === 'vendedor01@pilot.local').name = 'Vendedor'; },
    'B22 user inactive': (s) => { s.user.find((u) => u.email === 'administrador01@pilot.local').isActive = false; },
    'B23 a role missing': (s) => { const id = roleId(s, 'WAREHOUSE'); s.role = s.role.filter((r) => r.id !== id); s.rolePermission = s.rolePermission.filter((g) => g.roleId !== id); s.userRoleScope = s.userRoleScope.filter((x) => x.roleId !== id); },
    'B24 role name differs': (s) => { s.role.find((r) => r.code === 'SELLER').name = 'Vendedor'; },
    'B24 extra MANAGER role': (s) => { s.role.push({ id: randomUUID(), code: 'MANAGER', name: 'MANAGER' }); },
    'B25 extra grant SELLER→USER_MANAGE': (s) => { s.rolePermission.push({ roleId: roleId(s, 'SELLER'), permissionId: permId(s, 'USER_MANAGE') }); },
    'B25 OWNER grant': (s) => { s.rolePermission.push({ roleId: roleId(s, 'OWNER'), permissionId: permId(s, 'SALE_VIEW') }); },
    'B25 missing grant': (s) => { const r = roleId(s, 'CASHIER'); const i = s.rolePermission.findIndex((g) => g.roleId === r); s.rolePermission.splice(i, 1); },
    'B26 seller scoped to another location': (s) => { const sc = s.userRoleScope.find((x) => x.userId === userId(s, 'vendedor01@pilot.local')); sc.locationId = s.location.find((l) => l.code === 'RTB').id; },
    'B26 extra COMPANY scope for cashier': (s) => { s.userRoleScope.push({ id: randomUUID(), userId: userId(s, 'cajero01@pilot.local'), roleId: roleId(s, 'ADMIN'), scopeKind: 'COMPANY', locationId: null }); },
    'B26 legacy UserBranchRole row': (s) => { s.userBranchRole.push({ id: randomUUID(), userId: userId(s, 'cajero01@pilot.local'), branchId: s.branch[0].id, roleId: roleId(s, 'CASHIER') }); },
    'B27 partial: users and scopes absent': (s) => { const ids = new Set(s.user.filter((u) => u.email.endsWith('@pilot.local')).map((u) => u.id)); s.userRoleScope = []; s.user = s.user.filter((u) => !ids.has(u.id)); },
    'B27 partial: catalog absent, rest present': (s) => { s.rolePermission = []; s.userRoleScope = []; s.role = []; s.permission = []; },
    'B33 unknown extra user': (s) => { s.user.push({ id: randomUUID(), email: 'intruso@pilot.local', name: 'Intruso', isActive: true, passwordHash: 'x' }); },
    'B33 second company': (s) => { s.company.push({ ...s.company[0], id: randomUUID(), cuit: 'OTHER-SENTINEL' }); },
    'B33 company fields differ': (s) => { s.company[0].address = 'Otra dirección'; },
    'B33 unknown branch/location group': (s) => { const id = randomUUID(); s.branch.push({ id, code: 'ZZZ', name: 'Z', address: 'Z', pointOfSaleNumber: 99 }); },
    'B34 location id differs from branch id': (s) => { const l = s.location.find((x) => x.code === 'RTB'); l.id = randomUUID(); },
    'B34 second cash register': (s) => { s.cashRegister.push({ id: randomUUID(), branchId: s.branch[0].id, name: 'Caja 2' }); },
    'B34 register renamed': (s) => { s.cashRegister[0].name = 'Caja'; },
    'B34 counter missing': (s) => { s.saleNumberCounter.pop(); },
    'B34 location type differs': (s) => { s.location.find((x) => x.code === 'CDP').type = 'RETAIL_BRANCH'; },
    'B34 POS number differs': (s) => { s.branch.find((x) => x.code === 'RTA').pointOfSaleNumber = 77; },
    'B36 system actor active': (s) => { s.user.find((u) => u.id === CANONICAL.SYSTEM_ACTOR_USER_ID).isActive = true; },
    'B36 system actor missing': (s) => { s.user = s.user.filter((u) => u.id !== CANONICAL.SYSTEM_ACTOR_USER_ID); },
  };
  for (const [label, fn] of Object.entries(conflicts)) {
    const before = mutate(seed, fn);
    const r = await run(EXECUTE, { db: fakeDb({ seed: before }) });
    assert.equal(r.code, 1, label);
    assert.match(r.text, /phase=conflict/, label);
    assert.ok(!r.db.calls.some((c) => /\.(create|createMany)$/.test(c)), `${label}: wrote before detecting the conflict`);
    assert.deepEqual(r.db.tables, before, `${label}: state changed`);
    assert.equal(r.db.stats.commits, 0, label);
    assertNoLeak(r.text);
  }
});

test('B30: the in-transaction marker re-check refuses a different marker or a TEST marker', async () => {
  for (const marker of [{ rows: [{ environment: 'pilot', marker_id: OTHER }], testGuard: false }, { rows: [{ environment: 'pilot', marker_id: MARKER }], testGuard: true }, { rows: [], testGuard: false }]) {
    const r = await run(EXECUTE, { db: fakeDb({ marker }) });
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=conflict/);
    assert.equal(r.db.stats.commits, 0);
    assert.equal(r.db.tables.user.length, 0);
  }
});

test('B30b: the marker re-check accepts the json column as a parsed array or a JSON string, nothing else', async () => {
  const ok = await run(EXECUTE, { db: fakeDb({ marker: { rows: JSON.stringify([{ environment: 'pilot', marker_id: MARKER }]), testGuard: false } }) });
  assert.equal(ok.code, 0, ok.text);
  const bad = await run(EXECUTE, { db: fakeDb({ marker: { rows: '{"not":"an array"}', testGuard: false } }) });
  assert.equal(bad.code, 1);
  assert.equal(bad.db.stats.commits, 0);
});

test('B31/B32: a DB failure mid-bootstrap rolls back everything and stays sanitized', async () => {
  for (const failOn of ['location.create', 'user.create', 'userRoleScope.create']) {
    const r = await run(EXECUTE, { db: fakeDb({ failOn }) });
    assert.equal(r.code, 1, failOn);
    assert.match(r.text, /phase=bootstrap/, failOn);
    assert.equal(r.db.stats.commits, 0);
    assert.equal(r.db.stats.rollbacks, 1);
    for (const t of TABLES) assert.equal(r.db.tables[t].length, 0, `${failOn}: ${t} kept rows`);
    assert.ok(r.db.calls.includes('$disconnect'));
    assertNoLeak(r.text);
  }
});

test('B37: if the post-write verification disagrees, the transaction rolls back', async () => {
  // A canonical sync that also slips in an extra grant must never commit.
  const sneaky = {
    ...CANONICAL,
    syncProductionRbacCatalog: async (tx) => {
      const out = await CANONICAL.syncProductionRbacCatalog(tx);
      await tx.rolePermission.createMany({ data: [{ roleId: out.roleIds.SELLER, permissionId: out.permissionIds.USER_MANAGE }] });
      return out;
    },
  };
  const r = await run(EXECUTE, { canonical: sneaky });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=(verify|conflict|bootstrap)/);
  assert.equal(r.db.stats.commits, 0);
  assert.equal(r.db.tables.rolePermission.length, 0);
});

// --- structure --------------------------------------------------------------------------------

test('B38: source is additive-only and never reaches seed/reset/demo tooling', () => {
  const src = readFileSync(new URL('./pilot-bootstrap.mjs', import.meta.url), 'utf8');
  for (const forbidden of [/\.update\(/, /\.updateMany\(/, /\.upsert\(/, /\.delete\(/, /\.deleteMany\(/, /\$executeRaw/, /\bTRUNCATE\b/i, /\bDELETE FROM\b/i, /\bUPDATE\s+"/i, /seed\.ts|seed-demo|reset-demo|resetDemo|seedDemo|demo-database/]) {
    assert.doesNotMatch(src, forbidden);
  }
});

test('accounts: exactly the five approved Spanish identities with unchanged internal role codes', () => {
  assert.deepEqual(PILOT_ACCOUNTS.map((a) => [a.email, a.name, a.role, a.scope]), [
    ['propietario01@pilot.local', 'Propietario', 'OWNER', 'COMPANY'],
    ['administrador01@pilot.local', 'Administrador', 'ADMIN', 'COMPANY'],
    ['vendedor01@pilot.local', 'Vendedor 01', 'SELLER', 'LOCATION'],
    ['cajero01@pilot.local', 'Cajero 01', 'CASHIER', 'LOCATION'],
    ['deposito01@pilot.local', 'Depósito 01', 'WAREHOUSE', 'LOCATION'],
  ]);
  for (const a of PILOT_ACCOUNTS) assert.match(a.id, /^00000000-0000-4000-9700-00000000000[1-5]$/);
  assert.ok(Object.isFrozen(PILOT_ACCOUNTS));
});

test('private file locations are under ~/.config/mona-jacinta and distinct', () => {
  const dir = path.join(os.homedir(), '.config', 'mona-jacinta');
  assert.equal(CONFIG_FILE, path.join(dir, 'pilot-bootstrap.json'));
  assert.equal(CREDENTIALS_FILE, path.join(dir, 'pilot-credentials.json'));
});

test('loadCanonical exposes the canonical catalog, matrix, system-actor and password modules', async () => {
  const c = await loadCanonical();
  assert.equal(typeof c.syncProductionRbacCatalog, 'function');
  assert.equal(typeof c.bootstrapSystemActor, 'function');
  assert.equal(c.BCRYPT_ROUNDS, 12);
  assert.deepEqual(c.DEFAULT_ROLE_GRANTS, CANONICAL.DEFAULT_ROLE_GRANTS);
});

test('classifyPilotState is exported for independent review (pure, read-only)', () => {
  assert.equal(typeof classifyPilotState, 'function');
});

const snapshotOf = (t) => ({
  roles: t.role, permissions: t.permission, grants: t.rolePermission, companies: t.company, branches: t.branch,
  locations: t.location, registers: t.cashRegister, counters: t.saleNumberCounter,
  users: t.user.map(({ id, email, name, isActive }) => ({ id, email, name, isActive })), scopes: t.userRoleScope, legacy: t.userBranchRole,
});

test('classifyPilotState (own layer, independent of the canonical planner): exact, then an active system actor is a conflict', async () => {
  const seed = await bootstrapped();
  const exact = classifyPilotState(snapshotOf(seed), config(), CANONICAL);
  assert.deepEqual(exact.conflicts, []);
  assert.equal(exact.anchor, 'EXACT');
  const active = mutate(seed, (s) => { s.user.find((u) => u.id === CANONICAL.SYSTEM_ACTOR_USER_ID).isActive = true; });
  const result = classifyPilotState(snapshotOf(active), config(), CANONICAL);
  assert.ok(result.conflicts.some((c) => /system actor/.test(c)), result.conflicts.join('; '));
  const empty = classifyPilotState(snapshotOf(Object.fromEntries(TABLES.map((x) => [x, []]))), config(), CANONICAL);
  assert.deepEqual(empty.conflicts, []);
  assert.equal(empty.anchor, 'ABSENT');
});

// --- H2: dry-run → execute plan approval binding ------------------------------------------------

const DIGEST = /^  plan sha256: ([0-9a-f]{64})$/m;
const zeroDb = (r, label) => {
  assert.equal(r.counters.pgClients.length, 0, `${label}: pg client created`);
  assert.equal(r.counters.prisma.length, 0, `${label}: Prisma created`);
  assert.equal(r.counters.hashes, 0, `${label}: password hashed`);
  assert.equal(r.db.calls.length, 0, `${label}: DB touched`);
};
const REF_B = 'otherpilotref0000002';
const OTHER_MARKER = '0b1c2d3e-4f5a-4b6c-9d7e-8f9a0b1c2d3e';

test('H2/H1: dry-run prints a canonical non-secret plan digest and the exact approval token', async () => {
  const r = await run(DRY);
  assert.equal(r.code, 0, r.text);
  const digest = DIGEST.exec(r.text)?.[1];
  assert.ok(digest, 'dry-run must print "plan sha256: <64 hex>"');
  assert.ok(r.text.includes(`OWNER approval token: --plan=${digest}`));
  assert.match(r.text, /--execute requires this exact digest/);
  assert.equal(DIGEST.exec((await run(DRY)).text)?.[1], digest, 'deterministic');
  zeroDb(r, 'dry-run');
  assertNoLeak(r.text);
});

test('H2/H22-H25: --plan is required with --execute, refused with --dry-run, and must be exactly 64 lowercase hex', () => {
  const good = 'ab'.repeat(32);
  assert.equal(parseCliArgs([...EXECUTE, `--plan=${good}`]).ok, true);
  for (const argv of [
    EXECUTE,
    [...DRY, `--plan=${good}`],
    [...EXECUTE, `--plan=${good}`, `--plan=${good}`],
    [...EXECUTE, `--plan=${good.toUpperCase()}`],
    [...EXECUTE, `--plan=${'g'.repeat(64)}`],
    [...EXECUTE, `--plan=${good.slice(1)}`],
    [...EXECUTE, `--plan=${good}0`],
    [...EXECUTE, `--plan= ${good}`],
    [...EXECUTE, `--plan=${good} `],
    [...EXECUTE, '--plan'],
    [...EXECUTE, '--plan='],
    [...EXECUTE, `--Plan=${good}`],
  ]) {
    assert.equal(parseCliArgs(argv).ok, false, argv.at(-1));
  }
});

test('H2/H23: execute without --plan stops at phase=args before reading anything', async () => {
  const r = await run(EXECUTE, { plan: false });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=args/);
  zeroDb(r, 'no plan');
});

test('H2/H21: a well-formed but wrong digest stops at phase=plan with zero DB, Prisma or hashing', async () => {
  const r = await run(EXECUTE, { plan: 'f'.repeat(64) });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=plan/);
  zeroDb(r, 'wrong digest');
});

test('H2/H2: the exact approved digest passes the plan gate and the canonical bootstrap commits', async () => {
  const f = files();
  const digest = await approvedDigest(EXECUTE, { files: f });
  assert.ok(digest);
  const r = await run(EXECUTE, { files: f, plan: digest });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.db.stats.commits, 1);
});

const cfgWith = (fn) => {
  const c = config();
  fn(c);
  return c;
};
test('H2/H3-H14/H25: any business change after the reviewed dry-run refuses execute with the stale digest', async () => {
  const approved = await approvedDigest(EXECUTE, { files: files() });
  assert.ok(approved);
  const planFail = {
    'H3 company name': (c) => { c.company.name = 'Mona Jacinta PILOT Dos'; },
    'H4 company address': (c) => { c.company.address = 'Otro domicilio sintético PILOT'; },
    'H6 retail name': (c) => { c.locations[0].name = 'Centro Norte PILOT'; },
    'H7 location code (assignments follow)': (c) => { c.locations[0].code = 'RTZ'; c.assignments['vendedor01@pilot.local'] = 'RTZ'; c.assignments['cajero01@pilot.local'] = 'RTZ'; },
    'H8 POS number': (c) => { c.locations[1].pointOfSaleNumber = 42; },
    'H10 seller assignment': (c) => { c.assignments['vendedor01@pilot.local'] = 'RTB'; },
    'H11 cashier assignment': (c) => { c.assignments['cajero01@pilot.local'] = 'RTB'; },
    'H13 location added': (c) => { c.locations.push({ code: 'RTC', name: 'Sucursal C PILOT', type: 'RETAIL_BRANCH', address: 'Domicilio sintético PILOT — C', pointOfSaleNumber: 13 }); },
    'H14 location removed': (c) => { c.locations.splice(1, 1); },
  };
  for (const [label, fn] of Object.entries(planFail)) {
    const r = await run(EXECUTE, { files: files({ cfg: cfgWith(fn) }), plan: approved });
    assert.equal(r.code, 1, label);
    assert.match(r.text, /phase=plan/, label);
    zeroDb(r, label);
  }
  const configFail = {
    'H5 CUIT changed': (c) => { c.company.cuit = '30-71234567-1'; },
    'H9 warehouse type changed': (c) => { c.locations[2].type = 'RETAIL_BRANCH'; },
    'H12 warehouse assignment to a retail branch': (c) => { c.assignments['deposito01@pilot.local'] = 'RTA'; },
  };
  for (const [label, fn] of Object.entries(configFail)) {
    const r = await run(EXECUTE, { files: files({ cfg: cfgWith(fn) }), plan: approved });
    assert.equal(r.code, 1, label);
    assert.match(r.text, /phase=config/, label);
    zeroDb(r, label);
  }
});

test('H2/H17/H18: the digest binds the marker id and the derived project ref', async () => {
  const approved = await approvedDigest(EXECUTE, { files: files() });
  const otherMarker = await run(EXECUTE.map((a) => (a.startsWith('--marker-id=') ? `--marker-id=${OTHER_MARKER}` : a)), { plan: approved });
  assert.equal(otherMarker.code, 1);
  assert.match(otherMarker.text, /phase=plan/);
  zeroDb(otherMarker, 'marker');
  const otherProject = await run(EXECUTE.map((a) => (a.startsWith('--confirm-project-ref=') ? `--confirm-project-ref=${REF_B}` : a)), {
    files: files({ url: `postgresql://postgres.${REF_B}:${SECRET}@${HOST}:6543/postgres\n` }),
    plan: approved,
  });
  assert.equal(otherProject.code, 1);
  assert.match(otherProject.text, /phase=plan/);
  zeroDb(otherProject, 'project');
});

test('H2/H19/H20: formatting, key order, location order and assignment order do not change the digest', async () => {
  const base = await approvedDigest(EXECUTE, { files: files() });
  const c = config();
  const reordered = {
    assignments: Object.fromEntries(Object.entries(c.assignments).reverse()),
    locations: [...c.locations].reverse().map((l) => ({ pointOfSaleNumber: l.pointOfSaleNumber, address: l.address, type: l.type, name: l.name, code: l.code })),
    company: { address: c.company.address, cuit: c.company.cuit, name: c.company.name },
  };
  const compact = privateFile(JSON.stringify(reordered));
  const spaced = privateFile(`\n\n${JSON.stringify(reordered, null, 7)}\n\n`);
  for (const configFile of [compact, spaced]) {
    assert.equal(await approvedDigest(EXECUTE, { files: { ...files(), configFile } }), base);
  }
});

test('H2/H15/H16/H34/H33: canonicalPlan binds account descriptors and the RBAC model, and excludes every secret', () => {
  const input = { markerId: MARKER, projectRef: REF, config: config(), canonical: CANONICAL };
  const base = planDigest(input);
  assert.match(base, /^[0-9a-f]{64}$/);
  const renamed = PILOT_ACCOUNTS.map((a, i) => (i === 3 ? { ...a, name: 'Cajero Uno' } : a));
  const remapped = PILOT_ACCOUNTS.map((a, i) => (i === 2 ? { ...a, role: 'CASHIER' } : a));
  assert.notEqual(planDigest({ ...input, accounts: renamed }), base, 'visible name');
  assert.notEqual(planDigest({ ...input, accounts: remapped }), base, 'role mapping');
  const grants = structuredClone(CANONICAL.DEFAULT_ROLE_GRANTS);
  grants.SELLER = [...grants.SELLER, 'USER_MANAGE'];
  assert.notEqual(planDigest({ ...input, canonical: { ...CANONICAL, DEFAULT_ROLE_GRANTS: grants } }), base, 'RBAC model');
  const text = canonicalPlan(input);
  assert.ok(text.startsWith('mona-jacinta-pilot-bootstrap-plan-v1\n'));
  for (const secret of [SECRET, HOST, `postgres.${REF}`, URL_TEXT, '6543', ...Object.values(PASSWORDS), '$2a$', '$2b$', 'synthetic-hash']) {
    assert.ok(!text.includes(secret), `plan contains ${secret.slice(0, 10)}…`);
  }
  for (const email of Object.keys(PASSWORDS)) assert.ok(text.includes(email), 'credential key set is bound');
});

test('H2/H26: the config file is read once; a rewrite during execute is ignored and the held plan is used', async () => {
  const f = files();
  const approved = await approvedDigest(EXECUTE, { files: f });
  const pg = fakePg({ onQuery: () => writeFileSync(f.configFile, JSON.stringify(config({ company: { ...COMPANY, name: 'Reescrita PILOT' } }))) });
  const r = await run(EXECUTE, { files: f, plan: approved, pg });
  assert.equal(r.code, 0, r.text);
  assert.equal(r.db.tables.company[0].name, COMPANY.name);
});

test('H2/H27: valid password changes do not change the digest; execute uses the execute-time passwords', async () => {
  const approved = await approvedDigest(EXECUTE, { files: files() });
  const rotated = Object.fromEntries(Object.entries(PASSWORDS).map(([e, p]) => [e, `${p}-Rot9x`]));
  assert.equal(await approvedDigest(EXECUTE, { files: files({ creds: rotated }) }), approved);
  const r = await run(EXECUTE, { files: files({ creds: rotated }), plan: approved });
  assert.equal(r.code, 0, r.text);
  const owner = r.db.tables.user.find((u) => u.email === 'propietario01@pilot.local');
  assert.equal(owner.passwordHash, `synthetic-hash:${rotated['propietario01@pilot.local'].length}`);
});

test('H2/H28/H29: credential key-set changes and weak passwords fail at phase=config even with the approved digest', async () => {
  const approved = await approvedDigest(EXECUTE, { files: files() });
  const missing = { ...PASSWORDS };
  delete missing['deposito01@pilot.local'];
  for (const creds of [missing, { ...PASSWORDS, 'extra@pilot.local': 'Extra-Synth-1aB2cD3eF4gH' }, { ...PASSWORDS, 'cajero01@pilot.local': 'short' }]) {
    const r = await run(EXECUTE, { files: files({ creds }), plan: approved });
    assert.equal(r.code, 1);
    assert.match(r.text, /phase=config/);
    zeroDb(r, 'credentials');
  }
});

test('H2/H30: the digest is re-derived from the held plan right before the transaction; in-process drift stops it', async () => {
  const drifting = { ...CANONICAL, DEFAULT_ROLE_GRANTS: structuredClone(CANONICAL.DEFAULT_ROLE_GRANTS) };
  const approved = await approvedDigest(EXECUTE, { files: files(), dryCanonical: drifting });
  let drifted = false;
  const pg = fakePg({
    onQuery: () => {
      if (!drifted) {
        drifted = true;
        drifting.DEFAULT_ROLE_GRANTS.SELLER.push('USER_MANAGE');
      }
    },
  });
  const r = await run(EXECUTE, { plan: approved, pg, canonical: drifting });
  assert.equal(r.code, 1, r.text);
  assert.match(r.text, /phase=plan/);
  assert.equal(r.counters.pgClients.length, 1, 'the identity proof ran');
  assert.equal(r.counters.prisma.length, 0, 'no Prisma after a failed second comparison');
  assert.equal(r.db.calls.length, 0);
});

test('H2/H31: an identity failure after the plan gate passes still writes nothing', async () => {
  const r = await run(EXECUTE, { pg: fakePg({ testGuard: true }) });
  assert.equal(r.code, 1);
  assert.match(r.text, /phase=identity/);
  assert.equal(r.counters.prisma.length, 0);
});
