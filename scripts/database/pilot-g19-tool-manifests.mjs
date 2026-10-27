// Reviewed generator of the two G19 PILOT tool code manifests (pilot-g19-backup, pilot-g19-clone-restore). The sibling of
// pilot-tool-manifests.mjs (the four G14-era manifests), which is NOT modified: the G14 manifests stay byte-for-byte what they were,
// pinned to the G14 tools. Nothing is retyped by hand: every hash is computed from the bytes on disk.
//
//   node scripts/database/pilot-g19-tool-manifests.mjs --check   # read-only: CURRENT / STALE / ABSENT per tool
//   node scripts/database/pilot-g19-tool-manifests.mjs --write   # (re)write the two manifests from disk
//
// Each manifest pins, by SHA-256 of the bytes on disk: the tool's own REQUIRED_REPO_FILES (taken from the tool module, so the set can
// never drift from what the tool verifies), every file of the pinned pg dependency closure (versions/integrity from package-lock.json) and the
// PostgreSQL 17 binaries the tool runs. The Node version must be the pinned one. No database, no network, no credential; only the two
// manifest files are ever written, atomically, never through a symlink. Regenerate after ANY change to a pinned file (a new migration,
// the day the EXACT_G19 schema reference is pinned, a generation module) and review the diff like code: --check is the gate.
import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as BK from './pilot-g19-backup.mjs';
import * as CR from './pilot-g19-clone-restore.mjs';
import { EXPECTED_NODE } from './pilot-launch-command.mjs';
import { PACKAGE_CLOSURE } from './pilot-tool-manifests.mjs';

const PREFIX = '[db:pilot-g19-tool-manifests]';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = '/usr/lib/postgresql/17/bin';
export const TOOLS = Object.freeze({
  'pilot-g19-backup': Object.freeze({ format: 'mona-pilot-tool-manifest/v1', repoFiles: () => BK.REQUIRED_REPO_FILES, binaries: Object.freeze([`${BIN}/pg_dump`, `${BIN}/pg_restore`]) }),
  'pilot-g19-clone-restore': Object.freeze({ format: 'mona-pilot-tool-manifest/v1', repoFiles: () => CR.REQUIRED_REPO_FILES,
    binaries: Object.freeze(['initdb', 'pg_ctl', 'pg_restore', 'pg_dump', 'postgres'].map((b) => `${BIN}/${b}`)) }),
});

const sha = (fs, f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function walk(fs, abs, rel, out) {
  for (const d of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = `${rel}/${d.name}`;
    if (d.isDirectory()) walk(fs, path.join(abs, d.name), r, out); else if (d.isFile()) out.push(r); else throw new Error(`special file in the package closure: ${r}`);
  }
  return out;
}

export function buildManifest(tool, { root = ROOT, fs = nodeFs, binaries } = {}) {
  const t = TOOLS[tool];
  if (!t) throw new Error('unknown tool');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).packages;
  const packages = PACKAGE_CLOSURE.map((name) => {
    const e = lock[`node_modules/${name}`];
    if (!e?.version || !e?.integrity) throw new Error(`package-lock.json has no pinned ${name}`);
    return { name, version: e.version, integrity: e.integrity,
      files: walk(fs, path.join(root, 'node_modules', name), `node_modules/${name}`, []).map((p) => ({ path: p, sha256: sha(fs, path.join(root, p)) })) };
  });
  const repoFiles = t.repoFiles().map((p) => ({ path: p, sha256: sha(fs, path.join(root, p)) }));
  return { format: t.format, tool, node: EXPECTED_NODE, repoFiles, packages, binaries: (binaries ?? t.binaries).map((p) => ({ path: p, sha256: sha(fs, p) })) };
}
export const serialize = (m) => `${JSON.stringify(m, null, 2)}\n`;

export function main(argv, overrides = {}) {
  const deps = { root: ROOT, manifestDir: path.join(ROOT, 'scripts', 'database'), fs: nodeFs, nodeVersion: process.version,
    log: (l) => console.log(l), error: (l) => console.error(l), ...overrides };
  const { fs } = deps;
  if (!Array.isArray(argv) || argv.length !== 1 || !['--check', '--write'].includes(argv[0])) {
    deps.error(`${PREFIX} exactly one of --check or --write`); return 2;
  }
  if (deps.nodeVersion !== EXPECTED_NODE) { deps.error(`${PREFIX} Node ${EXPECTED_NODE} is required (the manifests pin it)`); return 1; }
  let notCurrent = 0;
  try {
    for (const tool of Object.keys(TOOLS)) {
      const target = path.join(deps.manifestDir, `${tool}.manifest.json`);
      let current = null;
      try {
        const st = fs.lstatSync(target);
        if (st.isSymbolicLink() || !st.isFile()) { deps.error(`${PREFIX} ${tool}: the manifest path is not a regular file; nothing written`); return 1; }
        current = fs.readFileSync(target, 'utf8');
      } catch (e) { if (e?.code !== 'ENOENT') throw e; }
      const text = serialize(buildManifest(tool, { root: deps.root, fs, binaries: deps.binaries?.[tool] }));
      const same = current === text;
      if (argv[0] === '--check') {
        deps.log(`${PREFIX} ${tool}: ${current === null ? 'ABSENT' : same ? 'CURRENT' : 'STALE'}`);
        if (!same) notCurrent += 1;
        continue;
      }
      if (same) { deps.log(`${PREFIX} ${tool}: CURRENT (unchanged)`); continue; }
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o644 });
      fs.chmodSync(tmp, 0o644);
      fs.renameSync(tmp, target);
      deps.log(`${PREFIX} ${tool}: WRITTEN sha256=${createHash('sha256').update(text).digest('hex')}`);
    }
  } catch (e) {
    deps.error(`${PREFIX} ERROR — ${String(e?.message ?? e).split('\n')[0]}`); return 1;
  }
  return notCurrent === 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
