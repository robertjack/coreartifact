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
