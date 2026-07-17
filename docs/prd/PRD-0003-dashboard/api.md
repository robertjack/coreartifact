# PRD-0003 — the dashboard JSON GET API contract

The binding shape for `coreartifact open`'s read-only HTTP surface. The
decomposer and every issue treat the field names, status codes, and SQL
semantics below as fixed. This document **adds no persistent data**: the
ledger stays schema v2 (`docs/prd/PRD-0002-evidence-depth/schema.md`),
the spool envelope stays `v: 1`, the hook artifact is byte-unchanged. Every
field named here is derivable from the v2 ledger tables (`meta`, `sessions`,
`events`, `footprint`, `checks`, `test_results`, `absences`) plus the
registry fold and the two code constants this design reuses
(`TESTED_CLAUDE_CODE_RANGE`, the ledger `BUSY_TIMEOUT_MS`). A decision that
would require a schema change is a **contract violation, flagged, never
made** — see *Flags for the operator*.

Vocabulary is `CONTEXT.md`, exactly: **overview**, **session view**,
**verified / failing / unverified**, **drift banner**, **facet**, **ABSENT**,
**bound check**, **ingest**, **registry**, **absence reason**. No synonyms.

The server is `node:http` only; runtime dependencies stay zero (react/vite
are devDependencies, assets are built into the package at publish). Every API
read **ingests-on-read via the existing ingest module** (`src/ingest`, the
same lazy path `log`/`show` use) — never a second ingest implementation. The
server never executes `claude`, never reads a transcript (enrichment already
happened at ingest), never mutates the spool, and performs no action of any
kind. It is a viewer.

---

## Named constants (proposed values — these become published constants)

| constant | value | rationale |
|---|---|---|
| `DASHBOARD_DEFAULT_PORT` | **2278** | "CART" on a phone keypad (2‑2‑7‑8) — memorable, and outside the common dev-server band (3000/5173/8080), so a collision on first `open` is unlikely. Tried first; if busy, an ephemeral port is bound and the **printed URL is authoritative** (R1). |
| `LATEST_SESSIONS_LIMIT` | **50** | The overview session list is capped at the newest 50 in-window sessions; the true in-window total ships alongside so the cap is never silent (R3). 50 fills a first screen without unbounded payloads at real registry sizes (PRD open risk 5). |
| `OVERVIEW_WINDOW_DAYS` | **7** | The rolling window (R3). One place, so a future change is one edit. |
| `READ_BUSY_TIMEOUT_MS` | **5000** | Reuse the ledger's existing `BUSY_TIMEOUT_MS`. Every read connection the API opens sets `PRAGMA busy_timeout = READ_BUSY_TIMEOUT_MS` so a concurrent writer never surfaces "database is locked" (R5, the finding-135/ISS-0017 class). |
| loopback host allowlist | `localhost`, `127.0.0.1`, `[::1]` / `::1` | The only `Host` header host-parts accepted (any `:port` suffix allowed). Everything else → 403 (the DNS-rebinding wall). |

The **timeline is uncapped** (no constant) — see Surface D.

---

## Surface A — transport, methods, security, errors

### Base path and versioning

- `GET /` → the SPA shell (`200`, `text/html; charset=utf-8`).
- `GET /api/overview[?repo=<root>]` → the overview JSON.
- `GET /api/session/<id>` → the session-view JSON.
- Built static assets are served from their content-hashed paths (e.g.
  `/assets/<hashed>.js`) out of the package's built SPA directory.
- Any other non-`/api` path that does **not** resolve to a real asset file
  serves the shell (`200`, SPA client-routing fallback). A path that resolves
  **outside** the asset root (traversal, `/../…`) never yields content — it is
  a `404` (R2). An unknown `/api/*` path is a `404`.

**The path carries no version segment (`/api/`, not `/api/v1/`).** Rationale:
the server and the SPA ship in one package and are always the same version —
there is no independently-deployed client to negotiate skew with, so a version
segment would be ceremony. The durable version contracts live where they
already do (the ledger `schema_version` rebuild trigger, the spool/registry
`v`), not in an HTTP path this campaign invents.

### Methods

`GET` and `HEAD` only. Any other method → **`405`**, with
`Allow: GET, HEAD` (R2).

### The loopback wall

Before routing, the server checks the request's `Host` header. If the
host-part is not in the loopback allowlist above (or `Host` is absent/empty),
the response is **`403`** — the DNS-rebinding wall, "nothing leaves the
machine" applied to HTTP (R2). The socket also binds a loopback address only
(R1); the Host check is the second, independent layer against a rebind to a
name that resolves to loopback.

### HTTP conduct

- **`Cache-Control: no-store`** on every `/api/*` response **and** on the
  shell (the data must never be staler than the spool; a cached shell could
  pin an old asset graph). Content-hashed static assets may carry
  long-lived/immutable caching — they are safe to cache because their URL
  changes when their bytes change.
- API `Content-Type`: `application/json; charset=utf-8`. Bodies are UTF-8.
- The shell: `text/html; charset=utf-8`. Assets: by extension.

### Error body — one shape, everywhere

Every non-2xx the API originates uses exactly:

```json
{ "error": { "code": "<machine_code>", "message": "<human, names the subject>" } }
```

| status | `code` | when | `message` names |
|---|---|---|---|
| `404` | `unknown_session` | `/api/session/<id>` matches no session in the union | the `<id>` |
| `404` | `repo_not_registered` | `?repo=<root>` is not a registered root | the `<root>` |
| `404` | `not_found` | unknown `/api/*` path, or a traversal attempt | the path |
| `405` | `method_not_allowed` | non-GET/HEAD | the method |
| `403` | `forbidden_host` | non-loopback `Host` | — (no reflection of the bad host) |

`403`/`405` bodies stay minimal and reflect nothing attacker-controlled back.

---

## Surface B — two universal rules, decided once

### B1. The null-vs-missing rule (the degradation law in JSON)

Decided once here, applied everywhere in this contract:

1. **Every field this contract names is ALWAYS present** in the response.
   Absence is signalled by the JSON value, never by omitting the key. There is
   no "field missing means absent" — that ambiguity is what R4 forbids.
2. **`null` means ABSENT** (facet source unavailable). ABSENT is never
   rendered as `0`, `""`, `false`, or `[]` — those are real values with their
   own meaning (a real zero cost, an empty prompt, no footprint). This is
   `docs/gotchas.md` #5 as a wire rule.
3. **A `null` that has a recorded absence reason carries it** in the sibling
   `absences` collection, keyed by facet name (Surface D). Not every `null`
   has a reason row — `sha_before`/`sha_after`/`ended_at` are self-describing
   nullables (boundary line absent) and the ledger records no absence for them
   (schema Surface 2e); those are `null` with no `absences` entry, honestly.
4. **Row-membership absence** (the test-results facet) is preserved on the
   wire as an **empty array vs. a present row**, exactly as the ledger encodes
   it: `test_results: []` = no command was ever claimed by a parser (facet
   ABSENT); a row with `passed=failed=skipped=0` = a real zero-test run. These
   stay distinguishable and no field is omitted.

### B2. The derived-labeling rule

The UI must render the **derived marker** (a computed figure, not observed off
the spool — `src/render/absent.ts` `renderCostUsd`) without hardcoding which
facets are derived. So every derived facet carries its own flag as data:

- **`cost`** is `{ "value": <number|null>, "derived": true }`.
- **`tokens`** is `{ "derived": true, "input": <int|null>, "output": <int|null>,
  "cache_read": <int|null>, "cache_creation": <int|null> }` — the four counts
  are all-present or all-`null` together (enrichment is all-or-nothing per
  request; "tokens present, cost absent" is the one split, expressible because
  `cost.value` can be `null` while the token counts are not).

The UI reads `.derived` and renders the marker generically. No other facet
carries `derived`; a consumer must never infer "derived" from a field name.
The overview `tiles.spend_present_usd` is a **derived aggregate** (a sum of
derived `cost_usd`); it is documented as derived and the UI labels the spend
tile as such — it is a constant-derived aggregate, so it needs no per-value
flag.

---

## Surface C — `GET /api/overview[?repo=<root>]`

The cross-repo **overview**: the union of every registered repo's in-window
sessions. The union is performed in application code across each repo's ledger
via `walkRegisteredRepos` (the same helper `log`/`show` use), **not** a
cross-database SQL join — each ledger is a separate SQLite file. `?repo=<root>`
scopes every aggregate below to that one registered root (an unregistered root
→ `404 repo_not_registered`).

### Response shape

```json
{
  "window": {
    "start": "2026-07-10T14:03:07.512-07:00",
    "end":   "2026-07-17T14:03:07.512-07:00",
    "days":  7
  },
  "kpi": {
    "delegated_total": 3,
    "verified":        1,
    "failing":         1,
    "unverified":      1,
    "unknown_kind":    1
  },
  "tiles": {
    "spend_present_usd": 1.668581,
    "cost_absent_count": 1,
    "sessions_by_kind":  { "headless": 3, "interactive": 1, "unknown": 1 },
    "failing_checks":    1
  },
  "sessions": {
    "latest": [
      {
        "session_id":     "<full id>",
        "repo_root":      "/abs/path/repo",
        "kind":           "headless",
        "status":         "closed-clean",
        "started_at":     "2026-07-17T13:00:00.000Z",
        "classification": "verified",
        "cost":           { "value": 0.555957, "derived": true }
      }
    ],
    "total": 5
  },
  "repos": [
    { "root": "/abs/path/repo",   "status": "ok" },
    { "root": "/abs/path/other",  "status": "unreadable",
      "reason": "database disk image is malformed" }
  ],
  "repos_skipped": 0,
  "drift": [
    { "session_id": "<full id>", "version": "2.1.212",
      "range": { "min": "2.1.208", "max": "2.1.211" } }
  ]
}
```

### `window`

- The window is anchored to the **server host's local clock at request time**.
  `end` = the instant of the request; `start` = `end − OVERVIEW_WINDOW_DAYS`
  (a rolling 7×24h span, not a calendar boundary). Both are emitted as ISO-8601
  with the **server's local UTC offset** so a reader sees the operator's
  wall-clock (R3 "local time"). `days` echoes the constant.
- The **SQL predicate** compares against the UTC-normalized (`Z`) instants of
  the same two boundaries — because `sessions.started_at` is stored UTC-`Z`
  ISO-8601 throughout the codebase (`new Date().toISOString()` and the hook
  `ts`), and string comparison is only chronological when both sides share a
  zone. See *SQL semantics* below.

### `kpi` — the verified-delegation headline

The KPI universe is **`kind = 'headless'` sessions in the window**. This is the
product's question ("of the work I *delegated*, how much came back with
proof?") — a delegated session is a headless (agent-run) one. `interactive`
sessions are a human at the keyboard, **not delegation**, and are excluded from
the KPI entirely (they still appear in `tiles.sessions_by_kind` and the session
list). `kind` ABSENT is excluded from the denominator and surfaced separately
as `unknown_kind` — never silently folded into either side (CONTEXT.md,
degradation law).

- `delegated_total` = count of in-window headless sessions.
- `verified` + `failing` + `unverified` partition `delegated_total`
  (each headless session lands in exactly one, per the classification below).
- `unknown_kind` = count of in-window sessions with `kind` ABSENT.

The API returns **counts only** — never a computed ratio. The UI renders "1 of
3" from `verified` / `delegated_total`. This is deliberate: a zero denominator
(empty registry, R6) is just `delegated_total: 0` with real zeros, never a
server-side `NaN`.

### `tiles`

All three tiles are scoped to the **same window**, over **all in-window
sessions regardless of kind** (spend and failing checks are cost/evidence
questions, not delegation questions):

- `spend_present_usd` = sum of **present** (`cost_usd IS NOT NULL`) costs.
  Derived aggregate.
- `cost_absent_count` = count of in-window sessions with `cost_usd` ABSENT.
  **This is the anti-silent-zero guard**: `spend_present_usd: 0` with
  `cost_absent_count: 2` reads as "spend unknown for 2 sessions," never as "$0
  spent." The two figures ship together, always.
- `sessions_by_kind` = `{ headless, interactive, unknown }` — the `unknown`
  bucket is `kind` ABSENT (never omitted; a real zero is `0`).
- `failing_checks` = count of **bound** checks with `exit_code <> 0` belonging
  to in-window sessions. Standalone checks (`session_id IS NULL`) are not bound
  to a session and never counted here.

### `sessions`

- `latest` = the in-window sessions, newest `started_at` first, capped at
  `LATEST_SESSIONS_LIMIT`. The cap is applied to the **merged** cross-repo
  list, after union and re-sort.
- `total` = the true count of in-window sessions across the union (the honest
  total behind the cap — R3).
- Each entry carries only what the list row and its link need. `classification`
  is `verified`/`failing`/`unverified` for headless sessions and **`null`** for
  interactive or unknown-kind sessions (the three-way classification is only
  defined for delegation). `cost` follows the derived-labeling rule.

### `repos` — union and unreadable degradation (R6)

One entry per registered root, **never silently skipped**:

- readable → `{ "root": <root>, "status": "ok" }`.
- unreadable / unreachable → `{ "root": <root>, "status": "unreadable",
  "reason": <reason> }`, where `reason` is the walk's failure reason
  (`walkRegisteredRepos` already produces it — a corrupt ledger, a moved root,
  `.coreartifact/` gone). The healthy repos still serve.
- With `?repo=<root>`, `repos` contains that single entry (its own readability).

`repos_skipped` = the count of corrupt registry lines `readRegistry` folded out
(`FoldedRegistry.skipped`). Surfaced rather than dropped — the same "skipped is
an observable fact, never a silent zero" discipline the registry fold already
holds. An empty registry serves `repos: []`, `repos_skipped: 0`, and all-zero
KPI/tiles (R6).

### `drift` — the drift banner data (R7)

Positive evidence only. An entry appears for each **in-window** session whose
`cc_version` is **non-`null`** and falls **outside** `TESTED_CLAUDE_CODE_RANGE`
(the constant already in `src/doctor/version.ts` — reused, not re-declared).

- `session_id`, `version` (the recorded `cc_version`), `range` (`{min, max}`
  from the constant).
- A `null` `cc_version` **never** produces an entry (degradation law: the
  banner fires on positive evidence, never on absence).
- The server **never executes `claude`** — drift is read from the ledger's
  recorded `cc_version` only (that is doctor's live-probe job, not the
  dashboard's). All kinds are eligible (a hand-authored `kind`-ABSENT stream
  can carry a drifting `cc_version` — R7).

---

## Surface D — `GET /api/session/<id>`

The **session view**: the same evidence `show` derives, structured. `<id>` is
the full `session_id`. Resolution reuses the ingest-on-read + union path
(`resolveSession`): the endpoint ingests each reachable repo, then reads the
matched ledger. Unknown id → `404 unknown_session` naming the id. An optional
`?repo=<root>` scopes resolution to one root (used by the UI's own links, which
carry `repo_root`); see *Flags* for the same-id-in-two-repos case.

### Response shape

```json
{
  "facets": {
    "session_id":    "<full id>",
    "repo_root":     "/abs/path/repo",
    "worktree_path": null,
    "status":        "closed-clean",
    "kind":          "headless",
    "sha_before":    "abc123…",
    "sha_after":     "def456…",
    "model":         "claude-opus-4-8",
    "cc_version":    "2.1.211",
    "cost":          { "value": 0.555957, "derived": true },
    "tokens":        { "derived": true, "input": 1200, "output": 340,
                       "cache_read": 0, "cache_creation": 512 },
    "started_at":    "2026-07-17T13:00:00.000Z",
    "last_event_at": "2026-07-17T13:04:11.900Z",
    "ended_at":      "2026-07-17T13:04:12.000Z"
  },
  "checks": [
    { "name": "typecheck", "exit_code": 0, "passed": true,
      "truncated": false, "bound_by": "single-open" }
  ],
  "test_results": [
    { "line_no": 42, "parser": "vitest", "passed": 12, "failed": 0,
      "skipped": 1, "duration_ms": 3400, "failed_names": [] }
  ],
  "footprint": [ "src/a.ts", "src/b.ts" ],
  "absences": [
    { "facet": "cost", "reason": "model unpinned: some-model" }
  ],
  "timeline": [
    {
      "seq": 1, "ts": "2026-07-17T13:00:00.000Z", "kind": "lifecycle",
      "hook_event_name": "SessionStart",
      "prompt_id": null, "agent_id": null, "agent_type": null, "tool_use_id": null
    },
    {
      "seq": 4, "ts": "2026-07-17T13:02:00.000Z", "kind": "command",
      "command": "pnpm test", "duration_ms": 3400,
      "outcome": { "state": "success" },
      "test_results": { "passed": 12, "failed": 0, "skipped": 1,
                        "duration_ms": 3400, "failed_names": [] },
      "prompt_id": null, "agent_id": null, "agent_type": null,
      "tool_use_id": "toolu_…"
    }
  ]
}
```

### `facets` — the header

- `status` is `NOT NULL` (`open`/`closed-clean`/`closed-inferred`) — never
  `null`.
- `kind` is `headless`/`interactive`/**`null`** (ABSENT). A `null` kind carries
  its reason in `absences` (facet `kind`).
- `sha_before`/`sha_after`/`ended_at` are nullable and self-describing (no
  `absences` row).
- `worktree_path` is `string|null`, self-describing (`null` = the session ran
  in the main checkout; a value = the worktree it ran in, per the attribution
  ruling — a first-class session column, so the session view carries it).
  Added at operator review of this pass.
- `cost`/`tokens` follow the derived-labeling rule (B2). `model`/`cc_version`
  are bare `string|null`; a `null` `cost` may carry an `absences` reason
  (facet `cost`).

### `checks`

One entry per **bound** check for this session (`checks WHERE session_id = ?`,
served by `idx_checks_session`). `passed` is the **derived render of
`exit_code == 0`** — `exit_code` is carried too because it is strictly richer
(a 137/SIGKILL exit reads differently from a 1; schema Surface 2a). Standalone
checks are out of a session's scope and never appear here.

### `test_results`

One entry per parser-claimed command event (`test_results WHERE session_id =
?`, `idx_test_results_session`). **Empty array = the facet is ABSENT** at the
session level (no command was claimed — B1 rule 4). `duration_ms` is
`int|null` (`null` = parser claimed but could not extract it, distinct from
`0`). `failed_names` is a real array (`[]` = a known-empty failure set, never
`null`).

### `footprint`

`string[]` of distinct touched paths (`footprint WHERE session_id = ?`). `[]`
is a real empty set (no files touched), not ABSENT.

### `absences`

`{ facet, reason }` entries verbatim from the `absences` table (`facet ∈
{cost, kind}`, `reason` the enumerated absence-reason string). This is the
collection B1 rule 3 points every explained `null` to.

### `timeline` — flat, spool order, complete

The flat timeline in `seq` order (never a tree — the nesting keys are surfaced,
not interpreted; PRD non-goal). Each entry carries the **structured evidence
`show` already derives**, plus the four nesting keys **passed through
verbatim**: `prompt_id`, `agent_id`, `agent_type`, `tool_use_id` (present on
every entry, `null` where the event has none). Entry `kind`:

- `lifecycle` → `hook_event_name`.
- `prompt` → `prompt` (the `UserPromptSubmit` text; `""` if the payload had
  none — a real empty prompt, not ABSENT).
- `command` → `command` (`string|null`), `duration_ms` (`int|null`),
  `outcome`, and `test_results` (the badge object, or `null` if no parser
  claimed this command). `outcome` is the **three-state facet, resolved
  server-side exactly as `show` resolves it** (`src/facets/outcome.ts`,
  including the backgrounded-outcome same-session join over
  `background_task_id`): `{ "state": "success" }` |
  `{ "state": "failure", "error": "<verbatim>" }` | `{ "state": "absent" }`.
  Never collapsed to two states; a backgrounded command with no resolving
  `TaskOutput` stays `absent`, honestly.
- `subagent` → `hook_event_name` (`SubagentStart`/`SubagentStop`) with the
  `agent_id`/`agent_type` keys (already in the universal four).

**Raw event payloads are NOT carried** — the four nesting keys and the derived
facets above are the interface; the verbatim payload stays in the ledger. The
dashboard is a viewer, not a spool browser.

**The timeline is complete (uncapped).** Rationale: a single session's event
count is bounded by one session's activity, not by unbounded cross-session
growth; `show` already renders the whole timeline; and a cap would break the
"flat timeline in spool order" contract (a truncated middle would misorder the
evidence). Re-entry (deferred, not speculative): if a pathological session ever
makes this slow, add a tail/head cap with an explicit `truncated` flag and an
honest total — the same shape `checks.output` already uses. Not this campaign.

---

## Surface E — freshness, concurrency, zero-write

- **Ingest-on-read (R5).** Every overview/session GET folds new spool lines
  first, through `src/ingest` — the exact lazy path `log`/`show` use, **no
  second ingest implementation**. Appending a valid spool line changes the very
  next GET with no restart and no poll (the dashboard is never staler than the
  spool). There is no server push, no websocket, no timer (PRD non-goal).
- **Concurrency (R5).** Every read connection the API opens sets `PRAGMA
  busy_timeout = READ_BUSY_TIMEOUT_MS` before reading, so a concurrent writer
  holding the ledger during a GET never surfaces "database is locked" — both
  complete. See *Flags*: the shared read path must be made to set this pragma;
  it is not universally set today.
- **Zero-footprint reads (R8).** The server's only write is the sanctioned
  ingest projection inside `.coreartifact/`. It reads no transcript, writes no
  registry line, installs nothing into user repos. After a full browse, the
  repo tree outside `.coreartifact/` is byte-identical and the registry log has
  not grown.

---

## SQL semantics (the exact predicates)

All queries run **per-repo** against that repo's ledger; the overview unions
their results in application code (sum counts, concat + re-sort + cap the
session list). `:window_start` / `:window_end` are the UTC-`Z` ISO-8601 forms
of the window boundaries (Surface C).

**Window predicate** (over `sessions.started_at`, stored UTC-`Z`):

```sql
WHERE started_at >= :window_start   -- (now − 7d), UTC-Z ISO-8601
  AND started_at <= :window_end     -- now, UTC-Z ISO-8601
-- lexicographic compare == chronological because both sides are UTC-Z ISO.
```

**Three-way classification** (join `checks` on `session_id`, headless + window):

```sql
SELECT s.session_id,
       COUNT(c.line_no)                                  AS bound_total,
       SUM(CASE WHEN c.exit_code <> 0 THEN 1 ELSE 0 END) AS bound_failing
FROM sessions s
LEFT JOIN checks c ON c.session_id = s.session_id
WHERE s.kind = 'headless'
  AND s.started_at >= :window_start AND s.started_at <= :window_end
GROUP BY s.session_id;
-- per row:  verified  = bound_total >= 1 AND bound_failing = 0
--           failing    = bound_failing >= 1
--           unverified = bound_total = 0
-- delegated_total = number of rows; the three counts partition it.
```

`unknown_kind`:

```sql
SELECT COUNT(*) FROM sessions
WHERE kind IS NULL
  AND started_at >= :window_start AND started_at <= :window_end;
```

**ABSENT-aware spend** (present-sum + explicit absent count, one pass):

```sql
SELECT COALESCE(SUM(cost_usd), 0)                          AS spend_present_usd,
       SUM(CASE WHEN cost_usd IS NULL THEN 1 ELSE 0 END)   AS cost_absent_count
FROM sessions
WHERE started_at >= :window_start AND started_at <= :window_end;
-- SUM ignores NULLs -> present-only sum; the CASE counts the NULLs separately.
-- spend 0 is only ever a real $0 when cost_absent_count is also 0.
```

`sessions_by_kind` (the `NULL` group maps to the `unknown` bucket) and
`failing_checks`:

```sql
SELECT kind, COUNT(*) FROM sessions
WHERE started_at >= :window_start AND started_at <= :window_end
GROUP BY kind;                       -- NULL row -> "unknown"

SELECT COUNT(*) FROM checks c
JOIN sessions s ON s.session_id = c.session_id
WHERE c.exit_code <> 0
  AND s.started_at >= :window_start AND s.started_at <= :window_end;
```

**Session list** (merged/capped in code after the per-repo query):

```sql
SELECT session_id, repo_root, kind, status, started_at, cost_usd
FROM sessions
WHERE started_at >= :window_start AND started_at <= :window_end
ORDER BY started_at DESC;            -- LIMIT applied to the merged union, not per repo
-- total = COUNT(*) over the same predicate, summed across repos.
```

**Drift predicate** (positive evidence only; range from the doctor constant):

```sql
SELECT session_id, cc_version FROM sessions
WHERE cc_version IS NOT NULL
  AND started_at >= :window_start AND started_at <= :window_end;
-- then, in code, emit an entry iff NOT (min <= cc_version <= max) under
-- semver ordering (parse dotted integers; do NOT string-compare "2.1.9" vs
-- "2.1.10"), min/max = TESTED_CLAUDE_CODE_RANGE. A NULL cc_version is filtered
-- out by the predicate above and never drifts.
```

---

## Invariants (restated; the reviewer's wall)

- **Strictly read-only GET surface.** No endpoint mutates anything but the
  sanctioned ingest projection. The first UI action, when demand appears, is a
  CLI invocation (spec ruling) — not this campaign.
- **Loopback only.** Socket binds loopback (R1); `Host` non-loopback → 403
  (R2). Nothing binds or leaks beyond loopback.
- **Ingest-on-read reuses `src/ingest`.** No second ingest implementation, ever
  (PRD Contracts).
- **Zero runtime dependencies.** `node:http` only; react/vite/playwright are
  devDependencies; assets are built into the package.
- **The server never executes `claude`** and **never reads a transcript** —
  enrichment (`cost`/`tokens`/`model`/`cc_version`) already happened at ingest;
  the API reads the ledger's recorded values only.
- **No schema change.** Every field is derivable from the v2 tables + registry
  + the two reused code constants. The ledger stays a disposable v2 projection;
  no `ALTER`, no migration tier.
- **The API never fabricates an ABSENT value** (B1). Absent is always `null` /
  empty-array / reason-carried, never `0`/`""`/`false`/a plausible guess.
- The hook artifact is byte-unchanged; capture parses nothing; the spool is
  never mutated; `log`/`show` output is unchanged this campaign; uninstall's
  byte-identical guarantee is untouched; PRD-0001/0002 criteria stay green.

---

## Flags for the operator

1. **Read connections must set `busy_timeout`; the shared read path does not
   today (R5).** `walkRegisteredRepos` (`src/resolve-session.ts`) and
   `show`'s read-only connection (`src/cli/commands/show.ts`) open
   `new DatabaseSync(..., { readOnly: true })` **without** a `PRAGMA
   busy_timeout` — only the ingest/`openLedger` write connection sets it. R5
   requires busy_timeout on **every** read connection. The overview/session
   endpoints reuse these read paths, so the contract requires the pragma to be
   set on whatever connection serves a GET. **Recommended resolution:** amend
   the shared `walkRegisteredRepos`/read helper to set `PRAGMA busy_timeout =
   READ_BUSY_TIMEOUT_MS` on open (one place, reused), rather than each endpoint
   duplicating it. This is a shared-surface amendment the decomposer should
   route explicitly (both endpoint issues depend on it). Note: `log`/`show`
   CLI output is frozen this campaign, but adding a busy_timeout pragma to a
   read connection changes no output — it only makes the read wait instead of
   erroring, so it does not violate the "no CLI render changes" wall. Confirm
   the amendment lands in the shared helper.

2. **Same-`session_id`-in-two-repos is a real resolution case the named error
   set does not cover.** The PRD names 404/405/403 only. But `resolveSession`
   has an `ambiguous` result — the test harness itself replays one fixture
   stream into two repos elsewhere, producing an identical `session_id` in two
   ledgers. `GET /api/session/<id>` for such an id is neither "unknown" (404)
   nor a clean hit. **Recommended resolution:** the UI's session links always
   carry `?repo=<root>` (the overview session entries include `repo_root`), so
   the UI never hits ambiguity; a **bare** ambiguous `/api/session/<id>`
   returns `404 unknown_session` with a message stating the id does not
   *uniquely* resolve and naming the candidate roots (the id names no single
   session). If you prefer a distinct status/code (e.g. a `409`/`ambiguous`
   body) surfaced to the UI, rule on it before the session-endpoint issue is
   cut — I have kept the error set to the three the PRD named and folded
   ambiguity into a descriptive 404 rather than invent a fourth status
   unilaterally.

3. **The window predicate assumes `started_at` is UTC-`Z` ISO-8601.** True for
   every code path today (`new Date().toISOString()` and hook `ts`), which is
   why lexicographic `>=`/`<=` is chronological. A **hand-authored fixture
   stream** that injects a `started_at` with a non-`Z` offset (e.g.
   `…-07:00`) would sort incorrectly against the UTC-`Z` boundaries. R3/R7 seed
   via hand-authored streams — please keep their `started_at` values UTC-`Z`
   (the recording pass already emits `Z`), or the window math is silently
   wrong for those rows. Not a schema issue; a fixture-authoring constraint
   worth stating so a seeding issue does not trip on it.

---

## The three API decisions most expensive to reverse

1. **The null-vs-missing rule: every field always present, `null` = ABSENT,
   reasons carried in a sibling collection (B1).** Every endpoint, every
   consumer, and every test encodes this. Reversing it later — letting an
   omitted field mean absent, or letting `0`/`""` stand in for ABSENT — would
   reintroduce exactly the ambiguity R4 forbids and the degradation law bans,
   across every field at once. It is chosen now because it is the one rule that
   makes the whole surface honest, and it must be true before the first issue
   ships or it is true nowhere.

2. **Derived facets self-describe with a `derived` flag as data (B2).** The UI
   renders the derived marker off `.derived`, never off a hardcoded field list.
   Reversing this — hardcoding "cost and tokens are derived" in the UI — would
   couple every consumer to today's derived set, so the day enrichment gains a
   second derived facet, every renderer is wrong until hand-patched. The flag
   travels with the value precisely so the marker never goes stale.

3. **The API adds no persistent data and no HTTP version segment — it is a pure
   read projection of the v2 ledger.** Every field derives from the existing
   tables + registry + two code constants; the path is unversioned because
   server and SPA ship as one artifact. Crossing this — a stored view, a
   materialized aggregate, a `/api/v1` skew surface — would give the dashboard
   ground truth the spool cannot rebuild and a version contract the ledger
   already owns, breaking "delete-and-reingest rebuilds everything" for a
   viewer that had no business holding state. Holding the line is why this PRD
   needs no migration tier.
