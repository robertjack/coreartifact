---
name: schema-conventions
description: coreartifact persistence is deliberately NOT the web pack — SQLite/JSONL/JSON, no Postgres/RLS/Drizzle. Where the single persistence contract lives.
metadata:
  type: reference
---

coreartifact's persistence surface is three local artifacts, per-repo, no
server, nothing leaves the machine. The web charter's Postgres/RLS/tenancy/
Drizzle sections do NOT apply here — skip them.

- **spool** — per-repo append-only JSONL, ground truth forever, never
  mutated by ingest, never rotated (v1). Envelope `{v, ts, event}`;
  boundary lines add top-level `git: {head, dirty}`.
- **ledger** — per-repo SQLite, a *disposable rebuildable projection* of
  the spool. Ledger "migrations" are drop-and-re-ingest, not ALTER.
- **registry** — one global plain-JSON file `~/.coreartifact/registry`,
  `{v, ledgers:[{repo_root, added_at}]}`.

Load-bearing rulings baked into the schema:
- Event identity = `line_no`, the spool physical line ordinal (intrinsic,
  stable, the idempotency anchor). `session_id` is the session natural key.
- Ingest idempotency = HWM (`meta.ingested_bytes` + `lines_seen`) floored
  by the `line_no` unique constraint. NOT full-rescan.
- Degradation law = `NULL` means ABSENT (source unavailable), always
  distinct from empty/zero/success; command **outcome** is a derived
  three-state (success / failure / ABSENT-when-backgrounded), not a column.
- `status` recomputed every ingest (also on wall-clock-only ingests);
  never a one-way door.
- Promote nesting keys (`prompt_id`, `agent_id`, `agent_type`,
  `tool_use_id` — there is NO `subagent_id`) + set-valued aggregates
  (`footprint` table). Per-event facets stay in the verbatim `payload`.

**The single persistence contract is
`docs/prd/PRD-0001-walking-skeleton/schema.md` (schema v1), extended by
`docs/prd/PRD-0002-evidence-depth/schema.md` (schema v2).** Consult both
before any db.migration review or new-persistence design; they are the
reference the decomposer and integration-reviewer consume. CONTEXT.md is
the canonical vocabulary; docs/spec-v1.md holds the observed hook payload
shapes + the fragile-dependency register.

Schema v2 rulings (PRD-0002, added on the v1 spine — `meta.schema_version`
bumped 1→2, still a rebuild trigger, never ALTER):
- **Second spool envelope variant = the check line.** Stays `v:1`;
  discriminate by top-level key — `event` (hook line) xor `check` (CLI-
  written check line). Neither/both present → corrupt (same skip+count+
  name+occupy-ordinal rule). Check lines occupy a `line_no`; identity is
  the ordinal, same as events. `CHECK_OUTPUT_CAP_BYTES = 32768` (head-
  capture, `truncated` flag never silent).
- **Check binding is CAPTURED, not derived.** The CLI freezes
  `session_id`/`bound_by` (`single-open`|`explicit`|null=standalone) into
  the spool line at check time; ingest projects verbatim, never re-
  resolves — that is what makes R2 rebuild-equivalence hold.
- **Cost facet: tokens stored SEPARATELY from computed `cost_usd`.** Four
  token columns on sessions (dedup by `requestId` then sum), + `cost_usd`
  REAL computed from a pinned per-model price table that lives as a CODE
  CONSTANT, not schema (register entry). Separation makes "tokens present,
  cost absent" (unpinned model) expressible and a price fix + re-ingest
  recover cost. `model`, `cc_version` (transcript top-level `version`)
  also stored. All NULL=ABSENT.
- **test_results table** keyed by the command event's `line_no`; row
  membership encodes the degradation law (no row = no parser claimed;
  zero-count row = real zero tests). `failed_names` is JSON-array text,
  not a child table (read whole, no query-by-name). `duration_ms`
  NULL=ABSENT.
- **R14 backgrounded-outcome join** via a new promoted `events.
  background_task_id` (from `tool_response.backgroundTaskId` on the
  backgrounding PostToolUse and `tool_input.task_id` on later TaskOutput);
  outcome stays DERIVED (not stored), resolved by same-session join,
  unpolled tail still ABSENT. Spool never mutated.
- **absences table** `(session_id, facet, reason)` PK on (session_id,
  facet) — the drift detector's ABSENT record doctor reads. Only session-
  level single-slot facets participate (`cost`, `kind`); outcome and
  test-results encode ABSENT structurally, excluded to avoid noise.
- **kind is the one v1 facet rule v2 touches:** classification preserved
  (model present→interactive, absent→headless, no SessionStart→ABSENT);
  R7's stripped-model→ABSENT reconciled via finding-4 (prompt_input_exit
  end-reason contradicting absent model) — FLAGGED for operator confirm,
  schema is agnostic to the predicate.
- **Surface G = global operator state** `~/.coreartifact/state.jsonl` —
  fourth global artifact, same append-and-fold-no-RMW pattern as the
  registry. Ops `install`/`consent`/`ping`; fold = first-wins install_id,
  last-wins consent (default false), max last_ping_at; ping recorded at
  send-attempt time. Uninstall never touches it.
