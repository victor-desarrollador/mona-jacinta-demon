// OWNER launch-command builder for the G20 PILOT backup and clone-restore tools (pilot-g20-backup.mjs and
// pilot-g20-clone-restore.mjs). The sibling of the builder in pilot-launch-command.mjs, which is NOT modified: that module is
// hash-pinned by the four G14 tool manifests and keeps its closed G14 contract (tools, exact-state enum). Everything that is
// not specific to G20 (runtime check, private-file reads, canonical JSON, child runner, trusted utilities) is IMPORTED from it,
// never re-implemented. Builtins only; it never opens a socket and never reads a credential.
//
// What differs from the G14 builder, and nothing else: the tool table (the two G20 tools, their manifests) and the closed
// exact-state enum, which is EXACT_G16 | EXACT_G20 — the only two generations a backup is taken at (G17, G18 and G19 are
// intermediates). The chain of digests is the same: tool, manifest, THIS launch module, the G14 launch module it imports,
// and Node are all checked by sha256sum before Node starts.
import path from 'node:path';
import { TRUSTED_UTILS, safePathChars } from './pilot-launch-command.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const PINNED_PATH = '/usr/bin:/bin';
const PINNED_LANG = 'C.UTF-8';
const TRUSTED_OWNER_UID = 0;
const LAUNCH_REL = 'scripts/database/pilot-g20-launch-command.mjs';
const BASE_LAUNCH_REL = 'scripts/database/pilot-launch-command.mjs';

export const G20_EXACT_STATES = Object.freeze(['EXACT_G16', 'EXACT_G20']);

export const TOOLS = Object.freeze({
  'pilot-g20-backup': Object.freeze({
    script: 'scripts/database/pilot-g20-backup.mjs', manifest: 'scripts/database/pilot-g20-backup.manifest.json',
    params: Object.freeze(['expectedState', 'outputDir']), netns: false,
    argv: (p) => ['--target=pilot', '--execute', `--output-dir=${p.outputDir}`, `--expected-state=${p.expectedState}`],
  }),
  'pilot-g20-clone-restore': Object.freeze({
    script: 'scripts/database/pilot-g20-clone-restore.mjs', manifest: 'scripts/database/pilot-g20-clone-restore.manifest.json',
    params: Object.freeze(['archive', 'expectedState', 'manifestFile', 'workRoot']), netns: true,
    argv: (p) => [`--archive=${p.archive}`, `--manifest=${p.manifestFile}`, `--work-root=${p.workRoot}`, `--expected-state=${p.expectedState}`],
  }),
});

const SAFE_ABSOLUTE = /^\/[^'"$`\\\n\r\0]*$/;
const BUILDER_KEYS = Object.freeze(['baseLaunchSha256', 'launchSha256', 'manifestSha256', 'nodePath', 'nodeSha256', 'params', 'repoDir', 'tool', 'toolSha256']);

export function buildOwnerCommand(spec) {
  if (spec === null || typeof spec !== 'object' || Object.keys(spec).sort().join(',') !== BUILDER_KEYS.join(',')) {
    throw new Error(`exactly ${BUILDER_KEYS.join(', ')} are accepted`);
  }
  const { tool, repoDir, nodePath, toolSha256, manifestSha256, launchSha256, baseLaunchSha256, nodeSha256, params } = spec;
  if (!Object.hasOwn(TOOLS, tool)) throw new Error('unknown tool');
  const t = TOOLS[tool];
  for (const value of [repoDir, nodePath]) {
    if (typeof value !== 'string' || !SAFE_ABSOLUTE.test(value) || path.posix.normalize(value) !== value) throw new Error('unsafe or relative path');
  }
  for (const digest of [toolSha256, manifestSha256, launchSha256, baseLaunchSha256, nodeSha256]) {
    if (typeof digest !== 'string' || !HEX64.test(digest)) throw new Error('digests must be 64 lowercase hex characters');
  }
  if (params === null || typeof params !== 'object' || Object.keys(params).sort().join(',') !== [...t.params].sort().join(',')) {
    throw new Error(`exactly ${t.params.join(', ')} are accepted as parameters`);
  }
  for (const k of t.params) {
    // The OWNER-named exact state is a closed enum (shell-safe by construction); every other parameter is a path.
    if (k === 'expectedState') { if (!G20_EXACT_STATES.includes(params[k])) throw new Error(`the expected state must be ${G20_EXACT_STATES.join(', ')}`); continue; }
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
    `printf "%s  %s\\n" ${toolSha256} ${t.script} ${manifestSha256} ${t.manifest} ${launchSha256} ${LAUNCH_REL} ${baseLaunchSha256} ${BASE_LAUNCH_REL} ${nodeSha256} ${q(nodePath)} | ${q(u.sha256sum)} --check --strict || exit 73`,
    ...(t.netns
      ? [`exec ${q(u.unshare)} -U -n --map-current-user ${q(u.env)} -i PATH=${PINNED_PATH} LANG=${PINNED_LANG} ${run}`]
      : [`H=$(${q(u.getent)} passwd "$(${q(u.id)} -un)" | ${q(u.cut)} -d: -f6)`, '[ -n "$H" ] || exit 74',
        `exec ${q(u.env)} -i HOME="$H" PATH=${PINNED_PATH} LANG=${PINNED_LANG} ${run}`]),
  ].join('\n');
  return `${q(u.env)} -i ${q(u.sh)} -c '${script}'`;
}
