// R3 PG gate (R-1/R-2, OWNER 2026-10-18): which unique constraint a Prisma
// P2002 names. Prisma's own engine reports it in meta.target (a column list or
// an index name). Through @prisma/adapter-pg 7.10 — what the API really runs on
// PostgreSQL — the same violation carries NO target: the constraint is in
// meta.driverAdapterError.cause.constraint, as { index } (the constraint name
// PostgreSQL reports) or { fields } (PostgreSQL-quoted identifiers parsed from
// the error detail). Nothing is ever inferred: a P2002 without either shape
// names nothing, so every classifier answers "not mine" and the caller rethrows
// the original error (errorHandler: 409 DATABASE_CONFLICT).

export type UniqueViolation = { modelName: string | null; fields: string[] | null; name: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
// "saleId" → saleId; a doubled quote inside a quoted identifier is one quote.
const unquote = (identifier: string) => (/^".*"$/.test(identifier) ? identifier.slice(1, -1).replaceAll('""', '"') : identifier);

// null when `error` is not a P2002; otherwise the constraint it names, if any.
export function uniqueViolation(error: unknown): UniqueViolation | null {
  if (!isRecord(error) || error.code !== 'P2002') return null;
  const meta = isRecord(error.meta) ? error.meta : {};
  const modelName = typeof meta.modelName === 'string' ? meta.modelName : null;
  if (isStringList(meta.target)) return { modelName, fields: [...meta.target], name: null };
  if (typeof meta.target === 'string') return { modelName, fields: null, name: meta.target };
  const cause = isRecord(meta.driverAdapterError) && isRecord(meta.driverAdapterError.cause) ? meta.driverAdapterError.cause : null;
  if (cause && cause.kind === 'UniqueConstraintViolation' && isRecord(cause.constraint)) {
    if (typeof cause.constraint.index === 'string') return { modelName, fields: null, name: cause.constraint.index };
    if (isStringList(cause.constraint.fields)) return { modelName, fields: cause.constraint.fields.map(unquote), name: null };
  }
  return { modelName, fields: null, name: null };
}

// The lowercase text the classifiers match: the constraint name, or the column
// list joined by commas; '' when the violation names nothing.
export function uniqueViolationText(violation: UniqueViolation): string {
  return (violation.name ?? violation.fields?.join(',') ?? '').toLowerCase();
}

// T-C and T-X: a P2002 of one of the two partial EXTERNAL reference indexes
// (ExternalCollection_transfer_ref_key / _debit_ref_key / _credit_ref_key), by
// SQL name, or by the column list Prisma reports for them. Never a false positive.
export function isExternalReferenceCollision(error: unknown): boolean {
  const violation = uniqueViolation(error);
  if (violation === null) return false;
  const text = uniqueViolationText(violation);
  return /externalcollection_(transfer|debit|credit)_ref_key/.test(text)
    || (text.includes('referencekey') && text.includes('branchid'));
}
