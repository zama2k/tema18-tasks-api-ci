const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveImage, main } = require('../../scripts/resolve-image');

const SHA = '0123456789abcdef0123456789abcdef01234567';
const DIGEST = `sha256:${'b'.repeat(64)}`;
const record = (overrides = {}) => ({ sha: SHA, digest: DIGEST, image: 'ghcr.io/owner/repo', ...overrides });

describe('resolveImage', () => {
  test('returns the image pinned by digest when the commit matches', () => {
    expect(resolveImage(record(), SHA)).toEqual({ imageRef: `ghcr.io/owner/repo@${DIGEST}`, digest: DIGEST });
  });

  test('refuses an image built from another commit (the bug of deploying a different HEAD)', () => {
    expect(() => resolveImage(record({ sha: 'f'.repeat(40) }), SHA)).toThrow(/built from fffffff, but 0123456 is being deployed/);
  });

  test.each([
    ['a short digest', { digest: 'sha256:abc' }],
    ['a tag instead of a digest', { digest: 'latest' }],
    ['uppercase repository', { image: 'ghcr.io/Owner/Repo' }],
    ['an image with a tag', { image: 'ghcr.io/owner/repo:main' }],
    ['a missing image', { image: undefined }],
  ])('rejects %s', (_label, overrides) => {
    expect(() => resolveImage(record(overrides), SHA)).toThrow();
  });

  test('rejects a non full-length expected sha and non-object records', () => {
    expect(() => resolveImage(record(), 'abc123')).toThrow(/40 character/);
    expect(() => resolveImage(null, SHA)).toThrow(/JSON object/);
  });
});

describe('main', () => {
  let dir;
  let write;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resolve-'));
    write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    write.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes the outputs consumed by the deploy step', () => {
    const file = path.join(dir, 'image-digest.json');
    fs.writeFileSync(file, JSON.stringify(record()));
    const env = { GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'sum') };

    main(['--file', file, '--expect-sha', SHA], env);

    expect(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8')).toBe(`image-ref=ghcr.io/owner/repo@${DIGEST}\ndigest=${DIGEST}\n`);
  });

  test('requires both arguments', () => {
    expect(() => main(['--file', 'x'], {})).toThrow(/required/);
  });
});
