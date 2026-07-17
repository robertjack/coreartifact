---
name: iss0028-overview-rescue
description: ISS-0028 GET /api/overview escalation rescue (dd660f3) review — pinLineToRepo is a clean test-only fix; the machine-leftover class is live and latent in the verbatim-replay scenarios
metadata:
  type: project
---

# ISS-0028 /api/overview — rescue review (dd660f3, executed 2026-07-17)

Rescue = ONE test-only commit, spend-tile scenario only (`git diff dd660f3^..dd660f3`
touches nothing but tests/acceptance/ISS-0028/overview.test.ts). `pinLineToRepo`
sets `obj.cwd = repo.root` on both sessions and `obj.transcript_path` only when
passed. Verdict: **mergeable, clean**.

- Mutation-proven both directions (mutate src, globalSetup rebuilds dist, run spend
  scenario, restore via `git checkout`): `spendPresentUsd += 0` → RED at the REAL
  oracle 0.555957 (not the escalation's leftover 0.0558); `costAbsentCount += 0` →
  RED (expected 1, got 0). The "never a zero contribution to the sum" clause is
  enforced *through cost_absent_count*, NOT the sum value — a 0 addend is invisible
  in a float sum, so absent-as-present-$0 is only catchable via the count. Pre-existing
  criterion-phrasing subtlety, still mutation-caught. Not a rescue weakening.
- Pin fidelity (executed): only `cwd`+`transcript_path` change; all other payload
  keys verbatim. Present session pins cwd only (transcript stays the substituted
  tmpdir copy → cost present); absent session pins transcript_path to
  join(repo.root,"no-such-transcript.jsonl") which cannot exist in the fresh tmpdir.

## The machine-leftover class (root cause; LIVE on this machine)
Shipped fixture streams (tests/fixtures/{headless,cost-headless,interactive,
clear-source}.jsonl) carry ABSOLUTE cwd + transcript_path from the recording
machine, e.g. transcript_path under `/Users/robbiejack/.claude/projects/...`.
Executed check 2026-07-17: **all four referenced transcripts still EXIST on disk.**
Verbatim replay therefore enriches cost/cc_version from a real leftover and can
attribute via cwd (resolveAttribution succeeds if the leftover dir is a git repo).
HOME-hermeticity does NOT cover this — `enrichFromTranscript` reads the payload's
absolute transcript_path directly, bypassing the tmpdir HOME override.

## Item-5 latent-but-passing scenarios (non-blocking; on record for ship-gate)
Scenarios that replay these fixtures with ONLY session_id overridden (cwd +
transcript_path verbatim), yet stay green because their assertions read only
leftover-immune fields:
- kind is stream-derived (sessionAggregate.ts:15 — SessionStart `model` key present
  ⇒ interactive, absent ⇒ headless), NEVER from the transcript;
- classification/failing_checks are check-exit-code-derived; counts/window are ts-derived.
So contamination lands only in UNASSERTED fields (sessions.latest[].cost,
.repo_root, possible spurious drift). Scenarios: 1 KPI (overview.test.ts:269),
3 sessions_by_kind/failing_checks (:395), 6 ?repo scoping (:558), 7 unreadable
repo (:600). Bites the instant any grows a cost/attribution/drift assertion.
Durable fix direction: pin cwd/transcript_path in the shared fixture-replay helper
(overrideSessionId / replayLines), not per-scenario.
