import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DIGEST_SCHEME,
  DigestSink,
  FINGERPRINT_SQL,
  ENUM_TYPES,
  PROTECTED_FUNCTION_NAMES,
  PROTECTED_RELATIONS,
  PROTECTED_SEARCH_PATH,
  StateStreamWriter,
  TYPE_CONTRACT_V3,
  proveDomainOnTransaction,
  proveSettingsOnTransaction,
  readStateOnTransaction,
  readProtectedRows,
  relationRowsSql,
  assertLiveTypeContract,
  assertRelationDomainFacts,
  protectedDomainContractSha256,
  type CellText,
  type ContractColumn,
  type EnumTypeFacts,
  type FunctionFacts,
  type LiveColumnRow,
  type LiveRelationDomainRow,
  type ProtectedTx,
  type RelationFacts,
  type StateHeader,
} from '../scripts/local-test-fingerprint.js';
import { classifyStatement } from '../scripts/local-test-runtime.js';

// ---- an INDEPENDENT oracle of FINGERPRINT.md §1–§3 (stream format 3): the module is judged against this, not against itself ----
const u8 = (n: number) => Buffer.from([n]);
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; };
const str = (s: string) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u32(b.length), b]); };
const bytesOf = (b: Buffer) => Buffer.concat([u32(b.length), b]);
const i64b = (t: string) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(t)); return b; };
const i32b = (t: string) => { const b = Buffer.alloc(4); b.writeInt32BE(Number(t)); return b; };

function oField(col: Pick<ContractColumn, 'type' | 'enumType'>, v: CellText): Buffer {
  if (v === null) return u8(0);
  switch (col.type) {
    case 'text': return Buffer.concat([u8(1), u8(0x01), bytesOf(Buffer.from(v, 'utf8'))]);
    case 'int4': return Buffer.concat([u8(1), u8(0x02), bytesOf(i32b(v))]);
    case 'int8': return Buffer.concat([u8(1), u8(0x03), bytesOf(i64b(v))]);
    case 'bool': return Buffer.concat([u8(1), u8(0x04), bytesOf(u8(v === 'true' ? 1 : 0))]);
    case 'tstz': {
      const cls = v === '+infinity' ? 2 : v === '-infinity' ? 3 : 1;
      return Buffer.concat([u8(1), u8(0x05), bytesOf(Buffer.concat([u8(cls), cls === 1 ? i64b(v) : Buffer.alloc(8)]))]);
    }
    case 'enum': {
      const ordinal = ENUM_TYPES.findIndex((e) => e.name === col.enumType);
      return Buffer.concat([u8(1), u8(0x06), bytesOf(Buffer.concat([u16(ordinal), str(v)]))]);
    }
    case 'jsonb': return Buffer.concat([u8(1), u8(0x07), bytesOf(Buffer.from(v, 'utf8'))]);
  }
}
type State = { header: StateHeader; types: EnumTypeFacts[]; functions: FunctionFacts[]; relations: { facts: RelationFacts; rows: CellText[][] }[] };
// metadata (schema-side) bytes versus data bytes: the row count, rows and END marker are data
function oParts(s: State): { full: Buffer; meta: Buffer } {
  const parts: Buffer[] = []; const meta: Buffer[] = [];
  const m = (...b: Buffer[]) => { parts.push(...b); meta.push(...b); };
  const d = (...b: Buffer[]) => { parts.push(...b); };
  m(Buffer.from('MJFP', 'latin1'), u16(3));
  const h = s.header;
  m(str(h.target), str(h.markerId), oField({ type: 'tstz', enumType: null }, h.markerInstalledAt), str(h.serverVersionNum), str(h.searchPath), str(h.serverEncoding), str(h.clientEncoding));
  m(u32(s.types.length));
  for (const t of s.types) { m(str(t.schema), str(t.name), u32(t.labels.length)); for (const l of t.labels) m(str(l)); }
  m(u32(s.functions.length));
  for (const f of s.functions) m(str(f.name), str(f.identityArgs), str(f.returnType), str(f.language), str(f.source), str(f.config), u8(f.securityDefiner ? 1 : 0), str(f.volatility), u8(f.strict ? 1 : 0), str(f.kind));
  m(u32(s.relations.length));
  for (const { facts: r, rows } of s.relations) {
    m(str('public'), str(r.relation), u32(r.columns.length));
    for (const c of r.columns) m(u16(c.attnum), str(c.name), str(c.formatType), u8(c.notNull ? 1 : 0), str(c.defaultExpr ?? ''), str(c.collation ?? ''));
    m(u32(r.pk.length)); for (const k of r.pk) m(u16(k));
    m(u32(r.constraints.length)); for (const c of r.constraints) m(str(c.name), str(c.type), u8(c.validated ? 1 : 0), str(c.definition));
    m(u32(r.indexes.length)); for (const i of r.indexes) m(str(i.name), str(i.definition), u8(i.valid ? 1 : 0), u8(i.ready ? 1 : 0));
    m(u32(r.triggers.length)); for (const t of r.triggers) m(str(t.name), str(t.enabled), str(t.definition));
    m(u32(r.riTriggers.length)); for (const t of r.riTriggers) m(str(t.constraint), u16(t.type), str(t.func), str(t.enabled));
    m(u8(r.rowSecurity ? 1 : 0), u8(r.forceRowSecurity ? 1 : 0), u32(0), u32(0), u32(0), str(r.comment ?? ''));
    d(u64(rows.length));
    const cols = TYPE_CONTRACT_V3.filter((c) => c.relation === r.relation);
    for (const row of rows) { d(u8(0x52)); row.forEach((v, i) => d(oField(cols[i] as ContractColumn, v))); }
  }
  d(Buffer.from('END', 'latin1'));
  return { full: Buffer.concat(parts), meta: Buffer.concat(meta) };
}
const oStream = (s: State): Buffer => oParts(s).full;
const oSchemaDigest = (s: State) => createHash('sha256').update(str(`${DIGEST_SCHEME}/SCHEMA`)).update(oParts(s).meta).digest('hex');
const oDigest = (role: 'PRE' | 'POST', stream: Buffer) => createHash('sha256').update(str(`${DIGEST_SCHEME}/${role}`)).update(stream).digest('hex');

// ---- synthetic state built from the contract ----
const sampleValue = (c: ContractColumn, variant = 0): CellText => {
  switch (c.type) {
    case 'text': return c.pk > 0 ? `id-${c.relation}-${c.name}${variant ? '-m' : ''}` : `v-${c.name}${variant ? '-m' : ''}`;
    case 'int4': return String(1 + variant);
    case 'int8': return String(10 + variant);
    case 'bool': return variant ? 'false' : 'true';
    case 'tstz': return String(1_700_000_000_000_000 + variant);
    case 'enum': return (ENUM_TYPES.find((e) => e.name === c.enumType)?.labels[variant ? 1 : 0]) as string;
    case 'jsonb': return variant ? '{"a": 2}' : '{"a": 1}';
  }
};
const header0: StateHeader = { target: 'mona_local_test@127.0.0.1:5432/mona_local_test', markerId: '11111111-1111-4111-8111-111111111111', markerInstalledAt: '1700000000000000', serverVersionNum: '170004', searchPath: PROTECTED_SEARCH_PATH, serverEncoding: 'UTF8', clientEncoding: 'UTF8' };
const functions0: FunctionFacts[] = PROTECTED_FUNCTION_NAMES.map((name) => ({ name, identityArgs: '', returnType: 'trigger', language: 'plpgsql', source: `BODY ${name}`, config: 'search_path=pg_catalog, pg_temp', securityDefiner: false, volatility: 'v', strict: false, kind: 'f' }));
const factsFor = (relation: string): RelationFacts => {
  const cols = TYPE_CONTRACT_V3.filter((c) => c.relation === relation);
  return {
    relation,
    columns: cols.map((c) => ({ attnum: c.attnum, name: c.name, formatType: c.formatType, notNull: c.notNull, defaultExpr: c.hasDefault ? 'DEFAULT_EXPR' : null, collation: c.type === 'text' ? 'default' : null })),
    pk: cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.attnum),
    constraints: [{ name: `${relation}_pkey`, type: 'p', validated: true, definition: 'PRIMARY KEY (id)' }],
    indexes: [{ name: `${relation}_pkey`, definition: `CREATE UNIQUE INDEX ${relation}_pkey`, valid: true, ready: true }],
    triggers: [], riTriggers: [], rowSecurity: false, forceRowSecurity: false, policies: 0, rules: 0, inheritanceChildren: 0, comment: null,
  };
};
const buildState = (rowOf: (c: ContractColumn) => CellText = (c) => sampleValue(c)): State => ({
  header: header0,
  types: ENUM_TYPES.map((e) => ({ schema: 'public', name: e.name, labels: e.labels })),
  functions: functions0,
  relations: PROTECTED_RELATIONS.map((relation) => ({ facts: factsFor(relation), rows: [TYPE_CONTRACT_V3.filter((c) => c.relation === relation).map(rowOf)] })),
});
function run(state: State, roles: ('PRE' | 'POST')[] = ['PRE', 'POST'], options: { maxRelationBytes?: number } = {}): Record<string, string> {
  const sinks = roles.map((r) => new DigestSink(r));
  const w = new StateStreamWriter(sinks, options);
  w.header(state.header); w.types(state.types); w.functions(state.functions);
  for (const r of state.relations) w.relation(r.facts, r.rows);
  lastSchemaDigest = w.finish();
  return Object.fromEntries(roles.map((r, i) => [r, (sinks[i] as DigestSink).end()]));
}
let lastSchemaDigest: string | void = '';
const sha = (t: string | Buffer) => createHash('sha256').update(t).digest('hex');

describe('type contract and stream encoding (G01–G07, G46, G49, G51)', () => {
  it('AC-152b finish() returns an in-memory schema-only digest: equal for equal metadata whatever the rows, different for any metadata change, and equal to the oracle', () => {
    const base = buildState(); run(base, ['PRE']); const d0 = lastSchemaDigest;
    expect(d0).toMatch(/^[0-9a-f]{64}$/);
    expect(d0).toBe(oSchemaDigest(base));
    run(buildState((c) => sampleValue(c, 1)), ['PRE']);
    expect(lastSchemaDigest).toBe(d0); // rows differ, schema equal
    const mutate = (f: (s: State) => void) => { const s = buildState(); f(s); run(s, ['PRE']); return lastSchemaDigest; };
    const rel = (s: State, n: string) => s.relations.find((r) => r.facts.relation === n) as State['relations'][number];
    const variants = [
      mutate((s) => { const r = rel(s, 'Sale'); r.facts = { ...r.facts, constraints: [{ name: 'Sale_pkey', type: 'p', validated: true, definition: 'X' }] }; }),
      mutate((s) => { const r = rel(s, 'Brand'); r.facts = { ...r.facts, comment: 'c' }; }),
      mutate((s) => { s.types = s.types.map((t, i) => (i === 0 ? { ...t, labels: [...t.labels, 'NEW'] } : t)); }),
      mutate((s) => { s.functions = s.functions.map((f, i) => (i === 0 ? { ...f, source: 'other' } : f)); }),
      mutate((s) => { s.header = { ...s.header, markerId: '33333333-3333-4333-8333-333333333333' }; }),
    ];
    for (const v of variants) expect(v).not.toBe(d0);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('AC-150 TYPE_CONTRACT_V3 is the 172-column / 26-relation / 2-jsonb / 10-enum contract and equals an independent derivation from schema.prisma', () => {
    expect(TYPE_CONTRACT_V3).toHaveLength(172);
    expect(PROTECTED_RELATIONS).toHaveLength(26);
    expect(TYPE_CONTRACT_V3.filter((c) => c.type === 'jsonb')).toHaveLength(2);
    expect(ENUM_TYPES).toHaveLength(10);
    expect(PROTECTED_FUNCTION_NAMES).toHaveLength(3);
    const counts: Record<string, number> = {};
    for (const c of TYPE_CONTRACT_V3) counts[c.type] = (counts[c.type] ?? 0) + 1;
    expect(counts).toEqual({ text: 102, int4: 9, int8: 21, bool: 5, tstz: 21, enum: 12, jsonb: 2 });
    // relations sorted by raw bytes, attnums contiguous from 1, exactly one PK column set per relation
    expect([...PROTECTED_RELATIONS].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))).toEqual([...PROTECTED_RELATIONS]);
    for (const r of PROTECTED_RELATIONS) {
      const cols = TYPE_CONTRACT_V3.filter((c) => c.relation === r);
      expect(cols.map((c) => c.attnum)).toEqual(cols.map((_, i) => i + 1));
      expect(cols.some((c) => c.pk > 0)).toBe(true);
    }
    // independent derivation from schema.prisma: every model field maps to a contract column with the same nullability/type class
    const schema = readFileSync(path.join(__dirname, '..', 'prisma', 'schema.prisma'), 'utf8');
    const enumNames = [...schema.matchAll(/^enum (\w+) \{/gm)].map((m) => m[1] as string);
    expect([...enumNames].sort()).toEqual(ENUM_TYPES.map((e) => e.name).sort());
    const prismaToType: Record<string, string> = { String: 'text', Int: 'int4', BigInt: 'int8', Boolean: 'bool', DateTime: 'tstz', Json: 'jsonb' };
    const modelNames = [...schema.matchAll(/^model (\w+) \{/gm)].map((m) => m[1] as string);
    let checked = 0;
    for (const m of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
      const model = m[1] as string;
      for (const line of (m[2] as string).split('\n')) {
        const f = /^\s{2}(\w+)\s+(\w+)(\?)?(\[\])?\s*(.*)$/.exec(line);
        if (!f || f[4] || line.trim().startsWith('@@') || line.trim().startsWith('//')) continue;
        const [, name, ptype, optional, , rest] = f as unknown as [string, string, string, string | undefined, string | undefined, string];
        if (modelNames.includes(ptype)) continue; // relation field (virtual), not a column
        void rest;
        const col = TYPE_CONTRACT_V3.find((c) => c.relation === model && c.name === name);
        expect(col, `${model}.${name}`).toBeDefined();
        const expectedType = prismaToType[ptype] ?? (enumNames.includes(ptype) ? 'enum' : undefined);
        expect(col?.type, `${model}.${name} type`).toBe(expectedType);
        expect(col?.notNull, `${model}.${name} nullability`).toBe(!optional);
        checked += 1;
      }
    }
    expect(checked).toBe(172 - 8); // every contract column except the 8 Prisma-internal _prisma_migrations columns is a schema.prisma field
  });

  it('AC-150b the migrations the contract was derived from are pinned: a new/changed migration must update the contract and its review', () => {
    const dir = path.join(__dirname, '..', 'prisma', 'migrations');
    const names = readdirSync(dir).filter((d) => /^\d{14}_/.test(d)).sort();
    expect(names).toEqual([
      '20260907015311_init', '20260912182432_add_company_location', '20260912191702_add_user_role_scope',
      '20260922210000_d3_initial_stock_and_global_audit', '20261002120000_block1_pricing_wholesale',
      '20261006120000_pilot_pricing_v2',
    ]);
    const joined = names.map((n) => `${n}:${sha(readFileSync(path.join(dir, n, 'migration.sql')))}`).join('\n');
    expect(sha(joined)).toBe('854c37caef36944848b211824a6d5bfc9027d09c0e75904bc60527c37d2f9552');
  });

  it('AC-136 SQL NULL, empty string and JSON null encode distinctly and boundary bytes cannot shift framing', () => {
    const jsonCol = TYPE_CONTRACT_V3.find((c) => c.relation === 'AuditLog' && c.name === 'before') as ContractColumn;
    const variant = (v: CellText) => run(buildState((c) => (c === jsonCol ? v : sampleValue(c))), ['PRE']).PRE;
    const [a, b, c2, d] = [variant(null), variant('null'), variant('"null"'), variant('')];
    expect(new Set([a, b, c2, d]).size).toBe(4);
    const t1 = TYPE_CONTRACT_V3.find((c) => c.relation === 'Brand' && c.name === 'name') as ContractColumn;
    const user = TYPE_CONTRACT_V3.filter((c) => c.relation === 'User' && c.type === 'text' && c.pk === 0);
    const split = (x: string, y: string) => run(buildState((c) => (c === user[0] ? x : c === user[1] ? y : sampleValue(c))), ['PRE']).PRE;
    expect(split('ab', 'c')).not.toBe(split('a', 'bc'));
    expect(split('a\u0000R', 'b')).not.toBe(split('a', '\u0000Rb'));
    expect(t1).toBeDefined();
  });

  it('AC-137 int8 is exact beyond 2^53 and the digests equal the independent oracle; bad int text is refused', () => {
    const col = TYPE_CONTRACT_V3.find((c) => c.relation === 'CashSession' && c.name === 'startingCash') as ContractColumn;
    const dig = (v: string) => run(buildState((c) => (c === col ? v : sampleValue(c))), ['PRE']).PRE;
    expect(dig('9007199254740993')).not.toBe(dig('9007199254740992'));
    const s = buildState((c) => (c === col ? '9007199254740993' : sampleValue(c)));
    expect(run(s, ['PRE', 'POST'])).toEqual({ PRE: oDigest('PRE', oStream(s)), POST: oDigest('POST', oStream(s)) });
    const int4 = TYPE_CONTRACT_V3.find((c) => c.type === 'int4') as ContractColumn;
    for (const bad of ['2147483648', '-2147483649', '007', '+1', '-0', '', '1.0', ' 1', '1e3']) expect(() => dig4(int4, bad), bad).toThrow();
    for (const bad of ['9223372036854775808', '01', '+5', '-0', 'x']) expect(() => dig(bad), bad).toThrow();
    function dig4(c: ContractColumn, v: string) { return run(buildState((x) => (x === c ? v : sampleValue(x))), ['PRE']); }
  });

  it('AC-138 only the exact texts true/false are accepted for bool', () => {
    const col = TYPE_CONTRACT_V3.find((c) => c.type === 'bool') as ContractColumn;
    const go = (v: string) => run(buildState((c) => (c === col ? v : sampleValue(c))), ['PRE']);
    for (const bad of ['t', 'f', 'TRUE', 'True', '1', '0', '', 'yes']) expect(() => go(bad), bad).toThrow();
    expect(go('true').PRE).not.toBe(go('false').PRE);
  });

  it('AC-139 timestamptz: infinities are distinct classes; decimals and scientific notation are refused', () => {
    const col = TYPE_CONTRACT_V3.find((c) => c.type === 'tstz' && c.relation === 'Company') as ContractColumn;
    const go = (v: string) => run(buildState((c) => (c === col ? v : sampleValue(c))), ['PRE']).PRE;
    expect(new Set([go('+infinity'), go('-infinity'), go('0'), go('1700000000000000'), go('-1')]).size).toBe(5);
    for (const bad of ['1.7e15', '1.5', '1700000000000000.0', '', 'infinity', 'NaN', '9223372036854775808']) expect(() => go(bad), bad).toThrow();
  });

  it('AC-140 rows must be strictly ascending in raw UTF-8 byte order (unsorted, duplicate, UTF-16 trap, prefix keys)', () => {
    const rel = 'Brand';
    const cols = TYPE_CONTRACT_V3.filter((c) => c.relation === rel);
    const mk = (keys: string[]) => {
      const s = buildState();
      const target = s.relations.find((r) => r.facts.relation === rel) as State['relations'][number];
      target.rows = keys.map((k) => cols.map((c) => (c.pk > 0 ? k : sampleValue(c))));
      return s;
    };
    expect(() => run(mk(['b', 'a']))).toThrow();
    expect(() => run(mk(['a', 'a']))).toThrow();
    expect(() => run(mk(['ab', 'a']))).toThrow();
    expect(() => run(mk(['a', 'ab', 'b']))).not.toThrow();
    // U+FFFD (EF BF BD) sorts BEFORE U+1F600 (F0 9F 98 80) in UTF-8 bytes, but AFTER it in JS UTF-16 order
    expect(() => run(mk(['\u{1F600}', '�']))).toThrow();
    expect(() => run(mk(['�', '\u{1F600}']))).not.toThrow();
  });

  it('AC-136b a lone surrogate (lossy in UTF-8) is refused in text and jsonb instead of being silently replaced', () => {
    const text = TYPE_CONTRACT_V3.find((c) => c.relation === 'Brand' && c.name === 'name') as ContractColumn;
    const json = TYPE_CONTRACT_V3.find((c) => c.relation === 'AuditLog' && c.name === 'before') as ContractColumn;
    for (const col of [text, json]) {
      expect(() => run(buildState((c) => (c === col ? 'a\uD800b' : sampleValue(c))), ['PRE']), col.name).toThrow();
    }
  });

  it('AC-151b the writer itself refuses a relation reporting RLS, policies, rules or inheritance children', () => {
    for (const patch of [{ rowSecurity: true }, { forceRowSecurity: true }, { policies: 1 }, { rules: 1 }, { inheritanceChildren: 1 }]) {
      const s = buildState();
      const r = s.relations.find((x) => x.facts.relation === 'Sale') as State['relations'][number];
      r.facts = { ...r.facts, ...patch };
      expect(() => run(s, ['PRE']), JSON.stringify(patch)).toThrow();
    }
  });

  it('AC-141 DigestSink: any chunking of write() yields the same digest', () => {
    const bytes = oStream(buildState());
    const whole = new DigestSink('PRE'); whole.write(bytes);
    const pieces = new DigestSink('PRE');
    for (let i = 0; i < bytes.length; i += 97) pieces.write(bytes.subarray(i, i + 97));
    const one = new DigestSink('PRE'); for (const b of bytes) one.write(Uint8Array.of(b));
    const d = whole.end();
    expect(pieces.end()).toBe(d);
    expect(one.end()).toBe(d);
    expect(d).toBe(oDigest('PRE', bytes));
  });

  it('AC-142 PRE and POST digests of one stream differ by label only, and a forged fPost = D_pre(Q) is not a POST digest', () => {
    const s = buildState(); const d = run(s, ['PRE', 'POST']);
    expect(d.PRE).not.toBe(d.POST);
    expect(d.POST).toBe(oDigest('POST', oStream(s)));
    expect(d.PRE).toBe(oDigest('PRE', oStream(s)));
    expect(sha(oStream(s))).not.toBe(d.PRE); // unlabelled digest is neither
  });

  it('AC-143 DigestSink exposes only write/end, is single use, and no accessor reaches the bytes', () => {
    const sink = new DigestSink('POST');
    expect(Object.getOwnPropertyNames(sink)).toEqual([]);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(sink)).sort()).toEqual(['constructor', 'end', 'write']);
    expect(JSON.stringify(sink)).toBe('{}');
    sink.write(Buffer.from('x'));
    const digest = sink.end();
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(() => sink.end()).toThrow();
    expect(() => sink.write(Buffer.from('y'))).toThrow();
    expect(() => new DigestSink('MID' as never)).toThrow();
  });

  it('AC-144 mutating any single one of the 172 columns changes both digests', () => {
    const base = run(buildState());
    let n = 0;
    for (const col of TYPE_CONTRACT_V3) {
      const mutated = run(buildState((c) => (c === col ? sampleValue(c, 1) : sampleValue(c))));
      expect(mutated.PRE, `${col.relation}.${col.name} PRE`).not.toBe(base.PRE);
      expect(mutated.POST, `${col.relation}.${col.name} POST`).not.toBe(base.POST);
      n += 1;
    }
    expect(n).toBe(172);
  });

  it('AC-145 every header field changes both digests; a wrong search_path or encoding is refused', () => {
    const base = run(buildState());
    const variants: Partial<StateHeader>[] = [{ markerId: '22222222-2222-4222-8222-222222222222' }, { markerInstalledAt: '1700000000000001' }, { serverVersionNum: '170005' }, { target: 'mona_local_test@127.0.0.1:5432/other' }];
    for (const v of variants) {
      const s = buildState(); s.header = { ...s.header, ...v };
      const d = run(s);
      expect(d.PRE).not.toBe(base.PRE); expect(d.POST).not.toBe(base.POST);
    }
    for (const bad of [{ searchPath: 'public, pg_catalog' }, { serverEncoding: 'LATIN1' }, { clientEncoding: 'SQL_ASCII' }]) {
      const s = buildState(); s.header = { ...s.header, ...bad };
      expect(() => run(s)).toThrow();
    }
  });

  it('AC-146 a relation larger than the per-relation byte cap stops the fingerprint', () => {
    expect(() => run(buildState(), ['PRE'], { maxRelationBytes: 64 })).toThrow();
    expect(() => run(buildState(), ['PRE'], { maxRelationBytes: 1_000_000 })).not.toThrow();
  });

  it('AC-149 jsonb: SQL NULL, JSON null and the string "null" are distinct fields, and the module digest equals the oracle for each', () => {
    const jsonCol = TYPE_CONTRACT_V3.find((c) => c.relation === 'AuditLog' && c.name === 'after') as ContractColumn;
    const digests = [null, 'null', '"null"'].map((v) => {
      const s = buildState((c) => (c === jsonCol ? v : sampleValue(c)));
      const d = run(s, ['POST']).POST;
      expect(d).toBe(oDigest('POST', oStream(s)));
      return d;
    });
    expect(new Set(digests).size).toBe(3);
    expect(oField({ type: 'jsonb', enumType: null }, null).toString('hex')).toBe('00');
  });

  it('AC-152 each schema component mutation changes the digest (constraint, index, trigger, default, collation, enum, function, comment)', () => {
    const base = run(buildState());
    const mut = (f: (s: State) => void) => { const s = buildState(); f(s); return run(s); };
    const rel = (s: State, name: string) => s.relations.find((r) => r.facts.relation === name) as State['relations'][number];
    const withFacts = (s: State, name: string, patch: Partial<RelationFacts>) => { const r = rel(s, name); r.facts = { ...r.facts, ...patch }; };
    const cases: Record<string, (s: State) => void> = {
      constraintDef: (s) => withFacts(s, 'Sale', { constraints: [{ name: 'Sale_pkey', type: 'p', validated: true, definition: 'PRIMARY KEY (id, x)' }] }),
      constraintValidated: (s) => withFacts(s, 'Sale', { constraints: [{ name: 'Sale_pkey', type: 'p', validated: false, definition: 'PRIMARY KEY (id)' }] }),
      indexDef: (s) => withFacts(s, 'Sale', { indexes: [{ name: 'Sale_pkey', definition: 'CREATE UNIQUE INDEX other', valid: true, ready: true }] }),
      indexValid: (s) => withFacts(s, 'Sale', { indexes: [{ name: 'Sale_pkey', definition: 'CREATE UNIQUE INDEX Sale_pkey', valid: false, ready: true }] }),
      triggerAdded: (s) => withFacts(s, 'SalePayment', { triggers: [{ name: 't', enabled: 'O', definition: 'CREATE TRIGGER t' }] }),
      riTrigger: (s) => withFacts(s, 'SaleItem', { riTriggers: [{ constraint: 'c', type: 5, func: 'RI_FKey_check_ins', enabled: 'O' }] }),
      defaultExpr: (s) => { const r = rel(s, 'Sale'); r.facts = { ...r.facts, columns: r.facts.columns.map((c) => (c.defaultExpr ? { ...c, defaultExpr: 'OTHER' } : c)) }; },
      collation: (s) => { const r = rel(s, 'Brand'); r.facts = { ...r.facts, columns: r.facts.columns.map((c) => (c.collation ? { ...c, collation: 'C' } : c)) }; },
      comment: (s) => withFacts(s, 'Brand', { comment: 'a table comment' }),
      enumLabel: (s) => { s.types = s.types.map((t, i) => (i === 0 ? { ...t, labels: [...t.labels.slice(0, -1), 'RENAMED'] } : t)); },
      funcBody: (s) => { s.functions = s.functions.map((f, i) => (i === 0 ? { ...f, source: f.source + ' ' } : f)); },
      funcConfig: (s) => { s.functions = s.functions.map((f, i) => (i === 0 ? { ...f, config: '' } : f)); },
      funcSecdef: (s) => { s.functions = s.functions.map((f, i) => (i === 0 ? { ...f, securityDefiner: true } : f)); },
    };
    for (const [name, f] of Object.entries(cases)) {
      const d = mut(f);
      expect(d.PRE, name).not.toBe(base.PRE); expect(d.POST, name).not.toBe(base.POST);
    }
    // oracle equality for the richest case
    const s = buildState(); cases.triggerAdded?.(s); cases.riTrigger?.(s);
    expect(run(s).PRE).toBe(oDigest('PRE', oStream(s)));
  });

  it('AC-151 a relation that is not an ordinary logged unpartitioned table without RLS/rules/inheritance owned by the current user stops the run', () => {
    const ok: LiveRelationDomainRow = { relname: 'Brand', relkind: 'r', persistence: 'p', isPartition: false, hasSubclass: false, inheritanceRows: 0, rowSecurity: false, forceRowSecurity: false, hasRules: false, ownerIsCurrentUser: true, policies: 0 };
    const all = PROTECTED_RELATIONS.map((r) => ({ ...ok, relname: r }));
    expect(() => assertRelationDomainFacts(all)).not.toThrow();
    for (const patch of [{ relkind: 'v' }, { relkind: 'p' }, { persistence: 'u' }, { persistence: 't' }, { isPartition: true }, { hasSubclass: true }, { inheritanceRows: 1 }, { rowSecurity: true }, { forceRowSecurity: true }, { hasRules: true }, { ownerIsCurrentUser: false }, { policies: 1 }]) {
      expect(() => assertRelationDomainFacts(all.map((r, i) => (i === 3 ? { ...r, ...patch } : r))), JSON.stringify(patch)).toThrow();
    }
    expect(() => assertRelationDomainFacts(all.slice(1))).toThrow(); // a relation missing
    expect(() => assertRelationDomainFacts([...all, { ...ok, relname: 'Extra' }])).toThrow(); // an extra relation
  });
});

describe('live type contract (G02, AC-147)', () => {
  const live = (): LiveColumnRow[] => TYPE_CONTRACT_V3.map((c) => ({
    relname: c.relation, attnum: c.attnum, attname: c.name, formatType: c.formatType, notNull: c.notNull, hasDefault: c.hasDefault, defaultExpr: c.hasDefault ? 'X' : null,
    generated: '', identity: '', collation: c.type === 'text' ? 'default' : null,
    typtype: c.type === 'enum' ? 'e' : 'b', typnsp: c.type === 'enum' ? 'public' : 'pg_catalog', typname: c.type === 'enum' ? (c.enumType as string) : 'x',
  }));
  it('the exact live metadata passes', () => { expect(() => assertLiveTypeContract(live())).not.toThrow(); });
  it('AC-147 an unsupported type, an extra/missing column, or drifted nullability/default/format/generation stops before any byte is hashed', () => {
    const base = live();
    const mutations: Record<string, (rows: LiveColumnRow[]) => LiveColumnRow[]> = {
      missing: (r) => r.slice(1),
      extra: (r) => [...r, { ...(r[0] as LiveColumnRow), attnum: 99, attname: 'extra' }],
      formatType: (r) => r.map((x, i) => (i === 0 ? { ...x, formatType: 'numeric' } : x)),
      unsupportedFormat: (r) => r.map((x, i) => (i === 5 ? { ...x, formatType: 'real' } : x)),
      nullability: (r) => r.map((x, i) => (i === 2 ? { ...x, notNull: !x.notNull } : x)),
      hasDefault: (r) => r.map((x, i) => (i === 8 ? { ...x, hasDefault: !x.hasDefault } : x)),
      generated: (r) => r.map((x, i) => (i === 1 ? { ...x, generated: 's' } : x)),
      identity: (r) => r.map((x, i) => (i === 1 ? { ...x, identity: 'a' } : x)),
      renamedColumn: (r) => r.map((x, i) => (i === 4 ? { ...x, attname: 'renamed' } : x)),
      attnumGap: (r) => r.map((x, i) => (i === 6 ? { ...x, attnum: x.attnum + 1 } : x)),
      enumNamespace: (r) => r.map((x) => (x.typtype === 'e' ? { ...x, typnsp: 'other' } : x)),
      relationExtra: (r) => [...r, { ...(r[0] as LiveColumnRow), relname: 'Intruder' }],
    };
    for (const [name, f] of Object.entries(mutations)) expect(() => assertLiveTypeContract(f(base)), name).toThrow();
  });
  it('the domain contract digest is the sha256 of the canonical contract text and is stable', () => {
    const a = protectedDomainContractSha256(); const b = protectedDomainContractSha256();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(sha(JSON.stringify({ relations: PROTECTED_RELATIONS, columns: TYPE_CONTRACT_V3.map((c) => [c.relation, c.attnum, c.name, c.type, c.formatType, c.notNull, c.hasDefault, c.enumType, c.pk]), enums: ENUM_TYPES.map((e) => [e.name, e.labels]), functions: PROTECTED_FUNCTION_NAMES })));
  });
});


// ---- SQL readers over a fake transaction (statement text, qualification, and digest equality with the oracle) ----
type Row = Record<string, string | null>;
const TSTZ_COLUMNS = (rel: string) => TYPE_CONTRACT_V3.filter((c) => c.relation === rel);
function fakeReaderTx(state: State, over: { settings?: Record<string, string>; ownTemp?: Row; extras?: string; domainPatch?: Partial<Row>; throwOn?: string } = {}) {
  const statements: string[] = [];
  const t = (b: boolean) => (b ? 'true' : 'false');
  const settings: Record<string, string> = { search_path: PROTECTED_SEARCH_PATH, transaction_isolation: 'read committed', server_encoding: 'UTF8', client_encoding: 'UTF8', session_replication_role: 'origin', standard_conforming_strings: 'on', synchronous_commit: 'on', fsync: 'on', TimeZone: 'UTC', lock_timeout: '10000', statement_timeout: '120000', idle_in_transaction_session_timeout: '180000', ...over.settings };
  const liveColumns = (): Row[] => TYPE_CONTRACT_V3.map((c) => {
    const f = state.relations.find((r) => r.facts.relation === c.relation)?.facts.columns.find((x) => x.attnum === c.attnum);
    return { relname: c.relation, attnum: String(c.attnum), attname: c.name, format_type: c.formatType, not_null: t(c.notNull), has_default: t(c.hasDefault), default_expr: f?.defaultExpr ?? null, generated: '', identity: '', collation: f?.collation ?? null, typtype: c.type === 'enum' ? 'e' : 'b', typnsp: c.type === 'enum' ? 'public' : 'pg_catalog', typname: c.type === 'enum' ? (c.enumType as string) : 'x' };
  });
  const answer = (sql: string): Row[] => {
    if (over.throwOn && sql === FINGERPRINT_SQL[over.throwOn]) throw Object.assign(new Error(`detail ${CANARY_TEXT}`), { code: '42P01' });
    const key = Object.entries(FINGERPRINT_SQL).find(([, v]) => v === sql)?.[0];
    switch (key) {
      case 'settings': return Object.entries(settings).map(([name, setting]) => ({ name, setting }));
      case 'ownTemp': return [over.ownTemp ?? { temp_classes: '0', temp_types: '0' }];
      case 'extraRelations': return [{ extra_relations: over.extras ?? '0' }];
      case 'domain': return state.relations.map((r) => ({ relname: r.facts.relation, relkind: 'r', persistence: 'p', is_partition: 'false', has_subclass: 'false', inheritance_rows: '0', row_security: t(r.facts.rowSecurity), force_row_security: t(r.facts.forceRowSecurity), has_rules: 'false', owner_is_current_user: 'true', policies: String(r.facts.policies), ...over.domainPatch }));
      case 'columns': return liveColumns();
      case 'marker': return [{ marker_id: state.header.markerId, installed_at: state.header.markerInstalledAt, server_version_num: state.header.serverVersionNum, search_path: state.header.searchPath, server_encoding: state.header.serverEncoding, client_encoding: state.header.clientEncoding }];
      case 'enums': return state.types.flatMap((e) => e.labels.map((label) => ({ nspname: e.schema, typname: e.name, label })));
      case 'functions': return state.functions.map((f) => ({ proname: f.name, identity_args: f.identityArgs, return_type: f.returnType, language: f.language, source: f.source, config: f.config, security_definer: t(f.securityDefiner), volatility: f.volatility, strict: t(f.strict), kind: f.kind }));
      case 'primaryKeys': return state.relations.flatMap((r) => r.facts.pk.map((attnum, i) => ({ relname: r.facts.relation, attnum: String(attnum), ord: String(i + 1) })));
      case 'constraints': return state.relations.flatMap((r) => r.facts.constraints.map((c) => ({ relname: r.facts.relation, conname: c.name, contype: c.type, validated: t(c.validated), definition: c.definition })));
      case 'indexes': return state.relations.flatMap((r) => r.facts.indexes.map((i) => ({ relname: r.facts.relation, indexname: i.name, definition: i.definition, valid: t(i.valid), ready: t(i.ready) })));
      case 'triggers': return state.relations.flatMap((r) => r.facts.triggers.map((x) => ({ relname: r.facts.relation, tgname: x.name, enabled: x.enabled, definition: x.definition })));
      case 'riTriggers': return state.relations.flatMap((r) => r.facts.riTriggers.map((x) => ({ relname: r.facts.relation, conname: x.constraint, tgtype: String(x.type), func: x.func, enabled: x.enabled })));
      case 'comments': return state.relations.map((r) => ({ relname: r.facts.relation, comment: r.facts.comment }));
      default: {
        const rel = state.relations.find((r) => relationRowsSql(r.facts.relation) === sql);
        if (!rel) throw new Error('unexpected statement');
        return rel.rows.map((row) => Object.fromEntries(row.map((v, i) => [`c${i + 1}`, v])));
      }
    }
  };
  return { statements, $queryRawUnsafe: async (sql: string) => { statements.push(sql); return answer(sql); } };
}
const CANARY_TEXT = 'CANARY_PASSWORD_HASH_DO_NOT_LEAK';
const asTx = (x: object) => x as unknown as ProtectedTx;

describe('SQL readers (G08 qualification, G05, G20, G42, G53)', () => {
  it('AC-109 the settings proof accepts the reviewed settings and refuses a drifted search_path, isolation, encoding, replication role, synchronous_commit, fsync or timeout', async () => {
    const state = buildState();
    await expect(proveSettingsOnTransaction(asTx(fakeReaderTx(state)))).resolves.toBeUndefined();
    const drift: Record<string, string>[] = [
      { search_path: 'public, pg_catalog' }, { search_path: 'pg_catalog, pg_temp, public' }, { transaction_isolation: 'repeatable read' }, { server_encoding: 'LATIN1' }, { client_encoding: 'SQL_ASCII' },
      { session_replication_role: 'replica' }, { standard_conforming_strings: 'off' }, { synchronous_commit: 'off' }, { synchronous_commit: 'local' }, { fsync: 'off' },
      { lock_timeout: '0' }, { statement_timeout: '0' }, { idle_in_transaction_session_timeout: '0' }, { TimeZone: 'Europe/Madrid' }, { TimeZone: 'UTC+01' },
    ];
    for (const d of drift) await expect(proveSettingsOnTransaction(asTx(fakeReaderTx(state, { settings: d }))), JSON.stringify(d)).rejects.toThrow();
  });

  it('AC-113 a missing setting row is a refusal, not a pass', async () => {
    const tx = fakeReaderTx(buildState());
    const real = tx.$queryRawUnsafe;
    tx.$queryRawUnsafe = async (sql: string) => (sql === FINGERPRINT_SQL.settings ? (await real(sql)).filter((r) => r.name !== 'synchronous_commit') : real(sql));
    await expect(proveSettingsOnTransaction(asTx(tx))).rejects.toThrow();
  });

  it('AC-109 the domain proof refuses a non-empty own temp schema BEFORE reading anything else', async () => {
    const state = buildState();
    const tx = fakeReaderTx(state, { ownTemp: { temp_classes: '1', temp_types: '0' } });
    await expect(proveDomainOnTransaction(asTx(tx))).rejects.toThrow();
    expect(tx.statements).toEqual([FINGERPRINT_SQL.ownTemp]);
    for (const ownTemp of [{ temp_classes: '0', temp_types: '2' }, { temp_classes: 'x', temp_types: '0' }]) {
      await expect(proveDomainOnTransaction(asTx(fakeReaderTx(state, { ownTemp })))).rejects.toThrow();
    }
  });

  it('AC-151/147 the domain proof refuses an extra relation in public, a non-ordinary relation, and live type drift; it accepts the reviewed domain', async () => {
    const state = buildState();
    await expect(proveDomainOnTransaction(asTx(fakeReaderTx(state)))).resolves.toBeUndefined();
    await expect(proveDomainOnTransaction(asTx(fakeReaderTx(state, { extras: '1' })))).rejects.toThrow();
    await expect(proveDomainOnTransaction(asTx(fakeReaderTx(state, { domainPatch: { relkind: 'p' } })))).rejects.toThrow();
    await expect(proveDomainOnTransaction(asTx(fakeReaderTx(state, { domainPatch: { owner_is_current_user: 'false' } })))).rejects.toThrow();
    const drifted = fakeReaderTx(state); const real = drifted.$queryRawUnsafe;
    drifted.$queryRawUnsafe = async (sql: string) => (sql === FINGERPRINT_SQL.columns ? (await real(sql)).slice(1) : real(sql));
    await expect(proveDomainOnTransaction(asTx(drifted))).rejects.toThrow();
  });

  it('AC-110 every statement is a read, uses only qualified relations, and projects every protected column as server-side text', async () => {
    const state = buildState(); const tx = fakeReaderTx(state);
    await proveSettingsOnTransaction(asTx(tx)); await proveDomainOnTransaction(asTx(tx));
    await readStateOnTransaction(asTx(tx), [new DigestSink('PRE')], false);
    expect(tx.statements.length).toBeGreaterThan(30);
    for (const sql of tx.statements) {
      expect(classifyStatement(sql), sql.slice(0, 60)).toBe('read');
      for (const m of sql.matchAll(/(?<!EPOCH )\b(?:FROM|JOIN)\s+(ONLY\s+)?([^\s,()]+)/gi)) {
        const target = m[2] as string;
        expect(/^(pg_catalog\.|public\."|mona_local_test_guard\.|LATERAL$)/i.test(target), `${target} in ${sql.slice(0, 50)}`).toBe(true);
      }
      expect(sql).not.toMatch(/\bset_config\b|\$\d/i);
    }
    for (const relation of PROTECTED_RELATIONS) {
      const sql = relationRowsSql(relation);
      expect(sql, relation).toContain(`FROM ONLY public."${relation}"`);
      const projections = TSTZ_COLUMNS(relation);
      for (const c of projections) {
        expect(sql, `${relation}.${c.name}`).toContain(`"${c.name}"`);
        if (c.type === 'tstz') expect(sql).toContain(`EXTRACT(EPOCH FROM "${c.name}")`);
      }
      expect(sql).toMatch(/ORDER BY ("[^"]+" COLLATE "C"(, )?)+$/);
    }
  });

  it('AC-147 readState refuses live column drift or an out-of-domain relation BEFORE the first stream byte is produced', async () => {
    const state = buildState();
    for (const mutate of ['columns', 'domain'] as const) {
      const tx = fakeReaderTx(state); const real = tx.$queryRawUnsafe;
      tx.$queryRawUnsafe = async (sql: string) => {
        const rows = await real(sql);
        if (sql !== FINGERPRINT_SQL[mutate]) return rows;
        return mutate === 'columns' ? rows.slice(1) : rows.map((r, i) => (i === 0 ? { ...r, relkind: 'v' } : r));
      };
      const sink = new DigestSink('PRE'); let writes = 0; const write = sink.write.bind(sink);
      sink.write = (chunk: Uint8Array) => { writes += 1; write(chunk); };
      await expect(readStateOnTransaction(asTx(tx), [sink], false), mutate).rejects.toThrow();
      expect(writes, mutate).toBe(0);
    }
  });

  it('AC-151 the out-of-contract relation check names exactly the 26 protected relations and every kind of relation object', () => {
    const sql = FINGERPRINT_SQL.extraRelations as string;
    for (const relation of PROTECTED_RELATIONS) expect(sql).toContain(`'${relation}'`);
    expect(sql).toMatch(/relkind IN \('r', 'p', 'v', 'm', 'f', 'S', 'c'\)/);
    expect(sql).toContain("n.nspname = 'public'");
    for (const key of ['domain', 'columns', 'primaryKeys', 'constraints', 'indexes', 'triggers', 'riTriggers', 'comments']) {
      for (const relation of PROTECTED_RELATIONS) expect(FINGERPRINT_SQL[key], `${key}:${relation}`).toContain(`'${relation}'`);
    }
  });

  it('raw read adapter rejects invalid structured specs before any raw statement reaches the reader', async () => {
    const tx = fakeReaderTx(buildState());
    await expect(readProtectedRows(asTx(tx), { kind: 'relationRows', relation: 'Intruder' })).rejects.toThrow();
    await expect(readProtectedRows(asTx(tx), { kind: 'unknown' } as never)).rejects.toThrow();
    expect(tx.statements).toEqual([]);
  });

  it('AC-123 readStateOnTransaction streams the whole state into the sinks exactly as the oracle encodes it, and returns rows only when asked', async () => {
    const state = buildState();
    const pre = new DigestSink('PRE'); const post = new DigestSink('POST');
    const result = await readStateOnTransaction(asTx(fakeReaderTx(state)), [pre, post], true);
    expect(pre.end()).toBe(oDigest('PRE', oStream(state)));
    expect(post.end()).toBe(oDigest('POST', oStream(state)));
    expect(result.serverVersionNum).toBe('170004');
    expect(result.markerId).toBe(header0.markerId);
    expect(result.rows?.size).toBe(26);
    expect(result.schemaDigest).toBe(oSchemaDigest(state));
    expect(result.rows?.get('User')).toEqual(state.relations.find((r) => r.facts.relation === 'User')?.rows);
    const none = await readStateOnTransaction(asTx(fakeReaderTx(state)), [new DigestSink('PRE')], false);
    expect(none.rows).toBeNull();
  });

  it('AC-125 a reader failure surfaces only a constant message: no statement text, parameter or driver detail', async () => {
    const state = buildState();
    for (const key of ['marker', 'enums', 'functions', 'columns']) {
      const error = await readStateOnTransaction(asTx(fakeReaderTx(state, { throwOn: key })), [new DigestSink('PRE')], false).then(() => null, (e: Error) => e);
      expect(error, key).not.toBeNull();
      expect(JSON.stringify([error?.message, error?.stack, Object.getOwnPropertyNames(error as object)])).not.toContain(CANARY_TEXT);
      expect((error as { cause?: unknown }).cause).toBeUndefined();
    }
  });

  it('AC-148 a cell that is neither a string nor NULL (driver conversion drift) stops the read', async () => {
    const state = buildState(); const tx = fakeReaderTx(state); const real = tx.$queryRawUnsafe;
    tx.$queryRawUnsafe = async (sql: string) => {
      const rows = await real(sql);
      return sql === relationRowsSql('Brand') ? rows.map((r) => ({ ...r, c2: 5 as unknown as string })) : rows;
    };
    await expect(readStateOnTransaction(asTx(tx), [new DigestSink('PRE')], false)).rejects.toThrow();
  });
});
