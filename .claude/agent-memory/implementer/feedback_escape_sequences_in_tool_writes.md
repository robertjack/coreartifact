---
name: feedback-escape-sequences-in-tool-writes
description: Typing \x00 / \xNN-style escape text in Write/Edit tool parameters can insert the literal raw byte, not the two-character escape text — silently reintroducing NUL-byte-in-source bugs.
metadata:
  type: feedback
---

When a source file needs to contain the *text* of an escape sequence (e.g. a
JS/TS string or regex literal like `/[\x00-\x1f]/` or `"a\x00b"`), do not
type `\x00` directly into a `Write`/`Edit` tool parameter and assume it stays
as four literal characters (`\`, `x`, `0`, `0`). Observed on ISS-0001: typing
`/[\x00-\x1f]/` into an `Edit` call produced an actual raw NUL byte (0x00) in
the written file, turning the source file binary to git (`file` reported
"data", `git diff` showed "Bin 0 -> N bytes") — the exact defect (F6) I was
supposed to be fixing, reintroduced in a different file.

**Why:** The tool-call parameter pipeline appears to interpret some
backslash-escape sequences rather than passing them through as literal text,
at least for `\xNN` forms. This is not something to catch by eye — the Read
tool's rendering of the file also hides the raw byte, so a visual re-read
does not reveal it.

**How to apply:** After any edit intended to embed a control-character
escape sequence as *source text* (not an actual control byte), verify with a
byte-level check, e.g. `python3 -c "print(open(path,'rb').read().find(b'\x00'))"`
or `file <path>` (raw NUL makes `file` report "data" instead of a text type).
If a raw byte did get inserted, don't retype the escape by hand — construct
the value programmatically instead, e.g.
`new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}]`)`
instead of `/[\x00-\x1f]/`, or use a Python `bytes.replace` pass via Bash to
inject the literal two-character escape text precisely. Check every file you
touch in a change for stray NUL bytes before committing, not just the one
file the review named.
