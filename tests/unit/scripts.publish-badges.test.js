const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '../../scripts/publish-badges.sh');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function hasBash() {
  try {
    execFileSync('bash', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Hermetic: the "remote" is a bare repository in a temp folder, nothing leaves the machine.
(hasBash() ? describe : describe.skip)('publish-badges.sh', () => {
  let root;
  let origin;
  let work;
  let badges;

  const publish = (sha) =>
    execFileSync('bash', [SCRIPT, badges], { cwd: work, encoding: 'utf8', env: { ...process.env, GITHUB_SHA: sha } });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'badges-'));
    origin = path.join(root, 'origin.git');
    work = path.join(root, 'work');
    badges = path.join(root, 'out');

    git(root, 'init', '--quiet', '--bare', origin);
    git(root, 'clone', '--quiet', origin, work);
    git(work, 'config', 'user.name', 'test');
    git(work, 'config', 'user.email', 'test@example.test');
    fs.writeFileSync(path.join(work, 'README.md'), 'main branch content\n');
    git(work, 'add', '.');
    git(work, 'commit', '--quiet', '-m', 'init');
    git(work, 'branch', '-M', 'main');
    git(work, 'push', '--quiet', 'origin', 'main');

    fs.mkdirSync(badges);
    fs.writeFileSync(path.join(badges, 'coverage.json'), '{"message":"91%"}\n');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('creates the orphan badges branch on the first run, with only the badge files', () => {
    publish('abcdef1234567');

    expect(git(origin, 'ls-tree', '-r', '--name-only', 'badges')).toBe('coverage.json');
    expect(git(origin, 'log', 'badges', '--format=%s')).toBe('chore(badges): update from abcdef1');
    expect(git(origin, 'rev-list', '--max-parents=0', 'badges')).not.toBe(git(origin, 'rev-list', '--max-parents=0', 'main'));
  });

  test('is idempotent: unchanged badges produce no new commit', () => {
    publish('1111111');
    const output = publish('2222222');

    expect(output).toContain('already up to date');
    expect(git(origin, 'rev-list', '--count', 'badges')).toBe('1');
  });

  test('adds a commit when a badge changes and leaves no local branch or worktree behind', () => {
    publish('1111111');
    fs.writeFileSync(path.join(badges, 'coverage.json'), '{"message":"95%"}\n');
    fs.writeFileSync(path.join(badges, 'mutation.json'), '{"message":"85%"}\n');
    publish('2222222');

    expect(git(origin, 'show', 'badges:coverage.json')).toContain('95%');
    expect(git(origin, 'ls-tree', '-r', '--name-only', 'badges').split('\n').sort()).toEqual(['coverage.json', 'mutation.json']);
    expect(git(work, 'branch', '--format=%(refname:short)')).toBe('main');
    expect(git(work, 'worktree', 'list').split('\n')).toHaveLength(1);
  });

  test('fails with a clear message when the directory does not exist', () => {
    expect(() =>
      execFileSync('bash', [SCRIPT, path.join(root, 'missing')], { cwd: work, stdio: 'pipe', encoding: 'utf8' }),
    ).toThrow(/directory not found/);
  });
});
