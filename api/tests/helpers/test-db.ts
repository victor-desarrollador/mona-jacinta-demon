import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../../src/generated/prisma/client.js';
import { Pool } from 'pg';
import { assertDistinct, parseTarget } from '../../scripts/demo-database.js';

type Metadata = {
  db: string;
  username: string;
  address: string | null;
  port: number;
  version: string;
};

const provenClients = new WeakSet<object>();

function readTargets(): { demo: string; test: string } {
  const values = parse(
    readFileSync(new URL('../../../.env.development', import.meta.url)),
  );
  const demo = values.DATABASE_URL;
  const test = values.TEST_DATABASE_URL;
  if (!demo || !test || demo === test)
    throw new Error('Distinct local demo/test configuration required');
  parseTarget(demo);
  parseTarget(test);
  return { demo, test };
}

function caCertificate(): string {
  return readFileSync(
    new URL('../../../scripts/certs/supabase-prod-ca-2021.crt', import.meta.url),
    'utf8',
  );
}

async function metadata(pool: Pool): Promise<Metadata> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query<Metadata>(`SELECT
      current_database() AS db,
      current_user AS username,
      host(inet_server_addr()) AS address,
      inet_server_port() AS port,
      version() AS version`);
    await client.query('COMMIT');
    return result.rows[0]!;
  } finally {
    client.release();
  }
}

export async function assertTestDatabaseIsolation(): Promise<{
  demo: string;
  test: string;
}> {
  const targets = readTargets();
  const ca = caCertificate();
  const pools = [targets.demo, targets.test].map(
    (connectionString) =>
      new Pool({
        connectionString,
        ssl: { ca, rejectUnauthorized: true },
        max: 1,
        connectionTimeoutMillis: 10000,
        idleTimeoutMillis: 0,
      }),
  );
  try {
    const [demoMetadata, testMetadata] = await Promise.all(
      pools.map((pool) => metadata(pool)),
    );
    if (!demoMetadata || !testMetadata)
      throw new Error('Database metadata could not be read');
    assertDistinct(
      parseTarget(targets.demo),
      parseTarget(targets.test),
      demoMetadata,
      testMetadata,
    );
    if (
      demoMetadata.port !== testMetadata.port &&
      demoMetadata.port === 0 &&
      testMetadata.port === 0
    )
      throw new Error('Database isolation could not be proven');
    return targets;
  } catch {
    throw new Error(
      'Test database safety/connection check failed; no destructive write authorized',
    );
  } finally {
    await Promise.allSettled(pools.map((pool) => pool.end()));
  }
}

export async function createTestPrismaClient(): Promise<PrismaClient> {
  const { test } = await assertTestDatabaseIsolation();
  const pool = new Pool({
    connectionString: test,
    ssl: { ca: caCertificate(), rejectUnauthorized: true },
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 0,
  });
  pool.on('error', () => {
    /* Never emit credentials from pg errors. */
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: [] });
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