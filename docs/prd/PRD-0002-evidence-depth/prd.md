# PRD-0002 — evidence depth

budget_usd: 150

Compiled 2026-07-15 from `spec-v1.md` (binding record incl. the
Compatibility stance and the fragile-dependency register), the PRD-0001
retro (one contract per issue; operator-lane work satisfied before
dispatch), and the PRD grill of 2026-07-15 (four rulings — see Grill
record). Reader: the aeh decomposer. Vocabulary: `CONTEXT.md`.

## Problem

The skeleton records what ran, but the evidence is shallow: no cost, no
parsed test results, no checks, and drift degrades facets silently — a
facet goes ABSENT and nothing names why, which is the product's own
thesis violated on itself. There is also no way out: init exists,
uninstall does not.

## Solution

Deepen the facets on the existing spine without touching the hot path.
Checks become spool-borne evidence badges; vitest output gains one deep
parser behind a pluggable interface; cost/tokens arrive as the fail-soft
transcript-derived facet the spec pinned; ingest gains a drift detector
that records *why* every ABSENT facet is absent; `doctor` reports the
running version, the tested range, and every degradation with its
reason; `uninstall` removes everything init added, byte-identically; and
init asks the one consent question, wiring the opt-in weekly ping. The
hook artifact does not change by one byte.

## Requirements

Each criterion below is the acceptance test's phrasing. All run at the
single seam in Testing decisions unless marked *unit*. All are deltas —
none holds against today's tree.

- **R1 Check runs and records.** `coreartifact check <name> -- <cmd>`
  runs the command, appends exactly one check line to the spool (never a
  direct ledger write), and exits with the wrapped command's exit code.
  After ingest: a check row with name, command, pass/fail, and captured
  output (truncated at a named cap with a truncation flag when
  exceeded). A failing command records a failing check; the check itself
  still records (recording is not conditional on success).
- **R2 Checks survive rebuild.** Deleting the ledger and re-ingesting
  rebuilds check rows equivalent to the originals — checks are spool
  ground truth, the ledger stays a pure projection.
- **R3 Check binding (single-open-session rule).** At check time with
  exactly one `open` session in the repo's ledger, the check binds to
  it; with zero or several open, it records standalone (session NULL —
  never a guess); `--session <id>` always wins; an unknown `--session`
  id exits nonzero naming the id. The resolved binding and which rule
  produced it are recorded in the spool line itself.
- **R4 Parser interface, vitest first.** Test-output parsing sits behind
  a pluggable interface at ingest (never in the hook artifact); exactly
  one parser ships. For a session whose recorded stream contains a real
  vitest run: the session gains a test-results facet with pass/fail/skip
  counts, failed test names, and duration, rendered in `show`. A command
  no parser claims records no test-results facet — distinguishable from
  a vitest run reporting zero tests (*degradation law*).
- **R5 Cost enrichment, fail-soft.** After ingest of a stream whose
  paired transcript fixture is present at the session's transcript
  path: the session carries cost and token counts matching the fixture's
  known values, rendered with a derived marker in `log` and `show`.
  Transcripts are read in place, never copied (law).
- **R6 Cost degradation is explicit.** A missing transcript file →
  cost ABSENT with reason "transcript unavailable". A hand-authored
  drifted transcript (shape outside the pinned parse) → cost ABSENT with
  a reason naming the mismatch — never zero, never estimated — and
  ingest completes normally. Deleting the ledger and re-ingesting after
  the transcript appears retroactively regains the facet (drift is
  recoverable, not lossy).
- **R7 Drift detector.** Whenever ingest degrades a facet to ABSENT, it
  records an absence reason naming the facet and the missing/mismatched
  source (the fragile-dependency register is the enumeration). Replaying
  a hand-authored stream with `model` stripped from SessionStart yields
  kind ABSENT plus an absence record naming the missing key. Absence
  records survive ledger rebuild (derived from the spool).
- **R8 Doctor.** `coreartifact doctor` (read-only) reports: the running
  Claude Code version (obtained by executing `claude --version`;
  rendered ABSENT when the binary is unavailable — asserted with a
  controlled PATH), the tested version range (named constant, the
  README's stamp), every facet currently ABSENT with its reason, and any
  worktree missing the settings file. Exit 0 when nothing degrades;
  nonzero, naming each finding, when anything does.
- **R9 Uninstall.** After init → captured session → `uninstall --yes`:
  the repo tree is byte-identical to its pre-init snapshot (hook config
  entries, artifact, spool, ledger, gitignore line, and propagated
  worktree copies all gone); a pre-existing settings file keeps its
  unrelated user keys; the registry folds the repo out (a remove op is
  appended — the log is never rewritten) and `log` no longer lists it.
  Without `--yes` on a TTY, uninstall names what will be deleted and
  requires confirmation.
- **R10 Consent, asked once.** First `init` on the machine asks the one
  opt-in question (anonymous weekly ping, version + install id), default
  no; the answer and a generated install id persist globally;
  subsequent inits in other repos do not re-ask. Non-interactive init
  (no TTY) records "no" without hanging — the fleet lane never blocks
  on a prompt.
- **R11 Ping, opt-in and inert.** With consent off: zero network
  attempts across all CLI commands (asserted through the injected
  transport — silence is the test). With consent on and the last ping
  older than the named weekly interval: exactly one POST to the pinned
  endpoint constant whose payload contains exactly two fields, version
  and install id — nothing else ever (law). A second invocation inside
  the interval sends nothing. A failing/unreachable endpoint changes no
  command's output or exit code (fire-and-forget). The ping rides only
  the CLI entry — never the hook artifact.
- **R12 Render.** `log` gains derived-marked cost and a checks column;
  `show` heads the timeline with cost (derived marker) and renders
  checks and test results as badge lines. Absent renders with the
  explicit absent marker, asserted for cost-absent and
  test-results-absent (the R12/PRD-0001 pattern extended).
- **R13 Fixtures (recording pass PRD-0002).** Committed before
  dispatch, **operator-assisted**: transcript fixtures paired to at
  least one headless and the interactive stream, with known cost/usage
  values noted in the manifest; a vitest-run session stream; the
  backgrounded-command completion probe (does any later event carry the
  eventual outcome? finding recorded either way); `claude --version`
  output shape. Each stamped with the Claude Code version, protocol
  appended to `docs/recording-pass.md`.

## Contracts (shapes, not paths — final columns owned by the schema.md pass)

**Flag: this PRD adds persistent data on three surfaces — the
data-architect schema.md co-authoring pass runs before decompose.**

Check line (a second envelope variant; the spool stays the only write
path into evidence):

```
{ v: 1, ts: <iso8601>,
  check: { name, argv, exit, output, truncated: <bool>,
           session_id: <id | null>, bound_by: "single-open" | "explicit" | null } }
```

Ledger additions: a checks projection; an absence-reasons projection
(facet, reason, per session); cost/token columns on sessions — all
nullable, all rebuildable. **Schema evolution rule:** the ledger is a
disposable projection — a `schema_version` bump means delete-and-reingest
at next read, never an ALTER migration. There is no migration tier in
this campaign or any other.

Parser interface (pure, ingest-side):

```
parse(command, stdout, stderr, exit) -> TestResults | null
```

`null` means "not mine / unparsable" and the facet stays absent;
parsers never run on the hot path and never see the transcript.

Global operator state (`~/.coreartifact/`): install id, consent, and
last-ping time live in an **append-only fold log**, same pattern as the
registry — one atomic O_APPEND per state change, folded on read, no
read-modify-write anywhere (the registry amendment deleted that bug
class; do not reintroduce it). Per-repo uninstall never touches global
state.

Ping transport: an injectable sender owned by the CLI layer; the
endpoint is one pinned constant (coreartifact.com host — deployment of
the receiver is an operator launch act, added to the spec's launch
acts). Payload: version + install id, exactly.

Invariants (reviewer prose, not criteria — a faithful test would be
green today or asserts a preserved default): the hook artifact is
byte-unchanged this campaign; capture still parses nothing; evidence
facets (commands, checks, footprint, shas) ride only the hooks surface —
cost is the sole transcript-derived facet and the trust spine never
depends on it; transcripts are referenced by path, never copied; nothing
leaves the machine except the consented ping; the spool is never mutated
by ingest; PRD-0001's twelve criteria stay green.

## Testing decisions

- **One seam, unchanged.** Acceptance tests copy the
  `tests/acceptance/harness/` factory **verbatim** (PRD-0001 prior art,
  by path) and drive the built CLI as a subprocess in tmpdir repos with
  fixture replay. Real filesystem, real git, zero mocks at the seam.
- **One sanctioned replay substitution.** For cost tests the replayer
  rewrites `transcript_path` in the delivered payload to the tmpdir copy
  of the paired transcript fixture — mirroring what Claude Code does on
  a real machine. Committed fixture files stay byte-verbatim; the
  substitution lives in the replayer, never in the fixture.
- **Network never happens in tests.** The sandbox has no network and the
  law forbids it anyway: the ping sender is injected, and acceptance
  asserts through a recording sink — including asserting *zero* sends in
  the consent-off path. No test performs real network I/O.
- **`claude --version` is faked at the seam.** The harness's allowlist
  env controls PATH; the present-case uses a shim executable emitting
  the recorded output shape (R13), the absent-case an empty PATH entry.
- **Shared-surface flag.** Ingest and the ledger schema module are
  touched by checks, cost, and the drift detector; render by R1/R4/R5/
  R12 — a later slice's addition breaks an earlier slice's green tests;
  the decomposer routes those amendments explicitly. The fixture
  manifest gains transcript pairs: regenerating the manifest is its own
  routed change, never a drive-by.
- **Unit tests** below the seam only for pure logic: the vitest parser
  over captured outputs, check-envelope parse/serialize, the global
  state fold.
- **Gates** per stack profile: `pnpm run typecheck` / `test` / `build`.

## Non-goals (adjacent — looks in-scope, is not)

- No second parser (pytest is v1.1, gated on demand); no parser
  registry/config — the interface is pluggable, the set is hardcoded.
- No dashboard rendering of any new facet (PRD-0003 designs against the
  by-then-real ledger).
- No consent-management command; changing your mind is a documented
  file edit until a user asks (that ask is the re-entry condition).
- No ping payload growth of any kind — no usage metrics, no repo names,
  no timestamps beyond the send itself. Version + install id is a wall.
- No doctor auto-fix; it reports, the operator acts. No `coreartifact
  record` (v1.1 gate stands).
- No CI/check-gating features — the check exit code composes in scripts,
  and that is all v1 offers.
- No reaction to backgrounded-command completion unless R13's probe
  observes a carrying event (escalation pre-authorized below).
- No spool rotation, still (append forever).
- No cost estimation, interpolation, or "approximate" rendering — ABSENT
  or exact, nothing between.

## Out of scope (spec-level walls)

Orchestration or dispatch, code review features, multi-vendor adapters,
CI enforcement, evals, team/sync/hosted anything, pricing, desktop app,
Windows-native support (WSL best-effort).

## Open risks

1. **Transcript schema is unknown in detail until R13 records it** —
   whether usage rides per-message lines or totals, and whether a
   version field exists. The parser design finalizes on the fixtures;
   if the shape forces summing rather than reading a total, that is a
   parser detail, pre-authorized, not a re-grill.
2. **Backgrounded-command probe may flip outcome-absent** — if a later
   event carries the eventual outcome, a small facet amendment lands by
   escalation (the PRD-0001 R9 pattern); otherwise outcome-absent is
   final for v1.
3. **`claude --version` availability/shape** — ABSENT fallback stands
   regardless of what R13 finds; worst case doctor simply cannot name
   the running version on machines where `claude` is not on PATH.
4. **The ping endpoint does not exist yet** — client ships first by
   design (fire-and-forget fails silent); the receiver is a launch act.
   Residual: a wrong pinned URL is correctable any time before launch.
5. **Single-open-session binding under fleets** degrades to standalone
   whenever several sessions are open — accepted; `--session` is the
   fleet path; re-entry if users ask for smarter binding.
6. **Check output cap** — the named constant's size is a schema-pass
   decision; whatever it is, truncation is flagged, never silent.

## Compile sketch (predicted decomposition — hold the decomposer to this)

Contracts tier, **one contract per issue** (PRD-0001 retro): check
envelope + checks projection (**high** — persistent, new spool variant) ·
absence-reasons record (**high** — persistent) · parser interface
(**medium**) · global operator-state fold (**medium-high** — new
persistent global surface, registry pattern). Fixtures tier: recording
pass PRD-0002 (**high, operator-assisted, complete BEFORE dispatch** —
zero DAG edges wait on the keyboard; ISS-0002 lesson). Feature tier:
vitest parser (**medium**) · cost enrichment (**high** — the register's
most brittle entry) · drift detector in ingest (**medium**, shared
surface with cost) · check CLI (**medium**) · doctor (**medium**,
read-only) · uninstall (**high** — mutates user repos, byte-identical
criterion) · consent + ping (**medium** — law-sensitive, injected
transport) · render additions (**low-medium**). No migration tier — the
ledger rebuilds, never migrates.

## Grill record (2026-07-15)

Budget → $150 · telemetry → full ping ships now (consent at init +
weekly send to a pinned endpoint constant; receiver deployment added to
the launch acts, operator-lane) · check binding → single-open-session
rule, `--session` override, standalone otherwise, rule recorded in the
spool line · operator-lane recording (transcripts, vitest stream,
backgrounded probe, `claude --version`) → all recorded before dispatch ·
compile sketch confirmed as above.
