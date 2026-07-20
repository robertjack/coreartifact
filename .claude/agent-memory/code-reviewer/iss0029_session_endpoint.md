---
name: iss0029-session-endpoint
description: ISS-0029 GET /api/session/<id> (session.ts) review — impl mirrors show.ts faithfully and is clean; two tests-cannot-fail gaps (concurrency busy_timeout, cost-ABSENT-as-zero at facet level)
metadata:
  type: project
---

# ISS-0029 GET /api/session/<id> — review (HEAD 4353d8d, executed 2026-07-17)

Diff = 3 files: src/dashboard/session.ts (new, 428L) + routes.ts stub swap +
locked acceptance (8 tests, 8/8 green here — sockets DO bind in this sandbox).
Impl is a faithful structural mirror of show.ts's derivation (same
buildTimelineEntry, same deriveCommandFacet/deriveBackgroundedOutcome reuse,
same pairedPostToolUseIds fold). Verdict: **mergeable**; both findings are
test-cannot-fail (green gate ≠ acceptance), impl itself spec-compliant.

## Executed-clean surfaces (mutation-proven)
- Handler-registration delta genuine: revert routes.ts to `() => ({status:200,body:{}})`
  → 7/8 RED incl. R8 zero-write (operator amendment 706e220 body-pin
  `facets?.session_id === sessionId` bites the stub's `{}`).
- M1 drop `worktree_path: sessionRow.worktree_path` → T1 RED. M3 force command
  `outcome = {state:"success"}` → T3 RED (backgrounded-absent enforced).
- Unverified criteria PROBED GREEN (temp zzprobe HTTP test, deleted): ?repo=A
  resolves an ambiguous id → 200 correct repo_root; ?repo=/unregistered → 404
  repo_not_registered; hostile ids (`..%2F..`, 5000-char, SQLi text) → 404
  unknown_session, no crash/escape (sessionArg is only a bound SQL param +
  prefix filter, never a path); cross-endpoint kind/cost/status agree overview
  vs session; NO raw payload leak (tool_response/tool_input/tool_name/payload/
  transcript_path all absent from wire — only derived fields + 4 nesting keys).
- waitForExit amendment (4353d8d) correct: signalCode!==null catches
  SIGTERM-killed child (exitCode null), else once("exit"). Not a finding.
- Footprint clean (only 3 owned/touched paths); no stray files/debug residue.

## Findings (both S2, tests-cannot-fail; impl correct)
1. **Concurrency criterion (T7) cannot fail.** Removed `PRAGMA busy_timeout`
   from BOTH read paths (session.ts:302 + resolve-session.ts:124), rebuilt, ran
   T7 → GREEN. The test seeds+warm-GET (pre-ingests), THEN spawns the BEGIN
   IMMEDIATE holder, THEN does the concurrent GETs — so the held lock never
   coincides with an ingest WRITE (spool unchanged → ingest no-op), and SQLite
   readers don't block on a RESERVED lock anyway. Criterion says "...while a
   writer holds the ledger DURING ingest" — the test never reproduces
   during-ingest contention. Impl sets the pragma (compliant); the acceptance
   is unverified by its own test. Genuine fix = append a NEW spool line AFTER
   the holder takes the lock so the GET's ingest must write under contention.
2. **facets.cost.value ABSENT-as-zero unguarded.** Mutating cost to
   `sessionRow.cost_usd ?? 0` (fabricate $0 for a cost-ABSENT session) → all 8
   GREEN. T2's session is cost-absent but T2 asserts only the sibling `absences`
   row, never `facets.cost.value === null`. B1 rule 2 / gotcha #5 (ABSENT never
   rendered as 0) is enforced for cost only via absences, not at the facet
   value. Impl uses null (correct).

## Latent for ship-gate (non-blocking)
- Machine-leftover fixture class (ISS-0028 memory) LIVE here: T3/T5/T6/T8 replay
  `headless` with cwd overridden but transcript_path NOT (seedLines only pins
  transcript_path when passed) → cost enriches from the real leftover
  transcript on disk (probe saw 0.0558). None of those tests assert cost, so
  green; bites the instant any grows a cost assertion. Same durable fix: pin
  transcript_path in the shared seedLines default.
- Timeline command-entry `test_results` badge + the RESOLVING backgrounded
  join (TaskOutput→success/failure) + tokens all-or-nothing split + test_results
  empty-array-vs-zero-row are all correct in impl but unasserted in this suite
  (covered indirectly by show.ts's own tests / shared functions).
