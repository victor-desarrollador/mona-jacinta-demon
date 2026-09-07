import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compare } from 'bcryptjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo, resetDemo } from '../prisma/seed.js';
import {
  assertDistinct,
  openSeedDatabase,
  parseTarget,
} from '../scripts/demo-database.js';

describe('seed target safety', () => {
  const a = { host: 'a.invalid', username: 'a' };
  const b = { host: 'b.invalid', username: 'b' };
  const x = {
    db: 'postgres',
    username: 'postgres',
    address: '10.0.0.1',
    version: 'PostgreSQL 17.0',
  };
  it('rejects missing static or live isolation signals', () => {
    expect(() =>
      assertDistinct(a, a, x, { ...x, address: '10.0.0.2' }),
    ).toThrow();
    expect(() => assertDistinct(a, b, x, x)).toThrow();
    expect(() =>
      assertDistinct(a, b, { ...x, address: null }, { ...x, address: null }),
    ).toThrow();
  });
  it('rejects connection overrides and non-session targets', () => {
    for (const raw of [
      'postgresql://x:y@localhost:5432/postgres',
      'postgresql://postgres.fake:x@fake.pooler.supabase.com:6543/postgres',
      'postgresql://postgres.fake:x@fake.pooler.supabase.com:5432/postgres?sslmode=no-verify',
    ]) {
      expect(() => parseTarget(raw)).toThrow();
    }
  });
});

// Only this file needs a real database in Task 5. The 47 bootstrap tests keep
// their synthetic environment. No global destructive test bootstrap is introduced.
describe('deterministic seed on dedicated TEST_DATABASE_URL', () => {
  let db: Awaited<ReturnType<typeof openSeedDatabase>>;
  async function safely<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch {
      throw new Error(
        'Seed integration operation failed (database details suppressed)',
      );
    }
  }
  beforeAll(async () => {
    db = await safely(() => openSeedDatabase('test'));
    await safely(async () => {
      const migrations = fileURLToPath(
        new URL('../prisma/migrations/', import.meta.url),
      );
      const dirs = readdirSync(migrations).filter((n) => n.endsWith('_init'));
      if (dirs.length !== 1)
        throw new Error('Expected one committed initial migration');
      const checksum = createHash('sha256')
        .update(readFileSync(`${migrations}/${dirs[0]}/migration.sql`))
        .digest('hex');
      const tables = await db.pool.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'",
      );
      if (tables.rows.length === 0) {
        // Minimum seed-test prerequisite: apply the existing, reviewed migration to
        // the proven TEST target. No shadow, reset, new migration, or schema drop.
        execFileSync(
          process.execPath,
          ['./node_modules/prisma/build/index.js', 'migrate', 'deploy'],
          {
            cwd: fileURLToPath(new URL('../', import.meta.url)),
            env: {
              ...process.env,
              NODE_ENV: 'test',
              DATABASE_URL: db.targetUrl,
            },
            stdio: 'pipe',
            timeout: 60000,
          },
        );
      }
      const history = await db.pool.query<{
        checksum: string;
        finished: boolean;
      }>(
        'SELECT checksum, (finished_at IS NOT NULL AND rolled_back_at IS NULL) AS finished FROM _prisma_migrations',
      );
      if (
        history.rows.length !== 1 ||
        !history.rows[0]?.finished ||
        history.rows[0].checksum !== checksum
      ) {
        throw new Error('Test migration does not match the reviewed schema');
      }
      await resetDemo(db.prisma);
    });
  }, 180000);
  afterAll(async () => {
    if (db) await safely(() => db.close());
  });

  it('seeds twice without duplicates and preserves deterministic business data', async () => {
    await safely(async () => {
      const snapshot = async () => {
        const users = await db.prisma.user.findMany({
          orderBy: { id: 'asc' },
          select: {
            id: true,
            name: true,
            email: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        });
        return JSON.stringify(
          {
            users,
            branches: await db.prisma.branch.findMany({
              orderBy: { id: 'asc' },
            }),
            variants: await db.prisma.productVariant.findMany({
              orderBy: { id: 'asc' },
            }),
            inventory: await db.prisma.inventory.findMany({
              orderBy: { id: 'asc' },
            }),
            counters: await db.prisma.saleNumberCounter.findMany({
              orderBy: { id: 'asc' },
            }),
          },
          (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString() : value,
        );
      };
      const first = await snapshot();
      await seedDemo(db.prisma);
      await seedDemo(db.prisma);
      expect(await snapshot()).toBe(first);
    });
  }, 180000);

  it('has the exact branches, users and branch assignments with bcrypt passwords', async () => {
    await safely(async () => {
      const branches = await db.prisma.branch.findMany({
        orderBy: { pointOfSaleNumber: 'asc' },
      });
      expect(
        branches.map((b) => [b.code, b.name, b.pointOfSaleNumber]),
      ).toEqual([
        ['CEN', 'Centro', 1],
        ['YB', 'Yerba Buena', 2],
        ['TV', 'Tafí Viejo', 3],
        ['BAN', 'Banda', 4],
        ['CON', 'Concepción', 5],
        ['DEP', 'Depósito Central', 6],
      ]);
      const users = await db.prisma.user.findMany({
        orderBy: { name: 'asc' },
        include: { branchRoles: { include: { role: true, branch: true } } },
      });
      expect(users.map((u) => u.name)).toEqual([
        'admin',
        'cashier01',
        'manager01',
        'seller01',
      ]);
      for (const user of users) {
        expect(user.email).toBe(`${user.name}@demo.local`);
        expect(await compare('demo123', user.passwordHash)).toBe(true);
        expect(user.passwordHash.startsWith('$2')).toBe(true);
        expect(user.isActive).toBe(true);
        const expectedRole = {
          admin: 'ADMIN',
          cashier01: 'CASHIER',
          manager01: 'MANAGER',
          seller01: 'SELLER',
        }[user.name];
        expect(
          user.branchRoles.every((r) => r.role.code === expectedRole),
        ).toBe(true);
        expect(user.branchRoles.map((r) => r.branch.code).sort()).toEqual(
          user.name === 'admin'
            ? ['BAN', 'CEN', 'CON', 'DEP', 'TV', 'YB']
            : ['CEN'],
        );
      }
    });
  }, 30000);

  it('has all 12 permissions and the exact role matrix, including queue separation', async () => {
    await safely(async () => {
      const all = [
        'sale.create',
        'sale.charge',
        'sale.complete',
        'sale.view',
        'sale.queue.view',
        'inventory.view',
        'inventory.manage',
        'cash.session.open',
        'cash.session.close',
        'user.manage',
        'report.view',
        'audit.view',
      ];
      const rows = await db.prisma.permission.findMany();
      expect(rows.map((p) => p.code).sort()).toEqual([...all].sort());
      const roles = await db.prisma.role.findMany({
        include: { permissions: { include: { permission: true } } },
      });
      expect(roles.map((r) => r.code).sort()).toEqual([
        'ADMIN',
        'CASHIER',
        'MANAGER',
        'SELLER',
      ]);
      const matrix: Record<string, string[]> = {
        SELLER: ['sale.create', 'sale.view', 'inventory.view'],
        CASHIER: [
          'sale.charge',
          'sale.complete',
          'sale.view',
          'sale.queue.view',
          'inventory.view',
          'cash.session.open',
          'cash.session.close',
        ],
        MANAGER: all.filter((p) => p !== 'user.manage' && p !== 'audit.view'),
        ADMIN: all,
      };
      for (const role of roles)
        expect(role.permissions.map((p) => p.permission.code).sort()).toEqual(
          matrix[role.code]!.slice().sort(),
        );
      expect(await db.prisma.rolePermission.count()).toBe(32);
    });
  });

  it('has exact BigInt demo prices and inventory for every variant × branch', async () => {
    await safely(async () => {
      expect(
        (await db.prisma.product.findMany()).map((p) => p.name).sort(),
      ).toEqual(['Campera Jean', 'Jean Slim', 'Remera Básica']);
      const variants = await db.prisma.productVariant.findMany({
        include: { product: true, inventory: true },
      });
      expect(variants).toHaveLength(6);
      expect(new Set(variants.map((v) => v.sku)).size).toBe(6);
      expect(new Set(variants.map((v) => v.barcode)).size).toBe(6);
      expect(await db.prisma.inventory.count()).toBe(36);
      const branchIds = (await db.prisma.branch.findMany())
        .map((b) => b.id)
        .sort();
      for (const variant of variants) {
        expect(variant.inventory.map((i) => i.branchId).sort()).toEqual(
          branchIds,
        );
        expect(
          variant.inventory.every(
            (i) => i.reserved === 0n && i.physical >= 20n,
          ),
        ).toBe(true);
        expect(typeof variant.price).toBe('bigint');
        expect(typeof variant.costPrice).toBe('bigint');
      }
      const remera = variants.find(
        (v) =>
          v.product.name === 'Remera Básica' &&
          v.color === 'Negro' &&
          v.size === 'M',
      )!;
      const jean = variants.find(
        (v) =>
          v.product.name === 'Jean Slim' &&
          v.color === 'Azul' &&
          v.size === '42',
      )!;
      expect(remera.price).toBe(4500000n);
      expect(jean.price).toBe(7500000n);
      expect(2n * remera.price + jean.price).toBe(16500000n);
    });
  });

  it('has one register and one initial counter per branch', async () => {
    await safely(async () => {
      const branches = await db.prisma.branch.findMany({
        include: { cashRegisters: true, saleNumberCounter: true },
      });
      expect(await db.prisma.cashRegister.count()).toBe(6);
      expect(await db.prisma.saleNumberCounter.count()).toBe(6);
      for (const branch of branches) {
        expect(branch.cashRegisters).toHaveLength(1);
        expect(branch.saleNumberCounter?.nextValue).toBe(1n);
      }
    });
  });

  it('rolls back deletion if reseeding fails', async () => {
    await safely(async () => {
      const before = await db.prisma.user.findMany({ orderBy: { id: 'asc' } });
      await expect(
        resetDemo({
          $transaction: (action, options) =>
            db.prisma.$transaction(
              (tx) =>
                action(
                  new Proxy(tx, {
                    get(target, key) {
                      if (key === 'user')
                        return new Proxy(target.user, {
                          get(delegate, method) {
                            if (method === 'upsert')
                              return () => {
                                throw new Error('Injected seed failure');
                              };
                            return Reflect.get(delegate, method);
                          },
                        });
                      return Reflect.get(target, key);
                    },
                  }),
                ),
              options,
            ),
        }),
      ).rejects.toThrow('Injected seed failure');
      const after = await db.prisma.user.findMany({ orderBy: { id: 'asc' } });
      // Compare internally so an assertion failure cannot expose password hashes.
      expect(JSON.stringify(before) === JSON.stringify(after)).toBe(true);
      expect(await db.prisma.inventory.count()).toBe(36);
      expect(await db.prisma.rolePermission.count()).toBe(32);
    });
  }, 180000);

  it('refuses seed over operations and reset removes linked data', async () => {
    await safely(async () => {
      const user = await db.prisma.user.findUniqueOrThrow({
        where: { email: 'seller01@demo.local' },
      });
      const branch = await db.prisma.branch.findUniqueOrThrow({
        where: { code: 'CEN' },
      });
      await db.prisma.sale.create({
        data: {
          sellerId: user.id,
          branchId: branch.id,
          items: {
            create: {
              variantId: (await db.prisma.productVariant.findFirstOrThrow()).id,
              productId: (await db.prisma.product.findFirstOrThrow()).id,
              productName: 'Demo',
              variantName: 'Demo',
              sku: 'DEMO',
              quantity: 1n,
              unitPrice: 1n,
              subtotal: 1n,
            },
          },
        },
      });
      await expect(seedDemo(db.prisma)).rejects.toThrow(
        'Business operations exist',
      );
      expect(await db.prisma.sale.count()).toBe(1);
      await resetDemo(db.prisma);
      expect(await db.prisma.sale.count()).toBe(0);
      expect(await db.prisma.saleItem.count()).toBe(0);
      expect(await db.prisma.inventory.count()).toBe(36);
      expect(
        (await db.prisma.saleNumberCounter.findMany()).every(
          (c) => c.nextValue === 1n,
        ),
      ).toBe(true);
    });
  }, 180000);
});
