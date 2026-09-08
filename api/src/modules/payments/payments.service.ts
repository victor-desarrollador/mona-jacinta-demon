import type { Prisma, PrismaClient, SalePayment } from '../../generated/prisma/client.js';
import { assertBranchAccess } from '../../middleware/authorization.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import type { RegisterPaymentInput } from './dto/payment.dto.js';

type RequestLike = Parameters<typeof assertBranchAccess>[0];
type LockedSale = { id: string; branchId: string; status: string; total: bigint };

const transient = (error: unknown) => {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034' || candidate.meta?.code === '40001'
    || candidate.meta?.code === '40P01' || message.includes('40001')
    || message.includes('40P01') || message.includes('TransactionWriteConflict');
};

const isIdempotencyConflict = (error: unknown) => {
  const candidate = error as { code?: string; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  return Array.isArray(target)
    ? target.includes('saleId') && target.includes('idempotencyKey')
    : typeof target === 'string' && target.includes('idempotencyKey');
};

function invalidState() {
  return new AppError(409, 'INVALID_SALE_STATE', 'La venta no admite nuevos pagos en su estado actual.');
}

function sameIntent(payment: SalePayment, input: RegisterPaymentInput) {
  return payment.method === input.method
    && payment.amount === input.amount
    && payment.receivedAmount === input.receivedAmount;
}

export function createPaymentsService(database: PrismaClient) {
  async function assertCurrentBranch(
    tx: Prisma.TransactionClient, req: RequestLike, userId: string, branchId: string,
  ) {
    if (!req.auth?.branchIds.includes(branchId)) throw new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
    const assignment = await tx.userBranchRole.findFirst({ where: { userId, branchId }, select: { id: true } });
    if (!assignment) throw new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
  }

  async function findExisting(idempotencyKey: string, saleId: string) {
    return database.$transaction((tx) => tx.salePayment.findUnique({
      where: { saleId_idempotencyKey: { saleId, idempotencyKey } },
    }));
  }

  async function attempt(req: RequestLike, userId: string, saleId: string, input: RegisterPaymentInput) {
    return database.$transaction(async (tx) => {
      const [sale] = await tx.$queryRaw<LockedSale[]>`
        SELECT id, "branchId", status, total FROM "Sale" WHERE id = ${saleId} FOR UPDATE
      `;
      if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
      await assertCurrentBranch(tx, req, userId, sale.branchId);

      const existing = await tx.salePayment.findUnique({
        where: { saleId_idempotencyKey: { saleId, idempotencyKey: input.idempotencyKey } },
      });
      if (existing) {
        if (!sameIntent(existing, input)) throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'La clave de idempotencia ya fue utilizada con otro pago.');
        return { payment: existing, replayed: true, saleId, branchId: sale.branchId, resultingStatus: sale.status };
      }
      if (sale.status !== 'PENDING_PAYMENT') throw invalidState();

      // Cancellation/expiry serializes on Sale. If this sale has reservations,
      // payment is only valid while they are still ACTIVE. This closes the
      // payment-vs-expiry race without changing payment amounts.
      const reservationStates = await tx.stockReservation.findMany({
        where: { saleId },
        select: { status: true },
      });
      if (reservationStates.length > 0 && reservationStates.some(({ status }) => status !== 'ACTIVE')) {
        throw new AppError(409, 'INVALID_RESERVATION', 'La venta ya no tiene reservas activas.');
      }

      const payments = await tx.salePayment.findMany({ where: { saleId }, select: { amount: true } });
      const accepted = payments.reduce((sum, payment) => sum + payment.amount, 0n);
      const remaining = sale.total - accepted;
      if (input.amount > remaining) throw new AppError(409, 'OVERPAYMENT', 'El importe supera el saldo pendiente.');

      let cashSessionId: string | null = null;
      let changeAmount: bigint | null = null;
      if (input.method === 'CASH') {
        const register = await tx.cashRegister.findFirst({ where: { branchId: sale.branchId }, orderBy: { id: 'asc' } });
        const session = register ? await tx.cashSession.findFirst({ where: { registerId: register.id, status: 'OPEN' } }) : null;
        if (!session) throw new AppError(409, 'NO_OPEN_CASH_SESSION', 'No hay una sesión de caja abierta.');
        cashSessionId = session.id;
        changeAmount = input.receivedAmount! - input.amount;
      }

      const payment = await tx.salePayment.create({ data: {
        saleId, method: input.method, amount: input.amount,
        receivedAmount: input.receivedAmount, changeAmount, cashSessionId,
        idempotencyKey: input.idempotencyKey,
      } });
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

  async function listPayments(req: RequestLike, userId: string, saleId: string) {
    const sale = await database.sale.findUnique({ where: { id: saleId }, select: { id: true, branchId: true } });
    if (!sale) throw new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
    assertBranchAccess(req, sale.branchId);
    const assignment = await database.userBranchRole.findFirst({ where: { userId, branchId: sale.branchId }, select: { id: true } });
    if (!assignment) throw new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
    return database.salePayment.findMany({ where: { saleId }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] });
  }

  return { registerPayment, listPayments };
}
