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

// The two lines init.ts ensures on every `.gitignore` it touches (main
// checkout and every worktree) -- named here so uninstall (ISS-0022) has one
// place to import the exact list from instead of re-deriving it. init.ts
// itself still passes its own literal array (outside this issue's
// file-ownership); a future change to that list breaks the byte-identical
// acceptance test loudly (a leftover or missing line fails the tree
// comparison) even though the two lists are not structurally the same
// reference.
export const COREARTIFACT_GITIGNORE_LINES = [".coreartifact/", ".claude/settings.local.json"];

function normalizeLines(content: string): Set<string> {
  return new Set(
    content
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

// Pure: the exact bytes ensureGitignoreLines would write for `existingContent`
// -- no disk I/O -- so uninstall (ISS-0022) can recompute what init would
// have written from the pre-init snapshot, to tell "untouched since init"
// (safe to byte-restore the snapshot verbatim) apart from "edited since
// init" (must surgically strip only the lines init itself appended, via
// removeGitignoreLines below, preserving the edit).
export function computeGitignoreOutput(existingContent: string, linesToEnsure: string[]): string {
  const existingLines = normalizeLines(existingContent);
  const missing = linesToEnsure.filter((line) => !existingLines.has(line));
  if (missing.length === 0) return existingContent;
  const base = existingContent.length === 0 || existingContent.endsWith("\n") ? existingContent : `${existingContent}\n`;
  return `${base}${missing.join("\n")}\n`;
}

// Returns true if the file was changed (at least one line was missing and
// got appended), false if every requested line was already present.
export function ensureGitignoreLines(gitignorePath: string, linesToEnsure: string[]): boolean {
  const existingContent = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf8") : "";
  const updated = computeGitignoreOutput(existingContent, linesToEnsure);
  if (updated === existingContent) return false;
  writeFileSync(gitignorePath, updated);
  return true;
}

// The subset of `linesToEnsure` init ITSELF actually appended for this one
// file, computed against that file's own pre-init content -- exactly the
// same "missing" computation computeGitignoreOutput above performs, exposed
// separately so uninstall's strip path (removeGitignoreLines below) never
// removes a line just because it happens to match the static
// COREARTIFACT_GITIGNORE_LINES list (reviewer finding F102): if the user's
// PRE-INIT .gitignore already contained `.coreartifact/`, init appended
// nothing for that line, so uninstall must never strip it even though it's
// on the list -- only lines init's own merge actually added are ours to
// remove.
export function linesInitAdded(preInitContent: string, linesToEnsure: string[]): string[] {
  const preInitLines = normalizeLines(preInitContent);
  return linesToEnsure.filter((line) => !preInitLines.has(line));
}

// Inverse of computeGitignoreOutput (ISS-0022 uninstall): removes exactly
// `linesToRemove` from `content`, wherever they appear, preserving every
// other line, its order, and `content`'s own trailing-newline state -- never
// the pre-init file's, since `content` here is the CURRENT file, which may
// carry lines appended after init ran. Matches by EXACT line bytes, never
// trimmed (reviewer finding F102): a user's own `  .coreartifact/  ` (with
// incidental whitespace) is the user's line, not the exact bytes init wrote,
// so it must never be treated as init's own entry and stripped.
export function removeGitignoreLines(content: string, linesToRemove: string[]): string {
  const remove = new Set(linesToRemove);
  const hadTrailingNewline = content.length > 0 && content.endsWith("\n");
  const allLines = content.split("\n");
  const lines = hadTrailingNewline ? allLines.slice(0, -1) : allLines;
  const kept = lines.filter((line) => !remove.has(line));
  if (kept.length === 0) return "";
  return hadTrailingNewline ? `${kept.join("\n")}\n` : kept.join("\n");
}
