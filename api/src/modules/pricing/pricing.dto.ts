import { z } from 'zod';
import { MAX_PRICE_ADJUSTMENT_BPS, PRICE_MODES } from './pricing.js';

export const priceModeSchema = z.enum(PRICE_MODES);

const adjustment = z.number().int().min(0).max(MAX_PRICE_ADJUSTMENT_BPS);

export const updatePricingConfigSchema = z
  .object({
    LIST: adjustment.optional(),
    CREDIT_CARD: adjustment.optional(),
    DEBIT_CARD: adjustment.optional(),
    BANK_TRANSFER: adjustment.optional(),
    QR: adjustment.optional(),
  })
  .strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: 'Debe indicar al menos un ajuste.',
  });

export const updateSalePriceModeDto = z.object({ priceMode: priceModeSchema }).strict();

export type UpdatePricingConfigInput = z.infer<typeof updatePricingConfigSchema>;
