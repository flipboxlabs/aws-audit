---
name: worktree
description: Create, resume, prepare, or clean up issue worktrees in the aws-audit repository when arranging isolated checkouts for parallel agents. Use for worktree lifecycle tasks ("/worktree 84", "start issue 84 in a worktree", "clean up the 84 worktree"), not routine coding already inside an assigned worktree.
argument-hint: <issue> | cleanup <issue>
---

# Worktrees

Use the repository's [helper](../../../scripts/worktree.sh) for creation and the
[worktree guide](../../../docs/worktrees.md) for environment and cleanup details.
Follow [AGENTS.md](../../../AGENTS.md) for the project's git workflow. Resolve
these paths relative to this skill's directory, not the shell's current directory.

## Select or create the checkout

- Inspect `git status --short --branch` and `git worktree list --porcelain` before
  changing anything. Every checkout is for a GitHub issue: branch `issue/<id>` at
  `.worktrees/issue-<id>`. If the task has no issue yet, ask for one or open it
  before creating a worktree.
- If this session already owns the matching issue worktree, continue there. If
  the branch is checked out elsewhere (including older checkouts under
  `.claude/worktrees/`), use that checkout only when it is assigned to this
  session and no other agent is using it; a `locked` worktree belongs to a running
  session. Resolve unclear ownership before editing; do not create a second
  checkout of the same branch or reset it.
- Otherwise, run `bash scripts/worktree.sh <issue>` from the root of a checkout
  that contains the helper. It creates `issue/<id>` from freshly fetched
  `origin/main`, or reopens an existing local or pushed branch. Do not switch the
  caller's branch to main or clear another checkout's changes. Prefer the helper
  over Claude Code's or Codex's built-in worktree features, so every agent's
  checkouts land under `.worktrees/`.
- On a fetch failure, occupied branch, or existing destination, inspect the
  reported cause. Do not retry with a reset, forced checkout, or directory deletion.
- Use the absolute path printed by the helper for all subsequent task commands;
  verify its branch and status. From a linked checkout, worktrees are siblings
  under the primary checkout's `.worktrees`, not children of the current checkout.

## Prepare for the assigned task

Install with `pnpm install --frozen-lockfile` inside the selected worktree when
needed; do not share `node_modules`, `dist`, or `cdk.out`. Copy only the ignored
files the task needs (such as `.env`), without printing secrets.

Coordinate the AWS profile and environment before `cdk:deploy` or anything else
that touches shared resources. Worktree creation alone does not require
deployments, services, or additional agents.

Report the selected absolute path, branch, and any remaining environment setup.
Then continue the authorized issue work in that directory.

## Clean up when requested

Read the guide's cleanup section. Confirm the target is no longer in use (not
`locked`, no process running from it), inspect its status including ignored
files, and preserve needed local configuration and unintegrated work before
removing it. Run `git worktree remove <absolute-path>` from another checkout
without `--force`. If Git refuses, report what prevents removal instead of
bypassing the protection. Keep the branch unless its deletion is in scope and
its work is safely integrated. Do not remove a worktree merely because the
current coding turn ended.
