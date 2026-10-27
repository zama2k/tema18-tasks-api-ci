(function () {
  'use strict';

  const form = document.getElementById('task-form');
  const titleInput = document.getElementById('title');
  const priorityInput = document.getElementById('priority');
  const filterInput = document.getElementById('filter');
  const errorBox = document.getElementById('form-error');
  const list = document.getElementById('task-list');
  const emptyMessage = document.getElementById('empty');
  const stats = document.getElementById('stats');

  async function api(path, options) {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (response.status === 204) return null;
    const body = await response.json();
    if (!response.ok) {
      const details = (body.error.details || []).map((d) => d.message).join('; ');
      throw new Error(details || body.error.message);
    }
    return body;
  }

  function showError(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function button(label, action, id) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = label;
    element.dataset.action = action;
    element.dataset.id = String(id);
    return element;
  }

  function renderTask(task) {
    const item = document.createElement('li');
    item.dataset.testid = 'task-item';
    item.dataset.status = task.status;

    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = task.title;

    const priority = document.createElement('span');
    priority.className = 'badge priority-' + task.priority;
    priority.textContent = task.priority;

    const status = document.createElement('span');
    status.className = 'badge status';
    status.textContent = task.status.replace('_', ' ');

    item.append(title, priority, status);
    if (task.status !== 'done') item.append(button('Complete', 'complete', task.id));
    item.append(button('Delete', 'delete', task.id));
    return item;
  }

  async function refresh() {
    const query = filterInput.value ? '?status=' + encodeURIComponent(filterInput.value) : '';
    const [tasks, summary] = await Promise.all([api('/api/tasks' + query), api('/api/tasks/stats')]);

    list.replaceChildren(...tasks.map(renderTask));
    emptyMessage.hidden = tasks.length > 0;
    stats.textContent = summary.total + ' total, ' + summary.byStatus.done + ' done (' + summary.completionRate + '%)';
  }

  async function run(action) {
    action = action || function () {};
    try {
      showError('');
      await action();
      await refresh();
    } catch (error) {
      showError(error.message);
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    run(async function () {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({ title: titleInput.value, priority: priorityInput.value }),
      });
      form.reset();
      titleInput.focus();
    });
  });

  list.addEventListener('click', function (event) {
    const target = event.target.closest('button[data-action]');
    if (!target) return;
    const path = '/api/tasks/' + target.dataset.id;

    run(function () {
      return target.dataset.action === 'delete'
        ? api(path, { method: 'DELETE' })
        : api(path, { method: 'PUT', body: JSON.stringify({ status: 'done' }) });
    });
  });

  filterInput.addEventListener('change', function () {
    run();
  });

  run();
})();
