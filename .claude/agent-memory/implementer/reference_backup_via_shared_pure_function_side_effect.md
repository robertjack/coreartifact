When an issue needs to intercept file state BEFORE another owned-elsewhere
command overwrites it (e.g. uninstall needing init's pre-write bytes for
byte-identical restore), and the writing command's file (`init.ts`) is
outside your write-guard, look for a PURE function that command already
calls with the right identifying argument (here: `mergeHookConfig(...,
repoRoot)`, called before either of init's two writes, and before its
worktree-propagation loop even starts) and add the side effect there
instead — one capture at the first call point can cover every worktree too,
if you enumerate them yourself (`listOtherWorktreePaths`) rather than
relying on the caller to pass each one in.

Guard hard before doing this: existing unit tests may call that "pure"
function with fabricated, nonexistent paths (e.g.
`mergeHookConfig({}, "...", "/repo")` in hookConfig.test.ts) — an
unconditional `mkdirSync`/`writeFileSync` there will throw EACCES on `/`
and break them. `if (!existsSync(repoRoot)) return;` plus a wrapping
try/catch that never rethrows keeps the function inert for fake test roots
while still firing for real installs (repoRoot is always real by the time
this call happens, since resolveRepoRoot already validated it upstream).

Restore the backed-up content VERBATIM (`writeFileSync(path, rawString)`),
never by re-parsing and re-serializing (`JSON.stringify(obj, null, 2)`
always destroys the original's whitespace/formatting/trailing-newline
state — there is no way to recover that after the fact without a raw-bytes
backup taken before the first overwrite) -- **but only when nothing has
touched the file since the write you are inverting.** See
[[feedback_invert_merge_two_path]] for the correction: blind verbatim
restore is itself destructive against a file edited *after* the write you
are undoing (round 2 caught this as S1, twice).

**Why:** ISS-0022 (uninstall) needed byte-identical restoration of a
pre-existing `.claude/settings.local.json`/`.gitignore`, but `init.ts` was
not in the issue's owns/touches list — this cost the most reasoning of the
whole attempt, working out that a backup manifest was mathematically
required (not optional) and finding the one legal, test-safe hook point.

**How to apply:** any issue that must invert or observe another command's
write path without editing that command's own file — search for a shared,
already-imported helper function that receives enough identifying
arguments, and audit ALL of its existing unit tests for fabricated/fake
arguments before adding any I/O side effect to it.
