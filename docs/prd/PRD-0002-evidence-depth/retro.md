# PRD-0002 retro — evidence depth (shipped 2026-07-17)

12/12 issues merged, main green at 494/494, ~9.5 hours dispatch→ship.
aeh ledger: **$134.71 of the $200 budget** (67%) against a $138 median
prediction — the compiler's estimate held within 3%. By role: implementer
$61.40 (24 attempts), code-reviewer $40.98 (15), test-author $32.33 (13).
The ledger does not carry the operator lane: ~12 session-side dispatches
(7 adversarial reviews/re-reviews, 5 fix rounds) ≈ $45–60, putting the
all-in campaign at ≈ $185–195 — almost exactly the $185 p90. Priciest
issue ISS-0022 ($19.05, uninstall + environment escalation); cheapest
ISS-0023 ($4.95 — cheap because its review never ran, see below).

## What stalled

- **Locked-test author defects — the dominant class.** Four of seven
  escalations were wholly or partly test-side (ISS-0013, 0015, 0016, plus
  ISS-0018's second blocker), six distinct test bugs, **zero
  implementation faults among them**. Guessed import paths
  (`checkLine.js`, `state.js`), cross-campaign over-pins (exact-five
  manifest set, `schema_version 1` literal), `os.homedir()` read after
  the test's own HOME override, and a single-token line search that
  always matched the fixture's prompt line. Every one was detectable at
  authoring time; every fix was a test-only operator amendment.
- **Real-bug round ceilings** (ISS-0017, four rounds; ISS-0019). Reviews
  kept finding genuine S1s — UTF-8 chunk corruption, database-locked
  parallel check, 10× cost fabrication — until the ladder ran out. This
  is the system working; escalation just transfers the tail to the
  operator lane.
- **ISS-0022 escalated on environment alone**: pnpm broken sandbox-wide
  in dispatch workers ("unable to open database file"); workers
  substituted `node_modules/.bin/*` and the operator ran real gates
  outside. Standing issue for future campaigns.
- **ISS-0018's footprint** could not reach show's stdout — the one
  genuine scope_change of the campaign (one-line grant).
- **ISS-0023 is the anti-stall**: it merged UNREVIEWED via an aeh harness
  bug (reviewer infra-error falls through to merge — S1, filed upstream
  with full event evidence, 71d41aa). Post-hoc operator review found the
  two-field ping wall clean and fixed one S2 on main (ping linger
  2012ms→282ms).

## What each reviewer source uniquely caught

- **Per-issue code review** again caught what only execution against the
  spec catches: per-chunk UTF-8 decode corrupting split multi-byte
  output, parallel `check` dying "database is locked", three uninstall
  data-destruction paths (delete-what-we-never-wrote, stale-snapshot
  restore, user gitignore-line strip), mixed-model transcripts priced at
  the first request's model (10× over-charge), `needsRebuild` deleting a
  live ledger under concurrent lock, doctor pinging on the dispatcher
  path. And, recurrently, tests that could not fail (enum-clause fixture
  violating two CHECKs at once, bytes-unchanged asserted via parsed
  JSON, the vacuous HOME-override assertion).
- **Focused post-escalation re-reviews** (operator lane — new this
  campaign) found real S1s in **3 of 7 rounds**: defects introduced or
  unmasked during rescue, e.g. ISS-0018's first-match parser false green
  and ISS-0015's still-vacuous criterion-4 after the first amendment.
  Never skip the re-review after a rescue.
- **The integration review** (once, whole branch) closed three S1
  cross-issue seams invisible per-issue and logged the S2 follow-up
  table (findings 132–145) plus six S3s (148–153).
- **red-verify caught nothing this campaign** — not because the tests
  were sound, but because the defect class moved into its blind spot: a
  locked test that fails with MODULE_NOT_FOUND is red, so
  mapped-and-red passes while proving nothing. "Red for the wrong
  reason" is invisible to it by construction — that observation drives
  this retro's process change.
- **The post-hoc review of the unreviewed merge** proved the fallback
  works but only because the operator noticed the harness bug; nothing
  structural would have caught ISS-0023.

## Footprint prediction accuracy

Worse than PRD-0001's zero violations, and both misses are the same
seam: **a slice that surfaces a new facet needs the render/CLI wiring in
its footprint**. ISS-0018 escalated on a structural block (no
in-footprint file could join test_results into show's stdout;
scope_change granted `src/cli/commands/show.ts`), and ISS-0019 tripped
the footprint gate twice attempting `.gitignore`/`log.ts`/`show.ts`.
Distilled to the new decomposer memory. The other two structural blocks
(ISS-0013 `checkLine.ts`, ISS-0015 `state.ts`) were locked-test import
bugs wearing a footprint costume, not prediction misses. The
memory-lane fix from PRD-0001's retro held: **zero denied memory writes**
(vs nine last campaign) — role memory landed 20+ notes during the run.
The remaining unsanctioned write class is scratch probes (`/tmp` scripts
denied at ISS-0014, 0018) — real but minor friction.

## Where the findings went (distillation record)

- Over-pin + module-path contract → **docs/gotchas.md #7**, landed
  mid-campaign; confirmed, nothing moved.
- Locked-test contract (imports from the owns block; red must be the
  criterion's red; env truths before overrides; containment over pins) →
  **new test-author memory** — the role that caused the dominant
  escalation class had one note and no record of it.
- Render-seam footprints, plan-time locked-surface scan, one contract
  per issue, operator-lane prerequisites → **new decomposer memory**
  (store created this retro, precedent PRD-0001 creating test-author's).
- Reviewer (8 notes) and implementer (12+ notes) per-issue memories
  landed during the campaign via the sanctioned lane; nothing to move.
- PRD-0002 geography (check, parsers, ping, doctor, uninstall,
  operatorState, priceTable, testResults/enrichment/drift) →
  **docs/map.md**, pointer-sized.
- Ledger hygiene repaired in `.aeh/aeh.db`: 9 stale `open` S1s flipped to
  resolved (each fix verified on main by commit); **7 missing
  eval_fixtures rows backfilled** — the by-hand rescue merges skipped the
  merge verb's side effects; the by-hand protocol memory now includes
  fixture recording and status flips.
- No new ADR: per-request all-or-nothing pricing and the two-field ping
  wall are recorded in their issue specs and code; neither is
  hard-to-reverse ∧ surprising ∧ a real trade-off.
- Upstream (craft, crosses only by PR): three aeh ideas already filed
  with evidence — test-author import/red-verify reconciliation
  (40a8c54), plan-time over-pin scan (5dcabf1), reviewer
  infra-error→merge S1 (71d41aa). Converting them to aeh PRs is the
  pre-PRD-0003 act.

## Fixtures and signals

- **ISS-0013** nominated representative: the corpus's first schema
  migration (ledger v1→v2, rebuild-on-drift) and the locked-test-dispute
  rescue path.
- **ISS-0017** nominated representative: the real-bug round-ceiling path
  — four rounds, all genuine defects — over the campaign's trickiest
  implementation (three-layer node:sqlite concurrency).
- Signals: the table is still empty — this PRD served no filed signals;
  nothing to flip, no authors to notify.

## The one process change

**Make the locked-test contract mechanically checked before
implementation dispatch.** Extend red-verify so a criterion counts as
red only when the failure is the criterion's own assertion — not
MODULE_NOT_FOUND, not a harness error — and reconcile every locked
test's imports against the issue's `[files] owns` block, flagging
exact-equality pins on surfaces the plan extends. Four of seven
escalations, six test bugs, zero implementation faults — and every one
of them was visible in the locked tests before a dollar of
implementation or review spend. Ideas 40a8c54 and 5dcabf1 already carry
the evidence; the change is landing them in aeh before PRD-0003
dispatches. (The reviewer-error→merge hole is S1 and must be fixed too,
but that is a bug fix, not a process change.)
