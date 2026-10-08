import { describe, expect, it } from 'vitest';
import {
  TEST_SESSION_DIAGNOSTICS_VAR,
  captureTestSessionDiagnosticOwner,
  localTestPoolConfig,
  testPoolConfig,
} from '../scripts/demo-database.js';

function stackFrom(...frames: string[]) {
  return ['Error', ...frames.map((frame) => `    at ${frame}`)].join('\n');
}

// D4A3B: D4A2 proved the startup application_name attribution channel was NOT
// observable in hosted TEST through the current connection path, so the D4A1
// application_name transport was removed. What remains — and what the new
// pool/PID sidecar attribution (tests/helpers/pool-attribution.ts) consumes —
// is the owner capture at the public acquisition boundary, and the guarantee
// that the pool CONFIG carries no diagnostic transport at all.
describe('TEST session diagnostics owner capture', () => {
  it('captures the calling prisma test file at the acquisition boundary', () => {
    const owner = captureTestSessionDiagnosticOwner(
      'prisma',
      stackFrom(
        'proveSelectedTestDatabase (/repo/api/tests/helpers/test-db.ts:41:1)',
        't (/repo/api/tests/backoffice/scope-assignment.test.ts:21:5)',
      ),
    );
    expect(owner).toEqual({
      resourceClass: 'prisma',
      owner: 'backoffice/scope-assignment.test.ts',
    });
  });

  it('skips helper frames and captures the seed caller instead', () => {
    const owner = captureTestSessionDiagnosticOwner(
      'seed',
      stackFrom(
        'openSeedDatabase (/repo/api/scripts/demo-database.ts:390:1)',
        't (/repo/api/tests/rbac/scope-backfill.test.ts:103:5)',
      ),
    );
    expect(owner).toEqual({
      resourceClass: 'seed',
      owner: 'rbac/scope-backfill.test.ts',
    });
  });

  it('is UNKNOWN for a malformed stack (never valid owner proof)', () => {
    expect(captureTestSessionDiagnosticOwner('prisma', 'not a useful stack')).toEqual({
      resourceClass: 'prisma',
      owner: 'UNKNOWN',
    });
    expect(captureTestSessionDiagnosticOwner('seed', '')).toEqual({
      resourceClass: 'seed',
      owner: 'UNKNOWN',
    });
  });

  it('captures its own live stack as this test file', () => {
    const owner = captureTestSessionDiagnosticOwner('prisma');
    expect(owner).toEqual({
      resourceClass: 'prisma',
      owner: 'test-db-session-diagnostics.test.ts',
    });
  });

  it('never carries a diagnostic transport in the pool config (application_name removed)', () => {
    const url = 'postgresql://postgres.example:secret@db.pooler.supabase.com:5432/postgres';
    const config = testPoolConfig(url, 5);
    expect(Object.keys(config).sort()).toEqual([
      'connectionString',
      'connectionTimeoutMillis',
      'idleTimeoutMillis',
      'max',
      'ssl',
    ]);
    expect(config.max).toBe(5);
    expect((config as { application_name?: string }).application_name).toBeUndefined();
  });

  it('keeps the LOCAL_TEST pool config untouched', () => {
    const url = 'postgresql://mona_local_test:secret@127.0.0.1:5432/mona_local_test';
    const local = localTestPoolConfig(url, 3);
    expect(local).toMatchObject({ connectionString: url, ssl: false, max: 3 });
    expect((local as { application_name?: string }).application_name).toBeUndefined();
  });

  it('exports the diagnostics env gate the attribution module must mirror', () => {
    expect(TEST_SESSION_DIAGNOSTICS_VAR).toBe('MONA_TEST_SESSION_DIAGNOSTICS');
  });
});
