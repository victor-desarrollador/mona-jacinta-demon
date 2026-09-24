import { AppError } from '../../shared/errors.js';
import { logger } from '../../shared/logger.js';
import type { ReconcileResult } from './cancellation.service.js';

// Pilot P0.1-B2: opt-in in-process sweeper for expired zero-payment
// technical holds. It owns only scheduling; every release goes through the
// B1 SYSTEM entry (wall-clock owned, one Serializable transaction per Sale).
// Chained setTimeout (never setInterval): the next tick is armed only after
// the current run settles, so runs never overlap within one process. It
// keeps no process-global state; correctness across instances comes from
// B1's Sale lock + guarded ACTIVE -> RELEASED, not from this scheduler.

type TimerHandle = { unref?: () => unknown };
type ReleasedSale = ReconcileResult['released'][number];

export type ReservationSweeperOptions = {
  enabled: boolean;
  intervalMs: number;
  batchSize: number;
  release: (options: { limit: number }) => Promise<ReconcileResult>;
  onReleased?: (release: ReleasedSale) => void;
  log?: { info: (entry: object) => void; warn: (entry: object) => void; error: (entry: object) => void };
  timers?: { setTimeout: (fn: () => void, ms: number) => TimerHandle; clearTimeout: (timer: TimerHandle) => void };
};

export type ReservationSweeper = { stop(): Promise<void> };

const defaultTimers: NonNullable<ReservationSweeperOptions['timers']> = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (timer) => clearTimeout(timer as NodeJS.Timeout),
};

export function startReservationSweeper(options: ReservationSweeperOptions): ReservationSweeper {
  if (!options.enabled) return { stop: async () => undefined };
  const log = options.log ?? logger;
  const timers = options.timers ?? defaultTimers;
  let stopped = false;
  let timer: TimerHandle | undefined;
  let inFlight: Promise<void> | undefined;

  async function sweep() {
    const startedAt = Date.now();
    try {
      const result = await options.release({ limit: options.batchSize });
      for (const release of result.released) {
        try {
          options.onReleased?.(release);
        } catch {
          log.warn({ event: 'reservation_sweep_notify_failed', saleId: release.saleId });
        }
      }
      for (const failure of result.failed) {
        log.warn({ event: 'reservation_sweep_sale_failed', saleId: failure.saleId, code: failure.code });
      }
      log.info({
        event: 'reservation_sweep_completed', released: result.released.length, failed: result.failed.length,
        batchSize: options.batchSize, durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      // Only a stable application code; raw messages may carry internals.
      log.error({
        event: 'reservation_sweep_failed', code: error instanceof AppError ? error.code : 'RELEASE_FAILED',
        durationMs: Date.now() - startedAt,
      });
    }
  }

  function run() {
    timer = undefined;
    if (stopped) return;
    inFlight = sweep().finally(() => {
      inFlight = undefined;
      schedule();
    });
  }

  function schedule() {
    if (stopped) return;
    timer = timers.setTimeout(run, options.intervalMs);
    timer.unref?.();
  }

  // Boot sweep through the same path as every later tick.
  run();

  return {
    async stop() {
      stopped = true;
      if (timer) timers.clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
