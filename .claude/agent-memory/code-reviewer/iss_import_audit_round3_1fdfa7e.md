---
name: iss-import-audit-round3-1fdfa7e
description: aeh 1fdfa7e round-3 import-audit remediation — regex-span lexer FIXES bare /'/ FP but the `)`/`]`/quote→division branch REOPENS the round-2 S2 FP (if/while no-brace + ASI). try/catch total (clean). One weak pin.
metadata:
  type: project
---

# aeh import-audit round 3 (1fdfa7e, feat/acceptance-import-audit)

Remediates round-2 ([[iss-import-audit-remediation-bd953f9]]): adds `regexCanStart`,
regex-consume branch in `stringAndCommentSpans`, try/catch in `caseExactExists`.

**S2 FP REOPENED (round-2 class, new door).** `regexCanStart` line 87
`return !/[)\]"'`]/.test(prev)` routes a `/` preceded by `)`,`]`, or a closing
quote/backtick to DIVISION. So a regex literal in those positions is NOT lexed;
an unbalanced quote in it (`/'/`) opens a phantom string span and poisons parity
→ honest import-shaped string data on a later line flags. Contradicts the commit's
own stated invariant ("biased toward regex ... never toward false POSITIVE").
Proven on real code (got 1 expect 0):
- `if (ok) /'/.test(s);` + string data next line
- `while (m.exec(s)) /'/.test(x);` (realistic no-brace control flow)
- ASI: `const r = compute()` \n `/'/.test(r)` \n string data  (`)`-terminated line before regex line)
NOT reproduced: `arr[0]; /'/` (semicolon → prev is `;` → regex, safe), `() => {} /'/`
(`}`→regex bias, safe), block-comment-before-division (no quote), `.test('import..')` arg
(inside span, safe), template `${/'/}` (safe). So the live door is `)`/`]`/closing-quote
IMMEDIATELY before a regex — reachable in idiomatic test code, worst failure mode
(walls honest author at MAX_TEST_AUTHOR_ATTEMPTS=2). S2.

**Weak pin (S3 test-quality).** "division chains never open regex state" pin passes
under BOTH `regexCanStart→return false` AND `→return true` mutations (newline-bounded
swallow means the next-line import flags regardless) — it pins nothing about regexCanStart.

**Clean lanes (executed):** 3 of 5 new pins bite `regexCanStart→false` (quote-bearing,
keyword-position, regex-then-real). try/catch removal reddens file-as-dir pin (crash).
Symlink cycle in acceptance dir: no hang (segments finite). Regex with escaped `//`,
char-class-with-quote `/[a-z']/`: parity correct. Baseline 26/26 green.
