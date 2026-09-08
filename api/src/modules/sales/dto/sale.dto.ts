import { z } from 'zod';

export const createDraftSaleDto = z
  .object({ branchId: z.uuid().optional() })
  .strict();

export const saleIdDto = z.object({ saleId: z.uuid() }).strict();

export type CreateDraftSaleInput = z.infer<typeof createDraftSaleDto>;