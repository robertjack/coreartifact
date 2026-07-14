---
name: git-gitdir-identity-discriminator
description: core.worktree presence, not --is-bare-repository, is the real ALLOWED/FORBIDDEN discriminator for gitdir-as-repo-root identity in src/core/attribution.ts — verified against real git 2.55.
metadata:
  type: reference
---

Verified fact about real git (2.55, macOS), load-bearing for
`src/core/attribution.ts` (ISS-0011) `validatedGitDirIdentity`.

When deciding whether a candidate gitdir (fed from `--git-common-dir`, never
from `git worktree list --porcelain`'s main entry — that output strips a
trailing `/.git`, see [[git-worktree-reverse-pointer-gotcha]]) is safe to use
as `repo_root`, `--is-bare-repository` is NOT a reliable ALLOWED signal on
its own:

| layout | `--is-bare-repository` | `core.worktree` |
|---|---|---|
| bare gitdir literally named `.git` (`git clone --bare url proj/.git`) | `true` | unset |
| `git init --separate-git-dir=EXTERNAL` gitdir | `false` (config explicitly has `core.bare = false`) | unset |
| submodule's `<super>/.git/modules/<name>` | `false` | **set** (`../../../<path>`) |

The only signal that actually separates ALLOWED (first two rows) from
FORBIDDEN (third row) is `core.worktree` presence — `git config --get
core.worktree` unset vs set. A discriminator gated on `--is-bare-repository
=== true` would wrongly reject the legitimate `--separate-git-dir` case,
since that layout is genuinely non-bare.

Also: with `core.worktree` set but pointing at a now-deleted directory
(e.g. the submodule checkout was `rm -rf`'d), essentially every git
subprocess run with cwd=that gitdir fails outright ("fatal: cannot chdir to
'../../../child'"), including `rev-parse --is-inside-git-dir` — so a corrupt
reverse pointer can never reach the `core.worktree` check at all; it's
caught earlier by the `tryGit` null return. Useful when trying to construct
a test that exercises the discriminator line itself with a submodule
candidate: a healthy submodule never reaches `validatedGitDirIdentity` in
the first place (its reverse pointer lets `validatedMainRoot` resolve first),
so testing the discriminator's rejection of the submodule-modules-dir case
requires calling the (exported-for-testing) function directly against a
real fixture, not going through the public `resolveAttribution` API.

`GIT_TEST_ASSUME_DIFFERENT_OWNER=1` is a real env var this git binary
honors to force the dubious-ownership refusal path without needing actual
differing file ownership — useful for exercising `safe.directory`-related
code, but it must itself be forwarded through whatever env-allowlist the
code under test uses, so it can't prove an allowlist addition (e.g.
`XDG_CONFIG_HOME`) end-to-end through a function that deliberately scrubs
unlisted vars. Test allowlist additions by exporting the scrub function and
asserting its output directly instead.
