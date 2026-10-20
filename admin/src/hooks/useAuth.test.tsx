import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TOKEN_KEY, adminUser, installApi, renderApp } from '../test/harness';

afterEach(() => vi.unstubAllGlobals());

const dashboard = { body: { salesToday: 0, pendingSalesCount: 0, revenueToday: '0', lowStockCount: 0 } };
const emptySales = { body: { items: [], pagination: { limit: 20, offset: 0 } } };

test('a stored token is validated against /auth/me and the session is restored on the deep link (F5)', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'stored-token');
  const { calls } = installApi({
    'GET /auth/me': { body: { user: adminUser } },
    'GET /backoffice/sales': emptySales,
    'GET /backoffice/branches': { body: { items: [] } },
  });
  renderApp('/ventas');
  expect(await screen.findByRole('heading', { name: 'Ventas' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Ingresar' })).not.toBeInTheDocument();
  const me = calls.find((c) => c.key === 'GET /auth/me');
  expect(new Headers(me?.init.headers).get('Authorization')).toBe('Bearer stored-token');
});

test('a 401 from /auth/me clears the stored token and sends the user to login', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'expired');
  installApi({ 'GET /auth/me': { status: 401, body: { message: 'Unauthorized' } } });
  renderApp('/ventas');
  expect(await screen.findByRole('button', { name: 'Ingresar' })).toBeInTheDocument();
  expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  expect(screen.queryByText('No se pudo validar la sesión')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).not.toBeInTheDocument();
});

test('while the stored token is being validated the app shows loading, never the login form', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'stored-token');
  let release!: (value: { body: unknown }) => void;
  const pending = new Promise<{ body: unknown }>((resolve) => { release = resolve; });
  installApi({ 'GET /auth/me': pending, 'GET /backoffice/dashboard': dashboard });
  renderApp('/');
  expect(screen.getByText('Cargando sesión')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Ingresar' })).not.toBeInTheDocument();
  release({ body: { user: adminUser } });
  expect(await screen.findByText('Ventas de hoy')).toBeInTheDocument();
  expect(screen.queryByText('Cargando sesión')).not.toBeInTheDocument();
});

test('an unauthenticated deep link goes to login and comes back to the same page after logging in', async () => {
  installApi({
    'POST /auth/login': { body: { accessToken: 'new-token', user: adminUser } },
    'GET /backoffice/sales': emptySales,
    'GET /backoffice/branches': { body: { items: [] } },
  });
  renderApp('/ventas');
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText('Correo'), 'administrador01@pilot.local');
  await user.type(screen.getByLabelText('Contraseña'), 'Clave-Larga#2026');
  await user.click(screen.getByRole('button', { name: 'Ingresar' }));
  expect(await screen.findByRole('heading', { name: 'Ventas' })).toBeInTheDocument();
  await waitFor(() => expect(window.localStorage.getItem(TOKEN_KEY)).toBe('new-token'));
});

test('logout removes the stored token', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'stored-token');
  installApi({ 'GET /auth/me': { body: { user: adminUser } }, 'GET /backoffice/dashboard': dashboard });
  renderApp('/');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Cerrar sesión' }));
  expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
});

test('a 500 from /auth/me keeps the token and shows a session-validation error, not the login form', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'stored-token');
  installApi({ 'GET /auth/me': { status: 500, body: { message: 'boom' } } });
  renderApp('/ventas');
  expect(await screen.findByText('No se pudo validar la sesión')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reintentar' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Ingresar' })).not.toBeInTheDocument();
  expect(window.localStorage.getItem(TOKEN_KEY)).toBe('stored-token');
});

test('a network error keeps the token and shows the same retryable error, not the login form', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'stored-token');
  installApi({ 'GET /auth/me': () => { throw new TypeError('Failed to fetch'); } });
  renderApp('/ventas');
  expect(await screen.findByText('No se pudo validar la sesión')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Ingresar' })).not.toBeInTheDocument();
  expect(window.localStorage.getItem(TOKEN_KEY)).toBe('stored-token');
});

test('Reintentar shows loading, re-runs /auth/me and restores the original deep link', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'stored-token');
  let attempts = 0;
  let release!: (value: { body: unknown }) => void;
  const second = new Promise<{ body: unknown }>((resolve) => { release = resolve; });
  const { calls } = installApi({
    'GET /auth/me': () => (++attempts === 1 ? { status: 503, body: { message: 'down' } } : second),
    'GET /backoffice/sales': emptySales,
    'GET /backoffice/branches': { body: { items: [] } },
  });
  renderApp('/ventas');
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Reintentar' }));
  expect(screen.getByText('Cargando sesión')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Reintentar' })).not.toBeInTheDocument();
  release({ body: { user: adminUser } });
  expect(await screen.findByRole('heading', { name: 'Ventas' })).toBeInTheDocument();
  expect(calls.filter((c) => c.key === 'GET /auth/me')).toHaveLength(2);
  expect(window.localStorage.getItem(TOKEN_KEY)).toBe('stored-token');
});
