#!/usr/bin/env bash
# Publishes the files of a directory (shields.io endpoint JSON) to an orphan "badges"
# branch, so README badges can point at raw.githubusercontent.com without third parties.
#
# Usage: scripts/publish-badges.sh <directory-with-json-files>
# Env:   REMOTE (default: origin), BADGES_BRANCH (default: badges), GITHUB_SHA (for the message)
set -euo pipefail

source_dir="${1:?usage: publish-badges.sh <directory>}"
remote="${REMOTE:-origin}"
branch="${BADGES_BRANCH:-badges}"
short_sha="$(printf '%s' "${GITHUB_SHA:-manual}" | cut -c1-7)"
temp_branch="badges-publish-$$"

[ -d "$source_dir" ] || { echo "::error::directory not found: $source_dir" >&2; exit 1; }
source_dir="$(cd "$source_dir" && pwd)"

scratch="$(mktemp -d)"
worktree="$scratch/wt"

cleanup_worktree() {
  git worktree remove --force "$worktree" >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
  git branch -D "$temp_branch" >/dev/null 2>&1 || true
}
# shellcheck disable=SC2317,SC2329 # invoked indirectly through the EXIT trap (SC2317: shellcheck < 0.10, SC2329: >= 0.11)
cleanup() {
  cleanup_worktree
  rm -rf "$scratch"
}
trap cleanup EXIT

# Every command is guarded with `|| return 1`: `set -e` is ignored inside `if publish_once`.
publish_once() {
  if git ls-remote --exit-code --heads "$remote" "$branch" >/dev/null 2>&1; then
    git fetch --quiet --depth=1 "$remote" "$branch" || return 1
    git worktree add --quiet --detach "$worktree" FETCH_HEAD || return 1
  else
    git worktree add --quiet --detach "$worktree" || return 1
    git -C "$worktree" checkout --quiet --orphan "$temp_branch" || return 1
    git -C "$worktree" rm -rf --quiet . >/dev/null 2>&1 || true
  fi

  cp "$source_dir"/*.json "$worktree/" || return 1
  git -C "$worktree" add -- '*.json' || return 1

  if git -C "$worktree" diff --cached --quiet; then
    echo "Badges are already up to date."
    return 0
  fi

  git -C "$worktree" -c user.name="github-actions[bot]" \
    -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    commit --quiet -m "chore(badges): update from ${short_sha}" || return 1
  git -C "$worktree" push --quiet "$remote" "HEAD:refs/heads/${branch}" || return 1
  echo "Badges published to ${remote}/${branch}."
}

# Two merges to main can race; the files are overwritten wholesale, so retrying is safe.
for attempt in 1 2 3; do
  if publish_once; then
    exit 0
  fi
  echo "::warning::publishing failed (attempt ${attempt}/3), retrying" >&2
  cleanup_worktree
  sleep "$attempt"
done

echo "::error::could not publish badges after 3 attempts" >&2
exit 1
