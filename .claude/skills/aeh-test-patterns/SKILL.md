---
name: aeh-test-patterns
description: House-pack (pnpm/vitest/Playwright/Drizzle/Next/Supabase) test patterns. Pack #1 skill bundle — worker-preload content for builder roles via the skills admission list, not an operator procedure. Every rule below was paid for by a failed attempt in a real campaign ledger.
---

# aeh-test-patterns — house stack, pack #1

Stack-specific testing knowledge. Distilled from the gm-portal PRD-0001
ledger (11 issues, 28 quality_fail events, 30 review findings; 2026-07-06).
Rules cite the ruling that paid for them.

## Vitest

- Excludes live in `vitest.config` only. Never pass `--exclude` on the CLI:
  a CLI exclude REPLACES the config's and vitest's default exclude list —
  one shipped `--exclude` swept 830 files / 7666 tests from inside
  node_modules. The same replace semantics apply to `exclude:` in config:
  when you set it, restate `node_modules/**`.
- A test touching the filesystem, a database, or a path derived from
  `import.meta.url` MUST pin `// @vitest-environment node` as the file's
  first line when the repo config defaults to a DOM environment — under
  jsdom/happy-dom `import.meta.url` is not a `file://` URL and repo-relative
  resolution silently yields absolute nonsense no implementation can satisfy.
- The test script carries `--passWithNoTests`: headless gates run against
  trees that may hold no tests yet, and a bare `vitest run` fails them.
- Narrow a possibly-undefined component before rendering it: JSX of a
  `T | undefined` fails the typecheck gate with TS2786 — `if (!Component)
  throw new Error("not implemented yet")` is the red-today idiom for a
  component that does not exist yet.

## Setup files and env

- Env defaults in a setup file (`process.env.X ||= …`) come from
  `.env.example`, never a guessed or "standard" value — a worker's guessed
  port 54321 silently shadowed every per-test env bootstrap on a stack
  running at 54421 for a whole campaign (`||=` wins over anything set later).
- Keep setup-file mocks defensive: a global `vi.mock` must defer to a test's
  own mock and fall back only where the real call would throw outside a
  request scope.
- Vitest never loads `.env.local`. A new env var your code reads under test
  needs a setup-file default (value from `.env.example`); when the setup
  file is outside your owns, that default is operator prep — name it in
  your diagnosis instead of working around it (PRD-0006 ISS-0035).

## Local Supabase + Drizzle

- Rows fetched via supabase-js are snake_case at runtime even where Drizzle
  types say camelCase — map explicitly at the data seam; asserting camelCase
  fields on a raw row reads `undefined` (shipped S1, ISS-0005).
- A fresh-database test CREATEs its own uniquely-named database on the local
  server (connect to the maintenance db, `CREATE DATABASE` with an
  mkdtemp-style name, target it, `DROP` in cleanup) — never DDL against the
  shared dev database: earlier attempts polluted it, and "already exists"
  there is your setup defect, not honest red (ISS-0002, 8 failed rolls).
- A fresh test database has no Supabase auth baseline — stub or bootstrap
  the `auth` schema and roles before auth-dependent code runs; app
  migrations do not create them. The proven minimal bootstrap (migrations
  with RLS policies fail without ALL of it — `auth.uid()` included, a
  partial rewrite cost ISS-0012 an attempt ladder):
  ```sql
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE SCHEMA IF NOT EXISTS auth;
  CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  ```
  pgcrypto is in the stub because Supabase provisions it in every real
  database — the first migration with a `gen_random_bytes` default reds
  against a stub without it (PRD-0006 ISS-0034).
- Tables created by Drizzle migrations carry NO Supabase role grants —
  GRANT to `anon`/`authenticated`/`service_role` in the seed, or PostgREST
  returns permission errors that read as missing data.
- After seed or DDL changes run `notify pgrst, 'reload schema'` — PostgREST
  caches the schema; a stale cache reads as missing tables/columns.
- The profile's migrate key is `supabase db reset` (migrations + seed
  against the local stack) — there is no separate drizzle push step.
- Db-backed test files carry the `.db.test.ts` suffix and live under the
  issue's own `tests/acceptance/<id>/` — they run under the DEFAULT vitest
  config (the suffix still matches the ordinary include glob), never a
  separate project/config. The profile's `db_test` key runs exactly that
  subset.
- In a worker session, run db-backed tests ONLY via the profile's `db_test`
  command, invoked VERBATIM (optionally with appended args) — that exact
  command string is the one carve-out from the sandbox. Any other
  invocation (plain `pnpm test`, a paraphrased vitest line) EPERMs on the
  first 127.0.0.1 connect: that EPERM is the sandbox wall, not your test or
  the stack (PRD-0009; platform fact 2026-07-10 — no allowlist opens
  localhost TCP).
- Schema-dependent failure must surface in the TEST BODY, never in
  beforeAll/afterAll — red-verify treats lifecycle-hook failures as
  never-honest-red and fails the ladder. Seed inside the test (or a helper
  the test calls), not in hooks.
- On a migration-adding issue your db tests stay red in-session no matter
  how correct the code: workers never run migrate (runner-owned law,
  ISS-0067), and the runner applies your migration only at its own pre-gate
  migrate point. That red is EXPECTED — finish when everything else is
  green; the gate battery is the verifier (PRD-0009).
- Postgres `ORDER BY col DESC` sorts NULLs FIRST — nullable timestamp feeds
  need `NULLS LAST` or a filter, or unpublished rows lead the feed.
- `.single()` errors when more than one row matches — memberships and other
  non-unique relations need `.limit(1)` plus an explicit choice, or
  multi-row handling (2 shipped findings).
- Resolve a seed row by a UNIQUE predicate (`role = 'owner'`, an exact
  email) — never unordered `.limit(1)`, and never hardcode a
  seed-credential map: the next slice's seed rows ambiguate both silently
  (three MAIN-side pin amendments in one campaign, PRD-0006).
- Function grants are explicit in BOTH directions: `REVOKE EXECUTE … FROM
  public, anon`, then GRANT only the intended role, and pin `search_path`
  on SECURITY DEFINER functions — never lean on platform defaults either
  way (a PRD-0006 integration S1 was half-disproven by live probe; the
  explicit posture ships regardless).
- Never discard the `error` field of a supabase-js response — a swallowed
  error masquerades as "no session", a false 403, or an empty state
  (3 shipped findings).

- Asserting a FK to `auth.users` via information_schema: never join
  `constraint_column_usage` on table_schema equality with the constrained
  table — for a cross-schema FK ccu rows carry the REFERENCED table's schema
  (`auth`), so the join yields zero rows for a correct migration. Join on
  constraint_name (+ constraint_schema), then assert
  `foreign_table_schema = 'auth'` (cost ISS-0012 an attempt ladder).

- A test that INSERTs/UPDATEs the shared local db MUST delete its rows in a
  finally/afterAll — seed-purity tests elsewhere in the suite assert exact
  seed state and fail the NEXT run on your leftovers (an uncleaned staff
  probe row flaked ISS-0016's regression gate via ISS-0003's assertions).
  Cleanup alone is NOT enough: vitest runs test FILES in parallel, so two
  files mutating the same seed row race regardless of finally-restore (one
  file read a member's watermark while another had it set 60s ahead —
  gm-portal ISS-0021). The template's `vitest.config.ts` sets
  `fileParallelism: false` for this; keep it, or give each mutating file its
  own dedicated member.

## Auth in tests

- Sign in through the seeded password (`signInWithPassword` with seed
  credentials) — never mint tokens by hand and never use `hashed_token` as
  a bearer token: hand-built sessions pass locally and lie.

## Seams and mocks

- Assert through the production seam. A mocked seam result must match the
  shape the real seam emits — import its type or copy a real row, never
  invent one. A criterion satisfied only by a fabricated mock shape is
  unmet (2 shipped-then-caught instances: a mock-only email render; a
  snake_case mock of a seam that emits camelCase).

## Next server actions and rendering

- A server action that mutates data any route renders MUST call
  `revalidatePath` for every route rendering it — Next caches the RSC
  payload, so without it the mutation is invisible on soft navigation
  and only a hard reload shows it (three campaigns paid: PRD-0002 admin
  actions, PRD-0003 markFeedSeenAction, PRD-0004 metrics authoring).
- Never initialize `useState` from a server-fetched prop in a client
  component — that freezes the first render's value and defeats
  `revalidatePath` entirely; render from the prop and reserve state for
  client-only concerns (PRD-0004 ISS-0027 S2).

## Playwright tracers

- After a mutating submit, locate the created row by a run-unique marker (a
  timestamped email or label) — never `.first()`: a stale row from an
  earlier failed run gets captured silently and the tracer passes against
  old state (PRD-0006 ISS-0038 S1).
- `waitForURL` resolves before the RSC payload commits — assert a rendered
  element of the destination before reading page state, or the snapshot
  races the render (ISS-0038 S1).
- A cross-tenant negative check must be falsifiable: first assert the other
  tenant's page rendered its OWN content, then assert the absence — an
  absence check against an unrendered DOM passes even when RLS leaks
  (ISS-0038, two S1s).
- Read baseline counts with retrying assertions
  (`expect(locator).toHaveCount`, `expect.poll`) — a one-shot `.count()`
  latches 0 at startup and reds the whole tracer steps later (ISS-0038).

## Environment and dependencies

- Never run the build (`pnpm run build` / `next build`) in a worker
  session: the sandbox wedges it — two 45-minute attempts died mid-build
  (PRD-0006 ISS-0035) — and an orphaned build holds `.next`'s lock into
  later gates. Build is an orchestrator gate; finish with tests green and
  let the gate battery build.

- The worker sandbox denies registry egress: never edit package.json
  dependencies — the install can never run. Emit `dependency_request` and
  the operator provisions the dep on main.
- package.json edits imply pnpm-lock.yaml changes; if package.json is not
  in your owns, neither file is yours to touch (2 footprint_gate_fail
  events).
