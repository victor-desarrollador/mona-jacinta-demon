import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { TOKEN_KEY, adminUser, installApi, renderApp } from '../test/harness';

afterEach(() => vi.unstubAllGlobals());

async function openSales() {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  const { calls } = installApi({
    'GET /auth/me': { body: { user: adminUser } },
    'GET /backoffice/branches': { body: { items: [] } },
    'GET /backoffice/sales': { body: { items: [], pagination: { limit: 20, offset: 0 } } },
  });
  renderApp('/ventas');
  await screen.findByRole('heading', { name: 'Ventas' });
  const lastQuery = () => calls.filter((c) => c.key === 'GET /backoffice/sales').at(-1)?.url.searchParams;
  return { lastQuery };
}
const startOfDay = (y: number, m: number, d: number) => new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
const endOfDay = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59, 999).toISOString();

test('"Desde" is the start of the selected day in the browser local time', async () => {
  const { lastQuery } = await openSales();
  fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-10-19' } });
  await waitFor(() => expect(lastQuery()?.get('dateFrom')).toBe(startOfDay(2026, 10, 19)));
  expect(lastQuery()?.get('dateTo')).toBeNull();
});

test('"Hasta" is the last millisecond of the selected day in the browser local time', async () => {
  const { lastQuery } = await openSales();
  fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-10-19' } });
  await waitFor(() => expect(lastQuery()?.get('dateTo')).toBe(endOfDay(2026, 10, 19)));
  expect(lastQuery()?.get('dateFrom')).toBeNull();
});

test('the same day as from and to covers exactly that local day', async () => {
  const { lastQuery } = await openSales();
  fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-10-19' } });
  fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-10-19' } });
  await waitFor(() => expect(lastQuery()?.get('dateTo')).toBe(endOfDay(2026, 10, 19)));
  const from = Date.parse(lastQuery()?.get('dateFrom') ?? '');
  const to = Date.parse(lastQuery()?.get('dateTo') ?? '');
  expect(from).toBe(Date.parse(startOfDay(2026, 10, 19)));
  expect(to - from).toBeGreaterThanOrEqual(23 * 3_600_000);
  expect(to - from).toBeLessThanOrEqual(25 * 3_600_000);
});

test('a two-day range runs from the start of the first local day to the end of the last', async () => {
  const { lastQuery } = await openSales();
  fireEvent.change(screen.getByLabelText('Desde'), { target: { value: '2026-10-18' } });
  fireEvent.change(screen.getByLabelText('Hasta'), { target: { value: '2026-10-19' } });
  await waitFor(() => expect(lastQuery()?.get('dateTo')).toBe(endOfDay(2026, 10, 19)));
  expect(lastQuery()?.get('dateFrom')).toBe(startOfDay(2026, 10, 18));
});
