---
name: reference-vitest-dynamic-import-no-alias
description: A dynamic `import(variableSpecifier)` in a vitest test is NOT rewritten by vite/vitest resolve.alias or test.alias, even with a matching RegExp find — use a real file at the exact relative path instead of aliasing it away.
metadata:
  type: reference
---

ISS-0003's locked acceptance tests (`tests/acceptance/ISS-0003/*.test.ts`)
all do `await import(HARNESS_MODULE_PATH)` where `HARNESS_MODULE_PATH` is a
`const` one line above, not a string literal inline in the `import(...)`
call. Tried redirecting that non-literal specifier to the canonical harness
module via vitest.config.ts `resolve.alias` / `test.alias` (string exact
match, then a RegExp matching the resolved root-relative id, e.g.
`/\/support\/harness$/`) — neither intercepted it. The import kept failing
to resolve, even though a *static* `import './support/harness'` (literal in
source) would very likely have been alias-rewritten fine.

**Why this matters:** don't burn time trying to alias away a dynamic
`import(nonLiteralSpecifier)` in vite-node/vitest — the alias/resolve
pipeline does not appear to see it the same way it sees statically
analyzable imports, in this vitest 4.1.10 setup. This cost real turns
figuring out (confirmed via a throwaway `tests/alias-check.test.ts`).

**How to apply:** when a locked test imports a relative path that doesn't
exist yet (e.g. `./support/harness`), just create a real file there — a
thin re-export barrel (`export * from "../../harness/index.js"`) pointing
at the canonical implementation — rather than reaching for a vitest alias.
This is also literally what the spec's copy-the-harness convention expects
every later issue to do in its own directory.

Related, same debugging session: `os.tmpdir()`/`$TMPDIR` on this macOS
sandbox resolves through a `/tmp` -> `/private/tmp` symlink. `git`'s
absolute-path output (e.g. `--git-common-dir` from inside a worktree) comes
back already resolved through that symlink, but a raw `path.resolve()` of
a non-realpathed tmp base won't match. Call `fs.realpathSync()` on the
tmpdir-repo factory's base directory immediately after `mkdtempSync`, before
deriving `root`/`home` from it, so every path handed to callers is already
canonical and compares equal to whatever git reports.
