import { describe, expect, it } from 'vitest';
import {
  COMPANY_SCOPE_REQUIRED_FOR_ADMIN,
  DEFAULT_ROLE_GRANTS,
  isConsistentScope,
  isProductionRoleCode,
  ownerHasImplicitAuthority,
  PRODUCTION_PERMISSIONS,
  productionPermissionValues,
  ROLE_CODES,
  roleCodeValues,
  SCOPE_KINDS,
} from '../../src/modules/rbac/index.js';

describe('Phase 1B RBAC domain module (no database)', () => {
  it('has exactly the Production V1 role set, with no MANAGER', () => {
    expect(roleCodeValues.slice().sort()).toEqual(
      ['ADMIN', 'CASHIER', 'OWNER', 'SELLER', 'WAREHOUSE'].sort(),
    );
    expect(roleCodeValues).not.toContain('MANAGER');
    expect(isProductionRoleCode('MANAGER')).toBe(false);
    for (const code of roleCodeValues) expect(isProductionRoleCode(code)).toBe(true);
  });

  it('has exactly the 33 permission constants from the frozen role-permission matrix', () => {
    const expected = [
      'PRICE_MANAGE',
      'GOODS_RECEIPT_MANAGE',
      'PRODUCT_MANAGE',
      'PRODUCT_VARIANT_MANAGE',
      'LABEL_PRINT',
      'IMPORT_RUN',
      'TRANSFER_RESOLVE',
      'SENA_SETTLE',
      'SALE_CREATE',
      'SALE_CHARGE',
      'SALE_COMPLETE',
      'SALE_VIEW',
      'SALE_QUEUE_VIEW',
      'INVENTORY_VIEW',
      'INVENTORY_MANAGE',
      'CASH_SESSION_OPEN',
      'CASH_SESSION_CLOSE',
      'USER_MANAGE',
      'REPORT_VIEW',
      'AUDIT_VIEW',
      'SUPPLIER_MANAGE',
      'TRANSFER_REQUEST',
      'TRANSFER_VIEW',
      'TRANSFER_APPROVE',
      'TRANSFER_PREPARE',
      'TRANSFER_DISPATCH',
      'TRANSFER_RECEIVE',
      'EXCHANGE_MANAGE',
      'PUBLICATION_CHECKOUT',
      'PUBLICATION_RETURN',
      'SENA_CREATE',
      'SENA_MANAGE',
      'PRODUCT_IMAGE_MANAGE',
    ];
    expect(productionPermissionValues.slice().sort()).toEqual(expected.slice().sort());
    expect(productionPermissionValues).toHaveLength(33);
    // Constant keys equal their string values (no invented abbreviations).
    for (const [key, value] of Object.entries(PRODUCTION_PERMISSIONS)) expect(key).toBe(value);
  });

  it('matches the exact default grants for SELLER, CASHIER and WAREHOUSE', () => {
    expect(DEFAULT_ROLE_GRANTS[ROLE_CODES.SELLER].slice().sort()).toEqual(
      ['SALE_CREATE', 'SALE_VIEW', 'INVENTORY_VIEW', 'TRANSFER_REQUEST', 'TRANSFER_VIEW', 'SENA_CREATE'].sort(),
    );
    expect(DEFAULT_ROLE_GRANTS[ROLE_CODES.CASHIER].slice().sort()).toEqual(
      [
        'LABEL_PRINT',
        'TRANSFER_RESOLVE',
        'SENA_SETTLE',
        'SALE_CHARGE',
        'SALE_COMPLETE',
        'SALE_VIEW',
        'SALE_QUEUE_VIEW',
        'INVENTORY_VIEW',
        'CASH_SESSION_OPEN',
        'CASH_SESSION_CLOSE',
        'TRANSFER_REQUEST',
        'TRANSFER_VIEW',
        'TRANSFER_APPROVE',
        'TRANSFER_DISPATCH',
        'TRANSFER_RECEIVE',
        'EXCHANGE_MANAGE',
        'PUBLICATION_CHECKOUT',
        'PUBLICATION_RETURN',
        'SENA_CREATE',
      ].sort(),
    );
    expect(DEFAULT_ROLE_GRANTS[ROLE_CODES.WAREHOUSE].slice().sort()).toEqual(
      [
        'GOODS_RECEIPT_MANAGE',
        'LABEL_PRINT',
        'TRANSFER_RESOLVE',
        'INVENTORY_MANAGE',
        'TRANSFER_REQUEST',
        'TRANSFER_VIEW',
        'TRANSFER_APPROVE',
        'TRANSFER_PREPARE',
        'TRANSFER_DISPATCH',
        'TRANSFER_RECEIVE',
        'PRODUCT_IMAGE_MANAGE',
      ].sort(),
    );
  });

  it('grants ADMIN every catalogued permission, with no OWNER grant list to rely on', () => {
    expect(DEFAULT_ROLE_GRANTS[ROLE_CODES.ADMIN].slice().sort()).toEqual(
      productionPermissionValues.slice().sort(),
    );
    expect('OWNER' in DEFAULT_ROLE_GRANTS).toBe(false);
    expect(ownerHasImplicitAuthority).toBe(true);
  });

  it('flags PRICE_MANAGE / PRODUCT_MANAGE / PRODUCT_VARIANT_MANAGE as COMPANY-scope-only for ADMIN', () => {
    expect(COMPANY_SCOPE_REQUIRED_FOR_ADMIN.slice().sort()).toEqual(
      ['PRICE_MANAGE', 'PRODUCT_MANAGE', 'PRODUCT_VARIANT_MANAGE'].sort(),
    );
  });

  it('has exactly the ScopeKind values LOCATION and COMPANY', () => {
    expect(Object.values(SCOPE_KINDS).slice().sort()).toEqual(['COMPANY', 'LOCATION']);
  });

  it('validates scope consistency identically to the DB CHECK constraint', () => {
    expect(isConsistentScope({ scopeKind: 'LOCATION', locationId: 'loc-1' })).toBe(true);
    expect(isConsistentScope({ scopeKind: 'LOCATION', locationId: null })).toBe(false);
    expect(isConsistentScope({ scopeKind: 'COMPANY', locationId: null })).toBe(true);
    expect(isConsistentScope({ scopeKind: 'COMPANY', locationId: 'loc-1' })).toBe(false);
  });
});
