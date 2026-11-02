// USER-MGMT-01 U2 — DB-free stub database for the administrative identity lifecycle (user-admin.service.ts + its HTTP routes + login).
//
// It models exactly what those flows touch, with REAL rollback semantics (a snapshot per transaction, restored when the callback throws) and
// the two unique constraints the service depends on, so atomicity, replays and unique-violation races are observable:
//   - User:  unique lower(email) (the G22 index) -> P2002 { modelName: 'User', target: ['email'] }
//   - UserAdminOperation: unique (actorId, idempotencyKey) -> P2002 { modelName: 'UserAdminOperation', target: ['actorId', 'idempotencyKey'] }
// Raw queries are matched by shape (the user row lock, the lower(email) lookups, the Location FOR SHARE lock); anything else throws.
// `race*` hooks run RIGHT BEFORE the matching write and commit a competitor's rows (another transaction that won): the hook is applied to the live
// state AND to the committed state (it is called twice, once on each), so the competitor's rows survive this transaction's rollback.
import type { PrismaClient } from '../../src/generated/prisma/client.js';

export type AdminStubUser = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  passwordHash: string;
  mustChangePassword: boolean;
  credentialsChangedAt: Date | null;
};
export type AdminStubScope = { userId: string; roleCode: string; scopeKind: 'LOCATION' | 'COMPANY'; locationId: string | null };
export type AdminStubLocation = { id: string; name: string; code: string; isActive: boolean };
export type AdminStubOperation = { id: string; actorId: string; targetUserId: string; operation: string; idempotencyKey: string; requestHash: string };
export type AdminStubAudit = { userId: string; branchId: string | null; action: string; entityType: string; entityId: string; before?: unknown; after?: unknown };

export type AdminStubState = {
  users: AdminStubUser[];
  scopes: AdminStubScope[];
  locations: AdminStubLocation[];
  operations: AdminStubOperation[];
  audit: AdminStubAudit[];
  events: string[];
  txOpen: boolean;
  transactions: number;
};

export type AdminStubWorld = Pick<AdminStubState, 'users' | 'scopes' | 'operations' | 'audit'>;

export type AdminStubOptions = {
  auditFailure?: boolean;
  transientFailures?: number;
  // run right before the User insert / the UserAdminOperation insert / the User email update (a competitor committed first); must be deterministic
  raceBeforeUserCreate?: (world: AdminStubWorld) => void;
  raceBeforeOperationCreate?: (world: AdminStubWorld) => void;
  raceBeforeUserUpdate?: (world: AdminStubWorld) => void;
};

const ROLE_IDS: Record<string, string> = { OWNER: 'role-owner', ADMIN: 'role-admin', CASHIER: 'role-cashier', SELLER: 'role-seller', WAREHOUSE: 'role-warehouse' };
const clone = <T>(value: T): T => structuredClone(value);
let counter = 0;
const nextId = (prefix: string) => `${prefix}-${(counter += 1).toString().padStart(4, '0')}`;

const unique = (modelName: string, target: string[]) => Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { modelName, target } });

export function createUserAdminStub(initial: { users: AdminStubUser[]; scopes?: AdminStubScope[]; locations?: AdminStubLocation[] }, options: AdminStubOptions = {}) {
  const state: AdminStubState = {
    users: clone(initial.users), scopes: clone(initial.scopes ?? []), locations: clone(initial.locations ?? []),
    operations: [], audit: [], events: [], txOpen: false, transactions: 0,
  };
  let transientLeft = options.transientFailures ?? 0;
  let raceUser = options.raceBeforeUserCreate;
  let raceOperation = options.raceBeforeOperationCreate;
  let raceUpdate = options.raceBeforeUserUpdate;
  // The committed state a rollback returns to; a competitor's commit (a race hook) is part of it.
  const snapshot = (): AdminStubWorld => clone({ users: state.users, scopes: state.scopes, operations: state.operations, audit: state.audit });
  let committed = snapshot();
  const commitCompetitor = (race: (world: AdminStubWorld) => void) => { race(state); race(committed); };

  const roleCodesOf = (userId: string) => state.scopes.filter((s) => s.userId === userId);
  const findUser = (where: { id?: string; email?: string }) => state.users.find((u) => (where.email !== undefined ? u.email === where.email : u.id === where.id));
  const emailTaken = (email: string, exceptId?: string) => state.users.some((u) => u.id !== exceptId && u.email.toLowerCase() === email.toLowerCase());
  const needTx = (what: string) => { if (!state.txOpen) throw new Error(`${what} outside a transaction`); };
  const view = (user: AdminStubUser) => ({
    ...clone(user),
    branchRoles: [],
    roleScopes: roleCodesOf(user.id).map((s) => ({
      roleId: ROLE_IDS[s.roleCode], scopeKind: s.scopeKind, locationId: s.locationId,
      role: { id: ROLE_IDS[s.roleCode], code: s.roleCode, name: s.roleCode, permissions: [] },
      location: s.locationId ? state.locations.find((l) => l.id === s.locationId) ?? null : null,
    })),
  });

  const db = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        const user = findUser(where);
        return user ? view(user) : null;
      },
      create: async ({ data }: { data: Omit<AdminStubUser, 'id' | 'credentialsChangedAt'> & { id?: string; credentialsChangedAt?: Date | null } }) => {
        needTx('user.create');
        if (raceUser) { const race = raceUser; raceUser = undefined; commitCompetitor(race); }
        if (emailTaken(data.email)) throw unique('User', ['email']);
        const user: AdminStubUser = { credentialsChangedAt: null, ...data, id: data.id ?? nextId('user') };
        state.events.push('user.create');
        state.users.push(user);
        return clone(user);
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<AdminStubUser> }) => {
        needTx('user.update');
        if (data.email !== undefined && raceUpdate) { const race = raceUpdate; raceUpdate = undefined; commitCompetitor(race); }
        const user = findUser(where);
        if (!user) throw new Error('user not found');
        if (data.email !== undefined && emailTaken(data.email, user.id)) throw unique('User', ['email']);
        state.events.push('user.update');
        Object.assign(user, data);
        return clone(user);
      },
    },
    role: { findUnique: async ({ where }: { where: { code: string } }) => (ROLE_IDS[where.code] ? { id: ROLE_IDS[where.code], code: where.code } : null) },
    userRoleScope: {
      findMany: async ({ where }: { where: { userId: string; roleId?: string } }) => {
        needTx('userRoleScope.findMany');
        return roleCodesOf(where.userId).filter((s) => where.roleId === undefined || ROLE_IDS[s.roleCode] === where.roleId).map((s) => ({ scopeKind: s.scopeKind, locationId: s.locationId, role: { code: s.roleCode } }));
      },
      create: async ({ data }: { data: { userId: string; roleId: string; scopeKind: 'LOCATION' | 'COMPANY'; locationId: string | null } }) => {
        needTx('userRoleScope.create');
        state.events.push('scope.create');
        state.scopes.push({ userId: data.userId, roleCode: Object.keys(ROLE_IDS).find((k) => ROLE_IDS[k] === data.roleId)!, scopeKind: data.scopeKind, locationId: data.locationId });
        return data;
      },
      deleteMany: async ({ where }: { where: { userId: string; roleId?: string } }) => {
        needTx('userRoleScope.deleteMany');
        const before = state.scopes.length;
        state.scopes = state.scopes.filter((s) => !(s.userId === where.userId && (where.roleId === undefined || ROLE_IDS[s.roleCode] === where.roleId)));
        state.events.push('scope.delete');
        return { count: before - state.scopes.length };
      },
      createMany: async ({ data }: { data: Array<{ userId: string; roleId: string; scopeKind: 'LOCATION' | 'COMPANY'; locationId: string | null }> }) => {
        needTx('userRoleScope.createMany');
        for (const row of data) {
          state.events.push('scope.create');
          state.scopes.push({ userId: row.userId, roleCode: Object.keys(ROLE_IDS).find((k) => ROLE_IDS[k] === row.roleId)!, scopeKind: row.scopeKind, locationId: row.locationId });
        }
        return { count: data.length };
      },
    },
    userAdminOperation: {
      findUnique: async ({ where }: { where: { actorId_idempotencyKey: { actorId: string; idempotencyKey: string } } }) => {
        needTx('userAdminOperation.findUnique');
        const { actorId, idempotencyKey } = where.actorId_idempotencyKey;
        const row = state.operations.find((o) => o.actorId === actorId && o.idempotencyKey === idempotencyKey);
        return row ? clone(row) : null;
      },
      create: async ({ data }: { data: Omit<AdminStubOperation, 'id'> }) => {
        needTx('userAdminOperation.create');
        if (raceOperation) { const race = raceOperation; raceOperation = undefined; commitCompetitor(race); }
        if (state.operations.some((o) => o.actorId === data.actorId && o.idempotencyKey === data.idempotencyKey)) throw unique('UserAdminOperation', ['actorId', 'idempotencyKey']);
        state.events.push('operation.create');
        const row = { ...data, id: nextId('op') };
        state.operations.push(row);
        return clone(row);
      },
    },
    location: {
      findMany: async ({ where }: { where?: { id?: { in: string[] } } } = {}) => state.locations.filter((l) => l.isActive && (where?.id?.in ? where.id.in.includes(l.id) : true)).map((l) => ({ id: l.id, name: l.name, code: l.code })),
    },
    auditLog: {
      create: async ({ data }: { data: AdminStubAudit }) => {
        needTx('auditLog.create');
        if (options.auditFailure) throw new Error('audit insert failed');
        state.events.push('audit');
        state.audit.push(JSON.parse(JSON.stringify(data)) as AdminStubAudit);
        return data;
      },
    },
    // tx.$executeRaw is used only for the advisory lock of the last-OWNER guard
    $executeRaw: async (strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (!/pg_advisory_xact_lock/.test(text)) throw new Error(`unexpected raw execute: ${text}`);
      needTx('the advisory lock');
      state.events.push('advisory');
      return 0;
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      // USER-MGMT-01 U3: the transaction-scoped advisory lock of the last-OWNER guard (a no-op here: the stub runs one transaction at a time)
      if (/pg_advisory_xact_lock/.test(text)) {
        needTx('the advisory lock');
        state.events.push('advisory');
        return [];
      }
      // USER-MGMT-01 U3: operative OWNERs other than the excluded account (active + OWNER + COMPANY)
      if (/count\(\*\)/.test(text) && /"UserRoleScope"/.test(text)) {
        needTx('the OWNER count');
        const excluded = String(values[0]);
        const n = state.users.filter((u) => u.isActive && u.id !== excluded && state.scopes.some((sc) => sc.userId === u.id && sc.roleCode === 'OWNER' && sc.scopeKind === 'COMPANY')).length;
        return [{ n }];
      }
      // the user row lock (service, change-password): the whole row
      if (/FROM "User"/.test(text) && /WHERE id = \?/.test(text) && /FOR NO KEY UPDATE/.test(text)) {
        needTx('the user row lock');
        state.events.push('lock');
        const user = findUser({ id: String(values[0]) });
        return user ? [clone(user)] : [];
      }
      // case-insensitive e-mail: login (id of the account) and the service (other accounts holding the e-mail)
      if (/FROM "User"/.test(text) && /lower\("email"\)/.test(text)) {
        const wanted = String(values[0]).toLowerCase();
        const except = values.length > 1 ? String(values[1]) : null;
        return state.users.filter((u) => u.email.toLowerCase() === wanted && u.id !== except).map((u) => ({ id: u.id }));
      }
      if (/FROM "Location"/.test(text) && /FOR SHARE/.test(text)) {
        needTx('the location lock');
        // Prisma.join(ids) arrives as ONE Sql value carrying the ids
        const ids = values.flatMap((value) => (typeof value === 'object' && value !== null && Array.isArray((value as { values?: unknown[] }).values) ? (value as { values: unknown[] }).values : [value])).map(String);
        return state.locations.filter((l) => ids.includes(l.id)).sort((a, b) => a.id.localeCompare(b.id)).map((l) => ({ id: l.id, isActive: l.isActive }));
      }
      throw new Error(`unexpected raw query: ${text}`);
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      if (transientLeft > 0) {
        transientLeft -= 1;
        throw Object.assign(new Error('could not serialize access'), { code: 'P2034' });
      }
      state.transactions += 1;
      committed = snapshot();
      state.txOpen = true;
      state.events.push('tx:begin');
      try {
        const result = await fn(db);
        state.events.push('tx:commit');
        return result;
      } catch (error) {
        state.users = committed.users; state.scopes = committed.scopes; state.operations = committed.operations; state.audit = committed.audit;
        state.events.push('tx:rollback');
        throw error;
      } finally {
        state.txOpen = false;
      }
    },
  };

  return { db: db as unknown as PrismaClient, state, user: (id: string) => state.users.find((u) => u.id === id)! };
}
