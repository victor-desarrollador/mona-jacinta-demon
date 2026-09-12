import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDemo } from '../../prisma/seed.js';
import { openSeedDatabase } from '../../scripts/demo-database.js';
import {
  backfillLocationsFromBranches,
  ensureCompany,
  locationTypeForBranchCode,
  verifyBackfill,
  type CompanyBootstrap,
} from '../../src/modules/organization/organization.service.js';

// Only this file needs a real database. Migration 20260912182432_add_company_location
// must already be applied to TEST_DATABASE_URL before this file runs (see
// docs/development/production-migration-readiness.md and the Phase 1A report).
describe('Company/Location backfill (Phase 1A)', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;

  // Distinct from the CLI's DEMO_COMPANY_BOOTSTRAP (different id/cuit), proving
  // the domain service takes bootstrap data from its caller rather than
  // encoding any fixed demo identity itself.
  const TEST_COMPANY_BOOTSTRAP: CompanyBootstrap = {
    id: '00000000-0000-4000-9100-000000000001',
    name: 'Mona Jacinta (test)',
    cuit: '00-11111111-1',
    address: 'Dirección legal test — pendiente de dato real',
  };

  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error('Organization backfill integration operation failed (database details suppressed)');
    }
  }

  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
    // Deterministic known-good Branch state, independent of any other test
    // file's leftover data — same convention as api/tests/seed.test.ts.
    await safely(() => resetDemo(db.prisma));
  }, 120000);

  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  it('maps the approved LocationType split (FR-ORG-001: five retail branches, one central warehouse)', () => {
    expect(locationTypeForBranchCode('DEP')).toBe('CENTRAL_WAREHOUSE');
    for (const code of ['CEN', 'YB', 'TV', 'BAN', 'CON']) {
      expect(locationTypeForBranchCode(code)).toBe('RETAIL_BRANCH');
    }
  });

  it('from a clean slate, backfills a deterministic Company id from the bootstrap and carries each Branch id forward as its Location id', async () => {
    await safely(async () => {
      // Clean slate: nothing here is referenced by any FK yet (Phase 1A only),
      // so this is a safe, fully-regeneratable reset — same idea as resetDemo()
      // already applies to Branch/User in this same suite.
      await db.prisma.location.deleteMany();
      await db.prisma.company.deleteMany();

      const result = await backfillLocationsFromBranches(db.prisma, TEST_COMPANY_BOOTSTRAP);
      expect(result.branchCount).toBe(6);
      expect(result.companyId).toBe(TEST_COMPANY_BOOTSTRAP.id);

      const company = await db.prisma.company.findFirstOrThrow();
      expect(company.id).toBe(TEST_COMPANY_BOOTSTRAP.id);
      expect(company.cuit).toBe(TEST_COMPANY_BOOTSTRAP.cuit);

      const branches = await db.prisma.branch.findMany();
      const locations = await db.prisma.location.findMany();
      const byCode = new Map(locations.map((location) => [location.code, location]));
      for (const branch of branches) {
        // The core identity-strategy invariant: Location.id === source Branch.id,
        // a permanent non-lookup link for a future branchId -> locationId migration.
        expect(byCode.get(branch.code)!.id).toBe(branch.id);
      }

      const verification = await verifyBackfill(db.prisma);
      expect(verification.issues).toEqual([]);
      expect(verification.ok).toBe(true);
      expect(verification.companyCount).toBe(1);
      expect(verification.locationCount).toBe(6);
    });
  }, 60000);

  it('preserves name/code/address/pointOfSaleNumber and assigns the approved type per Location', async () => {
    await safely(async () => {
      const branches = await db.prisma.branch.findMany({ orderBy: { code: 'asc' } });
      const locations = await db.prisma.location.findMany({ orderBy: { code: 'asc' } });
      const byCode = new Map(locations.map((location) => [location.code, location]));
      for (const branch of branches) {
        const location = byCode.get(branch.code)!;
        expect(location.name).toBe(branch.name);
        expect(location.address).toBe(branch.address);
        expect(location.pointOfSaleNumber).toBe(branch.pointOfSaleNumber);
        expect(location.type).toBe(locationTypeForBranchCode(branch.code));
      }
      expect(byCode.get('DEP')!.type).toBe('CENTRAL_WAREHOUSE');
      for (const code of ['CEN', 'YB', 'TV', 'BAN', 'CON']) {
        expect(byCode.get(code)!.type).toBe('RETAIL_BRANCH');
      }
    });
  });

  it('is idempotent: rerunning converges without duplicating Company or Location rows, or changing ids', async () => {
    await safely(async () => {
      const before = {
        locations: await db.prisma.location.findMany({ orderBy: { code: 'asc' } }),
        companies: await db.prisma.company.count(),
      };
      await backfillLocationsFromBranches(db.prisma, TEST_COMPANY_BOOTSTRAP);
      await backfillLocationsFromBranches(db.prisma, TEST_COMPANY_BOOTSTRAP);
      const after = await db.prisma.location.findMany({ orderBy: { code: 'asc' } });
      expect(after.map((l) => l.id)).toEqual(before.locations.map((l) => l.id));
      expect(await db.prisma.company.count()).toBe(before.companies);
      const verification = await verifyBackfill(db.prisma);
      expect(verification.ok).toBe(true);
    });
  }, 60000);

  it('rejects a duplicate Location code at the database level', async () => {
    await safely(async () => {
      const company = await db.prisma.company.findFirstOrThrow();
      await expect(
        db.prisma.location.create({
          data: {
            companyId: company.id,
            name: 'Duplicate',
            code: 'CEN',
            type: 'RETAIL_BRANCH',
            address: 'x',
            pointOfSaleNumber: 99001,
          },
        }),
      ).rejects.toThrow();
    });
  });

  it('rejects a duplicate Location pointOfSaleNumber at the database level', async () => {
    await safely(async () => {
      const company = await db.prisma.company.findFirstOrThrow();
      await expect(
        db.prisma.location.create({
          data: {
            companyId: company.id,
            name: 'Duplicate POS',
            code: 'ZZZ-DUP-POS',
            type: 'RETAIL_BRANCH',
            address: 'x',
            pointOfSaleNumber: 1,
          },
        }),
      ).rejects.toThrow();
    });
  });

  it('rejects a Location with a non-existent companyId', async () => {
    await safely(async () => {
      await expect(
        db.prisma.location.create({
          data: {
            companyId: '00000000-0000-4000-8000-000000000000',
            name: 'Orphan',
            code: 'ZZZ-ORPHAN',
            type: 'RETAIL_BRANCH',
            address: 'x',
            pointOfSaleNumber: 99002,
          },
        }),
      ).rejects.toThrow();
    });
  });

  it('fails closed instead of silently overwriting a Location code that maps to a different company/type', async () => {
    await safely(async () => {
      const company = await db.prisma.company.findFirstOrThrow();
      // Simulate an unrelated/corrupt row occupying CEN's code with the wrong type.
      await db.prisma.location.delete({ where: { code: 'CEN' } });
      await db.prisma.location.create({
        data: {
          companyId: company.id,
          name: 'Impostor',
          code: 'CEN',
          type: 'CENTRAL_WAREHOUSE', // wrong: CEN must be RETAIL_BRANCH
          address: 'x',
          pointOfSaleNumber: 1,
        },
      });
      await expect(
        backfillLocationsFromBranches(db.prisma, TEST_COMPANY_BOOTSTRAP),
      ).rejects.toThrow(/does not match the expected/);

      // Restore: remove the impostor and let a clean rerun recreate CEN correctly.
      await db.prisma.location.delete({ where: { code: 'CEN' } });
      const result = await backfillLocationsFromBranches(db.prisma, TEST_COMPANY_BOOTSTRAP);
      expect(result.branchCount).toBe(6);
      const verification = await verifyBackfill(db.prisma);
      expect(verification.ok).toBe(true);
    });
  }, 60000);

  it('fails closed when more than one Company row exists, instead of picking one', async () => {
    await safely(async () => {
      const extra = await db.prisma.company.create({
        data: {
          name: 'Unexpected extra company',
          cuit: '99-99999999-9',
          address: 'x',
        },
      });
      await expect(
        backfillLocationsFromBranches(db.prisma, TEST_COMPANY_BOOTSTRAP),
      ).rejects.toThrow(/Ambiguous Company/);
      await db.prisma.company.delete({ where: { id: extra.id } });
      // Confirm normal operation is restored once ambiguity is gone.
      const verification = await verifyBackfill(db.prisma);
      expect(verification.ok).toBe(true);
    });
  }, 60000);

  it('fails closed when exactly one Company exists but does not match the bootstrap, without mutating or duplicating it', async () => {
    await safely(async () => {
      // Location.companyId is onDelete: Restrict, so it must go first to
      // legally remove the (matching) Company underneath it.
      await db.prisma.location.deleteMany();
      await db.prisma.company.deleteMany();

      const unexpected = await db.prisma.company.create({
        data: {
          name: 'Some other, unrelated company',
          cuit: '55-55555555-5',
          address: 'Unexpected address',
        },
      });

      await expect(ensureCompany(db.prisma, TEST_COMPANY_BOOTSTRAP)).rejects.toThrow(
        /does not match the supplied bootstrap/,
      );

      // Not mutated by the refused call.
      expect(await db.prisma.company.findUniqueOrThrow({ where: { id: unexpected.id } })).toEqual(
        unexpected,
      );
      // No second Company was created alongside it.
      expect(await db.prisma.company.count()).toBe(1);

      // Cleaning the invalid fixture lets normal bootstrap succeed again.
      await db.prisma.company.delete({ where: { id: unexpected.id } });
      const result = await backfillLocationsFromBranches(db.prisma, TEST_COMPANY_BOOTSTRAP);
      expect(result.companyId).toBe(TEST_COMPANY_BOOTSTRAP.id);
      const verification = await verifyBackfill(db.prisma);
      expect(verification.ok).toBe(true);
    });
  }, 60000);

  it('leaves Branch data intact after backfill', async () => {
    await safely(async () => {
      const branches = await db.prisma.branch.findMany({
        orderBy: { pointOfSaleNumber: 'asc' },
      });
      expect(branches.map((b) => [b.code, b.name, b.pointOfSaleNumber])).toEqual([
        ['CEN', 'Centro', 1],
        ['YB', 'Yerba Buena', 2],
        ['TV', 'Tafí Viejo', 3],
        ['BAN', 'Banda', 4],
        ['CON', 'Concepción', 5],
        ['DEP', 'Depósito Central', 6],
      ]);
    });
  });

  it('leaves existing Branch-scoped consumers (Inventory) functional', async () => {
    await safely(async () => {
      const branch = await db.prisma.branch.findFirstOrThrow({ where: { code: 'CEN' } });
      const inventoryCount = await db.prisma.inventory.count({ where: { branchId: branch.id } });
      expect(inventoryCount).toBeGreaterThan(0);
    });
  });
});
