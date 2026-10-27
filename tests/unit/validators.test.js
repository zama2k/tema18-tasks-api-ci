const {
  TASK_PRIORITIES,
  TASK_STATUSES,
  validateTaskTitle,
  validateTaskPriority,
  validateTaskStatus,
  sanitizeInput,
  parseId,
  validateTask,
} = require('../../src/utils/validators');

describe('validateTaskTitle', () => {
  test.each(['Buy milk', 'a', 'x'.repeat(120), '  padded  '])('accepts %j', (title) => {
    expect(validateTaskTitle(title)).toBe(true);
  });

  test.each([
    ['empty string', ''],
    ['only whitespace', '   '],
    ['too long', 'x'.repeat(121)],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
    ['only markup', '<b></b>'],
  ])('rejects %s', (_label, title) => {
    expect(validateTaskTitle(title)).toBe(false);
  });
});

describe('validateTaskPriority', () => {
  test.each(TASK_PRIORITIES)('accepts %s', (priority) => {
    expect(validateTaskPriority(priority)).toBe(true);
  });

  test.each(['urgent', 'HIGH', '', null, undefined, 1])('rejects %j', (priority) => {
    expect(validateTaskPriority(priority)).toBe(false);
  });
});

describe('validateTaskStatus', () => {
  test.each(TASK_STATUSES)('accepts %s', (status) => {
    expect(validateTaskStatus(status)).toBe(true);
  });

  test.each(['finished', 'DONE', '', null, undefined, false])('rejects %j', (status) => {
    expect(validateTaskStatus(status)).toBe(false);
  });
});

describe('sanitizeInput', () => {
  test('trims surrounding whitespace', () => {
    expect(sanitizeInput('  hello  ')).toBe('hello');
  });

  test('strips html tags but keeps their text', () => {
    expect(sanitizeInput('<script>alert(1)</script>Hi <b>there</b>')).toBe('alert(1)Hi there');
  });

  test('removes control characters but keeps regular unicode', () => {
    expect(sanitizeInput('ca\u0000fe\u0007 éñ')).toBe('cafe éñ');
  });

  test.each([null, undefined, 12, {}, []])('returns an empty string for non-string %j', (value) => {
    expect(sanitizeInput(value)).toBe('');
  });
});

describe('parseId', () => {
  test.each([
    ['1', 1],
    ['42', 42],
    [7, 7],
    ['2147483647', 2147483647],
  ])('parses %j as %d', (raw, expected) => {
    expect(parseId(raw)).toBe(expected);
  });

  test.each(['0', '-1', '1.5', 'abc', '', '01', '2147483648', null, undefined, {}, 1.5])(
    'rejects %j',
    (raw) => {
      expect(parseId(raw)).toBeNull();
    },
  );
});

describe('validateTask (create)', () => {
  test('applies defaults and sanitizes the output', () => {
    const result = validateTask({ title: '  <i>Write</i> tests ' });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value).toEqual({
      title: 'Write tests',
      description: '',
      priority: 'medium',
      status: 'pending',
    });
  });

  test('keeps explicit valid values', () => {
    const result = validateTask({
      title: 'Ship',
      description: 'Release v1',
      priority: 'high',
      status: 'in_progress',
    });
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({
      title: 'Ship',
      description: 'Release v1',
      priority: 'high',
      status: 'in_progress',
    });
  });

  test('ignores unknown properties', () => {
    const result = validateTask({ title: 'Ok', id: 99, isAdmin: true });
    expect(result.valid).toBe(true);
    expect(result.value).not.toHaveProperty('id');
    expect(result.value).not.toHaveProperty('isAdmin');
  });

  test('requires a title', () => {
    const result = validateTask({});
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([{ field: 'title', message: expect.stringContaining('required') }]);
  });

  test('reports every invalid field at once', () => {
    const result = validateTask({
      title: '',
      priority: 'urgent',
      status: 'later',
      description: 'd'.repeat(501),
    });
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.field).sort()).toEqual([
      'description',
      'priority',
      'status',
      'title',
    ]);
    expect(result.value).toBeUndefined();
  });

  test.each([null, undefined, 'text', 12, [], [{ title: 'x' }]])(
    'rejects a non-object payload %j',
    (payload) => {
      const result = validateTask(payload);
      expect(result.valid).toBe(false);
      expect(result.errors[0].field).toBe('body');
    },
  );
});

describe('validateTask (partial update)', () => {
  test('accepts a subset of fields and returns only those', () => {
    const result = validateTask({ status: 'done' }, { partial: true });
    expect(result.valid).toBe(true);
    expect(result.value).toEqual({ status: 'done' });
  });

  test('rejects an update that changes nothing', () => {
    const result = validateTask({ unknown: 1 }, { partial: true });
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toMatch(/at least one/i);
  });

  test('still validates the fields that are present', () => {
    const result = validateTask({ priority: 'nope', title: 'fine' }, { partial: true });
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([{ field: 'priority', message: expect.any(String) }]);
  });

  test('does not allow blanking the title', () => {
    const result = validateTask({ title: '   ' }, { partial: true });
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('title');
  });
});
