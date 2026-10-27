/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular-internal',
      severity: 'error',
      comment: 'Internal application/tooling modules must remain acyclic.',
      from: {
        path: '^(?:api/src|api/tests|api/scripts|client/src|admin/src|scripts/database)/',
        pathNot: '^api/src/generated/',
      },
      to: {
        circular: true,
      },
    },

    {
      name: 'no-unresolved-internal',
      severity: 'error',
      comment: 'Internal imports must resolve. Missing imports fail closed.',
      from: {
        path: '^(?:api/src|api/tests|api/scripts|client/src|admin/src|scripts/database)/',
        pathNot: '^api/src/generated/',
      },
      to: {
        couldNotResolve: true,
      },
    },

    {
      name: 'non-test-code-not-to-tests',
      severity: 'error',
      comment: 'Production/tooling code must never depend on test implementation.',
      from: {
        path: '^(?:api/src|api/scripts|client/src|admin/src|scripts/database)/',
        pathNot: '[.]test[.](?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$',
      },
      to: {
        path: [
          '^api/tests/',
          '^scripts/database/.*[.]test[.](?:js|mjs|cjs|jsx|ts|mts|cts|tsx)$',
        ],
      },
    },

    {
      name: 'api-runtime-not-to-api-scripts',
      severity: 'error',
      comment: 'API production runtime must not depend on maintenance/bootstrap scripts.',
      from: {
        path: '^api/src/',
      },
      to: {
        path: '^api/scripts/',
      },
    },

    {
      name: 'api-runtime-not-to-db-tooling',
      severity: 'error',
      comment: 'API production runtime must not import repository database tooling.',
      from: {
        path: '^api/src/',
      },
      to: {
        path: '^scripts/database/',
      },
    },

    {
      name: 'client-not-to-api-runtime',
      severity: 'error',
      comment: 'Client must consume the API contract, never API implementation internals.',
      from: {
        path: '^client/src/',
      },
      to: {
        path: '^api/src/',
      },
    },

    {
      name: 'admin-not-to-api-runtime',
      severity: 'error',
      comment: 'Admin must consume the API contract, never API implementation internals.',
      from: {
        path: '^admin/src/',
      },
      to: {
        path: '^api/src/',
      },
    },

    {
      name: 'client-not-to-admin',
      severity: 'error',
      comment: 'Client and admin frontends must remain separate applications.',
      from: {
        path: '^client/src/',
      },
      to: {
        path: '^admin/src/',
      },
    },

    {
      name: 'admin-not-to-client',
      severity: 'error',
      comment: 'Admin and client frontends must remain separate applications.',
      from: {
        path: '^admin/src/',
      },
      to: {
        path: '^client/src/',
      },
    },

    {
      name: 'pilot-c-not-to-d',
      severity: 'error',
      comment: 'C tooling may not depend on the later D catalog-bootstrap layer.',
      from: {
        path: '^scripts/database/pilot-(?:marker|migrate|bootstrap)[.]mjs$',
      },
      to: {
        path: '^scripts/database/pilot-catalog-bootstrap[.]mjs$',
      },
    },

    // ---------------------------------------------------------------------
    // System V2 architecture guards (severity: warn).
    //
    // These stop NEW architectural debt without turning the existing debt
    // into CI failures: every violation that already existed when the guards
    // were added is recorded in .dependency-cruiser-known-violations.json and
    // is ignored by `npm run deps:check` (--ignore-known). A violation that
    // is NOT in that baseline is reported as a warning. Regenerate the
    // baseline with `npm run deps:baseline` in the same commit that removes
    // (or knowingly accepts) a legacy violation.
    // Module-level cycles cannot be expressed as a dependency-cruiser rule
    // (the cycle flag is computed before folders are collapsed); they are
    // reported by scripts/dev/module-cycles.mjs (`npm run deps:modules`).
    // ---------------------------------------------------------------------
    {
      name: 'shared-not-to-modules',
      severity: 'warn',
      comment: 'api/src/shared is the base layer: it must not depend on a domain module.',
      from: {
        path: '^api/src/shared/',
      },
      to: {
        path: '^api/src/modules/',
      },
    },

    {
      name: 'modules-via-public-index',
      severity: 'warn',
      comment:
        'A domain module consumes another module only through its index.ts (its public surface), never through its internals.',
      from: {
        path: '^api/src/modules/([^/]+)/',
      },
      to: {
        path: '^api/src/modules/[^/]+/',
        pathNot: ['^api/src/modules/$1/', '^api/src/modules/[^/]+/index[.]ts$'],
      },
    },

    {
      name: 'routes-controllers-not-prisma-runtime',
      severity: 'warn',
      comment:
        'Routes and controllers delegate to services: they may use Prisma types but must not import the Prisma runtime or client.',
      from: {
        path: '^api/src/modules/[^/]+/(?:[^/]+[.]routes|[^/]+[.]controller)[.]ts$',
      },
      to: {
        path: ['^api/src/generated/', '^api/src/config/prisma[.]ts$'],
        dependencyTypesNot: ['type-only'],
      },
    },
  ],

  options: {
    doNotFollow: {
      path: 'node_modules',
    },

    // Architecture boundaries must also see dependencies erased by TS compilation,
    // otherwise `import type` becomes a bypass.
    tsPreCompilationDeps: true,

    // Only derive expensive graph properties that are actually used by rules.
    skipAnalysisNotInRules: true,
  },
};
