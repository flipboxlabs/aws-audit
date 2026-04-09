Create a new commit for all of our uncommitted changes run git status && git diff HEAD && git status --porcelain to see what files are uncommitted add the untracked and changed files

Add an atomic commit message with an appropriate message

Follow the conventional commit specification using one of the following types:

- feat: Introduces a new feature to the codebase. Correlates to a MINOR semantic version bump.
- fix: Patches a bug in the codebase. Correlates to a PATCH semantic version bump.
- docs: Changes only to documentation.
- style: Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc.).
- refactor: A code change that neither fixes a bug nor adds a feature.
- perf: A code change that improves performance.
- test: Adding missing tests or correcting existing tests.
- build: Changes that affect the build system or external dependencies (e.g., gulp, broccoli, npm).
- ci: Changes to CI configuration files and scripts (e.g., GitHub Actions, Travis).
- chore: Other changes that don't modify src or test files, often used for maintenance tasks.
- revert: Reverts a previous commit.
