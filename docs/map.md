# Map — where things live (as of PRD-0003, 2026-07-20)

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
- `src/dashboard/` — the read-only HTTP surface (PRD-0003):
  `server.ts` (loopback bind, GET wall, lifecycle) · `assets.ts`
  (static SPA serving, traversal-safe) · `routes.ts` (the `/api/*`
  registry) · `overview.ts` + `session.ts` (the two endpoints,
  ingest-on-read via the shared walk) · `classify.ts` (the three-way
  classification, window math, semver range) · `constants.ts` (port
  2278, caps). Contract: docs/prd/PRD-0003-dashboard/api.md (binding).
- `web/` — the vite+react SPA (devDeps only, built into dist at
  publish): `src/views/Overview.tsx` + `overview/` · `Session.tsx` +
  `session/` · `api-types.ts` (the wire shapes) · `App.tsx` (shell;
  each view wired its own route — the shell-App seam). Design contract:
  docs/prd/PRD-0003-dashboard/prototypes/v2-tile-led.html (frozen).
- `tests/acceptance/ISS-0032/browser-harness.ts` — the one browser
  seam (playwright chromium); every other criterion stays on HTTP.
  `ISS-0029/session-and-freshness.test.ts` `seedLines` — the hermetic
  replay pin (gotcha #8 prior art).
- `docs/recording-pass.md` — observed platform truths (WorktreeCreate is a
  delegation hook; `model`-on-SessionStart is the kind signal, valid only
  at `source: "startup"` — findings 9–11 for the 2.1.212 pass).
