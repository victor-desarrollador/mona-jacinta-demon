// Block 1 — list pricing authority + sale-scoped wholesale authorization.
//
// DB-FREE: the REAL sales / payments / pending-correction / catalog-admin
// services run against tests/helpers/in-memory-sales-db.ts; no query ever
// reaches a database and no globalSetup/setup DB guard is needed. One
// exception, isolated in the "management pricing read" group: its dynamic
// import of the variants router loads config/prisma.ts, which CONSTRUCTS
// (never queries) a default PrismaClient on the synthetic DATABASE_URL.
// Run hermetically: no-setup Vitest config, synthetic *.invalid env and a
// network namespace with loopback only (see the Block 1 report).
//
// PRE-REGISTERED EXPECTATIONS (written before the implementation existed):
//   W01 ordinary item -> unitPrice = ProductVariant.price (Sale LIST)
//   W02 client price/priceType fields on add-item -> rejected (400, strict)
//   W03 valid code -> only that sale becomes WHOLESALE, its items repriced
//   W04 wrong code -> 403 WHOLESALE_CODE_INVALID, sale + audit unchanged
//   W05 blank / whitespace code -> 400, sale unchanged
//   W06 raw code absent from returned sale and every persisted row
//   W07 another sale of the same seller stays LIST (no inheritance)
//   W08 item without wholesalePrice -> 409 WHOLESALE_PRICE_MISSING, no change
//   W09 WHOLESALE unconfirmed -> payment 409, completion 409, no payment row
//   W10 cashier confirmation -> payment accepted -> completion succeeds
//   W11 seller cannot confirm (403); seller who is also cashier: 403 self
//   W12 cashier of another location -> 403, nothing recorded
//   W13 LIST sale pays and completes with no confirmation
//   W14 catalog list price change -> existing item snapshot unchanged
//   W15 catalog wholesale price change -> existing wholesale item unchanged
//   W16 client cannot pick WHOLESALE via create-sale / add-item payloads
//   W17 normalization: outer whitespace trimmed; case + inner chars exact
//   W18 confirmation replay -> idempotent, one audit row, first actor kept
//   W19 after confirmation: seller edits 409; cashier correction reprices at
//       wholesale AND clears the confirmation (reconfirm required)
//   W20 raw code never reaches logger calls or audit payloads
//   A01 activation on a PENDING_PAYMENT sale -> 409 SALE_NOT_DRAFT
//   A02 another seller's draft, valid code -> 403
//   A03 WAREHOUSE user, valid code -> 403
//   A04 no hash configured -> 503 WHOLESALE_NOT_CONFIGURED for any code
//   A05 verifier with a malformed hash -> false, never throws
//   A06 bcrypt 72-byte truncation: valid 72-byte code + suffix -> 400
//   A07 re-activation: valid code idempotent (no 2nd audit), wrong code 403
//   A08 one of two items lacks wholesalePrice -> neither repriced (atomic)
//   A09 quantity change on a WHOLESALE item keeps the wholesale snapshot
//   A10 wholesale > list rejected (both directions); 0 / negative -> 400
//   A11 wholesale cleared with null; {} -> 400; costPrice still rejected
//   A12 (revised in the Codex fix round: SaleItem.priceType was removed, so
//       its mismatch class no longer exists) a WHOLESALE sale with only ONE
//       of the two confirmation columns set -> payment/completion 409
//   A13 confirming a LIST sale -> 409 SALE_NOT_WHOLESALE
//   A14 confirming a DRAFT wholesale sale -> 409 INVALID_SALE_STATE
//   A15 PAID+confirmed -> replay; PAID+unconfirmed (corrupt) -> 409
//   A16 queue: unconfirmed WHOLESALE -> canAcceptPayment false, confirm flag
//   A17 control characters in the code -> 400
//   A18 env: empty hash -> undefined; malformed / low-cost hash rejected
//       without echoing the value
//   A19 add of a variant without wholesalePrice to a WHOLESALE sale -> 409
//   A20 OWNER (implicit authority) cannot activate another user's sale
//   R01 HTTP: 10 wrong codes -> 403 each, 11th -> 429; other users unaffected
//   R02 HTTP: no response body (200/400/403) ever contains the code
//   R03 HTTP: WAREHOUSE blocked at /wholesale; SELLER blocked at /confirm
//   R04 HTTP: activation returns WHOLESALE sale JSON with string money
//
// Codex pre-DB fix round (2026-10-02). N01-N37 were preregistered with their
// expected outcomes BEFORE the fix-round edits (see the fix report); the
// ones executable without a database are implemented below under the same
// ids. N01-N13 evaluate the migration's CHECK text with a restricted SQL
// evaluator (three-valued logic) — static semantics, not PostgreSQL.
import { randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import express, { type Request } from 'express';
import supertest from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { AppError } from '../src/shared/errors.js';
import { logger } from '../src/shared/logger.js';
import { DEFAULT_ROLE_GRANTS } from '../src/modules/rbac/role-permission-matrix.js';
import { createSalesService } from '../src/modules/sales/sales.service.js';
import { createSalesRouter } from '../src/modules/sales/sales.routes.js';
import { errorHandler } from '../src/middleware/errorHandler.js';
import { createPaymentsService } from '../src/modules/payments/payments.service.js';
import { createPendingCorrectionService } from '../src/modules/sales/pending-correction.service.js';
import { createCatalogAdminService } from '../src/modules/products/catalog-admin.service.js';
import { addSaleItemDto } from '../src/modules/sales/dto/sale-item.dto.js';
import { activateWholesaleDto, createDraftSaleDto } from '../src/modules/sales/dto/sale.dto.js';
import { createVariantSchema, updateVariantPriceSchema } from '../src/modules/products/dto/variant.dto.js';
import {
  createWholesaleCodeVerifier,
  normalizeWholesaleCode,
} from '../src/modules/sales/wholesale-authorization.service.js';
import { buildAuthorizationContext } from '../src/modules/rbac/authorization-context.js';
import { getProduct, getVariant, listProducts, listVariants } from '../src/modules/products/products.service.js';
import { readdirSync, readFileSync } from 'node:fs';
import { createInMemorySalesDb, type Row } from './helpers/in-memory-sales-db.js';

const CODE = 'Mayor-2026';
// Low bcrypt cost keeps the suite fast; the verifier accepts any valid hash
// (the env schema separately enforces a production minimum cost).
const CODE_HASH = await hash(CODE, 4);
const LONG_CODE = 'L'.repeat(72);
const LONG_CODE_HASH = await hash(LONG_CODE, 4);

type Role = 'SELLER' | 'CASHIER' | 'WAREHOUSE' | 'ADMIN';

function assignment(role: Role | 'OWNER', locationId: string | null): Express.ProductionAssignment {
  return {
    roleId: role, roleCode: role,
    scopeKind: locationId ? 'LOCATION' : 'COMPANY', locationId,
    permissions: role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[role]],
  };
}

function requestFor(userId: string, assignments: Express.ProductionAssignment[]): Request {
  const effectiveLocationIds = assignments.flatMap(({ locationId }) => (locationId ? [locationId] : []));
  return { auth: { userId, roles: assignments.map(({ roleCode }) => roleCode), assignments, effectiveLocationIds } } as unknown as Request;
}

function setup(options: { codeHash?: string | null } = {}) {
  const db = createInMemorySalesDb();
  db.insert('company', { name: 'Mona Jacinta', cuit: '00000000000', address: 'Demo', isActive: true, createdAt: new Date() });
  const L1 = db.insert('location', { isActive: true }).id as string;
  const L2 = db.insert('location', { isActive: true }).id as string;
  db.insert('branch', { id: L1, code: 'S1', name: 'Sucursal 1' });
  db.insert('branch', { id: L2, code: 'S2', name: 'Sucursal 2' });
  db.insert('saleNumberCounter', { branchId: L1, nextValue: 1n });
  db.insert('saleNumberCounter', { branchId: L2, nextValue: 1n });
  const user = (name: string) => db.insert('user', { name, email: `${name}@test.invalid`, isActive: true }).id as string;
  const ids = {
    seller: user('seller'), seller2: user('seller2'), cashier: user('cashier'), cashier2: user('cashier2'),
    warehouse: user('warehouse'), sellerCashier: user('sellerCashier'), owner: user('owner'),
  };
  const product = db.insert('product', { name: 'Remera', isActive: true }).id as string;
  const variant = (sku: string, price: bigint, wholesalePrice: bigint | null) =>
    db.insert('productVariant', { productId: product, sku, barcode: sku, cashPrice: price, price, wholesalePrice, costPrice: 1000n, color: 'Negro', size: sku }).id as string;
  const V1 = variant('V1', 10000n, 7000n);
  const V2 = variant('V2', 5000n, null);
  const V3 = variant('V3', 8000n, 6000n);
  for (const branchId of [L1, L2]) {
    for (const variantId of [V1, V2, V3]) db.insert('inventory', { branchId, variantId, physical: 100n, reserved: 0n });
    const registerId = db.insert('cashRegister', { branchId, name: `Caja ${branchId}` }).id as string;
    db.insert('cashSession', { registerId, openedById: ids.cashier, startingCash: 0n, status: 'OPEN' });
  }
  const reqs = {
    seller: requestFor(ids.seller, [assignment('SELLER', L1)]),
    seller2: requestFor(ids.seller2, [assignment('SELLER', L1)]),
    cashier: requestFor(ids.cashier, [assignment('CASHIER', L1)]),
    cashier2: requestFor(ids.cashier2, [assignment('CASHIER', L2)]),
    warehouse: requestFor(ids.warehouse, [assignment('WAREHOUSE', L1)]),
    sellerCashier: requestFor(ids.sellerCashier, [assignment('SELLER', L1), assignment('CASHIER', L1)]),
    owner: requestFor(ids.owner, [assignment('OWNER', null)]),
  };
  const codeHash = options.codeHash === null ? undefined : (options.codeHash ?? CODE_HASH);
  const client = db.client as unknown as PrismaClient;
  const sales = createSalesService(client, { wholesaleVerifier: createWholesaleCodeVerifier(codeHash) });
  const payments = createPaymentsService(client);
  const correction = createPendingCorrectionService(client);
  const catalog = createCatalogAdminService(client);

  async function draft(sellerKey: 'seller' | 'seller2' | 'sellerCashier' = 'seller', items: Array<[string, bigint]> = [[V1, 2n]]) {
    const created = await sales.createDraftSale(reqs[sellerKey], ids[sellerKey], L1);
    for (const [variantId, quantity] of items) await sales.addItem(reqs[sellerKey], ids[sellerKey], created.id, { variantId, quantity });
    // Pilot Pricing V2: new sales default to CASH (single payment method). These
    // Block 1 suites exercise wholesale and payment-history rules with MIXED
    // payment methods, which only an explicit LIST price mode allows; the CASH
    // default itself is covered in tests/pricing/.
    await sales.updatePriceMode(reqs[sellerKey], ids[sellerKey], created.id, 'LIST');
    return created.id;
  }
  async function send(saleId: string, sellerKey: 'seller' | 'seller2' | 'sellerCashier' = 'seller') {
    return sales.sendToCashier(saleId, ids[sellerKey], [L1]);
  }
  async function pay(saleId: string, req: Request = reqs.cashier, userId = ids.cashier) {
    const sale = db.table('sale').find((row) => row.id === saleId)!;
    return payments.registerPayment(req, userId, saleId, {
      method: 'CASH', amount: sale.total as bigint, receivedAmount: sale.total as bigint, idempotencyKey: randomUUID(),
    });
  }
  const sale = (saleId: string) => db.table('sale').find((row) => row.id === saleId)!;
  const items = (saleId: string) => db.table('saleItem').filter((row) => row.saleId === saleId);
  const audits = (action: string) => db.table('auditLog').filter((row) => row.action === action);
  return { db, L1, L2, ids, reqs, V1, V2, V3, sales, payments, correction, catalog, draft, send, pay, sale, items, audits };
}

async function expectAppError(promise: Promise<unknown>, status: number, code: string) {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected AppError ${status} ${code}`).toBeInstanceOf(AppError);
  expect({ status: (error as AppError).status, code: (error as AppError).code }).toEqual({ status, code });
}

function serialize(value: unknown) {
  return JSON.stringify(value, (_key, inner: unknown) => (typeof inner === 'bigint' ? inner.toString() : inner));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Block 1 — list price authority', () => {
  it('W01 ordinary sale item snapshots the authoritative list price', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 2n]]);
    const [item] = t.items(saleId);
    expect(item).toMatchObject({ unitPrice: 10000n, subtotal: 20000n });
    // N35: the line carries no price-mode copy; Sale.pricingMode is the fact.
    expect(item).not.toHaveProperty('priceType');
    expect(t.sale(saleId)).toMatchObject({ pricingMode: 'LIST', total: 20000n });
  });

  it('W02 client-supplied price fields on add-item are rejected by the strict DTO', () => {
    const variantId = randomUUID();
    // N32 included: wholesalePrice / pricingMode injection.
    for (const extra of [
      { unitPrice: '1' }, { price: '1' }, { priceType: 'WHOLESALE' }, { subtotal: '1' },
      { wholesalePrice: '1' }, { pricingMode: 'WHOLESALE' },
    ]) {
      expect(addSaleItemDto.safeParse({ variantId, quantity: '1', ...extra }).success).toBe(false);
    }
    expect(addSaleItemDto.safeParse({ variantId, quantity: '1' }).success).toBe(true);
  });

  it('W16 client cannot select WHOLESALE through create-sale or add-item payloads', () => {
    expect(createDraftSaleDto.safeParse({ pricingMode: 'WHOLESALE' }).success).toBe(false);
    expect(createDraftSaleDto.safeParse({ wholesale: true }).success).toBe(false);
    expect(addSaleItemDto.safeParse({ variantId: randomUUID(), quantity: '1', pricingMode: 'WHOLESALE' }).success).toBe(false);
  });

  it('W14 a later catalog list-price change never mutates an existing item snapshot', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 1n]]);
    await t.catalog.updateVariantPrice(t.ids.owner, t.V1, { price: 12000n });
    expect(t.items(saleId)[0]).toMatchObject({ unitPrice: 10000n, subtotal: 10000n });
    // Adding more of the same variant keeps the original snapshot too.
    await t.sales.addItem(t.reqs.seller, t.ids.seller, saleId, { variantId: t.V1, quantity: 1n });
    expect(t.items(saleId)[0]).toMatchObject({ quantity: 2n, unitPrice: 10000n, subtotal: 20000n });
  });
});

describe('Block 1 — wholesale activation (seller, sale-scoped)', () => {
  it('W03 + W07 valid code activates WHOLESALE for the target sale only', async () => {
    const t = setup();
    const saleA = await t.draft('seller', [[t.V1, 2n], [t.V3, 1n]]);
    const saleB = await t.draft('seller', [[t.V1, 1n]]);
    const result = await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleA, CODE);
    expect(result).toMatchObject({ id: saleA, pricingMode: 'WHOLESALE', total: 20000n });
    expect(t.sale(saleA).wholesaleAuthorizedAt).toBeInstanceOf(Date);
    expect(t.items(saleA).map(({ unitPrice }) => unitPrice)).toEqual([7000n, 6000n]);
    expect(t.audits('SALE_WHOLESALE_AUTHORIZED')).toHaveLength(1);
    // W07: the seller's other sale did not inherit anything.
    expect(t.sale(saleB).pricingMode).toBe('LIST');
    await t.sales.addItem(t.reqs.seller, t.ids.seller, saleB, { variantId: t.V3, quantity: 1n });
    expect(t.items(saleB).map(({ unitPrice }) => unitPrice)).toEqual([10000n, 8000n]);
    // Items added AFTER activation to the wholesale sale use wholesale.
    await t.sales.addItem(t.reqs.seller, t.ids.seller, saleA, { variantId: t.V1, quantity: 1n });
    expect(t.items(saleA)[0]).toMatchObject({ quantity: 3n, unitPrice: 7000n, subtotal: 21000n });
  });

  it('W04 wrong code is denied and changes nothing', async () => {
    const t = setup();
    const saleId = await t.draft();
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, 'Mayor-2025'), 403, 'WHOLESALE_CODE_INVALID');
    expect(t.sale(saleId).pricingMode).toBe('LIST');
    expect(t.items(saleId)[0]).toMatchObject({ unitPrice: 10000n });
    expect(t.audits('SALE_WHOLESALE_AUTHORIZED')).toHaveLength(0);
  });

  it('W05 blank or whitespace-only code is denied', async () => {
    const t = setup();
    const saleId = await t.draft();
    expect(activateWholesaleDto.safeParse({ code: '' }).success).toBe(false);
    expect(activateWholesaleDto.safeParse({}).success).toBe(false);
    expect(activateWholesaleDto.safeParse({ code: CODE, saleId }).success).toBe(false);
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, '   '), 400, 'WHOLESALE_CODE_FORMAT');
    expect(t.sale(saleId).pricingMode).toBe('LIST');
  });

  it('W06 + W20 + N34 the raw code is never returned, persisted, audited or logged', async () => {
    const t = setup();
    const calls: unknown[] = [];
    for (const level of ['info', 'warn', 'error', 'debug', 'fatal', 'trace'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { calls.push(args); }) as never);
    }
    const WRONG = 'Wrong-Code-XYZ';
    const returned: unknown[] = [];
    const saleId = await t.draft('seller', [[t.V1, 2n]]);
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, WRONG), 403, 'WHOLESALE_CODE_INVALID');
    returned.push(await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE));
    returned.push(await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, `  ${CODE}  `)); // idempotent replay
    returned.push(await t.send(saleId));
    returned.push(await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId));
    returned.push(await t.correction.correctPendingSale(t.reqs.cashier, saleId, { items: [{ variantId: t.V1, quantity: 1n }, { variantId: t.V3, quantity: 1n }] }));
    returned.push(await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId));
    returned.push(await t.pay(saleId));
    returned.push(await t.sales.completeSale(t.reqs.cashier, t.ids.cashier, saleId));
    returned.push(await t.sales.listPendingSales([t.L1], (t.reqs.cashier as unknown as { auth: Express.AuthContext }).auth));

    // Every simulated persisted structure, checked independently: Sale (incl.
    // pricing + confirmation state), SaleItem, AuditLog, payments, holds,
    // movements and the rest — all 16 tables of the in-memory store.
    const tables = t.db.allTables();
    expect(Object.keys(tables).length).toBe(18);
    expect(t.sale(saleId)).toMatchObject({ status: 'COMPLETED', pricingMode: 'WHOLESALE', wholesaleConfirmedById: t.ids.cashier });
    expect(t.audits('SALE_WHOLESALE_AUTHORIZED')).toHaveLength(1);
    expect(t.audits('SALE_WHOLESALE_CONFIRMED')).toHaveLength(2);
    for (const [name, rows] of Object.entries(tables)) {
      const text = serialize(rows);
      expect(text, name).not.toContain(CODE);
      expect(text, name).not.toContain(WRONG);
    }
    for (const surface of [serialize(returned), serialize(calls)]) {
      expect(surface).not.toContain(CODE);
      expect(surface).not.toContain(WRONG);
    }
    // The rejected attempt is still traceable (event only, no code).
    expect(serialize(calls)).toContain('wholesale_code_rejected');
  });

  it('W08 activation fails closed when an item has no wholesale price', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V2, 1n]]);
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE), 409, 'WHOLESALE_PRICE_MISSING');
    expect(t.sale(saleId).pricingMode).toBe('LIST');
    expect(t.items(saleId)[0]).toMatchObject({ unitPrice: 5000n });
  });

  it('W17 normalization: surrounding whitespace trimmed, everything else exact', async () => {
    expect(normalizeWholesaleCode(`  ${CODE}\t`)).toBe(CODE);
    expect(normalizeWholesaleCode('')).toBeNull();
    expect(normalizeWholesaleCode('   ')).toBeNull();
    const t = setup();
    const saleId = await t.draft();
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE.toLowerCase()), 403, 'WHOLESALE_CODE_INVALID');
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, 'Mayor -2026'), 403, 'WHOLESALE_CODE_INVALID');
    const result = await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, `  ${CODE} `);
    expect(result.pricingMode).toBe('WHOLESALE');
  });

  it('A01 activation is refused once the sale left DRAFT', async () => {
    const t = setup();
    const saleId = await t.draft();
    await t.send(saleId);
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE), 409, 'SALE_NOT_DRAFT');
    expect(t.sale(saleId).pricingMode).toBe('LIST');
  });

  it('A02 + A03 + A20 only the sale\'s own seller can activate it', async () => {
    const t = setup();
    const saleId = await t.draft();
    await expectAppError(t.sales.activateWholesale(t.reqs.seller2, t.ids.seller2, saleId, CODE), 403, 'FORBIDDEN');
    await expectAppError(t.sales.activateWholesale(t.reqs.warehouse, t.ids.warehouse, saleId, CODE), 403, 'FORBIDDEN');
    await expectAppError(t.sales.activateWholesale(t.reqs.owner, t.ids.owner, saleId, CODE), 403, 'FORBIDDEN');
    expect(t.sale(saleId).pricingMode).toBe('LIST');
  });

  it('A04 no configured hash -> wholesale unavailable for every code', async () => {
    const t = setup({ codeHash: null });
    const saleId = await t.draft();
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE), 503, 'WHOLESALE_NOT_CONFIGURED');
    expect(t.sale(saleId).pricingMode).toBe('LIST');
  });

  it('A05 a malformed configured hash never verifies and never throws', async () => {
    const verifier = createWholesaleCodeVerifier('not-a-bcrypt-hash');
    await expect(verifier.verify(CODE)).resolves.toBe(false);
  });

  it('A06 bcrypt 72-byte truncation cannot be used to pass a longer code', async () => {
    const t = setup({ codeHash: LONG_CODE_HASH });
    const saleId = await t.draft();
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, `${LONG_CODE}extra`), 400, 'WHOLESALE_CODE_FORMAT');
    expect((await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, LONG_CODE)).pricingMode).toBe('WHOLESALE');
  });

  it('A07 re-activation: valid code is idempotent, wrong code still denied', async () => {
    const t = setup();
    const saleId = await t.draft();
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    expect(t.audits('SALE_WHOLESALE_AUTHORIZED')).toHaveLength(1);
    expect(t.items(saleId)[0]).toMatchObject({ unitPrice: 7000n, subtotal: 14000n });
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, 'nope-nope'), 403, 'WHOLESALE_CODE_INVALID');
  });

  it('A08 repricing is atomic: one missing wholesale price reprices nothing', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 1n], [t.V2, 1n]]);
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE), 409, 'WHOLESALE_PRICE_MISSING');
    expect(t.items(saleId).map(({ unitPrice }) => unitPrice)).toEqual([10000n, 5000n]);
    expect(t.sale(saleId)).toMatchObject({ pricingMode: 'LIST', total: 15000n, wholesaleAuthorizedAt: null });
  });

  it('A09 + W15 wholesale snapshots survive quantity edits and catalog changes', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 1n]]);
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    await t.catalog.updateVariantPrice(t.ids.owner, t.V1, { wholesalePrice: 6500n });
    const [item] = t.items(saleId);
    await t.sales.updateItem(t.reqs.seller, t.ids.seller, saleId, item!.id as string, { quantity: 3n });
    expect(t.items(saleId)[0]).toMatchObject({ unitPrice: 7000n, subtotal: 21000n });
    expect(t.sale(saleId).total).toBe(21000n);
  });

  it('A17 control characters in the code are rejected', async () => {
    const t = setup();
    const saleId = await t.draft();
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, `Mayor\u0000-2026`), 400, 'WHOLESALE_CODE_FORMAT');
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, `Mayor\u0007-2026`), 400, 'WHOLESALE_CODE_FORMAT');
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, `Mayor\n-2026`), 400, 'WHOLESALE_CODE_FORMAT');
    expect(t.sale(saleId).pricingMode).toBe('LIST');
    // An OUTER newline is surrounding whitespace: trimmed, then verified.
    expect((await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, `${CODE}\n`)).pricingMode).toBe('WHOLESALE');
  });

  it('A19 a variant without wholesale price cannot join a WHOLESALE sale', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 1n]]);
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    await expectAppError(t.sales.addItem(t.reqs.seller, t.ids.seller, saleId, { variantId: t.V2, quantity: 1n }), 409, 'WHOLESALE_PRICE_MISSING');
    expect(t.items(saleId)).toHaveLength(1);
  });
});

describe('Block 1 — cashier confirmation and finalization', () => {
  async function wholesaleSent(t: ReturnType<typeof setup>, sellerKey: 'seller' | 'sellerCashier' = 'seller') {
    const saleId = await t.draft(sellerKey, [[t.V1, 2n]]);
    await t.sales.activateWholesale(t.reqs[sellerKey], t.ids[sellerKey], saleId, CODE);
    await t.send(saleId, sellerKey);
    return saleId;
  }

  it('W09 seller authorization alone cannot take payment or complete', async () => {
    const t = setup();
    const saleId = await wholesaleSent(t);
    await expectAppError(t.pay(saleId), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
    expect(t.db.table('salePayment')).toHaveLength(0);
    expect(t.sale(saleId).status).toBe('PENDING_PAYMENT');
    // Defense in depth: even a PAID wholesale sale lacking confirmation
    // (e.g. legacy/corrupt data) cannot complete.
    t.sale(saleId).status = 'PAID';
    await expectAppError(t.sales.completeSale(t.reqs.cashier, t.ids.cashier, saleId), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
    expect(t.sale(saleId).status).toBe('PAID');
  });

  it('W10 cashier confirmation enables payment and completion at wholesale price', async () => {
    const t = setup();
    const saleId = await wholesaleSent(t);
    const confirmed = await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    expect(confirmed).toMatchObject({ saleId, pricingMode: 'WHOLESALE', wholesaleConfirmedById: t.ids.cashier, replayed: false });
    expect(t.audits('SALE_WHOLESALE_CONFIRMED')).toHaveLength(1);
    const payment = await t.pay(saleId);
    expect(payment).toMatchObject({ resultingStatus: 'PAID', replayed: false });
    expect(payment.payment.amount).toBe(14000n);
    const completed = await t.sales.completeSale(t.reqs.cashier, t.ids.cashier, saleId);
    expect(completed.status).toBe('COMPLETED');
    expect(t.items(saleId)[0]).toMatchObject({ unitPrice: 7000n });
  });

  it('W11 a seller cannot confirm; nor can the sale\'s own seller holding CASHIER', async () => {
    const t = setup();
    const saleId = await wholesaleSent(t);
    await expectAppError(t.sales.confirmWholesale(t.reqs.seller, t.ids.seller, saleId), 403, 'FORBIDDEN');
    const own = await wholesaleSent(t, 'sellerCashier');
    await expectAppError(t.sales.confirmWholesale(t.reqs.sellerCashier, t.ids.sellerCashier, own), 403, 'WHOLESALE_SELF_CONFIRMATION');
    expect(t.sale(saleId).wholesaleConfirmedAt).toBeNull();
    expect(t.sale(own).wholesaleConfirmedAt).toBeNull();
    // The same dual-role user CAN confirm somebody else's sale.
    await t.sales.confirmWholesale(t.reqs.sellerCashier, t.ids.sellerCashier, saleId);
    expect(t.sale(saleId).wholesaleConfirmedById).toBe(t.ids.sellerCashier);
  });

  it('W12 a cashier of another location cannot confirm', async () => {
    const t = setup();
    const saleId = await wholesaleSent(t);
    await expectAppError(t.sales.confirmWholesale(t.reqs.cashier2, t.ids.cashier2, saleId), 403, 'FORBIDDEN');
    expect(t.sale(saleId).wholesaleConfirmedAt).toBeNull();
    expect(t.audits('SALE_WHOLESALE_CONFIRMED')).toHaveLength(0);
  });

  it('W13 a LIST sale pays and completes with no wholesale confirmation', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 1n]]);
    await t.send(saleId);
    expect((await t.pay(saleId)).resultingStatus).toBe('PAID');
    expect((await t.sales.completeSale(t.reqs.cashier, t.ids.cashier, saleId)).status).toBe('COMPLETED');
    expect(t.audits('SALE_WHOLESALE_CONFIRMED')).toHaveLength(0);
  });

  it('W18 confirmation replay is idempotent and keeps the first confirmer', async () => {
    const t = setup();
    const saleId = await wholesaleSent(t);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    const firstAt = t.sale(saleId).wholesaleConfirmedAt;
    const again = await t.sales.confirmWholesale(t.reqs.sellerCashier, t.ids.sellerCashier, saleId);
    expect(again).toMatchObject({ replayed: true, wholesaleConfirmedById: t.ids.cashier });
    expect(t.sale(saleId).wholesaleConfirmedAt).toBe(firstAt);
    expect(t.audits('SALE_WHOLESALE_CONFIRMED')).toHaveLength(1);
  });

  it('W19 after confirmation: seller cannot edit; correction reprices and requires reconfirmation', async () => {
    const t = setup();
    const saleId = await wholesaleSent(t);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    await expectAppError(t.sales.addItem(t.reqs.seller, t.ids.seller, saleId, { variantId: t.V3, quantity: 1n }), 409, 'SALE_NOT_DRAFT');
    const corrected = await t.correction.correctPendingSale(t.reqs.cashier, saleId, {
      items: [{ variantId: t.V1, quantity: 1n }, { variantId: t.V3, quantity: 2n }],
    });
    expect(corrected.total).toBe(7000n + 12000n);
    expect(t.items(saleId).map(({ unitPrice }) => unitPrice)).toEqual([7000n, 6000n]);
    expect(t.sale(saleId)).toMatchObject({ wholesaleConfirmedAt: null, wholesaleConfirmedById: null });
    await expectAppError(t.pay(saleId), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    expect((await t.pay(saleId)).resultingStatus).toBe('PAID');
  });

  it('W19b correction of a WHOLESALE sale cannot add a variant without wholesale price', async () => {
    const t = setup();
    const saleId = await wholesaleSent(t);
    await expectAppError(t.correction.correctPendingSale(t.reqs.cashier, saleId, {
      items: [{ variantId: t.V1, quantity: 2n }, { variantId: t.V2, quantity: 1n }],
    }), 409, 'WHOLESALE_PRICE_MISSING');
    expect(t.items(saleId)).toHaveLength(1);
  });

  it('A12 a WHOLESALE sale with only one confirmation column set cannot be paid or completed', async () => {
    const t = setup();
    for (const partial of [
      { wholesaleConfirmedAt: new Date(), wholesaleConfirmedById: null },
      { wholesaleConfirmedAt: null, wholesaleConfirmedById: t.ids.cashier },
    ]) {
      const saleId = await wholesaleSent(t);
      Object.assign(t.sale(saleId), partial); // corrupt/legacy persisted state
      await expectAppError(t.pay(saleId), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
      t.sale(saleId).status = 'PAID';
      await expectAppError(t.sales.completeSale(t.reqs.cashier, t.ids.cashier, saleId), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
    }
  });

  it('A13 + A14 confirmation needs a WHOLESALE sale already sent to cashier', async () => {
    const t = setup();
    const listSale = await t.draft();
    await t.send(listSale);
    await expectAppError(t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, listSale), 409, 'SALE_NOT_WHOLESALE');
    const draftSale = await t.draft();
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, draftSale, CODE);
    await expectAppError(t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, draftSale), 409, 'INVALID_SALE_STATE');
  });

  it('A15 PAID+confirmed replays; PAID+unconfirmed is refused', async () => {
    const t = setup();
    const saleId = await wholesaleSent(t);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    await t.pay(saleId);
    expect((await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId)).replayed).toBe(true);
    const other = await wholesaleSent(t);
    t.sale(other).status = 'PAID';
    await expectAppError(t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, other), 409, 'INVALID_SALE_STATE');
  });

  it('A16 queue exposes wholesale state and blocks payment until confirmed', async () => {
    const t = setup();
    const wholesale = await wholesaleSent(t);
    const list = await t.draft();
    await t.send(list);
    const auth = (t.reqs.cashier as unknown as { auth: Express.AuthContext }).auth;
    const queue = await t.sales.listPendingSales([t.L1], auth);
    const w = queue.find(({ saleId }) => saleId === wholesale)!;
    const l = queue.find(({ saleId }) => saleId === list)!;
    expect(w).toMatchObject({ pricingMode: 'WHOLESALE', wholesaleConfirmed: false, canConfirmWholesale: true, canAcceptPayment: false });
    expect(w.items[0]).toMatchObject({ unitPrice: 7000n });
    expect(l).toMatchObject({ pricingMode: 'LIST', wholesaleConfirmed: false, canConfirmWholesale: false, canAcceptPayment: true });
    const sellerAuth = (t.reqs.seller as unknown as { auth: Express.AuthContext }).auth;
    expect((await t.sales.listPendingSales([t.L1], sellerAuth)).find(({ saleId }) => saleId === wholesale)!.canConfirmWholesale).toBe(false);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, wholesale);
    const after = (await t.sales.listPendingSales([t.L1], auth)).find(({ saleId }) => saleId === wholesale)!;
    expect(after).toMatchObject({ wholesaleConfirmed: true, canConfirmWholesale: false, canAcceptPayment: true });
  });
});

describe('Block 1 — catalog wholesale price management', () => {
  it('A10 wholesale price must be positive and never above the list price', async () => {
    const t = setup();
    await expectAppError(t.catalog.updateVariantPrice(t.ids.owner, t.V1, { wholesalePrice: 10001n }), 409, 'WHOLESALE_PRICE_ABOVE_LIST');
    await expectAppError(t.catalog.updateVariantPrice(t.ids.owner, t.V1, { price: 6999n }), 409, 'WHOLESALE_PRICE_ABOVE_LIST');
    expect(t.db.table('productVariant').find((row: Row) => row.id === t.V1)).toMatchObject({ price: 10000n, wholesalePrice: 7000n });
    expect(updateVariantPriceSchema.safeParse({ wholesalePrice: '0' }).success).toBe(false);
    expect(updateVariantPriceSchema.safeParse({ wholesalePrice: '-1' }).success).toBe(false);
    expect(updateVariantPriceSchema.safeParse({ wholesalePrice: '1.5' }).success).toBe(false);
    const base = { productId: randomUUID(), sku: 'N1', barcode: 'N1', cashPrice: '1000', price: '1000', costPrice: '1' };
    expect(createVariantSchema.safeParse({ ...base, wholesalePrice: '1001' }).success).toBe(false);
    expect(createVariantSchema.safeParse({ ...base, wholesalePrice: '1000' }).success).toBe(true);
    expect(createVariantSchema.safeParse(base).success).toBe(true);
  });

  it('A11 wholesale price can be cleared; empty and cost changes are rejected', async () => {
    const t = setup();
    const cleared = await t.catalog.updateVariantPrice(t.ids.owner, t.V1, { wholesalePrice: null });
    expect(cleared).toMatchObject({ price: 10000n, wholesalePrice: null });
    expect(updateVariantPriceSchema.safeParse({}).success).toBe(false);
    expect(updateVariantPriceSchema.safeParse({ costPrice: '1' }).success).toBe(false);
    expect(updateVariantPriceSchema.safeParse({ price: '100' }).success).toBe(true);
    const audit = t.audits('PRODUCT_VARIANT_PRICE_CHANGED').at(-1)!;
    expect(serialize(audit.before)).toContain('"wholesalePrice":"7000"');
    expect(serialize(audit.after)).toContain('"wholesalePrice":null');
  });
});

describe('Block 1 — configuration', () => {
  it('A18 WHOLESALE_AUTH_CODE_HASH: empty is unset; malformed or weak is rejected without echo', async () => {
    const base = {
      NODE_ENV: 'production', DATABASE_URL: 'postgresql://u:p@db.invalid:5432/x',
      JWT_SECRET: 'a'.repeat(40), JWT_ACCESS_TTL_SECONDS: '900', CORS_ORIGINS: 'http://localhost:3000',
    };
    const saved = { ...process.env };
    Object.assign(process.env, base, { WHOLESALE_AUTH_CODE_HASH: '' });
    try {
      const { parseEnv } = await import('../src/config/env.js');
      expect(parseEnv({ ...base, WHOLESALE_AUTH_CODE_HASH: '' }).WHOLESALE_AUTH_CODE_HASH).toBeUndefined();
      expect(parseEnv(base).WHOLESALE_AUTH_CODE_HASH).toBeUndefined();
      const strong = await hash(CODE, 10);
      expect(parseEnv({ ...base, WHOLESALE_AUTH_CODE_HASH: strong }).WHOLESALE_AUTH_CODE_HASH).toBe(strong);
      for (const bad of ['plaintext-code', CODE_HASH /* cost 4: too weak */]) {
        let message = '';
        try {
          parseEnv({ ...base, WHOLESALE_AUTH_CODE_HASH: bad });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toContain('WHOLESALE_AUTH_CODE_HASH');
        expect(message).not.toContain(bad);
      }
    } finally {
      process.env = saved;
    }
  });
});

describe('Block 1 — HTTP routes (real router, in-memory database)', () => {
  function http(t: ReturnType<typeof setup>) {
    const app = express();
    app.use(express.json());
    // Stand-in for requireAuth: the header names a fixture identity.
    app.use((req, _res, next) => {
      const key = req.header('x-test-user') as keyof typeof t.reqs;
      req.auth = (t.reqs[key] as unknown as { auth: Express.AuthContext }).auth;
      next();
    });
    app.use('/sales', createSalesRouter(t.db.client as unknown as PrismaClient, undefined, {
      wholesaleVerifier: createWholesaleCodeVerifier(CODE_HASH),
    }));
    app.use(errorHandler);
    return supertest(app);
  }

  it('R01 + R02 wrong codes are rate limited per user and never echoed', async () => {
    const t = setup();
    const api = http(t);
    const saleId = await t.draft();
    const other = await t.draft('seller2');
    const bodies: string[] = [];
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      const response = await api.post(`/sales/${saleId}/wholesale`).set('x-test-user', 'seller').send({ code: `Wrong-${attempt}-Code` });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('WHOLESALE_CODE_INVALID');
      bodies.push(response.text);
    }
    const limited = await api.post(`/sales/${saleId}/wholesale`).set('x-test-user', 'seller').send({ code: CODE });
    expect(limited.status).toBe(429);
    expect(t.sale(saleId).pricingMode).toBe('LIST');
    // Another seller keeps an independent budget.
    const ok = await api.post(`/sales/${other}/wholesale`).set('x-test-user', 'seller2').send({ code: CODE });
    expect(ok.status).toBe(200);
    bodies.push(ok.text);
    const tooLong = await api.post(`/sales/${other}/wholesale`).set('x-test-user', 'seller2').send({ code: `${'Z'.repeat(300)}` });
    expect(tooLong.status).toBe(400);
    bodies.push(tooLong.text);
    const all = bodies.join('\n');
    expect(all).not.toContain(CODE);
    expect(all).not.toMatch(/Wrong-\d+-Code/);
    expect(all).not.toContain('ZZZZZZZZ');
  });

  it('R03 route permissions: WAREHOUSE cannot activate, SELLER cannot confirm', async () => {
    const t = setup();
    const api = http(t);
    const saleId = await t.draft();
    expect((await api.post(`/sales/${saleId}/wholesale`).set('x-test-user', 'warehouse').send({ code: CODE })).status).toBe(403);
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    await t.send(saleId);
    expect((await api.post(`/sales/${saleId}/wholesale/confirm`).set('x-test-user', 'seller').send()).status).toBe(403);
    expect((await api.post(`/sales/${saleId}/wholesale/confirm`).set('x-test-user', 'warehouse').send()).status).toBe(403);
    // N24: client-supplied role text is never authority.
    const spoofed = await api.post(`/sales/${saleId}/wholesale/confirm`).set('x-test-user', 'seller')
      .set('x-role', 'CASHIER').send({ role: 'CASHIER', roles: ['CASHIER'], assignments: [{ roleCode: 'CASHIER' }] });
    expect(spoofed.status).toBe(403);
    expect(t.sale(saleId).wholesaleConfirmedAt).toBeNull();
    const confirmed = await api.post(`/sales/${saleId}/wholesale/confirm`).set('x-test-user', 'cashier').send();
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ saleId, pricingMode: 'WHOLESALE', replayed: false, wholesaleConfirmedById: t.ids.cashier });
  });

  it('R04 activation over HTTP returns the repriced sale with string money', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 2n]]);
    const response = await http(t).post(`/sales/${saleId}/wholesale`).set('x-test-user', 'seller').send({ code: ` ${CODE} ` });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ id: saleId, pricingMode: 'WHOLESALE', total: '14000' });
    expect(response.body.items[0]).toMatchObject({ unitPrice: '7000', subtotal: '14000' });
    expect(response.text).not.toContain(CODE);
  });
});

describe('Block 1 fix round — CASHIER actor for wholesale confirmation (N14-N25)', () => {
  async function wholesalePending(t: ReturnType<typeof setup>) {
    const saleId = await t.draft('seller', [[t.V1, 1n]]);
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    await t.send(saleId);
    return saleId;
  }
  const userReq = (assignments: Express.ProductionAssignment[]) => requestFor(randomUUID(), assignments);
  const confirmAs = (t: ReturnType<typeof setup>, req: Request, saleId: string) =>
    t.sales.confirmWholesale(req, (req as unknown as { auth: Express.AuthContext }).auth.userId, saleId);

  it('N14 + N15 CASHIER at the sale location confirms; CASHIER elsewhere cannot', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    await expectAppError(confirmAs(t, userReq([assignment('CASHIER', t.L2)]), saleId), 403, 'FORBIDDEN');
    expect((await confirmAs(t, userReq([assignment('CASHIER', t.L1)]), saleId)).replayed).toBe(false);
  });

  it('N16 + N17 ADMIN or OWNER company authority alone cannot confirm', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    await expectAppError(confirmAs(t, userReq([assignment('ADMIN', null)]), saleId), 403, 'WHOLESALE_CASHIER_REQUIRED');
    await expectAppError(confirmAs(t, userReq([assignment('OWNER', null)]), saleId), 403, 'WHOLESALE_CASHIER_REQUIRED');
    await expectAppError(confirmAs(t, userReq([assignment('ADMIN', t.L1)]), saleId), 403, 'WHOLESALE_CASHIER_REQUIRED');
    expect(t.sale(saleId).wholesaleConfirmedAt).toBeNull();
    expect(t.audits('SALE_WHOLESALE_CONFIRMED')).toHaveLength(0);
  });

  it('N18 + N19 ADMIN/OWNER with a separate CASHIER assignment at the location may confirm', async () => {
    const t = setup();
    const a = await wholesalePending(t);
    const b = await wholesalePending(t);
    const adminCashier = userReq([assignment('ADMIN', null), assignment('CASHIER', t.L1)]);
    const ownerCashier = userReq([assignment('OWNER', null), assignment('CASHIER', t.L1)]);
    expect(await confirmAs(t, adminCashier, a)).toMatchObject({ replayed: false });
    expect(await confirmAs(t, ownerCashier, b)).toMatchObject({ replayed: false });
    // ...but only through a CASHIER assignment at THIS sale's location.
    const c = await wholesalePending(t);
    await expectAppError(confirmAs(t, userReq([assignment('OWNER', null), assignment('CASHIER', t.L2)]), c), 403, 'WHOLESALE_CASHIER_REQUIRED');
  });

  it('N20 + N21 persisted authority only: revoked scope and legacy-only CASHIER are denied', async () => {
    const t = setup();
    const userId = randomUUID();
    const cashierScope = {
      roleId: 'role-cashier', scopeKind: 'LOCATION' as const, locationId: t.L1,
      role: { code: 'CASHIER', permissions: DEFAULT_ROLE_GRANTS.CASHIER.map((code) => ({ permission: { code } })) },
    };
    const db = t.db.client as unknown as Parameters<typeof buildAuthorizationContext>[0];
    const asReq = (auth: Express.AuthContext) => ({ auth } as unknown as Request);
    // Real context builder over persisted-shaped rows (as requireAuth does per request).
    const live = await buildAuthorizationContext(db, { id: userId, branchRoles: [], roleScopes: [cashierScope] });
    const first = await wholesalePending(t);
    expect((await t.sales.confirmWholesale(asReq(live), userId, first)).replayed).toBe(false);
    const revoked = await buildAuthorizationContext(db, { id: userId, branchRoles: [], roleScopes: [] });
    const second = await wholesalePending(t);
    await expectAppError(t.sales.confirmWholesale(asReq(revoked), userId, second), 403, 'FORBIDDEN');
    const legacy = await buildAuthorizationContext(db, { id: userId, branchRoles: [{ role: { code: 'CASHIER' } }], roleScopes: [] });
    expect(legacy.roles).toContain('CASHIER');
    expect(legacy.assignments).toEqual([]);
    await expectAppError(t.sales.confirmWholesale(asReq(legacy), userId, second), 403, 'FORBIDDEN');
    expect(t.sale(second).wholesaleConfirmedAt).toBeNull();
  });

  it('N22 + N23 a CASHIER row without SALE_CHARGE, or a malformed COMPANY CASHIER, cannot confirm', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    const stripped = { ...assignment('CASHIER', t.L1), permissions: assignment('CASHIER', t.L1).permissions.filter((p) => p !== 'SALE_CHARGE') };
    await expectAppError(confirmAs(t, userReq([stripped]), saleId), 403, 'FORBIDDEN');
    await expectAppError(confirmAs(t, userReq([assignment('CASHIER', null)]), saleId), 403, 'WHOLESALE_CASHIER_REQUIRED');
    expect(t.sale(saleId).wholesaleConfirmedAt).toBeNull();
  });

  it('N25 queue eligibility follows the same actor rule', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    const flag = async (assignments: Express.ProductionAssignment[]) => {
      const auth = (userReq(assignments) as unknown as { auth: Express.AuthContext }).auth;
      return (await t.sales.listPendingSales([t.L1], auth)).find((row) => row.saleId === saleId)!.canConfirmWholesale;
    };
    expect(await flag([assignment('ADMIN', null)])).toBe(false);
    expect(await flag([assignment('OWNER', null)])).toBe(false);
    expect(await flag([assignment('ADMIN', null), assignment('CASHIER', t.L1)])).toBe(true);
    expect(await flag([assignment('CASHIER', t.L1)])).toBe(true);
    expect(await flag([assignment('CASHIER', t.L2)])).toBe(false);
  });
});

describe('Block 1 fix round — wholesale price confidentiality (N26)', () => {
  // A recording database that honors `select` exactly (unlike the superset
  // in-memory store), so it proves what the catalog reads actually expose.
  function selectingDb() {
    const selects: unknown[] = [];
    const variant = { id: randomUUID(), productId: randomUUID(), sku: 'V1', barcode: 'B1', color: null, size: null, cashPrice: 9000n, price: 10000n, wholesalePrice: 7000n, costPrice: 1n, isActive: true };
    const product = { id: variant.productId, name: 'Remera', slug: 'remera', description: null, isActive: true, category: { id: 'c', name: 'C' }, brand: { id: 'b', name: 'B' } };
    const project = (row: Record<string, unknown>, select: Record<string, unknown>): Record<string, unknown> =>
      Object.fromEntries(Object.entries(select).filter(([, on]) => on).map(([key, on]) => {
        if (key === 'variants') return [key, [project(variant, (on as { select: Record<string, unknown> }).select)]];
        if (key === 'product') return [key, project(product, (on as { select: Record<string, unknown> }).select)];
        if (key === 'inventory') return [key, []];
        if (typeof on === 'object') return [key, project(row[key] as Record<string, unknown>, (on as { select: Record<string, unknown> }).select)];
        return [key, row[key]];
      }));
    const delegate = (row: Record<string, unknown>) => ({
      findMany: async (args: { select: Record<string, unknown> }) => { selects.push(args.select); return [project(row, args.select)]; },
      findUnique: async (args: { select: Record<string, unknown> }) => { selects.push(args.select); return project(row, args.select); },
      count: async () => 1,
    });
    const db = { product: delegate(product), productVariant: delegate(variant), stockReservation: { groupBy: async () => [] } };
    return { db: db as never, selects };
  }

  it('N26 seller/warehouse catalog reads never select or return wholesalePrice', async () => {
    const { db, selects } = selectingDb();
    const req = requestFor(randomUUID(), [assignment('SELLER', null)]);
    const results = [
      await listProducts(db, { page: 1, limit: 20, isActive: true } as never),
      await getProduct(db, randomUUID(), req.auth),
      await listVariants(db, req, { page: 1, limit: 20, isActive: true } as never),
      await getVariant(db, randomUUID(), req.auth),
    ];
    expect(selects.length).toBeGreaterThanOrEqual(4);
    expect(serialize(selects)).not.toContain('wholesalePrice');
    expect(serialize(results)).not.toContain('wholesalePrice');
    expect(serialize(results)).toContain('"price":"10000"');
    // Pilot Pricing V2: the retail CASH base is exposed; the wholesale CASH base never is.
    expect(serialize(results)).toContain('"cashPrice":"9000"');
  });
});

describe('Block 1 fix round — management pricing read (N27-N31, N33)', () => {
  // NOTE: importing the variants router imports products.controller, which
  // imports config/prisma.ts: that CONSTRUCTS (never queries) a default
  // PrismaClient bound to the synthetic *.invalid DATABASE_URL. Every route
  // below uses the in-memory database instead; the run has no network.
  async function pricingApi(t: ReturnType<typeof setup>) {
    const { createVariantsRouter } = await import('../src/modules/products/products.routes.js');
    const contexts: Record<string, Request> = {
      adminCompany: requestFor(randomUUID(), [assignment('ADMIN', null)]),
      adminLocation: requestFor(randomUUID(), [assignment('ADMIN', t.L1)]),
      owner: t.reqs.owner, seller: t.reqs.seller, cashier: t.reqs.cashier, warehouse: t.reqs.warehouse,
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.auth = (contexts[req.header('x-test-user')!] as unknown as { auth: Express.AuthContext }).auth;
      next();
    });
    app.use('/variants', createVariantsRouter(t.db.client as unknown as PrismaClient));
    app.use(errorHandler);
    return supertest(app);
  }

  it('N27-N31 only COMPANY price managers read current list + wholesale price', async () => {
    const t = setup();
    const api = await pricingApi(t);
    for (const who of ['seller', 'cashier', 'warehouse', 'adminLocation']) {
      const response = await api.get(`/variants/${t.V1}/pricing`).set('x-test-user', who);
      expect(response.status, who).toBe(403);
      expect(response.text, who).not.toContain('7000');
    }
    // N31: the in-memory store returns a column superset, so the exposure
    // proof is the exact `select` the service sends: prices only, no cost.
    const lookups = vi.spyOn(t.db.client.productVariant as { findUnique: (args: unknown) => Promise<unknown> }, 'findUnique');
    for (const who of ['adminCompany', 'owner']) {
      const response = await api.get(`/variants/${t.V1}/pricing`).set('x-test-user', who);
      expect(response.status, who).toBe(200);
      expect(response.body.pricing).toMatchObject({ id: t.V1, sku: 'V1', cashPrice: '10000', price: '10000', wholesalePrice: '7000' });
    }
    expect(lookups).toHaveBeenCalledWith({ where: { id: t.V1 }, select: { id: true, sku: true, cashPrice: true, price: true, wholesalePrice: true } });
    // D13 + S32: exact GET shape (the harness now honors `select` exactly).
    const exact = await api.get(`/variants/${t.V1}/pricing`).set('x-test-user', 'adminCompany');
    expect(exact.body).toEqual({ pricing: { id: t.V1, sku: 'V1', cashPrice: '10000', price: '10000', wholesalePrice: '7000' } });
    const none = await api.get(`/variants/${t.V2}/pricing`).set('x-test-user', 'adminCompany');
    expect(none.body.pricing).toMatchObject({ cashPrice: '5000', price: '5000', wholesalePrice: null });
    expect((await api.get(`/variants/${randomUUID()}/pricing`).set('x-test-user', 'adminCompany')).status).toBe(404);
  });

  it('N33 lowering list below the current wholesale fails and never nulls the wholesale price', async () => {
    const t = setup();
    const api = await pricingApi(t);
    const lowered = await api.patch(`/variants/${t.V1}/price`).set('x-test-user', 'adminCompany').send({ price: '6999' });
    expect(lowered.status).toBe(409);
    expect(lowered.body.error.code).toBe('WHOLESALE_PRICE_ABOVE_LIST');
    const read = await api.get(`/variants/${t.V1}/pricing`).set('x-test-user', 'adminCompany');
    expect(read.body.pricing).toMatchObject({ cashPrice: '10000', price: '10000', wholesalePrice: '7000' });
    const equal = await api.patch(`/variants/${t.V1}/price`).set('x-test-user', 'adminCompany').send({ wholesalePrice: '10000' });
    expect(equal.status).toBe(200);
    const both = await api.patch(`/variants/${t.V1}/price`).set('x-test-user', 'adminCompany').send({ price: '6000', wholesalePrice: '5000' });
    expect(both.status).toBe(200);
    // D12 + S31: exact PATCH shape — the pricing projection only, no costPrice.
    expect(both.body).toEqual({ variant: { id: t.V1, sku: 'V1', cashPrice: '10000', price: '6000', wholesalePrice: '5000' } });
    expect(both.text).not.toContain('costPrice');
    expect(equal.body).toEqual({ variant: { id: t.V1, sku: 'V1', cashPrice: '10000', price: '10000', wholesalePrice: '10000' } });
    expect((await api.patch(`/variants/${t.V1}/price`).set('x-test-user', 'seller').send({ wholesalePrice: '1' })).status).toBe(403);
  });
});

describe('Block 1 fix round — migration CHECK semantics (N01-N13, static)', () => {
  // Restricted SQL boolean evaluator with SQL three-valued logic; a CHECK
  // passes unless its expression is FALSE (NULL passes, as in PostgreSQL).
  type V = boolean | string | number | null;
  function evaluate(sql: string, row: Record<string, V>): V {
    const tokens = sql.match(/"[^"]+"|'[^']*'|<=|>=|<>|[=<>(),]|\d+|[A-Za-z_]+/g)!;
    let i = 0;
    const peek = () => tokens[i]?.toUpperCase();
    const take = (expected?: string) => {
      const token = tokens[i++]!;
      if (expected && token.toUpperCase() !== expected) throw new Error(`expected ${expected}, got ${token}`);
      return token;
    };
    const and3 = (a: V, b: V): V => (a === false || b === false ? false : a === null || b === null ? null : true);
    const or3 = (a: V, b: V): V => (a === true || b === true ? true : a === null || b === null ? null : false);
    const primary = (): V => {
      const token = take();
      if (token === '(') { const value = or(); take(')'); return value; }
      if (token.startsWith('"')) {
        const name = token.slice(1, -1);
        if (!(name in row)) throw new Error(`unknown column ${name}`);
        return row[name]!;
      }
      if (token.startsWith("'")) return token.slice(1, -1);
      if (/^\d+$/.test(token)) return Number(token);
      throw new Error(`unexpected token ${token}`);
    };
    const comparison = (): V => {
      const left = primary();
      if (peek() === 'IS') {
        take(); const negate = peek() === 'NOT'; if (negate) take(); take('NULL');
        return negate ? left !== null : left === null;
      }
      if (peek() === 'NOT' || peek() === 'IN') {
        const negate = peek() === 'NOT'; if (negate) take(); take('IN'); take('(');
        const list: V[] = [primary()];
        while (peek() === ',') { take(); list.push(primary()); }
        take(')');
        if (left === null) return null;
        return negate ? !list.includes(left) : list.includes(left);
      }
      const op = peek();
      if (op && ['=', '<>', '<', '<=', '>', '>='].includes(op)) {
        take(); const right = primary();
        if (left === null || right === null) return null;
        const [a, b] = [left as number | string | boolean, right as number | string | boolean];
        return op === '=' ? a === b : op === '<>' ? a !== b : op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
      }
      return left;
    };
    const not = (): V => {
      if (peek() === 'NOT') { take(); const value = not(); return value === null ? null : !value; }
      return comparison();
    };
    const and = (): V => { let value = not(); while (peek() === 'AND') { take(); value = and3(value, not()); } return value; };
    const or = (): V => { let value = and(); while (peek() === 'OR') { take(); value = or3(value, and()); } return value; };
    const result = or();
    if (i !== tokens.length) throw new Error(`trailing tokens at ${tokens[i]}`);
    return result;
  }

  const migration = readFileSync(new URL('../prisma/migrations/20261002120000_block1_pricing_wholesale/migration.sql', import.meta.url), 'utf8');
  const checks = Object.fromEntries([...migration.matchAll(/ADD CONSTRAINT "(chk_\w+)" CHECK \(\n([\s\S]*?)\n\);/g)].map((m) => [m[1]!, m[2]!]));
  const saleChecks = ['chk_sale_wholesale_state', 'chk_sale_wholesale_confirmed_when_paid'];
  const saleAllowed = (row: Record<string, V>) => saleChecks.every((name) => evaluate(checks[name]!, row) !== false);
  const base = { pricingMode: 'LIST', status: 'DRAFT', wholesaleAuthorizedAt: null, wholesaleConfirmedAt: null, wholesaleConfirmedById: null } as Record<string, V>;
  const wholesale = (status: string, extra: Record<string, V> = {}) => ({ ...base, pricingMode: 'WHOLESALE', status, wholesaleAuthorizedAt: 1, ...extra });
  const confirmed = { wholesaleConfirmedAt: 1, wholesaleConfirmedById: 'cashier' };

  it('parses exactly the three Block 1 CHECK constraints and no SaleItem change', () => {
    expect(Object.keys(checks).sort()).toEqual(['chk_product_variant_wholesale_price', ...saleChecks].sort());
    expect(migration).not.toMatch(/ALTER TABLE "SaleItem"|priceType/);
    // Statements only: comments, plpgsql bodies, FK referential actions and
    // trigger EVENT clauses ("BEFORE INSERT OR UPDATE OF ...") are not writes.
    const statements = migration
      .replace(/--.*$/gm, '')
      .replace(/\$\$[\s\S]*?\$\$/g, '')
      .replace(/ON DELETE RESTRICT ON UPDATE CASCADE/g, '')
      .replace(/^(BEFORE|AFTER) [^\n]+ ON (public\.)?"\w+"$/gm, '');
    expect(statements).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME|INSERT)\b/);
    expect(statements.match(/^\s*(CREATE TYPE|ALTER TABLE "\w+" ADD (COLUMN|CONSTRAINT))/gm)).toHaveLength(7);
  });

  it('N01-N07 + N13 WHOLESALE can be PAID/COMPLETED only with both confirmation columns', () => {
    for (const status of ['PAID', 'COMPLETED']) {
      expect(saleAllowed(wholesale(status)), `N01/N02/N13 ${status}`).toBe(false);
      expect(saleAllowed(wholesale(status, { wholesaleConfirmedAt: 1 })), `N03 ${status}`).toBe(false);
      expect(saleAllowed(wholesale(status, { wholesaleConfirmedById: 'cashier' })), `N04 ${status}`).toBe(false);
      expect(saleAllowed(wholesale(status, confirmed)), `N05 ${status}`).toBe(true);
    }
    expect(saleAllowed(wholesale('PENDING_PAYMENT')), 'N06').toBe(true);
    expect(saleAllowed(wholesale('CANCELLED')), 'N07').toBe(true);
    expect(saleAllowed(wholesale('DRAFT')), 'draft').toBe(true);
  });

  it('N08-N11 shape rules: authorization required; LIST carries no wholesale state; history stays valid', () => {
    expect(saleAllowed(wholesale('DRAFT', { wholesaleAuthorizedAt: null })), 'N08').toBe(false);
    expect(saleAllowed({ ...base, status: 'PENDING_PAYMENT', ...confirmed }), 'N09').toBe(false);
    expect(saleAllowed({ ...base, wholesaleAuthorizedAt: 1 }), 'N10').toBe(false);
    for (const status of ['DRAFT', 'PENDING_PAYMENT', 'PAID', 'COMPLETED', 'CANCELLED']) {
      expect(saleAllowed({ ...base, status }), `N11 ${status}`).toBe(true);
    }
  });

  it('N12 wholesale price: NULL ok, 0/negative/above list rejected, equal ok', () => {
    const allowed = (wholesalePrice: V) => evaluate(checks.chk_product_variant_wholesale_price!, { price: 10000, wholesalePrice }) !== false;
    expect(allowed(null)).toBe(true);
    expect(allowed(0)).toBe(false);
    expect(allowed(-1)).toBe(false);
    expect(allowed(10000)).toBe(true);
    expect(allowed(10001)).toBe(false);
  });

  it('evaluator self-check: SQL NULL semantics (a NULL CHECK result passes)', () => {
    expect(evaluate('"a" > 0', { a: null })).toBeNull();
    expect(evaluate('"a" IS NULL OR ("a" > 0 AND "a" <= "b")', { a: null, b: 1 })).toBe(true);
    expect(evaluate('("a" IS NULL) = ("b" IS NULL)', { a: null, b: 'x' })).toBe(false);
  });
});

describe('Block 1 final hardening — WHOLESALE_PAYMENT_REQUIRES_CASHIER_CONFIRMATION (app, P01-P10 / Q19-Q28)', () => {
  async function wholesalePending(t: ReturnType<typeof setup>, quantity = 2n) {
    const saleId = await t.draft('seller', [[t.V1, quantity]]);
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    await t.send(saleId);
    return saleId;
  }
  function openCash(t: ReturnType<typeof setup>) {
    const register = t.db.insert('cashRegister', { branchId: t.L1, name: 'Caja' });
    t.db.insert('cashSession', { registerId: register.id, status: 'OPEN', openedById: t.ids.cashier, startingCash: 0n });
  }
  const payWith = (t: ReturnType<typeof setup>, saleId: string, method: 'CASH' | 'TRANSFER', amount: bigint) =>
    t.payments.registerPayment(t.reqs.cashier, t.ids.cashier, saleId, {
      method, amount, receivedAmount: method === 'CASH' ? amount : null, idempotencyKey: randomUUID(),
    });

  it('P01 + Q19 + Q24 first PARTIAL payment (CASH) before confirmation is rejected with no side effects', async () => {
    const t = setup();
    openCash(t);
    const saleId = await wholesalePending(t);
    await expectAppError(payWith(t, saleId, 'CASH', 1000n), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
    expect(t.db.table('salePayment')).toHaveLength(0);
    expect(t.db.table('cashMovement')).toHaveLength(0);
    expect(t.audits('PAYMENT_REGISTERED')).toHaveLength(0);
    expect(t.sale(saleId).status).toBe('PENDING_PAYMENT');
  });

  it('P02 + Q25 FULL payment before confirmation is rejected', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    await expectAppError(payWith(t, saleId, 'TRANSFER', t.sale(saleId).total as bigint), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
    expect(t.db.table('salePayment')).toHaveLength(0);
  });

  it('P03 + P04 + Q06 confirmed WHOLESALE accepts a partial then a final payment, two methods', async () => {
    const t = setup();
    openCash(t);
    const saleId = await wholesalePending(t);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    const total = t.sale(saleId).total as bigint; // 14000 at wholesale
    expect(total).toBe(14000n);
    expect((await payWith(t, saleId, 'TRANSFER', 4000n)).resultingStatus).toBe('PENDING_PAYMENT');
    expect((await payWith(t, saleId, 'CASH', total - 4000n)).resultingStatus).toBe('PAID');
    expect(t.db.table('salePayment')).toHaveLength(2);
    expect(t.db.table('cashMovement')).toHaveLength(1);
  });

  it('P05 + P06 LIST sale: partial and final payments need no confirmation', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 1n]]);
    await t.send(saleId);
    expect((await payWith(t, saleId, 'TRANSFER', 3000n)).resultingStatus).toBe('PENDING_PAYMENT');
    expect((await payWith(t, saleId, 'TRANSFER', 7000n)).resultingStatus).toBe('PAID');
  });

  it('P07 correction with ZERO payments may clear the confirmation (reconfirmation required)', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    await t.correction.correctPendingSale(t.reqs.cashier, saleId, { items: [{ variantId: t.V1, quantity: 1n }] });
    expect(t.sale(saleId)).toMatchObject({ wholesaleConfirmedAt: null, wholesaleConfirmedById: null });
    await expectAppError(payWith(t, saleId, 'TRANSFER', 1n), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
  });

  it('P08 + Q26 correction after a partial payment fails closed and keeps the confirmation', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    await payWith(t, saleId, 'TRANSFER', 1000n);
    const before = { ...t.sale(saleId) };
    await expectAppError(t.correction.correctPendingSale(t.reqs.cashier, saleId, { items: [{ variantId: t.V1, quantity: 1n }] }), 409, 'PAYMENT_ALREADY_ACCEPTED');
    expect(t.sale(saleId)).toMatchObject({
      wholesaleConfirmedAt: before.wholesaleConfirmedAt, wholesaleConfirmedById: t.ids.cashier, total: before.total,
    });
  });

  it('P09 + Q27 ADMIN-only cannot fabricate the confirmation that payment needs', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    const admin = requestFor(randomUUID(), [assignment('ADMIN', null)]);
    await expectAppError(t.sales.confirmWholesale(admin, (admin as unknown as { auth: Express.AuthContext }).auth.userId, saleId), 403, 'WHOLESALE_CASHIER_REQUIRED');
    await expectAppError(t.payments.registerPayment(admin, (admin as unknown as { auth: Express.AuthContext }).auth.userId, saleId, {
      method: 'TRANSFER', amount: 1n, receivedAmount: null, idempotencyKey: randomUUID(),
    }), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
    expect(t.db.table('salePayment')).toHaveLength(0);
  });

  it('P10 + Q28 legacy-only (UserBranchRole) CASHIER authority creates no confirmation', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    const userId = randomUUID();
    const legacy = await buildAuthorizationContext(t.db.client as unknown as Parameters<typeof buildAuthorizationContext>[0], {
      id: userId, branchRoles: [{ role: { code: 'CASHIER' } }], roleScopes: [],
    });
    await expectAppError(t.sales.confirmWholesale({ auth: legacy } as unknown as Request, userId, saleId), 403, 'FORBIDDEN');
    expect(t.sale(saleId).wholesaleConfirmedAt).toBeNull();
    await expectAppError(payWith(t, saleId, 'TRANSFER', 1n), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
  });
});

describe('Block 1 trigger STRUCTURE (static; payment-history final design, T01-T42)', () => {
  // Structural checks of the migration text only. They do NOT prove
  // PostgreSQL runtime: POSTGRES_TRIGGER_RUNTIME, POSTGRES_TRUNCATE_TRIGGER_RUNTIME,
  // POSTGRES_LOCKING and PRISMA_TRIGGER_ERROR_MAPPING = NOT_RUN_OWNER_GATE.
  const migration = readFileSync(new URL('../prisma/migrations/20261002120000_block1_pricing_wholesale/migration.sql', import.meta.url), 'utf8');
  const functions = [...migration.matchAll(/CREATE FUNCTION public\."(\w+)"\(\) RETURNS trigger\nLANGUAGE plpgsql\nSET search_path = pg_catalog, pg_temp\nAS \$\$([\s\S]*?)\$\$;/g)]
    .map((m) => ({ name: m[1]!, body: m[2]! }));
  const triggers = [...migration.matchAll(/CREATE TRIGGER "(\w+)"\n((?:BEFORE|AFTER) [^\n]+) ON public\."(\w+)"\nFOR EACH (ROW|STATEMENT) EXECUTE FUNCTION public\."(\w+)"\(\);/g)]
    .map((m) => ({ name: m[1]!, events: m[2]!, table: m[3]!, level: m[4]!, fn: m[5]! }));
  const body = (name: string) => functions.find((f) => f.name === name)!.body;
  const history = () => body('fn_sale_payment_history');
  const guard = () => body('fn_sale_payment_truncate_guard');
  const frozen = () => body('fn_sale_wholesale_frozen_after_payment');
  // DML keywords only: string literals (TG_OP/TG_WHEN comparisons) and the
  // row-lock clause FOR UPDATE are not statements.
  const dml = (b: string) => b.replace(/'[^']*'/g, "''").replace(/FOR UPDATE/g, '').match(/\b(INSERT|UPDATE|DELETE|TRUNCATE|MERGE)\b/g) ?? [];
  const recordFrom = (id: string) => new RegExp(
    `UPDATE public\\."Sale" s\\s+SET "paymentStartedAt" = h\\.first_paid\\s+FROM \\(SELECT min\\(p\\."paidAt"\\) AS first_paid FROM public\\."SalePayment" p WHERE p\\."saleId" = ${id.replace(/[."]/g, (c) => `\\${c}`)}\\) h\\s+WHERE s\\."id" = ${id.replace(/[."]/g, (c) => `\\${c}`)}\\s+AND h\\.first_paid IS NOT NULL\\s+AND \\(s\\."paymentStartedAt" IS NULL OR h\\.first_paid < s\\."paymentStartedAt"\\);`,
  );

  it('T29/Q29 three qualified functions with pinned search_path; four triggers on exact tables/events/levels', () => {
    expect((migration.match(/CREATE FUNCTION/g) ?? []).length).toBe(3);
    expect((migration.match(/CREATE TRIGGER/g) ?? []).length).toBe(4);
    expect(functions.map((f) => f.name).sort()).toEqual([
      'fn_sale_payment_history', 'fn_sale_payment_truncate_guard', 'fn_sale_wholesale_frozen_after_payment',
    ]);
    expect(triggers).toEqual([
      { name: 'trg_sale_payment_history_before', events: 'BEFORE INSERT OR UPDATE OF "saleId" OR DELETE', table: 'SalePayment', level: 'ROW', fn: 'fn_sale_payment_history' },
      { name: 'trg_sale_payment_history_after', events: 'AFTER INSERT OR UPDATE OF "saleId", "paidAt"', table: 'SalePayment', level: 'ROW', fn: 'fn_sale_payment_history' },
      { name: 'trg_sale_payment_truncate_guard', events: 'BEFORE TRUNCATE', table: 'SalePayment', level: 'STATEMENT', fn: 'fn_sale_payment_truncate_guard' },
      { name: 'trg_sale_wholesale_frozen_after_payment', events: 'BEFORE INSERT OR UPDATE OF "paymentStartedAt", "pricingMode", "wholesaleAuthorizedAt", "wholesaleConfirmedAt", "wholesaleConfirmedById"', table: 'Sale', level: 'ROW', fn: 'fn_sale_wholesale_frozen_after_payment' },
    ]);
  });

  it('T15/T18/T20/T34/T36 AFTER branch records the TARGET from current paidAt (new row visible); returns NULL', () => {
    const b = history();
    const after = b.slice(b.indexOf("IF TG_WHEN = 'AFTER' THEN"), b.indexOf('RETURN NULL;') + 'RETURN NULL;'.length);
    expect(after).toMatch(recordFrom('NEW."saleId"'));
    expect(b.indexOf("IF TG_WHEN = 'AFTER' THEN")).toBeLessThan(b.indexOf('PERFORM 1'));
  });

  it('T19/T20/LGC28 BEFORE branch: id-ordered locks, SOURCE recorded while the row is visible, TARGET eligibility', () => {
    const b = history();
    expect(b).toMatch(/PERFORM 1\s+FROM public\."Sale" s\s+WHERE s\."id" IN \(source_id, target_id\)\s+ORDER BY s\."id"\s+FOR UPDATE;/);
    expect(b).toMatch(/IF TG_OP IN \('UPDATE', 'DELETE'\) THEN\s+source_id := OLD\."saleId";/);
    expect(b).toMatch(/IF TG_OP IN \('INSERT', 'UPDATE'\) THEN\s+target_id := NEW\."saleId";/);
    expect(b).toMatch(recordFrom('source_id'));
    for (const column of ['wholesaleAuthorizedAt', 'wholesaleConfirmedAt', 'wholesaleConfirmedById']) {
      expect(b).toContain(`s."${column}" IS NOT NULL`);
    }
    expect(b).toContain('IF eligible IS NOT TRUE THEN');
    expect(b).toMatch(/IF TG_OP = 'DELETE' THEN\s+RETURN OLD;\s+END IF;\s+RETURN NEW;/); // T37
    // Exactly two marker UPDATEs (AFTER target, BEFORE source); no other DML;
    // never now() — only persisted paidAt; nothing assigns NULL.
    expect(dml(b)).toEqual(['UPDATE', 'UPDATE']);
    expect(migration).not.toMatch(/now\(\)|clock_timestamp|current_timestamp/i);
    expect(migration).not.toMatch(/"paymentStartedAt"\s*=\s*NULL/);
  });

  it('T01-T10/T21-T27 TRUNCATE guard: statement-level, read-only, refuses only unrecorded history', () => {
    const b = guard();
    expect(dml(b)).toEqual([]);
    expect(b).not.toMatch(/FOR UPDATE|FOR SHARE|LOCK TABLE/);
    expect(b).toMatch(/IF EXISTS \(\s+SELECT 1\s+FROM public\."SalePayment" p\s+JOIN public\."Sale" s ON s\."id" = p\."saleId"\s+WHERE s\."paymentStartedAt" IS NULL\s+OR p\."paidAt" < s\."paymentStartedAt"\s+\) THEN\s+RAISE EXCEPTION '[^']+'\s+USING ERRCODE = 'check_violation';\s+END IF;\s+RETURN NULL;/);
  });

  it('T11-T17/T31-T33 freeze + marker authority: marker may only become LEAST(old, earliest current paidAt)', () => {
    const b = frozen();
    expect(b).toMatch(/SELECT min\(p\."paidAt"\) INTO earliest FROM public\."SalePayment" p WHERE p\."saleId" = OLD\."id";/);
    expect(b).toMatch(/IF \(OLD\."paymentStartedAt" IS NOT NULL OR earliest IS NOT NULL\)\s+AND \(NEW\."pricingMode", NEW\."wholesaleAuthorizedAt", NEW\."wholesaleConfirmedAt", NEW\."wholesaleConfirmedById"\)\s+IS DISTINCT FROM\s+\(OLD\."pricingMode", OLD\."wholesaleAuthorizedAt", OLD\."wholesaleConfirmedAt", OLD\."wholesaleConfirmedById"\) THEN/);
    expect(b).toMatch(/IF NEW\."paymentStartedAt" IS DISTINCT FROM OLD\."paymentStartedAt"\s+AND NEW\."paymentStartedAt" IS DISTINCT FROM LEAST\(OLD\."paymentStartedAt", earliest\) THEN/);
    expect(dml(b)).toEqual([]);
  });

  it('M01-M05/X01-X03 a Sale is never INSERTed with a marker: INSERT branch first, before any OLD access', () => {
    const b = frozen();
    const insertBranch = /IF TG_OP = 'INSERT' THEN\s+IF NEW\."paymentStartedAt" IS NOT NULL THEN\s+RAISE EXCEPTION '[^']+'\s+USING ERRCODE = 'check_violation';\s+END IF;\s+RETURN NEW;\s+END IF;/;
    const match = insertBranch.exec(b);
    expect(match).not.toBeNull();
    // Nothing before the branch, and no OLD reference inside it: OLD is unset on INSERT.
    expect(b.slice(0, match!.index)).toMatch(/^\s*DECLARE\s+earliest timestamptz\(3\);\s+BEGIN\s*$/);
    expect(match![0]).not.toContain('OLD');
    expect(dml(match![0])).toEqual([]);
    expect(b.indexOf('OLD.')).toBeGreaterThan(match!.index + match![0].length);
    // JS model: only NULL is admitted on INSERT, regardless of pricing mode or timestamp.
    const insertRejected = (marker: number | null) => marker !== null;
    expect(insertRejected(null)).toBe(false);   // M01
    expect(insertRejected(1)).toBe(true);       // M02/M03 any timestamp, however old
  });

  it('T11-T17/T31-T33 marker rule truth table (JS model of the two IF conditions above)', () => {
    // LEAST ignores NULLs; both NULL -> NULL (PostgreSQL semantics).
    const least = (a: number | null, b: number | null) => (a === null ? b : b === null ? a : Math.min(a, b));
    const rejected = (old: number | null, next: number | null, earliest: number | null) =>
      next !== old && next !== least(old, earliest);
    expect(rejected(null, 100, null)).toBe(true);   // T11-T13 fabricated on zero payments
    expect(rejected(null, 50, 50)).toBe(false);     // T14 truthful earliest
    expect(rejected(null, 60, 50)).toBe(true);      // not the earliest
    expect(rejected(50, 70, 50)).toBe(true);        // T16 later
    expect(rejected(50, null, 50)).toBe(true);      // T17 cleared
    expect(rejected(50, null, null)).toBe(true);    // cleared after payments gone
    expect(rejected(50, 40, 40)).toBe(false);       // T31 earlier evidence
    expect(rejected(50, 45, 40)).toBe(true);        // T32 earlier but not the evidence
    expect(rejected(50, 50, 40)).toBe(false);       // unchanged is always fine
  });

  it('T28/T29 qualified relations, no definer, no dynamic SQL, check_violation, no secrets', () => {
    for (const { name, body: b } of functions) {
      for (const m of b.matchAll(/(?<!DISTINCT )\b(FROM|UPDATE|JOIN)\s+([^\s;(]+)/g)) {
        expect(m[2], `${name}: ${m[0]}`).toMatch(/^public\."\w+"$/);
      }
      expect([...b.matchAll(/(?<!DISTINCT )\bFROM\s+public\."\w+"/g)].length, name).toBeGreaterThan(0);
      expect(b, name).not.toMatch(/\bEXECUTE\b|format\(|quote_ident|SECURITY DEFINER/i);
      expect(b, name).toMatch(/RAISE EXCEPTION '[^']+'\s+USING ERRCODE = 'check_violation';/);
      expect(b, name).not.toMatch(/\bcode\b|hash|secret/i);
    }
    expect(migration).not.toMatch(/SECURITY DEFINER/i);
    expect((migration.match(/SET search_path = pg_catalog, pg_temp/g) ?? []).length).toBe(3);
  });

  it('T30 marker column once, nullable, no default; terminal CHECK kept; no migration-time data transform', () => {
    expect((migration.match(/ADD COLUMN "paymentStartedAt" TIMESTAMPTZ\(3\);/g) ?? []).length).toBe(1);
    expect(migration).not.toMatch(/"paymentStartedAt" TIMESTAMPTZ\(3\) (NOT NULL|DEFAULT)/);
    expect(migration).toContain('ADD CONSTRAINT "chk_sale_wholesale_confirmed_when_paid" CHECK (');
    const dirs = readdirSync(new URL('../prisma/migrations/', import.meta.url)).filter((name) => name.startsWith('2026100'));
    expect(dirs).toEqual(['20261002120000_block1_pricing_wholesale', '20261006120000_pilot_pricing_v2']);
    const outside = migration.replace(/--.*$/gm, '').replace(/\$\$[\s\S]*?\$\$/g, '');
    expect(outside).not.toMatch(/^\s*(INSERT|UPDATE|DELETE|TRUNCATE|DROP|MERGE)\b/gm);
  });

  it('T09/T24 cleanup stays possible: no trigger on Sale DELETE/TRUNCATE; the history function raises only for an ineligible target', () => {
    expect(triggers.some((t) => t.table === 'Sale' && /DELETE|TRUNCATE/.test(t.events))).toBe(false);
    const b = history();
    expect((b.match(/RAISE EXCEPTION/g) ?? []).length).toBe(1);
    expect(b.indexOf('RAISE EXCEPTION')).toBeGreaterThan(b.indexOf('IF target_id IS NOT NULL THEN'));
  });
});

describe('Block 1 fix round 2 — durable payment history in the application (D01-D14 / S01-S05, S18, S31-S38)', () => {
  // The in-memory store models persisted rows only; it does NOT run the
  // PostgreSQL triggers. These prove the APPLICATION writes and honors the
  // durable marker; trigger runtime stays NOT_RUN_OWNER_GATE.
  async function wholesalePending(t: ReturnType<typeof setup>) {
    const saleId = await t.draft('seller', [[t.V1, 2n]]);
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    await t.send(saleId);
    return saleId;
  }
  const pay = (t: ReturnType<typeof setup>, saleId: string, amount: bigint) =>
    t.payments.registerPayment(t.reqs.cashier, t.ids.cashier, saleId, {
      method: 'TRANSFER', amount, receivedAmount: null, idempotencyKey: randomUUID(),
    });

  it('D01 + D02 + S02/S04 first confirmed WHOLESALE payment marks history; a second payment keeps it', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    expect(t.sale(saleId).paymentStartedAt).toBeNull();
    const first = await pay(t, saleId, 4000n);
    const marked = t.sale(saleId).paymentStartedAt as Date;
    expect(marked).toEqual(first.payment.paidAt);
    await pay(t, saleId, 10000n);
    expect(t.sale(saleId).paymentStartedAt).toEqual(marked);
  });

  it('D07 + S01 LIST payment is allowed and marks history', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 1n]]);
    await t.send(saleId);
    await pay(t, saleId, 1000n);
    expect(t.sale(saleId).paymentStartedAt).toBeInstanceOf(Date);
  });

  it('D06 + S03 + S36 unconfirmed WHOLESALE payment is denied by the app (409) and marks nothing', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    await expectAppError(pay(t, saleId, 1000n), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
    expect(t.sale(saleId).paymentStartedAt).toBeNull();
  });

  it('D03 + D04 + D05 + D08 + S07/S09/S18 deleting or moving payments never erases the marker; correction stays closed', async () => {
    const t = setup();
    const a = await wholesalePending(t);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, a);
    await pay(t, a, 1000n);
    const marked = t.sale(a).paymentStartedAt;
    // Direct removal of every payment row of A, through the store's model of
    // the BEFORE DELETE history trigger.
    const paymentDelegate = t.db.client.salePayment as { delete: (args: unknown) => Promise<unknown> };
    for (const row of [...t.db.table('salePayment')]) await paymentDelegate.delete({ where: { id: row.id } });
    expect(t.db.table('salePayment')).toHaveLength(0);
    expect(t.sale(a).paymentStartedAt).toEqual(marked);
    await expectAppError(t.correction.correctPendingSale(t.reqs.cashier, a, { items: [{ variantId: t.V1, quantity: 1n }] }), 409, 'PAYMENT_ALREADY_ACCEPTED');
    expect(t.sale(a)).toMatchObject({ wholesaleConfirmedById: t.ids.cashier, paymentStartedAt: marked });
    // A move away (A -> B) keeps A's marker; B's own first payment marks B.
    const b = await t.draft('seller', [[t.V3, 1n]]);
    await t.send(b);
    await pay(t, b, 1000n);
    expect(t.sale(b).paymentStartedAt).toBeInstanceOf(Date);
    expect(t.sale(a).paymentStartedAt).toEqual(marked);
  });

  it('D09 + D10 + S38 once payment started, the app never rewrites confirmation or pricing mode', async () => {
    const t = setup();
    const saleId = await wholesalePending(t);
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    await pay(t, saleId, 1000n);
    const before = { ...t.sale(saleId) };
    expect((await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId)).replayed).toBe(true);
    await expectAppError(t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE), 409, 'SALE_NOT_DRAFT');
    for (const field of ['pricingMode', 'wholesaleAuthorizedAt', 'wholesaleConfirmedAt', 'wholesaleConfirmedById', 'paymentStartedAt'] as const) {
      expect(t.sale(saleId)[field], field).toEqual(before[field]);
    }
  });

  it('D11 + S05/S37 a payment transaction that fails after marking rolls the marker back too', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 1n]]);
    await t.send(saleId);
    const auditCreate = (t.db.client.auditLog as { create: (...args: unknown[]) => Promise<unknown> });
    vi.spyOn(auditCreate, 'create').mockRejectedValueOnce(new Error('audit write failed'));
    await expect(pay(t, saleId, 1000n)).rejects.toThrow('audit write failed');
    expect(t.db.table('salePayment')).toHaveLength(0);
    expect(t.sale(saleId).paymentStartedAt).toBeNull();
  });
});

describe('Block 1 payment history — application with the modelled DB triggers (T39-T41)', () => {
  it('T39 marker comes only from payment evidence (app never writes it); moves earlier on older evidence, never later', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 1n]]);
    await t.send(saleId);
    const first = await t.payments.registerPayment(t.reqs.cashier, t.ids.cashier, saleId, {
      method: 'TRANSFER', amount: 1000n, receivedAmount: null, idempotencyKey: randomUUID(),
    });
    expect(t.sale(saleId).paymentStartedAt).toEqual(first.payment.paidAt);
    const payments = t.db.client.salePayment as { update: (args: unknown) => Promise<unknown> };
    const earlier = new Date((first.payment.paidAt as Date).getTime() - 86_400_000);
    await payments.update({ where: { id: first.payment.id }, data: { paidAt: earlier } }); // T34
    expect(t.sale(saleId).paymentStartedAt).toEqual(earlier);
    await payments.update({ where: { id: first.payment.id }, data: { paidAt: new Date(earlier.getTime() + 5 * 86_400_000) } }); // T35
    expect(t.sale(saleId).paymentStartedAt).toEqual(earlier);
  });

  it('T40 + T41 app gate and correction remain domain errors (no reliance on 23514)', async () => {
    const t = setup();
    const saleId = await t.draft('seller', [[t.V1, 1n]]);
    await t.sales.activateWholesale(t.reqs.seller, t.ids.seller, saleId, CODE);
    await t.send(saleId);
    await expectAppError(t.payments.registerPayment(t.reqs.cashier, t.ids.cashier, saleId, {
      method: 'TRANSFER', amount: 1n, receivedAmount: null, idempotencyKey: randomUUID(),
    }), 409, 'WHOLESALE_CONFIRMATION_REQUIRED');
    expect(t.sale(saleId).paymentStartedAt).toBeNull();
    await t.sales.confirmWholesale(t.reqs.cashier, t.ids.cashier, saleId);
    await t.payments.registerPayment(t.reqs.cashier, t.ids.cashier, saleId, {
      method: 'TRANSFER', amount: 1n, receivedAmount: null, idempotencyKey: randomUUID(),
    });
    await expectAppError(t.correction.correctPendingSale(t.reqs.cashier, saleId, { items: [{ variantId: t.V1, quantity: 1n }] }), 409, 'PAYMENT_ALREADY_ACCEPTED');
  });
});
