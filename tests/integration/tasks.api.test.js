const request = require('supertest');
const { createApp } = require('../../src/app');
const { createPostgresRepository } = require('../../src/models/task.model');
const { createLogger } = require('../../src/utils/logger');
const { createIsolatedDatabase } = require('./helpers/db');

describe('tasks API against a real PostgreSQL', () => {
  let database;
  let app;

  beforeAll(async () => {
    database = await createIsolatedDatabase();
    app = createApp({
      repository: createPostgresRepository(database.pool),
      version: '1.0.0',
      commit: 'integration',
      logger: createLogger({ level: 'silent' }),
    });
  });

  beforeEach(() => database.reset());

  afterAll(() => database.destroy());

  test('GET /health reports postgres as the storage engine', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'healthy', storage: 'postgres', commit: 'integration' });
  });

  test('GET /ready checks the database connection', async () => {
    const res = await request(app).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready', storage: 'postgres' });
  });

  test('GET /ready answers 503 when the database is unreachable', async () => {
    const brokenRepository = createPostgresRepository({
      query: () => Promise.reject(new Error('connection refused')),
    });
    const brokenApp = createApp({ repository: brokenRepository, logger: createLogger({ level: 'silent' }) });

    const res = await request(brokenApp).get('/ready');
    expect(res.status).toBe(503);
  });

  test('creates a task and reads it back with database-generated fields', async () => {
    const created = await request(app).post('/api/tasks').send({ title: 'Persisted', priority: 'high' });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 1, title: 'Persisted', priority: 'high', status: 'pending' });

    const fetched = await request(app).get(`/api/tasks/${created.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(created.body);
  });

  test('ids keep growing and survive deletions', async () => {
    const first = await request(app).post('/api/tasks').send({ title: 'First' });
    await request(app).delete(`/api/tasks/${first.body.id}`);
    const second = await request(app).post('/api/tasks').send({ title: 'Second' });

    expect(second.body.id).toBe(first.body.id + 1);
  });

  test('update changes only the given fields and bumps updatedAt', async () => {
    const created = await request(app).post('/api/tasks').send({ title: 'Original', priority: 'low' });
    await new Promise((resolve) => setTimeout(resolve, 15));

    const updated = await request(app).put(`/api/tasks/${created.body.id}`).send({ status: 'done' });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ title: 'Original', priority: 'low', status: 'done' });
    expect(updated.body.createdAt).toBe(created.body.createdAt);
    expect(new Date(updated.body.updatedAt).getTime()).toBeGreaterThan(new Date(created.body.updatedAt).getTime());
  });

  test('delete removes the row for good', async () => {
    const created = await request(app).post('/api/tasks').send({ title: 'Gone soon' });

    expect((await request(app).delete(`/api/tasks/${created.body.id}`)).status).toBe(204);
    expect((await request(app).get(`/api/tasks/${created.body.id}`)).status).toBe(404);
    expect((await request(app).get('/api/tasks')).body).toEqual([]);
  });

  test('unknown ids answer 404 and malformed ids answer 400 (never a database error)', async () => {
    expect((await request(app).get('/api/tasks/12345')).status).toBe(404);
    expect((await request(app).put('/api/tasks/12345').send({ status: 'done' })).status).toBe(404);
    expect((await request(app).delete('/api/tasks/12345')).status).toBe(404);
    expect((await request(app).get('/api/tasks/99999999999')).status).toBe(400);
    expect((await request(app).get("/api/tasks/1;DROP TABLE tasks")).status).toBe(400);
  });

  test('filters by status and sorts by priority using stored data', async () => {
    await request(app).post('/api/tasks').send({ title: 'low pending', priority: 'low' });
    await request(app).post('/api/tasks').send({ title: 'high done', priority: 'high', status: 'done' });
    await request(app).post('/api/tasks').send({ title: 'medium pending', priority: 'medium' });

    const pending = await request(app).get('/api/tasks').query({ status: 'pending', sort: 'priority' });

    expect(pending.body.map((t) => t.title)).toEqual(['medium pending', 'low pending']);
  });

  test('stats reflect what is stored', async () => {
    await request(app).post('/api/tasks').send({ title: 'a', status: 'done', priority: 'high' });
    await request(app).post('/api/tasks').send({ title: 'b', status: 'in_progress' });
    await request(app).post('/api/tasks').send({ title: 'c' });
    await request(app).post('/api/tasks').send({ title: 'd', status: 'done' });

    const res = await request(app).get('/api/tasks/stats');

    expect(res.body).toEqual({
      total: 4,
      byStatus: { pending: 1, in_progress: 1, done: 2 },
      byPriority: { low: 0, medium: 3, high: 1 },
      completionRate: 50,
    });
  });

  test('hostile input is stored as plain text, not executed', async () => {
    const title = "Robert'); DROP TABLE tasks;--";
    const created = await request(app).post('/api/tasks').send({ title });

    expect(created.status).toBe(201);
    const list = await request(app).get('/api/tasks');
    expect(list.body).toHaveLength(1);
    expect(list.body[0].title).toBe(title);
  });

  test('markup in the title is stripped before it reaches the database', async () => {
    const created = await request(app).post('/api/tasks').send({ title: '<img src=x onerror=alert(1)>Clean me' });
    expect(created.body.title).toBe('Clean me');
  });

  test('handles concurrent creations without losing rows', async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_unused, index) => request(app).post('/api/tasks').send({ title: `task ${index}` })),
    );

    const list = await request(app).get('/api/tasks');
    expect(list.body).toHaveLength(20);
    expect(new Set(list.body.map((t) => t.id)).size).toBe(20);
  });
});
