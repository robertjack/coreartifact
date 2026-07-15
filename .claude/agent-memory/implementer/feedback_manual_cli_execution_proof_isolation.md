---
name: manual-cli-execution-proof-isolation
description: Manually executing this repo's own CLI (dist/cli/bin.js) for verification is dangerous — it self-propagates (init writes hooks/settings/.gitignore into every sibling git worktree it can find), and the Bash tool's cwd silently defaults to the main checkout, not the worktree you're working in.
metadata:
  type: feedback
---

When proving a fix by execution (CLAUDE.md law — "verify by execution, not
assertion"), running this project's OWN built CLI as a subprocess against
real git repos is higher-risk than it looks, for two independent reasons
that compounded into one incident on ISS-0007:

1. **The Bash tool's cwd is NOT the worktree you Write/Edit files in.**
   Each Bash call defaults to the main checkout
   (`/Users/robbiejack/dev/coreartifact`) unless you explicitly `cd` into
   the worktree first *in that same command*. A stray verification command
   run without an explicit `cd "$WORKTREE_OR_TMPDIR" &&` prefix executes
   against the main repo, not the isolated tmpdir you intended.

2. **`coreartifact init` self-propagates across sibling git worktrees.**
   Because this project's own repo is itself an `init`-able coreartifact
   target, running `node dist/cli/bin.js init` from (or accidentally
   defaulting into) the main checkout writes `.coreartifact/`,
   `.claude/settings.local.json`, and appends to `.gitignore` — then
   **propagates the same settings file into every other worktree** git
   knows about (other `~/.aeh/worktrees/coreartifact/*` checkouts),
   exactly the "Do not touch other worktrees" boundary every rescue-dispatch
   task states explicitly.

**Why:** an errant `node dist/cli/bin.js init --cwd "$REPO"` (a flag that
doesn't exist and is silently ignored) ran with the Bash tool's default
cwd, initializing the real main repo and three sibling worktrees before the
mistake was caught via `git status --ignored`.

**How to apply:** every manual verification of this CLI must (a) put `cd
"$TMPDIR" &&` as the FIRST token of the same command that invokes the
binary — never rely on a prior `cd` in an earlier tool call persisting, and
never pass invented flags hoping they're ignored harmlessly, (b) after any
manual CLI run, immediately `git status --short --ignored` in the main repo
and every sibling worktree to catch leakage before it compounds, (c) if
leakage is found, check whether `.claude/settings.local.json` is untracked
and contains ONLY a `"hooks"` key (pure coreartifact-generated content,
safe to delete) before removing it — never blind-revert without confirming
you're not discarding real pre-existing content. See also
[[reference_tests_acceptance_writable_in_practice]] and
[[reference_rescue_dispatch_escalated_branch_not_on_main]] for other
"boundary looks obvious but isn't tool-enforced" cases in this repo.
