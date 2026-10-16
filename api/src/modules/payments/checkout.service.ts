// R3-A3.2 (R3 rev. 2 §5–§8): the proportional checkout, the single settlement
// path of a PROPORTIONAL_V1 sale.
//
// One Serializable transaction (timeout 30000, up to 3 attempts on P2034 /
// 40001 / 40P01) does everything: it records the external collections, the
// payments and the per-line allocations, the net cash movement, transitions
// the sale to PAID and runs the shared PAID -> COMPLETED finalizer with the
// SAME TransactionClient (never a second transaction). Any failure reverts
// payments, stock, reservations, cash and audit together.
//
// Pricing is never recomputed here: computeProportionalQuote (R3-A1) is the
// only pricing authority, finalizePaidSaleInTransaction (R3-A3.1) the only
// completion authority. No Socket.IO event is emitted: the caller emits after
// commit, on the committed rows.
//
// Lock order (design §6): Sale -> ExternalCollection(id ASC) -> CashSession ->
// StockReservation(id ASC) -> Inventory(id ASC). The finalizer re-locks the
// sale, reservations and inventory in the same prefix.
import { createHash } from 'node:crypto';
import {
  Prisma,
  type PaymentMethod,
  type PrismaClient,
  type PriceType,
  type SalePricingModel,
  type TransferInstitution,
} from '../../generated/prisma/client.js';
import { assertPermissionAtLocation } from '../../middleware/authorization.js';
import { hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import { evaluateCurrentHoldCoverage } from '../sales/hold-coverage.js';
import { assertPricingFinalizable } from '../sales/wholesale-authorization.service.js';
import { finalizePaidSaleInTransaction } from '../sales/sale-finalization.js';
import { createPricingService } from '../pricing/pricing.service.js';
import { type PriceMode } from '../pricing/pricing.js';
import {
  PROPORTIONAL_METHODS,
  computeProportionalQuote,
  type ProportionalLineInput,
  type ProportionalMethod,
  type ProportionalPricingSnapshot,
  type ProportionalQuote,
  type ProportionalTenderInput,
} from '../pricing/proportional-checkout.js';

type RequestLike = Parameters<typeof assertPermissionAtLocation>[0];

export const CHECKOUT_ALGORITHM_VERSION = 1;
const CHECKOUT_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 3;
const TRANSFER_INSTITUTIONS: readonly TransferInstitution[] = ['MACRO', 'BBVA', 'NACION', 'GALICIA', 'MERCADO_PAGO', 'OTHER'];

export type CheckoutTenderRole = 'FIXED' | 'BALANCE';

// The already-parsed request (the zod DTO of the next slice performs the same
// shape checks at the HTTP boundary; this service never trusts raw JSON).
export type CheckoutTender = {
  method: ProportionalMethod;
  role: CheckoutTenderRole;
  amount: bigint | null;
  receivedAmount: bigint | null;
  reference: string | null;
  institution: TransferInstitution | null;
  institutionOther: string | null;
  externalCollectionId: string | null;
};

export type CheckoutRequest = {
  operationKey: string;
  cashSessionId: string;
  balanceMethod: ProportionalMethod;
  expectedTotal: bigint;
  expectedBalanceAmount: bigint;
  tenders: readonly CheckoutTender[];
};

export type CheckoutPaymentResult = {
  id: string;
  method: PaymentMethod;
  tenderRole: CheckoutTenderRole;
  amount: bigint;
  methodFullPrice: bigint;
  adjustmentBps: number;
  externalCollectionId: string | null;
  receivedAmount: bigint | null;
  changeAmount: bigint | null;
};

export type CheckoutResult = {
  saleId: string;
  saleNumber: string | null;
  status: 'COMPLETED';
  checkoutId: string;
  replayed: boolean;
  total: bigint;
  changeAmount: bigint;
  payments: CheckoutPaymentResult[];
  lines: Array<{ saleItemId: string; sku: string; quantity: bigint; finalAmount: bigint }>;
  completedAt: Date;
};

type LockedSale = {
  id: string;
  branchId: string;
  status: string;
  saleNumber: string | null;
  subtotal: bigint;
  total: bigint;
  pricingMode: PriceType;
  priceMode: PriceMode;
  pricingModel: SalePricingModel;
  paymentStartedAt: Date | null;
  wholesaleConfirmedAt: Date | null;
  wholesaleConfirmedById: string | null;
};

type LockedCollection = {
  id: string;
  branchId: string;
  method: PaymentMethod;
  amount: bigint;
  reference: string;
  referenceKey: string;
  institution: TransferInstitution | null;
  status: string;
};

type LockedSession = { id: string; status: string; registerId: string; branchId: string };

// ---------------------------------------------------------------------------
// Errors (design §5). Every one is thrown before the commit and leaves no row.
// ---------------------------------------------------------------------------
const validationError = (message: string) => new AppError(400, 'VALIDATION_ERROR', message);
const notFound = () => new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
const forbidden = () => new AppError(403, 'FORBIDDEN', 'No cuenta con acceso a esta sucursal.');
const invalidState = (message = 'La venta no admite el cobro proporcional en su estado actual.') => new AppError(409, 'INVALID_SALE_STATE', message);
// A FIXED_TOTAL sale never reaches the proportional checkout; the historical
// /payments path owns it. No dedicated code exists in the design table.
const notProportional = () => new AppError(409, 'INVALID_SALE_STATE', 'Esta venta no usa el cobro proporcional.');
const methodNotEnabled = (method: string) => new AppError(409, 'PAYMENT_METHOD_NOT_ENABLED', `El medio ${method} no está habilitado para el cobro proporcional.`);
const snapshotInconsistent = (message: string) => new AppError(409, 'PRICING_SNAPSHOT_INCONSISTENT', message);
const quoteChanged = (quote: ProportionalQuote) => new AppError(409, 'CHECKOUT_QUOTE_CHANGED', 'La cotización cambió; vuelva a confirmar.', { total: quote.total, balance: quote.balance.amount });
const cashReceivedInsufficient = () => new AppError(409, 'CASH_RECEIVED_INSUFFICIENT', 'El efectivo recibido es menor al importe.');
const noCashSession = () => new AppError(409, 'NO_OPEN_CASH_SESSION', 'No hay una sesión de caja abierta.');
const cashSessionBranch = () => new AppError(409, 'CASH_SESSION_BRANCH_MISMATCH', 'La sesión de caja pertenece a otra sucursal.');
const reservationExpired = () => new AppError(409, 'RESERVATION_EXPIRED', 'La reserva de la venta venció; no admite un primer cobro.');
const invalidReservation = () => new AppError(409, 'INVALID_RESERVATION', 'La venta no tiene reservas vigentes que respalden sus artículos.');
const insufficientPhysical = (variantId: string) => new AppError(409, 'INSUFFICIENT_PHYSICAL', 'El inventario físico no puede cubrir la venta.', { variantId });
const insufficientReserved = (variantId: string) => new AppError(409, 'INSUFFICIENT_RESERVED', 'El inventario reservado no puede cubrir la venta.', { variantId });
const referenceAlreadyRecorded = (status: string) => new AppError(409, 'EXTERNAL_REFERENCE_ALREADY_RECORDED', 'La referencia ya está registrada.', { status });
const unappliedPending = () => new AppError(409, 'UNAPPLIED_EXTERNAL_COLLECTION_PENDING', 'La venta tiene cobros externos sin imputar que no se incluyeron.');
const collectionNotApplicable = () => new AppError(409, 'EXTERNAL_COLLECTION_NOT_APPLICABLE', 'El cobro registrado no se puede aplicar a este medio o importe.');
const concurrencyError = () => new AppError(409, 'CONCURRENCY_ERROR', 'La operación no pudo completarse por concurrencia.');
const inconsistentState = (message: string) => new AppError(500, 'CHECKOUT_STATE_INCONSISTENT', message);

const transient = (error: unknown) => {
  const candidate = error as { code?: string; meta?: { code?: string } };
  const message = error instanceof Error ? error.message : '';
  return candidate.code === 'P2034' || candidate.meta?.code === '40001'
    || candidate.meta?.code === '40P01' || message.includes('40001')
    || message.includes('40P01') || message.includes('TransactionWriteConflict');
};

// Which unique constraint the driver reported. Prisma names the field list for a
// declared @@unique and, for the SQL-only partial indexes, may name the index
// itself; both shapes are recognised. The two reference indexes are told apart by
// their own columns (the debit key is (branch, referenceKey); the transfer key
// always carries institution), so the resolution can select the ONE method that
// actually collided. A target that identifies no method stays `null` and fails
// closed: no status is ever attributed to a guessed method.
type UniqueCollision =
  | { kind: 'operationKey' }
  | { kind: 'saleId' }
  | { kind: 'externalCollection' }
  | { kind: 'reference'; method: ProportionalMethod | null };

const uniqueCollision = (error: unknown): UniqueCollision | null => {
  const candidate = error as { code?: string; meta?: { target?: unknown } };
  if (candidate.code !== 'P2002') return null;
  const target = candidate.meta?.target;
  const text = (Array.isArray(target) ? target.join(',') : typeof target === 'string' ? target : '').toLowerCase();
  if (text.includes('operationkey')) return { kind: 'operationKey' };
  if (text.includes('externalcollectionid')) return { kind: 'externalCollection' };
  if (text.includes('externalcollection_transfer_ref_key') || text.includes('institution')) return { kind: 'reference', method: 'TRANSFER' };
  if (text.includes('externalcollection_debit_ref_key')) return { kind: 'reference', method: 'CARD_DEBIT' };
  // (branchId, referenceKey) without institution can only be the debit index.
  if (text.includes('branchid') && text.includes('referencekey')) return { kind: 'reference', method: 'CARD_DEBIT' };
  if (text.includes('referencekey')) return { kind: 'reference', method: null };
  if (text.includes('saleid')) return { kind: 'saleId' };
  return null;
};

// Reference canonical form (design §7): upper-case letters and digits only.
export function normalizeReferenceKey(reference: string): string {
  return reference.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

const METHOD_ORDER: Record<ProportionalMethod, number> = { CASH: 0, TRANSFER: 1, CARD_DEBIT: 2 };

// requestHash = SHA-256 of a canonical JSON with a fixed key order (design §7).
// Absent values are the empty string; the tender order never changes the hash.
export function checkoutRequestHash(saleId: string, request: CheckoutRequest): string {
  const tenders = [...request.tenders].sort((left, right) => METHOD_ORDER[left.method] - METHOD_ORDER[right.method]);
  const canonical = JSON.stringify({
    v: 1,
    saleId,
    cashSessionId: request.cashSessionId,
    balanceMethod: request.balanceMethod,
    expectedTotal: request.expectedTotal.toString(),
    expectedBalanceAmount: request.expectedBalanceAmount.toString(),
    tenders: tenders.map((tender) => ({
      method: tender.method,
      role: tender.role,
      amount: tender.amount === null ? '' : tender.amount.toString(),
      receivedAmount: tender.receivedAmount === null ? '' : tender.receivedAmount.toString(),
      referenceKey: tender.reference === null ? '' : normalizeReferenceKey(tender.reference),
      institution: tender.institution ?? '',
      institutionOther: tender.institutionOther?.trim() ?? '',
      externalCollectionId: tender.externalCollectionId ?? '',
    })),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function assertMethodEnabled(method: string): asserts method is ProportionalMethod {
  if (!(PROPORTIONAL_METHODS as readonly string[]).includes(method)) throw methodNotEnabled(method);
}

// Shape validation of the parsed request (V1-V7 of the design; the zod DTO of
// the next slice repeats it at the HTTP boundary). Fails before any transaction.
export function validateCheckoutRequest(request: CheckoutRequest): void {
  assertMethodEnabled(request.balanceMethod);
  if (request.tenders.length === 0) throw validationError('Se requiere al menos un medio de pago.');
  const methods = new Set<string>();
  let balances = 0;
  for (const tender of request.tenders) {
    assertMethodEnabled(tender.method);
    if (methods.has(tender.method)) throw validationError('Los medios de pago no pueden repetirse.');
    methods.add(tender.method);

    if (tender.role === 'BALANCE') {
      balances += 1;
      if (tender.method !== request.balanceMethod) throw validationError('El medio de saldo no coincide con balanceMethod.');
      if (tender.amount !== null) throw validationError('El medio de saldo no lleva importe: lo calcula el servidor.');
    } else if (tender.role === 'FIXED') {
      if (tender.amount === null) throw validationError('Un importe fijo requiere importe.');
      if (tender.amount <= 0n) throw validationError('Un importe fijo debe ser mayor que cero.');
      // Money actually received (CASH, TRANSFER, CARD_DEBIT) may carry centavos:
      // only the COMPUTED prices, balance and total land on whole pesos, and
      // chk_payment_balance_whole_peso constrains the BALANCE tender alone.
    } else {
      throw validationError('El rol del medio de pago no es válido.');
    }

    if (tender.method === 'CASH') {
      if (tender.reference !== null || tender.institution !== null || tender.institutionOther !== null || tender.externalCollectionId !== null) {
        throw validationError('El efectivo no lleva referencia ni institución.');
      }
      if (tender.receivedAmount === null) throw validationError('El efectivo recibido es obligatorio.');
      if (tender.amount !== null && tender.receivedAmount < tender.amount) throw cashReceivedInsufficient();
      continue;
    }

    if (tender.receivedAmount !== null) throw validationError('Solo el efectivo lleva importe recibido.');
    const hasReference = tender.reference !== null;
    const hasCollection = tender.externalCollectionId !== null;
    if (hasReference === hasCollection) throw validationError('Débito y transferencia llevan referencia o cobro externo, nunca ambos.');
    if (hasCollection) {
      // The registered collection already owns the reference and the institution.
      if (tender.role !== 'FIXED') throw validationError('Un cobro externo solo se imputa como importe fijo.');
      if (tender.institution !== null || tender.institutionOther !== null) throw validationError('Un cobro externo ya registrado no repite institución.');
      continue;
    }
    // chk_ec_reference: the RAW reference is 1..64 CHARACTERS (PostgreSQL
    // char_length counts Unicode code points, so the length is counted by code
    // point too — String.length would count UTF-16 units and reject a valid
    // astral reference) AND its normalised key matches ^[A-Z0-9]{3,40}$. Both are
    // checked before anything is normalised or stored; a long reference is refused,
    // never silently truncated.
    const referenceLength = [...tender.reference!].length;
    if (referenceLength < 1 || referenceLength > 64) {
      throw validationError('La referencia debe tener entre 1 y 64 caracteres.');
    }
    const key = normalizeReferenceKey(tender.reference!);
    if (key.length < 3 || key.length > 40) throw validationError('La referencia no tiene un formato válido.');
    if (tender.method === 'TRANSFER') {
      if (tender.institution === null) throw validationError('La transferencia requiere institución.');
      if (!TRANSFER_INSTITUTIONS.includes(tender.institution)) throw validationError('La institución de la transferencia no es válida.');
      if (tender.institution === 'OTHER') {
        const label = tender.institutionOther?.trim() ?? '';
        if (label.length < 1 || label.length > 60) throw validationError('La institución OTHER requiere un nombre de hasta 60 caracteres.');
      } else if (tender.institutionOther !== null) {
        throw validationError('institutionOther solo se usa con la institución OTHER.');
      }
    } else if (tender.institution !== null || tender.institutionOther !== null) {
      throw validationError('El débito no lleva institución.');
    }
  }
  if (balances !== 1) throw validationError('Se requiere exactamente un medio de saldo.');
}

export function createCheckoutService(database: PrismaClient) {
  const pricing = createPricingService(database);

  function assertCanCharge(req: RequestLike, branchId: string) {
    // Phase 1D.3.2 SWITCH: the real decision is the Production SALE_CHARGE and
    // SALE_COMPLETE grants paired with the sale's own persisted branchId.
    assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CHARGE, branchId);
    if (!req.auth || !hasPermissionAtLocation(req.auth, PRODUCTION_PERMISSIONS.SALE_COMPLETE, branchId)) throw forbidden();
  }

  function enginePricing(snapshot: { id: string | null; adjustmentsBps: Record<PriceMode, number> }): ProportionalPricingSnapshot | null {
    if (snapshot.id === null) return null;
    return {
      bankTransferAdjustmentBps: snapshot.adjustmentsBps.BANK_TRANSFER,
      debitCardAdjustmentBps: snapshot.adjustmentsBps.DEBIT_CARD,
    };
  }

  function adjustmentFor(quote: ProportionalQuote, method: ProportionalMethod, pricing: ProportionalPricingSnapshot | null): number {
    if (method === 'CASH') return 0;
    if (pricing === null) throw snapshotInconsistent(`Falta la configuración de precios para ${method}.`);
    return method === 'TRANSFER' ? pricing.bankTransferAdjustmentBps : pricing.debitCardAdjustmentBps;
  }

  async function replay(tx: Prisma.TransactionClient, saleId: string, checkout: { id: string; total: bigint; changeAmount: bigint; completedAt: Date }) {
    const sale = await tx.sale.findFirst({ where: { id: saleId }, select: { id: true, saleNumber: true, status: true } });
    if (!sale) throw notFound();
    if (sale.status !== 'COMPLETED') throw inconsistentState('La venta tiene un checkout pero no está COMPLETED.');
    const payments = await tx.salePayment.findMany({ where: { saleId }, orderBy: [{ paidAt: 'asc' }, { id: 'asc' }] });
    const allocations = await tx.saleLineAllocation.findMany({ where: { checkoutId: checkout.id }, orderBy: { id: 'asc' } });
    const items = await tx.saleItem.findMany({ where: { saleId }, select: { id: true, sku: true, quantity: true }, orderBy: { id: 'asc' } });
    const totals = new Map<string, bigint>();
    for (const allocation of allocations) {
      const current = totals.get(allocation.saleItemId) ?? 0n;
      totals.set(allocation.saleItemId, current + allocation.amount);
    }
    return {
      saleId,
      saleNumber: sale.saleNumber,
      status: 'COMPLETED' as const,
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
      lines: items.map((item) => ({
        saleItemId: item.id,
        sku: item.sku,
        quantity: item.quantity,
        finalAmount: totals.get(item.id) ?? 0n,
      })),
      completedAt: checkout.completedAt,
    } satisfies CheckoutResult;
  }

  async function attempt(req: RequestLike, userId: string, saleId: string, request: CheckoutRequest, requestHash: string): Promise<CheckoutResult> {
    return database.$transaction(async (tx) => {
      // 1. Lock the sale.
      const [sale] = await tx.$queryRaw<LockedSale[]>`
        SELECT id, "branchId", status, "saleNumber", subtotal, total, "pricingMode", "priceMode", "pricingModel",
               "paymentStartedAt", "wholesaleConfirmedAt", "wholesaleConfirmedById"
        FROM "Sale" WHERE id = ${saleId} FOR UPDATE
      `;
      if (!sale) throw notFound();

      // 2. Permissions on the sale's own branch.
      assertCanCharge(req, sale.branchId);

      // 3. Accept only the proportional model, then resolve idempotency.
      if (sale.pricingModel !== 'PROPORTIONAL_V1') throw notProportional();

      const existingByKey = await tx.saleCheckout.findUnique({ where: { operationKey: request.operationKey } });
      if (existingByKey) {
        if (existingByKey.saleId !== saleId || existingByKey.requestHash !== requestHash) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'La clave de idempotencia ya fue utilizada con otro contenido.');
        }
        return replay(tx, saleId, existingByKey);
      }
      const existingBySale = await tx.saleCheckout.findUnique({ where: { saleId } });
      if (existingBySale) throw new AppError(409, 'SALE_ALREADY_CHECKED_OUT', 'La venta ya tiene un checkout con otra clave.');

      // 4. State and snapshot validation.
      if (sale.status !== 'PENDING_PAYMENT') throw invalidState();
      assertPricingFinalizable(sale);
      if (sale.pricingMode === 'WHOLESALE' && sale.wholesaleConfirmedAt === null) throw invalidState();
      if (sale.priceMode !== 'CASH') throw snapshotInconsistent('Una venta proporcional debe estar tasada en efectivo.');
      const previousPayments = await tx.salePayment.findMany({ where: { saleId }, select: { id: true } });
      // PROPORTIONAL_V1 is a single-shot settlement: no payment may exist and no
      // payment history may have started (the DB trigger maintains that marker).
      if (previousPayments.length > 0 || sale.paymentStartedAt !== null) throw invalidState();

      const items = await tx.saleItem.findMany({
        where: { saleId },
        select: { id: true, sku: true, quantity: true, baseUnitPrice: true, priceMode: true, priceBaseType: true },
        orderBy: { id: 'asc' },
      });
      if (items.length === 0) throw snapshotInconsistent('La venta no tiene renglones para cotizar.');
      const lines: ProportionalLineInput[] = items.map((item) => {
        if (item.priceMode !== 'CASH') throw snapshotInconsistent('Un renglón no está tasado en efectivo.');
        if (item.priceBaseType !== sale.pricingMode) throw snapshotInconsistent('La base del renglón no coincide con la venta.');
        if (item.baseUnitPrice === null || item.baseUnitPrice <= 0n || item.quantity <= 0n) throw snapshotInconsistent('Un renglón tiene cantidad o precio base inválido.');
        return { saleItemId: item.id, sku: item.sku, quantity: item.quantity, baseUnitPrice: item.baseUnitPrice };
      });

      const tenders = request.tenders;
      const tenderByMethod = new Map<ProportionalMethod, CheckoutTender>(tenders.map((tender) => [tender.method, tender]));

      // Existing external collections named by the request, locked in id order.
      const includedCollectionIds = tenders
        .map((tender) => tender.externalCollectionId)
        .filter((id): id is string => id !== null)
        .sort();
      const lockedCollections = new Map<string, LockedCollection>();
      if (includedCollectionIds.length > 0) {
        const locked = await tx.$queryRaw<LockedCollection[]>`
          SELECT id, "branchId", method, amount, reference, "referenceKey", institution, status
          FROM "ExternalCollection"
          WHERE id IN (${Prisma.join(includedCollectionIds)})
          ORDER BY id ASC
          FOR UPDATE
        `;
        for (const collection of locked) lockedCollections.set(collection.id, collection);
        if (lockedCollections.size !== includedCollectionIds.length) throw collectionNotApplicable();
        for (const tender of tenders) {
          if (tender.externalCollectionId === null) continue;
          const collection = lockedCollections.get(tender.externalCollectionId)!;
          if (collection.status !== 'UNAPPLIED') throw collectionNotApplicable();
          if (collection.branchId !== sale.branchId || collection.method !== tender.method) throw collectionNotApplicable();
          if (tender.amount === null || collection.amount !== tender.amount) throw collectionNotApplicable();
        }
      }

      // A brand-new reference must not already exist (design §8, partial unique indexes).
      for (const tender of tenders) {
        if (tender.reference === null) continue;
        const referenceKey = normalizeReferenceKey(tender.reference);
        const conflict = await tx.externalCollection.findFirst({
          where: {
            branchId: sale.branchId,
            method: tender.method,
            referenceKey,
            institution: tender.method === 'TRANSFER' ? tender.institution : null,
          },
        });
        if (conflict) throw referenceAlreadyRecorded(conflict.status);
      }

      // A checkout must not silently leave an unapplied collection of this sale behind.
      const pendingCollections = await tx.externalCollection.findMany({
        where: { originSaleId: saleId, status: 'UNAPPLIED' },
        select: { id: true },
      });
      if (pendingCollections.some((collection) => !lockedCollections.has(collection.id))) throw unappliedPending();

      // 5. Price with the single authority and compare with the confirmed quote.
      const snapshot = await pricing.getSnapshot(tx);
      const engineSnapshot = enginePricing(snapshot);
      const fixedTenders: ProportionalTenderInput[] = tenders
        .filter((tender) => tender.role === 'FIXED')
        .map((tender) => ({ method: tender.method, amount: tender.amount! }));
      const quote = computeProportionalQuote({ lines, pricing: engineSnapshot, tenders: fixedTenders, balanceMethod: request.balanceMethod });

      const cashTender = tenderByMethod.get('CASH') ?? null;
      const cashMethod = quote.methods.find((method) => method.method === 'CASH') ?? null;
      let changeAmount = 0n;
      if (cashMethod) {
        const received = cashTender?.receivedAmount ?? 0n;
        if (received < cashMethod.amount) throw cashReceivedInsufficient();
        changeAmount = received - cashMethod.amount;
      }
      if (quote.total !== request.expectedTotal || quote.balance.amount !== request.expectedBalanceAmount) throw quoteChanged(quote);

      // 6. An OPEN cash session of the sale's own branch.
      const [session] = await tx.$queryRaw<LockedSession[]>`
        SELECT cs.id, cs.status, cs."registerId", r."branchId"
        FROM "CashSession" cs
        JOIN "CashRegister" r ON r.id = cs."registerId"
        WHERE cs.id = ${request.cashSessionId}
        FOR UPDATE OF cs
      `;
      if (!session || session.status !== 'OPEN') throw noCashSession();
      if (session.branchId !== sale.branchId) throw cashSessionBranch();

      // 7. Reservations and inventory, in deterministic lock order.
      const coverageItems = await tx.saleItem.findMany({ where: { saleId }, select: { variantId: true, quantity: true } });
      const activeHolds = await tx.$queryRaw<Array<{ id: string; variantId: string; branchId: string; quantity: bigint; expiresAt: Date }>>`
        SELECT id, "variantId", "branchId", quantity, "expiresAt"
        FROM "StockReservation"
        WHERE "saleId" = ${saleId} AND status = 'ACTIVE'
        ORDER BY id ASC
        FOR UPDATE
      `;
      const coverage = evaluateCurrentHoldCoverage({
        branchId: sale.branchId, items: coverageItems, activeHolds, policy: { kind: 'FIRST_PAYMENT', now: new Date() },
      });
      if (!coverage.ok) throw coverage.reason === 'EXPIRED' ? reservationExpired() : invalidReservation();
      const { requirements } = coverage;

      const variantIds = [...requirements.keys()];
      const inventories = await tx.$queryRaw<Array<{ id: string; variantId: string; physical: bigint; reserved: bigint }>>`
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
        if (!inventory) throw insufficientPhysical(variantId);
        if (inventory.physical < required) throw insufficientPhysical(variantId);
        if (inventory.reserved < required) throw insufficientReserved(variantId);
      }

      // 8. Writes, in the design's order.
      // 8.1 Sale.total (only the proportional path reprices).
      await tx.sale.update({ where: { id: saleId }, data: { total: quote.total } });

      // 8.2 SaleCheckout.
      const checkout = await tx.saleCheckout.create({
        data: {
          saleId,
          branchId: sale.branchId,
          pricingModel: 'PROPORTIONAL_V1',
          operationKey: request.operationKey,
          requestHash,
          cashSessionId: request.cashSessionId,
          userId,
          balanceMethod: request.balanceMethod,
          referenceSubtotal: sale.subtotal,
          total: quote.total,
          changeAmount,
          fullPriceCash: quote.fullPrices.CASH ?? 0n,
          fullPriceTransfer: engineSnapshot === null ? null : quote.fullPrices.TRANSFER,
          fullPriceDebit: engineSnapshot === null ? null : quote.fullPrices.CARD_DEBIT,
          transferAdjustmentBps: engineSnapshot?.bankTransferAdjustmentBps ?? null,
          debitAdjustmentBps: engineSnapshot?.debitCardAdjustmentBps ?? null,
          pricingConfigId: snapshot.id,
          pricingConfigUpdatedAt: snapshot.updatedAt,
          algorithmVersion: CHECKOUT_ALGORITHM_VERSION,
        },
      });

      // 8.3 External collections: apply the named ones, record the new ones APPLIED.
      const collectionByMethod = new Map<ProportionalMethod, string>();
      const appliedCollections: Array<{ id: string; method: PaymentMethod; amount: bigint; referenceKey: string; created: boolean }> = [];
      for (const methodQuote of quote.methods) {
        if (methodQuote.method === 'CASH') continue;
        const tender = tenderByMethod.get(methodQuote.method)!;
        if (tender.externalCollectionId !== null) {
          await tx.externalCollection.update({
            where: { id: tender.externalCollectionId },
            data: { status: 'APPLIED', appliedCheckoutId: checkout.id, appliedSaleId: saleId },
          });
          const collection = lockedCollections.get(tender.externalCollectionId)!;
          collectionByMethod.set(methodQuote.method, collection.id);
          appliedCollections.push({ id: collection.id, method: collection.method, amount: collection.amount, referenceKey: collection.referenceKey, created: false });
        } else {
          const reference = tender.reference!;
          const created = await tx.externalCollection.create({
            data: {
              branchId: sale.branchId,
              method: methodQuote.method,
              amount: methodQuote.amount,
              reference,
              referenceKey: normalizeReferenceKey(reference),
              institution: methodQuote.method === 'TRANSFER' ? tender.institution : null,
              institutionOther: methodQuote.method === 'TRANSFER' && tender.institution === 'OTHER' ? tender.institutionOther!.trim() : null,
              status: 'APPLIED',
              originSaleId: saleId,
              cashSessionId: request.cashSessionId,
              appliedCheckoutId: checkout.id,
              appliedSaleId: saleId,
              recordedById: userId,
            },
          });
          collectionByMethod.set(methodQuote.method, created.id);
          appliedCollections.push({ id: created.id, method: methodQuote.method, amount: methodQuote.amount, referenceKey: normalizeReferenceKey(reference), created: true });
        }
      }

      // 8.4 One SalePayment per method.
      const paymentByMethod = new Map<ProportionalMethod, { id: string; amount: bigint }>();
      for (const methodQuote of quote.methods) {
        const isCash = methodQuote.method === 'CASH';
        const payment = await tx.salePayment.create({
          data: {
            saleId,
            method: methodQuote.method,
            amount: methodQuote.amount,
            pricingModel: 'PROPORTIONAL_V1',
            checkoutId: checkout.id,
            tenderRole: methodQuote.role,
            methodFullPrice: methodQuote.fullPrice,
            adjustmentBps: adjustmentFor(quote, methodQuote.method, engineSnapshot),
            cashSessionId: request.cashSessionId,
            idempotencyKey: `co:${request.operationKey}:${methodQuote.method}`,
            externalCollectionId: isCash ? null : collectionByMethod.get(methodQuote.method)!,
            receivedAmount: isCash ? (cashTender?.receivedAmount ?? 0n) : null,
            changeAmount: isCash ? changeAmount : null,
          },
        });
        paymentByMethod.set(methodQuote.method, { id: payment.id, amount: payment.amount });
      }

      // 8.5 One SaleLineAllocation per method per line.
      for (const methodQuote of quote.methods) {
        const payment = paymentByMethod.get(methodQuote.method)!;
        const perLine = quote.lineFullPrices[methodQuote.method]!;
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index]!;
          const lineFullPrice = perLine[index]!;
          await tx.saleLineAllocation.create({
            data: {
              checkoutId: checkout.id,
              saleId,
              saleItemId: line.saleItemId,
              salePaymentId: payment.id,
              method: methodQuote.method,
              quantity: line.quantity,
              baseUnitPrice: line.baseUnitPrice,
              unitPrice: lineFullPrice / line.quantity,
              lineFullPrice,
              amount: methodQuote.allocations[index]!.amount,
            },
          });
        }
      }

      // 9. The net cash income only — CASH-1 reconciliation keeps 1:1.
      if (cashMethod) {
        await tx.cashMovement.create({
          data: {
            sessionId: request.cashSessionId,
            type: 'SALE_INCOME',
            amount: cashMethod.amount,
            salePaymentId: paymentByMethod.get('CASH')!.id,
            userId,
          },
        });
      }

      // 10. PAID, then the shared finalizer with the SAME transaction.
      await tx.sale.update({ where: { id: saleId }, data: { status: 'PAID' } });
      const finalized = await finalizePaidSaleInTransaction(tx, req, userId, saleId);

      // 11. Audit, all inside the same transaction.
      for (const methodQuote of quote.methods) {
        const payment = paymentByMethod.get(methodQuote.method)!;
        await createAuditLog(tx, {
          userId, branchId: sale.branchId, action: 'PAYMENT_REGISTERED',
          entityType: 'SalePayment', entityId: payment.id,
          before: { saleId, status: 'PENDING_PAYMENT' },
          after: {
            saleId, status: 'PAID', method: methodQuote.method, tenderRole: methodQuote.role,
            amount: payment.amount, receivedAmount: methodQuote.method === 'CASH' ? (cashTender?.receivedAmount ?? 0n) : null,
            changeAmount: methodQuote.method === 'CASH' ? changeAmount : null,
          },
        });
      }
      await createAuditLog(tx, {
        userId, branchId: sale.branchId, action: 'SALE_CHECKOUT_COMPLETED',
        entityType: 'SaleCheckout', entityId: checkout.id,
        before: { saleId, status: 'PAID' },
        after: {
          checkoutId: checkout.id, requestHash, total: quote.total, changeAmount,
          balanceMethod: request.balanceMethod,
          fullPrices: quote.fullPrices,
          adjustments: { transfer: engineSnapshot?.bankTransferAdjustmentBps ?? null, debit: engineSnapshot?.debitCardAdjustmentBps ?? null },
          methods: quote.methods.map((method) => ({ method: method.method, role: method.role, amount: method.amount })),
        },
      });
      for (const collection of appliedCollections) {
        await createAuditLog(tx, {
          userId, branchId: sale.branchId, action: 'EXTERNAL_COLLECTION_APPLIED',
          entityType: 'ExternalCollection', entityId: collection.id,
          before: { status: 'UNAPPLIED' },
          after: { status: 'APPLIED', method: collection.method, amount: collection.amount, referenceKey: collection.referenceKey, appliedSaleId: saleId, created: collection.created },
        });
      }

      // 12. Invariant read inside the transaction: anything off reverts everything.
      const writtenPayments = await tx.salePayment.findMany({ where: { saleId }, select: { amount: true } });
      const writtenAllocations = await tx.saleLineAllocation.findMany({
        where: { checkoutId: checkout.id },
        select: { salePaymentId: true, amount: true },
      });
      const [settled] = await tx.$queryRaw<Array<{ total: bigint }>>`SELECT total FROM "Sale" WHERE id = ${saleId}`;
      const paymentSum = writtenPayments.reduce((sum, payment) => sum + payment.amount, 0n);
      const allocationSum = writtenAllocations.reduce((sum, allocation) => sum + allocation.amount, 0n);
      if (paymentSum !== quote.total || allocationSum !== quote.total || checkout.total !== quote.total || settled?.total !== quote.total) {
        throw inconsistentState('La conciliación de pagos, asignaciones y total no cierra.');
      }
      // Per-payment reconciliation: the global sums alone would hide two payments
      // whose allocations offset each other. Each payment must be backed by exactly
      // its own amount.
      const allocationByPayment = new Map<string, bigint>();
      for (const allocation of writtenAllocations) {
        allocationByPayment.set(allocation.salePaymentId, (allocationByPayment.get(allocation.salePaymentId) ?? 0n) + allocation.amount);
      }
      for (const methodQuote of quote.methods) {
        const payment = paymentByMethod.get(methodQuote.method)!;
        if ((allocationByPayment.get(payment.id) ?? 0n) !== payment.amount) {
          throw inconsistentState('Las asignaciones de un pago no concilian con su importe.');
        }
      }

      return {
        saleId,
        saleNumber: finalized.saleNumber,
        status: 'COMPLETED' as const,
        checkoutId: checkout.id,
        replayed: false,
        total: quote.total,
        changeAmount,
        payments: quote.methods.map((methodQuote) => ({
          id: paymentByMethod.get(methodQuote.method)!.id,
          method: methodQuote.method,
          tenderRole: methodQuote.role,
          amount: methodQuote.amount,
          methodFullPrice: methodQuote.fullPrice,
          adjustmentBps: adjustmentFor(quote, methodQuote.method, engineSnapshot),
          externalCollectionId: methodQuote.method === 'CASH' ? null : collectionByMethod.get(methodQuote.method)!,
          receivedAmount: methodQuote.method === 'CASH' ? (cashTender?.receivedAmount ?? 0n) : null,
          changeAmount: methodQuote.method === 'CASH' ? changeAmount : null,
        })),
        lines: quote.lines.map((line, index) => ({ ...line, quantity: lines[index]!.quantity })),
        completedAt: checkout.completedAt,
      } satisfies CheckoutResult;
    }, { isolationLevel: 'Serializable', timeout: CHECKOUT_TIMEOUT_MS });
  }

  // The reference a collision must be matched on is the FULL approved unique key,
  // scoped to the sale's OWN branch: CARD_DEBIT (branch, referenceKey) and TRANSFER
  // (branch, institution, referenceKey). ONLY the method the failed index names is
  // consulted — never the first reference of the request — and a missing tender or
  // a missing row returns null so the caller rethrows instead of inventing a cause.
  async function referenceCollisionStatus(tx: Prisma.TransactionClient, branchId: string, method: ProportionalMethod, request: CheckoutRequest): Promise<string | null> {
    const tender = request.tenders.find((candidate) => candidate.method === method && candidate.reference !== null);
    if (!tender) return null;
    const conflict = await tx.externalCollection.findFirst({
      where: {
        branchId,
        method,
        referenceKey: normalizeReferenceKey(tender.reference!),
        institution: method === 'TRANSFER' ? tender.institution : null,
      },
    });
    return conflict?.status ?? null;
  }

  // Resolve a P2002 in ONE fresh, consistent transaction (design §7). DB-only race
  // path: an unresolvable collision returns null and the caller rethrows the
  // original error rather than inventing a cause.
  async function resolveUniqueConflict(error: unknown, saleId: string, request: CheckoutRequest, requestHash: string): Promise<CheckoutResult | null> {
    const collision = uniqueCollision(error);
    if (collision === null) return null;
    return database.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({ where: { id: saleId }, select: { branchId: true } });
      if (!sale) return null;
      if (collision.kind === 'reference') {
        if (collision.method === null) return null;
        const status = await referenceCollisionStatus(tx, sale.branchId, collision.method, request);
        if (status === null) return null;
        throw referenceAlreadyRecorded(status);
      }
      const existing = await tx.saleCheckout.findUnique({ where: { operationKey: request.operationKey } });
      if (existing) {
        // The key of THIS very request (a concurrent duplicate) replays; the key of
        // another payload or another sale is a reuse.
        if (existing.saleId !== saleId || existing.requestHash !== requestHash) {
          throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 'La clave de idempotencia ya fue utilizada con otro contenido.');
        }
        return replay(tx, saleId, existing);
      }
      if (collision.kind === 'saleId') throw new AppError(409, 'SALE_ALREADY_CHECKED_OUT', 'La venta ya tiene un checkout con otra clave.');
      return null;
    });
  }

  async function checkout(req: RequestLike, userId: string, saleId: string, request: CheckoutRequest): Promise<CheckoutResult> {
    // Fails before opening a transaction: no side effect on a malformed request.
    validateCheckoutRequest(request);
    const requestHash = checkoutRequestHash(saleId, request);

    for (let attemptNumber = 0; attemptNumber < MAX_ATTEMPTS; attemptNumber += 1) {
      try {
        return await attempt(req, userId, saleId, request, requestHash);
      } catch (error) {
        const resolved = await resolveUniqueConflict(error, saleId, request, requestHash);
        if (resolved) return resolved;
        if (!transient(error)) throw error;
        if (attemptNumber === MAX_ATTEMPTS - 1) throw concurrencyError();
      }
    }
    throw concurrencyError();
  }

  return { checkout };
}

export type CheckoutService = ReturnType<typeof createCheckoutService>;
