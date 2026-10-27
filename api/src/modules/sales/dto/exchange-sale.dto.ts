import { z } from 'zod';

// Sale exchange v1 (COMPLETED sale -> garment swap). Shape only: every rule that needs the database (sale state,
// ownership of the saleItem, exchangeable quantity, stock, price equality) lives in sale-exchange.service.ts.
//
//   reason           free text, trimmed, 1..200
//   idempotencyKey   UUID v4, like every other idempotent operation
//   lines            1..100; a saleItem may appear once
//     returnQuantity BigInt > 0 and <= the signed BIGINT maximum (the quantity of THAT saleItem handed back)
//
// TWO entry points over ONE set of rules (`build`), so no business rule is written twice:
//   exchangeSaleHttpDto  the HTTP edge. returnQuantity is a canonical positive decimal STRING and nothing else: a JSON number of ANY size is refused
//                        (JSON.parse has already rounded the ones above 2^53, and there is no raw-body parsing), so Number never enters the system.
//                        Output: the same shape as the domain input (returnQuantity already a BigInt).
//   exchangeSaleDto      the domain input the service validates again (and the one direct service callers use): returnQuantity is already a BigInt.
export const SALE_EXCHANGE_REASON_MAX = 200;
// Bounds the work one request can open (locks, pricing reads, ledger rows). The system has no canonical max of items per sale; the closest precedent is
// pending-correction.dto (items.max(100)).
export const SALE_EXCHANGE_LINES_MAX = 100;
const MAX_SIGNED_BIGINT = 9223372036854775807n;

const domainQuantity = z.bigint().positive().max(MAX_SIGNED_BIGINT);
// ^[1-9][0-9]*$ : no sign, no leading zero, no exponent, fraction, space, hex or non-ASCII digit. At most 19 digits (the digit count of the BIGINT maximum), so
// an absurdly long string is refused before any conversion.
const httpQuantity = z.string().max(19).regex(/^[1-9][0-9]*$/).transform((value) => BigInt(value)).pipe(domainQuantity);
// Lowercased: a UUID is stored and compared as text, so one UUID must have exactly one spelling.
const lowerUuid = z.uuid().transform((value) => value.toLowerCase());

const build = <Q extends z.ZodType<bigint>>(returnQuantity: z.ZodType<bigint, unknown> & Q) => z.object({
  reason: z.string().trim().min(1).max(SALE_EXCHANGE_REASON_MAX),
  idempotencyKey: z.uuid({ version: 'v4' }).transform((value) => value.toLowerCase()),
  lines: z.array(z.object({ saleItemId: lowerUuid, replacementVariantId: lowerUuid, returnQuantity }).strict()).min(1).max(SALE_EXCHANGE_LINES_MAX),
}).strict().superRefine((input, context) => {
  const seen = new Set<string>();
  for (const [index, line] of input.lines.entries()) {
    if (seen.has(line.saleItemId)) {
      context.addIssue({ code: 'custom', path: ['lines', index, 'saleItemId'], message: 'Un artículo de la venta solo puede aparecer una vez.' });
    }
    seen.add(line.saleItemId);
  }
});

export const exchangeSaleDto = build(domainQuantity);
export const exchangeSaleHttpDto = build(httpQuantity);

export type ExchangeSaleInput = z.output<typeof exchangeSaleDto>;
