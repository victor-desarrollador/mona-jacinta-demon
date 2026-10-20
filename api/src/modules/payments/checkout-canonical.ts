// R3-A4.3 S2: canonical texts and SHA-256 hashes of a checkout plan
// (planHash, mona-checkout-plan/v1) and of its confirmation
// (confirmationHash, mona-checkout-confirmation/v1). Contract: consolidated §4.
//
// Pure: no database, no clock, no environment. The hash is SHA-256 over the
// exact ASCII bytes of the text below, written as 64 lowercase hex characters.
//   - every line ends with 0x0A, the last one included; no BOM, no spaces;
//   - UUID: canonical lowercase v4 with hyphens; integer: decimal ASCII without
//     sign or leading zeroes, within PostgreSQL BIGINT; absent: "-"; enum: its
//     name; referenceKey: [A-Z0-9]{3,40}, already normalised;
//     institutionOther: trim → NFC → UTF-8 → lowercase hex;
//   - tenders always in the order CASH, TRANSFER, CARD_DEBIT.
// Only `null` means absent ("-"). `undefined`, a Number, an empty string or any
// malformed value is refused with CheckoutCanonicalError (fail closed): a hash
// is never computed over input that the database or the contract would reject.
// Stock recovery and the T-RR justification are not part of any hash.
import { createHash } from 'node:crypto';

// The tender grammar of mona-checkout-plan/v1 and mona-checkout-confirmation/v1 is
// unchanged by CARD_CREDIT: one `tender=<METHOD>|...` row per tender, and the method
// set only grows. A plan without credit therefore keeps its exact historical bytes
// and hash. Order: CASH, TRANSFER, CARD_DEBIT, CARD_CREDIT.
export const CHECKOUT_METHODS = ['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT'] as const;
// A checkout still carries at most two fixed tenders plus the balance.
export const MAX_CHECKOUT_TENDERS = 3;

// The pricing-snapshot format written by NEW attempts and checkouts. 1 = a snapshot
// WITHOUT a CARD_CREDIT price (everything written before the CARD_CREDIT block, and
// what an N-1 API still writes); 2 = the snapshot WITH it. The canonical text/hash
// grammar above is the same for both; this number only says which columns of the
// stored row are meaningful (chk_*_credit_snapshot).
export const CHECKOUT_ALGORITHM_VERSION = 2;
export const CHECKOUT_ALGORITHM_VERSION_NO_CREDIT = 1;
export type CheckoutMethod = (typeof CHECKOUT_METHODS)[number];
export const TENDER_ROLES = ['FIXED', 'BALANCE'] as const;
export type TenderRole = (typeof TENDER_ROLES)[number];
export const TENDER_SOURCES = ['NEW', 'COLLECTION'] as const;
export type TenderSource = (typeof TENDER_SOURCES)[number];
// Mirrors the TransferInstitution enum of prisma/schema.prisma.
export const TRANSFER_INSTITUTIONS = ['MACRO', 'BBVA', 'NACION', 'GALICIA', 'MERCADO_PAGO', 'OTHER'] as const;
export type TransferInstitutionName = (typeof TRANSFER_INSTITUTIONS)[number];

export const MAX_PG_BIGINT = 9223372036854775807n;
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const REFERENCE_KEY = /^[A-Z0-9]{3,40}$/;
const HASH_HEX = /^[0-9a-f]{64}$/;

// chk_ec_reference: the RAW reference is 1..64 Unicode code points, independent
// of its normalised key. Shared so the HTTP boundary and the service's
// defence-in-depth can never disagree.
export const REFERENCE_RAW_MAX = 64;
// Unicode code points, as PostgreSQL char_length counts them (never String.length,
// which counts UTF-16 units and would reject a valid astral reference).
export const codePoints = (value: string): number => [...value].length;

export const PLAN_PREFIX = 'mona-checkout-plan/v1';
export const CONFIRMATION_PREFIX = 'mona-checkout-confirmation/v1';

export class CheckoutCanonicalError extends Error {
  constructor(message: string) {
    super(`checkout canonicalization refused: ${message}`);
    this.name = 'CheckoutCanonicalError';
  }
}

export type PlanTenderInput = {
  method: CheckoutMethod;
  role: TenderRole;
  source: TenderSource;
  amount: bigint | null;
  externalCollectionId: string | null;
};

export type PlanInput = {
  saleId: string;
  cashSessionId: string;
  balanceMethod: CheckoutMethod;
  expectedTotal: bigint;
  expectedBalanceAmount: bigint;
  tenders: readonly PlanTenderInput[];
};

export type ConfirmationTenderInput = {
  method: CheckoutMethod;
  receivedAmount: bigint | null;
  referenceKey: string | null;
  institution: TransferInstitutionName | null;
  institutionOther: string | null;
};

export type ConfirmationInput = {
  planHash: string;
  reserveKey: string;
  operationKey: string;
  tenders: readonly ConfirmationTenderInput[];
};

const refuse = (message: string): never => {
  throw new CheckoutCanonicalError(message);
};

// The R3-A2 reference key (identical to checkout.service.ts normalizeReferenceKey,
// which writes ExternalCollection.referenceKey): uppercase, then keep [A-Z0-9].
export function normalizeReferenceKey(reference: string): string {
  return reference.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// The single normal form of an OTHER institution label: trim → NFC. The DTOs
// deliver it already in this form (so it is also what gets stored), and the
// hash encodes exactly its UTF-8 bytes.
export function normalizeInstitutionOther(label: string): string {
  return label.trim().normalize('NFC');
}

// normalizeInstitutionOther → UTF-8 → lowercase hex.
export function institutionOtherHex(label: string): string {
  return Buffer.from(normalizeInstitutionOther(label), 'utf8').toString('hex');
}

const explicit = <T>(value: T | undefined, field: string): T => {
  if (value === undefined) refuse(`${field} must be an explicit null when absent`);
  return value as T;
};

const uuid = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) refuse(`${field} must be a canonical lowercase UUID v4`);
  return value as string;
};

const integer = (value: unknown, field: string): string => {
  if (typeof value !== 'bigint') return refuse(`${field} must be a BigInt (never a Number or a string)`);
  if (value < 0n || value > MAX_PG_BIGINT) refuse(`${field} must be a non-negative BigInt within PostgreSQL BIGINT`);
  return value.toString(10);
};

const optionalInteger = (value: bigint | null | undefined, field: string): string => {
  const present = explicit(value, field);
  return present === null ? '-' : integer(present, field);
};

const oneOf = <T extends string>(values: readonly T[], value: unknown, field: string): T => {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) refuse(`${field} is not an accepted value`);
  return value as T;
};

function ordered<T extends { method: CheckoutMethod }>(tenders: readonly T[]): T[] {
  if (!Array.isArray(tenders) || tenders.length < 1 || tenders.length > MAX_CHECKOUT_TENDERS) {
    refuse('a checkout carries 1 to 3 tenders');
  }
  const seen = new Set<string>();
  for (const tender of tenders) {
    const method = oneOf(CHECKOUT_METHODS, tender?.method, 'tender method');
    if (seen.has(method)) refuse(`tender method ${method} is duplicated`);
    seen.add(method);
  }
  return [...tenders].sort((a, b) => CHECKOUT_METHODS.indexOf(a.method) - CHECKOUT_METHODS.indexOf(b.method));
}

const lines = (rows: string[]) => `${rows.join('\n')}\n`;
const sha256Hex = (text: string) => createHash('sha256').update(Buffer.from(text, 'ascii')).digest('hex');

export function canonicalPlanText(input: PlanInput): string {
  const tenders = ordered(input.tenders);
  const rows = [
    PLAN_PREFIX,
    `saleId=${uuid(input.saleId, 'saleId')}`,
    `cashSessionId=${uuid(input.cashSessionId, 'cashSessionId')}`,
    `balanceMethod=${oneOf(CHECKOUT_METHODS, input.balanceMethod, 'balance method')}`,
    `expectedTotal=${integer(input.expectedTotal, 'expectedTotal')}`,
    `expectedBalanceAmount=${integer(input.expectedBalanceAmount, 'expectedBalanceAmount')}`,
    `tenderCount=${tenders.length}`,
  ];
  for (const tender of tenders) {
    const role = oneOf(TENDER_ROLES, tender.role, 'tender role');
    const source = oneOf(TENDER_SOURCES, tender.source, 'tender source');
    const amount = optionalInteger(tender.amount, 'tender amount');
    const collection = explicit(tender.externalCollectionId, 'tender externalCollectionId');
    rows.push(`tender=${tender.method}|${role}|${source}|${amount}|${collection === null ? '-' : uuid(collection, 'externalCollectionId')}`);
  }
  return lines(rows);
}

export function planHash(input: PlanInput): string {
  return sha256Hex(canonicalPlanText(input));
}

export function canonicalConfirmationText(input: ConfirmationInput): string {
  if (typeof input.planHash !== 'string' || !HASH_HEX.test(input.planHash)) refuse('planHash must be 64 lowercase hex characters');
  const tenders = ordered(input.tenders);
  const rows = [
    CONFIRMATION_PREFIX,
    `planHash=${input.planHash}`,
    `reserveKey=${uuid(input.reserveKey, 'reserveKey')}`,
    `operationKey=${uuid(input.operationKey, 'operationKey')}`,
  ];
  for (const tender of tenders) {
    const received = explicit(tender.receivedAmount, 'receivedAmount');
    const referenceKey = explicit(tender.referenceKey, 'referenceKey');
    const institution = explicit(tender.institution, 'institution');
    const institutionOther = explicit(tender.institutionOther, 'institutionOther');
    if (referenceKey !== null && (typeof referenceKey !== 'string' || !REFERENCE_KEY.test(referenceKey))) {
      refuse('referenceKey must be a normalised [A-Z0-9]{3,40} key');
    }
    if (tender.method === 'CASH') {
      if (received === null || referenceKey !== null || institution !== null || institutionOther !== null) {
        refuse('a CASH tender carries receivedAmount and nothing else');
      }
    } else {
      if (received !== null) refuse('only a CASH tender carries receivedAmount');
      if ((tender.method === 'CARD_DEBIT' || tender.method === 'CARD_CREDIT') && (institution !== null || institutionOther !== null)) {
        refuse(`a ${tender.method} tender carries no institution`);
      }
      if (tender.method === 'TRANSFER' && (referenceKey === null) !== (institution === null)) {
        refuse('a TRANSFER tender carries a reference and an institution together (a COLLECTION tender carries neither)');
      }
    }
    if (institution !== null) oneOf(TRANSFER_INSTITUTIONS, institution, 'institution');
    if (institution === 'OTHER') {
      if (typeof institutionOther !== 'string' || institutionOther.trim().length === 0) refuse('institution OTHER requires a non-empty institutionOther');
    } else if (institutionOther !== null) {
      refuse('institutionOther is only allowed with institution OTHER');
    }
    rows.push(`tender=${tender.method}|${received === null ? '-' : integer(received, 'receivedAmount')}|${referenceKey ?? '-'}|${institution ?? '-'}|${
      institutionOther === null ? '-' : institutionOtherHex(institutionOther)}`);
  }
  return lines(rows);
}

export function confirmationHash(input: ConfirmationInput): string {
  return sha256Hex(canonicalConfirmationText(input));
}
