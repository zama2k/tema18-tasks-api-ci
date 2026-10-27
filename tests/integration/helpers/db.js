const crypto = require('node:crypto');
const { Pool } = require('pg');
const { createPool } = require('../../../src/db/pool');
const { migrate } = require('../../../src/db/migrate');

function databaseUrl() {
  const url = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'Integration tests need PostgreSQL. Start it with `docker compose up -d db` and set ' +
        'DATABASE_URL (see .env.example).',
    );
  }
  return url;
}

/**
 * Gives a test file its own schema inside the shared database, so Jest can run several
 * integration files in parallel without them seeing each other's rows.
 * `search_path` is pinned per connection, so the application code stays schema-agnostic.
 */
async function createIsolatedDatabase() {
  const url = databaseUrl();
  const schema = `it_${process.pid}_${crypto.randomBytes(4).toString('hex')}`;

  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);

  const pool = createPool(url, { options: `-c search_path=${schema}` });
  await migrate(pool);

  return {
    pool,
    schema,
    url,
    async reset() {
      await pool.query('TRUNCATE tasks RESTART IDENTITY');
    },
    async destroy() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

module.exports = { createIsolatedDatabase, databaseUrl };
