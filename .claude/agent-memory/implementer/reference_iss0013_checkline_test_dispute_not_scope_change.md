---
name: iss0013-checkline-test-dispute-not-scope-change
description: ISS-0013's locked acceptance test tests/acceptance/ISS-0013/checkLine.test.ts imports a module (src/core/checkLine.ts) that the issue's own footprint never grants — this is a test-authoring bug (test_dispute), not a missing-footprint bug (scope_change); do not spend another attempt re-requesting the grant.
metadata:
  type: reference
---

Two consecutive implementer attempts on ISS-0013 (same `owns: [envelope.ts,
ledger.ts, tests/unit/core/checkLine.test.ts]`, `touches: [envelope.test.ts,
ledger.test.ts, index.ts]`) hit an identical wall:
`tests/acceptance/ISS-0013/checkLine.test.ts` dynamically imports
`"../../../src/core/checkLine.js"`, a path neither attempt's footprint
grants — confirmed by direct probe, the write-guard hook denies it verbatim
("footprint violation -- src/core/checkLine.ts is outside your declared
footprint").

**Why this is a test_dispute, not a scope_change.** The issue's own spec
(`docs/issues/ISS-0013.md`, the canonical TOML+prose file, not just
`.aeh-attempt.json`) is unambiguous: `owns` never lists `checkLine.ts`, and
the body text says only "Add a new discriminating entry point (suggested
name `parseSpoolLine`)" with no instruction to create a new file —
`parseSpoolLine`/`serializeCheckLine` were clearly designed to land in the
already-owned `envelope.ts` (the module that already owns spool-line
parse/serialize semantics). The acceptance test's hardcoded import to a
never-specified new module is inconsistent with the issue's own declared
footprint — a mechanical bug in test authoring (the test-author role's
attempt, commit `d71513f`), not evidence the footprint is genuinely too
narrow for the spec. Requesting a `scope_change` grant for
`src/core/checkLine.ts` would be granting access to satisfy a wrong test,
not a real implementation need.

**Why an implementer still can't just fix it.** The task's own instructions
say the ISS-0013 acceptance tests are LOCKED — "make them pass by changing
implementation, never by editing a test" — and this project's
[[reference_tests_acceptance_writable_in_practice]] memory only sanctions
editing inside `tests/acceptance/**` when a dispatch/spec *explicitly* calls
for that specific edit; this dispatch explicitly forbids it. So the correct
fix (changing the acceptance test's import from `checkLine.js` to
`envelope.js`) is outside any implementer attempt's power — it needs a
test-author/operator action, not another implementer redispatch with the
same footprint.

**How to apply:** if redispatched on ISS-0013 with this same footprint,
don't re-litigate whether to request scope_change — the correct ask (for
whoever can act on it) is fixing the acceptance test's import path, and the
right implementation home for `parseSpoolLine`/`serializeCheckLine` remains
`envelope.ts` (already fully implemented and unit-tested there as of commit
`8c9f9ad` — `tests/unit/core/checkLine.test.ts` mirrors every acceptance
scenario against the real functions). Spend the attempt re-verifying
correctness and looking for regressions instead of re-probing the same
write-guard wall.
