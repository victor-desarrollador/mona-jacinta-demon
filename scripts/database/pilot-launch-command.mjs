// Shared launch-time guards for the OWNER-only A5-1 PILOT tools (pilot-backup.mjs and
// pilot-clone-restore.mjs) and the builder of their OWNER launch commands.
//
// Builtins only: this module is imported statically by both tools, so its bytes are
// pinned by the launch command itself (launchSha256) before Node starts, and nothing
// it imports can be swapped. It never opens a socket and never reads a credential.
//
// TRUST ROOT, stated plainly: the root-owned system binaries /usr/bin/env, /bin/sh (dash),
// /usr/bin/stat (and /usr/bin/unshare for the clone) are trusted a priori (Debian
// packages; their bytes are checked out-of-band with `dpkg --verify`). `stat` only checks
// that each listed utility is owned by uid 0 and not group/other-writable before it runs.
// The digests bind the launch to the reviewed tool, manifest, launch module and Node
// bytes; they do not authenticate the operator.

import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import path from 'node:path';

export const EXPECTED_NODE = 'v24.20.0';
const PINNED_PATH = '/usr/bin:/bin';
const PINNED_LANG = 'C.UTF-8';
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LOCK_BYTES = 8 * 1024 * 1024;
const MAX_PINNED_FILE_BYTES = 256 * 1024 * 1024;
const TOOL_MANIFEST_FORMAT = 'mona-pilot-tool-manifest/v1';
const HEX64 = /^[0-9a-f]{64}$/;

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Deterministic JSON: object keys sorted at every depth, arrays kept in order.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const TRUSTED_UTILS = Object.freeze({
  env: '/usr/bin/env', sh: '/bin/sh', sha256sum: '/usr/bin/sha256sum', getent: '/usr/bin/getent',
  id: '/usr/bin/id', cut: '/usr/bin/cut', stat: '/usr/bin/stat', unshare: '/usr/bin/unshare',
});
const TRUSTED_OWNER_UID = 0;
const LAUNCH_REL = 'scripts/database/pilot-launch-command.mjs';

// The only tools this builder launches, their fixed arguments and their process context.
export const TOOLS = Object.freeze({
  'pilot-backup': Object.freeze({
    script: 'scripts/database/pilot-backup.mjs', manifest: 'scripts/database/pilot-backup.manifest.json',
    params: Object.freeze(['expectedState', 'outputDir']), netns: false,
    argv: (p) => ['--target=pilot', '--execute', `--output-dir=${p.outputDir}`, `--expected-state=${p.expectedState}`],
  }),
  'pilot-clone-restore': Object.freeze({
    script: 'scripts/database/pilot-clone-restore.mjs', manifest: 'scripts/database/pilot-clone-restore.manifest.json',
    params: Object.freeze(['archive', 'expectedState', 'manifestFile', 'workRoot']), netns: true,
    argv: (p) => [`--archive=${p.archive}`, `--manifest=${p.manifestFile}`, `--work-root=${p.workRoot}`, `--expected-state=${p.expectedState}`],
  }),
});

// Locations the tools read or write: absolute, normalized, and limited to [A-Za-z0-9/._-]
// so they can never carry shell or option syntax.
export function safePathChars(p) {
  return typeof p === 'string' && p.length > 1 && p.length <= 1024 && /^\/[A-Za-z0-9._/-]+$/.test(p)
    && path.posix.normalize(p) === p && !p.endsWith('/') && !p.split('/').some((s) => s === '.' || s === '..');
}
// Repository and Node locations may contain spaces (the repository does) but no quoting or expansion syntax.
const SAFE_ABSOLUTE = /^\/[^'"$`\\\n\r\0]*$/;

const STATE_PARAMS = Object.freeze(['expectedState']);
const EXACT_STATES = Object.freeze(['EXACT_S4', 'EXACT_G7', 'EXACT_G11']);
const BUILDER_KEYS = Object.freeze(['launchSha256', 'manifestSha256', 'nodePath', 'nodeSha256', 'params', 'repoDir', 'tool', 'toolSha256']);
export function buildOwnerCommand(spec) {
  if (spec === null || typeof spec !== 'object' || Object.keys(spec).sort().join(',') !== BUILDER_KEYS.join(',')) {
    throw new Error(`exactly ${BUILDER_KEYS.join(', ')} are accepted`);
  }
  const { tool, repoDir, nodePath, toolSha256, manifestSha256, launchSha256, nodeSha256, params } = spec;
  if (!Object.hasOwn(TOOLS, tool)) throw new Error('unknown tool');
  const t = TOOLS[tool];
  for (const value of [repoDir, nodePath]) {
    if (typeof value !== 'string' || !SAFE_ABSOLUTE.test(value) || path.posix.normalize(value) !== value) throw new Error('unsafe or relative path');
  }
  for (const digest of [toolSha256, manifestSha256, launchSha256, nodeSha256]) {
    if (typeof digest !== 'string' || !HEX64.test(digest)) throw new Error('digests must be 64 lowercase hex characters');
  }
  if (params === null || typeof params !== 'object' || Object.keys(params).sort().join(',') !== [...t.params].sort().join(',')) {
    throw new Error(`exactly ${t.params.join(', ')} are accepted as parameters`);
  }
  for (const k of t.params) {
    // G11 cut-over: the OWNER-named exact state is a closed enum (shell-safe by construction); every other parameter is a path.
    if (STATE_PARAMS.includes(k)) { if (!EXACT_STATES.includes(params[k])) throw new Error('the expected state must be EXACT_S4, EXACT_G7 or EXACT_G11'); continue; }
    if (!safePathChars(params[k])) throw new Error('parameter paths must be absolute, normalized, [A-Za-z0-9/._-] only');
  }

  const u = TRUSTED_UTILS;
  const q = (v) => `"${v}"`;
  const utils = t.netns ? Object.values(u) : Object.values(u).filter((x) => x !== u.unshare);
  const run = `${q(nodePath)} ${t.script} ${t.argv(params).join(' ')}`;
  const script = [
    'set -eu',
    `for u in ${utils.map(q).join(' ')}; do`,
    `  s=$(${q(u.stat)} -L -c %u:%a "$u") || exit 70`,
    `  case "$s" in ${TRUSTED_OWNER_UID}:[0-7][0145][0145]) ;; *) echo "A5_LAUNCH=REFUSED untrusted utility" >&2; exit 71 ;; esac`,
    'done',
    `cd ${q(repoDir)} || exit 72`,
    `printf "%s  %s\\n" ${toolSha256} ${t.script} ${manifestSha256} ${t.manifest} ${launchSha256} ${LAUNCH_REL} ${nodeSha256} ${q(nodePath)} | ${q(u.sha256sum)} --check --strict || exit 73`,
    ...(t.netns
      // Clone: a new user + network namespace (only loopback), the invoking uid kept (never root), no HOME.
      ? [`exec ${q(u.unshare)} -U -n --map-current-user ${q(u.env)} -i PATH=${PINNED_PATH} LANG=${PINNED_LANG} ${run}`]
      : [`H=$(${q(u.getent)} passwd "$(${q(u.id)} -un)" | ${q(u.cut)} -d: -f6)`, '[ -n "$H" ] || exit 74',
        `exec ${q(u.env)} -i HOME="$H" PATH=${PINNED_PATH} LANG=${PINNED_LANG} ${run}`]),
  ].join('\n');
  return `${q(u.env)} -i ${q(u.sh)} -c '${script}'`;
}

// Exact process context: pinned Node, no runtime options, exactly the expected variables.
export function checkRuntime({ env, execArgv, version, expectedKeys, homedir }) {
  if (version !== EXPECTED_NODE) return { ok: false, phase: 'runtime', reason: `Node runtime must be ${EXPECTED_NODE}` };
  if (!Array.isArray(execArgv) || execArgv.length !== 0) return { ok: false, phase: 'runtime', reason: 'node must be started without runtime options' };
  const keys = Object.keys(env ?? {}).sort();
  if (keys.join(',') !== [...expectedKeys].sort().join(',')) {
    return { ok: false, phase: 'env', reason: `environment must contain exactly ${[...expectedKeys].sort().join(', ')} (launch with the OWNER command)` };
  }
  if (env.PATH !== PINNED_PATH || env.LANG !== PINNED_LANG) return { ok: false, phase: 'env', reason: 'PATH/LANG differ from the pinned values' };
  if (expectedKeys.includes('HOME') && (typeof homedir !== 'string' || env.HOME !== homedir)) {
    return { ok: false, phase: 'env', reason: 'HOME is not the passwd home directory' };
  }
  return { ok: true };
}

// lstat first (never opens a FIFO/socket/device/symlink), then a non-blocking no-follow open;
// the descriptor must be the SAME regular file (dev/ino), mode exactly 0600, owned, bounded,
// and fully read. Reasons are fixed strings: never a path or content.
export function readPrivateFile(fs, uid, file, maxBytes) {
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
  } catch {
    return { ok: false, reason: 'a private file could not be opened' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, reason: 'a private file is not a regular file' };
    if (st.dev !== pre.dev || st.ino !== pre.ino) return { ok: false, reason: 'a private file changed between inspection and open' };
    if ((st.mode & 0o777) !== 0o600) return { ok: false, reason: 'a private file must have mode exactly 0600' };
    if (st.uid !== uid) return { ok: false, reason: 'a private file is not owned by the current user' };
    if (st.size === 0 || st.size > maxBytes) return { ok: false, reason: 'a private file has an implausible size' };
    const bytes = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = fs.readSync(fd, bytes, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    if (off !== st.size || fs.readSync(fd, Buffer.alloc(1), 0, 1, st.size) !== 0) return { ok: false, reason: 'a private file changed while being read' };
    return { ok: true, bytes, dev: st.dev, ino: st.ino };
  } catch {
    return { ok: false, reason: 'a private file could not be read' };
  } finally {
    fs.closeSync(fd);
  }
}

// A real directory (not a symlink), owned by uid, mode exactly 0700.
export function checkPrivateDir(fs, uid, dir) {
  try {
    const st = fs.lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && st.uid === uid && (st.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

// No component of the absolute path is a symlink (each prefix is lstat'ed).
export function checkNoSymlinkComponents(fs, abs) {
  if (typeof abs !== 'string' || !path.isAbsolute(abs)) return false;
  const parts = abs.split('/').filter(Boolean);
  let cur = '';
  try {
    for (const part of parts) {
      cur = `${cur}/${part}`;
      if (fs.lstatSync(cur).isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function isUnderAny(p, roots) {
  return roots.some((r) => {
    const root = r.length > 1 && r.endsWith('/') ? r.slice(0, -1) : r;
    return p === root || p.startsWith(`${root}/`);
  });
}

function safeRelative(rel) {
  return typeof rel === 'string' && rel.length > 0 && !rel.startsWith('/') && !rel.includes('\\') && !rel.includes('\0')
    && path.posix.normalize(rel) === rel && !rel.split('/').includes('..') && !rel.split('/').includes('.');
}

function readRegular(fs, file, maxBytes) {
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > maxBytes) return null;
  return fs.readFileSync(file);
}

const sameSet = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n') && new Set(a).size === a.length;

// Code-integrity manifest of a tool: every pinned repository file, the complete npm package
// closure (no unlisted, symlinked, native or special file), and the exact PostgreSQL binaries.
// Verified before any non-builtin module is loaded and before any binary is executed.
export function verifyCodeManifest({ root, manifestRel, fs = nodeFs, tool, requiredRepoFiles, packageClosure, binaries, resolvePg }) {
  const fail = (reason) => ({ ok: false, reason });
  try {
    const manifestBytes = readRegular(fs, path.join(root, manifestRel), MAX_MANIFEST_BYTES);
    if (!manifestBytes) return fail('manifest is not a bounded regular file');
    const m = JSON.parse(manifestBytes.toString('utf8'));
    if (m === null || typeof m !== 'object' || Object.keys(m).sort().join(',') !== 'binaries,format,node,packages,repoFiles,tool') return fail('manifest structure invalid');
    if (m.format !== TOOL_MANIFEST_FORMAT || m.tool !== tool || m.node !== EXPECTED_NODE) return fail('manifest format, tool or Node version mismatch');
    if (!Array.isArray(m.repoFiles) || !Array.isArray(m.packages) || !Array.isArray(m.binaries)) return fail('manifest structure invalid');

    if (!sameSet(m.repoFiles.map((f) => f?.path), requiredRepoFiles)) return fail('manifest repository file set differs from the required set');
    const repoSha = new Map();
    for (const f of m.repoFiles) {
      if (!safeRelative(f.path) || !HEX64.test(f.sha256 ?? '')) return fail('manifest repository entry invalid');
      const bytes = readRegular(fs, path.join(root, f.path), MAX_PINNED_FILE_BYTES);
      if (!bytes || sha256(bytes) !== f.sha256) return fail('a pinned repository file differs from the manifest');
      repoSha.set(f.path, f.sha256);
    }

    if (!sameSet(m.binaries.map((b) => b?.path), binaries)) return fail('manifest binary set differs from the required binaries');
    for (const b of m.binaries) {
      if (!path.isAbsolute(b.path) || !HEX64.test(b.sha256 ?? '')) return fail('manifest binary entry invalid');
      const bytes = readRegular(fs, b.path, MAX_PINNED_FILE_BYTES);
      if (!bytes || sha256(bytes) !== b.sha256) return fail('a pinned binary differs from the manifest');
    }

    const lockBytes = readRegular(fs, path.join(root, 'package-lock.json'), MAX_LOCK_BYTES);
    if (!lockBytes) return fail('package-lock.json is not a bounded regular file');
    const lock = JSON.parse(lockBytes.toString('utf8'))?.packages ?? {};
    if (!sameSet(m.packages.map((p) => p?.name), packageClosure)) return fail('manifest package set differs from the pinned dependency closure');
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
      if (!sameSet(found, listed)) return fail('a pinned package has unlisted or missing files');
      for (const f of p.files) {
        const bytes = readRegular(fs, path.join(root, f.path), MAX_PINNED_FILE_BYTES);
        if (!bytes || !HEX64.test(f.sha256 ?? '') || sha256(bytes) !== f.sha256) return fail('a pinned package file differs from the manifest');
      }
    }
    if (packageClosure.includes('pg') && resolvePg() !== path.join(root, 'node_modules', 'pg', 'esm', 'index.mjs')) return fail('pg does not resolve to the pinned copy');
    return { ok: true, repoSha };
  } catch {
    return fail('manifest verification failed');
  }
}

// Runs one child with an explicit environment and no shell. stdin is the given bytes (or
// closed). stdout: maxStdout 0 drains and discards it; otherwise it is captured up to maxStdout
// (more is an overflow failure). stderr is drained and DISCARDED (it may carry connection
// details or row values). On timeout: SIGTERM, then SIGKILL after killGraceMs; a killed or
// exited child whose pipes stay open (a grandchild holding them) is not waited for: after
// EXIT_GRACE_MS the pipes are destroyed and a capture is reported incomplete (status null).
// Never throws for child failures.
const EXIT_GRACE_MS = 2000;
export function runChild(spawn, file, args, { env, input, timeoutMs, killGraceMs = 5000, maxStdout = 0 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, { env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
    } catch {
      resolve({ status: null, signal: null, timedOut: false, overflow: false, stdout: '', spawnError: true });
      return;
    }
    const capture = maxStdout > 0;
    const chunks = [];
    let size = 0; let overflow = false; let timedOut = false; let done = false;
    let killTimer = null; let graceTimer = null;
    const term = () => {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, killGraceMs);
    };
    const timer = setTimeout(() => { timedOut = true; term(); }, timeoutMs);
    child.stdout?.on('data', (c) => {
      if (!capture || overflow) return;
      size += c.length;
      if (size > maxStdout) { overflow = true; chunks.length = 0; term(); return; }
      chunks.push(c);
    });
    child.stderr?.on('data', () => {});
    child.stdout?.on('error', () => {}); child.stderr?.on('error', () => {});
    if (input !== undefined && child.stdin) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    const finish = (status, signal, { spawnError = false, incomplete = false } = {}) => {
      if (done) return;
      done = true; clearTimeout(timer); if (killTimer) clearTimeout(killTimer); if (graceTimer) clearTimeout(graceTimer);
      const lost = incomplete && capture;
      resolve({ status: lost ? null : status, signal, timedOut, overflow, spawnError, incomplete, stdout: overflow || lost ? '' : Buffer.concat(chunks).toString('utf8') });
    };
    const abandonPipes = () => { child.stdout?.destroy(); child.stderr?.destroy(); child.stdin?.destroy(); };
    child.on('error', () => finish(null, null, { spawnError: true }));
    child.on('exit', (status, signal) => {
      if (timedOut || overflow) { abandonPipes(); finish(status, signal); return; }
      graceTimer = setTimeout(() => { abandonPipes(); finish(status, signal, { incomplete: true }); }, EXIT_GRACE_MS);
    });
    child.on('close', (status, signal) => finish(status, signal));
  });
}
