// PILOT USER-MGMT rollout (G20 -> G21 -> G22): the SHARED, I/O-light core of the three tools of this rollout (pilot-g22-preflight.mjs, pilot-g22-migrate.mjs,
// pilot-g22-verify.mjs). Builtins and the reviewed modules of the G20 rollout only; it never opens a socket by itself (every function takes the client or the
// snapshot it works on), never reads a credential and never writes: every statement it issues is a SELECT inside a REPEATABLE READ READ ONLY transaction.
//
//   - the READ-ONLY snapshot (ledger, app-schema projection, RBAC catalog, the data facts of this rollout), with the PILOT marker, verified TLS and
//     read-only proven, always ROLLBACK;
//   - the pure assessment of a SOURCE snapshot (assessSource): exactly EXACT_G20 (ledger AND schema), no case-insensitive e-mail collision, at least one
//     operative OWNER (active user holding OWNER at COMPANY scope), a classifiable RBAC catalog. Everything else fails closed with a named reason;
//   - the pure verification of a TARGET snapshot (verifyTarget): EXACT_G21 / EXACT_G22, the lower(email) unique index, the G21 defaults on every existing
//     user, and the frozen business counts unchanged;
//   - the two-step ORCHESTRATOR (runRollout): precheck -> apply G21 -> witness G21 -> re-check -> apply G22 -> verify G22, with the step runner injected.
//
// What the data facts are for: migration 22 aborts on a collision by itself (check_violation, nothing written), so the collision check here is an EARLY, readable
// refusal rather than the safety net; the safety net is the SQL. The frozen counts prove that these two additive migrations changed no operational data.
import { main as pilotMarkerMain } from './pilot-marker.mjs';
import { SNAPSHOT_SQL } from './pilot-migrate.mjs';
import { LEDGER_SQL } from './pilot-migration-states.mjs';
import { classifyGenerationLedger, requireGeneration } from './pilot-migration-generations.mjs';
import { CATALOG_SQL } from './pilot-rbac-catalog.mjs';
import { classifyCatalogGeneration } from './pilot-rbac-catalog-generations.mjs';
import { projectionDigest, projectionSummary, readProjection, runProbes } from './app-schema-projection.mjs';
import { GENERATION_SCHEMA_G22 } from './pilot-g22-schema-references.mjs';

export const SOURCE_GENERATION = 'EXACT_G20';
export const INTERMEDIATE_GENERATION = 'EXACT_G21';
export const TARGET_GENERATION = 'EXACT_G22';
// The Prisma ledger table has 8 columns and is one relation: the local-test fingerprint (360 columns, 38 relations) counts it, the app projection does not.
export const LEDGER_COLUMNS = 8;
export const EXPECTED_FINGERPRINT = Object.freeze({ columns: 360, relations: 38 });

// Business tables whose row counts are frozen across the rollout (the migrations are additive and must change no data).
export const FROZEN_COUNT_TABLES = Object.freeze(['User', 'UserRoleScope', 'Sale', 'SalePayment', 'CashSession', 'Inventory', 'StockMovement', 'SaleExchange', 'SaleVoid', 'AuditLog']);
export const COUNT_SQL = Object.freeze(Object.fromEntries(FROZEN_COUNT_TABLES.map((table) => [table, `SELECT count(*)::text AS n FROM ONLY public."${table}"`])));

// Every statement is a fixed literal; the search_path of the snapshot is pg_catalog, pg_temp, so every relation is schema-qualified.
export const FACT_SQL = Object.freeze({
  users: 'SELECT count(*)::text AS total, (count(*) FILTER (WHERE "isActive"))::text AS active, (count(*) FILTER (WHERE "email" <> lower("email")))::text AS non_lower FROM ONLY public."User"',
  collisionGroups: 'SELECT count(*)::text AS n FROM (SELECT 1 FROM ONLY public."User" GROUP BY lower("email") HAVING count(*) > 1) AS g',
  operativeOwners: 'SELECT count(DISTINCT u."id")::text AS n FROM ONLY public."User" u JOIN ONLY public."UserRoleScope" s ON s."userId" = u."id" JOIN ONLY public."Role" r ON r."id" = s."roleId" '
    + "WHERE u.\"isActive\" AND r.\"code\" = 'OWNER' AND s.\"scopeKind\"::text = 'COMPANY'",
  cashOpen: "SELECT count(*)::text AS n FROM ONLY public.\"CashSession\" WHERE \"status\"::text = 'OPEN'",
  salesDraft: "SELECT count(*)::text AS n FROM ONLY public.\"Sale\" WHERE \"status\"::text = 'DRAFT'",
  salesPendingPayment: "SELECT count(*)::text AS n FROM ONLY public.\"Sale\" WHERE \"status\"::text = 'PENDING_PAYMENT'",
  liveReservations: "SELECT count(*)::text AS n FROM ONLY public.\"StockReservation\" WHERE \"status\"::text = 'ACTIVE' AND \"expiresAt\" > pg_catalog.now()",
  ledgerColumns: "SELECT count(*)::text AS n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '_prisma_migrations'",
  lowerIndexDef: "SELECT indexdef FROM pg_catalog.pg_indexes WHERE schemaname = 'public' AND indexname = 'User_email_lower_key'",
  // Only valid once migration 21 exists (the caller asks for it); a G20 database has no such columns.
  userDefaults: 'SELECT count(*)::text AS total, (count(*) FILTER (WHERE "mustChangePassword"))::text AS must_change, (count(*) FILTER (WHERE "credentialsChangedAt" IS NOT NULL))::text AS credentials_set FROM ONLY public."User"',
  // Only valid once migration 22 exists.
  adminOperations: 'SELECT count(*)::text AS n FROM ONLY public."UserAdminOperation"',
});

const COUNT = /^(0|[1-9][0-9]{0,14})$/;
const toCount = (value) => {
  if (typeof value !== 'string' || !COUNT.test(value)) throw new Error('count');
  return Number(value);
};

// Reads the data facts of the rollout through `query(sql) -> rows` (already inside the read-only snapshot). `userDefaults` / `adminOperations` only after G21 / G22.
export async function readFacts(query, { userDefaults = false, adminOperations = false } = {}) {
  const one = async (key) => (await query(FACT_SQL[key]))?.[0];
  const users = await one('users');
  const facts = {
    users: { total: toCount(users?.total), active: toCount(users?.active), nonLower: toCount(users?.non_lower) },
    collisionGroups: toCount((await one('collisionGroups'))?.n),
    operativeOwners: toCount((await one('operativeOwners'))?.n),
    operation: {
      cashOpen: toCount((await one('cashOpen'))?.n),
      salesDraft: toCount((await one('salesDraft'))?.n),
      salesPendingPayment: toCount((await one('salesPendingPayment'))?.n),
      liveReservations: toCount((await one('liveReservations'))?.n),
    },
    ledgerColumns: toCount((await one('ledgerColumns'))?.n),
    lowerIndexDef: (await one('lowerIndexDef'))?.indexdef ?? null,
    counts: {},
  };
  for (const table of FROZEN_COUNT_TABLES) facts.counts[table] = toCount((await query(COUNT_SQL[table]))?.[0]?.n);
  if (userDefaults) {
    const d = await one('userDefaults');
    facts.userDefaults = { total: toCount(d?.total), mustChange: toCount(d?.must_change), credentialsSet: toCount(d?.credentials_set) };
  }
  if (adminOperations) facts.adminOperations = toCount((await one('adminOperations'))?.n);
  return facts;
}

// The snapshot core, on an already created client: connect is the caller's. `requireTls` defaults to true and the CLI wrappers never turn it off; it exists for the
// disposable loopback PostgreSQL of the tests only. Returns { ok, ledger, projection, catalog, facts } or { ok: false, reason } (a reason never carries a value).
export async function readSnapshotOn(client, { markerId, requireTls = true, userDefaults = false, adminOperations = false } = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (typeof markerId !== 'string' || markerId === '') return fail('a marker id is required');
  try {
    if (requireTls) {
      const stream = client.connection?.stream;
      if (stream?.encrypted !== true || stream?.authorized !== true) return fail('verified TLS is required');
    }
    await client.query(SNAPSHOT_SQL.begin);
    try {
      await client.query(SNAPSHOT_SQL.searchPath);
      for (const sql of SNAPSHOT_SQL.timeouts) await client.query(sql);
      if ((await client.query(SNAPSHOT_SQL.readOnly)).rows?.[0]?.read_only !== 'on') return fail('the snapshot transaction is not read-only');
      const marker = (await client.query(SNAPSHOT_SQL.marker)).rows ?? [];
      if (marker.length !== 1 || marker[0].marker_id !== markerId || marker[0].environment !== 'pilot') return fail('the PILOT marker is not the named one');
      const present = (await client.query(SNAPSHOT_SQL.ledgerPresent)).rows?.[0]?.present === true;
      const ledger = present ? (await client.query(LEDGER_SQL)).rows : [];
      const projection = await readProjection(client);
      const rows = async (sql) => (await client.query(sql)).rows ?? null;
      const catalog = { roles: await rows(CATALOG_SQL.roles), permissions: await rows(CATALOG_SQL.permissions), grants: await rows(CATALOG_SQL.grants) };
      const facts = await readFacts(rows, { userDefaults, adminOperations });
      return { ok: true, ledger, projection, catalog, facts };
    } finally {
      try { await client.query(SNAPSHOT_SQL.rollback); } catch { /* the connection is closed by the caller; nothing was written */ }
    }
  } catch (err) {
    return fail(typeof err?.message === 'string' && err.message.startsWith('projection: ') ? err.message : 'the read-only snapshot could not be read');
  }
}

// The wrapper the CLIs use: one verified client, one snapshot, always closed.
export async function readSnapshot(deps, conn, markerId, options = {}) {
  let client;
  try { client = deps.createClient(conn); } catch { return { ok: false, reason: 'a read-only client could not be created' }; }
  try {
    await client.connect();
    return await readSnapshotOn(client, { ...options, markerId, requireTls: true });
  } catch {
    return { ok: false, reason: 'the read-only snapshot could not be read' };
  } finally {
    try { await client.end(); } catch { /* already closed */ }
  }
}

// The audited PILOT identity proof (pilot-marker --check) on the held URL; `deps.proveIdentity` is a seam for the hermetic tests of the CLIs (the tools never expose it
// as an argument). Returns the exit code of the proof; anything but 0 stops the tool before another statement is issued.
export async function proveIdentity(deps, heldUrl, markerId, redact = (line) => line) {
  if (typeof deps.proveIdentity === 'function') return deps.proveIdentity(heldUrl, markerId);
  return pilotMarkerMain(['--target=pilot', '--check', `--marker-id=${markerId}`], {
    urlFile: deps.urlFile, readUrlFile: () => ({ ok: true, text: heldUrl }), env: deps.env, createClient: deps.createClient,
    log: (line) => deps.log(redact(line)), error: (line) => deps.error(redact(line)),
  });
}

// ---- source assessment (preflight, and the precheck of the migrator) ----------------------------------------------------------------------------------

// Reason codes, in the order they are decided. Each has a stable meaning; none carries a value from the database.
export const REASONS = Object.freeze({
  LEDGER_UNCLASSIFIED: 'the ledger is not an exact reviewed generation (failed, rolled-back, unfinished, unknown, drifted or partial migration rows)',
  ALREADY_G22: 'the ledger is already EXACT_G22: nothing to migrate',
  SOURCE_IS_G21: 'the ledger is EXACT_G21: the normal run refuses it; only an explicit resume (--expected-initial-state=EXACT_G21) may take it to G22',
  SOURCE_BEFORE_G20: 'the ledger is older than EXACT_G20: run the earlier rollouts first',
  STATE_MISMATCH: 'the ledger is a valid generation but not the one this run was told to expect',
  SCHEMA_DRIFT: 'the app schema is not the EXACT_G20 reference (digest or reviewed probes differ)',
  CATALOG_UNCLASSIFIED: 'the RBAC catalog is not a reviewed catalog generation',
  EMAIL_COLLISION: 'User.email collides case-insensitively: migration 22 would abort; resolve the duplicate accounts by hand first',
  NO_OPERATIVE_OWNER: 'there is no operative OWNER (active user with OWNER at COMPANY scope)',
});

// Pure. `snapshot` = { ledger, projection, catalog, facts }. Never repairs, never throws on malformed rows.
export function assessSource(snapshot, schema = GENERATION_SCHEMA_G22, source = SOURCE_GENERATION) {
  const reasons = [];
  const ledger = classifyGenerationLedger(snapshot.ledger);
  const digest = projectionDigest(snapshot.projection);
  const schemaGeneration = Object.entries(schema.references).find(([, ref]) => ref.digest === digest)?.[0] ?? null;
  const out = (extra = {}) => ({
    ledger, digest, schemaGeneration, catalog: classifyCatalogGeneration(snapshot.catalog), facts: snapshot.facts, reasons,
    warnings: warningsOf(snapshot.facts), verdict: reasons.length === 0 ? 'READY' : 'BLOCKED', ...extra,
  });
  if (!ledger.ok) { reasons.push('LEDGER_UNCLASSIFIED'); return out(); }
  if (ledger.state === 'EXACT_G22') { reasons.push('ALREADY_G22'); return out(); }
  if (ledger.state === 'EXACT_G21' && source !== 'EXACT_G21') { reasons.push('SOURCE_IS_G21'); return out(); }
  if (ledger.state !== source) { reasons.push(snapshot.ledger.length < 20 ? 'SOURCE_BEFORE_G20' : 'STATE_MISMATCH'); return out(); }
  const reference = schema.references[source]?.digest;
  const failures = runProbes(snapshot.projection, schema.probes[source] ?? []);
  if (digest !== reference || failures.length > 0) reasons.push('SCHEMA_DRIFT');
  const catalog = classifyCatalogGeneration(snapshot.catalog);
  if (!catalog.ok) reasons.push('CATALOG_UNCLASSIFIED');
  if (snapshot.facts.collisionGroups > 0) reasons.push('EMAIL_COLLISION');
  if (snapshot.facts.operativeOwners < 1) reasons.push('NO_OPERATIVE_OWNER');
  return out({ probeFailures: failures });
}

// Operational facts that make a maintenance window inconvenient; warnings, never blockers (the migrations are additive and take no long lock).
export function warningsOf(facts) {
  const w = [];
  if (facts.operation.cashOpen > 0) w.push(`${facts.operation.cashOpen} cash session(s) OPEN`);
  if (facts.operation.salesPendingPayment > 0) w.push(`${facts.operation.salesPendingPayment} sale(s) PENDING_PAYMENT`);
  if (facts.operation.liveReservations > 0) w.push(`${facts.operation.liveReservations} live stock reservation(s)`);
  return w;
}

// ---- counts ---------------------------------------------------------------------------------------------------------------------------------------

export function formatCounts(counts) {
  return JSON.stringify(Object.fromEntries(FROZEN_COUNT_TABLES.map((t) => [t, counts[t]])));
}

// Strict: exactly the frozen tables, each a non-negative safe integer. Returns { ok, counts } or { ok: false }.
export function parseCounts(text) {
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false };
    const keys = Object.keys(value).sort();
    if (keys.join(',') !== [...FROZEN_COUNT_TABLES].sort().join(',')) return { ok: false };
    for (const k of keys) if (!Number.isSafeInteger(value[k]) || value[k] < 0) return { ok: false };
    return { ok: true, counts: Object.fromEntries(FROZEN_COUNT_TABLES.map((t) => [t, value[t]])) };
  } catch { return { ok: false }; }
}

// The tables whose count differs: [{ table, before, after }]. AuditLog included: the rollout writes no audit row.
export function diffCounts(before, after) {
  return FROZEN_COUNT_TABLES.filter((t) => before[t] !== after[t]).map((table) => ({ table, before: before[table], after: after[table] }));
}

// ---- target verification (witness after G21, verifier after G22) ----------------------------------------------------------------------------------------

// Pure. `generation` is EXACT_G21 or EXACT_G22; `expectedCounts` the frozen counts taken before the first migration (null = not compared).
export function verifyTarget(snapshot, generation, { expectedCounts = null, schema = GENERATION_SCHEMA_G22, fingerprint = EXPECTED_FINGERPRINT } = {}) {
  const failures = [];
  const ledger = requireGeneration(snapshot.ledger, generation);
  if (!ledger.ok) return { ok: false, failures: [`ledger: ${ledger.reason}`], digest: null };
  const digest = projectionDigest(snapshot.projection);
  if (digest !== schema.references[generation]?.digest) failures.push(`the app schema is not the ${generation} reference`);
  for (const f of runProbes(snapshot.projection, schema.probes[generation] ?? [])) failures.push(f);
  const facts = snapshot.facts;
  const expectedMigrations = generation === 'EXACT_G22' ? 22 : 21;
  if (snapshot.ledger.length !== expectedMigrations) failures.push(`the ledger does not hold exactly ${expectedMigrations} migrations`);
  if (generation === 'EXACT_G22') {
    const summary = projectionSummary(snapshot.projection);
    if (summary.columns + facts.ledgerColumns !== fingerprint.columns) failures.push(`the fingerprint does not show ${fingerprint.columns} columns`);
    if (summary.tables + 1 !== fingerprint.relations) failures.push(`the fingerprint does not show ${fingerprint.relations} relations`);
    if (!/CREATE UNIQUE INDEX/.test(facts.lowerIndexDef ?? '') || !/lower\(/.test(facts.lowerIndexDef ?? '')) failures.push('User_email_lower_key is not a UNIQUE index on lower("email")');
    if (facts.adminOperations !== 0) failures.push('UserAdminOperation is not empty');
  }
  if (!facts.userDefaults || facts.userDefaults.total !== facts.users.total) failures.push('the G21 defaults could not be read for every user');
  else {
    if (facts.userDefaults.mustChange !== 0) failures.push('an existing user has mustChangePassword = true');
    if (facts.userDefaults.credentialsSet !== 0) failures.push('an existing user has credentialsChangedAt set');
  }
  if (expectedCounts) for (const d of diffCounts(expectedCounts, facts.counts)) failures.push(`count changed: ${d.table} ${d.before} -> ${d.after}`);
  return { ok: failures.length === 0, failures, digest };
}

// ---- the orchestrator ----------------------------------------------------------------------------------------------------------------------------------

// Never throws. `readSnapshotNow(options)` -> snapshot, `applyStep(generation)` -> { ok, started?, detail? } (applies exactly ONE migration generation). The
// outcome is { result, step, detail } where result is one of: MIGRATED (EXACT_G22 proven), REFUSED (nothing was applied), RESTORE_REQUIRED (something may be
// partially applied or unproven: never resolved, never retried, never repaired), RESUMABLE (the ledger is exactly EXACT_G21 after a failed G22 step: a new
// approved plan with --expected-initial-state=EXACT_G21 may continue).
export async function runRollout({ initialState, readSnapshotNow, applyStep, log = () => {}, schema = GENERATION_SCHEMA_G22, fingerprint = EXPECTED_FINGERPRINT }) {
  const refused = (step, detail) => ({ result: 'REFUSED', step, detail });
  const restore = (step, detail) => ({ result: 'RESTORE_REQUIRED', step, detail });
  if (initialState !== 'EXACT_G20' && initialState !== 'EXACT_G21') return refused('args', 'the initial state is exactly EXACT_G20 (or EXACT_G21 to resume)');

  const pre = await readSnapshotNow({});
  if (!pre.ok) return refused('precheck', pre.reason);
  const assessed = assessSource(pre, schema, initialState);
  if (assessed.verdict !== 'READY') return refused('precheck', assessed.reasons.join(','));
  const baseline = pre.facts.counts;
  log(`precheck ok — ledger ${initialState}, app schema = reference, ${pre.facts.users.total} users, ${pre.facts.operativeOwners} operative owner(s), 0 e-mail collisions`);

  // The step runner for ONE generation, then its witness: the ledger and schema are EXACTLY the generation, the data is untouched.
  const step = async (generation, label) => {
    const applied = await applyStep(generation);
    if (!applied.ok) {
      if (applied.started === false) {
        // The step never started. After a passed G21 witness the database is provably EXACT_G21: that is a recognised, resumable intermediate, not a bare refusal.
        if (generation === 'EXACT_G22' && initialState === 'EXACT_G20') return { result: 'RESUMABLE', step: label, detail: `${applied.detail ?? 'the step could not start'}; the G21 witness passed, so the database is exactly EXACT_G21` };
        return refused(label, `${applied.detail ?? 'the step could not start'}; nothing was applied`);
      }
      const seen = await readSnapshotNow({});
      const previous = generation === 'EXACT_G21' ? 'EXACT_G20' : 'EXACT_G21';
      if (seen.ok && requireGeneration(seen.ledger, previous).ok) {
        return { result: generation === 'EXACT_G22' ? 'RESUMABLE' : 'REFUSED', step: label, detail: `${applied.detail ?? 'the step failed'}; the ledger is still exactly ${previous}` };
      }
      return restore(label, `${applied.detail ?? 'the step failed'}; the ledger/schema is not provably ${previous}`);
    }
    const witness = await readSnapshotNow({ userDefaults: true, adminOperations: generation === 'EXACT_G22' });
    if (!witness.ok) return restore(label, witness.reason);
    const verdict = verifyTarget(witness, generation, { expectedCounts: baseline, schema, fingerprint });
    if (!verdict.ok) return restore(label, verdict.failures.join('; '));
    log(`${label} ok — ledger ${generation}, app schema ${verdict.digest} = reference, counts unchanged`);
    return { result: 'STEP_OK', step: label, snapshot: witness };
  };

  if (initialState === 'EXACT_G20') {
    const g21 = await step('EXACT_G21', 'G21');
    if (g21.result !== 'STEP_OK') return g21;
    // Between the two steps the early refusals are decided again on the fresh witness: a collision that appeared meanwhile stops before migration 22 runs.
    const again = assessSource(g21.snapshot, schema, 'EXACT_G21');
    if (again.verdict !== 'READY') return { result: 'REFUSED', step: 'G21-to-G22', detail: `${again.reasons.join(',')}; the database stays EXACT_G21 (a resume needs a new approved plan)` };
  }
  const g22 = await step('EXACT_G22', 'G22');
  if (g22.result !== 'STEP_OK') return g22;
  return { result: 'MIGRATED', step: 'G22', detail: 'EXACT_G22 proven', snapshot: g22.snapshot };
}
