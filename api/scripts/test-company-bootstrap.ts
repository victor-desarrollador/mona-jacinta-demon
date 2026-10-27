import type { CompanyBootstrap } from '../src/modules/organization/organization.service.js';

// Task 4: the one canonical TEST/LOCAL_TEST Company identity, shared by the
// Company/Location backfill suite, the test factories and future LOCAL_TEST
// preparation. Data only: importing this module never touches a database —
// Company/Location mutation stays with the explicit callers of
// backfillLocationsFromBranches (organization.service.ts).
//
// Only the Company lives here. The six canonical Locations are never listed:
// the backfill derives them at runtime from the seeded Branch rows
// (prisma/seed.ts), Location.id == Branch.id.
//
// Synthetic identity, never a real legal one. `id` and `cuit` identify the
// row; `name` and the placeholder `address` are not business identity, but
// ensureCompany reuses a row only on an exact match of all four fields, so
// they must stay byte-stable to keep matching the Company TEST already holds.
export const TEST_COMPANY_BOOTSTRAP: Readonly<CompanyBootstrap> = Object.freeze({
  id: '00000000-0000-4000-9100-000000000001',
  name: 'Mona Jacinta (test)',
  cuit: '00-11111111-1',
  address: 'Dirección legal test — pendiente de dato real',
});
