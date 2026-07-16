// `coreartifact uninstall` -- the way out (docs/issues/ISS-0022.md). Thin
// CLI wrapper: resolve the repo, check it is actually registered, gate on
// consent, then hand off to src/install/uninstall.ts for the real work.
declare const process: {
  cwd(): string;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};

import { resolveRepoRoot } from "../../install/gitRepo.js";
import { readRegistry } from "../../core/registry.js";
import { computePlan, formatInventory, performUninstall, realConsentIO, resolveConsent } from "../../install/uninstall.js";
import { hasUsableInstallBackup, installBackupPath } from "../../install/installBackup.js";

export async function uninstallCommand(args: string[]): Promise<number> {
  const yes = args.includes("--yes");

  let repoRoot: string;
  try {
    repoRoot = resolveRepoRoot(process.cwd());
  } catch {
    process.stderr.write(
      "coreartifact uninstall: not a git repository (or any parent up to the mount point)\n",
    );
    return 1;
  }

  // Idempotence at the edges: a repo that was never initialized, or was
  // already uninstalled (the registry fold already honors the remove
  // tombstone this same command appends), is never guessed at -- exit
  // nonzero, delete nothing.
  const registry = await readRegistry();
  if (!registry.has(repoRoot)) {
    process.stderr.write(
      `coreartifact uninstall: ${repoRoot} is not registered (never initialized, or already uninstalled) -- nothing to do\n`,
    );
    return 1;
  }

  // Reviewer finding F103: a missing/damaged install-backup manifest (e.g.
  // `git clean -fdX` wiped the gitignored `.coreartifact/`) must never
  // silently degrade to "every per-file entry lookup returns undefined, so
  // files are left untouched" while the artifact is still deleted and the
  // registry still tombstoned -- that fabricates success while leaving live
  // hook config behind. Refuse loudly instead: exit nonzero, delete
  // nothing, tombstone nothing (docs/gotchas.md #5).
  if (!hasUsableInstallBackup(repoRoot)) {
    process.stderr.write(
      `coreartifact uninstall: install-backup manifest missing or unreadable at ${installBackupPath(repoRoot)} -- refusing to uninstall without it (this repo's .coreartifact/ directory may have been deleted by something other than coreartifact, e.g. \`git clean -fdX\`). Nothing was deleted. Re-run \`coreartifact init\` to recreate an inventory, or remove ${repoRoot}/.coreartifact and this repo's registry entry by hand if you accept losing byte-identical restoration.\n`,
    );
    return 1;
  }

  const plan = computePlan(repoRoot);
  const inventoryText = formatInventory(plan);

  const consent = await resolveConsent(yes, inventoryText, realConsentIO());
  if (!consent.proceed) {
    process.stderr.write(consent.reason);
    return 1;
  }

  await performUninstall(plan);
  process.stdout.write(`${inventoryText}\nuninstalled ${repoRoot}\n`);
  return 0;
}
