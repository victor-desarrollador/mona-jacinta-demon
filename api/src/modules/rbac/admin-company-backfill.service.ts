import type { PrismaClient } from '../../generated/prisma/client.js';
import { ROLE_CODES } from './roles.js';

type Database = Pick<PrismaClient, 'role' | 'userRoleScope' | '$transaction'>;

export type AdminCompanyBackfillResult = { usersConverted: number };

// Phase 1D.4.1 one-time data correction (AGENTS.md's Checkpoint /
// docs/superpowers/plans/2026-09-14-phase-1d-production-authorization.md
// Task 1D.4.1): Phase 1C's UserBranchRole -> UserRoleScope backfill gave
// every ADMIN a LOCATION row per branch, but the Phase 1D target model
// (AGENTS.md "Roles — Production V1") makes ADMIN a COMPANY-scoped role.
// This converts each affected user's ADMIN assignment(s) into exactly one
// COMPANY row (locationId: null), scoped strictly to (userId, ADMIN
// roleId) per user — it never deletes by userId alone, so a co-existing,
// independent assignment for that user under a different role (e.g.
// CASHIER) is left completely untouched. CLI-invoked only (see
// scripts/backfill-admin-company-scope.ts); never called from a request
// path.
export async function backfillAdminCompanyScope(db: Database): Promise<AdminCompanyBackfillResult> {
  const adminRole = await db.role.findUnique({ where: { code: ROLE_CODES.ADMIN } });
  if (!adminRole) {
    throw new Error(
      'Production ADMIN Role does not exist; run the Phase 1B RBAC catalog bootstrap ' +
        '(bootstrapProductionRbacCatalog) first',
    );
  }

  const affectedUserIds = [
    ...new Set(
      (
        await db.userRoleScope.findMany({
          where: { roleId: adminRole.id, scopeKind: 'LOCATION' },
          select: { userId: true },
        })
      ).map((row) => row.userId),
    ),
  ];

  let usersConverted = 0;
  for (const userId of affectedUserIds) {
    await db.$transaction(async (tx) => {
      // Scoped to (userId, adminRole.id) ONLY — never userId alone, so an
      // independent assignment for the same user under a different roleId
      // is never touched by this deleteMany.
      await tx.userRoleScope.deleteMany({ where: { userId, roleId: adminRole.id } });
      await tx.userRoleScope.create({
        data: { userId, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null },
      });
    });
    usersConverted += 1;
  }

  return { usersConverted };
}
