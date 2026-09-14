# CLAUDE.md

Claude-Code-specific operating instructions for this repository. Does not
duplicate `AGENTS.md` (the tool-agnostic project constitution) — read that
first for architecture, roles, and business rules.

## Startup reading order (non-trivial work)

1. `CLAUDE.md` (this file)
2. `AGENTS.md`
3. `docs/production-v1/00-master-index.md`
4. whichever `docs/production-v1/*` docs are relevant to the task
5. current `git status`/`git diff`
6. the relevant implementation area

Skip straight to implementation only for genuinely trivial, mechanical
edits.

## Ground rules

- The repository (code + git history) is the source of truth. Memory tools
  and prior-session context are orientation only — verify against the
  repository before acting on them.
- Do not assume old Demo V2 plans are current; `AGENTS.md`'s History section
  and `docs/production-v1/*` supersede them.
- Never touch the DEV database without explicit human approval in the
  current conversation.
- Never modify an already-applied Prisma migration.
- Do not casually modify `docs/production-v1/*` — it's frozen. If code and
  requirements disagree, raise it; don't silently edit the doc to match code.
- Do not commit or push unless explicitly requested for that change.
- Never reset, revert, or delete user work without confirming first.
- Never run another editing agent concurrently on this same working tree.

## Using Superpowers

Invoke deliberately, matched to the task:

- **Defects** → `systematic-debugging` (root cause before any fix).
- **Behavior changes** → `test-driven-development`.
- **Before declaring anything done** → `verification-before-completion` and
  a full diff/code review.

Do not invoke a heavyweight process for a trivial mechanical edit (renames,
comment fixes, doc typos) — use judgment.

## Testing policy

Run focused tests first, always:

```bash
cd api
NODE_ENV=test npx vitest run tests/<relevant-file>.test.ts --reporter=verbose
```

Static gates when appropriate:

```bash
npm run lint
npx tsc --noEmit
npm run build
git diff --check
```

Full suite (only at the final gate, never during exploration):

```bash
NODE_ENV=test npx vitest run --reporter=verbose
```

**The integration suite is deliberately slow** — it runs against hosted
Supabase TEST over the network (~100ms/round-trip), not a local database.
At checkpoint `7d0c2b6`: 37 files, 310 tests, ~3521s (~58m41s). A `vitest run`
with the default reporter piped to a log can look hung for many minutes
while genuinely still running — that is expected, not a bug. Use
`--reporter=verbose` whenever you need visible progress.

Consequence: never run the full suite during exploratory work. Run it only
once focused gates and diff review indicate the change is ready.

## Known deferred technical debt

Pre-existing, not automatic scope for unrelated tasks — only address if the
current task specifically concerns one of these:

- `createTestPrismaClient()` (`api/tests/helpers/test-db.ts`) creates a
  `pg.Pool` per test file but returns only the `PrismaClient`, so callers can
  never call `pool.end()`.
- A `pg` deprecation warning fires for concurrent `client.query()` calls on
  the same client during some integration tests.
- Socket.IO authorization scope is a connection-time snapshot and only
  updates on reconnect.
- `backoffice/users` still has some legacy `UserBranchRole`-derived
  presentation behavior.
