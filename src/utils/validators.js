const TASK_PRIORITIES = ['low', 'medium', 'high'];
const TASK_STATUSES = ['pending', 'in_progress', 'done'];

const TITLE_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 500;
// PostgreSQL `integer` upper bound; keeps ids valid for both storage engines.
const MAX_ID = 2147483647;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const HTML_TAGS = /<[^>]*>/g;

/**
 * Cleans free text coming from the outside: drops markup and control characters.
 * Output escaping is still the renderer's job (the UI uses textContent).
 */
function sanitizeInput(input) {
  if (typeof input !== 'string') return '';
  return input.replace(HTML_TAGS, '').replace(CONTROL_CHARS, '').trim();
}

function validateTaskTitle(title) {
  const clean = sanitizeInput(title);
  return clean.length >= 1 && clean.length <= TITLE_MAX_LENGTH;
}

function validateTaskPriority(priority) {
  return TASK_PRIORITIES.includes(priority);
}

function validateTaskStatus(status) {
  return TASK_STATUSES.includes(status);
}

/** Returns a positive integer id or null when the raw value is not a valid id. */
function parseId(raw) {
  const text = typeof raw === 'number' ? String(raw) : raw;
  if (typeof text !== 'string' || !/^[1-9]\d{0,9}$/.test(text)) return null;
  const id = Number(text);
  return id <= MAX_ID ? id : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates a task payload.
 * - create (default): title required, the rest gets defaults.
 * - `partial: true` (update): every field optional, but at least one must be present.
 * Returns `{ valid, errors, value }`; `value` only exists when valid.
 */
function validateTask(payload, { partial = false } = {}) {
  if (!isPlainObject(payload)) {
    return { valid: false, errors: [{ field: 'body', message: 'body must be a JSON object' }] };
  }

  const errors = [];
  const value = {};
  const has = (field) => payload[field] !== undefined;

  if (has('title') || !partial) {
    if (validateTaskTitle(payload.title)) {
      value.title = sanitizeInput(payload.title);
    } else {
      errors.push({
        field: 'title',
        message: has('title')
          ? `title must be a text of 1 to ${TITLE_MAX_LENGTH} characters`
          : 'title is required',
      });
    }
  }

  if (has('description')) {
    const description = sanitizeInput(payload.description);
    if (typeof payload.description === 'string' && description.length <= DESCRIPTION_MAX_LENGTH) {
      value.description = description;
    } else {
      errors.push({
        field: 'description',
        message: `description must be a text of up to ${DESCRIPTION_MAX_LENGTH} characters`,
      });
    }
  } else if (!partial) {
    value.description = '';
  }

  if (has('priority')) {
    if (validateTaskPriority(payload.priority)) {
      value.priority = payload.priority;
    } else {
      errors.push({ field: 'priority', message: `priority must be one of: ${TASK_PRIORITIES.join(', ')}` });
    }
  } else if (!partial) {
    value.priority = 'medium';
  }

  if (has('status')) {
    if (validateTaskStatus(payload.status)) {
      value.status = payload.status;
    } else {
      errors.push({ field: 'status', message: `status must be one of: ${TASK_STATUSES.join(', ')}` });
    }
  } else if (!partial) {
    value.status = 'pending';
  }

  if (partial && errors.length === 0 && Object.keys(value).length === 0) {
    errors.push({ field: 'body', message: 'provide at least one field to update' });
  }

  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [], value };
}

module.exports = {
  TASK_PRIORITIES,
  TASK_STATUSES,
  TITLE_MAX_LENGTH,
  DESCRIPTION_MAX_LENGTH,
  sanitizeInput,
  validateTaskTitle,
  validateTaskPriority,
  validateTaskStatus,
  parseId,
  validateTask,
};
