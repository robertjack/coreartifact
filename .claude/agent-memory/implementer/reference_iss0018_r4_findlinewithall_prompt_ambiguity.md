---
name: iss0018-r4-findlinewithall-prompt-ambiguity
description: ISS-0018 R4's single-token findLineWithAll call structurally selects the fixture's UserPromptSubmit line, not the command's own line — a second, independent test_dispute on top of the known scope_change
metadata:
  type: reference
---

Builds on [[reference_iss0018_footprint_excludes_cli_show_wiring]]. That
memory's hypothesis was: grant footprint on `src/cli/commands/show.ts`, wire
the one-line glue, and R4 goes fully green. **That hypothesis is false** —
confirmed by re-running R4 after re-verifying the footprint block is still
live (write-guard rejected an `Edit` on that file with an explicit
footprint-violation error, same as before).

The vitest fixture's own lines, in order (`tests/fixtures/vitest.jsonl`):

```
0 SessionStart
1 UserPromptSubmit  "First run `pnpm vitest run passing.test.js` (it passes). Then run ..."
2 PreToolUse        pnpm vitest run passing.test.js   (folded — paired with 3)
3 PostToolUse       pnpm vitest run passing.test.js   (the row a badge would attach to)
4 PreToolUse        pnpm vitest run                   (folded — paired with 5)
5 PostToolUseFailure pnpm vitest run
6 Stop
7 SessionEnd
```

R4's final assertion:

```js
const passingLine = findLineWithAll(showResult.stdout, ["pnpm vitest run passing.test.js"]);
expect(passingLine).toContain("65");
```

`findLineWithAll` (defined in this same test file) filters ALL rendered
lines containing every given token and returns `matches[0]` — the
FIRST-positioned match, not "the one match a human would mean." The
fixture's own prompt text embeds the literal command string in backticks, so
`UserPromptSubmit`'s rendered line (`[1] ... prompt: First run \`pnpm vitest
run passing.test.js\` ...`) ALSO matches the single token — and it renders
strictly earlier in the timeline than the command's own line (seq 1 vs seq
3, and a prompt causally always precedes the tool call it triggers). Given
only one, non-disambiguating token, `matches[0]` is therefore **always** the
prompt line, never the command line — confirmed both by this reasoning and
by direct execution: the observed failing assertion's own error message
prints the selected line as the `UserPromptSubmit` prompt line, not any
`command:` line.

Since a test-results badge can only ever render on a `command:` line (never
on a `prompt:` line), `.toContain("65")` is **unsatisfiable by any
implementation** while this exact test text stands, independent of the
footprint/scope_change issue. Both blockers are real and independent; fixing
one does not fix the other. Neither is fixable in-footprint: the
`scope_change` needs `src/cli/commands/show.ts` added to owns/touches, and
the `test_dispute` needs a disambiguating second token in the test itself
(e.g. `["pnpm vitest run passing.test.js", "command:"]`, mirroring
`findLineWithAll`'s own doc comment, which already names this exact pitfall
— "a token... could otherwise also appear, alone, in an unrelated line (e.g.
the session's own prompt text)" — but the R4 call site doesn't follow its
own warning).

**How to apply:** don't stop at the footprint diagnosis and assume attempt 3
just needs scope_change granted — re-verify R4 would actually go green after
that grant (it would not, as currently written). Report both findings
together; the scope_change alone is necessary but not sufficient.
