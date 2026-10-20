import { screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { BRANCH_ID, TOKEN_KEY, adminUser, installApi, renderApp } from '../test/harness';

afterEach(() => vi.unstubAllGlobals());

const location = { id: BRANCH_ID, name: 'Mona Centro', code: 'PCEN' };

test('Users renders the real backend contract (assignments: roleCode, scopeKind, location) without crashing', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  installApi({
    'GET /auth/me': { body: { user: adminUser } },
    'GET /backoffice/dashboard': { body: { salesToday: 0, pendingSalesCount: 0, revenueToday: '0', lowStockCount: 0 } },
    'GET /backoffice/users': {
      body: {
        items: [
          { id: '1', name: 'Vera Vendedora', email: 'vendedor01@pilot.local', isActive: true, assignments: [{ roleCode: 'SELLER', scopeKind: 'LOCATION', location }] },
          { id: '2', name: 'Dora Dueña', email: 'propietario01@pilot.local', isActive: true, assignments: [{ roleCode: 'OWNER', scopeKind: 'COMPANY', location: null }] },
          { id: '3', name: 'Sin Rol', email: 'sinrol@pilot.local', isActive: false, assignments: [] },
        ],
      },
    },
  });
  renderApp('/usuarios');
  expect(await screen.findByText('vendedor01@pilot.local')).toBeInTheDocument();
  expect(screen.getByText('Vendedor · PCEN')).toBeInTheDocument();
  expect(screen.getByText('Dueño · Toda la empresa')).toBeInTheDocument();
  expect(screen.getByText('Sin asignaciones')).toBeInTheDocument();
  expect(screen.queryByText(/No se pudo renderizar/)).not.toBeInTheDocument();
});

test('Users with an empty list shows an empty state, not a crash', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  installApi({
    'GET /auth/me': { body: { user: adminUser } },
    'GET /backoffice/users': { body: { items: [] } },
  });
  renderApp('/usuarios');
  expect(await screen.findByText('Sin usuarios')).toBeInTheDocument();
});
