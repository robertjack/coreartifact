// The acceptance harness's own self-test (spec-v1.md "Test-harness
// contract", ISS-0003). Exercises all four primitives against the real
// filesystem: a real git repo, a real built CLI subprocess, a real fixture
// stream piped into a stub command, and a real worktree.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createTmpRepo, runCli, replayFixtures, addWorktree } from "./harness/index.js";

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
    const isWorkTree = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: repo.root,
      encoding: "utf8",
    }).trim();
    expect(isWorkTree).toBe("true");

    const log = execFileSync("git", ["log", "--oneline"], { cwd: repo.root, encoding: "utf8" }).trim();
    expect(log.length).toBeGreaterThan(0);

    expect(existsSync(repo.home)).toBe(true);
    expect(repo.home).not.toBe(homedir());

    const realRegistryPath = join(homedir(), ".coreartifact", "registry.jsonl");
    expect(repo.registryPath).not.toBe(realRegistryPath);

    await repo.cleanup();
    expect(existsSync(repo.root)).toBe(false);
  });

  it("the CLI runner builds and spawns the real CLI, which prints usage naming init, log and show with no args and exits nonzero on an unknown command", async () => {
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

  it("the fixture replayer pipes a real fixture stream into a stub command that records the stdin it received, one invocation per line", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "coreartifact-harness-selftest-"));
    try {
      const stubPath = join(workDir, "stub.cjs");
      const resultsFile = join(workDir, "results.ndjson");
      writeFileSync(stubPath, STUB_SCRIPT);
      writeFileSync(resultsFile, "");

      const result = await replayFixtures("headless", ["node", stubPath, resultsFile]);
      expect(result.invocations.length).toBeGreaterThan(0);

      const recorded = readFileSync(resultsFile, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
      expect(recorded.length).toBe(result.invocations.length);

      for (let i = 0; i < recorded.length; i += 1) {
        const stubBytes = Buffer.from(recorded[i].base64, "base64");
        const reportedBytes = Buffer.from(result.invocations[i].stdinBytes);
        expect(stubBytes.equals(reportedBytes)).toBe(true);
        expect(typeof result.invocations[i].exitCode).toBe("number");
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
      }).trim();
      const resolvedWorktreeCommonDir = resolve(worktree.checkoutPath, worktreeCommonDirRaw);

      const mainCommonDirRaw = execFileSync("git", ["rev-parse", "--git-common-dir"], {
        cwd: repo.root,
        encoding: "utf8",
      }).trim();
      const resolvedMainCommonDir = resolve(repo.root, mainCommonDirRaw);

      expect(resolvedWorktreeCommonDir).toBe(resolvedMainCommonDir);
    } finally {
      await repo.cleanup();
    }
  });
});
