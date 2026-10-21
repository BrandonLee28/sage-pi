# Developing Sage Pi

Keep changes small enough to understand and merge independently. This is a personal
Pi Durable application: plain TypeScript, Node 24.2+, the upstream terminal UI,
and native Pi tools, tasks, documents, hooks, and storage. Read [AGENTS.md](AGENTS.md)
for the rules shared by humans and coding agents.

The gateway owns persistent Pi state and server services. The Mac client owns the
native TUI and audio. Keep the private terminal API small; it is not a web UI.

## Your high-level workflow

1. Describe a feature in chat or [open a feature request](https://github.com/BrandonLee28/sage-pi/issues/new/choose).
   State what you want to happen and how you will know it works.
2. The agent works on one feature branch, tests it, and opens a PR. Larger work
   should be split into independently useful PRs, with dependencies made explicit.
3. Review the PR's outcome, checks, and limitations. Ask for changes in the same
   chat or PR. Agents do not merge unless you explicitly ask them to merge that PR.
4. When satisfied and CI is green, choose **Squash and merge**. GitHub deletes the
   merged branch. Each merged PR becomes one entry in main's change history.

[Issues](https://github.com/BrandonLee28/sage-pi/issues) are the backlog;
[pull requests](https://github.com/BrandonLee28/sage-pi/pulls) show work underway
and ready for review. Use draft PRs for incomplete work. No separate develop branch
or release ceremony is needed. Merging does not deploy or restart the running agent.

## Start a change

Begin from a clean checkout. Preserve existing edits and continue an existing PR
on its own branch. For a new feature:

```sh
git switch main
git pull --ff-only origin main
git switch -c codex/short-feature-name
npm ci
```

For parallel features, leave the shared checkout alone and use separate worktrees:

```sh
git fetch origin
git worktree add ../sage-pi-short-feature -b codex/short-feature origin/main
cd ../sage-pi-short-feature
npm ci
```

Worktrees do not copy .env or data/. Automated tests use temporary workspaces and
mock services. Never point test worktrees at the running assistant's data directory.

## Validate and open a PR

```sh
npm run check
npm test
git diff
# Stage only the intended files, then inspect what will be published:
git add <changed-files>
git diff --cached
git commit -m "Describe the user-visible change"
git push -u origin HEAD
gh pr create --base main
```

Use the PR template and link the relevant issue with `Closes #123` when applicable.
For automation, use a body file with `gh pr create --body-file <file>` so the
description preserves its actual newlines. Report checks honestly; new behavior
needs focused coverage, while documentation changes do not need artificial tests.

CI installs the lockfile with npm ci, then runs npm run check and npm test on Node 24.
It runs for every PR to main and every push to main, without path filters, production
secrets, or live model/service tests. Third-party Actions are pinned to commit SHAs.

`npm run test:live` is a separate, explicitly requested local check against the
configured real model and a disposable workspace. Docker checks require a running
Docker daemon. Disclose any relevant validation you could not perform.

## Main and repository settings

The initial import bootstraps main. Every subsequent change, including docs and CI,
must use a PR. Repository settings allow squash merging only and delete merged
branches. Keep the repository private. Never commit credentials or runtime state;
only instruction templates and placeholder configuration belong in Git.

The intended main protection requires a PR, the `check-and-test` CI job on an
up-to-date branch, resolved review conversations, and linear history. It applies to
administrators and blocks force pushes and deletion. The required approval count is
zero because the owner and agents use the same GitHub identity; requiring the PR's
author to approve their own PR would block this solo workflow. Brandon's review
and merge remain the handoff policy in AGENTS.md.

Private-repository branch protections require a supported GitHub plan. Verify the
actual status under [branch settings](https://github.com/BrandonLee28/sage-pi/settings/branches);
if GitHub rejects protection, these rules remain agent instructions rather than a
server-enforced gate. Never make the repository public to enable protection.

GitHub ownership and agent instructions cannot distinguish Brandon from an agent
using his credentials. They are not separate permission identities.
