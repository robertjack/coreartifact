---
name: iss0015-home-override-dead-assertion
description: The "never touches the real home" acceptance assertion is vacuous when the test sets HOME and the registry-root override to the SAME tmp location
metadata:
  type: project
---

# The paths-override "real home" assertion that cannot bite (ISS-0015, executed 2026-07-16)

Criterion 4 ("state file lives under the overridable root, a subprocess never touches the
operator's real home") is verified in `tests/acceptance/ISS-0015/state.test.ts` by three
assertions, the load-bearing one being:

    expect(paths.state.startsWith(REAL_HOME_AT_LOAD)).toBe(false);   // state.test.ts:278

The escalation amendment (ISS-0015.md:110-121) claims it fixed this assertion to "actually
bite" by capturing `REAL_HOME_AT_LOAD = os.homedir()` at module load instead of inside the
test body. **It still does not bite.** `beforeEach` sets BOTH `process.env.HOME = tmpHome`
AND `COREARTIFACT_REGISTRY_ROOT = tmpHome/.coreartifact`. A mutant `paths.ts` that resolves
`state` from `homedir()` while IGNORING the override produces `tmpHome/.coreartifact/state.jsonl`
— which (a) equals `expectedStatePath` so the `toBe(expectedStatePath)` assertion passes, and
(b) is under `/var/folders/...`, never under `/Users/robbiejack`, so `startsWith(REAL_HOME)` is
false and the assertion passes. Proven: homedir-fallback mutant → all three acceptance
assertions GREEN.

**Why:** `os.homedir()` tracks `process.env.HOME` dynamically on macOS Node 24, and paths.ts's
own `homedir()` reads `process.env.HOME` too — so once the test overrides HOME to the same tmp
tree as the override, a home-derived path and an override-derived path are byte-identical. The
assertion can only go red if the state path lands under the REAL home, which requires HOME to be
left un-overridden — the exact "override-only isolation" scenario the criterion promises but the
test never exercises.

**What actually covers the criterion:** the paths UNIT test `paths.test.ts:53-61` sets the
override to `/tmp/fixture-registry` (DIFFERENT from home) and asserts
`state === /tmp/fixture-registry/state.jsonl` — homedir-fallback mutant → RED there. So the
criterion is genuinely met; only the dedicated acceptance assertion is vacuous.

**How to apply:** when an acceptance test sets HOME and the registry-root override to the same
tmpdir, any "not under real home" / "state === expected" assertion is dead — both a correct impl
and a home-fallback impl produce identical paths. To make it bite, the override must point
somewhere the home-derived path never would (as the unit test does), OR the test must leave HOME
as the real home and set only the override. This is gotchas-entry-4 ("a test that cannot fail")
wearing an env-setup disguise; an amendment note claiming it was fixed is not proof it bites —
run the homedir-fallback mutant.
