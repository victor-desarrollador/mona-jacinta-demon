// PILOT USER-MGMT rollout (G20 -> G21 -> G22): the app-schema references and probes of the generations G16 .. G22. A separate module on purpose:
// pilot-g20-schema-references.mjs (G16..G20) is pinned by the G20 tool manifests and by the G20 tools and stays untouched; the probes and references of
// G16 .. G20 are REUSED from it, not re-declared. G21 and G22 only ADD their own objects (and, for every earlier generation, their ABSENCE).
//
// GENERATION_PROBES_G22 — REVIEWED semantic facts. Each object migrations 21 (user_credentials_epoch) and 22 (user_admin_lifecycle) add is listed
//   explicitly; pilot-g22-schema-references.test.mjs checks every name against the migration SQL. Builtins only, no I/O.
//
// SCHEMA_REFERENCES_G22 — the app-owned schema projection digest (app-schema-projection.mjs, format v2) of a disposable PostgreSQL 17 cluster built from
//   nothing with exactly the generation's pinned migrations. GENERATED, never hand-written, by pilot-g22-schema-reference.mjs on a throwaway PostgreSQL
//   17.11 cluster (private network namespace, LOCAL_TEST marker). The G16 .. G20 values are the ones the G20 module already pinned; the G20 value is also
//   the CONTROL of the G22 generator (it must reproduce it byte for byte before the G21 / G22 values are trusted).
//   A reference that is ever null / `pending: true` is refused by every tool of this rollout (fail closed).
import { GENERATION_PROBES_G20, SCHEMA_REFERENCES_G20 } from './pilot-g20-schema-references.mjs';

const t = (name) => ({ kind: 'table', name });
const col = (table, name) => ({ kind: 'column', table, name });
const con = (table, name, type) => ({ kind: 'constraint', table, name, type });
const idx = (table, name) => ({ kind: 'index', table, name });
const not = (probe) => ({ ...probe, kind: `absent${probe.kind[0].toUpperCase()}${probe.kind.slice(1)}` });
const freeze = (list) => Object.freeze(list.map((p) => Object.freeze({ ...p, ...(p.labels ? { labels: Object.freeze([...p.labels]) } : {}) })));

// Everything migration 21 (user_credentials_epoch) adds: two additive columns on "User", nothing else.
export const G21_CREDENTIALS_ADDS = Object.freeze([
  col('User', 'mustChangePassword'),
  col('User', 'credentialsChangedAt'),
]);

// Everything migration 22 (user_admin_lifecycle) adds: the lower("email") unique index and the UserAdminOperation table with its constraints, FKs and indexes.
export const G22_LIFECYCLE_ADDS = Object.freeze([
  idx('User', 'User_email_lower_key'),
  t('UserAdminOperation'),
  col('UserAdminOperation', 'id'),
  col('UserAdminOperation', 'actorId'),
  col('UserAdminOperation', 'targetUserId'),
  col('UserAdminOperation', 'operation'),
  col('UserAdminOperation', 'idempotencyKey'),
  col('UserAdminOperation', 'requestHash'),
  col('UserAdminOperation', 'createdAt'),
  con('UserAdminOperation', 'UserAdminOperation_pkey', 'p'),
  con('UserAdminOperation', 'chk_user_admin_operation_operation', 'c'),
  con('UserAdminOperation', 'chk_user_admin_operation_request_hash', 'c'),
  con('UserAdminOperation', 'chk_user_admin_operation_key', 'c'),
  con('UserAdminOperation', 'UserAdminOperation_actorId_fkey', 'f'),
  con('UserAdminOperation', 'UserAdminOperation_targetUserId_fkey', 'f'),
  idx('UserAdminOperation', 'UserAdminOperation_pkey'),
  idx('UserAdminOperation', 'UserAdminOperation_actorId_idempotencyKey_key'),
  idx('UserAdminOperation', 'UserAdminOperation_targetUserId_createdAt_idx'),
]);

const G21_ADDS = [...G21_CREDENTIALS_ADDS];
const G22_ADDS = [...G22_LIFECYCLE_ADDS];
const withAbsence = (present, absent) => freeze([...present, ...absent.map(not)]);
export const GENERATION_PROBES_G22 = Object.freeze({
  EXACT_G16: withAbsence(GENERATION_PROBES_G20.EXACT_G16, [...G21_ADDS, ...G22_ADDS]),
  EXACT_G17: withAbsence(GENERATION_PROBES_G20.EXACT_G17, [...G21_ADDS, ...G22_ADDS]),
  EXACT_G18: withAbsence(GENERATION_PROBES_G20.EXACT_G18, [...G21_ADDS, ...G22_ADDS]),
  EXACT_G19: withAbsence(GENERATION_PROBES_G20.EXACT_G19, [...G21_ADDS, ...G22_ADDS]),
  EXACT_G20: withAbsence(GENERATION_PROBES_G20.EXACT_G20, [...G21_ADDS, ...G22_ADDS]),
  EXACT_G21: withAbsence([...GENERATION_PROBES_G20.EXACT_G20, ...G21_ADDS], G22_ADDS),
  EXACT_G22: freeze([...GENERATION_PROBES_G20.EXACT_G20, ...G21_ADDS, ...G22_ADDS]),
});

export const SCHEMA_REFERENCES_G22 = Object.freeze({
  ...SCHEMA_REFERENCES_G20,
  // Generated on a fresh disposable PostgreSQL 17.11 cluster, twice per state (identical); the G20 control reproduced 2f952749…26a3 (= the value the PILOT database holds).
  EXACT_G21: Object.freeze({ digest: 'eef8c81a5c5f3b484a6232b62350e0eb8fc493dfa28d66b43780ebab48f1788b', summary: Object.freeze({ tables: 36, columns: 345, enums: 18, types: 0, constraints: 193, indexes: 158, functions: 19, triggers: 25 }) }),
  EXACT_G22: Object.freeze({ digest: 'adbff646732d9896473c328c317bd44b9dc837cb3411d6dd41807ca2183e1e92', summary: Object.freeze({ tables: 37, columns: 352, enums: 18, types: 0, constraints: 199, indexes: 162, functions: 19, triggers: 25 }) }),
});
export const PENDING_REFERENCES = Object.freeze(Object.entries(SCHEMA_REFERENCES_G22).filter(([, r]) => r.pending === true).map(([g]) => g));

// The pair every tool of this rollout hands to verifySnapshot-style checks.
export const GENERATION_SCHEMA_G22 = Object.freeze({ references: SCHEMA_REFERENCES_G22, probes: GENERATION_PROBES_G22 });
