// R3-A4.3 S7: T-S, the supervised stock recovery of a RESERVED checkout attempt
// (POST /sales/:saleId/checkout/stock-recovery). OWNER decisions S7 §1.
//
// T-S is ONE Serializable transaction (timeout 30 s; up to 3 attempts on a
// transient P2034 / 40001 / 40P01, then 409 CONCURRENCY_ERROR) — it rewrites
// stock, like every other stock writer. Lock order, a subsequence of the global
// order Sale → CheckoutAttempt → ExternalCollection → CashSession →
// StockReservation(id ASC) → Inventory(id ASC), never NOWAIT:
//   1. lock the sale of the URL (404);
//   2. supervisor authority on its persisted branchId
//      (actsAsSupervisorAtLocation [SALE_CORRECT_PENDING, SALE_CHARGE]) —
//      nothing about any attempt is read before this;
//   3. lock the attempt by (reserveKey, saleId): an unknown key and a key of
//      another sale are the same 404, so no key is ever disclosed;
//   4. applicability: PROPORTIONAL_V1, PENDING_PAYMENT, no payment, RESERVED;
//   5. a sealed plan (anything else is a defect);
//   6. the sale's CURRENT lines still reproduce the sealed plan (S7-C), before
//      any stock lock — see assertSealedPlanStillMatchesSale.
// T-S never creates an attempt, charges, confirms, or touches the plan, the
// hashes, the recovery justification, the collection claims or the cash.
//
//   7. StockReservation ACTIVE of the sale (id ASC) → Inventory of V (id ASC):
//      evaluateStockRecovery computes the recovery plan, writing nothing (S7-D).
//
//   8. if the plan changed anything (S7-E): applyStockRecovery (release every
//      own ACTIVE hold → Inventory.reserved = newReserved → one new ACTIVE hold
//      per required variant) → Sale.updatedAt bump (the visibility rule) →
//      AuditLog CHECKOUT_STOCK_RECOVERED, after the last business write;
//   9. the ReservationView, read last with the same `now`.
// An unchanged coverage (changed:false) writes nothing at all: no hold, no
// Inventory, no bump, no audit.
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { holdExpiredByClock, TECHNICAL_HOLD_TTL_MS } from '../sales/reservation-holds.js';
import { loadReservationView, stockStateOf, type ReservationView } from './checkout-attempt-view.js';
import type { CheckoutStockRecoveryRequest } from './dto/checkout-stock-recovery.dto.js';
import { actsAsSupervisorAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { lineFullPrices, type ProportionalLineInput } from '../pricing/proportional-checkout.js';

const STOCK_RECOVERY_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;

type RequestLike = { auth?: Express.AuthContext };
type Tx = Prisma.TransactionClient;

export type StockRecoverySale = {
  id: string; branchId: string; status: string; pricingModel: string; priceMode: string; paymentStartedAt: Date | null;
};
export type StockRecoveryAttempt = {
  id: string; saleId: string; branchId: string; reserveKey: string; operationKey: string;
  status: string; planSealed: boolean;
  fullPriceCash: bigint; fullPriceTransfer: bigint | null; fullPriceDebit: bigint | null;
  transferAdjustmentBps: number | null; debitAdjustmentBps: number | null;
};
export type StockRecoveryTarget = { sale: StockRecoverySale; attempt: StockRecoveryAttempt };

export type StockRecoveryHold = { id: string; variantId: string; branchId: string; quantity: bigint; expiresAt: Date };
// One entry per variant of V = required ∪ own, with the values the apply step
// writes: newReserved = previousReserved − ownReserved + required (all BigInt).
export type StockRecoveryVariant = {
  variantId: string; inventoryId: string; physical: bigint;
  previousReserved: bigint; ownReserved: bigint; required: bigint; newReserved: bigint;
};
export type StockRecoveryEvaluation = {
  changed: boolean;
  now: Date;
  requiredByVariant: Map<string, bigint>;
  ownByVariant: Map<string, bigint>;
  activeReservations: StockRecoveryHold[];
  variants: StockRecoveryVariant[];
};

const saleNotFound = () => new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
const reservationNotFound = () => new AppError(404, 'NOT_FOUND', 'No se encontró la reserva de cobro.');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
const notApplicable = () => new AppError(409, 'STOCK_RECOVERY_NOT_APPLICABLE', 'La reserva de cobro no admite recuperar el stock en su estado actual.');
const inconsistentState = (message: string) => new AppError(500, 'CHECKOUT_STATE_INCONSISTENT', message);
const planInconsistent = (message: string) => new AppError(500, 'CHECKOUT_PLAN_INCONSISTENT', message);
// The existing stock-writer code and message (send-to-cashier, correction).
const insufficientStock = (variantId: string) => new AppError(409, 'INSUFFICIENT_STOCK', 'No hay stock disponible suficiente para la variante.', { variantId });
const concurrencyError = () => new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');

// Same classification as the other checkout transactions (T-R, T-C).
const transient = (error: unknown) => {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034' || candidate.meta?.code === '40001' || candidate.meta?.code === '40P01'
    || message.includes('40001') || message.includes('40P01') || message.includes('TransactionWriteConflict');
};

// One Serializable transaction per attempt; a transient failure re-runs the
// whole unit from the Sale lock, so every retry re-reads the committed state.
export async function inStockRecoveryTransaction<T>(database: PrismaClient, work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attemptNumber = 0; attemptNumber < MAX_ATTEMPTS; attemptNumber += 1) {
    try {
      return await database.$transaction(work, { isolationLevel: 'Serializable', timeout: STOCK_RECOVERY_TIMEOUT_MS });
    } catch (error) {
      if (!transient(error)) throw error;
    }
  }
  throw concurrencyError();
}

// Steps 1–5. Returns the locked sale and attempt; writes nothing.
export async function lockStockRecoveryTarget(
  tx: Tx,
  req: RequestLike,
  saleId: string,
  reserveKey: string,
): Promise<StockRecoveryTarget> {
  const [sale] = await tx.$queryRaw<StockRecoverySale[]>`
    SELECT id, "branchId", status, "pricingModel", "priceMode", "paymentStartedAt"
    FROM "Sale" WHERE id = ${saleId} FOR UPDATE
  `;
  if (!sale) throw saleNotFound();

  if (!req.auth || !actsAsSupervisorAtLocation(
    req.auth,
    [PRODUCTION_PERMISSIONS.SALE_CORRECT_PENDING, PRODUCTION_PERMISSIONS.SALE_CHARGE],
    sale.branchId,
  )) throw forbidden();

  const [attempt] = await tx.$queryRaw<StockRecoveryAttempt[]>`
    SELECT id, "saleId", "branchId", "reserveKey", "operationKey", status, "planSealed",
           "fullPriceCash", "fullPriceTransfer", "fullPriceDebit", "transferAdjustmentBps", "debitAdjustmentBps"
    FROM "CheckoutAttempt"
    WHERE "reserveKey" = ${reserveKey} AND "saleId" = ${saleId}
    FOR UPDATE
  `;
  if (!attempt || attempt.branchId !== sale.branchId) throw reservationNotFound();

  if (sale.pricingModel !== 'PROPORTIONAL_V1' || sale.status !== 'PENDING_PAYMENT') throw notApplicable();
  const payments = await tx.salePayment.count({ where: { saleId } });
  if (payments > 0 || sale.paymentStartedAt !== null) throw notApplicable();
  if (attempt.status !== 'RESERVED') throw notApplicable();

  if (!attempt.planSealed) throw inconsistentState('La reserva de cobro no tiene un plan sellado.');
  await assertSealedPlanStillMatchesSale(tx, sale, attempt);
  return { sale, attempt };
}

// Step 6 (OWNER decision S7-C, option 1): the sale's CURRENT lines must still
// reproduce EVERY sealed full price — cash with 0 bps, and transfer/debit with
// the SEALED basis points — through the engine T-C settles with
// (lineFullPrices, one rounding per unit, BigInt). Never the current pricing
// configuration, and never just expectedTotal. Read-only; any mismatch, any
// unreproducible snapshot and any engine refusal is 500 CHECKOUT_PLAN_INCONSISTENT.
//
// Known S7 limitation: CheckoutAttempt does not seal line identity or
// composition, so a recomposition that preserves every sealed full price is
// invisible here (and to T-C). S8 must prevent sale-line mutation while an
// attempt is open.
async function assertSealedPlanStillMatchesSale(tx: Tx, sale: StockRecoverySale, attempt: StockRecoveryAttempt) {
  if (sale.priceMode !== 'CASH') throw planInconsistent('Una venta proporcional debe estar tasada en efectivo.');

  // The same line read and validation as T-C (never the snapshot loader, whose
  // PRICING_SNAPSHOT_INCONSISTENT belongs to the quote and the reservation).
  const items = await tx.saleItem.findMany({
    where: { saleId: sale.id },
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

  // The pricing snapshot is whole or absent (chk_attempt_pricing_snapshot); a
  // plan with an external tender cannot exist without it.
  const snapshot = [attempt.fullPriceTransfer, attempt.fullPriceDebit, attempt.transferAdjustmentBps, attempt.debitAdjustmentBps];
  const present = snapshot.filter((value) => value !== null).length;
  if (present !== 0 && present !== snapshot.length) throw planInconsistent('La reserva sellada tiene un snapshot de precios incompleto.');
  if (present === 0) {
    const tenders = await tx.checkoutAttemptTender.findMany({ where: { attemptId: attempt.id }, select: { method: true } });
    if (tenders.some((tender) => tender.method !== 'CASH')) throw planInconsistent('La reserva sellada usa un medio externo sin snapshot de precios.');
  }

  const sealed: Array<[string, number, bigint]> = [['CASH', 0, attempt.fullPriceCash]];
  if (present !== 0) {
    sealed.push(['TRANSFER', attempt.transferAdjustmentBps!, attempt.fullPriceTransfer!]);
    sealed.push(['CARD_DEBIT', attempt.debitAdjustmentBps!, attempt.fullPriceDebit!]);
  }
  for (const [method, bps, sealedFullPrice] of sealed) {
    let fullPrice: bigint;
    try {
      fullPrice = lineFullPrices(lines, bps).reduce((sum, value) => sum + value, 0n);
    } catch (error) {
      // An engine refusal (e.g. AMOUNT_OVERFLOW) means the plan cannot be
      // reproduced; its own code and detail never leave this guard.
      if (error instanceof AppError) throw planInconsistent(`El precio completo sellado de ${method} no se puede reproducir.`);
      throw error;
    }
    if (fullPrice !== sealedFullPrice) throw planInconsistent(`El precio completo sellado de ${method} no coincide con la venta.`);
  }
}

// Step 7 (S7-D): the stock recovery plan, shared with T-RR. Locks, computes and
// validates; writes NOTHING (the apply step is separate, so a caller can still
// refuse — e.g. a changed quote — before any stock write).
//   required[v] = Σ current SaleItem.quantity of v;
//   own[v]      = Σ EVERY ACTIVE hold of the sale on v — unexpired or expired,
//                 several rows, or a variant no longer on the sale (orphan);
//   V           = keys(required) ∪ keys(own), locked in Inventory id order.
// Defects (500 CHECKOUT_STATE_INCONSISTENT) are reported before any shortage,
// so corruption is never disguised as missing stock:
//   an ACTIVE hold of another branch or with quantity ≤ 0; an own variant with
//   no Inventory row; reserved < own; a negative new reserved; an orphan whose
//   newReserved still exceeds physical (S7-D.1).
// Then, for each required variant: physical − (reserved − own) ≥ required, else
// 409 INSUFFICIENT_STOCK {variantId} (a missing Inventory row is a shortage only
// when nothing of the sale is reserved on it). That check is exactly
// newReserved ≤ physical, so 0 ≤ newReserved ≤ physical holds for EVERY variant. Unchanged (changed:false) only when every required
// variant has EXACTLY ONE unexpired ACTIVE hold of exactly its quantity and
// nothing else is held.
export async function evaluateStockRecovery(tx: Tx, sale: { id: string; branchId: string }, now: Date): Promise<StockRecoveryEvaluation> {
  const items = await tx.saleItem.findMany({ where: { saleId: sale.id }, select: { variantId: true, quantity: true } });
  if (items.length === 0) throw inconsistentState('La venta no tiene renglones.');
  const requiredByVariant = new Map<string, bigint>();
  for (const item of items) {
    if (item.quantity <= 0n) throw inconsistentState('Un renglón tiene una cantidad inválida.');
    requiredByVariant.set(item.variantId, (requiredByVariant.get(item.variantId) ?? 0n) + item.quantity);
  }

  // Every ACTIVE hold of the sale, NOT pre-filtered by branch: a hold of another
  // branch is a defect to report, never a row to ignore.
  const activeReservations = await tx.$queryRaw<StockRecoveryHold[]>`
    SELECT id, "variantId", "branchId", quantity, "expiresAt"
    FROM "StockReservation"
    WHERE "saleId" = ${sale.id} AND status = 'ACTIVE'
    ORDER BY id ASC
    FOR UPDATE
  `;
  const ownByVariant = new Map<string, bigint>();
  const rowsByVariant = new Map<string, number>();
  for (const hold of activeReservations) {
    if (hold.branchId !== sale.branchId) throw inconsistentState('Una reserva de stock pertenece a otra sucursal.');
    if (hold.quantity <= 0n) throw inconsistentState('Una reserva de stock tiene una cantidad inválida.');
    ownByVariant.set(hold.variantId, (ownByVariant.get(hold.variantId) ?? 0n) + hold.quantity);
    rowsByVariant.set(hold.variantId, (rowsByVariant.get(hold.variantId) ?? 0) + 1);
  }

  const variantIds = [...new Set([...requiredByVariant.keys(), ...ownByVariant.keys()])].sort();
  const inventories = await tx.$queryRaw<Array<{ id: string; variantId: string; physical: bigint; reserved: bigint }>>`
    SELECT id, "variantId", physical, reserved
    FROM "Inventory"
    WHERE "branchId" = ${sale.branchId}
      AND "variantId" IN (${Prisma.join(variantIds)})
    ORDER BY id ASC
    FOR UPDATE
  `;
  const inventoryByVariant = new Map(inventories.map((inventory) => [inventory.variantId, inventory]));

  // Pass 1 — defects, for every variant of V.
  for (const variantId of variantIds) {
    const own = ownByVariant.get(variantId) ?? 0n;
    const inventory = inventoryByVariant.get(variantId);
    if (!inventory) {
      if (own > 0n) throw inconsistentState('Una reserva de stock no tiene inventario.');
      continue;
    }
    if (inventory.reserved < own) throw inconsistentState('El inventario reservado es menor que las reservas de la venta.');
    const required = requiredByVariant.get(variantId) ?? 0n;
    const newReserved = inventory.reserved - own + required;
    if (newReserved < 0n) throw inconsistentState('El inventario reservado resultante sería negativo.');
    // S7-D.1: an orphan (no longer required) whose release still leaves the row
    // over-reserved means other operations already exceed the physical stock —
    // a defect T-S must not write back. A REQUIRED variant over physical is a
    // shortage instead (pass 2).
    if (required === 0n && newReserved > inventory.physical) {
      throw inconsistentState('El inventario reservado de la variante excede el stock físico.');
    }
  }

  // Pass 2 — availability of every REQUIRED variant, before any write. An
  // orphan (required 0) is only released: it needs no availability.
  const variants: StockRecoveryVariant[] = [];
  for (const variantId of variantIds) {
    const required = requiredByVariant.get(variantId) ?? 0n;
    const ownReserved = ownByVariant.get(variantId) ?? 0n;
    const inventory = inventoryByVariant.get(variantId);
    if (!inventory) throw insufficientStock(variantId);
    if (required > 0n && inventory.physical - (inventory.reserved - ownReserved) < required) throw insufficientStock(variantId);
    variants.push({
      variantId, inventoryId: inventory.id, physical: inventory.physical,
      previousReserved: inventory.reserved, ownReserved, required,
      newReserved: inventory.reserved - ownReserved + required,
    });
  }

  const changed = ownByVariant.size !== requiredByVariant.size
    || [...requiredByVariant].some(([variantId, required]) => ownByVariant.get(variantId) !== required || rowsByVariant.get(variantId) !== 1)
    || activeReservations.some((hold) => holdExpiredByClock(hold, now));

  return { changed, now, requiredByVariant, ownByVariant, activeReservations, variants };
}

export type StockRecoveryApplied = { released: StockRecoveryHold[]; created: StockRecoveryHold[]; expiresAt: Date };

// Step 8 (S7-E): applies EXACTLY the evaluated plan, shared with T-RR. It never
// re-decides availability; every write is guarded against the rows evaluate
// locked, and any mismatch fails the whole unit closed (500).
//   a. every own ACTIVE hold → RELEASED (status guard; count must match);
//   b. Inventory.reserved = newReserved, the computed BigInt (never an
//      increment), guarded by the locked row's previous value;
//   c. one ACTIVE hold per required variant (an orphan is only released), all
//      expiring at the same evaluation.now + TECHNICAL_HOLD_TTL_MS.
export async function applyStockRecovery(
  tx: Tx,
  sale: { id: string; branchId: string },
  evaluation: StockRecoveryEvaluation,
): Promise<StockRecoveryApplied> {
  const releasedIds = evaluation.activeReservations.map((hold) => hold.id);
  if (releasedIds.length > 0) {
    const released = await tx.stockReservation.updateMany({
      where: { id: { in: releasedIds }, status: 'ACTIVE' },
      data: { status: 'RELEASED' },
    });
    if (released.count !== releasedIds.length) throw inconsistentState('Las reservas de stock cambiaron durante la recuperación.');
  }

  for (const variant of [...evaluation.variants].sort((left, right) => (left.inventoryId < right.inventoryId ? -1 : 1))) {
    const updated = await tx.inventory.updateMany({
      where: { id: variant.inventoryId, reserved: variant.previousReserved },
      data: { reserved: variant.newReserved },
    });
    if (updated.count !== 1) throw inconsistentState('El inventario cambió durante la recuperación.');
  }

  const expiresAt = new Date(evaluation.now.getTime() + TECHNICAL_HOLD_TTL_MS);
  const created: StockRecoveryHold[] = [];
  for (const variant of evaluation.variants) {
    if (variant.required === 0n) continue;
    const hold = await tx.stockReservation.create({
      data: { saleId: sale.id, variantId: variant.variantId, branchId: sale.branchId, quantity: variant.required, status: 'ACTIVE', expiresAt },
    });
    created.push({ id: hold.id, variantId: hold.variantId, branchId: hold.branchId, quantity: hold.quantity, expiresAt: hold.expiresAt });
  }
  return { released: evaluation.activeReservations, created, expiresAt };
}

// The ONE writer of the CHECKOUT_STOCK_RECOVERED audit, shared by T-S and T-RR
// (OWNER N-1), so both record exactly the same payload. The caller has applied
// the evaluated plan and passes the attempt the audit is about (for T-RR, the
// NEW attempt) and its own justification. `before.stockState` is the coverage
// of the locked pre-write rows (evaluation.activeReservations at
// evaluation.now) with the existing stockStateOf semantics; the evaluation is
// never mutated by the apply step, so it is the state BEFORE the writes.
export function writeCheckoutStockRecoveredAudit(tx: Pick<Prisma.TransactionClient, 'auditLog'>, input: {
  userId: string;
  branchId: string;
  attemptId: string;
  reserveKey: string;
  reason: string;
  evidence: string;
  evaluation: StockRecoveryEvaluation;
  applied: StockRecoveryApplied;
}) {
  const { evaluation, applied } = input;
  const { stockState } = stockStateOf({
    branchId: input.branchId,
    items: [...evaluation.requiredByVariant].map(([variantId, quantity]) => ({ variantId, quantity })),
    activeHolds: evaluation.activeReservations,
    now: evaluation.now,
  });
  const hold = ({ id, variantId, quantity, expiresAt }: StockRecoveryHold) => ({ id, variantId, quantity, expiresAt });
  return createAuditLog(tx, {
    userId: input.userId,
    branchId: input.branchId,
    action: 'CHECKOUT_STOCK_RECOVERED',
    entityType: 'CheckoutAttempt',
    entityId: input.attemptId,
    before: { reserveKey: input.reserveKey, stockState, released: applied.released.map(hold) },
    after: {
      reserveKey: input.reserveKey,
      reason: input.reason,
      evidence: input.evidence,
      created: applied.created.map(hold),
      reservedDeltaByVariant: evaluation.variants.map((variant) => ({
        variantId: variant.variantId,
        beforeReserved: variant.previousReserved,
        afterReserved: variant.newReserved,
        delta: variant.newReserved - variant.previousReserved,
      })),
      expiresAt: applied.expiresAt,
    },
  });
}

export type StockRecoveryResult = { changed: boolean; view: ReservationView };

export function createCheckoutStockRecoveryService(database: PrismaClient, options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());

  async function recover(req: RequestLike, saleId: string, request: CheckoutStockRecoveryRequest): Promise<StockRecoveryResult> {
    return inStockRecoveryTransaction(database, async (tx) => {
      const { sale, attempt } = await lockStockRecoveryTarget(tx, req, saleId, request.reserveKey);
      const evaluation = await evaluateStockRecovery(tx, sale, now());

      if (evaluation.changed) {
        const applied = await applyStockRecovery(tx, sale, evaluation);
        await tx.sale.update({ where: { id: sale.id }, data: { updatedAt: evaluation.now } });
        await writeCheckoutStockRecoveredAudit(tx, {
          userId: req.auth!.userId,
          branchId: sale.branchId,
          attemptId: attempt.id,
          reserveKey: attempt.reserveKey,
          reason: request.reason,
          evidence: request.evidence,
          evaluation,
          applied,
        });
      }

      const current = await tx.checkoutAttempt.findUnique({ where: { id: attempt.id } });
      if (!current) throw inconsistentState('La reserva de cobro desapareció durante la recuperación.');
      return { changed: evaluation.changed, view: await loadReservationView(tx, current, evaluation.now) };
    });
  }

  return { recover };
}

export type CheckoutStockRecoveryService = ReturnType<typeof createCheckoutStockRecoveryService>;
