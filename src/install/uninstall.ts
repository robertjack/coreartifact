// `coreartifact uninstall` -- exact inversion of `init` (docs/issues/ISS-0022.md).
//
// Byte-identical restoration of a pre-existing settings.local.json/.gitignore
// uses the raw pre-init backup init's `mergeHookConfig` captures
// (src/install/installBackup.ts). Two paths, decided per file by comparing
// the file's CURRENT bytes against what init itself would have written from
// the pre-init snapshot (applyHookConfig/computeGitignoreOutput, both pure
// recomputations of init's own merge logic):
//
//   - Untouched since init (current bytes === init's own output): restore
//     the pre-init snapshot VERBATIM -- never a fresh JSON.stringify/text
//     rebuild, which would re-serialize formatting this module never touched
//     (docs/issues/ISS-0022.md, "Invariants").
//   - Edited since init (e.g. a live session granted itself permissions,
//     appended its own gitignore line): the pre-init snapshot is stale, so
//     restoring it verbatim would silently destroy the edit. Instead
//     surgically strip exactly coreartifact's own entries from the CURRENT
//     bytes (removeHookConfig/removeGitignoreLines), preserving everything
//     else -- reviewer findings S1/S1, round 1.
//
// A settings/gitignore path with NO install-backup entry (never captured --
// a worktree added after init, or a damaged/absent backup manifest) is never
// ours to judge: left untouched entirely, never deleted, never restored
// (docs/gotchas.md #5 -- fail toward "we don't know", never destructive).
//
// @types/node is unreachable in this sandbox (no network, nothing cached --
// see src/core/paths.ts) -- every node:fs import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn, mkdirSync as mkdirSyncFn, readdirSync as readdirSyncFn, readFileSync as readFileSyncFn, rmdirSync as rmdirSyncFn, rmSync as rmSyncFn, unlinkSync as unlinkSyncFn, writeFileSync as writeFileSyncFn } from "node:fs";
// @ts-ignore -- node:readline/promises has no ambient types available in this sandbox
import { createInterface as createInterfaceFn } from "node:readline/promises";
import { getPaths, joinPath, type Paths } from "../core/paths.js";
import { removeLedger } from "../core/registry.js";
import { listOtherWorktreePaths } from "./gitRepo.js";
import { readInstallBackup, installBackupPath, claudeDirBackupKey, skillsDirBackupKey, type InstallBackup, type BackupEntry } from "./installBackup.js";
import { applyHookConfig, removeHookConfig } from "./hookConfig.js";
import { COREARTIFACT_GITIGNORE_LINES, SKILL_GITIGNORE_LINE, computeGitignoreOutput, linesInitAdded, removeGitignoreLines } from "./gitignore.js";
import { skillPathsFor } from "./init.js";

declare const process: {
  stdin: { isTTY?: boolean };
  stdout: { write(chunk: string): boolean };
};

const existsSync = existsSyncFn as (path: string) => boolean;
const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const readdirSync = readdirSyncFn as (path: string) => string[];
const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;
const rmdirSync = rmdirSyncFn as (path: string) => void;
const rmSync = rmSyncFn as (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
const unlinkSync = unlinkSyncFn as (path: string) => void;
const writeFileSync = writeFileSyncFn as (path: string, data: string) => void;

interface ReadlineInterface {
  question(prompt: string): Promise<string>;
  close(): void;
}
const createInterface = createInterfaceFn as (opts: { input: unknown; output: unknown }) => ReadlineInterface;

// Hand-rolled dirname (same rationale as core/registry.ts's dirnameOf): this
// module owns no shared path-join module and node:path's ambient types are
// unreachable in this sandbox.
function dirnameOf(filePath: string): string {
  const idx = filePath.lastIndexOf("/");
  return idx <= 0 ? "/" : filePath.slice(0, idx);
}

export interface UninstallTarget {
  root: string;
  settingsPath: string;
  gitignorePath: string;
}

export interface UninstallPlan {
  repoRoot: string;
  paths: Paths;
  // Main checkout first, then every OTHER worktree -- the same created-vs-
  // merged inversion applies to each (spec "Propagated worktree copies").
  targets: UninstallTarget[];
  backup: InstallBackup;
}

// Reads the worktree list and the install backup manifest once, up front,
// so both the printed inventory and the actual deletion work from the SAME
// snapshot of "what init did here."
export function computePlan(repoRoot: string): UninstallPlan {
  const paths = getPaths(repoRoot);
  const backup = readInstallBackup(repoRoot);
  const roots = [repoRoot, ...listOtherWorktreePaths(repoRoot)];
  const targets: UninstallTarget[] = roots.map((root) => ({
    root,
    settingsPath: joinPath(root, ".claude", "settings.local.json"),
    gitignorePath: joinPath(root, ".gitignore"),
  }));
  return { repoRoot, paths, targets, backup };
}

function describeRestore(backup: InstallBackup, path: string): string {
  const entry = backup.entries[path];
  if (!entry) return "not touched by init -- left as-is";
  return entry.existed
    ? "invert init's merge (restore pre-init content, or strip init's entries if edited since)"
    : "invert init's merge (remove entirely, or strip init's entries if edited since)";
}

export function formatInventory(plan: UninstallPlan): string {
  const lines: string[] = [`coreartifact uninstall will delete, for ${plan.repoRoot}:`];
  lines.push(`  hook artifact:  ${plan.paths.hookArtifact}`);
  lines.push(`  spool:          ${plan.paths.spool}`);
  lines.push(`  ledger:         ${plan.paths.ledger}`);
  lines.push(`  data directory: ${joinPath(plan.repoRoot, ".coreartifact")} (removed entirely)`);
  for (const target of plan.targets) {
    const suffix = target.root === plan.repoRoot ? "" : ` [worktree ${target.root}]`;
    lines.push(`  settings:       ${target.settingsPath}${suffix} -- ${describeRestore(plan.backup, target.settingsPath)}`);
    lines.push(`  gitignore:      ${target.gitignorePath}${suffix} -- ${describeRestore(plan.backup, target.gitignorePath)}`);
  }
  // Re-review Finding 2 (2026-07-21): the destructive-op preview must name
  // everything it deletes — the skill file was removed but never disclosed.
  const skillEntry = plan.backup?.entries?.[skillPathsFor(plan.repoRoot).path];
  if (skillEntry !== undefined) {
    lines.push(`  skill:          ${skillPathsFor(plan.repoRoot).path} -- remove the installed coreartifact SKILL.md`);
  }
  lines.push(`  registry:       append a remove entry for ${plan.repoRoot} to ${plan.paths.registry}`);
  return lines.join("\n");
}

function parseSettingsOrEmpty(text: string): Record<string, unknown> {
  // Mirrors init.ts's own (unexported) readExistingSettings fold: an
  // unparseable pre-init file was an empty merge base to init too, so
  // recomputing "what init wrote" from the same bytes must fold the same
  // way or the two would never agree even with zero interleaved edits.
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the empty base
  }
  return {};
}

function tryParseSettingsObject(text: string): Record<string, unknown> | undefined {
  // Unlike parseSettingsOrEmpty above, a CURRENT file that fails to parse is
  // never folded to `{}` -- init always writes valid JSON, so an unparseable
  // current file means something outside coreartifact corrupted it after
  // init ran. Overwriting or deleting it would be a guess about content we
  // cannot read; leave it untouched instead (docs/gotchas.md #5).
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through
  }
  return undefined;
}

// Settings.local.json is JSON: the "untouched since init" check compares
// against a recomputed applyHookConfig(preInitSettings, ...), and the
// "edited since init" fallback strips via removeHookConfig, both imported
// from hookConfig.ts so this never re-derives init's own merge rules.
function restoreSettingsFile(
  entry: BackupEntry | undefined,
  path: string,
  hookArtifactPath: string,
  repoRoot: string,
): void {
  if (!entry) return; // never captured by init -- not ours to judge, leave untouched

  const preInitContent = entry.existed ? (entry.content ?? "") : "";
  const preInitSettings = parseSettingsOrEmpty(preInitContent);

  if (!existsSync(path)) {
    // Already absent. If init created the file, absence already matches the
    // pre-init snapshot -- nothing to do. If a file existed pre-init and is
    // now gone (removed by something other than coreartifact), byte-identity
    // with the pre-init snapshot still requires it back -- but its parent
    // directory may ALSO be gone (reviewer finding F105, e.g. someone `rm
    // -r .claude`'d the whole directory): recreate it first, or writeFileSync
    // throws ENOENT and wedges uninstall permanently.
    if (entry.existed) {
      mkdirSync(dirnameOf(path), { recursive: true });
      writeFileSync(path, preInitContent);
    }
    return;
  }

  const currentContent = readFileSync(path, "utf8");
  const expectedInitOutput = `${JSON.stringify(applyHookConfig(preInitSettings, hookArtifactPath, repoRoot), null, 2)}\n`;

  if (currentContent === expectedInitOutput) {
    // Untouched since init: safe to byte-restore the pre-init snapshot
    // verbatim -- entry.content is exactly what readFileSync returned before
    // init ever wrote here, never re-parsed, never re-serialized.
    if (entry.existed) {
      writeFileSync(path, preInitContent);
    } else {
      unlinkSync(path);
    }
    return;
  }

  // Edited since init: the pre-init snapshot is stale. Strip only
  // coreartifact's own hook entries from the CURRENT bytes, preserving the
  // edit (reviewer finding, round 1: blindly restoring the snapshot here
  // destroyed post-init user/session edits).
  const currentSettings = tryParseSettingsObject(currentContent);
  if (currentSettings === undefined) return; // can't safely parse -- leave it alone

  const stripped = removeHookConfig(currentSettings, preInitSettings);
  if (!entry.existed && Object.keys(stripped).length === 0) {
    unlinkSync(path);
  } else {
    writeFileSync(path, `${JSON.stringify(stripped, null, 2)}\n`);
  }
}

// Gitignore is line-based, not JSON: the same untouched-vs-edited split as
// restoreSettingsFile above, via computeGitignoreOutput/removeGitignoreLines
// (gitignore.ts) instead of the JSON hook-config helpers. `linesToEnsure` is
// caller-supplied (rather than hardcoded to COREARTIFACT_GITIGNORE_LINES)
// because the skill install (ISS-0034) appends its OWN line
// (SKILL_GITIGNORE_LINE) to the very SAME `.gitignore` file, under the SAME
// shared install-backup entry (one entry per path, keyed by the file, not by
// which install step touched it) -- the caller decides which lines were
// actually part of THIS repo's install (skill included or not) before
// recomputing "what init would have written."
function restoreGitignoreFile(entry: BackupEntry | undefined, path: string, linesToEnsure: string[]): void {
  if (!entry) return; // never captured by init -- not ours to judge, leave untouched

  const preInitContent = entry.existed ? (entry.content ?? "") : "";

  if (!existsSync(path)) {
    if (entry.existed) writeFileSync(path, preInitContent);
    return;
  }

  const currentContent = readFileSync(path, "utf8");
  const expectedInitOutput = computeGitignoreOutput(preInitContent, linesToEnsure);

  if (currentContent === expectedInitOutput) {
    if (entry.existed) {
      writeFileSync(path, preInitContent);
    } else {
      unlinkSync(path);
    }
    return;
  }

  // Only lines init itself added FOR THIS FILE (relative to its own pre-init
  // content) are ours to strip -- never every line on the static list, or a
  // user's own pre-existing `.coreartifact/` entry gets destroyed alongside
  // it (reviewer finding F102).
  const stripped = removeGitignoreLines(currentContent, linesInitAdded(preInitContent, linesToEnsure));
  if (!entry.existed && stripped === "") {
    unlinkSync(path);
  } else {
    writeFileSync(path, stripped);
  }
}

// Removes `.claude/` at `root` iff (a) init's own install-backup manifest
// recorded it as NOT existing pre-init (never a dir the repo already had, or
// one whose creation this uninstall run never captured -- docs/gotchas.md
// #5, never guess), and (b) it is now empty after the settings-file
// inversion above ran (never a dir a user has since put other content into,
// e.g. `.claude/commands/`). Reviewer finding F104: a files-only view of the
// tree left this directory behind invisibly; the operator's amended
// snapshotTree now captures directories, so this is required for the
// byte-identical acceptance bar.
function removeClaudeDirIfInitCreatedAndEmpty(backup: InstallBackup, root: string): void {
  const dirPath = claudeDirBackupKey(root);
  const entry = backup.entries[dirPath];
  if (!entry || entry.existed) return;
  if (!existsSync(dirPath)) return;
  try {
    if (readdirSync(dirPath).length === 0) rmdirSync(dirPath);
  } catch {
    // Best-effort: never let a directory-removal race (something wrote into
    // it between the readdirSync check and the rmdirSync call) fail the
    // rest of uninstall, which has already restored/removed the files that
    // matter.
  }
}

// The skill's own `.claude/skills` parent (ISS-0034 Ruling G: "uninstall
// removes `.claude/skills/coreartifact/` and any then-empty parent it
// created"). Same posture as removeClaudeDirIfInitCreatedAndEmpty above, one
// level down: only removed when init's own install-backup manifest recorded
// this directory as NOT existing pre-init (never a sibling user-authored
// skill's directory), and only once it is empty (i.e. AFTER restoreSkillFile
// below has already removed the coreartifact skill's own now-empty
// subdirectory).
function removeSkillsDirIfInitCreatedAndEmpty(backup: InstallBackup, root: string): void {
  const dirPath = skillsDirBackupKey(root);
  const entry = backup.entries[dirPath];
  if (!entry || entry.existed) return;
  if (!existsSync(dirPath)) return;
  try {
    if (readdirSync(dirPath).length === 0) rmdirSync(dirPath);
  } catch {
    // Best-effort, same posture as removeClaudeDirIfInitCreatedAndEmpty.
  }
}

// The installed skill (ISS-0034): a whole-file inversion, not line/JSON
// based like the two functions above. A pre-existing entry (`existed:
// true`) is unlikely in practice (init never overwrites a real pre-existing
// skill file — see the acceptance test's inversion case, which pre-creates
// a DIFFERENT skill directory) but is still honored for completeness. No
// entry at all (never captured -- a `--no-skill` install, or a repo that
// ran `init` before this feature shipped) is never ours to judge, same
// posture as the settings/gitignore paths above.
function restoreSkillFile(entry: BackupEntry | undefined, skillPath: string, skillDir: string): void {
  if (!entry) return;
  if (entry.existed) {
    writeFileSync(skillPath, entry.content ?? "");
    return;
  }
  if (existsSync(skillPath)) unlinkSync(skillPath);
  try {
    // Only the skill's OWN directory, and only if init's install left it
    // empty -- a sibling user-authored skill (or any other file a user has
    // since put there) keeps `.claude/skills/coreartifact/` from ever being
    // considered empty, so this never removes a directory in active use.
    if (existsSync(skillDir) && readdirSync(skillDir).length === 0) rmdirSync(skillDir);
  } catch {
    // Best-effort, same posture as removeClaudeDirIfInitCreatedAndEmpty
    // below: never let a directory-removal race fail the rest of uninstall.
  }
}

// One target's full inversion: settings, gitignore (base hook-config lines
// plus the skill's own line, IF the skill was installed for this root --
// signaled by the presence of a skillPath backup entry, never guessed), the
// skill file itself, and the two directories (`.claude/skills`, `.claude`)
// it may have created, in the order that makes each an empty-directory
// candidate for the next (ISS-0034 rescue Ruling A: the REAL uninstall path,
// shared by both `performUninstall`'s target loop and the standalone
// `uninstall()` export below -- one inversion implementation, not two).
function restoreTargetFiles(
  backup: InstallBackup,
  target: { root: string; settingsPath: string; gitignorePath: string },
  hookArtifactPath: string,
  repoRoot: string,
): void {
  restoreSettingsFile(backup.entries[target.settingsPath], target.settingsPath, hookArtifactPath, repoRoot);

  const { dir: skillDir, path: skillPath } = skillPathsFor(target.root);
  const skillEntry = backup.entries[skillPath];
  const gitignoreLines = skillEntry !== undefined ? [...COREARTIFACT_GITIGNORE_LINES, SKILL_GITIGNORE_LINE] : COREARTIFACT_GITIGNORE_LINES;
  restoreGitignoreFile(backup.entries[target.gitignorePath], target.gitignorePath, gitignoreLines);

  restoreSkillFile(skillEntry, skillPath, skillDir);
  removeSkillsDirIfInitCreatedAndEmpty(backup, target.root);
  removeClaudeDirIfInitCreatedAndEmpty(backup, target.root);
}

export interface UninstallSkillOptions {
  cwd: string;
  yes?: boolean;
}

// Kept for the locked acceptance test's own import seam
// (tests/acceptance/ISS-0034/init-skill.test.ts calls `init` and `uninstall`
// directly against a plain tmpdir, never through git or the real CLI).
// Rescue Ruling A (finding 196/198): this used to be a SEPARATE, scoped
// implementation with its own manifest-deleting bookkeeping -- deleted
// entirely. This now delegates to the exact same `restoreTargetFiles` the
// real `performUninstall` uses, scoped to a single target (`opts.cwd`, no
// worktree enumeration -- the acceptance test's tmpdir is never a git repo,
// so `listOtherWorktreePaths` is never reachable here) and never touching
// the hook artifact, spool, ledger, or registry -- all of which stay
// strictly out of this thin wrapper's reach (Boundaries: "install-surface
// only"; `getPaths` below only derives repo-relative paths, it never reads
// or writes the global registry root). `yes` exists only for signature
// symmetry with the CLI's consent gate; this function never prompts.
export async function uninstall(opts: UninstallSkillOptions): Promise<void> {
  const repoRoot = opts.cwd;
  const backup = readInstallBackup(repoRoot);
  const paths = getPaths(repoRoot);
  const target = {
    root: repoRoot,
    settingsPath: joinPath(repoRoot, ".claude", "settings.local.json"),
    gitignorePath: joinPath(repoRoot, ".gitignore"),
  };
  restoreTargetFiles(backup, target, paths.hookArtifact, repoRoot);

  // Bookkeeping cleanup scoped to THIS thin wrapper only (never duplicated
  // into `performUninstall`, which already unconditionally removes the
  // whole `.coreartifact/` -- hook artifact, spool, ledger, and manifest
  // together -- as part of a REAL full install's inversion). In this
  // standalone codepath `.coreartifact/` is never created for anything
  // other than the install-backup manifest itself (this module never
  // touches the hook artifact/spool/ledger), so once the manifest this call
  // just consumed is removed, an empty `.coreartifact/` left behind is
  // itself a byte-identical-tree regression the locked acceptance test
  // catches (it walks the WHOLE tree, `.coreartifact/` included).
  try {
    const backupPath = installBackupPath(repoRoot);
    if (existsSync(backupPath)) unlinkSync(backupPath);
    const dataDir = joinPath(repoRoot, ".coreartifact");
    if (existsSync(dataDir) && readdirSync(dataDir).length === 0) rmdirSync(dataDir);
  } catch {
    // Best-effort: never let bookkeeping cleanup fail the actual restore
    // above, which has already completed.
  }
}

export async function performUninstall(plan: UninstallPlan, registryPath?: string): Promise<void> {
  for (const target of plan.targets) {
    restoreTargetFiles(plan.backup, target, plan.paths.hookArtifact, plan.repoRoot);
  }
  // .coreartifact/ holds the hook artifact, the spool, the ledger, and the
  // install-backup manifest itself -- one removal covers all four (spec
  // "The spool and ledger").
  rmSync(joinPath(plan.repoRoot, ".coreartifact"), { recursive: true, force: true });
  await removeLedger(plan.repoRoot, registryPath);
}

// --- Consent gate -----------------------------------------------------
//
// Kept as a pure function of an injected IO seam so the TTY-confirmation
// path -- unreachable at the acceptance subprocess seam (no PTY) -- can be
// unit-tested directly (tests/unit/install/uninstall.test.ts), per this
// issue's Test-harness contract.

export interface ConsentIO {
  isTTY: boolean;
  write(chunk: string): void;
  readLine(promptText: string): Promise<string>;
}

export type ConsentResult = { proceed: true } | { proceed: false; reason: string };

export async function resolveConsent(yes: boolean, inventoryText: string, io: ConsentIO): Promise<ConsentResult> {
  if (yes) return { proceed: true };

  if (!io.isTTY) {
    // Never reads stdin in this branch -- a fleet/non-interactive caller
    // must never hang waiting for input that will never arrive.
    return {
      proceed: false,
      reason:
        "coreartifact uninstall: refusing to delete without confirmation on a non-interactive stdin -- pass --yes to proceed\n",
    };
  }

  io.write(`${inventoryText}\n`);
  const answer = await io.readLine('Type "yes" to permanently delete the above: ');
  if (answer.trim().toLowerCase() === "yes") {
    return { proceed: true };
  }
  return { proceed: false, reason: "coreartifact uninstall: aborted -- no changes made\n" };
}

// The real IO seam `uninstallCommand` wires resolveConsent to: TTY-ness and
// stdout come straight from process, stdin reads go through readline so a
// TTY user gets line-editing/backspace for free.
export function realConsentIO(): ConsentIO {
  return {
    isTTY: Boolean(process.stdin.isTTY),
    write: (chunk) => {
      process.stdout.write(chunk);
    },
    readLine: async (promptText: string) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(promptText);
      } finally {
        rl.close();
      }
    },
  };
}
