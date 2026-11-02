-- USER-MGMT-01 U2 (G22): the identity lifecycle's two database needs, and nothing else.
--
-- 1. Case-insensitive email uniqueness. The application normalizes (trim + lowercase); this UNIQUE index on lower("email") is the BACKSTOP that
--    makes `Maria@Local.com` and `maria@local.com` the same account under any concurrency. The existing case-sensitive "User_email_key" stays.
--    The migration ABORTS, writing nothing, when existing rows already collide case-insensitively: it never merges, renames or deletes an
--    account; the OWNER resolves a collision by hand and re-runs it.
-- 2. "UserAdminOperation": the append-only record that binds an (actor, idempotencyKey) to the canonical hash of ONE administrative operation
--    (create, reset password, deactivate, reactivate), so a retry is a replay and never a second effect. It stores who, what, which target and the
--    request hash — NEVER a password, a password hash or a token.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "User" GROUP BY lower("email") HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'G22 aborted: User.email collides case-insensitively; nothing was changed. Resolve the duplicate accounts by hand and run it again.'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE UNIQUE INDEX "User_email_lower_key"
  ON "User" (lower("email"));

CREATE TABLE "UserAdminOperation" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "targetUserId" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserAdminOperation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "chk_user_admin_operation_operation" CHECK ("operation" IN ('CREATE_USER', 'RESET_PASSWORD', 'DEACTIVATE_USER', 'REACTIVATE_USER')),
  CONSTRAINT "chk_user_admin_operation_request_hash" CHECK ("requestHash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "chk_user_admin_operation_key" CHECK ("idempotencyKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);

CREATE UNIQUE INDEX "UserAdminOperation_actorId_idempotencyKey_key" ON "UserAdminOperation"("actorId", "idempotencyKey");
CREATE INDEX "UserAdminOperation_targetUserId_createdAt_idx" ON "UserAdminOperation"("targetUserId", "createdAt");

ALTER TABLE "UserAdminOperation" ADD CONSTRAINT "UserAdminOperation_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserAdminOperation" ADD CONSTRAINT "UserAdminOperation_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
