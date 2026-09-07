import { z } from 'zod';

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