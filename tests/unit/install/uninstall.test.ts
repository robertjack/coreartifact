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
import { captureInstallBackup, readInstallBackup, hasUsableInstallBackup, installBackupPath } from "../../../src/install/installBackup.js";
import { mergeHookConfig } from "../../../src/install/hookConfig.js";
import { ensureGitignoreLines } from "../../../src/install/gitignore.js";
import { getPaths, REGISTRY_ROOT_ENV_VAR } from "../../../src/core/paths.js";
import { addLedger } from "../../../src/core/registry.js";
import { uninstallCommand } from "../../../src/cli/commands/uninstall.js";

// Operator fix 2026-07-16: every in-process uninstallCommand call must run
// with BOTH stdio streams captured — the command writes its inventory
// directly to process.stdout, raw writes bypass vitest's console
// interception, and aeh's red-verify parses `vitest --reporter=json`
// stdout as JSON (the pollution broke the PRD-0002 relaunch baseline).
async function withCapturedStdio<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

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

  // Reviewer finding F102 (round 2, exact repro): a .gitignore that ALREADY
  // contains `.coreartifact/` pre-init only gets `.claude/settings.local.json`
  // appended by init; a post-init edit (dist/) makes this the "edited since
  // init" strip path. The strip must remove only what init itself added
  // (`.claude/settings.local.json`) -- never the user's own pre-existing
  // `.coreartifact/` line, even though it's on the static ensure-list.
  it("F102: strip path never deletes a user-owned gitignore line that merely matches init's static list", async () => {
    writeFileSync(join(repoRoot, ".gitignore"), ".coreartifact/\nnode_modules/\n");
    runRealInit(repoRoot); // init sees .coreartifact/ already present -- appends only the settings line

    const gitignorePath = join(repoRoot, ".gitignore");
    writeFileSync(gitignorePath, `${readFileSync(gitignorePath, "utf8")}dist/\n`); // post-init edit

    const plan = computePlan(repoRoot);
    await performUninstall(plan, registryPath);

    const finalLines = readFileSync(gitignorePath, "utf8")
      .split("\n")
      .filter((line) => line.length > 0);
    expect(finalLines, "the user's own pre-existing .coreartifact/ line must survive uninstall").toEqual([
      ".coreartifact/",
      "node_modules/",
      "dist/",
    ]);
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

  // Reviewer finding F104: a files-only view of the tree left an
  // init-created, now-empty `.claude/` behind after uninstall, invisibly --
  // the operator's snapshotTree amendment makes this show up as a directory
  // diff. Uninstall must remove `.claude/` when init created it AND it is
  // empty after the settings-file inversion.
  it("F104: removes .claude/ entirely when init created it (no pre-init file) and it is empty after uninstall", async () => {
    runRealInit(repoRoot); // no pre-existing .claude/ -- init creates the dir and the settings file

    const claudeDir = join(repoRoot, ".claude");
    expect(existsSync(claudeDir), "test setup invariant: init must have created .claude/").toBe(true);

    const plan = computePlan(repoRoot);
    await performUninstall(plan, registryPath);

    expect(existsSync(claudeDir), "an init-created, now-empty .claude/ must be removed by uninstall").toBe(false);
  });

  it("F104: never removes .claude/ when it pre-existed init, even if it is empty after uninstall", async () => {
    mkdirSync(join(repoRoot, ".claude"), { recursive: true }); // .claude/ exists BEFORE init runs
    runRealInit(repoRoot);

    const claudeDir = join(repoRoot, ".claude");
    const plan = computePlan(repoRoot);
    await performUninstall(plan, registryPath);

    expect(existsSync(claudeDir), "a .claude/ directory that pre-existed init must never be removed by uninstall").toBe(
      true,
    );
  });

  it("F104: never removes .claude/ when a user has put other content in it, even though init created the directory", async () => {
    runRealInit(repoRoot); // no pre-existing .claude/ -- init creates it

    const claudeDir = join(repoRoot, ".claude");
    mkdirSync(join(claudeDir, "commands"), { recursive: true });
    writeFileSync(join(claudeDir, "commands", "user-command.md"), "# not coreartifact's to delete\n");

    const plan = computePlan(repoRoot);
    await performUninstall(plan, registryPath);

    expect(
      existsSync(join(claudeDir, "commands", "user-command.md")),
      "user content under .claude/ must survive uninstall even when init created the directory",
    ).toBe(true);
  });

  // Reviewer finding F105: restoring a pre-existing settings.local.json
  // whose parent .claude/ directory was deleted post-init (e.g. `rm -r
  // .claude`) must recreate the directory rather than crash ENOENT and wedge
  // uninstall permanently (every re-run hits the identical crash).
  it("F105: init -> rm -r .claude -> uninstall --yes succeeds and restores the pre-init settings file, not wedged", async () => {
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    const preInitSettingsBytes = '{"customUserKey":"keep-me-untouched"}';
    writeFileSync(join(repoRoot, ".claude", "settings.local.json"), preInitSettingsBytes);
    runRealInit(repoRoot); // pre-existing settings file, merged by init

    rmSync(join(repoRoot, ".claude"), { recursive: true, force: true }); // simulate `rm -r .claude`

    const plan = computePlan(repoRoot);
    // Must not throw ENOENT.
    await expect(performUninstall(plan, registryPath)).resolves.toBeUndefined();

    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    expect(existsSync(settingsPath), "the pre-init settings file must be restored even though its parent dir was deleted").toBe(
      true,
    );
    expect(readFileSync(settingsPath, "utf8")).toBe(preInitSettingsBytes);

    // A second run (the "every re-run identical" wedge symptom the finding
    // describes) must also succeed cleanly, not throw again.
    const secondPlan = computePlan(repoRoot);
    await expect(performUninstall(secondPlan, registryPath)).resolves.toBeUndefined();
  });
});

// Reviewer finding F103: a missing/damaged install-backup manifest is a
// different question from "was this ONE path ever captured" (the F96/S1
// scenario the suite above already covers) -- it means uninstall has NO
// reliable inventory of what init did to this repo at all, and must refuse
// the whole operation loudly rather than silently degrading to "leave
// everything untouched" while still deleting `.coreartifact/` and
// tombstoning the registry (a fabricated success, docs/gotchas.md #5).
describe("install/installBackup hasUsableInstallBackup (F103)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "iss22-backup-presence-unit-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("is false when .coreartifact/install-backup.json does not exist at all", () => {
    expect(existsSync(installBackupPath(repoRoot))).toBe(false);
    expect(hasUsableInstallBackup(repoRoot)).toBe(false);
  });

  it("is false when the manifest file exists but is not parseable JSON", () => {
    mkdirSync(join(repoRoot, ".coreartifact"), { recursive: true });
    writeFileSync(installBackupPath(repoRoot), "{not valid json");
    expect(hasUsableInstallBackup(repoRoot)).toBe(false);
  });

  it("is true for a real, valid (even empty-entries) manifest", () => {
    // captureInstallBackup shells out to `git worktree list` -- needs a real
    // git repo, unlike the two absence/damage cases above which never reach
    // that call.
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, ".gitkeep"), "");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: repoRoot });

    captureInstallBackup(repoRoot);
    expect(hasUsableInstallBackup(repoRoot)).toBe(true);
  });
});

describe("cli/commands/uninstall uninstallCommand (F103: refuses loudly on a missing manifest)", () => {
  let repoRoot: string;
  let registryRoot: string;
  let registryPath: string;
  let originalCwd: string;
  let originalRegistryRootEnv: string | undefined;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "iss22-cmd-unit-")));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, ".gitkeep"), "");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: repoRoot });

    registryRoot = mkdtempSync(join(tmpdir(), "iss22-cmd-unit-registry-"));
    registryPath = join(registryRoot, "registry.jsonl");

    originalCwd = process.cwd();
    originalRegistryRootEnv = process.env[REGISTRY_ROOT_ENV_VAR];
    process.chdir(repoRoot);
    process.env[REGISTRY_ROOT_ENV_VAR] = registryRoot;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalRegistryRootEnv === undefined) delete process.env[REGISTRY_ROOT_ENV_VAR];
    else process.env[REGISTRY_ROOT_ENV_VAR] = originalRegistryRootEnv;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(registryRoot, { recursive: true, force: true });
  });

  it("exits nonzero, names the missing manifest, and deletes/tombstones nothing when .coreartifact/install-backup.json is gone (e.g. git clean -fdX)", async () => {
    // Real init, so live hook config actually exists in settings.local.json
    // and .gitignore -- exactly what F103 says must NOT be left behind
    // while uninstall still claims success.
    const paths = getPaths(repoRoot);
    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const merged = mergeHookConfig({}, paths.hookArtifact, repoRoot);
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
    ensureGitignoreLines(join(repoRoot, ".gitignore"), [".coreartifact/", ".claude/settings.local.json"]);
    await addLedger(repoRoot, registryPath);

    // Simulate `git clean -fdX` wiping the gitignored .coreartifact/
    // directory (which held the install-backup manifest) while the live
    // settings.local.json and .gitignore survive untouched.
    rmSync(join(repoRoot, ".coreartifact"), { recursive: true, force: true });
    expect(existsSync(installBackupPath(repoRoot)), "test setup invariant: manifest must be gone").toBe(false);

    const settingsBefore = readFileSync(settingsPath, "utf8");
    const gitignoreBefore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
    const registryBefore = readFileSync(registryPath);

    const captured = await withCapturedStdio(() => uninstallCommand(["--yes"]));
    const exitCode: number = captured.result;
    const stderrChunks: string[] = [captured.stderr];

    expect(exitCode, "uninstall must exit nonzero when the install-backup manifest is missing").not.toBe(0);
    expect(stderrChunks.join(""), "the refusal must name the missing manifest").toContain("install-backup");

    expect(readFileSync(settingsPath, "utf8"), "live hook config in settings.local.json must survive untouched").toBe(
      settingsBefore,
    );
    expect(
      readFileSync(join(repoRoot, ".gitignore"), "utf8"),
      "live gitignore entries must survive untouched",
    ).toBe(gitignoreBefore);
    expect(readFileSync(registryPath).equals(registryBefore), "the registry must not be tombstoned").toBe(true);
  });
});

// Reviewer finding F108 (round 4): the F103 recovery path -- re-running
// `init` after `.coreartifact/` was wiped, exactly the refusal message's own
// advice -- must not re-open F103 by capturing the ALREADY-POLLUTED settings
// file (still carrying coreartifact's own hook entries from the lost
// manifest's install) as though it were the clean pre-init baseline.
// Verbatim-restoring that polluted baseline on uninstall leaves every live
// hook entry behind, dangling at the just-deleted artifact.
describe("install/installBackup captureInstallBackup never re-captures a settings file already carrying coreartifact's own hook entries (F108)", () => {
  let repoRoot: string;
  let registryRoot: string;
  let registryPath: string;
  let originalCwd: string;
  let originalRegistryRootEnv: string | undefined;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "iss22-f108-unit-")));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, ".gitkeep"), "");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: repoRoot });

    registryRoot = mkdtempSync(join(tmpdir(), "iss22-f108-unit-registry-"));
    registryPath = join(registryRoot, "registry.jsonl");

    originalCwd = process.cwd();
    originalRegistryRootEnv = process.env[REGISTRY_ROOT_ENV_VAR];
    process.chdir(repoRoot);
    process.env[REGISTRY_ROOT_ENV_VAR] = registryRoot;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalRegistryRootEnv === undefined) delete process.env[REGISTRY_ROOT_ENV_VAR];
    else process.env[REGISTRY_ROOT_ENV_VAR] = originalRegistryRootEnv;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(registryRoot, { recursive: true, force: true });
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

  it("init -> rm -rf .coreartifact -> init -> uninstall --yes leaves ZERO coreartifact hook entries and preserves the user's own settings key", async () => {
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    writeFileSync(join(repoRoot, ".claude", "settings.local.json"), '{"customUserKey":"keep-me-untouched"}');

    runRealInit(repoRoot); // first init: clean pre-init baseline captured normally
    await addLedger(repoRoot, registryPath);

    // Simulate the F103 loss: something (e.g. `git clean -fdX`) wipes the
    // gitignored `.coreartifact/` directory, taking the install-backup
    // manifest with it, while the live settings.local.json survives.
    rmSync(join(repoRoot, ".coreartifact"), { recursive: true, force: true });
    expect(existsSync(installBackupPath(repoRoot)), "test setup invariant: manifest must be gone").toBe(false);

    // The refusal message's own advice: re-run init to recreate an
    // inventory. The settings file init sees now already carries
    // coreartifact's own hook entries from the lost first install.
    runRealInit(repoRoot);

    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const captured = await withCapturedStdio(() => uninstallCommand(["--yes"]));
    const exitCode: number = captured.result;
    const stderrChunks: string[] = [captured.stderr];

    expect(exitCode, `uninstall must succeed: ${stderrChunks.join("")}`).toBe(0);

    const finalSettings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
    const finalText = readFileSync(settingsPath, "utf8");
    expect(finalText.includes("capture.mjs"), "zero coreartifact hook entries must survive uninstall").toBe(false);
    expect((finalSettings as { customUserKey?: string }).customUserKey, "the user's own pre-init key must survive").toBe(
      "keep-me-untouched",
    );
  });
});

// Reviewer finding F109 (round 4): `hasUsableInstallBackup` and
// `readBackupFile` use `typeof entries === "object"`, which also passes for
// `[]` and `null` -- neither is a usable entries map. An array folds to
// "usable, empty" (uninstall proceeds destructively with zero per-path
// entries, the F103 defect through a side door); `null` throws a raw
// TypeError the first time anything indexes into it.
describe("install/installBackup entries-shape validation rejects array/null (F109)", () => {
  let repoRoot: string;
  let registryRoot: string;
  let registryPath: string;
  let originalCwd: string;
  let originalRegistryRootEnv: string | undefined;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "iss22-f109-unit-")));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: repoRoot });
    writeFileSync(join(repoRoot, ".gitkeep"), "");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: repoRoot });

    registryRoot = mkdtempSync(join(tmpdir(), "iss22-f109-unit-registry-"));
    registryPath = join(registryRoot, "registry.jsonl");

    originalCwd = process.cwd();
    originalRegistryRootEnv = process.env[REGISTRY_ROOT_ENV_VAR];
    process.chdir(repoRoot);
    process.env[REGISTRY_ROOT_ENV_VAR] = registryRoot;
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalRegistryRootEnv === undefined) delete process.env[REGISTRY_ROOT_ENV_VAR];
    else process.env[REGISTRY_ROOT_ENV_VAR] = originalRegistryRootEnv;
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(registryRoot, { recursive: true, force: true });
  });

  it("hasUsableInstallBackup is false for entries: [] and entries: null", () => {
    mkdirSync(join(repoRoot, ".coreartifact"), { recursive: true });
    writeFileSync(installBackupPath(repoRoot), JSON.stringify({ v: 1, entries: [] }));
    expect(hasUsableInstallBackup(repoRoot), "entries: [] must not read as usable").toBe(false);

    writeFileSync(installBackupPath(repoRoot), JSON.stringify({ v: 1, entries: null }));
    expect(hasUsableInstallBackup(repoRoot), "entries: null must not read as usable").toBe(false);
  });

  it("uninstallCommand refuses (does not proceed destructively) against entries: [], live hooks left untouched", async () => {
    const paths = getPaths(repoRoot);
    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const merged = mergeHookConfig({}, paths.hookArtifact, repoRoot);
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
    ensureGitignoreLines(join(repoRoot, ".gitignore"), [".coreartifact/", ".claude/settings.local.json"]);
    await addLedger(repoRoot, registryPath);

    // Corrupt the manifest to the hostile array shape after a real install.
    writeFileSync(installBackupPath(repoRoot), JSON.stringify({ v: 1, entries: [] }));

    const settingsBefore = readFileSync(settingsPath, "utf8");
    const registryBefore = readFileSync(registryPath);

    const captured = await withCapturedStdio(() => uninstallCommand(["--yes"]));
    const exitCode: number = captured.result;
    const stderrChunks: string[] = [captured.stderr];

    expect(exitCode, "uninstall must refuse (nonzero) against entries: []").not.toBe(0);
    expect(stderrChunks.join(""), "the refusal must name the missing manifest").toContain("install-backup");
    expect(readFileSync(settingsPath, "utf8"), "live hook config must survive untouched").toBe(settingsBefore);
    expect(readFileSync(registryPath).equals(registryBefore), "the registry must not be tombstoned").toBe(true);
  });

  it("uninstallCommand refuses cleanly (no throw) against entries: null", async () => {
    const paths = getPaths(repoRoot);
    const settingsPath = join(repoRoot, ".claude", "settings.local.json");
    const merged = mergeHookConfig({}, paths.hookArtifact, repoRoot);
    mkdirSync(join(repoRoot, ".claude"), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
    ensureGitignoreLines(join(repoRoot, ".gitignore"), [".coreartifact/", ".claude/settings.local.json"]);
    await addLedger(repoRoot, registryPath);

    writeFileSync(installBackupPath(repoRoot), JSON.stringify({ v: 1, entries: null }));

    let exitCode: number | undefined;
    let threw: unknown;
    try {
      const captured = await withCapturedStdio(() => uninstallCommand(["--yes"]));
      exitCode = captured.result;
    } catch (err) {
      threw = err;
    }

    expect(threw, "uninstallCommand must not throw against entries: null").toBeUndefined();
    expect(exitCode, "uninstall must refuse (nonzero) against entries: null").not.toBe(0);
  });
});
