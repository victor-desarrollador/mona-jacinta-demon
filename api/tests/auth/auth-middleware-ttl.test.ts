import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// USER-MGMT-01 U1 — the auth middleware must not carry its own copy of the access-token lifetime. tokens.ts already takes it from
// JWT_ACCESS_TTL_SECONDS (tokens.test.ts); `maxTokenAge: 900` in middleware/auth.ts was a second, hardcoded source that silently
// rejects every token the day the TTL is configured above 900 s. At the PILOT value (900) the behaviour is unchanged.

const source = () => readFile(fileURLToPath(new URL('../../src/middleware/auth.ts', import.meta.url)), 'utf8');

describe('auth middleware token age (TTL-01..TTL-02)', () => {
  it('TTL-01 does not hardcode maxTokenAge', async () => {
    expect(await source()).not.toMatch(/maxTokenAge:\s*\d+/);
  });

  it('TTL-02 takes maxTokenAge from the shared ACCESS_TOKEN_SECONDS (one source of truth)', async () => {
    const text = await source();
    expect(text).toMatch(/maxTokenAge:\s*ACCESS_TOKEN_SECONDS/);
    expect(text).toContain("from '../modules/auth/tokens.js'");
  });
});
