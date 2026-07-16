# PRD-0002 — persistence schema (schema v2)

The v2 continuation of `docs/prd/PRD-0001-walking-skeleton/schema.md`
(schema v1 — the normative prior art). This file EXTENDS that design; it
does not re-derive it. Every v1 ruling it depends on is cited, not
restated: event identity is the spool line ordinal (`line_no`); the ledger
is a disposable projection and the spool is sole ground truth; ingest is
HWM-cursored and idempotent; `NULL` means ABSENT, never fabricated;
promote join keys and materialize set-valued aggregates, leave per-event
facets in the verbatim payload. Read v1 first; this file only adds.

Vocabulary is `CONTEXT.md`, exactly — `check`, `absence reason`,
`enrichment`, `parser`, `operator state` carry their CONTEXT.md meanings,
no synonyms.

The persistence surfaces are unchanged in number and character (v1 Scope):
the per-repo **spool** (append-only JSONL, ground truth), the per-repo
**ledger** (disposable SQLite projection), the global **registry**
(append-only JSONL fold). v2 adds a fourth global artifact — **operator
state** (Surface G below) — built on the exact append-and-fold pattern the
registry already uses. This is NOT the web pack: no Postgres, no RLS, no
Drizzle, no server, no ALTER migration.

`meta.schema_version` bumps **1 → 2**. Per the v1 versioning stance and the
PRD Contracts ruling, that bump is a **rebuild trigger, not an `ALTER`
script**: an ingest that opens a ledger with `schema_version < 2`
deletes-and-reingests from the spool. **There is no migration tier in this
campaign or any other.** The durable version contracts — the spool
envelope `v`, the registry `v`, and the new operator-state `v` — all stay
`1`; only the rebuild trigger moves.

---

## Surface 1 — the check line (spool envelope, second variant)

`coreartifact check <name> -- <cmd>` runs the wrapped command and appends
**exactly one** check line to the spool, then exits with the wrapped exit
code (R1). The check line is written by the **CLI**, not the hook artifact
— the hook artifact is byte-unchanged this campaign (invariant). Both
writers emit the same framing.

```
{ "v": 1, "ts": "<iso8601>",
  "check": { "name": "<str>", "argv": ["<cmd>", "<arg>", …],
             "exit": <int>, "output": "<capped str>", "truncated": <bool>,
             "session_id": "<id>" | null,
             "bound_by": "single-open" | "explicit" | null } }
```

### The envelope stays `v: 1` — discriminated by key, not by version

**Decision: the envelope version does not bump; the check line is a second
`v: 1` variant, discriminated by which top-level member is present.** A
parsed `v: 1` line carries **exactly one** of:

- `event` → a hook-event line (v1 capture path, unchanged), or
- `check` → a check line (this surface).

Rationale, and why NOT `v: 2`: `v` is the **framing** contract (v1
versioning stance) — "one JSON object per line, `v` + `ts` present, the
reader knows how to skip what it doesn't recognize." Framing is unchanged;
only a new variant is added under it. Bumping to `v: 2` would split the
version space against the grain of the contract: hook lines are *still*
`v: 1`, so a per-variant bump can't work, and a blanket bump would force
every existing `v: 1`-only reader to reject unchanged hook lines. The v1
stance already names this: "each line carries [`v`], so the format can
evolve without a migration." A sibling variant is exactly that evolution.

### Ingest discrimination and the corrupt-line rule

The v1 corrupt-line rule (v1 Ingest algorithm step 3) is **extended, not
changed**. A physical spool line is classified after JSON parse:

- Not valid JSON, or not `v: 1` → **corrupt**: skip, count, name, occupy
  its `line_no` ordinal (v1, unchanged).
- `v: 1` with **exactly one** of `event` / `check` → route to the events
  path or the checks path respectively.
- `v: 1` with **neither** or **both** discriminators → **corrupt**, by the
  same rule (skip, count, name, occupy the ordinal). A line that is neither
  a hook event nor a check is not silently guessed into either.

A check line **occupies a `line_no`** exactly as a hook-event line does —
it is a physical spool line — so `lines_seen`/`ingested_bytes` advance over
it and its identity is its ordinal (see Surface 2). Corrupt-line skips
still occupy their ordinal so `line_no` stays stable across rebuild (v1
Identity, unchanged).

### The output cap

**`CHECK_OUTPUT_CAP_BYTES = 32768` (32 KiB).** The CLI captures the wrapped
command's combined output; if its UTF-8 byte length exceeds the cap it
stores the first `CHECK_OUTPUT_CAP_BYTES` bytes (truncated on a codepoint
boundary) and sets `truncated: true`; otherwise `truncated: false`.
**Truncation is always flagged, never silent** (R1, PRD open risk 6).

Sizing: 32 KiB holds a full vitest failure block or a compiler error dump —
the actionable evidence — while keeping the never-rotated append-forever
spool from ballooning across thousands of checks. Head-capture (first N
bytes) is chosen over tail for determinism and because a check's primary
signal is its `exit` code; `output` is supporting evidence and its opening
lines carry the command banner and first error. The capping *policy* is the
`check` CLI slice's; the schema stores the already-capped `output` string
plus the `truncated` flag verbatim.

---

## Surface 2 — the ledger, schema v2 (SQLite DDL)

The v2 ledger is **built fresh** (drop-and-reingest; never `ALTER`ed).
Below is the complete v2 schema; deltas from v1 are marked `-- +v2`.
Unmarked tables/columns are v1 verbatim — see v1 Surface 1 for their notes.

```sql
-- coreartifact ledger — SQLite, schema v2.
-- Disposable, rebuildable projection of the spool + transcripts-at-path.
-- The spool and the transcript files are truth; this rebuilds from them.

-- meta: single-row header + ingest cursor (v1; schema_version now 2) ----------
CREATE TABLE meta (
  id             INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,               -- = 2 this campaign (rebuild trigger)
  ingested_bytes INTEGER NOT NULL DEFAULT 0,
  lines_seen     INTEGER NOT NULL DEFAULT 0,
  last_ingest_at TEXT
);

-- sessions: aggregate per session_id; v2 adds the cost/token facet ------------
CREATE TABLE sessions (
  session_id     TEXT PRIMARY KEY NOT NULL,
  repo_root      TEXT NOT NULL,
  worktree_path  TEXT,
  kind           TEXT CHECK (kind IN ('headless','interactive')),
  status         TEXT NOT NULL
                 CHECK (status IN ('open','closed-clean','closed-inferred')),
  sha_before     TEXT,
  sha_after      TEXT,
  started_at     TEXT NOT NULL,
  last_event_at  TEXT NOT NULL,
  ended_at       TEXT,
  -- +v2 cost/token facet: enrichment-derived from the transcript-at-path.
  -- All NULL = ABSENT (degradation law). Tokens are stored SEPARATELY from
  -- cost_usd so "tokens present, cost absent" (unpinned model) is expressible
  -- and a price-table fix + re-ingest retroactively regains cost.
  tokens_input          INTEGER,   -- +v2 summed across requestId-deduped requests
  tokens_output         INTEGER,   -- +v2
  tokens_cache_read     INTEGER,   -- +v2
  tokens_cache_creation INTEGER,   -- +v2
  cost_usd              REAL,      -- +v2 computed from the pinned price table; NULL = ABSENT
  model                 TEXT,      -- +v2 transcript .message.model; the price-table key + display
  cc_version            TEXT       -- +v2 transcript top-level `version` (per-session recorded CC version)
);

-- events: one row per hook-event line; v2 promotes the TaskOutput join key ----
CREATE TABLE events (
  line_no         INTEGER PRIMARY KEY,
  session_id      TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  ts              TEXT NOT NULL,
  hook_event_name TEXT NOT NULL,
  prompt_id       TEXT,
  agent_id        TEXT,
  agent_type      TEXT,
  tool_use_id     TEXT,
  background_task_id TEXT,   -- +v2 promoted join key (see Surface 6); NULL = absent
  payload         TEXT NOT NULL
);

-- footprint: distinct file paths touched (v1, unchanged) ----------------------
CREATE TABLE footprint (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  PRIMARY KEY (session_id, path)
);

-- +v2 checks: the checks projection. One row per check line ----------------
CREATE TABLE checks (
  line_no    INTEGER PRIMARY KEY,   -- the check line's spool ordinal: identity + idempotency anchor
  ts         TEXT NOT NULL,         -- envelope.ts
  name       TEXT NOT NULL,         -- check.name
  argv       TEXT NOT NULL,         -- check.argv, JSON array text, verbatim
  exit_code  INTEGER NOT NULL,      -- check.exit (pass = 0; richer than a bool — 1 vs 137 preserved)
  output     TEXT NOT NULL,         -- check.output, already capped by the CLI
  truncated  INTEGER NOT NULL CHECK (truncated IN (0,1)),
  session_id TEXT,                  -- check.session_id; NULL = standalone (no binding, by rule)
  bound_by   TEXT CHECK (bound_by IN ('single-open','explicit')),
  -- binding is all-or-nothing: bound_by is set iff a session is bound
  CHECK ((session_id IS NULL) = (bound_by IS NULL))
);

-- +v2 test_results: parser-derived test facet. One row per claimed command --
CREATE TABLE test_results (
  line_no      INTEGER PRIMARY KEY, -- the command event's line_no: identity (rebuild re-runs the parser → same row)
  session_id   TEXT NOT NULL,       -- denormalized for per-session render (footprint pattern)
  parser       TEXT NOT NULL,       -- which parser claimed it ('vitest') — provenance
  passed       INTEGER NOT NULL,    -- count; 0 is a real zero (row-present), distinct from facet-absent (no row)
  failed       INTEGER NOT NULL,
  skipped      INTEGER NOT NULL,
  duration_ms  INTEGER,             -- NULL = parser could not extract it (ABSENT), distinct from 0ms
  failed_names TEXT NOT NULL        -- JSON array text of failed test names; '[]' when failed=0 (real empty, not NULL)
);

-- +v2 absences: the drift detector's per-session × facet ABSENT record -----
CREATE TABLE absences (
  session_id TEXT NOT NULL,
  facet      TEXT NOT NULL,         -- 'cost' | 'kind' (enumerated below)
  reason     TEXT NOT NULL,         -- enumerated reason string naming the missing/mismatched source
  PRIMARY KEY (session_id, facet)   -- at most one absence per facet per session
);

-- indexes: each justified by a named access pattern (see Indexes) ------------
CREATE INDEX idx_events_session       ON events       (session_id, seq);       -- v1
CREATE INDEX idx_checks_session       ON checks       (session_id);            -- +v2 R12 render / show
CREATE INDEX idx_test_results_session ON test_results (session_id);            -- +v2 R12 render / show
```

Notes carry forward from v1 (single-row `meta`; `sessions` is a derived
aggregate with no hard `REFERENCES`; `payload` is `TEXT` holding the
`event` member byte-preserved). The v2 additions are justified per surface
below.

---

## Surface 2a — the checks projection, and the binding-is-captured rule

**Identity is `line_no`** — the check line's spool ordinal, exactly the v1
event-identity law. This buys R2 (checks survive rebuild) for free: line 42
is line 42 on a from-scratch re-ingest, so `ON CONFLICT(line_no) DO
NOTHING` dedupes and the rebuilt rows are equivalent. Ingest routes a
`check`-variant line into `checks`, a hook-event line into `events`; both
consume ordinals from the same `line_no` sequence.

**pass/fail is derived from `exit_code` (0 = pass), not stored.** This
mirrors v1's discipline — the outcome facet is derived, not a redundant
boolean. `exit_code` is the stored truth because it is strictly richer than
a boolean (a 137/SIGKILL exit reads differently from a 1). R1's "pass/fail"
is the render of `exit_code == 0`.

**Binding is CAPTURED at check time and frozen in the spool line — ingest
reads it, never re-resolves it.** This is the load-bearing ruling for
checks. R3 requires "the resolved binding and which rule produced it are
recorded in the spool line itself." So the `check` CLI resolves the binding
**once**, against the ledger's open-session set as it exists at check time:

- exactly one `open` session → bind, `session_id = <that id>`,
  `bound_by = "single-open"`;
- `--session <id>` given → `session_id = <id>`, `bound_by = "explicit"`
  (an unknown id exits nonzero naming it — no line is written);
- zero or several `open` → standalone, `session_id = null`,
  `bound_by = null` — never a guess (degradation-law-adjacent: NULL here is
  "no binding, by rule," the same honest-N/A shape as v1
  `worktree_path` = NULL = "ran in the main checkout").

Ingest then **projects `session_id`/`bound_by` verbatim** from the frozen
line; it does not consult the current open-session set. This is what makes
R2 hold: re-ingest against a ledger in a *different* state must still
produce the same binding, and it does because the binding lives in the
spool, not in ingest logic. No hard FK to `sessions` (v1 rationale:
`sessions` is itself derived, SQLite FKs off); a bound `session_id` may name
a session whose events have not yet been ingested, or a standalone check may
outlive its session — both are honest.

Render (R12): `log`'s checks column and `show`'s check badge lines read
`checks WHERE session_id = ?` (served by `idx_checks_session`). Standalone
checks are `WHERE session_id IS NULL` (the same index serves NULLs); no
separate high-frequency access pattern, so no separate index.

---

## Surface 2b — cost/token columns (enrichment)

The cost facet is the register's most brittle entry and the only
transcript-derived facet (invariant: the trust spine never depends on it).
It is derived by the **enrichment** pass at ingest, reading the transcript
**in place at the session's stored `transcript_path`** — never copied (law;
no transcript column exists, v1). Recording-pass findings 6/R5 fix its
shape.

**Two layers, stored separately, both `NULL = ABSENT`:**

1. **Token counts — parsed exactly.** Usage rides `type:"assistant"` lines
   at `.message.usage`; **multiple assistant lines repeat one request's
   usage under a shared `requestId`** (finding 6: a naive summer
   over-counts ~2.4×). The parse rule is **dedup by `requestId`, take usage
   once per request, sum across requests** — validated to the token against
   the envelope oracles. The four token classes are stored as four columns
   (`tokens_input`, `tokens_output`, `tokens_cache_read`,
   `tokens_cache_creation`) because the price table rates each class
   differently. Per-request rows are **not** materialized — no access
   pattern needs them; the sum is the facet (v1 discipline: don't
   materialize what nothing queries).

2. **`cost_usd` — computed, labeled derived.** No dollar figure exists
   anywhere in the transcript (finding 6, exhaustive search); dollars are
   invoker-side only. `cost_usd` is computed from a **pinned per-model price
   table** — a **code constant, not schema** (a new fragile-dependency
   register entry) — as the sum over the four token classes × their
   per-class rate for `model`. Acceptance ground truth: the computation must
   reproduce each oracle's `total_cost_usd` to the digit
   (`0.555957` / `0.438619` / `0.674005`).

**Why tokens and cost are stored separately (expensive to reverse — see
close):** it makes the degradation states *representable and recoverable*:

| state | tokens_* | cost_usd | model | absences row |
|---|---|---|---|---|
| enriched, model pinned | present | present | present | none |
| model **unpinned** | present | **NULL** | present | `cost` / `model unpinned: <model>` |
| transcript **missing** | NULL | NULL | NULL | `cost` / `transcript unavailable` |
| transcript **drifted** (parse failed) | NULL | NULL | NULL | `cost` / `transcript shape unrecognized` |

"tokens present, cost absent" (R5/finding 6) is only expressible because
tokens are not folded into cost. And because tokens are re-parsed and cost
re-computed from the transcript-at-path on every ingest, **a price-table
fix + delete-ledger + re-ingest retroactively regains cost** (R6, drift is
recoverable) — the spool and the transcript are ground truth; the ledger
carries no cost state they cannot reconstruct.

`model` is stored (price-table key + `show`/`log` display). `cc_version`
(transcript top-level `version`, finding 6) is stored so **doctor reports
the per-session recorded CC version** (R8) as free drift context; `NULL`
when the transcript is unreadable. Both `NULL = ABSENT`.

---

## Surface 2c — test-results (the vitest parser facet, R4)

Test-output parsing sits behind the pure ingest-side **parser** interface
`parse(command, stdout, stderr, exit) -> TestResults | null` (Contracts); v1
ships exactly one (vitest). Parsers never run on the hot path and never see
the transcript. The parser reads from the **verbatim `events.payload`** —
both input paths (finding 7): a passing run in
`tool_response.stdout` (plain text, no ANSI) and a failing run embedded in
`PostToolUseFailure.error` after `"Exit code 1\n\n"` (that event carries no
`tool_response`). No new raw storage is needed — `test_results` is a pure
derivation over stored events, so it rebuilds (R4 rebuild-equivalence) by
re-running the parser over the same `payload`.

**Dedicated table, not a JSON column on sessions**, because the facet is
per-command-event (each vitest run is one command), keyed by the command
event's `line_no` (identity → rebuild-equivalence). `failed_names` is a
**JSON array text column, not a child table**: it is set-valued but only
ever read whole to render `show`'s badge lines — there is no query *by*
test name and no cross-event dedup — so a child table would materialize
structure nothing queries (v1 discipline; contrast footprint, which R10/R11
count and list).

**The degradation law is encoded as row membership** (the footprint
pattern), which is exactly what R4 demands — "a command no parser claims
records no test-results facet, distinguishable from a vitest run reporting
zero tests":

- **no row** = no parser claimed the command (facet absent — the command
  is not a test run). This is the common case and it writes **nothing** —
  no absences row either (a non-test command is not a degraded facet).
- **row with `passed=failed=skipped=0`** = a parser claimed it and the run
  reported zero tests (a real zero).

These are distinguishable by presence, never conflated. `duration_ms = NULL`
is a further ABSENT (parser claimed but could not extract duration),
distinct from `0`. `failed_names = '[]'` is a real empty set (parser knows
the failures exactly), never `NULL`.

Render (R12): `show` reads `test_results WHERE session_id = ?`
(`idx_test_results_session`) and renders pass/fail/skip + failed names +
duration as badge lines; the absent case (no row) renders the explicit
absent marker.

---

## Surface 2d — the backgrounded-outcome join (R14)

R14 resolves what v1 left final: v1's command **outcome** is a derived
three-state (success / failure / ABSENT-when-backgrounded), and v1 declared
the backgrounded case ABSENT-final. Finding 8 shows the outcome **is**
recoverable via a same-session join, so v2 **extends the third state to
resolve** — without storing an outcome column and **without mutating the
spool** (the resolution is a derivation, never a write-back).

The mechanism honors v1's "outcome is derived, not stored" by promoting
only the **join key**, exactly as v1 promotes `agent_id` et al. for joins:
the new `events.background_task_id` column is populated from **two payload
locations**, normalized:

- on the backgrounding `PostToolUse`: `tool_response.backgroundTaskId`;
- on a later `PostToolUse(TaskOutput)`: `tool_input.task_id`.

`NULL` on every other event (absent). The outcome derivation then resolves
a backgrounded command by joining within the session
(`e2.background_task_id = e1.background_task_id`, `e2` a TaskOutput) and
reading the matched event's verbatim `tool_response.task.exitCode`:

- TaskOutput found, `exitCode = 0` → **success**;
- TaskOutput found, `exitCode ≠ 0` → **failure**;
- **no** TaskOutput (no poll before session end, or SIGKILL) → **ABSENT**,
  honestly (v1's final case survives for the unpolled tail — no poll, no
  join, no guess).

This is a `show`-time in-memory join over the session's already-loaded
events (no materialization: `log`'s v2 columns are cost + checks, not
per-command outcome, so nothing needs a stored resolved outcome). Because
it is pure derivation over the verbatim spool, it rebuilds identically. The
spool is never mutated — the resolution lives only in the projection.

---

## Surface 2e — the absence-reasons projection (the drift detector, R7)

Whenever the enrichment/drift pass degrades a **session-level single-slot
facet** to ABSENT, it records `(session_id, facet, reason)`. Grain is
per-session × facet (`PRIMARY KEY (session_id, facet)`) — one expected slot
per facet per session — which is exactly what `doctor` enumerates ("every
facet currently ABSENT with its reason," R8). It is a derived projection,
recomputed each ingest and **rebuildable from the spool + transcripts** (R7
last clause) like footprint and status.

**Which facets participate, and why not all of them.** Only facets that
have a single expected slot per session *and* degrade with a distinguishing
reason belong here:

| facet | reason strings (enumerated from the fragile-dependency register) |
|---|---|
| `cost` | `transcript unavailable` · `transcript shape unrecognized` · `model unpinned: <model>` |
| `kind` | `no SessionStart captured` · `model absent, contradicted by end-reason` |

Deliberately **excluded** (their ABSENT is already encoded structurally, so
duplicating it here would be redundant and noisy):

- **command outcome** — the v1 three-state is a payload signature / the
  Surface 2d join; doctor reads it from there, and a non-backgrounded
  command has no absence to report.
- **test-results** — encoded as row membership (Surface 2c); a non-test
  command is not a degraded facet and must not emit an absence per command
  (that would flood the table).
- **sha_before / sha_after / worktree_path** — v1 nullable columns whose
  NULL is self-describing; no reason beyond "boundary line absent," which
  the column already says.

**The `kind` reconciliation (a v2 sharpening, flagged for the operator).**
R7 requires that a hand-authored stream with `model` stripped from
SessionStart yield `kind` ABSENT plus an absence record. Taken alone,
"`model` absent → ABSENT" would *contradict* v1 finding 3's fixture-verified
"`model` absent → headless" and regress every genuine headless session to
ABSENT — which I will not silently do. The reconciliation that satisfies R7
**without** that regression uses the second signal v1 recorded but did not
consume (finding 4: a clean interactive `/exit` yields SessionEnd
`reason:"prompt_input_exit"`; headless clean completion yields `other`):

- SessionStart present with `model` → `interactive` (v1, unchanged);
- SessionStart present without `model`, **consistent** end-signal
  (`reason:"other"` / no interactive marker) → `headless` (v1, unchanged —
  real headless);
- SessionStart present without `model`, **contradicted** by an interactive
  end-reason (`prompt_input_exit`) → `kind` ABSENT + absence
  `model absent, contradicted by end-reason` (R7's stripped-model case);
- **no** SessionStart line at all → `kind` ABSENT + absence
  `no SessionStart captured`.

The classification rule is v1's, preserved; the drift detector only adds
the ABSENT-plus-reason on the two genuinely-unknowable cases. **This is the
one place v2 touches a v1 facet rule — the exact drift predicate is ingest
logic the drift-detector issue finalizes against the fixtures, and I am
flagging it for operator confirmation** (accept finding-4 corroboration, or
rule that R7's stripped stream is the no-SessionStart case). The schema is
agnostic to that choice: it stores whatever `(facet, reason)` ingest emits.

---

## The degradation law as a schema convention (v2 extension)

The v1 law is unchanged and applies to every new column: **`NULL` means
ABSENT; ABSENT is always distinct from empty, zero, and success; the ledger
never fabricates.** New encodings introduced above, for the reviewer's
checklist:

- **Nullable columns, `NULL = ABSENT`:** the five cost/token columns,
  `model`, `cc_version` (Surface 2b); `test_results.duration_ms`
  (Surface 2c); `events.background_task_id` (absent = not a
  backgrounding/TaskOutput event).
- **Row membership as ABSENT vs zero:** `test_results` presence
  (Surface 2c) — no row = facet absent, zero-count row = real zero.
- **Reason-carrying ABSENT:** the `absences` table (Surface 2e) — ABSENT is
  named, not merely NULL, for `cost` and `kind`.
- **Honest-N/A NULL:** `checks.session_id` / `bound_by` = standalone
  binding "by rule," the v1 `worktree_path` shape.
- **Structural three-state, now resolvable:** command outcome (Surface 2d)
  — success / failure / ABSENT (unpolled backgrounded), never collapsed.

Render (R12) prints an explicit absent marker for every ABSENT —
cost-absent and test-results-absent are the asserted cases — distinguishable
from empty/zero/success, extending the v1 pattern.

---

## Ingest algorithm additions

The v1 single-transaction, HWM-cursored, `line_no`-anchored algorithm is
unchanged in shape. Three additions:

1. **Line routing (step 3).** After a successful `v: 1` parse, discriminate
   `event` vs `check` (Surface 1). A `check` line → upsert `checks`
   (`ON CONFLICT(line_no) DO NOTHING`), projecting `session_id`/`bound_by`
   verbatim. An `event` line → the v1 path, additionally promoting
   `background_task_id` (Surface 2d).
2. **Derived-projection recompute (step 5).** Alongside footprint + status,
   recompute the v2 per-session projections for touched sessions:
   `test_results` (re-run the parser over each command event's payload),
   the outcome join key coverage, and — the **enrichment** sub-pass — read
   each session's transcript-at-path, dedup-by-`requestId`, sum tokens,
   compute `cost_usd`, populate `model`/`cc_version`, and emit `absences`
   rows for every facet degraded to ABSENT (cost, kind). All are `UPDATE`/
   idempotent `INSERT` keyed on stable identities, so re-run changes no row
   counts (v1 R6 idempotency holds). Enrichment is fail-soft: a missing or
   drifted transcript degrades that session's cost facet and ingest
   **completes normally** (R6).
3. **Rebuild-equivalence (R2/R4/R6/R7).** Every v2 projection is keyed on a
   spool `line_no` or on `session_id`, and derives purely from the verbatim
   spool + the transcript-at-path — so delete-ledger + re-ingest rebuilds
   equivalent `checks`, `test_results`, `absences`, tokens/cost, and outcome
   resolution. No v2 table holds ground truth the spool/transcript cannot
   regenerate.

---

## Indexes (justified only by named access patterns)

New in v2, each tied to a named access pattern; no speculative index:

- **`checks.line_no` PRIMARY KEY** — ingest dedupe (`ON CONFLICT`) +
  identity.
- **`test_results.line_no` PRIMARY KEY** — ingest dedupe + identity.
- **`absences (session_id, facet)` PRIMARY KEY** — doctor's per-session
  facet enumeration (R8) and the one-slot upsert.
- **`idx_checks_session ON checks(session_id)`** — R12 `log` checks column
  and `show` check badges (`WHERE session_id = ?`; NULLs serve the
  standalone query too).
- **`idx_test_results_session ON test_results(session_id)`** — R12 `show`
  test badges (`WHERE session_id = ?`).

Explicitly **not** added: `events(background_task_id)` — the Surface 2d
join is an in-memory pass over a single session's already-loaded events at
`show` time, not a cross-session lookup; if profiling ever shows it slow,
this is the first lever, deferred not speculative (the v1 `tool_name`
stance). No index on the cost/token columns — no requirement filters or
sorts by them.

---

## Surface G — global operator state (append-only fold log)

A **fourth global artifact** at `~/.coreartifact/` (proposed
`~/.coreartifact/state.jsonl`; exact filename owned by the init slice),
holding install id, consent, and last-ping time. It is the **same
append-and-fold pattern as the registry** (v1 Surface 3), for the same
reason the registry was rewritten 2026-07-14: **no read-modify-write
anywhere** — that was the only RMW in the system and the only source of
concurrency bugs, and it is not reintroduced (PRD Contracts, explicit).

```
{"v":1,"op":"install","install_id":"<id>","at":"<iso8601>"}
{"v":1,"op":"consent","ping":true,"at":"<iso8601>"}
{"v":1,"op":"ping","at":"<iso8601>"}
```

- **Every state change is one atomic `O_APPEND` of one line.** No read, no
  lock, no RMW. `install` is appended once at first init on the machine;
  `consent` once when the opt-in question is answered (R10); `ping` once per
  actual send (R11).
- **`readState` folds the log into `{install_id, consent, last_ping_at}`**
  and is **total**: a corrupt/truncated line is skipped and counted, never
  thrown (a damaged state file must never take down every CLI command); a
  missing file folds to the empty state. Fold rules:
  - `install_id` = the **first** `install` op's id (first-wins — the
    install id is generated once and must be stable; it is the *only* value
    that ever leaves the machine, in the ping, so it never silently
    changes).
  - `consent` = the **last** `consent` op's `ping` (last-write-wins for a
    mutable setting). **Default when no `consent` op has ever been recorded
    = `false`** — silence folds to "no," never to a flattering "yes" (the
    degradation law applied to consent: never ping without a positive
    record).
  - `last_ping_at` = the **latest** `ping` op's `at`.
- **Idempotence is a property of the fold, not the write** (v1 registry
  ruling). Compaction is a v1.1 concern; the file grows only on rare state
  changes.
- **`v: 1`** — a durable, per-line version contract (the registry's
  discipline), so the format evolves without a migration.

Behavioral wiring the schema serves (not schema, but shape-constraining):

- **R10 consent asked once.** First init: TTY → ask (default no); no TTY →
  record `false` without hanging (the fleet lane never blocks). Either way
  `install` + `consent` are appended once; subsequent inits in other repos
  read the folded state, see an install id present, and **do not re-ask**.
- **R11 ping.** `readState` → if `consent` and `now − last_ping_at >
  PING_INTERVAL` (the named weekly constant): append a `ping` line **at the
  moment the send is attempted**, then fire-and-forget one POST (version +
  install id, exactly — a law-level payload wall). Recording the `ping` at
  attempt-time (not on success) is deliberate: it closes the weekly gate
  regardless of delivery, so a second invocation inside the interval sends
  nothing (R11) and an unreachable endpoint never spam-retries. The ping
  rides only the CLI entry, never the hook artifact.
- **Uninstall never touches Surface G** (PRD Contracts; R9). Per-repo
  uninstall folds the *repo* out of the **registry** (v1 Surface 3's
  `op:"remove"` tombstone — append-only stays append-only) and removes the
  repo's own artifacts; global install id and consent are machine-scoped
  and survive.

---

## schema_version and the versioning stance (v2)

`meta.schema_version = 2`. Per v1: the ledger is a **disposable
projection**, so this bump is a **rebuild trigger** — an ingest opening a
`schema_version < 2` (or mismatched) ledger deletes-and-reingests from the
spool rather than `ALTER`-ing. **No migration tier, this campaign or any
other** (PRD Contracts). The durable, non-regenerable version contracts —
spool envelope `v`, registry `v`, operator-state `v` — all stay `1` and
gain only additive variants (the check line under the spool `v`;
`op:"install"|"consent"|"ping"` under the operator-state `v`). Those are
the real forward-compatibility surfaces; `meta.schema_version` remains a
rebuild flag, not a data-migration script.

---

## The three schema decisions most expensive to reverse (v2)

These extend, and do not displace, v1's three (line-no identity;
disposable-projection/verbatim-spool; structural degradation law) — all of
which v2 leans on entirely.

1. **Check binding is CAPTURED at check time and frozen in the spool line
   — ingest projects it verbatim, never re-resolves it.** Every check row's
   `session_id`/`bound_by` is decided once against the then-current open set
   and written into the ground-truth spool. Reversing this — making ingest
   resolve binding against the ledger's *current* state — would break R2
   (delete-and-reingest against a differently-populated ledger would bind
   differently, so rebuilt rows would not be equivalent) and make the same
   spool yield different evidence on different days. It is chosen now
   because the binding is a point-in-time judgement, and only the spool can
   freeze a point in time; the ledger is disposable.

2. **The cost facet stores exact token counts SEPARATELY from a computed
   `cost_usd`, with the price table living as a code constant outside the
   ledger.** This is what makes the two irreversible-if-lost properties
   hold: "tokens present, cost absent" (unpinned model) is *expressible*,
   and a price-table fix + re-ingest *retroactively regains* cost from the
   transcript-at-path. Collapsing them — storing only `cost_usd`, or baking
   the price into a stored dollar figure with no token columns — would make
   an unpinned model indistinguishable from a missing transcript, and would
   freeze yesterday's prices into the ledger where a re-ingest could never
   correct them. The transcript is ground truth; the ledger must keep only
   what re-derives from it.

3. **Every v2 facet — checks, test-results, absences, cost/tokens, the
   backgrounded-outcome resolution — is a pure projection keyed on a spool
   `line_no` or `session_id`, deriving solely from the verbatim spool plus
   the transcript-at-path; the ledger accretes zero new ground truth.** This
   is v1's disposable-projection decision defended at its hardest test:
   checks arrive from the CLI and cost from the transcript, both of which
   *feel* external and tempt a "just store the authoritative value" shortcut
   (a re-resolved binding, a copied transcript, a stored outcome the spool
   can't rebuild). The moment any v2 table holds state the spool +
   transcript cannot regenerate, "delete and re-ingest rebuilds equivalent
   rows" (R2/R4/R6/R7) dies for the whole model and schema evolution can no
   longer be drop-and-reingest. Holding this line is why v2 needs no
   migration tier — and it is a one-way door if crossed.

> **Ruling (2026-07-16, operator lane):** the finding-4 corroboration in
> Surface 2e is ACCEPTED — v1 classification preserved, demote-only
> contradiction detection, the two enumerated `kind` absence reasons stand.
> PRD Amendment 2 records the corrected R7 fixture case.
