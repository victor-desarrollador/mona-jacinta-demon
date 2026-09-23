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

// D3: minimum real Product create contract (schema: name, slug, categoryId,
// brandId required; description optional and deliberately not accepted
// here). Slug is a lowercase kebab-case identifier; uniqueness is enforced
// by the service (409) and the database.
export const createProductSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    slug: z.string().trim().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    categoryId: z.uuid(),
    brandId: z.uuid(),
  })
  .strict();

export type CreateProductInput = z.infer<typeof createProductSchema>;
