export const PERMISSIONS = {
  SALE_CREATE: 'sale.create',
  SALE_CHARGE: 'sale.charge',
  SALE_COMPLETE: 'sale.complete',
  SALE_VIEW: 'sale.view',
  SALE_QUEUE_VIEW: 'sale.queue.view',
  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_MANAGE: 'inventory.manage',
  CASH_SESSION_OPEN: 'cash.session.open',
  CASH_SESSION_CLOSE: 'cash.session.close',
  USER_MANAGE: 'user.manage',
  REPORT_VIEW: 'report.view',
  AUDIT_VIEW: 'audit.view',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
export const permissionValues = Object.values(PERMISSIONS) as Permission[];

export const {
  SALE_CREATE,
  SALE_CHARGE,
  SALE_COMPLETE,
  SALE_VIEW,
  SALE_QUEUE_VIEW,
  INVENTORY_VIEW,
  INVENTORY_MANAGE,
  CASH_SESSION_OPEN,
  CASH_SESSION_CLOSE,
  USER_MANAGE,
  REPORT_VIEW,
  AUDIT_VIEW,
} = PERMISSIONS;