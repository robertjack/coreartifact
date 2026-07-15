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
`docs/prd/PRD-0001-walking-skeleton/schema.md`** — consult it before any
db.migration review or new-persistence design; it is the reference the
decomposer and integration-reviewer consume. CONTEXT.md is the canonical
vocabulary; docs/spec-v1.md holds the observed hook payload shapes.
