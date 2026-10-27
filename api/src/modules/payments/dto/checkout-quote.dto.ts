// R3-A4.1 (R3 rev. 2 §5): HTTP contract of POST /sales/:saleId/checkout/quote.
//
// Boundary only. It turns the wire JSON into exactly the CheckoutQuoteRequest
// the quote service consumes: money travels as decimal centavo strings and
// becomes BigInt (never Number). It never prices, never totals, never opens a
// transaction and never touches a database: the R3-A1 engine stays the only
// pricing authority and it validates the business rules on its own.
//
// What the edge enforces and what it deliberately leaves to the engine:
//   * the five proportional methods only (anything else is 400 here);
//   * 0..2 fixed tenders, integer centavos >= 1, `.strict()` shape;
//   * duplicate methods, a balance method that is also fixed, coverage and a
//     sub-peso balance are ENGINE rules (409 with their own stable codes), so
//     they are not re-implemented here.
// A value above int8 is not clamped here even though it fits the 19-digit
// bound: AMOUNT_OVERFLOW is the engine's own 409 code and stays reachable.
import { z } from 'zod';
import type { CheckoutQuoteRequest } from '../checkout-quote.service.js';

// Integer centavos as a decimal string: no sign, no leading zeroes, and at most
// 19 digits (the width of a signed 64-bit integer).
const centavosString = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);

const quoteMethod = z.enum(['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR']);

const quoteTenderDto = z
  .object({
    method: quoteMethod,
    amount: centavosString,
  })
  .strict()
  .superRefine((tender, context) => {
    if (BigInt(tender.amount) < 1n) {
      context.addIssue({ code: 'custom', path: ['amount'], message: 'Un importe fijo debe ser mayor que cero.' });
    }
  });

export const checkoutQuoteRequestDto = z
  .object({
    balanceMethod: quoteMethod,
    tenders: z.array(quoteTenderDto).max(2),
  })
  .strict()
  .transform((input): CheckoutQuoteRequest => ({
    balanceMethod: input.balanceMethod,
    tenders: input.tenders.map((tender) => ({ method: tender.method, amount: BigInt(tender.amount) })),
  }));
