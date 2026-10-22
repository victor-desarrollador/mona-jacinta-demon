import { afterEach, expect, test, vi } from 'vitest';
import { buildSalesHistoryQueryParams } from './SalesHistory';

afterEach(() => vi.unstubAllGlobals());

// P0-C: el Admin envía las fechas de negocio (YYYY-MM-DD) literalmente.
// La API es la autoridad de la zona (America/Argentina/Tucuman); el
// frontend NO aplica el offset del navegador ni convierte a UTC.
test('dateFrom is sent literally as YYYY-MM-DD, no UTC conversion', () => {
  const params = buildSalesHistoryQueryParams({
    branchId: '',
    dateFrom: '2026-10-21',
    dateTo: '',
    limit: '20',
    offset: '0',
  });
  expect(params.get('dateFrom')).toBe('2026-10-21');
  expect(params.get('dateTo')).toBeNull();
  expect(params.get('limit')).toBe('20');
  expect(params.get('offset')).toBe('0');
});

test('dateTo is sent literally as YYYY-MM-DD, no UTC conversion', () => {
  const params = buildSalesHistoryQueryParams({
    branchId: '',
    dateFrom: '',
    dateTo: '2026-10-21',
    limit: '20',
    offset: '0',
  });
  expect(params.get('dateTo')).toBe('2026-10-21');
  expect(params.get('dateFrom')).toBeNull();
});

test('same day range sends both dates literally as YYYY-MM-DD', () => {
  const params = buildSalesHistoryQueryParams({
    branchId: '',
    dateFrom: '2026-10-21',
    dateTo: '2026-10-21',
    limit: '20',
    offset: '0',
  });
  expect(params.get('dateFrom')).toBe('2026-10-21');
  expect(params.get('dateTo')).toBe('2026-10-21');
});

test('branchId is included when set', () => {
  const params = buildSalesHistoryQueryParams({
    branchId: 'loc-a',
    dateFrom: '2026-10-21',
    dateTo: '2026-10-21',
    limit: '20',
    offset: '0',
  });
  expect(params.get('branchId')).toBe('loc-a');
  expect(params.get('dateFrom')).toBe('2026-10-21');
  expect(params.get('dateTo')).toBe('2026-10-21');
});
