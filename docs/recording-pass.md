# Recording pass — findings (operator lane)

Recorded 2026-07-14 on **Claude Code 2.1.209**, macOS (the smoke test of
2026-07-13 ran on 2.1.208; observations below supersede it where they
conflict). Recorder: per-repo `settings.local.json` subscribing all hook
events, each doing a `jq -c` O_APPEND of the raw stdin payload to a
per-scenario stream file. Streams live at `tests/fixtures/<scenario>.jsonl`
— raw payloads as delivered, one JSON object per line, never edited.

## Stream status

| scenario | file | status |
|---|---|---|
| headless | `headless.jsonl` | recorded (22 events) |
| worktree | `worktree.jsonl` | recorded (26 events, three sessions — see below) |
| SIGTERM | `sigterm.jsonl` | recorded (23 events) |
| SIGKILL | `sigkill.jsonl` | recorded (6 events) |
| interactive | `interactive.jsonl` | recorded (18 events, operator keyboard session 2026-07-14) |

The interactive stream is a real keyboard session (the PTY could not be
scripted — Claude Code's TUI does not ingest keystrokes from a spawned
pty, so this one is operator-recorded). It carries a successful Bash
command, a `PostToolUseFailure` (`Exit code 1`), a Read + Edit pair, and a
clean `/exit`. It also closes spec-v1's standing operator-lane item: one
interactive session eyeballed end to end.

The headless stream contains every payload variant the facet criteria
need: Bash `PostToolUse` with `tool_input.command` / `tool_response` /
`duration_ms`; a `PostToolUseFailure` whose `error` embeds `Exit code 1`
and which carries **no** `tool_response`; an auto-backgrounded
`PostToolUse` (`tool_response.backgroundTaskId`, empty stdout); Write and
Edit events; an Agent spawn with `SubagentStart`/`SubagentStop` and
`agent_id`/`agent_type` on every subagent tool event.

## FINDING 1 (spec-reshaping): WorktreeCreate is a delegation hook, not a notification

Observed on 2.1.209: configuring a WorktreeCreate hook makes Claude Code
**delegate worktree creation to the hook**, which must print the new
worktree's path to stdout (or return `hookSpecificOutput.worktreePath`).

- A passive append-only hook (exit 0, no stdout) **fails the spawn**:
  `Agent` with `isolation: worktree` dies with "WorktreeCreate hook failed:
  hook succeeded but returned no worktree path". Captured verbatim in
  `worktree.jsonl` (first session, `PostToolUseFailure` on `Agent`).
- The WorktreeCreate payload carries `session_id`, `transcript_path`,
  `cwd` (the main checkout), `prompt_id`, and a `name`
  (`agent-<id>`) — **no worktree path exists in the payload** (open risk 1:
  answered, in the worse direction).
- With a properly-delegating hook (record + `git worktree add` + echo
  path), the spawn succeeds and the subagent runs inside the delegated
  worktree (second session in `worktree.jsonl`).
- **WorktreeRemove never fired** in either flow — cleanup of a delegated
  worktree is not hook-notified.

**Consequence for the product:** coreartifact's capture hook must NOT
subscribe WorktreeCreate or WorktreeRemove — a passive subscription breaks
every worktree-isolated agent in the repo, violating the "capture never
breaks the host session" law. Worktree propagation degrades to the
init-time copy plus the ingest gap warning, as the PRD's escalation path
pre-authorized. Mitigating observation: a worktree-isolated **subagent's
events are captured anyway** through the parent session's hooks (tagged
`agent_id`/`agent_type`) — the gap is only new top-level sessions whose
cwd is a worktree, which the init-time copy and the warning cover.

## FINDING 2: crash semantics reconfirmed on 2.1.209

- SIGTERM → SessionEnd fires, **no Stop** (`sigterm.jsonl`).
- SIGKILL → the stream simply stops mid-tool, no Stop, no SessionEnd
  (`sigkill.jsonl`) — the `closed-inferred` case.
- Bonus real-world interleave in `sigterm.jsonl`: one `PostToolUse`
  landed **after** `SessionEnd` (hook processes racing at shutdown).
  Ingest must tolerate events after a session's end event; ordering is by
  spool line, not by lifecycle assumptions.

## FINDING 3: the kind question (open risk 2) — ANSWERED, a signal exists

**`SessionStart` carries a `model` key if and only if the session is
interactive.** Ingest reads exactly this field: `model` present → `kind =
interactive`; `model` absent → `kind = headless`. Nothing else. No
heuristic (an absent UserPromptSubmit does NOT mean headless).

`source` is **not** the signal — it is `"startup"` in both modes.

The evidence is a controlled 2×2, because the obvious reading was
confounded: every headless stream above was recorded with `--model haiku`,
so "interactive has `model`, headless doesn't" could equally have meant
"the key appears when no `--model` flag was passed." A control run
(headless, **no** `--model` flag) disambiguates:

| session | `model` on SessionStart |
|---|---|
| headless, `--model haiku` | absent |
| headless, default model (control) | absent |
| interactive, default model | **present** (`claude-fable-5`) |

Both headless cells lack it regardless of the flag, so absence is a
property of headless, not of the flag. The fourth cell (interactive with
an explicit `--model`) is not needed for that conclusion.

**A near-miss worth recording:** `effort` on `Stop` looked like a second
discriminator (present in interactive, absent in the `--model haiku`
headless stream) — but the control shows headless-with-default-model
*does* carry `effort`. It tracks the model, not the session mode. Had the
control not been run, `effort` would have shipped as a false signal, and
every default-model headless session would have been mislabeled
interactive. This is exactly why the recording pass exists.

**Fragility, and the honest fallback:** `model` is an undocumented payload
field. If a future Claude Code release drops it, `kind` degrades to
ABSENT — which the schema already permits (the column is nullable and
NULL means ABSENT). It must never degrade to a *guess*.

Note: `permission_mode` appears on tool events (recorded value in the
headless streams: `bypassPermissions`, an artifact of the recording setup,
not a headless signal — interactive sessions can run any permission mode).

## FINDING 4: SessionEnd `reason` — refines the 2026-07-13 claim

The smoke test concluded `reason` "does not discriminate" (it was `other`
for both clean headless completion and SIGTERM). True *within* headless,
and it stands as the basis for the `closed-clean` vs `closed-inferred`
rule (presence/absence of the SessionEnd event, nothing finer). But
interactive adds a third value: a clean `/exit` yields
`reason: "prompt_input_exit"`, where headless clean completion yields
`other`. It is an **end-reason** signal, not a session-kind one, and it is
useless for crashed sessions (SIGKILL emits no SessionEnd at all), so no
requirement reads it in v1. Recorded so a later facet does not have to
rediscover it.

## Latency (open risk 5) — method, measurement pending the artifact

The recorder (`jq -c` append) is not the shipped artifact. Once ISS-0004
builds the zero-dependency hook artifact, measure per-event overhead by
timing N replayed invocations of the built artifact (wall clock / N) and
record the number here. User-noticeable overhead re-opens the artifact's
form by escalation.

## FINDING 5: unknown hook event names are ignored, not an error

Observed 2026-07-14 on 2.1.209: a `settings.local.json` subscribing a hook
event name that does not exist (`TotallyFakeEventName`) does **not** fail
the session, warn, or suppress the real hooks — the session ran normally
and every genuine hook still fired.

**This is the fact the version-compatibility stance rests on** (see
spec-v1.md "Compatibility stance"): coreartifact can subscribe a superset
of hook events and run against older Claude Code releases that have never
heard of some of them. Subscription is therefore forward- and
backward-safe; only *semantics* (finding 1) and *payload shape* (findings
3–4) drift.

## Recording protocol (for re-recording on future Claude Code versions)

One scratch git repo; `settings.local.json` subscribes every event with
`jq -c . >> "$REC_STREAM"`; scenarios driven via `claude -p
--permission-mode bypassPermissions` with per-scenario `REC_STREAM`;
crash variants launched in background and killed mid-tool-sequence
(`kill -TERM` / `kill -9` at ~8s into a ten-command sequence). The
WorktreeCreate recording additionally requires the delegating variant
(record, `git worktree add`, echo path) or the spawn fails. Interactive:
operator keyboard session in the same scratch repo with `REC_STREAM`
exported, running at least one succeeding command, one failing command,
one file edit, then a clean exit.

---

# Recording pass PRD-0002 — findings (2026-07-15)

Recorded on **Claude Code 2.1.211**, macOS, driven from an assistant
session on the operator's machine (a first: the scriptable scenarios ran
as nested `claude -p` sessions; only the rulings stayed on the operator).
Recorder: the same nine-event `jq -c` O_APPEND as production subscribes.
Nested-agent protocol variant: `--permission-mode bypassPermissions` is
refused for nested agents by the host's safety classifier — scoped
`--allowedTools` rules replace it and change nothing about payload shape
except `permission_mode`. The parent session's `CLAUDE*` env vars must be
unset or they leak into the recorded session.

## Stream status (new)

| scenario | stream | transcript pair | oracle |
|---|---|---|---|
| cost-headless | `cost-headless.jsonl` (14 events) | yes | envelope, $0.555957 |
| vitest | `vitest.jsonl` (8 events) | yes | envelope, $0.438619 |
| background | `background.jsonl` (16 events) | yes | envelope, $0.674005 |
| headless (2.1.209) | existing | **recovered** 2026-07-15 | none — shape only |
| interactive (2.1.209) | existing | **recovered** 2026-07-15 | none — shape only |

Pairs, oracles, and known values live in
`tests/fixtures/transcripts/manifest.json`. The three new streams are
deliberately NOT in the typed `tests/fixtures/manifest.json` — wiring
them into the loader is routed campaign work.

## FINDING 6: transcript shape — tokens exact, dollars absent, dedup mandatory

- Usage lives on `type: "assistant"` lines at `.message.usage`
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, …) with `.message.model` naming the
  model and a top-level **`version`** field naming the Claude Code
  release — the transcript self-identifies its writer (doctor gains a
  per-session version source beyond `claude --version`).
- **Multiple assistant lines share one `requestId` and repeat the SAME
  usage object** (headless 2.1.209 pair: 17 assistant lines, 7 distinct
  requestIds). A naive summer over-counts ~2.4×. The parse rule —
  dedup by `requestId`, take usage once, sum across requests — was
  validated by execution against the envelope oracle: **exact match**
  (805 output / 12 input / 166,807 cache-read across 6 requests).
- **No cost field exists anywhere in the transcript** (exhaustive key
  search; the only "cost" hits are MCP tool names). Dollars exist only
  invoker-side: `claude -p --output-format json` envelope
  `total_cost_usd` + per-model `modelUsage[].costUSD` — invisible to
  hooks, absent from transcripts. Operator ruling (2026-07-15): tokens
  are parsed exactly; `cost_usd` is computed from a pinned per-model
  price table, labeled derived, ABSENT for unpinned models; the price
  table joins the fragile-dependency register. The envelope oracles are
  the acceptance ground truth for that computation.
- Transcript line-type zoo (parser must skip unknown types silently):
  headless: assistant/user/system/attachment/last-prompt/queue-operation;
  interactive adds file-history-snapshot/file-history-delta/mode/
  permission-mode/ai-title.

## FINDING 7: vitest output rides two different payload paths

- A **passing** run lands in `PostToolUse.tool_response.stdout` — plain
  text, **no ANSI codes**, with clean summary lines
  (` Test Files  1 passed (1)` / `      Tests  2 passed (2)` /
  `   Duration  65ms (…)`).
- A **failing** run exits 1 and lands as **`PostToolUseFailure`, which
  carries NO `tool_response`** (re-confirming 2.1.208/209): the entire
  vitest output — summary lines AND failed test names — is embedded in
  the `error` string after `"Exit code 1\n\n"`. The parser therefore
  needs both input paths, and the failing path is doubly fragile
  (string-embedded, undocumented).

## FINDING 8: backgrounded-command outcome IS recoverable — via the TaskOutput join

Open risk "backgrounded final outcome unverified" (2026-07-13), answered
in the good direction on 2.1.211:

- The backgrounding `PostToolUse` carries `tool_response.backgroundTaskId`
  (observed value shape: `blczchubi`).
- When the session later polls, `PostToolUse(TaskOutput)` events carry
  `tool_input.task_id` (= that id) and `tool_response.task.{status,
  output, exitCode}` — the completed poll held
  `status: "completed", output: "PROBE_DONE\n", exitCode: 0`.
- **Ingest can resolve a backgrounded command's outcome by joining
  backgroundTaskId → later TaskOutput events in the same session.** No
  poll before session end (or a SIGKILL) → no join → outcome stays
  ABSENT, honestly. The tool is named `TaskOutput` on 2.1.211; the whole
  join is undocumented surface → register entry, fail to ABSENT.

## `claude --version` (doctor's source)

Output shape observed on this machine: `2.1.211 (Claude Code)` — one
line, semver first token, suffix in parentheses. Parse the first token;
anything else → version ABSENT.

## Tested range

Fixtures now span **2.1.208–2.1.211** (streams on .209 and .211;
smoke-test observations on .208). The spec's Compatibility stance range
is bumped accordingly.

---

# Recording pass PRD-0003 — findings (2026-07-17)

Recorded on **Claude Code 2.1.212**, macOS, driven from an assistant
session per the PRD-0002 nested-agent protocol variant (scoped
`--allowedTools`, `CLAUDE*` env unset, per-scenario `REC_STREAM`).
Recorder: the production nine-event `jq -c` O_APPEND set. Streams,
envelope oracles, and one transcript pair live in
`tests/fixtures/recpass-2.1.212/` — deliberately OUTSIDE both typed
manifests (wiring is routed campaign work, per the PRD-0002 precedent).
Trigger: doctor flagging 2.1.212 vs tested 2.1.208–2.1.211, plus a live
dogfood misclassification (finding 9).

## Stream status (new)

| scenario | stream | oracle |
|---|---|---|
| headless, default model | `headless-default.jsonl` (10 events) | envelope $0.476391 + transcript pair |
| headless, `--model haiku` | `headless-haiku.jsonl` | envelope (control cell) |
| background | `background.jsonl` (10 events) | envelope |
| vitest pass+fail | `vitest.jsonl` | envelope |

## FINDING 9: a third SessionStart mode exists — `source: "clear"` — and it breaks the kind signal's coverage

Observed live in the dogfood ledger (session `7cdc9d81`, this repo): an
**interactive** session started via `/clear` carries
`source: "clear"` and **no `model` key** on SessionStart — so the
finding-3 rule (`model` absent → headless) classifies it `headless`.
FABRICATED KIND, the degradation law violated by the classifier. This is
not (necessarily) 2.1.212 drift: `/clear` was never in the finding-3
2×2 — the interactive cell was recorded at fresh keyboard startup only.
Both .212 headless cells below are unchanged from .209, so the signal
itself did not move where it was tested:

| session (2.1.212) | `model` on SessionStart | `source` |
|---|---|---|
| headless, default model | absent | `startup` |
| headless, `--model haiku` | absent | `startup` |
| interactive via `/clear` (live spool) | **absent** | **`clear`** |
| interactive, fresh startup | **UNRECORDED — operator keyboard cell, outstanding** | — |

**Consequence:** until the keyboard cell closes and a ruling lands, the
kind facet mislabels every `/clear`-descended interactive session as
headless — which also pollutes the PRD-0003 KPI denominator (this
session's four bound checks rendered it a "delegated" session in the
live ledger). Candidate honest fix, pending the cell + ruling:
demote-only corroboration on `source != "startup"` (never classifies,
only refuses — the Amendment-2 pattern). The range stamp is NOT bumped
by this pass: everything below verified clean on .212, but kind's
discriminating cell is exactly the one still unrecorded.

## FINDING 10: the backgrounded-outcome flow changed on 2.1.212 — TaskOutput no longer guaranteed

The backgrounding `PostToolUse` still carries
`tool_response.backgroundTaskId` (observed `b6a00xufd`), and
`tool_input.run_in_background: true` is now visible on Pre/PostToolUse.
But in the observed .212 flow **no `PostToolUse(TaskOutput)` ever
fires**: the turn Stops, the harness re-invokes the session with a
synthetic `UserPromptSubmit` whose prompt embeds
`<task-notification><task-id>…` XML (the id matches
`backgroundTaskId`), and the model **Read**s the task's output file.
The R14 join therefore finds no TaskOutput → outcome ABSENT, honestly —
the designed degradation, now the common case on .212 flows.
The notification prompt is a *potential* future join source but it is
string-embedded XML in a prompt (doubly fragile, vitest-error class);
recorded as a register note, not adopted. TaskOutput may still fire when
a session polls explicitly — the join stays, ABSENT when unfed.

## FINDING 11: everything else in the fragile register holds on 2.1.212

- **Transcript/cost**: usage on `assistant` lines, `requestId` dedup
  reproduces the envelope **exactly** (8 in / 625 out / 103,721
  cache-read / 17,067 cache-creation across 4 requests; 9 assistant
  lines — dedup still mandatory, ~2.25× over-count without it).
  Transcript self-identifies `version: "2.1.212"`.
- **Vitest, both payload paths**: passing run in
  `tool_response.stdout`, plain text, no ANSI, stable summary lines;
  failing run in `PostToolUseFailure.error` after `"Exit code 1\n\n"`
  with failed test names and summary present, no ANSI, and no
  `tool_response` on the failure event.
- **Command outcome**: `error` embeds `Exit code N`; `duration_ms`
  present on PostToolUse/PostToolUseFailure; `prompt_id` on everything
  after prompt submit.
- **`claude --version`**: `2.1.212 (Claude Code)` — first-token parse
  holds.
- **Additive only** (captured verbatim, no consumer): Bash
  `tool_response` gains `isImage` and `noOutputExpected` keys.
- **Not re-verified this pass**: `agent_id`/`agent_type` (no subagent
  scenario recorded) and the crash variants (SIGTERM/SIGKILL) — .209/.211
  fixtures remain their evidence.

## Protocol note (self-inflicted, worth keeping)

vitest config discovery walks UP out of the scratch repo: a stray
`vitest.config.mjs` five directories above the scratch root failed both
runs on first recording with an UNRESOLVED_IMPORT rolldown error (and
THAT error path carried ANSI — unlike real vitest output). Scratch
recorder repos must pin a `vitest.config.mts` at their root. Re-recorded
clean.

## FINDING 9 — CLOSED (2026-07-17, operator keyboard cell)

The outstanding cell recorded (`recpass-2.1.212/interactive-startup.jsonl`,
6 events): fresh interactive startup on 2.1.212 carries
**`model: "claude-fable-5"`** with `source: "startup"`, and the clean
`/exit` re-emitted `reason: "prompt_input_exit"` (finding 4 holds). The
finding-3 signal therefore SURVIVES on 2.1.212 everywhere it was
defined; the hole is exactly the non-`startup` source modes.

**Rulings (operator, 2026-07-17):**

1. **Kind classifier — demote-only on non-startup sources.** `model`
   present → interactive (positive evidence, any source); `model`
   absent AND `source == "startup"` → headless (the verified cell);
   `model` absent AND any other source → kind **ABSENT** with a reason
   naming the unverified source mode. Never classify from n=1 —
   `"clear"` joins a fixture-verified interactive-source set only if a
   future pass proves it. Fix lane: daily-lane `aeh do`, before
   `aeh plan` PRD-0003.
2. **Tested range bumped 2.1.208–2.1.212** (spec stance + the
   `TESTED_CLAUDE_CODE_RANGE` constant + its deliberate-tripwire test
   pin, amended together — the gotcha #7 remedy, exercised as designed).

---

# Recording pass 2.1.215 — findings (2026-07-20)

Recorded on **Claude Code 2.1.215**, macOS, per the established
nested-agent protocol (scoped `--allowedTools`, `CLAUDE*` env unset,
per-scenario `REC_STREAM`, nine-event `jq -c` recorder,
`vitest.config.mts` pinned at the scratch root). Trigger: the live
drift banner — session `e5d1454c` recorded 2.1.215, outside tested
2.1.208–2.1.212. Versions .213/.214 were never observed on this
machine (the update jumped straight to .215). Streams and envelope
oracles live in `tests/fixtures/recpass-2.1.215/` — deliberately
OUTSIDE both typed manifests, per the standing precedent.

## Stream status

| scenario | stream | oracle |
|---|---|---|
| headless, default model | `headless-default.jsonl` (10 events) | envelope $0.454621 + transcript pair |
| headless, `--model haiku` | `headless-haiku.jsonl` (6 events) | envelope $0.0241008 (control cell) |
| background, explicit poll | `background.jsonl` (12 events) | envelope $0.503359 |
| vitest pass+fail | `vitest.jsonl` (8 events) | envelope $0.422169 |

## FINDING 12: the fragile register holds on 2.1.215 — every scripted cell clean

- **Kind cells**: both headless streams carry NO `model` and
  `source: "startup"` — plus four live dogfood worker sessions on .215
  (`e5d1454c`, `642aad37`, `3b861cb6`, `f73f837d`) with the identical
  shape straight from the production spool: n=6 for the headless cell.
  The ISS-0025 demote-only classifier needs no change.
- **Transcript/cost**: usage on `assistant` lines; `requestId` dedup
  reproduces the envelope **exactly** (8 in / 639 out / 101,231
  cache-read / 16,068 cache-creation across 4 requests; 6 assistant
  lines — dedup still mandatory, 1.5× over-count without). Transcript
  self-identifies `version: "2.1.215"`. Still no cost key anywhere in
  the transcript.
- **Vitest, both payload paths**: passing run in
  `tool_response.stdout` — plain text, no ANSI, stable summary lines;
  failing run as `PostToolUseFailure` with NO `tool_response`, full
  output (summary + failed test names) embedded after
  `"Exit code 1\n\n"`, no ANSI.
- **Command outcome**: `error` embeds `Exit code N`; `duration_ms` and
  `prompt_id` present on Post events.
- **`claude --version`** → `2.1.215 (Claude Code)`: first-token parse
  holds.
- **Bash `tool_response` key set unchanged from .212**
  (`backgroundTaskId, interrupted, isImage, noOutputExpected, stderr,
  stdout` — nothing new in these streams).
- Envelope-side additive only (invoker-visible, no consumer):
  `usage.cache_creation.{ephemeral_1h,ephemeral_5m}_input_tokens`,
  `iterations`, `inference_geo`, `speed`.

## FINDING 13: TaskOutput fires on explicit poll on 2.1.215 — and the in-flight-poll case is now on record

Finding 10 (.212) observed the notification-prompt flow where NO
`TaskOutput` ever fires. On .215, a session told to poll explicitly
DOES emit `PostToolUse(TaskOutput)` with the full join shape:
`tool_input.task_id` = the backgrounding event's `backgroundTaskId`
(`bhl28jtd6`), `tool_response.task.{status, output, exitCode}` =
`completed` / `PROBE_DONE\n` / `0`. The R14 join resolves when fed —
finding 10's stance is unchanged (unfed joins stay ABSENT, honestly).

New on record: the stream carries an **in-flight poll**
(`status: "running"`, `exitCode` null) BEFORE the completed one —
the first recorded instance of the case
`deriveBackgroundedOutcome`'s skip rule was written for (previously
code-comment-only). `background.jsonl` is a regression-fixture
candidate for that skip path. Protocol note: the .215 session loaded
`TaskOutput` via a `ToolSearch` tool call before polling —
ToolSearch Pre/PostToolUse events now appear in streams; captured
verbatim, no consumer.

## Outstanding cells + range stance

- **Interactive fresh keyboard startup on .215: UNRECORDED** — the
  kind register's interactive discriminating cell. Note: the operator
  session driving this pass still runs the .212 binary (its transcript
  self-identifies 2.1.212; `claude -p` children resolve .215), so no
  live .215 interactive evidence exists yet. The range bump WAITS on
  this cell, per the finding-9 precedent.
- **`/clear` on .215: unrecorded, no bump dependency** — the
  demote-only ruling degrades any non-startup source to ABSENT
  regardless of version.
- **Crash variants + subagent tagging: not re-verified** — .209/.211
  fixtures remain their evidence, per the .212 precedent.
- Tested range stays **2.1.208–2.1.212** until the keyboard cell
  closes; then bump the spec stance + `TESTED_CLAUDE_CODE_RANGE` +
  its tripwire test pin together (the gotcha #7 remedy).
