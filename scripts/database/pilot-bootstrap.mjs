import { hash as oneShotHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CA_PATH, PROJECT_REF_PATTERN } from './lib.mjs';
import {
  PILOT_URL_FILE,
  createVerifiedClient,
  deriveProjectRef,
  main as pilotMarkerMain,
  parsePilotUrl,
  readPrivateUrlFile,
  safeCode,
} from './pilot-marker.mjs';

// OWNER-only, PILOT-only, ADDITIVE bootstrap of the minimum data needed to log in
// and operate the PILOT application. Separate from the DEMO seed/reset path.
//
//   node scripts/database/pilot-bootstrap.mjs --target=pilot --dry-run --marker-id=<uuid>
//   node scripts/database/pilot-bootstrap.mjs --target=pilot --execute --marker-id=<uuid> \
//     --confirm-project-ref=<ref>
//
// Inputs are three OWNER-private files (0600, owned, no symlink, bounded):
//   ~/.config/mona-jacinta/pilot-database-url   the only database target
//   ~/.config/mona-jacinta/pilot-bootstrap.json synthetic PILOT business data + user locations
//   ~/.config/mona-jacinta/pilot-credentials.json one password per account (never printed)
// PILOT business data is intentionally synthetic (OWNER decision): every name and
// address must carry the `PILOT` marker and Company.cuit must be the non-fiscal
// sentinel PILOT-NO-FISCAL; nothing here is real business or fiscal data.
//
// Execute: the URL is read once; the project ref must match; pilot-marker's
// audited --check proves the canonical PILOT marker on that held URL; then ONE
// Prisma transaction over the same URL (verified TLS) takes the maintenance
// advisory lock, re-checks the marker row, reads every touched table, and
// classifies the state. Absent → create only; exact → no-op; anything else →
// roll back. Writes are create/createMany only, reusing the canonical api/src
// RBAC catalog sync, grant matrix, system-actor bootstrap and password hashing
// (loaded in-process through the repo-local tsx). A post-write verification in
// the same transaction must find the exact canonical state before COMMIT.

export const PILOT_ACCOUNTS = Object.freeze(
  [
    ['propietario01@pilot.local', 'Propietario', 'OWNER', 'COMPANY'],
    ['administrador01@pilot.local', 'Administrador', 'ADMIN', 'COMPANY'],
    ['vendedor01@pilot.local', 'Vendedor 01', 'SELLER', 'LOCATION'],
    ['cajero01@pilot.local', 'Cajero 01', 'CASHIER', 'LOCATION'],
    ['deposito01@pilot.local', 'Depósito 01', 'WAREHOUSE', 'LOCATION'],
  ].map(([email, name, role, scope], i) =>
    Object.freeze({ id: `00000000-0000-4000-9700-00000000000${i + 1}`, email, name, role, scope }),
  ),
);

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CONFIG_DIR = path.join(os.homedir(), '.config', 'mona-jacinta');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'pilot-bootstrap.json');
export const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'pilot-credentials.json');
const LABEL = {
  url: '~/.config/mona-jacinta/pilot-database-url',
  config: '~/.config/mona-jacinta/pilot-bootstrap.json',
  credentials: '~/.config/mona-jacinta/pilot-credentials.json',
};
const PREFIX = '[db:pilot-bootstrap]';
const CUIT_SENTINEL = 'PILOT-NO-FISCAL';
const REGISTER_NAME = 'Caja principal';
// The shared maintenance advisory lock id (also taken by the canonical-owner and
// system-actor bootstraps), so maintenance operations serialize.
const MAINTENANCE_ADVISORY_LOCK_ID = 506005;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODES = ['dry-run', 'execute'];
const VALUE_ARGS = ['target', 'marker-id', 'confirm-project-ref', 'plan'];
const PLAN_DIGEST = /^[0-9a-f]{64}$/;
const LOCATION_ACCOUNTS = PILOT_ACCOUNTS.filter((a) => a.scope === 'LOCATION');
const EXPECTED_LOCATION_TYPE = { SELLER: 'RETAIL_BRANCH', CASHIER: 'RETAIL_BRANCH', WAREHOUSE: 'CENTRAL_WAREHOUSE' };
const DENIED_PASSWORDS = new Set(['demo123']);
const MARKER_RECHECK_SQL = `SELECT to_regnamespace('mona_test_guard') IS NOT NULL AS test_guard_exists,
  (SELECT coalesce(json_agg(json_build_object('environment', environment, 'marker_id', marker_id::text)), '[]'::json)
     FROM mona_pilot_guard.database_identity) AS rows`;

// --- H2: the OWNER-approved, non-secret bootstrap plan -----------------------------
//
// Dry-run prints the SHA-256 of this canonical plan; --execute must present the same
// digest (--plan=<hex>), and it is re-derived from the held, validated, frozen plan
// twice: before any DB access and again immediately before the write transaction.
// Serialization is explicit: a domain/version line, then JSON of nested ARRAYS only
// (no object-key order dependence); locations sorted by code; accounts in their fixed
// order; RBAC lists sorted. It binds the business topology, identities, roles,
// scopes, operational records, RBAC model, system actor, target (derived project ref
// + marker id) and — for credentials — ONLY the policy id and the exact 5-email key
// set. Never the URL/host/user/port, passwords, hashes, salts or any environment data:
// passwords are secrets, validated at execute time but not approved via the digest.
const PLAN_DOMAIN = 'mona-jacinta-pilot-bootstrap-plan-v1';
const CREDENTIAL_POLICY =
  'pilot-credentials-v1: one password per listed account; >=16 characters; <=72 UTF-8 bytes; no whitespace/control; distinct; not a demo password; not containing the login';
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalPlan({ markerId, projectRef, config, canonical, accounts = PILOT_ACCOUNTS }) {
  const c = config.company;
  const locations = [...config.locations].sort((a, b) => byString(a.code, b.code));
  const body = [
    ['target', 'pilot'],
    ['projectRef', projectRef],
    ['markerId', markerId],
    ['company', ['name', c.name], ['cuit', c.cuit], ['address', c.address], ['active', true]],
    ['locations', ...locations.map((l) => ['location', ['code', l.code], ['name', l.name], ['type', l.type], ['address', l.address], ['pointOfSaleNumber', l.pointOfSaleNumber], ['active', true]])],
    ['locationIdentity', 'one new uuid per location group; Location.id = Branch.id; Branch carries the same code, name, address and pointOfSaleNumber'],
    ['operational', ['cashRegisterName', REGISTER_NAME], ['cashRegistersPerLocation', 1], ['saleNumberCounterInitialValue', 1], ['saleNumberCountersPerLocation', 1]],
    ['accounts', ...accounts.map((a) => ['account', ['id', a.id], ['email', a.email], ['name', a.name], ['role', a.role], ['scopeKind', a.scope], ['locationCode', a.scope === 'COMPANY' ? null : config.assignments[a.email] ?? null], ['active', true]])],
    ['rbac',
      ['roles', ...[...canonical.roleCodeValues].sort(byString).map((code) => [code, canonical.CANONICAL_ROLE_IDS[code], code])],
      ['permissions', ...[...canonical.productionPermissionValues].sort(byString).map((code) => [code, canonical.CANONICAL_PERMISSION_IDS[code]])],
      ['grants', ...Object.keys(canonical.DEFAULT_ROLE_GRANTS).sort(byString).map((role) => [role, ...[...canonical.DEFAULT_ROLE_GRANTS[role]].sort(byString)])],
      ['ownerGrants', 'none (implicit authority)']],
    ['systemActor', ['id', canonical.SYSTEM_ACTOR_USER_ID], ['email', canonical.SYSTEM_ACTOR_EMAIL], ['name', canonical.SYSTEM_ACTOR_NAME], ['active', false], ['scopes', 0], ['secret', 'random, never output']],
    ['credentials', ['policy', CREDENTIAL_POLICY], ['accounts', ...accounts.map((a) => a.email)]],
    ['writes', 'additive only: create/createMany; absent → create, exact → no-op, anything else → rollback'],
  ];
  return `${PLAN_DOMAIN}\n${JSON.stringify(body)}\n`;
}

// UTF-8 bytes of the canonical plan → SHA-256, lowercase hex.
export const planDigest = (input) => oneShotHash('sha256', Buffer.from(canonicalPlan(input), 'utf8'), 'hex');

const deepFreeze = (value) => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};

// Exactly one --target=pilot, exactly one mode, a canonical marker id, and
// --confirm-project-ref only (and always) with --execute. Values are never echoed.
export function parseCliArgs(argv) {
  const values = {};
  const modes = [];
  for (const arg of argv) {
    if (!arg.startsWith('--')) return { ok: false, error: 'Unexpected positional argument (not echoed)' };
    const body = arg.slice(2);
    if (MODES.includes(body)) {
      modes.push(body);
      continue;
    }
    const eq = body.indexOf('=');
    const key = eq === -1 ? null : body.slice(0, eq);
    if (!key || !VALUE_ARGS.includes(key)) return { ok: false, error: 'Unknown argument (not echoed)' };
    if (key in values) return { ok: false, error: `--${key} may be given only once` };
    values[key] = body.slice(eq + 1);
  }
  if (modes.length !== 1) return { ok: false, error: 'Specify exactly one of --dry-run or --execute' };
  const [mode] = modes;
  if (values.target !== 'pilot') return { ok: false, error: 'Exactly --target=pilot is required' };
  if (values['marker-id'] === undefined || !UUID_V4.test(values['marker-id'])) {
    return { ok: false, error: '--marker-id must be a canonical lowercase version-4 UUID' };
  }
  const confirmProjectRef = values['confirm-project-ref'] ?? null;
  const plan = values.plan ?? null;
  if (mode === 'dry-run' && (confirmProjectRef !== null || plan !== null)) {
    return { ok: false, error: '--confirm-project-ref and --plan are accepted only with --execute' };
  }
  if (mode === 'execute' && (confirmProjectRef === null || !PROJECT_REF_PATTERN.test(confirmProjectRef))) {
    return { ok: false, error: '--execute requires --confirm-project-ref=<20-character lowercase project ref>' };
  }
  if (mode === 'execute' && (plan === null || !PLAN_DIGEST.test(plan))) {
    return { ok: false, error: '--execute requires --plan=<the exact 64-character lowercase sha256 printed by the reviewed --dry-run>' };
  }
  return { ok: true, mode, markerId: values['marker-id'], confirmProjectRef, plan };
}

// JSON with no duplicate keys (at any depth), no prototype keys, integers only.
// JSON.parse silently keeps the last duplicate, which would let a second value
// hide behind a reviewed first one. Errors never echo the input.
export function parseStrictJson(text) {
  let i = 0;
  const bad = () => {
    throw new Error('not strict JSON');
  };
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i += 1;
  };
  const string = () => {
    if (text[i] !== '"') bad();
    let j = i + 1;
    while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
    if (j >= text.length) bad();
    const token = text.slice(i, j + 1);
    i = j + 1;
    return JSON.parse(token);
  };
  const value = () => {
    ws();
    const c = text[i];
    if (c === '{') {
      i += 1;
      const obj = {};
      ws();
      if (text[i] === '}') {
        i += 1;
        return obj;
      }
      for (;;) {
        ws();
        const key = string();
        if (Object.hasOwn(obj, key) || key === '__proto__' || key === 'constructor' || key === 'prototype') bad();
        ws();
        if (text[i] !== ':') bad();
        i += 1;
        obj[key] = value();
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === '}') {
          i += 1;
          return obj;
        }
        bad();
      }
    }
    if (c === '[') {
      i += 1;
      const arr = [];
      ws();
      if (text[i] === ']') {
        i += 1;
        return arr;
      }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ',') {
          i += 1;
          continue;
        }
        if (text[i] === ']') {
          i += 1;
          return arr;
        }
        bad();
      }
    }
    if (c === '"') return string();
    const num = /^-?(0|[1-9]\d*)/.exec(text.slice(i));
    if (num) {
      i += num[0].length;
      if (i < text.length && '.eE'.includes(text[i])) bad();
      return Number(num[0]);
    }
    for (const [lit, v] of [['true', true], ['false', false], ['null', null]]) {
      if (text.startsWith(lit, i)) {
        i += lit.length;
        return v;
      }
    }
    return bad();
  };
  if (typeof text !== 'string') bad();
  const result = value();
  ws();
  if (i !== text.length) bad();
  return result;
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const exactKeys = (obj, keys) => isPlainObject(obj) && Object.keys(obj).length === keys.length && keys.every((k) => Object.hasOwn(obj, k));

// One password per account: exact key set, 16+ characters, at most 72 UTF-8
// bytes (bcrypt silently ignores the rest), no whitespace/control characters,
// all distinct, never a known demo password or the account's own login.
// Reasons name the account and rule only — never the value.
export function validateCredentials(value) {
  const emails = PILOT_ACCOUNTS.map((a) => a.email);
  if (!exactKeys(value, emails)) return { ok: false, reason: 'must hold exactly one password for each of the 5 PILOT accounts' };
  const seen = new Set();
  for (const email of emails) {
    const pw = value[email];
    const local = email.split('@')[0];
    if (typeof pw !== 'string') return { ok: false, reason: `${email}: password must be a string` };
    if ([...pw].length < 16) return { ok: false, reason: `${email}: password must have at least 16 characters` };
    if (Buffer.byteLength(pw, 'utf8') > 72) return { ok: false, reason: `${email}: password exceeds bcrypt's 72-byte limit` };
    if (/[\s\p{C}]/u.test(pw)) return { ok: false, reason: `${email}: password must not contain whitespace or control characters` };
    if (DENIED_PASSWORDS.has(pw.toLowerCase())) return { ok: false, reason: `${email}: password is a known demo password` };
    if (pw.toLowerCase().includes(local)) return { ok: false, reason: `${email}: password must not contain the account login` };
    if (seen.has(pw)) return { ok: false, reason: `${email}: passwords must be distinct per account` };
    seen.add(pw);
  }
  return { ok: true, passwords: new Map(emails.map((e) => [e, value[e]])) };
}

// Synthetic PILOT text: exact (untrimmed), bounded, no control characters,
// visibly marked PILOT, never a DEMO value.
function pilotText(v, what) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 200 || v !== v.trim() || /\p{C}/u.test(v)) {
    return `${what} must be a non-empty, untrimmed-safe string of at most 200 characters`;
  }
  if (!/\bPILOT\b/.test(v)) return `${what} must be visibly marked PILOT (synthetic data)`;
  if (/\bdemo\b/i.test(v)) return `${what} must not reuse DEMO data`;
  return null;
}

// Business config: synthetic company (CUIT sentinel), exactly one central
// warehouse plus 1-5 retail branches (FR-ORG-001 shape), and where each
// LOCATION-scoped account works (sellers/cashiers retail, depot the warehouse).
export function validateBusinessConfig(value) {
  const fail = (reason) => ({ ok: false, reason });
  if (!exactKeys(value, ['company', 'locations', 'assignments'])) return fail('top level must be exactly {company, locations, assignments}');
  const { company, locations, assignments } = value;
  if (!exactKeys(company, ['name', 'cuit', 'address'])) return fail('company must be exactly {name, cuit, address}');
  if (company.cuit !== CUIT_SENTINEL) return fail(`company.cuit must be the non-fiscal sentinel ${CUIT_SENTINEL}`);
  for (const key of ['name', 'address']) {
    const problem = pilotText(company[key], `company.${key}`);
    if (problem) return fail(problem);
  }
  if (!Array.isArray(locations) || locations.length < 2 || locations.length > 6) return fail('locations must list 2 to 6 locations');
  const codes = new Set();
  const pos = new Set();
  for (const [i, loc] of locations.entries()) {
    if (!exactKeys(loc, ['code', 'name', 'type', 'address', 'pointOfSaleNumber'])) {
      return fail(`locations[${i}] must be exactly {code, name, type, address, pointOfSaleNumber}`);
    }
    if (typeof loc.code !== 'string' || !/^[A-Z]{2,6}$/.test(loc.code)) return fail(`locations[${i}].code must be 2-6 uppercase letters`);
    if (!['RETAIL_BRANCH', 'CENTRAL_WAREHOUSE'].includes(loc.type)) return fail(`locations[${i}].type must be RETAIL_BRANCH or CENTRAL_WAREHOUSE`);
    if (!Number.isInteger(loc.pointOfSaleNumber) || loc.pointOfSaleNumber < 1 || loc.pointOfSaleNumber > 99999) {
      return fail(`locations[${i}].pointOfSaleNumber must be an integer from 1 to 99999`);
    }
    for (const key of ['name', 'address']) {
      const problem = pilotText(loc[key], `locations[${i}].${key}`);
      if (problem) return fail(problem);
    }
    if (codes.has(loc.code)) return fail(`location code ${loc.code} is duplicated`);
    if (pos.has(loc.pointOfSaleNumber)) return fail(`pointOfSaleNumber ${loc.pointOfSaleNumber} is duplicated`);
    codes.add(loc.code);
    pos.add(loc.pointOfSaleNumber);
  }
  const warehouses = locations.filter((l) => l.type === 'CENTRAL_WAREHOUSE').length;
  const retail = locations.length - warehouses;
  if (warehouses !== 1 || retail < 1 || retail > 5) return fail('locations must be exactly 1 CENTRAL_WAREHOUSE and 1-5 RETAIL_BRANCH');
  if (!exactKeys(assignments, LOCATION_ACCOUNTS.map((a) => a.email))) {
    return fail(`assignments must name a location for exactly: ${LOCATION_ACCOUNTS.map((a) => a.email).join(', ')}`);
  }
  for (const account of LOCATION_ACCOUNTS) {
    const loc = locations.find((l) => l.code === assignments[account.email]);
    if (!loc) return fail(`${account.email} is assigned to an unknown location code`);
    if (loc.type !== EXPECTED_LOCATION_TYPE[account.role]) {
      return fail(`${account.email} (${account.role}) must be assigned to a ${EXPECTED_LOCATION_TYPE[account.role]}`);
    }
  }
  return { ok: true, config: structuredClone(value) };
}

// --- classification (pure, read-only) -------------------------------------------

const key = (...parts) => parts.map(String).join('|');
function sameSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  const a = [...actual].sort();
  const e = [...expected].sort();
  return a.every((v, i) => v === e[i]);
}

// Classifies the rows this bootstrap owns against the config. Anchor = RBAC
// catalog + Company + the 5 accounts (with scopes) + system actor: uniformly
// ABSENT or EXACT. Each location group (Branch + Location with the same id +
// one 'Caja principal' register + one sale counter) is ABSENT or EXACT, and may
// only exist beside an EXACT anchor. Unknown rows in any touched table, and any
// partial or deviating state, are conflicts. Nothing is ever "repaired".
export function classifyPilotState(s, config, canonical) {
  const conflicts = [];
  const conflict = (msg) => conflicts.push(msg);

  // RBAC catalog: empty, or exactly the canonical rows/grants (no extras, no OWNER grants).
  const catalogEmpty = s.roles.length === 0 && s.permissions.length === 0 && s.grants.length === 0;
  const expectedRoles = canonical.roleCodeValues.map((c) => key(canonical.CANONICAL_ROLE_IDS[c], c, c));
  const expectedPerms = canonical.productionPermissionValues.map((c) => key(canonical.CANONICAL_PERMISSION_IDS[c], c));
  const expectedGrants = Object.entries(canonical.DEFAULT_ROLE_GRANTS).flatMap(([role, codes]) =>
    codes.map((c) => key(canonical.CANONICAL_ROLE_IDS[role], canonical.CANONICAL_PERMISSION_IDS[c])),
  );
  const catalogExact =
    sameSet(s.roles.map((r) => key(r.id, r.code, r.name)), expectedRoles) &&
    sameSet(s.permissions.map((p) => key(p.id, p.code)), expectedPerms) &&
    sameSet(s.grants.map((g) => key(g.roleId, g.permissionId)), expectedGrants);
  const catalog = catalogEmpty ? 'ABSENT' : catalogExact ? 'EXACT' : 'CONFLICT';
  if (catalog === 'CONFLICT') conflict('RBAC catalog is partial or differs from the canonical roles/permissions/grants');

  // Company.
  const c = config.company;
  let companyState = 'ABSENT';
  const company = s.companies.length === 1 ? s.companies[0] : null;
  if (s.companies.length > 1) {
    companyState = 'CONFLICT';
    conflict('more than one Company row exists');
  } else if (company) {
    const exact = company.name === c.name && company.cuit === c.cuit && company.address === c.address && company.isActive === true;
    companyState = exact ? 'EXACT' : 'CONFLICT';
    if (!exact) conflict('the existing Company differs from the configured PILOT company');
  }

  // Location groups.
  const cfgCodes = new Set(config.locations.map((l) => l.code));
  for (const row of [...s.branches, ...s.locations]) {
    if (!cfgCodes.has(row.code)) conflict(`unexpected Branch/Location ${row.code} not in the PILOT config`);
  }
  const branchIds = new Set(s.branches.map((b) => b.id));
  for (const row of [...s.registers, ...s.counters]) {
    if (!branchIds.has(row.branchId)) conflict('a cash register or sale counter references an unknown branch');
  }
  const groups = new Map();
  const locationIds = new Map();
  for (const l of config.locations) {
    const b = s.branches.filter((x) => x.code === l.code);
    const loc = s.locations.filter((x) => x.code === l.code);
    if (b.length === 0 && loc.length === 0) {
      groups.set(l.code, 'ABSENT');
      continue;
    }
    const [branch] = b;
    const [location] = loc;
    const registers = branch ? s.registers.filter((r) => r.branchId === branch.id) : [];
    const counters = branch ? s.counters.filter((r) => r.branchId === branch.id) : [];
    const exact =
      b.length === 1 && loc.length === 1 && location.id === branch.id &&
      branch.name === l.name && branch.address === l.address && branch.pointOfSaleNumber === l.pointOfSaleNumber &&
      location.name === l.name && location.address === l.address && location.pointOfSaleNumber === l.pointOfSaleNumber &&
      location.type === l.type && location.isActive === true && company !== null && location.companyId === company.id &&
      registers.length === 1 && registers[0].name === REGISTER_NAME && counters.length === 1;
    groups.set(l.code, exact ? 'EXACT' : 'CONFLICT');
    if (exact) locationIds.set(l.code, location.id);
    else conflict(`location group ${l.code} is partial or differs from the PILOT config`);
  }

  // Accounts, scopes, legacy rows, system actor, unknown users.
  const actorId = canonical.SYSTEM_ACTOR_USER_ID;
  const knownIds = new Set([...PILOT_ACCOUNTS.map((a) => a.id), actorId]);
  const knownEmails = new Set([...PILOT_ACCOUNTS.map((a) => a.email), canonical.SYSTEM_ACTOR_EMAIL]);
  for (const u of s.users) {
    if (!knownIds.has(u.id) && !knownEmails.has(u.email)) conflict('an unexpected User row exists');
  }
  if (s.legacy.length > 0) conflict('legacy UserBranchRole rows exist');
  const accountStates = PILOT_ACCOUNTS.map((a) => {
    const byEmail = s.users.find((u) => u.email === a.email);
    const byId = s.users.find((u) => u.id === a.id);
    if (!byEmail && !byId) return 'ABSENT';
    if (byEmail && byId && byEmail === byId && byId.name === a.name && byId.isActive === true) return 'EXACT';
    conflict(`${a.email}: existing identity differs (id, email, name or active state)`);
    return 'CONFLICT';
  });
  const presentIds = new Set(PILOT_ACCOUNTS.filter((_, i) => accountStates[i] === 'EXACT').map((a) => a.id));
  for (const scope of s.scopes) {
    if (!presentIds.has(scope.userId)) conflict('a UserRoleScope row exists for a user this bootstrap does not own or has not created');
  }
  for (const [i, a] of PILOT_ACCOUNTS.entries()) {
    if (accountStates[i] !== 'EXACT') continue;
    const mine = s.scopes.filter((x) => x.userId === a.id);
    const locationId = a.scope === 'COMPANY' ? null : locationIds.get(config.assignments[a.email]) ?? '(missing)';
    const ok =
      mine.length === 1 && mine[0].roleId === canonical.CANONICAL_ROLE_IDS[a.role] &&
      mine[0].scopeKind === a.scope && mine[0].locationId === locationId;
    if (!ok) conflict(`${a.email}: role scope differs from ${a.role} ${a.scope === 'COMPANY' ? 'COMPANY' : `LOCATION ${config.assignments[a.email]}`}`);
  }
  const users = accountStates.every((x) => x === 'ABSENT') ? 'ABSENT' : accountStates.every((x) => x === 'EXACT') ? 'EXACT' : 'CONFLICT';
  if (users === 'CONFLICT' && !accountStates.includes('CONFLICT')) conflict('only some PILOT accounts exist (partial bootstrap)');

  const actorById = s.users.find((u) => u.id === actorId);
  const actorByEmail = s.users.find((u) => u.email === canonical.SYSTEM_ACTOR_EMAIL);
  let actor = 'ABSENT';
  if (actorById || actorByEmail) {
    const valid = actorById && actorById === actorByEmail && actorById.name === canonical.SYSTEM_ACTOR_NAME && actorById.isActive === false;
    actor = valid ? 'EXACT' : 'CONFLICT';
    if (!valid) conflict('the system actor exists but is not canonical (identity, name or active state)');
  }

  const parts = { catalog, company: companyState, users, actor };
  const values = Object.values(parts);
  let anchor = values.every((x) => x === 'ABSENT') ? 'ABSENT' : values.every((x) => x === 'EXACT') ? 'EXACT' : 'CONFLICT';
  if (anchor === 'CONFLICT' && !values.includes('CONFLICT')) {
    conflict(`partial bootstrap: ${Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  }
  if (anchor === 'ABSENT' && [...groups.values()].some((g) => g !== 'ABSENT')) {
    conflict('location rows exist without the rest of the PILOT bootstrap (partial bootstrap)');
    anchor = 'CONFLICT';
  }
  return { conflicts, anchor, groups, company, locationIds, parts };
}

// --- canonical modules (in-process, repo-local tsx) ------------------------------

async function tsImport(rel) {
  const api = await import(pathToFileURL(path.join(ROOT, 'api/node_modules/tsx/dist/esm/api/index.mjs')).href);
  return api.tsImport(pathToFileURL(path.join(ROOT, rel)).href, import.meta.url);
}

export async function loadCanonical() {
  const catalog = await tsImport('api/src/modules/rbac/catalog.service.ts');
  const matrix = await tsImport('api/src/modules/rbac/role-permission-matrix.ts');
  const roles = await tsImport('api/src/modules/rbac/roles.ts');
  const permissions = await tsImport('api/src/modules/rbac/permissions.ts');
  const actor = await tsImport('api/src/modules/audit/system-actor.service.ts');
  const password = await tsImport('api/src/modules/auth/password.ts');
  return {
    syncProductionRbacCatalog: catalog.syncProductionRbacCatalog,
    verifyProductionRbacCatalog: catalog.verifyProductionRbacCatalog,
    CANONICAL_ROLE_IDS: catalog.CANONICAL_ROLE_IDS,
    CANONICAL_PERMISSION_IDS: catalog.CANONICAL_PERMISSION_IDS,
    DEFAULT_ROLE_GRANTS: matrix.DEFAULT_ROLE_GRANTS,
    roleCodeValues: roles.roleCodeValues,
    productionPermissionValues: permissions.productionPermissionValues,
    planSystemActorBootstrap: actor.planSystemActorBootstrap,
    bootstrapSystemActor: actor.bootstrapSystemActor,
    SYSTEM_ACTOR_USER_ID: actor.SYSTEM_ACTOR_USER_ID,
    SYSTEM_ACTOR_EMAIL: actor.SYSTEM_ACTOR_EMAIL,
    SYSTEM_ACTOR_NAME: actor.SYSTEM_ACTOR_NAME,
    hashPassword: password.hashPassword,
    BCRYPT_ROUNDS: password.BCRYPT_ROUNDS,
  };
}

// Prisma over the SAME held connection fields as the proof, with the same
// verified-TLS trust anchor (explicit CA, rejectUnauthorized) — never a URL
// string, so no query/libpq override can apply.
async function createPilotPrisma(conn) {
  const { PrismaClient } = await tsImport('api/src/generated/prisma/client.ts');
  const require = createRequire(path.join(ROOT, 'api', 'package.json'));
  const { PrismaPg } = await import(pathToFileURL(require.resolve('@prisma/adapter-pg')).href);
  const adapter = new PrismaPg({
    ...conn,
    ssl: { rejectUnauthorized: true, ca: readFileSync(CA_PATH, 'utf8'), servername: conn.host },
    connectionTimeoutMillis: 10000,
  });
  return new PrismaClient({ adapter, log: [] });
}

// --- transaction body ----------------------------------------------------------

class Stop extends Error {
  constructor(phase, reason) {
    super(reason);
    this.phase = phase;
  }
}

async function readSnapshot(tx) {
  return {
    roles: await tx.role.findMany({ select: { id: true, code: true, name: true } }),
    permissions: await tx.permission.findMany({ select: { id: true, code: true } }),
    grants: await tx.rolePermission.findMany({ select: { roleId: true, permissionId: true } }),
    companies: await tx.company.findMany({ select: { id: true, name: true, cuit: true, address: true, isActive: true } }),
    branches: await tx.branch.findMany({ select: { id: true, code: true, name: true, address: true, pointOfSaleNumber: true } }),
    locations: await tx.location.findMany({
      select: { id: true, companyId: true, code: true, name: true, type: true, address: true, pointOfSaleNumber: true, isActive: true },
    }),
    registers: await tx.cashRegister.findMany({ select: { id: true, branchId: true, name: true } }),
    counters: await tx.saleNumberCounter.findMany({ select: { id: true, branchId: true } }),
    // Least privilege: never passwordHash.
    users: await tx.user.findMany({ select: { id: true, email: true, name: true, isActive: true } }),
    scopes: await tx.userRoleScope.findMany({ select: { id: true, userId: true, roleId: true, scopeKind: true, locationId: true } }),
    legacy: await tx.userBranchRole.findMany({ select: { id: true } }),
  };
}

// Runs the canonical system-actor bootstrap inside THIS transaction: its own
// `$transaction(fn)` becomes `fn(tx)`, so nothing commits separately.
const inline = (tx) => new Proxy(tx, { get: (target, prop) => (prop === '$transaction' ? (fn) => fn(target) : target[prop]) });

async function bootstrapTransaction(tx, { config, passwords, markerId, canonical }) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${MAINTENANCE_ADVISORY_LOCK_ID})::text`;

  // Bind the write session itself to the marker proven moments ago.
  const [marker] = await tx.$queryRawUnsafe(MARKER_RECHECK_SQL);
  // json_agg may arrive decoded or as JSON text, depending on the driver adapter.
  let rows = marker?.rows;
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows);
    } catch {
      rows = null;
    }
  }
  if (!Array.isArray(rows)) rows = [];
  if (marker?.test_guard_exists !== false || rows.length !== 1 || rows[0].environment !== 'pilot' || rows[0].marker_id !== markerId) {
    throw new Stop('conflict', 'the write session does not see exactly the proven PILOT marker (or sees a TEST marker)');
  }

  const before = classifyPilotState(await readSnapshot(tx), config, canonical);
  const actorPlan = await canonical.planSystemActorBootstrap(tx);
  if (before.conflicts.length === 0) {
    const expected = before.anchor === 'ABSENT' ? 'ABSENT' : 'VALID';
    if (actorPlan.state !== expected) before.conflicts.push('canonical system-actor planner disagrees with the expected state');
  }
  if (before.conflicts.length > 0) {
    throw new Stop('conflict', `${before.conflicts[0]}${before.conflicts.length > 1 ? ` (+${before.conflicts.length - 1} more)` : ''}; nothing was written`);
  }
  const absentGroups = config.locations.filter((l) => before.groups.get(l.code) === 'ABSENT');
  if (before.anchor === 'EXACT' && absentGroups.length === 0) return { action: 'NOOP' };

  const created = { catalog: false, company: false, locations: [], accounts: [], systemActor: false };
  let companyId = before.company?.id;
  if (before.anchor === 'ABSENT') {
    await canonical.syncProductionRbacCatalog(tx);
    companyId = randomUUID();
    await tx.company.create({ data: { id: companyId, name: config.company.name, cuit: config.company.cuit, address: config.company.address }, select: { id: true } });
    created.catalog = true;
    created.company = true;
  }
  const locationIds = new Map(before.locationIds);
  for (const l of absentGroups) {
    const id = randomUUID();
    await tx.branch.create({ data: { id, code: l.code, name: l.name, address: l.address, pointOfSaleNumber: l.pointOfSaleNumber }, select: { id: true } });
    await tx.location.create({
      data: { id, companyId, code: l.code, name: l.name, type: l.type, address: l.address, pointOfSaleNumber: l.pointOfSaleNumber },
      select: { id: true },
    });
    await tx.cashRegister.create({ data: { branchId: id, name: REGISTER_NAME }, select: { id: true } });
    await tx.saleNumberCounter.create({ data: { branchId: id, nextValue: 1n }, select: { id: true } });
    locationIds.set(l.code, id);
    created.locations.push(l.code);
  }
  if (before.anchor === 'ABSENT') {
    for (const a of PILOT_ACCOUNTS) {
      const passwordHash = await canonical.hashPassword(passwords.get(a.email));
      await tx.user.create({ data: { id: a.id, email: a.email, name: a.name, passwordHash }, select: { id: true } });
      await tx.userRoleScope.create({
        data: {
          userId: a.id,
          roleId: canonical.CANONICAL_ROLE_IDS[a.role],
          scopeKind: a.scope,
          locationId: a.scope === 'COMPANY' ? null : locationIds.get(config.assignments[a.email]),
        },
        select: { id: true },
      });
      created.accounts.push(a);
    }
    await canonical.bootstrapSystemActor(inline(tx), {
      createPasswordHash: () => canonical.hashPassword(randomBytes(48).toString('base64url')),
    });
    created.systemActor = true;
  }

  // Post-write verification in the same transaction, independent of the writes above.
  const after = classifyPilotState(await readSnapshot(tx), config, canonical);
  const catalogCheck = await canonical.verifyProductionRbacCatalog(tx);
  const actorCheck = await canonical.planSystemActorBootstrap(tx);
  const allExact = after.anchor === 'EXACT' && [...after.groups.values()].every((g) => g === 'EXACT');
  if (after.conflicts.length > 0 || !allExact || !catalogCheck.ok || actorCheck.state !== 'VALID') {
    throw new Stop('verify', `post-write verification failed (${after.conflicts[0] ?? 'state not exact'}); rolled back`);
  }
  return { action: 'CREATED', created };
}

// --- CLI -------------------------------------------------------------------------

const defaultDeps = {
  urlFile: PILOT_URL_FILE,
  configFile: CONFIG_FILE,
  credentialsFile: CREDENTIALS_FILE,
  readPrivateFile: (file) => readPrivateUrlFile(file),
  env: process.env,
  createClient: createVerifiedClient,
  createPrisma: createPilotPrisma,
  loadCanonical,
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function main(argv, deps = defaultDeps) {
  const d = { ...defaultDeps, ...deps };
  const fail = (phase, detail, code) => {
    d.error(`${PREFIX} FAIL: phase=${phase}${code ? ` code=${code}` : ''} — ${detail}`);
    return 1;
  };
  const readPrivate = (file, label) => {
    let result;
    try {
      result = d.readPrivateFile(file);
    } catch {
      result = { ok: false, reason: 'private URL file could not be read' };
    }
    if (!result.ok) return { ok: false, reason: `${label}: ${String(result.reason).replace('private URL file', 'file')}` };
    return result;
  };
  const readJson = (file, label) => {
    const read = readPrivate(file, label);
    if (!read.ok) return read;
    try {
      return { ok: true, value: parseStrictJson(read.text) };
    } catch {
      return { ok: false, reason: `${label}: not strict JSON (duplicate keys and non-integer numbers are refused; content not shown)` };
    }
  };

  const parsed = parseCliArgs(argv);
  if (!parsed.ok) return fail('args', parsed.error);

  const urlRead = readPrivate(d.urlFile, LABEL.url);
  if (!urlRead.ok) return fail('config', urlRead.reason);
  const heldUrl = urlRead.text.replace(/\r?\n$/, '');
  const url = parsePilotUrl(heldUrl);
  if (!url.ok) return fail('config', `${LABEL.url} must hold one PostgreSQL URL with user, password, host and database (value not shown)`);

  const cfgRead = readJson(d.configFile, LABEL.config);
  if (!cfgRead.ok) return fail('config', `${cfgRead.reason} — the OWNER supplies this synthetic PILOT business config`);
  const cfg = validateBusinessConfig(cfgRead.value);
  if (!cfg.ok) return fail('config', `${LABEL.config}: ${cfg.reason}`);
  const credRead = readJson(d.credentialsFile, LABEL.credentials);
  if (!credRead.ok) return fail('config', credRead.reason);
  const creds = validateCredentials(credRead.value);
  if (!creds.ok) return fail('config', `${LABEL.credentials}: ${creds.reason}`);
  // Held, immutable inputs for the whole invocation: never re-read from disk.
  const config = deepFreeze(cfg.config);
  const projectRef = deriveProjectRef(url.conn);
  const derivable = projectRef !== null;
  let canonical;
  try {
    canonical = await d.loadCanonical();
  } catch {
    return fail('config', 'the canonical RBAC/system-actor modules could not be loaded');
  }
  const planInput = Object.freeze({ markerId: parsed.markerId, projectRef, config, canonical });
  const digest = planDigest(planInput);

  if (parsed.mode === 'dry-run') {
    const scopeOf = (a) => (a.scope === 'COMPANY' ? 'COMPANY' : `LOCATION ${config.assignments[a.email]}`);
    for (const line of [
      `${PREFIX} DRY RUN — no database connection was opened and nothing was written`,
      '  target: PILOT',
      `  private URL file: accepted (${LABEL.url}; value not shown)`,
      derivable ? '  project identity: derivable from the URL (value not shown)' : '  project identity: NOT derivable from the URL — --execute will refuse',
      `  marker id: ${parsed.markerId} (proven against the database only during --execute)`,
      `  credentials: 5 accounts, shape accepted (values not shown) — ${LABEL.credentials}`,
      `  company: "${config.company.name}" — synthetic PILOT data, CUIT sentinel ${CUIT_SENTINEL} (non-fiscal)`,
      '  all business values are synthetic PILOT data, not real business or fiscal data',
      '  locations (Branch + Location with the same id, one "Caja principal" register, one sale counter each):',
      ...config.locations.map((l) => `    ${l.code}  ${l.type}  "${l.name}"  POS ${l.pointOfSaleNumber}`),
      '  accounts (email  "visible name"  internal role  scope):',
      ...PILOT_ACCOUNTS.map((a) => `    ${a.email}  "${a.name}"  ${a.role}  ${scopeOf(a)}`),
      '  also: canonical Production RBAC catalog (5 roles, permissions, default grants) and the inactive system actor',
      '  additive only: absent → create; exact existing → no-op; anything partial or different → rollback, nothing written',
      '  no seed, no reset, no deletes, no updates, no migration; passwords hashed only during --execute',
      '  the plan digest binds: target, derived project ref, marker id, company, locations, accounts/roles/scopes,',
      '    registers/counters, RBAC model, system actor, credential key set + policy (never passwords or DB secrets)',
      `  plan sha256: ${digest}`,
      `  OWNER approval token: --plan=${digest}`,
      '  --execute requires this exact digest via --plan=...; any change to the plan above yields a different digest',
      '  passwords are validated again at --execute and are NOT part of the digest',
      '  STILL REQUIRED before --execute: explicit OWNER approval naming PILOT',
    ]) d.log(line);
    return 0;
  }

  if (d.env?.DEBUG !== undefined) return fail('config', 'DEBUG is set; unset it (debug output could expose query parameters)');
  // First plan comparison: before any database access, hashing or write.
  if (digest !== parsed.plan) {
    return fail('plan', 'this business plan/target does not match the approved --plan digest; re-run --dry-run and review (nothing was opened or written)');
  }
  if (projectRef !== parsed.confirmProjectRef) {
    return fail('target', `--confirm-project-ref does not match the project addressed by ${LABEL.url} (values not shown)`);
  }

  const proof = await pilotMarkerMain(['--target=pilot', '--check', `--marker-id=${parsed.markerId}`], {
    urlFile: d.urlFile,
    readUrlFile: () => ({ ok: true, text: heldUrl }),
    env: d.env,
    createClient: d.createClient,
    log: (line) => d.log(line),
    error: (line) => d.error(line),
  });
  if (proof !== 0) return fail('identity', 'PILOT identity proof failed; nothing was written');

  // Second plan comparison, re-derived from the held plan immediately before the
  // write transaction (no disk re-read): in-process drift stops here.
  if (planDigest(planInput) !== parsed.plan) {
    return fail('plan', 'the held plan no longer matches the approved --plan digest; nothing was written');
  }

  const secrets = [url.conn.password, url.conn.host, url.conn.user, heldUrl, ...creds.passwords.values()];
  let prisma;
  try {
    prisma = await d.createPrisma(url.conn);
    const result = await prisma.$transaction(
      (tx) => bootstrapTransaction(tx, { config, passwords: creds.passwords, markerId: parsed.markerId, canonical }),
      { timeout: 120000, maxWait: 10000 },
    );
    if (result.action === 'NOOP') {
      d.log(`${PREFIX} OK — PILOT already bootstrapped exactly as configured; nothing was written`);
      return 0;
    }
    const { created } = result;
    d.log(`${PREFIX} OK — PILOT bootstrap committed (one transaction, additive only)`);
    if (created.catalog) d.log('  RBAC catalog: created (canonical roles, permissions, default grants)');
    if (created.company) d.log(`  company: "${config.company.name}" (synthetic, CUIT sentinel ${CUIT_SENTINEL})`);
    if (created.locations.length) d.log(`  locations created: ${created.locations.join(', ')} (each with register + sale counter)`);
    for (const a of created.accounts) d.log(`  account: ${a.email}  ${a.role}  ${a.scope === 'COMPANY' ? 'COMPANY' : `LOCATION ${config.assignments[a.email]}`}`);
    if (created.systemActor) d.log('  system actor: created (inactive, no scopes)');
    d.log('  passwords: not shown; they are the ones in the private credentials file');
    return 0;
  } catch (err) {
    if (err instanceof Stop) return fail(err.phase, err.message);
    return fail('bootstrap', 'transaction rolled back; nothing was written', safeCode(err, secrets));
  } finally {
    if (prisma) await Promise.resolve().then(() => prisma.$disconnect()).catch(() => {});
  }
}

// Only run when executed directly; importing from a test never connects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
