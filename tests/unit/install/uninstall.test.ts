// Unit tests for the pieces of ISS-0022's uninstall that the acceptance
// seam (tests/acceptance/ISS-0022/uninstall.test.ts) cannot exercise:
//
//   - the TTY confirmation gate (`resolveConsent`), which the acceptance
//     harness cannot drive because runCli spawns with piped stdio, never a
//     PTY -- this issue's own Test-harness contract routes that path here,
//     with an injected is-TTY/answer seam instead of a real terminal.
//   - the install-backup manifest (`captureInstallBackup`/`readInstallBackup`),
//     the mechanism byte-identical restoration of a pre-existing
//     settings.local.json/.gitignore rests on -- worth proving directly
//     rather than only indirectly through the full CLI subprocess.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { computePlan, performUninstall, resolveConsent, type ConsentIO } from "../../../src/install/uninstall.js";
import { captureInstallBackup, readInstallBackup } from "../../../src/install/installBackup.js";
import { mergeHookConfig } from "../../../src/install/hookConfig.js";
import { ensureGitignoreLines } from "../../../src/install/gitignore.js";
import { getPaths } from "../../../src/core/paths.js";

function fakeIO(overrides: Partial<ConsentIO> & { isTTY: boolean }): ConsentIO {
  return {
    write: () => {},
    readLine: async () => "",
    ...overrides,
  };
}

describe("install/uninstall resolveConsent (TTY confirmation gate)", () => {
  it("--yes proceeds without ever consulting isTTY or reading a line", async () => {
    const readLine = vi.fn(async () => "irrelevant");
    const io = fakeIO({ isTTY: false, readLine });
    const result = await resolveConsent(true, "inventory text", io);
    expect(result).toEqual({ proceed: true });
    expect(readLine).not.toHaveBeenCalled();
  });

  it("no --yes, no TTY: refuses, names --yes, and never reads a line (never hangs)", async () => {
    const readLine = vi.fn(async () => "yes");
    const io = fakeIO({ isTTY: false, readLine });
    const result = await resolveConsent(false, "inventory text", io);
    expect(result.proceed).toBe(false);
    if (!result.proceed) {
      expect(result.reason).toContain("--yes");
    }
    expect(readLine).not.toHaveBeenCalled();
  });

  it("no --yes, TTY, answer 'yes': prints the full inventory first, then proceeds", async () => {
    const written: string[] = [];
    const io = fakeIO({
      isTTY: true,
      write: (chunk) => written.push(chunk),
      readLine: async () => "yes",
    });
    const result = await resolveConsent(false, "full inventory listing", io);
    expect(result).toEqual({ proceed: true });
    expect(written.join("")).toContain("full inventory listing");
  });

  it("no --yes, TTY, answer is not an explicit 'yes': aborts cleanly, no proceed", async () => {
    for (const answer of ["no", "", "y", "  Yes please  "]) {
      const io = fakeIO({ isTTY: true, readLine: async () => answer });
      const result = await resolveConsent(false, "inventory", io);
      expect(result.proceed, `answer ${JSON.stringify(answer)} must not proceed`).toBe(false);
    }
  });

  it("no --yes, TTY, answer 'yes' case/whitespace-insensitively: proceeds", async () => {
    for (const answer of ["yes", "YES", "  yes  ", "Yes"]) {
      const io = fakeIO({ isTTY: true, readLine: async () => answer });
      const result = await resolveConsent(false, "inventory", io);
      expect(result.proceed, `answer ${JSON.stringify(answer)} must proceed`).toBe(true);
    }
  });
});

describe("install/installBackup captureInstallBackup / readInstallBackup", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "iss22-installbackup-unit-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, ".gitkeep"), "");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: repoRoot });
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("records existed:false for settings/gitignore paths that do not exist yet", () => {
    captureInstallBackup(repoRoot);
    const backup = readInstallBackup(repoRoot);
    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const gitignorePath = join(repoRoot, ".gitignore");
    expect(backup.entries[settingsPath]).toEqual({ existed: false });
    expect(backup.entries[gitignorePath]).toEqual({ existed: false });
  });

  it("captures the exact raw bytes of a pre-existing settings.local.json and .gitignore", () => {
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    const settingsBytes = '{"customUserKey":"keep-me-untouched","other":123}';
    const gitignoreBytes = "node_modules/\n*.log";
    writeFileSync(join(repoRoot, ".claude", "settings.local.json"), settingsBytes);
    writeFileSync(join(repoRoot, ".gitignore"), gitignoreBytes);

    captureInstallBackup(repoRoot);

    const backup = readInstallBackup(repoRoot);
    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const gitignorePath = join(repoRoot, ".gitignore");
    expect(backup.entries[settingsPath]).toEqual({ existed: true, content: settingsBytes });
    expect(backup.entries[gitignorePath]).toEqual({ existed: true, content: gitignoreBytes });
  });

  it("first capture wins: a second call does not clobber the true original with what's on disk now", () => {
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    const originalBytes = '{"original":true}';
    writeFileSync(join(repoRoot, ".claude", "settings.local.json"), originalBytes);

    captureInstallBackup(repoRoot);

    // Simulate init's own overwrite happening between two captureInstallBackup
    // calls (e.g. a second `init` run reusing the same call path).
    writeFileSync(join(repoRoot, ".claude", "settings.local.json"), '{"mutated":true,"hooks":{}}');
    captureInstallBackup(repoRoot);

    const backup = readInstallBackup(repoRoot);
    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    expect(backup.entries[settingsPath]).toEqual({ existed: true, content: originalBytes });
  });

  it("never touches disk for a repo root that does not exist (the fabricated paths hookConfig.test.ts uses)", () => {
    const fakeRoot = "/definitely/not/a/real/coreartifact/test/root";
    expect(existsSync(fakeRoot)).toBe(false);
    expect(() => captureInstallBackup(fakeRoot)).not.toThrow();
    expect(existsSync(fakeRoot)).toBe(false);
  });
});

// Reviewer findings, round 1 (docs/issues/ISS-0022.md is silent on both --
// caught only by hand-execution, not by the locked acceptance suite):
//
//   S1 restoreOrRemove's no-backup-entry default was unlinkSync -- a
//   worktree added AFTER init, or any path a damaged/absent install-backup
//   manifest never captured, got DELETED rather than left alone.
//   S1 uninstall restored the stale pre-init snapshot unconditionally --
//   a settings.local.json/.gitignore edit made AFTER init (e.g. a live
//   session granting itself permissions) was silently destroyed.
//
// Exercises computePlan/performUninstall directly against a realistic
// on-disk repo (runRealInit below mirrors init.ts's own settings.local.json
// + .gitignore writes byte-for-byte) rather than through the CLI
// subprocess, so these stay fast, targeted unit tests of the surgical
// inversion logic itself.
describe("install/uninstall performUninstall — surgical inversion of init's merge", () => {
  let repoRoot: string;
  let registryPath: string;

  beforeEach(() => {
    // realpath immediately: macOS tmpdir() commonly resolves through a
    // symlink, and `git worktree list --porcelain` reports paths already
    // resolved through it -- comparing a non-canonical repoRoot against
    // git's canonical worktree output would spuriously mismatch (same
    // rationale as tests/acceptance/harness/tmpRepo.ts).
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "iss22-uninstall-unit-")));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, ".gitkeep"), "");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: repoRoot });
    registryPath = join(mkdtempSync(join(tmpdir(), "iss22-uninstall-unit-registry-")), "registry.jsonl");
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function runRealInit(root: string): void {
    const paths = getPaths(root);
    const settingsPath = join(root, ".claude", "settings.local.json");
    const existing = existsSync(settingsPath)
      ? (JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>)
      : {};
    const merged = mergeHookConfig(existing, paths.hookArtifact, root);
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
    ensureGitignoreLines(join(root, ".gitignore"), [".coreartifact/", ".claude/settings.local.json"]);
  }

  it("preserves a settings.local.json edit made AFTER init (e.g. a session granting itself permissions) instead of reverting it to the stale pre-init snapshot", async () => {
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    writeFileSync(join(repoRoot, ".claude", "settings.local.json"), '{"customUserKey":"keep-me"}');
    runRealInit(repoRoot);

    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const afterInit = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    afterInit.permissions = { allow: ["Bash(pnpm test)"] };
    writeFileSync(settingsPath, `${JSON.stringify(afterInit, null, 2)}\n`);

    const plan = computePlan(repoRoot);
    await performUninstall(plan, registryPath);

    const final = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(final).toEqual({ customUserKey: "keep-me", permissions: { allow: ["Bash(pnpm test)"] } });
  });

  it("preserves a .gitignore line appended AFTER init instead of reverting it to the stale pre-init snapshot", async () => {
    writeFileSync(join(repoRoot, ".gitignore"), "node_modules/\n");
    runRealInit(repoRoot);

    const gitignorePath = join(repoRoot, ".gitignore");
    writeFileSync(gitignorePath, `${readFileSync(gitignorePath, "utf8")}coverage/\n`);

    const plan = computePlan(repoRoot);
    await performUninstall(plan, registryPath);

    const finalLines = readFileSync(gitignorePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(finalLines).toEqual(["node_modules/", "coverage/"]);
  });

  it("a settings.local.json created by init (no pre-init file) is preserved, not deleted, when a post-init edit left it non-empty", async () => {
    runRealInit(repoRoot); // no pre-existing settings file -- init creates it from scratch

    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const afterInit = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    afterInit.permissions = { allow: ["Bash(pnpm test)"] };
    writeFileSync(settingsPath, `${JSON.stringify(afterInit, null, 2)}\n`);

    const plan = computePlan(repoRoot);
    await performUninstall(plan, registryPath);

    expect(existsSync(settingsPath), "a settings file left non-empty by a post-init edit must not be deleted").toBe(
      true,
    );
    const final = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    expect(final).toEqual({ permissions: { allow: ["Bash(pnpm test)"] } });
  });

  it("leaves a settings.local.json / .gitignore pair completely untouched when the install-backup manifest never captured them (e.g. a damaged manifest) -- never deletes files coreartifact never wrote", async () => {
    // No captureInstallBackup call at all for this repoRoot: readInstallBackup
    // folds a missing .coreartifact/install-backup.json to `{ entries: {} }`,
    // exactly the shape a damaged/absent manifest produces too.
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const gitignorePath = join(repoRoot, ".gitignore");
    const settingsBytes = '{"userLocal":"do-not-delete"}';
    const gitignoreBytes = "node_modules/\n";
    writeFileSync(settingsPath, settingsBytes);
    writeFileSync(gitignorePath, gitignoreBytes);

    const plan = computePlan(repoRoot);
    expect(plan.backup.entries[settingsPath], "test setup invariant: this path must be uncaptured").toBeUndefined();
    await performUninstall(plan, registryPath);

    expect(existsSync(settingsPath), "an uncaptured settings.local.json must never be deleted by uninstall").toBe(
      true,
    );
    expect(readFileSync(settingsPath, "utf8")).toBe(settingsBytes);
    expect(existsSync(gitignorePath), "an uncaptured .gitignore must never be deleted by uninstall").toBe(true);
    expect(readFileSync(gitignorePath, "utf8")).toBe(gitignoreBytes);
  });

  it("leaves a worktree's settings.local.json / .gitignore untouched when the worktree was added AFTER init (init.ts's own comment: worktrees added later 'stay uncaptured until ... init is re-run')", async () => {
    runRealInit(repoRoot);

    const worktreePath = `${repoRoot}-wt`;
    execFileSync("git", ["worktree", "add", "-q", "-b", "iss22-unit-post-init-wt", worktreePath], { cwd: repoRoot });
    try {
      mkdirSync(join(worktreePath, ".claude"), { recursive: true });
      const worktreeSettingsPath = join(worktreePath, ".claude", "settings.local.json");
      const worktreeGitignorePath = join(worktreePath, ".gitignore");
      const settingsBytes = '{"userWorktreeKey":"do-not-delete"}';
      const gitignoreBytes = "node_modules/\n";
      writeFileSync(worktreeSettingsPath, settingsBytes);
      writeFileSync(worktreeGitignorePath, gitignoreBytes);

      const plan = computePlan(repoRoot);
      expect(
        plan.targets.some((t) => t.root === worktreePath),
        "test setup invariant: the worktree must appear in the plan",
      ).toBe(true);
      await performUninstall(plan, registryPath);

      expect(
        existsSync(worktreeSettingsPath),
        "a post-init worktree's settings.local.json must never be deleted by uninstall",
      ).toBe(true);
      expect(readFileSync(worktreeSettingsPath, "utf8")).toBe(settingsBytes);
      expect(
        existsSync(worktreeGitignorePath),
        "a post-init worktree's .gitignore must never be deleted by uninstall",
      ).toBe(true);
      expect(readFileSync(worktreeGitignorePath, "utf8")).toBe(gitignoreBytes);
    } finally {
      execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoRoot });
    }
  });
});
