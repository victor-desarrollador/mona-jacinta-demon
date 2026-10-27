import { z } from 'zod';

// Sale void v1 (post-payment void, PAID | COMPLETED -> CANCELLED). Shape only: every rule that needs the
// database (which payments the sale has, whether they are CASH or external, the cash session) lives in
// sale-void.service.ts.
//
//   reason           free text, trimmed, 1..200 (not the pre-payment /cancel catalog)
//   idempotencyKey   UUID v4, like every other idempotent operation (payments, cash movements)
//   cashSessionId    optional here; the service requires it only when the sale has a CASH payment
//   externalRefunds  optional here; the service requires exactly one entry per external payment
//                    (TRANSFER / CARD_DEBIT / CARD_CREDIT / QR): the evidence that the money went back
//                    outside the POS, trimmed, 1..200. A payment may appear once.
export const SALE_VOID_REASON_MAX = 200;
export const SALE_VOID_EVIDENCE_MAX = 200;

const externalRefundDto = z.object({
  salePaymentId: z.uuid(),
  evidence: z.string().trim().min(1).max(SALE_VOID_EVIDENCE_MAX),
}).strict();

export const voidSaleDto = z.object({
  reason: z.string().trim().min(1).max(SALE_VOID_REASON_MAX),
  idempotencyKey: z.uuid({ version: 'v4' }),
  cashSessionId: z.uuid().optional(),
  externalRefunds: z.array(externalRefundDto).max(50).optional(),
}).strict().superRefine((input, context) => {
  const seen = new Set<string>();
  for (const [index, refund] of (input.externalRefunds ?? []).entries()) {
    if (seen.has(refund.salePaymentId)) {
      context.addIssue({ code: 'custom', path: ['externalRefunds', index, 'salePaymentId'], message: 'Un pago solo puede tener una evidencia de reintegro.' });
    }
    seen.add(refund.salePaymentId);
  }
}).transform((input) => ({
  reason: input.reason,
  idempotencyKey: input.idempotencyKey,
  ...(input.cashSessionId ? { cashSessionId: input.cashSessionId } : {}),
  externalRefunds: input.externalRefunds ?? [],
}));

export type VoidSaleInput = z.output<typeof voidSaleDto>;
