import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { startReservationSweeper, type ReservationSweeperOptions } from '../../src/modules/sales/reservation-sweeper.js';

// Pilot P0.1-B2: DB-free lifecycle tests for the opt-in expired-hold sweeper.
// Timers are an injected seam, so every tick is fired explicitly: no real
// clock, no sleeps, no database.
type FakeTimer = { fn: () => void; ms: number; unref: Mock<() => void>; cleared: boolean };

function harness(overrides: Partial<ReservationSweeperOptions> = {}) {
  const timers: FakeTimer[] = [];
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const release = vi.fn(async (_options: { limit: number }) => ({ released: [], failed: [] }) as Awaited<ReturnType<ReservationSweeperOptions['release']>>);
  const onReleased = vi.fn();
  const options: ReservationSweeperOptions = {
    enabled: true,
    intervalMs: 60000,
    batchSize: 25,
    release,
    onReleased,
    log,
    timers: {
      setTimeout: (fn, ms) => {
        const timer: FakeTimer = { fn, ms, unref: vi.fn<() => void>(), cleared: false };
        timers.push(timer);
        return timer;
      },
      clearTimeout: (timer) => { (timer as FakeTimer).cleared = true; },
    },
    ...overrides,
  };
  const live = () => timers.filter((timer) => !timer.cleared);
  const fire = async () => {
    const [next] = live();
    if (!next) throw new Error('no pending timer');
    next.cleared = true;
    next.fn();
    await settle();
  };
  return { options, timers, live, fire, log, release, onReleased };
}

// Drains queued promise callbacks; not a sleep.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('reservation sweeper lifecycle (Pilot P0.1-B2)', () => {
  it('is inert when disabled: no run, no timer, stop is a no-op', async () => {
    const h = harness({ enabled: false });
    const sweeper = startReservationSweeper(h.options);
    await settle();
    expect(h.release).not.toHaveBeenCalled();
    expect(h.timers).toHaveLength(0);
    await sweeper.stop();
  });

  it('runs one boot sweep immediately, passing exactly { limit: batchSize } and no clock', async () => {
    const h = harness();
    const sweeper = startReservationSweeper(h.options);
    await settle();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.release.mock.calls[0]![0]).toEqual({ limit: 25 });
    await sweeper.stop();
  });

  it('schedules the next tick only after a run completes, with intervalMs, unref\'d', async () => {
    const h = harness();
    const sweeper = startReservationSweeper(h.options);
    await settle();
    expect(h.live()).toHaveLength(1);
    expect(h.live()[0]!.ms).toBe(60000);
    expect(h.live()[0]!.unref).toHaveBeenCalled();
    await h.fire();
    expect(h.release).toHaveBeenCalledTimes(2);
    expect(h.live()).toHaveLength(1);
    await sweeper.stop();
  });

  it('never overlaps: a slow run leaves no timer armed until it settles', async () => {
    const h = harness();
    const slow = deferred<{ released: never[]; failed: never[] }>();
    h.release.mockImplementationOnce(() => slow.promise);
    const sweeper = startReservationSweeper(h.options);
    await settle();
    expect(h.live()).toHaveLength(0);
    expect(h.release).toHaveBeenCalledTimes(1);
    slow.resolve({ released: [], failed: [] });
    await settle();
    expect(h.live()).toHaveLength(1);
    await sweeper.stop();
  });

  it('survives a throwing run with a safe error log and keeps scheduling', async () => {
    const h = harness();
    h.release
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED postgres://user:secret@db.internal'))
      .mockRejectedValueOnce(new AppError(503, 'SYSTEM_ACTOR_UNAVAILABLE', 'x'));
    const sweeper = startReservationSweeper(h.options);
    await settle();
    await h.fire();
    await h.fire();
    const errors = h.log.error.mock.calls.map(([entry]) => entry);
    expect(errors).toEqual([
      expect.objectContaining({ event: 'reservation_sweep_failed', code: 'RELEASE_FAILED' }),
      expect.objectContaining({ event: 'reservation_sweep_failed', code: 'SYSTEM_ACTOR_UNAVAILABLE' }),
    ]);
    expect(JSON.stringify(h.log.error.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(h.log.error.mock.calls)).not.toContain('ECONNREFUSED');
    expect(h.release).toHaveBeenCalledTimes(3);
    expect(h.live()).toHaveLength(1);
    await sweeper.stop();
  });

  it('logs one safe warning per failed Sale and notifies only committed releases', async () => {
    const h = harness();
    const committed = { saleId: 's-ok', branchId: 'b-1', quantities: [{ variantId: 'v-1', quantity: 2n }] };
    h.release.mockResolvedValueOnce({ released: [committed], failed: [{ saleId: 's-bad', code: 'INVALID_RESERVATION' }] });
    const sweeper = startReservationSweeper(h.options);
    await settle();
    expect(h.log.warn.mock.calls.map(([entry]) => entry)).toEqual([
      { event: 'reservation_sweep_sale_failed', saleId: 's-bad', code: 'INVALID_RESERVATION' },
    ]);
    expect(h.onReleased.mock.calls).toEqual([[committed]]);
    expect(h.log.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'reservation_sweep_completed', released: 1, failed: 1, batchSize: 25, durationMs: expect.any(Number),
    }));
    await sweeper.stop();
  });

  it('keeps sweeping when a realtime notification throws', async () => {
    const h = harness({ onReleased: () => { throw new Error('socket down'); } });
    h.release.mockResolvedValueOnce({ released: [{ saleId: 's', branchId: 'b', quantities: [] }], failed: [] });
    const sweeper = startReservationSweeper(h.options);
    await settle();
    expect(h.log.warn).toHaveBeenCalledWith({ event: 'reservation_sweep_notify_failed', saleId: 's' });
    expect(h.live()).toHaveLength(1);
    await sweeper.stop();
  });

  it('stop before the next tick clears it; a late callback still never runs', async () => {
    const h = harness();
    const sweeper = startReservationSweeper(h.options);
    await settle();
    const [pending] = h.live();
    await sweeper.stop();
    expect(pending!.cleared).toBe(true);
    pending!.fn();
    await settle();
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.live()).toHaveLength(0);
  });

  it('stop during an in-flight run awaits it and schedules nothing after', async () => {
    const h = harness();
    const slow = deferred<{ released: never[]; failed: never[] }>();
    h.release.mockImplementationOnce(() => slow.promise);
    const sweeper = startReservationSweeper(h.options);
    await settle();
    let stopped = false;
    const stopping = sweeper.stop().then(() => { stopped = true; });
    await settle();
    expect(stopped).toBe(false);
    slow.resolve({ released: [], failed: [] });
    await stopping;
    expect(stopped).toBe(true);
    expect(h.live()).toHaveLength(0);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('holds no process-global state: two instances run and stop independently', async () => {
    const a = harness();
    const b = harness();
    const sweeperA = startReservationSweeper(a.options);
    const sweeperB = startReservationSweeper(b.options);
    await settle();
    await sweeperA.stop();
    await b.fire();
    expect(a.release).toHaveBeenCalledTimes(1);
    expect(b.release).toHaveBeenCalledTimes(2);
    expect(b.live()).toHaveLength(1);
    await sweeperB.stop();
  });
});

describe('reservation sweeper runtime wiring (Pilot P0.1-B2, static)', () => {
  const source = (path: string) => readFileSync(new URL(`../../src/${path}`, import.meta.url), 'utf8');

  it('createApp never starts the sweeper (supertest builds no timers)', () => {
    expect(source('app.ts')).not.toMatch(/reservation-sweeper|startReservationSweeper/);
  });

  it('the server starts it from env opt-in and stops it before prisma.$disconnect()', () => {
    const server = source('server.ts');
    expect(server).toContain('startReservationSweeper(');
    expect(server).toContain('enabled: env.RESERVATION_SWEEPER_ENABLED');
    expect(server).toContain('releaseExpiredHoldsAsSystem(');
    const stop = server.indexOf('await sweeper?.stop()');
    const disconnect = server.indexOf('await prisma.$disconnect()');
    expect(stop).toBeGreaterThan(-1);
    expect(stop).toBeLessThan(disconnect);
  });
});
