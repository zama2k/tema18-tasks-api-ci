/**
 * Task persistence behind a single async interface (repository pattern).
 *
 *   list()            -> raw[]
 *   get(id)           -> raw | null
 *   create(data)      -> raw
 *   update(id, patch) -> raw | null
 *   remove(id)        -> boolean
 *   ping()            -> resolves when the storage is reachable
 *   close()           -> releases resources
 *
 * "raw" tasks use the database row shape (snake_case, Date timestamps);
 * the controller turns them into the public JSON shape with formatTask().
 */

const UPDATABLE_COLUMNS = ['title', 'description', 'status', 'priority'];

function createMemoryRepository({ now = () => new Date() } = {}) {
  let tasks = [];
  let nextId = 1;

  const copy = (task) => ({ ...task });

  return {
    storage: 'memory',

    async list() {
      return tasks.map(copy);
    },

    async get(id) {
      const task = tasks.find((t) => t.id === id);
      return task ? copy(task) : null;
    },

    async create(data) {
      const timestamp = now();
      const task = {
        id: nextId++,
        title: data.title,
        description: data.description ?? '',
        status: data.status ?? 'pending',
        priority: data.priority ?? 'medium',
        created_at: timestamp,
        updated_at: timestamp,
      };
      tasks.push(task);
      return copy(task);
    },

    async update(id, patch) {
      const task = tasks.find((t) => t.id === id);
      if (!task) return null;
      for (const column of UPDATABLE_COLUMNS) {
        if (patch[column] !== undefined) task[column] = patch[column];
      }
      task.updated_at = now();
      return copy(task);
    },

    async remove(id) {
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== id);
      return tasks.length < before;
    },

    async ping() {},

    async close() {},
  };
}

function createPostgresRepository(pool) {
  return {
    storage: 'postgres',

    async list() {
      const { rows } = await pool.query('SELECT * FROM tasks ORDER BY id ASC');
      return rows;
    },

    async get(id) {
      const { rows } = await pool.query('SELECT * FROM tasks WHERE id = $1', [id]);
      return rows[0] || null;
    },

    async create(data) {
      const { rows } = await pool.query(
        `INSERT INTO tasks (title, description, status, priority)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [data.title, data.description ?? '', data.status ?? 'pending', data.priority ?? 'medium'],
      );
      return rows[0];
    },

    async update(id, patch) {
      // Column names come from a fixed whitelist; values are always bound parameters.
      const columns = UPDATABLE_COLUMNS.filter((column) => patch[column] !== undefined);
      const assignments = columns.map((column, index) => `${column} = $${index + 2}`);
      const values = columns.map((column) => patch[column]);
      const { rows } = await pool.query(
        `UPDATE tasks SET ${[...assignments, 'updated_at = now()'].join(', ')}
         WHERE id = $1
         RETURNING *`,
        [id, ...values],
      );
      return rows[0] || null;
    },

    async remove(id) {
      const { rowCount } = await pool.query('DELETE FROM tasks WHERE id = $1', [id]);
      return rowCount > 0;
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    async close() {
      await pool.end();
    },
  };
}

module.exports = { createMemoryRepository, createPostgresRepository, UPDATABLE_COLUMNS };
