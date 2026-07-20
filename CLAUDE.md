# CLAUDE.md — coreartifact

Local-first evidence ledger for agent-built software (TS CLI + SQLite +
local dashboard). This file is behavior only; orientation lives in
`docs/spec-v1.md` — the binding spec, including the dated smoke-test
findings section and the decisions log.

## Source of truth

- The spec governs. On any conflict between code, this file, and the spec:
  the spec wins; fix the artifact, never code around it.
- Nothing in the spec re-opens without a named reason. The non-goals wall
  and expand gate are load-bearing — a wanted feature outside v1 gets a
  named re-entry condition in the spec, not code.
- Never assert Claude Code platform behavior from memory. Verify against
  live docs or a real observed session, then record the fact dated in the
  spec's findings section before relying on it. The 2026-07-13 smoke test
  is the model: observed truth supersedes documented claims.

## Laws (never weaken)

- Nothing leaves the machine: no code, no transcripts, no telemetry by
  default. "Your code never leaves your machine" is a law, not a
  preference.
- The raw spool is ground truth forever; ingestion is always re-runnable
  from it. An unavailable facet records as ABSENT — never fabricated,
  never silently zero.
- Capture never parses and never breaks the host. The hook artifact
  appends the payload verbatim, exits 0, and knows nothing about schemas
  or versions — that ignorance is what makes it survive Claude Code
  releases (spec "Compatibility stance"). Never push parsing, version
  branching or schema knowledge into it. Never subscribe a hook event
  whose semantics have not been observed: WorktreeCreate proved a
  subscription can change the host's behavior, not merely watch it.
- Repo is private until v1 launch, then the ENTIRE history publishes
  unredacted — write every commit message, ledger entry, and escalation
  as if already public.
- The npm name is reserved (`coreartifact@0.0.0` placeholder, published
  2026-07-15). No publish of the real package until v1 launch;
  `private: true` in package.json is the guard — do not remove it.

## Build motion

- Built with aeh: `aeh do` for issue-sized work, PRD campaigns for scoped
  slices (three campaigns, skeleton-first — spec "Build motion"). Judgment
  lives in agent prompts and skills, never in CLI code.
- Hand-edit only what the loop cannot run on itself: this file, the spec,
  and the stamped `.claude/` artifacts (aeh-canonical — byte-stability
  matters; edit via `aeh upgrade`, never drive-by).
- Minimum code that solves the problem; surgical diffs; every task becomes
  a verifiable goal before starting.

## Now (update as acts complete)

- Done: spec confirmed (2026-07-12) · hooks smoke test (2026-07-13,
  findings in spec) · scaffold + `aeh init` + `aeh upgrade` (2026-07-13) ·
  PRD-0001 walking skeleton shipped (2026-07-15; retro at
  docs/prd/PRD-0001-walking-skeleton/retro.md) · PRD-0002 evidence depth
  shipped (2026-07-17; 12 issues, $134.71 of $200 aeh-side) with retro
  done (2026-07-17; docs/prd/PRD-0002-evidence-depth/retro.md — seven
  escalations, zero implementation faults in the test-side four; process
  change: mechanically check locked tests against the issue contract
  before dispatch).
- Done (post-retro, 2026-07-17): all three aeh ideas landed as merged
  PRs (#1 reviewer infra-error→merge S1; #2 locked-test import audit —
  the retro's process change, four review rounds; #4 plan-time
  lock-collision scan) — aeh dist rebuilt, next campaign runs all
  three. Deliberate dogfood `init` live on this repo: capture verified
  (first session in the ledger), doctor already flagging real drift
  (cc 2.1.212 vs tested 2.1.208–2.1.211).
- Done (2026-07-17): PRD-0003 grill — twelve rulings, $200 budget,
  prd.md at docs/prd/PRD-0003-dashboard/ (headline = verified-delegation
  three-way; HTTP seam + one browser flow; api.md + prototype passes
  flagged). CONTEXT.md gained overview / session view /
  verified-failing-unverified / drift banner.
- Done (2026-07-17, same day): api.md pass (binding GET contract,
  PRD Amendment 1 — port 2278, busy_timeout in the shared read helper,
  UTC-Z fixture pin) · prototype freeze (PRD Amendment 2 —
  v2-tile-led is the design contract; ABSENT = disclosure chip;
  toolchain Tailwind 4 + shadcn CLI primitives on vite; premium
  template stays gitignored/license-walled, reference only).
- R10 status (2026-07-17): (d) DONE — gates wrapped in `cart check`,
  four checks bound in the live ledger (typecheck ✓ / test ✗ / test ✓ /
  build ✓; the ✗ is a one-off stale-dist mismatch during the wrapped
  run, full output captured at checks line 289 — daily-lane item,
  unreproduced twice after). (a)+(c) probed GREEN in an
  implementer-agent sandbox (pnpm store + typecheck clean; playwright
  1.61.1 chromium screenshot clean) — an approximation of the real aeh
  worker; a cheap `aeh do` smoke remains the definitive confirmation.
  R9 provisionally dispatch-lane, fallback armed.
- (b) recording pass on 2.1.212: DONE (2026-07-17, findings 9–11 +
  F9 closure in docs/recording-pass.md; streams/oracles at
  tests/fixtures/recpass-2.1.212/). Register holds; keyboard cell
  closed the matrix (fresh interactive carries `model`; the hole is
  exactly non-`startup` sources). RULED: kind demote-only on
  `source != "startup"` (fix lane: `aeh do`, before plan) · range
  BUMPED 2.1.208–2.1.212 (spec + constant + both over-pinned tests
  amended — gotcha #7's second sighting, caught by the dogfood check
  loop). F10: TaskOutput not guaranteed on .212 → backgrounded outcome
  commonly ABSENT, honest; notification-prompt join = register note.
- ISS-0025 MERGED (2026-07-17, fa88093): kind demote-only on
  non-startup sources. Budget-killed `aeh do` ($4 s-tier too small) →
  by-hand rescue per protocol (runner's locked tests preserved; two
  S2s found by review on a green suite — empty-string poison-pill +
  untested embedding — fixed with mutation proofs; merged with full
  side effects). Execution-proven: live ledger rebuild flipped this
  repo's /clear session to ABSENT-with-reason. Upstream: run-issue
  resume gap + mislabeled infra_failure detail filed (aeh 27299f5).
  NEW daily-lane finds: claude-sonnet-5 missing from the price table
  (every worker session's cost reads ABSENT "model unpinned") and the
  `<synthetic>` model-row artifact.
- PRD-0003 SHIPPED (2026-07-17, ship gate approved ~23:15Z): 7/7
  merged, $94.31 of $200. Runner carried 5 autonomously; 0028 + 0029
  landed via by-hand escalation protocol — both test-side, zero
  implementation faults (0028: environmental fixture collision, pin
  amendment; 0029: stub-200 made R8 vacuous + waitForExit race + two
  review-S2 test gaps — four test-only amendments, all
  mutation-proven). Integration review: SHIP, all nine requirements
  verified live (playwright + SQL + seam), invariants hold, four
  carried finding classes resolved, five S3 residuals in the findings
  table (F1 busy_timeout triple-literal + F3 UI-swallowed error bodies
  = daily-lane). Dashboard verified on the live ledger: honest "0 of
  35 verified" headline (checks bind to kind-NULL operator sessions —
  demo-optics note: seed one headless session with a bound check
  before showing anyone; aeh-workers-wrap-gates-in-cart-check is the
  real fix and an aeh integration idea).
- RETRO DONE (2026-07-20, docs/prd/PRD-0003-dashboard/retro.md):
  zero footprint violations/scope changes; the PRD-0002 audit paid for
  itself (vacuous criterion caught pre-spend, twice); green-suite rule
  now 27 consecutive issues; the dogfood ledger debuted as a reviewer
  source. Distilled: gotcha #8 (hermetic replay) · decomposer
  stub-distinguishable memory · test-author seedLines memory · map.md
  dashboard geography · ISS-0029 + ISS-0032 representative fixtures.
  ONE process change: fold the cwd/transcript_path pin into
  replayLines (harness-level hermeticity) — daily-lane `aeh do`,
  BEFORE PRD-0004 dispatches.
- ISS-0033 MERGED (2026-07-20, 243a42e): hermetic replay by
  construction — the retro's process change, PRD-0004 unblocked.
  `aeh do` escalated on a NEW class: the write-guard acceptance lock
  covers a tests-only issue's own footprint (zero implementation
  faults; attempt 3 scratch-validated the whole design before
  escalating). By-hand rescue per protocol: rulings A–D test/spec-only,
  locked test unedited, adversarial re-review MERGE with mutation
  proofs, findings 185–195 dispositioned, merge via the real verb
  (eval_fixtures auto-recorded; only findings flips were manual).
  Idea filed upstream (aeh 31187c2): dispatch-time role-lock vs
  footprint feasibility. BONUS: the R10 stale-dist flake ROOT-CAUSED
  on its second sighting — `prepack: pnpm run build` × ISS-0009's
  mid-suite `pnpm pack` rewrites dist while workers import it (torn
  dist); red + green gate runs both bound (checks 6311/6334).
- Next, in order: (1) convert the six filed aeh ideas to PRs
  (27299f5+addendum, fc518f8, bbe2f40, 3ff175a, 31187c2 — PRD-0002
  precedent) · (2) launch acts (spec list): README, LICENSE/NOTICE,
  SECURITY.md, CI, ping receiver, write-up, the flip. Daily-lane:
  sonnet-5 + <synthetic> price rows · S2s 132–145 · F1/F3 ·
  torn-dist flake (fix: packaging test packs with lifecycle scripts
  ignored, or from a repo snapshot — root cause above) · ISS-0027
  default-port test vs a running dashboard (retro addendum) ·
  findings 194/195 breadth notes. Geography in docs/map.md.

## Repo conventions

- TypeScript, pnpm (never npm/yarn), vitest; conventions mirror the aeh
  repo. Bins `coreartifact` + `cart` land with PRD-0001.
- Run gates through the product: `node dist/cli/bin.js check <name> --
  <cmd>` (typecheck/test/build), not raw. In a headless/delegated
  session, bind to yourself: read your session id from the spool's last
  SessionStart line and pass `--session <id>` — that is what makes the
  session VERIFIED in the dashboard's headline instead of unverified
  (evidence bound to the session, the product's own thesis). Exit codes
  pass through, so nothing else changes.
- Model IDs are exact and pinned (`claude-opus-4-8`, `claude-sonnet-5`) —
  never aliases.
