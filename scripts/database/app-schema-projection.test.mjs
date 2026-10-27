// Zero-database unit tests for scripts/database/app-schema-projection.mjs: the canonical
// APP-OWNED schema projection (tables, columns, enums, constraints, indexes, app functions
// and triggers of schema public, extension-owned objects excluded), its deterministic
// serialization/digest, the semantic probes, and the read-only catalog SQL.
// Run with: node --test scripts/database/app-schema-projection.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as P from './app-schema-projection.mjs';

const SOURCE = readFileSync(new URL('./app-schema-projection.mjs', import.meta.url), 'utf8');

// A small, realistic raw catalog read (the shape readProjection's queries return).
function raw() {
  return {
    tables: [{ table: 'CashMovement' }, { table: 'CashSession' }],
    columns: [
      { table: 'CashMovement', column: 'id', type: 'text', not_null: true, default_expr: null, identity: '', generated: '' },
      { table: 'CashMovement', column: 'sessionId', type: 'text', not_null: true, default_expr: null, identity: '', generated: '' },
      { table: 'CashMovement', column: 'reason', type: 'text', not_null: false, default_expr: null, identity: '', generated: '' },
      { table: 'CashMovement', column: 'type', type: '"CashMovementType"', not_null: true, default_expr: null, identity: '', generated: '' },
      { table: 'CashSession', column: 'id', type: 'text', not_null: true, default_expr: null, identity: '', generated: '' },
      { table: 'CashSession', column: 'openedAt', type: 'timestamp(3) with time zone', not_null: true, default_expr: 'CURRENT_TIMESTAMP', identity: '', generated: '' },
    ],
    enums: [
      { type: 'CashMovementType', label: 'OPENING', sort_order: '1' },
      { type: 'CashMovementType', label: 'WITHDRAWAL', sort_order: '5' },
      { type: 'CashMovementType', label: 'EXPENSE', sort_order: '6' },
    ],
    types: [],
    constraints: [
      { table: 'CashMovement', name: 'CashMovement_pkey', type: 'p', definition: 'PRIMARY KEY (id)', validated: true },
      { table: 'CashMovement', name: 'CashMovement_sessionId_fkey', type: 'f', definition: 'FOREIGN KEY ("sessionId") REFERENCES "CashSession"(id) ON UPDATE CASCADE ON DELETE RESTRICT', validated: true },
      { table: 'CashMovement', name: 'chk_cash_movement_exit_reason', type: 'c', definition: "CHECK (((type)::text <> ALL (ARRAY['WITHDRAWAL'::text, 'EXPENSE'::text])) OR (reason IS NOT NULL))", validated: true },
      { table: 'CashSession', name: 'CashSession_pkey', type: 'p', definition: 'PRIMARY KEY (id)', validated: true },
    ],
    indexes: [
      { table: 'CashMovement', name: 'CashMovement_pkey', definition: 'CREATE UNIQUE INDEX "CashMovement_pkey" ON public."CashMovement" USING btree (id)', valid: true },
      { table: 'CashMovement', name: 'CashMovement_sessionId_idx', definition: 'CREATE INDEX "CashMovement_sessionId_idx" ON public."CashMovement" USING btree ("sessionId")', valid: true },
      { table: 'CashSession', name: 'CashSession_pkey', definition: 'CREATE UNIQUE INDEX "CashSession_pkey" ON public."CashSession" USING btree (id)', valid: true },
    ],
    functions: [
      { name: 'fn_guard', args: '', kind: 'f', definition: 'CREATE OR REPLACE FUNCTION public.fn_guard()\n RETURNS trigger\n LANGUAGE plpgsql\nAS $function$ BEGIN RETURN NEW; END $function$\n' },
    ],
    triggers: [
      { table: 'CashMovement', name: 'trg_guard', definition: 'CREATE TRIGGER trg_guard BEFORE INSERT ON public."CashMovement" FOR EACH ROW EXECUTE FUNCTION fn_guard()', enabled: 'O' },
    ],
  };
}
const digestOf = (r) => P.projectionDigest(P.buildProjection(r));
const BASE = digestOf(raw());
const mutate = (fn) => { const r = raw(); fn(r); return digestOf(r); };

test('SP-01 same schema → same digest; the digest is SHA-256 hex', () => {
  assert.match(BASE, /^[0-9a-f]{64}$/);
  assert.equal(digestOf(raw()), BASE);
});

test('SP-02 object and row ordering are irrelevant (enum label order is semantic and kept by sort_order)', () => {
  const r = raw();
  for (const key of Object.keys(r)) r[key].reverse();
  assert.equal(digestOf(r), BASE);
  const projection = P.buildProjection(r);
  assert.deepEqual(projection.enums, [{ name: 'CashMovementType', labels: ['OPENING', 'WITHDRAWAL', 'EXPENSE'] }]);
});

test('SP-03 every app object family is in the digest: a missing or changed object changes it', () => {
  const cases = {
    'missing table': (r) => {
      // A real catalog never lists objects of an absent table: drop them with it.
      for (const key of ['tables', 'columns', 'constraints', 'indexes', 'triggers']) r[key] = r[key].filter((x) => x.table !== 'CashSession');
      r.constraints = r.constraints.filter((c) => c.type !== 'f');
    },
    'missing column': (r) => { r.columns = r.columns.filter((c) => c.column !== 'reason'); },
    'changed type': (r) => { r.columns.find((c) => c.column === 'reason').type = 'character varying'; },
    'changed nullability': (r) => { r.columns.find((c) => c.column === 'reason').not_null = true; },
    'changed default': (r) => { r.columns.find((c) => c.column === 'openedAt').default_expr = 'now()'; },
    'missing enum label': (r) => { r.enums = r.enums.filter((e) => e.label !== 'EXPENSE'); },
    'enum label order': (r) => { r.enums.find((e) => e.label === 'EXPENSE').sort_order = '4'; },
    'missing FK': (r) => { r.constraints = r.constraints.filter((c) => c.type !== 'f'); },
    'changed FK action': (r) => { r.constraints.find((c) => c.type === 'f').definition = r.constraints.find((c) => c.type === 'f').definition.replace('RESTRICT', 'CASCADE'); },
    'missing CHECK': (r) => { r.constraints = r.constraints.filter((c) => c.type !== 'c'); },
    'CHECK not validated': (r) => { r.constraints.find((c) => c.type === 'c').validated = false; },
    'missing unique/index': (r) => { r.indexes = r.indexes.filter((i) => i.name !== 'CashMovement_sessionId_idx'); },
    'invalid index': (r) => { r.indexes[1].valid = false; },
    'missing app trigger': (r) => { r.triggers = []; },
    'disabled app trigger': (r) => { r.triggers[0].enabled = 'D'; },
    'missing app function': (r) => { r.functions = []; },
    'changed function body': (r) => { r.functions[0].definition = r.functions[0].definition.replace('RETURN NEW', 'RETURN NULL'); },
    'extra unknown table': (r) => { r.tables.push({ table: 'Intruder' }); },
    'extra domain type': (r) => { r.types.push({ type: 'money_domain', kind: 'd' }); },
  };
  for (const [label, fn] of Object.entries(cases)) assert.notEqual(mutate(fn), BASE, label);
});

test('SP-04 extension/provider objects never enter the projection: the SQL excludes them at the source', () => {
  // Exclusion happens in the catalog SQL (pg_depend deptype e, schema public only, relkind r/p,
  // _prisma_migrations excluded); this pins that every object query carries it.
  for (const key of ['tables', 'columns', 'constraints', 'indexes', 'triggers']) {
    assert.match(P.PROJECTION_SQL[key], /n\.nspname = 'public'/, key);
    assert.match(P.PROJECTION_SQL[key], /c\.relkind IN \('r', 'p'\)/, key);
    assert.match(P.PROJECTION_SQL[key], /c\.relname <> '_prisma_migrations'/, key);
    assert.match(P.PROJECTION_SQL[key], /deptype = 'e'/, key);
  }
  assert.equal(P.PROJECTION_SQL.searchPath, "SELECT pg_catalog.current_setting('search_path') AS search_path");
  for (const key of ['enums', 'types', 'functions']) {
    assert.match(P.PROJECTION_SQL[key], /n\.nspname = 'public'/, key);
    assert.match(P.PROJECTION_SQL[key], /deptype = 'e'/, key);
  }
  assert.match(P.PROJECTION_SQL.triggers, /NOT t\.tgisinternal/);
  assert.match(P.PROJECTION_SQL.functions, /p\.prokind IN \('f', 'p'\)/);
  // Views, sequences, RLS/policies, ownership, privileges and comments are not read at all.
  assert.doesNotMatch(Object.values(P.PROJECTION_SQL).join('\n'), /pg_policy|relrowsecurity|relowner|relacl|pg_description|relkind IN \('v'|'S'/);
});

test('SP-05 every query is a single read-only SELECT over pg_catalog with no side effects', () => {
  for (const [key, sql] of Object.entries(P.PROJECTION_SQL)) {
    assert.match(sql, /^SELECT /, key);
    assert.doesNotMatch(sql, /;|\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|GRANT|TRUNCATE|COPY|SET|DO)\b/i, key);
  }
  assert.doesNotMatch(SOURCE, /readFile|process\.env|import\(/);
});

test('SP-06 malformed raw rows are refused (never silently projected)', () => {
  const bad = [
    (r) => { r.tables.push({ table: 42 }); },
    (r) => { r.columns[0].not_null = 'yes'; },
    (r) => { r.constraints[0].type = 'z'; },
    (r) => { r.enums[0].sort_order = 'x'; },
    (r) => { delete r.indexes; },
    (r) => { r.columns.push({ ...r.columns[0], table: 'NotATable' }); },
  ];
  for (const fn of bad) { const r = raw(); fn(r); assert.throws(() => P.buildProjection(r), /projection/); }
});

test('SP-07 readProjection proves the pinned search_path, then runs exactly the eight object queries and projects them', async () => {
  const seen = [];
  const r = raw();
  const byKey = { searchPath: [{ search_path: 'pg_catalog, pg_temp' }], tables: r.tables, columns: r.columns, enums: r.enums, types: r.types, constraints: r.constraints, indexes: r.indexes, functions: r.functions, triggers: r.triggers };
  const client = { query: async (text) => { const key = Object.keys(P.PROJECTION_SQL).find((k) => P.PROJECTION_SQL[k] === text); seen.push(key); return { rows: byKey[key] }; } };
  const projection = await P.readProjection(client);
  assert.deepEqual([...seen].sort(), Object.keys(P.PROJECTION_SQL).sort());
  assert.equal(P.projectionDigest(projection), BASE);
  assert.equal(seen[0], 'searchPath', 'the search_path is proven before any object query');
  // Any other search_path would change how names are qualified: refused before reading objects.
  const other = { query: async (text) => ({ rows: text === P.PROJECTION_SQL.searchPath ? [{ search_path: '"$user", public' }] : byKey.tables }) };
  await assert.rejects(() => P.readProjection(other), /projection: search_path/);
});

test('SP-08 probes: each required object reports when absent, each forbidden object when present', () => {
  const projection = P.buildProjection(raw());
  const probes = [
    { kind: 'table', name: 'CashMovement' },
    { kind: 'column', table: 'CashMovement', name: 'reason' },
    { kind: 'enumLabels', name: 'CashMovementType', labels: ['WITHDRAWAL', 'EXPENSE'] },
    { kind: 'constraint', table: 'CashMovement', name: 'CashMovement_sessionId_fkey', type: 'f' },
    { kind: 'index', table: 'CashMovement', name: 'CashMovement_sessionId_idx' },
    { kind: 'function', name: 'fn_guard' },
    { kind: 'trigger', table: 'CashMovement', name: 'trg_guard' },
    { kind: 'absentColumn', table: 'CashMovement', name: 'reversesMovementId' },
    { kind: 'absentTable', name: 'SaleCheckout' },
  ];
  assert.deepEqual(P.runProbes(projection, probes), []);
  const failing = P.runProbes(projection, [
    { kind: 'table', name: 'SaleCheckout' },
    { kind: 'column', table: 'CashMovement', name: 'reversesMovementId' },
    { kind: 'enumLabels', name: 'CashMovementType', labels: ['WITHDRAWAL_REVERSAL'] },
    { kind: 'constraint', table: 'CashMovement', name: 'chk_cash_movement_exit_reason', type: 'f' },
    { kind: 'index', table: 'CashMovement', name: 'CashMovement_reversesMovementId_key' },
    { kind: 'function', name: 'fn_checkout_attempt_guard' },
    { kind: 'trigger', table: 'CashMovement', name: 'trg_x' },
    { kind: 'absentColumn', table: 'CashMovement', name: 'reason' },
    { kind: 'absentTable', name: 'CashSession' },
  ]);
  assert.equal(failing.length, 9);
  for (const f of failing) assert.match(f, /^PROBE_FAILED:/);
  // A CHECK that exists but is NOT VALID fails a constraint probe.
  const r = raw();
  r.constraints.find((c) => c.type === 'c').validated = false;
  assert.equal(P.runProbes(P.buildProjection(r), [{ kind: 'constraint', table: 'CashMovement', name: 'chk_cash_movement_exit_reason', type: 'c' }]).length, 1);
});

test('SP-09 summary counts each family (for evidence output, no object bodies)', () => {
  assert.deepEqual(P.projectionSummary(P.buildProjection(raw())), { tables: 2, columns: 6, enums: 1, types: 0, constraints: 4, indexes: 3, functions: 1, triggers: 1 });
});

// ---------------- canonicalization robustness (G11 lab finding, 2026-10-18) ----------------
// A pg_dump/pg_restore round trip re-parses CHECK expressions: Prisma-created `((A AND B) AND C)`
// (nested BoolExpr from BETWEEN) comes back flat as `(A AND B AND C)`. Same semantics, so the same digest.
const NESTED = "CHECK ((((char_length(reference) >= 1) AND (char_length(reference) <= 64)) AND (\"referenceKey\" ~ '^[A-Z0-9]{3,40}$'::text)))";
const FLAT = "CHECK (((char_length(reference) >= 1) AND (char_length(reference) <= 64) AND (\"referenceKey\" ~ '^[A-Z0-9]{3,40}$'::text)))";
const withCheck = (def) => mutate((r) => { r.constraints.find((c) => c.type === 'c').definition = def; });
test('SP-10 associativity of AND / OR is canonical: nested and flat chains have the same digest', () => {
  assert.equal(P.canonicalSqlText(NESTED), P.canonicalSqlText(FLAT));
  assert.equal(withCheck(NESTED), withCheck(FLAT));
  assert.equal(P.canonicalSqlText('CHECK (((a = 1) OR ((b = 2) OR (c = 3))))'), P.canonicalSqlText('CHECK (((a = 1) OR (b = 2) OR (c = 3)))'));
  assert.equal(P.canonicalSqlText("CREATE UNIQUE INDEX x ON public.t USING btree (a) WHERE (((s = 'A'::text) AND (k IS NOT NULL)) AND (n > 0))"),
    P.canonicalSqlText("CREATE UNIQUE INDEX x ON public.t USING btree (a) WHERE ((s = 'A'::text) AND (k IS NOT NULL) AND (n > 0))"));
});
test('SP-11 formatting-only differences (whitespace, line breaks) do not change the digest', () => {
  assert.equal(withCheck(FLAT.replace(/ AND /g, '\n    AND ')), withCheck(FLAT));
  assert.equal(P.canonicalSqlText('CHECK  ((a   >= 1))'), P.canonicalSqlText('CHECK ((a >= 1))'));
});
test('SP-12 semantic differences still change the digest (no relaxation)', () => {
  const cases = [
    "CHECK ((((char_length(reference) >= 1) OR (char_length(reference) <= 64)) AND (\"referenceKey\" ~ '^[A-Z0-9]{3,40}$'::text)))", // AND → OR inside
    "CHECK ((((char_length(reference) >= 1) AND (char_length(reference) <= 65)) AND (\"referenceKey\" ~ '^[A-Z0-9]{3,40}$'::text)))", // bound
    "CHECK ((((char_length(reference) >= 1) AND (char_length(reference) <= 64)) OR (\"referenceKey\" ~ '^[A-Z0-9]{3,40}$'::text)))", // mixed: never flattened
    "CHECK (((\"referenceKey\" ~ '^[A-Z0-9]{3,40}$'::text) AND (char_length(reference) >= 1) AND (char_length(reference) <= 64)))", // operand order kept
    "CHECK ((((char_length(reference) >= 1) AND (char_length(reference) <= 64)) AND (\"referenceKey\" ~ '^[A-Z0-9]{3,41}$'::text)))", // literal
  ];
  for (const c of cases) assert.notEqual(withCheck(c), withCheck(NESTED), c);
  // NOT binds tighter than AND: NOT (a AND b) AND c is not NOT a AND b AND c.
  assert.notEqual(P.canonicalSqlText('CHECK (((NOT ((a = 1) AND (b = 2))) AND (c = 3)))'), P.canonicalSqlText('CHECK (((NOT (a = 1)) AND (b = 2) AND (c = 3)))'));
  // A function call's argument list is never a boolean group.
  assert.notEqual(P.canonicalSqlText('CHECK ((f((a AND b), c) AND d))'), P.canonicalSqlText('CHECK ((f(a AND b, c) AND d))'));
  // Quoted text is opaque: AND inside a literal or a quoted identifier is not an operator.
  assert.notEqual(P.canonicalSqlText("CHECK ((a = '(x AND y) AND z'::text))"), P.canonicalSqlText("CHECK ((a = 'x AND y AND z'::text))"));
  assert.notEqual(P.canonicalSqlText('CHECK (("a  b" = 1))'), P.canonicalSqlText('CHECK (("a b" = 1))'));
});
test('SP-13 canonicalization is idempotent and applies to CHECK, index, trigger and default texts (format v2)', () => {
  assert.equal(P.canonicalSqlText(P.canonicalSqlText(NESTED)), P.canonicalSqlText(NESTED));
  assert.equal(P.PROJECTION_FORMAT, 'mona-app-schema-projection/v2');
  const p = P.buildProjection((() => { const r = raw(); r.constraints.find((c) => c.type === 'c').definition = NESTED; return r; })());
  assert.equal(p.constraints.find((c) => c.type === 'c').definition, P.canonicalSqlText(FLAT));
  const d = mutate((r) => { r.columns.find((c) => c.column === 'openedAt').default_expr = 'CURRENT_TIMESTAMP  '; });
  assert.equal(d, BASE, 'default texts are canonical too');
});
