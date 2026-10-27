const pkg = require('../package.json');

const TRUE_VALUES = new Set(['1', 'true', 'yes']);

/** Reads and validates the runtime configuration from environment variables. */
function loadConfig(env = process.env) {
  const rawPort = env.PORT === undefined || env.PORT === '' ? '3000' : env.PORT;
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer between 0 and 65535, received "${rawPort}"`);
  }

  return {
    port,
    databaseUrl: env.DATABASE_URL || null,
    autoMigrate: TRUE_VALUES.has(String(env.AUTO_MIGRATE || '').toLowerCase()),
    commit: env.GIT_SHA || 'unknown',
    version: pkg.version,
    logLevel: env.LOG_LEVEL || 'info',
  };
}

module.exports = { loadConfig };
