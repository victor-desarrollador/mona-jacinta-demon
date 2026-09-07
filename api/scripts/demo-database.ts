import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

type Target = 'demo' | 'test';
type Identity = { host: string; username: string };
type Metadata = {
  db: string;
  username: string;
  address: string | null;
  version: string;
};

// The ignored repository file is the explicit local target configuration. Inherited
// shell URLs cannot redirect a demo reset; tests read it without changing process.env.
export function readDemoTargets() {
  const local = parse(
    readFileSync(new URL('../../.env.development', import.meta.url)),
  );
  const demo = local.DATABASE_URL;
  const test = local.TEST_DATABASE_URL;
  if (!demo || !test || demo === test)
    throw new Error('Distinct local demo/test configuration required');
  parseTarget(demo);
  parseTarget(test);
  return { demo, test };
}

export function parseTarget(raw: string): Identity {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid database target');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !url.hostname.endsWith('.pooler.supabase.com') ||
    url.port !== '5432' ||
    url.pathname !== '/postgres' ||
    url.search ||
    url.hash ||
    !decodeURIComponent(url.username).startsWith('postgres.') ||
    !url.password
  ) {
    throw new Error(
      'Expected Supabase session target without connection overrides',
    );
  }
  return { host: url.hostname, username: decodeURIComponent(url.username) };
}

export function assertDistinct(
  a: Identity,
  b: Identity,
  x: Metadata,
  y: Metadata,
) {
  const staticDistinct = a.host !== b.host || a.username !== b.username;
  const liveDistinct =
    x.username !== y.username ||
    (x.address !== null && y.address !== null && x.address !== y.address);
  const supported = [x, y].every(
    (m) => Number(m.version.match(/^PostgreSQL (\d+)/)?.[1]) >= 16,
  );
  if (
    !staticDistinct ||
    !liveDistinct ||
    !supported ||
    x.db !== 'postgres' ||
    y.db !== 'postgres'
  ) {
    throw new Error('Database isolation could not be proven; refusing writes');
  }
}

export async function openSeedDatabase(target: Target) {
  if (
    target === 'demo' &&
    process.env.NODE_ENV &&
    process.env.NODE_ENV !== 'development'
  ) {
    throw new Error('Demo commands require a development environment');
  }
  if (target === 'test' && process.env.NODE_ENV !== 'test') {
    throw new Error('Test target is available only to automated tests');
  }
  const urls = readDemoTargets();
  if (
    target === 'demo' &&
    ((process.env.DATABASE_URL && process.env.DATABASE_URL !== urls.demo) ||
      (process.env.TEST_DATABASE_URL &&
        process.env.TEST_DATABASE_URL !== urls.test))
  )
    throw new Error(
      'Shell database overrides do not match local demo configuration',
    );

  const ca = readFileSync(
    new URL('../../scripts/certs/supabase-prod-ca-2021.crt', import.meta.url),
    'utf8',
  );
  const pools = [urls.demo, urls.test].map((connectionString) => {
    const pool = new Pool({
      connectionString,
      ssl: { ca, rejectUnauthorized: true },
      max: 1,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 0,
    });
    pool.on('error', () => {
      /* Never emit credentials from pg errors. Queries fail closed. */
    });
    return pool;
  });
  const demo = pools[0]!;
  const test = pools[1]!;
  try {
    const metadata: Metadata[] = [];
    for (const pool of pools) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY');
        const result =
          await client.query<Metadata>(`SELECT current_database() AS db,
          current_user AS username, host(inet_server_addr()) AS address, version() AS version`);
        metadata.push(result.rows[0]!);
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }
    assertDistinct(
      parseTarget(urls.demo),
      parseTarget(urls.test),
      metadata[0]!,
      metadata[1]!,
    );
    const pool = target === 'demo' ? demo : test;
    await (target === 'demo' ? test : demo).end();
    const prisma = new PrismaClient({ adapter: new PrismaPg(pool), log: [] });
    return {
      prisma,
      pool,
      targetUrl: urls[target],
      close: async () => {
        await prisma.$disconnect();
        await pool.end();
      },
    };
  } catch {
    await Promise.allSettled(pools.map((pool) => pool.end()));
    throw new Error(
      'Seed database safety/connection check failed; no writes authorized',
    );
  }
}
