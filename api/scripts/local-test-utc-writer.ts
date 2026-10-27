// The Prisma adapter binds a Date as zone-less text, so every instant a LOCAL_TEST writer stores is interpreted in the session's
// zone: under a non-UTC server default (found on the real PostgreSQL: America/Argentina/Buenos_Aires) seed #1 and the Company/Location
// backfill stored every timestamp shifted by the offset, and seed #2 (which pins UTC) rightly refused to rewrite them. The default
// writers therefore run each of their transactions with a transaction-local UTC zone, verified before the body runs. Nothing global
// (role, database, server, PGOPTIONS) is touched, and only function-form $transaction is supported (fail closed otherwise).
export const UTC_WRITER_PIN_SQL = "SET LOCAL timezone = 'UTC'";
export const UTC_WRITER_VERIFY_SQL = "SELECT pg_catalog.current_setting('TimeZone') AS tz";
export function pinUtcWriterSession<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === '$transaction') {
        return (body: unknown, options?: unknown) => {
          if (typeof body !== 'function') throw new Error('LOCAL_TEST writers support only the interactive transaction form');
          const run = (target as unknown as { $transaction: (fn: (tx: unknown) => Promise<unknown>, o?: unknown) => Promise<unknown> }).$transaction.bind(target);
          return run(async (tx) => {
            const raw = tx as { $executeRawUnsafe: (sql: string) => Promise<unknown>; $queryRawUnsafe: (sql: string) => Promise<unknown> };
            await raw.$executeRawUnsafe(UTC_WRITER_PIN_SQL);
            const rows = (await raw.$queryRawUnsafe(UTC_WRITER_VERIFY_SQL)) as { tz?: unknown }[];
            if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.tz !== 'UTC') throw new Error('LOCAL_TEST writer could not pin the session zone to UTC');
            return (body as (tx: unknown) => Promise<unknown>)(tx);
          }, options);
        };
      }
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
