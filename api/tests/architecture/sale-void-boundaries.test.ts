// Sale void v1 — module boundaries (static, database-free). dependency-cruiser's `modules-via-public-index` rule says a
// domain module consumes another module only through that module's index.ts. The ~90 historical violations are ignored by
// .dependency-cruiser-known-violations.json; the sale void files introduce NONE: every cross-module import they make goes
// through a public index, and the cash module exposes exactly the two pure helpers the void needs (nothing else of cash.service).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MODULES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'modules');
const FILES = ['sales/sale-void.service.ts', 'sales/sale-void.controller.ts', 'sales/dto/void-sale.dto.ts'];

const importsOf = (file: string) => {
  const text = readFileSync(path.join(MODULES, file), 'utf8');
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/g)].map((m) => m[1] as string);
};

describe('sale void v1 — cross-module imports go through public indexes', () => {
  it.each(FILES)('BD01 %s imports another domain module only through its index', (file) => {
    const own = file.split('/')[0]!;
    for (const specifier of importsOf(file)) {
      if (!specifier.startsWith('.')) continue;
      const target = path.normalize(path.join(path.dirname(path.join(MODULES, file)), specifier));
      const relative = path.relative(MODULES, target);
      if (relative.startsWith('..')) continue; // shared/, realtime/, generated/: not domain modules
      const [module] = relative.split(path.sep);
      if (module === own) continue;
      expect(path.basename(relative), `${file} -> ${specifier}`).toMatch(/^index\.(js|ts)$/);
    }
  });

  it('BD02 the cash module has a minimal public index: exactly the two pure helpers the void reuses', () => {
    const index = readFileSync(path.join(MODULES, 'cash', 'index.ts'), 'utf8');
    const names = [...index.matchAll(/export\s*\{([^}]*)\}\s*from\s*'\.\/cash\.service\.js'/g)]
      .flatMap((m) => (m[1] as string).split(',').map((n) => n.trim()).filter(Boolean)).sort();
    expect(names).toEqual(['projectExpectedCash', 'reconciliationRefusal']);
    expect(index).not.toMatch(/export\s*\*/);
  });

  it('BD03 the public index re-exports the very functions the service uses (no duplicated logic)', async () => {
    const viaIndex = await import('../../src/modules/cash/index.js');
    const direct = await import('../../src/modules/cash/cash.service.js');
    expect(viaIndex.projectExpectedCash).toBe(direct.projectExpectedCash);
    expect(viaIndex.reconciliationRefusal).toBe(direct.reconciliationRefusal);
  });
});
