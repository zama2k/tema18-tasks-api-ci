/**
 * Post-deploy smoke tests against a running instance (staging, a local container...).
 *
 *   node scripts/smoke.js --url https://staging.example.com
 *
 * Covers the critical path: health, readiness, UI, and a full create/read/update/stats/delete
 * cycle on /api/tasks plus the error contract (404, 400). The task it creates is always
 * deleted, even when a check fails half way.
 */
const { parseArgs, setOutput, appendSummary, annotate } = require('./lib/util');

async function runSmoke({ baseUrl, fetchImpl = fetch, requestTimeoutMs = 10000, runId = Date.now().toString(36) }) {
  const base = baseUrl.replace(/\/+$/, '');
  const results = [];
  const context = { taskId: null };

  async function call(method, path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: assertions below will say so
    }
    return { status: response.status, json, text, headers: response.headers };
  }

  function expect(condition, message) {
    if (!condition) throw new Error(message);
  }

  async function check(name, fn) {
    const startedAt = Date.now();
    try {
      await fn();
      results.push({ name, ok: true, ms: Date.now() - startedAt });
    } catch (error) {
      const cause = error.cause && error.cause.code ? ` (${error.cause.code})` : '';
      results.push({ name, ok: false, ms: Date.now() - startedAt, detail: `${error.message}${cause}` });
    }
  }

  const title = `[smoke] ${runId}`;

  await check('GET /health reports healthy', async () => {
    const res = await call('GET', '/health');
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(res.json && res.json.status === 'healthy', `status is ${res.json && res.json.status}`);
    expect(typeof res.json.commit === 'string', 'commit is missing');
  });

  await check('GET /ready reports ready', async () => {
    const res = await call('GET', '/ready');
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(res.json && res.json.status === 'ready', `status is ${res.json && res.json.status}`);
  });

  await check('GET / serves the UI', async () => {
    const res = await call('GET', '/');
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(res.text.includes('<title>Tasks</title>'), 'index.html does not look like the Tasks UI');
  });

  await check('GET /api/tasks returns a list', async () => {
    const res = await call('GET', '/api/tasks');
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(Array.isArray(res.json), 'body is not an array');
  });

  await check('POST /api/tasks creates a task', async () => {
    const res = await call('POST', '/api/tasks', { title, priority: 'low' });
    expect(res.status === 201, `expected 201, got ${res.status}`);
    expect(res.json && Number.isInteger(res.json.id), 'created task has no id');
    context.taskId = res.json.id;
  });

  await check('GET /api/tasks/:id returns what was created', async () => {
    expect(context.taskId !== null, 'skipped: the task was not created');
    const res = await call('GET', `/api/tasks/${context.taskId}`);
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(res.json.title === title, `unexpected title "${res.json.title}"`);
  });

  await check('PUT /api/tasks/:id updates the status', async () => {
    expect(context.taskId !== null, 'skipped: the task was not created');
    const res = await call('PUT', `/api/tasks/${context.taskId}`, { status: 'done' });
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(res.json.status === 'done', `status is ${res.json.status}`);
  });

  await check('GET /api/tasks/stats counts the task', async () => {
    const res = await call('GET', '/api/tasks/stats');
    expect(res.status === 200, `expected 200, got ${res.status}`);
    expect(res.json.total >= 1, `total is ${res.json.total}`);
    expect(res.json.byStatus && res.json.byStatus.done >= 1, 'no done task in the statistics');
  });

  // Cleanup runs regardless of earlier failures and is itself a check.
  await check('DELETE /api/tasks/:id removes the task', async () => {
    expect(context.taskId !== null, 'skipped: the task was not created');
    const res = await call('DELETE', `/api/tasks/${context.taskId}`);
    expect(res.status === 204, `expected 204, got ${res.status}`);
  });

  await check('GET a deleted task answers 404', async () => {
    expect(context.taskId !== null, 'skipped: the task was not created');
    const res = await call('GET', `/api/tasks/${context.taskId}`);
    expect(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check('unknown route answers a JSON 404', async () => {
    const res = await call('GET', '/api/does-not-exist');
    expect(res.status === 404, `expected 404, got ${res.status}`);
    expect(res.json && res.json.error && res.json.error.code === 'not_found', 'error body does not follow the contract');
  });

  await check('invalid id answers 400', async () => {
    const res = await call('GET', '/api/tasks/not-a-number');
    expect(res.status === 400, `expected 400, got ${res.status}`);
  });

  return { ok: results.every((r) => r.ok), results, taskId: context.taskId };
}

function renderSummary(baseUrl, outcome) {
  const rows = outcome.results.map((r) => `| ${r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.ms} ms | ${r.detail || ''} |`);
  const passed = outcome.results.filter((r) => r.ok).length;
  return [
    '### Smoke tests',
    `Target: ${baseUrl} - **${passed}/${outcome.results.length} passed**`,
    '',
    '| Result | Check | Time | Detail |',
    '|:---:|---|---:|---|',
    ...rows,
  ].join('\n');
}

async function main(argv, env = process.env) {
  const options = parseArgs(argv);
  const baseUrl = options.url || env.STAGING_URL;
  if (!baseUrl) {
    annotate.notice('STAGING_URL is not configured: skipping the smoke tests.');
    return 0;
  }

  const outcome = await runSmoke({ baseUrl });
  for (const r of outcome.results) {
    process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.ms} ms)${r.detail ? ` - ${r.detail}` : ''}\n`);
  }

  appendSummary(renderSummary(baseUrl, outcome), env);
  setOutput('checks', `${outcome.results.filter((r) => r.ok).length}/${outcome.results.length}`, env);

  if (!outcome.ok) annotate.error('Smoke tests failed');
  return outcome.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      // exitCode instead of exit(): exiting while undici closes sockets aborts libuv on Windows.
      process.exitCode = code;
    },
    (error) => {
      annotate.error(error.message);
      process.exitCode = 1;
    },
  );
}

module.exports = { runSmoke, renderSummary, main };
