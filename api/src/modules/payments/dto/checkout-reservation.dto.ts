// R3-A4.3 S2: HTTP contract of POST /sales/:saleId/checkout/reservations (T-R),
// and of its supervised recovery variant T-RR (the same body plus `recovery`).
// Contract: consolidated §3, last-REVISE §3.2.
//
// Boundary only: the output is exactly the plan the server seals, in the
// canonical types of checkout-canonical.ts. The service validates again under
// lock (quote, cash session, collections, permissions).
import { z } from 'zod';
import type { CheckoutMethod, PlanTenderInput } from '../checkout-canonical.js';
import {
  canonicalUuid,
  checkoutMethod,
  moneyString,
  saleIdParams,
  supervisorJustification,
  tenderRole,
  tenderSource,
  safeBigInt,
  toBigInt,
} from './checkout-fields.js';

export const checkoutReservationParamsDto = saleIdParams;

// chk_tender_shape at the edge:
//   BALANCE + NEW, no amount, no collection;
//   FIXED + NEW, amount > 0, no collection;
//   FIXED + COLLECTION, TRANSFER/CARD_DEBIT/CARD_CREDIT/QR only, amount > 0 and the collection id.
const planTender = z.object({
  method: checkoutMethod,
  role: tenderRole,
  source: tenderSource,
  amount: moneyString.optional(),
  externalCollectionId: canonicalUuid.optional(),
}).strict().superRefine((tender, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
  const amount = safeBigInt(tender.amount);
  if (tender.role === 'BALANCE') {
    if (tender.source !== 'NEW') issue('source', 'El medio de saldo es siempre dinero nuevo.');
    if (tender.amount !== undefined) issue('amount', 'El medio de saldo no lleva importe: lo calcula el servidor.');
    if (tender.externalCollectionId !== undefined) issue('externalCollectionId', 'El medio de saldo no imputa cobros externos.');
    return;
  }
  if (tender.amount === undefined || (amount !== null && amount <= 0n)) issue('amount', 'Un importe fijo debe ser mayor que cero.');
  if (tender.source === 'NEW') {
    if (tender.externalCollectionId !== undefined) issue('externalCollectionId', 'Un medio nuevo no lleva cobro externo.');
    return;
  }
  if (tender.method === 'CASH') issue('method', 'El efectivo nunca es un cobro externo.');
  if (tender.externalCollectionId === undefined) issue('externalCollectionId', 'Un medio COLLECTION requiere el cobro externo.');
});

export type CheckoutReservationRequest = {
  reserveKey: string;
  cashSessionId: string;
  balanceMethod: CheckoutMethod;
  expectedTotal: bigint;
  expectedBalanceAmount: bigint;
  tenders: PlanTenderInput[];
  recovery: { reason: string; evidence: string } | null;
};

export const checkoutReservationDto = z.object({
  reserveKey: canonicalUuid,
  cashSessionId: canonicalUuid,
  balanceMethod: checkoutMethod,
  expectedTotal: moneyString,
  expectedBalanceAmount: moneyString,
  tenders: z.array(planTender).min(1).max(3),
  // T-RR only; never part of the plan hash.
  recovery: supervisorJustification.optional(),
}).strict().superRefine((input, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
  const methods = new Set<string>();
  let balances = 0;
  for (const [index, tender] of input.tenders.entries()) {
    if (methods.has(tender.method)) issue(['tenders', index, 'method'], 'Los medios de pago no pueden repetirse.');
    methods.add(tender.method);
    if (tender.role !== 'BALANCE') continue;
    balances += 1;
    if (tender.method !== input.balanceMethod) issue(['tenders', index, 'method'], 'El medio de saldo no coincide con balanceMethod.');
  }
  if (balances !== 1) issue(['tenders'], 'Se requiere exactamente un medio de saldo.');
  // chk_attempt_plan parity: total > 0; the balance is a whole-peso amount >= $1.
  const total = safeBigInt(input.expectedTotal);
  if (total !== null && total <= 0n) issue(['expectedTotal'], 'El total debe ser mayor que cero.');
  const balance = safeBigInt(input.expectedBalanceAmount);
  if (balance !== null && (balance < 100n || balance % 100n !== 0n)) issue(['expectedBalanceAmount'], 'El saldo debe ser un importe en pesos enteros de al menos $1.');
}).transform((input): CheckoutReservationRequest => ({
  reserveKey: input.reserveKey,
  cashSessionId: input.cashSessionId,
  balanceMethod: input.balanceMethod,
  expectedTotal: toBigInt(input.expectedTotal),
  expectedBalanceAmount: toBigInt(input.expectedBalanceAmount),
  tenders: input.tenders.map((tender): PlanTenderInput => ({
    method: tender.method,
    role: tender.role,
    source: tender.source,
    amount: tender.amount === undefined ? null : toBigInt(tender.amount),
    externalCollectionId: tender.externalCollectionId ?? null,
  })),
  recovery: input.recovery ?? null,
}));
