# PRD-0001 retro — walking skeleton (shipped 2026-07-15)

12 issues merged in 47 commits, ~7.9k lines of TypeScript across src +
tests. Spent **$149.04 of the $150 budget** (99.4%) — the budget was set
right, with zero headroom to spare. By role: implementer $66.80
(28 attempts), code-reviewer $48.89 (22), test-author $33.35 (21). By
issue: ISS-0001 alone cost $27.73 (18.6%); the cheapest full slice
(ISS-0012) cost $6.89.

## What stalled

- **ISS-0001, the contract mega-issue.** Envelope + ledger + registry +
  attribution + status + CLI skeleton in one issue drew nine reviewer S1s
  in round one, escalated twice, and was split at round three into
  ISS-0010 (registry/ledger) and ISS-0011 (attribution) — after ~$22 of
  the $27.73 was already burned. The compile sketch bundled the whole
  contracts tier into one slice; every subsequent single-contract issue
  landed in ≤2 review rounds. Contracts want one issue each.
- **ISS-0002 blocked the entire DAG on the operator's keyboard.** The
  interactive fixture stream can only be recorded by a human session; when
  dispatch reached it, the escalation cascaded `blocked` to all seven
  remaining issues. Operator-lane prerequisites should be satisfied (or
  scheduled) before the run starts, not discovered at dispatch time.
- **ISS-0008's first test-author attempt** ran 49 minutes to a timeout and
  returned empty structured output — a full round lost to nothing.
- **ISS-0009 took three test-author rounds** to converge on one delta
  criterion; two of its original three criteria were invariants already
  green at base (see the test_author_defect pattern below).

## What each reviewer source uniquely caught

Every green suite hid at least one real defect — the standing rule held
for all twelve issues. But the four sources caught disjoint classes:

- **Per-issue code review (opus)** caught what execution against the spec
  catches: the S0 silent no-op entrypoint guard, two data-loss ordering
  bugs, the registry TOCTOU, and — repeatedly — tests that could not fail
  (decoy-passing manifest discovery, serial "concurrency" tests,
  toBeTruthy stamps). Nothing else would have found these.
- **The integration reviewer (once, whole branch)** caught only
  cross-issue contract drift — log printing an 8-char short id that show
  could not resolve, log being global while show read only cwd's ledger,
  in-flight PreToolUse commands invisible in show. All three were
  invisible per-issue by construction; this pass paid for itself (spawned
  ISS-0012 + two direct fixes).
- **red-verify (script)** caught mapped-but-green criteria mechanically,
  five times. It is the only source that runs before money is spent on
  implementation.
- **The recording pass (operator + live platform)** caught the two facts
  no code reader could: WorktreeCreate is a delegation hook (subscribing
  breaks every worktree agent spawn) and the `model`-key kind signal. Both
  amended the PRD before they could become bugs.

## Footprint prediction accuracy

Good where it governs code: **zero source-footprint violations across all
12 issues** — no implementer touched spec'd-out files. All 25 write-guard
denials were meta-writes: nine attempts to bank memory notes (below),
scratch scripts, an .npmrc. The one gate misfire: ISS-0003's
acceptance_lock denied the harness issue writes to `tests/acceptance/**` —
the very directory that issue existed to create — forcing an
amendment-by-escalation for work that was in spec.

## Where the findings went (distillation record)

- Falsifiability + delta-criteria lessons → new **test-author agent
  memory** (the role logged five defects and had no store at all).
- Sandbox no-network / transitive @types/node (re-learned in ≥4 issues,
  denied banking 9 times) → **implementer agent memory**.
- Deleted one **wrong** implementer note: import.meta.main was falsified
  on the engines floor by ISS-0004 (gotchas.md #1 supersedes it).
- Repo geography → new **docs/map.md** (pointer-sized). CLAUDE.md "Now"
  updated; net lines removed, not added.
- Entry-point guards, newline ordering, env allowlist, can't-fail tests,
  degradation law, verify-on-the-floor → already landed in
  **docs/gotchas.md** during the campaign; confirmed, nothing moved.
- No new ADR: the settled decisions (append-only registry, nine-event
  subscription, allowlist scrub) are already recorded in schema.md,
  CONTEXT.md, the spec amendment, and gotchas — an ADR would duplicate.
- Fixtures: **ISS-0011** (git-identity matrix) and **ISS-0008** (render +
  test-author failure path) marked representative in the eval corpus.
- Signals: the table is empty — this PRD served no filed signals; nothing
  to flip, no authors to notify.

## The one process change

**Give roles a sanctioned memory lane in the aeh write guard.** Allowlist
`.claude/agent-memory/<own role>/**` for each dispatched role (or queue
denied memory writes into a retro inbox). Nine times this campaign an
implementer learned something real mid-issue — the no-network sandbox, the
types shim trap, git worktree quirks — tried to save it, and was denied;
the same @types/node gotcha was then re-learned from scratch in at least
four issues, and this retro had to reconstruct the knowledge from deny-log
titles. The guard exists to protect the footprint; role memory is not
footprint. This is an aeh (harness) change — it crosses the project
boundary by PR, before PRD-0002 dispatches.
