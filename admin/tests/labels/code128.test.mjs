export const ORACLE_VECTORS = {
 "A": {
  "symbols": [
   104,
   33,
   34,
   106
  ],
  "checksum": 34,
  "modules": "1101001000010100011000100010110001100011101011"
 },
 "0": {
  "symbols": [
   104,
   16,
   17,
   106
  ],
  "checksum": 17,
  "modules": "1101001000010011101100100111001101100011101011"
 },
 " ": {
  "symbols": [
   104,
   0,
   1,
   106
  ],
  "checksum": 1,
  "modules": "1101001000011011001100110011011001100011101011"
 },
 "~": {
  "symbols": [
   104,
   94,
   95,
   106
  ],
  "checksum": 95,
  "modules": "1101001000010001011110101111010001100011101011"
 },
 "Hello": {
  "symbols": [
   104,
   40,
   69,
   76,
   76,
   79,
   76,
   106
  ],
  "checksum": 76,
  "modules": "110100100001100010100010110010000110010100001100101000010001111010110010100001100011101011"
 },
 "DEMO-JEA-OXF-AZU-42": {
  "symbols": [
   104,
   36,
   37,
   45,
   47,
   13,
   42,
   37,
   33,
   13,
   47,
   56,
   38,
   13,
   33,
   58,
   53,
   13,
   20,
   18,
   25,
   106
  ],
  "checksum": 25,
  "modules": "1101001000010110001000100011010001011101100010001110110100110111001011011100010001101000101000110001001101110010001110110111000101101000110001010011011100101000110001110110001011011101110100110111001100100111011001110010111001011001100011101011"
 },
 "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx": {
  "symbols": [
   104,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   88,
   10,
   106
  ],
  "checksum": 10,
  "modules": "1101001000011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010111100100101111001001011110010010110010001001100011101011"
 },
 "ab c": {
  "symbols": [
   104,
   65,
   66,
   0,
   67,
   54,
   106
  ],
  "checksum": 54,
  "modules": "1101001000010010110000100100001101101100110010000101100111010110001100011101011"
 },
 " abc ": {
  "symbols": [
   104,
   0,
   65,
   66,
   67,
   0,
   82,
   106
  ],
  "checksum": 82,
  "modules": "110100100001101100110010010110000100100001101000010110011011001100100100111101100011101011"
 },
 "!\"#$%&'()*+,-./": {
  "symbols": [
   104,
   1,
   2,
   3,
   4,
   5,
   6,
   7,
   8,
   9,
   10,
   11,
   12,
   13,
   14,
   15,
   5,
   106
  ],
  "checksum": 5,
  "modules": "11010010000110011011001100110011010010011000100100011001000100110010011001000100110001001000110010011001001000110010001001100010010010110011100100110111001001100111010111001100100010011001100011101011"
 }
};
export const ORACLE_ALL95_SHA256 = "36a9edad7cb295121f8b41248e5981d34cb827508b4a683e664b3c55e464b729";

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeCode128B, MAX_BARCODE_LENGTH } from '../../src/lib/labels/code128.ts';

// Reference vectors above were produced by an independent Code 128
// implementation (reportlab 5.0.1) and are embedded as literals; the encoder
// under test never sees that implementation.
const START_B_BITS = '11010010000';
const STOP_BITS = '1100011101011';

test('encoder exposes the 64-character limit of the variant barcode contract', () => {
  assert.equal(MAX_BARCODE_LENGTH, 64);
});

for (const [value, expected] of Object.entries(ORACLE_VECTORS)) {
  test(`matches the independent reference for ${JSON.stringify(value.length > 24 ? value.slice(0, 8) + '…(' + value.length + ')' : value)}`, () => {
    const result = encodeCode128B(value);
    assert.equal(result.ok, true);
    assert.equal(result.value, value);
    assert.deepEqual(result.symbols, expected.symbols);
    assert.equal(result.checksum, expected.checksum);
    assert.equal(result.modules, expected.modules);
    assert.equal(result.width, 11 * value.length + 35);
    assert.equal(result.modules.length, result.width);
  });
}

test('checksum vectors computed by hand: "A"=34, " "=1, "0"=17, "Hello"=76, "~"=95, "DEMO-JEA-OXF-AZU-42"=25', () => {
  const expected = { A: 34, ' ': 1, 0: 17, Hello: 76, '~': 95, 'DEMO-JEA-OXF-AZU-42': 25 };
  for (const [value, checksum] of Object.entries(expected)) {
    assert.equal(encodeCode128B(value).checksum, checksum, value);
  }
});

test('"A" is framed by Start B and Stop and is 46 modules wide', () => {
  const result = encodeCode128B('A');
  assert.equal(result.width, 46);
  assert.ok(result.modules.startsWith(START_B_BITS));
  assert.ok(result.modules.endsWith(STOP_BITS));
  assert.match(result.modules, /^[01]+$/);
});

test('every printable ASCII character (32-126) encodes to the reference bit pattern', () => {
  let all = '';
  for (let code = 32; code <= 126; code += 1) {
    const result = encodeCode128B(String.fromCharCode(code));
    assert.equal(result.ok, true, `char ${code}`);
    assert.equal(result.symbols[1], code - 32);
    all += `${result.modules}|`;
  }
  assert.equal(createHash('sha256').update(all).digest('hex'), ORACLE_ALL95_SHA256);
});

test('adversarial 1: empty string is rejected as EMPTY', () => {
  assert.deepEqual(encodeCode128B(''), { ok: false, code: 'EMPTY' });
});

test('adversarial 1b: non-string values are rejected as EMPTY without throwing', () => {
  for (const bad of [null, undefined, 12345, {}, []]) {
    assert.deepEqual(encodeCode128B(bad), { ok: false, code: 'EMPTY' });
  }
});

test('adversarial 2: characters outside ASCII 32-126 are rejected, never transliterated', () => {
  for (const bad of ['Ñandú', 'café', '日本', '😀', 'a\tb', 'a\nb', 'a\u0000b', 'a\u007fb', 'ab c']) {
    assert.deepEqual(encodeCode128B(bad), { ok: false, code: 'NON_PRINTABLE_ASCII' }, JSON.stringify(bad));
  }
});

test('adversarial 3: 64 characters encode (739 modules) and 65 are TOO_LONG', () => {
  const ok = encodeCode128B('x'.repeat(64));
  assert.equal(ok.ok, true);
  assert.equal(ok.width, 739);
  assert.deepEqual(encodeCode128B('x'.repeat(65)), { ok: false, code: 'TOO_LONG' });
});

test('adversarial 3b: length is checked before the alphabet', () => {
  assert.deepEqual(encodeCode128B('Ñ'.repeat(65)), { ok: false, code: 'TOO_LONG' });
});

test('characters that are special in XML/SVG are valid barcode data and returned verbatim', () => {
  const value = '<"&\'>';
  const result = encodeCode128B(value);
  assert.equal(result.ok, true);
  assert.equal(result.value, value);
});

test('encoding is deterministic and does not mutate or share state between calls', () => {
  const first = encodeCode128B('MJ-123');
  const second = encodeCode128B('MJ-123');
  assert.deepEqual(first, second);
  first.symbols.push(999);
  assert.deepEqual(encodeCode128B('MJ-123'), second);
});
