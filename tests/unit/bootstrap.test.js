const { EventEmitter } = require('node:events');
const { createRepository, registerShutdown, start } = require('../../src/bootstrap');

const silentLogger = () => ({ info: jest.fn(), error: jest.fn(), debug: jest.fn() });

describe('createRepository', () => {
  test('falls back to in-memory storage without DATABASE_URL', async () => {
    const poolFactory = jest.fn();
    const repository = await createRepository({ databaseUrl: null }, { logger: silentLogger(), poolFactory });

    expect(repository.storage).toBe('memory');
    expect(poolFactory).not.toHaveBeenCalled();
  });

  test('uses PostgreSQL when DATABASE_URL is set, without migrating by default', async () => {
    const pool = { query: jest.fn(), end: jest.fn() };
    const poolFactory = jest.fn().mockReturnValue(pool);
    const migrateFn = jest.fn();

    const repository = await createRepository(
      { databaseUrl: 'postgresql://x', autoMigrate: false },
      { logger: silentLogger(), poolFactory, migrateFn },
    );

    expect(repository.storage).toBe('postgres');
    expect(poolFactory).toHaveBeenCalledWith('postgresql://x');
    expect(migrateFn).not.toHaveBeenCalled();
  });

  test('runs migrations on boot when AUTO_MIGRATE is enabled', async () => {
    const pool = { query: jest.fn(), end: jest.fn() };
    const migrateFn = jest.fn().mockResolvedValue([]);

    await createRepository(
      { databaseUrl: 'postgresql://x', autoMigrate: true },
      { logger: silentLogger(), poolFactory: () => pool, migrateFn },
    );

    expect(migrateFn).toHaveBeenCalledWith(pool, expect.objectContaining({ logger: expect.any(Object) }));
  });

  test('closes the pool and rethrows when a migration fails', async () => {
    const pool = { query: jest.fn(), end: jest.fn().mockResolvedValue() };
    const migrateFn = jest.fn().mockRejectedValue(new Error('migration 001 failed'));

    await expect(
      createRepository(
        { databaseUrl: 'postgresql://x', autoMigrate: true },
        { logger: silentLogger(), poolFactory: () => pool, migrateFn },
      ),
    ).rejects.toThrow('migration 001 failed');
    expect(pool.end).toHaveBeenCalledTimes(1);
  });
});

describe('registerShutdown', () => {
  function setup({ closeError, repositoryError } = {}) {
    const processRef = Object.assign(new EventEmitter(), { exit: jest.fn() });
    const server = {
      close: jest.fn((callback) => callback(closeError)),
      closeIdleConnections: jest.fn(),
    };
    const repository = {
      close: repositoryError ? jest.fn().mockRejectedValue(repositoryError) : jest.fn().mockResolvedValue(),
    };
    const logger = silentLogger();
    const shutdown = registerShutdown({ server, repository, logger, processRef, timeoutMs: 50 });
    return { processRef, server, repository, logger, shutdown };
  }

  test('SIGTERM stops the server, closes the repository and exits with 0', async () => {
    const { processRef, server, repository, shutdown } = setup();

    await shutdown('SIGTERM');

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
    expect(repository.close).toHaveBeenCalledTimes(1);
    expect(processRef.exit).toHaveBeenCalledWith(0);
  });

  test('is wired to SIGTERM and SIGINT', async () => {
    const { processRef, server } = setup();

    processRef.emit('SIGINT');
    await new Promise((resolve) => setImmediate(resolve));

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(processRef.listenerCount('SIGTERM')).toBe(1);
    expect(processRef.listenerCount('SIGINT')).toBe(1);
  });

  test('a second signal while shutting down is ignored', async () => {
    const { server, shutdown } = setup();

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(server.close).toHaveBeenCalledTimes(1);
  });

  test('exits with 1 when closing the server fails', async () => {
    const { processRef, repository, shutdown } = setup({ closeError: new Error('boom') });

    await shutdown('SIGTERM');

    expect(repository.close).not.toHaveBeenCalled();
    expect(processRef.exit).toHaveBeenCalledWith(1);
  });

  test('exits with 1 when the repository cannot be closed', async () => {
    const { processRef, shutdown } = setup({ repositoryError: new Error('pool stuck') });

    await shutdown('SIGTERM');

    expect(processRef.exit).toHaveBeenCalledWith(1);
  });

  test('forces exit(1) when shutdown never completes', async () => {
    const processRef = Object.assign(new EventEmitter(), { exit: jest.fn() });
    const server = { close: jest.fn(), closeIdleConnections: jest.fn() }; // never calls back
    const repository = { close: jest.fn() };
    const shutdown = registerShutdown({ server, repository, logger: silentLogger(), processRef, timeoutMs: 20 });

    shutdown('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(processRef.exit).toHaveBeenCalledWith(1);
  });
});

describe('start', () => {
  test('boots the app on the requested port with in-memory storage', async () => {
    const logger = silentLogger();
    const config = { port: 0, databaseUrl: null, autoMigrate: false, commit: 'abc', version: '1.2.3' };
    const processRef = jest.spyOn(process, 'on').mockImplementation(() => process);

    const { server, repository } = await start(config, { logger });
    try {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      const body = await response.json();

      expect(body).toMatchObject({ status: 'healthy', commit: 'abc', version: '1.2.3', storage: 'memory' });
      expect(repository.storage).toBe('memory');
    } finally {
      processRef.mockRestore();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections?.();
      });
    }
  });

  test('rejects when the port is already taken', async () => {
    const net = require('node:net');
    const blocker = net.createServer();
    // Same bind address as app.listen(port) so the clash happens on every OS.
    await new Promise((resolve) => blocker.listen(0, resolve));
    const processRef = jest.spyOn(process, 'on').mockImplementation(() => process);

    try {
      await expect(
        start(
          { port: blocker.address().port, databaseUrl: null, autoMigrate: false, commit: 'x', version: '1' },
          { logger: silentLogger() },
        ),
      ).rejects.toThrow(/EADDRINUSE/);
    } finally {
      processRef.mockRestore();
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});
