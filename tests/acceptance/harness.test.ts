// The acceptance harness's own self-test (spec-v1.md "Test-harness
// contract", ISS-0003). Exercises all four primitives against the real
// filesystem: a real git repo, a real built CLI subprocess, a real fixture
// stream piped into a stub command (serial and parallel), and a real
// worktree — plus an explicit hermeticity proof (2026-07-14 escalation
// finding: the first attempt's env handling was a denylist, not an
// allowlist, and its parallel replayer shipped untested).
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createTmpRepo, runCli, replayFixtures, replayFixturesParallel, addWorktree } from "./harness/index.js";
import { gitEnv } from "./harness/gitEnv.js";
import { loadFixtureStream, type ScenarioName } from "../fixtures/loader.js";

const STUB_SCRIPT = `
const fs = require('node:fs');
const resultsFile = process.argv[2];
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const payload = Buffer.concat(chunks);
  fs.appendFileSync(resultsFile, JSON.stringify({ base64: payload.toString('base64') }) + '\\n');
  process.exit(0);
});
`;

describe("acceptance harness self-test", () => {
  it("the tmpdir-repo factory creates and cleans up a real git repo with an isolated HOME and registry path", async () => {
    const repo = await createTmpRepo();

    expect(existsSync(repo.root)).toBe(true);
    // Route verification git calls through gitEnv() too — the harness is copied
    // verbatim into seven slices, so even the self-test must model the hermetic
    // pattern, never raw `git` that inherits GIT_DIR/GIT_COMMON_DIR from a
    // poisoned parent shell (2026-07-14 review: a raw call here produced a
    // false-RED under a hostile parent env).
    const isWorkTree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repo.root,
      encoding: "utf8",
      env: gitEnv(repo.home),
    }).trim();
    expect(isWorkTree).toBe("true");

    const log = execFileSync("git", ["log", "--oneline"], {
      cwd: repo.root,
      encoding: "utf8",
      env: gitEnv(repo.home),
    }).trim();
    expect(log.length).toBeGreaterThan(0);

    expect(existsSync(repo.home)).toBe(true);
    expect(repo.home).not.toBe(homedir());

    const realRegistryPath = join(homedir(), ".coreartifact", "registry.jsonl");
    expect(repo.registryPath).not.toBe(realRegistryPath);

    await repo.cleanup();
    expect(existsSync(repo.root)).toBe(false);
  });

  it("the CLI runner spawns the real CLI with a hermetic allowlisted env, printing usage naming init, log and show with no args and exiting nonzero on an unknown command", async () => {
    const repo = await createTmpRepo();
    try {
      const noArgs = await runCli([], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(noArgs.exitCode).toBe(0);
      expect(noArgs.stdout).toContain("init");
      expect(noArgs.stdout).toContain("log");
      expect(noArgs.stdout).toContain("show");

      const unknown = await runCli(["bogus-command"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(unknown.exitCode).not.toBe(0);
    } finally {
      await repo.cleanup();
    }
  });

  it("the fixture replayer pipes a real fixture stream into a stub command that records the stdin it received, one invocation per line, every delivered line pinned to the given pin target (ISS-0033)", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "coreartifact-harness-selftest-"));
    try {
      const stubPath = join(workDir, "stub.cjs");
      const resultsFile = join(workDir, "results.ndjson");
      writeFileSync(stubPath, STUB_SCRIPT);
      writeFileSync(resultsFile, "");
      const pinTarget = mkdtempSync(join(tmpdir(), "coreartifact-harness-selftest-pin-"));

      const invocations = await replayFixtures("headless", pinTarget, { command: ["node", stubPath, resultsFile] });
      expect(invocations.length).toBeGreaterThan(0);

      const recorded = readFileSync(resultsFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      expect(recorded.length).toBe(invocations.length);

      for (let i = 0; i < recorded.length; i += 1) {
        const stubBytes = Buffer.from(recorded[i].base64, "base64");
        const reportedBytes = Buffer.from(invocations[i].stdinBytes);
        expect(stubBytes.equals(reportedBytes)).toBe(true);
        expect(typeof invocations[i].exitCode).toBe("number");

        const delivered = JSON.parse(reportedBytes.toString("utf8"));
        expect(delivered.cwd).toBe(pinTarget);
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  // S2b finding (2026-07-14 escalation): replayFixturesParallel shipped
  // untested in the first attempt even though the capture slice (ISS-0004)
  // depends on it to prove concurrent sessions lose zero lines. Interleave
  // three real fixture streams into ONE stub command and prove the stub
  // received exactly the sum of every stream's lines, none lost, none
  // duplicated (a sorted multiset comparison catches loss/duplication even
  // though concurrent scheduling means arrival order is not guaranteed).
  it("the parallel replayer interleaves N streams into one stub command, which receives exactly the sum of the input lines, none lost, none duplicated, every delivered line pinned to its own request's pin target (ISS-0033 contract migration: byte equality now asserted post-pin, not against the raw committed fixture text)", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "coreartifact-harness-selftest-parallel-"));
    try {
      const stubPath = join(workDir, "stub.cjs");
      const resultsFile = join(workDir, "results.ndjson");
      writeFileSync(stubPath, STUB_SCRIPT);
      writeFileSync(resultsFile, "");

      const scenarios: ScenarioName[] = ["interactive", "headless", "worktree"];
      const expectedLines = scenarios.flatMap((scenario) => loadFixtureStream(scenario));
      expect(expectedLines.length).toBeGreaterThan(0);

      const pinTarget = mkdtempSync(join(tmpdir(), "coreartifact-harness-selftest-parallel-pin-"));
      const results = await replayFixturesParallel(
        scenarios.map((scenario) => ({ scenario, pinTarget, options: { command: ["node", stubPath, resultsFile] } })),
      );

      const totalInvocations = results.reduce((sum, r) => sum + r.length, 0);
      expect(totalInvocations).toBe(expectedLines.length);

      const recorded = readFileSync(resultsFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { base64: string });
      expect(recorded.length).toBe(expectedLines.length);

      // Post-pin equality (ISS-0033): every delivered line's cwd/transcript_path
      // is the harness's own pin, not the committed fixture's recorded values —
      // strip both before the none-lost/none-duplicated multiset comparison,
      // then verify the pin separately.
      function stripPin(line: string): string {
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          delete obj.cwd;
          delete obj.transcript_path;
          return JSON.stringify(obj);
        } catch {
          return line;
        }
      }

      const recordedTexts = recorded
        .map((entry) => Buffer.from(entry.base64, "base64").toString("utf8"))
        .map(stripPin)
        .sort();
      const expectedTexts = expectedLines.map(stripPin).sort();
      expect(recordedTexts).toEqual(expectedTexts);

      for (const entry of recorded) {
        const delivered = JSON.parse(Buffer.from(entry.base64, "base64").toString("utf8")) as Record<string, unknown>;
        expect(delivered.cwd).toBe(pinTarget);
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("the worktree helper produces a real worktree whose git common dir resolves to the main repo", async () => {
    const repo = await createTmpRepo();
    try {
      const worktree = await addWorktree(repo, "harness-self-test");
      expect(existsSync(worktree.checkoutPath)).toBe(true);

      const worktreeCommonDirRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: worktree.checkoutPath,
        encoding: "utf8",
        env: gitEnv(repo.home),
      }).trim();
      const resolvedWorktreeCommonDir = resolve(worktree.checkoutPath, worktreeCommonDirRaw);

      const mainCommonDirRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: repo.root,
        encoding: "utf8",
        env: gitEnv(repo.home),
      }).trim();
      const resolvedMainCommonDir = resolve(repo.root, mainCommonDirRaw);

      expect(resolvedWorktreeCommonDir).toBe(resolvedMainCommonDir);
    } finally {
      await repo.cleanup();
    }
  });

  // S1a finding (2026-07-14 escalation): the first attempt's gitEnv was a
  // DENYLIST (`{ ...process.env }` minus GIT_DIR/GIT_WORK_TREE), which
  // leaks the operator's XDG_CONFIG_HOME / GIT_CONFIG_GLOBAL / GIT_COMMON_DIR
  // into every "hermetic" tmpdir repo. Prove the allowlist actually blocks
  // that leak — this test MUST fail if gitEnv regresses to a denylist (see
  // mutation-check notes in the final report).
  describe("hermeticity", () => {
    it("git invocations built from gitEnv() ignore a hostile GIT_CONFIG_GLOBAL and XDG_CONFIG_HOME in the parent environment", async () => {
      const hostileDir = mkdtempSync(join(tmpdir(), "coreartifact-hostile-config-"));
      const hostileGlobalConfig = join(hostileDir, "gitconfig-hostile");
      writeFileSync(hostileGlobalConfig, "[user]\n\tname = Hostile Operator\n\temail = hostile@evil.invalid\n");

      const isolatedHome = mkdtempSync(join(tmpdir(), "coreartifact-hostile-home-"));

      const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
      const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
      process.env.GIT_CONFIG_GLOBAL = hostileGlobalConfig;
      process.env.XDG_CONFIG_HOME = hostileDir;

      try {
        const env = gitEnv(isolatedHome);

        // A fresh isolated HOME has no global gitconfig of its own. If
        // GIT_CONFIG_GLOBAL leaked through from the parent, this call would
        // succeed and print "Hostile Operator" instead of failing — proving
        // the leak. `git config --global` reads ONLY global scope, so this
        // is not masked by any local repo config the way `git log` would be.
        expect(() =>
          execFileSync("git", ["config", "--global", "--get", "user.name"], {
            cwd: isolatedHome,
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }),
        ).toThrow();
      } finally {
        if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
        if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
        rmSync(hostileDir, { recursive: true, force: true });
        rmSync(isolatedHome, { recursive: true, force: true });
      }
    });

    it("a harness-made repo is unaffected by a hostile GIT_CONFIG_GLOBAL / XDG_CONFIG_HOME / GIT_COMMON_DIR in the parent environment", async () => {
      const hostileConfigDir = mkdtempSync(join(tmpdir(), "coreartifact-hostile-config-"));
      const hostileGlobalConfig = join(hostileConfigDir, "gitconfig-hostile");
      writeFileSync(hostileGlobalConfig, "[user]\n\tname = Hostile Operator\n\temail = hostile@evil.invalid\n");
      const hostileCommonDir = mkdtempSync(join(tmpdir(), "coreartifact-hostile-common-"));

      const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
      const originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
      const originalGitCommonDir = process.env.GIT_COMMON_DIR;
      process.env.GIT_CONFIG_GLOBAL = hostileGlobalConfig;
      process.env.XDG_CONFIG_HOME = hostileConfigDir;
      process.env.GIT_COMMON_DIR = hostileCommonDir;

      try {
        const repo = await createTmpRepo();
        try {
          // Query through gitEnv(), exactly as every later acceptance test
          // and every other harness primitive does — a raw `git` call with
          // no explicit env would inherit THIS TEST's own polluted
          // process.env (since we set the hostile vars on process.env
          // itself to simulate the operator's shell) and prove nothing
          // about the harness's own hermeticity.
          //
          // Local repo config (set explicitly by createTmpRepo) always wins
          // over global scope, so author identity alone would not detect a
          // GIT_CONFIG_GLOBAL leak. What a leaked GIT_COMMON_DIR WOULD do is
          // redirect git's repository discovery away from repo.root
          // entirely — assert the repo's own git-common-dir still resolves
          // under the harness's own base, never the hostile directory.
          const queryEnv = gitEnv(repo.home);
          const commonDirRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
            cwd: repo.root,
            env: queryEnv,
            encoding: "utf8",
          }).trim();
          const resolvedCommonDir = resolve(repo.root, commonDirRaw);

          expect(resolvedCommonDir).not.toBe(resolve(hostileCommonDir));
          expect(resolvedCommonDir.startsWith(repo.base)).toBe(true);

          const authorName = execFileSync("git", ["log", "-1", "--format=%an"], {
            cwd: repo.root,
            env: queryEnv,
            encoding: "utf8",
          }).trim();
          expect(authorName).toBe("Coreartifact Test");
        } finally {
          await repo.cleanup();
        }
      } finally {
        if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
        else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
        if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
        if (originalGitCommonDir === undefined) delete process.env.GIT_COMMON_DIR;
        else process.env.GIT_COMMON_DIR = originalGitCommonDir;
        rmSync(hostileConfigDir, { recursive: true, force: true });
        rmSync(hostileCommonDir, { recursive: true, force: true });
      }
    });
  });
});
