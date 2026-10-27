// R3-A4.3 S1: pure (DB-free) helpers for the ninth migration
// 20261016130000_r3_checkout_attempts. No database, no child process, no
// network: the static schema test and the opt-in PostgreSQL test share them.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MIGRATIONS_DIR = path.join(API_ROOT, 'prisma', 'migrations');
export const R3_A2_MIGRATION = '20261016120000_r3_proportional_checkout';
export const R3_ATTEMPTS_MIGRATION = '20261016130000_r3_checkout_attempts';

export const P21B_INJECTION =
  "DO $$ BEGIN RAISE EXCEPTION 'P21b injected late failure' USING ERRCODE = 'P0001'; END $$;";

export function migrationPath(name: string): string {
  return path.join(MIGRATIONS_DIR, name, 'migration.sql');
}

export function readMigration(name: string): string {
  return readFileSync(migrationPath(name), 'utf8');
}

export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR).filter((d) => /^\d{14}_/.test(d)).sort();
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

// Splits SQL into top-level statements. Line comments are dropped; quoted
// strings, quoted identifiers and dollar-quoted bodies are kept intact, so a
// semicolon inside a plpgsql body never ends a statement.
export function splitTopLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch && sql[j + 1] === ch) { j += 2; continue; }
        if (sql[j] === ch) break;
        j += 1;
      }
      if (j >= sql.length) throw new Error(`unterminated ${ch} quote at offset ${i}`);
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`unterminated ${tag} body at offset ${i}`);
        current += sql.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }
    if (ch === ';') {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) throw new Error(`trailing statement without semicolon: ${current.trim().slice(0, 60)}`);
  return statements;
}

// Removes dollar-quoted bodies so text checks see only the statement shells.
export function stripDollarBodies(statement: string): string {
  return statement.replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, () => '$$ … $$');
}

export function functionBody(sql: string, name: string): string {
  const statement = splitTopLevelStatements(sql).find((s) =>
    new RegExp(`^CREATE FUNCTION public\\."${name}"\\(\\)`).test(s));
  if (!statement) throw new Error(`function ${name} not found`);
  const body = /\$\$([\s\S]*)\$\$/.exec(statement)?.[1];
  if (body === undefined) throw new Error(`function ${name} has no $$ body`);
  return body;
}

// Every `(NEW."a", NEW."b", ...)` tuple in a body, as column-name lists.
export function newTuples(body: string): string[][] {
  return [...body.matchAll(/\((\s*NEW\."\w+"(?:\s*,\s*NEW\."\w+")*\s*)\)/g)].map((m) =>
    [...m[1]!.matchAll(/NEW\."(\w+)"/g)].map((c) => c[1]!));
}

// Column names of a CREATE TABLE statement, in declaration order.
export function createTableColumns(sql: string, table: string): string[] {
  const statement = splitTopLevelStatements(sql).find((s) => s.startsWith(`CREATE TABLE "${table}" (`));
  if (!statement) throw new Error(`table ${table} not found`);
  const inner = statement.slice(statement.indexOf('(') + 1, statement.lastIndexOf(')'));
  const columns: string[] = [];
  let depth = 0;
  let part = '';
  const flush = () => {
    const m = /^\s*"(\w+)"\s/.exec(part);
    if (m && !/^\s*CONSTRAINT\b/.test(part)) columns.push(m[1]!);
    part = '';
  };
  for (const ch of inner) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { flush(); continue; }
    part += ch;
  }
  flush();
  return columns;
}

export function addedColumns(sql: string, table: string): string[] {
  return splitTopLevelStatements(sql)
    .filter((s) => s.startsWith(`ALTER TABLE "${table}" ADD COLUMN`))
    .flatMap((s) => [...s.matchAll(/ADD COLUMN "(\w+)"/g)].map((m) => m[1]!));
}

// P21b (R3-A4.3, three final corrections §3): the instrumented copy is the
// real migration with exactly one line inserted immediately before the last
// `COMMIT;` line. Anything else is refused.
export function deriveP21bInstrumentedCopy(original: string): string {
  const lines = original.split('\n');
  const commitIndexes = lines.flatMap((line, index) => (line === 'COMMIT;' ? [index] : []));
  if (commitIndexes.length !== 1) throw new Error(`expected exactly one COMMIT; line, found ${commitIndexes.length}`);
  const at = commitIndexes[0]!;
  if (lines.slice(at + 1).some((line) => line.trim() !== '')) throw new Error('COMMIT; must be the last statement');
  return [...lines.slice(0, at), P21B_INJECTION, ...lines.slice(at)].join('\n');
}

// Returns the inserted lines if `copy` equals `original` plus a contiguous
// insertion, else null.
export function insertedLines(original: string, copy: string): { at: number; lines: string[] } | null {
  const a = original.split('\n');
  const b = copy.split('\n');
  if (b.length < a.length) return null;
  let prefix = 0;
  while (prefix < a.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  if (prefix + suffix !== a.length) return null;
  return { at: prefix, lines: b.slice(prefix, b.length - suffix) };
}

// Migration-9 SHA-256 pin. The AUTHORITATIVE pin is fixed by R3-T (U1) in the
// reviewed LOCAL_TEST payload, scripts/database/local-test-migration-payload.mjs;
// this literal must equal it (bound by r3-attempts-pg-harness.static H06). A
// hash is never considered validated just because it is 64 lowercase hex
// characters: only an exact comparison against this pin is. `null` (no pin)
// still reports PENDING_R3_T_PIN, and P21b fails closed.
export const R3_T_MIGRATION_9_SHA256_PIN: string | null = '076884120da38a05099ee00dbb16aafaa9e8c78f5846889fe7f590a8e95d9148';

export type PinCheck = { status: 'MATCH' | 'PENDING_R3_T_PIN'; actual: string };

export function checkMigration9Pin(text: string | Buffer, pin: string | null = R3_T_MIGRATION_9_SHA256_PIN): PinCheck {
  const actual = sha256(text);
  if (pin === null) return { status: 'PENDING_R3_T_PIN', actual };
  if (!/^[0-9a-f]{64}$/.test(pin)) throw new Error('malformed R3-T pin for migration 9');
  if (actual !== pin) throw new Error(`migration 9 (sha256 ${actual}) does not match the R3-T pin ${pin}`);
  return { status: 'MATCH', actual };
}

// The exact _prisma_migrations content required before migration 9 is run
// (P21a/P21b): migrations 1–8 of this repository, each with the SHA-256 of its
// file, which is the checksum Prisma records.
export function expectedLedgerBeforeMigration9(): Array<{ name: string; checksum: string }> {
  const names = migrationNames();
  const at = names.indexOf(R3_ATTEMPTS_MIGRATION);
  if (at !== 8) throw new Error(`migration 9 must be the ninth migration, found at index ${at}`);
  return names.slice(0, 8).map((name) => ({ name, checksum: sha256(readFileSync(migrationPath(name))) }));
}
