import { screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TOKEN_KEY, adminUser, installApi, renderApp } from './test/harness';

vi.mock('./pages/Branches', () => ({ Branches: () => { throw new Error('boom en sucursales'); } }));

afterEach(() => vi.unstubAllGlobals());

test('a page that throws is contained: the shell and navigation stay usable', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  installApi({ 'GET /auth/me': { body: { user: adminUser } }, 'GET /backoffice/dashboard': { body: { salesToday: 0, pendingSalesCount: 0, revenueToday: '0', lowStockCount: 0 } } });
  renderApp('/sucursales');
  expect(await screen.findByText(/boom en sucursales/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /Ventas/ })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeInTheDocument();
});
