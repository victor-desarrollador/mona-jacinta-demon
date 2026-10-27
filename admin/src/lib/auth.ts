import type { UserContext } from './api';

export const TOKEN_KEY = 'mona-jacinta-admin-token';

export function readStoredToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string | null) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable: the session just won't survive a reload
  }
}

export function canUseBackoffice(user: UserContext | null) {
  return Boolean(user?.permissions.includes('report.view'));
}

export function canManageUsers(user: UserContext | null) {
  return Boolean(user?.permissions.includes('user.manage'));
}

// D3: Production codes projected verbatim by /auth/me. UX gating only —
// the backend re-checks every write (COMPANY scope, location pairing).
// UX gating only: the external refund is a supervisor action (OWNER or COMPANY ADMIN) and
// /auth/me projects where the caller is one. Absent hint => hidden; the backend decides.
export function canRefundExternalCollection(user: UserContext | null, branchId: string) {
  return Boolean(user?.cashSupervisorLocationIds?.includes(branchId));
}

export function canCreateProducts(user: UserContext | null) {
  return Boolean(user?.permissions.includes('PRODUCT_MANAGE'));
}

export function canCreateVariants(user: UserContext | null) {
  return Boolean(user?.permissions.includes('PRODUCT_VARIANT_MANAGE'));
}

export function canManagePrices(user: UserContext | null) {
  return Boolean(user?.permissions.includes('PRICE_MANAGE'));
}

export function canLoadInitialStock(user: UserContext | null) {
  return Boolean(user?.permissions.includes('IMPORT_RUN'));
}
