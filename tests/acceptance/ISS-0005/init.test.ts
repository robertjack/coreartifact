// ISS-0005 acceptance tests — `coreartifact init`: install per-repo capture,
// idempotently, and propagate to worktrees (docs/issues/ISS-0005.md).
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory, CLI runner, worktree
// helper, gitEnv, readSpool). Also imports two already-shipped, independent
// modules as oracles rather than guessing their output shape: src/core/paths.js
// (getPaths — where the spool/ledger/hook artifact live, keyed only by repo
// root, so its values are safe to compute from this process even though the
// CLI itself runs in a subprocess with an isolated HOME) and
// src/core/registry.js (readRegistry — already implemented by ISS-0010,
// folds the append-only registry log the same way `init`'s registry entry
// must be readable by).
//
// Module under test: the `init` command currently stubbed in
// src/cli/index.ts's COMMANDS table (`notImplemented("init")`, exits 1).
// Every test below invokes it only through the built CLI subprocess
// (runCli), never by importing CLI internals — the public interface is the
// test surface.
import { describe, it, expect, afterAll } from "vitest";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createTmpRepo, runCli, addWorktree, readSpool, gitEnv, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { getPaths } from "../../../src/core/paths.js";
import { readRegistry } from "../../../src/core/registry.js";

const NINE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
];

function gitStatusPorcelain(cwd: string, home: string): string[] {
  const output = execFileSync("git", ["status", "--porcelain"], { cwd, env: gitEnv(home), encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isGitIgnored(cwd: string, home: string, relPath: string): boolean {
  const result = spawnSync("git", ["check-ignore", "-q", relPath], { cwd, env: gitEnv(home) });
  return result.status === 0;
}

function isGitTracked(cwd: string, home: string, relPath: string): boolean {
  const result = spawnSync("git", ["ls-files", "--error-unmatch", relPath], { cwd, env: gitEnv(home) });
  return result.status === 0;
}

// Both the count-of-occurrences check (R2, no duplicate entries) and the
// find-one-command check (R3, propagated hook invocation) walk an unknown
// hooks-config shape looking for a string referencing the installed hook
// artifact's known filename (src/core/paths.ts's getPaths().hookArtifact
// always ends in "hooks/capture.mjs") rather than assuming a specific
// nesting for Claude Code's settings.local.json hooks schema.
function countCoreartifactHookOccurrences(node: unknown): number {
  if (node === undefined || node === null) return 0;
  if (typeof node === "string") return node.includes("capture.mjs") ? 1 : 0;
  if (Array.isArray(node)) {
    return node.reduce((sum: number, child) => sum + countCoreartifactHookOccurrences(child), 0);
  }
  if (typeof node === "object") {
    return Object.values(node as Record<string, unknown>).reduce(
      (sum: number, child) => sum + countCoreartifactHookOccurrences(child),
      0,
    );
  }
  return 0;
}

function findCoreartifactCommandString(node: unknown): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string") return node.includes("capture.mjs") ? node : undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findCoreartifactCommandString(child);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = findCoreartifactCommandString(value);
      if (found) return found;
    }
  }
  return undefined;
}

interface RawResult {
  exitCode: number;
}

// Runs a hook command STRING (as extracted verbatim from a settings.local.json
// hook entry, which Claude Code always stores as one shell command string,
// not an argv array) via a shell, from a given cwd, piping stdin.
function runHookCommandString(commandString: string, cwd: string, stdinText: string): Promise<RawResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(commandString, { cwd, shell: true, stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ exitCode: code ?? -1 });
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

describe("ISS-0005 init: install per-repo capture, idempotently, and propagate to worktrees", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    "R1 Install. After init in a fresh tmpdir git repo: exit 0; stdout inventories exactly what was installed (hook config, hook artifact, spool + ledger location, gitignore line, registry entry); the repo tree diff shows ONLY those additions. The hook config subscribes exactly nine events - SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, SubagentStart, SubagentStop, Stop, SessionEnd - and does NOT subscribe WorktreeCreate or WorktreeRemove.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);

      const result = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(result.exitCode, `init did not exit 0; stderr: ${result.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const inventory = `${result.stdout}\n${result.stderr}`;
      expect(inventory, "stdout inventory did not name the hook config path").toContain(
        join(repo.root, ".claude", "settings.local.json"),
      );
      expect(inventory, "stdout inventory did not name the hook artifact path").toContain(paths.hookArtifact);
      expect(inventory, "stdout inventory did not name the spool location").toContain(paths.spool);
      expect(inventory, "stdout inventory did not name the ledger location").toContain(paths.ledger);
      expect(inventory, "stdout inventory did not mention the gitignore addition").toMatch(/gitignore/i);
      expect(inventory, "stdout inventory did not mention the registry entry").toMatch(/registry/i);

      // Repo tree diff shows ONLY those additions: default `git status
      // --porcelain` already hides ignored files, so the only legitimate
      // remaining change is the .gitignore edit itself.
      const statusLines = gitStatusPorcelain(repo.root, repo.home);
      expect(statusLines.length, "init produced no .gitignore change in the tree diff").toBeGreaterThan(0);
      for (const line of statusLines) {
        expect(line, `unexpected tree change outside .gitignore: "${line}"`).toMatch(/\.gitignore$/);
      }

      const settingsPath = join(repo.root, ".claude", "settings.local.json");
      expect(existsSync(settingsPath), "init did not write .claude/settings.local.json").toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      const subscribedEvents = Object.keys(settings.hooks ?? {}).sort();
      expect(subscribedEvents, "hook config did not subscribe exactly the nine specified events").toEqual(
        [...NINE_EVENTS].sort(),
      );
      expect(
        subscribedEvents,
        "hook config subscribed WorktreeCreate, which must never be subscribed (2026-07-14 amendment)",
      ).not.toContain("WorktreeCreate");
      expect(
        subscribedEvents,
        "hook config subscribed WorktreeRemove, which must never be subscribed (2026-07-14 amendment)",
      ).not.toContain("WorktreeRemove");
    },
    30000,
  );

  it(
    "R2 Init idempotence + merge. Re-running init: exit 0, no duplicate hook entries, no duplicate registry entry. A pre-existing settings file with unrelated user keys keeps those keys intact.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);

      const first = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(first.exitCode, `first init did not exit 0; stderr: ${first.stderr}`).toBe(0);
      const second = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(second.exitCode, `re-running init did not exit 0; stderr: ${second.stderr}`).toBe(0);

      const settingsPath = join(repo.root, ".claude", "settings.local.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
      for (const event of NINE_EVENTS) {
        const count = countCoreartifactHookOccurrences(settings.hooks?.[event]);
        expect(count, `event "${event}" has a duplicated coreartifact hook entry after re-running init`).toBe(1);
      }

      const folded = await readRegistry(repo.registryPath);
      expect(folded.has(repo.root), "the registry fold has no entry for the repo root after init").toBe(true);
      const matchingCount = [...folded.keys()].filter((k) => k === repo.root).length;
      expect(matchingCount, "the registry fold contains more than one entry for the same repo root").toBe(1);

      // Merge: a pre-existing settings file with an unrelated key survives
      // byte-for-byte, never clobbered.
      const repo2 = await createTmpRepo();
      tmpRepos.push(repo2);
      const claudeDir = join(repo2.root, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      const preexisting = { customUserKey: "keep-me-untouched", hooks: {} };
      writeFileSync(join(claudeDir, "settings.local.json"), JSON.stringify(preexisting, null, 2));

      const mergeResult = await runCli(["init"], {
        cwd: repo2.root,
        home: repo2.home,
        registryPath: repo2.registryPath,
      });
      expect(
        mergeResult.exitCode,
        `init over a pre-existing settings file did not exit 0; stderr: ${mergeResult.stderr}`,
      ).toBe(0);

      const mergedSettings = JSON.parse(readFileSync(join(claudeDir, "settings.local.json"), "utf8"));
      expect(
        mergedSettings.customUserKey,
        "init clobbered an unrelated user key in a pre-existing settings file",
      ).toBe("keep-me-untouched");
    },
    30000,
  );

  it(
    "After init, neither path init writes is committable: .coreartifact/ is gitignored, .claude/settings.local.json is gitignored (init adds the line if Claude Code has not), and if .coreartifact/ was already tracked by a prior commit init warns rather than silently leaving the verbatim-payload spool committable. git status --porcelain plus the ignored-file listing shows no coreartifact-written path in a committable state.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);

      const result = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(result.exitCode, `init did not exit 0; stderr: ${result.stderr}`).toBe(0);

      expect(isGitIgnored(repo.root, repo.home, ".coreartifact/"), ".coreartifact/ is not git-ignored after init").toBe(
        true,
      );
      expect(
        isGitIgnored(repo.root, repo.home, ".claude/settings.local.json"),
        ".claude/settings.local.json is not git-ignored after init",
      ).toBe(true);

      const statusLines = gitStatusPorcelain(repo.root, repo.home);
      for (const line of statusLines) {
        expect(
          line,
          `git status --porcelain shows a coreartifact-written path in a committable state: "${line}"`,
        ).not.toMatch(/\.coreartifact|settings\.local\.json/);
      }

      // Prior-tracked .coreartifact/: a repo where a previous commit already
      // tracked .coreartifact/ before init ever ran, so appending a
      // .gitignore line cannot retroactively untrack it — init must warn
      // loudly instead of silently leaving the verbatim-payload spool
      // committable.
      const repo2 = await createTmpRepo();
      tmpRepos.push(repo2);
      const trackedDir = join(repo2.root, ".coreartifact");
      mkdirSync(trackedDir, { recursive: true });
      writeFileSync(join(trackedDir, "spool.jsonl"), '{"already":"tracked"}\n');
      execFileSync("git", ["add", ".coreartifact"], { cwd: repo2.root, env: gitEnv(repo2.home) });
      execFileSync("git", ["commit", "-q", "-m", "pre-existing tracked spool"], {
        cwd: repo2.root,
        env: gitEnv(repo2.home),
      });
      expect(
        isGitTracked(repo2.root, repo2.home, ".coreartifact/spool.jsonl"),
        "test setup invariant: .coreartifact/spool.jsonl must already be tracked before init runs",
      ).toBe(true);

      const trackedResult = await runCli(["init"], {
        cwd: repo2.root,
        home: repo2.home,
        registryPath: repo2.registryPath,
      });
      const trackedOutput = `${trackedResult.stdout}\n${trackedResult.stderr}`;
      expect(
        trackedOutput,
        "init did not warn about a .coreartifact/ path already tracked by a prior commit",
      ).toMatch(/warn/i);
      expect(
        trackedOutput,
        "init's warning about the already-tracked spool did not name .coreartifact",
      ).toMatch(/\.coreartifact/);
    },
    30000,
  );

  it(
    "R3 Propagation. init in a repo that already has a worktree: the settings file appears in that worktree, and a session run in that worktree with the propagated settings is captured into the main checkout's spool.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const worktree = await addWorktree(repo, "iss5-r3-worktree");

      const result = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(result.exitCode, `init did not exit 0; stderr: ${result.stderr}`).toBe(0);

      const worktreeSettingsPath = join(worktree.checkoutPath, ".claude", "settings.local.json");
      expect(
        existsSync(worktreeSettingsPath),
        "init did not propagate the settings file into the pre-existing worktree",
      ).toBe(true);

      const worktreeSettings = JSON.parse(readFileSync(worktreeSettingsPath, "utf8"));
      const sessionStartCommand = findCoreartifactCommandString(worktreeSettings?.hooks?.SessionStart);
      if (!sessionStartCommand) {
        throw new Error(
          "the propagated worktree settings file has no SessionStart hook command referencing the coreartifact hook artifact",
        );
      }

      const recordedLine = loadFixtureStream("headless")[0];
      if (!recordedLine) throw new Error("headless fixture has no lines to reuse");
      const payload = {
        ...JSON.parse(recordedLine),
        session_id: "iss5-r3-propagation-test",
        cwd: worktree.checkoutPath,
      };
      const payloadText = JSON.stringify(payload);

      const spoolPath = getPaths(repo.root).spool;
      const spoolBefore = readSpool(spoolPath).length;

      const replay = await runHookCommandString(sessionStartCommand, worktree.checkoutPath, payloadText);
      expect(replay.exitCode, "the propagated hook command run from the worktree did not exit 0").toBe(0);

      const spoolAfter = readSpool(spoolPath);
      expect(
        spoolAfter.length,
        "a session run in the worktree with the propagated settings did not append to the MAIN checkout's spool",
      ).toBe(spoolBefore + 1);

      const lastLine = spoolAfter[spoolAfter.length - 1];
      if (!lastLine || !lastLine.ok) {
        throw new Error("the spool line captured from the worktree session failed to parse as envelope v1");
      }
      expect(
        lastLine.eventText,
        "the spool line captured from the worktree session did not byte-preserve the replayed payload",
      ).toBe(payloadText);

      expect(
        existsSync(join(worktree.checkoutPath, ".coreartifact", "spool.jsonl")),
        "a session run in the worktree wrote its own local spool instead of landing in the main checkout's",
      ).toBe(false);
    },
    30000,
  );
});
