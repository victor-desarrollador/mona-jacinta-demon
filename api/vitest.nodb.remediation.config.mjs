// Compatibility shim: the original config hardcoded another worktree's absolute
// path. The canonical DB-free config is vitest.nodb.config.mjs; run it through
// scripts/dev/safe-nodb-run.mjs (sanitized env + network namespace) rather than
// invoking Vitest directly with either file.
export { default } from './vitest.nodb.config.mjs';
