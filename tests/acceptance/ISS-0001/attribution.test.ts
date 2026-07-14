import { describe, it, expect } from "vitest";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, realpathSync } from "node:fs";
import { SRC_CORE, mkTmpDir, tryImport } from "./helpers.js";

const ATTRIBUTION_MODULE = path.join(SRC_CORE, "attribution.ts");

function initRepo(dir: string) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "coreartifact-test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "coreartifact test"], { cwd: dir });
  execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: dir });
}

describe("attribution", () => {
  it("resolveAttribution given a cwd inside a git worktree returns the main repo root as the repo root and the worktree checkout path as the worktree path; given a cwd inside a main checkout it returns that root with an absent worktree path; given a non-git cwd it returns the supplied init root fallback", async () => {
    const mod = await tryImport(ATTRIBUTION_MODULE);
    if (!mod) throw new Error("not implemented yet: src/core/attribution.ts");
    const { resolveAttribution } = mod;
    if (!resolveAttribution) throw new Error("not implemented yet: resolveAttribution export");

    const mainDir = mkTmpDir("coreartifact-attr-main-");
    initRepo(mainDir);
    const realMainDir = realpathSync(mainDir);

    const worktreeParent = mkTmpDir("coreartifact-attr-wt-parent-");
    const worktreeDir = path.join(worktreeParent, "wt");
    execFileSync(
      "git",
      ["worktree", "add", "-q", worktreeDir, "-b", "coreartifact-test-branch"],
      { cwd: mainDir },
    );
    const realWorktreeDir = realpathSync(worktreeDir);

    const worktreeResult = await resolveAttribution({ cwd: worktreeDir, initRoot: worktreeDir });
    expect(worktreeResult.repoRoot).toBe(realMainDir);
    expect(worktreeResult.worktreePath).toBe(realWorktreeDir);

    const mainResult = await resolveAttribution({ cwd: mainDir, initRoot: mainDir });
    expect(mainResult.repoRoot).toBe(realMainDir);
    expect(mainResult.worktreePath == null).toBe(true);

    const nonGitDir = mkTmpDir("coreartifact-attr-nongit-");
    const fallbackRoot = "/some/fallback/init-root";
    const nonGitResult = await resolveAttribution({ cwd: nonGitDir, initRoot: fallbackRoot });
    expect(nonGitResult.repoRoot).toBe(fallbackRoot);
    expect(nonGitResult.worktreePath == null).toBe(true);
  });

  it("resolveAttribution classifies a main checkout correctly even when the git dir is not at <repo_root>/.git and even when the cwd is reached by a symlinked path: given a submodule checkout (or a git init --separate-git-dir checkout) it returns that checkout as the repo root with an absent worktree path and never a repo root inside .git; given a symlinked cwd for a main checkout it returns an absent worktree path and the same repo root as the realpathed cwd returns", async () => {
    const mod = await tryImport(ATTRIBUTION_MODULE);
    if (!mod) throw new Error("not implemented yet: src/core/attribution.ts");
    const { resolveAttribution } = mod;
    if (!resolveAttribution) throw new Error("not implemented yet: resolveAttribution export");

    // The git dir lives entirely outside the checkout, so a repo_root that
    // ends up pointing inside a `.git`-ish path would prove the dirname()
    // heuristic the spec forbids is in play.
    const outer = mkTmpDir("coreartifact-attr-sepgit-");
    const externalGitDir = path.join(outer, "external-git-storage");
    const checkoutDir = path.join(outer, "checkout");
    mkdirSync(checkoutDir, { recursive: true });
    execFileSync("git", ["init", "-q", `--separate-git-dir=${externalGitDir}`, checkoutDir]);
    execFileSync("git", ["config", "user.email", "coreartifact-test@example.com"], {
      cwd: checkoutDir,
    });
    execFileSync("git", ["config", "user.name", "coreartifact test"], { cwd: checkoutDir });
    execFileSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd: checkoutDir });
    const realCheckoutDir = realpathSync(checkoutDir);

    const sepGitResult = await resolveAttribution({ cwd: checkoutDir, initRoot: checkoutDir });
    expect(sepGitResult.repoRoot).toBe(realCheckoutDir);
    expect(sepGitResult.worktreePath == null).toBe(true);
    expect(sepGitResult.repoRoot.includes("external-git-storage")).toBe(false);

    // Symlinked cwd for a main checkout must resolve to the same repo root
    // as calling with the already-realpathed cwd.
    const realMainDir = mkTmpDir("coreartifact-attr-symreal-");
    initRepo(realMainDir);
    const realRealMainDir = realpathSync(realMainDir);

    const symlinkParent = mkTmpDir("coreartifact-attr-symparent-");
    const symlinkedCwd = path.join(symlinkParent, "symlinked-checkout");
    symlinkSync(realMainDir, symlinkedCwd, "dir");

    const viaSymlink = await resolveAttribution({ cwd: symlinkedCwd, initRoot: symlinkedCwd });
    const viaRealpath = await resolveAttribution({
      cwd: realRealMainDir,
      initRoot: realRealMainDir,
    });

    expect(viaSymlink.worktreePath == null).toBe(true);
    expect(viaSymlink.repoRoot).toBe(viaRealpath.repoRoot);
    expect(viaSymlink.repoRoot).toBe(realRealMainDir);
  });
});
