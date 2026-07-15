// Appends missing lines to a repo's `.gitignore`, never rewrites it.
// Idempotent: a line already present (exact match, after trimming) is left
// alone, so re-running `init` never adds a second copy.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — the node:fs import below is `@ts-ignore`d at the
// import site and re-typed through a local interface.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn, readFileSync as readFileSyncFn, writeFileSync as writeFileSyncFn } from "node:fs";

const existsSync = existsSyncFn as (path: string) => boolean;
const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;
const writeFileSync = writeFileSyncFn as (path: string, data: string) => void;

// Returns true if the file was changed (at least one line was missing and
// got appended), false if every requested line was already present.
export function ensureGitignoreLines(gitignorePath: string, linesToEnsure: string[]): boolean {
  const existingContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const existingLines = new Set(
    existingContent
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );

  const missing = linesToEnsure.filter((line) => !existingLines.has(line));
  if (missing.length === 0) return false;

  const base = existingContent.length === 0 || existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
  writeFileSync(gitignorePath, `${base}${missing.join("\n")}\n`);
  return true;
}
