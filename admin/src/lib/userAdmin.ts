import { useRef } from 'react';
import { ApiError, type BackofficeUser, type UserContext } from './api';

// USER-MGMT-01 U5 — UX helpers for the Users screen. NOTHING here is authorization: it only hides what the backend would refuse (policy of
// api/src/modules/backoffice/user-admin-policy.ts). The backend stays the authority, and a refusal is shown with its own message.

export const CREATABLE_BY_OWNER = ['OWNER', 'ADMIN', 'CASHIER', 'SELLER', 'WAREHOUSE'] as const;
export const CREATABLE_BY_ADMIN = ['CASHIER', 'SELLER', 'WAREHOUSE'] as const;
export const COMPANY_ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN']);

export const isOwnerActor = (actor: UserContext | null) => Boolean(actor?.roles.includes('OWNER'));
export const creatableRoles = (actor: UserContext | null): readonly string[] => (isOwnerActor(actor) ? CREATABLE_BY_OWNER : CREATABLE_BY_ADMIN);

// An account that holds ANY OWNER/ADMIN assignment is privileged (the backend reads the real scope rows, whatever their kind).
export const isPrivilegedRow = (row: BackofficeUser) => row.assignments.some((a) => a.roleCode === 'OWNER' || a.roleCode === 'ADMIN');

export type RowAction = 'edit' | 'access' | 'deactivate' | 'reactivate' | 'reset';
export function rowActions(actor: UserContext | null, row: BackofficeUser): RowAction[] {
  if (!actor || row.id === actor.id) return []; // nobody administers themselves here (change-password is the self path)
  if (!isOwnerActor(actor) && isPrivilegedRow(row)) return []; // an ADMIN never touches an OWNER/ADMIN
  // 'access' (role / scope management) also applies to an inactive account: the backend allows preparing its scopes before a reactivation
  return row.isActive ? ['edit', 'access', 'deactivate', 'reset'] : ['edit', 'access', 'reactivate'];
}

// The text shown for a failed administrative call: the backend's own Spanish message (already safe), except where it must not be trusted to be
// user-facing (a 5xx) or where the session itself is the problem.
export function adminErrorMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return 'Tu sesión expiró. Volvé a ingresar.';
    if (cause.status >= 500) return 'Ocurrió un error en el servidor. Intentá nuevamente.';
    return cause.message;
  }
  return 'No se pudo completar la operación. Revisá la conexión e intentá nuevamente.';
}

export const newIdempotencyKey = (): string => crypto.randomUUID();

// One idempotency key per CONSCIOUS intent. The same key is reused while the same intent is retried (same signature); a different signature — the
// user changed the request — or an explicit reset (the intent was finished or abandoned) takes a new one. It is never renewed automatically after a
// timeout: an ambiguous outcome is retried with the SAME key, so the server answers a replay instead of repeating the effect.
export function useIntentKey() {
  const current = useRef<{ signature: string; key: string } | null>(null);
  return {
    keyFor(signature: string): string {
      if (current.current?.signature !== signature) current.current = { signature, key: newIdempotencyKey() };
      return current.current.key;
    },
    reset() {
      current.current = null;
    },
  };
}

// ---- role / scope management (U5.1) ---------------------------------------------------------------------------------------------------------------
// The account's accesses grouped by role: GET /backoffice/users returns ONE entry per scope row, so a LOCATION role held at two sedes is two entries.
export type RoleAccess = { roleCode: string; scopeKind: 'COMPANY' | 'LOCATION'; locations: Array<{ id: string; name: string; code: string }> };

export function groupAccesses(assignments: BackofficeUser['assignments']): RoleAccess[] {
  const byRole = new Map<string, RoleAccess>();
  for (const a of assignments) {
    const entry = byRole.get(a.roleCode) ?? { roleCode: a.roleCode, scopeKind: a.scopeKind, locations: [] };
    if (a.location) entry.locations.push(a.location);
    byRole.set(a.roleCode, entry);
  }
  return [...byRole.values()].sort((x, y) => x.roleCode.localeCompare(y.roleCode));
}

// One access as the person reads it, e.g. "Vendedor — Mona Centro, Mona Yerba" / "Administrador — Toda la empresa".
export function accessLabel(access: RoleAccess, roleName: (code: string) => string): string {
  const where = access.scopeKind === 'COMPANY' ? 'Toda la empresa' : access.locations.map((l) => l.name).join(', ') || 'Alcance inválido';
  return `${roleName(access.roleCode)} — ${where}`;
}

// The accesses the account would have AFTER one change, for the review step (the server result is re-read afterwards; this is never state).
export function projectAccesses(current: RoleAccess[], change: { kind: 'set'; access: RoleAccess } | { kind: 'remove'; roleCode: string }): RoleAccess[] {
  const rest = current.filter((a) => a.roleCode !== (change.kind === 'set' ? change.access.roleCode : change.roleCode));
  return (change.kind === 'set' ? [...rest, change.access] : rest).sort((x, y) => x.roleCode.localeCompare(y.roleCode));
}
