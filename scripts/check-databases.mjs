import { loadEnvFile } from 'node:process';
import { readFileSync } from 'node:fs';
import pg from 'pg';

const { Client } = pg;

const ENV_FILE = '.env.development';
const DEV_VAR = 'DATABASE_URL';
const TEST_VAR = 'TEST_DATABASE_URL';
const MIN_PG_MAJOR = 16;
const DEFAULT_PORT = '5432';
const CONNECT_TIMEOUT_MS = 10000;

function fail(message) {
  console.error(`[db:check] FAIL: ${message}`);
  process.exit(1);
}

function parsePgUrl(raw) {
  const url = new URL(raw);
  return {
    host: url.hostname.toLowerCase(),
    port: url.port || DEFAULT_PORT,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || '',
    username: decodeURIComponent(url.username) || '',
  };
}

function clientFor(raw, ca, varName) {
  // pg URL TLS options replace the explicit ssl object, including its trusted CA.
  const params = new URL(raw).searchParams;
  if (['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat'].some(key => params.has(key))) {
    fail(`${varName} must not contain TLS query options; db:check configures verified TLS explicitly (see docs/development/database.md)`);
  }
  return new Client({
    connectionString: raw,
    ssl: { rejectUnauthorized: true, ca },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
}

async function queryMetadata(client) {
  if (!client.connection.stream.encrypted || !client.connection.stream.authorized) {
    throw new Error('Verified TLS is required before querying database metadata');
  }
  const result = await client.query(
    `SELECT
       current_database()          AS current_database,
       current_user                AS current_user,
       host(inet_server_addr())    AS server_addr,
       inet_server_port()          AS server_port,
       version()                   AS version`
  );
  const row = result.rows[0];
  let systemId = null;
  try {
    const sys = await client.query(
      'SELECT system_identifier::text AS system_id FROM pg_control_system()'
    );
    if (sys.rows.length > 0 && sys.rows[0].system_id != null) {
      systemId = String(sys.rows[0].system_id);
    }
  } catch {
    systemId = null;
  }
  return {
    currentDatabase: String(row.current_database),
    currentUser: String(row.current_user),
    serverAddr: row.server_addr == null ? null : String(row.server_addr),
    serverPort: row.server_port == null ? null : String(row.server_port),
    version: String(row.version),
    systemId,
  };
}

function parseVersionMajor(version) {
  const match = version.match(/PostgreSQL\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function compareSignals(a, b) {
  const strong = [];
  if (a.host !== b.host) strong.push('hostname');
  if (a.username !== b.username) strong.push('username');
  if (a.currentUser != null && b.currentUser != null && a.currentUser !== b.currentUser) {
    strong.push('current_user');
  }
  if (a.serverAddr != null && b.serverAddr != null && a.serverAddr !== b.serverAddr) {
    strong.push('inet_server_addr');
  }
  if (a.systemId != null && b.systemId != null && a.systemId !== b.systemId) {
    strong.push('system_identifier');
  }

  const staticDistinct = a.host !== b.host || a.username !== b.username;
  const liveDistinct =
    (a.currentUser != null && b.currentUser != null && a.currentUser !== b.currentUser) ||
    (a.serverAddr != null && b.serverAddr != null && a.serverAddr !== b.serverAddr) ||
    (a.systemId != null && b.systemId != null && a.systemId !== b.systemId);

  return { strong, staticDistinct, liveDistinct, distinct: staticDistinct && liveDistinct };
}

function formatMajor(version) {
  const major = parseVersionMajor(version);
  return major != null ? `${major}.x` : 'unknown';
}

async function main() {
  try {
    loadEnvFile(ENV_FILE);
  } catch {
    fail(`could not load ${ENV_FILE} (create it locally with real server-only connection strings; never commit it)`);
  }

  const devUrl = process.env[DEV_VAR];
  const testUrl = process.env[TEST_VAR];

  if (!devUrl) fail(`${DEV_VAR} is missing`);
  if (!testUrl) fail(`${TEST_VAR} is missing`);

  if (devUrl === testUrl) fail(`${DEV_VAR} and ${TEST_VAR} must be different raw connection strings`);

  let devParsed;
  let testParsed;
  try {
    devParsed = parsePgUrl(devUrl);
  } catch {
    fail(`${DEV_VAR} is not a parseable PostgreSQL URL`);
  }
  try {
    testParsed = parsePgUrl(testUrl);
  } catch {
    fail(`${TEST_VAR} is not a parseable PostgreSQL URL`);
  }

  let ca;
  try {
    ca = readFileSync(new URL('./certs/supabase-prod-ca-2021.crt', import.meta.url), 'utf8');
  } catch {
    fail('could not read the bundled Supabase CA certificate (see docs/development/database.md)');
  }

  const devClient = clientFor(devUrl, ca, DEV_VAR);
  const testClient = clientFor(testUrl, ca, TEST_VAR);

  let devMeta;
  let testMeta;
  try {
    await devClient.connect();
    devMeta = await queryMetadata(devClient);
  } catch (err) {
    fail(`could not connect to ${DEV_VAR}: ${err?.code ?? 'connection failed'}`);
  } finally {
    await devClient.end().catch(() => {});
  }

  try {
    await testClient.connect();
    testMeta = await queryMetadata(testClient);
  } catch (err) {
    fail(`could not connect to ${TEST_VAR}: ${err?.code ?? 'connection failed'}`);
  } finally {
    await testClient.end().catch(() => {});
  }

  const sig = compareSignals(
    { ...devParsed, ...devMeta },
    { ...testParsed, ...testMeta }
  );

  if (!sig.distinct) {
    const reason = !sig.staticDistinct
      ? 'parsed connection identity components (hostname/username) are not distinct'
      : 'live server identity could not be proven distinct (inet_server_addr masked/equal and pg_control_system unavailable — possible pooled connection mode masking server metadata)';
    fail(
      `cannot establish distinct Supabase project/database identities (failing closed). ${reason}. Differing signals: [${sig.strong.join(', ') || 'none'}].`
    );
  }

  for (const [varName, meta] of [
    [DEV_VAR, devMeta],
    [TEST_VAR, testMeta],
  ]) {
    const major = parseVersionMajor(meta.version);
    if (major == null || major < MIN_PG_MAJOR) {
      fail(
        `${varName} reports unsupported PostgreSQL version (${meta.version || 'unknown'}); Prisma 7.10.x requires ${MIN_PG_MAJOR}+`
      );
    }
  }

  console.log('[db:check] OK');
  console.log('  DEV/DEMO reachable: yes');
  console.log('  TEST reachable: yes');
  console.log('  TLS certificate and hostname verification: enabled (both connections authorized)');
  console.log(`  PostgreSQL versions: DEV=${formatMajor(devMeta.version)} TEST=${formatMajor(testMeta.version)}`);
  console.log('  distinct identities proven: yes');
  console.log(`  signals used: ${sig.strong.join(', ') || 'none'}`);
}

await main();
