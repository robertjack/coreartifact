# PRD-0003 retro — dashboard (shipped 2026-07-17)

7/7 issues merged, one day grill→ship (grill ~09:00Z, gate approved
~23:15Z), main green at 590/590. aeh ledger: **$94.31 of the $200
budget** (47%) — the cheapest campaign yet per issue despite two new
seams (HTTP + browser). By role: implementer $40.93 (11 attempts),
test-author $32.03 (11), code-reviewer $21.35 (8). Priciest issue
ISS-0028 ($21.29, the one escalation); cheapest ISS-0030 ($5.56 — the
overview UI, autonomous in three attempts). The ledger does not carry
the operator lane: the api.md pass, prototype round, recording pass,
ISS-0025 pre-campaign fix, two escalation rescues with adversarial
reviews, and the integration review all rode the operator session.
Same-day context: the morning recording pass (findings 9–11) and
ISS-0025 (kind demote-only) landed BEFORE dispatch — the campaign ran
on a just-verified 2.1.208–2.1.212 range with a just-fixed classifier.

## What stalled

- **ISS-0028 escalated on pure environment** — the campaign's only
  escalation, zero implementation faults (the runner's own review had
  passed the implementation). Recorded fixture streams carry the
  recording machine's absolute paths, and the leftovers still exist at
  those paths: the absent-cost scenario read a live leftover transcript
  (0.0558… vs the 0.555957 oracle). Test-only pin amendment; the class
  hit three times total this campaign (also ISS-0025 authoring,
  ISS-0029 re-confirmation) → gotcha #8, and this retro's process
  change.
- **ISS-0029 terminated `test_author_defect` twice, correctly** — the
  runner's mechanical audit (the PRD-0002 process change) refused a
  mapped-but-green R8 criterion in two consecutive ladders. Root cause
  sat one issue upstream: ISS-0027's session stub returned a
  valid-shaped `200 {}`, making "browse returns 200" vacuous by
  construction. The audit cannot see that the fix is body-pinning; it
  burned two test-author rounds proving the criterion wasn't red-able.
  Amended by operator (body pin), continued by hand. Decomposer lesson
  distilled: stubs must be distinguishable from success.
- **Runner lifecycle friction, not work friction**: the run terminated
  and needed operator relaunch four times (gate-stdout crash from the
  operator's own globalSetup hand-edit; memory-merge abort; two
  end-of-pass exits with issues still queued), and the pre-flight
  tripped twice on under-load flakes (distinct tests, green solo and
  on double-rerun) before a documented `--accept-red-main`. None cost
  implementation spend; all are filed upstream (stage-aware resume,
  auto-commit agent memory, `--outputFile` gate parse).
- **ISS-0026's first ladder died to the operator's own hand-edit** —
  the globalSetup SPA-build step printed vite's chunk listing into the
  stdout the gate parses. ~$6 redo. The one self-inflicted stall.

## What each reviewer source uniquely caught

- **The mechanical audit (red-verify + import audit)** caught the
  campaign's deepest defect class before any implementation dollar:
  ISS-0029's vacuous criterion, twice. In PRD-0002 this class cost four
  escalations at ~$15–20 each; here it cost two test-author rounds
  ($7.71) and an operator amendment. The process change paid for
  itself in its first campaign.
- **Per-issue code review** (runner, in-ladder): two quality_fail
  rounds on ISS-0028 pre-escalation; passed the 0028 implementation
  that later proved correct (the escalation was environmental).
- **Operator-lane adversarial reviews** (both rescues): ISS-0029's two
  S2 test gaps on a green suite — a concurrency test that passed with
  busy_timeout deleted entirely (unchanged spool = no-op ingest;
  readers don't block on RESERVED) and a cost facet that could
  fabricate $0 undetected (only the reason row was asserted). Both
  closed by amendment with mutation proofs (EXCLUSIVE-holder contended
  write; value pinned null). The green-suite-hides-a-defect rule is
  now 27 consecutive issues.
- **The integration review** (once, whole branch, everything executed
  live): confirmed all nine requirements against the real server +
  playwright + SQL, proved the flake trilogy shares a
  subprocess-latency mechanism with no product race (the one that
  mattered — a real binding race would poison the KPI), closed all
  four carried finding classes, and contributed the demo-optics
  observation (bound evidence landing outside the KPI universe) that
  became the verified-delegation actions below.
- **The dogfood ledger** (new source, first campaign it existed):
  caught the /clear kind-fabrication live before dispatch (finding 9 →
  ISS-0025), flagged real version drift, and recorded the operator's
  two honest gate failures with full output. The product reviewed its
  own build.

## Footprint prediction accuracy

**Zero source-footprint violations and zero scope changes across all
seven issues** — better than both prior campaigns (PRD-0002 had one
scope_change + two gate trips). The render-seam and one-contract
lessons from the PRD-0002 decomposer memory held. The plan-time
validator also caught the decomposer's cycle-inexpressible stub-seam
design at the gate (aeh's own repair pass had failed on it; operator
repaired to the shell-App seam) — cheaper than the mid-campaign
collision it would have become. Write-guard denies: 5, all scratch
probes (the known minor class). ISS-0026's duplicate fixture row from
the crashed ladder marked dead this retro.

## Where the findings went (distillation record)

- Machine-leftover fixture contamination (×3) → **docs/gotchas.md #8**
  + **test-author memory** (hermetic seedLines pattern, by path).
- Stub-200 vacuous-criterion class → **decomposer memory** (stubs
  distinguishable from success, or downstream criteria pin content).
- PRD-0003 geography (src/dashboard/, web/, browser harness, hermetic
  pin prior art) → **docs/map.md**.
- Verified-delegation practice → **CLAUDE.md convention** (gates
  through `cart check`, self-bound) + **aeh idea 3ff175a** (runner
  wraps profile gates; mechanism field-proven, flipped the live
  headline to 1-of-36).
- Five aeh harness gaps → **upstream ideas, all filed with field
  evidence** (27299f5 stage-aware resume + addendum mislabeled
  infra_failure; fc518f8 gate --outputFile; bbe2f40 auto-commit agent
  memory; 3ff175a cart-check wrap). Conversion to PRs is post-retro
  work, PRD-0002 precedent.
- Integration-review S3s → findings table (F1 busy_timeout
  triple-literal + F3 UI-swallowed error bodies = daily-lane; F2/F4/F5
  open-logged). Carried S2s from ship: verbatim-replay latent class in
  ISS-0028's scenarios 1/3/6/7 (resolved for new tests, latent in old
  ones until the process change lands).
- No new ADR: the shell-App seam, the KPI universe split, and the
  browser-lane decision are recorded in issue specs, api.md, and the
  PRD amendments — none is hard-to-reverse ∧ surprising ∧ a trade-off.
- Fixtures: **ISS-0029** nominated representative (the
  audit-terminated → by-hand-continued path with four test-only
  amendments — the richest test-side rescue in the corpus) and
  **ISS-0032** (the first browser-seam issue). Signals table: still
  empty; nothing to flip.
- Daily-lane carried forward: claude-sonnet-5 + `<synthetic>` price
  table rows (every campaign worker session reads cost ABSENT until
  fixed) · S2s 132–145 from PRD-0002 · F1/F3 above · the under-load
  flake class (raise the acceptance HTTP timeout or serialize the
  heavy files).

## The one process change

**Make fixture replay hermetic by construction: fold the
cwd/transcript_path pin into the shared replay helper.** Every
acceptance seeding path goes through `replayLines`; today each test
file re-derives (or forgets) the pin by hand, and the class has now
cost one escalation, one re-recording detour, and one latent-exposure
finding in a single campaign — three hits on the same nail. Move the
pin into the harness (`replayLines` gains the tmp-repo root and pins
every line's `cwd`; `transcript_path` pinned to a tmpdir sentinel
unless the caller substitutes), delete the per-file helpers, and the
machine-leftover class is unexpressible rather than remembered. Small
enough for the daily lane (`aeh do`, harness + touched tests
footprint); lands before PRD-0004 dispatches anything.
