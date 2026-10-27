// PILOT G11 cut-over: the canonical APP-OWNED schema projection and its digest, shared by
// pilot-migrate (pre/post), pilot-a4-readonly, pilot-clone-restore (restore proof and the
// migration rehearsal) and pilot-schema-reference (the mechanical reference generator).
// Builtins only (node:crypto), no I/O of its own: the caller supplies a connected client.
//
// APP_OWNED (the definition every PILOT tool shares): an object is app-owned when it lives in
// schema public AND no extension owns it (no pg_depend deptype 'e' row) AND it is of a kind the
// migrations create — an ordinary/partitioned table other than the _prisma_migrations ledger
// (with its columns, constraints, indexes and non-internal triggers), an enum or other user type,
// or a function/procedure. Everything else is provider-owned or out of contract BY THAT RULE
// (schemas auth/storage/extensions/graphql/realtime/vault/the marker schemas, extension members,
// views, sequences, RLS, ownership, grants, comments) — never because an object is unknown: an
// unknown object that satisfies the rule IS projected and changes the digest.
//
// Canonical text (v2): expression texts PostgreSQL deparses (CHECK/FK/PK/UNIQUE definitions,
// index definitions with their predicates, trigger definitions, column defaults) are tokenized
// (quoted literals and identifiers opaque) and re-joined with single spaces, and an AND (or OR)
// chain nested as a direct operand of the same operator is flattened — associativity only, never
// commutativity, never across NOT/a function call/a mixed AND-OR level. A dump/restore round trip
// re-parses `((A AND B) AND C)` (what BETWEEN leaves in a Prisma-created CHECK) as `(A AND B AND C)`;
// both are one canonical text. Anything else that differs still changes the digest.
//
// What is projected — the objects Mona Jacinta's migrations own in schema public:
//   tables (relkind r/p, except Prisma's _prisma_migrations ledger, verified separately)
//   with every column's name, formatted type, NOT NULL, default, identity and generated
//   kind; enums with their labels in sort order; other standalone user types (domains,
//   composites, ranges — expected none); every PK/FK/UNIQUE/CHECK/EXCLUDE constraint with
//   pg_get_constraintdef and its validated flag; every index with pg_get_indexdef and its
//   validity; app functions/procedures with the SHA-256 of pg_get_functiondef; and every
//   non-internal trigger with pg_get_triggerdef and its enabled state.
// What is NOT projected, by construction of the SQL (never filtered afterwards):
//   anything outside schema public (Supabase's auth/storage/extensions/graphql/realtime/
//   vault schemas, the PILOT marker schema), anything owned by an extension (pg_depend
//   deptype 'e'), views/materialized views/sequences/foreign tables, RLS flags and policies,
//   ownership, privileges and comments. Those are provider metadata, not app schema.
//
// Determinism: pg_get_*def and format_type qualify names relative to the READER's
// search_path, so readProjection first proves search_path = 'pg_catalog, pg_temp' (every
// PILOT tool pins exactly that) and refuses otherwise. Rows are sorted in JavaScript; the
// database never orders, groups or compares. The digest is SHA-256 over a canonical JSON
// (keys sorted at every depth) of the projection.
import { createHash } from 'node:crypto';

export const PROJECTION_FORMAT = 'mona-app-schema-projection/v2';
export const PINNED_SEARCH_PATH = 'pg_catalog, pg_temp';

const NOT_EXTENSION = (catalog, oid) => `NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d WHERE d.classid = '${catalog}'::pg_catalog.regclass AND d.objid = ${oid} AND d.deptype = 'e')`;
const APP_TABLE = `n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> '_prisma_migrations' AND ${NOT_EXTENSION('pg_catalog.pg_class', 'c.oid')}`;
const FROM_TABLE = 'pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace';

export const PROJECTION_SQL = Object.freeze({
  searchPath: "SELECT pg_catalog.current_setting('search_path') AS search_path",
  tables: `SELECT c.relname AS "table" FROM ${FROM_TABLE} WHERE ${APP_TABLE}`,
  columns: 'SELECT c.relname AS "table", a.attname AS "column", pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, '
    + 'a.attnotnull AS not_null, pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr, a.attidentity::text AS identity, '
    + `a.attgenerated::text AS generated FROM pg_catalog.pg_attribute a JOIN ${FROM_TABLE} ON c.oid = a.attrelid `
    + 'LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum '
    + `WHERE a.attnum > 0 AND NOT a.attisdropped AND ${APP_TABLE}`,
  enums: 'SELECT t.typname AS type, e.enumlabel AS label, e.enumsortorder::text AS sort_order FROM pg_catalog.pg_enum e '
    + 'JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace '
    + `WHERE n.nspname = 'public' AND ${NOT_EXTENSION('pg_catalog.pg_type', 't.oid')}`,
  types: 'SELECT t.typname AS type, t.typtype::text AS kind FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace '
    + "WHERE n.nspname = 'public' AND t.typtype IN ('b', 'c', 'd', 'r', 'm') AND t.typcategory <> 'A' "
    + "AND NOT (t.typtype = 'c' AND EXISTS (SELECT 1 FROM pg_catalog.pg_class r WHERE r.oid = t.typrelid AND r.relkind <> 'c')) "
    + `AND ${NOT_EXTENSION('pg_catalog.pg_type', 't.oid')}`,
  constraints: 'SELECT c.relname AS "table", con.conname AS name, con.contype::text AS type, '
    + 'pg_catalog.pg_get_constraintdef(con.oid) AS definition, con.convalidated AS validated '
    + `FROM pg_catalog.pg_constraint con JOIN ${FROM_TABLE} ON c.oid = con.conrelid `
    + `WHERE con.contype IN ('p', 'f', 'u', 'c', 'x') AND ${APP_TABLE}`,
  indexes: 'SELECT c.relname AS "table", i.relname AS name, pg_catalog.pg_get_indexdef(x.indexrelid) AS definition, x.indisvalid AS valid '
    + `FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid JOIN ${FROM_TABLE} ON c.oid = x.indrelid `
    + `WHERE ${APP_TABLE}`,
  functions: 'SELECT p.proname AS name, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args, p.prokind::text AS kind, '
    + 'pg_catalog.pg_get_functiondef(p.oid) AS definition FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace '
    + `WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND ${NOT_EXTENSION('pg_catalog.pg_proc', 'p.oid')}`,
  triggers: 'SELECT c.relname AS "table", t.tgname AS name, pg_catalog.pg_get_triggerdef(t.oid) AS definition, t.tgenabled::text AS enabled '
    + `FROM pg_catalog.pg_trigger t JOIN ${FROM_TABLE} ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND ${APP_TABLE}`,
});

const fail = (what) => { throw new Error(`projection: ${what}`); };
const str = (v, what) => (typeof v === 'string' && v.length > 0 ? v : fail(`${what} is malformed`));
const optStr = (v, what) => (v === null || typeof v === 'string' ? v : fail(`${what} is malformed`));
const bool = (v, what) => (typeof v === 'boolean' ? v : fail(`${what} is malformed`));
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byKeys = (...keys) => (a, b) => keys.reduce((r, k) => r || cmp(a[k], b[k]), 0);
const rowsOf = (raw, key) => (Array.isArray(raw?.[key]) ? raw[key] : fail(`${key} could not be read`));

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Pure: raw catalog rows (PROJECTION_SQL shapes) -> the canonical projection. Throws on any
// malformed row, duplicate object or column of an unknown table.
// ---------------- canonical expression text ----------------
function tokenizeSql(text) {
  const out = []; let i = 0; const s = String(text);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= s.length) fail('unterminated quoted text in a definition');
        if (s[j] === ch) { if (s[j + 1] === ch) { j += 2; continue; } break; }
        j += 1;
      }
      out.push({ t: 'q', v: s.slice(i, j + 1) }); i = j + 1; continue;
    }
    if ('(),[]'.includes(ch)) { out.push({ t: ch, v: ch }); i += 1; continue; }
    const word = /^[A-Za-z0-9_$]+/.exec(s.slice(i));
    if (word) { out.push({ t: 'w', v: word[0] }); i += word[0].length; continue; }
    const op = /^[+\-*/<>=~!@#%^&|`?:.;]+/.exec(s.slice(i));
    if (op) { out.push({ t: 'o', v: op[0] }); i += op[0].length; continue; }
    out.push({ t: 'o', v: ch }); i += 1;
  }
  return out;
}
function parseGroups(tokens) {
  const root = []; const stack = [root];
  for (const tk of tokens) {
    if (tk.t === '(') { const g = { g: [] }; stack.at(-1).push(g); stack.push(g.g); } else if (tk.t === ')') { if (stack.length === 1) fail('unbalanced parentheses in a definition'); stack.pop(); } else stack.at(-1).push(tk);
  }
  if (stack.length !== 1) fail('unbalanced parentheses in a definition');
  return root;
}
const isWord = (it, w) => it && !it.g && it.t === 'w' && it.v.toUpperCase() === w;
function splitTop(items, w) {
  const parts = [[]];
  for (const it of items) { if (isWord(it, w)) parts.push([]); else parts.at(-1).push(it); }
  return parts;
}
// A pure chain of `w`: two or more operands joined by `w` at its top level, with no mixed operator and no list.
function pureChain(items, w) {
  const other = w === 'AND' ? 'OR' : 'AND';
  if (items.some((it) => isWord(it, other) || (!it.g && it.t === ','))) return false;
  const parts = splitTop(items, w);
  return parts.length >= 2 && parts.every((p) => p.length > 0);
}
function canonItems(items) {
  let out = items.map((it) => (it.g ? { g: canonItems(it.g) } : it));
  for (const w of ['AND', 'OR']) {
    if (!pureChain(out, w)) continue;
    const parts = splitTop(out, w).map((p) => (p.length === 1 && p[0].g && pureChain(p[0].g, w) ? p[0].g : p));
    out = parts.flatMap((p, k) => (k === 0 ? p : [{ t: 'w', v: w }, ...p]));
  }
  return out;
}
const serializeItems = (items) => items.map((it) => (it.g ? `( ${serializeItems(it.g)} )` : it.v)).join(' ');
export function canonicalSqlText(text) {
  return serializeItems(canonItems(parseGroups(tokenizeSql(text))));
}
const canonicalOpt = (v) => (v === null ? null : canonicalSqlText(v));

export function buildProjection(raw) {
  const tableNames = rowsOf(raw, 'tables').map((r) => str(r?.table, 'table name'));
  if (new Set(tableNames).size !== tableNames.length) fail('a table appears twice');
  const columns = new Map(tableNames.map((t) => [t, []]));
  for (const r of rowsOf(raw, 'columns')) {
    const list = columns.get(str(r?.table, 'column table'));
    if (!list) fail('a column belongs to a table outside the projection');
    list.push({
      name: str(r.column, 'column name'), type: str(r.type, 'column type'), notNull: bool(r.not_null, 'column nullability'),
      default: canonicalOpt(optStr(r.default_expr, 'column default')), identity: optStr(r.identity, 'column identity') ?? '', generated: optStr(r.generated, 'column generated') ?? '',
    });
  }
  const tables = tableNames.sort(cmp).map((name) => {
    const cols = columns.get(name).sort(byKeys('name'));
    if (new Set(cols.map((c) => c.name)).size !== cols.length) fail('a column appears twice');
    return { name, columns: cols };
  });

  const enumLabels = new Map();
  for (const r of rowsOf(raw, 'enums')) {
    const order = Number(str(r?.sort_order, 'enum sort order'));
    if (!Number.isFinite(order)) fail('enum sort order is malformed');
    const name = str(r.type, 'enum name');
    if (!enumLabels.has(name)) enumLabels.set(name, []);
    enumLabels.get(name).push({ label: str(r.label, 'enum label'), order });
  }
  const enums = [...enumLabels.keys()].sort(cmp).map((name) => ({ name, labels: enumLabels.get(name).sort((a, b) => a.order - b.order).map((l) => l.label) }));

  const types = rowsOf(raw, 'types').map((r) => {
    const kind = str(r?.kind, 'type kind');
    if (!['b', 'c', 'd', 'r', 'm'].includes(kind)) fail('type kind is malformed');
    return { name: str(r.type, 'type name'), kind };
  }).sort(byKeys('name'));

  const known = new Set(tableNames);
  const onTable = (r, what) => { const t = str(r?.table, `${what} table`); if (!known.has(t)) fail(`${what} belongs to a table outside the projection`); return t; };
  const constraints = rowsOf(raw, 'constraints').map((r) => {
    const type = str(r?.type, 'constraint type');
    if (!['p', 'f', 'u', 'c', 'x'].includes(type)) fail('constraint type is malformed');
    return { table: onTable(r, 'constraint'), name: str(r.name, 'constraint name'), type, definition: canonicalSqlText(str(r.definition, 'constraint definition')), validated: bool(r.validated, 'constraint validated') };
  }).sort(byKeys('table', 'name'));
  const indexes = rowsOf(raw, 'indexes').map((r) => ({
    table: onTable(r, 'index'), name: str(r?.name, 'index name'), definition: canonicalSqlText(str(r.definition, 'index definition')), valid: bool(r.valid, 'index validity'),
  })).sort(byKeys('table', 'name'));
  const functions = rowsOf(raw, 'functions').map((r) => {
    const kind = str(r?.kind, 'function kind');
    if (!['f', 'p'].includes(kind)) fail('function kind is malformed');
    return { name: str(r.name, 'function name'), args: optStr(r.args, 'function args') ?? '', kind, definitionSha256: sha256(str(r.definition, 'function definition')) };
  }).sort(byKeys('name', 'args'));
  const triggers = rowsOf(raw, 'triggers').map((r) => ({
    table: onTable(r, 'trigger'), name: str(r?.name, 'trigger name'), definition: canonicalSqlText(str(r.definition, 'trigger definition')), enabled: str(r.enabled, 'trigger enabled'),
  })).sort(byKeys('table', 'name'));

  for (const [label, list, key] of [['constraint', constraints, (x) => `${x.table}.${x.name}`], ['index', indexes, (x) => `${x.table}.${x.name}`],
    ['function', functions, (x) => `${x.name}(${x.args})`], ['trigger', triggers, (x) => `${x.table}.${x.name}`], ['enum', enums, (x) => x.name], ['type', types, (x) => x.name]]) {
    const keys = list.map(key);
    if (new Set(keys).size !== keys.length) fail(`a ${label} appears twice`);
  }
  return { format: PROJECTION_FORMAT, tables, enums, types, constraints, indexes, functions, triggers };
}

export const projectionDigest = (projection) => sha256(canonicalJson(projection));

export function projectionSummary(p) {
  return {
    tables: p.tables.length, columns: p.tables.reduce((n, t) => n + t.columns.length, 0), enums: p.enums.length, types: p.types.length,
    constraints: p.constraints.length, indexes: p.indexes.length, functions: p.functions.length, triggers: p.triggers.length,
  };
}

// Reads the projection through the caller's client (already inside the caller's
// read-only transaction with the pinned search_path). Never sets anything itself.
export async function readProjection(client) {
  const rows = async (key) => {
    const r = await client.query(PROJECTION_SQL[key]);
    return Array.isArray(r?.rows) ? r.rows : fail(`${key} could not be read`);
  };
  const sp = (await rows('searchPath'))[0]?.search_path;
  if (sp !== PINNED_SEARCH_PATH) fail(`search_path must be exactly '${PINNED_SEARCH_PATH}'`);
  const raw = {};
  for (const key of ['tables', 'columns', 'enums', 'types', 'constraints', 'indexes', 'functions', 'triggers']) raw[key] = await rows(key);
  return buildProjection(raw);
}

// Semantic probes: explicit facts about critical objects, checked against a projection.
// Returns one 'PROBE_FAILED:…' string per failing probe (object names only, never bodies).
export function runProbes(p, probes) {
  const tables = new Map(p.tables.map((t) => [t.name, t]));
  const col = (t, c) => tables.get(t)?.columns.some((x) => x.name === c) === true;
  const con = (t, n) => p.constraints.find((x) => x.table === t && x.name === n);
  const idx = (t, n) => p.indexes.find((x) => x.table === t && x.name === n);
  const fn = (n) => p.functions.find((x) => x.name === n);
  const trg = (t, n) => p.triggers.find((x) => x.table === t && x.name === n);
  const failures = [];
  for (const probe of probes) {
    const id = `${probe.kind}:${probe.table ? `${probe.table}.` : ''}${probe.name}`;
    let ok;
    switch (probe.kind) {
      case 'table': ok = tables.has(probe.name); break;
      case 'absentTable': ok = !tables.has(probe.name); break;
      case 'column': ok = col(probe.table, probe.name); break;
      case 'absentColumn': ok = !col(probe.table, probe.name); break;
      case 'enumLabels': { const e = p.enums.find((x) => x.name === probe.name); ok = !!e && probe.labels.every((l) => e.labels.includes(l)); break; }
      case 'absentEnumLabels': { const e = p.enums.find((x) => x.name === probe.name); ok = !e || probe.labels.every((l) => !e.labels.includes(l)); break; }
      case 'constraint': { const c = con(probe.table, probe.name); ok = !!c && c.type === probe.type && c.validated === true; break; }
      case 'absentConstraint': ok = !con(probe.table, probe.name); break;
      case 'index': { const i = idx(probe.table, probe.name); ok = !!i && i.valid === true; break; }
      case 'absentIndex': ok = !idx(probe.table, probe.name); break;
      case 'function': ok = !!fn(probe.name); break;
      case 'absentFunction': ok = !fn(probe.name); break;
      case 'trigger': { const t = trg(probe.table, probe.name); ok = !!t && t.enabled !== 'D'; break; }
      case 'absentTrigger': ok = !trg(probe.table, probe.name); break;
      default: ok = false;
    }
    if (!ok) failures.push(`PROBE_FAILED:${id}`);
  }
  return failures;
}
