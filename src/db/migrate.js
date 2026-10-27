const fs = require('node:fs/promises');
const path = require('node:path');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
// Arbitrary constant: serializes concurrent migrators (several replicas booting at once).
const ADVISORY_LOCK_ID = 18_000_001;

/**
 * Applies the pending `*.sql` files in lexical order, each one in its own transaction.
 * Applied versions are recorded in `schema_migrations`. Returns the files applied by this call.
 */
async function migrate(pool, { directory = MIGRATIONS_DIR, logger } = {}) {
  const files = (await fs.readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const client = await pool.connect();
  const applied = [];

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version    text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const done = new Set(rows.map((row) => row.version));

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(directory, file), 'utf8');

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${error.message}`, { cause: error });
      }

      applied.push(file);
      if (logger) logger.info('migration applied', { file });
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {});
    client.release();
  }

  return applied;
}

module.exports = { migrate, MIGRATIONS_DIR };
