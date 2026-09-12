import type { PrismaClient } from '../../generated/prisma/client.js';

type OrgDatabase = Pick<PrismaClient, 'company' | 'location' | 'branch' | '$transaction'>;
type CompanyDelegate = Pick<PrismaClient, 'company'>;
type VerifyDatabase = Pick<PrismaClient, 'branch' | 'location' | 'company'>;

export type CompanyBootstrap = { id: string; name: string; cuit: string; address: string };

// docs/production-v1/02-functional-requirements.md FR-ORG-001: five retail
// branches plus one central warehouse/depot. `DEP` ("Depósito Central") is the
// only seeded Branch matching "central warehouse/depot"; every other seeded
// Branch is a named retail location. This mapping is not a heuristic — it is
// the approved 5+1 split stated by the frozen requirement.
const CENTRAL_WAREHOUSE_CODE = 'DEP';

export function locationTypeForBranchCode(code: string) {
  return code === CENTRAL_WAREHOUSE_CODE ? 'CENTRAL_WAREHOUSE' : 'RETAIL_BRANCH';
}

// Company is a single, never-deleted, immutable-after-creation row (§Company,
// 06-erd-data-model.md). Production V1 is single-company: more than one
// existing row is ambiguous/corrupt state, not a "pick one" situation, so this
// fails closed instead of silently choosing an arbitrary row. `bootstrap`
// (including any placeholder legal identity) is supplied by the caller — this
// function never encodes demo or production business values itself, so a
// caller wired to a real bootstrap process can never inherit a hardcoded demo
// CUIT.
//
// A single existing row is reused only if it IS the Company the caller
// expects — every field the bootstrap actually carries (id, cuit, name,
// address) must match exactly. Company identity is immutable after creation
// (§Company, 06-erd-data-model.md), so a single row that does NOT match is
// not "the same Company with different values to converge" (unlike Location's
// mutable name/address/pointOfSaleNumber) — it is a different, unexpected
// Company, and this throws rather than silently reusing, updating, or
// replacing it. `isActive`/`createdAt` are not part of `CompanyBootstrap`
// (isActive is a schema default, createdAt is server-generated) and are not
// compared here for the same reason: they are not caller-supplied identity.
export async function ensureCompany(db: CompanyDelegate, bootstrap: CompanyBootstrap) {
  const existing = await db.company.findMany({ take: 2 });
  if (existing.length > 1) {
    throw new Error(
      'Ambiguous Company state: more than one Company row exists; Production V1 is single-company. Refusing to guess which one is authoritative.',
    );
  }
  if (existing.length === 1) {
    const company = existing[0]!;
    const matchesBootstrap =
      company.id === bootstrap.id &&
      company.cuit === bootstrap.cuit &&
      company.name === bootstrap.name &&
      company.address === bootstrap.address;
    if (!matchesBootstrap) {
      throw new Error(
        `Unexpected Company row (id=${company.id}) does not match the supplied bootstrap ` +
          `identity; Company is immutable after creation, so refusing to reuse, mutate, or ` +
          `replace it. If this is an intentionally-created real Company, the caller's ` +
          `bootstrap must be updated to match it, not the other way around.`,
      );
    }
    return company;
  }
  return db.company.create({ data: bootstrap });
}

// ADD -> BACKFILL step of the Branch -> Location lifecycle
// (docs/development/migrations.md §5; docs/production-v1/08-implementation-roadmap.md
// Phase 1A). Idempotent: converges by `code` (shared with the source Branch)
// instead of blindly upserting — an existing Location with a matching code but
// a different companyId/type is a different logical entity (or corrupt state),
// never silently overwritten with this Branch's data. Branch itself is never
// read-write beyond a plain SELECT here, and is never mutated, renamed, or
// removed.
//
// Location.id is set to the source Branch's own id (see Phase 1A final
// data-integrity review, §2). This is deliberate, not incidental: the frozen
// ERD (06-erd-data-model.md) already calls Location an "ALTER (Demo V2 Branch
// -> add type)" of Branch — i.e. Location is the eventual evolution of Branch,
// not an unrelated new entity that happens to import its data. Carrying the
// same id forward gives Phase 1C (and any later branchId -> locationId
// migration on Sale, Inventory, StockMovement, CashRegister, AuditLog,
// UserBranchRole, ...) a permanent, non-lookup identity link: `locationId =
// branchId` directly, with no join on a mutable business key like `code`
// required or even possible to get wrong. It also makes cross-database
// determinism free: Branch.id is already deterministic (prisma/seed.ts),
// so every backfilled Location.id inherits that same determinism.
export async function backfillLocationsFromBranches(
  db: OrgDatabase,
  companyBootstrap: CompanyBootstrap,
) {
  return db.$transaction(async (tx) => {
    const company = await ensureCompany(tx, companyBootstrap);
    const branches = await tx.branch.findMany({ orderBy: { code: 'asc' } });
    for (const branch of branches) {
      const expectedType = locationTypeForBranchCode(branch.code);
      const existing = await tx.location.findUnique({ where: { code: branch.code } });
      if (existing) {
        // `pointOfSaleNumber` is checked here, not converged like name/address
        // below: the ERD only declares name/address mutable for Location
        // (06-erd-data-model.md §Location); pointOfSaleNumber's mutability is
        // unstated, it is `@unique`, and in production terms it is a
        // fiscal/AFIP-style registered identifier — not safe to silently
        // overwrite back to Branch's value if it has legitimately diverged
        // (e.g. a real renumbering applied directly to Location). A mismatch
        // here is treated the same as an id/companyId/type mismatch: fail
        // closed rather than silently reverting it.
        if (
          existing.id !== branch.id ||
          existing.companyId !== company.id ||
          existing.type !== expectedType ||
          existing.pointOfSaleNumber !== branch.pointOfSaleNumber
        ) {
          throw new Error(
            `Location code ${branch.code} already exists but does not match the expected ` +
              `Branch mapping (id, companyId, type, or pointOfSaleNumber mismatch); refusing ` +
              `to silently overwrite what may be an unrelated Location or revert a legitimate ` +
              `change`,
          );
        }
        // `id`, `type`, `companyId` and `pointOfSaleNumber` are never part of
        // this update — see the checks above. Only name/address, which the
        // ERD explicitly declares mutable, converge from Branch on rerun.
        await tx.location.update({
          where: { code: branch.code },
          data: {
            name: branch.name,
            address: branch.address,
          },
        });
      } else {
        await tx.location.create({
          data: {
            id: branch.id,
            companyId: company.id,
            name: branch.name,
            code: branch.code,
            type: expectedType,
            address: branch.address,
            pointOfSaleNumber: branch.pointOfSaleNumber,
          },
        });
      }
    }
    return { companyId: company.id, branchCount: branches.length };
  });
}

// VERIFY step: proves the backfill's invariants hold without trusting the
// transaction's exit code alone.
export async function verifyBackfill(db: VerifyDatabase) {
  const [branches, locations, companies] = await Promise.all([
    db.branch.findMany(),
    db.location.findMany(),
    db.company.findMany(),
  ]);

  const issues: string[] = [];
  if (companies.length !== 1) {
    issues.push(`expected exactly 1 Company, found ${companies.length}`);
  }
  if (locations.length !== branches.length) {
    issues.push(
      `expected ${branches.length} Locations (one per Branch), found ${locations.length}`,
    );
  }

  const locationByCode = new Map(locations.map((location) => [location.code, location]));
  for (const branch of branches) {
    const location = locationByCode.get(branch.code);
    if (!location) {
      issues.push(`Branch ${branch.code} has no matching Location`);
      continue;
    }
    if (location.id !== branch.id) {
      issues.push(`Location ${location.code}: id does not match its source Branch id`);
    }
    if (location.name !== branch.name) issues.push(`Location ${location.code}: name mismatch`);
    if (location.address !== branch.address) issues.push(`Location ${location.code}: address mismatch`);
    if (location.pointOfSaleNumber !== branch.pointOfSaleNumber) {
      issues.push(`Location ${location.code}: pointOfSaleNumber mismatch`);
    }
    const expectedType = locationTypeForBranchCode(branch.code);
    if (location.type !== expectedType) {
      issues.push(
        `Location ${location.code}: type mismatch (expected ${expectedType}, got ${location.type})`,
      );
    }
  }

  const codes = new Set(locations.map((location) => location.code));
  if (codes.size !== locations.length) issues.push('duplicate Location code detected');
  const posNumbers = new Set(locations.map((location) => location.pointOfSaleNumber));
  if (posNumbers.size !== locations.length) {
    issues.push('duplicate Location pointOfSaleNumber detected');
  }

  return {
    ok: issues.length === 0,
    issues,
    companyCount: companies.length,
    branchCount: branches.length,
    locationCount: locations.length,
  };
}
