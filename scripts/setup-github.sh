#!/usr/bin/env bash
# One-shot, idempotent GitHub repository setup with the GitHub CLI (`gh`).
#
#   - protects `main`: pull request required, 1 approval, required status checks, no force-push
#   - creates the `staging` environment, limited to the `main` branch
#   - sets the non-secret environment variables (RENDER_SERVICE_ID, STAGING_URL)
#   - optionally stores secrets when the value is provided through the environment
#
# Usage:   scripts/setup-github.sh [--dry-run]
# Env:     GH_REPO            owner/name (default: the repository of the current directory)
#          RENDER_SERVICE_ID  Render service id, e.g. srv-xxxxxxxx           -> staging variable
#          STAGING_URL        public URL of the staging service              -> staging variable
#          RENDER_API_KEY     Render API key                                 -> staging secret
#          DISCORD_WEBHOOK_URL, CODECOV_TOKEN                                -> repository secrets
#          REQUIRED_CHECKS    comma separated job names (default: see below)
#
# Safe to re-run: every call either upserts or checks before creating.
# Secret values are read from the environment and piped to `gh`; they are never printed.
set -euo pipefail

dry_run=false
case "${1:-}" in
  --dry-run) dry_run=true ;;
  "") ;;
  *) echo "usage: setup-github.sh [--dry-run]" >&2; exit 2 ;;
esac

default_checks="CI OK,Lint,Unit tests (Node 18),Unit tests (Node 20),Unit tests (Node 22),Unit tests (Node 24),Integration tests,E2E tests (shard 1),E2E tests (shard 2),Mutation tests,Build image"
required_checks="${REQUIRED_CHECKS:-$default_checks}"

command -v jq >/dev/null 2>&1 || { echo "error: jq is not installed" >&2; exit 1; }
if [ "$dry_run" != true ]; then
  command -v gh >/dev/null 2>&1 || { echo "error: GitHub CLI (gh) is not installed" >&2; exit 1; }
fi

if [ -n "${GH_REPO:-}" ]; then
  repo="$GH_REPO"
elif [ "$dry_run" = true ]; then
  repo="zama2k/tema18-tasks-api-ci"
else
  repo="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
fi
echo "Repository: ${repo}"
[ "$dry_run" = true ] && echo "(dry run: nothing is changed)"

# Runs a mutating gh command, or only prints it in dry-run mode.
mutate() {
  if [ "$dry_run" = true ]; then
    echo "[dry-run] gh $*"
    cat >/dev/null || true
  else
    gh "$@" >/dev/null
  fi
}

# --- 1. Branch protection for main ------------------------------------------------------------
checks_json="$(printf '%s' "$required_checks" | jq -R 'split(",") | map(select(length > 0))')"

echo "Protecting main (checks: ${required_checks})"
jq -cn --argjson checks "$checks_json" '{
  required_status_checks: { strict: true, contexts: $checks },
  enforce_admins: false,
  required_pull_request_reviews: {
    required_approving_review_count: 1,
    dismiss_stale_reviews: true,
    require_code_owner_reviews: false
  },
  restrictions: null,
  required_conversation_resolution: true,
  allow_force_pushes: false,
  allow_deletions: false
}' | mutate api --method PUT "repos/${repo}/branches/main/protection" --input -
echo "  enforce_admins=false on purpose: with a single account the owner merges with admin bypass."

# --- 2. staging environment restricted to main ------------------------------------------------
echo "Creating environment: staging"
jq -cn '{ deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } }' \
  | mutate api --method PUT "repos/${repo}/environments/staging" --input -

if [ "$dry_run" = true ]; then
  has_main_policy=0
else
  has_main_policy="$(gh api "repos/${repo}/environments/staging/deployment-branch-policies" \
    --jq '[.branch_policies[] | select(.name == "main")] | length')"
fi
if [ "$has_main_policy" = "0" ]; then
  jq -cn '{ name: "main", type: "branch" }' \
    | mutate api --method POST "repos/${repo}/environments/staging/deployment-branch-policies" --input -
  echo "  deployment allowed only from: main"
else
  echo "  branch policy for main already present"
fi

# --- 3. Environment variables (not secret) ----------------------------------------------------
upsert_variable() {
  local name="$1" value="$2"
  local body
  body="$(jq -cn --arg name "$name" --arg value "$value" '{ name: $name, value: $value }')"
  if [ "$dry_run" = true ]; then
    echo "[dry-run] upsert staging variable ${name}"
    return 0
  fi
  if printf '%s' "$body" | gh api --method PATCH "repos/${repo}/environments/staging/variables/${name}" --input - >/dev/null 2>&1; then
    echo "  variable ${name}: updated"
  else
    printf '%s' "$body" | gh api --method POST "repos/${repo}/environments/staging/variables" --input - >/dev/null
    echo "  variable ${name}: created"
  fi
}

for name in RENDER_SERVICE_ID STAGING_URL; do
  if [ -n "${!name:-}" ]; then
    upsert_variable "$name" "${!name}"
  else
    echo "  variable ${name}: PENDING (export ${name} and run this script again)"
  fi
done

# --- 4. Secrets (values come from the environment, never from the command line) ---------------
set_secret() {
  local name="$1" scope="$2" # scope: "env" or "repo"
  if [ -z "${!name:-}" ]; then
    echo "  secret ${name}: PENDING (export ${name} and run this script again)"
    return 0
  fi
  if [ "$dry_run" = true ]; then
    echo "[dry-run] set ${scope} secret ${name}"
    return 0
  fi
  if [ "$scope" = "env" ]; then
    printf '%s' "${!name}" | gh secret set "$name" --env staging --repo "$repo" >/dev/null
  else
    printf '%s' "${!name}" | gh secret set "$name" --repo "$repo" >/dev/null
  fi
  echo "  secret ${name}: stored (${scope})"
}

set_secret RENDER_API_KEY env
set_secret DISCORD_WEBHOOK_URL repo
set_secret CODECOV_TOKEN repo

echo "Done. Review: https://github.com/${repo}/settings/branches and https://github.com/${repo}/settings/environments"
