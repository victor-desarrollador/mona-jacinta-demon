import { describe, expect, it } from 'vitest';
import {
  hasPermission,
  hasPermissionAtLocation,
  isOwner,
} from '../../src/modules/rbac/authorization-policy.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import {
  COMPANY_SCOPE_REQUIRED_FOR_ADMIN,
  productionPermissionValues,
} from '../../src/modules/rbac/permissions.js';
import { ROLE_CODES } from '../../src/modules/rbac/roles.js';

const LOCATION_A = 'location-a';
const LOCATION_B = 'location-b';
const COMPANY_REQUIRED = new Set(COMPANY_SCOPE_REQUIRED_FOR_ADMIN);
const LOCATION_ONLY_ROLES = [
  ROLE_CODES.CASHIER,
  ROLE_CODES.SELLER,
  ROLE_CODES.WAREHOUSE,
] as const;

describe('canonical role x permission x scope authorization matrix (Phase 1E)', () => {
  it.each(LOCATION_ONLY_ROLES)(
    '%s: LOCATION assignment at A grants exactly its default permissions at A, never at B',
    (roleCode) => {
      const ctx = {
        assignments: [
          {
            roleId: 'r',
            roleCode,
            permissions: [...DEFAULT_ROLE_GRANTS[roleCode]],
            scopeKind: 'LOCATION' as const,
            locationId: LOCATION_A,
          },
        ],
      };

      for (const permission of productionPermissionValues) {
        const expected = DEFAULT_ROLE_GRANTS[roleCode].includes(permission);

        expect(
          hasPermissionAtLocation(ctx, permission, LOCATION_A),
        ).toBe(expected);

        expect(
          hasPermissionAtLocation(ctx, permission, LOCATION_B),
        ).toBe(false);
      }
    },
  );

  it('ADMIN: COMPANY assignment grants every catalogued permission at every location; LOCATION assignment fails every COMPANY-required permission everywhere', () => {
    const companyCtx = {
      assignments: [
        {
          roleId: 'r',
          roleCode: ROLE_CODES.ADMIN,
          permissions: [...DEFAULT_ROLE_GRANTS.ADMIN],
          scopeKind: 'COMPANY' as const,
          locationId: null,
        },
      ],
    };

    const locationCtx = {
      assignments: [
        {
          roleId: 'r',
          roleCode: ROLE_CODES.ADMIN,
          permissions: [...DEFAULT_ROLE_GRANTS.ADMIN],
          scopeKind: 'LOCATION' as const,
          locationId: LOCATION_A,
        },
      ],
    };

    for (const permission of productionPermissionValues) {
      expect(
        hasPermissionAtLocation(companyCtx, permission, LOCATION_A),
      ).toBe(true);

      expect(
        hasPermissionAtLocation(companyCtx, permission, LOCATION_B),
      ).toBe(true);

      expect(
        hasPermission(companyCtx, permission),
      ).toBe(true);

      if (COMPANY_REQUIRED.has(permission)) {
        expect(
          hasPermissionAtLocation(locationCtx, permission, LOCATION_A),
        ).toBe(false);

        expect(
          hasPermission(locationCtx, permission),
        ).toBe(false);
      } else {
        expect(
          hasPermissionAtLocation(locationCtx, permission, LOCATION_A),
        ).toBe(true);

        expect(
          hasPermissionAtLocation(locationCtx, permission, LOCATION_B),
        ).toBe(false);
      }
    }
  });

  it('OWNER: COMPANY assignment grants every catalogued permission at every location, even with an empty explicit permissions array', () => {
    const ctx = {
      assignments: [
        {
          roleId: 'r',
          roleCode: ROLE_CODES.OWNER,
          permissions: [],
          scopeKind: 'COMPANY' as const,
          locationId: null,
        },
      ],
    };

    expect(isOwner(ctx)).toBe(true);

    for (const permission of productionPermissionValues) {
      expect(
        hasPermission(ctx, permission),
      ).toBe(true);

      expect(
        hasPermissionAtLocation(ctx, permission, LOCATION_A),
      ).toBe(true);

      expect(
        hasPermissionAtLocation(ctx, permission, LOCATION_B),
      ).toBe(true);
    }
  });

  it.each(
    LOCATION_ONLY_ROLES.flatMap((roleA) =>
      LOCATION_ONLY_ROLES.map((roleB) => [roleA, roleB] as const),
    ),
  )(
    '%s @ A + %s @ B never cross-composes: only each role\'s own default grants apply, only at its own location',
    (roleA, roleB) => {
      const ctx = {
        assignments: [
          {
            roleId: 'ra',
            roleCode: roleA,
            permissions: [...DEFAULT_ROLE_GRANTS[roleA]],
            scopeKind: 'LOCATION' as const,
            locationId: LOCATION_A,
          },
          {
            roleId: 'rb',
            roleCode: roleB,
            permissions: [...DEFAULT_ROLE_GRANTS[roleB]],
            scopeKind: 'LOCATION' as const,
            locationId: LOCATION_B,
          },
        ],
      };

      for (const permission of productionPermissionValues) {
        expect(
          hasPermissionAtLocation(ctx, permission, LOCATION_A),
        ).toBe(DEFAULT_ROLE_GRANTS[roleA].includes(permission));

        expect(
          hasPermissionAtLocation(ctx, permission, LOCATION_B),
        ).toBe(DEFAULT_ROLE_GRANTS[roleB].includes(permission));
      }
    },
  );
});
