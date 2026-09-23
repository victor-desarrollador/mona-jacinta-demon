import type { UserContext } from './api';

export function canUseBackoffice(user: UserContext | null) {
  return Boolean(user?.permissions.includes('report.view'));
}

export function canManageUsers(user: UserContext | null) {
  return Boolean(user?.permissions.includes('user.manage'));
}

// D3: Production codes projected verbatim by /auth/me. UX gating only —
// the backend re-checks every write (COMPANY scope, location pairing).
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
