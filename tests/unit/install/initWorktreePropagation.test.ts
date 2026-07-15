// Regression tests for the S1 (S1a merge, S1b gitignore) review findings on
// ISS-0005: worktree propagation must be held to the SAME two guarantees the
// main checkout's install path already gets, not a lesser, unsafe copy
// (docs/issues/ISS-0005.md, "Propagation to existing worktrees", 2026-07-14
// amendment):
//
//   S1a — merge into a pre-existing worktree settings.local.json, never
//   blind-overwrite it. A worktree — the exact place aeh runs isolated
//   agents — commonly carries its own gitignored settings.local.json with
//   per-worktree permissions/user keys; `init` destroying them is precisely
//   the harm the spec's merge-never-clobber law exists to prevent.
//
//   S1b/S2 — the propagated settings.local.json must be gitignored IN THE
//   WORKTREE, by the same rule the main checkout follows. A worktree has its
//   own working tree and its own .gitignore state (it may sit on a
//   different branch/commit than the main checkout, so the main checkout's
//   .gitignore edit does not travel for free) — leaving the propagated file
//   committable reintroduces the exact leak this issue exists to close, one
//   directory over.
//
// This lives in tests/unit/install/ (not tests/acceptance/ISS-0005/, which
// is locked) because the acceptance R3 test only exercises a *freshly
// created* worktree with no pre-existing settings file, so it cannot catch
// either regression. Uses the acceptance harness's primitives directly, same
// as the acceptance suite, since exercising this end-to-end through the
// built CLI is the only way to prove the real write path is merge-safe and
// non-committable.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createTmpRepo, runCli, addWorktree, gitEnv, type TmpRepo } from "../../acceptance/harness/index.js";

function isGitIgnored(cwd: string, home: string, relPath: string): boolean {
  const result = spawnSync("git", ["check-ignore", "-q", relPath], { cwd, env: gitEnv(home) });
  return result.status === 0;
}

function gitStatusPorcelain(cwd: string, home: string): string[] {
  const output = execFileSync("git", ["status", "--porcelain"], { cwd, env: gitEnv(home), encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe("init worktree propagation merges rather than clobbers a pre-existing settings.local.json", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it("preserves a worktree's own precious user keys while still installing the coreartifact hooks", async () => {
    const repo = await createTmpRepo();
    tmpRepos.push(repo);
    const worktree = await addWorktree(repo, "iss5-s1-worktree");

    const worktreeClaudeDir = join(worktree.checkoutPath, ".claude");
    mkdirSync(worktreeClaudeDir, { recursive: true });
    const preexisting = {
      userWorktreeKey: "PRECIOUS",
      permissions: { allow: ["Bash"] },
      hooks: {
        Notification: [{ matcher: "*", hooks: [{ type: "command", command: "some-other-tool" }] }],
      },
    };
    writeFileSync(join(worktreeClaudeDir, "settings.local.json"), JSON.stringify(preexisting, null, 2));

    const result = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
    expect(result.exitCode, `init did not exit 0; stderr: ${result.stderr}`).toBe(0);

    const worktreeSettingsPath = join(worktreeClaudeDir, "settings.local.json");
    expect(existsSync(worktreeSettingsPath), "init did not write the worktree settings file").toBe(true);
    const worktreeSettings = JSON.parse(readFileSync(worktreeSettingsPath, "utf8"));

    expect(worktreeSettings.userWorktreeKey, "init destroyed the worktree's precious user key").toBe("PRECIOUS");
    expect(
      worktreeSettings.permissions,
      "init destroyed the worktree's pre-existing permissions block",
    ).toEqual({ allow: ["Bash"] });
    expect(
      worktreeSettings.hooks?.Notification,
      "init destroyed an unrelated pre-existing hook entry in the worktree",
    ).toEqual(preexisting.hooks.Notification);

    expect(
      Object.keys(worktreeSettings.hooks ?? {}),
      "init did not install the coreartifact hook events into the worktree",
    ).toEqual(expect.arrayContaining(["SessionStart", "PreToolUse", "Stop"]));
  }, 30000);

  it(
    "gitignores the propagated worktree settings.local.json in the worktree's OWN .gitignore state (S1b/S2), " +
      "not just the main checkout's",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const worktree = await addWorktree(repo, "iss5-s1b-worktree");

      const result = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(result.exitCode, `init did not exit 0; stderr: ${result.stderr}`).toBe(0);

      const worktreeSettingsPath = join(worktree.checkoutPath, ".claude", "settings.local.json");
      expect(existsSync(worktreeSettingsPath), "init did not propagate the settings file into the worktree").toBe(
        true,
      );

      // The load-bearing assertion: settings.local.json is git-ignored WITHIN
      // THE WORKTREE's own checkout, not merely in the main checkout.
      expect(
        isGitIgnored(worktree.checkoutPath, repo.home, ".claude/settings.local.json"),
        "the propagated worktree settings.local.json is not git-ignored in the worktree — it is committable, " +
          "reintroducing the exact leak init exists to close, one directory over",
      ).toBe(true);

      // And it must not show up as a committable addition in the worktree's
      // own `git status --porcelain` (the only legitimate remaining change
      // there is the worktree's own .gitignore edit).
      const statusLines = gitStatusPorcelain(worktree.checkoutPath, repo.home);
      for (const line of statusLines) {
        expect(
          line,
          `worktree git status --porcelain shows a coreartifact-written path in a committable state: "${line}"`,
        ).not.toMatch(/settings\.local\.json/);
      }
    },
    30000,
  );
});
