// PILOT G20 rollout (sale exchange v1 + the post-sale claim): the app-schema references and probes of the generations G16 .. G20. A separate
// module on purpose: pilot-g19-schema-references.mjs (G16..G19), pilot-g16-schema-references.mjs and pilot-schema-references.mjs are pinned by
// the PILOT tool manifests and by the historical tools and stay untouched; the probes and references of G16 .. G19 are REUSED from them, not
// re-declared, and G20 only ADDS its own objects (and, for every earlier generation, their ABSENCE).
//
// GENERATION_PROBES_G20 — REVIEWED semantic facts. Each object migration 20 (sale_post_sale_guard) adds is listed explicitly; pilot-g20-schema-references.test.mjs
//   checks every name against the migration SQL (the names were extracted from the SQL, not typed from memory). Builtins only, no I/O.
//
// SCHEMA_REFERENCES_G20 — the app-owned schema projection digest (app-schema-projection.mjs, format v2) of a disposable PostgreSQL 17 cluster built from
//   nothing with exactly the generation's pinned migrations. GENERATED, never hand-written, by pilot-g20-schema-reference.mjs on a throwaway PostgreSQL
//   17.11 cluster (private network namespace, LOCAL_TEST marker). The G16 .. G19 values are the ones already derived and pinned by the G19 module.
//   A reference that is ever null / `pending: true` (a future generation) is refused by every tool of this rollout (fail closed).
import { GENERATION_PROBES_G19, SCHEMA_REFERENCES_G19 } from './pilot-g19-schema-references.mjs';

const t = (name) => ({ kind: 'table', name });
const col = (table, name) => ({ kind: 'column', table, name });
const con = (table, name, type) => ({ kind: 'constraint', table, name, type });
const idx = (table, name) => ({ kind: 'index', table, name });
const fn = (name) => ({ kind: 'function', name });
const trg = (table, name) => ({ kind: 'trigger', table, name });
const not = (probe) => ({ ...probe, kind: `absent${probe.kind[0].toUpperCase()}${probe.kind.slice(1)}` });
const freeze = (list) => Object.freeze(list.map((p) => Object.freeze({ ...p, ...(p.labels ? { labels: Object.freeze([...p.labels]) } : {}) })));

// Everything migration 20 (sale_post_sale_guard) adds: the claim table, its three constraints and index, the claim function and its two triggers.
const G20_CLAIM_ADDS = [
  t('SalePostSaleGuard'),
  col('SalePostSaleGuard', 'createdAt'),
  col('SalePostSaleGuard', 'mode'),
  col('SalePostSaleGuard', 'saleId'),
  con('SalePostSaleGuard', 'SalePostSaleGuard_pkey', 'p'),
  con('SalePostSaleGuard', 'SalePostSaleGuard_saleId_fkey', 'f'),
  con('SalePostSaleGuard', 'chk_sale_post_sale_guard_mode', 'c'),
  idx('SalePostSaleGuard', 'SalePostSaleGuard_pkey'),
  fn('fn_sale_post_sale_claim'),
  trg('SaleExchange', 'trg_sale_exchange_post_sale_claim'),
  trg('SaleVoid', 'trg_sale_void_post_sale_claim'),
];

const withAbsence = (present, absent) => freeze([...present, ...absent.map(not)]);
export const GENERATION_PROBES_G20 = Object.freeze({
  EXACT_G16: withAbsence(GENERATION_PROBES_G19.EXACT_G16, G20_CLAIM_ADDS),
  EXACT_G17: withAbsence(GENERATION_PROBES_G19.EXACT_G17, G20_CLAIM_ADDS),
  EXACT_G18: withAbsence(GENERATION_PROBES_G19.EXACT_G18, G20_CLAIM_ADDS),
  EXACT_G19: withAbsence(GENERATION_PROBES_G19.EXACT_G19, G20_CLAIM_ADDS),
  EXACT_G20: freeze([...GENERATION_PROBES_G19.EXACT_G19, ...G20_CLAIM_ADDS]),
});

export const SCHEMA_REFERENCES_G20 = Object.freeze({
  ...SCHEMA_REFERENCES_G19,
  // Generated 2026-10-26 on a fresh disposable PostgreSQL 17.11 cluster, twice (identical); the G16 control reproduced 87ecc8d7…c7b3 and G17..G19 their pinned values.
  EXACT_G20: Object.freeze({ digest: '2f9527496aa8d4881ae345baaf8a6a678ca1127ec7319313a80850cffa2026a3', summary: Object.freeze({ tables: 36, columns: 343, enums: 18, types: 0, constraints: 193, indexes: 158, functions: 19, triggers: 25 }) }),
});
export const PENDING_REFERENCES = Object.freeze(Object.entries(SCHEMA_REFERENCES_G20).filter(([, r]) => r.pending === true).map(([g]) => g));

// The pair every tool of this rollout hands to verifySnapshot-style checks.
export const GENERATION_SCHEMA_G20 = Object.freeze({ references: SCHEMA_REFERENCES_G20, probes: GENERATION_PROBES_G20 });
