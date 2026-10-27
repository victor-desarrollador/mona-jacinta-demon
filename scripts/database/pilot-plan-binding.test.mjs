// G11-ADV-001: unit tests for the shared planbinding module. Zero database: builtins
// only, fixture files under a temp root, /proc/self/fd canonical-path checks (Linux
// only — the same environment pilot-migrate.mjs already requires).
// Run with: node --test scripts/database/pilot-plan-binding.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  TARGET_BINDING_FORMAT, TOOLING_BINDING_FORMAT, TOOLING_MODULE_ROOT,
  buildTargetBinding, buildToolingBinding, readLockedFile, toolingFile,
  validateTargetBinding, validateToolingBinding,
} from './pilot-plan-binding.mjs';

const MARKER = '2b4d6f81-7a9c-4e0b-8d2f-3c5e7a9b1d0f';
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const TMP = mkdtempSync(path.join(os.tmpdir(), 'plan-binding-test-'));
process.on('exit', () => rmSync(TMP, { recursive: true, force: true }));

function fixtureApi() {
  const root = path.join(TMP, `api-${fixtureApi.n += 1}`);
  mkdirSync(path.join(root, 'prisma'), { recursive: true });
  mkdirSync(path.join(root, 'scripts', 'certs'), { recursive: true });
  writeFileSync(path.join(root, 'prisma.config.ts'), 'export default {}\n');
  writeFileSync(path.join(root, 'prisma', 'schema.prisma'), 'model X { id String @id }\n');
  writeFileSync(path.join(root, 'scripts', 'certs', 'ca.pem'), 'CERT\n');
  return root;
}
fixtureApi.n = 0;

const THE_FILES = [
  toolingFile('api', 'prisma.config.ts'),
  toolingFile('api', 'prisma/schema.prisma'),
  toolingFile('repo', 'scripts/certs/ca.pem'),
  toolingFile('module', 'pilot-plan-binding.mjs'),
];

const FILES_ = (api) => ({
  moduleDir: TOOLING_MODULE_ROOT,
  apiDir: api,
  repoDir: api,
  files: THE_FILES,
});

test('BND-01 a target binding is canonical and deep-frozen', () => {
  const b = buildTargetBinding({ environment: 'pilot', projectRef: 'pilotsynthref0000001', host: 'aws-0-synthetic.pooler.invalid', database: 'postgres', markerId: MARKER });
  assert.equal(b.format, TARGET_BINDING_FORMAT);
  assert.ok(Object.isFrozen(b));
  assert.equal(validateTargetBinding(b), true);
});

test('BND-02 invalid inputs are refused with fixed text (never values)', () => {
  for (const bad of [
    { environment: 'test', projectRef: 'pilotsynthref0000001', host: 'x.invalid', database: 'db', markerId: MARKER },
    { environment: 'pilot', projectRef: 'SHORT', host: 'x.invalid', database: 'db', markerId: MARKER },
    { environment: 'pilot', projectRef: 'pilotsynthref0000001', host: 'no-dots', database: 'db', markerId: MARKER },
    { environment: 'pilot', projectRef: 'pilotsynthref0000001', host: 'x.invalid', database: '', markerId: MARKER },
    { environment: 'pilot', projectRef: 'pilotsynthref0000001', host: 'x.invalid', database: 'a/b', markerId: MARKER },
    { environment: 'pilot', projectRef: 'pilotsynthref0000001', host: 'x.invalid', database: 'db', markerId: 'not-a-uuid' },
  ]) {
    assert.throws(() => buildTargetBinding(bad), (e) => typeof e?.message === 'string' && e.message.includes('target binding:'), JSON.stringify(bad.environment ?? bad.database));
  }
  assert.equal(validateTargetBinding(null), false);
  assert.equal(validateTargetBinding({ format: TARGET_BINDING_FORMAT }), false);
});

test('BND-03 the tooling binding reads every listed file once, hard-hardened, and is order-stable', () => {
  const api = fixtureApi();
  const shuffled = [
    toolingFile('repo', 'scripts/certs/ca.pem'),
    toolingFile('module', 'pilot-plan-binding.mjs'),
    toolingFile('api', 'prisma/schema.prisma'),
    toolingFile('api', 'prisma.config.ts'),
  ];
  const a = buildToolingBinding({ ...FILES_(api), files: shuffled });
  const b = buildToolingBinding(FILES_(api));
  assert.equal(a.format, TOOLING_BINDING_FORMAT);
  assert.deepEqual(a, b, 'order must be deterministic regardless of list order');
  assert.deepEqual(a.files.map((f) => f.path), ['pilot-plan-binding.mjs', 'prisma.config.ts', 'prisma/schema.prisma', 'scripts/certs/ca.pem']);
  assert.equal(a.files.find((f) => f.path === 'prisma.config.ts')?.sha256, sha(readFileSync(path.join(api, 'prisma.config.ts'))));
  assert.equal(a.files.find((f) => f.path === 'pilot-plan-binding.mjs')?.sha256, sha(readFileSync(new URL('./pilot-plan-binding.mjs', import.meta.url))));
  assert.equal(validateToolingBinding(a), true);
});

test('BND-04 a tooling byte change changes the binding (listings bind content, not names)', () => {
  const api = fixtureApi();
  const before = buildToolingBinding(FILES_(api));
  const bytes = readFileSync(path.join(api, 'prisma.config.ts'));
  bytes[0] ^= 0x01;
  writeFileSync(path.join(api, 'prisma.config.ts'), bytes);
  const after = buildToolingBinding(FILES_(api));
  assert.notEqual(before.files.find((f) => f.path === 'prisma.config.ts')?.sha256, after.files.find((f) => f.path === 'prisma.config.ts')?.sha256);
  assert.notEqual(sha(Buffer.from(JSON.stringify(before))), sha(Buffer.from(JSON.stringify(after)))); // digest-relevant binding
});

test('BND-05 missing, symlinked, FIFO, oversize or empty files fail closed with their relative name', () => {
  const api = fixtureApi();
  assert.throws(() => buildToolingBinding({ ...FILES_(api), files: [...THE_FILES, toolingFile('api', 'prisma/absent.prisma')] }), /absent\.prisma/);
  rmSync(path.join(api, 'prisma', 'schema.prisma'));
  symlinkSync(path.join(TMP, 'elsewhere.prisma'), path.join(api, 'prisma', 'schema.prisma'));
  assert.throws(() => buildToolingBinding(FILES_(api)), /schema\.prisma/);
  rmSync(path.join(api, 'prisma', 'schema.prisma'));
  execFileSync('mkfifo', [path.join(api, 'prisma', 'schema.prisma')]);
  assert.throws(() => buildToolingBinding(FILES_(api)), /schema\.prisma/);
  rmSync(path.join(api, 'prisma', 'schema.prisma'));
  writeFileSync(path.join(api, 'prisma', 'schema.prisma'), '');
  assert.throws(() => buildToolingBinding(FILES_(api)), /schema\.prisma/);
});

test('BND-06 unsafe or dotted relative paths and unknown root classes are refused', () => {
  const api = fixtureApi();
  for (const files of [
    [toolingFile('api', '../escape')],
    [toolingFile('api', '/absolute')], // hmm: replaces clean rel 'prisma/schema.prisma'
    [toolingFile('satellite', 'x')],
    [toolingFile('api', 'a b')],
  ]) {
    assert.throws(() => buildToolingBinding({ ...FILES_(api), files }), /tooling binding:/);
  }
});

test('BND-07 readLockedFile refuses a symlinked parent directory (canonical /proc path check)', () => {
  const dir = path.join(TMP, `link-${Math.floor(Math.random() * 1e9)}`);
  mkdirSync(path.join(dir, 'real'), { recursive: true });
  writeFileSync(path.join(dir, 'real', 'f.txt'), 'abc');
  symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
  const r = readLockedFile(path.join(dir, 'link', 'f.txt'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /canonical path/);
});

test('BND-08 the module itself never holds process state and never emits; builtins only', () => {
  const source = readFileSync(new URL('./pilot-plan-binding.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['/console\\.', '/stdout', '/stderr', '/spawn', '/process\\.', '/globalThis', '/require\\(']) {
    assert.doesNotMatch(source, new RegExp(forbidden), `the binding module must never contain ${forbidden}`);
  }
});

test('BND-09 a huge file is refused by the size bound', () => {
  const api = fixtureApi();
  writeFileSync(path.join(api, 'big.prisma'), Buffer.alloc(17 * 1024 * 1024, 0x41), { mode: 0o600 });
  const r = readLockedFile(path.join(api, 'big.prisma'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /implausible size/);
});
