---
name: review-defect-patterns
description: Recurring defect classes found while reviewing coreartifact issue branches, and why green gates do not prove acceptance
metadata:
  type: project
---

# coreartifact review — recurring defect classes

**Green gates (typecheck + `pnpm test` + build) do not prove an acceptance criterion is met.**

**Why:** the `tests/acceptance/ISS-xxxx/` files are written by a *test-author agent* before the
implementation exists (see commit `5412062 "test-author attempt 1"`). They restate the criterion
verbatim in the test name but exercise only the happy shape. On ISS-0001, the criterion
"serializeEnvelope emits exactly one line **for any payload**" was tested with an *object* payload
only; the implementation's `typeof input.event === "string"` raw-text passthrough branch emitted
multi-line and invalid-JSON records and the suite stayed 35/35 green.

**How to apply:** when reviewing any coreartifact branch, re-derive each acceptance criterion by
executing the built code (`dist/`) against adversarial inputs yourself. Specifically probe:
- functions with an **untagged union input** (`unknown` that means "value" *or* "pre-serialized
  text") — this is the repo's most productive break vector;
- the ABSENT law (CLAUDE.md): empty string / null / wrong-type must degrade to key-omitted, never
  fabricate. Check both the writer and the parser.
- module-local `declare const process` shims — these are *deliberate* here (`@types/node` is an
  empty dir in `node_modules/@types/node`, unfetchable offline). They are module-local, not
  `declare global`, and do NOT shadow real node types. Do not re-report them as the attempt-1
  `node-shim.d.ts` defect.

## Break vectors that have paid off (run these every time)

1. **Test the artifact `bin` points at, not the one the test spawns.** The ISS-0001 acceptance
   test spawns `dist/cli.js` (a wrapper that calls `main()` unconditionally) while `package.json`
   `bin` points at `dist/cli/index.js` (guarded by an entrypoint check). The guarded one silently
   exited 0 on an unknown command; the suite was green. **Always run the real bin target, through
   a symlink, and from a path containing `@`.**
2. **Hand-rolled `file://` URL derivation is always wrong.** The repo avoids `node:url` because
   `@types/node` is unfetchable, so implementers hand-roll `toFileUrl` with `encodeURIComponent`.
   It over-escapes `@ , & = + $ ; :` (Node's `pathToFileURL` leaves them raw) and it cannot see
   through symlinks (ESM `import.meta.url` is realpath'd; `process.argv[1]` is not). Both break
   `import.meta.url === toFileUrl(process.argv[1])`, and the failure is a **silent no-op exit 0**.
3. **"Total: never throws" comments are claims, not guarantees.** Check every unguarded
   `JSON.stringify` on an `unknown` — BigInt, circular refs, and a throwing `toJSON`/getter all
   throw `TypeError`. Guarding only `=== undefined` is the usual half-fix.
4. **Byte-scan the diff yourself with python, not `tr`/`grep`.** BSD `tr -dc '\0'` silently
   mis-handles octal escapes and will report clean. A fix commit claiming "escaped the NUL + scanned
   all files" instead *introduced* a raw `0x01` byte. `git diff --numstat` showing no `-`/`Bin` only
   proves git's NUL heuristic didn't trip, not that the bytes are clean.
5. **The catch block is part of the totality contract.** The usual fix for "JSON.stringify throws"
   is `try { ... } catch (err) { return { ok: false, reason: \`...: ${String(err)}\` } }` — but
   `String(err)` *itself* throws when the thrown value has a hostile `Symbol.toPrimitive` /
   `toString` / `message` getter, so the exception escapes the function that promises never to
   throw. A "never throws" wrapper must not stringify an attacker-controlled thrown value; use a
   fixed reason string, or `err instanceof Error ? err.name : "non-Error"`. Found on ISS-0001
   rescue-fix (V2, executed 2026-07-14). Low reachability (JSON-decoded payloads have no getters)
   but it is the literal wording of the criterion.
6. **U+2028/U+2029 is a red herring here** — `JSON.stringify` leaves them raw in the line, but the
   spool splits strictly on `\n`, so they are harmless. Verified; do not inflate it into a finding.

Prior ladder history: ISS-0001 burned two attempt ladders; escalated branches
`escalated/ISS-0001-attempt-1` / `-attempt-2` hold prior implementations.
