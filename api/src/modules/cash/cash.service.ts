import type { CashSession, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { hasBranchAccess, hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';

const conflict = (opening: boolean) => new AppError(409,
  opening ? 'CASH_SESSION_ALREADY_OPEN' : 'CASH_SESSION_ALREADY_CLOSED',
  opening ? 'La caja ya tiene una sesión abierta.' : 'La sesión ya está cerrada.');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
const summary = (session: CashSession, branchId: string) => {
  const { id, ...fields } = session;
  return { sessionId: id, ...fields, branchId };
};

// CASH-1 (FR-CASH-001): PostgreSQL signed BIGINT bounds. The reconciliation
// refuses instead of letting any intermediate value wrap or exceed them.
const MAX_SIGNED_BIGINT = 9223372036854775807n;
const MIN_SIGNED_BIGINT = -9223372036854775808n;

export type CashReconciliationMovement = { type: string; amount: bigint; salePaymentId: string | null };
export type CashReconciliationPayment = { id: string; amount: bigint };

export type CashReconciliation =
  | { ok: true; expectedCash: bigint; difference: bigint }
  | {
      ok: false;
      reason:
        | 'MISSING_OPENING'
        | 'DUPLICATE_OPENING'
        | 'OPENING_AMOUNT_MISMATCH'
        | 'MOVEMENT_TYPE_NOT_ALLOWED'
        | 'PAYMENT_MOVEMENT_MISMATCH'
        | 'AMOUNT_OVERFLOW';
    };

// CASH-1: the pure, database-free reconciliation of one cash session.
//
// expectedCash = startingCash + the net SALE_INCOME movements:
//   - the OPENING row must exist exactly once and match startingCash — it is
//     consumed as the base, never summed again (no duplicated opening);
//   - a CLOSING row is not income and is deliberately excluded;
//   - MANUAL or any unknown movement type makes the session non-reconcilable
//     (fail closed);
//   - every SALE_INCOME movement must map 1:1, by salePaymentId and by NET
//     amount, to a CASH payment bound to this session — the change (vuelto)
//     returns to the customer, so the drawer keeps `amount`, never
//     `receivedAmount`;
//   - every accumulation is bounds-checked against signed BIGINT.
// difference = countedCash - expectedCash (positive: sobra; negative: falta).
export function reconcileCashSession(input: {
  startingCash: bigint;
  movements: CashReconciliationMovement[];
  cashPayments: CashReconciliationPayment[];
  countedCash: bigint;
}): CashReconciliation {
  const openings = input.movements.filter((movement) => movement.type === 'OPENING');
  if (openings.length === 0) return { ok: false, reason: 'MISSING_OPENING' };
  if (openings.length > 1) return { ok: false, reason: 'DUPLICATE_OPENING' };
  if (openings[0]!.amount !== input.startingCash) return { ok: false, reason: 'OPENING_AMOUNT_MISMATCH' };

  let income = 0n;
  const movementByPaymentId = new Map<string, bigint>();
  for (const movement of input.movements) {
    if (movement.type === 'OPENING' || movement.type === 'CLOSING') continue;
    if (movement.type !== 'SALE_INCOME') return { ok: false, reason: 'MOVEMENT_TYPE_NOT_ALLOWED' };
    if (movement.salePaymentId === null) return { ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' };
    if (movementByPaymentId.has(movement.salePaymentId)) return { ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' };
    movementByPaymentId.set(movement.salePaymentId, movement.amount);
    income += movement.amount;
    if (income > MAX_SIGNED_BIGINT || income < MIN_SIGNED_BIGINT) return { ok: false, reason: 'AMOUNT_OVERFLOW' };
  }

  const paymentAmounts = new Map(input.cashPayments.map((payment) => [payment.id, payment.amount]));
  if (paymentAmounts.size !== input.cashPayments.length) return { ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' };
  if (movementByPaymentId.size !== paymentAmounts.size) return { ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' };
  for (const [paymentId, amount] of paymentAmounts) {
    const movementAmount = movementByPaymentId.get(paymentId);
    if (movementAmount === undefined || movementAmount !== amount) {
      return { ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' };
    }
  }

  const expectedCash = input.startingCash + income;
  if (expectedCash > MAX_SIGNED_BIGINT || expectedCash < MIN_SIGNED_BIGINT) {
    return { ok: false, reason: 'AMOUNT_OVERFLOW' };
  }
  const difference = input.countedCash - expectedCash;
  if (difference > MAX_SIGNED_BIGINT || difference < MIN_SIGNED_BIGINT) {
    return { ok: false, reason: 'AMOUNT_OVERFLOW' };
  }
  return { ok: true, expectedCash, difference };
}

// CASH-1: every reconciliation refusal is a fixed, detail-free 409 — the
// movement/payment specifics are never exposed through the API.
function reconciliationRefusal(reason: Extract<CashReconciliation, { ok: false }>['reason']) {
  if (reason === 'PAYMENT_MOVEMENT_MISMATCH') {
    return new AppError(409, 'CASH_PAYMENTS_INCONSISTENT', 'Los pagos en efectivo no coinciden con los movimientos de la sesión.');
  }
  if (reason === 'AMOUNT_OVERFLOW') {
    return new AppError(409, 'CASH_AMOUNT_OVERFLOW', 'El importe de caja excede el límite permitido.');
  }
  return new AppError(409, 'CASH_RECONCILIATION_INCONSISTENT', 'Los movimientos de la sesión no permiten conciliar el cierre.');
}

export function createCashService(database: PrismaClient) {
  // Task 1D.5.3's firm decision: GET register/current keep coarse branch
  // membership only — no CASH_VIEW permission exists in the Production
  // catalog, and none is introduced. Routed through the centralized
  // hasBranchAccess policy (not a bespoke inline array check) so OWNER's
  // implicit authority and a COMPANY assignment are honored here too.
  async function getRegister(branchId: string, ctx: Express.AuthContext) {
    if (!hasBranchAccess(ctx, branchId)) throw forbidden();
    // Demo V2 seeds one register per branch; ordering keeps discovery deterministic.
    const register = await database.cashRegister.findFirst({ where: { branchId }, orderBy: { id: 'asc' } });
    if (!register) throw new AppError(404, 'NOT_FOUND', 'No se encontró la caja.');
    return register;
  }

  async function transact<T>(opening: boolean, operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await database.$transaction(operation, { isolationLevel: 'Serializable', timeout: 30000 });
      } catch (error) {
        const candidate = error as { code?: string; meta?: { code?: string } };
        if (opening && candidate?.code === 'P2002') throw conflict(true);
        const message = error instanceof Error ? error.message : '';
        const transient = candidate?.code === 'P2034' || candidate?.meta?.code === '40001'
          || candidate?.meta?.code === '40P01' || message.includes('40001') || message.includes('TransactionWriteConflict');
        if (!transient) throw error;
        if (attempt === 2) throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
      }
    }
    throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
  }

  return {
    getRegister,
    async getCurrentSession(branchId: string, ctx: Express.AuthContext) {
      const register = await getRegister(branchId, ctx);
      const session = await database.cashSession.findFirst({ where: { registerId: register.id, status: 'OPEN' } });
      return session ? summary(session, branchId) : null;
    },
    // Phase 1D.3.3 SWITCH: the real decision is the Production
    // CASH_SESSION_OPEN grant paired with this register's own persisted
    // branchId (ctx.assignments) — matches the route's own
    // requirePermission(CASH_SESSION_OPEN) gate.
    async openSession(registerId: string, ctx: Express.AuthContext, startingCash: bigint) {
      return transact(true, async (tx) => {
        const [register] = await tx.$queryRaw<{ id: string; branchId: string }[]>`
          SELECT id, "branchId" FROM "CashRegister" WHERE id = ${registerId} FOR UPDATE
        `;
        if (!register) throw new AppError(404, 'NOT_FOUND', 'No se encontró la caja.');
        if (!hasPermissionAtLocation(ctx, PRODUCTION_PERMISSIONS.CASH_SESSION_OPEN, register.branchId)) throw forbidden();
        if (await tx.cashSession.findFirst({ where: { registerId, status: 'OPEN' } })) throw conflict(true);
        const userId = ctx.userId;
        const session = await tx.cashSession.create({ data: { registerId, openedById: userId, startingCash, status: 'OPEN' } });
        await tx.cashMovement.create({ data: { sessionId: session.id, type: 'OPENING', amount: startingCash, salePaymentId: null, userId } });
        await createAuditLog(tx, {
          userId, branchId: register.branchId, action: 'CASH_SESSION_OPENED', entityType: 'CashSession', entityId: session.id,
          after: summary(session, register.branchId),
        });
        return summary(session, register.branchId);
      });
    },
    // Phase 1D.3.3 SWITCH: the real decision is the Production
    // CASH_SESSION_CLOSE grant paired with this session's register's own
    // persisted branchId (ctx.assignments) — matches the route's own
    // requirePermission(CASH_SESSION_CLOSE) gate.
    async closeSession(sessionId: string, ctx: Express.AuthContext, closingCash: bigint) {
      return transact(false, async (tx) => {
        const [locked] = await tx.$queryRaw<CashSession[]>`
          SELECT * FROM "CashSession" WHERE id = ${sessionId} FOR UPDATE
        `;
        if (!locked) throw new AppError(404, 'NOT_FOUND', 'No se encontró la sesión.');
        const register = await tx.cashRegister.findUniqueOrThrow({ where: { id: locked.registerId } });
        if (!hasPermissionAtLocation(ctx, PRODUCTION_PERMISSIONS.CASH_SESSION_CLOSE, register.branchId)) throw forbidden();
        if (locked.status !== 'OPEN') throw conflict(false);
        // CASH-1: reconcile before any write. expectedCash comes from the
        // session's own movements (locked row: startingCash), and the CASH
        // payments bound to this session are cross-checked 1:1 against the
        // SALE_INCOME movements, net of change. Both the movements and the
        // payments are read inside this transaction, under the session row
        // lock the cash charge also takes (payments.service.ts), so no income
        // can commit between the lock and this snapshot.
        const movements = await tx.cashMovement.findMany({
          where: { sessionId },
          select: { type: true, amount: true, salePaymentId: true },
        });
        const cashPayments = await tx.salePayment.findMany({
          where: { cashSessionId: sessionId, method: 'CASH' },
          select: { id: true, amount: true },
        });
        const reconciled = reconcileCashSession({
          startingCash: locked.startingCash,
          movements,
          cashPayments,
          countedCash: closingCash,
        });
        if (!reconciled.ok) throw reconciliationRefusal(reconciled.reason);
        const userId = ctx.userId;
        await tx.cashMovement.create({ data: { sessionId, type: 'CLOSING', amount: closingCash, salePaymentId: null, userId } });
        const session = await tx.cashSession.update({ where: { id: sessionId }, data: {
          status: 'CLOSED', closedById: userId, closedAt: new Date(),
          expectedCash: reconciled.expectedCash, countedCash: closingCash, difference: reconciled.difference,
        } });
        await createAuditLog(tx, {
          userId, branchId: register.branchId, action: 'CASH_SESSION_CLOSED', entityType: 'CashSession', entityId: sessionId,
          before: { status: 'OPEN' },
          after: { ...summary(session, register.branchId), closingCash },
        });
        return { ...summary(session, register.branchId), closingCash };
      });
    },
    // CASH-1: close history for the register of one authorized location. The
    // decision is the Production CASH_SESSION_CLOSE grant paired with this
    // register's own persisted branchId — matching the history route's own
    // requirePermission(CASH_SESSION_CLOSE) gate. Pre-CASH-1 closes keep the
    // reconciliation fields NULL and are never presented as reconciled.
    async listSessions(branchId: string, ctx: Express.AuthContext) {
      const register = await getRegister(branchId, ctx);
      if (!hasPermissionAtLocation(ctx, PRODUCTION_PERMISSIONS.CASH_SESSION_CLOSE, register.branchId)) throw forbidden();
      const sessions = await database.cashSession.findMany({
        where: { registerId: register.id, status: 'CLOSED' },
        orderBy: [{ closedAt: 'desc' }, { openedAt: 'desc' }],
        take: 10,
      });
      return sessions.map((session) => summary(session, branchId));
    },
  };
}
