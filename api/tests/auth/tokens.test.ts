import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import {
  ACCESS_TOKEN_SECONDS,
  signAccessToken,
  verifyAccessToken,
} from '../../src/modules/auth/tokens.js';

describe('access token TTL', () => {
  it('uses JWT_ACCESS_TTL_SECONDS as the single source of truth', async () => {
    expect(ACCESS_TOKEN_SECONDS).toBe(env.JWT_ACCESS_TTL_SECONDS);

    const token = await signAccessToken('user-1');
    const payload = decodeJwt(token);

    expect(payload.iat).toEqual(expect.any(Number));
    expect(payload.exp).toBe(payload.iat! + env.JWT_ACCESS_TTL_SECONDS);

    const verified = await verifyAccessToken(token);
    expect(verified.payload.sub).toBe('user-1');
  });
});

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

it('does not hardcode the access token TTL', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../src/modules/auth/tokens.ts', import.meta.url)),
    'utf8',
  );

  expect(source).toContain(
    'const ACCESS_TOKEN_SECONDS = env.JWT_ACCESS_TTL_SECONDS;',
  );
  expect(source).not.toContain(
    'const ACCESS_TOKEN_SECONDS = 15 * 60;',
  );
});
