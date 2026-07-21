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
// @ts-ignore -- node:crypto has no ambient types available in this sandbox
import { randomUUID as randomUUIDFn } from "node:crypto";
import { getPaths, joinPath } from "../../core/paths.js";
import { addLedger } from "../../core/registry.js";
import { readState, appendInstall, appendConsent } from "../../core/operatorState.js";
import { resolveRepoRoot, listOtherWorktreePaths, isTrackedByGit } from "../../install/gitRepo.js";
import { mergeHookConfig } from "../../install/hookConfig.js";
import { ensureGitignoreLines } from "../../install/gitignore.js";
import { resolveHookArtifactSource } from "../../install/hookArtifactSource.js";
import { askConsent, realConsentIO } from "../../install/consent.js";

declare const process: {
  cwd(): string;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};

const randomUUID = randomUUIDFn as () => string;

// First init on the machine (docs/issues/ISS-0023.md "Consent at init
// (R10)"): the folded operator state has no install id yet. Generate one,
// append it, then ask (TTY) or default-no (no TTY) and append the answer.
// Both ops are appended exactly once, ever — a second init anywhere on the
// same machine finds an install id already folded and does nothing here.
async function ensureConsentAsked(): Promise<void> {
  const state = await readState();
  if (state.install_id !== null) return;

  const installId = randomUUID();
  await appendInstall(installId);

  const consent = await askConsent(realConsentIO());
  await appendConsent(consent);
}

const mkdirSync = mkdirSyncFn as (path: string, options?: { recursive?: boolean }) => void;
const writeFileSync = writeFileSyncFn as (path: string, data: string) => void;
const readFileSync = readFileSyncFn as (path: string, encoding: "utf8") => string;
const existsSync = existsSyncFn as (path: string) => boolean;
const copyFileSync = copyFileSyncFn as (src: string, dest: string) => void;


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

  // Machine-scoped, not repo-scoped: asked once ever, regardless of which
  // repo's `init` happens to trigger it first (packet R10).
  await ensureConsentAsked();

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

  // Propagation — a worktree is a first-class install target, held to the
  // SAME two guarantees the main checkout gets above, not a lesser copy
  // (spec "Propagation to existing worktrees", 2026-07-14 amendment, S1x2):
  //
  //   1. Merge, never clobber. A worktree commonly carries its own
  //      gitignored settings.local.json (per-worktree permissions/user
  //      keys) — read-merge-write it through the SAME mergeHookConfig
  //      routine the main checkout uses, never blind-overwrite it, or an
  //      agent's worktree-local keys are destroyed by `init`.
  //   2. Gitignore both written paths in the worktree too. A worktree has
  //      its own working tree and its own .gitignore state — the
  //      guarantee does not travel for free. Leaving the propagated
  //      settings.local.json committable in the worktree reintroduces the
  //      exact leak this issue exists to close, one directory over. The
  //      worktree's own .coreartifact/ (if a session ever writes one) is
  //      covered by the same line for the same reason, even though R3
  //      attribution routes worktree sessions into the MAIN checkout's
  //      spool and a worktree-local .coreartifact/ is not expected to
  //      exist in the ordinary case.
  //
  // A worktree created after `init` stays uncaptured until ingest's
  // warning names it, or until `init` is re-run.
  for (const worktreePath of listOtherWorktreePaths(repoRoot)) {
    const worktreeSettingsPath = joinPath(worktreePath, ".claude", "settings.local.json");
    const existingWorktreeSettings = readExistingSettings(worktreeSettingsPath);
    const mergedWorktreeSettings = mergeHookConfig(existingWorktreeSettings, paths.hookArtifact, repoRoot);
    const worktreeSettingsText = `${JSON.stringify(mergedWorktreeSettings, null, 2)}\n`;
    mkdirSync(joinPath(worktreePath, ".claude"), { recursive: true });
    writeFileSync(worktreeSettingsPath, worktreeSettingsText);
    lines.push(`propagated:     ${worktreeSettingsPath}`);

    const worktreeGitignorePath = joinPath(worktreePath, ".gitignore");
    const worktreeGitignoreChanged = ensureGitignoreLines(worktreeGitignorePath, [
      ".coreartifact/",
      ".claude/settings.local.json",
    ]);
    lines.push(
      worktreeGitignoreChanged
        ? `gitignore:      appended .coreartifact/ and .claude/settings.local.json to ${worktreeGitignorePath}`
        : `gitignore:      ${worktreeGitignorePath} already covers .coreartifact/ and .claude/settings.local.json`,
    );
  }

  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
