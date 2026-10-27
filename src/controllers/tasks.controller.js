const { HttpError } = require('../utils/errors');
const {
  TASK_PRIORITIES,
  TASK_STATUSES,
  parseId,
  validateTask,
  validateTaskStatus,
} = require('../utils/validators');

const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };

// ---- Pure functions (no I/O) -------------------------------------------------

const toIso = (value) => (value instanceof Date ? value : new Date(value)).toISOString();

/** Turns a storage row into the public JSON representation of a task. */
function formatTask(rawTask) {
  return {
    id: Number(rawTask.id),
    title: rawTask.title,
    description: rawTask.description ?? '',
    status: rawTask.status,
    priority: rawTask.priority,
    createdAt: toIso(rawTask.created_at),
    updatedAt: toIso(rawTask.updated_at),
  };
}

/** Keeps the tasks with the given status; a missing status means "no filter". */
function filterByStatus(tasks, status) {
  if (!status) return tasks;
  return tasks.filter((task) => task.status === status);
}

/** Highest priority first; ties keep creation order. Does not mutate its input. */
function sortByPriority(tasks) {
  return [...tasks].sort(
    (a, b) =>
      PRIORITY_WEIGHT[b.priority] - PRIORITY_WEIGHT[a.priority] ||
      new Date(a.createdAt) - new Date(b.createdAt) ||
      a.id - b.id,
  );
}

function calculateStats(tasks) {
  const byStatus = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0]));
  const byPriority = Object.fromEntries(TASK_PRIORITIES.map((priority) => [priority, 0]));

  for (const task of tasks) {
    byStatus[task.status] += 1;
    byPriority[task.priority] += 1;
  }

  const total = tasks.length;
  const completionRate = total === 0 ? 0 : Math.round((byStatus.done / total) * 1000) / 10;
  return { total, byStatus, byPriority, completionRate };
}

// ---- HTTP handlers -----------------------------------------------------------

function requireId(req) {
  const id = parseId(req.params.id);
  if (id === null) throw HttpError.badRequest('id must be a positive integer');
  return id;
}

function createTasksController(repository) {
  async function loadFormatted() {
    return (await repository.list()).map(formatTask);
  }

  return {
    async list(req, res) {
      const { status, sort } = req.query;

      if (status !== undefined && !validateTaskStatus(status)) {
        throw HttpError.badRequest(`status must be one of: ${TASK_STATUSES.join(', ')}`);
      }
      if (sort !== undefined && sort !== 'priority') {
        throw HttpError.badRequest('sort only supports the value: priority');
      }

      let tasks = filterByStatus(await loadFormatted(), status);
      if (sort === 'priority') tasks = sortByPriority(tasks);
      res.json(tasks);
    },

    async stats(_req, res) {
      res.json(calculateStats(await loadFormatted()));
    },

    async get(req, res) {
      const task = await repository.get(requireId(req));
      if (!task) throw HttpError.notFound('task not found');
      res.json(formatTask(task));
    },

    async create(req, res) {
      const { valid, errors, value } = validateTask(req.body);
      if (!valid) throw HttpError.badRequest('invalid task', errors);

      const task = formatTask(await repository.create(value));
      res.status(201).location(`/api/tasks/${task.id}`).json(task);
    },

    async update(req, res) {
      const id = requireId(req);
      const { valid, errors, value } = validateTask(req.body, { partial: true });
      if (!valid) throw HttpError.badRequest('invalid task', errors);

      const task = await repository.update(id, value);
      if (!task) throw HttpError.notFound('task not found');
      res.json(formatTask(task));
    },

    async remove(req, res) {
      const removed = await repository.remove(requireId(req));
      if (!removed) throw HttpError.notFound('task not found');
      res.status(204).end();
    },
  };
}

module.exports = {
  formatTask,
  filterByStatus,
  sortByPriority,
  calculateStats,
  createTasksController,
};
