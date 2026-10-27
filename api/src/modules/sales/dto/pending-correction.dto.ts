import { z } from 'zod';

// Pilot P0.2-A: the complete target item list of a PENDING_PAYMENT sale.
// Quantities are positive integer strings (BigInt, never floats); one entry
// per variant, so every corrected sale keeps one SaleItem per variant. An
// empty list is rejected: an empty sale is never valid (send-to-cashier and
// hold coverage both refuse it) — cancel the sale instead.
const quantity = z.string().regex(/^[1-9][0-9]{0,8}$/).transform((value) => BigInt(value));

export const correctPendingSaleDto = z.object({
  items: z.array(z.object({ variantId: z.uuid(), quantity }).strict()).min(1).max(100),
}).strict().superRefine((input, context) => {
  const seen = new Set<string>();
  input.items.forEach((item, index) => {
    if (seen.has(item.variantId)) {
      context.addIssue({ code: 'custom', path: ['items', index, 'variantId'], message: 'La variante está repetida.' });
    }
    seen.add(item.variantId);
  });
});

export type CorrectPendingSaleInput = z.output<typeof correctPendingSaleDto>;
