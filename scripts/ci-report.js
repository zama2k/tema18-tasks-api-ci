/**
 * Turns the machine readable test outputs (Jest json-summary, Stryker json) into
 * human artifacts: the sticky PR comment, the job summary and the shields.io badges.
 *
 *   node scripts/ci-report.js comment --unit <coverage-summary.json> [--integration <file>]
 *        [--mutation <mutation.json>] [--sha <sha>] [--run-url <url>] [--out <file>]
 *   node scripts/ci-report.js badges  --unit <file> [--mutation <file>] --out-dir <dir>
 *
 * The PR comment starts with a hidden marker so the workflow can find it and update it
 * in place instead of posting a new comment on every push.
 */
const fs = require('node:fs');
const path = require('node:path');

const COMMENT_MARKER = '<!-- tasks-api-ci:coverage-report -->';
const METRICS = ['statements', 'branches', 'functions', 'lines'];
const COVERAGE_THRESHOLD = 80;

function round1(value) {
  return Math.round(value * 10) / 10;
}

/** Reads the `total` block of a Jest `json-summary` report. */
function summarizeCoverage(summary) {
  if (!summary || !summary.total) throw new Error('not a Jest json-summary report (missing "total")');
  const result = {};
  for (const metric of METRICS) {
    const { pct, covered, total } = summary.total[metric];
    result[metric] = { pct: Number(pct), covered, total };
  }
  return result;
}

/** Mutation score following the Stryker definition: detected / (detected + undetected). */
function summarizeMutation(report) {
  if (!report || typeof report.files !== 'object') throw new Error('not a Stryker mutation report (missing "files")');
  const counts = { Killed: 0, Timeout: 0, Survived: 0, NoCoverage: 0, Other: 0 };

  for (const file of Object.values(report.files)) {
    for (const mutant of file.mutants) {
      counts[mutant.status in counts ? mutant.status : 'Other'] += 1;
    }
  }

  const detected = counts.Killed + counts.Timeout;
  const valid = detected + counts.Survived + counts.NoCoverage;
  return {
    score: valid === 0 ? 100 : round1((detected / valid) * 100),
    killed: counts.Killed,
    timeout: counts.Timeout,
    survived: counts.Survived,
    noCoverage: counts.NoCoverage,
    total: valid,
    thresholds: report.thresholds || null,
  };
}

function icon(pct, threshold) {
  return pct >= threshold ? 'PASS' : 'FAIL';
}

function coverageTable(title, coverage, threshold) {
  const rows = METRICS.map((metric) => {
    const { pct, covered, total } = coverage[metric];
    const status = threshold === null ? '' : ` | ${icon(pct, threshold)}`;
    return `| ${metric} | ${pct}% | ${covered}/${total}${status} |`;
  });
  const header = threshold === null ? '| Metric | Coverage | Covered |\n|---|---:|---:|' : `| Metric | Coverage | Covered | Gate (>= ${threshold}%) |\n|---|---:|---:|:---:|`;
  return `**${title}**\n\n${header}\n${rows.join('\n')}`;
}

function renderReport({ unit, integration, mutation, sha, runUrl, marker = true }) {
  const parts = [];
  if (marker) parts.push(COMMENT_MARKER);
  parts.push('## Test report');
  if (sha) parts.push(`Commit \`${sha.slice(0, 7)}\`${runUrl ? ` | [workflow run](${runUrl})` : ''}`);

  parts.push(coverageTable('Unit tests coverage (enforced by Jest `coverageThreshold`)', unit, COVERAGE_THRESHOLD));
  if (integration) parts.push(coverageTable('Integration tests coverage (PostgreSQL, informational)', integration, null));

  if (mutation) {
    const { score, killed, timeout, survived, noCoverage, total, thresholds } = mutation;
    const gate = thresholds ? ` Break threshold: ${thresholds.break}%.` : '';
    parts.push(
      `**Mutation score (Stryker): ${score}%**\n\n` +
        `| Killed | Timeout | Survived | No coverage | Valid mutants |\n|---:|---:|---:|---:|---:|\n` +
        `| ${killed} | ${timeout} | ${survived} | ${noCoverage} | ${total} |\n\n` +
        `A surviving mutant is a code change that no test noticed.${gate}`,
    );
  } else {
    parts.push('_Mutation score not available for this run._');
  }

  return `${parts.join('\n\n')}\n`;
}

function badgeColor(pct) {
  if (pct >= 90) return 'brightgreen';
  if (pct >= 80) return 'green';
  if (pct >= 70) return 'yellowgreen';
  if (pct >= 60) return 'yellow';
  return 'red';
}

/** Payload for shields.io "endpoint" badges: https://shields.io/badges/endpoint-badge */
function shieldsBadge(label, pct) {
  return { schemaVersion: 1, label, message: `${pct}%`, color: badgeColor(pct) };
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error(`invalid argument near "${rest[i]}"`);
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return { command, options };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readOptional(file, summarize) {
  return file && fs.existsSync(file) ? summarize(readJson(file)) : null;
}

function main(argv) {
  const { command, options } = parseArgs(argv);
  if (!options.unit) throw new Error('--unit <coverage-summary.json> is required');

  const unit = summarizeCoverage(readJson(options.unit));
  const mutation = readOptional(options.mutation, summarizeMutation);

  if (command === 'comment' || command === 'summary') {
    const markdown = renderReport({
      unit,
      integration: readOptional(options.integration, summarizeCoverage),
      mutation,
      sha: options.sha,
      runUrl: options['run-url'],
      marker: command === 'comment',
    });
    if (options.out) fs.writeFileSync(options.out, markdown);
    else process.stdout.write(markdown);
    return;
  }

  if (command === 'badges') {
    if (!options['out-dir']) throw new Error('--out-dir is required');
    fs.mkdirSync(options['out-dir'], { recursive: true });
    const linesPct = unit.lines.pct;
    fs.writeFileSync(path.join(options['out-dir'], 'coverage.json'), `${JSON.stringify(shieldsBadge('coverage', linesPct))}\n`);
    if (mutation) {
      fs.writeFileSync(path.join(options['out-dir'], 'mutation.json'), `${JSON.stringify(shieldsBadge('mutation score', mutation.score))}\n`);
    }
    return;
  }

  throw new Error(`unknown command "${command}" (expected comment, summary or badges)`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ci-report: ${error.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  COMMENT_MARKER,
  summarizeCoverage,
  summarizeMutation,
  renderReport,
  shieldsBadge,
  badgeColor,
  parseArgs,
  main,
};
