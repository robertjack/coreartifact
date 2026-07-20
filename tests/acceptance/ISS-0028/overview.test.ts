// ISS-0028 acceptance tests — GET /api/overview, the cross-repo union view
// (docs/issues/ISS-0028.md, api.md Surface C). Every criterion here drives
// the BUILT CLI as a real subprocess (`open --port 0 --no-browser`) and
// asserts raw HTTP over loopback, mirroring ISS-0027's own Test-harness
// contract precedent (tests/acceptance/ISS-0027/open-and-getwall.test.ts):
// the endpoint cannot be red-tested without the server, and driving it
// through HTTP means this suite imports neither the not-yet-existing
// src/dashboard/overview.ts nor src/dashboard/classify.ts directly — the
// HTTP surface IS the seam api.md commits to.
//
// Seeding is real-path only (the issue packet's "Test-harness contract"):
// every session is either replayed through the installed hook (the shared
// acceptance harness's replayFixtures/replayLines, which pin cwd/
// transcript_path by construction — ISS-0033) or, where the packet
// explicitly sanctions it (an old session outside the window, many
// sessions for the cap test, and the drift fixture whose transcript has no
// registered replay scenario), appended directly to the repo's own spool
// file as a well-formed envelope line — never a direct ledger write.
//
// Footprint note: the write-guard restricts this agent to
// tests/acceptance/ISS-0028/** only. The issue packet names
// tests/fixtures/dashboard/** and tests/unit/dashboard-classify.test.ts as
// sibling footprint paths, but this agent cannot create files there — the
// classify.ts pure-logic unit tests instead live alongside this file at
// tests/acceptance/ISS-0028/classify.test.ts, and the hand-authored
// out-of-range-version transcript is generated at test RUNTIME into each
// test's own disposable tmpdir rather than committed under
// tests/fixtures/dashboard/.
import { describe, it, expect, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, appendFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http, { type IncomingHttpHeaders } from "node:http";
import { createTmpRepo, runCli, replayLines, baseHermeticEnv, type TmpRepo } from "../harness/index.js";
import { loadFixtureStream, loadTranscriptPair } from "../../fixtures/loader.js";
import { getPaths } from "../../../src/core/paths.js";

// tests/acceptance/ISS-0028/overview.test.ts -> repo root is three levels up
// (same depth as ISS-0027's own open-and-getwall.test.ts).
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "bin.js");
const COST_HEADLESS_TRANSCRIPT_PATH = join(REPO_ROOT, "tests", "fixtures", "transcripts", "cost-headless.transcript.jsonl");

function assertBuilt(): void {
  if (!existsSync(CLI_ENTRY)) {
    throw new Error(
      `CLI build not found at ${CLI_ENTRY}. The harness's globalSetup (tests/acceptance/harness/globalSetup.ts) ` +
        "is supposed to build it once before any test runs.",
    );
  }
}

interface HermeticEnvOptions {
  home: string;
  registryPath: string;
}

function envFor(options: HermeticEnvOptions): NodeJS.ProcessEnv {
  const base = baseHermeticEnv(options.home);
  return {
    ...base,
    COREARTIFACT_REGISTRY_ROOT: dirname(options.registryPath),
  };
}

interface SpawnedOpen {
  child: ChildProcess;
  url: string;
  stdout(): string;
  stderr(): string;
}

function spawnOpenAndWaitForUrl(cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<SpawnedOpen> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [CLI_ENTRY, "open", "--port", "0", "--no-browser"], { cwd, env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`open did not print a URL within ${timeoutMs}ms; stdout: ${stdout}; stderr: ${stderr}`));
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (settled) return;
      const match = stdout.match(/https?:\/\/\S+/);
      if (match) {
        settled = true;
        clearTimeout(timer);
        const url = match[0].replace(/[).,;'"]+$/, "");
        resolvePromise({ child, url, stdout: () => stdout, stderr: () => stderr });
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`open exited (code ${code}) before printing a URL; stdout: ${stdout}; stderr: ${stderr}`));
    });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolvePromise) => {
    child.on("exit", () => resolvePromise());
  });
}

interface HttpJsonResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: any;
  rawBody: string;
}

function httpGetJson(baseUrl: string, path: string): Promise<HttpJsonResult> {
  return new Promise((resolvePromise, reject) => {
    const target = new URL(path, baseUrl);
    const req = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: "GET", timeout: 10_000 },
      (res) => {
        let rawBody = "";
        res.on("data", (chunk) => (rawBody += chunk));
        res.on("end", () => {
          let body: any = undefined;
          try {
            body = JSON.parse(rawBody);
          } catch {
            body = undefined;
          }
          resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body, rawBody });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error(`request to ${target.toString()} timed out`)));
    req.end();
  });
}

// Overrides session_id on every raw hook-payload line of an already-loaded
// fixture stream -- needed whenever a single scenario's fixture stream
// (baked-in session_id) must appear more than once, or alongside another
// scenario, in the same repo.
function overrideSessionId(lines: string[], sessionId: string): string[] {
  return lines.map((line) => JSON.stringify({ ...JSON.parse(line), session_id: sessionId }));
}

// A truncated (no SessionEnd) prefix of a fixture stream, session_id
// overridden -- leaves the session open so the single-open-session check
// binding rule (ISS-0017 prior art) binds a subsequently-run `check` to it.
function truncatedOpen(fullLines: string[], sessionId: string): string[] {
  return overrideSessionId(fullLines.slice(0, -1), sessionId);
}

// Replays just the final (SessionEnd) line of a fixture stream under the
// given session_id -- closes a session previously opened via truncatedOpen.
async function closeSession(pinTarget: string, fullLines: string[], sessionId: string): Promise<void> {
  const last = fullLines[fullLines.length - 1]!;
  const overridden = JSON.stringify({ ...JSON.parse(last), session_id: sessionId });
  await replayLines([overridden], pinTarget);
}

function loadRawFixtureLines(relPath: string): string[] {
  const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
  return text.split("\n").filter((l) => l.trim().length > 0);
}

// Hand-authors a minimal SessionStart-only envelope line and appends it
// directly to the repo's own spool -- the packet's own sanctioned technique
// for the 8-day-old exclusion case, reused here (with an explicit ts) for
// the cap test and the drift fixture, both of which need timestamps or
// transcript paths the real hook cannot be told to fabricate (the hook
// always stamps its own real-now ts at replay). This bypasses the harness's
// replay pin entirely by design -- it never replays a recorded fixture, so
// `cwd` here is always this test's own live tmp-repo root, never a
// leftover recording-machine path.
function appendHandAuthoredSession(
  spoolPath: string,
  ts: string,
  sessionId: string,
  pinTarget: string,
  transcriptPath: string | null,
): void {
  const event: Record<string, unknown> = {
    session_id: sessionId,
    hook_event_name: "SessionStart",
    source: "startup",
    cwd: pinTarget,
  };
  if (transcriptPath !== null) event.transcript_path = transcriptPath;
  const line = `${JSON.stringify({ v: 1, ts, event })}\n`;
  appendFileSync(spoolPath, line);
}

// Recursively searches an arbitrary JSON value for a string that equals or
// contains `target` -- used only for the drift entry shape, whose exact key
// names api.md's own text ("naming that session_id, its version, and the
// range") never pins down the way it pins kpi.*/tiles.*/sessions.*/repos
// dotted paths. Guessing a key name here would trap a correct
// implementation that reasonably chose different field names; asserting on
// the VALUES the criterion actually names does not.
function deepContainsValue(value: unknown, target: string): boolean {
  if (typeof value === "string") return value === target || value.includes(target);
  if (typeof value === "number") return String(value) === target;
  if (Array.isArray(value)) return value.some((v) => deepContainsValue(v, target));
  if (value && typeof value === "object") return Object.values(value).some((v) => deepContainsValue(v, target));
  return false;
}

async function registerSecondRepo(primary: TmpRepo, second: TmpRepo): Promise<void> {
  const result = await runCli(["init"], { cwd: second.root, home: primary.home, registryPath: primary.registryPath });
  if (result.exitCode !== 0) {
    throw new Error(`test setup invariant: init of the second repo did not exit 0; stderr: ${result.stderr}`);
  }
}

describe("ISS-0028 GET /api/overview: the verified-delegation headline", () => {
  const tmpRepos: TmpRepo[] = [];
  const liveChildren: ChildProcess[] = [];

  afterAll(async () => {
    for (const child of liveChildren) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
    for (const repo of tmpRepos) {
      await repo.cleanup();
    }
  });

  async function makeRepo(): Promise<TmpRepo> {
    const repo = await createTmpRepo();
    tmpRepos.push(repo);
    return repo;
  }

  async function initRepo(repo: TmpRepo): Promise<void> {
    const result = await runCli(["init"], { cwd: repo.root, home: repo.home, registryPath: repo.registryPath });
    expect(result.exitCode, `test setup invariant: init did not exit 0; stderr: ${result.stderr}`).toBe(0);
  }

  async function openServerFor(home: string, registryPath: string, cwd: string): Promise<SpawnedOpen> {
    assertBuilt();
    const env = envFor({ home, registryPath });
    const opened = await spawnOpenAndWaitForUrl(cwd, env);
    liveChildren.push(opened.child);
    return opened;
  }

  async function stop(opened: SpawnedOpen): Promise<void> {
    opened.child.kill("SIGTERM");
    await waitForExit(opened.child);
  }

  it(
    "Against a seeded registry with headless session A carrying one passing bound check, headless B carrying a failing bound check, headless C with no checks, interactive D, and a hand-authored kind-ABSENT session E, GET /api/overview returns kpi.delegated_total 3, kpi.verified 1, kpi.failing 1, kpi.unverified 1, and kpi.unknown_kind 1.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);

      const headlessLines = loadFixtureStream("headless");
      const interactiveLines = loadFixtureStream("interactive");
      const clearSourceLines = loadRawFixtureLines("tests/fixtures/clear-source.jsonl");

      // A: passing bound check.
      await replayLines(truncatedOpen(headlessLines, "iss28-r1-session-a"), repo.root);
      const checkA = await runCli(["check", "r1-check-a", "--", "node", "-e", "process.exit(0)"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(checkA.exitCode, "the passing check for session A must exit 0").toBe(0);
      await closeSession(repo.root, headlessLines, "iss28-r1-session-a");

      // B: failing bound check.
      await replayLines(truncatedOpen(headlessLines, "iss28-r1-session-b"), repo.root);
      const checkB = await runCli(["check", "r1-check-b", "--", "node", "-e", "process.exit(1)"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(checkB.exitCode, "the failing check for session B must exit with the wrapped command's code").toBe(1);
      await closeSession(repo.root, headlessLines, "iss28-r1-session-b");

      // C: headless, zero checks.
      await replayLines(overrideSessionId(headlessLines, "iss28-r1-session-c"), repo.root);

      // D: interactive.
      await replayLines(overrideSessionId(interactiveLines, "iss28-r1-session-d"), repo.root);

      // E: kind-ABSENT (source "clear", no model).
      await replayLines(overrideSessionId(clearSourceLines, "iss28-r1-session-e"), repo.root);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const res = await httpGetJson(opened.url, "/api/overview");
        expect(res.status, `GET /api/overview did not return 200; body: ${res.rawBody}`).toBe(200);
        expect(res.body.kpi?.delegated_total, "kpi.delegated_total must count only the three headless sessions").toBe(3);
        expect(res.body.kpi?.verified, "kpi.verified must count session A (one passing bound check)").toBe(1);
        expect(res.body.kpi?.failing, "kpi.failing must count session B (one failing bound check)").toBe(1);
        expect(res.body.kpi?.unverified, "kpi.unverified must count session C (zero bound checks)").toBe(1);
        expect(res.body.kpi?.unknown_kind, "kpi.unknown_kind must count session E (kind ABSENT), excluded from the KPI denominator").toBe(1);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "For the same seeded registry, GET /api/overview returns tiles.spend_present_usd equal to the sum of the present cost_usd values and tiles.cost_absent_count equal to the count of in-window sessions whose cost is ABSENT, and never reports a session with ABSENT cost as a zero contribution to the sum.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);

      // Present-cost session: transcript materialized in place via the
      // fixtures' own sanctioned technique for a replayed stream
      // (tests/fixtures/transcriptReplay.ts's buildSubstitutedTranscript),
      // named by the issue packet as the tool for this exact seeding need.
      // Its transcript_path is already substituted (workDir == repo.root);
      // the harness's own replayLines pins cwd to repo.root by construction.
      const { buildSubstitutedTranscript } = await import("../../fixtures/transcriptReplay.js");
      const presentSubstituted = buildSubstitutedTranscript("cost-headless", repo.root);
      await replayLines(presentSubstituted.lines, repo.root, {
        transcriptPathOverride: presentSubstituted.transcriptPath,
      });

      // Absent-cost session: a headless replay whose transcript_path is
      // pinned to a path that does not exist in this tmpdir by construction
      // -- cost reads ABSENT.
      const headlessLines = loadFixtureStream("headless");
      await replayLines(overrideSessionId(headlessLines, "iss28-r2-absent"), repo.root, {
        transcriptPathOverride: join(repo.root, "no-such-transcript.jsonl"),
      });

      const oracle = loadTranscriptPair("cost-headless").oracle;
      if (!oracle) throw new Error("test setup invariant: cost-headless transcript pair has no oracle");

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const res = await httpGetJson(opened.url, "/api/overview");
        expect(res.status, `GET /api/overview did not return 200; body: ${res.rawBody}`).toBe(200);
        expect(
          res.body.tiles?.spend_present_usd,
          "tiles.spend_present_usd must equal the independently-known oracle cost of the one present-cost session, never zero or a fabricated figure",
        ).toBeCloseTo(oracle.total_cost_usd, 6);
        expect(
          res.body.tiles?.cost_absent_count,
          "tiles.cost_absent_count must count exactly the one session whose cost is ABSENT",
        ).toBe(1);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "For the same seeded registry, GET /api/overview returns tiles.sessions_by_kind with the headless, interactive, and unknown counts and tiles.failing_checks equal to the count of bound checks with exit_code not zero.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const headlessLines = loadFixtureStream("headless");
      const interactiveLines = loadFixtureStream("interactive");
      const clearSourceLines = loadRawFixtureLines("tests/fixtures/clear-source.jsonl");

      // A standalone check (zero open sessions) must never count toward
      // failing_checks, even though it fails -- only BOUND checks count.
      const standalone = await runCli(["check", "r3-standalone-fail", "--", "node", "-e", "process.exit(1)"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(standalone.exitCode, "the standalone check must still exit with the wrapped command's code").toBe(1);

      // H1: headless, bound failing check.
      await replayLines(truncatedOpen(headlessLines, "iss28-r3-h1"), repo.root);
      const checkH1 = await runCli(["check", "r3-h1-fail", "--", "node", "-e", "process.exit(1)"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(checkH1.exitCode).toBe(1);
      await closeSession(repo.root, headlessLines, "iss28-r3-h1");

      // H2: headless, bound passing check.
      await replayLines(truncatedOpen(headlessLines, "iss28-r3-h2"), repo.root);
      const checkH2 = await runCli(["check", "r3-h2-pass", "--", "node", "-e", "process.exit(0)"], {
        cwd: repo.root,
        home: repo.home,
        registryPath: repo.registryPath,
      });
      expect(checkH2.exitCode).toBe(0);
      await closeSession(repo.root, headlessLines, "iss28-r3-h2");

      // I1: interactive.
      await replayLines(overrideSessionId(interactiveLines, "iss28-r3-i1"), repo.root);
      // U1: unknown kind.
      await replayLines(overrideSessionId(clearSourceLines, "iss28-r3-u1"), repo.root);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const res = await httpGetJson(opened.url, "/api/overview");
        expect(res.status, `GET /api/overview did not return 200; body: ${res.rawBody}`).toBe(200);
        expect(res.body.tiles?.sessions_by_kind?.headless, "sessions_by_kind.headless must count H1 and H2").toBe(2);
        expect(res.body.tiles?.sessions_by_kind?.interactive, "sessions_by_kind.interactive must count I1").toBe(1);
        expect(res.body.tiles?.sessions_by_kind?.unknown, "sessions_by_kind.unknown must count U1").toBe(1);
        expect(
          res.body.tiles?.failing_checks,
          "tiles.failing_checks must count only H1's bound failing check, never the standalone failing check",
        ).toBe(1);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "GET /api/overview returns sessions.latest capped at the LATEST_SESSIONS_LIMIT of 50 newest in-window sessions and sessions.total equal to the true count of in-window sessions across the union.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);

      const now = new Date();
      const TOTAL = 51;
      const lines: string[] = [];
      for (let k = 0; k < TOTAL; k++) {
        const ts = new Date(now.getTime() - k * 60_000).toISOString();
        const sessionId = `iss28-r4-cap-${String(k).padStart(3, "0")}`;
        const event = {
          session_id: sessionId,
          hook_event_name: "SessionStart",
          source: "startup",
          cwd: repo.root,
          transcript_path: `/nonexistent/coreartifact-cap-test/${sessionId}.jsonl`,
        };
        lines.push(`${JSON.stringify({ v: 1, ts, event })}\n`);
      }
      appendFileSync(paths.spool, lines.join(""));

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const res = await httpGetJson(opened.url, "/api/overview");
        expect(res.status, `GET /api/overview did not return 200; body: ${res.rawBody}`).toBe(200);
        expect(res.body.sessions?.total, "sessions.total must be the TRUE in-window count, uncapped").toBe(TOTAL);
        expect(
          Array.isArray(res.body.sessions?.latest) && res.body.sessions.latest.length,
          "sessions.latest must be capped at LATEST_SESSIONS_LIMIT (50), never the full 51",
        ).toBe(50);

        const latestIds = new Set((res.body.sessions.latest as Array<{ session_id: string }>).map((s) => s.session_id));
        const expectedNewest = new Set(
          Array.from({ length: 50 }, (_, k) => `iss28-r4-cap-${String(k).padStart(3, "0")}`),
        );
        expect(
          [...latestIds].sort(),
          "sessions.latest must contain exactly the 50 NEWEST sessions (k=0..49), not an arbitrary 50",
        ).toEqual([...expectedNewest].sort());
        expect(
          latestIds.has("iss28-r4-cap-050"),
          "the single oldest session (k=50) must be excluded from the capped latest list",
        ).toBe(false);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "A session seeded with started_at eight days before the request instant is absent from kpi, tiles, sessions, and drift, while a session seeded one day before the request instant is present in them.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);

      const now = new Date();
      const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const oneDayAgo = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();

      // The old session's transcript carries an out-of-range cc_version --
      // proving the window excludes it from drift too, not merely from kpi
      // counts. Generated at test runtime into this repo's own tree (this
      // agent's write footprint cannot hold a committed fixture file).
      const oldTranscriptPath = join(repo.base, "old-session.transcript.jsonl");
      writeFileSync(oldTranscriptPath, `${JSON.stringify({ version: "2.1.220", type: "summary" })}\n`);

      appendHandAuthoredSession(paths.spool, eightDaysAgo, "iss28-r5-old-8day", repo.root, oldTranscriptPath);
      appendHandAuthoredSession(paths.spool, oneDayAgo, "iss28-r5-new-1day", repo.root, null);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const res = await httpGetJson(opened.url, "/api/overview");
        expect(res.status, `GET /api/overview did not return 200; body: ${res.rawBody}`).toBe(200);
        expect(res.body.kpi?.delegated_total, "the 8-day-old session must not count toward kpi.delegated_total").toBe(1);
        expect(
          res.body.tiles?.sessions_by_kind?.headless,
          "the 8-day-old session must not count toward tiles.sessions_by_kind.headless",
        ).toBe(1);
        expect(res.body.sessions?.total, "sessions.total must exclude the 8-day-old session").toBe(1);

        const latest = res.body.sessions?.latest as Array<{ session_id: string }>;
        expect(latest?.some((s) => s.session_id === "iss28-r5-new-1day"), "the 1-day-old session must appear in sessions.latest").toBe(true);
        expect(latest?.some((s) => s.session_id === "iss28-r5-old-8day"), "the 8-day-old session must never appear in sessions.latest").toBe(false);

        expect(
          deepContainsValue(res.body.drift, "iss28-r5-old-8day"),
          "the 8-day-old session must never produce a drift entry, even though its recorded cc_version (2.1.220) is out of range -- the window excludes it first",
        ).toBe(false);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "GET /api/overview?repo=<root> scopes every aggregate to that one registered root, and GET /api/overview?repo=<unregistered> returns 404 with error code repo_not_registered naming the root.",
    async () => {
      const repoA = await makeRepo();
      await initRepo(repoA);
      const repoB = await makeRepo();
      await registerSecondRepo(repoA, repoB);

      const headlessLines = loadFixtureStream("headless");
      await replayLines(overrideSessionId(headlessLines, "iss28-r6-scope-a"), repoA.root);
      await replayLines(overrideSessionId(headlessLines, "iss28-r6-scope-b"), repoB.root);

      const opened = await openServerFor(repoA.home, repoA.registryPath, repoA.root);
      try {
        const scopedRes = await httpGetJson(opened.url, `/api/overview?repo=${encodeURIComponent(repoA.root)}`);
        expect(scopedRes.status, `scoped GET /api/overview did not return 200; body: ${scopedRes.rawBody}`).toBe(200);
        expect(scopedRes.body.sessions?.total, "?repo= scoping must limit sessions.total to the named root's own sessions").toBe(1);
        expect(scopedRes.body.kpi?.delegated_total, "?repo= scoping must limit kpi.delegated_total to the named root's own sessions").toBe(1);
        const scopedIds = (scopedRes.body.sessions?.latest as Array<{ session_id: string }>).map((s) => s.session_id);
        expect(scopedIds, "the scoped response must include repoA's own session").toContain("iss28-r6-scope-a");
        expect(scopedIds, "the scoped response must never include repoB's session").not.toContain("iss28-r6-scope-b");

        const unregisteredRoot = join(repoA.base, "never-registered-repo");
        const notFoundRes = await httpGetJson(opened.url, `/api/overview?repo=${encodeURIComponent(unregisteredRoot)}`);
        expect(notFoundRes.status, "?repo=<unregistered> must return 404").toBe(404);
        expect(notFoundRes.body?.error?.code, "the 404 JSON error body code must be repo_not_registered").toBe("repo_not_registered");
        expect(
          deepContainsValue(notFoundRes.body, unregisteredRoot),
          "the 404 error must name the offending unregistered root",
        ).toBe(true);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "With two registered repos where one repo's ledger is unreadable, GET /api/overview still reports the healthy repo's sessions and lists the unreadable repo in repos with status unreadable and a reason string, and does not crash or omit it.",
    async () => {
      const repoA = await makeRepo();
      await initRepo(repoA);
      const repoB = await makeRepo();
      await registerSecondRepo(repoA, repoB);

      const pathsB = getPaths(repoB.root);
      await replayLines(overrideSessionId(loadFixtureStream("headless"), "iss28-r7-healthy"), repoA.root);

      // Make repoB's ledger path a directory instead of a file: openLedger
      // (src/core/ledger.ts) throws LedgerPathIsDirectoryError on this
      // shape BEFORE any rebuild-on-corruption self-heal can kick in, so
      // this failure persists across the handler's own ingest-on-read --
      // unlike garbage bytes in a real file, which openLedger's own
      // rebuild-trigger would silently repair.
      mkdirSync(pathsB.ledger, { recursive: true });

      const opened = await openServerFor(repoA.home, repoA.registryPath, repoA.root);
      try {
        const res = await httpGetJson(opened.url, "/api/overview");
        expect(res.status, `GET /api/overview did not return 200 despite the unreadable repo; body: ${res.rawBody}`).toBe(200);
        expect(res.body.sessions?.total, "the healthy repo's session must still be counted").toBe(1);
        const ids = (res.body.sessions?.latest as Array<{ session_id: string }>).map((s) => s.session_id);
        expect(ids, "the healthy repo's session must still appear in sessions.latest").toContain("iss28-r7-healthy");

        const repos = res.body.repos as Array<{ root: string; status: string; reason?: string }>;
        const entryA = repos.find((r) => r.root === repoA.root);
        const entryB = repos.find((r) => r.root === repoB.root);
        expect(entryA?.status, "the healthy repo must be listed with status ok").toBe("ok");
        expect(entryB?.status, "the unreadable repo must be listed with status unreadable, never omitted").toBe("unreadable");
        expect(typeof entryB?.reason, "the unreadable repo's entry must carry a reason string").toBe("string");
        expect((entryB?.reason ?? "").length, "the unreadable repo's reason string must be non-empty").toBeGreaterThan(0);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );

  it(
    "GET /api/overview against an empty registry returns repos as an empty array, repos_skipped 0, and all kpi and tiles figures as real zeros, never NaN and never an error.",
    async () => {
      const repo = await makeRepo();
      // Deliberately never `init` -- the registry at repo.registryPath is
      // never written at all, the empty-file/missing-file case readRegistry
      // itself already folds to the empty set (src/core/registry.ts).
      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const res = await httpGetJson(opened.url, "/api/overview");
        expect(res.status, `GET /api/overview against an empty registry did not return 200; body: ${res.rawBody}`).toBe(200);
        expect(res.body.repos, "repos must be an empty array against an empty registry").toEqual([]);
        expect(res.body.repos_skipped, "repos_skipped must be 0 against an empty registry").toBe(0);

        for (const [key, value] of Object.entries(res.body.kpi ?? {})) {
          expect(Number.isNaN(value as number), `kpi.${key} must never be NaN`).toBe(false);
          expect(value, `kpi.${key} must be a real zero against an empty registry`).toBe(0);
        }
        expect(res.body.tiles?.spend_present_usd, "tiles.spend_present_usd must be a real zero").toBe(0);
        expect(res.body.tiles?.cost_absent_count, "tiles.cost_absent_count must be a real zero").toBe(0);
        expect(res.body.tiles?.failing_checks, "tiles.failing_checks must be a real zero").toBe(0);
        expect(res.body.tiles?.sessions_by_kind, "tiles.sessions_by_kind must report real zeros for every kind").toEqual({
          headless: 0,
          interactive: 0,
          unknown: 0,
        });
        expect(res.body.sessions?.total, "sessions.total must be 0 against an empty registry").toBe(0);
        expect(res.body.sessions?.latest, "sessions.latest must be an empty array against an empty registry").toEqual([]);
        expect(res.body.drift, "drift must be an empty array against an empty registry").toEqual([]);
      } finally {
        await stop(opened);
      }
    },
    30_000,
  );

  it(
    "Replaying a hand-authored session whose enriched cc_version falls outside the tested range 2.1.208 to 2.1.215 makes GET /api/overview carry a drift entry naming that session_id, its version, and the range; an all-in-range session carries no drift entry; and a session whose cc_version is NULL never produces a drift entry.",
    async () => {
      const repo = await makeRepo();
      await initRepo(repo);
      const paths = getPaths(repo.root);
      const now = new Date().toISOString();

      // Out-of-range: a hand-authored transcript (no registered replay
      // scenario exists for this version), generated at test runtime.
      const outOfRangeTranscriptPath = join(repo.base, "drift-out-of-range.transcript.jsonl");
      writeFileSync(outOfRangeTranscriptPath, `${JSON.stringify({ version: "2.1.220", type: "summary" })}\n`);
      appendHandAuthoredSession(paths.spool, now, "iss28-r9-out-of-range", repo.root, outOfRangeTranscriptPath);

      // In-range: point directly at the committed cost-headless transcript
      // (recorded claudeCodeVersion 2.1.211, inside the tested range),
      // read in place -- enrichFromTranscript never copies a transcript.
      appendHandAuthoredSession(paths.spool, now, "iss28-r9-in-range", repo.root, COST_HEADLESS_TRANSCRIPT_PATH);

      // NULL cc_version: no transcript_path recorded at all.
      appendHandAuthoredSession(paths.spool, now, "iss28-r9-null-version", repo.root, null);

      const opened = await openServerFor(repo.home, repo.registryPath, repo.root);
      try {
        const res = await httpGetJson(opened.url, "/api/overview");
        expect(res.status, `GET /api/overview did not return 200; body: ${res.rawBody}`).toBe(200);
        const drift = res.body.drift;
        expect(Array.isArray(drift), "drift must be an array").toBe(true);
        expect(drift.length, "exactly one session (the out-of-range one) must produce a drift entry").toBe(1);

        const entry = drift[0];
        expect(deepContainsValue(entry, "iss28-r9-out-of-range"), "the drift entry must name the offending session_id").toBe(true);
        expect(deepContainsValue(entry, "2.1.220"), "the drift entry must name the session's actual out-of-range version").toBe(true);
        expect(deepContainsValue(entry, "2.1.208"), "the drift entry must name the tested range's minimum").toBe(true);
        expect(deepContainsValue(entry, "2.1.215"), "the drift entry must name the tested range's maximum").toBe(true);

        expect(
          deepContainsValue(drift, "iss28-r9-in-range"),
          "the in-range session (cc_version 2.1.211) must never produce a drift entry",
        ).toBe(false);
        expect(
          deepContainsValue(drift, "iss28-r9-null-version"),
          "the NULL-cc_version session must never produce a drift entry",
        ).toBe(false);
      } finally {
        await stop(opened);
      }
    },
    60_000,
  );
});
