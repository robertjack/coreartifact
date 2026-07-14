# CLAUDE.md — coreartifact

Local-first evidence ledger for agent-built software (TS CLI + SQLite +
local dashboard). This file is behavior only; orientation lives in
`spec-v1.md` — the binding spec, including the dated smoke-test findings
section and the decisions log.

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
- Repo is private until v1 launch, then the ENTIRE history publishes
  unredacted — write every commit message, ledger entry, and escalation
  as if already public.
- No npm publish until the `coreartifact` name is reserved (operator act,
  deferred 2026-07-13); `private: true` in package.json is the guard —
  do not remove it.

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
  findings in spec) · scaffold + `aeh init` + `aeh upgrade` (2026-07-13).
- Next: `/aeh-prd` for PRD-0001 (walking skeleton: init, hook capture,
  spool, lazy ingest, log/show, attribution). The grill must settle five
  items left to PRD time:
  (a) schema.md co-authored by data-architect;
  (b) spool line envelope — version field, pass-through vs normalized;
  (c) settings.local.json MERGE on init / clean UNMERGE on uninstall as
      explicit acceptance criteria (uninstall = byte-identical, incl.
      reverting init's .gitignore entry);
  (d) the 10-minute init translated into machine-checkable steps;
  (e) the worktree capture mechanism — worktree sessions load NO hooks
      from the main checkout (smoke test finding; candidates in spec).

## Repo conventions

- TypeScript, pnpm (never npm/yarn), vitest; conventions mirror the aeh
  repo. Bins `coreartifact` + `cart` land with PRD-0001.
- Model IDs are exact and pinned (`claude-opus-4-8`, `claude-sonnet-5`) —
  never aliases.
