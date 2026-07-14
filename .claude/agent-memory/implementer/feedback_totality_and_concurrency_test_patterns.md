---
name: feedback-totality-and-concurrency-test-patterns
description: Recurring review findings in this repo for JSONL-fold "totality" code and for concurrency tests — apply to any append-only-log fold (registry, spool, future ledger ingest).
metadata:
  type: feedback
---

Two failure patterns recur across this repo's append-only-JSONL-fold code
(seen on ISS-0010's registry.ts, likely to recur on spool/ledger ingest):

1. **`typeof x === "object"` is not a not-null-and-is-a-plain-object guard.**
   `typeof null === "object"` and `typeof [] === "object"` are both true.
   Any fold over `JSON.parse`'d lines that claims "totality" (never throws)
   must guard explicitly: `typeof parsed !== "object" || parsed === null ||
   Array.isArray(parsed)`. A `.someField` access on a parsed value before
   this guard throws a `TypeError` on a `null` line — a real reviewer
   finding, not a hypothetical.

2. **A `Promise.all` over an `async` function whose body never `await`s
   before its side effect (e.g. one `appendFileSync` call) runs serially in
   practice, and cannot prove anything about concurrency/lost-updates.**
   The honest test for "N concurrent appends don't lose an update" is N
   separate OS processes (`spawn`/`spawnSync` against the *built* `dist/`
   output, per the existing pattern in `tests/acceptance/ISS-0001/cli.test.ts`
   — resolve `repoRoot` via `import.meta.url`, spawn `node dist/...`).
   In-repo convention for a subprocess that needs to call one exported
   function: `spawn(process.execPath, ["--input-type=module", "-e", script],
   { env: {...} })`, passing arguments via `env`, not `argv`, to dodge
   Node's `-e` argv-index ambiguity.

**Why:** ISS-0010's registry rewrite existed specifically because three
prior review rounds died on registry concurrency bugs; the 2026-07-14 spec
amendment named both of these exact traps as findings after a first
attempt's tests silently proved nothing.

**How to apply:** Before writing a "never throws" test for a JSONL-fold,
enumerate every JSON-valid-but-wrong-shape value (`null`, `true`, a number,
a string, `[]`) as its own case. Before writing a concurrency test in this
repo, ask "could this fail if the bug were present?" — if the body has no
`await` before the racy operation, `Promise.all` cannot answer that; spawn
real processes instead. See also [[reference_tests_acceptance_writable_in_practice]].
