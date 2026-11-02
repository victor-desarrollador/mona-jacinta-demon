// USER-MGMT-01 U5 — forced password change in the ADMIN app. The backend stays the authority (403 PASSWORD_CHANGE_REQUIRED on everything else);
// this is the UX that follows it: a dedicated screen, no navigation around it, the new token replaces the old one, a reload keeps it.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { TOKEN_KEY, adminUser, installApi, renderApp } from '../test/harness';

afterEach(() => vi.unstubAllGlobals());
const pending = { ...adminUser, mustChangePassword: true };
const dashboard = { body: { salesToday: 0, pendingSalesCount: 0, revenueToday: '0', lowStockCount: 0 } };
const NEW = 'una-contrasena-nueva-123';

async function fill(user: ReturnType<typeof userEvent.setup>, { current = 'temporal-actual', next = NEW, again = NEW } = {}) {
  await user.type(screen.getByLabelText('Contraseña actual'), current);
  await user.type(screen.getByLabelText('Nueva contraseña'), next);
  await user.type(screen.getByLabelText('Repetir nueva contraseña'), again);
}

test('F01 an account without a pending change goes straight to the panel', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  installApi({ 'GET /auth/me': { body: { user: { ...adminUser, mustChangePassword: false } } }, 'GET /backoffice/dashboard': dashboard });
  renderApp('/');
  expect(await screen.findByRole('heading', { name: 'Panel de control' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Cambiar contraseña' })).not.toBeInTheDocument();
});

test('F02 a pending change shows ONLY the change screen — no sidebar, no panel, and a deep link to another page stays blocked', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  const { calls } = installApi({ 'GET /auth/me': { body: { user: pending } } });
  renderApp('/usuarios');
  expect(await screen.findByRole('heading', { name: 'Cambiar contraseña' })).toBeInTheDocument();
  expect(screen.getByText('Necesitás cambiar tu contraseña antes de continuar.')).toBeInTheDocument();
  expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  expect(screen.queryByText('Usuarios')).not.toBeInTheDocument();
  expect(calls.filter((c) => c.key !== 'GET /auth/me')).toEqual([]); // no page loaded any data
});

test('F03 mismatching confirmation is refused in the browser, with no request', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  const { calls } = installApi({ 'GET /auth/me': { body: { user: pending } } });
  const user = userEvent.setup();
  renderApp('/');
  await screen.findByRole('heading', { name: 'Cambiar contraseña' });
  await fill(user, { again: 'otra-distinta-123' });
  await user.click(screen.getByRole('button', { name: 'Cambiar contraseña' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Las contraseñas nuevas no coinciden.');
  expect(calls.filter((c) => c.key === 'POST /auth/change-password')).toHaveLength(0);
});

test('F04 the backend\'s INVALID_CURRENT_PASSWORD is shown and the screen stays', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  installApi({
    'GET /auth/me': { body: { user: pending } },
    'POST /auth/change-password': { status: 400, body: { error: { code: 'INVALID_CURRENT_PASSWORD', message: 'La contraseña actual no es correcta.' } } },
  });
  const user = userEvent.setup();
  renderApp('/');
  await screen.findByRole('heading', { name: 'Cambiar contraseña' });
  await fill(user);
  await user.click(screen.getByRole('button', { name: 'Cambiar contraseña' }));
  expect(await screen.findByText('La contraseña actual no es correcta.')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Cambiar contraseña' })).toBeInTheDocument();
  expect(window.localStorage.getItem(TOKEN_KEY)).toBe('tok');
});

test('F05 success: the OLD token is replaced by the new one, /auth/me is re-read WITH the new token, and the panel opens (the policy message of the backend is shown when it refuses)', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'old-token');
  let changed = false;
  const { calls } = installApi({
    'GET /auth/me': ({ init }) => ({ body: { user: new Headers(init.headers).get('Authorization') === 'Bearer new-token' ? { ...adminUser, mustChangePassword: false } : pending } }),
    'POST /auth/change-password': () => { changed = true; return { body: { accessToken: 'new-token', user: { ...adminUser, mustChangePassword: false } } }; },
    'GET /backoffice/dashboard': dashboard,
  });
  const user = userEvent.setup();
  renderApp('/');
  await screen.findByRole('heading', { name: 'Cambiar contraseña' });
  await fill(user);
  await user.click(screen.getByRole('button', { name: 'Cambiar contraseña' }));
  expect(await screen.findByRole('heading', { name: 'Panel de control' })).toBeInTheDocument();
  expect(changed).toBe(true);
  const post = calls.find((c) => c.key === 'POST /auth/change-password')!;
  expect(new Headers(post.init.headers).get('Authorization')).toBe('Bearer old-token');
  expect(JSON.parse(String(post.init.body))).toEqual({ currentPassword: 'temporal-actual', newPassword: NEW });
  expect(window.localStorage.getItem(TOKEN_KEY)).toBe('new-token');
  const meCalls = calls.filter((c) => c.key === 'GET /auth/me');
  expect(new Headers(meCalls.at(-1)!.init.headers).get('Authorization')).toBe('Bearer new-token');
  expect(JSON.stringify([...Object.entries(window.localStorage)])).not.toContain(NEW);
  expect(JSON.stringify([...Object.entries(window.localStorage)])).not.toContain('old-token');
});

test('F06 PASSWORD_CHANGE_REQUIRED from ANY request sends a normal session to the change screen (no loop: it only flips a flag)', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  const { calls } = installApi({
    'GET /auth/me': { body: { user: { ...adminUser, mustChangePassword: false } } },
    'GET /backoffice/dashboard': { status: 403, body: { error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'Necesitás cambiar tu contraseña antes de continuar.' } } },
  });
  renderApp('/');
  expect(await screen.findByRole('heading', { name: 'Cambiar contraseña' })).toBeInTheDocument();
  await new Promise((r) => setTimeout(r, 100));
  expect(calls.filter((c) => c.key === 'GET /backoffice/dashboard')).toHaveLength(1);
});

test('F07 INACTIVE_USER ends the session: token cleared, back to login, with the explanation', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  installApi({
    'GET /auth/me': { body: { user: { ...adminUser, mustChangePassword: false } } },
    'GET /backoffice/dashboard': { status: 403, body: { error: { code: 'INACTIVE_USER', message: 'El usuario está inactivo.' } } },
  });
  renderApp('/');
  expect(await screen.findByRole('button', { name: 'Ingresar' })).toBeInTheDocument();
  expect(screen.getByText('Tu usuario fue desactivado. Consultá con un administrador.')).toBeInTheDocument();
  expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Panel de control' })).not.toBeInTheDocument();
});

test('F08 a reload during the forced flow is still blocked, and INACTIVE_USER on /auth/me (restoring a session) clears it with the explanation', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  installApi({ 'GET /auth/me': { body: { user: pending } } });
  const first = renderApp('/ventas');
  expect(await screen.findByRole('heading', { name: 'Cambiar contraseña' })).toBeInTheDocument();
  first.unmount();
  renderApp('/ventas'); // "reload": a fresh app with the same stored token
  expect(await screen.findByRole('heading', { name: 'Cambiar contraseña' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Ventas' })).not.toBeInTheDocument();
});

test('F09 logging in with a temporary password lands on the change screen, not on the panel', async () => {
  installApi({ 'POST /auth/login': { body: { accessToken: 'temp-token', user: pending } }, 'GET /backoffice/dashboard': dashboard });
  const user = userEvent.setup();
  renderApp('/login');
  await user.type(await screen.findByLabelText('Correo'), 'nuevo@pilot.local');
  await user.type(screen.getByLabelText('Contraseña'), 'ABCD-efgh-JKLM-npqr');
  await user.click(screen.getByRole('button', { name: 'Ingresar' }));
  expect(await screen.findByRole('heading', { name: 'Cambiar contraseña' })).toBeInTheDocument();
  await waitFor(() => expect(within(document.body).queryByRole('heading', { name: 'Panel de control' })).not.toBeInTheDocument());
});

test('F10 two submits in the SAME tick send ONE change-password request (the in-flight guard, not the disabled button)', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  let release!: (v: { status: number; body: unknown }) => void;
  const held = new Promise<{ status: number; body: unknown }>((resolve) => { release = resolve; });
  const { calls } = installApi({ 'GET /auth/me': { body: { user: pending } }, 'POST /auth/change-password': held });
  const user = userEvent.setup();
  renderApp('/');
  await screen.findByRole('heading', { name: 'Cambiar contraseña' });
  await fill(user);
  const form = screen.getByRole('button', { name: 'Cambiar contraseña' }).closest('form')!;
  act(() => { form.requestSubmit(); form.requestSubmit(); });
  expect(calls.filter((c) => c.key === 'POST /auth/change-password')).toHaveLength(1);
  release({ status: 400, body: { error: { code: 'X', message: 'No.' } } });
  expect(await screen.findByText('No.')).toBeInTheDocument();
});
