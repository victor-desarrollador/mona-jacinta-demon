import { randomInt } from 'node:crypto';

// USER-MGMT-01 U2 — the temporary password an administrative create / reset / reactivate issues. It is shown ONCE and never stored (not
// encrypted either): only its bcrypt hash is. 16 symbols drawn uniformly (crypto.randomInt, no modulo bias) from a 57-symbol alphabet without
// the ambiguous characters 0 1 O I l, i.e. ~93.3 bits, displayed as XXXX-XXXX-XXXX-XXXX (19 bytes, inside the 10..72 byte password policy).
export const TEMPORARY_PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
export const TEMPORARY_PASSWORD_PATTERN = /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/;
const SYMBOLS = 16;
const GROUP = 4;

export function generateTemporaryPassword(draw: (max: number) => number = randomInt): string {
  const groups: string[] = [];
  for (let g = 0; g < SYMBOLS / GROUP; g += 1) {
    let group = '';
    for (let i = 0; i < GROUP; i += 1) {
      const index = draw(TEMPORARY_PASSWORD_ALPHABET.length);
      if (!Number.isInteger(index) || index < 0 || index >= TEMPORARY_PASSWORD_ALPHABET.length) throw new RangeError('the random draw is outside the alphabet');
      group += TEMPORARY_PASSWORD_ALPHABET[index];
    }
    groups.push(group);
  }
  return groups.join('-');
}
