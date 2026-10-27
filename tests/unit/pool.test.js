jest.mock('pg', () => ({ Pool: jest.fn() }));

const { Pool } = require('pg');
const { createPool } = require('../../src/db/pool');

describe('createPool', () => {
  let instance;

  beforeEach(() => {
    instance = { on: jest.fn() };
    Pool.mockReset();
    Pool.mockImplementation(() => instance);
  });

  test('applies safe defaults for connection handling', () => {
    createPool('postgresql://u:p@db/x');

    expect(Pool).toHaveBeenCalledWith({
      connectionString: 'postgresql://u:p@db/x',
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
  });

  test('lets callers override the defaults', () => {
    createPool('postgresql://x', { max: 1, options: '-c search_path=tests' });

    expect(Pool).toHaveBeenCalledWith(expect.objectContaining({ max: 1, options: '-c search_path=tests', connectionTimeoutMillis: 5000 }));
  });

  test('logs idle client errors instead of crashing the process', () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      createPool('postgresql://x');
      const [event, handler] = instance.on.mock.calls[0];
      expect(event).toBe('error');

      handler(new Error('terminating connection due to administrator command'));

      const line = JSON.parse(write.mock.calls[0][0]);
      expect(line).toMatchObject({ level: 'error', message: 'idle pg client error', error: 'terminating connection due to administrator command' });
    } finally {
      write.mockRestore();
    }
  });
});
