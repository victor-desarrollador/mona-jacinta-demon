// R3-A4.3 S2: wire primitives shared by the durable-checkout DTOs (reservation,
// confirmation, close/declaration, stock recovery). Boundary only: they never
// price, total or touch a database. The canonical rules (UUID form, BIGINT
// range, reference key, methods, institutions) come from checkout-canonical.ts
// so the edge and the hash can never disagree.
import { z } from 'zod';
import {
  CANONICAL_UUID,
  CHECKOUT_METHODS,
  MAX_PG_BIGINT,
  REFERENCE_KEY,
  REFERENCE_RAW_MAX,
  TENDER_ROLES,
  TENDER_SOURCES,
  TRANSFER_INSTITUTIONS,
  codePoints,
  normalizeInstitutionOther,
  normalizeReferenceKey,
} from '../checkout-canonical.js';

// Canonical lowercase UUID v4: TEXT ids are compared case-sensitively.
export const canonicalUuid = z.string().regex(CANONICAL_UUID, 'Debe ser un UUID v4 en minúsculas.');

// Integer centavos as a decimal string: no sign, no leading zeroes, no decimals,
// at most the PostgreSQL BIGINT maximum. Never a JSON number.
export const moneyString = z.string().regex(/^(0|[1-9][0-9]*)$/, 'Importe inválido.')
  .refine((value) => {
    try {
      return BigInt(value) <= MAX_PG_BIGINT;
    } catch {
      return false;
    }
  }, 'El importe supera el máximo admitido.');

export const toBigInt = (value: string): bigint => BigInt(value);

// For refinements: zod still runs them when an earlier check failed, so a
// malformed string must not throw there. null = not a valid centavo integer.
export const safeBigInt = (value: string | undefined): bigint | null => {
  if (value === undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  return BigInt(value);
};

// PROPORTIONAL_V1 accepts only these three: CARD_CREDIT and QR are refused.
export const checkoutMethod = z.enum(CHECKOUT_METHODS);
export const tenderRole = z.enum(TENDER_ROLES);
export const tenderSource = z.enum(TENDER_SOURCES);
export const transferInstitution = z.enum(TRANSFER_INSTITUTIONS);

// Unicode code points, as PostgreSQL char_length counts them. Re-exported from
// the canonical module so the boundary and the service share ONE definition.
export { codePoints };

// Trimmed text bounded in code points. The trimmed value is what travels on, so
// the database btrim/char_length CHECKs see exactly the measured string.
export const boundedText = (min: number, max: number) => z.string()
  .transform((value) => value.trim())
  .refine((value) => codePoints(value) >= min && codePoints(value) <= max, `Debe tener entre ${min} y ${max} caracteres.`);

export const supervisorJustification = z.object({
  reason: boundedText(10, 500),
  evidence: boundedText(3, 200),
}).strict();

// A non-cash reference as typed by the cashier: 1..64 code points raw
// (chk_ec_reference), and a normalised key of [A-Z0-9]{3,40}.
export const referenceString = z.string()
  .refine((value) => codePoints(value) >= 1 && codePoints(value) <= REFERENCE_RAW_MAX, 'La referencia debe tener entre 1 y 64 caracteres.')
  .refine((value) => REFERENCE_KEY.test(normalizeReferenceKey(value)), 'La referencia no tiene un formato válido.');

// The free-text label of institution OTHER, delivered in its single normal
// form (trim → NFC, shared with the hash) and bounded to 1..60 code points of
// that form.
export const institutionOtherString = z.string()
  .transform(normalizeInstitutionOther)
  .refine((value) => codePoints(value) >= 1 && codePoints(value) <= 60, 'Debe tener entre 1 y 60 caracteres.');

export const saleIdParams = z.object({ saleId: canonicalUuid }).strict();
