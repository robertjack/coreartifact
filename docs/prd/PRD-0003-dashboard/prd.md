# PRD-0003 — dashboard

budget_usd: 200

Compiled 2026-07-17 from `spec-v1.md` (binding record: read-only
dashboard ruling, registry-union view, vite+react default, degradation
law), the PRD-0001/0002 retros (seam-blindness, operator-lane
prerequisites before dispatch, one contract per issue), the 2026-07-16/17
operator strategy discussion (headline = verified-delegation share, not
spend), and the PRD grill of 2026-07-17 (twelve rulings — see Grill
record). Reader: the aeh decomposer. Vocabulary: `CONTEXT.md` (this PRD
adds four terms: overview, session view, verified/failing/unverified,
drift banner).

## Problem

The ledger is real and deep — sessions, cost, checks, test results,
absence reasons — but the only windows into it are `log` and `show`.
There is no glanceable answer to the question the product exists to
answer: *of the work I delegated, how much came back with proof?* The
spec's done-criterion (`coreartifact open` renders it) is unmet, and the
launch demo has no face.

## Solution

`coreartifact open`: a strictly read-only local dashboard — vite+react
static assets built into the package, served with a JSON GET API by the
CLI's own node:http server, loopback-only. Two views: the **overview**
(the spec's cross-repo union view: the verified-delegation headline,
three computable tiles, the session list, the drift banner) and the
**session view** (facet header, check badges, test results, footprint,
flat timeline, every ABSENT facet with its recorded reason). Every API
read folds new spool lines first — the dashboard is never staler than
the spool. The ledger schema does not change; the hook artifact does not
change by one byte; runtime dependencies stay zero.

## Requirements

Each criterion below is the acceptance test's phrasing. All run at the
HTTP seam in Testing decisions unless marked otherwise. All are deltas —
`open` does not exist today.

- **R1 Open serves.** From any cwd, with registered repos present,
  `coreartifact open --port 0 --no-browser` starts a server bound to a
  loopback address only, prints the bound URL on stdout, and `GET /`
  returns the dashboard shell (200, text/html). Without `--port` the
  named default-port constant is tried; if busy, an ephemeral port is
  bound — the printed URL is authoritative either way. SIGINT/SIGTERM
  shut it down cleanly. Browser auto-open happens only on a TTY and
  never when `--no-browser` is passed. `cart open` behaves identically.
- **R2 The GET wall.** Non-GET/HEAD methods → 405. A path-traversal
  request (`/../…`) never yields content outside the asset root. A
  request whose Host header is not a loopback name → 403 (the
  DNS-rebinding wall — "nothing leaves the machine" applied to HTTP).
  API responses carry `Cache-Control: no-store`. All asserted with raw
  HTTP requests at the seam.
- **R3 Overview endpoint.** Against a seeded repo (headless session A:
  one passing bound check · headless B: a failing bound check ·
  headless C: no checks · interactive D · hand-authored E with kind
  ABSENT): the overview JSON reports delegated_total 3, verified 1
  (A), failing 1 (B), unverified 1 (C), unknown_kind 1 (E), per the
  classification in Contracts. Tiles: spend = the sum of *present*
  cost_usd values plus an explicit count of cost-ABSENT sessions (never
  a silent zero); sessions by kind; failing-bound-checks count. The
  session list is capped at the named latest-N constant and carries the
  true total. A session seeded 8 days old is excluded from every
  windowed figure (the rolling 7-day window is asserted, not assumed).
  A `repo` query param filters to one registered root.
- **R4 Session endpoint.** For a replayed fixture session, the session
  JSON carries: status, kind, shas before/after, cost/tokens labeled
  derived, model, cc_version; check badges; the test-results facet;
  footprint; absences with their recorded reasons; and the flat
  timeline in spool order with `prompt_id`/`agent_id`/`agent_type`/
  `tool_use_id` passed through (the v2 tree view's keys, surfaced not
  interpreted). Absent facets are explicit nulls with their reasons
  alongside — never zeros, never omitted-field ambiguity (null vs
  missing is fixed once, in api.md). An unknown session id → 404 naming
  the id.
- **R5 Freshness and concurrency.** With the server running, appending
  a valid line to a registered spool changes the very next overview and
  session GET — no restart, no poll. A concurrent writer holding the
  ledger during a GET: both complete, no "database is locked" surface
  (the finding-135/ISS-0017 class, not repeated — busy_timeout on every
  read connection).
- **R6 Union and unreadable degradation.** With two registered repos
  and one ledger made unreadable: the overview still serves the healthy
  repo and lists the other as unreadable with a reason — never silently
  skipped, never a crash. An empty registry serves an explicit empty
  overview shape (zero-denominator KPI renders as real zeros, never
  NaN/absent-as-error).
- **R7 Drift banner data.** Replaying a hand-authored stream whose
  enriched session carries a cc_version outside the tested range: the
  overview JSON carries a drift entry naming the session, its version,
  and the range. An all-in-range replay carries no drift entry, and a
  NULL cc_version never triggers one — the banner fires on positive
  evidence only (degradation law), and the server never executes
  `claude` (that is doctor's job; the dashboard reads only the ledger).
- **R8 Zero-footprint reads.** After open + a full browse of both
  views, the repo tree outside `.coreartifact/` is byte-identical to
  before, and the registry log has not grown — the dashboard's only
  write is the sanctioned ingest projection inside `.coreartifact/`.
- **R9 The browser flow** (the one browser-seam criterion; dispatch
  lane per the R10 probe). Against the R3+R7 seeded repo, a headless
  chromium session: loads the printed URL → the overview shows the
  headline "1 of 3" with failing and unknown-kind surfaced and the
  drift banner visible → navigates to session A's view → sees the
  derived-marked cost, a check badge, an ABSENT facet rendered with the
  explicit absent marker and its reason, and timeline rows. A
  screenshot is captured as the evidence artifact.
- **R10 Pre-dispatch acts (operator-lane, complete before dispatch —
  zero DAG edges wait on the keyboard).** (a) The chromium-in-sandbox
  probe: verify headless chromium runs inside a dispatch worker; its
  result fixes R9's lane (dispatched, or operator-lane at the ship gate
  — decided before money). (b) A recording pass on the current Claude
  Code (doctor is already flagging 2.1.212 vs 2.1.208–2.1.211) per
  `docs/recording-pass.md`; tested-range stamp bumped, fixtures
  re-verified. (c) The standing pnpm-in-dispatch-sandbox check. (d) The
  dogfood act: wrap this repo's own gates in `cart check` so the live
  ledger carries bound-check evidence before the demo.

## Contracts (shapes, not paths — final field names owned by the api.md pass)

**Flag: this PRD adds a new interface (the JSON GET API) and a new user
surface (the SPA) — the data-architect co-authors `api.md` and the
ui-prototyper freeze runs, both BEFORE decompose.** No persistent-data
change is permitted: the ledger stays schema v2; a criterion requiring a
schema bump is a compile error in this PRD.

The API (shape sketch; api.md owns the final names, the null-vs-missing
rule, the default-port constant, and the latest-N cap):

```
GET /api/overview[?repo=<root>] -> { window, kpi: {delegated_total, verified,
                                     failing, unverified, unknown_kind},
                                     tiles: {spend_present_usd, cost_absent_count,
                                     sessions_by_kind, failing_checks},
                                     sessions: [latest N] + total,
                                     repos: [{root, ok | unreadable+reason}],
                                     drift: [{session, version, range}] }
GET /api/session/<id>           -> { facets, checks, test_results, footprint,
                                     absences, timeline }
```

The classification (canonical, also entering CONTEXT.md):

```
bound check  := checks row with session_id = this session
verified     := bound ≥ 1 AND failing bound = 0
failing      := failing bound ≥ 1          (failing: exit_code ≠ 0)
unverified   := bound = 0
window       := sessions.started_at within rolling 7 days, local time
KPI universe := kind = 'headless' in window; kind ABSENT excluded from
                the denominator and surfaced as unknown_kind (never
                silently folded into either side)
```

Server: node:http only — runtime dependencies stay zero (react/vite are
devDependencies; assets are built into the package at publish). Every
API read ingests-on-read via the existing ingest module (the same lazy
path `log` uses — no second ingest implementation), touching only the
ledgers the request needs.

Invariants (reviewer prose, not criteria): the hook artifact is
byte-unchanged; capture still parses nothing; the spool is never mutated;
the ledger remains a disposable v2 projection — no ALTER, no migration
tier; `log`/`show` output is unchanged this campaign; transcripts are
never read by the server (enrichment already happened at ingest); the
dashboard performs no action of any kind — the first UI action, when
demand appears, is a CLI invocation per the spec ruling; nothing binds
beyond loopback; uninstall's byte-identical guarantee is untouched (the
dashboard installs nothing into user repos); PRD-0001/0002 criteria stay
green.

## Testing decisions

- **Primary seam: the existing one, extended with HTTP.** Acceptance
  tests copy `tests/acceptance/harness/` **verbatim** (prior art, by
  path), spawn the built CLI (`open --port 0 --no-browser`) as a
  subprocess in tmpdir repos with fixture replay, parse the printed URL,
  and assert raw HTTP/JSON. Real filesystem, real git, real sockets on
  loopback, zero mocks at the seam.
- **Second seam: exactly one browser flow (R9).** Playwright chromium
  driving the real served UI. The browser harness is new seam
  infrastructure owned by ONE issue (the ISS-0003 precedent); every
  other criterion stays off it. Its dispatch lane is fixed by the R10a
  probe before the campaign starts — the fallback (operator-lane at the
  ship gate, tracer precedent) is pre-named, not discovered.
- **Seeding is real-path only.** Check rows are seeded by running the
  real `check` CLI against replayed open sessions (the single-open
  binding rule does the work); kind/cc_version variants are
  hand-authored streams outside the typed manifest (corrupt-line
  precedent). No direct ledger writes from tests — the spool is the
  only way in, in tests as in production.
- **Network never happens** beyond loopback sockets the tests
  themselves open. The browser downloads nothing; chromium is
  preinstalled or the lane moves (R10a).
- **Shared-surface flags for the decomposer:** the SPA scaffold is
  touched by both view issues; the server module by both endpoint
  issues and the open command — route those amendments explicitly (the
  gm-portal green-alone-throws-together class). `pnpm run build` grows
  an SPA build step in the scaffold issue; later issues inherit it,
  never re-wire it.
- **Unit tests** below the seam only for pure logic: the classification
  and window math over a seeded ledger file.
- **Gates** per stack profile: `pnpm run typecheck` / `test` / `build`.

## Non-goals (adjacent — looks in-scope, is not)

- No live updates: no polling, no websockets, no server push. Refresh
  is the refresh. Re-entry: a user asks while watching a live fleet.
- No UI actions of any kind (spec ruling). No auth, no non-loopback
  bind, no remote access — that is the hosted layer, post-gate.
- No session tree view (v2 — the keys are surfaced by R4, nothing
  interprets them) and no avoided-cost meter (v2, banked in the spec
  roadmap; its gate has not fired — HARD wall).
- No charting/visualization library, no theming, no dark-mode toggle —
  the tiles are numbers; taste lives in the frozen prototype variant.
- No search, no filters beyond the `repo` param, no pagination beyond
  the latest-N cap with its honest total.
- No CLI render changes (`log`/`show` untouched); the KPI does not gain
  a CLI rendering this campaign.
- No divergence-rate, cost-per-merged-unit, or time-to-diagnosis tiles
  — the ledger does not carry their inputs. Re-entry: when it does.
- No `open --global` install story, no spool rotation, still.

## Out of scope (spec-level walls)

Orchestration or dispatch, code review features, multi-vendor adapters,
CI enforcement, evals, team/sync/hosted anything, pricing, desktop app,
Windows-native support (WSL best-effort).

## Open risks

1. **The chromium probe may fail** — pre-named fallback: R9 moves to
   the operator lane at the ship gate; dispatch-side coverage stays
   HTTP-seam. Decided by R10a before dispatch, either way.
2. **The 2.1.212 recording pass may drift fixtures** — the maintenance
   loop runs pre-campaign (R10b); acceptance tests go red exactly where
   payloads moved, parsers fix, range stamp bumps. Budgeted ~30 min.
3. **Taste churn after the prototype freeze** — reviews judge against
   the frozen variant by name; a taste disagreement post-freeze is an
   operator amendment, not a review round.
4. **Tiny-N dogfood demo** — the live ledger has one session and zero
   checks today; R10d (gates wrapped in `cart check`) puts real
   bound-check evidence in the headline before anyone sees it.
5. **Per-request ingest cost across many ledgers** — accepted at
   current scale (ingest is incremental; the union is one repo today).
   Re-entry: felt slowness at real registry sizes.
6. **Toolchain churn as devDeps** (vite/react/playwright majors) —
   pinned versions; the zero-runtime-deps wall means users never feel
   it.

## Compile sketch (predicted decomposition — hold the decomposer to this)

Pre-decompose passes: api.md (data-architect co-author) · ui-prototyper
round → frozen variant · R10 operator acts complete.

Contracts tier, one contract per issue: server core — static serving,
bind/port/lifecycle, the GET wall (**high** — new surface, security
prose) · overview endpoint + classification/window query (**high** —
the headline's correctness is the product claim; ABSENT-aware
aggregation is subtle) · session endpoint (**medium**) · browser-seam
harness (**high** — new seam infra, sandbox contingency).

Feature tier: SPA scaffold + build wiring into dist (**medium**, shared
surface) · overview UI — headline, tiles, list, drift banner,
empty/unreadable states (**medium-high**) · session view UI (**medium**)
· `open` command — flags, TTY browser launch, registry union,
ingest-on-read wiring (**medium**) · the R9 browser flow (**medium**,
lane per probe).

Nine issues. No migration tier — no schema change exists in this PRD.

## Grill record (2026-07-17)

Stack → spec default confirmed: vite+react SPA (devDeps only) + JSON
GET API over node:http · KPI → three-way verified/failing/unverified
(evidence present AND green), rolling 7-day local window, kind-ABSENT
excluded from the denominator and surfaced · freshness → ingest on
every API read · views → two (overview + session view) · degradation →
loud: absent markers + reasons + overview drift banner, ledger-derived
only · prototype → one disposable ui-prototyper round before freeze ·
tiles → spend (ABSENT-aware) + sessions-by-kind + failing checks; the
three uncomputable strategy KPIs walled with named re-entry · seams →
HTTP primary + exactly one browser flow · sandbox risk → pre-dispatch
chromium probe with pre-named operator-lane fallback · contract pass →
api.md co-authored before decompose; no schema change permitted ·
compile sketch confirmed as above · budget → $200.
