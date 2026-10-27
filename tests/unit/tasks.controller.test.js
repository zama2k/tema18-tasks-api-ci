const {
  formatTask,
  filterByStatus,
  sortByPriority,
  calculateStats,
  createTasksController,
} = require('../../src/controllers/tasks.controller');
const { HttpError } = require('../../src/utils/errors');

const task = (overrides = {}) => ({
  id: 1,
  title: 'Task',
  description: '',
  status: 'pending',
  priority: 'medium',
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  ...overrides,
});

describe('formatTask', () => {
  test('maps a database row to the public shape', () => {
    const raw = {
      id: '7',
      title: 'Write docs',
      description: null,
      status: 'done',
      priority: 'low',
      created_at: new Date('2026-02-03T04:05:06.000Z'),
      updated_at: '2026-02-04T00:00:00Z',
    };

    expect(formatTask(raw)).toEqual({
      id: 7,
      title: 'Write docs',
      description: '',
      status: 'done',
      priority: 'low',
      createdAt: '2026-02-03T04:05:06.000Z',
      updatedAt: '2026-02-04T00:00:00.000Z',
    });
  });

  test('does not leak unknown columns', () => {
    const raw = { id: 1, title: 'x', status: 'pending', priority: 'low', created_at: new Date(0), updated_at: new Date(0), secret: 'no' };
    expect(formatTask(raw)).not.toHaveProperty('secret');
  });
});

describe('filterByStatus', () => {
  const tasks = [task({ id: 1, status: 'pending' }), task({ id: 2, status: 'done' }), task({ id: 3, status: 'done' })];

  test('returns only the matching tasks', () => {
    expect(filterByStatus(tasks, 'done').map((t) => t.id)).toEqual([2, 3]);
  });

  test('returns every task when no status is given', () => {
    expect(filterByStatus(tasks, undefined)).toBe(tasks);
  });

  test('returns an empty list when nothing matches', () => {
    expect(filterByStatus(tasks, 'in_progress')).toEqual([]);
  });
});

describe('sortByPriority', () => {
  test('orders high, medium, low', () => {
    const sorted = sortByPriority([
      task({ id: 1, priority: 'low' }),
      task({ id: 2, priority: 'high' }),
      task({ id: 3, priority: 'medium' }),
    ]);
    expect(sorted.map((t) => t.priority)).toEqual(['high', 'medium', 'low']);
  });

  test('breaks ties by creation date and then by id', () => {
    const sorted = sortByPriority([
      task({ id: 3, createdAt: '2026-01-02T00:00:00.000Z' }),
      task({ id: 2, createdAt: '2026-01-01T00:00:00.000Z' }),
      task({ id: 1, createdAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(sorted.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  test('does not mutate the input array', () => {
    const input = [task({ id: 1, priority: 'low' }), task({ id: 2, priority: 'high' })];
    const snapshot = [...input];
    sortByPriority(input);
    expect(input).toEqual(snapshot);
  });
});

describe('calculateStats', () => {
  test('counts by status and priority and computes the completion rate', () => {
    const stats = calculateStats([
      task({ status: 'done', priority: 'high' }),
      task({ status: 'done', priority: 'low' }),
      task({ status: 'pending', priority: 'low' }),
    ]);

    expect(stats).toEqual({
      total: 3,
      byStatus: { pending: 1, in_progress: 0, done: 2 },
      byPriority: { low: 2, medium: 0, high: 1 },
      completionRate: 66.7,
    });
  });

  test('is all zeros for an empty list (no division by zero)', () => {
    expect(calculateStats([])).toEqual({
      total: 0,
      byStatus: { pending: 0, in_progress: 0, done: 0 },
      byPriority: { low: 0, medium: 0, high: 0 },
      completionRate: 0,
    });
  });
});

describe('createTasksController handlers', () => {
  const rawRow = (overrides = {}) => ({
    id: 1,
    title: 'Stored',
    description: '',
    status: 'pending',
    priority: 'medium',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  });

  const fakeResponse = () => {
    const res = {};
    res.json = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    res.location = jest.fn().mockReturnValue(res);
    res.end = jest.fn().mockReturnValue(res);
    return res;
  };

  const fakeRepository = () => ({
    list: jest.fn().mockResolvedValue([]),
    get: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
  });

  test('list rejects an unknown status filter before touching the repository', async () => {
    const repository = fakeRepository();
    const controller = createTasksController(repository);

    await expect(controller.list({ query: { status: 'later' } }, fakeResponse())).rejects.toMatchObject({
      status: 400,
    });
    expect(repository.list).not.toHaveBeenCalled();
  });

  test('list rejects an unsupported sort key', async () => {
    const controller = createTasksController(fakeRepository());
    await expect(controller.list({ query: { sort: 'title' } }, fakeResponse())).rejects.toBeInstanceOf(HttpError);
  });

  test('list filters and sorts the formatted tasks', async () => {
    const repository = fakeRepository();
    repository.list.mockResolvedValue([
      rawRow({ id: 1, status: 'done', priority: 'low' }),
      rawRow({ id: 2, status: 'done', priority: 'high' }),
      rawRow({ id: 3, status: 'pending', priority: 'high' }),
    ]);
    const res = fakeResponse();

    await createTasksController(repository).list({ query: { status: 'done', sort: 'priority' } }, res);

    expect(res.json.mock.calls[0][0].map((t) => t.id)).toEqual([2, 1]);
  });

  test('get answers 404 when the repository finds nothing', async () => {
    const repository = fakeRepository();
    repository.get.mockResolvedValue(null);

    await expect(createTasksController(repository).get({ params: { id: '5' } }, fakeResponse())).rejects.toMatchObject({
      status: 404,
    });
    expect(repository.get).toHaveBeenCalledWith(5);
  });

  test('get answers 400 for an invalid id without querying storage', async () => {
    const repository = fakeRepository();

    await expect(createTasksController(repository).get({ params: { id: 'abc' } }, fakeResponse())).rejects.toMatchObject({
      status: 400,
    });
    expect(repository.get).not.toHaveBeenCalled();
  });

  test('create stores the sanitized payload and answers 201 with a Location header', async () => {
    const repository = fakeRepository();
    repository.create.mockResolvedValue(rawRow({ id: 9, title: 'Clean' }));
    const res = fakeResponse();

    await createTasksController(repository).create({ body: { title: ' <b>Clean</b> ' } }, res);

    expect(repository.create).toHaveBeenCalledWith({
      title: 'Clean',
      description: '',
      priority: 'medium',
      status: 'pending',
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.location).toHaveBeenCalledWith('/api/tasks/9');
  });

  test('create exposes every validation error in the details', async () => {
    const controller = createTasksController(fakeRepository());
    const error = await controller.create({ body: { priority: 'x' } }, fakeResponse()).catch((e) => e);

    expect(error.status).toBe(400);
    expect(error.details.map((d) => d.field)).toEqual(['title', 'priority']);
  });

  test('update answers 404 when the task does not exist', async () => {
    const repository = fakeRepository();
    repository.update.mockResolvedValue(null);

    await expect(
      createTasksController(repository).update({ params: { id: '3' }, body: { status: 'done' } }, fakeResponse()),
    ).rejects.toMatchObject({ status: 404 });
  });

  test('remove answers 204 on success and 404 when nothing was deleted', async () => {
    const repository = fakeRepository();
    const controller = createTasksController(repository);
    const res = fakeResponse();

    repository.remove.mockResolvedValueOnce(true);
    await controller.remove({ params: { id: '2' } }, res);
    expect(res.status).toHaveBeenCalledWith(204);

    repository.remove.mockResolvedValueOnce(false);
    await expect(controller.remove({ params: { id: '2' } }, fakeResponse())).rejects.toMatchObject({ status: 404 });
  });
});
