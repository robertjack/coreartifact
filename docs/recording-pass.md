# Recording pass — findings (operator lane)

## Manifest and loader (implementer lane, ISS-0002)

The committed streams are indexed by `tests/fixtures/manifest.json` (scenario
name → file, recorded Claude Code version, ordered hook event names). Load a
stream by scenario name via `tests/fixtures/loader.ts`
(`loadFixtureStream('headless')` etc.) — later tests should use the loader,
never a raw path. `interactive` is present in the manifest with
`status: "pending"` and no version/file claimed: the operator has not yet run
the interactive keyboard session (see "Stream status" below). Once
`tests/fixtures/interactive.jsonl` is recorded and committed, fill in that
entry's `file`, `claudeCodeVersion` and `hookEvents` — no other code changes
are needed for the manifest/loader/unit-test contract.

The hand-authored corrupt-line fixture lives at `tests/fixtures/corrupt.jsonl`
(valid SessionStart line, one deliberately invalid JSON line, valid Stop
line) — the only fixture permitted to be hand-authored rather than recorded.


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
| interactive | `interactive.jsonl` | **pending — operator keyboard session** |

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

## The kind question (open risk 2) — pending the interactive stream

Headless `SessionStart` carries exactly:
`cwd, hook_event_name, session_id, source, transcript_path` with
`source: "startup"`. Whether interactive sessions differ (in `source` or
any other field) is decided by diffing the interactive stream when
recorded. If no field discriminates, `kind` records ABSENT permanently
this campaign — never inferred heuristically.

Note: `permission_mode` appears on tool events (recorded value here:
`bypassPermissions`, an artifact of the recording setup, not a headless
signal — interactive sessions can run any permission mode).

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
