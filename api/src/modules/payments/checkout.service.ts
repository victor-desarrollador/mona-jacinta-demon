// R3-A4.3 S5 (confirmación T-C): the ONE public settlement path of a
// PROPORTIONAL_V1 sale. It turns a SEALED `CheckoutAttempt` (RESERVED) into a
// committed, PAID -> COMPLETED sale, or terminally rejects the attempt.
//
// One Serializable transaction (timeout 30000, up to 3 attempts on P2034 /
// 40001 / 40P01) does everything: it confirms the attempt, records the external
// collections, the payments and the per-line allocations, the net cash
// movement, transitions the sale to PAID and runs the shared PAID -> COMPLETED
// finalizer with the SAME TransactionClient (never a second transaction). Any
// failure reverts payments, stock, reservations, cash and audit together.
//
// The sealed plan is the ONLY source of the amounts (design §5.2): T-C never
// reads the current pricing configuration and never re-quotes the sale. It
// rebuilds the per-line full prices from the
// sale's OWN line snapshot and the SEALED basis points, through the shared pure
// helpers of the pricing engine (lineFullPrices/allocate), so the settlement is
// bit-identical to the quote that produced the seal. The request contributes
// only the reserveKey, the operationKey, the CASH receivedAmount, new external
// evidence and the optional supervisor justification: totals, balance, session,
// roles and amounts always come from the sealed attempt and its tenders.
//
// Discriminated result (design §5.3): a terminal rejection (INVALID_SALE_STATE,
// NO_OPEN_CASH_SESSION, CASH_SESSION_BRANCH_MISMATCH,
// EXTERNAL_COLLECTION_NOT_APPLICABLE, INSUFFICIENT_PHYSICAL,
// INSUFFICIENT_RESERVED) commits the attempt as REJECTED with no charge, and
// the caller turns it into a 409 after commit. Correctable errors (tender
// mismatch, insufficient cash, duplicate reference, expired/released stock)
// throw and roll the whole transaction back: the attempt stays RESERVED.
//
// Lock order (design §6): Sale -> CheckoutAttempt -> ExternalCollection(id ASC)
// -> CashSession -> StockReservation(id ASC) -> Inventory(id ASC). The
// finalizer re-locks the sale, reservations and inventory in the same order.
import { createHash } from 'node:crypto';
import {
  Prisma,
  type PaymentMethod,
  type PrismaClient,
  type PriceType,
  type SalePricingModel,
  type TransferInstitution,
} from '../../generated/prisma/client.js';
import { assertPermissionAtLocation } from '../../middleware/authorization.js';
import { actsAsSupervisorAtLocation, hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { AppError } from '../../shared/errors.js';
import type { CheckoutConfirmationRequest } from './dto/checkout.dto.js';
import {
  CHECKOUT_ALGORITHM_VERSION, CheckoutCanonicalError, REFERENCE_RAW_MAX, codePoints, confirmationHash, type ConfirmationTenderInput,
} from './checkout-canonical.js';
import { readCheckoutResult } from './checkout-attempt-view.js';
import { createAuditLog } from '../../shared/audit.js';
import { evaluateCurrentHoldCoverage } from '../sales/hold-coverage.js';
import { assertPricingFinalizable } from '../sales/wholesale-authorization.service.js';
import { finalizePaidSaleInTransaction } from '../sales/sale-finalization.js';
import { type PriceMode } from '../pricing/pricing.js';
import { isExternalReferenceCollision } from './prisma-unique-violation.js';
import {
  PROPORTIONAL_METHODS,
  allocate,
  lineFullPrices,
  type ProportionalLineInput,
  type ProportionalMethod,
} from '../pricing/proportional-checkout.js';

type RequestLike = Parameters<typeof assertPermissionAtLocation>[0];

// Re-exported: the pricing-snapshot format version now lives in checkout-canonical.ts (2 = with CARD_CREDIT).
export { CHECKOUT_ALGORITHM_VERSION };
const CHECKOUT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const TRANSFER_INSTITUTIONS: readonly TransferInstitution[] = ['MACRO', 'BBVA', 'NACION', 'GALICIA', 'MERCADO_PAGO', 'OTHER'];

export type CheckoutTenderRole = 'FIXED' | 'BALANCE';

// The already-parsed request (the zod DTO of the next slice performs the same
// shape checks at the HTTP boundary; this service never trusts raw JSON).
export type CheckoutTender = {
  method: ProportionalMethod;
  role: CheckoutTenderRole;
  amount: bigint | null;
  receivedAmount: bigint | null;
  reference: string | null;
  institution: TransferInstitution | null;
  institutionOther: string | null;
  externalCollectionId: string | null;
};

export type CheckoutRequest = {
  operationKey: string;
  cashSessionId: string;
  balanceMethod: ProportionalMethod;
  expectedTotal: bigint;
  expectedBalanceAmount: bigint;
  tenders: readonly CheckoutTender[];
};

export type CheckoutPaymentResult = {
  id: string;
  method: PaymentMethod;
  tenderRole: CheckoutTenderRole;
  amount: bigint;
  methodFullPrice: bigint;
  adjustmentBps: number;
  externalCollectionId: string | null;
  receivedAmount: bigint | null;
  changeAmount: bigint | null;
};

export type CheckoutResult = {
  saleId: string;
  saleNumber: string | null;
  status: 'COMPLETED';
  checkoutId: string;
  replayed: boolean;
  total: bigint;
  changeAmount: bigint;
  payments: CheckoutPaymentResult[];
  lines: Array<{ saleItemId: string; sku: string; quantity: bigint; finalAmount: bigint }>;
  completedAt: Date;
};

type LockedSale = {
  id: string;
  branchId: string;
  status: string;
  saleNumber: string | null;
  subtotal: bigint;
  total: bigint;
  pricingMode: PriceType;
  priceMode: PriceMode;
  pricingModel: SalePricingModel;
  paymentStartedAt: Date | null;
  wholesaleConfirmedAt: Date | null;
  wholesaleConfirmedById: string | null;
};

// Only the sealed snapshot of the attempt is read at T-C: totals, balance,
// session, balance method, tender count and the sealed basis points. The plan
// itself never comes from the request.
type LockedCheckoutAttempt = {
  id: string;
  saleId: string;
  branchId: string;
  reserveKey: string;
  operationKey: string;
  planHash: string;
  planSealed: boolean;
  status: string;
  startedById: string;
  confirmationHash: string | null;
  cashSessionId: string;
  balanceMethod: ProportionalMethod;
  expectedTotal: bigint;
  expectedBalanceAmount: bigint;
  tenderCount: number;
  fullPriceCash: bigint;
  fullPriceTransfer: bigint | null;
  fullPriceDebit: bigint | null;
  fullPriceCredit: bigint | null;
  transferAdjustmentBps: number | null;
  debitAdjustmentBps: number | null;
  creditAdjustmentBps: number | null;
  algorithmVersion: number;
  pricingConfigId: string | null;
  pricingConfigUpdatedAt: Date | null;
  rejectionCode: string | null;
  rejectionDetails: unknown;
  declaredAt: Date | null;
};

type SealedCheckoutTender = {
  method: string;
  role: string;
  source: string;
  amount: bigint | null;
  externalCollectionId: string | null;
};

type LockedCollection = {
  id: string;
  branchId: string;
  method: PaymentMethod;
  amount: bigint;
  reference: string;
  referenceKey: string;
  institution: TransferInstitution | null;
  status: string;
  claimAttemptId: string | null;
  originSaleId: string | null;
};

type LockedSession = { id: string; status: string; registerId: string; branchId: string };

// The evidence a confirmation supplies for ONE method. Only the CASH received
// amount and the NEW external reference/institution ever come from the request.
type SealedEvidence = {
  method: string;
  receivedAmount: bigint | null;
  reference: string | null;
  referenceKey: string | null;
  institution: TransferInstitution | null;
  institutionOther: string | null;
};

// One method's settlement, derived exclusively from the sealed plan.
type MethodSettlement = {
  method: ProportionalMethod;
  role: CheckoutTenderRole;
  amount: bigint;
  fullPrice: bigint;
  perLine: bigint[];
  allocations: Array<{ saleItemId: string; sku: string; amount: bigint }>;
};

// The discriminated outcome of one Serializable confirmation attempt. A
// terminal rejection is COMMITTED (the attempt is REJECTED, no charge happened)
// and only becomes an HTTP error after the commit; a defect or a correctable
// error throws instead and rolls the transaction back.
type ConfirmOutcome =
  | { kind: 'CONFIRMED'; result: CheckoutResult }
  | { kind: 'REJECTED'; code: string; message: string; details: Record<string, unknown> };

// ---------------------------------------------------------------------------
// Errors (design §5). A correctable error is thrown before the commit and
// leaves no row: the attempt stays RESERVED. A defect is a 500.
// ---------------------------------------------------------------------------
const INVALID_SALE_STATE = 'INVALID_SALE_STATE';
const NO_OPEN_CASH_SESSION = 'NO_OPEN_CASH_SESSION';
const CASH_SESSION_BRANCH_MISMATCH = 'CASH_SESSION_BRANCH_MISMATCH';
const EXTERNAL_COLLECTION_NOT_APPLICABLE = 'EXTERNAL_COLLECTION_NOT_APPLICABLE';
const INSUFFICIENT_PHYSICAL = 'INSUFFICIENT_PHYSICAL';
const INSUFFICIENT_RESERVED = 'INSUFFICIENT_RESERVED';

const validationError = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);
const notFound = () => new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
const methodNotEnabled = (method: string) => new AppError(409, 'PAYMENT_METHOD_NOT_ENABLED', `El medio ${method} no está habilitado para el cobro proporcional.`);
const cashReceivedInsufficient = () => new AppError(409, 'CASH_RECEIVED_INSUFFICIENT', 'El efectivo recibido es menor al importe.');
const referenceAlreadyRecorded = (status: string) => new AppError(409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED', 'La referencia ya está registrada.', { status });
const concurrencyError = () => new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
const inconsistentState = (message: string) => new AppError(500, 'CHECKOUT_STATE_INCONSISTENT', message);
// Defect (design §5.2 step 8): the sale's lines no longer reproduce the sealed
// plan. Fails the whole transaction (500), never a silent re-price.
const planInconsistent = (message: string) => new AppError(500, 'CHECKOUT_PLAN_INCONSISTENT', message);
const invalidAttemptState = () => new AppError(409, 'INVALID_CHECKOUT_ATTEMPT_STATE', 'La reserva de cobro no admite una nueva confirmación.');
const reservationClosed = () => new AppError(409, 'CHECKOUT_RESERVATION_CLOSED', 'La reserva de cobro ya fue cerrada y no admite confirmación.');
const confirmationHashMismatch = () => new AppError(409, 'CHECKOUT_CONFIRMATION_HASH_MISMATCH', 'La confirmación no coincide con la confirmación ya registrada.');
// Correctable stock errors (design §6.1 C5): 409, attempt stays RESERVED, and
// the response carries the observed attempt status and the computed stock state.
const stockHoldExpired = () => new AppError(409, 'STOCK_HOLD_EXPIRED', 'La reserva de stock de la venta venció.', { observedStatus: 'RESERVED', stockState: 'EXPIRED' });
const stockHoldReleased = () => new AppError(409, 'STOCK_HOLD_RELEASED', 'La reserva de stock de la venta fue liberada.', { observedStatus: 'RESERVED', stockState: 'RELEASED' });

const transient = (error: unknown) => {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034' || candidate.meta?.code === '40001'
    || candidate.meta?.code === '40P01' || message.includes('40001')
    || message.includes('40P01') || message.includes('TransactionWriteConflict');
};

// A terminal rejection persists its CODE and DETAILS but not its message. A
// replay reconstructs the same 409 from the code alone, without ever writing or
// re-auditing — see the last step of the JSDoc on `checkout`.
const REJECTION_MESSAGES: Record<string, string> = {
  [INVALID_SALE_STATE]: 'La venta no admite el cobro en su estado actual.',
  [NO_OPEN_CASH_SESSION]: 'No hay una sesión de caja abierta.',
  [CASH_SESSION_BRANCH_MISMATCH]: 'La sesión de caja pertenece a otra sucursal.',
  [EXTERNAL_COLLECTION_NOT_APPLICABLE]: 'El cobro registrado no se puede aplicar a este intento.',
  [INSUFFICIENT_PHYSICAL]: 'El inventario físico no puede cubrir la venta.',
  [INSUFFICIENT_RESERVED]: 'El inventario reservado no puede cubrir la venta.',
};
const rejectionMessage = (code: string): string => REJECTION_MESSAGES[code] ?? 'La reserva de cobro fue rechazada.';
const rejectionDetailsOf = (value: unknown): Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

// Reference canonical form (design §7): upper-case letters and digits only.
export function normalizeReferenceKey(reference: string): string {
  return reference.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const METHOD_ORDER: Record<ProportionalMethod, number> = { CASH: 0, TRANSFER: 1, CARD_DEBIT: 2, CARD_CREDIT: 3 };

// requestHash = SHA-256 of a canonical JSON with a fixed key order (design §7).
// Absent values are the empty string; the tender order never changes the hash.
export function checkoutRequestHash(saleId: string, request: CheckoutRequest): string {
  const tenders = [...request.tenders].sort((left, right) => METHOD_ORDER[left.method] - METHOD_ORDER[right.method]);
  const canonical = JSON.stringify({
    v: 1,
    saleId,
    cashSessionId: request.cashSessionId,
    balanceMethod: request.balanceMethod,
    expectedTotal: request.expectedTotal.toString(),
    expectedBalanceAmount: request.expectedBalanceAmount.toString(),
    tenders: tenders.map((tender) => ({
      method: tender.method,
      role: tender.role,
      amount: tender.amount === null ? '' : tender.amount.toString(),
      receivedAmount: tender.receivedAmount === null ? '' : tender.receivedAmount.toString(),
      referenceKey: tender.reference === null ? '' : normalizeReferenceKey(tender.reference),
      institution: tender.institution ?? '',
      institutionOther: tender.institutionOther?.trim() ?? '',
      externalCollectionId: tender.externalCollectionId ?? '',
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function assertMethodEnabled(method: string): asserts method is ProportionalMethod {
  if (!(PROPORTIONAL_METHODS as readonly string[]).includes(method)) throw methodNotEnabled(method);
}

// Shape validation of the parsed request (V1-V7 of the design; the zod DTO of
// the next slice repeats it at the HTTP boundary). Fails before any transaction.
export function validateCheckoutRequest(request: CheckoutRequest): void {
  assertMethodEnabled(request.balanceMethod);
  if (request.tenders.length === 0) throw validationError('Se requiere al menos un medio de pago.');
  const methods = new Set<string>();
  let balances = 0;
  for (const tender of request.tenders) {
    assertMethodEnabled(tender.method);
    if (methods.has(tender.method)) throw validationError('Los medios de pago no pueden repetirse.');
    methods.add(tender.method);

    if (tender.role === 'BALANCE') {
      balances += 1;
      if (tender.method !== request.balanceMethod) throw validationError('El medio de saldo no coincide con balanceMethod.');
      if (tender.amount !== null) throw validationError('El medio de saldo no lleva importe: lo calcula el servidor.');
    } else if (tender.role === 'FIXED') {
      if (tender.amount === null) throw validationError('Un importe fijo requiere importe.');
      if (tender.amount <= 0n) throw validationError('Un importe fijo debe ser mayor que cero.');
      // Money actually received (CASH, TRANSFER, CARD_DEBIT) may carry centavos:
      // only the COMPUTED prices, balance and total land on whole pesos, and
      // chk_payment_balance_whole_peso constrains the BALANCE tender alone.
    } else {
      throw validationError('El rol del medio de pago no es válido.');
    }

    if (tender.method === 'CASH') {
      if (tender.reference !== null || tender.institution !== null || tender.institutionOther !== null || tender.externalCollectionId !== null) {
        throw validationError('El efectivo no lleva referencia ni institución.');
      }
      if (tender.receivedAmount === null) throw validationError('El efectivo recibido es obligatorio.');
      if (tender.amount !== null && tender.receivedAmount < tender.amount) throw cashReceivedInsufficient();
      continue;
    }

    if (tender.receivedAmount !== null) throw validationError('Solo el efectivo lleva importe recibido.');
    const hasReference = tender.reference !== null;
    const hasCollection = tender.externalCollectionId !== null;
    if (hasReference === hasCollection) throw validationError('Débito y transferencia llevan referencia o cobro externo, nunca ambos.');
    if (hasCollection) {
      // The registered collection already owns the reference and the institution.
      if (tender.role !== 'FIXED') throw validationError('Un cobro externo solo se imputa como importe fijo.');
      if (tender.institution !== null || tender.institutionOther !== null) throw validationError('Un cobro externo ya registrado no repite institución.');
      continue;
    }
    // chk_ec_reference: the RAW reference is 1..64 CHARACTERS (PostgreSQL
    // char_length counts Unicode code points, so the length is counted by code
    // point too — String.length would count UTF-16 units and reject a valid
    // astral reference) AND its normalised key matches ^[A-Z0-9]{3,40}$. Both are
    // checked before anything is normalised or stored; a long reference is refused,
    // never silently truncated.
    const referenceLength = [...tender.reference!].length;
    if (referenceLength < 1 || referenceLength > 64) {
      throw validationError('La referencia debe tener entre 1 y 64 caracteres.');
    }
    const key = normalizeReferenceKey(tender.reference!);
    if (key.length < 3 || key.length > 40) throw validationError('La referencia no tiene un formato válido.');
    if (tender.method === 'TRANSFER') {
      if (tender.institution === null) throw validationError('La transferencia requiere institución.');
      if (!TRANSFER_INSTITUTIONS.includes(tender.institution)) throw validationError('La institución de la transferencia no es válida.');
      if (tender.institution === 'OTHER') {
        const label = tender.institutionOther?.trim() ?? '';
        if (label.length < 1 || label.length > 60) throw validationError('La institución OTHER requiere un nombre de hasta 60 caracteres.');
      } else if (tender.institutionOther !== null) {
        throw validationError('institutionOther solo se usa con la institución OTHER.');
      }
    } else if (tender.institution !== null || tender.institutionOther !== null) {
      throw validationError(tender.method === 'CARD_CREDIT' ? 'El crédito no lleva institución.' : 'El débito no lleva institución.');
    }
  }
  if (balances !== 1) throw validationError('Se requiere exactamente un medio de saldo.');
}

export function createCheckoutService(database: PrismaClient) {
  // Everything a confirmation needs, derived exclusively from the SEALED plan:
  // the canonical confirmation hash, the CASH change and the normalised evidence
  // per method. Only the CASH receivedAmount and a NEW reference/institution ever
  // come from the request; totals, balance and roles never do. Fails before any
  // write when the confirmation does not match the reservation.
  function hashSealedConfirmation(
    attempt: LockedCheckoutAttempt,
    planTenders: SealedCheckoutTender[],
    request: CheckoutConfirmationRequest,
  ): { hash: string; cashChange: bigint; evidenceByMethod: Map<string, SealedEvidence> } {
    if (planTenders.length !== request.tenders.length) throw validationError('Los medios de confirmación no coinciden con la reserva.');
    const requestByMethod = new Map<string, CheckoutConfirmationRequest['tenders'][number]>();
    for (const tender of request.tenders) {
      if (requestByMethod.has(tender.method)) throw validationError('Los medios de pago no pueden repetirse.');
      requestByMethod.set(tender.method, tender);
    }
    const planMethods = new Set<string>();
    for (const tender of planTenders) {
      if (planMethods.has(tender.method) || !requestByMethod.has(tender.method)) {
        throw validationError('Los medios de confirmación no coinciden con la reserva.');
      }
      planMethods.add(tender.method);
      if (!['FIXED', 'BALANCE'].includes(tender.role) || !['NEW', 'COLLECTION'].includes(tender.source)) {
        throw inconsistentState('La reserva contiene un tender inválido.');
      }
      if ((tender.role === 'FIXED' && (tender.amount === null || tender.amount <= 0n))
        || (tender.role === 'BALANCE' && tender.amount !== null)) {
        throw inconsistentState('La reserva contiene un importe de tender inválido.');
      }
      if (tender.source === 'COLLECTION'
        && (tender.method === 'CASH' || tender.role !== 'FIXED' || tender.amount === null || tender.externalCollectionId === null)) {
        throw inconsistentState('La reserva contiene un tender COLLECTION inválido.');
      }
      if (tender.source === 'NEW' && tender.externalCollectionId !== null) {
        throw inconsistentState('La reserva NEW referencia un cobro externo.');
      }
    }
    if (planMethods.size !== requestByMethod.size) throw validationError('Los medios de confirmación no coinciden con la reserva.');

    let cashChange = 0n;
    const evidenceByMethod = new Map<string, SealedEvidence>();
    const hashTenders: ConfirmationTenderInput[] = [];
    for (const sealed of planTenders) {
      const evidence = requestByMethod.get(sealed.method)!;
      if (evidence.reference !== null) {
        if (evidence.referenceKey === null || normalizeReferenceKey(evidence.reference) !== evidence.referenceKey) {
          throw validationError('La referencia del cobro no es válida.');
        }
        // Defence in depth (design §7, chk_ec_reference): the RAW reference is
        // 1..64 Unicode code points. The HTTP DTO bounds it too, but repeating it
        // here makes a caller that bypasses the boundary fail with 400 BEFORE any
        // INSERT — never a PostgreSQL check violation or a silent truncation.
        const rawLength = codePoints(evidence.reference);
        if (rawLength < 1 || rawLength > REFERENCE_RAW_MAX) {
          throw validationError('La referencia debe tener entre 1 y 64 caracteres.');
        }
      } else if (evidence.referenceKey !== null) {
        throw validationError('La referencia del cobro no es válida.');
      }

      if (sealed.source === 'COLLECTION') {
        if (evidence.reference !== null || evidence.referenceKey !== null || evidence.institution !== null || evidence.institutionOther !== null) {
          throw validationError('Un cobro ya registrado no admite nueva evidencia de referencia o institución.');
        }
      } else if (sealed.method === 'TRANSFER') {
        if (evidence.referenceKey === null || evidence.institution === null) {
          throw validationError('La transferencia nueva requiere referencia e institución.');
        }
        if (evidence.institution === 'OTHER') {
          if (evidence.institutionOther === null || evidence.institutionOther.trim().length === 0) {
            throw validationError('La institución OTHER requiere un nombre.');
          }
        } else if (evidence.institutionOther !== null) {
          throw validationError('institutionOther solo se usa con la institución OTHER.');
        }
      } else if (sealed.method === 'CARD_DEBIT' || sealed.method === 'CARD_CREDIT') {
        if (evidence.referenceKey === null || evidence.institution !== null || evidence.institutionOther !== null) {
          throw validationError(sealed.method === 'CARD_CREDIT'
            ? 'El crédito nuevo requiere referencia y no admite institución.'
            : 'El débito nuevo requiere referencia y no admite institución.');
        }
      } else {
        if (evidence.receivedAmount === null || evidence.referenceKey !== null || evidence.institution !== null || evidence.institutionOther !== null) {
          throw validationError('El efectivo requiere importe recibido y no admite referencia ni institución.');
        }
        const sealedCashAmount = sealed.role === 'BALANCE' ? attempt.expectedBalanceAmount : sealed.amount;
        if (sealedCashAmount === null || sealedCashAmount <= 0n) {
          throw inconsistentState('La reserva no contiene un importe de efectivo válido.');
        }
        if (evidence.receivedAmount < sealedCashAmount) throw validationError('El efectivo recibido es menor al importe reservado.');
        cashChange += evidence.receivedAmount - sealedCashAmount;
      }
      if (sealed.method !== 'CASH' && evidence.receivedAmount !== null) {
        throw validationError('Solo el efectivo admite importe recibido.');
      }
      hashTenders.push({
        method: evidence.method,
        receivedAmount: evidence.receivedAmount,
        referenceKey: evidence.referenceKey,
        institution: evidence.institution,
        institutionOther: evidence.institutionOther,
      });
      evidenceByMethod.set(sealed.method, {
        method: sealed.method,
        receivedAmount: evidence.receivedAmount,
        reference: evidence.reference,
        referenceKey: evidence.referenceKey,
        institution: evidence.institution,
        institutionOther: evidence.institutionOther,
      });
    }

    try {
      return {
        hash: confirmationHash({
          planHash: attempt.planHash,
          reserveKey: attempt.reserveKey,
          operationKey: attempt.operationKey,
          tenders: hashTenders,
        }),
        cashChange,
        evidenceByMethod,
      };
    } catch (error) {
      if (error instanceof CheckoutCanonicalError) throw validationError('La confirmación no cumple el formato canónico.');
      throw error;
    }
  }

  function assertCanCharge(req: RequestLike, branchId: string) {
    // Phase 1D.3.2 SWITCH: the real decision is the Production SALE_CHARGE and
    // SALE_COMPLETE grants paired with the sale's own persisted branchId.
    assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CHARGE, branchId);
    if (!req.auth || !hasPermissionAtLocation(req.auth, PRODUCTION_PERMISSIONS.SALE_COMPLETE, branchId)) throw forbidden();
  }

  // The settlement is derived from the SEALED plan alone (design §5.2 step 8):
  // amounts come from the sealed tenders, the balance from
  // `expectedBalanceAmount`, the per-line full prices from the SEALED basis
  // points applied to the sale's OWN line snapshot. Any disagreement with the
  // seal is a defect (CHECKOUT_PLAN_INCONSISTENT) that reverts everything; the
  // current pricing configuration is never consulted.
  function buildSettlement(
    attempt: LockedCheckoutAttempt,
    planTenders: readonly SealedCheckoutTender[],
    lines: readonly ProportionalLineInput[],
  ): { methods: MethodSettlement[]; total: bigint; adjustments: Record<ProportionalMethod, number> } {
    const adjustments: Record<ProportionalMethod, number> = { CASH: 0, TRANSFER: 0, CARD_DEBIT: 0, CARD_CREDIT: 0 };
    if (attempt.transferAdjustmentBps !== null) adjustments.TRANSFER = attempt.transferAdjustmentBps;
    if (attempt.debitAdjustmentBps !== null) adjustments.CARD_DEBIT = attempt.debitAdjustmentBps;
    if (attempt.creditAdjustmentBps !== null) adjustments.CARD_CREDIT = attempt.creditAdjustmentBps;
    const sealedFullPrice: Record<ProportionalMethod, bigint | null> = {
      CASH: attempt.fullPriceCash,
      TRANSFER: attempt.fullPriceTransfer,
      CARD_DEBIT: attempt.fullPriceDebit,
      CARD_CREDIT: attempt.fullPriceCredit,
    };

    const amounts = new Map<ProportionalMethod, bigint>();
    for (const tender of planTenders) {
      if (!(PROPORTIONAL_METHODS as readonly string[]).includes(tender.method)) {
        throw planInconsistent('La reserva sellada contiene un medio inválido.');
      }
      const method = tender.method as ProportionalMethod;
      if (amounts.has(method)) throw planInconsistent('La reserva sellada repite un medio.');
      const isBalance = tender.role === 'BALANCE';
      if (isBalance !== (method === attempt.balanceMethod)) {
        throw planInconsistent('La reserva sellada no marca un único medio de saldo.');
      }
      const amount = isBalance ? attempt.expectedBalanceAmount : tender.amount;
      if (amount === null || amount <= 0n) throw planInconsistent('La reserva sellada contiene un importe de medio inválido.');
      amounts.set(method, amount);
    }
    if (amounts.size !== attempt.tenderCount) throw planInconsistent('La reserva sellada no concilia con su número de medios.');
    const total = [...amounts.values()].reduce((sum, value) => sum + value, 0n);
    if (total !== attempt.expectedTotal) throw planInconsistent('El total sellado no concilia con sus medios.');

    const methods: MethodSettlement[] = [];
    for (const method of PROPORTIONAL_METHODS) {
      if (!amounts.has(method)) continue;
      if (method !== 'CASH' && (attempt.transferAdjustmentBps === null || attempt.debitAdjustmentBps === null)) {
        throw planInconsistent(`Falta el ajuste sellado de ${method}.`);
      }
      // A plan can only carry CARD_CREDIT if it was sealed WITH a credit snapshot.
      if (method === 'CARD_CREDIT' && (attempt.creditAdjustmentBps === null || attempt.fullPriceCredit === null)) {
        throw planInconsistent('Falta el ajuste sellado de CARD_CREDIT.');
      }
      const perLine = lineFullPrices(lines, adjustments[method]);
      const fullPrice = perLine.reduce((sum, value) => sum + value, 0n);
      const sealed = sealedFullPrice[method];
      if (sealed === null || sealed !== fullPrice) {
        throw planInconsistent(`El precio completo sellado de ${method} no coincide con la venta.`);
      }
      const amount = amounts.get(method)!;
      const allocations = allocate({ amount, methodFullPrice: fullPrice, perLine, lines }).map((entry) => ({
        saleItemId: entry.saleItemId,
        sku: entry.sku,
        amount: entry.amount,
      }));
      methods.push({ method, role: method === attempt.balanceMethod ? 'BALANCE' : 'FIXED', amount, fullPrice, perLine, allocations });
    }
    return { methods, total, adjustments };
  }

  // T-C: confirm a RESERVED attempt. ONE Serializable transaction (retried on a
  // transient conflict); a terminal rejection is committed with the attempt
  // REJECTED and only becomes an HTTP error after the commit.
  async function checkout(req: RequestLike, userId: string, saleId: string, request: CheckoutConfirmationRequest): Promise<CheckoutResult> {
    // The NEW references the request proposes. Kept OUTSIDE the transaction: the
    // in-transaction pre-check is only fast-fail (design §5.2), and when a peer
    // commits the same reference between it and the INSERT, the partial unique
    // index is what stops us — the winner is only identifiable after the
    // rollback, with a read-only lookup that never reopens a transaction.
    const proposedReferences = request.tenders.flatMap((tender) => (
      tender.reference === null
        ? []
        : [{
            method: tender.method,
            referenceKey: normalizeReferenceKey(tender.reference),
            institution: tender.method === 'TRANSFER' ? tender.institution : null,
          }]
    ));

    const confirmAttempt = async (): Promise<ConfirmOutcome> => database.$transaction(async (tx): Promise<ConfirmOutcome> => {
      // 1. Sale, then attempt (design §5.2 steps 1-2). Never invert this order.
      const [sale] = await tx.$queryRaw<LockedSale[]>`
        SELECT id, "branchId", status, "saleNumber", subtotal, total, "pricingMode", "priceMode", "pricingModel",
               "paymentStartedAt", "wholesaleConfirmedAt", "wholesaleConfirmedById"
        FROM "Sale" WHERE id = ${saleId} FOR UPDATE
      `;
      if (!sale) throw notFound();

      const [attempt] = await tx.$queryRaw<LockedCheckoutAttempt[]>`
        SELECT id, "saleId", "branchId", "reserveKey", "operationKey", "planHash", "planSealed", status,
               "startedById", "confirmationHash", "cashSessionId", "balanceMethod", "expectedTotal",
               "expectedBalanceAmount", "tenderCount", "fullPriceCash", "fullPriceTransfer", "fullPriceDebit",
               "fullPriceCredit", "transferAdjustmentBps", "debitAdjustmentBps", "creditAdjustmentBps",
               "algorithmVersion", "pricingConfigId", "pricingConfigUpdatedAt",
               "rejectionCode", "rejectionDetails", "declaredAt"
        FROM "CheckoutAttempt" WHERE "reserveKey" = ${request.reserveKey} FOR UPDATE
      `;
      if (!attempt || attempt.saleId !== saleId || attempt.branchId !== sale.branchId) throw notFound();
      if (attempt.operationKey !== request.operationKey) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'La clave de idempotencia ya fue utilizada con otro contenido.');
      }
      if (!attempt.planSealed) throw inconsistentState('La reserva de cobro no tiene un plan sellado.');

      // 2. Permissions: the initiator charges on their own; anyone else must act
      //    as a supervisor at the sale's branch and leave a justification.
      const authenticatedUserId = req.auth?.userId;
      if (!authenticatedUserId || authenticatedUserId !== userId) throw forbidden();
      let supervisorReason: string | null = null;
      let supervisorEvidence: string | null = null;
      if (attempt.startedById === authenticatedUserId) {
        assertCanCharge(req, sale.branchId);
      } else {
        if (!request.supervisor || !req.auth || !actsAsSupervisorAtLocation(
          req.auth,
          [PRODUCTION_PERMISSIONS.SALE_CHARGE, PRODUCTION_PERMISSIONS.SALE_COMPLETE],
          sale.branchId,
        )) throw forbidden();
        supervisorReason = request.supervisor.reason;
        supervisorEvidence = request.supervisor.evidence;
      }

      // 3. State. A persisted TERMINAL rejection is idempotent: the same
      //    reserveKey and operationKey reproduce EXACTLY the rejection already
      //    committed — no settlement, no audit, no mutation. A different
      //    operationKey is a key reuse and never reaches here (step 1). A
      //    REJECTED attempt that T-X already DECLARED (declaredAt set) is closed
      //    for good: its rejection is no longer replayable (S6.2).
      if (attempt.status === 'REJECTED') {
        if (attempt.declaredAt !== null) throw reservationClosed();
        if (attempt.rejectionCode === null) throw inconsistentState('El intento rechazado no conserva su código de rechazo.');
        return {
          kind: 'REJECTED',
          code: attempt.rejectionCode,
          message: rejectionMessage(attempt.rejectionCode),
          details: rejectionDetailsOf(attempt.rejectionDetails),
        };
      }
      // An ABANDONED attempt was closed by T-X: it is never confirmed, and the
      // refusal writes nothing (no plan read, no settlement, no audit).
      if (attempt.status === 'ABANDONED') throw reservationClosed();
      // 4. A normal confirmation (or its replay) is decided by the sealed plan
      //    and the confirmation hash.
      if (attempt.status !== 'RESERVED' && attempt.status !== 'CONFIRMED') throw invalidAttemptState();
      const planTenders = await tx.checkoutAttemptTender.findMany({
        where: { attemptId: attempt.id },
        select: { method: true, role: true, source: true, amount: true, externalCollectionId: true },
      });
      const { hash: requestConfirmationHash, cashChange, evidenceByMethod } = hashSealedConfirmation(attempt, planTenders, request);
      if (attempt.status === 'CONFIRMED') {
        if (attempt.confirmationHash === null) throw inconsistentState('El intento confirmado no tiene confirmationHash.');
        if (attempt.confirmationHash !== requestConfirmationHash) throw confirmationHashMismatch();
        return { kind: 'CONFIRMED', result: await readCheckoutResult(tx, attempt) };
      }

      // A terminal rejection COMMITS (attempt REJECTED, no charge); the caller
      // turns it into a 409 after commit (design §5.3).
      const reject = async (code: string, message: string, details: Record<string, unknown> = {}): Promise<ConfirmOutcome> => {
        const now = new Date();
        await tx.sale.update({ where: { id: saleId }, data: { updatedAt: now } });
        await tx.checkoutAttempt.update({
          where: { id: attempt.id },
          data: {
            status: 'REJECTED',
            rejectionCode: code,
            rejectionDetails: details as Prisma.InputJsonValue,
            rejectedById: userId,
            rejectedAt: now,
          },
        });
        await createAuditLog(tx, {
          userId, branchId: sale.branchId, action: 'CHECKOUT_RESERVATION_REJECTED',
          entityType: 'CheckoutAttempt', entityId: attempt.id,
          before: { status: 'RESERVED' },
          after: { status: 'REJECTED', code, details },
        });
        return { kind: 'REJECTED', code, message, details };
      };

      // 4. Terminal sale-state rejection: no charge is possible.
      if (sale.pricingModel !== 'PROPORTIONAL_V1' || sale.status !== 'PENDING_PAYMENT') {
        return reject(INVALID_SALE_STATE, 'La venta no admite el cobro en su estado actual.');
      }
      assertPricingFinalizable(sale);
      if (sale.priceMode !== 'CASH') throw planInconsistent('Una venta proporcional debe estar tasada en efectivo.');
      const previousPayments = await tx.salePayment.findMany({ where: { saleId }, select: { id: true } });
      if (previousPayments.length > 0 || sale.paymentStartedAt !== null) {
        return reject(INVALID_SALE_STATE, 'La venta ya tiene cobros registrados.');
      }

      // 5. External collections, locked in id order: the plan's COLLECTION
      //    tenders, then the NEW references that must not already exist.
      const collectionIds = [...new Set(
        planTenders.filter((tender) => tender.source === 'COLLECTION').map((tender) => tender.externalCollectionId!),
      )].sort();
      const lockedCollections = new Map<string, LockedCollection>();
      if (collectionIds.length > 0) {
        const locked = await tx.$queryRaw<LockedCollection[]>`
          SELECT id, "branchId", method, amount, reference, "referenceKey", institution, status, "claimAttemptId", "originSaleId"
          FROM "ExternalCollection"
          WHERE id IN (${Prisma.join(collectionIds)})
          ORDER BY id ASC
          FOR UPDATE
        `;
        for (const collection of locked) lockedCollections.set(collection.id, collection);
      }
      // SECURITY-R3-CROSS-SALE-01 (OWNER): only a collection originated by THIS
      // sale may be applied to it — re-checked here on the locked row,
      // independently of T-R, so a historical or corrupt cross-sale claim can
      // never move money between sales.
      for (const tender of planTenders) {
        if (tender.source !== 'COLLECTION') continue;
        const collection = tender.externalCollectionId === null ? undefined : lockedCollections.get(tender.externalCollectionId);
        if (!collection || collection.branchId !== sale.branchId || collection.originSaleId !== saleId || collection.method !== tender.method
          || collection.amount !== tender.amount || collection.status !== 'UNAPPLIED'
          || collection.claimAttemptId !== attempt.id) {
          return reject(EXTERNAL_COLLECTION_NOT_APPLICABLE, 'El cobro registrado no se puede aplicar a este intento.');
        }
      }
      const newReferences = new Map<ProportionalMethod, { reference: string; referenceKey: string; institution: TransferInstitution | null; institutionOther: string | null }>();
      for (const tender of planTenders) {
        if (tender.source !== 'NEW' || tender.method === 'CASH') continue;
        const method = tender.method as ProportionalMethod;
        const evidence = evidenceByMethod.get(tender.method)!;
        const referenceKey = evidence.referenceKey!;
        const institution = tender.method === 'TRANSFER' ? evidence.institution : null;
        const conflict = await tx.externalCollection.findFirst({
          where: { branchId: sale.branchId, method, referenceKey, institution },
        });
        if (conflict) throw referenceAlreadyRecorded(conflict.status);
        newReferences.set(method, {
          reference: evidence.reference!,
          referenceKey,
          institution,
          institutionOther: tender.method === 'TRANSFER' && evidence.institution === 'OTHER' ? evidence.institutionOther!.trim() : null,
        });
      }

      // 6. An OPEN cash session of the sale's own branch.
      const [session] = await tx.$queryRaw<LockedSession[]>`
        SELECT cs.id, cs.status, cs."registerId", r."branchId"
        FROM "CashSession" cs
        JOIN "CashRegister" r ON r.id = cs."registerId"
        WHERE cs.id = ${attempt.cashSessionId}
        FOR UPDATE OF cs
      `;
      if (!session || session.status !== 'OPEN') return reject(NO_OPEN_CASH_SESSION, 'No hay una sesión de caja abierta.');
      if (session.branchId !== sale.branchId) return reject(CASH_SESSION_BRANCH_MISMATCH, 'La sesión de caja pertenece a otra sucursal.');

      // 7. Stock holds (FIRST_PAYMENT(now)) and inventory, in lock order. An
      //    expired or released hold is CORRECTABLE: 409, the attempt stays
      //    RESERVED and nothing is written.
      const coverageItems = await tx.saleItem.findMany({ where: { saleId }, select: { variantId: true, quantity: true } });
      const activeHolds = await tx.$queryRaw<Array<{ id: string; variantId: string; branchId: string; quantity: bigint; expiresAt: Date }>>`
        SELECT id, "variantId", "branchId", quantity, "expiresAt"
        FROM "StockReservation"
        WHERE "saleId" = ${saleId} AND status = 'ACTIVE'
        ORDER BY id ASC
        FOR UPDATE
      `;
      const coverage = evaluateCurrentHoldCoverage({
        branchId: sale.branchId, items: coverageItems, activeHolds, policy: { kind: 'FIRST_PAYMENT', now: new Date() },
      });
      if (!coverage.ok) {
        if (coverage.reason === 'EXPIRED') throw stockHoldExpired();
        if (coverage.reason === 'NO_ACTIVE_HOLDS' || coverage.reason === 'COVERAGE_MISMATCH') throw stockHoldReleased();
        throw inconsistentState('La reserva de stock de la venta es inválida.');
      }
      const { requirements } = coverage;

      const variantIds = [...requirements.keys()];
      const inventories = await tx.$queryRaw<Array<{ id: string; variantId: string; physical: bigint; reserved: bigint }>>`
        SELECT id, "variantId", physical, reserved
        FROM "Inventory"
        WHERE "branchId" = ${sale.branchId}
          AND "variantId" IN (${Prisma.join(variantIds)})
        ORDER BY id ASC
        FOR UPDATE
      `;
      const inventoryByVariant = new Map(inventories.map((inventory) => [inventory.variantId, inventory]));
      for (const [variantId, required] of requirements) {
        const inventory = inventoryByVariant.get(variantId);
        if (!inventory || inventory.physical < required) {
          return reject(INSUFFICIENT_PHYSICAL, 'El inventario físico no puede cubrir la venta.', { variantId });
        }
        if (inventory.reserved < required) {
          return reject(INSUFFICIENT_RESERVED, 'El inventario reservado no puede cubrir la venta.', { variantId });
        }
      }

      // 8. The settlement, from the sealed plan only.
      const items = await tx.saleItem.findMany({
        where: { saleId },
        select: { id: true, sku: true, quantity: true, baseUnitPrice: true },
        orderBy: { id: 'asc' },
      });
      if (items.length === 0) throw planInconsistent('La venta no tiene renglones.');
      const lines: ProportionalLineInput[] = items.map((item) => {
        if (item.baseUnitPrice === null || item.baseUnitPrice <= 0n || item.quantity <= 0n) {
          throw planInconsistent('Un renglón tiene cantidad o precio base inválido.');
        }
        return { saleItemId: item.id, sku: item.sku, quantity: item.quantity, baseUnitPrice: item.baseUnitPrice };
      });
      const settlement = buildSettlement(attempt, planTenders, lines);
      const tenderByMethod = new Map<string, SealedCheckoutTender>(planTenders.map((tender) => [tender.method, tender]));

      // 9. Writes, in the design's order. The FKs SaleCheckout -> CheckoutAttempt
      //    and ExternalCollection -> SaleCheckout force the confirmation first.
      const now = new Date();
      await tx.sale.update({ where: { id: saleId }, data: { updatedAt: now } });
      await tx.checkoutAttempt.update({
        where: { id: attempt.id },
        data: {
          status: 'CONFIRMED',
          confirmationHash: requestConfirmationHash,
          confirmedById: userId,
          confirmedAt: now,
          confirmReason: supervisorReason,
          confirmEvidence: supervisorEvidence,
        },
      });
      await tx.sale.update({ where: { id: saleId }, data: { total: settlement.total } });
      const checkout = await tx.saleCheckout.create({
        data: {
          saleId,
          branchId: sale.branchId,
          pricingModel: 'PROPORTIONAL_V1',
          operationKey: attempt.operationKey,
          requestHash: requestConfirmationHash,
          cashSessionId: attempt.cashSessionId,
          userId,
          balanceMethod: attempt.balanceMethod,
          referenceSubtotal: sale.subtotal,
          total: settlement.total,
          changeAmount: cashChange,
          fullPriceCash: attempt.fullPriceCash,
          fullPriceTransfer: attempt.fullPriceTransfer,
          fullPriceDebit: attempt.fullPriceDebit,
          fullPriceCredit: attempt.fullPriceCredit,
          transferAdjustmentBps: attempt.transferAdjustmentBps,
          debitAdjustmentBps: attempt.debitAdjustmentBps,
          creditAdjustmentBps: attempt.creditAdjustmentBps,
          pricingConfigId: attempt.pricingConfigId,
          pricingConfigUpdatedAt: attempt.pricingConfigUpdatedAt,
          // The checkout carries the snapshot format of the attempt it settles.
          algorithmVersion: attempt.algorithmVersion,
          attemptStatus: 'CONFIRMED',
          completedAt: now,
        },
      });

      // 9.1 External collections: apply the claimed ones, record the new ones.
      const collectionByMethod = new Map<ProportionalMethod, string>();
      const appliedCollections: Array<{ id: string; method: PaymentMethod; amount: bigint; referenceKey: string; created: boolean }> = [];
      for (const methodSettlement of settlement.methods) {
        if (methodSettlement.method === 'CASH') continue;
        const tender = tenderByMethod.get(methodSettlement.method)!;
        if (tender.source === 'COLLECTION') {
          const id = tender.externalCollectionId!;
          await tx.externalCollection.update({
            where: { id },
            data: { status: 'APPLIED', appliedCheckoutId: checkout.id, appliedSaleId: saleId },
          });
          const collection = lockedCollections.get(id)!;
          collectionByMethod.set(methodSettlement.method, id);
          appliedCollections.push({ id, method: collection.method, amount: collection.amount, referenceKey: collection.referenceKey, created: false });
        } else {
          const reference = newReferences.get(methodSettlement.method)!;
          const created = await tx.externalCollection.create({
            data: {
              branchId: sale.branchId,
              method: methodSettlement.method,
              amount: methodSettlement.amount,
              reference: reference.reference,
              referenceKey: reference.referenceKey,
              institution: reference.institution,
              institutionOther: reference.institutionOther,
              status: 'APPLIED',
              originSaleId: saleId,
              cashSessionId: attempt.cashSessionId,
              appliedCheckoutId: checkout.id,
              appliedSaleId: saleId,
              recordedById: userId,
            },
          });
          collectionByMethod.set(methodSettlement.method, created.id);
          appliedCollections.push({ id: created.id, method: methodSettlement.method, amount: methodSettlement.amount, referenceKey: reference.referenceKey, created: true });
        }
      }

      // 9.2 One SalePayment per method.
      const paymentByMethod = new Map<ProportionalMethod, { id: string; amount: bigint }>();
      for (const methodSettlement of settlement.methods) {
        const isCash = methodSettlement.method === 'CASH';
        const payment = await tx.salePayment.create({
          data: {
            saleId,
            method: methodSettlement.method,
            amount: methodSettlement.amount,
            pricingModel: 'PROPORTIONAL_V1',
            checkoutId: checkout.id,
            tenderRole: methodSettlement.role,
            methodFullPrice: methodSettlement.fullPrice,
            adjustmentBps: settlement.adjustments[methodSettlement.method],
            cashSessionId: attempt.cashSessionId,
            idempotencyKey: `co:${attempt.operationKey}:${methodSettlement.method}`,
            externalCollectionId: isCash ? null : collectionByMethod.get(methodSettlement.method)!,
            receivedAmount: isCash ? (evidenceByMethod.get('CASH')?.receivedAmount ?? 0n) : null,
            changeAmount: isCash ? cashChange : null,
          },
        });
        paymentByMethod.set(methodSettlement.method, { id: payment.id, amount: payment.amount });
      }

      // 9.3 One SaleLineAllocation per method per line.
      for (const methodSettlement of settlement.methods) {
        const payment = paymentByMethod.get(methodSettlement.method)!;
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!;
          const lineFullPrice = methodSettlement.perLine[index]!;
          await tx.saleLineAllocation.create({
            data: {
              checkoutId: checkout.id,
              saleId,
              saleItemId: line.saleItemId,
              salePaymentId: payment.id,
              method: methodSettlement.method,
              quantity: line.quantity,
              baseUnitPrice: line.baseUnitPrice,
              unitPrice: lineFullPrice / line.quantity,
              lineFullPrice,
              amount: methodSettlement.allocations[index]!.amount,
            },
          });
        }
      }

      // 9.4 The net cash income only — CASH-1 reconciliation keeps 1:1.
      const cashSettlement = settlement.methods.find((method) => method.method === 'CASH') ?? null;
      if (cashSettlement) {
        await tx.cashMovement.create({
          data: {
            sessionId: attempt.cashSessionId,
            type: 'SALE_INCOME',
            amount: cashSettlement.amount,
            salePaymentId: paymentByMethod.get('CASH')!.id,
            userId,
          },
        });
      }

      // 9.5 PAID, then the shared finalizer with the SAME transaction.
      await tx.sale.update({ where: { id: saleId }, data: { status: 'PAID' } });
      const finalized = await finalizePaidSaleInTransaction(tx, req, userId, saleId);

      // 10. Audit, all inside the same transaction.
      for (const methodSettlement of settlement.methods) {
        const payment = paymentByMethod.get(methodSettlement.method)!;
        await createAuditLog(tx, {
          userId, branchId: sale.branchId, action: 'PAYMENT_REGISTERED',
          entityType: 'SalePayment', entityId: payment.id,
          before: { saleId, status: 'PENDING_PAYMENT' },
          after: {
            saleId, status: 'PAID', method: methodSettlement.method, tenderRole: methodSettlement.role,
            amount: payment.amount,
            receivedAmount: methodSettlement.method === 'CASH' ? (evidenceByMethod.get('CASH')?.receivedAmount ?? 0n) : null,
            changeAmount: methodSettlement.method === 'CASH' ? cashChange : null,
          },
        });
      }
      await createAuditLog(tx, {
        userId, branchId: sale.branchId, action: 'SALE_CHECKOUT_COMPLETED',
        entityType: 'SaleCheckout', entityId: checkout.id,
        before: { saleId, status: 'PAID' },
        after: {
          checkoutId: checkout.id, requestHash: requestConfirmationHash, total: settlement.total, changeAmount: cashChange,
          balanceMethod: attempt.balanceMethod,
          fullPrices: {
            CASH: attempt.fullPriceCash, TRANSFER: attempt.fullPriceTransfer, CARD_DEBIT: attempt.fullPriceDebit,
            // Only a snapshot sealed with a credit price reports one: a credit-free audit keeps its historical shape.
            ...(attempt.fullPriceCredit === null ? {} : { CARD_CREDIT: attempt.fullPriceCredit }),
          },
          adjustments: {
            transfer: attempt.transferAdjustmentBps, debit: attempt.debitAdjustmentBps,
            ...(attempt.creditAdjustmentBps === null ? {} : { credit: attempt.creditAdjustmentBps }),
          },
          methods: settlement.methods.map((method) => ({ method: method.method, role: method.role, amount: method.amount })),
          supervisor: supervisorReason === null ? null : { byId: userId, reason: supervisorReason },
        },
      });
      for (const collection of appliedCollections) {
        await createAuditLog(tx, {
          userId, branchId: sale.branchId, action: 'EXTERNAL_COLLECTION_APPLIED',
          entityType: 'ExternalCollection', entityId: collection.id,
          before: { status: 'UNAPPLIED' },
          after: { status: 'APPLIED', method: collection.method, amount: collection.amount, referenceKey: collection.referenceKey, appliedSaleId: saleId, created: collection.created },
        });
      }

      // 11. Invariant read inside the transaction: anything off reverts everything.
      const writtenPayments = await tx.salePayment.findMany({ where: { saleId }, select: { amount: true } });
      const writtenAllocations = await tx.saleLineAllocation.findMany({
        where: { checkoutId: checkout.id },
        select: { salePaymentId: true, amount: true },
      });
      const [settled] = await tx.$queryRaw<Array<{ total: bigint }>>`SELECT total FROM "Sale" WHERE id = ${saleId}`;
      const paymentSum = writtenPayments.reduce((sum, payment) => sum + payment.amount, 0n);
      const allocationSum = writtenAllocations.reduce((sum, allocation) => sum + allocation.amount, 0n);
      if (paymentSum !== settlement.total || allocationSum !== settlement.total || checkout.total !== settlement.total || settled?.total !== settlement.total) {
        throw inconsistentState('La conciliación de pagos, asignaciones y total no cierra.');
      }
      // Per-payment reconciliation: the global sums alone would hide two payments
      // whose allocations offset each other.
      const allocationByPayment = new Map<string, bigint>();
      for (const allocation of writtenAllocations) {
        allocationByPayment.set(allocation.salePaymentId, (allocationByPayment.get(allocation.salePaymentId) ?? 0n) + allocation.amount);
      }
      for (const methodSettlement of settlement.methods) {
        const payment = paymentByMethod.get(methodSettlement.method)!;
        if ((allocationByPayment.get(payment.id) ?? 0n) !== payment.amount) {
          throw inconsistentState('Las asignaciones de un pago no concilian con su importe.');
        }
      }

      return {
        kind: 'CONFIRMED',
        result: {
          saleId,
          saleNumber: finalized.saleNumber,
          status: 'COMPLETED' as const,
          checkoutId: checkout.id,
          replayed: false,
          total: settlement.total,
          changeAmount: cashChange,
          payments: settlement.methods.map((methodSettlement) => ({
            id: paymentByMethod.get(methodSettlement.method)!.id,
            method: methodSettlement.method,
            tenderRole: methodSettlement.role,
            amount: methodSettlement.amount,
            methodFullPrice: methodSettlement.fullPrice,
            adjustmentBps: settlement.adjustments[methodSettlement.method],
            externalCollectionId: methodSettlement.method === 'CASH' ? null : collectionByMethod.get(methodSettlement.method)!,
            receivedAmount: methodSettlement.method === 'CASH' ? (evidenceByMethod.get('CASH')?.receivedAmount ?? 0n) : null,
            changeAmount: methodSettlement.method === 'CASH' ? cashChange : null,
          })),
          lines: settlement.methods.length === 0 ? [] : lines.map((line, index) => ({
            saleItemId: line.saleItemId,
            sku: line.sku,
            quantity: line.quantity,
            finalAmount: settlement.methods.reduce((sum, method) => sum + method.allocations[index]!.amount, 0n),
          })),
          completedAt: checkout.completedAt,
        },
      };
    }, { isolationLevel: 'Serializable', timeout: CHECKOUT_TIMEOUT_MS });

    // A P2002 for one of the two partial EXTERNAL reference indexes is the SAME
    // domain error as the in-transaction pre-check (409
    // EXTERNAL_REFERENCE_ALREADY_RECORDED) and stays CORRECTABLE. It arrives here
    // only AFTER the transaction has rolled back, so the attempt stays RESERVED
    // and no partial settlement can survive. Detection is by the unique
    // constraint (isExternalReferenceCollision, prisma-unique-violation.ts:
    // meta.target or the adapter-pg 7.10 shape — R-1/R-2): the partial index by
    // SQL name, or its column list. Any other constraint (SaleCheckout
    // operationKey/saleId, SalePayment, ...) is never converted.

    // Read-only, OUTSIDE the failed transaction and with NO lock: which proposed
    // reference is now recorded, and in which state. `null` = no proposed
    // reference is recorded, so the collision was not a reference race and the
    // original error must stand (never an invented status).
    const recordedReferenceStatus = async (): Promise<string | null> => {
      if (proposedReferences.length === 0) return null;
      const sale = await database.sale.findUnique({ where: { id: saleId }, select: { branchId: true } });
      if (!sale) return null;
      for (const reference of proposedReferences) {
        const recorded = await database.externalCollection.findFirst({
          where: {
            branchId: sale.branchId,
            method: reference.method,
            referenceKey: reference.referenceKey,
            institution: reference.institution,
          },
          select: { status: true },
        });
        if (recorded) return recorded.status;
      }
      return null;
    };

    for (let attemptNumber = 0; attemptNumber < MAX_ATTEMPTS; attemptNumber += 1) {
      let outcome: ConfirmOutcome;
      try {
        outcome = await confirmAttempt();
      } catch (error) {
        if (isExternalReferenceCollision(error)) {
          const status = await recordedReferenceStatus();
          if (status !== null) throw referenceAlreadyRecorded(status);
        }
        if (!transient(error)) throw error;
        if (attemptNumber === MAX_ATTEMPTS - 1) throw concurrencyError();
        continue;
      }
      if (outcome.kind === 'REJECTED') {
        throw new AppError(409, outcome.code, outcome.message, {
          ...outcome.details,
          attempt: { reserveKey: request.reserveKey, operationKey: request.operationKey, status: 'REJECTED' },
        });
      }
      return outcome.result;
    }
    throw concurrencyError();
  }

  return { checkout };
}

export type CheckoutService = ReturnType<typeof createCheckoutService>;
