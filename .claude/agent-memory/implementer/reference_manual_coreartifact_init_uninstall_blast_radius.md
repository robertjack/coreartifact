---
name: manual-coreartifact-init-uninstall-blast-radius
description: Running `coreartifact init`/`uninstall` by hand without a hermetic HOME/registry override touches EVERY git worktree of this repo family (main + all aeh worktrees) via listOtherWorktreePaths, not just cwd — and `uninstall`'s own F108 baseline-stripping can look like it deleted a live dogfood config.
metadata:
  type: reference
---

Extends [[manual-cli-execution-proof-isolation]]. That memory already warns
"always `cd \"$TMPDIR\" && ...` in the same command." This is what happens
when you forget, concretely, with the exact recovery steps.

**What happened (ISS-0029 attempt, 2026-07-17):** ran `node dist/cli/bin.js
init` from inside the ISS-0029 worktree with no env override (real `$HOME`,
real `~/.coreartifact/registry.jsonl`). `init.ts`'s propagation loop
(`listOtherWorktreePaths(repoRoot)`) walks **every worktree of the same git
repo** — main checkout, every other `ISS-*`/`PRD-*` worktree — and
overwrites each one's `.claude/settings.local.json` to point at the
INITIATING worktree's own hook artifact + repoRoot. One misplaced `init`
call turns every sibling worktree's dogfood capture into "attribute
everything to ISS-0029."

**First fix layer (safe):** re-running `init` from the correct root (main
checkout) re-propagates the correct pointer everywhere — this alone would
have fully repaired it.

**Second mistake (much worse):** instead, ran `coreartifact uninstall
--yes` from the polluted worktree to "clean up" — this does NOT just
tombstone that one worktree. `uninstall` inverts THAT worktree's own
install-backup manifest (`.coreartifact/install-backup.json`, captured
by `captureInstallBackup` on ITS init call), which recorded a baseline for
repoRoot **and every sibling worktree**. Per the F108 fix
(`stripArtifactPollutionForBaseline`), if a settings file at capture time
ALREADY only contained coreartifact's own hook keys (true for a live
dogfood install with no other Claude Code settings), the recorded
"pre-init baseline" is `{}` (hooks stripped out) — because from that
manifest's point of view, `{}` genuinely IS what the file looked like
before coreartifact ever touched it. Restoring that baseline is CORRECT
uninstall semantics, but it means **running `uninstall` from ANY worktree
undoes the ENTIRE dogfood install across the whole worktree family**, not
just that one worktree's registration. Only the registry line for the
initiating worktree gets an explicit `remove` tombstone; every sibling's
settings.local.json goes back to `{}`/deleted.

**Recovery:** re-run `init` once more from the correct root (main
checkout) — this recreates the correct dogfood config everywhere again,
and the registry's fold-by-last-op-per-root means the earlier stray `add`
+ `remove` pair for the polluted worktree nets out to "not registered,"
which is what you want. Verify via `grep -o "capture.mjs' '[^']*'"` on
every sibling's `settings.local.json` (all should name the SAME root) and
by reading `~/.coreartifact/registry.jsonl` (last op per repo_root wins).

**How to apply:** NEVER run `init`/`uninstall` against the real `$HOME` to
"just check something." If you must exercise the real CLI outside a
`createTmpRepo()`-style hermetic sandbox, treat it as production: read the
registry/settings state FIRST, and if you break it, the fix is `init`
from the correct root — never `uninstall` as a "revert" impulse, since
uninstall's semantics are "remove forever," not "undo my last action."
