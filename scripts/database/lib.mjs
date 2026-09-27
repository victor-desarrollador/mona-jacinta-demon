import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import pg from 'pg';

const { Client } = pg;

// Local, gitignored artifact directory (see .gitignore) — never a tracked path.
export const ARTIFACT_DIR = fileURLToPath(new URL('../../backups/database/', import.meta.url));
export const CA_PATH = fileURLToPath(new URL('../certs/supabase-prod-ca-2021.crt', import.meta.url));

export function utcTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export function artifactName(environment, purpose) {
  return `${environment}_${purpose}_${utcTimestamp()}.dump`;
}

// Only what pg_dump/pg_restore need as libpq environment variables — never the
// raw connection string, and never passed as a literal CLI argument.
export function parseConnection(raw) {
  const url = new URL(raw);
  return {
    host: url.hostname,
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}

function pgEnv(conn) {
  return {
    PATH: process.env.PATH,
    PGHOST: conn.host,
    PGPORT: conn.port,
    PGDATABASE: conn.database,
    PGUSER: conn.user,
    PGPASSWORD: conn.password,
    PGSSLMODE: 'verify-full',
    PGSSLROOTCERT: CA_PATH,
  };
}

export function redact(text, conn) {
  let out = text;
  for (const secret of [conn.password, conn.host, conn.user]) {
    if (secret) out = out.split(secret).join('«redacted»');
  }
  return out;
}

// Runs pg_dump/pg_restore with credentials only via env (never argv, never a
// connection string), and never echoes unredacted output on failure.
export function runPgTool(bin, args, conn) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env: pgEnv(conn), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.on('error', (err) => {
      reject(new Error(`${bin} failed to start: ${err.code ?? err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout: redact(stdout, conn) });
      } else {
        reject(new Error(`${bin} exited with code ${code}: ${redact(stderr, conn).slice(0, 4000)}`));
      }
    });
  });
}

// Same verified-TLS shape as scripts/check-databases.mjs's clientFor: rejectUnauthorized
// plus an explicit trusted CA gives certificate *and* hostname verification (Node's tls
// module runs its default checkServerIdentity unless overridden, which this doesn't do).
function createVerifiedPgClient(conn) {
  return new Client({
    host: conn.host,
    port: Number(conn.port),
    database: conn.database,
    user: conn.user,
    password: conn.password,
    ssl: { rejectUnauthorized: true, ca: readFileSync(CA_PATH, 'utf8') },
    connectionTimeoutMillis: 10000,
  });
}

// `createClient` is a test seam only; production callers use the default above.
export async function withVerifiedClient(conn, fn, createClient = createVerifiedPgClient) {
  const client = createClient(conn);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    // Cleanup never replaces fn(client)'s outcome. client.end() is evaluated inside
    // this try, so a synchronous throw is contained as well as a rejection
    // (an eager `client.end().catch()` would miss the synchronous case).
    try {
      await client.end();
    } catch {
      /* the primary outcome stands */
    }
  }
}

// Row counts for `tables` (or, if omitted, every table in the `public` schema,
// discovered dynamically — never a hand-picked/hardcoded subset). Used by both
// backup.mjs (to capture a logical-state manifest at backup time) and restore.mjs
// (to verify the restored state matches that manifest exactly).
export async function tableRowCounts(conn, tables) {
  return withVerifiedClient(conn, async (client) => {
    let names = tables;
    if (!names) {
      const result = await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
      );
      names = result.rows.map((row) => row.tablename);
    }
    const counts = {};
    for (const name of names) {
      const result = await client.query(`SELECT count(*)::int AS n FROM "${name}"`);
      counts[name] = result.rows[0].n;
    }
    return counts;
  });
}

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// TEST-only identity marker schema (installed by scripts/database/test-marker.mjs).
// It must never travel between environments: backup.mjs already dumps only
// --schema=public, and restore.mjs refuses any archive whose table of contents
// names this schema. Comment lines (';') are archive metadata, not entries.
export const TEST_GUARD_SCHEMA = 'mona_test_guard';

export function archiveContainsTestGuardSchema(tocText) {
  const pattern = new RegExp(`\\b${TEST_GUARD_SCHEMA}\\b`);
  return tocText
    .split('\n')
    .some((line) => !line.trimStart().startsWith(';') && pattern.test(line));
}

// --- TEST-only bootstrap helpers (marker installer + TEST backup) -------------
// Used before the TEST identity marker exists. They read TEST configuration only
// and never DATABASE_URL. The project-ref attestation below is a one-time
// administrative bootstrap check; once the marker is installed, TEST tooling and
// the integration-test runtime guard must prove TEST from the live marker instead.

export const TEST_VAR = 'TEST_DATABASE_URL';
export const MARKER_VAR = 'TEST_DATABASE_MARKER_ID';
export const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/;
const TEST_BACKUP_NAME = /^test_[a-z-]+_\d{8}T\d{6}Z\.dump$/;

// Reads only TEST_DATABASE_URL and the pinned marker id; DATABASE_URL is never
// looked up. Well-formedness only — this is not an identity proof.
export function readTestConfig(envText) {
  let parsed;
  try {
    parsed = parseEnv(envText);
  } catch {
    return { ok: false };
  }
  const raw = parsed[TEST_VAR];
  if (!raw) return { ok: false };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false };
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname ||
    !url.username ||
    !url.password ||
    !url.pathname ||
    url.pathname === '/' ||
    url.search ||
    url.hash
  ) {
    return { ok: false };
  }
  return { ok: true, testUrl: raw, pinnedMarkerId: parsed[MARKER_VAR] };
}

// Owner attestation: the ref the owner names must be the tenant TEST_DATABASE_URL
// routes to. A necessary extra condition for bootstrap tooling — never printed,
// and never the runtime identity proof, which is the marker itself.
export function matchesProjectRef(testUrl, ref) {
  try {
    return decodeURIComponent(new URL(testUrl).username) === `postgres.${ref}`;
  } catch {
    return false;
  }
}

// --- TEST backup set contract: mona-test-backup/v1 ---------------------------
// A TEST backup set is exactly two files:
//   test_<purpose>_<ts>.dump                 pg_dump custom archive (public schema only)
//   test_<purpose>_<ts>.dump.manifest.json   canonical manifest binding this run
// The manifest carries a per-run setId, the dump's file name, byte size and SHA-256,
// the row counts captured for the same run, and manifestSha256 over the canonical
// JSON of everything else. It detects mixed runs, edits and truncation; it is not a
// signature against someone able to rewrite both files (no secret key exists here).

export const BACKUP_FORMAT = 'mona-test-backup/v1';
export const BACKUP_PURPOSES = ['manual', 'pre-migration', 'scheduled', 'drill'];
// pg_restore --list reads only the local archive; empty libpq settings, no secrets.
export const LIST_CONN = { host: '', port: '', database: '', user: '', password: '' };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// Counts keys become quoted identifiers in tableRowCounts; only plain names are allowed.
const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MANIFEST_KEYS = ['counts', 'createdAt', 'dump', 'environment', 'format', 'manifestSha256', 'purpose', 'setId'];
const DUMP_KEYS = ['bytes', 'file', 'sha256'];
// pg_restore --list prints every entry as "%d; %u %u %s %s %s %s" (dump id, table
// oid, oid, desc, schema, tag, owner) with the tag unquoted; comment lines start ';'.
const TOC_ENTRY = /^(\d+); (\d+) (\d+) (.+)$/;
const TABLE_DATA_PREFIX = 'TABLE DATA ';

export function manifestPathFor(dumpPath) {
  return `${dumpPath}.manifest.json`;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

export function validCounts(counts) {
  return (
    counts !== null &&
    typeof counts === 'object' &&
    !Array.isArray(counts) &&
    Object.keys(counts).length > 0 &&
    Object.entries(counts).every(([table, n]) => PLAIN_IDENTIFIER.test(table) && Number.isInteger(n) && n >= 0)
  );
}

// The one serialization of a manifest value. JSON.stringify emits each own
// property of every object exactly once, so its output never holds a duplicate key
// at any depth, and it has a single spelling for every key, string and number.
export function renderBackupManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function buildBackupManifest({ setId, createdAt, purpose, file, bytes, sha256, counts }) {
  const body = { format: BACKUP_FORMAT, environment: 'test', setId, createdAt, purpose, dump: { file, bytes, sha256 }, counts };
  return renderBackupManifest({ ...body, manifestSha256: sha256Text(canonicalJson(body)) });
}

// Returns the manifest only if every field is exactly as the contract requires.
//
// One document, one meaning: the raw bytes must be strict UTF-8 (no BOM) and
// byte-identical to renderBackupManifest(JSON.parse(raw)). JSON.parse alone would
// silently resolve duplicate keys (last wins) and accept alternative spellings;
// requiring the canonical rendering means the accepted inputs are exactly the
// renderer's outputs, which contain no duplicate keys (at any depth, however a key
// is escaped), no alternative escapes and no alternative whitespace. This check
// runs before any field is interpreted.
export function parseBackupManifest(raw, expectedFile) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');
  let manifest;
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    manifest = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Buffer.from(renderBackupManifest(manifest), 'utf8').equals(bytes)) return null;
  if (!hasExactKeys(manifest, MANIFEST_KEYS)) return null;
  const { manifestSha256, ...body } = manifest;
  if (typeof manifestSha256 !== 'string' || manifestSha256 !== sha256Text(canonicalJson(body))) return null;
  const { format, environment, setId, createdAt, purpose, dump, counts } = manifest;
  if (format !== BACKUP_FORMAT || environment !== 'test') return null;
  if (typeof setId !== 'string' || !UUID_V4.test(setId)) return null;
  if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null;
  if (!BACKUP_PURPOSES.includes(purpose)) return null;
  if (!hasExactKeys(dump, DUMP_KEYS)) return null;
  if (dump.file !== expectedFile || !TEST_BACKUP_NAME.test(dump.file) || !dump.file.startsWith(`test_${purpose}_`)) return null;
  if (!Number.isInteger(dump.bytes) || dump.bytes <= 0) return null;
  if (typeof dump.sha256 !== 'string' || !SHA256_HEX.test(dump.sha256)) return null;
  if (!validCounts(counts)) return null;
  return manifest;
}

// The archive must hold exactly one TABLE DATA entry for each table the manifest
// counted, all in public, and nothing from the TEST identity marker schema.
//
// Every non-blank, non-comment line must be a well-formed entry with a dump id not
// seen before. A TABLE DATA entry's schema and tag must both be plain identifiers,
// so no quoting or case-folding rules apply: for accepted names the printed tag IS
// the canonical identity, and any quoted or unusual spelling is rejected rather
// than normalised. Uniqueness is proven entry by entry before any comparison.
export function checkArchiveToc(tocText, counts) {
  if (archiveContainsTestGuardSchema(tocText)) return 'archive contains the TEST identity marker schema';
  const dumpIds = new Set();
  const tables = new Map();
  for (const line of tocText.split('\n')) {
    if (line.trim() === '' || line.startsWith(';')) continue;
    const entry = TOC_ENTRY.exec(line);
    if (!entry) return 'archive table of contents has an unrecognised line';
    if (dumpIds.has(entry[1])) return 'archive table of contents repeats an entry id';
    dumpIds.add(entry[1]);
    if (!entry[4].startsWith(TABLE_DATA_PREFIX)) continue;
    const tokens = entry[4].slice(TABLE_DATA_PREFIX.length).split(' ');
    if (tokens.length === 3 && tokens[2] === '') tokens.pop(); // empty owner
    if (tokens.length < 2 || tokens.length > 3 || tokens.some((t) => t === '')) {
      return 'archive has an unrecognised TABLE DATA entry';
    }
    const [schema, table] = tokens;
    if (!PLAIN_IDENTIFIER.test(schema) || !PLAIN_IDENTIFIER.test(table)) {
      return 'archive TABLE DATA entry is not a plain schema/table identifier';
    }
    if (schema !== 'public') return 'archive holds table data outside the public schema';
    if (tables.has(table)) return 'archive holds more than one TABLE DATA entry for the same table';
    tables.set(table, entry[1]);
  }
  if (tables.size === 0) return 'archive contains no table data';
  const expected = Object.keys(counts);
  if (tables.size !== expected.length || !expected.every((table) => tables.has(table))) {
    return 'archive tables do not match the manifest row counts';
  }
  return null;
}

function fileIdentity(stat) {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

// Copies from the pinned descriptor (positional reads) into the snapshot while
// hashing, so the digest is of exactly the bytes the snapshot holds.
function copyAndHash(sourceFd, destination) {
  const hash = createHash('sha256');
  const out = openSync(destination, 'wx', 0o600);
  const buffer = Buffer.alloc(1024 * 1024);
  let position = 0;
  try {
    for (;;) {
      const read = readSync(sourceFd, buffer, 0, buffer.length, position);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
      writeSync(out, buffer, 0, read);
      position += read;
    }
  } finally {
    closeSync(out);
  }
  return { bytes: position, sha256: hash.digest('hex') };
}

// Consumer-side proof that a TEST backup set is real, complete and one run.
// The dump and manifest are opened once (O_NOFOLLOW) and stay open; the dump is
// copied into a private snapshot (mkdtemp, 0700) and everything is checked on that
// snapshot. The returned handle:
//   snapshotPath      — the exact verified bytes; restore reads this, never the original
//   assertUnchanged() — true only while both original paths still name the same,
//                       unmodified inodes (dev/ino/size/mtime/ctime, no symlink)
//   dispose()         — closes descriptors and removes the snapshot
export async function verifyBackupPair({ dumpPath, manifestPath, expectedFile }, deps = {}) {
  const run = deps.runPgTool ?? runPgTool;
  const tmpRoot = deps.tmpRoot ?? os.tmpdir();
  const fds = [];
  let snapshotDir = null;
  const release = () => {
    for (const fd of fds.splice(0)) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    if (snapshotDir) rmSync(snapshotDir, { recursive: true, force: true });
    snapshotDir = null;
  };
  const reject = (reason) => {
    release();
    return { ok: false, reason };
  };
  try {
    if (!TEST_BACKUP_NAME.test(expectedFile)) return reject('artifact name is not test_<purpose>_<timestamp>.dump');
    const pin = (filePath) => {
      const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      fds.push(fd);
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw new Error('not a regular file');
      return { fd, filePath, id: fileIdentity(stat) };
    };
    let dump;
    let manifestFile;
    try {
      dump = pin(dumpPath);
      manifestFile = pin(manifestPath);
    } catch {
      return reject('dump or manifest is missing, not a regular file, or a symlink');
    }
    if (manifestFile.id.size > MAX_MANIFEST_BYTES) return reject('manifest is too large');
    const manifest = parseBackupManifest(readFileSync(manifestFile.fd), expectedFile);
    if (!manifest) return reject('manifest is malformed, incomplete, for another file, or fails its self-digest');

    snapshotDir = mkdtempSync(path.join(tmpRoot, 'mona-backup-verify-'));
    const snapshotPath = path.join(snapshotDir, expectedFile);
    const copied = copyAndHash(dump.fd, snapshotPath);
    const stillSame = [dump, manifestFile].every((f) => sameIdentity(fileIdentity(fstatSync(f.fd)), f.id));
    if (!stillSame) return reject('artifact changed while it was being verified');
    if (copied.bytes !== manifest.dump.bytes || copied.sha256 !== manifest.dump.sha256) {
      return reject('dump does not match its manifest (size or sha256)');
    }

    let toc;
    try {
      toc = await run('pg_restore', ['--list', snapshotPath], LIST_CONN);
    } catch {
      return reject('dump is not a readable PostgreSQL custom archive');
    }
    const problem = checkArchiveToc(String(toc?.stdout ?? ''), manifest.counts);
    if (problem) return reject(problem);

    const pinned = [dump, manifestFile];
    return {
      ok: true,
      name: expectedFile,
      setId: manifest.setId,
      sha256: copied.sha256,
      counts: manifest.counts,
      snapshotPath,
      assertUnchanged: () =>
        pinned.every((f) => {
          try {
            const link = lstatSync(f.filePath);
            return (
              !link.isSymbolicLink() &&
              sameIdentity(fileIdentity(link), f.id) &&
              sameIdentity(fileIdentity(fstatSync(f.fd)), f.id)
            );
          } catch {
            return false;
          }
        }),
      dispose: release,
    };
  } catch {
    return reject('artifact could not be verified');
  }
}

export function openVerifiedBackup(file, deps = {}) {
  const dumpPath = path.resolve(file);
  return verifyBackupPair({ dumpPath, manifestPath: manifestPathFor(dumpPath), expectedFile: path.basename(dumpPath) }, deps);
}
