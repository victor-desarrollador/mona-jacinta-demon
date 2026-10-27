// One transient-transaction classifier for the critical money / stock services that retry a Serializable transaction (H2 + audit follow-up).
// DB-free and static: the shared classifier knows every shape the driver stack produces; a service-local copy would silently miss some (that is how
// the sale exchange and the sale void missed the @prisma/adapter-pg shapes).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isTransientTransactionError } from '../../src/shared/transient-transaction-error.js';

const read = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

// Migrated: the same retry on a serialization failure / deadlock / write conflict, now with the full shape coverage.
const MIGRATED = [
  'modules/sales/sale-void.service.ts', 'modules/sales/sale-exchange.service.ts', 'modules/inventory/inventory-adjustment.service.ts',
  'modules/sales/cancellation.service.ts', 'modules/sales/pending-correction.service.ts', 'modules/sales/sales.service.ts', 'modules/sales/reservation.service.ts',
  'modules/payments/payments.service.ts', 'modules/payments/checkout.service.ts', 'modules/payments/checkout-reservation.service.ts', 'modules/payments/checkout-stock-recovery.service.ts',
  // H-01 of the second audit: initial-stock and cash joined, keeping ONLY their exact expected unique violation (P2002 of one named constraint each)
  'modules/inventory/initial-stock.service.ts', 'modules/cash/cash.service.ts',
];

describe('transient classifier — one shared implementation', () => {
  it.each(MIGRATED)('%s imports the shared classifier and carries no local SQLSTATE string matching', (path) => {
    const source = read(path);
    expect(source).toMatch(/from '\.\.\/\.\.\/shared\/transient-transaction-error\.js'/);
    expect(source).not.toMatch(/message\.includes\('40001'\)/);
    expect(source).not.toMatch(/meta\?\.code === '40001'/);
  });

  it('the P2002 each of them still understands is the EXACT constraint it expects, never a bare code', () => {
    const initialStock = read('modules/inventory/initial-stock.service.ts');
    const cash = read('modules/cash/cash.service.ts');
    expect(initialStock).not.toMatch(/code === 'P2002'/);
    expect(cash).not.toMatch(/code === 'P2002'/);
    expect(initialStock).toMatch(/isInventoryFirstRowRace/);
    expect(cash).toMatch(/cash_session_one_open_per_register/);
    expect(read('modules/inventory/inventory-unique-race.ts')).toMatch(/Inventory_variantId_branchId_key/);
  });
});

describe('isTransientTransactionError — shapes', () => {
  it.each<[string, unknown]>([
    ['P2034', { code: 'P2034' }],
    ['SQLSTATE 40001 as code', { code: '40001' }],
    ['SQLSTATE 40P01 as code', { code: '40P01' }],
    ['meta.code 40001', { code: 'P2010', meta: { code: '40001' } }],
    ['meta.code 40P01', { code: 'P2010', meta: { code: '40P01' } }],
    ['adapter originalCode 40001', { meta: { driverAdapterError: { cause: { originalCode: '40001' } } } }],
    ['adapter originalCode 40P01', { meta: { driverAdapterError: { cause: { originalCode: '40P01' } } } }],
    ['adapter cause.code 40001', { meta: { driverAdapterError: { cause: { code: '40001' } } } }],
    ['adapter kind TransactionWriteConflict', { meta: { driverAdapterError: { cause: { kind: 'TransactionWriteConflict' } } } }],
    ['message token 40001', new Error('ERROR: could not serialize access (40001)')],
    ['message TransactionWriteConflict', new Error('Transaction failed due to a write conflict (TransactionWriteConflict)')],
    ['cause chain', { cause: { cause: { code: 'P2034' } } }],
  ])('transient: %s', (_label, error) => {
    expect(isTransientTransactionError(error)).toBe(true);
  });

  it.each<[string, unknown]>([
    ['null', null], ['a string', '40001'], ['P2002', { code: 'P2002' }], ['23505', { code: '23505' }], ['40001 inside another number', new Error('row 140001 missing')],
    ['a cause chain deeper than the guard', { cause: { cause: { cause: { cause: { cause: { cause: { code: 'P2034' } } } } } } }],
  ])('not transient: %s', (_label, error) => {
    expect(isTransientTransactionError(error)).toBe(false);
  });
});
