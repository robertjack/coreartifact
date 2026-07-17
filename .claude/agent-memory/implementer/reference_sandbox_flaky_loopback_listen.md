---
name: sandbox-flaky-loopback-listen
description: node:net server.listen("127.0.0.1") intermittently throws EPERM in this sandbox, independent of code changes — don't chase a false git-dirty correlation
metadata:
  type: reference
---

`tests/unit/cli/pingLinger.test.ts` (spins up a real `node:http`/`node:net`
server on 127.0.0.1 to test ping timing) intermittently fails the whole file
with an unhandled `Error: listen EPERM: operation not permitted 127.0.0.1`
in this Bash sandbox — same file, same code, alternating pass/fail across
consecutive runs with zero changes in between. Confirmed by running it 2x
back-to-back with an identical dirty tree: one run all-green, the next run
all-red.

**Why:** ISS-0021 attempt 2 (fixing two reviewer findings in
`src/cli/index.ts` and `src/doctor/version.ts`) burned real time chasing a
false lead — reverting `src/cli/index.ts` alone made the failure vanish
once, which looked like a causal link between the dispatcher change and the
network permission, but a same-code re-run then failed again. The same
session's `tests/acceptance/ISS-0009/packaging.test.ts` (`pnpm pack`) showed
the same pattern — looked git-dirty-correlated on a handful of runs, but is
almost certainly the same underlying flake class as
[[reference_pnpm_broken_in_sandbox]] (a sandboxed write/permission check
that intermittently denies) rather than caused by any particular diff.

**How to apply:** if a test that binds a real socket or shells out to
`pnpm` starts failing with `EPERM`/"unable to open database file" during an
otherwise-correct change, re-run it 2-3× on the exact same tree (no edits
between runs) before concluding your diff caused it. If the pass/fail
flips with zero code change, it's this sandbox flake — report it as an
observed, pre-existing environment limitation in structured output rather
than continuing to bisect files for a "cause."
