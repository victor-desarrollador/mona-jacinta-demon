// R3-A4.3 S2: HTTP contract of POST /sales/:saleId/checkout/reservations/:reserveKey/close
// (T-X: abandon and/or declare). Contract: consolidated §3 and §7, C1–C5 §9.
//
// One row per tender of the plan (the service checks the exact set against the
// sealed plan, and that a COLLECTION tender is declared only NONE):
//   CASH: NONE, or RETURNED with returnedAmount > 0 and evidence (no RETAINED);
//   TRANSFER/CARD_DEBIT/CARD_CREDIT: NONE, or CHARGED with amount > 0, reference, evidence,
//   and the institution for TRANSFER (OTHER with its label).
// Evidence is optional on NONE because a non-initiator (supervisor) must give
// it on every row (F4); the service enforces that. Boundary only.
import { z } from 'zod';
import type { CheckoutMethod, TransferInstitutionName } from '../checkout-canonical.js';
import { normalizeReferenceKey } from '../checkout-canonical.js';
import {
  boundedText,
  canonicalUuid,
  checkoutMethod,
  institutionOtherString,
  moneyString,
  referenceString,
  safeBigInt,
  supervisorJustification,
  toBigInt,
  transferInstitution,
} from './checkout-fields.js';

export const checkoutCloseParamsDto = z.object({ saleId: canonicalUuid, reserveKey: canonicalUuid }).strict();

const declarationOutcome = z.enum(['NONE', 'CHARGED', 'RETURNED']);

const declaration = z.object({
  method: checkoutMethod,
  outcome: declarationOutcome,
  returnedAmount: moneyString.optional(),
  amount: moneyString.optional(),
  reference: referenceString.optional(),
  institution: transferInstitution.optional(),
  institutionOther: institutionOtherString.optional(),
  evidence: boundedText(3, 200).optional(),
}).strict().superRefine((row, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
  const chargeFields = row.amount !== undefined || row.reference !== undefined || row.institution !== undefined || row.institutionOther !== undefined;
  if (row.outcome === 'NONE') {
    if (row.returnedAmount !== undefined || chargeFields) issue('outcome', 'Una declaración NONE no lleva importes, referencias ni institución.');
    return;
  }
  if (row.evidence === undefined) issue('evidence', 'La declaración requiere comprobante.');
  if (row.outcome === 'RETURNED') {
    if (row.method !== 'CASH') issue('outcome', 'Solo el efectivo puede declararse devuelto.');
    if (row.returnedAmount === undefined || (safeBigInt(row.returnedAmount) ?? 1n) <= 0n) issue('returnedAmount', 'El importe devuelto debe ser mayor que cero.');
    if (chargeFields) issue('outcome', 'Una devolución de efectivo no lleva datos de cobro externo.');
    return;
  }
  // CHARGED
  if (row.method === 'CASH') issue('outcome', 'El efectivo no se declara como cobro externo.');
  if (row.returnedAmount !== undefined) issue('returnedAmount', 'Un cobro externo no lleva importe devuelto.');
  if (row.amount === undefined || (safeBigInt(row.amount) ?? 1n) <= 0n) issue('amount', 'El importe cobrado debe ser mayor que cero.');
  if (row.reference === undefined) issue('reference', 'El cobro externo requiere referencia.');
  if (row.method === 'TRANSFER') {
    if (row.institution === undefined) issue('institution', 'La transferencia requiere institución.');
    else if (row.institution === 'OTHER' && row.institutionOther === undefined) issue('institutionOther', 'La institución OTHER requiere un nombre.');
    else if (row.institution !== 'OTHER' && row.institutionOther !== undefined) issue('institutionOther', 'institutionOther solo se usa con la institución OTHER.');
  } else if (row.institution !== undefined || row.institutionOther !== undefined) {
    issue('institution', row.method === 'CARD_CREDIT' ? 'El crédito no lleva institución.' : 'El débito no lleva institución.');
  }
});

export type CheckoutDeclarationRow = {
  method: CheckoutMethod;
  outcome: 'NONE' | 'CHARGED' | 'RETURNED';
  returnedAmount: bigint | null;
  amount: bigint | null;
  reference: string | null;
  referenceKey: string | null;
  institution: TransferInstitutionName | null;
  institutionOther: string | null;
  evidence: string | null;
};

export type CheckoutCloseRequest = {
  supervisor: { reason: string; evidence: string } | null;
  declarations: CheckoutDeclarationRow[];
};

export const checkoutCloseDto = z.object({
  supervisor: supervisorJustification.optional(),
  declarations: z.array(declaration).min(1).max(3),
}).strict().superRefine((input, context) => {
  const methods = new Set<string>();
  for (const [index, row] of input.declarations.entries()) {
    if (methods.has(row.method)) context.addIssue({ code: 'custom', path: ['declarations', index, 'method'], message: 'Un renglón por medio de pago.' });
    methods.add(row.method);
  }
}).transform((input): CheckoutCloseRequest => ({
  supervisor: input.supervisor ?? null,
  declarations: input.declarations.map((row): CheckoutDeclarationRow => ({
    method: row.method,
    outcome: row.outcome,
    returnedAmount: row.returnedAmount === undefined ? null : toBigInt(row.returnedAmount),
    amount: row.amount === undefined ? null : toBigInt(row.amount),
    reference: row.reference ?? null,
    referenceKey: row.reference === undefined ? null : normalizeReferenceKey(row.reference),
    institution: row.institution ?? null,
    institutionOther: row.institutionOther ?? null,
    evidence: row.evidence ?? null,
  })),
}));
