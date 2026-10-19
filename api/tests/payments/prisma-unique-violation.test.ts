// R3 PG gate (R-1/R-2, OWNER 2026-10-18): which unique constraint a Prisma P2002
// names, in BOTH shapes the stack produces — Prisma's own meta.target and the
// @prisma/adapter-pg 7.10 shape meta.driverAdapterError.cause.constraint
// ({ index } | { fields }) that the real PostgreSQL gate observed — and the four
// payment classifiers built on it. DB-free.
import { describe, expect, it } from 'vitest';
import * as uniqueModule from '../../src/modules/payments/prisma-unique-violation.js';
import { attemptCollision } from '../../src/modules/payments/checkout-reservation.service.js';
import * as paymentsModule from '../../src/modules/payments/payments.service.js';
import { p2002, p2002Adapter } from '../helpers/checkout-reservation-fake-db.js';

const helper = () => {
  expect(typeof uniqueModule.uniqueViolation, 'uniqueViolation must be exported').toBe('function');
  expect(typeof uniqueModule.isExternalReferenceCollision, 'isExternalReferenceCollision must be exported').toBe('function');
  return uniqueModule;
};
const idempotency = () => {
  const fn = (paymentsModule as Record<string, unknown>).isIdempotencyConflict;
  expect(typeof fn, 'payments.service must export isIdempotencyConflict').toBe('function');
  return fn as (error: unknown) => boolean;
};
const withMeta = (meta: unknown) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta });

describe('uniqueViolation — the constraint a P2002 names, never inferred', () => {
  it('UV-01 meta.target as a column list (Prisma engine / legacy fakes)', () => {
    expect(helper().uniqueViolation(p2002(['reserveKey']))).toEqual({ modelName: 'CheckoutAttempt', fields: ['reserveKey'], name: null });
  });
  it('UV-02 meta.target as an index name', () => {
    expect(helper().uniqueViolation(p2002('CheckoutAttempt_one_open_per_sale'))).toEqual({ modelName: 'CheckoutAttempt', fields: null, name: 'CheckoutAttempt_one_open_per_sale' });
  });
  it('UV-03 adapter-pg constraint.index', () => {
    expect(helper().uniqueViolation(p2002Adapter({ index: 'CheckoutAttempt_reserveKey_key' }))).toEqual({ modelName: 'CheckoutAttempt', fields: null, name: 'CheckoutAttempt_reserveKey_key' });
  });
  it('UV-04 adapter-pg constraint.fields: PostgreSQL-quoted identifiers are unquoted', () => {
    expect(helper().uniqueViolation(p2002Adapter({ fields: ['"saleId"', '"idempotencyKey"'] }, 'SalePayment'))).toEqual({ modelName: 'SalePayment', fields: ['saleId', 'idempotencyKey'], name: null });
    expect(helper().uniqueViolation(p2002Adapter({ fields: ['"we""ird"', 'plain'] }))?.fields).toEqual(['we"ird', 'plain']);
  });
  it('UV-05 unknown or incomplete metadata names NOTHING (never inferred)', () => {
    const none = (meta: unknown) => expect(helper().uniqueViolation(withMeta(meta)), JSON.stringify(meta)).toEqual({ modelName: null, fields: null, name: null });
    none(undefined);
    none({});
    none({ driverAdapterError: {} });
    none({ driverAdapterError: { cause: {} } });
    none({ driverAdapterError: { cause: { kind: 'UniqueConstraintViolation' } } });
    none({ driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { foreignKey: {} } } } });
    none({ driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { index: 42 } } } });
    none({ driverAdapterError: { cause: { kind: 'UniqueConstraintViolation', constraint: { fields: ['ok', 7] } } } });
    none({ target: ['ok', 7] });
    // a constraint under a cause that is NOT a unique violation is ignored
    none({ driverAdapterError: { cause: { kind: 'ForeignKeyConstraintViolation', constraint: { index: 'CheckoutAttempt_reserveKey_key' } } } });
  });
  it('UV-06 not a P2002 at all → null', () => {
    for (const error of [null, undefined, 'P2002', new Error('x'), Object.assign(new Error('x'), { code: 'P2003', meta: { target: ['reserveKey'] } })]) {
      expect(helper().uniqueViolation(error)).toBeNull();
    }
  });
});

describe('attemptCollision (T-R / T-RR) — only its own CheckoutAttempt constraints', () => {
  it('AC-01 reserveKey: legacy target, adapter index and adapter fields', () => {
    expect(attemptCollision(p2002(['reserveKey']))).toBe('reserveKey');
    expect(attemptCollision(p2002Adapter({ index: 'CheckoutAttempt_reserveKey_key' }))).toBe('reserveKey');
    expect(attemptCollision(p2002Adapter({ fields: ['"reserveKey"'] }))).toBe('reserveKey');
  });
  it('AC-02 one open attempt per sale: legacy index name, adapter index, adapter fields (saleId)', () => {
    expect(attemptCollision(p2002('CheckoutAttempt_one_open_per_sale'))).toBe('openPerSale');
    expect(attemptCollision(p2002Adapter({ index: 'CheckoutAttempt_one_open_per_sale' }))).toBe('openPerSale');
    expect(attemptCollision(p2002Adapter({ fields: ['"saleId"'] }))).toBe('openPerSale');
  });
  it('AC-03 another constraint, another model, unknown or incomplete metadata → null', () => {
    expect(attemptCollision(p2002Adapter({ index: 'CheckoutAttempt_operationKey_key' }))).toBeNull();
    expect(attemptCollision(p2002Adapter({ index: 'SalePayment_saleId_idempotencyKey_key' }, 'SalePayment'))).toBeNull();
    expect(attemptCollision(p2002Adapter({ fields: ['"reserveKey"'] }, 'AuditLog'))).toBeNull();
    expect(attemptCollision(p2002Adapter({ fields: ['"saleId"'] }, 'SaleCheckout'))).toBeNull();
    expect(attemptCollision(withMeta({ modelName: 'CheckoutAttempt' }))).toBeNull();
    expect(attemptCollision(withMeta({ modelName: 'CheckoutAttempt', driverAdapterError: { cause: { kind: 'UniqueConstraintViolation' } } }))).toBeNull();
  });
});

describe('isExternalReferenceCollision (T-C / T-X) — only the partial external-reference indexes', () => {
  it('ER-01 both partial indexes, every shape', () => {
    const is = helper().isExternalReferenceCollision;
    for (const index of ['ExternalCollection_transfer_ref_key', 'ExternalCollection_debit_ref_key']) {
      expect(is(p2002(index, 'ExternalCollection')), index).toBe(true);
      expect(is(p2002Adapter({ index }, 'ExternalCollection')), index).toBe(true);
    }
    expect(is(p2002(['branchId', 'referenceKey'], 'ExternalCollection'))).toBe(true);
    expect(is(p2002Adapter({ fields: ['"branchId"', '"institution"', '"referenceKey"'] }, 'ExternalCollection'))).toBe(true);
  });
  it('ER-02 any other constraint or unknown metadata is NOT a reference collision', () => {
    const is = helper().isExternalReferenceCollision;
    expect(is(p2002Adapter({ index: 'ExternalCollection_id_applied_key' }, 'ExternalCollection'))).toBe(false);
    expect(is(p2002Adapter({ index: 'SalePayment_externalCollectionId_key' }, 'SalePayment'))).toBe(false);
    expect(is(p2002Adapter({ fields: ['"referenceKey"'] }, 'ExternalCollection'))).toBe(false);
    expect(is(withMeta({ modelName: 'ExternalCollection' }))).toBe(false);
    expect(is(Object.assign(new Error('x'), { code: 'P2003', meta: { target: 'ExternalCollection_debit_ref_key' } }))).toBe(false);
  });
});

describe('isIdempotencyConflict (legacy payments) — only SalePayment (saleId, idempotencyKey)', () => {
  it('IC-01 legacy target array/string, adapter index and adapter fields', () => {
    const is = idempotency();
    expect(is(p2002(['saleId', 'idempotencyKey'], 'SalePayment'))).toBe(true);
    expect(is(p2002('SalePayment_saleId_idempotencyKey_key', 'SalePayment'))).toBe(true);
    expect(is(p2002Adapter({ index: 'SalePayment_saleId_idempotencyKey_key' }, 'SalePayment'))).toBe(true);
    expect(is(p2002Adapter({ fields: ['"saleId"', '"idempotencyKey"'] }, 'SalePayment'))).toBe(true);
  });
  it('IC-02 other constraints and unknown metadata stay unclassified', () => {
    const is = idempotency();
    expect(is(p2002(['idempotencyKey'], 'SalePayment'))).toBe(false);
    expect(is(p2002Adapter({ fields: ['"idempotencyKey"'] }, 'SalePayment'))).toBe(false);
    expect(is(p2002Adapter({ index: 'SalePayment_checkoutId_method_key' }, 'SalePayment'))).toBe(false);
    expect(is(withMeta({ modelName: 'SalePayment' }))).toBe(false);
  });
});
