# Map — where things live (as of PRD-0001, 2026-07-15)

Vocabulary in `CONTEXT.md`; read `docs/gotchas.md` before writing any slice.

- `src/hook/capture.ts` — the hook artifact: append + boundary git
  enrichment, always exits 0. Built self-contained; init copies it from
  `dist/` into the target repo.
- `src/core/` — the contracts: `envelope` (spool line), `registry`
  (append-only JSONL fold), `ledger` (node:sqlite projection), `status`,
  `paths`, `attribution` (allowlist env scrub lives here — import
  `scrubbedEnv`, never reinvent).
- `src/ingest/` — lazy spool→ledger projection: idempotent, corrupt lines
  skipped + counted + named, ordinals, session aggregation, footprint.
- `src/facets/` + `src/render/` — derived evidence columns and `log`/`show`
  rendering; the absent marker is `src/render/absent.ts` (degradation law).
- `src/install/` — `init`: hook config merge, gitignore line, artifact
  copy, worktree propagation. `src/worktree-gap.ts` — the ingest warning.
- `src/cli/` — `bin.ts` (guardless, calls `main()`) + `commands/`; bins
  `coreartifact` and `cart`.
- `tests/acceptance/harness/` — the seam: tmpdir repos, subprocess CLI,
  fixture replay, hermetic git env. Copied verbatim into each issue's
  acceptance dir.
- `tests/fixtures/` — version-stamped recorded streams + `manifest.json`
  (fixed path, never discovered) + typed `loader.ts`. `corrupt-line.jsonl`
  is the one hand-authored stream, deliberately outside the manifest.
- `docs/recording-pass.md` — observed platform truths (WorktreeCreate is a
  delegation hook; `model`-on-SessionStart is the kind signal).
