-- USER-MGMT-01 U1 (G21): the two columns the auth foundations need, and nothing else.
--
-- "mustChangePassword": the account must set its own password before it can do anything else (enforced by the API; the temporary
--   credentials of a later phase set it). false for every existing row: nobody is forced to change anything by this migration.
-- "credentialsChangedAt": the credentials EPOCH (milliseconds) the access token's `cc` claim must equal. NULL = the account has never
--   changed credentials; an existing token (no `cc`) stays valid exactly while it is NULL. No default, no backfill.
--
-- Additive and rollback-compatible: an API that does not know the columns ignores them (explicit selects, defaulted insert).
ALTER TABLE "User" ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "credentialsChangedAt" TIMESTAMPTZ(3);
