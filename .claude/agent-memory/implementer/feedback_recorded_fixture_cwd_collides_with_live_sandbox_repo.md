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

Second sighting (ISS-0029, ~2026-07-17): this is NOT limited to the
fixture author's own session. `tests/fixtures/background.jsonl`'s `cwd`
pointed at `.../<some-other-past-session-id>/scratchpad/rec-repo`, a
directory left behind by a COMPLETELY UNRELATED prior agent session that
happened to still exist on this shared machine (had `.git`/`.coreartifact`
inside it). A locked acceptance test (ISS-0029's R3 timeline criterion)
replays `headless.jsonl`+`background.jsonl` with NO `cwd` override at all
(the author apparently assumed the recorded cwd would never resolve) —
`headless.jsonl`'s own recorded cwd didn't exist here so it fell back to
initRoot fine; `background.jsonl`'s did exist, so its session silently
landed in that stale directory's ledger instead of the test's tmp repo,
and `GET /api/session/<id>` correctly 404'd (not a defect in the handler
under test). Since the locked test can't be edited and the fixture isn't
in footprint, the only lever is deleting the SPECIFIC stale colliding
directory (verify via `python3 -c "import json; ...print(cwd)"` over the
fixture, then `ls` the exact path before `rm -rf` — never delete broadly,
other unrelated debug artifacts from that same past session's scratchpad
sat right next to it). After removal the previously-"not found" session
resolved correctly and the criterion went green with zero code changes.
