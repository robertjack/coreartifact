---
name: import-meta-main-single-file-entrypoint
description: When a spec bans path-comparison entrypoint guards (fileURLToPath(import.meta.url) === argv[1], breaks on symlinks) but the file must still be static-importable by unit tests without side effects, import.meta.main (native Node, unflagged since 22.12, confirmed on this repo's pinned Node 24) is the correct replacement — not a reintroduction of the banned guard.
metadata:
  type: reference
---

On ISS-0004 (the capture hook artifact, 2026-07-14 rescue dispatch), the
spec forbade any entrypoint guard, specifically the pattern
`fileURLToPath(import.meta.url) === process.argv[1]` (this repo's ISS-0001
S0 bug, twice-committed) — because that specific manual path comparison
breaks under any symlinked install path (npx cache, node_modules/.bin, /tmp
on macOS): the ESM loader realpaths the main module but Node does not
realpath `argv[1]`, so they diverge and the guard silently reads false.

But the artifact is also a **single self-contained file** (no sibling
module to split entry from pure logic into, unlike `src/cli/bin.ts` /
`src/cli/index.ts`), and `tests/unit/hook/` needs to statically import its
pure exported functions in-process. An unconditional top-level
`main().finally(() => process.exit(0))` — the literal "no guard, run
unconditionally" reading of the spec — kills the vitest worker the instant
any unit test file imports the module.

`import.meta.main` resolves this: it is a native Node/V8 property (Node
tracks internally which module object started the process), not a manual
string comparison, so it does NOT share the symlink-divergence failure mode.
Verified directly on this repo's environment (Node 24.18.0):

```
node mod.mjs                    -> import.meta.main === true
node <symlink-to-mod.mjs>       -> import.meta.main === true   (survives symlinks)
import("./mod.mjs") from another module -> import.meta.main === false (safe for unit-test imports)
```

TypeScript's `ImportMeta` lib type does not yet declare `.main` — access it
via `(import.meta as any).main` rather than trying to interface-merge
`ImportMeta` (that merge silently fails to attach under this repo's tsconfig
even though it looks like it should type-check).

**How to apply:** if a spec bans "entrypoint guard" language broadly but the
file also needs to be safely importable by tests without running its
top-level effect, don't literally delete all conditionals — replace the
banned *path-comparison* mechanism with `import.meta.main`, and write the
justification inline (a reviewer pattern-matching on "no guard" language
may flag it on sight; the acceptance test that invokes the artifact through
a real symlink is the executable proof it isn't the banned bug reborn).
