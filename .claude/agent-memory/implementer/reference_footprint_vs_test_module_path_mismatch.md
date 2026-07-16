---
name: reference-footprint-vs-test-module-path-mismatch
description: The test-author's guessed module filename and the decomposer's assigned write-footprint filename can disagree; the write-guard blocks fixing either side, so this is a hard blocker to surface, not implement around.
metadata:
  type: reference
---

ISS-0015 ("Global operator state"): the dispatch's declared write footprint
was `src/core/operatorState.ts`, but the acceptance test helper
(`tests/acceptance/ISS-0015/helpers.ts`, written earlier by the test-author
role) hardcoded `STATE_MODULE_PATH = "../../../src/core/state.js"` — a
different filename, guessed independently before the footprint was fixed.
Same story for the concurrency test's `dist/core/state.js` spawn target.

**Why this matters:** the write-guard hook enforces the footprint literally
per-file, not per-directory-prefix — attempting `Write` to
`src/core/state.ts` (outside the footprint) is blocked with a
"footprint violation" error, and editing the test's import path is
separately blocked with the "acceptance lock" error (see
[[reference_tests_acceptance_writable_in_practice]]'s 2026-07-16 update).
There is no tool-permitted way to reconcile a footprint/test filename
mismatch from inside a single implementer session — both sides of the fix
are guarded. Do not try to route around it (symlink via Bash, writing into
an allowed file that re-exports under a different name doesn't help either,
since the test uses a literal relative import path it resolves directly).

**How to apply:** the first time you read the acceptance test file, extract
every module path it imports/dynamically-imports (including strings built
for spawned child scripts, e.g. `dist/core/<name>.js`) and diff them against
your declared footprint's filenames *before* writing any implementation.
If they disagree on a filename, this is not something you can fix by
picking either name — implement fully and correctly against your actual
footprint anyway (so the real logic exists, typechecks, and has full unit
coverage), run the acceptance suite once to capture the exact failure
(expect every criterion to fail identically with a "not implemented yet:
<their-path>#<export>" style error, not a logic failure), and report the
mismatch as the headline open finding with both paths named verbatim so a
reviewer/test-author can reconcile it in one pass.
