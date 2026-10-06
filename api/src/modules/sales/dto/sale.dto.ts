import { z } from 'zod';

export const createDraftSaleDto = z
  .object({ branchId: z.uuid().optional() })
  .strict();

export const saleIdDto = z.object({ saleId: z.uuid() }).strict();

// Block 1: the wholesale code travels only in this body. Format rules
// (trim, control characters, bcrypt byte limit) live in the service; the
// generous max only bounds the input before hashing. Zod errors expose path
// and code only, never the submitted value (errorHandler).
export const activateWholesaleDto = z.object({ code: z.string().min(1).max(256) }).strict();

export type CreateDraftSaleInput = z.infer<typeof createDraftSaleDto>;
export type ActivateWholesaleInput = z.infer<typeof activateWholesaleDto>;