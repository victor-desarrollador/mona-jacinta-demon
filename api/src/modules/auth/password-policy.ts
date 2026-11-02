import { AppError } from '../../shared/errors.js';

// USER-MGMT-01 U1 — password policy. 10..72 UTF-8 BYTES (bcrypt only hashes the first 72 BYTES, so the limit is in bytes and
// never in characters), no composition rules, different from the account email and, for an own change, from the current password.
// The password is never trimmed (spaces are part of it), never echoed in an error and never put in `details`.
export const PASSWORD_MIN_BYTES = 10;
export const PASSWORD_MAX_BYTES = 72;

const violation = (message: string) => new AppError(400, 'PASSWORD_POLICY_VIOLATION', message);
const normalizeEmail = (value: string) => value.trim().toLowerCase();

export function assertPasswordPolicy(input: { password: string; email: string; currentPassword?: string }): void {
  const { password, email, currentPassword } = input;
  if (typeof password !== 'string') throw violation('La contraseña es obligatoria.');
  const bytes = Buffer.byteLength(password, 'utf8');
  if (bytes < PASSWORD_MIN_BYTES || bytes > PASSWORD_MAX_BYTES) {
    throw violation(
      `La contraseña debe tener entre ${PASSWORD_MIN_BYTES} y ${PASSWORD_MAX_BYTES} bytes (las letras con acento ocupan más de uno).`,
    );
  }
  if (normalizeEmail(password) === normalizeEmail(email)) {
    throw violation('La contraseña no puede ser igual al correo electrónico.');
  }
  if (currentPassword !== undefined && password === currentPassword) {
    throw violation('La nueva contraseña debe ser distinta de la actual.');
  }
}
