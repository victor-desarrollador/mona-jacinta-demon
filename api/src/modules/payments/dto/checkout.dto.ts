// R3-A3.3 (R3 rev. 2 §5): HTTP contract of POST /sales/:saleId/checkout.
//
// Boundary only. The DTO turns the wire JSON into EXACTLY the CheckoutRequest
// the checkout service consumes: money travels as decimal centavo strings and
// becomes BigInt (never Number), and the service's structural rules are
// repeated here so a malformed request dies at the edge with 400. It never
// prices, never totals, never opens a transaction and never touches a database:
// the checkout service (and, through it, the R3-A1 engine) stays the only
// authority, and it validates again on its own.
import { z } from 'zod';
import type { TransferInstitution } from '../../../generated/prisma/client.js';
import {
  normalizeReferenceKey,
  type CheckoutRequest,
  type CheckoutTender,
} from '../checkout.service.js';

const MAX_BIGINT = 9223372036854775807n;

// Integer centavos as a decimal string: no sign, no leading zeroes, no decimals.
const moneyString = z.string().regex(/^(0|[1-9][0-9]*)$/).refine((value) => {
  try {
    return BigInt(value) <= MAX_BIGINT;
  } catch {
    return false;
  }
});

const parseMoney = (value: string) => {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
};

// R3 accepts these three methods and nothing else: CARD_CREDIT and QR are
// rejected at the edge (enabling credit is a code change, never a switch).
const checkoutMethod = z.enum(['CASH', 'TRANSFER', 'CARD_DEBIT']);
const tenderRole = z.enum(['FIXED', 'BALANCE']);
// Mirrors TransferInstitution (prisma/schema.prisma) and the service's own
// private institution list.
const transferInstitution = z.enum(['MACRO', 'BBVA', 'NACION', 'GALICIA', 'MERCADO_PAGO', 'OTHER']);
const MAX_REFERENCE_CODE_POINTS = 64;

export const checkoutParamsDto = z.object({ saleId: z.uuid() }).strict();

const tenderDto = z.object({
  method: checkoutMethod,
  role: tenderRole,
  amount: moneyString.nullish(),
  receivedAmount: moneyString.nullish(),
  changeAmount: moneyString.nullish(),
  reference: z.string().nullish(),
  institution: transferInstitution.nullish(),
  institutionOther: z.string().nullish(),
  externalCollectionId: z.uuid().nullish(),
}).strict().superRefine((tender, context) => {
  const issue = (path: string[], message: string) => context.addIssue({ code: 'custom', path, message });
  const amount = tender.amount == null ? null : parseMoney(tender.amount);
  const received = tender.receivedAmount == null ? null : parseMoney(tender.receivedAmount);

  // Money: a FIXED tender carries its exact centavos (cents allowed); the
  // BALANCE amount is computed by the server and must not be sent.
  if (tender.role === 'FIXED') {
    if (amount === null) issue(['amount'], 'Un importe fijo requiere importe.');
    else if (amount <= 0n) issue(['amount'], 'Un importe fijo debe ser mayor que cero.');
  } else if (tender.amount != null) {
    issue(['amount'], 'El medio de saldo no lleva importe: lo calcula el servidor.');
  }

  if (tender.method === 'CASH') {
    // Cash is the only method with an amount received and with a vuelto; the
    // vuelto itself is informational, recomputed by the server and never
    // forwarded.
    if (tender.reference != null || tender.institution != null || tender.institutionOther != null || tender.externalCollectionId != null) {
      issue(['reference'], 'El efectivo no lleva referencia ni institución.');
    }
    if (tender.receivedAmount == null) issue(['receivedAmount'], 'El efectivo recibido es obligatorio.');
    else if (received !== null && amount !== null && received < amount) {
      issue(['receivedAmount'], 'El efectivo recibido es menor al importe.');
    }
    return;
  }

  if (tender.receivedAmount != null) issue(['receivedAmount'], 'Solo el efectivo lleva importe recibido.');
  if (tender.changeAmount != null) issue(['changeAmount'], 'El vuelto solo corresponde al efectivo.');

  const hasReference = tender.reference != null;
  const hasCollection = tender.externalCollectionId != null;
  if (hasReference === hasCollection) {
    issue(['reference'], 'Débito y transferencia llevan referencia o cobro externo, nunca ambos.');
    return;
  }
  if (hasCollection) {
    // The registered collection already owns the reference and the institution.
    if (tender.role !== 'FIXED') issue(['externalCollectionId'], 'Un cobro externo solo se imputa como importe fijo.');
    if (tender.institution != null || tender.institutionOther != null) {
      issue(['institution'], 'Un cobro externo ya registrado no repite institución.');
    }
    return;
  }

  const reference = tender.reference as string;
  // chk_ec_reference parity: 1..64 characters counted by Unicode code point
  // (PostgreSQL char_length), and a normalised key of 3..40 [A-Z0-9].
  const referenceLength = [...reference].length;
  if (referenceLength < 1 || referenceLength > MAX_REFERENCE_CODE_POINTS) {
    issue(['reference'], 'La referencia debe tener entre 1 y 64 caracteres.');
    return;
  }
  const key = normalizeReferenceKey(reference);
  if (key.length < 3 || key.length > 40) issue(['reference'], 'La referencia no tiene un formato válido.');

  if (tender.method === 'TRANSFER') {
    if (tender.institution == null) {
      issue(['institution'], 'La transferencia requiere institución.');
      return;
    }
    if (tender.institution === 'OTHER') {
      const label = tender.institutionOther?.trim() ?? '';
      if (label.length < 1 || label.length > 60) {
        issue(['institutionOther'], 'La institución OTHER requiere un nombre de hasta 60 caracteres.');
      }
    } else if (tender.institutionOther != null) {
      issue(['institutionOther'], 'institutionOther solo se usa con la institución OTHER.');
    }
    return;
  }
  if (tender.institution != null || tender.institutionOther != null) issue(['institution'], 'El débito no lleva institución.');
});

export const checkoutRequestDto = z.object({
  operationKey: z.uuid({ version: 'v4' }),
  cashSessionId: z.uuid(),
  balanceMethod: checkoutMethod,
  expectedTotal: moneyString,
  expectedBalanceAmount: moneyString,
  tenders: z.array(tenderDto).min(1),
}).strict().superRefine((input, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
  // Exactly one BALANCE tender, whose method is the one declared; a method can
  // never be repeated.
  const methods = new Set<string>();
  let balances = 0;
  for (const [index, tender] of input.tenders.entries()) {
    if (methods.has(tender.method)) issue(['tenders', index, 'method'], 'Los medios de pago no pueden repetirse.');
    methods.add(tender.method);
    if (tender.role !== 'BALANCE') continue;
    balances += 1;
    if (tender.method !== input.balanceMethod) {
      issue(['tenders', index, 'method'], 'El medio de saldo no coincide con balanceMethod.');
    }
  }
  if (balances !== 1) issue(['tenders'], 'Se requiere exactamente un medio de saldo.');
}).transform((input): CheckoutRequest => ({
  operationKey: input.operationKey,
  cashSessionId: input.cashSessionId,
  balanceMethod: input.balanceMethod,
  expectedTotal: parseMoney(input.expectedTotal),
  expectedBalanceAmount: parseMoney(input.expectedBalanceAmount),
  tenders: input.tenders.map((tender): CheckoutTender => ({
    method: tender.method,
    role: tender.role,
    amount: tender.amount == null ? null : parseMoney(tender.amount),
    receivedAmount: tender.receivedAmount == null ? null : parseMoney(tender.receivedAmount),
    reference: tender.reference ?? null,
    institution: (tender.institution ?? null) as TransferInstitution | null,
    institutionOther: tender.institutionOther ?? null,
    externalCollectionId: tender.externalCollectionId ?? null,
  })),
}));

export type CheckoutRequestInput = z.output<typeof checkoutRequestDto>;

// ---------------------------------------------------------------------------
// R3-A4.3 S2: confirmation of a sealed reservation (T-C), contract
// consolidated §3. The route POST /sales/:saleId/checkout stays; S5 switches it
// from checkoutRequestDto (R3-A2, above, still used by the current service) to
// this DTO. Amounts, methods' roles, the cash session and the totals are NOT
// accepted: they come from the sealed plan. Per tender:
//   CASH: receivedAmount only;
//   TRANSFER (NEW): reference + institution (+ institutionOther for OTHER);
//   CARD_DEBIT (NEW): reference, no institution;
//   COLLECTION tender (TRANSFER/CARD_DEBIT): nothing at all.
// The service checks the exact method set and NEW/COLLECTION against the plan.
import type { ConfirmationTenderInput } from '../checkout-canonical.js';
import { normalizeReferenceKey as canonicalReferenceKey } from '../checkout-canonical.js';
import {
  canonicalUuid,
  checkoutMethod as attemptMethod,
  institutionOtherString,
  moneyString as attemptMoney,
  referenceString,
  saleIdParams,
  supervisorJustification,
  toBigInt,
  transferInstitution as attemptInstitution,
} from './checkout-fields.js';

// Path params of the confirmation: a canonical lowercase UUID v4 saleId.
// checkoutParamsDto (above, R3-A2) stays as is; S5 mounts this one on the route.
export const checkoutConfirmationParamsDto = saleIdParams;

const confirmationTender = z.object({
  method: attemptMethod,
  receivedAmount: attemptMoney.optional(),
  reference: referenceString.optional(),
  institution: attemptInstitution.optional(),
  institutionOther: institutionOtherString.optional(),
}).strict().superRefine((tender, context) => {
  const issue = (path: string, message: string) => context.addIssue({ code: 'custom', path: [path], message });
  if (tender.method === 'CASH') {
    if (tender.receivedAmount === undefined) issue('receivedAmount', 'El efectivo recibido es obligatorio.');
    if (tender.reference !== undefined || tender.institution !== undefined || tender.institutionOther !== undefined) {
      issue('reference', 'El efectivo no lleva referencia ni institución.');
    }
    return;
  }
  if (tender.receivedAmount !== undefined) issue('receivedAmount', 'Solo el efectivo lleva importe recibido.');
  if (tender.method === 'CARD_DEBIT') {
    if (tender.institution !== undefined || tender.institutionOther !== undefined) issue('institution', 'El débito no lleva institución.');
    return;
  }
  // TRANSFER: a reference and an institution together (NEW), or neither (COLLECTION).
  if ((tender.reference === undefined) !== (tender.institution === undefined)) {
    issue('institution', 'La transferencia lleva referencia e institución juntas, o ninguna si es un cobro ya registrado.');
  }
  if (tender.institution === 'OTHER' && tender.institutionOther === undefined) issue('institutionOther', 'La institución OTHER requiere un nombre.');
  if (tender.institution !== 'OTHER' && tender.institutionOther !== undefined) issue('institutionOther', 'institutionOther solo se usa con la institución OTHER.');
});

export type CheckoutConfirmationTender = ConfirmationTenderInput & { reference: string | null };
export type CheckoutConfirmationRequest = {
  reserveKey: string;
  operationKey: string;
  tenders: CheckoutConfirmationTender[];
  supervisor: { reason: string; evidence: string } | null;
};

export const checkoutConfirmationDto = z.object({
  reserveKey: canonicalUuid,
  operationKey: canonicalUuid,
  tenders: z.array(confirmationTender).min(1).max(3),
  supervisor: supervisorJustification.optional(),
}).strict().superRefine((input, context) => {
  const methods = new Set<string>();
  for (const [index, tender] of input.tenders.entries()) {
    if (methods.has(tender.method)) context.addIssue({ code: 'custom', path: ['tenders', index, 'method'], message: 'Los medios de pago no pueden repetirse.' });
    methods.add(tender.method);
  }
}).transform((input): CheckoutConfirmationRequest => ({
  reserveKey: input.reserveKey,
  operationKey: input.operationKey,
  tenders: input.tenders.map((tender): CheckoutConfirmationTender => ({
    method: tender.method,
    receivedAmount: tender.receivedAmount === undefined ? null : toBigInt(tender.receivedAmount),
    reference: tender.reference ?? null,
    referenceKey: tender.reference === undefined ? null : canonicalReferenceKey(tender.reference),
    institution: tender.institution ?? null,
    institutionOther: tender.institutionOther ?? null,
  })),
  supervisor: input.supervisor ?? null,
}));
