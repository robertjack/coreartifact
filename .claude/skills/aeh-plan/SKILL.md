---
name: aeh-plan
description: The plan gate as a break attempt — dry-run dispatch the plan's riskiest issues and rank what would fail, aimed by the ledger's history of how plans actually failed here.
argument-hint: "PRD id to gate (e.g. PRD-0007)"
disable-model-invocation: true
---

# aeh-plan

No red test exists for a plan; this session is the substitute. Do not walk the operator through the plan — **try to break it**, the way the code-reviewer tries to break a diff, and report what survived.

## 0. Load the ammunition

Read the PRD dir's `plan.json` (the compiled issue list + criteria mapping) and every spec it names under `docs/issues/` — until the gate they live on the `plan/<PRD>` branch, not main. Then arm the attacks with history, if it exists: the ledger via `aeh status` / `aeh why` (or `.aeh/aeh.db` directly) for **footprint_miss by issue kind**, **attempt distribution** (which kinds climb the ladder), **fast-path failure rate**, and past `retro.md` files. History converts generic attacks into aimed ones — "migrations climbed the ladder in 3 of 4 past campaigns; this plan has two tagged M" outranks any checklist. No ledger yet (early campaigns): run the attacks unaimed and say so.

Budgets and model tiers come from `.aeh/config.toml`; the fast path is risk-defined by the spec (low risk buys it), not a config key.

## 1. Break attempts

- **Dry-run dispatch** the two or three highest-risk issues: compile each packet in your head — spec, consumed contracts, conventions. Self-contained under the configured cap? Shippable by a competent engineer with zero PRD access? What exactly would the test-author turn red? A packet you can't compile is a plan defect, found now instead of mid-campaign.
- **Risk-tag audit** — every `low` buys the fast path (one review round, one attempt). Attack any low tag touching auth, money, migrations, concurrency, or a contract other issues consume — and any tag that contradicts `prd.md`'s compile-check predictions or the ledger's history for that kind.
- **Edge audit** — for each dependency edge, what actually breaks without it? Missing edges surface as escalations; false edges serialize work for nothing.
- **Data-interplay audit** — for any two issues whose rules act on the same persistent rows (one issue's migration defaults, another's validity rules), run the SHIPPED data through both on paper: each spec can be right alone and the pair still destroy real rows (PRD-0008: an unbackfilled column × a missing-value-means-dead rule would have tombstoned all 71 production eval fixtures on first preflight; cost a full attempt ladder).
- **Coverage walk** — map each PRD acceptance criterion to the one issue that owns it. Owned by "several together" is owned by nobody.
- **Two-issues-in-one smell** — any L that didn't justify itself; any title with "and" in it; any kind the attempt distribution says routinely climbs.
- **Built-in-first challenge** — for each new pattern the plan introduces, ask what existing code or framework primitive already solves it; a plan slice rebuilding a built-in is scope nobody asked for. Treat >8 files or >2 new services/modules in one issue as a complexity tripwire: stop and challenge the decomposition before workers spend on it.

## 2. Report, ranked

Findings most-severe first, each with the concrete campaign failure it predicts ("ISS-0007 tagged low but migrates the users table → fast path skips the data-architect") and the smallest fix: retag, split, add edge, or return to decomposer. Confirm the clean parts in one line each — spend the operator's minutes where the risk is, not uniformly.

## 3. Decide

- **Approve** → **merge the `plan/<PRD>` branch to main** — that IS the gate act: the runner reads `plan.json` from main, and a gated-but-unmerged plan fails with "No plan.json found" (cost a false campaign start, 2026-07-07). Then optionally `aeh mirror <PRD>` — sub-issues now carry full spec content.
- **Revise** → the finding list becomes the decomposer's one repair pass, verbatim; record the gate as `changes_requested` with the list as its note.
- **Reject upstream** → findings that trace to PRD ambiguity are fixed in `/aeh-prd`, not by replanning.

Done when: an outcome is recorded where aeh will find it, and every finding is fixed, sent to repair, or explicitly accepted by the operator — nothing left as "we'll see".
