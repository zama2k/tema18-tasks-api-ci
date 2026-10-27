/**
 * Post-deploy health check: polls GET <url>/health with exponential backoff until the service
 * answers "healthy" AND reports the expected commit.
 *
 *   node scripts/wait-for-health.js --url https://staging.example.com --expect-commit <sha>
 *
 * Checking the commit matters: right after a deploy the previous version can still be serving
 * traffic, and a plain "200 OK" would pass against the old build. Render's free tier also needs
 * about a minute to wake up, hence the generous default budget (20 attempts, backoff capped at 30s).
 */
const { sleep, backoffDelay, parseArgs, setOutput, appendSummary, annotate } = require('./lib/util');

async function checkOnce({ healthUrl, expectedCommit, fetchImpl, requestTimeoutMs }) {
  let response;
  try {
    response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(requestTimeoutMs), headers: { Accept: 'application/json' } });
  } catch (error) {
    return { ok: false, reason: `no answer (${error.name === 'TimeoutError' ? 'timeout' : error.message})` };
  }

  if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };

  let body;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'answer is not JSON (a platform placeholder page?)' };
  }

  if (body.status !== 'healthy') return { ok: false, reason: `status is "${body.status}"` };
  if (expectedCommit && body.commit !== expectedCommit) {
    return { ok: false, reason: `serving commit ${String(body.commit).slice(0, 7)}, expected ${expectedCommit.slice(0, 7)} (previous version still live?)` };
  }
  return { ok: true, body };
}

async function waitForHealth({
  url,
  expectedCommit,
  attempts = 20,
  baseDelayMs = 3000,
  maxDelayMs = 30000,
  requestTimeoutMs = 10000,
  fetchImpl = fetch,
  sleepFn = sleep,
  now = Date.now,
  log = () => {},
}) {
  const healthUrl = `${url.replace(/\/+$/, '')}/health`;
  const startedAt = now();
  let lastReason = 'not checked';

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await checkOnce({ healthUrl, expectedCommit, fetchImpl, requestTimeoutMs });
    if (result.ok) {
      log(`attempt ${attempt}/${attempts}: healthy, commit ${String(result.body.commit).slice(0, 7)}`);
      return { attempts: attempt, elapsedMs: now() - startedAt, body: result.body };
    }

    lastReason = result.reason;
    if (attempt === attempts) break;
    const delay = backoffDelay(attempt, baseDelayMs, maxDelayMs);
    log(`attempt ${attempt}/${attempts}: ${result.reason}; retrying in ${Math.round(delay / 1000)}s`);
    await sleepFn(delay);
  }

  throw new Error(`${healthUrl} is not healthy after ${attempts} attempts (last: ${lastReason})`);
}

async function main(argv, env = process.env) {
  const options = parseArgs(argv);
  const url = options.url || env.STAGING_URL;
  if (!url) {
    annotate.notice('STAGING_URL is not configured: skipping the health check.');
    setOutput('checked', 'false', env);
    return 0;
  }

  const result = await waitForHealth({
    url,
    expectedCommit: options['expect-commit'],
    attempts: Number(options.attempts || 20),
    baseDelayMs: Number(options['base-delay'] || 3) * 1000,
    log: (message) => process.stdout.write(`[health] ${message}\n`),
  });

  const seconds = Math.round(result.elapsedMs / 1000);
  setOutput('checked', 'true', env);
  setOutput('attempts', result.attempts, env);
  setOutput('health-seconds', seconds, env);
  appendSummary(`### Health check\n- URL: ${url}\n- Healthy after **${result.attempts}** attempt(s), ${seconds}s\n- Commit: \`${result.body.commit}\``, env);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      annotate.error(error.message);
      process.exit(1);
    },
  );
}

module.exports = { waitForHealth, main };
