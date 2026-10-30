import { z } from 'zod';

// GET /sales/:saleId/exchange-replacements?branchId=&saleItemId=[&search=][&page=][&limit=] — the replacement candidates for ONE SaleItem of a sale.
// Shape only: authorization, existence and pricing live in sale-exchange-replacements.service.ts. Lowercased UUIDs: one spelling per id.
// page / limit / search follow GET /variants (variantQuerySchema), so the same paging works for both.
export const exchangeReplacementsQueryDto = z.object({
  branchId: z.uuid().transform((value) => value.toLowerCase()),
  saleItemId: z.uuid().transform((value) => value.toLowerCase()),
  search: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
}).strict();

export type ExchangeReplacementsQuery = z.output<typeof exchangeReplacementsQueryDto>;
