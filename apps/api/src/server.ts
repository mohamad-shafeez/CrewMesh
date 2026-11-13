import { buildApp } from './app.js';
import { getEnv } from './config/env.js';
import { closeDbPool } from './db/pool.js';

async function startServer(): Promise<void> {
  const env = getEnv();
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'Received shutdown signal; closing HTTP server and DB pool');
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
