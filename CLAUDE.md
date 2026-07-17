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
- Next: the PRD-0003 grill, fresh session (dashboard — designed against
  the now-real ledger with live dogfood data; the avoided-cost meter is
  banked in the spec roadmap for its grill to see). S2 follow-ups
  132–145 are daily-lane candidates; pnpm-broken-in-dispatch-sandbox is
  a standing pre-campaign check. Geography lives in docs/map.md.

## Repo conventions

- TypeScript, pnpm (never npm/yarn), vitest; conventions mirror the aeh
  repo. Bins `coreartifact` + `cart` land with PRD-0001.
- Model IDs are exact and pinned (`claude-opus-4-8`, `claude-sonnet-5`) —
  never aliases.
