---
name: iss-plan-lock-collision-1481fce
description: aeh 1481fce plan-time lock-collision scan — refactor is behavior-preserving (proven differential), impl correct, but ISS-1/ISS-10 exclusion boundary is UNPINNED (trailing-slash mutation survives the suite).
metadata:
  type: project
---

# aeh plan lock-collision scan (1481fce, feat/plan-lock-collision-scan)

Stacked on feat/acceptance-import-audit (PR #2). Refactors import-audit to export
`codeImportSpecifiers`/`sourceFilesUnder`; new src/lock-collision.ts scans prior-campaign
acceptance tests whose imports fall in a planned issue's footprint, appends an advisory
'## Prior-lock collisions' section to each issue spec before the plan-ready commit.

**Cleared by execution:**
- Lane 1 refactor behavior-preservation: built parent worktree, differential harness across 5
  adversarial cases (bare-package-repeat, from+dynamic same specifier, repo-rooted bare, span-first,
  leading-** footprint) → ZERO diff in violation lists. The hinted bare-package non-dedup is
  invisible in output (bare packages never produce violations). 28 import-audit tests green.
- Lane 2 corruption: parseIssueSpec survives append even with a body ending WITHOUT trailing newline
  (renderLockCollisionSection leads with "" → join injects a separating \n). spec.path is the
  worktree file; persistPlanRows does NOT store spec.body (only id/kind/risk/complexity/deps), and
  plan.json stores only {id,path}/criteria — no stale-body embed.
- Lane 3: ISS-1 plan does NOT exclude ISS-10 prior lock (trailing slash on `${id}/` saves it);
  escaping ../ targets dropped, no crash; bare packages only collide under implausible leading-**
  footprints (globToRegExp "**/*.ts" = `.*/[^/]*\.ts`, needs a slash; "@scope/pkg" would match but
  that footprint owns all TS — not realistic).

**FINDING (S2, test breadth gap):** the ISS-1/ISS-10 prefix-exclusion boundary is UNPINNED. The
only exclusion unit test (tests/lock-collision.test.ts:158) uses an EXACT id match (dir ISS-NEW1 ==
spec ISS-NEW1). Mutation: drop the trailing slash in `${ACCEPTANCE_ROOT}/${spec.id}/` (src/
lock-collision.ts:80) → self-exclude test still passes [] but ISS-10 gets wrongly excluded from an
ISS-1 plan. Proven on a dist-sibling mutant. Impl is correct; the guard is untested.

**S3 notes:** pin detection (exactPinsIn, L48-58) counts `.toEqual(`/`.toBe(` inside comments AND
string data (no span filtering) and records only the FIRST matcher per line — advisory noise, low
realism. Scan's escaping filter checks only `startsWith("../")` not `=== ".."` (audit checks both,
L420) — a "../../../.." import (5-up) yields target ".." unfiltered, but ".." matches no realistic
footprint. Both nil-impact.

**Genuine pins:** neuter appendLockCollisionSections → plan-lock-collision.test.ts:201 RED
(integration genuinely guards the wiring). Tree left clean at 1481fce.
