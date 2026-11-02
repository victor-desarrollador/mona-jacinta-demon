import { createServer, type RequestListener, type Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.js';
import { env, type Env } from './config/env.js';
import { prisma } from './config/prisma.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { logger } from './shared/logger.js';
import { createRealtime, REALTIME_EVENTS } from './realtime/socket.js';
import { createCancellationService } from './modules/sales/cancellation.service.js';
import { startReservationSweeper, type ReservationSweeper } from './modules/sales/reservation-sweeper.js';
import { R3ReadinessError, assertR3Ready, createPrismaR3ReadinessClient, r3FeaturesFromEnv } from './modules/payments/checkout-readiness.js';

// R3-A4.3 S9 — the minimal, injectable startup seam. The readiness gate is
// awaited BEFORE the socket is bound, so when an R3 feature is enabled and the
// database is not ready the server never accepts a connection (OPTION A:
// abort startup, no polling, no retry). With both R3 flags off the gate is a
// no-op and reads nothing. Exported so the DB-free suite proves the ordering
// without a driver.
export type StartupHttpServer = {
  listen: (port: number, callback: () => void) => unknown;
};
export type StartupLogger = {
  info: (entry: Record<string, unknown>) => void;
  error: (entry: Record<string, unknown>) => void;
};
export type StartServerDependencies = {
  httpServer: StartupHttpServer;
  env: Pick<Env, 'API_PORT'>;
  logger: StartupLogger;
  assertReady: () => Promise<void>;
  onListening?: () => void;
};

export async function startServer(dependencies: StartServerDependencies): Promise<void> {
  // Throws before listen when the gate fails; the caller owns the exit path.
  await dependencies.assertReady();
  dependencies.httpServer.listen(dependencies.env.API_PORT, () => {
    dependencies.logger.info({ event: 'server_started', port: dependencies.env.API_PORT });
    dependencies.onListening?.();
  });
}

let io: ReturnType<typeof createRealtime>['io'] | undefined;
let emitter: ReturnType<typeof createRealtime>['emitter'] | undefined;
let sweeper: ReservationSweeper | undefined;
let stopping = false;

function startSweeper() {
  const cancellation = createCancellationService(prisma);
  sweeper = startReservationSweeper({
    enabled: env.RESERVATION_SWEEPER_ENABLED,
    intervalMs: env.RESERVATION_SWEEP_INTERVAL_MS,
    batchSize: env.RESERVATION_SWEEP_BATCH_SIZE,
    release: ({ limit }) => cancellation.releaseExpiredHoldsAsSystem({ limit }),
    onReleased: (release) => {
      emitter?.emit(REALTIME_EVENTS.inventoryUpdated, release);
    },
  });
  logger.info({ event: env.RESERVATION_SWEEPER_ENABLED ? 'reservation_sweeper_enabled' : 'reservation_sweeper_disabled' });
}

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
    if (io) await new Promise<void>((resolve) => io!.close(() => resolve()));
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

// A fixed-shape failure entry: a refused R3 gate reports only its stable code,
// its closed reason and public migration/object names. Any other startup error
// is reported by event only. A driver message, a URL or a credential is never
// read and never logged. Exported so the DB-free suite can prove the log shape.
export function startupFailureEntry(error: unknown): Record<string, unknown> {
  if (error instanceof R3ReadinessError) {
    return { event: 'r3_startup_gate_failed', code: error.code, reason: error.reason, migrations: error.migrations, objects: error.objects };
  }
  return { event: 'startup_failed' };
}

// U4.1 — the ONE place the HTTP server, Express and Socket.IO are put together.
//
// ORDER MATTERS. Engine.IO's attach() snapshots the 'request' listeners that exist AT THAT MOMENT, removes them, and installs a single dispatcher: a
// request under /socket.io/ goes to Engine.IO ONLY, every other request is replayed to the snapshotted listeners. A listener added AFTER attach() is
// not in the snapshot: it is a sibling that receives EVERY request, /socket.io/ polling included, so Express answered (404) requests Engine.IO was
// already answering — ERR_HTTP_HEADERS_SENT, and a 404 racing the long-poll. Hence the request listener is installed BEFORE Socket.IO attaches. Express
// itself needs the emitter and the session revoker that Socket.IO creates, so the listener installed first is a thin late-bound delegate to the app.
// (WebSocket upgrades never use the 'request' event: Engine.IO's own 'upgrade' listener serves /socket.io/ and closes foreign upgrades.)
export function assembleServer(
  database: PrismaClient,
  makeApp: typeof createApp = createApp,
): { server: HttpServer; realtime: ReturnType<typeof createRealtime> } {
  const late: { app?: RequestListener } = {};
  const server = createServer((req, res) => {
    if (late.app) {
      late.app(req, res);
      return;
    }
    res.statusCode = 503; // only reachable if a request arrives between createServer and the line below: both run synchronously in one tick
    res.end();
  });
  const realtime = createRealtime(server, database);
  late.app = makeApp(database, realtime.emitter, realtime.sessionRevoker);
  return { server, realtime };
}

async function main(): Promise<void> {
  const { server, realtime } = assembleServer(prisma);
  io = realtime.io;
  emitter = realtime.emitter;
  server.once('error', () => {
    logger.error({ event: 'server_error' });
    void shutdown(1);
  });
  process.once('SIGINT', () => {
    void shutdown(0);
  });
  process.once('SIGTERM', () => {
    void shutdown(0);
  });
  await startServer({
    httpServer: server,
    env,
    logger,
    // Validate the database BEFORE binding the socket (env is already parsed).
    assertReady: () => assertR3Ready(createPrismaR3ReadinessClient(prisma), r3FeaturesFromEnv(env)),
    onListening: () => {
      if (!stopping) startSweeper();
    },
  });
}

// Only the real process entry starts the server. Importing this module (the
// DB-free startup test) performs no I/O and binds no socket.
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void main().catch((error) => {
    logger.error(startupFailureEntry(error));
    void shutdown(1);
  });
}
