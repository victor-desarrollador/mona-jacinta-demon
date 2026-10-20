// R3-A4.3 S4: the read model of a durable checkout attempt (ReservationView),
// shared by the reservation responses, the per-sale reads and
// /checkout-attempts/recent. Consolidated §3 (ReservationView) + C1–C5 §1/§4.1
// (stockState, stockExpiresAt).
//
// stockState is computed when read, never stored, and only for a RESERVED
// attempt (it is meaningless once the attempt is terminal):
//   VALID         exact ACTIVE coverage, every hold unexpired (FIRST_PAYMENT(now));
//   EXPIRED       exact ACTIVE coverage, some hold with expiresAt <= now;
//   RELEASED      no ACTIVE coverage, total or partial (sweeper or B1/B2 released it);
//   INCONSISTENT  a hold of another branch or with quantity <= 0, or no items.
// Every read here is a plain read: no lock, no write.
import type { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { CHECKOUT_METHODS } from './checkout-canonical.js';
import type { CheckoutResult, CheckoutTenderRole } from './checkout.service.js';
import { evaluateCurrentHoldCoverage, type CoverageHold, type CoverageItem } from '../sales/hold-coverage.js';

export type StockState = 'VALID' | 'EXPIRED' | 'RELEASED' | 'INCONSISTENT';
export type StockView = { stockState: StockState; stockExpiresAt: Date | null };

export function stockStateOf(input: { branchId: string; items: CoverageItem[]; activeHolds: CoverageHold[]; now: Date }): StockView {
  const stockExpiresAt = input.activeHolds.length === 0
    ? null
    : new Date(Math.min(...input.activeHolds.map((hold) => hold.expiresAt.getTime())));
  const coverage = evaluateCurrentHoldCoverage({
    branchId: input.branchId, items: input.items, activeHolds: input.activeHolds, policy: { kind: 'FIRST_PAYMENT', now: input.now },
  });
  if (coverage.ok) return { stockState: 'VALID', stockExpiresAt };
  switch (coverage.reason) {
    case 'EXPIRED': return { stockState: 'EXPIRED', stockExpiresAt };
    case 'NO_ACTIVE_HOLDS':
    case 'COVERAGE_MISMATCH': return { stockState: 'RELEASED', stockExpiresAt };
    default: return { stockState: 'INCONSISTENT', stockExpiresAt };
  }
}

type AttemptRow = {
  reserveKey: string; operationKey: string; status: string; startedById: string; startedAt: Date;
  cashSessionId: string; balanceMethod: string; expectedTotal: bigint; expectedBalanceAmount: bigint; tenderCount: number;
  fullPriceCash: bigint; fullPriceTransfer: bigint | null; fullPriceDebit: bigint | null; fullPriceCredit?: bigint | null;
  recoveryReason: string | null; recoveryEvidence: string | null;
  rejectionCode: string | null; rejectionDetails: unknown; declaredById: string | null; declaredAt: Date | null;
};
type TenderRow = { method: string; role: string; source: string; amount: bigint | null; externalCollectionId: string | null };
type DeclarationRow = {
  method: string; tenderSource: string; outcome: string; externalCollectionId: string | null;
  returnedAmount: bigint | null; evidence: string | null;
};

export type ReservationView = {
  reserveKey: string;
  operationKey: string;
  status: string;
  startedBy: { id: string; name: string | null };
  startedAt: Date;
  plan: {
    cashSessionId: string;
    balanceMethod: string;
    expectedTotal: bigint;
    expectedBalanceAmount: bigint;
    tenderCount: number;
    tenders: TenderRow[];
    fullPrices: { CASH: bigint; TRANSFER: bigint | null; CARD_DEBIT: bigint | null; CARD_CREDIT: bigint | null };
  };
  recovery: { reason: string; evidence: string } | null;
  rejection: { code: string; details: unknown } | null;
  declaration: { declaredById: string; declaredAt: Date; rows: DeclarationRow[] } | null;
  declared: boolean;
  stockState: StockState | null;
  stockExpiresAt: Date | null;
};

const methodOrder = (method: string) => (CHECKOUT_METHODS as readonly string[]).indexOf(method);

export function buildReservationView(input: {
  attempt: AttemptRow;
  tenders: TenderRow[];
  declarations: DeclarationRow[];
  startedBy: { id: string; name: string | null };
  stock: StockView | null;
}): ReservationView {
  const { attempt } = input;
  const stock = attempt.status === 'RESERVED' ? input.stock : null;
  return {
    reserveKey: attempt.reserveKey,
    operationKey: attempt.operationKey,
    status: attempt.status,
    startedBy: input.startedBy,
    startedAt: attempt.startedAt,
    plan: {
      cashSessionId: attempt.cashSessionId,
      balanceMethod: attempt.balanceMethod,
      expectedTotal: attempt.expectedTotal,
      expectedBalanceAmount: attempt.expectedBalanceAmount,
      tenderCount: attempt.tenderCount,
      tenders: [...input.tenders].sort((a, b) => methodOrder(a.method) - methodOrder(b.method)).map((tender) => ({
        method: tender.method, role: tender.role, source: tender.source, amount: tender.amount, externalCollectionId: tender.externalCollectionId,
      })),
      fullPrices: {
        CASH: attempt.fullPriceCash, TRANSFER: attempt.fullPriceTransfer, CARD_DEBIT: attempt.fullPriceDebit,
        CARD_CREDIT: attempt.fullPriceCredit ?? null,
      },
    },
    recovery: attempt.recoveryReason === null || attempt.recoveryEvidence === null
      ? null
      : { reason: attempt.recoveryReason, evidence: attempt.recoveryEvidence },
    rejection: attempt.rejectionCode === null ? null : { code: attempt.rejectionCode, details: attempt.rejectionDetails ?? null },
    declaration: attempt.declaredAt === null || attempt.declaredById === null
      ? null
      : {
        declaredById: attempt.declaredById,
        declaredAt: attempt.declaredAt,
        rows: [...input.declarations].sort((a, b) => methodOrder(a.method) - methodOrder(b.method)).map((row) => ({
          method: row.method, tenderSource: row.tenderSource, outcome: row.outcome, externalCollectionId: row.externalCollectionId,
          returnedAmount: row.returnedAmount, evidence: row.evidence,
        })),
      },
    declared: attempt.declaredAt !== null,
    stockState: stock?.stockState ?? null,
    stockExpiresAt: stock?.stockExpiresAt ?? null,
  };
}

type ConfirmedReader = Pick<Prisma.TransactionClient, 'saleCheckout' | 'sale'>;
type Reader = ConfirmedReader & Pick<Prisma.TransactionClient, 'checkoutAttemptTender' | 'checkoutAttemptDeclaration' | 'user' | 'saleItem' | 'stockReservation'>;
type AttemptKeys = { id: string; saleId: string; branchId: string; status: string; operationKey: string; confirmationHash: string | null };

const inconsistent = (message: string) => new AppError(500, 'CHECKOUT_STATE_INCONSISTENT', message);

// A CONFIRMED attempt exists only together with its committed checkout
// (SaleCheckout_attempt_fkey: same operationKey, saleId and hash, attemptStatus
// CONFIRMED), which is the sale's ONLY checkout (SaleCheckout_saleId_key), of
// the same branch, on a COMPLETED sale. Any missing or mismatching link is a
// defect: it fails closed with 500, never a view with a null checkout.
export async function requireConfirmedCheckout(reader: ConfirmedReader, attempt: AttemptKeys) {
  const checkout = await reader.saleCheckout.findUnique({ where: { operationKey: attempt.operationKey } });
  if (!checkout) throw inconsistent('El intento confirmado no tiene su checkout.');
  if (checkout.saleId !== attempt.saleId || checkout.branchId !== attempt.branchId) {
    throw inconsistent('El checkout del intento confirmado pertenece a otra venta o sucursal.');
  }
  if (attempt.confirmationHash === null || checkout.requestHash !== attempt.confirmationHash || checkout.attemptStatus !== 'CONFIRMED') {
    throw inconsistent('El checkout no coincide con la confirmación del intento.');
  }
  // SaleCheckout_saleId_key makes this exactly one row in PostgreSQL; counted
  // anyway so a second checkout can never be silently ignored.
  const saleCheckouts = await reader.saleCheckout.findMany({ where: { saleId: attempt.saleId }, select: { id: true }, take: 2 });
  if (saleCheckouts.length !== 1 || saleCheckouts[0]!.id !== checkout.id) throw inconsistent('La venta tiene otro checkout que el del intento confirmado.');
  const sale = await reader.sale.findFirst({ where: { id: attempt.saleId }, select: { id: true, saleNumber: true, status: true } });
  if (!sale || sale.status !== 'COMPLETED') throw inconsistent('La venta de un intento confirmado no está COMPLETED.');
  return { checkout, sale };
}

// Loads what a view needs for one attempt (plain reads). A CONFIRMED attempt is
// verified against its checkout first (requireConfirmedCheckout).
export async function loadReservationView(
  reader: Reader,
  attempt: AttemptRow & AttemptKeys,
  now: Date,
): Promise<ReservationView> {
  if (attempt.status === 'CONFIRMED') await requireConfirmedCheckout(reader, attempt);
  const tenders = await reader.checkoutAttemptTender.findMany({ where: { attemptId: attempt.id } });
  const declarations = attempt.declaredAt === null ? [] : await reader.checkoutAttemptDeclaration.findMany({ where: { attemptId: attempt.id } });
  const user = await reader.user.findUnique({ where: { id: attempt.startedById }, select: { id: true, name: true } });
  let stock: StockView | null = null;
  if (attempt.status === 'RESERVED') {
    const items = await reader.saleItem.findMany({ where: { saleId: attempt.saleId }, select: { variantId: true, quantity: true } });
    const activeHolds = await reader.stockReservation.findMany({
      where: { saleId: attempt.saleId, status: 'ACTIVE' },
      select: { variantId: true, branchId: true, quantity: true, expiresAt: true },
    });
    stock = stockStateOf({ branchId: attempt.branchId, items, activeHolds, now });
  }
  return buildReservationView({
    attempt, tenders, declarations, startedBy: { id: attempt.startedById, name: user?.name ?? null }, stock,
  });
}

type CheckoutReader = ConfirmedReader & Pick<Prisma.TransactionClient, 'salePayment' | 'saleLineAllocation' | 'saleItem'>;

// Read-only projection of the committed checkout of a CONFIRMED attempt (for a
// lost confirmation response). Same shape as the R3-A2 CheckoutResult. Never
// null: an incoherent confirmation fails closed (requireConfirmedCheckout), and
// only the payments of THIS checkout are read (SalePayment.checkoutId).
export async function readCheckoutResult(reader: CheckoutReader, attempt: AttemptKeys): Promise<CheckoutResult> {
  const { checkout, sale } = await requireConfirmedCheckout(reader, attempt);
  const saleId = attempt.saleId;
  const payments = await reader.salePayment.findMany({ where: { checkoutId: checkout.id }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] });
  const allocations = await reader.saleLineAllocation.findMany({ where: { checkoutId: checkout.id }, orderBy: { id: 'asc' } });
  const items = await reader.saleItem.findMany({ where: { saleId }, select: { id: true, sku: true, quantity: true }, orderBy: { id: 'asc' } });
  const totals = new Map<string, bigint>();
  for (const allocation of allocations) totals.set(allocation.saleItemId, (totals.get(allocation.saleItemId) ?? 0n) + allocation.amount);
  return {
    saleId,
    saleNumber: sale.saleNumber,
    status: 'COMPLETED',
    checkoutId: checkout.id,
    replayed: true,
    total: checkout.total,
    changeAmount: checkout.changeAmount,
    payments: payments.map((payment) => ({
      id: payment.id,
      method: payment.method,
      tenderRole: payment.tenderRole as CheckoutTenderRole,
      amount: payment.amount,
      methodFullPrice: payment.methodFullPrice ?? 0n,
      adjustmentBps: payment.adjustmentBps ?? 0,
      externalCollectionId: payment.externalCollectionId,
      receivedAmount: payment.receivedAmount,
      changeAmount: payment.changeAmount,
    })),
    lines: items.map((item) => ({ saleItemId: item.id, sku: item.sku, quantity: item.quantity, finalAmount: totals.get(item.id) ?? 0n })),
    completedAt: checkout.completedAt,
  } as CheckoutResult;
}
