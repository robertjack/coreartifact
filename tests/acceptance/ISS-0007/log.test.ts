// ISS-0007 acceptance tests — `log`: one line per session, unioned across
// repos, honest about gaps (docs/issues/ISS-0007.md).
//
// Test-harness contract: reuses the acceptance harness's primitives verbatim
// from ../harness/index.js (tmpdir-repo factory with its isolated registry,
// CLI runner, fixture replayer, worktree helper, readLedger). Also imports
// two already-shipped, independent modules as oracles rather than guessing
// their output shape: src/core/paths.js (getPaths — where the spool/ledger/
// hook artifact live) and src/ingest/footprint.js (deriveFootprintPaths —
// the footprint slice's own pure derivation, already shipped by ISS-0006,
// reused here only to compute the fixture's EXPECTED distinct-path count,
// never to guess the renderer's own output shape).
//
// Module under test: the renderer this issue owns (src/render/log.ts,
// src/render/absent.ts, src/worktree-gap.ts) plus its wiring into the
// already-shipped `log` command (src/cli/commands/log.ts). Every test below
// drives the built CLI subprocess (runCli) and asserts on its stdout/stderr
// — the public interface the spec names as the seam — never by importing
// the not-yet-existing renderer modules directly.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTmpRepo,
  runCli,
  replayFixtures,
  addWorktree,
  readLedger,
  stripNodeDiagnostics,
  type TmpRepo,
} from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { getPaths } from "../../../src/core/paths.js";
import { deriveFootprintPaths, type FootprintCandidateEvent } from "../../../src/ingest/footprint.js";

interface RawHookResult {
  exitCode: number;
}

// A single raw invocation of the installed hook command with caller-supplied
// stdin bytes — needed to inject a session missing its SessionStart line (an
// adapted payload, not a named fixture scenario the replayer can load
// wholesale). Mirrors ISS-0006's own `runRawHookInvocation` helper.
function runRawHookInvocation(command: string[], stdinText: string): Promise<RawHookResult> {
  const [cmd, ...args] = command;
  if (!cmd) throw new Error("runRawHookInvocation: empty command");
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      resolvePromise({ exitCode: code ?? -1 });
    });
    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function sessionIdOf(fixtureLine: string): string {
  const parsed = JSON.parse(fixtureLine) as { session_id?: unknown };
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
    throw new Error("test setup invariant: fixture line has no session_id");
  }
  return parsed.session_id;
}

// "Command count comes from the events table (Bash tool events for the
// session)" (spec) — the distinct Bash invocations in the fixture, computed
// from the fixture itself so a re-recording can never invalidate a hardcoded
// number.
function distinctBashCommandCount(lines: string[]): number {
  const toolUseIds = new Set<string>();
  for (const line of lines) {
    const parsed = JSON.parse(line) as { tool_name?: unknown; tool_use_id?: unknown };
    if (parsed.tool_name === "Bash" && typeof parsed.tool_use_id === "string") {
      toolUseIds.add(parsed.tool_use_id);
    }
  }
  return toolUseIds.size;
}

// "footprint count from the footprint table" (spec) — the distinct edited
// paths in the fixture, via the already-shipped, independent footprint
// derivation (ISS-0006's src/ingest/footprint.ts), never re-guessed here.
function distinctFootprintCount(lines: string[]): number {
  const candidates: FootprintCandidateEvent[] = lines.map(
    (line) => JSON.parse(line) as FootprintCandidateEvent,
  );
  return deriveFootprintPaths(candidates).length;
}

// Finds the single rendered line naming the given session (by a prefix of
// its session_id, standing in for "short id" without pinning an exact
// truncation length the renderer is free to choose).
function findSessionLine(output: string, sessionId: string): string {
  const shortIdToken = sessionId.slice(0, 6);
  const matches = output.split("\n").filter((line) => line.includes(shortIdToken));
  expect(matches.length, `expected exactly one rendered line naming session ${sessionId}, found: ${JSON.stringify(matches)}`).toBe(
    1,
  );
  return matches[0]!;
}

describe("ISS-0007 log: one line per session, unioned across repos, honest about gaps", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    "R10 Log. One line per session containing at minimum: short id, repo, status, kind-or-absent, start time, command count, footprint count. With two registered repos, log unions both. Ingest emits a warning naming any worktree missing the settings file and stays silent when propagation is complete.",
    async () => {
      // --- Phase 1: one line per session with the required fields, plus
      // the absent-kind case (a session with no captured SessionStart line
      // must never render as a guessed "headless"/"interactive"). ---
      const repo1 = await createTmpRepo();
      tmpRepos.push(repo1);
      const init1 = await runCli(["init"], { cwd: repo1.root, home: repo1.home, registryPath: repo1.registryPath });
      expect(init1.exitCode, `test setup invariant: init did not exit 0; stderr: ${init1.stderr}`).toBe(0);

      const paths1 = getPaths(repo1.root);
      const command1 = ["node", paths1.hookArtifact, repo1.root];

      const headlessLines = loadFixtureStream("headless");
      await replayFixtures("headless", repo1.root);
      const headlessSessionId = sessionIdOf(headlessLines[0]!);
      const expectedCommandCount = distinctBashCommandCount(headlessLines);
      const expectedFootprintCount = distinctFootprintCount(headlessLines);

      const missingStartSessionId = "iss7-r10-missing-start-session";
      const skippedStartLines = loadFixtureStream("SIGKILL").slice(1);
      for (const line of skippedStartLines) {
        const payload = { ...JSON.parse(line), session_id: missingStartSessionId };
        const invocation = await runRawHookInvocation(command1, JSON.stringify(payload));
        expect(invocation.exitCode, "a hook invocation for the missing-SessionStart session did not exit 0").toBe(0);
      }

      const logResult1 = await runCli(["log"], { cwd: repo1.root, home: repo1.home, registryPath: repo1.registryPath });
      expect(logResult1.exitCode, `log did not exit 0; stderr: ${logResult1.stderr}`).toBe(0);
      const output1 = `${logResult1.stdout}\n${logResult1.stderr}`;

      const ledger1 = readLedger(paths1.ledger);
      const headlessRow = ledger1.sessions.find((s) => s.session_id === headlessSessionId);
      if (!headlessRow) throw new Error("no session row found for the headless session after ingest");
      const expectedStartDatePrefix = headlessRow.started_at.slice(0, 10);

      const headlessLine = findSessionLine(output1, headlessSessionId);
      expect(headlessLine, "the session line did not name the repo (full root path)").toContain(repo1.root);
      expect(headlessLine, "the session line did not carry the session's status").toContain(headlessRow.status);
      expect(headlessLine, "the session line did not render kind as headless").toContain("headless");
      expect(headlessLine, "the session line did not carry the session's start time").toContain(
        expectedStartDatePrefix,
      );
      expect(
        headlessLine,
        `the session line did not carry the command count (expected ${expectedCommandCount}, derived from the fixture's distinct Bash tool_use_ids)`,
      ).toContain(String(expectedCommandCount));
      expect(
        headlessLine,
        `the session line did not carry the footprint count (expected ${expectedFootprintCount}, derived from the fixture via the shipped footprint module)`,
      ).toContain(String(expectedFootprintCount));

      const missingStartLine = findSessionLine(output1, missingStartSessionId);
      expect(
        missingStartLine,
        "a session with no captured SessionStart line rendered kind as headless instead of an absent marker",
      ).not.toMatch(/headless/);
      expect(
        missingStartLine,
        "a session with no captured SessionStart line rendered kind as interactive (guessed) instead of an absent marker",
      ).not.toMatch(/interactive/);

      // --- Phase 2: two-repo union — a second repo sharing repo1's
      // isolated registry (the harness's isolated-registry primitive is
      // exactly what makes this test possible: without it, this would leak
      // into a real registry or into an unrelated test's). ---
      const repo2 = await createTmpRepo();
      tmpRepos.push(repo2);
      const init2 = await runCli(["init"], {
        cwd: repo2.root,
        home: repo2.home,
        registryPath: repo1.registryPath,
      });
      expect(init2.exitCode, `test setup invariant: second repo's init did not exit 0; stderr: ${init2.stderr}`).toBe(
        0,
      );

      const paths2 = getPaths(repo2.root);
      const interactiveLines = loadFixtureStream("interactive");
      await replayFixtures("interactive", repo2.root);
      const interactiveSessionId = sessionIdOf(interactiveLines[0]!);

      const unionLogResult = await runCli(["log"], {
        cwd: repo1.root,
        home: repo1.home,
        registryPath: repo1.registryPath,
      });
      expect(unionLogResult.exitCode, `log did not exit 0; stderr: ${unionLogResult.stderr}`).toBe(0);
      const unionOutput = `${unionLogResult.stdout}\n${unionLogResult.stderr}`;

      const repo1LineInUnion = findSessionLine(unionOutput, headlessSessionId);
      expect(
        repo1LineInUnion,
        "the union output's line for repo1's session did not name repo1",
      ).toContain(repo1.root);
      const repo2LineInUnion = findSessionLine(unionOutput, interactiveSessionId);
      expect(
        repo2LineInUnion,
        "log run from repo1 did not union in repo2's session (registered under the same shared registry)",
      ).toContain(repo2.root);

      // --- Phase 3: the worktree gap warning fires for a hand-made
      // worktree that never got the settings file (created AFTER init, with
      // no session ever run in it — nothing to propagate the settings via). ---
      const repo3 = await createTmpRepo();
      tmpRepos.push(repo3);
      const init3 = await runCli(["init"], { cwd: repo3.root, home: repo3.home, registryPath: repo3.registryPath });
      expect(init3.exitCode, `test setup invariant: init did not exit 0; stderr: ${init3.stderr}`).toBe(0);
      const gapWorktree = await addWorktree(repo3, "iss7-r10-warning-fires");

      const gapLogResult = await runCli(["log"], {
        cwd: repo3.root,
        home: repo3.home,
        registryPath: repo3.registryPath,
      });
      expect(gapLogResult.exitCode, `log did not exit 0; stderr: ${gapLogResult.stderr}`).toBe(0);
      const gapOutput = stripNodeDiagnostics(`${gapLogResult.stdout}\n${gapLogResult.stderr}`);
      expect(gapOutput, "log did not warn about a worktree missing the settings file").toMatch(/warn/i);
      expect(
        gapOutput,
        "the worktree-gap warning did not name the affected worktree's checkout path",
      ).toContain(gapWorktree.checkoutPath);

      // --- Phase 4: the warning stays silent when propagation is complete
      // (worktree created BEFORE init, so init propagates the settings file
      // into it per ISS-0005's R3 propagation guarantee). ---
      const repo4 = await createTmpRepo();
      tmpRepos.push(repo4);
      const propagatedWorktree = await addWorktree(repo4, "iss7-r10-warning-silent");
      const init4 = await runCli(["init"], { cwd: repo4.root, home: repo4.home, registryPath: repo4.registryPath });
      expect(init4.exitCode, `test setup invariant: init did not exit 0; stderr: ${init4.stderr}`).toBe(0);

      const silentLogResult = await runCli(["log"], {
        cwd: repo4.root,
        home: repo4.home,
        registryPath: repo4.registryPath,
      });
      expect(silentLogResult.exitCode, `log did not exit 0; stderr: ${silentLogResult.stderr}`).toBe(0);
      const silentOutput = stripNodeDiagnostics(`${silentLogResult.stdout}\n${silentLogResult.stderr}`);
      expect(
        silentOutput,
        `log warned about a worktree even though propagation was complete before init ran (checkout: ${propagatedWorktree.checkoutPath})`,
      ).not.toMatch(/warn/i);
    },
    60000,
  );

  it(
    "log in a repo with no sessions exits 0 and prints an explicit empty-state line rather than nothing, and log run outside any registered repo exits 0 and says so",
    async () => {
      // --- Phase A: a registered repo with zero sessions. ---
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

      const emptyLogResult = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(emptyLogResult.exitCode, `log in a repo with no sessions did not exit 0; stderr: ${emptyLogResult.stderr}`).toBe(
        0,
      );
      const emptyOutput = `${emptyLogResult.stdout}\n${emptyLogResult.stderr}`;
      expect(
        emptyOutput.trim().length,
        "log in a repo with no sessions printed nothing instead of an explicit empty-state line",
      ).toBeGreaterThan(0);
      expect(
        emptyOutput,
        "log in a repo with no sessions did not print an explicit empty-state line naming the absence of sessions",
      ).toMatch(/no session/i);

      // --- Phase B: cwd is a real git repo, but never registered (no
      // `init` ever ran against it, and the registry it points at is
      // otherwise empty) — "outside any registered repo". ---
      const unregisteredRepo = await createTmpRepo();
      tmpRepos.push(unregisteredRepo);

      const outsideLogResult = await runCli(["log"], {
        cwd: unregisteredRepo.root,
        home: unregisteredRepo.home,
        registryPath: unregisteredRepo.registryPath,
      });
      expect(
        outsideLogResult.exitCode,
        `log run outside any registered repo did not exit 0; stderr: ${outsideLogResult.stderr}`,
      ).toBe(0);
      const outsideOutput = `${outsideLogResult.stdout}\n${outsideLogResult.stderr}`;
      expect(
        outsideOutput.trim().length,
        "log run outside any registered repo printed nothing instead of saying so",
      ).toBeGreaterThan(0);
      expect(
        outsideOutput,
        "log run outside any registered repo did not say so (no mention of the registry being empty/unregistered)",
      ).toMatch(/regist/i);
    },
    30000,
  );

  it(
    "log is a GLOBAL command: run from a NON-GIT directory (a plain tmpdir, not a repo) it still exits 0 and prints the union (or empty state) — it must never require cwd to be a git repo (2026-07-14 amendment, S2/S1b)",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      await replayFixtures("headless", repo.root);
      const headlessLines = loadFixtureStream("headless");
      const headlessSessionId = sessionIdOf(headlessLines[0]!);

      // A plain tmpdir with no `.git` anywhere up to the mount point — the
      // most natural place an operator would stand to ask "what's been
      // captured across all my repos?" `log` reads the registry, not cwd,
      // so this must behave identically to running it from repo.root.
      const nonGitDir = mkdtempSync(join(tmpdir(), "coreartifact-iss7-nongit-"));

      const logResult = await runCli(["log"], {
        cwd: nonGitDir,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(
        logResult.exitCode,
        `log run from a non-git directory did not exit 0 (must never require cwd to be a git repo); stderr: ${logResult.stderr}`,
      ).toBe(0);
      const output = `${logResult.stdout}\n${logResult.stderr}`;
      expect(
        output,
        "log run from a non-git directory did not union in the registered repo's session",
      ).toContain(headlessSessionId.slice(0, 6));

      rmSync(nonGitDir, { recursive: true, force: true });
    },
    30000,
  );

  it(
    "log isolates per-repo failures: with two registered repos where one has been DELETED from disk, log still prints the healthy repo's sessions, warns naming the broken one, exits 0, and does NOT recreate the deleted repo's .coreartifact/ directory (2026-07-14 amendment, S1/S3)",
    async () => {
      // Healthy repo — a registered ledger with a real session.
      const healthyRepo = await createTmpRepo();
      tmpRepos.push(healthyRepo);
      const initHealthy = await runCli(["init"], {
        cwd: healthyRepo.root,
        home: healthyRepo.home,
        registryPath: healthyRepo.registryPath,
      });
      expect(
        initHealthy.exitCode,
        `test setup invariant: healthy repo's init did not exit 0; stderr: ${initHealthy.stderr}`,
      ).toBe(0);
      const healthyPaths = getPaths(healthyRepo.root);
      await replayFixtures("headless", healthyRepo.root);
      const healthyLines = loadFixtureStream("headless");
      const healthySessionId = sessionIdOf(healthyLines[0]!);

      // Broken repo — registered under the SAME shared registry, then
      // deleted wholesale from disk (rm -rf its root), simulating a
      // registry entry the user never unregistered (v1 has no unregister).
      const brokenRepo = await createTmpRepo();
      tmpRepos.push(brokenRepo);
      const initBroken = await runCli(["init"], {
        cwd: brokenRepo.root,
        home: healthyRepo.home,
        registryPath: healthyRepo.registryPath,
      });
      expect(
        initBroken.exitCode,
        `test setup invariant: broken repo's init did not exit 0; stderr: ${initBroken.stderr}`,
      ).toBe(0);
      const brokenDataDir = join(brokenRepo.root, ".coreartifact");
      expect(
        existsSync(brokenDataDir),
        "test setup invariant: init did not create .coreartifact/ for the broken repo",
      ).toBe(true);

      rmSync(brokenRepo.root, { recursive: true, force: true });
      expect(existsSync(brokenRepo.root), "test setup invariant: the broken repo's root was not actually deleted").toBe(
        false,
      );

      const logResult = await runCli(["log"], {
        cwd: healthyRepo.root,
        home: healthyRepo.home,
        registryPath: healthyRepo.registryPath,
      });
      expect(
        logResult.exitCode,
        `log did not exit 0 with one registered repo deleted from disk; stderr: ${logResult.stderr}`,
      ).toBe(0);
      const output = `${logResult.stdout}\n${logResult.stderr}`;

      expect(
        output,
        "log did not print the healthy repo's session even though the other registered repo was deleted",
      ).toContain(healthySessionId.slice(0, 6));
      expect(output, "log did not warn, naming the deleted/unreachable repo").toMatch(/warn/i);
      expect(output, "log's warning did not name the broken repo's root path").toContain(brokenRepo.root);

      expect(
        existsSync(brokenRepo.root),
        "log recreated the deleted repo's root directory (ingest must never resurrect a gone repo)",
      ).toBe(false);
      expect(
        existsSync(brokenDataDir),
        "log recreated the deleted repo's .coreartifact/ directory (ingest -> openLedger's mkdirSync must never run before the reachability check)",
      ).toBe(false);
    },
    30000,
  );
});
