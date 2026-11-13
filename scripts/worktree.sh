#!/usr/bin/env bash
# Create or reopen an isolated issue checkout without changing the caller's branch or files.
#
# Branches follow AGENTS.md's `issue/<issueId>` convention; checkouts live at
# `.worktrees/issue-<issueId>` under the primary checkout, whichever checkout runs the
# helper (docs/worktrees.md).
set -euo pipefail

usage() {
  echo 'Usage: bash scripts/worktree.sh <issue>'
  echo 'For example 84, which checks out branch issue/84 at .worktrees/issue-84.'
}

if [[ "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  usage
  exit 0
fi

if [[ $# -ne 1 || ! "$1" =~ ^[0-9]+$ ]]; then
  usage >&2
  exit 1
fi

issue="$1"
branch="issue/$issue"

common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
if [[ "$(git -C "$common_dir" rev-parse --is-bare-repository)" == true ]]; then
  # A bare clone has no primary checkout: keep worktrees inside it, beside its other checkouts.
  primary_dir="$common_dir"
else
  primary_dir="$(dirname "$common_dir")"
fi
target="$primary_dir/.worktrees/issue-$issue"

if [[ -e "$target" || -L "$target" ]]; then
  echo "Path already exists: $target. Inspect it with git worktree list before continuing." >&2
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/$branch"; then
  # Git refuses if another worktree already has this branch checked out.
  git worktree add "$target" "$branch"
else
  # Fail on fetch errors rather than silently creating a branch from stale main.
  git fetch origin main:refs/remotes/origin/main
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null; then
    # Someone already pushed this branch: continue their work rather than fork it from main.
    git fetch origin "$branch:refs/remotes/origin/$branch"
    git worktree add --track -b "$branch" "$target" "refs/remotes/origin/$branch"
  else
    git worktree add --no-track -b "$branch" "$target" refs/remotes/origin/main
  fi
fi

printf '\nWorktree ready on %s at:\n  %s\n\nNext:\n' "$branch" "$target"
printf '  cd %q\n' "$target"
printf '  pnpm install --frozen-lockfile\n'
printf '\nIgnored files such as .env are not copied. See docs/worktrees.md.\n'
