---
name: aeh-retro
description: Post-campaign curation session — distill the ledger and retro into conventions, skills, ADRs, and fixtures under the caps, by hand until the curator role exists.
argument-hint: "PRD id to retro (e.g. PRD-0007)"
disable-model-invocation: true
---

# aeh-retro

The compounding pump, operated by hand. Until the memory-curator role exists (INC 4), nothing distills a shipped campaign into the stores that make the next one smarter — this session is that pump, and when the curator arrives it becomes the interactive mode of the same mandate.

## 1. Read the raw layers

For the shipped PRD: the findings and their fates (`aeh why`, `.aeh/aeh.db`, `reviews/`), escalations and scope changes, `footprint_miss` and `packet_overflow` events, dossiers (dead ends and hypotheses), role memory notes, `retro.md` if drafted, and the final diff summary. You are hunting **repetition and surprise** — one-off events are noise; patterns and things nobody predicted are signal.

## 2. Distill upward, one question per finding

For each pattern, place it at the cheapest altitude that changes future behavior:

- **Could a script check this?** → a hook or lint rule, and if a CLAUDE.md convention already covers it, *delete the prose* — law costs no context and never drifts.
- **Is it a one-line imperative?** → CLAUDE.md, under the hard cap: cut the least load-bearing line for every line added. Recurring S3 review nits (3+) land here so they stop occurring at the source.
- **Is it a multi-step procedure?** → a skill, via `/aeh-skill` (which gates on repetition — this session supplies the evidence).
- **Is it a settled decision future planning shouldn't relitigate?** → an ADR, only if hard-to-reverse ∧ surprising-without-context ∧ real-trade-off.
- **Is it a role-scoped gotcha?** → that role's agent memory (MEMORY.md loads only its first 200 lines / 25KB — keep it an index; delete wrong notes; promote repo-wide truths up an altitude).
- **Did the world change?** → `PROJECT.md` (identity), `docs/map.md` (geography), `CONTEXT.md` (language) — pointer-sized updates.
- **True of the craft, not the product?** → a PR against the golden template or harness repo; nothing crosses the project boundary except by PR.

## 3. Nominate fixtures, flip signals

Pick one or two merged issues whose path the eval corpus lacks (a migration, a UI issue, a known-tricky integration) and record them as fixtures. Flip the signals this PRD served to `shipped`, and surface any signal author who asked to be told.

## 4. Close

Write or finish `docs/prd/<PRD>/retro.md`: what stalled, what each reviewer source uniquely caught, footprint prediction accuracy, cost by phase, and **one process change worth making** — one, not a list.

Done when: every recurring pattern from step 1 has landed at exactly one altitude or been deliberately dropped; every store touched is at or under its cap (deletions counted, not just additions); fixtures are nominated; signals are flipped; and the retro names its one process change.
