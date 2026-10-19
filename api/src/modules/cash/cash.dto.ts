import { z } from 'zod';

// PostgreSQL signed BIGINT, parsed without a floating-point intermediate.
const cashAmount = z.string().regex(/^\d+$/).transform((value) => BigInt(value))
  .refine((value) => value <= 9223372036854775807n, 'El importe excede el límite permitido.');
export const cashBranchDto = z.object({ branchId: z.uuid() }).strict();
export const openCashDto = z.object({ registerId: z.uuid(), startingCash: cashAmount }).strict();
export const closeCashDto = z.object({ closingCash: cashAmount }).strict();
export const cashSessionParamsDto = z.object({ sessionId: z.uuid() });

// PILOT cash exit (WITHDRAWAL/EXPENSE): the route fixes the movement type, so
// the body can never name MANUAL/OPENING/CLOSING/SALE_INCOME or an arbitrary
// type. The amount is a strict integer-cents string (never a float); the reason
// is trimmed to 1..200 characters; the idempotency key is a UUID v4.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// A manual cash exit is always strictly positive (session-open/close cash may
// legitimately be 0, so the shared `cashAmount` is not tightened).
const cashExitAmount = cashAmount.refine((value) => value > 0n, 'El importe debe ser mayor que cero.');
export const cashMovementDto = z.object({
  amount: cashExitAmount,
  reason: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().regex(UUID_V4, 'La clave de idempotencia debe ser un UUID v4.'),
}).strict();

// PILOT cash movement reversal (migration 11): the path names the session and
// the original movement; the body carries only the justification and the
// idempotency key. Strict: amount, type, reversesMovementId and sessionId are
// always decided by the server (the amount is the original's), never accepted.
export const cashMovementParamsDto = z.object({ sessionId: z.uuid(), movementId: z.uuid() });
export const cashMovementReversalDto = z.object({
  reason: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().regex(UUID_V4, 'La clave de idempotencia debe ser un UUID v4.'),
}).strict();
