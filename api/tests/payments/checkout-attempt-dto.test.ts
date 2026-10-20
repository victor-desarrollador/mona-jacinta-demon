// R3-A4.3 S2 — wire DTOs of the durable checkout attempt. DB-free.
// Contract: consolidated §3 (reservation, confirmation, close), C1–C5 §4.2
// (stock recovery), last-REVISE §3.2 (T-RR = reservation + recovery) and §2
// (T-S recovers only a RESERVED attempt by its reserveKey, so it is required).
// The external-refund DTO belongs to S-REF and is not part of S2.
import { describe, expect, it } from 'vitest';
import { checkoutCloseDto, checkoutCloseParamsDto } from '../../src/modules/payments/dto/checkout-close.dto.js';
import { checkoutReservationDto, checkoutReservationParamsDto } from '../../src/modules/payments/dto/checkout-reservation.dto.js';
import { checkoutStockRecoveryDto } from '../../src/modules/payments/dto/checkout-stock-recovery.dto.js';
import { checkoutConfirmationDto, checkoutConfirmationParamsDto, checkoutParamsDto, checkoutRequestDto } from '../../src/modules/payments/dto/checkout.dto.js';
import { confirmationHash, institutionOtherHex } from '../../src/modules/payments/checkout-canonical.js';

const SALE = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const SESSION = '9b2e1c3a-7d4f-4e8a-b1c2-3d4e5f6a7b8c';
const COLLECTION = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const RESERVE = 'c9bf9e57-1685-4c89-bafb-ff5af830be8a';
const OPERATION = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const MAX = '9223372036854775807';
const OVER = '9223372036854775808';
const BAD_UUIDS = [RESERVE.toUpperCase(), RESERVE.replace(/-/g, ''), 'c9bf9e57-1685-1c89-bafb-ff5af830be8a', 'c9bf9e57-1685-4c89-cafb-ff5af830be8a', `{${RESERVE}}`, '', 123];
const BAD_MONEY: unknown[] = ['01', '-1', '1.5', '1e3', ' 1', '1 ', '', '+1', '0x10', 100, 100n, null, OVER];

type Json = Record<string, unknown>;
const ok = (schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown) => {
  const result = schema.safeParse(value);
  expect(result.success, JSON.stringify(result.error ?? null)).toBe(true);
};
const ko = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown, label = '') => {
  expect(schema.safeParse(value).success, `${label} ${JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`).toBe(false);
};
const reason = 'motivo verificado del supervisor';

// --------------------------------------------------------------- reservation
const reservation = (patch: Json = {}): Json => ({
  reserveKey: RESERVE, cashSessionId: SESSION, balanceMethod: 'CASH', expectedTotal: '152300', expectedBalanceAmount: '52300',
  tenders: [
    { method: 'CASH', role: 'BALANCE', source: 'NEW' },
    { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: '50000' },
    { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: '50000', externalCollectionId: COLLECTION },
  ],
  ...patch,
});
const withTenders = (tenders: Json[], patch: Json = {}) => reservation({ tenders, ...patch });

describe('R3-A4.3 S2 — reservation DTO (POST /sales/:saleId/checkout/reservations)', () => {
  it('D01 parses into BigInt money and canonical plan tenders; recovery is null when absent', () => {
    expect(checkoutReservationDto.parse(reservation())).toEqual({
      reserveKey: RESERVE, cashSessionId: SESSION, balanceMethod: 'CASH', expectedTotal: 152300n, expectedBalanceAmount: 52300n,
      tenders: [
        { method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null, externalCollectionId: null },
        { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: 50000n, externalCollectionId: null },
        { method: 'CARD_DEBIT', role: 'FIXED', source: 'COLLECTION', amount: 50000n, externalCollectionId: COLLECTION },
      ],
      recovery: null,
    });
    ok(checkoutReservationParamsDto, { saleId: SALE });
    ko(checkoutReservationParamsDto, { saleId: SALE.toUpperCase() });
  });

  it('D02 T-RR: an optional recovery {reason 10..500, evidence 3..200}, trimmed; bounds counted in code points', () => {
    expect(checkoutReservationDto.parse(reservation({ recovery: { reason: `  ${reason}  `, evidence: ' cupón 123 ' } })).recovery)
      .toEqual({ reason, evidence: 'cupón 123' });
    ok(checkoutReservationDto, reservation({ recovery: { reason: 'ñ'.repeat(500), evidence: 'ñ'.repeat(200) } }));
    for (const recovery of [
      { reason: 'x'.repeat(9), evidence: 'ok1' }, { reason: 'x'.repeat(501), evidence: 'ok1' }, { reason, evidence: 'ab' },
      { reason, evidence: 'x'.repeat(201) }, { reason: `   ${'x'.repeat(9)}   `, evidence: 'ok1' }, { reason }, { evidence: 'ok1' },
      { reason, evidence: 'ok1', extra: 1 }, null, 'motivo',
    ]) ko(checkoutReservationDto, reservation({ recovery }), 'recovery');
  });

  it('D03 tender structure: 1..3 tenders, no repeated method, exactly one BALANCE in balanceMethod', () => {
    ok(checkoutReservationDto, withTenders([{ method: 'TRANSFER', role: 'BALANCE', source: 'NEW' }], { balanceMethod: 'TRANSFER' }));
    ko(checkoutReservationDto, withTenders([]), 'empty');
    ko(checkoutReservationDto, withTenders([
      { method: 'CASH', role: 'BALANCE', source: 'NEW' }, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: '1' },
      { method: 'CARD_DEBIT', role: 'FIXED', source: 'NEW', amount: '1' }, { method: 'CASH', role: 'FIXED', source: 'NEW', amount: '1' },
    ]), 'four');
    ko(checkoutReservationDto, withTenders([{ method: 'CASH', role: 'BALANCE', source: 'NEW' }, { method: 'CASH', role: 'FIXED', source: 'NEW', amount: '1' }]), 'duplicate method');
    ko(checkoutReservationDto, withTenders([{ method: 'CASH', role: 'FIXED', source: 'NEW', amount: '1' }]), 'no BALANCE');
    ko(checkoutReservationDto, withTenders([{ method: 'CASH', role: 'BALANCE', source: 'NEW' }, { method: 'TRANSFER', role: 'BALANCE', source: 'NEW' }]), 'two BALANCE');
    ko(checkoutReservationDto, withTenders([{ method: 'TRANSFER', role: 'BALANCE', source: 'NEW' }]), 'BALANCE not in balanceMethod');
  });

  it('D04 every invalid role × source × method × amount × collection combination is refused (oracle = chk_tender_shape)', () => {
    const valid = (t: Json) => {
      if (t.role === 'BALANCE') return t.source === 'NEW' && t.amount === undefined && t.externalCollectionId === undefined;
      if (t.source === 'NEW') return typeof t.amount === 'string' && t.amount !== '0' && t.externalCollectionId === undefined;
      return t.method !== 'CASH' && typeof t.amount === 'string' && t.amount !== '0' && t.externalCollectionId !== undefined;
    };
    let accepted = 0;
    for (const method of ['CASH', 'TRANSFER', 'CARD_DEBIT']) for (const role of ['BALANCE', 'FIXED']) for (const source of ['NEW', 'COLLECTION'])
      for (const amount of [undefined, '0', '50000']) for (const externalCollectionId of [undefined, COLLECTION]) {
        const tender: Json = { method, role, source, ...(amount === undefined ? {} : { amount }), ...(externalCollectionId === undefined ? {} : { externalCollectionId }) };
        // Pair the tender with a BALANCE in another method when it is FIXED, so only its own shape is under test.
        const balance = method === 'CASH' ? 'TRANSFER' : 'CASH';
        const body = role === 'BALANCE'
          ? withTenders([tender], { balanceMethod: method })
          : withTenders([{ method: balance, role: 'BALANCE', source: 'NEW' }, tender], { balanceMethod: balance });
        const expected = valid(tender);
        if (expected) accepted += 1;
        expect(checkoutReservationDto.safeParse(body).success, JSON.stringify(tender)).toBe(expected);
      }
    expect(accepted).toBe(3 + 3 + 2);
  });

  it('D05 CARD_CREDIT is a proportional method (balance, NEW fixed, COLLECTION fixed); QR and unknown methods are refused', () => {
    ok(checkoutReservationDto, reservation({ balanceMethod: 'CARD_CREDIT', tenders: [
      { method: 'CARD_CREDIT', role: 'BALANCE', source: 'NEW' },
      { method: 'CASH', role: 'FIXED', source: 'NEW', amount: '1' },
    ] }));
    ok(checkoutReservationDto, withTenders([
      { method: 'CASH', role: 'BALANCE', source: 'NEW' },
      { method: 'CARD_CREDIT', role: 'FIXED', source: 'COLLECTION', amount: '50000', externalCollectionId: COLLECTION },
    ]));
    for (const method of ['QR', 'cash', 'OTHER']) {
      ko(checkoutReservationDto, reservation({ balanceMethod: method }), method);
      ko(checkoutReservationDto, withTenders([{ method: 'CASH', role: 'BALANCE', source: 'NEW' }, { method, role: 'FIXED', source: 'NEW', amount: '1' }]), method);
    }
  });

  it('D06 money: decimal centavo strings only, up to the PostgreSQL BIGINT maximum; plan amounts mirror chk_attempt_plan', () => {
    for (const bad of BAD_MONEY) {
      ko(checkoutReservationDto, reservation({ expectedTotal: bad }), 'expectedTotal');
      ko(checkoutReservationDto, withTenders([{ method: 'CASH', role: 'BALANCE', source: 'NEW' }, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: bad }]), 'amount');
    }
    expect(checkoutReservationDto.parse(reservation({ expectedTotal: MAX })).expectedTotal).toBe(9223372036854775807n);
    ko(checkoutReservationDto, reservation({ expectedTotal: '0' }), 'expectedTotal 0');
    for (const balance of ['0', '99', '150', '10001']) ko(checkoutReservationDto, reservation({ expectedBalanceAmount: balance }), `balance ${balance}`);
    for (const balance of ['100', '10000']) ok(checkoutReservationDto, reservation({ expectedBalanceAmount: balance }));
    // A fixed tender keeps exact centavos.
    expect(checkoutReservationDto.parse(withTenders([{ method: 'CASH', role: 'BALANCE', source: 'NEW' }, { method: 'TRANSFER', role: 'FIXED', source: 'NEW', amount: '12345' }])).tenders[1]!.amount).toBe(12345n);
  });

  it('D07 UUIDs are canonical lowercase v4; unknown and server-owned fields are refused (strict)', () => {
    for (const bad of BAD_UUIDS) {
      ko(checkoutReservationDto, reservation({ reserveKey: bad }), 'reserveKey');
      ko(checkoutReservationDto, reservation({ cashSessionId: bad }), 'cashSessionId');
      ko(checkoutReservationDto, withTenders([{ method: 'CASH', role: 'BALANCE', source: 'NEW' }, { method: 'TRANSFER', role: 'FIXED', source: 'COLLECTION', amount: '1', externalCollectionId: bad }]), 'collection');
    }
    for (const extra of [{ operationKey: OPERATION }, { planHash: 'a'.repeat(64) }, { saleId: SALE }, { total: '1' }]) ko(checkoutReservationDto, reservation(extra), 'extra');
    ko(checkoutReservationDto, withTenders([{ method: 'CASH', role: 'BALANCE', source: 'NEW', receivedAmount: '1' }]), 'tender extra');
    for (const key of ['reserveKey', 'cashSessionId', 'balanceMethod', 'expectedTotal', 'expectedBalanceAmount', 'tenders']) {
      const body = reservation();
      delete body[key];
      ko(checkoutReservationDto, body, `missing ${key}`);
    }
    // null is not "absent" for a required field, and an explicit null optional is refused.
    ko(checkoutReservationDto, withTenders([{ method: 'CASH', role: 'BALANCE', source: 'NEW', amount: null }]), 'amount null');
  });
});

// --------------------------------------------------------------- confirmation
const confirmation = (patch: Json = {}): Json => ({
  reserveKey: RESERVE, operationKey: OPERATION,
  tenders: [
    { method: 'CASH', receivedAmount: '60000' },
    { method: 'TRANSFER', reference: 'op-00123 abc', institution: 'MERCADO_PAGO' },
    { method: 'CARD_DEBIT' },
  ],
  ...patch,
});
const confTender = (tender: Json) => confirmation({ tenders: [tender] });

describe('R3-A4.3 S2 — confirmation DTO (POST /sales/:saleId/checkout)', () => {
  it('D10 parses into the canonical confirmation tenders with the normalised referenceKey; supervisor is null when absent', () => {
    expect(checkoutConfirmationDto.parse(confirmation())).toEqual({
      reserveKey: RESERVE, operationKey: OPERATION,
      tenders: [
        { method: 'CASH', receivedAmount: 60000n, reference: null, referenceKey: null, institution: null, institutionOther: null },
        { method: 'TRANSFER', receivedAmount: null, reference: 'op-00123 abc', referenceKey: 'OP00123ABC', institution: 'MERCADO_PAGO', institutionOther: null },
        { method: 'CARD_DEBIT', receivedAmount: null, reference: null, referenceKey: null, institution: null, institutionOther: null },
      ],
      supervisor: null,
    });
  });

  it('D11 never accepts amounts, methods roles, session or totals: they come from the sealed plan', () => {
    for (const extra of [{ cashSessionId: SESSION }, { balanceMethod: 'CASH' }, { expectedTotal: '1' }, { expectedBalanceAmount: '100' }, { saleId: SALE }, { planHash: 'a'.repeat(64) }]) {
      ko(checkoutConfirmationDto, confirmation(extra), 'extra');
    }
    for (const extra of [{ amount: '1' }, { role: 'BALANCE' }, { source: 'NEW' }, { changeAmount: '0' }, { externalCollectionId: COLLECTION }]) {
      ko(checkoutConfirmationDto, confTender({ method: 'CASH', receivedAmount: '1', ...extra }), 'tender extra');
    }
  });

  it('D12 per-method shapes: CASH needs receivedAmount only; TRANSFER reference+institution; CARD_DEBIT reference without institution; COLLECTION carries nothing', () => {
    ok(checkoutConfirmationDto, confTender({ method: 'CASH', receivedAmount: '0' }));
    ok(checkoutConfirmationDto, confTender({ method: 'CARD_DEBIT', reference: 'DEB-123' }));
    ok(checkoutConfirmationDto, confTender({ method: 'TRANSFER' }));
    ko(checkoutConfirmationDto, confTender({ method: 'CASH' }), 'CASH without receivedAmount');
    ko(checkoutConfirmationDto, confTender({ method: 'CASH', receivedAmount: '1', reference: 'ABC123' }), 'CASH with reference');
    ko(checkoutConfirmationDto, confTender({ method: 'CASH', receivedAmount: '1', institution: 'BBVA' }), 'CASH with institution');
    ko(checkoutConfirmationDto, confTender({ method: 'TRANSFER', receivedAmount: '1' }), 'TRANSFER with receivedAmount');
    ko(checkoutConfirmationDto, confTender({ method: 'TRANSFER', reference: 'ABC123' }), 'TRANSFER without institution');
    ko(checkoutConfirmationDto, confTender({ method: 'TRANSFER', institution: 'BBVA' }), 'institution without reference');
    ko(checkoutConfirmationDto, confTender({ method: 'CARD_DEBIT', reference: 'ABC123', institution: 'BBVA' }), 'CARD_DEBIT with institution');
  });

  it('D13 institutionOther only with OTHER, trimmed, 1..60 code points; non-ASCII kept for the canonical NFC hex', () => {
    const other = (label: unknown) => confTender({ method: 'TRANSFER', reference: 'TRF998877', institution: 'OTHER', institutionOther: label });
    expect(checkoutConfirmationDto.parse(other('  Cooperativa Ñandú  ')).tenders[0]!.institutionOther).toBe('Cooperativa Ñandú');
    ok(checkoutConfirmationDto, other('ñ'.repeat(60)));
    for (const bad of ['', '   ', 'x'.repeat(61), 'ñ'.repeat(61), null, 5]) ko(checkoutConfirmationDto, other(bad), `OTHER label ${String(bad)}`);
    ko(checkoutConfirmationDto, confTender({ method: 'TRANSFER', reference: 'TRF998877', institution: 'OTHER' }), 'OTHER without label');
    for (const institution of ['MACRO', 'BBVA', 'NACION', 'GALICIA', 'MERCADO_PAGO']) {
      ok(checkoutConfirmationDto, confTender({ method: 'TRANSFER', reference: 'TRF998877', institution }));
      ko(checkoutConfirmationDto, confTender({ method: 'TRANSFER', reference: 'TRF998877', institution, institutionOther: 'Banco X' }), `${institution} with label`);
    }
    ko(checkoutConfirmationDto, confTender({ method: 'TRANSFER', reference: 'TRF998877', institution: 'SANTANDER' }), 'unknown institution');
  });

  it('D14 references: 1..64 code points raw, normalised key [A-Z0-9]{3,40}; empty or null-as-value refused', () => {
    for (const bad of ['', '--', 'ab', '-'.repeat(10), 'x'.repeat(65), 'A1'.repeat(21), null, 123]) {
      ko(checkoutConfirmationDto, confTender({ method: 'CARD_DEBIT', reference: bad }), `reference ${String(bad)}`);
    }
    expect(checkoutConfirmationDto.parse(confTender({ method: 'CARD_DEBIT', reference: ' deb/000-777 ' })).tenders[0]!.referenceKey).toBe('DEB000777');
    ok(checkoutConfirmationDto, confTender({ method: 'CARD_DEBIT', reference: 'A1'.repeat(20) }));
  });

  it('D15 tenders 1..3 without repeated methods; historical methods refused; receivedAmount money bounds; UUIDs canonical v4', () => {
    ko(checkoutConfirmationDto, confirmation({ tenders: [] }), 'empty');
    ko(checkoutConfirmationDto, confirmation({ tenders: [{ method: 'CASH', receivedAmount: '1' }, { method: 'CASH', receivedAmount: '2' }] }), 'duplicate');
    ko(checkoutConfirmationDto, confirmation({ tenders: [{ method: 'CASH', receivedAmount: '1' }, { method: 'TRANSFER' }, { method: 'CARD_DEBIT' }, { method: 'TRANSFER' }] }), 'four');
    ko(checkoutConfirmationDto, confTender({ method: 'QR' }), 'QR');
    // CARD_CREDIT: a reference (NEW) or none (COLLECTION), never an institution.
    ok(checkoutConfirmationDto, confTender({ method: 'CARD_CREDIT', reference: 'CRD 0001' }));
    ok(checkoutConfirmationDto, confTender({ method: 'CARD_CREDIT' }));
    ko(checkoutConfirmationDto, confTender({ method: 'CARD_CREDIT', reference: 'CRD 0001', institution: 'BBVA' }), 'credit with institution');
    ko(checkoutConfirmationDto, confTender({ method: 'CARD_CREDIT', receivedAmount: '1' }), 'credit with receivedAmount');
    for (const bad of BAD_MONEY) ko(checkoutConfirmationDto, confTender({ method: 'CASH', receivedAmount: bad }), 'receivedAmount');
    expect(checkoutConfirmationDto.parse(confTender({ method: 'CASH', receivedAmount: MAX })).tenders[0]!.receivedAmount).toBe(9223372036854775807n);
    for (const bad of BAD_UUIDS) {
      ko(checkoutConfirmationDto, confirmation({ reserveKey: bad }), 'reserveKey');
      ko(checkoutConfirmationDto, confirmation({ operationKey: bad }), 'operationKey');
    }
  });

  it('D16 supervisor {reason 10..500, evidence 3..200} trimmed; partial or extra fields refused', () => {
    expect(checkoutConfirmationDto.parse(confirmation({ supervisor: { reason: ` ${reason} `, evidence: ' cupón 1 ' } })).supervisor)
      .toEqual({ reason, evidence: 'cupón 1' });
    for (const supervisor of [{ reason }, { evidence: 'ok1' }, { reason: 'corto', evidence: 'ok1' }, { reason, evidence: 'ab' }, { reason, evidence: 'ok1', by: 'x' }, null]) {
      ko(checkoutConfirmationDto, confirmation({ supervisor }), 'supervisor');
    }
  });

  it('D17 compatibility: the R3-A2 checkoutRequestDto (current FIXED+proportional service path) is unchanged', () => {
    const legacy = {
      operationKey: OPERATION, cashSessionId: SESSION, balanceMethod: 'CASH', expectedTotal: '10000', expectedBalanceAmount: '10000',
      tenders: [{ method: 'CASH', role: 'BALANCE', receivedAmount: '10000' }],
    };
    expect(checkoutRequestDto.parse(legacy).expectedTotal).toBe(10000n);
  });
});

// --------------------------------------------------------------- close / declaration
const close = (declarations: Json[], patch: Json = {}): Json => ({ declarations, ...patch });
const charged = (method: string, patch: Json = {}): Json => ({
  method, outcome: 'CHARGED', amount: '50000', reference: 'op 777', evidence: 'comprobante 1',
  ...(method === 'TRANSFER' ? { institution: 'BBVA' } : {}), ...patch,
});

describe('R3-A4.3 S2 — close/declaration DTO (POST …/reservations/:reserveKey/close)', () => {
  it('D20 parses CASH NONE/RETURNED and TRANSFER/CARD_DEBIT NONE/CHARGED into typed rows', () => {
    expect(checkoutCloseDto.parse(close([
      { method: 'CASH', outcome: 'RETURNED', returnedAmount: '2000', evidence: ' recibo 1 ' },
      charged('TRANSFER'),
      { method: 'CARD_DEBIT', outcome: 'NONE' },
    ]))).toEqual({
      supervisor: null,
      declarations: [
        { method: 'CASH', outcome: 'RETURNED', returnedAmount: 2000n, amount: null, reference: null, referenceKey: null, institution: null, institutionOther: null, evidence: 'recibo 1' },
        { method: 'TRANSFER', outcome: 'CHARGED', returnedAmount: null, amount: 50000n, reference: 'op 777', referenceKey: 'OP777', institution: 'BBVA', institutionOther: null, evidence: 'comprobante 1' },
        { method: 'CARD_DEBIT', outcome: 'NONE', returnedAmount: null, amount: null, reference: null, referenceKey: null, institution: null, institutionOther: null, evidence: null },
      ],
    });
    ok(checkoutCloseParamsDto, { saleId: SALE, reserveKey: RESERVE });
    for (const bad of BAD_UUIDS) ko(checkoutCloseParamsDto, { saleId: SALE, reserveKey: bad }, 'reserveKey');
  });

  it('D21 outcome × method matrix: CASH only NONE|RETURNED, TRANSFER/CARD_DEBIT/CARD_CREDIT only NONE|CHARGED', () => {
    const rows: Record<string, Json> = {
      NONE: {}, RETURNED: { returnedAmount: '1', evidence: 'recibo 1' }, CHARGED: { amount: '1', reference: 'op 777', evidence: 'comprobante 1' },
    };
    for (const method of ['CASH', 'TRANSFER', 'CARD_DEBIT', 'CARD_CREDIT']) for (const outcome of ['NONE', 'RETURNED', 'CHARGED', 'RETAINED']) {
      const row: Json = { method, outcome, ...(rows[outcome] ?? {}), ...(outcome === 'CHARGED' && method === 'TRANSFER' ? { institution: 'BBVA' } : {}) };
      const expected = method === 'CASH' ? ['NONE', 'RETURNED'].includes(outcome) : ['NONE', 'CHARGED'].includes(outcome);
      expect(checkoutCloseDto.safeParse(close([row])).success, `${method} ${outcome}`).toBe(expected);
    }
  });

  it('D22 required and forbidden fields per outcome; evidence optional on NONE (a supervisor declaring needs it), 3..200', () => {
    ok(checkoutCloseDto, close([{ method: 'CASH', outcome: 'NONE', evidence: 'vi el cajón' }]));
    ko(checkoutCloseDto, close([{ method: 'CASH', outcome: 'RETURNED', returnedAmount: '1' }]), 'RETURNED without evidence');
    ko(checkoutCloseDto, close([{ method: 'CASH', outcome: 'RETURNED', returnedAmount: '0', evidence: 'recibo 1' }]), 'RETURNED 0');
    ko(checkoutCloseDto, close([{ method: 'CASH', outcome: 'RETURNED', evidence: 'recibo 1' }]), 'RETURNED without amount');
    ko(checkoutCloseDto, close([{ method: 'CASH', outcome: 'NONE', returnedAmount: '1' }]), 'NONE with returnedAmount');
    ko(checkoutCloseDto, close([{ method: 'TRANSFER', outcome: 'NONE', reference: 'op 777' }]), 'NONE with reference');
    ko(checkoutCloseDto, close([{ method: 'TRANSFER', outcome: 'NONE', amount: '1' }]), 'NONE with amount');
    for (const key of ['amount', 'reference', 'evidence']) {
      const row = charged('CARD_DEBIT');
      delete row[key];
      ko(checkoutCloseDto, close([row]), `CHARGED without ${key}`);
    }
    ko(checkoutCloseDto, close([charged('TRANSFER', { institution: undefined })]), 'TRANSFER CHARGED without institution');
    ko(checkoutCloseDto, close([charged('CARD_DEBIT', { institution: 'BBVA' })]), 'CARD_DEBIT CHARGED with institution');
    ko(checkoutCloseDto, close([charged('CARD_CREDIT', { institution: 'BBVA' })]), 'CARD_CREDIT CHARGED with institution');
    ko(checkoutCloseDto, close([charged('TRANSFER', { institution: 'BBVA', institutionOther: 'X' })]), 'label without OTHER');
    ok(checkoutCloseDto, close([charged('TRANSFER', { institution: 'OTHER', institutionOther: ' Cooperativa Ñandú ' })]));
    ko(checkoutCloseDto, close([charged('TRANSFER', { institution: 'OTHER' })]), 'OTHER without label');
    ko(checkoutCloseDto, close([charged('CARD_DEBIT', { amount: '0' })]), 'CHARGED 0');
    ko(checkoutCloseDto, close([charged('CARD_DEBIT', { amount: OVER })]), 'CHARGED over BIGINT');
    ko(checkoutCloseDto, close([charged('CARD_DEBIT', { reference: '--' })]), 'reference key too short');
    for (const evidence of ['ab', '  ab  ', 'x'.repeat(201), '']) ko(checkoutCloseDto, close([{ method: 'CASH', outcome: 'NONE', evidence }]), `evidence ${evidence}`);
    ko(checkoutCloseDto, close([{ method: 'CASH', outcome: 'NONE', externalCollectionId: COLLECTION }]), 'client-supplied collection id');
  });

  it('D23 1..3 rows, no repeated method; supervisor justification; unknown fields refused', () => {
    ko(checkoutCloseDto, close([]), 'empty');
    ko(checkoutCloseDto, close([{ method: 'CASH', outcome: 'NONE' }, { method: 'CASH', outcome: 'NONE' }]), 'duplicate');
    ok(checkoutCloseDto, close([{ method: 'CARD_CREDIT', outcome: 'NONE' }]));
    ko(checkoutCloseDto, close([{ method: 'QR', outcome: 'NONE' }]), 'QR');
    expect(checkoutCloseDto.parse(close([{ method: 'CASH', outcome: 'NONE', evidence: 'ok1' }], { supervisor: { reason, evidence: 'cupón 1' } })).supervisor).toEqual({ reason, evidence: 'cupón 1' });
    ko(checkoutCloseDto, close([{ method: 'CASH', outcome: 'NONE' }], { supervisor: { reason: 'corto', evidence: 'ok1' } }), 'short reason');
    ko(checkoutCloseDto, close([{ method: 'CASH', outcome: 'NONE' }], { status: 'ABANDONED' }), 'extra');
  });
});

// --------------------------------------------------------------- stock recovery
describe('R3-A4.3 S2 — supervised stock recovery DTO (POST /sales/:saleId/checkout/stock-recovery)', () => {
  it('D30 {reserveKey, reason 10..500, evidence 3..200}; reserveKey is REQUIRED (T-S recovers only a RESERVED attempt)', () => {
    expect(checkoutStockRecoveryDto.parse({ reserveKey: RESERVE, reason: ` ${reason} `, evidence: ' cupón 1 ' })).toEqual({ reserveKey: RESERVE, reason, evidence: 'cupón 1' });
    ko(checkoutStockRecoveryDto, { reason, evidence: 'cupón 1' }, 'without reserveKey');
    for (const bad of BAD_UUIDS) ko(checkoutStockRecoveryDto, { reserveKey: bad, reason, evidence: 'cupón 1' }, 'reserveKey');
    for (const [r, e] of [['x'.repeat(9), 'ok1'], ['x'.repeat(501), 'ok1'], [reason, 'ab'], [reason, 'x'.repeat(201)], [reason, '  ab  ']]) {
      ko(checkoutStockRecoveryDto, { reserveKey: RESERVE, reason: r, evidence: e }, 'bounds');
    }
    ok(checkoutStockRecoveryDto, { reserveKey: RESERVE, reason: 'x'.repeat(500), evidence: 'x'.repeat(200) });
    ko(checkoutStockRecoveryDto, { reserveKey: RESERVE, reason, evidence: 'ok1', variants: [] }, 'extra');
  });
});

// --------------------------------------------------------------- S2 REVISE
// "Cooperativa Ñandú": NFC U+00D1 / U+00FA; NFD N+U+0303 / u+U+0301.
const LABEL_NFC = 'Cooperativa \u00d1and\u00fa';
const LABEL_NFD = 'Cooperativa N\u0303andu\u0301';
const LABEL_HEX = '436f6f706572617469766120c391616e64c3ba';
// Confirmation reference vector V2 of checkout-canonical.test.ts (plan V1 hash, same keys).
const PLAN_V1_HASH = '865f82c7c4270694a0b6f063652bea174b0ba8b198142e65632b2f6a4b0af3e6';
const CONF_V2_HASH = 'e94891ba53f0bd849a6098dd9a09aa5bb5dd8f2e43a6da9834d863bc80d90bff';

describe('R3-A4.3 S2 REVISE — institutionOther is delivered trimmed AND NFC-normalised', () => {
  it('D40 confirmation: NFD input → NFC output, its UTF-8 hex and the canonical SHA-256 of vector V2', () => {
    expect(LABEL_NFD).not.toBe(LABEL_NFC);
    const parsed = checkoutConfirmationDto.parse(confirmation({
      tenders: [
        { method: 'CASH', receivedAmount: '0' },
        { method: 'TRANSFER', reference: 'TRF998877', institution: 'OTHER', institutionOther: `  ${LABEL_NFD} ` },
      ],
    }));
    const label = parsed.tenders[1]!.institutionOther;
    expect(label).toBe(LABEL_NFC);
    expect(label === null ? null : label.normalize('NFC')).toBe(label);
    expect(Buffer.from(label!, 'utf8').toString('hex')).toBe(LABEL_HEX);
    expect(institutionOtherHex(label!)).toBe(LABEL_HEX);
    const hash = confirmationHash({
      planHash: PLAN_V1_HASH, reserveKey: parsed.reserveKey, operationKey: parsed.operationKey,
      tenders: parsed.tenders.map(({ reference: _reference, ...tender }) => tender),
    });
    expect(hash).toBe(CONF_V2_HASH);
  });

  it('D41 close/declaration: a CHARGED TRANSFER OTHER label given in NFD is delivered NFC with the same hex', () => {
    const parsed = checkoutCloseDto.parse(close([charged('TRANSFER', { institution: 'OTHER', institutionOther: `${LABEL_NFD}\t` })]));
    const label = parsed.declarations[0]!.institutionOther;
    expect(label).toBe(LABEL_NFC);
    expect(Buffer.from(label!, 'utf8').toString('hex')).toBe(LABEL_HEX);
  });

  it('D42 the 1..60 bound is measured on the NFC form (60 decomposed ñ = 120 code points NFD, 60 NFC)', () => {
    const other = (value: string) => confTender({ method: 'TRANSFER', reference: 'TRF998877', institution: 'OTHER', institutionOther: value });
    ok(checkoutConfirmationDto, other('n\u0303'.repeat(60)));
    ko(checkoutConfirmationDto, other('n\u0303'.repeat(61)), '61 NFC');
    // Other institutions keep their semantics: no label at all.
    ko(checkoutConfirmationDto, confTender({ method: 'TRANSFER', reference: 'TRF998877', institution: 'BBVA', institutionOther: LABEL_NFD }), 'BBVA with label');
  });
});

describe('R3-A4.3 S2 REVISE — canonical params DTO of the confirmation route', () => {
  it('D43 checkoutConfirmationParamsDto accepts only a canonical lowercase UUID v4 saleId', () => {
    ok(checkoutConfirmationParamsDto, { saleId: SALE });
    for (const bad of [
      SALE.toUpperCase(),                              // uppercase
      'f47ac10b-58cc-1372-a567-0e02b2c3d479',          // version 1
      'f47ac10b-58cc-7372-a567-0e02b2c3d479',          // version 7
      'f47ac10b-58cc-4372-c567-0e02b2c3d479',          // invalid variant
      '00000000-0000-0000-0000-000000000000',          // nil
      SALE.replace(/-/g, ''), `{${SALE}}`, '',
    ]) ko(checkoutConfirmationParamsDto, { saleId: bad }, 'saleId');
    ko(checkoutConfirmationParamsDto, { saleId: SALE, extra: 1 }, 'strict');
  });

  it('D44 the R3-A2 checkoutParamsDto is unchanged (still z.uuid(): accepts any RFC UUID, e.g. uppercase)', () => {
    ok(checkoutParamsDto, { saleId: SALE });
    ok(checkoutParamsDto, { saleId: SALE.toUpperCase() });
  });
});
