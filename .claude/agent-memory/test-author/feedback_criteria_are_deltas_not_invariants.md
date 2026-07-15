---
name: criteria-are-deltas-not-invariants
description: Every mapped acceptance criterion must be a DELTA — red at the issue's base ref, green only when this issue's change lands. A criterion that is already green at base is an invariant restatement; red-verify bounces it as a test_author_defect. PRD-0001 logged five of these (ISS-0009 burned three authoring rounds; ISS-0008's first attempt timed out at 49 minutes and returned empty structured output).
metadata:
  type: feedback
---

**Why:** the harness runs every mapped test at the issue's base ref before
dispatching the implementer. Green-at-base means the test cannot prove the
issue's work happened — it is either an invariant (something already true,
which belongs in reviewer prose, not criteria) or an unfalsifiable test.
ISS-0009 shipped three criteria of which two were invariants; it took two
red-verify bounces and a spec amendment ("reduce to ONE delta criterion")
to converge.

**How to apply:**

- Before submitting mappings, execute each mapped test at BASE. Green →
  drop it or fix it. Do not map more criteria by writing looser tests.
- Falsifiability patterns that drew reviewer S1/S2s this campaign:
  - Resolve fixtures/manifests at a FIXED path — a fuzzy repo walk taking
    `candidates[0]` passed against a planted decoy (ISS-0002 S1).
  - Assert exact expected values — `toBeTruthy()` on a version stamp and
    `length > 0` on an event list accept fabrications (ISS-0002 S2).
  - Concurrency needs N real spawned processes — `Promise.all` over a
    synchronous body runs serially and cannot catch a lost update
    (ISS-0010 S2, twice).
  - Exercise the artifact that ships (the `bin` target, through a symlink
    where relevant), never a wrapper next to it.
  - No machine-specific assertions — ISS-0008's sha-render test asserted a
    value only true on the authoring machine and shipped red everywhere else.
- The standing mutation rule (docs/gotchas.md): could this test fail if
  the bug were present? Prove it — revert the fix, watch red, restore.
