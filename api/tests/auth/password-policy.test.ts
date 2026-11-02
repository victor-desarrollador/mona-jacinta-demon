import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_MIN_BYTES,
  assertPasswordPolicy,
} from '../../src/modules/auth/password-policy.js';

// USER-MGMT-01 U1 — password policy (DB-free). Approved: 10..72 UTF-8 BYTES (bcrypt hashes at most 72 BYTES), no composition rules,
// different from the account email, and (own change) different from the current password.
//
//   PP-01..PP-06  length in bytes
//   PP-07..PP-09  no composition rules
//   PP-10..PP-12  email / current password
//   PP-13         the refusals are 400 AppErrors in Spanish with ONE stable code, and never echo the password

const ok = (password: string, extra: { email?: string; currentPassword?: string } = {}) =>
  assertPasswordPolicy({ password, email: extra.email ?? 'maria@local.test', currentPassword: extra.currentPassword });

const refusal = (password: string, extra: { email?: string; currentPassword?: string } = {}) => {
  try {
    ok(password, extra);
  } catch (error) {
    return error;
  }
  return null;
};

describe('password policy — length in bytes (PP-01..PP-06)', () => {
  it('PP-00 the bounds are 10 and 72', () => {
    expect(PASSWORD_MIN_BYTES).toBe(10);
    expect(PASSWORD_MAX_BYTES).toBe(72);
  });

  it('PP-01 9 bytes fail', () => {
    expect(refusal('a'.repeat(9))).toBeInstanceOf(AppError);
  });

  it('PP-02 10 bytes pass', () => {
    expect(() => ok('a'.repeat(10))).not.toThrow();
  });

  it('PP-03 72 bytes pass', () => {
    expect(() => ok('a'.repeat(72))).not.toThrow();
  });

  it('PP-04 73 bytes fail', () => {
    expect(refusal('a'.repeat(73))).toBeInstanceOf(AppError);
  });

  it('PP-05 a multibyte string that exceeds 72 BYTES fails even though it has fewer than 72 characters', () => {
    const password = 'ñ'.repeat(37); // 37 characters, 74 bytes
    expect(password.length).toBeLessThan(72);
    expect(Buffer.byteLength(password, 'utf8')).toBe(74);
    expect(refusal(password)).toBeInstanceOf(AppError);
  });

  it('PP-06 a multibyte string of exactly 72 bytes passes, and 5 two-byte characters (10 bytes) pass although they are only 5 characters', () => {
    expect(() => ok('ñ'.repeat(36))).not.toThrow(); // 72 bytes
    expect(() => ok('ñ'.repeat(5))).not.toThrow(); // 10 bytes
    expect(refusal('ñ'.repeat(4))).toBeInstanceOf(AppError); // 8 bytes
  });
});

describe('password policy — no composition rules (PP-07..PP-09)', () => {
  it.each([['all lowercase', 'abcdefghij'], ['all digits', '1234567890'], ['all symbols', '!!!!!!!!!!']])(
    'PP-07 %s is accepted',
    (_label, password) => {
      expect(() => ok(password)).not.toThrow();
    },
  );

  it('PP-08 leading and trailing spaces are part of the password (never trimmed) and count as bytes', () => {
    expect(() => ok('  spaced   ')).not.toThrow();
    expect(refusal('         ')).toBeInstanceOf(AppError); // 9 spaces = 9 bytes
  });

  it('PP-09 an empty or non-string password is refused', () => {
    expect(refusal('')).toBeInstanceOf(AppError);
    expect(refusal(undefined as unknown as string)).toBeInstanceOf(AppError);
  });
});

describe('password policy — email and current password (PP-10..PP-12)', () => {
  it('PP-10 equal to the account email is refused, comparing the NORMALIZED email (trim + lowercase) with the NORMALIZED password', () => {
    expect(refusal('maria@local.test', { email: 'maria@local.test' })).toBeInstanceOf(AppError);
    expect(refusal('MARIA@Local.Test', { email: '  maria@local.test ' })).toBeInstanceOf(AppError);
    expect(refusal('  maria@local.test  ', { email: 'maria@local.test' })).toBeInstanceOf(AppError);
  });

  it('PP-11 equal to the current password is refused (own change); case matters for the current password', () => {
    expect(refusal('same-password-1', { currentPassword: 'same-password-1' })).toBeInstanceOf(AppError);
    expect(() => ok('Same-Password-1', { currentPassword: 'same-password-1' })).not.toThrow();
  });

  it('PP-12 without a current password (an admin-issued context) only the length and email rules apply', () => {
    expect(() => ok('another-good-pass')).not.toThrow();
  });
});

describe('password policy — error contract (PP-13)', () => {
  it('PP-13 every refusal is a 400 AppError with one stable code, a Spanish message, and no echo of the password', () => {
    const secret = 'sh0rt';
    const error = refusal(secret) as AppError;
    expect(error.status).toBe(400);
    expect(error.code).toBe('PASSWORD_POLICY_VIOLATION');
    expect(error.message).toMatch(/contraseña/i);
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.details ?? null)).not.toContain(secret);

    const emailError = refusal('maria@local.test', { email: 'maria@local.test' }) as AppError;
    expect(emailError.code).toBe('PASSWORD_POLICY_VIOLATION');
    const sameError = refusal('same-password-1', { currentPassword: 'same-password-1' }) as AppError;
    expect(sameError.code).toBe('PASSWORD_POLICY_VIOLATION');
  });
});
