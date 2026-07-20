// ISS-0022 acceptance tests — `coreartifact uninstall`: the way out,
// byte-identical (docs/issues/ISS-0022.md).
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory with its isolated registry,
// CLI runner, worktree helper, fixture replayer, gitEnv). Also imports two
// already-shipped, independent modules as oracles rather than guessing their
// output shape: src/core/paths.js (getPaths — where the spool/ledger/hook
// artifact live) and src/core/registry.js (readRegistry — the already-shipped
// fold this issue's `removeLedger` tombstone must be visible through).
//
// Module under test: `uninstall` (src/cli/commands/uninstall.ts,
// src/install/uninstall.ts), which does not exist yet — every test below
// drives it exclusively through the built CLI subprocess (runCli), never by
// importing not-yet-existing internals. The one property this whole issue
// rests on — "byte-identical to its pre-init snapshot" — is asserted with a
// full recursive tree capture (./snapshotTree.ts), never a proxy for it
// (docs/gotchas.md #4): no assumption about which files init touches is
// baked into the assertion, so a change to init's own inventory breaks these
// tests loudly rather than silently.
//
// The TTY confirmation prompt cannot be driven at this subprocess seam (no
// PTY available) — docs/issues/ISS-0022.md's own "Test-harness contract"
// says so explicitly and routes that path to a unit test
// (tests/unit/install/uninstall.test.ts, outside this issue's test-author
// footprint). This file asserts only what the acceptance seam can: the
// non-TTY refusal and the --yes path.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmpRepo, runCli, addWorktree, replayFixtures, gitEnv, type TmpRepo } from "../harness/index.js";
import { getPaths } from "../../../src/core/paths.js";
import { readRegistry } from "../../../src/core/registry.js";
import { snapshotTree, diffTreeSnapshots } from "./snapshotTree.js";

// A second repo registered under the SAME shared home/registry as `repo`
// (the harness's isolated-registry primitive is what makes "two registered
// repos, uninstall only one" testable without leaking into a real registry
// or another test's) — mirrors tmpRepo.ts's own git-init sequence, the only
// part of that factory this needs, since createTmpRepo() always mints a
// fresh, distinct home.
function createSecondRepo(repo: TmpRepo, name: string): string {
  const root = join(repo.base, name);
  mkdirSync(root, { recursive: true });
  const env = gitEnv(repo.home);
  execFileSync("git", ["init", "-q"], { cwd: root, env });
  execFileSync("git", ["config", "user.email", "test@coreartifact.invalid"], { cwd: root, env });
  execFileSync("git", ["config", "user.name", "Coreartifact Test"], { cwd: root, env });
  writeFileSync(join(root, ".gitkeep"), "");
  execFileSync("git", ["add", "."], { cwd: root, env });
  execFileSync("git", ["commit", "-q", "-m", "initial commit"], { cwd: root, env });
  return root;
}

describe("ISS-0022 uninstall: the way out, byte-identical", () => {
  const tmpRepos: TmpRepo[] = [];
  const extraDirs: string[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
    for (const dir of extraDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    "R9 Uninstall. After init → captured session → uninstall --yes: the repo tree is byte-identical to its pre-init snapshot (hook config entries, artifact, spool, ledger, gitignore line, and propagated worktree copies all gone); a pre-existing settings file keeps its unrelated user keys; the registry folds the repo out (a remove op is appended — the log is never rewritten) and log no longer lists it. Without --yes on a TTY, uninstall names what will be deleted and requires confirmation.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const worktree = await addWorktree(repo, "iss22-r9-worktree");

      const mainSnapshotBefore = snapshotTree(repo.root);
      const worktreeSnapshotBefore = snapshotTree(worktree.checkoutPath);

      const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      await replayFixtures("headless", repo.root);

      // Trigger ingest so the ledger (part of .coreartifact/, part of what
      // uninstall must revert) is actually populated, not just the spool.
      const logResult = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(logResult.exitCode, `test setup invariant: log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);

      const uninstallResult = await runCli(["uninstall", "--yes"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(uninstallResult.exitCode, `uninstall --yes did not exit 0; stderr: ${uninstallResult.stderr}`).toBe(0);

      const mainSnapshotAfter = snapshotTree(repo.root);
      const mainDiff = diffTreeSnapshots(mainSnapshotBefore, mainSnapshotAfter);
      expect(
        mainDiff,
        `repo tree is not byte-identical to its pre-init snapshot after uninstall --yes: ${JSON.stringify(mainDiff)}`,
      ).toEqual([]);

      const worktreeSnapshotAfter = snapshotTree(worktree.checkoutPath);
      const worktreeDiff = diffTreeSnapshots(worktreeSnapshotBefore, worktreeSnapshotAfter);
      expect(
        worktreeDiff,
        `propagated worktree tree is not byte-identical to its own pre-init snapshot after uninstall: ${JSON.stringify(worktreeDiff)}`,
      ).toEqual([]);

      const folded = await readRegistry(repo.registryPath);
      expect(folded.has(repo.root), "the registry fold still contains the repo root after uninstall --yes").toBe(false);

      const nonGitDir = mkdtempSync(join(tmpdir(), "coreartifact-iss22-r9-nongit-"));
      extraDirs.push(nonGitDir);
      const postUninstallLog = await runCli(["log"], { cwd: nonGitDir, home: repo.home, registryPath: repo.registryPath });
      expect(postUninstallLog.exitCode, `log did not exit 0 after uninstall; stderr: ${postUninstallLog.stderr}`).toBe(0);
      const postUninstallOutput = `${postUninstallLog.stdout}\n${postUninstallLog.stderr}`;
      expect(postUninstallOutput, "log still lists the uninstalled repo after uninstall --yes").not.toContain(repo.root);
    },
    60000,
  );

  it(
    "Uninstall in a repo where init created the settings file removes the file entirely; in a repo whose settings file pre-existed init, uninstall removes exactly the entries init merged and preserves every unrelated user key — the tree comparison against the pre-init snapshot is clean in both shapes.",
    async () => {
      // Shape A: fresh repo — init creates .claude/settings.local.json and
      // .gitignore from scratch, so uninstall must remove both files
      // entirely, restoring the tree to exactly its pre-init snapshot.
      const freshRepo = await createTmpRepo();
      tmpRepos.push(freshRepo);
      const freshSnapshotBefore = snapshotTree(freshRepo.root);

      const freshInit = await runCli(["init"], {
        cwd: freshRepo.root,
        home: freshRepo.home,
        registryPath: freshRepo.registryPath,
      });
      expect(freshInit.exitCode, `test setup invariant: init did not exit 0; stderr: ${freshInit.stderr}`).toBe(0);

      const freshSettingsPath = join(freshRepo.root, ".claude", "settings.local.json");
      expect(existsSync(freshSettingsPath), "test setup invariant: init did not create the settings file").toBe(true);

      const freshUninstall = await runCli(["uninstall", "--yes"], {
        cwd: freshRepo.root,
        home: freshRepo.home,
        registryPath: freshRepo.registryPath,
      });
      expect(freshUninstall.exitCode, `uninstall --yes did not exit 0; stderr: ${freshUninstall.stderr}`).toBe(0);

      expect(
        existsSync(freshSettingsPath),
        "uninstall left behind a settings file that init had created from scratch (should be removed entirely)",
      ).toBe(false);

      const freshSnapshotAfter = snapshotTree(freshRepo.root);
      const freshDiff = diffTreeSnapshots(freshSnapshotBefore, freshSnapshotAfter);
      expect(
        freshDiff,
        `fresh-repo shape is not clean against the pre-init snapshot after uninstall: ${JSON.stringify(freshDiff)}`,
      ).toEqual([]);

      // Shape B: settings.local.json and .gitignore PRE-EXISTED init, with
      // unrelated user content, deliberately unusual formatting (compact,
      // no trailing newline) — the exact bytes uninstall must restore
      // without re-serializing anything it did not itself change.
      const seededRepo = await createTmpRepo();
      tmpRepos.push(seededRepo);
      const claudeDir = join(seededRepo.root, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      const preexistingSettingsBytes = '{"customUserKey":"keep-me-untouched","other":123}';
      writeFileSync(join(claudeDir, "settings.local.json"), preexistingSettingsBytes);
      const preexistingGitignoreBytes = "node_modules/\n*.log";
      writeFileSync(join(seededRepo.root, ".gitignore"), preexistingGitignoreBytes);

      const seededSnapshotBefore = snapshotTree(seededRepo.root);

      const seededInit = await runCli(["init"], {
        cwd: seededRepo.root,
        home: seededRepo.home,
        registryPath: seededRepo.registryPath,
      });
      expect(seededInit.exitCode, `test setup invariant: init did not exit 0; stderr: ${seededInit.stderr}`).toBe(0);

      const seededUninstall = await runCli(["uninstall", "--yes"], {
        cwd: seededRepo.root,
        home: seededRepo.home,
        registryPath: seededRepo.registryPath,
      });
      expect(seededUninstall.exitCode, `uninstall --yes did not exit 0; stderr: ${seededUninstall.stderr}`).toBe(0);

      const seededSnapshotAfter = snapshotTree(seededRepo.root);
      const seededDiff = diffTreeSnapshots(seededSnapshotBefore, seededSnapshotAfter);
      expect(
        seededDiff,
        `pre-existing-settings shape is not byte-identical to its pre-init snapshot after uninstall (unrelated keys/lines, formatting, or final-newline state lost): ${JSON.stringify(seededDiff)}`,
      ).toEqual([]);
    },
    60000,
  );

  it(
    "The registry log after uninstall contains every prior line byte-unchanged plus exactly one appended remove op for the repo root; the fold no longer contains the root and log no longer lists the repo.",
    async () => {
      const repoA = await createTmpRepo();
      tmpRepos.push(repoA);
      const initA = await runCli(["init"], { cwd: repoA.root, home: repoA.home, registryPath: repoA.registryPath });
      expect(initA.exitCode, `test setup invariant: repoA init did not exit 0; stderr: ${initA.stderr}`).toBe(0);

      const repoBRoot = createSecondRepo(repoA, "iss22-registry-repoB");
      const initB = await runCli(["init"], { cwd: repoBRoot, home: repoA.home, registryPath: repoA.registryPath });
      expect(initB.exitCode, `test setup invariant: repoB init did not exit 0; stderr: ${initB.stderr}`).toBe(0);

      const registryBefore = readFileSync(repoA.registryPath);

      const uninstallA = await runCli(["uninstall", "--yes"], {
        cwd: repoA.root,
        home: repoA.home,
        registryPath: repoA.registryPath,
      });
      expect(uninstallA.exitCode, `uninstall --yes did not exit 0; stderr: ${uninstallA.stderr}`).toBe(0);

      const registryAfter = readFileSync(repoA.registryPath);
      expect(
        registryAfter.subarray(0, registryBefore.length).equals(registryBefore),
        "the registry's prior bytes are not a strict prefix of its post-uninstall bytes (an append-only log must never be rewritten)",
      ).toBe(true);

      const appendedText = registryAfter.subarray(registryBefore.length).toString("utf8");
      const appendedLines = appendedText.split("\n").filter((line) => line.trim().length > 0);
      expect(
        appendedLines.length,
        `expected exactly one appended registry line after uninstall, got: ${JSON.stringify(appendedLines)}`,
      ).toBe(1);

      const appendedEntry = JSON.parse(appendedLines[0]!) as { op?: unknown; repo_root?: unknown };
      expect(appendedEntry.op, "the appended registry line's op is not 'remove'").toBe("remove");
      expect(appendedEntry.repo_root, "the appended registry line does not name repoA's root").toBe(repoA.root);

      const folded = await readRegistry(repoA.registryPath);
      expect(folded.has(repoA.root), "the registry fold still contains repoA's root after uninstall").toBe(false);

      const nonGitDir = mkdtempSync(join(tmpdir(), "coreartifact-iss22-registry-nongit-"));
      extraDirs.push(nonGitDir);
      const logResult = await runCli(["log"], { cwd: nonGitDir, home: repoA.home, registryPath: repoA.registryPath });
      expect(logResult.exitCode, `log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);
      const logOutput = `${logResult.stdout}\n${logResult.stderr}`;
      expect(logOutput, "log still lists the uninstalled repo (repoA)").not.toContain(repoA.root);
      expect(logOutput, "log no longer lists the still-registered second repo (repoB)").toContain(repoBRoot);
    },
    60000,
  );

  it(
    "Uninstall never touches the global operator state or any other repo: a second registered repo's registry entry and on-disk artifacts are unchanged before and after, and the global state file (present or absent) is byte-unchanged.",
    async () => {
      const repoA = await createTmpRepo();
      tmpRepos.push(repoA);
      const initA = await runCli(["init"], { cwd: repoA.root, home: repoA.home, registryPath: repoA.registryPath });
      expect(initA.exitCode, `test setup invariant: repoA init did not exit 0; stderr: ${initA.stderr}`).toBe(0);

      const repoBRoot = createSecondRepo(repoA, "iss22-global-repoB");
      const initB = await runCli(["init"], { cwd: repoBRoot, home: repoA.home, registryPath: repoA.registryPath });
      expect(initB.exitCode, `test setup invariant: repoB init did not exit 0; stderr: ${initB.stderr}`).toBe(0);

      const repoBSnapshotBefore = snapshotTree(repoBRoot);
      const foldedBefore = await readRegistry(repoA.registryPath);
      expect(foldedBefore.has(repoBRoot), "test setup invariant: repoB is not registered before uninstalling repoA").toBe(
        true,
      );

      // Global operator state (install id / consent) lives under the same
      // registry root as the append-only log, but is a distinct file a
      // per-repo uninstall must never touch — simulated here with a marker
      // file of known bytes under that root.
      const registryRoot = repoA.registryRoot;
      mkdirSync(registryRoot, { recursive: true });
      const globalStatePath = join(registryRoot, "state.json");
      const globalStateBytes = '{"installId":"fixed-marker-do-not-touch","consent":true}';
      writeFileSync(globalStatePath, globalStateBytes);

      const uninstallA = await runCli(["uninstall", "--yes"], {
        cwd: repoA.root,
        home: repoA.home,
        registryPath: repoA.registryPath,
      });
      expect(uninstallA.exitCode, `uninstall --yes did not exit 0; stderr: ${uninstallA.stderr}`).toBe(0);

      const repoBSnapshotAfter = snapshotTree(repoBRoot);
      const repoBDiff = diffTreeSnapshots(repoBSnapshotBefore, repoBSnapshotAfter);
      expect(
        repoBDiff,
        `repoB's on-disk artifacts changed after uninstalling repoA: ${JSON.stringify(repoBDiff)}`,
      ).toEqual([]);

      const foldedAfter = await readRegistry(repoA.registryPath);
      expect(foldedAfter.has(repoBRoot), "repoB's registry entry was affected by uninstalling repoA").toBe(true);

      const globalStateAfter = readFileSync(globalStatePath, "utf8");
      expect(globalStateAfter, "the global state file's bytes changed after a per-repo uninstall").toBe(
        globalStateBytes,
      );
    },
    60000,
  );

  it(
    "Without --yes and without a TTY, uninstall exits nonzero naming the --yes requirement and deletes nothing — it never destroys without explicit consent and never hangs waiting for input.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

      const snapshotBefore = snapshotTree(repo.root);
      const registryBefore = readFileSync(repo.registryPath);

      // runCli spawns the CLI as a plain child process with piped stdio
      // (never a PTY) — its stdin is never a TTY, exactly the "no --yes, no
      // TTY" shape this criterion names. The 30s test timeout is itself part
      // of the assertion: an implementation that blocks reading stdin for
      // consent instead of detecting non-TTY up front times out here rather
      // than exiting promptly.
      const result = await runCli(["uninstall"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });

      expect(result.exitCode, "uninstall without --yes and without a TTY did not exit nonzero").not.toBe(0);
      expect(
        `${result.stdout}\n${result.stderr}`,
        "uninstall's refusal did not name the --yes requirement",
      ).toContain("--yes");

      const snapshotAfter = snapshotTree(repo.root);
      const diff = diffTreeSnapshots(snapshotBefore, snapshotAfter);
      expect(diff, `uninstall without consent deleted or changed something: ${JSON.stringify(diff)}`).toEqual([]);

      const registryAfter = readFileSync(repo.registryPath);
      expect(registryAfter.equals(registryBefore), "uninstall without consent modified the registry log").toBe(true);
    },
    30000,
  );
});
