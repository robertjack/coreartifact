---
name: ts-ignore-single-line-only
description: In coreartifact's node:sqlite/node:fs shim files, @ts-ignore only suppresses the very next line — never reflow a suppressed import onto multiple lines.
metadata:
  type: feedback
---

`src/core/ledger.ts` (and similarly `paths.ts`) rely on `// @ts-ignore -- ...`
immediately above a single-line `import { ... } from "node:fs"` to suppress
TS2591 ("Cannot find name 'node:fs'" — no `@types/node` in this sandbox, see
[[reference_sandbox_no_network_types_node]]). Reformatting that import across
multiple lines (e.g. via Prettier or manual edit when adding a new named
import) moves the `from "node:..."` specifier off the suppressed line, and
`tsc` fails again with the same TS2591 — but only surfaces via
`globalSetup`'s `execFileSync(tsc)` inside `pnpm test`, not `pnpm run
typecheck` in isolation necessarily (both actually fail, but the vitest
globalSetup failure is a confusing "no test files found" wrapper error that
obscures the real cause).

**Why:** `@ts-ignore` is a single-line directive; TS does not apply it to a
multi-line statement's continuation lines.

**How to apply:** When adding a new named import to one of these shimmed
`node:*` imports, keep the whole `import { a, b, c } from "node:x"` on ONE
line, however long. Never let a formatter or manual edit wrap it.
