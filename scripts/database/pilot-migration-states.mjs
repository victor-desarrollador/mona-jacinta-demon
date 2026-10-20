// PILOT G12 cut-over: the single source of the twelve reviewed migration pins, the
// four authorizable EXACT ledger states and the strict ledger classifier every PILOT
// tool shares (pilot-migrate, pilot-a4-readonly, pilot-backup, pilot-clone-restore,
// the migration rehearsal). Builtins only, no I/O, nothing derived from disk: the pins
// are reviewed literals (tests recompute the real bytes), and a new or changed
// migration needs a fresh OWNER review and a new pin here.
//
// States (OWNER 2026-10-18, extended 2026-10-20): the last PILOT ledger the OWNER
// observed was S4, but it is not re-confirmed, so BOTH EXACT_S4 and EXACT_G7 are
// authorizable initial states. They are mutually exclusive and never auto-selected:
// every caller names the one state it expects (requireState). EXACT_G11 and EXACT_G12
// are preserved as historical exact ledgers; the only final state is EXACT_G12.
//
// "Exact" means: every ledger row is one of the pinned migrations, exactly one row per
// migration, finished, never rolled back, with the pinned checksum (Prisma's checksum
// is the SHA-256 of migration.sql), and the set of names is exactly the state's prefix.
// A gap, a mixed set, a G5/G6/G8/G9/G10/G11 prefix (when G12 is expected), a duplicate,
// an unknown name, a failed or rolled-back attempt (even one later retried) or any
// malformed row is refused.

export const MIGRATION_PINS = Object.freeze([
  Object.freeze({ name: '20260907015311_init', bytes: 17328, sha256: 'a584edab13a2ae540d694578ffa3b5a622decff04e238a5cf16d3040d295e4cb' }),
  Object.freeze({ name: '20260912182432_add_company_location', bytes: 1343, sha256: '19c345aa92c79a0a613dc03ea01dcf10e91b5a75fd6f3535076d8d71b6f740af' }),
  Object.freeze({ name: '20260912191702_add_user_role_scope', bytes: 2356, sha256: '2b415411eddc1212bf60419ce49022cea38d1fc2d12cb08938ad7c953caf7f3a' }),
  Object.freeze({ name: '20260922210000_d3_initial_stock_and_global_audit', bytes: 482, sha256: '62b3b169e06a48dc2e2a3f81cee11e02a809b2733db2453c5b9eef91c15f77cf' }),
  Object.freeze({ name: '20261002120000_block1_pricing_wholesale', bytes: 10096, sha256: '45cf8d080e8fa4ec0a8dab9c9e5d4b780eb1642f0a8992d43b57dff655250173' }),
  Object.freeze({ name: '20261006120000_pilot_pricing_v2', bytes: 3282, sha256: 'd948f74e9c0eed3ce959f5c0e6edea70871d7d5957275f3304922e31bab6df12' }),
  Object.freeze({ name: '20261012120000_cash_session_reconciliation', bytes: 390, sha256: 'd98b7ce082bff6810312866c81c26203146dff03c7a12e5f3bd6a595893fc47f' }),
  Object.freeze({ name: '20261016120000_r3_proportional_checkout', bytes: 15340, sha256: '217e87eb5b156a57a5edcfd73433e1e9558ce59caa019208d9df8c0268f08dc6' }),
  Object.freeze({ name: '20261016130000_r3_checkout_attempts', bytes: 35290, sha256: '076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148' }),
  Object.freeze({ name: '20261018120000_cash_movement_withdrawals_expenses', bytes: 2732, sha256: 'e37149442d1fb82ec87877e7b3e1f2e4311b36a9d47d314a3fd1843702c5adf9' }),
  Object.freeze({ name: '20261018180000_cash_movement_reversals', bytes: 3366, sha256: 'd638559da376f5c4fb1f71136027c0af426906b8b8a2c582f388e73ffd1b3770' }),
  Object.freeze({ name: '20261021120000_r3_card_credit', bytes: 11413, sha256: 'ccec6685120cc9236c5c95a57f2922dc5bbe09cf759ff21b4c9a3635d893f6be' }),
]);
export const LOCK_PIN = Object.freeze({ bytes: 128, sha256: '99836963713b4f5b269ad49af0ed3d7b0b2e336115c2f92dc9ac683d139d0900', provider: 'postgresql' });

const NAMES = MIGRATION_PINS.map((m) => m.name);
const CHECKSUM = new Map(MIGRATION_PINS.map((m) => [m.name, m.sha256]));
export const STATES = Object.freeze({
  EXACT_S4: Object.freeze(NAMES.slice(0, 4)),
  EXACT_G7: Object.freeze(NAMES.slice(0, 7)),
  EXACT_G11: Object.freeze(NAMES.slice(0, 11)),
  EXACT_G12: Object.freeze(NAMES.slice()),
});
export const INITIAL_STATES = Object.freeze(['EXACT_S4', 'EXACT_G7']);
export const FINAL_STATE = 'EXACT_G12';

// The ONLY ledger read, identical everywhere: four columns, no ordering or filtering in
// the database (classification happens here).
export const LEDGER_SQL = 'SELECT migration_name, checksum, (finished_at IS NOT NULL) AS finished, (rolled_back_at IS NOT NULL) AS rolled_back FROM ONLY public."_prisma_migrations"';

function assertState(state, allowed, label) {
  if (typeof state !== 'string' || !allowed.includes(state)) throw new Error(`unknown ${label} state`);
}

// The migrations an authorized initial state still needs to reach FINAL_STATE, in order.
export function pendingFor(initialState) {
  assertState(initialState, INITIAL_STATES, 'initial');
  return NAMES.slice(STATES[initialState].length);
}

// Classifies ledger rows (LEDGER_SQL shape) into exactly one of the four states, or
// refuses. Never throws; the reason never contains a row value.
export function classifyLedger(rows) {
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
  for (const [state, names] of Object.entries(STATES)) {
    if (names.length === seen.size && names.every((name) => seen.has(name))) return { ok: true, state };
  }
  return refuse('the ledger is not an exact S4, G7, G11 or G12 ledger');
}

// The ledger must be exactly the ONE state the caller names; another valid state is a refusal.
export function requireState(rows, expectedState) {
  assertState(expectedState, Object.keys(STATES), 'expected');
  const classified = classifyLedger(rows);
  if (!classified.ok) return classified;
  if (classified.state !== expectedState) {
    return { ok: false, state: null, reason: `the ledger is ${classified.state}, expected ${expectedState}` };
  }
  return classified;
}
