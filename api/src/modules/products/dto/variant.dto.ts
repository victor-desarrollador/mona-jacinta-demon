import { z } from 'zod';
import { nonNegativeCents, positiveCents } from './money.dto.js';

export const variantIdSchema = z.object({ id: z.string().uuid() });

export const variantQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(100).optional(),
  productId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  isActive: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true')
});

export type VariantQuery = z.infer<typeof variantQuerySchema>;

// D3: minimum real ProductVariant create contract (schema: productId, sku,
// barcode, price, costPrice required; color/size optional). Sell price must
// be positive; cost may be zero.
export const createVariantSchema = z
  .object({
    productId: z.uuid(),
    sku: z.string().trim().min(1).max(64),
    barcode: z.string().trim().min(1).max(64),
    color: z.string().trim().min(1).max(60).optional(),
    size: z.string().trim().min(1).max(30).optional(),
    price: positiveCents,
    costPrice: nonNegativeCents,
  })
  .strict();

export type CreateVariantInput = z.infer<typeof createVariantSchema>;

// D3: changes the sell price only — costPrice is not accepted (strict).
export const updateVariantPriceSchema = z.object({ price: positiveCents }).strict();

export type UpdateVariantPriceInput = z.infer<typeof updateVariantPriceSchema>;
