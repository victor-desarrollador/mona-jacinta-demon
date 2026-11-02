// TEST SUPPORT (not a tool, not a test): a scripted in-memory stand-in for the PILOT database that the hermetic tests of the G22 rollout tools share.
// It answers EXACTLY the fixed statements of pilot-g22-rollout.mjs (any other statement throws), keeps a log of every statement it saw so a test can prove the
// rollout is read-only, and moves between generations on request (`advance`) the way a Prisma deploy would. The projections are SYNTHETIC but are built from the REAL
// reviewed probes of pilot-g22-schema-references.mjs, so the real probes pass or fail for the right reasons; the references are the digests of those synthetic
// projections (one distinct schema per generation). Never imported by a tool.
import { LEDGER_SQL } from './pilot-migration-states.mjs';
import { pinsOf } from './pilot-migration-generations.mjs';
import { CATALOG_SQL } from './pilot-rbac-catalog.mjs';
import { CATALOG_38 } from './pilot-rbac-catalog-generations.mjs';
import { PROJECTION_SQL, PINNED_SEARCH_PATH, buildProjection, projectionDigest, projectionSummary } from './app-schema-projection.mjs';
import { SNAPSHOT_SQL } from './pilot-migrate.mjs';
import { GENERATION_PROBES_G22 } from './pilot-g22-schema-references.mjs';
import { COUNT_SQL, FACT_SQL, FROZEN_COUNT_TABLES } from './pilot-g22-rollout.mjs';

export const MARKER = '2b4d6f81-7a9c-4e0b-8d2f-3c5e7a9b1d0f';
export const GENERATIONS_FAKE = Object.freeze(['EXACT_G20', 'EXACT_G21', 'EXACT_G22']);

// A synthetic projection that satisfies the REAL probes of a generation.
export function rawFor(state) {
  const tables = new Set();
  const raw = { tables: [], columns: [], enums: [], types: [], constraints: [], indexes: [], functions: [], triggers: [] };
  const table = (name) => {
    if (tables.has(name)) return;
    tables.add(name); raw.tables.push({ table: name });
    raw.columns.push({ table: name, column: 'id', type: 'text', not_null: true, default_expr: null, identity: '', generated: '' });
  };
  for (const p of GENERATION_PROBES_G22[state].filter((q) => !q.kind.startsWith('absent'))) {
    if (p.kind === 'table') table(p.name);
    if (p.kind === 'column') { table(p.table); if (p.name !== 'id') raw.columns.push({ table: p.table, column: p.name, type: 'text', not_null: false, default_expr: null, identity: '', generated: '' }); }
    if (p.kind === 'enumLabels') p.labels.forEach((label, i) => raw.enums.push({ type: p.name, label, sort_order: String(i + 1) }));
    if (p.kind === 'constraint') { table(p.table); raw.constraints.push({ table: p.table, name: p.name, type: p.type, definition: `def ${p.name}`, validated: true }); }
    if (p.kind === 'index') { table(p.table); raw.indexes.push({ table: p.table, name: p.name, definition: `CREATE INDEX ${p.name}`, valid: true }); }
    if (p.kind === 'function') raw.functions.push({ name: p.name, args: '', kind: 'f', definition: `body ${p.name}` });
    if (p.kind === 'trigger') { table(p.table); raw.triggers.push({ table: p.table, name: p.name, definition: `CREATE TRIGGER ${p.name}`, enabled: 'O' }); }
  }
  return raw;
}

const PROJECTIONS = Object.fromEntries(GENERATIONS_FAKE.map((g) => [g, buildProjection(rawFor(g))]));
export const SCHEMA = Object.freeze({
  references: Object.freeze(Object.fromEntries(GENERATIONS_FAKE.map((g) => [g, Object.freeze({ digest: projectionDigest(PROJECTIONS[g]) })]))),
  probes: GENERATION_PROBES_G22,
});
// The fingerprint the synthetic EXACT_G22 produces with an 8-column ledger table (so the real 360 / 38 are not asserted on synthetic data).
export const FINGERPRINT = Object.freeze({ columns: projectionSummary(PROJECTIONS.EXACT_G22).columns + 8, relations: projectionSummary(PROJECTIONS.EXACT_G22).tables + 1 });

export const catalogRows = (def) => {
  const roleId = new Map(def.roles.map(([c, id]) => [c, id]));
  const permId = new Map(def.permissions.map(([c, id]) => [c, id]));
  return {
    roles: def.roles.map(([code, id]) => ({ id, code })),
    permissions: def.permissions.map(([code, id]) => ({ id, code })),
    grants: def.grants.map(([r, p]) => ({ roleId: roleId.get(r), permissionId: permId.get(p) })),
  };
};
const ledgerOf = (generation) => pinsOf(generation).map((m) => ({ migration_name: m.name, checksum: m.sha256, finished: true, rolled_back: false }));

export const baseData = () => ({
  users: { total: 6, active: 5, non_lower: 0 }, collisionGroups: 0, operativeOwners: 1,
  operation: { cashOpen: 0, salesDraft: 18, salesPendingPayment: 1, liveReservations: 0 },
  counts: { User: 6, UserRoleScope: 5, Sale: 36, SalePayment: 10, CashSession: 9, Inventory: 264, StockMovement: 275, SaleExchange: 0, SaleVoid: 1, AuditLog: 895 },
  lowerIndexDef: 'CREATE UNIQUE INDEX "User_email_lower_key" ON public."User" USING btree (lower(email))',
  userDefaults: { total: 6, mustChange: 0, credentialsSet: 0 }, adminOperations: 0, ledgerColumns: 8,
});

export class FakeDb {
  constructor({ generation = 'EXACT_G20', data = {}, ledger = null, marker = { marker_id: MARKER, environment: 'pilot' }, readOnly = 'on' } = {}) {
    this.generation = generation;
    this.data = { ...baseData(), ...data };
    this.ledgerOverride = ledger;
    this.marker = marker;
    this.readOnly = readOnly;
    this.statements = [];
    this.rawOverride = null;
    this.connects = 0;
    this.ends = 0;
  }

  advance(generation) { this.generation = generation; this.ledgerOverride = null; this.rawOverride = null; }

  // The pg-like client the tools get; `tls` mirrors client.connection.stream of the verified client.
  client({ tls = true } = {}) {
    const db = this;
    return {
      connection: { stream: { encrypted: tls, authorized: tls } },
      connect: async () => { db.connects += 1; },
      end: async () => { db.ends += 1; },
      query: async (text) => db.answer(text),
    };
  }

  createClient() { return this.client(); }

  answer(text) {
    this.statements.push(text);
    const d = this.data;
    const afterG21 = this.generation !== 'EXACT_G20';
    const afterG22 = this.generation === 'EXACT_G22';
    const one = (row) => ({ rows: [row] });
    if (text === SNAPSHOT_SQL.begin || text === SNAPSHOT_SQL.searchPath || text === SNAPSHOT_SQL.rollback || SNAPSHOT_SQL.timeouts.includes(text)) return { rows: [] };
    if (text === SNAPSHOT_SQL.readOnly) return one({ read_only: this.readOnly });
    if (text === SNAPSHOT_SQL.marker) return { rows: this.marker ? [this.marker] : [] };
    if (text === SNAPSHOT_SQL.ledgerPresent) return one({ present: true });
    if (text === LEDGER_SQL) return { rows: this.ledgerOverride ?? ledgerOf(this.generation) };
    if (text === PROJECTION_SQL.searchPath) return one({ search_path: PINNED_SEARCH_PATH });
    for (const [k, sql] of Object.entries(PROJECTION_SQL)) if (text === sql) return { rows: (this.rawOverride ?? rawFor(this.generation))[k] };
    const cat = catalogRows(CATALOG_38);
    if (text === CATALOG_SQL.roles) return { rows: cat.roles };
    if (text === CATALOG_SQL.permissions) return { rows: cat.permissions };
    if (text === CATALOG_SQL.grants) return { rows: cat.grants };
    if (text === FACT_SQL.users) return one({ total: String(d.users.total), active: String(d.users.active), non_lower: String(d.users.non_lower) });
    if (text === FACT_SQL.collisionGroups) return one({ n: String(d.collisionGroups) });
    if (text === FACT_SQL.operativeOwners) return one({ n: String(d.operativeOwners) });
    if (text === FACT_SQL.cashOpen) return one({ n: String(d.operation.cashOpen) });
    if (text === FACT_SQL.salesDraft) return one({ n: String(d.operation.salesDraft) });
    if (text === FACT_SQL.salesPendingPayment) return one({ n: String(d.operation.salesPendingPayment) });
    if (text === FACT_SQL.liveReservations) return one({ n: String(d.operation.liveReservations) });
    if (text === FACT_SQL.ledgerColumns) return one({ n: String(d.ledgerColumns) });
    if (text === FACT_SQL.lowerIndexDef) return { rows: afterG22 && d.lowerIndexDef ? [{ indexdef: d.lowerIndexDef }] : [] };
    if (text === FACT_SQL.userDefaults) {
      if (!afterG21) throw new Error('column "mustChangePassword" does not exist');
      return one({ total: String(d.userDefaults.total), must_change: String(d.userDefaults.mustChange), credentials_set: String(d.userDefaults.credentialsSet) });
    }
    if (text === FACT_SQL.adminOperations) {
      if (!afterG22) throw new Error('relation "UserAdminOperation" does not exist');
      return one({ n: String(d.adminOperations) });
    }
    for (const t of FROZEN_COUNT_TABLES) if (text === COUNT_SQL[t]) return one({ n: String(d.counts[t]) });
    throw new Error(`unexpected SQL in the fake database: ${String(text).slice(0, 60)}`);
  }

  // True when every statement seen is a read (no DDL/DML), i.e. the whole interaction was a snapshot.
  get readOnlyOnly() { return this.statements.every((s) => /^(SELECT|BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL|ROLLBACK)/i.test(s)); }
}
