import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../../src/generated/prisma/client.js';
import {
  openProvenTestPool,
  testPoolConfig,
} from '../../scripts/demo-database.js';

const provenClients = new WeakSet<object>();

// TEST-H1: proves TEST from its own marker (TEST_DATABASE_URL only; DATABASE_URL
// is never read or connected to) and closes the proof pool it opened.
async function proveTestDatabase() {
  const { pool, target, fail } = await openProvenTestPool(1);
  try {
    await pool.end();
  } catch (error) {
    throw fail('cleanup', error, true);
  }
  return { target, fail };
}

export async function assertTestDatabaseIsolation(): Promise<void> {
  await proveTestDatabase();
}

// The adapter receives a pool *configuration*, so it alone creates the TEST pool
// on connect and ends it on every $disconnect() (a repeat $disconnect is a no-op).
// No helper-created pool outlives this call.
export async function createTestPrismaClient(): Promise<PrismaClient> {
  const { target, fail } = await proveTestDatabase();
  let prisma: PrismaClient;
  try {
    prisma = new PrismaClient({
      adapter: new PrismaPg(testPoolConfig(target.url, 5), {
        onPoolError: () => {
          /* Never emit credentials from pg errors. */
        },
        onConnectionError: () => {
          /* Never emit credentials from pg errors. */
        },
      }),
      log: [],
    });
  } catch (error) {
    throw fail('client-create', error);
  }
  provenClients.add(prisma);
  return prisma;
}

export async function truncateAllTables(prisma: PrismaClient): Promise<void> {
  if (!provenClients.has(prisma))
    throw new Error('Destructive test cleanup requires a proven test client');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE
    "CashMovement", "SalePayment", "StockMovement", "StockReservation",
    "SaleItem", "Sale", "CashSession", "AuditLog", "Inventory",
    "ProductVariant", "Product", "Category", "Brand", "CashRegister",
    "SaleNumberCounter", "UserBranchRole", "RolePermission", "User",
    "Role", "Permission", "Branch" CASCADE`);
}

export function withTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if (!provenClients.has(prisma))
    throw new Error('Transactions require a proven test client');
  return prisma.$transaction(fn);
}
