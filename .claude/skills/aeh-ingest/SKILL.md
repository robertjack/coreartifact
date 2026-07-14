---
name: aeh-ingest
description: Normalize real-world input — user quotes, PM notes, analytics, errors — into provenance-stamped signals; route bugs to /aeh-qa, everything else into the corpus and ideation backlog.
argument-hint: "paste or describe the feedback and its source"
disable-model-invocation: true
---

# aeh-ingest

Whatever arrives — a pasted user email, a Slack thread from a PM, an analytics observation, a screenshot of an app-store review — leaves this session as **signals, not opinions**: the verbatim is the record, the interpretation is a separate line, and every signal carries provenance a future planning session can trust.

## For each item the operator brings

**1. Capture the verbatim.** The exact quote, number, or error — never a paraphrase. If the operator paraphrases, ask once for the original; if it's gone, mark the signal `paraphrased`. Provenance on every signal: source (who/where), date, and how it reached you. **Redact identity by default**: names become roles ("a freelancer customer"), emails and handles become initials — the verbatim survives, the person is anonymized. For a public repo, keep the corpus untracked by adding `docs/feedback/` to `.gitignore` by hand — the once-planned `feedback.private` config key is not read by the loader (unbuilt; graduate this sentence when it is).

**2. Classify** — one of four kinds, and the kind decides the route:

- **bug** — something is broken. Route into a `/aeh-qa` extraction on the spot (given/when/then or `needs-repro`); the signal records the resulting fix-issue id.
- **friction** — works as designed, hurts to use. Corpus.
- **request** — asked-for capability. Corpus.
- **insight** — a usage pattern, metric movement, or strategic read. Corpus.

**3. Tag the product area** in the project's domain language (`CONTEXT.md` vocabulary — never internal module names), so signals cluster by what users experience, not by code layout.

**4. File.** Append to `docs/feedback/` as provenance-stamped markdown (one file per source-batch or per signal, whichever reads better) — source, kind, area, status `new`. Index via `aeh signal` when the CLI exists; before then, the markdown's frontmatter line IS the index (the `signals` table is derived and rebuilt when the CLI lands — never insert into the db directly; the orchestrator is its only writer).

```markdown
## SIG-0042 · request · billing · 2026-07-03
> "I just want to download all my invoices as one PDF at tax time."
— customer email, jane@…, forwarded by support

Interpretation: bulk-export, yearly cadence, tax-driven. Third
export-shaped request in the billing area (see SIG-0017, SIG-0031).
```

## Theme, don't just pile

When a new signal resembles existing ones, say so and link them — **themes emerge from counts across signals, never from one loud voice**. When a theme's count or severity crosses interesting, promote it: add or strengthen a candidate PRD in `docs/ideas.md`, listing every supporting signal id and a rough shape (one paragraph, not a spec — `/aeh-prd` does the specifying, grounded in these very signals). Flip the constituent signals to `themed`.

## Close loops when told

If the operator mentions something shipped, flip the serving signals to `shipped` and surface any signal author who asked to be told.

Done when: every item brought to the session is a filed signal with verbatim + provenance + kind + area; every bug-shaped item has a fix issue or a `needs-repro` flag; every resemblance to existing signals is linked; and nothing was recorded as fact that was actually interpretation.
