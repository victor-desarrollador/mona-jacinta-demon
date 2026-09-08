import { z } from 'zod';

// PostgreSQL signed BIGINT, parsed without a floating-point intermediate.
const cashAmount = z.string().regex(/^\d+$/).transform((value) => BigInt(value))
  .refine((value) => value <= 9223372036854775807n, 'El importe excede el límite permitido.');
export const cashBranchDto = z.object({ branchId: z.uuid() }).strict();
export const openCashDto = z.object({ registerId: z.uuid(), startingCash: cashAmount }).strict();
export const closeCashDto = z.object({ closingCash: cashAmount }).strict();
export const cashSessionParamsDto = z.object({ sessionId: z.uuid() });
