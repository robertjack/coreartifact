---
name: feedback-validate-before-transform-spool
description: Control-char-vs-trim ordering in envelope/spool validation is CONTEXT-DEPENDENT — src/core/envelope.ts's serializeEnvelope(eventText) checks raw-then-trims (no legitimate framing expected); the hook's raw-stdin reader must trim-then-check (a trailing \n is legitimate framing). Applying the wrong one is a real, repeated data-loss bug.
metadata:
  type: feedback
---

**Revised 2026-07-14 (ISS-0004 rescue dispatch)** — the original version of
this memory was itself the cause of a second data-loss bug (S1) on the next
issue that touched this pattern. Read the "two contexts" section below
before touching any control-char-rejection-plus-trim code in this repo.

## Two contexts, two correct orderings

**Context A — `serializeEnvelope`'s `eventText` param
(`src/core/envelope.ts`), and any caller feeding it an already-JSON-extracted
string.** No legitimate trailing/interior whitespace is expected here — the
value came out of a parsed structure, not off a wire. Order:
**reject-raw-control-chars-first, trim second, re-validate JSON last.**
Trimming before checking would silently accept a value whose corruption
*is* a trailing/embedded control byte (the F1 multi-line spool-corruption
trap). This is ISS-0001's V3 finding and is still correct for this
function.

**Context B — reading raw stdin bytes off a pipe (the hook artifact,
`src/hook/capture.ts`'s `validateEventText`, and anything else consuming
`process.stdin` directly).** A trailing `\n` here is not corruption, it is
the *ordinary, universal shape* of a piped JSON line — every real Claude
Code hook invocation delivers one. Order: **trim first (strips legitimate
framing: leading/trailing whitespace, the trailing `\n`), THEN reject
control chars in the trimmed remainder (catches genuine corruption: an
*interior* control character that would still desync the spool's line
count), THEN JSON.parse.** Checking raw-before-trim in this context (i.e.
applying Context A's rule here) rejects every normal payload as
"unparseable" and silently drops it — this is exactly what happened on
ISS-0004's first attempt (S1, 2026-07-14): it copied context A's ordering
verbatim into a context-B call site.

**Why the two differ:** whether the input is expected to carry legitimate
wire/stdio framing bytes that a downstream re-embed must strip (context B),
versus a value with no such framing where any control byte at all is
inherently suspicious (context A).

**How to apply:** before ordering a control-char check against a trim in
*this specific* class of code, ask "does this string come straight off
stdin/a pipe (context B, trim first) or out of an already-parsed JSON
structure with no expected framing (context A, check first)?" Don't
pattern-match on "there was a control-char-vs-trim bug here before" without
checking which context you're actually in — the correct fix is opposite
depending on the answer, and this codebase now has one bug instance of
each direction.
