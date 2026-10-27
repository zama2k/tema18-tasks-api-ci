const { buildPayload, sendWebhook, main, WEBHOOK_PATTERN, COLORS } = require('../../scripts/notify-discord');

const WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/abcDEF_ghi-123';
const fixedNow = () => new Date('2026-10-27T10:00:00.000Z');

describe('buildPayload', () => {
  const base = {
    status: 'success',
    sha: '0123456789abcdef',
    url: 'https://staging.example.com',
    runUrl: 'https://github.com/o/r/actions/runs/1',
    digest: `sha256:${'a'.repeat(64)}`,
    deploySeconds: '83',
    actor: 'antonio',
    now: fixedNow,
  };

  test('builds an embed with status, short sha, url, digest and run link', () => {
    const [embed] = buildPayload(base).embeds;

    expect(embed.title).toBe('Staging deploy succeeded');
    expect(embed.color).toBe(COLORS.success);
    expect(embed.timestamp).toBe('2026-10-27T10:00:00.000Z');
    expect(embed.url).toBe(base.runUrl);
    const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    expect(fields.Commit).toBe('`0123456`');
    expect(fields.Staging).toBe('https://staging.example.com');
    expect(fields['Deploy time']).toBe('83s');
    expect(fields['Workflow run']).toContain(base.runUrl);
  });

  test('uses a red embed for failures and grey for skipped', () => {
    expect(buildPayload({ ...base, status: 'failure' }).embeds[0]).toMatchObject({ title: 'Staging deploy FAILED', color: COLORS.failure });
    expect(buildPayload({ ...base, status: 'skipped' }).embeds[0].color).toBe(COLORS.skipped);
  });

  test('omits optional fields and respects Discord limits', () => {
    const payload = buildPayload({ status: 'failure', sha: 'abc', details: 'x'.repeat(5000), now: fixedNow });
    const [embed] = payload.embeds;

    expect(embed.fields.map((f) => f.name)).toEqual(['Commit']);
    expect(embed.description.length).toBeLessThanOrEqual(1500);
    expect(embed.title.length).toBeLessThanOrEqual(256);
    expect(JSON.stringify(payload)).not.toContain('undefined');
  });

  test('rejects an unknown status', () => {
    expect(() => buildPayload({ status: 'maybe', sha: 'a' })).toThrow(/unknown status/);
  });
});

describe('WEBHOOK_PATTERN', () => {
  test.each([WEBHOOK, 'https://discordapp.com/api/webhooks/1/abc', 'https://canary.discord.com/api/webhooks/1/abc'])('accepts %s', (url) => {
    expect(WEBHOOK_PATTERN.test(url)).toBe(true);
  });

  test.each(['http://discord.com/api/webhooks/1/abc', 'https://evil.example/api/webhooks/1/abc', 'https://discord.com.evil.example/api/webhooks/1/a', 'nonsense'])(
    'rejects %s',
    (url) => {
      expect(WEBHOOK_PATTERN.test(url)).toBe(false);
    },
  );
});

describe('sendWebhook', () => {
  const payload = { username: 'x', embeds: [] };

  test('posts JSON and accepts 204', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 204 });

    await sendWebhook({ webhookUrl: WEBHOOK, payload, fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(WEBHOOK, expect.objectContaining({ method: 'POST', body: JSON.stringify(payload) }));
  });

  test('waits retry_after once on 429 and then succeeds', async () => {
    const sleepFn = jest.fn().mockResolvedValue();
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ status: 429, json: async () => ({ retry_after: 0.5 }) })
      .mockResolvedValueOnce({ status: 204 });

    await sendWebhook({ webhookUrl: WEBHOOK, payload, fetchImpl, sleepFn });

    expect(sleepFn).toHaveBeenCalledWith(500);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('gives up when rate limited twice', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 429, json: async () => ({}) });
    await expect(sendWebhook({ webhookUrl: WEBHOOK, payload, fetchImpl, sleepFn: async () => {} })).rejects.toThrow(/HTTP 429/);
  });

  test('reports HTTP errors without the webhook URL', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ status: 400 });
    const error = await sendWebhook({ webhookUrl: WEBHOOK, payload, fetchImpl }).catch((e) => e);
    expect(error.message).toBe('Discord answered HTTP 400');
  });

  test('network errors never leak the secret webhook URL', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error(`getaddrinfo failed for ${WEBHOOK}`));
    const error = await sendWebhook({ webhookUrl: WEBHOOK, payload, fetchImpl }).catch((e) => e);
    expect(error.message).not.toContain('abcDEF_ghi-123');
  });
});

describe('main', () => {
  let write;

  beforeEach(() => {
    write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const output = () => write.mock.calls.map((c) => c[0]).join('');

  test('skips with a notice when the secret is missing', async () => {
    expect(await main(['--status', 'success', '--sha', 'abc'], {})).toBe(0);
    expect(output()).toContain('::notice::DISCORD_WEBHOOK_URL is not configured');
  });

  test('refuses a URL that is not a Discord webhook (never posts the payload there)', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 204 });

    expect(await main(['--status', 'success'], { DISCORD_WEBHOOK_URL: 'https://evil.example/hook' })).toBe(0);

    expect(output()).toContain('::warning::');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('sends the notification and reports success', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ status: 204 });

    const code = await main(['--status', 'success', '--sha', 'abcdef1234', '--url', 'https://s.test'], { DISCORD_WEBHOOK_URL: WEBHOOK });

    expect(code).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(output()).toContain('Discord notification sent (success)');
  });

  test('a delivery failure becomes a warning and does not fail the pipeline', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({ status: 500 });

    const code = await main(['--status', 'failure', '--sha', 'abc'], { DISCORD_WEBHOOK_URL: WEBHOOK });

    expect(code).toBe(0);
    expect(output()).toContain('::warning::Discord notification failed: Discord answered HTTP 500');
  });
});
