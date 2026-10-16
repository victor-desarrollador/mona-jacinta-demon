// R3-A4.3 S2 — canonical texts and hashes of a checkout plan and confirmation.
// DB-free. Contract: consolidated §4 (mona-checkout-plan/v1,
// mona-checkout-confirmation/v1), unchanged by C1–C5 §5 and the later
// adjustments (stock recovery and the T-RR justification never enter a hash).
//
// The reference vectors are hand-written texts; each SHA-256 below was computed
// from that literal text with an independent SHA-256 (not with the module under
// test), and the UTF-8 hex of the non-ASCII label was derived byte by byte.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CheckoutCanonicalError,
  MAX_PG_BIGINT,
  canonicalConfirmationText,
  canonicalPlanText,
  confirmationHash,
  institutionOtherHex,
  normalizeInstitutionOther,
  normalizeReferenceKey,
  planHash,
  type ConfirmationInput,
  type PlanInput,
} from '../../src/modules/payments/checkout-canonical.js';
import { normalizeReferenceKey as serviceNormalizeReferenceKey } from '../../src/modules/payments/checkout.service.js';

const SALE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const SESSION = '9b2e1c3a-7d4f-4e8a-b1c2-3d4e5f6a7b8c';
const COLLECTION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const RESERVE = 'c9bf9e57-1685-4c89-bafb-ff5af830be8a';
const OPERATION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'ascii')).digest('hex');

// V1: three tenders given OUT of canonical order.
const PLAN_V1: PlanInput = {
  saleId: SALE, cashSessionId: SESSION, balanceMethod: 'CASH', expectedTotal: 152300n, expectedBalanceAmount: 52300n,
  tenders: [
    { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 50000n, externalCollectionId: COLLECTION },
    { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
    { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 50000n, externalCollectionId: null },
  ],
};
const PLAN_V1_TEXT = [
  'mona-checkout-plan/v1',
  `saleId=${SALE}`,
  `cashSessionId=${SESSION}`,
  'balanceMethod=CASH',
  'expectedTotal=152300',
  'expectedBalanceAmount=52300',
  'tenderCount=3',
  'tender=CASH|BALANCE|NEW|-|-',
  'tender=TRANSFER|FIXED|NEW|50000|-',
  `tender=CARD_DEBIT|FIXED|COLLECTION|50000|${COLLECTION}`,
  '',
].join('\n');
const PLAN_V1_HASH = '865f82c7c4270694a0b6f063652bea174b0ba8b198142e65632b2f6a4b0af3e6';

// V2: single tender, PostgreSQL BIGINT maximum.
const PLAN_V2: PlanInput = {
  saleId: SALE, cashSessionId: SESSION, balanceMethod: 'TRANSFER', expectedTotal: 9223372036854775807n, expectedBalanceAmount: 100n,
  tenders: [{ method: 'TRANSFER', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null }],
};
const PLAN_V2_HASH = 'c6bd8e2d3417d99f8cb1d2b3592e49a13305888d0c4994d5d11e75f1ae9be3fb';

const CONF_V1: ConfirmationInput = {
  planHash: PLAN_V1_HASH, reserveKey: RESERVE, operationKey: OPERATION,
  tenders: [
    { method: 'TRANSFER', receivedAmount: null, referenceKey: 'OP00123ABC', institution: 'MERCADO_PAGO', institutionOther: null },
    { method: 'CARD_DEBIT', receivedAmount: null, referenceKey: null, institution: null, institutionOther: null },
    { method: 'CASH', receivedAmount: 60000n, referenceKey: null, institution: null, institutionOther: null },
  ],
};
const CONF_V1_TEXT = [
  'mona-checkout-confirmation/v1',
  `planHash=${PLAN_V1_HASH}`,
  `reserveKey=${RESERVE}`,
  `operationKey=${OPERATION}`,
  'tender=CASH|60000|-|-|-',
  'tender=TRANSFER|-|OP00123ABC|MERCADO_PAGO|-',
  'tender=CARD_DEBIT|-|-|-|-',
  '',
].join('\n');
const CONF_V1_HASH = 'c8718232a70c9892876e91394e2301f370e45514a094e19fa515a856632ed3fe';

// V2: non-ASCII OTHER institution label ("Cooperativa Ñandú"), received cash 0.
// UTF-8: "Cooperativa " 436f6f706572617469766120, Ñ c391, "and" 616e64, ú c3ba.
const LABEL_HEX = '436f6f706572617469766120c391616e64c3ba';
const conf2 = (label: string): ConfirmationInput => ({
  planHash: PLAN_V1_HASH, reserveKey: RESERVE, operationKey: OPERATION,
  tenders: [
    { method: 'CASH', receivedAmount: 0n, referenceKey: null, institution: null, institutionOther: null },
    { method: 'TRANSFER', receivedAmount: null, referenceKey: 'TRF998877', institution: 'OTHER', institutionOther: label },
  ],
});
const CONF_V2_HASH = 'e94891ba53f0bd849a6098dd9a09aa5bb5dd8f2e43a6da9834d863bc80d90bff';

const refuses = (run: () => unknown, pattern: RegExp) => {
  expect(run).toThrow(CheckoutCanonicalError);
  expect(run).toThrow(pattern);
};

describe('R3-A4.3 S2 — planHash canonical text (mona-checkout-plan/v1)', () => {
  it('C01 reference vector V1: exact text, ASCII bytes with a final LF, SHA-256 hex', () => {
    expect(sha(PLAN_V1_TEXT)).toBe(PLAN_V1_HASH); // the vector itself is self-consistent
    expect(canonicalPlanText(PLAN_V1)).toBe(PLAN_V1_TEXT);
    expect(planHash(PLAN_V1)).toBe(PLAN_V1_HASH);
    expect(planHash(PLAN_V1)).toMatch(/^[0-9a-f]{64}$/);
    // Printable ASCII and LF only (so no BOM, no CR), and no space before a line end.
    const bytes = Buffer.from(canonicalPlanText(PLAN_V1), 'utf8');
    expect([...bytes].every((byte) => byte === 0x0a || (byte >= 0x20 && byte <= 0x7e))).toBe(true);
    expect(canonicalPlanText(PLAN_V1)).not.toContain(' \n');
    expect(bytes.at(-1)).toBe(0x0a);
  });

  it('C02 every tender order gives the same text and hash (fixed order CASH, TRANSFER, CARD_DEBIT)', () => {
    const [a, b, c] = PLAN_V1.tenders;
    for (const order of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
      expect(planHash({ ...PLAN_V1, tenders: order as PlanInput['tenders'] })).toBe(PLAN_V1_HASH);
    }
  });

  it('C03 reference vector V2: BIGINT maximum is encoded exactly; one past it is refused', () => {
    expect(planHash(PLAN_V2)).toBe(PLAN_V2_HASH);
    expect(canonicalPlanText(PLAN_V2)).toContain('expectedTotal=9223372036854775807\n');
    expect(MAX_PG_BIGINT).toBe(9223372036854775807n);
    refuses(() => planHash({ ...PLAN_V2, expectedTotal: 9223372036854775808n }), /BIGINT/);
  });

  it('C04 every plan field changes the hash (no field is ignored)', () => {
    const variants: PlanInput[] = [
      { ...PLAN_V1, saleId: 'a47ac10b-58cc-4372-a567-0e02b2c3d479' },
      { ...PLAN_V1, cashSessionId: 'ab2e1c3a-7d4f-4e8a-b1c2-3d4e5f6a7b8c' },
      { ...PLAN_V1, balanceMethod: 'TRANSFER' },
      { ...PLAN_V1, expectedTotal: 152301n },
      { ...PLAN_V1, expectedBalanceAmount: 52400n },
      { ...PLAN_V1, tenders: PLAN_V1.tenders.slice(1) },
      { ...PLAN_V1, tenders: PLAN_V1.tenders.map((t) => (t.method === 'TRANSFER' ? { ...t, amount: 50001n } : t)) },
      { ...PLAN_V1, tenders: PLAN_V1.tenders.map((t) => (t.method === 'CARD_DEBIT' ? { ...t, externalCollectionId: '2a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' } : t)) },
      { ...PLAN_V1, tenders: PLAN_V1.tenders.map((t) => (t.method === 'TRANSFER' ? { ...t, role: 'BALANCE' as const, amount: null } : t)) },
      { ...PLAN_V1, tenders: PLAN_V1.tenders.map((t) => (t.method === 'CARD_DEBIT' ? { ...t, source: 'NEW' as const, externalCollectionId: null } : t)) },
    ];
    const hashes = new Set(variants.map((v) => planHash(v)));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(PLAN_V1_HASH)).toBe(false);
  });

  it('C05 UUIDs must be canonical lowercase v4 (uppercase, braces, no hyphens, other versions or variants are refused)', () => {
    for (const bad of [
      SALE.toUpperCase(), `{${SALE}}`, SALE.replace(/-/g, ''), 'f47ac10b-58cc-1372-a567-0e02b2c3d479',
      'f47ac10b-58cc-4372-c567-0e02b2c3d479', '00000000-0000-0000-0000-000000000000', ` ${SALE}`, '',
    ]) {
      refuses(() => planHash({ ...PLAN_V1, saleId: bad }), /UUID/);
      refuses(() => planHash({ ...PLAN_V1, cashSessionId: bad }), /UUID/);
    }
    refuses(() => planHash({ ...PLAN_V1, tenders: PLAN_V1.tenders.map((t) => (t.source === 'COLLECTION' ? { ...t, externalCollectionId: COLLECTION.toUpperCase() } : t)) }), /UUID/);
  });

  it('C06 amounts are BigInt only: Number, negative, non-integer types and undefined are refused; null means absent ("-")', () => {
    const bad: unknown[] = [152300, -1n, '152300', undefined, 1.5];
    for (const value of bad) refuses(() => planHash({ ...PLAN_V1, expectedTotal: value as bigint }), /BigInt|BIGINT/);
    refuses(() => planHash({ ...PLAN_V1, tenders: PLAN_V1.tenders.map((t) => (t.method === 'TRANSFER' ? { ...t, amount: 50000 as unknown as bigint } : t)) }), /BigInt/);
    refuses(() => planHash({ ...PLAN_V1, tenders: PLAN_V1.tenders.map((t) => (t.method === 'TRANSFER' ? { ...t, amount: undefined as unknown as null } : t)) }), /explicit null/);
    expect(canonicalPlanText({ ...PLAN_V1, expectedBalanceAmount: 0n })).toContain('expectedBalanceAmount=0\n');
  });

  it('C07 duplicated methods, unknown methods/roles/sources and 0 or 4+ tenders are refused', () => {
    refuses(() => planHash({ ...PLAN_V1, tenders: [...PLAN_V1.tenders, PLAN_V1.tenders[1]!] }), /tender/);
    refuses(() => planHash({ ...PLAN_V1, tenders: [PLAN_V1.tenders[1]!, PLAN_V1.tenders[1]!] }), /duplicated/);
    refuses(() => planHash({ ...PLAN_V1, tenders: [] }), /tender/);
    for (const method of ['CARD_CREDIT', 'QR', 'cash', '']) {
      refuses(() => planHash({ ...PLAN_V1, tenders: [{ ...PLAN_V1.tenders[1]!, method: method as 'CASH' }] }), /method/);
      refuses(() => planHash({ ...PLAN_V1, balanceMethod: method as 'CASH' }), /method/);
    }
    refuses(() => planHash({ ...PLAN_V1, tenders: [{ ...PLAN_V1.tenders[1]!, role: 'OTHER' as 'FIXED' }] }), /role/);
    refuses(() => planHash({ ...PLAN_V1, tenders: [{ ...PLAN_V1.tenders[1]!, source: 'OLD' as 'NEW' }] }), /source/);
  });
});

describe('R3-A4.3 S2 — confirmationHash canonical text (mona-checkout-confirmation/v1)', () => {
  it('C10 reference vector V1: exact text and hash; tender order irrelevant', () => {
    expect(sha(CONF_V1_TEXT)).toBe(CONF_V1_HASH);
    expect(canonicalConfirmationText(CONF_V1)).toBe(CONF_V1_TEXT);
    expect(confirmationHash(CONF_V1)).toBe(CONF_V1_HASH);
    const reversed = { ...CONF_V1, tenders: [...CONF_V1.tenders].reverse() };
    expect(confirmationHash(reversed)).toBe(CONF_V1_HASH);
  });

  it('C11 reference vector V2: OTHER label trimmed, NFC-normalised, UTF-8 lowercase hex; NFC and NFD inputs hash the same', () => {
    const nfc = 'Cooperativa Ñandú';
    const nfd = 'Cooperativa Ñandú';
    expect(nfc).not.toBe(nfd);
    expect(institutionOtherHex(nfc)).toBe(LABEL_HEX);
    expect(institutionOtherHex(nfd)).toBe(LABEL_HEX);
    expect(institutionOtherHex(`  ${nfd}\t `)).toBe(LABEL_HEX);
    for (const label of [nfc, nfd, `   ${nfc}  `]) expect(confirmationHash(conf2(label))).toBe(CONF_V2_HASH);
    expect(canonicalConfirmationText(conf2(nfd))).toContain(`tender=TRANSFER|-|TRF998877|OTHER|${LABEL_HEX}\n`);
    // received cash 0 is present ("0"), not absent ("-").
    expect(canonicalConfirmationText(conf2(nfc))).toContain('tender=CASH|0|-|-|-\n');
  });

  it('C12 every confirmation field changes the hash', () => {
    const variants: ConfirmationInput[] = [
      { ...CONF_V1, planHash: PLAN_V2_HASH },
      { ...CONF_V1, reserveKey: 'a9bf9e57-1685-4c89-bafb-ff5af830be8a' },
      { ...CONF_V1, operationKey: 'ac9e6679-7425-40de-944b-e07fc1f90ae7' },
      { ...CONF_V1, tenders: CONF_V1.tenders.map((t) => (t.method === 'CASH' ? { ...t, receivedAmount: 60001n } : t)) },
      { ...CONF_V1, tenders: CONF_V1.tenders.map((t) => (t.method === 'TRANSFER' ? { ...t, referenceKey: 'OP00123ABD' } : t)) },
      { ...CONF_V1, tenders: CONF_V1.tenders.map((t) => (t.method === 'TRANSFER' ? { ...t, institution: 'BBVA' as const } : t)) },
      { ...CONF_V1, tenders: CONF_V1.tenders.map((t) => (t.method === 'CARD_DEBIT' ? { ...t, referenceKey: 'DEB123' } : t)) },
    ];
    const hashes = new Set(variants.map((v) => confirmationHash(v)));
    expect(hashes.size).toBe(variants.length);
    expect(hashes.has(CONF_V1_HASH)).toBe(false);
  });

  it('C13 absent, null and empty are distinct: undefined and empty strings are refused, only null means "-"', () => {
    const transfer = (patch: Record<string, unknown>) => ({
      ...CONF_V1, tenders: CONF_V1.tenders.map((t) => (t.method === 'TRANSFER' ? { ...t, ...patch } : t)),
    }) as ConfirmationInput;
    refuses(() => confirmationHash(transfer({ referenceKey: '' })), /referenceKey/);
    refuses(() => confirmationHash(transfer({ referenceKey: undefined })), /explicit null/);
    refuses(() => confirmationHash(transfer({ institution: 'OTHER', institutionOther: '' })), /institutionOther/);
    refuses(() => confirmationHash(transfer({ institution: 'OTHER', institutionOther: '   ' })), /institutionOther/);
    refuses(() => confirmationHash(transfer({ institution: 'OTHER', institutionOther: null })), /institutionOther/);
    refuses(() => confirmationHash(transfer({ institutionOther: 'Banco X' })), /institutionOther/); // not OTHER
  });

  it('C14 referenceKey must already be normalised [A-Z0-9]{3,40}; the normaliser matches the R3-A2 service exactly', () => {
    for (const bad of ['op00123abc', 'OP-00123', 'AB', 'A'.repeat(41), 'ÑANDU1']) {
      refuses(() => confirmationHash({ ...CONF_V1, tenders: CONF_V1.tenders.map((t) => (t.method === 'TRANSFER' ? { ...t, referenceKey: bad } : t)) }), /referenceKey/);
    }
    for (const raw of ['op-00123 abc', '  Op 00-123/abc  ', 'straße 12', 'ñ-123-x', '0001', '---']) {
      expect(normalizeReferenceKey(raw)).toBe(serviceNormalizeReferenceKey(raw));
    }
    expect(normalizeReferenceKey('op-00123 abc')).toBe('OP00123ABC');
  });

  it('C15 per-method shape: cash carries only receivedAmount; only TRANSFER carries an institution; planHash must be 64 lowercase hex', () => {
    const patch = (method: string, p: Record<string, unknown>) => ({
      ...CONF_V1, tenders: CONF_V1.tenders.map((t) => (t.method === method ? { ...t, ...p } : t)),
    }) as ConfirmationInput;
    refuses(() => confirmationHash(patch('CASH', { referenceKey: 'ABC123' })), /CASH/);
    refuses(() => confirmationHash(patch('CASH', { receivedAmount: null })), /CASH/);
    refuses(() => confirmationHash(patch('TRANSFER', { receivedAmount: 1n })), /receivedAmount/);
    refuses(() => confirmationHash(patch('CARD_DEBIT', { institution: 'BBVA' })), /institution/);
    refuses(() => confirmationHash(patch('TRANSFER', { referenceKey: null })), /institution/); // institution without reference
    refuses(() => confirmationHash(patch('CASH', { receivedAmount: MAX_PG_BIGINT + 1n })), /BIGINT/);
    expect(confirmationHash(patch('CASH', { receivedAmount: MAX_PG_BIGINT }))).toMatch(/^[0-9a-f]{64}$/);
    for (const bad of [PLAN_V1_HASH.toUpperCase(), PLAN_V1_HASH.slice(1), `${PLAN_V1_HASH}0`, 'g'.repeat(64)]) {
      refuses(() => confirmationHash({ ...CONF_V1, planHash: bad }), /planHash/);
    }
    refuses(() => confirmationHash({ ...CONF_V1, tenders: [...CONF_V1.tenders, CONF_V1.tenders[0]!] }), /tender/);
    refuses(() => confirmationHash({ ...CONF_V1, reserveKey: RESERVE.toUpperCase() }), /UUID/);
  });
});

describe('R3-A4.3 S2 REVISE — one shared institutionOther normaliser', () => {
  it('C20 normalizeInstitutionOther = trim → NFC; institutionOtherHex is exactly its UTF-8 hex', () => {
    const nfd = '  Cooperativa N\u0303andu\u0301 \t';
    expect(normalizeInstitutionOther(nfd)).toBe('Cooperativa \u00d1and\u00fa');
    expect(normalizeInstitutionOther('Banco Ña')).toBe('Banco Ña'.normalize('NFC'));
    for (const value of [nfd, ' x ', 'Cooperativa \u00d1and\u00fa', '\u212b']) {
      expect(institutionOtherHex(value)).toBe(Buffer.from(normalizeInstitutionOther(value), 'utf8').toString('hex'));
    }
    // Idempotent.
    expect(normalizeInstitutionOther(normalizeInstitutionOther(nfd))).toBe(normalizeInstitutionOther(nfd));
  });
});
