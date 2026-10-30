import { z } from 'zod';

// GET /sales/exchangeable?branchId=&saleNumber= — the two halves of a sale's own unique key (Sale @@unique([branchId, saleNumber])).
// Shape only: authorization and existence live in sale-exchange-read.service.ts. Lowercased UUID: one spelling per id.
export const SALE_NUMBER_MAX = 40;

export const exchangeableSaleQueryDto = z.object({
  branchId: z.uuid().transform((value) => value.toLowerCase()),
  saleNumber: z.string().trim().min(1).max(SALE_NUMBER_MAX),
}).strict();

export type ExchangeableSaleQuery = z.output<typeof exchangeableSaleQueryDto>;
