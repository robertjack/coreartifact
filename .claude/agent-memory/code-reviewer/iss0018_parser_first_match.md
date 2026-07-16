---
name: iss0018-parser-first-match
description: ISS-0018 vitest parser reads the FIRST Tests/Duration summary-line match, so embedded summary-shaped output before the real summary mis-parses counts
metadata:
  type: project
---

# ISS-0018 vitest parser — first-match summary extraction (S2, executed 2026-07-16)

`src/parsers/vitest.ts` extracts counts/duration via `TESTS_LINE.exec(text)` and
`DURATION_LINE.exec(text)` — both `/m` regexes returning the **first** line match
across `stdout+"\n"+stderr`. vitest emits the real summary LAST, so any earlier
line that is (leading-whitespace only) `Tests  <n> (passed|failed|skipped)` or
`Duration  <n>ms` wins and the true summary is ignored.

Proven: input whose FAIL block embeds a console-style line `      Tests  99 passed (99)`
and `   Duration  9999ms` before the real ` Test Files 1 failed (1)` / `Tests 1 failed (1)`
summary parsed to `{passed:99,failed:0,skipped:0,durationMs:9999}` — a real 1-failed run
reported as all-green. Evidence-integrity defect (the tool's whole point is trustworthy
test evidence), but reachability needs the captured output to carry a summary-shaped line
at line-start (test `console.log`, not code frames / `-`/`+` diff lines, which are prefix-
protected), so S2 not S1. Fix: anchor to the LAST Test Files+Tests block, or require the
Tests line be part of the trailing summary block adjacent to Test Files.

`×`-prefixed failed-name lines are NOT affected (a test literally named
`Tests  5 passed (5)` parsed fine — the `×` prefix keeps it off the summary regex).

## What the parser does correctly (verified, do not re-report)
- Never throws: empty / truncated-mid-word / ANSI / jest / pytest input all return
  null-or-TestResults (ANSI around counts still parses; truncated `2 pas` → zero-count row).
- Real vitest zero-tests: empty `describe` → `Tests  no tests` (Test Files line present)
  → claims a zero-count row (correct). BUT `No test files found, exiting with code 1`
  (glob matched nothing) has NO summary lines → parser returns null → treated as ABSENT
  (no row), not a zero-count row. Spec-interpretation gray area (S3): the clearly-named
  `Tests 0 passed (0)` case works; "no test files found" collapses to absence.
- Both payload paths solid: PostToolUse.tool_response.stdout (exit 0) and
  PostToolUseFailure.error after `"Exit code 1\n\n"` (exit 1, no tool_response); a
  failure error lacking the marker degrades (uses whole string), never crashes.
- show blast radius clean: a command with no test_results row renders byte-identical
  to pre-branch (`badge` = "" concat); badge only appends for claimed commands.

## Mutation coverage of the ISS-0018 acceptance/unit tests (all bite, executed via copy)
- parser→null: 8 red. extraction skips PostToolUseFailure: 3 red. badge wiring dropped:
  R4 reddens on the `65` badge assertion (the `command:`-prefix disambiguation amendment
  genuinely bites — the passing line's only "65" is the badge; tool duration_ms is 624).
- GAP: line_no-vs-seq identity not distinguished — the vitest fixture is a single session
  so seq==line_no; keying test_results on seq instead of line_no would not redden (S2
  test-breadth; impl is correct, uses line_no).
