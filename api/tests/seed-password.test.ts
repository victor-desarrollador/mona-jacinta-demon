import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { demoSeedOptionsFromEnv, resetDemo, resolveSeedPassword, seedDemo } from '../prisma/seed.js';

// D3R1: a public DEMO database must be seedable with an operator-supplied,
// non-source-controlled password; local/TEST keep the deterministic demo123
// default. Pure, database-free checks — the DB-backed round trip lives in
// tests/seed.test.ts. Synthetic secrets are generated at runtime and every
// assertion on them compares booleans, so no secret reaches test output.
const strong = () => `synthetic-${randomUUID()}`;

const invalid: Array<[string, string]> = [
  ['empty', ''],
  ['too short', 'short'],
  ['15 characters', 'fifteen-chars!!'],
  ['leading space', ' leading-space-password'],
  ['trailing space', 'trailing-space-password '],
  ['73 ASCII bytes', 'x'.repeat(73)],
  ['74 UTF-8 bytes in 37 characters', 'ñ'.repeat(37)],
];

function thrownMessage(action: () => unknown) {
  try {
    action();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('demo seed password selection', () => {
  it('keeps the deterministic local/TEST default when no override is given', () => {
    expect(resolveSeedPassword()).toBe('demo123');
    expect(resolveSeedPassword({})).toBe('demo123');
  });

  it('selects a valid explicit override instead of the default', () => {
    const secret = strong();
    expect(resolveSeedPassword({ password: secret }) === secret).toBe(true);
  });

  it('accepts the exact 16-character minimum and the 72-byte maximum', () => {
    for (const secret of ['a'.repeat(16), 'x'.repeat(72), 'ñ'.repeat(36)]) {
      expect(resolveSeedPassword({ password: secret }) === secret).toBe(true);
    }
  });

  it.each(invalid)('rejects an invalid explicit override (%s) without falling back or echoing it', (_label, value) => {
    const message = thrownMessage(() => resolveSeedPassword({ password: value }));
    expect(message.startsWith('DEMO_SEED_PASSWORD')).toBe(true);
    expect(value.length > 3 && message.includes(value)).toBe(false);
  });
});

describe('DEMO_SEED_PASSWORD environment override', () => {
  it('returns no override when the variable is absent', () => {
    expect(demoSeedOptionsFromEnv({})).toEqual({});
  });

  it('passes a valid value through unchanged', () => {
    const secret = strong();
    expect(demoSeedOptionsFromEnv({ DEMO_SEED_PASSWORD: secret }).password === secret).toBe(true);
  });

  it.each(invalid)('rejects an explicitly supplied invalid value (%s) without echoing it', (_label, value) => {
    const message = thrownMessage(() => demoSeedOptionsFromEnv({ DEMO_SEED_PASSWORD: value }));
    expect(message.startsWith('DEMO_SEED_PASSWORD')).toBe(true);
    expect(value.length > 3 && message.includes(value)).toBe(false);
  });
});

describe('seedDemo/resetDemo with an invalid override', () => {
  it.each(invalid)('refuse (%s) before opening any transaction', async (_label, value) => {
    let transactionOpened = false;
    const client = {
      $transaction: async () => {
        transactionOpened = true;
        throw new Error('transaction must not be reached');
      },
    };
    await expect(seedDemo(client as never, { password: value })).rejects.toThrow('DEMO_SEED_PASSWORD');
    await expect(resetDemo(client as never, { password: value })).rejects.toThrow('DEMO_SEED_PASSWORD');
    expect(transactionOpened).toBe(false);
  });

  it('with a valid override proceed to the transaction (validation and hashing come first)', async () => {
    let transactionOpened = false;
    const client = {
      $transaction: async () => {
        transactionOpened = true;
        throw new Error('stop at transaction');
      },
    };
    await expect(resetDemo(client as never, { password: strong() })).rejects.toThrow('stop at transaction');
    expect(transactionOpened).toBe(true);
  });
});
