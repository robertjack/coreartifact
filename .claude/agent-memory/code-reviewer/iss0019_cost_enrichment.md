---
name: iss0019-cost-enrichment
description: ISS-0019 cost enrichment F127/F128 per-request pricing fix — verified clean; where a regression would hide and where coverage is thin
metadata:
  type: project
---

# ISS-0019 cost enrichment (F127/F128 fix, HEAD 90c281a, reviewed 2026-07-16)

Per-request mixed-model pricing fix. Verified CLEAN by execution.

- **Per-request cache-class pricing is correct.** Built an adversarial fable+haiku mixed
  transcript with nonzero cache-read and split 5m/1h writes per request, hand-computed, drove
  through real `ingest()` → cost matched to the bit (0.12433820000000001). Each request's own
  `.message.model` prices its own usage; 5m→write5m, 1h→write1h, cacheRead→cacheRead, right model.
- **The committed oracles' numerators are all integers.** All 3 fixtures are fable-only with
  ephemeral_5m=0, and every fable rate (10/50/1.0/12.5/20.0) is a dyadic rational → numerator is an
  exact integer (555957/438619/674005) → `.toBe(0.55...)` exact-equality holds trivially. The
  "integer-domain summation" framing is imprecise (12.5 is fractional) but harmless: 12.5 is dyadic
  so fable arithmetic is always bit-exact. **The ONLY non-dyadic rate is haiku cacheRead=0.1** — it
  carries FP fuzz (N*0.1) but has NO oracle (haiku = shape coverage only), so no exactness contract
  is at risk. Spec forbids rounded rendering, so `${costUsd} (derived)` printing full float is
  CORRECT, not a defect.
- **Mutation genuine.** Reintroduced first-model pricing (price all requests at `[...values()][0]`)
  in a scratch src tree → both new unit files redden (mixedModelEnrichment.test.ts: 60.006 vs
  6.006; enrichment.test.ts F127 block). The ACCEPTANCE file (cost-enrichment.test.ts, from base
  commit 50fbbe8) stayed GREEN under the mutant — it has ZERO mixed-model coverage. F127/F128 are
  covered only by the two unit files the fix commit added; mixedModelEnrichment drives real
  `ingest()` end-to-end (satisfies F128).
- **Degradation ordering + recovery CLEAN.** unpinned-only→tokens present, cost null, model
  recorded, reason names model. Mixed pinned+unpinned→first unpinned in file order named (Map
  insertion order = first-occurrence order, matches "file order"). delete-ledger + re-ingest after
  transcript appears → cost regains (spec's sanctioned recovery path).
- **Consistent-with-design, not a bug:** a plain re-ingest with NO new spool bytes does NOT
  recompute enrichment for untouched sessions (enrichment/kind/footprint/test_results all loop over
  `touchedSessionIds`; only status recomputes for all). So a transcript appearing later needs
  delete-ledger OR a new session event to regain the facet. Spec R6 mandates delete-ledger as the
  recovery path, so this is correct — same recompute-per-touched-session pattern as footprint/kind.
- **The ISS-0017 check.test.ts flake did NOT reproduce** in 6 full-suite runs (449/449 each). It is
  load-sensitive per the fixer's note; unverified whether fixed or dormant. See
  [[iss0017_check_concurrency_gaps]] — the first-creation race in check's readOnly binding conn is a
  documented latent S1 that could be the flake's source.
