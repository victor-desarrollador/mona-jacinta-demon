import { SignJWT, decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import {
  credentialsEpochClaim,
  isCredentialsEpochCurrent,
  nextCredentialsEpoch,
} from '../../src/modules/auth/credentials-epoch.js';
import { ACCESS_TOKEN_SECONDS, signAccessToken } from '../../src/modules/auth/tokens.js';

// USER-MGMT-01 U1 — credentials epoch. DB-free.
//
// The epoch (User.credentialsChangedAt, TIMESTAMPTZ(3)) is a VERSION of the user's credentials, not a clock check: the access token
// carries it as the `cc` claim (epoch in integer milliseconds, ABSENT while the user has never changed credentials) and a request
// is valid only when the claim EQUALS the stored epoch. `iat` (1 s granularity) is never compared against it.
//
//   EP-01..EP-04  nextCredentialsEpoch: max(now, previous + 1 ms)
//   EP-05..EP-06  credentialsEpochClaim: the claim value for a stored epoch
//   EP-07..EP-14  isCredentialsEpochCurrent: exact equality, legacy tokens, 1 ms apart, malformed claims
//   EP-15..EP-18  signAccessToken: the `cc` claim in the signed token

const at = (ms: number) => new Date(ms);

describe('nextCredentialsEpoch (EP-01..EP-04)', () => {
  it('EP-01 first change: the epoch is "now"', () => {
    expect(nextCredentialsEpoch(null, at(1_700_000_000_123)).getTime()).toBe(1_700_000_000_123);
  });

  it('EP-02 normal time: a later "now" wins over the previous epoch', () => {
    expect(nextCredentialsEpoch(at(1_700_000_000_000), at(1_700_000_005_000)).getTime()).toBe(1_700_000_005_000);
  });

  it('EP-03 same millisecond: the epoch still moves forward by exactly 1 ms', () => {
    expect(nextCredentialsEpoch(at(1_700_000_000_000), at(1_700_000_000_000)).getTime()).toBe(1_700_000_000_001);
  });

  it('EP-04 clock moved backwards: the epoch is previous + 1 ms, never earlier or equal', () => {
    expect(nextCredentialsEpoch(at(1_700_000_010_000), at(1_700_000_000_000)).getTime()).toBe(1_700_000_010_001);
  });

  it('EP-04b the result is a NEW Date at whole milliseconds (compatible with TIMESTAMPTZ(3)) and does not alias its inputs', () => {
    const previous = at(1_700_000_000_000);
    const now = at(1_700_000_000_000);
    const next = nextCredentialsEpoch(previous, now);
    expect(next).not.toBe(previous);
    expect(next).not.toBe(now);
    expect(Number.isInteger(next.getTime())).toBe(true);
  });
});

describe('credentialsEpochClaim (EP-05..EP-06)', () => {
  it('EP-05 a user that never changed credentials has NO claim', () => {
    expect(credentialsEpochClaim(null)).toBeNull();
  });

  it('EP-06 a defined epoch is the integer milliseconds of the stored value', () => {
    expect(credentialsEpochClaim(at(1_700_000_000_123))).toBe(1_700_000_000_123);
  });
});

describe('isCredentialsEpochCurrent (EP-07..EP-14)', () => {
  it('EP-07 legacy token (no claim) is valid while the stored epoch is NULL', () => {
    expect(isCredentialsEpochCurrent(undefined, null)).toBe(true);
    expect(isCredentialsEpochCurrent(null, null)).toBe(true);
  });

  it('EP-08 a token without the claim is INVALID once an epoch is stored', () => {
    expect(isCredentialsEpochCurrent(undefined, at(1_700_000_000_000))).toBe(false);
    expect(isCredentialsEpochCurrent(null, at(1_700_000_000_000))).toBe(false);
  });

  it('EP-09 a token carrying a claim is INVALID while the stored epoch is NULL', () => {
    expect(isCredentialsEpochCurrent(1_700_000_000_000, null)).toBe(false);
  });

  it('EP-10 the claim equal to the stored epoch is valid', () => {
    expect(isCredentialsEpochCurrent(1_700_000_000_123, at(1_700_000_000_123))).toBe(true);
  });

  it('EP-11 a claim that differs by ONE millisecond is invalid, in either direction', () => {
    expect(isCredentialsEpochCurrent(1_700_000_000_122, at(1_700_000_000_123))).toBe(false);
    expect(isCredentialsEpochCurrent(1_700_000_000_124, at(1_700_000_000_123))).toBe(false);
  });

  it('EP-12 the same-second case: a change and a token in the same second are told apart by the exact millisecond epoch', () => {
    const first = at(1_700_000_000_100);
    const second = nextCredentialsEpoch(first, at(1_700_000_000_900)); // same wall-clock second
    expect(Math.floor(first.getTime() / 1000)).toBe(Math.floor(second.getTime() / 1000));
    expect(isCredentialsEpochCurrent(first.getTime(), second)).toBe(false); // token of the first change
    expect(isCredentialsEpochCurrent(second.getTime(), second)).toBe(true); // token issued after the second change
  });

  it('EP-13 two consecutive changes: the token of the first change is invalid after the second, even on the same millisecond', () => {
    const first = at(1_700_000_000_000);
    const second = nextCredentialsEpoch(first, at(1_700_000_000_000));
    expect(isCredentialsEpochCurrent(first.getTime(), first)).toBe(true);
    expect(isCredentialsEpochCurrent(first.getTime(), second)).toBe(false);
    expect(isCredentialsEpochCurrent(second.getTime(), second)).toBe(true);
  });

  it.each([
    ['a numeric string', '1700000000123'],
    ['a float', 1_700_000_000_123.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an object', {}],
    ['a boolean', true],
    ['a bigint', 1_700_000_000_123n],
  ])('EP-14 a malformed claim (%s) is never current, not even against its own value', (_label, claim) => {
    expect(isCredentialsEpochCurrent(claim, at(1_700_000_000_123))).toBe(false);
    expect(isCredentialsEpochCurrent(claim, null)).toBe(false);
  });
});

describe('signAccessToken carries the epoch (EP-15..EP-18)', () => {
  it('EP-15 no stored epoch (null) -> the token has NO cc claim', async () => {
    const payload = decodeJwt(await signAccessToken('user-1', null));
    expect(payload).not.toHaveProperty('cc');
  });

  it('EP-16 the second argument is optional: the legacy call shape still signs a token without cc', async () => {
    const payload = decodeJwt(await signAccessToken('user-1'));
    expect(payload).not.toHaveProperty('cc');
    expect(payload.sub).toBe('user-1');
  });

  it('EP-17 a stored epoch -> cc is its exact integer milliseconds, and iat/exp keep their meaning', async () => {
    const epoch = at(1_700_000_000_123);
    const payload = decodeJwt(await signAccessToken('user-1', epoch));
    expect(payload.cc).toBe(1_700_000_000_123);
    expect(payload.exp).toBe(payload.iat! + ACCESS_TOKEN_SECONDS);
    expect(isCredentialsEpochCurrent(payload.cc, epoch)).toBe(true);
  });

  it('EP-18 the claim is under the signature: a token re-signed with another cc under another key does not verify', async () => {
    const { verifyAccessToken } = await import('../../src/modules/auth/tokens.js');
    const forged = await new SignJWT({ cc: 1 })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuedAt()
      .setExpirationTime(`${env.JWT_ACCESS_TTL_SECONDS}s`)
      .sign(new TextEncoder().encode('x'.repeat(env.JWT_SECRET.length + 1)));
    await expect(verifyAccessToken(forged)).rejects.toThrow();
  });
});
