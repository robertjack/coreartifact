# PRD-0001 — walking skeleton

budget_usd: 150

Compiled 2026-07-14 from `spec-v1.md` (binding record, 2026-07-12/13, incl.
the hooks smoke test) plus the PRD grill of 2026-07-14 (five rulings — see
Grill record). Reader: the aeh decomposer. Vocabulary: `CONTEXT.md`.

## Problem

Agent sessions leave no durable evidence: what ran, what it cost, what
changed, what proves it correct all evaporate when the terminal closes.
Nothing of coreartifact exists yet — this campaign builds the demo path
end-to-end thin (`init` → a captured session → `log`/`show`) so that every
platform surprise surfaces in the cheapest campaign.

## Solution

The walking skeleton of the evidence ledger. `npx coreartifact init`
installs per-repo capture: Claude Code hooks append envelope lines to an
append-only spool, including from worktree sessions via layered
propagation. `coreartifact log` / `show <session>` lazily ingest the spool
into the per-repo SQLite ledger and render sessions with their evidence
facets, honestly marking anything absent. Every layer present, no layer
deep.

## Requirements

Each criterion below is the acceptance test's phrasing. All run at the
single seam in Testing decisions unless marked *unit*. All are deltas —
none holds against today's tree (no CLI exists).

- **R1 Install.** After `init` in a fresh tmpdir git repo: exit 0; stdout
  inventories exactly what was installed (hook config, hook artifact,
  spool + ledger location, gitignore line, registry entry); the repo tree
  diff shows ONLY those additions. The hook config subscribes exactly
  nine events: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
  PostToolUseFailure, SubagentStart, SubagentStop, Stop, SessionEnd
  (PreToolUse is deliberate: it leaves the in-flight command visible when
  a session dies mid-command). WorktreeCreate and WorktreeRemove are
  deliberately NOT subscribed — see the 2026-07-14 amendment.
- **R2 Init idempotence + merge.** Re-running `init`: exit 0, no duplicate
  hook entries, no duplicate registry entry. A pre-existing settings file
  with unrelated user keys keeps those keys intact.
- **R3 Propagation.** `init` in a repo that already has a worktree: the
  settings file appears in that worktree. (The former second clause —
  WorktreeCreate-hook propagation — was removed by the 2026-07-14
  amendment: the platform made it impossible without breaking the host.)
- **R4 Capture.** Replaying each recorded fixture stream through the
  installed hook command verbatim: one spool line per event; every line
  parses as envelope v1 with the payload byte-preserved; boundary lines
  carry head sha + dirty flag; N parallel interleaved replays lose zero
  lines (spool line count = sum of inputs).
- **R5 Worktree capture + attribution.** The hook invoked with a worktree
  cwd appends to the main checkout's spool; after ingest the session row
  carries the main repo root with the worktree path recorded. A non-git
  cwd falls back to the init root.
- **R6 Ingest.** Running `log` ingests the spool: session and event rows
  appear. Re-running changes zero row counts (idempotent). Deleting the
  ledger and re-running rebuilds equivalent rows (the spool is ground
  truth). A corrupt line is skipped, counted, and named in output, and
  every subsequent line still ingests. Events of concurrent sessions
  interleaved in one spool group by session id.
- **R7 Status.** SessionEnd present → `closed-clean`. Absent with the last
  event older than the staleness threshold (named constant, 12h) →
  `closed-inferred`. Absent and recent → `open`. A late-ingested
  SessionEnd flips `closed-inferred` back to `closed-clean` — status is
  recomputed on every ingest, never a one-way door.
- **R8 Facets.** Per session: sha before/after from boundary lines;
  footprint = distinct file paths from file-editing tool events; every
  Bash command records its command string, outcome, and duration; a
  PostToolUseFailure records a failure outcome with its error string
  preserved; an auto-backgrounded command records outcome ABSENT,
  distinguishable from both success and failure.
- **R9 Kind.** Session kind (`headless`/`interactive`) is populated iff
  the recording pass finds a discriminating signal in real payloads
  (fixture-verified); otherwise it records ABSENT. Never inferred
  heuristically.
- **R10 Log.** One line per session containing at minimum: short id,
  repo, status, kind-or-absent, start time, command count, footprint
  count. With two registered repos, `log` unions both. Ingest emits a
  warning naming any worktree missing the settings file and stays silent
  when propagation is complete.
- **R11 Show.** `show <session>` prints a flat chronological timeline —
  lifecycle events, prompts, every command with outcome + duration,
  subagent events with agent id/type — headed by shas and footprint. An
  unknown session id exits nonzero with an error naming the id.
- **R12 Degradation rendering.** In `log` and `show`, an absent facet
  renders as an explicit absent marker, distinguishable from
  empty/zero/success — asserted for sha-absent, kind-absent, and
  outcome-absent.
- **R13 Packaging.** The packed tarball installs into a tmpdir and exposes
  bins `coreartifact` and `cart`; `cart log` output is identical to
  `coreartifact log`. (The npx path is checked via pack + install, not the
  live registry.)
- **R14 Fixtures (recording pass).** Committed fixture streams cover:
  interactive, headless, worktree, SIGTERM, SIGKILL; each stamped with the
  Claude Code version it was recorded on; the WorktreeCreate payload shape
  is recorded. **Operator-assisted** — live sessions need the operator's
  machine and key.

## Contracts (shapes, not paths — final columns owned by the schema.md pass)

**Flag: this PRD creates persistent data and an on-disk interface — the
data-architect schema.md co-authoring pass runs before decompose.**

Spool envelope v1 (one line per hook invocation, atomic O_APPEND, never
rewritten):

```
{ v: 1, ts: <iso8601>, event: <hook payload, verbatim> }
boundary lines (SessionStart/SessionEnd) add:
  git: { head: <sha | absent>, dirty: <bool | absent> }
```

Ledger (per-repo SQLite, a rebuildable projection of the spool):

```
meta(schema_version)
sessions(session_id, repo_root, worktree_path?, kind?, status,
         sha_before?, sha_after?, started_at, last_event_at, ended_at?)
events(session_id, seq, ts, hook_event_name,
       prompt_id?, agent_id?, agent_type?, tool_use_id?, payload)
```

Registry: one global plain-JSON file listing ledger roots with added-at
timestamps.

Hook artifact: self-contained and zero-dependency (must work in a repo
with no node_modules), referenced by absolute path from the hook config;
always exits 0 — a capture failure must never break the host session. Its
only behaviors: the append and boundary git enrichment (2026-07-14
amendment: WorktreeCreate propagation removed).

Invariants (reviewer prose, not criteria — a faithful test would be green
today or asserts a preserved default): payloads stored verbatim;
transcripts referenced by path, never copied; nothing leaves the machine;
no write path exists outside the CLI; the canonical nesting key is
`agent_id` (there is no `subagent_id`); the spool is never mutated by
ingest.

## Testing decisions

- **One seam.** Acceptance tests build the CLI and drive it as a
  subprocess in fresh tmpdir git repos (worktrees included), replay
  recorded payload fixtures by piping them into the installed hook command
  exactly as Claude Code would deliver them, and assert on stdout, exit
  codes, spool bytes, and ledger rows. Real filesystem, real git, zero
  mocks at this seam.
- **Prior art: none — first campaign.** The harness issue creates the
  harness under `tests/acceptance/` (tmpdir-repo factory + fixture
  replayer). The decomposer writes "copy the `tests/acceptance/` harness
  from the harness issue verbatim" into every subsequent issue's
  Test-harness contract. `tests/scaffold.test.ts` is a placeholder deleted
  with the first real acceptance test.
- **Unit tests** (plain vitest, per stack profile) sit below the seam only
  for pure logic: envelope parsing, attribution resolution, status
  derivation.
- **Shared-surface flag.** The CLI command wiring and the ledger schema
  module are touched by nearly every slice; a later slice's column or
  command addition can break an earlier slice's green tests — the
  decomposer routes those amendments explicitly (gm-portal PRD-0004
  lesson). Fixture files are shared test inputs: regenerating a fixture is
  its own routed change, never a drive-by inside another issue.
- **Gates** per stack profile: `pnpm run typecheck` / `test` / `build`.

## Non-goals (adjacent — looks in-scope, is not)

- No dashboard / `open` (PRD-0003). No checks, doctor, uninstall,
  cost/token enrichment, vitest output parsing, or telemetry ping
  (PRD-0002). The single worktree warning in R10 is not the doctor — no
  other diagnostics ship.
- No transcript reading at all this campaign, even though the path is
  stored — cost enrichment is PRD-0002.
- No tree or nested rendering — nesting keys are captured, rendering
  stays flat (v2).
- No reaction to backgrounded-command completion; outcome-absent is final
  for this campaign.
- No `init --global`, no user-level hooks (v1.1 re-entry).
- No spool rotation or compaction — append forever, this campaign.
- No WorktreeCreate/WorktreeRemove subscription (2026-07-14 amendment):
  they are delegation hooks — subscribing would hijack worktree creation
  and break agent spawns. Capture never competes with the host.

## Out of scope (spec-level walls)

Orchestration or dispatch, code review features, multi-vendor adapters,
CI enforcement, evals, team/sync/hosted anything, pricing, desktop app,
Windows-native support (WSL best-effort).

## Open risks

1. **WorktreeCreate payload shape — RESOLVED 2026-07-14 (recording
   pass), in the worse direction.** The payload carries no worktree path
   (only a `name`), and WorktreeCreate is a **delegation hook**: a
   configured hook must create the worktree and print its path, so a
   passive capture subscription breaks every worktree-isolated agent
   spawn. The escalation path fired as designed: propagation is init-time
   copy + ingest warning; WorktreeCreate/WorktreeRemove are not
   subscribed. Residual, observed and accepted: worktree-isolated
   subagents are captured anyway via the parent session's hooks; only new
   top-level sessions in post-init worktrees stay uncaptured until the
   warning names them. Revisit if the platform adds a notification-style
   worktree event.
2. **Headless discrimination may not exist** on current Claude Code — R9
   then lands as permanently-absent kind; revisit when the platform grows
   a signal.
3. **Backgrounded-command final outcome unverified** — outcome-absent
   stands; revisit at PRD-0002 alongside doctor.
4. **Hook drift across Claude Code upgrades** — fixtures pin the recorded
   version; payload drift surfaces as ingest degradation, never capture
   loss (the envelope stores verbatim). Standing chore, accepted at spec
   level.
5. **Hook artifact per-event latency unmeasured** — the recording pass
   measures it; user-noticeable overhead re-opens the artifact form by
   escalation.
6. **Hand-made `git worktree add` with no session involved** stays
   uncaptured until the next ingest warning — accepted residual of the
   layered-propagation ruling.

## Compile sketch (predicted decomposition — hold the decomposer to this)

Contracts tier: ledger schema + envelope + registry (**high** — persistent
contract) · recording pass / fixtures (**high, operator-assisted**) ·
acceptance harness (**medium**). Skeleton tier: hook artifact (**high** —
runs inside foreign sessions) · init incl. propagation (**high** — mutates
user repos) · ingest (**high** — data integrity) · log (**low**) · show
(**low-medium**) · worktree-gap warning (**low**, may fold into ingest) ·
packaging (**medium**). No migration tier — schema v1 from nothing.

## Grill record (2026-07-14)

Worktree capture → layered propagation (init copies to existing worktrees;
WorktreeCreate hook propagates to new ones; ingest warns on gaps) · hook
scope → thin envelope + boundary shas only · headless tagging → recording
pass settles it, nullable kind, honest-absent fallback · test topology →
single subprocess-CLI seam with fixture replay, no mocks · budget → $150 ·
compile sketch confirmed as above.

## Amendment (2026-07-14, recording pass — see docs/recording-pass.md)

Observed on Claude Code 2.1.209: **WorktreeCreate is a delegation hook**
— when configured, Claude Code hands worktree creation to the hook, which
must print the new path; a passive append-only hook fails the spawn
("hook succeeded but returned no worktree path"), killing every
`isolation: worktree` agent in the repo. The payload also carries no
worktree path (a `name` only), and WorktreeRemove never fired. Therefore:
R1 subscribes nine events (WorktreeCreate/WorktreeRemove dropped), R3
loses its WorktreeCreate clause, and propagation is two layers — init-time
copy to existing worktrees + the ingest gap warning. Mitigation observed:
worktree-isolated subagents are captured through the parent session's
hooks regardless. The hook artifact has exactly two behaviors: the append
and boundary git enrichment.
