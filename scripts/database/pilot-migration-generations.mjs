// Migration GENERATIONS after the G14 cut-over (sale void v1, then sale exchange v1). A separate module on
// purpose: pilot-migration-states.mjs, the G11 -> G14 cut-over state machine pinned by the OWNER-reviewed tool
// manifests, stays untouched, so every cut-over tool keeps its exact G14 target and code identity. This
// module only EXTENDS the G14 pins with the sale void and sale exchange migrations and classifies the generations.
// Builtins only, no I/O, nothing derived from disk: the pins are reviewed literals (tests recompute the bytes).
//
//   EXACT_G14 = m1..m14                    the frozen cut-over target of the PILOT tooling
//   EXACT_G15 = G14 + sale_void_enum       INTERMEDIATE: the two enum labels alone (never a target)
//   EXACT_G16 = G15 + sale_void_schema     the complete sale void schema: the previous LATEST, still a valid
//                                          historical generation (a database may legitimately stay at G16)
//   EXACT_G17 = G16 + sale_exchange_enum   INTERMEDIATE: the two StockMovementType labels alone (never a target)
//   EXACT_G18 = G17 + sale_exchange_schema INTERMEDIATE: SaleExchange / SaleExchangeLine / ledger guards, before
//                                          the void guard (never a target)
//   EXACT_G19 = G18 + sale_void_exchange_guard   a sale with exchanges cannot be voided (G19 tools still target it, literally)
//   EXACT_G20 = G19 + sale_post_sale_guard       the snapshot-independent claim table that closes the mixed-isolation race of the
//                                          void / exchange exclusion (audit H3): the LATEST generation
//
// The enum labels ship in their own migration because a label added by ALTER TYPE ... ADD VALUE cannot be used in
// the transaction that adds it. The SHA-256 is that of migration.sql, like every other pin (it is also what
// Prisma stores as the ledger checksum). A new or changed migration is a new generation and a new review.
import { MIGRATION_PINS } from './pilot-migration-states.mjs';

export const POST_G14_MIGRATION_PINS = Object.freeze([
  Object.freeze({ name: '20261024120000_sale_void_enum', bytes: 604, sha256: '82581170e1d9f5c2d4dd1d347e272f61b13cded2e20d623144ff72894c914c0f' }),
  Object.freeze({ name: '20261024130000_sale_void_schema', bytes: 11592, sha256: '0f2841cadaffac4579cf7f096329f899a8b7211a8cb4eb817770b8ee4911182d' }),
  Object.freeze({ name: '20261026120000_sale_exchange_enum', bytes: 670, sha256: '109881c4e0cb3733949f7a066d8bfe23998fe87ae68037186cc9ee5bba7d9785' }),
  Object.freeze({ name: '20261026130000_sale_exchange_schema', bytes: 17418, sha256: '1817b905585257ad916f2f0cefe271f89d5c7a2455e1383f17546a8389ead796' }),
  Object.freeze({ name: '20261026140000_sale_void_exchange_guard', bytes: 4050, sha256: '65a56d7bf9206d0424447ae8b88dfb0b6342a3a0e2303a0ab774c0a92545344f' }),
  Object.freeze({ name: '20261026150000_sale_post_sale_guard', bytes: 5396, sha256: '5924bb722676048489dd930bc1c90a36a8dda193ae77dc0368562989667deef5' }),
]);
export const GENERATION_MIGRATION_PINS = Object.freeze([...MIGRATION_PINS, ...POST_G14_MIGRATION_PINS]);

const NAMES = GENERATION_MIGRATION_PINS.map((m) => m.name);
const CHECKSUM = new Map(GENERATION_MIGRATION_PINS.map((m) => [m.name, m.sha256]));
export const GENERATIONS = Object.freeze({
  EXACT_G14: Object.freeze(NAMES.slice(0, 14)),
  EXACT_G15: Object.freeze(NAMES.slice(0, 15)),
  EXACT_G16: Object.freeze(NAMES.slice(0, 16)),
  EXACT_G17: Object.freeze(NAMES.slice(0, 17)),
  EXACT_G18: Object.freeze(NAMES.slice(0, 18)),
  EXACT_G19: Object.freeze(NAMES.slice(0, 19)),
  EXACT_G20: Object.freeze(NAMES.slice()),
});

export const CUTOVER_TARGET_GENERATION = 'EXACT_G14';
export const LATEST_GENERATION = 'EXACT_G20';
export const INTERMEDIATE_GENERATIONS = Object.freeze(['EXACT_G15', 'EXACT_G17', 'EXACT_G18', 'EXACT_G19']);

// The pins of one generation, in order (a fresh frozen array each call is unnecessary: they are frozen already).
export function pinsOf(generation) {
  if (typeof generation !== 'string' || !Object.hasOwn(GENERATIONS, generation)) throw new Error('unknown generation');
  return Object.freeze(GENERATION_MIGRATION_PINS.slice(0, GENERATIONS[generation].length));
}

// Classifies ledger rows (the LEDGER_SQL shape of pilot-migration-states.mjs) into EXACT_G14, EXACT_G15 or
// EXACT_G16 .. EXACT_G20, or refuses (fail-closed): a gap (a schema migration without its enum one), an unknown
// migration, a checksum drift, a duplicate, a rolled-back or unfinished attempt, any malformed row, or any
// older prefix. Never throws on rows; the reason never contains a row value. Same row rules as classifyLedger.
export function classifyGenerationLedger(rows) {
  const refuse = (reason) => ({ ok: false, state: null, reason });
  if (!Array.isArray(rows)) return refuse('the ledger could not be read');
  const seen = new Set();
  for (const row of rows) {
    if (row === null || typeof row !== 'object') return refuse('a ledger row is malformed');
    const { migration_name: name, checksum, finished, rolled_back: rolledBack } = row;
    if (typeof name !== 'string' || typeof checksum !== 'string' || typeof finished !== 'boolean' || typeof rolledBack !== 'boolean') {
      return refuse('a ledger row is malformed');
    }
    if (!CHECKSUM.has(name)) return refuse('the ledger holds an unknown migration');
    if (seen.has(name)) return refuse('the ledger holds more than one row for one migration');
    seen.add(name);
    if (rolledBack) return refuse('the ledger holds a rolled-back migration attempt');
    if (!finished) return refuse('the ledger holds an unfinished (failed or in-progress) migration');
    if (checksum !== CHECKSUM.get(name)) return refuse('a ledger checksum differs from its reviewed migration');
  }
  for (const [state, names] of Object.entries(GENERATIONS)) {
    if (names.length === seen.size && names.every((name) => seen.has(name))) return { ok: true, state };
  }
  return refuse('the ledger is not an exact G14 .. G20 ledger');
}

// The ledger must be exactly the ONE generation the caller names; another valid generation is a refusal.
export function requireGeneration(rows, expectedGeneration) {
  if (typeof expectedGeneration !== 'string' || !Object.hasOwn(GENERATIONS, expectedGeneration)) throw new Error('unknown expected generation');
  const classified = classifyGenerationLedger(rows);
  if (!classified.ok) return classified;
  if (classified.state !== expectedGeneration) {
    return { ok: false, state: null, reason: `the ledger is ${classified.state}, expected ${expectedGeneration}` };
  }
  return classified;
}
