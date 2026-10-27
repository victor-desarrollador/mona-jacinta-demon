import { isTransientTransactionError } from '../../shared/transient-transaction-error.js';
import type { Request } from 'express';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { projectExpectedCash, reconciliationRefusal } from '../cash/index.js';
import { PRODUCTION_PERMISSIONS, actsAsSupervisorAtLocation } from '../rbac/index.js';
import { releaseReservations } from './cancellation.service.js';
import { voidSaleDto, type VoidSaleInput } from './dto/void-sale.dto.js';

// Sale void v1: the post-payment void (PAID | COMPLETED -> CANCELLED). NOT the pre-payment cancel
// (cancellation.service.ts), which refuses any sale with a payment.
//
// What it does, all in ONE Serializable transaction:
//   - stock follows the real lifecycle. PAID still HOLDS its stock (ACTIVE StockReservation +
//     Inventory.reserved; physical not consumed): the holds are released, physical is untouched and no
//     StockMovement is written. COMPLETED consumed physical stock (StockMovement SALE): it is returned
//     from those SALE rows as append-only StockMovement SALE_VOID (+delta), reserved untouched, the
//     original SALE rows never touched;
//   - CASH goes back as one append-only CashMovement SALE_REFUND per CASH payment, into an OPEN session
//     of the sale's own branch (never a CLOSED one), never more than the projected drawer;
//   - TRANSFER / CARD_DEBIT / CARD_CREDIT / QR went back outside the POS: the explicit evidence is kept
//     in SaleVoidExternalRefund, one per payment. SalePayment, SALE_INCOME and ExternalCollection are
//     never edited, deleted or auto-marked REFUNDED;
//   - one SaleVoid (UNIQUE(saleId)) is the durable record and the idempotency source; one SALE_VOIDED audit.
//
// Order of decisions (every step before the writes is read-only, so a refusal writes nothing):
//   auth -> input shape -> Sale FOR UPDATE -> supervisor at the sale's persisted branch -> existing SaleVoid
//   (replay / conflict) -> state -> no SaleExchange (SALE_HAS_EXCHANGES) -> payments -> external evidence -> existing refunds -> CashSession FOR UPDATE
//   (only with CASH) -> drawer -> stock (PAID: StockReservation then Inventory; COMPLETED: Inventory) -> writes.
// Lock order: Sale -> CashSession -> StockReservation -> Inventory, a prefix-compatible extension of payments
// (Sale -> CashSession), finalization and cancellation (Sale -> StockReservation -> Inventory) and the
// checkout; the cash close takes the CashSession alone.

const MAX_SIGNED_BIGINT = 9223372036854775807n;
const EXTERNAL_METHODS = ['TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR'] as const;

type LockedSale = { id: string; branchId: string; status: string; total: bigint };
type LockedReservation = { id: string; variantId: string; branchId: string; quantity: bigint; status: string; expiresAt: Date };
type LockedInventory = { id: string; variantId: string; branchId: string; physical: bigint; reserved: bigint };
type LockedSession = { id: string; status: string; startingCash: bigint; registerId: string; branchId: string | null };
type VoidablePreviousStatus = 'PAID' | 'COMPLETED';
type StockReturned = { variantId: string; inventoryId: string; quantity: bigint };
type ReservationReleased = { variantId: string; quantity: bigint };
type CashRefundMovement = { id: string; salePaymentId: string; amount: bigint };
type ExternalRefundView = { salePaymentId: string; method: string; amount: bigint; evidence: string; refundPerformed: true };

export type SaleVoidResult = {
  saleId: string;
  branchId: string;
  voidId: string;
  status: 'CANCELLED';
  previousStatus: VoidablePreviousStatus;
  reason: string;
  replayed: boolean;
  // COMPLETED: the physical units put back (one row per inventory). PAID: always empty.
  stockReturned: StockReturned[];
  // PAID: the ACTIVE holds released. COMPLETED: empty.
  reservationsReleased: ReservationReleased[];
  // null when the sale had no CASH payment.
  cashRefund: null | { cashSessionId: string; total: bigint; movements: CashRefundMovement[] };
  // One entry per external payment, each with its explicit evidence; empty when the sale had none.
  externalRefunds: ExternalRefundView[];
};

const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con permisos para anular esta venta.');
const notFound = (message: string) => new AppError(404, 'NOT_FOUND', message);
const stockInconsistent = (message: string) => new AppError(409, 'SALE_VOID_STOCK_INCONSISTENT', message);
const concurrency = () => new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');

// Shared classifier (src/shared/transient-transaction-error.ts): P2034, SQLSTATE 40001 / 40P01 in every driver shape, TransactionWriteConflict.
const transient = isTransientTransactionError;

const byId = <T extends { id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const toBigInt = (value: unknown) => BigInt(typeof value === 'bigint' ? value : String(value));
const evidenceKey = (refunds: Array<{ salePaymentId: string; evidence: string }>) =>
  refunds.map((refund) => `${refund.salePaymentId}\u0000${refund.evidence}`).sort().join('\u0001');

export function createSaleVoidService(database: PrismaClient) {
  async function inTransaction<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await database.$transaction(operation, { isolationLevel: 'Serializable', timeout: 30000 });
      } catch (error) {
        if (!transient(error)) throw error;
        if (attempt === 2) throw concurrency();
      }
    }
    throw concurrency();
  }

  async function voidSale(req: Pick<Request, 'auth'>, saleId: string, rawInput: unknown): Promise<SaleVoidResult> {
    const auth = req.auth;
    if (!auth) throw new AppError(401, 'UNAUTHORIZED', 'Se requiere autenticación.');
    const parsed = voidSaleDto.safeParse(rawInput);
    if (!parsed.success) throw new AppError(400, 'VALIDATION_ERROR', 'Los datos de la anulación no son válidos.');
    const input = parsed.data;

    return inTransaction(async (tx): Promise<SaleVoidResult> => {
      // 1. The Sale row is the FIRST lock: every writer of this sale's state serializes here.
      const [sale] = await tx.$queryRaw<LockedSale[]>`SELECT id, "branchId", status, total FROM "Sale" WHERE id = ${saleId} FOR UPDATE`;
      if (!sale) throw notFound('No se encontró la venta.');

      // 2. Supervisor (OWNER, or a COMPANY-scoped ADMIN holding SALE_VOID), against the PERSISTED branch.
      if (!actsAsSupervisorAtLocation(auth, [PRODUCTION_PERMISSIONS.SALE_VOID], sale.branchId)) throw forbidden();

      // 3. A void already exists: replay of the same intent, or a conflict. Never touches the session state.
      const existing = await tx.saleVoid.findFirst({ where: { saleId } });
      if (existing) return replay(tx, sale, existing, input);

      // 4. State.
      if (sale.status !== 'PAID' && sale.status !== 'COMPLETED') {
        throw new AppError(409, 'INVALID_SALE_STATE', 'La venta no puede anularse en su estado actual.');
      }
      const previousStatus: VoidablePreviousStatus = sale.status;

      // 4b. A sale that was exchanged cannot be voided: the void rebuilds the stock from the original SALE
      //     movements, which after an exchange would return the original variant a second time and never the
      //     replacement. Read-only, before payments / cash / stock, so a refusal writes nothing. The database
      //     refuses the same thing on a direct SaleVoid insert (sale_void_exchange_guard).
      if (await tx.saleExchange.findFirst({ where: { saleId }, select: { id: true } })) {
        throw new AppError(409, 'SALE_HAS_EXCHANGES', 'La venta tiene cambios registrados y no puede anularse.');
      }

      // 5. Payments, and the evidence the external ones need (pure validation, nothing locked yet).
      const payments = await tx.salePayment.findMany({
        where: { saleId }, select: { id: true, method: true, amount: true }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      });
      const cashPayments = payments.filter((payment) => payment.method === 'CASH');
      const externalPayments = payments.filter((payment) => (EXTERNAL_METHODS as readonly string[]).includes(payment.method));
      const evidenceByPayment = new Map(input.externalRefunds.map((refund) => [refund.salePaymentId, refund.evidence]));
      const externalIds = new Set(externalPayments.map((payment) => payment.id));
      if (input.externalRefunds.some((refund) => !externalIds.has(refund.salePaymentId))) {
        throw new AppError(409, 'EXTERNAL_REFUND_PAYMENT_MISMATCH', 'La evidencia indicada no corresponde a un pago externo de esta venta.');
      }
      if (externalPayments.some((payment) => !evidenceByPayment.has(payment.id))) {
        throw new AppError(409, 'EXTERNAL_REFUND_EVIDENCE_REQUIRED', 'Cada pago externo necesita la evidencia de su reintegro.');
      }

      // 6. CASH: a refund already recorded for one of these payments fails closed; then the OPEN session of the
      //    sale's branch (locked AFTER the Sale) and the drawer it must be able to give back.
      let cashSessionId: string | null = null;
      if (cashPayments.length > 0) {
        if (!input.cashSessionId) {
          throw new AppError(409, 'CASH_SESSION_REQUIRED', 'La venta tiene pagos en efectivo: indicá la sesión de caja abierta que devuelve el dinero.');
        }
        const already = await tx.cashMovement.findMany({
          where: { refundOfSalePaymentId: { in: cashPayments.map((payment) => payment.id) } }, select: { id: true },
        });
        if (already.length > 0) {
          throw new AppError(409, 'SALE_REFUND_ALREADY_RECORDED', 'Ya existe un reintegro en efectivo registrado para esta venta.');
        }
        const [session] = await tx.$queryRaw<LockedSession[]>`
          SELECT cs.id, cs.status, cs."startingCash", cs."registerId", r."branchId"
          FROM "CashSession" cs JOIN "CashRegister" r ON r.id = cs."registerId"
          WHERE cs.id = ${input.cashSessionId}
          FOR UPDATE OF cs
        `;
        if (!session) throw notFound('No se encontró la sesión de caja.');
        if (session.branchId !== sale.branchId) {
          throw new AppError(409, 'CASH_SESSION_BRANCH_MISMATCH', 'La sesión de caja pertenece a otra sucursal.');
        }
        if (session.status !== 'OPEN') throw new AppError(409, 'CASH_SESSION_ALREADY_CLOSED', 'La sesión de caja ya está cerrada.');
        const total = cashPayments.reduce((sum, payment) => sum + payment.amount, 0n);
        if (total > MAX_SIGNED_BIGINT) throw new AppError(409, 'CASH_AMOUNT_OVERFLOW', 'El importe de caja excede el límite permitido.');
        const movements = await tx.cashMovement.findMany({
          where: { sessionId: session.id },
          select: { id: true, type: true, amount: true, salePaymentId: true, reversesMovementId: true, refundOfSalePaymentId: true },
        });
        const projected = projectExpectedCash({ startingCash: session.startingCash, movements });
        if (!projected.ok) throw reconciliationRefusal(projected.reason);
        if (total > projected.projectedExpectedCash) {
          throw new AppError(409, 'INSUFFICIENT_CASH_IN_DRAWER', 'El importe supera el efectivo disponible en caja.');
        }
        cashSessionId = session.id;
      }

      // 7. Stock. PAID: release the ACTIVE holds (StockReservation, then Inventory). COMPLETED: lock the
      //    inventory the SALE movements point at. All checks first; the writes come after the SaleVoid exists.
      let reservationsReleased: ReservationReleased[] = [];
      let toReturn: StockReturned[] = [];
      if (previousStatus === 'COMPLETED') {
        toReturn = await lockStockToReturn(tx, sale);
      } else {
        const reservations = await tx.$queryRaw<LockedReservation[]>`
          SELECT id, "variantId", "branchId", quantity, status, "expiresAt"
          FROM "StockReservation" WHERE "saleId" = ${saleId} AND status = 'ACTIVE' ORDER BY id ASC FOR UPDATE
        `;
        reservationsReleased = await releaseReservations(tx, sale, reservations);
      }

      // 8. Writes.
      const created = await tx.saleVoid.create({
        data: {
          saleId, branchId: sale.branchId, previousStatus, reason: input.reason,
          idempotencyKey: input.idempotencyKey, voidedById: auth.userId,
        },
      });
      for (const line of toReturn) {
        await tx.inventory.update({ where: { id: line.inventoryId }, data: { physical: { increment: line.quantity } } });
        await tx.stockMovement.create({
          data: {
            inventoryId: line.inventoryId, type: 'SALE_VOID', quantityDelta: line.quantity, saleId, saleVoidId: created.id,
            userId: auth.userId, branchId: sale.branchId,
          },
        });
      }
      const cashMovements: CashRefundMovement[] = [];
      for (const payment of cashPayments) {
        const movement = await tx.cashMovement.create({
          data: {
            sessionId: cashSessionId!, type: 'SALE_REFUND', amount: payment.amount, salePaymentId: null,
            refundOfSalePaymentId: payment.id, userId: auth.userId, reason: input.reason,
          },
        });
        cashMovements.push({ id: movement.id, salePaymentId: payment.id, amount: payment.amount });
      }
      const externalRefunds: ExternalRefundView[] = [];
      for (const payment of externalPayments) {
        const evidence = evidenceByPayment.get(payment.id)!;
        await tx.saleVoidExternalRefund.create({
          data: { saleVoidId: created.id, saleId, salePaymentId: payment.id, method: payment.method as never, amount: payment.amount, evidence },
        });
        externalRefunds.push({ salePaymentId: payment.id, method: payment.method, amount: payment.amount, evidence, refundPerformed: true });
      }
      await tx.sale.update({ where: { id: saleId }, data: { status: 'CANCELLED' } });

      const cashRefund = cashSessionId
        ? { cashSessionId, total: cashMovements.reduce((sum, movement) => sum + movement.amount, 0n), movements: cashMovements }
        : null;
      await createAuditLog(tx, {
        userId: auth.userId, branchId: sale.branchId, action: 'SALE_VOIDED', entityType: 'Sale', entityId: saleId,
        before: { status: previousStatus, total: sale.total },
        after: {
          status: 'CANCELLED', previousStatus, voidId: created.id, reason: input.reason, idempotencyKey: input.idempotencyKey,
          stockReturned: toReturn, reservationsReleased,
          payments: payments.map((payment) => ({ id: payment.id, method: payment.method, amount: payment.amount })),
          cashSessionId, cashRefunded: cashRefund?.total ?? 0n, cashRefundMovementIds: cashMovements.map((movement) => movement.id),
          externalRefunds: externalRefunds.map(({ salePaymentId, method, amount, evidence }) => ({ salePaymentId, method, amount, evidence })),
        },
      });
      return {
        saleId, branchId: sale.branchId, voidId: created.id, status: 'CANCELLED', previousStatus, reason: input.reason, replayed: false,
        stockReturned: toReturn, reservationsReleased, cashRefund, externalRefunds,
      };
    });
  }

  // COMPLETED: the SALE StockMovement rows (never the SaleItem rows) prove what left the shelf. The inventory
  // they point at is locked in id order; every row must belong to the sale's branch; the units come back as
  // exactly what went out and may never push physical past the signed BIGINT maximum.
  async function lockStockToReturn(tx: Prisma.TransactionClient, sale: LockedSale): Promise<StockReturned[]> {
    const movements = await tx.stockMovement.findMany({ where: { saleId: sale.id, type: 'SALE' } });
    if (movements.length === 0) throw stockInconsistent('No hay movimientos de venta que permitan devolver el stock.');
    const quantities = new Map<string, bigint>();
    for (const movement of movements) {
      if (movement.quantityDelta >= 0n) throw stockInconsistent('Un movimiento de venta no descuenta stock.');
      if (movement.branchId !== sale.branchId) throw stockInconsistent('Un movimiento de venta pertenece a otra sucursal.');
      quantities.set(movement.inventoryId, (quantities.get(movement.inventoryId) ?? 0n) - movement.quantityDelta);
    }
    const inventoryIds = [...quantities.keys()].sort();
    const locked = await tx.$queryRaw<LockedInventory[]>`
      SELECT id, "variantId", "branchId", physical, reserved
      FROM "Inventory"
      WHERE id IN (${Prisma.join(inventoryIds)})
      ORDER BY id ASC FOR UPDATE
    `;
    if (locked.length !== inventoryIds.length || new Set(locked.map(({ id }) => id)).size !== inventoryIds.length) {
      throw stockInconsistent('No se encontró el inventario de un movimiento de venta.');
    }
    const lockedById = new Map(locked.map((inventory) => [inventory.id, inventory]));
    return inventoryIds.map((inventoryId) => {
      const inventory = lockedById.get(inventoryId);
      const quantity = quantities.get(inventoryId)!;
      if (!inventory || inventory.branchId !== sale.branchId) throw stockInconsistent('Un inventario no pertenece a la sucursal de la venta.');
      if (inventory.physical + quantity > MAX_SIGNED_BIGINT) throw stockInconsistent('La devolución excede el límite del inventario físico.');
      return { variantId: inventory.variantId, inventoryId, quantity };
    });
  }

  // The durable intent of the void that exists, rebuilt from its own rows: reason (SaleVoid), the session the
  // CASH went back through (the SALE_REFUND movements) and the external evidence (SaleVoidExternalRefund). The
  // same intent returns the persisted result; a different key is SALE_ALREADY_VOIDED; the same key with a
  // different intent is IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD. No lock beyond the Sale, no write.
  async function replay(
    tx: Prisma.TransactionClient,
    sale: LockedSale,
    existing: { id: string; previousStatus: string; reason: string; idempotencyKey: string },
    input: VoidSaleInput,
  ): Promise<SaleVoidResult> {
    if (existing.idempotencyKey !== input.idempotencyKey) {
      throw new AppError(409, 'SALE_ALREADY_VOIDED', 'La venta ya fue anulada.');
    }
    const payments = await tx.salePayment.findMany({
      where: { saleId: sale.id }, select: { id: true, method: true, amount: true }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    });
    const cashPayments = payments.filter((payment) => payment.method === 'CASH');
    const refundMovements = cashPayments.length === 0 ? [] : await tx.cashMovement.findMany({
      where: { refundOfSalePaymentId: { in: cashPayments.map((payment) => payment.id) } },
      select: { id: true, sessionId: true, amount: true, refundOfSalePaymentId: true },
    });
    const refundByPayment = new Map(refundMovements.map((movement) => [movement.refundOfSalePaymentId as string, movement]));
    const storedSession = refundMovements[0]?.sessionId ?? null;
    const storedExternal = await tx.saleVoidExternalRefund.findMany({ where: { saleVoidId: existing.id } });

    const requestedSession = cashPayments.length > 0 ? (input.cashSessionId ?? null) : null;
    if (existing.reason !== input.reason || requestedSession !== storedSession || evidenceKey(input.externalRefunds) !== evidenceKey(storedExternal)) {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'La clave de idempotencia ya se usó con otros datos.');
    }

    const stockMovements = await tx.stockMovement.findMany({ where: { saleVoidId: existing.id } });
    const inventories = stockMovements.length === 0 ? [] : await tx.inventory.findMany({ where: { id: { in: stockMovements.map(({ inventoryId }) => inventoryId) } } });
    const variantByInventory = new Map(inventories.map((inventory) => [inventory.id, inventory.variantId]));
    const stockReturned = byId(stockMovements.map((movement) => ({ ...movement, id: movement.inventoryId }))).map((movement) => {
      const variantId = variantByInventory.get(movement.inventoryId);
      if (!variantId) throw stockInconsistent('No se encontró el inventario de un movimiento de anulación.');
      return { variantId, inventoryId: movement.inventoryId, quantity: movement.quantityDelta };
    });

    // The released holds of a PAID void are not a durable table: they come back from the void's own audit record.
    let reservationsReleased: ReservationReleased[] = [];
    if (existing.previousStatus === 'PAID') {
      const audit = await tx.auditLog.findFirst({ where: { entityType: 'Sale', entityId: sale.id, action: 'SALE_VOIDED' } });
      const released = (audit?.after as { reservationsReleased?: Array<{ variantId: string; quantity: unknown }> } | null | undefined)?.reservationsReleased;
      reservationsReleased = (released ?? []).map((line) => ({ variantId: line.variantId, quantity: toBigInt(line.quantity) }));
    }

    const cashMovements = cashPayments.flatMap((payment) => {
      const movement = refundByPayment.get(payment.id);
      return movement ? [{ id: movement.id, salePaymentId: payment.id, amount: movement.amount }] : [];
    });
    const externalByPayment = new Map(storedExternal.map((refund) => [refund.salePaymentId, refund]));
    const externalRefunds: ExternalRefundView[] = payments.flatMap((payment) => {
      const refund = externalByPayment.get(payment.id);
      return refund ? [{ salePaymentId: payment.id, method: refund.method, amount: refund.amount, evidence: refund.evidence, refundPerformed: true as const }] : [];
    });
    return {
      saleId: sale.id, branchId: sale.branchId, voidId: existing.id, status: 'CANCELLED',
      previousStatus: existing.previousStatus as VoidablePreviousStatus, reason: existing.reason, replayed: true,
      stockReturned, reservationsReleased,
      cashRefund: storedSession ? { cashSessionId: storedSession, total: cashMovements.reduce((sum, movement) => sum + movement.amount, 0n), movements: cashMovements } : null,
      externalRefunds,
    };
  }

  return { voidSale };
}

export type SaleVoidService = ReturnType<typeof createSaleVoidService>;
