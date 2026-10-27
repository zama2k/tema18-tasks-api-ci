const { defineConfig, devices } = require('@playwright/test');

const PORT = Number(process.env.E2E_PORT || 3100);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IN_CI = Boolean(process.env.CI);

module.exports = defineConfig({
  testDir: 'tests/e2e',
  testMatch: '**/*.e2e.test.js',
  outputDir: 'test-results',

  // One worker per job: every test starts by emptying the shared database.
  // Parallelism comes from sharding across CI jobs, each with its own PostgreSQL.
  fullyParallel: false,
  workers: 1,
  forbidOnly: IN_CI,
  retries: IN_CI ? 1 : 0,
  timeout: 30_000,

  reporter: IN_CI ? [['blob'], ['list']] : [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL: BASE_URL,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  // The real entry point (src/server.js), backed by PostgreSQL when DATABASE_URL is set.
  webServer: {
    command: 'node src/server.js',
    url: `${BASE_URL}/ready`,
    timeout: 30_000,
    reuseExistingServer: !IN_CI,
    env: {
      ...process.env,
      PORT: String(PORT),
      AUTO_MIGRATE: 'true',
      GIT_SHA: 'e2e',
      LOG_LEVEL: 'error',
    },
  },
});
