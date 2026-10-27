const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../scripts/setup-github.sh');

function hasTools() {
  try {
    execFileSync('bash', ['--version'], { stdio: 'ignore' });
    execFileSync('jq', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A fake `gh` that records every call (arguments + stdin) in a log file and answers the
 * few read calls the script makes. No network, no GitHub.
 */
const FAKE_GH = `#!/usr/bin/env bash
{
  echo "ARGS: $*"
  if [[ " $* " == *" --input - "* ]]; then echo "STDIN: $(cat)"; fi
} >> "$FAKE_GH_LOG"
case "$*" in
  "repo view"*) echo "student/tasks-api" ;;
  *"deployment-branch-policies"*"--jq"*) echo "\${FAKE_MAIN_POLICY_COUNT:-0}" ;;
  *"--method PATCH"*"/variables/"*) [ "\${FAKE_VARIABLE_EXISTS:-0}" = "1" ] || exit 1 ;;
esac
`;

jest.setTimeout(30000);

(hasTools() ? describe : describe.skip)('setup-github.sh', () => {
  let dir;
  let log;

  const run = (args = [], env = {}) =>
    spawnSync('bash', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_GH_LOG: log, ...env },
    });

  const calls = () => fs.readFileSync(log, 'utf8');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakegh-'));
    log = path.join(dir, 'calls.log');
    fs.writeFileSync(path.join(dir, 'gh'), FAKE_GH, { mode: 0o755 });
    fs.writeFileSync(log, '');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('protects main with a PR, one approval, required checks and no force push', () => {
    const result = run([], { GH_REPO: 'student/tasks-api' });

    expect(result.status).toBe(0);
    const protectionCall = calls().split('\n').find((l) => l.startsWith('STDIN:') && l.includes('required_status_checks'));
    const body = JSON.parse(protectionCall.replace('STDIN: ', ''));
    expect(body.required_pull_request_reviews.required_approving_review_count).toBe(1);
    expect(body.required_status_checks.contexts).toEqual(expect.arrayContaining(['CI OK', 'Lint', 'Integration tests', 'Build image']));
    expect(body.required_status_checks.strict).toBe(true);
    expect(body.allow_force_pushes).toBe(false);
    expect(body.enforce_admins).toBe(false);
    expect(calls()).toContain('ARGS: api --method PUT repos/student/tasks-api/branches/main/protection');
  });

  test('creates the staging environment restricted to main only when the policy is missing', () => {
    run([], { GH_REPO: 'student/tasks-api', FAKE_MAIN_POLICY_COUNT: '0' });
    expect(calls()).toContain('api --method PUT repos/student/tasks-api/environments/staging');
    expect(calls()).toContain('deployment-branch-policies --input -');
    expect(calls()).toContain('"name":"main"');
  });

  test('is idempotent: an existing main policy is not created twice', () => {
    const result = run([], { GH_REPO: 'student/tasks-api', FAKE_MAIN_POLICY_COUNT: '1' });

    expect(result.stdout).toContain('branch policy for main already present');
    expect(calls()).not.toContain('--method POST repos/student/tasks-api/environments/staging/deployment-branch-policies');
  });

  test('creates variables when missing and updates them when they exist', () => {
    const created = run([], { GH_REPO: 's/r', RENDER_SERVICE_ID: 'srv-1', STAGING_URL: 'https://x.test', FAKE_VARIABLE_EXISTS: '0' });
    expect(created.stdout).toContain('variable RENDER_SERVICE_ID: created');
    expect(calls()).toContain('--method POST repos/s/r/environments/staging/variables');

    fs.writeFileSync(log, '');
    const updated = run([], { GH_REPO: 's/r', RENDER_SERVICE_ID: 'srv-1', FAKE_VARIABLE_EXISTS: '1' });
    expect(updated.stdout).toContain('variable RENDER_SERVICE_ID: updated');
    expect(updated.stdout).toContain('variable STAGING_URL: PENDING');
  });

  test('stores secrets through gh without ever printing their value', () => {
    const result = run([], { GH_REPO: 's/r', RENDER_API_KEY: 'rnd_super_secret_value', DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/secret' });

    expect(result.stdout).toContain('secret RENDER_API_KEY: stored (env)');
    expect(result.stdout).toContain('secret DISCORD_WEBHOOK_URL: stored (repo)');
    expect(result.stdout + result.stderr + calls()).not.toContain('rnd_super_secret_value');
    expect(calls()).toContain('secret set RENDER_API_KEY --env staging --repo s/r');
    expect(result.stdout).toContain('secret CODECOV_TOKEN: PENDING');
  });

  test('--dry-run changes nothing', () => {
    const result = run(['--dry-run'], { GH_REPO: 's/r', RENDER_API_KEY: 'k', RENDER_SERVICE_ID: 'srv' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[dry-run] gh api --method PUT repos/s/r/branches/main/protection');
    expect(calls()).toBe('');
  });

  test('fails on an unknown argument', () => {
    expect(run(['--force']).status).toBe(2);
  });
});
