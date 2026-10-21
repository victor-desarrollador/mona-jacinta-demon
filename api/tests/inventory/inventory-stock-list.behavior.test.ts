// WAREHOUSE-MVP: DB-FREE route contract for GET /inventory/stock (paginated,
// searchable stock list for the warehouse screen). Everything below the stub
// Prisma client is real: buildAuthorizationContext, requirePermission, the
// strict query DTO, the router, controller and service.
//
// PRE-REGISTERED EXPECTATIONS (2026-10-20), G01..G12:
//   G01 no auth -> 401, no read
//   G02 INVENTORY_MANAGE missing at the branch (SELLER / CASHIER / WAREHOUSE elsewhere) -> 403, no read
//   G03 authorized WAREHOUSE -> 200 { items, pagination } with BigInt quantities as strings
//   G04 an active variant without an Inventory row is listed as 0/0/0
//   G05 search matches product name, SKU, barcode, color and size (case-insensitive)
//   G06 real pagination with the total of the filtered set; defaults page 1 / limit 50
//   G07 limit > 100, limit 0, page 0, malformed branchId, extra params -> 400, no read
//   G08 only active variants; stable order by product name then SKU
//   G09 available = physical - reserved
//   G10 COMPANY ADMIN and OWNER are authorized
//   G11 the inventory join is restricted to the requested branch
//   G12..G15 (audit M1) branchId must be an existing ACTIVE location: unknown -> 404, inactive -> 404,
//            authorization is decided BEFORE existence (unauthorized -> 403 for known and unknown ids alike)
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { errorHandler } from '../../src/middleware/errorHandler.js';
import { createInventoryRouter } from '../../src/modules/inventory/inventory.routes.js';
import { buildAuthorizationContext } from '../../src/modules/rbac/authorization-context.js';
import { DEFAULT_ROLE_GRANTS } from '../../src/modules/rbac/role-permission-matrix.js';

const BRANCH = '00000000-0000-4000-8000-0000000000a1';
const OTHER_BRANCH = '00000000-0000-4000-8000-0000000000b2';
const INACTIVE_BRANCH = '00000000-0000-4000-8000-0000000000b3';
const UNKNOWN_BRANCH = '00000000-0000-4000-8000-0000000000e9';

type RoleName = keyof typeof DEFAULT_ROLE_GRANTS | 'OWNER';
type Scope = { role: RoleName; at: string | 'COMPANY' };

async function authFor(scopes: Scope[]) {
  return buildAuthorizationContext(
    { location: { findMany: async () => [BRANCH, OTHER_BRANCH, INACTIVE_BRANCH].map((id) => ({ id })) } },
    {
      id: 'user-1',
      branchRoles: [],
      roleScopes: scopes.map((scope) => ({
        roleId: `role-${scope.role}`,
        scopeKind: scope.at === 'COMPANY' ? ('COMPANY' as const) : ('LOCATION' as const),
        locationId: scope.at === 'COMPANY' ? null : scope.at,
        role: {
          code: scope.role,
          permissions: (scope.role === 'OWNER' ? [] : [...DEFAULT_ROLE_GRANTS[scope.role]]).map((code) => ({ permission: { code } })),
        },
      })),
    },
  );
}

type VariantRow = {
  id: string; sku: string; barcode: string; color: string | null; size: string | null; isActive: boolean;
  product: { id: string; name: string };
  inventory: Array<{ branchId: string; physical: bigint; reserved: bigint }>;
};

const variant = (n: number, overrides: Partial<VariantRow> = {}): VariantRow => ({
  id: `00000000-0000-4000-8000-00000000f${String(n).padStart(3, '0')}`,
  sku: `SKU-${String(n).padStart(3, '0')}`, barcode: `779000${String(n).padStart(6, '0')}`, color: 'Negro', size: 'M', isActive: true,
  product: { id: `product-${n}`, name: `Remera ${n}` },
  inventory: [{ branchId: BRANCH, physical: 10n, reserved: 4n }],
  ...overrides,
});

type Where = { isActive?: boolean; OR?: Array<Record<string, unknown>> };
const contains = (value: string | null, needle: string) => (value ?? '').toLowerCase().includes(needle.toLowerCase());

let rows: VariantRow[] = [];
const findMany = vi.fn();
const count = vi.fn();
const locations = new Map<string, { isActive: boolean }>();
const branchFindUnique = vi.fn();
const locationFindUnique = vi.fn();

function matching(where: Where) {
  return rows
    .filter((row) => where.isActive === undefined || row.isActive === where.isActive)
    .filter((row) => !where.OR || where.OR.some((clause) => {
      const [field] = Object.keys(clause);
      const filter = (clause as Record<string, { contains?: string } & Record<string, unknown>>)[field!]!;
      if (field === 'product') return contains(row.product.name, String((filter as { name: { contains: string } }).name.contains));
      return contains((row as unknown as Record<string, string | null>)[field!]!, String(filter.contains));
    }))
    .sort((a, b) => a.product.name.localeCompare(b.product.name) || a.sku.localeCompare(b.sku));
}

beforeEach(() => {
  rows = [];
  locations.clear();
  for (const id of [BRANCH, OTHER_BRANCH]) locations.set(id, { isActive: true });
  locations.set(INACTIVE_BRANCH, { isActive: false });
  branchFindUnique.mockReset();
  locationFindUnique.mockReset();
  branchFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => (locations.has(where.id) ? { id: where.id } : null));
  locationFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => locations.get(where.id) ?? null);
  findMany.mockReset();
  count.mockReset();
  findMany.mockImplementation(async ({ where, skip = 0, take }: { where: Where; skip?: number; take: number }) =>
    matching(where).slice(skip, skip + take).map((row) => ({
      ...row,
      inventory: row.inventory.filter((inv) => inv.branchId === BRANCH).map(({ physical, reserved }) => ({ physical, reserved })),
    })));
  count.mockImplementation(async ({ where }: { where: Where }) => matching(where).length);
});

function list(auth: Express.AuthContext | undefined, query: Record<string, string>) {
  const app = express();
  app.use((req, _res, next) => { if (auth) req.auth = auth; next(); });
  app.use('/inventory', createInventoryRouter({ productVariant: { findMany, count }, branch: { findUnique: branchFindUnique }, location: { findUnique: locationFindUnique } } as unknown as PrismaClient));
  app.use(errorHandler);
  return request(app).get('/inventory/stock').query(query);
}
const noRead = () => { expect(findMany).not.toHaveBeenCalled(); expect(count).not.toHaveBeenCalled(); };

describe('GET /inventory/stock (WAREHOUSE-MVP route contract)', () => {
  it('G01 refuses an unauthenticated request with 401 before any read', async () => {
    expect((await list(undefined, { branchId: BRANCH })).status).toBe(401);
    noRead();
  });

  it('G02 refuses callers without INVENTORY_MANAGE at the requested branch with 403 before any read', async () => {
    for (const scope of [{ role: 'SELLER', at: BRANCH }, { role: 'CASHIER', at: BRANCH }, { role: 'WAREHOUSE', at: OTHER_BRANCH }] as Scope[]) {
      expect((await list(await authFor([scope]), { branchId: BRANCH })).status, `${scope.role}@${scope.at}`).toBe(403);
    }
    noRead();
  });

  it('G03 returns items and pagination with BigInt quantities as strings', async () => {
    rows = [variant(1)];
    const response = await list(await authFor([{ role: 'WAREHOUSE', at: BRANCH }]), { branchId: BRANCH });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      items: [{
        variantId: rows[0]!.id, productId: 'product-1', productName: 'Remera 1', sku: 'SKU-001', barcode: '779000000001',
        color: 'Negro', size: 'M', physical: '10', reserved: '4', available: '6',
      }],
      pagination: { page: 1, limit: 50, total: 1 },
    });
  });

  it('G04 lists an active variant without an Inventory row as 0/0/0', async () => {
    rows = [variant(1, { inventory: [] })];
    const response = await list(await authFor([{ role: 'WAREHOUSE', at: BRANCH }]), { branchId: BRANCH });
    expect(response.body.items[0]).toMatchObject({ physical: '0', reserved: '0', available: '0' });
  });

  it.each([
    ['product name', 'camperita', 'SKU-002'],
    ['SKU', 'sku-003', 'SKU-003'],
    ['barcode', '779000000004', 'SKU-004'],
    ['color', 'turquesa', 'SKU-005'],
    ['size', 'xxl', 'SKU-006'],
  ])('G05 searches by %s (case-insensitive)', async (_name, search, expectedSku) => {
    rows = [
      variant(1), variant(2, { product: { id: 'p2', name: 'Camperita Pro' } }), variant(3), variant(4),
      variant(5, { color: 'Turquesa' }), variant(6, { size: 'XXL' }),
    ];
    const response = await list(await authFor([{ role: 'WAREHOUSE', at: BRANCH }]), { branchId: BRANCH, search });
    expect(response.status).toBe(200);
    expect(response.body.items.map((item: { sku: string }) => item.sku)).toEqual([expectedSku]);
    expect(response.body.pagination.total).toBe(1);
  });

  it('G06 paginates for real and reports the total of the filtered set', async () => {
    rows = Array.from({ length: 5 }, (_, index) => variant(index + 1));
    const auth = await authFor([{ role: 'WAREHOUSE', at: BRANCH }]);
    const second = await list(auth, { branchId: BRANCH, page: '2', limit: '2' });
    expect(second.body.items.map((item: { sku: string }) => item.sku)).toEqual(['SKU-003', 'SKU-004']);
    expect(second.body.pagination).toEqual({ page: 2, limit: 2, total: 5 });
    const last = await list(auth, { branchId: BRANCH, page: '3', limit: '2' });
    expect(last.body.items.map((item: { sku: string }) => item.sku)).toEqual(['SKU-005']);
    const defaults = await list(auth, { branchId: BRANCH });
    expect(defaults.body.pagination).toEqual({ page: 1, limit: 50, total: 5 });
  });

  it.each([
    ['limit 101', { limit: '101' }],
    ['limit 0', { limit: '0' }],
    ['page 0', { page: '0' }],
    ['non numeric page', { page: 'x' }],
    ['malformed branchId', { branchId: 'nope' }],
    ['extra parameter', { take: '1000' }],
  ])('G07 rejects %s with 400 before any read', async (_name, change) => {
    const response = await list(await authFor([{ role: 'WAREHOUSE', at: BRANCH }]), { branchId: BRANCH, ...change });
    expect(response.status).toBe(400);
    noRead();
  });

  it('G08 lists only active variants ordered by product name then SKU', async () => {
    rows = [
      variant(1, { product: { id: 'pb', name: 'Buzo' }, sku: 'B-2' }),
      variant(2, { product: { id: 'pa', name: 'Abrigo' }, sku: 'A-9' }),
      variant(3, { product: { id: 'pb', name: 'Buzo' }, sku: 'B-1' }),
      variant(4, { isActive: false, sku: 'Z-0' }),
    ];
    const response = await list(await authFor([{ role: 'WAREHOUSE', at: BRANCH }]), { branchId: BRANCH });
    expect(response.body.items.map((item: { sku: string }) => item.sku)).toEqual(['A-9', 'B-1', 'B-2']);
    expect(findMany.mock.calls[0]![0].where).toMatchObject({ isActive: true });
    expect(findMany.mock.calls[0]![0].orderBy).toEqual([{ product: { name: 'asc' } }, { sku: 'asc' }]);
  });

  it('G09 available is physical minus reserved', async () => {
    rows = [variant(1, { inventory: [{ branchId: BRANCH, physical: 7n, reserved: 7n }] })];
    const response = await list(await authFor([{ role: 'WAREHOUSE', at: BRANCH }]), { branchId: BRANCH });
    expect(response.body.items[0]).toMatchObject({ physical: '7', reserved: '7', available: '0' });
  });

  it('G10 COMPANY ADMIN and OWNER are authorized', async () => {
    for (const role of ['ADMIN', 'OWNER'] as const) {
      expect((await list(await authFor([{ role, at: 'COMPANY' }]), { branchId: BRANCH })).status, role).toBe(200);
    }
  });

  it('G11 restricts the inventory join to the requested branch', async () => {
    rows = [variant(1, { inventory: [{ branchId: OTHER_BRANCH, physical: 99n, reserved: 0n }] })];
    const response = await list(await authFor([{ role: 'WAREHOUSE', at: BRANCH }]), { branchId: BRANCH });
    expect(response.body.items[0]).toMatchObject({ physical: '0', reserved: '0' });
    const select = findMany.mock.calls[0]![0].select;
    expect(select.inventory.where).toEqual({ branchId: BRANCH });
  });

  it.each([['OWNER', 'COMPANY'], ['ADMIN', 'COMPANY']] as const)('G12 %s asking for an unknown branch gets 404 NOT_FOUND, never an empty 0/0/0 catalog', async (role, at) => {
    rows = [variant(1)];
    const response = await list(await authFor([{ role, at }]), { branchId: UNKNOWN_BRANCH });
    expect(response.status).toBe(404);
    expect(response.body.error?.code ?? response.body.code).toBe('NOT_FOUND');
    expect(response.body.items).toBeUndefined();
    noRead();
  });

  it('G13 an inactive location is 404 even for OWNER', async () => {
    rows = [variant(1)];
    const response = await list(await authFor([{ role: 'OWNER', at: 'COMPANY' }]), { branchId: INACTIVE_BRANCH });
    expect(response.status).toBe(404);
    expect(response.body.items).toBeUndefined();
    noRead();
  });

  it('G14 a valid, authorized, active location still lists (and checks Branch and Location)', async () => {
    rows = [variant(1)];
    const response = await list(await authFor([{ role: 'WAREHOUSE', at: BRANCH }]), { branchId: BRANCH });
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    expect(branchFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: BRANCH } }));
    expect(locationFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: BRANCH } }));
  });

  it.each([['an existing', OTHER_BRANCH], ['an unknown', UNKNOWN_BRANCH], ['an inactive', INACTIVE_BRANCH]])(
    'G15 a WAREHOUSE assigned elsewhere asking for %s branch gets 403 and nothing about existence is read', async (_name, branchId) => {
      const response = await list(await authFor([{ role: 'WAREHOUSE', at: BRANCH }]), { branchId });
      expect(response.status).toBe(403);
      expect(branchFindUnique).not.toHaveBeenCalled();
      expect(locationFindUnique).not.toHaveBeenCalled();
      noRead();
    });
});
