import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapProductionRbacCatalog } from '../../src/modules/rbac/catalog.service.js';
import { createBranch, ensureTestLocation } from '../helpers/factories.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import {
  bootstrapCanonicalOwner,
  planCanonicalOwnerBootstrap,
  CANONICAL_OWNER_EMAIL,
  CANONICAL_OWNER_NAME,
  CANONICAL_OWNER_USER_ID,
  type CanonicalOwnerBootstrapPlan,
} from '../../src/modules/rbac/canonical-owner-bootstrap.service.js';
import { main, parseCliArgs, type BootstrapCanonicalOwnerCliDeps } from '../../scripts/bootstrap-canonical-owner.js';

// GC4F3 (Phase 1 Global Closeout): narrow, auditable, dry-run-first bootstrap
// for the fixed canonical demo OWNER identity — independent of
// prisma/seed.ts's broad seedDemo/resetDemo path (see the GC4F3A design
// audit). Every test proves the planner is read-only (exact before/after
// snapshot) and the mutator touches only the canonical user's OWNER-role
// UserRoleScope rows.
describe('canonical OWNER bootstrap (GC4F3)', () => {
  let db: Awaited<ReturnType<typeof createTestPrismaClient>>;

  beforeAll(async () => {
    db = await createTestPrismaClient();
  });

  beforeEach(async () => {
    await truncateAllTables(db);
    await bootstrapProductionRbacCatalog(db);
  });

  afterAll(async () => db.$disconnect());

  async function ownerRoleId() {
    return (await db.role.findUniqueOrThrow({ where: { code: 'OWNER' } })).id;
  }

  async function snapshot() {
    return {
      userCount: await db.user.count(),
      scopes: await db.userRoleScope.findMany({ orderBy: { id: 'asc' } }),
      legacyRows: await db.userBranchRole.count(),
    };
  }

  describe('planCanonicalOwnerBootstrap', () => {
    it('reports ABSENT / CREATE_USER_AND_OWNER_SCOPE with zero mutation when the canonical identity does not exist', async () => {
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.identityState).toBe('ABSENT');
      expect(plan.action).toBe('CREATE_USER_AND_OWNER_SCOPE');
      expect(plan.readyForExecution).toBe(true);
      expect(plan.blockers).toEqual([]);
      expect(plan.passwordRequiredForExecute).toBe(true);
      expect(plan.existingCanonicalUser).toBeNull();
      expect(plan.canonical).toEqual({
        userId: CANONICAL_OWNER_USER_ID,
        email: CANONICAL_OWNER_EMAIL,
        expectedName: CANONICAL_OWNER_NAME,
      });

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('reports ADD_OWNER_SCOPE for an exact active canonical user with no OWNER scope', async () => {
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.identityState).toBe('EXACT_MATCH');
      expect(plan.action).toBe('ADD_OWNER_SCOPE');
      expect(plan.readyForExecution).toBe(true);
      expect(plan.existingCanonicalUser).toEqual({
        id: CANONICAL_OWNER_USER_ID,
        email: CANONICAL_OWNER_EMAIL,
        name: CANONICAL_OWNER_NAME,
        isActive: true,
      });
      expect(plan.existingCanonicalUser).not.toHaveProperty('passwordHash');
      expect(plan.existingOwnerScopes).toEqual([]);
      expect(plan.passwordRequiredForExecute).toBe(false);

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('reports NOOP_ALREADY_CANONICAL for an exact active canonical user with one OWNER COMPANY scope', async () => {
      const roleId = await ownerRoleId();
      const user = await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      await db.userRoleScope.create({ data: { userId: user.id, roleId, scopeKind: 'COMPANY', locationId: null } });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.action).toBe('NOOP_ALREADY_CANONICAL');
      expect(plan.readyForExecution).toBe(true);
      expect(plan.existingOwnerScopes).toHaveLength(1);
      expect(plan.existingOwnerScopes[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('reports NOT READY for an inactive exact canonical user', async () => {
      await db.user.create({
        data: {
          id: CANONICAL_OWNER_USER_ID,
          name: CANONICAL_OWNER_NAME,
          email: CANONICAL_OWNER_EMAIL,
          passwordHash: 'x',
          isActive: false,
        },
      });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.readyForExecution).toBe(false);
      expect(plan.action).toBe('BLOCKED');
      expect(plan.blockers.some((b) => b.includes('inactive'))).toBe(true);

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('reports EMAIL_ID_MISMATCH and NOT READY when the canonical email belongs to a different id', async () => {
      await db.user.create({ data: { name: 'someone', email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' } });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.identityState).toBe('EMAIL_ID_MISMATCH');
      expect(plan.readyForExecution).toBe(false);
      expect(plan.action).toBe('BLOCKED');
      expect(plan.existingCanonicalUser).toBeNull();

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('reports CANONICAL_ID_OCCUPIED and NOT READY when the canonical id belongs to a different email', async () => {
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: 'someone', email: 'someone-else@test.local', passwordHash: 'x' },
      });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.identityState).toBe('CANONICAL_ID_OCCUPIED');
      expect(plan.readyForExecution).toBe(false);
      expect(plan.action).toBe('BLOCKED');
      expect(plan.existingCanonicalUser).toBeNull();

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('reports SPLIT_IDENTITY and NOT READY when canonical email and canonical id resolve to different users', async () => {
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: 'id-holder', email: 'id-holder@test.local', passwordHash: 'x' },
      });
      await db.user.create({ data: { name: 'email-holder', email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' } });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.identityState).toBe('SPLIT_IDENTITY');
      expect(plan.readyForExecution).toBe(false);
      expect(plan.action).toBe('BLOCKED');
      expect(plan.existingCanonicalUser).toBeNull();

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('reports RECONCILE_OWNER_SCOPE for an exact canonical user with OWNER LOCATION rows', async () => {
      const roleId = await ownerRoleId();
      const user = await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      await db.userRoleScope.create({
        data: { userId: user.id, roleId, scopeKind: 'LOCATION', locationId: branch.id },
      });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.action).toBe('RECONCILE_OWNER_SCOPE');
      expect(plan.readyForExecution).toBe(true);
      expect(plan.existingOwnerScopes).toHaveLength(1);
      expect(plan.existingOwnerScopes[0]).toMatchObject({ scopeKind: 'LOCATION' });

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('reports RECONCILE_OWNER_SCOPE for an exact canonical user with mixed OWNER COMPANY and LOCATION rows', async () => {
      const roleId = await ownerRoleId();
      const user = await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      await db.userRoleScope.create({ data: { userId: user.id, roleId, scopeKind: 'COMPANY', locationId: null } });
      await db.userRoleScope.create({
        data: { userId: user.id, roleId, scopeKind: 'LOCATION', locationId: branch.id },
      });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.action).toBe('RECONCILE_OWNER_SCOPE');
      expect(plan.readyForExecution).toBe(true);
      expect(plan.existingOwnerScopes).toHaveLength(2);

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('surfaces non-OWNER Production scopes as preserved context without affecting readiness', async () => {
      const ownerRole = await ownerRoleId();
      const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
      const user = await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      await db.userRoleScope.create({ data: { userId: user.id, roleId: ownerRole, scopeKind: 'COMPANY', locationId: null } });
      await db.userRoleScope.create({
        data: { userId: user.id, roleId: cashierRole.id, scopeKind: 'LOCATION', locationId: branch.id },
      });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.action).toBe('NOOP_ALREADY_CANONICAL');
      expect(plan.readyForExecution).toBe(true);
      expect(plan.existingNonOwnerScopes).toHaveLength(1);
      expect(plan.existingNonOwnerScopes[0]).toMatchObject({ roleCode: 'CASHIER', scopeKind: 'LOCATION' });

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('surfaces legacy UserBranchRole rows and reports NOT READY, even when OWNER scope is already canonical', async () => {
      const ownerRole = await ownerRoleId();
      const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
      const branch = await createBranch(db);
      // createTestUser creates a User + a legacy UserBranchRole row; reuse
      // it to get a canonical-id user with a real legacy row attached.
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      await db.userBranchRole.create({
        data: { userId: CANONICAL_OWNER_USER_ID, branchId: branch.id, roleId: cashierRole.id },
      });
      await db.userRoleScope.create({
        data: { userId: CANONICAL_OWNER_USER_ID, roleId: ownerRole, scopeKind: 'COMPANY', locationId: null },
      });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.readyForExecution).toBe(false);
      expect(plan.action).toBe('BLOCKED');
      expect(plan.legacyUserBranchRoleRows).toHaveLength(1);
      expect(plan.legacyUserBranchRoleRows[0]).toMatchObject({ roleCode: 'CASHIER' });
      expect(plan.blockers.some((b) => b.includes('UserBranchRole'))).toBe(true);

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('surfaces another OWNER COMPANY user as context without affecting readiness or naming them as target', async () => {
      const roleId = await ownerRoleId();
      const otherOwner = await db.user.create({
        data: { name: 'other-owner', email: 'other-owner@test.local', passwordHash: 'x' },
      });
      await db.userRoleScope.create({
        data: { userId: otherOwner.id, roleId, scopeKind: 'COMPANY', locationId: null },
      });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.identityState).toBe('ABSENT');
      expect(plan.readyForExecution).toBe(true);
      expect(plan.otherOwnerUsers).toHaveLength(1);
      expect(plan.otherOwnerUsers[0]).toMatchObject({
        userId: otherOwner.id,
        email: 'other-owner@test.local',
        isActive: true,
        scopes: [{ scopeKind: 'COMPANY', locationId: null }],
      });

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    // GC4F3R1 finding 4: a malformed OWNER LOCATION holder (never valid
    // authority per authorization-policy.ts, but real, schema-representable
    // state) must still be surfaced as context — the old query filtered by
    // scopeKind: 'COMPANY' and silently omitted exactly this case.
    it('surfaces another OWNER user holding only a malformed OWNER LOCATION row', async () => {
      const roleId = await ownerRoleId();
      const otherOwner = await db.user.create({
        data: { name: 'location-owner', email: 'location-owner@test.local', passwordHash: 'x' },
      });
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      await db.userRoleScope.create({
        data: { userId: otherOwner.id, roleId, scopeKind: 'LOCATION', locationId: branch.id },
      });

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.readyForExecution).toBe(true);
      expect(plan.otherOwnerUsers).toHaveLength(1);
      expect(plan.otherOwnerUsers[0]).toMatchObject({
        userId: otherOwner.id,
        email: 'location-owner@test.local',
        scopes: [{ scopeKind: 'LOCATION', locationId: branch.id }],
      });
    });

    it('surfaces another OWNER user holding mixed OWNER COMPANY + LOCATION rows with every scope reported', async () => {
      const roleId = await ownerRoleId();
      const otherOwner = await db.user.create({
        data: { name: 'mixed-owner', email: 'mixed-owner@test.local', passwordHash: 'x' },
      });
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      await db.userRoleScope.create({
        data: { userId: otherOwner.id, roleId, scopeKind: 'COMPANY', locationId: null },
      });
      await db.userRoleScope.create({
        data: { userId: otherOwner.id, roleId, scopeKind: 'LOCATION', locationId: branch.id },
      });

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.otherOwnerUsers).toHaveLength(1);
      expect(plan.otherOwnerUsers[0]!.scopes).toHaveLength(2);
      expect(plan.otherOwnerUsers[0]!.scopes).toEqual(
        expect.arrayContaining([
          { scopeKind: 'COMPANY', locationId: null },
          { scopeKind: 'LOCATION', locationId: branch.id },
        ]),
      );
    });

    // GC4F3R1 finding 2: the initial identity reads must never load
    // passwordHash, even transiently — proven at the query-shape level (not
    // merely that the final plan omits it), using the same $extends query
    // interception pattern already established by tests/audit/audit.test.ts.
    it('reads canonical identity with an explicit least-privilege select, never requesting passwordHash', async () => {
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'sentinel-hash' },
      });
      const capturedSelects: Record<string, unknown>[] = [];
      const instrumented = db.$extends({
        query: {
          user: {
            findUnique({ args, query }) {
              if (args.select) capturedSelects.push(args.select as Record<string, unknown>);
              return query(args);
            },
          },
        },
      });

      await planCanonicalOwnerBootstrap(instrumented as unknown as typeof db);

      expect(capturedSelects.length).toBeGreaterThan(0);
      for (const select of capturedSelects) {
        expect(select.passwordHash).toBeUndefined();
        expect(select.createdAt).toBeUndefined();
        expect(select.updatedAt).toBeUndefined();
        expect(select.id).toBe(true);
        expect(select.email).toBe(true);
        expect(select.name).toBe(true);
        expect(select.isActive).toBe(true);
      }
    });

    it('reports NOT READY when the OWNER Role does not exist', async () => {
      const ownerRole = await db.role.findUniqueOrThrow({ where: { code: 'OWNER' } });
      await db.role.delete({ where: { id: ownerRole.id } });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.ownerRole.exists).toBe(false);
      expect(plan.readyForExecution).toBe(false);
      expect(plan.action).toBe('BLOCKED');

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('reports NOT READY when the OWNER Role has any RolePermission grant', async () => {
      const roleId = await ownerRoleId();
      const permission = await db.permission.findFirstOrThrow({ where: { code: { not: { contains: '.' } } } });
      await db.rolePermission.create({ data: { roleId, permissionId: permission.id } });
      const before = await snapshot();

      const plan = await planCanonicalOwnerBootstrap(db);

      expect(plan.ownerRole.unexpectedRolePermissionCount).toBe(1);
      expect(plan.readyForExecution).toBe(false);
      expect(plan.action).toBe('BLOCKED');

      const after = await snapshot();
      expect(after).toEqual(before);
    });
  });

  describe('bootstrapCanonicalOwner', () => {
    it('creates the canonical user and exactly one OWNER COMPANY scope when absent', async () => {
      const result = await bootstrapCanonicalOwner(db, { createPasswordHash: 'hashed-secret' });

      expect(result).toMatchObject({
        actionPerformed: 'CREATE_USER_AND_OWNER_SCOPE',
        userCreated: true,
        ownerScopeChanged: true,
        canonicalUserId: CANONICAL_OWNER_USER_ID,
      });
      const user = await db.user.findUniqueOrThrow({ where: { id: CANONICAL_OWNER_USER_ID } });
      expect(user).toMatchObject({ name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL });
      const scopes = await db.userRoleScope.findMany({ where: { userId: CANONICAL_OWNER_USER_ID } });
      expect(scopes).toHaveLength(1);
      expect(scopes[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
    });

    it('uses the supplied hashed password verbatim when creating the absent canonical user', async () => {
      await bootstrapCanonicalOwner(db, { createPasswordHash: 'exact-hashed-value' });

      const user = await db.user.findUniqueOrThrow({ where: { id: CANONICAL_OWNER_USER_ID } });
      expect(user.passwordHash).toBe('exact-hashed-value');
    });

    // GC4F3R2 finding: the ABSENT-user create call itself must write
    // passwordHash (creation requires it) but never load it back in the
    // create RESULT — a bare tx.user.create() with no explicit select
    // returns every column by default. Proven at the query-shape level via
    // the same $extends interception pattern used for the identity-select
    // regression tests above, not merely by inspecting the service's
    // returned BootstrapCanonicalOwnerResult (which never carried
    // passwordHash regardless).
    it('creates the absent canonical user with an explicit least-privilege create-result select (writes but never reloads passwordHash)', async () => {
      const capturedCreateArgs: { data?: Record<string, unknown>; select?: Record<string, unknown> }[] = [];
      const instrumented = db.$extends({
        query: {
          user: {
            create({ args, query }) {
              capturedCreateArgs.push(args as { data?: Record<string, unknown>; select?: Record<string, unknown> });
              return query(args);
            },
          },
        },
      });

      await bootstrapCanonicalOwner(instrumented as unknown as typeof db, {
        createPasswordHash: 'sentinel-create-hash',
      });

      expect(capturedCreateArgs).toHaveLength(1);
      const createArgs = capturedCreateArgs[0]!;
      // passwordHash MUST still be written — creation needs to persist it.
      expect(createArgs.data?.passwordHash).toBe('sentinel-create-hash');
      // But the CREATE RESULT must be narrowed to only what's used afterward.
      expect(createArgs.select).toBeDefined();
      expect(createArgs.select?.id).toBe(true);
      expect(createArgs.select?.email).toBe(true);
      expect(createArgs.select?.isActive).toBe(true);
      expect(createArgs.select?.passwordHash).toBeUndefined();
      expect(createArgs.select?.createdAt).toBeUndefined();
      expect(createArgs.select?.updatedAt).toBeUndefined();
    });

    it('refuses to create the absent canonical user without a supplied password hash', async () => {
      await expect(bootstrapCanonicalOwner(db, {})).rejects.toThrow(/createPasswordHash/);
      expect(await db.user.count()).toBe(0);
    });

    it("preserves an existing canonical user's passwordHash unchanged", async () => {
      await db.user.create({
        data: {
          id: CANONICAL_OWNER_USER_ID,
          name: CANONICAL_OWNER_NAME,
          email: CANONICAL_OWNER_EMAIL,
          passwordHash: 'original-hash',
        },
      });

      await bootstrapCanonicalOwner(db, { createPasswordHash: 'should-never-be-used' });

      const user = await db.user.findUniqueOrThrow({ where: { id: CANONICAL_OWNER_USER_ID } });
      expect(user.passwordHash).toBe('original-hash');
    });

    it("preserves an existing canonical user's name unchanged", async () => {
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: 'Custom Name', email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });

      await bootstrapCanonicalOwner(db, {});

      const user = await db.user.findUniqueOrThrow({ where: { id: CANONICAL_OWNER_USER_ID } });
      expect(user.name).toBe('Custom Name');
    });

    it('refuses an inactive existing canonical user with zero mutation', async () => {
      await db.user.create({
        data: {
          id: CANONICAL_OWNER_USER_ID,
          name: CANONICAL_OWNER_NAME,
          email: CANONICAL_OWNER_EMAIL,
          passwordHash: 'x',
          isActive: false,
        },
      });
      const before = await snapshot();

      await expect(bootstrapCanonicalOwner(db, {})).rejects.toThrow(/inactive/);

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('refuses an ambiguous identity (email/id mismatch) with zero mutation', async () => {
      await db.user.create({ data: { name: 'someone', email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' } });
      const before = await snapshot();

      await expect(bootstrapCanonicalOwner(db, {})).rejects.toThrow(/ambiguous/);

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    it('adds exactly one OWNER COMPANY scope when the canonical user has no OWNER scope', async () => {
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });

      const result = await bootstrapCanonicalOwner(db, {});

      expect(result).toMatchObject({ actionPerformed: 'ADD_OWNER_SCOPE', userCreated: false, ownerScopeChanged: true });
      const scopes = await db.userRoleScope.findMany({ where: { userId: CANONICAL_OWNER_USER_ID } });
      expect(scopes).toHaveLength(1);
      expect(scopes[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
    });

    it('converges OWNER LOCATION rows to exactly one OWNER COMPANY scope', async () => {
      const roleId = await ownerRoleId();
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const branchA = await createBranch(db);
      const branchB = await createBranch(db);
      await ensureTestLocation(db, branchA.id);
      await ensureTestLocation(db, branchB.id);
      await db.userRoleScope.create({
        data: { userId: CANONICAL_OWNER_USER_ID, roleId, scopeKind: 'LOCATION', locationId: branchA.id },
      });
      await db.userRoleScope.create({
        data: { userId: CANONICAL_OWNER_USER_ID, roleId, scopeKind: 'LOCATION', locationId: branchB.id },
      });

      const result = await bootstrapCanonicalOwner(db, {});

      expect(result.actionPerformed).toBe('RECONCILE_OWNER_SCOPE');
      const scopes = await db.userRoleScope.findMany({ where: { userId: CANONICAL_OWNER_USER_ID, roleId } });
      expect(scopes).toHaveLength(1);
      expect(scopes[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
    });

    it('converges mixed OWNER COMPANY + LOCATION rows to exactly one OWNER COMPANY scope', async () => {
      const roleId = await ownerRoleId();
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      await db.userRoleScope.create({ data: { userId: CANONICAL_OWNER_USER_ID, roleId, scopeKind: 'COMPANY', locationId: null } });
      await db.userRoleScope.create({
        data: { userId: CANONICAL_OWNER_USER_ID, roleId, scopeKind: 'LOCATION', locationId: branch.id },
      });

      const result = await bootstrapCanonicalOwner(db, {});

      expect(result.actionPerformed).toBe('RECONCILE_OWNER_SCOPE');
      const scopes = await db.userRoleScope.findMany({ where: { userId: CANONICAL_OWNER_USER_ID, roleId } });
      expect(scopes).toHaveLength(1);
      expect(scopes[0]).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
    });

    it('performs zero mutation when already canonical', async () => {
      const roleId = await ownerRoleId();
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const existingScope = await db.userRoleScope.create({
        data: { userId: CANONICAL_OWNER_USER_ID, roleId, scopeKind: 'COMPANY', locationId: null },
      });

      const result = await bootstrapCanonicalOwner(db, {});

      expect(result).toMatchObject({ actionPerformed: 'NOOP_ALREADY_CANONICAL', userCreated: false, ownerScopeChanged: false });
      const scopes = await db.userRoleScope.findMany({ where: { userId: CANONICAL_OWNER_USER_ID, roleId } });
      expect(scopes).toHaveLength(1);
      // Same row id proves this was never deleted/recreated (zero churn), not merely equal count.
      expect(scopes[0]!.id).toBe(existingScope.id);
    });

    it('preserves non-OWNER scopes unchanged', async () => {
      const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
      const branch = await createBranch(db);
      await ensureTestLocation(db, branch.id);
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const cashierScope = await db.userRoleScope.create({
        data: { userId: CANONICAL_OWNER_USER_ID, roleId: cashierRole.id, scopeKind: 'LOCATION', locationId: branch.id },
      });

      await bootstrapCanonicalOwner(db, {});

      const survivingScope = await db.userRoleScope.findUniqueOrThrow({ where: { id: cashierScope.id } });
      expect(survivingScope).toMatchObject({ roleId: cashierRole.id, scopeKind: 'LOCATION', locationId: branch.id });
    });

    it('never mutates another OWNER user', async () => {
      const roleId = await ownerRoleId();
      const otherOwner = await db.user.create({
        data: { name: 'other-owner', email: 'other-owner@test.local', passwordHash: 'other-hash' },
      });
      const otherOwnerScope = await db.userRoleScope.create({
        data: { userId: otherOwner.id, roleId, scopeKind: 'COMPANY', locationId: null },
      });

      await bootstrapCanonicalOwner(db, { createPasswordHash: 'x' });

      const untouchedUser = await db.user.findUniqueOrThrow({ where: { id: otherOwner.id } });
      expect(untouchedUser.passwordHash).toBe('other-hash');
      const untouchedScope = await db.userRoleScope.findUniqueOrThrow({ where: { id: otherOwnerScope.id } });
      expect(untouchedScope).toMatchObject({ scopeKind: 'COMPANY', locationId: null });
    });

    it('refuses when legacy UserBranchRole rows exist, without deleting them', async () => {
      const cashierRole = await db.role.findUniqueOrThrow({ where: { code: 'CASHIER' } });
      const branch = await createBranch(db);
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const legacyRow = await db.userBranchRole.create({
        data: { userId: CANONICAL_OWNER_USER_ID, branchId: branch.id, roleId: cashierRole.id },
      });

      await expect(bootstrapCanonicalOwner(db, {})).rejects.toThrow(/UserBranchRole/);

      const survivingRow = await db.userBranchRole.findUniqueOrThrow({ where: { id: legacyRow.id } });
      expect(survivingRow.id).toBe(legacyRow.id);
      expect(await db.userRoleScope.count({ where: { userId: CANONICAL_OWNER_USER_ID } })).toBe(0);
    });

    it('refuses when the OWNER Role has an unexpected RolePermission grant', async () => {
      const roleId = await ownerRoleId();
      const permission = await db.permission.findFirstOrThrow({ where: { code: { not: { contains: '.' } } } });
      await db.rolePermission.create({ data: { roleId, permissionId: permission.id } });
      const before = await snapshot();

      await expect(bootstrapCanonicalOwner(db, { createPasswordHash: 'x' })).rejects.toThrow(/RolePermission/);

      const after = await snapshot();
      expect(after).toEqual(before);
    });

    // GC4F3R1 finding 2 (mutator side): the mutator's own pre-lock identity
    // reads must be equally narrow — the raw-SQL FOR UPDATE query already
    // selects explicit columns, but the plain findUnique reads used to
    // classify identity state did not.
    it("reads its own pre-lock identity with an explicit least-privilege select, never requesting passwordHash", async () => {
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'sentinel-hash' },
      });
      const capturedSelects: Record<string, unknown>[] = [];
      const instrumented = db.$extends({
        query: {
          user: {
            findUnique({ args, query }) {
              if (args.select) capturedSelects.push(args.select as Record<string, unknown>);
              return query(args);
            },
          },
        },
      });

      await bootstrapCanonicalOwner(instrumented as unknown as typeof db, {});

      expect(capturedSelects.length).toBeGreaterThan(0);
      for (const select of capturedSelects) {
        expect(select.passwordHash).toBeUndefined();
      }
    });

    // GC4F3R1 finding 1: the FOR UPDATE lock must be re-verified against the
    // canonical email, not just id/isActive — otherwise a concurrent direct
    // email change landing between the initial identity read and the row
    // lock could leave OWNER scope reconciliation proceeding against a
    // no-longer-canonical identity. Real, non-mocked proof: a second
    // transaction holds the row lock first, changes the email while holding
    // it, then commits — bootstrapCanonicalOwner's blocked FOR UPDATE must
    // then see the changed email and abort before any scope write.
    it('aborts before scope mutation when the canonical email changes between the initial read and the row lock', async () => {
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const roleId = await ownerRoleId();
      await db.userRoleScope.create({
        data: { userId: CANONICAL_OWNER_USER_ID, roleId, scopeKind: 'COMPANY', locationId: null },
      });

      const HOLD_MS = 2000;
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${CANONICAL_OWNER_USER_ID} FOR UPDATE`;
          await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
          await tx.$executeRaw`UPDATE "User" SET email = 'changed-mid-flight@evil.local' WHERE id = ${CANONICAL_OWNER_USER_ID}`;
        },
        { maxWait: 10000, timeout: HOLD_MS + 8000 },
      );

      // Give the holder a comfortable head start to acquire the row lock
      // before the mutator even starts (the holder needs one round trip;
      // the mutator needs several sequential ones first, so this margin is
      // generous, not fragile).
      await new Promise((resolve) => setTimeout(resolve, 500));
      await expect(bootstrapCanonicalOwner(db, {})).rejects.toThrow(/email/i);

      await holder;
      const finalScopeCount = await db.userRoleScope.count({ where: { userId: CANONICAL_OWNER_USER_ID, roleId } });
      expect(finalScopeCount).toBe(1);
    }, 20000);

    it('is idempotent across repeated executions', async () => {
      const first = await bootstrapCanonicalOwner(db, { createPasswordHash: 'x' });
      expect(first.userCreated).toBe(true);

      const second = await bootstrapCanonicalOwner(db, {});
      expect(second).toMatchObject({ actionPerformed: 'NOOP_ALREADY_CANONICAL', userCreated: false, ownerScopeChanged: false });

      expect(await db.user.count()).toBe(1);
      expect(await db.userRoleScope.count({ where: { userId: CANONICAL_OWNER_USER_ID } })).toBe(1);
    });
  });

  describe('bootstrapCanonicalOwner concurrency', () => {
    it('serializes against a concurrent holder of the shared maintenance advisory lock (same lock id as seed.ts)', async () => {
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const roleId = await ownerRoleId();
      await db.userRoleScope.create({ data: { userId: CANONICAL_OWNER_USER_ID, roleId, scopeKind: 'COMPANY', locationId: null } });

      const HOLD_MS = 1500;
      const start = Date.now();
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(506005)::text`;
          await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
        },
        { maxWait: 10000, timeout: HOLD_MS + 5000 },
      );

      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await bootstrapCanonicalOwner(db, {});
      const elapsed = Date.now() - start;

      await holder;
      expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS);
      expect(result.actionPerformed).toBe('NOOP_ALREADY_CANONICAL');
    }, 20000);

    it('serializes against a concurrent holder of the canonical user row lock (FOR UPDATE)', async () => {
      await db.user.create({
        data: { id: CANONICAL_OWNER_USER_ID, name: CANONICAL_OWNER_NAME, email: CANONICAL_OWNER_EMAIL, passwordHash: 'x' },
      });
      const roleId = await ownerRoleId();
      await db.userRoleScope.create({ data: { userId: CANONICAL_OWNER_USER_ID, roleId, scopeKind: 'COMPANY', locationId: null } });

      const HOLD_MS = 1500;
      const start = Date.now();
      const holder = db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${CANONICAL_OWNER_USER_ID} FOR UPDATE`;
          await new Promise((resolve) => setTimeout(resolve, HOLD_MS));
        },
        { maxWait: 10000, timeout: HOLD_MS + 5000 },
      );

      await new Promise((resolve) => setTimeout(resolve, 300));
      const result = await bootstrapCanonicalOwner(db, {});
      const elapsed = Date.now() - start;

      await holder;
      expect(elapsed).toBeGreaterThanOrEqual(HOLD_MS);
      expect(result.actionPerformed).toBe('NOOP_ALREADY_CANONICAL');
    }, 20000);
  });
});

// GC4F3 CLI safety contract: pure argument-parsing tests, no database
// involved. Importing the script module (see the top-level import above)
// must not itself open a connection or read OWNER_BOOTSTRAP_PASSWORD — its
// direct-execution guard only fires when the module is run as the CLI entry
// point, never on import.
describe('parseCliArgs (GC4F3 CLI safety contract)', () => {
  it('accepts --target=test --dry-run', () => {
    expect(parseCliArgs(['--target=test', '--dry-run'])).toEqual({ ok: true, target: 'test', mode: 'dry-run' });
  });

  it('accepts --target=demo --dry-run', () => {
    expect(parseCliArgs(['--target=demo', '--dry-run'])).toEqual({ ok: true, target: 'demo', mode: 'dry-run' });
  });

  it('accepts --target=test --execute', () => {
    expect(parseCliArgs(['--target=test', '--execute'])).toEqual({ ok: true, target: 'test', mode: 'execute' });
  });

  it('accepts --target=demo --execute', () => {
    expect(parseCliArgs(['--target=demo', '--execute'])).toEqual({ ok: true, target: 'demo', mode: 'execute' });
  });

  it('rejects a bare --target with no mode', () => {
    expect(parseCliArgs(['--target=test']).ok).toBe(false);
  });

  it('rejects a missing target', () => {
    expect(parseCliArgs(['--dry-run']).ok).toBe(false);
  });

  it('rejects both --dry-run and --execute together', () => {
    expect(parseCliArgs(['--target=test', '--dry-run', '--execute']).ok).toBe(false);
  });

  it('rejects neither mode being specified', () => {
    expect(parseCliArgs(['--target=test']).ok).toBe(false);
  });

  it('rejects an invalid --target value', () => {
    expect(parseCliArgs(['--target=production', '--dry-run']).ok).toBe(false);
  });

  it('rejects duplicate identical --target arguments', () => {
    expect(parseCliArgs(['--target=test', '--target=test', '--dry-run']).ok).toBe(false);
  });

  it('rejects conflicting duplicate --target arguments', () => {
    expect(parseCliArgs(['--target=test', '--target=demo', '--dry-run']).ok).toBe(false);
  });

  it('rejects duplicate --dry-run flags', () => {
    expect(parseCliArgs(['--target=test', '--dry-run', '--dry-run']).ok).toBe(false);
  });

  it('rejects duplicate --execute flags', () => {
    expect(parseCliArgs(['--target=test', '--execute', '--execute']).ok).toBe(false);
  });

  it('rejects an unknown flag', () => {
    expect(parseCliArgs(['--target=test', '--dry-run', '--force']).ok).toBe(false);
  });

  it('rejects a positional argument', () => {
    expect(parseCliArgs(['--target=test', '--dry-run', 'extra']).ok).toBe(false);
  });
});

// GC4F3R1 finding 3: main()'s real branching logic (dry-run vs execute,
// password-required-vs-not, hash-only-transfer) was previously unexercised —
// parser tests alone only prove argv parsing, not the secret flow. A narrow
// dependency-injection seam (defaulted to the real implementations) makes
// this observable without weakening production behavior: the direct-
// execution guard at the bottom of the script still calls `main(argv)` with
// no deps override, so it always gets the real openSeedDatabase/
// planCanonicalOwnerBootstrap/bootstrapCanonicalOwner/bcrypt hash/
// process.env.OWNER_BOOTSTRAP_PASSWORD in production.
describe('main() CLI secret-flow contract (GC4F3R1)', () => {
  const readyPlanFixture: CanonicalOwnerBootstrapPlan = {
    canonical: { userId: CANONICAL_OWNER_USER_ID, email: CANONICAL_OWNER_EMAIL, expectedName: CANONICAL_OWNER_NAME },
    ownerRole: { id: 'fixture-owner-role-id', exists: true, unexpectedRolePermissionCount: 0, unexpectedRolePermissionCodes: [] },
    identityState: 'ABSENT',
    existingCanonicalUser: null,
    existingOwnerScopes: [],
    existingNonOwnerScopes: [],
    legacyUserBranchRoleRows: [],
    otherOwnerUsers: [],
    targetScope: { scopeKind: 'COMPANY', locationId: null },
    action: 'CREATE_USER_AND_OWNER_SCOPE',
    passwordRequiredForExecute: true,
    readyForExecution: true,
    blockers: [],
  };

  function fakeDb() {
    return { prisma: {} as never, close: vi.fn(async () => {}) };
  }

  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = 0;
  });

  it('A. dry-run never reads the password env, never hashes, never calls the mutator', async () => {
    const readPassword = vi.fn<() => string | undefined>(() => undefined);
    const hashPassword = vi.fn(async () => 'should-not-be-called');
    const bootstrapMock = vi.fn();
    const planMock = vi.fn(async () => readyPlanFixture);
    const openSeedDatabaseMock = vi.fn(async () => fakeDb());
    const deps: BootstrapCanonicalOwnerCliDeps = {
      openSeedDatabase: openSeedDatabaseMock as unknown as BootstrapCanonicalOwnerCliDeps['openSeedDatabase'],
      planCanonicalOwnerBootstrap: planMock as unknown as BootstrapCanonicalOwnerCliDeps['planCanonicalOwnerBootstrap'],
      bootstrapCanonicalOwner: bootstrapMock as unknown as BootstrapCanonicalOwnerCliDeps['bootstrapCanonicalOwner'],
      hashPassword,
      readPassword,
    };

    await main(['--target=test', '--dry-run'], deps);

    expect(planMock).toHaveBeenCalledTimes(1);
    expect(readPassword).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
    expect(bootstrapMock).not.toHaveBeenCalled();
  });

  it('B. execute-create fails before the mutator call when the password env is missing, with no secret in the error', async () => {
    const readPassword = vi.fn<() => string | undefined>(() => undefined);
    const hashPassword = vi.fn(async () => 'unused');
    const bootstrapMock = vi.fn();
    const planMock = vi.fn(async () => readyPlanFixture);
    const openSeedDatabaseMock = vi.fn(async () => fakeDb());
    const deps: BootstrapCanonicalOwnerCliDeps = {
      openSeedDatabase: openSeedDatabaseMock as unknown as BootstrapCanonicalOwnerCliDeps['openSeedDatabase'],
      planCanonicalOwnerBootstrap: planMock as unknown as BootstrapCanonicalOwnerCliDeps['planCanonicalOwnerBootstrap'],
      bootstrapCanonicalOwner: bootstrapMock as unknown as BootstrapCanonicalOwnerCliDeps['bootstrapCanonicalOwner'],
      hashPassword,
      readPassword,
    };

    await main(['--target=test', '--execute'], deps);

    expect(readPassword).toHaveBeenCalledTimes(1);
    expect(hashPassword).not.toHaveBeenCalled();
    expect(bootstrapMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    const loggedError = errorSpy.mock.calls.flat().join(' ');
    expect(loggedError).toContain('OWNER_BOOTSTRAP_PASSWORD is required');
    expect(loggedError).not.toContain('undefined'); // readPassword's return value never leaks into the message
  });

  it('C. execute-create passes plaintext only to hashPassword and forwards only the hash to the mutator', async () => {
    const readPassword = vi.fn<() => string | undefined>(() => 'super-secret-plaintext');
    const hashPassword = vi.fn(async (plaintext: string) => `hashed(${plaintext})`);
    const bootstrapMock = vi.fn(async () => ({
      actionPerformed: 'CREATE_USER_AND_OWNER_SCOPE' as const,
      userCreated: true,
      ownerScopeChanged: true,
      canonicalUserId: CANONICAL_OWNER_USER_ID,
    }));
    const planMock = vi.fn(async () => readyPlanFixture);
    const openSeedDatabaseMock = vi.fn(async () => fakeDb());
    const deps: BootstrapCanonicalOwnerCliDeps = {
      openSeedDatabase: openSeedDatabaseMock as unknown as BootstrapCanonicalOwnerCliDeps['openSeedDatabase'],
      planCanonicalOwnerBootstrap: planMock as unknown as BootstrapCanonicalOwnerCliDeps['planCanonicalOwnerBootstrap'],
      bootstrapCanonicalOwner: bootstrapMock as unknown as BootstrapCanonicalOwnerCliDeps['bootstrapCanonicalOwner'],
      hashPassword,
      readPassword,
    };

    await main(['--target=test', '--execute'], deps);

    expect(hashPassword).toHaveBeenCalledWith('super-secret-plaintext');
    expect(bootstrapMock).toHaveBeenCalledWith(expect.anything(), { createPasswordHash: 'hashed(super-secret-plaintext)' });
    const loggedOutput = logSpy.mock.calls.flat().join(' ') + errorSpy.mock.calls.flat().join(' ');
    expect(loggedOutput).not.toContain('super-secret-plaintext');
  });

  it('D. execute-existing never reads the password env, never hashes, and forwards no createPasswordHash', async () => {
    const readPassword = vi.fn<() => string | undefined>(() => undefined);
    const hashPassword = vi.fn(async () => 'unused');
    const bootstrapMock = vi.fn(async () => ({
      actionPerformed: 'ADD_OWNER_SCOPE' as const,
      userCreated: false,
      ownerScopeChanged: true,
      canonicalUserId: CANONICAL_OWNER_USER_ID,
    }));
    const existingUserPlan: CanonicalOwnerBootstrapPlan = {
      ...readyPlanFixture,
      identityState: 'EXACT_MATCH',
      action: 'ADD_OWNER_SCOPE',
      passwordRequiredForExecute: false,
      existingCanonicalUser: { id: CANONICAL_OWNER_USER_ID, email: CANONICAL_OWNER_EMAIL, name: CANONICAL_OWNER_NAME, isActive: true },
    };
    const planMock = vi.fn(async () => existingUserPlan);
    const openSeedDatabaseMock = vi.fn(async () => fakeDb());
    const deps: BootstrapCanonicalOwnerCliDeps = {
      openSeedDatabase: openSeedDatabaseMock as unknown as BootstrapCanonicalOwnerCliDeps['openSeedDatabase'],
      planCanonicalOwnerBootstrap: planMock as unknown as BootstrapCanonicalOwnerCliDeps['planCanonicalOwnerBootstrap'],
      bootstrapCanonicalOwner: bootstrapMock as unknown as BootstrapCanonicalOwnerCliDeps['bootstrapCanonicalOwner'],
      hashPassword,
      readPassword,
    };

    await main(['--target=test', '--execute'], deps);

    expect(readPassword).not.toHaveBeenCalled();
    expect(hashPassword).not.toHaveBeenCalled();
    expect(bootstrapMock).toHaveBeenCalledWith(expect.anything(), { createPasswordHash: undefined });
  });

  // E. Password preservation for the existing-user path is proven jointly by
  // D above (the CLI supplies no create hash for a RECONCILE/ADD action) and
  // by the dedicated service-level tests ("preserves an existing canonical
  // user's passwordHash unchanged" / the least-privilege select test above),
  // which prove bootstrapCanonicalOwner itself never writes User.passwordHash
  // on the existing-user path — no separate CLI test is needed to avoid
  // duplicating that proof.
});
