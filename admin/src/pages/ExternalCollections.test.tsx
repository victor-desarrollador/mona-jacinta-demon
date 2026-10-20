import { screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { BRANCH_ID, TOKEN_KEY, adminUser, installApi, renderApp } from '../test/harness';

afterEach(() => vi.unstubAllGlobals());

const collection = {
  id: 'c1', branchId: BRANCH_ID, method: 'TRANSFER', amount: '125000', reference: 'REF-1', referenceKey: 'ref-1',
  institution: null, institutionOther: null, status: 'UNAPPLIED', originSaleId: null, originAttemptId: null, cashSessionId: null,
  recordedById: 'u-1', recordedAt: '2026-10-19T12:00:00.000Z', resolvedById: null, resolvedAt: null, refundReference: null,
  resolutionNote: null, externalRefundedAt: null,
};

function setup(user: typeof adminUser) {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  installApi({
    'GET /auth/me': { body: { user } },
    'GET /backoffice/branches': { body: { items: [{ id: BRANCH_ID, name: 'Mona Centro', code: 'PCEN' }] } },
    'GET /external-collections': { body: { items: [collection] } },
  });
  renderApp('/cobros-externos');
}

test('the refund button is shown only to a supervisor of that branch', async () => {
  setup(adminUser);
  expect(await screen.findByRole('button', { name: 'Registrar devolución' })).toBeInTheDocument();
});

test('a non-supervisor sees the collections but no refund button (the backend stays the authority)', async () => {
  setup({ ...adminUser, cashSupervisorLocationIds: [] });
  expect(await screen.findByText('REF-1')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Registrar devolución' })).not.toBeInTheDocument();
});

test('a user without the projected hint at all gets no refund button', async () => {
  const { cashSupervisorLocationIds: _omit, ...withoutHint } = adminUser;
  void _omit;
  setup(withoutHint);
  expect(await screen.findByText('REF-1')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Registrar devolución' })).not.toBeInTheDocument();
});
