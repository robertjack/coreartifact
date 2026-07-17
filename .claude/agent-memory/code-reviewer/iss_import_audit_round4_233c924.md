---
name: iss-import-audit-round4-233c924
description: aeh 233c924 round-4 import-audit — newline-bounds quote spans (closes the round-3 quote door) BUT the cross-line FP invariant is still BROKEN via phantom BACKTICK (templates are NOT newline-bounded). Commit-msg overclaims "impossible by construction".
metadata:
  type: project
---

# aeh import-audit round 4 (233c924, feat/acceptance-import-audit)

Fix: `stringAndCommentSpans` newline-bounds single/double-quote spans
(src/import-audit.ts ~L194) so a phantom quote from a misread regex dies at
the next raw `\n`. Closes the round-3 `)`-before-regex quote door for QUOTES.

**INVARIANT STILL BROKEN — cross-line FP via phantom BACKTICK (S2, same class
as round-3).** The firewall bounds only `single`/`double`; `template` spans are
(legitimately) NOT newline-bounded. A backtick-bearing regex misread as division
in a `)`/`]`/quote/value-ASI position (`` /`/ ``, markdown-fence `` /```/ ``)
opens a PHANTOM TEMPLATE that runs to a later REAL template's opening backtick,
closing it there → the real template's honest import-shaped data lexes in CODE
context → flagged. Proven by execution (got 1 violation, expect []):
- A1 ASI: `const r = fn()` ⏎ `` /`/.test(r) `` ⏎ ``const t = `import x from "../../../src/data.js"`;``
- A2 no-brace if: `` if (ok) /`/.test(s); `` ⏎ ``const expected = `import y from "../../../src/gen.js"`;``
- A3 control (real template, NO phantom backtick) → [] correctly.
Commit message claim "bounds ANY phantom quote... False positives across lines
are now impossible by construction" is FALSE — only quotes, not backticks. The
new "door stays shut" pin covers only `/'/` quote regexes, never `` /`/ ``.

Realism: LOW/contrived — needs a backtick-in-regex in ASI/no-brace value pos
COEXISTING with a valid template holding import-shaped text in one acceptance
file. Same tier the team accepted as S2 round-3. Per parent's own gate (cross-line
FP = the only blocker) the invariant does NOT hold as literally stated.

**Not-a-finding lanes (executed):**
- V2b (phantom quote line ending in `\` before newline) reddened BUT the input
  is malformed — the trailing `\` sits in CODE, the "data" was never stringified,
  so lexer matches real-JS reading; not a clean FP. Inconclusive, discarded.
- V2a continuation string, V3a CRLF firewall, V3b CRLF true-positive boundary:
  all clean.
- Pin verify: `git show 233c924^:src/import-audit.ts` → paren-regex pin RED (1
  failed), division pin green under parent (parent already lexes regex); restore
  → 30/30 green (27 unit + 3 run-issue integration). Tree left clean at 233c924.
