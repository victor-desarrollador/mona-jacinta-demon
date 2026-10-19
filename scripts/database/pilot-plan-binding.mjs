// G11-ADV-001: Plan/target/tooling binding for the two OWNER-only PILOT plan tools
// (pilot-migrate.mjs and pilot-rbac-catalog-upgrade.mjs).
//
// Root cause this closes: PLAN_DIGEST used to bind only the state/payload/Prisma
// tuple, so a digest approved for one PILOT target could be replayed against
// another valid PILOT project, and a change in the tooling (runner code, pins,
// probes, config contract, CA trust anchor) did not invalidate an old digest.
//
// What a plan now carries (inside the digest; values are never printed):
//   targetBinding  — environment classification, project ref, host, database and
//                    the marker id the execute will prove.
//   toolingBinding — for every repository artifact whose byte-level modification can
//                    change what executes: its relative path, byte count and SHA-256.
//
// The binding is canonical and non-secret in its digested form; no URL, password,
// token or secret query parameter is ever read, held or emitted here. Builtins
// only: fs hashing and pure construction. Nothing connects, spawns or resolves a
// Prisma migration.
import { closeSync, constants as fsConstants, fstatSync, openSync, readlinkSync, readSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const TARGET_BINDING_FORMAT = 'mona-pilot-target-binding/v1';
export const TOOLING_BINDING_FORMAT = 'mona-pilot-tooling-binding/v1';

// The real, one directory both PILOT plan tools and this module live in: the
// default root for 'module' entries. Tests may inject another root; production
// callers never do.
export const TOOLING_MODULE_ROOT = path.dirname(fileURLToPath(import.meta.url));

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROJECT_REF = /^[a-z0-9]{20}$/;
const DNS_HOST = /^(?=.*[a-z])[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const SAFE_REL = /^[A-Za-z0-9][A-Za-z0-9/._-]*$/;
const MAX_BINDING_FILE_BYTES = 16 * 1024 * 1024;

// Hardened single-file read: O_NOFOLLOW refuses a symlinked final component,
// fstat must show a bounded regular file, the kernel's own path for the
// descriptor must be the canonical path (a symlinked parent cannot redirect),
// and the read must be complete with no trailing change.
export function readLockedFile(file) {
  let fd;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return { ok: false, reason: 'is missing or is a symlink' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'is not a regular file' };
    if (st.size === 0 || st.size > MAX_BINDING_FILE_BYTES) return { ok: false, reason: 'has an implausible size' };
    if (readlinkSync(`/proc/self/fd/${fd}`) !== file) return { ok: false, reason: 'does not resolve to its canonical path' };
    const bytes = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, bytes, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read !== st.size || readSync(fd, Buffer.alloc(1), 0, 1, read) !== 0) return { ok: false, reason: 'changed while being read' };
    return { ok: true, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    return { ok: false, reason: 'could not be read' };
  } finally {
    closeSync(fd);
  }
}

// Canonical, non-secret target binding. Throws a fixed-text error on any invalid
// input; callers derive these fields from inputs they already validated
// (parsePilotUrl/deriveProjectRef) and re-validation is the defense in depth.
export function buildTargetBinding({ environment, projectRef, host, database, markerId }) {
  if (environment !== 'pilot') throw new Error('target binding: environment must be exactly "pilot"');
  if (typeof projectRef !== 'string' || !PROJECT_REF.test(projectRef)) throw new Error('target binding: project ref is missing or invalid');
  if (typeof host !== 'string' || !DNS_HOST.test(host)) throw new Error('target binding: host is missing or invalid');
  if (typeof database !== 'string' || database === '' || /\s|\/|#/.test(database)) throw new Error('target binding: database is missing or invalid');
  if (typeof markerId !== 'string' || !UUID_V4.test(markerId)) throw new Error('target binding: marker id is missing or invalid');
  return Object.freeze({
    format: TARGET_BINDING_FORMAT,
    environment,
    projectRef,
    host,
    database,
    markerId,
  });
}

// Canonical tooling binding: every listed artifact is read through
// readLockedFile and recorded as { path, bytes, sha256 } in a sorted, order-stable
// list. One missing, symlinked, oversized or unreadable file throws with its
// relative path — a binding that cannot be built must fail the whole plan.
export function buildToolingBinding({ moduleDir = TOOLING_MODULE_ROOT, apiDir, repoDir, files, read = readLockedFile }) {
  if (typeof moduleDir !== 'string' || !path.isAbsolute(moduleDir)) throw new Error('tooling binding: module root is missing or not absolute');
  const roots = { module: moduleDir, api: apiDir, repo: repoDir };
  for (const { path: rel, root } of files) {
    if (typeof rel !== 'string' || !SAFE_REL.test(rel) || rel.includes('..') || rel.endsWith('/')) throw new Error(`tooling binding: invalid listed path ${rel === undefined ? '(missing)' : ''}`);
    if (!(root in roots)) throw new Error(`tooling binding: invalid root class "${String(root)}" for ${rel}`);
    if (typeof roots[root] !== 'string' || !path.isAbsolute(roots[root])) throw new Error(`tooling binding: the class-${root} root is missing or not absolute`);
  }
  const entries = [];
  for (const { path: rel, root } of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const abs = path.join(roots[root], rel);
    const file = read(abs);
    if (!file.ok) throw new Error(`tooling binding: ${rel} ${file.reason}`);
    entries.push(Object.freeze({ path: rel, bytes: file.bytes.length, sha256: file.sha256 }));
  }
  return Object.freeze({ format: TOOLING_BINDING_FORMAT, files: Object.freeze(entries) });
}

export function validateTargetBinding(value) {
  return value !== null && typeof value === 'object' && value.format === TARGET_BINDING_FORMAT
    && value.environment === 'pilot' && PROJECT_REF.test(String(value.projectRef)) && DNS_HOST.test(String(value.host))
    && typeof value.database === 'string' && value.database !== '' && !/\s|\/|#/.test(value.database) && UUID_V4.test(String(value.markerId))
    && Object.keys(value).sort().join(',') === 'database,environment,format,host,markerId,projectRef';
}

export function validateToolingBinding(value) {
  return value !== null && typeof value === 'object' && value.format === TOOLING_BINDING_FORMAT
    && Array.isArray(value.files) && value.files.length > 0
    && value.files.every((f) => f !== null && typeof f === 'object'
      && SAFE_REL.test(String(f.path)) && Number.isSafeInteger(f.bytes) && f.bytes > 0
      && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256)
      && Object.keys(f).sort().join(',') === 'bytes,path,sha256')
    && Object.keys(value).sort().join(',') === 'files,format';
}

export function toolingFile(root, path) {
  return { root, path };
}
