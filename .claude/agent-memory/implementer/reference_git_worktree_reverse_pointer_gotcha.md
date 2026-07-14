---
name: git-worktree-reverse-pointer-gotcha
description: git can self-correct a submodule's gitdir back to its checkout, but NOT a --separate-git-dir or bare repo's gitdir — verified against real git 2.55, load-bearing for src/core/attribution.ts
metadata:
  type: reference
---

Verified fact about real git (2.55, macOS), load-bearing for any future work on
`src/core/attribution.ts` (ISS-0011) or similar worktree-discovery code.

From inside a **linked worktree**, `git worktree list --porcelain`'s first
("main") entry reports the **git directory**, not the checkout path, whenever
the git dir doesn't live at the conventional `<repo_root>/.git`. This is true
for both a submodule's checkout (`<super>/.git/modules/<name>`) and a
`git init --separate-git-dir` checkout (the external dir given to
`--separate-git-dir`).

The two cases then diverge sharply when you try to self-correct that gitdir
candidate back to a real checkout via
`git rev-parse --is-inside-work-tree --show-toplevel` (cwd = the candidate):

- **Submodule**: succeeds. `git submodule add` writes a reverse pointer file
  at `<super>/.git/modules/<name>/gitdir` back to the submodule's checkout, so
  git can walk from the gitdir back to the work tree.
- **`--separate-git-dir`**: fails with `fatal: this operation must be run in a
  work tree`. No reverse pointer file is ever written for this layout — git
  genuinely has no way to recover the original work dir from the external
  gitdir once you're only holding a linked-worktree's porcelain listing.
- **Bare main repo**: same failure, for the same reason (no work tree to
  point to at all). Its porcelain entry differs syntactically from the two
  above, though — it carries a `bare` marker line, so it can be told apart
  from the separate-git-dir case if that distinction ever matters.

Net effect: there is no pure-git way to recover a `--separate-git-dir` main
checkout's path from a linked worktree of it. Any resolver in this codebase
must treat that (and the bare case) as a genuine resolution failure and fall
back rather than fabricate — see [[feedback_validate_before_transform_spool]]
for the sibling principle applied elsewhere in this codebase (validate before
trusting, don't paper over an unresolvable state).
