# Parallel work with Git worktrees

Each active issue gets its own directory, `.worktrees/issue-<id>`, on AGENTS.md's
`issue/<id>` branch. Worktrees share Git history and refs but have separate files,
indexes, dependencies, and build output. Start each agent in its assigned
directory.

## Create or resume an issue checkout

From the root of any checkout containing the helper:

```bash
pnpm worktree 84    # or: bash scripts/worktree.sh 84
```

This creates `<primary-checkout>/.worktrees/issue-84` on branch `issue/84`, made
from freshly fetched `origin/main`, and leaves the caller's branch and files
alone.

An existing local branch is reopened without resetting it, and a branch that
exists only on `origin` is checked out tracking it rather than restarted from
main. Git refuses a branch already checked out elsewhere; the helper rejects
existing destinations and stops on fetch failure. Inspect `git worktree list` to
locate an existing checkout and confirm its ownership before resuming there.

Use the absolute path printed by the helper. Even from a linked worktree, new
checkouts are siblings under the primary checkout's `.worktrees` directory, which
Git ignores. A bare clone has no primary checkout, so there they go under the
bare repository's own `.worktrees`. Uncommitted changes and ignored files are not
copied.

Older checkouts under `.claude/worktrees/` (Claude Code's own `--worktree`
location, also ignored) still work; finish them there. New ones go under
`.worktrees/`, so Claude Code and Codex sessions find each other's checkouts in
one place.

The project-local [worktree skill](../.agents/skills/worktree/SKILL.md) guides
this workflow for both Codex (`.agents/skills/`) and Claude Code
(`.claude/skills/worktree`, a symlink to it). For example:

> Use $worktree to prepare a worktree for issue 84. _(Codex)_
>
> /worktree 84 _(Claude Code)_

Use a checkout containing the skill. New branches from main inherit it.

## Prepare the environment

From the new worktree's root:

```bash
pnpm install --frozen-lockfile
```

Run installs from the worktree root, since `sdk` and `cdk` are workspace
packages. Do not symlink `node_modules`, `dist`, or `cdk.out` between checkouts;
pnpm still reuses downloaded packages from its store.

Git does not copy ignored files such as `.env`. Copy only what the task needs from
the primary checkout, without printing secrets.

## Coordinate shared environments

Worktrees do not isolate AWS accounts, deployed stacks, DynamoDB tables, or event
buses. Choose one owner for `pnpm cdk:deploy:dev` and anything else that changes
a shared environment, and check the AWS profile before every command. Do not
deploy merely to create a worktree.

## Review and cleanup

Run `pnpm check` and `pnpm test` as AGENTS.md asks, commit, push the issue branch
(`git push -u origin HEAD`), and open a PR targeting main. Keep edits and staging
inside the assigned worktree. Git config, refs, hooks, and the stash stack are
shared, so avoid changing repository-wide settings while other agents are
working. Agents must not push or merge to main.

When cleanup is requested and the checkout is no longer needed, confirm no other
agent is using it and preserve needed local files. From the primary checkout:

```bash
git worktree list
git -C .worktrees/issue-84 status --short --ignored
git worktree remove .worktrees/issue-84
```

Use Git's removal command without `--force`, not `rm -rf`. Git refuses while the
checkout has untracked or modified files; ignored files (`node_modules`, `dist`,
`.env`) are removed with it. A locked worktree (`git worktree list` says
`locked`) belongs to a running session; leave it. The branch remains; delete it
separately with `git branch -d issue/84` only when requested and its work is
safely integrated. Inspect any refusal instead of forcing deletion.
