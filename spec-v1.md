# coreartifact — v1 spec

Drafted 2026-07-12 with the aeh grill discipline (decision-dependency ordered,
every requirement checkable, non-goals non-empty). This document is compiler
input for the v1 build and the record of what was decided and why. Supersedes
nothing; the aeh repo remains the private proving ground.

## One sentence

**When agents write the code, the code stops being the scarce artifact — the
evidence is.** coreartifact is the local-first evidence ledger for agent-built
software: what ran, what it cost, what changed, and what proves it correct.

## Positioning

- Category: the system of record for agent work — vendor-neutral, evidence-
  first. NOT a cost tracker (ccusage-class tools are commodity; cost is one
  column here, evidence is the spine). NOT an orchestrator (never compete
  with the harness — that layer is being absorbed by platform vendors
  release by release; this product lives in the layer they structurally
  can't own neutrally).
- The wedge claim, in the user's language: "every agent session in this repo
  is recorded with receipts — cost, footprint, gates, checks — and my code
  never leaves my machine."
- Naming note: "artifact" carries devops-registry connotation (Artifactory;
  build artifacts) and Anthropic's Artifacts feature is ambient noise. The
  tagline does the steering work: evidence, not binaries. coreartifact.com
  is owned; reserve the npm name immediately (operator action).

## Wedge user (v1)

Solo agent power-users: people running Claude Code daily on real projects.
Founder-market fit is exact; distribution is OSS + content; the paying buyer
(team lead) arrives later, pulled by these users. Team anything is behind
the expand gate below.

## v1 surface

An OSS, single-player-complete tool, three parts:

1. **Capture** — Claude Code hooks-based recorder installed by
   `npx coreartifact init`: records sessions with zero workflow change.
2. **Ledger** — local SQLite, one vendor-neutral versioned event schema.
3. **View** — `coreartifact open`: a local dashboard over the ledger, plus
   a terse CLI (`coreartifact log`, `coreartifact show <session>`).

Plus exactly one trust primitive:

4. **Checks** — `coreartifact check <name> -- <cmd>` (and a hook variant):
   runs the command, records name + command + captured output + exit
   status, bound to the active session; rendered as evidence badges. The
   seed of the trust layer and the future CI hook. Thin by design.

## Requirements — each criterion machine-checkable

The v1 done-criterion (demo-scriptable end to end, assertable in CI against
a fixture repo):

- `npx coreartifact init` completes in a repo in under 10 minutes with no
  hand-written config, and prints what it installed (hooks, ledger path).
- The next Claude Code session in that repo is recorded automatically: the
  ledger holds a session row with cost/token totals, the file footprint
  (paths touched), git shas before/after, every command the session ran
  with exit codes, and parsed test-runner outcomes when a test command ran.
- `coreartifact open` renders that session with all of the above visible;
  `coreartifact log` prints a one-line-per-session summary.
- `coreartifact check lint -- <cmd>` records a bound check with captured
  output and pass/fail, and the dashboard shows it as a badge on the
  session.
- Graceful degradation is explicit: any capture facet that is unavailable
  (e.g. a hook that didn't fire) records as absent, never as fabricated or
  silently zero — an empty facet must be distinguishable from a clean one
  (the aeh empty-vitest-report lesson, applied from birth).
- Uninstall is one command and leaves the repo byte-identical except the
  ledger file.

## Schema commitments

- One versioned, vendor-neutral event schema from the first migration —
  adapter-specific fields namespaced, nothing Claude-Code-shaped in core
  tables (the aeh dispatch-contract lesson). Claude Code is the only v1
  adapter; a second adapter (Codex CLI) is the v1.1 neutrality proof, not
  a v1 promise.
- The session is the primary unit; turns/dispatches nest under it. Exact
  granularity is a build-time decision recorded in the schema doc when the
  hooks surface is verified (open risk below).
- SQLite, local, one file per machine or per repo (decide at build against
  real usage; lean per-repo — the repo is the trust boundary).

## Data stance (load-bearing)

Local-first. In the OSS core, nothing leaves the machine — no code, no
transcripts, no telemetry by default. One opt-in anonymous weekly ping
(version + install id only) exists solely to measure the expand gate, off
by default, asked once at init. The future hosted layer syncs evidence
metadata only — outcomes, costs, check results, file paths, sha references
— never file contents, never transcripts. "Your code never leaves your
machine" is a standing product claim; treat it as a law, not a preference.

## OSS / paid line

Single-player is OSS-complete and never crippled: capture, ledger, CLI,
dashboard, checks — permissive license (default Apache-2.0 for the patent
grant; revisit only with counsel). Paid (post-gate) = multiplayer: hosted
sync, team dashboards, retention, org trust policy, CI-enforced checks.
The line is single-player vs multi-player — defensible and fair.

## Expand gate + roadmap

No hosted or team feature is built until BOTH: ≥50 weekly-active installs
(the opt-in ping) AND ≥3 unprompted asks for sync/team. Re-entry-condition
discipline applied to the roadmap.

Layers that graduate later, in pull order, each with its own gate:
- **v1.1** second adapter (Codex CLI) — proves schema neutrality.
- **v2** prompt-surface evals (paired replay over the fixture corpus the
  ledger accretes) and the locked-acceptance workflow — the deep aeh
  mechanisms, productized only once the ledger has created their raw
  material in user repos.
- **Post-gate** the hosted trust layer: sync, team views, org policy.

## Non-goals (v1, confirmed)

Agent orchestration or dispatch of any kind · code review features ·
multi-vendor adapters · CI enforcement · prompt-surface evals · the
locked-acceptance workflow · team/sync/hosted anything · pricing ·
a desktop app (ruled 2026-07-12: the wedge user is terminal-native, the
signing/update surface is a standing solo-founder tax, and the winning
class precedent is CLI + local web; the dashboard ships as self-contained
static assets served by the CLI's local server over SQLite, which keeps a
Tauri wrap cheap if ever warranted. Named re-entry for a desktop surface:
users running long unattended sessions ask for ambient OS-level
notifications — a menu-bar monitor, not a dashboard shell).

## Build motion

Built WITH aeh, publicly: fresh repo, brownfield `aeh init` (TypeScript
CLI stack — vitest + tsc profile; the web golden template does not apply),
campaigns from the first PRD, ledger and release packets committed to the
repo. The meta-story is the launch content: built by agents, with receipts.
This also legitimately fires aeh's own productization re-entry (three PRDs
across two projects).

## Open risks

- **The hooks capture surface is unverified.** Whether Claude Code hooks
  expose cost/token totals, session boundaries, and command outcomes at
  the fidelity v1 assumes must be verified against live docs and a smoke
  test BEFORE the first PRD freezes (the aeh platform-facts law: never
  assert harness behavior from memory; date and record what's found).
  Capture fidelity findings reshape the criterion list, not the wedge.
- **Platform absorption.** Anthropic could ship a native session ledger.
  Mitigations are structural: vendor neutrality, local-first privacy
  stance, and the org-specific corpus — value that accretes to the user,
  not the vendor. If the plumbing is absorbed, the product retreats up a
  layer (checks, evals, policy) by design.
- **Commodity adjacency.** Week-one users may read it as a cost dashboard.
  The checks primitive and evidence-first dashboard design carry the
  positioning; if usage data shows cost is the only facet used, that's a
  wedge-miss signal to confront, not spin.
- **Solo bandwidth.** Two products (gm-portal service work + coreartifact)
  compete for gate attention. The aeh spec's own lean — max two concurrent
  campaigns — applies across projects too.

## Decisions log (grill record, 2026-07-12)

Wedge user: solo agent power-users · wedge pain: drop-in evidence ledger ·
aeh relation: extract the spine, aeh stays the private proving ground ·
vendor scope: Claude Code capture, neutral schema, Codex as v1.1 proof ·
OSS line: single-player OSS-complete · capture: evidence-rich (cost +
footprint + shas + command outcomes + test parses) · data stance:
local-first, metadata-only sync · trust seed: ship thin checks primitive ·
done-criterion: the 10-minute zero-config demo above · expand gate: 50 WAU
+ 3 unprompted team asks · non-goals: confirmed as listed · build motion:
aeh-built, publicly.
