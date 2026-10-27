import { z } from 'zod';

export const addSaleItemDto = z
  .object({ variantId: z.uuid(), quantity: z.coerce.bigint().positive() })
  .strict();

export const updateSaleItemDto = z
  .object({ quantity: z.coerce.bigint().positive() })
  .strict();

export const saleItemParamsDto = z
  .object({ saleId: z.uuid(), itemId: z.uuid() })
  .strict();

export type AddSaleItemInput = z.infer<typeof addSaleItemDto>;
export type UpdateSaleItemInput = z.infer<typeof updateSaleItemDto>;