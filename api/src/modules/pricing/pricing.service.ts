import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../shared/audit.js';
import {
  PRICE_MODES,
  ZERO_ADJUSTMENTS,
  assertAdjustmentBps,
  type PricingConfigSnapshot,
} from './pricing.js';

type PricingDatabase = Pick<PrismaClient, 'company' | 'companyPricingConfig' | '$transaction'>;

const selectConfig = {
  id: true,
  companyId: true,
  listAdjustmentBps: true,
  creditCardAdjustmentBps: true,
  debitCardAdjustmentBps: true,
  bankTransferAdjustmentBps: true,
  qrAdjustmentBps: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type PricingConfigUpdate = Partial<{
  LIST: number;
  CREDIT_CARD: number;
  DEBIT_CARD: number;
  BANK_TRANSFER: number;
  QR: number;
}>;

function toSnapshot(config: null | {
  id: string;
  updatedAt: Date;
  listAdjustmentBps: number;
  creditCardAdjustmentBps: number;
  debitCardAdjustmentBps: number;
  bankTransferAdjustmentBps: number;
  qrAdjustmentBps: number;
}): PricingConfigSnapshot {
  if (!config) return { id: null, updatedAt: null, adjustmentsBps: { ...ZERO_ADJUSTMENTS } };
  return {
    id: config.id,
    updatedAt: config.updatedAt,
    adjustmentsBps: {
      CASH: 0,
      LIST: config.listAdjustmentBps,
      CREDIT_CARD: config.creditCardAdjustmentBps,
      DEBIT_CARD: config.debitCardAdjustmentBps,
      BANK_TRANSFER: config.bankTransferAdjustmentBps,
      QR: config.qrAdjustmentBps,
    },
  };
}

function validatePatch(input: PricingConfigUpdate) {
  for (const mode of PRICE_MODES) {
    if (mode === 'CASH') continue;
    const value = input[mode];
    if (value !== undefined) assertAdjustmentBps(value, mode);
  }
  if (Object.keys(input).length === 0) {
    throw new AppError(400, 'PRICE_CONFIG_EMPTY_UPDATE', 'Debe indicar al menos un ajuste.');
  }
}

export function createPricingService(database: PricingDatabase) {
  async function companyId() {
    const company = await database.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
    if (!company) throw new AppError(409, 'COMPANY_NOT_CONFIGURED', 'No hay compañía configurada.');
    return company.id;
  }

  async function getSnapshot(): Promise<PricingConfigSnapshot> {
    const id = await companyId();
    const config = await database.companyPricingConfig.findUnique({ where: { companyId: id }, select: selectConfig });
    return toSnapshot(config);
  }

  async function getConfig() {
    const id = await companyId();
    const config = await database.companyPricingConfig.findUnique({ where: { companyId: id }, select: selectConfig });
    return toSnapshot(config);
  }

  async function updateConfig(userId: string, input: PricingConfigUpdate) {
    validatePatch(input);
    return database.$transaction(async (tx) => {
      const company = await tx.company.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
      if (!company) throw new AppError(409, 'COMPANY_NOT_CONFIGURED', 'No hay compañía configurada.');
      const before = await tx.companyPricingConfig.findUnique({ where: { companyId: company.id }, select: selectConfig });
      const data = {
        ...(input.LIST !== undefined ? { listAdjustmentBps: input.LIST } : {}),
        ...(input.CREDIT_CARD !== undefined ? { creditCardAdjustmentBps: input.CREDIT_CARD } : {}),
        ...(input.DEBIT_CARD !== undefined ? { debitCardAdjustmentBps: input.DEBIT_CARD } : {}),
        ...(input.BANK_TRANSFER !== undefined ? { bankTransferAdjustmentBps: input.BANK_TRANSFER } : {}),
        ...(input.QR !== undefined ? { qrAdjustmentBps: input.QR } : {}),
      };
      const updated = await tx.companyPricingConfig.upsert({
        where: { companyId: company.id },
        create: { companyId: company.id, ...data },
        update: data,
        select: selectConfig,
      });
      await createAuditLog(tx, {
        userId,
        branchId: null,
        action: 'COMPANY_PRICING_CONFIG_CHANGED',
        entityType: 'CompanyPricingConfig',
        entityId: updated.id,
        before: before ? toSnapshot(before).adjustmentsBps : null,
        after: toSnapshot(updated).adjustmentsBps,
      });
      return toSnapshot(updated);
    });
  }

  return { getSnapshot, getConfig, updateConfig };
}
