---
name: recorded-fixture-cwd-collides-with-live-sandbox-repo
description: A hand-authored fixture trimmed from a recpass-2.1.212/*.jsonl donor keeps the donor's real recorded `cwd` — if that scratch path still exists in THIS sandbox as a live git repo, capture.mjs resolves repoRoot to it instead of the test's tmp repo, and the spool silently never appears where the test expects it (all hook exit codes still 0 — capture's never-break-the-host contract swallows it).
metadata:
  type: feedback
---

ISS-0025: an acceptance test's third criterion kept failing with "no
rendered log line found" / "0 sessions ingested" even though every
replayed hook invocation exited 0. Root cause: the hand-authored fixture
(`tests/fixtures/clear-source.jsonl`, trimmed from
`tests/fixtures/recpass-2.1.212/headless-default.jsonl` per the issue's
own "Prior art" instructions) preserved the donor's real `cwd` field
verbatim. That `cwd` pointed at a `/private/tmp/claude-501/...scratchpad/...`
path that happened to be **this exact agent session's own scratchpad
directory**, which is a live git repo right now. `resolveRepoRoot`
(src/hook/capture.ts) ran `git rev-parse` there, got a real answer, and
silently wrote the spool into that real repo's `.coreartifact/` instead
of the test's own tmp repo — never erroring, never printing anything
(capture's "always exit 0, never break the host" contract hides this
completely).

**Why:** recording-pass fixtures carry real absolute paths from whatever
machine/session recorded them. Sandbox scratchpad directories can be
long-lived and reused across sessions in this environment, so a stale
path is not guaranteed stale.

**How to apply:** when hand-authoring a fixture by trimming a
`recpass-*` donor file (the corrupt-line.jsonl / clear-source.jsonl
pattern), always rewrite every line's `cwd` to a clearly-fake,
guaranteed-nonexistent path (e.g. `/nonexistent/<fixture-name>/repo`)
rather than keeping the donor's real recorded cwd. If ingest silently
sees "0 sessions" after a replay whose hook invocations all exited 0,
check whether the fixture's `cwd` resolves to a real git repo on the
current machine before suspecting the classification/ingest logic itself.

Related: also hit a full-worktree reset mid-session (uncommitted src
edits AND an untracked fixture file both vanished back to HEAD with no
git command of mine causing it) — commit early and often in small WIP
checkpoints when resuming a killed run in an existing worktree, then
squash before the final commit.
