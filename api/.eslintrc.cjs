// Explicit flat-config entrypoint (npm run lint passes --config for this filename).
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'src/generated/**',
      '.eslintrc.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // System V2 guard: no NEW day/week bucketing that depends on the server's
    // time zone. Date.prototype.setHours uses the process time zone (UTC on
    // Railway), so a business day computed with it is wrong for Argentina.
    // Use the operating-time primitive (P0-C) instead. A legacy use that still
    // exists must carry an explicit `eslint-disable-next-line` with a reason.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='setHours']",
          message:
            'setHours() depends on the server time zone. Compute business days with the operating-time primitive (America/Argentina/Tucuman), not with the process time zone.',
        },
      ],
    },
  },
);
