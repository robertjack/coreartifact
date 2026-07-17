# Locked tests are contract — PRD-0002 escalation record

Four of PRD-0002's seven escalations were wholly or partly caused by
locked acceptance tests, with ZERO implementation faults among them. Every
one was detectable at authoring time. The defects, so they never recur:

1. **Import paths are contract, not guesses.** The module paths you import
   come from the issue's `[files] owns` block, verbatim. Guessed filenames
   (`checkLine.js` for `check.ts` exports, `state.js` for
   `operatorState.ts`) escalated ISS-0013 and ISS-0015 — the tests could
   never pass against any correct implementation.
2. **A red test only counts if it is red for the criterion's reason.**
   red-verify checks mapped-and-red; a test that fails with
   MODULE_NOT_FOUND or a harness error sails through it while proving
   nothing. Before locking, read the failure output: it must be the
   criterion's own assertion failing, never a broken import or setup.
3. **Never read environment truths after overriding them.** ISS-0015's
   criterion-4 called `os.homedir()` after `beforeEach` had already
   overridden `HOME` — the assertion failed unconditionally. Capture
   ground truth BEFORE any override, and point overrides at a root
   distinct from every asserted path.
4. **Assert containment, not exact equality, on extensible surfaces**
   (manifest entries, version stamps, scenario sets, table lists) — the
   full rule with both PRD-0001→0002 detonations is docs/gotchas.md #7.
   Exact pins are landmines for the next campaign's sanctioned extension.
