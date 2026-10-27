// Pilot Pricing V2 — REAL PostgreSQL constraint behavior (LOCAL_TEST via the supported test lifecycle).
//
// Preregistered BEFORE execution (2026-10-06). Classes: ALLOW | DENY | DEFAULT_CASH | NOT_APPLICABLE.
//  P01 cashPrice NULL (transition)                                  ALLOW
//  P02 cashPrice > 0                                                ALLOW
//  P03 cashPrice = 0                                                DENY  chk_product_variant_cash_price_positive
//  P04 cashPrice < 0                                                DENY  chk_product_variant_cash_price_positive
//  P05 wholesalePrice = cashPrice                                   ALLOW
//  P06 wholesalePrice < cashPrice                                   ALLOW
//  P07 wholesalePrice > cashPrice (insert and update)               DENY  chk_product_variant_wholesale_not_above_cash
//  P07c cashPrice NULL with a wholesalePrice (transition)           ALLOW
//  P08 every config bps = 0                                         ALLOW
//  P09 every config bps = 10000                                     ALLOW
//  P10 any one config bps < 0 (5 columns)                           DENY  chk_company_pricing_config_bps_bounds
//  P11 any one config bps > 10000 (5 columns)                       DENY  chk_company_pricing_config_bps_bounds
//  P12 first CompanyPricingConfig for the company                   ALLOW
//  P13 second CompanyPricingConfig for the same company             DENY  CompanyPricingConfig_companyId_key
//  P14 SaleItem legacy snapshot, all four fields NULL               ALLOW
//  P15 SaleItem complete valid snapshot (incl. bps 0 and 10000)     ALLOW
//  P16 SaleItem partial/inconsistent snapshot (7 shapes)            DENY  chk_sale_item_pricing_snapshot_consistency
//  P17 new Sale with priceMode omitted (Prisma default path)        DEFAULT_CASH
//  P17b new Sale INSERT omitting priceMode (database column default) DEFAULT_CASH
//  P18 CompanyPricingConfig for a nonexistent company               DENY  CompanyPricingConfig_companyId_fkey
//  P19 historical-sale LIST backfill                                NOT_APPLICABLE (the supported lifecycle starts from a freshly seeded schema with no pre-migration rows)
//
// Every case runs inside a transaction that is always rolled back: an ALLOW case proves PostgreSQL accepted the write, then
// nothing persists, so no cleanup beyond the supported fixture lifecycle is needed. A DENY case must be rejected AND name the
// intended constraint, so it cannot pass for an unrelated reason.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { createTestPrismaClient, truncateAllTables, withTransaction } from '../helpers/test-db.js';

class Rollback extends Error {}

describe('Pilot Pricing V2 PostgreSQL constraints', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let baseline: { sellerId: string; branchId: string; productId: string; variantId: string; companyId: string };

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const [seller, branch, variant, company] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      prisma.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
      prisma.company.findFirstOrThrow(),
    ]);
    baseline = { sellerId: seller.id, branchId: branch.id, productId: variant.productId, variantId: variant.id, companyId: company.id };
    // The migrated, seeded baseline holds no pricing config; P12/P13 depend on that.
    expect(await prisma.companyPricingConfig.count()).toBe(0);
  });

  afterAll(async () => prisma?.$disconnect());

  // Runs `fn` in a transaction that is ALWAYS rolled back. Resolves { accepted: true, value } when every statement
  // succeeded, or { accepted: false, error } with the database error when one was rejected.
  async function attempt<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    let value: T | undefined;
    try {
      await withTransaction(prisma, async (tx) => {
        value = await fn(tx);
        throw new Rollback();
      });
    } catch (error) {
      if (error instanceof Rollback) return { accepted: true as const, value: value as T };
      return { accepted: false as const, error };
    }
    throw new Error('unreachable');
  }
  const text = (error: unknown) => {
    const parts = [String(error)];
    try {
      parts.push(JSON.stringify(error, Object.getOwnPropertyNames(error as object)));
    } catch {
      /* not serializable */
    }
    return parts.join(' ');
  };
  async function expectDenied(constraint: string, fn: (tx: Prisma.TransactionClient) => Promise<unknown>) {
    const result = await attempt(fn);
    expect(result.accepted, `expected PostgreSQL to reject the write (${constraint})`).toBe(false);
    if (!result.accepted) expect(text(result.error)).toContain(constraint);
  }
  async function expectAllowed<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    const result = await attempt(fn);
    if (!result.accepted) throw new Error(`PostgreSQL rejected a write that must be accepted: ${text(result.error)}`);
    return result.value;
  }

  let sequence = 0;
  const variantData = (extra: { price?: bigint; cashPrice?: bigint | null; wholesalePrice?: bigint | null } = {}) => {
    sequence += 1;
    return {
      productId: baseline.productId, sku: `PV2-CON-${process.pid}-${sequence}`, barcode: `PV2-CON-BC-${process.pid}-${sequence}`,
      price: extra.price ?? 100n, costPrice: 50n,
      ...(extra.cashPrice === undefined ? {} : { cashPrice: extra.cashPrice }),
      ...(extra.wholesalePrice === undefined ? {} : { wholesalePrice: extra.wholesalePrice }),
    };
  };
  const CASH_POSITIVE = 'chk_product_variant_cash_price_positive';
  const WHOLESALE_CASH = 'chk_product_variant_wholesale_not_above_cash';

  describe('ProductVariant.cashPrice / wholesalePrice', () => {
    it('P01 cashPrice NULL is accepted (transition) and stays NULL', async () => {
      const row = await expectAllowed((tx) => tx.productVariant.create({ data: variantData() }));
      expect(row.cashPrice).toBeNull();
    });
    it('P02 cashPrice > 0 is accepted', async () => {
      const row = await expectAllowed((tx) => tx.productVariant.create({ data: variantData({ cashPrice: 1n }) }));
      expect(row.cashPrice).toBe(1n);
    });
    it('P03 cashPrice = 0 is rejected by chk_product_variant_cash_price_positive', async () => {
      await expectDenied(CASH_POSITIVE, (tx) => tx.productVariant.create({ data: variantData({ cashPrice: 0n }) }));
    });
    it('P04 cashPrice < 0 is rejected by chk_product_variant_cash_price_positive', async () => {
      await expectDenied(CASH_POSITIVE, (tx) => tx.productVariant.create({ data: variantData({ cashPrice: -1n }) }));
    });
    it('P04b updating an existing variant to cashPrice 0 is rejected', async () => {
      await expectDenied(CASH_POSITIVE, (tx) => tx.productVariant.update({ where: { id: baseline.variantId }, data: { cashPrice: 0n } }));
    });
    it('P05 wholesalePrice = cashPrice is accepted', async () => {
      await expectAllowed((tx) => tx.productVariant.create({ data: variantData({ cashPrice: 80n, wholesalePrice: 80n }) }));
    });
    it('P06 wholesalePrice < cashPrice is accepted', async () => {
      await expectAllowed((tx) => tx.productVariant.create({ data: variantData({ cashPrice: 80n, wholesalePrice: 70n }) }));
    });
    it('P07 wholesalePrice > cashPrice is rejected by chk_product_variant_wholesale_not_above_cash (insert)', async () => {
      // wholesalePrice (60) stays <= price (100), so only the new cash check can reject it.
      await expectDenied(WHOLESALE_CASH, (tx) => tx.productVariant.create({ data: variantData({ cashPrice: 50n, wholesalePrice: 60n }) }));
    });
    it('P07b raising wholesalePrice above an existing cashPrice is rejected (update)', async () => {
      await expectDenied(WHOLESALE_CASH, async (tx) => {
        const created = await tx.productVariant.create({ data: variantData({ cashPrice: 50n, wholesalePrice: 40n }) });
        await tx.productVariant.update({ where: { id: created.id }, data: { wholesalePrice: 60n } });
      });
    });
    it('P07c cashPrice NULL with a wholesalePrice is accepted (transition)', async () => {
      await expectAllowed((tx) => tx.productVariant.create({ data: variantData({ wholesalePrice: 90n }) }));
    });
  });

  describe('CompanyPricingConfig', () => {
    const FIELDS = ['listAdjustmentBps', 'creditCardAdjustmentBps', 'debitCardAdjustmentBps', 'bankTransferAdjustmentBps', 'qrAdjustmentBps'] as const;
    const BOUNDS = 'chk_company_pricing_config_bps_bounds';
    const config = (data: Partial<Record<(typeof FIELDS)[number], number>> = {}, companyId = baseline.companyId) => ({ companyId, ...data });

    it('P08 every bps = 0 (also the column defaults) is accepted', async () => {
      const row = await expectAllowed((tx) => tx.companyPricingConfig.create({ data: config() }));
      for (const field of FIELDS) expect(row[field]).toBe(0);
    });
    it('P09 every bps = 10000 is accepted', async () => {
      const all = Object.fromEntries(FIELDS.map((f) => [f, 10000]));
      const row = await expectAllowed((tx) => tx.companyPricingConfig.create({ data: config(all) }));
      for (const field of FIELDS) expect(row[field]).toBe(10000);
    });
    for (const field of FIELDS) {
      it(`P10 ${field} < 0 is rejected by ${BOUNDS}`, async () => {
        await expectDenied(BOUNDS, (tx) => tx.companyPricingConfig.create({ data: config({ [field]: -1 }) }));
      });
      it(`P11 ${field} > 10000 is rejected by ${BOUNDS}`, async () => {
        await expectDenied(BOUNDS, (tx) => tx.companyPricingConfig.create({ data: config({ [field]: 10001 }) }));
      });
    }
    it('P10b updating an existing config out of bounds is rejected', async () => {
      await expectDenied(BOUNDS, async (tx) => {
        const created = await tx.companyPricingConfig.create({ data: config() });
        await tx.companyPricingConfig.update({ where: { id: created.id }, data: { qrAdjustmentBps: 10001 } });
      });
    });
    it('P12 the first config for the company is accepted', async () => {
      await expectAllowed(async (tx) => {
        expect(await tx.companyPricingConfig.count({ where: { companyId: baseline.companyId } })).toBe(0);
        return tx.companyPricingConfig.create({ data: config({ listAdjustmentBps: 1500 }) });
      });
    });
    it('P13 a second config for the same company is rejected by CompanyPricingConfig_companyId_key', async () => {
      await expectDenied('CompanyPricingConfig_companyId_key', async (tx) => {
        await tx.companyPricingConfig.create({ data: config() });
        await tx.companyPricingConfig.create({ data: config({ qrAdjustmentBps: 5 }) });
      });
    });
    it('P18 a config for a nonexistent company is rejected by CompanyPricingConfig_companyId_fkey', async () => {
      await expectDenied('CompanyPricingConfig_companyId_fkey', (tx) => tx.companyPricingConfig.create({ data: config({}, 'no-such-company') }));
    });
  });

  describe('SaleItem pricing snapshot', () => {
    const CONSISTENCY = 'chk_sale_item_pricing_snapshot_consistency';
    type Snapshot = Partial<Pick<Prisma.SaleItemUncheckedCreateInput, 'priceBaseType' | 'priceMode' | 'baseUnitPrice' | 'priceAdjustmentBps'>>;
    const complete: Snapshot = { priceBaseType: 'LIST', priceMode: 'CREDIT_CARD', baseUnitPrice: 100n, priceAdjustmentBps: 2000 };
    const insertItem = async (tx: Prisma.TransactionClient, snapshot: Snapshot) => {
      const sale = await tx.sale.create({ data: { sellerId: baseline.sellerId, branchId: baseline.branchId } });
      return tx.saleItem.create({
        data: {
          saleId: sale.id, variantId: baseline.variantId, productId: baseline.productId, productName: 'P', variantName: 'V', sku: 'S',
          quantity: 1n, unitPrice: 120n, subtotal: 120n, ...snapshot,
        },
      });
    };

    it('P14 a legacy item with all four snapshot fields NULL is accepted', async () => {
      const row = await expectAllowed((tx) => insertItem(tx, {}));
      expect([row.priceBaseType, row.priceMode, row.baseUnitPrice, row.priceAdjustmentBps]).toEqual([null, null, null, null]);
    });
    it('P15 a complete valid snapshot is accepted (bps 0 and 10000 included)', async () => {
      const row = await expectAllowed((tx) => insertItem(tx, complete));
      expect(row.priceMode).toBe('CREDIT_CARD');
      await expectAllowed((tx) => insertItem(tx, { ...complete, priceAdjustmentBps: 0 }));
      await expectAllowed((tx) => insertItem(tx, { ...complete, priceAdjustmentBps: 10000 }));
    });
    const partial: Array<[string, Snapshot]> = [
      ['only priceBaseType', { priceBaseType: 'LIST' }],
      ['only priceMode', { priceMode: 'CASH' }],
      ['only baseUnitPrice', { baseUnitPrice: 100n }],
      ['only priceAdjustmentBps', { priceAdjustmentBps: 0 }],
      ['complete but without priceMode', { ...complete, priceMode: null }],
      ['complete but without priceAdjustmentBps', { ...complete, priceAdjustmentBps: null }],
      ['complete with baseUnitPrice = 0', { ...complete, baseUnitPrice: 0n }],
      ['complete with priceAdjustmentBps = -1', { ...complete, priceAdjustmentBps: -1 }],
      ['complete with priceAdjustmentBps = 10001', { ...complete, priceAdjustmentBps: 10001 }],
    ];
    for (const [label, snapshot] of partial) {
      it(`P16 ${label} is rejected by ${CONSISTENCY}`, async () => {
        await expectDenied(CONSISTENCY, (tx) => insertItem(tx, snapshot));
      });
    }
  });

  describe('Sale.priceMode default', () => {
    it('P17 a Sale created through Prisma with priceMode omitted is CASH', async () => {
      const sale = await expectAllowed((tx) => tx.sale.create({ data: { sellerId: baseline.sellerId, branchId: baseline.branchId } }));
      expect(sale.priceMode).toBe('CASH');
      expect(sale.pricingMode).toBe('LIST');
    });
    it('P17b a Sale inserted by raw SQL omitting priceMode gets the DATABASE default CASH', async () => {
      const mode = await expectAllowed(async (tx) => {
        const id = `pv2-default-${process.pid}`;
        await tx.$executeRaw`INSERT INTO "Sale" (id, "sellerId", "branchId", "updatedAt") VALUES (${id}, ${baseline.sellerId}, ${baseline.branchId}, now())`;
        const rows = await tx.$queryRaw<Array<{ priceMode: string }>>`SELECT "priceMode"::text AS "priceMode" FROM "Sale" WHERE id = ${id}`;
        return rows[0]?.priceMode;
      });
      expect(mode).toBe('CASH');
    });
  });
});
