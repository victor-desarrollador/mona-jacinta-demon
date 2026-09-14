import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { createBranch, createRole, createTestUser, FACTORY_LOCATION_CODE_PREFIX } from '../helpers/factories.js';
import { cleanupFactoryOwnedLocations } from '../helpers/factory-cleanup.js';

// Phase 1C correction: a dedicated TEST_FACTORY_COMPANY previously caused a
// second Company row to exist mid-suite, which tests/rbac/scope-backfill.test.ts's
// beforeAll (via organization.service.ts's ensureCompany) treats as corrupt
// state and refuses to guess between (Production V1 is single-company). This
// suite proves the fix holds: factory Locations attach to the one canonical
// Company, never create a second one, and cleanup removes only the
// factory-marked Locations, leaving the canonical Company/Locations intact.
describe('factory Location ownership under the canonical Company (Phase 1C correction)', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates a factory Location under the single canonical Company, and cleanup removes only that Location', async () => {
    // Precondition this whole suite depends on: exactly one Company already
    // exists (Phase 1A's canonical TEST Company) before any factory code runs.
    expect(await prisma.company.count()).toBe(1);
    const canonicalCompany = await prisma.company.findFirstOrThrow();
    const canonicalLocationsBefore = await prisma.location.findMany({
      where: { NOT: { code: { startsWith: FACTORY_LOCATION_CODE_PREFIX } } },
    });
    expect(canonicalLocationsBefore).toHaveLength(6);

    const branch = await createBranch(prisma);
    const role = await createRole(prisma);
    const user = await createTestUser(prisma, role, branch);

    // The critical invariant: still exactly one Company. Factory Locations
    // never spawn a second one.
    expect(await prisma.company.count()).toBe(1);

    const factoryLocation = await prisma.location.findUniqueOrThrow({ where: { id: branch.id } });
    expect(factoryLocation.code.startsWith(FACTORY_LOCATION_CODE_PREFIX)).toBe(true);
    expect(factoryLocation.companyId).toBe(canonicalCompany.id);

    const scope = await prisma.userRoleScope.findFirstOrThrow({ where: { userId: user.id } });
    expect(scope.locationId).toBe(factoryLocation.id);

    const { locationsDeleted } = await cleanupFactoryOwnedLocations(prisma);
    expect(locationsDeleted).toBeGreaterThanOrEqual(1);

    // Cleanup removed the factory Location (and, via ON DELETE CASCADE, its
    // UserRoleScope row) without touching the canonical Company or its six
    // canonical Locations.
    expect(await prisma.location.findUnique({ where: { id: factoryLocation.id } })).toBeNull();
    expect(await prisma.userRoleScope.findUnique({ where: { id: scope.id } })).toBeNull();
    expect(await prisma.company.count()).toBe(1);
    expect(await prisma.company.findUniqueOrThrow({ where: { id: canonicalCompany.id } })).toBeTruthy();
    const canonicalLocationsAfter = await prisma.location.findMany({
      where: { NOT: { code: { startsWith: FACTORY_LOCATION_CODE_PREFIX } } },
    });
    expect(canonicalLocationsAfter.map((l) => l.id).sort()).toEqual(
      canonicalLocationsBefore.map((l) => l.id).sort(),
    );
  });
});
