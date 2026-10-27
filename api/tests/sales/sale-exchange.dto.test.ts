// Sale exchange v1 — the request DTOs (shape only). DB-FREE.
//
// TWO entry points over ONE set of rules (a builder, no duplicated business rule):
//   exchangeSaleHttpDto  the HTTP edge. returnQuantity is a canonical positive decimal STRING (^[1-9][0-9]*$, at most 19 digits, <= the signed BIGINT max) and
//                        NOTHING ELSE: a JSON number of any size (1, 1000, 1e3, 2^53+1) is refused — Number never enters (M-01 of the second audit).
//   exchangeSaleDto      the domain input the service validates again: returnQuantity is already a positive BigInt (<= the signed BIGINT max); a number or a
//                        string is refused here too.
// The UUIDs are canonicalized to lower case at the edge (route param and body), so one intent has exactly one spelling. lines: 1..100.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { exchangeSaleDto, exchangeSaleHttpDto } from '../../src/modules/sales/dto/exchange-sale.dto.js';

const MAX = 9223372036854775807n;
const make = (schema: typeof exchangeSaleDto | typeof exchangeSaleHttpDto) => (returnQuantity: unknown) => schema.safeParse({
  reason: 'Cambio', idempotencyKey: randomUUID(), lines: [{ saleItemId: randomUUID(), replacementVariantId: randomUUID(), returnQuantity }],
});
const http = make(exchangeSaleHttpDto);
const internal = make(exchangeSaleDto);

describe('HTTP DTO — returnQuantity is a canonical decimal string only (M-01)', () => {
  it.each([
    ['JSON number 1', 1], ['JSON number 2', 2], ['JSON number 1000', 1000], ['JSON number MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER], ['JSON number 1e3', 1e3],
    ['JSON number 2^53 + 1 (already rounded by JSON.parse)', Number.MAX_SAFE_INTEGER + 2], ['JSON number 2^63', Number(2n ** 63n)], ['JSON number 1.5', 1.5], ['JSON number 0', 0], ['JSON number -1', -1],
    ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['a bigint', 1n],
    ['boolean true', true], ['boolean false', false], ['array [1]', [1]], ['array ["1"]', ['1']], ['object {}', {}], ['null', null], ['undefined', undefined],
    ['string "1.5"', '1.5'], ['string "1e3"', '1e3'], ['string "1E3"', '1E3'], ['string "0"', '0'], ['string "-1"', '-1'], ['string "+1"', '+1'], ['string "01"', '01'],
    ['string " 1"', ' 1'], ['string "1 "', '1 '], ['string "1\\n"', '1\n'], ['string ""', ''], ['string "0x10"', '0x10'], ['string "1_000"', '1_000'], ['string "１" (full-width)', '１'], ['string "abc"', 'abc'],
    ['string over the signed bigint max', (MAX + 1n).toString()], ['string of 20 digits', '10000000000000000000'], ['string of 40 digits', '1'.repeat(40)],
  ])('refuses %s', (_label, value) => {
    expect(http(value).success).toBe(false);
  });

  it.each([
    ['"1"', '1', 1n], ['"2"', '2', 2n], ['"1000"', '1000', 1000n], ['"123"', '123', 123n], ['2^53 + 1 as a string (exact)', '9007199254740993', 9007199254740993n],
    ['the signed bigint max as a string', MAX.toString(), MAX],
  ])('accepts %s and yields the exact BigInt', (_label, value, expected) => {
    const result = http(value);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lines[0]!.returnQuantity).toBe(expected);
  });
});

describe('domain DTO (what the service validates again) — a positive BigInt only', () => {
  it.each([['1n', 1n], ['the signed bigint max', MAX]])('accepts %s', (_label, value) => {
    const result = internal(value);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lines[0]!.returnQuantity).toBe(value);
  });
  it.each([['0n', 0n], ['-1n', -1n], ['max + 1', MAX + 1n], ['a number', 1], ['a string', '1'], ['null', null]])('refuses %s', (_label, value) => {
    expect(internal(value).success).toBe(false);
  });
});

describe('exchange DTOs — UUIDs are lower-cased at the edge (M1)', () => {
  it('lower-cases idempotencyKey, saleItemId and replacementVariantId', () => {
    const [key, item, variant] = [randomUUID(), randomUUID(), randomUUID()];
    const result = exchangeSaleHttpDto.safeParse({
      reason: 'Cambio', idempotencyKey: key.toUpperCase(), lines: [{ saleItemId: item.toUpperCase(), replacementVariantId: variant.toUpperCase(), returnQuantity: '1' }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.idempotencyKey).toBe(key);
      expect(result.data.lines[0]).toEqual({ saleItemId: item, replacementVariantId: variant, returnQuantity: 1n });
    }
  });

  it('the same saleItem in two spellings is a DUPLICATE line', () => {
    const [item, variant] = [randomUUID(), randomUUID()];
    const result = exchangeSaleHttpDto.safeParse({
      reason: 'Cambio', idempotencyKey: randomUUID(),
      lines: [{ saleItemId: item, replacementVariantId: variant, returnQuantity: '1' }, { saleItemId: item.toUpperCase(), replacementVariantId: variant, returnQuantity: '1' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('exchange DTOs — at most 100 lines (L1)', () => {
  const lines = (count: number) => Array.from({ length: count }, () => ({ saleItemId: randomUUID(), replacementVariantId: randomUUID(), returnQuantity: '1' }));
  const parseLines = (value: unknown[]) => exchangeSaleHttpDto.safeParse({ reason: 'Cambio', idempotencyKey: randomUUID(), lines: value });
  it('100 lines are accepted, 101 are refused, 0 are refused', () => {
    expect(parseLines(lines(100)).success).toBe(true);
    expect(parseLines(lines(101)).success).toBe(false);
    expect(parseLines([]).success).toBe(false);
  });
  it('the duplicate saleItemId rule still applies at the limit (100 lines, one repeated -> refused)', () => {
    const many = lines(100);
    many[99] = { ...many[99]!, saleItemId: many[0]!.saleItemId };
    expect(parseLines(many).success).toBe(false);
  });
});
