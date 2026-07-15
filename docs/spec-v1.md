# coreartifact — v1 spec

Drafted 2026-07-12 (grill round 1), deep interview + platform-fact
verification same day (round 2, twelve further rulings). This is the
binding record and compiler input for the v1 build. Shared understanding
confirmed by the operator 2026-07-12; nothing below re-opens without a
named reason.

## One sentence

**When agents write the code, the code stops being the scarce artifact — the
evidence is.** coreartifact is the local-first evidence ledger for agent-built
software: what ran, what it cost, what changed, and what proves it correct.

## Positioning

- Category: the system of record for agent work — vendor-neutral,
  evidence-first. NOT a cost tracker (cost is one derived column; evidence
  is the spine). NOT an orchestrator (never compete with the harness; that
  layer is being absorbed by platform vendors — this product lives in the
  layer they structurally can't own neutrally).
- The wedge claim, in the user's language: "every agent session in this
  repo is recorded with receipts — cost, footprint, gates, checks — and my
  code never leaves my machine."
- Naming: "artifact" carries devops-registry connotation (Artifactory) and
  Anthropic's Artifacts feature is ambient noise; the tagline does the
  steering — evidence, not binaries. coreartifact.com is owned. npm
  package `coreartifact` — reserve immediately (operator action, before
  anything else becomes public).

## Wedge user (v1)

Solo agent power-users: people running Claude Code daily on real projects,
including headless/dispatched fleets. Founder-market fit is exact. Team
anything waits behind the expand gate.

## v1 surface

OSS, single-player-complete:

1. **Capture** — Claude Code hooks recorder installed by
   `npx coreartifact init`; zero workflow change.
2. **Ledger** — per-repo SQLite over an append-only spool (architecture
   below), one vendor-neutral versioned schema.
3. **View** — `coreartifact open` (read-only local dashboard) +
   `coreartifact log` / `show <session>` (CLI).
4. **Checks** — `coreartifact check <name> -- <cmd>`: runs the command,
   records name + command + output + pass/fail bound to the active session
   (nullable session for standalone runs); rendered as evidence badges.
   The seed of the trust layer; deliberately thin.

Bins: `coreartifact` (canonical — all docs and examples) + `cart` (the one
blessed short alias, mentioned once in the README).

## Architecture rulings (interview, 2026-07-12)

- **Storage: per-repo + global registry.** `.coreartifact/ledger.db` per
  repo (gitignored by init); `~/.coreartifact/registry.jsonl` lists known
  ledgers; the dashboard unions registered ledgers for the cross-repo
  "today" view. Repo = trust boundary; uninstall is per-repo and total.
- **Write path: spool → lazy ingest.** Hooks do exactly one atomic
  O_APPEND of one JSON line to a per-repo spool (microseconds — fits every
  hook timeout, contention-free across concurrent worktree sessions);
  `log`/`open` ingest the spool into SQLite on read; the raw spool remains
  ground truth if ingestion ever has a bug.
- **Install locus: per-repo `.claude/settings.local.json`** (explicit
  opt-in per repo, teammate-invisible, cleanly removable). `init --global`
  is a v1.1 re-entry on demonstrated many-repo pain.
- **Attribution: git common dir.** Worktree sessions resolve to the main
  repo's ledger (worktree path kept as a session column); non-git dirs
  fall back to the init root; headless sessions are captured and tagged
  `headless` — the agent fleet is first-class, not an edge.
- **Granularity: flat stream, nesting keys captured.** v1 renders a flat
  per-session timeline; `prompt_id`, `subagent_id`, `tool_use_id` are
  recorded on every event so the v2 tree view is pure UI, no migration.
- **Cost: fail-soft transcript enrichment.** Cost/tokens are a DERIVED
  facet parsed from the session transcript JSONL (the only local source —
  verified absent from hook payloads), version-pinned to tested Claude
  Code releases and labeled derived in the UI. On parser mismatch the
  facet records ABSENT (never zero, never estimated silently) and
  `coreartifact doctor` names the needed parser update. Evidence facets
  (commands, checks, footprint, shas) ride ONLY the stable hooks surface —
  the trust spine never depends on the unstable parse.
- **Test parsing: vitest-only, pluggable.** Every command records with its
  exit status universally; one deep parser (vitest) ships in v1 behind a
  parser interface sized for contribution; further runners (pytest first)
  are gated on demonstrated demand.
- **Dashboard: strictly read-only.** One GET surface over SQLite; all
  actions live in the CLI. First UI action arrives only on demonstrated
  pull, implemented as a CLI invocation, never a parallel write path.
- **Session lifecycle (default):** SessionEnd appends an end event when it
  fires; a session with no end event and no recent activity is finalized
  at ingest as `closed-inferred`, visually distinct from `closed-clean`
  (crash-path firing is unverified — honesty over tidiness).
- **Defaults (operator may veto):** dashboard = vite+react static assets
  served by the CLI's local server; transcripts are never copied — the
  path is stored, the file stays Claude Code's; registry is an **append-only
  JSONL log** (amended 2026-07-14 — it was specced as a plain JSON file, and
  the read-modify-write that shape forces cost three consecutive review rounds
  to concurrency bugs; it is now the same append-and-fold pattern as the spool,
  which deletes the bug class rather than fixing it); macOS/Linux are tier-1,
  Windows best-effort via WSL until demand.

## Verified platform facts (2026-07-12, live docs — superseded in part by the 2026-07-13 smoke test below)

- `session_id`, `transcript_path`, `cwd` are present in EVERY hook
  payload; 31 hook events exist including SessionStart/SessionEnd,
  SubagentStart/Stop, PostToolUse/PostToolUseFailure.
- PostToolUse(Bash) carries the command string, stdout/stderr, and
  `duration_ms`; failures carry an `error` naming the exit status —
  sufficient for "every command with outcomes."
- **Cost/tokens are NOT in any hook payload.** They exist only in the
  `claude -p` JSON envelope (invisible to hooks) and the transcript JSONL,
  whose schema is documented as internal and breakable on any release —
  hence the fail-soft ruling above.
- SessionEnd default timeout is 1.5s (spool append fits); firing on
  crash/SIGKILL is UNVERIFIED — hence lazy finalization.
- Hooks can be user-global, but a project cannot selectively opt out of
  user-level hooks (`disableAllHooks` is all-or-nothing) — a further
  argument for the per-repo install ruling.

## Hooks smoke test findings (2026-07-13, OBSERVED — Claude Code 2.1.208, macOS; docs cross-checked at code.claude.com/docs/en/hooks)

The pre-PRD platform act, executed: real hook installed via per-repo
`.claude/settings.local.json` (an atomic `jq -c` O_APPEND to a spool),
five real headless sessions plus kill and worktree variants. 25 events
captured, zero spool errors, zero lost lines. Observed truth supersedes
the 2026-07-12 fact sheet where they conflict.

- **Headless capture works, full lifecycle.** `claude -p` with
  per-repo `settings.local.json` fires SessionStart → UserPromptSubmit →
  PreToolUse → PostToolUse → Stop → SessionEnd. The fleet lane is safe
  to build on.
- **Crash paths, observed:** SIGKILL → spool simply stops (no Stop, no
  SessionEnd). SIGTERM → SessionEnd fires, no Stop. `closed-inferred`
  lazy finalization confirmed necessary. Caveat: SessionEnd `reason` was
  `"other"` for BOTH clean headless completion and SIGTERM — reason does
  not discriminate; closed-clean vs closed-inferred = presence/absence
  of the SessionEnd event, nothing finer.
- **Payload shapes, observed (richer than documented):**
  `session_id`/`transcript_path`/`cwd`/`hook_event_name` on every event;
  `prompt_id` on everything after prompt submit (including SessionEnd);
  `permission_mode` + `effort` on tool events. PostToolUse(Bash) carries
  `tool_input.command`, `tool_response.{stdout,stderr,interrupted}`,
  `tool_use_id`, `duration_ms`. PostToolUseFailure carries `error` (a
  string embedding `Exit code N` + message), `is_interrupt`,
  `duration_ms` — and NO `tool_response`.
- **Nesting keys, real names:** `prompt_id`, `tool_use_id`, and
  `agent_id` + `agent_type` (there is no `subagent_id` — schema should
  use `agent_id`). SubagentStart/SubagentStop fire; every tool event
  inside a subagent carries `agent_id`/`agent_type`; SubagentStop also
  carries `agent_transcript_path` and `last_assistant_message`. The
  flat-stream ruling holds as designed. The spawning tool is named
  `Agent` in 2.1.208.
- **Cost absence re-confirmed:** no cost/token field in any observed
  payload; `claude -p --output-format json` envelope carries
  `total_cost_usd` + full `usage` (invoker-visible only). Fail-soft
  derived-cost ruling stands.
- **WORKTREE CAPTURE GAP (spec-reshaping — settle at PRD-0001 grill):**
  a session running in a git worktree does NOT load the main checkout's
  `.claude/settings.local.json` — the gitignored file is absent from the
  worktree checkout and Claude Code has no git-common-dir fallback
  (control run in the main checkout fired; identical worktree run fired
  nothing). The git-common-dir attribution ruling stands, but capture
  must exist before attribution matters: PRD-0001 must name the
  worktree-capture mechanism (candidates: init writes a propagation
  step; WorktreeCreate/WorktreeRemove hook events exist in 2.1.208;
  dispatcher-side settings copy for fleets; earlier `init --global`
  re-entry). Until then, worktree sessions are silently uncaptured.
- **Auto-backgrounded commands:** a long-running Bash (`sleep 120`) was
  auto-backgrounded — PostToolUse fired in 155 ms with
  `tool_response.backgroundTaskId` and empty stdout; whether any later
  event carries the eventual outcome is UNVERIFIED. "Every command with
  outcome" must treat backgrounded commands as outcome-absent (honest
  degradation) until observed otherwise.
- **Stale 2026-07-12 facts:** docs now enumerate 30 hook events, not 31
  (SubagentStart/Stop, PostToolUseFailure, WorktreeCreate/Remove all
  real); the SessionEnd 1.5s-timeout claim is gone — command hooks
  default 600s.
- **Not yet covered (operator-lane):** one interactive session
  eyeballed end-to-end (all smoke runs were headless — the inverse of
  the usual gap); hook behavior across `claude` version upgrades.

## Requirements — the v1 done-criterion (machine-checkable)

Demo-scriptable end to end, assertable in CI against a fixture repo:

- `npx coreartifact init` completes in under 10 minutes with no
  hand-written config and prints what it installed (hooks, spool, ledger,
  registry entry).
- The next Claude Code session in that repo (or any of its worktrees) is
  recorded automatically: session row with file footprint, git shas
  before/after, every command with outcome and duration, parsed vitest
  results when vitest ran, and cost/tokens as a derived facet when the
  pinned parser matches (absent otherwise, distinguishably).
- `coreartifact open` renders it; `coreartifact log` prints
  one-line-per-session summaries across registered repos.
- `coreartifact check lint -- <cmd>` records a bound evidence badge.
- Degradation is explicit everywhere: an unavailable facet records as
  absent, never as fabricated or silently zero — an empty facet is always
  distinguishable from a clean one.
- Uninstall is one command and leaves the repo byte-identical except the
  ledger/spool it removes.

## Data stance (load-bearing)

Local-first. OSS core: nothing leaves the machine — no code, no
transcripts, no telemetry by default. One opt-in anonymous weekly ping
(version + install id), off by default, asked once at init, exists solely
to measure the expand gate. The future hosted layer syncs evidence
metadata only — outcomes, costs, check results, paths, sha references —
never file contents or transcripts. "Your code never leaves your machine"
is a law, not a preference.

## Compatibility stance (load-bearing, 2026-07-14)

coreartifact's evidence spine rides a platform whose payloads are
semi-documented and whose internals move. This stance is how that is
survivable rather than a treadmill. It is derived from observation, not
hope — see `docs/recording-pass.md`.

**Three layers, three different failure modes.**

1. **Capture is version-agnostic — and must stay that way.** The hook
   artifact parses nothing: it appends the payload verbatim and exits.
   New fields, renamed fields, new event types are all captured
   losslessly, because nothing on the hot path understands what it is
   writing. Unknown hook event names are ignored by Claude Code, not an
   error (observed 2.1.209) — so coreartifact may subscribe a **superset**
   of events and still run against older releases. Any proposal that puts
   parsing, schema knowledge, or version branching into the hook artifact
   is rejected on sight: it would trade this property away.
2. **Derivation is where drift lands, and it degrades honestly.** Promoted
   columns and facets are read from payloads at ingest/render. A renamed or
   removed field makes a facet **ABSENT** (NULL) — never wrong, never
   fabricated. Because the spool is ground truth and the ledger is a
   disposable projection, **drift is recoverable, not lossy**: ship a fixed
   parser, delete the ledger, re-ingest, and every historical session
   retroactively regains its facets. Evidence captured is never evidence
   lost; only temporarily evidence unread.
3. **Semantic change is the dangerous class.** WorktreeCreate is the
   cautionary tale: subscribing it does not observe worktree creation, it
   *delegates* it — a passive capture hook breaks every worktree-isolated
   agent in the repo. Verbatim storage protects against nothing here,
   because the harm is to the **host**, not to the data. The discipline:
   subscribe the minimum event set that the requirements need, and **never
   subscribe an event whose semantics have not been personally observed**.
   For any new event, the question the recording pass must answer is not
   "what shape is the payload" but "does subscribing this change Claude
   Code's behavior?"

**The version-support contract (what we promise users).** Capture works on
any version. Facets are verified against a named, tested range (currently
**2.1.208–2.1.209**), published in the README. Outside that range, capture
still records everything and facets may degrade to ABSENT — and `doctor`
names which ones and why. We never silently guess a facet to preserve the
appearance of support.

**The maintenance loop (the fixtures ARE the regression suite).** On each
Claude Code release: re-run the recording protocol
(`docs/recording-pass.md`), replay the new streams through the acceptance
tests — they go red exactly where payloads drifted — fix the parsers, bump
the tested-range stamp, ship. The diff between the old fixture and the new
one **is** the changelog. Budget ~30 minutes per release; `coreartifact
record` (v1.1) is the investment that turns it into ~5 (and the difference
between a chore done and a chore skipped).

**The fragile-dependency register.** Most brittle first — every entry here
is a facet whose source can vanish on any release, and each must fail to
ABSENT, never to a guess:

| dependency | facet it feeds | why fragile |
|---|---|---|
| transcript JSONL schema | cost/tokens (PRD-0002) | documented as internal + breakable; the standing tax the spec already accepted |
| `model` on SessionStart | session `kind` | undocumented; our newest dependency (2026-07-14) |
| `error` string embedding `Exit code N` | command outcome | string parsing, not a field |
| `tool_response.backgroundTaskId` | outcome ABSENT | undocumented |
| `agent_id` / `agent_type` | nesting keys | already renamed once (docs said `subagent_id`) |
| `duration_ms` | command duration | undocumented |

The trust spine — shas, footprint, commands, checks — rides only stable,
documented surfaces. That was the original ruling and it is holding: every
2026-07-13/14 surprise landed in the register above, never in the spine.

## OSS / paid line

Single-player is OSS-complete and never crippled (capture, ledger, CLI,
dashboard, checks). License: **Apache-2.0** (confirmed — the patent grant;
you pick the conservative license once). Paid, post-gate = multiplayer:
hosted sync, team dashboards, retention, org trust policy, CI-enforced
checks. The line is single-player vs multi-player.

## Expand gate + roadmap

No hosted or team feature until BOTH: ≥50 weekly-active installs (opt-in
ping) AND ≥3 unprompted asks for sync/team.

Graduating layers, each with its own gate: **v1.1** second adapter (Codex
CLI — the schema-neutrality proof), `init --global` (on many-repo pain),
and **`coreartifact record`** (the recording protocol as a command — the
maintenance loop's highest-leverage investment; gate: the first release
where re-recording by runbook is felt as a chore) · **v2** prompt-surface
evals + locked-acceptance workflow (need the corpus v1 accretes) and the
session tree view (pure UI over captured keys) · **post-gate** the hosted
trust layer.

## Launch posture

**Private while building; public at v1 launch** (operator ruling,
overriding the build-in-public lean). To keep "built with receipts"
verifiable rather than curated: the ENTIRE git history publishes
unredacted at launch — commit log, PRD artifacts (prd/plan/dag/schema/
retro), escalation amendments, release packets — and the launch write-up
walks that history. **Amended 2026-07-15 (operator ruling): the aeh
ledger does NOT publish.** `.aeh/aeh.db`, `events.jsonl`, and transcripts
stay local and untracked (as the gitignore already had them) — they are
operational exhaust, not evidence: absolute machine paths and session
internals with no verification value the tracked artifacts don't already
carry. The write-as-if-public discipline for ledger entries stands
regardless. The npm name was reserved 2026-07-15 (`coreartifact@0.0.0`
placeholder, operator act complete).

## Non-goals (v1, confirmed)

Agent orchestration or dispatch of any kind · code review features ·
multi-vendor adapters · CI enforcement · prompt-surface evals · the
locked-acceptance workflow · team/sync/hosted anything · pricing ·
a desktop app (ruled 2026-07-12: wedge user is terminal-native; the
signing/update surface is a solo-founder tax; CLI + local web is the
winning class precedent; the static-assets architecture keeps a Tauri
wrap cheap. Desktop re-entry: users running long unattended sessions ask
for ambient OS-level notifications — a menu-bar monitor, not a dashboard
shell).

## Build motion

Built with aeh: fresh private repo, brownfield `aeh init` (TypeScript CLI
stack — vitest + tsc profile; the web golden template does not apply),
ledger and release packets committed from the first campaign.

**Pre-PRD platform act:** the hooks smoke test — a real hook installed by
hand, a real session, the spool inspected; findings dated and recorded,
reshaping criteria if the fact sheet above missed anything. DONE
2026-07-13 — see the smoke test findings section; one interactive-session
eyeball remains operator-lane.

**Three campaigns, skeleton-first:**
1. **PRD-0001 — walking skeleton:** init, hook capture, spool, lazy
   ingest, `log`/`show`, attribution rules. The 10-minute demo minus
   polish, end-to-end thin — every platform surprise surfaces here, in
   the cheapest campaign.
2. **PRD-0002 — evidence depth:** vitest parser (pluggable interface),
   fail-soft cost enrichment, the checks primitive, `doctor`, uninstall,
   the telemetry ping + consent. **`doctor` widened (2026-07-14):** it is
   not just the cost-parser reporter — it is the **drift reporter**. It
   names the running Claude Code version, the tested range, and every facet
   currently degrading to ABSENT *with its reason* (the register in the
   Compatibility stance is its checklist). Ingest gains a cheap drift
   detector to feed it: because payloads are stored verbatim, ingest can
   notice "SessionStart no longer carries `model`" and record kind ABSENT
   with a reason rather than a shrug. Silent drift is the enemy; the
   product's own thesis applied to itself.
3. **PRD-0003 — dashboard:** the read-only viewer, designed against a
   by-then-real ledger.

**Launch acts (added 2026-07-15)** — after PRD-0003, before the public
flip; operator-lane hand-work like the retro, not a dispatched campaign:

- README — the front door: the laws up top, quickstart (init → session →
  `log`/`show`), Node floor, pre-1.0 no-support banner, plus the two
  facts this spec already mandates it carry: the `cart` alias and the
  tested Claude Code version range.
- LICENSE + NOTICE — Apache-2.0 (confirmed above); correct the npm
  placeholder's wrong MIT stamp at the next publish.
- SECURITY.md — vulnerability contact + the privacy law restated.
- Contribution posture — a short "personal-first, no contributions
  before 1.0, issues welcome without SLA" note or issue-template config.
- CI — the existing gates (typecheck/test/build) on GitHub Actions;
  prerequisite for npm provenance at the v1 publish.
- The launch write-up walking the public history (per Launch posture).
- The flip itself: repo public, `private: true` removed, v1 published
  over the placeholder.

## Open risks

- **Transcript-parse maintenance tax:** the cost facet breaks on Claude
  Code releases by design of its source; the fail-soft + doctor shape
  contains it, but it is a standing chore. Accepted knowingly.
- **Crash-path capture:** RESOLVED by observation 2026-07-13 (see smoke
  test findings): SIGKILL fires nothing, SIGTERM fires SessionEnd, and
  `reason` discriminates neither — `closed-inferred` stands as designed.
- **Worktree capture gap:** worktree sessions load no hooks from the
  main checkout (smoke test, 2026-07-13) — uncaptured until PRD-0001
  names the mechanism. The single open spec-level risk from the smoke
  test.
- **Platform absorption:** Anthropic could ship a native session ledger.
  Mitigations are structural: vendor neutrality, local-first stance, and
  the user-owned corpus. If plumbing is absorbed, retreat up a layer
  (checks, evals, policy) by design.
- **Commodity adjacency:** if usage shows cost is the only facet read,
  that's a wedge-miss signal to confront, not spin.
- **Solo bandwidth:** gm-portal service work and coreartifact compete for
  gate attention; max two concurrent campaigns holds across projects.

## Decisions log

Round 1 (2026-07-12): wedge user = solo power-users · wedge pain =
drop-in evidence ledger · extract the spine, aeh stays private proving
ground · Claude Code capture, neutral schema, Codex v1.1 · single-player
OSS-complete · evidence-rich capture · local-first, metadata-only sync ·
ship thin checks · 10-minute done-criterion · expand gate 50 WAU + 3
unprompted asks · non-goals wall · aeh-built · no desktop app.

Round 2 (2026-07-12, deep interview): per-repo ledger + registry · spool
→ lazy ingest · per-repo settings.local.json install · git-common-dir
attribution + headless first-class · vitest-only pluggable parsing ·
fail-soft derived cost (hooks verified cost-free) · read-only dashboard ·
flat stream w/ nesting keys · `coreartifact` + `cart` bins · public at
launch w/ unredacted history (operator override) · Apache-2.0 · three
campaigns skeleton-first.
