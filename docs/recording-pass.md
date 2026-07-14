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
