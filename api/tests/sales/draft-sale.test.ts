import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../../prisma/seed.js';
import { createApp } from '../../src/app.js';
import { createTestPrismaClient, truncateAllTables } from '../helpers/test-db.js';
import { getAuthToken, createTestUser } from '../helpers/auth.js';
import { createRole } from '../helpers/factories.js';

describe('seller draft sales', () => {
  let prisma: Awaited<ReturnType<typeof createTestPrismaClient>>;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let otherSellerToken: string;
  let centroId: string;
  let yerbaId: string;
  let remeraId: string;
  let jeanId: string;

  beforeAll(async () => {
    prisma = await createTestPrismaClient();
    app = createApp(prisma);
  });

  beforeEach(async () => {
    await truncateAllTables(prisma);
    await seedDemo(prisma);
    const [seller, otherSeller, centro, yerba, remera, jean] = await Promise.all([
      prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } }),
      prisma.user.create({ data: { name: 'other-seller', email: 'other@test.local', passwordHash: 'test' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'CEN' } }),
      prisma.branch.findUniqueOrThrow({ where: { code: 'YB' } }),
      prisma.productVariant.findUniqueOrThrow({ where: { sku: 'REM-NEG-M' } }),
      prisma.productVariant.findUniqueOrThrow({ where: { sku: 'JEA-AZU-42' } }),
    ]);
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    await prisma.userBranchRole.create({ data: { userId: otherSeller.id, branchId: centro.id, roleId: sellerRole.id } });
    // Phase 1C SWITCH: req.auth.branchIds comes from UserRoleScope
    // exclusively (empty means empty, no legacy fallback) — otherSeller is a
    // brand-new user created directly above, not via seedDemo, so it needs
    // its own scope row too. Centro's Location already exists (seeded/
    // backfilled), so this just points at it directly.
    await prisma.userRoleScope.create({
      data: { userId: otherSeller.id, roleId: sellerRole.id, scopeKind: 'LOCATION', locationId: centro.id },
    });
    token = await getAuthToken(seller);
    otherSellerToken = await getAuthToken(otherSeller);
    centroId = centro.id;
    yerbaId = yerba.id;
    remeraId = remera.id;
    jeanId = jean.id;
  });

  afterAll(async () => prisma.$disconnect());

  const postSale = (body: Record<string, unknown> = {}) =>
    request(app).post('/api/v1/sales').set('Authorization', `Bearer ${token}`).send(body);

  it('requires authentication and SALE_CREATE', async () => {
    expect((await request(app).post('/api/v1/sales').send({})).status).toBe(401);
    // Phase 1D.3.1 SWITCH: POST /sales now gates on the Production SALE_CREATE
    // grant (req.auth.assignments), not the legacy sale.create code — revoke
    // the Production grant to prove that is the real, live decision.
    const permission = await prisma.permission.findUniqueOrThrow({ where: { code: 'SALE_CREATE' } });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    await prisma.rolePermission.delete({ where: { roleId_permissionId: { roleId: role.id, permissionId: permission.id } } });
    expect((await postSale()).status).toBe(403);
  });

  it('authorizes creation via the Production SALE_CREATE grant alone', async () => {
    // Isolated via a fresh user, not a fresh role: authorization-context.ts
    // validates a persisted UserRoleScope's Role.code against the canonical
    // Production catalog (isProductionRoleCode) before it can ever become an
    // assignment — an arbitrary test-only role code would be skipped
    // entirely and prove nothing. SELLER carries SALE_CREATE as its own real
    // default grant (role-permission-matrix.ts), so a brand-new SELLER user
    // with no other state still isolates "the grant alone authorizes".
    const sellerRole = await prisma.role.findUniqueOrThrow({ where: { code: 'SELLER' } });
    const user = await createTestUser(prisma, sellerRole.id, centroId);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${isolatedToken}`).send({ branchId: centroId });
    expect(response.status).toBe(201);
  });

  it('rejects a legacy-lowercase-only sale.create grant, once switched', async () => {
    const permission = await prisma.permission.upsert({ where: { code: 'sale.create' }, create: { code: 'sale.create' }, update: {} });
    const role = await createRole(prisma, 'LEGACY-ONLY-SALE-CREATE');
    await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
    const user = await createTestUser(prisma, role.id, centroId);
    const isolatedToken = await getAuthToken(user);
    const response = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${isolatedToken}`).send({ branchId: centroId });
    expect(response.status).toBe(403);
  });

  // Phase 1D.3.1 §5 location-validation audit: createDraftSale's branchId is
  // genuinely client-controlled (POST body), unlike every other Sales manual
  // recheck in this file (all derived from an already-persisted Sale row).
  // A COMPANY assignment's hasPermissionAtLocation qualifies for ANY
  // non-empty locationId string, so this exact input must be validated
  // against a persisted, active Location before it ever reaches the policy —
  // never solved by consulting effectiveLocationIds.
  it('rejects a nonexistent branch for a COMPANY-scoped caller (location-validation audit)', async () => {
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const companyAdmin = await prisma.user.create({ data: { name: 'Company Admin', email: 'company-admin@test.local', passwordHash: 'x' } });
    await prisma.userRoleScope.create({ data: { userId: companyAdmin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null } });
    const adminToken = await getAuthToken(companyAdmin);
    const bogusBranchId = '00000000-0000-4000-8000-000000000099';
    const response = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${adminToken}`).send({ branchId: bogusBranchId });
    expect(response.status).toBe(404);
    expect(await prisma.sale.count({ where: { branchId: bogusBranchId } })).toBe(0);
  });

  it('rejects an inactive branch for a COMPANY-scoped caller (location-validation audit)', async () => {
    await prisma.location.update({ where: { id: yerbaId }, data: { isActive: false } });
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
    const companyAdmin = await prisma.user.create({ data: { name: 'Company Admin Inactive', email: 'company-admin-inactive@test.local', passwordHash: 'x' } });
    await prisma.userRoleScope.create({ data: { userId: companyAdmin.id, roleId: adminRole.id, scopeKind: 'COMPANY', locationId: null } });
    const adminToken = await getAuthToken(companyAdmin);
    const response = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${adminToken}`).send({ branchId: yerbaId });
    expect(response.status).toBe(404);
    expect(await prisma.sale.count({ where: { branchId: yerbaId } })).toBe(0);
    // `Location` is not in truncateAllTables' TRUNCATE list (test-db.ts is
    // out of scope for this task) — restore the shared seeded YB location so
    // this mutation cannot leak into any later test in this file/run.
    await prisma.location.update({ where: { id: yerbaId }, data: { isActive: true } });
  });

  it('creates a draft with server identity and null sale number', async () => {
    const response = await postSale({ branchId: centroId });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ status: 'DRAFT', saleNumber: null, subtotal: '0', discountTotal: '0', total: '0' });
    const seller = await prisma.user.findUniqueOrThrow({ where: { email: 'seller01@demo.local' } });
    expect(response.body.sellerId).toBe(seller.id);
    expect((await postSale({ sellerId: 'client-controlled', branchId: centroId })).status).toBe(400);
  });

  it('rejects a branch outside the seller assignment', async () => {
    expect((await postSale({ branchId: yerbaId })).status).toBe(403);
  });

  it('adds and merges items, recalculates totals, and keeps inventory unchanged', async () => {
    const sale = await postSale();
    const saleId = sale.body.id;
    const addRemera = () => request(app).post(`/api/v1/sales/${saleId}/items`).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 1 });
    expect((await addRemera()).status).toBe(200);
    expect((await addRemera()).body.total).toBe('9000000');
    const final = await request(app).post(`/api/v1/sales/${saleId}/items`).set('Authorization', `Bearer ${token}`).send({ variantId: jeanId, quantity: 1 });
    expect(final.body.total).toBe('16500000');
    expect(final.body.items).toHaveLength(2);
    expect(final.body.items.find((item: { variantId: string }) => item.variantId === remeraId).quantity).toBe('2');
    const inventory = await prisma.inventory.findMany({ where: { branchId: centroId, variantId: { in: [remeraId, jeanId] } } });
    expect(inventory).toEqual(expect.arrayContaining([
      expect.objectContaining({ physical: 20n, reserved: 0n }),
      expect.objectContaining({ physical: 20n, reserved: 0n }),
    ]));
  });

  it('rejects inactive, unknown, and insufficient variants', async () => {
    const sale = await postSale();
    const path = `/api/v1/sales/${sale.body.id}/items`;
    expect((await request(app).post(path).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 21 })).status).toBe(409);
    expect((await request(app).post(path).set('Authorization', `Bearer ${token}`).send({ variantId: '00000000-0000-4000-8000-000000000001', quantity: 1 })).status).toBe(404);
    await prisma.productVariant.update({ where: { id: remeraId }, data: { isActive: false } });
    expect((await request(app).post(path).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 1 })).status).toBe(404);
  });

  it('updates and removes items, and protects another seller draft', async () => {
    const sale = await postSale();
    const added = await request(app).post(`/api/v1/sales/${sale.body.id}/items`).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 2 });
    const itemId = added.body.items[0].id;
    const updated = await request(app).patch(`/api/v1/sales/${sale.body.id}/items/${itemId}`).set('Authorization', `Bearer ${token}`).send({ quantity: 3 });
    expect(updated.body.total).toBe('13500000');
    expect((await request(app).patch(`/api/v1/sales/${sale.body.id}/items/${itemId}`).set('Authorization', `Bearer ${token}`).send({ quantity: 21 })).status).toBe(409);
    const removed = await request(app).delete(`/api/v1/sales/${sale.body.id}/items/${itemId}`).set('Authorization', `Bearer ${token}`);
    expect(removed.body.total).toBe('0');
    const otherSale = await request(app).post('/api/v1/sales').set('Authorization', `Bearer ${otherSellerToken}`).send({ branchId: centroId });
    expect((await request(app).post(`/api/v1/sales/${otherSale.body.id}/items`).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 1 })).status).toBe(403);
    expect((await request(app).get(`/api/v1/sales/${otherSale.body.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('rejects access to a draft in another branch', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@demo.local' } });
    const otherSale = await prisma.sale.create({ data: { sellerId: admin.id, branchId: yerbaId, status: 'DRAFT' } });
    expect((await request(app).get(`/api/v1/sales/${otherSale.id}`).set('Authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('returns only accessible seller drafts with item details and string money', async () => {
    const sale = await postSale();
    await request(app).post(`/api/v1/sales/${sale.body.id}/items`).set('Authorization', `Bearer ${token}`).send({ variantId: remeraId, quantity: 2 });
    const fetched = await request(app).get(`/api/v1/sales/${sale.body.id}`).set('Authorization', `Bearer ${token}`);
    expect(fetched.body.items[0].variant.product.name).toBe('Remera Básica');
    expect(fetched.body.items[0].unitPrice).toBe('4500000');
    expect(fetched.body.total).toBe('9000000');
    const list = await request(app).get('/api/v1/sales').set('Authorization', `Bearer ${token}`);
    expect(list.body.items.map((item: { id: string }) => item.id)).toContain(sale.body.id);
    expect(list.body.items.every((item: { sellerId: string }) => item.sellerId === sale.body.sellerId)).toBe(true);
  });
});