import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../../src/generated/prisma/client.js';
import {
  localTestPoolConfig,
  openProvenLocalTestPool,
  openProvenTestPool,
  resolveAutomatedTestTarget,
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

// Task 4: LOCAL_TEST from process.env only (never the hosted TEST file target),
// proven by its own marker; the helper closes the proof pool it opened.
async function proveLocalTestDatabase() {
  const { pool, target, fail } = await openProvenLocalTestPool(1);
  try {
    await pool.end();
  } catch {
    throw fail('cleanup');
  }
  return { target, fail };
}

// The one target decision: the selector is resolved before any pool exists (an
// unknown value throws here) and 'local' never falls back to hosted TEST. The
// adapter config is built from the same target object the proof ran against,
// lazily, so the isolation check alone never builds one.
async function proveSelectedTestDatabase() {
  if (resolveAutomatedTestTarget(process.env) === 'local') {
    const { target, fail } = await proveLocalTestDatabase();
    return {
      adapterConfig: () => localTestPoolConfig(target.url, 5),
      failClientCreate: () => fail('client-create'),
    };
  }
  const { target, fail } = await proveTestDatabase();
  return {
    adapterConfig: () => testPoolConfig(target.url, 5),
    failClientCreate: (error: unknown) => fail('client-create', error),
  };
}

export async function assertTestDatabaseIsolation(): Promise<void> {
  await proveSelectedTestDatabase();
}

// The adapter receives a pool *configuration*, so it alone creates the target pool
// on connect and ends it on every $disconnect() (a repeat $disconnect is a no-op).
// No helper-created pool outlives this call.
export async function createTestPrismaClient(): Promise<PrismaClient> {
  const { adapterConfig, failClientCreate } = await proveSelectedTestDatabase();
  let prisma: PrismaClient;
  try {
    prisma = new PrismaClient({
      adapter: new PrismaPg(adapterConfig(), {
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
    throw failClientCreate(error);
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
