/**
 * Sends the result of a deployment to a Discord channel through an incoming webhook.
 *
 *   DISCORD_WEBHOOK_URL=... node scripts/notify-discord.js \
 *     --status success|failure|skipped --sha <sha> --url <staging url> --run-url <actions run url> \
 *     [--digest sha256:...] [--deploy-seconds 83] [--actor user] [--details "text"]
 *
 * Webhook API (docs consulted 2026-10-27, see docs/plataformas.md): POST the JSON body to the
 * webhook URL; 204 No Content on success. Embed limits: title 256, description 4096, 25 fields,
 * field value 1024, 6000 characters in total.
 * Notification problems are warnings, never a failed pipeline.
 */
const { parseArgs, annotate, redact, sleep } = require('./lib/util');

const COLORS = { success: 0x2ecc71, failure: 0xe74c3c, skipped: 0x95a5a6 };
const TITLES = {
  success: 'Staging deploy succeeded',
  failure: 'Staging deploy FAILED',
  skipped: 'Staging deploy skipped',
};
const WEBHOOK_PATTERN = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

const clip = (text, max) => (String(text).length > max ? `${String(text).slice(0, max - 3)}...` : String(text));

function buildPayload({ status, sha, url, runUrl, digest, deploySeconds, actor, details, now = () => new Date() }) {
  if (!COLORS[status]) throw new Error(`unknown status "${status}" (expected success, failure or skipped)`);

  const fields = [{ name: 'Commit', value: `\`${String(sha).slice(0, 7)}\``, inline: true }];
  if (actor) fields.push({ name: 'Author', value: clip(actor, 100), inline: true });
  if (deploySeconds) fields.push({ name: 'Deploy time', value: `${deploySeconds}s`, inline: true });
  if (url) fields.push({ name: 'Staging', value: clip(url, 1000), inline: false });
  if (digest) fields.push({ name: 'Image digest', value: `\`${clip(digest, 80)}\``, inline: false });
  if (runUrl) fields.push({ name: 'Workflow run', value: `[Open the run](${runUrl})`, inline: false });

  return {
    username: 'Tasks API CI',
    embeds: [
      {
        title: TITLES[status],
        description: details ? clip(details, 1500) : undefined,
        url: runUrl || undefined,
        color: COLORS[status],
        fields,
        timestamp: now().toISOString(),
      },
    ],
  };
}

async function sendWebhook({ webhookUrl, payload, fetchImpl = fetch, sleepFn = sleep }) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- the original error may embed the secret URL
      throw new Error(`could not reach Discord: ${redact(error.message, [webhookUrl])}`);
    }

    if (response.status === 429 && attempt === 1) {
      const body = await response.json().catch(() => ({}));
      await sleepFn(Math.min(Number(body.retry_after || 1), 10) * 1000);
      continue;
    }
    if (response.status !== 204 && response.status !== 200) {
      throw new Error(`Discord answered HTTP ${response.status}`);
    }
    return;
  }
  throw new Error('Discord kept rate limiting the request');
}

async function main(argv, env = process.env) {
  const options = parseArgs(argv);
  const webhookUrl = env.DISCORD_WEBHOOK_URL;

  if (!webhookUrl) {
    annotate.notice('DISCORD_WEBHOOK_URL is not configured: skipping the Discord notification.');
    return 0;
  }
  if (!WEBHOOK_PATTERN.test(webhookUrl)) {
    annotate.warning('DISCORD_WEBHOOK_URL does not look like a Discord webhook URL: notification skipped.');
    return 0;
  }

  try {
    const payload = buildPayload({
      status: options.status,
      sha: options.sha || 'unknown',
      url: options.url,
      runUrl: options['run-url'],
      digest: options.digest,
      deploySeconds: options['deploy-seconds'],
      actor: options.actor,
      details: options.details,
    });
    await sendWebhook({ webhookUrl, payload });
    process.stdout.write(`Discord notification sent (${options.status}).\n`);
  } catch (error) {
    annotate.warning(`Discord notification failed: ${redact(error.message, [webhookUrl])}`);
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      annotate.warning(`Discord notification failed: ${redact(error.message, [process.env.DISCORD_WEBHOOK_URL])}`);
      process.exit(0);
    },
  );
}

module.exports = { buildPayload, sendWebhook, main, WEBHOOK_PATTERN, COLORS };
