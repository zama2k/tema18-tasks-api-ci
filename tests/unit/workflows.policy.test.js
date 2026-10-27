/**
 * Static guard rails over the workflow files. They cannot replace running the pipeline on GitHub,
 * but they pin down mistakes that were already made once (and are cheap to catch locally).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '../..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/cd-staging.yml', '.github/actions/setup-project/action.yml'];

describe('third party actions', () => {
  test.each(WORKFLOWS)('%s pins every external action by full commit SHA', (file) => {
    const uses = [...read(file).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]).filter((ref) => !ref.startsWith('./'));

    expect(uses.length).toBeGreaterThan(0);
    for (const ref of uses) expect(ref).toMatch(/@[0-9a-f]{40}$/);
  });
});

describe('shellcheck', () => {
  test('CI runs a pinned shellcheck image, not the one preinstalled on the runner', () => {
    const ci = read('.github/workflows/ci.yml');

    expect(ci).toMatch(/koalaman\/shellcheck:v\d+\.\d+\.\d+ scripts\/\*\.sh/);
    expect(ci).not.toMatch(/run:\s*shellcheck\b/);
  });

  test('scripts silence the trap-invoked cleanup for old (SC2317) and new (SC2329) shellcheck', () => {
    for (const script of ['scripts/publish-badges.sh', 'scripts/verify-image.sh']) {
      expect(read(script)).toContain('# shellcheck disable=SC2317,SC2329');
    }
  });
});

describe('shell scripts in git', () => {
  test('every .sh is committed with the executable bit (workflows call them directly)', () => {
    const { execFileSync } = require('node:child_process');
    let listing;
    try {
      listing = execFileSync('git', ['ls-files', '-s', 'scripts/*.sh'], { cwd: ROOT, encoding: 'utf8' });
    } catch {
      return; // not a git checkout (e.g. a source archive): nothing to verify
    }
    const entries = listing.trim().split('\n').filter(Boolean);

    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (const entry of entries) expect(entry).toMatch(/^100755 /);
  });
});

describe('concurrency', () => {
  test('CI uses one group per commit on push and cancels only superseded PR runs', () => {
    const ci = read('.github/workflows/ci.yml');

    expect(ci).toContain("group: ci-${{ github.event_name == 'pull_request' && format('pr-{0}', github.event.pull_request.number) || github.sha }}");
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ci).not.toContain('github.ref }}\n');
  });

  test('CD never cancels a running deploy and documents that only the latest pending run waits', () => {
    const cd = read('.github/workflows/cd-staging.yml');

    expect(cd).toMatch(/group: deploy-staging\n\s+cancel-in-progress: false/);
    expect(cd).toContain('GitHub keeps only ONE pending run per group');
    expect(cd).not.toMatch(/never cancel[^\n]*queue up/i);
  });

  test('CD skips commits superseded on main before touching the image or Render', () => {
    const cd = read('.github/workflows/cd-staging.yml');
    const supersededAt = cd.indexOf('id: superseded');

    expect(supersededAt).toBeGreaterThan(-1);
    for (const step of ['Download the image digest', 'Resolve and validate the image', 'Deploy the image to Render']) {
      const stepAt = cd.indexOf(`- name: ${step}`);
      expect(stepAt).toBeGreaterThan(supersededAt);
      expect(cd.slice(stepAt, stepAt + 200)).toContain("steps.superseded.outputs.superseded != 'true'");
    }
  });
});
