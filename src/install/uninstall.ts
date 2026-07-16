// `coreartifact uninstall` -- exact inversion of `init` (docs/issues/ISS-0022.md).
//
// Byte-identical restoration of a pre-existing settings.local.json/.gitignore
// uses the raw pre-init backup init's `mergeHookConfig` captures
// (src/install/installBackup.ts) and writes it back VERBATIM -- never a
// fresh JSON.stringify/text rebuild, which would re-serialize formatting
// this module never touched (docs/issues/ISS-0022.md, "Invariants").
//
// @types/node is unreachable in this sandbox (no network, nothing cached --
// see src/core/paths.ts) -- every node:fs import below is `@ts-ignore`d at
// the import site and re-typed through a local interface.

// @ts-ignore -- node:fs has no ambient types available in this sandbox
import { existsSync as existsSyncFn, rmSync as rmSyncFn, unlinkSync as unlinkSyncFn, writeFileSync as writeFileSyncFn } from "node:fs";
// @ts-ignore -- node:readline/promises has no ambient types available in this sandbox
import { createInterface as createInterfaceFn } from "node:readline/promises";
import { getPaths, type Paths } from "../core/paths.js";
import { removeLedger } from "../core/registry.js";
import { listOtherWorktreePaths } from "./gitRepo.js";
import { readInstallBackup, type InstallBackup } from "./installBackup.js";

declare const process: {
  stdin: { isTTY?: boolean };
  stdout: { write(chunk: string): boolean };
};

const existsSync = existsSyncFn as (path: string) => boolean;
const rmSync = rmSyncFn as (path: string, options?: { recursive?: boolean; force?: boolean }) => void;
const unlinkSync = unlinkSyncFn as (path: string) => void;
const writeFileSync = writeFileSyncFn as (path: string, data: string) => void;

interface ReadlineInterface {
  question(prompt: string): Promise<string>;
  close(): void;
}
const createInterface = createInterfaceFn as (opts: { input: unknown; output: unknown }) => ReadlineInterface;

function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
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
  return entry?.existed
    ? "restore its pre-init content exactly"
    : "remove entirely (init created it from scratch)";
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
  lines.push(`  registry:       append a remove entry for ${plan.repoRoot} to ${plan.paths.registry}`);
  return lines.join("\n");
}

function restoreOrRemove(backup: InstallBackup, path: string): void {
  const entry = backup.entries[path];
  if (entry?.existed) {
    // Verbatim: entry.content is exactly what readFileSync returned before
    // init ever wrote here -- never re-parsed, never re-serialized.
    writeFileSync(path, entry.content ?? "");
  } else if (existsSync(path)) {
    unlinkSync(path);
  }
}

export async function performUninstall(plan: UninstallPlan, registryPath?: string): Promise<void> {
  for (const target of plan.targets) {
    restoreOrRemove(plan.backup, target.settingsPath);
    restoreOrRemove(plan.backup, target.gitignorePath);
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
