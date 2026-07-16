---
name: iss0018-footprint-excludes-cli-show-wiring
description: ISS-0018's granted footprint has no path that can wire test_results into show's CLI stdout — a genuine scope_change, not a test bug
metadata:
  type: reference
---

ISS-0018 (parser interface + vitest parser) granted footprint: `src/parsers/**`,
`src/render/show.ts`, `tests/unit/parsers/**`, `tests/acceptance/ISS-0018/**`,
`src/ingest/**`, `tests/unit/ingest/**`. It does NOT include
`src/cli/commands/show.ts`.

The locked acceptance test's R4 criterion drives the built CLI
(`coreartifact show <session>`) and asserts the passing command's rendered
line contains its parsed vitest duration ("65") as a badge. But
`src/render/show.ts` is a pure formatter (no SQLite, by its own header
comment) and `src/cli/commands/show.ts` is the ONLY place that queries the
ledger and builds `TimelineEntry` objects to hand to the renderer — and it is
outside the footprint. There is no way to get a `test_results` row into
`show`'s stdout without editing that file.

This is NOT the [[reference_iss0013_checkline_test_dispute_not_scope_change]]
pattern (a test importing a module the footprint never grants — fixable by
correcting the test's import path). Here the test drives the CLI as a
subprocess and asserts on stdout; there is no test-side fix, because the gap
is in implementation wiring, not a wrong path in the test. Confirmed by
attempting the Edit and getting the write-guard's footprint-violation error.

What was still done inside the footprint, ready for the wiring to consume:
`src/parsers/vitest.ts` (the parser), `src/ingest/testResults.ts` (payload
extraction + hardcoded parser list + `claimTestResults`), the `test_results`
upsert added to `src/ingest/index.ts`'s recompute, and
`src/render/show.ts`'s `TimelineEntry` "command" variant gained an OPTIONAL
`testResults?: TestResultsBadge | null` field plus a `renderTestResultsBadge`
function — optional so `src/cli/commands/show.ts` still compiles unmodified.
3 of 4 acceptance criteria pass; only R4's CLI-stdout assertion fails, and
only on that one line.

**How to apply:** the one-line fix for attempt 2 is in
`src/cli/commands/show.ts`: add `line_no` to the `events` SELECT, query
`test_results WHERE session_id = ?`, build a `Map<number, TestResultsBadge>`
keyed on `line_no`, and pass `testResultsByLineNo.get(row.line_no) ?? null`
as the `testResults` field when building a "command" `TimelineEntry` in
`buildTimelineEntry`. Request footprint expansion to include
`src/cli/commands/show.ts` before attempt 2 starts, rather than guessing
around it again.
