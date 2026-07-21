---
name: reference-aeh-full-suite-runtime-needs-background
description: aeh repo's full `vitest run` (206 files / 781 tests as of PR #9) takes ~180s — exceeds Bash's 120s default timeout, always launch it with run_in_background.
metadata:
  type: reference
---

Running `node_modules/.bin/vitest run` with no filter against the aeh repo
(~/dev/aeh or a worktree of it) takes about 180 seconds wall-clock (206 test
files, 781 tests as of 2026-07-20 / PR #9 feat/dispatch-lock-feasibility).
That's over the Bash tool's 120s default timeout, so a plain foreground call
gets auto-backgrounded mid-flight anyway — cleaner to launch it with
`run_in_background: true` from the start and poll the output file with a
Bash until-loop (`while ! grep -q "Test Files" <file>; do sleep 3; done`)
rather than eating a forced-background surprise.

Single-file runs (`vitest run tests/<name>.test.ts`) are fast (under a
second) and fine to run in the foreground.

**How to apply:** [[reference_pnpm_broken_in_sandbox]] already establishes
using `node_modules/.bin/{tsc,vitest}` directly in this sandbox — combine
that with `run_in_background: true` for any unfiltered `vitest run` in the
aeh repo specifically.
