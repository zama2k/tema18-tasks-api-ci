/**
 * Deploys a container image to an image-backed Render service and waits until it is live.
 *
 *   RENDER_API_KEY=... RENDER_SERVICE_ID=srv-... \
 *   node scripts/render-deploy.js --image ghcr.io/owner/repo@sha256:<digest>
 *
 * Optional: --poll-interval <s> (default 10), --timeout <s> (default 900), --api-url <url>
 * (default https://api.render.com/v1; point it at scripts/fake-render-server.js to test locally).
 *
 * API used (docs consulted 2026-10-27, see docs/plataformas.md):
 *   POST /v1/services/{serviceId}/deploys          body: { "imageUrl": "<image>" }  -> 201 deploy
 *   GET  /v1/services/{serviceId}/deploys/{deployId}                                -> 200 deploy
 * Deploy status values: created, queued, build_in_progress, update_in_progress,
 * pre_deploy_in_progress, live, deactivated, build_failed, update_failed, pre_deploy_failed, canceled.
 */
const { sleep, parseArgs, setOutput, appendSummary, annotate, redact } = require('./lib/util');

const DEFAULT_API_URL = 'https://api.render.com/v1';
const IN_PROGRESS = new Set(['created', 'queued', 'build_in_progress', 'update_in_progress', 'pre_deploy_in_progress']);
const FAILED = new Set(['build_failed', 'update_failed', 'pre_deploy_failed', 'canceled', 'deactivated']);
const RETRYABLE_HTTP = new Set([429, 500, 502, 503, 504]);

class RenderApiError extends Error {
  constructor(message, { status, retryAfterMs } = {}) {
    super(message);
    this.name = 'RenderApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  get retryable() {
    return this.status === undefined || RETRYABLE_HTTP.has(this.status);
  }
}

function createRenderClient({ apiKey, apiUrl = DEFAULT_API_URL, fetchImpl = fetch, requestTimeoutMs = 20000 }) {
  if (!apiKey) throw new Error('RENDER_API_KEY is required');
  const base = apiUrl.replace(/\/+$/, '');

  async function request(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
    } catch (error) {
      throw new RenderApiError(`network error calling Render: ${redact(error.message, [apiKey])}`);
    }

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      // non JSON body (proxy error page): keep payload null
    }

    if (!response.ok) {
      const detail = payload && payload.message ? payload.message : response.statusText || 'request failed';
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new RenderApiError(`Render API ${method} ${path} answered ${response.status}: ${redact(detail, [apiKey])}`, {
        status: response.status,
        retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
      });
    }
    return { status: response.status, payload };
  }

  return {
    async triggerDeploy(serviceId, imageUrl) {
      const { status, payload } = await request('POST', `/services/${encodeURIComponent(serviceId)}/deploys`, { imageUrl });
      if (!payload || !payload.id) {
        throw new RenderApiError(
          `Render accepted the deploy request (HTTP ${status}) but returned no deploy id; check the Render dashboard`,
          { status },
        );
      }
      return payload;
    },

    async getDeploy(serviceId, deployId) {
      const { payload } = await request('GET', `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`);
      return payload;
    },
  };
}

/**
 * Triggers the deploy and polls until it reaches `live`.
 * Throws on a failed/superseded deploy and on timeout. Polling tolerates short API blips
 * (up to `maxPollErrors` consecutive failures); the trigger is only retried on 429/503.
 */
async function deployImage({
  client,
  serviceId,
  imageUrl,
  pollIntervalMs = 10000,
  timeoutMs = 900000,
  maxPollErrors = 5,
  sleepFn = sleep,
  now = Date.now,
  log = () => {},
}) {
  const startedAt = now();

  let deploy;
  for (let attempt = 1; ; attempt += 1) {
    try {
      deploy = await client.triggerDeploy(serviceId, imageUrl);
      break;
    } catch (error) {
      const retryable = error instanceof RenderApiError && (error.status === 429 || error.status === 503);
      if (!retryable || attempt >= 3) throw error;
      const wait = error.retryAfterMs ?? attempt * 5000;
      log(`trigger answered ${error.status}, retrying in ${Math.round(wait / 1000)}s (attempt ${attempt}/3)`);
      await sleepFn(wait);
    }
  }
  log(`deploy ${deploy.id} created with status "${deploy.status}"`);

  let lastStatus = deploy.status;
  let consecutiveErrors = 0;
  let polls = 0;

  while (now() - startedAt < timeoutMs) {
    if (lastStatus === 'live') {
      return { deployId: deploy.id, status: 'live', durationMs: now() - startedAt, polls };
    }
    if (FAILED.has(lastStatus)) {
      throw new Error(`deploy ${deploy.id} ended with status "${lastStatus}"`);
    }
    if (!IN_PROGRESS.has(lastStatus)) {
      throw new Error(`deploy ${deploy.id} reported an unknown status "${lastStatus}"`);
    }

    await sleepFn(pollIntervalMs);
    polls += 1;

    try {
      const current = await client.getDeploy(serviceId, deploy.id);
      consecutiveErrors = 0;
      if (current.status !== lastStatus) log(`deploy ${deploy.id}: ${lastStatus} -> ${current.status}`);
      lastStatus = current.status;
    } catch (error) {
      if (!(error instanceof RenderApiError) || !error.retryable) throw error;
      consecutiveErrors += 1;
      log(`could not read deploy status (${consecutiveErrors}/${maxPollErrors}): ${error.message}`);
      if (consecutiveErrors >= maxPollErrors) throw error;
      if (error.retryAfterMs) await sleepFn(error.retryAfterMs);
    }
  }

  throw new Error(`deploy ${deploy.id} did not become live within ${Math.round(timeoutMs / 1000)}s (last status "${lastStatus}")`);
}

async function main(argv, env = process.env) {
  const options = parseArgs(argv);
  const imageUrl = options.image || env.IMAGE_URL;
  const apiKey = env.RENDER_API_KEY;
  const serviceId = env.RENDER_SERVICE_ID;

  if (!apiKey || !serviceId) {
    annotate.notice('RENDER_API_KEY / RENDER_SERVICE_ID are not configured: skipping the Render deploy.');
    setOutput('deployed', 'false', env);
    appendSummary('### Render deploy\nSkipped: `RENDER_API_KEY` or `RENDER_SERVICE_ID` is not configured.', env);
    return 0;
  }
  if (!imageUrl) throw new Error('--image <registry/repo@sha256:digest> is required');
  if (!/@sha256:[0-9a-f]{64}$/.test(imageUrl)) {
    throw new Error('--image must be pinned by digest (...@sha256:<64 hex>) so exactly the tested build is deployed');
  }

  const client = createRenderClient({ apiKey, apiUrl: options['api-url'] || env.RENDER_API_URL || DEFAULT_API_URL });
  const log = (message) => process.stdout.write(`[render] ${message}\n`);

  log(`deploying ${imageUrl} to service ${serviceId}`);
  const result = await deployImage({
    client,
    serviceId,
    imageUrl,
    pollIntervalMs: Number(options['poll-interval'] || 10) * 1000,
    timeoutMs: Number(options.timeout || 900) * 1000,
    log,
  });

  const seconds = Math.round(result.durationMs / 1000);
  log(`deploy ${result.deployId} is live after ${seconds}s`);
  setOutput('deployed', 'true', env);
  setOutput('deploy-id', result.deployId, env);
  setOutput('deploy-seconds', seconds, env);
  appendSummary(`### Render deploy\n- Deploy: \`${result.deployId}\`\n- Image: \`${imageUrl}\`\n- Time to live: **${seconds}s**`, env);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      annotate.error(`Render deploy failed: ${redact(error.message, [process.env.RENDER_API_KEY])}`);
      process.exit(1);
    },
  );
}

module.exports = { createRenderClient, deployImage, RenderApiError, main, IN_PROGRESS, FAILED };
