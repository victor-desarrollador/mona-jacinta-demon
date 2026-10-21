// System V2 architecture guard: api/src must not introduce new day bucketing
// that depends on the server time zone (Date.prototype.setHours). The rule is
// configured in api/.eslintrc.cjs; this test proves it fires where it must and
// stays silent where it must not. DB-free: it only runs ESLint on strings.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const apiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function lint(code: string, filePath: string) {
  const eslint = new ESLint({ cwd: apiRoot, overrideConfigFile: path.join(apiRoot, '.eslintrc.cjs') });
  const [result] = await eslint.lintText(code, { filePath: path.join(apiRoot, filePath) });
  return result!.messages;
}

describe('setHours guard (api/src)', () => {
  it('rejects setHours() in api/src', async () => {
    const messages = await lint('export const a = (d: Date) => d.setHours(0, 0, 0, 0);\n', 'src/modules/example/example.service.ts');
    expect(messages.map((m) => m.ruleId)).toEqual(['no-restricted-syntax']);
    expect(messages[0]!.message).toContain('operating-time');
  });

  it('rejects setHours() reached through any receiver', async () => {
    const messages = await lint('export const a = (x: { d: Date }) => x.d.setHours(23);\n', 'src/shared/example.ts');
    expect(messages.map((m) => m.ruleId)).toEqual(['no-restricted-syntax']);
  });

  it('allows an explicitly justified legacy use', async () => {
    const code = '// eslint-disable-next-line no-restricted-syntax -- legacy\nexport const a = (d: Date) => d.setHours(0);\n';
    expect(await lint(code, 'src/modules/example/legacy.ts')).toEqual([]);
  });

  it('does not flag other Date members (no false positives)', async () => {
    const code = 'export const a = (d: Date) => [d.setUTCHours(1), d.getHours(), d.setDate(2)];\n';
    expect(await lint(code, 'src/modules/example/other.ts')).toEqual([]);
  });

  it('is scoped to api/src: tests may still use setHours', async () => {
    expect(await lint('export const a = (d: Date) => d.setHours(0);\n', 'tests/example.test.ts')).toEqual([]);
  });
});
