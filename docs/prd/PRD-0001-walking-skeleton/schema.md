# PRD-0001 — persistence schema (schema v1)

Co-authored by the data-architect pass that the PRD's Contracts section
flags as running before decompose. This file is the single persistence
reference for the decomposer and the integration-reviewer: it fixes the
concrete shapes of all three persistence surfaces so no later slice
re-derives them.

Vocabulary is `CONTEXT.md`, exactly. Terms of art below (`spool`,
`ledger`, `envelope`, `facet`, `attribution`, `status`, `kind`,
`footprint`, `agent_id`) carry their CONTEXT.md meanings.

## Scope and stack

Not the web pack. There is no Postgres, no RLS, no tenancy, no Drizzle,
no server. The persistence surface is exactly three artifacts:

1. **The spool** — a per-repo append-only JSONL file. Ground truth,
   forever. Never mutated by ingest, never rotated (v1).
2. **The ledger** — a per-repo SQLite database. A *disposable,
   rebuildable projection* of the spool. Deleting it and re-ingesting the
   spool must rebuild equivalent rows (R6).
3. **The registry** — one global plain-JSON file listing ledger roots.

The repo boundary IS the trust boundary: one spool + one ledger per repo,
at `<repo_root>/.coreartifact/` (spec architecture ruling); the registry
is the single global file `~/.coreartifact/registry` (spec ruling). Exact
spool filename and the SQLite driver choice belong to the implementer, not
this file — the DDL below is vanilla `CREATE TABLE`.

Binding invariants this schema serves (from the PRD and CLAUDE.md laws):
payloads stored verbatim, never rewritten; the spool is ground truth and
the ledger a rebuildable projection; transcripts referenced by path, never
copied (no transcript column exists — the path lives inside the verbatim
payload); nothing leaves the machine; the canonical nesting key is
`agent_id` (there is no `subagent_id`); ingest never mutates the spool.

---

## Surface 1 — the ledger (SQLite DDL)

```sql
-- coreartifact ledger — SQLite, schema v1.
-- One ledger per repo at <repo_root>/.coreartifact/ledger.db.
-- A disposable, rebuildable projection of the spool. The spool is truth.

-- meta: single-row ledger header + ingest cursor -----------------------------
CREATE TABLE meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),  -- single-row guard
  schema_version INTEGER NOT NULL,                    -- = 1 this campaign
  ingested_bytes INTEGER NOT NULL DEFAULT 0,          -- HWM: byte offset after last consumed line
  lines_seen     INTEGER NOT NULL DEFAULT 0,          -- physical spool lines consumed (incl. skipped)
  last_ingest_at TEXT                                 -- iso8601, informational; NULL before first ingest
);

-- sessions: one row per session_id; an aggregate derived from its events ------
CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY NOT NULL,           -- natural key, verbatim from hook payload
  repo_root      TEXT NOT NULL,                       -- attribution result (main root, or init root if non-git)
  worktree_path  TEXT,                                -- worktree checkout path; NULL = ran in main checkout
  kind           TEXT CHECK (kind IN ('headless','interactive')),  -- NULL = ABSENT (no verified signal)
  status         TEXT NOT NULL
                 CHECK (status IN ('open','closed-clean','closed-inferred')),
  sha_before     TEXT,                                -- SessionStart git.head; NULL = ABSENT
  sha_after      TEXT,                                -- SessionEnd   git.head; NULL = ABSENT
  started_at     TEXT NOT NULL,                       -- iso8601, ts of earliest event
  last_event_at  TEXT NOT NULL,                       -- iso8601, ts of latest event (drives staleness)
  ended_at       TEXT                                 -- iso8601, ts of SessionEnd; NULL = ABSENT (no clean end)
);

-- events: one row per successfully-parsed spool line -------------------------
CREATE TABLE events (
  line_no         INTEGER PRIMARY KEY,                -- spool physical line ordinal: identity + idempotency anchor
  session_id      TEXT NOT NULL,                      -- payload.session_id (groups interleaved lines)
  seq             INTEGER NOT NULL,                   -- per-session ordinal, deterministic in line_no order
  ts              TEXT NOT NULL,                      -- envelope.ts, iso8601
  hook_event_name TEXT NOT NULL,                      -- payload.hook_event_name (promoted)
  prompt_id       TEXT,                               -- promoted nesting key; NULL = absent
  agent_id        TEXT,                               -- promoted nesting key; NULL = absent (not a subagent event)
  agent_type      TEXT,                               -- promoted nesting key; NULL = absent
  tool_use_id     TEXT,                               -- promoted nesting key; NULL = absent (non-tool event)
  payload         TEXT NOT NULL                       -- envelope.event, verbatim JSON text, never rewritten
);

-- footprint: distinct file paths touched; a materialized set facet -----------
CREATE TABLE footprint (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  PRIMARY KEY (session_id, path)                      -- membership + count; distinct by construction
);

-- indexes: each justified by a named access pattern (see Indexes) ------------
CREATE INDEX idx_events_session ON events (session_id, seq);
```

Notes on the DDL choices:

- **`meta` is a single-row table**, not key-value, so the header is a
  typed, self-documenting contract. `schema_version`, plus the two
  ingest-cursor columns (`ingested_bytes`, `lines_seen`) that make
  incremental ingest possible — see Identity below.
- **`sessions` is an aggregate**, not directly inserted. Every column
  except `session_id` and `repo_root` is *derived* from that session's
  events and recomputed on ingest. No hard `REFERENCES` is declared
  (SQLite FKs are off by default and the sessions row is itself derived
  from events); the relationship is `events.session_id → sessions.session_id`
  and ingest upserts the session aggregate as it processes its events.
- **`events.payload` is `TEXT`**, holding the JSON text of the envelope's
  `event` member — see Event payload storage.
- **`footprint` is the one materialized facet table** — justified under
  Facets. Everything else derives at render from `events` + `payload`.

---

## Identity and ingest idempotency

### Session identity

`session_id` is the natural key, taken verbatim from the hook payload
(`session_id` is present on every observed event — spec smoke test). It is
the `sessions` primary key and the `events.session_id` grouping column.
Interleaved concurrent sessions in one spool group correctly because every
physical line carries its own `session_id` regardless of interleave order
(R6, last clause).

### Event identity — the spool line ordinal

**An event's identity is `line_no`: the 1-based ordinal of its source line
in the spool.** This is the intrinsic, stable, deterministic identity —
the Nth physical line of an append-only, never-mutated spool is always the
Nth line. It is chosen over any payload-derived key because:

- Hook payloads carry **no globally unique event id**; `ts` can collide,
  and the same hook event name legitimately recurs within a session.
- `line_no` is a pure function of spool *content and position*,
  independent of ledger state — so it is identical on a from-scratch
  rebuild (delete ledger → re-ingest → line 42 is line 42 again → same
  `line_no` → equivalent rows, R6).
- It survives corruption: a corrupt line **occupies its ordinal** (see the
  algorithm), so a valid line always keeps the same `line_no` whether or
  not neighbors parse.

`line_no` is the `events` PRIMARY KEY (an `INTEGER PRIMARY KEY` rowid
alias — the efficient case) and therefore the `ON CONFLICT` dedupe anchor.

`seq` is a **per-session presentation ordinal**, assigned deterministically
in `line_no` order (a session's Kth event, ordered by `line_no`, gets
`seq = K`). Because the spool is append-only, a session's later events
always carry higher `line_no` than its earlier ones, so `seq` is stable
across incremental and from-scratch ingest alike. `seq` is *not* the
identity — `line_no` is; `seq` exists to give `show` a clean per-session
timeline order and index (`idx_events_session`).

### Idempotency mechanism — high-water mark, floored by the unique key

**Chosen: an ingest high-water mark in `meta`, backed by the `line_no`
unique constraint as a correctness floor.** Rejected alternative: full
rescan + content dedupe on every ingest.

Why not pure full-rescan: the spool never rotates this campaign (append
forever), so a full rescan is O(spool size) *every* `log`/`show` — an
unbounded and growing cost on the hot read path.

Why not pure HWM: a bare cursor is fragile — a partial write, a crash
between inserting events and persisting the cursor, or a cursor reset would
double-insert.

So each earns its place: **`ingested_bytes` (byte offset) gives O(new
bytes) ingest**; **the `line_no` primary key guarantees correctness** even
if the cursor is stale, reset, or the spool is re-read from zero (the
rebuild case). `lines_seen` persists the physical-line counter so `line_no`
numbering *continues correctly across incremental runs and includes
skipped-corrupt lines* — without it, `max(line_no)+1` would silently
re-number after a corrupt line and break rebuild-equivalence.

### Ingest algorithm (contract-level)

Run inside a **single transaction** so the event inserts and the `meta`
cursor advance commit atomically (a crash rolls both back; no partial
state):

1. If the ledger is absent, create the schema and the `meta` row
   (`schema_version = 1`, `ingested_bytes = 0`, `lines_seen = 0`).
2. Seek the spool to `ingested_bytes`. Read line by line.
3. For each **complete** line (terminated by `\n`):
   `line_no = lines_seen + 1`; `lines_seen += 1`.
   - **Parse fails** (not envelope v1 / malformed JSON): increment a
     skipped counter, name the line in output (R6), insert *no* event row —
     but still advance `lines_seen` and `ingested_bytes` past it. The
     corrupt line is permanently skipped and permanently occupies its
     ordinal. Continue to the next line.
   - **Parse succeeds**: promote fields; `INSERT INTO events … ON
     CONFLICT(line_no) DO NOTHING`; upsert the session aggregate.
4. Stop at the last complete line. **Leave any trailing partial line (no
   `\n`) unconsumed** — do not advance past it; a hook may still be
   mid-append. Set `ingested_bytes` to the offset after the last consumed
   `\n`; persist `lines_seen`.
5. Recompute derived `sessions` columns (facets + `status`) — see Status
   for why `status` is recomputed for *all* sessions, not only touched
   ones.
6. Persist `meta` (`last_ingest_at = now`).

**R6 conformance, clause by clause:**

- *Re-run changes zero row counts* — cursor is at EOF, no new complete
  lines, zero inserts; facet/status recompute is `UPDATE`, never
  `INSERT`/`DELETE`.
- *Delete ledger + re-ingest rebuilds equivalent rows* — `meta` dies with
  the ledger, cursor resets to 0, full rescan re-derives identical
  `line_no` (and therefore `seq`, sessions, facets).
- *Corrupt line skipped, counted, named, subsequent lines still ingest* —
  step 3's failure branch.
- *Interleaved concurrent sessions group by session id* — `session_id` on
  every line; `line_no` gives a total capture order across the interleave.

---

## The degradation law as a schema convention

**Stated once, applied everywhere: NULL means the facet is ABSENT (its
source was unavailable). ABSENT is always representable distinctly from
empty, zero, and success.** A facet is never defaulted to a plausible
value; the ledger never fabricates evidence (CLAUDE.md law).

Two encodings, by column shape:

**(a) Stored nullable columns — `NULL = ABSENT`.** Applies to
`sessions.sha_before`, `sessions.sha_after`, `sessions.kind`,
`sessions.ended_at`, `sessions.worktree_path` and the four nullable
`events` nesting keys.

- `sha_before` / `sha_after` — `NULL` when the boundary line is missing
  (crash: no SessionEnd → `sha_after` NULL) or when `git.head` was absent
  in the envelope (non-git cwd, or a repo with no commits). `NULL` is
  distinct from a real 40-char sha and from an empty string; a repo with no
  HEAD reads ABSENT, never `''`.
- `kind` — `NULL` unless the recording pass finds a fixture-verified
  discriminating signal (R9). The smoke test found none, so `kind` is
  expected to be `NULL` for every session this campaign. Ingest **never**
  sets `kind` heuristically; the `CHECK` allows the two values but the
  common state is `NULL`/ABSENT.
- `ended_at` — `NULL` when no SessionEnd was captured. This is the direct
  signal for `closed-clean` vs not (see Status).
- `worktree_path` — `NULL` means the session ran in the *main checkout*
  (there is no distinct worktree). This is a genuine N/A, not a degraded
  facet, but it reads the same way: absent = no worktree.
- `events` nesting keys (`prompt_id`, `agent_id`, `agent_type`,
  `tool_use_id`) — `NULL` when the payload did not carry them (e.g.
  `agent_id`/`agent_type` NULL on any event outside a subagent;
  `tool_use_id` NULL on non-tool events).

**(b) Derived per-event facets — ABSENT is a distinct payload signature.**
The command **outcome** is *not* a stored column (see Facets); it is
computed at render from `hook_event_name` + `payload`. Its three states map
to three distinct, non-overlapping signatures the schema guarantees survive
by storing `hook_event_name` promoted and `payload` verbatim:

- **success** — `PostToolUse` on a Bash command, no failure marker.
- **failure** — `PostToolUseFailure`, carrying its `error` string
  (verbatim in `payload`, embedding `Exit code N`).
- **ABSENT** — an auto-backgrounded command: `PostToolUse` whose
  `tool_response` carries `backgroundTaskId` with no exit outcome (spec
  smoke test). Its outcome is ABSENT, and ingest/render **must never**
  collapse it into success or failure (R8/R12). Backgrounded-outcome is
  final this campaign (no completion event is consumed).

The renderer's job in `log`/`show` (R12): every ABSENT — sha-absent,
kind-absent, outcome-absent — prints an explicit absent marker,
distinguishable from empty/zero/success.

---

## Status derivation (R7)

`sessions.status` is a `TEXT` column, `NOT NULL`, `CHECK`-constrained to
`open | closed-clean | closed-inferred`, and **recomputed on every ingest**
from a pure function — never a one-way door:

- **`closed-clean`** — a SessionEnd event was captured (`ended_at IS NOT
  NULL`).
- **`closed-inferred`** — no SessionEnd, and `last_event_at` is older than
  the staleness threshold (a named constant, 12h — R7).
- **`open`** — no SessionEnd, and `last_event_at` is recent.

Two consequences the storage must honor:

1. A late-ingested SessionEnd flips `closed-inferred` → `closed-clean`.
   Because status is a recomputed `UPDATE` keyed on the (now-present)
   SessionEnd event, this is automatic and reversible — no state is
   sticky.
2. Status depends on **wall-clock now**, not only on new spool lines. An
   `open` session can become `closed-inferred` on an ingest that reads
   *zero* new lines, purely because time passed. Therefore step 5 of the
   algorithm recomputes `status` for **all** sessions each ingest, not only
   those touched by new events. This is an `UPDATE`, so it changes no row
   counts (R6 idempotency holds).

---

## Facets — where each lives

| Facet | Source | Storage |
|---|---|---|
| sha before / after | envelope `git.head` on SessionStart / SessionEnd | promoted → `sessions.sha_before` / `sha_after` |
| footprint (distinct paths) | file-editing tool events | **materialized** → `footprint` table |
| session kind | fixture-verified signal (none yet) | `sessions.kind` (NULL this campaign) |
| status | derived from SessionEnd + staleness | `sessions.status` |
| command string / duration | Bash `PostToolUse` payload | derived at render from `payload` |
| command outcome | `hook_event_name` + payload signature | derived at render (three-state, above) |
| command count (R10) | count of Bash tool events | derived at query from `events` |

**Why `footprint` is materialized but commands are not.** Footprint is a
*set-valued, cross-event aggregate* (distinct paths over many events),
awkward to express as one SQL query over JSON arrays and needed by both
R10 (count) and R11 (list) — so it earns a table, recomputed each ingest
for touched sessions, fully rebuildable from `events`. Commands, outcome
and duration are *per-event* facets readable from a single event's
`payload` via `json_extract` at render time — promoting them would
duplicate the verbatim source for no query win. This is the line: promote
nesting keys (per the PRD) and set-valued aggregates (footprint); leave
per-event facets in the verbatim payload.

**Footprint definition (CONTEXT.md):** distinct file paths touched via
*file-editing* tool events (Edit/Write and kin). Bash side-effects on files
are not footprint (v1).

**dirty flag.** The envelope's `git.dirty` is captured on boundary lines
(R4) and lives in the spool, but v1 promotes no `dirty` column — no
requirement renders it. It remains recoverable from the spool if a later
facet needs it. (Not speculatively added.)

---

## Indexes (justified only by named access patterns)

- **`events.line_no` PRIMARY KEY** — serves ingest dedupe lookups
  (`ON CONFLICT(line_no)`) and is the identity. No extra index needed.
- **`sessions.session_id` PRIMARY KEY** — serves R11 `show <session>`
  lookup and ingest's session upsert.
- **`footprint (session_id, path)` PRIMARY KEY** — serves footprint
  membership and per-session count (`WHERE session_id = ?`).
- **`idx_events_session ON events (session_id, seq)`** — the one added
  index. Serves R11 `show`'s per-session chronological timeline
  (`WHERE session_id = ? ORDER BY seq`) and R10 `log`'s per-session
  command-count aggregate.

No other indexes. Explicitly **not** added (no named access pattern):
`sessions(repo_root)` — within a ledger all sessions resolve to ~one repo
root; the cross-repo union in R10 is done across *ledgers* via the
registry, not by a `repo_root` filter. `events(hook_event_name)`,
`events(ts)` — `show` orders within a session by `seq`, already covered.
If profiling ever shows R10's command count is slow, promoting `tool_name`
(read today via `json_extract`) is the first lever — deferred, not
speculatively added.

---

## Event payload storage

`events.payload` is **`TEXT`** holding the JSON text of the envelope's
`event` member — the hook payload — **byte-preserved and never rewritten**
(PRD invariant). Ingest stores the `event` value's source text as written
to the spool; it does not re-serialize it (re-serialization would reorder
keys and violate "never rewritten"). `TEXT` (not `BLOB`) because the spool
is UTF-8 JSON and SQLite's `json_extract` — used to read command / outcome /
duration / `tool_name` at render — operates on `TEXT`.

The envelope's `git` sibling (boundary lines only) is **not** stored in
`payload`: `payload` is the `event` field alone. Ingest consumes `git.head`
to populate `sessions.sha_before` / `sha_after`; `git.dirty` stays in the
spool. Transcripts are referenced by the `transcript_path` that already
lives inside the verbatim payload — never copied into a column (PRD/CLAUDE
law). The ledger stores no transcript content this campaign (no transcript
reading at all — PRD non-goal).

---

## schema_version and the versioning stance

`meta.schema_version = 1`. Schema v1 is built from nothing; there is **no
migration tier this campaign** (PRD compile sketch).

The stance that makes this cheap: **the ledger is a disposable projection,
so ledger schema evolution is "drop and re-ingest," not an `ALTER`
script.** When a future release ships `schema_version = 2`, ingest that
opens a lower-versioned (or version-mismatched) ledger rebuilds it from the
spool rather than migrating data in place. The spool is ground truth; the
migration is a rebuild.

That is *why* the two contracts that actually need careful versioning are
the ones the ledger cannot regenerate: the **spool envelope `v`** and the
**registry `v`**. Those are the durable, forward-compatible surfaces.
Treat their version fields as the real schema contract; treat
`meta.schema_version` as a rebuild trigger.

---

## Surface 2 — the spool envelope (v1)

The spool is per-repo append-only JSONL at `<repo_root>/.coreartifact/`
(exact filename owned by the init slice). One line per hook invocation,
written with a single atomic `O_APPEND`, never rewritten, never rotated
(v1). The hook artifact always exits 0 — a capture failure must never break
the host session.

```
{ "v": 1, "ts": "<iso8601>", "event": <hook payload, verbatim> }

boundary lines (SessionStart / SessionEnd) additionally carry a top-level
git sibling of `event`:

{ "v": 1, "ts": "<iso8601>", "event": <payload>,
  "git": { "head": "<sha>", "dirty": <bool> } }
```

- `v` — envelope version, `1`. The durable version contract (above).
- `ts` — ISO-8601 capture time; becomes `events.ts`.
- `event` — the hook payload **verbatim**, byte-preserved (R4); becomes
  `events.payload`. Carries `session_id`, `hook_event_name`, `cwd`,
  `transcript_path`, and per-event `prompt_id` / `agent_id` / `agent_type`
  / `tool_use_id` where present.
- `git` — **boundary lines only**, a sibling of `event` (the only
  enrichment the hook adds beyond the pass-through). `head` and `dirty`
  each follow the degradation law: **the key is present with its value, or
  ABSENT (key omitted / null)** when git resolution failed (non-git cwd,
  no-HEAD repo). Ingest maps present → value, absent → `NULL` in
  `sha_before` / `sha_after`.

The hook artifact is self-contained and zero-dependency (must run in a repo
with no `node_modules`), referenced by absolute path from the hook config.
Its only behaviors: the append and boundary git enrichment (2026-07-14
amendment — WorktreeCreate propagation removed; it is a delegation hook and
subscribing it breaks agent worktree spawns, see docs/recording-pass.md).

---

## Surface 3 — the registry (global JSON)

One global plain-JSON file at `~/.coreartifact/registry` (spec ruling)
listing known ledger roots with added-at timestamps. What `log` unions
across repos (R10).

```json
{
  "v": 1,
  "ledgers": [
    { "repo_root": "/abs/path/to/repo", "added_at": "<iso8601>" }
  ]
}
```

- `v` — registry version, `1`. A durable version contract (above).
- `ledgers[]` — one entry per registered repo. `repo_root` is the
  attribution root (the ledger lives at
  `<repo_root>/.coreartifact/ledger.db`, the spool alongside it).
  `added_at` is ISO-8601.
- **Uniqueness by `repo_root`** — `init` re-run adds no duplicate entry
  (R2). `log` iterates `ledgers[]`, opens/ingests each ledger, and unions
  the `sessions` rows across all of them (R10).

---

## The three schema decisions most expensive to reverse

1. **Event identity is the spool physical line ordinal (`line_no`), and
   the spool line is the atomic unit of ground truth.** Every idempotency
   guarantee, the HWM cursor, dedupe, rebuild-equivalence, and timeline
   order all hang off it. Reversing it — moving to a payload-derived
   surrogate or a content hash — would break "delete and re-ingest rebuilds
   equivalent rows," would force a re-numbering of every historical spool
   line, and would ripple into `seq`, the cursor, and every consumer that
   assumed a stable ordinal. It is chosen now because the append-only,
   never-mutated spool makes the ordinal *provably* stable, which no
   payload field is.

2. **The ledger is a disposable projection; the spool is the sole ground
   truth; the payload is stored verbatim.** This is what lets ledger schema
   migrations be "drop and rebuild" instead of data migrations, and it is
   the product's trust story ("receipts you can regenerate"). The moment
   the ledger is allowed to accrete state the spool cannot reconstruct
   (user annotations, a lossy payload rewrite, a stateful status that
   doesn't recompute), "rebuild equivalent rows" dies permanently and every
   downstream assumption of rebuildability breaks. Reversing this is a
   one-way door for the whole data model.

3. **The degradation law is encoded structurally — `NULL = ABSENT` on
   typed nullable columns, and a distinct payload signature for derived
   outcome — so absent is never conflated with empty, zero, or success.**
   This is the one guarantee the product must never violate: the ledger
   does not fabricate evidence. Reversing it — defaulting `sha_*` to `''`,
   `kind` to `interactive`, or backgrounded outcome to success — would
   silently manufacture false receipts that are nearly impossible to detect
   after the fact across accumulated ledgers, and would poison the corpus
   that later campaigns (evals, cost) build on. Baking absence into
   nullability and into the three-state outcome makes fabrication a schema
   violation, not a code slip.