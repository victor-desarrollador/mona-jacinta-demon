import { createHash } from 'node:crypto';

// USER-MGMT-01 U2 — normalization and the canonical request hash of the administrative identity operations.
//
// The hash is the INTENT of an operation, the thing an idempotency key is bound to: the same (actor, key) with the same hash is a replay, with
// another hash it is a conflict. It is built from an explicit allow-list per operation (so a secret that reaches the payload can never enter
// it), from NORMALIZED values (so capitalisation / surrounding whitespace / location order do not change the intent) and serialized with a
// fixed key order. The idempotency key itself is not part of it.
export const USER_ADMIN_OPERATIONS = Object.freeze(['CREATE_USER', 'RESET_PASSWORD', 'DEACTIVATE_USER', 'REACTIVATE_USER'] as const);
export type UserAdminOperationName = (typeof USER_ADMIN_OPERATIONS)[number];

export const normalizeEmail = (value: string): string => value.trim().toLowerCase();
export const normalizeName = (value: string): string => value.trim();

export function canonicalRequestHash(operation: UserAdminOperationName, payload: Record<string, unknown>): string {
  let canonical: Record<string, unknown>;
  if (operation === 'CREATE_USER') {
    const locationIds = Array.isArray(payload.locationIds) ? [...new Set(payload.locationIds.map(String))].sort() : [];
    canonical = {
      operation,
      name: normalizeName(String(payload.name ?? '')),
      email: normalizeEmail(String(payload.email ?? '')),
      roleCode: String(payload.roleCode ?? ''),
      scopeKind: String(payload.scopeKind ?? ''),
      locationIds,
    };
  } else {
    canonical = { operation, targetUserId: payload.targetUserId === undefined ? null : String(payload.targetUserId) };
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
