---
name: reference-iss0015-second-test-bug-homedir-after-override
description: ISS-0015's 4th acceptance criterion computes os.homedir() INSIDE the test body, after beforeEach already overrode process.env.HOME — os.homedir() reads HOME dynamically, so this assertion is backwards and fails even with a fully correct implementation and a correctly-named module.
metadata:
  type: reference
---

`tests/acceptance/ISS-0015/state.test.ts`'s 4th criterion ("The state file
lives under the same overridable global root...") has a SECOND,
independent test-authoring bug beyond the `state.js`/`operatorState.js`
filename mismatch documented in
[[reference_footprint_vs_test_module_path_mismatch]].

**The bug, verified experimentally (node -e, this session, 2026-07-16):**
Node's `os.homedir()` reads `process.env.HOME` dynamically on every call
(POSIX `uv_os_homedir()` checks `HOME` first). `beforeEach` sets
`process.env.HOME = tmpHome` before every test runs. The test body then
does:

```js
const realHome = os.homedir();          // returns tmpHome, NOT the real home —
                                          // HOME was already overridden in beforeEach
expect(paths.state.startsWith(realHome)).toBe(false);
```

Since `paths.state` is derived from `tmpRegistryRoot` which is derived from
`tmpHome`, and `realHome` here also evaluates to `tmpHome`, `paths.state`
DOES start with `realHome` — the assertion expects `false` but gets `true`.
**This assertion fails unconditionally, for any correct implementation,**
as long as the test computes `os.homedir()` after the override instead of
before it (or instead of asserting against the pre-override
`originalHome`/`os.homedir()` value captured once, at module load, before
any `beforeEach` runs).

**Why this matters:** don't assume — as the prior ISS-0015 attempt's
dossier did — that this 4th criterion's failure is "just a side effect of
the same missing-module assumption" as the other three. It is not. Even
after a `test_dispute` fixes the `state.js` → `operatorState.js` path in
`helpers.ts`, this criterion will still fail on this second, independent
bug. Both fixes belong in the same `test_dispute` request.

**How to apply:** when a locked acceptance test asserts "X differs from the
real/unmodified environment" inside a test body that runs after a
`beforeEach` mutates that same environment, check whether the "real" value
is captured before or after the mutation. If captured after (inside the
`it` body, with no `beforeEach`-order guarantee protecting it), the
assertion is measuring the mutated value against itself. Verify with a
throwaway `node -e` experiment (as done here) rather than reading the
assertion and trusting its variable name (`realHome` is misleading — it is
not real once `beforeEach` has run first, which it always has by the time
any `it` body executes).
