// R3-A4.3 S1 — ninth migration 20261016130000_r3_checkout_attempts and its
// schema.prisma mirror. DB-FREE: these checks read files only. The behavior of
// every CHECK, FK, index and function on a real PostgreSQL is proven by the
// opt-in r3-attempts-schema.pg.test.ts (P1–P5, P21, P23, P33–P35, P47–P53).
//
// Precedence: consolidated contract < C1–C5 revision < last-REVISE closure
// (atomic migration, claim, refund) < three final corrections (F6 claim
// fragment, T-X order, P21b). A later document replaces only what it changes.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_ROOT,
  P21B_INJECTION,
  R3_A2_MIGRATION,
  R3_ATTEMPTS_MIGRATION,
  addedColumns,
  createTableColumns,
  deriveP21bInstrumentedCopy,
  functionBody,
  insertedLines,
  migrationNames,
  migrationPath,
  newTuples,
  readMigration,
  sha256,
  splitTopLevelStatements,
  stripDollarBodies,
} from '../helpers/r3-attempts-migration.js';

// R3-A2 is uncommitted but frozen: S1 must never change its bytes.
const R3_A2_SHA256 = '217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6';

const FUNCTIONS = [
  'fn_checkout_attempt_guard',
  'fn_checkout_attempt_tender_guard',
  'fn_checkout_attempt_commit_check',
  'fn_checkout_attempt_declaration_guard',
  'fn_checkout_declaration_commit_check',
  'fn_external_collection_guard',
] as const;

const RA = 'ON DELETE RESTRICT ON UPDATE RESTRICT';
const FOREIGN_KEYS: Record<string, [table: string, columns: string, target: string]> = {
  CheckoutAttempt_sale_branch_fkey: ['CheckoutAttempt', '"saleId","branchId"', '"Sale"("id","branchId")'],
  CheckoutAttempt_cashSessionId_fkey: ['CheckoutAttempt', '"cashSessionId"', '"CashSession"("id")'],
  CheckoutAttempt_startedById_fkey: ['CheckoutAttempt', '"startedById"', '"User"("id")'],
  CheckoutAttempt_confirmedById_fkey: ['CheckoutAttempt', '"confirmedById"', '"User"("id")'],
  CheckoutAttempt_rejectedById_fkey: ['CheckoutAttempt', '"rejectedById"', '"User"("id")'],
  CheckoutAttempt_abandonedById_fkey: ['CheckoutAttempt', '"abandonedById"', '"User"("id")'],
  CheckoutAttempt_declaredById_fkey: ['CheckoutAttempt', '"declaredById"', '"User"("id")'],
  CheckoutAttemptTender_attempt_fkey: ['CheckoutAttemptTender', '"attemptId","branchId"', '"CheckoutAttempt"("id","branchId")'],
  CheckoutAttemptTender_collection_fkey: ['CheckoutAttemptTender', '"externalCollectionId","branchId","method","amount"', '"ExternalCollection"("id","branchId","method","amount")'],
  CheckoutAttemptDeclaration_tender_fkey: ['CheckoutAttemptDeclaration', '"attemptId","method","tenderSource"', '"CheckoutAttemptTender"("attemptId","method","source")'],
  CheckoutAttemptDeclaration_attempt_fkey: ['CheckoutAttemptDeclaration', '"attemptId","saleId","branchId"', '"CheckoutAttempt"("id","saleId","branchId")'],
  CheckoutAttemptDeclaration_collection_fkey: ['CheckoutAttemptDeclaration', '"externalCollectionId","attemptId","saleId","branchId","method"', '"ExternalCollection"("id","originAttemptId","originSaleId","branchId","method")'],
  CheckoutAttemptDeclaration_declaredById_fkey: ['CheckoutAttemptDeclaration', '"declaredById"', '"User"("id")'],
  ExternalCollection_origin_attempt_fkey: ['ExternalCollection', '"originAttemptId","originSaleId","branchId"', '"CheckoutAttempt"("id","saleId","branchId")'],
  ExternalCollection_claim_fkey: ['ExternalCollection', '"claimAttemptId","branchId"', '"CheckoutAttempt"("id","branchId")'],
  SaleCheckout_attempt_fkey: ['SaleCheckout', '"operationKey","saleId","attemptStatus","requestHash"', '"CheckoutAttempt"("operationKey","saleId","status","confirmationHash")'],
};

const INDEXES: Record<string, string> = {
  CheckoutAttempt_reserveKey_key: 'CREATE UNIQUE INDEX "CheckoutAttempt_reserveKey_key" ON "CheckoutAttempt"("reserveKey")',
  CheckoutAttempt_operationKey_key: 'CREATE UNIQUE INDEX "CheckoutAttempt_operationKey_key" ON "CheckoutAttempt"("operationKey")',
  CheckoutAttempt_id_branchId_key: 'CREATE UNIQUE INDEX "CheckoutAttempt_id_branchId_key" ON "CheckoutAttempt"("id","branchId")',
  CheckoutAttempt_id_saleId_branchId_key: 'CREATE UNIQUE INDEX "CheckoutAttempt_id_saleId_branchId_key" ON "CheckoutAttempt"("id","saleId","branchId")',
  CheckoutAttempt_confirmation_key: 'CREATE UNIQUE INDEX "CheckoutAttempt_confirmation_key" ON "CheckoutAttempt"("operationKey","saleId","status","confirmationHash")',
  CheckoutAttempt_one_open_per_sale: `CREATE UNIQUE INDEX "CheckoutAttempt_one_open_per_sale" ON "CheckoutAttempt"("saleId") WHERE "status" IN ('RESERVED','REJECTED') AND "declaredAt" IS NULL`,
  CheckoutAttempt_branch_starter_time_idx: 'CREATE INDEX "CheckoutAttempt_branch_starter_time_idx" ON "CheckoutAttempt"("branchId","startedById","startedAt" DESC)',
  CheckoutAttempt_branch_time_idx: 'CREATE INDEX "CheckoutAttempt_branch_time_idx" ON "CheckoutAttempt"("branchId","startedAt" DESC)',
  CheckoutAttemptTender_attempt_method_key: 'CREATE UNIQUE INDEX "CheckoutAttemptTender_attempt_method_key" ON "CheckoutAttemptTender"("attemptId","method")',
  CheckoutAttemptTender_attempt_method_source_key: 'CREATE UNIQUE INDEX "CheckoutAttemptTender_attempt_method_source_key" ON "CheckoutAttemptTender"("attemptId","method","source")',
  CheckoutAttemptTender_one_balance: `CREATE UNIQUE INDEX "CheckoutAttemptTender_one_balance" ON "CheckoutAttemptTender"("attemptId") WHERE "role" = 'BALANCE'`,
  CheckoutAttemptDeclaration_attempt_method_key: 'CREATE UNIQUE INDEX "CheckoutAttemptDeclaration_attempt_method_key" ON "CheckoutAttemptDeclaration"("attemptId","method")',
  CheckoutAttemptDeclaration_externalCollectionId_key: 'CREATE UNIQUE INDEX "CheckoutAttemptDeclaration_externalCollectionId_key" ON "CheckoutAttemptDeclaration"("externalCollectionId")',
  ExternalCollection_id_branch_method_amount_key: 'CREATE UNIQUE INDEX "ExternalCollection_id_branch_method_amount_key" ON "ExternalCollection"("id","branchId","method","amount")',
  ExternalCollection_id_origin_attempt_key: 'CREATE UNIQUE INDEX "ExternalCollection_id_origin_attempt_key" ON "ExternalCollection"("id","originAttemptId","originSaleId","branchId","method")',
  ExternalCollection_claimAttemptId_idx: 'CREATE INDEX "ExternalCollection_claimAttemptId_idx" ON "ExternalCollection"("claimAttemptId")',
  SaleCheckout_attempt_link_key: 'CREATE UNIQUE INDEX "SaleCheckout_attempt_link_key" ON "SaleCheckout"("operationKey","saleId","attemptStatus","requestHash")',
};

const CHECKS: Record<string, string> = {
  chk_attempt_hashes: 'CheckoutAttempt',
  chk_attempt_plan: 'CheckoutAttempt',
  chk_attempt_pricing_snapshot: 'CheckoutAttempt',
  chk_attempt_texts: 'CheckoutAttempt',
  chk_attempt_status_fields: 'CheckoutAttempt',
  chk_attempt_recovery: 'CheckoutAttempt',
  chk_tender_shape: 'CheckoutAttemptTender',
  chk_declaration_shape: 'CheckoutAttemptDeclaration',
  chk_declaration_evidence: 'CheckoutAttemptDeclaration',
  chk_ec_origin_attempt: 'ExternalCollection',
  chk_ec_claim_state: 'ExternalCollection',
  chk_ec_refund_fields: 'ExternalCollection',
  chk_checkout_attempt_status: 'SaleCheckout',
};

const squash = (s: string) => s.replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ',').trim();

// Read lazily-tolerant so a missing file fails each case, not the collection.
const readNinth = () => (existsSync(migrationPath(R3_ATTEMPTS_MIGRATION)) ? readMigration(R3_ATTEMPTS_MIGRATION) : '');

describe('R3-A4.3 S1 — ninth migration (static)', () => {
  const sql = readNinth();
  const statements = splitTopLevelStatements(sql);
  const shells = statements.map(stripDollarBodies).map(squash);

  it('S1-01 is the ninth migration, followed only by the reviewed cash-exit migration 10 and cash-reversal migration 11, and R3-A2 keeps its exact bytes', () => {
    const names = migrationNames();
    // Reviewed tree: 11 migrations. S1 (migration 9) is no longer last: the
    // additive cash-withdrawal/expense migration 10 and the additive
    // cash-reversal migration 11 follow it. S1's own position and R3-A2's
    // bytes are unchanged by those additive neighbours.
    expect(names).toHaveLength(11);
    expect(names.at(-4)).toBe(R3_A2_MIGRATION);
    expect(names.at(-3)).toBe(R3_ATTEMPTS_MIGRATION);
    expect(names.at(-2)).toBe('20261018120000_cash_movement_withdrawals_expenses');
    expect(names.at(-1)).toBe('20261018180000_cash_movement_reversals');
    expect(sha256(readFileSync(migrationPath(R3_A2_MIGRATION)))).toBe(R3_A2_SHA256);
  });

  it('S1-02 every statement is inside one explicit BEGIN … COMMIT', () => {
    expect(statements[0]).toBe('BEGIN');
    expect(statements.at(-1)).toBe('COMMIT');
    expect(statements.filter((s) => /^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\b/i.test(s))).toEqual(['BEGIN', 'COMMIT']);
    // The file ends with the COMMIT line: nothing (not even a comment) follows it.
    expect(sql.trimEnd().endsWith('\nCOMMIT;')).toBe(true);
  });

  it('S1-03 LOCK and the fail-closed preflight run before any DDL', () => {
    expect(shells[1]).toBe('LOCK TABLE "SaleCheckout","SalePayment","ExternalCollection" IN SHARE ROW EXCLUSIVE MODE');
    expect(statements[2]).toMatch(/^DO \$\$/);
    const preflight = statements[2]!;
    expect(preflight).toContain(`IF EXISTS (SELECT 1 FROM "SaleCheckout") THEN`);
    expect(preflight).toContain(`IF EXISTS (SELECT 1 FROM "SalePayment" WHERE "checkoutId" IS NOT NULL OR "pricingModel" <> 'FIXED_TOTAL') THEN`);
    expect(preflight).toContain(`IF EXISTS (SELECT 1 FROM "ExternalCollection") THEN`);
    expect(preflight.match(/RAISE EXCEPTION 'R3-A4\.3 preflight: [^']+' USING ERRCODE = 'check_violation';/g)).toHaveLength(3);
    expect(statements.slice(3).some((s) => /^(LOCK|DO)\b/.test(s))).toBe(false);
  });

  it('S1-04 is additive: only CREATE / ALTER TABLE … ADD statements, no DML, drops, renames or enum edits', () => {
    const allowed = /^(BEGIN|COMMIT|LOCK TABLE|DO \$\$|CREATE TYPE "\w+" AS ENUM|CREATE TABLE "\w+" \(|ALTER TABLE "\w+" ADD (COLUMN|CONSTRAINT) |CREATE (UNIQUE )?INDEX "\w+" ON "\w+"|CREATE FUNCTION public\."\w+"\(\) RETURNS trigger|CREATE (CONSTRAINT )?TRIGGER "\w+" )/;
    for (const shell of shells) expect(shell, shell.slice(0, 80)).toMatch(allowed);
    // FK referential actions and trigger EVENT clauses are not writes (block1 precedent).
    const outside = shells.join('\n')
      .replaceAll(RA, '')
      .replace(/ (BEFORE|AFTER) (INSERT|UPDATE|DELETE)( OR (INSERT|UPDATE|DELETE))* ON public\."\w+"/g, '');
    expect(outside).not.toMatch(/\b(DROP|DELETE|UPDATE|TRUNCATE|RENAME|INSERT|ALTER TYPE|ALTER COLUMN|OR REPLACE)\b/);
  });

  it('S1-05 creates exactly the three enums with their contract labels', () => {
    const enums = shells.filter((s) => s.startsWith('CREATE TYPE'));
    expect(enums).toEqual([
      `CREATE TYPE "CheckoutAttemptStatus" AS ENUM ('RESERVED','CONFIRMED','REJECTED','ABANDONED')`,
      `CREATE TYPE "CheckoutTenderSource" AS ENUM ('NEW','COLLECTION')`,
      `CREATE TYPE "CheckoutDeclarationOutcome" AS ENUM ('NONE','CHARGED','RETURNED')`,
    ]);
  });

  it('S1-06 creates the three tables and adds exactly the contract columns to ExternalCollection and SaleCheckout', () => {
    expect(shells.filter((s) => s.startsWith('CREATE TABLE')).map((s) => /"(\w+)"/.exec(s)![1])).toEqual([
      'CheckoutAttempt', 'CheckoutAttemptTender', 'CheckoutAttemptDeclaration',
    ]);
    expect(addedColumns(sql, 'ExternalCollection')).toEqual(['originAttemptId', 'claimAttemptId', 'externalRefundedAt']);
    expect(addedColumns(sql, 'SaleCheckout')).toEqual(['attemptStatus']);
    for (const table of ['Sale', 'SalePayment', 'SaleItem', 'SaleLineAllocation', 'StockReservation', 'Inventory', 'CashSession']) {
      expect(addedColumns(sql, table), table).toEqual([]);
    }
    expect(createTableColumns(sql, 'CheckoutAttemptTender')).toEqual([
      'id', 'attemptId', 'branchId', 'method', 'role', 'source', 'amount', 'externalCollectionId',
    ]);
    expect(createTableColumns(sql, 'CheckoutAttemptDeclaration')).toEqual([
      'id', 'attemptId', 'saleId', 'branchId', 'method', 'tenderSource', 'outcome',
      'externalCollectionId', 'returnedAmount', 'evidence', 'declaredById', 'declaredAt',
    ]);
    const added = shells.filter((s) => s.startsWith('ALTER TABLE') && s.includes('ADD COLUMN'));
    expect(added).toContain('ALTER TABLE "ExternalCollection" ADD COLUMN "originAttemptId" TEXT');
    expect(added).toContain('ALTER TABLE "ExternalCollection" ADD COLUMN "claimAttemptId" TEXT');
    expect(added).toContain('ALTER TABLE "ExternalCollection" ADD COLUMN "externalRefundedAt" TIMESTAMPTZ(3)');
    expect(added).toContain(`ALTER TABLE "SaleCheckout" ADD COLUMN "attemptStatus" "CheckoutAttemptStatus" NOT NULL DEFAULT 'CONFIRMED'`);
  });

  it('S1-07 CheckoutAttempt carries the plan, the pricing snapshot, the outcome columns and the immutable recovery justification', () => {
    expect(createTableColumns(sql, 'CheckoutAttempt')).toEqual([
      'id', 'saleId', 'branchId', 'reserveKey', 'operationKey', 'planHash', 'cashSessionId', 'balanceMethod',
      'expectedTotal', 'expectedBalanceAmount', 'tenderCount', 'fullPriceCash', 'fullPriceTransfer', 'fullPriceDebit',
      'transferAdjustmentBps', 'debitAdjustmentBps', 'pricingConfigId', 'pricingConfigUpdatedAt', 'algorithmVersion',
      'planSealed', 'status', 'startedById', 'startedAt', 'recoveryReason', 'recoveryEvidence',
      'confirmationHash', 'confirmedById', 'confirmedAt', 'confirmReason', 'confirmEvidence',
      'rejectionCode', 'rejectionDetails', 'rejectedById', 'rejectedAt',
      'abandonedById', 'abandonedAt', 'abandonReason', 'abandonEvidence', 'declaredById', 'declaredAt',
    ]);
    const table = squash(statements.find((s) => s.startsWith('CREATE TABLE "CheckoutAttempt" ('))!);
    for (const fragment of [
      '"reserveKey" UUID NOT NULL', '"operationKey" UUID NOT NULL', '"planHash" CHAR(64) NOT NULL',
      '"balanceMethod" "PaymentMethod" NOT NULL', '"expectedTotal" BIGINT NOT NULL', '"tenderCount" INTEGER NOT NULL',
      '"planSealed" BOOLEAN NOT NULL DEFAULT false', `"status" "CheckoutAttemptStatus" NOT NULL DEFAULT 'RESERVED'`,
      '"startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP', '"confirmationHash" CHAR(64)',
      '"rejectionDetails" JSONB', '"recoveryReason" TEXT', '"recoveryEvidence" TEXT',
    ]) expect(table, fragment).toContain(fragment);
  });

  it('S1-08 declares every contract CHECK on its table, each NULL-safe status form spelled out', () => {
    const found = Object.fromEntries([...sql.matchAll(/CONSTRAINT "(chk_\w+)"\s+CHECK/g)].map((m) => [m[1], true]));
    expect(Object.keys(found).sort()).toEqual(Object.keys(CHECKS).sort());
    for (const [name, table] of Object.entries(CHECKS)) {
      const owner = squash(statements.find((s) => squash(s).includes(`CONSTRAINT "${name}" CHECK`))!);
      expect(owner.startsWith(`CREATE TABLE "${table}" (`) || owner.startsWith(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}"`), name).toBe(true);
    }
    const body = squash(sql);
    expect(body).toContain(`CHECK ("originAttemptId" IS NULL OR "originSaleId" IS NOT NULL)`);
    expect(body).toContain(`CHECK ("status" <> 'REFUNDED' OR "claimAttemptId" IS NULL)`);
    expect(body).toContain(`CHECK ("attemptStatus" = 'CONFIRMED')`);
    expect(body).toContain(`"externalRefundedAt" <= "resolvedAt"`);
    // C2: a COLLECTION tender is never CHARGED (CHARGED requires tenderSource NEW).
    expect(body).toContain(`("method" IN ('TRANSFER','CARD_DEBIT') AND "tenderSource" = 'NEW' AND "outcome" = 'CHARGED'`);
    for (const status of ['RESERVED', 'CONFIRMED', 'REJECTED', 'ABANDONED']) expect(body).toContain(`("status" = '${status}'`);
  });

  it('S1-09 creates exactly the contract indexes, partial predicates included', () => {
    const created = shells.filter((s) => /^CREATE (UNIQUE )?INDEX/.test(s));
    expect(created.map((s) => /INDEX "(\w+)"/.exec(s)![1]).sort()).toEqual(Object.keys(INDEXES).sort());
    for (const [name, definition] of Object.entries(INDEXES)) expect(created, name).toContain(squash(definition));
  });

  it('S1-10 every foreign key is the exact composite of the contract, RESTRICT on delete and update', () => {
    const fks = shells.filter((s) => s.includes(' FOREIGN KEY '));
    expect(fks.map((s) => /ADD CONSTRAINT "(\w+)"/.exec(s)![1]).sort()).toEqual(Object.keys(FOREIGN_KEYS).sort());
    for (const [name, [table, columns, target]] of Object.entries(FOREIGN_KEYS)) {
      expect(fks, name).toContain(`ALTER TABLE "${table}" ADD CONSTRAINT "${name}" FOREIGN KEY (${columns}) REFERENCES ${target} ${RA}`);
    }
  });

  it('S1-11 defines exactly six hardened plpgsql functions (no SECURITY DEFINER, no dynamic SQL, check_violation only)', () => {
    const fns = statements.filter((s) => s.startsWith('CREATE FUNCTION'));
    expect(fns.map((s) => /public\."(\w+)"/.exec(s)![1])).toEqual([...FUNCTIONS]);
    for (const fn of fns) {
      const shell = squash(stripDollarBodies(fn));
      expect(shell, fn.slice(0, 60)).toMatch(/RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog,pg_temp AS \$\$ … \$\$$/);
      const body = /\$\$([\s\S]*)\$\$/.exec(fn)![1]!;
      expect(body).not.toMatch(/\bEXECUTE\b|\bSECURITY DEFINER\b|\bset_config\b|\bSET\s+(LOCAL\s+)?(ROLE|SESSION)/i);
      for (const raise of body.match(/RAISE EXCEPTION[^;]*;/g) ?? []) expect(raise).toMatch(/USING ERRCODE = 'check_violation';$/);
    }
  });

  it('S1-12 wires the triggers: F1/F2/F4/F6 immediate BEFORE, F3/F5 deferred constraint triggers, no TRUNCATE guard', () => {
    const triggers = shells.filter((s) => /^CREATE (CONSTRAINT )?TRIGGER/.test(s));
    expect(triggers).toEqual([
      'CREATE TRIGGER "trg_checkout_attempt_guard" BEFORE UPDATE OR DELETE ON public."CheckoutAttempt" FOR EACH ROW EXECUTE FUNCTION public."fn_checkout_attempt_guard"()',
      'CREATE TRIGGER "trg_checkout_attempt_tender_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."CheckoutAttemptTender" FOR EACH ROW EXECUTE FUNCTION public."fn_checkout_attempt_tender_guard"()',
      'CREATE CONSTRAINT TRIGGER "trg_checkout_attempt_commit_check" AFTER INSERT OR UPDATE ON public."CheckoutAttempt" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."fn_checkout_attempt_commit_check"()',
      'CREATE TRIGGER "trg_checkout_attempt_declaration_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."CheckoutAttemptDeclaration" FOR EACH ROW EXECUTE FUNCTION public."fn_checkout_attempt_declaration_guard"()',
      'CREATE CONSTRAINT TRIGGER "trg_checkout_declaration_commit_check" AFTER INSERT ON public."CheckoutAttemptDeclaration" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."fn_checkout_declaration_commit_check"()',
      'CREATE TRIGGER "trg_external_collection_guard" BEFORE INSERT OR UPDATE OR DELETE ON public."ExternalCollection" FOR EACH ROW EXECUTE FUNCTION public."fn_external_collection_guard"()',
    ]);
    // No TRUNCATE guard in any statement (test cleanup relies on TRUNCATE … CASCADE).
    expect(statements.join('\n')).not.toMatch(/TRUNCATE/);
  });

  it('S1-13 F1 classifies every CheckoutAttempt column: plan frozen, outcome frozen after RESERVED, declaration write-once', () => {
    const body = functionBody(sql, 'fn_checkout_attempt_guard');
    const tuples = newTuples(body);
    const plan = tuples.find((t) => t[0] === 'id')!;
    const outcome = tuples.find((t) => t[0] === 'confirmationHash')!;
    const declared = tuples.find((t) => t[0] === 'declaredById')!;
    expect(plan).toEqual([
      'id', 'saleId', 'branchId', 'reserveKey', 'operationKey', 'planHash', 'cashSessionId', 'balanceMethod',
      'expectedTotal', 'expectedBalanceAmount', 'tenderCount', 'fullPriceCash', 'fullPriceTransfer', 'fullPriceDebit',
      'transferAdjustmentBps', 'debitAdjustmentBps', 'pricingConfigId', 'pricingConfigUpdatedAt', 'algorithmVersion',
      'startedById', 'startedAt', 'recoveryReason', 'recoveryEvidence',
    ]);
    expect(outcome).toEqual([
      'confirmationHash', 'confirmedById', 'confirmedAt', 'confirmReason', 'confirmEvidence',
      'rejectionCode', 'rejectionDetails', 'rejectedById', 'rejectedAt',
      'abandonedById', 'abandonedAt', 'abandonReason', 'abandonEvidence',
    ]);
    expect(declared).toEqual(['declaredById', 'declaredAt']);
    const classified = [...plan, ...outcome, ...declared, 'planSealed', 'status'];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...createTableColumns(sql, 'CheckoutAttempt')].sort());
    expect(body).toContain(`TG_OP = 'DELETE'`);
    expect(body).toContain(`OLD."status" <> 'RESERVED'`);
  });

  it('S1-14 F6 classifies every ExternalCollection column (R3-A2 + three new) and carries the approved claim rules', () => {
    const body = functionBody(sql, 'fn_external_collection_guard');
    const tuples = newTuples(body);
    const immutable = tuples.find((t) => t[0] === 'id')!;
    const resolution = tuples.find((t) => t[0] === 'appliedCheckoutId')!;
    expect(immutable).toEqual([
      'id', 'branchId', 'method', 'amount', 'reference', 'referenceKey', 'institution', 'institutionOther',
      'originSaleId', 'originAttemptId', 'cashSessionId', 'recordedById', 'recordedAt', 'incidentReason',
    ]);
    expect(resolution).toEqual([
      'appliedCheckoutId', 'appliedSaleId', 'resolvedById', 'resolvedAt', 'refundReference', 'resolutionNote', 'externalRefundedAt',
    ]);
    const r3a2 = createTableColumns(readMigration(R3_A2_MIGRATION), 'ExternalCollection');
    const all = [...r3a2, ...addedColumns(sql, 'ExternalCollection')];
    const classified = [...immutable, ...resolution, 'status', 'claimAttemptId'];
    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual([...all].sort());
    const flat = squash(body);
    // Three final corrections §1: NULL → X only from the unsealed RESERVED plan that holds it as COLLECTION.
    expect(flat).toContain(`a."status" = 'RESERVED' AND a."planSealed" = false AND t."source" = 'COLLECTION' AND t."externalCollectionId" = NEW."id"`);
    // X → NULL only once X is terminal and declared.
    expect(flat).toContain(`a."status" IN ('REJECTED','ABANDONED') AND a."declaredAt" IS NOT NULL`);
    expect(flat).toContain(`'Claim cannot move between attempts'`);
    // UNAPPLIED → APPLIED only by the checkout of the claiming attempt; REFUNDED never claimed.
    expect(flat).toContain(`sc."operationKey" = a."operationKey"`);
    expect(flat).toContain(`OLD."status" = 'UNAPPLIED' AND NEW."status" IN ('APPLIED','REFUNDED')`);
  });

  it('S1-15 F3 rereads the attempt at commit and checks plan, declaration and claim state', () => {
    const flat = squash(functionBody(sql, 'fn_checkout_attempt_commit_check'));
    expect(flat).toContain(`SELECT * INTO a FROM public."CheckoutAttempt" WHERE "id" = NEW."id"`);
    expect(flat).toContain(`'CheckoutAttempt plan incomplete at commit'`);
    expect(flat).toContain(`'ABANDONED attempt requires a declaration'`);
    expect(flat).toContain(`'Declaration must cover every tender,by the declaring actor'`);
    expect(flat).toContain(`"claimAttemptId" = a."id"`);
  });
});

describe('R3-A4.3 S1 — P21b instrumented copy (static derivation)', () => {
  const original = readNinth();

  it('P21b-1 the copy is the real file plus exactly the injected line, immediately before the final COMMIT', () => {
    const copy = deriveP21bInstrumentedCopy(original);
    const diff = insertedLines(original, copy);
    expect(diff).not.toBeNull();
    expect(diff!.lines).toEqual([P21B_INJECTION]);
    expect(copy.split('\n')[diff!.at + 1]).toBe('COMMIT;');
    expect(splitTopLevelStatements(copy).at(-2)).toBe(P21B_INJECTION.slice(0, -1));
  });

  it('P21b-2 the derivation refuses a file without exactly one final COMMIT line', () => {
    expect(() => deriveP21bInstrumentedCopy('BEGIN;\nSELECT 1;\n')).toThrow(/exactly one COMMIT/);
    expect(() => deriveP21bInstrumentedCopy('BEGIN;\nCOMMIT;\nCOMMIT;\n')).toThrow(/exactly one COMMIT/);
    expect(() => deriveP21bInstrumentedCopy('BEGIN;\nCOMMIT;\nSELECT 1;\n')).toThrow(/last statement/);
    expect(insertedLines('a\nb', 'a\nX\nc')).toBeNull();
  });
});

describe('R3-A4.3 S1 — schema.prisma mirror (static)', () => {
  const schema = readFileSync(path.join(API_ROOT, 'prisma', 'schema.prisma'), 'utf8');
  const block = (kind: 'model' | 'enum', name: string) => {
    const m = new RegExp(`\\n${kind} ${name} \\{\\n([\\s\\S]*?)\\n\\}`).exec(schema);
    if (!m) throw new Error(`${kind} ${name} missing from schema.prisma`);
    return m[1]!.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim().replace(/\s+/g, ' ')).filter(Boolean);
  };

  it('S1-P1 declares the three enums', () => {
    expect(block('enum', 'CheckoutAttemptStatus')).toEqual(['RESERVED', 'CONFIRMED', 'REJECTED', 'ABANDONED']);
    expect(block('enum', 'CheckoutTenderSource')).toEqual(['NEW', 'COLLECTION']);
    expect(block('enum', 'CheckoutDeclarationOutcome')).toEqual(['NONE', 'CHARGED', 'RETURNED']);
  });

  it('S1-P2 mirrors the three tables with their exact scalar types', () => {
    const attempt = block('model', 'CheckoutAttempt');
    for (const line of [
      'reserveKey String @unique(map: "CheckoutAttempt_reserveKey_key") @db.Uuid',
      'operationKey String @unique(map: "CheckoutAttempt_operationKey_key") @db.Uuid',
      'planHash String @db.Char(64)',
      'expectedTotal BigInt',
      'tenderCount Int',
      'planSealed Boolean @default(false)',
      'status CheckoutAttemptStatus @default(RESERVED)',
      'startedAt DateTime @default(now()) @db.Timestamptz(3)',
      'confirmationHash String? @db.Char(64)',
      'rejectionDetails Json?',
      'recoveryReason String?',
      'recoveryEvidence String?',
    ]) expect(attempt, line).toContain(line);
    expect(block('model', 'CheckoutAttemptTender')).toEqual(expect.arrayContaining([
      'source CheckoutTenderSource', 'role CheckoutTenderRole', 'amount BigInt?', 'externalCollectionId String?',
    ]));
    expect(block('model', 'CheckoutAttemptDeclaration')).toEqual(expect.arrayContaining([
      'tenderSource CheckoutTenderSource', 'outcome CheckoutDeclarationOutcome', 'returnedAmount BigInt?',
      'declaredAt DateTime @default(now()) @db.Timestamptz(3)',
    ]));
  });

  it('S1-P3 mirrors the new ExternalCollection and SaleCheckout columns', () => {
    expect(block('model', 'ExternalCollection')).toEqual(expect.arrayContaining([
      'originAttemptId String?', 'claimAttemptId String?', 'externalRefundedAt DateTime? @db.Timestamptz(3)',
    ]));
    expect(block('model', 'SaleCheckout')).toEqual(expect.arrayContaining(['attemptStatus CheckoutAttemptStatus @default(CONFIRMED)']));
  });

  it('S1-P4 reproduces every migration-9 FK and unique/plain index by name; partial indexes stay SQL-only', () => {
    for (const name of Object.keys(FOREIGN_KEYS)) expect(schema, name).toContain(`map: "${name}")`);
    for (const name of Object.keys(INDEXES)) {
      const partial = INDEXES[name]!.includes(' WHERE ');
      if (partial) expect(schema, name).not.toContain(`map: "${name}")`);
      else expect(schema, name).toContain(`map: "${name}")`);
    }
    // The SQL-only objects are documented next to their models.
    for (const name of [...Object.keys(CHECKS), 'CheckoutAttempt_one_open_per_sale', 'CheckoutAttemptTender_one_balance', ...FUNCTIONS]) {
      expect(schema, name).toContain(name);
    }
  });
});
