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
// barcode, cashPrice, legacy LIST price and costPrice required; color/size
// optional). Sell prices must be positive; cost may be zero.
export const createVariantSchema = z
  .object({
    productId: z.uuid(),
    sku: z.string().trim().min(1).max(64),
    barcode: z.string().trim().min(1).max(64),
    color: z.string().trim().min(1).max(60).optional(),
    size: z.string().trim().min(1).max(30).optional(),
    cashPrice: positiveCents,
    price: positiveCents,
    // Pilot Pricing V2: optional; omitted means the variant has no wholesale cash base.
    wholesalePrice: positiveCents.optional(),
    costPrice: nonNegativeCents,
  })
  .strict()
  .refine((input) => input.wholesalePrice === undefined || input.wholesalePrice <= input.price, {
    path: ['wholesalePrice'],
    message: 'El precio mayorista no puede superar el precio de lista.',
  })
  .refine((input) => input.wholesalePrice === undefined || input.wholesalePrice <= input.cashPrice, {
    path: ['wholesalePrice'],
    message: 'El precio mayorista no puede superar el precio efectivo minorista.',
  });

export type CreateVariantInput = z.infer<typeof createVariantSchema>;

// D3: changes sell prices only — costPrice is not accepted (strict).
// Pilot Pricing V2: cash/list/wholesale price; wholesalePrice null clears it.
// The wholesale <= list rule is checked by the service against the locked
// row, since either side may be omitted here.
export const updateVariantPriceSchema = z
  .object({ cashPrice: positiveCents.optional(), price: positiveCents.optional(), wholesalePrice: positiveCents.nullable().optional() })
  .strict()
  .refine((input) => input.cashPrice !== undefined || input.price !== undefined || input.wholesalePrice !== undefined, {
    message: 'Debe indicar al menos un precio.',
  });

export type UpdateVariantPriceInput = z.infer<typeof updateVariantPriceSchema>;
