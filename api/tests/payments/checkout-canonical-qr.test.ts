// The canonical checkout text/hash with QR (P0-B).
//
// The grammar of mona-checkout-plan/v1 and mona-checkout-confirmation/v1 is UNCHANGED: a
// tender is one row `tender=<METHOD>|...` and the method set only grows (CASH, TRANSFER,
// CARD_DEBIT, CARD_CREDIT, QR). A plan without QR therefore keeps its exact historical
// bytes and hash (golden vectors shared with checkout-canonical-credit.test.ts), so no
// stored hash stops verifying and no canonical version needs to change. A QR tender is an
// external, referenced collection like CARD_DEBIT / CARD_CREDIT: it carries a reference
// and NO institution.
import { describe, expect, it } from 'vitest';
import {
  CHECKOUT_ALGORITHM_VERSION,
  CHECKOUT_ALGORITHM_VERSION_NO_QR,
  CHECKOUT_METHODS,
  MAX_CHECKOUT_TENDERS,
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

// The same golden vectors as the CARD_CREDIT block: produced before CARD_CREDIT and QR existed.
const GOLDEN_PLAN_HASH = '5fe890d5193e72af8580b5fcbfb724732d805179608f28b234fbe698c40afe89';
const GOLDEN_CONFIRMATION_HASH = '37d2913325f711662f62a4d0b0661f6b232ee8e597c7372e2c0ab20a4b671484';

const historicalPlan: PlanInput = {
  saleId, cashSessionId, balanceMethod: 'CARD_DEBIT', expectedTotal: 5153700n, expectedBalanceAmount: 3150000n,
  tenders: [
    { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2003700n, externalCollectionId: null },
    { method: 'CARD_DEBIT', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
  ],
};

describe('canonical checkout with QR', () => {
  it('lists the five methods in the canonical order, still at most three tenders', () => {
    expect([...CHECKOUT_METHODS]).toEqual(['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT', 'QR']);
    expect(MAX_CHECKOUT_TENDERS).toBe(3);
  });

  it('QR-C1 the snapshot-format version is 3 (QR snapshot); 2 and 1 stay the historical formats', () => {
    // The text/hash grammar does not change; the version only says which snapshot columns are meaningful.
    expect(CHECKOUT_ALGORITHM_VERSION).toBe(3);
    expect(CHECKOUT_ALGORITHM_VERSION_NO_QR).toBe(2);
  });

  it('QR-C2 a plan without QR keeps its historical bytes and hash (still mona-checkout-plan/v1)', () => {
    expect(canonicalPlanText(historicalPlan).startsWith('mona-checkout-plan/v1\n')).toBe(true);
    expect(planHash(historicalPlan)).toBe(GOLDEN_PLAN_HASH);
  });

  it('QR-C3 a confirmation without QR keeps its historical hash', () => {
    const hash = confirmationHash({
      planHash: GOLDEN_PLAN_HASH, reserveKey, operationKey,
      tenders: [
        { method: 'CASH', receivedAmount: 3003700n, referenceKey: null, institution: null, institutionOther: null },
        { method: 'CARD_DEBIT', receivedAmount: null, referenceKey: 'D009', institution: null, institutionOther: null },
      ],
    });
    expect(hash).toBe(GOLDEN_CONFIRMATION_HASH);
  });

  it('QR-C4 a plan with QR hashes deterministically and differently from the same plan without it', () => {
    const withQr: PlanInput = {
      ...historicalPlan, balanceMethod: 'QR',
      tenders: [
        { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 2003700n, externalCollectionId: null },
        { method: 'QR', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      ],
    };
    const first = planHash(withQr);
    expect(planHash(withQr)).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(GOLDEN_PLAN_HASH);
    expect(canonicalPlanText(withQr)).toContain('tender=QR|BALANCE|NEW|-|-\n');
  });

  it('QR-C5 orders tenders CASH, TRANSFER, CARD_DEBIT, CARD_CREDIT, QR whatever the input order', () => {
    const tenders: PlanInput['tenders'] = [
      { method: 'QR', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
      { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 100n, externalCollectionId: null },
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: 200n, externalCollectionId: null },
    ];
    const text = canonicalPlanText({ ...historicalPlan, balanceMethod: 'QR', tenders });
    const methods = text.split('\n').filter((row) => row.startsWith('tender=')).map((row) => row.slice(7).split('|')[0]);
    expect(methods).toEqual(['CASH', 'TRANSFER', 'QR']);
    expect(planHash({ ...historicalPlan, balanceMethod: 'QR', tenders })).toBe(
      planHash({ ...historicalPlan, balanceMethod: 'QR', tenders: [...tenders].reverse() }),
    );
  });

  const permutations = <T,>(items: T[]): T[][] => (items.length < 2 ? [items]
    : items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])));
  const tenderOf = (method: PlanInput['tenders'][number]['method'], balance: boolean): PlanInput['tenders'][number] => (
    { method, role: balance ? 'BALANCE' : 'FIXED', source: 'NEW', amount: balance ? null : 1000n, externalCollectionId: null });
  const COMBINATIONS: Array<[string, Array<PlanInput['tenders'][number]['method']>, PlanInput['tenders'][number]['method'], string[]]> = [
    ['QR only (balance)', ['QR'], 'QR', ['tender=QR|BALANCE|NEW|-|-']],
    ['CASH + QR (QR balance)', ['QR', 'CASH'], 'QR', ['tender=CASH|FIXED|NEW|1000|-', 'tender=QR|BALANCE|NEW|-|-']],
    ['TRANSFER + QR (QR balance)', ['QR', 'TRANSFER'], 'QR', ['tender=TRANSFER|FIXED|NEW|1000|-', 'tender=QR|BALANCE|NEW|-|-']],
    ['DEBIT + QR (QR balance)', ['QR', 'CARD_DEBIT'], 'QR', ['tender=CARD_DEBIT|FIXED|NEW|1000|-', 'tender=QR|BALANCE|NEW|-|-']],
    ['CREDIT + QR (QR balance)', ['QR', 'CARD_CREDIT'], 'QR', ['tender=CARD_CREDIT|FIXED|NEW|1000|-', 'tender=QR|BALANCE|NEW|-|-']],
    ['QR fixed + CASH balance', ['QR', 'CASH'], 'CASH', ['tender=CASH|BALANCE|NEW|-|-', 'tender=QR|FIXED|NEW|1000|-']],
    ['QR fixed + TRANSFER balance', ['QR', 'TRANSFER'], 'TRANSFER', ['tender=TRANSFER|BALANCE|NEW|-|-', 'tender=QR|FIXED|NEW|1000|-']],
    ['QR fixed + DEBIT balance', ['QR', 'CARD_DEBIT'], 'CARD_DEBIT', ['tender=CARD_DEBIT|BALANCE|NEW|-|-', 'tender=QR|FIXED|NEW|1000|-']],
    ['QR fixed + CREDIT balance', ['QR', 'CARD_CREDIT'], 'CARD_CREDIT', ['tender=CARD_CREDIT|BALANCE|NEW|-|-', 'tender=QR|FIXED|NEW|1000|-']],
    ['CASH + CREDIT + QR', ['QR', 'CARD_CREDIT', 'CASH'], 'CASH',
      ['tender=CASH|BALANCE|NEW|-|-', 'tender=CARD_CREDIT|FIXED|NEW|1000|-', 'tender=QR|FIXED|NEW|1000|-']],
  ];
  it.each(COMBINATIONS)('QR-C6 %s: exact canonical rows, the same bytes and hash for every input order', (_label, methods, balance, rows) => {
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

  it('QR-C7 the hashes of the QR combinations are pairwise distinct', () => {
    const hashes = COMBINATIONS.map(([, methods, balance]) => planHash({
      ...historicalPlan, balanceMethod: balance, tenders: methods.map((method) => tenderOf(method, method === balance)),
    }));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('QR-C8 four tenders are still refused', () => {
    expect(() => planHash({
      ...historicalPlan,
      tenders: [
        tenderOf('CASH', true), tenderOf('TRANSFER', false), tenderOf('CARD_DEBIT', false), tenderOf('QR', false),
      ],
    })).toThrow(/1 to 3 tenders/);
  });

  it('QR-C9 a QR confirmation tender carries a reference and no institution, and no received amount', () => {
    const base = { planHash: GOLDEN_PLAN_HASH, reserveKey, operationKey };
    const ok = canonicalConfirmationText({
      ...base, tenders: [{ method: 'QR', receivedAmount: null, referenceKey: 'QR0001', institution: null, institutionOther: null }],
    });
    expect(ok).toContain('tender=QR|-|QR0001|-|-\n');
    expect(() => canonicalConfirmationText({
      ...base, tenders: [{ method: 'QR', receivedAmount: null, referenceKey: 'QR0001', institution: 'GALICIA', institutionOther: null }],
    })).toThrow();
    expect(() => canonicalConfirmationText({
      ...base, tenders: [{ method: 'QR', receivedAmount: 100n, referenceKey: 'QR0001', institution: null, institutionOther: null }],
    })).toThrow();
  });

  it('QR-C10 a QR confirmation hash is deterministic and differs from CARD_CREDIT with the same reference', () => {
    const base = { planHash: GOLDEN_PLAN_HASH, reserveKey, operationKey };
    const tender = (method: 'QR' | 'CARD_CREDIT') => ({ method, receivedAmount: null, referenceKey: 'R0001', institution: null, institutionOther: null });
    const qr = confirmationHash({ ...base, tenders: [tender('QR')] });
    expect(confirmationHash({ ...base, tenders: [tender('QR')] })).toBe(qr);
    expect(qr).not.toBe(confirmationHash({ ...base, tenders: [tender('CARD_CREDIT')] }));
  });

  it('still refuses an unknown method', () => {
    expect(() => canonicalPlanText({
      ...historicalPlan,
      tenders: [{ method: 'PAYPAL' as never, role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }],
    })).toThrow();
  });
});
