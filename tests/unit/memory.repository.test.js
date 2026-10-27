const { createMemoryRepository } = require('../../src/models/task.model');

describe('memory repository', () => {
  let clock;
  let repository;

  beforeEach(() => {
    clock = new Date('2026-03-01T00:00:00.000Z');
    repository = createMemoryRepository({ now: () => clock });
  });

  test('reports its storage engine', () => {
    expect(repository.storage).toBe('memory');
  });

  test('create assigns incremental ids, defaults and timestamps', async () => {
    const first = await repository.create({ title: 'One' });
    const second = await repository.create({ title: 'Two', priority: 'high' });

    expect(first).toEqual({
      id: 1,
      title: 'One',
      description: '',
      status: 'pending',
      priority: 'medium',
      created_at: clock,
      updated_at: clock,
    });
    expect(second.id).toBe(2);
    expect(second.priority).toBe('high');
  });

  test('never reuses the id of a deleted task', async () => {
    await repository.create({ title: 'One' });
    await repository.remove(1);
    const next = await repository.create({ title: 'Two' });
    expect(next.id).toBe(2);
  });

  test('get returns a copy, so callers cannot mutate the stored task', async () => {
    await repository.create({ title: 'One' });
    const copy = await repository.get(1);
    copy.title = 'changed';
    expect((await repository.get(1)).title).toBe('One');
  });

  test('get returns null for an unknown id', async () => {
    expect(await repository.get(99)).toBeNull();
  });

  test('list returns every task in creation order', async () => {
    await repository.create({ title: 'A' });
    await repository.create({ title: 'B' });
    expect((await repository.list()).map((t) => t.title)).toEqual(['A', 'B']);
  });

  test('update merges the patch, bumps updated_at and ignores unknown columns', async () => {
    await repository.create({ title: 'One' });
    clock = new Date('2026-03-02T00:00:00.000Z');

    const updated = await repository.update(1, { status: 'done', id: 50, hacked: true });

    expect(updated.status).toBe('done');
    expect(updated.id).toBe(1);
    expect(updated).not.toHaveProperty('hacked');
    expect(updated.created_at).toEqual(new Date('2026-03-01T00:00:00.000Z'));
    expect(updated.updated_at).toEqual(clock);
  });

  test('update returns null for an unknown id', async () => {
    expect(await repository.update(5, { status: 'done' })).toBeNull();
  });

  test('remove reports whether something was deleted', async () => {
    await repository.create({ title: 'One' });
    expect(await repository.remove(1)).toBe(true);
    expect(await repository.remove(1)).toBe(false);
    expect(await repository.list()).toEqual([]);
  });

  test('ping and close resolve', async () => {
    await expect(repository.ping()).resolves.toBeUndefined();
    await expect(repository.close()).resolves.toBeUndefined();
  });
});
