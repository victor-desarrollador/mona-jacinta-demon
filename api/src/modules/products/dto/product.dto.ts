import { z } from 'zod';

export const productIdSchema = z.object({ id: z.string().uuid() });

export const productQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().min(1).max(100).optional(),
  isActive: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true')
});

export type ProductQuery = z.infer<typeof productQuerySchema>;