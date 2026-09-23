import { describe, expect, it } from 'vitest';
import {
  LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE,
  resolveLegacyRoleDisposition,
} from '../../src/modules/rbac/legacy-role-map.js';

describe('legacy role mapping (Phase 1C, D2.1 deferred-MANAGER)', () => {
  it('classifies ADMIN, CASHIER, and SELLER as ELIGIBLE, mapped to themselves', () => {
    expect(resolveLegacyRoleDisposition('ADMIN')).toEqual({ kind: 'ELIGIBLE', productionRoleCode: 'ADMIN' });
    expect(resolveLegacyRoleDisposition('CASHIER')).toEqual({ kind: 'ELIGIBLE', productionRoleCode: 'CASHIER' });
    expect(resolveLegacyRoleDisposition('SELLER')).toEqual({ kind: 'ELIGIBLE', productionRoleCode: 'SELLER' });
  });

  it('classifies the legacy MANAGER code explicitly as DEFERRED (LEGACY_MANAGER)', () => {
    expect(resolveLegacyRoleDisposition('MANAGER')).toEqual({ kind: 'DEFERRED', reason: 'LEGACY_MANAGER' });
  });

  it('never resolves MANAGER to WAREHOUSE, or to any Production role code at all', () => {
    const disposition = resolveLegacyRoleDisposition('MANAGER');
    expect(disposition.kind).not.toBe('ELIGIBLE');
    expect('productionRoleCode' in disposition).toBe(false);
  });

  it('throws on any code with no explicit eligible mapping or deferral', () => {
    expect(() => resolveLegacyRoleDisposition('GHOST')).toThrow(
      /No explicit Production role mapping or deferral/,
    );
    expect(() => resolveLegacyRoleDisposition('OWNER')).toThrow();
    expect(() => resolveLegacyRoleDisposition('WAREHOUSE')).toThrow();
  });

  it('the eligible mapping table contains exactly ADMIN, CASHIER, and SELLER — MANAGER is never a key', () => {
    expect(Object.keys(LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE).sort()).toEqual(
      ['ADMIN', 'CASHIER', 'SELLER'].sort(),
    );
    expect(LEGACY_ROLE_CODE_TO_PRODUCTION_ROLE_CODE).not.toHaveProperty('MANAGER');
  });
});
