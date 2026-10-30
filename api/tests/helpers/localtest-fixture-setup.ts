// Setup of the LOCAL_TEST-only exchange fixture suite. The identity proof is the FIRST statement: nothing below it (truncate, location
// cleanup, seed, fixture load) can run against a database that is not provably the disposable LOCAL_TEST, even if the suite-level skip is
// ever removed or bypassed. The steps are injected so the ordering is testable without a database.
export type LocalTestFixtureSteps<TFixture, TDb = never> = {
  assertDisposableLocalTest: (db: TDb) => Promise<void>;
  truncateAllTables: (db: TDb) => Promise<void>;
  removeLocalTestLocations: (db: TDb) => Promise<void>;
  seedDemo: (db: TDb) => Promise<unknown>;
  loadFixture: (db: TDb) => Promise<TFixture>;
};

export async function prepareLocalTestFixtureDatabase<TFixture, TDb>(
  db: TDb,
  steps: LocalTestFixtureSteps<TFixture, TDb>,
): Promise<TFixture> {
  await steps.assertDisposableLocalTest(db);
  await steps.truncateAllTables(db);
  await steps.removeLocalTestLocations(db);
  await steps.seedDemo(db);
  return steps.loadFixture(db);
}
