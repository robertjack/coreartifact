---
name: dynamic-reason-builder-vs-length-validator-edge
description: A classifier that builds a validated string dynamically (prefix + observed value) and a separate closed-vocabulary validator checking `reason.length > PREFIX.length` will silently disagree the instant the observed value can be an empty string — the empty-string cell is exactly the one every "clear"-only test suite misses.
metadata:
  type: feedback
---

ISS-0025 review round: `classifySessionKind` (src/ingest/drift.ts) built a
per-source absence reason as `PREFIX + source` for any non-"startup"
source. `setAbsence`'s `isValidReason` (src/core/absence.ts) validated that
family with `reason.startsWith(PREFIX) && reason.length > PREFIX.length` —
correct for every source value used in testing ("clear") but WRONG the
moment `source` is `""`: the classifier emits the bare prefix, the
validator's own length check rejects it, `setAbsence` throws INSIDE the
ingest transaction, and (per this codebase's fold/rollback design) the
entire repo's ledger reads zero sessions forever after — re-thrown on
every re-ingest attempt. Silent-because-`""`-is-falsy-but-still-a-string:
`typeof "" === "string"` passes every guard that only checks `typeof`.

**Why:** two boundary checks (a builder in one file, a length-based
validator in another) encode the same "must have SOMETHING after the
prefix" invariant independently. They agree by construction only if every
call site is tested with a non-empty value.

**How to apply:** whenever a classifier builds a reason/label as
`PREFIX + observedValue` and a separate validator gates on
`length > PREFIX.length` (or equivalent "non-empty suffix" check), always
fold the empty-string case to the same branch as "value absent entirely"
at the SOURCE (the classifier), not just in the validator — an unnameable
value is unnameable regardless of whether it's missing or empty. Then lock
the invariant with an end-to-end test that drives the classifier's real
output through the real validator (not two isolated unit tests each
using their own expectation), across an adversarial matrix that includes
`""`, and add at least two non-trivial dynamic values (not just the one
literal every other test already uses) to catch a builder that silently
ignores its own argument — see [[recorded-fixture-cwd-collides-with-live-sandbox-repo]]
for the sibling ISS-0025 fixture gotcha from the same issue.
