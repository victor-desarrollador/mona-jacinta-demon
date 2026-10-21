#!/usr/bin/env node
// module-cycles: WARN-ONLY report of dependency cycles between API domain
// modules (api/src/modules/<name>).
//
//   npm run deps:modules
//   dependency-cruiser ... --collapse "^api/src/modules/[^/]+" --output-type json api/src \
//     | node scripts/dev/module-cycles.mjs [--fail-on-new] [--baseline <file>]
//
// WHY A SCRIPT: dependency-cruiser decides `circular` on the file graph BEFORE
// folders are collapsed, so a module-level cycle (sales -> inventory -> sales)
// cannot be a `forbidden` rule: two acyclic files can still make two modules
// depend on each other. This reads the collapsed graph and finds strongly
// connected components of modules.
//
// SEMANTICS: a cycle already listed in the baseline is KNOWN legacy debt and is
// only counted. A cycle that is not in the baseline is reported as a warning.
// The exit code is 0 either way (warn mode) unless --fail-on-new is given, so
// this never breaks CI by itself. Output is deterministic: sorted, one line per
// cycle, then one summary line.
//
// Reads the dependency-cruiser JSON from stdin and the baseline from
// scripts/dev/module-cycles.baseline.json (a JSON array of module-name arrays).

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_PREFIX = 'api/src/modules/';
const DEFAULT_BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'module-cycles.baseline.json');

const moduleOf = (source) => {
  if (typeof source !== 'string' || !source.startsWith(MODULE_PREFIX)) return null;
  const name = source.slice(MODULE_PREFIX.length).split('/')[0];
  return name === '' ? null : name;
};

// Module dependency graph from a dependency-cruiser result: edges between
// DIFFERENT modules only. Works on collapsed and on uncollapsed output.
export function buildModuleGraph(cruiseResult) {
  const graph = new Map();
  const ensure = (name) => {
    if (!graph.has(name)) graph.set(name, new Set());
    return graph.get(name);
  };
  for (const entry of cruiseResult?.modules ?? []) {
    const from = moduleOf(entry.source);
    if (from === null) continue;
    ensure(from);
    for (const dependency of entry.dependencies ?? []) {
      const to = moduleOf(dependency.resolved);
      if (to !== null && to !== from) {
        ensure(from).add(to);
        ensure(to);
      }
    }
  }
  return graph;
}

// Strongly connected components with more than one module (Tarjan, iterative
// order is irrelevant because the result is sorted).
export function findModuleCycles(graph) {
  let counter = 0;
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const cycles = [];

  const visit = (node) => {
    index.set(node, counter);
    low.set(node, counter);
    counter += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of [...(graph.get(node) ?? [])].sort()) {
      if (!index.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), index.get(next)));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      if (component.length > 1) cycles.push(component.sort());
    }
  };

  for (const node of [...graph.keys()].sort()) {
    if (!index.has(node)) visit(node);
  }
  return cycles.sort((a, b) => a.join(',').localeCompare(b.join(',')));
}

// Splits cycles into KNOWN (identical member set in the baseline) and NEW.
export function classifyCycles(cycles, baseline) {
  const known = new Set((baseline ?? []).map((cycle) => [...cycle].sort().join(',')));
  const result = { known: [], fresh: [] };
  for (const cycle of cycles) {
    (known.has(cycle.join(',')) ? result.known : result.fresh).push(cycle);
  }
  return result;
}

export function report(cruiseResult, baseline) {
  const cycles = findModuleCycles(buildModuleGraph(cruiseResult));
  const { known, fresh } = classifyCycles(cycles, baseline);
  const lines = fresh.map((cycle) => `  warn module-cycle: ${cycle.join(' <-> ')}`);
  lines.push(`module cycles: ${fresh.length} new, ${known.length} known (baseline)`);
  return { lines, known, fresh };
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

function main(argv) {
  const failOnNew = argv.includes('--fail-on-new');
  const baselineFlag = argv.indexOf('--baseline');
  const baselinePath = baselineFlag >= 0 ? argv[baselineFlag + 1] : DEFAULT_BASELINE;
  let cruiseResult;
  try {
    cruiseResult = JSON.parse(readStdin());
  } catch {
    process.stderr.write('module-cycles: stdin is not dependency-cruiser JSON\n');
    return 2;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const { lines, fresh } = report(cruiseResult, baseline);
  process.stdout.write(`${lines.join('\n')}\n`);
  return failOnNew && fresh.length > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = main(process.argv.slice(2));
}
