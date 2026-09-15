// Phase 1B (Production V1) RBAC module: typed role/permission/scope
// definitions from docs/production-v1/03-role-permission-matrix.md and
// 05-architecture.md §5, plus an additive Production catalog bootstrap.
//   - typed Production role codes (roles.ts) and permission codes
//     (permissions.ts)
//   - deterministic default role -> permission grants (role-permission-matrix.ts)
//   - a scope-consistency domain helper mirroring the DB CHECK (scope.ts)
//   - additive Role/Permission/RolePermission catalog bootstrap
//     (catalog.service.ts) — creates the 5 Production roles and 33
//     permissions if absent, and persists their default grants; never
//     touches legacy `MANAGER`, legacy lowercase Permission codes, or any
//     `UserBranchRole` row
//   - Phase 1C: explicit legacy role mapping (legacy-role-map.ts) and the
//     UserRoleScope backfill/verify pair (scope-backfill.service.ts) —
//     reads UserBranchRole, never mutates it
// Explicitly NOT in this module (deferred to Phase 1D, per
// docs/production-v1/08-implementation-roadmap.md):
//   - no requirePermission-style middleware or route wiring
//   - no switch of application reads/writes from UserBranchRole to UserRoleScope
export * from './roles.js';
export * from './permissions.js';
export * from './role-permission-matrix.js';
export * from './scope.js';
export * from './catalog.service.js';
export * from './legacy-role-map.js';
export * from './scope-backfill.service.js';
export * from './scope-resolver.js';
export * from './effective-branch-ids.js';
export * from './authorization-context.js';
