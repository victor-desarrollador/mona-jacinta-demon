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
        const userId = ctx.userId;
        await tx.cashMovement.create({ data: { sessionId, type: 'CLOSING', amount: closingCash, salePaymentId: null, userId } });
        const session = await tx.cashSession.update({ where: { id: sessionId }, data: { status: 'CLOSED', closedById: userId, closedAt: new Date() } });
        await createAuditLog(tx, {
          userId, branchId: register.branchId, action: 'CASH_SESSION_CLOSED', entityType: 'CashSession', entityId: sessionId,
          before: { status: 'OPEN' },
          after: { ...summary(session, register.branchId), closingCash },
        });
        return { ...summary(session, register.branchId), closingCash };
      });
    },
  };
}
