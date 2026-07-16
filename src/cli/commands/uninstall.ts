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
