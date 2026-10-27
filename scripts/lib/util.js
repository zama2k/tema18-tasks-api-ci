/** Small helpers shared by the deployment scripts. Zero dependencies on purpose. */
const fs = require('node:fs');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff: base, 2*base, 4*base... capped at max. attempt starts at 1. */
function backoffDelay(attempt, baseMs, maxMs) {
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) {
      throw new Error(`invalid argument near "${argv[i]}"`);
    }
    options[argv[i].slice(2)] = argv[i + 1];
  }
  return options;
}

/** Appends `name=value` to the GitHub Actions output file (no-op outside Actions). */
function setOutput(name, value, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  fs.appendFileSync(env.GITHUB_OUTPUT, `${name}=${String(value)}\n`);
}

/** Appends markdown to the job summary (no-op outside Actions). */
function appendSummary(markdown, env = process.env) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

/** Workflow command annotations; messages are single line by construction. */
const annotate = {
  notice: (message) => process.stdout.write(`::notice::${oneLine(message)}\n`),
  warning: (message) => process.stdout.write(`::warning::${oneLine(message)}\n`),
  error: (message) => process.stdout.write(`::error::${oneLine(message)}\n`),
};

function oneLine(text) {
  return String(text).replace(/\r?\n/g, ' ');
}

/** Removes secrets from any text before it is logged or thrown. */
function redact(text, secrets) {
  return secrets
    .filter(Boolean)
    .reduce((out, secret) => out.split(secret).join('***'), String(text));
}

module.exports = { sleep, backoffDelay, parseArgs, setOutput, appendSummary, annotate, redact };
