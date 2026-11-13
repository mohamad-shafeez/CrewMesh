import { buildApp } from './app.js';
import { getEnv } from './config/env.js';
import { checkDatabaseReadiness, closeDbPool } from './db/pool.js';

async function startServer(): Promise<void> {
  const env = getEnv();

  // Fail fast at startup if PostgreSQL is unreachable
  const dbReady = await checkDatabaseReadiness();
  if (!dbReady.ready) {
    throw new Error(
      `Database readiness check failed at server startup: ${dbReady.error ?? 'Unknown DB error'}`,
    );
  }

  const app = await buildApp();
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'Received shutdown signal; closing SSE streams, HTTP server, and DB pool');
    try {
      await app.close();
      await closeDbPool();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'Error during graceful shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ host: env.HOST, port: env.PORT });
}

startServer().catch((err) => {
  console.error(
    JSON.stringify({
      error: 'SERVER_STARTUP_FAILED',
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  process.exit(1);
});
