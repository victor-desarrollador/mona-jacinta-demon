import { defineConfig } from 'vitest/config';

// Configuracion exclusiva para tests de unidad DB-free (p. ej. primitives de
// tiempo de operacion). No toca globalSetup (abre DB real) ni setupFiles
// (aísla TEST/LOCAL_TEST). No modifica el flujo de pruebas del proyecto.
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/shared/operating-time.test.ts',
      'tests/backoffice/dashboard.unit.test.ts',
    ],
  },
});
