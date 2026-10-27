const { createPostgresRepository } = require('../../src/models/task.model');
const { createIsolatedDatabase } = require('./helpers/db');

describe('postgres repository against a real PostgreSQL', () => {
  let database;
  let repository;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    repository = createPostgresRepository(database.pool);
  });

  beforeEach(() => database.reset());

  afterAll(() => database.destroy());

  test('create returns the stored row with defaults applied', async () => {
    const row = await repository.create({ title: 'Stored' });

    expect(row).toMatchObject({ id: 1, title: 'Stored', description: '', status: 'pending', priority: 'medium' });
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
  });

  test('list is ordered by id', async () => {
    await repository.create({ title: 'A' });
    await repository.create({ title: 'B' });

    expect((await repository.list()).map((row) => row.title)).toEqual(['A', 'B']);
  });

  test('update with several columns persists them all', async () => {
    const { id } = await repository.create({ title: 'Before' });

    const row = await repository.update(id, { title: 'After', description: 'Detail', status: 'in_progress', priority: 'high' });

    expect(row).toMatchObject({ title: 'After', description: 'Detail', status: 'in_progress', priority: 'high' });
    expect(await repository.get(id)).toMatchObject({ title: 'After' });
  });

  test('update and remove report missing rows', async () => {
    expect(await repository.update(404, { title: 'x' })).toBeNull();
    expect(await repository.remove(404)).toBe(false);
    expect(await repository.get(404)).toBeNull();
  });

  test('the database itself rejects values the application should never send', async () => {
    await expect(database.pool.query("INSERT INTO tasks (title, status) VALUES ('x', 'bogus')")).rejects.toThrow(/check constraint/i);
    await expect(database.pool.query("INSERT INTO tasks (title, priority) VALUES ('x', 'urgent')")).rejects.toThrow(/check constraint/i);
    await expect(database.pool.query("INSERT INTO tasks (title) VALUES ('   ')")).rejects.toThrow(/check constraint/i);
  });

  test('ping succeeds with a live pool', async () => {
    await expect(repository.ping()).resolves.toBeUndefined();
  });
});
