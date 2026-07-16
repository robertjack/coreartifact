// Resolves the package's own version for the ping payload (docs/issues/
// ISS-0023.md: "version (the package's own version)"). Same
// import.meta.url-relative pattern src/install/hookArtifactSource.ts uses
// to find the built hook artifact — this file compiles to
// dist/ping/version.js, two directories under the package root.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — every node: import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { readFileSync as readFileSyncFn } from "node:fs";
// @ts-ignore -- node:url has no ambient types available in this sandbox
import { fileURLToPath as fileURLToPathFn } from "node:url";

const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;
const fileURLToPath = fileURLToPathFn as (url: string) => string;

function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

export function resolvePackageVersion(): string {
  const pingDir = dirnameOf(fileURLToPath(import.meta.url)); // dist/ping
  const distRoot = dirnameOf(pingDir); // dist
  const repoRoot = dirnameOf(distRoot); // package root
  const pkg = JSON.parse(readFileSync(`${repoRoot}/package.json`, "utf8")) as { version: string };
  return pkg.version;
}
