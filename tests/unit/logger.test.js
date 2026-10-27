const { createLogger } = require('../../src/utils/logger');
const { HttpError } = require('../../src/utils/errors');

function capture(level) {
  const lines = [];
  const logger = createLogger({ level, stream: { write: (line) => lines.push(JSON.parse(line)) } });
  return { logger, lines };
}

describe('createLogger', () => {
  test('writes one JSON object per call with time, level and message', () => {
    const { logger, lines } = capture('info');
    logger.info('hello', { port: 3000 });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', message: 'hello', port: 3000 });
    expect(new Date(lines[0].time).toString()).not.toBe('Invalid Date');
  });

  test('drops messages below the configured level', () => {
    const { logger, lines } = capture('error');
    logger.info('ignored');
    logger.debug('ignored');
    logger.error('kept');
    expect(lines.map((l) => l.message)).toEqual(['kept']);
  });

  test('silent mutes everything', () => {
    const { logger, lines } = capture('silent');
    logger.error('nope');
    expect(lines).toEqual([]);
  });

  test('falls back to info for an unknown level', () => {
    const { logger, lines } = capture('verbose');
    logger.info('shown');
    logger.debug('hidden');
    expect(lines.map((l) => l.message)).toEqual(['shown']);
  });

  test('writes errors to stderr and the rest to stdout by default', () => {
    const out = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const err = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const logger = createLogger({ level: 'info' });
      logger.info('to stdout');
      logger.error('to stderr');
      expect(out).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledTimes(1);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

describe('HttpError', () => {
  test('badRequest and notFound carry status and code', () => {
    expect(HttpError.badRequest('bad', [{ field: 'x' }])).toMatchObject({
      status: 400,
      code: 'bad_request',
      details: [{ field: 'x' }],
    });
    expect(HttpError.notFound()).toMatchObject({ status: 404, code: 'not_found', message: 'resource not found' });
  });

  test('is a real Error with a stack', () => {
    const error = HttpError.notFound('x');
    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toContain('HttpError');
  });
});
