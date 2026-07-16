---
name: iss0018-seq-computed-after-test-results
description: In src/ingest/index.ts, the seq recompute block runs AFTER the test_results insert block, so a naive "key on seq" mutant sees seq=0 for brand-new events, not a subtly-wrong-but-plausible value.
metadata:
  type: reference
---

`src/ingest/index.ts`'s per-ingest transaction computes `test_results` rows
(keyed correctly on `events.line_no`) BEFORE the "Seq: a per-session
presentation ordinal" block runs. So for a brand-new session in a single
ingest call, `events.seq` is still its just-inserted default (0) at the
point `test_results` would be computed — a "what if this were keyed on seq
instead" mutant test sees every claimed row collide at line_no=0 (only the
first survives via `ON CONFLICT DO NOTHING`), not a plausible-looking
off-by-a-few value. That's still a valid, sufficient red for a
seq-vs-line_no identity test (confirmed by execution: the mutant reddens
cleanly), but don't be surprised the failure mode is "no row found" rather
than "row found under the wrong line_no" — both prove the same thing.

The corrupt-spool-line technique for producing a real line_no/seq
divergence (a line matching `assignLineOrdinals`/ordinals.test.ts's
`"{this is not valid JSON}"` pattern, injected between two real events)
is the standard way to desync them in a unit test: it consumes a spool
ordinal but is never inserted into `events`, so every event after it in
that session gets `line_no > seq` for the rest of the session. See
`tests/unit/ingest/testResultsIdentity.test.ts` (ISS-0018 fix-mode F-B)
for the full pattern, including the mutant-proof-then-revert method.
