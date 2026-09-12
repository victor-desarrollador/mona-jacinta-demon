// Phase 1B (Production V1) permission catalog, exactly as named in
// docs/production-v1/03-role-permission-matrix.md. Distinct from the Demo V2
// lowercase dot-separated codes in ../../shared/permissions.ts (e.g.
// `sale.create`) — that module remains the authorization source for existing
// Demo V2 routes/middleware until Phase 1C/1D switch reads. These constants
// are domain definitions only; Phase 1B does not seed or migrate `Permission`
// rows, and no requirePermission-style middleware consumes them yet (that is
// Phase 1D).
export const PRODUCTION_PERMISSIONS = {
  PRICE_MANAGE: 'PRICE_MANAGE',
  GOODS_RECEIPT_MANAGE: 'GOODS_RECEIPT_MANAGE',
  PRODUCT_MANAGE: 'PRODUCT_MANAGE',
  PRODUCT_VARIANT_MANAGE: 'PRODUCT_VARIANT_MANAGE',
  LABEL_PRINT: 'LABEL_PRINT',
  IMPORT_RUN: 'IMPORT_RUN',
  TRANSFER_RESOLVE: 'TRANSFER_RESOLVE',
  SENA_SETTLE: 'SENA_SETTLE',
  SALE_CREATE: 'SALE_CREATE',
  SALE_CHARGE: 'SALE_CHARGE',
  SALE_COMPLETE: 'SALE_COMPLETE',
  SALE_VIEW: 'SALE_VIEW',
  SALE_QUEUE_VIEW: 'SALE_QUEUE_VIEW',
  INVENTORY_VIEW: 'INVENTORY_VIEW',
  INVENTORY_MANAGE: 'INVENTORY_MANAGE',
  CASH_SESSION_OPEN: 'CASH_SESSION_OPEN',
  CASH_SESSION_CLOSE: 'CASH_SESSION_CLOSE',
  USER_MANAGE: 'USER_MANAGE',
  REPORT_VIEW: 'REPORT_VIEW',
  AUDIT_VIEW: 'AUDIT_VIEW',
  SUPPLIER_MANAGE: 'SUPPLIER_MANAGE',
  TRANSFER_REQUEST: 'TRANSFER_REQUEST',
  TRANSFER_VIEW: 'TRANSFER_VIEW',
  TRANSFER_APPROVE: 'TRANSFER_APPROVE',
  TRANSFER_PREPARE: 'TRANSFER_PREPARE',
  TRANSFER_DISPATCH: 'TRANSFER_DISPATCH',
  TRANSFER_RECEIVE: 'TRANSFER_RECEIVE',
  EXCHANGE_MANAGE: 'EXCHANGE_MANAGE',
  PUBLICATION_CHECKOUT: 'PUBLICATION_CHECKOUT',
  PUBLICATION_RETURN: 'PUBLICATION_RETURN',
  SENA_CREATE: 'SENA_CREATE',
  SENA_MANAGE: 'SENA_MANAGE',
  PRODUCT_IMAGE_MANAGE: 'PRODUCT_IMAGE_MANAGE',
} as const;

export type ProductionPermission =
  (typeof PRODUCTION_PERMISSIONS)[keyof typeof PRODUCTION_PERMISSIONS];

export const productionPermissionValues = Object.values(
  PRODUCTION_PERMISSIONS,
) as ProductionPermission[];

// docs/production-v1/03-role-permission-matrix.md: "Pricing is global (not
// per-location)... Products are global... Variants are global." ADMIN needs
// COMPANY scope for these; OWNER's implicit authority is not scope-gated (see
// role-permission-matrix.ts). This is domain metadata describing the rule for
// later enforcement (Phase 1D authorization middleware) — it does not itself
// grant or check anything.
export const COMPANY_SCOPE_REQUIRED_FOR_ADMIN: readonly ProductionPermission[] = [
  PRODUCTION_PERMISSIONS.PRICE_MANAGE,
  PRODUCTION_PERMISSIONS.PRODUCT_MANAGE,
  PRODUCTION_PERMISSIONS.PRODUCT_VARIANT_MANAGE,
];
