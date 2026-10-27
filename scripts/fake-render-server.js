/**
 * In-process fake of the two Render API endpoints used by render-deploy.js.
 * Used by the test suite and for manual runs without a Render account:
 *
 *   node scripts/fake-render-server.js --port 3102 --scenario success
 *   RENDER_API_KEY=test RENDER_SERVICE_ID=srv-test node scripts/render-deploy.js \
 *     --api-url http://127.0.0.1:3102/v1 --poll-interval 1 --image ghcr.io/o/r@sha256:<64 hex>
 *
 * Scenarios: success | build-failed | never-live | flaky (503 while polling) | rate-limited (429 on trigger)
 */
const http = require('node:http');
const { parseArgs } = require('./lib/util');

const SCENARIOS = {
  success: ['created', 'build_in_progress', 'update_in_progress', 'live'],
  'build-failed': ['created', 'build_in_progress', 'build_failed'],
  'never-live': ['created', 'update_in_progress'],
  flaky: ['created', 'update_in_progress', 'update_in_progress', 'live'],
  'rate-limited': ['created', 'live'],
};

function createFakeRender({ apiKey = 'test-key', serviceId = 'srv-test', scenario = 'success' } = {}) {
  if (!SCENARIOS[scenario]) throw new Error(`unknown scenario "${scenario}"`);
  const requests = [];
  const state = { polls: 0, triggers: 0, deploys: new Map() };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      const send = (status, payload, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        res.end(payload === undefined ? '' : JSON.stringify(payload));
      };

      if (req.headers.authorization !== `Bearer ${apiKey}`) return send(401, { message: 'Unauthorized' });

      const deployMatch = req.url.match(/^\/v1\/services\/([^/]+)\/deploys(?:\/([^/]+))?$/);
      if (!deployMatch) return send(404, { message: 'Not Found' });
      if (deployMatch[1] !== serviceId) return send(404, { message: 'service not found' });

      if (req.method === 'POST' && !deployMatch[2]) {
        state.triggers += 1;
        if (scenario === 'rate-limited' && state.triggers === 1) {
          return send(429, { message: 'Rate limit exceeded' }, { 'Retry-After': '0' });
        }
        if (!body || typeof body.imageUrl !== 'string') return send(400, { message: 'imageUrl is required' });
        const id = `dep-${String(state.deploys.size + 1).padStart(3, '0')}`;
        state.deploys.set(id, { imageUrl: body.imageUrl, step: 0 });
        return send(201, { id, status: SCENARIOS[scenario][0], image: { ref: body.imageUrl } });
      }

      if (req.method === 'GET' && deployMatch[2]) {
        const deploy = state.deploys.get(deployMatch[2]);
        if (!deploy) return send(404, { message: 'deploy not found' });
        state.polls += 1;
        if (scenario === 'flaky' && state.polls === 1) return send(503, { message: 'temporarily unavailable' });
        const steps = SCENARIOS[scenario];
        deploy.step = Math.min(deploy.step + 1, steps.length - 1);
        return send(200, { id: deployMatch[2], status: steps[deploy.step] });
      }

      return send(405, { message: 'Method Not Allowed' });
    });
  });

  return {
    requests,
    state,
    start: (port = 0) =>
      new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/v1`))),
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const fake = createFakeRender({ scenario: options.scenario || 'success' });
  fake.start(Number(options.port || 0)).then((url) => process.stdout.write(`fake Render API listening at ${url} (key: test-key, service: srv-test)\n`));
}

module.exports = { createFakeRender, SCENARIOS };
