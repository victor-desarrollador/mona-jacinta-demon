// R3-A4.3 S4: DB-free double for the durable-checkout reservation service and
// its read views. Not PostgreSQL: there are no triggers (F1–F6), CHECKs, FKs or
// real locks here — those are proven by the opt-in *.pg.test.ts files. What it
// does model, so the service's own logic can be driven deterministically:
//   - one transaction at a time; a thrown callback restores every table
//     (rollback); the options passed to $transaction are recorded;
//   - `SELECT … FOR UPDATE` raw queries the service issues, recorded in order;
//   - `UPDATE "Sale" SET "updatedAt" = now()` (the visibility rule);
//   - the CheckoutAttempt unique keys (reserveKey, operationKey) and the
//     partial "one open attempt per sale" index, raising Prisma-shaped P2002;
//   - injected failures (`failOn`) and a concurrent peer's committed writes
//     (`concurrently`), which survive our own rollback.
import { randomUUID } from 'node:crypto';

export type Row = Record<string, unknown>;
export type Op = { kind: string; model?: string; detail?: unknown };

const MODELS = [
  'sale', 'saleItem', 'salePayment', 'saleCheckout', 'saleLineAllocation', 'checkoutAttempt', 'checkoutAttemptTender',
  'checkoutAttemptDeclaration', 'externalCollection', 'cashSession', 'cashRegister', 'stockReservation', 'user',
  'auditLog', 'company', 'companyPricingConfig',
] as const;
export type Model = (typeof MODELS)[number];

const ATTEMPT_DEFAULTS: Row = {
  planSealed: false, status: 'RESERVED', fullPriceTransfer: null, fullPriceDebit: null, transferAdjustmentBps: null,
  debitAdjustmentBps: null, pricingConfigId: null, pricingConfigUpdatedAt: null, recoveryReason: null, recoveryEvidence: null,
  confirmationHash: null, confirmedById: null, confirmedAt: null, confirmReason: null, confirmEvidence: null,
  rejectionCode: null, rejectionDetails: null, rejectedById: null, rejectedAt: null, abandonedById: null, abandonedAt: null,
  abandonReason: null, abandonEvidence: null, declaredById: null, declaredAt: null,
};

const clone = <T>(value: T): T => structuredClone(value);

function matches(row: Row, where: unknown): boolean {
  if (where === undefined || where === null) return true;
  for (const [key, condition] of Object.entries(where as Row)) {
    if (key === 'OR') { if (!(condition as unknown[]).some((part) => matches(row, part))) return false; continue; }
    if (key === 'AND') { if (!(condition as unknown[]).every((part) => matches(row, part))) return false; continue; }
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const c = condition as Row;
      if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
      if ('notIn' in c && (c.notIn as unknown[]).includes(value)) return false;
      if ('gte' in c && !((value as Date | bigint) >= (c.gte as Date | bigint))) return false;
      if ('lte' in c && !((value as Date | bigint) <= (c.lte as Date | bigint))) return false;
      if ('not' in c && value === c.not) return false;
      if ('equals' in c && value !== c.equals) return false;
      continue;
    }
    if (condition instanceof Date) { if (!(value instanceof Date) || value.getTime() !== condition.getTime()) return false; continue; }
    if (value !== condition) return false;
  }
  return true;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<string, 'asc' | 'desc'>[];
  return [...rows].sort((a, b) => {
    for (const entry of keys) {
      const [key, direction] = Object.entries(entry)[0]!;
      const x = a[key] instanceof Date ? (a[key] as Date).getTime() : a[key];
      const y = b[key] instanceof Date ? (b[key] as Date).getTime() : b[key];
      if (x === y) continue;
      const less = (x as number) < (y as number) ? -1 : 1;
      return direction === 'desc' ? -less : less;
    }
    return 0;
  });
}

export function p2002(target: string | string[], modelName = 'CheckoutAttempt'): Error {
  return Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { modelName, target } });
}

export function createCheckoutReservationFakeDb(options: { now?: () => Date } = {}) {
  const now = options.now ?? (() => new Date());
  const tables = Object.fromEntries(MODELS.map((model) => [model, [] as Row[]])) as Record<Model, Row[]>;
  const ops: Op[] = [];
  const transactions: Array<Record<string, unknown> | undefined> = [];
  let inTransaction = false;
  const failures: Array<{ model: string; op: string; error: () => Error; once: boolean }> = [];
  const beforeHooks: Array<{ model: string; op: string; run: () => void }> = [];
  const peerCommits: Array<() => void> = [];

  const table = (model: Model) => tables[model];

  function maybeFail(model: string, op: string) {
    const index = failures.findIndex((failure) => failure.model === model && failure.op === op);
    if (index === -1) return;
    const failure = failures[index]!;
    if (failure.once) failures.splice(index, 1);
    throw failure.error();
  }
  function runBefore(model: string, op: string) {
    for (const hook of beforeHooks.splice(0).filter((h) => h.model === model && h.op === op)) hook.run();
  }

  function checkAttemptUniques(candidate: Row, self?: Row) {
    for (const other of table('checkoutAttempt')) {
      if (other === self) continue;
      if (other.reserveKey === candidate.reserveKey) throw p2002(['reserveKey']);
      if (other.operationKey === candidate.operationKey) throw p2002(['operationKey']);
      const open = (row: Row) => (row.status === 'RESERVED' || row.status === 'REJECTED') && row.declaredAt === null;
      if (other.saleId === candidate.saleId && open(other) && open(candidate)) throw p2002('CheckoutAttempt_one_open_per_sale');
    }
  }

  function delegate(model: Model) {
    return {
      findUnique: async (args: { where: Row }) => clone(table(model).find((row) => matches(row, args.where)) ?? null),
      findFirst: async (args: { where?: Row; orderBy?: unknown } = {}) =>
        clone(sortRows(table(model).filter((row) => matches(row, args.where)), args.orderBy)[0] ?? null),
      findMany: async (args: { where?: Row; orderBy?: unknown; take?: number } = {}) => {
        const rows = sortRows(table(model).filter((row) => matches(row, args.where)), args.orderBy);
        return clone(args.take === undefined ? rows : rows.slice(0, args.take));
      },
      count: async (args: { where?: Row } = {}) => table(model).filter((row) => matches(row, args.where)).length,
      create: async (args: { data: Row }) => {
        runBefore(model, 'create');
        maybeFail(model, 'create');
        const row: Row = { id: randomUUID(), ...(model === 'checkoutAttempt' ? { ...ATTEMPT_DEFAULTS, startedAt: now() } : {}),
          ...(model === 'auditLog' ? { createdAt: now() } : {}), ...clone(args.data) };
        if (model === 'checkoutAttempt') checkAttemptUniques(row);
        table(model).push(row);
        ops.push({ kind: 'create', model, detail: clone(row) });
        return clone(row);
      },
      createMany: async (args: { data: Row[] }) => {
        runBefore(model, 'createMany');
        maybeFail(model, 'createMany');
        for (const data of args.data) {
          const row = { id: randomUUID(), ...clone(data) };
          table(model).push(row);
          ops.push({ kind: 'create', model, detail: clone(row) });
        }
        return { count: args.data.length };
      },
      update: async (args: { where: Row; data: Row }) => {
        maybeFail(model, 'update');
        const row = table(model).find((candidate) => matches(candidate, args.where));
        if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' });
        const next = { ...row, ...clone(args.data) };
        if (model === 'checkoutAttempt') checkAttemptUniques(next, row);
        Object.assign(row, clone(args.data));
        ops.push({ kind: 'update', model, detail: { where: args.where, data: clone(args.data) } });
        return clone(row);
      },
      updateMany: async (args: { where: Row; data: Row }) => {
        maybeFail(model, 'updateMany');
        const targets = table(model).filter((row) => matches(row, args.where));
        for (const row of targets) Object.assign(row, clone(args.data));
        ops.push({ kind: 'updateMany', model, detail: { where: args.where, data: clone(args.data), count: targets.length } });
        return { count: targets.length };
      },
    };
  }

  const sqlOf = (strings: TemplateStringsArray) => strings.join('?').replace(/\s+/g, ' ').trim();

  async function queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> {
    const sql = sqlOf(strings);
    if (/FROM "Sale" WHERE id = \? FOR UPDATE/.test(sql)) {
      maybeFail('sale', 'lock');
      ops.push({ kind: 'lock', model: 'Sale' });
      const sale = table('sale').find((row) => row.id === values[0]);
      return sale ? [clone(sale)] : [];
    }
    // R3-A4.3 S-REF: T-F locks ONE collection of the URL by primary key, with
    // no claim predicate and no NOWAIT (plain FOR UPDATE). It must be matched
    // before the two broader claim/plan branches below, whose value shapes
    // differ (a single id string vs an id array).
    if (/FROM "ExternalCollection" WHERE "id" = \? FOR UPDATE/.test(sql)) {
      maybeFail('externalCollection', 'lock');
      ops.push({ kind: 'lock', model: 'ExternalCollection', detail: 'id' });
      const [id] = values as [string];
      const row = table('externalCollection').find((candidate) => candidate.id === id);
      return row ? [clone(row)] : [];
    }
    if (/FROM "ExternalCollection"/.test(sql) && /"claimAttemptId" = \?/.test(sql) && /FOR UPDATE/.test(sql)) {
      maybeFail('externalCollection', 'lock');
      ops.push({ kind: 'lock', model: 'ExternalCollection', detail: sql });
      const [attemptId] = values as [string];
      return clone(sortRows(table('externalCollection').filter((row) => row.claimAttemptId === attemptId), { id: 'asc' }));
    }
    if (/FROM "ExternalCollection"/.test(sql) && /FOR UPDATE/.test(sql)) {
      maybeFail('externalCollection', 'lock');
      ops.push({ kind: 'lock', model: 'ExternalCollection', detail: sql });
      const [ids, saleId, branchId] = values as [string[], string, string];
      return clone(sortRows(table('externalCollection').filter((row) => ids.includes(row.id as string)
        || (row.originSaleId === saleId && row.branchId === branchId && row.status === 'UNAPPLIED')), { id: 'asc' }));
    }
    if (/FROM "CheckoutAttempt" WHERE "reserveKey" = \? AND "saleId" = \? FOR UPDATE/.test(sql)) {
      maybeFail('checkoutAttempt', 'lock');
      ops.push({ kind: 'lock', model: 'CheckoutAttempt' });
      const [reserveKey, saleId] = values as [string, string];
      const attempt = table('checkoutAttempt').find((row) => row.reserveKey === reserveKey && row.saleId === saleId);
      return attempt ? [clone(attempt)] : [];
    }
    if (/FROM "CheckoutAttempt" WHERE "reserveKey" = \? FOR UPDATE/.test(sql)) {
      maybeFail('checkoutAttempt', 'lock');
      ops.push({ kind: 'lock', model: 'CheckoutAttempt' });
      const [reserveKey] = values as [string];
      const attempt = table('checkoutAttempt').find((row) => row.reserveKey === reserveKey);
      return attempt ? [clone(attempt)] : [];
    }
    if (/FROM "CashSession" cs JOIN "CashRegister" r/.test(sql)) {
      ops.push({ kind: 'lock', model: 'CashSession' });
      const session = table('cashSession').find((row) => row.id === values[0]);
      if (!session) return [];
      const register = table('cashRegister').find((row) => row.id === session.registerId);
      return register ? [{ id: session.id, status: session.status, branchId: register.branchId }] : [];
    }
    if (/FROM "StockReservation"/.test(sql) && /FOR UPDATE/.test(sql)) {
      ops.push({ kind: 'lock', model: 'StockReservation' });
      return clone(sortRows(table('stockReservation').filter((row) => row.saleId === values[0] && row.status === 'ACTIVE'), { id: 'asc' }));
    }
    throw new Error(`fake db: unexpected raw query: ${sql}`);
  }

  async function executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number> {
    const sql = sqlOf(strings);
    if (/^UPDATE "Sale" SET "updatedAt" = now\(\) WHERE id = \?$/.test(sql)) {
      maybeFail('sale', 'touch');
      const sale = table('sale').find((row) => row.id === values[0]);
      if (sale) sale.updatedAt = now();
      ops.push({ kind: 'touch', model: 'Sale' });
      return sale ? 1 : 0;
    }
    throw new Error(`fake db: unexpected raw statement: ${sql}`);
  }

  const client: Record<string, unknown> = Object.fromEntries(MODELS.map((model) => [model, delegate(model)]));
  client.$queryRaw = queryRaw;
  client.$executeRaw = executeRaw;
  client.$transaction = async (fn: (tx: unknown) => Promise<unknown>, transactionOptions?: Record<string, unknown>) => {
    if (inTransaction) throw new Error('fake db: nested transaction');
    transactions.push(transactionOptions);
    const snapshot = clone(tables);
    inTransaction = true;
    ops.push({ kind: 'begin' });
    try {
      const result = await fn(client);
      ops.push({ kind: 'commit' });
      peerCommits.splice(0); // already applied before our writes; never re-applied
      return result;
    } catch (error) {
      for (const model of MODELS) tables[model] = snapshot[model];
      ops.push({ kind: 'rollback' });
      // A concurrent peer had already committed: its rows survive our rollback.
      for (const commit of peerCommits.splice(0)) commit();
      throw error;
    } finally {
      inTransaction = false;
    }
  };

  return {
    client,
    tables,
    table,
    ops,
    transactions,
    insert(model: Model, row: Row): Row {
      const full: Row = { id: randomUUID(), ...(model === 'checkoutAttempt' ? { ...ATTEMPT_DEFAULTS, startedAt: now() } : {}), ...row };
      table(model).push(full);
      return full;
    },
    failOn(model: string, op: string, error: () => Error, once = true) {
      failures.push({ model, op, error, once });
    },
    // Runs `write` right before our `model.op` executes, as a peer transaction
    // that commits first; it is re-applied after our rollback (it was durable).
    concurrently(model: string, op: string, write: () => void) {
      beforeHooks.push({ model, op, run: () => { write(); peerCommits.push(write); } });
    },
    writesSince(index: number) {
      return ops.slice(index).filter((op) => ['create', 'update', 'updateMany', 'touch'].includes(op.kind));
    },
  };
}

export type CheckoutReservationFakeDb = ReturnType<typeof createCheckoutReservationFakeDb>;
