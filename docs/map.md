# Map — where things live (as of PRD-0002, 2026-07-17)

Vocabulary in `CONTEXT.md`; read `docs/gotchas.md` before writing any slice.

- `src/hook/capture.ts` — the hook artifact: append + boundary git
  enrichment, always exits 0. Built self-contained; init copies it from
  `dist/` into the target repo.
- `src/core/` — the contracts: `envelope` (spool line + check-line
  variant), `registry` (append-only JSONL fold), `ledger` (node:sqlite
  projection, schema v2), `operatorState` (global append-only fold log),
  `status`, `paths`, `priceTable` (pinned per-model pricing),
  `attribution` (allowlist env scrub lives here — import `scrubbedEnv`,
  never reinvent).
- `src/ingest/` — lazy spool→ledger projection: idempotent, corrupt lines
  skipped + counted + named, ordinals, session aggregation, footprint,
  `testResults`, `enrichment` (cost, per-request all-or-nothing),
  `drift`.
- `src/facets/` + `src/render/` — derived evidence columns and `log`/`show`
  rendering; the absent marker is `src/render/absent.ts` (degradation law).
- `src/parsers/` — pluggable test-output parsing at ingest (vitest first);
  never in the hook artifact.
- `src/check/` — `coreartifact check`: wrapped-command evidence capture
  (argv, binding, cap, run).
- `src/doctor/` + `src/ping/` — doctor report / version drift, and the
  consented two-field version ping.
- `src/install/` — `init`: hook config merge, gitignore line, artifact
  copy, worktree propagation. `uninstall` inverts it byte-identically
  (backup manifest; never delete what init didn't write).
  `src/worktree-gap.ts` — the ingest warning.
- `src/cli/` — `bin.ts` (guardless, calls `main()`) + `commands/` (log,
  show, check, doctor, init, uninstall); bins `coreartifact` and `cart`.
- `tests/acceptance/harness/` — the seam: tmpdir repos, subprocess CLI,
  fixture replay, hermetic git env. Copied verbatim into each issue's
  acceptance dir.
- `tests/fixtures/` — version-stamped recorded streams + `manifest.json`
  (fixed path, never discovered) + typed `loader.ts`. `corrupt-line.jsonl`
  is the one hand-authored stream, deliberately outside the manifest.
- `docs/recording-pass.md` — observed platform truths (WorktreeCreate is a
  delegation hook; `model`-on-SessionStart is the kind signal).
