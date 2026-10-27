// Transient transaction failure classification (Prisma P2034 / SQLSTATE 40001 / 40P01 / TransactionWriteConflict) in every shape the driver stack
// really produces: the Prisma code, meta.code, the adapter-pg driverAdapterError cause (originalCode / code / kind), a pg error carrying the
// SQLSTATE as `code`, an Error.cause chain, or the SQLSTATE as a whole token in the message.
// One classifier shared by the flows that retry a Serializable transaction (manual stock adjustment, sale exchange), so a fix lands once.
const TRANSIENT_SQLSTATES = new Set(['40001', '40P01']);
const MAX_CAUSE_DEPTH = 4;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isTransientState = (value: unknown) => typeof value === 'string' && TRANSIENT_SQLSTATES.has(value);

export function isTransientTransactionError(error: unknown, depth = 0): boolean {
  if (!isRecord(error) || depth > MAX_CAUSE_DEPTH) return false;
  const meta = isRecord(error.meta) ? error.meta : {};
  const adapter = isRecord(meta.driverAdapterError) ? meta.driverAdapterError : {};
  const adapterCause = isRecord(adapter.cause) ? adapter.cause : {};
  const message = error instanceof Error ? error.message : '';
  return error.code === 'P2034'
    || isTransientState(error.code)
    || isTransientState(meta.code)
    || isTransientState(adapterCause.originalCode)
    || isTransientState(adapterCause.code)
    || adapterCause.kind === 'TransactionWriteConflict'
    || /(?<![0-9A-Za-z])(40001|40P01)(?![0-9A-Za-z])/.test(message)
    || message.includes('TransactionWriteConflict')
    || isTransientTransactionError(error.cause, depth + 1);
}
