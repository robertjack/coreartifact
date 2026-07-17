# Compile-time lessons from the first two campaigns

1. **A slice that surfaces a new facet needs the render/CLI seam in its
   footprint** — `src/cli/commands/show.ts` / `log.ts` and the relevant
   `src/render/**` file. PRD-0002 missed this twice: ISS-0018 escalated on
   a structural block (no in-footprint file could join test_results into
   show's stdout; scope_change granted one line), and ISS-0019 tripped the
   footprint gate twice attempting the same files. If the criterion says
   the user SEES something, the footprint must reach where seeing happens.
2. **Scan the plan for locked-test collisions before dispatch.** When a
   slice extends a surface a prior campaign's locked test pins exactly
   (manifest sets, `schema_version` literals, scenario counts), the
   collision is visible at plan time — name it in the issue spec as a
   sanctioned test amendment. ISS-0013 (schema v2 vs pinned v1) and
   ISS-0016 (eight streams vs exact-five set) both escalated on
   collisions the plan could have named. Rule: docs/gotchas.md #7.
3. **Contracts want one issue each** (PRD-0001, ISS-0001: the six-contract
   mega-issue drew nine S1s and split at round three, ~$22 sunk; every
   single-contract issue after it landed in ≤2 rounds).
4. **Operator-lane prerequisites are satisfied or scheduled BEFORE the run
   starts** (PRD-0001, ISS-0002: an interactive recording blocked the
   whole DAG at dispatch time, cascading `blocked` to seven issues).
