// ISS-0012 acceptance tests — the log->show handoff: `show` becomes global
// and prefix-tolerant, symmetrical with `log` (fixing the cross-slice
// mismatch the 2026-07-15 integration review found between ISS-0007's
// global `log` and ISS-0008's cwd-only, full-uuid-only `show`).
//
// Test-harness contract: reuses the acceptance harness's primitives
// verbatim from ../harness/index.js (tmpdir-repo factory with its isolated
// registry, CLI runner, fixture replayer, readLedger). Module under test:
// `show <session>` (src/cli/commands/show.ts) driven exclusively through
// the built CLI subprocess (runCli) — the public interface the spec names
// as the seam — never by importing not-yet-existing internals (e.g. a
// prospective src/resolve-session.ts) directly.
//
// Per docs/gotchas.md #6: every property below is asserted end-to-end
// through the real hook -> spool -> ingest -> show chain, never by reading
// the ledger to shortcut the thing being tested. The short id used to drive
// `show` is always parsed out of `log`'s own stdout (see extractShortId),
// exactly as a user would copy it — never read from the ledger.
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTmpRepo, runCli, replayFixtures, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream } from "../../fixtures/loader.js";
import { getPaths } from "../../../src/core/paths.js";

function sessionIdOf(fixtureLine: string): string {
  const parsed = JSON.parse(fixtureLine) as { session_id?: unknown };
  if (typeof parsed.session_id !== "string" || parsed.session_id.length === 0) {
    throw new Error("test setup invariant: fixture line has no session_id");
  }
  return parsed.session_id;
}

// Parses the short id `log` actually printed for a session out of its raw
// stdout — never the ledger. Locates the line via a short locator token
// (mirrors ISS-0007/ISS-0008's own findSessionLine technique) and takes the
// first whitespace-delimited field, which is where log's renderer
// (src/render/log.ts, unmodified by this issue) places the short id.
function extractShortId(logOutput: string, sessionId: string): string {
  const locatorToken = sessionId.slice(0, 6);
  const matches = logOutput.split("\n").filter((line) => line.includes(locatorToken));
  expect(
    matches.length,
    `expected exactly one log line naming session ${sessionId}, found: ${JSON.stringify(matches)}`,
  ).toBe(1);
  const line = matches[0]!.trim();
  const shortId = line.split(/\s+/)[0];
  if (!shortId) {
    throw new Error("test setup invariant: log's session line had no leading token to use as the short id");
  }
  expect(
    sessionId.startsWith(shortId),
    `test setup invariant: the token log printed first ("${shortId}") was not actually a prefix of the session's full id (${sessionId})`,
  ).toBe(true);
  return shortId;
}

describe("ISS-0012 show: global and prefix-tolerant, symmetrical with log", () => {
  const tmpRepos: TmpRepo[] = [];

  afterAll(async () => {
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  it(
    "The log-to-show handoff works as a user performs it: after sessions are captured in a registered repo, running log, parsing the SHORT id out of log's actual stdout (never read from the ledger), and running show with that short id - from a NON-GIT working directory - prints that session's timeline and exits 0.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];
      const headlessLines = loadFixtureStream("headless");
      await replayFixtures("headless", command);
      const sessionId = sessionIdOf(headlessLines[0]!);

      const logResult = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(logResult.exitCode, `test setup invariant: log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);
      const logOutput = `${logResult.stdout}\n${logResult.stderr}`;
      const shortId = extractShortId(logOutput, sessionId);
      expect(
        shortId.length,
        "test setup invariant: the parsed short id was not actually shorter than the full session id",
      ).toBeLessThan(sessionId.length);

      // A plain tmpdir with no `.git` anywhere up to the mount point — the
      // handoff must work from here exactly as it would from inside the
      // owning repo.
      const nonGitDir = mkdtempSync(join(tmpdir(), "coreartifact-iss12-handoff-"));

      const showResult = await runCli(["show", shortId], {
        cwd: nonGitDir,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(
        showResult.exitCode,
        `show <short-id-from-log> run from a non-git cwd did not exit 0; stderr: ${showResult.stderr}`,
      ).toBe(0);
      const showOutput = `${showResult.stdout}\n${showResult.stderr}`;
      expect(
        showOutput,
        "show did not print the resolved session's full id in its header after resolving a short id copied from log's stdout",
      ).toContain(sessionId);
      expect(
        showOutput,
        "show did not render the session's timeline (SessionStart) after resolving from a short id copied from log's stdout",
      ).toMatch(/SessionStart/);

      rmSync(nonGitDir, { recursive: true, force: true });
    },
    60000,
  );

  it(
    "show resolves its session argument across ALL registered repos via the registry union, with the same per-repo degradation log has: a session captured in repo A opens from any cwd, and an unreachable registered repo is warned-and-skipped, never sinking the lookup.",
    async () => {
      const repoA = await createTmpRepo();
      tmpRepos.push(repoA);
      const initA = await runCli(["init"], { cwd: repoA.root, home: repoA.home, registryPath: repoA.registryPath });
      expect(initA.exitCode, `test setup invariant: repo A's init did not exit 0; stderr: ${initA.stderr}`).toBe(0);

      const pathsA = getPaths(repoA.root);
      const commandA = ["node", pathsA.hookArtifact, repoA.root];
      const headlessLines = loadFixtureStream("headless");
      await replayFixtures("headless", commandA);
      const sessionId = sessionIdOf(headlessLines[0]!);

      // repo B — registered under the SAME shared registry, no session of
      // its own — is where `show` is actually invoked from.
      const repoB = await createTmpRepo();
      tmpRepos.push(repoB);
      const initB = await runCli(["init"], {
        cwd: repoB.root,
        home: repoA.home,
        registryPath: repoA.registryPath,
      });
      expect(initB.exitCode, `test setup invariant: repo B's init did not exit 0; stderr: ${initB.stderr}`).toBe(0);

      // A third repo, registered then deleted wholesale from disk — the
      // registry is append-only with no unregister in v1, so this is a
      // normal reachable state the lookup must survive (mirrors ISS-0007's
      // own "isolates per-repo failures" degradation test).
      const brokenRepo = await createTmpRepo();
      tmpRepos.push(brokenRepo);
      const initBroken = await runCli(["init"], {
        cwd: brokenRepo.root,
        home: repoA.home,
        registryPath: repoA.registryPath,
      });
      expect(
        initBroken.exitCode,
        `test setup invariant: broken repo's init did not exit 0; stderr: ${initBroken.stderr}`,
      ).toBe(0);
      rmSync(brokenRepo.root, { recursive: true, force: true });
      expect(
        existsSync(brokenRepo.root),
        "test setup invariant: the broken repo's root was not actually deleted",
      ).toBe(false);

      const showResult = await runCli(["show", sessionId], {
        cwd: repoB.root,
        home: repoA.home,
        registryPath: repoA.registryPath,
      });
      expect(
        showResult.exitCode,
        `show run from repo B for a session captured only in repo A did not exit 0 (registry union); stderr: ${showResult.stderr}`,
      ).toBe(0);
      const output = `${showResult.stdout}\n${showResult.stderr}`;
      expect(
        output,
        "show run from an unrelated registered repo's cwd did not resolve a session captured in a different registered repo",
      ).toContain(sessionId);
      expect(
        output,
        "show did not warn about the unreachable registered repo (must warn-and-skip, never silently ignore it)",
      ).toMatch(/warn/i);
      expect(
        output,
        "show's warning did not name the unreachable repo's root path",
      ).toContain(brokenRepo.root);
    },
    60000,
  );

  it(
    "An AMBIGUOUS short id fails honestly: when a prefix matches more than one session row across the union (including the same session_id present in two repos' ledgers), show exits nonzero and lists every candidate with its full session id and repo, never silently picking one.",
    async () => {
      const repo1 = await createTmpRepo();
      tmpRepos.push(repo1);
      const init1 = await runCli(["init"], { cwd: repo1.root, home: repo1.home, registryPath: repo1.registryPath });
      expect(init1.exitCode, `test setup invariant: repo1's init did not exit 0; stderr: ${init1.stderr}`).toBe(0);

      const paths1 = getPaths(repo1.root);
      const command1 = ["node", paths1.hookArtifact, repo1.root];
      const headlessLines = loadFixtureStream("headless");
      await replayFixtures("headless", command1);
      const sessionId = sessionIdOf(headlessLines[0]!);

      // repo2, registered under the SAME shared registry, replays the
      // IDENTICAL fixture stream — the fixture's session_id is data inside
      // the stream itself, so this deterministically yields the SAME
      // session_id in a SECOND repo's ledger (the real ambiguous case the
      // spec names, not a contrived duplicate).
      const repo2 = await createTmpRepo();
      tmpRepos.push(repo2);
      const init2 = await runCli(["init"], {
        cwd: repo2.root,
        home: repo1.home,
        registryPath: repo1.registryPath,
      });
      expect(init2.exitCode, `test setup invariant: repo2's init did not exit 0; stderr: ${init2.stderr}`).toBe(0);
      const paths2 = getPaths(repo2.root);
      const command2 = ["node", paths2.hookArtifact, repo2.root];
      await replayFixtures("headless", command2);

      const showResult = await runCli(["show", sessionId], {
        cwd: repo1.root,
        home: repo1.home,
        registryPath: repo1.registryPath,
      });
      expect(
        showResult.exitCode,
        "show with a session id present in two different repos' ledgers exited 0 (expected nonzero — ambiguity must fail honestly, never silently pick one)",
      ).not.toBe(0);
      const output = `${showResult.stdout}\n${showResult.stderr}`;
      expect(
        output,
        "show's ambiguous-match error did not list the shared session's full id",
      ).toContain(sessionId);
      expect(
        output,
        "show's ambiguous-match error did not name repo1 as one of the candidates",
      ).toContain(repo1.root);
      expect(
        output,
        "show's ambiguous-match error did not name repo2 as one of the candidates",
      ).toContain(repo2.root);
    },
    60000,
  );

  it(
    "A full session id continues to work exactly as before, an unknown id (prefix or full) exits nonzero naming the id, and an empty or too-short prefix (below the length log prints) is rejected with a usage error rather than treated as a match-everything prefix.",
    async () => {
      const repo = await createTmpRepo();
      tmpRepos.push(repo);
      const initResult = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(initResult.exitCode, `test setup invariant: init did not exit 0; stderr: ${initResult.stderr}`).toBe(0);

      const paths = getPaths(repo.root);
      const command = ["node", paths.hookArtifact, repo.root];
      const headlessLines = loadFixtureStream("headless");
      await replayFixtures("headless", command);
      const sessionId = sessionIdOf(headlessLines[0]!);

      // --- A full session id continues to work exactly as before. ---
      const fullIdResult = await runCli(["show", sessionId], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(
        fullIdResult.exitCode,
        `show with the full session id did not exit 0; stderr: ${fullIdResult.stderr}`,
      ).toBe(0);
      expect(
        `${fullIdResult.stdout}\n${fullIdResult.stderr}`,
        "show with the full session id did not render the session's timeline",
      ).toMatch(/SessionStart/);

      // The threshold is whatever length log ACTUALLY prints, read from
      // log's own stdout rather than assumed.
      const logResult = await runCli(["log"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
      expect(logResult.exitCode, `test setup invariant: log did not exit 0; stderr: ${logResult.stderr}`).toBe(0);
      const shortId = extractShortId(`${logResult.stdout}\n${logResult.stderr}`, sessionId);

      // --- An unknown FULL id exits nonzero, naming the id. ---
      const unknownFullId = "00000000-0000-0000-0000-000000000000";
      const unknownFullResult = await runCli(["show", unknownFullId], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(
        unknownFullResult.exitCode,
        "show with an unknown full session id exited 0 (expected nonzero)",
      ).not.toBe(0);
      expect(
        `${unknownFullResult.stdout}\n${unknownFullResult.stderr}`,
        "show with an unknown full id did not name the id in its error output",
      ).toContain(unknownFullId);

      // --- An unknown id at the SAME length log prints (a same-length
      // prefix matching no session) exits nonzero, naming the id. "z" never
      // appears in a hex-formatted session id, so this cannot collide. ---
      const unknownPrefixAtLogLength = "z".repeat(shortId.length);
      const unknownPrefixResult = await runCli(["show", unknownPrefixAtLogLength], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(
        unknownPrefixResult.exitCode,
        "show with an unknown prefix at log's own short-id length exited 0 (expected nonzero)",
      ).not.toBe(0);
      expect(
        `${unknownPrefixResult.stdout}\n${unknownPrefixResult.stderr}`,
        "show with an unknown same-length prefix did not name the id/prefix in its error output",
      ).toContain(unknownPrefixAtLogLength);

      // --- A prefix shorter than what log prints is a usage error, never a
      // match-everything wildcard. ---
      const tooShortPrefix = shortId.slice(0, shortId.length - 1);
      const tooShortResult = await runCli(["show", tooShortPrefix], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(
        tooShortResult.exitCode,
        "show with a prefix shorter than the length log prints exited 0 (expected nonzero usage error)",
      ).not.toBe(0);
      expect(
        `${tooShortResult.stdout}\n${tooShortResult.stderr}`,
        "show with a too-short prefix did not report a usage error (must reject explicitly, never silently treat it as a match-everything prefix)",
      ).toMatch(/usage/i);

      // --- An empty prefix is likewise a usage error, not a
      // match-everything wildcard. ---
      const emptyResult = await runCli(["show", ""], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(
        emptyResult.exitCode,
        "show with an empty session argument exited 0 (expected nonzero usage error)",
      ).not.toBe(0);
      expect(
        `${emptyResult.stdout}\n${emptyResult.stderr}`,
        "show with an empty session argument did not report a usage error",
      ).toMatch(/usage/i);
    },
    60000,
  );
});
