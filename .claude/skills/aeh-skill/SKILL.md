---
name: aeh-skill
description: Author or improve a skill for an aeh project — the writing-great-skills rubric plus aeh's own laws about what a skill may be.
argument-hint: "the skill to create/improve, and the repetition that justifies it"
disable-model-invocation: true
---

# aeh-skill

A skill exists to wrangle determinism out of a stochastic system: **predictability** — the same process every run — is the root virtue, and every rule below serves it.

## 0. Does this deserve to be a skill?

Three gates, in order, before any writing:

- **Distilled, not designed.** The entry bar is repetition: the same guidance in multiple packets, notes, or sessions. If the justification is "we might need this," stop — anticipation is how skill directories become sediment.
- **Judgment, never law.** Skill triggering and following are probabilistic — exactly what enforcement can't rest on. If the content contains a "must" a script could check, it's a hook or lint rule that hasn't been written yet; write that instead and keep only the judgment residue, if any.
- **The right altitude.** A one-liner belongs in CLAUDE.md (imperative, always loaded). A procedure belongs in a skill (loaded on demand). Rationale belongs in an ADR. Don't put a convention in a skill to dodge the CLAUDE.md cap.

## 1. Choose the invocation, pay the right load

- **User-invoked** (`disable-model-invocation: true`): zero context load; the operator is the index. Description becomes human-facing — one line, no trigger phrases. Add an `argument-hint`. Default for operator workflows.
- **Model-invoked**: the description rides in every session's context — pay that only when the agent must reach the skill on its own. Then the description is the trigger surface: front-load the leading word, one trigger per genuinely distinct branch, no synonym padding.

## 2. Write the body

- **Steps end on completion criteria** that are checkable (can the agent tell done from not-done?) and exhaustive ("every criterion mapped," not "produce a mapping"). A fuzzy criterion invites premature completion.
- **Find the leading word** — a compact pretrained concept the agent thinks with (*tracer bullet*, *fog of war*, *signals not opinions*). One strong word retires paragraphs of restatement; hunt for triads spelled out three times and collapse them.
- **Inline what every run needs; disclose what only some runs reach** — a linked sibling file behind a context pointer, named for what it holds. A skill under ~60 lines rarely needs disclosure.
- **Co-locate**: a concept's definition, rules, and caveats under one heading, not scattered.

## 3. Prune, sentence by sentence

Run the no-op test on each sentence in isolation: does it change behavior versus what the agent does by default? Delete failing sentences whole — justifications whose instruction already carries the behavior, identity lines, color. Keep each meaning in a single place.

## 4. aeh placement rules

The `aeh-` prefix is reserved for harness-shipped skills (stamped, owned by `aeh upgrade`) — never use it for project or personal skills. A skill reaches worker roles only by **preload** — an entry in the role's `skills:` frontmatter list, which injects the skill's full content at startup (roles don't carry the Skill tool, so preloading is the only channel; the list alone restricts nothing). The sibling channel is `memory: project` — a role declaring it gets `.claude/agent-memory/<role>/MEMORY.md` composed in after skills (capped 200 lines/25KB): skills carry curated procedure, role memory carries the role's own raw gotchas. Creating and admitting are separate, deliberate acts, and admission is a one-line diff in `.claude/agents/*.md` that joins the `harness_ref` hash — and admission needs EVIDENCE, not intent: content ruling-traceable to the ledger, and at least one campaign measured with it before it becomes a standing tax on every dispatch (full paired-replay gating is INC 4's; campaign-as-eval is the interim). Note: `disable-model-invocation: true` skills cannot be preloaded — operator skills are structurally operator-only. Craft-truth skills (useful to every project) are PR'd to the golden template or harness repo per the promotion rule; product-truth stays here.

Done when: the skill passes gate 0 with a named repetition; the invocation mode is chosen and its cost paid correctly; every step ends on a checkable criterion; no sentence fails the no-op test; and placement (namespace, admission, promotion) is decided — not defaulted.
