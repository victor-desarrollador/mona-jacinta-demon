import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool, PoolConfig } from 'pg';
import { PrismaClient, Prisma } from '../../src/generated/prisma/client.js';
import {
  localTestPoolConfig,
  captureTestSessionDiagnosticOwner,
  openProvenLocalTestPool,
  openProvenTestPool,
  resolveAutomatedTestTarget,
  testPoolConfig,
} from '../../scripts/demo-database.js';
import { createAttributedPool } from './pool-attribution.js';

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
// proof runs against the selected target only, and each branch returns its own
// config builder — LOCAL_TEST keeps localTestPoolConfig (LocalTestClient +
// ssl:false, its PGOPTIONS refusal) and hosted TEST keeps testPoolConfig.
// Attribution is authorized only for the hosted TEST branch.
async function proveSelectedTestDatabase() {
  if (resolveAutomatedTestTarget(process.env) === 'local') {
    const { target, fail } = await proveLocalTestDatabase();
    return {
      target,
      fail,
      attributionAllowed: false,
      buildConfig: () => localTestPoolConfig(target.url, 5),
    };
  }
  const { target, fail } = await proveTestDatabase();
  return {
    target,
    fail,
    attributionAllowed: true,
    buildConfig: () => testPoolConfig(target.url, 5),
  };
}

export async function assertTestDatabaseIsolation(): Promise<void> {
  await proveSelectedTestDatabase();
}

// D4A3B: the one place that wires a proven TEST pool config into a PrismaPg
// adapter. Diagnostics OFF (attributedPool = null) keeps the exact pre-D4A1
// behavior: the adapter receives a PoolConfig, owns/creates its Pool and ends
// it on every $disconnect (a repeat $disconnect is a no-op). Diagnostics ON
// passes the helper-owned, attributed Pool instance plus the installed
// adapter's supported external-pool disposal option, so $disconnect still
// observably ends the pool exactly once.
export function buildTestPrismaAdapter(config: PoolConfig, attributedPool: Pool | null): PrismaPg {
  const onPoolError = () => {
    /* Never emit credentials from pg errors. */
  };
  const onConnectionError = () => {
    /* Never emit credentials from pg errors. */
  };
  if (attributedPool) {
    // Installed @prisma/adapter-pg 7.10.0: a Pool instance is borrowed as the
    // adapter's external pool; { disposeExternalPool: true } makes dispose()
    // end it — the same observable close semantics as the adapter-owned pool.
    return new PrismaPg(attributedPool, { disposeExternalPool: true, onPoolError, onConnectionError });
  }
  return new PrismaPg(config, { onPoolError, onConnectionError });
}

// Diagnostics OFF: the adapter owns/creates its pool on connect and ends it on
// every $disconnect() (a repeat $disconnect is a no-op). Diagnostics ON: the
// helper owns an attributed pool with the same config (same max/SSL/timeouts)
// and $disconnect still ends it exactly once. The proof runs first in both
// cases and the proof pool itself is never attributed. No helper-created pool
// outlives this call.
export async function createTestPrismaClient(): Promise<PrismaClient> {
  const diagnosticOwner = captureTestSessionDiagnosticOwner('prisma');
  const { fail, attributionAllowed, buildConfig } = await proveSelectedTestDatabase();
  const config = buildConfig();
  // D4A3B §18: attribution stays inactive on the LOCAL_TEST branch even when
  // diagnostics are enabled — only the hosted TEST branch may attach.
  const attributedPool = attributionAllowed ? createAttributedPool(config, diagnosticOwner) : null;
  let prisma: PrismaClient;
  try {
    prisma = new PrismaClient({
      adapter: buildTestPrismaAdapter(config, attributedPool),
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
