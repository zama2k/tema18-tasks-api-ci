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
