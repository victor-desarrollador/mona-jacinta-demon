import type { PriceType, PrismaClient, SalePayment, SalePricingModel } from '../../generated/prisma/client.js';
import { assertPermissionAtLocation } from '../../middleware/authorization.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import type { RegisterPaymentInput } from './dto/payment.dto.js';
import { evaluateCurrentHoldCoverage } from '../sales/hold-coverage.js';
import { assertPricingFinalizable } from '../sales/wholesale-authorization.service.js';
import { assertPaymentCompatible, type PriceMode } from '../pricing/pricing.js';
import { uniqueViolation } from './prisma-unique-violation.js';

type RequestLike = Parameters<typeof assertPermissionAtLocation>[0];
type LockedSale = {
  id: string; branchId: string; status: string; total: bigint;
  pricingMode: PriceType; priceMode: PriceMode; pricingModel: SalePricingModel;
  wholesaleConfirmedAt: Date | null; wholesaleConfirmedById: string | null;
};

const transient = (error: unknown) => {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034' || candidate.meta?.code === '40001'
    || candidate.meta?.code === '40P01' || message.includes('40001')
    || message.includes('40P01') || message.includes('TransactionWriteConflict');
};

// The SalePayment (saleId, idempotencyKey) unique key, read from meta.target or
// the adapter-pg 7.10 shape (R-1, prisma-unique-violation.ts); a column list
// must name both columns, a constraint name must contain idempotencyKey.
// Exported for the classification unit tests only.
export const isIdempotencyConflict = (error: unknown) => {
  const violation = uniqueViolation(error);
  if (violation === null) return false;
  return violation.fields !== null
    ? violation.fields.includes('saleId') && violation.fields.includes('idempotencyKey')
    : violation.name !== null && violation.name.includes('idempotencyKey');
};

function invalidState() {
  return new AppError(409, 'INVALID_SALE_STATE', 'La venta no admite nuevos pagos en su estado actual.');
}

// R3-A3.4 (R3 rev. 2 §5): a PROPORTIONAL_V1 sale is settled ONLY by the
// proportional checkout. The decision is the persisted Sale.pricingModel read
// under the Sale row lock (below), never the branch policy variable, which is
// consulted once by createDraftSale. No payment, cash movement, reservation
// change or audit row is written on this path.
function checkoutRequired() {
  return new AppError(409, 'CHECKOUT_REQUIRED', 'Esta venta se cobra con el checkout proporcional.');
}

// System V2 P0-A (Matrix R4 domain 6, FR-PAY-006): the historical FIXED_TOTAL
// path takes CASH only. It never recorded a reference, an institution or any
// evidence for a non-cash payment, so such a sale could be marked PAID with a
// payment that never existed. The only valid evidence contract for a non-cash
// method is ExternalCollection, which exists inside the PROPORTIONAL_V1
// checkout; nothing is added to SalePayment and ExternalCollection is not
// duplicated here. Nothing is written when this refuses.
function nonCashRequiresCheckout() {
  return new AppError(
    409,
    'NON_CASH_REQUIRES_PROPORTIONAL_CHECKOUT',
    'Los cobros con transferencia, tarjeta o QR se registran con el checkout proporcional; el cobro tradicional solo admite efectivo.',
  );
}

// Pilot P0.1-C: stable, detail-free rejections for a NEW payment. The
// inventory/reservation specifics are never exposed.
function reservationExpired() {
  return new AppError(409, 'RESERVATION_EXPIRED', 'La reserva de la venta venció; no admite un primer pago.');
}

function invalidReservation() {
  return new AppError(409, 'INVALID_RESERVATION', 'La venta no tiene reservas vigentes que respalden sus artículos.');
}

function sameIntent(payment: SalePayment, input: RegisterPaymentInput) {
  return payment.method === input.method
    && payment.amount === input.amount
    && payment.receivedAmount === input.receivedAmount;
}

export function createPaymentsService(database: PrismaClient) {
  // Phase 1D.3.2 SWITCH: the real decision is the Production SALE_CHARGE
  // grant paired with this sale's own persisted branchId
  // (req.auth.assignments), not a bare effectiveLocationIds membership
  // check — matches the route's own requirePermission(SALE_CHARGE) gate.
  function assertCurrentBranch(req: RequestLike, branchId: string) {
    assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CHARGE, branchId);
  }

  async function findExisting(idempotencyKey: string, saleId: string) {
    return database.$transaction((tx) => tx.salePayment.findUnique({
      where: { saleId_idempotencyKey: { saleId, idempotencyKey } },
    }));
  }

  async function attempt(req: RequestLike, userId: string, saleId: string, input: RegisterPaymentInput) {
    return database.$transaction(async (tx) => {
      const [sale] = await tx.$queryRaw<LockedSale[]>`
        SELECT id, "branchId", status, total, "pricingMode", "priceMode", "pricingModel", "wholesaleConfirmedAt", "wholesaleConfirmedById"
        FROM "Sale" WHERE id = ${saleId} FOR UPDATE
      `;
      if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
      assertCurrentBranch(req, sale.branchId);

      // R3-A3.4 (R3 rev. 2 §5): the durable path, decided on the row just
      // locked. A proportional sale never takes the historical payment path —
      // not even a replay of its own key.
      if (sale.pricingModel === 'PROPORTIONAL_V1') throw checkoutRequired();

      const existing = await tx.salePayment.findUnique({
        where: { saleId_idempotencyKey: { saleId, idempotencyKey: input.idempotencyKey } },
      });
      if (existing) {
        if (!sameIntent(existing, input)) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'La clave de idempotencia ya fue utilizada con otro pago.');
        return { payment: existing, replayed: true, saleId, branchId: sale.branchId, resultingStatus: sale.status };
      }
      // System V2 P0-A: after the idempotent replay (a historical non-cash row
      // for the same key is still returned above, never refused), under the
      // Sale lock and before any new write or state decision: this sale is
      // FIXED_TOTAL here (PROPORTIONAL_V1 already took the checkout route), and
      // a FIXED_TOTAL sale is settled in cash only. The refused intent consumes
      // no idempotency key because nothing is written.
      if (input.method !== 'CASH') throw nonCashRequiresCheckout();
      if (sale.status !== 'PENDING_PAYMENT') throw invalidState();

      // Pilot P0.1-C: a NEW payment needs exact CURRENT hold coverage
      // (ACTIVE rows only == current SaleItems, same branch). Every writer
      // of StockReservation.status (B1/B2 release, cancel, complete) takes
      // this same Sale lock first, so these plain reads cannot race them.
      // Expiry: zero SalePayment rows -> the holds must still be unexpired;
      // any existing row (Policy A, row existence, never the sum) protects
      // them. The clock is read here, once per decision, never from input.
      // Detection only: nothing is released from the payment path.
      const payments = await tx.salePayment.findMany({ where: { saleId }, select: { amount: true } });
      // Block 1: a WHOLESALE sale takes no payment (not even a partial one)
      // until a cashier confirmed it.
      assertPricingFinalizable(sale);
      assertPaymentCompatible(sale.priceMode, input.method);
      const items = await tx.saleItem.findMany({ where: { saleId }, select: { variantId: true, quantity: true } });
      const activeHolds = await tx.stockReservation.findMany({
        where: { saleId, status: 'ACTIVE' },
        select: { variantId: true, branchId: true, quantity: true, expiresAt: true },
      });
      const coverage = evaluateCurrentHoldCoverage({
        branchId: sale.branchId, items, activeHolds,
        policy: payments.length === 0 ? { kind: 'FIRST_PAYMENT', now: new Date() } : { kind: 'PAYMENT_PROTECTED' },
      });
      if (!coverage.ok) throw coverage.reason === 'EXPIRED' ? reservationExpired() : invalidReservation();

      const accepted = payments.reduce((sum, payment) => sum + payment.amount, 0n);
      const remaining = sale.total - accepted;
      if (input.amount > remaining) throw new AppError(409, 'OVERPAYMENT', 'El importe supera el saldo pendiente.');

      let cashSessionId: string | null = null;
      let changeAmount: bigint | null = null;
      if (input.method === 'CASH') {
        const register = await tx.cashRegister.findFirst({ where: { branchId: sale.branchId }, orderBy: { id: 'asc' } });
        // CASH-1: take the same CashSession row lock the reconciliation close
        // uses (cash.service.ts closes with SELECT ... FOR UPDATE on this
        // row), so a cash charge and a close can never interleave on one
        // session. Lock order is Sale -> CashSession on every path that takes
        // both; the close locks only the session.
        const [session] = register
          ? await tx.$queryRaw<{ id: string }[]>`
              SELECT id FROM "CashSession" WHERE "registerId" = ${register.id} AND "status" = 'OPEN' FOR UPDATE
            `
          : [];
        if (!session) throw new AppError(409, 'NO_OPEN_CASH_SESSION', 'No hay una sesión de caja abierta.');
        cashSessionId = session.id;
        changeAmount = input.receivedAmount! - input.amount;
      }

      const payment = await tx.salePayment.create({ data: {
        saleId, method: input.method, amount: input.amount,
        receivedAmount: input.receivedAmount, changeAmount, cashSessionId,
        idempotencyKey: input.idempotencyKey,
      } });
      // Block 1: Sale.paymentStartedAt (durable payment history) is
      // maintained by the database from this SalePayment row, in this same
      // transaction (see the Block 1 migration); the service never writes it.
      if (cashSessionId) {
        await tx.cashMovement.create({ data: {
          sessionId: cashSessionId, type: 'SALE_INCOME', amount: payment.amount,
          salePaymentId: payment.id, userId,
        } });
      }

      const newTotal = accepted + payment.amount;
      const resultingStatus = newTotal === sale.total ? 'PAID' : 'PENDING_PAYMENT';
      if (resultingStatus === 'PAID') {
        await tx.sale.update({ where: { id: saleId }, data: { status: 'PAID' } });
      }
      await createAuditLog(tx, {
        userId, branchId: sale.branchId, action: 'PAYMENT_REGISTERED',
        entityType: 'SalePayment', entityId: payment.id,
        before: { saleId, status: sale.status },
        after: { saleId, status: resultingStatus, method: payment.method, amount: payment.amount,
          receivedAmount: payment.receivedAmount, changeAmount: payment.changeAmount },
      });
      return { payment, replayed: false, saleId, branchId: sale.branchId, resultingStatus };
    }, { isolationLevel: 'Serializable', timeout: 30000 });
  }

  async function registerPayment(req: RequestLike, userId: string, saleId: string, input: RegisterPaymentInput) {
    for (let attemptNumber = 0; attemptNumber < 3; attemptNumber += 1) {
      try {
        return await attempt(req, userId, saleId, input);
      } catch (error) {
        if (isIdempotencyConflict(error)) {
          // The compound database unique constraint is the final race guard. Resolve its winner in a fresh transaction.
          const existing = await findExisting(input.idempotencyKey, saleId);
          if (existing) {
            if (!sameIntent(existing, input)) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'La clave de idempotencia ya fue utilizada con otro pago.');
            const sale = await database.sale.findUniqueOrThrow({ where: { id: saleId }, select: { branchId: true, status: true } });
            return { payment: existing, replayed: true, saleId, branchId: sale.branchId, resultingStatus: sale.status };
          }
          throw error;
        }
        if (!transient(error)) throw error;
        if (attemptNumber === 2) throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
      }
    }
    throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
  }

  // Phase 1D.3.2 SWITCH: the real decision is the Production SALE_VIEW grant
  // paired with this sale's own persisted branchId (req.auth.assignments) —
  // matches the route's own requirePermission(SALE_VIEW) gate.
  async function listPayments(req: RequestLike, saleId: string) {
    const sale = await database.sale.findUnique({ where: { id: saleId }, select: { id: true, branchId: true } });
    if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
    assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_VIEW, sale.branchId);
    return database.salePayment.findMany({ where: { saleId }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] });
  }

  return { registerPayment, listPayments };
}
