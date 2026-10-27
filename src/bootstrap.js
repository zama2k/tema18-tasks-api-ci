const { createApp } = require('./app');
const { createMemoryRepository, createPostgresRepository } = require('./models/task.model');
const { createPool } = require('./db/pool');
const { migrate } = require('./db/migrate');

/** Picks PostgreSQL when DATABASE_URL is set, in-memory storage otherwise. */
async function createRepository(config, { logger, poolFactory = createPool, migrateFn = migrate } = {}) {
  if (!config.databaseUrl) {
    logger.info('DATABASE_URL not set: using in-memory storage');
    return createMemoryRepository();
  }

  const pool = poolFactory(config.databaseUrl);
  if (config.autoMigrate) {
    try {
      await migrateFn(pool, { logger });
    } catch (error) {
      await pool.end();
      throw error;
    }
  }
  return createPostgresRepository(pool);
}

// Express 5 hands listen errors (EADDRINUSE...) to the callback instead of only emitting 'error'.
function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, (error) => (error ? reject(error) : resolve(server)));
  });
}

/**
 * Graceful shutdown: stop accepting connections, let in-flight requests finish,
 * close the database pool, then exit. A deadline prevents hanging forever.
 */
function registerShutdown({
  server,
  repository,
  logger,
  processRef = process,
  timeoutMs = 10000,
  signals = ['SIGTERM', 'SIGINT'],
}) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown started', { signal });

    const deadline = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit', { timeoutMs });
      processRef.exit(1);
    }, timeoutMs);
    deadline.unref();

    try {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections?.();
      });
      await repository.close();
      clearTimeout(deadline);
      logger.info('shutdown complete');
      processRef.exit(0);
    } catch (error) {
      clearTimeout(deadline);
      logger.error('shutdown failed', { error: error.message });
      processRef.exit(1);
    }
  }

  for (const signal of signals) processRef.on(signal, () => shutdown(signal));
  return shutdown;
}

async function start(config, { logger, ...overrides }) {
  const repository = await createRepository(config, { logger, ...overrides });
  const app = createApp({ repository, version: config.version, commit: config.commit, logger });
  const server = await listen(app, config.port);
  logger.info('server listening', {
    port: server.address().port,
    storage: repository.storage,
    commit: config.commit,
  });
  registerShutdown({ server, repository, logger });
  return { app, server, repository };
}

module.exports = { createRepository, registerShutdown, start };
