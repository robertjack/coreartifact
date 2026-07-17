# CONTEXT.md — canonical vocabulary

One term per concept; PRDs, issue specs, code, and reviews use these words
and no synonyms. Created 2026-07-14 during the PRD-0001 grill.

- **capture** — a hook appending one line to the spool at event time.
  Distinct from **ingest** — reading the spool into the ledger at
  `log`/`open` time. Capture is hot-path and dumb; ingest is lazy and
  smart.
- **spool** — the per-repo append-only JSONL file; ground truth. Never
  mutated by ingest, never rotated (v1).
- **envelope** — the spool line wrapper `{v, ts, event}`; `event` is the
  hook payload verbatim. Boundary lines add `git: {head, dirty}`.
- **boundary events** — SessionStart and SessionEnd; the only lines the
  hook enriches beyond the envelope.
- **ledger** — the per-repo SQLite database; a disposable, rebuildable
  projection of the spool.
- **registry** — the single global **append-only JSONL log** of known ledger
  roots (`~/.coreartifact/registry.jsonl`). `addLedger` is one atomic
  `O_APPEND`; `readRegistry` **folds** the log into the current set, deduping
  by `repo_root` and skipping corrupt lines. No lock, no read-modify-write
  (rewritten 2026-07-14 — the read-modify-write was the only one in the system
  and the only source of concurrency bugs). What `log` unions across repos.
- **facet** — one derived evidence column (shas, footprint, outcome, kind,
  later cost). A facet is ABSENT when its source is unavailable — absent
  is always distinguishable from empty, zero, or success (the degradation
  law).
- **footprint** — the distinct file paths touched via file-editing tool
  events in a session. Bash side-effects on files are not footprint (v1).
- **status** — `open` | `closed-clean` (SessionEnd present) |
  `closed-inferred` (no SessionEnd, last event older than the staleness
  threshold). Recomputed on every ingest.
- **kind** — `headless` | `interactive` | absent. Populated only from a
  fixture-verified discriminating signal, never heuristics.
- **attribution** — resolving a session to its ledger: git common dir →
  main repo root (worktree path recorded); non-git → init root.
- **propagation** — copying the per-repo hook settings file into worktree
  checkouts at init time, so worktree sessions are captured at all; the
  ingest warning names any worktree still missing the file. (The
  WorktreeCreate-hook layer was removed 2026-07-14: WorktreeCreate is a
  delegation hook — a configured hook must create the worktree and return
  its path — so a passive capture subscription breaks agent worktree
  spawns. Worktree-isolated subagents are captured via the parent
  session's hooks regardless.)
- **recording pass** — re-recording real Claude Code payloads as
  version-stamped committed fixtures; the empirical answer to payload
  questions and the input to all acceptance tests.
- **the seam** — the one place acceptance tests exercise the system: the
  CLI as a subprocess in a tmpdir repo, with fixtures replayed through the
  installed hook command. No mocks at the seam.
- **hook artifact** — the self-contained zero-dependency program init
  installs and the hook config points at; always exits 0.
- **agent_id** — the canonical nesting key for subagent events (with
  `agent_type`); there is no `subagent_id`.
- **check** — a named command run recorded as evidence
  (`coreartifact check <name> -- <cmd>`); rides the spool as the second
  envelope variant, projected at ingest like everything else. Bound by
  the single-open-session rule (`--session` overrides; otherwise
  standalone). Added 2026-07-15, PRD-0002 grill.
- **absence reason** — the drift detector's ingest-time record of WHY a
  facet is ABSENT (which source key was missing or mismatched); what
  `doctor` reports. Rebuildable from the spool like any projection.
- **enrichment** — the ingest-time derivation of cost/tokens from the
  transcript at the session's stored path; fail-soft, version-pinned,
  the only transcript-derived facet. Never on the hot path.
- **parser** — a pure ingest-side test-output parser behind the
  pluggable interface (`parse(command, stdout, stderr, exit)`); returns
  null for "not mine", and null means the facet stays absent. v1 ships
  exactly one (vitest).
- **operator state** — the global append-only fold log under
  `~/.coreartifact/` holding install id, consent, and last-ping time;
  same append-and-fold pattern as the registry, no read-modify-write.
  Per-repo uninstall never touches it.
- **overview** — the dashboard's landing view: the cross-repo union the
  spec called the "today" view (this name supersedes it), carrying the
  verified-delegation headline, the tiles, the session list, and the
  drift banner. Added 2026-07-17, PRD-0003 grill.
- **session view** — the dashboard's per-session page: facet header,
  check badges, test results, footprint, absences with reasons, flat
  timeline. Added 2026-07-17, PRD-0003 grill.
- **verified / failing / unverified** — the canonical three-way
  classification of a session by its bound checks: verified = ≥1 bound
  check and no failing bound check; failing = ≥1 failing bound check
  (exit ≠ 0); unverified = no bound checks. The headline KPI applies it
  to kind=`headless` sessions in a rolling 7-day local window; kind
  ABSENT is excluded from the denominator and surfaced separately,
  never silently folded. Added 2026-07-17, PRD-0003 grill.
- **drift banner** — the overview element naming in-window sessions
  whose recorded cc_version falls outside the tested range;
  ledger-derived only (the server never executes `claude`), fired on
  positive evidence only — a NULL version never triggers it. Added
  2026-07-17, PRD-0003 grill.
