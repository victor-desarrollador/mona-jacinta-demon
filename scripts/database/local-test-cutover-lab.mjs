// LOCAL_TEST cut-over lab — the ONE protected entry for disposable LOCAL_TEST clusters used by
// the PILOT cut-over tooling (references, restore proof, migration rehearsal, real-PG itest).
//
//   node scripts/database/local-test-cutover-lab.mjs --op=provision            --state=EXACT_S4|EXACT_G7|EXACT_G11|EXACT_G12|EXACT_G13|EXACT_G14
//   node scripts/database/local-test-cutover-lab.mjs --op=schema-reference     --state=…
//   node scripts/database/local-test-cutover-lab.mjs --op=backup-restore-proof --state=…
//   node scripts/database/local-test-cutover-lab.mjs --op=migration-rehearsal  --from=EXACT_S4|EXACT_G7|EXACT_G11   (always → EXACT_G14)
//   node scripts/database/local-test-cutover-lab.mjs --op=integration-test
//   node scripts/database/local-test-cutover-lab.mjs --op=teardown             --run=lab-<utc>-<hex>
//
// It never reads a database URL from the shell: an inherited DATABASE_URL, TEST_DATABASE_URL,
// PILOT_*, DEV_*, SUPABASE_*, LOCAL_TEST_*, PG*, NODE_OPTIONS or MONA_* variable refuses the run
// before anything starts. Stage 1 (this process) re-executes itself in a NEW user + network
// namespace (unshare --user --map-root-user --net); stage 2 brings lo up and re-maps to the
// invoking uid (postgres refuses root); stage 3 proves the isolation (only lo, zero routes,
// not root) and only then dispatches the operation (local-test-cutover-lab-ops.mjs). Every
// cluster is created by the lab itself under its 0700 root; every DB command passes the gate
// identity proof (marker, pg_controldata system_identifier, loopback, PostgreSQL 17, exact
// database/user/owner) → exact-state proof → command. It never touches PILOT, DEV, hosted TEST
// or DEMO, and has no remote-capable code path (the namespace has no route at all).
//
// Exit codes: 0 GREEN, 1 arguments, 2 refused (environment/isolation/identity), 3 proof failed, 4 error.
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkInheritedEnv, parseLabArgs, proveIsolation } from './local-test-cutover-lab-core.mjs';

const PREFIX = '[db:local-test-cutover-lab]';
const SELF = fileURLToPath(import.meta.url);
const UNSHARE = '/usr/bin/unshare';
const IP = ['/usr/sbin/ip', '/usr/bin/ip', '/sbin/ip'];
const STAGES = ['--stage=netns', '--stage=inner'];

const defaultDeps = {
  env: process.env, spawn: nodeSpawn, execPath: process.execPath, uid: process.getuid(), gid: process.getgid(),
  readProc: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
  importOps: () => import(pathToFileURL(path.join(path.dirname(SELF), 'local-test-cutover-lab-ops.mjs')).href),
  log: (l) => console.log(l), error: (l) => console.error(l),
};

const waitChild = (child) => new Promise((resolve) => {
  child.on('error', () => resolve(4));
  child.on('close', (code, signal) => resolve(signal ? 4 : (Number.isInteger(code) ? code : 4)));
});

export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const end = (result, rc) => { deps.log(`LAB_RESULT=${result}`); return rc; };
  const refuse = (phase, reason, rc = 2) => { deps.error(`${PREFIX} REFUSED: phase=${phase} — ${reason}`); return end('REFUSED', rc); };

  const stage = STAGES.includes(argv[0]) ? argv[0] : null;
  const rest = stage ? argv.slice(1) : argv;
  const outer = stage === null ? null : (/^--outer=([0-9]+):([0-9]+)$/.exec(rest[0] ?? '') ?? null);
  const labArgv = stage ? rest.slice(1) : rest;
  if (stage && !outer) return refuse('args', 'internal stage without the outer uid/gid', 1);
  const args = parseLabArgs(labArgv);
  if (!args.ok) return refuse('args', 'exactly one --op and its required --state / --from / --run are accepted (values not echoed)', 1);
  const inherited = checkInheritedEnv(deps.env);
  if (!inherited.ok) return refuse('env', `inherited database/provider variables are refused: ${inherited.forbidden.join(', ')} (values not shown)`);

  const baseEnv = { PATH: '/usr/bin:/bin', HOME: deps.env.HOME ?? os.homedir(), LANG: 'C.UTF-8' };
  if (stage === null) {
    // Stage 1: a new user + network namespace; nothing else is inherited.
    const child = deps.spawn(UNSHARE, ['--user', '--map-root-user', '--net', '--', deps.execPath, SELF, '--stage=netns', `--outer=${deps.uid}:${deps.gid}`, ...labArgv],
      { env: baseEnv, stdio: 'inherit', shell: false });
    return waitChild(child);
  }
  if (stage === '--stage=netns') {
    // Stage 2 (root of the new user namespace): loopback up, then back to the invoking uid/gid.
    const ip = IP.find((p) => existsSync(p));
    if (!ip) return refuse('isolation', 'the ip utility is not installed');
    const up = await waitChild(deps.spawn(ip, ['link', 'set', 'lo', 'up'], { env: baseEnv, stdio: 'ignore', shell: false }));
    if (up !== 0) return refuse('isolation', 'the loopback interface could not be brought up');
    const child = deps.spawn(UNSHARE, ['--user', `--map-user=${outer[1]}`, `--map-group=${outer[2]}`, '--', deps.execPath, SELF, '--stage=inner', rest[0], ...labArgv],
      { env: baseEnv, stdio: 'inherit', shell: false });
    return waitChild(child);
  }
  // Stage 3: prove the isolation, then run the operation.
  const iso = proveIsolation({ netDev: deps.readProc('/proc/self/net/dev'), route: deps.readProc('/proc/self/net/route'),
    ipv6Route: deps.readProc('/proc/self/net/ipv6_route') ?? '', uid: deps.uid });
  if (!iso.ok) return refuse('isolation', iso.reason);
  deps.log(`${PREFIX} isolation proven (new user+net namespace: only lo, zero routes, uid ${deps.uid})`);
  let ops;
  try { ops = await deps.importOps(); } catch { return refuse('integrity', 'the lab operations module could not be loaded', 4); }
  try {
    const r = await ops.runOperation(args, { log: deps.log, error: deps.error, home: baseEnv.HOME, execPath: deps.execPath });
    return end(r.ok ? 'GREEN' : (r.result ?? 'FAILED'), r.ok ? 0 : (r.rc ?? 3));
  } catch (e) {
    const msg = String(e?.message ?? '');
    if (msg.startsWith('LOCAL_TEST_IDENTITY_NOT_PROVEN')) { deps.error(`${PREFIX} ${msg.split('\n')[0]}`); return end('LOCAL_TEST_IDENTITY_NOT_PROVEN', 2); }
    if (msg.startsWith('EXACT_STATE_NOT_PROVEN')) { deps.error(`${PREFIX} ${msg.split('\n')[0]}`); return end('EXACT_STATE_NOT_PROVEN', 3); }
    deps.error(`${PREFIX} ERROR — ${msg.split('\n')[0].slice(0, 300)}`);
    return end('ERROR', 4);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  main(process.argv.slice(2)).then((rc) => { process.exitCode = rc; }, () => { console.log('LAB_RESULT=ERROR'); process.exitCode = 4; });
}
