---
name: feedback-invert-merge-two-path
description: Inverting an idempotent merge-not-clobber write (e.g. uninstall undoing init) needs TWO paths, not one -- blind snapshot restore destroys edits made after the write you're undoing, and "no backup record" must mean "leave alone", never "delete".
metadata:
  type: feedback
---

ISS-0022 (coreartifact uninstall) round 1 shipped green against the locked
acceptance suite but drew two S1 findings on manual review, both from the
same root cause: treating "invert init's merge" as a single unconditional
rule instead of a decision that depends on what happened *between* init and
uninstall.

## Rule 1: no backup record means "not ours", never "safe to delete"

The first attempt's fallback for a settings/gitignore path with no entry in
the install-backup manifest was `unlinkSync`. Two real paths hit that
fallback and both were destructive: a worktree added *after* init (its
`.claude/settings.local.json`/`.gitignore` were never captured, by
construction — init.ts's own comment says such a worktree "stays
uncaptured until ... init is re-run"), and a damaged/unparseable backup
manifest (readBackupFile's own catch folds to `{ entries: {} }` on purpose,
so a corrupt file silently drops every capture without erroring).

**Fix:** a missing entry means "we don't know if this is ours" — skip it
entirely, don't restore, don't delete. This directly matches
docs/gotchas.md #5 ("fail toward we don't know, never destructive") but is
easy to miss because the *positive* case (`entry.existed === true/false`)
reads as if it's already exhaustive — the undefined-entry case is a third
state the type system doesn't force you to handle if you write
`entry?.existed ? A : B` instead of checking `entry` itself first.

## Rule 2: "invert the write" needs an untouched-vs-edited branch

The second finding: restoring the pre-init snapshot verbatim is only
correct if nothing touched the file *after* the write being undone. A real
Claude Code session commonly adds a `permissions` key to
`.claude/settings.local.json` mid-session — restoring the pre-init snapshot
verbatim in that case silently discards the permissions grant (and any
other post-init edit, e.g. a user's own later `.gitignore` line).

**Fix pattern — compute, compare, branch:**
1. Extract the ORIGINAL merge into a pure function with no side effects
   (here: `applyHookConfig`/`computeGitignoreOutput`, split out of
   `mergeHookConfig`/`ensureGitignoreLines` which also carry the
   backup-capture side effect — see
   [[reference_backup_via_shared_pure_function_side_effect]]).
2. At undo time, recompute "what the original write would have produced"
   from the pre-write snapshot using that same pure function.
3. Compare the file's CURRENT bytes to that recomputed output.
   - Equal (untouched since the write): restore the pre-write snapshot
     VERBATIM — safe, and the only way to get byte-identical formatting
     back.
   - Different (edited since): the snapshot is stale. Write an INVERSE
     pure function (here: `removeHookConfig`/`removeGitignoreLines`) that
     strips only the entries the original merge would have added, from the
     CURRENT bytes, preserving every other edit. This will not be
     byte-identical to any prior state, but it's the only non-destructive
     option once the file has diverged.
4. The inverse function needs the pre-write snapshot too, not just the
   current bytes — to know whether an emptied key should be deleted (it
   didn't exist pre-write) or kept as an empty container (it did).

**Why this is easy to miss:** the acceptance suite's own "byte-identical"
tests only exercise the untouched case (init → fixture replay → uninstall,
with nothing touching settings.local.json in between) — fixture replay
through the hook artifact never edits `.claude/settings.local.json`, only a
live Claude Code session or a manual edit does. A locked acceptance suite
can go green while this bug ships; it was only caught by hand-executing the
realistic "session grants itself permissions mid-run" scenario the
acceptance harness structurally cannot simulate.

**How to apply:** whenever an issue's job is "undo what an idempotent
merge/append operation did", resist writing a single unconditional
restore-from-backup path. Ask: could ANYTHING have touched this file
between the write and the undo, through a channel my test harness doesn't
exercise (a real session, a human, another tool)? If yes, split the pure
merge logic out of the write-side command (even if that file is outside
your write-guard — extract only the pure half, per
[[reference_backup_via_shared_pure_function_side_effect]]), write its
inverse, and branch on equality-to-recomputed-output before choosing
verbatim-restore vs. surgical-strip. Mutation-test both branches: revert
your fix, confirm a test goes red for a worktree/repo state with NO backup
entry, and confirm a second test goes red for a file edited after the
original write.
