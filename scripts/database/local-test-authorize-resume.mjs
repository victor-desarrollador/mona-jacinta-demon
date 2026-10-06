import { randomBytes, createHash } from 'node:crypto';
import { closeSync, constants as fsConstants, openSync, readSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CONFIRM_LOCAL_TARGET, DEFAULT_PREPARE_DEPS, MAX_BACKUP_AGE_MS, PREPARE_ACTIONS, staticGates } from './local-test-prepare.mjs';
import { runTool } from './local-test-safe-error.mjs';
import { AUTH_MAX_TTL_MS, buildAuthorizationRecord, ensureAuthorizationStore, writeAuthorizationRecord } from './local-test-witness.mjs';

// LOCAL_TEST OWNER authorization ceremony for the resume (seed #2) — V2.3.3 R4.
//
//   node scripts/database/local-test-authorize-resume.mjs --marker-id=<uuid> \
//     --backup-evidence=<absolute backup run directory> --plan=<64-hex plan digest of the resume --dry-run>
//
// The OWNER's explicit, single-use authorization to run seed #2. It is created ONLY by this tool; the resume can never create
// one, and the backup evidence is NOT an authorization (separate artifact, separate store). The tool:
//   1. fully verifies the backup run exactly as the resume would (files, strict archive contract, manifest v4 + embedded PRE
//      witness, current checkpoint, age) and that --plan equals the resume plan computed NOW — no database connection;
//   2. shows the reviewed values on the controlling TERMINAL (/dev/tty) and requires the human to type, on that terminal only
//      (never argv, stdin or the environment): the target, the first 12 hex of fPre, the first 12 hex of the dump sha256 and
//      the literal RESUME SEED 2 (the machine comparison of every value is on the full strings);
//   3. writes <home>/.local/state/mona-jacinta/local-test-authorizations/<authId>.json (dir 0700, file 0600, O_EXCL, fsync of
//      file and directory): canonical, closed key set, binding target, marker, backup run, dump, manifest, fPre, PRE witness,
//      checkpoint, plan, action and expiry (<= 2 h and <= the backup age limit). No stream hash exists in R4.
// Agents never run this tool. Same-user forgery is the accepted trust boundary (see OWNER-AUTH): this is a human-boundary
// mechanism, not cryptographic identity.

export const PREFIX = '[db:local-test-authorize-resume]';
const VALUE_ARGS = ['marker-id', 'backup-evidence', 'plan'];
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PLAN_DIGEST = /^[0-9a-f]{64}$/;
const CONFIRM_LITERAL = 'RESUME SEED 2';
const MAX_TTY_LINE = 256;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// Exactly --marker-id, --backup-evidence and --plan, each once. Rejected values are never echoed.
export function parseAuthorizeArgs(argv) {
  const values = {};
  for (const arg of argv) {
    if (typeof arg !== 'string' || !arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  const markerId = values['marker-id'];
  const evidence = values['backup-evidence'];
  const plan = values.plan;
  if (markerId === undefined || !UUID_V4.test(markerId)) return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  if (evidence === undefined || !evidence.startsWith('/')) return { ok: false, error: '--backup-evidence must be an absolute run directory path (value not echoed)' };
  if (plan === undefined || !PLAN_DIGEST.test(plan)) return { ok: false, error: '--plan must be the exact 64-character lowercase sha256 printed by the reviewed resume --dry-run' };
  return { ok: true, markerId, backupEvidence: evidence, plan };
}

// The controlling terminal, and nothing else: it fails (throws) when there is none. The human's typed values are read here only.
export function openControllingTerminal() {
  const fd = openSync('/dev/tty', fsConstants.O_RDWR | fsConstants.O_NOCTTY);
  return {
    write: (text) => { writeSync(fd, text); },
    readLine: async () => {
      const byte = Buffer.alloc(1);
      let line = '';
      while (line.length < MAX_TTY_LINE) {
        if (readSync(fd, byte, 0, 1, null) === 0) break;
        const ch = byte.toString('latin1');
        if (ch === '\n') break;
        if (ch !== '\r') line += ch;
      }
      return line;
    },
    close: () => { closeSync(fd); },
  };
}

const DEFAULTS = Object.freeze({ ...DEFAULT_PREPARE_DEPS, openTty: openControllingTerminal, randomId: () => randomBytes(16).toString('hex') });

export async function main(argv, overrides = {}) {
  const merged = { ...DEFAULTS, ...overrides };
  const deps = Object.freeze({ ...merged, env: Object.freeze({ ...merged.env }) });
  const fail = (phase, detail) => {
    deps.error(`${PREFIX} FAIL: phase=${phase} — ${detail}`);
    return 1;
  };
  const parsed = parseAuthorizeArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);

  // 1. the backup evidence and the plan exactly as the resume computes them now (files + the contained, archive-only pg_restore --list)
  const s = await staticGates({ mode: 'dry-run', markerId: parsed.markerId, plan: null, confirm: null, action: PREPARE_ACTIONS.RESUME, backupEvidence: parsed.backupEvidence }, deps);
  if (!s.ok) return fail(s.phase, `${s.detail}; nothing was authorized`);
  if (s.digest !== parsed.plan) return fail('plan', '--plan does not match the resume plan computed now; review a fresh resume --dry-run (values not shown); nothing was authorized');
  const backup = s.backup;
  const createdAt = deps.now();
  const expiresAtMs = Math.min(createdAt.getTime() + AUTH_MAX_TTL_MS, Date.parse(backup.createdAt) + MAX_BACKUP_AGE_MS);
  if (!(expiresAtMs > createdAt.getTime())) return fail('expiry', 'the backup is too old to authorize a resume; take a fresh backup; nothing was authorized');

  // 2. the human boundary: the controlling terminal only
  let tty;
  try {
    tty = deps.openTty();
  } catch {
    return fail('tty', 'a controlling terminal (/dev/tty) is required; nothing was authorized');
  }
  let confirmed = false;
  try {
    tty.write([
      '',
      `${PREFIX} OWNER AUTHORIZATION — seed #2 on LOCAL_TEST (single use)`,
      `  target:           ${CONFIRM_LOCAL_TARGET}`,
      `  marker id sha256: ${sha256(parsed.markerId)}`,
      `  backup run:       ${backup.run}`,
      `  dump sha256:      ${backup.dumpSha256}`,
      `  manifest sha256:  ${backup.manifestSha256}`,
      `  fPre (PRE state): ${backup.fPre}`,
      `  checkpoint:       ${backup.checkpointId}`,
      `  plan digest:      ${s.digest}`,
      '  action:           resume-seed-2 (seed #2 inside one protected transaction; rolled back unless the verified post-state is durably witnessed)',
      `  expires:          ${new Date(expiresAtMs).toISOString()}`,
      '',
    ].join('\n'));
    const ask = async (prompt, expected) => {
      tty.write(`${prompt}: `);
      const typed = await tty.readLine();
      return typeof typed === 'string' && typed === expected;
    };
    const answers = [
      await ask('Type the target', CONFIRM_LOCAL_TARGET),
      await ask('Type the first 12 hex characters of fPre', backup.fPre.slice(0, 12)),
      await ask('Type the first 12 hex characters of the dump sha256', backup.dumpSha256.slice(0, 12)),
      await ask(`Type ${CONFIRM_LITERAL}`, CONFIRM_LITERAL),
    ];
    confirmed = answers.every(Boolean);
  } catch {
    confirmed = false;
  } finally {
    try { tty.close?.(); } catch { /* the terminal is done either way */ }
  }
  if (!confirmed) return fail('confirmation', 'a typed confirmation did not match (values not shown); nothing was authorized');

  // 3. the single-use record
  const authId = deps.randomId();
  let text;
  try {
    text = buildAuthorizationRecord({
      authId,
      target: CONFIRM_LOCAL_TARGET,
      markerIdSha256: sha256(parsed.markerId),
      backupRun: backup.run,
      dumpSha256: backup.dumpSha256,
      manifestSha256: backup.manifestSha256,
      fPre: backup.fPre,
      preWitnessSha256: backup.preWitnessSha256,
      checkpointId: backup.checkpointId,
      checkpointRecordSha256: backup.checkpointSha256,
      planDigest: s.digest,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
  } catch {
    return fail('record', 'the authorization record could not be built; nothing was authorized');
  }
  const store = await ensureAuthorizationStore({ home: deps.home });
  if (!store.ok) return fail('store', 'the authorization store is missing or not owner-only; nothing was authorized');
  const written = await writeAuthorizationRecord({ dir: store.dir, authId, text });
  if (!written.durable) return fail('store', 'the authorization record could not be written durably; nothing was authorized');
  deps.log(`${PREFIX} AUTHORIZATION OK authId=${authId} expires=${new Date(expiresAtMs).toISOString()} backup=${backup.run}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runTool(() => main(process.argv.slice(2)), { prefix: PREFIX });
}
