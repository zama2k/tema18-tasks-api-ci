/**
 * Tells the CD whether the commit it is about to deploy is still the tip of the branch.
 *
 *   GITHUB_TOKEN=... node scripts/check-superseded.js --repo owner/name --branch main --sha <head_sha>
 *
 * GitHub keeps a single pending run per concurrency group and cancels the older pending ones,
 * but a run that was already queued behind a long deploy can still start after a newer commit
 * reached the branch. Deploying it would put OLDER code on top of a newer deploy, so it stops.
 *
 * Output (GITHUB_OUTPUT): superseded=true|false. If the GitHub API cannot be queried the check
 * fails open (superseded=false plus a warning): missing a deploy is worse than a redundant one.
 */
const { parseArgs, setOutput, appendSummary, annotate } = require('./lib/util');

async function findBranchTip({ apiUrl, repo, branch, token, fetchImpl = fetch }) {
  const response = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}/repos/${repo}/commits/${encodeURIComponent(branch)}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`GitHub API answered HTTP ${response.status}`);
  const body = await response.json();
  if (!body || !/^[0-9a-f]{40}$/.test(String(body.sha))) throw new Error('GitHub API returned no commit sha');
  return body.sha;
}

async function main(argv, env = process.env, fetchImpl = fetch) {
  const options = parseArgs(argv);
  const { repo, branch = 'main', sha } = options;
  if (!repo || !sha) throw new Error('--repo and --sha are required');

  let tip;
  try {
    tip = await findBranchTip({
      apiUrl: env.GITHUB_API_URL || 'https://api.github.com',
      repo,
      branch,
      token: env.GITHUB_TOKEN,
      fetchImpl,
    });
  } catch (error) {
    annotate.warning(`Could not check whether ${sha.slice(0, 7)} is still the tip of ${branch} (${error.message}); deploying anyway.`);
    setOutput('superseded', 'false', env);
    return 0;
  }

  if (tip === sha) {
    process.stdout.write(`${sha.slice(0, 7)} is the tip of ${branch}: deploying.\n`);
    setOutput('superseded', 'false', env);
    return 0;
  }

  annotate.notice(`${sha.slice(0, 7)} was superseded by ${tip.slice(0, 7)} on ${branch}: skipping this deploy so older code does not overwrite a newer one.`);
  appendSummary(`### Deploy skipped\n\`${sha}\` is no longer the tip of \`${branch}\` (now \`${tip}\`). The newer commit has its own CI and CD run.`, env);
  setOutput('superseded', 'true', env);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      annotate.error(error.message);
      process.exitCode = 1;
    },
  );
}

module.exports = { findBranchTip, main };
