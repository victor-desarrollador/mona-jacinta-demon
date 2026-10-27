// Sale exchange v1 — end-to-end validation on the SYNTHETIC multi-branch fixture (api/scripts/sale-exchange-local-test-fixture.ts) with the REAL
// service, the REAL authorization context built from the database roles, and the REAL database guards, on the disposable LOCAL_TEST.
//
// The scenarios share one fixture and run in file order (some build on the state the previous ones left, as a business day does); every test names
// the fixture sale it consumes. Nothing here uses PILOT, DEV or real data: the fixture loader refuses to write unless the connected database is
// provably the disposable LOCAL_TEST. The suite deletes only what it created outside the truncated tables (the LOCALTEST- locations).
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';
import { createSaleExchangeService } from '../../src/modules/sales/sale-exchange.service.js';
import { createSaleVoidService } from '../../src/modules/sales/sale-void.service.js';
import {
  BRANCH_KEYS, FIXTURE_BRANCHES, FIXTURE_USERS, PRICE, USER_KEYS, loadSaleExchangeLocalTestFixture, removeSaleExchangeLocalTestLocations,
  type FixtureManifest, type UserKey, type VariantKey, type SaleKey,
} from '../../scripts/sale-exchange-local-test-fixture.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';

const CHECK = '23514';
function sqlState(error: unknown): string {
  const e = error as { code?: string; message?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } }; cause?: { originalCode?: string } };
  const original = e.meta?.driverAdapterError?.cause?.originalCode ?? e.cause?.originalCode ?? e.meta?.code;
  if (typeof original === 'string' && /^[0-9A-Z]{5}$/.test(original)) return original;
  const fromMessage = /\b(2[0-9]{4})\b/.exec(e.message ?? '');
  return fromMessage ? fromMessage[1]! : `UNKNOWN(${e.code ?? 'no-code'})`;
}

describe('sale exchange on the synthetic multi-branch LOCAL_TEST fixture (PostgreSQL)', () => {
  let db: PrismaClient;
  let fx: FixtureManifest;
  const req = {} as Record<UserKey, Request>;
  const service = () => createSaleExchangeService(db);
  const body = (lines: Array<{ saleItemId: string; replacementVariantId: string; returnQuantity?: bigint }>, idempotencyKey: string = randomUUID(), reason = 'Cambio de talle (TEST)') =>
    ({ reason, idempotencyKey, lines: lines.map((line) => ({ returnQuantity: 1n, ...line })) });
  const item = (sale: SaleKey, index = 0) => fx.sales[sale].itemIds[index]!;
  const variant = (key: VariantKey) => fx.variants[key];
  const swap = (who: UserKey, sale: SaleKey, to: VariantKey, quantity = 1n, key: string = randomUUID()) =>
    service().exchangeSale(req[who], fx.sales[sale].saleId, body([{ saleItemId: item(sale), replacementVariantId: variant(to), returnQuantity: quantity }], key));
  const physical = async (variantKey: VariantKey, branch: (typeof BRANCH_KEYS)[number]) => (await db.inventory.findUniqueOrThrow({ where: { id: fx.inventories[`${variantKey}@${branch}`]! } })).physical;
  const totalPhysical = async () => (await db.inventory.aggregate({ _sum: { physical: true } }))._sum.physical ?? 0n;
  const count = async (table: string) => Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${table}"`))[0]!.n);
  const rejected = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => null, (cause: unknown) => cause);
    expect(error, 'expected a refusal').toBeInstanceOf(AppError);
    return { status: (error as AppError).status, code: (error as AppError).code };
  };

  beforeAll(async () => {
    db = await createTestPrismaClient();
    await truncateAllTables(db);
    await removeSaleExchangeLocalTestLocations(db);
    await seedDemo(db);
    fx = await loadSaleExchangeLocalTestFixture(db);
    // the REAL authorization context, built from the roles / scopes / grants of the seeded catalog (the same function the API middleware uses)
    for (const key of USER_KEYS) {
      const user = await db.user.findUniqueOrThrow({
        where: { id: FIXTURE_USERS[key].id },
        include: { branchRoles: { include: { role: true } }, roleScopes: { include: { role: { include: { permissions: { include: { permission: true } } } } } } },
      });
      const auth = await buildAuthorizationContext(db, user as never);
      req[key] = { auth } as unknown as Request;
    }
  }, 300000);
  afterAll(async () => {
    await db?.$disconnect();
  }, 120000);

  it('FX00 the fixture: six DISTINCT branch/location pairs, all synthetic, with the intended topology (counts printed for the report)', async () => {
    const branches = await db.branch.findMany({ where: { code: { startsWith: 'LOCALTEST-' } }, orderBy: { code: 'asc' } });
    expect(branches.map((b) => b.code)).toEqual(['LOCALTEST-DEP', 'LOCALTEST-S1', 'LOCALTEST-S2', 'LOCALTEST-S3', 'LOCALTEST-S4', 'LOCALTEST-S5']);
    expect(new Set(branches.map((b) => b.id)).size).toBe(6);
    const locations = await db.location.findMany({ where: { code: { startsWith: 'LOCALTEST-' } } });
    expect(locations.map((l) => l.id).sort()).toEqual(branches.map((b) => b.id).sort());
    expect(locations.find((l) => l.code === 'LOCALTEST-DEP')!.type).toBe('CENTRAL_WAREHOUSE');
    expect(locations.filter((l) => l.type === 'RETAIL_BRANCH')).toHaveLength(5);
    expect(await db.user.count({ where: { email: { endsWith: '@localtest.invalid' } } })).toBe(6);
    expect(await count('CashMovement')).toBe(0); expect(await count('SalePayment')).toBe(0); expect(await count('CashSession')).toBe(0);
    const printable = Object.fromEntries(BRANCH_KEYS.map((k) => [k, { ...fx.counts.perBranch[k], physicalUnits: String(fx.counts.perBranch[k].physicalUnits), reservedUnits: String(fx.counts.perBranch[k].reservedUnits) }]));
    console.log('FIXTURE_COUNTS', JSON.stringify({ ...fx.counts, perBranch: printable }, (_k, v) => (typeof v === 'bigint' ? String(v) : v)));
    expect(fx.counts.sales).toBe(18); expect(fx.counts.variants).toBe(12);
    expect(fx.counts.perBranch.DEP.sales).toBe(0); // the warehouse sells nothing
    expect(fx.counts.perBranch.DEP.inventoryRows).toBeGreaterThan(5);
    expect(fx.counts.perBranch.S1.reservedUnits).toBe(6n); // ST_RES 5 (PENDING) + A_M 1 (PAID)
    // the auth contexts really differ: both ADMIN hold SALE_EXCHANGE, only one of them company-wide
    const admin = req.ADMIN_COMPANY.auth!.assignments[0]!;
    expect(admin).toMatchObject({ roleCode: 'ADMIN', scopeKind: 'COMPANY' });
    expect(admin.permissions).toContain('SALE_EXCHANGE');
    expect(req.ADMIN_LOCATION.auth!.assignments[0]).toMatchObject({ roleCode: 'ADMIN', scopeKind: 'LOCATION' });
    for (const role of ['CASHIER', 'SELLER', 'WAREHOUSE'] as const) expect(req[role].auth!.assignments[0]!.permissions).not.toContain('SALE_EXCHANGE');
  });

  const X0: { total: bigint } = { total: 0n };

  it('FX01 EQUAL PRICE (A M -> A L, OWNER): stock moves in the SALE\'s branch only; no other branch, no warehouse, no money', async () => {
    X0.total = await totalPhysical();
    const before = { m1: await physical('A_M', 'S1'), l1: await physical('A_L', 'S1'), m2: await physical('A_M', 'S2'), l2: await physical('A_L', 'S2'), dm: await physical('A_M', 'DEP'), dl: await physical('A_L', 'DEP') };
    const result = await swap('OWNER', 'EXCH_OK', 'A_L');
    expect(result).toMatchObject({ replayed: false, branchId: FIXTURE_BRANCHES.S1.id });
    expect(result.lines[0]).toMatchObject({ originalUnitPrice: PRICE, replacementUnitPrice: PRICE, returnQuantity: 1n });
    expect(await physical('A_M', 'S1')).toBe(before.m1 + 1n);
    expect(await physical('A_L', 'S1')).toBe(before.l1 - 1n);
    expect([await physical('A_M', 'S2'), await physical('A_L', 'S2'), await physical('A_M', 'DEP'), await physical('A_L', 'DEP')]).toEqual([before.m2, before.l2, before.dm, before.dl]);
    expect(await count('CashMovement')).toBe(0);
    expect((await db.sale.findUniqueOrThrow({ where: { id: fx.sales.EXCH_OK.saleId } })).status).toBe('COMPLETED');
  });

  it('FX02 PARTIAL exchanges: 1 + 1 of 2 are fine, the third unit is refused, the stock of the refused request is untouched', async () => {
    await swap('OWNER', 'EXCH_PARTIAL', 'A_L', 1n);
    await swap('OWNER', 'EXCH_PARTIAL', 'A_L', 1n);
    const l = await physical('A_L', 'S1'); const m = await physical('A_M', 'S1');
    expect(await rejected(swap('OWNER', 'EXCH_PARTIAL', 'A_L', 1n))).toEqual({ status: 409, code: 'EXCHANGE_QUANTITY_EXCEEDED' });
    expect([await physical('A_L', 'S1'), await physical('A_M', 'S1')]).toEqual([l, m]);
    const total = await db.$queryRaw<{ s: bigint }[]>`SELECT sum("returnQuantity")::bigint AS s FROM "SaleExchangeLine" WHERE "saleItemId" = ${item('EXCH_PARTIAL')}`;
    expect(total[0]!.s).toBe(2n);
  });

  it('FX03 DEARER, CHEAPER, INACTIVE, UNKNOWN and NO-OP replacements are refused with nothing written (GENERAL sale)', async () => {
    const snapshot = async () => ({ ex: await count('SaleExchange'), mv: await count('StockMovement'), inv: await totalPhysical(), au: await count('AuditLog') });
    const before = await snapshot();
    expect(await rejected(swap('OWNER', 'GENERAL', 'A_XL'))).toEqual({ status: 409, code: 'REPLACEMENT_MORE_EXPENSIVE_NOT_SUPPORTED' });
    expect(await rejected(swap('OWNER', 'GENERAL', 'A_S'))).toEqual({ status: 409, code: 'REPLACEMENT_CHEAPER_NOT_SUPPORTED' });
    expect(await rejected(swap('OWNER', 'GENERAL', 'A_OFF'))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await rejected(service().exchangeSale(req.OWNER, fx.sales.GENERAL.saleId, body([{ saleItemId: item('GENERAL'), replacementVariantId: randomUUID() }])))).toEqual({ status: 404, code: 'NOT_FOUND' });
    expect(await rejected(swap('OWNER', 'GENERAL', 'A_M'))).toEqual({ status: 409, code: 'NO_OP_EXCHANGE' });
    expect(await rejected(swap('OWNER', 'GENERAL', 'A_L', 2n))).toEqual({ status: 409, code: 'EXCHANGE_QUANTITY_EXCEEDED' });
    expect(await snapshot()).toEqual(before);
  });

  it('FX04 WHOLESALE: the replacement is priced from ITS wholesale price (8 000, never the retail 10 000); a variant WITHOUT wholesale price is refused', async () => {
    const sale = fx.sales.WHOLESALE;
    expect(await rejected(service().exchangeSale(req.OWNER, sale.saleId, body([{ saleItemId: sale.itemIds[0]!, replacementVariantId: variant('W_XL') }])))).toEqual({ status: 409, code: 'WHOLESALE_PRICE_MISSING' });
    const ok = await service().exchangeSale(req.OWNER, sale.saleId, body([{ saleItemId: sale.itemIds[0]!, replacementVariantId: variant('W_L') }]));
    expect(ok.lines[0]).toMatchObject({ originalUnitPrice: 8_000n, replacementUnitPrice: 8_000n });
    expect(await physical('W_M', 'S1')).toBe(29n); // 30 - 2 sold + 1 returned
    expect(await physical('W_L', 'S1')).toBe(29n); // 30 - 1 delivered
  });

  it('FX05 STOCK (S1): the LAST unit is enough, NONE is refused, physical > 0 but fully RESERVED is refused (available = physical - reserved)', async () => {
    // last unit: two concurrent requests for it (different keys): exactly one wins, the loser is refused, stock ends at exactly 0 (never negative)
    const attempt = (key: string) => swap('OWNER', 'STOCK_LAST', 'ST_LAST', 1n, key).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
    const [a, b] = await Promise.all([attempt(randomUUID()), attempt(randomUUID())]);
    expect([a, b].filter((r) => r.ok)).toHaveLength(1);
    expect(([a, b].find((r) => !r.ok) as { error: AppError }).error.code).toBe('EXCHANGE_QUANTITY_EXCEEDED');
    expect(await physical('ST_LAST', 'S1')).toBe(0n);
    expect(await rejected(swap('OWNER', 'STOCK_NONE', 'ST_NONE'))).toEqual({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(await rejected(swap('OWNER', 'STOCK_RESERVED', 'ST_RES'))).toEqual({ status: 409, code: 'INSUFFICIENT_STOCK' });
    const reserved = await db.inventory.findUniqueOrThrow({ where: { id: fx.inventories['ST_RES@S1']! } });
    expect([reserved.physical, reserved.reserved]).toEqual([5n, 5n]);
    expect(await physical('ST_NONE', 'S1')).toBe(0n);
  });

  it('FX06 BRANCH ISOLATION: a sale of S2 moves S2\'s inventory; a replacement that exists only in the warehouse or in another branch is NOT available (S5 has no A L row)', async () => {
    const before = { s1: await physical('A_L', 'S1'), dep: await physical('A_L', 'DEP'), s2m: await physical('A_M', 'S2'), s2l: await physical('A_L', 'S2') };
    await swap('OWNER', 'S2_COMPLETED', 'A_L');
    expect([await physical('A_M', 'S2'), await physical('A_L', 'S2')]).toEqual([before.s2m + 1n, before.s2l - 1n]);
    expect([await physical('A_L', 'S1'), await physical('A_L', 'DEP')]).toEqual([before.s1, before.dep]);
    const depTotal = await totalPhysicalOf('DEP');
    expect(await rejected(swap('OWNER', 'S5_COMPLETED', 'A_L'))).toEqual({ status: 409, code: 'INSUFFICIENT_STOCK' }); // A_L exists in S1/S2/S3/DEP, never in S5
    expect(await totalPhysicalOf('DEP')).toBe(depTotal);
  });

  async function totalPhysicalOf(branch: (typeof BRANCH_KEYS)[number]) {
    return (await db.inventory.aggregate({ where: { branchId: FIXTURE_BRANCHES[branch].id }, _sum: { physical: true } }))._sum.physical ?? 0n;
  }

  it('FX07 the SAME variant has different stock per branch: S4 uses ITS 3 units (not the warehouse 3 000, not S3\'s 300)', async () => {
    const before = { s4: await physical('ST_MULTI', 'S4'), s3: await physical('ST_MULTI', 'S3'), dep: await physical('ST_MULTI', 'DEP') };
    await swap('OWNER', 'S4_COMPLETED', 'ST_MULTI');
    expect([await physical('ST_MULTI', 'S4'), await physical('ST_MULTI', 'S3'), await physical('ST_MULTI', 'DEP')]).toEqual([before.s4 - 1n, before.s3, before.dep]);
    // S5 holds 0 of it: the same request in S5 is refused although 3 300+ units exist elsewhere
    expect(await rejected(swap('OWNER', 'S5_COMPLETED', 'ST_MULTI'))).toEqual({ status: 409, code: 'INSUFFICIENT_STOCK' });
  });

  it('FX08 only OWNER and a COMPANY ADMIN holding SALE_EXCHANGE may exchange; LOCATION ADMIN, CASHIER, SELLER and WAREHOUSE are 403 with nothing written', async () => {
    const before = { ex: await count('SaleExchange'), inv: await totalPhysical() };
    for (const who of ['ADMIN_LOCATION', 'CASHIER', 'SELLER', 'WAREHOUSE'] as const) {
      expect(await rejected(swap(who, 'GENERAL', 'A_L')), who).toEqual({ status: 403, code: 'FORBIDDEN' });
    }
    expect({ ex: await count('SaleExchange'), inv: await totalPhysical() }).toEqual(before);
    const result = await swap('ADMIN_COMPANY', 'S3_COMPLETED', 'ST_MULTI');
    expect(result.replayed).toBe(false);
    expect(await db.stockMovement.count({ where: { saleExchangeId: result.exchangeId, userId: FIXTURE_USERS.ADMIN_COMPANY.id } })).toBe(2);
  });

  it('FX09 every sale state but COMPLETED is refused with INVALID_SALE_STATE (DRAFT, PENDING_PAYMENT, PAID, CANCELLED), nothing written', async () => {
    const before = { ex: await count('SaleExchange'), inv: await totalPhysical() };
    for (const sale of ['DRAFT', 'PENDING_PAYMENT', 'PAID', 'CANCELLED'] as const) {
      expect(await rejected(swap('OWNER', sale, 'A_L')), sale).toEqual({ status: 409, code: 'INVALID_SALE_STATE' });
    }
    expect({ ex: await count('SaleExchange'), inv: await totalPhysical() }).toEqual(before);
  });

  it('FX10 IDEMPOTENCY on the real database: the same key replays the stored answer (no new rows, stock untouched), another intent with the key is a conflict', async () => {
    const key = randomUUID();
    const first = await swap('OWNER', 'GENERAL', 'A_L', 1n, key);
    const stock = await totalPhysical(); const exchanges = await count('SaleExchange'); const movements = await count('StockMovement'); const audits = await count('AuditLog');
    const replay = await swap('OWNER', 'GENERAL', 'A_L', 1n, key);
    expect(replay).toEqual({ ...first, replayed: true, inventories: [] });
    expect([await totalPhysical(), await count('SaleExchange'), await count('StockMovement'), await count('AuditLog')]).toEqual([stock, exchanges, movements, audits]);
    // the key has ONE spelling: the same UUID in upper case is the same request
    expect(await swap('OWNER', 'GENERAL', 'A_L', 1n, key.toUpperCase())).toEqual({ ...first, replayed: true, inventories: [] });
    expect(await rejected(swap('OWNER', 'GENERAL', 'ST_MULTI', 1n, key))).toEqual({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD' });
    expect([await totalPhysical(), await count('SaleExchange'), await count('StockMovement')]).toEqual([stock, exchanges, movements]);
  });

  it('FX11 STOCK CONSERVATION: after all those exchanges the total physical units differ from the start by exactly the units the SALES consumed after FX01 (none): exchanges are +N / -N', async () => {
    expect(await totalPhysical()).toBe(X0.total);
    const bad = await db.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Inventory" WHERE physical < 0 OR reserved < 0 OR reserved > physical`;
    expect(Number(bad[0]!.n)).toBe(0);
    const unbalanced = await db.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "SaleExchangeLine" l
      WHERE (SELECT coalesce(sum("quantityDelta"), 0) FROM "StockMovement" m WHERE m."saleExchangeLineId" = l.id) <> 0
         OR (SELECT count(*) FROM "StockMovement" m WHERE m."saleExchangeLineId" = l.id) <> 2`;
    expect(Number(unbalanced[0]!.n)).toBe(0);
    expect(await count('CashMovement')).toBe(0); expect(await count('SalePayment')).toBe(0);
    const audits = await db.auditLog.count({ where: { action: 'SALE_EXCHANGED' } });
    expect(audits).toBe(await count('SaleExchange'));
  });

  it('FX12 VOID <-> EXCHANGE: an exchanged sale cannot be voided (service AND direct SQL); a plain sale voids normally; a voided sale cannot be exchanged (service AND direct SQL)', async () => {
    // exchanged -> void blocked
    await swap('OWNER', 'EXCH_THEN_VOID', 'A_L');
    expect(await rejected(createSaleVoidService(db).voidSale(req.OWNER, fx.sales.EXCH_THEN_VOID.saleId, { reason: 'error', idempotencyKey: randomUUID() }))).toEqual({ status: 409, code: 'SALE_HAS_EXCHANGES' });
    const direct = fx.sales.EXCH_THEN_VOID.saleId;
    const insertVoid = (saleId: string, branchId: string) => db.$executeRaw`INSERT INTO "SaleVoid"(id, "saleId", "branchId", "previousStatus", reason, "idempotencyKey", "voidedById")
      VALUES (${randomUUID()}, ${saleId}, ${branchId}, 'COMPLETED', 'x', ${randomUUID()}, ${FIXTURE_USERS.OWNER.id})`;
    const sqlError = await insertVoid(direct, FIXTURE_BRANCHES.S1.id).then(() => null, (e: unknown) => e);
    expect(sqlState(sqlError)).toBe(CHECK);
    expect(String((sqlError as Error).message)).toContain('chk_sale_void_has_exchanges');
    // plain sale: the void works as always and returns the stock
    const plainBefore = await physical('A_M', 'S1');
    const voided = await createSaleVoidService(db).voidSale(req.OWNER, fx.sales.VOID_PLAIN.saleId, { reason: 'error de carga (TEST)', idempotencyKey: randomUUID() });
    expect(voided).toMatchObject({ status: 'CANCELLED', previousStatus: 'COMPLETED', replayed: false });
    expect(await physical('A_M', 'S1')).toBe(plainBefore + 1n);
    // voided -> exchange blocked, through the service (state) ...
    await createSaleVoidService(db).voidSale(req.OWNER, fx.sales.VOID_THEN_EXCH.saleId, { reason: 'error (TEST)', idempotencyKey: randomUUID() });
    expect(await rejected(swap('OWNER', 'VOID_THEN_EXCH', 'A_L'))).toEqual({ status: 409, code: 'INVALID_SALE_STATE' });
    // ... and by direct SQL even when the sale was NOT cancelled (the pure G19 guard): a void row on a still-COMPLETED sale blocks a raw exchange header
    const s5 = fx.sales.S5_COMPLETED;
    await insertVoid(s5.saleId, FIXTURE_BRANCHES.S5.id);
    expect((await db.sale.findUniqueOrThrow({ where: { id: s5.saleId } })).status).toBe('COMPLETED');
    const raw = await db.$executeRaw`INSERT INTO "SaleExchange"(id, "saleId", "branchId", "createdById", reason, "idempotencyKey", "requestHash")
      VALUES (${randomUUID()}, ${s5.saleId}, ${FIXTURE_BRANCHES.S5.id}, ${FIXTURE_USERS.OWNER.id}, 'x', ${randomUUID()}, ${'a'.repeat(64)})`.then(() => null, (e: unknown) => e);
    expect(sqlState(raw)).toBe(CHECK);
    // since G20 the claim trigger (trg_sale_exchange_post_sale_claim) fires before the G19 guard, so either guard may be the one that names the refusal
    expect(String((raw as Error).message)).toMatch(/chk_sale_(exchange_has_void|post_sale_guard)/);
  });

  it('FX13 the history is append-only and the exclusion is symmetric at the database', async () => {
    const exchange = await db.saleExchange.findFirstOrThrow({ where: { saleId: fx.sales.EXCH_OK.saleId } });
    const update = await db.$executeRaw`UPDATE "SaleExchange" SET reason = 'otro' WHERE id = ${exchange.id}`.then(() => null, (e: unknown) => e);
    expect(sqlState(update)).toBe(CHECK);
    const del = await db.$executeRaw`DELETE FROM "SaleExchangeLine" WHERE "saleExchangeId" = ${exchange.id}`.then(() => null, (e: unknown) => e);
    expect(sqlState(del)).toBe(CHECK);
    const mv = await db.$executeRaw`DELETE FROM "StockMovement" WHERE "saleExchangeId" = ${exchange.id}`.then(() => null, (e: unknown) => e);
    expect(sqlState(mv)).toBe(CHECK);
  });
});
