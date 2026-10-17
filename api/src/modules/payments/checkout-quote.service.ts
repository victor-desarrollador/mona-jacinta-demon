// R3-A4.1 (R3 rev. 2 §5): read-only quote of a PROPORTIONAL_V1 sale.
//
// One RepeatableRead, LOCK-FREE transaction: it reads the persisted sale, its
// line snapshots and the company pricing configuration, prices them with the
// SAME single authority the settlement uses (computeProportionalQuote, R3-A1)
// and answers what the cashier needs to confirm the charge. It writes no row,
// consumes no stock hold, takes no row lock and sends nothing to the clients.
// The definitive checkout recomputes and validates everything under its own
// Serializable transaction and its own locks (design §5 step 10).
//
// Deliberately NOT evaluated here: the ACTIVE hold coverage. It depends on the
// clock and belongs to the settlement precondition; this answer exposes
// reservationExpiresAt so the caller can decide, and /checkout re-checks it.
import {
  type PaymentMethod,
  type PrismaClient,
  type SalePricingModel,
  type TransferInstitution,
} from '../../generated/prisma/client.js';
import { assertPermissionAtLocation } from '../../middleware/authorization.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { AppError } from '../../shared/errors.js';
import { assertPricingFinalizable } from '../sales/wholesale-authorization.service.js';
import { createPricingService } from '../pricing/pricing.service.js';
import { type PriceMode } from '../pricing/pricing.js';
import {
  PROPORTIONAL_METHODS,
  computeProportionalQuote,
  type ProportionalLineInput,
  type ProportionalMethod,
  type ProportionalPricingSnapshot,
  type ProportionalTenderInput,
} from '../pricing/proportional-checkout.js';

type RequestLike = Parameters<typeof assertPermissionAtLocation>[0];

// The already-parsed request: a balance method plus 0..2 FIXED tenders with
// their amounts in centavos. No price ever travels in from the caller.
export type CheckoutQuoteRequest = {
  balanceMethod: ProportionalMethod;
  tenders: readonly ProportionalTenderInput[];
};

export type CheckoutQuoteEnabledMethod = {
  method: ProportionalMethod;
  available: boolean;
  // PRICING_CONFIG_MISSING: without a pricing configuration only CASH can be
  // priced (the one availability rule of the R3-A1 engine). PAYMENT_METHOD_NOT_ENABLED:
  // S-REF's pilot gate switched the two external methods off on purpose.
  reason?: 'PRICING_CONFIG_MISSING' | 'PAYMENT_METHOD_NOT_ENABLED';
};

export type CheckoutQuoteCollection = {
  id: string;
  method: PaymentMethod;
  amount: bigint;
  reference: string;
  institution: TransferInstitution | null;
  institutionOther: string | null;
};

export type CheckoutQuoteResult = {
  saleId: string;
  saleNumber: string | null;
  pricingModel: SalePricingModel;
  enabledMethods: CheckoutQuoteEnabledMethod[];
  fullPrices: Record<ProportionalMethod, bigint | null>;
  tenders: Array<{ method: ProportionalMethod; role: 'FIXED'; amount: bigint }>;
  balance: { method: ProportionalMethod; amount: bigint };
  total: bigint;
  lines: Array<{ saleItemId: string; sku: string; quantity: bigint; finalAmount: bigint }>;
  unappliedCollections: CheckoutQuoteCollection[];
  reservationExpiresAt: Date | null;
};

// Errors (design §5). Codes and messages match the settlement path so the same
// condition never yields two different answers, and every one leaves no row.
const notFound = () => new AppError(404, 'NOT_FOUND', 'No se encontró la venta.');
const invalidState = (message = 'La venta no admite el cobro proporcional en su estado actual.') => new AppError(409, 'INVALID_SALE_STATE', message);
// A FIXED_TOTAL sale never uses the proportional path: it keeps the historical
// /payments circuit. Same stable code the settlement answers for this case.
const notProportional = () => new AppError(409, 'INVALID_SALE_STATE', 'Esta venta no usa el cobro proporcional.');
const snapshotInconsistent = (message: string) => new AppError(409, 'PRICING_SNAPSHOT_INCONSISTENT', message);

export function createCheckoutQuoteService(
  database: PrismaClient,
  options: { externalMethodsEnabled?: boolean } = {},
) {
  const pricing = createPricingService(database);
  // S-REF: the pilot gate is injected by composition, never read from the
  // process here, so the quote stays a pure projection. S-REF.1: the fallback is
  // FAIL-CLOSED — a caller that omits the option gets the external methods OFF,
  // and no omission can ever enable them. The runtime always injects the
  // validated configuration from app.ts.
  const externalMethodsEnabled = options.externalMethodsEnabled ?? false;

  function assertCanQuote(req: RequestLike, branchId: string) {
    // Design §5: the route gate is SALE_CHARGE and the service re-checks it on
    // the sale's OWN persisted branch. Lighter than the settlement gate on
    // purpose: a quote commits nothing, so SALE_COMPLETE is not demanded.
    assertPermissionAtLocation(req, PRODUCTION_PERMISSIONS.SALE_CHARGE, branchId);
  }

  function enginePricing(snapshot: { id: string | null; adjustmentsBps: Record<PriceMode, number> }): ProportionalPricingSnapshot | null {
    // Parity with the settlement: no configuration row means CASH only.
    if (snapshot.id === null) return null;
    return {
      bankTransferAdjustmentBps: snapshot.adjustmentsBps.BANK_TRANSFER,
      debitCardAdjustmentBps: snapshot.adjustmentsBps.DEBIT_CARD,
    };
  }

  async function quote(
    req: RequestLike,
    saleId: string,
    request: CheckoutQuoteRequest,
  ): Promise<CheckoutQuoteResult> {
    return database.$transaction(async (tx) => {
      const sale = await tx.sale.findFirst({
        where: { id: saleId },
        select: {
          id: true,
          branchId: true,
          saleNumber: true,
          status: true,
          pricingMode: true,
          priceMode: true,
          pricingModel: true,
          paymentStartedAt: true,
          wholesaleConfirmedAt: true,
          wholesaleConfirmedById: true,
        },
      });
      if (!sale) throw notFound();

      // Permissions on the sale's own branch, exactly like the settlement.
      assertCanQuote(req, sale.branchId);

      // Same acceptance order and codes as /checkout: model, state, snapshot.
      if (sale.pricingModel !== 'PROPORTIONAL_V1') throw notProportional();
      if (sale.status !== 'PENDING_PAYMENT') throw invalidState();
      assertPricingFinalizable(sale);
      if (sale.priceMode !== 'CASH') throw snapshotInconsistent('Una venta proporcional debe estar tasada en efectivo.');

      // PROPORTIONAL_V1 is a single-shot settlement: nothing may be paid yet.
      const previousPayments = await tx.salePayment.findMany({ where: { saleId }, select: { id: true } });
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

      // The single pricing authority, fed with the persisted snapshots only.
      const snapshot = await pricing.getSnapshot(tx);
      const engineSnapshot = enginePricing(snapshot);
      const priced = computeProportionalQuote({
        lines,
        pricing: engineSnapshot,
        tenders: request.tenders,
        balanceMethod: request.balanceMethod,
      });

      // What the caller must see: the sale's own unapplied collections of the
      // sale's OWN branch (a collection of another branch or another sale is
      // never this sale's incident), and the expiry the cashier has to watch.
      // Both are plain reads.
      const unappliedCollections = await tx.externalCollection.findMany({
        where: { originSaleId: saleId, branchId: sale.branchId, status: 'UNAPPLIED' },
        select: { id: true, method: true, amount: true, reference: true, institution: true, institutionOther: true },
        orderBy: { id: 'asc' },
      });
      const activeHolds = await tx.stockReservation.findMany({
        where: { saleId, status: 'ACTIVE' },
        select: { expiresAt: true },
      });

      return {
        saleId,
        saleNumber: sale.saleNumber,
        pricingModel: sale.pricingModel,
        enabledMethods: PROPORTIONAL_METHODS.map((method): CheckoutQuoteEnabledMethod => {
          if (method === 'CASH') return { method, available: true };
          // S-REF gate: with the external methods switched off the two non-cash
          // methods are unavailable whatever the pricing configuration says, and
          // the reason distinguishes an intentional pilot switch-off from a
          // missing configuration.
          if (!externalMethodsEnabled) {
            return { method, available: false, reason: 'PAYMENT_METHOD_NOT_ENABLED' };
          }
          return engineSnapshot !== null
            ? { method, available: true }
            : { method, available: false, reason: 'PRICING_CONFIG_MISSING' };
        }),
        fullPrices: priced.fullPrices,
        tenders: request.tenders.map((tender) => ({ method: tender.method, role: 'FIXED' as const, amount: tender.amount })),
        balance: priced.balance,
        total: priced.total,
        lines: priced.lines.map((line, index) => ({ ...line, quantity: lines[index]!.quantity })),
        // S-REF.1: while the external methods are off, a recorded collection is
        // not a consumable option (T-R refuses it), so the quote never offers it.
        unappliedCollections: externalMethodsEnabled
          ? unappliedCollections.map((collection) => ({
            id: collection.id,
            method: collection.method,
            amount: collection.amount,
            reference: collection.reference,
            institution: collection.institution,
            institutionOther: collection.institutionOther,
          }))
          : [],
        reservationExpiresAt: activeHolds.length === 0
          ? null
          : new Date(Math.min(...activeHolds.map((hold) => hold.expiresAt.getTime()))),
      };
    }, { isolationLevel: 'RepeatableRead' });
  }

  return { quote };
}

export type CheckoutQuoteService = ReturnType<typeof createCheckoutQuoteService>;
