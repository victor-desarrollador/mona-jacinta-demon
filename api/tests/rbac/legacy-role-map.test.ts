import { describe, expect, it } from 'vitest';
import {
  LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE,
  resolveProductionRoleCodeForLegacy,
} from '../../src/modules/rbac/legacy-role-map.js';

describe('legacy role mapping (Phase 1C)', () => {
  it('maps ADMIN, CASHIER, and SELLER to themselves', () => {
    expect(resolveProductionRoleCodeForLegacy('ADMIN')).toBe('ADMIN');
    expect(resolveProductionRoleCodeForLegacy('CASHIER')).toBe('CASHIER');
    expect(resolveProductionRoleCodeForLegacy('SELLER')).toBe('SELLER');
  });

  it('maps the legacy MANAGER code explicitly to WAREHOUSE', () => {
    expect(resolveProductionRoleCodeForLegacy('MANAGER')).toBe('WAREHOUSE');
  });

  it('throws on any code with no explicit mapping', () => {
    expect(() => resolveProductionRoleCodeForLegacy('GHOST')).toThrow(
      /No explicit Production role mapping/,
    );
    expect(() => resolveProductionRoleCodeForLegacy('OWNER')).toThrow();
    expect(() => resolveProductionRoleCodeForLegacy('WAREHOUSE')).toThrow();
  });

  it('covers exactly the four legacy Demo V2 role codes', () => {
    expect(Object.keys(LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE).sort()).toEqual(
      ['ADMIN', 'CASHIER', 'MANAGER', 'SELLER'].sort(),
    );
  });
});
