---
name: daily-lane-sonnet5-pin-evidence
description: The exact cross-referenced evidence that pinned claude-sonnet-5 to the STANDARD price tier ($3/$15), not the documented intro tier — for re-deriving or auditing the pin later.
metadata:
  type: reference
---

2026-07-20: `src/core/priceTable.ts` pinned `claude-sonnet-5` at
in=3.00, out=15.00, cacheRead=0.3, write5m=3.75, write1h=6.00 (USD/MTok,
standard multiples: cacheRead=0.1x in, write5m=1.25x in, write1h=2x in).

**Method**: joined `.coreartifact/ledger.db` `sessions.tokens_*` (parsed
via the ISS-0019 dedup rule) against `.aeh/aeh.db` `attempts.cost_usd` (the
envelope oracle, Claude Code's own `total_cost_usd`) on `session_id`, for 7
real claude-sonnet-5 worker attempts: f60a4043, 4af91a7c, 8fc93fd5,
a0e792c9, e5d1454c, 642aad37, 3b861cb6.

For every one of the 7: `(cost_usd*1e6 - (in*3 + out*15 +
cacheRead*0.3)) / cacheCreationTokens == 6.0` exactly (zero residual) —
i.e. all cache-creation tokens billed at the standard tier's 1h rate. The
documented intro tier ($2/$10, same multiples) does not fit any of the 7
pairs under any 5m/1h mix — even an all-1h intro-tier assumption yields a
lower number than observed.

Caveat noted in the pin's own comment: the ledger's `tokens_cache_creation`
column is a display aggregate (5m+1h combined), not the pricing split, so
this derivation assumes 100% 1h — confirmed self-consistently across all 7
independent sessions, which is why it's trusted despite the aggregate
column.

Collides with a locked acceptance test — see
[[feedback_daily_lane_pinning_can_break_locked_acceptance_oracle]].
