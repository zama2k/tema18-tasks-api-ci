const LEVELS = { silent: 0, error: 1, info: 2, debug: 3 };

/** Minimal JSON-lines logger: one object per line, easy to ship to any log platform. */
function createLogger({ level = process.env.LOG_LEVEL || 'info', stream } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function write(name, message, fields) {
    if (LEVELS[name] > threshold) return;
    const out = stream || (name === 'error' ? process.stderr : process.stdout);
    out.write(`${JSON.stringify({ time: new Date().toISOString(), level: name, message, ...fields })}\n`);
  }

  return {
    error: (message, fields) => write('error', message, fields),
    info: (message, fields) => write('info', message, fields),
    debug: (message, fields) => write('debug', message, fields),
  };
}

module.exports = { createLogger };
