/** Command line entry point: `npm run db:migrate` (reads DATABASE_URL). */
const { loadConfig } = require('../config');
const { createLogger } = require('../utils/logger');
const { createPool } = require('./pool');
const { migrate } = require('./migrate');

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  if (!config.databaseUrl) {
    logger.error('DATABASE_URL is required to run migrations');
    process.exitCode = 1;
    return;
  }

  const pool = createPool(config.databaseUrl);
  try {
    const applied = await migrate(pool, { logger });
    logger.info('migrations finished', { applied: applied.length });
  } catch (error) {
    logger.error('migration run failed', { error: error.message });
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
