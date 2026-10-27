const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findBranchTip, main } = require('../../scripts/check-superseded');

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);
const reply = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe('findBranchTip', () => {
  test('asks the commits API for the branch and returns its sha, sending the token', async () => {
    const fetchImpl = jest.fn(reply(200, { sha: NEW }));

    const tip = await findBranchTip({ apiUrl: 'https://api.github.test/', repo: 'o/r', branch: 'main', token: 'tkn', fetchImpl });

    expect(tip).toBe(NEW);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.github.test/repos/o/r/commits/main', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer tkn' }) }));
  });

  test('rejects HTTP errors and malformed bodies', async () => {
    await expect(findBranchTip({ apiUrl: 'https://x', repo: 'o/r', branch: 'main', fetchImpl: reply(404, {}) })).rejects.toThrow('HTTP 404');
    await expect(findBranchTip({ apiUrl: 'https://x', repo: 'o/r', branch: 'main', fetchImpl: reply(200, { sha: 'nope' }) })).rejects.toThrow('no commit sha');
  });
});

describe('main', () => {
  let dir;
  let env;
  let write;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superseded-'));
    env = { GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'sum'), GITHUB_API_URL: 'https://api.github.test' };
    write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    write.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const outputs = () => fs.readFileSync(env.GITHUB_OUTPUT, 'utf8');
  const printed = () => write.mock.calls.map((c) => c[0]).join('');

  test('deploys when the commit is still the tip of main', async () => {
    expect(await main(['--repo', 'o/r', '--sha', OLD], env, reply(200, { sha: OLD }))).toBe(0);
    expect(outputs()).toBe('superseded=false\n');
  });

  test('skips with a notice when a newer commit reached main', async () => {
    await main(['--repo', 'o/r', '--branch', 'main', '--sha', OLD], env, reply(200, { sha: NEW }));

    expect(outputs()).toBe('superseded=true\n');
    expect(printed()).toContain('::notice::aaaaaaa was superseded by bbbbbbb on main');
    expect(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain('Deploy skipped');
  });

  test('fails open with a warning when the API cannot be queried', async () => {
    expect(await main(['--repo', 'o/r', '--sha', OLD], env, reply(500, {}))).toBe(0);

    expect(outputs()).toBe('superseded=false\n');
    expect(printed()).toContain('::warning::');
    expect(printed()).toContain('deploying anyway');
  });

  test('requires --repo and --sha', async () => {
    await expect(main(['--repo', 'o/r'], env, reply(200, {}))).rejects.toThrow(/required/);
  });
});
