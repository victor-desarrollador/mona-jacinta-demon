// DB-free integrity tests of the R4 real-DB proof harness itself. No database, no network, no child process.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CANARY_PREFIX, EvidenceRecorder, assertEvidenceDirOutsideRepo, newCanaryId, sanitizeEvidence } from './evidence.js';
import { AC_CASES, AC_IDS } from './registry.js';
import { LOCAL_MARKER_VAR, LOCAL_URL_VAR, OPT_IN_VALUE, OPT_IN_VAR, SELECTOR_VAR, evaluateGate } from './gate.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(DIR, '../../..');
const SOURCES = ['registry.ts', 'gate.ts', 'evidence.ts', 'fixture.ts', 'r4-real-db.proofs.test.ts'];
const read = (name: string) => readFileSync(path.join(DIR, name), 'utf8');

const goodEnv = {
  [OPT_IN_VAR]: OPT_IN_VALUE,
  [SELECTOR_VAR]: 'local',
  [LOCAL_URL_VAR]: 'postgresql://synthetic:synthetic@127.0.0.1:5432/synthetic',
  [LOCAL_MARKER_VAR]: '00000000-0000-4000-8000-000000000000',
};

type Finding = { rule: string; file: string };
const ALLOWED_IMPORT = [/^node:/, /^pg$/, /^vitest$/, /^\.\//, /^\.\.\/\.\.\/scripts\/(demo-database|local-test-fingerprint|local-test-runtime)\.js$/, /^\.\.\/\.\.\/src\/generated\/prisma\/client\.js$/];

// The static gate over harness sources (also run against synthetic bad input as its own positive control).
export function scanSource(file: string, text: string): Finding[] {
  const found: Finding[] = [];
  const flag = (rule: string) => found.push({ rule, file });
  if (file !== 'gate.ts' && /(?<![A-Za-z0-9_])(?:TEST_)?DATABASE_URL/.test(text)) flag('dev-or-test-url-variable');
  if (/\b(TRUNCATE|DROP|ALTER|COPY)\b/i.test(text.replace(/\/\/.*$/gm, ''))) flag('destructive-sql');
  if (/--clean|--create|--exit-on-error|--execute|prisma\s+migrate|migrate\s+(deploy|dev|reset)/.test(text)) flag('destructive-tool-flag');
  if (file !== 'fixture.ts' && /\bDELETE\s+FROM\b/i.test(text)) flag('delete-outside-removeCanary');
  if (/\bconsole\./.test(text)) flag('console');
  if (/(JSON\.stringify|String)\(\s*process\.env\s*\)/.test(text)) flag('env-echo');
  if (/\.only\b/.test(text) || /\b(describe|it|test)\.skip\b/.test(text)) flag('only-or-skip');
  for (const m of text.matchAll(/\bfrom\s+'([^']+)'/g)) {
    if (!ALLOWED_IMPORT.some((re) => re.test(m[1] as string))) flag(`import:${m[1]}`);
  }
  const restoreCalls = [...text.matchAll(/runTool\(PG_RESTORE_LIST_ONLY,\s*\[([^\]]*)\]/g)];
  if (restoreCalls.some((m) => !(m[1] as string).includes("'--list'"))) flag('restore-without-list');
  return found;
}

describe('R4 real-DB harness integrity (DB-free)', () => {
  it('H01 registry is exactly AC-204..AC-214, ordered and unique', () => {
    expect(AC_IDS).toEqual(['AC-204', 'AC-205', 'AC-206', 'AC-207', 'AC-208', 'AC-209', 'AC-210', 'AC-211', 'AC-212', 'AC-213', 'AC-214']);
    expect(AC_CASES.map((c) => c.id)).toEqual([...AC_IDS]);
    expect(new Set(AC_CASES.map((c) => c.id)).size).toBe(11);
    for (const c of AC_CASES) {
      expect(c.topic.length).toBeGreaterThan(5);
      expect(c.invariant.length).toBeGreaterThan(20);
    }
  });

  it('H02 every implemented AC has a titled test and every title maps to a registered AC', () => {
    const proofs = read('r4-real-db.proofs.test.ts');
    for (const c of AC_CASES) {
      const pattern = c.status === 'implemented' ? `it('${c.id} ` : `it.todo('${c.id} `;
      expect(proofs.includes(pattern), c.id).toBe(true);
    }
    const titled = [...proofs.matchAll(/\bit(?:\.todo)?\('(AC-\d{3}) /g)].map((m) => m[1]);
    expect(titled).toEqual([...AC_IDS]);
  });

  it('H03 gate refuses without the exact opt-in token', () => {
    expect(evaluateGate({ ...goodEnv, [OPT_IN_VAR]: undefined }).enabled).toBe(false);
    expect(evaluateGate({ ...goodEnv, [OPT_IN_VAR]: '1' }).enabled).toBe(false);
    expect(evaluateGate({ ...goodEnv, [OPT_IN_VAR]: 'true' }).enabled).toBe(false);
  });

  it('H04 gate refuses when DATABASE_URL is present', () => {
    expect(evaluateGate({ ...goodEnv, DATABASE_URL: 'postgresql://x' }).enabled).toBe(false);
  });

  it('H05 gate refuses when TEST_DATABASE_URL is present', () => {
    expect(evaluateGate({ ...goodEnv, TEST_DATABASE_URL: 'postgresql://x' }).enabled).toBe(false);
  });

  it('H06 gate refuses a missing, hosted or junk target selector', () => {
    for (const value of [undefined, 'test', 'LOCAL', 'local ', 'dev', '']) {
      expect(evaluateGate({ ...goodEnv, [SELECTOR_VAR]: value }).enabled, String(value)).toBe(false);
    }
  });

  it('H07 gate refuses incomplete LOCAL_TEST configuration', () => {
    expect(evaluateGate({ ...goodEnv, [LOCAL_URL_VAR]: undefined }).enabled).toBe(false);
    expect(evaluateGate({ ...goodEnv, [LOCAL_MARKER_VAR]: '' }).enabled).toBe(false);
  });

  it('H08 gate opens only for the exact complete configuration', () => {
    expect(evaluateGate(goodEnv).enabled).toBe(true);
    expect(evaluateGate({ ...goodEnv, DATABASE_URL: '' }).enabled).toBe(true); // an empty value is not a target
  });

  it('H09..H15 real harness sources pass every static rule', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && f !== 'r4-real-db.harness.test.ts').sort();
    expect(files).toEqual([...SOURCES].sort());
    for (const file of SOURCES) expect(scanSource(file, read(file)), file).toEqual([]);
  });

  it('H11 evidence directory inside the repository is refused', () => {
    expect(() => assertEvidenceDirOutsideRepo(path.join(REPO_ROOT, 'api', 'evidence'), REPO_ROOT)).toThrow();
    expect(() => assertEvidenceDirOutsideRepo(REPO_ROOT, REPO_ROOT)).toThrow();
    expect(() => assertEvidenceDirOutsideRepo(path.join(REPO_ROOT, '..', 'elsewhere'), REPO_ROOT)).not.toThrow();
    expect(() => new EvidenceRecorder().flush(path.join(REPO_ROOT, 'x'), REPO_ROOT)).toThrow();
    expect(() => new EvidenceRecorder().flush(undefined, REPO_ROOT)).not.toThrow();
  });

  it('H12 evidence sanitizer rejects DSN-like strings, long values and sensitive keys', () => {
    expect(() => sanitizeEvidence({ ok: true, n: 3, s: 'short', z: null })).not.toThrow();
    expect(() => sanitizeEvidence({ note: 'postgresql://u:p@127.0.0.1:5432/db' })).toThrow();
    expect(() => sanitizeEvidence({ note: 'x'.repeat(81) })).toThrow();
    for (const key of ['password', 'passwordHash', 'dbUrl', 'userEmail', 'secret', 'auditLogBefore', 'authToken']) {
      expect(() => sanitizeEvidence({ [key]: 1 }), key).toThrow();
    }
  });

  it('H16 scanner positive control: synthetic bad sources are flagged', () => {
    const bad = [
      ['x.ts', "const u = process.env.TEST_DATABASE_URL;", 'dev-or-test-url-variable'],
      ['x.ts', "await c.query('TRUNCATE TABLE a');", 'destructive-sql'],
      ['x.ts', "await c.query('drop table a');", 'destructive-sql'],
      ['x.ts', "run('prisma migrate deploy')", 'destructive-tool-flag'],
      ['x.ts', "await c.query('DELETE FROM public.\"User\"');", 'delete-outside-removeCanary'],
      ['x.ts', 'console.log(1);', 'console'],
      ['x.ts', 'JSON.stringify(process.env)', 'env-echo'],
      ['x.ts', "it.only('a', () => {});", 'only-or-skip'],
      ['x.ts', "describe.skip('a', () => {});", 'only-or-skip'],
      ['x.ts', "import x from 'mysql2';", 'import:mysql2'],
      ['x.ts', "runTool(PG_RESTORE_LIST_ONLY, ['--clean', file], env)", 'restore-without-list'],
    ] as const;
    for (const [file, text, rule] of bad) expect(scanSource(file, text).map((f) => f.rule), text).toContain(rule);
    expect(scanSource('x.ts', "import { x } from 'vitest'; const a = 1;")).toEqual([]);
  });

  it('H17 AC-211 (restore) stays OWNER_DECISION_REQUIRED and nothing restores', () => {
    const c = AC_CASES.find((x) => x.id === 'AC-211');
    expect(c?.status).toBe('OWNER_DECISION_REQUIRED');
    expect(c?.mutation).toBe('not-implemented');
    const all = SOURCES.map(read).join('\n');
    expect(/runTool\(PG_RESTORE_LIST_ONLY,\s*\[\s*'--list'/.test(all)).toBe(true);
    expect(all.includes('--clean')).toBe(false);
    expect(AC_CASES.filter((x) => x.mutation === 'canary').map((x) => x.id)).toEqual(['AC-205', 'AC-210']);
  });

  it('H18 canary ids are prefixed, unique and synthetic', () => {
    const ids = Array.from({ length: 50 }, () => newCanaryId('ab12cd34'));
    expect(new Set(ids).size).toBe(50);
    for (const id of ids) {
      expect(id.startsWith(CANARY_PREFIX)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(36); // fits the narrowest id column used (varchar(36))
      expect(id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
