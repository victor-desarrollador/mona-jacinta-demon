import { Prisma, type PriceType, type PrismaClient } from '../../generated/prisma/client.js';
import { assertPermissionAtLocation } from '../../middleware/authorization.js';
import { actsAsRoleAtLocation, hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { logger } from '../../shared/logger.js';
import { createInventoryService } from '../inventory/inventory.service.js';
import type { AddSaleItemInput, UpdateSaleItemInput } from './dto/sale-item.dto.js';
import { createReservationService } from './reservation.service.js';
import { createCancellationService } from './cancellation.service.js';
import { cashierHoldState, canAcceptPayment, evaluateCurrentHoldCoverage, type HoldCoverageFailure } from './hold-coverage.js';
import {
  assertPricingFinalizable,
  createWholesaleCodeVerifier,
  parseWholesaleCode,
  unitPriceFor,
  type WholesaleCodeVerifier,
} from './wholesale-authorization.service.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';
import { REALTIME_EVENTS } from '../../realtime/socket.js';

type SaleDatabase = PrismaClient;

const saleInclude = {
  items: {
    orderBy: { id: 'asc' as const },
    include: {
      variant: {
        select: {
          id: true, sku: true, barcode: true, color: true, size: true,
          price: true, isActive: true,
          product: { select: { id: true, name: true, slug: true, isActive: true } },
        },
      },
    },
  },
  branch: { select: { id: true, name: true, code: true } },
  seller: { select: { id: true, name: true, email: true } },
} satisfies Prisma.SaleInclude;

function notFound(message: string) {
  return new AppError(404, 'NOT_FOUND', message);
}

function ensureDraft(sale: { status: string }) {
  if (sale.status !== 'DRAFT') {
    throw new AppError(409, 'SALE_NOT_DRAFT', 'La venta no se encuentra en borrador.');
  }
}

function ensureSaleAccess(
  req: Parameters<typeof assertPermissionAtLocation>[0],
  sale: { sellerId: string; branchId: string },
  userId: string,
) {
  assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_VIEW, sale.branchId);
  if (sale.sellerId !== userId) {
    throw new AppError(403, 'FORBIDDEN', 'No cuenta con permisos para esta venta.');
  }
}

function completionConflict(code: string, message: string, details?: unknown) {
  return new AppError(409, code, message, details);
}

// Pilot P0.1-C: completion keeps its pre-existing stable codes/messages for
// each current-coverage defect.
function completionCoverageError(reason: HoldCoverageFailure, variantId?: string) {
  if (reason === 'INVALID_ITEM_QUANTITY') return completionConflict('INVALID_SALE_QUANTITY', 'La venta contiene una cantidad inválida.');
  if (reason === 'NO_ITEMS') return completionConflict('INVALID_RESERVATION', 'La venta no tiene cantidades para finalizar.');
  if (reason === 'INVALID_HOLD') return completionConflict('INVALID_RESERVATION', 'La reserva de la venta no es válida para finalizarse.');
  return completionConflict('INVALID_RESERVATION', 'Las reservas no respaldan exactamente los artículos de la venta.', variantId ? { variantId } : undefined);
}

function isTransientCompletionError(error: unknown) {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034'
    || candidate.meta?.code === '40001'
    || candidate.meta?.code === '40P01'
    || message.includes('40001')
    || message.includes('40P01')
    || message.includes('TransactionWriteConflict');
}

function variantName(variant: { color: string | null; size: string | null }) {
  return [variant.color, variant.size].filter(Boolean).join(' / ') || 'Única';
}

async function recalculateTotals(tx: Prisma.TransactionClient, saleId: string) {
  const items = await tx.saleItem.findMany({ where: { saleId }, select: { subtotal: true } });
  const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0n);
  return tx.sale.update({
    where: { id: saleId },
    data: { subtotal, discountTotal: 0n, total: subtotal },
    include: saleInclude,
  });
}

// Block 1: every item write re-reads the price mode under the Sale row lock,
// so it serializes with a wholesale activation and can never snapshot a
// price from the other catalog column.
async function lockDraft(tx: Prisma.TransactionClient, saleId: string) {
  const [sale] = await tx.$queryRaw<Array<{ id: string; status: string; pricingMode: PriceType; total: bigint }>>`
    SELECT id, status, "pricingMode", total FROM "Sale" WHERE id = ${saleId} FOR UPDATE
  `;
  if (!sale) throw notFound('No se encontró la venta.');
  ensureDraft(sale);
  return sale;
}

export function createSalesService(
  database: SaleDatabase,
  // Block 1: without a verifier, wholesale activation is unavailable.
  options: { realtime?: RealtimeEmitter; wholesaleVerifier?: WholesaleCodeVerifier } = {},
) {
  const wholesaleVerifier = options.wholesaleVerifier ?? createWholesaleCodeVerifier(undefined);
  const inventory = createInventoryService(database);
  const cancellation = createCancellationService(database);
  // Pilot P0.1-B2: targeted expiry reconciliation before send-to-cashier.
  // Each candidate release has already committed when it is returned, so
  // the existing inventory.updated event is emitted after commit and never
  // inside a transaction. Realtime is advisory: an emit failure is logged
  // on its own and never reclassifies or stops a committed release.
  const reservations = createReservationService(database, {
    reconcileBeforeSend: async (target) => {
      const result = await cancellation.reconcileBeforeSend(target);
      for (const release of result.released) {
        try {
          options.realtime?.emit(REALTIME_EVENTS.inventoryUpdated, release);
        } catch {
          logger.warn({ event: 'reservation_pre_reconcile_notify_failed', saleId: release.saleId, code: 'NOTIFY_FAILED' });
        }
      }
      return result;
    },
  });

  async function loadSale(saleId: string) {
    const sale = await database.sale.findUnique({ where: { id: saleId }, include: saleInclude });
    if (!sale) throw notFound('No se encontró la venta.');
    return sale;
  }

  async function authorizeSale(
    req: Parameters<typeof assertPermissionAtLocation>[0], userId: string, saleId: string,
  ) {
    const sale = await loadSale(saleId);
    ensureSaleAccess(req, sale, userId);
    return sale;
  }

  async function createDraftSale(
    req: Parameters<typeof assertPermissionAtLocation>[0], userId: string, requestedBranchId?: string,
  ) {
    const branchId = requestedBranchId ?? (req.auth?.effectiveLocationIds.length === 1 ? req.auth.effectiveLocationIds[0] : undefined);
    if (!branchId) throw new AppError(400, 'BRANCH_REQUIRED', 'Debe indicar una sucursal autorizada.');
    // A COMPANY assignment's hasPermissionAtLocation qualifies for ANY
    // non-empty locationId string (authorization-policy.ts's documented
    // contract) — this client-controlled branchId must be validated against
    // a persisted, active Location before it ever reaches that policy check.
    const location = await database.location.findUnique({ where: { id: branchId }, select: { isActive: true } });
    if (!location || !location.isActive) throw notFound('No se encontró la sucursal.');
    assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CREATE, branchId);
    return database.$transaction(async (tx) => {
      const sale = await tx.sale.create({
        data: { sellerId: userId, branchId, status: 'DRAFT', subtotal: 0n, discountTotal: 0n, total: 0n },
        include: saleInclude,
      });
      await createAuditLog(tx, {
        userId,
        branchId,
        action: 'SALE_CREATED',
        entityType: 'Sale',
        entityId: sale.id,
        after: {
          status: sale.status,
          subtotal: sale.subtotal,
          discountTotal: sale.discountTotal,
          total: sale.total,
        },
      });
      return sale;
    });
  }

  async function addItem(
    req: Parameters<typeof assertPermissionAtLocation>[0], userId: string, saleId: string, input: AddSaleItemInput,
  ) {
    const sale = await authorizeSale(req, userId, saleId);
    ensureDraft(sale);
    const variant = await database.productVariant.findUnique({
      where: { id: input.variantId },
      select: {
        id: true, productId: true, sku: true, price: true, wholesalePrice: true, color: true, size: true, isActive: true,
        product: { select: { id: true, name: true, isActive: true } },
      },
    });
    if (!variant || !variant.isActive || !variant.product.isActive) throw notFound('No se encontró la variante activa.');
    const existing = sale.items.find((item) => item.variantId === input.variantId);
    const quantity = (existing?.quantity ?? 0n) + input.quantity;
    await inventory.checkAvailability(sale.branchId, [{ variantId: input.variantId, quantity }]);
    return database.$transaction(async (tx) => {
      const locked = await lockDraft(tx, saleId);
      const current = await tx.saleItem.findFirst({ where: { saleId, variantId: variant.id }, orderBy: { id: 'asc' } });
      if (current) {
        // The line keeps its original price snapshot.
        const nextQuantity = current.quantity + input.quantity;
        await tx.saleItem.update({ where: { id: current.id }, data: { quantity: nextQuantity, subtotal: nextQuantity * current.unitPrice } });
      } else {
        // Server-chosen catalog price for the sale's mode; never client input.
        const unitPrice = unitPriceFor(locked.pricingMode, variant);
        await tx.saleItem.create({
          data: {
            saleId, variantId: variant.id, productId: variant.productId,
            productName: variant.product.name, variantName: variantName(variant), sku: variant.sku,
            quantity: input.quantity, unitPrice, subtotal: input.quantity * unitPrice,
          },
        });
      }
      return recalculateTotals(tx, saleId);
    });
  }

  async function updateItem(
    req: Parameters<typeof assertPermissionAtLocation>[0], userId: string, saleId: string, itemId: string, input: UpdateSaleItemInput,
  ) {
    const sale = await authorizeSale(req, userId, saleId);
    ensureDraft(sale);
    const item = sale.items.find(({ id }) => id === itemId);
    if (!item) throw notFound('No se encontró el artículo de la venta.');
    await inventory.checkAvailability(sale.branchId, [{ variantId: item.variantId, quantity: input.quantity }]);
    return database.$transaction(async (tx) => {
      await lockDraft(tx, saleId);
      // Re-read under the lock: a wholesale activation may have repriced it.
      const current = await tx.saleItem.findUnique({ where: { id: itemId } });
      if (!current || current.saleId !== saleId) throw notFound('No se encontró el artículo de la venta.');
      await tx.saleItem.update({ where: { id: itemId }, data: { quantity: input.quantity, subtotal: input.quantity * current.unitPrice } });
      return recalculateTotals(tx, saleId);
    });
  }

  async function removeItem(req: Parameters<typeof assertPermissionAtLocation>[0], userId: string, saleId: string, itemId: string) {
    const sale = await authorizeSale(req, userId, saleId);
    ensureDraft(sale);
    if (!sale.items.some(({ id }) => id === itemId)) throw notFound('No se encontró el artículo de la venta.');
    return database.$transaction(async (tx) => {
      await tx.saleItem.delete({ where: { id: itemId } });
      return recalculateTotals(tx, saleId);
    });
  }

  // Block 1: the sale's own seller enables WHOLESALE for THIS draft sale by
  // submitting the wholesale code. Only the verification result is used:
  // the code is never stored, logged, audited or returned. Every current
  // line is repriced from the catalog wholesale price atomically; a line
  // without one fails the whole activation closed.
  async function activateWholesale(
    req: Parameters<typeof assertPermissionAtLocation>[0], userId: string, saleId: string, rawCode: string,
  ) {
    const code = parseWholesaleCode(rawCode);
    const sale = await authorizeSale(req, userId, saleId);
    assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CREATE, sale.branchId);
    ensureDraft(sale);
    if (!wholesaleVerifier.configured) {
      throw new AppError(503, 'WHOLESALE_NOT_CONFIGURED', 'La venta mayorista no está habilitada.');
    }
    if (!(await wholesaleVerifier.verify(code))) {
      logger.warn({ event: 'wholesale_code_rejected', saleId, code: 'WHOLESALE_CODE_INVALID' });
      throw new AppError(403, 'WHOLESALE_CODE_INVALID', 'El código mayorista no es válido.');
    }
    return database.$transaction(async (tx) => {
      const locked = await lockDraft(tx, saleId);
      if (locked.pricingMode === 'WHOLESALE') return tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: saleInclude });
      const items = await tx.saleItem.findMany({
        where: { saleId }, orderBy: { id: 'asc' },
        include: { variant: { select: { id: true, price: true, wholesalePrice: true } } },
      });
      // Price every line before writing any of them.
      const repriced = items.map((item) => ({ item, unitPrice: unitPriceFor('WHOLESALE', item.variant) }));
      for (const { item, unitPrice } of repriced) {
        await tx.saleItem.update({
          where: { id: item.id },
          data: { unitPrice, subtotal: item.quantity * unitPrice },
        });
      }
      await tx.sale.update({ where: { id: saleId }, data: { pricingMode: 'WHOLESALE', wholesaleAuthorizedAt: new Date() } });
      const updated = await recalculateTotals(tx, saleId);
      await createAuditLog(tx, {
        userId, branchId: sale.branchId, action: 'SALE_WHOLESALE_AUTHORIZED', entityType: 'Sale', entityId: saleId,
        before: { pricingMode: 'LIST', total: locked.total, items: items.map(({ variantId, unitPrice }) => ({ variantId, unitPrice })) },
        after: {
          pricingMode: 'WHOLESALE', total: updated.total,
          items: repriced.map(({ item, unitPrice }) => ({ variantId: item.variantId, unitPrice })),
        },
      });
      return updated;
    });
  }

  // Block 1: a cashier at the sale's own location confirms the wholesale
  // buyer before the sale may take a payment. Two layers: the normal
  // SALE_CHARGE permission at the sale's location, AND the business actor —
  // a persisted CASHIER LOCATION assignment at that location carrying that
  // permission (ADMIN/OWNER company authority alone never qualifies). The
  // sale's seller can never confirm it, even when also holding a cashier
  // assignment. Idempotent: a repeat returns the original confirmer.
  async function confirmWholesale(
    req: Parameters<typeof assertPermissionAtLocation>[0], userId: string, saleId: string,
  ) {
    return database.$transaction(async (tx) => {
      const [sale] = await tx.$queryRaw<Array<{
        id: string; branchId: string; sellerId: string; status: string; pricingMode: PriceType;
        wholesaleConfirmedAt: Date | null; wholesaleConfirmedById: string | null;
      }>>`
        SELECT id, "branchId", "sellerId", status, "pricingMode", "wholesaleConfirmedAt", "wholesaleConfirmedById"
        FROM "Sale" WHERE id = ${saleId} FOR UPDATE
      `;
      if (!sale) throw notFound('No se encontró la venta.');
      assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CHARGE, sale.branchId);
      if (!actsAsRoleAtLocation(req.auth!, 'CASHIER', PRODUCTION_PERMISSIONS.SALE_CHARGE, sale.branchId)) {
        throw new AppError(403, 'WHOLESALE_CASHIER_REQUIRED', 'La venta mayorista debe confirmarla un cajero de la sucursal.');
      }
      if (sale.sellerId === userId) {
        throw new AppError(403, 'WHOLESALE_SELF_CONFIRMATION', 'Quien realizó la venta no puede confirmarla como mayorista.');
      }
      if (sale.pricingMode !== 'WHOLESALE') throw completionConflict('SALE_NOT_WHOLESALE', 'La venta no es mayorista.');
      const result = (replayed: boolean, confirmedAt: Date, confirmedById: string) => ({
        saleId, branchId: sale.branchId, pricingMode: sale.pricingMode,
        wholesaleConfirmedAt: confirmedAt, wholesaleConfirmedById: confirmedById, replayed,
      });
      if (sale.wholesaleConfirmedAt && sale.wholesaleConfirmedById) {
        return result(true, sale.wholesaleConfirmedAt, sale.wholesaleConfirmedById);
      }
      if (sale.status !== 'PENDING_PAYMENT') {
        throw completionConflict('INVALID_SALE_STATE', 'Solo se puede confirmar una venta pendiente de pago.');
      }
      const confirmedAt = new Date();
      await tx.sale.update({ where: { id: saleId }, data: { wholesaleConfirmedAt: confirmedAt, wholesaleConfirmedById: userId } });
      await createAuditLog(tx, {
        userId, branchId: sale.branchId, action: 'SALE_WHOLESALE_CONFIRMED', entityType: 'Sale', entityId: saleId,
        before: { pricingMode: sale.pricingMode, wholesaleConfirmed: false },
        after: { pricingMode: sale.pricingMode, wholesaleConfirmed: true },
      });
      return result(false, confirmedAt, userId);
    });
  }

  async function getDraft(req: Parameters<typeof assertPermissionAtLocation>[0], userId: string, saleId: string) {
    const sale = await authorizeSale(req, userId, saleId);
    ensureDraft(sale);
    return sale;
  }

  async function listDrafts(userId: string, branchIds: string[]) {
    return database.sale.findMany({
      where: { sellerId: userId, branchId: { in: branchIds }, status: 'DRAFT' },
      orderBy: { createdAt: 'desc' },
      include: saleInclude,
    });
  }

  async function sendToCashier(saleId: string, userId: string, branchIds: string[]) {
    await reservations.sendToCashier(saleId, userId, branchIds);
    return loadSale(saleId);
  }

  // Pilot P0.1-C: the cashier work queue is PENDING_PAYMENT + PAID, so a
  // fully paid sale stays visible until completed. holdState and
  // canAcceptPayment are informational (one wall-clock read per request);
  // payment and completion re-check everything under the Sale lock.
  // Pilot P0.2-C: canCorrect/canCancel are informational eligibility for
  // the CALLER (live permission at the row's own persisted location, same
  // assignment), computed in memory with no extra query. /correct and
  // /cancel re-check everything under the Sale lock.
  // Block 1: pricingMode/wholesaleConfirmed are the stored state; a WHOLESALE
  // sale is not chargeable until confirmed, and canConfirmWholesale is the
  // caller's informational eligibility (confirmWholesale re-checks).
  async function listPendingSales(branchIds: string[], auth?: Pick<Express.AuthContext, 'assignments' | 'userId'>) {
    const now = new Date();
    const sales = await database.sale.findMany({
      where: { status: { in: ['PENDING_PAYMENT', 'PAID'] }, branchId: { in: branchIds } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true, saleNumber: true, subtotal: true, total: true, status: true, branchId: true,
        sellerId: true, pricingMode: true, wholesaleConfirmedAt: true,
        seller: { select: { name: true } },
        // Historical item snapshots only; never join the current catalog.
        items: {
          orderBy: { id: 'asc' },
          select: {
            id: true, productId: true, variantId: true,
            productName: true, variantName: true, sku: true,
            quantity: true, unitPrice: true, subtotal: true,
          },
        },
        payments: { select: { amount: true } },
        stockReservations: {
          where: { status: 'ACTIVE' },
          select: { variantId: true, branchId: true, quantity: true, expiresAt: true },
        },
      },
    });
    return sales.map((sale) => {
      const paidAmount = sale.payments.reduce((sum, payment) => sum + payment.amount, 0n);
      const holdState = cashierHoldState({
        status: sale.status, paymentCount: sale.payments.length, branchId: sale.branchId,
        items: sale.items, activeHolds: sale.stockReservations, now,
      });
      const wholesaleConfirmed = sale.wholesaleConfirmedAt !== null;
      const pricingReady = sale.pricingMode === 'LIST' || wholesaleConfirmed;
      return {
        saleId: sale.id,
        saleNumber: sale.saleNumber,
        sellerName: sale.seller.name,
        status: sale.status,
        items: sale.items,
        subtotal: sale.subtotal,
        total: sale.total,
        paidAmount,
        remainingBalance: sale.total - paidAmount,
        holdState,
        canAcceptPayment: canAcceptPayment(holdState) && pricingReady,
        paymentCount: sale.payments.length,
        pricingMode: sale.pricingMode,
        wholesaleConfirmed,
        canConfirmWholesale: sale.pricingMode === 'WHOLESALE' && !wholesaleConfirmed && sale.status === 'PENDING_PAYMENT'
          && Boolean(auth && auth.userId !== sale.sellerId
            && hasPermissionAtLocation(auth, PRODUCTION_PERMISSIONS.SALE_CHARGE, sale.branchId)
            && actsAsRoleAtLocation(auth, 'CASHIER', PRODUCTION_PERMISSIONS.SALE_CHARGE, sale.branchId)),
        canCorrect: holdState === 'VALID'
          && Boolean(auth && hasPermissionAtLocation(auth, PRODUCTION_PERMISSIONS.SALE_CORRECT_PENDING, sale.branchId)),
        canCancel: sale.status === 'PENDING_PAYMENT' && sale.payments.length === 0
          && Boolean(auth && hasPermissionAtLocation(auth, PRODUCTION_PERMISSIONS.SALE_CANCEL_PENDING, sale.branchId)),
      };
    });
  }

  async function completeSaleInTransaction(
    tx: Prisma.TransactionClient,
    req: Parameters<typeof assertPermissionAtLocation>[0],
    userId: string,
    saleId: string,
  ) {
    const [sale] = await tx.$queryRaw<Array<{
      id: string;
      branchId: string;
      status: string;
      total: bigint;
      pricingMode: PriceType;
      wholesaleConfirmedAt: Date | null;
      wholesaleConfirmedById: string | null;
    }>>`
      SELECT id, "branchId", status, total, "pricingMode", "wholesaleConfirmedAt", "wholesaleConfirmedById"
      FROM "Sale"
      WHERE id = ${saleId}
      FOR UPDATE
    `;
    if (!sale) throw notFound('No se encontró la venta.');

    // Phase 1D.3.1 SWITCH: the real decision is the Production SALE_COMPLETE
    // grant paired with this sale's own location (req.auth.assignments), not
    // a bare effectiveLocationIds membership check.
    if (!req.auth || !hasPermissionAtLocation(req.auth, PRODUCTION_PERMISSIONS.SALE_COMPLETE, sale.branchId)) {
      throw new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
    }

    if (sale.status === 'COMPLETED') return tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: saleInclude });
    if (sale.status !== 'PAID') throw completionConflict('INVALID_SALE_STATE', 'La venta no está lista para finalizarse.');

    // Block 1: defense in depth (payment already requires it; the DB CHECK
    // chk_sale_wholesale_confirmed_when_paid is the last guard).
    assertPricingFinalizable(sale);
    const items = await tx.saleItem.findMany({ where: { saleId }, select: { variantId: true, quantity: true } });

    // Pilot P0.1-C: only CURRENT ACTIVE holds back a completion. Historical
    // RELEASED/CONSUMED rows are neither locked, matched nor re-consumed.
    // A PAID sale is completable after its original expiresAt (the sweeper
    // never touches PAID). Lock order stays Sale -> StockReservation(id
    // ASC) -> Inventory(id ASC), the same prefix as B1 release and cancel.
    const activeHolds = await tx.$queryRaw<Array<{
      id: string;
      variantId: string;
      branchId: string;
      quantity: bigint;
      expiresAt: Date;
    }>>`
      SELECT id, "variantId", "branchId", quantity, "expiresAt"
      FROM "StockReservation"
      WHERE "saleId" = ${saleId} AND status = 'ACTIVE'
      ORDER BY id ASC
      FOR UPDATE
    `;
    const coverage = evaluateCurrentHoldCoverage({
      branchId: sale.branchId, items, activeHolds, policy: { kind: 'PAID_COMPLETION' },
    });
    if (!coverage.ok) throw completionCoverageError(coverage.reason, coverage.variantId);
    const { requirements } = coverage;

    const variantIds = [...requirements.keys()];
    const inventories = await tx.$queryRaw<Array<{
      id: string;
      variantId: string;
      physical: bigint;
      reserved: bigint;
    }>>`
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
      if (!inventory) throw completionConflict('INVENTORY_NOT_FOUND', 'No se encontró el inventario de la variante.', { variantId });
      if (inventory.physical < required) throw completionConflict('INSUFFICIENT_PHYSICAL', 'El inventario físico no puede cubrir la venta.', { variantId });
      if (inventory.reserved < required) throw completionConflict('INSUFFICIENT_RESERVED', 'El inventario reservado no puede cubrir la venta.', { variantId });
    }

    const finalizedInventory: Array<{ variantId: string; quantity: bigint }> = [];
    for (const [variantId, required] of requirements) {
      const inventory = inventoryByVariant.get(variantId)!;
      await tx.inventory.update({
        where: { id: inventory.id },
        data: {
          physical: inventory.physical - required,
          reserved: inventory.reserved - required,
        },
      });
      await tx.stockMovement.create({
        data: {
          inventoryId: inventory.id,
          type: 'SALE',
          quantityDelta: -required,
          saleId,
          userId,
          branchId: sale.branchId,
        },
      });
      finalizedInventory.push({ variantId, quantity: required });
    }

    const consumed = await tx.stockReservation.updateMany({
      where: { id: { in: activeHolds.map(({ id }) => id) }, status: 'ACTIVE' },
      data: { status: 'CONSUMED' },
    });
    if (consumed.count !== activeHolds.length) {
      throw completionConflict('INVALID_RESERVATION', 'La reserva de la venta no es válida para finalizarse.');
    }
    await createAuditLog(tx, {
      userId,
      branchId: sale.branchId,
      action: 'SALE_COMPLETED',
      entityType: 'Sale',
      entityId: saleId,
      before: { status: 'PAID' },
      after: { status: 'COMPLETED', inventory: finalizedInventory },
    });
    await tx.sale.update({ where: { id: saleId }, data: { status: 'COMPLETED' } });
    return tx.sale.findUniqueOrThrow({ where: { id: saleId }, include: saleInclude });
  }

  async function completeSale(
    req: Parameters<typeof assertPermissionAtLocation>[0], userId: string, saleId: string,
  ) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await database.$transaction(
          (tx) => completeSaleInTransaction(tx, req, userId, saleId),
          { isolationLevel: 'Serializable', timeout: 30000 },
        );
      } catch (error) {
        if (!isTransientCompletionError(error)) throw error;
        if (attempt === 3) throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
      }
    }
    throw new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
  }

  return {
    createDraftSale, addItem, updateItem, removeItem, activateWholesale, confirmWholesale,
    getDraft, listDrafts, sendToCashier, listPendingSales, completeSale,
  };
}
