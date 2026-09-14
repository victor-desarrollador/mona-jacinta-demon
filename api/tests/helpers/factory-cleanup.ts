import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { FACTORY_LOCATION_CODE_PREFIX } from './factories.js';

// Deletes only Locations marked with FACTORY_LOCATION_CODE_PREFIX — never the
// canonical Company (single-company invariant, organization.service.ts's
// ensureCompany) and never the six canonical Locations, which carry no such
// prefix. UserRoleScope.locationId -> Location is onDelete: Cascade
// (schema.prisma), so deleting these Locations already removes any
// UserRoleScope rows pointing at them; nothing else needs explicit cleanup.
export async function cleanupFactoryOwnedLocations(
  prisma: PrismaClient,
): Promise<{ locationsDeleted: number }> {
  const { count } = await prisma.location.deleteMany({
    where: { code: { startsWith: FACTORY_LOCATION_CODE_PREFIX } },
  });
  return { locationsDeleted: count };
}
