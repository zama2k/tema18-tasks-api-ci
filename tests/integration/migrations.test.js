const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Pool } = require('pg');
const { createPool } = require('../../src/db/pool');
const { migrate } = require('../../src/db/migrate');
const { databaseUrl } = require('./helpers/db');

const run = promisify(execFile);

describe('migrations against a real PostgreSQL', () => {
  const schema = `it_mig_${process.pid}`;
  let admin;
  let pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl(), max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = createPool(databaseUrl(), { options: `-c search_path=${schema}` });
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  test('applies the schema once and records it', async () => {
    const first = await migrate(pool);
    const second = await migrate(pool);

    expect(first).toEqual(['001_create_tasks.sql']);
    expect(second).toEqual([]);

    const { rows } = await pool.query('SELECT version FROM schema_migrations');
    expect(rows).toEqual([{ version: '001_create_tasks.sql' }]);
  });

  test('creates the tasks table with the expected columns', async () => {
    const { rows } = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'tasks' ORDER BY ordinal_position`,
      [schema],
    );
    expect(rows.map((row) => row.column_name)).toEqual([
      'id',
      'title',
      'description',
      'status',
      'priority',
      'created_at',
      'updated_at',
    ]);
  });

  test('concurrent runners are serialized by the advisory lock', async () => {
    const racing = `${schema}_race`;
    await admin.query(`CREATE SCHEMA ${racing}`);
    const racers = Array.from({ length: 4 }, () => createPool(databaseUrl(), { options: `-c search_path=${racing}` }));

    try {
      const results = await Promise.all(racers.map((racer) => migrate(racer)));
      const appliedCount = results.reduce((sum, applied) => sum + applied.length, 0);
      expect(appliedCount).toBe(1);
    } finally {
      await Promise.all(racers.map((racer) => racer.end()));
      await admin.query(`DROP SCHEMA ${racing} CASCADE`);
    }
  });

  test('a failing migration is rolled back and nothing is recorded', async () => {
    const broken = `${schema}_broken`;
    await admin.query(`CREATE SCHEMA ${broken}`);
    const brokenPool = createPool(databaseUrl(), { options: `-c search_path=${broken}` });
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'broken-migrations-'));
    await fs.writeFile(path.join(directory, '001_partial.sql'), 'CREATE TABLE half_done (id int); SELECT * FROM missing_table;');

    try {
      await expect(migrate(brokenPool, { directory })).rejects.toThrow(/001_partial.sql failed/);

      const tables = await admin.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'half_done'",
        [broken],
      );
      expect(tables.rows).toEqual([]);
      const recorded = await brokenPool.query('SELECT version FROM schema_migrations');
      expect(recorded.rows).toEqual([]);
    } finally {
      await brokenPool.end();
      await admin.query(`DROP SCHEMA ${broken} CASCADE`);
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  test('npm run db:migrate entry point applies migrations from DATABASE_URL', async () => {
    const cliSchema = `${schema}_cli`;
    await admin.query(`CREATE SCHEMA ${cliSchema}`);
    const url = new URL(databaseUrl());
    url.searchParams.set('options', `-c search_path=${cliSchema}`);

    try {
      const { stdout } = await run(process.execPath, [path.join(__dirname, '../../src/db/cli.js')], {
        env: { ...process.env, DATABASE_URL: url.toString(), LOG_LEVEL: 'info' },
      });

      expect(stdout).toContain('migrations finished');
      const { rows } = await admin.query(`SELECT version FROM ${cliSchema}.schema_migrations`);
      expect(rows).toEqual([{ version: '001_create_tasks.sql' }]);
    } finally {
      await admin.query(`DROP SCHEMA ${cliSchema} CASCADE`);
    }
  });

  test('the CLI exits with a non-zero code when DATABASE_URL is missing', async () => {
    const env = { ...process.env, LOG_LEVEL: 'info' };
    delete env.DATABASE_URL;

    await expect(run(process.execPath, [path.join(__dirname, '../../src/db/cli.js')], { env })).rejects.toMatchObject({
      code: 1,
    });
  });
});
