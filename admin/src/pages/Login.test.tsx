import { screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { installApi, renderApp } from '../test/harness';

afterEach(() => vi.unstubAllGlobals());

test('the login form starts empty: no prefilled demo email', async () => {
  installApi({});
  renderApp('/login');
  const email = await screen.findByLabelText('Correo');
  expect(email).toHaveValue('');
  expect(screen.getByLabelText('Contraseña')).toHaveValue('');
});
