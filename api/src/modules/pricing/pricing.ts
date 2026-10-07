import { AppError } from '../../shared/errors.js';

export const BASIS_POINTS = 10_000n;
export const MAX_PRICE_ADJUSTMENT_BPS = 10_000;

export const PRICE_MODES = ['CASH', 'LIST', 'CREDIT_CARD', 'DEBIT_CARD', 'BANK_TRANSFER', 'QR'] as const;
export type PriceMode = (typeof PRICE_MODES)[number];

export type PricingConfigSnapshot = {
  id: string | null;
  updatedAt: Date | null;
  adjustmentsBps: Record<PriceMode, number>;
};

export type PriceBaseTier = 'LIST' | 'WHOLESALE';

export type PriceCalculation = {
  baseTier: PriceBaseTier;
  priceMode: PriceMode;
  baseUnitPrice: bigint;
  adjustmentBps: number;
  unitPrice: bigint;
  pricingConfigId: string | null;
  pricingConfigUpdatedAt: Date | null;
};

export const ZERO_ADJUSTMENTS: Record<PriceMode, number> = {
  CASH: 0,
  LIST: 0,
  CREDIT_CARD: 0,
  DEBIT_CARD: 0,
  BANK_TRANSFER: 0,
  QR: 0,
};

export function assertAdjustmentBps(value: number, field = 'adjustmentBps') {
  if (!Number.isInteger(value) || value < 0 || value > MAX_PRICE_ADJUSTMENT_BPS) {
    throw new AppError(400, 'INVALID_PRICE_ADJUSTMENT', `${field} debe estar entre 0 y ${MAX_PRICE_ADJUSTMENT_BPS} bps.`);
  }
}

export function roundHalfUpBps(base: bigint, adjustmentBps: number): bigint {
  assertAdjustmentBps(adjustmentBps);
  const multiplier = BASIS_POINTS + BigInt(adjustmentBps);
  return (base * multiplier + BASIS_POINTS / 2n) / BASIS_POINTS;
}

export function calculateUnitPrice(input: {
  baseTier: PriceBaseTier;
  priceMode: PriceMode;
  baseUnitPrice: bigint;
  config: PricingConfigSnapshot;
}): PriceCalculation {
  if (input.baseUnitPrice <= 0n) {
    throw new AppError(409, 'PRICE_BASE_MISSING', 'La variante no tiene precio base válido.');
  }
  const adjustmentBps = input.priceMode === 'CASH' ? 0 : input.config.adjustmentsBps[input.priceMode];
  assertAdjustmentBps(adjustmentBps, input.priceMode);
  return {
    baseTier: input.baseTier,
    priceMode: input.priceMode,
    baseUnitPrice: input.baseUnitPrice,
    adjustmentBps,
    unitPrice: roundHalfUpBps(input.baseUnitPrice, adjustmentBps),
    pricingConfigId: input.config.id,
    pricingConfigUpdatedAt: input.config.updatedAt,
  };
}

export function paymentMethodPriceMode(method: string): Exclude<PriceMode, 'LIST'> {
  if (method === 'CASH') return 'CASH';
  if (method === 'TRANSFER') return 'BANK_TRANSFER';
  if (method === 'CARD_DEBIT') return 'DEBIT_CARD';
  if (method === 'CARD_CREDIT') return 'CREDIT_CARD';
  if (method === 'QR') return 'QR';
  throw new AppError(400, 'UNSUPPORTED_PAYMENT_METHOD', 'El medio de pago no está soportado.');
}

export function assertPaymentCompatible(priceMode: PriceMode, method: string) {
  if (priceMode === 'LIST') return;
  const methodMode = paymentMethodPriceMode(method);
  if (methodMode !== priceMode) {
    throw new AppError(409, 'PAYMENT_METHOD_PRICE_MODE_CONFLICT', 'El medio de pago no coincide con el modo de precio de la venta.');
  }
}
