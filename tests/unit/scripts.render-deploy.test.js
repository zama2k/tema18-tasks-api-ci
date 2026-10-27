const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFakeRender } = require('../../scripts/fake-render-server');
const { createRenderClient, deployImage, findQueuedDeploy, normalizeDigest, RenderApiError, main } = require('../../scripts/render-deploy');

const IMAGE = `ghcr.io/owner/repo@sha256:${'a'.repeat(64)}`;
const noSleep = () => Promise.resolve();

describe('render-deploy against a fake Render API', () => {
  let fake;
  let apiUrl;

  async function boot(scenario) {
    fake = createFakeRender({ scenario });
    apiUrl = await fake.start();
    return createRenderClient({ apiKey: 'test-key', apiUrl });
  }

  afterEach(async () => {
    await fake.stop();
  });

  test('triggers a deploy with the image digest and waits until it is live', async () => {
    const client = await boot('success');
    const log = jest.fn();

    const result = await deployImage({ client, serviceId: 'srv-test', imageUrl: IMAGE, sleepFn: noSleep, log });

    expect(result).toMatchObject({ deployId: 'dep-001', status: 'live', polls: 3 });
    const trigger = fake.requests[0];
    expect(trigger.method).toBe('POST');
    expect(trigger.url).toBe('/v1/services/srv-test/deploys');
    expect(trigger.headers.authorization).toBe('Bearer test-key');
    expect(trigger.body).toEqual({ imageUrl: IMAGE });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('build_in_progress -> update_in_progress'));
  });

  test('fails with the Render status when the build fails', async () => {
    const client = await boot('build-failed');

    await expect(deployImage({ client, serviceId: 'srv-test', imageUrl: IMAGE, sleepFn: noSleep })).rejects.toThrow(
      'ended with status "build_failed"',
    );
  });

  test('times out when the deploy never goes live', async () => {
    const client = await boot('never-live');
    let clock = 0;

    await expect(
      deployImage({
        client,
        serviceId: 'srv-test',
        imageUrl: IMAGE,
        pollIntervalMs: 10,
        timeoutMs: 100,
        now: () => clock,
        sleepFn: async (ms) => {
          clock += ms;
        },
      }),
    ).rejects.toThrow(/did not become live within \d+s \(last status "update_in_progress"\)/);
  });

  test('survives a transient 503 while polling', async () => {
    const client = await boot('flaky');
    const log = jest.fn();

    const result = await deployImage({ client, serviceId: 'srv-test', imageUrl: IMAGE, sleepFn: noSleep, log });

    expect(result.status).toBe('live');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('could not read deploy status (1/5)'));
  });

  test('retries the trigger once when the API answers 429', async () => {
    const client = await boot('rate-limited');

    const result = await deployImage({ client, serviceId: 'srv-test', imageUrl: IMAGE, sleepFn: noSleep });

    expect(result.status).toBe('live');
    expect(fake.state.triggers).toBe(2);
  });

  test('a wrong API key is a clear, non-retried error that never echoes the key', async () => {
    await boot('success');
    const client = createRenderClient({ apiKey: 'super-secret-wrong-key', apiUrl });

    const error = await deployImage({ client, serviceId: 'srv-test', imageUrl: IMAGE, sleepFn: noSleep }).catch((e) => e);

    expect(error).toBeInstanceOf(RenderApiError);
    expect(error.status).toBe(401);
    expect(error.message).toContain('401');
    expect(error.message).not.toContain('super-secret-wrong-key');
    expect(fake.requests).toHaveLength(1);
  });

  test('an unknown service id is reported as 404', async () => {
    const client = await boot('success');
    await expect(deployImage({ client, serviceId: 'srv-other', imageUrl: IMAGE, sleepFn: noSleep })).rejects.toMatchObject({ status: 404 });
  });
});

describe('render-deploy client edge cases', () => {
  const response = (status, body, headers = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  });

  test('requires an API key', () => {
    expect(() => createRenderClient({})).toThrow(/RENDER_API_KEY/);
  });

  test('turns network failures into retryable errors without leaking the key', async () => {
    const client = createRenderClient({
      apiKey: 'k-123',
      fetchImpl: async () => {
        throw new Error('connect ECONNREFUSED while sending Bearer k-123');
      },
    });

    const error = await client.getDeploy('srv', 'dep').catch((e) => e);

    expect(error.retryable).toBe(true);
    expect(error.message).not.toContain('k-123');
  });

  test('a 202 without a body is exposed as "no deploy yet", not as an error', async () => {
    const client = createRenderClient({ apiKey: 'k', fetchImpl: async () => response(202) });
    await expect(client.triggerDeploy('srv', IMAGE)).resolves.toEqual({ status: 202, deploy: null });
  });

  test('listDeploys unwraps [{deploy, cursor}] and also accepts a flat array', async () => {
    const wrapped = createRenderClient({ apiKey: 'k', fetchImpl: async () => response(200, [{ deploy: { id: 'a' }, cursor: 'c1' }, { deploy: { id: 'b' }, cursor: 'c2' }]) });
    const flat = createRenderClient({ apiKey: 'k', fetchImpl: async () => response(200, [{ id: 'a' }]) });
    const empty = createRenderClient({ apiKey: 'k', fetchImpl: async () => response(200, { not: 'an array' }) });

    expect((await wrapped.listDeploys('srv')).map((d) => d.id)).toEqual(['a', 'b']);
    expect((await flat.listDeploys('srv')).map((d) => d.id)).toEqual(['a']);
    expect(await empty.listDeploys('srv')).toEqual([]);
  });

  test('listDeploys asks for 20 deploys by default, never just the latest one', async () => {
    const fetchImpl = jest.fn(async () => response(200, []));
    await createRenderClient({ apiKey: 'k', fetchImpl }).listDeploys('srv-1');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.render.com/v1/services/srv-1/deploys?limit=20');
  });

  test('reads Retry-After from a 429', async () => {
    const client = createRenderClient({ apiKey: 'k', fetchImpl: async () => response(429, { message: 'slow down' }, { 'retry-after': '7' }) });
    await expect(client.getDeploy('srv', 'dep')).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 });
  });

  test('handles a non JSON error body (proxy page)', async () => {
    const client = createRenderClient({
      apiKey: 'k',
      fetchImpl: async () => ({ ...response(502), text: async () => '<html>Bad gateway</html>' }),
    });
    await expect(client.getDeploy('srv', 'dep')).rejects.toMatchObject({ status: 502 });
  });

  test('gives up after the maximum number of consecutive polling errors', async () => {
    const client = {
      triggerDeploy: async () => ({ status: 201, deploy: { id: 'dep-1', status: 'created' } }),
      getDeploy: async () => {
        throw new RenderApiError('boom', { status: 503 });
      },
    };

    await expect(deployImage({ client, serviceId: 's', imageUrl: IMAGE, sleepFn: noSleep, maxPollErrors: 3 })).rejects.toThrow('boom');
  });

  test('does not retry a non retryable polling error', async () => {
    const getDeploy = jest.fn().mockRejectedValue(new RenderApiError('forbidden', { status: 403 }));
    const client = { triggerDeploy: async () => ({ status: 201, deploy: { id: 'dep-1', status: 'created' } }), getDeploy };

    await expect(deployImage({ client, serviceId: 's', imageUrl: IMAGE, sleepFn: noSleep })).rejects.toThrow('forbidden');
    expect(getDeploy).toHaveBeenCalledTimes(1);
  });

  test('rejects an unknown status instead of polling forever', async () => {
    const client = { triggerDeploy: async () => ({ status: 201, deploy: { id: 'dep-1', status: 'mystery' } }), getDeploy: jest.fn() };
    await expect(deployImage({ client, serviceId: 's', imageUrl: IMAGE, sleepFn: noSleep })).rejects.toThrow('unknown status "mystery"');
  });

  test('a deploy that is already live returns without polling', async () => {
    const getDeploy = jest.fn();
    const client = { triggerDeploy: async () => ({ status: 201, deploy: { id: 'dep-1', status: 'live' } }), getDeploy };
    const result = await deployImage({ client, serviceId: 's', imageUrl: IMAGE, sleepFn: noSleep });
    expect(result).toMatchObject({ status: 'live', polls: 0 });
    expect(getDeploy).not.toHaveBeenCalled();
  });
});

describe('202 "Queued" answers', () => {
  test('locates the queued deploy in the list (not on the first call) and follows it until live', async () => {
    const fake = createFakeRender({ scenario: 'queued' });
    const apiUrl = await fake.start();
    const log = jest.fn();
    try {
      const client = createRenderClient({ apiKey: 'test-key', apiUrl });

      const result = await deployImage({ client, serviceId: 'srv-test', imageUrl: IMAGE, sleepFn: noSleep, log });

      expect(result).toMatchObject({ deployId: 'dep-001', status: 'live' });
      const calls = fake.requests.map((r) => `${r.method} ${r.url}`);
      expect(calls.slice(0, 3)).toEqual(['POST /v1/services/srv-test/deploys', 'GET /v1/services/srv-test/deploys?limit=20', 'GET /v1/services/srv-test/deploys?limit=20']);
      expect(calls.some((c) => c.includes('limit=1&') || c.endsWith('limit=1'))).toBe(false);
      expect(fake.state.triggers).toBe(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining('queued deploy not listed yet (attempt 1/8)'));
    } finally {
      await fake.stop();
    }
  });

  test('does not trigger a second deploy when listing fails', async () => {
    const triggerDeploy = jest.fn().mockResolvedValue({ status: 202, deploy: null });
    const listDeploys = jest.fn().mockRejectedValue(new RenderApiError('unavailable', { status: 503 }));

    await expect(deployImage({ client: { triggerDeploy, listDeploys }, serviceId: 's', imageUrl: IMAGE, sleepFn: noSleep })).rejects.toThrow('unavailable');
    expect(triggerDeploy).toHaveBeenCalledTimes(1);
  });
});

describe('findQueuedDeploy', () => {
  const NOW = Date.parse('2026-10-27T10:00:00.000Z');
  const deploy = (id, createdAt, image) => ({ id, createdAt, status: 'queued', image });
  const clientWith = (...pages) => {
    const listDeploys = jest.fn();
    pages.forEach((page) => listDeploys.mockResolvedValueOnce(page));
    return { listDeploys };
  };
  const base = { serviceId: 's', imageUrl: IMAGE, requestedAt: NOW, sleepFn: noSleep };

  test('normalizeDigest accepts prefixes and uppercase', () => {
    const hex = 'ab'.repeat(32);
    expect(normalizeDigest(`SHA256:${hex.toUpperCase()}`)).toBe(hex);
    expect(normalizeDigest(hex)).toBe(hex);
    expect(normalizeDigest(`ghcr.io/o/r@sha256:${hex}`)).toBe(hex);
    expect(normalizeDigest('latest')).toBeNull();
    expect(normalizeDigest(undefined)).toBeNull();
  });

  test('picks the newest deploy of our digest created after the request, matching by sha or ref in any case', async () => {
    const ours = 'a'.repeat(64);
    const client = clientWith([
      deploy('other-image', '2026-10-27T10:00:05.000Z', { sha: `sha256:${'c'.repeat(64)}` }),
      deploy('too-old', '2026-10-26T10:00:00.000Z', { sha: `sha256:${ours}` }),
      deploy('older-match', '2026-10-27T09:59:30.000Z', { sha: `SHA256:${ours.toUpperCase()}` }),
      deploy('newest-match', '2026-10-27T10:00:03.000Z', { ref: `ghcr.io/o/r@sha256:${ours}` }),
      deploy('git-backed', '2026-10-27T10:00:04.000Z', undefined),
    ]);

    const found = await findQueuedDeploy({ ...base, client });

    expect(found.id).toBe('newest-match');
    expect(client.listDeploys).toHaveBeenCalledWith('s', { limit: 20 });
  });

  test('tolerates clock skew between the runner and Render', async () => {
    const client = clientWith([deploy('skewed', '2026-10-27T09:58:30.000Z', { sha: `sha256:${'a'.repeat(64)}` })]);
    expect((await findQueuedDeploy({ ...base, client })).id).toBe('skewed');
  });

  test('retries while the deploy is not listed and then reports a clear error', async () => {
    const client = { listDeploys: jest.fn().mockResolvedValue([]) };
    const sleepFn = jest.fn().mockResolvedValue();

    await expect(findQueuedDeploy({ ...base, client, attempts: 3, sleepFn })).rejects.toThrow(/Render queued the deploy \(HTTP 202\) but no recent deploy with image digest sha256:aaaaaaaaaaaa/);
    expect(client.listDeploys).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  test('refuses to look up an image that has no digest', async () => {
    await expect(findQueuedDeploy({ ...base, imageUrl: 'ghcr.io/o/r:main', client: { listDeploys: jest.fn() } })).rejects.toThrow(/no sha256 digest/);
  });
});

describe('render-deploy command line (main)', () => {
  let dir;
  let output;
  let summary;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));
    output = path.join(dir, 'output');
    summary = path.join(dir, 'summary');
    jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const envFor = (extra = {}) => ({ GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...extra });

  test('skips with a notice when the Render secrets are not configured', async () => {
    const code = await main(['--image', IMAGE], envFor());

    expect(code).toBe(0);
    expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('::notice::'));
    expect(fs.readFileSync(output, 'utf8')).toBe('deployed=false\n');
    expect(fs.readFileSync(summary, 'utf8')).toContain('Skipped');
  });

  test('refuses an image that is not pinned by digest', async () => {
    await expect(main(['--image', 'ghcr.io/owner/repo:main'], envFor({ RENDER_API_KEY: 'k', RENDER_SERVICE_ID: 's' }))).rejects.toThrow(
      /pinned by digest/,
    );
  });

  test('requires an image when configured', async () => {
    await expect(main([], envFor({ RENDER_API_KEY: 'k', RENDER_SERVICE_ID: 's' }))).rejects.toThrow(/--image/);
  });

  test('deploys end to end against the fake API and writes outputs', async () => {
    const fake = createFakeRender({ scenario: 'success' });
    const apiUrl = await fake.start();
    try {
      const code = await main(
        ['--image', IMAGE, '--api-url', apiUrl, '--poll-interval', '0'],
        envFor({ RENDER_API_KEY: 'test-key', RENDER_SERVICE_ID: 'srv-test' }),
      );

      expect(code).toBe(0);
      const outputs = fs.readFileSync(output, 'utf8');
      expect(outputs).toContain('deployed=true');
      expect(outputs).toContain('deploy-id=dep-001');
      expect(fs.readFileSync(summary, 'utf8')).toContain(IMAGE);
    } finally {
      await fake.stop();
    }
  });
});
