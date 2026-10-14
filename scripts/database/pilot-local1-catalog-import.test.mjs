import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync as realCloseSync,
  fsyncSync as realFsyncSync,
  mkdtempSync,
  openSync as realOpenSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  unlinkSync as realUnlinkSync,
  writeFileSync,
  writeSync as realWriteSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import {
  ImportError,
  buildCatalogPlan,
  classifyImportState,
  executionDigest,
  importTransaction,
  main,
  parseCliArgs,
  parseLocal1Workbook,
  verifyBackupArchive,
} from './pilot-local1-catalog-import.mjs';
import * as importerModule from './pilot-local1-catalog-import.mjs';
import { APPROVED_MIGRATION_PAYLOAD } from './pilot-migrate.mjs';
import { NestedTransactionFailure, loadCanonical } from './pilot-catalog-bootstrap.mjs';

// Every workbook, backup and database row in this file is SYNTHETIC. The real
// spreadsheet and its costs are never stored in the repository.
//
// PRE-CLASSIFIED EXPECTATIONS (written before the implementation):
//   W01 valid synthetic sheet maps every column, normalizes the name, keeps the raw text  -> PASS
//   W02 a header text or a header fill moved                                             -> HEADER
//   W03 a second sheet, a hidden sheet, or a renamed sheet                               -> SHEET
//   W04 a data formula without a cached value                                            -> FORMULA_NO_CACHE
//   W05 a formula other than E=F/D, I=J/H, totals=SUM                                    -> FORMULA_UNEXPECTED
//   W06 yellow stock != red stock; stock 0, negative or fractional                       -> STOCK
//   W07 list price that is not a positive amount with an exact 80% cash price            -> LIST_PRICE
//   W08 cost with 3 decimals or negative                                                 -> COST
//   W09 cost 0 and cost > list are KEPT and reported as anomalies                        -> PASS + 2 anomalies
//   W10 duplicate SKU (case-insensitive) / slug collision / missing description          -> SKU / SLUG / ROW_TEXT
//   W11 any value outside B,D,E,F,H,I,J or outside the data/total rows                   -> STRAY_CELL
//   W12 totals row missing or not equal to the sum                                        -> TOTALS
//   W13 E x D != F, or |I x H - J| > 0.01                                                -> VALUED
//   W14 unexpected merges                                                                 -> LAYOUT
//   W15 SKU > 64 or name > 120 characters                                                 -> LENGTH
//   W16 expected item/unit counts differ from the sheet                                  -> COUNTS
//   P01 the catalog digest changes with one cent, row order and file hash                -> CHANGES
//   P02 the execution digest binds location, marker, project and tool                     -> CHANGES
//   D01 every planned row passes the canonical Product/Variant/initial-stock DTOs          -> PASS
//   C01 CLI: unknown, duplicate or missing arguments; partial target triple               -> REFUSED, nothing read
//   M01 dry-run: hash mismatch fails before parsing                                       -> REFUSED
//   M02 dry-run: no URL file, client, Prisma or network; stdout has no cost; private report 0600 -> PASS
//   B01 backup: sha, magic, mode, age, future, dbname, PILOT schema, required tables       -> each REFUSED; valid -> PASS
//   A01 authorize: needs a TTY and the exact typed phrase; writes a 0600 single-use record -> PASS / REFUSED
//   E01 execute: plan mismatch before the URL file; DEBUG/PGOPTIONS refused               -> REFUSED, nothing opened
//   E02 execute: forged, expired, foreign or consumed authorization                        -> REFUSED before any client
//   E03 execute: failed marker proof does not consume the authorization                    -> REFUSED
//   E04 execute: full fake run consumes the authorization once and commits                 -> PASS
//   T01 ABSENT -> creates exactly the plan through the services, other branches untouched -> CREATED
//   T02 EXACT re-run -> no writes                                                          -> NOOP
//   T03 partial prior import / changed price / extra movement (a sale) / stock elsewhere  -> CONFLICT, no writes
//   T04 barcode or slug collision with another product                                     -> CONFLICT
//   T05 wrong location type, inactive, unknown, or non-PILOT company                       -> CONFLICT
//   T06 migration ledger not exactly the 7 approved; marker mismatch                       -> STOP
//   T07 a nested service failure                                                           -> NestedTransactionFailure
//   T08 another branch's inventory changes during the transaction                          -> VERIFY
//   T09 an existing "General"/"Sin marca" is reused, never duplicated                      -> CREATED
// M-1 POST-COMMIT EXPECTATIONS (fixed before the implementation):
//   M1-01 createPrisma fails before a transaction -> no persistence claim.
//   M1-02 transaction callback throws -> no persistence claim, no receipt.
//   M1-03 transaction resolves and receipt directory is unwritable -> PERSISTED, no blind retry.
//   M1-04 receipt exclusive create EACCES -> PERSISTED.
//   M1-05 receipt write ENOSPC -> PERSISTED.
//   M1-06 receipt fsync EIO -> PERSISTED.
//   M1-07 receipt close EIO -> PERSISTED.
//   M1-08 receipt timestamp failure after COMMIT -> PERSISTED.
//   M1-09 callback resolves, COMMIT rejects -> UNCERTAIN; no success or rollback claim.
//   M1-10 callback rejects before COMMIT -> PRECOMMIT; no persistence claim.
//   M1-11 confirmed COMMIT and receipt success -> COMPLETE.
//   M1-12 confirmed NOOP and receipt success -> COMPLETE, no writes.
//   M1-13 consumed authorization cannot be reused after a missing receipt.
//   M1-14 new authorization may check EXACT and complete a NOOP.
//   M1-15 all error channels omit URL, password, and cost amounts.
//   M1-16 a receipt directory with non-private permissions -> PERSISTED, no success.
// M-1 PARTIAL-WRITE EXPECTATIONS (fixed before the implementation):
//   W1-01 a realistic 4096-byte short write followed by the remainder -> exact bytes, PASS.
//   W1-02 repeated short writes, including a split UTF-8 code point -> exact bytes, PASS.
//   W1-03 write returning zero -> STOP at the call-site phase; no infinite loop.
//   W1-04 negative or non-integer write counts -> STOP at the call-site phase.
//   W1-05 ENOSPC after partial progress -> STOP with sanitized output.
//   W1-06 EINTR/EAGAIN policy: fail closed immediately (no automatic retry).
//   W1-07 authorization fsync EIO -> authorize fails; the record cannot authorize execution.
//   W1-08 authorization close EIO -> authorize fails; the record cannot authorize execution.
//   W1-09 a partial authorization record -> authorize fails and no later client is created.
//   W1-10 a partial consumed marker -> stop before Prisma; retry sees the authorization consumed.
//   W1-11 a partial report -> dry-run fails with no DRY RUN success line.
//   W1-12 a partial receipt after confirmed COMMIT -> PERSISTED, exit 1, no success line.
//   W1-13 exclusive-open failures -> sanitized STOP in report/authorize call-site phases.

// --- synthetic workbook builder ------------------------------------------------------

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.from(e.data, 'utf8');
    const body = deflateRawSync(raw);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// styles: 0 none, 1 yellow, 2 red, 3 grey (data B), 4 white (data numbers)
const STYLES = `<?xml version="1.0"?><styleSheet ${NS}><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF0F0F0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/></patternFill></fill></fills><cellXfs count="5"><xf fillId="0"/><xf fillId="2"/><xf fillId="3"/><xf fillId="4"/><xf fillId="5"/></cellXfs></styleSheet>`;

// Synthetic rows: [B text, stock, list unit (pesos), cost unit (pesos), cost valued override]
const SYN = [
  ['SYN-001 Taza  ceramica', 3, '10000', '4000'],
  ['SYN-002 Vela', 1, '2500', '0'],
  ['ÑAN-003 Muñeco de tela', 2, '5000', '6000'],
  ['SYN-004 Libreta', 2, '1250', '333.33', '666.66'],
];

const mul = (a, b) => {
  const [i, f = ''] = String(a).split('.');
  const scaled = BigInt(i + f.padEnd(2, '0')) * BigInt(b);
  const s = scaled.toString().padStart(3, '0');
  const out = `${s.slice(0, -2)}.${s.slice(-2)}`.replace(/\.?0+$/, '');
  return out === '' ? '0' : out;
};
const sumStr = (values) => {
  const cents = values.reduce((acc, v) => {
    const [i, f = ''] = String(v).split('.');
    return acc + BigInt(i + f.padEnd(2, '0'));
  }, 0n);
  const s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`.replace(/\.?0+$/, '') || '0';
};

function sheetXml(rows = SYN, mutate = {}) {
  const cells = new Map();
  const put = (ref, spec) => cells.set(ref, spec);
  put('B2', { s: 0, str: 'productos' });
  put('D2', { s: 1, str: 'precio de lista' }); put('E2', { s: 1 }); put('F2', { s: 1 });
  put('H2', { s: 2, str: 'precio de costo' }); put('I2', { s: 2 }); put('J2', { s: 2 });
  put('B3', { s: 0, str: 'codigo / sku' });
  put('D3', { s: 1, str: 'stock' }); put('E3', { s: 1, str: 'precio unitario' }); put('F3', { s: 1, str: 'stock valorizado' });
  put('H3', { s: 2, str: 'stock' }); put('I3', { s: 2, str: 'precio unitario' }); put('J3', { s: 2, str: 'stock valorizado' });
  rows.forEach(([text, stock, list, cost, costValued], i) => {
    const r = 4 + i;
    const listValued = mul(list, stock);
    const cv = costValued ?? mul(cost, stock);
    put(`B${r}`, { s: 3, str: text });
    put(`C${r}`, { s: 3 });
    put(`D${r}`, { s: 4, v: String(stock) });
    put(`E${r}`, { s: 4, f: `F${r}/D${r}`, v: list });
    put(`F${r}`, { s: 4, v: listValued });
    put(`G${r}`, { s: 4 });
    put(`H${r}`, { s: 4, v: String(stock) });
    put(`I${r}`, { s: 4, f: `J${r}/H${r}`, v: cost });
    put(`J${r}`, { s: 4, v: cv });
  });
  const last = 3 + rows.length;
  const t = last + 1;
  put(`B${t}`, { s: 0, str: 'total' });
  put(`E${t}`, { s: 0, f: `SUM(E4:E${last})`, v: sumStr(rows.map((x) => x[2])) });
  put(`F${t}`, { s: 0, f: `SUM(F4:F${last})`, v: sumStr(rows.map((x) => mul(x[2], x[1]))) });
  put(`I${t}`, { s: 0, f: `SUM(I4:I${last})`, v: sumStr(rows.map((x) => x[3])) });
  put(`J${t}`, { s: 0, f: `SUM(J4:J${last})`, v: sumStr(rows.map((x) => x[4] ?? mul(x[3], x[1]))) });
  for (const [ref, spec] of Object.entries(mutate.cells ?? {})) {
    if (spec === null) cells.delete(ref);
    else put(ref, { ...(cells.get(ref) ?? { s: 0 }), ...spec });
  }
  const byRow = new Map();
  for (const [ref, spec] of cells) {
    const row = Number(ref.replace(/^[A-Z]+/, ''));
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push([ref, spec]);
  }
  const colNum = (ref) => [...ref.replace(/[0-9]+$/, '')].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  const rowsXml = [...byRow.keys()].sort((a, b) => a - b).map((row) => {
    const cs = byRow.get(row).sort((a, b) => colNum(a[0]) - colNum(b[0])).map(([ref, spec]) => {
      if (spec.str !== undefined) return `<c r="${ref}" s="${spec.s}" t="inlineStr"><is><t xml:space="preserve">${esc(spec.str)}</t></is></c>`;
      const f = spec.f !== undefined ? `<f>${esc(spec.f)}</f>` : '';
      const v = spec.v !== undefined && spec.v !== null ? `<v>${spec.v}</v>` : '';
      return f || v ? `<c r="${ref}" s="${spec.s}">${f}${v}</c>` : `<c r="${ref}" s="${spec.s}"/>`;
    });
    return `<row r="${row}">${cs.join('')}</row>`;
  });
  const merges = mutate.merges ?? ['B2:C2', 'B3:C3', 'D2:F2', 'H2:J2', `B${t}:C${t}`];
  return `<?xml version="1.0"?><worksheet ${NS}><sheetData>${rowsXml.join('')}</sheetData><mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells></worksheet>`;
}

function workbook(rows = SYN, mutate = {}) {
  const sheets = mutate.sheets ?? [{ name: 'Hoja1' }];
  const parts = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0"?><workbook ${NS}><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>` },
    { name: 'xl/styles.xml', data: STYLES },
  ];
  sheets.forEach((_, i) => parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(rows, mutate) }));
  return zip(parts);
}

const EXPECT = { items: 4, units: 8 };
const parse = (buf, expect = EXPECT) => parseLocal1Workbook(buf, expect);
const errCode = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ImportError, `expected ImportError, got ${err?.name}: ${err?.message}`);
    return err.code;
  }
  return 'NO_ERROR';
};
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// --- W: workbook validation ---------------------------------------------------------

test('W01 a valid synthetic sheet maps every column exactly', () => {
  const parsed = parse(workbook());
  assert.deepEqual(parsed.rows[0], {
    row: 4, sku: 'SYN-001', barcode: 'SYN-001', raw: 'SYN-001 Taza  ceramica', name: 'Taza ceramica', slug: 'syn-001',
    listCents: '1000000', cashCents: '800000', costCents: '400000', stock: '3',
  });
  assert.deepEqual(parsed.rows[2].sku, 'ÑAN-003');
  assert.deepEqual(parsed.rows[2].slug, 'nan-003');
  assert.deepEqual(parsed.rows[3].costCents, '33333');
  assert.deepEqual(parsed.totals, { items: 4, units: '8', listValueCents: '4500000', cashValueCents: '3600000', costValueCents: '2466666' });
});

test('W02 header text or header fill out of place is refused', () => {
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { E3: { str: 'precio' } } }))), 'HEADER');
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { E2: { s: 2 } } }))), 'HEADER');
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { I3: { s: 1 } } }))), 'HEADER');
});

test('W03 second, hidden or renamed sheets are refused', () => {
  assert.equal(errCode(() => parse(workbook(SYN, { sheets: [{ name: 'Hoja1' }, { name: 'Otra' }] }))), 'SHEET');
  assert.equal(errCode(() => parse(workbook(SYN, { sheets: [{ name: 'Hoja1', state: 'hidden' }] }))), 'SHEET');
  assert.equal(errCode(() => parse(workbook(SYN, { sheets: [{ name: 'Stock' }] }))), 'SHEET');
});

test('W04 a formula without a cached value is refused', () => {
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { E5: { v: null } } }))), 'FORMULA_NO_CACHE');
});

test('W05 any formula other than the expected shapes is refused', () => {
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { E5: { f: 'F5/D4' } } }))), 'FORMULA_UNEXPECTED');
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { D5: { f: '1+0' } } }))), 'FORMULA_UNEXPECTED');
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { E8: { f: 'SUM(E4:E6)' } } }))), 'FORMULA_UNEXPECTED');
});

test('W06 stock mismatch and invalid stock are refused', () => {
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { H5: { v: '2' } } }))), 'STOCK');
  for (const bad of ['0', '-1', '1.5', '']) {
    assert.equal(errCode(() => parse(workbook(SYN, { cells: { D7: { v: bad }, H7: { v: bad } } }))), 'STOCK', `stock ${bad}`);
  }
});

test('W07 a list price without an exact 80% cash price, or not positive, is refused', () => {
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), ['SYN-004 Libreta', 2, '0.03', '0']]))), 'LIST_PRICE');
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), ['SYN-004 Libreta', 2, '0', '0']]))), 'LIST_PRICE');
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), ['SYN-004 Libreta', 2, '12.345', '0']]))), 'LIST_PRICE');
});

test('W08 a cost with more than 2 decimals or negative is refused', () => {
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), ['SYN-004 Libreta', 2, '1250', '333.333', '666.666']]))), 'COST');
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), ['SYN-004 Libreta', 2, '1250', '-1']]))), 'COST');
});

test('W09 cost 0 and cost above list are kept and reported as anomalies', () => {
  const parsed = parse(workbook());
  assert.deepEqual(parsed.anomalies, [
    { row: 5, sku: 'SYN-002', kind: 'COST_ZERO', listCents: '250000', costCents: '0' },
    { row: 6, sku: 'ÑAN-003', kind: 'COST_ABOVE_LIST', listCents: '500000', costCents: '600000' },
  ]);
  assert.equal(parsed.rows[1].costCents, '0');
  assert.equal(parsed.rows[2].costCents, '600000');
});

test('W10 duplicate SKU, slug collision and missing description are refused', () => {
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), ['syn-001 Otra', 2, '1250', '333.33', '666.66']]))), 'SKU');
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), ['NAN-003 Otra', 2, '1250', '333.33', '666.66']]))), 'SLUG');
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), ['SYN-004', 2, '1250', '333.33', '666.66']]))), 'ROW_TEXT');
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), ['  ', 2, '1250', '333.33', '666.66']]))), 'ROW_TEXT');
});

test('W11 stray values outside the layout are refused', () => {
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { G5: { v: '1' } } }))), 'STRAY_CELL');
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { C4: { str: 'x' } } }))), 'STRAY_CELL');
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { B20: { str: 'nota' } } }))), 'STRAY_CELL');
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { K4: { v: '9' } } }))), 'STRAY_CELL');
});

test('W12 a missing or wrong totals row is refused', () => {
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { F8: { v: '1' } } }))), 'TOTALS');
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { B8: { str: 'subtotal' } } }))), 'TOTALS');
});

test('W13 valued columns must match units x price', () => {
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { F4: { v: '30001' }, F8: { v: '55001' } } }))), 'VALUED');
  assert.equal(errCode(() => parse(workbook(SYN, { cells: { J7: { v: '666.68' }, J8: { v: '24666.68' } } }))), 'VALUED');
});

test('W14 unexpected merges are refused', () => {
  assert.equal(errCode(() => parse(workbook(SYN, { merges: ['B2:C2', 'B3:C3', 'D2:F2', 'H2:J2', 'B8:C8', 'B4:C4'] }))), 'LAYOUT');
  assert.equal(errCode(() => parse(workbook(SYN, { merges: ['B2:C2', 'B3:C3', 'D2:F2', 'H2:J2'] }))), 'LAYOUT');
});

test('W15 SKU over 64 or name over 120 characters is refused', () => {
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), [`${'X'.repeat(65)} desc`, 2, '1250', '333.33', '666.66']]))), 'LENGTH');
  assert.equal(errCode(() => parse(workbook([...SYN.slice(0, 3), [`SYN-004 ${'d'.repeat(121)}`, 2, '1250', '333.33', '666.66']]))), 'LENGTH');
});

test('W16 the expected item and unit counts must match', () => {
  assert.equal(errCode(() => parse(workbook(), { items: 5, units: '8' })), 'COUNTS');
  assert.equal(errCode(() => parse(workbook(), { items: 4, units: '9' })), 'COUNTS');
});

// --- P: plan and digests ------------------------------------------------------------

test('P01 the catalog digest changes with one cent, the row order and the file hash', () => {
  const buf = workbook();
  const base = buildCatalogPlan({ fileSha256: sha(buf), parsed: parse(buf) });
  assert.match(base.catalogDigest, /^[0-9a-f]{64}$/);
  assert.equal(buildCatalogPlan({ fileSha256: sha(buf), parsed: parse(buf) }).catalogDigest, base.catalogDigest);
  const cent = workbook([...SYN.slice(0, 3), ['SYN-004 Libreta', 2, '1250', '333.34', '666.68']]);
  assert.notEqual(buildCatalogPlan({ fileSha256: sha(buf), parsed: parse(cent) }).catalogDigest, base.catalogDigest);
  const swapped = workbook([SYN[1], SYN[0], SYN[2], SYN[3]]);
  assert.notEqual(buildCatalogPlan({ fileSha256: sha(buf), parsed: parse(swapped) }).catalogDigest, base.catalogDigest);
  assert.notEqual(buildCatalogPlan({ fileSha256: 'f'.repeat(64), parsed: parse(buf) }).catalogDigest, base.catalogDigest);
  assert.ok(base.canonical.includes('"General"') && base.canonical.includes('"Sin marca"'));
});

test('P02 the execution digest binds location, marker, project and tool', () => {
  const t = { catalogDigest: 'a'.repeat(64), locationCode: 'LOCUNO', markerId: '11111111-1111-4111-8111-111111111111', projectRef: 'abcdefghijklmnopqrst', toolSha256: 'b'.repeat(64) };
  const d = executionDigest(t);
  assert.match(d, /^[0-9a-f]{64}$/);
  for (const [k, v] of Object.entries({ catalogDigest: 'c'.repeat(64), locationCode: 'LOCDOS', markerId: '22222222-2222-4222-8222-222222222222', projectRef: 'zbcdefghijklmnopqrst', toolSha256: 'd'.repeat(64) })) {
    assert.notEqual(executionDigest({ ...t, [k]: v }), d, k);
  }
});

// --- D: canonical DTO compatibility (offline, real api/src schemas) -----------------

test('D01 every planned row passes the canonical Product, Variant and initial-stock DTOs', async () => {
  const canonical = await loadCanonical();
  const { rows } = parse(workbook());
  const uuid = '33333333-3333-4333-8333-333333333333';
  for (const r of rows) {
    canonical.createProductSchema.parse({ name: r.name, slug: r.slug, categoryId: uuid, brandId: uuid });
    canonical.createVariantSchema.parse({ productId: uuid, sku: r.sku, barcode: r.barcode, cashPrice: r.cashCents, price: r.listCents, costPrice: r.costCents });
    canonical.initialStockSchema.parse({ variantId: uuid, branchId: uuid, quantity: r.stock });
  }
});

// --- C: CLI -------------------------------------------------------------------------

const BASE_ARGS = ['--file=/x/inventario.xlsx', `--expect-file-sha256=${'a'.repeat(64)}`, '--expect-items=4', '--expect-units=8'];
const TARGET_ARGS = ['--location=LOCUNO', '--marker-id=11111111-1111-4111-8111-111111111111'];

test('C01 the CLI refuses unknown, duplicate, missing and partial arguments', () => {
  assert.equal(parseCliArgs(['--dry-run', ...BASE_ARGS]).ok, true);
  assert.equal(parseCliArgs(['--dry-run', ...BASE_ARGS, ...TARGET_ARGS, '--project-ref=abcdefghijklmnopqrst']).ok, true);
  for (const argv of [
    ['--dry-run', ...BASE_ARGS, '--bogus=1'],
    ['--dry-run', ...BASE_ARGS, '--file=/y.xlsx'],
    ['--dry-run', ...BASE_ARGS.slice(1)],
    ['--dry-run', ...BASE_ARGS, '--location=LOCUNO'],
    ['--dry-run', '--execute', ...BASE_ARGS],
    ['--execute', ...BASE_ARGS, ...TARGET_ARGS],
    ['--dry-run', '--file=relative.xlsx', ...BASE_ARGS.slice(1)],
    ['--dry-run', ...BASE_ARGS.slice(0, 1), '--expect-file-sha256=XYZ', ...BASE_ARGS.slice(2)],
    ['dry-run', ...BASE_ARGS],
    ['--dry-run', '--dry-run', ...BASE_ARGS],
  ]) assert.equal(parseCliArgs(argv).ok, false, argv.join(' '));
});

test('C02 the default tool digest covers the importer AND the XLSX reader', async () => {
  const { toolDigest } = await import('./pilot-local1-catalog-import.mjs');
  const importer = readFileSync(new URL('./pilot-local1-catalog-import.mjs', import.meta.url));
  const reader = readFileSync(new URL('./xlsx-sheet-reader.mjs', import.meta.url));
  assert.equal(toolDigest(), createHash('sha256').update(`${sha(importer)}\n${sha(reader)}`).digest('hex'));
});

// --- M: dry-run ---------------------------------------------------------------------

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'mona-import-test-'));
}
const forbidden = (label) => () => {
  throw new Error(`${label} must not be used`);
};

function harness(overrides = {}) {
  const out = [];
  const err = [];
  const buf = overrides.buf ?? workbook();
  const deps = {
    readInputFile: () => buf,
    reportRoot: tmp(),
    stateRoot: tmp(),
    forbiddenRoots: [],
    now: () => new Date('2026-10-13T12:00:00Z'),
    toolSha256: 'e'.repeat(64),
    log: (l) => out.push(l),
    error: (l) => err.push(l),
    readPrivateFile: forbidden('readPrivateFile'),
    createClient: forbidden('createClient'),
    createPrisma: forbidden('createPrisma'),
    pilotMarkerMain: forbidden('pilotMarkerMain'),
    pgRestoreList: forbidden('pgRestoreList'),
    env: {},
    ...overrides.deps,
  };
  return { out, err, buf, deps };
}
const args = (mode, buf, extra = []) => [`--${mode}`, '--file=/x/inventario.xlsx', `--expect-file-sha256=${sha(buf)}`, '--expect-items=4', '--expect-units=8', ...extra];

// Assumed RED seam: main(argv, { fsOps }) propagates this Node-compatible object
// to writeExclusive(file, text, phase, fsOps) at every one of its four call sites.
function instrumentedFsOps(matches, hooks = {}) {
  const files = new Map();
  const trackOpen = (file, flags, mode) => {
    const fd = realOpenSync(file, flags, mode);
    files.set(fd, file);
    return fd;
  };
  return {
    openSync(file, flags, mode) {
      if (matches(file) && hooks.open) return hooks.open({ file, flags, mode, open: () => trackOpen(file, flags, mode) });
      return trackOpen(file, flags, mode);
    },
    writeSync(fd, buffer, offset, length, position) {
      const file = files.get(fd);
      const write = (count = length) => realWriteSync(fd, buffer, offset, count, position);
      if (matches(file) && hooks.write) return hooks.write({ file, fd, buffer, offset, length, position, write });
      return write();
    },
    fsyncSync(fd) {
      const file = files.get(fd);
      if (matches(file) && hooks.fsync) return hooks.fsync({ file, fd, fsync: () => realFsyncSync(fd) });
      return realFsyncSync(fd);
    },
    closeSync(fd) {
      const file = files.get(fd);
      const close = () => {
        files.delete(fd);
        return realCloseSync(fd);
      };
      if (matches(file) && hooks.close) return hooks.close({ file, fd, close });
      return close();
    },
    unlinkSync(file) {
      return realUnlinkSync(file);
    },
  };
}

const ioError = (code, message = `${code} while writing private output`) => Object.assign(new Error(message), { code });
const reportFile = (h) => {
  const [dir] = readdirSync(h.deps.reportRoot);
  return path.join(h.deps.reportRoot, dir, 'report.json');
};

test('M01 a dry-run with the wrong file hash fails before parsing', async () => {
  const h = harness();
  const code = await main(['--dry-run', '--file=/x/inventario.xlsx', `--expect-file-sha256=${'0'.repeat(64)}`, '--expect-items=4', '--expect-units=8'], h.deps);
  assert.equal(code, 1);
  assert.match(h.err.join('\n'), /phase=file/);
  assert.equal(readdirSync(h.deps.reportRoot).length, 0);
});

test('M02 a dry-run opens nothing, prints no cost and writes a private 0600 report', async () => {
  const h = harness();
  const code = await main(args('dry-run', h.buf, [...TARGET_ARGS, '--project-ref=abcdefghijklmnopqrst']), h.deps);
  assert.equal(code, 0, h.err.join('\n'));
  const raw = h.out.join('\n');
  // digests and temporary paths are random-looking text; strip them before looking for cost figures
  const stdout = raw.split(h.deps.reportRoot).join('<report>').replace(/[0-9a-f]{12,64}/g, '<hex>');
  assert.match(raw, /catalog sha256: [0-9a-f]{64}/);
  assert.match(raw, /execution plan sha256: [0-9a-f]{64}/);
  assert.match(stdout, /items: 4; units: 8/);
  assert.match(stdout, /anomalies: 2 \(COST_ZERO SYN-002 row 5; COST_ABOVE_LIST ÑAN-003 row 6\)/);
  // whole numbers only: "6000" inside the legitimate cash total 3600000 is not a cost leak
  for (const secret of ['4000', '6000', '333.33', '400000', '600000', '33333', '2466666']) {
    assert.ok(!new RegExp(`(^|[^0-9.])${secret.replace('.', '\\.')}([^0-9.]|$)`).test(stdout), `stdout leaks ${secret}`);
  }
  const [dir] = readdirSync(h.deps.reportRoot);
  const file = path.join(h.deps.reportRoot, dir, 'report.json');
  assert.equal(statSync(path.join(h.deps.reportRoot, dir)).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const report = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(report.rows[0].raw, 'SYN-001 Taza  ceramica');
  assert.equal(report.anomalies.length, 2);
  assert.equal(report.totals.costValueCents, '2466666');
});

test('M03 an unwritable report location fails closed with a phase, never an uncaught exception', async () => {
  const h = harness();
  const blocker = path.join(tmp(), 'not-a-dir');
  writeFileSync(blocker, 'x');
  h.deps.reportRoot = path.join(blocker, 'reports');
  const code = await main(args('dry-run', h.buf), h.deps);
  assert.equal(code, 1);
  assert.match(h.err.join('\n'), /phase=report/);
});

test('M04 two dry-runs at the same instant each write their own report', async () => {
  const h = harness();
  assert.equal(await main(args('dry-run', h.buf), h.deps), 0, h.err.join('\n'));
  assert.equal(await main(args('dry-run', h.buf), h.deps), 0, h.err.join('\n'));
  assert.equal(readdirSync(h.deps.reportRoot).length, 2);
});

// --- B: backup evidence -------------------------------------------------------------

// Marker data in the exact shape pg_restore --data-only emits for the REAL marker table
// (scripts/database/pilot-marker.mjs CANONICAL_MARKER: singleton, environment, marker_id, installed_at).
// Synthetic values; never a real archive.
const MARKER_ID = '11111111-1111-4111-8111-111111111111';
const MARKER_PREAMBLE = "--\n-- PostgreSQL database dump\n--\n\nSET statement_timeout = 0;\nSET client_encoding = 'UTF8';\n"
  + "SELECT pg_catalog.set_config('search_path', '', false);\n\n--\n-- Data for Name: database_identity; Type: TABLE DATA; "
  + 'Schema: mona_pilot_guard; Owner: postgres\n--\n\n';
const MARKER_ROW = `t\tpilot\t${MARKER_ID}\t2026-10-13 04:00:00.123456+00`;
const markerCopy = ({ columns = 'singleton, environment, marker_id, installed_at', rows = [MARKER_ROW] } = {}) =>
  `${MARKER_PREAMBLE}COPY mona_pilot_guard.database_identity (${columns}) FROM stdin;\n${rows.map((r) => `${r}\n`).join('')}\\.\n\n`;
const MARKER_DATA = markerCopy();

const PGLIST = (created = '2026-10-13 10:30:00 UTC', dbname = 'postgres', omit = []) => [
  ';',
  '; Archive created at ' + created,
  ';     dbname: ' + dbname,
  ';     TOC Entries: 40',
  ';     Format: CUSTOM',
  ';',
  '200; 2615 1 SCHEMA - mona_pilot_guard postgres',
  ...['Category', 'Brand', 'Product', 'ProductVariant', 'Inventory', 'StockMovement', 'Location', 'Branch', 'Company', 'AuditLog', '_prisma_migrations']
    .filter((t) => !omit.includes(t))
    .map((t, i) => `${300 + i}; 0 1 TABLE DATA public ${t} postgres`),
  ...(omit.includes('database_identity') ? [] : ['400; 0 1 TABLE DATA mona_pilot_guard database_identity postgres']),
].join('\n');

function backupFile(content = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 7)]), mode = 0o600) {
  const dir = tmp();
  const file = path.join(dir, 'pilot.dump');
  writeFileSync(file, content);
  chmodSync(file, mode);
  return { file, sha256: sha(content) };
}
const verify = (o) => verifyBackupArchive({
  path: o.file, expectedSha256: o.sha256, expectedDbname: 'postgres', now: new Date('2026-10-13T12:00:00Z'), forbiddenRoots: [],
  expectedMarkerId: '11111111-1111-4111-8111-111111111111',
  pgRestoreList: (archive) => o.pgRestoreList?.(archive) ?? o.list ?? PGLIST(),
  pgRestoreMarkerData: (archive) => o.pgRestoreMarkerData?.(archive) ?? MARKER_DATA,
  ...(o.maxArchiveBytes ? { maxArchiveBytes: o.maxArchiveBytes } : {}),
  ...(o.fsOps ? { fsOps: o.fsOps } : {}),
  ...(o.forbiddenRoots ? { forbiddenRoots: o.forbiddenRoots } : {}),
});

test('B02 replacement after the digest cannot change the archive inspected by pg_restore', () => {
  const b = backupFile();
  const original = readFileSync(b.file);
  let inspected;
  const result = verify({ ...b, pgRestoreList: (archive) => {
    writeFileSync(b.file, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 9)]));
    inspected = Buffer.from(archive);
    return PGLIST();
  } });
  assert.deepEqual(inspected, original, 'pg_restore must inspect the bytes identified by the expected digest');
  // C3 fix (A22): the backup at the path no longer matches the verified bytes, so it is not a valid recovery point.
  assert.equal(result.ok, false);
  assert.match(result.reason, /changed during verification/);
});

test('B03 a wrong marker value in the archive is refused', () => {
  const b = backupFile();
  const result = verify({ ...b, pgRestoreMarkerData: () => markerCopy({ rows: ['t\tpilot\t99999999-9999-4999-8999-999999999999\t2026-10-13 04:00:00+00'] }) });
  assert.equal(result.ok, false);
});

test('B04 marker extraction refuses wrong environment, duplicates, empty and malformed rows', () => {
  for (const rows of [
    [`t\ttest\t${MARKER_ID}\t2026-10-13 04:00:00+00`],
    [MARKER_ROW, MARKER_ROW],
    [],
    [`t pilot ${MARKER_ID} 2026-10-13 04:00:00+00`],
    ['t\tpilot\tnot-a-uuid\t2026-10-13 04:00:00+00'],
  ]) {
    const result = verify({ ...backupFile(), pgRestoreMarkerData: () => markerCopy({ rows }) });
    assert.equal(result.ok, false, JSON.stringify(rows));
  }
});

test('B05 marker extraction failure is fixed and does not disclose child output', () => {
  const result = verify({ ...backupFile(), pgRestoreMarkerData: () => { throw new Error('secret cost 2466666'); } });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.reason, /secret|2466666/);
});

test('B06 backup mutation during listing is refused, and marker extraction still receives the verified bytes', () => {
  const b = backupFile();
  const original = readFileSync(b.file);
  let markerSaw;
  const result = verify({ ...b,
    pgRestoreList: () => { writeFileSync(b.file, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 9)])); return PGLIST(); },
    pgRestoreMarkerData: (archive) => { markerSaw = Buffer.from(archive); return MARKER_DATA; },
  });
  assert.deepEqual(markerSaw, original);
  assert.equal(result.ok, false);
  assert.match(result.reason, /changed during verification/);
});

test('B07 backup mutation during marker extraction is refused', () => {
  const b = backupFile();
  const result = verify({ ...b, pgRestoreMarkerData: () => {
    writeFileSync(b.file, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 9)]));
    return MARKER_DATA;
  } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /changed during verification/);
});

test('B08 wrong digest refuses before archive inspection', () => {
  let listed = false;
  const result = verify({ ...backupFile(), sha256: '0'.repeat(64), pgRestoreList: () => { listed = true; return PGLIST(); } });
  assert.equal(result.ok, false);
  assert.equal(listed, false);
});

test('B09 replacing the backup path (new inode) before marker extraction is refused; extraction saw the verified bytes', () => {
  const b = backupFile();
  let markerSaw;
  const result = verify({ ...b,
    pgRestoreList: () => {
      renameSync(b.file, `${b.file}.aside`);
      writeFileSync(b.file, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 7)]));
      chmodSync(b.file, 0o600);
      return PGLIST();
    },
    pgRestoreMarkerData: (archive) => { markerSaw = Buffer.from(archive); return MARKER_DATA; },
  });
  assert.deepEqual(markerSaw, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 7)]));
  assert.equal(result.ok, false, 'same bytes under another inode are not the verified backup');
  assert.match(result.reason, /changed during verification/);
});

test('B10 both archive inspections receive the verified bytes in memory, never a path', () => {
  const b = backupFile();
  const original = readFileSync(b.file);
  const seen = [];
  const result = verify({ ...b,
    pgRestoreList: (archive) => { seen.push(archive); return PGLIST(); },
    pgRestoreMarkerData: (archive) => { seen.push(archive); return MARKER_DATA; },
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(seen.length, 2);
  for (const archive of seen) {
    assert.ok(Buffer.isBuffer(archive), 'pg_restore receives bytes, not a path');
    assert.deepEqual(archive, original);
  }
});

test('B11 a backup removed during verification fails closed without an uncaught path error', () => {
  const b = backupFile();
  const result = verify({ ...b, pgRestoreList: () => { realUnlinkSync(b.file); return PGLIST(); } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /changed during verification/);
});

test('B01 backup evidence is verified, not trusted', () => {
  const good = backupFile();
  const ok = verify(good);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.createdAt, '2026-10-13T10:30:00.000Z');
  assert.equal(verify({ ...good, sha256: '0'.repeat(64) }).ok, false);
  assert.equal(verify(backupFile(Buffer.from('NOTADUMPxxxxxxxx'))).ok, false);
  assert.equal(verify(backupFile(undefined, 0o644)).ok, false);
  assert.equal(verify({ ...good, list: PGLIST('2026-10-13 05:00:00 UTC') }).ok, false);
  assert.equal(verify({ ...good, list: PGLIST('2026-10-13 12:30:00 UTC') }).ok, false);
  assert.equal(verify({ ...good, list: PGLIST('ayer a la tarde') }).ok, false);
  assert.equal(verify({ ...good, list: PGLIST(undefined, 'otra') }).ok, false);
  assert.equal(verify({ ...good, list: PGLIST(undefined, undefined, ['database_identity']) }).ok, false);
  assert.equal(verify({ ...good, list: PGLIST(undefined, undefined, ['StockMovement']) }).ok, false);
  assert.equal(verify({ ...good, list: PGLIST('2026-10-13 07:30:00 -03') }).ok, true);
});

// --- A/E: authorization and execute (fake connected path) ---------------------------

const MARKER = '11111111-1111-4111-8111-111111111111';
const REF = 'abcdefghijklmnopqrst';
const URL_TEXT = `postgresql://postgres.${REF}:secret@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`;

async function planFor(h) {
  const parsed = parse(h.buf);
  const catalog = buildCatalogPlan({ fileSha256: sha(h.buf), parsed });
  return executionDigest({ catalogDigest: catalog.catalogDigest, locationCode: 'LOCUNO', markerId: MARKER, projectRef: REF, toolSha256: h.deps.toolSha256 });
}

function connectedHarness(extra = {}) {
  const backup = backupFile();
  const calls = [];
  const h = harness({
    deps: {
      readPrivateFile: () => ({ ok: true, text: `${URL_TEXT}\n` }),
      pgRestoreList: () => PGLIST(),
      pgRestoreMarkerData: () => MARKER_DATA,
      isTTY: true,
      prompt: async () => extra.phrase,
      pilotMarkerMain: async () => {
        calls.push('marker');
        return extra.markerCode ?? 0;
      },
      createPrisma: async () => {
        calls.push('prisma');
        return { $transaction: async (fn, opts) => { calls.push(`tx:${opts.timeout}`); return extra.txResult ?? { action: 'CREATED', counts: { products: 4, variants: 4, stockRows: 4 }, totals: { units: '8' } }; }, $disconnect: async () => {} };
      },
      loadCanonical: async () => ({}),
      ...extra.deps,
    },
  });
  return { h, backup, calls };
}

async function authorize(c, phraseOverride) {
  const plan = await planFor(c.h);
  const phrase = phraseOverride ?? `AUTORIZO LOCUNO ${plan.slice(0, 12)}`;
  c.h.deps.prompt = async () => phrase;
  const code = await main(args('authorize', c.h.buf, [...TARGET_ARGS, `--project-ref=${REF}`, `--plan=${plan}`, `--backup=${c.backup.file}`, `--backup-sha256=${c.backup.sha256}`]), c.h.deps);
  const line = c.h.out.find((l) => l.includes('authorization id:'));
  return { code, plan, authId: line?.match(/authorization id: ([0-9a-f]{32})/)?.[1] };
}
const execArgs = (c, plan, authId, extra = []) => args('execute', c.h.buf, [...TARGET_ARGS, `--confirm-project-ref=${REF}`, `--plan=${plan}`, `--backup=${c.backup.file}`, `--backup-sha256=${c.backup.sha256}`, `--authorization=${authId}`, ...extra]);

// --- C3 fix: real marker format (A13), mixed-environment backups (A14), bytes-not-paths (A22) ---
// PRE-REGISTERED (~/.local/share/mona-jacinta/c3-fix-*/expectations.md) before the implementation.

test('N01 the real pg_restore marker output (preamble + 4 canonical columns) with the expected marker is accepted', () => {
  const result = verify({ ...backupFile(), pgRestoreMarkerData: () => MARKER_DATA });
  assert.equal(result.ok, true, result.reason);
});

test('N02–N09 marker rows or column lists that are not exactly the canonical PILOT marker are refused', () => {
  const cases = {
    N02: markerCopy({ rows: [`t\tpilot\t99999999-9999-4999-8999-999999999999\t2026-10-13 04:00:00+00`] }),
    N03: markerCopy({ rows: [`t\ttest\t${MARKER_ID}\t2026-10-13 04:00:00+00`] }),
    N04: markerCopy({ rows: [`f\tpilot\t${MARKER_ID}\t2026-10-13 04:00:00+00`] }),
    N05: markerCopy({ rows: [`t\tpilot\t${MARKER_ID}\t\\N`] }),
    N06: markerCopy({ columns: 'singleton, environment, marker_id, installed_at, extra', rows: [`${MARKER_ROW}\tx`] }),
    N07: markerCopy({ columns: 'environment, singleton, marker_id, installed_at', rows: [`pilot\tt\t${MARKER_ID}\t2026-10-13 04:00:00+00`] }),
    N08: `COPY mona_pilot_guard.database_identity (environment, marker_id) FROM stdin;\npilot\t${MARKER_ID}\n\\.\n`,
    N09: markerCopy({ rows: [MARKER_ROW, MARKER_ROW] }),
  };
  for (const [id, data] of Object.entries(cases)) {
    const result = verify({ ...backupFile(), pgRestoreMarkerData: () => data });
    assert.equal(result.ok, false, id);
    assert.match(result.reason, /PILOT marker/, id);
  }
});

test('N10–N12 a backup whose TOC names any guard schema other than mona_pilot_guard is refused', () => {
  for (const [id, line] of [
    ['N10', '500; 2615 1 SCHEMA - mona_test_guard postgres'],
    ['N11', '501; 0 1 TABLE DATA mona_local_test_guard database_identity postgres'],
    ['N12', '502; 2615 1 SCHEMA - mona_demo_guard postgres'],
  ]) {
    const result = verify({ ...backupFile(), list: `${PGLIST()}\n${line}` });
    assert.equal(result.ok, false, id);
    assert.match(result.reason, /environment/, id);
  }
});

test('N13 a backup that also carries a TEST marker is refused by --authorize and by --execute before any prompt or client', async () => {
  const mixed = () => `${PGLIST()}\n500; 2615 1 SCHEMA - mona_test_guard postgres`;
  // Control: the same backup without the TEST guard passes the backup phase, so the refusal below is A14's.
  const control = connectedHarness();
  const controlPlan = await planFor(control.h);
  control.h.deps.prompt = async () => `AUTORIZO LOCUNO ${controlPlan.slice(0, 12)}`;
  const controlCode = await main(args('authorize', control.h.buf, [...TARGET_ARGS, `--project-ref=${REF}`, `--plan=${controlPlan}`, `--backup=${control.backup.file}`, `--backup-sha256=${control.backup.sha256}`]), control.h.deps);
  assert.equal(controlCode, 0, control.h.err.join('\n'));
  const a = connectedHarness({ deps: { pgRestoreList: mixed, prompt: forbidden('prompt') } });
  const plan = await planFor(a.h);
  const code = await main(args('authorize', a.h.buf, [...TARGET_ARGS, `--project-ref=${REF}`, `--plan=${plan}`, `--backup=${a.backup.file}`, `--backup-sha256=${a.backup.sha256}`]), a.h.deps);
  assert.equal(code, 1);
  assert.match(a.h.err.join('\n'), /phase=backup/);
  const e = connectedHarness({ deps: { pgRestoreList: mixed } });
  const execCode = await main(execArgs(e, plan, 'a'.repeat(32)), e.h.deps);
  assert.equal(execCode, 1);
  assert.match(e.h.err.join('\n'), /phase=backup/);
  assert.deepEqual(e.calls, []);
});

test('N14 each pg_restore inspection receives a Buffer byte-identical to the hashed archive', () => {
  const b = backupFile();
  const hashes = [];
  const result = verify({ ...b,
    pgRestoreList: (archive) => { hashes.push(Buffer.isBuffer(archive) ? sha(archive) : `not-bytes:${typeof archive}`); return PGLIST(); },
    pgRestoreMarkerData: (archive) => { hashes.push(Buffer.isBuffer(archive) ? sha(archive) : `not-bytes:${typeof archive}`); return MARKER_DATA; },
  });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(hashes, [b.sha256, b.sha256]);
});

test('N15 the default pg_restore invocations read the bytes from stdin: no filename, custom format, minimal env', () => {
  for (const kind of ['list', 'markerData']) {
    const { file, args: argv, options } = importerModule.pgRestoreInvocation(kind, Buffer.from('PGDMP'));
    assert.equal(file, '/usr/lib/postgresql/17/bin/pg_restore', kind);
    assert.ok(argv.includes('--format=custom'), kind);
    assert.ok(argv.every((a) => a.startsWith('--')), `${kind}: no positional filename`);
    assert.ok(!argv.some((a) => a.startsWith('--dbname') || a.startsWith('-d')), `${kind}: never a database connection`);
    assert.deepEqual(options.env, { PATH: '/usr/bin:/bin' }, kind);
    assert.equal(options.stdio[0], 'pipe', kind);
    assert.deepEqual(options.input, Buffer.from('PGDMP'), kind);
  }
});

test('N16–N18 a rewritten, removed or swapped backup during inspection is refused', () => {
  const replacements = {
    N16: (file) => writeFileSync(file, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 9)])),
    N17: (file) => realUnlinkSync(file),
    N18: (file) => { const bytes = readFileSync(file); renameSync(file, `${file}.orig`); writeFileSync(file, bytes); chmodSync(file, 0o600); },
  };
  for (const [id, act] of Object.entries(replacements)) {
    const b = backupFile();
    const result = verify({ ...b, pgRestoreList: () => { act(b.file); return PGLIST(); } });
    assert.equal(result.ok, false, id);
    assert.match(result.reason, /changed during verification/, id);
  }
});

// N18b (added AFTER the pre-registration): the X06 swap that restores the very same inode. pg_restore never reads
// the path any more, so what it inspected are the verified bytes, and the path still holds that inode and digest.
test('N18b swapping the path and restoring the same inode cannot change what pg_restore inspected', () => {
  const b = backupFile();
  const original = readFileSync(b.file);
  let markerSaw;
  const result = verify({ ...b,
    pgRestoreList: () => {
      renameSync(b.file, `${b.file}.orig`);
      writeFileSync(b.file, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 9)]));
      return PGLIST();
    },
    pgRestoreMarkerData: (archive) => { markerSaw = Buffer.from(archive); renameSync(`${b.file}.orig`, b.file); return MARKER_DATA; },
  });
  assert.deepEqual(markerSaw, original);
  assert.equal(result.ok, true, result.reason);
});

test('N19 verification creates nothing under the temporary directory', () => {
  const before = new Set(readdirSync(os.tmpdir()).filter((n) => n.startsWith('mona-pilot-archive-')));
  let during;
  const result = verify({ ...backupFile(), pgRestoreList: () => {
    during = readdirSync(os.tmpdir()).filter((n) => n.startsWith('mona-pilot-archive-') && !before.has(n));
    return PGLIST();
  } });
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(during, []);
});

test('N20 an archive above the size cap is refused before any inspection', () => {
  let inspected = false;
  const result = verify({ ...backupFile(), maxArchiveBytes: 16, pgRestoreList: () => { inspected = true; return PGLIST(); } });
  assert.equal(result.ok, false);
  assert.equal(inspected, false);
  assert.match(result.reason, /size/);
});

test('N21 every synthetic row keeps SKU, barcode, raw text, name, stock, list, cash and cost exactly', () => {
  const parsed = parse(workbook());
  const pick = (r) => [r.row, r.sku, r.barcode, r.raw, r.name, r.stock, r.listCents, r.cashCents, r.costCents];
  assert.deepEqual(parsed.rows.map(pick), [
    [4, 'SYN-001', 'SYN-001', 'SYN-001 Taza  ceramica', 'Taza ceramica', '3', '1000000', '800000', '400000'],
    [5, 'SYN-002', 'SYN-002', 'SYN-002 Vela', 'Vela', '1', '250000', '200000', '0'],
    [6, 'ÑAN-003', 'ÑAN-003', 'ÑAN-003 Muñeco de tela', 'Muñeco de tela', '2', '500000', '400000', '600000'],
    [7, 'SYN-004', 'SYN-004', 'SYN-004 Libreta', 'Libreta', '2', '125000', '100000', '33333'],
  ]);
  const plan = buildCatalogPlan({ fileSha256: sha(workbook()), parsed });
  assert.deepEqual(plan.rows.map(pick), parsed.rows.map(pick));
});

test('W1-01 a 4096-byte partial write resumes and publishes the exact report bytes', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => [`SYN-${String(i + 1).padStart(3, '0')} Producto ${'x'.repeat(80)}`, 1, '10000', '4000']);
  const buf = workbook(rows);
  const argv = ['--dry-run', '--file=/x/inventario.xlsx', `--expect-file-sha256=${sha(buf)}`, '--expect-items=40', '--expect-units=40'];
  const control = harness({ buf });
  assert.equal(await main(argv, control.deps), 0, control.err.join('\n'));
  const expected = readFileSync(reportFile(control));
  assert.ok(expected.length > 4096);

  const writes = [];
  const h = harness({ buf });
  h.deps.fsOps = instrumentedFsOps((file) => String(file).endsWith('report.json'), {
    write: ({ length, write }) => {
      const count = writes.length === 0 ? 4096 : length;
      writes.push(count);
      return write(count);
    },
  });
  assert.equal(await main(argv, h.deps), 0, h.err.join('\n'));
  assert.equal(writes[0], 4096);
  assert.ok(writes.length >= 2);
  assert.deepEqual(readFileSync(reportFile(h)), expected);
});

test('W1-02 repeated short writes preserve UTF-8 bytes when a write splits Ñ', async () => {
  const control = harness();
  assert.equal(await main(args('dry-run', control.buf), control.deps), 0, control.err.join('\n'));
  const expected = readFileSync(reportFile(control));
  const offsets = [];
  let scripted;
  const h = harness();
  h.deps.fsOps = instrumentedFsOps((file) => String(file).endsWith('report.json'), {
    write: ({ buffer, offset, length, write }) => {
      offsets.push(offset);
      if (!scripted) {
        const utf8 = buffer.indexOf(Buffer.from('Ñ', 'utf8'));
        assert.ok(utf8 >= 0);
        scripted = [utf8 + 1, 1, 2, 3, 5, 8];
      }
      return write(Math.min(scripted.shift() ?? length, length));
    },
  });
  assert.equal(await main(args('dry-run', h.buf), h.deps), 0, h.err.join('\n'));
  assert.ok(offsets.length > 2);
  assert.deepEqual(readFileSync(reportFile(h)), expected);
});

test('W1-03 zero write progress stops the report without looping', async () => {
  let writes = 0;
  const h = harness({ deps: { fsOps: instrumentedFsOps((file) => String(file).endsWith('report.json'), { write: () => { writes += 1; return 0; } }) } });
  assert.equal(await main(args('dry-run', h.buf), h.deps), 1);
  assert.equal(writes, 1);
  assert.match(h.err.join('\n'), /phase=report/);
  assert.doesNotMatch(h.out.join('\n'), /DRY RUN/);
});

test('W1-04 negative and non-integer write counts stop at the report phase', async () => {
  for (const count of [-1, 1.5]) {
    const h = harness({ deps: { fsOps: instrumentedFsOps((file) => String(file).endsWith('report.json'), { write: () => count }) } });
    assert.equal(await main(args('dry-run', h.buf), h.deps), 1, `count ${count}`);
    assert.match(h.err.join('\n'), /phase=report/, `count ${count}`);
    assert.doesNotMatch(h.out.join('\n'), /DRY RUN/, `count ${count}`);
  }
});

test('W1-05 ENOSPC after partial progress stops with no path, URL, password or cost leak', async () => {
  let writes = 0;
  const h = harness();
  h.deps.fsOps = instrumentedFsOps((file) => String(file).endsWith('report.json'), {
    write: ({ file, write }) => {
      writes += 1;
      if (writes === 1) return write(17);
      throw ioError('ENOSPC', `disk full at ${file}: ${URL_TEXT} cost 2466666`);
    },
  });
  assert.equal(await main(args('dry-run', h.buf), h.deps), 1);
  const text = [...h.out, ...h.err].join('\n');
  assert.match(h.err.join('\n'), /phase=report/);
  assert.doesNotMatch(text, /postgresql:|secret|2466666|report\.json/);
});

test('W1-06 EINTR and EAGAIN fail closed immediately without an implicit retry', async () => {
  for (const code of ['EINTR', 'EAGAIN']) {
    let writes = 0;
    const h = harness({ deps: { fsOps: instrumentedFsOps((file) => String(file).endsWith('report.json'), {
      write: () => { writes += 1; throw ioError(code); },
    }) } });
    assert.equal(await main(args('dry-run', h.buf), h.deps), 1, code);
    assert.equal(writes, 1, code);
    assert.match(h.err.join('\n'), /phase=report/, code);
  }
});

test('W1-07 authorization fsync EIO fails and cannot leave a usable authorization', async () => {
  const c = connectedHarness();
  let authFile;
  c.h.deps.fsOps = instrumentedFsOps((file) => String(file).endsWith('.json') && !String(file).endsWith('.consumed.json'), {
    open: ({ file, open }) => { authFile = file; return open(); },
    fsync: ({ fsync }) => { fsync(); throw ioError('EIO'); },
  });
  const authorization = await authorize(c);
  assert.equal(authorization.code, 1);
  assert.match(c.h.err.join('\n'), /phase=authorize/);
  assert.doesNotMatch(c.h.out.join('\n'), /AUTHORIZED/);
  assert.ok(authFile);
  const authId = path.basename(authFile, '.json');
  assert.equal(await main(execArgs(c, authorization.plan, authId), c.h.deps), 1);
  assert.equal(c.calls.length, 0, 'a failed authorization must not reach identity proof or Prisma');
});

test('W1-08 authorization close EIO fails and cannot leave a usable authorization', async () => {
  const c = connectedHarness();
  let authFile;
  c.h.deps.fsOps = instrumentedFsOps((file) => String(file).endsWith('.json') && !String(file).endsWith('.consumed.json'), {
    open: ({ file, open }) => { authFile = file; return open(); },
    close: ({ close }) => { close(); throw ioError('EIO'); },
  });
  const authorization = await authorize(c);
  assert.equal(authorization.code, 1);
  assert.match(c.h.err.join('\n'), /phase=authorize/);
  assert.doesNotMatch(c.h.out.join('\n'), /AUTHORIZED/);
  assert.ok(authFile);
  const authId = path.basename(authFile, '.json');
  assert.equal(await main(execArgs(c, authorization.plan, authId), c.h.deps), 1);
  assert.equal(c.calls.length, 0, 'a failed authorization must not reach identity proof or Prisma');
});

test('W1-09 a partial authorization record fails and cannot later create a client', async () => {
  const c = connectedHarness();
  let authFile;
  let writes = 0;
  c.h.deps.fsOps = instrumentedFsOps((file) => String(file).endsWith('.json') && !String(file).endsWith('.consumed.json'), {
    open: ({ file, open }) => { authFile = file; return open(); },
    write: ({ write }) => { writes += 1; return writes === 1 ? write(23) : 0; },
  });
  const authorization = await authorize(c);
  assert.equal(authorization.code, 1);
  assert.match(c.h.err.join('\n'), /phase=authorize/);
  assert.ok(authFile);
  const authId = path.basename(authFile, '.json');
  assert.equal(await main(execArgs(c, authorization.plan, authId), c.h.deps), 1);
  assert.equal(c.calls.length, 0);
});

test('W1-10 a partial consumed marker stops before Prisma and remains single-use', async () => {
  const c = connectedHarness();
  const { plan, authId } = await authorize(c);
  let writes = 0;
  c.h.deps.fsOps = instrumentedFsOps((file) => String(file).endsWith('.consumed.json'), {
    write: ({ write }) => { writes += 1; return writes === 1 ? write(11) : 0; },
  });
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1);
  assert.deepEqual(c.calls, ['marker']);
  assert.match(c.h.err.join('\n'), /phase=authorization/);
  const before = c.calls.length;
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1);
  assert.equal(c.calls.length, before, 'the partial consumed marker prevents any retry client');
  assert.match(c.h.err.at(-1), /phase=authorization.*already used/);
});

test('W1-11 a partial report makes dry-run fail without a success line', async () => {
  let writes = 0;
  const h = harness({ deps: { fsOps: instrumentedFsOps((file) => String(file).endsWith('report.json'), {
    write: ({ write }) => { writes += 1; return writes === 1 ? write(29) : 0; },
  }) } });
  assert.equal(await main(args('dry-run', h.buf), h.deps), 1);
  assert.match(h.err.join('\n'), /phase=report/);
  assert.doesNotMatch(h.out.join('\n'), /DRY RUN/);
});

test('W1-12 a partial receipt after confirmed COMMIT reports only sanitized PERSISTED guidance', async () => {
  const c = connectedHarness();
  const { plan, authId } = await authorize(c);
  let writes = 0;
  c.h.deps.fsOps = instrumentedFsOps((file) => String(file).endsWith('receipt.json'), {
    write: ({ write }) => {
      writes += 1;
      if (writes === 1) return write(19);
      return 0;
    },
  });
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1);
  const text = [...c.h.out, ...c.h.err].join('\n');
  assert.match(c.h.err.join('\n'), /phase=receipt.*COMMIT confirmed.*data persisted.*Do not retry blindly.*EXACT.*NOOP/);
  assert.doesNotMatch(text, /COMPLETE| OK —|uncertain|rolled back|postgresql:|secret|2466666|receipt\.json/);
  assert.ok(readdirSync(c.h.deps.stateRoot).includes(`${authId}.consumed.json`));
});

test('W1-13 exclusive-open failures are sanitized in report and authorize phases', async () => {
  const report = harness();
  report.deps.fsOps = instrumentedFsOps((file) => String(file).endsWith('report.json'), {
    open: ({ file }) => { throw ioError('EACCES', `denied ${file}: ${URL_TEXT} cost 2466666`); },
  });
  assert.equal(await main(args('dry-run', report.buf), report.deps), 1);
  assert.match(report.err.join('\n'), /phase=report/);
  assert.doesNotMatch([...report.out, ...report.err].join('\n'), /postgresql:|secret|2466666|report\.json/);

  const auth = connectedHarness();
  auth.h.deps.fsOps = instrumentedFsOps((file) => String(file).endsWith('.json'), {
    open: ({ file }) => { throw ioError('EACCES', `denied ${file}: ${URL_TEXT} cost 2466666`); },
  });
  assert.equal((await authorize(auth)).code, 1);
  assert.match(auth.h.err.join('\n'), /phase=authorize/);
  assert.doesNotMatch([...auth.h.out, ...auth.h.err].join('\n'), /AUTHORIZED|postgresql:|secret|2466666/);
});

test('A01 authorize needs a TTY and the exact typed phrase, and writes a 0600 record', async () => {
  const noTty = connectedHarness({ deps: { isTTY: false } });
  assert.equal((await authorize(noTty)).code, 1);
  const wrong = connectedHarness();
  assert.equal((await authorize(wrong, 'si')).code, 1);
  const c = connectedHarness();
  const r = await authorize(c);
  assert.equal(r.code, 0, c.h.err.join('\n'));
  assert.match(r.authId, /^[0-9a-f]{32}$/);
  const file = path.join(c.h.deps.stateRoot, `${r.authId}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(rec.planDigest, r.plan);
  assert.equal(rec.backup.sha256, c.backup.sha256);
  assert.equal(c.calls.length, 0, 'authorize opens no client');
});

test('E01 execute refuses a foreign plan before reading the URL file, and refuses DEBUG/PGOPTIONS', async () => {
  const c = connectedHarness();
  let urlRead = false;
  c.h.deps.readPrivateFile = () => { urlRead = true; return { ok: true, text: URL_TEXT }; };
  assert.equal(await main(execArgs(c, 'f'.repeat(64), '0'.repeat(32)), c.h.deps), 1);
  assert.equal(urlRead, false);
  assert.match(c.h.err.join('\n'), /phase=plan/);
  for (const env of [{ DEBUG: '1' }, { PGOPTIONS: '-c x=y' }]) {
    const d = connectedHarness();
    d.h.deps.env = env;
    assert.equal(await main(execArgs(d, await planFor(d.h), '0'.repeat(32)), d.h.deps), 1);
    assert.equal(d.calls.length, 0);
  }
});

test('E02 a forged, expired, foreign or consumed authorization is refused before any client', async () => {
  const c = connectedHarness();
  const { plan, authId } = await authorize(c);
  const file = path.join(c.h.deps.stateRoot, `${authId}.json`);
  const original = readFileSync(file, 'utf8');
  // forged: a bound field changed without re-hashing
  writeFileSync(file, original.replace(c.backup.sha256, 'f'.repeat(64)));
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1);
  writeFileSync(file, original);
  // expired
  const later = { ...c.h.deps, now: () => new Date('2026-10-13T16:00:00Z') };
  assert.equal(await main(execArgs(c, plan, authId), later), 1);
  // unknown id
  assert.equal(await main(execArgs(c, plan, 'a'.repeat(32)), c.h.deps), 1);
  assert.equal(c.calls.length, 0);
  // consumed: a successful run, then a second run with the same id
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 0, c.h.err.join('\n'));
  const before = c.calls.length;
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1);
  assert.equal(c.calls.length, before, 'a consumed authorization opens nothing');
});

test('E03 a failed marker proof does not consume the authorization', async () => {
  const c = connectedHarness({ markerCode: 1 });
  const { plan, authId } = await authorize(c);
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1);
  assert.deepEqual(c.calls, ['marker']);
  assert.ok(!readdirSync(c.h.deps.stateRoot).some((f) => f.endsWith('.consumed.json')));
});

test('E04 a full fake run proves identity, consumes once, uses a long timeout and writes a receipt', async () => {
  const c = connectedHarness();
  const { plan, authId } = await authorize(c);
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 0, c.h.err.join('\n'));
  assert.deepEqual(c.calls, ['marker', 'prisma', 'tx:600000']);
  assert.ok(readdirSync(c.h.deps.stateRoot).includes(`${authId}.consumed.json`));
  assert.ok(readdirSync(c.h.deps.reportRoot).some((d) => readdirSync(path.join(c.h.deps.reportRoot, d)).includes('receipt.json')));
});

test('M1-03 a confirmed commit followed by an unwritable receipt reports persisted data', async () => {
  const c = connectedHarness();
  const { plan, authId } = await authorize(c);
  const blocker = path.join(tmp(), 'not-a-dir');
  writeFileSync(blocker, 'x');
  c.h.deps.reportRoot = path.join(blocker, 'receipts');
  const code = await main(execArgs(c, plan, authId), c.h.deps);
  assert.equal(code, 1);
  assert.match(c.h.err.join('\n'), /phase=receipt/);
  assert.match(c.h.err.join('\n'), /persisted/);
  assert.match(c.h.err.join('\n'), /EXACT.*NOOP/);
});

test('M1-16 non-private receipt directory permissions fail after a confirmed COMMIT', async () => {
  const c = connectedHarness();
  const { plan, authId } = await authorize(c);
  chmodSync(c.h.deps.reportRoot, 0o755);
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1);
  assert.match(c.h.err.join('\n'), /phase=receipt.*COMMIT confirmed.*data persisted/);
  assert.doesNotMatch(c.h.out.join('\n'), / OK —/);
});

// --- T: transaction body against a fake database ------------------------------------

const LOC = '44444444-4444-4444-8444-444444444444';
const DEPOT = '55555555-5555-4555-8555-555555555555';
const OTHER_VARIANT = '66666666-6666-4666-8666-666666666666';
const OWNER = { id: '00000000-0000-4000-9700-000000000001', email: 'propietario01@pilot.local' };
const MIGRATIONS = APPROVED_MIGRATION_PAYLOAD.migrations.map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));

function fakeDb(seed = {}) {
  const t = {
    category: [], brand: [], product: [], productVariant: [], stockMovement: [], auditLog: [],
    inventory: [{ id: 'inv-other', variantId: OTHER_VARIANT, branchId: DEPOT, physical: 7n, reserved: 0n }],
    location: [{ id: LOC, code: 'LOCUNO', type: 'RETAIL_BRANCH', isActive: true, companyId: 'co' }, { id: DEPOT, code: 'DEPUNO', type: 'CENTRAL_WAREHOUSE', isActive: true, companyId: 'co' }],
    branch: [{ id: LOC, code: 'LOCUNO' }, { id: DEPOT, code: 'DEPUNO' }],
    company: [{ id: 'co', cuit: 'PILOT-NO-FISCAL', isActive: true }],
    user: [{ id: OWNER.id, email: OWNER.email, isActive: true }],
    ...seed,
  };
  const writes = [];
  let seq = 0;
  const newId = () => `77777777-7777-4777-8777-${String(++seq).padStart(12, '0')}`;
  const match = (row, where) => !where || Object.entries(where).every(([k, v]) => {
    if (k === 'OR') return v.some((w) => match(row, w));
    if (k === 'NOT') return !match(row, v);
    if (v !== null && typeof v === 'object' && 'in' in v) return v.in.includes(row[k]);
    return row[k] === v;
  });
  const pick = (row, select) => (select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null])) : { ...row });
  // AuditLog JSON as PostgreSQL JSONB returns it: BigInt written as text by the writer, absent -> NULL, and object keys
  // reordered (shorter keys first, then bytewise) — never in insertion order.
  const jsonb = (v) => {
    if (v === undefined || v === null) return null;
    const plain = JSON.parse(JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : x)));
    const order = (x) => (Array.isArray(x) ? x.map(order) : x && typeof x === 'object'
      ? Object.fromEntries(Object.keys(x).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)).map((k) => [k, order(x[k])])) : x);
    return order(plain);
  };
  const tx = {
    marker: { test_guard_exists: false, rows: [{ environment: 'pilot', marker_id: MARKER }] },
    migrations: MIGRATIONS,
    $queryRaw: async () => [{}],
    $queryRawUnsafe: async (sql) => (sql.includes('_prisma_migrations') ? tx.migrations : [tx.marker]),
  };
  for (const name of Object.keys(t)) {
    tx[name] = {
      findMany: async ({ where, select } = {}) => t[name].filter((r) => match(r, where)).map((r) => pick(r, select)),
      create: async ({ data, select }) => {
        const row = name === 'auditLog' ? { id: newId(), ...data, before: jsonb(data.before), after: jsonb(data.after) } : { id: newId(), ...data };
        t[name].push(row);
        writes.push(name);
        return pick(row, select);
      },
    };
  }
  return { tx, t, writes };
}

function fakeCanonical({ failOn = null, tamper = null } = {}) {
  return {
    createProductSchema: { parse: (x) => x },
    createVariantSchema: { parse: (x) => ({ ...x, cashPrice: BigInt(x.cashPrice), price: BigInt(x.price), costPrice: BigInt(x.costPrice) }) },
    initialStockSchema: { parse: (x) => ({ ...x, quantity: BigInt(x.quantity) }) },
    // Same audit rows as the real services (catalog-admin.service.ts / initial-stock.service.ts); BigInt values are
    // stored as strings, as toJsonSafe writes them.
    createCatalogAdminService: (db) => ({
      createProduct: (userId, input) => db.$transaction(async (tx) => {
        if (failOn === 'product') throw new Error('boom');
        const product = await tx.product.create({ data: { ...input, description: null, isActive: true }, select: { id: true } });
        await tx.auditLog.create({ data: {
          userId, branchId: null, action: 'PRODUCT_CREATED', entityType: 'Product', entityId: product.id,
          after: { id: product.id, name: input.name, slug: input.slug, categoryId: input.categoryId, brandId: input.brandId, isActive: true },
        } });
        return product;
      }),
      createVariant: (userId, input) => db.$transaction(async (tx) => {
        const variant = await tx.productVariant.create({ data: { ...input, color: null, size: null, wholesalePrice: null, isActive: true }, select: { id: true } });
        await tx.auditLog.create({ data: {
          userId, branchId: null, action: 'PRODUCT_VARIANT_CREATED', entityType: 'ProductVariant', entityId: variant.id,
          after: {
            id: variant.id, productId: input.productId, sku: input.sku, barcode: input.barcode, color: null, size: null,
            cashPrice: input.cashPrice, price: input.price, wholesalePrice: null, costPrice: input.costPrice, isActive: true,
          },
        } });
        return variant;
      }),
    }),
    createInitialStockService: (db) => ({
      loadInitialStock: (userId, input) => db.$transaction(async (tx) => {
        const inv = await tx.inventory.create({ data: { variantId: input.variantId, branchId: input.branchId, physical: input.quantity, reserved: 0n }, select: { id: true } });
        await tx.stockMovement.create({ data: { inventoryId: inv.id, type: 'INITIAL_STOCK', quantityDelta: input.quantity, saleId: null, userId, branchId: input.branchId } });
        await tx.auditLog.create({ data: {
          userId, branchId: input.branchId, action: 'INVENTORY_INITIAL_STOCK_LOADED', entityType: 'Inventory', entityId: inv.id,
          before: { physical: 0n, reserved: 0n }, after: { physical: input.quantity, reserved: 0n, quantity: input.quantity, variantId: input.variantId },
        } });
        if (tamper) tamper();
        return {};
      }),
    }),
  };
}

const PLAN = () => buildCatalogPlan({ fileSha256: sha(workbook()), parsed: parse(workbook()) });
const PROVENANCE_CTX = Object.freeze({
  authId: 'a'.repeat(32), projectRef: REF, toolSha256: 'e'.repeat(64),
  planDigest: executionDigest({ catalogDigest: PLAN().catalogDigest, locationCode: 'LOCUNO', markerId: MARKER, projectRef: REF, toolSha256: 'e'.repeat(64) }),
});
const ctx = (canonical = fakeCanonical()) => ({ plan: PLAN(), locationCode: 'LOCUNO', markerId: MARKER, owner: OWNER, canonical, approvedMigrations: APPROVED_MIGRATION_PAYLOAD.migrations, provenance: PROVENANCE_CTX });

test('T01 ABSENT creates exactly the plan and leaves other branches untouched', async () => {
  const db = fakeDb();
  const r = await importTransaction(db.tx, ctx());
  assert.equal(r.action, 'CREATED');
  assert.deepEqual(r.counts, { categories: 1, brands: 1, products: 4, variants: 4, stockRows: 4, provenance: 1 });
  assert.deepEqual(r.totals, { items: 4, units: '8', listValueCents: '4500000', cashValueCents: '3600000', costValueCents: '2466666' });
  assert.equal(db.t.stockMovement.length, 4);
  assert.ok(db.t.inventory.filter((i) => i.variantId !== OTHER_VARIANT).every((i) => i.branchId === LOC));
  assert.equal(db.t.inventory.find((i) => i.id === 'inv-other').physical, 7n);
  const v = db.t.productVariant.find((x) => x.sku === 'SYN-001');
  assert.deepEqual([v.barcode, v.cashPrice, v.price, v.costPrice], ['SYN-001', 800000n, 1000000n, 400000n]);
});

test('T02 an EXACT re-run writes nothing', async () => {
  const db = fakeDb();
  await importTransaction(db.tx, ctx());
  const writes = db.writes.length;
  const r = await importTransaction(db.tx, ctx());
  assert.equal(r.action, 'NOOP');
  assert.equal(db.writes.length, writes);
});

test('T03 partial, changed, sold or misplaced prior state is a CONFLICT with no writes', async () => {
  const scenarios = {
    partial: (t) => { t.productVariant.splice(1, 1); },
    price: (t) => { t.productVariant[0].cashPrice = 799999n; },
    sale: (t) => { t.stockMovement.push({ id: 'm-sale', inventoryId: t.inventory[1].id, type: 'SALE', quantityDelta: -1n, branchId: LOC }); t.inventory[1].physical -= 1n; },
    secondInitial: (t) => { t.stockMovement.push({ id: 'm-dup', inventoryId: t.inventory[1].id, type: 'INITIAL_STOCK', quantityDelta: 3n, branchId: LOC }); },
    depot: (t) => { t.inventory.push({ id: 'inv-depot', variantId: t.productVariant[0].id, branchId: DEPOT, physical: 0n, reserved: 0n }); },
  };
  for (const [name, mutate] of Object.entries(scenarios)) {
    const db = fakeDb();
    await importTransaction(db.tx, ctx());
    mutate(db.t);
    const writes = db.writes.length;
    await assert.rejects(importTransaction(db.tx, ctx()), (e) => e.phase === 'conflict', name);
    assert.equal(db.writes.length, writes, name);
  }
});

test('T04 barcode or slug collisions with other products are a CONFLICT', async () => {
  const other = fakeDb({ productVariant: [{ id: OTHER_VARIANT, productId: 'p0', sku: 'OTRO', barcode: 'SYN-002', cashPrice: 1n, price: 1n, costPrice: 0n, isActive: true }] });
  await assert.rejects(importTransaction(other.tx, ctx()), (e) => e.phase === 'conflict');
  assert.equal(other.writes.length, 0);
  const slug = fakeDb({ product: [{ id: 'p0', name: 'Otro', slug: 'syn-003', categoryId: 'c', brandId: 'b', isActive: true }] });
  const plan = PLAN();
  plan.rows[0].slug = 'syn-003';
  await assert.rejects(importTransaction(slug.tx, { ...ctx(), plan }), (e) => e.phase === 'conflict');
});

test('T05 the target location must be one active RETAIL_BRANCH of the PILOT company', async () => {
  for (const mutate of [
    (t) => { t.location[0].type = 'CENTRAL_WAREHOUSE'; },
    (t) => { t.location[0].isActive = false; },
    (t) => { t.location[0].code = 'OTRO'; },
    (t) => { t.company[0].cuit = '20-12345678-9'; },
    (t) => { t.branch.splice(0, 1); },
    (t) => { t.user[0].isActive = false; },
  ]) {
    const db = fakeDb();
    mutate(db.t);
    await assert.rejects(importTransaction(db.tx, ctx()), (e) => e.phase === 'conflict');
    assert.equal(db.writes.length, 0);
  }
});

test('T06 the migration ledger and the marker are re-proven inside the transaction', async () => {
  for (const mutate of [
    (tx) => { tx.migrations = MIGRATIONS.slice(0, 6); },
    (tx) => { tx.migrations = MIGRATIONS.map((m, i) => (i === 6 ? { ...m, checksum: '0'.repeat(64) } : m)); },
    (tx) => { tx.migrations = MIGRATIONS.map((m, i) => (i === 6 ? { ...m, rolled_back: true } : m)); },
    (tx) => { tx.migrations = [...MIGRATIONS, { migration_name: 'zz_extra', checksum: 'x', finished: true, rolled_back: false }]; },
    (tx) => { tx.marker = { test_guard_exists: false, rows: [{ environment: 'pilot', marker_id: '99999999-9999-4999-8999-999999999999' }] }; },
    (tx) => { tx.marker = { test_guard_exists: true, rows: [{ environment: 'pilot', marker_id: MARKER }] }; },
  ]) {
    const db = fakeDb();
    mutate(db.tx);
    await assert.rejects(importTransaction(db.tx, ctx()), (e) => e.phase === 'identity');
    assert.equal(db.writes.length, 0);
  }
});

test('T07 a nested service failure aborts the transaction', async () => {
  const db = fakeDb();
  await assert.rejects(importTransaction(db.tx, ctx(fakeCanonical({ failOn: 'product' }))), (e) => e instanceof NestedTransactionFailure);
});

test('T08 another branch changing during the transaction fails verification', async () => {
  const db = fakeDb();
  const canonical = fakeCanonical({ tamper: () => { db.t.inventory[0].physical = 8n; } });
  await assert.rejects(importTransaction(db.tx, ctx(canonical)), (e) => e.phase === 'verify');
});

test('T09 an existing General category and Sin marca brand are reused', async () => {
  const db = fakeDb({ category: [{ id: 'cat-g', name: 'General' }], brand: [{ id: 'br-s', name: 'Sin marca' }] });
  const r = await importTransaction(db.tx, ctx());
  assert.deepEqual([r.counts.categories, r.counts.brands], [0, 0]);
  assert.ok(db.t.product.every((p) => p.categoryId === 'cat-g' && p.brandId === 'br-s'));
});

function statefulHarness(db, onTransaction = (fn, tx) => fn(tx)) {
  const c = connectedHarness();
  c.h.deps.owner = OWNER;
  c.h.deps.loadCanonical = async () => fakeCanonical();
  c.h.deps.createPrisma = async () => {
    c.calls.push('prisma');
    return {
      $transaction: async (fn, opts) => {
        c.calls.push(`tx:${opts.timeout}`);
        return onTransaction(fn, db.tx);
      },
      $disconnect: async () => {},
    };
  };
  return c;
}

test('M1-01/M1-02/M1-10 failures before COMMIT make no persistence claim or receipt', async () => {
  const scenarios = [
    { name: 'client creation', setup: (c) => { c.h.deps.createPrisma = async () => { throw Object.assign(new Error('client unavailable'), { code: 'ECONNREFUSED' }); }; } },
    { name: 'transaction callback', setup: (c) => { c.h.deps.loadCanonical = async () => fakeCanonical({ failOn: 'product' }); } },
  ];
  for (const scenario of scenarios) {
    const c = statefulHarness(fakeDb());
    scenario.setup(c);
    const { plan, authId } = await authorize(c);
    assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1, scenario.name);
    const text = c.h.err.join('\n');
    assert.match(text, /phase=import/);
    assert.match(text, /before COMMIT/);
    assert.doesNotMatch(text, /data persisted|COMMIT confirmed|transaction rolled back|nothing was written/);
    assert.equal(readdirSync(c.h.deps.reportRoot).length, 0);
  }
});

test('M1-04/M1-05/M1-06/M1-07/M1-15 receipt I/O errors after COMMIT retain a sanitized persisted warning', async () => {
  for (const [stage, code] of [['exclusive create', 'EACCES'], ['write', 'ENOSPC'], ['fsync', 'EIO'], ['close', 'EIO'], ['opaque code', '2466666']]) {
    const c = connectedHarness();
    const { plan, authId } = await authorize(c);
    c.h.deps.publishReceipt = async () => { throw Object.assign(new Error(`${stage} failed: ${URL_TEXT} cost 2466666`), { code }); };
    assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1, stage);
    const text = [...c.h.out, ...c.h.err].join('\n');
    assert.match(c.h.err.join('\n'), /phase=receipt.*COMMIT confirmed.*data persisted.*Do not retry blindly.*EXACT.*NOOP/);
    assert.doesNotMatch(text, /secret|2466666|cost 2466666/);
    assert.ok(readdirSync(c.h.deps.stateRoot).includes(`${authId}.consumed.json`));
  }
});

test('M1-08 a post-COMMIT timestamp failure is still reported as persisted', async () => {
  const c = connectedHarness();
  const { plan, authId } = await authorize(c);
  let failNow = false;
  c.h.deps.now = () => {
    if (failNow) throw Object.assign(new Error('clock failed'), { code: 'EIO' });
    return new Date('2026-10-13T12:00:00Z');
  };
  c.h.deps.createPrisma = async () => ({
    $transaction: async () => { failNow = true; return { action: 'CREATED', counts: { products: 4, variants: 4 }, totals: { units: '8' } }; },
    $disconnect: async () => {},
  });
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1);
  assert.match(c.h.err.join('\n'), /phase=receipt.*COMMIT confirmed.*data persisted/);
});

test('M1-09 COMMIT response failure after callback completion is uncertain', async () => {
  const db = fakeDb();
  const c = statefulHarness(db, async (fn, tx) => {
    await fn(tx);
    throw Object.assign(new Error(`connection lost: ${URL_TEXT} cost 2466666`), { code: 'ECONNRESET' });
  });
  const { plan, authId } = await authorize(c);
  assert.equal(await main(execArgs(c, plan, authId), c.h.deps), 1);
  const text = [...c.h.out, ...c.h.err].join('\n');
  assert.match(c.h.err.join('\n'), /phase=commit.*uncertain.*Do not assume success or rollback.*reconcile PILOT/);
  assert.doesNotMatch(text, /COMMIT confirmed|data persisted|nothing was written|secret|2466666/);
  assert.equal(readdirSync(c.h.deps.reportRoot).length, 0);
});

test('M1-11/M1-12/M1-13/M1-14 a missing receipt blocks reuse; a new authorization verifies EXACT and NOOP', async () => {
  const db = fakeDb();
  const first = statefulHarness(db);
  const a = await authorize(first);
  first.h.deps.publishReceipt = () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  assert.equal(await main(execArgs(first, a.plan, a.authId), first.h.deps), 1);
  const writes = db.writes.length;
  assert.ok(writes > 0);
  assert.equal(await main(execArgs(first, a.plan, a.authId), first.h.deps), 1);
  assert.match(first.h.err.at(-1), /phase=authorization.*already used/);
  assert.equal(db.writes.length, writes);

  const second = statefulHarness(db);
  const b = await authorize(second);
  assert.equal(await main(execArgs(second, b.plan, b.authId), second.h.deps), 0, second.h.err.join('\n'));
  assert.match(second.h.out.join('\n'), /already holds exactly this import; nothing was written/);
  assert.equal(db.writes.length, writes);
  assert.ok(readdirSync(second.h.deps.reportRoot).some((d) => readdirSync(path.join(second.h.deps.reportRoot, d)).includes('receipt.json')));
});

// --- C3 provenance contract (OWNER-confirmed 2026-10-13) and residual security fixes ---
// PRE-REGISTERED (~/.local/share/mona-jacinta/c3-prov-*/expectations.md) before the implementation.

const PROVENANCE = 'PILOT_LOCAL1_IMPORT_COMMITTED';
const provenanceRows = (db) => db.t.auditLog.filter((a) => a.action === PROVENANCE);
async function imported() {
  const db = fakeDb();
  const r = await importTransaction(db.tx, ctx());
  assert.equal(r.action, 'CREATED');
  const [prov] = provenanceRows(db);
  assert.ok(prov, 'the import must leave its provenance row');
  return { db, prov };
}
async function rerunConflicts(db, label) {
  const writes = db.writes.length;
  await assert.rejects(importTransaction(db.tx, ctx()), (e) => e.phase === 'conflict', label);
  assert.equal(db.writes.length, writes, `${label}: nothing written`);
}

test('P01 CREATED writes exactly one provenance row with exactly the contract fields and no secret or cost', async () => {
  const { db, prov } = await imported();
  assert.equal(provenanceRows(db).length, 1);
  const plan = PLAN();
  assert.deepEqual([prov.userId, prov.branchId, prov.entityType, prov.entityId], [OWNER.id, LOC, 'PilotLocal1Import', plan.catalogDigest]);
  const sorted = (xs) => [...xs].sort();
  assert.deepEqual(prov.after, {
    format: 'mona-pilot-local1-import-provenance/v1',
    authId: PROVENANCE_CTX.authId, planDigest: PROVENANCE_CTX.planDigest, catalogDigest: plan.catalogDigest, fileSha256: plan.fileSha256,
    locationCode: 'LOCUNO', markerId: MARKER, projectRef: REF, toolSha256: PROVENANCE_CTX.toolSha256,
    productIds: sorted(db.t.product.map((x) => x.id)), variantIds: sorted(db.t.productVariant.map((x) => x.id)),
    inventoryIds: sorted(db.t.inventory.filter((i) => i.id !== 'inv-other').map((i) => i.id)), movementIds: sorted(db.t.stockMovement.map((m) => m.id)),
    totals: { items: 4, units: '8', listValueCents: '4500000', cashValueCents: '3600000' },
  });
  const text = JSON.stringify(prov);
  for (const secret of ['postgresql://', 'secret', '2466666', 'costPrice', 'costValue']) assert.ok(!text.includes(secret), secret);
  assert.equal(db.writes[db.writes.length - 1], 'auditLog', 'the provenance row is the last write');
});

test('P02 an identical catalog without provenance (a manual OWNER load) is a CONFLICT, never a NOOP', async () => {
  const { db } = await imported();
  db.t.auditLog.splice(0, db.t.auditLog.length, ...db.t.auditLog.filter((a) => a.action !== PROVENANCE));
  await rerunConflicts(db, 'P02');
});

test('P03–P06 duplicate, foreign, non-OWNER or incomplete provenance is a CONFLICT', async () => {
  const mutations = {
    P03: (db, prov) => { db.t.auditLog.push({ ...prov, id: 'prov-dup' }); },
    P04: (db, prov) => { prov.entityId = 'f'.repeat(64); prov.after = { ...prov.after, catalogDigest: 'f'.repeat(64) }; },
    P05: (db, prov) => { prov.userId = '00000000-0000-4000-9700-000000000099'; },
    P06: (db, prov) => { prov.after = { ...prov.after, variantIds: prov.after.variantIds.slice(1) }; },
  };
  for (const [id, mutate] of Object.entries(mutations)) {
    const { db, prov } = await imported();
    mutate(db, prov);
    await rerunConflicts(db, id);
  }
});

test('P07 a provenance row without its catalog is a CONFLICT, never a fresh import', async () => {
  const { prov } = await imported();
  const db = fakeDb({ auditLog: [prov] });
  await rerunConflicts(db, 'P07');
});

test('P08–P10 a later audit, a foreign stock actor or a missing canonical audit is a CONFLICT', async () => {
  const mutations = {
    P08: (db) => { db.t.auditLog.push({ id: 'a-price', userId: OWNER.id, branchId: null, action: 'PRODUCT_VARIANT_PRICE_CHANGED', entityType: 'ProductVariant', entityId: db.t.productVariant[0].id }); },
    P09: (db) => { db.t.stockMovement[0].userId = '00000000-0000-4000-9700-000000000099'; },
    P10: (db) => { const i = db.t.auditLog.findIndex((a) => a.action === 'PRODUCT_CREATED'); db.t.auditLog.splice(i, 1); },
  };
  for (const [id, mutate] of Object.entries(mutations)) {
    const { db } = await imported();
    mutate(db);
    await rerunConflicts(db, id);
  }
});

test('S01 a backup reached through a symlinked parent into a forbidden root is refused', () => {
  const forbiddenRoot = tmp();
  const outside = tmp();
  const file = path.join(forbiddenRoot, 'pilot.dump');
  const content = Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 7)]);
  writeFileSync(file, content);
  chmodSync(file, 0o600);
  symlinkSync(forbiddenRoot, path.join(outside, 'link'));
  const result = verify({ file: path.join(outside, 'link', 'pilot.dump'), sha256: sha(content), forbiddenRoots: [forbiddenRoot] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /repository or temporary storage/);
});

test('S02 a private report directory reached through a symlinked parent into a forbidden root is refused', async () => {
  const forbiddenRoot = tmp();
  const outside = tmp();
  symlinkSync(forbiddenRoot, path.join(outside, 'link'));
  const h = harness({ deps: { reportRoot: path.join(outside, 'link', 'reports'), forbiddenRoots: [forbiddenRoot] } });
  const code = await main(args('dry-run', h.buf), h.deps);
  assert.equal(code, 1);
  assert.match(h.err.join('\n'), /phase=report/);
});

test('S03–S06 the marker installation time must be a real timestamp no later than the archive', () => {
  const at = (ts) => markerCopy({ rows: [`t\tpilot\t${MARKER_ID}\t${ts}`] });
  for (const [id, ts] of [['S03', '2026-99-99 99:99:99+99'], ['S04', '2026-02-30 10:00:00+00'], ['S05', '2026-10-13 11:00:00+00']]) {
    const result = verify({ ...backupFile(), pgRestoreMarkerData: () => at(ts) });
    assert.equal(result.ok, false, id);
  }
  const ok = verify({ ...backupFile(), pgRestoreMarkerData: () => at('2026-10-13 01:00:00.5-03') });
  assert.equal(ok.ok, true, `S06 ${ok.reason}`);
});

test('S07 permissions are proven on the held descriptor: a chmod in the lstat->open window is refused', () => {
  const b = backupFile();
  const result = verify({ ...b, fsOps: { openSync: (file, flags) => { chmodSync(file, 0o644); return realOpenSync(file, flags); } } });
  assert.equal(result.ok, false);
});

test('S08 the default pg_restore invocations are bounded in time and killed hard on expiry', () => {
  for (const kind of ['list', 'markerData']) {
    const { options } = importerModule.pgRestoreInvocation(kind, Buffer.from('PGDMP'));
    assert.equal(options.timeout, 120000, kind);
    assert.equal(options.killSignal, 'SIGKILL', kind);
  }
});

test('S09 a pg_restore timeout is a refusal that discloses nothing', () => {
  const timedOut = () => { throw Object.assign(new Error('spawnSync pg_restore ETIMEDOUT secret 2466666'), { code: 'ETIMEDOUT' }); };
  for (const o of [{ pgRestoreList: timedOut }, { pgRestoreMarkerData: timedOut }]) {
    const result = verify({ ...backupFile(), ...o });
    assert.equal(result.ok, false);
    assert.doesNotMatch(result.reason, /secret|2466666|ETIMEDOUT/);
  }
});

// --- Round 2 (Codex REVISE): JSONB read-back, full canonical audits, digest binding ---------------------------------

test('Q01 JSONB key order on read-back neither rolls back the import nor breaks the NOOP', async () => {
  const { db } = await imported();
  const [prov] = provenanceRows(db);
  assert.notDeepStrictEqual(Object.keys(prov.after.totals), ['items', 'units', 'listValueCents', 'cashValueCents'], 'the fake must reorder keys');
  const writes = db.writes.length;
  const r = await importTransaction(db.tx, ctx());
  assert.equal(r.action, 'NOOP');
  assert.equal(db.writes.length, writes);
});

test('Q02–Q05, Q09 a truncated, false or extended canonical audit snapshot is a CONFLICT', async () => {
  const audit = (db, action) => db.t.auditLog.find((a) => a.action === action);
  const mutations = {
    Q02: (db) => { const a = audit(db, 'PRODUCT_CREATED'); const { slug, ...rest } = a.after; void slug; a.after = rest; },
    Q03: (db) => { const a = audit(db, 'PRODUCT_VARIANT_CREATED'); a.after = { ...a.after, costPrice: '1' }; },
    Q04: (db) => { const a = audit(db, 'INVENTORY_INITIAL_STOCK_LOADED'); a.before = { physical: '5', reserved: '0' }; },
    Q05a: (db) => { audit(db, 'PRODUCT_CREATED').before = { name: 'antes' }; },
    Q05b: (db) => { audit(db, 'PRODUCT_VARIANT_CREATED').before = { price: '1' }; },
    Q09: (db) => { const a = audit(db, 'INVENTORY_INITIAL_STOCK_LOADED'); a.after = { ...a.after, note: 'x' }; },
  };
  for (const [id, mutate] of Object.entries(mutations)) {
    const { db } = await imported();
    mutate(db);
    await rerunConflicts(db, id);
  }
});

test('Q06–Q07 a provenance whose planDigest is not derived from its own fields is a CONFLICT', async () => {
  for (const [id, mutate] of [
    ['Q06', (prov) => { prov.after = { ...prov.after, planDigest: 'c'.repeat(64) }; }],
    ['Q07', (prov) => { prov.after = { ...prov.after, toolSha256: 'd'.repeat(64) }; }],
  ]) {
    const { db, prov } = await imported();
    mutate(prov);
    await rerunConflicts(db, id);
  }
});

test('Q08 a transaction whose provenance planDigest is not derived from its own inputs writes nothing', async () => {
  const db = fakeDb();
  await assert.rejects(importTransaction(db.tx, { ...ctx(), provenance: { ...PROVENANCE_CTX, planDigest: 'c'.repeat(64) } }), (e) => e.phase === 'identity');
  assert.equal(db.writes.length, 0);
});

test('Q11 the fake services write exactly the real audit key sets', async () => {
  const { db } = await imported();
  const keys = (action, field) => Object.keys(db.t.auditLog.find((a) => a.action === action)[field] ?? {}).sort();
  assert.deepEqual(keys('PRODUCT_CREATED', 'after'), ['brandId', 'categoryId', 'id', 'isActive', 'name', 'slug']);
  assert.deepEqual(keys('PRODUCT_VARIANT_CREATED', 'after'), ['barcode', 'cashPrice', 'color', 'costPrice', 'id', 'isActive', 'price', 'productId', 'size', 'sku', 'wholesalePrice']);
  assert.deepEqual(keys('INVENTORY_INITIAL_STOCK_LOADED', 'before'), ['physical', 'reserved']);
  assert.deepEqual(keys('INVENTORY_INITIAL_STOCK_LOADED', 'after'), ['physical', 'quantity', 'reserved', 'variantId']);
});

test('K01 classifyImportState is pure and reports every conflict', () => {
  const state = classifyImportState({ locations: [], branches: [], companies: [], owners: [], categories: [], brands: [], products: [], variants: [], inventory: [], movements: [] }, PLAN(), { locationCode: 'LOCUNO', ownerId: OWNER.id });
  assert.equal(state.state, 'CONFLICT');
  assert.ok(state.conflicts.length >= 2);
});
