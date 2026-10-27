/** Process entry point: the only file that opens a port and listens to signals. */
const { loadConfig } = require('./config');
const { createLogger } = require('./utils/logger');
const { start } = require('./bootstrap');

async function main() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel });

  try {
    await start(config, { logger });
  } catch (error) {
    logger.error('failed to start', { error: error.message });
    process.exit(1);
  }
}

main();
