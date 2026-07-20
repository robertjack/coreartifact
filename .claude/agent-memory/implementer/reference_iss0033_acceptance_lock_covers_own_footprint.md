---
name: iss0033-acceptance-lock-covers-own-footprint
description: ISS-0033's entire owns/touches footprint is inside tests/acceptance/** (harness + prior issues' migrated tests); the write-guard's acceptance_lock rule denies role=implementer there unconditionally, before even checking owns/touches — confirmed by direct probe, zero writes possible, genuine test_dispute case.
metadata:
  type: reference
---

ISS-0033 ("fold the cwd/transcript_path pin into the shared replay
harness") is a pure test-migration issue: `owns` is
`tests/acceptance/harness/fixtureReplayer.ts`,
`tests/acceptance/harness/index.ts`, `tests/fixtures/transcriptReplay.ts`,
`tests/acceptance/harness.test.ts`, `tests/acceptance/ISS-0033/hermetic-replay.test.ts`,
and six more `tests/acceptance/ISS-XXXX/*.test.ts` files; `touches` is ten
more of the same shape. Confirmed by direct Write/Edit probe (not just
reading the hook source): `write-guard.mjs`'s acceptance_lock check
(`role !== "test-author" && isAcceptanceLocked(relPath)`) fires and denies
UNCONDITIONALLY for `role: "implementer"`, before the owns/touches check
ever runs — so listing a `tests/acceptance/**` path in `owns` does NOT
grant write access to it. This matches
[[reference_tests_acceptance_writable_in_practice]]'s 2026-07-16 update
("the guard IS enforced now, and by role") but is a stronger case: that
memory covered one or two files in an otherwise-src-footprint issue; here
literally 100% of the deliverable sits behind the lock. Only
`tests/fixtures/transcriptReplay.ts` and `tests/unit/fixtures.test.ts` are
writable (not under `tests/acceptance/`), and neither is useful in
isolation: `transcriptReplay.ts`'s `replaySubstitutedTranscript`/
`buildSubstitutedTranscript` call `replayLines` imported from the locked
`fixtureReplayer.ts`, so they cannot adopt the new pin-target signature
without that file changing too.

**Why this is a test_dispute, not a scope_change.** A scope_change would
ask for MORE footprint; the footprint here is already exactly right per
the issue packet's `owns`/`touches` — the blocker is that the write-guard's
acceptance_lock rule doesn't recognize per-issue sanctioned exceptions
(the issue body's own words: "This issue's operator sanction to edit
locked tests extends exactly that far"). The tool-layer law and the
issue-packet's explicit sanction directly conflict. This is either a
dispatch bug (this issue should have run under `role: "test-author"`,
which the acceptance_lock check exempts unconditionally) or the
write-guard needs a per-issue override the packet can set. Route it as a
test_dispute / redispatch request, not a scope_change.

**How to apply:** if redispatched on ISS-0033 with the same
`role: implementer` and the same footprint, don't re-probe the write-guard
— it is deterministic (confirmed twice, both `Write` and `Edit`, on two
different files including a trivial single-line comment insertion). Spend
the attempt only on: (1) verifying the guard behavior is unchanged, (2)
refining the *design* recorded in this issue's own dossier (the full
target implementation for `fixtureReplayer.ts`'s new pin-aware
`replayLines`/`replayFixtures`/`replayFixturesParallel`/
`replaySubstitutedTranscript` signatures, the new `ingest`/`getSession`
harness helpers the locked ISS-0033 test requires, and the per-file
`transformLines`/`pinLineToRepo`/`seedLines` migration plan) so a
test-author-role or operator-authorized attempt can implement it in one
pass instead of re-deriving the design from the locked test file again.
