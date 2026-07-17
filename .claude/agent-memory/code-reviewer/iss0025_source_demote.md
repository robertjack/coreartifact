---
name: iss0025-source-demote
description: ISS-0025 kind demote-only on non-startup sources — empty-source classifier/validator boundary throw wedges whole repo; source-embedding untested beyond "clear"
metadata:
  type: project
---

# ISS-0025 (kind demote-only on non-startup SessionStart source) — 4eb8852

Impl adds a source gate to `classifySessionKind` (src/ingest/drift.ts) + a prefix-validated
dynamic reason `sourceNotStartup(source)` in src/core/absence.ts.

**S2 boundary throw (the planted defect):** `sourceOf` returns `""` for a JSON `source:""`
(typeof==="string"), so classify emits `sourceNotStartupReason("")` = the bare prefix
`"model absent, source not startup: "`. But `isValidReason` requires
`reason.length > SOURCE_NOT_STARTUP_PREFIX.length` — the bare prefix fails it → `setAbsence`
THROWS. Ingest loop (ingest/index.ts:447-450) is inside `BEGIN IMMEDIATE`/`COMMIT` with
`ROLLBACK; throw` (609-612), and `log`'s `walkRegisteredRepos` folds the throw to a warning:
one `source:""` session → **whole repo's ingest permanently rolls back**, `log` shows "no
sessions recorded yet." + misleading `warning: registered repo unreachable` (repo is fine),
exit 0, persists every run. On MAIN empty-source→headless (no throw) so this is a regression.
Reachability low (CC source ∈ {startup,clear,resume,compact}, never ""), blast radius severe.
Fix: sourceOf treat `""` as undefined (→ no-source-recorded), OR isValidReason accept bare prefix.
Classifier emitting a reason its own validator rejects = self-contradiction.

**S2 test-gap:** `sourceNotStartup` embeds `source`, but every test (unit + acceptance crit-1)
uses source="clear", == the hardcoded precomputed literal `MODEL_ABSENT_SOURCE_NOT_STARTUP_CLEAR`.
A constant-"clear" mutant of the builder passes all 21 unit tests. Branded return-type
`${prefix}${string}` blocks the naive literal mutant at tsc, but a type-valid ignore-source
mutant survives the suite. No non-clear non-startup source is exercised anywhere.

**Fix round 1 (8ffcdc5) — MERGEABLE, execution-verified:** one-line prod change `sourceOf`
returns undefined when `source.length === 0` → "" folds to no-source-recorded branch; setAbsence
accepts, no throw. Full-CLI poison-pill gone (session present, kind null, reason "model absent, no
source recorded", ledger not wiped, log2 also fine). S2#2 fixed test-only: two embedding tests
hardcode "resume"/"compact" literals (not via the builder) → Mutation C (builder ignores arg)
→ 2 red. New 11-cell test.each invariant matrix in absence.test.ts drives REAL classify → REAL
setAbsence → REAL ledger asserting no-throw; genuine BOTH directions (Mutation D: validator
rejecting "resume" → matrix 'resume' cell red). absence.ts NOT touched by fix (invariant locked
via test, justified); locked acceptance file untouched; sourceOf single caller, no collateral;
519/519. Empty/non-string→"no source recorded" honesty tradeoff persists (S3, blessed, not a blocker).

**Clean (mutation-proven):** gate precedence correct; branch 1-2 byte-preserved (all committed
fixtures carry source:"startup" or a model key; 505/505 green). Mutation A (invert gate) → 9 red
incl. acceptance; Mutation B (no-source→headless) → 3 red. Rebuild invariance (crit-3) genuinely
drives CLI ingest + rmSync-reingest byte-compare. clear-source.jsonl matches finding-9 shape.
Footprint clean (only owned paths), git status clean. Non-string source→"no source recorded"
(mildly dishonest but locked test blesses it, S3).
