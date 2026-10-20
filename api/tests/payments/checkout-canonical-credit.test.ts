// The canonical checkout text/hash with CARD_CREDIT (OWNER block).
//
// The grammar of mona-checkout-plan/v1 and mona-checkout-confirmation/v1 is
// UNCHANGED: a tender is one row `tender=<METHOD>|...` and the method set only
// grows. A plan without CARD_CREDIT therefore produces exactly the bytes — and the
// hash — it produced before this change (golden vectors below, computed with the
// pre-change module), so stored v1 hashes keep verifying. The canonical order is
// CASH, TRANSFER, CARD_DEBIT, CARD_CREDIT.
import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_METHODS,
  canonicalConfirmationText,
  canonicalPlanText,
  confirmationHash,
  planHash,
  type PlanInput,
} from '../../src/modules/payments/checkout-canonical.js';

const saleId = '11111111-1111-4111-8111-111111111111';
const cashSessionId = '22222222-2222-4222-8222-222222222222';
const reserveKey = '33333333-3333-4333-8333-333333333333';
const operationKey = '44444444-4444-4444-8444-444444444444';

// Golden vectors produced by the module BEFORE CARD_CREDIT existed.
const GOLDEN_PLAN_HASH = '5fe890d5193e72af8580b5fcbfb724732d805179608f28b234fbe698c40afe89';
const GOLDEN_CONFIRMATION_HASH = '37d2913325f711662f62a4d0b0661f6b232ee8e597c7372e2c0ab20a4b671484';

const historicalPlan: PlanInput = {
  saleId, cashSessionId, balanceMethod: 'CARD_DEBIT', expectedTotal: 5153700n, expectedBalanceAmount: 3150000n,
  tenders: [
    { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2003700n, externalCollectionId: null },
    { method: 'CARD_DEBIT', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
  ],
};

describe('canonical checkout with CARD_CREDIT', () => {
  it('lists the four methods in the canonical order', () => {
    expect([...CHECKOUT_METHODS]).toEqual(['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT']);
  });

  it('keeps the plan hash of a plan without credit byte-identical to v1 (historical hashes still verify)', () => {
    expect(canonicalPlanText(historicalPlan).startsWith('mona-checkout-plan/v1\n')).toBe(true);
    expect(planHash(historicalPlan)).toBe(GOLDEN_PLAN_HASH);
  });

  it('keeps the confirmation hash of a plan without credit byte-identical to v1', () => {
    const hash = confirmationHash({
      planHash: GOLDEN_PLAN_HASH, reserveKey, operationKey,
      tenders: [
        { method: 'CASH', receivedAmount: 3003700n, referenceKey: null, institution: null, institutionOther: null },
        { method: 'CARD_DEBIT', receivedAmount: null, referenceKey: 'D009', institution: null, institutionOther: null },
      ],
    });
    expect(hash).toBe(GOLDEN_CONFIRMATION_HASH);
  });

  it('CRED-10 a plan with CARD_CREDIT hashes deterministically and differently from the same plan without it', () => {
    const withCredit: PlanInput = {
      ...historicalPlan, balanceMethod: 'CARD_CREDIT',
      tenders: [
        { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2003700n, externalCollectionId: null },
        { method: 'CARD_CREDIT', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      ],
    };
    const first = planHash(withCredit);
    expect(planHash(withCredit)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(GOLDEN_PLAN_HASH);
    expect(canonicalPlanText(withCredit)).toContain('tender=CARD_CREDIT|BALANCE|NEW|-|-\n');
  });

  it('orders tenders CASH, TRANSFER, CARD_DEBIT, CARD_CREDIT whatever the input order', () => {
    const tenders: PlanInput['tenders'] = [
      { method: 'CARD_CREDIT', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 100n, externalCollectionId: null },
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 200n, externalCollectionId: null },
    ];
    const text = canonicalPlanText({ ...historicalPlan, balanceMethod: 'CARD_CREDIT', tenders });
    const methods = text.split('\n').filter((row) => row.startsWith('tender=')).map((row) => row.slice(7).split('|')[0]);
    expect(methods).toEqual(['CASH', 'TRANSFER', 'CARD_CREDIT']);
    expect(planHash({ ...historicalPlan, balanceMethod: 'CARD_CREDIT', tenders })).toBe(
      planHash({ ...historicalPlan, balanceMethod: 'CARD_CREDIT', tenders: [...tenders].reverse() }),
    );
  });

  // Every combination with credit: exact bytes, input-order independence, distinct hashes.
  const permutations = <T,>(items: T[]): T[][] => (items.length < 2 ? [items]
    : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));
  const tenderOf = (method: PlanInput['tenders'][number]['method'], balance: boolean): PlanInput['tenders'][number] => (
    { method, role: balance ? 'BALANCE' : 'FIXED', source: 'NEW', amount: balance ? null : 1000n, externalCollectionId: null });
  const COMBINATIONS: Array<[string, Array<PlanInput['tenders'][number]['method']>, PlanInput['tenders'][number]['method'], string[]]> = [
    ['credit only (balance)', ['CARD_CREDIT'], 'CARD_CREDIT', ['tender=CARD_CREDIT|BALANCE|NEW|-|-']],
    ['CASH + CREDIT (credit balance)', ['CARD_CREDIT', 'CASH'], 'CARD_CREDIT', ['tender=CASH|FIXED|NEW|1000|-', 'tender=CARD_CREDIT|BALANCE|NEW|-|-']],
    ['TRANSFER + CREDIT (credit balance)', ['CARD_CREDIT', 'TRANSFER'], 'CARD_CREDIT', ['tender=TRANSFER|FIXED|NEW|1000|-', 'tender=CARD_CREDIT|BALANCE|NEW|-|-']],
    ['DEBIT + CREDIT (credit balance)', ['CARD_CREDIT', 'CARD_DEBIT'], 'CARD_CREDIT', ['tender=CARD_DEBIT|FIXED|NEW|1000|-', 'tender=CARD_CREDIT|BALANCE|NEW|-|-']],
    ['CREDIT fixed + CASH balance', ['CARD_CREDIT', 'CASH'], 'CASH', ['tender=CASH|BALANCE|NEW|-|-', 'tender=CARD_CREDIT|FIXED|NEW|1000|-']],
    ['CREDIT fixed + TRANSFER balance', ['CARD_CREDIT', 'TRANSFER'], 'TRANSFER', ['tender=TRANSFER|BALANCE|NEW|-|-', 'tender=CARD_CREDIT|FIXED|NEW|1000|-']],
    ['CREDIT fixed + DEBIT balance', ['CARD_CREDIT', 'CARD_DEBIT'], 'CARD_DEBIT', ['tender=CARD_DEBIT|BALANCE|NEW|-|-', 'tender=CARD_CREDIT|FIXED|NEW|1000|-']],
    ['CASH + DEBIT + CREDIT', ['CARD_CREDIT', 'CARD_DEBIT', 'CASH'], 'CASH',
      ['tender=CASH|BALANCE|NEW|-|-', 'tender=CARD_DEBIT|FIXED|NEW|1000|-', 'tender=CARD_CREDIT|FIXED|NEW|1000|-']],
  ];
  it.each(COMBINATIONS)('CRED-11 %s: exact canonical rows, the same bytes and hash for every input order', (_label, methods, balance, rows) => {
    const tenders = methods.map((method) => tenderOf(method, method === balance));
    const reference = { ...historicalPlan, balanceMethod: balance, tenders };
    const text = canonicalPlanText(reference);
    expect(text.split('\n').filter((row) => row.startsWith('tender='))).toEqual(rows);
    expect(text.split('\n')[0]).toBe('mona-checkout-plan/v1');
    for (const order of permutations(tenders)) {
      expect(canonicalPlanText({ ...reference, tenders: order })).toBe(text);
      expect(planHash({ ...reference, tenders: order })).toBe(planHash(reference));
    }
  });

  it('CRED-12 the hashes of the credit combinations are pairwise distinct', () => {
    const hashes = COMBINATIONS.map(([, methods, balance]) => planHash({
      ...historicalPlan, balanceMethod: balance, tenders: methods.map((method) => tenderOf(method, method === balance)),
    }));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('a CARD_CREDIT confirmation tender carries a reference and no institution', () => {
    const base = { planHash: GOLDEN_PLAN_HASH, reserveKey, operationKey };
    const ok = canonicalConfirmationText({
      ...base, tenders: [{ method: 'CARD_CREDIT', receivedAmount: null, referenceKey: 'CRD0001', institution: null, institutionOther: null }],
    });
    expect(ok).toContain('tender=CARD_CREDIT|-|CRD0001|-|-\n');
    expect(() => canonicalConfirmationText({
      ...base, tenders: [{ method: 'CARD_CREDIT', receivedAmount: null, referenceKey: 'CRD0001', institution: 'GALICIA', institutionOther: null }],
    })).toThrow();
  });

  it('still refuses QR', () => {
    expect(() => canonicalPlanText({
      ...historicalPlan,
      tenders: [{ method: 'QR' as never, role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }],
    })).toThrow();
  });
});
