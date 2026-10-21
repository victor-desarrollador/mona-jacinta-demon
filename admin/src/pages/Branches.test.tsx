import { screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TOKEN_KEY, adminUser, installApi, renderApp } from '../test/harness';

afterEach(() => vi.unstubAllGlobals());

const items = [
  { id: 'b1', name: 'Centro', code: 'CEN', address: 'Dir 1', pointOfSaleNumber: 1, type: 'RETAIL_BRANCH', isActive: true, locationConsistency: 'consistent' },
  { id: 'b2', name: 'Depósito', code: 'DEP', address: 'Dir 2', pointOfSaleNumber: 6, type: 'CENTRAL_WAREHOUSE', isActive: false, locationConsistency: 'consistent' },
  { id: 'b3', name: 'Sin ubicación', code: 'INC', address: 'Dir 3', pointOfSaleNumber: 9, type: null, isActive: null, locationConsistency: 'missing_location' },
];

async function openBranches() {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  installApi({
    'GET /auth/me': { body: { user: adminUser } },
    'GET /backoffice/branches': { body: { items } },
  });
  renderApp('/sucursales');
  await screen.findByRole('heading', { name: 'Sucursales autorizadas' });
  await screen.findByText('Centro');
}

test('shows the Location type and state of each authorized branch', async () => {
  await openBranches();
  expect(screen.getByText('Local')).toBeInTheDocument();
  expect(screen.getByText('Depósito Central')).toBeInTheDocument();
  expect(screen.getByText('Activo')).toBeInTheDocument();
  expect(screen.getByText('Inactivo')).toBeInTheDocument();
});

test('a branch without Location is flagged and shows neither type nor state', async () => {
  await openBranches();
  expect(screen.getByText('Inconsistente: Location faltante')).toBeInTheDocument();
  expect(screen.getAllByText(/^(Local|Depósito Central)$/)).toHaveLength(2);
  expect(screen.getAllByText(/^(Activo|Inactivo)$/)).toHaveLength(2);
});
