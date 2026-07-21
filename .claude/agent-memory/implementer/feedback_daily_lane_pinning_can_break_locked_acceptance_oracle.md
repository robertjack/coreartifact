---
name: daily-lane-pinning-can-break-locked-acceptance-oracle
description: A daily-lane price-table pin (claude-sonnet-5) collided with a read-only acceptance test that hardcodes the same model id as its "deliberately unpinned" example — implemented anyway, left the test red, reported it.
metadata:
  type: feedback
---

Daily-lane / ad-hoc tasks given directly by Robbie (not dispatched through
`aeh do`) still carry the same `tests/acceptance/**` read-only law as full
issue attempts — the Edit tool does NOT technically block the write in this
context (tested: a probe edit to
`tests/acceptance/ISS-0019/cost-enrichment.test.ts` succeeded), but the
system-prompt law still applies and was honored by reverting the probe and
leaving the file alone.

**The collision**: ISS-0019's own acceptance suite
(`tests/acceptance/ISS-0019/cost-enrichment.test.ts`) hardcodes
`claude-sonnet-5` as its literal example of "a model not in the pinned
price table" — the ISS-0019 spec doc even names it "deliberately unpinned
*this campaign*" (the wording anticipated it wouldn't stay that way
forever). When a later task legitimately pins claude-sonnet-5
(`src/core/priceTable.ts`, 2026-07-20, [[reference_daily_lane_sonnet5_pin_evidence]]),
that acceptance test flips from green to red — `cost_usd` now derives
instead of staying NULL — with **zero implementation defect**; the oracle
itself is stale.

**Why:** the acceptance test's assumption ("this model will never be
pinned") was never structurally guaranteed, just true at write-time. Locked
acceptance tests that embed a *temporal* fact (a deliberately-unpinned
model list) as a literal example are a standing collision risk with any
later change that makes the fact stop being true.

**How to apply:** when a daily-lane task's requested change would flip a
locked acceptance test red for reasons that are correct-per-the-new-truth
rather than a real regression, do NOT edit the acceptance file even though
the tool technically allows it in this non-`aeh do` context. Implement the
change in owned files, run the full gate suite to get an exact count of
what turned red, and report it as a named, headline finding for the human
to decide on (formal amendment vs. reverting the change) — do not silently
route around the read-only law just because nothing enforces it
mechanically here.
