import { z } from 'zod';

// Pilot P0.2-B: the structured business reason is the authoritative category;
// the note is free text. OTHER requires a nonblank note. The note is trimmed
// and stored in the audit only.
export const CANCELLATION_REASONS = [
  'WRONG_ITEM',
  'WRONG_QUANTITY',
  'CUSTOMER_CHANGED_MIND',
  'DUPLICATE_SALE',
  'OTHER',
] as const;

export const cancelSaleDto = z.object({
  reason: z.enum(CANCELLATION_REASONS),
  note: z.string().trim().max(500).optional(),
}).strict().superRefine((input, context) => {
  if (input.reason === 'OTHER' && !input.note) {
    context.addIssue({ code: 'custom', path: ['note'], message: 'Indicá el motivo de la cancelación.' });
  }
}).transform((input) => ({ reason: input.reason, ...(input.note ? { note: input.note } : {}) }));

export type CancelSaleInput = z.output<typeof cancelSaleDto>;
