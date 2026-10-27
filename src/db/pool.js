const { Pool } = require('pg');

/** Creates a connection pool. `options` are merged over the defaults (used by tests). */
function createPool(connectionString, options = {}) {
  const pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    ...options,
  });

  // An idle client can fail (network blip, DB restart). Without a listener Node would crash.
  pool.on('error', (error) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', message: 'idle pg client error', error: error.message })}\n`);
  });

  return pool;
}

module.exports = { createPool };
