# Mona Jacinta — Security Guidance

## Authorization authority

- `UserRoleScope` is the authoritative source for effective location authorization.
- Never fall back to `UserBranchRole` for location authorization.
- An empty `UserRoleScope` means zero authorized locations.
- `UserBranchRole` is legacy compatibility state only and must not become a second source of location authority.

## Production roles

The only Production V1 roles are:

- OWNER
- ADMIN
- CASHIER
- SELLER
- WAREHOUSE

`MANAGER` is legacy only and maps explicitly to `WAREHOUSE`.

Never infer a Production role heuristically from a legacy role.

## Scope security

- LOCATION-scoped users may act only on explicitly authorized locations.
- Never trust branch/location IDs supplied by the client without server-side authorization.
- Resource authorization must use the persisted resource location where applicable.
- Authorization must use current database state, not authorization claims embedded in old JWTs.
- COMPANY scope must fail closed until the approved Phase 1D implementation explicitly enables it.

## Privilege boundaries

- OWNER has full COMPANY authority.
- ADMIN may operate across all branches and the central warehouse.
- ADMIN must never be able to escalate itself or another user to OWNER.
- OWNER-only sensitive operations must remain inaccessible to ADMIN.
- CASHIER, SELLER, and WAREHOUSE must never self-assign locations or broaden their own scopes.

## Assignment

- Employee location reassignment changes `UserRoleScope`, not role identity.
- Only OWNER or ADMIN may assign/reassign employee location scopes.
- Scope revocation must take effect from current persisted authorization state.

## Database safety

- Destructive integration testing is TEST-only.
- Never reset, backfill, truncate, or destructively mutate DEV without explicit human approval.
- Never expose database credentials, JWT secrets, or other secrets.
- Never rewrite an already-applied migration.

## General

- Prefer fail-closed authorization behavior.
- Do not introduce role-name bypasses around permission checks.
- Do not create multiple competing authorization sources.
- Treat authorization and scope inconsistencies as security defects.
