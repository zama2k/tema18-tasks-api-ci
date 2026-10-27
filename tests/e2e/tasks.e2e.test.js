const { test, expect } = require('@playwright/test');

const EXPECTED_STORAGE = process.env.DATABASE_URL ? 'postgres' : 'memory';

async function clearTasks(request) {
  const response = await request.get('/api/tasks');
  for (const task of await response.json()) {
    await request.delete(`/api/tasks/${task.id}`);
  }
}

test.beforeEach(async ({ request }) => {
  await clearTasks(request);
});

test.describe('UI', () => {
  test('shows the empty state on a clean database', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle('Tasks');
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible();
    await expect(page.getByText('No tasks yet.')).toBeVisible();
    await expect(page.locator('#stats')).toHaveText('0 total, 0 done (0%)');
  });

  test('creates a task from the form and lists it with its priority', async ({ page }) => {
    await page.goto('/');

    await page.getByLabel('Title').fill('Write the pipeline');
    await page.getByLabel('Priority').selectOption('high');
    await page.getByRole('button', { name: 'Add task' }).click();

    const item = page.getByTestId('task-item');
    await expect(item).toHaveCount(1);
    await expect(item).toContainText('Write the pipeline');
    await expect(item).toContainText('high');
    await expect(item).toContainText('pending');
    await expect(page.getByLabel('Title')).toBeEmpty();
    await expect(page.locator('#stats')).toHaveText('1 total, 0 done (0%)');
  });

  test('shows the validation message returned by the API for an empty title', async ({ page }) => {
    await page.goto('/');

    await page.getByRole('button', { name: 'Add task' }).click();

    await expect(page.getByRole('alert')).toContainText('title must be a text of 1 to 120 characters');
    await expect(page.getByTestId('task-item')).toHaveCount(0);
  });

  test('completes a task and updates the statistics', async ({ page, request }) => {
    await request.post('/api/tasks', { data: { title: 'Ship it' } });
    await page.goto('/');

    await page.getByRole('button', { name: 'Complete' }).click();

    const item = page.getByTestId('task-item');
    await expect(item).toHaveAttribute('data-status', 'done');
    await expect(page.getByRole('button', { name: 'Complete' })).toHaveCount(0);
    await expect(page.locator('#stats')).toHaveText('1 total, 1 done (100%)');
  });

  test('deletes a task', async ({ page, request }) => {
    await request.post('/api/tasks', { data: { title: 'Disposable' } });
    await page.goto('/');
    await expect(page.getByTestId('task-item')).toHaveCount(1);

    await page.getByRole('button', { name: 'Delete' }).click();

    await expect(page.getByTestId('task-item')).toHaveCount(0);
    await expect(page.getByText('No tasks yet.')).toBeVisible();
  });

  test('filters the list by status', async ({ page, request }) => {
    await request.post('/api/tasks', { data: { title: 'Open item' } });
    await request.post('/api/tasks', { data: { title: 'Closed item', status: 'done' } });
    await page.goto('/');
    await expect(page.getByTestId('task-item')).toHaveCount(2);

    await page.getByLabel('Show').selectOption('done');

    await expect(page.getByTestId('task-item')).toHaveCount(1);
    await expect(page.getByTestId('task-item')).toContainText('Closed item');
  });

  test('renders user text as text, never as markup', async ({ page, request }) => {
    await request.post('/api/tasks', { data: { title: '<b>bold</b> <img src=x onerror=window.__pwned=1>text' } });
    await page.goto('/');

    const item = page.getByTestId('task-item');
    await expect(item).toContainText('bold text');
    await expect(item.locator('b, img')).toHaveCount(0);
    expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
  });

  test('keeps the data after a page reload', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Title').fill('Survives reload');
    await page.getByRole('button', { name: 'Add task' }).click();
    await expect(page.getByTestId('task-item')).toHaveCount(1);

    await page.reload();

    await expect(page.getByTestId('task-item')).toContainText('Survives reload');
  });
});

test.describe('API', () => {
  test('GET /health reports the running build and the storage engine', async ({ request }) => {
    const response = await request.get('/health');

    expect(response.ok()).toBeTruthy();
    expect(await response.json()).toMatchObject({ status: 'healthy', commit: 'e2e', storage: EXPECTED_STORAGE });
  });

  test('serves the full CRUD lifecycle', async ({ request }) => {
    const created = await request.post('/api/tasks', { data: { title: 'Lifecycle', priority: 'low' } });
    expect(created.status()).toBe(201);
    const { id } = await created.json();

    const updated = await request.put(`/api/tasks/${id}`, { data: { status: 'in_progress' } });
    expect(await updated.json()).toMatchObject({ id, title: 'Lifecycle', status: 'in_progress' });

    expect((await request.get(`/api/tasks/${id}`)).ok()).toBeTruthy();
    expect((await request.delete(`/api/tasks/${id}`)).status()).toBe(204);
    expect((await request.get(`/api/tasks/${id}`)).status()).toBe(404);
  });

  test('answers 400 with details for invalid payloads and ids', async ({ request }) => {
    const invalid = await request.post('/api/tasks', { data: { title: '', priority: 'urgent' } });
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error.details).toHaveLength(2);

    expect((await request.get('/api/tasks/not-a-number')).status()).toBe(400);
  });

  test('computes statistics and sorting from stored data', async ({ request }) => {
    await request.post('/api/tasks', { data: { title: 'low', priority: 'low' } });
    await request.post('/api/tasks', { data: { title: 'high', priority: 'high', status: 'done' } });

    const stats = await (await request.get('/api/tasks/stats')).json();
    expect(stats).toMatchObject({ total: 2, completionRate: 50 });

    const sorted = await (await request.get('/api/tasks?sort=priority')).json();
    expect(sorted.map((task) => task.title)).toEqual(['high', 'low']);
  });

  test('sends security headers and hides the framework', async ({ request }) => {
    const response = await request.get('/health');
    const headers = response.headers();

    expect(headers['x-powered-by']).toBeUndefined();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toContain("default-src 'self'");
  });
});
