// Locates the BUILT hook artifact `init` copies into a target repo. This
// file compiles to dist/install/hookArtifactSource.js; the compiled hook
// artifact is a sibling under dist/ at dist/hook/capture.js (mirrors
// src/hook/capture.ts -> dist/hook/capture.js). Resolved relative to this
// module's own `import.meta.url` rather than assumed as a fixed path, so it
// still works when the package is installed under node_modules, run via
// npx, or reached through a symlinked bin.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:url import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

// @ts-ignore -- node:url has no ambient types available in this sandbox
import { fileURLToPath as fileURLToPathFn } from "node:url";

const fileURLToPath = fileURLToPathFn as (url: string) => string;

// Hand-rolled dirname: same rationale as src/core/ledger.ts's `dirnameOf` —
// node:path has the same unresolvable-ambient-types problem as node:url in
// this sandbox, and this is the only path operation this file needs.
function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

export function resolveHookArtifactSource(): string {
  const installDir = dirnameOf(fileURLToPath(import.meta.url)); // dist/install
  const distRoot = dirnameOf(installDir); // dist
  return `${distRoot}/hook/capture.js`;
}
