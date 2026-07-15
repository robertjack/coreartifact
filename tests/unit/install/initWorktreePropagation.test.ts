// Regression test for the S1 review finding on ISS-0005: worktree
// propagation must merge into a pre-existing worktree settings.local.json,
// never blind-overwrite it. A worktree — the exact place aeh runs isolated
// agents — commonly carries its own gitignored settings.local.json with
// per-worktree permissions/user keys; `init` destroying them is precisely
// the harm the spec's merge-never-clobber law exists to prevent.
//
// This lives in tests/unit/install/ (not tests/acceptance/ISS-0005/, which
// is locked) because the acceptance R3 test only exercises a *freshly
// created* worktree with no pre-existing settings file, so it cannot catch
// this regression. Uses the acceptance harness's primitives directly, same
// as the acceptance suite, since exercising this end-to-end through the
// built CLI is the only way to prove the real write path is merge-safe.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTmpRepo, runCli, addWorktree, type TmpRepo } from "../../acceptance/harness/index.js";

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
});
