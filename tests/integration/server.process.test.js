const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { databaseUrl } = require('./helpers/db');

const SERVER = path.join(__dirname, '../../src/server.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHealth(port, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return response.json();
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('server did not become healthy in time');
}

describe('server process (real entry point + PostgreSQL)', () => {
  const schema = `it_srv_${process.pid}`;
  let admin;
  let child;
  let output;

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl(), max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
  });

  afterAll(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  test('boots with AUTO_MIGRATE, serves tasks from PostgreSQL and shuts down cleanly on SIGTERM', async () => {
    const port = await freePort();
    const url = new URL(databaseUrl());
    url.searchParams.set('options', `-c search_path=${schema}`);

    output = '';
    child = spawn(process.execPath, [SERVER], {
      env: {
        ...process.env,
        PORT: String(port),
        DATABASE_URL: url.toString(),
        AUTO_MIGRATE: 'true',
        GIT_SHA: 'process-test',
        LOG_LEVEL: 'info',
      },
    });
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

    const health = await waitForHealth(port);
    expect(health).toMatchObject({ status: 'healthy', storage: 'postgres', commit: 'process-test' });

    const created = await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Booted for real' }),
    });
    expect(created.status).toBe(201);

    // Windows cannot deliver SIGTERM to a child (it is killed abruptly); Linux CI and the Docker image can.
    if (process.platform === 'win32') {
      child.kill();
      await exited;
      return;
    }

    child.kill('SIGTERM');
    const { code } = await exited;
    expect(code).toBe(0);
    expect(output).toContain('shutdown complete');
  });

  test('exits with code 1 and a clear log line when the port is not usable', async () => {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, resolve));

    try {
      const failing = spawn(process.execPath, [SERVER], {
        env: { ...process.env, PORT: String(blocker.address().port), DATABASE_URL: '', LOG_LEVEL: 'info' },
      });
      let stderr = '';
      failing.stderr.on('data', (chunk) => (stderr += chunk));
      const code = await new Promise((resolve) => failing.once('exit', resolve));

      expect(code).toBe(1);
      expect(stderr).toContain('failed to start');
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
