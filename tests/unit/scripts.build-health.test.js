const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { checkBuild } = require('../../scripts/build-check');

const run = promisify(execFile);
const ROOT = path.join(__dirname, '../..');

describe('build-check', () => {
  test('the real project tree is deployable', () => {
    expect(checkBuild(ROOT)).toEqual([]);
  });

  test('reports missing files and empty migration folders', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
    fs.mkdirSync(path.join(dir, 'src/db/migrations'), { recursive: true });

    const problems = checkBuild(dir);

    expect(problems).toEqual(expect.arrayContaining(['missing src/app.js', 'missing public/index.html', 'src/db/migrations has no .sql files']));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reports syntax errors with the offending file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/broken.js'), 'const = ;');

    expect(checkBuild(dir).some((p) => p.startsWith(path.join('src', 'broken.js')))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('npm run build entry point succeeds', async () => {
    const { stdout } = await run(process.execPath, [path.join(ROOT, 'scripts/build-check.js')]);
    expect(stdout).toContain('build check passed');
  });

  test('the entry point exits with 1 when the tree is broken', async () => {
    // Running from a copy that lacks everything: reuse checkBuild through a tiny wrapper.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-'));
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.copyFileSync(path.join(ROOT, 'scripts/build-check.js'), path.join(dir, 'scripts/build-check.js'));

    await expect(run(process.execPath, [path.join(dir, 'scripts/build-check.js')])).rejects.toMatchObject({ code: 1 });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('container healthcheck script', () => {
  function serve(status) {
    return new Promise((resolve) => {
      const server = http.createServer((_req, res) => res.writeHead(status).end('{}'));
      server.listen(0, '127.0.0.1', () => resolve(server));
    });
  }

  const probe = (port) =>
    run(process.execPath, [path.join(ROOT, 'scripts/healthcheck.js')], { env: { ...process.env, PORT: String(port) } });

  test('exits 0 when /health answers 200', async () => {
    const server = await serve(200);
    try {
      await expect(probe(server.address().port)).resolves.toBeDefined();
    } finally {
      server.close();
    }
  });

  test('exits 1 when /health answers an error status', async () => {
    const server = await serve(503);
    try {
      await expect(probe(server.address().port)).rejects.toMatchObject({ code: 1 });
    } finally {
      server.close();
    }
  });

  test('exits 1 when nothing is listening', async () => {
    const server = await serve(200);
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));

    await expect(probe(port)).rejects.toMatchObject({ code: 1 });
  });
});
