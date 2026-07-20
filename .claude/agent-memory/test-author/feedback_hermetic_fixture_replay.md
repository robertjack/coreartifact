# Seed by fixture replay hermetically: pin cwd + transcript_path, every line

**What happened (PRD-0003, three independent hits):** recorded streams
carry the recording machine's absolute `cwd`/`transcript_path`, and the
leftovers still exist at those paths on this machine — a verbatim
replay attributed sessions into a stale repo and enriched an
"absent-transcript" session from a live leftover (ISS-0028's
escalation: the spend assertion read a leftover's 0.0558 instead of
the fixture oracle's 0.555957). HOME overrides do NOT shield this:
enrichment reads the payload's absolute path directly.

**How to apply:** every replayed line gets `cwd` pinned to the tmp repo
and, when the scenario touches cost, `transcript_path` pinned —
present case via `buildSubstitutedTranscript`, absent case via a
guaranteed-nonexistent path INSIDE the tmpdir (never "a path that
happens not to exist"). Copy ISS-0029's `seedLines` helper
(tests/acceptance/ISS-0029/session-and-freshness.test.ts), don't
re-derive. Assert the absent case's ABSENT value, not only its
absence-reason row (a fabricated 0 passed a suite that only checked
the reason — reviewer mutation, ISS-0029). Full class writeup:
docs/gotchas.md #8. Related: [[feedback_locked_test_contract]],
[[feedback_criteria_are_deltas_not_invariants]].
