import assert from 'node:assert/strict';
import test from 'node:test';
import { buildModuleGraph, classifyCycles, findModuleCycles, report } from './module-cycles.mjs';

const mod = (source, ...targets) => ({
  source: `api/src/modules/${source}`,
  dependencies: targets.map((target) => ({ resolved: `api/src/modules/${target}` })),
});

test('detects a two-module cycle and ignores acyclic dependencies', () => {
  const graph = buildModuleGraph({ modules: [mod('sales', 'inventory', 'rbac'), mod('inventory', 'sales', 'rbac'), mod('rbac')] });
  assert.deepEqual(findModuleCycles(graph), [['inventory', 'sales']]);
});

test('detects a three-module cycle as ONE component', () => {
  const graph = buildModuleGraph({ modules: [mod('a', 'b'), mod('b', 'c'), mod('c', 'a'), mod('d', 'a')] });
  assert.deepEqual(findModuleCycles(graph), [['a', 'b', 'c']]);
});

test('works on uncollapsed paths: files of one module never form a cycle with themselves', () => {
  const graph = buildModuleGraph({
    modules: [
      { source: 'api/src/modules/payments/a.ts', dependencies: [{ resolved: 'api/src/modules/payments/b.ts' }] },
      { source: 'api/src/modules/payments/b.ts', dependencies: [{ resolved: 'api/src/modules/payments/a.ts' }] },
    ],
  });
  assert.deepEqual(findModuleCycles(graph), []);
});

test('ignores sources and targets outside api/src/modules', () => {
  const graph = buildModuleGraph({
    modules: [
      { source: 'api/src/shared/audit.ts', dependencies: [{ resolved: 'api/src/modules/rbac/permissions.ts' }] },
      mod('rbac', 'rbac'),
    ],
  });
  assert.deepEqual(findModuleCycles(graph), []);
});

test('a baselined cycle is known; any other cycle is new', () => {
  const cycles = [['inventory', 'sales'], ['cash', 'payments']];
  assert.deepEqual(classifyCycles(cycles, [['sales', 'inventory']]), {
    known: [['inventory', 'sales']],
    fresh: [['cash', 'payments']],
  });
});

test('report is deterministic and only lists NEW cycles as warnings', () => {
  const input = { modules: [mod('sales', 'inventory'), mod('inventory', 'sales'), mod('cash', 'payments'), mod('payments', 'cash')] };
  const first = report(input, [['inventory', 'sales']]);
  const second = report(input, [['inventory', 'sales']]);
  assert.deepEqual(first, second);
  assert.deepEqual(first.lines, ['  warn module-cycle: cash <-> payments', 'module cycles: 1 new, 1 known (baseline)']);
});

test('empty input yields an empty report', () => {
  assert.deepEqual(report({ modules: [] }, []).lines, ['module cycles: 0 new, 0 known (baseline)']);
});
