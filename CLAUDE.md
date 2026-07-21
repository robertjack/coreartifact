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
- Recording pass 2.1.215 (2026-07-20, findings 12–13 in
  docs/recording-pass.md; streams at tests/fixtures/recpass-2.1.215/):
  register holds on every scripted cell (kind headless n=6 incl. live
  workers · dedup exact vs envelope · vitest both paths · --version
  parse · Bash keys unchanged); TaskOutput DOES fire on explicit poll
  (in-flight-poll skip case now on record — regression-fixture
  candidate). CLOSED same day (3c89208): keyboard cell recorded (model
  present at fresh startup; /clear reproduces no-model; NEW SessionEnd
  reason "clear" on record) · range BUMPED 2.1.208–2.1.215 — the two
  unit tripwires fired on the first gate run (incomplete bump caught
  as designed, gotcha #7's third exercise), reds + green all bound ·
  drift banner retired honestly. .213/.214 never observed (semver
  coverage only).
- ALL SIX aeh ideas MERGED as five PRs (2026-07-20, aeh main a39dc67 →
  4e7d3fe; #5 #6 #7 #8 #9): vitest --outputFile · agent-memory
  auto-commit (review caught a pre-staged-sweep S2, pathspec fix) ·
  cart-check gate wrapping (workers now land BOUND evidence — the
  dashboard headline becomes real next campaign) · stage-aware resume
  + truthful infra_failure (marker: tests/acceptance/<ISS>/
  .aeh-mappings.json committed at acceptance) · dispatch-time
  lock-feasibility (ISS-0033 class refused before spend, drift
  tripwire on the hook glob). Five-branch train verified conflict-free
  + 209/807 green before merging; dist rebuilt + smoked — next
  campaign runs all five.
- Launch acts 1–5 DONE (2026-07-20, commits 6a3e631..eee4e50):
  torn-dist flake FIXED first (pack --config.ignore-scripts=true,
  execution-proven, before CI could inherit it) · README (laws-first,
  quickstart, cart alias, range 2.1.208–2.1.215) · LICENSE+NOTICE
  (Apache-2.0; packaging allowlist gained NOTICE, proven vs real
  tarball) · SECURITY.md (GitHub advisories; privacy law = security
  surface) · CONTRIBUTING.md (personal-first, no PRs pre-1.0) · CI
  (three gates, macos-15 — the only proven environment; actionlint
  clean; runs on first push to GitHub). Full gates re-verified bound.
- Launch act 6 DONE (2026-07-20, 75427ec): ping receiver LIVE at
  coreartifact.com/ping — custom-domain Worker, AE dataset
  coreartifact_pings (index install_id, blob version, nothing else
  stored — privacy law server-side); 204/405/400/413/404 shapes
  verified live; dist's pinned PING_ENDPOINT proven 204 end-to-end.
  Near-miss: wrangler cache (account id + operator geolocation)
  briefly committed — caught and amended OUT before any push;
  .wrangler/ now gitignored (public-history law: check every commit's
  file list, not just the diff).
- Launch act 7 DRAFTED (2026-07-20, e0f6e5b):
  docs/launch-writeup.md — walks the public history ("your agent says
  the tests passed — prove it"); every number verified (three campaigns
  $378.06, 33 issues, test-side-only escalations, the honest 0-of-35
  headline, 4 recording passes / 5 versions). Awaiting operator voice
  pass.
- PRE-LAUNCH E2E AUDIT (2026-07-20, dynamic workflow, 11 agents):
  installed-from-tarball simulation of real use — 4 scenarios (verified
  happy path · failing+unverified · degradation honesty · dashboard
  API + uninstall), each adversarially re-verified; 3/4 clean, the 4th
  "failure" was a mis-briefed expectation (the hook DROPS non-JSON
  with exit 0 by contract — no bug). Unverified-sessions answer:
  39/45 are aeh workers with ZERO checks (raw gates, fixed by aeh
  PR #7); 41 of 42 bound checks sit on operator sessions the headline
  deliberately never classifies (overview rates headless only). ONE
  REAL DEFECT found + FIXED same day (7025ff0): rebuild law —
  source:"resume" second SessionStart (finding 14, fourth mode, no
  model) made batch fold (last-wins) diverge from incremental COALESCE
  on sha_before; fold now first-non-null per facet, regression-pinned,
  live ledger cleared + re-ingested identical (45 sessions). S3 noted:
  cart with no args exits 0 printing usage (daily-lane).
- Next: the flip (operator decision — repo public, private:true
  removed, publish over the placeholder + fix its MIT stamp), after
  the write-up edit. Daily-lane: sonnet-5 + <synthetic>
  price rows · S2s 132–145 · F1/F3 · ISS-0027 default-port test vs a
  running dashboard (retro addendum) · findings 194/195 breadth
  notes. Geography in docs/map.md.

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
