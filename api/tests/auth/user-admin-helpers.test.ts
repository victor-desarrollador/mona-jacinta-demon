// USER-MGMT-01 U2 — the pure helpers of the identity lifecycle (DB-free): temporary password, email/name normalization, the canonical
// request hash and the request DTOs.
//   TP-01..TP-06  temporary password        RH-01..RH-08  canonical request hash
//   EN-01..EN-03  normalization             DT-01..DT-12  DTOs
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { assertPasswordPolicy } from '../../src/modules/auth/password-policy.js';
import {
  TEMPORARY_PASSWORD_ALPHABET, TEMPORARY_PASSWORD_PATTERN, generateTemporaryPassword,
} from '../../src/modules/auth/temporary-password.js';
import { canonicalRequestHash, normalizeEmail, normalizeName } from '../../src/modules/backoffice/user-admin-request.js';
import {
  adminOperationDto, createUserDto, updateUserDto,
} from '../../src/modules/backoffice/user-admin.dto.js';

const KEY = '3f1c2a9e-7b4d-4c3a-8e21-5d6f7a8b9c0d';
const LOC_A = '11111111-1111-4111-8111-111111111111';
const LOC_B = '22222222-2222-4222-8222-222222222222';

describe('temporary password (TP-01..TP-06)', () => {
  it('TP-01 the alphabet has no ambiguous character (0 1 O I l) and 57 symbols', () => {
    expect(TEMPORARY_PASSWORD_ALPHABET).toHaveLength(57);
    expect(TEMPORARY_PASSWORD_ALPHABET).not.toMatch(/[01OIl]/);
    expect(new Set(TEMPORARY_PASSWORD_ALPHABET).size).toBe(57);
  });

  it('TP-02 the format is XXXX-XXXX-XXXX-XXXX, 19 bytes, 16 symbols inside the alphabet', () => {
    for (let i = 0; i < 20; i += 1) {
      const password = generateTemporaryPassword();
      expect(password).toMatch(TEMPORARY_PASSWORD_PATTERN);
      expect(password).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/);
      expect(Buffer.byteLength(password, 'utf8')).toBe(19);
      for (const ch of password.replaceAll('-', '')) expect(TEMPORARY_PASSWORD_ALPHABET).toContain(ch);
    }
  });

  it('TP-03 it always satisfies the password policy (10..72 bytes, not the email)', () => {
    for (let i = 0; i < 20; i += 1) expect(() => assertPasswordPolicy({ password: generateTemporaryPassword(), email: 'maria@local.test' })).not.toThrow();
  });

  it('TP-04 it draws each of the 16 symbols with randomInt(alphabet.length): uniform, no modulo bias (injected generator, deterministic)', () => {
    const asked: number[] = [];
    const password = generateTemporaryPassword((max) => { asked.push(max); return asked.length - 1; });
    expect(asked).toEqual(Array(16).fill(57));
    expect(password).toBe([...Array(16).keys()].map((i) => TEMPORARY_PASSWORD_ALPHABET[i]).join('').replace(/(.{4})(?=.)/g, '$1-'));
  });

  it('TP-05 two generations differ (93 bits: a collision is not a flaky risk)', () => {
    expect(new Set(Array.from({ length: 50 }, () => generateTemporaryPassword())).size).toBe(50);
  });

  it('TP-06 an out-of-range draw from the generator is refused instead of producing a short/undefined symbol', () => {
    expect(() => generateTemporaryPassword(() => 57)).toThrow();
    expect(() => generateTemporaryPassword(() => -1)).toThrow();
  });
});

describe('normalization (EN-01..EN-03)', () => {
  it('EN-01 email: trim + lowercase', () => {
    expect(normalizeEmail('  Maria@Local.COM ')).toBe('maria@local.com');
  });
  it('EN-02 name: trim, inner spacing and case untouched, accents kept', () => {
    expect(normalizeName('  María  José Peña ')).toBe('María  José Peña');
  });
  it('EN-03 idempotent', () => {
    expect(normalizeEmail(normalizeEmail(' A@B.CO '))).toBe('a@b.co');
  });
});

describe('canonical request hash (RH-01..RH-08)', () => {
  const create = (patch: Record<string, unknown> = {}) => ({
    name: 'María López', email: 'maria@local.com', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [LOC_A, LOC_B], ...patch,
  });

  it('RH-01 exactly 64 lowercase hex characters (sha256)', () => {
    expect(canonicalRequestHash('CREATE_USER', create())).toMatch(/^[0-9a-f]{64}$/);
  });
  it('RH-02 deterministic', () => {
    expect(canonicalRequestHash('CREATE_USER', create())).toBe(canonicalRequestHash('CREATE_USER', create()));
  });
  it('RH-03 locationIds in a different order give the SAME hash; duplicates are not part of the intent', () => {
    expect(canonicalRequestHash('CREATE_USER', create({ locationIds: [LOC_B, LOC_A] }))).toBe(canonicalRequestHash('CREATE_USER', create()));
  });
  it('RH-04 email capitalisation and surrounding whitespace give the same hash', () => {
    expect(canonicalRequestHash('CREATE_USER', create({ email: '  MARIA@Local.com ' }))).toBe(canonicalRequestHash('CREATE_USER', create()));
  });
  it('RH-05 a real change of name, role, scope kind, a location or the operation gives a different hash', () => {
    const base = canonicalRequestHash('CREATE_USER', create());
    const others = [
      canonicalRequestHash('CREATE_USER', create({ name: 'María Lopez' })),
      canonicalRequestHash('CREATE_USER', create({ roleCode: 'SELLER' })),
      canonicalRequestHash('CREATE_USER', create({ locationIds: [LOC_A] })),
      canonicalRequestHash('CREATE_USER', create({ email: 'maria2@local.com' })),
      canonicalRequestHash('CREATE_USER', create({ roleCode: 'ADMIN', scopeKind: 'COMPANY', locationIds: [] })),
      canonicalRequestHash('RESET_PASSWORD', create()),
    ];
    for (const other of others) expect(other).not.toBe(base);
    expect(new Set([base, ...others]).size).toBe(others.length + 1);
  });
  it('RH-06 a target-only operation hashes (operation, targetUserId): another target or another operation differ', () => {
    const a = canonicalRequestHash('RESET_PASSWORD', { targetUserId: LOC_A });
    expect(canonicalRequestHash('RESET_PASSWORD', { targetUserId: LOC_B })).not.toBe(a);
    expect(canonicalRequestHash('DEACTIVATE_USER', { targetUserId: LOC_A })).not.toBe(a);
    expect(canonicalRequestHash('RESET_PASSWORD', { targetUserId: LOC_A })).toBe(a);
  });
  it('RH-07 the idempotency key is NOT part of the hash (it is the lookup key, not the intent)', () => {
    expect(canonicalRequestHash('RESET_PASSWORD', { targetUserId: LOC_A, idempotencyKey: KEY } as never)).toBe(canonicalRequestHash('RESET_PASSWORD', { targetUserId: LOC_A }));
  });
  it('RH-08 it carries no secret by construction: a password/hash/token field in the payload is ignored', () => {
    const base = canonicalRequestHash('CREATE_USER', create());
    expect(canonicalRequestHash('CREATE_USER', create({ password: 'x', passwordHash: 'y', token: 'z', temporaryPassword: 'w' }))).toBe(base);
    expect(createHash('sha256').update('x').digest('hex')).not.toBe(base);
  });
});

describe('DTOs (DT-01..DT-12)', () => {
  const body = (patch: Record<string, unknown> = {}) => ({
    name: ' María López ', email: ' Maria@Local.COM ', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [LOC_A], idempotencyKey: KEY, ...patch,
  });

  it('DT-01 create: normalizes name and email, keeps the rest', () => {
    const parsed = createUserDto.parse(body());
    expect(parsed).toMatchObject({ name: 'María López', email: 'maria@local.com', roleCode: 'CASHIER', scopeKind: 'LOCATION', locationIds: [LOC_A], idempotencyKey: KEY });
  });
  it('DT-02 create: COMPANY scope carries no locationIds', () => {
    const companyBody: Record<string, unknown> = body({ roleCode: 'ADMIN', scopeKind: 'COMPANY' });
    delete companyBody.locationIds;
    expect(createUserDto.parse(companyBody)).toMatchObject({ scopeKind: 'COMPANY' });
    expect(createUserDto.safeParse(body({ roleCode: 'ADMIN', scopeKind: 'COMPANY', locationIds: [LOC_A] })).success).toBe(false);
  });
  it.each([
    ['an empty name', { name: '   ' }], ['a name over 100 characters', { name: 'a'.repeat(101) }], ['an invalid email', { email: 'not-an-email' }],
    ['an email over 254 characters', { email: `${'a'.repeat(250)}@b.co` }], ['an unknown role', { roleCode: 'MANAGER' }],
    ['a LOCATION scope without locations', { locationIds: [] }], ['duplicate locations', { locationIds: [LOC_A, LOC_A] }],
    ['a non-uuid location', { locationIds: ['x'] }], ['a missing idempotency key', { idempotencyKey: undefined }],
    ['an idempotency key that is not a UUID v4', { idempotencyKey: '11111111-1111-1111-8111-111111111111' }],
    ['an extra field (a client-chosen password)', { password: 'Secret-1234567' }],
    ['an extra field (isActive)', { isActive: false }],
  ])('DT-03 create refuses %s', (_label, patch) => {
    expect(createUserDto.safeParse(body(patch)).success).toBe(false);
  });
  it('DT-04 the name keeps accents and is not upper-cased', () => {
    expect(createUserDto.parse(body({ name: 'Peña Ñandú' })).name).toBe('Peña Ñandú');
  });
  it('DT-05 update: name and/or email, at least one, strict', () => {
    expect(updateUserDto.parse({ name: ' Ana ' })).toEqual({ name: 'Ana' });
    expect(updateUserDto.parse({ email: ' ANA@X.CO ' })).toEqual({ email: 'ana@x.co' });
    expect(updateUserDto.safeParse({}).success).toBe(false);
    expect(updateUserDto.safeParse({ name: 'Ana', roleCode: 'OWNER' }).success).toBe(false);
    expect(updateUserDto.safeParse({ passwordHash: 'x' }).success).toBe(false);
    expect(updateUserDto.safeParse({ name: '' }).success).toBe(false);
  });
  it('DT-06 an administrative operation body is exactly { idempotencyKey }', () => {
    expect(adminOperationDto.parse({ idempotencyKey: KEY })).toEqual({ idempotencyKey: KEY });
    expect(adminOperationDto.safeParse({}).success).toBe(false);
    expect(adminOperationDto.safeParse({ idempotencyKey: KEY, password: 'x' }).success).toBe(false);
  });
});
