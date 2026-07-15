---
name: sandbox-no-network-types-node
description: The issue sandbox has no network — pnpm add fails and a bare pnpm install can wipe node_modules; Node builtin types already resolve via the committed lockfile's transitive @types/node (pulled in by vitest), so no action is needed to typecheck node:fs/node:sqlite imports. Never hand-roll an ambient node shim d.ts — ISS-0001's shim shadowed the real types and drew three reviewer S2s.
metadata:
  type: reference
---

The dispatch sandbox blocks the network. Consequences, all observed on
PRD-0001 (implementers tried to bank this nine separate times across
ISS-0001/0003/0004/0008/0009/0010/0011/0012 and were denied by the write
guard each time; the PRD-0001 retro banked it here):

- `pnpm add <pkg>` cannot reach the registry and fails.
- A bare `pnpm install` can prune a working `node_modules` and cannot
  restore it — do not run it to "fix" anything; the checkout arrives
  installed.
- `@types/node` is already on disk at `node_modules/@types/node`, pulled
  transitively by vitest through the committed `pnpm-lock.yaml`. Imports of
  `node:fs`, `node:sqlite`, `process`, `Buffer` typecheck with zero action.

**How to apply:** if a Node builtin fails to typecheck, the cause is never
"missing @types/node — add a shim". Check what shadowed it. A hand-rolled
`node-shim.d.ts` inside `src/` typechecks the current slice against a
fiction and breaks every later slice (ISS-0001, three S2 findings, removed
during the ISS-0001 split). Do not attempt `pnpm add @types/node` either —
no network, and the types are already present.
