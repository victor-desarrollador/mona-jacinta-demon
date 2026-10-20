// R3-A4.3 S7 — T-S, the supervised stock recovery
// (POST /sales/:saleId/checkout/stock-recovery), against the DB-free double
// tests/helpers/checkout-reservation-fake-db.ts.
//
// S7-A (infrastructure only): T-S locks and rewrites Inventory, so the double
// must model it the way the services use it — the exact raw lock T-C already
// issues (branchId + variantId IN (…) ORDER BY id ASC FOR UPDATE), a computed
// `reserved` update, BigInt values, rollback and write tracking.
//
// S7-B: the T-S transaction (Serializable, 30 s, 3 attempts) and its guards —
// Sale lock → supervisor RBAC on the locked branch → CheckoutAttempt lock →
// applicability → sealed plan. The stock recovery itself (S7-C…S7-E) is not
// exercised yet: the guards are driven through lockStockRecoveryTarget inside
// inStockRecoveryTransaction, which return the locked sale and attempt.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Prisma, type PrismaClient } from '../../src/generated/prisma/client.js';
import { AppError } from '../../src/shared/errors.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';
import { PRODUCTION_PERMISSIONS } from '../../src/modules/rbac/permissions.js';
import { lineFullPrices } from '../../src/modules/pricing/proportional-checkout.js';
import {
  applyStockRecovery,
  createCheckoutStockRecoveryService,
  evaluateStockRecovery,
  inStockRecoveryTransaction,
  lockStockRecoveryTarget,
} from '../../src/modules/payments/checkout-stock-recovery.service.js';
import { TECHNICAL_HOLD_TTL_MS } from '../../src/modules/sales/reservation-holds.js';
import { createCheckoutReservationFakeDb, type Row } from '../helpers/checkout-reservation-fake-db.js';

const NOW = new Date('2026-10-17T12:00:00.000Z');
const BRANCH = '11111111-1111-4111-8111-111111111111';
const OTHER_BRANCH = '22222222-2222-4222-8222-222222222222';
// Beyond Number.MAX_SAFE_INTEGER: any Number round-trip would corrupt it.
const HUGE = 9007199254740993n;

type Tx = { $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Row[]>; inventory: { update: (args: { where: Row; data: Row }) => Promise<Row> } };

// The exact Inventory lock the services issue (checkout.service.ts T-C step 7).
const lockInventory = (tx: Tx, branchId: string, variantIds: string[]) => tx.$queryRaw`
  SELECT id, "variantId", physical, reserved
  FROM "Inventory"
  WHERE "branchId" = ${branchId}
    AND "variantId" IN (${Prisma.join(variantIds)})
  ORDER BY id ASC
  FOR UPDATE
`;

function setup() {
  const db = createCheckoutReservationFakeDb({ now: () => NOW });
  // Inserted out of id order on purpose: the lock must return id ASC.
  db.insert('inventory', { id: 'inv-c', variantId: 'var-1', branchId: BRANCH, physical: 10n, reserved: 4n });
  db.insert('inventory', { id: 'inv-a', variantId: 'var-2', branchId: BRANCH, physical: HUGE, reserved: HUGE - 1n });
  db.insert('inventory', { id: 'inv-b', variantId: 'var-3', branchId: BRANCH, physical: 5n, reserved: 0n });
  // Same variant, other branch; and a variant nobody asks for: never returned.
  db.insert('inventory', { id: 'inv-0', variantId: 'var-1', branchId: OTHER_BRANCH, physical: 99n, reserved: 0n });
  db.insert('inventory', { id: 'inv-9', variantId: 'var-9', branchId: BRANCH, physical: 1n, reserved: 0n });
  return db;
}

describe('R3-A4.3 S7-A — Inventory in the DB-free double', () => {
  it('TS-B01-INFRA the double locks Inventory (branch + variants, id ASC, BigInt), updates reserved, tracks the write and rolls back', async () => {
    const db = setup();
    const client = db.client as unknown as { $transaction: (fn: (tx: Tx) => Promise<unknown>, options?: Row) => Promise<unknown> };

    // 1. Lock + computed BigInt update inside one transaction.
    const mark = db.ops.length;
    const locked = await client.$transaction(async (tx) => {
      const rows = await lockInventory(tx, BRANCH, ['var-1', 'var-2', 'var-3']);
      const first = rows.find((row) => row.variantId === 'var-1')!;
      // reserved = reserved - ownReserved + required, written as ONE computed value.
      await tx.inventory.update({ where: { id: first.id }, data: { reserved: (first.reserved as bigint) - 2n + 3n } });
      return rows;
    }, { isolationLevel: 'Serializable', timeout: 30_000 }) as Row[];

    expect(locked.map((row) => row.id)).toEqual(['inv-a', 'inv-b', 'inv-c']);
    // The double returns whole rows (it never models column projection, like its
    // other raw locks); the selected columns must be exact.
    expect(locked.find((row) => row.id === 'inv-a')).toMatchObject({ id: 'inv-a', variantId: 'var-2', physical: HUGE, reserved: HUGE - 1n });
    expect(locked.every((row) => row.branchId === BRANCH)).toBe(true);
    expect(locked.every((row) => typeof row.physical === 'bigint' && typeof row.reserved === 'bigint')).toBe(true);
    expect(db.transactions.at(-1)).toEqual({ isolationLevel: 'Serializable', timeout: 30_000 });
    expect(db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model)).toEqual(['Inventory']);
    expect(db.writesSince(mark)).toEqual([
      { kind: 'update', model: 'inventory', detail: { where: { id: 'inv-c' }, data: { reserved: 5n } } },
    ]);
    expect(db.table('inventory').find((row) => row.id === 'inv-c')!.reserved).toBe(5n);
    // Untouched rows keep their exact BigInt values.
    expect(db.table('inventory').find((row) => row.id === 'inv-a')!.reserved).toBe(HUGE - 1n);

    // 2. A thrown callback restores Inventory exactly (rollback).
    await expect(client.$transaction(async (tx) => {
      await lockInventory(tx, BRANCH, ['var-3']);
      await tx.inventory.update({ where: { id: 'inv-b' }, data: { reserved: 5n } });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(db.ops.at(-1)).toEqual({ kind: 'rollback' });
    expect(db.table('inventory').find((row) => row.id === 'inv-b')!.reserved).toBe(0n);
    expect(db.table('inventory').find((row) => row.id === 'inv-c')!.reserved).toBe(5n);

    // 3. The lock honours injected failures like every other raw lock.
    db.failOn('inventory', 'lock', () => Object.assign(new Error('write conflict'), { code: 'P2034' }));
    await expect(client.$transaction((tx) => lockInventory(tx, BRANCH, ['var-1']))).rejects.toMatchObject({ code: 'P2034' });
  });
});

// ---------------------------------------------------------------------------
// S7-B — transaction, Sale lock, RBAC, CheckoutAttempt lock, applicability.
// ---------------------------------------------------------------------------
type Line = { variantId: string; quantity: bigint; baseUnitPrice: bigint };
// 2 × $50,00 + 1 × $30,00. Sealed with TRANSFER +10 % and CARD_DEBIT +5 %:
// cash 13000, transfer 2×5500 + 3300 = 14300, debit 2×5300 + 3200 = 13800.
const DEFAULT_LINES: Line[] = [
  { variantId: 'var-1', quantity: 2n, baseUnitPrice: 5000n },
  { variantId: 'var-2', quantity: 1n, baseUnitPrice: 3000n },
];
const TRANSFER_BPS = 1000;
const DEBIT_BPS = 500;

type Role = 'OWNER' | 'ADMIN' | 'CASHIER';
type Assignment = { roleCode: Role; locationId: string | null; permissions: string[] };
const P = PRODUCTION_PERMISSIONS;

// One request context; each assignment is COMPANY-scoped when locationId is null.
function actor(userId: string, assignments: Assignment[]) {
  return {
    auth: {
      userId,
      roles: [...new Set(assignments.map((assignment) => assignment.roleCode))],
      effectiveLocationIds: assignments.flatMap((assignment) => (assignment.locationId ? [assignment.locationId] : [])),
      assignments: assignments.map((assignment) => ({
        roleId: assignment.roleCode, roleCode: assignment.roleCode,
        scopeKind: assignment.locationId ? 'LOCATION' : 'COMPANY',
        locationId: assignment.locationId, permissions: assignment.permissions,
      })),
    },
  } as never;
}

function guardSetup() {
  const db = createCheckoutReservationFakeDb({ now: () => NOW });
  const user = (name: string) => db.insert('user', { id: randomUUID(), name });
  const owner = user('Dueño');
  const admin = user('Admin compañía');
  const cashier = user('Caja');
  const sale = (patch: Row = {}, lines: Line[] = DEFAULT_LINES) => {
    const row = db.insert('sale', {
      id: randomUUID(), branchId: BRANCH, status: 'PENDING_PAYMENT', pricingModel: 'PROPORTIONAL_V1',
      pricingMode: 'LIST', priceMode: 'CASH', paymentStartedAt: null, updatedAt: new Date(0), ...patch,
    });
    for (const line of lines) db.insert('saleItem', { saleId: row.id, sku: `SKU-${line.variantId}`, ...line });
    return row;
  };
  const items = (saleId: unknown) => db.table('saleItem').filter((item) => item.saleId === saleId);
  // Seals the attempt from the sale's CURRENT lines with the real engine, the way
  // T-R seals it: one rounding per unit, sealed basis points, BigInt end-to-end.
  const attempt = (saleRow: Row, patch: Row = {}, tenders: Row[] = [{ method: 'CASH', role: 'BALANCE' }]) => {
    const lines = items(saleRow.id).map((item) => ({
      saleItemId: item.id as string, sku: item.sku as string, quantity: item.quantity as bigint, baseUnitPrice: item.baseUnitPrice as bigint,
    }));
    const full = (bps: number) => lineFullPrices(lines, bps).reduce((sum, value) => sum + value, 0n);
    const row = db.insert('checkoutAttempt', {
      saleId: saleRow.id, branchId: saleRow.branchId, reserveKey: randomUUID(), operationKey: randomUUID(),
      planHash: 'a'.repeat(64), cashSessionId: randomUUID(), balanceMethod: 'CASH', expectedTotal: full(0),
      expectedBalanceAmount: full(0), tenderCount: tenders.length, algorithmVersion: 1, planSealed: true, startedById: cashier.id,
      fullPriceCash: full(0), fullPriceTransfer: full(TRANSFER_BPS), fullPriceDebit: full(DEBIT_BPS),
      transferAdjustmentBps: TRANSFER_BPS, debitAdjustmentBps: DEBIT_BPS, pricingConfigId: 'cfg-1', pricingConfigUpdatedAt: NOW,
      // An attempt sealed before the CARD_CREDIT block (algorithmVersion 1): no credit snapshot.
      fullPriceCredit: null, creditAdjustmentBps: null,
      ...patch,
    });
    for (const tender of tenders) db.insert('checkoutAttemptTender', { attemptId: row.id, source: 'NEW', amount: null, externalCollectionId: null, ...tender });
    return row;
  };
  const supervisorPermissions = [P.SALE_CORRECT_PENDING, P.SALE_CHARGE];
  return {
    db,
    sale,
    items,
    attempt,
    asOwner: actor(owner.id as string, [{ roleCode: 'OWNER', locationId: null, permissions: [] }]),
    asCompanyAdmin: actor(admin.id as string, [{ roleCode: 'ADMIN', locationId: null, permissions: supervisorPermissions }]),
    asLocationAdmin: actor(admin.id as string, [{ roleCode: 'ADMIN', locationId: BRANCH, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] }]),
    // A real CASHIER grant holds both permissions, and must still be refused.
    asCashier: actor(cashier.id as string, [{ roleCode: 'CASHIER', locationId: BRANCH, permissions: [...DEFAULT_ROLE_GRANTS.CASHIER] }]),
    asAdminMissingCorrect: actor(admin.id as string, [{ roleCode: 'ADMIN', locationId: null, permissions: [P.SALE_CHARGE] }]),
    asAdminMissingCharge: actor(admin.id as string, [{ roleCode: 'ADMIN', locationId: null, permissions: [P.SALE_CORRECT_PENDING] }]),
    asSplitAuthority: actor(admin.id as string, [
      { roleCode: 'ADMIN', locationId: null, permissions: [P.SALE_CORRECT_PENDING] },
      { roleCode: 'ADMIN', locationId: null, permissions: [P.SALE_CHARGE] },
    ]),
  };
}

// Runs exactly the S7-B part of T-S: the transaction plus the guards.
const guard = (t: ReturnType<typeof guardSetup>, req: unknown, saleId: string, reserveKey: string) =>
  inStockRecoveryTransaction(t.db.client as unknown as PrismaClient, (tx) => lockStockRecoveryTarget(tx, req as never, saleId, reserveKey));

const codeOf = async (promise: Promise<unknown>) => {
  try { await promise; return null; } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return { status: error.status, code: error.code, message: error.message };
  }
};

const locksSince = (t: ReturnType<typeof guardSetup>, mark: number) =>
  t.db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model);

describe('R3-A4.3 S7-B — T-S guards (DB-free)', () => {
  it('TS-B14 a REJECTED (declared or not), ABANDONED or CONFIRMED attempt is 409 STOCK_RECOVERY_NOT_APPLICABLE with zero writes', async () => {
    const terminal: Row[] = [
      { status: 'REJECTED', rejectionCode: 'NO_OPEN_CASH_SESSION', rejectedById: 'u', rejectedAt: NOW },
      { status: 'REJECTED', rejectionCode: 'NO_OPEN_CASH_SESSION', rejectedById: 'u', rejectedAt: NOW, declaredById: 'u', declaredAt: NOW },
      { status: 'ABANDONED', abandonedById: 'u', abandonedAt: NOW, declaredById: 'u', declaredAt: NOW },
      { status: 'CONFIRMED', confirmationHash: 'b'.repeat(64), confirmedById: 'u', confirmedAt: NOW },
    ];
    for (const patch of terminal) {
      const t = guardSetup();
      const sale = t.sale();
      const attempt = t.attempt(sale, patch);
      const mark = t.db.ops.length;
      expect(await codeOf(guard(t, t.asOwner, sale.id as string, attempt.reserveKey as string)), JSON.stringify(patch))
        .toMatchObject({ status: 409, code: 'STOCK_RECOVERY_NOT_APPLICABLE' });
      expect(t.db.writesSince(mark)).toEqual([]);
      expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ status: patch.status });
    }
  });

  it('TS-B15 an unknown reserveKey and a reserveKey of ANOTHER sale are the same 404 NOT_FOUND, with zero writes', async () => {
    const t = guardSetup();
    const sale = t.sale();
    const otherSale = t.sale();
    const foreign = t.attempt(otherSale);
    const mark = t.db.ops.length;
    const unknown = await codeOf(guard(t, t.asOwner, sale.id as string, randomUUID()));
    const other = await codeOf(guard(t, t.asOwner, sale.id as string, foreign.reserveKey as string));
    expect(unknown).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    // Indistinguishable: nothing reveals that the key exists on another sale.
    expect(other).toEqual(unknown);
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('TS-B16 a FIXED_TOTAL sale or a sale that is not PENDING_PAYMENT is 409 STOCK_RECOVERY_NOT_APPLICABLE', async () => {
    for (const patch of [{ pricingModel: 'FIXED_TOTAL' }, { status: 'COMPLETED' }, { status: 'CANCELLED' }, { status: 'DRAFT' }]) {
      const t = guardSetup();
      const sale = t.sale(patch);
      const attempt = t.attempt(sale);
      const mark = t.db.ops.length;
      expect(await codeOf(guard(t, t.asOwner, sale.id as string, attempt.reserveKey as string)), JSON.stringify(patch))
        .toMatchObject({ status: 409, code: 'STOCK_RECOVERY_NOT_APPLICABLE' });
      expect(t.db.writesSince(mark)).toEqual([]);
    }
  });

  it('TS-B17 a sale with any SalePayment (or a recorded paymentStartedAt) is 409 STOCK_RECOVERY_NOT_APPLICABLE', async () => {
    const withPayment = guardSetup();
    const sale = withPayment.sale();
    const attempt = withPayment.attempt(sale);
    withPayment.db.insert('salePayment', { saleId: sale.id, method: 'CASH', amount: 100n });
    expect(await codeOf(guard(withPayment, withPayment.asOwner, sale.id as string, attempt.reserveKey as string)))
      .toMatchObject({ status: 409, code: 'STOCK_RECOVERY_NOT_APPLICABLE' });

    const started = guardSetup();
    const startedSale = started.sale({ paymentStartedAt: NOW });
    const startedAttempt = started.attempt(startedSale);
    expect(await codeOf(guard(started, started.asOwner, startedSale.id as string, startedAttempt.reserveKey as string)))
      .toMatchObject({ status: 409, code: 'STOCK_RECOVERY_NOT_APPLICABLE' });
  });

  it('TS-B18 an OWNER and a COMPANY ADMIN holding SALE_CORRECT_PENDING + SALE_CHARGE pass every S7-B guard in ONE Serializable transaction', async () => {
    for (const who of ['asOwner', 'asCompanyAdmin'] as const) {
      const t = guardSetup();
      const sale = t.sale();
      const attempt = t.attempt(sale);
      const mark = t.db.ops.length;
      const target = await guard(t, t[who], sale.id as string, attempt.reserveKey as string);
      // The locked rows are handed to the (later) stock recovery; nothing else.
      expect(target.sale).toMatchObject({ id: sale.id, branchId: BRANCH, status: 'PENDING_PAYMENT' });
      expect(target.attempt).toMatchObject({ id: attempt.id, reserveKey: attempt.reserveKey, status: 'RESERVED', planSealed: true });
      expect(t.db.transactions).toEqual([{ isolationLevel: 'Serializable', timeout: 30_000 }]);
      expect(t.db.writesSince(mark)).toEqual([]);
    }
  });

  it('TS-B19 a LOCATION ADMIN, a CASHIER, a COMPANY ADMIN missing either permission and split authority are 403 after the Sale lock and before any attempt lock', async () => {
    for (const who of ['asLocationAdmin', 'asCashier', 'asAdminMissingCorrect', 'asAdminMissingCharge', 'asSplitAuthority'] as const) {
      const t = guardSetup();
      const sale = t.sale();
      const attempt = t.attempt(sale);
      const mark = t.db.ops.length;
      expect(await codeOf(guard(t, t[who], sale.id as string, attempt.reserveKey as string)), who)
        .toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(locksSince(t, mark), who).toEqual(['Sale']);
      expect(t.db.writesSince(mark)).toEqual([]);
    }
  });

  it('TS-B26 (S7-B part) Sale is locked before CheckoutAttempt; no NOWAIT, no ExternalCollection or CashSession lock', async () => {
    const t = guardSetup();
    const sale = t.sale();
    const attempt = t.attempt(sale);
    const mark = t.db.ops.length;
    await guard(t, t.asOwner, sale.id as string, attempt.reserveKey as string);
    expect(t.db.ops.slice(mark).map((op) => `${op.kind}:${op.model ?? ''}`))
      .toEqual(['begin:', 'lock:Sale', 'lock:CheckoutAttempt', 'commit:']);
    expect(JSON.stringify(t.db.ops.slice(mark))).not.toMatch(/NOWAIT/i);
  });

  it('TS-B29 an attempt whose plan is not sealed is 500 CHECKOUT_STATE_INCONSISTENT with zero writes', async () => {
    const t = guardSetup();
    const sale = t.sale();
    const attempt = t.attempt(sale, { planSealed: false });
    const mark = t.db.ops.length;
    expect(await codeOf(guard(t, t.asOwner, sale.id as string, attempt.reserveKey as string)))
      .toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('TS-B30 an unknown sale is 404 NOT_FOUND before any permission check', async () => {
    const t = guardSetup();
    const mark = t.db.ops.length;
    expect(await codeOf(guard(t, t.asCashier, randomUUID(), randomUUID()))).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(locksSince(t, mark)).toEqual(['Sale']);
  });

  it('TS-B24 a transient failure (P2034 / 40001 / 40P01) is retried; the third attempt can succeed', async () => {
    const t = guardSetup();
    const sale = t.sale();
    const attempt = t.attempt(sale);
    t.db.failOn('sale', 'lock', () => Object.assign(new Error('write conflict'), { code: 'P2034' }));
    t.db.failOn('sale', 'lock', () => Object.assign(new Error('deadlock'), { meta: { code: '40P01' } }));
    const target = await guard(t, t.asOwner, sale.id as string, attempt.reserveKey as string);
    expect(target.attempt).toMatchObject({ id: attempt.id });
    expect(t.db.transactions).toEqual(Array(3).fill({ isolationLevel: 'Serializable', timeout: 30_000 }));
  });

  it('TS-B25 three transient failures are 409 CONCURRENCY_ERROR; a non-transient error is never retried', async () => {
    const exhausted = guardSetup();
    const sale = exhausted.sale();
    const attempt = exhausted.attempt(sale);
    for (let index = 0; index < 3; index += 1) {
      exhausted.db.failOn('sale', 'lock', () => Object.assign(new Error('could not serialize access (40001)'), { meta: { code: '40001' } }));
    }
    expect(await codeOf(guard(exhausted, exhausted.asOwner, sale.id as string, attempt.reserveKey as string)))
      .toMatchObject({ status: 409, code: 'CONCURRENCY_ERROR' });
    expect(exhausted.db.transactions).toHaveLength(3);

    const fatal = guardSetup();
    const fatalSale = fatal.sale();
    const fatalAttempt = fatal.attempt(fatalSale);
    fatal.db.failOn('sale', 'lock', () => new Error('disk on fire'));
    await expect(guard(fatal, fatal.asOwner, fatalSale.id as string, fatalAttempt.reserveKey as string)).rejects.toThrow('disk on fire');
    expect(fatal.db.transactions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// S7-C — the sale's CURRENT lines must still reproduce the SEALED plan: every
// sealed full price (cash, transfer, debit) with the SEALED basis points, the
// T-C arithmetic (lineFullPrices, BigInt). Never the current pricing config.
// ---------------------------------------------------------------------------
describe('R3-A4.3 S7-C — sealed-plan coherence (DB-free)', () => {
  // Seal on the original lines, then mutate the sale and run the guards.
  async function afterMutation(mutate: (t: ReturnType<typeof guardSetup>, sale: Row) => void, lines: Line[] = DEFAULT_LINES, attemptPatch: Row = {}, tenders?: Row[]) {
    const t = guardSetup();
    const sale = t.sale({}, lines);
    const attempt = t.attempt(sale, attemptPatch, tenders);
    const sealed = { ...t.db.table('checkoutAttempt')[0]! };
    mutate(t, sale);
    const mark = t.db.ops.length;
    const result = await codeOf(guard(t, t.asOwner, sale.id as string, attempt.reserveKey as string));
    return { t, sale, attempt, sealed, mark, result };
  }

  const expectRefused = ({ t, sealed, mark, result }: Awaited<ReturnType<typeof afterMutation>>) => {
    expect(result).toMatchObject({ status: 500, code: 'CHECKOUT_PLAN_INCONSISTENT' });
    expect(t.db.writesSince(mark)).toEqual([]);
    // Refused before any stock lock; the attempt is untouched.
    expect(locksSince(t, mark)).toEqual(['Sale', 'CheckoutAttempt']);
    expect(t.db.table('checkoutAttempt')[0]).toEqual(sealed);
  };

  it('TS-B13a a changed line quantity (cash full price 13000 → 16000) is 500 CHECKOUT_PLAN_INCONSISTENT with zero writes', async () => {
    expectRefused(await afterMutation((t, sale) => { t.items(sale.id).find((item) => item.variantId === 'var-2')!.quantity = 2n; }));
  });

  it('TS-B13b a line added after the seal is 500 CHECKOUT_PLAN_INCONSISTENT', async () => {
    expectRefused(await afterMutation((t, sale) => {
      t.db.insert('saleItem', { saleId: sale.id, variantId: 'var-3', sku: 'SKU-var-3', quantity: 1n, baseUnitPrice: 1000n });
    }));
  });

  it('TS-B13c a sealed line removed after the seal is 500 CHECKOUT_PLAN_INCONSISTENT', async () => {
    expectRefused(await afterMutation((t, sale) => {
      const removed = t.items(sale.id).find((item) => item.variantId === 'var-2')!;
      t.db.tables.saleItem = t.db.tables.saleItem.filter((item) => item !== removed);
    }));
  });

  it('TS-B13d1 a recomposition that keeps the cash and transfer full prices (and expectedTotal) but changes the sealed DEBIT full price is refused — not a total-only check', async () => {
    // 2 × $50,00 → 1 × $100,00 of another variant: cash 10000 = 10000 and
    // transfer 2×5500 = 1×11000, but debit 2×5300 = 10600 ≠ 1×10500.
    const outcome = await afterMutation((t, sale) => {
      const line = t.items(sale.id).find((item) => item.variantId === 'var-1')!;
      Object.assign(line, { variantId: 'var-9', sku: 'SKU-var-9', quantity: 1n, baseUnitPrice: 10000n });
    });
    expect(outcome.sealed).toMatchObject({ fullPriceCash: 13000n, fullPriceTransfer: 14300n, fullPriceDebit: 13800n, expectedTotal: 13000n });
    expectRefused(outcome);
  });

  // Known S7 limitation (OWNER decision S7-C, option 1):
  // CheckoutAttempt does not seal line identity/composition (variantId, the
  // per-line quantities, SaleItem identity). A recomposition that preserves EVERY
  // sealed full price is invisible to T-S — and to T-C, which uses the same check.
  // S8 must prevent sale-line mutation while an attempt is open.
  // This test CHARACTERISES that gap; it is not a desired rule.
  it('TS-B13d2 KNOWN LIMITATION: a recomposition preserving every sealed full price is NOT detected', async () => {
    // (i) the same quantity and base price under another variant;
    const swapped = await afterMutation((t, sale) => {
      Object.assign(t.items(sale.id).find((item) => item.variantId === 'var-1')!, { variantId: 'var-7', sku: 'SKU-var-7' });
    });
    expect(swapped.result).toBeNull();
    // (ii) 2 × $60,00 → 1 × $120,00: cash 12000, transfer 2×6600 = 13200 and
    // debit 2×6300 = 12600 are identical either way.
    const recomposed = await afterMutation((t, sale) => {
      Object.assign(t.items(sale.id)[0]!, { variantId: 'var-8', sku: 'SKU-var-8', quantity: 1n, baseUnitPrice: 12000n });
    }, [{ variantId: 'var-6', quantity: 2n, baseUnitPrice: 6000n }]);
    expect(recomposed.result).toBeNull();
    for (const outcome of [swapped, recomposed]) expect(outcome.t.db.writesSince(outcome.mark)).toEqual([]);
  });

  it('TS-B13e an incomplete, impossible or unreproducible sealed snapshot is 500 CHECKOUT_PLAN_INCONSISTENT, never PRICING_SNAPSHOT_INCONSISTENT', async () => {
    const cases: Array<[string, Parameters<typeof afterMutation>]> = [
      // A partial pricing snapshot (bps without its full price).
      ['partial snapshot', [() => undefined, DEFAULT_LINES, { fullPriceTransfer: null }]],
      // A sealed basis point that no longer reproduces its sealed full price
      // (debit 13800 was sealed at 500 bps; at 1000 bps the lines give 14300 —
      // 600 bps would still round to 13800 and be, correctly, coherent).
      ['tampered bps', [() => undefined, DEFAULT_LINES, { debitAdjustmentBps: 1000 }]],
      // A TRANSFER tender sealed without any pricing snapshot.
      ['external tender without snapshot', [() => undefined, DEFAULT_LINES,
        { fullPriceTransfer: null, fullPriceDebit: null, transferAdjustmentBps: null, debitAdjustmentBps: null, pricingConfigId: null, pricingConfigUpdatedAt: null },
        [{ method: 'CASH', role: 'BALANCE' }, { method: 'TRANSFER', role: 'FIXED', amount: 1000n }]]],
      // A line whose base price is gone or whose quantity is invalid.
      ['null base price', [(t, sale) => { t.items(sale.id)[0]!.baseUnitPrice = null; }]],
      ['zero quantity', [(t, sale) => { t.items(sale.id)[0]!.quantity = 0n; }]],
      // No line at all.
      ['no lines', [(t, sale) => { t.db.tables.saleItem = t.db.tables.saleItem.filter((item) => item.saleId !== sale.id); }]],
      // The engine itself refuses (AMOUNT_OVERFLOW, 409): mapped, never leaked.
      ['engine overflow', [(t, sale) => { t.items(sale.id)[0]!.quantity = 9_000_000_000_000_000_000n; }]],
      // A sale not priced in CASH cannot be a proportional plan.
      ['sale not priced in cash', [(t, sale) => { t.db.table('sale').find((row) => row.id === sale.id)!.priceMode = 'LIST'; }]],
    ];
    for (const [label, args] of cases) {
      const outcome = await afterMutation(...args);
      expect(outcome.result, label).toMatchObject({ status: 500, code: 'CHECKOUT_PLAN_INCONSISTENT' });
      expect(outcome.result?.code, label).not.toBe('PRICING_SNAPSHOT_INCONSISTENT');
      expect(outcome.t.db.writesSince(outcome.mark), label).toEqual([]);
    }
  });

  // CARD_CREDIT block: a version-2 attempt seals the credit price and bps next to the others; T-S
  // must reproduce them from the sale's current lines exactly like the other sealed full prices.
  const creditSnapshot = (bps: number) => ({
    algorithmVersion: 2,
    fullPriceCredit: lineFullPrices(
      DEFAULT_LINES.map((line, index) => ({ saleItemId: `credit-${index}`, sku: line.variantId, quantity: line.quantity, baseUnitPrice: line.baseUnitPrice })), bps,
    ).reduce((sum, value) => sum + value, 0n),
    creditAdjustmentBps: bps,
  });

  it('TS-B13g a coherent sealed CARD_CREDIT snapshot passes the guard with zero writes and no stock lock', async () => {
    const tenders = [{ method: 'CASH', role: 'FIXED', amount: 3000n }, { method: 'CARD_CREDIT', role: 'BALANCE' }];
    const { t, mark, result } = await afterMutation(() => undefined, DEFAULT_LINES, creditSnapshot(1500), tenders);
    expect(result).toBeNull();
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(locksSince(t, mark)).toEqual(['Sale', 'CheckoutAttempt']);
  });

  it('TS-B13h a CARD_CREDIT snapshot that no longer reproduces (tampered bps) or is incomplete is 500 CHECKOUT_PLAN_INCONSISTENT', async () => {
    const tenders = [{ method: 'CASH', role: 'FIXED', amount: 3000n }, { method: 'CARD_CREDIT', role: 'BALANCE' }];
    const cases: Array<[string, Record<string, unknown>]> = [
      ['tampered credit bps', { ...creditSnapshot(1500), creditAdjustmentBps: 2500 }],
      ['credit price without bps', { ...creditSnapshot(1500), creditAdjustmentBps: null }],
      ['credit bps without price', { ...creditSnapshot(1500), fullPriceCredit: null }],
    ];
    for (const [label, patch] of cases) {
      const outcome = await afterMutation(() => undefined, DEFAULT_LINES, patch, tenders);
      expect(outcome.result, label).toMatchObject({ status: 500, code: 'CHECKOUT_PLAN_INCONSISTENT' });
      expect(outcome.t.db.writesSince(outcome.mark), label).toEqual([]);
    }
  });

  it('TS-B13f unchanged lines pass the coherence guard and reach the next seam with zero writes and no stock lock', async () => {
    for (const tenders of [undefined, [{ method: 'CASH', role: 'FIXED', amount: 3000n }, { method: 'TRANSFER', role: 'BALANCE' }]]) {
      const { t, attempt, mark, result } = await afterMutation(() => undefined, DEFAULT_LINES, {}, tenders);
      expect(result).toBeNull();
      expect(t.db.writesSince(mark)).toEqual([]);
      expect(locksSince(t, mark)).toEqual(['Sale', 'CheckoutAttempt']);
      expect(t.db.table('checkoutAttempt')[0]).toMatchObject({ id: attempt.id, status: 'RESERVED' });
    }
    // A sale sealed WITHOUT a pricing configuration (cash only) is coherent too.
    const cashOnly = await afterMutation(() => undefined, DEFAULT_LINES,
      { fullPriceTransfer: null, fullPriceDebit: null, transferAdjustmentBps: null, debitAdjustmentBps: null, pricingConfigId: null, pricingConfigUpdatedAt: null });
    expect(cashOnly.result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// S7-D — evaluateStockRecovery: required (current SaleItem, per variant) vs own
// (EVERY ACTIVE hold of the sale), over V = required ∪ own; locks StockReservation
// then Inventory (id ASC, FOR UPDATE), validates, and returns the recovery plan.
// It writes NOTHING: the writes are S7-E.
// ---------------------------------------------------------------------------
const SERVICE_SOURCE = new URL('../../src/modules/payments/checkout-stock-recovery.service.ts', import.meta.url);
const LATER = new Date(NOW.getTime() + 10 * 60_000);
const EARLIER = new Date(NOW.getTime() - 60_000);

describe('R3-A4.3 S7-D — evaluateStockRecovery (DB-free, zero writes)', () => {
  type Hold = { variantId: string; quantity: bigint; expiresAt?: Date; branchId?: string; status?: string; id?: string };
  type Inv = { variantId: string; physical: bigint; reserved: bigint; id?: string };

  // DEFAULT_LINES require var-1 = 2 and var-2 = 1.
  async function evaluate(holds: Hold[], inventory: Inv[], lines: Line[] = DEFAULT_LINES) {
    const t = guardSetup();
    const sale = t.sale({}, lines);
    const attempt = t.attempt(sale);
    for (const hold of holds) {
      t.db.insert('stockReservation', {
        saleId: sale.id, branchId: BRANCH, status: 'ACTIVE', expiresAt: LATER, ...hold,
      });
    }
    for (const row of inventory) t.db.insert('inventory', { branchId: BRANCH, ...row });
    const mark = t.db.ops.length;
    let evaluation: Awaited<ReturnType<typeof evaluateStockRecovery>> | null = null;
    let error: { status: number; code: string } | null = null;
    let details: unknown = null;
    // ONE run: the guards, then the evaluation, in the T-S transaction.
    try {
      await inStockRecoveryTransaction(t.db.client as unknown as PrismaClient, async (tx) => {
        const target = await lockStockRecoveryTarget(tx, t.asOwner as never, sale.id as string, attempt.reserveKey as string);
        evaluation = await evaluateStockRecovery(tx, target.sale, NOW);
      });
    } catch (caught) {
      if (!(caught instanceof AppError)) throw caught;
      error = { status: caught.status, code: caught.code };
      details = caught.details ?? null;
    }
    return { t, sale, mark, error, details, evaluation: evaluation as Awaited<ReturnType<typeof evaluateStockRecovery>> | null };
  }

  const variant = (evaluation: Awaited<ReturnType<typeof evaluateStockRecovery>> | null, variantId: string) =>
    evaluation!.variants.find((entry) => entry.variantId === variantId)!;

  const EXACT: Hold[] = [{ variantId: 'var-1', quantity: 2n }, { variantId: 'var-2', quantity: 1n }];
  // reserved already counts the sale's own holds (2 and 1) plus other sales'.
  const STOCKED: Inv[] = [
    { variantId: 'var-1', physical: 10n, reserved: 5n },
    { variantId: 'var-2', physical: 5n, reserved: 1n },
  ];

  it('TS-B03 exact, unexpired, single-row coverage with consistent Inventory is changed:false; locks Sale → CheckoutAttempt → StockReservation → Inventory; zero writes', async () => {
    const { t, mark, error, evaluation } = await evaluate(EXACT, STOCKED);
    expect(error).toBeNull();
    expect(evaluation!.changed).toBe(false);
    expect(evaluation!.now).toEqual(NOW);
    expect(variant(evaluation, 'var-1')).toMatchObject({ required: 2n, ownReserved: 2n, previousReserved: 5n, newReserved: 5n, physical: 10n });
    expect(variant(evaluation, 'var-2')).toMatchObject({ required: 1n, ownReserved: 1n, previousReserved: 1n, newReserved: 1n });
    expect(evaluation!.activeReservations).toHaveLength(2);
    expect(t.db.ops.slice(mark).filter((op) => op.kind === 'lock').map((op) => op.model))
      .toEqual(['Sale', 'CheckoutAttempt', 'StockReservation', 'Inventory']);
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('TS-B07 physical − (reserved − own) < required is 409 INSUFFICIENT_STOCK {variantId}; the own holds are discounted, never physical − reserved', async () => {
    // var-1 released by the sweeper (own 0): available 3 − 2 = 1 < 2.
    const short = await evaluate([{ variantId: 'var-2', quantity: 1n }], [
      { variantId: 'var-1', physical: 3n, reserved: 2n }, { variantId: 'var-2', physical: 5n, reserved: 1n },
    ]);
    expect(short.error).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(short.details).toEqual({ variantId: 'var-1' });
    expect(short.t.db.writesSince(short.mark)).toEqual([]);

    // physical − reserved = 4 − 4 = 0 looks short, but 2 of the 4 are this
    // sale's own (split) holds: 4 − (4 − 2) = 2 ≥ 2 → recoverable.
    const own = await evaluate([{ variantId: 'var-1', quantity: 1n }, { variantId: 'var-1', quantity: 1n }, { variantId: 'var-2', quantity: 1n }], [
      { variantId: 'var-1', physical: 4n, reserved: 4n }, { variantId: 'var-2', physical: 5n, reserved: 1n },
    ]);
    expect(own.error).toBeNull();
    expect(own.evaluation!.changed).toBe(true);
    expect(variant(own.evaluation, 'var-1')).toMatchObject({ previousReserved: 4n, ownReserved: 2n, required: 2n, newReserved: 4n, physical: 4n });
  });

  it('TS-B08 multi-variant: A covers, B does not → 409 INSUFFICIENT_STOCK {variantId: B}, zero writes', async () => {
    const { t, mark, error, details } = await evaluate([], [
      { variantId: 'var-1', physical: 10n, reserved: 0n }, { variantId: 'var-2', physical: 3n, reserved: 3n },
    ]);
    expect(error).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(details).toEqual({ variantId: 'var-2' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('TS-B09 a required variant with neither Inventory nor own hold is 409 INSUFFICIENT_STOCK {variantId}', async () => {
    const { error, details } = await evaluate([{ variantId: 'var-1', quantity: 2n }], [{ variantId: 'var-1', physical: 10n, reserved: 2n }]);
    expect(error).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(details).toEqual({ variantId: 'var-2' });
  });

  it('TS-B10 a variant with own holds but no Inventory row is 500 CHECKOUT_STATE_INCONSISTENT — orphan-only or also required', async () => {
    const orphan = await evaluate([...EXACT, { variantId: 'var-9', quantity: 3n }], STOCKED);
    expect(orphan.error).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    expect(orphan.t.db.writesSince(orphan.mark)).toEqual([]);
    const both = await evaluate(EXACT, [STOCKED[0]!]);
    expect(both.error).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
  });

  it('TS-B11 inventory.reserved < ownReserved is 500 CHECKOUT_STATE_INCONSISTENT (never clamped)', async () => {
    const { t, mark, error } = await evaluate(EXACT, [{ variantId: 'var-1', physical: 10n, reserved: 1n }, STOCKED[1]!]);
    expect(error).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('TS-B12a an ACTIVE hold of another branch is 500 CHECKOUT_STATE_INCONSISTENT (holds are not pre-filtered by branch)', async () => {
    const { error } = await evaluate([{ variantId: 'var-1', quantity: 2n, branchId: OTHER_BRANCH }, EXACT[1]!], STOCKED);
    expect(error).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
  });

  it('TS-B12b an ACTIVE hold with quantity <= 0 is 500 CHECKOUT_STATE_INCONSISTENT', async () => {
    for (const quantity of [0n, -1n]) {
      const { error } = await evaluate([...EXACT, { variantId: 'var-1', quantity }], STOCKED);
      expect(error, String(quantity)).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    }
  });

  it('TS-B31a an orphan ACTIVE hold (own > 0, required 0, Inventory present) is changed:true with newReserved = reserved − own ≤ physical', async () => {
    const { error, evaluation, t, mark } = await evaluate([...EXACT, { variantId: 'var-9', quantity: 3n }], [
      ...STOCKED, { variantId: 'var-9', physical: 10n, reserved: 5n },
    ]);
    expect(error).toBeNull();
    expect(evaluation!.changed).toBe(true);
    expect(variant(evaluation, 'var-9')).toMatchObject({ required: 0n, ownReserved: 3n, previousReserved: 5n, newReserved: 2n, physical: 10n });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  // S7-D.1 (OWNER): T-S must never write an Inventory that is still
  // over-reserved. For an orphan the sale no longer needs the variant, so the
  // overflow is other operations' corruption — a defect, not a shortage.
  it('TS-B31b an orphan whose newReserved (10 − 3 + 0 = 7) still exceeds physical 2 is 500 CHECKOUT_STATE_INCONSISTENT, zero writes', async () => {
    const { error, t, mark } = await evaluate([...EXACT, { variantId: 'var-9', quantity: 3n }], [
      ...STOCKED, { variantId: 'var-9', physical: 2n, reserved: 10n },
    ]);
    expect(error).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('TS-B31d boundary: an orphan whose newReserved (5 − 3 = 2) equals physical 2 is valid (reserved = physical is allowed)', async () => {
    const { error, evaluation } = await evaluate([...EXACT, { variantId: 'var-9', quantity: 3n }], [
      ...STOCKED, { variantId: 'var-9', physical: 2n, reserved: 5n },
    ]);
    expect(error).toBeNull();
    expect(variant(evaluation, 'var-9')).toMatchObject({ newReserved: 2n, physical: 2n });
  });

  it('TS-B31c control: a REQUIRED variant whose newReserved exceeds physical stays 409 INSUFFICIENT_STOCK {variantId}, never 500', async () => {
    // var-1: required 2, own 0 → newReserved 3 + 2 = 5 > physical 4.
    const { error, details, t, mark } = await evaluate([EXACT[1]!], [
      { variantId: 'var-1', physical: 4n, reserved: 3n }, STOCKED[1]!,
    ]);
    expect(error).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(details).toEqual({ variantId: 'var-1' });
    expect(t.db.writesSince(mark)).toEqual([]);
  });

  it('TS-B32 two ACTIVE rows of one variant (1 + 1 = required 2), all unexpired, are NOT a no-op: changed:true, own 2, newReserved unchanged in value', async () => {
    const { error, evaluation } = await evaluate([
      { variantId: 'var-1', quantity: 1n }, { variantId: 'var-1', quantity: 1n }, { variantId: 'var-2', quantity: 1n },
    ], STOCKED);
    expect(error).toBeNull();
    expect(evaluation!.changed).toBe(true);
    expect(variant(evaluation, 'var-1')).toMatchObject({ ownReserved: 2n, required: 2n, previousReserved: 5n, newReserved: 5n });
  });

  it('TS-B33 an exact single-row coverage whose review date has passed is changed:false (the clock is not a recovery trigger)', async () => {
    const { error, evaluation } = await evaluate([{ variantId: 'var-1', quantity: 2n, expiresAt: NOW }, { ...EXACT[1]!, expiresAt: EARLIER }], STOCKED);
    expect(error).toBeNull();
    expect(evaluation!.changed).toBe(false);
  });

  it('TS-B34 a missing hold for a required variant is changed:true', async () => {
    const { error, evaluation } = await evaluate([EXACT[0]!], [STOCKED[0]!, { variantId: 'var-2', physical: 5n, reserved: 0n }]);
    expect(error).toBeNull();
    expect(evaluation!.changed).toBe(true);
    expect(variant(evaluation, 'var-2')).toMatchObject({ ownReserved: 0n, required: 1n, previousReserved: 0n, newReserved: 1n });
  });

  it('TS-B35 RELEASED and CONSUMED holds never count as own: an exact ACTIVE coverage beside them is changed:false', async () => {
    const { error, evaluation } = await evaluate([
      ...EXACT,
      { variantId: 'var-1', quantity: 100n, status: 'RELEASED', expiresAt: EARLIER },
      { variantId: 'var-2', quantity: 7n, status: 'CONSUMED' },
    ], STOCKED);
    expect(error).toBeNull();
    expect(evaluation!.changed).toBe(false);
    expect(variant(evaluation, 'var-1').ownReserved).toBe(2n);
    // Exactly the two ACTIVE holds: the RELEASED 100 and the CONSUMED 7 are absent.
    const held = evaluation!.activeReservations
      .map((hold) => `${hold.variantId}:${hold.quantity}`)
      .sort();
    expect(held).toEqual(['var-1:2', 'var-2:1']);
  });

  it('TS-B36 required sums every SaleItem of the same variant; every quantity stays BigInt end-to-end', async () => {
    const { error, evaluation } = await evaluate([], [{ variantId: 'var-1', physical: 10n, reserved: 0n }], [
      { variantId: 'var-1', quantity: 2n, baseUnitPrice: 5000n }, { variantId: 'var-1', quantity: 3n, baseUnitPrice: 5000n },
    ]);
    expect(error).toBeNull();
    expect(variant(evaluation, 'var-1')).toMatchObject({ required: 5n, ownReserved: 0n, newReserved: 5n });
    for (const entry of evaluation!.variants) {
      for (const key of ['physical', 'previousReserved', 'ownReserved', 'required', 'newReserved'] as const) expect(typeof entry[key]).toBe('bigint');
    }
  });

  it('TS-B26 (S7-D part) the StockReservation and Inventory locks are ORDER BY id ASC FOR UPDATE, never NOWAIT; no ExternalCollection or CashSession lock', async () => {
    // Code only: the header comments legitimately mention "never NOWAIT".
    const source = readFileSync(SERVICE_SOURCE, 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n').replace(/\s+/g, ' ');
    expect(source).toMatch(/FROM "StockReservation" WHERE "saleId" = \$\{[^}]+\} AND status = 'ACTIVE' ORDER BY id ASC FOR UPDATE/);
    expect(source).toMatch(/FROM "Inventory" WHERE "branchId" = \$\{[^}]+\} AND "variantId" IN \(\$\{Prisma\.join\([^)]*\)\}\) ORDER BY id ASC FOR UPDATE/);
    expect(source).not.toMatch(/NOWAIT|FROM "ExternalCollection"|FROM "CashSession"/);
  });
});

// ---------------------------------------------------------------------------
// S7-E — the complete T-S: apply the evaluated plan (release EVERY own ACTIVE
// hold → Inventory.reserved = newReserved → one new ACTIVE hold per required
// variant, expiresAt = now + TTL), then the Sale.updatedAt bump, then the
// CHECKOUT_STOCK_RECOVERED audit, all in the one Serializable transaction; the
// view is read last with the same `now`. An unchanged coverage writes nothing.
// ---------------------------------------------------------------------------
describe('R3-A4.3 S7-E — applyStockRecovery + audit + view (DB-free)', () => {
  type Hold = { variantId: string; quantity: bigint; expiresAt?: Date; status?: string };
  type Inv = { variantId: string; physical: bigint; reserved: bigint };
  const NEW_EXPIRY = new Date(NOW.getTime() + TECHNICAL_HOLD_TTL_MS);
  const EXACT: Hold[] = [{ variantId: 'var-1', quantity: 2n }, { variantId: 'var-2', quantity: 1n }];
  // OWNER 2026-10-20: the clock no longer ends a hold, so the recoverable
  // coverage is valid but not one ACTIVE row per variant (var-1's 2 as 1 + 1).
  const SPLIT: Hold[] = [{ variantId: 'var-1', quantity: 1n }, { variantId: 'var-1', quantity: 1n }, { variantId: 'var-2', quantity: 1n }];
  const STOCKED: Inv[] = [
    { variantId: 'var-1', physical: 10n, reserved: 5n },
    { variantId: 'var-2', physical: 5n, reserved: 1n },
  ];
  const REQUEST = { reason: 'el posnet tardó y la reserva venció', evidence: 'cupón 0042' };

  function scenario(holds: Hold[], inventory: Inv[]) {
    const t = guardSetup();
    const sale = t.sale();
    const attempt = t.attempt(sale);
    for (const hold of holds) {
      t.db.insert('stockReservation', { saleId: sale.id, branchId: BRANCH, status: 'ACTIVE', expiresAt: LATER, ...hold });
    }
    for (const row of inventory) t.db.insert('inventory', { branchId: BRANCH, ...row });
    const service = createCheckoutStockRecoveryService(t.db.client as unknown as PrismaClient, { now: () => NOW });
    const recover = (req: unknown = t.asOwner) => service.recover(req as never, sale.id as string, { reserveKey: attempt.reserveKey as string, ...REQUEST });
    const attemptBefore = { ...t.db.table('checkoutAttempt')[0]! };
    return { t, sale, attempt, recover, attemptBefore };
  }

  const holdsOf = (t: ReturnType<typeof guardSetup>, status: string) => t.db.table('stockReservation').filter((row) => row.status === status);
  const reservedOf = (t: ReturnType<typeof guardSetup>, variantId: string) => t.db.table('inventory').find((row) => row.variantId === variantId)!.reserved;

  it('TS-B01 a split coverage is released and re-secured: new ACTIVE holds at now + TTL, reserved = newReserved, view VALID, attempt untouched', async () => {
    const { t, recover, attempt, attemptBefore } = scenario(SPLIT, STOCKED);
    const oldIds = holdsOf(t, 'ACTIVE').map((row) => row.id);
    const result = await recover();
    expect(result.changed).toBe(true);
    expect(holdsOf(t, 'RELEASED').map((row) => row.id).sort()).toEqual([...oldIds].sort());
    const created = holdsOf(t, 'ACTIVE');
    expect(created.map((row) => [row.variantId, row.quantity, row.branchId, row.expiresAt]).sort())
      .toEqual([['var-1', 2n, BRANCH, NEW_EXPIRY], ['var-2', 1n, BRANCH, NEW_EXPIRY]]);
    expect(reservedOf(t, 'var-1')).toBe(5n);
    expect(reservedOf(t, 'var-2')).toBe(1n);
    expect(result.view).toMatchObject({ reserveKey: attempt.reserveKey, status: 'RESERVED', stockState: 'VALID' });
    // Same reserveKey, operationKey, plan and snapshot: nothing of the attempt changed.
    expect(t.db.table('checkoutAttempt')[0]).toEqual(attemptBefore);
  });

  it('TS-B02 a coverage the sweeper already RELEASED is re-reserved; the old RELEASED row is never touched', async () => {
    const { t, recover } = scenario([
      { variantId: 'var-1', quantity: 2n, status: 'RELEASED', expiresAt: EARLIER },
      { variantId: 'var-2', quantity: 1n },
    ], [{ variantId: 'var-1', physical: 10n, reserved: 3n }, STOCKED[1]!]);
    const oldReleased = { ...holdsOf(t, 'RELEASED')[0]! };
    const result = await recover();
    expect(result.changed).toBe(true);
    expect(t.db.table('stockReservation').find((row) => row.id === oldReleased.id)).toEqual(oldReleased);
    expect(holdsOf(t, 'ACTIVE').map((row) => [row.variantId, row.quantity]).sort()).toEqual([['var-1', 2n], ['var-2', 1n]]);
    expect(reservedOf(t, 'var-1')).toBe(5n);
  });

  it('TS-B03 an exact unexpired coverage is changed:false: zero writes, zero audit, no bump, view VALID', async () => {
    const { t, sale, recover } = scenario(EXACT, STOCKED);
    const mark = t.db.ops.length;
    const result = await recover();
    expect(result.changed).toBe(false);
    expect(result.view).toMatchObject({ stockState: 'VALID' });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('auditLog')).toEqual([]);
    expect(t.db.table('sale').find((row) => row.id === sale.id)!.updatedAt).toEqual(new Date(0));
  });

  it('TS-B04 an orphan ACTIVE hold is released, its reserved goes down to newReserved, and nothing is re-created for it', async () => {
    const { t, recover } = scenario([...EXACT, { variantId: 'var-9', quantity: 3n }], [...STOCKED, { variantId: 'var-9', physical: 10n, reserved: 5n }]);
    const result = await recover();
    expect(result.changed).toBe(true);
    expect(reservedOf(t, 'var-9')).toBe(2n);
    expect(holdsOf(t, 'ACTIVE').some((row) => row.variantId === 'var-9')).toBe(false);
    expect(holdsOf(t, 'RELEASED').some((row) => row.variantId === 'var-9')).toBe(true);
  });

  it('TS-B05 a partial coverage replaces EVERY own ACTIVE hold with exactly one new ACTIVE per required variant, all sharing one expiresAt', async () => {
    const { t, recover } = scenario([EXACT[0]!], [STOCKED[0]!, { variantId: 'var-2', physical: 5n, reserved: 0n }]);
    const kept = holdsOf(t, 'ACTIVE')[0]!.id;
    await recover();
    expect(t.db.table('stockReservation').find((row) => row.id === kept)!.status).toBe('RELEASED');
    const active = holdsOf(t, 'ACTIVE');
    expect(active.map((row) => [row.variantId, row.quantity]).sort()).toEqual([['var-1', 2n], ['var-2', 1n]]);
    expect(new Set(active.map((row) => (row.expiresAt as Date).getTime()))).toEqual(new Set([NEW_EXPIRY.getTime()]));
    expect(reservedOf(t, 'var-2')).toBe(1n);
  });

  it('TS-B06 two ACTIVE rows of one variant (1 + 1) are both released and replaced by ONE ACTIVE of 2; reserved nets out', async () => {
    const { t, recover } = scenario([{ variantId: 'var-1', quantity: 1n }, { variantId: 'var-1', quantity: 1n }, EXACT[1]!], STOCKED);
    await recover();
    expect(holdsOf(t, 'RELEASED').filter((row) => row.variantId === 'var-1')).toHaveLength(2);
    expect(holdsOf(t, 'ACTIVE').filter((row) => row.variantId === 'var-1').map((row) => row.quantity)).toEqual([2n]);
    expect(reservedOf(t, 'var-1')).toBe(5n);
  });

  it('TS-B20 the CHECKOUT_STOCK_RECOVERED audit: entity, actor, branch, released/created rows, reserved deltas and expiry, BigInt as decimal strings', async () => {
    const { t, attempt, recover } = scenario([{ variantId: 'var-1', quantity: 2n, expiresAt: EARLIER }, { variantId: 'var-9', quantity: 3n }], [
      STOCKED[0]!, { variantId: 'var-2', physical: 5n, reserved: 0n }, { variantId: 'var-9', physical: 10n, reserved: 5n },
    ]);
    const released = holdsOf(t, 'ACTIVE').map((row) => ({ id: row.id, variantId: row.variantId, quantity: String(row.quantity), expiresAt: row.expiresAt }));
    await recover(t.asCompanyAdmin);
    const audits = t.db.table('auditLog');
    expect(audits).toHaveLength(1);
    const [audit] = audits;
    const created = holdsOf(t, 'ACTIVE').map((row) => ({ id: row.id, variantId: row.variantId, quantity: String(row.quantity), expiresAt: NEW_EXPIRY }));
    const admin = (t.asCompanyAdmin as unknown as { auth: { userId: string } }).auth.userId;
    expect(audit).toMatchObject({ action: 'CHECKOUT_STOCK_RECOVERED', entityType: 'CheckoutAttempt', entityId: attempt.id, userId: admin, branchId: BRANCH });
    const byId = (rows: Row[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect({ ...(audit!.before as Row), released: byId((audit!.before as { released: Row[] }).released) })
      // The existing stockStateOf semantics: a coverage mismatch (var-2 missing,
      // orphan var-9) is reported before expiry → RELEASED, not EXPIRED.
      .toEqual({ reserveKey: attempt.reserveKey, stockState: 'RELEASED', released: byId(released) });
    expect({ ...(audit!.after as Row), created: byId((audit!.after as { created: Row[] }).created) }).toEqual({
      reserveKey: attempt.reserveKey, reason: REQUEST.reason, evidence: REQUEST.evidence, created: byId(created), expiresAt: NEW_EXPIRY,
      reservedDeltaByVariant: [
        { variantId: 'var-1', beforeReserved: '5', afterReserved: '5', delta: '0' },
        { variantId: 'var-2', beforeReserved: '0', afterReserved: '1', delta: '1' },
        { variantId: 'var-9', beforeReserved: '5', afterReserved: '2', delta: '-3' },
      ],
    });
  });

  it('TS-B21 a failing audit rolls everything back: old holds ACTIVE again, no new hold, reserved and updatedAt restored, no audit', async () => {
    const { t, sale, recover } = scenario(SPLIT, STOCKED);
    const before = structuredClone({ holds: t.db.table('stockReservation'), inventory: t.db.table('inventory') });
    t.db.failOn('auditLog', 'create', () => new Error('audit down'), false);
    await expect(recover()).rejects.toThrow('audit down');
    expect(t.db.table('stockReservation')).toEqual(before.holds);
    expect(t.db.table('inventory')).toEqual(before.inventory);
    expect(t.db.table('sale').find((row) => row.id === sale.id)!.updatedAt).toEqual(new Date(0));
    expect(t.db.table('auditLog')).toEqual([]);
  });

  it('TS-B22 changed:true bumps Sale.updatedAt exactly once (to the operation now); changed:false never', async () => {
    const changed = scenario(SPLIT, STOCKED);
    const mark = changed.t.db.ops.length;
    await changed.recover();
    const saleWrites = changed.t.db.writesSince(mark).filter((op) => op.model === 'sale' || op.model === 'Sale');
    expect(saleWrites).toEqual([{ kind: 'update', model: 'sale', detail: { where: { id: changed.sale.id }, data: { updatedAt: NOW } } }]);

    const unchanged = scenario(EXACT, STOCKED);
    const quiet = unchanged.t.db.ops.length;
    await unchanged.recover();
    expect(unchanged.t.db.writesSince(quiet).filter((op) => op.model === 'sale' || op.model === 'Sale')).toEqual([]);
  });

  it('TS-B23 every written quantity and reserved value is BigInt; the service computes stock without Number/parseFloat/Math', async () => {
    const { t, recover } = scenario([{ variantId: 'var-1', quantity: 2n, expiresAt: EARLIER }], [
      { variantId: 'var-1', physical: 9007199254740993n, reserved: 9007199254740992n }, { variantId: 'var-2', physical: 5n, reserved: 0n },
    ]);
    await recover();
    expect(reservedOf(t, 'var-1')).toBe(9007199254740992n);
    for (const row of t.db.table('stockReservation')) expect(typeof row.quantity).toBe('bigint');
    for (const row of t.db.table('inventory')) expect(typeof row.reserved).toBe('bigint');
    const code = readFileSync(SERVICE_SOURCE, 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/\bNumber\(|parseFloat|parseInt|Math\.|increment|decrement/);
  });

  it('TS-B28 T-S writes only StockReservation, Inventory, the Sale.updatedAt bump and the audit — never the attempt, tenders, collections, cash or payments', async () => {
    const { t, recover } = scenario([...SPLIT, { variantId: 'var-9', quantity: 1n }], [
      ...STOCKED, { variantId: 'var-9', physical: 5n, reserved: 1n },
    ]);
    const mark = t.db.ops.length;
    await recover();
    const models = new Set(t.db.writesSince(mark).map((op) => op.model));
    expect([...models].sort()).toEqual(['auditLog', 'inventory', 'sale', 'stockReservation']);
    const saleData = t.db.writesSince(mark).filter((op) => op.model === 'sale').map((op) => Object.keys((op.detail as { data: Row }).data));
    expect(saleData).toEqual([['updatedAt']]);
  });

  it('TS-B40 write order: release old ACTIVE → Inventory updates → new ACTIVE holds → Sale.updatedAt → audit, all after the locks', async () => {
    const { t, recover } = scenario(SPLIT, STOCKED);
    const mark = t.db.ops.length;
    await recover();
    expect(t.db.ops.slice(mark).filter((op) => op.kind !== 'begin' && op.kind !== 'commit').map((op) => `${op.kind}:${op.model}`)).toEqual([
      'lock:Sale', 'lock:CheckoutAttempt', 'lock:StockReservation', 'lock:Inventory',
      'updateMany:stockReservation', 'updateMany:inventory', 'updateMany:inventory',
      'create:stockReservation', 'create:stockReservation', 'update:sale', 'create:auditLog',
    ]);
  });

  it('TS-B41 an identical second call right after a recovery is changed:false with zero writes; the attempt keeps its keys', async () => {
    const { t, recover, attemptBefore } = scenario(SPLIT, STOCKED);
    expect((await recover()).changed).toBe(true);
    const mark = t.db.ops.length;
    const again = await recover();
    expect(again.changed).toBe(false);
    expect(again.view).toMatchObject({ stockState: 'VALID' });
    expect(t.db.writesSince(mark)).toEqual([]);
    expect(t.db.table('auditLog')).toHaveLength(1);
    // CC-01: one effective recovery — a single, exact ACTIVE coverage.
    expect(holdsOf(t, 'ACTIVE').map((row) => [row.variantId, row.quantity]).sort()).toEqual([['var-1', 2n], ['var-2', 1n]]);
    expect(t.db.table('checkoutAttempt')[0]).toEqual(attemptBefore);
  });

  // Apply guards: the plan must still match the locked rows, or the whole unit
  // fails closed. Driven by applying a plan that no longer matches.
  async function applyStale(mutatePlan: (evaluation: Awaited<ReturnType<typeof evaluateStockRecovery>>) => void) {
    const { t, sale } = scenario(SPLIT, STOCKED);
    const before = structuredClone({ holds: t.db.table('stockReservation'), inventory: t.db.table('inventory') });
    const outcome = await codeOf(inStockRecoveryTransaction(t.db.client as unknown as PrismaClient, async (tx) => {
      const evaluation = await evaluateStockRecovery(tx, { id: sale.id as string, branchId: BRANCH }, NOW);
      mutatePlan(evaluation);
      await applyStockRecovery(tx, { id: sale.id as string, branchId: BRANCH }, evaluation);
    }));
    return { t, before, outcome };
  }

  it('TS-B37 a release that updates fewer ACTIVE rows than evaluated is 500 CHECKOUT_STATE_INCONSISTENT with a total rollback', async () => {
    const { t, before, outcome } = await applyStale((evaluation) => {
      evaluation.activeReservations.push({ ...evaluation.activeReservations[0]!, id: randomUUID() });
    });
    expect(outcome).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    expect(t.db.table('stockReservation')).toEqual(before.holds);
    expect(t.db.table('inventory')).toEqual(before.inventory);
  });

  it('TS-B38 an Inventory update that matches no row (not the locked row/value) is 500 CHECKOUT_STATE_INCONSISTENT, never a raw ORM error', async () => {
    const { t, before, outcome } = await applyStale((evaluation) => { evaluation.variants[1]!.previousReserved += 1n; });
    expect(outcome).toMatchObject({ status: 500, code: 'CHECKOUT_STATE_INCONSISTENT' });
    expect(t.db.table('inventory')).toEqual(before.inventory);
    expect(t.db.table('stockReservation')).toEqual(before.holds);
  });

  it('TS-B39 a failure creating the SECOND new hold rolls back the release, the Inventory and the first new hold', async () => {
    const { t, recover } = scenario(SPLIT, STOCKED);
    const before = structuredClone({ holds: t.db.table('stockReservation'), inventory: t.db.table('inventory') });
    const delegate = (t.db.client as unknown as { stockReservation: { create: (args: unknown) => Promise<unknown> } }).stockReservation;
    const original = delegate.create;
    let calls = 0;
    delegate.create = async (args) => {
      calls += 1;
      if (calls === 2) throw new Error('hold insert failed');
      return original(args);
    };
    await expect(recover()).rejects.toThrow('hold insert failed');
    expect(calls).toBe(2);
    expect(t.db.table('stockReservation')).toEqual(before.holds);
    expect(t.db.table('inventory')).toEqual(before.inventory);
    expect(t.db.table('auditLog')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// S7-F — retry semantics provable without PostgreSQL. Each attempt is a NEW
// transaction that re-runs the whole unit from the Sale lock: guards, RBAC,
// attempt lock, plan coherence, evaluation. A peer that commits BETWEEN two
// attempts is simulated by mutating the double after attempt 1's rollback and
// before attempt 2 begins. Real locks, real 40001/40P01, real blocking and real
// concurrent overselling are PostgreSQL-only (P43/P44) and are not faked here.
// ---------------------------------------------------------------------------
describe('R3-A4.3 S7-F — T-S retries re-run everything from scratch (DB-free)', () => {
  type Inv = { variantId: string; physical: bigint; reserved: bigint };
  // A valid coverage that is not one ACTIVE row per variant: recoverable (the clock no longer is).
  const EXPIRED = [
    { variantId: 'var-1', quantity: 1n, expiresAt: LATER },
    { variantId: 'var-1', quantity: 1n, expiresAt: LATER },
    { variantId: 'var-2', quantity: 1n, expiresAt: LATER },
  ];
  const STOCKED: Inv[] = [
    { variantId: 'var-1', physical: 10n, reserved: 5n },
    { variantId: 'var-2', physical: 5n, reserved: 1n },
  ];
  const transientError = () => Object.assign(new Error('could not serialize access'), { code: 'P2034' });

  function scenario(req?: unknown) {
    const t = guardSetup();
    const sale = t.sale();
    const attempt = t.attempt(sale);
    for (const hold of EXPIRED) t.db.insert('stockReservation', { saleId: sale.id, branchId: BRANCH, status: 'ACTIVE', ...hold });
    for (const row of STOCKED) t.db.insert('inventory', { branchId: BRANCH, ...row });
    const service = createCheckoutStockRecoveryService(t.db.client as unknown as PrismaClient, { now: () => NOW });
    const actorReq = req ?? t.asOwner;
    const recover = () => service.recover(actorReq as never, sale.id as string, { reserveKey: attempt.reserveKey as string, reason: 'reserva vencida en caja', evidence: 'cupón 7' });
    return { t, sale, attempt, recover, actorReq };
  }

  // Runs `mutate` once, right before the SECOND transaction begins — i.e. after
  // attempt 1 rolled back, as if a peer had committed in between.
  function betweenAttempts(t: ReturnType<typeof guardSetup>, mutate: () => void) {
    const client = t.db.client as unknown as { $transaction: (...args: unknown[]) => Promise<unknown> };
    const original = client.$transaction;
    let opened = 0;
    client.$transaction = async (...args) => {
      opened += 1;
      if (opened === 2) mutate();
      return original(...args);
    };
  }

  const lockSequence = (t: ReturnType<typeof guardSetup>, mark: number) =>
    t.db.ops.slice(mark).filter((op) => ['begin', 'lock', 'rollback', 'commit'].includes(op.kind)).map((op) => `${op.kind}${op.model ? `:${op.model}` : ''}`);

  it('CC-02 T-X closes the attempt between two attempts: the retry re-locks it and answers 409 STOCK_RECOVERY_NOT_APPLICABLE, not the old transient; nothing of T-S is committed', async () => {
    const { t, sale, attempt, recover } = scenario();
    const holdsBefore = structuredClone(t.db.table('stockReservation'));
    const inventoryBefore = structuredClone(t.db.table('inventory'));
    // Attempt 1 fails while applying (after the evaluation).
    t.db.failOn('stockReservation', 'updateMany', transientError);
    betweenAttempts(t, () => {
      Object.assign(t.db.table('checkoutAttempt').find((row) => row.id === attempt.id)!, {
        status: 'ABANDONED', abandonedById: 'u', abandonedAt: NOW, declaredById: 'u', declaredAt: NOW,
      });
    });
    const mark = t.db.ops.length;
    expect(await codeOf(recover())).toMatchObject({ status: 409, code: 'STOCK_RECOVERY_NOT_APPLICABLE' });
    expect(t.db.transactions).toHaveLength(2);
    // The retry re-ran the guards from the Sale lock.
    expect(lockSequence(t, mark)).toEqual([
      'begin', 'lock:Sale', 'lock:CheckoutAttempt', 'lock:StockReservation', 'lock:Inventory', 'rollback',
      'begin', 'lock:Sale', 'lock:CheckoutAttempt', 'rollback',
    ]);
    expect(t.db.table('stockReservation')).toEqual(holdsBefore);
    expect(t.db.table('inventory')).toEqual(inventoryBefore);
    expect(t.db.table('auditLog')).toEqual([]);
    expect(t.db.table('sale').find((row) => row.id === sale.id)!.updatedAt).toEqual(new Date(0));
  });

  it('CC-03 T-C completes the sale between two attempts: the retry re-reads the Sale and answers 409 STOCK_RECOVERY_NOT_APPLICABLE with zero committed writes', async () => {
    const { t, sale, recover } = scenario();
    const holdsBefore = structuredClone(t.db.table('stockReservation'));
    // Attempt 1 fails while applying, i.e. AFTER it locked and read the Sale.
    t.db.failOn('stockReservation', 'updateMany', transientError);
    betweenAttempts(t, () => { t.db.table('sale').find((row) => row.id === sale.id)!.status = 'COMPLETED'; });
    expect(await codeOf(recover())).toMatchObject({ status: 409, code: 'STOCK_RECOVERY_NOT_APPLICABLE' });
    expect(t.db.transactions).toHaveLength(2);
    expect(t.db.table('stockReservation')).toEqual(holdsBefore);
    expect(t.db.table('auditLog')).toEqual([]);
  });

  // Structural: RBAC runs INSIDE the retried unit. In production req.auth does
  // not change during one request; this proves the check is re-evaluated per
  // attempt (never cached outside the retry loop).
  it('CC-04 authority is re-evaluated on every attempt: an actor that no longer qualifies gets 403 on the retry, before the attempt is locked, with zero writes', async () => {
    const { t, recover, actorReq } = scenario();
    t.db.failOn('stockReservation', 'updateMany', transientError);
    betweenAttempts(t, () => {
      (actorReq as { auth: { assignments: Array<Record<string, unknown>> } }).auth.assignments = [
        { roleId: 'ADMIN', roleCode: 'ADMIN', scopeKind: 'LOCATION', locationId: BRANCH, permissions: [...DEFAULT_ROLE_GRANTS.ADMIN] },
      ];
    });
    const mark = t.db.ops.length;
    expect(await codeOf(recover())).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    const sequence = lockSequence(t, mark);
    expect(sequence.slice(sequence.lastIndexOf('begin'))).toEqual(['begin', 'lock:Sale', 'rollback']);
    expect(t.db.table('auditLog')).toEqual([]);
  });

  it('CC-05 the evaluation of an aborted attempt is never reused: the retry re-evaluates against the new state — new values applied, or a shortage refused', async () => {
    // (a) Another sale reserved 3 more of var-1 in between: still enough
    // (10 − (8 − 2) = 4 ≥ 2), and the applied reserved is 8 − 2 + 2 = 8, not 5.
    const fresh = scenario();
    fresh.t.db.failOn('stockReservation', 'updateMany', transientError);
    betweenAttempts(fresh.t, () => { fresh.t.db.table('inventory').find((row) => row.variantId === 'var-1')!.reserved = 8n; });
    const mark = fresh.t.db.ops.length;
    expect((await fresh.recover()).changed).toBe(true);
    expect(fresh.t.db.table('inventory').find((row) => row.variantId === 'var-1')!.reserved).toBe(8n);
    const audit = fresh.t.db.table('auditLog')[0]!.after as { reservedDeltaByVariant: Row[] };
    expect(audit.reservedDeltaByVariant[0]).toEqual({ variantId: 'var-1', beforeReserved: '8', afterReserved: '8', delta: '0' });
    expect(lockSequence(fresh.t, mark).filter((entry) => entry === 'lock:Inventory')).toHaveLength(2);

    // (b) Another sale took the rest of var-1 in between: 10 − (11 − 2) = 1 < 2.
    const short = scenario();
    short.t.db.failOn('stockReservation', 'updateMany', transientError);
    betweenAttempts(short.t, () => { short.t.db.table('inventory').find((row) => row.variantId === 'var-1')!.reserved = 11n; });
    expect(await codeOf(short.recover())).toMatchObject({ status: 409, code: 'INSUFFICIENT_STOCK' });
    expect(short.t.db.table('stockReservation').filter((row) => row.status === 'ACTIVE')).toHaveLength(EXPIRED.length);
    expect(short.t.db.table('auditLog')).toEqual([]);
  });

  it('CC-06 a domain refusal never triggers a second attempt (STATE/PLAN inconsistency, INSUFFICIENT_STOCK, NOT_APPLICABLE, FORBIDDEN)', async () => {
    const cases: Array<[string, (s: ReturnType<typeof scenario>) => void, string]> = [
      ['unsealed plan', (s) => { s.t.db.table('checkoutAttempt')[0]!.planSealed = false; }, 'CHECKOUT_STATE_INCONSISTENT'],
      ['changed lines', (s) => { s.t.items(s.sale.id)[0]!.quantity = 9n; }, 'CHECKOUT_PLAN_INCONSISTENT'],
      ['no stock', (s) => { s.t.db.table('inventory').find((row) => row.variantId === 'var-1')!.physical = 1n; }, 'INSUFFICIENT_STOCK'],
      ['sale completed', (s) => { s.t.db.table('sale')[0]!.status = 'COMPLETED'; }, 'STOCK_RECOVERY_NOT_APPLICABLE'],
    ];
    for (const [label, mutate, code] of cases) {
      const s = scenario();
      mutate(s);
      expect(await codeOf(s.recover()), label).toMatchObject({ code });
      expect(s.t.db.transactions, label).toHaveLength(1);
    }
    const forbidden = scenario(guardSetup().asCashier);
    expect(await codeOf(forbidden.recover())).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect(forbidden.t.db.transactions).toHaveLength(1);
  });

  it('CC-06b the transient classifier stays P2034 / 40001 / 40P01: NOWAIT (55P03), P2002 and P2025 are never retried', async () => {
    for (const error of [
      Object.assign(new Error('lock not available'), { meta: { code: '55P03' } }),
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      Object.assign(new Error('Record not found'), { code: 'P2025' }),
    ]) {
      const s = scenario();
      s.t.db.failOn('sale', 'lock', () => error);
      await expect(s.recover()).rejects.toBe(error);
      expect(s.t.db.transactions).toHaveLength(1);
    }
  });

  it('CC-07 a transient AFTER every write (at the audit) rolls attempt 1 back entirely; only the retried attempt is committed — one coverage, one audit, one bump', async () => {
    const { t, sale, recover } = scenario();
    t.db.failOn('auditLog', 'create', transientError);
    const result = await recover();
    expect(result.changed).toBe(true);
    expect(t.db.transactions).toHaveLength(2);
    expect(t.db.table('stockReservation').filter((row) => row.status === 'ACTIVE').map((row) => [row.variantId, row.quantity]).sort())
      .toEqual([['var-1', 2n], ['var-2', 1n]]);
    expect(t.db.table('stockReservation').filter((row) => row.status === 'RELEASED')).toHaveLength(EXPIRED.length);
    expect(t.db.table('inventory').map((row) => row.reserved)).toEqual([5n, 1n]);
    expect(t.db.table('auditLog')).toHaveLength(1);
    expect(t.db.table('sale').find((row) => row.id === sale.id)!.updatedAt).toEqual(NOW);
  });
});
