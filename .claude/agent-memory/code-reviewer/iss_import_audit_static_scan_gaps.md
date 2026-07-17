---
name: iss-import-audit-static-scan-gaps
description: aeh b507fca acceptance-import audit — gate/mutations genuine; regex-not-parser false-positive on string-data + bare-specifier/wrong-case false-negatives
metadata:
  type: project
---

# aeh import-audit (b507fca, feat/acceptance-import-audit) review

Feature: static-scan every relative import specifier under `tests/acceptance/<ISS>/`,
flag any resolving neither to an existing file nor into footprint (owns∪touches). Gates
test-author acceptance BEFORE implementer spend. src/import-audit.ts.

**Genuine parts (proven by execution):** gate mutation `redResult.ok && importViolations.length===0`
→ `redResult.ok` = 1 integration test red. Scanner mutation (drop dynamic-import regex) = 2 tests red.
Field replay (caught dynamic `import("../../../src/core/state.js")` vs owns operatorState.ts) genuine.
Terminal diagnosis + run.ts display + both-attempt events carry violations; `lastImportViolations`
reassigned every attempt so no stale leak into SUCCESS or scoped-gate-only terminals.

**Real gaps (the scanner is a regex over raw file text, not a parser):**
1. S2 string-data false positive: `expect(out).toContain('import "../../../src/x.js"')` flags the
   INNER specifier. Code comment claims "fix is self-evident either way" (import-audit.ts:35) — true
   for a commented-out import, FALSE for an assertion payload the test must keep. Message gives no hint
   it matched string data → poor recovery inside MAX_TEST_AUTHOR_ATTEMPTS=2.
2. S2 bare-specifier false negative: guard `!startsWith("./") && !startsWith("../")` skips bare
   `src/...`. A caught dynamic `import("src/core/state.js")` slips BOTH audit AND verifyRed
   (caught→ordinary red, not collection error) — the exact class the feature targets. New prompt
   (run-issue.ts:541) displays footprint as bare `src/...` paths + "must resolve to one of these
   footprint paths", arguably inducing bare guesses. Narrow (agent must fail to relativize).
3. S3 wrong-case false negative on macOS: `existsSync` (import-audit.ts:64) is case-insensitive on
   Darwin, so `../../../src/State.js` for `src/state.ts` audits clean — but impact is downstream Linux
   breakage, not the wasted-implementer-spend the feature targets, AND tests pass on the same mac.
4. S3 test breadth: `export ... from` and `import type ... from` are audited today (both flag) but no
   test pins them — a scanner refactor could silently drop re-export/type coverage.

Template literals, string concat, comments, embedded `../` (posix.normalize), directory-index,
existing-outside-footprint, node:/bare-pkg all behave correctly — verified by scratch probe.
