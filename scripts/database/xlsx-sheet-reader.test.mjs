import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { DEFAULT_LIMITS, XlsxError, readXlsx } from './xlsx-sheet-reader.mjs';

// Synthetic workbooks only: every archive below is built in memory by this test.

// --- minimal ZIP writer (test-only) ---------------------------------------------------

function zip(entries, { corruptCrcOf = null, flagsOf = {}, declaredSizeOf = {}, extraCentral = [] } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of [...entries]) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method ?? 8;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    let crc = crc32(raw);
    if (corruptCrcOf === e.name) crc = (crc ^ 0xffffffff) >>> 0;
    const flags = flagsOf[e.name] ?? 0;
    const size = declaredSizeOf[e.name] ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  for (const c of extraCentral) centrals.push(c);
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  const count = entries.length + extraCentral.length / 2;
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function workbookParts({ sheets = [{ name: 'Hoja1', xml: null }], sharedStrings = ['productos', 'SYN-001 alfa'], workbookPrefix = '', stylesXml = null } = {}) {
  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet ${NS}><dimension ref="B2:E4"/><sheetData>
<row r="2"><c r="B2" s="0" t="s"><v>0</v></c><c r="D2" s="1"><v>6</v></c></row>
<row r="4"><c r="B4" t="s"><v>1</v></c><c r="E4" s="1"><f>F4/D4</f><v>9375</v></c><c r="G4" s="2"/></row>
</sheetData><mergeCells count="1"><mergeCell ref="B2:C2"/></mergeCells></worksheet>`;
  const parts = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    {
      name: 'xl/workbook.xml',
      data: `${workbookPrefix}<?xml version="1.0"?><workbook ${NS}><sheets>${sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data: stylesXml ?? `<?xml version="1.0"?><styleSheet ${NS}><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills><cellXfs count="3"><xf numFmtId="0" fillId="0"/><xf numFmtId="0" fillId="2" applyFill="1"/><xf numFmtId="0" fillId="1"/></cellXfs></styleSheet>`,
    },
    {
      name: 'xl/sharedStrings.xml',
      data: `<?xml version="1.0"?><sst ${NS} count="${sharedStrings.length}">${sharedStrings.map((s) => (s.startsWith('<') ? `<si>${s}</si>` : `<si><t xml:space="preserve">${s}</t></si>`)).join('')}</sst>`,
    },
  ];
  sheets.forEach((s, i) => parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml ?? sheetXml }));
  return parts;
}

const book = (options) => zip(workbookParts(options));
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof XlsxError, `expected XlsxError, got ${err?.name}: ${err?.message}`);
    return err.code;
  }
  return 'NO_ERROR';
};

// --- behaviour -----------------------------------------------------------------------

test('R01 reads sheets, shared strings, numbers, cached formulas, fills and merges', () => {
  const wb = readXlsx(book());
  assert.equal(wb.sheets.length, 1);
  const [sheet] = wb.sheets;
  assert.equal(sheet.name, 'Hoja1');
  assert.equal(sheet.state, 'visible');
  assert.deepEqual(sheet.merges, ['B2:C2']);
  assert.deepEqual(sheet.cells.get('B2'), { ref: 'B2', col: 'B', row: 2, type: 's', value: 'productos', formula: null, fill: null });
  assert.deepEqual(sheet.cells.get('D2'), { ref: 'D2', col: 'D', row: 2, type: 'n', value: '6', formula: null, fill: 'FFFFFF00' });
  assert.deepEqual(sheet.cells.get('E4'), { ref: 'E4', col: 'E', row: 4, type: 'n', value: '9375', formula: 'F4/D4', fill: 'FFFFFF00' });
  assert.equal(sheet.cells.get('B4').value, 'SYN-001 alfa');
  assert.deepEqual(sheet.cells.get('G4'), { ref: 'G4', col: 'G', row: 4, type: 'n', value: null, formula: null, fill: 'pattern:gray125' });
});

test('R02 non-ZIP and truncated archives are refused', () => {
  assert.equal(code(() => readXlsx(Buffer.from('not a zip at all, definitely not'))), 'XLSX_NOT_ZIP');
  const full = book();
  assert.equal(code(() => readXlsx(full.subarray(0, full.length - 10))), 'XLSX_NOT_ZIP');
  assert.equal(code(() => readXlsx('string input')), 'XLSX_NOT_ZIP');
});

test('R03 expansion limits: declared size, real inflated size and ratio are bounded', () => {
  const parts = workbookParts();
  const big = 'A'.repeat(300_000);
  parts[4] = { name: 'xl/sharedStrings.xml', data: `<?xml version="1.0"?><sst ${NS}><si><t>${big}</t></si></sst>` };
  assert.equal(code(() => readXlsx(zip(parts), { ...DEFAULT_LIMITS, maxEntryBytes: 100_000 })), 'XLSX_LIMIT');
  // A lying central directory (declares 10 bytes) must not let the inflater run past it.
  assert.equal(code(() => readXlsx(zip(parts, { declaredSizeOf: { 'xl/sharedStrings.xml': 10 } }))), 'XLSX_LIMIT');
  assert.equal(code(() => readXlsx(zip(parts), { ...DEFAULT_LIMITS, maxRatio: 5 })), 'XLSX_LIMIT');
  assert.equal(code(() => readXlsx(book(), { ...DEFAULT_LIMITS, maxFileBytes: 100 })), 'XLSX_LIMIT');
});

test('R04 DOCTYPE, ENTITY and processing instructions are refused in every part', () => {
  assert.equal(code(() => readXlsx(book({ workbookPrefix: '<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>' }))), 'XLSX_UNSAFE_XML');
  assert.equal(code(() => readXlsx(book({ sharedStrings: ['<t>&e;</t>'] }))), 'XLSX_UNSAFE_XML');
  assert.equal(code(() => readXlsx(book({ sharedStrings: ['<t>a<?php x ?></t>'] }))), 'XLSX_UNSAFE_XML');
});

test('R05 predefined and numeric entities decode; nothing else does', () => {
  const wb = readXlsx(book({ sharedStrings: ['<t>A&amp;B &lt;x&gt; &quot;q&quot; &apos;s&apos; &#209;&#xF1;</t>', 'SYN-001 alfa'] }));
  assert.equal(wb.sheets[0].cells.get('B2').value, 'A&B <x> "q" \'s\' Ññ');
  assert.equal(code(() => readXlsx(book({ sharedStrings: ['<t>&#0;</t>', 'x'] }))), 'XLSX_UNSAFE_XML');
});

test('R06 encrypted, traversal, absolute and duplicate entries are refused', () => {
  const parts = workbookParts();
  assert.equal(code(() => readXlsx(zip(parts, { flagsOf: { 'xl/styles.xml': 1 } }))), 'XLSX_ZIP_INVALID');
  assert.equal(code(() => readXlsx(zip([...parts, { name: '../evil.xml', data: 'x' }]))), 'XLSX_ZIP_INVALID');
  assert.equal(code(() => readXlsx(zip([...parts, { name: '/abs.xml', data: 'x' }]))), 'XLSX_ZIP_INVALID');
  assert.equal(code(() => readXlsx(zip([...parts, { name: 'xl\\back.xml', data: 'x' }]))), 'XLSX_ZIP_INVALID');
  assert.equal(code(() => readXlsx(zip([...parts, parts[3]]))), 'XLSX_ZIP_INVALID');
  assert.equal(code(() => readXlsx(zip(parts.map((p) => (p.name === 'xl/styles.xml' ? { ...p, method: 12 } : p))))), 'XLSX_ZIP_INVALID');
});

test('R07 a CRC mismatch is refused', () => {
  assert.equal(code(() => readXlsx(zip(workbookParts(), { corruptCrcOf: 'xl/sharedStrings.xml' }))), 'XLSX_ZIP_INVALID');
});

test('R08 a shared-string index out of range is refused', () => {
  assert.equal(code(() => readXlsx(book({ sharedStrings: ['only one'] }))), 'XLSX_INVALID');
});

test('R09 rich-text runs concatenate and phonetic runs are excluded', () => {
  const wb = readXlsx(book({ sharedStrings: ['<r><t>SYN-</t></r><r><t>002 beta</t></r><rPh sb="0" eb="1"><t>IGNORED</t></rPh>', 'x'] }));
  assert.equal(wb.sheets[0].cells.get('B2').value, 'SYN-002 beta');
});

test('R10 a formula without a cached value keeps value null and the formula text', () => {
  const xml = `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="4"><c r="E4"><f>F4/D4</f></c></row></sheetData></worksheet>`;
  const cell = readXlsx(book({ sheets: [{ name: 'Hoja1', xml }] })).sheets[0].cells.get('E4');
  assert.equal(cell.value, null);
  assert.equal(cell.formula, 'F4/D4');
});

test('R11 hidden sheets and their state are reported, in workbook order', () => {
  const wb = readXlsx(book({ sheets: [{ name: 'Hoja1' }, { name: 'Oculta', state: 'hidden' }, { name: 'Muy', state: 'veryHidden' }] }));
  assert.deepEqual(wb.sheets.map((s) => [s.name, s.state]), [['Hoja1', 'visible'], ['Oculta', 'hidden'], ['Muy', 'veryHidden']]);
});

test('R12 inline strings, booleans and errors carry their type; bad cell refs are refused', () => {
  const xml = `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="5"><c r="B5" t="inlineStr"><is><t>inline &amp; x</t></is></c><c r="C5" t="b"><v>1</v></c><c r="D5" t="e"><v>#DIV/0!</v></c><c r="E5" t="str"><f>"a"</f><v>a</v></c></row></sheetData></worksheet>`;
  const cells = readXlsx(book({ sheets: [{ name: 'Hoja1', xml }] })).sheets[0].cells;
  assert.deepEqual([...cells.values()].map((c) => [c.ref, c.type, c.value]), [['B5', 's', 'inline & x'], ['C5', 'b', '1'], ['D5', 'e', '#DIV/0!'], ['E5', 'str', 'a']]);
  const bad = `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="5"><c r="5B"><v>1</v></c></row></sheetData></worksheet>`;
  assert.equal(code(() => readXlsx(book({ sheets: [{ name: 'Hoja1', xml: bad }] }))), 'XLSX_INVALID');
});

test('R13 a cell count above the limit is refused', () => {
  assert.equal(code(() => readXlsx(book(), { ...DEFAULT_LIMITS, maxCells: 2 })), 'XLSX_LIMIT');
});

test('R15 shared formulas expand to each dependent cell with relative references shifted', () => {
  const xml = `<?xml version="1.0"?><worksheet ${NS}><sheetData>
<row r="8"><c r="E8"><f t="shared" ref="E8:E10" si="0">F8/D8+$A$1</f><v>1</v></c></row>
<row r="9"><c r="E9"><f t="shared" si="0"/><v>2</v></c></row>
<row r="10"><c r="E10"><f t="shared" si="0"/><v>3</v></c></row>
</sheetData></worksheet>`;
  const cells = readXlsx(book({ sheets: [{ name: 'Hoja1', xml }] })).sheets[0].cells;
  assert.deepEqual(['E8', 'E9', 'E10'].map((r) => cells.get(r).formula), ['F8/D8+$A$1', 'F9/D9+$A$1', 'F10/D10+$A$1']);
});

test('R16 a shared formula without its master, or outside the master range, is refused', () => {
  const orphan = `<?xml version="1.0"?><worksheet ${NS}><sheetData><row r="9"><c r="E9"><f t="shared" si="7"/><v>2</v></c></row></sheetData></worksheet>`;
  assert.equal(code(() => readXlsx(book({ sheets: [{ name: 'Hoja1', xml: orphan }] }))), 'XLSX_INVALID');
  const outside = `<?xml version="1.0"?><worksheet ${NS}><sheetData>
<row r="8"><c r="E8"><f t="shared" ref="E8:E9" si="0">F8/D8</f><v>1</v></c></row>
<row r="12"><c r="E12"><f t="shared" si="0"/><v>2</v></c></row></sheetData></worksheet>`;
  assert.equal(code(() => readXlsx(book({ sheets: [{ name: 'Hoja1', xml: outside }] }))), 'XLSX_INVALID');
});

test('R14 a missing required part is refused', () => {
  const parts = workbookParts().filter((p) => p.name !== 'xl/styles.xml');
  assert.equal(code(() => readXlsx(zip(parts))), 'XLSX_INVALID');
});
