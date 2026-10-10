// Hermetic tests for scripts/dev/safe-nodb-run.mjs (TOOL-1).
//
// Node built-ins only. No database, no external network, no install. These tests never run the real
// Vitest binary: flow tests inject a fake process runner, and one group runs the REAL /usr/bin/unshare
// wrapper against a fake Vitest entry to prove the namespace/loopback/env containment. AST-screening
// tests need a TypeScript module, resolved by `resolveTestTypescript` below: with TOOLING_TEST_TYPESCRIPT_DIR
// UNSET only the exact repo-local, version-pinned <repo>/api/node_modules/typescript (self-contained mode);
// with it SET only that explicit path (supplemental mode). When no valid TypeScript is available those tests
// are reported as SKIPPED with a precise reason, never run against a borrowed package.
//
// PREREGISTRATION (written before the first run). Verdicts: ALLOW = tool
// proceeds / PASS, DENY = refused before spawn (exit 2) or result FAIL
// (exit 1), BLOCKED = no valid execution could be established (exit 3).
//
//   P0A #9  empty test list ........................................ DENY
//   P0A #10 DB-backed test passed to the runner (test-db import) ... DENY
//   P0A #11 path with ".." ......................................... DENY
//   P0A #12 generic nodb config missing ............................ BLOCKED
//   P0A #13 /usr/bin/unshare unavailable ........................... BLOCKED, no unisolated run
//   P0A #14 loopback bring-up fails (ip missing / ip fails) ........ BLOCKED
//   P0A #15 Vitest exits non-zero .................................. DENY (verdict FAIL)
//   P0A #16 Vitest killed by signal / timeout ...................... BLOCKED
//   P0A #17 reporter output missing ................................ BLOCKED
//   P0A #22 inherited DATABASE_URL in caller env ................... ALLOW, never forwarded
//   P0A #24 valid DB-free list, clean ............................... ALLOW (PASS)
//   P0A #25 repo root differs from any hardcoded worktree .......... ALLOW (root computed)
//   P0A #28 `import type { PrismaClient }` ......................... ALLOW (clean)
//   P0A #29 DB env name only in a comment .......................... ALLOW (clean)
//   P0A #30 'TEST_DATABASE_URL' string literal in code ............. WARN
//   P0A #31 literal import of src/config/prisma .................... WARN
//   P0A #32 tests/helpers/in-memory-sales-db import ................ ALLOW (clean)
//   P0A #33 tests/helpers/test-db import ........................... DENY
//   P0A #34 createTestPrismaClient identifier ...................... DENY
//   P0A #35 globalSetup import ..................................... DENY
//   P0A #36 pg / adapter-pg import, new Pool/Client ................ DENY
//   P0A #37 child_process .......................................... DENY
//   P0A #38 non-literal dynamic import ............................. DENY
//   P0A #39 unparsable test file ................................... DENY
//   P0A #40 normal tracked DB-free test, end to end ................ ALLOW (PASS)
//   P0A #41 untracked regular test path ............................ DENY
//   P0A #42 exit 0 but zero tests in the report .................... DENY (verdict FAIL)
//   P0A #43 malformed JSON report .................................. BLOCKED
//   P0A #44 local Vitest entry absent .............................. BLOCKED
//   P0A #45 unshare exits non-zero before Vitest ................... BLOCKED
//   P0A #46 absolute path .......................................... DENY
//   P0A #47 glob syntax ............................................ DENY
//   P0A #48 tracked file outside api/tests/ ........................ DENY
//   P0A #49 TypeScript unresolvable ................................ BLOCKED
//   P0A #8  (T1 part) symlink where a regular file is expected ..... DENY
//   not applicable here: #1-7,#18-21,#23,#26,#27,#50-61 (T2/T3/T4/hook).
//
//   P0B-XN01 "./" prefix, double slash, trailing slash, backslash ... DENY
//   P0B-XN02 option-like argument (--help, -x) ...................... DENY
//   P0B-XN03 NUL / control character / non-string / empty element ... DENY
//   P0B-XN04 duplicate test path .................................... ALLOW, deduplicated
//   P0B-XN05 uppercase API/Tests prefix, "api/testsx/" lookalike .... DENY
//   P0B-XN06 tracked file replaced by FIFO / deleted from disk ...... DENY
//   P0B-XN07 symlinked parent directory ............................. DENY
//   P0B-XN08 report names a file that was not validated (filter overmatch) ... BLOCKED
//   P0B-XN09 report omits a requested file .......................... BLOCKED
//   P0B-XN10 report totals inconsistent ............................. BLOCKED
//   P0B-XN11 report success:true although failures present .......... BLOCKED
//   P0B-XN12 exit 0 but a suite failed (no assertion results) ....... DENY (verdict FAIL)
//   P0B-XN13 all tests skipped/todo ................................. DENY (verdict FAIL)
//   P0B-XN14 exit non-zero although the report shows all passed ..... DENY (verdict FAIL)
//   P0B-XN15 exit 0 but the isolation marker was never created ...... BLOCKED
//   P0B-XN16 inline `{ type X }` import of a driver ................. DENY (conservative)
//   P0B-XN17 multiline / template-literal / export-from / require forms ... DENY
//   P0B-XN18 import specifier aliasing (extensions, ../ chains, @/) . DENY / WARN by resolved path
//   P0B-XN19 `new PrismaClient`, `new pg.Client`, createRequire ..... DENY
//   P0B-XN20 identifier DATABASE_URL via process.env ................ WARN
//   P0B-XN21 type-only whole-declaration imports of denied modules .. ALLOW
//   P0B-XN22 the real in-memory helper source passes the same screen . ALLOW (clean)
//   P0B-XN23 WARN does not stop the run; warnings reach the evidence . PASS + warnings
//   P0B-XN24 temp dir is outside the repo and removed ............... ALLOW
//   P0B-XN25 deterministic output ................................... ALLOW
//   P0B-XN26 real unshare: only lo, env scrubbed, cwd api/ .......... PASS (probe inside the namespace)
//   P0B-XN27 real unshare with a failing ip ......................... BLOCKED
//   P0B-XN28 real timeout kills the process group ................... BLOCKED
//   P0B-XN29 every spawn goes through /usr/bin/unshare -rn .......... never a bare node/vitest run
//   P0B-XN30 synthetic env constants equal api/tests/helpers/test-runtime-env.ts ... ALLOW
//   P0B-XN31 CLI: no args / option-like / absolute path ............. exit 2
//
// HISTORICAL MISMATCH (TOOLING-P0B, kept on record): P0B-XN26 was preregistered
// as "the child sees EXACTLY the nine explicit variables". The real /bin/sh
// (dash) adds PWD, so the first run FAILED that expectation. Classification:
// EXPECTATION_MISMATCH; no implementation defect was demonstrated; the probe now
// permits shell-added PWD while still proving caller variables are scrubbed.
//
// TOOLING-P0B1 POST-MISMATCH PREREGISTRATION (written BEFORE these cases were
// first run). Defect class exposed by XN26: "runtime wrappers/shells may add or
// transform process environment and execution metadata". Real /usr/bin/unshare
// plus an observing fake Vitest records what the child really sees.
//
//   P0B-XN32 no caller overrides: child PWD is exactly <root>/api and equals its cwd ........ ALLOW (PASS)
//   P0B-XN33 caller PWD=/etc/evil: child PWD is still <root>/api; runner never passes PWD ... ALLOW (PASS)
//   P0B-XN34 caller HOME=<canary>: child HOME is the runner's fresh mona-nodb-* dir ......... ALLOW (PASS)
//   P0B-XN35 caller TMPDIR=<dir>: child TMPDIR is a fresh mona-nodb-* SUBDIR of it, == HOME ... ALLOW (PASS)
//   P0B-XN36 caller TMPDIR inside the repo: temp dir would resolve in the repo ............... BLOCKED (TMPDIR_IN_REPO)
//   P0B-XN37 caller TMPDIR=<nonexistent dir>: temp dir cannot be created ..................... BLOCKED (never a thrown crash / exit 1)
//   P0B-XN38 caller NODE_ENV/JWT/CORS/DB URLs/PATH/ENV/BASH_ENV/NODE_OPTIONS/LD_PRELOAD set ... ALLOW (PASS); child gets only runner values
//   P0B-XN39 test path containing shell metacharacters ($ ; ' &) reaches Vitest as ONE argv entry, no injection .. ALLOW (PASS)
//
// RESULT OF THE FIRST P0B1 RUN (recorded, not rewritten):
//   XN37 MISMATCH -> IMPLEMENTATION_DEFECT: a nonexistent caller TMPDIR made mkdtemp reject and the
//        runner THREW (a crash is exit 1, which reads as FAIL; the contract requires BLOCKED).
//   XN38 MISMATCH -> TEST_EXPECTATION_ERROR: the "leaked value" check searched the stringified child
//        env for the caller value "1" (JWT_ACCESS_TTL_SECONDS), a substring of unrelated text such
//        as "127.0.0.1". The per-key equality assertions (which passed) are the real proof; the
//        substring sweep now only covers values of 8+ characters.
//
// SECOND PREREGISTRATION (written BEFORE running; derived from the XN37 defect class "unexpected
// operational exceptions must surface as BLOCKED, never as a thrown crash / exit 1"):
//   P0B-XN40 caller TMPDIR is a regular file (ENOTDIR) ............................ BLOCKED, no throw
//   P0B-XN41 caller TMPDIR is a read-only directory (EACCES) ...................... BLOCKED, no throw
//   P0B-XN42 repo root does not exist / is not a git repository ................... BLOCKED, no throw
//   P0B-XN43 a listed test file is unreadable during the AST screen (EACCES) ...... BLOCKED, no throw
//   P0B-XN44 the injected process runner itself rejects unexpectedly .............. BLOCKED, no throw
//   P0B-XN45 the reporter file exists but cannot be read (EACCES), exit 0 ......... BLOCKED
//   P0B-XN46 the Vitest entry crashes at startup (syntax error), real unshare ..... FAIL (documented contract:
//            non-zero exit after isolation is established); reporterParsed false, REPORTER_MISSING noted
//
// RESULT OF THE SECOND P0B1 BATCH (against the then-unchanged implementation; recorded, not rewritten):
//   XN37/XN40/XN41/XN44 MISMATCH -> IMPLEMENTATION_DEFECT (same root: mkdtemp and the process-runner
//   call were unguarded, so an operational exception escaped as a crash/exit 1). XN42, XN43, XN45, XN46 matched.
//   (XN41/43/45 first ran INVALID: my test forgot to import chmodSync -> ReferenceError. Fixed in the test, re-run.)
//   FIX applied to safe-nodb-run.mjs: TMPDIR_UNUSABLE guard around mkdtemp + a generic wrapper that turns any
//   unexpected exception into BLOCKED RUNNER_INTERNAL_ERROR (error code/name only, never a message or path).
//   PROCESS NOTE: the fix was applied BEFORE this third preregistration; the rule asks for new cases
//   "before continuing". The third batch below is therefore run against the already-fixed code.
//
// THIRD PREREGISTRATION (written before running; class: "the exception guard itself and malformed
// collaborator results must still end in BLOCKED, never a crash"):
//   P0B-XN47 `paths` is an array whose element access throws (Proxy trap) ........ BLOCKED, no throw (even while building the error result)
//   P0B-XN48 the screening collaborator returns undefined ......................... BLOCKED, no throw
//   P0B-XN49 the process-runner collaborator returns undefined .................... BLOCKED, no throw
//   P0B-XN50 the runner reports exit 0 AND a signal (contradictory) ............... BLOCKED (KILLED_BY_SIGNAL), never PASS
//   P0B-XN51 the reporter path is a directory, not a file (EISDIR), exit 0 ........ BLOCKED, reporterParsed false
//
// RESULT OF THE THIRD BATCH (run against the fixed-once code; recorded, not rewritten):
//   XN47 MISMATCH -> IMPLEMENTATION_DEFECT: the generic wrapper's catch block re-read the hostile `paths`
//        (calling .map on it) to build its error result, so the guard itself threw. XN48-XN51 matched.
//
// FOURTH PREREGISTRATION (written BEFORE running and BEFORE any fix this time; class: "building the error
// result / evidence must never depend on, or re-execute, untrusted input"):
//   P0B-XN52 `deps` object whose property access throws ........................... BLOCKED, no throw
//   P0B-XN53 a paths element whose toString() throws .............................. DENY (NOT_A_STRING), no throw
//   P0B-XN54 a paths element that is a Symbol ..................................... DENY (NOT_A_STRING), no throw
//   P0B-XN55 repoRoot is not a string (42) ........................................ BLOCKED, no throw
//   P0B-XN56 runSafeNodb(null) .................................................... BLOCKED, no throw
//   P0B-XN57 a sparse paths array with holes ...................................... DENY (NOT_A_STRING), no throw
//
// RESULT OF THE FOURTH BATCH (run BEFORE any fix, as the rule requires; recorded, not rewritten):
//   XN47 (carried over) and XN53 MISMATCH -> IMPLEMENTATION_DEFECT, same root as XN47: untrusted values were
//   stringified outside any guard (String(p) in the policy detail, .map in the error path).
//   XN52, XN54, XN55, XN56, XN57 matched.
//   CLASS FIX (one helper, safeText: String() inside try/catch, length-bounded) now used by the policy detail, the
//   `requested` list and the exception wrapper; errorTag is guarded too.
//
// FIFTH PREREGISTRATION (written after the fix, BEFORE running; PROCESS NOTE: unlike batch 4 the fix preceded
// this batch, to stop the mismatch->batch->mismatch recursion once the class was understood; class: "every
// way an untrusted value can be stringified into the evidence"):
//   P0B-XN58 a paths element with a throwing Symbol.toPrimitive ................... DENY (NOT_A_STRING), no throw
//   P0B-XN59 a 1 MB invalid path string ........................................... DENY; every evidence string stays <= 600 chars
//   P0B-XN60 a lone-surrogate path 'api/tests/\ud800.test.ts' ..................... DENY (not tracked), no throw
//   P0B-XN61 a BigInt element ..................................................... DENY (NOT_A_STRING), no throw
//   P0B-XN62 a null-prototype object element (String() would throw) ............... DENY (NOT_A_STRING), no throw


// ===========================================================================
// TOOLING-P0D PREREGISTRATION (written BEFORE the first P0D run).
//
// P0C review inputs treated as RED: (HIGH) filesystem AF_UNIX sockets are reachable from `unshare -rn`;
// (MEDIUM) AST screening bypass classes: loader indirection, eval/Function, createRequire aliasing,
// query/hash-suffixed specifiers, one-level scanning; (MEDIUM, TOOL-2) rename attribution for RM/RD.
// Existing assertions that encoded the OLD model (`-rn` argv, single `networkIsolation` field, env list)
// were updated to the new design in the same edit; they are RED inputs too.
//
// Cases below are NEW (not copied from P0A/P0B/P0B1/P0C or the P0D prompt examples). EXPECTED:
//
//  SCREENING (screenSource, needs TypeScript)
//   P0D-Y01 aliased loader receiver  `const v = vi; await v.importActual('pg')` ............ DENY DB_DRIVER_IMPORT
//   P0D-Y02 destructured/renamed loader `const { importActual: load } = vi; load('node:child_process')` ... DENY INDIRECT_LOADER
//   P0D-Y03 fragment suffix  `import '../helpers/test-db.js#section'` ....................... DENY DB_HELPER_IMPORT
//   P0D-Y04 percent-encoded  `import '../helpers/test%2Ddb.js'` ............................. DENY DB_HELPER_IMPORT
//   P0D-Y05 URL-scheme specifier `import x from 'file:///abs/thing.js'` ...................... DENY UNANALYZABLE_SPECIFIER
//   P0D-Y06 pure binding `import { isIP } from 'node:net'` (rateLimit.ts does this) ........... ALLOW clean
//   P0D-Y07 namespace + query `import * as n from 'node:net?x=1'` ............................ DENY SOCKET_PRIMITIVE_IMPORT
//   P0D-Y08 `http.request({ socketPath: '/var/run/docker.sock' })` ............................ DENY SOCKET_PATH_USE
//   P0D-Y09 bare literal '/run/postgresql/.s.PGSQL.5432' ..................................... WARN UNIX_SOCKET_PATH_LITERAL
//   P0D-Y10 indirect eval `(0, eval)('1')` .................................................... DENY DYNAMIC_CODE
//   P0D-Y11 `[].constructor.constructor('return process')()` .................................. DENY DYNAMIC_CODE
//   P0D-Y12 string timer `setTimeout('boom()', 0)` ............................................ DENY DYNAMIC_CODE
//   P0D-Y13 `import vm from 'node:vm'` ........................................................ DENY DYNAMIC_CODE_IMPORT
//   P0D-Y14 `import { createRequire as mk } from 'node:module'; mk(import.meta.url)('pg')` ..... DENY INDIRECT_REQUIRE + LOADER_MODULE_IMPORT
//   P0D-Y15 `const r = require; r('pg')` ...................................................... DENY INDIRECT_REQUIRE
//   P0D-Y16 `vi.mock('pg', async (orig) => ({ ...(await orig()) }))` loads the real driver .... DENY DB_DRIVER_IMPORT
//   P0D-Y17 `vi.mock('pg', () => ({ Pool: class {} }))` never loads the real module ........... ALLOW clean
//   P0D-Y18 `import.meta.glob('./*.ts')` ...................................................... DENY NON_LITERAL_IMPORT
//   P0D-Y19 impure named binding `import { isIP, connect } from 'node:net'` ................... DENY SOCKET_PRIMITIVE_IMPORT
//  TRANSITIVE CLOSURE (fixture repo, real default screen, needs TypeScript)
//   P0D-Y20 test -> tests/helpers/h1 -> src/h2 which imports 'pg' (depth 3) ................... DENY, offending file named
//   P0D-Y21 import cycle a<->b, both clean .................................................... PASS (terminates)
//   P0D-Y22 relative import of a file that does not exist ..................................... DENY UNRESOLVED_LOCAL_IMPORT
//   P0D-Y23 directory import './lib' -> lib/index.ts imports 'node:tls' ....................... DENY
//   P0D-Y24 './x.js' specifier resolving to x.ts containing child_process .................... DENY
//   P0D-Y25 import of a missing file under api/src/generated/ (gitignored build output) ........ PASS (leaf)
//   P0D-Y26 bare package whose node_modules source contains pg: never traversed ............... PASS
//   P0D-Y27 closure larger than the bound (maxScreenFiles=3, 5-file chain) .................... DENY CLOSURE_TOO_LARGE
//   P0D-Y28 local import that is a symlink ..................................................... DENY
//   P0D-Y29 local import escaping the repository ............................................... DENY
//   P0D-Y30 chain reaching api/src/config/prisma.ts (boundary, contains pg + new PrismaClient) . PASS + WARN PRISMA_CONFIG_IMPORT
//   P0D-Y31 local non-code import './data.json' ............................................... PASS (leaf)
//   P0D-Y32 helper two levels down uses `socketPath` ........................................... DENY SOCKET_PATH_USE
//  ISOLATION (real /usr/bin/unshare + observing fake Vitest; ONLY test-created disposable sockets)
//   P0D-Y33 disposable socket under /run/user/UID is unreachable from the child (default masks) . PASS, child sees ENOENT, server hits 0
//   P0D-Y34 POSITIVE CONTROL: the same probe under the old `-rn` model connects ................ server hits >= 1 (proves Y33 discriminates)
//   P0D-Y35 injected mask dir (temp layout): socket inside it is unreachable ................... PASS, ENOENT, hits 0
//   P0D-Y36 child sees an empty /run, /var/run resolves to the same place; host /run and host mounts unchanged ... PASS
//   P0D-Y37 PG defaults forced; caller PGHOST/PGSERVICE/PGPASSWORD/PGUSER/PGDATABASE never reach the child ........ PASS
//   P0D-Y38 mount tool fails (/usr/bin/false) .................................................. BLOCKED RUNTIME_MASK_FAILED, Vitest never starts
//   P0D-Y39 wrapper sentinels 95 / 96 without marker ........................................... BLOCKED PROPAGATION_NOT_PRIVATE / RUNTIME_MASK_FAILED
//   P0D-Y40 caller TMPDIR located under a masked directory ..................................... BLOCKED TMPDIR_UNDER_MASKED_DIR, nothing spawned
//   P0D-Y41 PASS evidence: tcpDnsIsolation ENFORCED, runtimeSocketIsolation MASKED, maskedRuntimeDirs, arbitrary... NOT_GUARANTEED, no networkIsolation key
//   P0D-Y42 BLOCKED evidence: NOT_ESTABLISHED for both, arbitrary... stays NOT_GUARANTEED ....... BLOCKED
//   P0D-Y43 /var/run symlink -> ['/run'] ; distinct directory -> ['/run','/var/run'] ; absent -> ['/run'] (injected fs ops) ... mask list
//   P0D-Y44 mount binary missing ................................................................ BLOCKED MOUNT_MISSING, nothing spawned
//   P0D-Y45 a mask directory that does not exist ................................................ BLOCKED RUNTIME_DIR_UNAVAILABLE
//
// RESULT / PROCESS NOTES are appended below after the first run (not rewritten).
//
// P0D RESULT / PROCESS NOTES (recorded in P0F from what P0D actually observed; nothing here is new evidence):
//   * PREREGISTERED: 57 cases before the first P0D run: runner P0D-Y01..Y45 and guard P0D-G44..G55. The guard
//     cases were first numbered Y44..Y55 and renamed G44..G55 before GREEN to avoid an ID collision with the
//     runner's Y44/Y45 (cosmetic, disclosed).
//   * RED (old implementation, supplemental TypeScript so AST tests executed): 177 tests, 41 failed, ALL
//     AssertionError (no module/syntax/fixture failure), 136 passed. Intended failure reasons: socket probe
//     returned CONNECTED instead of ENOENT; child listed the host /run; PGHOST undefined; transitive helpers
//     returned PASS instead of DENY; RM/RD put a phantom original path in DIRTY. Regression pins that
//     correctly passed before and after: Y21, Y25, Y26, Y31, G46..G48, G50, G51, G53..G55.
//   * Existing assertions encoding the OLD model (-rn argv, single networkIsolation field, env list, PWD probe
//     list) were updated to the new design in the same edit as the RED tests.
//   * FIXED CLASSES: (1) filesystem runtime sockets (mount namespace, private propagation, /run tmpfs mask,
//     /var/run only if distinct, PG* defaults to the isolated TCP namespace); (2) screening by syntax class
//     over a bounded transitive repository-local closure; (3) TOOL-2 rename attribution by git XY letters.
//   * FINAL STATUS: all 57 preregistered cases matched against the fixed implementation (no post-implementation
//     mismatch, so no extra batch was required under the mismatch rule as applied). Totals at P0D close:
//     SELF_CONTAINED_GREEN 177 tests = 139 passed + 38 skipped (TypeScript-dependent AST/closure tests) + 0 failed;
//     SUPPLEMENTAL_NON_SELF_CONTAINED_EVIDENCE (external TypeScript 5.9.3, not a repo dependency) 177/177 passed.
//   * REAL_VITEST_HAPPY_PATH: NOT RUN. TOOL-1 is NOT integration-validated.
//   * Residual, unchanged: arbitrary filesystem AF_UNIX sockets outside the masked runtime dirs are NOT_GUARANTEED.
//
// ===========================================================================
// TOOLING-P0F PREREGISTRATION (written BEFORE the first P0F run).
// P0E finding (MEDIUM): a PARAMETERLESS vi.mock(spec) / vi.doMock(spec) makes Vitest AUTOMOCK, which loads and
// evaluates the real module, but the screen was silent for that form. Class: "a mock registration that can load
// the original module is a module-load edge". Rule: it is NOT a load edge only when the second argument is a
// function-like factory with ZERO parameters (it cannot receive importOriginal). Everything else (no factory,
// undefined, options object such as { spy: true }, a factory of unknown arity, any factory with >=1 parameter)
// is a load edge and goes through the SAME normalized classification and closure as a real import. A
// non-literal specifier on a load edge is DENY (unanalyzable). Existing factory-with-parameter handling is kept.
// Note: the older test "strings and comments that merely mention imports" asserted that `vi.mock('pg');` was
// clean. That expectation encoded the very silence P0E found, so it was changed to the zero-parameter-factory
// form (disclosed here, not hidden).
//
//  screenSource cases (needs TypeScript)
//   P0F-Z01 `vi.mock('postgres')` ................................................ DENY DB_DRIVER_IMPORT
//   P0F-Z02 `vi.doMock('node:tls')` ............................................ DENY SOCKET_PRIMITIVE_IMPORT
//   P0F-Z03 `vi.mock('node:child_process')` ..................................... DENY CHILD_PROCESS_IMPORT
//   P0F-Z04 options object `vi.mock('pg', { spy: true })` ....................... DENY DB_DRIVER_IMPORT
//   P0F-Z05 scoped + suffix `vi.mock('@prisma/adapter-pg?raw')` ................. DENY DB_DRIVER_IMPORT
//   P0F-Z06 explicit `vi.mock('pg', undefined)` ................................. DENY DB_DRIVER_IMPORT
//   P0F-Z07 factory of unknown arity `vi.mock('pg', makeFactory)` ............... DENY DB_DRIVER_IMPORT (fail closed)
//   P0F-Z08 rest-parameter factory `vi.mock('pg', (...a) => ({}))` .............. DENY DB_DRIVER_IMPORT
//   P0F-Z09 CONTROL zero-parameter factory `vi.mock('pg', () => ({}))` .......... ALLOW clean
//   P0F-Z10 CONTROL async zero-parameter factory .................................. ALLOW clean
//   P0F-Z11 CONTROL function-expression factory `vi.doMock('pg', function () {})` ALLOW clean
//   P0F-Z12 CONTROL parameterless mock of a harmless builtin `vi.mock('node:fs')` ALLOW clean
//   P0F-Z13 CONTROL `vi.unmock('pg')` and `vi.doUnmock('pg')` (never load) ...... ALLOW clean
//   P0F-Z14 non-literal parameterless `vi.mock(name)` / template with substitution  DENY NON_LITERAL_IMPORT
//   P0F-Z15 CONTROL non-literal specifier WITH zero-parameter factory ............ ALLOW clean
//   P0F-Z16 typed form `vi.mock(import('pg'))` ................................. DENY DB_DRIVER_IMPORT (through import());
//           and `vi.mock(import('./safe.js'), () => ({}))` ....................... ALLOW (no finding)
//   P0F-Z17 aliased receiver `const v = vi; v.mock('pg')` ........................ DENY DB_DRIVER_IMPORT
//   P0F-Z18 element access `vi['doMock']('pg')` ................................. DENY DB_DRIVER_IMPORT
//   P0F-Z19 value reference `const m = vi.mock;` and `const { doMock } = vi;` ... DENY INDIRECT_MOCK
//   P0F-Z20 CONTROL spy bookkeeping `fn.mock.calls`, `vi.fn().mock.results` ...... ALLOW clean
//  closure cases (fixture repo, real default screen, needs TypeScript)
//   P0F-Z21 test -> vi.mock('./h1') -> h1 imports ./h2 -> h2 imports node:net (default) ... DENY, h2 named
//   P0F-Z22 parameterless mock of an unresolvable local module ................... DENY UNRESOLVED_LOCAL_IMPORT
//   P0F-Z23 cycle through parameterless local mocks .............................. PASS (terminates)
//   P0F-Z24 local mock with query+hash `vi.mock('./h1.js?x=1#y')` ............... DENY (resolved and traversed)
//   P0F-Z25 CONTROL zero-parameter factory mock of a local module with a bad import  PASS (never loaded, not traversed)
//   P0F-Z26 parameterless mock of the repo DB helper `../helpers/test-db.js` ..... DENY DB_HELPER_IMPORT
//   P0F-Z27 parameterless mock of api/src/config/prisma (boundary) ............... PASS + WARN PRISMA_CONFIG_IMPORT
//   P0F-Z28 CONTROL parameterless mock of a bare third-party package ............. PASS (third-party never traversed)
//   P0F-Z29 parameterless mock of api/src/generated/** (gitignored build output) . PASS (leaf, unchanged policy)
//   P0F-Z30 closure bound still applies to mock-reached files (maxScreenFiles=3) .. DENY CLOSURE_TOO_LARGE
// ===========================================================================
//
// P0F RESULT / PROCESS NOTES (recorded in P0H from what P0F actually observed): 30 cases preregistered; RED on the
// old screen = 189 tests, 10 failed (all AssertionError), 179 passed (controls included); GREEN 189/189
// (supplemental TypeScript) and 139 passed + 50 skipped + 0 failed self-contained. The older test asserting that
// `vi.mock('pg');` was clean was changed to the zero-parameter-factory form because it encoded the P0E silence.
//
// ===========================================================================
// TOOLING-P0H PREREGISTRATION (written BEFORE the first P0H run). Codex final review (MEDIUM x3):
//  A. result accounting: duplicate reporter entries for one requested file collapsed through Set comparison and
//     produced PASS; unknown suite status, invalid and inconsistent suite totals were accepted.
//  B. mock access: bracket/computed/bound property forms of mock/doMock escaped the screen.
//  C. (TOOL-2, tested in repo-scope-guard.test.mjs) malformed porcelain-v2 records were accepted.
// Rule for this block: the REQUIRED Codex regressions are listed first and DO NOT count toward the independent set.
//
//  REQUIRED CODEX REGRESSIONS (not independent)
//   P0H-CX-A1 two identical report entries for the one requested file (consistent totals) .... BLOCKED REPORT_DUPLICATE_FILE
//   P0H-CX-A2 suite status 'weird' ............................................................. BLOCKED
//   P0H-CX-A3 invalid suite totals (-1, '1', null, 1.5) ........................................ BLOCKED REPORTER_MALFORMED
//   P0H-CX-A4 inconsistent suite totals (total != sum / != entries) ............................ BLOCKED REPORTER_INCONSISTENT
//   P0H-CX-B1 `const m = vi['mock']; m('pg')` .................................................. DENY INDIRECT_MOCK
//   P0H-CX-B2 `vi['mock'].bind(vi)('pg')` ...................................................... DENY INDIRECT_MOCK
//   P0H-CX-B3 `vi[key]('pg')` (unresolvable computed property on a mock receiver) ............. DENY INDIRECT_MOCK
//
//  INDEPENDENT CASES (new in P0H; none appears in P0A..P0G, the Codex report or the prompt examples)
//  report accounting (runner, fake process runner)
//   P0H-W01 duplicate entry spelled differently (`.../rbac/../rbac/a.test.ts`) ................ BLOCKED REPORT_DUPLICATE_FILE
//   P0H-W02 two requested files; report lists A twice and omits B (consistent totals) .......... BLOCKED
//   P0H-W03 a suite entry that is an array / null / a string ................................... BLOCKED REPORTER_MALFORMED
//   P0H-W04 report file name is relative ....................................................... BLOCKED REPORTER_MALFORMED
//   P0H-W05 non-finite totals (numTotalTestSuites: 1e999) ...................................... BLOCKED REPORTER_MALFORMED
//   P0H-W06 suite status 'passed' although it holds a failed assertion (counts consistent) ..... BLOCKED REPORTER_INCONSISTENT
//   P0H-W07 suite status 'skipped' although it holds a passed assertion ....................... BLOCKED REPORTER_INCONSISTENT
//   P0H-W08 suite totals absent entirely ....................................................... BLOCKED REPORTER_MALFORMED
//   P0H-W09 a suite has status 'failed' but numFailedTestSuites is 0 ........................... BLOCKED REPORTER_INCONSISTENT
//   P0H-W10 an assertion entry that is null / a string ......................................... BLOCKED REPORTER_MALFORMED
//   P0H-W11 CONTROL valid negative evidence: suite 'failed', suite totals consistent, exit 0 .... FAIL SUITE_FAILED
//   P0H-W12 CONTROL two requested files reported in a different order .......................... PASS
//   P0H-W13 only numPendingTestSuites inconsistent ............................................. BLOCKED REPORTER_INCONSISTENT
//   P0H-W14 empty file name / non-string file name ............................................. BLOCKED REPORTER_MALFORMED
//  mock access (screenSource; needs TypeScript)
//   P0H-W20 `const k = 'mock'; vi[k]('pg')` (constant-folded name) ............................. DENY DB_DRIVER_IMPORT
//   P0H-W21 `vi['do' + 'Mock']('node:net')` (concatenated name) ................................ DENY SOCKET_PRIMITIVE_IMPORT
//   P0H-W22 `` vi[`mock`]('pg') `` (template name) ............................................. DENY DB_DRIVER_IMPORT
//   P0H-W23 `vi[flag ? 'mock' : 'doMock']('pg')` (conditional name) ............................ DENY INDIRECT_MOCK
//   P0H-W24 `const reg = vi[pick()]; reg('x')` (computed value extracted) ...................... DENY INDIRECT_MOCK
//   P0H-W25 alias chain `const a = vi; const b = a; const m = b['mock']; m('pg')` ............. DENY INDIRECT_MOCK
//   P0H-W26 `import { vi as v } from 'vitest'; const m = v.doMock; m('pg')` .................... DENY INDIRECT_MOCK
//   P0H-W27 `vi['mock'].call(vi, 'pg')` and `Reflect.apply(vi['doMock'], vi, ['pg'])` ........... DENY INDIRECT_MOCK
//   P0H-W28 `const { ['do' + 'Mock']: reg } = vi` and `const { [k]: reg } = vi` ................. DENY INDIRECT_MOCK
//   P0H-W29 `const { ...rest } = vi; rest['mock'](...)` and `rest.mock('pg')` .................. DENY
//   P0H-W30 CONTROL static non-mock names on a mock receiver: vi['fn'](), vi[`spyOn`](o,'m') ... ALLOW clean
//   P0H-W31 CONTROL unrelated objects: registry[name]('pg'), o['mock'] ........................... ALLOW clean
//   P0H-W32 `(vi as any)['mock']('./x.js', () => ({}))` ALLOW; `(vi as any)['mock']('pg')` DENY .. as stated
//   P0H-W33 closure: `vi['do' + 'Mock']('./helpers/w33.js')` where w33 imports pg ............... DENY, w33 named
//   P0H-W34 `vi?.mock('pg')` and `vi.mock?.('pg')` (optional chaining) ........................... DENY DB_DRIVER_IMPORT
//  porcelain parser (TOOL-2; see repo-scope-guard.test.mjs header for P0H-P*)
//
// FIXTURE CORRECTION recorded (not a behavior loosening): the pre-existing [P0B-XN13] skipped-only fixture declared
// numPassedTestSuites=1 although its only suite entry has status 'skipped'. Suite counters were not validated before
// P0H, so that inconsistency was invisible; under the strict contract it is REPORTER_INCONSISTENT, so the fixture's
// counters were corrected (numPassedTestSuites 0, numPendingTestSuites 1) to describe its own entry truthfully.
// ===========================================================================
//
// P0H RESULT / PROCESS NOTES (recorded in P0J from what P0H actually observed; nothing here is new evidence):
//   * FIRST TDD RED (before the later control cases P0H-P20..P30 were added): 214 tests, 194 passed, 20 failed, all
//     AssertionError (no module/syntax/fixture failure).
//   * Two EXPECTATION_ERROR mismatches occurred on controls and are recorded above (P0H-P19 backslash vs the
//     argument contract; P0H-P10/P11 XY side confusion); extra cases P0H-P20..P25 and P0H-P26..P30 were derived.
//   * FINAL P0H STATE: SELF_CONTAINED_GREEN 218 tests = 161 passed + 57 skipped + 0 failed (the skips are the
//     TypeScript-dependent AST/closure tests); SUPPLEMENTAL_NON_SELF_CONTAINED_EVIDENCE (external TypeScript 5.9.3,
//     not a repo dependency) 218/218 passed.
//   * REAL_VITEST_HAPPY_PATH: NOT RUN (still).
//
// ===========================================================================
// TOOLING-P0J PREREGISTRATION (written BEFORE the first P0J run).
// Finding (independent P0I, static reading of pinned Vitest 5.0.0): FILE tasks have type "suite" and getSuites(files)
// includes file suites AND nested describe suites, so numTotalTestSuites can be GREATER than testResults.length.
// The runner wrongly tied suite counters to file entries (numTotalTestSuites === testResults.length and
// passed/failed/pending suite counters === tallies of file-entry statuses), so a valid real report with describe
// blocks would be BLOCKED REPORTER_INCONSISTENT (fail-closed, but Gate B could never succeed).
// Supported relationships kept: total === passed + failed + pending (suite sub-counts); total >= file entries (each file
// is itself a suite); a file entry marked failed must be counted among numFailedTestSuites; any failed suite (file entry
// or counter) prevents PASS and contradicts success:true. NOT kept: equality to file-entry counts.
//
//  REQUIRED P0J REGRESSIONS (not independent)
//   P0J-NV1 one file with one nested describe (numTotalTestSuites 2 > 1 file entry), all passing, exit 0 .... PASS
//   P0J-NV2 one file with three nested describes ................................................ PASS
//   P0J-NV3 two requested files with nested describes (2 + 3 describes) ......................... PASS
//
//  INDEPENDENT CASES
//   P0J-V01 deep nesting: describe in describe in describe (3 describes) in one file ................ PASS
//   P0J-V02 nested describe skipped: file+A passed, B pending (suites 2/0/1), one executed pass ..... PASS
//   P0J-V03 file failed + nested describe failed (suites 0/2/0), failed assertion, Vitest exit 1 ..... FAIL
//   P0J-V04 exit 0, file entry passed, numFailedTestSuites 1 (a describe failed), success false ...... FAIL SUITE_FAILED
//   P0J-V05 same as V04 but success true ................................................................ BLOCKED REPORTER_INCONSISTENT
//   P0J-V06 total 4 but passed 2 + failed 0 + pending 1 (sum 3) ......................................... BLOCKED REPORTER_INCONSISTENT
//   P0J-V07 two requested files but numTotalTestSuites 1 (fewer suites than files) ..................... BLOCKED REPORTER_INCONSISTENT
//   P0J-V08 file entry failed but numFailedTestSuites 0 (nested suites inflate the total) ............... BLOCKED REPORTER_INCONSISTENT
//   P0J-V09 a component exceeds the total (numPassedTestSuites 5, total 2) .............................. BLOCKED REPORTER_INCONSISTENT
//   P0J-V10 suite counter that is a string / negative / fractional / non-finite ......................... BLOCKED REPORTER_MALFORMED
//   P0J-V11 nested describes whose tests are all todo, exit 0 ........................................... FAIL NO_TESTS_EXECUTED
//   P0J-V12 three files with 0, 2 and 5 nested describes (total 10) ................................... PASS
//   P0J-V13 duplicate file entry hidden behind inflated nested-suite totals ............................ BLOCKED REPORT_DUPLICATE_FILE
//   P0J-V14 test counters stay strict beside nested suites (numTotalTests 3, assertion evidence 2) ..... BLOCKED REPORTER_INCONSISTENT
//   P0J-V15 file entry passed although it holds a failed assertion (nested suites present) .............. BLOCKED REPORTER_INCONSISTENT
// ===========================================================================
//
// P0J RESULT / PROCESS NOTES (recorded in P0L from what P0J actually observed): RED = 228 tests, 221 passed, 7 failed
// (all AssertionError: valid nested-describe reports were BLOCKED instead of PASS, a failed nested describe counted only
// in the counters was invisible, a duplicate hidden behind inflated totals returned the wrong code). GREEN = 228/228
// supplemental, 228 = 171 passed + 57 skipped + 0 failed self-contained. All 15 independent cases matched (no mismatch).
// REAL_VITEST_HAPPY_PATH: NOT RUN.
//
// ===========================================================================
// TOOLING-P0L PREREGISTRATION (written BEFORE the first P0L run).
// Codex P0K finding (MEDIUM): a numeric NON-ZERO Vitest exit became FAIL before the reporter evidence was validated, so
// malformed JSON, a missing report, a duplicate/missing/extra reported file, inconsistent counters, an unknown status or
// contradictory success evidence were reported as a test FAIL. Root cause (documented before editing): in
// runSafeNodbUnguarded the report read/parse/structure/consistency (steps B,C,D,F) only filled a `reportProblem`
// variable, and `if (outcome.code !== 0) return finish('FAIL', ...)` ran BEFORE the exact-file-cardinality check (E) and
// without consulting `reportProblem`, so the process exit decided the verdict ahead of the evidence. A second gap: ANY
// `code !== 0`, including `null` with no signal/timeout, was treated as a test failure.
// Verdict precedence implemented and tested (evidence is validated FIRST, then the outcome is interpreted):
//   operational inability to establish execution (spawn error, timeout, signal, isolation marker missing,
//   no numeric exit status) -> BLOCKED ; unusable reporter evidence (missing/unparsable/malformed/inconsistent/
//   wrong file set) -> BLOCKED, whatever the exit code ; usable evidence + non-zero exit or negative result -> FAIL ;
//   usable evidence + zero exit + complete positive result -> PASS ; pre-spawn input/screen rejection -> DENY.
// Two older tests encoded the rejected behavior and CHANGE expectation (disclosed, not hidden): "a non-zero exit with no
// usable report is FAIL" and [P0B-XN46] "Vitest entry crashes at startup is FAIL" are now BLOCKED REPORTER_MISSING.
//
//  REQUIRED CODEX REGRESSIONS (not independent) - all with a numeric non-zero exit
//   P0L-CX-1 missing report ................................................................ BLOCKED REPORTER_MISSING
//   P0L-CX-2 malformed JSON ................................................................ BLOCKED REPORTER_MALFORMED
//   P0L-CX-3 duplicate report file ......................................................... BLOCKED REPORT_DUPLICATE_FILE
//   P0L-CX-4 requested file missing from the report ......................................... BLOCKED REPORT_FILE_SET_MISMATCH
//   P0L-CX-5 extra reported file ............................................................ BLOCKED REPORT_FILE_SET_MISMATCH
//   P0L-CX-6 structurally inconsistent counters ............................................. BLOCKED REPORTER_INCONSISTENT
//   P0L-CX-7 unknown assertion status ....................................................... BLOCKED REPORTER_INCONSISTENT
//   P0L-CX-8 contradictory success:true with recorded failures .............................. BLOCKED REPORTER_INCONSISTENT
//   P0L-CX-C1 CONTROL valid positive report + non-zero exit ................................ FAIL
//   P0L-CX-C2 CONTROL valid negative report + non-zero exit ................................ FAIL
//
//  INDEPENDENT CASES (new in P0L)
//   P0L-E01 exit 2 + valid positive report ................................................... FAIL (any numeric non-zero exit)
//   P0L-E02 exit 255 + valid negative report (failed test) ................................... FAIL
//   P0L-E03 exit 1 + report that is valid JSON but `null` / an array / a scalar ................ BLOCKED REPORTER_MALFORMED
//   P0L-E04 exit 1 + relative file name in the report ........................................ BLOCKED REPORTER_MALFORMED
//   P0L-E05 exit 1 + impossible suite arithmetic (total != passed+failed+pending) ............... BLOCKED REPORTER_INCONSISTENT
//   P0L-E06 exit 1 + valid nested-describe report (P0J shape), positive AND negative ............ FAIL
//   P0L-E07 numeric exit absent (code null, no signal, no timeout) + valid report ................ BLOCKED NO_EXIT_STATUS
//   P0L-E08 exit status that is not a safe integer ('1', NaN, 1.5) + valid report ................ BLOCKED NO_EXIT_STATUS
//   P0L-E09 exit 0 + missing report (control for the unchanged zero-exit behavior) ............... BLOCKED REPORTER_MISSING
//   P0L-E10 exit 1 + empty (0 byte) report file ................................................ BLOCKED REPORTER_MALFORMED
//   P0L-E11 exit 1 + reporter path is a directory ............................................... BLOCKED REPORTER_MISSING
//   P0L-E12 exit 1 + two requested files, report lists only one (valid for that one) ............ BLOCKED REPORT_FILE_SET_MISMATCH
//   P0L-E13 exit 1 + valid report with success:false but no failed test/suite ................... FAIL
//   P0L-E14 signal (SIGSEGV, no exit code) + valid negative report ............................... BLOCKED KILLED_BY_SIGNAL
//   P0L-E15 timeout + valid positive report ..................................................... BLOCKED TIMEOUT
//   P0L-E16 isolation marker absent + exit 1 + valid report ..................................... BLOCKED ISOLATION_NOT_ESTABLISHED
//   P0L-E17 exit 1 + unknown SUITE status ....................................................... BLOCKED REPORTER_INCONSISTENT
//   P0L-E18 exit 1 + duplicate entry spelled differently ......................................... BLOCKED REPORT_DUPLICATE_FILE
//   P0L-E19 exit 1 + failed file entry not counted among failed suites (P0J lower bound) .......... BLOCKED REPORTER_INCONSISTENT
//   P0L-E20 exit 1 + valid report with zero executed tests (no failures) ........................ FAIL
//
//  MISMATCH RECORDED DURING P0L GREEN (not rewritten): the first P0L-E07/E08 test passed `code: undefined` to the shared
//  fakeRun helper. Its default parameter (`code = 0`) turned that into a genuine exit 0, so the runner correctly returned
//  PASS for a valid report. Classification: EXPECTATION_ERROR (test-fixture default), runner behavior correct. Class:
//  "exit-status values that reach the decision boundary in unusual shapes". Extra cases derived BEFORE correcting E07/E08,
//  expectations fixed before they ran; they use a runner fake that returns the outcome object VERBATIM:
//   P0L-E21 outcome object with no `code` property at all + valid report .......................... BLOCKED NO_EXIT_STATUS
//   P0L-E22 `code` is boolean false / true + valid report ........................................... BLOCKED NO_EXIT_STATUS
//   P0L-E23 `code` is -1 (a safe, negative, non-zero integer) + valid positive report ................ FAIL
//   P0L-E24 `code` is BigInt 0n or a boxed `new Number(0)` + valid report ............................ BLOCKED NO_EXIT_STATUS
//   P0L-E25 `code` is -0 (numerically zero) + valid positive report ................................. PASS
//   P0L-E26 `code` is the string '0' + valid positive report ......................................... BLOCKED NO_EXIT_STATUS
// ===========================================================================
//
// P0L RESULT / PROCESS NOTES (recorded in P0O from what P0L actually observed): RED = 234 tests, 228 passed, 6 failed
// (all AssertionError, 'FAIL' !== 'BLOCKED'); one EXPECTATION_ERROR (E07/E08 passed `code: undefined` into fakeRun, whose
// `code = 0` default made it a real exit 0) -> E21..E26 added; GREEN 235/235 supplemental, 235 = 178 passed + 57 skipped
// + 0 failed self-contained. REAL_VITEST_HAPPY_PATH: NOT RUN at that point.
// P0N RESULT (pre-integration, recorded in P0O): `npm --prefix api ci` installed TypeScript 5.9.3 and Vitest 5.0.0
// locally with no source mutation; GATE A FAILED honestly: 235 total, 178 passed, 0 failed, 57 skipped, ALL 57 with
// "TypeScript unavailable (set TOOLING_TEST_TYPESCRIPT_DIR ...)", because this harness only consulted that variable and
// never tried the repo-local package. Gate B was not run.
//
// ===========================================================================
// TOOLING-P0O PREREGISTRATION (written BEFORE the first P0O run). Scope: TEST HARNESS ONLY (the TypeScript used by the
// AST tests); no runtime/tool policy changes. Resolution policy under test, helper `resolveTestTypescript`:
//   * TOOLING_TEST_TYPESCRIPT_DIR SET (supplemental mode): use ONLY that path. Empty/blank/relative/invalid/wrong version
//     => UNAVAILABLE. NEVER silently fall back to the repo-local package.
//   * UNSET (self-contained Gate-A mode): use ONLY <repo-root>/api/node_modules/typescript, with provenance: api/node_modules
//     and typescript must both resolve (realpath) inside THIS repo (no symlink escape), package.json name "typescript" and
//     version === the exact pin read from api/package.json devDependencies, lib/typescript.js loads and exports
//     transpileModule. Anything else => UNAVAILABLE with a precise reason (skip, never borrow another TypeScript).
//   * NO ambient search: not NODE_PATH, not ancestor/sibling/global node_modules, not other worktrees/projects.
// EXPECTED source values: LOCAL | EXPLICIT_OVERRIDE | UNAVAILABLE.
//   P0O-T01 env unset + valid local 5.9.3 (the Gate-A gap) ................................................ LOCAL
//   P0O-T02 env unset + local package absent ............................................................... UNAVAILABLE
//   P0O-T03 env unset + local present, wrong version (5.8.0 vs pin 5.9.3) ................................ UNAVAILABLE
//   P0O-T04 env unset + local package.json malformed JSON ................................................ UNAVAILABLE
//   P0O-T05 env unset + local package.json missing ....................................................... UNAVAILABLE
//   P0O-T06 env unset + local lib/typescript.js missing .................................................. UNAVAILABLE
//   P0O-T07 env unset + api/node_modules/typescript is a symlink to an external valid 5.9.3 ................ UNAVAILABLE (provenance)
//   P0O-T08 env unset + api/node_modules itself is a symlink to an external dir holding a valid typescript ... UNAVAILABLE
//   P0O-T09 env unset + NODE_PATH (env object AND process.env) points to an external valid TS, local absent .. UNAVAILABLE
//   P0O-T10 env unset + valid TS in root/node_modules and in the parent directory's node_modules, local absent  UNAVAILABLE
//   P0O-T11 env unset + valid local AND external installs (NODE_PATH, ancestor, root) all present ............ LOCAL (the local one)
//   P0O-T12 explicit override valid + valid local also present ............................................ EXPLICIT_OVERRIDE (the override)
//   P0O-T13 explicit override points to a nonexistent dir + valid local present ............................ UNAVAILABLE (no silent fallback)
//   P0O-T14 explicit override has the wrong version + valid local present ................................. UNAVAILABLE
//   P0O-T15 explicit override is "" or whitespace + valid local present ................................... UNAVAILABLE
//   P0O-T16 explicit override is a relative path ........................................................... UNAVAILABLE
//   P0O-T17 explicit override with trailing slash / ".." segments resolving to a valid dir ................. EXPLICIT_OVERRIDE
//   P0O-T18 local lib/typescript.js loads but has no transpileModule ....................................... UNAVAILABLE
//   P0O-T19 local package.json name is not "typescript" (version matches) ................................. UNAVAILABLE
//   P0O-T20 the pin is read from api/package.json: pin 5.10.0 + local 5.10.0 => LOCAL; api/package.json missing, or a
//           range pin (^5.9.3) => UNAVAILABLE (an exact pin cannot be established) ............................. as stated
//   P0O-T21 repo root path containing a space (the real checkout has one) .................................. LOCAL
//   P0O-T22 REAL checkout provenance: env unset + installed local package => LOCAL, real path inside THIS
//           worktree's api/node_modules/typescript, version 5.9.3 (supplemental mode => EXPLICIT_OVERRIDE) ... as stated
// ===========================================================================
//
// P0O RESULT / PROCESS NOTES (recorded in P0Q from what P0O actually observed): RED = 244 tests, 181 passed, 6 failed
// (all AssertionError; the old env-only scaffold still skipped the same 57 tests). GREEN: all 22 resolver cases
// matched. GATE A (env unset): 244 total, 244 passed, 0 failed, 0 skipped, exit 0, TypeScript source=LOCAL
// path=<this worktree>/api/node_modules/typescript version=5.9.3. GATE B (real Vitest 5.0.0 through
// `npm run tooling:nodb`, target api/tests/rbac/scope-backfill-batching.test.ts): PASS, 37 executed / 37 passed, tcpDns
// ENFORCED, runtime sockets MASKED, arbitrary AF_UNIX NOT_GUARANTEED.
//
// ===========================================================================
// TOOLING-P0Q PREREGISTRATION (written BEFORE the first P0Q run).
// Codex P0P: HIGH - ordinary symlink layouts make the harness report LOCAL while TypeScript code is executed from OUTSIDE the
// authorized package/worktree; MEDIUM - metadata and exact-pin provenance are not verified after realpath resolution.
// Root cause (documented before editing): resolveTestTypescript realpath-checked only the package DIRECTORY, then read/loaded
// three artifacts by LEXICAL child path: api/package.json (the exact pin), <pkg>/package.json (version/name) and
// <pkg>/lib/typescript.js (the code that runs). Any symlink in lib/, in the entry, or in either manifest redirected the bytes
// that are trusted/executed without a check. Class: a provenance boundary must apply to EVERY consumed artifact.
// Policy under test: for each artifact (pin file, TS metadata, TS entry) resolve it with realpath FIRST, require the
// canonical target to be inside its authorized boundary using a path-COMPONENT-aware check (so /x/typescript2 is not inside
// /x/typescript), then read/load THAT canonical path. Boundaries: pin file -> <real repo>/api (which must itself be exactly
// <real repo>/api); LOCAL package root -> exactly <real repo>/api/node_modules/typescript; EXPLICIT package root -> the
// canonical selected root (it may live outside the worktree); metadata and entry -> inside the canonical package root.
// The pin file is checked in BOTH modes. Valid INTERNAL symlinks (final target inside the boundary) remain acceptable.
// An invalid explicit override still never falls back to LOCAL.
//
//  REQUIRED CODEX REGRESSIONS (not independent)
//   P0Q-CX01 LOCAL lib/typescript.js is a symlink to a file outside the package ........................ UNAVAILABLE
//   P0Q-CX02 LOCAL lib/ directory is a symlink outside the package ...................................... UNAVAILABLE
//   P0Q-CX03 LOCAL entry -> internal hop -> ends outside (chain) ......................................... UNAVAILABLE
//   P0Q-CX04 LOCAL TypeScript package.json is a symlink outside the package ............................. UNAVAILABLE
//   P0Q-CX05 api/package.json (the pin) is a symlink outside the API boundary ........................... UNAVAILABLE
//   P0Q-CX06 LOCAL entry -> another package under the repo root node_modules ............................. UNAVAILABLE
//   P0Q-CX07 EXPLICIT entry is a symlink outside the selected override package ........................... UNAVAILABLE
//   P0Q-CX08 EXPLICIT package.json is a symlink outside the selected override package .................... UNAVAILABLE
//   P0Q-CX09 CONTROL LOCAL entry symlink whose final target stays inside the TS package .................. LOCAL
//   P0Q-CX10 CONTROL EXPLICIT entry symlink whose final target stays inside the override package ......... EXPLICIT_OVERRIDE
//
//  INDEPENDENT CASES (new in P0Q; layouts not in P0O-T01..T22 or the required list above)
//   P0Q-I01 LOCAL entry -> api/node_modules/typescript2/lib/typescript.js (prefix-like SIBLING of the package) .. UNAVAILABLE
//   P0Q-I02 LOCAL package.json -> a sibling "typescript-extra" directory's package.json ....................... UNAVAILABLE
//   P0Q-I03 api/package.json -> api2/package.json (prefix-like sibling of the API boundary) ................... UNAVAILABLE
//   P0Q-I04 api/package.json -> api/package.real.json (valid INTERNAL pin symlink) ............................ LOCAL
//   P0Q-I05 api/ itself is a symlink to another directory inside the repo ..................................... UNAVAILABLE
//   P0Q-I06 repoRoot passed through a symlinked path, everything real inside the real tree ................... LOCAL
//   P0Q-I07 lib/ is a valid INTERNAL directory symlink (lib -> libReal inside the package) ................... LOCAL
//   P0Q-I08 package.json inside, entry -> another INSTALLED package inside api/node_modules (vitest) ......... UNAVAILABLE
//   P0Q-I09 entry path is a directory named typescript.js ..................................................... UNAVAILABLE
//   P0Q-I10 entry is a dangling symlink; entry is a symlink loop ............................................ UNAVAILABLE
//   P0Q-I11 EXPLICIT root given through a symlink to the real package dir ..................................... EXPLICIT_OVERRIDE (canonical root reported)
//   P0Q-I12 EXPLICIT root via a symlink, with an entry escaping the CANONICAL root ........................... UNAVAILABLE
//   P0Q-I13 EXPLICIT package.json -> prefix-like sibling directory's package.json ............................ UNAVAILABLE
//   P0Q-I14 EXPLICIT valid package but api/package.json (pin) escapes the API boundary ....................... UNAVAILABLE (pin checked in both modes)
//   P0Q-I15 LOCAL package.json is a 2-hop INTERNAL symlink chain ............................................ LOCAL
//   P0Q-I16 repoRoot spelled with ".." segments ................................................................ LOCAL
//   P0Q-I17 lib is a regular file instead of a directory ...................................................... UNAVAILABLE
//   P0Q-I18 the loaded module's own __filename equals the canonical validated entry path ...................... as stated
//   P0Q-I19 invalid explicit override (entry escapes) with a perfectly valid LOCAL package present ........... UNAVAILABLE (no fallback)
// ===========================================================================
// ===========================================================================

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import { createRequire } from 'node:module';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import * as runner from './safe-nodb-run.mjs';

const { runSafeNodb, screenSource, validateTestPathStrings } = runner;
const RUNNER_CLI = fileURLToPath(new URL('./safe-nodb-run.mjs', import.meta.url));
const REAL_REPO_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));

// ---------------------------------------------------------------- test infra

const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

// TypeScript for the AST-screening tests (test-harness provenance; the TOOL never reads TOOLING_TEST_TYPESCRIPT_DIR).
//   * TOOLING_TEST_TYPESCRIPT_DIR SET   -> supplemental mode: ONLY that absolute path. If it is empty, relative, missing,
//                                         the wrong version or otherwise unusable the result is UNAVAILABLE: there is NEVER a
//                                         silent fallback to the repo-local package. It may live outside this worktree.
//   * UNSET                             -> self-contained mode: ONLY <repo-root>/api/node_modules/typescript.
//   * No ambient search of any kind (NODE_PATH, ancestor/sibling/global node_modules, other worktrees or projects).
// PROVENANCE: every file whose bytes or metadata are trusted is resolved with realpath FIRST, its canonical target must
// lie inside that artifact's authorized boundary (a path-COMPONENT-aware test: "/x/typescript2" is not inside "/x/typescript"),
// and only then is that canonical path read/loaded:
//   pin file  api/package.json          -> inside <real repo>/api (and api/ must itself be exactly <real repo>/api)  [both modes]
//   package   LOCAL                     -> exactly <real repo>/api/node_modules/typescript
//             EXPLICIT                  -> the canonical selected root (anywhere)
//   metadata  <pkg>/package.json        -> inside the canonical package root, name "typescript", version === the exact pin
//   entry     <pkg>/lib/typescript.js   -> inside the canonical package root, a regular file, exports transpileModule
// Valid INTERNAL symlinks (final target inside the boundary) are fine; anything resolving outside is UNAVAILABLE and is
// never loaded. Residual (LOW): a concurrent privileged filesystem swap between the check and the load is not defended.
// Returns { ts, source: 'LOCAL' | 'EXPLICIT_OVERRIDE' | 'UNAVAILABLE', path, version, entry, metadata, reason }.
function isInside(child, root) {
  const rel = path.relative(root, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function resolveTestTypescript({ env = process.env, repoRoot = REAL_REPO_ROOT } = {}) {
  const unavailable = (reason) => ({ ts: null, source: 'UNAVAILABLE', path: null, version: null, entry: null, metadata: null, reason });
  const codeOf = (error) => (error && (error.code || error.name)) || 'error';

  // A. the exact pin, from THIS worktree's api/package.json
  let pinned;
  let realRepo;
  try {
    realRepo = realpathSync(repoRoot);
    const apiBoundary = path.join(realRepo, 'api');
    if (realpathSync(path.join(repoRoot, 'api')) !== apiBoundary) return unavailable('api/ does not resolve to <repo>/api (symlink)');
    const realPin = realpathSync(path.join(repoRoot, 'api', 'package.json'));
    if (!isInside(realPin, apiBoundary)) return unavailable('api/package.json resolves outside the API boundary');
    const declared = JSON.parse(readFileSync(realPin, 'utf8')).devDependencies?.typescript;
    if (typeof declared !== 'string' || !/^\d+\.\d+\.\d+$/.test(declared)) return unavailable('api/package.json does not pin typescript to an exact version');
    pinned = declared;
  } catch (error) {
    return unavailable(`the pinned TypeScript version cannot be read from api/package.json (${codeOf(error)})`);
  }

  // B. the selected package root
  const explicit = env.TOOLING_TEST_TYPESCRIPT_DIR;
  const isExplicit = explicit !== undefined;
  const origin = isExplicit ? 'explicit override' : 'repo-local api/node_modules/typescript';
  let realDir;
  try {
    if (isExplicit) {
      if (typeof explicit !== 'string' || explicit.trim() === '' || !path.isAbsolute(explicit)) {
        return unavailable('TOOLING_TEST_TYPESCRIPT_DIR is set but empty or not an absolute path (no fallback to the repo-local package)');
      }
      realDir = realpathSync(path.resolve(explicit));
    } else {
      const boundary = path.join(realRepo, 'api', 'node_modules');
      if (realpathSync(path.join(repoRoot, 'api', 'node_modules')) !== boundary) return unavailable('api/node_modules does not resolve inside this repository (symlink escape)');
      realDir = realpathSync(path.join(repoRoot, 'api', 'node_modules', 'typescript'));
      if (realDir !== path.join(boundary, 'typescript')) return unavailable(`${origin} does not resolve to <repo>/api/node_modules/typescript (symlink escape)`);
    }
  } catch (error) {
    return unavailable(`${origin} cannot be resolved (${codeOf(error)})`);
  }

  // C. metadata and D. entry: resolve FIRST, require them inside the canonical package root, then use the canonical path
  try {
    const realMeta = realpathSync(path.join(realDir, 'package.json'));
    if (!isInside(realMeta, realDir)) return unavailable(`${origin}: package.json resolves outside the selected package`);
    const pkg = JSON.parse(readFileSync(realMeta, 'utf8'));
    if (pkg.name !== 'typescript') return unavailable(`${origin} is not the typescript package`);
    if (pkg.version !== pinned) return unavailable(`${origin} is version ${pkg.version}, the pin is ${pinned}`);

    const realEntry = realpathSync(path.join(realDir, 'lib', 'typescript.js'));
    if (!isInside(realEntry, realDir)) return unavailable(`${origin}: lib/typescript.js resolves outside the selected package`);
    if (!statSync(realEntry).isFile()) return unavailable(`${origin}: lib/typescript.js is not a regular file`);
    const ts = createRequire(realEntry)(realEntry); // the CANONICAL validated file is what runs
    if (typeof ts.transpileModule !== 'function') return unavailable(`${origin} does not export transpileModule`);
    return { ts, source: isExplicit ? 'EXPLICIT_OVERRIDE' : 'LOCAL', path: realDir, version: pkg.version, entry: realEntry, metadata: realMeta, reason: null };
  } catch (error) {
    return unavailable(`${origin} cannot be loaded (${codeOf(error)})`);
  }
}
const RESOLVED_TS = resolveTestTypescript();
const TS = RESOLVED_TS.ts;
const tsTest = (name, fn) => test(name, { skip: TS ? false : `TypeScript unavailable: ${RESOLVED_TS.reason}` }, fn);

function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_')) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.invalid',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
}
const git = (dir, ...args) => execFileSync('git', args, { cwd: dir, env: gitEnv(), encoding: 'utf8' });

function put(root, rel, content) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

const FAKE_VITEST_REL = 'api/node_modules/vitest/vitest.mjs';
const CONFIG_REL = 'api/vitest.nodb.config.mjs';
const A = 'api/tests/rbac/a.test.ts';
const B = 'api/tests/b.test.ts';
const BENIGN = "import { describe, expect, it } from 'vitest';\ndescribe('x', () => { it('y', () => expect(1).toBe(1)); });\n";

function mkFixture({ config = true, vitest = true, extraTracked = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'nodb-fixture-'));
  created.push(root);
  git(root, 'init', '-q', '-b', 'main');
  put(root, A, BENIGN);
  put(root, B, BENIGN);
  if (config) put(root, CONFIG_REL, 'export default {};\n');
  for (const [rel, content] of Object.entries(extraTracked)) put(root, rel, content);
  git(root, 'add', '--', '.');
  git(root, 'commit', '-q', '-m', 'init');
  if (vitest) put(root, FAKE_VITEST_REL, '// fake vitest entry (never executed by fake-run tests)\n');
  return root;
}

const stubScreen = async () => ({ denies: [], warnings: [] });
const absOf = (root, rel) => path.join(root, rel);

function reportFor(root, files, over = {}) {
  const testResults = files.map((rel) => ({
    name: absOf(root, rel),
    status: 'passed',
    assertionResults: [{ status: 'passed', title: 't' }],
  }));
  const n = files.length;
  return {
    numTotalTestSuites: n,
    numPassedTestSuites: n,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: n,
    numPassedTests: n,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults,
    ...over,
  };
}

// Fake process runner: records the call and emulates what the wrapper script does.
function fakeRun({ marker = true, code = 0, signal = null, timedOut = false, spawnError = null, report = undefined } = {}) {
  const calls = [];
  const run = async (call) => {
    calls.push(call);
    if (spawnError) return { code: null, signal: null, timedOut: false, spawnError, stdout: '', stderr: '' };
    if (marker) writeFileSync(call.markerPath, '');
    if (report !== undefined && report !== null) {
      writeFileSync(call.reportPath, typeof report === 'string' ? report : JSON.stringify(report));
    }
    return { code, signal, timedOut, spawnError: null, stdout: '', stderr: '' };
  };
  run.calls = calls;
  return run;
}

async function go(root, paths, deps = {}) {
  return runSafeNodb({ paths, repoRoot: root, deps: { screen: stubScreen, ...deps } });
}

const codes = (r) => r.result.errors.map((e) => e.code);

// ------------------------------------------------------------ input policy

test('[P0A #9] an empty test list is DENY with exit 2 and nothing is spawned', async () => {
  const root = mkFixture();
  const run = fakeRun();
  const { exitCode, result } = await go(root, [], { run });
  assert.equal(result.verdict, 'DENY');
  assert.equal(exitCode, 2);
  assert.ok(codes({ result }).includes('EMPTY_TEST_LIST'));
  assert.equal(run.calls.length, 0);
});

test('[P0A #11][P0A #46][P0A #47][P0A #48][P0B-XN01][P0B-XN02][P0B-XN03][P0B-XN05] invalid path syntax is DENY before any filesystem access', () => {
  const bad = [
    'api/tests/../x.test.ts',
    'api/tests/a/../../../x.test.ts',
    '/etc/hosts',
    '/abs/api/tests/a.test.ts',
    'api/tests/*.test.ts',
    'api/tests/a?.test.ts',
    'api/tests/[ab].test.ts',
    'api/tests/{a,b}.test.ts',
    'api/tests/(a).test.ts',
    'api/tests/!a.test.ts',
    'api/tests/**/a.test.ts',
    'api/src/x.test.ts',
    'scripts/x.test.ts',
    'api/tests',
    'api/tests/',
    'api/tests/a.test.js',
    'api/tests/a.test.ts.bak',
    'api/tests/a.ts',
    'api/testsx/a.test.ts',
    'API/tests/a.test.ts',
    'client/api/tests/a.test.ts',
    './api/tests/a.test.ts',
    'api/./tests/a.test.ts',
    'api/tests//a.test.ts',
    'api/tests/a.test.ts/',
    'api\\tests\\a.test.ts',
    'api/tests/a\\b.test.ts',
    '--help',
    '-x',
    '--config=evil.mjs',
    'api/tests/a\0.test.ts',
    'api/tests/a\n.test.ts',
    'api/tests/a\t.test.ts',
    '',
    '   ',
    ' api/tests/a.test.ts',
  ];
  for (const p of bad) {
    const out = validateTestPathStrings([p]);
    assert.equal(out.ok, false, JSON.stringify(p));
    assert.ok(out.errors.length > 0, JSON.stringify(p));
  }
  for (const p of [42, null, undefined, {}, ['x']]) {
    assert.equal(validateTestPathStrings([p]).ok, false, String(p));
  }
  assert.equal(validateTestPathStrings('api/tests/a.test.ts').ok, false, 'a bare string is not a list');
  assert.equal(validateTestPathStrings(undefined).ok, false);
});

test('valid test paths pass the string policy, are de-duplicated and sorted [P0B-XN04]', () => {
  const out = validateTestPathStrings([B, A, B, 'api/tests/with space/c.test.ts']);
  assert.equal(out.ok, true);
  assert.deepEqual(out.validated, ['api/tests/b.test.ts', 'api/tests/rbac/a.test.ts', 'api/tests/with space/c.test.ts']);
});

test('[P0B-XN04] duplicate test paths run once; requested keeps the caller list, validated is unique', async () => {
  const root = mkFixture();
  const base = fakeRun();
  const run = async (call) => {
    const r = await base(call);
    writeFileSync(call.reportPath, JSON.stringify(reportFor(root, [A])));
    return r;
  };
  run.calls = base.calls;
  const { result } = await go(root, [A, A], { run });
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.testsRequested, [A, A]);
  assert.deepEqual(result.testsValidated, [A]);
  assert.equal(base.calls[0].args.filter((a) => a === absOf(root, A)).length, 1);
});

test('[P0A #41] an untracked regular test file is DENY', async () => {
  const root = mkFixture();
  put(root, 'api/tests/untracked.test.ts', BENIGN);
  const run = fakeRun();
  const { exitCode, result } = await go(root, ['api/tests/untracked.test.ts'], { run });
  assert.equal(result.verdict, 'DENY');
  assert.equal(exitCode, 2);
  assert.ok(codes({ result }).includes('NOT_TRACKED'));
  assert.equal(run.calls.length, 0);
});

test('a staged-new (index-tracked) regular test file is accepted as tracked', async () => {
  const root = mkFixture();
  put(root, 'api/tests/new.test.ts', BENIGN);
  git(root, 'add', '--', 'api/tests/new.test.ts');
  const run = fakeRun({ report: undefined });
  const wrapped = async (call) => {
    const r = await run(call);
    writeFileSync(call.reportPath, JSON.stringify(reportFor(root, ['api/tests/new.test.ts'])));
    return r;
  };
  wrapped.calls = run.calls;
  const { result } = await go(root, ['api/tests/new.test.ts'], { run: wrapped });
  assert.equal(result.verdict, 'PASS');
  assert.deepEqual(result.testsValidated, ['api/tests/new.test.ts']);
});

test('[P0A #8][P0B-XN06] a tracked symlink, FIFO, or deleted file is DENY (not a regular file)', async () => {
  const root = mkFixture();
  unlinkSync(path.join(root, B));
  symlinkSync('rbac/a.test.ts', path.join(root, B));
  const sym = await go(root, [B], { run: fakeRun() });
  assert.equal(sym.result.verdict, 'DENY');
  assert.ok(codes(sym).includes('NOT_REGULAR_FILE'));

  unlinkSync(path.join(root, B));
  execFileSync('mkfifo', [path.join(root, B)]);
  const fifo = await go(root, [B], { run: fakeRun() });
  assert.equal(fifo.result.verdict, 'DENY');
  assert.ok(codes(fifo).includes('NOT_REGULAR_FILE'));

  unlinkSync(path.join(root, B));
  const gone = await go(root, [B], { run: fakeRun() });
  assert.equal(gone.result.verdict, 'DENY');
  assert.ok(codes(gone).includes('NOT_REGULAR_FILE'));
});

test('[P0B-XN07] a path that goes through a symlinked directory is DENY', async () => {
  const root = mkFixture();
  symlinkSync('rbac', path.join(root, 'api/tests/linkdir'));
  const out = await go(root, ['api/tests/linkdir/a.test.ts'], { run: fakeRun() });
  assert.equal(out.result.verdict, 'DENY');
  assert.equal(out.exitCode, 2);
});

// ------------------------------------------------------------- success path

test('[P0A #40][P0A #24][P0A #25][P0B-XN24][P0B-XN29] a valid tracked DB-free test PASSes through unshare, with an explicit config and absolute filters', async () => {
  const root = mkFixture();
  let tmpSeen = null;
  const base = fakeRun();
  const run = async (call) => {
    tmpSeen = path.dirname(call.reportPath);
    const r = await base(call);
    writeFileSync(call.reportPath, JSON.stringify(reportFor(root, [A, B])));
    return r;
  };
  run.calls = base.calls;
  const { exitCode, result } = await go(root, [B, A], { run });
  assert.equal(result.verdict, 'PASS');
  assert.equal(exitCode, 0);
  assert.equal(result.tool, 'safe-nodb-run');
  assert.equal(result.head, git(root, 'rev-parse', 'HEAD').trim(), 'head comes from the computed repo root');
  assert.deepEqual(result.testsValidated, [B, A].sort());
  assert.equal(result.config, CONFIG_REL);
  assert.equal(result.tcpDnsIsolation, 'ENFORCED');
  assert.equal(result.runtimeSocketIsolation, 'MASKED');
  assert.equal(result.arbitraryFilesystemUnixSocketIsolation, 'NOT_GUARANTEED');
  assert.equal(result.processExit.code, 0);
  assert.equal(result.reporterParsed, true);
  assert.equal(result.testsExecuted, 2);
  assert.equal(result.testsPassed, 2);
  assert.equal(result.testsFailed, 0);
  assert.equal(result.testsSkipped, 0);
  assert.equal(result.testsTodo, 0);
  assert.deepEqual(result.errors, []);

  assert.equal(base.calls.length, 1);
  const call = base.calls[0];
  assert.equal(call.command, '/usr/bin/unshare');
  assert.deepEqual(call.args.slice(0, 5), ['-rnm', '--propagation', 'private', '--', '/bin/sh']);
  assert.equal(call.cwd, path.join(root, 'api'));
  const argsJoined = call.args.join(' ');
  assert.ok(!/\bnpx\b/.test(argsJoined) && !/\bnpm\b/.test(argsJoined));
  const iNode = call.args.indexOf(process.execPath);
  assert.ok(iNode > 0, 'runs the current node executable');
  assert.equal(call.args[iNode + 1], path.join(root, FAKE_VITEST_REL));
  assert.equal(call.args[iNode + 2], 'run');
  assert.ok(call.args.includes('--config'));
  assert.equal(call.args[call.args.indexOf('--config') + 1], path.join(root, CONFIG_REL));
  assert.ok(call.args.includes('--reporter=json'));
  assert.ok(call.args.some((a) => a.startsWith('--outputFile=')));
  assert.deepEqual(call.args.slice(-2), [absOf(root, A), absOf(root, B)].sort());
  assert.ok(path.relative(root, tmpSeen).startsWith('..'), 'temp dir is outside the repo');
  assert.equal(existsSync(tmpSeen), false, 'temp dir is removed');
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(tmpSeen), 'temp path is redacted');
  assert.ok(!/\.invalid/.test(serialized) && !serialized.includes('synthetic-test-jwt'), 'no synthetic values in evidence');
  assert.ok(result.command.argv.includes('<report>') || result.command.argv.some((a) => a.includes('<report>')));
  assert.deepEqual(result.command.envNames, result.command.envNames.slice().sort());
});

test('[P0B-XN25] output is deterministic across runs', async () => {
  const root = mkFixture();
  const mk = () => {
    const base = fakeRun();
    const run = async (call) => {
      const r = await base(call);
      writeFileSync(call.reportPath, JSON.stringify(reportFor(root, [A])));
      return r;
    };
    run.calls = base.calls;
    return run;
  };
  const one = await go(root, [A], { run: mk() });
  const two = await go(root, [A], { run: mk() });
  assert.equal(one.result.verdict, 'PASS');
  assert.equal(one.result.testsExecuted, 1);
  assert.equal(JSON.stringify(one.result), JSON.stringify(two.result));
});

// ------------------------------------------------------------ environment

test('[P0A #22] the child env is built explicitly: caller DB URLs and secrets are never forwarded', async () => {
  const root = mkFixture();
  const canary = {
    DATABASE_URL: 'postgresql://canary:dev-secret@dev.example.com:5432/dev',
    TEST_DATABASE_URL: 'postgresql://canary:test-secret@test.example.com:5432/test',
    LOCAL_TEST_DATABASE_URL: 'postgresql://canary:local-secret@127.0.0.1:5432/x',
    JWT_SECRET: 'caller-jwt-secret-canary-0123456789abcdef',
    SUPABASE_KEY: 'canary-supabase-key',
    NODE_OPTIONS: '--require /tmp/evil.js',
  };
  const saved = {};
  for (const [k, v] of Object.entries(canary)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const base = fakeRun();
    const run = async (call) => {
      const r = await base(call);
      writeFileSync(call.reportPath, JSON.stringify(reportFor(root, [A])));
      return r;
    };
    run.calls = base.calls;
    const { result } = await go(root, [A], { run });
    assert.equal(result.verdict, 'PASS');
    assert.equal(base.calls.length, 1, 'the child must actually have been spawned');
    const env = base.calls[0].env;
    assert.deepEqual(Object.keys(env).sort(), [
      'CORS_ORIGINS', 'DATABASE_URL', 'HOME', 'JWT_ACCESS_TTL_SECONDS', 'JWT_SECRET', 'NODE_ENV', 'PATH',
      'PGHOST', 'PGPASSFILE', 'PGPORT', 'PGSERVICEFILE', 'TEST_DATABASE_URL', 'TMPDIR',
    ]);
    assert.equal(env.NODE_ENV, 'test');
    for (const k of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
      assert.match(new URL(env[k]).hostname, /\.invalid$/, k);
    }
    const all = JSON.stringify(env);
    for (const v of Object.values(canary)) assert.ok(!all.includes(v), `leaked ${v.slice(0, 12)}`);
    assert.ok(!JSON.stringify(result).includes('canary'));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('[P0B-XN30] the synthetic env constants equal api/tests/helpers/test-runtime-env.ts', () => {
  const src = readFileSync(path.join(REAL_REPO_ROOT, 'api/tests/helpers/test-runtime-env.ts'), 'utf8').replace(/\s+/g, ' ');
  const { SYNTHETIC_ENV } = runner;
  assert.ok(src.includes(`'${SYNTHETIC_ENV.JWT_SECRET}'`));
  assert.ok(src.includes(`'${SYNTHETIC_ENV.JWT_ACCESS_TTL_SECONDS}'`));
  assert.ok(src.includes(`'${SYNTHETIC_ENV.CORS_ORIGINS}'`));
});

// ------------------------------------------------- BLOCKED / FAIL result contract

test('[P0A #12] a missing generic nodb config is BLOCKED and nothing is spawned', async () => {
  const root = mkFixture({ config: false });
  const run = fakeRun();
  const { exitCode, result } = await go(root, [A], { run });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.ok(codes({ result }).includes('CONFIG_MISSING'));
  assert.equal(run.calls.length, 0);
});

test('[P0A #44] a missing local Vitest entry is BLOCKED (never npx, never a default config)', async () => {
  const root = mkFixture({ vitest: false });
  const run = fakeRun();
  const { exitCode, result } = await go(root, [A], { run });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.ok(codes({ result }).includes('VITEST_MISSING'));
  assert.equal(run.calls.length, 0);
});

test('[P0A #13] unshare unavailable is BLOCKED with no unisolated fallback', async () => {
  const root = mkFixture();
  const run = fakeRun();
  const { exitCode, result } = await go(root, [A], { run, unshareBin: '/nonexistent/unshare' });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.ok(codes({ result }).includes('UNSHARE_MISSING'));
  assert.equal(run.calls.length, 0);
});

test('[P0A #14] a missing ip binary is BLOCKED with no unisolated fallback', async () => {
  const root = mkFixture();
  const run = fakeRun();
  const { exitCode, result } = await go(root, [A], { run, ipCandidates: ['/nonexistent/ip', '/also/missing/ip'] });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.ok(codes({ result }).includes('IP_MISSING'));
  assert.equal(run.calls.length, 0);
});

test('[P0A #14] loopback bring-up failure (sentinel exit 97, no marker) is BLOCKED not FAIL', async () => {
  const root = mkFixture();
  const { exitCode, result } = await go(root, [A], { run: fakeRun({ marker: false, code: 97 }) });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.ok(codes({ result }).includes('LOOPBACK_FAILED'));
  assert.equal(result.tcpDnsIsolation, 'NOT_ESTABLISHED');
  assert.equal(result.runtimeSocketIsolation, 'NOT_ESTABLISHED');
  assert.equal(result.arbitraryFilesystemUnixSocketIsolation, 'NOT_GUARANTEED');
});

test('[P0A #45] unshare exiting non-zero before Vitest is BLOCKED, never FAIL', async () => {
  const root = mkFixture();
  const { exitCode, result } = await go(root, [A], { run: fakeRun({ marker: false, code: 1, report: reportFor(root, [A]) }) });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.ok(codes({ result }).includes('ISOLATION_NOT_ESTABLISHED'));
});

test('[P0B-XN15] exit 0 with a pristine report but no isolation marker is BLOCKED', async () => {
  const root = mkFixture();
  const { result } = await go(root, [A], { run: fakeRun({ marker: false, code: 0, report: reportFor(root, [A]) }) });
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(codes({ result }).includes('ISOLATION_NOT_ESTABLISHED'));
});

test('[P0A #16] a signal or a timeout is BLOCKED', async () => {
  const root = mkFixture();
  const sig = await go(root, [A], { run: fakeRun({ code: null, signal: 'SIGKILL' }) });
  assert.equal(sig.result.verdict, 'BLOCKED');
  assert.ok(codes(sig).includes('KILLED_BY_SIGNAL'));
  const to = await go(root, [A], { run: fakeRun({ code: null, timedOut: true }) });
  assert.equal(to.result.verdict, 'BLOCKED');
  assert.ok(codes(to).includes('TIMEOUT'));
  const spawnFail = await go(root, [A], { run: fakeRun({ spawnError: 'ENOENT' }) });
  assert.equal(spawnFail.result.verdict, 'BLOCKED');
  assert.ok(codes(spawnFail).includes('SPAWN_FAILED'));
});

test('[P0A #17][P0A #43] missing or malformed reporter output (exit 0) is BLOCKED', async () => {
  const root = mkFixture();
  const missing = await go(root, [A], { run: fakeRun({ report: undefined }) });
  assert.equal(missing.result.verdict, 'BLOCKED');
  assert.equal(missing.exitCode, 3);
  assert.ok(codes(missing).includes('REPORTER_MISSING'));
  assert.equal(missing.result.reporterParsed, false);
  for (const bad of ['{not json', '', '[]', 'null', '"x"', '{}', '{"numTotalTests": "3"}', JSON.stringify({ ...reportFor(root, [A]), numFailedTests: -1 })]) {
    const out = await go(root, [A], { run: fakeRun({ report: bad }) });
    assert.equal(out.result.verdict, 'BLOCKED', JSON.stringify(bad));
    assert.ok(codes(out).includes('REPORTER_MALFORMED'), JSON.stringify(bad));
    assert.equal(out.result.reporterParsed, false);
  }
});

test('[P0A #15] a non-zero exit with a failing report is FAIL (exit 1)', async () => {
  const root = mkFixture();
  const failing = reportFor(root, [A], {
    numPassedTests: 0,
    numFailedTests: 1,
    success: false,
    testResults: [{ name: absOf(root, A), status: 'failed', assertionResults: [{ status: 'failed' }] }],
    numFailedTestSuites: 1,
    numPassedTestSuites: 0,
  });
  const { exitCode, result } = await go(root, [A], { run: fakeRun({ code: 1, report: failing }) });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(exitCode, 1);
  assert.equal(result.testsFailed, 1);
  assert.equal(result.processExit.code, 1);
});

test('[P0B-XN14] a non-zero exit is FAIL even if the report claims everything passed', async () => {
  const root = mkFixture();
  const { exitCode, result } = await go(root, [A], { run: fakeRun({ code: 1, report: reportFor(root, [A]) }) });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(exitCode, 1);
});

test('a non-zero exit with no usable report is BLOCKED (never FAIL, never PASS), with reporterParsed false [P0L: was FAIL before Codex P0K]', async () => {
  const root = mkFixture();
  const { exitCode, result } = await go(root, [A], { run: fakeRun({ code: 1, report: undefined }) });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.equal(result.reporterParsed, false);
  assert.ok(result.errors.some((e) => e.code === 'REPORTER_MISSING'));
  assert.equal(result.processExit.code, 1, 'the exit status is still reported as evidence');
});

test('[P0A #42] exit 0 with zero tests in the report is FAIL', async () => {
  const root = mkFixture();
  const empty = reportFor(root, [A], { numTotalTests: 0, numPassedTests: 0, testResults: [{ name: absOf(root, A), status: 'passed', assertionResults: [] }] });
  const { exitCode, result } = await go(root, [A], { run: fakeRun({ report: empty }) });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(exitCode, 1);
  assert.ok(codes({ result }).includes('NO_TESTS_EXECUTED'));
});

test('[P0B-XN13] a run where every test was skipped or todo is FAIL (nothing was executed)', async () => {
  const root = mkFixture();
  const skipped = reportFor(root, [A], {
    numTotalTests: 2,
    numPassedTests: 0,
    numPendingTests: 1,
    numTodoTests: 1,
    numPassedTestSuites: 0,
    numPendingTestSuites: 1,
    testResults: [{ name: absOf(root, A), status: 'skipped', assertionResults: [{ status: 'pending' }, { status: 'todo' }] }],
  });
  const { result } = await go(root, [A], { run: fakeRun({ report: skipped }) });
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.testsSkipped, 1);
  assert.equal(result.testsTodo, 1);
  assert.equal(result.testsExecuted, 0);
});

test('[P0B-XN12] exit 0 but a suite failed to load is FAIL', async () => {
  const root = mkFixture();
  const rep = reportFor(root, [A, B]);
  rep.numFailedTestSuites = 1;
  rep.numPassedTestSuites = 1;
  rep.success = false;
  rep.testResults[1] = { name: absOf(root, B), status: 'failed', assertionResults: [] };
  rep.numTotalTests = 1;
  rep.numPassedTests = 1;
  const { result } = await go(root, [A, B], { run: fakeRun({ report: rep }) });
  assert.equal(result.verdict, 'FAIL');
  assert.ok(codes({ result }).includes('SUITE_FAILED'));
});

test('[P0B-XN08] a report naming a file that was not validated (filter overmatch) is BLOCKED', async () => {
  const root = mkFixture();
  const rep = reportFor(root, [A, B]);
  const { exitCode, result } = await go(root, [A], { run: fakeRun({ report: rep }) });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.ok(codes({ result }).includes('REPORT_FILE_SET_MISMATCH'));
});

test('[P0B-XN09] a report that omits a requested file is BLOCKED', async () => {
  const root = mkFixture();
  const { result } = await go(root, [A, B], { run: fakeRun({ report: reportFor(root, [A]) }) });
  assert.equal(result.verdict, 'BLOCKED');
  assert.ok(codes({ result }).includes('REPORT_FILE_SET_MISMATCH'));
});

test('[P0B-XN10][P0B-XN11] inconsistent report totals or success flag are BLOCKED', async () => {
  const root = mkFixture();
  const totals = await go(root, [A], { run: fakeRun({ report: reportFor(root, [A], { numTotalTests: 5 }) }) });
  assert.equal(totals.result.verdict, 'BLOCKED');
  assert.ok(codes(totals).includes('REPORTER_INCONSISTENT'));
  const failingButSuccess = reportFor(root, [A], {
    numPassedTests: 0,
    numFailedTests: 1,
    success: true,
    testResults: [{ name: absOf(root, A), status: 'failed', assertionResults: [{ status: 'failed' }] }],
  });
  const flag = await go(root, [A], { run: fakeRun({ report: failingButSuccess }) });
  assert.equal(flag.result.verdict, 'BLOCKED');
  assert.ok(codes(flag).includes('REPORTER_INCONSISTENT'));
  const perTest = reportFor(root, [A], {
    testResults: [{ name: absOf(root, A), status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'passed' }] }],
  });
  const mismatch = await go(root, [A], { run: fakeRun({ report: perTest }) });
  assert.equal(mismatch.result.verdict, 'BLOCKED');
  assert.ok(codes(mismatch).includes('REPORTER_INCONSISTENT'));
});

test('[P0A #49] TypeScript that cannot be resolved is BLOCKED, never PASS or FAIL', async () => {
  const root = mkFixture();
  const run = fakeRun();
  const out = await runSafeNodb({
    paths: [A],
    repoRoot: root,
    deps: { run, loadTypescript: async () => { throw new Error('Cannot find module typescript'); } },
  });
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.ok(codes(out).includes('TYPESCRIPT_UNAVAILABLE'));
  assert.equal(run.calls.length, 0);
});

test('the default TypeScript lookup is limited to this repo (api/node_modules, node_modules) and is BLOCKED when absent', async () => {
  const root = mkFixture();
  const run = fakeRun();
  const out = await runSafeNodb({ paths: [A], repoRoot: root, deps: { run } });
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.ok(codes(out).includes('TYPESCRIPT_UNAVAILABLE'));
  assert.equal(run.calls.length, 0);
});

test('[P0B-XN29] across every flow the only executable ever spawned is /usr/bin/unshare', async () => {
  const root = mkFixture();
  const runs = [];
  for (const spec of [{ code: 0 }, { code: 1 }, { marker: false, code: 1 }, { signal: 'SIGTERM', code: null }]) {
    const base = fakeRun(spec);
    const run = async (call) => {
      const r = await base(call);
      if (spec.code === 0) writeFileSync(call.reportPath, JSON.stringify(reportFor(root, [A])));
      return r;
    };
    run.calls = base.calls;
    await go(root, [A], { run });
    runs.push(...base.calls);
  }
  assert.ok(runs.length >= 4);
  for (const c of runs) {
    assert.equal(c.command, '/usr/bin/unshare');
    assert.equal(c.args[0], '-rnm');
  }
});

// ------------------------------------------------------------------- CLI

test('[P0B-XN31] the CLI refuses no args, option-like args and absolute paths with exit 2 and one JSON line', () => {
  for (const args of [[], ['--help'], ['-x'], ['/etc/hosts'], ['api/tests/../x.test.ts'], ['api/tests/*.test.ts']]) {
    const res = spawnSync(process.execPath, [RUNNER_CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(res.status, 2, JSON.stringify(args) + res.stderr);
    const lines = res.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]).verdict, 'DENY');
  }
});

// ----------------------------------------------- AST screening (needs TypeScript)

const screen = (text, file = 'api/tests/rbac/x.test.ts') => screenSource({ ts: TS, text, file });
const dcodes = (r) => r.denies.map((d) => d.code).sort();
const wcodes = (r) => r.warnings.map((d) => d.code).sort();

tsTest('[P0A #28][P0B-XN21] type-only whole-declaration imports are clean, even for denied modules', () => {
  for (const src of [
    "import type { PrismaClient } from '../../src/generated/prisma/client.js';",
    "import type { Pool } from 'pg';",
    "import type * as pg from 'pg';",
    "export type { Pool } from 'pg';",
    "import type { Db } from '../helpers/test-db.js';",
  ]) {
    const r = screen(src);
    assert.deepEqual([dcodes(r), wcodes(r)], [[], []], src);
  }
  assert.deepEqual(dcodes(screen("import { Pool } from 'pg';")), ['DB_DRIVER_IMPORT'], 'positive control: the value form IS denied');
});

tsTest('[P0A #29] database variable names that appear only in comments are clean', () => {
  const r = screen("// DATABASE_URL and TEST_DATABASE_URL\n/* import { Pool } from 'pg'; createTestPrismaClient() */\nconst x = 1;\n");
  assert.deepEqual([dcodes(r), wcodes(r)], [[], []]);
  assert.deepEqual(dcodes(screen('const p = new Pool();')), ['DB_CLIENT_CONSTRUCTION'], 'positive control');
});

tsTest('[P0A #30][P0B-XN20] database variable names in executable source are WARN, not DENY', () => {
  for (const src of [
    "const k = 'TEST_DATABASE_URL';",
    'const k = `prefix_DATABASE_URL_suffix`;',
    'const v = process.env.DATABASE_URL;',
    "const v = process.env['LOCAL_TEST_DATABASE_URL'];",
    'const { DATABASE_URL } = process.env;',
  ]) {
    const r = screen(src);
    assert.deepEqual(dcodes(r), [], src);
    assert.ok(wcodes(r).includes('DB_ENV_NAME_REFERENCE'), src);
  }
});

tsTest('[P0A #31][P0B-XN18] importing src/config/prisma (static, dynamic, aliased) is WARN', () => {
  for (const src of [
    "import { prisma } from '../../src/config/prisma.js';",
    "const m = await import('../../src/config/prisma.js');",
    "import { prisma } from '../../src/config/prisma';",
    "import { prisma } from '@/config/prisma.js';",
    "import { prisma } from '../../src/config/../config/prisma.ts';",
  ]) {
    const r = screen(src);
    assert.deepEqual(dcodes(r), [], src);
    assert.deepEqual(wcodes(r), ['PRISMA_CONFIG_IMPORT'], src);
  }
});

tsTest('[P0A #32][P0B-XN22] the in-memory sales helper import is clean and the real helper source passes the same screen', () => {
  const r = screen("import { createInMemorySalesDb } from '../helpers/in-memory-sales-db.js';");
  assert.deepEqual([dcodes(r), wcodes(r)], [[], []]);
  const real = readFileSync(path.join(REAL_REPO_ROOT, 'api/tests/helpers/in-memory-sales-db.ts'), 'utf8');
  const rr = screen(real, 'api/tests/helpers/in-memory-sales-db.ts');
  assert.deepEqual([dcodes(rr), wcodes(rr)], [[], []]);
  assert.deepEqual(dcodes(screen("import { h } from '../helpers/test-db.js';")), ['DB_HELPER_IMPORT'], 'positive control');
});

tsTest('[P0A #10][P0A #33][P0B-XN18] the DB test helper is DENY under every specifier spelling', () => {
  for (const [file, spec] of [
    ['api/tests/rbac/x.test.ts', '../helpers/test-db.js'],
    ['api/tests/rbac/x.test.ts', '../helpers/test-db'],
    ['api/tests/rbac/x.test.ts', '../helpers/test-db.ts'],
    ['api/tests/rbac/x.test.ts', '../../tests/helpers/test-db.js'],
    ['api/tests/rbac/x.test.ts', '../helpers/../helpers/test-db.js'],
    ['api/tests/x.test.ts', './helpers/test-db.js'],
    ['api/tests/helpers/y.ts', './test-db.js'],
    ['api/tests/rbac/x.test.ts', '../helpers/factories.js'],
    ['api/tests/rbac/x.test.ts', '../helpers/factory-cleanup.js'],
    ['api/tests/rbac/x.test.ts', '../helpers/pool-attribution.js'],
    ['api/tests/rbac/x.test.ts', '../../scripts/demo-database.js'],
  ]) {
    const r = screen(`import { h } from '${spec}';`, file);
    assert.deepEqual(dcodes(r), ['DB_HELPER_IMPORT'], `${file} ${spec}`);
  }
});

tsTest('[P0A #34][P0B-XN19] DB helper identifiers are DENY even without an import', () => {
  for (const src of ['const c = createTestPrismaClient();', 'openSeedDatabase("test");', 'const { createTestPrismaClient: c } = helpers;']) {
    assert.ok(dcodes(screen(src)).includes('DB_HELPER_IDENTIFIER'), src);
  }
});

tsTest('[P0A #35] globalSetup and setup imports are DENY', () => {
  for (const spec of ['../globalSetup.js', '../setup.js', '../../tests/globalSetup']) {
    assert.deepEqual(dcodes(screen(`import s from '${spec}';`)), ['DB_HELPER_IMPORT'], spec);
  }
});

tsTest('[P0A #36][P0B-XN16][P0B-XN17] database drivers are DENY in every import syntax class', () => {
  const sources = [
    "import { Pool } from 'pg';",
    "import pg from 'pg';",
    "import * as pg from 'pg';",
    "import 'pg';",
    "import pg, { type Pool } from 'pg';",
    "import { type Pool } from 'pg';",
    "import { PrismaPg } from '@prisma/adapter-pg';",
    "export { Pool } from 'pg';",
    "export * from 'pg';",
    "import pg = require('pg');",
    "const pg = require('pg');",
    "const pg = await import('pg');",
    "const pg = await import(\n  'pg'\n);",
    'const pg = await import(`pg`);',
    "const pg = await import('pg', { with: {} });",
    "import('node:module'); import('pg-pool');",
  ];
  for (const src of sources) {
    const r = screen(src);
    assert.ok(dcodes(r).includes('DB_DRIVER_IMPORT'), src);
  }
});

tsTest('[P0A #36][P0B-XN19] constructing a database client directly is DENY', () => {
  for (const src of [
    "const p = new Pool({ host: '127.0.0.1' });",
    'const c = new pg.Client({});',
    'const c = new Client();',
    'const prisma = new PrismaClient();',
    'const a = new PrismaPg({ connectionString: x });',
    'const p = new ns.Pool();',
  ]) {
    assert.ok(dcodes(screen(src)).includes('DB_CLIENT_CONSTRUCTION'), src);
  }
});

tsTest('[P0A #37] child_process is DENY in every spelling', () => {
  for (const src of [
    "import { execSync } from 'node:child_process';",
    "import cp from 'child_process';",
    "const cp = await import('node:child_process');",
    "const cp = require('child_process');",
    "export { spawn } from 'node:child_process';",
  ]) {
    assert.ok(dcodes(screen(src)).includes('CHILD_PROCESS_IMPORT'), src);
  }
});

tsTest('[P0A #38][P0B-XN17] non-literal dynamic imports and requires are DENY (cannot be screened)', () => {
  for (const src of [
    'const m = await import(name);',
    'const m = await import(`./x-${y}.js`);',
    "const m = await import('./a' + b);",
    'const m = require(name);',
    'const m = await import();',
    "const r = createRequire(import.meta.url); r('pg');",
  ]) {
    const codesFound = dcodes(screen(src));
    assert.ok(codesFound.includes('NON_LITERAL_IMPORT') || codesFound.includes('INDIRECT_REQUIRE'), src);
  }
});

tsTest('[P0A #39] an unparsable file is DENY', () => {
  for (const src of ['const = ;', 'import { from ;', 'describe("x", () => {']) {
    assert.deepEqual(dcodes(screen(src)), ['UNPARSABLE'], src);
  }
});

tsTest('strings and comments that merely mention imports are not import statements', () => {
  const r = screen("const doc = \"import { Pool } from 'pg'\"; // import('pg')\nvi.mock('pg', () => ({}));\n");
  assert.deepEqual(dcodes(r), []);
  assert.deepEqual(dcodes(screen("import('pg');")), ['DB_DRIVER_IMPORT'], 'positive control');
});

tsTest('findings are reported with line numbers, sorted, and never include secret-looking content', () => {
  const r = screen("import { Pool } from 'pg';\n\nconst x = process.env.DATABASE_URL;\nconst p = new Pool();\n");
  assert.deepEqual(r.denies.map((d) => d.line), [1, 4]);
  assert.deepEqual(r.warnings.map((d) => d.line), [3]);
});

tsTest('[P0A #10] runSafeNodb: a DB-backed test is DENY from the real screen and nothing is spawned', async () => {
  const root = mkFixture({ extraTracked: { 'api/tests/db.test.ts': "import { createTestPrismaClient } from './helpers/test-db.js';\n" } });
  const run = fakeRun();
  const out = await runSafeNodb({ paths: ['api/tests/db.test.ts'], repoRoot: root, deps: { run, loadTypescript: async () => TS } });
  assert.equal(out.result.verdict, 'DENY');
  assert.equal(out.exitCode, 2);
  assert.ok(codes(out).includes('SCREEN_DENY'));
  assert.ok(out.result.errors.some((e) => /DB_HELPER_IMPORT/.test(e.detail)));
  assert.equal(run.calls.length, 0);
});

tsTest('[P0B-XN23] WARN findings do not stop the run and are carried into the evidence', async () => {
  const root = mkFixture({ extraTracked: { 'api/tests/warn.test.ts': "const n = 'TEST_DATABASE_URL';\nexport {};\n" } });
  const base = fakeRun();
  const run = async (call) => {
    const r = await base(call);
    writeFileSync(call.reportPath, JSON.stringify(reportFor(root, ['api/tests/warn.test.ts'])));
    return r;
  };
  run.calls = base.calls;
  const out = await runSafeNodb({ paths: ['api/tests/warn.test.ts'], repoRoot: root, deps: { run, loadTypescript: async () => TS } });
  assert.equal(out.result.verdict, 'PASS');
  assert.ok(Array.isArray(out.result.warnings));
  assert.equal(out.result.warnings.length, 1);
  assert.equal(out.result.warnings[0].code, 'DB_ENV_NAME_REFERENCE');
  assert.equal(out.result.warnings[0].file, 'api/tests/warn.test.ts');
});

// ------------------------------- real /usr/bin/unshare against a fake Vitest

function unshareUsable() {
  const r = spawnSync('/usr/bin/unshare', ['-rnm', '--propagation', 'private', '--', '/bin/sh', '-c', 'exit 0'], { stdio: 'ignore' });
  return r.status === 0;
}
const realNs = (name, fn) => test(name, { skip: unshareUsable() ? false : 'unprivileged user namespaces unavailable' }, fn);

const PROBE_VITEST = `
import { networkInterfaces } from 'node:os';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
const files = args.filter((a) => a.endsWith('.test.ts'));
const ifaces = networkInterfaces();
const names = Object.keys(ifaces).sort();
const loUp = (ifaces.lo ?? []).some((i) => i.address === '127.0.0.1');
const envKeys = Object.keys(process.env).sort().join(',');
// PWD is added by /bin/sh (dash) itself from the cwd; every other name is one the runner set explicitly.
const expectEnv = 'CORS_ORIGINS,DATABASE_URL,HOME,JWT_ACCESS_TTL_SECONDS,JWT_SECRET,NODE_ENV,PATH,PGHOST,PGPASSFILE,PGPORT,PGSERVICEFILE,PWD,TEST_DATABASE_URL,TMPDIR';
const ok =
  names.join(',') === 'lo' && loUp && envKeys === expectEnv &&
  path.basename(process.cwd()) === 'api' && path.basename(process.env.PWD) === 'api' && process.env.NODE_ENV === 'test' &&
  process.env.DATABASE_URL.endsWith('.invalid:5432/postgres') && process.env.PATH === '/usr/bin:/bin' &&
  args[0] === 'run' && args.includes('--config') && args.includes('--reporter=json');
const status = ok ? 'passed' : 'failed';
const rep = {
  numTotalTestSuites: files.length, numPassedTestSuites: ok ? files.length : 0, numFailedTestSuites: ok ? 0 : files.length,
  numPendingTestSuites: 0, numTotalTests: files.length, numPassedTests: ok ? files.length : 0,
  numFailedTests: ok ? 0 : files.length, numPendingTests: 0, numTodoTests: 0, success: ok,
  testResults: files.map((name) => ({ name, status, assertionResults: [{ status }] })),
};
writeFileSync(out, JSON.stringify(rep));
process.exit(ok ? 0 : 1);
`;

realNs('[P0B-XN26] real unshare: the child sees only lo (127.0.0.1 up), the scrubbed env, cwd api/ and the exact Vitest argv', async () => {
  const root = mkFixture();
  put(root, FAKE_VITEST_REL, PROBE_VITEST);
  const out = await runSafeNodb({ paths: [A, B], repoRoot: root, deps: { screen: stubScreen } });
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
  assert.equal(out.exitCode, 0);
  assert.equal(out.result.tcpDnsIsolation, 'ENFORCED');
  assert.equal(out.result.runtimeSocketIsolation, 'MASKED');
  assert.equal(out.result.testsExecuted, 2);
});

realNs('[P0B-XN27] real unshare with a failing ip is BLOCKED (LOOPBACK_FAILED), Vitest never starts', async () => {
  const root = mkFixture();
  put(root, FAKE_VITEST_REL, PROBE_VITEST);
  const out = await runSafeNodb({ paths: [A], repoRoot: root, deps: { screen: stubScreen, ipCandidates: ['/usr/bin/false'] } });
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.ok(codes(out).includes('LOOPBACK_FAILED'));
  assert.equal(out.result.tcpDnsIsolation, 'NOT_ESTABLISHED');
  assert.equal(out.result.runtimeSocketIsolation, 'NOT_ESTABLISHED');
});

realNs('[P0B-XN28] real timeout kills the whole process group and is BLOCKED', async () => {
  const root = mkFixture();
  const pidFile = path.join(root, 'child.pid');
  put(
    root,
    FAKE_VITEST_REL,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 60000);`,
  );
  const started = Date.now();
  const out = await runSafeNodb({ paths: [A], repoRoot: root, deps: { screen: stubScreen, timeoutMs: 1500 } });
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.ok(codes(out).includes('TIMEOUT'));
  assert.ok(Date.now() - started < 20000);
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((r) => setTimeout(r, 300));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the fake Vitest process must be gone');
});

// ------------------------------------------------ TOOLING-P0B1 post-mismatch cases

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return Promise.resolve()
    .then(fn)
    .finally(restore);
}

const observingProbe = (obsPath) => `
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
const files = args.filter((a) => a.endsWith('.test.ts'));
writeFileSync(${JSON.stringify(obsPath)}, JSON.stringify({ env: process.env, cwd: process.cwd(), files }));
const n = files.length;
writeFileSync(out, JSON.stringify({
  numTotalTestSuites: n, numPassedTestSuites: n, numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: n, numPassedTests: n, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true,
  testResults: files.map((name) => ({ name, status: 'passed', assertionResults: [{ status: 'passed' }] })),
}));
`;

// Runs the REAL runner under the REAL /usr/bin/unshare with an observing fake
// Vitest; returns what the child process actually saw.
async function observe({ callerEnv = {}, paths = [A], extraTracked = {} } = {}) {
  const root = mkFixture({ extraTracked });
  const obsPath = path.join(root, 'observed.json');
  put(root, FAKE_VITEST_REL, observingProbe(obsPath));
  const out = await withEnv(callerEnv, () => runSafeNodb({ paths, repoRoot: root, deps: { screen: stubScreen } }));
  const obs = existsSync(obsPath) ? JSON.parse(readFileSync(obsPath, 'utf8')) : null;
  return { root, out, obs };
}

realNs('[P0B-XN32] no caller overrides: the shell-added PWD is exactly <root>/api and equals the child cwd', async () => {
  const { root, out, obs } = await observe();
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
  assert.ok(obs, 'the child must have run');
  assert.equal(obs.env.PWD, path.join(root, 'api'));
  assert.equal(obs.cwd, path.join(root, 'api'));
});

realNs('[P0B-XN33] a caller PWD cannot reach the child, and the runner itself never passes PWD', async () => {
  const { root, out, obs } = await observe({ callerEnv: { PWD: '/etc/evil' } });
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
  assert.ok(obs);
  assert.equal(obs.env.PWD, path.join(root, 'api'));
  assert.ok(!JSON.stringify(obs.env).includes('/etc/evil'));
  // the runner's own explicit env (what it hands to unshare) contains no PWD at all
  const fixture = mkFixture();
  const base = fakeRun();
  const run = async (call) => {
    const r = await base(call);
    writeFileSync(call.reportPath, JSON.stringify(reportFor(fixture, [A])));
    return r;
  };
  run.calls = base.calls;
  await withEnv({ PWD: '/etc/evil' }, () => go(fixture, [A], { run }));
  assert.equal(base.calls.length, 1);
  assert.ok(!('PWD' in base.calls[0].env));
});

realNs('[P0B-XN34] a caller HOME is replaced by the runner\'s fresh temp directory', async () => {
  const canary = '/home/canary-user-do-not-use';
  const { root, out, obs } = await observe({ callerEnv: { HOME: canary } });
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
  assert.ok(obs);
  assert.notEqual(obs.env.HOME, canary);
  assert.match(path.basename(obs.env.HOME), /^mona-nodb-/);
  assert.ok(path.relative(root, obs.env.HOME).startsWith('..'), 'HOME is outside the repository');
});

realNs('[P0B-XN35] a caller TMPDIR is replaced by a fresh mona-nodb-* subdirectory that is also HOME', async () => {
  const callerTmp = mkdtempSync(path.join(tmpdir(), 'caller-tmp-'));
  created.push(callerTmp);
  const { out, obs } = await observe({ callerEnv: { TMPDIR: callerTmp } });
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
  assert.ok(obs);
  assert.notEqual(obs.env.TMPDIR, callerTmp);
  assert.equal(path.dirname(obs.env.TMPDIR), callerTmp);
  assert.match(path.basename(obs.env.TMPDIR), /^mona-nodb-/);
  assert.equal(obs.env.TMPDIR, obs.env.HOME);
});

test('[P0B-XN36] a caller TMPDIR that points inside the repository is BLOCKED (TMPDIR_IN_REPO), nothing spawned', async () => {
  const root = mkFixture();
  const inside = path.join(root, 'inside-tmp');
  mkdirSync(inside);
  const run = fakeRun();
  const out = await withEnv({ TMPDIR: inside }, () => go(root, [A], { run }));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.ok(codes(out).includes('TMPDIR_IN_REPO'));
  assert.equal(run.calls.length, 0);
  assert.deepEqual(readdirSync(inside), [], 'the rejected temp directory must be cleaned up');
});

test('[P0B-XN37] a caller TMPDIR that does not exist is BLOCKED, never a thrown crash (exit 1 would read as FAIL)', async () => {
  const root = mkFixture();
  const run = fakeRun();
  let out;
  await assert.doesNotReject(async () => {
    out = await withEnv({ TMPDIR: '/nonexistent-caller-tmpdir-for-p0b1' }, () => go(root, [A], { run }));
  });
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.equal(run.calls.length, 0);
  assert.ok(out.result.errors.length > 0);
});

realNs('[P0B-XN38] caller NODE_ENV/JWT/CORS/DB/PATH/ENV/BASH_ENV/NODE_OPTIONS/LD_PRELOAD cannot override or reach the child', async () => {
  const callerEnv = {
    NODE_ENV: 'production',
    JWT_SECRET: 'caller-jwt-canary-0123456789abcdef0123',
    JWT_ACCESS_TTL_SECONDS: '1',
    CORS_ORIGINS: 'https://evil.example.com',
    DATABASE_URL: 'postgresql://canary:x@dev.example.com/db',
    TEST_DATABASE_URL: 'postgresql://canary:x@test.example.com/db',
    PATH: '/evil/bin:/usr/bin',
    ENV: '/tmp/evil-env.sh',
    BASH_ENV: '/tmp/evil-bash-env.sh',
    NODE_OPTIONS: '--require /tmp/evil.js',
    LD_PRELOAD: '/tmp/evil.so',
  };
  const { out, obs } = await observe({ callerEnv });
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
  assert.ok(obs);
  const { SYNTHETIC_ENV } = runner;
  assert.equal(obs.env.NODE_ENV, 'test');
  assert.equal(obs.env.PATH, '/usr/bin:/bin');
  for (const [k, v] of Object.entries(SYNTHETIC_ENV)) assert.equal(obs.env[k], v, k);
  for (const k of ['ENV', 'BASH_ENV', 'NODE_OPTIONS', 'LD_PRELOAD']) assert.ok(!(k in obs.env), k);
  const all = JSON.stringify(obs.env);
  for (const v of Object.values(callerEnv)) if (v.length >= 8) assert.ok(!all.includes(v), `leaked ${v}`);
  assert.deepEqual(Object.keys(obs.env).sort(), [
    'CORS_ORIGINS', 'DATABASE_URL', 'HOME', 'JWT_ACCESS_TTL_SECONDS', 'JWT_SECRET', 'NODE_ENV', 'PATH',
    'PGHOST', 'PGPASSFILE', 'PGPORT', 'PGSERVICEFILE', 'PWD', 'TEST_DATABASE_URL', 'TMPDIR',
  ]);
});

realNs('[P0B-XN39] a test path with shell metacharacters reaches Vitest as exactly one argv entry and nothing is executed', async () => {
  const odd = "api/tests/x;touch pwned;$HOME'y&z.test.ts";
  const { root, out, obs } = await observe({ paths: [odd], extraTracked: { [odd]: BENIGN } });
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
  assert.ok(obs);
  assert.deepEqual(obs.files, [path.join(root, odd)]);
  assert.equal(existsSync(path.join(root, 'api', 'pwned')), false);
  assert.equal(existsSync(path.join(root, 'pwned')), false);
});

// ------------------------------- TOOLING-P0B1 second batch (operational exceptions)

const notRoot = process.getuid && process.getuid() !== 0 ? false : 'running as root: permission bits are not enforced';
const noCrash = async (fn) => {
  let out;
  await assert.doesNotReject(async () => {
    out = await fn();
  });
  return out;
};

test('[P0B-XN40] a caller TMPDIR that is a regular file is BLOCKED, not a crash', async () => {
  const root = mkFixture();
  const file = path.join(root, '..', `tmpdir-is-a-file-${path.basename(root)}`);
  writeFileSync(file, 'x');
  created.push(file);
  const run = fakeRun();
  const out = await noCrash(() => withEnv({ TMPDIR: file }, () => go(root, [A], { run })));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.equal(run.calls.length, 0);
});

test('[P0B-XN41] a caller TMPDIR that is read-only is BLOCKED, not a crash', { skip: notRoot }, async () => {
  const root = mkFixture();
  const ro = mkdtempSync(path.join(tmpdir(), 'ro-tmp-'));
  created.push(ro);
  chmodSync(ro, 0o500);
  try {
    const run = fakeRun();
    const out = await noCrash(() => withEnv({ TMPDIR: ro }, () => go(root, [A], { run })));
    assert.equal(out.result.verdict, 'BLOCKED');
    assert.equal(out.exitCode, 3);
    assert.equal(run.calls.length, 0);
  } finally {
    chmodSync(ro, 0o700);
  }
});

test('[P0B-XN42] a repo root that does not exist is BLOCKED, not a crash', async () => {
  const run = fakeRun();
  const out = await noCrash(() => runSafeNodb({ paths: [A], repoRoot: '/nonexistent-root-for-p0b1', deps: { screen: stubScreen, run } }));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.equal(run.calls.length, 0);
});

tsTest('[P0B-XN43] a test file that cannot be read during the AST screen is BLOCKED, not a crash', async () => {
  if (notRoot) return;
  const root = mkFixture();
  chmodSync(path.join(root, A), 0o000);
  try {
    const run = fakeRun();
    const out = await noCrash(() => runSafeNodb({ paths: [A], repoRoot: root, deps: { run, loadTypescript: async () => TS } }));
    assert.equal(out.result.verdict, 'BLOCKED');
    assert.equal(out.exitCode, 3);
    assert.equal(run.calls.length, 0);
  } finally {
    chmodSync(path.join(root, A), 0o600);
  }
});

test('[P0B-XN44] an unexpected rejection from the process runner is BLOCKED, not a crash', async () => {
  const root = mkFixture();
  const run = async () => {
    throw new Error('boom: spawn layer failed');
  };
  const out = await noCrash(() => go(root, [A], { run }));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.ok(out.result.errors.length > 0);
  assert.ok(!JSON.stringify(out.result).includes(root), 'no local path in the evidence');
});

test('[P0B-XN45] exit 0 with a reporter file that exists but cannot be read is BLOCKED', { skip: notRoot }, async () => {
  const root = mkFixture();
  const base = fakeRun();
  const run = async (call) => {
    const r = await base(call);
    writeFileSync(call.reportPath, JSON.stringify(reportFor(root, [A])));
    chmodSync(call.reportPath, 0o000);
    return r;
  };
  run.calls = base.calls;
  const out = await noCrash(() => go(root, [A], { run }));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.equal(out.result.reporterParsed, false);
});

realNs('[P0B-XN46] a Vitest entry that crashes at startup (after isolation) is BLOCKED REPORTER_MISSING with reporterParsed=false [P0L: was FAIL before Codex P0K]', async () => {
  const root = mkFixture();
  put(root, FAKE_VITEST_REL, 'this is not javascript (\n');
  const out = await runSafeNodb({ paths: [A], repoRoot: root, deps: { screen: stubScreen } });
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.equal(out.result.tcpDnsIsolation, 'ENFORCED');
  assert.equal(out.result.reporterParsed, false);
  assert.ok(codes(out).includes('REPORTER_MISSING'));
  assert.equal(out.result.processExit.code, 1);
});

// ------------------------------------------------ TOOLING-P0B1 third batch

test('[P0B-XN47] a paths array whose element access throws still ends in BLOCKED, not a crash', async () => {
  const root = mkFixture();
  const hostile = new Proxy([A], {
    get(target, prop, receiver) {
      if (prop === 'map' || prop === 'length' || prop === '0' || prop === Symbol.iterator) throw new Error('hostile getter');
      return Reflect.get(target, prop, receiver);
    },
  });
  const run = fakeRun();
  const out = await noCrash(() => runSafeNodb({ paths: hostile, repoRoot: root, deps: { screen: stubScreen, run } }));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.equal(run.calls.length, 0);
});

test('[P0B-XN48] a screening collaborator that returns undefined is BLOCKED, not a crash', async () => {
  const root = mkFixture();
  const run = fakeRun();
  const out = await noCrash(() => runSafeNodb({ paths: [A], repoRoot: root, deps: { screen: async () => undefined, run } }));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.equal(run.calls.length, 0);
});

test('[P0B-XN49] a process runner that returns undefined is BLOCKED, not a crash', async () => {
  const root = mkFixture();
  const out = await noCrash(() => go(root, [A], { run: async () => undefined }));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
});

test('[P0B-XN50] exit 0 together with a signal is contradictory evidence: BLOCKED, never PASS', async () => {
  const root = mkFixture();
  const { exitCode, result } = await go(root, [A], { run: fakeRun({ code: 0, signal: 'SIGTERM', report: reportFor(root, [A]) }) });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.ok(codes({ result }).includes('KILLED_BY_SIGNAL'));
});

test('[P0B-XN51] a reporter path that is a directory (EISDIR) is BLOCKED with reporterParsed=false', async () => {
  const root = mkFixture();
  const base = fakeRun();
  const run = async (call) => {
    const r = await base(call);
    mkdirSync(call.reportPath);
    return r;
  };
  run.calls = base.calls;
  const { exitCode, result } = await go(root, [A], { run });
  assert.equal(result.verdict, 'BLOCKED');
  assert.equal(exitCode, 3);
  assert.equal(result.reporterParsed, false);
});

// ------------------------------------------------ TOOLING-P0B1 fourth batch

test('[P0B-XN52] a deps object whose property access throws is BLOCKED, not a crash', async () => {
  const root = mkFixture();
  const hostileDeps = new Proxy({}, { get() { throw new Error('hostile deps'); } });
  const out = await noCrash(() => runSafeNodb({ paths: [A], repoRoot: root, deps: hostileDeps }));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
});

test('[P0B-XN53] a paths element whose toString() throws is DENY (not a string), not a crash', async () => {
  const root = mkFixture();
  const evil = { toString() { throw new Error('hostile toString'); } };
  const out = await noCrash(() => go(root, [evil], { run: fakeRun() }));
  assert.equal(out.result.verdict, 'DENY');
  assert.equal(out.exitCode, 2);
  assert.ok(codes(out).includes('NOT_A_STRING'));
});

test('[P0B-XN54] a Symbol in paths is DENY (not a string), not a crash', async () => {
  const root = mkFixture();
  const out = await noCrash(() => go(root, [Symbol('x')], { run: fakeRun() }));
  assert.equal(out.result.verdict, 'DENY');
  assert.equal(out.exitCode, 2);
  assert.ok(codes(out).includes('NOT_A_STRING'));
});

test('[P0B-XN55] a non-string repoRoot is BLOCKED, not a crash', async () => {
  const out = await noCrash(() => runSafeNodb({ paths: [A], repoRoot: 42, deps: { screen: stubScreen, run: fakeRun() } }));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
});

test('[P0B-XN56] runSafeNodb(null) is BLOCKED, not a crash', async () => {
  const out = await noCrash(() => runSafeNodb(null));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
});

test('[P0B-XN57] a sparse paths array (holes) is DENY (not a string), not a crash', async () => {
  const root = mkFixture();
  const out = await noCrash(() => go(root, new Array(2), { run: fakeRun() }));
  assert.equal(out.result.verdict, 'DENY');
  assert.equal(out.exitCode, 2);
  assert.ok(codes(out).includes('NOT_A_STRING'));
});

// ------------------------------------------------ TOOLING-P0B1 fifth batch

test('[P0B-XN58] a paths element with a throwing Symbol.toPrimitive is DENY, not a crash', async () => {
  const root = mkFixture();
  const evil = { [Symbol.toPrimitive]() { throw new Error('hostile toPrimitive'); } };
  const out = await noCrash(() => go(root, [evil], { run: fakeRun() }));
  assert.equal(out.result.verdict, 'DENY');
  assert.equal(out.exitCode, 2);
  assert.ok(codes(out).includes('NOT_A_STRING'));
});

test('[P0B-XN59] a 1 MB invalid path is DENY and no evidence string grows beyond a small bound', async () => {
  const root = mkFixture();
  const huge = `api/tests/${'a'.repeat(1_000_000)}*.test.ts`;
  const out = await noCrash(() => go(root, [huge], { run: fakeRun() }));
  assert.equal(out.result.verdict, 'DENY');
  assert.equal(out.exitCode, 2);
  const longest = (value) => {
    if (typeof value === 'string') return value.length;
    if (Array.isArray(value)) return Math.max(0, ...value.map(longest));
    if (value && typeof value === 'object') return Math.max(0, ...Object.values(value).map(longest));
    return 0;
  };
  assert.ok(longest(out.result) <= 600, `longest evidence string: ${longest(out.result)}`);
});

test('[P0B-XN60] a lone-surrogate path is DENY, not a crash', async () => {
  const root = mkFixture();
  const out = await noCrash(() => go(root, ['api/tests/\ud800.test.ts'], { run: fakeRun() }));
  assert.equal(out.result.verdict, 'DENY');
  assert.equal(out.exitCode, 2);
});

test('[P0B-XN61] a BigInt element is DENY (not a string), not a crash', async () => {
  const root = mkFixture();
  const out = await noCrash(() => go(root, [10n], { run: fakeRun() }));
  assert.equal(out.result.verdict, 'DENY');
  assert.ok(codes(out).includes('NOT_A_STRING'));
});

test('[P0B-XN62] a null-prototype object element is DENY (not a string), not a crash', async () => {
  const root = mkFixture();
  const out = await noCrash(() => go(root, [Object.create(null)], { run: fakeRun() }));
  assert.equal(out.result.verdict, 'DENY');
  assert.ok(codes(out).includes('NOT_A_STRING'));
});

// ======================================================= TOOLING-P0D tests

const passRun = (root, rels) => {
  const base = fakeRun();
  const run = async (call) => {
    const r = await base(call);
    writeFileSync(call.reportPath, JSON.stringify(reportFor(root, rels)));
    return r;
  };
  run.calls = base.calls;
  return run;
};
const closureGo = (root, rels, deps = {}) =>
  runSafeNodb({ paths: rels, repoRoot: root, deps: { loadTypescript: async () => TS, run: passRun(root, [...new Set(rels)].sort()), ...deps } });
const detail = (out) => out.result.errors.map((e) => e.detail).join('\n');

// ---- Y01-Y19: AST screening classes

tsTest('[P0D-Y01] an aliased loader receiver (`const v = vi; v.importActual(...)`) is classified like an import', () => {
  assert.ok(dcodes(screen("const v = vi;\nawait v.importActual('pg');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("await vi.doImportActual('pg');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("await vi['importActual']('node:child_process');")).includes('CHILD_PROCESS_IMPORT'));
});

tsTest('[P0D-Y02] a destructured or renamed loader is DENY INDIRECT_LOADER', () => {
  assert.ok(dcodes(screen("const { importActual: load } = vi;\nawait load('node:child_process');")).includes('INDIRECT_LOADER'));
  assert.ok(dcodes(screen('const f = vi.importActual;\nawait f(name);')).includes('INDIRECT_LOADER'));
});

tsTest('[P0D-Y03][P0D-Y04] fragment suffixes and percent-encoding do not hide a DB helper', () => {
  for (const spec of ['../helpers/test-db.js#section', '../helpers/test-db.js?x=1#y', '../helpers/test%2Ddb.js', '../helpers/test%2ddb']) {
    assert.deepEqual(dcodes(screen(`import '${spec}';`)), ['DB_HELPER_IMPORT'], spec);
  }
  for (const spec of ['pg#frag', 'pg?x=1', 'node:child_process?x', '@prisma/adapter-pg?raw']) {
    assert.equal(dcodes(screen(`import '${spec}';`)).length, 1, spec);
  }
});

tsTest('[P0D-Y05] URL-scheme, absolute and "#" subpath specifiers are DENY UNANALYZABLE_SPECIFIER', () => {
  for (const spec of ['file:///abs/thing.js', 'data:text/javascript,export{}', 'https://example.com/x.js', '/abs/thing.js', '#internal/thing']) {
    assert.deepEqual(dcodes(screen(`import x from '${spec}';`)), ['UNANALYZABLE_SPECIFIER'], spec);
  }
});

tsTest('[P0D-Y06][P0D-Y19][P0D-Y07] node:net is allowed only for pure bindings', () => {
  const clean = screen("import { isIP, isIPv4 } from 'node:net';");
  assert.deepEqual([dcodes(clean), wcodes(clean)], [[], []]);
  for (const src of [
    "import { isIP, connect } from 'node:net';",
    "import * as n from 'node:net?x=1';",
    "import net from 'net';",
    "import 'node:net';",
    "const n = await import('node:net');",
    "const n = require('net');",
    "import tls from 'node:tls';",
    "export { connect } from 'node:net';",
  ]) {
    assert.ok(dcodes(screen(src)).includes('SOCKET_PRIMITIVE_IMPORT'), src);
  }
});

tsTest('[P0D-Y08][P0D-Y09] socketPath is DENY, a unix-socket-looking literal is WARN only', () => {
  assert.ok(dcodes(screen("http.request({ socketPath: '/var/run/docker.sock' });")).includes('SOCKET_PATH_USE'));
  assert.ok(dcodes(screen("const o = { 'socketPath': p };")).includes('SOCKET_PATH_USE'));
  assert.ok(dcodes(screen("const k = 'socketPath'; agent[k] = 1;")).includes('SOCKET_PATH_USE'));
  const lit = screen("const p = '/run/postgresql/.s.PGSQL.5432';");
  assert.deepEqual(dcodes(lit), []);
  assert.ok(wcodes(lit).includes('UNIX_SOCKET_PATH_LITERAL'));
  assert.ok(wcodes(screen("const u = 'unix:///tmp/x';")).includes('UNIX_SOCKET_PATH_LITERAL'));
  const plain = screen("const n = 'socket.io-client';");
  assert.deepEqual(dcodes(plain), []);
});

tsTest('[P0D-Y10][P0D-Y11][P0D-Y12] dynamic code generation is DENY by syntax class', () => {
  for (const src of [
    "(0, eval)('1');",
    "globalThis.eval('1');",
    "const f = new Function('return 1');",
    "Function('return 1')();",
    "globalThis.Function('x');",
    "[].constructor.constructor('return process')();",
    "setTimeout('boom()', 0);",
    "setInterval(`x()`, 1);",
  ]) {
    assert.ok(dcodes(screen(src)).includes('DYNAMIC_CODE'), src);
  }
  const typeOnly = screen('type Cb = Function;\nconst f: Function = () => 1;\nsetTimeout(() => 1, 0);\nsetTimeout(handler, 0);');
  assert.deepEqual(dcodes(typeOnly), [], 'type positions and function timers are not dynamic code');
});

tsTest('[P0D-Y13][P0D-Y14] vm and node:module imports and aliased createRequire are DENY', () => {
  assert.ok(dcodes(screen("import vm from 'node:vm';")).includes('DYNAMIC_CODE_IMPORT'));
  assert.ok(dcodes(screen("const vm = require('vm');")).includes('DYNAMIC_CODE_IMPORT'));
  const r = screen("import { createRequire as mk } from 'node:module';\nmk(import.meta.url)('pg');");
  assert.ok(dcodes(r).includes('INDIRECT_REQUIRE'));
  assert.ok(dcodes(r).includes('LOADER_MODULE_IMPORT'));
  assert.ok(dcodes(screen("const m = await import('node:module'); m.default.createRequire(x);")).includes('INDIRECT_REQUIRE'));
  assert.ok(dcodes(screen("const k = 'createRequire'; mod[k](x);")).includes('INDIRECT_REQUIRE'));
});

tsTest('[P0D-Y15] a non-call reference to require is DENY INDIRECT_REQUIRE; a plain call keeps its normal classification', () => {
  assert.ok(dcodes(screen("const r = require;\nr('pg');")).includes('INDIRECT_REQUIRE'));
  assert.ok(dcodes(screen("const f = { load: require };")).includes('INDIRECT_REQUIRE'));
  assert.deepEqual(dcodes(screen("const x = require('./safe-local.js');")), []);
  assert.deepEqual(dcodes(screen('const o = { require: 1 }; o.require = 2;')), []);
});

tsTest('[P0D-Y16][P0D-Y17] a vi.mock factory that can load the original is classified; a self-contained mock is clean', () => {
  assert.ok(dcodes(screen("vi.mock('pg', async (orig) => ({ ...(await orig()) }));")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("vi.doMock('../helpers/test-db.js', async (importOriginal) => importOriginal());")).includes('DB_HELPER_IMPORT'));
  const clean = screen("vi.mock('pg', () => ({ Pool: class {} }));");
  assert.deepEqual([dcodes(clean), wcodes(clean)], [[], []]);
});

tsTest('[P0D-Y18] import.meta.glob (file set unknowable) is DENY NON_LITERAL_IMPORT', () => {
  assert.ok(dcodes(screen("const m = import.meta.glob('./*.ts');")).includes('NON_LITERAL_IMPORT'));
  assert.ok(dcodes(screen("const m = import.meta.globEager('./*.ts');")).includes('NON_LITERAL_IMPORT'));
});

// ---- Y20-Y32: bounded transitive closure

tsTest('[P0D-Y20] a DB driver three levels down a local import chain is DENY and the offending file is named', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/y20.test.ts': "import { h } from './helpers/y20-h1.js';\nexport { h };\n",
      'api/tests/helpers/y20-h1.ts': "import { g } from '../../src/y20-h2.js';\nexport const h = g;\n",
      'api/src/y20-h2.ts': "import { Pool } from 'pg';\nexport const g = Pool;\n",
    },
  });
  const out = await closureGo(root, ['api/tests/y20.test.ts']);
  assert.equal(out.result.verdict, 'DENY');
  assert.equal(out.exitCode, 2);
  assert.match(detail(out), /api\/src\/y20-h2\.ts:1 DB_DRIVER_IMPORT/);
});

tsTest('[P0D-Y21][P0D-Y31] import cycles terminate and non-code local imports are leaves', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/y21.test.ts': "import { b } from './helpers/y21b.js';\nimport data from './data.json';\nexport const a = b + data;\n",
      'api/tests/helpers/y21b.ts': "import { a } from '../y21.test.js';\nexport const b = a;\n",
      'api/tests/data.json': '{}\n',
    },
  });
  const out = await closureGo(root, ['api/tests/y21.test.ts']);
  assert.equal(out.result.verdict, 'PASS', detail(out));
});

tsTest('[P0D-Y22][P0D-Y29] an unresolvable or repository-escaping local import fails closed', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/y22.test.ts': "import './nope.js';\n",
      'api/tests/y29.test.ts': "import '../../../outside/x.js';\n",
    },
  });
  const a = await closureGo(root, ['api/tests/y22.test.ts']);
  assert.equal(a.result.verdict, 'DENY');
  assert.match(detail(a), /UNRESOLVED_LOCAL_IMPORT/);
  const b = await closureGo(root, ['api/tests/y29.test.ts']);
  assert.equal(b.result.verdict, 'DENY');
  assert.match(detail(b), /UNRESOLVED_LOCAL_IMPORT/);
});

tsTest('[P0D-Y23][P0D-Y24] directory-index and .js-to-.ts resolution reach the hidden primitive', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/y23.test.ts': "import './helpers/lib';\n",
      'api/tests/helpers/lib/index.ts': "import tls from 'node:tls';\nexport default tls;\n",
      'api/tests/y24.test.ts': "import './helpers/y24.js';\n",
      'api/tests/helpers/y24.ts': "import { execSync } from 'node:child_process';\nexport const x = execSync;\n",
    },
  });
  const a = await closureGo(root, ['api/tests/y23.test.ts']);
  assert.equal(a.result.verdict, 'DENY');
  assert.match(detail(a), /api\/tests\/helpers\/lib\/index\.ts:1 SOCKET_PRIMITIVE_IMPORT/);
  const b = await closureGo(root, ['api/tests/y24.test.ts']);
  assert.equal(b.result.verdict, 'DENY');
  assert.match(detail(b), /api\/tests\/helpers\/y24\.ts:1 CHILD_PROCESS_IMPORT/);
});

tsTest('[P0D-Y25][P0D-Y26] generated output and node_modules are leaves and are never traversed', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/y25.test.ts': "import type { X } from '../src/generated/prisma/client.js';\nimport { y } from '../src/generated/prisma/client.js';\nexport { y };\n",
      'api/tests/y26.test.ts': "import lp from 'left-pad';\nexport { lp };\n",
    },
  });
  put(root, 'api/node_modules/left-pad/index.js', "import 'pg';\n");
  const a = await closureGo(root, ['api/tests/y25.test.ts']);
  assert.equal(a.result.verdict, 'PASS', detail(a));
  const b = await closureGo(root, ['api/tests/y26.test.ts']);
  assert.equal(b.result.verdict, 'PASS', detail(b));
});

tsTest('[P0D-Y27] a closure larger than the bound is DENY CLOSURE_TOO_LARGE', async () => {
  const files = {};
  for (let i = 0; i < 5; i += 1) files[`api/tests/helpers/y27-${i}.ts`] = i < 4 ? `import './y27-${i + 1}.js';\n` : 'export {};\n';
  files['api/tests/y27.test.ts'] = "import './helpers/y27-0.js';\n";
  const root = mkFixture({ extraTracked: files });
  const out = await closureGo(root, ['api/tests/y27.test.ts'], { maxScreenFiles: 3 });
  assert.equal(out.result.verdict, 'DENY');
  assert.match(detail(out), /CLOSURE_TOO_LARGE/);
});

tsTest('[P0D-Y28] a local import that is a symlink is DENY', async () => {
  const root = mkFixture({
    extraTracked: { 'api/tests/y28.test.ts': "import './helpers/y28.js';\n", 'api/tests/helpers/y28real.ts': 'export {};\n' },
  });
  symlinkSync('y28real.ts', path.join(root, 'api/tests/helpers/y28.ts'));
  const out = await closureGo(root, ['api/tests/y28.test.ts']);
  assert.equal(out.result.verdict, 'DENY');
  assert.match(detail(out), /UNRESOLVED_LOCAL_IMPORT/);
});

tsTest('[P0D-Y30] reaching api/src/config/prisma is a WARN boundary: not traversed, not DENY', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/y30.test.ts': "import { r } from './helpers/y30h.js';\nexport { r };\n",
      'api/tests/helpers/y30h.ts': "import { prisma } from '../../src/config/prisma.js';\nexport const r = prisma;\n",
      'api/src/config/prisma.ts': "import pg from 'pg';\nimport { PrismaPg } from '@prisma/adapter-pg';\nexport const prisma = new pg.Pool();\nexport const a = PrismaPg;\n",
    },
  });
  const out = await closureGo(root, ['api/tests/y30.test.ts']);
  assert.equal(out.result.verdict, 'PASS', detail(out));
  assert.ok(out.result.warnings.some((w) => w.code === 'PRISMA_CONFIG_IMPORT' && w.file === 'api/tests/helpers/y30h.ts'));
});

tsTest('[P0D-Y32] socketPath in a helper two levels down is DENY SOCKET_PATH_USE', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/y32.test.ts': "import './helpers/y32a.js';\n",
      'api/tests/helpers/y32a.ts': "import './y32b.js';\n",
      'api/tests/helpers/y32b.ts': "export const o = { socketPath: '/tmp/x.sock' };\n",
    },
  });
  const out = await closureGo(root, ['api/tests/y32.test.ts']);
  assert.equal(out.result.verdict, 'DENY');
  assert.match(detail(out), /api\/tests\/helpers\/y32b\.ts:1 SOCKET_PATH_USE/);
});

// ---- Y33-Y45: layered socket containment

const RUN_USER_DIR = `/run/user/${process.getuid()}`;
const runUserWritable = (() => {
  try {
    accessSync(RUN_USER_DIR, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
})();
const nsSkip = () => (unshareUsable() ? false : 'NOT EXECUTABLE: unprivileged user+mount namespaces unavailable');
const realRun = (name, fn) => test(name, { skip: nsSkip() }, fn);
const realRunUserSock = (name, fn) =>
  test(name, { skip: nsSkip() || (runUserWritable ? false : `NOT EXECUTABLE: ${RUN_USER_DIR} is not writable (real /run runtime probe)`) }, fn);

async function startUnixServer(sockPath) {
  let hits = 0;
  const server = net.createServer((c) => {
    hits += 1;
    c.destroy();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });
  return {
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const unixProbe = (obsPath, targets) => `
import net from 'node:net';
import { readdirSync, realpathSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const out = args.find((a) => a.startsWith('--outputFile=')).slice('--outputFile='.length);
const files = args.filter((a) => a.endsWith('.test.ts'));
const results = {};
const tryOne = (p) => new Promise((resolve) => {
  const s = net.connect(p);
  const t = setTimeout(() => { results[p] = 'TIMEOUT'; s.destroy(); resolve(); }, 3000);
  s.on('connect', () => { clearTimeout(t); results[p] = 'CONNECTED'; s.destroy(); resolve(); });
  s.on('error', (e) => { clearTimeout(t); results[p] = e.code; resolve(); });
});
for (const p of ${JSON.stringify(targets)}) await tryOne(p);
let runList; try { runList = readdirSync('/run'); } catch (e) { runList = ['ERR:' + e.code]; }
let varRun = null; try { varRun = realpathSync('/var/run'); } catch { varRun = null; }
writeFileSync(${JSON.stringify(obsPath)}, JSON.stringify({ results, runList, varRun, env: process.env }));
const n = files.length;
writeFileSync(out, JSON.stringify({ numTotalTestSuites: n, numPassedTestSuites: n, numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: n, numPassedTests: n, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: true,
  testResults: files.map((name) => ({ name, status: 'passed', assertionResults: [{ status: 'passed' }] })) }));
`;

async function runProbe(targets, { deps = {}, callerEnv = {} } = {}) {
  const root = mkFixture();
  const obsPath = path.join(root, 'observed.json');
  put(root, FAKE_VITEST_REL, unixProbe(obsPath, targets));
  const out = await withEnv(callerEnv, () => runSafeNodb({ paths: [A], repoRoot: root, deps: { screen: stubScreen, ...deps } }));
  return { root, out, obs: existsSync(obsPath) ? JSON.parse(readFileSync(obsPath, 'utf8')) : null };
}

realRunUserSock('[P0D-Y33][P0D-Y34] a disposable socket under /run/user/UID is unreachable through the runner (default masks) but reachable under the old -rn model', async () => {
  const sockPath = path.join(RUN_USER_DIR, `mona-p0d-${process.pid}-${Date.now()}.sock`);
  const server = await startUnixServer(sockPath);
  try {
    const { out, obs } = await runProbe([sockPath]);
    assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
    assert.ok(obs, 'the child must have run');
    assert.equal(obs.results[sockPath], 'ENOENT');
    assert.equal(server.hits(), 0, 'the host socket must never see a connection from the sandboxed child');

    // POSITIVE CONTROL (Y34): the OLD isolation model could reach it, so the assertion above discriminates.
    const probe = `const s=require('node:net').connect(${JSON.stringify(sockPath)});s.on('connect',()=>{console.log('CONNECTED');s.destroy()});s.on('error',(e)=>console.log(e.code))`;
    const stdout = await new Promise((resolve, reject) => {
      const child = spawnSync('/usr/bin/unshare', ['-rn', '--', process.execPath, '-e', probe], { encoding: 'utf8' });
      if (child.error) reject(child.error);
      else resolve(child.stdout);
    });
    assert.match(stdout, /CONNECTED/);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(server.hits() >= 1, 'control: the old -rn model reaches the host socket');
  } finally {
    await server.close();
  }
});

realRun('[P0D-Y35] an injected mask directory hides a disposable socket inside it', async () => {
  const base = mkdtempSync(path.join(tmpdir(), 'p0d-mask-'));
  created.push(base);
  const sockPath = path.join(base, 'x.sock');
  const server = await startUnixServer(sockPath);
  try {
    const { out, obs } = await runProbe([sockPath], { deps: { runtimeMaskDirs: [base] } });
    assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
    assert.ok(obs);
    assert.equal(obs.results[sockPath], 'ENOENT');
    assert.equal(server.hits(), 0);
    assert.deepEqual(out.result.maskedRuntimeDirs, [base]);
  } finally {
    await server.close();
  }
});

realRun('[P0D-Y36] the child sees an empty /run, /var/run resolves into it, and the host mounts are untouched', async () => {
  const mountsOnRun = () => readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter((l) => l.split(' ')[4] === '/run').length;
  const hostBefore = { list: readdirSync('/run').sort(), mounts: mountsOnRun() };
  const { out, obs } = await runProbe([]);
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
  assert.ok(obs);
  assert.deepEqual(obs.runList, [], 'the child must see an empty /run');
  assert.equal(obs.varRun, '/run');
  const hostAfter = { list: readdirSync('/run').sort(), mounts: mountsOnRun() };
  assert.deepEqual(hostAfter, hostBefore, 'no host mount or host /run content may change');
});

realRun('[P0D-Y37] ordinary libpq defaults are forced to the isolated TCP namespace and caller PG* values never reach the child', async () => {
  const callerEnv = {
    PGHOST: '/run/postgresql',
    PGSERVICE: 'prod-service',
    PGPASSWORD: 's3cret-pg-password',
    PGUSER: 'postgres-admin',
    PGDATABASE: 'production',
    PGPORT: '5432',
    PGPASSFILE: '/home/someone/.pgpass',
    PGSERVICEFILE: '/etc/pg_service.conf',
  };
  const { out, obs } = await runProbe([], { callerEnv });
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
  assert.ok(obs);
  assert.equal(obs.env.PGHOST, '127.0.0.1');
  assert.equal(obs.env.PGPORT, '1');
  assert.equal(obs.env.PGPASSFILE, '/dev/null');
  assert.equal(obs.env.PGSERVICEFILE, '/dev/null');
  for (const k of ['PGSERVICE', 'PGPASSWORD', 'PGUSER', 'PGDATABASE']) assert.ok(!(k in obs.env), k);
  assert.ok(!JSON.stringify(out.result).includes('s3cret-pg-password'));
});

realRun('[P0D-Y38] a failing mount tool is BLOCKED RUNTIME_MASK_FAILED and Vitest never starts', async () => {
  const { out, obs } = await runProbe([], { deps: { mountCandidates: ['/usr/bin/false'] } });
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.ok(codes(out).includes('RUNTIME_MASK_FAILED'));
  assert.equal(obs, null, 'Vitest must not have started');
  assert.equal(out.result.runtimeSocketIsolation, 'NOT_ESTABLISHED');
});

test('[P0D-Y39] wrapper sentinels 95 and 96 (no marker) are BLOCKED with their own codes', async () => {
  const root = mkFixture();
  const p = await go(root, [A], { run: fakeRun({ marker: false, code: 95 }) });
  assert.equal(p.result.verdict, 'BLOCKED');
  assert.ok(codes(p).includes('PROPAGATION_NOT_PRIVATE'));
  const m = await go(root, [A], { run: fakeRun({ marker: false, code: 96 }) });
  assert.equal(m.result.verdict, 'BLOCKED');
  assert.ok(codes(m).includes('RUNTIME_MASK_FAILED'));
  assert.equal(m.exitCode, 3);
});

test('[P0D-Y40] a caller TMPDIR located under a masked directory is BLOCKED TMPDIR_UNDER_MASKED_DIR, nothing spawned', async () => {
  const root = mkFixture();
  const base = mkdtempSync(path.join(tmpdir(), 'p0d-tmpmask-'));
  created.push(base);
  const run = fakeRun();
  const out = await withEnv({ TMPDIR: base }, () => go(root, [A], { run, runtimeMaskDirs: [base] }));
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.equal(out.exitCode, 3);
  assert.ok(codes(out).includes('TMPDIR_UNDER_MASKED_DIR'));
  assert.equal(run.calls.length, 0);
  assert.deepEqual(readdirSync(base), [], 'the rejected temp directory is cleaned up');
});

test('[P0D-Y41][P0D-Y42] the evidence names each guarantee separately and never claims arbitrary AF_UNIX isolation', async () => {
  const root = mkFixture();
  const pass = await go(root, [A], { run: passRun(root, [A]) });
  assert.equal(pass.result.verdict, 'PASS');
  assert.equal(pass.result.tcpDnsIsolation, 'ENFORCED');
  assert.equal(pass.result.runtimeSocketIsolation, 'MASKED');
  assert.ok(pass.result.maskedRuntimeDirs.includes('/run'));
  assert.equal(pass.result.arbitraryFilesystemUnixSocketIsolation, 'NOT_GUARANTEED');
  assert.ok(!('networkIsolation' in pass.result), 'the single over-claiming field must be gone');
  assert.match(pass.result.isolationModel, /user\+net\+mount/);

  const blocked = await go(root, [A], { run: fakeRun({ marker: false, code: 1 }) });
  assert.equal(blocked.result.tcpDnsIsolation, 'NOT_ESTABLISHED');
  assert.equal(blocked.result.runtimeSocketIsolation, 'NOT_ESTABLISHED');
  assert.equal(blocked.result.arbitraryFilesystemUnixSocketIsolation, 'NOT_GUARANTEED');

  const early = await go(mkFixture({ config: false }), [A], { run: fakeRun() });
  assert.equal(early.result.tcpDnsIsolation, 'NOT_ATTEMPTED');
  assert.equal(early.result.runtimeSocketIsolation, 'NOT_ATTEMPTED');
  assert.equal(early.result.arbitraryFilesystemUnixSocketIsolation, 'NOT_GUARANTEED');
});

test('[P0D-Y43] /var/run: symlink to /run is covered by /run, a distinct directory is masked too, an absent one is ignored', async () => {
  const dirStat = { isDirectory: () => true, isSymbolicLink: () => false };
  const mk = (varRun) => ({
    realpath: async (p) => {
      if (p === '/var/run') {
        if (varRun === 'ABSENT') throw Object.assign(new Error('x'), { code: 'ENOENT' });
        return varRun;
      }
      return p;
    },
    lstat: async (p) => {
      if (p === '/var/run' && varRun === 'ABSENT') throw Object.assign(new Error('x'), { code: 'ENOENT' });
      return dirStat;
    },
  });
  const dirsFor = async (varRun) => {
    const root = mkFixture();
    const run = fakeRun();
    await go(root, [A], { run, fsOps: mk(varRun) });
    assert.equal(run.calls.length, 1);
    const a = run.calls[0].args;
    const i = a.indexOf('sh');
    return a.slice(i + 5, i + 5 + Number(a[i + 4]));
  };
  assert.deepEqual(await dirsFor('/run'), ['/run']);
  assert.deepEqual(await dirsFor('/srv/distinct-var-run'), ['/run', '/var/run']);
  assert.deepEqual(await dirsFor('ABSENT'), ['/run']);
});

test('[P0D-Y44] a missing mount binary is BLOCKED MOUNT_MISSING and nothing is spawned', async () => {
  const root = mkFixture();
  const run = fakeRun();
  const out = await go(root, [A], { run, mountCandidates: ['/nonexistent/mount'] });
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.ok(codes(out).includes('MOUNT_MISSING'));
  assert.equal(run.calls.length, 0);
});

test('[P0D-Y45] a mask directory that does not exist is BLOCKED RUNTIME_DIR_UNAVAILABLE', async () => {
  const root = mkFixture();
  const run = fakeRun();
  const out = await go(root, [A], { run, runtimeMaskDirs: ['/nonexistent-mask-dir-p0d'] });
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.ok(codes(out).includes('RUNTIME_DIR_UNAVAILABLE'));
  assert.equal(run.calls.length, 0);
});

// ======================================================= TOOLING-P0F tests (mock registrations are load edges)

tsTest('[P0F-Z01][P0F-Z02][P0F-Z03][P0F-Z05] a parameterless vi.mock/vi.doMock of a denied module is DENY under the same normalized classification', () => {
  assert.ok(dcodes(screen("vi.mock('postgres');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("vi.doMock('node:tls');")).includes('SOCKET_PRIMITIVE_IMPORT'));
  assert.ok(dcodes(screen("vi.mock('node:child_process');")).includes('CHILD_PROCESS_IMPORT'));
  assert.ok(dcodes(screen("vi.mock('@prisma/adapter-pg?raw');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("vi.doMock('pg#frag');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("vi.mock('../helpers/test-db.js');", 'api/tests/rbac/x.test.ts')).includes('DB_HELPER_IMPORT'));
});

tsTest('[P0F-Z04][P0F-Z06][P0F-Z07][P0F-Z08] options-object, undefined, unknown-arity and rest-parameter factories can load the original: DENY (fail closed)', () => {
  for (const src of [
    "vi.mock('pg', { spy: true });",
    "vi.mock('pg', undefined);",
    "vi.mock('pg', makeFactory);",
    "vi.mock('pg', buildFactory());",
    "vi.mock('pg', (...a) => ({}));",
    "vi.doMock('pg', async (importOriginal) => importOriginal());",
  ]) {
    assert.ok(dcodes(screen(src)).includes('DB_DRIVER_IMPORT'), src);
  }
});

tsTest('[P0F-Z09][P0F-Z10][P0F-Z11][P0F-Z12][P0F-Z13] CONTROLS: zero-parameter factories, harmless builtins and unmock never load a denied module', () => {
  for (const src of [
    "vi.mock('pg', () => ({}));",
    "vi.mock('pg', async () => ({ Pool: class {} }));",
    "vi.doMock('pg', function () { return {}; });",
    "vi.mock('node:fs');",
    "vi.mock('node:path', () => ({}));",
    "vi.unmock('pg');",
    "vi.doUnmock('pg');",
  ]) {
    const r = screen(src);
    assert.deepEqual([dcodes(r), wcodes(r)], [[], []], src);
  }
  // positive control: the rule is not "ban every mock"
  assert.ok(dcodes(screen("vi.mock('pg');")).includes('DB_DRIVER_IMPORT'));
});

tsTest('[P0F-Z14][P0F-Z15] a non-literal specifier on a load edge is DENY; with a zero-parameter factory it is not a load edge', () => {
  for (const src of ['vi.mock(name);', 'vi.doMock(`./m-${x}.js`);', "vi.mock('./a' + b);", 'vi.mock(name, undefined);']) {
    assert.ok(dcodes(screen(src)).includes('NON_LITERAL_IMPORT'), src);
  }
  const ok = screen('vi.mock(name, () => ({}));');
  assert.deepEqual([dcodes(ok), wcodes(ok)], [[], []]);
});

tsTest('[P0F-Z16] the typed vi.mock(import(...)) form is classified through the import() call', () => {
  assert.ok(dcodes(screen("vi.mock(import('pg'));")).includes('DB_DRIVER_IMPORT'));
  const ok = screen("vi.mock(import('./safe.js'), () => ({}));");
  assert.deepEqual(dcodes(ok), []);
});

tsTest('[P0F-Z17][P0F-Z18] an aliased receiver or bracket access does not hide a parameterless mock', () => {
  assert.ok(dcodes(screen("const v = vi;\nv.mock('pg');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("vi['doMock']('pg');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("jest.mock('pg');")).includes('DB_DRIVER_IMPORT'));
});

tsTest('[P0F-Z19][P0F-Z20] taking vi.mock/doMock as a value is DENY INDIRECT_MOCK; spy bookkeeping `.mock.calls` is not a mock registration', () => {
  assert.ok(dcodes(screen("const m = vi.mock;\nm('pg');")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("const { doMock } = vi;\ndoMock('pg');")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("const { mock: reg } = vitest;\nreg('pg');")).includes('INDIRECT_MOCK'));
  for (const src of ['expect(fn.mock.calls.length).toBe(1);', 'const r = vi.fn().mock.results;', 'const c = spy.mock.calls[0];']) {
    const r = screen(src);
    assert.deepEqual([dcodes(r), wcodes(r)], [[], []], src);
  }
});

tsTest('[P0F-Z21] a parameterless local mock participates in the transitive closure (three levels, denied import at the bottom)', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/z21.test.ts': "vi.mock('./helpers/z21-h1.js');\n",
      'api/tests/helpers/z21-h1.ts': "import { x } from './z21-h2.js';\nexport const h = x;\n",
      'api/tests/helpers/z21-h2.ts': "import net from 'node:net';\nexport const x = net;\n",
    },
  });
  const out = await closureGo(root, ['api/tests/z21.test.ts']);
  assert.equal(out.result.verdict, 'DENY');
  assert.match(detail(out), /api\/tests\/helpers\/z21-h2\.ts:1 SOCKET_PRIMITIVE_IMPORT/);
});

tsTest('[P0F-Z22][P0F-Z24] unresolvable local mocks fail closed; query+hash variants are resolved and traversed', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/z22.test.ts': "vi.mock('./nope.js');\n",
      'api/tests/z24.test.ts': "vi.mock('./helpers/z24-h1.js?x=1#y');\n",
      'api/tests/helpers/z24-h1.ts': "import { Pool } from 'pg';\nexport { Pool };\n",
    },
  });
  const a = await closureGo(root, ['api/tests/z22.test.ts']);
  assert.equal(a.result.verdict, 'DENY');
  assert.match(detail(a), /UNRESOLVED_LOCAL_IMPORT/);
  const b = await closureGo(root, ['api/tests/z24.test.ts']);
  assert.equal(b.result.verdict, 'DENY');
  assert.match(detail(b), /api\/tests\/helpers\/z24-h1\.ts:1 DB_DRIVER_IMPORT/);
});

tsTest('[P0F-Z23][P0F-Z25][P0F-Z28][P0F-Z29] CONTROLS: mock cycles terminate; zero-parameter factories, third-party packages and generated output are not traversed', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/z23.test.ts': "vi.mock('./helpers/z23-a.js');\nexport {};\n",
      'api/tests/helpers/z23-a.ts': "vi.mock('../z23.test.js');\nexport const a = 1;\n",
      'api/tests/z25.test.ts': "vi.mock('./helpers/z25-bad.js', () => ({ x: 1 }));\n",
      'api/tests/helpers/z25-bad.ts': "import { Pool } from 'pg';\nexport { Pool };\n",
      'api/tests/z28.test.ts': "vi.mock('left-pad');\n",
      'api/tests/z29.test.ts': "vi.mock('../src/generated/prisma/client.js');\n",
    },
  });
  put(root, 'api/node_modules/left-pad/index.js', "import 'pg';\n");
  for (const t of ['z23', 'z25', 'z28', 'z29']) {
    const out = await closureGo(root, [`api/tests/${t}.test.ts`]);
    assert.equal(out.result.verdict, 'PASS', `${t}: ${detail(out)}`);
  }
});

tsTest('[P0F-Z26][P0F-Z27] a parameterless mock of the repo DB helper is DENY; of the config/prisma boundary it is WARN only', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/z26.test.ts': "vi.mock('./helpers/test-db.js');\n",
      'api/tests/z27.test.ts': "vi.mock('../src/config/prisma.js');\n",
      'api/src/config/prisma.ts': "import pg from 'pg';\nexport const prisma = new pg.Pool();\n",
    },
  });
  const a = await closureGo(root, ['api/tests/z26.test.ts']);
  assert.equal(a.result.verdict, 'DENY');
  assert.match(detail(a), /DB_HELPER_IMPORT/);
  const b = await closureGo(root, ['api/tests/z27.test.ts']);
  assert.equal(b.result.verdict, 'PASS', detail(b));
  assert.ok(b.result.warnings.some((w) => w.code === 'PRISMA_CONFIG_IMPORT'));
});

tsTest('[P0F-Z30] the closure bound still applies to files reached through mocks', async () => {
  const files = { 'api/tests/z30.test.ts': "vi.mock('./helpers/z30-0.js');\n" };
  for (let i = 0; i < 5; i += 1) files[`api/tests/helpers/z30-${i}.ts`] = i < 4 ? `vi.mock('./z30-${i + 1}.js');\n` : 'export {};\n';
  const root = mkFixture({ extraTracked: files });
  const out = await closureGo(root, ['api/tests/z30.test.ts'], { maxScreenFiles: 3 });
  assert.equal(out.result.verdict, 'DENY');
  assert.match(detail(out), /CLOSURE_TOO_LARGE/);
});


// ======================================================= TOOLING-P0H tests

// ---- A. report accounting (cardinality, suite structure, totals)

const withSuites = (root, files, mutate) => {
  const rep = reportFor(root, files);
  if (mutate) mutate(rep);
  return rep;
};
const goReport = (root, files, report, extra = {}) => go(root, files, { run: fakeRun({ report, ...extra }) });
const blockedWith = (out, code) => {
  assert.equal(out.result.verdict, 'BLOCKED', JSON.stringify(out.result.errors));
  assert.equal(out.exitCode, 3);
  assert.ok(codes(out).includes(code), `${code} not in ${JSON.stringify(codes(out))}`);
};

test('[P0H-CX-A1][P0H-W01] a duplicate reporter entry for one requested file is BLOCKED REPORT_DUPLICATE_FILE (also when spelled differently)', async () => {
  const root = mkFixture();
  const dup = withSuites(root, [A], (r) => {
    r.testResults.push({ ...r.testResults[0] });
    r.numTotalTestSuites = 2;
    r.numPassedTestSuites = 2;
    r.numTotalTests = 2;
    r.numPassedTests = 2;
  });
  blockedWith(await goReport(root, [A], dup), 'REPORT_DUPLICATE_FILE');
  const spelled = withSuites(root, [A], (r) => {
    r.testResults.push({ ...r.testResults[0], name: path.join(root, 'api/tests/rbac/../rbac/a.test.ts') });
    r.numTotalTestSuites = 2;
    r.numPassedTestSuites = 2;
    r.numTotalTests = 2;
    r.numPassedTests = 2;
  });
  blockedWith(await goReport(root, [A], spelled), 'REPORT_DUPLICATE_FILE');
});

test('[P0H-W02] a report that lists A twice and omits B is BLOCKED', async () => {
  const root = mkFixture();
  const rep = reportFor(root, [A, A]);
  const out = await goReport(root, [A, B], rep);
  assert.equal(out.result.verdict, 'BLOCKED');
  assert.ok(codes(out).includes('REPORT_DUPLICATE_FILE') || codes(out).includes('REPORT_FILE_SET_MISMATCH'));
});

test('[P0H-CX-A2] an unknown suite status is BLOCKED', async () => {
  const root = mkFixture();
  for (const status of ['weird', 'PASSED', '', 7, null]) {
    const rep = withSuites(root, [A], (r) => {
      r.testResults[0].status = status;
    });
    const out = await goReport(root, [A], rep);
    assert.equal(out.result.verdict, 'BLOCKED', String(status));
    assert.ok(codes(out).some((c) => c === 'REPORTER_INCONSISTENT' || c === 'REPORTER_MALFORMED'), String(status));
  }
});

test('[P0H-CX-A3][P0H-W05][P0H-W08] invalid, non-finite or absent suite totals are BLOCKED REPORTER_MALFORMED', async () => {
  const root = mkFixture();
  for (const [field, value] of [
    ['numTotalTestSuites', -1],
    ['numTotalTestSuites', '1'],
    ['numPassedTestSuites', null],
    ['numFailedTestSuites', 1.5],
    ['numPendingTestSuites', -0.5],
  ]) {
    const rep = withSuites(root, [A], (r) => {
      r[field] = value;
    });
    blockedWith(await goReport(root, [A], rep), 'REPORTER_MALFORMED');
  }
  const inf = JSON.stringify(reportFor(root, [A])).replace('"numTotalTestSuites":1', '"numTotalTestSuites":1e999');
  assert.match(inf, /1e999/);
  blockedWith(await goReport(root, [A], inf), 'REPORTER_MALFORMED');
  for (const field of ['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites']) {
    const rep = withSuites(root, [A], (r) => {
      delete r[field];
    });
    blockedWith(await goReport(root, [A], rep), 'REPORTER_MALFORMED');
  }
});

test('[P0H-CX-A4][P0H-W13] inconsistent suite totals are BLOCKED REPORTER_INCONSISTENT', async () => {
  const root = mkFixture();
  for (const mutate of [
    (r) => { r.numTotalTestSuites = 5; },
    (r) => { r.numPassedTestSuites = 0; },
    (r) => { r.numPendingTestSuites = 1; },
    (r) => { r.numFailedTestSuites = 1; r.numPassedTestSuites = 0; },
  ]) {
    blockedWith(await goReport(root, [A], withSuites(root, [A], mutate)), 'REPORTER_INCONSISTENT');
  }
});

test('[P0H-W03][P0H-W04][P0H-W10][P0H-W14] structurally invalid suite or assertion entries and file names are BLOCKED REPORTER_MALFORMED', async () => {
  const root = mkFixture();
  for (const entry of [null, 'text', ['x'], 5]) {
    const rep = withSuites(root, [A], (r) => {
      r.testResults = [entry];
    });
    blockedWith(await goReport(root, [A], rep), 'REPORTER_MALFORMED');
  }
  for (const name of ['api/tests/rbac/a.test.ts', './a.test.ts', '', 42, null]) {
    const rep = withSuites(root, [A], (r) => {
      r.testResults[0].name = name;
    });
    blockedWith(await goReport(root, [A], rep), 'REPORTER_MALFORMED');
  }
  for (const a of [null, 'passed', 7, ['passed']]) {
    const rep = withSuites(root, [A], (r) => {
      r.testResults[0].assertionResults = [a];
    });
    blockedWith(await goReport(root, [A], rep), 'REPORTER_MALFORMED');
  }
});

test('[P0H-W06][P0H-W07][P0H-W09] a suite status that contradicts its own evidence is BLOCKED REPORTER_INCONSISTENT', async () => {
  const root = mkFixture();
  const passedButFailed = withSuites(root, [A], (r) => {
    r.numPassedTests = 0;
    r.numFailedTests = 1;
    r.success = false;
    r.testResults[0].assertionResults = [{ status: 'failed' }];
  });
  blockedWith(await goReport(root, [A], passedButFailed), 'REPORTER_INCONSISTENT');
  const skippedButPassed = withSuites(root, [A], (r) => {
    r.testResults[0].status = 'skipped';
    r.numPassedTestSuites = 0;
    r.numPendingTestSuites = 1;
  });
  blockedWith(await goReport(root, [A], skippedButPassed), 'REPORTER_INCONSISTENT');
  const failedSuiteUncounted = withSuites(root, [A], (r) => {
    r.testResults[0].status = 'failed';
    r.success = false;
  });
  blockedWith(await goReport(root, [A], failedSuiteUncounted), 'REPORTER_INCONSISTENT');
});

test('[P0H-W11][P0H-W12] CONTROLS: valid negative suite evidence is still FAIL; file order does not matter for PASS', async () => {
  const root = mkFixture();
  const failedSuite = withSuites(root, [A], (r) => {
    r.testResults[0].status = 'failed';
    r.testResults[0].assertionResults = [];
    r.numTotalTests = 0;
    r.numPassedTests = 0;
    r.numTotalTestSuites = 1;
    r.numPassedTestSuites = 0;
    r.numFailedTestSuites = 1;
    r.success = false;
  });
  const f = await goReport(root, [A], failedSuite);
  assert.equal(f.result.verdict, 'FAIL');
  assert.equal(f.exitCode, 1);
  assert.ok(codes(f).includes('SUITE_FAILED'));
  const reordered = withSuites(root, [A, B], (r) => {
    r.testResults.reverse();
  });
  const p = await goReport(root, [A, B], reordered);
  assert.equal(p.result.verdict, 'PASS', JSON.stringify(p.result.errors));
});

test('previous report-evidence behavior is preserved (malformed JSON, missing report, extra file, unknown assertion status, zero executed, skipped-only, failed tests, non-zero exit, valid PASS)', async () => {
  const root = mkFixture();
  blockedWith(await goReport(root, [A], '{not json'), 'REPORTER_MALFORMED');
  blockedWith(await goReport(root, [A], undefined), 'REPORTER_MISSING');
  blockedWith(await goReport(root, [A], reportFor(root, [A, B])), 'REPORT_FILE_SET_MISMATCH');
  const unknownAssertion = withSuites(root, [A], (r) => {
    r.testResults[0].assertionResults = [{ status: 'mystery' }];
  });
  blockedWith(await goReport(root, [A], unknownAssertion), 'REPORTER_INCONSISTENT');
  const zero = withSuites(root, [A], (r) => {
    r.numTotalTests = 0;
    r.numPassedTests = 0;
    r.testResults[0].assertionResults = [];
  });
  const z = await goReport(root, [A], zero);
  assert.equal(z.result.verdict, 'FAIL');
  const failing = withSuites(root, [A], (r) => {
    r.numPassedTests = 0;
    r.numFailedTests = 1;
    r.success = false;
    r.testResults[0].status = 'failed';
    r.testResults[0].assertionResults = [{ status: 'failed' }];
    r.numPassedTestSuites = 0;
    r.numFailedTestSuites = 1;
  });
  const f = await goReport(root, [A], failing, { code: 1 });
  assert.equal(f.result.verdict, 'FAIL');
  const nz = await goReport(root, [A], reportFor(root, [A]), { code: 1 });
  assert.equal(nz.result.verdict, 'FAIL');
  const ok = await goReport(root, [A], reportFor(root, [A]));
  assert.equal(ok.result.verdict, 'PASS');
});

// ---- B. mock access class

tsTest('[P0H-CX-B1][P0H-CX-B2][P0H-CX-B3] bracket-property, bound and unresolvable-computed mock registrations are DENY INDIRECT_MOCK', () => {
  for (const src of [
    "const m = vi['mock'];\nm('pg');",
    'const d = jest["doMock"];\nd(\'pg\');',
    "vi['mock'].bind(vi)('pg');",
    "vi.mock.bind(vi)('pg');",
    "vi[key]('pg');",
  ]) {
    assert.ok(dcodes(screen(src)).includes('INDIRECT_MOCK'), src);
  }
});

tsTest('[P0H-W20][P0H-W21][P0H-W22][P0H-W34] statically resolvable names are classified as ordinary mock calls', () => {
  assert.ok(dcodes(screen("const k = 'mock';\nvi[k]('pg');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("vi['do' + 'Mock']('node:net');")).includes('SOCKET_PRIMITIVE_IMPORT'));
  assert.ok(dcodes(screen("vi[`mock`]('pg');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("const base = 'do';\nconst k = `${base}Mock`;\nvi[k]('pg');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("vi?.mock('pg');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("vi.mock?.('pg');")).includes('DB_DRIVER_IMPORT'));
});

tsTest('[P0H-W23][P0H-W24] a conditional or call-computed property name on a mock receiver is unanalyzable: DENY INDIRECT_MOCK', () => {
  assert.ok(dcodes(screen("vi[flag ? 'mock' : 'doMock']('pg');")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("const reg = vi[pick()];\nreg('x');")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("let n;\nn = 'mock';\nvi[n]('pg');")).includes('INDIRECT_MOCK'), 'a non-const binding is not trusted');
});

tsTest('[P0H-W25][P0H-W26] receiver aliases (chains, vitest import aliases, wrappers) are tracked before the property is extracted', () => {
  assert.ok(dcodes(screen("const a = vi;\nconst b = a;\nconst m = b['mock'];\nm('pg');")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("import { vi as v } from 'vitest';\nconst m = v.doMock;\nm('pg');")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("const m = (vi as any)['mock'];\nm('pg');")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("import * as V from 'vitest';\nconst m = V.vi.doMock;\nm('pg');")).includes('INDIRECT_MOCK'));
});

tsTest('[P0H-W27][P0H-W28][P0H-W29] call/apply forms, computed destructuring and rest aliases do not launder a mock registration', () => {
  assert.ok(dcodes(screen("vi['mock'].call(vi, 'pg');")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("Reflect.apply(vi['doMock'], vi, ['pg']);")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("const { ['do' + 'Mock']: reg } = vi;\nreg('pg');")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("const { [k]: reg } = vi;\nreg('pg');")).includes('INDIRECT_MOCK'));
  assert.ok(dcodes(screen("const { ...rest } = vi;\nrest.mock('pg');")).includes('DB_DRIVER_IMPORT'));
  assert.ok(dcodes(screen("const { ...rest } = vi;\nconst m = rest['mock'];\nm('pg');")).includes('INDIRECT_MOCK'));
});

tsTest('[P0H-W30][P0H-W31][P0H-W32] CONTROLS: other vi members, unrelated objects and zero-parameter factories are not banned', () => {
  for (const src of [
    "const f = vi['fn']();",
    "vi[`spyOn`](obj, 'method');",
    "vi['useFakeTimers']();",
    "registry[name]('pg');",
    "const o = { mock: 1 };\nconst x = o['mock'];",
    "(vi as any)['mock']('./x.js', () => ({}));",
    "expect(spy['mock'].calls.length).toBe(1);",
  ]) {
    const r = screen(src);
    assert.deepEqual([dcodes(r), wcodes(r)], [[], []], src);
  }
  assert.ok(dcodes(screen("(vi as any)['mock']('pg');")).includes('DB_DRIVER_IMPORT'));
});

tsTest('[P0H-W33] a statically resolved computed mock of a local module joins the transitive closure', async () => {
  const root = mkFixture({
    extraTracked: {
      'api/tests/w33.test.ts': "vi['do' + 'Mock']('./helpers/w33.js');\n",
      'api/tests/helpers/w33.ts': "import { Pool } from 'pg';\nexport { Pool };\n",
    },
  });
  const out = await closureGo(root, ['api/tests/w33.test.ts']);
  assert.equal(out.result.verdict, 'DENY');
  assert.match(detail(out), /api\/tests\/helpers\/w33\.ts:1 DB_DRIVER_IMPORT/);
});


// ======================================================= TOOLING-P0J tests (Vitest-shaped nested suite counters)

// Models the pinned Vitest 5 shape: one suite per FILE plus one per nested describe, so
// numTotalTestSuites = files + describes, while testResults has one entry per file.
function nestedReport(root, files, describes, over = {}) {
  const sum = describes.reduce((a, b) => a + b, 0);
  const suites = files.length + sum;
  const tests = files.length + sum;
  return {
    numTotalTestSuites: suites,
    numPassedTestSuites: suites,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: tests,
    numPassedTests: tests,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    success: true,
    testResults: files.map((rel, i) => ({
      name: absOf(root, rel),
      status: 'passed',
      assertionResults: Array.from({ length: describes[i] + 1 }, () => ({ status: 'passed' })),
    })),
    ...over,
  };
}

test('[P0J-NV1][P0J-NV2][P0J-NV3][P0J-V01][P0J-V12] a valid report whose nested describes make numTotalTestSuites exceed the file entries is PASS', async () => {
  const root = mkFixture();
  for (const [files, describes] of [
    [[A], [1]],
    [[A], [3]],
    [[A, B], [2, 3]],
    [[A], [3]], // deep nesting counts the same: three describe suites
    [[A, B], [1, 5]],
  ]) {
    const rep = nestedReport(root, files, describes);
    assert.ok(rep.numTotalTestSuites > rep.testResults.length, 'shape sanity: more suites than file entries');
    const out = await goReport(root, files, rep);
    assert.equal(out.result.verdict, 'PASS', `${JSON.stringify(describes)}: ${JSON.stringify(out.result.errors)}`);
    assert.equal(out.exitCode, 0);
  }
});

test('[P0J-V12] three files with 0, 2 and 5 nested describes (total 10 suites for 3 entries) is PASS', async () => {
  const third = 'api/tests/third.test.ts';
  const root = mkFixture({ extraTracked: { [third]: BENIGN } });
  const rep = nestedReport(root, [A, B, third], [0, 2, 5]);
  assert.equal(rep.numTotalTestSuites, 10);
  assert.equal(rep.testResults.length, 3);
  const out = await goReport(root, [A, B, third], rep);
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
});

test('[P0J-V02] a skipped nested describe: file and describe A passed, describe B pending, one executed pass is PASS', async () => {
  const root = mkFixture();
  const rep = nestedReport(root, [A], [2], {
    numTotalTestSuites: 3,
    numPassedTestSuites: 2,
    numPendingTestSuites: 1,
    numTotalTests: 2,
    numPassedTests: 1,
    numPendingTests: 1,
  });
  rep.testResults[0].assertionResults = [{ status: 'passed' }, { status: 'pending' }];
  const out = await goReport(root, [A], rep);
  assert.equal(out.result.verdict, 'PASS', JSON.stringify(out.result.errors));
});

test('[P0J-V03] file and nested describe both failed, Vitest exit 1 is FAIL with the counts', async () => {
  const root = mkFixture();
  const rep = nestedReport(root, [A], [1], {
    numPassedTestSuites: 0,
    numFailedTestSuites: 2,
    numPassedTests: 1,
    numFailedTests: 1,
    success: false,
  });
  rep.testResults[0].status = 'failed';
  rep.testResults[0].assertionResults = [{ status: 'passed' }, { status: 'failed' }];
  const out = await goReport(root, [A], rep, { code: 1 });
  assert.equal(out.result.verdict, 'FAIL');
  assert.equal(out.exitCode, 1);
  assert.equal(out.result.testsFailed, 1);
});

test('[P0J-V04][P0J-V05] a failed nested describe counted only in numFailedTestSuites is FAIL (success false) or BLOCKED (success true)', async () => {
  const root = mkFixture();
  const mk = (success) =>
    nestedReport(root, [A], [1], { numPassedTestSuites: 1, numFailedTestSuites: 1, numTotalTests: 1, numPassedTests: 1, success });
  const rep = (success) => {
    const r = mk(success);
    r.testResults[0].assertionResults = [{ status: 'passed' }];
    return r;
  };
  const f = await goReport(root, [A], rep(false));
  assert.equal(f.result.verdict, 'FAIL', JSON.stringify(f.result.errors));
  assert.ok(codes(f).includes('SUITE_FAILED'));
  blockedWith(await goReport(root, [A], rep(true)), 'REPORTER_INCONSISTENT');
});

test('[P0J-V06][P0J-V07][P0J-V08][P0J-V09] impossible suite arithmetic stays BLOCKED REPORTER_INCONSISTENT', async () => {
  const root = mkFixture();
  // V06: total 4 but parts sum to 3
  blockedWith(await goReport(root, [A], nestedReport(root, [A], [3], { numPassedTestSuites: 2, numPendingTestSuites: 1 })), 'REPORTER_INCONSISTENT');
  // V07: two requested files, only one suite counted
  blockedWith(await goReport(root, [A, B], nestedReport(root, [A, B], [0, 0], { numTotalTestSuites: 1, numPassedTestSuites: 1 })), 'REPORTER_INCONSISTENT');
  // V08: a file entry is failed but no suite is counted failed (total inflated by nested suites)
  const v08 = nestedReport(root, [A], [2], { numPassedTests: 1, numFailedTests: 1, numTotalTests: 2, success: false });
  v08.testResults[0].status = 'failed';
  v08.testResults[0].assertionResults = [{ status: 'passed' }, { status: 'failed' }];
  blockedWith(await goReport(root, [A], v08), 'REPORTER_INCONSISTENT');
  // V09: a component exceeds the total
  blockedWith(await goReport(root, [A], nestedReport(root, [A], [1], { numTotalTestSuites: 2, numPassedTestSuites: 5 })), 'REPORTER_INCONSISTENT');
});

test('[P0J-V10] malformed nested-suite counters (string, negative, fractional, non-finite) are BLOCKED REPORTER_MALFORMED', async () => {
  const root = mkFixture();
  for (const v of ['2', -1, 1.5, null]) {
    blockedWith(await goReport(root, [A], nestedReport(root, [A], [1], { numPassedTestSuites: v })), 'REPORTER_MALFORMED');
  }
  const text = JSON.stringify(nestedReport(root, [A], [1])).replace('"numTotalTestSuites":2', '"numTotalTestSuites":1e999');
  assert.match(text, /1e999/);
  blockedWith(await goReport(root, [A], text), 'REPORTER_MALFORMED');
});

test('[P0J-V11] nested describes whose tests are all todo executed nothing: FAIL NO_TESTS_EXECUTED', async () => {
  const root = mkFixture();
  const rep = nestedReport(root, [A], [1], { numPassedTests: 0, numTodoTests: 2 });
  rep.testResults[0].assertionResults = [{ status: 'todo' }, { status: 'todo' }];
  const out = await goReport(root, [A], rep);
  assert.equal(out.result.verdict, 'FAIL', JSON.stringify(out.result.errors));
  assert.ok(codes(out).includes('NO_TESTS_EXECUTED'));
});

test('[P0J-V13] a duplicate file entry is still caught when inflated nested-suite totals make the counters look right', async () => {
  const root = mkFixture();
  const rep = nestedReport(root, [A, A], [1, 1]);
  assert.equal(rep.numTotalTestSuites, 4);
  blockedWith(await goReport(root, [A], rep), 'REPORT_DUPLICATE_FILE');
});

test('[P0J-V14][P0J-V15] test-level evidence stays strict beside nested suites', async () => {
  const root = mkFixture();
  blockedWith(await goReport(root, [A], nestedReport(root, [A], [2], { numTotalTests: 4 })), 'REPORTER_INCONSISTENT');
  const contradictory = nestedReport(root, [A], [2], { numPassedTests: 2, numFailedTests: 1, success: false });
  contradictory.testResults[0].assertionResults = [{ status: 'passed' }, { status: 'passed' }, { status: 'failed' }];
  blockedWith(await goReport(root, [A], contradictory), 'REPORTER_INCONSISTENT'); // file entry says passed but holds a failed assertion
});


// ======================================================= TOOLING-P0L tests (evidence first, then outcome)

const nonZero = (root, files, report, code = 1) => goReport(root, files, report, { code });
const expectBlocked = (out, code, exit) => {
  blockedWith(out, code);
  if (exit !== undefined) assert.equal(out.result.processExit.code, exit, 'the numeric exit status is still reported as evidence');
};

test('[P0L-CX-1][P0L-CX-2][P0L-E09][P0L-E10][P0L-E11][P0L-E03] a non-zero exit never turns missing or unparsable reporter output into FAIL', async () => {
  const root = mkFixture();
  expectBlocked(await nonZero(root, [A], undefined), 'REPORTER_MISSING', 1);
  expectBlocked(await nonZero(root, [A], '{not json'), 'REPORTER_MALFORMED', 1);
  expectBlocked(await nonZero(root, [A], ''), 'REPORTER_MALFORMED', 1);
  for (const text of ['null', '[]', '"x"', '42', 'true']) expectBlocked(await nonZero(root, [A], text), 'REPORTER_MALFORMED', 1);
  expectBlocked(await goReport(root, [A], undefined), 'REPORTER_MISSING', 0); // unchanged: exit 0 + missing
  // reporter path is a directory
  const base = fakeRun({ code: 1 });
  const run = async (call) => {
    const r = await base(call);
    mkdirSync(call.reportPath);
    return r;
  };
  run.calls = base.calls;
  expectBlocked(await go(root, [A], { run }), 'REPORTER_MISSING', 1);
});

test('[P0L-CX-3][P0L-CX-4][P0L-CX-5][P0L-E12][P0L-E18] a non-zero exit never hides a wrong reported file set (duplicate, missing, extra)', async () => {
  const root = mkFixture();
  const dup = withSuites(root, [A], (r) => {
    r.testResults.push({ ...r.testResults[0] });
    r.numTotalTestSuites = 2;
    r.numPassedTestSuites = 2;
    r.numTotalTests = 2;
    r.numPassedTests = 2;
  });
  expectBlocked(await nonZero(root, [A], dup), 'REPORT_DUPLICATE_FILE', 1);
  const spelled = withSuites(root, [A], (r) => {
    r.testResults.push({ ...r.testResults[0], name: path.join(root, 'api/tests/rbac/../rbac/a.test.ts') });
    r.numTotalTestSuites = 2;
    r.numPassedTestSuites = 2;
    r.numTotalTests = 2;
    r.numPassedTests = 2;
  });
  expectBlocked(await nonZero(root, [A], spelled), 'REPORT_DUPLICATE_FILE', 1);
  expectBlocked(await nonZero(root, [A, B], reportFor(root, [A])), 'REPORT_FILE_SET_MISMATCH', 1); // B missing
  expectBlocked(await nonZero(root, [A], reportFor(root, [A, B])), 'REPORT_FILE_SET_MISMATCH', 1); // B extra
});

test('[P0L-CX-6][P0L-CX-7][P0L-CX-8][P0L-E04][P0L-E05][P0L-E17][P0L-E19] a non-zero exit never hides inconsistent counters, unknown statuses, relative names or contradictory evidence', async () => {
  const root = mkFixture();
  expectBlocked(await nonZero(root, [A], withSuites(root, [A], (r) => { r.numTotalTests = 7; })), 'REPORTER_INCONSISTENT', 1);
  expectBlocked(await nonZero(root, [A], withSuites(root, [A], (r) => { r.numTotalTestSuites = 9; })), 'REPORTER_INCONSISTENT', 1);
  expectBlocked(await nonZero(root, [A], withSuites(root, [A], (r) => { r.testResults[0].assertionResults = [{ status: 'mystery' }]; })), 'REPORTER_INCONSISTENT', 1);
  expectBlocked(await nonZero(root, [A], withSuites(root, [A], (r) => { r.testResults[0].status = 'weird'; })), 'REPORTER_INCONSISTENT', 1);
  expectBlocked(
    await nonZero(root, [A], withSuites(root, [A], (r) => { r.numPassedTests = 0; r.numFailedTests = 1; r.testResults[0].assertionResults = [{ status: 'failed' }]; })),
    'REPORTER_INCONSISTENT',
    1,
  ); // success:true although a failed test is recorded
  expectBlocked(await nonZero(root, [A], withSuites(root, [A], (r) => { r.testResults[0].name = 'api/tests/rbac/a.test.ts'; })), 'REPORTER_MALFORMED', 1);
  const failedUncounted = withSuites(root, [A], (r) => {
    r.testResults[0].status = 'failed';
    r.success = false;
  });
  expectBlocked(await nonZero(root, [A], failedUncounted), 'REPORTER_INCONSISTENT', 1);
});

test('[P0L-CX-C1][P0L-CX-C2][P0L-E01][P0L-E02][P0L-E06][P0L-E13][P0L-E20] CONTROLS: usable evidence + any numeric non-zero exit is FAIL', async () => {
  const root = mkFixture();
  const negative = withSuites(root, [A], (r) => {
    r.numPassedTests = 0;
    r.numFailedTests = 1;
    r.success = false;
    r.testResults[0].status = 'failed';
    r.testResults[0].assertionResults = [{ status: 'failed' }];
    r.numPassedTestSuites = 0;
    r.numFailedTestSuites = 1;
  });
  for (const [report, code] of [
    [reportFor(root, [A]), 1],
    [reportFor(root, [A]), 2],
    [reportFor(root, [A]), 255],
    [negative, 1],
    [negative, 255],
    [nestedReport(root, [A], [2]), 1],
    [nestedReport(root, [A], [2], { numPassedTests: 2, numFailedTests: 1, numTotalTests: 3, numPassedTestSuites: 2, numFailedTestSuites: 1, success: false }), 1],
  ]) {
    if (report.numFailedTests === 1 && report.testResults[0].assertionResults.length === 3) {
      report.testResults[0].status = 'failed';
      report.testResults[0].assertionResults = [{ status: 'passed' }, { status: 'passed' }, { status: 'failed' }];
    }
    const out = await nonZero(root, [A], report, code);
    assert.equal(out.result.verdict, 'FAIL', `${code}: ${JSON.stringify(out.result.errors)}`);
    assert.equal(out.exitCode, 1);
    assert.ok(codes(out).includes('VITEST_EXIT_NONZERO'));
    assert.equal(out.result.processExit.code, code);
    assert.equal(out.result.reporterParsed, true);
  }
  const notSuccess = withSuites(root, [A], (r) => { r.success = false; });
  const ns = await nonZero(root, [A], notSuccess);
  assert.equal(ns.result.verdict, 'FAIL');
  const zeroExecuted = withSuites(root, [A], (r) => {
    r.numTotalTests = 0;
    r.numPassedTests = 0;
    r.testResults[0].assertionResults = [];
  });
  const ze = await nonZero(root, [A], zeroExecuted);
  assert.equal(ze.result.verdict, 'FAIL');
  assert.ok(codes(ze).includes('VITEST_EXIT_NONZERO'));
});

// Returns the outcome object VERBATIM (unlike fakeRun, whose `code = 0` default would turn undefined into a real exit 0).
const verbatimRun = (outcome, report) => {
  const calls = [];
  const run = async (call) => {
    calls.push(call);
    writeFileSync(call.markerPath, '');
    if (report !== undefined) writeFileSync(call.reportPath, JSON.stringify(report));
    return { signal: null, timedOut: false, spawnError: null, stdout: '', stderr: '', ...outcome };
  };
  run.calls = calls;
  return run;
};

test('[P0L-E07][P0L-E08][P0L-E21][P0L-E22][P0L-E24][P0L-E26] without a numeric exit status Vitest did not establish an outcome: BLOCKED NO_EXIT_STATUS', async () => {
  const root = mkFixture();
  const good = reportFor(root, [A]);
  for (const code of [null, '1', '0', Number.NaN, 1.5, Infinity, -0.5, false, true, 0n, new Number(0), 2 ** 60, {}, []]) {
    const out = await go(root, [A], { run: verbatimRun({ code }, good) });
    blockedWith(out, 'NO_EXIT_STATUS');
  }
  const noKey = await go(root, [A], { run: verbatimRun({}, good) }); // property absent entirely
  blockedWith(noKey, 'NO_EXIT_STATUS');
  const explicitUndefined = await go(root, [A], { run: verbatimRun({ code: undefined }, good) });
  blockedWith(explicitUndefined, 'NO_EXIT_STATUS');
});

test('[P0L-E23][P0L-E25] a negative non-zero safe integer is a numeric failure exit; -0 is numerically zero', async () => {
  const root = mkFixture();
  const good = reportFor(root, [A]);
  const neg = await go(root, [A], { run: verbatimRun({ code: -1 }, good) });
  assert.equal(neg.result.verdict, 'FAIL');
  assert.ok(codes(neg).includes('VITEST_EXIT_NONZERO'));
  const negZero = await go(root, [A], { run: verbatimRun({ code: -0 }, good) });
  assert.equal(negZero.result.verdict, 'PASS', JSON.stringify(negZero.result.errors));
});

test('[P0L-E14][P0L-E15][P0L-E16] abnormal termination or missing isolation stays BLOCKED even with a valid report present', async () => {
  const root = mkFixture();
  const negative = withSuites(root, [A], (r) => {
    r.numPassedTests = 0;
    r.numFailedTests = 1;
    r.success = false;
    r.testResults[0].status = 'failed';
    r.testResults[0].assertionResults = [{ status: 'failed' }];
    r.numPassedTestSuites = 0;
    r.numFailedTestSuites = 1;
  });
  blockedWith(await goReport(root, [A], negative, { code: null, signal: 'SIGSEGV' }), 'KILLED_BY_SIGNAL');
  blockedWith(await goReport(root, [A], reportFor(root, [A]), { code: null, timedOut: true }), 'TIMEOUT');
  blockedWith(await goReport(root, [A], reportFor(root, [A]), { marker: false, code: 1 }), 'ISOLATION_NOT_ESTABLISHED');
  blockedWith(await goReport(root, [A], reportFor(root, [A]), { spawnError: 'ENOENT' }), 'SPAWN_FAILED');
});


// ======================================================= TOOLING-P0O tests (TypeScript resolver provenance)

function stubTypescript(dir, { version = '5.9.3', name = 'typescript', pkg = 'ok', lib = 'ok', marker = 'LOCAL' } = {}) {
  mkdirSync(path.join(dir, 'lib'), { recursive: true });
  if (pkg === 'ok') writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version }));
  else if (pkg === 'malformed') writeFileSync(path.join(dir, 'package.json'), '{not json');
  if (lib === 'ok') writeFileSync(path.join(dir, 'lib', 'typescript.js'), `module.exports = { transpileModule() {}, __marker: ${JSON.stringify(marker)}, __file: __filename };\n`);
  else if (lib === 'noTranspile') writeFileSync(path.join(dir, 'lib', 'typescript.js'), `module.exports = { __marker: ${JSON.stringify(marker)} };\n`);
}

// A throwaway "repo" (path deliberately contains a space) with a pinned api/package.json.
function mkTsRepo({ pin = '5.9.3', local = {} } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), 'ts resolver '));
  created.push(base);
  const root = path.join(base, 'repo');
  mkdirSync(path.join(root, 'api'), { recursive: true });
  if (pin !== null) writeFileSync(path.join(root, 'api', 'package.json'), JSON.stringify({ devDependencies: { typescript: pin } }));
  if (local !== null) stubTypescript(path.join(root, 'api', 'node_modules', 'typescript'), local);
  return { base, root, localDir: path.join(root, 'api', 'node_modules', 'typescript') };
}
const extTs = (marker = 'EXTERNAL', opts = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ts external '));
  created.push(dir);
  stubTypescript(path.join(dir, 'typescript'), { marker, ...opts });
  return path.join(dir, 'typescript');
};
const resolveIn = (root, env = {}) => resolveTestTypescript({ env, repoRoot: root });
const unavailable = (r, what) => {
  assert.equal(r.source, 'UNAVAILABLE', what);
  assert.equal(r.ts, null, what);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, `${what}: a precise reason is required`);
};

test('[P0O-T01][P0O-T21] env unset + a valid repo-local pinned TypeScript is resolved as LOCAL (path with a space)', () => {
  const { root, localDir } = mkTsRepo();
  const r = resolveIn(root);
  assert.equal(r.source, 'LOCAL');
  assert.equal(r.version, '5.9.3');
  assert.equal(r.path, realpathSync(localDir));
  assert.equal(r.ts.__marker, 'LOCAL');
  assert.ok(root.includes(' '));
});

test('[P0O-T02][P0O-T03][P0O-T04][P0O-T05][P0O-T06][P0O-T18][P0O-T19] a missing, wrong-version, malformed or incomplete repo-local package is UNAVAILABLE (never borrows another)', () => {
  for (const [what, local] of [
    ['absent', null],
    ['wrong version', { version: '5.8.0' }],
    ['malformed package.json', { pkg: 'malformed' }],
    ['missing package.json', { pkg: 'missing' }],
    ['missing lib', { lib: 'missing' }],
    ['no transpileModule', { lib: 'noTranspile' }],
    ['wrong package name', { name: 'not-typescript' }],
  ]) {
    const { root } = mkTsRepo({ local });
    unavailable(resolveIn(root), what);
  }
});

test('[P0O-T07][P0O-T08] a repo-local typescript (or api/node_modules) that is a symlink to elsewhere fails provenance', () => {
  const external = extTs('EXTERNAL');
  const a = mkTsRepo({ local: null });
  mkdirSync(path.join(a.root, 'api', 'node_modules'), { recursive: true });
  symlinkSync(external, a.localDir);
  unavailable(resolveIn(a.root), 'typescript symlink');

  const b = mkTsRepo({ local: null });
  symlinkSync(path.dirname(external), path.join(b.root, 'api', 'node_modules'));
  unavailable(resolveIn(b.root), 'api/node_modules symlink');
});

test('[P0O-T09][P0O-T10] NODE_PATH and ancestor/root node_modules are never searched', async () => {
  const external = extTs('EXTERNAL');
  const { base, root } = mkTsRepo({ local: null });
  stubTypescript(path.join(root, 'node_modules', 'typescript'), { marker: 'ROOT' });
  stubTypescript(path.join(base, 'node_modules', 'typescript'), { marker: 'PARENT' });
  unavailable(resolveIn(root, { NODE_PATH: path.dirname(external) }), 'env-object NODE_PATH, root and parent installs');
  await withEnv({ NODE_PATH: path.dirname(external) }, () => unavailable(resolveTestTypescript({ repoRoot: root }), 'process.env NODE_PATH'));
});

test('[P0O-T11] with the valid local package and external installs all present, the LOCAL one is used', async () => {
  const external = extTs('EXTERNAL');
  const { base, root, localDir } = mkTsRepo();
  stubTypescript(path.join(root, 'node_modules', 'typescript'), { marker: 'ROOT' });
  stubTypescript(path.join(base, 'node_modules', 'typescript'), { marker: 'PARENT' });
  await withEnv({ NODE_PATH: path.dirname(external) }, () => {
    const r = resolveTestTypescript({ env: { NODE_PATH: path.dirname(external) }, repoRoot: root });
    assert.equal(r.source, 'LOCAL');
    assert.equal(r.ts.__marker, 'LOCAL');
    assert.equal(r.path, realpathSync(localDir));
  });
});

test('[P0O-T12][P0O-T17] a valid explicit override wins over the local package, including with trailing slash and ".." segments', () => {
  const { root } = mkTsRepo();
  const external = extTs('EXPLICIT');
  for (const spelled of [external, `${external}/`, `${external}/../typescript`, `${path.dirname(external)}//typescript`]) {
    const r = resolveIn(root, { TOOLING_TEST_TYPESCRIPT_DIR: spelled });
    assert.equal(r.source, 'EXPLICIT_OVERRIDE', spelled);
    assert.equal(r.ts.__marker, 'EXPLICIT', spelled);
    assert.equal(r.version, '5.9.3');
    assert.equal(r.path, realpathSync(external));
  }
});

test('[P0O-T13][P0O-T14][P0O-T15][P0O-T16] an invalid explicit override is UNAVAILABLE and NEVER falls back to the valid local package', () => {
  const { root } = mkTsRepo();
  const wrongVersion = extTs('EXPLICIT', { version: '6.0.3' });
  for (const [what, value] of [
    ['nonexistent', path.join(tmpdir(), 'no-such-typescript-dir-p0o')],
    ['wrong version', wrongVersion],
    ['empty', ''],
    ['whitespace', '   '],
    ['relative', './api/node_modules/typescript'],
    ['relative bare', 'typescript'],
  ]) {
    unavailable(resolveIn(root, { TOOLING_TEST_TYPESCRIPT_DIR: value }), what);
  }
});

test('[P0O-T20] the expected version is the exact pin read from api/package.json', () => {
  const bumped = mkTsRepo({ pin: '5.10.0', local: { version: '5.10.0' } });
  assert.equal(resolveIn(bumped.root).source, 'LOCAL');
  const mismatch = mkTsRepo({ pin: '5.10.0', local: { version: '5.9.3' } });
  unavailable(resolveIn(mismatch.root), 'local older than the pin');
  unavailable(resolveIn(mkTsRepo({ pin: null }).root), 'api/package.json missing');
  unavailable(resolveIn(mkTsRepo({ pin: '^5.9.3' }).root), 'range pin');
  unavailable(resolveIn(mkTsRepo({ pin: '~5.9.3' }).root), 'tilde pin');
});

test('[P0O-T22] the REAL checkout: env unset resolves THIS worktree\'s api/node_modules/typescript 5.9.3 (provenance for Gate A)', (t) => {
  const localPkg = path.join(REAL_REPO_ROOT, 'api', 'node_modules', 'typescript', 'package.json');
  const r = resolveTestTypescript({ env: {}, repoRoot: REAL_REPO_ROOT });
  t.diagnostic(`TypeScript source=${r.source} path=${r.path} version=${r.version} reason=${r.reason}`);
  if (!existsSync(localPkg)) {
    unavailable(r, 'local package not installed');
    return;
  }
  assert.equal(r.source, 'LOCAL', r.reason);
  assert.equal(r.version, '5.9.3');
  assert.equal(r.path, realpathSync(path.join(REAL_REPO_ROOT, 'api', 'node_modules', 'typescript')));
  assert.ok(r.path.startsWith(realpathSync(path.join(REAL_REPO_ROOT, 'api', 'node_modules')) + path.sep));
  // and the harness-wide resolution used by every tsTest in THIS run is consistent with the environment
  if (process.env.TOOLING_TEST_TYPESCRIPT_DIR === undefined) {
    assert.equal(RESOLVED_TS.source, 'LOCAL');
    assert.equal(RESOLVED_TS.path, r.path);
  } else {
    assert.equal(RESOLVED_TS.source === 'EXPLICIT_OVERRIDE' || RESOLVED_TS.source === 'UNAVAILABLE', true);
  }
});


// ======================================================= TOOLING-P0Q tests (consumed-file provenance)

const relink = (target, linkPath) => {
  rmSync(linkPath, { recursive: true, force: true });
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath);
};
const entryOf = (pkgDir) => path.join(pkgDir, 'lib', 'typescript.js');
const metaOf = (pkgDir) => path.join(pkgDir, 'package.json');
const okLocal = (r, what) => {
  assert.equal(r.source, 'LOCAL', `${what}: ${r.reason}`);
  assert.ok(r.ts && typeof r.ts.transpileModule === 'function', what);
};

test('[P0Q-CX01][P0Q-CX02][P0Q-CX03][P0Q-CX04][P0Q-CX06] LOCAL: an entry or manifest that resolves outside the selected TypeScript package is UNAVAILABLE', () => {
  const ext = extTs('EXTERNAL');
  // CX01 entry symlink outside
  let r = mkTsRepo();
  relink(entryOf(ext), entryOf(r.localDir));
  unavailable(resolveIn(r.root), 'CX01');
  // CX02 lib directory symlink outside
  r = mkTsRepo();
  relink(path.join(ext, 'lib'), path.join(r.localDir, 'lib'));
  unavailable(resolveIn(r.root), 'CX02');
  // CX03 chain: entry -> lib/hop1.js (inside) -> external
  r = mkTsRepo();
  relink(entryOf(ext), path.join(r.localDir, 'lib', 'hop1.js'));
  relink('hop1.js', entryOf(r.localDir));
  unavailable(resolveIn(r.root), 'CX03');
  // CX04 package.json symlink outside
  r = mkTsRepo();
  relink(metaOf(ext), metaOf(r.localDir));
  unavailable(resolveIn(r.root), 'CX04');
  // CX06 entry -> another package under the repo-root node_modules
  r = mkTsRepo();
  stubTypescript(path.join(r.root, 'node_modules', 'typescript'), { marker: 'ROOT' });
  relink(entryOf(path.join(r.root, 'node_modules', 'typescript')), entryOf(r.localDir));
  unavailable(resolveIn(r.root), 'CX06');
});

test('[P0Q-CX05][P0Q-I03][P0Q-I05][P0Q-I14] the exact pin must come from api/package.json inside the API boundary (both modes)', () => {
  // CX05 pin file symlink to an external file
  const extDir = mkdtempSync(path.join(tmpdir(), 'pin external '));
  created.push(extDir);
  writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ devDependencies: { typescript: '5.9.3' } }));
  let r = mkTsRepo();
  relink(path.join(extDir, 'package.json'), path.join(r.root, 'api', 'package.json'));
  unavailable(resolveIn(r.root), 'CX05');
  // I03 prefix-like sibling api2
  r = mkTsRepo();
  mkdirSync(path.join(r.root, 'api2'));
  writeFileSync(path.join(r.root, 'api2', 'package.json'), JSON.stringify({ devDependencies: { typescript: '5.9.3' } }));
  relink(path.join(r.root, 'api2', 'package.json'), path.join(r.root, 'api', 'package.json'));
  unavailable(resolveIn(r.root), 'I03');
  // I05 api/ itself is a symlink to another directory inside the repo
  r = mkTsRepo();
  renameSync(path.join(r.root, 'api'), path.join(r.root, 'apiReal'));
  symlinkSync('apiReal', path.join(r.root, 'api'));
  unavailable(resolveIn(r.root), 'I05');
  // I14 explicit package is valid but the pin file escapes: still UNAVAILABLE
  r = mkTsRepo();
  relink(path.join(extDir, 'package.json'), path.join(r.root, 'api', 'package.json'));
  unavailable(resolveIn(r.root, { TOOLING_TEST_TYPESCRIPT_DIR: extTs('EXPLICIT') }), 'I14');
});

test('[P0Q-I04][P0Q-I06][P0Q-I16] a valid INTERNAL pin symlink, a symlinked repoRoot path and a repoRoot with ".." segments are LOCAL', () => {
  let r = mkTsRepo();
  renameSync(path.join(r.root, 'api', 'package.json'), path.join(r.root, 'api', 'package.real.json'));
  symlinkSync('package.real.json', path.join(r.root, 'api', 'package.json'));
  okLocal(resolveIn(r.root), 'I04');

  r = mkTsRepo();
  const viaLink = path.join(r.base, 'repo-link');
  symlinkSync(r.root, viaLink);
  const res = resolveIn(viaLink);
  okLocal(res, 'I06');
  assert.equal(res.path, realpathSync(r.localDir));

  r = mkTsRepo();
  mkdirSync(path.join(r.base, 'sub'));
  okLocal(resolveIn(path.join(r.base, 'sub', '..', 'repo')), 'I16');
});

test('[P0Q-CX09][P0Q-I07][P0Q-I15][P0Q-I18] LOCAL: symlinks that stay inside the TypeScript package are accepted and the CANONICAL file is the one loaded', () => {
  // CX09 entry -> lib/real.js (inside)
  let r = mkTsRepo();
  writeFileSync(path.join(r.localDir, 'lib', 'real.js'), 'module.exports = { transpileModule() {}, __marker: "LOCAL-REAL", __file: __filename };\n');
  relink('real.js', entryOf(r.localDir));
  let res = resolveIn(r.root);
  okLocal(res, 'CX09');
  assert.equal(res.ts.__marker, 'LOCAL-REAL');
  assert.equal(res.ts.__file, realpathSync(path.join(r.localDir, 'lib', 'real.js')), 'I18: the module that ran is the canonical validated file');
  assert.equal(res.entry, realpathSync(path.join(r.localDir, 'lib', 'real.js')));

  // I07 lib -> libReal (internal directory symlink)
  r = mkTsRepo();
  renameSync(path.join(r.localDir, 'lib'), path.join(r.localDir, 'libReal'));
  symlinkSync('libReal', path.join(r.localDir, 'lib'));
  okLocal(resolveIn(r.root), 'I07');

  // I15 package.json is a 2-hop internal chain
  r = mkTsRepo();
  renameSync(metaOf(r.localDir), path.join(r.localDir, 'meta.real.json'));
  symlinkSync('meta.real.json', path.join(r.localDir, 'meta.hop.json'));
  symlinkSync('meta.hop.json', metaOf(r.localDir));
  res = resolveIn(r.root);
  okLocal(res, 'I15');
  assert.equal(res.metadata, realpathSync(path.join(r.localDir, 'meta.real.json')));
});

test('[P0Q-I01][P0Q-I02][P0Q-I08] path containment is component-aware: prefix-like siblings and other installed packages are outside', () => {
  // I01 entry -> typescript2 (prefix-like sibling), I02 package.json -> typescript-extra, I08 entry -> vitest package
  let r = mkTsRepo();
  const nm = path.join(r.root, 'api', 'node_modules');
  stubTypescript(path.join(nm, 'typescript2'), { marker: 'SIBLING' });
  relink(entryOf(path.join(nm, 'typescript2')), entryOf(r.localDir));
  unavailable(resolveIn(r.root), 'I01');

  r = mkTsRepo();
  stubTypescript(path.join(r.root, 'api', 'node_modules', 'typescript-extra'), { marker: 'EXTRA' });
  relink(metaOf(path.join(r.root, 'api', 'node_modules', 'typescript-extra')), metaOf(r.localDir));
  unavailable(resolveIn(r.root), 'I02');

  r = mkTsRepo();
  stubTypescript(path.join(r.root, 'api', 'node_modules', 'vitest'), { marker: 'VITEST', name: 'vitest' });
  relink(entryOf(path.join(r.root, 'api', 'node_modules', 'vitest')), entryOf(r.localDir));
  unavailable(resolveIn(r.root), 'I08');
});

test('[P0Q-I09][P0Q-I10][P0Q-I17] an entry that is a directory, dangling, a symlink loop, or a lib that is a file is UNAVAILABLE', () => {
  let r = mkTsRepo();
  rmSync(entryOf(r.localDir));
  mkdirSync(entryOf(r.localDir));
  unavailable(resolveIn(r.root), 'I09 directory entry');

  r = mkTsRepo();
  relink(path.join(r.base, 'does-not-exist.js'), entryOf(r.localDir));
  unavailable(resolveIn(r.root), 'I10 dangling');

  r = mkTsRepo();
  rmSync(entryOf(r.localDir));
  symlinkSync('loop-b.js', entryOf(r.localDir));
  symlinkSync('typescript.js', path.join(r.localDir, 'lib', 'loop-b.js'));
  unavailable(resolveIn(r.root), 'I10 loop');

  r = mkTsRepo();
  rmSync(path.join(r.localDir, 'lib'), { recursive: true });
  writeFileSync(path.join(r.localDir, 'lib'), 'not a directory');
  unavailable(resolveIn(r.root), 'I17 lib is a file');
});

test('[P0Q-CX07][P0Q-CX08][P0Q-CX10][P0Q-I11][P0Q-I12][P0Q-I13][P0Q-I19] EXPLICIT: the selected canonical package root is the boundary for its own metadata and entry; invalid overrides never fall back', () => {
  const { root } = mkTsRepo(); // a perfectly valid LOCAL package exists in every case
  const other = extTs('OTHER');
  const env = (dir) => ({ TOOLING_TEST_TYPESCRIPT_DIR: dir });

  // CX07 / I19 entry escapes
  let ext = extTs('EXPLICIT');
  relink(entryOf(other), entryOf(ext));
  unavailable(resolveIn(root, env(ext)), 'CX07/I19');
  // CX08 package.json escapes
  ext = extTs('EXPLICIT');
  relink(metaOf(other), metaOf(ext));
  unavailable(resolveIn(root, env(ext)), 'CX08');
  // CX10 entry symlink staying inside
  ext = extTs('EXPLICIT');
  writeFileSync(path.join(ext, 'lib', 'inner.js'), 'module.exports = { transpileModule() {}, __marker: "EXPLICIT-INNER", __file: __filename };\n');
  relink('inner.js', entryOf(ext));
  let res = resolveIn(root, env(ext));
  assert.equal(res.source, 'EXPLICIT_OVERRIDE', res.reason);
  assert.equal(res.ts.__marker, 'EXPLICIT-INNER');
  // I11 root given through a symlink: canonical root reported
  ext = extTs('EXPLICIT');
  const viaLink = path.join(path.dirname(ext), 'ts-link');
  symlinkSync(ext, viaLink);
  res = resolveIn(root, env(viaLink));
  assert.equal(res.source, 'EXPLICIT_OVERRIDE', res.reason);
  assert.equal(res.path, realpathSync(ext));
  // I12 root via symlink, entry escapes the CANONICAL root
  ext = extTs('EXPLICIT');
  const via2 = path.join(path.dirname(ext), 'ts-link2');
  symlinkSync(ext, via2);
  relink(entryOf(other), entryOf(ext));
  unavailable(resolveIn(root, env(via2)), 'I12');
  // I13 package.json -> prefix-like sibling of the selected root
  ext = extTs('EXPLICIT');
  stubTypescript(`${ext}-extra`, { marker: 'EXTRA' });
  created.push(`${ext}-extra`);
  relink(metaOf(`${ext}-extra`), metaOf(ext));
  unavailable(resolveIn(root, env(ext)), 'I13');
});
