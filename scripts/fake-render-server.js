/**
 * In-process fake of the two Render API endpoints used by render-deploy.js.
 * Used by the test suite and for manual runs without a Render account:
 *
 *   node scripts/fake-render-server.js --port 3102 --scenario success
 *   RENDER_API_KEY=test RENDER_SERVICE_ID=srv-test node scripts/render-deploy.js \
 *     --api-url http://127.0.0.1:3102/v1 --poll-interval 1 --image ghcr.io/o/r@sha256:<64 hex>
 *
 * Scenarios: success | build-failed | never-live | flaky (503 while polling) | rate-limited (429 on trigger)
 *            | queued (202 without a body; the deploy only shows up in the list, and not on the first call)
 */
const http = require('node:http');
const { parseArgs } = require('./lib/util');

const SCENARIOS = {
  success: ['created', 'build_in_progress', 'update_in_progress', 'live'],
  'build-failed': ['created', 'build_in_progress', 'build_failed'],
  'never-live': ['created', 'update_in_progress'],
  flaky: ['created', 'update_in_progress', 'update_in_progress', 'live'],
  'rate-limited': ['created', 'live'],
  queued: ['queued', 'build_in_progress', 'update_in_progress', 'live'],
};

const sha256Of = (imageUrl) => (/sha256:[0-9a-f]{64}/i.exec(imageUrl) || [''])[0];

function createFakeRender({ apiKey = 'test-key', serviceId = 'srv-test', scenario = 'success' } = {}) {
  if (!SCENARIOS[scenario]) throw new Error(`unknown scenario "${scenario}"`);
  const requests = [];
  const state = { polls: 0, triggers: 0, lists: 0, deploys: new Map() };
  const publicDeploy = (id, deploy, status) => ({
    id,
    status,
    createdAt: deploy.createdAt,
    image: { ref: deploy.imageUrl, sha: sha256Of(deploy.imageUrl) },
  });
  // Decoys the client must not pick: a recent deploy of another image and an old deploy of ours.
  const decoy = (id, imageUrl, ageMs) => ({ id, imageUrl, step: 0, createdAt: new Date(Date.now() - ageMs).toISOString() });

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

      const deployMatch = req.url.split('?')[0].match(/^\/v1\/services\/([^/]+)\/deploys(?:\/([^/]+))?$/);
      if (!deployMatch) return send(404, { message: 'Not Found' });
      if (deployMatch[1] !== serviceId) return send(404, { message: 'service not found' });

      if (req.method === 'POST' && !deployMatch[2]) {
        state.triggers += 1;
        if (scenario === 'rate-limited' && state.triggers === 1) {
          return send(429, { message: 'Rate limit exceeded' }, { 'Retry-After': '0' });
        }
        if (!body || typeof body.imageUrl !== 'string') return send(400, { message: 'imageUrl is required' });
        const id = `dep-${String(state.deploys.size + 1).padStart(3, '0')}`;
        const deploy = { imageUrl: body.imageUrl, step: 0, createdAt: new Date().toISOString() };
        state.deploys.set(id, deploy);
        if (scenario === 'queued') return send(202); // "Queued": no body, as documented
        return send(201, publicDeploy(id, deploy, SCENARIOS[scenario][0]));
      }

      if (req.method === 'GET' && !deployMatch[2]) {
        state.lists += 1;
        if (scenario === 'queued' && state.lists === 1) return send(200, []); // not visible yet
        const ours = [...state.deploys.entries()].map(([id, deploy]) => ({ id, deploy }));
        const old = state.deploys.size ? [...state.deploys.values()][0].imageUrl : `ghcr.io/o/r@sha256:${'0'.repeat(64)}`;
        const items = [
          ...ours.map(({ id, deploy }) => publicDeploy(id, deploy, SCENARIOS[scenario][Math.min(deploy.step, SCENARIOS[scenario].length - 1)])),
          publicDeploy('dep-other', decoy('x', `ghcr.io/o/r@sha256:${'e'.repeat(64)}`, 1000), 'live'),
          publicDeploy('dep-ancient', decoy('y', old, 24 * 3600 * 1000), 'live'),
        ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
        return send(200, items.map((deploy) => ({ deploy, cursor: `cur-${deploy.id}` })));
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
    // Node 18 keeps idle keep-alive sockets open on close(); drop them so tests do not hang.
    stop: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      }),
  };
}

if (require.main === module) {
  const options = parseArgs(process.argv.slice(2));
  const fake = createFakeRender({ scenario: options.scenario || 'success' });
  fake.start(Number(options.port || 0)).then((url) => process.stdout.write(`fake Render API listening at ${url} (key: test-key, service: srv-test)\n`));
}

module.exports = { createFakeRender, SCENARIOS };
