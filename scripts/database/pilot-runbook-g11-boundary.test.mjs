// G11-ADV-003 (P2): static contract for the G11 rollback boundary.
//
// Root cause: the rollback runbook placed the last guaranteed-lossless restore point at
// "the first business write of cut-over step 20", while the API process — started at
// step 18 — contains a startup writer: the reservation sweeper
// (startReservationSweeper on the listening socket, gated only by
// RESERVATION_SWEEPER_ENABLED) releases expired holds as system writes with no HTTP
// request. A restore that ignored that would silently discard sweeper writes.
//
// This test pins the corrected, conservative boundary: the guarantee ends BEFORE step 18
// (any writer-capable process start), the exception is only allowed with three recorded
// verifications (sweeper flag false, maintenance state, no non-health requests), and the
// runbooks must keep naming the real flag and its real default from the code. DB-free:
// reads two markdown runbooks and two TypeScript sources, writes nothing.
// Run with: node --test scripts/database/pilot-runbook-g11-boundary.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const read = (rel, url) => readFileSync(fileURLToPath(new URL(rel, url ?? import.meta.url)), 'utf8');
const cutover = read('../../docs/pilot-v1.1/10-g11-cutover-runbook.md');
const rollback = read('../../docs/pilot-v1.1/11-g11-rollback-runbook.md');
const serverSource = read('../../api/src/server.ts');
const envSource = read('../../api/src/config/env.ts');
const sweeperSource = read('../../api/src/modules/sales/reservation-sweeper.ts');

test('RB-1 the real startup writer is a sweeper gated by RESERVATION_SWEEPER_ENABLED, default false (runbook ↔ code contract)', () => {
  assert.match(serverSource, /startReservationSweeper/);
  assert.match(envSource, /RESERVATION_SWEEPER_ENABLED: z\.enum\(\['true', 'false'\]\)\.default\('false'\)/, 'the env flag default must stay false');
  assert.match(sweeperSource, /export/, 'the sweeper module exists');
});

test('RB-2 the rollback policy places the guaranteed-lossless restore point BEFORE the API start (step 18)', () => {
  assert.match(rollback, /guaranteed-lossless restore point/i);
  assert.match(rollback, /before step 18/i);
  assert.match(rollback, /reservation sweeper/i);
  assert.match(rollback, /RESERVATION_SWEEPER_ENABLED=false/i);
});

test('RB-3 the OLD boundary wording is gone: a first-business-write boundary must not be the restore guarantee', () => {
  assert.ok(
    !/no business write through the API at G11 has happened/i.test(rollback),
    'the superseded wording must not reappear: the old boundary ignored the startup sweeper',
  );
  for (const line of rollback.split('\n')) {
    if (/guaranteed-lossless/i.test(line)) assert.ok(!/step 20/i.test(line), `the boundary line must not name step 20: ${line.trim()}`);
  }
});

test('RB-4 the R-C restore window is conditional: the exception needs all three recorded verifications', () => {
  const policySection = rollback.slice(rollback.indexOf('## Policy'), rollback.indexOf('## Decision tree'));
  for (const required of [/RESERVATION_SWEEPER_ENABLED=false/, /maintenance state/, /no non-health HTTP request/, /FORWARD FIX/i]) {
    assert.match(policySection, required);
  }
  assert.match(policySection, /Default once step 18 has run: FORWARD FIX/i);
});

test('RB-5 the decision tree does not silently include the running API in the no-writer branch', () => {
  const table = rollback.slice(rollback.indexOf('## Decision tree'), rollback.indexOf('### R-A'));
  const rcRow = table.split('\n').find((l) => l.startsWith('| Steps 12–17'));
  assert.ok(rcRow, 'the R-C row must be the 12–17 row (conditioned)');
  assert.ok(!/12–19/.test(table), 'the R-C branch must not span step 18–19 unconditionally');
  const rdRow = table.split('\n').find((l) => l.startsWith('| Step 18 (API running)'));
  assert.ok(rdRow && /R-D/.test(rdRow), 'an API running without the exception records is R-D (default FORWARD FIX)');
});

test('RB-6 cut-over step 18 verifies the sweeper flag before the start, with a fail-closed alternative', () => {
  const step18 = cutover.slice(cutover.indexOf('18. **Start the API.**'), cutover.indexOf('19. **Client deployment.**'));
  assert.match(step18, /RESERVATION_SWEEPER_ENABLED=false/);
  assert.match(step18, /absent do NOT assume the default/);
  assert.match(step18, /PILOT_WRITER_RISK_ACCEPTED/);
  assert.match(step18, /forward-fix boundary/);
});

test('RB-7 smoke step 20 no longer claims the boundary', () => {
  const step20 = cutover.slice(cutover.indexOf('20. **Smoke test'), cutover.indexOf('21. **A4 after the smoke test'));
  assert.ok(!/The first business write of this step is the G11 write boundary/.test(step20));
  assert.match(step20, /rollback[- ]runbook/i);
  assert.match(step20, /lossless-restore guarantee ends at\s*\n?\s*step 18/);
});
