---
name: rescue-dispatch-escalated-branch-not-on-main
description: On a rescue/fix-findings dispatch, main may not contain the prior attempt's implementation at all -- check before assuming you're patching a diff.
metadata:
  type: reference
---

On ISS-0005's rescue dispatch, `main` only had doc/spec commits for the issue
-- the entire implementation (src/cli/commands/init.ts, src/install/**, the
acceptance/unit tests) existed solely on `escalated/ISS-0005-attempt-1`.
`git worktree add -b iss/ISS-0005 ... main` therefore started from a tree with
none of the code the findings referred to.

**How to apply:** on a rescue dispatch, before hunting for "the bug", diff
`git ls-tree -r main` against `git ls-tree -r escalated/<branch>` for the
owned paths. If files the findings describe don't exist on main at all, the
first step is bringing the whole implementation over (`git show
<branch>:<path> > <path>` per file), not just cherry-picking a targeted fix.
Only then read the diff between the escalated branch's fix commit and its
parent to see what the escalating reviewer already addressed vs. what's still
open -- see [[feedback_validate_before_transform_spool]] for another case
where reading the wrong slice of history wasted a turn.
