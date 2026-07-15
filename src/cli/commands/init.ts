// `coreartifact init` — install per-repo capture, idempotently, and
// propagate to worktrees (docs/issues/ISS-0005.md).
//
// Exactly five things are installed, all named on stdout (spec "Output"):
// hook config (merged into .claude/settings.local.json), the hook artifact
// (copied into .coreartifact/hooks/), the spool + ledger location
// (.coreartifact/, created but not populated), a .gitignore line for both
// written paths, and a registry entry. Nothing else touches the repo tree.
//
// @types/node is unreachable in this sandbox (no network, nothing cached —
// see src/core/paths.ts) — every node:fs import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { mkdirSync as mkdirSyncFn, writeFileSync as writeFileSyncFn, readFileSync as readFileSyncFn, existsSync as existsSyncFn, copyFileSync as copyFileSyncFn } from "node:fs";
import { getPaths } from "../../core/paths.js";
import { addLedger } from "../../core/registry.js";
import { resolveRepoRoot, listOtherWorktreePaths, isTrackedByGit } from "../../install/gitRepo.js";
import { mergeHookConfig } from "../../install/hookConfig.js";
import { ensureGitignoreLines } from "../../install/gitignore.js";
import { resolveHookArtifactSource } from "../../install/hookArtifactSource.js";

declare const process: {
  cwd(): string;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};

const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const writeFileSync = writeFileSyncFn as (path: string, data: string) => void;
const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;
const existsSync = existsSyncFn as (path: string) => boolean;
const copyFileSync = copyFileSyncFn as (src: string, dest: string) => void;

function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

// A pre-existing settings file that fails to parse as a JSON object is
// treated as absent (an empty base to merge onto) rather than aborting
// `init` — losing an unparseable file's malformed content is not the same
// promise as losing a valid one's keys, and `init` must still leave the
// repo in a working, captured state.
function readExistingSettings(settingsPath: string): Record<string, unknown> {
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to the empty base
  }
  return {};
}

export async function initCommand(): Promise<number> {
  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(process.cwd());
  } catch {
    process.stderr.write(
      "coreartifact init: not a git repository (or any parent up to the mount point)\n",
    );
    return 1;
  }

  const paths = getPaths(repoRoot);
  const lines: string[] = [];

  // 1. Hook artifact — copied, never referenced in place, so it is still
  // reachable after an npx cache eviction.
  mkdirSync(joinPath(repoRoot, ".coreartifact", "hooks"), { recursive: true });
  copyFileSync(resolveHookArtifactSource(), paths.hookArtifact);
  lines.push(`hook artifact:  ${paths.hookArtifact}`);

  // 2. Spool + ledger location — the directory exists now; the ledger
  // itself is created lazily by the first ingest.
  lines.push(`spool:          ${paths.spool}`);
  lines.push(`ledger:         ${paths.ledger}`);

  // 3. Hook config — merged into .claude/settings.local.json, never
  // clobbering unrelated keys or a non-coreartifact entry on another event.
  const settingsPath = joinPath(repoRoot, ".claude", "settings.local.json");
  const existingSettings = readExistingSettings(settingsPath);
  const mergedSettings = mergeHookConfig(existingSettings, paths.hookArtifact, repoRoot);
  const settingsText = `${JSON.stringify(mergedSettings, null, 2)}\n`;
  mkdirSync(joinPath(repoRoot, ".claude"), { recursive: true });
  writeFileSync(settingsPath, settingsText);
  lines.push(`hook config:    ${settingsPath}`);

  // 4. Gitignore — append-only, and covers BOTH written paths (closing the
  // leak where an un-ignored settings.local.json is the first thing to
  // create that file and a later `git add -A` commits it).
  const gitignorePath = joinPath(repoRoot, ".gitignore");
  const gitignoreChanged = ensureGitignoreLines(gitignorePath, [
    ".coreartifact/",
    ".claude/settings.local.json",
  ]);
  lines.push(
    gitignoreChanged
      ? `gitignore:      appended .coreartifact/ and .claude/settings.local.json to ${gitignorePath}`
      : `gitignore:      ${gitignorePath} already covers .coreartifact/ and .claude/settings.local.json`,
  );

  if (isTrackedByGit(repoRoot, ".coreartifact")) {
    lines.push(
      `WARNING:        .coreartifact/ is already tracked by a prior commit — appending it to .gitignore ` +
        `does not untrack it, and the spool stores session payloads verbatim. Run ` +
        `"git rm -r --cached .coreartifact" to stop tracking it.`,
    );
  }

  // 5. Registry entry — the registry module's own fold guarantees
  // uniqueness by repo root, so this is always safe to append.
  await addLedger(repoRoot);
  lines.push(`registry:       added ${repoRoot} to ${paths.registry}`);

  // Propagation — merge the same hook config into every worktree checkout
  // that already exists at install time (spec "Propagation to existing
  // worktrees"). A worktree commonly carries its own gitignored
  // settings.local.json (per-worktree permissions/user keys) — read-merge-
  // write it exactly like the main checkout, never blind-overwrite it, or
  // an agent's worktree-local keys are destroyed by `init`. A worktree
  // created after `init` stays uncaptured until ingest's warning names it,
  // or until `init` is re-run.
  for (const worktreePath of listOtherWorktreePaths(repoRoot)) {
    const worktreeSettingsPath = joinPath(worktreePath, ".claude", "settings.local.json");
    const existingWorktreeSettings = readExistingSettings(worktreeSettingsPath);
    const mergedWorktreeSettings = mergeHookConfig(existingWorktreeSettings, paths.hookArtifact, repoRoot);
    const worktreeSettingsText = `${JSON.stringify(mergedWorktreeSettings, null, 2)}\n`;
    mkdirSync(joinPath(worktreePath, ".claude"), { recursive: true });
    writeFileSync(worktreeSettingsPath, worktreeSettingsText);
    lines.push(`propagated:     ${worktreeSettingsPath}`);
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
