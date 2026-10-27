import type { CashSession, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { hasBranchAccess, hasPermissionAtLocation, actsAsSupervisorAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { uniqueViolation, uniqueViolationText } from '../payments/prisma-unique-violation.js';

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

// `id` and `reversesMovementId` are needed only to pair a reversal with its
// original (migration 11); a movement without them can never be paired.
export type CashReconciliationMovement = {
  type: string; amount: bigint; salePaymentId: string | null; id?: string; reversesMovementId?: string | null;
  // Sale void v1 (SALE_REFUND only): the CASH payment the refund returns.
  refundOfSalePaymentId?: string | null;
};
export type CashReconciliationPayment = { id: string; amount: bigint };

export type CashReconciliationReason =
  | 'MISSING_OPENING'
  | 'DUPLICATE_OPENING'
  | 'OPENING_AMOUNT_MISMATCH'
  | 'MOVEMENT_TYPE_NOT_ALLOWED'
  | 'PAYMENT_MOVEMENT_MISMATCH'
  | 'REVERSAL_MISMATCH'
  | 'AMOUNT_OVERFLOW';

export type CashReconciliation =
  | { ok: true; expectedCash: bigint; difference: bigint }
  | { ok: false; reason: CashReconciliationReason };

export type CashProjection =
  | { ok: true; projectedExpectedCash: bigint }
  | { ok: false; reason: CashReconciliationReason };

// PILOT reversal (migration 11): the type each reversal type compensates.
const REVERSED_TYPE: Readonly<Record<string, string>> = Object.freeze({
  WITHDRAWAL_REVERSAL: 'WITHDRAWAL',
  EXPENSE_REVERSAL: 'EXPENSE',
});
const isReversalType = (type: string) => Object.hasOwn(REVERSED_TYPE, type);

// Sale void v1: a SALE_REFUND is the append-only cash returned to the customer by the void of a
// CASH sale. Its shape is validated here, row by row (the exits convention): it must name the
// payment it returns, must not carry a salePaymentId (that unique column belongs to the payment's
// SALE_INCOME), must be a positive amount and may not repeat another refund's payment. The
// correspondence with the original payment's exact CASH amount spans sessions (the refund may sit
// in a LATER session than the income), so it is the void service's guarantee, not this pure
// function's. `seen` carries the payment ids already refunded in this movement set.
function refundFault(movement: CashReconciliationMovement, seen: Set<string>): CashReconciliationReason | null {
  const link = movement.refundOfSalePaymentId ?? null;
  if (movement.salePaymentId !== null || link === null) return 'PAYMENT_MOVEMENT_MISMATCH';
  if (movement.amount <= 0n) return 'AMOUNT_OVERFLOW';
  if (seen.has(link)) return 'PAYMENT_MOVEMENT_MISMATCH';
  seen.add(link);
  return null;
}

// PILOT reversal: true when any reversal of the session does not compensate
// exactly one corresponding original of the SAME session movement set. Each
// reversal must carry a link, no payment, a positive amount, and point at an
// original present in `movements` whose type corresponds (WITHDRAWAL <->
// WITHDRAWAL_REVERSAL, EXPENSE <-> EXPENSE_REVERSAL — so a reversal of a
// reversal never pairs) and whose amount is identical; an original is reversed
// at most once. A link on any non-reversal type is corrupt as well.
function hasReversalMismatch(movements: CashReconciliationMovement[]): boolean {
  const byId = new Map<string, CashReconciliationMovement>();
  for (const movement of movements) if (movement.id !== undefined) byId.set(movement.id, movement);
  const reversed = new Set<string>();
  for (const movement of movements) {
    const link = movement.reversesMovementId ?? null;
    if (!isReversalType(movement.type)) {
      if (link !== null) return true;
      continue;
    }
    if (link === null || movement.salePaymentId !== null || movement.amount <= 0n || reversed.has(link)) return true;
    const original = byId.get(link);
    if (!original || original.type !== REVERSED_TYPE[movement.type] || original.amount !== movement.amount) return true;
    reversed.add(link);
  }
  return false;
}

// CASH-1: the pure, database-free reconciliation of one cash session.
//
// expectedCash = startingCash + the net SALE_INCOME movements − the net manual
//   cash exits (WITHDRAWAL, EXPENSE) + their reversals (WITHDRAWAL_REVERSAL,
//   EXPENSE_REVERSAL, migration 11):
//   - the OPENING row must exist exactly once and match startingCash — it is
//     consumed as the base, never summed again (no duplicated opening);
//   - a CLOSING row is not income and is deliberately excluded;
//   - MANUAL or any unknown movement type makes the session non-reconcilable
//     (fail closed);
//   - every SALE_INCOME movement must map 1:1, by salePaymentId and by NET
//     amount, to a CASH payment bound to this session — the change (vuelto)
//     returns to the customer, so the drawer keeps `amount`, never
//     `receivedAmount`;
//   - a WITHDRAWAL/EXPENSE movement must never carry a salePaymentId (a linked
//     exit would double-count a payment) and must be a positive amount;
//   - every reversal must compensate exactly one corresponding original of
//     this session, for its exact amount (hasReversalMismatch), else
//     REVERSAL_MISMATCH;
//   - every accumulation is bounds-checked against signed BIGINT, and the
//     result never depends on the order of the movements.
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
  if (hasReversalMismatch(input.movements)) return { ok: false, reason: 'REVERSAL_MISMATCH' };

  let income = 0n;
  let outgoing = 0n;
  let restored = 0n;
  let refunded = 0n;
  const refundedPayments = new Set<string>();
  const movementByPaymentId = new Map<string, bigint>();
  for (const movement of input.movements) {
    if (movement.type === 'OPENING' || movement.type === 'CLOSING') continue;
    if (movement.type === 'SALE_REFUND') {
      const fault = refundFault(movement, refundedPayments);
      if (fault) return { ok: false, reason: fault };
      refunded += movement.amount;
      if (refunded > MAX_SIGNED_BIGINT) return { ok: false, reason: 'AMOUNT_OVERFLOW' };
      continue;
    }
    if (isReversalType(movement.type)) {
      // Validated by hasReversalMismatch: a positive amount equal to a
      // corresponding exit of this session, which it gives back to the drawer.
      restored += movement.amount;
      if (restored > MAX_SIGNED_BIGINT) return { ok: false, reason: 'AMOUNT_OVERFLOW' };
      continue;
    }
    if (movement.type === 'WITHDRAWAL' || movement.type === 'EXPENSE') {
      // PILOT cash exit: subtracts from the drawer. A non-positive amount or a
      // payment link on an exit is corrupt (both are refused by the DB CHECK)
      // and fails closed.
      if (movement.salePaymentId !== null) return { ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' };
      if (movement.amount <= 0n) return { ok: false, reason: 'AMOUNT_OVERFLOW' };
      outgoing += movement.amount;
      if (outgoing > MAX_SIGNED_BIGINT) return { ok: false, reason: 'AMOUNT_OVERFLOW' };
      continue;
    }
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

  const expectedCash = input.startingCash + income - outgoing + restored - refunded;
  if (expectedCash > MAX_SIGNED_BIGINT || expectedCash < MIN_SIGNED_BIGINT) {
    return { ok: false, reason: 'AMOUNT_OVERFLOW' };
  }
  const difference = input.countedCash - expectedCash;
  if (difference > MAX_SIGNED_BIGINT || difference < MIN_SIGNED_BIGINT) {
    return { ok: false, reason: 'AMOUNT_OVERFLOW' };
  }
  return { ok: true, expectedCash, difference };
}

// PILOT cash exits: the projected drawer of an OPEN session, before its close.
// It is the same arithmetic the reconciliation performs, WITHOUT the CASH
// payment 1:1 cross-check (the projection must be cheap and is only a floor for
// a new exit). It refuses, fail-closed, exactly like the reconciliation:
// expectedCash is the session's OPENING base; a MANUAL/unknown movement, a
// payment link on an exit, a non-positive exit amount, a reversal that does not
// compensate exactly one corresponding original (REVERSAL_MISMATCH) and any
// BIGINT overflow all refuse. Income, exits and reversals are summed apart, so
// the result never depends on the order of the movements. This never mutates
// CashSession.expectedCash — that stays materialized only at close.
export function projectExpectedCash(input: {
  startingCash: bigint;
  movements: CashReconciliationMovement[];
}): CashProjection {
  const openings = input.movements.filter((movement) => movement.type === 'OPENING');
  if (openings.length === 0) return { ok: false, reason: 'MISSING_OPENING' };
  if (openings.length > 1) return { ok: false, reason: 'DUPLICATE_OPENING' };
  if (openings[0]!.amount !== input.startingCash) return { ok: false, reason: 'OPENING_AMOUNT_MISMATCH' };
  if (hasReversalMismatch(input.movements)) return { ok: false, reason: 'REVERSAL_MISMATCH' };

  let income = 0n;
  let outgoing = 0n;
  let restored = 0n;
  let refunded = 0n;
  const refundedPayments = new Set<string>();
  for (const movement of input.movements) {
    if (movement.type === 'OPENING' || movement.type === 'CLOSING') continue;
    if (movement.type === 'SALE_REFUND') {
      const fault = refundFault(movement, refundedPayments);
      if (fault) return { ok: false, reason: fault };
      refunded += movement.amount;
    } else if (movement.type === 'SALE_INCOME') {
      if (movement.salePaymentId === null) return { ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' };
      income += movement.amount;
    } else if (movement.type === 'WITHDRAWAL' || movement.type === 'EXPENSE') {
      if (movement.salePaymentId !== null) return { ok: false, reason: 'PAYMENT_MOVEMENT_MISMATCH' };
      if (movement.amount <= 0n) return { ok: false, reason: 'AMOUNT_OVERFLOW' };
      outgoing += movement.amount;
    } else if (isReversalType(movement.type)) {
      restored += movement.amount;
    } else {
      return { ok: false, reason: 'MOVEMENT_TYPE_NOT_ALLOWED' };
    }
    if (income > MAX_SIGNED_BIGINT || income < MIN_SIGNED_BIGINT || outgoing > MAX_SIGNED_BIGINT || restored > MAX_SIGNED_BIGINT
      || refunded > MAX_SIGNED_BIGINT) {
      return { ok: false, reason: 'AMOUNT_OVERFLOW' };
    }
  }
  const projected = input.startingCash + income - outgoing + restored - refunded;
  if (projected > MAX_SIGNED_BIGINT || projected < MIN_SIGNED_BIGINT) return { ok: false, reason: 'AMOUNT_OVERFLOW' };
  return { ok: true, projectedExpectedCash: projected };
}

// CASH-1: every reconciliation refusal is a fixed, detail-free 409 — the
// movement/payment specifics are never exposed through the API.
export function reconciliationRefusal(reason: CashReconciliationReason) {
  if (reason === 'PAYMENT_MOVEMENT_MISMATCH') {
    return new AppError(409, 'CASH_PAYMENTS_INCONSISTENT', 'Los pagos en efectivo no coinciden con los movimientos de la sesión.');
  }
  if (reason === 'AMOUNT_OVERFLOW') {
    return new AppError(409, 'CASH_AMOUNT_OVERFLOW', 'El importe de caja excede el límite permitido.');
  }
  return new AppError(409, 'CASH_RECONCILIATION_INCONSISTENT', 'Los movimientos de la sesión no permiten conciliar el cierre.');
}

export type CashMovementKind = 'WITHDRAWAL' | 'EXPENSE';

type CashMovementView = {
  id: string; sessionId: string; type: string; amount: bigint; salePaymentId: string | null;
  userId: string; reason: string | null; idempotencyKey: string | null; reversesMovementId: string | null; timestamp: Date;
};
const movementView = (movement: CashMovementView) => ({
  id: movement.id, sessionId: movement.sessionId, type: movement.type, amount: movement.amount,
  salePaymentId: movement.salePaymentId, userId: movement.userId, reason: movement.reason,
  idempotencyKey: movement.idempotencyKey, reversesMovementId: movement.reversesMovementId, timestamp: movement.timestamp,
});

// PILOT reversal (migration 11): the only reversible types, and what each becomes.
const REVERSAL_OF: Readonly<Record<string, 'WITHDRAWAL_REVERSAL' | 'EXPENSE_REVERSAL'>> = Object.freeze({
  WITHDRAWAL: 'WITHDRAWAL_REVERSAL',
  EXPENSE: 'EXPENSE_REVERSAL',
});
const REVERSAL_ACTION = Object.freeze({
  WITHDRAWAL_REVERSAL: 'CASH_WITHDRAWAL_REVERSED',
  EXPENSE_REVERSAL: 'CASH_EXPENSE_REVERSED',
});
const idempotencyReused = () => new AppError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'La clave de idempotencia ya fue utilizada con otro movimiento.');
// Every movement read the reconciliation/projection needs, reversal pairing included.
const RECONCILIATION_SELECT = {
  id: true, type: true, amount: true, salePaymentId: true, reversesMovementId: true, refundOfSalePaymentId: true,
} as const;

// PILOT reversal: a P2002 of one of the two CashMovement unique indexes a
// reversal can lose a race on — the one-reversal-per-original index or the
// (sessionId, idempotencyKey) index — named by constraint or by column list
// (prisma-unique-violation.ts, R-1/R-2). Anything else is not ours.
function isReversalRace(error: unknown): boolean {
  const violation = uniqueViolation(error);
  if (violation === null || violation.modelName !== 'CashMovement') return false;
  if (violation.fields !== null) {
    const fields = [...violation.fields].sort().join(',');
    return fields === 'reversesMovementId' || fields === 'idempotencyKey,sessionId';
  }
  const text = uniqueViolationText(violation);
  return text === 'cashmovement_reversesmovementid_key' || text === 'cashmovement_sessionid_idempotencykey_key';
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
          select: RECONCILIATION_SELECT,
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
    // PILOT cash exits (WITHDRAWAL/EXPENSE, migration 10). One Serializable
    // transaction, in this exact order:
    //   1. lock the CashSession row (FOR UPDATE) — the same lock the close and
    //      the CASH charge take; the lock order stays CashSession-only and can
    //      never reverse the payment path's Sale -> CashSession order;
    //   2. resolve the register and its persisted branchId;
    //   3. RBAC at that branch, plus the supervisor rule for a WITHDRAWAL;
    //   4. idempotent replay: an existing (sessionId, idempotencyKey) returns
    //      the original movement without requiring the session to be OPEN and
    //      without writing a second movement or audit (a lost HTTP response can
    //      be retried even after the session closed); a different payload is a
    //      409;
    //   5. only a NEW key requires the session to be OPEN;
    //   6. the projected drawer (startingCash + SALE_INCOME − exits);
    //   7. the exit may never exceed it;
    //   8. the movement;
    //   9. its audit, in the same transaction (an audit failure rolls back).
    async registerMovement(
      kind: CashMovementKind,
      sessionId: string,
      ctx: Express.AuthContext,
      input: { amount: bigint; reason: string; idempotencyKey: string },
    ) {
      const reason = input.reason.trim();
      if (input.amount <= 0n || input.amount > MAX_SIGNED_BIGINT) {
        throw new AppError(400, 'VALIDATION_ERROR', 'El importe debe ser un entero positivo.');
      }
      if (reason.length === 0 || reason.length > 200) {
        throw new AppError(400, 'VALIDATION_ERROR', 'El motivo es obligatorio.');
      }
      if (input.idempotencyKey.length === 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Falta la clave de idempotencia.');
      }
      const action = kind === 'WITHDRAWAL' ? 'CASH_WITHDRAWAL_REGISTERED' : 'CASH_EXPENSE_REGISTERED';

      return transact(false, async (tx) => {
        const [locked] = await tx.$queryRaw<CashSession[]>`
          SELECT * FROM "CashSession" WHERE id = ${sessionId} FOR UPDATE
        `;
        if (!locked) throw new AppError(404, 'NOT_FOUND', 'No se encontró la sesión.');
        const register = await tx.cashRegister.findUniqueOrThrow({ where: { id: locked.registerId } });
        if (kind === 'WITHDRAWAL') {
          // OWNER, or a COMPANY-scoped ADMIN holding CASH_MOVEMENT_MANAGE. A
          // LOCATION cashier never qualifies, whatever permission it holds.
          if (!actsAsSupervisorAtLocation(ctx, [PRODUCTION_PERMISSIONS.CASH_MOVEMENT_MANAGE], register.branchId)) throw forbidden();
        } else if (!hasPermissionAtLocation(ctx, PRODUCTION_PERMISSIONS.CASH_MOVEMENT_MANAGE, register.branchId)) {
          throw forbidden();
        }

        const existing = await tx.cashMovement.findUnique({
          where: { sessionId_idempotencyKey: { sessionId, idempotencyKey: input.idempotencyKey } },
        });
        if (existing) {
          const sameIntent = existing.type === kind && existing.amount === input.amount && existing.reason === reason;
          if (!sameIntent) throw idempotencyReused();
          return { movement: movementView(existing), replayed: true };
        }

        // Only a NEW operation requires the session to still be OPEN. The only
        // non-OPEN status is CLOSED, so the existing CASH_SESSION_ALREADY_CLOSED
        // conflict is reused verbatim — no alias is introduced.
        if (locked.status !== 'OPEN') throw conflict(false);

        const movements = await tx.cashMovement.findMany({
          where: { sessionId },
          select: RECONCILIATION_SELECT,
        });
        const projected = projectExpectedCash({ startingCash: locked.startingCash, movements });
        if (!projected.ok) throw reconciliationRefusal(projected.reason);
        if (input.amount > projected.projectedExpectedCash) {
          throw new AppError(409, 'INSUFFICIENT_CASH_IN_DRAWER', 'El importe supera el efectivo disponible en caja.');
        }

        const userId = ctx.userId;
        const movement = await tx.cashMovement.create({ data: {
          sessionId, type: kind, amount: input.amount, salePaymentId: null, userId, reason,
          idempotencyKey: input.idempotencyKey,
        } });
        await createAuditLog(tx, {
          userId, branchId: register.branchId, action, entityType: 'CashMovement', entityId: movement.id,
          before: null,
          after: {
            sessionId, type: kind, amount: input.amount, reason,
            idempotencyKey: input.idempotencyKey, projectedExpectedCash: projected.projectedExpectedCash,
          },
        });
        return { movement: movementView(movement), replayed: false };
      });
    },
    // PILOT reversal (migration 11): corrects a mistaken WITHDRAWAL / EXPENSE
    // with an append-only compensating movement of the SAME session; the
    // original row is never updated or deleted. One Serializable transaction
    // (the cash pattern: 30 s, three attempts on 40001/40P01), in this order:
    //   1. lock the CashSession row (FOR UPDATE) — the same lock the exits, the
    //      close and the CASH charge take; no Sale lock, no new lock order;
    //   2. resolve the register and its persisted branchId;
    //   3. supervisor only: OWNER, or a COMPANY-scoped ADMIN holding
    //      CASH_MOVEMENT_MANAGE (actsAsSupervisorAtLocation) — never a cashier;
    //   4. idempotent replay: an existing (sessionId, idempotencyKey) that is a
    //      reversal of THIS original with the same reason returns it, even if
    //      the session has closed since, with no second movement or audit; any
    //      other row under that key is a 409;
    //   5. only a NEW reversal requires the session to be OPEN;
    //   6. the original, read within this session only (another session's
    //      movement is not found; the composite FK makes it impossible anyway);
    //   7. only a WITHDRAWAL or an EXPENSE is reversible;
    //   8. at most one reversal per original (the UNIQUE index is the backstop);
    //   9. the projected drawer must still reconcile (fail-closed);
    //  10. the reversal: type mapped from the original, amount = the original's
    //      amount (never the caller's);
    //  11. its audit, in the same transaction (an audit failure rolls back).
    // A P2002 of either unique index means a concurrent winner committed after
    // this transaction's snapshot: ONE fresh transaction re-reads it and answers
    // a replay or the deterministic 409. Any other error is rethrown.
    async reverseMovement(
      sessionId: string,
      movementId: string,
      ctx: Express.AuthContext,
      input: { reason: string; idempotencyKey: string },
    ) {
      const reason = input.reason.trim();
      if (reason.length === 0 || reason.length > 200) {
        throw new AppError(400, 'VALIDATION_ERROR', 'El motivo es obligatorio.');
      }
      if (input.idempotencyKey.length === 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Falta la clave de idempotencia.');
      }
      const idempotencyKey = input.idempotencyKey;

      const attempt = () => transact(false, async (tx) => {
        const [locked] = await tx.$queryRaw<CashSession[]>`
          SELECT * FROM "CashSession" WHERE id = ${sessionId} FOR UPDATE
        `;
        if (!locked) throw new AppError(404, 'NOT_FOUND', 'No se encontró la sesión.');
        const register = await tx.cashRegister.findUniqueOrThrow({ where: { id: locked.registerId } });
        if (!actsAsSupervisorAtLocation(ctx, [PRODUCTION_PERMISSIONS.CASH_MOVEMENT_MANAGE], register.branchId)) throw forbidden();

        const findOriginal = () => tx.cashMovement.findFirst({ where: { id: movementId, sessionId } });
        const existing = await tx.cashMovement.findUnique({
          where: { sessionId_idempotencyKey: { sessionId, idempotencyKey } },
        });
        if (existing) {
          const sameIntent = isReversalType(existing.type) && existing.reversesMovementId === movementId && existing.reason === reason;
          if (!sameIntent) throw idempotencyReused();
          const original = await findOriginal();
          if (!original) throw new AppError(404, 'NOT_FOUND', 'No se encontró el movimiento.');
          return { movement: movementView(existing), original: movementView(original), replayed: true };
        }

        if (locked.status !== 'OPEN') throw conflict(false);

        const original = await findOriginal();
        if (!original) throw new AppError(404, 'NOT_FOUND', 'No se encontró el movimiento.');
        const type = REVERSAL_OF[original.type];
        if (type === undefined) {
          throw new AppError(409, 'CASH_MOVEMENT_NOT_REVERSIBLE', 'Sólo un retiro o un gasto puede corregirse.');
        }
        if (await tx.cashMovement.findUnique({ where: { reversesMovementId: original.id } })) {
          throw new AppError(409, 'CASH_MOVEMENT_ALREADY_REVERSED', 'El movimiento ya fue corregido.');
        }

        const movements = await tx.cashMovement.findMany({ where: { sessionId }, select: RECONCILIATION_SELECT });
        const projected = projectExpectedCash({ startingCash: locked.startingCash, movements });
        if (!projected.ok) throw reconciliationRefusal(projected.reason);
        const projectedAfter = projected.projectedExpectedCash + original.amount;
        if (projectedAfter > MAX_SIGNED_BIGINT) throw reconciliationRefusal('AMOUNT_OVERFLOW');

        const userId = ctx.userId;
        const movement = await tx.cashMovement.create({ data: {
          sessionId, type, amount: original.amount, salePaymentId: null, userId, reason, idempotencyKey,
          reversesMovementId: original.id,
        } });
        await createAuditLog(tx, {
          userId, branchId: register.branchId, action: REVERSAL_ACTION[type], entityType: 'CashMovement', entityId: movement.id,
          before: {
            id: original.id, type: original.type, amount: original.amount, reason: original.reason,
            userId: original.userId, timestamp: original.timestamp,
          },
          after: {
            reversalMovementId: movement.id, originalMovementId: original.id, sessionId, type, amount: original.amount,
            reason, idempotencyKey, projectedExpectedCashBefore: projected.projectedExpectedCash, projectedExpectedCashAfter: projectedAfter,
          },
        });
        return { movement: movementView(movement), original: movementView(original), replayed: false };
      });

      try {
        return await attempt();
      } catch (error) {
        if (!isReversalRace(error)) throw error;
        return attempt();
      }
    },
    // PILOT cash exits: the movement history of one session, location-authorized
    // through the register's own persisted branchId. Reads only — no lock.
    async listMovements(sessionId: string, ctx: Express.AuthContext) {
      const session = await database.cashSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new AppError(404, 'NOT_FOUND', 'No se encontró la sesión.');
      const register = await database.cashRegister.findUniqueOrThrow({ where: { id: session.registerId } });
      if (!hasPermissionAtLocation(ctx, PRODUCTION_PERMISSIONS.CASH_MOVEMENT_MANAGE, register.branchId)) throw forbidden();
      const movements = await database.cashMovement.findMany({
        where: { sessionId },
        orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
      });
      return movements.map((movement) => movementView(movement));
    },
  };
}
