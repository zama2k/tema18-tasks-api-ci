const request = require('supertest');
const { createApp } = require('../../src/app');
const { createMemoryRepository } = require('../../src/models/task.model');
const { createLogger } = require('../../src/utils/logger');

const silent = createLogger({ level: 'silent' });

function buildApp(repository = createMemoryRepository()) {
  return createApp({ repository, version: '9.9.9', commit: 'abc1234', logger: silent });
}

describe('createApp', () => {
  test('requires a repository', () => {
    expect(() => createApp({})).toThrow(TypeError);
  });
});

describe('operational endpoints', () => {
  test('GET /health reports status, version, commit and storage', async () => {
    const res = await request(buildApp()).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: 'healthy',
      version: '9.9.9',
      commit: 'abc1234',
      storage: 'memory',
    });
    expect(typeof res.body.uptime).toBe('number');
  });

  test('does not advertise the framework', async () => {
    const res = await request(buildApp()).get('/health');
    expect(res.headers).not.toHaveProperty('x-powered-by');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('GET /ready is 200 when the storage answers', async () => {
    const res = await request(buildApp()).get('/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
  });

  test('GET /ready is 503 without leaking the cause when the storage is down', async () => {
    const repository = createMemoryRepository();
    repository.ping = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

    const res = await request(buildApp(repository)).get('/ready');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('unavailable');
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
  });
});

describe('tasks API', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  const createTask = (body) => request(app).post('/api/tasks').send(body);

  test('GET /api/tasks starts empty', async () => {
    const res = await request(app).get('/api/tasks');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('POST /api/tasks creates a task and returns 201 with Location', async () => {
    const res = await createTask({ title: 'Learn CI', priority: 'high' });

    expect(res.status).toBe(201);
    expect(res.headers.location).toBe('/api/tasks/1');
    expect(res.body).toMatchObject({ id: 1, title: 'Learn CI', priority: 'high', status: 'pending' });
    expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
  });

  test('POST /api/tasks answers 400 with field details for invalid data', async () => {
    const res = await createTask({ title: '', priority: 'urgent' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
    expect(res.body.error.details.map((d) => d.field)).toEqual(['title', 'priority']);
  });

  test('POST /api/tasks answers 400 for malformed JSON', async () => {
    const res = await request(app).post('/api/tasks').set('Content-Type', 'application/json').send('{"title": ');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/valid JSON/);
  });

  test('POST /api/tasks answers 400 when the body is missing entirely', async () => {
    const res = await request(app).post('/api/tasks');
    expect(res.status).toBe(400);
  });

  test('POST /api/tasks answers 413 for oversized payloads', async () => {
    const res = await createTask({ title: 'ok', description: 'x'.repeat(200 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('payload_too_large');
  });

  test('GET /api/tasks/:id returns one task', async () => {
    await createTask({ title: 'Find me' });
    const res = await request(app).get('/api/tasks/1');

    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Find me');
  });

  test('GET /api/tasks/:id answers 404 for an unknown task', async () => {
    const res = await request(app).get('/api/tasks/404');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  test.each(['abc', '0', '-3', '1.5', '99999999999'])('GET /api/tasks/%s answers 400', async (id) => {
    const res = await request(app).get(`/api/tasks/${id}`);
    expect(res.status).toBe(400);
  });

  test('PUT /api/tasks/:id updates only the given fields', async () => {
    await createTask({ title: 'Original', priority: 'low' });
    const res = await request(app).put('/api/tasks/1').send({ status: 'done' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: 'Original', priority: 'low', status: 'done' });
  });

  test('PUT /api/tasks/:id answers 404 and 400 appropriately', async () => {
    expect((await request(app).put('/api/tasks/9').send({ status: 'done' })).status).toBe(404);
    await createTask({ title: 'T' });
    expect((await request(app).put('/api/tasks/1').send({})).status).toBe(400);
    expect((await request(app).put('/api/tasks/1').send({ status: 'nope' })).status).toBe(400);
  });

  test('DELETE /api/tasks/:id answers 204 and then 404', async () => {
    await createTask({ title: 'Temporary' });

    expect((await request(app).delete('/api/tasks/1')).status).toBe(204);
    expect((await request(app).delete('/api/tasks/1')).status).toBe(404);
    expect((await request(app).get('/api/tasks')).body).toEqual([]);
  });

  test('filters by status and rejects invalid filters', async () => {
    await createTask({ title: 'A' });
    await createTask({ title: 'B', status: 'done' });

    const done = await request(app).get('/api/tasks').query({ status: 'done' });
    expect(done.body.map((t) => t.title)).toEqual(['B']);

    expect((await request(app).get('/api/tasks').query({ status: 'bogus' })).status).toBe(400);
    expect((await request(app).get('/api/tasks?status=done&status=pending')).status).toBe(400);
  });

  test('sorts by priority and rejects other sort keys', async () => {
    await createTask({ title: 'Low', priority: 'low' });
    await createTask({ title: 'High', priority: 'high' });
    await createTask({ title: 'Medium', priority: 'medium' });

    const sorted = await request(app).get('/api/tasks').query({ sort: 'priority' });
    expect(sorted.body.map((t) => t.title)).toEqual(['High', 'Medium', 'Low']);

    expect((await request(app).get('/api/tasks').query({ sort: 'title' })).status).toBe(400);
  });

  test('GET /api/tasks/stats is not shadowed by the :id route', async () => {
    await createTask({ title: 'A', status: 'done' });
    await createTask({ title: 'B' });

    const res = await request(app).get('/api/tasks/stats');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, completionRate: 50 });
    expect(res.body.byStatus).toEqual({ pending: 1, in_progress: 0, done: 1 });
  });
});

describe('error handling', () => {
  test('unknown routes answer a JSON 404', async () => {
    const res = await request(buildApp()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error.code).toBe('not_found');
  });

  test('unexpected failures answer 500 without leaking internals', async () => {
    const repository = createMemoryRepository();
    repository.list = jest.fn().mockRejectedValue(new Error('password authentication failed for user "secret"'));
    const logger = { error: jest.fn(), info: jest.fn(), debug: jest.fn() };
    const app = createApp({ repository, logger });

    const res = await request(app).get('/api/tasks');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: { code: 'internal_error', message: 'internal server error' } });
    expect(JSON.stringify(res.body)).not.toContain('secret');
    expect(logger.error).toHaveBeenCalledWith('unhandled error', expect.objectContaining({ path: '/api/tasks' }));
  });
});

describe('static UI', () => {
  test('serves the single page app at /', async () => {
    const res = await request(buildApp()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('Tasks');
  });
});
