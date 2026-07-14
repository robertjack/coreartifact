---
name: aeh-qa
description: Turn conversational bug reports into aeh fix issues shaped as failing tests — given/when/then extracted, cross-checked against the evidence packs and findings ledger.
argument-hint: "describe the bug, or paste the report"
disable-model-invocation: true
---

# aeh-qa

A fix issue is well-formed when the test-author can turn it red without asking anyone anything. So this session does not collect bug *descriptions* — it extracts **failing tests in prose**. For each report, keep the conversation going until all three slots fill:

- **Given** — the state the system was in (data, auth, config, fixtures)
- **When** — the numbered steps taken
- **Then** — the assertable difference between expected and observed

An unfilled slot is your next clarifying question — and the *only* kind of clarifying question this session asks. If the operator can't fill it either, the report files flagged `needs-repro` rather than pretending.

While the operator talks, run a background Explore over the area — not for a fix, but for the domain language and the intended behavior boundary. Behaviors, never code: "the sync service fails to apply the patch", not a function name and a line number. Footprint is the planner's job at intake, not yours.

## Cross-check the system's own records

Before filing, two lookups only aeh makes possible:

- **Evidence packs** — search `docs/prd/*/evidence/` for the flow in question (best-effort: nothing writes this directory yet — browser-qa/verifier records are unbuilt; until then the acceptance tests under `tests/acceptance/<ISS>/` are the evidence). If the evidence shows it passing at merge time, this is a *regression since merge*; if the flow was never in the evidence, it's an *acceptance-coverage gap*. Say which in the issue — they route differently (regression → bisect-shaped; gap → the test-author writes net-new coverage).
- **Findings ledger** — check the findings for a deferred S2 or discarded finding matching this behavior (`aeh why`, the reviews/ files, or `.aeh/aeh.db`). A match means the review pipeline saw this coming and the rubric filed or discarded it: record a `discard_resurfaced` event (via the CLI when it exists, otherwise note it in the issue).

## Verify before filing

If the reproduction is runnable from where you sit — a command, a test, a local flow — run it. Confirmed: say so; downstream red-verification is now guaranteed. Not runnable or unconfirmed: file anyway, flagged unverified — a warning to the test-author, not a blocker.

## File

One issue per independent behavior; symptoms sharing a root behavior stay together; thin beats thick; blockers filed first so blocked-by references are real. File real aeh spec files into the flat `docs/issues/` (where `aeh run`/`aeh resume`/`aeh do` resolve specs — never a per-PRD subdir). The format is TOML frontmatter between `+++` lines — `parseIssueSpec` rejects YAML `---`, and `verify` is required (copy the profile's real `pnpm run <key>` commands):

```
+++
id = "<planner assigns if absent>"
kind = "fix"
risk = "med"     # blast radius of the BUG — data corruption is never low because the fix looks small
complexity = "s"
depends_on = []  # blockers only, honestly
db = false
ui = false       # true if the repro is a browser flow
verify = ["pnpm run typecheck", "pnpm run test"]
acceptance = [
  "<the Then, phrased as the check — plain prose, no markdown decoration>",
]

[files]
owns = []        # planner fills at intake
touches = []
+++
## Given / ## When / ## Then
## Context   <!-- regression-vs-gap verdict, verification status, discard_resurfaced note, domain observations -->
```

File without asking for review; summarize what was filed with blocking relationships, then: "next, or done?"

Done when: the operator says done, every filed issue carries a verified reproduction or an explicit unverified/`needs-repro` flag, and every report was cross-checked against evidence and findings — no issue relies on the test-author guessing, and no resurfaced discard goes unrecorded.
