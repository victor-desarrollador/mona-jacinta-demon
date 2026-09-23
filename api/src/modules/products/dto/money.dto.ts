import { z } from 'zod';

// D3: integer-cent money as a JSON string, the same convention as
// payments/dto (never a JSON number, never a decimal): parsed straight to
// BigInt, so no floating-point conversion is ever possible.
const MAX_BIGINT = 9223372036854775807n;

// Zod keeps running refinements after a failed regex, so every BigInt()
// here must tolerate non-integer input (a thrown SyntaxError would escape
// validation as a 500 instead of a 400).
function toCents(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

const centsString = z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => {
  const cents = toCents(value);
  return cents !== null && cents <= MAX_BIGINT;
});

export const nonNegativeCents = centsString.transform((value) => BigInt(value));

export const positiveCents = centsString
  .refine((value) => (toCents(value) ?? 0n) > 0n, { message: 'El importe debe ser mayor que cero.' })
  .transform((value) => BigInt(value));
