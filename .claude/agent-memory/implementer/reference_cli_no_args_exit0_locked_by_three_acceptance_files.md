---
name: cli-no-args-exit0-locked-by-three-acceptance-files
description: cart/coreartifact with no args exiting 0 is NOT a free daily-lane fix — three locked acceptance test files hard-assert it
metadata:
  type: reference
---

`src/cli/index.ts`'s `main()`: no-command-at-all (`!commandName`) currently
writes usage to stdout and `process.exit(0)`. A pre-launch E2E flagged this
as wrong (should be a usage error, exit 1, stderr) and a daily-lane packet
asked for exactly that fix. Do NOT make this change without also updating
the locked tests — as of 2026-07-20 three tests/acceptance/** files
hard-assert `exitCode === 0` / `status === 0` for the no-args case:

- `tests/acceptance/harness.test.ts` (`noArgs.exitCode` toBe(0))
- `tests/acceptance/ISS-0001/cli.test.ts` (`noArgs.status` toBe(0))
- `tests/acceptance/ISS-0001/cli-symlink-and-atpath.test.ts` (2 tests, same assertion)

Confirmed by execution (full vitest run): changing the behavior alone
flips exactly these 4 tests red while everything else stays green.
tests/acceptance/** is read-only to an implementer — this is a genuine
test_dispute/scope-change situation, not a surgical daily-lane diff. The
correct move: revert the behavior change, leave the finding open, and file
it as a proper issue whose footprint covers both `src/cli/index.ts` and
the three locked test files (or dispatch it through whatever path can edit
locked acceptance tests).

**How to apply:** before touching this specific no-args behavior again,
grep for `noArgs` / `!commandName` usage across `tests/acceptance/**`
first — don't rediscover the conflict by running the full suite again.
