---
name: iss0016-bytes-unchanged-proxy-assertion
description: ISS-0016's "all other payload bytes unchanged" clause is guarded only by .toEqual on parsed JSON, so a byte-format regression (pretty-print) stays green
metadata:
  type: project
---

# ISS-0016 transcript-replay wrapper: bytes-unchanged clause tested by a semantic proxy

Criterion 4 requires the substitution wrapper rewrite `transcript_path` "with all other payload
bytes unchanged." Both guard tests verify this by destructuring `transcript_path` out and comparing
the REST with `expect(deliveredRest).toEqual(originalRest)` — deep-equality of PARSED objects, not
bytes:
- `tests/acceptance/ISS-0016/transcript-replay-wrapper.test.ts:121`
- `tests/unit/fixtures.test.ts:239`

**Proven vacuous for the byte clause (2026-07-16):** mutate the wrapper's
`return JSON.stringify(payload);` (transcriptReplay.ts:44) to `JSON.stringify(payload, null, 2)` —
every delivered payload becomes multi-line, changing nearly every "other byte" — and BOTH tests stay
GREEN (14/14). The skip-rewrite mutant (M3) and event-list/version/containment mutants (M1,M4a-c)
all DO redden, so the suite isn't dead generally; only the byte-exactness clause is unguarded.

**Why it matters downstream:** the capture hook appends the payload verbatim, one record per line.
A wrapper regression to multi-line delivery would break the spool's one-record-per-line invariant,
and this test could not catch it.

**The real implementation is byte-faithful** (verified: JSON.parse→set transcript_path→JSON.stringify
reproduces the original bytes for all 136 committed lines across 8 streams, because the fixtures are
compact ASCII with standard escaping). So the criterion IS met by the code; the finding is S2
test-strength, not S1 noncompliance. To bite, the test must compare the delivered LINE bytes against
the original line with only the transcript_path value substituted.

Everything else on the branch held under execution: byte-verbatim law (clean git after full 245-test
suite), event lists re-derived from streams (jq match), recovered pairs null oracle, unknown/stream-
only scenario throws loudly, buildSubstitutedTranscript fails loudly (no fabrication) on a scenario
with no transcript pair. Gates green (typecheck/test/build exit 0).
