---
name: feedback-harness-env-isolation-test-own-env-too
description: When writing a hermeticity test that mutates process.env to simulate a hostile operator shell, your own verification/assertion calls must go through the harness's hermetic env helper too — not a raw execFileSync with default env, or the test poisons itself.
metadata:
  type: feedback
---

On ISS-0003's rescue dispatch (fixing an escalated acceptance-harness
attempt, 2026-07-14), a hermeticity self-test set hostile
`GIT_CONFIG_GLOBAL`/`XDG_CONFIG_HOME`/`GIT_COMMON_DIR` on `process.env` to
simulate a poisoned operator shell, then called `execFileSync("git", ...)`
with no explicit `env` to *verify* the harness-made repo was unaffected.
That verification call inherits `process.env` by default (Node replaces
env wholesale only when you pass one) — so it inherited the hostile vars
itself and failed with `fatal: not a git repository`, even though the
harness's own `gitEnv()`-driven repo creation was completely fine.

**Why this matters:** a hermeticity test that mutates the parent env must
route every one of its own git calls — both the setup/creation calls made
through the harness AND the assertion/verification calls the test writes
itself — through the same hermetic env builder the production code uses.
Otherwise the test's own probe is the thing that's not hermetic, and you
get a false red that looks like a harness bug but is actually a test bug.

**How to apply:** when writing this shape of test (mutate `process.env` to
simulate a hostile parent, assert the thing-under-test is unaffected),
grep for every raw `execFileSync`/`spawn` call in the test body and make
sure each one either passes the same allowlisted env the harness would use,
or is deliberately testing the raw/unfiltered path on purpose. See
[[reference-git-gitdir-identity-discriminator]] and the ISS-0003 acceptance
harness (`tests/acceptance/harness/env.ts`'s `baseHermeticEnv`, reusing
`src/core/attribution.ts`'s `scrubbedEnv`/`ALLOWED_ENV_VARS`) for the
canonical allowlist-not-denylist pattern this project has now ruled on
twice.
