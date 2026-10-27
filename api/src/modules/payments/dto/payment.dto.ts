import { z } from 'zod';
import type { PaymentMethod } from '../../../generated/prisma/client.js';

const MAX_BIGINT = 9223372036854775807n;
const moneyString = z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => {
  try {
    return BigInt(value) <= MAX_BIGINT;
  } catch {
    return false;
  }
});

const paymentMethod = z.enum(['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR']);
const parseMoney = (value: string) => {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

export const paymentParamsDto = z.object({ saleId: z.uuid() }).strict();

export const registerPaymentDto = z.object({
  method: paymentMethod,
  amount: moneyString,
  receivedAmount: moneyString.nullish(),
  idempotencyKey: z.uuid({ version: 'v4' }),
}).strict().superRefine((input, context) => {
  const amount = parseMoney(input.amount);
  if (amount === 0n) context.addIssue({ code: 'custom', path: ['amount'], message: 'El importe debe ser mayor que cero.' });

  if (input.method === 'CASH') {
    if (input.receivedAmount == null) {
      context.addIssue({ code: 'custom', path: ['receivedAmount'], message: 'El efectivo recibido es obligatorio.' });
    } else if (parseMoney(input.receivedAmount) < amount) {
      context.addIssue({ code: 'custom', path: ['receivedAmount'], message: 'El efectivo recibido no puede ser menor al importe.' });
    }
  }

  if (input.method !== 'CASH' && input.receivedAmount != null) {
    context.addIssue({ code: 'custom', path: ['receivedAmount'], message: 'El efectivo recibido solo corresponde a pagos en efectivo.' });
  }
}).transform((input) => ({
  method: input.method as PaymentMethod,
  amount: parseMoney(input.amount),
  receivedAmount: input.receivedAmount == null ? null : parseMoney(input.receivedAmount),
  idempotencyKey: input.idempotencyKey,
}));

export type RegisterPaymentInput = z.output<typeof registerPaymentDto>;