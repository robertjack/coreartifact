---
name: aeh-prd
description: Author an aeh PRD by grilling backwards from verification — every requirement leaves with a machine-checkable criterion and a known decomposition shape.
argument-hint: "the idea to spec, or an ideas.md entry / map to graduate"
disable-model-invocation: true
---

# aeh-prd

You are writing **compiler input**. The reader of this PRD is not a human — it is the aeh decomposer, which compiles it into issue specs, risk tags, and file footprints. Every ambiguity left in costs an escalation at 1am instead of a sentence now.

There is no `aeh prd new` verb (spec'd, never built — build-plan deferred). Allocate by hand: the next `PRD-NNNN` across `docs/prd/` and the db's `prds` table, then create `docs/prd/PRD-NNNN-<slug>/prd.md` with a `budget_usd: <n>` line near the top — `aeh plan <path-to-prd.md>` derives the PRD id from the directory name, creates the `prds` row, and parses that line as the campaign budget.

## Ground in what the system already knows

Before the first question, read what exists: `PROJECT.md` (does this idea serve the mission?), `docs/map.md`, `CONTEXT.md`, ADRs in the area, the stack profile in `.aeh/config.toml`, and past retros (`docs/prd/*/retro.md`) touching this area. A retro that says "footprint misses clustered in the billing module" or "browser flows stalled on seeded data" is a question you ask *now*, pre-answered by history. If a map exists for this scope (`docs/maps/<slug>.md` from `/aeh-map`), its Decisions-so-far are pre-answered grilling — start from them, don't re-litigate them. Throughout the session: when the codebase can answer a question, read the codebase instead of asking.

## Grill backwards from verification

Interview one question at a time, your recommended answer attached to each, **ordered by decision dependency — never ask a question whose premise is still undecided** (the permission model comes before the scope that assumes it). **Synthesis mode:** when the operator arrives with the design conversation already had (a rich session, answered decision rounds, a map), do not re-interview what is already decided — jump to the compile check and synthesis, and grill only the genuine gaps. The question generator is not the design tree — it is the check. For every requirement the operator states, the next question is **"how would a machine verify this?"**

- An answer names a command, an assertion, or a browser flow → that phrasing *is* the acceptance criterion — and it must be checkable by tools the stack profile actually has ("returns 403 for non-owner" as a vitest assertion; a browser criterion phrased as a flow browser-qa can drive with seeded data).
- Every criterion must be a **delta**: a faithful test for it fails against today's tree. If it asserts what already holds — a preserved default, an untouched code path, behavior that is "still" true — it is an invariant: record it as Contract prose for the reviewer and grill for the delta hiding behind it. red-verify refuses an un-red-able criterion downstream, at the cost of a wasted test-author round.
- No answer → the requirement is not real yet. Grill until it splits into checkable pieces or moves to Out of scope.

The remaining lenses come from how aeh campaigns actually fail:

- **Scope creep the write-guard can't catch** → grill Non-goals until non-empty: name what looks in-scope but isn't.
- **Contract drift** → anything touching persistent data or a new interface gets flagged now, because schema.md co-authoring and the prototype freeze run *before* decompose — miss the flag here and those passes silently don't happen.
- **Vocabulary drift** → sharpen fuzzy terms to one canonical term as they appear; update `CONTEXT.md` inline, created lazily. ADR only when hard-to-reverse ∧ surprising-without-context ∧ real-trade-off.
- **Test topology** → before synthesis, sketch the seams the feature will be TESTED at, as a set: prefer existing seams, use the highest seam possible, and treat every additional seam as a cost (the ideal number is one). Confirm the sketch with the operator. A defect living above the tested seam is invisible to the whole campaign — PRD-0002's two real bugs (a redirect, a missing revalidation) sat above seam-mocked component tests and were only caught by the operator-run tracer.

Close the grilling with a **completeness sweep**: walk the design tree's untouched branches once — anything still undecided either becomes a question now or an explicit Open-risks entry, never a silent gap (the lenses aim the grill; the sweep is the backstop for branches no lens lit). Then ask for the **PRD budget** (`budget_usd` at intake — the config default is a fallback, not a decision).

## The compile check

Before writing anything, dry-run the decomposition aloud: "this PRD becomes roughly — contracts: X, Y; migration: Z (risk high by definition); features: A, B, C, probably tagged …". If you cannot sketch the tiers *with predicted risk tags*, the PRD is not done — return to grilling. Share the sketch for correction; the risk predictions give `/aeh-plan` something to hold the decomposer to.

## Synthesize

Write `prd.md` — pure synthesis, no new questions:

Problem · Solution · Requirements (each criterion checkable) · Contracts (shapes, not paths) · Testing decisions · Non-goals · Out of scope · Open risks (what grilling surfaced but couldn't close).

**Testing decisions** names the seam sketch and the PRIOR ART: the existing test harnesses db-backed/browser/integration criteria must copy, by path ("db-backed tests copy tests/acceptance/ISS-0002's fresh-db harness verbatim"). The decomposer propagates this into every issue's Test-harness contract — named once here instead of re-derived per issue (two attempt ladders died 2026-07-07 to a harness the spec said to 'mirror' instead of naming copy-verbatim at PRD level). When multiple slices touch one shared module/page, flag it here too: a later slice's new export breaks an earlier slice's hermetic mock of that module (green alone, throws together) — name it so the decomposer routes the mock amendment (2× in gm-portal PRD-0004).

No file paths or code snippets — except a snippet that encodes a decision more precisely than prose can (schema, type shape, state machine), trimmed to the decision.

Done when: every requirement's criterion names its check in the stack's own vocabulary; Non-goals is non-empty; the compile-check sketch drew cleanly with risk predictions; the budget is recorded; everything unresolved sits in Open risks rather than silently absent.
