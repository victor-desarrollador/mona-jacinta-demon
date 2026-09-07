import type { CashSession, Prisma, PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { toJsonSafe } from '../../shared/json-safe.js';

const conflict = (opening: boolean) => new AppError(409,
  opening ? 'CASH_SESSION_ALREADY_OPEN' : 'CASH_SESSION_ALREADY_CLOSED',
  opening ? 'La caja ya tiene una sesión abierta.' : 'La sesión ya está cerrada.');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
const summary = (session: CashSession, branchId: string) => {
  const { id, ...fields } = session;
  return { sessionId: id, ...fields, branchId };
};

export function createCashService(database: PrismaClient) {
  async function getRegister(branchId: string, branchIds: string[]) {
    if (!branchIds.includes(branchId)) throw forbidden();
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

  async function assertCurrentBranch(tx: Prisma.TransactionClient, userId: string, branchId: string, branchIds: string[]) {
    if (!branchIds.includes(branchId) || !await tx.userBranchRole.findFirst({ where: { userId, branchId }, select: { id: true } })) throw forbidden();
  }

  return {
    getRegister,
    async getCurrentSession(branchId: string, branchIds: string[]) {
      const register = await getRegister(branchId, branchIds);
      const session = await database.cashSession.findFirst({ where: { registerId: register.id, status: 'OPEN' } });
      return session ? summary(session, branchId) : null;
    },
    async openSession(registerId: string, userId: string, branchIds: string[], startingCash: bigint) {
      return transact(true, async (tx) => {
        const [register] = await tx.$queryRaw<{ id: string; branchId: string }[]>`
          SELECT id, "branchId" FROM "CashRegister" WHERE id = ${registerId} FOR UPDATE
        `;
        if (!register) throw new AppError(404, 'NOT_FOUND', 'No se encontró la caja.');
        await assertCurrentBranch(tx, userId, register.branchId, branchIds);
        if (await tx.cashSession.findFirst({ where: { registerId, status: 'OPEN' } })) throw conflict(true);
        const session = await tx.cashSession.create({ data: { registerId, openedById: userId, startingCash, status: 'OPEN' } });
        await tx.cashMovement.create({ data: { sessionId: session.id, type: 'OPENING', amount: startingCash, salePaymentId: null, userId } });
        await tx.auditLog.create({ data: {
          userId, branchId: register.branchId, action: 'CASH_SESSION_OPENED', entityType: 'CashSession', entityId: session.id,
          after: toJsonSafe(summary(session, register.branchId)) as Prisma.InputJsonValue,
        } });
        return summary(session, register.branchId);
      });
    },
    async closeSession(sessionId: string, userId: string, branchIds: string[], closingCash: bigint) {
      return transact(false, async (tx) => {
        const [locked] = await tx.$queryRaw<CashSession[]>`
          SELECT * FROM "CashSession" WHERE id = ${sessionId} FOR UPDATE
        `;
        if (!locked) throw new AppError(404, 'NOT_FOUND', 'No se encontró la sesión.');
        const register = await tx.cashRegister.findUniqueOrThrow({ where: { id: locked.registerId } });
        await assertCurrentBranch(tx, userId, register.branchId, branchIds);
        if (locked.status !== 'OPEN') throw conflict(false);
        await tx.cashMovement.create({ data: { sessionId, type: 'CLOSING', amount: closingCash, salePaymentId: null, userId } });
        const session = await tx.cashSession.update({ where: { id: sessionId }, data: { status: 'CLOSED', closedById: userId, closedAt: new Date() } });
        await tx.auditLog.create({ data: {
          userId, branchId: register.branchId, action: 'CASH_SESSION_CLOSED', entityType: 'CashSession', entityId: sessionId,
          before: { status: 'OPEN' },
          after: toJsonSafe({ ...summary(session, register.branchId), closingCash }) as Prisma.InputJsonValue,
        } });
        return { ...summary(session, register.branchId), closingCash };
      });
    },
  };
}
