const { loadConfig } = require('../../src/config');

describe('loadConfig', () => {
  test('uses safe defaults', () => {
    expect(loadConfig({})).toMatchObject({
      port: 3000,
      databaseUrl: null,
      autoMigrate: false,
      commit: 'unknown',
      logLevel: 'info',
    });
  });

  test('reads values from the environment', () => {
    const config = loadConfig({
      PORT: '8080',
      DATABASE_URL: 'postgresql://u:p@db:5432/x',
      AUTO_MIGRATE: 'TRUE',
      GIT_SHA: 'deadbeef',
      LOG_LEVEL: 'debug',
    });

    expect(config).toMatchObject({
      port: 8080,
      databaseUrl: 'postgresql://u:p@db:5432/x',
      autoMigrate: true,
      commit: 'deadbeef',
      logLevel: 'debug',
    });
  });

  test('treats an empty DATABASE_URL as "not configured"', () => {
    expect(loadConfig({ DATABASE_URL: '' }).databaseUrl).toBeNull();
  });

  test('accepts port 0 (ephemeral port, used by tests)', () => {
    expect(loadConfig({ PORT: '0' }).port).toBe(0);
  });

  test.each(['abc', '-1', '70000', '80.5'])('rejects PORT=%s', (port) => {
    expect(() => loadConfig({ PORT: port })).toThrow(/PORT/);
  });

  test.each(['false', '0', '', 'no'])('AUTO_MIGRATE=%j stays disabled', (value) => {
    expect(loadConfig({ AUTO_MIGRATE: value }).autoMigrate).toBe(false);
  });
});
