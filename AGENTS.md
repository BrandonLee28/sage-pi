# Development instructions

Keep this a small application of Pi Durable, not another agent framework.
Prefer native Pi conversations, tools, documents, tasks, hooks, and storage.
Read node_modules/@earendil-works/pi-durable/README.md and the installed type
declarations before changing API usage. GitHub main may be newer than npm.

Use plain TypeScript on Node 24.2+ and the upstream Pi Durable demo TUI.
The user explicitly does not want a web UI. Do not add a web server or frontend.
Add dependencies only for a concrete missing capability. No new abstraction layer
for one implementation. Keep code readable to a human editing a single feature.

Instructions live in instructions/ as templates and data/workspace/ at runtime.
Never overwrite an existing runtime workspace during startup. Native Pi extension
modules go in extensions/. Never replace the native generation/tool loop.

Run npm run check and npm test after meaningful changes. npm run test:live uses
the real configured model and a disposable workspace. Do not send Telegram messages
or mutate real external accounts as part of automated tests.

The user has ADHD. Keep progress updates and final answers short and concrete.
Ask about missing user choices; continue independent work while waiting. Do not
silently expand scope or hardcode guessed services and credentials.

## Repository workflow — all coding agents

Read this file and CONTRIBUTING.md before making changes. These are development
rules; instructions/AGENTS.md is Sage's runtime template, not a substitute.

- Every change after the initial repository import goes through a pull request to
  main, including documentation, configuration, and dependency changes. Never
  commit or push directly to main, force-push main, or bypass repository checks.
- Start each independent feature or fix from current origin/main on a descriptive
  codex/<short-description> branch. One user outcome per PR; keep unrelated cleanup
  separate. If continuing an existing PR, use its branch instead.
- Inspect git status before editing. Preserve work already present. When another
  feature is in progress, use a separate Git worktree and branch; do not switch a
  shared checkout out from under another agent or use real data/ in test worktrees.
- Turn a feature into a small GitHub issue with a clear outcome and acceptance
  criteria when useful; an explicit chat request is enough for a small change.
  Do not invent a backlog, services, credentials, or product decisions.
- Prefer native Pi behavior and existing code. Add focused regression coverage for
  behavior changes, update relevant docs, and keep upstream vendor changes minimal
  with provenance notes. Do not add frameworks or dependencies speculatively.
- Run npm run check and npm test before handing over a PR. Report actual results
  and any checks not run. Keep test:live opt-in and local; never run it in CI or
  send Telegram messages, use real account credentials, or mutate external accounts
  during automated tests.
- Inspect the staged diff for secrets and unintended files before every commit.
  Never commit .env files (except the placeholder .env.example), runtime data,
  transcripts, uploads, databases, OAuth files, or private keys. Never copy real
  credentials into fixtures or PR descriptions.
- Open a PR using the template, link its issue when present, and state the user
  outcome, validation, and material limitations in plain language. Use a draft
  while work is incomplete; mark ready only when it is reviewable and checks pass.
- Leave merging to Brandon unless he explicitly asks an agent to merge that PR.
  Do not enable auto-merge, merge other features, change repository visibility,
  disable protections, or deploy as part of an ordinary feature request.
- Finish with the PR link, a short description of the result, and test status.
  All agents follow the same rules; tool-specific instruction files only point here.
