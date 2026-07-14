---
name: feedback-validate-before-transform-spool
description: In envelope/spool validation, run rejection checks (e.g. control-char scan) on the raw untransformed input before any normalizing transform (e.g. trim) — never after.
metadata:
  type: feedback
---

On ISS-0001 (2026-07-14 rescue dispatch, fixing finding V3), fixing
"`eventText` with whitespace padding must round-trip byte-identically" by
adding `.trim()` *before* the existing control-character rejection check
silently defeated an already-hardened invariant: `.trim()` strips `\n`
along with spaces, so a trailing-newline payload (the exact F1 multi-line
spool-corruption trap this codebase names by ID and has failed on three
times) passed the control-char check on the *trimmed* text and was wrongly
accepted, reintroducing the bug the trim was nowhere near touching.

**Why:** `String.prototype.trim()` removes all Unicode whitespace,
including control characters like `\n`, `\t`, `\r`. Any validation gate
meant to reject those control characters must run before a transform that
could remove the exact bytes it's checking for, or the gate becomes a
no-op for that failure mode.

**How to apply:** When adding a normalizing transform (trim, dedent,
collapse-whitespace, etc.) to satisfy a new round-trip/byte-identity
requirement in code that already has a rejection check for a subset of
what that transform would strip, order operations as: reject-checks on
raw input first, transform second, re-validate (e.g. JSON.parse) on the
transformed value last. Don't assume "add the transform, tests will catch
regressions" — this codebase's own contract prose (see
`docs/issues/ISS-0001.md`, "The trap, named") calls out that exact
regression class as the one that has defeated multiple attempts; treat it
as a standing checklist item whenever touching `serializeEnvelope`.
