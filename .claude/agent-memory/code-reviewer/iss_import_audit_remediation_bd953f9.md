---
name: iss-import-audit-remediation-bd953f9
description: aeh bd953f9 remediation of b507fca import-audit — span-lexer FIXES string-data/comment FP but reopens it via regex-preceded FP (S2); novel ENOTDIR crash in caseExactExists (S3)
metadata:
  type: project
---

# aeh import-audit remediation (bd953f9, feat/acceptance-import-audit)

Remediates the 4 b507fca findings ([[iss-import-audit-static-scan-gaps]]).
src/import-audit.ts. Full 24 (21 unit + 3 integration) green; both required
mutations bite (insideAnySpan→false kills string-data+comment tests; remove
bare block kills bare test). Brace/interpolation lexer robust across 5 nested
adversarial cases. Symlinked node_modules + relative-import-through-symlinked-src
both clean. NodeNext, NO tsconfig/vitest path aliases → bare `src/...` rule is
sound for this repo (no real package subpath collides with dist/docs/src/tests).

**Novel gaps found by execution:**
1. **S2 regex-preceded false positive reopens the fixed S2.** A regex literal
   with an unbalanced quote (`/'/`, `/"/`) is not lexed (code state has no regex
   handling, lines 69-97); it opens a phantom string span that flips quote parity
   so the FOLLOWING honest string-data (`toContain('import y from "../../../src/data.js"')`)
   is read in code context and FLAGGED. Proven: got 1 expect 0, both quote flavors.
   Commit documents the residual as benign false-NEGATIVES "bounded by the defect
   loop"; the false-POSITIVE direction is NOT bounded — walls a correct test-author
   at MAX_TEST_AUTHOR_ATTEMPTS=2 on a non-bug. Same S2 class the remediation claims
   closed, just gated behind a preceding regex.
2. **S3 novel ENOTDIR crash.** caseExactExists line 181 `readdirSync(dirAbs)` after
   existsSync guard (178) that only rejects nonexistence, not file-as-dir. A relative
   import walking THROUGH an existing file as a directory
   (`../../../src/anchor.js/deeper.js`) throws ENOTDIR. b507fca used existsSync (never
   throws → clean violation). Call site run-issue.ts:973 is OUTSIDE the try (850 closes
   before it) → unwinds runIssue, the "strand the issue" hazard the 843 comment warns of.
   Trigger (file-as-intermediate-segment) is a contrived specifier → S3 not S2.

**Cleared lanes (executed):** division vs regex (division fine), escaped quotes,
quote-heavy strings before real import, nested/deep template interp with bad import,
object-literal-in-interpolation, unterminated-string-at-EOF, string-with-backtick-in-interp
— all correctly flag the real import (got 1). Documented regex false-NEGATIVE (real
import after `/["']/`) reproduced: got 0 = S3 pre-feature soft-fail, as documented.
