import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './config/prisma.js';
import { logger } from './shared/logger.js';

const httpServer = createServer(createApp());
const io = new Server(httpServer, { cors: { origin: env.CORS_ORIGINS } });
// Task 21 adds authenticated rooms and domain notifications to this transport.

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
});
