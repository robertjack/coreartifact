// Captures the raw, pre-init bytes (or absence) of every settings.local.json
// and .gitignore `init` is about to write, so `uninstall` (ISS-0022) can
// restore them byte-for-byte later without re-serializing anything.
//
// Why this lives here instead of in `init.ts`: init.ts's own read of a
// pre-existing settings.local.json happens through a local, unexported
// `readExistingSettings` and is immediately followed by a full
// `JSON.stringify(merged, null, 2)` rewrite that destroys the original
// file's whitespace/formatting -- by the time that rewrite lands there is
// no code path left that has seen the true original bytes. init.ts is
// outside this issue's file-ownership, so this module instead piggybacks on
// `mergeHookConfig` (src/install/hookConfig.ts), the one settings-related
// function init.ts calls with `repoRoot` BEFORE either the settings write or
// the gitignore write happen for the main checkout, and before the worktree
// propagation loop starts at all -- see hookConfig.ts's call site for why
// that ordering makes a single capture-here-and-now sufficient for every
// path init is about to touch, worktrees included.
//
// @types/node is unreachable in this sandbox (no network, nothing cached --
// see src/core/paths.ts) -- every node:fs import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn, mkdirSync as mkdirSyncFn, readFileSync as readFileSyncFn, writeFileSync as writeFileSyncFn } from "node:fs";
import { listOtherWorktreePaths } from "./gitRepo.js";

const existsSync = existsSyncFn as (path: string) => boolean;
const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;
const writeFileSync = writeFileSyncFn as (path: string, data: string) => void;

function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

export interface BackupEntry {
  existed: boolean;
  // Present iff existed is true -- the file's exact raw bytes, read before
  // anything wrote to it. Absent (never "") when the file never existed, so
  // absence-vs-empty-file stays distinguishable (docs/gotchas.md #5).
  content?: string;
}

export interface InstallBackup {
  v: 1;
  entries: Record<string, BackupEntry>;
}

export function installBackupPath(repoRoot: string): string {
  return joinPath(repoRoot, ".coreartifact", "install-backup.json");
}

function readBackupFile(path: string): InstallBackup {
  if (!existsSync(path)) return { v: 1, entries: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      "entries" in parsed &&
      typeof (parsed as { entries: unknown }).entries === "object"
    ) {
      return { v: 1, entries: (parsed as { entries: Record<string, BackupEntry> }).entries };
    }
  } catch {
    // A damaged or unparseable manifest folds to empty rather than
    // aborting init -- the same degrade-not-abort posture readRegistry
    // takes for its own log.
  }
  return { v: 1, entries: {} };
}

// First capture wins: re-running `init` (idempotent by design) must never
// overwrite an already-captured true original with the now-merged content
// from a prior init run.
function captureOne(backup: InstallBackup, targetPath: string): void {
  if (targetPath in backup.entries) return;
  if (existsSync(targetPath)) {
    backup.entries[targetPath] = { existed: true, content: readFileSync(targetPath, "utf8") };
  } else {
    backup.entries[targetPath] = { existed: false };
  }
}

// Idempotent and entirely best-effort: called from `mergeHookConfig`, which
// existing unit tests (tests/unit/install/hookConfig.test.ts) call directly
// with fabricated, nonexistent repo roots like "/repo" -- this must never
// touch disk or throw for those. A real `init` run always passes a real,
// existing, already-git-validated repo root (resolveRepoRoot succeeded
// before mergeHookConfig is ever reached), so the existsSync guard below is
// what keeps unit-test calls inert while real installs capture normally.
export function captureInstallBackup(repoRoot: string): void {
  if (!existsSync(repoRoot)) return;
  try {
    const backupPath = installBackupPath(repoRoot);
    const backup = readBackupFile(backupPath);

    // Every worktree is enumerated and captured HERE, on the first call
    // (the main checkout's), before init's own worktree-propagation loop
    // has written anything -- see this module's header comment for why that
    // ordering is what makes one capture point enough for every worktree
    // too, without init.ts ever passing a worktree path into this function.
    const roots = [repoRoot, ...listOtherWorktreePaths(repoRoot)];
    for (const root of roots) {
      captureOne(backup, joinPath(root, ".claude", "settings.local.json"));
      captureOne(backup, joinPath(root, ".gitignore"));
    }

    mkdirSync(joinPath(repoRoot, ".coreartifact"), { recursive: true });
    writeFileSync(backupPath, JSON.stringify(backup));
  } catch {
    // Best-effort: a failure here must never break `init`. A repo where it
    // fails degrades uninstall to its structural fallback (remove entirely)
    // for the affected path rather than a byte-perfect restore.
  }
}

export function readInstallBackup(repoRoot: string): InstallBackup {
  return readBackupFile(installBackupPath(repoRoot));
}
