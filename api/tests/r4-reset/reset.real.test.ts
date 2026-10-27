// REAL destructive reset of the canonical disposable LOCAL_TEST. Skipped unless the reset gate is open (explicit owner token,
// MONA_TEST_DATABASE_TARGET=local, no DATABASE_URL/TEST_DATABASE_URL, canonical loopback target, expected marker == configured marker).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openProvenLocalTestPool, proveIdentityOnTransaction } from '../../scripts/demo-database.js';
import { EvidenceRecorder } from '../r4-real-db/evidence.js';
import { clientAsTx } from '../r4-real-db/fixture.js';
import { LOCAL_MARKER_VAR, LOCAL_URL_VAR } from '../r4-real-db/gate.js';
import { evaluateResetGate, resetDisposableLocalTest, RESET_EXPECTED_MARKER_VAR, RESET_TOKEN_VAR, type ResetClient, type ResetDeps, type ResetReport } from './reset.js';

const decision = evaluateResetGate(process.env);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe.skipIf(!decision.enabled)('R4 REAL destructive reset of the disposable LOCAL_TEST (R30-R32)', () => {
  it('R30-R32 reset, repeat (ALREADY_FRESH), marker digest and identity preserved', async () => {
    const source = { [LOCAL_URL_VAR]: process.env[LOCAL_URL_VAR] as string, [LOCAL_MARKER_VAR]: process.env[LOCAL_MARKER_VAR] as string } as NodeJS.ProcessEnv;
    const markerId = source[LOCAL_MARKER_VAR] as string;
    const evidence = new EvidenceRecorder();
    const { pool } = await openProvenLocalTestPool(1, source); // identity proven in-process before anything else
    try {
      const run = async (): Promise<ResetReport> => {
        const client = await pool.connect();
        try {
          const resetClient = client as unknown as ResetClient;
          const deps: ResetDeps = {
            client: resetClient,
            ownerToken: process.env[RESET_TOKEN_VAR],
            expectedMarkerId: process.env[RESET_EXPECTED_MARKER_VAR],
            targetMarkerId: markerId,
            proveIdentity: (c) => proveIdentityOnTransaction(clientAsTx(c as unknown as Parameters<typeof clientAsTx>[0]), markerId),
          };
          return await resetDisposableLocalTest(deps);
        } finally {
          client.release();
        }
      };
      const first = await run();
      evidence.record('R30', { outcome: first.outcome, droppedTables: first.droppedTables, droppedTypes: first.droppedTypes, droppedFunctions: first.droppedFunctions, rowTotal: Object.values(first.rowCounts).reduce((a, b) => a + b, 0) });
      const second = await run();
      evidence.record('R31', { outcome: second.outcome, droppedTables: second.droppedTables, droppedTypes: second.droppedTypes });
      evidence.record('R32', { markerDigestEqual: first.markerDigest === second.markerDigest });
      expect(second.outcome).toBe('ALREADY_FRESH');
      expect(second.markerDigest).toBe(first.markerDigest);
      // a brand-new proven pool re-proves the identity after the commit
      const again = await openProvenLocalTestPool(1, source);
      await again.pool.end();
      evidence.record('R30-post', { identityReproved: true });
    } finally {
      await pool.end();
      evidence.flush(process.env.MONA_R4_EVIDENCE_DIR, REPO_ROOT);
    }
  });
});
