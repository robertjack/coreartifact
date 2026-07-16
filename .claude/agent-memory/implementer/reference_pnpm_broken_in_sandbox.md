`pnpm` itself (any subcommand, even `pnpm --version`) fails in this Bash
sandbox with `[ERROR] unable to open database file` — confirmed
environment-wide, not project- or change-specific, by running it before any
edits and against a stash of a clean tree. Likely a sandboxed-write
restriction on a pnpm state/store db under the real `$HOME` (pnpm's own
config/store dirs exist and are readable — `pnpm store path` succeeds — but
anything that needs to WRITE its local db does not).

**Why:** cost real time chasing whether ISS-0022's `pnpm run build`/`pnpm
test`/`pnpm run typecheck` failures were caused by my changes before
isolating it to pnpm itself.

**How to apply:** when a verify command specified as `pnpm run X` fails
with this exact error, don't debug the code — run the package.json
script's underlying binary directly instead (`node_modules/.bin/tsc
--noEmit`, `node_modules/.bin/tsc`, `node_modules/.bin/vitest run`), which
all work fine, and report the substitution explicitly in structured output
rather than treating pnpm-dependent acceptance tests (e.g. ISS-0009's
`pnpm pack` packaging test) as new failures your change caused.
