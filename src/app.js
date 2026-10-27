const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const { createTasksController } = require('./controllers/tasks.controller');
const { createTasksRouter } = require('./routes/tasks');
const { HttpError } = require('./utils/errors');
const { createLogger } = require('./utils/logger');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

/**
 * Express application factory. It never calls listen(): tests mount it with supertest,
 * server.js is the only place that opens a port.
 */
function createApp({
  repository,
  version = '0.0.0',
  commit = 'unknown',
  logger = createLogger(),
  publicDir = PUBLIC_DIR,
}) {
  if (!repository) throw new TypeError('createApp requires a repository');

  const app = express();
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        // Plain HTTP is used in local development and in the CI smoke tests.
        directives: { 'upgrade-insecure-requests': null },
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      version,
      commit,
      storage: repository.storage,
      uptime: Math.round(process.uptime()),
    });
  });

  app.get('/ready', async (_req, res) => {
    try {
      await repository.ping();
      res.json({ status: 'ready', storage: repository.storage });
    } catch (error) {
      logger.error('readiness check failed', { error: error.message });
      res.status(503).json({ status: 'unavailable', storage: repository.storage });
    }
  });

  app.use('/api/tasks', createTasksRouter(createTasksController(repository)));
  app.use(express.static(publicDir));

  app.use((req, _res, next) => {
    next(HttpError.notFound(`route not found: ${req.method} ${req.path}`));
  });

  // Express identifies error handlers by their 4 parameters, so `_next` must stay.
  app.use((error, req, res, _next) => {
    if (error instanceof HttpError) {
      return res.status(error.status).json({
        error: { code: error.code, message: error.message, details: error.details },
      });
    }

    // Errors raised by express.json(): malformed JSON, payload too large...
    if (error.type === 'entity.parse.failed') {
      return res
        .status(400)
        .json({ error: { code: 'bad_request', message: 'request body is not valid JSON' } });
    }
    if (error.type === 'entity.too.large') {
      return res
        .status(413)
        .json({ error: { code: 'payload_too_large', message: 'request body is too large' } });
    }

    // Unknown failure: log the detail, never send the stack or message to the client.
    logger.error('unhandled error', { method: req.method, path: req.path, error: error.message });
    return res
      .status(500)
      .json({ error: { code: 'internal_error', message: 'internal server error' } });
  });

  return app;
}

module.exports = { createApp };
