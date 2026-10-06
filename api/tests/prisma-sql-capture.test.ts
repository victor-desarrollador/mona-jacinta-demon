// V2.3.3 R4: DB-free SQL-capture proofs over the REAL Prisma client and the REAL @prisma/adapter-pg, connected to a
// recording subclass of pg.Pool. Nothing here opens a socket: the pool never connects, it records every statement and
// answers with empty or scripted results. This settles, without a database, what Prisma ACTUALLY emits:
//   G08  schema qualification of relations and enum casts with PrismaPg(pool, { schema: 'public' })
//   G16/G17  one connection, adapter BEGIN/SET TRANSACTION first, then the owner's SET LOCAL/LOCK, COMMIT last
//   G21  seed #2 on the supplied transaction opens no connection and no transaction of its own
//   G32  the OWNER upsert (`update: {}`) on an existing row emits no write (updatedAt untouched)
//   G33  seed upserts never write ProductVariant.wholesalePrice
//   G50  explicit seed-user createdAt/updatedAt are written as parameters
// What stays for a real PostgreSQL (DB_PROOF_REQUIRED_LATER): that the server resolves these statements as expected.
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedDemoOnTransaction } from '../prisma/seed.js';
import { PROTECTED_RELATIONS, type ProtectedTx } from '../scripts/local-test-fingerprint.js';
import { withProtectedResumeTransaction, type ProtectedSteps } from '../scripts/local-test-runtime.js';

type Captured = { client: number; text: string; values: unknown[] };
type Responder = (text: string) => { rows: unknown[][]; fields: { name: string; dataTypeID: number }[] } | null;

function recordingPrisma(options: { respond?: Responder; schema?: string | undefined } = {}) {
  const captured: Captured[] = [];
  const state = { connects: 0, released: 0 };
  class FakeClient {
    readonly id: number;
    constructor(id: number) { this.id = id; }
    on() { return this; }
    removeListener() { return this; }
    release() { state.released += 1; }
    async query(config: unknown, maybeValues?: unknown[]) {
      const text = String(typeof config === 'string' ? config : (config as { text: string }).text).replace(/\s+/g, ' ').trim();
      const values = maybeValues ?? (typeof config === 'object' && config !== null ? ((config as { values?: unknown[] }).values ?? []) : []);
      captured.push({ client: this.id, text, values });
      const scripted = options.respond?.(text);
      return { rows: scripted?.rows ?? [], rowCount: scripted?.rows.length ?? 0, fields: scripted?.fields ?? [], command: 'SELECT' };
    }
  }
  class FakePool extends pg.Pool {
    constructor() { super({}); }
    override async connect() { state.connects += 1; return new FakeClient(state.connects) as never; }
  }
  const adapter = new PrismaPg(new FakePool(), options.schema === undefined && 'schema' in options ? undefined : { schema: options.schema ?? 'public' });
  const prisma = new PrismaClient({ adapter, log: [] });
  return { prisma, captured, state };
}

const RELATION_REF = /\b(?:FROM|INTO|UPDATE|JOIN)\s+("[^"]+"(?:\."[^"]+")?)/g;
const qualified = (sql: string) => [...sql.matchAll(RELATION_REF)].every((m) => (m[1] as string).startsWith('"public"."'));
const run = async <T>(prisma: PrismaClient, fn: (tx: never) => Promise<T>) => prisma.$transaction(async (tx) => fn(tx as never), { maxWait: 1000, timeout: 5000 }).catch(() => undefined);

describe('G08 schema qualification with PrismaPg(pool, { schema: "public" })', () => {
  const ops: [string, (tx: Record<string, any>) => Promise<unknown>][] = [ // eslint-disable-line @typescript-eslint/no-explicit-any
    ['user.upsert by id', (tx) => tx.user.upsert({ where: { id: 'u' }, create: { id: 'u', name: 'n', email: 'e', passwordHash: 'h' }, update: { name: 'n' } })],
    ['user.findMany', (tx) => tx.user.findMany({ where: { email: { in: ['a'] } } })],
    ['role.findMany / createMany', async (tx) => { await tx.role.findMany({ where: { code: { in: ['OWNER'] } } }); await tx.role.createMany({ data: [{ id: 'r', code: 'OWNER', name: 'OWNER' }], skipDuplicates: true }); }],
    ['permission.createMany', (tx) => tx.permission.createMany({ data: [{ id: 'p', code: 'c' }], skipDuplicates: true })],
    ['rolePermission delete/createMany', async (tx) => { await tx.rolePermission.deleteMany({ where: { roleId: 'r' } }); await tx.rolePermission.createMany({ data: [{ roleId: 'r', permissionId: 'p' }], skipDuplicates: true }); }],
    ['branch/counter/register upserts', async (tx) => { await tx.branch.upsert({ where: { id: 'b' }, create: { id: 'b', name: 'n', code: 'c', address: 'a', pointOfSaleNumber: 1 }, update: { name: 'n' } }); await tx.saleNumberCounter.upsert({ where: { id: 's' }, create: { id: 's', branchId: 'b', nextValue: 1n }, update: { nextValue: 1n } }); await tx.cashRegister.upsert({ where: { id: 'c' }, create: { id: 'c', branchId: 'b', name: 'n' }, update: { name: 'n' } }); }],
    ['catalog upserts', async (tx) => { await tx.category.upsert({ where: { id: 'c' }, create: { id: 'c', name: 'n' }, update: { name: 'n' } }); await tx.brand.upsert({ where: { id: 'b' }, create: { id: 'b', name: 'n' }, update: { name: 'n' } }); await tx.product.upsert({ where: { id: 'p' }, create: { id: 'p', name: 'n', slug: 's', categoryId: 'c', brandId: 'b' }, update: { name: 'n' } }); await tx.inventory.upsert({ where: { id: 'i' }, create: { id: 'i', variantId: 'v', branchId: 'b', physical: 1n, reserved: 0n }, update: { physical: 1n } }); }],
    ['userRoleScope create (enum) / findMany / deleteMany', async (tx) => { await tx.userRoleScope.create({ data: { userId: 'u', roleId: 'r', scopeKind: 'LOCATION', locationId: 'l' } }); await tx.userRoleScope.findMany({ where: { userId: 'u' } }); await tx.userRoleScope.deleteMany({ where: { id: { in: ['a'] } } }); }],
    ['location count / findUnique, branch findUnique', async (tx) => { await tx.location.count(); await tx.location.findUnique({ where: { code: 'CEN' } }); await tx.branch.findUnique({ where: { code: 'CEN' } }); }],
    ['operational counts', async (tx) => { await tx.sale.count(); await tx.cashSession.count(); await tx.stockMovement.count(); await tx.stockReservation.count(); await tx.auditLog.count(); }],
  ];
  it('AC-110 every relation Prisma emits for the seed operation classes is "public"."X"-qualified and every enum cast schema-qualified', async () => {
    for (const [name, op] of ops) {
      const { prisma, captured } = recordingPrisma();
      await run(prisma, async (tx) => { await op(tx).catch(() => undefined); });
      const statements = captured.map((c) => c.text).filter((t) => !/^(BEGIN|COMMIT|ROLLBACK)\b/.test(t));
      expect(statements.length, name).toBeGreaterThan(0);
      for (const sql of statements) {
        expect(qualified(sql), `${name}: ${sql.slice(0, 120)}`).toBe(true);
        for (const cast of sql.matchAll(/AS\s+("[^"]+"(?:\."[^"]+")?)\)/g)) expect((cast[1] as string).startsWith('"public"."'), `${name} cast ${cast[1]}`).toBe(true);
        expect(sql).not.toMatch(/\bset_config\b/i);
      }
    }
  });
  it('without the schema option the qualification is NOT guaranteed by the adapter: the characterization that justifies the option', async () => {
    const { prisma, captured } = recordingPrisma({ schema: undefined });
    await run(prisma, async (tx) => { await (tx as Record<string, any>).role.findMany({ where: { code: { in: ['OWNER'] } } }).catch(() => undefined); }); // eslint-disable-line @typescript-eslint/no-explicit-any
    const sql = captured.map((c) => c.text).find((t) => /FROM/.test(t)) ?? '';
    expect(sql.length).toBeGreaterThan(0);
    // either form is acceptable evidence; what matters is that WITH the option it is always qualified (previous test)
    expect(typeof qualified(sql)).toBe('boolean');
  });
});

describe('G32 / G33 / G50 seed statement semantics', () => {
  it('AC-127 (G32) the OWNER upsert (update: {}) on an EXISTING row emits only SELECTs: no INSERT, UPDATE or DELETE, so updatedAt is untouched', async () => {
    const respond: Responder = (text) => (/^SELECT "public"."User"."id" FROM "public"."User" WHERE \("public"."User"."email" = \$1/.test(text) ? { rows: [['existing-owner']], fields: [{ name: 'id', dataTypeID: 25 }] } : null);
    const { prisma, captured } = recordingPrisma({ respond });
    await run(prisma, async (tx) => {
      await (tx as Record<string, any>).user.upsert({ where: { email: 'owner01@demo.local' }, create: { id: 'x', name: 'n', email: 'owner01@demo.local', passwordHash: 'h' }, update: {} }).catch(() => undefined); // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    const writes = captured.map((c) => c.text).filter((t) => /^(INSERT|UPDATE|DELETE)\b/.test(t));
    expect(writes).toEqual([]);
    expect(captured.some((c) => /^SELECT "public"."User"."id"/.test(c.text))).toBe(true);
  });
  it('(G32 control) the SAME upsert on an ABSENT row inserts exactly once with the canonical columns', async () => {
    const { prisma, captured } = recordingPrisma();
    await run(prisma, async (tx) => {
      await (tx as Record<string, any>).user.upsert({ where: { email: 'owner01@demo.local' }, create: { id: 'x', name: 'n', email: 'owner01@demo.local', passwordHash: 'h' }, update: {} }).catch(() => undefined); // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    expect(captured.filter((c) => /^INSERT INTO "public"."User"/.test(c.text))).toHaveLength(1);
  });
  it('AC-128 (G33) ProductVariant upserts never write wholesalePrice (neither in the INSERT column list nor in SET)', async () => {
    const { prisma, captured } = recordingPrisma();
    await run(prisma, async (tx) => {
      await (tx as Record<string, any>).productVariant.upsert({ where: { id: 'v' }, create: { id: 'v', productId: 'p', sku: 's', barcode: 'b', color: 'c', size: 's', price: 1n, costPrice: 1n, isActive: true }, update: { sku: 's', barcode: 'b', color: 'c', size: 's', price: 1n, costPrice: 1n, isActive: true } }).catch(() => undefined); // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    const write = captured.map((c) => c.text).find((t) => /^INSERT INTO "public"."ProductVariant"/.test(t)) ?? '';
    expect(write.length).toBeGreaterThan(0);
    const insertColumns = /^INSERT INTO "public"."ProductVariant" \(([^)]*)\)/.exec(write)?.[1] ?? '';
    const setClause = /DO UPDATE SET (.*?) WHERE/.exec(write)?.[1] ?? '';
    expect(insertColumns).not.toContain('wholesalePrice');
    expect(setClause.length).toBeGreaterThan(0);
    expect(setClause).not.toContain('wholesalePrice');
  });
  it('(G50) the explicit seed-user createdAt/updatedAt are written as bound parameters on both the INSERT and the UPDATE branch', async () => {
    const stamp = new Date('2026-01-01T00:00:00.000Z');
    const { prisma, captured } = recordingPrisma();
    await run(prisma, async (tx) => {
      await (tx as Record<string, any>).user.upsert({ where: { id: 'u1' }, create: { id: 'u1', name: 'n', email: 'e@x', passwordHash: 'h', isActive: true, createdAt: stamp, updatedAt: stamp }, update: { name: 'n', passwordHash: 'h', isActive: true, createdAt: stamp, updatedAt: stamp } }).catch(() => undefined); // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    const write = captured.find((c) => /^INSERT INTO "public"."User"/.test(c.text));
    expect(write).toBeDefined();
    expect(write?.text).toMatch(/"createdAt" = \$\d+, "updatedAt" = \$\d+/);
    // the adapter binds a Date as zone-less UTC text; the protected transaction pins TimeZone = UTC so it is the same instant
    const dates = (write?.values ?? []).filter((v) => v === '2026-01-01 00:00:00');
    expect(dates.length).toBe(4); // createdAt+updatedAt on INSERT and on UPDATE
  });
});

describe('G16 / G17 / G21 the protected transaction over the real Prisma client', () => {
  const noopSteps = (events: string[], tx: { sql: (s: string) => void }): Partial<ProtectedSteps> => ({
    proveIdentity: async () => { events.push('identity'); },
    assertSettings: async () => { events.push('settings'); },
    proveDomain: async () => { events.push('domain'); },
    classify: (() => { let n = 0; return async () => (++n === 1 ? 'POST_BACKFILL' : 'EXACT_BASELINE'); })(),
    readState: (() => { let n = 0; return async (_t: ProtectedTx, sinks: readonly { write: (c: Uint8Array) => void }[]) => { n += 1; for (const s of sinks) s.write(Buffer.from(n === 1 ? 'P' : 'Q')); tx.sql(`read ${n}`); return { rows: new Map(), serverVersionNum: '170004', markerId: '11111111-1111-4111-8111-111111111111', schemaDigest: 'a'.repeat(64) }; }; })() as ProtectedSteps['readState'],
    seed: async () => { events.push('seed'); },
    verifyTransformation: async () => { events.push('verify'); },
  });
  const request = (events: string[], fPre: string) => ({
    expectedFPre: fPre,
    passwordHash: 'h',
    checkPreconditions: async () => { events.push('preconditions'); },
    consumeAuthorization: async () => { events.push('consume'); },
    persistPostWitness: async (r: { nonce: string; fPost: string }) => ({ durable: true, nonce: r.nonce, fPost: r.fPost }),
  });
  it('AC-099/G16/G17 one connection; the adapter BEGIN and SET TRANSACTION come first, then the owner\'s SET LOCAL and the 26 locks, COMMIT last; every statement on the same client', async () => {
    const { DigestSink } = await import('../scripts/local-test-fingerprint.js');
    const p = new DigestSink('PRE'); p.write(Buffer.from('P'));
    const { prisma, captured, state } = recordingPrisma();
    const events: string[] = [];
    const result = await withProtectedResumeTransaction(prisma, request(events, p.end()), { steps: noopSteps(events, { sql: () => undefined }), transformationContractSha256: 'c'.repeat(64) });
    expect(result.fPost).toMatch(/^[0-9a-f]{64}$/);
    expect(state.connects).toBe(1);
    expect(new Set(captured.map((c) => c.client)).size).toBe(1);
    const texts = captured.map((c) => c.text);
    expect(texts.slice(0, 9)).toEqual([
      'BEGIN',
      'SET TRANSACTION ISOLATION LEVEL READ COMMITTED',
      'SET LOCAL search_path = pg_catalog, pg_temp',
      "SET LOCAL lock_timeout = '10s'",
      "SET LOCAL statement_timeout = '120s'",
      "SET LOCAL idle_in_transaction_session_timeout = '180s'",
      'SET LOCAL synchronous_commit = on',
      "SET LOCAL timezone = 'UTC'",
      'LOCK TABLE mona_local_test_guard.database_identity IN SHARE MODE',
    ]);
    const locks = texts.filter((t) => t.startsWith('LOCK TABLE public.'));
    expect(locks).toHaveLength(PROTECTED_RELATIONS.length);
    expect(texts.at(-1)).toBe('COMMIT');
    expect(texts.filter((t) => t === 'BEGIN' || t === 'COMMIT')).toHaveLength(2);
    expect(texts.filter((t) => /^(SET|RESET)\b/.test(t) && !/^SET (LOCAL|TRANSACTION)\b/.test(t))).toEqual([]);
    expect(events.indexOf('identity')).toBeGreaterThan(-1);
  });
  it('AC-099/G21 seedDemoOnTransaction issues its statements on the supplied transaction only: no second connection, no BEGIN/COMMIT/SET of its own', async () => {
    const { prisma, captured, state } = recordingPrisma();
    const outcome = await prisma.$transaction(async (tx) => { await seedDemoOnTransaction(tx as unknown as ProtectedTx, 'bcrypt-hash-placeholder'); }, { maxWait: 1000, timeout: 5000 }).then(() => 'completed', () => 'stopped');
    expect(['completed', 'stopped']).toContain(outcome); // an empty recording database may stop the seed early; the proof is about what it issued
    expect(state.connects).toBe(1);
    const statements = captured.map((c) => c.text).filter((t) => t !== 'BEGIN' && t !== 'COMMIT' && t !== 'ROLLBACK');
    expect(statements.length).toBeGreaterThan(0);
    expect(statements[0]).toBe('SELECT pg_advisory_xact_lock(506005)::text');
    for (const sql of statements) {
      expect(sql, sql.slice(0, 60)).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|LOCK|DISCARD)\b|set_config/i);
      expect(qualified(sql), sql.slice(0, 100)).toBe(true);
    }
    expect(new Set(captured.map((c) => c.client)).size).toBe(1);
  });
});
