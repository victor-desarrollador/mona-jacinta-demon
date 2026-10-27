import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Evidence is a flat list of non-sensitive facts (booleans, numbers, short enums). No row data, no DSN, no secrets.
export type EvidenceValue = string | number | boolean | null;
const FORBIDDEN_KEY = /pass(word)?|secret|token|email|dsn|url|hash(?!_ok)|credential|audit/i;
const DSN_LIKE = /postgres(ql)?:\/\/|:\/\/[^\s/]*:[^\s/]*@/i;
const MAX_STRING = 80;

export function sanitizeEvidence(facts: Readonly<Record<string, EvidenceValue>>): Record<string, EvidenceValue> {
  const out: Record<string, EvidenceValue> = {};
  for (const [key, value] of Object.entries(facts)) {
    if (FORBIDDEN_KEY.test(key)) throw new Error('evidence key refused');
    if (typeof value === 'string' && (DSN_LIKE.test(value) || value.length > MAX_STRING)) throw new Error('evidence value refused');
    out[key] = value;
  }
  return out;
}

export function assertEvidenceDirOutsideRepo(dir: string, repoRoot: string): string {
  const resolved = path.resolve(dir);
  const root = path.resolve(repoRoot);
  if (resolved === root || resolved.startsWith(root + path.sep)) throw new Error('evidence directory must be outside the repository');
  return resolved;
}

export class EvidenceRecorder {
  private readonly entries: { id: string; facts: Record<string, EvidenceValue> }[] = [];
  record(id: string, facts: Readonly<Record<string, EvidenceValue>>): void {
    this.entries.push({ id, facts: sanitizeEvidence(facts) });
  }
  snapshot(): readonly { id: string; facts: Record<string, EvidenceValue> }[] {
    return this.entries;
  }
  flush(dir: string | undefined, repoRoot: string): void {
    if (!dir) return;
    const target = assertEvidenceDirOutsideRepo(dir, repoRoot);
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(target, 'r4-real-db-evidence.json'), `${JSON.stringify(this.entries, null, 2)}\n`, { mode: 0o600 });
  }
}

// Synthetic canary identifiers: prefixed, unique, never a real-looking value.
export const CANARY_PREFIX = 'r4-canary-';
let canaryCounter = 0;
export function newCanaryId(nonce: string): string {
  canaryCounter += 1;
  return `${CANARY_PREFIX}${nonce}-${canaryCounter}`;
}
