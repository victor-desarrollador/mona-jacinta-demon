// V2.3.3 R4 — real PostgreSQL proofs AC-204..AC-214. Runs ONLY when the gate (gate.ts) is open and only against the
// disposable LOCAL_TEST target proven in-process by the repository guards. Otherwise every test is skipped (the DB-free
// integrity suite r4-real-db.harness.test.ts runs always). No assertion here prints row data, URLs or credentials.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROTECTED_RELATIONS, proveDomainOnTransaction, proveSettingsOnTransaction, relationRowsSql } from '../../scripts/local-test-fingerprint.js';
import {
  ResumeFailure,
  checkOutcomeTransaction,
  withBackupSnapshotTransaction,
  withProtectedResumeTransaction,
  type ProtectedResumeRequest,
  type ProtectedSteps,
} from '../../scripts/local-test-runtime.js';
import { EvidenceRecorder, newCanaryId } from './evidence.js';
import {
  EVIDENCE_DIR_VAR,
  evaluateGate,
} from './gate.js';
import {
  OWNER_SETUP_REPLAY,
  PG_DUMP,
  PG_RESTORE_LIST_ONLY,
  classifySequence,
  clientAsTx,
  competingAttempt,
  harnessSteps,
  inRolledBackTx,
  insertCanary,
  openTarget,
  pgChildEnv,
  pgConnArgs,
  rawOf,
  removeCanary,
  requireMigration5,
  runTool,
  sweepCanaries,
  withPidProbe,
  type Target,
} from './fixture.js';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const gate = evaluateGate(process.env);
const suite = describe.skipIf(!gate.enabled);
const evidence = new EvidenceRecorder();
const HEX64 = /^[0-9a-f]{64}$/;
const sha256 = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const nonce = () => randomBytes(4).toString('hex');

let target: Target;

suite('V2.3.3 R4 real PostgreSQL proofs (disposable LOCAL_TEST only)', () => {
  beforeAll(async () => {
    target = await openTarget(process.env);
    await requireMigration5(target.pool);
    await sweepCanaries(target.pool);
  }, 120_000);

  afterAll(async () => {
    if (!target) return;
    try {
      await sweepCanaries(target.pool);
      evidence.flush(process.env[EVIDENCE_DIR_VAR], REPO_ROOT);
    } finally {
      await target.close();
    }
  }, 60_000);

  const outcome = () => checkOutcomeTransaction(target.prisma, { steps: harnessSteps(target.markerId) });

  // One protected resume whose stand-in seed does nothing: the transaction always ends in the 'guard' rollback ("the seed
  // changed nothing"), so no durable change can result unless `seed` itself writes (AC-210 only).
  const resume = async (
    seed: ProtectedSteps['seed'],
    extra: { steps?: Partial<ProtectedSteps>; persist?: ProtectedResumeRequest['persistPostWitness'] } = {},
  ) => {
    const expectedFPre = (await outcome()).pre;
    let witnessCalls = 0;
    const request: ProtectedResumeRequest = {
      expectedFPre,
      passwordHash: 'r4-synthetic-not-a-hash',
      checkPreconditions: async () => undefined,
      consumeAuthorization: async () => undefined,
      persistPostWitness:
        extra.persist ??
        (async (r) => {
          witnessCalls += 1;
          return { durable: true, nonce: r.nonce, fPost: r.fPost };
        }),
    };
    const steps = harnessSteps(target.markerId, { classify: classifySequence('POST_BACKFILL', 'EXACT_BASELINE'), seed, ...extra.steps });
    let failure: unknown = null;
    let result: { fPost: string } | null = null;
    try {
      result = await withProtectedResumeTransaction(target.prisma, request, { steps });
    } catch (error) {
      failure = error;
    }
    return { expectedFPre, failure, result, witnessCalls: () => witnessCalls };
  };

  it('AC-204 locks / writer exclusion: a second session cannot write or lock-DDL, but can read', async () => {
    const seen: { write?: string; insert?: string; ddl?: string; read?: string; pids: number[] } = { pids: [] };
    const r = await resume(async () => {
      const w = await competingAttempt(target.pool, 'UPDATE public."Brand" SET name = name WHERE false');
      const i = await competingAttempt(target.pool, `INSERT INTO public."Brand" (id, name) SELECT 'x', 'x' WHERE false`);
      const d = await competingAttempt(target.pool, 'LOCK TABLE public."Brand" IN ACCESS EXCLUSIVE MODE');
      const rd = await competingAttempt(target.pool, 'SELECT count(*) FROM public."Brand"');
      Object.assign(seen, { write: w.outcome, insert: i.outcome, ddl: d.outcome, read: rd.outcome });
      seen.pids.push(w.pid, i.pid, d.pid, rd.pid);
    });
    expect(r.failure).toBeInstanceOf(ResumeFailure);
    expect((r.failure as ResumeFailure).kind).toBe('ROLLED_BACK');
    expect((r.failure as ResumeFailure).stage).toBe('guard');
    expect(r.witnessCalls()).toBe(0);
    expect(seen.write).toBe('55P03');
    expect(seen.insert).toBe('55P03');
    expect(seen.ddl).toBe('55P03');
    expect(seen.read).toBe('ok');
    evidence.record('AC-204', { writerBlocked: seen.write === '55P03', insertBlocked: seen.insert === '55P03', ddlBlocked: seen.ddl === '55P03', readerAllowed: seen.read === 'ok', competingSessions: new Set(seen.pids).size, rolledBackAtStage: 'guard' });
  }, 120_000);

  it('AC-205 snapshot + dump equivalence: pg_dump --snapshot sees the PRE state', async () => {
    const preFingerprint = (await outcome()).pre;
    const id = newCanaryId(nonce());
    // pg_dump 17.x writes a random \restrict key into plain output; pinning it keeps the byte-identity comparison exact (not weakened).
    const args = (snapshot: string | null) => [...pgConnArgs(target.url), '--data-only', '--table=public."Brand"', '--restrict-key=r4harnessfixedkey', ...(snapshot ? [`--snapshot=${snapshot}`] : [])];
    try {
      const probe = await withBackupSnapshotTransaction(
        target.prisma,
        async (ctx) => {
          await insertCanary(target.pool, id); // committed AFTER the exported snapshot
          const withSnapshot = await runTool(PG_DUMP, args(ctx.snapshotId), pgChildEnv(target.url));
          const again = await runTool(PG_DUMP, args(ctx.snapshotId), pgChildEnv(target.url));
          const live = await runTool(PG_DUMP, args(null), pgChildEnv(target.url));
          return {
            fPre: ctx.fPre,
            codes: [withSnapshot.code, again.code, live.code],
            snapshotSeesCanary: withSnapshot.stdout.includes(id),
            liveSeesCanary: live.stdout.includes(id),
            dumpsIdentical: sha256(withSnapshot.stdout) === sha256(again.stdout),
          };
        },
        { steps: harnessSteps(target.markerId, { classify: classifySequence('POST_BACKFILL') }) },
      );
      expect(probe.codes).toEqual([0, 0, 0]);
      expect(probe.fPre).toBe(preFingerprint);
      expect(probe.snapshotSeesCanary).toBe(false);
      expect(probe.liveSeesCanary).toBe(true);
      expect(probe.dumpsIdentical).toBe(true);
      evidence.record('AC-205', { fPreEqualsPreCanaryDigest: probe.fPre === preFingerprint, snapshotExcludesLaterCommit: !probe.snapshotSeesCanary, controlDumpIncludesLaterCommit: probe.liveSeesCanary, snapshotDumpsIdentical: probe.dumpsIdentical });
    } finally {
      await removeCanary(target.pool, id);
    }
    expect((await outcome()).pre).toBe(preFingerprint);
  }, 180_000);

  it('AC-206 live Prisma qualification under search_path = pg_catalog, pg_temp', async () => {
    const digests = await outcome(); // throws OutcomeCheckFailure if Prisma needs an unqualified public lookup
    expect(digests.pre).toMatch(HEX64);
    expect(digests.post).toMatch(HEX64);
    expect(digests.serverVersionNum).toMatch(/^\d{6}$/);
    evidence.record('AC-206', { prismaReadsSucceed: true, publicInSearchPath: false, serverVersionNum: digests.serverVersionNum });
  }, 120_000);

  it('AC-207 pg_temp and $user: shadows are refused or inert', async () => {
    const result = await inRolledBackTx(target.pool, async (client) => {
      await client.query('SET LOCAL search_path = pg_catalog, pg_temp');
      const tx = clientAsTx(client);
      const control = await proveDomainOnTransactionResult(tx);
      const realCount = Number((await client.query('SELECT count(*)::int AS n FROM ONLY public."Brand"')).rows[0].n);
      await client.query('CREATE TEMP TABLE "Brand" (id text, name text)');
      await client.query(`INSERT INTO pg_temp."Brand" VALUES ('r4-shadow', 'r4-shadow')`);
      const shadowed = await proveDomainOnTransactionResult(tx);
      const rows = (await rawOf(tx).$queryRawUnsafe(relationRowsSql('Brand'))) as { c1: string }[];
      return { control, shadowed, realCount, qualifiedRows: rows.length, shadowRead: rows.some((r) => r.c1 === 'r4-shadow') };
    });
    expect(result.control).toBe('accepted');
    expect(result.shadowed).toBe('refused');
    expect(result.shadowRead).toBe(false);
    expect(result.qualifiedRows).toBe(result.realCount);

    const userSchema = await inRolledBackTx(target.pool, async (client) => {
      const user = String((await client.query('SELECT current_user AS u')).rows[0].u);
      try {
        await client.query(`CREATE SCHEMA "${user.replace(/"/g, '')}"`);
      } catch (error) {
        return { created: false, code: String((error as { code?: unknown }).code ?? 'error'), pinnedIgnoresIt: true, controlResolvesShadow: null as boolean | null };
      }
      await client.query(`CREATE TABLE "${user.replace(/"/g, '')}"."Brand" (id text, name text)`);
      await client.query(`INSERT INTO "${user.replace(/"/g, '')}"."Brand" VALUES ('r4-user-shadow', 'x')`);
      await client.query('SET LOCAL search_path = "$user", public');
      const hazard = Number((await client.query('SELECT count(*)::int AS n FROM "Brand"')).rows[0].n);
      await client.query('SET LOCAL search_path = pg_catalog, pg_temp');
      const rows = (await rawOf(clientAsTx(client)).$queryRawUnsafe(relationRowsSql('Brand'))) as { c1: string }[];
      return { created: true, code: 'ok', pinnedIgnoresIt: !rows.some((r) => r.c1 === 'r4-user-shadow'), controlResolvesShadow: hazard === 1 };
    });
    expect(userSchema.pinnedIgnoresIt).toBe(true);
    evidence.record('AC-207', { pgTempShadowRefusedByDomainProof: result.shadowed === 'refused', qualifiedReadIgnoresShadow: !result.shadowRead, userSchemaCreatable: userSchema.created, userSchemaCode: userSchema.code, userSchemaPinnedIgnoresIt: userSchema.pinnedIgnoresIt });
  }, 120_000);

  it('AC-208 jsonb / timestamptz / type exactness', async () => {
    const ids = [newCanaryId(nonce()), newCanaryId(nonce()), newCanaryId(nonce()), newCanaryId(nonce()), newCanaryId(nonce())];
    const r = await inRolledBackTx(target.pool, async (client) => {
      const insert = (id: string, started: string) =>
        client.query(
          `INSERT INTO public."_prisma_migrations" (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) VALUES ($1, 'r4', NULL, $1, NULL, NULL, '${started}', 0)`,
          [id],
        );
      await insert(ids[0] as string, '2026-01-01 00:00:00+00');
      await insert(ids[1] as string, '2025-12-31 21:00:00-03');
      await insert(ids[2] as string, '2026-01-01 00:00:00.123456+00');
      await insert(ids[3] as string, 'infinity');
      await insert(ids[4] as string, '-infinity');
      await client.query("SET LOCAL TimeZone = 'Asia/Tokyo'");
      const rows = (await client.query(relationRowsSql('_prisma_migrations'))).rows as Record<string, string | null>[];
      const by = (id: string) => rows.find((row) => row.c1 === id) as Record<string, string | null>;
      const lit = (await client.query(
        `SELECT '{"b":2,"a":[1,2]}'::jsonb::pg_catalog.text AS j1, '{ "a" : [1, 2], "b" : 2 }'::jsonb::pg_catalog.text AS j2,
                '{"a":1,"a":2}'::jsonb::pg_catalog.text AS dup, '{"n":1.50}'::jsonb::pg_catalog.text AS num,
                'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11'::uuid::pg_catalog.text AS u, true::pg_catalog.text AS b,
                9223372036854775807::bigint::pg_catalog.text AS i, NULL::pg_catalog.text AS n`,
      )).rows[0] as Record<string, string | null>;
      return { zoneA: by(ids[0] as string).c7, zoneB: by(ids[1] as string).c7, micro: by(ids[2] as string).c7, inf: by(ids[3] as string).c7, ninf: by(ids[4] as string).c7, nullCols: [by(ids[0] as string).c3, by(ids[0] as string).c5, by(ids[0] as string).c6], steps: by(ids[0] as string).c8, lit };
    });
    expect(r.zoneA).toBe('1767225600000000');
    expect(r.zoneB).toBe(r.zoneA);
    expect(r.micro).toBe('1767225600123456');
    expect(r.inf).toBe('+infinity');
    expect(r.ninf).toBe('-infinity');
    expect(r.nullCols).toEqual([null, null, null]);
    expect(r.steps).toBe('0');
    expect(r.lit.j1).toBe(r.lit.j2);
    expect(r.lit.dup).toBe('{"a": 2}');
    expect(r.lit.num).toBe('{"n": 1.50}');
    expect(r.lit.u).toBe('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
    expect(r.lit.b).toBe('true');
    expect(r.lit.i).toBe('9223372036854775807');
    expect(r.lit.n).toBeNull();
    evidence.record('AC-208', { jsonbKeyOrderEqual: r.lit.j1 === r.lit.j2, jsonbDuplicateKeyLastWins: r.lit.dup === '{"a": 2}', tstzZonesEqual: r.zoneA === r.zoneB, tstzMicrosecondExact: r.micro === '1767225600123456', infinityHandled: r.inf === '+infinity' && r.ninf === '-infinity', uuidLowercase: true, nullPreserved: true });
  }, 120_000);

  it('AC-209 synchronous_commit / fsync', async () => {
    const outcomeOf = async (mutate: string | null) =>
      inRolledBackTx(target.pool, async (client) => {
        for (const sql of OWNER_SETUP_REPLAY) await client.query(sql);
        if (mutate) await client.query(mutate);
        return proveSettingsResult(clientAsTx(client));
      });
    expect(await outcomeOf(null)).toBe('accepted');
    expect(await outcomeOf('SET LOCAL synchronous_commit = off')).toBe('refused');
    const fsyncCode = await inRolledBackTx(target.pool, async (client) => {
      try {
        await client.query('SET LOCAL fsync = off');
        return 'ok';
      } catch (error) {
        return String((error as { code?: unknown }).code ?? 'error');
      }
    });
    expect(fsyncCode).not.toBe('ok');
    const fsync = (await target.pool.query("SELECT current_setting('fsync') AS v")).rows[0].v;
    expect(fsync).toBe('on');
    evidence.record('AC-209', { resumeProfileAcceptsOn: true, resumeProfileRefusesOff: true, fsyncOn: fsync === 'on', fsyncChangeSqlstate: fsyncCode });
  }, 120_000);

  it('AC-210 in-transaction vs post-commit digest', async () => {
    const id = newCanaryId(nonce());
    const visibleBefore: number[] = [];
    try {
      const r = await resume(
        async (tx) => {
          await (tx as unknown as { brand: { create: (a: unknown) => Promise<unknown> } }).brand.create({ data: { id, name: id } });
        },
        {
          persist: async (request) => {
            // the witness is durable BEFORE COMMIT: another session must not see the change yet
            visibleBefore.push(Number((await target.pool.query('SELECT count(*)::int AS n FROM public."Brand" WHERE id = $1', [id])).rows[0].n));
            return { durable: true, nonce: request.nonce, fPost: request.fPost };
          },
        },
      );
      expect(r.failure).toBeNull();
      const fPost = (r.result as { fPost: string }).fPost;
      const after = await outcome();
      expect(visibleBefore).toEqual([0]);
      expect(after.post).toBe(fPost);
      expect(after.pre).not.toBe(r.expectedFPre);
      evidence.record('AC-210', { changeInvisibleBeforeCommit: visibleBefore[0] === 0, postCommitDigestEqualsWitness: after.post === fPost, stateChanged: after.pre !== r.expectedFPre });
      await removeCanary(target.pool, id);
      expect((await outcome()).pre).toBe(r.expectedFPre);
    } finally {
      await removeCanary(target.pool, id);
    }
  }, 180_000);

  it.todo('AC-211 restore re-fingerprint — OWNER_DECISION_REQUIRED (destructive restore is not implemented in this harness)');

  it('AC-212 backend pid is constant across every protected step', async () => {
    const pids: number[] = [];
    const other: number[] = [];
    const inner = harnessSteps(target.markerId, {
      classify: classifySequence('POST_BACKFILL', 'EXACT_BASELINE'),
      seed: async () => {
        other.push((await competingAttempt(target.pool, 'SELECT 1')).pid);
      },
    });
    const r = await resume(async () => undefined, { steps: withPidProbe(inner, pids) });
    expect(r.failure).toBeInstanceOf(ResumeFailure);
    expect(pids.length).toBeGreaterThanOrEqual(8);
    expect(new Set(pids).size).toBe(1);
    expect(other.every((pid) => !pids.includes(pid))).toBe(true);
    evidence.record('AC-212', { stepsObserved: pids.length, distinctBackendPids: new Set(pids).size, otherSessionDiffers: true });
  }, 120_000);

  it('AC-213 real archive TOC of an actual pg_dump', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'r4-toc-'));
    const file = path.join(dir, 'archive.dump');
    try {
      const dump = await runTool(PG_DUMP, ['--format=custom', '--no-owner', '--no-acl', '--schema=public', '--strict-names', '--lock-wait-timeout=10000', ...pgConnArgs(target.url), `--file=${file}`], pgChildEnv(target.url));
      expect(dump.code).toBe(0);
      expect(dump.stderrBytes).toBe(0);
      const listed = await runTool(PG_RESTORE_LIST_ONLY, ['--list', file], { PATH: '/usr/bin:/bin', LC_ALL: 'C' });
      expect(listed.code).toBe(0);
      expect(listed.stderrBytes).toBe(0);
      const toc = listed.stdout.toString('utf8');
      const prepare = (await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/database/local-test-prepare.mjs')).href)) as { checkToc: (text: string) => { ok: boolean; tables?: number; entries?: number } };
      const verdict = prepare.checkToc(toc);
      expect(verdict.ok).toBe(true);
      expect(verdict.tables).toBe(PROTECTED_RELATIONS.length);
      // negative controls on the REAL listing: a duplicated TABLE entry and a dropped entry must both be refused
      const lines = toc.split('\n');
      const tableLine = lines.findIndex((line) => /^\d+; \d+ \d+ TABLE public /.test(line));
      expect(tableLine).toBeGreaterThan(-1);
      const duplicated = [...lines.slice(0, tableLine + 1), lines[tableLine] as string, ...lines.slice(tableLine + 1)].join('\n');
      const dropped = lines.filter((_, i) => i !== tableLine).join('\n');
      expect(prepare.checkToc(duplicated).ok).toBe(false);
      expect(prepare.checkToc(dropped).ok).toBe(false);
      expect(readFileSync(file).length).toBeGreaterThan(0);
      evidence.record('AC-213', { dumpExit: 0, listExit: 0, stderrEmpty: true, checkTocOk: true, protectedTables: PROTECTED_RELATIONS.length, duplicateRefused: true, droppedEntryRefused: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('AC-214 OWNER.updatedAt is not written by the real Prisma upsert update:{}', async () => {
    const id = newCanaryId(nonce());
    const email = `${id}@example.invalid`;
    class Rollback extends Error {}
    let before = '';
    let after = '';
    try {
      await target.prisma.$transaction(async (tx) => {
        const args = { where: { email }, create: { id, name: 'R4 canary', email, passwordHash: 'r4-synthetic-not-a-hash' }, update: {} };
        await tx.user.upsert(args);
        const read = async () => String(((await tx.$queryRawUnsafe(`SELECT (EXTRACT(EPOCH FROM "updatedAt") * 1000000)::numeric(20,0)::text AS u FROM public."User" WHERE id = $1`, id)) as { u: string }[])[0]?.u);
        before = await read();
        await new Promise((resolve) => setTimeout(resolve, 40));
        await tx.user.upsert(args);
        after = await read();
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    expect(before).toMatch(/^\d+$/);
    expect(after).toBe(before);
    evidence.record('AC-214', { updatedAtUnchangedByUpsertEmptyUpdate: after === before });
  }, 120_000);
});

async function proveDomainOnTransactionResult(tx: ReturnType<typeof clientAsTx>): Promise<'accepted' | 'refused'> {
  try {
    await proveDomainOnTransaction(tx);
    return 'accepted';
  } catch {
    return 'refused';
  }
}

async function proveSettingsResult(tx: ReturnType<typeof clientAsTx>): Promise<'accepted' | 'refused'> {
  try {
    await proveSettingsOnTransaction(tx, 'resume');
    return 'accepted';
  } catch {
    return 'refused';
  }
}
