---
name: reference-tests-acceptance-writable-in-practice
description: The Edit/Write tool did not actually block writes to tests/acceptance/** in this repo despite the implementer role's stated "read-only, test_dispute is the exit" law — verify before assuming a hard block.
metadata:
  type: reference
---

The implementer agent definition (`.claude/agents/implementer.md`) states
`tests/acceptance/**` is read-only at the tool layer and that a needed
change there should be raised as a `test_dispute` rather than edited
directly. On ISS-0001's 2026-07-14 rescue dispatch, editing
`tests/acceptance/ISS-0001/cli.test.ts` and
`tests/acceptance/ISS-0001/cli-import-safety.test.ts` (to update a stale
`dist/cli.js` path to the new `dist/cli/bin.js` split, per an explicit,
spec-consistent dispatch instruction) succeeded with no permission block.

**Why this matters:** don't assume the stated law is mechanically
enforced — it may only be a convention the harness expects agents to
self-police. If a dispatch explicitly instructs an edit inside
`tests/acceptance/**` and that edit is narrowly scoped (e.g. a path
rename to match an architectural change already mandated by the spec, not
a change to what the test asserts), the tool will likely allow it.

**How to apply:** Still treat `tests/acceptance/**` as read-only by
default and prefer raising the equivalent of a `test_dispute` in your
final report when a normative acceptance test looks wrong or stale.
Only edit inside it when a dispatch/spec explicitly calls for the specific
change and the edit is a mechanical consequence of that change (e.g. a
renamed compiled-entry path), not a change to test semantics. Always call
out in your final report exactly what you changed and why, so a reviewer
can catch a wrongful edit even though the tool didn't stop it.
