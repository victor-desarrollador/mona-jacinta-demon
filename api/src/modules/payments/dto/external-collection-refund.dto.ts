// R3-A4.3 S-REF: HTTP contract of POST /api/v1/external-collections/:id/refund
// (T-F) and of GET /api/v1/external-collections (branch listing).
//
// Boundary only: the service is the authority (it locks, checks, writes and
// audits). The refund carries NO amount — the amount is read exclusively from
// the locked ExternalCollection row.
//
// OWNER decision (S-REF): refundReference is a raw reference of 3..64 Unicode
// code points whose canonical form is /^[A-Z0-9]{3,64}$/ — deliberately NOT the
// 3..40 of REFERENCE_KEY (checkout-canonical.ts), which the collection itself
// keeps for its own referenceKey. The RAW TRIMMED value is what gets persisted;
// the canonical form is computed by the service for the replay comparison and
// never travels from the client.
import { z } from 'zod';
import { codePoints, normalizeReferenceKey } from '../checkout-canonical.js';
import { boundedText, canonicalUuid } from './checkout-fields.js';

export const externalCollectionParamsDto = z.object({ externalCollectionId: canonicalUuid }).strict();

export const REFUND_REFERENCE_MIN_CODE_POINTS = 3;
export const REFUND_REFERENCE_MAX_CODE_POINTS = 64;
// The refund reference canonical key is wider than REFERENCE_KEY on purpose.
export const REFUND_REFERENCE_KEY = /^[A-Z0-9]{3,64}$/;

export const refundReferenceString = z.string()
  .transform((value) => value.trim())
  .refine(
    (value) => codePoints(value) >= REFUND_REFERENCE_MIN_CODE_POINTS && codePoints(value) <= REFUND_REFERENCE_MAX_CODE_POINTS,
    'La referencia debe tener entre 3 y 64 caracteres.',
  )
  .refine((value) => REFUND_REFERENCE_KEY.test(normalizeReferenceKey(value)), 'La referencia no tiene un formato válido.');

// S-REF.1 (A2): an explicit ISO-8601 instant with an offset is validated
// STRICTLY. `Date.parse` alone silently normalises impossible values
// (`2026-02-30T00:00:00Z` -> 2026-03-02, `24:00:00` -> the next day 00:00), so
// the calendar/clock components are re-derived from the exact instant and every
// one must match the text. Anything that is not an exact instant is rejected
// BEFORE the service or any UPDATE. Valid offsets (including non-Z) are kept.
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function parseStrictIsoInstant(value: string): Date | null {
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, fraction, zone, sign, offsetHour, offsetMinute] = match;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number) as [number, number, number, number, number, number];
  const ms = fraction === undefined ? 0 : Number(fraction.padEnd(3, '0'));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  let offsetMinutes = 0;
  if (zone !== 'Z') {
    const oh = Number(offsetHour);
    const om = Number(offsetMinute);
    if (oh > 23 || om > 59) return null;
    offsetMinutes = (sign === '-' ? -1 : 1) * (oh * 60 + om);
  }
  const instant = Date.UTC(y, mo - 1, d, h, mi, s, ms) - offsetMinutes * 60_000;
  // Re-derive the textual components from the exact instant in the SAME offset:
  // a mismatch means V8 normalised an impossible value and it must be refused.
  const local = new Date(instant + offsetMinutes * 60_000);
  if (
    local.getUTCFullYear() !== y || local.getUTCMonth() !== mo - 1 || local.getUTCDate() !== d
    || local.getUTCHours() !== h || local.getUTCMinutes() !== mi || local.getUTCSeconds() !== s
    || local.getUTCMilliseconds() !== ms
  ) return null;
  return new Date(instant);
}

export type ExternalCollectionRefundRequest = {
  // Raw, trimmed (what is persisted); the canonical key is recomputed in the service.
  refundReference: string;
  externalRefundedAt: Date;
  // Trimmed 10..500 (chk_ec_refund_fields).
  reason: string;
};

export const externalCollectionRefundDto = z.object({
  refundReference: refundReferenceString,
  externalRefundedAt: z.string()
    .refine((value) => parseStrictIsoInstant(value) !== null, 'externalRefundedAt debe ser una fecha ISO-8601 exacta.')
    .transform((value) => parseStrictIsoInstant(value)!),
  reason: boundedText(10, 500),
}).strict().transform((input): ExternalCollectionRefundRequest => ({
  refundReference: input.refundReference,
  externalRefundedAt: input.externalRefundedAt,
  reason: input.reason,
}));

// ---------------------------------------------------------------------------
// GET /api/v1/external-collections — branch listing query.
// ---------------------------------------------------------------------------
export const EXTERNAL_COLLECTION_LIST_DEFAULT_LIMIT = 100;
export const EXTERNAL_COLLECTION_LIST_MAX_LIMIT = 100;

export type ExternalCollectionStatusName = 'APPLIED' | 'UNAPPLIED' | 'REFUNDED';
export type ExternalCollectionListQuery = {
  branchId: string;
  status: ExternalCollectionStatusName | null;
  limit: number;
};

export const externalCollectionListQueryDto = z.object({
  branchId: canonicalUuid,
  status: z.enum(['APPLIED', 'UNAPPLIED', 'REFUNDED']).optional(),
  limit: z.string()
    .regex(/^[1-9][0-9]{0,2}$/, 'limit inválido.')
    .refine((value) => Number(value) <= EXTERNAL_COLLECTION_LIST_MAX_LIMIT, `limit no puede superar ${EXTERNAL_COLLECTION_LIST_MAX_LIMIT}.`)
    .optional(),
}).strict().transform((query): ExternalCollectionListQuery => ({
  branchId: query.branchId,
  status: query.status ?? null,
  limit: query.limit === undefined ? EXTERNAL_COLLECTION_LIST_DEFAULT_LIMIT : Number(query.limit),
}));
