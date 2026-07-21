# Your agent says the tests passed. Prove it.

> DRAFT for operator edit — facts verified against the repo history and
> the live ledger 2026-07-20; voice is a starting point, not a final.

I shipped coreartifact today: a local-first evidence ledger for
agent-built software. It records what your Claude Code sessions actually
did — commands, files, test results, checks, cost — into an append-only
spool on your machine, and renders the only headline that matters for
delegated work: which sessions are **verified** (bound passing checks),
which are **failing**, and which are merely **unverified claims**.

It was built in nine days, almost entirely by agents, for $378.06 of
metered agent spend — and this repository's entire unredacted history is
the receipt. Every commit, every issue packet, every escalation
amendment, every retro, every budget line. Not a curated highlight reel:
the actual history, including the parts where things went wrong. This
write-up is a walking tour.

## The problem

If you delegate real work to coding agents, you already know the
feeling: the agent reports green, and you believe it — because checking
would cost the time delegation was supposed to save. The failure mode
isn't that agents lie, exactly. It's that a summary is not evidence.
"Tests passed" in a transcript is a claim. An exit code captured at
execution time, bound to the session that produced it, is a fact.

coreartifact's answer is deliberately small: a capture hook that appends
every session event verbatim to a local spool, a ledger projected from
that spool, and one verb — `cart check <name> -- <cmd>` — that runs your
command unchanged, records its output and exit code as evidence, and
binds it to the session that ran it. Delegation stays cheap. Verification
becomes a query.

## The laws

Four rules are load-bearing, and the history shows them being enforced
against convenience over and over:

- **Nothing leaves your machine.** No code, no transcripts, no telemetry
  by default. The one exception is an opt-in weekly ping carrying a
  version and a random install id — and it exists solely to measure
  whether anyone uses this thing (the "expand gate": no team features
  until ≥50 weekly-active installs ask for them with their behavior).
- **The spool is ground truth forever.** Delete the ledger, re-ingest,
  get the same answers. Ingestion is re-runnable from raw capture.
- **Absence is honest.** A fact that can't be verified from captured
  evidence records as ABSENT with a reason — never guessed, never
  silently zero.
- **Capture never breaks the host.** The hook appends verbatim, exits 0,
  and knows nothing about schemas. Claude Code releases can't break it,
  because there is nothing to break.

## Built by the thing it measures

Here's the part I actually want you to check: coreartifact was built by
an agent harness driving Claude Code workers through three campaigns —
and the repo has been dogfooding itself since mid-build, so the
product's own ledger holds the receipts for its own construction.

The numbers, all verifiable in `docs/prd/*/retro.md`:

- **PRD-0001 (walking skeleton):** 12 issues, $149.04 of a $150 budget.
- **PRD-0002 (evidence depth):** 12 issues, $134.71 of $200.
- **PRD-0003 (dashboard):** 7 issues, $94.31 of $200.

Thirty-three issues total. Workers wrote the failing acceptance tests
first, implemented to green, and were adversarially reviewed before
every merge. The retros tally what that discipline caught, and the
pattern is the single most useful thing I learned building this:

**Every escalation that reached me was a test-side or environment
fault. Zero were implementation faults. And every green suite was
hiding at least one real defect that only adversarial review found.**
Reviewers proved their findings by execution — mutation proofs, not
opinions — and the findings tables in the issue packets record each one
with its disposition. If you take one thing from this history, take
that: green is a claim too.

The honest-absence law got enforced against me during the build, which
is how I know it's real. The live ledger's cost column reads ABSENT for
most of the worker sessions that built the dashboard — because those
workers ran on a model the pinned price table didn't cover yet, and the
product refuses to guess. My own dashboard showed me an honest "0 of 35
verified" headline for an entire campaign, because the workers ran their
gates raw instead of through `cart check`. The fix wasn't to soften the
headline; it was to make the harness bind its gates. The number was
embarrassing and correct, in that order.

## Observed truth over documented claims

Claude Code's hook payloads are undocumented surface, so the project
keeps a dated register of observed facts (`docs/recording-pass.md`) and
refuses to assert platform behavior from memory. Five recording passes
across six Claude Code versions caught, among other things: a hook
subscription that silently changes host behavior rather than observing
it; a session-kind signal that looked obvious and was wrong until a
controlled 2×2 disambiguated it; and a `/clear` session shape that the
classifier initially mislabeled — fixed by a demote-only rule that
prefers ABSENT over a guess.

The mechanism still works in launch week — twice. Claude Code shipped
2.1.215 and then 2.1.216 on consecutive days; each time the dashboard
raised a drift banner naming the first session outside the tested range,
and each time a recording pass re-verified every fragile signal before
the range moved (the .216 interactive cell closed from live dogfood
sessions — observed truth, not a lab rig). The bump amendments tripped
the deliberate test pins on the way, exactly as designed
(`docs/gotchas.md`, #7).

One more receipt from the final day: a pre-launch audit — run against
the installed tarball, not the repo — found that a resumed session
violates the rebuild law in one facet (`source: "resume"` emits a
second SessionStart the fold didn't anticipate). The bug was fixed,
regression-pinned, and the live ledger deleted and re-ingested
identically before anything shipped. The audit is in the history like
everything else.

## What to read if you're skeptical

Skepticism is the intended response. Start here:

- `docs/spec-v1.md` — the binding spec, including the non-goals wall
  and the decisions log with dates.
- `docs/prd/PRD-0002-evidence-depth/retro.md` and
  `docs/prd/PRD-0003-dashboard/retro.md` — escalation taxonomies,
  what review caught that tests missed, what each campaign cost.
- `docs/gotchas.md` — eight classes of bug this codebase paid to learn,
  written so the next agent doesn't pay twice.
- `docs/issues/ISS-0033.md` — a complete escalation record: an issue
  the harness could not implement by construction, the rulings that
  rescued it, and the findings with mutation proofs.
- The commit log itself. It was written knowing it would publish.

## What it is not

No teams, no sync, no hosted anything, no CI enforcement, no multi-agent
orchestration — the non-goals are walled in the spec, and each wall
re-opens only on a named condition, not on enthusiasm. It supports
Claude Code on a tested version range (currently 2.1.208–2.1.216),
degrades honestly outside it, and runs wherever Node ≥ 22.13 runs.

## Try it

```sh
npm install -g coreartifact
cd your-repo
coreartifact init   # asks the ping question once; no is a fine answer
# ...delegate something...
cart log            # what actually happened
cart open           # the verified / failing / unverified headline
```

Pre-1.0, no support promises, issues welcome. The harness that built it
is a separate project and will publish on its own timeline — this repo's
history shows you exactly what it does either way.
