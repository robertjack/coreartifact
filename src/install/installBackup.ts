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
import { joinPath } from "../core/paths.js";
// referencesHookArtifact/removeHookConfig: F108 fix below needs both to
// recognize and strip a settings file that ALREADY carries coreartifact's
// own hook entries before recording it as a "pre-init" baseline (see
// captureSettingsFile). Circular with hookConfig.js (which imports
// captureInstallBackup from here) is safe: both imports are only used
// inside function bodies invoked well after both modules finish
// initializing, never at module-eval time.
import { referencesHookArtifact, removeHookConfig } from "./hookConfig.js";

const existsSync = existsSyncFn as (path: string) => boolean;
const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;
const writeFileSync = writeFileSyncFn as (path: string, data: string) => void;


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

// The `.claude` directory's own backup-entry key for a given root -- shared
// between the capture side (above) and uninstall.ts's F104 removal so the
// two never drift on how the key is built.
export function claudeDirBackupKey(root: string): string {
  return joinPath(root, ".claude");
}

// The `.claude/skills` directory's own backup-entry key (ISS-0034 ruling G):
// the same directory-existence pattern as claudeDirBackupKey above, one
// level down, so uninstall can tell "init's own skill install created this
// directory" apart from "a user's own skill already lived here" before
// removing it as an empty parent of the installed skill's own directory.
export function skillsDirBackupKey(root: string): string {
  return joinPath(root, ".claude", "skills");
}

// Reviewer finding F109: `typeof x === "object"` also passes for `[]` and
// `null` -- neither is a usable entries MAP. `[]` folds through as
// "usable, empty," letting uninstall proceed destructively with zero
// per-path entries (the F103 defect through a side door, docs/gotchas.md
// #3's typeof-object trap, cousin of this repo's registry/state folds that
// already exclude exactly these two shapes); `null` throws a raw TypeError
// the moment anything indexes into it.
function isEntriesMap(value: unknown): value is Record<string, BackupEntry> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readBackupFile(path: string): InstallBackup {
  if (!existsSync(path)) return { v: 1, entries: {} };
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && "entries" in parsed && isEntriesMap((parsed as { entries: unknown }).entries)) {
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

// Reviewer finding F108: the F103 recovery path (`init` re-run after
// `.coreartifact/` -- and with it the install-backup manifest -- was wiped
// by something outside coreartifact, e.g. `git clean -fdX`) must never
// capture the settings file AS FOUND when that file already carries
// coreartifact's own hook entries from the lost prior install. Recording
// that polluted content as the "pre-init" baseline means uninstall's
// untouched-since-init branch later restores it verbatim, leaving every
// live hook entry behind, dangling at the just-deleted hook artifact.
//
// Capture-time fix (chosen over a restore-time strip): the strip logic
// (referencesHookArtifact / removeHookConfig) already exists and is shared
// with uninstall's own edited-since-init path, so stripping HERE means the
// recorded baseline is simply correct from the start -- every downstream
// consumer of a BackupEntry (both restore branches, the inventory text)
// keeps treating `content` as "what the user's file looked like before
// coreartifact ever touched it," with no new "was this baseline itself
// polluted" branch needed anywhere else.
//
// A settings file that is unparseable, or parses but doesn't reference the
// hook artifact at all, is returned byte-for-byte unchanged -- only a
// PROVEN-polluted baseline pays the re-serialization cost of losing its
// original formatting (unavoidable: there is no "clean" byte-original left
// to preserve once coreartifact's own entries are already mixed in).
function stripArtifactPollutionForBaseline(raw: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw; // unparseable -- nothing safe to strip, leave as captured
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return raw;
  if (!referencesHookArtifact(parsed)) return raw; // genuinely clean pre-init content
  const stripped = removeHookConfig(parsed as Record<string, unknown>, {});
  return `${JSON.stringify(stripped, null, 2)}\n`;
}

function captureSettingsFile(backup: InstallBackup, targetPath: string): void {
  if (targetPath in backup.entries) return;
  if (!existsSync(targetPath)) {
    backup.entries[targetPath] = { existed: false };
    return;
  }
  const raw = readFileSync(targetPath, "utf8");
  backup.entries[targetPath] = { existed: true, content: stripArtifactPollutionForBaseline(raw) };
}

// Directory existence only -- no `content` (directories have none). Keyed
// by the directory's own path, which never collides with a file entry's key
// (e.g. ".claude" vs ".claude/settings.local.json") in the same `entries`
// map. Reviewer finding F104: uninstall needs to know whether `init` itself
// created the `.claude/` directory (never remove a dir that pre-existed, or
// one a user has since put other content into) before it can safely remove
// an empty one it created.
function captureDirExistence(backup: InstallBackup, dirPath: string): void {
  if (dirPath in backup.entries) return;
  backup.entries[dirPath] = { existed: existsSync(dirPath) };
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
      captureSettingsFile(backup, joinPath(root, ".claude", "settings.local.json"));
      captureOne(backup, joinPath(root, ".gitignore"));
      captureDirExistence(backup, claudeDirBackupKey(root));
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

// A single-path variant of captureInstallBackup (ISS-0034): records ONE
// arbitrary path's pre-touch bytes/absence into the SAME shared manifest,
// first-capture-wins, for callers that touch only one or two paths (the
// installed skill file, its own .gitignore line) rather than the whole
// settings/gitignore/worktree inventory `init` captures for the hook
// config. Sharing the manifest (rather than a second file) is what makes
// "the skill joins the install backup" (spec ruling 2) literally true: one
// inversion oracle for everything `init` has ever written to a repo.
export function captureBackupEntry(repoRoot: string, targetPath: string): void {
  if (!existsSync(repoRoot)) return;
  try {
    const backupPath = installBackupPath(repoRoot);
    const backup = readBackupFile(backupPath);
    captureOne(backup, targetPath);
    mkdirSync(joinPath(repoRoot, ".coreartifact"), { recursive: true });
    writeFileSync(backupPath, JSON.stringify(backup));
  } catch {
    // Best-effort, same posture as captureInstallBackup: never let a
    // capture failure break the caller's install step.
  }
}

// Directory-existence variant of captureBackupEntry (ISS-0034 ruling G):
// records whether `dirPath` existed BEFORE the caller is about to
// (possibly) create it, into the SAME shared manifest, first-capture-wins.
// Used for `.claude/skills` so uninstall can tell "init's own skill install
// created this directory" apart from "a user's own sibling skill already
// lived here" before removing it as an empty parent.
export function captureBackupDirEntry(repoRoot: string, dirPath: string): void {
  if (!existsSync(repoRoot)) return;
  try {
    const backupPath = installBackupPath(repoRoot);
    const backup = readBackupFile(backupPath);
    captureDirExistence(backup, dirPath);
    mkdirSync(joinPath(repoRoot, ".coreartifact"), { recursive: true });
    writeFileSync(backupPath, JSON.stringify(backup));
  } catch {
    // Best-effort, same posture as captureBackupEntry.
  }
}

// Whether repoRoot has a usable install-backup manifest -- reviewer finding
// F103: `readInstallBackup` folds BOTH "the manifest file is entirely
// absent" (e.g. `git clean -fdX` wiped the gitignored `.coreartifact/`) and
// "the manifest is damaged/unparseable" down to the SAME empty-entries
// shape as a real, valid, empty manifest. That fold is correct for
// per-PATH decisions inside uninstall (docs/gotchas.md #5: an uncaptured
// path is never guessed at) but is the wrong signal for the top-level
// question "do we have a reliable inventory of what init did here at all?"
// -- uninstall (src/cli/commands/uninstall.ts) calls this FIRST and refuses
// the whole operation rather than silently proceeding as if nothing had
// ever been installed.
export function hasUsableInstallBackup(repoRoot: string): boolean {
  const path = installBackupPath(repoRoot);
  if (!existsSync(path)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return Boolean(
      parsed && typeof parsed === "object" && "entries" in parsed && isEntriesMap((parsed as { entries: unknown }).entries),
    );
  } catch {
    return false;
  }
}
