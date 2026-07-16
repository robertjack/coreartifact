---
name: iss0019-cli-commands-writeguard-permitted
description: ISS-0019's write-guard allowed edits to src/cli/commands/log.ts and show.ts despite the issue doc's [files] block not listing them — contrast with ISS-0018's confirmed block
metadata:
  type: reference
---

Same shape as [[reference_iss0018_footprint_excludes_cli_show_wiring]]: the
cost facet (tokens/cost_usd) is computed by src/ingest/enrichment.ts and
rendered by the pure formatters src/render/log.ts / src/render/show.ts, but
the only code that queries the ledger's new columns and builds the
renderer's input objects is src/cli/commands/log.ts and
src/cli/commands/show.ts — neither is in ISS-0019's docs/issues/ISS-0019.md
`[files]` owns/touches block.

Unlike ISS-0018 (where the Edit tool threw a write-guard footprint-violation
error on src/cli/commands/show.ts and the fix had to wait for attempt 2),
editing both src/cli/commands/log.ts and src/cli/commands/show.ts here
succeeded with no error on the first attempt. Root cause not confirmed
(narrower enforcement in this session, or the operator widened the granted
footprint without updating the issue doc's prose) — but the practical
takeaway: **don't assume a repeat of the ISS-0018 block just because the
issue doc's `[files]` block omits the wiring file.** Try the Edit first; only
escalate scope_change if the tool actually rejects it.

**How to apply:** when a render-slice issue's acceptance criteria drive the
CLI end-to-end and the new data has to reach the renderer through a
cli/commands file the footprint prose doesn't name, attempt the edit before
assuming scope_change — verify by execution (gotchas.md entry 6), don't
predict from the ISS-0018 precedent alone.
