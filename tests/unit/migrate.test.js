const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { migrate, MIGRATIONS_DIR } = require('../../src/db/migrate');

function fakePool({ applied = [], failOn } = {}) {
  const calls = [];
  const client = {
    query: jest.fn(async (sql, params) => {
      calls.push({ sql: String(sql).trim().split(/\s+/).slice(0, 3).join(' '), params });
      if (String(sql).includes('SELECT version')) return { rows: applied.map((version) => ({ version })) };
      if (failOn && String(sql).includes(failOn)) throw new Error('syntax error');
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return { pool: { connect: jest.fn().mockResolvedValue(client) }, client, calls };
}

describe('migrate', () => {
  let directory;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'migrations-'));
    await fs.writeFile(path.join(directory, '002_second.sql'), 'CREATE TABLE second ();');
    await fs.writeFile(path.join(directory, '001_first.sql'), 'CREATE TABLE first ();');
    await fs.writeFile(path.join(directory, 'README.txt'), 'not a migration');
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  test('applies pending files in lexical order, each inside a transaction', async () => {
    const { pool, calls, client } = fakePool();

    const applied = await migrate(pool, { directory });

    expect(applied).toEqual(['001_first.sql', '002_second.sql']);
    const statements = calls.map((c) => c.sql);
    expect(statements.filter((s) => s === 'BEGIN')).toHaveLength(2);
    expect(statements.filter((s) => s === 'COMMIT')).toHaveLength(2);
    expect(statements.indexOf('CREATE TABLE first')).toBeLessThan(statements.indexOf('CREATE TABLE second'));
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('skips versions that are already recorded', async () => {
    const { pool } = fakePool({ applied: ['001_first.sql'] });

    expect(await migrate(pool, { directory })).toEqual(['002_second.sql']);
  });

  test('is a no-op when everything is applied', async () => {
    const { pool } = fakePool({ applied: ['001_first.sql', '002_second.sql'] });

    expect(await migrate(pool, { directory })).toEqual([]);
  });

  test('rolls back, names the failing file and still releases the client and the lock', async () => {
    const { pool, calls, client } = fakePool({ failOn: 'CREATE TABLE second' });

    await expect(migrate(pool, { directory })).rejects.toThrow('migration 002_second.sql failed: syntax error');

    const statements = calls.map((c) => c.sql);
    expect(statements).toContain('ROLLBACK');
    expect(statements[statements.length - 1]).toBe('SELECT pg_advisory_unlock($1)');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  test('logs each applied migration', async () => {
    const { pool } = fakePool();
    const logger = { info: jest.fn() };

    await migrate(pool, { directory, logger });

    expect(logger.info).toHaveBeenCalledWith('migration applied', { file: '001_first.sql' });
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  test('ships at least the initial schema migration', async () => {
    const files = await fs.readdir(MIGRATIONS_DIR);
    expect(files).toContain('001_create_tasks.sql');
  });
});
