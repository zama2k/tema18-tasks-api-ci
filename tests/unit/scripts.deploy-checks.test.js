const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../../src/app');
const { createMemoryRepository } = require('../../src/models/task.model');
const { createLogger } = require('../../src/utils/logger');
const { waitForHealth, main: healthMain } = require('../../scripts/wait-for-health');
const { runSmoke, renderSummary, main: smokeMain } = require('../../scripts/smoke');
const { backoffDelay, parseArgs, redact, setOutput, appendSummary } = require('../../scripts/lib/util');

const noSleep = () => Promise.resolve();

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const close = (server) => new Promise((resolve) => server.close(resolve));

describe('util', () => {
  test('backoffDelay doubles and is capped', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => backoffDelay(n, 3000, 30000))).toEqual([3000, 6000, 12000, 24000, 30000, 30000]);
  });

  test('parseArgs reads pairs and rejects dangling flags or positional values', () => {
    expect(parseArgs(['--a', '1', '--b', '2'])).toEqual({ a: '1', b: '2' });
    expect(() => parseArgs(['--a'])).toThrow(/invalid argument/);
    expect(() => parseArgs(['positional', 'x'])).toThrow(/invalid argument/);
  });

  test('redact hides every secret occurrence and ignores empty secrets', () => {
    expect(redact('token abc and abc again', ['abc', undefined, ''])).toBe('token *** and *** again');
  });

  test('setOutput and appendSummary are no-ops outside GitHub Actions', () => {
    expect(() => setOutput('x', 1, {})).not.toThrow();
    expect(() => appendSummary('x', {})).not.toThrow();
  });
});

describe('waitForHealth', () => {
  const healthy = (commit) => ({ ok: true, status: 200, json: async () => ({ status: 'healthy', commit }) });

  test('returns on the first healthy answer with the expected commit', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(healthy('abc1234'));

    const result = await waitForHealth({ url: 'https://s.test/', expectedCommit: 'abc1234', fetchImpl, sleepFn: noSleep });

    expect(result.attempts).toBe(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://s.test/health', expect.any(Object));
  });

  test('keeps retrying with growing delays while the service is cold (connection errors, 503)', async () => {
    const delays = [];
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce(healthy('abc'));

    const result = await waitForHealth({
      url: 'https://s.test',
      expectedCommit: 'abc',
      fetchImpl,
      sleepFn: async (ms) => delays.push(ms),
    });

    expect(result.attempts).toBe(3);
    expect(delays).toEqual([3000, 6000]);
  });

  test('does not accept a healthy answer from the previous version', async () => {
    const log = jest.fn();
    const fetchImpl = jest.fn().mockResolvedValue(healthy('oldoldold'));

    await expect(
      waitForHealth({ url: 'https://s.test', expectedCommit: 'newnewnew', attempts: 3, fetchImpl, sleepFn: noSleep, log }),
    ).rejects.toThrow(/not healthy after 3 attempts \(last: serving commit oldold/);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('previous version still live?'));
  });

  test('without an expected commit any healthy answer is enough', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(healthy('whatever'));
    await expect(waitForHealth({ url: 'https://s.test', fetchImpl, sleepFn: noSleep })).resolves.toMatchObject({ attempts: 1 });
  });

  test.each([
    ['a non JSON placeholder page', { ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }, /not JSON/],
    ['an unhealthy status', { ok: true, status: 200, json: async () => ({ status: 'degraded' }) }, /status is "degraded"/],
    ['an HTTP error', { ok: false, status: 502 }, /HTTP 502/],
  ])('reports %s', async (_label, response, pattern) => {
    await expect(
      waitForHealth({ url: 'https://s.test', attempts: 1, fetchImpl: async () => response, sleepFn: noSleep }),
    ).rejects.toThrow(pattern);
  });

  test('reports request timeouts distinctly', async () => {
    const timeout = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    await expect(
      waitForHealth({ url: 'https://s.test', attempts: 1, fetchImpl: async () => { throw timeout; }, sleepFn: noSleep }),
    ).rejects.toThrow(/no answer \(timeout\)/);
  });

  test('main skips with a notice when no URL is configured', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await healthMain([], {})).toBe(0);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('::notice::'));
    } finally {
      write.mockRestore();
    }
  });
});

describe('smoke tests against the real application', () => {
  let server;
  let url;

  beforeAll(async () => {
    const app = createApp({ repository: createMemoryRepository(), commit: 'smoke', logger: createLogger({ level: 'silent' }) });
    ({ server, url } = await listen(app));
  });

  afterAll(() => close(server));

  test('every check passes and the created task is cleaned up', async () => {
    const outcome = await runSmoke({ baseUrl: url, runId: 'test' });

    expect(outcome.results.filter((r) => !r.ok)).toEqual([]);
    expect(outcome.results.length).toBeGreaterThanOrEqual(12);
    const list = await (await fetch(`${url}/api/tasks`)).json();
    expect(list).toEqual([]);
  });

  test('main prints one line per check, writes outputs and exits 0', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'));
    const env = { GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'sum') };
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await smokeMain(['--url', url], env)).toBe(0);
      expect(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8')).toMatch(/passed=true/);
      expect(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('### Smoke tests');
    } finally {
      write.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('main skips with a notice when no URL is configured', async () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await smokeMain([], {})).toBe(0);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('::notice::'));
    } finally {
      write.mockRestore();
    }
  });
});

describe('smoke tests against a broken deployment', () => {
  test('a service that cannot persist fails the run, names the failing checks and still tries to clean up', async () => {
    const repository = createMemoryRepository();
    repository.create = async () => {
      throw new Error('database is read-only');
    };
    const app = createApp({ repository, logger: createLogger({ level: 'silent' }) });
    const { server, url } = await listen(app);

    try {
      const outcome = await runSmoke({ baseUrl: url });

      expect(outcome.ok).toBe(false);
      const failed = outcome.results.filter((r) => !r.ok).map((r) => r.name);
      expect(failed).toContain('POST /api/tasks creates a task');
      expect(failed).toContain('DELETE /api/tasks/:id removes the task');
      expect(outcome.results.find((r) => r.name === 'POST /api/tasks creates a task').detail).toMatch(/expected 201, got 500/);
    } finally {
      await close(server);
    }
  });

  test('a placeholder page instead of the app fails the health and UI checks', async () => {
    const { server, url } = await listen((_req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end('<h1>Render is waking up</h1>'));

    try {
      const outcome = await runSmoke({ baseUrl: url });
      const failed = outcome.results.filter((r) => !r.ok).map((r) => r.name);
      expect(failed).toEqual(expect.arrayContaining(['GET /health reports healthy', 'GET / serves the UI']));
    } finally {
      await close(server);
    }
  });

  test('main returns 1 when something fails and renders the table', async () => {
    const { server, url } = await listen((_req, res) => res.writeHead(503).end());
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(await smokeMain(['--url', url], {})).toBe(1);
      expect(write).toHaveBeenCalledWith(expect.stringContaining('::error::Smoke tests failed'));
    } finally {
      write.mockRestore();
      await close(server);
    }
  });

  test('renderSummary shows pass/fail counts and details', () => {
    const text = renderSummary('https://s.test', {
      results: [
        { name: 'a', ok: true, ms: 5 },
        { name: 'b', ok: false, ms: 7, detail: 'expected 200, got 500' },
      ],
    });
    expect(text).toContain('**1/2 passed**');
    expect(text).toContain('| FAIL | b | 7 ms | expected 200, got 500 |');
  });
});
