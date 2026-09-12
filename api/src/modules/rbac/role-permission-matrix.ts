import { PRODUCTION_PERMISSIONS, productionPermissionValues } from './permissions.js';
import { ROLE_CODES } from './roles.js';
import type { ProductionPermission } from './permissions.js';

const P = PRODUCTION_PERMISSIONS;

// Deterministic default grants transcribed exactly from the "Default granted
// to role" column of docs/production-v1/03-role-permission-matrix.md. This
// domain definition is the single source `catalog.service.ts` reads to
// persist `RolePermission` rows (Phase 1B: catalog only, never a
// `UserRoleScope` assignment — see index.ts).
// Every row where ADMIN is a "Default granted to role" value is included
// here, even where that permission is COMPANY-scope-only for ADMIN in
// practice; scope enforcement is a separate concern (permissions.ts'
// COMPANY_SCOPE_REQUIRED_FOR_ADMIN, enforced later by Phase 1D middleware).
export const DEFAULT_ROLE_GRANTS: Record<
  Exclude<(typeof ROLE_CODES)[keyof typeof ROLE_CODES], 'OWNER'>,
  readonly ProductionPermission[]
> = {
  [ROLE_CODES.SELLER]: [
    P.SALE_CREATE,
    P.SALE_VIEW,
    P.INVENTORY_VIEW,
    P.TRANSFER_REQUEST,
    P.TRANSFER_VIEW,
    P.SENA_CREATE,
  ],
  [ROLE_CODES.CASHIER]: [
    P.LABEL_PRINT,
    P.TRANSFER_RESOLVE,
    P.SENA_SETTLE,
    P.SALE_CHARGE,
    P.SALE_COMPLETE,
    P.SALE_VIEW,
    P.SALE_QUEUE_VIEW,
    P.INVENTORY_VIEW,
    P.CASH_SESSION_OPEN,
    P.CASH_SESSION_CLOSE,
    P.TRANSFER_REQUEST,
    P.TRANSFER_VIEW,
    P.TRANSFER_APPROVE,
    P.TRANSFER_DISPATCH,
    P.TRANSFER_RECEIVE,
    P.EXCHANGE_MANAGE,
    P.PUBLICATION_CHECKOUT,
    P.PUBLICATION_RETURN,
    P.SENA_CREATE,
  ],
  [ROLE_CODES.WAREHOUSE]: [
    P.GOODS_RECEIPT_MANAGE,
    P.LABEL_PRINT,
    P.TRANSFER_RESOLVE,
    P.INVENTORY_MANAGE,
    P.TRANSFER_REQUEST,
    P.TRANSFER_VIEW,
    P.TRANSFER_APPROVE,
    P.TRANSFER_PREPARE,
    P.TRANSFER_DISPATCH,
    P.TRANSFER_RECEIVE,
    P.PRODUCT_IMAGE_MANAGE,
  ],
  // ADMIN is granted every catalogued permission (docs/production-v1/03-role-permission-matrix.md
  // lists ADMIN in the "Default granted to role" column of all 33 rows).
  // "ADMIN role alone never implies global access" (05-architecture.md §5) —
  // the permission grant is unconditional; the required scope (LOCATION vs
  // COMPANY) is a separate, per-operation check layered on top, never
  // encoded as a narrower RolePermission grant.
  [ROLE_CODES.ADMIN]: productionPermissionValues,
};

// OWNER intentionally has no entry above: "OWNER is special: unrestricted/
// implicit; do not rely on RolePermission rows as the source of OWNER
// authority" (frozen instructions) and
// docs/production-v1/03-role-permission-matrix.md: "OWNER — Unrestricted
// access; all permissions granted implicitly." `ownerHasImplicitAuthority`
// exists only so callers cannot mistake "no grant list" for "no access" —
// it is domain policy documentation, not an enforcement mechanism (Phase 1D).
export const ownerHasImplicitAuthority = true as const;
