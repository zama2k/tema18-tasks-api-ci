/**
 * Reads the `image-digest` artifact written by the CI workflow and refuses to continue unless it
 * describes exactly the commit that is being deployed.
 *
 *   node scripts/resolve-image.js --file image-digest/image-digest.json --expect-sha <head_sha>
 *
 * Outputs (GITHUB_OUTPUT): image-ref (registry/repo@sha256:...) and digest.
 */
const fs = require('node:fs');
const { parseArgs, setOutput, appendSummary } = require('./lib/util');

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;

function resolveImage(record, expectedSha) {
  if (!record || typeof record !== 'object') throw new Error('image-digest.json is not a JSON object');
  if (!SHA.test(String(expectedSha))) throw new Error(`expected sha "${expectedSha}" is not a full 40 character commit`);
  if (record.sha !== expectedSha) {
    throw new Error(`the image was built from ${String(record.sha).slice(0, 7)}, but ${expectedSha.slice(0, 7)} is being deployed`);
  }
  if (!DIGEST.test(String(record.digest))) throw new Error(`digest "${record.digest}" is not a valid sha256 digest`);
  if (typeof record.image !== 'string' || !/^[a-z0-9.-]+(?::\d+)?\/[a-z0-9._/-]+$/.test(record.image)) {
    throw new Error(`image "${record.image}" is not a valid lowercase registry reference`);
  }
  return { imageRef: `${record.image}@${record.digest}`, digest: record.digest };
}

function main(argv, env = process.env) {
  const options = parseArgs(argv);
  if (!options.file || !options['expect-sha']) throw new Error('--file and --expect-sha are required');

  const record = JSON.parse(fs.readFileSync(options.file, 'utf8'));
  const { imageRef, digest } = resolveImage(record, options['expect-sha']);

  setOutput('image-ref', imageRef, env);
  setOutput('digest', digest, env);
  appendSummary(`### Image to deploy\n- Commit: \`${options['expect-sha']}\`\n- Image: \`${imageRef}\``, env);
  process.stdout.write(`Resolved ${imageRef}\n`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stdout.write(`::error::${error.message}\n`);
    process.exit(1);
  }
}

module.exports = { resolveImage, main };
