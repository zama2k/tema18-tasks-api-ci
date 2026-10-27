const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  COMMENT_MARKER,
  summarizeCoverage,
  summarizeMutation,
  renderReport,
  shieldsBadge,
  badgeColor,
  parseArgs,
  main,
} = require('../../scripts/ci-report');

const metric = (pct, covered, total) => ({ total, covered, skipped: 0, pct });
const coverageJson = (pct = 91.5) => ({
  total: {
    statements: metric(pct, 183, 200),
    branches: metric(88, 44, 50),
    functions: metric(100, 20, 20),
    lines: metric(pct, 180, 196),
  },
});

const mutationJson = () => ({
  thresholds: { high: 80, low: 60, break: 50 },
  files: {
    'src/a.js': {
      mutants: [{ status: 'Killed' }, { status: 'Killed' }, { status: 'Survived' }, { status: 'Timeout' }],
    },
    'src/b.js': {
      mutants: [{ status: 'NoCoverage' }, { status: 'CompileError' }, { status: 'Ignored' }, { status: 'Killed' }],
    },
  },
});

describe('summarizeCoverage', () => {
  test('extracts the four metrics from the total block', () => {
    const summary = summarizeCoverage(coverageJson());
    expect(summary.lines).toEqual({ pct: 91.5, covered: 180, total: 196 });
    expect(Object.keys(summary)).toEqual(['statements', 'branches', 'functions', 'lines']);
  });

  test('rejects files that are not a Jest json-summary', () => {
    expect(() => summarizeCoverage({})).toThrow(/json-summary/);
    expect(() => summarizeCoverage(null)).toThrow(/json-summary/);
  });
});

describe('summarizeMutation', () => {
  test('computes the Stryker score ignoring compile errors and ignored mutants', () => {
    const result = summarizeMutation(mutationJson());

    // detected = 3 killed + 1 timeout = 4; undetected = 1 survived + 1 no coverage; valid = 6
    expect(result).toMatchObject({ killed: 3, timeout: 1, survived: 1, noCoverage: 1, total: 6, score: 66.7 });
    expect(result.thresholds.break).toBe(50);
  });

  test('an empty report scores 100 instead of dividing by zero', () => {
    expect(summarizeMutation({ files: {} }).score).toBe(100);
  });

  test('rejects files that are not a Stryker report', () => {
    expect(() => summarizeMutation({})).toThrow(/Stryker/);
  });
});

describe('renderReport', () => {
  const base = { unit: summarizeCoverage(coverageJson()), mutation: summarizeMutation(mutationJson()) };

  test('starts with the hidden marker used to update the comment in place', () => {
    expect(renderReport(base).startsWith(COMMENT_MARKER)).toBe(true);
  });

  test('can omit the marker for the job summary', () => {
    expect(renderReport({ ...base, marker: false })).not.toContain(COMMENT_MARKER);
  });

  test('shows gate status per metric', () => {
    const report = renderReport({ ...base, unit: summarizeCoverage({ total: { ...coverageJson().total, branches: metric(70, 7, 10) } }) });
    expect(report).toContain('| branches | 70% | 7/10 | FAIL |');
    expect(report).toContain('| lines | 91.5% | 180/196 | PASS |');
  });

  test('includes commit, run link, integration table and mutation score when provided', () => {
    const report = renderReport({
      ...base,
      integration: summarizeCoverage(coverageJson(75)),
      sha: 'abcdef1234567890',
      runUrl: 'https://example.test/run/1',
    });

    expect(report).toContain('`abcdef1`');
    expect(report).toContain('[workflow run](https://example.test/run/1)');
    expect(report).toContain('Integration tests coverage');
    expect(report).toContain('**Mutation score (Stryker): 66.7%**');
    expect(report).toContain('Break threshold: 50%');
  });

  test('says so when there is no mutation data', () => {
    expect(renderReport({ unit: base.unit })).toContain('Mutation score not available');
  });
});

describe('badges', () => {
  test.each([
    [95, 'brightgreen'],
    [85, 'green'],
    [75, 'yellowgreen'],
    [65, 'yellow'],
    [10, 'red'],
  ])('%d%% is %s', (pct, color) => {
    expect(badgeColor(pct)).toBe(color);
  });

  test('uses the shields.io endpoint schema', () => {
    expect(shieldsBadge('coverage', 91.5)).toEqual({
      schemaVersion: 1,
      label: 'coverage',
      message: '91.5%',
      color: 'brightgreen',
    });
  });
});

describe('command line', () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-report-'));
    fs.writeFileSync(path.join(dir, 'unit.json'), JSON.stringify(coverageJson()));
    fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify(mutationJson()));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('parseArgs reads --key value pairs and rejects dangling flags', () => {
    expect(parseArgs(['comment', '--unit', 'a.json', '--sha', 'x'])).toEqual({
      command: 'comment',
      options: { unit: 'a.json', sha: 'x' },
    });
    expect(() => parseArgs(['comment', '--unit'])).toThrow(/invalid argument/);
  });

  test('comment writes the markdown file', () => {
    const out = path.join(dir, 'comment.md');
    main(['comment', '--unit', path.join(dir, 'unit.json'), '--mutation', path.join(dir, 'mutation.json'), '--out', out]);

    const text = fs.readFileSync(out, 'utf8');
    expect(text).toContain(COMMENT_MARKER);
    expect(text).toContain('66.7%');
  });

  test('comment tolerates a missing optional mutation file', () => {
    const out = path.join(dir, 'comment.md');
    main(['comment', '--unit', path.join(dir, 'unit.json'), '--mutation', path.join(dir, 'nope.json'), '--out', out]);
    expect(fs.readFileSync(out, 'utf8')).toContain('Mutation score not available');
  });

  test('summary prints to stdout without marker', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      main(['summary', '--unit', path.join(dir, 'unit.json')]);
      expect(write.mock.calls[0][0]).not.toContain(COMMENT_MARKER);
    } finally {
      write.mockRestore();
    }
  });

  test('badges writes one shields file per metric available', () => {
    const outDir = path.join(dir, 'badges');
    main(['badges', '--unit', path.join(dir, 'unit.json'), '--mutation', path.join(dir, 'mutation.json'), '--out-dir', outDir]);

    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'coverage.json'), 'utf8')).message).toBe('91.5%');
    expect(JSON.parse(fs.readFileSync(path.join(outDir, 'mutation.json'), 'utf8')).message).toBe('66.7%');
  });

  test('badges skips the mutation badge when there is no report', () => {
    const outDir = path.join(dir, 'badges');
    main(['badges', '--unit', path.join(dir, 'unit.json'), '--out-dir', outDir]);
    expect(fs.existsSync(path.join(outDir, 'mutation.json'))).toBe(false);
  });

  test('mutation prints a one-line summary and needs --mutation', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      main(['mutation', '--mutation', path.join(dir, 'mutation.json')]);
      expect(write.mock.calls[0][0]).toBe('**Mutation score: 66.7%** (3 killed, 1 timeout, 1 survived, 1 without coverage, 6 valid mutants)\n');
    } finally {
      write.mockRestore();
    }
    expect(() => main(['mutation'])).toThrow(/--mutation/);
  });

  test('fails without --unit', () => {
    expect(() => main(['comment'])).toThrow(/--unit/);
  });

  test('fails for an unknown command', () => {
    expect(() => main(['bogus', '--unit', path.join(dir, 'unit.json')])).toThrow(/unknown command/);
  });

  test('badges requires an output directory', () => {
    expect(() => main(['badges', '--unit', path.join(dir, 'unit.json')])).toThrow(/--out-dir/);
  });
});
