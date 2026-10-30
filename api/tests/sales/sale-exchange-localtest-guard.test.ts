// Hermetic (no database): the LOCAL_TEST-only exchange fixture suite must never reach a write on a database that is not provably the
// disposable LOCAL_TEST. Two independent defences: the suite is skipped unless the run targets LOCAL_TEST, and its setup proves the
// identity BEFORE the first write (truncate / location cleanup / seed / fixture load).
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { prepareLocalTestFixtureDatabase, type LocalTestFixtureSteps } from '../helpers/localtest-fixture-setup.js';

const source = readFileSync(new URL('./sale-exchange.localtest-fixture.pg.test.ts', import.meta.url), 'utf8');
const db = { marker: 'db' } as never;

function steps(overrides: Partial<LocalTestFixtureSteps<string>> = {}) {
  const calls: string[] = [];
  const record = <T>(name: string, value?: T) => vi.fn(async () => { calls.push(name); return value as T; });
  const all = {
    assertDisposableLocalTest: record('assert'),
    truncateAllTables: record('truncate'),
    removeLocalTestLocations: record('remove'),
    seedDemo: record('seed'),
    loadFixture: record('load', 'FIXTURE'),
    ...overrides,
  } as LocalTestFixtureSteps<string>;
  return { all, calls };
}

describe('prepareLocalTestFixtureDatabase', () => {
  it('1 when the identity proof refuses (hosted TEST), NOTHING is written: truncate, cleanup, seed and fixture load are never called', async () => {
    const refusal = new Error('refused: not LOCAL_TEST');
    const { all, calls } = steps({ assertDisposableLocalTest: vi.fn(async () => { throw refusal; }) });
    await expect(prepareLocalTestFixtureDatabase(db, all)).rejects.toBe(refusal);
    expect(calls).toEqual([]);
    expect(all.truncateAllTables).toHaveBeenCalledTimes(0);
    expect(all.removeLocalTestLocations).toHaveBeenCalledTimes(0);
    expect(all.seedDemo).toHaveBeenCalledTimes(0);
    expect(all.loadFixture).toHaveBeenCalledTimes(0);
  });

  it('2 on LOCAL_TEST the flow is unchanged and the proof comes FIRST: assert -> truncate -> cleanup -> seed -> load', async () => {
    const { all, calls } = steps();
    await expect(prepareLocalTestFixtureDatabase(db, all)).resolves.toBe('FIXTURE');
    expect(calls).toEqual(['assert', 'truncate', 'remove', 'seed', 'load']);
    for (const step of [all.assertDisposableLocalTest, all.truncateAllTables, all.removeLocalTestLocations, all.seedDemo, all.loadFixture]) {
      expect(step).toHaveBeenCalledWith(db);
    }
  });

  it('3 a failure after the proof surfaces as is (no swallowed errors)', async () => {
    const boom = new Error('seed failed');
    const { all } = steps({ seedDemo: vi.fn(async () => { throw boom; }) });
    await expect(prepareLocalTestFixtureDatabase(db, all)).rejects.toBe(boom);
    expect(all.loadFixture).toHaveBeenCalledTimes(0);
  });
});

describe('sale-exchange.localtest-fixture.pg.test.ts is explicitly LOCAL_TEST-only', () => {
  it('4 the suite is skipped unless MONA_TEST_DATABASE_TARGET=local, the same gate as sale-exchange-read.pg.test.ts', () => {
    expect(source).toContain("const ON_LOCAL_TEST = process.env.MONA_TEST_DATABASE_TARGET === 'local';");
    expect(source).toMatch(/describe\.skipIf\(!ON_LOCAL_TEST\)\(/);
    expect(source).not.toMatch(/^describe\(/m);
  });

  it('5 setup goes through the guarded helper and never calls truncateAllTables directly', () => {
    expect(source).toContain('prepareLocalTestFixtureDatabase(');
    expect(source).not.toMatch(/\btruncateAllTables\(/);
    expect(source).not.toMatch(/\bseedDemo\(/);
  });
});
