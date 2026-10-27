// Block 1: an in-memory stand-in for the subset of PrismaClient that the
// sales, payments, pending-correction and catalog-admin services call. It
// lets those REAL services run with zero database contact (no Prisma
// engine, no pg Pool, no network). It is deliberately strict: an operator,
// relation or raw query it does not understand throws, so a test can never
// pass because the fake silently ignored a filter.
//
// MODEL OF THE BLOCK 1 PAYMENT-HISTORY ROW TRIGGERS (not proof of them):
// Sale.paymentStartedAt is maintained only by the database, so this store
// mirrors the row-level rule of fn_sale_payment_history — record a Sale's
// earliest current SalePayment.paidAt (moving it earlier, never later or to
// NULL) after a payment is created/moved/edited, and before one is deleted
// or moved away. PostgreSQL trigger runtime stays NOT_RUN_OWNER_GATE.
//
// Fidelity limits (by design, documented for reviewers):
// - `$transaction` runs callbacks serially and restores a full snapshot on
//   throw (atomic rollback); it does not model isolation levels or races.
// - `select` returns exactly the selected scalars plus requested relations;
//   `include` returns every scalar column plus the requested relations.
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;
type Tables = Record<string, Row[]>;
type Args = Record<string, unknown>;

const MODELS = [
  'company', 'companyPricingConfig', 'location', 'branch', 'user', 'product', 'productVariant', 'inventory', 'sale', 'saleItem',
  'salePayment', 'stockReservation', 'stockMovement', 'saleNumberCounter', 'auditLog',
  'cashRegister', 'cashSession', 'cashMovement',
] as const;
// Sale void (post-payment): opt-in models, so the 18-table store that existing
// tests assert on is unchanged unless a test asks for them (`withSaleVoid`).
const SALE_VOID_MODELS = ['saleVoid', 'saleVoidExternalRefund', 'externalCollection'] as const;
// Sale exchange (post-sale garment swap): opt-in models, same contract as `withSaleVoid`.
const SALE_EXCHANGE_MODELS = ['saleExchange', 'saleExchangeLine'] as const;
type Model = (typeof MODELS)[number] | (typeof SALE_VOID_MODELS)[number] | (typeof SALE_EXCHANGE_MODELS)[number];

type Relation = { model: Model; kind: 'one' | 'many'; local: string; foreign: string };
const RELATIONS: Partial<Record<Model, Record<string, Relation>>> = {
  sale: {
    items: { model: 'saleItem', kind: 'many', local: 'id', foreign: 'saleId' },
    payments: { model: 'salePayment', kind: 'many', local: 'id', foreign: 'saleId' },
    stockReservations: { model: 'stockReservation', kind: 'many', local: 'id', foreign: 'saleId' },
    branch: { model: 'branch', kind: 'one', local: 'branchId', foreign: 'id' },
    seller: { model: 'user', kind: 'one', local: 'sellerId', foreign: 'id' },
    // Only with `withSaleVoid` (UNIQUE(saleId) on SaleVoid).
    saleVoid: { model: 'saleVoid', kind: 'one', local: 'id', foreign: 'saleId' },
    // Only with `withSaleExchange` (a sale may have many exchanges).
    exchanges: { model: 'saleExchange', kind: 'many', local: 'id', foreign: 'saleId' },
    wholesaleConfirmedBy: { model: 'user', kind: 'one', local: 'wholesaleConfirmedById', foreign: 'id' },
  },
  saleItem: {
    variant: { model: 'productVariant', kind: 'one', local: 'variantId', foreign: 'id' },
    sale: { model: 'sale', kind: 'one', local: 'saleId', foreign: 'id' },
  },
  productVariant: {
    product: { model: 'product', kind: 'one', local: 'productId', foreign: 'id' },
  },
  stockReservation: {
    sale: { model: 'sale', kind: 'one', local: 'saleId', foreign: 'id' },
  },
  saleVoid: {
    voidedBy: { model: 'user', kind: 'one', local: 'voidedById', foreign: 'id' },
  },
  saleExchange: {
    lines: { model: 'saleExchangeLine', kind: 'many', local: 'id', foreign: 'saleExchangeId' },
  },
};

const DEFAULTS: Partial<Record<Model, () => Row>> = {
  sale: () => ({
    saleNumber: null, status: 'DRAFT', subtotal: 0n, discountTotal: 0n, total: 0n,
    pricingMode: 'LIST', priceMode: 'LIST', wholesaleAuthorizedAt: null, wholesaleConfirmedById: null, wholesaleConfirmedAt: null,
    paymentStartedAt: null,
    createdAt: new Date(), updatedAt: new Date(),
  }),
  productVariant: () => ({ wholesalePrice: null, isActive: true, color: null, size: null }),
  companyPricingConfig: () => ({
    listAdjustmentBps: 0,
    creditCardAdjustmentBps: 0,
    debitCardAdjustmentBps: 0,
    bankTransferAdjustmentBps: 0,
    qrAdjustmentBps: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
  salePayment: () => ({ receivedAmount: null, changeAmount: null, cashSessionId: null, paidAt: new Date() }),
  auditLog: () => ({ before: null, after: null, timestamp: new Date() }),
  saleVoid: () => ({ voidedAt: new Date() }),
  saleExchange: () => ({ createdAt: new Date() }),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !(value instanceof Date) && !Array.isArray(value);
}

function unsupported(what: string): never {
  throw new Error(`in-memory-sales-db: unsupported ${what}`);
}

export function createInMemorySalesDb(options: { withSaleVoid?: boolean; withSaleExchange?: boolean } = {}) {
  const models: readonly Model[] = [
    ...MODELS,
    ...(options.withSaleVoid ? SALE_VOID_MODELS : []),
    ...(options.withSaleExchange ? SALE_EXCHANGE_MODELS : []),
  ];
  let tables: Tables = Object.fromEntries(models.map((model) => [model, [] as Row[]]));
  const rawQueries: string[] = [];

  function rows(model: Model) {
    return tables[model]!;
  }

  function related(model: Model, row: Row, name: string): Row[] | Row | null {
    const relation = RELATIONS[model]?.[name];
    if (!relation) unsupported(`relation ${model}.${name}`);
    const matches = rows(relation.model).filter((candidate) => candidate[relation.foreign] === row[relation.local]);
    return relation.kind === 'many' ? matches : (matches[0] ?? null);
  }

  function matchesValue(actual: unknown, condition: unknown): boolean {
    if (!isPlainObject(condition)) return actual === condition;
    return Object.entries(condition).every(([operator, expected]) => {
      if (operator === 'in') return (expected as unknown[]).includes(actual);
      if (operator === 'not') return actual !== expected;
      if (operator === 'lte') return (actual as Date | bigint) <= (expected as Date | bigint);
      return unsupported(`operator ${operator}`);
    });
  }

  function matches(model: Model, row: Row, where: unknown): boolean {
    if (where === undefined) return true;
    if (!isPlainObject(where)) return unsupported('where shape');
    return Object.entries(where).every(([key, condition]) => {
      if (condition === undefined) return true;
      if (key === 'OR') return (condition as unknown[]).some((part) => matches(model, row, part));
      if (key === 'saleId_idempotencyKey') return matches(model, row, condition);
      const relation = RELATIONS[model]?.[key];
      if (relation) {
        if (relation.kind === 'many') return unsupported(`to-many relation filter ${model}.${key}`);
        const target = related(model, row, key) as Row | null;
        return target !== null && matches(relation.model, target, condition);
      }
      return matchesValue(row[key], condition);
    });
  }

  function compare(a: unknown, b: unknown) {
    if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
    if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
    return String(a).localeCompare(String(b));
  }

  function sort(list: Row[], orderBy: unknown) {
    if (orderBy === undefined) return list;
    const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<string, unknown>[];
    return [...list].sort((left, right) => {
      for (const key of keys) {
        for (const [field, direction] of Object.entries(key)) {
          if (typeof direction !== 'string') continue; // nested relation ordering: not modelled
          const result = compare(left[field], right[field]);
          if (result !== 0) return direction === 'desc' ? -result : result;
        }
      }
      return 0;
    });
  }

  function project(model: Model, row: Row, args: Args | undefined): Row {
    const shape = (args?.include ?? args?.select) as Record<string, unknown> | undefined;
    // `select` returns exactly the selected scalars (like Prisma); `include`
    // and no shape return every scalar column.
    const copy: Row = args?.select
      ? Object.fromEntries(Object.entries(row).filter(([key]) => (args.select as Record<string, unknown>)[key] === true))
      : { ...row };
    if (!shape) return copy;
    for (const [key, spec] of Object.entries(shape)) {
      if (!spec || !RELATIONS[model]?.[key]) continue;
      const relation = RELATIONS[model]![key]!;
      const nested = isPlainObject(spec) ? (spec as Args) : undefined;
      const value = related(model, row, key);
      if (Array.isArray(value)) {
        const filtered = value.filter((candidate) => matches(relation.model, candidate, nested?.where));
        copy[key] = sort(filtered, nested?.orderBy).map((candidate) => project(relation.model, candidate, nested));
      } else {
        copy[key] = value ? project(relation.model, value, nested) : null;
      }
    }
    return copy;
  }

  // Model of fn_sale_payment_history's marking rule (see header).
  function recordPaymentHistory(saleId: unknown) {
    const sale = rows('sale').find((row) => row.id === saleId);
    const paid = rows('salePayment').filter((row) => row.saleId === saleId).map((row) => row.paidAt as Date);
    if (!sale || paid.length === 0) return;
    const earliest = new Date(Math.min(...paid.map((date) => date.getTime())));
    const marker = sale.paymentStartedAt as Date | null;
    if (marker === null || earliest < marker) sale.paymentStartedAt = earliest;
  }

  function applyData(row: Row, data: Row) {
    for (const [key, value] of Object.entries(data)) {
      if (isPlainObject(value) && 'increment' in value) {
        row[key] = (row[key] as bigint) + (value.increment as bigint);
      } else if (value !== undefined) {
        row[key] = value;
      }
    }
    if ('updatedAt' in row) row.updatedAt = new Date();
  }

  function delegate(model: Model) {
    const findMany = async (args: Args = {}) =>
      sort(rows(model).filter((row) => matches(model, row, args.where)), args.orderBy)
        .slice(0, typeof args.take === 'number' ? args.take : undefined)
        .map((row) => project(model, row, args));
    const findFirst = async (args: Args = {}) => (await findMany(args))[0] ?? null;
    return {
      findMany,
      findFirst,
      findUnique: findFirst,
      findUniqueOrThrow: async (args: Args) => {
        const found = await findFirst(args);
        if (!found) throw new Error(`in-memory-sales-db: ${model} not found`);
        return found;
      },
      count: async (args: Args = {}) => rows(model).filter((row) => matches(model, row, args.where)).length,
      create: async (args: Args) => {
        const row: Row = { id: randomUUID(), ...(DEFAULTS[model]?.() ?? {}), ...(args.data as Row) };
        rows(model).push(row);
        if (model === 'salePayment') recordPaymentHistory(row.saleId); // AFTER INSERT
        return project(model, row, args);
      },
      update: async (args: Args) => {
        const row = rows(model).find((candidate) => matches(model, candidate, args.where));
        if (!row) throw new Error(`in-memory-sales-db: ${model} update target not found`);
        if (model === 'salePayment') recordPaymentHistory(row.saleId); // BEFORE (source)
        applyData(row, args.data as Row);
        if (model === 'salePayment') recordPaymentHistory(row.saleId); // AFTER (target)
        return project(model, row, args);
      },
      upsert: async (args: Args) => {
        const row = rows(model).find((candidate) => matches(model, candidate, args.where));
        if (row) {
          applyData(row, args.update as Row);
          return project(model, row, args);
        }
        const created: Row = { id: randomUUID(), ...(DEFAULTS[model]?.() ?? {}), ...(args.create as Row) };
        rows(model).push(created);
        return project(model, created, args);
      },
      updateMany: async (args: Args) => {
        const targets = rows(model).filter((candidate) => matches(model, candidate, args.where));
        for (const row of targets) applyData(row, args.data as Row);
        return { count: targets.length };
      },
      delete: async (args: Args) => {
        const index = rows(model).findIndex((candidate) => matches(model, candidate, args.where));
        if (index < 0) throw new Error(`in-memory-sales-db: ${model} delete target not found`);
        if (model === 'salePayment') recordPaymentHistory(rows(model)[index]!.saleId); // BEFORE DELETE (source)
        const [removed] = rows(model).splice(index, 1);
        return removed!;
      },
      // Releasable-expired-hold aggregation: these tests never create
      // expired holds, so the aggregate is always empty.
      groupBy: async () => [],
    };
  }

  // Raw SQL used by the services: only `SELECT ... FOR UPDATE` row locks.
  async function queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> {
    const sql = strings.join('?');
    const normalized = sql.replace(/\s+/g, ' ').trim();
    rawQueries.push(normalized);
    const flat = values.map((value) => (isPlainObject(value) && Array.isArray(value.values) ? value.values : value));
    if (/FROM "Sale"\s/.test(sql)) return rows('sale').filter((row) => row.id === flat[0]).map((row) => ({ ...row }));
    if (/FROM "StockReservation"/.test(sql)) {
      return sort(rows('stockReservation').filter((row) => row.saleId === flat[0] && row.status === 'ACTIVE'), { id: 'asc' })
        .map((row) => ({ ...row }));
    }
    // Sale void: Inventory locked by id (WHERE id IN (...) ORDER BY id ASC FOR UPDATE).
    if (/FROM "Inventory" WHERE id IN/.test(normalized)) {
      const ids = flat[0] as unknown[];
      return sort(rows('inventory').filter((row) => ids.includes(row.id)), { id: 'asc' }).map((row) => ({ ...row }));
    }
    if (/FROM "Inventory"/.test(sql)) {
      const variantIds = flat[1] as unknown[];
      return sort(rows('inventory').filter((row) => row.branchId === flat[0] && variantIds.includes(row.variantId)), { id: 'asc' })
        .map((row) => ({ ...row }));
    }
    if (/FROM "ProductVariant"/.test(sql)) return rows('productVariant').filter((row) => row.id === flat[0]).map((row) => ({ ...row }));
    if (/FROM "SaleNumberCounter"/.test(sql)) {
      return rows('saleNumberCounter').filter((row) => row.branchId === flat[0]).map((row) => ({
        ...row, code: (rows('branch').find((branch) => branch.id === row.branchId) ?? {}).code,
      }));
    }
    // CASH-1: the payments service locks the register's OPEN cash session
    // (payments.service.ts and the cash close share this row lock). Exact-form
    // recognition only: the ONE query the service emits, normalized, compared
    // as a whole string — bound by registerId (flat[0]) with the OPEN status
    // as a literal. Any other SQL touching "CashSession" (including the
    // close's id-keyed lock) stays unsupported, fail-closed.
    if (
      normalized ===
      'SELECT id FROM "CashSession" WHERE "registerId" = ? AND "status" = \'OPEN\' FOR UPDATE'
    ) {
      return rows('cashSession')
        .filter((row) => row.registerId === flat[0] && row.status === 'OPEN')
        .map((row) => ({ ...row }));
    }
    // Sale void: one CashSession locked by id (any select list, optionally joined to its register
    // for the branch). Returns the session plus the register's `branchId`.
    if (/FROM "CashSession"/.test(normalized) && /FOR UPDATE/.test(normalized) && typeof flat[0] === 'string') {
      return rows('cashSession').filter((row) => row.id === flat[0]).map((row) => ({
        ...row, branchId: rows('cashRegister').find((register) => register.id === row.registerId)?.branchId ?? null,
      }));
    }
    return unsupported(`raw query: ${sql}`);
  }

  const client: Record<string, unknown> = Object.fromEntries(models.map((model) => [model, delegate(model)]));
  client.$queryRaw = queryRaw;
  client.$transaction = async (operation: unknown) => {
    if (typeof operation !== 'function') return unsupported('array $transaction');
    const snapshot = structuredClone(tables);
    try {
      return await (operation as (tx: unknown) => Promise<unknown>)(client);
    } catch (error) {
      tables = snapshot;
      throw error;
    }
  };

  return {
    client,
    rawQueries,
    table: (model: Model) => rows(model),
    // Every simulated table (all models), for whole-store assertions.
    allTables: () => Object.fromEntries(models.map((model) => [model, rows(model)])) as Record<Model, Row[]>,
    insert: (model: Model, data: Row) => {
      const row: Row = { id: randomUUID(), ...(DEFAULTS[model]?.() ?? {}), ...data };
      rows(model).push(row);
      return row;
    },
  };
}

export type InMemorySalesDb = ReturnType<typeof createInMemorySalesDb>;
