---
name: iss0023-reviewer-infra-crash-contract
description: aeh fix/reviewer-infra-crash-contract (commit 42797c9) — dispatchReviewToCompletion; verified clean, tests genuinely red-first
metadata:
  type: project
---

# aeh commit 42797c9 — crashed code review never counts as a passed round

Reviewed 2026-07-16. This is the aeh-harness fix for the S1 that ISS-0023 field
evidence exposed (reviewer dispatch error x2 → issue_merged 150ms later, zero
findings). NOT a coreartifact issue branch — it lives in `~/dev/aeh`.

**Verdict: clean. No S0-S3 findings.** Rare here; recorded because the hunt was
thorough and the negative result is load-bearing for future aeh reviews.

- `dispatchReviewToCompletion` (src/run-issue.ts:1113) routes BOTH review sites
  (per-round ~1526, terminal-guard ~1192). Happy path (no crash) calls
  dispatchAndRecord exactly once and returns — byte-identical to old behavior, so
  existing suites unaffected (ran run-issue.test + integration + gate-hardening =
  23 green).
- Shared `consecutiveInfra` across implementer+reviewer roles is CORRECT: every
  entry into a review has consecutiveInfra=0 because the implementer path resets
  it (line 1319) on success before any review, and the terminal guard is only
  reached via quality-fail advances (also post-reset). Traced all cross-role
  sequences; no wrong escalation or wrong reset.
- Spread `{ ...reviewSpec, cwd: retryWorktree, settingsPath }` is complete against
  DispatchSpec (dispatch.ts:13) — every field is constant or overridden; env is a
  port record, worktree-independent.
- Label `code-reviewer-${attemptN+1}` is collision-free: prepareLaunch is always
  immediately followed by exactly one dispatchAndRecord (which increments attemptN),
  so attemptN+1 == the next dispatch's n; attemptN is global/monotonic across roles.
- No worktree leak: on 2-crash null-return, lastReviewerWorktree = retryWorktree and
  the caller's cleanupReviewerWorktree removes it. On single-crash success, caller's
  later cleanup removes retryWorktree; original was removed inside the helper. The
  caller's local `reviewerWorktree`/`finalReviewerWorktree` vars are never used after
  the helper call.
- Fixed `-review` path recreation after removeWorktree does NOT collide — proven by
  the retry tests passing (they exercise crash→cleanup→reviewerCheckout same path).

**Mutation proof (executed):** checked out 42797c9^ into a scratch worktree, dropped
in the new test file, ran vitest — all 3 RED. Test 1: `expected 'merge_ready' to be
'escalated'` (the exact field failure). Tests 2/3: reviewer-dispatch length/infra
assertions catch "no retry". Test 3's state assertion alone is NOT load-bearing (its
round-2 footprint violation independently forces escalated) but its length=3 +
infra=2 assertions give it teeth. Unbounded-retry mutant fails via 120s timeout
(FakeDispatcher throw → dispatchAndRecord catch converts to error → infinite loop,
never escalates).

**Restore discipline:** used `git worktree add` in scratch (NOT swapping the tracked
file) to keep the repo tree read-only; `worktree remove --force` + prune after. Tree
verified clean at HEAD 42797c9.
