// Code 128 subset B encoder (printable ASCII 32-126), pure and dependency-free.
//
// ADM-15-A: encodes the barcode string that already exists on each
// ProductVariant. It never derives a code from price or any other field.
// Each symbol is 11 modules wide (bar/space widths below, 6 digits); the stop
// symbol has 7 widths (13 modules).

export const MAX_BARCODE_LENGTH = 64;

const START_B = 104;
const STOP = 106;
const FIRST_CHAR = 32;
const LAST_CHAR = 126;

// Symbol values 0..106 as alternating bar/space widths (bar first).
const PATTERNS: readonly string[] = (
  '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 ' +
  '113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 ' +
  '212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 ' +
  '113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 ' +
  '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 ' +
  '241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 ' +
  '214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 ' +
  '211232 2331112'
).split(' ');

function symbolModules(value: number): string {
  let bar = true;
  let modules = '';
  for (const width of PATTERNS[value]) {
    modules += (bar ? '1' : '0').repeat(Number(width));
    bar = !bar;
  }
  return modules;
}

export type Code128Encoded = {
  ok: true;
  value: string;
  // Symbol values: Start B, one per character, checksum, Stop.
  symbols: number[];
  checksum: number;
  // Bar (1) / space (0) pattern, without quiet zones.
  modules: string;
  width: number;
};

export type Code128Failure = {
  ok: false;
  code: 'EMPTY' | 'TOO_LONG' | 'NON_PRINTABLE_ASCII';
};

export function encodeCode128B(value: unknown): Code128Encoded | Code128Failure {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, code: 'EMPTY' };
  if (value.length > MAX_BARCODE_LENGTH) return { ok: false, code: 'TOO_LONG' };

  const characters: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < FIRST_CHAR || code > LAST_CHAR) return { ok: false, code: 'NON_PRINTABLE_ASCII' };
    characters.push(code - FIRST_CHAR);
  }

  let sum = START_B;
  characters.forEach((symbol, index) => {
    sum += symbol * (index + 1);
  });
  const checksum = sum % 103;

  const symbols = [START_B, ...characters, checksum, STOP];
  const modules = symbols.map(symbolModules).join('');
  return { ok: true, value, symbols, checksum, modules, width: modules.length };
}
