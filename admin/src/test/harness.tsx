import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';
import { App } from '../App';
import { AuthProvider } from '../hooks/useAuth';
import type { UserContext } from '../lib/api';

export const TOKEN_KEY = 'mona-jacinta-admin-token';
export const BRANCH_ID = '2477257d-2567-4fd6-9df7-1e078676b7ad';

export const adminUser: UserContext = {
  id: 'u-admin',
  name: 'Admin Piloto',
  email: 'administrador01@pilot.local',
  roles: ['ADMIN'],
  branchIds: [BRANCH_ID],
  permissions: ['report.view', 'user.manage'],
  cashSupervisorLocationIds: [BRANCH_ID],
};

type Reply = { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>;
type Handler = (request: { url: URL; init: RequestInit }) => Reply;

// Every request goes through this fake: no network, never a real API or database.
export function installApi(routes: Record<string, Handler | Reply>) {
  const calls: Array<{ key: string; url: URL; init: RequestInit }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const key = `${init.method ?? 'GET'} ${url.pathname.replace(/^\/api\/v1/, '')}`;
    calls.push({ key, url, init });
    const route = routes[key];
    // a handler that throws simulates a network failure (fetch rejects)
    const reply = typeof route === 'function' ? await route({ url, init }) : await route;
    const status = reply?.status ?? (route ? 200 : 404);
    return new Response(JSON.stringify(reply?.body ?? { message: route ? 'ok' : `unmocked ${key}` }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

export function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}
