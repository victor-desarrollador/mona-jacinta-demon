// Bounded, dependency-free XLSX reader for OWNER-supplied spreadsheets.
//
// Only what an inventory sheet needs: the ZIP central directory (stored or
// deflate entries, Node's zlib), the workbook sheet list and relationships,
// shared strings, cell fills and the worksheet cells/merges. Everything is
// bounded (file size, entry count, per-entry and total inflated bytes,
// compression ratio, cell count) and checked (CRC-32, declared sizes, entry
// names). XML is tokenized by a closed scanner that refuses DOCTYPE/ENTITY/
// any other markup declaration and processing instructions, and decodes only
// the five predefined and numeric character references — no external entity
// can be resolved because nothing resolves entities. Values are returned as
// the cached text Excel stored; this module never evaluates formulas.

import { crc32, inflateRawSync } from 'node:zlib';

export class XlsxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'XlsxError';
    this.code = code;
  }
}

export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxEntries: 64,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxRatio: 200,
  maxCells: 20_000,
  maxDepth: 32,
});

const fail = (code, message) => {
  throw new XlsxError(code, message);
};

// --- ZIP ------------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG && i + 22 + buf.readUInt16LE(i + 20) === buf.length) return i;
  }
  return -1;
}

function validEntryName(name) {
  if (name.length === 0 || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((segment) => segment === '..' || segment === '.');
}

function readCentralDirectory(buf, limits) {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) fail('XLSX_NOT_ZIP', 'not a ZIP archive (no end-of-central-directory record)');
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countOnDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) fail('XLSX_ZIP_INVALID', 'ZIP64 archives are not accepted');
  if (disk !== 0 || cdDisk !== 0 || countOnDisk !== count) fail('XLSX_ZIP_INVALID', 'multi-disk archives are not accepted');
  if (count > limits.maxEntries) fail('XLSX_LIMIT', `more than ${limits.maxEntries} archive entries`);
  if (cdOffset + cdSize > eocd) fail('XLSX_NOT_ZIP', 'central directory lies outside the archive');

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CENTRAL_SIG) fail('XLSX_ZIP_INVALID', 'malformed central directory');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (p + 46 + nameLength > eocd) fail('XLSX_ZIP_INVALID', 'malformed central directory');
    const name = buf.subarray(p + 46, p + 46 + nameLength).toString('utf8');
    if (!validEntryName(name)) fail('XLSX_ZIP_INVALID', 'an archive entry has an unsafe name');
    if (entries.has(name)) fail('XLSX_ZIP_INVALID', 'duplicate archive entry');
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) fail('XLSX_ZIP_INVALID', 'encrypted entries are not accepted');
    if (method !== 0 && method !== 8) fail('XLSX_ZIP_INVALID', 'unsupported compression method');
    if (compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) fail('XLSX_ZIP_INVALID', 'ZIP64 entries are not accepted');
    entries.set(name, { name, method, crc, compressedSize, size, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function makeExtractor(buf, entries, limits) {
  let total = 0;
  return (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.size > limits.maxEntryBytes) fail('XLSX_LIMIT', 'an archive entry exceeds the inflated size limit');
    if (e.compressedSize > 0 && e.size / e.compressedSize > limits.maxRatio) fail('XLSX_LIMIT', 'an archive entry exceeds the compression ratio limit');
    if (total + e.size > limits.maxTotalBytes) fail('XLSX_LIMIT', 'the archive exceeds the total inflated size limit');
    const h = e.localOffset;
    if (h + 30 > buf.length || buf.readUInt32LE(h) !== LOCAL_SIG) fail('XLSX_ZIP_INVALID', 'malformed local header');
    const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
    if (start + e.compressedSize > buf.length) fail('XLSX_NOT_ZIP', 'truncated archive entry');
    const body = buf.subarray(start, start + e.compressedSize);
    let data;
    if (e.method === 0) {
      data = Buffer.from(body);
    } else {
      try {
        data = inflateRawSync(body, { maxOutputLength: Math.max(e.size, 1) });
      } catch (err) {
        if (err?.code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) fail('XLSX_LIMIT', 'an archive entry inflates beyond its declared size');
        fail('XLSX_ZIP_INVALID', 'an archive entry could not be inflated');
      }
    }
    if (data.length !== e.size) fail('XLSX_ZIP_INVALID', 'an archive entry does not match its declared size');
    if (crc32(data) >>> 0 !== e.crc) fail('XLSX_ZIP_INVALID', 'an archive entry fails its CRC-32 check');
    total += data.length;
    return data;
  };
}

// --- XML ------------------------------------------------------------------------------

const PREDEFINED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeText(raw) {
  return raw.replace(/&([^;&\s]{0,12});|&/g, (match, body) => {
    if (body === undefined) fail('XLSX_UNSAFE_XML', 'a bare ampersand is not well-formed');
    if (Object.hasOwn(PREDEFINED, body)) return PREDEFINED[body];
    const num = /^#([0-9]{1,7})$/.exec(body) ?? /^#x([0-9A-Fa-f]{1,6})$/.exec(body);
    if (num) {
      const cp = parseInt(num[1], body[1] === 'x' ? 16 : 10);
      const allowed = cp === 0x9 || cp === 0xa || cp === 0xd || (cp >= 0x20 && cp <= 0xd7ff) || (cp >= 0xe000 && cp <= 0xfffd) || (cp >= 0x10000 && cp <= 0x10ffff);
      if (!allowed) fail('XLSX_UNSAFE_XML', 'a character reference names a forbidden code point');
      return String.fromCodePoint(cp);
    }
    return fail('XLSX_UNSAFE_XML', 'entity references other than the predefined ones are refused');
  });
}

const TAG = /<(\/?)([A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?)((?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/y;
const ATTR = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;

function parseXml(buffer, limits) {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const decl = /^<\?xml\s[^?<>]*\?>/.exec(text);
  let i = decl ? decl[0].length : 0;
  if (text.includes('<!', i)) fail('XLSX_UNSAFE_XML', 'markup declarations (DOCTYPE, ENTITY, CDATA, comments) are refused');
  if (text.includes('<?', i)) fail('XLSX_UNSAFE_XML', 'processing instructions are refused');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const end = lt < 0 ? text.length : lt;
    if (end > i) {
      const chunk = text.slice(i, end);
      const top = stack[stack.length - 1];
      if (top === root) {
        if (chunk.trim() !== '') fail('XLSX_INVALID', 'text outside the document element');
      } else {
        top.text += decodeText(chunk);
      }
    }
    if (lt < 0) break;
    TAG.lastIndex = lt;
    const m = TAG.exec(text);
    if (!m) fail('XLSX_INVALID', 'malformed XML tag');
    const [, closing, qname, rawAttrs, selfClosing] = m;
    const local = qname.includes(':') ? qname.slice(qname.indexOf(':') + 1) : qname;
    if (closing) {
      if (rawAttrs.trim() !== '' || selfClosing) fail('XLSX_INVALID', 'malformed closing tag');
      const top = stack.pop();
      if (!top || top === root || top.qname !== qname) fail('XLSX_INVALID', 'mismatched XML tags');
    } else {
      const attrs = {};
      for (const a of rawAttrs.matchAll(ATTR)) {
        if (Object.hasOwn(attrs, a[1])) fail('XLSX_INVALID', 'duplicate XML attribute');
        attrs[a[1]] = decodeText(a[2] ?? a[3]);
      }
      const node = { name: local, qname, attrs, children: [], text: '' };
      const parent = stack[stack.length - 1];
      if (parent === root && root.children.length > 0) fail('XLSX_INVALID', 'more than one document element');
      parent.children.push(node);
      if (!selfClosing) {
        stack.push(node);
        if (stack.length > limits.maxDepth) fail('XLSX_LIMIT', 'XML nesting is too deep');
      }
    }
    i = TAG.lastIndex;
  }
  if (stack.length !== 1 || root.children.length !== 1) fail('XLSX_INVALID', 'unbalanced XML document');
  return root.children[0];
}

const child = (node, name) => node?.children.find((c) => c.name === name);
const children = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);

// Text of a shared/inline string item: direct <t> or rich-text <r><t>; phonetic runs (<rPh>) excluded.
function stringItemText(node) {
  let out = '';
  for (const c of node.children) {
    if (c.name === 't') out += c.text;
    else if (c.name === 'r') out += children(c, 't').map((t) => t.text).join('');
  }
  return out;
}

// --- workbook -------------------------------------------------------------------------

const REF = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/;

const colNumber = (letters) => [...letters].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
function colLetters(n) {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

// A shared formula's dependents reuse the master text with every relative A1
// reference shifted by the dependent's offset from the master ($-anchored parts stay).
function shiftFormula(text, dRow, dCol) {
  return text.replace(/(\$?)([A-Z]{1,3})(\$?)([0-9]{1,7})(?![0-9A-Za-z_(])/g, (_, ac, col, ar, row) => {
    const c = ac ? col : colLetters(colNumber(col) + dCol);
    const r = ar ? row : String(Number(row) + dRow);
    if (!ac && colNumber(col) + dCol < 1) fail('XLSX_INVALID', 'a shared formula shifts outside the sheet');
    if (!ar && Number(row) + dRow < 1) fail('XLSX_INVALID', 'a shared formula shifts outside the sheet');
    return `${ac}${c}${ar}${r}`;
  });
}

function parseRange(ref) {
  const m = /^([A-Z]{1,3})([1-9][0-9]{0,6}):([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(ref ?? '');
  if (!m) return null;
  return { c1: colNumber(m[1]), r1: Number(m[2]), c2: colNumber(m[3]), r2: Number(m[4]) };
}

function resolveTarget(target) {
  if (typeof target !== 'string') return null;
  const full = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  return validEntryName(full) && full.startsWith('xl/') ? full : null;
}

function fillLabel(fill) {
  const pattern = child(fill, 'patternFill');
  const type = pattern?.attrs.patternType;
  if (!pattern || !type || type === 'none') return null;
  if (type !== 'solid') return `pattern:${type}`;
  const fg = child(pattern, 'fgColor');
  if (fg?.attrs.rgb) return fg.attrs.rgb.toUpperCase();
  if (fg?.attrs.theme !== undefined) return `theme:${fg.attrs.theme}${fg.attrs.tint ? `/tint:${fg.attrs.tint}` : ''}`;
  if (fg?.attrs.indexed !== undefined) return `indexed:${fg.attrs.indexed}`;
  return 'solid:unknown';
}

export function readXlsx(input, limits = DEFAULT_LIMITS) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) fail('XLSX_NOT_ZIP', 'input is not binary data');
  const buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (buf.length > lim.maxFileBytes) fail('XLSX_LIMIT', 'the file exceeds the size limit');
  if (buf.length < 22) fail('XLSX_NOT_ZIP', 'not a ZIP archive');
  const entries = readCentralDirectory(buf, lim);
  const extract = makeExtractor(buf, entries, lim);
  const requireXml = (name) => {
    const data = extract(name);
    if (!data) fail('XLSX_INVALID', `required part ${name} is missing`);
    return parseXml(data, lim);
  };

  const workbook = requireXml('xl/workbook.xml');
  const rels = requireXml('xl/_rels/workbook.xml.rels');
  const styles = requireXml('xl/styles.xml');
  const ssData = extract('xl/sharedStrings.xml');
  const shared = ssData ? children(parseXml(ssData, lim), 'si').map(stringItemText) : [];

  const fills = children(child(styles, 'fills'), 'fill').map(fillLabel);
  const xfFills = children(child(styles, 'cellXfs'), 'xf').map((xf) => {
    const id = Number(xf.attrs.fillId ?? 0);
    if (!Number.isInteger(id) || id < 0 || id >= Math.max(fills.length, 1)) fail('XLSX_INVALID', 'a cell style references an unknown fill');
    return fills[id] ?? null;
  });

  const relTargets = new Map(children(rels, 'Relationship').map((r) => [r.attrs.Id, r.attrs.Target]));
  let cellCount = 0;
  const sheets = children(child(workbook, 'sheets'), 'sheet').map((s) => {
    const target = resolveTarget(relTargets.get(s.attrs['r:id']));
    if (!target) fail('XLSX_INVALID', 'a sheet has no valid relationship target');
    const sheet = requireXml(target);
    const cells = new Map();
    const masters = new Map();
    const pendingShared = [];
    for (const row of children(child(sheet, 'sheetData'), 'row')) {
      for (const c of children(row, 'c')) {
        const m = REF.exec(c.attrs.r ?? '');
        if (!m) fail('XLSX_INVALID', 'a cell has an invalid reference');
        if (cells.has(c.attrs.r)) fail('XLSX_INVALID', 'duplicate cell reference');
        cellCount += 1;
        if (cellCount > lim.maxCells) fail('XLSX_LIMIT', 'the workbook exceeds the cell limit');
        const style = Number(c.attrs.s ?? 0);
        if (!Number.isInteger(style) || style < 0 || (xfFills.length > 0 && style >= xfFills.length)) fail('XLSX_INVALID', 'a cell references an unknown style');
        const v = child(c, 'v');
        const f = child(c, 'f');
        const t = c.attrs.t ?? 'n';
        let type = t;
        let value = v ? v.text : null;
        if (t === 's') {
          const idx = Number(value);
          if (value === null || !/^[0-9]+$/.test(value) || idx >= shared.length) fail('XLSX_INVALID', 'a shared-string index is out of range');
          value = shared[idx];
        } else if (t === 'inlineStr') {
          type = 's';
          const is = child(c, 'is');
          value = is ? stringItemText(is) : null;
        } else if (!['n', 'b', 'e', 'str'].includes(t)) {
          fail('XLSX_INVALID', 'a cell has an unknown type');
        }
        let formula = f ? f.text : null;
        if (f && f.attrs.t === 'shared') {
          const si = f.attrs.si;
          if (f.text !== '') {
            const range = parseRange(f.attrs.ref);
            if (!range || masters.has(si)) fail('XLSX_INVALID', 'a shared formula master is malformed');
            masters.set(si, { text: f.text, row: Number(m[2]), col: colNumber(m[1]), range });
          } else {
            pendingShared.push({ ref: c.attrs.r, si, row: Number(m[2]), col: colNumber(m[1]) });
            formula = null;
          }
        } else if (f && f.attrs.t !== undefined && f.attrs.t !== 'normal') {
          fail('XLSX_INVALID', 'array/data-table formulas are not accepted');
        }
        cells.set(c.attrs.r, { ref: c.attrs.r, col: m[1], row: Number(m[2]), type, value, formula, fill: xfFills[style] ?? null });
      }
    }
    for (const dep of pendingShared) {
      const master = masters.get(dep.si);
      const inRange = master && dep.row >= master.range.r1 && dep.row <= master.range.r2 && dep.col >= master.range.c1 && dep.col <= master.range.c2;
      if (!inRange) fail('XLSX_INVALID', 'a shared formula has no master covering it');
      cells.get(dep.ref).formula = shiftFormula(master.text, dep.row - master.row, dep.col - master.col);
    }
    const merges = children(child(sheet, 'mergeCells'), 'mergeCell').map((mc) => mc.attrs.ref);
    const state = s.attrs.state ?? 'visible';
    return { name: s.attrs.name, state, cells, merges };
  });
  if (sheets.length === 0) fail('XLSX_INVALID', 'the workbook has no sheets');
  return { sheets };
}
