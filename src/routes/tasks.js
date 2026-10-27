const { Router } = require('express');

function createTasksRouter(controller) {
  const router = Router();

  // `/stats` must be registered before `/:id`, otherwise "stats" would be read as an id.
  router.get('/stats', controller.stats);
  router.get('/', controller.list);
  router.post('/', controller.create);
  router.get('/:id', controller.get);
  router.put('/:id', controller.update);
  router.delete('/:id', controller.remove);

  return router;
}

module.exports = { createTasksRouter };
