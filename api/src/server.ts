import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { logger } from './shared/logger.js';
import { createRealtime, REALTIME_EVENTS } from './realtime/socket.js';
import { createCancellationService } from './modules/sales/cancellation.service.js';
import { startReservationSweeper, type ReservationSweeper } from './modules/sales/reservation-sweeper.js';

const httpServer = createServer();
const { io, emitter } = createRealtime(httpServer, prisma);
httpServer.on('request', createApp(prisma, emitter));

// Pilot P0.1-B2: server runtime only (never createApp), opt-in via env.
let sweeper: ReservationSweeper | undefined;
function startSweeper() {
  const cancellation = createCancellationService(prisma);
  sweeper = startReservationSweeper({
    enabled: env.RESERVATION_SWEEPER_ENABLED,
    intervalMs: env.RESERVATION_SWEEP_INTERVAL_MS,
    batchSize: env.RESERVATION_SWEEP_BATCH_SIZE,
    release: ({ limit }) => cancellation.releaseExpiredHoldsAsSystem({ limit }),
    onReleased: (release) => emitter.emit(REALTIME_EVENTS.inventoryUpdated, release),
  });
  logger.info({ event: env.RESERVATION_SWEEPER_ENABLED ? 'reservation_sweeper_enabled' : 'reservation_sweeper_disabled' });
}

let stopping = false;
async function shutdown(exitCode: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => {
    logger.error({ event: 'shutdown_timeout' });
    process.exit(1);
  }, 10_000);
  timeout.unref();
  try {
    // Stop the sweeper (awaiting any in-flight run) before the database goes.
    await sweeper?.stop();
    await new Promise<void>((resolve) => io.close(() => resolve()));
    await prisma.$disconnect();
    process.exitCode = exitCode;
    logger.info({ event: 'server_stopped' });
  } catch {
    process.exitCode = 1;
    logger.error({ event: 'shutdown_failed' });
  } finally {
    clearTimeout(timeout);
  }
}

process.once('SIGINT', () => {
  void shutdown(0);
});
process.once('SIGTERM', () => {
  void shutdown(0);
});
httpServer.once('error', () => {
  logger.error({ event: 'server_error' });
  void shutdown(1);
});
httpServer.listen(env.API_PORT, () => {
  logger.info({ event: 'server_started', port: env.API_PORT });
  if (!stopping) startSweeper();
});
