const { createPostgresRepository } = require('../../src/models/task.model');

describe('postgres repository (mocked pool)', () => {
  let pool;
  let repository;

  beforeEach(() => {
    pool = { query: jest.fn(), end: jest.fn().mockResolvedValue() };
    repository = createPostgresRepository(pool);
  });

  test('reports its storage engine', () => {
    expect(repository.storage).toBe('postgres');
  });

  test('list returns the rows ordered by id', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1 }, { id: 2 }] });

    expect(await repository.list()).toEqual([{ id: 1 }, { id: 2 }]);
    expect(pool.query.mock.calls[0][0]).toMatch(/ORDER BY id ASC/);
  });

  test('get binds the id as a parameter and returns null when missing', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: 4 }] }).mockResolvedValueOnce({ rows: [] });

    expect(await repository.get(4)).toEqual({ id: 4 });
    expect(await repository.get(5)).toBeNull();
    expect(pool.query).toHaveBeenNthCalledWith(1, expect.stringContaining('$1'), [4]);
  });

  test('create inserts with defaults filled in', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 1, title: 'T' }] });

    const created = await repository.create({ title: 'T' });

    expect(created).toEqual({ id: 1, title: 'T' });
    expect(pool.query.mock.calls[0][1]).toEqual(['T', '', 'pending', 'medium']);
  });

  test('update only sets the provided columns and always touches updated_at', async () => {
    pool.query.mockResolvedValue({ rows: [{ id: 3 }] });

    await repository.update(3, { status: 'done', priority: 'high', ignored: 'x' });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain('status = $2, priority = $3, updated_at = now()');
    expect(sql).not.toContain('ignored');
    expect(params).toEqual([3, 'done', 'high']);
  });

  test('update returns null when no row matched', async () => {
    pool.query.mockResolvedValue({ rows: [] });
    expect(await repository.update(3, { title: 'x' })).toBeNull();
  });

  test('values are never interpolated into the SQL text', async () => {
    pool.query.mockResolvedValue({ rows: [{}] });
    const hostile = "x'; DROP TABLE tasks; --";

    await repository.update(1, { title: hostile });

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toContain(hostile);
  });

  test('remove maps rowCount to a boolean', async () => {
    pool.query.mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 });

    expect(await repository.remove(1)).toBe(true);
    expect(await repository.remove(1)).toBe(false);
  });

  test('ping runs a trivial query and propagates failures', async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(new Error('down'));

    await expect(repository.ping()).resolves.toBeUndefined();
    await expect(repository.ping()).rejects.toThrow('down');
  });

  test('close ends the pool', async () => {
    await repository.close();
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});
