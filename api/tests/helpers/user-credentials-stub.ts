// USER-MGMT-01 U1 — DB-free stub database for the credentials tests (auth middleware epoch, mustChangePassword, /auth/change-password).
//
// It models exactly what those flows touch and nothing else, with REAL rollback semantics so atomicity can be asserted:
//   - user.findUnique (login by email, middleware/me by id) -> the stored row plus empty role relations;
//   - $transaction(fn): a snapshot is taken, `txOpen` is true while fn runs, any throw restores the snapshot (rollback);
//   - $queryRaw: the user row lock `SELECT ... FROM "User" WHERE id = ? FOR NO KEY UPDATE` and the login lookup `lower("email") = lower(?)` (G22); every statement is recorded;
//   - user.update / auditLog.create: refused outside a transaction (a write outside a tx is a test failure);
//   - `onLock` simulates a concurrent winner that committed just before this transaction acquired the row lock.
import type { PrismaClient } from '../../src/generated/prisma/client.js';

export type StubUser = {
  id: string;
  name: string;
  email: string;
  isActive: boolean;
  passwordHash: string;
  mustChangePassword: boolean;
  credentialsChangedAt: Date | null;
};

export type StubAudit = {
  userId: string;
  branchId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
};

export type StubOptions = {
  // makes the audit insert fail (the movement/user update before it must roll back)
  auditFailure?: boolean;
  // runs when the row lock is requested, BEFORE the locked row is read (a winner that committed while we waited)
  onLock?: (state: StubState, userId: string) => void;
  // the first N transactions fail with a transient serialization/deadlock error before doing anything
  transientFailures?: number;
};

export type StubState = {
  users: StubUser[];
  audit: StubAudit[];
  statements: string[];
  events: string[]; // ordered: 'tx:begin', 'tx:commit', 'tx:rollback', 'lock', 'update', 'audit'
  txOpen: boolean;
  transactions: number;
};

const clone = (user: StubUser): StubUser => ({ ...user, credentialsChangedAt: user.credentialsChangedAt === null ? null : new Date(user.credentialsChangedAt.getTime()) });

export function createCredentialsStub(initial: StubUser[], options: StubOptions = {}) {
  const state: StubState = { users: initial.map(clone), audit: [], statements: [], events: [], txOpen: false, transactions: 0 };
  let transientLeft = options.transientFailures ?? 0;
  // The state a rollback returns to. A concurrent winner simulated by `onLock` is ANOTHER transaction that already committed: it is part of
  // the committed state, so it must survive this transaction's rollback.
  let committed: { users: StubUser[]; audit: StubAudit[] } = { users: [], audit: [] };

  const find = (where: { id?: string; email?: string }) => state.users.find((u) => (where.email !== undefined ? u.email === where.email : u.id === where.id));

  const db = {
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) => {
        const user = find(where);
        return user ? { ...clone(user), branchRoles: [], roleScopes: [] } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<StubUser> }) => {
        if (!state.txOpen) throw new Error('user.update outside a transaction');
        const user = find(where);
        if (!user) throw new Error('user not found');
        state.events.push('update');
        Object.assign(user, data);
        return clone(user);
      },
    },
    location: { findMany: async () => [] },
    auditLog: {
      create: async ({ data }: { data: StubAudit }) => {
        if (!state.txOpen) throw new Error('auditLog.create outside a transaction');
        if (options.auditFailure) throw new Error('audit insert failed');
        state.events.push('audit');
        state.audit.push(JSON.parse(JSON.stringify(data)) as StubAudit);
        return data;
      },
    },
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?');
      state.statements.push(text);
      if (/FROM "User"/.test(text) && /FOR NO KEY UPDATE/.test(text)) {
        if (!state.txOpen) throw new Error('the user row lock outside a transaction');
        state.events.push('lock');
        const id = String(values[0]);
        options.onLock?.(state, id);
        committed = { users: state.users.map(clone), audit: committed.audit };
        const user = find({ id });
        return user ? [clone(user)] : [];
      }
      // login (USER-MGMT-01 U2, G22): the case-insensitive e-mail lookup returns the id of the account
      if (/FROM "User"/.test(text) && /lower\("email"\)/.test(text)) {
        return state.users.filter((u) => u.email.toLowerCase() === String(values[0]).toLowerCase()).map((u) => ({ id: u.id }));
      }
      throw new Error(`unexpected raw query: ${text}`);
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => {
      if (transientLeft > 0) {
        transientLeft -= 1;
        throw Object.assign(new Error('could not serialize access'), { code: 'P2034' });
      }
      state.transactions += 1;
      committed = { users: state.users.map(clone), audit: [...state.audit] };
      state.txOpen = true;
      state.events.push('tx:begin');
      try {
        const result = await fn(db);
        state.events.push('tx:commit');
        return result;
      } catch (error) {
        state.users = committed.users;
        state.audit = committed.audit;
        state.events.push('tx:rollback');
        throw error;
      } finally {
        state.txOpen = false;
      }
    },
  };

  return { db: db as unknown as PrismaClient, state, user: (id: string) => state.users.find((u) => u.id === id)! };
}
