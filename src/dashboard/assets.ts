// Serves the built SPA out of dist/web/ — the asset-root contract ISS-0026
// established (docs/issues/ISS-0027.md) — and defends the asset root against
// path traversal.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:fs and node:url imports below are
// `@ts-ignore`d at the import site and re-typed through local interfaces,
// same pattern as src/install/hookArtifactSource.ts.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn, statSync as statSyncFn, readFileSync as readFileSyncFn } from "node:fs";
// @ts-ignore -- node:url has no ambient types available in this sandbox
import { fileURLToPath as fileURLToPathFn } from "node:url";

const existsSync = existsSyncFn as (path: string) => boolean;
const statSync = statSyncFn as (path: string) => { isFile(): boolean };
const readFileSync = readFileSyncFn as (path: string) => Uint8Array;
const fileURLToPath = fileURLToPathFn as (url: string) => string;

// Hand-rolled dirname: node:path has the same unresolvable-ambient-types
// problem as node:fs/node:url in this sandbox (src/install/hookArtifactSource.ts's
// `dirnameOf` precedent).
function dirnameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

// This module compiles to dist/dashboard/assets.js; the built SPA lands at
// dist/web/ (a sibling of dist/dashboard/), the asset-root contract
// ISS-0026 established. Resolved relative to this module's own location,
// never assumed as a fixed path, so it still works installed under
// node_modules or reached through a symlinked bin.
export function getAssetRoot(): string {
  const dashboardDir = dirnameOf(fileURLToPath(import.meta.url)); // dist/dashboard
  const distRoot = dirnameOf(dashboardDir); // dist
  return `${distRoot}/web`;
}

// Decodes the ENTIRE pathname before it is ever split on "/". A percent-
// encoded separator (`%2f`) decodes to a literal `/` here, so it splits into
// its own segment same as a literal one would — decoding per-segment AFTER
// the split (the prior approach) let `%2e%2e%2f%2e%2e%2f...` survive as one
// opaque segment (never equal to ".."), which got pushed whole and only
// re-interpreted as `../../..` by the OS once existsSync/readAsset touched
// the resolved string, escaping the asset root despite passing the
// string-prefix containment check below. A malformed escape anywhere falls
// the whole pathname back to its raw (still percent-encoded) form, never a
// partially-decoded mix.
function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

export type ResolvedRequestPath =
  | { kind: "outside-root" }
  | { kind: "file"; filePath: string }
  | { kind: "shell" };

// Resolves a request pathname against the asset root the same way real
// filesystem path resolution would: `..` segments pop the accumulated stack
// with NO floor clamp, so a traversal attempt that pops PAST the asset
// root's own segments genuinely lands outside it and is detected as such —
// never silently clamped back inside (api.md Surface A #3 / the GET wall:
// traversal is checked before the asset-vs-shell decision below).
export function resolveRequestPath(
  pathname: string,
  assetRoot: string = getAssetRoot(),
): ResolvedRequestPath {
  const rootSegments = assetRoot.split("/").filter((s) => s.length > 0);
  const segments = [...rootSegments];

  const decodedPathname = decodePathname(pathname);
  for (const part of decodedPathname.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      segments.pop();
    } else {
      segments.push(part);
    }
  }

  const resolved = `/${segments.join("/")}`;
  if (resolved !== assetRoot && !resolved.startsWith(`${assetRoot}/`)) {
    return { kind: "outside-root" };
  }

  if (existsSync(resolved) && statSync(resolved).isFile()) {
    // The shell itself is never treated as "a real asset file" even when
    // requested by its literal path — api.md's no-store rule applies to it,
    // never the long-lived caching a real content-hashed asset gets.
    if (resolved === `${assetRoot}/index.html`) return { kind: "shell" };
    return { kind: "file", filePath: resolved };
  }

  return { kind: "shell" };
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export function contentTypeFor(filePath: string): string {
  const idx = filePath.lastIndexOf(".");
  const ext = idx === -1 ? "" : filePath.slice(idx).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function readShell(assetRoot: string = getAssetRoot()): Uint8Array {
  return readFileSync(`${assetRoot}/index.html`);
}

export function readAsset(filePath: string): Uint8Array {
  return readFileSync(filePath);
}
