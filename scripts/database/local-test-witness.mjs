import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';

// V2.3.3 R4 evidence helper: digest-only PRE/POST state witnesses, the OWNER authorization record shape,
// the unknown-commit outcome classifier and the durable witness persistence protocol.
//
// Pure Node: no database, no Prisma, no child process. Every artifact built here contains identity,
// binding and digests ONLY (closed key sets, per-key patterns on write and read): a protected value
// (password hash, e-mail, name, AuditLog JSON) cannot be written into a slot because the slot's pattern
// refuses it. A witness is tamper-EVIDENCE (self-hash), not authentication against the same OS user.
// A POST witness says "expected post-commit state"; whether the commit happened is established only
// by the verifier from the database (witness presence is never commit evidence).

export const SCHEME = 'MONA/V233/STATE-DIGEST/SD1';
export const TARGET = 'mona_local_test@127.0.0.1:5432/mona_local_test';
export const PRE_FORMAT = 'mona-local-test-pre-witness/v1';
export const POST_FORMAT = 'mona-local-test-resume-post-witness/v1';
export const POST_STATE = 'PRECOMMIT_EXPECTED_POST';
export const AUTH_FORMAT = 'mona-local-test-resume-authorization/v1';
export const AUTH_ACTION = 'resume-seed-2';
export const AUTH_MAX_TTL_MS = 2 * 60 * 60 * 1000;
export const WITNESS_MAX_BYTES = 4096;
// The 25 protected relations (raw-byte order), mirrored from api/scripts/local-test-fingerprint.ts PROTECTED_RELATIONS; a vitest
// test (local-test-fingerprint.test.ts) pins the two lists against each other so they cannot drift.
export const PROTECTED_RELATION_NAMES = Object.freeze([
  'AuditLog', 'Branch', 'Brand', 'CashMovement', 'CashRegister', 'CashSession', 'Category', 'Company', 'Inventory', 'Location', 'Permission', 'Product',
  'ProductVariant', 'Role', 'RolePermission', 'Sale', 'SaleItem', 'SaleNumberCounter', 'SalePayment', 'StockMovement', 'StockReservation', 'User',
  'UserBranchRole', 'UserRoleScope', '_prisma_migrations',
]);
export const WITNESS_DEADLINE_MS = 5000;

const u32 = (n) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw new Error('length out of range');
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
// str(s) = u32(len(UTF-8 s)) || UTF-8 s — the R3 framing primitive; every label is framed, never concatenated raw.
export const frameStr = (s) => {
  const body = Buffer.from(s, 'utf8');
  return Buffer.concat([u32(body.length), body]);
};
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const HEX64 = /^[0-9a-f]{64}$/;
const ID32 = /^[0-9a-f]{32}$/;
// the backup run name exactly as the manifest's `run` and the run directory: local-test-<UTC stamp>-<8 hex>
const RUN = /^local-test-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$/;
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const CHECKPOINT_ID = /^cp-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{32}$/;
const eq = (value) => (x) => x === value;
const re = (pattern) => (x) => typeof x === 'string' && pattern.test(x);
const instant = (x) => re(TIME)(x) && !Number.isNaN(Date.parse(x)) && new Date(x).toISOString() === x;

export const PRE_SPEC = Object.freeze([
  ['format', eq(PRE_FORMAT)],
  ['digestScheme', eq(SCHEME)],
  ['streamFormat', eq(3)],
  ['target', eq(TARGET)],
  ['markerIdSha256', re(HEX64)],
  ['serverVersionNum', re(/^17[0-9]{4}$/)],
  ['protectedDomainContractSha256', re(HEX64)],
  ['fPre', re(HEX64)],
]);
export const POST_SPEC = Object.freeze([
  ['format', eq(POST_FORMAT)],
  ['state', eq(POST_STATE)],
  ['digestScheme', eq(SCHEME)],
  ['streamFormat', eq(3)],
  ['target', eq(TARGET)],
  ['markerIdSha256', re(HEX64)],
  ['serverVersionNum', re(/^17[0-9]{4}$/)],
  ['backupRun', re(RUN)],
  ['manifestSha256', re(HEX64)],
  ['dumpSha256', re(HEX64)],
  ['preWitnessSha256', re(HEX64)],
  ['fPre', re(HEX64)],
  ['fPost', re(HEX64)],
  ['authId', re(ID32)],
  ['authorizationRecordSha256', re(HEX64)],
  ['planDigest', re(HEX64)],
  ['protectedDomainContractSha256', re(HEX64)],
  ['transformationContractSha256', re(HEX64)],
  ['createdAt', instant],
  ['witnessSha256', re(HEX64)],
]);
// The OWNER authorization record (created only by local-test-authorize-resume.mjs). No streamSha256: R4 has no stream.
export const AUTH_SPEC = Object.freeze([
  ['format', eq(AUTH_FORMAT)],
  ['authId', re(ID32)],
  ['target', eq(TARGET)],
  ['markerIdSha256', re(HEX64)],
  ['action', eq(AUTH_ACTION)],
  ['fPre', re(HEX64)],
  ['preWitnessSha256', re(HEX64)],
  ['backupRun', re(RUN)],
  ['dumpSha256', re(HEX64)],
  ['manifestSha256', re(HEX64)],
  ['checkpointId', re(CHECKPOINT_ID)],
  ['checkpointRecordSha256', re(HEX64)],
  ['planDigest', re(HEX64)],
  ['createdAt', instant],
  ['expiresAt', instant],
  ['recordSha256', re(HEX64)],
]);
const SPECS = { PRE: PRE_SPEC, POST: POST_SPEC, AUTH: AUTH_SPEC };
const SELF_LABEL = { PRE: `${SCHEME}/WITNESS/PRE/SELF`, POST: `${SCHEME}/WITNESS/POST/SELF` };

const bodyJson = (spec, obj, selfKey) => JSON.stringify(Object.fromEntries(spec.filter(([k]) => k !== selfKey).map(([k]) => [k, obj[k]])));
const canonicalText = (spec, obj) => `${JSON.stringify(Object.fromEntries(spec.map(([k]) => [k, obj[k]])))}\n`;

export const postSelfHash = (obj) => sha256(Buffer.concat([frameStr(SELF_LABEL.POST), Buffer.from(bodyJson(POST_SPEC, obj, 'witnessSha256'), 'utf8')]));
const authSelfHash = (obj) => sha256(bodyJson(AUTH_SPEC, obj, 'recordSha256'));
export const preWitnessSha256 = (text) => sha256(Buffer.concat([frameStr(`${SCHEME}/WITNESS/PRE/SHA`), Buffer.from(text, 'utf8')]));

function checkedFields(kind, fields, constants) {
  const spec = SPECS[kind];
  const names = new Set(spec.map(([k]) => k));
  for (const key of Object.keys(fields)) if (!names.has(key)) throw new Error('evidence key not allowed');
  const obj = { ...fields, ...constants };
  return { spec, obj };
}
function validate(spec, obj) {
  for (const [key, ok] of spec) if (!ok(obj[key])) throw new Error('evidence value invalid');
}

// Write side: unknown key, value failing its slot pattern, or fPost == fPre are refused.
export function buildWitness(kind, fields) {
  if (kind === 'PRE') {
    const { spec, obj } = checkedFields('PRE', fields, { format: PRE_FORMAT, digestScheme: SCHEME, streamFormat: 3, target: TARGET });
    validate(spec, obj);
    return canonicalText(spec, obj);
  }
  if (kind !== 'POST') throw new Error('unknown witness kind');
  const { spec, obj } = checkedFields('POST', fields, { format: POST_FORMAT, state: POST_STATE, digestScheme: SCHEME, streamFormat: 3, target: TARGET });
  if (Object.hasOwn(fields, 'witnessSha256')) throw new Error('evidence key not allowed');
  obj.witnessSha256 = HEX64.test(String(obj.fPost)) ? postSelfHash(obj) : undefined;
  validate(spec, obj);
  if (obj.fPost === obj.fPre) throw new Error('fPost must differ from fPre');
  return canonicalText(spec, obj);
}

function parseClosed(kind, text) {
  const spec = SPECS[kind];
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'NOT_JSON' };
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'NOT_OBJECT' };
  const keys = Object.keys(obj);
  if (keys.length !== spec.length || keys.some((k, i) => k !== spec[i][0])) return { ok: false, reason: 'KEYS' };
  for (const [key, ok] of spec) if (!ok(obj[key])) return { ok: false, reason: `VALUE:${key}` };
  if (canonicalText(spec, obj) !== text) return { ok: false, reason: 'NOT_CANONICAL' };
  return { ok: true, obj };
}

export function parseWitness(kind, text) {
  if (kind !== 'PRE' && kind !== 'POST') return { ok: false, reason: 'KIND' };
  if (typeof text !== 'string') return { ok: false, reason: 'NOT_JSON' };
  const parsed = parseClosed(kind, text);
  if (!parsed.ok || kind === 'PRE') return parsed;
  if (parsed.obj.witnessSha256 !== postSelfHash(parsed.obj)) return { ok: false, reason: 'SELF_HASH' };
  if (parsed.obj.fPost === parsed.obj.fPre) return { ok: false, reason: 'POST_EQ_PRE' };
  return parsed;
}

export function buildAuthorizationRecord(fields) {
  const { spec, obj } = checkedFields('AUTH', fields, { format: AUTH_FORMAT, action: AUTH_ACTION });
  if (Object.hasOwn(fields, 'recordSha256')) throw new Error('evidence key not allowed');
  obj.recordSha256 = authSelfHash(obj);
  validate(spec, obj);
  if (!(Date.parse(obj.expiresAt) > Date.parse(obj.createdAt)) || Date.parse(obj.expiresAt) - Date.parse(obj.createdAt) > AUTH_MAX_TTL_MS) throw new Error('evidence value invalid');
  return canonicalText(spec, obj);
}

export function parseAuthorizationRecord(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'NOT_JSON' };
  const parsed = parseClosed('AUTH', text);
  if (!parsed.ok) return parsed;
  const { obj } = parsed;
  if (obj.recordSha256 !== authSelfHash(obj)) return { ok: false, reason: 'SELF_HASH' };
  const window = Date.parse(obj.expiresAt) - Date.parse(obj.createdAt);
  if (!(window > 0) || window > AUTH_MAX_TTL_MS) return { ok: false, reason: 'EXPIRY_WINDOW' };
  return parsed;
}

// Binding of one POST witness to the verified surrounding evidence. `fileAuthId` is the authId taken from the
// FILE NAME: it must equal the authId inside the witness (breaker LOW-1). The authorization record is bound by
// its CONTENT, not only by a file hash (breaker LOW-5).
export function bindPost(text, ctx, fileAuthId) {
  const parsed = parseWitness('POST', text);
  if (!parsed.ok) return parsed;
  const w = parsed.obj;
  if (w.authId !== fileAuthId) return { ok: false, reason: 'FILENAME_AUTHID' };
  if (w.backupRun !== ctx.run) return { ok: false, reason: 'RUN' };
  if (w.manifestSha256 !== ctx.manifestSha256) return { ok: false, reason: 'MANIFEST' };
  if (w.dumpSha256 !== ctx.dumpSha256) return { ok: false, reason: 'DUMP' };
  if (w.preWitnessSha256 !== ctx.preWitnessSha256) return { ok: false, reason: 'PRE_WITNESS' };
  if (w.fPre !== ctx.fPre) return { ok: false, reason: 'F_PRE' };
  if (w.target !== TARGET || w.markerIdSha256 !== ctx.markerIdSha256) return { ok: false, reason: 'TARGET' };
  if (w.serverVersionNum !== ctx.serverVersionNum) return { ok: false, reason: 'SERVER' };
  if (w.protectedDomainContractSha256 !== ctx.domainSha256) return { ok: false, reason: 'DOMAIN' };
  if (!ctx.acceptedTransformationContracts.includes(w.transformationContractSha256)) return { ok: false, reason: 'TRANSFORMATION_CONTRACT' };
  if (!ctx.consumedAuthIds.includes(w.authId)) return { ok: false, reason: 'NO_CONSUMED_AUTHORIZATION' };
  const recordText = Object.hasOwn(ctx.authRecords, w.authId) ? ctx.authRecords[w.authId] : undefined;
  if (typeof recordText !== 'string' || sha256(recordText) !== w.authorizationRecordSha256) return { ok: false, reason: 'AUTH_RECORD' };
  const record = parseAuthorizationRecord(recordText);
  if (!record.ok) return { ok: false, reason: 'AUTH_RECORD_INVALID' };
  const r = record.obj;
  const agrees = r.authId === w.authId && r.target === w.target && r.markerIdSha256 === w.markerIdSha256 && r.backupRun === w.backupRun
    && r.dumpSha256 === w.dumpSha256 && r.manifestSha256 === w.manifestSha256 && r.fPre === w.fPre
    && r.preWitnessSha256 === w.preWitnessSha256 && r.planDigest === w.planDigest && r.action === AUTH_ACTION;
  if (!agrees) return { ok: false, reason: 'AUTH_RECORD_CONTENT' };
  return { ok: true, obj: w };
}

// Read-only outcome decision from DIGESTS (current state digested in both domains) and witnesses.
//   PRE evidence invalid                         -> PARTIAL_OR_UNKNOWN (PRE_EVIDENCE_INVALID)
//   H_pre(current) == fPre                       -> PRE_SEED_EXACT      (precedence: a witness is never commit evidence)
//   exactly one bound witness with H_post == fPost -> POST_SEED_EXACT
//   otherwise                                    -> PARTIAL_OR_UNKNOWN  (NO_MATCH | AMBIGUOUS_WITNESSES)
export function classifyOutcome({ pre, ctx, witnesses, current }) {
  if (!pre || pre.valid !== true) return { state: 'PARTIAL_OR_UNKNOWN', reason: 'PRE_EVIDENCE_INVALID' };
  if (current.pre === pre.fPre) return { state: 'PRE_SEED_EXACT' };
  const matches = [];
  let valid = 0;
  let invalid = 0;
  for (const { authId, text } of witnesses) {
    const bound = bindPost(text, ctx, authId);
    if (!bound.ok) {
      invalid += 1;
      continue;
    }
    valid += 1;
    if (current.post === bound.obj.fPost) matches.push(bound.obj.authId);
  }
  const inventory = { valid, invalid };
  if (matches.length === 1) return { state: 'POST_SEED_EXACT', authId: matches[0], inventory };
  if (matches.length > 1) return { state: 'PARTIAL_OR_UNKNOWN', reason: 'AMBIGUOUS_WITNESSES', inventory };
  return { state: 'PARTIAL_OR_UNKNOWN', reason: 'NO_MATCH', inventory };
}

// What a tool may do next. There is no seed, execute or restore action in this vocabulary.
export function nextAction(outcome, authConsumed) {
  switch (outcome.state) {
    case 'PRE_SEED_EXACT': return authConsumed ? 'FRESH_AUTHORIZATION_REQUIRED' : 'RESUME_ALLOWED_AFTER_NORMAL_CHECKS';
    case 'POST_SEED_EXACT': return 'RECORD_COMPLETION_ONLY';
    default: return 'STOP_OWNER_RESTORE_FROM_BACKUP';
  }
}

// ---- file side ---------------------------------------------------------------------------------------------

// Async filesystem surface (injectable). Handles are opaque.
export const realWitnessFs = Object.freeze({
  openExcl: (p) => fsp.open(p, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600),
  write: async (handle, buffer) => (await handle.write(buffer, 0, buffer.length)).bytesWritten,
  fsync: (handle) => handle.sync(),
  close: (handle) => handle.close(),
  readFile: (p) => fsp.readFile(p),
  link: (a, b) => fsp.link(a, b),
  unlink: (p) => fsp.unlink(p),
  lstat: (p) => fsp.lstat(p),
  readdir: (p) => fsp.readdir(p),
  mkdir: (p, mode) => fsp.mkdir(p, { mode }),
  fsyncDir: async (p) => {
    const handle = await fsp.open(p, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  getuid: () => (typeof process.getuid === 'function' ? process.getuid() : -1),
});

const CANDIDATE = /^([0-9a-f]{32})\.post\.json$/;

// Read-side hygiene: regular file (lstat), nlink 1, no group/other bits, own uid, 1..4096 bytes.
export async function readWitnessFile(file, fs = realWitnessFs) {
  let st;
  try {
    st = await fs.lstat(file);
  } catch {
    return { ok: false, reason: 'MISSING' };
  }
  if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: 'NOT_REGULAR' };
  if (st.nlink !== 1) return { ok: false, reason: 'NLINK' };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: 'MODE' };
  if (st.uid !== fs.getuid()) return { ok: false, reason: 'OWNER' };
  if (st.size < 1 || st.size > WITNESS_MAX_BYTES) return { ok: false, reason: 'SIZE' };
  try {
    return { ok: true, text: (await fs.readFile(file)).toString('utf8') };
  } catch {
    return { ok: false, reason: 'UNREADABLE' };
  }
}

// Only exact `<32 hex>.post.json` names are candidates (dotfiles, temp files and anything else never are).
export async function listWitnessFiles(dir, fs = realWitnessFs) {
  const names = (await fs.readdir(dir)).filter((n) => CANDIDATE.test(n)).sort();
  const out = [];
  for (const name of names) {
    const authId = CANDIDATE.exec(name)[1];
    const read = await readWitnessFile(path.join(dir, name), fs);
    out.push(read.ok ? { authId, ok: true, text: read.text } : { authId, ok: false, reason: read.reason });
  }
  return out;
}

const OWNER_DIR_OK = (st, fs) => st.isDirectory() && !st.isSymbolicLink() && st.uid === fs.getuid() && (st.mode & 0o077) === 0;

// Creates (if absent) and verifies <root> and <root>/<run> (0700, own uid, no symlink), fsyncing each parent after
// its child exists (breaker LOW-2). Called BEFORE the protected transaction opens: no mkdir inside the lock window.
export async function ensureWitnessDir({ root, run, fs = realWitnessFs }) {
  const fail = { ok: false, reason: 'WITNESS_DIR' };
  const ensure = async (dir, parent) => {
    let st;
    try {
      st = await fs.lstat(dir);
    } catch {
      await fs.mkdir(dir, 0o700);
      st = await fs.lstat(dir);
    }
    if (!OWNER_DIR_OK(st, fs)) return false;
    await fs.fsyncDir(parent);
    return true;
  };
  try {
    if (typeof run !== 'string' || !RUN.test(run)) return fail;
    const dir = path.join(root, run);
    if (!(await ensure(root, path.dirname(root)))) return fail;
    if (!(await ensure(dir, root))) return fail;
    return { ok: true, dir };
  } catch {
    return fail;
  }
}

// The durable persistence protocol (design POST-WITNESS §4), under a deadline. Returns {durable:true, ...} only if
// every step succeeded; otherwise {durable:false, step}. Any non-durable result means the transaction owner ROLLS BACK.
//   1 openExcl temp (O_EXCL|O_NOFOLLOW, 0600)  2 write loop  3 fsync  4 close  5 read-back
//   6 link temp -> final (no overwrite)  7 unlink temp (failure = not durable: the final would have nlink 2)
//   8 fsync directory  9 final read-back + hygiene
export async function persistWitnessDurably({ dir, authId, text, fs = realWitnessFs, deadlineMs = WITNESS_DEADLINE_MS, timers = { setTimeout, clearTimeout } }) {
  if (typeof authId !== 'string' || !ID32.test(authId)) return { durable: false, step: 'input' };
  return persistFileDurably({ dir, authId, finalName: `${authId}.post.json`, text, fs, deadlineMs, timers });
}

async function persistFileDurably({ dir, authId, finalName, text, fs, deadlineMs, timers }) {
  if (typeof text !== 'string') return { durable: false, step: 'input' };
  const bytes = Buffer.from(text, 'utf8');
  const tmp = path.join(dir, `.${finalName}.tmp`);
  const final = path.join(dir, finalName);
  let aborted = false;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = timers.setTimeout(() => {
      aborted = true;
      resolve({ durable: false, step: 'deadline' });
    }, deadlineMs);
  });
  const work = (async () => {
    let handle = null;
    let tmpMade = false;
    const stop = (step) => ({ durable: false, step });
    const cleanup = async () => {
      try { if (handle !== null) await fs.close(handle); } catch { /* best effort */ }
      handle = null;
      try { if (tmpMade) await fs.unlink(tmp); } catch { /* own temp only; never swept */ }
    };
    const fail = async (step) => {
      await cleanup();
      return stop(step);
    };
    if (aborted) return stop('deadline');
    try { handle = await fs.openExcl(tmp); tmpMade = true; } catch { return stop('open'); }
    if (aborted) return fail('deadline');
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const n = await fs.write(handle, bytes.subarray(offset));
        if (!(n > 0)) return fail('write');
        offset += n;
        if (aborted) return fail('deadline');
      }
    } catch { return fail('write'); }
    try { await fs.fsync(handle); } catch { return fail('fsync'); }
    if (aborted) return fail('deadline');
    try { const h = handle; handle = null; await fs.close(h); } catch { return fail('close'); }
    if (aborted) return fail('deadline');
    try { if (!(await fs.readFile(tmp)).equals(bytes)) return fail('readback'); } catch { return fail('readback'); }
    if (aborted) return fail('deadline');
    try { await fs.link(tmp, final); } catch { return fail('link'); }
    if (aborted) return stop('deadline');
    try { await fs.unlink(tmp); } catch { return stop('unlink'); }
    tmpMade = false;
    try { await fs.fsyncDir(dir); } catch { return stop('dirfsync'); }
    if (aborted) return stop('deadline');
    try {
      if (!(await fs.readFile(final)).equals(bytes)) return stop('final-readback');
      const st = await fs.lstat(final);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || st.uid !== fs.getuid()) return stop('final-readback');
    } catch { return stop('final-readback'); }
    if (aborted) return stop('deadline');
    return { durable: true, authId, witnessSha256: sha256(bytes) };
  })();
  try {
    return await Promise.race([work, deadline]);
  } finally {
    timers.clearTimeout(timer);
  }
}

// ---- OWNER authorization store (R3 OWNER-AUTH, R4 bindings) -----------------------------------------------------------
// <home>/.local/state/mona-jacinta/local-test-authorizations/: owner-only 0700; one record `<authId>.json` (0600, created
// O_EXCL through the durable protocol); one consumed marker `<authId>.consumed.json` (0600, O_EXCL). A marker in ANY form
// (file, symlink, directory, partial) means consumed; no tool deletes or resurrects it.
export const AUTH_STORE = Object.freeze(['.local', 'state', 'mona-jacinta', 'local-test-authorizations']);
export const AUTH_CONSUMED_FORMAT = 'mona-local-test-resume-authorization-consumed/v1';
export const authorizationStorePath = (home) => path.join(home, ...AUTH_STORE);
const CONSUMED_SPEC = Object.freeze([
  ['format', eq(AUTH_CONSUMED_FORMAT)],
  ['authId', re(ID32)],
  ['planDigest', re(HEX64)],
  ['fPre', re(HEX64)],
  ['backupRun', re(RUN)],
  ['at', instant],
]);
export function buildConsumedMarker(fields) {
  const names = new Set(CONSUMED_SPEC.map(([k]) => k));
  for (const key of Object.keys(fields)) if (!names.has(key) || key === 'format') throw new Error('evidence key not allowed');
  const obj = { ...fields, format: AUTH_CONSUMED_FORMAT };
  for (const [key, ok] of CONSUMED_SPEC) if (!ok(obj[key])) throw new Error('evidence value invalid');
  return canonicalText(CONSUMED_SPEC, obj);
}

export async function ensureAuthorizationStore({ home, fs = realWitnessFs }) {
  const fail = { ok: false, reason: 'AUTH_STORE' };
  try {
    if (typeof home !== 'string' || !path.isAbsolute(home)) return fail;
    let current = home;
    for (const part of AUTH_STORE) {
      const next = path.join(current, part);
      let st;
      try {
        st = await fs.lstat(next);
      } catch {
        await fs.mkdir(next, 0o700);
        st = await fs.lstat(next);
        await fs.fsyncDir(current);
      }
      if (!st.isDirectory() || st.isSymbolicLink()) return fail;
      current = next;
    }
    const final = await fs.lstat(current);
    if (!OWNER_DIR_OK(final, fs)) return fail;
    return { ok: true, dir: current };
  } catch {
    return fail;
  }
}

export async function writeAuthorizationRecord({ dir, authId, text, fs = realWitnessFs, deadlineMs = WITNESS_DEADLINE_MS, timers = { setTimeout, clearTimeout } }) {
  if (typeof authId !== 'string' || !ID32.test(authId)) return { durable: false, step: 'input' };
  return persistFileDurably({ dir, authId, finalName: `${authId}.json`, text, fs, deadlineMs, timers });
}

// Reads one authorization: not consumed (the marker path must not exist in ANY form), regular owner-only 0600 file, canonical
// content with a valid self-hash, file name == content authId, valid now (createdAt <= now <= expiresAt).
export async function readAuthorizationRecord({ dir, authId, fs = realWitnessFs, now }) {
  if (typeof authId !== 'string' || !ID32.test(authId)) return { ok: false, reason: 'BAD_ID' };
  try {
    await fs.lstat(path.join(dir, `${authId}.consumed.json`));
    return { ok: false, reason: 'CONSUMED' };
  } catch (error) {
    if (error?.code !== 'ENOENT') return { ok: false, reason: 'CONSUMED' }; // unreadable marker state fails closed
  }
  const read = await readWitnessFile(path.join(dir, `${authId}.json`), fs);
  if (!read.ok) return { ok: false, reason: read.reason };
  const parsed = parseAuthorizationRecord(read.text);
  if (!parsed.ok) return { ok: false, reason: 'INVALID' };
  if (parsed.obj.authId !== authId) return { ok: false, reason: 'FILENAME_AUTHID' };
  const at = now instanceof Date ? now.getTime() : Number.NaN;
  if (!(at >= Date.parse(parsed.obj.createdAt))) return { ok: false, reason: 'NOT_YET_VALID' };
  if (at > Date.parse(parsed.obj.expiresAt)) return { ok: false, reason: 'EXPIRED' };
  return { ok: true, text: read.text, record: parsed.obj };
}

// The single use: O_EXCL create of the consumed marker, durable (file fsync + directory fsync). Any pre-existing entry — or a
// partially written one left by a crash — refuses and keeps counting as consumed.
export async function consumeAuthorizationMarker({ dir, authId, text, fs = realWitnessFs }) {
  if (typeof authId !== 'string' || !ID32.test(authId) || typeof text !== 'string') return { durable: false, step: 'input' };
  const bytes = Buffer.from(text, 'utf8');
  const final = path.join(dir, `${authId}.consumed.json`);
  let handle;
  try { handle = await fs.openExcl(final); } catch { return { durable: false, step: 'open' }; }
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const n = await fs.write(handle, bytes.subarray(offset));
      if (!(n > 0)) return { durable: false, step: 'write' };
      offset += n;
    }
    await fs.fsync(handle);
  } catch { return { durable: false, step: 'write' }; }
  try { await fs.close(handle); } catch { return { durable: false, step: 'close' }; }
  try { await fs.fsyncDir(dir); } catch { return { durable: false, step: 'dirfsync' }; }
  return { durable: true, authId, witnessSha256: sha256(bytes) };
}
