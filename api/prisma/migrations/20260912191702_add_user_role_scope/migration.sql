-- CreateEnum
CREATE TYPE "ScopeKind" AS ENUM ('LOCATION', 'COMPANY');

-- CreateTable
CREATE TABLE "UserRoleScope" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "scopeKind" "ScopeKind" NOT NULL DEFAULT 'LOCATION',
    "locationId" TEXT,

    CONSTRAINT "UserRoleScope_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserRoleScope_locationId_idx" ON "UserRoleScope"("locationId");

-- CreateIndex
CREATE INDEX "UserRoleScope_roleId_idx" ON "UserRoleScope"("roleId");

-- CreateIndex
CREATE INDEX "UserRoleScope_scopeKind_idx" ON "UserRoleScope"("scopeKind");

-- AddForeignKey
ALTER TABLE "UserRoleScope" ADD CONSTRAINT "UserRoleScope_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleScope" ADD CONSTRAINT "UserRoleScope_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserRoleScope" ADD CONSTRAINT "UserRoleScope_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma has no @@check (docs/development/migrations.md §12). Table is new and
-- empty in this migration, so no existing-row violation is possible; no
-- pre-check or NOT VALID two-phase pattern is required (§13).
ALTER TABLE "UserRoleScope" ADD CONSTRAINT "chk_user_role_scope_consistency" CHECK (
  ("scopeKind" = 'LOCATION' AND "locationId" IS NOT NULL)
  OR
  ("scopeKind" = 'COMPANY' AND "locationId" IS NULL)
);

-- Prisma's plain @@unique treats NULL as distinct and would not stop duplicate
-- COMPANY-scope rows (locationId always NULL) for the same user+role. Two
-- partial unique indexes cover the full (userId, roleId, scopeKind,
-- locationId) uniqueness with correct NULL semantics, following this
-- project's existing partial-unique-index precedent
-- (cash_session_one_open_per_register) rather than NULLS NOT DISTINCT
-- (docs/development/migrations.md §12/§14, docs/production-v1/05-architecture.md §5).
CREATE UNIQUE INDEX uq_user_role_scope_location
  ON "UserRoleScope" ("userId", "roleId", "scopeKind", "locationId")
  WHERE "locationId" IS NOT NULL;

CREATE UNIQUE INDEX uq_user_role_scope_company
  ON "UserRoleScope" ("userId", "roleId", "scopeKind")
  WHERE "locationId" IS NULL;
