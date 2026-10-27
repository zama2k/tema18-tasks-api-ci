/**
 * Container HEALTHCHECK probe. The alpine image has no curl, so we use Node itself.
 * Exit code 0 = healthy, 1 = unhealthy. Uses the liveness endpoint only (no DB dependency),
 * so a database blip does not make the orchestrator kill an otherwise healthy process.
 */
const port = process.env.PORT || '3000';
const url = process.env.HEALTHCHECK_URL || `http://127.0.0.1:${port}/health`;

fetch(url, { signal: AbortSignal.timeout(2500) })
  .then((response) => process.exit(response.ok ? 0 : 1))
  .catch(() => process.exit(1));
